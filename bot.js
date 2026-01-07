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

import { FOOD_CATEGORIES, NONSENSE_QUIZ } from "./data.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ===== 공통 유틸 =====
const uniq = (arr) => [...new Set(arr.filter(Boolean).map((x) => String(x).trim()).filter(Boolean))];

function isHHMM(t) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t) || t === "24:00";
}
function toMin(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function normalizeTimeToMin(t) {
  return t === "24:00" ? 1440 : toMin(t);
}

// ===== FOOD 추천 =====
function poolFromCategories(keys) {
  const items = keys.flatMap((k) => FOOD_CATEGORIES?.[k] || []);
  return uniq(items);
}

function getMealPool(mealType) {
  if (mealType === "dinner") {
    return poolFromCategories(["meat", "seafood", "soup_stew", "western_chinese", "street_food", "rice_noodle"]);
  }
  if (mealType === "snack") {
    return poolFromCategories(["dessert_snack", "drink", "street_food"]);
  }
  return poolFromCategories(["staple", "soup_stew", "western_chinese", "street_food", "rice_noodle"]);
}

function mealLabel(mealType) {
  if (mealType === "dinner") return "저녁";
  if (mealType === "snack") return "간식";
  return "점심";
}

// ===== 넌센스 퀴즈 =====
function ensureStoreShape(store) {
  if (!store.nonsense) store.nonsense = { byChannel: {} };
  if (!store.proposals) store.proposals = [];
  if (!store.busy) store.busy = [];
}

function normalizeAnswer(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[.,!?~'"`]/g, "");
}

function pickNonsenseItemByMode(mode, idx) {
  if (!Array.isArray(NONSENSE_QUIZ) || NONSENSE_QUIZ.length === 0) return null;

  if (mode === "seq") {
    const i = Number.isInteger(idx) ? idx : 0;
    const item = NONSENSE_QUIZ[i % NONSENSE_QUIZ.length];
    return { item, nextIdx: (i + 1) % NONSENSE_QUIZ.length };
  }

  return { item: pick(NONSENSE_QUIZ), nextIdx: idx ?? 0 };
}

function buildNonsenseQuestionText(item) {
  return [
    "넌센스 퀴즈다 아이가",
    `- 문제: ${item.q}`,
    "",
    "정답은 /answer로 넣어라. (예: /answer text:모카우)",
  ].join("\n");
}

function buildNonsenseCorrectText(item, userMention) {
  return [
    "정답이다 아이가.",
    `- 맞춘 사람: ${userMention}`,
    `- 정답: ${item.a}`,
  ].join("\n");
}

async function postNonsenseQuestion(channelId, mode = "random") {
  const picked = await withStore(async (store) => {
    ensureStoreShape(store);

    const st = store.nonsense.byChannel[channelId] || {
      mode: "random",
      idx: 0,
      current: null,
      attemptsByUser: {},
      createdAt: null,
      messageId: null,
    };

    st.mode = mode;

    const res = pickNonsenseItemByMode(st.mode, st.idx);
    if (!res?.item) return null;

    st.idx = res.nextIdx;
    st.current = { quizId: res.item.id, q: res.item.q, a: res.item.a };
    st.attemptsByUser = {};
    st.createdAt = new Date().toISOString();

    store.nonsense.byChannel[channelId] = st;
    return st.current;
  });

  if (!picked) return;

  const ch = await client.channels.fetch(channelId);
  const msg = await ch.send(buildNonsenseQuestionText(picked));

  await withStore(async (store) => {
    ensureStoreShape(store);
    const st = store.nonsense.byChannel[channelId];
    if (st) st.messageId = msg.id;
  });
}

// ===== 날짜 파싱 (/go day) =====
function toKstDateParts(d = new Date()) {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kst.getUTCDate()).padStart(2, "0");
  return { yyyy, mm, dd };
}

function addDaysKst(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
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

  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;

  const [y, m, d] = raw.split("-").map(Number);
  if (y < 2000 || y > 2100) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;

  return raw;
}

// ===== /go (시작시간만 제안 + 수락/거절 버튼만) =====
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

// start가 busy 구간에 포함되면 경고
async function computeConflictsAtStart(date, start) {
  const store = await loadStore();
  const s = normalizeTimeToMin(start);

  const conflicts = {};
  for (const k of USER_KEYS) conflicts[k] = [];

  const sameDate = store.busy.filter((b) => b.date === date);

  for (const k of USER_KEYS) {
    const slots = sameDate.filter((b) => b.userKey === k);
    for (const b of slots) {
      const bs = normalizeTimeToMin(b.start);
      const be = normalizeTimeToMin(b.end);

      if (bs <= s && s < be) {
        const reason = b.reason ? `(${b.reason})` : "";
        conflicts[k].push(`${b.start}~${b.end}${reason}`);
      }
    }
  }

  return conflicts;
}

function buildGoMessage({ date, start }, responses, conflicts) {
  const lines = [];
  lines.push(`할매가 시간 하나 딱 제안한다 아이가`);
  lines.push(`- 날짜: ${date}`);
  lines.push(`- 시작: ${start}\n`);

  lines.push(`수락/거절 눌러라`);
  for (const k of USER_KEYS) {
    const nm = userNameFromKey(k);
    const st = responses[k] ?? "PENDING";
    const stKr = st === "ACCEPT" ? "수락" : st === "DECLINE" ? "거절" : "대기";
    const warn = conflicts[k]?.length ? ` · 겹침: ${conflicts[k].join(", ")}` : "";
    lines.push(`- ${nm}: ${stKr}${warn}`);
  }

  const allAccepted = USER_KEYS.every((k) => (responses[k] ?? "PENDING") === "ACCEPT");
  const anyDeclined = USER_KEYS.some((k) => (responses[k] ?? "PENDING") === "DECLINE");

  if (allAccepted) lines.push(`\n고! 그 시간에 모이라.`);
  else if (anyDeclined) lines.push(`\n안 된다. 시간 다시 잡아라.`);
  else lines.push(`\n아직 응답 안 한 사람 있다.`);

  return lines.join("\n");
}

// ===== 날씨 =====
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

// ===== ready =====
client.once("ready", () => {
  console.log(`✅ 로그인: ${client.user.tag}`);

  // 채널 하나로 통일
  const channelId = process.env.GUILD_ID;
  if (!channelId) {
    console.warn("GUILD_ID 미설정: 자동 알림(날씨/넌센스) 스킵");
    return;
  }

  // 07:00 날씨 알림
  cron.schedule(
    "0 7 * * *",
    async () => {
      try {
        const ch = await client.channels.fetch(channelId);
        const msg = await fetchWeather(process.env.WEATHER_DEFAULT_CITY);
        await ch.send(`할매 아침 날씨다 아이가\n${msg}`);
      } catch (e) {
        console.error("날씨 알림 오류:", e);
      }
    },
    { timezone: "Asia/Seoul" }
  );

  // 15:00 넌센스 퀴즈 자동 출제
  cron.schedule(
    "0 15 * * *",
    async () => {
      try {
        const mode = process.env.NONSENSE_MODE || "random"; // random | seq
        await postNonsenseQuestion(channelId, mode);
      } catch (e) {
        console.error("넌센스 자동출제 오류:", e);
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
      const type = interaction.options.getString("type") || "lunch";
      const pool = getMealPool(type);

      if (!pool.length) {
        await interaction.reply("추천할 게 없다 아이가. FOOD_CATEGORIES 데이터부터 확인해라.");
        return;
      }

      const menu = pick(pool);
      await interaction.reply(`${mealLabel(type)}은 이거 묵어라: **${menu}**\n고민은 거기서 끝내라.`);
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

    // /nonsense
    if (interaction.commandName === "nonsense") {
      const mode = interaction.options.getString("mode") || "random";
      await interaction.deferReply();

      try {
        await postNonsenseQuestion(interaction.channelId, mode);
        await interaction.editReply("문제 냈다 아이가. 위에 올라간 거 보고 맞춰봐라.");
      } catch (e) {
        console.error(e);
        await interaction.editReply("문제 내는 게 꼬였다. DB(NONSENSE_QUIZ)부터 확인해라.");
      }
      return;
    }

    // /answer
    if (interaction.commandName === "answer") {
      const text = interaction.options.getString("text", true);

      const result = await withStore(async (store) => {
        ensureStoreShape(store);

        const channelId = interaction.channelId;
        const st = store.nonsense.byChannel[channelId];
        if (!st?.current) return { ok: false, reason: "NO_QUESTION" };

        const userId = interaction.user.id;
        const tries = st.attemptsByUser?.[userId] ?? 0;

        const input = normalizeAnswer(text);
        const answer = normalizeAnswer(st.current.a);

        if (input && input === answer) {
          const current = st.current;
          st.current = null;
          st.attemptsByUser = {};
          store.nonsense.byChannel[channelId] = st;
          return { ok: true, type: "CORRECT", current };
        }

        const nextTries = tries + 1;
        st.attemptsByUser[userId] = nextTries;
        store.nonsense.byChannel[channelId] = st;

        if (nextTries >= 2) {
          return { ok: true, type: "REVEAL_TO_USER", current: st.current, tries: nextTries };
        }
        return { ok: true, type: "WRONG", tries: nextTries };
      });

      if (!result.ok) {
        await interaction.reply({ content: "지금 문제 없다. /nonsense로 문제부터 내라.", ephemeral: true });
        return;
      }

      if (result.type === "CORRECT") {
        await interaction.reply(buildNonsenseCorrectText(result.current, `<@${interaction.user.id}>`));
        return;
      }

      if (result.type === "WRONG") {
        await interaction.reply({
          content: `틀렸다 아이가. (${result.tries}/2) 다시 생각해봐라.`,
          ephemeral: true,
        });
        return;
      }

      if (result.type === "REVEAL_TO_USER") {
        await interaction.reply({
          content: `두 번 틀렸다. 정답 알려준다.\n- 문제: ${result.current.q}\n- 정답: ${result.current.a}`,
          ephemeral: true,
        });
        return;
      }

      return;
    }

    // /go (추천 없음, 시작시간만 제안)
    if (interaction.commandName === "go") {
      const dayRaw = interaction.options.getString("day");
      const date = parseGoDay(dayRaw);

      if (!date) {
        await interaction.reply({
          content: "day 입력이 좀 이상하다. '오늘', '내일', 'YYYY-MM-DD' 중 하나로 넣어라.",
          ephemeral: true,
        });
        return;
      }

      const start = interaction.options.getString("start", true);

      if (!isHHMM(start) || start === "24:00") {
        await interaction.reply({
          content: "start는 HH:MM으로 넣어라. (24:00 제외) 예: 19:30",
          ephemeral: true,
        });
        return;
      }

      const proposalId = crypto.randomUUID().slice(0, 8);
      const responses = {};
      for (const k of USER_KEYS) responses[k] = "PENDING";

      const conflicts = await computeConflictsAtStart(date, start);
      const content = buildGoMessage({ date, start }, responses, conflicts);
      const rows = buildGoButtons(proposalId);

      const msg = await interaction.reply({ content, components: rows, fetchReply: true });

      await withStore(async (store) => {
        ensureStoreShape(store);
        store.proposals.push({
          id: proposalId,
          channelId: msg.channelId,
          messageId: msg.id,
          date,
          start,
          creatorId: interaction.user.id,
          responses,
          status: "OPEN",
          createdAt: new Date().toISOString(),
        });
      });

      return;
    }

    // /busy는 기존 코드 그대로 유지(당신 프로젝트에 이미 구현돼 있으니 여기서는 생략)
    return;
  }

  // 2) 버튼(/go)
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
      ensureStoreShape(store);

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

    const conflicts = await computeConflictsAtStart(updated.date, updated.start);
    const content = buildGoMessage(
      { date: updated.date, start: updated.start },
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
