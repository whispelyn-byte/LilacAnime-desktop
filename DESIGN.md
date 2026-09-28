# LilacAnime Design System

## Direction

Android LilacAnime의 Material 기반 구조를 Windows에 적응한다. 시각적으로 새 브랜드를 만드는 작업이 아니라 모바일 원본의 화면 계층과 조작 습관을 보존하는 포팅이다.

## Mode

Operate. 사용자는 작품을 찾고 회차를 재생하는 반복 작업을 빠르게 완료해야 한다.

## Navigation

- 홈, 전체, 검색, 시청기록, 내 목록, 설정의 6개 목적지를 하단 탐색에 고정한다.
- 상세와 플레이어는 탐색 목적지가 아니라 선택 후 진입하는 화면이다.
- 데스크톱에서는 콘텐츠 폭을 제한하되 하단 탐색의 순서와 용어는 Android 원본을 유지한다.

## Color

- Primary: `#C8A2C8`
- Primary dark: `#9A7B9A`
- Dark background: `#121212`
- Dark surface: `#1E1E1E`
- Light background: `#FFFFFF`
- Light surface: `#F5F5F5`
- 장식용 그라데이션은 사용하지 않는다. 강조색은 선택, 주요 동작, 포커스에만 사용한다.

## Typography

Windows 환경의 읽기 안정성을 위해 `Segoe UI Variable`, `Pretendard`, sans-serif를 사용한다. 제목은 굵기와 크기로만 계층을 만들며 영문 eyebrow는 사용하지 않는다.

## Components

- 포스터 카드는 이미지, 제목, 최소 메타데이터만 가진다.
- 설정은 Android처럼 섹션 제목, 설명, 칩·스위치·슬라이더를 수직으로 배치한다.
- 상세 화면은 별도 전체 화면 또는 넓은 시트로 열며, 회차 선택이 첫 작업이다.
- 로딩은 스켈레톤, 실패는 원인과 다시 시도 동작, 빈 상태는 다음 행동을 제공한다.

## Motion

`src/motion.css`에 모은다. 상태 변화(색, 선택, 누름)는 140ms, 등장·전환은 200–280ms ease-out을 사용한다. 상세 창은 떠오르며 열리고 닫히며, 카드 목록은 처음 나타날 때 짧은 시차(30ms 간격, 최대 180ms)로 올라온다. 반복되거나 계속 움직이는 장식 애니메이션은 사용하지 않는다. `prefers-reduced-motion`을 존중한다.

## Desktop Adaptation

콘텐츠는 넓은 화면에서 더 많은 열을 사용하지만 정보 구조는 바꾸지 않는다. 하단 탐색은 유지하고, 마우스 hover와 키보드 단축키를 추가적인 편의로만 사용한다.
