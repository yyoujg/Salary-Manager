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
} from "discord.js";

import { FOOD_CATEGORIES, NONSENSE_QUIZ, SCHEDULE, WORK_ROLES } from "./data.js";
import { MESSAGES } from "./messages.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// =========================
// 설정(고정 멤버/DB 경로)
// =========================
const STORE_PATH = path.resolve(process.cwd(), "store.json");

// 친구 목록 (고정)
// - 이전에 주신 디스코드 ID 기준
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

  if (!raw || raw === MESSAGES.date.today || raw.toLowerCase() === "today") return today;
  if (raw === MESSAGES.date.tomorrow || raw.toLowerCase() === "tomorrow") return addDaysKst(today, 1);

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
    const stKr = st === "ACCEPT" ? MESSAGES.go.statusAccept : st === "DECLINE" ? MESSAGES.go.statusDecline : MESSAGES.go.statusPending;
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
  return poolFromCategories(["staple", "soup_stew", "western_chinese", "street_food", "rice_noodle"]);
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
  const dayMap = { 0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat" };
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

async function ensureRoleExists(guild, roleName, colorHex) {
  let role = guild.roles.cache.find((r) => r.name === roleName);
  if (role) return role;

  const color = parseInt(colorHex.replace("#", ""), 16);
  role = await guild.roles.create({
    name: roleName,
    color: color,
    mentionable: false,
  });
  return role;
}

async function toggleWorkRoles(guild, userKey, shouldHaveRoles) {
  const userMeta = USER_META[userKey];
  if (!userMeta) return false;

  const member = await guild.members.fetch(userMeta.discordId).catch(() => null);
  if (!member) return false;

  const commonRole = await ensureRoleExists(guild, WORK_ROLES.common.name, WORK_ROLES.common.color);
  const personalRole = await ensureRoleExists(guild, WORK_ROLES[userKey].name, WORK_ROLES[userKey].color);

  if (shouldHaveRoles) {
    if (!member.roles.cache.has(commonRole.id)) {
      await member.roles.add(commonRole);
    }
    if (!member.roles.cache.has(personalRole.id)) {
      await member.roles.add(personalRole);
    }
  } else {
    if (member.roles.cache.has(commonRole.id)) {
      await member.roles.remove(commonRole);
    }
    if (member.roles.cache.has(personalRole.id)) {
      await member.roles.remove(personalRole);
    }
  }
  return true;
}

async function checkAndUpdateWorkRoles(guild, silent = false) {
  const changes = [];
  for (const userKey of ["youjung", "youngjin", "myeongjae"]) {
    const isWorking = isWorkingNow(userKey);
    const userMeta = USER_META[userKey];
    if (!userMeta) continue;

    const member = await guild.members.fetch(userMeta.discordId).catch(() => null);
    if (!member) continue;

    const commonRole = await ensureRoleExists(guild, WORK_ROLES.common.name, WORK_ROLES.common.color);
    const personalRole = await ensureRoleExists(guild, WORK_ROLES[userKey].name, WORK_ROLES[userKey].color);

    await guild.roles.fetch();
    await member.roles.fetch();

    const hasCommonRole = member.roles.cache.has(commonRole.id);
    const hasPersonalRole = member.roles.cache.has(personalRole.id);
    const currentlyHasRoles = hasCommonRole && hasPersonalRole;

    if (isWorking && !currentlyHasRoles) {
      await toggleWorkRoles(guild, userKey, true);
      if (!silent) {
        changes.push({ userKey, action: "start" });
      }
    } else if (!isWorking && currentlyHasRoles) {
      await toggleWorkRoles(guild, userKey, false);
      if (!silent) {
        changes.push({ userKey, action: "end" });
      }
    }
  }
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

async function sendWeatherForWorkStart(channel, userKey, userName) {
  try {
    const msg = await fetchWeather(process.env.WEATHER_DEFAULT_CITY);
    await channel.send(`${MESSAGES.work.weatherPrefix(userName)}\n${msg}`);
  } catch (e) {
    console.error(MESSAGES.console.weatherError, e);
  }
}

// =========================
// 날씨 (/weather) + 07시 자동알림
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
  if (typeof hum === "number" && hum >= 75)
    nags.push(MESSAGES.weather.humidWarning);
  if (typeof wind === "number" && wind >= 6)
    nags.push(MESSAGES.weather.windyWarning);

  const nagText = nags.length ? `\n${nags.join(" ")}` : `\n${MESSAGES.weather.normalWarning}`;

  return MESSAGES.weatherDetail.weatherFormat(name, desc, temp, feels, hum, wind) + nagText;
}

// =========================
// ready
// =========================
client.once("clientReady", async () => {
  console.log(MESSAGES.console.login(client.user.tag));

  const channelId = process.env.CHANNEL_ID;
  const workChannelId = process.env.WORK_CHANNEL_ID || channelId;
  const guildId = process.env.CHANNEL_ID;

  if (!channelId) {
    console.warn(MESSAGES.console.channelIdNotSet);
  }

  if (!guildId) {
    console.warn(MESSAGES.console.guildIdNotSet);
  }

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
          if (workChannel) {
            await sendDailyScheduleSummary(workChannel);
          }
        } catch (e) {
          console.error(MESSAGES.console.scheduleSummaryError, e);
        }
      },
      { timezone: "Asia/Seoul" }
    );
  }

  // 근무 시작 시간에 맞춰 날씨 알림
  if (channelId) {
    const weatherTimes = new Set(["09:00", "12:00", "19:00", "20:00", "21:00"]);

    // 각 시간대별로 cron 설정
    for (const startTime of weatherTimes) {
      const [hour, minute] = startTime.split(":").map(Number);
      const cronPattern = `${minute} ${hour} * * *`;

      cron.schedule(
        cronPattern,
        async () => {
          try {
            const ch = await client.channels.fetch(channelId);
            const todayStartTimes = getWorkStartTimes();

            for (const { userKey, userName, start } of todayStartTimes) {
              if (start === startTime) {
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
      await interaction.reply(`${mealLabel(type)}${MESSAGES.lunch.menuSuffix} **${menu}**\n${MESSAGES.lunch.menuEnd}`);
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
          return { ok: true, type: "REVEAL_TO_USER", current: st.current, tries: nextTries };
        }
        return { ok: true, type: "WRONG", tries: nextTries };
      });

      if (!result.ok) {
        await interaction.reply({ content: MESSAGES.nonsense.noQuestion, ephemeral: true });
        return;
      }

      if (result.type === "CORRECT") {
        await interaction.reply(buildNonsenseCorrectText(result.current, `<@${interaction.user.id}>`));
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

    // /go (추천 없음, 시작시간만)
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
    const content = buildGoMessage({ date: updated.date, start: updated.start }, updated.responses, conflicts);

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
