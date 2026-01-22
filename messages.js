// messages.js
export const MESSAGES = {
  // /go 관련
  go: {
    buttonAccept: "간다",
    buttonDecline: "못 간다",
    proposalTitle: "모일라카면 똑바로 모이라",
    askResponse: "갈 수 있으면 ‘간다’ 눌러라. 안 되면 ‘못 간다’ 눌러라.",
    statusAccept: "간다",
    statusDecline: "못 간다",
    statusPending: "아직이다",
    allAccepted: "다 된다카네. 그 시간 맞춰서 그냥 모이라.",
    anyDeclined: "못 간다카는 사람 있다. 시간 다시 잡아라.",
    waitingResponse: "아직 답 안 한 사람 있다 아이가! 얼른 눌러라.",
    invalidDay:
      "날짜를 그라믄 누가 알아묵노. ‘오늘’, ‘내일’ 아니면 YYYY-MM-DD로 적어라.",
    invalidStart:
      "시간은 HH:MM으로 해라. 24시는 없다. 예) 19:30 이래 쓰라.",
    notRegisteredMember:
      "니는 여 등록 안 됐다 아이가. 끼지 마라.",
    proposalNotFound:
      "그런 약속 없다 아이가. 새로 잡아라.",
  },

  // /lunch 관련
  lunch: {
    noMenu:
      "먹을 거 하나도 없다 아이가. 메뉴부터 좀 넣어라.",
    menuSuffix: "이거 묵어라:",
    menuEnd:
      "고민 그만 하고 그냥 묵어라. 배고프다.",
  },

  // /nonsense 관련
  nonsense: {
    quizTitle: "할매가 문제 하나 낸다 아이가",
    answerInstruction:
      "정답은 /answer로 넣어라. 엉뚱한 소리 하지 말고 똑바로 써라.",
    correct:
      "맞다 맞다. 니 머리 아직 살아있네.",
    emptyDb:
      "문제 하나도 없다 아이가. DB부터 채워라.",
    questionPosted:
      "문제 냈다. 머리 좀 굴려봐라.",
    questionError:
      "문제 내다가 꼬였데이. 콘솔 보고 와라.",
    noQuestion:
      "지금 문제 없다. 먼저 /nonsense부터 쳐라.",
    wrong: (tries) =>
      `아이다 아이다. (${tries}/2) 다시 생각해봐라.`,
    revealAnswer: (question, answer) =>
      `두 번 다 틀렸다 아이가. 답 알려준다.\n- 문제: ${question}\n- 정답: ${answer}`,
  },

  // /weather 관련
  weather: {
    question:
      "날씨 궁금해서 왔나?",
    error:
      "날씨가 오늘따라 말 안 듣는다. 도시 이름 다시 넣어보던가, 좀 있다 해라.",
    morningPrefix:
      "오늘 아침 날씨다 아이가",
    coldWarning:
      "체감이 영하로 떨어진다. 옷 얇게 입고 나가면 얼어 죽는다.",
    chillyWarning:
      "쌀쌀하다. 겉옷 하나 챙겨라.",
    hotWarning:
      "덥다. 물 안 챙기면 퍼질라.",
    humidWarning:
      "습하다. 머리 부시시한 건 니 팔자다.",
    windyWarning:
      "바람 세다. 모자 쓰면 날아간다, 조심해라.",
    normalWarning:
      "별일 없다. 그래도 길 조심해서 다녀라.",
  },

  // 근무 관련
  work: {
    start: (name, time) =>
      `${name} 일 들어갔다. (${time})`,
    end: (name, time) =>
      `${name} 일 끝났다. (${time})`,
    scheduleTitle:
      "오늘 일하는 사람들이다 아이가",
    scheduleItem: (name, start, end) =>
      `- ${name}: ${start}부터 ${end}까지`,
    weatherPrefix: (name) =>
      `${name}야, 일 시작하기 전에 날씨 한 번 봐라`,
  },

  // 콘솔 로그
  console: {
    login: (tag) =>
      `로그인 됐다 아이가: ${tag}`,
    channelIdNotSet:
      "CHANNEL_ID 없다 아이가. 자동 알림은 안 돌린다.",
    guildIdNotSet:
      "CHANNEL_ID 없다 아이가. 근무 기능은 건너뛴다.",
    workRoleSyncComplete:
      "근무 역할 다 맞춰놨다 아이가.",
    workRoleSyncError:
      "근무 역할 맞추다 에러 났데이:",
    workRoleToggleError:
      "근무 역할 바꾸다 에러 났데이:",
    scheduleSummaryError:
      "오늘 일정 정리하다가 문제 생겼데이:",
    weatherError:
      "날씨 알림 보내다 에러 났데이:",
    nonsenseDbEmpty:
      "넌센스 문제 하나도 없다 아이가. DB 확인해라.",
    nonsenseAutoError:
      "넌센스 자동으로 내다 에러 났데이:",
    commandRegisterComplete:
      "커맨드 등록 끝났다 아이가: /lunch /nonsense /answer /weather /go",
    clientIdError: "CLIENT_ID 없다 아이가. .env 확인해라.",
    channelIdError: "CHANNEL_ID 없다 아이가. .env 확인해라.",
  },

  // 커맨드 등록 관련
  commands: {
    lunch: {
      name: "lunch",
      description: "할매가 점심/저녁/간식 하나 딱 찍어준다 아이가.",
      typeDescription: "뭐 묵을끼고? (기본: 점심)",
      typeLunch: "점심",
      typeDinner: "저녁",
      typeSnack: "간식",
    },
    nonsense: {
      name: "nonsense",
      description: "할매가 넌센스 문제 하나 낸다 아이가.",
    },
    answer: {
      name: "answer",
      description: "넌센스 정답 적는 거다 아이가.",
      textDescription: "정답",
    },
    weather: {
      name: "weather",
      description: "할매가 지금 날씨 알려준다 아이가.",
      cityDescription: "도시명 (예: Seoul, Busan). 안 넣으면 기본 도시로 한다 아이가.",
    },
    go: {
      name: "go",
      description: "할매가 시간 하나 딱 잡아 제안한다. (수락/거절만 해라)",
      startDescription: "시작시간 (HH:MM) 예: 19:30",
      dayDescription: "오늘/내일/YYYY-MM-DD (안 적으면 오늘로 한다)",
    },
  },

  // 날짜/시간 관련
  date: {
    today: "오늘",
    tomorrow: "내일",
    dateLabel: "날짜",
    startLabel: "시작",
  },

  // 식사 타입
  meal: {
    lunch: "점심",
    dinner: "저녁",
    snack: "간식",
  },

  // 날씨 상세 + 잔소리 자동 분기
  weatherDetail: {
    weatherInfo: "밖에 날씨 이렇다 아이가",

    weatherFormat: (name, desc, temp, feels, hum, wind) => {
      const lines = [];
      lines.push(`${name} 지금 밖에 이렇다.`);
      lines.push(`${desc}고, ${temp}도다 (체감 ${feels}도).`);
      lines.push(`습도 ${hum}%에 바람 ${wind}m/s다.`);

      // ===== 잔소리 분기 =====
      if (feels <= 0) {
        lines.push("이건 날씨가 아니다. 나가면 뼛속까지 시리다.");
        lines.push("내복 입고 목도리 해라. 멋 부릴 날 아니다.");
      } else if (feels <= 5) {
        lines.push("춥다 아이가. 겉옷 얇게 입고 나가면 바로 감기다.");
      } else if (feels <= 10) {
        lines.push("쌀쌀하다. 바람 맞으면 골병 든다. 조심해라.");
      }

      if (temp >= 30) {
        lines.push("덥다. 물 안 들고 나가면 쓰러진다.");
        lines.push("땀 난다고 찬 거 들이키지 마라. 탈난다.");
      } else if (temp >= 26) {
        lines.push("좀 덥다. 그늘로 다니고 물 챙겨라.");
      }

      if (hum >= 80) {
        lines.push("습해서 찝찝하다. 머리 부시시한 건 오늘 운명이다.");
      }

      if (wind >= 8) {
        lines.push("바람 사납다. 모자 쓰면 날아간다.");
      } else if (wind >= 5) {
        lines.push("바람 좀 분다. 괜히 얇게 입지 마라.");
      }

      // 아무 조건도 안 걸리면
      if (lines.length <= 3) {
        lines.push("날은 무난하다. 그래도 방심은 하지 마라.");
      }

      return lines.join("\n");
    },

    apiKeyError:
      "날씨 보려 했더니 열쇠가 없다 아이가. WEATHER_API_KEY부터 챙겨라.",
  },


  // 넌센스 퀴즈 관련
  nonsenseDetail: {
    problemLabel: "문제",
    correctPersonLabel: "맞춘 사람",
    answerLabel: "정답",
  },
};
