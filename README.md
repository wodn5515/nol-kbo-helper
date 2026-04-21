# 인터파크 KBO 예매 보조 스크립트

인터파크 두산 베어스 KBO 티켓 예매를 돕는 Tampermonkey 유저스크립트 2종.

| 스크립트 | 동작 페이지 | 역할 |
|---|---|---|
| `interpark-autoclick.user.js` | `ticket.interpark.com/Contents/Sports/GoodsInfo` | 오픈 시각 자동 감지 후 예매 버튼 고속 클릭 |
| `seat-helper.user.js` | `poticket.interpark.com` (예매 팝업) + 팀 페이지 | 등급 필터 · 좌석 시각화 · CAPTCHA 보조 · AUTO_FLOW · SEAT_PROFILES |

## 사전 준비

### 1. Tampermonkey 설치
- **Chrome / Edge**: [Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey)
- **Firefox**: [addons.mozilla.org](https://addons.mozilla.org/)
- **Safari**: Mac App Store

설치 후 🐵 아이콘이 툴바에 나타납니다.

### 2. 개발자 모드 활성화 (Chrome/Edge 한정)
1. 주소창에 `chrome://extensions`
2. 우측 상단 **"개발자 모드"** 토글 ON

## 설치

아래 두 URL 에 브라우저로 차례로 접속 → Tampermonkey 가 설치 확인 창을 띄움 → **"설치"**:

```
https://raw.githubusercontent.com/wodn5515/nol-kbo-helper/master/interpark-autoclick.user.js
https://raw.githubusercontent.com/wodn5515/nol-kbo-helper/master/seat-helper.user.js
```

---

## 1. `interpark-autoclick` — 예매 버튼 고속 클릭

**언제**: 오픈되지 않은 경기를 예매하려 할 때 (판매예정 상태)

### 절차
1. 인터파크 KBO 구단 페이지 접속 & 로그인
   ```
   https://ticket.interpark.com/Contents/Sports/GoodsInfo?SportsCode=07001&TeamCode=PB004
   ```
2. 우측 상단 자동 패널 → **경기 날짜 선택** → **[시작]**
3. 스크립트가 자동으로:
   - 해당 경기 블럭의 "MM월 DD일 HH시 오픈" 문구 파싱해서 오픈 시각 추출
   - 서버 시각 동기화 (Date 헤더 기준 offset)
   - 카운트다운 타이머 + keep-alive 핑 (10분 간격)
   - **T-2s 부터 0ms 간격 순차 폴링** (`POST /Contents/Sports/GoodsInfoList`)
   - 서버가 "Y"(판매중) 로 플립하는 순간 `SportsBooking(...)` 직접 호출 → 예매 팝업 오픈

### 옵션
- **"다음 새로고침부터 자동 시작"** 체크박스: 탭 재방문 시 입력 없이 자동 시작. 전날 저녁 세팅하고 자는 시나리오에 유용.

### Tips
- 탭을 **포그라운드 유지** (백그라운드 스로틀링 방지)
- 10분마다 keep-alive 로 로그인 세션 유지
- 브라우저 절전 모드 방지 권장 (맥: `caffeinate -d`)

---

## 2. `seat-helper` — 예매 팝업 보조 + AUTO_FLOW

**언제**: 예매 팝업 (`poticket.interpark.com`) 모든 단계 + 구단 페이지

### 기능

**① 등급 리스트 필터**
`SEAT_GRADE_FILTER` / `SEAT_GRADE_EXCLUDE` 키워드로 원치 않는 등급 숨김.

**② 좌석맵 시각화**
| 상태 | 표시 |
|---|---|
| 예매가능 | 연두 얇은 테두리 |
| 매진/불가 | 회색 + 반투명 |
| 선호 좌석 매칭 | 주황 펄스 애니메이션 |
| Hover (연속석 preview) | 청록 점선 |
| 선택됨 (본인) | 형광 노랑 + 글로우 |

**③ 연속 좌석 자동 선택**
좌석 하나 클릭 → 같은 행의 양옆 좌석 자동 선택 (`TICKET_COUNT` 매). 각 좌석 클릭 사이 50ms 간격 (bot 탐지 완화).

**④ 단축키**
- `Q` — 선호도 매칭 연속석 자동 선택
- `E` — Hover 클릭 토글
- `Enter` — "다음" / "좌석선택완료" / "입력완료" 버튼 자동 클릭

**⑤ CAPTCHA 보조**
- 입력란 자동 focus (숨겨진 경우 강제 visible, CAPTCHA 해제 후엔 DOM 무간섭)
- 한글 IME → 영문 자판 자동 변환 (두벌식)
- Enter = 자동 제출 (Interpark 네이티브 `onkeydown` 없을 때만)

**⑥ 예매안내 팝업 자동 닫기**
단계마다 뜨는 `#divBookNoticeLayer` modal 을 `.closeBtn` 자동 클릭으로 해제 (페이지당 1회).

**⑦ AUTO_FLOW — 완전 자동화** (옵션)
CAPTCHA 입력 후 등급 → 좌석 → 좌석선택완료까지 자동:

1. CAPTCHA 오버레이가 사라지면 (`whenCaptchaResolved` gate) 동작 시작
2. **등급 자동선택**: `SEAT_PROFILES` 우선순위로 매칭되는 첫 등급 클릭
3. **자동배정/좌석선택 분기**: 좌석선택 버튼 자동 클릭 (자동배정은 스킵)
4. **좌석 자동선택**: profile 의 blocks/rows/columns 로 `autoPick` 호출 (AND 매칭)
5. **좌석선택완료**: TICKET_COUNT 매 선택 확인 후 50ms 대기 → `fnSelect` 클릭
6. CAPTCHA / 결제 단계는 수동 진행

---

## 설정 커스터마이징

### `interpark-autoclick`
날짜만 입력 (패널 UI → localStorage). 고급 설정 없음.

### `seat-helper` — 🐵 메뉴 → "⚙️ 설정 열기"

예매 오픈 **전에 미리** 설정해두세요. 예매 팝업은 브라우저 확장 접근 불가라서 팝업 뜨기 전에 구단 페이지에서 세팅.

**설정 항목**
| 필드 | 설명 | 예시 |
|---|---|---|
| `TICKET_COUNT` | 매수 (연속석 선택 수) | `2` |
| `SEAT_GRADE_FILTER` | 등급 포함 키워드 (쉼표 구분) | `3루, 중앙` |
| `SEAT_GRADE_EXCLUDE` | 등급 제외 키워드 | `휠체어, 테이블` |
| `HIDE_SOLD_OUT` | 매진 등급 숨김 | 체크박스 |
| `AUTO_FLOW` | CAPTCHA 통과 후 등급→좌석→완료 자동화 | 체크박스 |
| `SEAT_PROFILES` | 등급별 선호 좌석 배열 (JSON) | 아래 참조 |
| `SEAT_PREFERENCE.blocks/rows/columns` | fallback (SEAT_PROFILES 비어있을 때) | `413, 412` / `3, 4` / `0, 2, 4` |

### `SEAT_PROFILES` — 우선순위 배열 + 자동 backtracking

등급별로 선호 좌석 조건을 **우선순위 배열**로 지정. 각 profile 은:
- `grade`: 등급 이름 포함 키워드 (빈 문자열 = 모든 등급 매칭)
- `blocks` / `rows` / `columns`: 좌석 AND 매칭 조건 (빈 배열 = 제약 없음)

```json
[
  {"grade": "테이블", "blocks": [101, 102], "rows": [1, 2, 3]},
  {"grade": "레드",   "blocks": [201, 202], "rows": []},
  {"grade": "네이비", "blocks": [],         "rows": [1, 2, 3]},
  {"grade": "",       "blocks": [],         "rows": [], "columns": []}
]
```

**동작**
- **등급 선택 시**: 배열 앞쪽 profile 부터 순회 → `(sgn 에 grade 키워드 포함) AND (rc > 0)` 인 첫 등급 클릭
- **좌석맵 진입 시**: 좌석 title 에서 등급명 추출 → 매칭되는 profile 의 blocks/rows/columns 를 `SEAT_PREFERENCE` 로 override → autoPick 이 그 조건으로 동작
- **좌석 매칭 실패 시** (backtrack):
  - 현재 등급을 `sessionStorage.nol_tried_grades` 에 기록
  - `fnCancel()` (이전단계) 자동 클릭 → 등급 리스트로 복귀
  - 재진입 시 tried 목록 제외하고 다음 profile 시도
  - 최대 6회 backtrack (`MAX_BACKTRACK`)
  - 성공 시 tried 초기화
- **빈 fallback profile**: 맨 끝에 `{"grade":"","blocks":[],"rows":[],"columns":[]}` 두면 다른 profile 실패 시 아무 등급/좌석이든 잡음. 안 넣으면 시도 소진 시 조용히 warn 후 중단.

**초기화**: 🐵 메뉴 → **"↩ 설정 초기화"** 또는 다이얼로그 내 **"↩ 기본값"**

**저장소**: Tampermonkey GM storage (기기별 독립). 업데이트 받아도 보존. 스크립트 삭제 시 초기화.

---

## 업데이트

Tampermonkey 가 자동으로 감지하고 알림 표시.

**즉시 확인**: 🐵 → 대시보드 → 스크립트 우클릭 → **Check for updates**

**자동 체크 주기**: 설정 → Updates 탭 (기본 매일)

---

## 주의사항

- **개인 사용 전용.** 인터파크 약관상 자동화 도구 사용 제한 가능성. 매크로성 과도한 사용은 계정 제재 위험
- **CAPTCHA 는 직접 풀어야 함** (입력 편의만 제공: 확대/포커스/자판 변환)
- **결제는 자동화 안 됨.** 좌석선택완료 이후 본인 인증/결제는 수동
- 스크립트 타이밍은 브라우저 탭 상태에 의존 (포그라운드 유지 권장)
- **AUTO_FLOW 는 조심해서 사용**: 기계적 패턴으로 보여 anti-bot 탐지 가능. 50ms 지연 + 랜덤 딜레이로 완화 중이지만 보장 없음

---

## 개발자 섹션

로컬에서 코드 수정 후 push 하려는 경우:

```bash
git clone git@github.com:wodn5515/nol-kbo-helper.git
cd nol-kbo-helper
git config core.hooksPath .githooks   # pre-commit hook 활성화 (clone 마다 1회)
```

**Pre-commit hook**
- `*.user.js` 파일 수정 후 커밋 시 `@version` patch 숫자 자동 +1
- Tampermonkey 가 버전 증가 감지해 자동 업데이트
- 우회: `git commit --no-verify`

**수동 버전 점프 (minor/major)**
```bash
# 파일 상단 @version 을 원하는 값으로 직접 수정
# 예: 1.x.y → 2.0.0
git add -u
git commit --no-verify -m "feat: major change"  # hook 우회해서 2.0.0 유지
```

---

## 라이선스

개인 사용 목적. 인터파크의 권리를 침해할 의도 없음.
