// ==UserScript==
// @name         인터파크 KBO 예매 보조 (좌석/등급/CAPTCHA)
// @namespace    https://github.com/wodn5515/nol-kbo-helper
// @version      1.1.0
// @description  예매 팝업 보조 — 등급 필터, 좌석 시각화, 연속석 자동, CAPTCHA 한↔영 변환
// @match        https://poticket.interpark.com/*
// @match        https://*.interpark.com/*TMGS*
// @run-at       document-end
// @grant        none
// @all-frames   true
// @updateURL    https://raw.githubusercontent.com/wodn5515/nol-kbo-helper/master/seat-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/wodn5515/nol-kbo-helper/master/seat-helper.user.js
// ==/UserScript==

// ============================================================
// 인터파크 KBO 예매 팝업 보조
// ▶ 기능
//   [등급 리스트]  SEAT_GRADE_FILTER 키워드 포함 등급만 표시, 나머지 숨김
//   [좌석맵]       시각화(가능/매진/선택됨 구분) + HUD +
//                 연속 좌석 자동 선택 (TICKET_COUNT 매, 같은 행 양옆 균형)
//                 Q: 임의 연속석 자동 / E: hover클릭 / 클릭: 동료 자동 추가
//   [CAPTCHA]     이미지 확대 + 입력란 auto-focus + Enter 제출
//   [공통]        Enter = "다음" 버튼 클릭
// ============================================================

(() => {
  // ========== 설정 ==========
  const TICKET_COUNT       = 3;                                   // 매수 (연속석 자동 선택 수)
  const SEAT_GRADE_FILTER  = ['3루', '중앙'];                     // 포함 키워드 (OR, 부분일치) · 빈 배열 = 필터 없음
  const SEAT_GRADE_EXCLUDE = ['휠체어', '테이블'];  // 제외 키워드 (하나라도 포함 시 숨김) · 빈 배열 = 제외 없음
  const HIDE_SOLD_OUT      = false;                               // true 면 잔여석 0(rc="0") 등급도 숨김

  // 좌석 선호도 — Q 자동선택 우선순위 & 하이라이트 (비어있으면 선호 없음, 배열 앞쪽일수록 우선)
  // 주의: ci 값은 보통 0,2,4,6... 처럼 2씩 증가 (블럭 레이아웃에 따라 다름)
  const SEAT_PREFERENCE = {
    blocks:  [],  // 예: [413, 412] — 블럭 번호 (rg "413_4" 앞부분)
    rows:    [],                     // 예: [3, 4, 5, 6] — 행 인덱스 ri
    columns: [],              // 예: [0,2,4,6] — 열 인덱스 ci (좌→우 순서)
  };
  // ==========================

  if (window.__seat_helper_loaded__) { console.warn('[HELPER] 이미 로드됨'); return; }
  window.__seat_helper_loaded__ = true;

  const log  = (...a) => console.log('%c[HELPER]', 'color:#0af;font-weight:bold', ...a);
  const warn = (...a) => console.warn('%c[HELPER]', 'color:#fa0;font-weight:bold', ...a);

  // =========================================================
  // 공통: "다음" Enter 단축키
  // =========================================================
  function clickNext() {
    const sels = [
      'a[onclick*="NextStep"]', 'a[onclick*="fnNext"]', 'a[onclick*="goNext"]',
      'button[onclick*="NextStep"]', 'button[onclick*="fnNext"]',
      '.btn_next', '#btnNext', '.nextBtn', '[class*="btnNext"]',
      'input[value*="다음"]',
    ];
    const tryIn = (doc) => {
      for (const sel of sels) { try { const b = doc.querySelector(sel); if (b) { b.click(); return true; } } catch (_) {} }
      return false;
    };
    try { if (tryIn(document)) return true; } catch (_) {}
    try { if (window.parent && tryIn(window.parent.document)) return true; } catch (_) {}
    try { if (window.top && tryIn(window.top.document)) return true; } catch (_) {}
    warn('다음 버튼 못 찾음');
    return false;
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.target.matches?.('input, textarea, select')) clickNext();
  });

  // =========================================================
  // 공통: 예매안내 팝업 자동 닫기
  // (팝업 뜨는 순간 감지해서 closeBtn 클릭 — 짧게 뜨고 바로 사라짐)
  // =========================================================
  let lastNoticeDismiss = 0;
  const dismissBookNotice = () => {
    if (Date.now() - lastNoticeDismiss < 300) return; // 연속 호출 디바운스
    const layer = document.getElementById('divBookNoticeLayer');
    if (!layer) return;
    if (layer.offsetParent === null) return; // 이미 숨겨진 상태
    const close = layer.querySelector('.closeBtn');
    if (close) close.click();
    // closeBtn 없거나 click 안 먹을 때 fallback
    if (typeof window.fnBookNoticeShowHide === 'function') {
      try { window.fnBookNoticeShowHide(''); } catch (_) {}
    }
    lastNoticeDismiss = Date.now();
    log('예매안내 팝업 자동 닫힘');
  };
  dismissBookNotice(); // 로드 시점에 이미 떠있는 경우
  try {
    new MutationObserver(dismissBookNotice).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class']
    });
  } catch (_) {}

  // =========================================================
  // 모드 1: 등급 리스트 필터 (div.list > a[sgn])
  // =========================================================
  if (document.querySelector('div.list a[sgn]')) initGradeList();

  // =========================================================
  // 모드 2: 좌석맵 (img.stySeat)
  // =========================================================
  if (document.querySelector('img.stySeat')) initSeatMap();

  // =========================================================
  // 모드 3: CAPTCHA (동적 감지)
  // =========================================================
  let captchaInited = false;
  const tryInitCaptcha = () => {
    if (captchaInited) return;
    const img   = findCaptchaImg();
    const input = findCaptchaInput();
    if (!img && !input) return;
    captchaInited = true;
    initCaptcha(img, input);
  };
  tryInitCaptcha();
  try {
    new MutationObserver(tryInitCaptcha).observe(document.documentElement, { childList: true, subtree: true });
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

        const matchInc  = SEAT_GRADE_FILTER.length === 0 || SEAT_GRADE_FILTER.some(kw => sgn.includes(kw));
        const matchExc  = SEAT_GRADE_EXCLUDE.length === 0 || !SEAT_GRADE_EXCLUDE.some(kw => sgn.includes(kw));
        const matchSold = !HIDE_SOLD_OUT || rc > 0;
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
        include: SEAT_GRADE_FILTER, exclude: SEAT_GRADE_EXCLUDE
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
    if (SEAT_GRADE_FILTER.length)  parts.push(`포함: ${SEAT_GRADE_FILTER.join(',')}`);
    if (SEAT_GRADE_EXCLUDE.length) parts.push(`제외: ${SEAT_GRADE_EXCLUDE.join(',')}`);
    if (HIDE_SOLD_OUT)             parts.push('매진숨김');
    banner.textContent = parts.length ? `🔎 등급 필터 · ${parts.join(' · ')}` : '🔎 등급 필터 비활성';
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 3000);
  }

  // =========================================================
  // 좌석맵
  // =========================================================
  function initSeatMap() {
    let hoverClickOn = false;

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
        `<div style="color:#fff;font-size:11px;margin-bottom:4px">🏟 좌석 보조 · ${TICKET_COUNT}매</div>`,
        `<div>전체 ${total} / 가능 ${avail} / 선택 ${sel}</div>`,
        `<div style="margin-top:10px;font-size:11px;color:#888;line-height:1.7">`,
        `[Q] 임의 ${TICKET_COUNT}매 연속<br>`,
        `[E] Hover클릭 ${hoverClickOn ? 'ON' : 'off'}<br>`,
        `[클릭] 연속 ${TICKET_COUNT}매 자동<br>`,
        `[Enter] 다음/확인`,
        `</div>`,
      ].join('');
    };
    setInterval(renderHud, 400);
    renderHud();

    const selectGroup = (group) => {
      let ok = 0;
      for (const s of group) {
        if (isSelected(s)) continue;
        if (clickSeat(s)) ok++;
      }
      return ok;
    };

    // 선호도 스코어링 (SEAT_PREFERENCE 기반)
    const prefActive = SEAT_PREFERENCE.blocks.length + SEAT_PREFERENCE.rows.length + SEAT_PREFERENCE.columns.length > 0;
    const scoreSeat = (seat) => {
      const sid = seatSID(seat);
      const ov  = sid ? overlayOfSID(sid) : null;
      if (!ov) return 0;
      const ri  = ov.getAttribute('ri');   // 문자열 그대로 비교 (DOM 속성은 항상 string)
      const ci  = ov.getAttribute('ci');
      const blk = (ov.getAttribute('rg') || '').split('_')[0];
      // 설정값이 숫자로 들어와도 DOM 속성(문자열)과 맞게 양쪽 String 정규화
      const rank = (list, val, base) => {
        if (!list || !list.length) return 0;
        const strVal = String(val);
        const i = list.findIndex(x => String(x) === strVal);
        return i >= 0 ? base * (list.length - i) : 0;
      };
      return rank(SEAT_PREFERENCE.blocks,  blk, 10000)
           + rank(SEAT_PREFERENCE.rows,    ri,    100)
           + rank(SEAT_PREFERENCE.columns, ci,      1);
    };

    // 선호 좌석 하이라이트 (주기적 갱신 — 매진/선택 상태 변화 반영)
    const applyPreferredHighlight = () => {
      allSeats().forEach(s => s.removeAttribute('data-preferred'));
      if (!prefActive) return;
      allSeats().forEach(s => {
        if (isAvailable(s) && scoreSeat(s) > 0) s.setAttribute('data-preferred', '1');
      });
    };
    applyPreferredHighlight();
    setInterval(applyPreferredHighlight, 800);

    // Q: 선호 좌석 우선, 연속 N매 가능한 첫 자리 선택
    const autoPick = () => {
      let candidates = allSeats().filter(isAvailable);
      if (prefActive) {
        candidates = candidates
          .map(s => ({ s, sc: scoreSeat(s) }))
          .sort((a, b) => b.sc - a.sc)
          .map(x => x.s);
      }
      for (const s of candidates) {
        const group = findCompanions(s, TICKET_COUNT);
        if (group.length >= TICKET_COUNT) {
          selectGroup(group);
          const tag = prefActive ? ` (score=${scoreSeat(s)})` : '';
          log(`✅ ${group.length}매 선택${tag}: ${group.map(x => x.getAttribute('title') || x.getAttribute('seatinfo') || '').join(' | ')}`);
          return true;
        }
      }
      warn('연속 빈자리 없음');
      return false;
    };

    // 유저 클릭 → 동료 좌석 자동 추가
    let clickToken = 0;
    document.addEventListener('click', (e) => {
      const seat = e.target?.closest?.('img.stySeat');
      if (!seat) return;
      if (!seat.getAttribute('onclick')) return;
      const my = ++clickToken;
      setTimeout(() => {
        if (my !== clickToken) return;
        if (TICKET_COUNT <= 1) return;
        const selectedNow = allSeats().filter(isSelected);
        if (selectedNow.length !== 1) return;
        if (!isSelected(seat)) return;
        const group = findCompanions(seat, TICKET_COUNT);
        if (group.length < TICKET_COUNT) {
          warn(`같은 행에 ${TICKET_COUNT}칸 연속 없음 (단일 유지)`);
          return;
        }
        selectGroup(group);
        log(`👥 연속석 자동: ${group.length}매`);
      }, 150);
    }, true);

    // hover 미리보기 + hover-click
    document.addEventListener('mouseover', (e) => {
      const seat = e.target?.closest?.('img.stySeat');
      if (!seat) return;
      if (hoverClickOn && isAvailable(seat)) { clickSeat(seat); return; }
      if (TICKET_COUNT < 2) return;
      if (!isAvailable(seat)) return;
      if (allSeats().some(isSelected)) return;
      const group = findCompanions(seat, TICKET_COUNT);
      if (group.length >= TICKET_COUNT) {
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

    log(`좌석 보조 활성화 · 매수=${TICKET_COUNT}`);
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
      const forceVisible = () => {
        if (!input.isConnected) return;
        // 1) inline display:none 제거 + !important 로 visible 강제
        input.style.setProperty('display', 'inline-block', 'important');
        input.style.setProperty('visibility', 'visible', 'important');
        input.style.setProperty('opacity', '1', 'important');
        // 2) 같은 컨테이너(.validationTxt 등) 의 placeholder span 숨김 (겹침 방지)
        const parent = input.parentElement;
        if (parent) {
          parent.querySelectorAll('span').forEach(sp => {
            if (/입력|문자|보안/.test(sp.textContent || '')) sp.style.display = 'none';
          });
        }
      };
      forceVisible();

      // focus (강제로 보이게 한 뒤 시도)
      let focusedOnce = false;
      const tryFocus = () => {
        if (!input.isConnected) return;
        if (focusedOnce && document.activeElement === input) return;
        if (input.offsetParent === null) return; // 아직 렌더링 안됨
        try { input.focus(); input.select(); } catch (_) {}
        if (document.activeElement === input) {
          if (!focusedOnce) log('CAPTCHA 입력란 focus 성공');
          focusedOnce = true;
        }
      };
      tryFocus();
      [50, 150, 400, 1000].forEach(d => setTimeout(tryFocus, d));

      // 페이지 JS 가 display 다시 none 으로 되돌리는 경우 대비 → 감시해서 계속 visible 유지
      const guardObs = new MutationObserver(() => {
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

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const submitSels = [
            'button[type="submit"]', 'input[type="submit"]',
            'a[onclick*="submit" i]', 'a[onclick*="confirm" i]',
            '.btn_ok', '.btn_confirm', '#btnOk', '#btnConfirm',
            'a[onclick*="fnNext"]', '.btn_next',
          ];
          for (const s of submitSels) { const b = document.querySelector(s); if (b) { b.click(); return; } }
          warn('제출 버튼 못 찾음');
        }
      });
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
