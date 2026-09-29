# LilacAnime Desktop

[LilacAnime](https://github.com/dream150/LilacAnime) Android 앱을 Windows 데스크톱용으로 옮긴 Electron 앱입니다. 작품 탐색, 회차 선택, 자막, 재생, 다운로드, 이어보기를 Android 버전과 같은 구조로 제공합니다.

## 설치

[Releases](https://github.com/whispelyn-byte/LilacAnime-desktop/releases)에서 `LilacAnime-Setup-x.y.z.exe`를 받아 설치합니다. 설치한 뒤에는 새 버전이 나오면 앱에서 알려 주고, 설정 > 앱 업데이트에서 바로 받을 수 있습니다.

## 주요 기능

- **콘텐츠 소스:** Linkkf, Animenosub, Re:Anime (설정 > 콘텐츠 / 영상 소스)
- **플레이어:** 이전/다음 화, 다음 화 자동재생, OP/ED 스킵 버튼과 자동 스킵, 화면 잠금, 화질·재생 속도 선택, 미니 플레이어
- **플레이어 설정 메뉴** (재생 화면 오른쪽 위 톱니바퀴): 자막 소스, Re:Anime 자막 트랙, 자막 크기·위치·싱크, VTT 스타일, 커스텀 폰트, 사용자 자막, 이 회차의 저장 자막
- **자막:** Linkkf VTT, Re:Anime 트랙, Kairan/Csora ASS, 사용자 자막 (ASS / SSA / SRT / VTT / SMI)
- **다운로드:** 동시 2개, 자막·폰트와 OP/ED 구간을 함께 저장해 오프라인에서도 그대로 재생
- **OP/ED:** 온라인은 AniSkip 타임스탬프, 다운로드한 회차는 저장된 타임스탬프 → 없으면 다른 다운로드 회차와 오디오 비교
- **백그라운드 재생:** 창을 내리거나 최소화해도 계속 재생되고, Windows 미디어 키·볼륨 창·잠금 화면으로 조작
- **키보드 / 리모컨:** 방향키로 이동, Enter로 선택, Esc로 닫기·뒤로
- 시청 기록, 이어보기, 내 목록, 라이트 / 다크 / 시스템 테마

## TMDB API 키 (선택)

Re:Anime 작품은 제목이 영어라서, Kairan/Csora 자막을 찾으려면 한국어 제목이 필요합니다. 앱은 한국어 제목을 **TMDB → AniList → Wikidata** 순으로 찾습니다. TMDB가 가장 많은 작품을 찾지만 API 키가 있어야 사용할 수 있고, 키가 없으면 AniList와 Wikidata로만 찾습니다.

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
- This product uses the TMDB API but is not endorsed or certified by TMDB.
