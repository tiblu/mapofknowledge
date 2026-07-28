/* ═══════════════════════════════════════════════════════════════
   ONBOARDING TOUR  —  tour.js
   ───────────────────────────────────────────────────────────────
   Self-contained 5-step product tour. No external dependencies.
   Roll back: remove tour.css + tour.js from index.html.
   Exposes: window.Tour.start()  window.Tour.restart()
            window._tourCheckAutoStart(settings)
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var _step = 0;
  var _overlay, _spot, _tip, _flash, _flashTimer;

  /* ─── Inline icon helpers ──────────────────────────────────── */
  function _ico(d, s) {
    s = s || 13;
    return '<svg width="'+s+'" height="'+s+'" viewBox="0 0 15 15" fill="none" class="tour-ico">'+d+'</svg>';
  }
  var _icoGlobe   = _ico('<circle cx="7.5" cy="7.5" r="6" stroke="currentColor" stroke-width="1.3"/><path d="M1.5 7.5h12M7.5 1.5c-2 2-2 8 0 12M7.5 1.5c2 2 2 8 0 12" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>');
  var _icoLayers  = _ico('<path d="M7.5 2 L13 5.5 L7.5 9 L2 5.5 Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M2 9L7.5 12.5L13 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>');
  var _icoFilter  = _ico('<path d="M2 4.5h11M4 7.5h7M6 10.5h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>');
  var _icoZoomIn  = _ico('<circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.3"/><path d="M6 4v4M4 6h4M10 10l2.5 2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>');
  var _icoZoomOut = _ico('<circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.3"/><path d="M4 6h4M10 10l2.5 2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>');
  var _icoTiltUp  = _ico('<ellipse cx="7.5" cy="10" rx="5.5" ry="2" stroke="currentColor" stroke-width="1.2"/><ellipse cx="7.5" cy="7" rx="5.5" ry="2" stroke="currentColor" stroke-width="1.2" stroke-dasharray="3 2"/><path d="M7.5 4V1M6 2.5l1.5-1.5 1.5 1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>');
  var _icoTiltDn  = _ico('<ellipse cx="7.5" cy="5" rx="5.5" ry="2" stroke="currentColor" stroke-width="1.2"/><ellipse cx="7.5" cy="8" rx="5.5" ry="2" stroke="currentColor" stroke-width="1.2" stroke-dasharray="3 2"/><path d="M7.5 11v3M6 12.5l1.5 1.5 1.5-1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>');

  function _row(icon, label, desc) {
    return '<div class="tour-row">'
      + '<span class="tour-row-icon">'+icon+'</span>'
      + '<span><strong>'+label+'</strong>'+(desc?' — '+desc:'')+'</span></div>';
  }

  /* ─── Step definitions (order: sidebar → zoom → controls → learning → passport) ── */
  var STEPS = [
    {
      target:   '#sidebar',
      position: 'left',
      title:    'Welcome — this is a learning platform',
      text:     'Click any node on the map to open its sidebar. From here you can <strong>mark it as known</strong>, run a <strong>4-question knowledge test</strong>, or start a <strong>guided learning session</strong>.<br><br>No curriculum. No prerequisites. Complete freedom to learn whatever you want, in any order.',
      before: function() {
        if (window.MapView && window.MapView.openDemoNode) window.MapView.openDemoNode();
      },
      after: function() {
        if (window.MapView && window.MapView.closeSidebar) window.MapView.closeSidebar();
      },
      padding: 0,
    },
    {
      target:   '#ctrl-zoom',
      position: 'left',
      title:    'Explore the map',
      text:     'Navigate with the controls here:<br><br>'
        + _row(_icoZoomIn,  'Zoom in')
        + _row(_icoZoomOut, 'Zoom out')
        + _row(_icoTiltUp,  'Tilt', 'view the map in 3D')
        + _row(_icoTiltDn,  'Flatten', 'return to top-down view')
        + '<br>Drag any node to rearrange. Over 10,000 concepts across all domains of human knowledge.',
      padding: 10,
    },
    {
      target:   '#ctrl-left-stack',
      position: 'right',
      title:    'Map controls',
      text:     _row(_icoGlobe,  'Map view',  'reset to full overview')
        + _row(_icoLayers, 'Layers',   'show or hide knowledge domains')
        + _row(_icoFilter, 'Filters',  'focus on a specific curriculum or learning goal'),
      padding: 14,
    },
    {
      target:   '#learning-mode',
      position: 'overlay-center',
      title:    'Learning mode &amp; knobits',
      text:     'Guided learning breaks each topic into <strong>knobits</strong> — small, focused units you master one at a time. Each knobit walks you through four phases:<br><br><em>Explain → Demonstrate → Practice → Meaning</em><br><br>You set the pace. You can ask anything at any time using the field at the bottom.',
      before: function () {
        var lm = document.getElementById('learning-mode');
        if (lm) lm.style.zIndex = '9500';
        if (window.Learn && window.Learn.open) {
          window.Learn.open(
            { id: 'tour-demo', label: 'Quantum Mechanics', color: '#5BC8D8' },
            'Natural Sciences › Physics',
            [
              { id: -1, sequence: 1, title: 'What is a quantum state?' },
              { id: -2, sequence: 2, title: 'Wave-particle duality' },
              { id: -3, sequence: 3, title: 'The uncertainty principle' },
              { id: -4, sequence: 4, title: 'Quantum superposition' },
              { id: -5, sequence: 5, title: 'Measurement and collapse' },
            ]
          );
        }
      },
      after: function () {
        if (window.Learn && window.Learn.close) window.Learn.close();
        var lm = document.getElementById('learning-mode');
        if (lm) lm.style.zIndex = '';
      },
    },
    {
      target:   '.topbar-burger-wrap',
      position: 'bottom-left',
      title:    'Your Learner Passport',
      text:     'Tap the menu icon above, then click <strong>Account</strong> to open your Learner Passport — a living record of everything you learn. It stores credentials, your knowledge map, reflections, and goals.<br><br>Exportable in internationally recognised formats and verifiable via blockchain.',
      padding:  10,
    },
  ];

  /* ─── Flash message ────────────────────────────────────────── */
  function _flashMsg(text) {
    if (!_flash) {
      _flash = document.createElement('div');
      _flash.className = 'tour-flash';
      document.body.appendChild(_flash);
    }
    _flash.textContent = text;
    _flash.classList.add('show');
    clearTimeout(_flashTimer);
    _flashTimer = setTimeout(function() { _flash.classList.remove('show'); }, 1800);
  }

  /* ─── DOM setup ────────────────────────────────────────────── */
  function _createDOM() {
    _overlay = document.createElement('div');
    _overlay.className = 'tour-overlay';
    _overlay.addEventListener('click', function() {
      _flashMsg('The app is available after the tour. Use Next → to continue.');
    });

    _spot = document.createElement('div');
    _spot.className = 'tour-spotlight';

    _tip = document.createElement('div');
    _tip.className = 'tour-tooltip';

    document.body.appendChild(_overlay);
    document.body.appendChild(_spot);
    document.body.appendChild(_tip);
  }

  /* ─── Positioning ──────────────────────────────────────────── */
  function _positionSpot(rect, padding) {
    // Use class only — no inline style.display, so _hide() always works cleanly
    if (!rect) { _spot.classList.remove('visible'); return; }
    var p = padding || 0;
    _spot.style.left   = (rect.left   - p) + 'px';
    _spot.style.top    = (rect.top    - p) + 'px';
    _spot.style.width  = (rect.width  + p * 2) + 'px';
    _spot.style.height = (rect.height + p * 2) + 'px';
    _spot.classList.add('visible');
  }

  function _positionTip() {
    var TW = 340, M = 18;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.round((vw - TW) / 2);
    var top  = Math.max(M, Math.round(vh / 2 - 185));
    left = Math.max(M, Math.min(left, vw - TW - M));
    _tip.style.left = left + 'px';
    _tip.style.top  = top  + 'px';
  }

  /* ─── Render a step ────────────────────────────────────────── */
  function _show(idx) {
    var s    = STEPS[idx];
    _step    = idx;
    var n    = STEPS.length;
    var last = (idx === n - 1);

    // Before hook
    if (s.before) s.before();

    // Re-read rect after before hook may have changed DOM
    var targetEl = s.target ? document.querySelector(s.target) : null;
    var rect     = targetEl ? targetEl.getBoundingClientRect() : null;

    // Re-position after transitions settle (sidebar slide-in, learning mode open)
    if (s.target === '#sidebar' || s.position === 'overlay-center') {
      setTimeout(function () {
        var el2   = s.target ? document.querySelector(s.target) : null;
        var rect2 = el2 ? el2.getBoundingClientRect() : null;
        _positionSpot(rect2, s.padding || 0);
        _positionTip();
      }, 380);
    }

    _positionSpot(rect, s.padding || 0);
    _positionTip();

    // Progress dots
    var dots = '';
    for (var i = 0; i < n; i++) {
      dots += '<div class="tour-dot' + (i === idx ? ' active' : '') + '"></div>';
    }

    _tip.innerHTML =
      '<div class="tour-dots">' + dots + '</div>' +
      '<div class="tour-step-num">Step ' + (idx + 1) + ' of ' + n + '</div>' +
      '<div class="tour-title">' + s.title + '</div>' +
      '<div class="tour-text">'  + s.text  + '</div>' +
      '<div class="tour-actions">' +
        '<button class="tour-skip" onclick="window.Tour.skip()">Skip tour</button>' +
        '<div class="tour-btn-group">' +
          (idx > 0 ? '<button class="tour-btn tour-btn-secondary" onclick="window.Tour.prev()">← Back</button>' : '') +
          '<button class="tour-btn tour-btn-primary" onclick="window.Tour.next()">' +
            (last ? 'Done ✓' : 'Next →') +
          '</button>' +
        '</div>' +
      '</div>';

    _overlay.classList.add('visible');
    _spot.classList.add('visible');
    _tip.classList.add('visible');
  }

  /* ─── Leave a step (run after hook) ───────────────────────── */
  function _leave(idx) {
    var s = STEPS[idx];
    if (s && s.after) s.after();
  }

  function _hide() {
    if (_overlay) _overlay.classList.remove('visible');
    if (_spot)    { _spot.classList.remove('visible'); _spot.style.cssText = ''; }
    if (_tip)     _tip.classList.remove('visible');
  }

  function _markDone(done) {
    // Server-side only (per-user, via the authenticated session) — not
    // localStorage, which is scoped to the browser, not the account. A
    // shared-browser localStorage flag would silently block the tour for
    // every other account that ever logs in on that same browser/device.
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'tour_completed', value: done ? '1' : '' }),
    }).catch(function () {});
  }

  /* ─── Anne visibility ──────────────────────────────────────── */
  // Anne stays hidden for the whole tour — otherwise her avatar sits there
  // fully visible and clickable underneath every other step's "highlight".
  function _hideAnne() {
    if (window.Anne && window.Anne.setVisible) window.Anne.setVisible(false);
  }
  function _restoreAnne() {
    if (window.Anne && window.Anne.setVisible) window.Anne.setVisible(true);
  }

  /* ─── Public API ───────────────────────────────────────────── */
  window.Tour = {
    start: function () {
      if (!_overlay) _createDOM();
      _hideAnne();
      _show(0);
    },
    restart: function () {
      _markDone(false);
      if (!_overlay) _createDOM();
      _hideAnne();
      _show(0);
    },
    next: function () {
      _leave(_step);
      if (_step < STEPS.length - 1) {
        _show(_step + 1);
      } else {
        _hide();
        _restoreAnne();
        _markDone(true);
      }
    },
    prev: function () {
      if (_step > 0) { _leave(_step); _show(_step - 1); }
    },
    skip: function () {
      _leave(_step);
      _hide();
      _restoreAnne();
      _markDone(true);
    },
  };

  /* ─── Auto-start logic ─────────────────────────────────────── */
  // Called by app.js after settings are loaded
  window._tourCheckAutoStart = function (settings) {
    // Forced restart from settings page
    if (localStorage.getItem('kq_force_tour') === '1') {
      localStorage.removeItem('kq_force_tour');
      setTimeout(function () { window.Tour.start(); }, 1800);
      return;
    }
    // Already completed — per-user server setting only, see _markDone.
    if (settings && settings.tour_completed === '1') return;
    // First visit — start after map settles
    setTimeout(function () { window.Tour.start(); }, 2200);
  };

}());
