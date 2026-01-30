// bot.js
import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import cron from "node-cron";
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";

import { FOOD_CATEGORIES, NONSENSE_QUIZ, SCHEDULE, WORK_ROLES } from "./data.js";
import { MESSAGES } from "./messages.js";

/**
 * ============================================================
 * IMPORTANT
 * ============================================================
 * 1) "Used disallowed intents"가 뜨면, Developer Portal에서
 *    Server Members Intent를 켜지 않았는데 GuildMembers 인텐트를 쓴 경우입니다.
 *
 *  - Portal에서 Server Members Intent 켤 수 있으면:
 *      intents: [Guilds, GuildMembers]
 *  - Portal 접근/권한 없으면 (지금 유정님 상황일 가능성 높음):
 *      intents: [Guilds] 만 사용 (아래 기본값)
 *
 * 2) 역할 토글하려면 서버에서 봇 역할에 Manage Roles 권한 + 역할 순서(봇 역할이 위)가 필요합니다.
 */

// ✅ 기본: 권한 없을 때 안전(Used disallowed intents 방지)
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// =========================
// 설정(고정 멤버/DB 경로)
// =========================
const STORE_PATH = path.resolve(process.cwd(), "store.json");

// 친구 목록 (고정)
const USER_KEYS = ["youngjin", "minsu", "youjung", "myeongjae"];

const USER_META = {
  youngjin: { name: "영진", discordId: "411236144219553792" },
  minsu: { name: "민수", discordId: "372007150966538241" },
  youjung: { name: "유정", discordId: "837984030745165905" },
  myeongjae: { name: "명재", discordId: "272960214796468224" },
};

function userKeyFromDiscordId(id) {
  for (const k of USER_KEYS) {
    if (USER_META[k]?.discordId === id) return k;
  }
  return null;
}
function userNameFromKey(k) {
  return USER_META[k]?.name ?? k;
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const uniq = (arr) =>
  [...new Set(arr.filter(Boolean).map((x) => String(x).trim()).filter(Boolean))];

// =========================
// store.json (파일 기반 DB)
// =========================
async function loadStore() {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return ensureStoreShape(parsed);
  } catch {
    const init = ensureStoreShape({});
    await fs.writeFile(STORE_PATH, JSON.stringify(init, null, 2), "utf-8");
    return init;
  }
}

async function saveStore(store) {
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

function ensureStoreShape(store) {
  const s = store && typeof store === "object" ? store : {};
  if (!Array.isArray(s.proposals)) s.proposals = [];
  if (!s.nonsense || typeof s.nonsense !== "object") s.nonsense = {};
  if (!s.nonsense.byChannel || typeof s.nonsense.byChannel !== "object")
    s.nonsense.byChannel = {};

  // ✅ 추가: 근무 상태 캐시(공지 스팸 방지)
  if (!s.work || typeof s.work !== "object") s.work = {};
  if (!s.work.last || typeof s.work.last !== "object") s.work.last = {};
  // s.work.last: { [userKey]: boolean }

  return s;
}

async function withStore(mutator) {
  const store = await loadStore();
  const result = await mutator(store);
  await saveStore(store);
  return result;
}

// =========================
// 시간/날짜 유틸
// =========================
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

  if (!raw || raw === MESSAGES.date.today || raw.toLowerCase() === "today")
    return today;
  if (raw === MESSAGES.date.tomorrow || raw.toLowerCase() === "tomorrow")
    return addDaysKst(today, 1);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;

  const [y, m, d] = raw.split("-").map(Number);
  if (y < 2000 || y > 2100) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;

  return raw;
}

// =========================
// /go (시작시간 제안 + 수락/거절)
// =========================
function buildGoButtons(proposalId) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`go:${proposalId}:ACCEPT`)
      .setLabel(MESSAGES.go.buttonAccept)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`go:${proposalId}:DECLINE`)
      .setLabel(MESSAGES.go.buttonDecline)
      .setStyle(ButtonStyle.Danger)
  );
  return [row];
}

function buildGoMessage({ date, start }, responses, conflicts) {
  const lines = [];
  lines.push(MESSAGES.go.proposalTitle);
  lines.push(`- ${MESSAGES.date.dateLabel}: ${date}`);
  lines.push(`- ${MESSAGES.date.startLabel}: ${start}\n`);

  lines.push(MESSAGES.go.askResponse);
  for (const k of USER_KEYS) {
    const nm = userNameFromKey(k);
    const st = responses[k] ?? "PENDING";
    const stKr =
      st === "ACCEPT"
        ? MESSAGES.go.statusAccept
        : st === "DECLINE"
          ? MESSAGES.go.statusDecline
          : MESSAGES.go.statusPending;
    const warn = conflicts[k]?.length ? ` · 겹침: ${conflicts[k].join(", ")}` : "";
    lines.push(`- ${nm}: ${stKr}${warn}`);
  }

  const allAccepted = USER_KEYS.every((k) => (responses[k] ?? "PENDING") === "ACCEPT");
  const anyDeclined = USER_KEYS.some((k) => (responses[k] ?? "PENDING") === "DECLINE");

  if (allAccepted) lines.push(`\n${MESSAGES.go.allAccepted}`);
  else if (anyDeclined) lines.push(`\n${MESSAGES.go.anyDeclined}`);
  else lines.push(`\n${MESSAGES.go.waitingResponse}`);

  return lines.join("\n");
}

// =========================
// FOOD (/lunch)
// =========================
function poolFromCategories(keys) {
  const items = keys.flatMap((k) => FOOD_CATEGORIES?.[k] || []);
  return uniq(items);
}

function getMealPool(mealType) {
  if (mealType === "dinner") {
    return poolFromCategories([
      "meat",
      "seafood",
      "soup_stew",
      "western_chinese",
      "street_food",
      "rice_noodle",
    ]);
  }
  if (mealType === "snack") {
    return poolFromCategories(["dessert_snack", "drink", "street_food"]);
  }
  return poolFromCategories([
    "staple",
    "soup_stew",
    "western_chinese",
    "street_food",
    "rice_noodle",
  ]);
}

function mealLabel(mealType) {
  if (mealType === "dinner") return MESSAGES.meal.dinner;
  if (mealType === "snack") return MESSAGES.meal.snack;
  return MESSAGES.meal.lunch;
}

// =========================
// 넌센스 퀴즈 (/nonsense, /answer) + 15시 자동출제
// =========================
function normalizeAnswer(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[.,!?~'"`]/g, "");
}

function pickNonsenseItem() {
  if (!Array.isArray(NONSENSE_QUIZ) || NONSENSE_QUIZ.length === 0) return null;
  return pick(NONSENSE_QUIZ);
}

function buildNonsenseQuestionText(item) {
  return [
    MESSAGES.nonsense.quizTitle,
    `- ${MESSAGES.nonsenseDetail.problemLabel}: ${item.q}`,
    "",
    MESSAGES.nonsense.answerInstruction,
  ].join("\n");
}

function buildNonsenseCorrectText(item, userMention) {
  return [
    MESSAGES.nonsense.correct,
    `- ${MESSAGES.nonsenseDetail.correctPersonLabel}: ${userMention}`,
    `- ${MESSAGES.nonsenseDetail.answerLabel}: ${item.a}`,
  ].join("\n");
}

async function postNonsenseQuestion(channelId) {
  const item = pickNonsenseItem();
  if (!item) return false;

  const current = await withStore(async (store) => {
    const st = store.nonsense.byChannel[channelId] || {
      current: null,
      attemptsByUser: {},
      createdAt: null,
      messageId: null,
    };

    st.current = { quizId: item.id, q: item.q, a: item.a };
    st.attemptsByUser = {};
    st.createdAt = new Date().toISOString();

    store.nonsense.byChannel[channelId] = st;
    return st.current;
  });

  const ch = await client.channels.fetch(channelId);
  const msg = await ch.send(buildNonsenseQuestionText(current));

  await withStore(async (store) => {
    const st = store.nonsense.byChannel[channelId];
    if (st) st.messageId = msg.id;
  });

  return true;
}

// =========================
// 근무 관리 (역할 토글 + 채널 공지)
// =========================
function getDayOfWeek(date = new Date()) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const day = kst.getUTCDay();
  const dayMap = {
    0: "sun",
    1: "mon",
    2: "tue",
    3: "wed",
    4: "thu",
    5: "fri",
    6: "sat",
  };
  return dayMap[day];
}

function getCurrentTimeInMin() {
  const kst = new Date(new Date().getTime() + 9 * 60 * 60 * 1000);
  const h = kst.getUTCHours();
  const m = kst.getUTCMinutes();
  return h * 60 + m;
}

function isWorkingNow(userKey) {
  const schedule = SCHEDULE[userKey];
  if (!schedule) return false;

  const dayOfWeek = getDayOfWeek();
  const todaySlots = schedule.weeklyBusy[dayOfWeek] || [];
  if (todaySlots.length === 0) return false;

  const currentMin = getCurrentTimeInMin();

  for (const [start, end] of todaySlots) {
    const startMin = normalizeTimeToMin(start);
    const endMin = normalizeTimeToMin(end);
    if (currentMin >= startMin && currentMin < endMin) {
      return true;
    }
  }
  return false;
}

// 역할 생성/조회 캐시(불필요한 create/검색 줄이기)
const roleCache = new Map(); // key: guildId|roleName -> Role

async function ensureRoleExists(guild, roleName, colorHex) {
  const key = `${guild.id}|${roleName}`;
  const cached = roleCache.get(key);
  if (cached) return cached;

  // cache 최신화 (봇 재시작 시를 대비)
  if (guild.roles?.cache?.size === 0) {
    try {
      await guild.roles.fetch();
    } catch {}
  }

  let role = guild.roles.cache.find((r) => r.name === roleName);
  if (role) {
    roleCache.set(key, role);
    return role;
  }

  const color = parseInt(String(colorHex).replace("#", ""), 16);

  // ✅ deprecation 대응: color -> colors
  role = await guild.roles.create({
    name: roleName,
    colors: { primaryColor: color },
    mentionable: false,
  });

  roleCache.set(key, role);
  return role;
}

async function toggleWorkRoles(guild, userKey, shouldHaveRoles) {
  const userMeta = USER_META[userKey];
  if (!userMeta) return false;

  const member = await guild.members.fetch(userMeta.discordId).catch(() => null);
  if (!member) return false;

  const commonRole = await ensureRoleExists(
    guild,
    WORK_ROLES.common.name,
    WORK_ROLES.common.color
  ).catch(() => null);

  const personalRole = await ensureRoleExists(
    guild,
    WORK_ROLES[userKey].name,
    WORK_ROLES[userKey].color
  ).catch(() => null);

  if (!commonRole || !personalRole) return false;

  try {
    if (shouldHaveRoles) {
      const toAdd = [];
      if (!member.roles.cache.has(commonRole.id)) toAdd.push(commonRole);
      if (!member.roles.cache.has(personalRole.id)) toAdd.push(personalRole);
      if (toAdd.length) await member.roles.add(toAdd);
    } else {
      const toRemove = [];
      if (member.roles.cache.has(commonRole.id)) toRemove.push(commonRole);
      if (member.roles.cache.has(personalRole.id)) toRemove.push(personalRole);
      if (toRemove.length) await member.roles.remove(toRemove);
    }
    return true;
  } catch (e) {
    // 권한 없으면 여기로 옴. 공지 로직엔 영향 X
    console.error("[toggleWorkRoles] failed:", e?.code, e?.message);
    return false;
  }
}

async function checkAndUpdateWorkRoles(guild, silent = false) {
  // ✅ 공지는 상태 변화가 있을 때만 발생
  const changes = [];

  await withStore(async (store) => {
    const keys = ["youjung", "youngjin", "myeongjae"];

    for (const userKey of keys) {
      const nowWorking = isWorkingNow(userKey);
      const prevWorking = store.work?.last?.[userKey];

      // 최초 1회는 기준만 잡고 공지하지 않음(스팸 방지)
      if (typeof prevWorking !== "boolean") {
        store.work.last[userKey] = nowWorking;
        continue;
      }

      // 변화 없으면 아무 것도 안 함
      if (nowWorking === prevWorking) continue;

      // ✅ 상태 변화 발생: store 갱신 + 공지 등록
      store.work.last[userKey] = nowWorking;
      if (!silent) {
        changes.push({ userKey, action: nowWorking ? "start" : "end" });
      }

      // 역할 토글은 "부가 기능" (권한 없어도 공지 정상)
      // 실패해도 변화/공지에는 영향 없음
      await toggleWorkRoles(guild, userKey, nowWorking);
    }
  });

  return changes;
}

async function sendWorkAnnouncement(channel, userKey, action) {
  const userName = USER_META[userKey]?.name || userKey;
  const timeStr = new Date().toLocaleTimeString("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
  });

  if (action === "start") {
    await channel.send(MESSAGES.work.start(userName, timeStr));
  } else if (action === "end") {
    await channel.send(MESSAGES.work.end(userName, timeStr));
  }
}

function getTodaySchedule() {
  const dayOfWeek = getDayOfWeek();
  const schedule = [];

  for (const userKey of ["youjung", "youngjin", "myeongjae"]) {
    const userSchedule = SCHEDULE[userKey];
    if (!userSchedule) continue;

    const todaySlots = userSchedule.weeklyBusy[dayOfWeek] || [];
    if (todaySlots.length === 0) continue;

    const userName = userSchedule.name;
    for (const [start, end] of todaySlots) {
      schedule.push({ name: userName, start, end });
    }
  }

  return schedule;
}

async function sendDailyScheduleSummary(channel) {
  const schedule = getTodaySchedule();
  if (schedule.length === 0) return;

  const lines = [MESSAGES.work.scheduleTitle];
  for (const item of schedule) {
    lines.push(MESSAGES.work.scheduleItem(item.name, item.start, item.end));
  }

  await channel.send(lines.join("\n"));
}

function getWorkStartTimes() {
  const dayOfWeek = getDayOfWeek();
  const startTimes = [];

  for (const userKey of ["youjung", "youngjin", "myeongjae"]) {
    const userSchedule = SCHEDULE[userKey];
    if (!userSchedule) continue;

    const todaySlots = userSchedule.weeklyBusy[dayOfWeek] || [];
    if (todaySlots.length === 0) continue;

    for (const [start] of todaySlots) {
      startTimes.push({ userKey, userName: userSchedule.name, start });
    }
  }

  return startTimes;
}

async function fetchWeatherTempOnly(cityRaw) {
  const city = cityRaw || process.env.WEATHER_DEFAULT_CITY || "Seoul";
  const key = process.env.WEATHER_API_KEY;
  const units = process.env.WEATHER_UNITS || "metric";

  if (!key) throw new Error(MESSAGES.weatherDetail.apiKeyError);

  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
    city
  )}&appid=${key}&units=${units}&lang=kr`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather API error: ${res.status}`);
  const w = await res.json();

  const temp = Math.round(w.main?.temp ?? 0);
  const feels = Math.round(w.main?.feels_like ?? temp);
  return { temp, feels };
}

async function sendWeatherForWorkStart(channel, userKey, userName) {
  try {
    const { temp, feels } = await fetchWeatherTempOnly(process.env.WEATHER_DEFAULT_CITY);
    await channel.send(MESSAGES.work.weatherTempOnly(userName, temp, feels));
  } catch (e) {
    console.error(MESSAGES.console.weatherError, e);
  }
}

// =========================
// 날씨 (/weather) + 근무시작 알림
// =========================
async function fetchWeather(cityRaw) {
  const city = cityRaw || process.env.WEATHER_DEFAULT_CITY || "Seoul";
  const key = process.env.WEATHER_API_KEY;
  const units = process.env.WEATHER_UNITS || "metric";
  const lang = process.env.WEATHER_LANG || "kr";

  if (!key) throw new Error(MESSAGES.weatherDetail.apiKeyError);

  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
    city
  )}&appid=${key}&units=${units}&lang=${lang}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather API error: ${res.status}`);
  const w = await res.json();

  const name = w.name;
  const desc = w.weather?.[0]?.description || MESSAGES.weatherDetail.weatherInfo;
  const temp = Math.round(w.main?.temp);
  const feels = Math.round(w.main?.feels_like);
  const hum = w.main?.humidity;
  const wind = w.wind?.speed;

  const nags = [];
  if (Number.isFinite(feels)) {
    if (feels <= 0) nags.push(MESSAGES.weather.coldWarning);
    else if (feels <= 8) nags.push(MESSAGES.weather.chillyWarning);
    else if (feels >= 28) nags.push(MESSAGES.weather.hotWarning);
  }
  if (typeof hum === "number" && hum >= 75) nags.push(MESSAGES.weather.humidWarning);
  if (typeof wind === "number" && wind >= 6) nags.push(MESSAGES.weather.windyWarning);

  const nagText = nags.length ? `\n${nags.join(" ")}` : `\n${MESSAGES.weather.normalWarning}`;

  return MESSAGES.weatherDetail.weatherFormat(name, desc, temp, feels, hum, wind) + nagText;
}

// =========================
// 사주 (/사주) API + Embed
// =========================
const SAJU_BIRTH_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function validateSajuBirth(birthStr) {
  if (!birthStr || typeof birthStr !== "string") return false;
  const trimmed = birthStr.trim();
  if (!SAJU_BIRTH_REGEX.test(trimmed)) return false;
  const [datePart, timePart] = trimmed.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm, ss] = timePart.split(":").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 59) return false;
  const lastDay = new Date(y, m, 0).getDate();
  if (d > lastDay) return false;
  return true;
}

async function fetchSajuFortune({ birth, gender, city, midnightType, calendar }) {
  const key = process.env.SAJU_API_KEY;
  if (!key) return { ok: false, error: MESSAGES.saju.apiKeyError };

  const params = new URLSearchParams();
  params.set("birth", birth.trim());
  params.set("gender", gender);
  if (city && String(city).trim()) params.set("city", String(city).trim());
  if (midnightType !== undefined && midnightType !== null) params.set("midnightType", String(midnightType));
  if (calendar && String(calendar).trim()) params.set("calendar", String(calendar).trim());

  const url = `https://api.ablecity.kr/api/v1/saju/fortune?${params.toString()}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const text = await res.text();
      let errMsg = `API ${res.status}`;
      try {
        const j = JSON.parse(text);
        if (j.message) errMsg = j.message;
      } catch {}
      return { ok: false, error: errMsg };
    }

    const body = await res.json();
    const data = body?.data ?? body;
    const sinsal = body?.data?.sinsal ?? body?.sinsal ?? null;
    return { ok: true, data, sinsal, raw: body };
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") return { ok: false, error: "요청 시간 초과" };
    return { ok: false, error: e.message || String(e) };
  }
}

function truncateField(str, maxLen = 1024) {
  const s = String(str ?? "").trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

function fmtNum(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "-";
  return (Math.round(n * 100) / 100).toString();
}

function detectStrengthLabel(strengthRaw) {
  const s = String(strengthRaw ?? "").toLowerCase();
  if (!s) return null;
  if (s.includes("weak")) return "weak";
  if (s.includes("strong")) return "strong";
  return s;
}

function detectGeokLabel(geokguk) {
  const g = geokguk?.geok_kor || geokguk?.geok || "";
  return String(g || "").trim() || null;
}

function detectYongshinLabel(yongshin) {
  const primary =
    yongshin?.primary ?? yongshin?.primary_kor ?? yongshin?.primaryKor ?? null;
  const secondary =
    yongshin?.secondary ?? yongshin?.secondary_kor ?? yongshin?.secondaryKor ?? null;

  const parts = [primary, secondary].filter(Boolean).map(String);
  return parts.length ? parts.join(" / ") : null;
}

function buildInterpretationText(data) {
  const strength = detectStrengthLabel(data?.strength);
  const geok = detectGeokLabel(data?.geokguk);
  const yongshin = detectYongshinLabel(data?.yongshin);
  const fortune = data?.fortune;

  const five = data?.five_kor && typeof data.five_kor === "object" ? data.five_kor : null;
  const needElem = data?.lucky?.need_elem_kor || null;

  const bigLuck = Array.isArray(data?.big_luck) ? data.big_luck : [];

  let summary = "핵심 요약: (데이터 부족)";
  if (strength === "weak") {
    summary =
      "핵심 요약: 기본 에너지가 약한 편이라, 혼자 버티기보다 환경·사람·흐름을 잘 타야 하는 타입입니다.";
  } else if (strength === "strong") {
    summary =
      "핵심 요약: 기본 에너지가 강한 편이라, 목표를 정하고 밀어붙일 때 성과가 잘 나는 타입입니다.";
  } else if (strength) {
    summary =
      `핵심 요약: 일간 강약(${strength}) 성향에 맞춰 환경과 루틴을 잡는 게 중요합니다.`;
  }

  let strengthBlock = "";
  if (strength === "weak") {
    strengthBlock = [
      "일간 강약: weak",
      "- 에너지가 센 사주가 아니라 무작정 버티는 방식이 불리합니다.",
      "- 스트레스가 누적되면 급격히 소진될 수 있어, 회복 루틴이 핵심입니다.",
      "- 야근/압박/혼자 책임 구조가 길어지면 손해를 보기 쉽습니다.",
      "- 환경이 받쳐주면 안정적으로 성장합니다.",
    ].join("\n");
  } else if (strength === "strong") {
    strengthBlock = [
      "일간 강약: strong",
      "- 체력/추진력이 강한 편이라 목표를 정하고 밀어붙이는 방식이 유리합니다.",
      "- 다만 과속/과로로 균형이 깨지지 않게 관리가 필요합니다.",
    ].join("\n");
  } else if (strength) {
    strengthBlock = `일간 강약: ${strength}`;
  }

  let geokBlock = "";
  if (geok) {
    if (String(geok).includes("정재")) {
      geokBlock = [
        "격국: 정재격",
        "- 성실/규칙/계획/안정 수입(월급형)과 궁합이 좋습니다.",
        "- 한방/투기/모험보다 '꾸준히 쌓는 구조'가 강점입니다.",
        "- 회사·조직·플랫폼·시스템 안에서 성과가 잘 납니다.",
      ].join("\n");
    } else {
      geokBlock = `격국: ${geok}`;
    }
  }

  let fiveBlock = "";
  if (five) {
    const parts = Object.entries(five).map(([k, v]) => `${k}: ${fmtNum(v)}`);
    fiveBlock = [
      "오행 분포:",
      `- ${parts.join(", ")}`,
    ].join("\n");
  }

  let yongBlock = "";
  if (yongshin) {
    const yl = yongshin.toLowerCase();
    const tips = [];
    if (yl.includes("water")) tips.push("휴식/회복, 감정 순환, 여유/흐름");
    if (yl.includes("wood")) tips.push("학습/성장, 기록/정리, 꾸준히 쌓기");
    yongBlock = [
      `용신: ${yongshin}`,
      tips.length ? `- 실생활 적용: ${tips.join(" + ")}` : "",
      "- 쉬지 않고 버티면 성과가 꺾이기 쉬워, 회복 루틴을 우선으로 두는 편이 안전합니다.",
    ].filter(Boolean).join("\n");
  }

  let luckBlock = "";
  if (bigLuck.length) {
    const shown = bigLuck.slice(0, 5).map((p) => {
      const range = p.age_range ?? p.year_range ?? "";
      const pillar = p.pillar_kor ?? p.pillar ?? "";
      return `${range} ${pillar}`.trim();
    });
    luckBlock = [
      "대운(요약):",
      `- ${shown.join(" · ")}`,
      "- 대운은 '지금 시기엔 무엇을 우선해야 유리한지' 참고용으로 보시면 됩니다.",
    ].join("\n");
  }

  let opsBlock = "";
  if (strength === "weak") {
    opsBlock = [
      "운영 방식(추천):",
      "- 밤샘/체력 갈아넣기보다 루틴(수면·운동·식사) 고정이 최우선입니다.",
      "- 계획 + 기록 + 구조화가 성과를 만듭니다.",
      "- 불확실한 도전보다 '안정 수입 + 점진적 성장' 전략이 유리합니다.",
    ].join("\n");
  } else if (strength === "strong") {
    opsBlock = [
      "운영 방식(추천):",
      "- 목표를 명확히 하고 실행량을 확보하면 성과가 빠릅니다.",
      "- 다만 과로로 리듬이 깨지지 않게 \"멈추는 루틴\"도 같이 설계하세요.",
    ].join("\n");
  }

  let needBlock = "";
  if (needElem) {
    needBlock = `보완 포인트(필요 오행): ${needElem}`;
  }

  const blocks = [
    summary,
    fortune != null ? `종합 지표: ${fortune}` : null,
    strengthBlock || null,
    geokBlock || null,
    fiveBlock || null,
    yongBlock || null,
    needBlock || null,
    luckBlock || null,
    opsBlock || null,
  ].filter(Boolean);

  return blocks.join("\n\n");
}

function buildSajuEmbed(body, birthLabel, hasSinsal) {
  const data = body.data ?? body;
  const embed = new EmbedBuilder();

  const title = `사주: ${birthLabel}`;
  embed.setTitle(truncateField(title, 256));

  const parts = [];

  const year = data.year;
  const month = data.month;
  const day = data.day;
  const hour = data.hour;
  if (year || month || day || hour) {
    const yStr = year?.hangul || year?.hanja || "-";
    const mStr = month?.hangul || month?.hanja || "-";
    const dStr = day?.hangul || day?.hanja || "-";
    const hStr = hour?.hangul || hour?.hanja || "-";
    parts.push(`**사주 4기둥**\n년 ${yStr} / 월 ${mStr} / 일 ${dStr} / 시 ${hStr}`);
  }

  if (data.fortune != null) {
    parts.push(`**종합 지표** ${data.fortune}`);
  }

  if (data.five_kor && typeof data.five_kor === "object") {
    const fiveLines = Object.entries(data.five_kor).map(([k, v]) => `${k}: ${v}`).join(", ");
    parts.push(`**오행** ${truncateField(fiveLines, 500)}`);
  } else if (data.five_star) {
    parts.push(`**오행** ${truncateField(String(data.five_star), 500)}`);
  }

  if (data.twelve_growth_kor) {
    const tw = data.twelve_growth_kor;
    const twStr = typeof tw === "object" ? [tw.year, tw.month, tw.day, tw.hour].filter(Boolean).join(" / ") : String(tw);
    parts.push(`**십이운성** ${truncateField(twStr, 500)}`);
  }

  if (data.strength) {
    parts.push(`**일간 강약** ${String(data.strength)}`);
  }

  if (data.geokguk && typeof data.geokguk === "object") {
    const gk = data.geokguk;
    const gkName = gk.geok_kor || gk.geok || null;
    if (gkName) parts.push(`**격국** ${truncateField(gkName, 300)}`);
  }

  if (data.yongshin) {
    const ys = data.yongshin;
    const primary = ys?.primary ?? ys?.primary_kor ?? ys?.primaryKor;
    const secondary = ys?.secondary ?? ys?.secondary_kor ?? ys?.secondaryKor;
    const ysParts = [primary, secondary].filter(Boolean).map(String);
    if (ysParts.length) parts.push(`**용신** ${truncateField(ysParts.join(" / "), 300)}`);
  }

  const br = data.branch_relations_kor;
  if (br && typeof br === "object") {
    const brLines = [];
    const pushIf = (label, arr) => {
      if (Array.isArray(arr) && arr.length) brLines.push(`${label}: ${arr.join(", ")}`);
    };
    pushIf("합", br.harmonies);
    pushIf("파", br.breaks);
    pushIf("삼합", br.three_harmonies);
    pushIf("형", br.punishments);
    pushIf("해", br.harms);
    pushIf("충", br.clashes);
    if (brLines.length) parts.push(`**지지 관계**\n${truncateField(brLines.join("\n"), 800)}`);
  }

  if (Array.isArray(data.big_luck) && data.big_luck.length) {
    const maxLuck = 5;
    const luckLines = data.big_luck.slice(0, maxLuck).map((p) => {
      const range = p.age_range ?? p.year_range ?? "";
      const pillar = p.pillar_kor ?? p.pillar ?? "";
      return `${range} ${pillar}`.trim();
    });
    parts.push(`**대운**\n${truncateField(luckLines.join("\n"), 800)}`);
  }

  if (data.lucky && typeof data.lucky === "object") {
    const l = data.lucky;
    const luckyParts = [];
    if (l.good_num) luckyParts.push(`길한 수: ${l.good_num}`);
    if (l.bad_num) luckyParts.push(`흉한 수: ${l.bad_num}`);
    if (l.good_dir) luckyParts.push(`길한 방위: ${l.good_dir}`);
    if (l.bad_dir) luckyParts.push(`흉한 방위: ${l.bad_dir}`);
    if (l.need_elem_kor) luckyParts.push(`필요 오행: ${l.need_elem_kor}`);
    if (Array.isArray(l.good_colors)) luckyParts.push(`길한 색: ${l.good_colors.join(", ")}`);
    else if (l.good_colors) luckyParts.push(`길한 색: ${String(l.good_colors)}`);
    if (Array.isArray(l.bad_color)) luckyParts.push(`흉한 색: ${l.bad_color.join(", ")}`);
    else if (l.bad_color) luckyParts.push(`흉한 색: ${String(l.bad_color)}`);
    if (luckyParts.length) parts.push(`**행운 요소**\n${truncateField(luckyParts.join(" | "), 800)}`);
  }

  const fullDesc = parts.join("\n\n");
  embed.setDescription(truncateField(fullDesc, 4096));

  const interpretation = buildInterpretationText(data);
  embed.addFields({
    name: "해석(요약)",
    value: truncateField(interpretation, 1024),
  });

  if (hasSinsal) {
    embed.setFooter({ text: MESSAGES.saju.sinsalBeta });
  }

  return embed;
}

// =========================
// ready
// =========================
client.once("ready", async () => {
  console.log(MESSAGES.console.login(client.user.tag));

  const channelId = process.env.CHANNEL_ID; // 공지/날씨/넌센스 채널
  const workChannelId = process.env.WORK_CHANNEL_ID || channelId; // 근무 공지 채널
  const guildId = process.env.GUILD_ID; // ✅ 길드(서버) ID

  if (!channelId) console.warn(MESSAGES.console.channelIdNotSet);
  if (!guildId) console.warn(MESSAGES.console.guildIdNotSet);

  // 봇 시작 시 초기 상태 동기화
  if (guildId) {
    try {
      const guild = await client.guilds.fetch(guildId);
      await checkAndUpdateWorkRoles(guild, true);
      console.log(MESSAGES.console.workRoleSyncComplete);
    } catch (e) {
      console.error(MESSAGES.console.workRoleSyncError, e);
    }
  }

  // 근무 역할 자동 토글 (1분마다 체크)
  if (guildId) {
    cron.schedule(
      "* * * * *",
      async () => {
        try {
          const guild = await client.guilds.fetch(guildId);
          const changes = await checkAndUpdateWorkRoles(guild);

          if (changes.length > 0 && workChannelId) {
            const workChannel = await client.channels.fetch(workChannelId).catch(() => null);
            if (workChannel) {
              for (const change of changes) {
                await sendWorkAnnouncement(workChannel, change.userKey, change.action);
              }
            }
          }
        } catch (e) {
          console.error(MESSAGES.console.workRoleToggleError, e);
        }
      },
      { timezone: "Asia/Seoul" }
    );
  }

  // 08:30 일정 요약
  if (workChannelId) {
    cron.schedule(
      "30 8 * * *",
      async () => {
        try {
          const workChannel = await client.channels.fetch(workChannelId).catch(() => null);
          if (workChannel) await sendDailyScheduleSummary(workChannel);
        } catch (e) {
          console.error(MESSAGES.console.scheduleSummaryError, e);
        }
      },
      { timezone: "Asia/Seoul" }
    );
  }

  // 출근 30분 전 날씨 알림 (현재·체감 온도만)
  if (channelId) {
    cron.schedule(
      "30 8,11,18,19,20 * * *",
      async () => {
        try {
          const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
          const totalMin = kst.getUTCHours() * 60 + kst.getUTCMinutes();
          const in30 = totalMin + 30;
          const targetHour = Math.floor(in30 / 60) % 24;
          const targetMin = in30 % 60;
          const targetStart = `${String(targetHour).padStart(2, "0")}:${String(targetMin).padStart(2, "0")}`;

          const ch = await client.channels.fetch(channelId);
          const todayStartTimes = getWorkStartTimes();

          for (const { userKey, userName, start } of todayStartTimes) {
            if (start === targetStart) {
              await sendWeatherForWorkStart(ch, userKey, userName);
            }
          }
        } catch (e) {
          console.error(MESSAGES.console.weatherError, e);
        }
      },
      { timezone: "Asia/Seoul" }
    );
  }

  // 15:00 넌센스 자동 출제
  if (channelId) {
    cron.schedule(
      "0 15 * * *",
      async () => {
        try {
          const ok = await postNonsenseQuestion(channelId);
          if (!ok) console.warn(MESSAGES.console.nonsenseDbEmpty);
        } catch (e) {
          console.error(MESSAGES.console.nonsenseAutoError, e);
        }
      },
      { timezone: "Asia/Seoul" }
    );
  }
});

// =========================
// interaction
// =========================
client.on("interactionCreate", async (interaction) => {
  // ---------- 슬래시 ----------
  if (interaction.isChatInputCommand()) {
    // /lunch
    if (interaction.commandName === "lunch") {
      const type = interaction.options.getString("type") || "lunch";
      const pool = getMealPool(type);

      if (!pool.length) {
        await interaction.reply(MESSAGES.lunch.noMenu);
        return;
      }

      const menu = pick(pool);
      await interaction.reply(
        `${mealLabel(type)}${MESSAGES.lunch.menuSuffix} **${menu}**\n${MESSAGES.lunch.menuEnd}`
      );
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
        await interaction.editReply(`${MESSAGES.weather.question}\n${msg}`);
      } catch (e) {
        console.error(e);
        await interaction.editReply(MESSAGES.weather.error);
      }
      return;
    }

    // /사주
    if (interaction.commandName === MESSAGES.commands.saju.name) {
      const birthRaw = interaction.options.getString("birth", true);
      const gender = interaction.options.getString("gender", true);
      const city = interaction.options.getString("city");
      const calendar = interaction.options.getString("calendar");
      const midnightType = interaction.options.getInteger("midnighttype");

      if (!validateSajuBirth(birthRaw)) {
        await interaction.reply({
          content: MESSAGES.saju.invalidBirth,
          ephemeral: true,
        });
        return;
      }
      if (gender !== "male" && gender !== "female") {
        await interaction.reply({
          content: MESSAGES.saju.invalidGender,
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply();

      const birth = birthRaw.trim();
      const result = await fetchSajuFortune({
        birth,
        gender,
        city: city?.trim(),
        midnightType: midnightType ?? 0,
        calendar: calendar?.trim() || "solar",
      });

      if (!result.ok) {
        await interaction.editReply(result.error || MESSAGES.saju.apiError);
        return;
      }

      const hasSinsal = result.sinsal != null;
      const embed = buildSajuEmbed(result.raw ?? result.data, birth, hasSinsal);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // /nonsense
    if (interaction.commandName === "nonsense") {
      await interaction.deferReply();

      if (!Array.isArray(NONSENSE_QUIZ) || NONSENSE_QUIZ.length === 0) {
        await interaction.editReply(MESSAGES.nonsense.emptyDb);
        return;
      }

      try {
        await postNonsenseQuestion(interaction.channelId);
        await interaction.editReply(MESSAGES.nonsense.questionPosted);
      } catch (e) {
        console.error(e);
        await interaction.editReply(MESSAGES.nonsense.questionError);
      }
      return;
    }

    // /answer (2번 틀리면 정답 공개: 본인에게만)
    if (interaction.commandName === "answer") {
      const text = interaction.options.getString("text", true);

      const result = await withStore(async (store) => {
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
          return {
            ok: true,
            type: "REVEAL_TO_USER",
            current: st.current,
            tries: nextTries,
          };
        }
        return { ok: true, type: "WRONG", tries: nextTries };
      });

      if (!result.ok) {
        await interaction.reply({ content: MESSAGES.nonsense.noQuestion, ephemeral: true });
        return;
      }

      if (result.type === "CORRECT") {
        await interaction.reply(
          buildNonsenseCorrectText(result.current, `<@${interaction.user.id}>`)
        );
        return;
      }

      if (result.type === "WRONG") {
        await interaction.reply({
          content: MESSAGES.nonsense.wrong(result.tries),
          ephemeral: true,
        });
        return;
      }

      if (result.type === "REVEAL_TO_USER") {
        await interaction.reply({
          content: MESSAGES.nonsense.revealAnswer(result.current.q, result.current.a),
          ephemeral: true,
        });
        return;
      }

      return;
    }

    // /go
    if (interaction.commandName === "go") {
      const dayRaw = interaction.options.getString("day");
      const date = parseGoDay(dayRaw);

      if (!date) {
        await interaction.reply({
          content: MESSAGES.go.invalidDay,
          ephemeral: true,
        });
        return;
      }

      const start = interaction.options.getString("start", true);
      if (!isHHMM(start) || start === "24:00") {
        await interaction.reply({
          content: MESSAGES.go.invalidStart,
          ephemeral: true,
        });
        return;
      }

      const proposalId = crypto.randomUUID().slice(0, 8);
      const responses = {};
      for (const k of USER_KEYS) responses[k] = "PENDING";

      const conflicts = {};
      const content = buildGoMessage({ date, start }, responses, conflicts);
      const rows = buildGoButtons(proposalId);

      const msg = await interaction.reply({ content, components: rows, fetchReply: true });

      await withStore(async (store) => {
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

    return;
  }

  // ---------- 버튼(/go) ----------
  if (interaction.isButton()) {
    const [prefix, proposalId, action] = interaction.customId.split(":");
    if (prefix !== "go") return;

    const callerKey = userKeyFromDiscordId(interaction.user.id);
    if (!callerKey) {
      await interaction.reply({
        content: MESSAGES.go.notRegisteredMember,
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
        content: MESSAGES.go.proposalNotFound,
        ephemeral: true,
      });
      return;
    }

    const conflicts = {};
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
