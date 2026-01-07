// registerCommands.js
import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

const commands = [
  // /lunch
  new SlashCommandBuilder()
    .setName("lunch")
    .setDescription("할매가 점심/저녁/간식 메뉴 하나 딱 찍어준다.")
    .addStringOption((o) =>
      o
        .setName("type")
        .setDescription("뭐 추천받을끼고? (기본: 점심)")
        .setRequired(false)
        .addChoices(
          { name: "점심", value: "lunch" },
          { name: "저녁", value: "dinner" },
          { name: "간식", value: "snack" }
        )
    ),

  // /nonsense
  new SlashCommandBuilder()
    .setName("nonsense")
    .setDescription("할매가 넌센스 퀴즈 문제 하나 낸다 아이가."),

  // /answer
  new SlashCommandBuilder()
    .setName("answer")
    .setDescription("넌센스 퀴즈 정답 입력한다 아이가.")
    .addStringOption((o) => o.setName("text").setDescription("정답").setRequired(true)),

  // /weather
  new SlashCommandBuilder()
    .setName("weather")
    .setDescription("할매가 지금 날씨 알려준다 아이가.")
    .addStringOption((o) =>
      o
        .setName("city")
        .setDescription("도시명 (예: Seoul, Busan). 안 넣으면 기본 도시로 한다.")
        .setRequired(false)
    ),

  // /busy
  new SlashCommandBuilder()
    .setName("busy")
    .setDescription("못 되는 시간(바쁜 시간) 적어두는 기다.")
    .addSubcommand((sc) =>
      sc
        .setName("add")
        .setDescription("내 바쁜 시간 추가한다(본인만).")
        .addStringOption((o) => o.setName("date").setDescription("날짜 (YYYY-MM-DD)").setRequired(true))
        .addStringOption((o) => o.setName("start").setDescription("시작 (HH:MM)").setRequired(true))
        .addStringOption((o) => o.setName("end").setDescription("끝 (HH:MM)").setRequired(true))
        .addStringOption((o) => o.setName("reason").setDescription("사유(선택)").setRequired(false))
    )
    .addSubcommand((sc) =>
      sc
        .setName("list")
        .setDescription("바쁜 시간 본다(전체 또는 특정 사람).")
        .addStringOption((o) =>
          o
            .setName("user")
            .setDescription("유저 키(youngjin/minsu/youjung/myeongjae). 안 넣으면 본인 걸로 본다.")
            .setRequired(false)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("remove")
        .setDescription("내 바쁜 시간 하나 지운다(본인만).")
        .addStringOption((o) => o.setName("id").setDescription("busy id").setRequired(true))
    )
    .addSubcommand((sc) => sc.setName("clear").setDescription("내 바쁜 시간 싹 비운다(본인만).")),

  // /go (시작시간만)
  new SlashCommandBuilder()
    .setName("go")
    .setDescription("할매가 시작시간 하나 딱 정해서 제안한다. (수락/거절만)")
    // required 먼저
    .addStringOption((o) =>
      o.setName("start").setDescription("시작시간 (HH:MM) 예: 19:30").setRequired(true)
    )
    // optional 나중
    .addStringOption((o) =>
      o.setName("day").setDescription("오늘/내일/YYYY-MM-DD (미입력은 오늘)").setRequired(false)
    ),
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

if (!process.env.CLIENT_ID) throw new Error("CLIENT_ID가 없다 아이가. .env 확인해라.");
if (!process.env.CHANNEL_ID) throw new Error("CHANNEL_ID가 없다 아이가. .env 확인해라.");

await rest.put(
  Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.CHANNEL_ID),
  { body: commands }
);

console.log("커맨드 등록 끝났다 아이가: /lunch /nonsense /answer /weather /busy /go");
