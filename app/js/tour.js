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

  /* ─── Step definitions (order: sidebar → zoom → controls → learning → passport) ──
     Built lazily (not at module-load time) so window.t() reflects loaded strings —
     strings.js's fetch is async and may not have resolved yet at parse time. */
  var STEPS = [];
  function _buildSteps() {
    return [
    {
      target:   '#sidebar',
      position: 'left',
      title:    t('tour.step1_title'),
      text:     t('tour.step1_text'),
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
      title:    t('tour.step2_title'),
      text:     'Navigate with the controls here:<br><br>'
        + _row(_icoZoomIn,  t('tour.row_zoom_in'))
        + _row(_icoZoomOut, t('tour.row_zoom_out'))
        + _row(_icoTiltUp,  t('tour.row_tilt'), t('tour.row_tilt_desc'))
        + _row(_icoTiltDn,  t('tour.row_flatten'), t('tour.row_flatten_desc'))
        + '<br>' + t('tour.step2_text_tail'),
      padding: 10,
    },
    {
      target:   '#ctrl-left-stack',
      position: 'right',
      title:    t('tour.step3_title'),
      text:     _row(_icoGlobe,  t('tour.row_map_view'),  t('tour.row_map_view_desc'))
        + _row(_icoFilter, t('tour.row_filters'),  t('tour.row_filters_desc')),
      padding: 14,
    },
    {
      target:   '#learning-mode',
      position: 'overlay-center',
      title:    t('tour.step4_title'),
      text:     t('tour.step4_text'),
      before: function () {
        var lm = document.getElementById('learning-mode');
        if (lm) lm.style.zIndex = '9500';
        if (window.Learn && window.Learn.open) {
          window.Learn.open(
            { id: 'tour-demo', label: t('tour.demo_node_label'), color: '#5BC8D8' },
            t('tour.demo_breadcrumb'),
            [
              { id: -1, sequence: 1, title: t('tour.demo_knobit_1') },
              { id: -2, sequence: 2, title: t('tour.demo_knobit_2') },
              { id: -3, sequence: 3, title: t('tour.demo_knobit_3') },
              { id: -4, sequence: 4, title: t('tour.demo_knobit_4') },
              { id: -5, sequence: 5, title: t('tour.demo_knobit_5') },
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
      title:    t('tour.step5_title'),
      text:     t('tour.step5_text'),
      padding:  10,
    },
    ];
  }

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
      _flashMsg(t('tour.overlay_hint'));
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

    var stepOf = t('tour.step_of').replace('{n}', idx + 1).replace('{total}', n);
    _tip.innerHTML =
      '<div class="tour-dots">' + dots + '</div>' +
      '<div class="tour-step-num">' + stepOf + '</div>' +
      '<div class="tour-title">' + s.title + '</div>' +
      '<div class="tour-text">'  + s.text  + '</div>' +
      '<div class="tour-actions">' +
        '<button class="tour-skip" onclick="window.Tour.skip()">' + t('tour.skip') + '</button>' +
        '<div class="tour-btn-group">' +
          (idx > 0 ? '<button class="tour-btn tour-btn-secondary" onclick="window.Tour.prev()">' + t('tour.back') + '</button>' : '') +
          '<button class="tour-btn tour-btn-primary" onclick="window.Tour.next()">' +
            (last ? t('tour.done') : t('tour.next')) +
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
    localStorage.setItem(window.lsKey('kq_tour_done'), done ? '1' : '0');
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'tour_completed', value: done ? '1' : '' }),
    }).catch(function () {});
  }

  /* ─── Public API ───────────────────────────────────────────── */
  window.Tour = {
    start: function () {
      STEPS = _buildSteps();
      if (!_overlay) _createDOM();
      _show(0);
    },
    restart: function () {
      _markDone(false);
      STEPS = _buildSteps();
      if (!_overlay) _createDOM();
      _show(0);
    },
    next: function () {
      _leave(_step);
      if (_step < STEPS.length - 1) {
        _show(_step + 1);
      } else {
        _hide();
        _markDone(true);
      }
    },
    prev: function () {
      if (_step > 0) { _leave(_step); _show(_step - 1); }
    },
    skip: function () {
      _leave(_step);
      _hide();
      _markDone(true);
    },
  };

  /* ─── Auto-start logic ─────────────────────────────────────── */
  // Called by app.js after settings are loaded
  window._tourCheckAutoStart = function (settings) {
    // Forced restart from settings page
    if (localStorage.getItem(window.lsKey('kq_force_tour')) === '1') {
      localStorage.removeItem(window.lsKey('kq_force_tour'));
      setTimeout(function () { window.Tour.start(); }, 1800);
      return;
    }
    // Already completed
    if (localStorage.getItem(window.lsKey('kq_tour_done')) === '1') return;
    if (settings && settings.tour_completed === '1') return;
    // First visit — start after map settles
    setTimeout(function () { window.Tour.start(); }, 2200);
  };

}());
