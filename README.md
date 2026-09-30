# LilacAnime Desktop

[LilacAnime](https://github.com/dream150/LilacAnime) Android 앱을 Windows 데스크톱용으로 옮긴 Electron 앱입니다. 작품 탐색, 회차 선택, 자막, 재생, 다운로드, 이어보기를 Android 버전과 같은 구조로 제공합니다.

## 설치

[Releases](https://github.com/whispelyn-byte/LilacAnime-desktop/releases)에서 `LilacAnime-Setup-x.y.z.exe`를 받아 설치합니다. 설치한 뒤에는 새 버전이 나오면 앱에서 알려 주고, 설정 > 앱 업데이트에서 바로 받을 수 있습니다.

## 주요 기능

- **콘텐츠 소스:** Linkkf, Animenosub, Re:Anime (설정 > 콘텐츠 / 영상 소스)
- **작품 제목 표시:** 한국어 / 영어 선택 (설정 > 작품 제목 표시). 시청 기록·이어보기·다운로드·플레이어 제목도 같은 언어로 표시되고, 검색은 한국어와 영어 모두 됩니다.
- **플레이어:** 이전/다음 화, 다음 화 자동재생, OP/ED 스킵 버튼과 자동 스킵, 화면 잠금, 화질·재생 속도 선택, 미니 플레이어
- **플레이어 설정 메뉴** (재생 화면 오른쪽 위 톱니바퀴): 자막 소스, Re:Anime 자막 트랙, 자막 크기·위치·싱크, VTT 스타일, 발견된 ASS 폰트, 커스텀 폰트, 사용자 자막, 이 회차의 저장 자막
- **자막 소스:** Linkkf, Re:Anime 트랙, Kairan, Csora, Anissia, 사용자 자막 (ASS / SSA / SRT / VTT / SMI)
- **한국어 자막 자동 검색:** 재생을 시작하면 Kairan → Csora → Anissia 순으로 한국어 자막을 찾고, 영상에 딸린 자막이 한국어가 아니면 바꿀지 물어봅니다.
- **다운로드:** 동시 2개, 자막·폰트와 OP/ED 구간을 함께 저장해 오프라인에서도 그대로 재생
- **OP/ED:** 온라인은 AniSkip 타임스탬프, 다운로드한 회차는 저장된 타임스탬프 → 없으면 다른 다운로드 회차와 오디오 비교
- **이어보기:** 마지막에 본 회차를 재생 (95% 이상 봤으면 처음부터, 그 전이면 멈춘 위치부터)
- **백그라운드 재생:** 창을 내리거나 최소화해도 계속 재생되고, Windows 미디어 키·볼륨 창·잠금 화면으로 조작
- **키보드 / 리모컨:** 방향키로 이동, Enter로 선택, Esc로 닫기·뒤로
- 시청 기록, 내 목록, 라이트 / 다크 / 시스템 테마

## 온라인 자막 소스

| 소스 | 설명 |
|---|---|
| Kairan | [kairan03.blogspot.com](https://kairan03.blogspot.com) |
| Csora | [csora556.blogspot.com](https://csora556.blogspot.com) |
| Anissia | [anissia.net](https://anissia.net) 자막 편성표에 등록된 제작자의 블로그 (Blogger, 티스토리, 네이버 블로그). Anissia 소스를 고르면 플레이어 설정에서 제작자를 직접 고를 수 있습니다. |

2기 이후 시즌을 1기에 이어서 번호 매기는 블로그(예: 2기 3화를 "15화"로 올린 글)도 찾습니다.

## TMDB API 키 (선택)

Re:Anime 작품은 제목이 영어라서, 한국어 자막을 찾거나 한국어 제목을 보여 주려면 한국어 제목이 필요합니다. 앱은 한국어 제목을 **TMDB → AniList → Wikidata** 순으로 찾습니다. TMDB가 가장 많은 작품을 찾지만 API 키가 있어야 사용할 수 있고, 키가 없으면 AniList와 Wikidata로만 찾습니다.

1. [themoviedb.org](https://www.themoviedb.org)에 가입합니다.
2. 계정 설정 > API에서 개발자 키를 신청합니다 (개인·비상업 용도).
3. 발급된 **API 키(v3)** 또는 **읽기 액세스 토큰**을 앱의 설정 > 한국어 제목 검색 > TMDB API 키에 넣고 저장합니다.

키는 이 PC의 앱 데이터 폴더에만 저장됩니다.

## 개발

```powershell
npm install
npm start
```

설치 파일 만들기:

```powershell
npm run dist
```

`dist/LilacAnime-Setup-<버전>.exe`가 만들어집니다. 버전은 `package.json`의 `version`을 따릅니다.

## 크레딧

- 원작: [dream150/LilacAnime](https://github.com/dream150/LilacAnime) (Android). 원작자의 허락을 받아 Windows 데스크톱(Electron)용으로 포팅한 프로젝트입니다.
- 자막: Kairan, Csora 및 [Anissia](https://anissia.net)에 등록된 자막 제작자분들
- This product uses the TMDB API but is not endorsed or certified by TMDB.
