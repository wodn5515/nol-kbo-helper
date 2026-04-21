// ==UserScript==
// @name         인터파크 KBO 예매 자동화
// @namespace    https://github.com/wodn5515/nol-kbo-helper
// @version      1.1.1
// @description  인터파크 KBO 구단 페이지 — 오픈 시각 자동 감지 후 예매 버튼 고속 클릭
// @match        https://ticket.interpark.com/Contents/Sports/GoodsInfo*
// @run-at       document-end
// @grant        none
// @updateURL    https://raw.githubusercontent.com/wodn5515/nol-kbo-helper/master/interpark-autoclick.user.js
// @downloadURL  https://raw.githubusercontent.com/wodn5515/nol-kbo-helper/master/interpark-autoclick.user.js
// ==/UserScript==

// ============================================================
// 인터파크 KBO 예매 자동화
// ▶ 설치
//   Tampermonkey 대시보드 → + → 이 파일 전체 붙여넣기 → 저장
// ▶ 사용
//   1) 인터파크 KBO 구단 페이지 접속 & 로그인
//   2) 우측 상단 패널 → 경기 날짜 입력 → [시작]
//   3) 오픈 시각 자동 감지 → 대기 → 폴링 → 발사
// ▶ 전략
//   POST /Contents/Sports/GoodsInfoList 직통 호출 → .timeSchedule 파싱 →
//   판매예정 텍스트("MM월 DD일 HH시 오픈")에서 오픈 시각 자동 추출 →
//   T-2s 100ms / T-1s 50ms 2단 폴링 → Y 플립 순간 onclick 직접 eval
// ============================================================

(() => {
  // ========== 고급 설정 ==========
  const AJAX_URL              = '/Contents/Sports/GoodsInfoList';
  const AJAX_PAGE_SIZE        = 30;
  const POLL_LEAD_MS          = 2000;   // T-2s 부터 폴링 시작
  const POLL_INTERVAL_MS      = 0;      // 간격 없음 — 응답 즉시 다음 요청 (RTT 가 자연 간격)
  const POLL_TIMEOUT_MS       = 120_000;
  const KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000;
  const AUTO_FIRE             = true;
  const LS_KEY_DATE           = 'interpark_autoclick_target_date';
  const LS_KEY_AUTOSTART      = 'interpark_autoclick_autostart';
  // ================================

  // 중복 실행 방지
  if (window.__interpark_autoclick_loaded__) { console.warn('[AUTO] 이미 로드됨'); return; }
  window.__interpark_autoclick_loaded__ = true;

  // ---- 로깅 ---------------------------------------------------------------
  const log  = (...a) => console.log('%c[AUTO]', 'color:#0af;font-weight:bold', ...a);
  const warn = (...a) => console.warn('%c[AUTO]', 'color:#fa0;font-weight:bold', ...a);
  const err  = (...a) => console.error('%c[AUTO]', 'color:#f44;font-weight:bold', ...a);

  // ---- 서버 시간 동기화 ----------------------------------------------------
  async function measureServerOffset(samples = 5) {
    const rs = [];
    for (let i = 0; i < samples; i++) {
      const t0 = performance.now();
      try {
        const r = await fetch(location.href, { method: 'HEAD', cache: 'no-store' });
        const t1 = performance.now();
        const dh = r.headers.get('Date');
        if (!dh) continue;
        const rtt = t1 - t0;
        const serverAtRecv = new Date(dh).getTime() + rtt / 2;
        const localAtRecv  = Date.now() - (performance.now() - t1);
        rs.push({ offset: serverAtRecv - localAtRecv, rtt });
      } catch (_) {}
    }
    if (!rs.length) return 0;
    rs.sort((a, b) => a.rtt - b.rtt);
    log(`서버 오프셋: ${Math.round(rs[0].offset)}ms (RTT ${Math.round(rs[0].rtt)}ms, n=${rs.length})`);
    return rs[0].offset;
  }

  // ---- GoodsInfoList AJAX --------------------------------------------------
  function getCodes() {
    const q = new URLSearchParams(location.search);
    const sportsCode = (document.getElementById('SportsCode')?.value) || q.get('SportsCode') || '';
    const teamCode   = (document.getElementById('TeamCode')?.value)   || q.get('TeamCode')   || '';
    return { sportsCode, teamCode };
  }

  async function fetchScheduleDoc() {
    const { sportsCode, teamCode } = getCodes();
    if (!sportsCode || !teamCode) throw new Error('SportsCode/TeamCode 가져오기 실패');
    const body = new URLSearchParams({
      SportsCode: sportsCode,
      TeamCode:   teamCode,
      Page:       '0',
      PageSize:   String(AJAX_PAGE_SIZE),
    }).toString();
    const res = await fetch(AJAX_URL, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept':           'text/html, */*; q=0.01',
      },
      body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return new DOMParser().parseFromString(html, 'text/html');
  }

  // ---- 타겟 경기 찾기 ------------------------------------------------------
  function findScheduleInDoc(doc, targetMM, targetDD) {
    const blocks = doc.querySelectorAll('.timeSchedule');
    for (const el of blocks) {
      const digits = Array.from(el.querySelectorAll('.scheduleDate .num')).map(n => {
        if (n.classList.contains('dot')) return '.';
        const m = n.className.match(/num(\d)/);
        return m ? m[1] : '';
      }).join('');
      const [mmStr, ddStr] = digits.split('.');
      if (!mmStr || !ddStr) continue;
      if (parseInt(mmStr, 10) !== targetMM || parseInt(ddStr, 10) !== targetDD) continue;

      const bookBtn = el.querySelector('a[onclick*="SportsBooking"]');
      if (bookBtn) return { state: 'open', onclick: bookBtn.getAttribute('onclick') };

      const pending = el.querySelector('.BtnColor_P');
      if (pending) {
        const txt = (pending.textContent || '').replace(/\s+/g, ' ').trim();
        const m = txt.match(/(\d+)월\s*(\d+)일\s*(\d+)시(?:\s*(\d+)분)?/);
        if (m) {
          return {
            state: 'pending',
            openAt: { month: +m[1], day: +m[2], hour: +m[3], minute: +(m[4] || 0) }
          };
        }
      }
      return { state: 'unknown' };
    }
    return null;
  }

  // ---- 시각 유틸 ------------------------------------------------------------
  function toLocalDate(month, day, hour, minute) {
    const now = new Date();
    let year = now.getFullYear();
    const cand = new Date(year, month - 1, day, hour, minute, 0);
    if (cand.getTime() < now.getTime() - 24 * 3600 * 1000) year++;
    return new Date(year, month - 1, day, hour, minute, 0);
  }

  function scheduleAt(targetLocalMs, cb) {
    const delay = targetLocalMs - Date.now();
    setTimeout(() => {
      const tick = () => {
        if (Date.now() >= targetLocalMs) cb();
        else requestAnimationFrame(tick);
      };
      tick();
    }, Math.max(0, delay - 50));
  }

  // ---- 패널 UI -------------------------------------------------------------
  function ensurePanel() {
    let p = document.getElementById('__ap_panel__');
    if (p) return p;
    p = document.createElement('div');
    p.id = '__ap_panel__';
    p.style.cssText = [
      'position:fixed', 'top:80px', 'right:20px', 'z-index:2147483647',
      'background:#1a1a1a', 'color:#eee',
      'border-radius:12px', 'padding:16px',
      'font:14px system-ui,-apple-system,sans-serif',
      'box-shadow:0 8px 32px rgba(0,0,0,.5)',
      'min-width:280px', 'border:1px solid #333'
    ].join(';');
    document.body.appendChild(p);
    return p;
  }

  let countdownTimer = null;
  function stopCountdown() { if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; } }

  function renderSetup() {
    stopCountdown();
    const p = ensurePanel();
    const saved    = localStorage.getItem(LS_KEY_DATE) || '';
    const autoOn   = localStorage.getItem(LS_KEY_AUTOSTART) === '1';
    p.innerHTML = `
      <div style="font-weight:700;font-size:15px;margin-bottom:12px">⚾ KBO 예매 자동화</div>
      <label style="display:block;margin-bottom:4px;font-size:12px;color:#aaa">경기 날짜</label>
      <input id="__ap_date__" type="date" value="${saved}"
        style="width:100%;padding:8px;border:1px solid #444;background:#0d0d0d;color:#fff;border-radius:6px;font-size:14px;box-sizing:border-box;margin-bottom:10px">
      <label style="display:flex;align-items:center;gap:6px;margin-bottom:10px;font-size:12px;color:#aaa;cursor:pointer">
        <input id="__ap_auto__" type="checkbox" ${autoOn ? 'checked' : ''}> 다음 새로고침부터 자동 시작
      </label>
      <button id="__ap_start__"
        style="width:100%;padding:12px;background:#0a8;color:#fff;border:0;border-radius:8px;font-weight:700;font-size:15px;cursor:pointer">
        시작
      </button>
      <div style="margin-top:10px;font-size:11px;color:#888;line-height:1.5">
        오픈 시각은 자동 감지됨.<br>탭 포그라운드 유지 권장.
      </div>
    `;
    document.getElementById('__ap_start__').onclick = () => {
      const date = document.getElementById('__ap_date__').value;
      const auto = document.getElementById('__ap_auto__').checked;
      if (!date) { alert('날짜를 입력해주세요'); return; }
      localStorage.setItem(LS_KEY_DATE, date);
      localStorage.setItem(LS_KEY_AUTOSTART, auto ? '1' : '0');
      run(date).catch(e => err('실행 오류:', e));
    };
  }

  function renderStatus(html, bg = '#333') {
    stopCountdown();
    const p = ensurePanel();
    p.innerHTML = `
      <div style="padding:16px;background:${bg};color:#fff;text-align:center;border-radius:8px;font-weight:600">
        ${html}
      </div>
      <button id="__ap_reset__" style="margin-top:8px;width:100%;padding:6px;background:transparent;color:#888;border:1px solid #444;border-radius:6px;font-size:11px;cursor:pointer">설정으로 돌아가기</button>
    `;
    document.getElementById('__ap_reset__').onclick = () => { stopKeepalive(); fired = false; renderSetup(); };
  }

  function renderWaiting(openLocal) {
    stopCountdown();
    const p = ensurePanel();
    p.innerHTML = `
      <div style="font-size:12px;color:#aaa;margin-bottom:4px">오픈까지</div>
      <div id="__ap_countdown__" style="font:700 28px/1 monospace;color:#0f0;text-align:center;margin:8px 0">--:--:--</div>
      <div style="font-size:12px;color:#aaa;text-align:center">${openLocal.toLocaleString()}</div>
      <div id="__ap_subst__" style="margin-top:10px;font-size:11px;color:#888;text-align:center">세션 유지 중</div>
      <button id="__ap_reset__" style="margin-top:10px;width:100%;padding:6px;background:transparent;color:#888;border:1px solid #444;border-radius:6px;font-size:11px;cursor:pointer">취소 / 재설정</button>
    `;
    document.getElementById('__ap_reset__').onclick = () => { stopKeepalive(); stopCountdown(); renderSetup(); };
    const update = () => {
      const remain = openLocal.getTime() - Date.now();
      const el = document.getElementById('__ap_countdown__');
      if (!el) { stopCountdown(); return; }
      if (remain <= 0) { el.textContent = '00:00:00'; return; }
      const h = Math.floor(remain / 3600000);
      const m = Math.floor((remain % 3600000) / 60000);
      const s = Math.floor((remain % 60000) / 1000);
      el.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    };
    update();
    countdownTimer = setInterval(update, 500);
  }

  function renderArmed(onclickStr) {
    stopCountdown();
    const p = ensurePanel();
    p.innerHTML = `
      <button id="__ap_fire__" style="width:100%;padding:24px;background:#e33;color:#fff;border:0;border-radius:10px;font-weight:800;font-size:22px;cursor:pointer;animation:pulse 0.6s ease-in-out infinite alternate">
        🔥 발사 (클릭!)
      </button>
      <style>@keyframes pulse{from{transform:scale(1)}to{transform:scale(1.05)}}</style>
    `;
    document.getElementById('__ap_fire__').onclick = () => fire(onclickStr, 'manual');
  }

  function renderFired() {
    stopCountdown();
    const p = ensurePanel();
    p.innerHTML = `
      <div style="padding:18px;background:#2a2;color:#fff;text-align:center;font-weight:700;border-radius:8px;font-size:16px">
        ✅ 발사 완료
      </div>
      <button id="__ap_reset__" style="margin-top:8px;width:100%;padding:6px;background:transparent;color:#888;border:1px solid #444;border-radius:6px;font-size:11px;cursor:pointer">새로 시작</button>
    `;
    document.getElementById('__ap_reset__').onclick = () => { fired = false; renderSetup(); };
  }

  // ---- 발사 ---------------------------------------------------------------
  let fired = false;
  function fire(onclickStr, via) {
    if (fired) return;
    log(`🔥 발사 [${via}] → ${onclickStr}`);
    try {
      (0, eval)(onclickStr);
      fired = true;
      renderFired();
    } catch (e) {
      err('호출 실패:', e);
    }
  }
  function onOpen(sched, tag) {
    if (fired) return;
    log(`시그 획득 [${tag}] @ ${new Date().toISOString()}`);
    renderArmed(sched.onclick);
    if (AUTO_FIRE) fire(sched.onclick, 'auto');
  }

  // ---- Keep-alive ---------------------------------------------------------
  let keepaliveTimer = null;
  function startKeepalive() {
    if (keepaliveTimer) return;
    const ping = async () => {
      try {
        const { sportsCode, teamCode } = getCodes();
        const body = new URLSearchParams({
          SportsCode: sportsCode, TeamCode: teamCode, Page: '0', PageSize: '1'
        }).toString();
        const r = await fetch(AJAX_URL, {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: {
            'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            'Accept':           'text/html, */*; q=0.01',
          },
          body,
        });
        log(`[keepalive] ${r.status} @ ${new Date().toLocaleTimeString()}`);
      } catch (e) {
        warn(`[keepalive] ${e.message}`);
      }
    };
    keepaliveTimer = setInterval(ping, KEEPALIVE_INTERVAL_MS);
    log(`keep-alive 시작 (${KEEPALIVE_INTERVAL_MS/60000}분 간격)`);
  }
  function stopKeepalive() {
    if (!keepaliveTimer) return;
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
    log('keep-alive 중지');
  }

  // ---- 폴링 루프 -----------------------------------------------------------
  // T-2s 부터 `응답 → 즉시 다음` 방식. inflight 가드로 순차 실행, 간격 0ms.
  function startPolling(targetMM, targetDD, targetLocalMs) {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let attempts = 0, inflight = false;

    const step = async () => {
      if (fired) return;
      if (!inflight) {
        inflight = true; attempts++;
        try {
          const doc = await fetchScheduleDoc();
          if (fired) return;
          const s = findScheduleInDoc(doc, targetMM, targetDD);
          if (s && s.state === 'open') { onOpen(s, `ajax#${attempts}`); return; }
        } catch (e) {
          if (attempts % 10 === 1) warn(`폴링 오류: ${e.message}`);
        } finally { inflight = false; }
      }
      if (fired) return;
      if (Date.now() >= deadline) {
        err(`${POLL_TIMEOUT_MS/1000}s 폴링 실패 (시도 ${attempts}회)`);
        renderStatus('⚠️ 폴링 실패<br><span style="font-size:11px">콘솔 확인</span>', '#c33');
        return;
      }
      setTimeout(step, POLL_INTERVAL_MS);
    };
    step();
  }

  // ---- 메인 ---------------------------------------------------------------
  async function run(targetGameDate) {
    if (typeof window.SportsBooking !== 'function') {
      err('이 페이지엔 SportsBooking 함수가 없습니다. GoodsInfo 페이지에서 실행하세요.');
      renderStatus('⚠️ GoodsInfo 페이지에서 실행 필요', '#c33');
      return;
    }
    const m = targetGameDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!m) { renderStatus(`⚠️ 날짜 형식 오류: ${targetGameDate}`, '#c33'); return; }
    const targetMM = +m[2], targetDD = +m[3];

    const { sportsCode, teamCode } = getCodes();
    log(`SportsCode=${sportsCode}, TeamCode=${teamCode}, 타겟=${targetMM}.${targetDD}`);
    renderStatus('🔍 스케줄 확인 중');

    // (1) 라이브 DOM → (2) AJAX 확인
    let sched = findScheduleInDoc(document, targetMM, targetDD);
    log(`라이브 DOM: ${sched ? sched.state : '경기 없음'}`);
    if (!sched || sched.state === 'pending' || sched.state === 'unknown') {
      try {
        const doc = await fetchScheduleDoc();
        const s2 = findScheduleInDoc(doc, targetMM, targetDD);
        log(`AJAX: ${s2 ? s2.state : '경기 없음'}`);
        if (s2) sched = s2;
      } catch (e) { warn(`AJAX 초기 로드 실패: ${e.message}`); }
    }

    if (!sched) {
      renderStatus(`⚠️ ${targetMM}.${targetDD} 경기 없음<br><span style="font-size:11px">PageSize=${AJAX_PAGE_SIZE} 넘어간 경기일 수 있음</span>`, '#c33');
      return;
    }
    if (sched.state === 'open')    { onOpen(sched, 'initial'); return; }
    if (sched.state !== 'pending') { renderStatus('⚠️ 상태 불명', '#c33'); return; }

    // (3) 판매예정 → 오픈 시각까지 대기 후 폴링
    const { month, day, hour, minute } = sched.openAt;
    const openLocal = toLocalDate(month, day, hour, minute);
    log(`오픈 시각: ${month}월 ${day}일 ${hour}시${minute ? ` ${minute}분` : ''} → ${openLocal.toLocaleString()}`);

    const offset = await measureServerOffset(5);
    const targetLocalMs = openLocal.getTime() - offset;
    const until = targetLocalMs - Date.now();
    if (until < -60_000) {
      renderStatus('⚠️ 오픈 시각 지남 / 새로고침', '#c33');
      return;
    }

    renderWaiting(openLocal);
    log(`T-${Math.round(until/1000)}s 대기 → T-${POLL_LEAD_MS}ms 부터 간격 ${POLL_INTERVAL_MS}ms 폴링`);
    if (until > KEEPALIVE_INTERVAL_MS) startKeepalive();

    scheduleAt(targetLocalMs - POLL_LEAD_MS, () => {
      stopKeepalive();
      log('📡 폴링 개시');
      renderStatus('📡 폴링 중...', '#f80');
      startPolling(targetMM, targetDD, targetLocalMs);
    });
  }

  // ---- 부팅 ---------------------------------------------------------------
  const savedDate    = localStorage.getItem(LS_KEY_DATE);
  const autoStart    = localStorage.getItem(LS_KEY_AUTOSTART) === '1';
  if (savedDate && autoStart) {
    log(`자동 시작 (저장된 날짜: ${savedDate})`);
    run(savedDate).catch(e => err('실행 오류:', e));
  } else {
    renderSetup();
  }
})();
