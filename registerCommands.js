// registerCommands.js
import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

const commands = [
  // /lunch
  new SlashCommandBuilder()
    .setName("lunch")
    .setDescription("할매가 점심 하나 골라준다."),

  // /weather
  new SlashCommandBuilder()
    .setName("weather")
    .setDescription("할매가 지금 날씨 알려준다.")
    .addStringOption((o) =>
      o.setName("city").setDescription("도시명 (예: Seoul, Busan) 안 넣으면 기본 도시")
    ),

  // /busy (본인만 add/remove/clear, list는 전체/특정유저 조회 가능)
  new SlashCommandBuilder()
    .setName("busy")
    .setDescription("안 되는 시간(바쁜 시간)을 관리한다.")
    .addSubcommand((sc) =>
      sc
        .setName("add")
        .setDescription("안 되는 시간을 추가한다(본인만).")
        .addStringOption((o) =>
          o.setName("date").setDescription("날짜 (YYYY-MM-DD)").setRequired(true)
        )
        .addStringOption((o) =>
          o.setName("start").setDescription("시작 (HH:MM)").setRequired(true)
        )
        .addStringOption((o) =>
          o.setName("end").setDescription("끝 (HH:MM)").setRequired(true)
        )
        .addStringOption((o) => o.setName("reason").setDescription("사유(선택)"))
    )
    .addSubcommand((sc) =>
      sc
        .setName("list")
        .setDescription("안 되는 시간을 본다(전체 또는 특정 유저).")
        .addStringOption((o) =>
          o
            .setName("user")
            .setDescription("유저 키(youngjin/minsu/youjung/myeongjae). 안 넣으면 본인")
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("remove")
        .setDescription("안 되는 시간을 삭제한다(본인만).")
        .addStringOption((o) =>
          o.setName("id").setDescription("busy id (예: a1b2c3d4)").setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc.setName("clear").setDescription("내 안 되는 시간을 전부 비운다(본인만).")
    ),

  // /go (단순화: day 하나만)
  new SlashCommandBuilder()
    .setName("go")
    .setDescription("할매가 그날 가능한 시간 하나 딱 잡아서 제안한다.")
    .addStringOption((o) =>
      o
        .setName("day")
        .setDescription("오늘/내일/YYYY-MM-DD (미입력 시 오늘)")
        .setRequired(false)
    ),
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

if (!process.env.CLIENT_ID) throw new Error("CLIENT_ID가 없다. .env 확인해라.");
if (!process.env.GUILD_ID) throw new Error("GUILD_ID가 없다. .env 확인해라.");

await rest.put(
  Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
  { body: commands }
);

console.log("커맨드 등록 완료: /lunch /weather /busy /go");
