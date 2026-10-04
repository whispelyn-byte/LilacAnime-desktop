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
4. (선택) 자막 번역을 쓰려면 **설정 > 자막 자동 번역**에서 번역 API(Gemini · OpenAI · DeepL · Qwen) 키를 넣거나 로컬 AI 모델을 받습니다. → [자막 번역](#자막-번역)

## 콘텐츠 소스

| 소스 | 목록·검색 | 영상 | 자막 |
|---|---|---|---|
| **RE:Anime** | 2만여 작품, 한국어 검색 | 자막 없는 영상 | 사이트의 여러 언어 자막 트랙 (한국어 트랙이 있으면 자동 적용) |
| **Miruro** | 한국어 검색, 회차 제목·방영일 | 서버 선택: SUB · RAW · SOFT · DUB | SOFT 서버의 여러 언어 자막 트랙 |
| **Animenosub** | 한국어 검색 | 서버 선택: SUB · RAW | 한국어 자막은 온라인 검색 |
| **애니24** | 한국어 목록·검색, 원제·장르·방영일 | 1080p, 한국어 자막이 영상에 들어 있음 | 영상에 박힌 한국어 자막 (다른 자막을 찾거나 번역하지 않음) |
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
3. 온라인 한국어 자막: **Kairan · Csora · Anissia** (세 곳을 동시에 찾고, 설정에서 고른 소스가 먼저)
4. 한국어 자막이 없으면 **번역할 자막을 띄우고 한국어로 번역**합니다. 번역이 끝날 때까지는 원문 자막이 나옵니다.
   번역할 자막은 **Jimaku 일본어 자막 → 사이트의 일본어 트랙 → 사이트의 영어 트랙** 순으로 고릅니다 (영어 트랙이 여럿이면 대사 트랙).

한국어 자막이 있어도 같은 순서로 **번역본을 하나 더 만들어** 이 회차에 저장해 둡니다. 블로그 자막이 다른 회차·시즌 것으로 잘못 맞춰졌을 때 플레이어 설정 > 자막 > **AI 번역**을 누르면 바로 바뀝니다. 회차를 다시 열면 한국어 자막이 먼저 나옵니다.

한국어 자막이 있는데 번역 버튼이나 AI 번역을 누르면(Jimaku 파일을 직접 골라도), 그 작품은 다음 화부터 **AI 번역 자막을 먼저** 띄웁니다. 한국어 자막을 다시 고르면 원래대로 돌아갑니다.

플레이어 설정 > 자막에서는 자막을 가져올 곳(Re:Anime·Miruro, Kairan, Csora, Anissia, Jimaku, AI 번역)을 고르고, 고른 곳의 목록(자막 트랙, Jimaku 파일, Anissia 제작자)이 그 아래에 펼쳐집니다. 영어·일본어 자막이 떠 있으면 위쪽에 번역 버튼이 나옵니다.

번역은 **설정 > 자막 자동 번역**이 번역 API나 로컬 AI로 되어 있고, 둘 중 하나가 준비돼 있을 때 합니다. 끄면 플레이어의 번역 버튼을 눌렀을 때만 번역합니다.

### 자막 소스

| 소스 | 설명 |
|---|---|
| Kairan | [kairan03.blogspot.com](https://kairan03.blogspot.com) |
| Csora | [csora556.blogspot.com](https://csora556.blogspot.com) |
| Anissia | [anissia.net](https://anissia.net) 자막 편성표에 등록된 제작자의 블로그 (Blogger, 티스토리, 네이버 블로그). 플레이어 설정에서 제작자를 직접 고를 수 있습니다. 글 이미지 안에 자막을 넣어 두는 블로그([WinPNG](https://github.com/harnenim/WinPNG))도 읽습니다. |
| Jimaku | [jimaku.cc](https://jimaku.cc)의 **일본어** 자막. 플레이어 설정 > 자막에 그 회차의 파일 목록이 늘 나오고, 고른 파일을 적용합니다. API 키는 필요 없습니다. |
| RE:Anime · Miruro 트랙 | 사이트가 주는 여러 언어 자막. 플레이어 설정의 자막 트랙에서 고릅니다. |
| 내 파일 | 내 PC의 ASS / SSA / SRT / VTT / SMI 파일 |

- 2기 이후 시즌을 1기에 이어서 번호 매기는 블로그(예: 2기 3화를 "15화"로 올린 글)도 찾습니다.
- ASS 자막은 원본의 위치·색상·효과 그대로 보여 주고, 자막에 쓰인 폰트도 함께 받아 씁니다.
- SRT·VTT 자막에 남은 `{\an8}` 같은 표시는 지우고, 그런 줄(효과음 · 화면 글자 설명)은 화면 위쪽에 보여 줍니다.
- 자막 크기·높이·타이밍, 글꼴, 일반 자막(SRT·VTT)의 테두리·굵기는 플레이어 설정 > 자막 모양에서 바꿀 수 있습니다.

### 자막 번역

번역한 자막은 이 회차에 저장되어 다음에 볼 때 바로 적용됩니다.

- **자동 번역:** 위 [자막](#자막) 순서대로 알아서 번역합니다.
- **직접 번역:** 플레이어 설정 > 자막에서 RE:Anime·Miruro 트랙이나 Jimaku 파일을 고르면 **(번역 API)로 한국어 번역** · **내 PC(로컬 AI)로 번역** 버튼이 나옵니다.
- **취소 · 이어서 번역:** 번역 중인 버튼을 다시 누르면 멈춥니다. 다른 회차로 넘어가도 멈춥니다. 번역한 줄은 남아 있어서, 다시 번역하면 멈춘 곳부터 이어서 합니다 (앱을 껐다 켜도).
- **번역해 둔 자막:** 같은 자막을 번역해 둔 게 있으면 다시 번역하지 않고 그대로 씁니다. 번역 API와 로컬 AI는 따로 셉니다: 번역 API로 번역해 뒀어도 로컬 AI 버튼을 누르면 로컬 AI로 번역하고, 둘 다 저장해 둡니다.
- **다음 화 미리 번역:** 로컬 AI로 한 화를 번역하면, 보는 동안 다음 화도 미리 번역해 둡니다 (Jimaku, 없으면 사이트의 일본어·영어 트랙). 다음 화를 열면 바로 한국어 자막이 나옵니다.
- **이어받기:** 고른 번역 API를 쓸 수 없으면(키 없음, 사용량 초과) 키가 있는 다른 API가, 그다음 로컬 AI가 이어서 번역하고 무엇으로 번역했는지 알려 줍니다.

번역 API(DeepL 제외)에는 작품 제목·줄거리와 주요 등장인물 이름(AniList)을 함께 보내 이름이 매번 같게, 말투는 관계에 맞게 옮겨지도록 합니다.

#### 번역 API

**설정 > 자막 자동 번역 > 번역 API**에서 하나를 고르고 키를 넣습니다. 키를 저장할 때 맞는 키인지 확인하고, 쓸 수 있는 모델을 불러옵니다.

| API | 키 받는 곳 | 특징 |
|---|---|---|
| **Gemini** | [Google AI Studio](https://aistudio.google.com/apikey) | 무료 사용량이 있음 (하루 한도). 최신 Flash 모델을 고름 |
| **OpenAI** | [OpenAI API keys](https://platform.openai.com/api-keys) | 쓴 만큼 요금. 최신 mini 모델을 고름 |
| **DeepL** | [DeepL API](https://www.deepl.com/pro-api) | 번역기라 줄마다 그대로 번역. 무료 키(끝이 `:fx`)도 됨 |
| **Qwen** | Alibaba Cloud Model Studio | 쓴 만큼 요금. 키를 만든 지역(국제 · 중국)을 함께 고름. qwen-plus를 고름 |

#### 로컬 AI

인터넷이나 API 키 없이 이 PC에서 번역합니다. 사용 한도도 없습니다.

1. **설정 > 자막 자동 번역 > 로컬 AI 모델**에서 모델의 **받기**를 누릅니다. 받다가 끊기면 **이어 받기**로 이어서 받고, 받는 중에 누르면 멈춥니다.
2. 처음 번역할 때 번역 프로그램([llama.cpp](https://github.com/ggml-org/llama.cpp))을 자동으로 받습니다. 그래픽카드에 맞는 판을 먼저 쓰고, 실행되지 않거나 그래픽카드를 못 잡으면 다음 판으로 넘어갑니다 (한 번 안 된 판은 그래픽 드라이버가 바뀔 때까지 다시 쓰지 않음). 한 달에 한 번 새 버전을 확인합니다.

   | 그래픽카드 | 쓰는 순서 |
   |---|---|
   | NVIDIA | CUDA (약 600MB, Vulkan보다 약 1.5배 빠름) → Vulkan |
   | AMD 라데온 | ROCm (약 260MB: RX 5000 · 6000 · 7000 · 9000 시리즈, 라이젠 내장 680M · 780M · 890M 등) → Vulkan. 그보다 오래된 RX 400 · 500 · Vega는 바로 Vulkan |
   | 인텔 Arc | SYCL (약 150MB) → OpenVINO (약 90MB) → Vulkan |
   | 그 밖 | Vulkan (약 33MB) |

   ROCm · SYCL · OpenVINO판은 AMD · 인텔 그래픽카드에서 직접 돌려 보지 못했습니다 (안 되면 Vulkan판으로 넘어가는 것까지만 확인).
3. 그래픽카드가 있으면 그래픽카드로, 없으면 CPU로 번역합니다. 번역할 때만 실행되고 30초 동안 쓰지 않으면 꺼집니다.
4. 설정의 모델 목록에 마지막으로 어디서 돌았는지 표시됩니다 (예: `NVIDIA GeForce GTX 1050 Ti · CUDA · 33/33층`). 그래픽카드 메모리에 다 안 들어가는 모델은 일부가 CPU에서 돌아 느립니다.

| 모델 | 크기 | 특징 | 한 화 번역 시간 (GTX 1050 Ti) |
|---|---|---|---|
| Hy-MT2 30B-A3B | 18GB | 가장 정확함. 그래픽카드가 작아도 램으로 돌아감 (램 24GB 이상) | Vulkan 10분, CUDA 약 6분(예상) |
| Hy-MT2 7B | 4.6GB | 정확함. 그래픽카드 메모리 6GB 이상이면 빠름 | 재 보지 않음 |
| ja-ko-vn 7B | 4.6GB | 일본어 → 한국어 특화 | Vulkan 16분 |
| Hy-MT2 1.8B (기본) | 1.1GB | 빠름 | CUDA 2분 20초 |

한 화는 Horimiya 1화(약 430줄), 램 32GB · Ryzen 5 5600 PC 기준입니다. 다른 GGUF 모델 파일을 **GGUF 파일 추가**로 넣어 쓸 수도 있습니다. 작은 모델은 이름·호칭을 가끔 틀리게 옮깁니다.

## 플레이어

- 이전 / 다음 화, 다음 화 자동 재생, 화면 잠금
- 화질·재생 속도 선택, 자막이 함께 나오는 PIP
- **OP/ED 건너뛰기:** 버튼 또는 자동 건너뛰기. [AniSkip](https://aniskip.com) 타임스탬프를 쓰고, 없으면 다운로드한 다른 회차와 오디오를 비교해 찾습니다.
- **이어보기:** 마지막에 본 회차를 재생합니다 (95% 이상 봤으면 처음부터, 그 전이면 멈춘 위치부터).
- **백그라운드 재생:** 창을 내리거나 최소화해도 계속 재생되고, Windows 미디어 키·볼륨 창·잠금 화면에서 조작할 수 있습니다.
- **키보드 / 리모컨:** 방향키로 이동, Enter로 선택, Esc로 닫기·뒤로

## 다운로드

- 회차 옆 다운로드 버튼이나 **전체 저장**으로 내려받습니다. 두 회차씩 동시에 받습니다.
- 자막·폰트·자막 트랙·OP/ED 구간을 함께 저장해 오프라인에서도 그대로 재생합니다.
- 한국어 번역본도 하나 만들어 둡니다: Jimaku 자막(자막 자동 번역이 켜져 있을 때), 없으면 일본어 트랙, 그것도 없으면 영어 트랙. 한국어 자막이 있어도 만들어 둡니다 (설정 > 다운로드할 때 자막 트랙 번역).
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

API 키는 이 PC에만 저장되고 다른 곳으로 보내지 않습니다 (각 키는 그 서비스 요청에만 씁니다).

받아 둔 자막과 번역 중 저장된 자막 목록에 없는 파일은 **설정 > 자막 자동 번역 > 자막 캐시**에서 지울 수 있고, 30일 넘게 쓰지 않은 파일은 앱이 알아서 지웁니다.

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
- 로컬 번역: [llama.cpp](https://github.com/ggml-org/llama.cpp), [Tencent Hy-MT2](https://github.com/Tencent-Hunyuan/Hy-MT2), [ja-ko-vn](https://huggingface.co/hell0ks/ja-ko-vn-7b-v1-gguf)
- OP/ED 타임스탬프: [AniSkip](https://aniskip.com)
- This product uses the TMDB API but is not endorsed or certified by TMDB.
