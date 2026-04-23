// ==UserScript==
// @name         인터파크 KBO 예매 보조 (좌석/등급/CAPTCHA)
// @namespace    https://github.com/wodn5515/nol-kbo-helper
// @version      2.2.0
// @description  예매 팝업 보조 — 등급 필터, 좌석 시각화, 연속석 자동, CAPTCHA 한↔영 변환
// @match        https://poticket.interpark.com/*
// @match        https://ticket.interpark.com/*
// @match        https://*.interpark.com/*TMGS*
// @match        https://*.interpark.com/*Book*
// @match        https://*.interpark.com/*Seat*
// @match        https://*.interpark.com/*Sports*
// @run-at       document-end
// @all-frames   true
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @updateURL    https://raw.githubusercontent.com/wodn5515/nol-kbo-helper/master/seat-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/wodn5515/nol-kbo-helper/master/seat-helper.user.js
// ==/UserScript==

// ============================================================
// 인터파크 KBO 예매 팝업 보조
// ▶ 기능
//   [등급 리스트]  등급 키워드 필터 (포함/제외)
//   [좌석맵]       시각화(가능/매진/선택됨 구분) + HUD +
//                 연속 좌석 자동 선택 (같은 행 양옆 균형)
//                 Q: 임의 연속석 자동 / E: hover클릭 / 클릭: 동료 자동 추가
//   [CAPTCHA]     이미지 확대 + 입력란 auto-focus + Enter 제출
//   [공통]        Enter = "다음" 버튼 클릭
// ============================================================

(() => {
  // ========================================================================
  // 설정: Tampermonkey 아이콘 → "⚙️ 설정 열기" 메뉴로 변경 가능
  // (아래 DEFAULT_SETTINGS 는 최초 설치 시 기본값. 저장소에 값 있으면 그게 우선)
  // ========================================================================
  const DEFAULT_SETTINGS = {
    TICKET_COUNT:       2,         // 매수 (연속석 자동 선택 수)
    SEAT_GRADE_FILTER:  [],        // 등급 포함 키워드 (OR, 부분일치)
    SEAT_GRADE_EXCLUDE: [],        // 등급 제외 키워드
    HIDE_SOLD_OUT:      false,     // 잔여석 0 등급 숨김
    AUTO_FLOW:          false,     // CAPTCHA 통과 후 등급→좌석→좌석선택완료 자동 진행
    SEAT_PREFERENCE: {             // (fallback) SEAT_PROFILES 비어있을 때 사용
      blocks:  [],  rows: [],  columns: [],
    },
    SEAT_PROFILES:      [],        // [{grade, blocks, rows, columns}, ...] 순서대로 시도
    // 취소표 헌팅 모드 — 좌석맵에서 선호 매칭 실패 시 backtrack 대신 reload 반복
    HUNT_MODE:              false,   // true = 좌석맵 새로고침 반복
    HUNT_RELOAD_INTERVAL_MS: 2500,   // reload 간격 (너무 짧으면 서버가 차단)
    HUNT_WEBHOOK_URL:       '',      // 좌석 잡힘 시 POST 할 URL (비워두면 비활성)
  };
  const SETTINGS_KEY = 'nol_kbo_seat_helper_settings';

  // GM_* 또는 localStorage 폴백
  const storage = {
    get: () => {
      try {
        if (typeof GM_getValue !== 'undefined') return GM_getValue(SETTINGS_KEY, null);
        const raw = localStorage.getItem(SETTINGS_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (_) { return null; }
    },
    set: (v) => {
      try {
        if (typeof GM_setValue !== 'undefined') GM_setValue(SETTINGS_KEY, v);
        else localStorage.setItem(SETTINGS_KEY, JSON.stringify(v));
      } catch (e) { console.error('[HELPER] 설정 저장 실패', e); }
    },
    del: () => {
      try {
        if (typeof GM_deleteValue !== 'undefined') GM_deleteValue(SETTINGS_KEY);
        else localStorage.removeItem(SETTINGS_KEY);
      } catch (_) {}
    },
  };

  const loadSettings = () => {
    const stored = storage.get();
    if (!stored || typeof stored !== 'object') return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      SEAT_PREFERENCE: { ...DEFAULT_SETTINGS.SEAT_PREFERENCE, ...(stored.SEAT_PREFERENCE || {}) },
      SEAT_PROFILES: Array.isArray(stored.SEAT_PROFILES) ? stored.SEAT_PROFILES : [],
    };
  };
  const S = loadSettings();
  // ========================================================================

  if (window.__seat_helper_loaded__) { console.warn('[HELPER] 이미 로드됨'); return; }
  window.__seat_helper_loaded__ = true;

  const log  = (...a) => console.log('%c[HELPER]', 'color:#0af;font-weight:bold', ...a);
  const warn = (...a) => console.warn('%c[HELPER]', 'color:#fa0;font-weight:bold', ...a);

  // ====== init 진단 로그 ======
  // 두산 케이스: 같은 URL 이어도 iframe 구조 달라서 우리 스크립트가 좌석맵 frame
  // 에 injection 안 될 수 있음. 어느 frame/URL 에 실행되는지 찍어서 @match 조정.
  (() => {
    let frameLabel = 'self';
    try {
      if (window === window.top) frameLabel = 'TOP';
      else if (window.parent === window.top) frameLabel = 'child-of-TOP';
      else frameLabel = 'nested-iframe';
    } catch (_) {}
    const initialSeats = document.querySelectorAll('img.stySeat').length;
    const initialFrames = (() => { try { return window.frames.length; } catch (_) { return '?'; } })();
    console.log(
      '%c[HELPER/init]', 'color:#0f0;font-weight:bold',
      `frame=${frameLabel} url=${location.href} · readyState=${document.readyState} · img.stySeat=${initialSeats} · child frames=${initialFrames}`
    );
  })();

  // =========================================================
  // [INTERPARK bug shim] jsonCallback JSONP race 무력화
  //
  // Captcha.js 가 $.ajax({dataType:'jsonp', jsonpCallback:'jsonCallback'}) 로
  // 동일 전역 이름 재사용. 연속 호출 시 이전 응답 cleanup 이 다음 응답 전에
  // 실행되면 "jsonCallback is not a function" TypeError 발생.
  // 두산 페이지는 divBookNoticeLayer 닫기 → fnBookNoticeShowHide → capchaInit
  // 이 이미 DOM ready 시점에 호출된 capchaInit 과 충돌해서 특히 자주 터짐.
  //
  // 실제 동작엔 무해 (이미지/입력은 정상) 지만 콘솔만 더럽힘. Accessor property
  // 로 설치해서, jQuery 가 delete window.jsonCallback 해도 getter 는 noop 반환
  // → 서버 응답이 jsonCallback(data) 호출해도 silent drop.
  // configurable:false 로 delete 를 non-op 로 만들어 shim 이 영속.
  // =========================================================
  try {
    let captured;  // jQuery 가 세팅하는 실제 handler 보관
    const noop = function () {};
    Object.defineProperty(window, 'jsonCallback', {
      configurable: false,
      enumerable: true,
      get() { return typeof captured === 'function' ? captured : noop; },
      set(v) { captured = v; }
    });
  } catch (e) {
    console.warn('[HELPER] jsonCallback shim 설치 실패:', e.message);
  }

  // =========================================================
  // [alert shim] 좌석 매진/중복 관련 alert() 자동 dismiss
  // alert() 은 UI 블록이라 "OK 버튼 누르기" 를 코드로 할 수 없음 — 함수 자체를
  // 가로채는 방법이 유일. 매진/판매종료/이미선택됨 등 AUTO_FLOW 에서 치명적이지
  // 않은 메시지만 dismiss 하고 나머지는 원본 alert 호출 (중요 메시지 보존).
  // =========================================================
  try {
    const origAlert = window.alert.bind(window);
    const DISMISS_PATTERN = /이미\s*선택|선택.*좌석|판매.*(마감|종료|완료)|매진|예매.*불가|판매된\s*좌석|선택.*불가/;
    window.alert = function (msg) {
      const m = String(msg == null ? '' : msg);
      if (DISMISS_PATTERN.test(m)) {
        console.log('%c[HELPER/alert]', 'color:#0af;font-weight:bold', `좌석관련 alert auto-dismiss: "${m}"`);
        // AUTO_FLOW 가 다시 시도할 수 있도록 seat 단계 플래그 해제
        try {
          window.__auto_seat_done__        = false;
          window.__auto_backtrack_fired__  = false;
          window.__auto_seatchoice_done__  = false;
        } catch (_) {}
        return;
      }
      return origAlert(msg);
    };
  } catch (e) {
    console.warn('[HELPER] alert shim 설치 실패:', e.message);
  }

  // =========================================================
  // CAPTCHA 게이트 — AUTO_FLOW 는 CAPTCHA 오버레이가 걷힌 뒤에만 진행
  // (인터파크 CAPTCHA 는 등급/좌석 위에 overlay 로 뜨기 때문에, 단순히
  //  div.list/img.stySeat 존재 여부만 체크하면 premature 하게 자동선택됨)
  // =========================================================
  const isVisible = (el) => {
    if (!el) return false;
    if (el.offsetParent === null) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return true;
  };
  const captchaActive = () => {
    // 1차: 오버레이 layer visibility
    const layer = document.getElementById('divRecaptcha') || document.querySelector('.capchaLayer');
    if (isVisible(layer)) return true;
    // 2차 fallback — CAPTCHA.js 초기화 타이밍이나 JSONP 실패로 layer class/visibility 가
    // 일시적으로 꼬여도 input/이미지가 살아있으면 CAPTCHA 입력 단계임
    const input = document.getElementById('txtCaptcha') ||
                  document.querySelector('input[id*="captcha" i], input[name*="captcha" i]');
    if (isVisible(input)) return true;
    const img = document.querySelector(
      'img[id*="captcha" i], img[src*="captcha" i], img[src*="Captcha"], img[src*="IPCaptcha"]'
    );
    if (isVisible(img)) return true;
    return false;
  };

  // AUTO_FLOW 소진 플래그 — 팝업 창 session 단위
  // (팝업 닫고 새 팝업 열면 sessionStorage 자연 초기화 → AUTO_FLOW 재시도 가능)
  const isAutoFlowExhausted = () => {
    try { return sessionStorage.getItem('nol_auto_flow_exhausted') === '1'; } catch (_) { return false; }
  };
  const markAutoFlowExhausted = () => {
    try { sessionStorage.setItem('nol_auto_flow_exhausted', '1'); } catch (_) {}
  };
  // AUTO_FLOW 완료 플래그 — 좌석선택완료 클릭 성공 후 이 팝업 내에서 다시는
  // 자동동작 안 함. 결제/확인 페이지에서 tryInitSeatMap 재진입해서 잘못된
  // backtrack 발동하는 것 방지.
  const isAutoFlowDone = () => {
    try { return sessionStorage.getItem('nol_auto_flow_done') === '1'; } catch (_) { return false; }
  };
  const markAutoFlowDone = () => {
    try { sessionStorage.setItem('nol_auto_flow_done', '1'); } catch (_) {}
  };
  // 편의: 어떤 이유든 AUTO_FLOW 가 다시 돌면 안 되는 상태 통합 체크
  const isAutoFlowBlocked = () => isAutoFlowExhausted() || isAutoFlowDone();
  const clearAutoFlowState = () => {
    try {
      sessionStorage.removeItem('nol_tried_grades');
      sessionStorage.removeItem('nol_auto_flow_exhausted');
      sessionStorage.removeItem('nol_auto_flow_done');
      sessionStorage.removeItem('nol_current_grade');
      sessionStorage.removeItem('nol_captcha_passed');
    } catch (_) {}
  };

  // =========================================================
  // HUNT_MODE — 취소표 헌팅 알림 헬퍼
  //  1) 소리 (AudioContext, 외부 리소스 불필요)
  //  2) 브라우저 desktop notification (requireInteraction 으로 클릭까지 고정)
  //  3) 웹훅 POST (ntfy.sh / Discord / Slack 등 — 핸드폰 푸시)
  // =========================================================
  function playHuntAlarm() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      let t = ctx.currentTime;
      // 3번 반복 beep (800Hz → 1200Hz 교차)
      for (let i = 0; i < 3; i++) {
        for (const freq of [800, 1200]) {
          const osc  = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, t);
          gain.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
          osc.connect(gain); gain.connect(ctx.destination);
          osc.start(t); osc.stop(t + 0.2);
          t += 0.22;
        }
        t += 0.1;
      }
    } catch (_) {}
  }

  function showHuntDesktopNotification(title, body) {
    if (!('Notification' in window)) return;
    try {
      if (Notification.permission === 'granted') {
        const n = new Notification(title, { body, requireInteraction: true });
        n.onclick = () => { window.focus(); n.close(); };
      } else if (Notification.permission === 'default') {
        Notification.requestPermission().then(p => {
          if (p === 'granted') {
            const n = new Notification(title, { body, requireInteraction: true });
            n.onclick = () => { window.focus(); n.close(); };
          }
        });
      }
    } catch (_) {}
  }

  async function sendHuntWebhook(url, message) {
    if (!url) return;
    // 여러 서비스 호환용 — 대부분 text/plain body 나 JSON 하나는 처리함
    // ntfy.sh: 그냥 body 만 보내면 됨. Discord/Slack: JSON 필요.
    const isDiscord = /discord\.com\/api\/webhooks/i.test(url);
    const isSlack   = /hooks\.slack\.com\//i.test(url);
    try {
      if (isDiscord) {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: message }),
        });
      } else if (isSlack) {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message }),
        });
      } else {
        // ntfy.sh / 기타 — plain text body
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain', 'Title': '좌석 잡힘!', 'Priority': 'urgent' },
          body: message,
        });
      }
      log(`[HUNT] webhook 전송 완료 → ${url.replace(/\/[^/]+$/, '/***')}`);
    } catch (e) {
      warn(`[HUNT] webhook 전송 실패: ${e.message}`);
    }
  }

  function showHuntSuccessBanner(seatDesc) {
    const b = document.createElement('div');
    b.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      'background:#c0392b', 'color:#fff',
      'padding:20px', 'font:700 18px system-ui',
      'text-align:center', 'box-shadow:0 4px 20px rgba(0,0,0,.5)',
      'border-bottom:3px solid #fff',
    ].join(';');
    b.innerHTML = `🎯 좌석 잡힘! · ${seatDesc}<br><span style="font-size:13px;font-weight:normal">좌석선택완료는 수동으로 진행하세요 (Enter 키)</span>`;
    (document.body || document.documentElement).appendChild(b);
  }

  async function notifyHuntSuccess(seatDesc) {
    log(`[HUNT] 🎯 좌석 잡힘! ${seatDesc}`);
    playHuntAlarm();
    showHuntDesktopNotification('🎯 좌석 잡힘!', `${seatDesc}\n좌석선택완료는 수동으로 진행하세요.`);
    showHuntSuccessBanner(seatDesc);
    if (S.HUNT_WEBHOOK_URL) await sendHuntWebhook(S.HUNT_WEBHOOK_URL, `🎯 인터파크 좌석 잡힘: ${seatDesc}`);
  }

  // =========================================================
  // triggerBacktrack — 선호 좌석 매칭 실패 시 이전단계 버튼 클릭
  // initSeatMap 안/밖 어디서든 호출 가능해야 해서 모듈 레벨로 추출.
  // (img.stySeat 가 하나도 없을 때 initSeatMap 자체가 호출 안 되는 케이스 대응)
  // =========================================================
  const waitMs = (ms) => new Promise(r => setTimeout(r, ms));
  async function triggerBacktrack(reason) {
    if (window.__auto_backtrack_fired__) {
      log(`[AUTO/backtrack] 중복 호출 skip (reason="${reason}")`);
      return;
    }
    window.__auto_backtrack_fired__ = true;

    log(`[AUTO/backtrack] 진입 — reason="${reason}" · url=${location.pathname}`);
    // 전역 S 는 IIFE 시작부에서 로드됨 (이 함수는 IIFE 안 클로저)
    const profiles = S.SEAT_PROFILES || [];
    if (profiles.length < 2) {
      warn(`[AUTO/backtrack] ${reason} — 수동 진행 필요 (SEAT_PROFILES 가 ${profiles.length}개라 backtrack 불가, 2개 이상 필요)`);
      return;
    }

    let currentGrade = '';
    let gradeSrc = '';
    try { currentGrade = sessionStorage.getItem('nol_current_grade') || ''; } catch (_) {}
    if (currentGrade) gradeSrc = 'sessionStorage';
    if (!currentGrade) {
      const firstSeat = document.querySelector('img.stySeat[title]');
      const title = firstSeat?.getAttribute('title') || '';
      const m = title.match(/^\[([^\]]+)\]/);
      if (m) { currentGrade = m[1]; gradeSrc = 'title 파싱'; }
      log(`[AUTO/backtrack] session 에 등급 없음 → title 파싱: firstSeat="${title.slice(0, 60)}" → "${currentGrade}"`);
    }

    let triedGrades = [];
    try { triedGrades = JSON.parse(sessionStorage.getItem('nol_tried_grades') || '[]'); } catch (_) {}
    log(`[AUTO/backtrack] currentGrade="${currentGrade}" (src=${gradeSrc || 'none'}), 기존 tried=${JSON.stringify(triedGrades)}`);

    if (!currentGrade) {
      warn('[AUTO/backtrack] 현재 등급 식별 실패 (session/title 둘 다 비어있음) → AUTO_FLOW 중단');
      markAutoFlowExhausted();
      return;
    }
    if (triedGrades.includes(currentGrade)) {
      warn(`[AUTO/backtrack] "${currentGrade}" 이미 tried 에 있음 — 중복 진입, AUTO_FLOW 소진 처리`);
      markAutoFlowExhausted();
      return;
    }
    triedGrades.push(currentGrade);
    try { sessionStorage.setItem('nol_tried_grades', JSON.stringify(triedGrades)); } catch (_) {}
    log(`[AUTO/backtrack] tried 에 "${currentGrade}" 추가 → ${JSON.stringify(triedGrades)} (${triedGrades.length}/${profiles.length})`);

    window.__auto_seat_done__ = true;
    await waitMs(400);

    // 좌석맵은 iframe 이라 이전단계 버튼은 부모 프레임에 있을 수 있음
    const frames = [];
    try { frames.push({ name: 'self', doc: document }); } catch (_) {}
    try { if (window.parent && window.parent !== window) frames.push({ name: 'parent', doc: window.parent.document }); } catch (e) { log(`[AUTO/backtrack] parent 접근 실패: ${e.message}`); }
    try { if (window.top && window.top !== window && window.top !== window.parent) frames.push({ name: 'top', doc: window.top.document }); } catch (e) { log(`[AUTO/backtrack] top 접근 실패: ${e.message}`); }
    log(`[AUTO/backtrack] 프레임 ${frames.length}개 검색 (${frames.map(f => f.name).join(', ')})`);

    const selectors = [
      'a[onclick*="fnCancel" i]',
      'a[onclick*="history.back" i]',
      'a[onclick*="goBack" i]',
      'img[alt*="이전단계"]',
      'img[alt*="이전 단계"]',
      'button[onclick*="fnCancel" i]',
    ];

    for (const { name, doc } of frames) {
      for (const sel of selectors) {
        try {
          const hits = Array.from(doc.querySelectorAll(sel));
          if (!hits.length) continue;
          log(`  · [${name}] selector "${sel}" → ${hits.length}개 매칭`);
          for (const h of hits) {
            const btn = h.closest?.('a') || h;
            const visible = btn.offsetParent !== null;
            const onclick = btn.getAttribute?.('onclick') || '(no onclick)';
            log(`    - visible=${visible}, onclick="${String(onclick).slice(0, 80)}"`);
            if (visible) {
              log(`[AUTO/backtrack] 이전단계 클릭 → frame=${name}, selector="${sel}"`);
              btn.click();
              return;
            }
          }
        } catch (e) {
          log(`  · [${name}] selector "${sel}" 에러: ${e.message}`);
        }
      }
    }
    warn('[AUTO/backtrack] 이전단계 버튼 못 찾음 — 수동 진행');
  }

  // CAPTCHA 통과 플래그 — 예매 팝업 session 단위
  // (CAPTCHA 는 첫 페이지에서만 등장, 이후 페이지는 이미 통과된 상태이므로
  //  looking phase 4s 대기 없이 즉시 진행해야 함)
  const captchaAlreadyPassed = () => {
    try { return sessionStorage.getItem('nol_captcha_passed') === '1'; } catch (_) { return false; }
  };
  const markCaptchaPassed = () => {
    try { sessionStorage.setItem('nol_captcha_passed', '1'); } catch (_) {}
  };

  // whenCaptchaResolved — 2-phase gate
  // phase A (looking): 호출 시점에 CAPTCHA 가 아직 active 가 아닐 수 있음
  //                    (CAPTCHA.js 가 늦게 init 되거나 JSONP 실패로 layer 뒤늦게 visible).
  //                    최대 APPEAR_TIMEOUT ms 동안 등장 감시. 등장하면 phase B 로.
  //                    안 뜨면 "진짜 CAPTCHA 없음" 으로 보고 cb().
  // phase B (waiting): 사용자가 CAPTCHA 풀 때까지 대기.
  //                    단, layer visibility 가 transient 하게 깜빡일 수 있으니
  //                    연속으로 STABLE_MS 동안 inactive 여야 cb().
  // ★ 한 번 통과된 후엔 플래그 캐싱 — 좌석맵/분기 등 이후 페이지는 즉시 진행
  //   (키움처럼 backtrack 빠르게 되려면 필수)
  const whenCaptchaResolved = (cb, timeoutMs = 10 * 60 * 1000) => {
    if (captchaAlreadyPassed()) { cb(); return; }
    if (captchaActive()) {
      // 처음 등장한 CAPTCHA — 사용자 입력 대기
    } else {
      // 첫 진입이고 CAPTCHA 도 아직 안 뜸 → 등장 감시 (Doosan 타이밍 대응)
    }

    const APPEAR_TIMEOUT = 4000;  // CAPTCHA 등장 기다리는 최대 시간
    const STABLE_MS      = 500;   // inactive 가 이 시간만큼 연속되어야 resolved 인정
    let phase = captchaActive() ? 'waiting' : 'looking';
    let inactiveSince = 0;
    let fired = false;
    const startedAt = Date.now();

    if (phase === 'looking') log('[AUTO] CAPTCHA 등장 대기 (최대 ' + (APPEAR_TIMEOUT/1000) + 's)...');
    else                     log('[AUTO] CAPTCHA 입력 대기 중...');

    const fire = (reason) => {
      if (fired) return;
      fired = true;
      try { obs.disconnect(); } catch (_) {}
      clearInterval(intv);
      clearTimeout(tmo);
      // 정상 통과(사용자 입력) 거나 "미등장" 둘 다 CAPTCHA 가 이 팝업에서 끝난 것으로 간주.
      // timeout 은 10분짜리라 정상 상황에선 안 옴 — 캐싱하지 않음.
      if (reason === '통과 감지' || reason === 'CAPTCHA 미등장') markCaptchaPassed();
      log('[AUTO] CAPTCHA 게이트 해제 — ' + reason);
      cb();
    };

    const tick = () => {
      if (fired) return;
      const active = captchaActive();
      if (phase === 'looking') {
        if (active) {
          phase = 'waiting';
          log('[AUTO] CAPTCHA 등장 감지 → 입력 대기 중...');
          return;
        }
        if (Date.now() - startedAt > APPEAR_TIMEOUT) {
          fire('CAPTCHA 미등장');
        }
        return;
      }
      // phase === 'waiting'
      if (active) { inactiveSince = 0; return; }
      if (!inactiveSince) inactiveSince = Date.now();
      if (Date.now() - inactiveSince >= STABLE_MS) fire('통과 감지');
    };

    const obs = new MutationObserver(tick);
    obs.observe(document.documentElement, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['style', 'class']
    });
    // attribute/childList 변화 없이 조용히 해제되는 케이스 대비 폴링 백업
    const intv = setInterval(tick, 250);
    const tmo  = setTimeout(() => { if (!fired) fire('timeout'); }, timeoutMs);
  };

  // =========================================================
  // 설정 다이얼로그 + Tampermonkey 메뉴 커맨드
  // =========================================================
  function openSettingsDialog() {
    const existing = document.getElementById('__nol_settings_modal__');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.id = '__nol_settings_modal__';
    backdrop.style.cssText = [
      'position:fixed', 'inset:0', 'background:rgba(0,0,0,.7)',
      'z-index:2147483646', 'display:flex', 'align-items:center', 'justify-content:center',
      'font-family:system-ui,-apple-system,sans-serif'
    ].join(';');

    const panel = document.createElement('div');
    panel.style.cssText = [
      'background:#1a1a1a', 'color:#eee', 'padding:24px 28px', 'border-radius:14px',
      'min-width:460px', 'max-width:90vw', 'max-height:85vh', 'overflow:auto',
      'box-shadow:0 20px 60px rgba(0,0,0,.8)', 'border:1px solid #333'
    ].join(';');

    const inp = (label, type, value, id, hint = '') => `
      <label style="display:block;margin-bottom:14px">
        <div style="font-size:12px;color:#aaa;margin-bottom:4px">${label}${hint ? ` <span style="color:#666">· ${hint}</span>` : ''}</div>
        <input id="${id}" type="${type}" value="${value}"
          style="width:100%;padding:8px 10px;background:#0d0d0d;border:1px solid #444;border-radius:6px;color:#fff;font-size:13px;box-sizing:border-box;font-family:monospace">
      </label>`;
    const chk = (label, checked, id) => `
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:13px;cursor:pointer">
        <input id="${id}" type="checkbox" ${checked ? 'checked' : ''} style="width:16px;height:16px">
        ${label}
      </label>`;
    const txt = (label, value, id, hint = '', rows = 4) => `
      <label style="display:block;margin-bottom:14px">
        <div style="font-size:12px;color:#aaa;margin-bottom:4px">${label}${hint ? ` <span style="color:#666">· ${hint}</span>` : ''}</div>
        <textarea id="${id}" rows="${rows}"
          style="width:100%;padding:8px 10px;background:#0d0d0d;border:1px solid #444;border-radius:6px;color:#fff;font-size:12px;box-sizing:border-box;font-family:monospace;resize:vertical;line-height:1.4">${value}</textarea>
      </label>`;

    panel.innerHTML = `
      <h2 style="margin:0 0 16px;font-size:18px">⚙️ 예매 보조 설정</h2>
      <div style="font-size:11px;color:#888;margin-bottom:16px;line-height:1.5">
        배열 값은 쉼표로 구분 (예: <code style="color:#0cf">3루, 중앙</code>).<br>
        숫자 배열도 쉼표 구분 (예: <code style="color:#0cf">413, 412</code>).
      </div>
      ${inp('TICKET_COUNT (매수)', 'number', S.TICKET_COUNT, '__s_ticket__', '연속석 자동 선택 수')}
      ${inp('SEAT_GRADE_FILTER (포함 키워드)', 'text', S.SEAT_GRADE_FILTER.join(', '), '__s_finc__', '등급명에 포함되어야 할 키워드')}
      ${inp('SEAT_GRADE_EXCLUDE (제외 키워드)', 'text', S.SEAT_GRADE_EXCLUDE.join(', '), '__s_fexc__', '하나라도 포함되면 숨김')}
      ${chk('HIDE_SOLD_OUT (매진 등급 숨김)', S.HIDE_SOLD_OUT, '__s_sold__')}
      ${chk('AUTO_FLOW — CAPTCHA 입력 후 등급 자동선택 → 좌석 자동선택 → 좌석선택완료 자동진행', S.AUTO_FLOW, '__s_auto__')}
      <hr style="border:0;border-top:1px solid #333;margin:16px 0">
      <div style="font-size:13px;color:#ffa500;margin-bottom:6px">🎯 HUNT_MODE (취소표 헌팅)</div>
      <div style="font-size:11px;color:#888;margin-bottom:10px;line-height:1.5">
        좌석맵에서 선호 좌석 없으면 <b>페이지 새로고침</b> 반복.<br>
        좌석 잡히면 소리 + 데스크톱 알림 + 웹훅 발송. 좌석선택완료는 수동 (결제 세션 보존).<br>
        HUNT_MODE 켜면 SEAT_PROFILES backtrack 은 비활성 — 한 등급/블럭만 계속 감시.
      </div>
      ${chk('HUNT_MODE 활성화', S.HUNT_MODE, '__s_hunt__')}
      ${inp('HUNT_RELOAD_INTERVAL_MS (reload 간격)', 'number', S.HUNT_RELOAD_INTERVAL_MS, '__s_hunt_intv__', '너무 짧으면 서버가 bot 으로 차단. 2000~5000 권장')}
      ${inp('HUNT_WEBHOOK_URL (핸드폰 푸시용, 옵션)', 'text', S.HUNT_WEBHOOK_URL, '__s_hunt_hook__', 'ntfy.sh/<topic명> / Discord webhook / Slack webhook 등')}
      <hr style="border:0;border-top:1px solid #333;margin:16px 0">
      <div style="font-size:13px;color:#aaa;margin-bottom:10px">SEAT_PROFILES (우선순위 배열 · 매칭된 등급의 blocks/rows/columns 적용)</div>
      ${txt('SEAT_PROFILES (JSON 배열)',
        JSON.stringify(S.SEAT_PROFILES || [], null, 2),
        '__s_profiles__',
        '예: [{"grade":"테이블","blocks":[101,102],"rows":[1,2]},{"grade":"레드","blocks":[]}]',
        10)}
      <hr style="border:0;border-top:1px solid #333;margin:16px 0">
      <div style="font-size:13px;color:#aaa;margin-bottom:10px">SEAT_PREFERENCE (fallback · PROFILES 비어있을 때만 적용)</div>
      ${inp('blocks (블럭 번호)', 'text', (S.SEAT_PREFERENCE.blocks || []).join(', '), '__s_blks__', '예: 413, 412')}
      ${inp('rows (행 ri)', 'text', (S.SEAT_PREFERENCE.rows || []).join(', '), '__s_rows__', '예: 3, 4, 5')}
      ${inp('columns (열 ci)', 'text', (S.SEAT_PREFERENCE.columns || []).join(', '), '__s_cols__', '예: 0, 2, 4, 6')}
      <div style="margin-top:20px;display:flex;gap:8px;justify-content:flex-end">
        <button id="__s_reset__" style="padding:8px 16px;background:#444;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:13px">↩ 기본값</button>
        <button id="__s_cancel__" style="padding:8px 16px;background:#444;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:13px">취소</button>
        <button id="__s_save__" style="padding:8px 20px;background:#0a8;color:#fff;border:0;border-radius:6px;cursor:pointer;font-weight:700;font-size:13px">💾 저장 & 새로고침</button>
      </div>
    `;

    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);

    const $ = (id) => document.getElementById(id);
    const parseList = (str, asNumber) => {
      return str.split(',').map(x => x.trim()).filter(Boolean)
        .map(v => asNumber ? (isNaN(+v) ? v : +v) : v);
    };

    $('__s_cancel__').onclick = close;
    $('__s_reset__').onclick = () => {
      if (!confirm('설정을 기본값으로 복원할까요?')) return;
      storage.del();
      location.reload();
    };
    $('__s_save__').onclick = () => {
      // SEAT_PROFILES JSON 파싱 + 검증
      let profiles = [];
      const profilesRaw = ($('__s_profiles__').value || '').trim();
      if (profilesRaw) {
        try {
          const parsed = JSON.parse(profilesRaw);
          if (!Array.isArray(parsed)) throw new Error('배열이 아님');
          profiles = parsed.map(p => ({
            grade:   typeof p.grade === 'string' ? p.grade : '',
            blocks:  Array.isArray(p.blocks)  ? p.blocks  : [],
            rows:    Array.isArray(p.rows)    ? p.rows    : [],
            columns: Array.isArray(p.columns) ? p.columns : [],
          }));
        } catch (e) {
          alert(`SEAT_PROFILES JSON 파싱 실패:\n${e.message}\n\n저장 취소됨 — 형식 확인 후 다시 저장해주세요.`);
          return;
        }
      }

      const next = {
        TICKET_COUNT:       Math.max(1, parseInt($('__s_ticket__').value, 10) || 1),
        SEAT_GRADE_FILTER:  parseList($('__s_finc__').value, false),
        SEAT_GRADE_EXCLUDE: parseList($('__s_fexc__').value, false),
        HIDE_SOLD_OUT:      $('__s_sold__').checked,
        AUTO_FLOW:          $('__s_auto__').checked,
        HUNT_MODE:              $('__s_hunt__').checked,
        HUNT_RELOAD_INTERVAL_MS: Math.max(500, parseInt($('__s_hunt_intv__').value, 10) || 2500),
        HUNT_WEBHOOK_URL:       ($('__s_hunt_hook__').value || '').trim(),
        SEAT_PREFERENCE: {
          blocks:  parseList($('__s_blks__').value, true),
          rows:    parseList($('__s_rows__').value, true),
          columns: parseList($('__s_cols__').value, true),
        },
        SEAT_PROFILES: profiles,
      };
      // HUNT_MODE 켤 때 알림 권한 미리 요청
      if (next.HUNT_MODE && 'Notification' in window && Notification.permission === 'default') {
        try { Notification.requestPermission(); } catch (_) {}
      }
      storage.set(next);
      log('설정 저장됨', next);
      location.reload();
    };
  }

  if (typeof GM_registerMenuCommand !== 'undefined') {
    GM_registerMenuCommand('⚙️ 설정 열기', openSettingsDialog);
    GM_registerMenuCommand('↩ 설정 초기화', () => {
      if (confirm('설정을 기본값으로 복원할까요?')) { storage.del(); location.reload(); }
    });
  }

  // AUTO_FLOW / HUNT_MODE 상태 배너
  if ((S.AUTO_FLOW || S.HUNT_MODE) && document.body) {
    const b = document.createElement('div');
    b.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      `background:${S.HUNT_MODE ? '#ffa500' : '#c33'}`, 'color:#fff',
      'padding:6px 12px', 'font:700 12px system-ui,-apple-system,sans-serif',
      'text-align:center', 'letter-spacing:1px',
    ].join(';');
    b.textContent = S.HUNT_MODE
      ? `🎯 HUNT_MODE ON · 좌석맵 ${S.HUNT_RELOAD_INTERVAL_MS}ms 간격 새로고침 · 좌석 잡히면 알림`
      : '⚡ AUTO_FLOW ON · CAPTCHA 입력 후 등급→좌석→완료 자동 진행';
    document.body.appendChild(b);
    setTimeout(() => b.remove(), 4000);
  }
  // =========================================================

  // =========================================================
  // 공통: "다음" Enter 단축키
  // =========================================================
  // 다음/확인 버튼 후보 텍스트 (라벨 기반 fallback)
  const NEXT_LABELS = ['다음', '다음단계', '좌석선택완료', '결제하기', '확인', '입력완료', '예매하기', '완료', '동의'];

  function findNextIn(doc) {
    const sels = [
      // CAPTCHA 최우선 — 오버레이로 떠있으면 뒤쪽 fnSelect/fnNext 보다 먼저 매칭돼야 함
      '.capchaBtns a', 'a[onclick*="fnCheck" i]', 'a[onclick*="fnSubmit" i]',
      // 일반 "다음" 계열
      'a[onclick*="NextStep" i]', 'a[onclick*="fnNext" i]', 'a[onclick*="goNext" i]',
      'a[onclick*="fnSelect" i]',   // 좌석선택완료
      'button[onclick*="NextStep" i]', 'button[onclick*="fnNext" i]',
      '.btn_next', '#btnNext', '.nextBtn', '[class*="btnNext"]', '[class*="BtnNext"]',
      'a.btn_next', 'a.next', 'a.nextStep', 'a.btnOk', 'a.btn_ok',
      '#NextStepImage',                                           // 좌석선택완료 이미지 id
      'img[alt*="좌석선택완료"]', 'img[alt*="다음" i]',
      'input[type="button"][value*="다음"]', 'input[type="submit"][value*="다음"]',
      'input[type="image"][alt*="다음"]', 'input[type="image"][src*="next" i]',
    ];
    for (const sel of sels) {
      try {
        const b = doc.querySelector(sel);
        if (!b || b.offsetParent === null) continue;
        // img 가 매칭된 경우 클릭해야 할 건 부모 a
        const target = b.closest('a, button, input[type="button"], input[type="submit"], input[type="image"]') || b;
        return { el: target, via: `sel:${sel}` };
      } catch (_) {}
    }
    // 텍스트 / img alt fallback — visible 한 clickable 중 라벨 일치
    const candidates = doc.querySelectorAll('a, button, input[type="button"], input[type="submit"]');
    for (const el of candidates) {
      if (el.offsetParent === null) continue;
      const text = ((el.textContent || el.value || '') + '').replace(/\s+/g, '').trim();
      const imgAlt = (el.querySelector('img')?.getAttribute('alt') || '').replace(/\s+/g, '').trim();
      const label = NEXT_LABELS.find(l => l === text || l === imgAlt);
      if (label) return { el, via: `label:${label}` };
    }
    return null;
  }

  function clickNext() {
    const frames = [];
    try { frames.push(document); } catch (_) {}
    try { if (window.parent && window.parent !== window) frames.push(window.parent.document); } catch (_) {}
    try { if (window.top && window.top !== window && window.top !== window.parent) frames.push(window.top.document); } catch (_) {}

    for (const doc of frames) {
      try {
        const hit = findNextIn(doc);
        if (hit) {
          log(`다음 버튼 클릭 [${hit.via}]`);
          hit.el.click();
          return true;
        }
      } catch (_) {}
    }
    warn('다음 버튼 못 찾음 — 페이지 구조 확인 필요');
    return false;
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.target.matches?.('input, textarea, select')) clickNext();
  });

  // =========================================================
  // 공통: 예매안내 팝업 자동 닫기 — 페이지당 1회만
  //
  // 즉시 click 하면 인터파크 초기 capchaInit 의 JSONP 가 아직 in-flight 인
  // 상태에서 fnBookNoticeShowHide → 두번째 capchaInit 이 race 를 일으켜
  // "jsonCallback is not a function" 발생 (수동 클릭 시엔 사용자가 1~2초 뒤
  // 누르므로 race 없음). 자동닫기에도 인간적 지연 부여.
  //
  // 조건: 다음 중 먼저 만족되는 쪽에서 click
  //   A. CAPTCHA 이미지 로드 완료 (첫 JSONP 사이클 끝난 신호)
  //   B. 1.5s 경과 (CAPTCHA 없는 페이지 대비)
  // =========================================================
  let bookNoticeHandled  = false;
  let bookNoticeArmed    = false;   // 감지 후 대기 시작 여부
  const captchaImgLoaded = () => {
    const img = document.querySelector(
      'img[id*="captcha" i], img[src*="captcha" i], img[src*="Captcha"], img[src*="IPCaptcha"]'
    );
    return !!(img && img.src && img.complete && img.naturalWidth > 0);
  };
  const doClickCloseBtn = () => {
    if (bookNoticeHandled) return;
    const layer = document.getElementById('divBookNoticeLayer');
    if (!layer || layer.offsetParent === null) return;
    const close = layer.querySelector('.closeBtn');
    if (!close) return;
    bookNoticeHandled = true;
    close.click();
    log('예매안내 팝업 자동 닫힘');
  };
  const armBookNoticeAutoClose = () => {
    if (bookNoticeArmed || bookNoticeHandled) return;
    const layer = document.getElementById('divBookNoticeLayer');
    if (!layer || layer.offsetParent === null) return;
    bookNoticeArmed = true;
    log('[HELPER] 예매안내 팝업 감지 → CAPTCHA 초기화 대기 중 (최대 1.5s)');

    const started = Date.now();
    const MAX_WAIT = 1500;
    const tick = () => {
      if (bookNoticeHandled) return;
      if (captchaImgLoaded()) {
        log('[HELPER] CAPTCHA 이미지 로드 확인 → 즉시 자동닫기');
        doClickCloseBtn();
        return;
      }
      if (Date.now() - started >= MAX_WAIT) {
        log(`[HELPER] ${MAX_WAIT}ms 경과 → 자동닫기 진행 (CAPTCHA 이미지 감지 안 됨)`);
        doClickCloseBtn();
        return;
      }
      setTimeout(tick, 150);
    };
    tick();
  };

  armBookNoticeAutoClose();
  try {
    const bn = new MutationObserver(() => {
      if (bookNoticeHandled) { bn.disconnect(); return; }
      armBookNoticeAutoClose();
    });
    bn.observe(document.body || document.documentElement, { childList: true, subtree: true });
  } catch (_) {}

  // =========================================================
  // 모드 1: 등급 리스트 필터 (div.list > a[sgn])
  // =========================================================
  if (document.querySelector('div.list a[sgn]')) initGradeList();

  // =========================================================
  // 모드 1.5: 자동배정/좌석선택 분기 페이지 (AUTO_FLOW 전용)
  // — 등급 클릭 후 뜨는 중간 선택 화면에서 "좌석선택" 쪽만 자동 클릭
  // =========================================================
  if (S.AUTO_FLOW && document.querySelector('a[onclick*="KBOGate.SetSeat()"]')) {
    autoClickSeatChoice();
  }

  // =========================================================
  // 모드 2: 좌석맵 (img.stySeat)
  // body onload="fnInit()" 이 좌석 초기화를 수행. 우리 DOM 수정(CSS/HUD) 이
  // 그보다 먼저 들어가면 fnInit 가 기대하는 초기 state 와 충돌 → 서버가
  // '비정상 경로' 로 판정 가능. 따라서 window.load 후에만 init.
  // =========================================================
  // seat map page 감지: img.stySeat 가 있거나, 좌석선택완료/이전단계 등 seat map
  // 전용 마커가 있으면 seat map 페이지로 간주 (좌석 0개여도 포함)
  const isSeatMapPage = () => {
    if (document.querySelector('img.stySeat')) return true;
    if (document.querySelector('a[onclick*="fnSelect" i]')) return true;
    if (document.querySelector('a[onclick*="SeatBuffer" i]')) return true;
    if (document.querySelector('#divSeatZoom, #divSeatArea, #SeatImg')) return true;
    return false;
  };
  // 좌석 렌더 — load + 100ms 시점에 판단. 대기 없음.
  // - img.stySeat 존재하면 initSeatMap
  // - 자식 frame 에 좌석 있으면 wrapper, skip
  // - 없으면 좌석 0개로 판단 → 즉시 backtrack
  // (tryInitSeatMap 은 load 이벤트 후 100ms 에 한 번만 실행되므로 그 전에 AJAX
  //  완료 못 되는 드문 케이스는 놓침. 대신 어떤 경우에도 즉시 결론.)

  // 현재 프레임 + 접근 가능한 모든 parent/child 프레임에서 img.stySeat 탐색
  const scanSeatsAcrossFrames = () => {
    const results = [];
    const visit = (win, label, depth = 0) => {
      if (depth > 4) return;
      try {
        const doc   = win.document;
        const count = doc.querySelectorAll('img.stySeat').length;
        const url   = (win.location && win.location.href) || '(unknown)';
        const imgSeatCount = doc.getElementById('ImgSeatCount')?.value;
        results.push({ label, url, count, imgSeatCount });
        for (let i = 0; i < win.frames.length; i++) {
          visit(win.frames[i], `${label}>frames[${i}]`, depth + 1);
        }
      } catch (e) {
        results.push({ label, url: '(cross-origin)', count: '?', err: e.message });
      }
    };
    visit(window, 'self');
    try { if (window.parent && window.parent !== window) visit(window.parent, 'parent'); } catch (_) {}
    try { if (window.top && window.top !== window && window.top !== window.parent) visit(window.top, 'top'); } catch (_) {}
    return results;
  };

  // 자식 frame 에 좌석 있는지 (wrapper frame 판정용)
  const childFrameHasSeats = () => {
    try {
      for (let i = 0; i < window.frames.length; i++) {
        try {
          if (window.frames[i].document.querySelector('img.stySeat')) return true;
        } catch (_) {}
      }
    } catch (_) {}
    return false;
  };

  let seatMapSettled = false;
  const tryInitSeatMap = () => {
    if (seatMapSettled) return;

    // 1. 좌석 있으면 즉시 init
    if (document.querySelector('img.stySeat')) {
      seatMapSettled = true;
      log(`[AUTO/좌석맵] img.stySeat ${document.querySelectorAll('img.stySeat').length}개 → initSeatMap`);
      initSeatMap();
      return;
    }

    // 2. seat map 페이지가 아니면 무시
    if (!isSeatMapPage()) return;

    // 3. wrapper frame — 자식 iframe 이 좌석 가지고 있음
    if (childFrameHasSeats()) {
      seatMapSettled = true;
      log(`[AUTO/좌석맵] 자식 frame 에 좌석 있음 — wrapper, skip (url=${location.pathname})`);
      return;
    }

    // 4. 좌석 없음
    seatMapSettled = true;
    const isc = document.getElementById('ImgSeatCount');
    const iscVal = isc ? isc.value : '(없음)';

    // HUNT_MODE: 이전단계 대신 reload 반복
    if (S.HUNT_MODE && !isAutoFlowBlocked()) {
      log(`[HUNT] 좌석 0개 (ImgSeatCount=${iscVal}) — ${S.HUNT_RELOAD_INTERVAL_MS}ms 후 새로고침`);
      setTimeout(() => location.reload(), S.HUNT_RELOAD_INTERVAL_MS);
      return;
    }
    // 기본: backtrack
    warn(`[AUTO/좌석맵] 좌석 0개 (ImgSeatCount=${iscVal}) — 즉시 이전단계`);
    if (S.AUTO_FLOW && !isAutoFlowBlocked()) {
      triggerBacktrack(`좌석맵 빈 페이지 (ImgSeatCount=${iscVal})`);
    }
  };
  // load 후 100ms 지연
  const scheduleSeatMapInit = () => setTimeout(tryInitSeatMap, 100);
  if (document.readyState === 'complete') scheduleSeatMapInit();
  else window.addEventListener('load', scheduleSeatMapInit, { once: true });

  // =========================================================
  // 모드 3: CAPTCHA (동적 감지)
  // — CAPTCHA 오버레이가 실제로 visible 일 때만 init (input 속성/스타일 수정)
  //   그렇지 않으면 DOM 무간섭 (등급→좌석 flow 중 서버 validation 방해 방지)
  // =========================================================
  let captchaInited = false;
  const tryInitCaptcha = () => {
    if (captchaInited) return;
    if (!captchaActive()) return;                     // ★ 오버레이 visible 할 때만 init
    const img   = findCaptchaImg();
    const input = findCaptchaInput();
    if (!img && !input) return;
    captchaInited = true;
    initCaptcha(img, input);
  };
  tryInitCaptcha();
  try {
    new MutationObserver(tryInitCaptcha).observe(document.documentElement, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['style', 'class']  // visibility 변화도 감지
    });
  } catch (_) {}

  // =========================================================
  // 등급 리스트 필터
  // =========================================================
  function initGradeList() {
    const list = document.querySelector('div.list');
    if (!list) return;

    const applyFilter = () => {
      const items = list.querySelectorAll('a[sgn]');
      if (!items.length) return;
      let shown = 0, hiddenByInc = 0, hiddenByExc = 0, hiddenBySold = 0;

      items.forEach(a => {
        const sgn = a.getAttribute('sgn') || '';
        const rc  = parseInt(a.getAttribute('rc') || '0', 10);

        const matchInc  = S.SEAT_GRADE_FILTER.length === 0 || S.SEAT_GRADE_FILTER.some(kw => sgn.includes(kw));
        const matchExc  = S.SEAT_GRADE_EXCLUDE.length === 0 || !S.SEAT_GRADE_EXCLUDE.some(kw => sgn.includes(kw));
        const matchSold = !S.HIDE_SOLD_OUT || rc > 0;
        const visible   = matchInc && matchExc && matchSold;

        a.style.display = visible ? '' : 'none';

        // hasInfo 등급은 다음 형제에 .groundInfo 안내 박스가 붙어있음 → 같이 처리
        const next = a.nextElementSibling;
        if (next && next.classList.contains('groundInfo')) {
          next.style.display = visible ? '' : 'none';
        }

        if (visible) shown++;
        else if (!matchInc) hiddenByInc++;
        else if (!matchExc) hiddenByExc++;
        else hiddenBySold++;
      });

      log(`등급 필터: 표시 ${shown} / 포함안됨 ${hiddenByInc} / 제외매칭 ${hiddenByExc} / 매진 ${hiddenBySold}`, {
        include: S.SEAT_GRADE_FILTER, exclude: S.SEAT_GRADE_EXCLUDE
      });
    };

    applyFilter();

    // AJAX 로 리스트 재렌더될 때 재적용 (childList 변화만 추적, style 변경은 무시)
    const obs = new MutationObserver((muts) => {
      if (muts.some(m => m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length))) {
        applyFilter();
      }
    });
    obs.observe(list, { childList: true, subtree: true });

    // 상단 요약 배너
    const banner = document.createElement('div');
    banner.style.cssText = [
      'position:fixed', 'top:0', 'left:50%', 'transform:translateX(-50%)',
      'z-index:2147483647', 'background:#0a8', 'color:#fff',
      'padding:6px 18px', 'font:700 13px system-ui,-apple-system,sans-serif',
      'border-radius:0 0 8px 8px', 'box-shadow:0 2px 10px rgba(0,0,0,.3)'
    ].join(';');
    const parts = [];
    if (S.SEAT_GRADE_FILTER.length)  parts.push(`포함: ${S.SEAT_GRADE_FILTER.join(',')}`);
    if (S.SEAT_GRADE_EXCLUDE.length) parts.push(`제외: ${S.SEAT_GRADE_EXCLUDE.join(',')}`);
    if (S.HIDE_SOLD_OUT)             parts.push('매진숨김');
    banner.textContent = parts.length ? `🔎 등급 필터 · ${parts.join(' · ')}` : '🔎 등급 필터 비활성';
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 3000);

    // AUTO_FLOW — CAPTCHA 통과 후 SEAT_PROFILES 우선순위대로 등급 자동 클릭
    // (좌석맵 backtrack 으로 돌아온 경우 nol_tried_grades 에 기록된 등급 제외)
    if (S.AUTO_FLOW && !window.__auto_grade_clicked__ && !isAutoFlowBlocked()) {
      log(`[AUTO/등급] AUTO_FLOW 대기 시작 (url=${location.pathname})`);
      whenCaptchaResolved(() => {
        if (window.__auto_grade_clicked__ || isAutoFlowBlocked()) {
          log(`[AUTO/등급] skip — grade_clicked=${!!window.__auto_grade_clicked__}, blocked=${isAutoFlowBlocked()}`);
          return;
        }
        const autoPickGrade = () => {
          if (window.__auto_grade_clicked__ || isAutoFlowBlocked()) return;
          const triedGrades = (() => {
            try { return JSON.parse(sessionStorage.getItem('nol_tried_grades') || '[]'); }
            catch (_) { return []; }
          })();

          // 전체 a[sgn] 열거 — 숨김/rc=0/tried 이유 전부 로깅
          const all = Array.from(list.querySelectorAll('a[sgn]'));
          const enumerated = all.map(a => {
            const sgn = a.getAttribute('sgn') || '';
            const rc  = parseInt(a.getAttribute('rc') || '0', 10);
            const hiddenByStyle = a.style.display === 'none' || a.offsetParent === null;
            const tried = triedGrades.includes(sgn);
            const reasons = [];
            if (hiddenByStyle) reasons.push('hidden');
            if (tried)         reasons.push('tried');
            if (rc <= 0)       reasons.push('rc=0');
            return { sgn, rc, a, skip: reasons.length > 0, reasons };
          });
          log(`[AUTO/등급] 리스트 전체 ${all.length}개 (tried=${JSON.stringify(triedGrades)})`);
          enumerated.forEach((e, i) => {
            const mark = e.skip ? '✗' : '✓';
            const why  = e.reasons.length ? ` [${e.reasons.join(',')}]` : '';
            log(`  ${mark} #${i+1} "${e.sgn}" rc=${e.rc}${why}`);
          });

          const candidates = enumerated.filter(e => !e.skip);

          // 프로필 순위로 매칭 시도
          let target = null;
          let matchedProfile = null;
          let matchedProfileIdx = -1;
          const profiles = S.SEAT_PROFILES || [];
          log(`[AUTO/등급] SEAT_PROFILES ${profiles.length}개 순차 매칭:`);
          for (let i = 0; i < profiles.length; i++) {
            const p = profiles[i];
            const hit = candidates.find(c => !p.grade || c.sgn.includes(p.grade));
            if (hit) {
              log(`  ➜ #${i+1} grade="${p.grade || '(any)'}" → MATCH "${hit.sgn}" rc=${hit.rc}`);
              target = hit.a;
              matchedProfile = p;
              matchedProfileIdx = i;
              break;
            } else {
              const dropped = enumerated.filter(e => e.skip && (!p.grade || e.sgn.includes(p.grade)));
              const msg = dropped.length
                ? `dropped=[${dropped.map(d => `"${d.sgn}"(${d.reasons.join(',')})`).join(', ')}]`
                : '해당 등급 없음';
              log(`  ✗ #${i+1} grade="${p.grade || '(any)'}" — no candidate (${msg})`);
            }
          }
          // SEAT_PROFILES 비어있을 때만 legacy fallback (rc>0 첫 등급)
          if (!target && profiles.length === 0) {
            const fb = candidates[0];
            if (fb) {
              target = fb.a;
              log(`[AUTO/등급] profile 없음 → legacy fallback: "${fb.sgn}" rc=${fb.rc}`);
            }
          }
          if (!target) {
            if (profiles.length) {
              warn('[AUTO/등급] SEAT_PROFILES 매칭 등급 없음 — AUTO_FLOW 중단 (빈 fallback profile 추가하면 아무 등급이나 잡힘)');
            } else {
              warn('[AUTO/등급] 시도 가능한 등급 소진 — AUTO_FLOW 중단');
            }
            markAutoFlowExhausted();
            return;
          }

          window.__auto_grade_clicked__ = true;
          const gradeSgn = target.getAttribute('sgn') || '';
          try { sessionStorage.setItem('nol_current_grade', gradeSgn); } catch (_) {}
          const tag = matchedProfile
            ? ` [profile #${matchedProfileIdx+1} grade="${matchedProfile.grade || '(any)'}"]`
            : '';
          log(`[AUTO/등급] 자동선택${tag}: "${gradeSgn}" (rc=${target.getAttribute('rc')}) · onclick=${target.getAttribute('onclick')?.slice(0, 80)}`);
          target.click();
        };
        setTimeout(autoPickGrade, 400 + Math.floor(Math.random() * 200));
      });
    }
  }

  // =========================================================
  // 자동배정/좌석선택 분기 페이지 — 좌석선택 버튼 자동 클릭
  // (KBOGate.SetSeatAuto 는 서버 랜덤배정이라 스킵, KBOGate.SetSeat 만 사용)
  // CAPTCHA 오버레이가 같이 떠 있으면 통과할 때까지 대기
  // =========================================================
  function autoClickSeatChoice() {
    log(`[AUTO/분기] 진입 (url=${location.pathname}) seatchoice_done=${!!window.__auto_seatchoice_done__}, blocked=${isAutoFlowBlocked()}`);
    if (window.__auto_seatchoice_done__ || isAutoFlowBlocked()) return;
    whenCaptchaResolved(() => {
      if (window.__auto_seatchoice_done__ || isAutoFlowBlocked()) return;
      let attempts = 0;
      const tryClick = () => {
        if (window.__auto_seatchoice_done__ || isAutoFlowBlocked()) return;
        attempts++;

        // ★ 반드시 등급 auto-click 완료된 뒤에만 진행 (같은 페이지 공존 구조 대응)
        if (!window.__auto_grade_clicked__) {
          if (attempts === 1 || attempts % 20 === 0) {
            log(`[AUTO/분기] 등급 클릭 대기 (attempts=${attempts}) — __auto_grade_clicked__=false`);
          }
          if (attempts < 100) setTimeout(tryClick, 150);
          else warn('[AUTO/분기] 등급 자동선택이 안 돼서 좌석선택 단계 진입 못함');
          return;
        }

        // 등급 클릭 후에도 Interpark JS 가 DOM 업데이트 시간 필요
        const btn = document.querySelector('a[onclick*="KBOGate.SetSeat()"]');
        if (!btn || btn.offsetParent === null) {
          if (attempts === 1 || attempts % 20 === 0) {
            log(`[AUTO/분기] 좌석선택 버튼 대기 (attempts=${attempts}) — btn=${!!btn}, visible=${btn?.offsetParent !== null}`);
          }
          if (attempts < 100) setTimeout(tryClick, 150);
          else warn('[AUTO/분기] 좌석선택 버튼 visible 전환 안됨 — 수동 진행');
          return;
        }

        window.__auto_seatchoice_done__ = true;
        log(`[AUTO/분기] 좌석선택 버튼 클릭 (자동배정 스킵, 시도 ${attempts}회) · onclick=${btn.getAttribute('onclick')?.slice(0, 80)}`);
        btn.click();
      };
      // 초기 지연 제거 — 플래그 기반 대기로 충분
      tryClick();
    });
  }

  // =========================================================
  // 좌석맵
  // =========================================================
  function initSeatMap() {
    let hoverClickOn = false;

    // 현재 좌석맵의 등급 감지 (좌석 title: "[등급명] 블럭-좌석")
    // → SEAT_PROFILES 에서 매칭되는 프로필의 blocks/rows/columns 를 SEAT_PREFERENCE 로 override
    const profiles = S.SEAT_PROFILES || [];
    const totalSeatsAtInit = document.querySelectorAll('img.stySeat').length;
    const titledSeatsAtInit = document.querySelectorAll('img.stySeat[title]').length;
    log(`[AUTO/좌석맵] initSeatMap 진입 (url=${location.pathname}) · img.stySeat=${totalSeatsAtInit}, title 있음=${titledSeatsAtInit}`);

    if (profiles.length) {
      const firstSeat = document.querySelector('img.stySeat[title]');
      const title = firstSeat?.getAttribute('title') || '';
      const gradeMatch = title.match(/^\[([^\]]+)\]/);
      const gradeFromTitle = gradeMatch ? gradeMatch[1] : '';
      let gradeFromSession = '';
      try { gradeFromSession = sessionStorage.getItem('nol_current_grade') || ''; } catch (_) {}
      const currentGrade = gradeFromTitle || gradeFromSession;
      log(`[AUTO/좌석맵] currentGrade: title="${gradeFromTitle}" session="${gradeFromSession}" → "${currentGrade}" (firstSeat.title="${title.slice(0, 60)}")`);

      const matchedIdx = profiles.findIndex(p => !p.grade || currentGrade.includes(p.grade));
      const matched = matchedIdx >= 0 ? profiles[matchedIdx] : null;
      if (matched) {
        S.SEAT_PREFERENCE = {
          blocks:  matched.blocks  || [],
          rows:    matched.rows    || [],
          columns: matched.columns || [],
        };
        log(`[AUTO/좌석맵] 활성 프로필 #${matchedIdx+1}: grade="${matched.grade || '(any)'}" → SEAT_PREFERENCE=`, S.SEAT_PREFERENCE);
      } else {
        log(`[AUTO/좌석맵] SEAT_PROFILES 매칭 없음 (currentGrade="${currentGrade}") — fallback 으로 기존 SEAT_PREFERENCE 사용:`, S.SEAT_PREFERENCE);
      }
    } else {
      log(`[AUTO/좌석맵] SEAT_PROFILES 비어있음 — SEAT_PREFERENCE 그대로 사용:`, S.SEAT_PREFERENCE);
    }

    const allSeats = () => Array.from(document.querySelectorAll('img.stySeat'));
    const seatSID  = (s) => {
      const m = (s.getAttribute('onclick') || '').match(/SelectSeatKBO\('(SID\d+)'/);
      return m ? m[1] : null;
    };
    const isSelected = (s) => {
      const sid = seatSID(s); if (!sid) return false;
      const ov = document.getElementById(sid); if (!ov) return false;
      return (ov.style.display || '').toLowerCase() !== 'none';
    };
    const isAvailable = (s) => {
      if (!s.getAttribute('onclick')) return false;
      if (s.offsetParent === null) return false;
      if (isSelected(s)) return false;
      return true;
    };

    const clickSeat = (s) => {
      const oc = s.getAttribute('onclick');
      if (!oc) return false;
      try { (0, eval)(oc); return true; } catch (e) { warn('클릭 실패:', e); return false; }
    };

    // SID → 짝 오버레이 / 짝 base seat
    const overlayOfSID = (sid) => document.getElementById(sid);
    const seatOfSID    = (sid) => Array.from(document.querySelectorAll('img.stySeat'))
      .find(s => (s.getAttribute('onclick') || '').includes(`'${sid}'`));
    const seatOfOverlay = (ov) => seatOfSID(ov.id) || ov;

    // 오버레이 기준 예매가능 판정 (속성이 오버레이에만 있음)
    const overlayPickable = (ov) => {
      const d = (ov.style.display || '').toLowerCase();
      if (d !== 'none') return false; // 이미 선택됨
      if (!ov.getAttribute('onclick')) return false;
      const base = seatOfSID(ov.id);
      if (!base) return false;
      if (!base.getAttribute('onclick')) return false;
      if (base.offsetParent === null) return false;
      return true;
    };

    // 같은 rg 내에서 연속 N칸 찾기 (균형 우선)
    //   → rg/ci 속성은 .stySelectSeat 에만 있으므로 오버레이로 탐색 후 .stySeat 로 변환해 반환
    const findCompanions = (clicked, count) => {
      if (count <= 1) return [clicked];

      const sid = seatSID(clicked);
      if (!sid) return [clicked];
      const ov0 = overlayOfSID(sid);
      if (!ov0) return [clicked];

      const rg  = ov0.getAttribute('rg');
      const ci0 = parseInt(ov0.getAttribute('ci'), 10);
      if (!rg || Number.isNaN(ci0)) return [clicked];

      const rowOvs = Array.from(document.querySelectorAll('img.stySelectSeat'))
        .filter(ov => ov.getAttribute('rg') === rg)
        .sort((a, b) => parseInt(a.getAttribute('ci'), 10) - parseInt(b.getAttribute('ci'), 10));
      if (!rowOvs.length) return [clicked];

      const diffs = [];
      for (let i = 1; i < rowOvs.length; i++) {
        diffs.push(parseInt(rowOvs[i].getAttribute('ci'), 10) - parseInt(rowOvs[i-1].getAttribute('ci'), 10));
      }
      const step = diffs.length ? Math.min(...diffs.filter(d => d > 0)) : 1;

      const byCi   = new Map(rowOvs.map(ov => [parseInt(ov.getAttribute('ci'), 10), ov]));
      const canPick = (ov) => ov === ov0 || overlayPickable(ov);

      const add = count - 1;
      const balance = Math.floor(add / 2);
      const splits = [];
      for (let l = 0; l <= add; l++) splits.push([l, add - l]);
      splits.sort((a, b) => Math.abs(a[0] - balance) - Math.abs(b[0] - balance));

      for (const [lN, rN] of splits) {
        const result = [ov0];
        let ok = true;
        for (let i = 1; i <= lN; i++) {
          const ov = byCi.get(ci0 - i * step);
          if (!ov || !canPick(ov)) { ok = false; break; }
          result.unshift(ov);
        }
        if (!ok) continue;
        for (let i = 1; i <= rN; i++) {
          const ov = byCi.get(ci0 + i * step);
          if (!ov || !canPick(ov)) { ok = false; break; }
          result.push(ov);
        }
        if (ok) {
          // 첫번째(ov0)는 유저가 클릭한 원본 유지, 나머지는 base .stySeat 으로 매핑
          return result.map(ov => ov === ov0 ? clicked : seatOfOverlay(ov));
        }
      }
      return [clicked];
    };

    // 시각화 CSS
    const style = document.createElement('style');
    style.id = '__seat_helper_styles__';
    style.textContent = `
      /* 예매가능 (연두 얇은 테두리) */
      img.stySeat[onclick] {
        filter: saturate(1.4) brightness(1.08) !important;
        outline: 1px solid rgba(0,220,100,0.55) !important;
      }
      /* 선호 좌석 — 주황 굵은 테두리 + 글로우 + 펄스 애니메이션 */
      img.stySeat[data-preferred="1"] {
        outline: 3px solid #ff7b00 !important;
        box-shadow:
          0 0 0 1px #ff7b00,
          0 0 14px rgba(255,123,0,.95),
          0 0 28px rgba(255,123,0,.55) !important;
        filter: saturate(2.6) brightness(1.35) !important;
        z-index: 6 !important;
        animation: __seat_pref_pulse 1.2s ease-in-out infinite alternate !important;
      }
      @keyframes __seat_pref_pulse {
        from { outline-width: 3px; box-shadow: 0 0 0 1px #ff7b00, 0 0 10px rgba(255,123,0,.8), 0 0 20px rgba(255,123,0,.4); }
        to   { outline-width: 5px; box-shadow: 0 0 0 1px #ff7b00, 0 0 18px rgba(255,123,0,1),  0 0 36px rgba(255,123,0,.7); }
      }
      /* hover 연속석 미리보기 — 청록 점선 (차분하게) */
      img.stySeat[data-preview="1"] {
        outline: 2px dashed #00e0ff !important;
        outline-offset: 1px !important;
        box-shadow: 0 0 6px rgba(0,224,255,.6) !important;
        filter: saturate(1.6) brightness(1.15) !important;
        z-index: 8 !important;
        animation: none !important;  /* 선호석과 겹칠 때 펄스 애니메이션 중단 */
      }
      /* 선택됨 (본인) — 형광 노랑 + 가장 강한 글로우 */
      img.stySelectSeat {
        outline: 4px solid #ffff00 !important;
        box-shadow:
          0 0 0 1px #000,
          0 0 18px rgba(255,255,0,1),
          0 0 36px rgba(255,255,0,.7) !important;
        z-index: 10 !important;
      }
    `;
    document.head.appendChild(style);

    // HUD
    const hud = document.createElement('div');
    hud.id = '__seat_hud__';
    hud.style.cssText = [
      'position:fixed', 'top:10px', 'right:10px', 'z-index:2147483647',
      'background:rgba(0,0,0,0.88)', 'color:#0f0',
      'padding:12px 16px', 'font:700 12px/1.5 monospace',
      'border-radius:8px', 'min-width:200px',
      'box-shadow:0 4px 20px rgba(0,0,0,.5)',
      'user-select:none', 'pointer-events:none'
    ].join(';');
    document.body.appendChild(hud);

    const renderHud = () => {
      const total = allSeats().length;
      const avail = allSeats().filter(isAvailable).length;
      const sel   = allSeats().filter(isSelected).length;
      hud.innerHTML = [
        `<div style="color:#fff;font-size:11px;margin-bottom:4px">🏟 좌석 보조 · ${S.TICKET_COUNT}매</div>`,
        `<div>전체 ${total} / 가능 ${avail} / 선택 ${sel}</div>`,
        `<div style="margin-top:10px;font-size:11px;color:#888;line-height:1.7">`,
        `[Q] 임의 ${S.TICKET_COUNT}매 연속<br>`,
        `[E] Hover클릭 ${hoverClickOn ? 'ON' : 'off'}<br>`,
        `[클릭] 연속 ${S.TICKET_COUNT}매 자동<br>`,
        `[Enter] 다음/확인`,
        `</div>`,
      ].join('');
    };
    setInterval(renderHud, 400);
    renderHud();

    // 좌석 여러 개를 50ms 간격으로 순차 클릭 (서버 bot 탐지 완화)
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const STEP_DELAY_MS = 50;
    const selectGroup = async (group) => {
      let ok = 0;
      for (let i = 0; i < group.length; i++) {
        const s = group[i];
        if (isSelected(s)) continue;
        if (clickSeat(s)) {
          ok++;
          if (i < group.length - 1) await wait(STEP_DELAY_MS);
        }
      }
      return ok;
    };

    // 선호도 — blocks AND rows AND columns 교집합 필터 (빈 배열 필드 = 해당 제약 없음)
    const prefActive = S.SEAT_PREFERENCE.blocks.length + S.SEAT_PREFERENCE.rows.length + S.SEAT_PREFERENCE.columns.length > 0;

    const matchesPreference = (seat) => {
      if (!prefActive) return true;
      const sid = seatSID(seat);
      const ov  = sid ? overlayOfSID(sid) : null;
      if (!ov) return false;
      const ri  = ov.getAttribute('ri');
      const ci  = ov.getAttribute('ci');
      const blk = (ov.getAttribute('rg') || '').split('_')[0];
      const inList = (list, val) => {
        if (!list || !list.length) return true;           // 빈 배열 = 제약 없음
        const strVal = String(val);
        return list.some(x => String(x) === strVal);
      };
      return inList(S.SEAT_PREFERENCE.blocks,  blk)
          && inList(S.SEAT_PREFERENCE.rows,    ri)
          && inList(S.SEAT_PREFERENCE.columns, ci);
    };

    // 매칭된 좌석 내부 정렬용 (배열 앞쪽 값일수록 높은 점수)
    const scoreSeat = (seat) => {
      const sid = seatSID(seat);
      const ov  = sid ? overlayOfSID(sid) : null;
      if (!ov) return 0;
      const ri  = ov.getAttribute('ri');
      const ci  = ov.getAttribute('ci');
      const blk = (ov.getAttribute('rg') || '').split('_')[0];
      const rank = (list, val, base) => {
        if (!list || !list.length) return 0;
        const strVal = String(val);
        const i = list.findIndex(x => String(x) === strVal);
        return i >= 0 ? base * (list.length - i) : 0;
      };
      return rank(S.SEAT_PREFERENCE.blocks,  blk, 10000)
           + rank(S.SEAT_PREFERENCE.rows,    ri,    100)
           + rank(S.SEAT_PREFERENCE.columns, ci,      1);
    };

    // 선호 좌석 하이라이트 — AND 매칭되는 자리만 (주기적 갱신)
    const applyPreferredHighlight = () => {
      allSeats().forEach(s => s.removeAttribute('data-preferred'));
      if (!prefActive) return;
      allSeats().forEach(s => {
        if (isAvailable(s) && matchesPreference(s)) s.setAttribute('data-preferred', '1');
      });
    };
    applyPreferredHighlight();
    setInterval(applyPreferredHighlight, 800);

    // Q: 선호 조건 AND 매칭된 좌석 중에서만 연속 N매 가능한 자리 선택
    const autoPick = async () => {
      const all = allSeats();
      const avail = all.filter(isAvailable);
      log(`[AUTO/pick] 전체 좌석 ${all.length}, 가용 ${avail.length}, prefActive=${prefActive}, TICKET_COUNT=${S.TICKET_COUNT}`);
      if (prefActive) {
        log(`[AUTO/pick] SEAT_PREFERENCE: blocks=${JSON.stringify(S.SEAT_PREFERENCE.blocks)} rows=${JSON.stringify(S.SEAT_PREFERENCE.rows)} columns=${JSON.stringify(S.SEAT_PREFERENCE.columns)}`);
      }

      // 가용 좌석의 블럭 분포 집계 (선호 blocks 와 비교용)
      if (avail.length > 0 && avail.length <= 200) {
        const byBlock = {};
        avail.forEach(s => {
          const sid = seatSID(s);
          const ov  = sid ? overlayOfSID(sid) : null;
          const blk = ov ? (ov.getAttribute('rg') || '').split('_')[0] : '?';
          byBlock[blk] = (byBlock[blk] || 0) + 1;
        });
        log(`[AUTO/pick] 가용 좌석 블럭 분포:`, byBlock);
      }

      let candidates = prefActive ? avail.filter(matchesPreference) : avail;

      if (prefActive && candidates.length === 0) {
        warn(`[AUTO/pick] 선호 조건 AND 매칭 좌석 0개 — blocks=${JSON.stringify(S.SEAT_PREFERENCE.blocks)} rows=${JSON.stringify(S.SEAT_PREFERENCE.rows)} columns=${JSON.stringify(S.SEAT_PREFERENCE.columns)}`);
        return false;
      }
      log(`[AUTO/pick] 매칭 후보 ${candidates.length}개`);

      if (prefActive) {
        candidates = candidates
          .map(s => ({ s, sc: scoreSeat(s) }))
          .sort((a, b) => b.sc - a.sc)
          .map(x => x.s);
      }

      let tried = 0;
      for (const s of candidates) {
        tried++;
        const group = findCompanions(s, S.TICKET_COUNT);
        if (group.length >= S.TICKET_COUNT) {
          await selectGroup(group);
          const tag = prefActive ? ` (AND match, score=${scoreSeat(s)})` : '';
          log(`[AUTO/pick] ✅ ${group.length}매 선택${tag} · 시도 ${tried}/${candidates.length}: ${group.map(x => x.getAttribute('title') || x.getAttribute('seatinfo') || '').join(' | ')}`);
          return true;
        }
      }
      warn(`[AUTO/pick] ${candidates.length}개 후보 모두 연속 ${S.TICKET_COUNT}칸 불가 (${prefActive ? '선호 매칭 중' : '전체 중'})`);
      return false;
    };

    // 유저 클릭 → 동료 좌석 자동 추가
    let clickToken = 0;
    document.addEventListener('click', (e) => {
      const seat = e.target?.closest?.('img.stySeat');
      if (!seat) return;
      if (!seat.getAttribute('onclick')) return;
      const my = ++clickToken;
      setTimeout(async () => {
        if (my !== clickToken) return;
        if (S.TICKET_COUNT <= 1) return;
        const selectedNow = allSeats().filter(isSelected);
        if (selectedNow.length !== 1) return;
        if (!isSelected(seat)) return;
        const group = findCompanions(seat, S.TICKET_COUNT);
        if (group.length < S.TICKET_COUNT) {
          warn(`같은 행에 ${S.TICKET_COUNT}칸 연속 없음 (단일 유지)`);
          return;
        }
        await selectGroup(group);
        log(`👥 연속석 자동: ${group.length}매`);
      }, 150);
    }, true);

    // hover 미리보기 + hover-click
    document.addEventListener('mouseover', (e) => {
      const seat = e.target?.closest?.('img.stySeat');
      if (!seat) return;
      if (hoverClickOn && isAvailable(seat)) { clickSeat(seat); return; }
      if (S.TICKET_COUNT < 2) return;
      if (!isAvailable(seat)) return;
      if (allSeats().some(isSelected)) return;
      const group = findCompanions(seat, S.TICKET_COUNT);
      if (group.length >= S.TICKET_COUNT) {
        allSeats().forEach(s => s.removeAttribute('data-preview'));
        group.forEach(s => s.setAttribute('data-preview', '1'));
      }
    });
    document.addEventListener('mouseout', (e) => {
      const seat = e.target?.closest?.('img.stySeat');
      if (!seat) return;
      allSeats().forEach(s => s.removeAttribute('data-preview'));
    });

    // 단축키
    document.addEventListener('keydown', (e) => {
      if (e.target.matches?.('input, textarea, select')) return;
      const k = e.key.toLowerCase();
      if (k === 'q') { e.preventDefault(); autoPick(); }
      else if (k === 'e') { e.preventDefault(); hoverClickOn = !hoverClickOn; log(`hover-click: ${hoverClickOn}`); }
    });

    log(`좌석 보조 활성화 · 매수=${S.TICKET_COUNT}`);

    // AUTO_FLOW — CAPTCHA 통과 후 좌석 로드 → autoPick → 좌석선택완료
    // 각 단계 사이 50ms 딜레이 (bot 탐지 완화)
    if (S.AUTO_FLOW && !window.__auto_seat_done__ && !isAutoFlowBlocked()) {
      whenCaptchaResolved(async () => {
        if (window.__auto_seat_done__ || isAutoFlowBlocked()) return;

        // 실패 시 처리 헬퍼 — HUNT_MODE 면 reload, 아니면 backtrack
        const onFailure = async (reason) => {
          if (S.HUNT_MODE) {
            log(`[HUNT] ${reason} → ${S.HUNT_RELOAD_INTERVAL_MS}ms 후 새로고침`);
            await wait(S.HUNT_RELOAD_INTERVAL_MS);
            location.reload();
          } else {
            await triggerBacktrack(reason);
          }
        };

        const availableCount = allSeats().filter(isAvailable).length;
        if (availableCount === 0) {
          warn('[AUTO] 빈자리 없음');
          await onFailure('빈자리 없음');
          return;
        }
        log(`[AUTO] 좌석 ${allSeats().length}개 · 가용 ${availableCount} → autoPick`);

        const picked = await autoPick();
        if (!picked) {
          await onFailure('선호 좌석 매칭 실패');
          return;
        }
        window.__auto_seat_done__ = true;

        // 서버 반영 대기
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          const sel = allSeats().filter(isSelected).length;
          if (sel >= S.TICKET_COUNT) break;
          await wait(50);
        }
        const finalSelected = allSeats().filter(isSelected).length;
        if (finalSelected < S.TICKET_COUNT) {
          warn(`[AUTO] 선택 확인 실패 (${finalSelected}/${S.TICKET_COUNT}) — 수동 진행`);
          return;
        }

        markAutoFlowDone();
        log(`[AUTO] AUTO_FLOW 완료 플래그 세팅 — 이후 자동동작 off`);

        // HUNT_MODE: 좌석선택완료 자동 클릭 안 함. 알림만 쏘고 사용자 개입 대기.
        if (S.HUNT_MODE) {
          const titles = allSeats().filter(isSelected).map(s => s.getAttribute('title') || '').filter(Boolean);
          const seatDesc = titles.join(' | ') || `${finalSelected}매`;
          await notifyHuntSuccess(seatDesc);
          return;
        }

        // 기본: 좌석선택완료 자동 클릭
        await wait(STEP_DELAY_MS);
        log(`[AUTO] ${finalSelected}매 선택 확인 → 좌석선택완료 클릭`);
        clickNext();
      });
    }
  }

  // =========================================================
  // CAPTCHA 보조
  // =========================================================
  function findCaptchaImg() {
    const sels = [
      'img[id*="captcha" i]', 'img[src*="captcha" i]', 'img[src*="Captcha"]',
      'img[src*="imgcert"]', 'img[src*="CaptchaImg"]',
      'img[alt*="보안" i]', 'img[alt*="자동입력" i]',
      'img[src*="SecurityCode"]', 'img[id*="cert" i]',
    ];
    for (const s of sels) { const el = document.querySelector(s); if (el) return el; }
    return null;
  }
  function findCaptchaInput() {
    const sels = [
      '#txtCaptcha',
      'input[id*="captcha" i]', 'input[name*="captcha" i]',
      'input[id*="cert" i]:not([type=hidden])',
      'input[name*="cert" i]:not([type=hidden])',
      'input[id*="security" i]', 'input[placeholder*="보안" i]',
      'input[placeholder*="자동입력" i]',
    ];
    for (const s of sels) { const el = document.querySelector(s); if (el) return el; }
    return null;
  }

  function initCaptcha(img, input) {
    log('CAPTCHA 감지', { img: !!img, input: !!input });

    if (input) {
      input.style.fontSize      = '22px';
      input.style.padding       = '10px 14px';
      input.style.border        = '2px solid #0af';
      input.style.borderRadius  = '6px';
      input.style.letterSpacing = '4px';
      input.style.fontFamily    = 'monospace';
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('autocapitalize', 'off');
      input.setAttribute('spellcheck', 'false');
      // IME 힌트 (브라우저별 효과 제한적 — 파이어폭스 등에서만 IME 차단 가능)
      input.setAttribute('lang', 'en');
      input.setAttribute('inputmode', 'latin');
      input.style.setProperty('ime-mode', 'disabled');
      input.style.setProperty('-webkit-ime-mode', 'disabled');
      input.style.setProperty('-moz-ime-mode', 'disabled');

      // 한글 → 영문 자판 변환 (두벌식). Korean IME 모드로 친 글자를 입력 시 자동 치환
      // 예: "ㅊㅁㅔ" → "cap", "챠" → "cho"
      const koToEn = (() => {
        const CHO  = 'rRseEfaqQtTdwWczxvg'.split('');
        const JUNG = ['k','o','i','O','j','p','u','P','h','hk','ho','hl','y','n','nj','np','nl','b','m','ml','l'];
        const JONG = ['','r','R','rt','s','sw','sg','e','f','fr','fa','fq','ft','fx','fv','fg','a','q','qt','t','T','d','w','c','z','x','v','g'];
        const JAMO = {'ㄱ':'r','ㄲ':'R','ㄴ':'s','ㄷ':'e','ㄸ':'E','ㄹ':'f','ㅁ':'a','ㅂ':'q','ㅃ':'Q','ㅅ':'t','ㅆ':'T','ㅇ':'d','ㅈ':'w','ㅉ':'W','ㅊ':'c','ㅋ':'z','ㅌ':'x','ㅍ':'v','ㅎ':'g','ㅏ':'k','ㅐ':'o','ㅑ':'i','ㅒ':'O','ㅓ':'j','ㅔ':'p','ㅕ':'u','ㅖ':'P','ㅗ':'h','ㅘ':'hk','ㅙ':'ho','ㅚ':'hl','ㅛ':'y','ㅜ':'n','ㅝ':'nj','ㅞ':'np','ㅟ':'nl','ㅠ':'b','ㅡ':'m','ㅢ':'ml','ㅣ':'l','ㄳ':'rt','ㄵ':'sw','ㄶ':'sg','ㄺ':'fr','ㄻ':'fa','ㄼ':'fq','ㄽ':'ft','ㄾ':'fx','ㄿ':'fv','ㅀ':'fg','ㅄ':'qt'};
        return (text) => {
          let r = '';
          for (const ch of text) {
            const c = ch.charCodeAt(0);
            if (c >= 0xAC00 && c <= 0xD7A3) {
              const o = c - 0xAC00;
              r += CHO[Math.floor(o / 588)] + JUNG[Math.floor((o % 588) / 28)] + JONG[o % 28];
            } else {
              r += JAMO[ch] ?? ch;
            }
          }
          return r;
        };
      })();

      // 한글 감지 정규식 (완성형 + 자모)
      const hasHangul = (s) => /[ㄱ-ㆎᄀ-ᇿ가-힣]/.test(s);
      // IME 조합 중에도 input 이벤트 발화 → guard 제거하고 즉시 변환
      // input.value 를 덮어쓰면 IME 조합이 자동 중단됨 (다음 키는 새 조합으로 시작)
      const convertIfNeeded = () => {
        const v = input.value;
        if (!hasHangul(v)) return;
        const converted = koToEn(v);
        if (converted === v) return;
        input.value = converted;
        input.setSelectionRange(converted.length, converted.length);
      };
      input.addEventListener('input', convertIfNeeded);
      input.addEventListener('compositionend', convertIfNeeded);
      // IME 가 compositionupdate 만 발화하고 input 은 안 터뜨리는 케이스 대비
      input.addEventListener('compositionupdate', () => setTimeout(convertIfNeeded, 0));

      // 페이지가 input 을 display:none 으로 숨겨둬서 focus 불가인 경우 → 강제 visible
      // ★ 중요: CAPTCHA 오버레이가 active 일 때만 동작. 해제 후엔 절대 DOM 건드리지 않음
      //   (이전 버전은 해제 후에도 guardObs 가 계속 style 바꿔서 후속 flow 에서
      //    '비정상 경로' 탐지 유발)
      const forceVisible = () => {
        if (!input.isConnected) return;
        if (!captchaActive()) return;
        input.style.setProperty('display', 'inline-block', 'important');
        input.style.setProperty('visibility', 'visible', 'important');
        input.style.setProperty('opacity', '1', 'important');
        const parent = input.parentElement;
        if (parent) {
          parent.querySelectorAll('span').forEach(sp => {
            if (/입력|문자|보안/.test(sp.textContent || '')) sp.style.display = 'none';
          });
        }
      };
      forceVisible();

      let focusedOnce = false;
      const tryFocus = () => {
        if (!input.isConnected) return;
        if (!captchaActive()) return;
        if (focusedOnce && document.activeElement === input) return;
        if (input.offsetParent === null) return;
        try { input.focus(); input.select(); } catch (_) {}
        if (document.activeElement === input) {
          if (!focusedOnce) log('CAPTCHA 입력란 focus 성공');
          focusedOnce = true;
        }
      };
      tryFocus();
      [50, 150, 400, 1000].forEach(d => setTimeout(tryFocus, d));

      // Guard observer — CAPTCHA 해제되면 즉시 disconnect (DOM 간섭 중단)
      const guardObs = new MutationObserver(() => {
        if (!captchaActive()) {
          guardObs.disconnect();
          log('CAPTCHA 해제 — DOM guard 중지');
          return;
        }
        if (input.style.display === 'none' || getComputedStyle(input).display === 'none') {
          forceVisible();
        }
        tryFocus();
      });
      guardObs.observe(input, { attributes: true, attributeFilter: ['style', 'class'] });
      let _p = input.parentElement;
      while (_p && _p !== document.documentElement) {
        guardObs.observe(_p, { attributes: true, attributeFilter: ['style', 'class'] });
        _p = _p.parentElement;
      }

      // Enter 제출 — Interpark 의 onkeydown="IsEnterGo()" 가 이미 처리하면 우리는 skip
      // (두 핸들러가 같이 fire 되면 fnCheck 이중 호출 → SeatBuffer ReferenceError)
      if (!input.getAttribute('onkeydown')) {
        input.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const captchaBtn = document.querySelector('.capchaBtns a, .capchaLayer a[onclick*="fnCheck" i], a[onclick*="fnCheck" i]');
          if (captchaBtn && captchaBtn.offsetParent !== null) {
            log('CAPTCHA 입력완료 클릭 (fallback)');
            captchaBtn.click();
          } else {
            warn('CAPTCHA 제출 버튼 못 찾음');
          }
        });
      } else {
        log('CAPTCHA input 에 네이티브 onkeydown 존재 — 자체 Enter 핸들러 skip');
      }
    }

    const banner = document.createElement('div');
    banner.style.cssText = [
      'position:fixed', 'top:0', 'left:50%', 'transform:translateX(-50%)',
      'z-index:2147483647', 'background:#0af', 'color:#fff',
      'padding:8px 20px', 'font:700 14px system-ui,-apple-system,sans-serif',
      'border-radius:0 0 8px 8px', 'box-shadow:0 2px 12px rgba(0,0,0,.3)'
    ].join(';');
    banner.textContent = '🔐 CAPTCHA 확대됨 · Enter 로 제출';
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 3500);
  }
})();
