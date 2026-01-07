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

import {
  LUNCH,
  USERS,
  USER_KEYS,
  userKeyFromDiscordId,
  userNameFromKey,
} from "./data.js";
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
function normalizeTimeToMin(t) {
  return t === "24:00" ? 1440 : toMin(t);
}
function overlap(aStart, aEnd, bStart, bEnd) {
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

function isHHMM(t) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t) || t === "24:00";
}

function formatBusyItem(x) {
  const nm = userNameFromKey(x.userKey);
  const reason = x.reason ? ` (${x.reason})` : "";
  return `- [${x.id}] ${nm} ${x.date} ${x.start}~${x.end}${reason}`;
}

// ===== 날짜 파싱 (/go day) =====
function toKstDateParts(d = new Date()) {
  // 런타임이 어디서 돌든 KST 기준 날짜를 쓰기 위함 (간단 버전)
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kst.getUTCDate()).padStart(2, "0");
  return { yyyy, mm, dd };
}

function addDaysKst(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  // Date는 로컬타임 영향 있으니 UTC로 처리 후 KST 보정 방식 유지
  const baseUtc = Date.UTC(y, m - 1, d);
  const next = new Date(baseUtc + days * 24 * 60 * 60 * 1000);
  const yyyy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(next.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseGoDay(dayRaw) {
  const raw = (dayRaw || "").trim();

  const todayParts = toKstDateParts(new Date());
  const today = `${todayParts.yyyy}-${todayParts.mm}-${todayParts.dd}`;

  if (!raw || raw === "오늘" || raw.toLowerCase() === "today") return today;
  if (raw === "내일" || raw.toLowerCase() === "tomorrow") return addDaysKst(today, 1);

  // YYYY-MM-DD 검증
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;

  // 최소한의 유효성(월/일 범위)만 체크
  const [y, m, d] = raw.split("-").map(Number);
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;

  return raw;
}

// ===== /go 메시지/버튼 =====
function buildGoMessage({ date, start, end, durationMin }, responses, conflicts) {
  const lines = [];
  lines.push(`할매가 시간 하나 딱 잡아준다 아이가`);
  lines.push(`- 날짜: ${date}`);
  lines.push(`- 시간: ${start}~${end} (${durationMin}분)\n`);

  lines.push(`응답 상태 보이소`);
  for (const k of USER_KEYS) {
    const nm = userNameFromKey(k);
    const st = responses[k] ?? "PENDING";
    const stKr = st === "ACCEPT" ? "오케이(간다)" : st === "DECLINE" ? "못 간다" : "아직이다";
    const warn = conflicts[k]?.length ? ` · 겹치는 거: ${conflicts[k].join(", ")}` : "";
    lines.push(`- ${nm}: ${stKr}${warn}`);
  }

  const allAccepted = USER_KEYS.every((k) => (responses[k] ?? "PENDING") === "ACCEPT");
  const anyDeclined = USER_KEYS.some((k) => (responses[k] ?? "PENDING") === "DECLINE");

  if (allAccepted) lines.push(`\n확정이다. 그 시간에 딱 모이라.`);
  else if (anyDeclined) lines.push(`\n안 된다. 날짜나 시간 다시 잡아라.`);
  else lines.push(`\n아직 답 안 한 사람 있다. 얼른 눌러라.`);

  return lines.join("\n");
}

function buildGoButtons(proposalId) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`go:${proposalId}:ACCEPT`)
      .setLabel("간다")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`go:${proposalId}:DECLINE`)
      .setLabel("못 간다")
      .setStyle(ButtonStyle.Danger)
  );

  return [row];
}

// ===== 추천 유틸 (/go 입력값 기반) =====
async function recommendSlotsByInput({
  date,
  from,
  to,
  durationMin,
  stepMin,
  maxCandidates = 20,
}) {
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
      if (candidates.length >= maxCandidates) break;
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

  if (!key) throw new Error("WEATHER_API_KEY 미설정");

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
    if (feels <= 0) nags.push("체감이 영하라 카이. 옷 얇게 입고 나가면 안 된다.");
    else if (feels <= 8) nags.push("쌀쌀타. 겉옷 하나 챙겨라.");
    else if (feels >= 28) nags.push("덥다. 물 안 챙기면 고생한다.");
  }
  if (typeof hum === "number" && hum >= 75)
    nags.push("습하다. 머리 부스스해도 그건 어쩔 수 없다.");
  if (typeof wind === "number" && wind >= 6)
    nags.push("바람 센 편이다. 모자 쓰면 날아간다.");

  const nagText = nags.length ? `\n${nags.join(" ")}` : "\n별일 없다. 그래도 조심해서 다녀라.";

  return `지금 ${name} 날씨다: ${desc}, ${temp}°C (체감 ${feels}°C), 습도 ${hum}%, 바람 ${wind} m/s${nagText}`;
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

  cron.schedule(
    "0 7 * * *",
    async () => {
      try {
        const channelId = process.env.WEATHER_CHANNEL_ID;
        if (!channelId) return console.warn("WEATHER_CHANNEL_ID 미설정");

        const ch = await client.channels.fetch(channelId);
        const msg = await fetchWeather(process.env.WEATHER_DEFAULT_CITY);
        await ch.send(`할매 아침 날씨다 아이가\n${msg}`);
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
      await interaction.reply(`점심은 이거 묵어라: **${menu}**\n고민은 거기서 끝내라.`);
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
        await interaction.editReply(`날씨 궁금했나?\n${msg}`);
      } catch {
        await interaction.editReply(
          "날씨가 오늘 영 말을 안 듣는다. 도시명 바꿔보던지, 쪼매 있다가 다시 해봐라."
        );
      }
      return;
    }

    // /busy
    if (interaction.commandName === "busy") {
      const sub = interaction.options.getSubcommand();
      const callerKey = userKeyFromDiscordId(interaction.user.id);

      if (sub === "add") {
        if (!callerKey) {
          await interaction.reply({
            content: "니는 등록된 멤버가 아니라서 못 한다. (영진/민수/유정/명재만 된다)",
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
            content: "시간이 좀 이상하다. 시작이 끝보다 빨라야 된다 아이가. 다시 넣어라.",
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
          `됐다. 박아놨다 아이가.\n${formatBusyItem({
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
              ? `없다 아이가. ${userNameFromKey(targetKey)}는 그날그날 비어있네.`
              : "없다 아이가. 아무도 안 막혀있네."
          );
          return;
        }

        const title = targetKey
          ? `${userNameFromKey(targetKey)} 못 되는 시간`
          : `전체 못 되는 시간`;
        const body = list.map(formatBusyItem).join("\n");
        await interaction.reply(`${title}\n${body}`);
        return;
      }

      if (sub === "remove") {
        if (!callerKey) {
          await interaction.reply({
            content: "니는 등록된 멤버가 아니라서 삭제도 못 한다.",
            ephemeral: true,
          });
          return;
        }

        const id = interaction.options.getString("id");
        const store = await loadStore();
        const item = store.busy.find((b) => b.id === id);
        if (!item) {
          await interaction.reply({
            content: "그 번호는 없다 아이가. /busy list로 한번 보고 와라.",
            ephemeral: true,
          });
          return;
        }

        if (item.userKey !== callerKey) {
          await interaction.reply({
            content: "그건 니꺼 아니다. 남의 거 건드리면 안 된다.",
            ephemeral: true,
          });
          return;
        }

        await withStore(async (s) => {
          s.busy = s.busy.filter((b) => b.id !== id);
        });

        await interaction.reply(`지웠다 아이가.\n${formatBusyItem(item)}`);
        return;
      }

      if (sub === "clear") {
        if (!callerKey) {
          await interaction.reply({
            content: "니는 등록된 멤버가 아니라서 싹 비우는 것도 못 한다.",
            ephemeral: true,
          });
          return;
        }

        await withStore(async (s) => {
          s.busy = s.busy.filter((b) => b.userKey !== callerKey);
        });

        await interaction.reply(`${userNameFromKey(callerKey)} 스케줄, 할매가 싹 비워놨다.`);
        return;
      }
    }

    // /go (입력 기반 + 2버튼)
    if (interaction.commandName === "go") {
      const dayRaw = interaction.options.getString("day"); // optional
      const date = parseGoDay(dayRaw);

      if (!date) {
        await interaction.reply({
          content: "day 입력이 좀 이상하다. '오늘', '내일', 'YYYY-MM-DD' 중 하나로 넣어라.",
          ephemeral: true,
        });
        return;
      }

      const from = interaction.options.getString("from", true);
      const to = interaction.options.getString("to", true);
      const durationMin = interaction.options.getInteger("duration", true);
      const stepMin = interaction.options.getInteger("step") ?? 30;

      if (!isHHMM(from) || !isHHMM(to)) {
        await interaction.reply({
          content: "시간은 HH:MM으로 넣어라. 예: 18:00, 23:30, 24:00",
          ephemeral: true,
        });
        return;
      }

      const fromM = normalizeTimeToMin(from);
      const toM = normalizeTimeToMin(to);
      if (!(fromM < toM)) {
        await interaction.reply({
          content: "시간 범위가 이상하다. from이 to보다 빨라야 된다 아이가.",
          ephemeral: true,
        });
        return;
      }

      if (durationMin <= 0 || durationMin > 600) {
        await interaction.reply({
          content: "duration(분)이 좀 이상하다. 1~600 사이로 넣어라.",
          ephemeral: true,
        });
        return;
      }

      if (stepMin <= 0 || stepMin > 180) {
        await interaction.reply({
          content: "step(분)이 좀 이상하다. 1~180 사이로 넣어라.",
          ephemeral: true,
        });
        return;
      }

      if (fromM + durationMin > toM) {
        await interaction.reply({
          content: "그 시간 범위 안에 duration이 안 들어간다. 범위를 늘리던지 duration을 줄여라.",
          ephemeral: true,
        });
        return;
      }

      const candidates = await recommendSlotsByInput({
        date,
        from,
        to,
        durationMin,
        stepMin,
        maxCandidates: 20,
      });

      if (!candidates.length) {
        await interaction.reply(
          `없다 아이가.\n- 날짜: ${date}\n- 범위: ${from}~${to}\n- 필요시간: ${durationMin}분\n- 간격: ${stepMin}분\n그날은 각자 바쁜가 보다.`
        );
        return;
      }

      const chosen = candidates[0];
      const proposalId = crypto.randomUUID().slice(0, 8);

      const responses = {};
      for (const k of USER_KEYS) responses[k] = "PENDING";

      const conflicts = await computeConflicts(date, chosen.start, chosen.end);
      const content = buildGoMessage(
        { date, start: chosen.start, end: chosen.end, durationMin },
        responses,
        conflicts
      );

      const rows = buildGoButtons(proposalId);
      const msg = await interaction.reply({ content, components: rows, fetchReply: true });

      await withStore(async (store) => {
        store.proposals.push({
          id: proposalId,
          channelId: msg.channelId,
          messageId: msg.id,
          date,
          start: chosen.start,
          end: chosen.end,
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

  // 2) 버튼(간다/못 간다)
  if (interaction.isButton()) {
    const [prefix, proposalId, action] = interaction.customId.split(":");
    if (prefix !== "go") return;

    const callerKey = userKeyFromDiscordId(interaction.user.id);
    if (!callerKey) {
      await interaction.reply({
        content: "니는 등록 멤버가 아니라서 참여 못 한다.",
        ephemeral: true,
      });
      return;
    }

    const nextStatus = action === "ACCEPT" ? "ACCEPT" : "DECLINE";

    const updated = await withStore(async (store) => {
      const p = store.proposals.find((x) => x.id === proposalId);
      if (!p) return null;
      if (p.status !== "OPEN") return p;

      p.responses[callerKey] = nextStatus;

      const allAccepted = USER_KEYS.every((k) => (p.responses[k] ?? "PENDING") === "ACCEPT");
      const anyDeclined = USER_KEYS.some((k) => (p.responses[k] ?? "PENDING") === "DECLINE");

      if (allAccepted) p.status = "CONFIRMED";
      else if (anyDeclined) p.status = "CANCELLED";

      return p;
    });

    if (!updated) {
      await interaction.reply({
        content: "그 제안은 없다 아이가. 새로 잡아라.",
        ephemeral: true,
      });
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
