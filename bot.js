// bot.js
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import cron from "node-cron";
import crypto from "crypto";

import { LUNCH, USERS, USER_KEYS, userKeyFromDiscordId, userNameFromKey } from "./data.js";
import { withStore, loadStore } from "./storage.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ===== 시간 유틸 =====
function toMin(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function fromMin(n) {
  const h = String(Math.floor(n / 60)).padStart(2, "0");
  const m = String(n % 60).padStart(2, "0");
  return `${h}:${m}`;
}
// "24:00" 같은 표현 처리: 1440으로 취급
function normalizeTimeToMin(t) {
  return t === "24:00" ? 1440 : toMin(t);
}
function overlap(aStart, aEnd, bStart, bEnd) {
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}
function clampDay(min) {
  if (min < 0) return 0;
  if (min > 1440) return 1440;
  return min;
}

function formatBusyItem(x) {
  const nm = userNameFromKey(x.userKey);
  const reason = x.reason ? ` (${x.reason})` : "";
  return `- [${x.id}] ${nm} ${x.date} ${x.start}~${x.end}${reason}`;
}

// ===== /go 메시지/버튼 =====
function buildGoMessage({ date, start, end, durationMin }, responses, conflicts) {
  const lines = [];
  lines.push(`할매가 시간 잡아준다`);
  lines.push(`- 날짜: ${date}`);
  lines.push(`- 시간: ${start}~${end} (${durationMin}분)\n`);

  lines.push(`응답 현황`);
  for (const k of USER_KEYS) {
    const nm = userNameFromKey(k);
    const st = responses[k] ?? "PENDING";
    const stKr = st === "ACCEPT" ? "수락" : st === "DECLINE" ? "거절" : "대기";
    const warn = conflicts[k]?.length ? ` · 충돌: ${conflicts[k].join(", ")}` : "";
    lines.push(`- ${nm}: ${stKr}${warn}`);
  }

  const allAccepted = USER_KEYS.every((k) => (responses[k] ?? "PENDING") === "ACCEPT");
  const anyDeclined = USER_KEYS.some((k) => (responses[k] ?? "PENDING") === "DECLINE");

  if (allAccepted) lines.push(`\n확정이다. 그 시간에 모여라.`);
  else if (anyDeclined) lines.push(`\n안 된다. 다른 시간 다시 잡아라.`);
  else lines.push(`\n아직 대기다. 누가 답 안 했냐.`);

  return lines.join("\n");
}

function buildGoButtons(proposalId) {
  // 한 줄에 버튼 5개 제한 => 2줄(4명*2=8개)
  const row1 = new ActionRowBuilder();
  const row2 = new ActionRowBuilder();

  const pairs = USER_KEYS.flatMap((k) => [
    { userKey: k, action: "ACCEPT", label: `${userNameFromKey(k)} 수락` },
    { userKey: k, action: "DECLINE", label: `${userNameFromKey(k)} 거절` },
  ]);

  pairs.forEach((p, idx) => {
    const btn = new ButtonBuilder()
      .setCustomId(`go:${proposalId}:${p.userKey}:${p.action}`)
      .setLabel(p.label)
      .setStyle(p.action === "ACCEPT" ? ButtonStyle.Success : ButtonStyle.Danger);

    if (idx < 4) row1.addComponents(btn);
    else row2.addComponents(btn);
  });

  return [row1, row2];
}

// ===== 추천 유틸 (/go time 미입력 시) =====
function formatCandidateList(cands) {
  if (!cands.length) return "없다. 그날은 시간이 안 맞는다.";
  return cands.map((c, i) => `${i + 1}) ${c.start}~${c.end}`).join("\n");
}

async function recommendSlots(date, durationMin, from = "18:00", to = "24:00", stepMin = 30, count = 5) {
  const store = await loadStore();
  const busy = store.busy.filter((b) => b.date === date);

  const fromM = normalizeTimeToMin(from);
  const toM = normalizeTimeToMin(to);

  const candidates = [];
  for (let t = fromM; t + durationMin <= toM; t += stepMin) {
    const startM = t;
    const endM = t + durationMin;

    let ok = true;
    for (const personKey of USER_KEYS) {
      const personBusy = busy.filter((b) => b.userKey === personKey);
      for (const b of personBusy) {
        const bs = normalizeTimeToMin(b.start);
        const be = normalizeTimeToMin(b.end);
        if (overlap(startM, endM, bs, be)) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
    }

    if (ok) {
      const start = fromMin(startM);
      const end = endM === 1440 ? "24:00" : fromMin(endM);
      candidates.push({ start, end });
      if (candidates.length >= count) break;
    }
  }

  return candidates;
}

// ===== 날씨 (+ 잔소리) =====
async function fetchWeather(cityRaw) {
  const city = cityRaw || process.env.WEATHER_DEFAULT_CITY || "Seoul";
  const key = process.env.WEATHER_API_KEY;
  const units = process.env.WEATHER_UNITS || "metric";
  const lang = process.env.WEATHER_LANG || "kr";

  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
    city
  )}&appid=${key}&units=${units}&lang=${lang}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather API error: ${res.status}`);
  const w = await res.json();

  const name = w.name;
  const desc = w.weather?.[0]?.description || "날씨 정보";
  const temp = Math.round(w.main?.temp);
  const feels = Math.round(w.main?.feels_like);
  const hum = w.main?.humidity;
  const wind = w.wind?.speed;

  const nags = [];

  if (Number.isFinite(feels)) {
    if (feels <= 0) nags.push("체감이 영하다. 옷 얇게 입지 마라.");
    else if (feels <= 8) nags.push("쌀쌀하다. 겉옷 챙겨라.");
    else if (feels >= 28) nags.push("덥다. 물 챙겨라.");
  }
  if (typeof hum === "number" && hum >= 75) nags.push("습하다. 머리 부스스해도 참아라.");
  if (typeof wind === "number" && wind >= 6) nags.push("바람 센 편이다. 모자 날아간다.");

  const nagText = nags.length ? `\n${nags.join(" ")}` : "\n별일 없다. 그냥 나가라.";

  return `현재 ${name} 날씨: ${desc}, ${temp}°C (체감 ${feels}°C), 습도 ${hum}%, 바람 ${wind} m/s${nagText}`;
}

// ===== 충돌 계산 =====
async function computeConflicts(date, start, end) {
  const store = await loadStore();
  const s = normalizeTimeToMin(start);
  const e = normalizeTimeToMin(end);

  const conflicts = {};
  for (const k of USER_KEYS) conflicts[k] = [];

  const sameDate = store.busy.filter((b) => b.date === date);

  for (const k of USER_KEYS) {
    const slots = sameDate.filter((b) => b.userKey === k);
    for (const b of slots) {
      const bs = normalizeTimeToMin(b.start);
      const be = normalizeTimeToMin(b.end);
      if (overlap(s, e, bs, be)) {
        const reason = b.reason ? `(${b.reason})` : "";
        conflicts[k].push(`${b.start}~${b.end}${reason}`);
      }
    }
  }

  return conflicts;
}

// ===== ready =====
client.once("ready", () => {
  console.log(`✅ 로그인: ${client.user.tag}`);

  // 매일 오전 7시(Asia/Seoul) 정각에 날씨 알림
  cron.schedule(
    "0 7 * * *",
    async () => {
      try {
        const channelId = process.env.WEATHER_CHANNEL_ID;
        if (!channelId) return console.warn("WEATHER_CHANNEL_ID 미설정");

        const ch = await client.channels.fetch(channelId);
        const msg = await fetchWeather(process.env.WEATHER_DEFAULT_CITY);
        await ch.send(`할매 아침 날씨다\n${msg}`);
      } catch (e) {
        console.error("날씨 알림 오류:", e);
      }
    },
    { timezone: "Asia/Seoul" }
  );
});

// ===== interaction =====
client.on("interactionCreate", async (interaction) => {
  // 1) 슬래시 커맨드
  if (interaction.isChatInputCommand()) {
    // /lunch
    if (interaction.commandName === "lunch") {
      const menu = pick(LUNCH);
      await interaction.reply(`점심은 이거 먹어라: **${menu}**\n고민은 여기서 끝.`);
      return;
    }

    // /weather
    if (interaction.commandName === "weather") {
      await interaction.deferReply();
      try {
        const city =
          interaction.options.getString("city") ||
          process.env.WEATHER_DEFAULT_CITY ||
          "Seoul";
        const msg = await fetchWeather(city);
        await interaction.editReply(`날씨 물어봤지?\n${msg}`);
      } catch {
        await interaction.editReply(
          "날씨가 말을 안 듣는다. 도시명을 바꾸거나 잠깐 있다가 해봐라."
        );
      }
      return;
    }

    // /busy (CRUD)
    if (interaction.commandName === "busy") {
      const sub = interaction.options.getSubcommand();
      const callerKey = userKeyFromDiscordId(interaction.user.id);

      if (sub === "add") {
        if (!callerKey) {
          await interaction.reply({
            content: "등록된 멤버만 추가할 수 있다. (영진/민수/유정/명재)",
            ephemeral: true,
          });
          return;
        }

        const date = interaction.options.getString("date");
        const start = interaction.options.getString("start");
        const end = interaction.options.getString("end");
        const reason = interaction.options.getString("reason") || "";

        const s = normalizeTimeToMin(start);
        const e = normalizeTimeToMin(end);
        if (!(s < e)) {
          await interaction.reply({
            content: "시간이 이상하다. start < end로 다시 넣어라.",
            ephemeral: true,
          });
          return;
        }

        const id = crypto.randomUUID().slice(0, 8);
        await withStore(async (store) => {
          store.busy.push({
            id,
            userKey: callerKey,
            date,
            start,
            end,
            reason: reason.trim() || null,
            createdAt: new Date().toISOString(),
          });
        });

        await interaction.reply(
          `추가했다.\n${formatBusyItem({
            id,
            userKey: callerKey,
            date,
            start,
            end,
            reason: reason.trim() || null,
          })}`
        );
        return;
      }

      if (sub === "list") {
        const user = interaction.options.getString("user"); // optional
        const targetKey = user || callerKey;

        const store = await loadStore();
        const list = store.busy
          .filter((b) => (targetKey ? b.userKey === targetKey : true))
          .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));

        if (!list.length) {
          await interaction.reply(
            targetKey
              ? `없다. ${userNameFromKey(targetKey)} 스케줄 비었네.`
              : "없다. 아무도 안 막혀있네."
          );
          return;
        }

        const title = targetKey
          ? `${userNameFromKey(targetKey)} 안 되는 시간`
          : `전체 안 되는 시간`;
        const body = list.map(formatBusyItem).join("\n");
        await interaction.reply(`${title}\n${body}`);
        return;
      }

      if (sub === "remove") {
        if (!callerKey) {
          await interaction.reply({
            content: "등록된 멤버만 삭제할 수 있다.",
            ephemeral: true,
          });
          return;
        }

        const id = interaction.options.getString("id");
        const store = await loadStore();
        const item = store.busy.find((b) => b.id === id);
        if (!item) {
          await interaction.reply({
            content: "그 id는 없다. /busy list로 확인해라.",
            ephemeral: true,
          });
          return;
        }

        // 본인만 삭제
        if (item.userKey !== callerKey) {
          await interaction.reply({ content: "남의 건 삭제 못 한다.", ephemeral: true });
          return;
        }

        await withStore(async (s) => {
          s.busy = s.busy.filter((b) => b.id !== id);
        });

        await interaction.reply(`지웠다.\n${formatBusyItem(item)}`);
        return;
      }

      if (sub === "clear") {
        if (!callerKey) {
          await interaction.reply({ content: "등록된 멤버만 clear 가능하다.", ephemeral: true });
          return;
        }

        await withStore(async (s) => {
          s.busy = s.busy.filter((b) => b.userKey !== callerKey);
        });

        await interaction.reply(`${userNameFromKey(callerKey)} 스케줄 싹 비웠다.`);
        return;
      }
    }

    // /go (제안 or 추천)
    if (interaction.commandName === "go") {
      const date = interaction.options.getString("date");
      const time = interaction.options.getString("time"); // optional
      const durationMin = interaction.options.getInteger("duration") ?? 120;

      const from = interaction.options.getString("from") || "18:00";
      const to = interaction.options.getString("to") || "24:00";
      const step = interaction.options.getInteger("step") ?? 30;
      const count = interaction.options.getInteger("count") ?? 5;

      // 추천 모드
      if (!time) {
        const cands = await recommendSlots(date, durationMin, from, to, step, count);
        const body = formatCandidateList(cands);

        await interaction.reply(
          `할매가 가능한 시간 골라봤다.\n- 날짜: ${date}\n- 길이: ${durationMin}분\n- 탐색: ${from}~${to} / ${step}분 간격\n\n${body}\n\n원하는 걸로 /go date:${date} time:HH:MM duration:${durationMin} 다시 쳐라.`
        );
        return;
      }

      // 제안 모드
      const startMin = normalizeTimeToMin(time);
      const endMin = clampDay(startMin + durationMin);
      const end = endMin === 1440 ? "24:00" : fromMin(endMin);

      const proposalId = crypto.randomUUID().slice(0, 8);

      const responses = {};
      for (const k of USER_KEYS) responses[k] = "PENDING";

      const conflicts = await computeConflicts(date, time, end);
      const content = buildGoMessage({ date, start: time, end, durationMin }, responses, conflicts);

      const rows = buildGoButtons(proposalId);
      const msg = await interaction.reply({ content, components: rows, fetchReply: true });

      await withStore(async (store) => {
        store.proposals.push({
          id: proposalId,
          channelId: msg.channelId,
          messageId: msg.id,
          date,
          start: time,
          end,
          durationMin,
          creatorId: interaction.user.id,
          responses,
          status: "OPEN",
          createdAt: new Date().toISOString(),
        });
      });

      return;
    }

    return;
  }

  // 2) 버튼(수락/거절)
  if (interaction.isButton()) {
    const [prefix, proposalId, userKey, action] = interaction.customId.split(":");
    if (prefix !== "go") return;

    const expectedDiscordId = USERS[userKey]?.id;
    if (!expectedDiscordId) {
      await interaction.reply({ content: "이상한 버튼이다.", ephemeral: true });
      return;
    }

    // 해당 당사자만 클릭 가능
    if (interaction.user.id !== expectedDiscordId) {
      await interaction.reply({ content: "네 버튼 아니다. 손 떼라.", ephemeral: true });
      return;
    }

    const nextStatus = action === "ACCEPT" ? "ACCEPT" : "DECLINE";

    const updated = await withStore(async (store) => {
      const p = store.proposals.find((x) => x.id === proposalId);
      if (!p) return null;
      if (p.status !== "OPEN") return p;

      p.responses[userKey] = nextStatus;

      const allAccepted = USER_KEYS.every((k) => (p.responses[k] ?? "PENDING") === "ACCEPT");
      const anyDeclined = USER_KEYS.some((k) => (p.responses[k] ?? "PENDING") === "DECLINE");

      if (allAccepted) p.status = "CONFIRMED";
      else if (anyDeclined) p.status = "CANCELLED";

      return p;
    });

    if (!updated) {
      await interaction.reply({ content: "그 제안은 없다.", ephemeral: true });
      return;
    }

    const conflicts = await computeConflicts(updated.date, updated.start, updated.end);
    const content = buildGoMessage(
      { date: updated.date, start: updated.start, end: updated.end, durationMin: updated.durationMin },
      updated.responses,
      conflicts
    );

    const disabled = updated.status !== "OPEN";
    const rows = buildGoButtons(updated.id).map((row) => {
      row.components.forEach((c) => c.setDisabled(disabled));
      return row;
    });

    await interaction.update({ content, components: rows });
    return;
  }
});

client.login(process.env.DISCORD_TOKEN);
