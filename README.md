# LilacAnime Desktop

[![최신 버전](https://img.shields.io/github/v/release/whispelyn-byte/LilacAnime-desktop?label=%EC%B5%9C%EC%8B%A0%20%EB%B2%84%EC%A0%84&color=b98fd6)](https://github.com/whispelyn-byte/LilacAnime-desktop/releases/latest)
![Windows 10 / 11](https://img.shields.io/badge/Windows-10%20%2F%2011-0078d4)

[LilacAnime](https://github.com/dream150/LilacAnime) Android 앱을 Windows에서 쓸 수 있게 옮긴 데스크톱 앱입니다.
여러 사이트의 애니를 한 화면에서 찾아 보고, 한국어 자막을 자동으로 찾아 입히고, 없으면 일본어·영어 자막을 한국어로 번역해 줍니다.
회차를 내려받아 오프라인에서도 자막과 함께 볼 수 있습니다.

## 설치

1. **[LilacAnime-Setup.exe 받기](https://github.com/whispelyn-byte/LilacAnime-desktop/releases/latest/download/LilacAnime-Setup.exe)**: 항상 최신 버전이 받아집니다. ([모든 릴리즈](https://github.com/whispelyn-byte/LilacAnime-desktop/releases))
2. 실행해서 설치 위치를 고르고 설치합니다. 바탕 화면에 바로가기가 생깁니다.

설치한 뒤에는 새 버전이 나오면 앱이 알려 주고, **설정 > 앱 업데이트**에서 바로 받아 설치할 수 있습니다. 업데이트하면 바뀐 점이 처음 한 번 표시됩니다.

## 처음 쓸 때

1. **설정 > 콘텐츠 / 영상 소스**에서 볼 사이트를 고릅니다. 바꾸면 앱을 다시 시작할 때 적용됩니다.
2. **설정 > 작품 제목 표시**에서 한국어 / 영어를 고릅니다.
3. (선택) **설정 > 한국어 제목 검색**에 TMDB API 키를 넣으면 한국어 제목과 한국어 자막을 더 많이 찾습니다. → [TMDB API 키](#tmdb-api-키-선택)
4. (선택) 자막 번역을 쓰려면 **설정 > 자막 자동 번역**에서 로컬 AI 모델을 받거나 Gemini API 키를 넣습니다. → [자막 번역](#자막-번역)

## 콘텐츠 소스

| 소스 | 목록·검색 | 영상 | 자막 |
|---|---|---|---|
| **RE:Anime** | 2만여 작품, 한국어 검색 | 자막 없는 영상 | 사이트의 여러 언어 자막 트랙 (한국어 트랙이 있으면 자동 적용) |
| **Miruro** | 한국어 검색, 회차 제목·방영일 | 서버 선택: SUB · RAW · SOFT · DUB | SOFT 서버의 여러 언어 자막 트랙 |
| **Animenosub** | 한국어 검색 | 서버 선택: SUB · RAW | 한국어 자막은 온라인 검색 |
| **Linkkf** | 한국어 목록 | 사이트 기본 영상 | 사이트의 한국어 자막 |

- 영어 제목인 사이트(RE:Anime·Miruro·Animenosub)도 한국어 제목으로 보여 주고 한국어로 검색할 수 있습니다. 2기 이후 시즌은 "○○ 2기"처럼 표시합니다.
- **영상 서버 (Miruro·Animenosub):** 한국어 자막이 있으면 자막 없는 영상(RAW / SOFT)에 한국어 자막을, 없으면 영어 자막이 박힌 SUB를 고릅니다. 플레이어 설정 > 영상 서버에서 직접 고를 수도 있고, 고른 서버는 다음 회차에도 유지됩니다.
  - **SUB:** 영어 자막이 영상에 박혀 있음
  - **RAW:** 자막 없음
  - **SOFT (Miruro):** 자막 없는 영상 + 자막 파일. 자막 트랙을 바꾸거나 번역할 수 있습니다.
  - **DUB:** 영어 더빙

## 자막

재생을 시작하면 이 순서로 자막을 정합니다.

1. 이 회차에 저장해 둔 자막 (직접 고른 자막, 번역한 자막)
2. 영상에 딸린 한국어 자막 (RE:Anime·Miruro의 한국어 트랙, Linkkf)
3. 온라인 한국어 자막: **Kairan → Csora → Anissia** (설정에서 고른 소스가 먼저)

영상에 딸린 자막이 한국어가 아니면, 온라인에서 한국어 자막을 찾았을 때 바꿀지 물어봅니다.

### 자막 소스

| 소스 | 설명 |
|---|---|
| Kairan | [kairan03.blogspot.com](https://kairan03.blogspot.com) |
| Csora | [csora556.blogspot.com](https://csora556.blogspot.com) |
| Anissia | [anissia.net](https://anissia.net) 자막 편성표에 등록된 제작자의 블로그 (Blogger, 티스토리, 네이버 블로그). 플레이어 설정에서 제작자를 직접 고를 수 있습니다. 글 이미지 안에 자막을 넣어 두는 블로그([WinPNG](https://github.com/harnenim/WinPNG))도 읽습니다. |
| Jimaku | [jimaku.cc](https://jimaku.cc)의 **일본어** 자막. 플레이어 설정 > 자막 소스 > Jimaku를 누르면 그 회차의 파일 목록이 나오고, 고른 파일을 적용합니다. API 키는 필요 없습니다. |
| RE:Anime · Miruro 트랙 | 사이트가 주는 여러 언어 자막. 플레이어 설정의 자막 트랙에서 고릅니다. |
| 사용자 자막 | 내 PC의 ASS / SSA / SRT / VTT / SMI 파일 |

- 2기 이후 시즌을 1기에 이어서 번호 매기는 블로그(예: 2기 3화를 "15화"로 올린 글)도 찾습니다.
- ASS 자막은 원본의 위치·색상·효과 그대로 보여 주고, 자막에 쓰인 폰트도 함께 받아 씁니다.
- 자막 크기·위치·싱크, 폰트, VTT 테두리·굵기는 플레이어 설정에서 바꿀 수 있습니다.

### 자막 번역

한국어 자막이 없을 때 다른 언어 자막을 한국어로 번역합니다. 번역한 자막은 이 회차에 저장되어 다음에 볼 때 바로 적용됩니다.

- **자막 트랙 번역:** 플레이어 설정에서 RE:Anime·Miruro 자막 트랙을 고르고 **Gemini 번역** 또는 **로컬 AI 번역**을 누릅니다.
- **Jimaku 번역:** Jimaku 파일을 고르면 일본어 자막을 먼저 띄우고, 번역이 끝나면 한국어 자막으로 바꿉니다. 이 자동 번역을 Gemini로 할지 로컬 AI로 할지(또는 끌지)는 **설정 > 자막 자동 번역 > Jimaku 자막 자동 번역**에서 고릅니다. 같은 버튼 두 개로 다시 번역할 수도 있습니다.
- **다운로드:** 회차를 내려받을 때 모든 자막 트랙을 함께 저장하고 번역해 둡니다 (설정에서 끌 수 있음).

다운로드할 때 하는 번역은 Gemini 키가 있으면 Gemini로, 없으면 로컬 AI로 합니다. Gemini에는 작품 제목과 주요 등장인물 이름(AniList)을 함께 보내 이름이 매번 같게 옮겨지도록 합니다.

#### 로컬 AI

인터넷이나 API 키 없이 이 PC에서 번역합니다. 사용 한도도 없습니다.

1. **설정 > 자막 자동 번역 > 로컬 AI 모델**에서 모델의 **받기**를 누릅니다.
2. 처음 번역할 때 번역 프로그램([llama.cpp](https://github.com/ggml-org/llama.cpp), 약 33MB)을 자동으로 받습니다.
3. 그래픽카드가 있으면 그래픽카드로, 없으면 CPU로 번역합니다. 번역할 때만 실행되고 몇 분 쓰지 않으면 꺼집니다.
4. 설정의 모델 목록에 마지막으로 어디서 돌았는지 표시됩니다 (예: `AMD Radeon RX 6600 · 33/33층`). 그래픽카드 메모리에 다 안 들어가는 모델은 일부가 CPU에서 돌아 느리니, 그럴 때는 HY-MT1.5 1.8B를 쓰세요. 7B 모델은 그래픽카드 메모리가 8GB면 대개 전부 올라갑니다 (약 5.7GB 사용).

| 모델 | 크기 | 특징 |
|---|---|---|
| HY-MT1.5 1.8B (기본) | 1.1GB | 빠름. 한 화(약 600줄)에 2~3분 |
| HY-MT1.5 7B | 4.6GB | 더 정확함, 더 느림 |
| ja-ko-vn 7B | 4.6GB | 일본어 → 한국어 특화 |

다른 GGUF 모델 파일을 **GGUF 파일 추가**로 넣어 쓸 수도 있습니다. 작은 모델은 이름·호칭을 가끔 틀리게 옮깁니다.

#### Gemini

Google Gemini API로 번역합니다. 대사 흐름과 말투를 살린 번역이 나오지만 본인의 API 키가 필요합니다.

1. [Google AI Studio](https://aistudio.google.com/apikey)에서 API 키를 만듭니다.
2. **설정 > 자막 자동 번역 > Gemini API 키**에 넣고 저장합니다. 쓸 수 있는 모델을 불러와 최신 Flash 모델을 고릅니다.

무료 키에는 하루 사용 한도가 있습니다.

## 플레이어

- 이전 / 다음 화, 다음 화 자동 재생, 화면 잠금
- 화질·재생 속도 선택, 자막이 함께 나오는 PIP
- **OP/ED 건너뛰기:** 버튼 또는 자동 건너뛰기. [AniSkip](https://aniskip.com) 타임스탬프를 쓰고, 없으면 다운로드한 다른 회차와 오디오를 비교해 찾습니다.
- **이어보기:** 마지막에 본 회차를 재생합니다 (95% 이상 봤으면 처음부터, 그 전이면 멈춘 위치부터).
- **백그라운드 재생:** 창을 내리거나 최소화해도 계속 재생되고, Windows 미디어 키·볼륨 창·잠금 화면에서 조작할 수 있습니다.
- **키보드 / 리모컨:** 방향키로 이동, Enter로 선택, Esc로 닫기·뒤로

## 다운로드

- 회차 옆 다운로드 버튼이나 **전체 저장**으로 내려받습니다. 두 회차씩 동시에 받습니다.
- 자막·폰트·자막 트랙(번역 포함)·OP/ED 구간을 함께 저장해 오프라인에서도 그대로 재생합니다.
- Miruro는 빠른 서버를 골라 최고 화질만 여러 조각씩 동시에 받습니다 (1080p 한 화가 보통 1~4분). 멈췄다가 다시 받으면 받아 둔 조각부터 이어서 받습니다.

## TMDB API 키 (선택)

RE:Anime·Animenosub·Miruro는 제목이 영어라서, 한국어 자막을 찾거나 한국어 제목을 보여 주려면 한국어 제목이 필요합니다. 앱은 한국어 제목을 **TMDB → AniList → Wikidata** 순으로 찾습니다. TMDB가 가장 많은 작품을 찾지만 API 키가 있어야 쓸 수 있고, 키가 없으면 AniList와 Wikidata로만 찾습니다.

1. [themoviedb.org](https://www.themoviedb.org)에 가입합니다.
2. 계정 설정 > API에서 개발자 키를 신청합니다 (개인·비상업 용도).
3. 발급된 **API 키(v3)** 또는 **읽기 액세스 토큰**을 **설정 > 한국어 제목 검색 > TMDB API 키**에 넣고 저장합니다.

## 저장 위치

| 내용 | 위치 |
|---|---|
| 다운로드한 회차 | `동영상\LilacAnime\작품 이름\` |
| 설정, API 키, 자막·번역, 로컬 AI 모델 | `%APPDATA%\lilacanime-desktop\` |

API 키는 이 PC에만 저장되고 다른 곳으로 보내지 않습니다 (TMDB·Gemini 요청에만 씁니다).

## 개발

[Node.js](https://nodejs.org)가 필요합니다.

```powershell
npm install
npm start
```

설치 파일 만들기:

```powershell
npm run dist
```

`dist\LilacAnime-Setup.exe`가 만들어집니다. 앱 버전은 `package.json`의 `version`을 따릅니다.

| 폴더 | 내용 |
|---|---|
| `electron/` | 메인 프로세스: 사이트 연결, 자막 검색, 다운로드, 번역, 업데이트 |
| `src/` | 화면: 목록, 상세, 플레이어, 설정 |
| `scripts/` | 빌드 보조 스크립트 |

## 크레딧

- 원작: [dream150/LilacAnime](https://github.com/dream150/LilacAnime) (Android). 원작자의 허락을 받아 Windows 데스크톱(Electron)용으로 포팅한 프로젝트입니다.
- 자막: Kairan, Csora, [Anissia](https://anissia.net)에 등록된 자막 제작자분들, [Jimaku](https://jimaku.cc)
- 로컬 번역: [llama.cpp](https://github.com/ggml-org/llama.cpp), [Tencent HY-MT1.5](https://huggingface.co/tencent/HY-MT1.5-1.8B-GGUF)
- OP/ED 타임스탬프: [AniSkip](https://aniskip.com)
- This product uses the TMDB API but is not endorsed or certified by TMDB.
