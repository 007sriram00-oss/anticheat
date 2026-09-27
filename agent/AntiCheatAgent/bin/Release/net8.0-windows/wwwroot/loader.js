'use strict';

/* ============================================================
   Tournament Anti-Cheat — agent UI controller
   Talks to the WPF host through the WebView2 bridge.
   ============================================================ */

const $ = (s, root) => (root || document).querySelector(s);

const bridge = {
  post: (obj) => {
    try { window.chrome?.webview?.postMessage(obj); } catch (e) { console.error(e); }
  },
  on: (fn) => window.chrome?.webview?.addEventListener('message', (ev) => fn(ev.data)),
};

const state = {
  pin: '',
  playerName: '',
  portal: 'http://127.0.0.1:3000',
  auto: false,
  session: null,
  targetPct: 0,
  shownPct: 0,
  animTimer: null,
  countdownTimer: null,
};

/* ------------------------------------------------ screen switch */

function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const el = document.getElementById(id);
  el.classList.add('active');
  // restart entrance animation
  el.style.animation = 'none';
  void el.offsetHeight;
  el.style.animation = '';
}

/* --------------------------------------------------- formatting */

function formatPin(raw) {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

/* ------------------------------------------------ portal status */

async function checkPortal() {
  const dot = $('#portal-dot');
  const status = $('#portal-status');
  $('#portal-url').textContent = state.portal.replace(/^https?:\/\//, '');
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${state.portal}/api/agent/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error('bad status');
    dot.className = 'dot up';
    status.className = 'status up';
    status.textContent = 'connected';
    return true;
  } catch {
    dot.className = 'dot down';
    status.className = 'status down';
    status.textContent = 'offline — check portal';
    return false;
  }
}

/* ------------------------------------------------ pin screen */

function initPinScreen() {
  const pinInput = $('#pin');
  const playerInput = $('#player');
  const err = $('#pin-error');

  if (state.pin) {
    pinInput.value = formatPin(state.pin);
  }
  if (state.playerName) playerInput.value = state.playerName;

  pinInput.addEventListener('input', () => {
    pinInput.value = formatPin(pinInput.value);
    err.hidden = true;
  });
  pinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-continue').click(); });
  playerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-continue').click(); });

  $('#btn-continue').addEventListener('click', async () => {
    const pin = formatPin(pinInput.value);
    if (pin.replace('-', '').length < 8) {
      err.textContent = 'Enter the full 8-character PIN (XXXX-XXXX).';
      err.hidden = false;
      return;
    }

    const btn = $('#btn-continue');
    btn.disabled = true;
    $('.btn-label', btn).textContent = 'Checking PIN…';
    $('.spinner', btn).hidden = false;
    err.hidden = true;

    state.pin = pin;
    state.playerName = playerInput.value.trim();

    // ask host to validate; the reply arrives via bridge
    bridge.post({ type: 'continue', pin, playerName: state.playerName });

    // safety timeout if host never replies
    setTimeout(() => {
      if (btn.disabled && $('#screen-pin').classList.contains('active')) {
        btn.disabled = false;
        $('.btn-label', btn).textContent = 'Continue';
        $('.spinner', btn).hidden = true;
        err.textContent = 'No response from the agent host — try again.';
        err.hidden = false;
      }
    }, 20000);
  });
}

/* ------------------------------------------------ consent screen */

function initConsentScreen() {
  $('#btn-back').addEventListener('click', () => {
    const btn = $('#btn-continue');
    btn.disabled = false;
    $('.btn-label', btn).textContent = 'Continue';
    $('.spinner', btn).hidden = true;
    show('screen-pin');
    checkPortal();
  });

  $('#agree').addEventListener('change', (e) => {
    $('#btn-start').disabled = !e.target.checked;
  });

  $('#btn-start').addEventListener('click', () => {
    show('screen-progress');
    startProgressAnimation();
    bridge.post({ type: 'start', consentAt: new Date().toISOString() });
  });
}

/* ------------------------------------------------ progress */

const RING_LEN = 653.45;

function startProgressAnimation() {
  state.targetPct = 2;
  state.shownPct = 0;
  paintProgress(0);

  clearInterval(state.animTimer);
  state.animTimer = setInterval(() => {
    // ease toward target for a fluid, natural feel
    const diff = state.targetPct - state.shownPct;
    if (Math.abs(diff) < 0.2 && state.shownPct >= state.targetPct) return;
    state.shownPct += Math.max(diff * 0.12, diff > 0 ? 0.35 : 0);
    state.shownPct = Math.min(state.shownPct, state.targetPct);
    paintProgress(state.shownPct);
  }, 40);
}

function paintProgress(pct) {
  const rounded = Math.floor(pct);
  $('#pct-num').textContent = rounded;
  const offset = RING_LEN * (1 - pct / 100);
  $('#ring-fill').style.strokeDashoffset = offset;

  document.querySelectorAll('.step').forEach((s) => {
    s.classList.toggle('on', pct >= Number(s.dataset.at));
  });
}

function setProgress(pct, label) {
  state.targetPct = Math.max(state.targetPct, pct);
  const lbl = $('#scan-label');
  if (label && lbl.textContent !== label) {
    lbl.textContent = label;
    lbl.style.animation = 'none';
    void lbl.offsetHeight;
    lbl.style.animation = '';
  }
}

/* ------------------------------------------------ result */

function showResult(msg) {
  clearInterval(state.animTimer);
  state.targetPct = 100;
  paintProgress(100);

  setTimeout(() => {
    show('screen-result');
    const badge = $('#r-badge');
    const title = $('#r-title');
    const sub = $('#r-sub');
    const errBox = $('#r-error');

    badge.className = 'result-badge';
    errBox.hidden = true;

    if (!msg.uploaded) {
      badge.classList.add('fail');
      title.textContent = 'Report not uploaded';
      sub.textContent = 'The scan finished but the portal could not be reached.';
      errBox.textContent = msg.error || 'Connection to the portal failed. Ask the admin before closing.';
      errBox.hidden = false;
      $('#btn-exit').hidden = false;
      $('#r-closing').hidden = true;
      return;
    }

    if (msg.verdict === 'detected') {
      badge.classList.add('detected');
      title.textContent = 'Cheat indicators detected';
      sub.textContent = 'Your report was uploaded and flagged for review by the admin.';
    } else if (msg.verdict === 'suspicious') {
      badge.classList.add('suspicious');
      title.textContent = 'Suspicious items found';
      sub.textContent = 'Some items need review. Report uploaded successfully.';
    } else {
      badge.classList.add('clean');
      title.textContent = 'Clean — no cheats found';
      sub.textContent = 'Your scan report has been uploaded. Thank you!';
    }

    $('#r-findings').textContent = msg.findings ?? 0;
    $('#r-serious').textContent = msg.serious ?? 0;
    $('#r-score').textContent = msg.score ?? 0;

    const secs = Number(msg.autoCloseSeconds) || 0;
    if (secs > 0) {
      $('#r-closing').hidden = false;
      let left = secs;
      $('#r-count').textContent = left;
      clearInterval(state.countdownTimer);
      state.countdownTimer = setInterval(() => {
        left -= 1;
        $('#r-count').textContent = Math.max(left, 0);
        if (left <= 0) clearInterval(state.countdownTimer);
      }, 1000);
    } else {
      $('#btn-exit').hidden = false;
    }
  }, 750);
}

/* ------------------------------------------------ host messages */

bridge.on((msg) => {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'config':
      if (msg.pin) state.pin = msg.pin;
      if (msg.playerName) state.playerName = msg.playerName;
      if (msg.portal) state.portal = msg.portal;
      state.auto = !!msg.auto;
      initPinScreen();
      show('screen-pin');
      checkPortal();
      setInterval(checkPortal, 8000);
      if (msg.auto && state.pin) {
        // Unattended mode (--auto): operator consent was given at launch.
        setTimeout(() => $('#btn-continue').click(), 600);
      }
      break;

    case 'session': {
      const btn = $('#btn-continue');
      btn.disabled = false;
      $('.btn-label', btn).textContent = 'Continue';
      $('.spinner', btn).hidden = true;

      if (!msg.ok) {
        const err = $('#pin-error');
        err.textContent = msg.error || 'PIN rejected';
        err.hidden = false;
        return;
      }
      state.session = msg.session;
      $('#c-session').textContent = msg.session.name;
      $('#c-game').textContent = msg.session.game;
      show('screen-consent');
      if (state.auto) {
        setTimeout(() => {
          $('#agree').checked = true;
          $('#agree').dispatchEvent(new Event('change'));
          $('#btn-start').click();
        }, 500);
      }
      break;
    }

    case 'progress':
      setProgress(msg.pct, msg.step);
      break;

    case 'done':
      showResult(msg);
      break;
  }
});

/* ------------------------------------------------ particles */

function initParticles() {
  const canvas = document.getElementById('particles');
  const ctx = canvas.getContext('2d');
  let w, h, parts;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
    parts = Array.from({ length: 46 }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.8 + 0.4,
      vx: (Math.random() - 0.5) * 0.22,
      vy: (Math.random() - 0.5) * 0.22,
      a: Math.random() * 0.5 + 0.15,
      hue: [168, 262, 322][Math.floor(Math.random() * 3)],
    }));
  }

  function tick() {
    ctx.clearRect(0, 0, w, h);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${p.hue}, 85%, 70%, ${p.a})`;
      ctx.fill();
    }
    requestAnimationFrame(tick);
  }

  window.addEventListener('resize', resize);
  resize();
  tick();
}

/* ------------------------------------------------ titlebar & window drag */

function initTitlebar() {
  const minBtn = $('#btn-minimize');
  const closeBtn = $('#btn-window-close');
  const dragArea = $('#titlebar-drag');

  if (minBtn) {
    minBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      bridge.post({ type: 'minimize' });
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      bridge.post({ type: 'exit' });
    });
  }

  if (dragArea) {
    dragArea.addEventListener('mousedown', (e) => {
      if (e.button === 0 && !e.target.closest('.tb-btn')) {
        bridge.post({ type: 'drag' });
      }
    });
  }

  // Allow clicking and dragging anywhere on empty header or stage background
  window.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
      const interactive = e.target.closest('input, button, label, .card, .btn, a, .rs, .check, .step, .tb-btn');
      if (!interactive) {
        bridge.post({ type: 'drag' });
      }
    }
  });
}

/* ------------------------------------------------ boot */

document.addEventListener('DOMContentLoaded', () => {
  initParticles();
  initTitlebar();
  initConsentScreen();
  $('#btn-exit').addEventListener('click', () => bridge.post({ type: 'exit' }));
  bridge.post({ type: 'ready' }); // host replies with config
});
