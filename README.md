# 인터파크 KBO 예매 보조 스크립트

인터파크 두산 베어스 KBO 티켓 예매를 돕는 Tampermonkey 유저스크립트 2종.

| 스크립트 | 동작 페이지 | 역할 |
|---|---|---|
| `interpark-autoclick.user.js` | `ticket.interpark.com/Contents/Sports/GoodsInfo` | 오픈 시각 자동 감지 후 예매 버튼 고속 클릭 |
| `seat-helper.user.js` | `poticket.interpark.com` (예매 팝업) | 등급 필터 · 좌석 시각화 · 연속석 자동 · CAPTCHA 보조 |

## 사전 준비

### 1. Tampermonkey 설치
브라우저별 공식 확장:
- **Chrome / Edge**: [Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey)
- **Firefox**: [addons.mozilla.org](https://addons.mozilla.org/)
- **Safari**: Mac App Store

설치 후 🐵 아이콘이 툴바에 나타납니다.

### 2. 개발자 모드 활성화 (Chrome/Edge 한정)
최신 Chrome 정책상 유저스크립트 실행 전에 필요함:
1. 주소창에 `chrome://extensions` 입력
2. 우측 상단 **"개발자 모드"** 토글 ON

## 설치

두 링크를 브라우저 주소창에 차례로 붙여넣으세요. Tampermonkey 가 자동으로 설치 확인 창을 띄워줍니다.

```
https://raw.githubusercontent.com/wodn5515/nol-kbo-helper/master/interpark-autoclick.user.js
https://raw.githubusercontent.com/wodn5515/nol-kbo-helper/master/seat-helper.user.js
```

각 링크에서 **"설치"** 클릭 → 완료.

## 사용법

### 1. `interpark-autoclick` — 예매 자동 클릭

**언제**: 아직 오픈되지 않은 경기를 예매하려 할 때 (판매예정 상태)

**절차**
1. 인터파크 KBO 구단 페이지 접속
   ```
   https://ticket.interpark.com/Contents/Sports/GoodsInfo?SportsCode=07001&TeamCode=PB004
   ```
2. 로그인
3. 우측 상단에 자동으로 **패널이 뜸** — 여기서 경기 날짜 선택 후 [시작] 클릭
4. 오픈 시각 자동 감지 (해당 경기 블럭의 "MM월 DD일 HH시 오픈" 문구 파싱)
5. 큰 카운트다운 타이머 표시 — 오픈 시각까지 대기
6. **T-2초부터 100ms 간격 폴링 → T-1초부터 50ms 간격** 으로 전환
7. 서버가 "Y"(판매중) 플립하는 순간 `SportsBooking(...)` 직접 호출 → 예매 팝업 오픈

**옵션 체크박스**
- **"다음 새로고침부터 자동 시작"**: 체크하면 탭 재방문 시 입력 없이 바로 시작. 전날 저녁 세팅하고 잠자는 시나리오.

**Tips**
- 탭을 **포그라운드 유지** (다른 탭 보면 브라우저가 setTimeout throttle → 타이밍 밀림)
- 10분마다 keep-alive ping 으로 로그인 세션 유지
- 브라우저 절전 모드 방지 권장 (맥: `caffeinate -d`)

### 2. `seat-helper` — 예매 팝업 보조

**언제**: 예매하기 → 팝업이 뜬 이후 모든 단계에서 자동 활성화

**기능별 동작**

**① 등급 리스트 필터** (등급 선택 화면)
`SEAT_GRADE_FILTER` / `SEAT_GRADE_EXCLUDE` 키워드 기반으로 원치 않는 등급 숨김.

**② 좌석맵 시각화** (좌석 선택 화면)
| 좌석 상태 | 표시 |
|---|---|
| 예매 가능 | 연두 얇은 테두리 |
| 매진/불가 | 회색 + 반투명 |
| 선호 좌석 (설정값 매칭) | 주황 펄스 애니메이션 |
| Hover (연속석 미리보기) | 청록 점선 |
| 선택됨 (본인) | 형광 노랑 + 글로우 |

**③ 연속 좌석 자동 선택**
좌석맵에서 본인이 좌석 하나 클릭하면 같은 행의 양옆 좌석이 자동으로 함께 선택됨 (`TICKET_COUNT` 매만큼). 균형(좌1/우1) 우선.

**④ 단축키**
- `Q` — 임의 빈 연속석 자동 선택 (선호도 설정 우선)
- `E` — Hover 클릭 토글 (마우스 올린 좌석 즉시 선택)
- `Enter` — "다음" 버튼 자동 클릭

**⑤ CAPTCHA 보조**
- 입력란 자동 포커싱 (숨겨진 경우 강제 visible)
- 한글 IME 상태에서 쳐도 **한↔영 자판 자동 변환** (두벌식 기준)
- Enter 제출

**⑥ 예매안내 팝업 자동 닫기**
단계마다 뜨는 modal 팝업을 `.closeBtn` 자동 클릭으로 즉시 해제.

## 설정 커스터마이징

### interpark-autoclick
날짜는 패널 UI 로 입력 (localStorage 저장). 고급 설정 필요 없음.

### seat-helper — GUI 다이얼로그로 설정

`poticket.interpark.com` 예매 팝업에 진입하면 **우측 하단에 플로팅 ⚙️ 버튼** 자동 표시됨:

1. **⚙️ 버튼 클릭** → 설정 모달 오픈
2. 원하는 값 입력
3. **"💾 저장 & 새로고침"** 클릭 → 자동으로 페이지 reload, 새 설정 적용

> 참고: 예매 팝업은 브라우저 주소창/확장 아이콘이 없는 window 라서 Tampermonkey 🐵 메뉴에 접근 불가.
> 그래서 페이지 내 ⚙️ 버튼으로 제공함. 일반 탭에서는 🐵 아이콘 메뉴에도 동일 항목 있음.

**설정 항목**
| 필드 | 설명 | 입력 예시 |
|---|---|---|
| `TICKET_COUNT` | 매수 (연속석 자동 선택 수) | `2` |
| `SEAT_GRADE_FILTER` | 등급 포함 키워드 (쉼표 구분) | `3루, 중앙` |
| `SEAT_GRADE_EXCLUDE` | 등급 제외 키워드 | `휠체어, 테이블` |
| `HIDE_SOLD_OUT` | 매진 등급 숨김 | 체크박스 |
| `blocks` | 선호 블럭 번호 | `413, 412` |
| `rows` | 선호 행 인덱스 ri | `3, 4, 5` |
| `columns` | 선호 열 인덱스 ci | `0, 2, 4, 6` |

**초기화**: 메뉴 **"↩ 설정 초기화"** 또는 다이얼로그 내 **"↩ 기본값"** 버튼

저장소: Tampermonkey GM storage (기기별 독립). 업데이트 받아도 보존됨. 스크립트를 삭제하면 초기화됨.

## 업데이트

스크립트가 업데이트되면 Tampermonkey 가 자동으로 감지하고 알림 표시.

**즉시 업데이트 확인**
1. 🐵 아이콘 → 대시보드
2. 스크립트 우클릭 → **Check for updates**
3. 새 버전 있으면 자동 설치

**자동 체크 주기 변경**
설정 → Updates 탭에서 "Check interval" 조정 (기본 매일).

## 주의사항

- **개인 사용 전용.** 인터파크 약관상 자동화 도구 사용은 제한될 수 있음. 매크로성 과도한 사용은 계정 제재 위험.
- **CAPTCHA 는 직접 풀어야 함.** 스크립트는 입력 편의(확대/포커스/자판 변환) 만 제공하며 자동 풀이 없음.
- **결제는 자동화 안 됨.** 좌석 선택 → 다음 단계부터 본인 인증/결제 수동.
- 스크립트 타이밍은 브라우저 탭 상태에 의존 (백그라운드 스로틀링 등). 중요한 예매는 탭 포그라운드 유지.

## 개발자 섹션 (선택)

로컬에서 코드 수정해 push 하려는 경우:

```bash
git clone git@github.com:wodn5515/nol-kbo-helper.git
cd nol-kbo-helper

# pre-commit hook 활성화 (각 clone 마다 1회)
git config core.hooksPath .githooks
```

**Pre-commit hook 동작**
- `*.user.js` 파일 수정 후 커밋 시 `@version` 의 patch 숫자 자동 +1
- 예: `1.1.0` → `1.1.1`
- Tampermonkey 가 버전 증가를 감지해 자동 업데이트 가능
- 우회: `git commit --no-verify`

**수동 버전 점프 (minor/major)**
```bash
# 파일 상단 @version 을 원하는 값으로 직접 수정
# 예: 1.1.5 → 1.2.0
git add -u
git commit --no-verify -m "feat: major change"  # hook 우회해서 1.2.0 유지
```

이후 커밋부터는 hook 이 patch 증가 (1.2.0 → 1.2.1 → …).

## 라이선스

개인 사용 목적. 인터파크의 권리를 침해할 의도 없음.
