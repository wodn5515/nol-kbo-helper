// ==UserScript==
// @name         인터파크 KBO 예매 보조 (좌석/등급/CAPTCHA)
// @namespace    https://github.com/wodn5515/nol-kbo-helper
// @version      1.1.6
// @description  예매 팝업 보조 — 등급 필터, 좌석 시각화, 연속석 자동, CAPTCHA 한↔영 변환
// @match        https://poticket.interpark.com/*
// @match        https://*.interpark.com/*TMGS*
// @match        https://ticket.interpark.com/Contents/Sports/*
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
    CAPTCHA_SCALE:      2,         // (현재 미사용) CAPTCHA 확대 배율
    SEAT_PREFERENCE: {
      blocks:  [],  // 블럭 번호 (rg "413_4" 앞부분)
      rows:    [],  // 행 인덱스 ri
      columns: [],  // 열 인덱스 ci (좌→우 순서)
    },
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
    };
  };
  const S = loadSettings();
  // ========================================================================

  if (window.__seat_helper_loaded__) { console.warn('[HELPER] 이미 로드됨'); return; }
  window.__seat_helper_loaded__ = true;

  const log  = (...a) => console.log('%c[HELPER]', 'color:#0af;font-weight:bold', ...a);
  const warn = (...a) => console.warn('%c[HELPER]', 'color:#fa0;font-weight:bold', ...a);

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
      <hr style="border:0;border-top:1px solid #333;margin:16px 0">
      <div style="font-size:13px;color:#aaa;margin-bottom:10px">좌석 선호도 (Q 자동선택 우선순위)</div>
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
      const next = {
        TICKET_COUNT:       Math.max(1, parseInt($('__s_ticket__').value, 10) || 1),
        SEAT_GRADE_FILTER:  parseList($('__s_finc__').value, false),
        SEAT_GRADE_EXCLUDE: parseList($('__s_fexc__').value, false),
        HIDE_SOLD_OUT:      $('__s_sold__').checked,
        CAPTCHA_SCALE:      S.CAPTCHA_SCALE,
        SEAT_PREFERENCE: {
          blocks:  parseList($('__s_blks__').value, true),
          rows:    parseList($('__s_rows__').value, true),
          columns: parseList($('__s_cols__').value, true),
        },
      };
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
  // =========================================================

  // =========================================================
  // 공통: "다음" Enter 단축키
  // =========================================================
  // 다음/확인 버튼 후보 텍스트 (라벨 기반 fallback)
  const NEXT_LABELS = ['다음', '다음단계', '좌석선택완료', '결제하기', '확인', '입력완료', '예매하기', '완료', '동의'];

  function findNextIn(doc) {
    const sels = [
      'a[onclick*="NextStep" i]', 'a[onclick*="fnNext" i]', 'a[onclick*="goNext" i]',
      'a[onclick*="fnCheck" i]', 'a[onclick*="fnSubmit" i]',
      'button[onclick*="NextStep" i]', 'button[onclick*="fnNext" i]',
      '.btn_next', '#btnNext', '.nextBtn', '[class*="btnNext"]', '[class*="BtnNext"]',
      'a.btn_next', 'a.next', 'a.nextStep', 'a.btnOk', 'a.btn_ok',
      'input[type="button"][value*="다음"]', 'input[type="submit"][value*="다음"]',
      'input[type="image"][alt*="다음"]', 'input[type="image"][src*="next" i]',
    ];
    for (const sel of sels) {
      try { const b = doc.querySelector(sel); if (b && b.offsetParent !== null) return { el: b, via: `sel:${sel}` }; } catch (_) {}
    }
    // 텍스트 기반 fallback — visible 한 clickable 요소 중 NEXT_LABELS 와 일치
    const candidates = doc.querySelectorAll('a, button, input[type="button"], input[type="submit"]');
    for (const el of candidates) {
      if (el.offsetParent === null) continue;
      const text = ((el.textContent || el.value || '') + '').replace(/\s+/g, '').trim();
      if (NEXT_LABELS.includes(text)) return { el, via: `text:${text}` };
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
          // href="javascript:..." 인 a 태그는 click() 이 안 먹을 수 있어 onclick 직접 실행 fallback
          const onclickAttr = hit.el.getAttribute('onclick');
          if (onclickAttr) { try { (0, eval)(onclickAttr); } catch (_) {} }
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

    const selectGroup = (group) => {
      let ok = 0;
      for (const s of group) {
        if (isSelected(s)) continue;
        if (clickSeat(s)) ok++;
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
    const autoPick = () => {
      const avail = allSeats().filter(isAvailable);
      let candidates = prefActive ? avail.filter(matchesPreference) : avail;

      if (prefActive && candidates.length === 0) {
        warn(`선호 조건 매칭 좌석 없음 — blocks=${JSON.stringify(S.SEAT_PREFERENCE.blocks)} rows=${JSON.stringify(S.SEAT_PREFERENCE.rows)} columns=${JSON.stringify(S.SEAT_PREFERENCE.columns)}`);
        return false;
      }

      if (prefActive) {
        candidates = candidates
          .map(s => ({ s, sc: scoreSeat(s) }))
          .sort((a, b) => b.sc - a.sc)
          .map(x => x.s);
      }

      for (const s of candidates) {
        const group = findCompanions(s, S.TICKET_COUNT);
        if (group.length >= S.TICKET_COUNT) {
          selectGroup(group);
          const tag = prefActive ? ` (AND match, score=${scoreSeat(s)})` : '';
          log(`✅ ${group.length}매 선택${tag}: ${group.map(x => x.getAttribute('title') || x.getAttribute('seatinfo') || '').join(' | ')}`);
          return true;
        }
      }
      warn(prefActive ? '매칭 좌석 중 연속 N칸 가능한 자리 없음' : '연속 빈자리 없음');
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
        if (S.TICKET_COUNT <= 1) return;
        const selectedNow = allSeats().filter(isSelected);
        if (selectedNow.length !== 1) return;
        if (!isSelected(seat)) return;
        const group = findCompanions(seat, S.TICKET_COUNT);
        if (group.length < S.TICKET_COUNT) {
          warn(`같은 행에 ${S.TICKET_COUNT}칸 연속 없음 (단일 유지)`);
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
