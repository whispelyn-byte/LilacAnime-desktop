## 재생

- 일부 Re:Anime 회차(예: 그랑블루 9화 2:36 부근)에서 같은 몇 초가 계속 되풀이되던 문제를 고쳤습니다. v0.5.56에서는 같은 자리에서 아예 재생되지 않고 `fragParsingError · Found no media` 오류가 나던 문제입니다.
  - 원인: 영상 조각 끝의 두 프레임 시간이 거의 같아, 다음 조각이 통째로 버려지고 키프레임 없는 조각만 따로 다시 받게 되던 문제였습니다. 이제 이런 프레임의 시간을 바로잡아 넘겨줍니다.
- 키프레임이 없는 구간으로 이어보기 · 이동했을 때, 그 앞 구간부터 차례로 다시 받아 재생을 이어갑니다.

## 검증

- 자동 테스트 282개 통과.
- 그랑블루 9화를 1.25배속으로 2:20 · 2:37 · 2:41에서 시작해 문제 구간을 오류 없이 지나가는 것을 확인.

## 다운로드

- Windows: `LilacAnime-Setup.exe`
- Mac Apple Silicon: `LilacAnime-mac-arm64.dmg`
- Mac Intel: `LilacAnime-mac-x64.dmg`
- Linux x64: `LilacAnime-linux-amd64.deb`
- Linux arm64: `LilacAnime-linux-arm64.deb`
