// registerCommands.js
import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

// 유의:
// - GUILD_ID: 커맨드를 "길드 전용"으로 등록 (즉시 반영)
// - 전역 등록은 Routes.applicationCommands(CLIENT_ID) 사용 (전파 지연 있음)

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
    // add (user 옵션 제거: 무조건 본인)
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
        .addStringOption((o) =>
          o.setName("reason").setDescription("사유(선택)")
        )
    )
    // list (전체 or 특정 유저)
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
    // remove (id로 삭제, 본인만)
    .addSubcommand((sc) =>
      sc
        .setName("remove")
        .setDescription("안 되는 시간을 삭제한다(본인만).")
        .addStringOption((o) =>
          o.setName("id").setDescription("busy id (예: a1b2c3d4)").setRequired(true)
        )
    )
    // clear (본인꺼 전체 삭제)
    .addSubcommand((sc) =>
      sc
        .setName("clear")
        .setDescription("내 안 되는 시간을 전부 비운다(본인만).")
    ),

  // /go (time 미입력 시 추천 모드)
  new SlashCommandBuilder()
    .setName("go")
    .setDescription("시간 제안하거나(시간 입력), 가능한 시간 추천받는다(시간 미입력).")
    .addStringOption((o) =>
      o.setName("date").setDescription("날짜 (YYYY-MM-DD)").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("time").setDescription("시작 (HH:MM) - 안 넣으면 추천해준다")
    )
    .addIntegerOption((o) =>
      o.setName("duration").setDescription("몇 분 할지(기본 120분)")
    )
    // 추천 옵션들(선택)
    .addStringOption((o) =>
      o.setName("from").setDescription("추천 탐색 시작(기본 18:00)")
    )
    .addStringOption((o) =>
      o.setName("to").setDescription("추천 탐색 끝(기본 24:00)")
    )
    .addIntegerOption((o) =>
      o.setName("step").setDescription("추천 간격(분, 기본 30)")
    )
    .addIntegerOption((o) =>
      o.setName("count").setDescription("추천 개수(기본 5)")
    ),
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

if (!process.env.CLIENT_ID) {
  throw new Error("CLIENT_ID가 없다. .env 확인해라.");
}
if (!process.env.GUILD_ID) {
  throw new Error("GUILD_ID가 없다. .env 확인해라.");
}

await rest.put(
  Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
  { body: commands }
);

console.log("커맨드 등록 완료: /lunch /weather /busy /go");
