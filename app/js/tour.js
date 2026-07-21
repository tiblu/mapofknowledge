/* ═══════════════════════════════════════════════════════════════
   ONBOARDING TOUR  —  tour.js
   ───────────────────────────────────────────────────────────────
   Self-contained 7-step product tour. No external dependencies.
   Roll back: remove tour.css + tour.js from index.html.
   Exposes: window.Tour.start()  window.Tour.restart()
            window._tourCheckAutoStart(settings)
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var _step = 0;
  var _overlay, _dimSvg, _maskEl, _spots = [], _tip, _flash, _flashTimer;

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
  var _icoSearch  = _ico('<circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.3"/><path d="M10 10l3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>');

  function _row(icon, label, desc) {
    return '<div class="tour-row">'
      + '<span class="tour-row-icon">'+icon+'</span>'
      + '<span><strong>'+label+'</strong>'+(desc?' — '+desc:'')+'</span></div>';
  }

  // A self-contained decorative diagram — no image asset dependency, so the
  // "Õppimine" step's demo visual block can never 404.
  function _demoVisualDataUri() {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160">'
      + '<rect width="320" height="160" fill="#F5EEE8" rx="10"/>'
      + '<circle cx="90" cy="80" r="36" fill="none" stroke="#C4826A" stroke-width="5"/>'
      + '<path d="M150 118 L190 68 L230 106 L268 52" fill="none" stroke="#C4826A" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>'
      + '</svg>';
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  /* ─── Step definitions (order: welcome → controls/search → menu/Anne →
     sidebar → learning path → learning content → learner passport) ──
     Built lazily (not at module-load time) so window.t() reflects loaded
     strings — strings.js's fetch is async and may not have resolved yet
     at parse time. ── */
  var STEPS = [];
  function _buildSteps() {
    var demoKnobits = [
      { id: -1, sequence: 1, title: t('tour.demo_knobit_1') },
      { id: -2, sequence: 2, title: t('tour.demo_knobit_2') },
      { id: -3, sequence: 3, title: t('tour.demo_knobit_3') },
      { id: -4, sequence: 4, title: t('tour.demo_knobit_4') },
      { id: -5, sequence: 5, title: t('tour.demo_knobit_5') },
    ];
    var demoNode = { id: 'tour-demo', label: t('tour.demo_node_label'), color: '#5BC8D8' };

    return [
    // 1 — Teadmiste kaart
    {
      title:    t('tour.welcome_title'),
      text:     t('tour.welcome_text'),
      before: function() {
        if (window.MapView && window.MapView.tourZoom) window.MapView.tourZoom(3.4);
      },
    },
    // 2 — Kaardi juhtnupud + otsing
    {
      targets:  [{ selector: '#ctrl-left-stack', padding: 14 }, { selector: '.topbar-search-wrap', padding: 10 }],
      title:    t('tour.step3_title'),
      text:     _row(_icoZoomIn,  t('tour.row_zoom_in'))
        + _row(_icoZoomOut, t('tour.row_zoom_out'))
        + _row(_icoGlobe,  t('tour.row_map_view'),  t('tour.row_map_view_desc'))
        + _row(_icoFilter, t('tour.row_filters'),  t('tour.row_filters_desc'))
        + _row(_icoSearch, t('tour.row_search'),   t('tour.row_search_desc'))
        + '<br>' + t('tour.step2_text_tail'),
    },
    // 3 — Menüü ja Anne
    {
      targets:  [{ selector: '#nav-dropdown', padding: 6 }, { selector: '#anne-widget', padding: 6 }],
      title:    t('tour.menu_title'),
      text:     t('tour.menu_text'),
      before: function () {
        if (window.Anne && window.Anne.setVisible) window.Anne.setVisible(true);
        // Deferred: this before() hook runs synchronously inside the same
        // click event that fired Tour.next() — both the menu and Anne have
        // their own "close on any outside click" listener on `document`,
        // which would otherwise see that same click bubble past and
        // immediately undo the .open we're about to add.
        setTimeout(function () {
          var dd = document.getElementById('nav-dropdown');
          if (dd) dd.classList.add('open');
          if (window.Anne && window.Anne.open) window.Anne.open();
        }, 30);
      },
      after: function () {
        var dd = document.getElementById('nav-dropdown');
        if (dd) dd.classList.remove('open');
        if (window.Anne && window.Anne.setVisible) window.Anne.setVisible(false);
      },
    },
    // 4 — Külgpaneel (unchanged from the old tour)
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
    // 5 — Õpirada (the flat knobit list — unchanged content from the old tour)
    {
      target:   '#lm-path',
      position: 'overlay-center',
      title:    t('tour.step4_title'),
      text:     t('tour.step4_text'),
      before: function () {
        var lm = document.getElementById('learning-mode');
        if (lm) lm.style.zIndex = '9500';
        if (window.Learn && window.Learn.open) window.Learn.open(demoNode, t('tour.demo_breadcrumb'), demoKnobits);
      },
      after: function () {
        if (window.Learn && window.Learn.close) window.Learn.close();
        var lm = document.getElementById('learning-mode');
        if (lm) lm.style.zIndex = '';
      },
      padding: 0,
    },
    // 6 — Õppimine (actual byte/visual content, faked via a resume session
    // so it renders through the real UI with zero API calls)
    {
      target:   '#lm-knobit',
      position: 'overlay-center',
      title:    t('tour.learning_title'),
      text:     t('tour.learning_text'),
      before: function () {
        var lm = document.getElementById('learning-mode');
        if (lm) lm.style.zIndex = '9500';
        if (window.Learn && window.Learn.open) {
          window.Learn.open(demoNode, t('tour.demo_breadcrumb'), demoKnobits, {
            knobitId: demoKnobits[0].id,
            blocks: [
              { phase: 'explain', block_type: 'byte', block_index: 0, content: t('tour.demo_byte_1') },
              { phase: 'explain', block_type: 'visual', block_index: 0,
                content: JSON.stringify({ type: 'image', url: _demoVisualDataUri(), caption: t('tour.demo_visual_caption') }) },
            ],
          });
        }
        if (window.startKnobit) window.startKnobit();
      },
      after: function () {
        if (window.Learn && window.Learn.close) window.Learn.close();
        var lm = document.getElementById('learning-mode');
        if (lm) lm.style.zIndex = '';
      },
      padding: 0,
    },
    // 7 — Õppija pass
    {
      target:   '#page-overlay-frame',
      position: 'overlay-center',
      title:    t('tour.passport_title'),
      text:     t('tour.passport_text'),
      before: function () {
        if (window.openOverlay) window.openOverlay('profile.html');
      },
      after: function () {
        if (window.closeOverlay) window.closeOverlay();
      },
      padding: 0,
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
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function _createDOM() {
    _overlay = document.createElement('div');
    _overlay.className = 'tour-overlay';
    _overlay.addEventListener('click', function() {
      _flashMsg(t('tour.overlay_hint'));
    });

    // One shared dimming layer with an SVG mask, so a step that highlights
    // more than one element at once gets ONE unified dark surround with
    // multiple cutouts — not N independent elements each darkening
    // everything outside themselves (which darkens the OTHER cutouts too).
    _dimSvg = document.createElementNS(SVG_NS, 'svg');
    _dimSvg.setAttribute('class', 'tour-dim-svg');
    var maskId = 'tour-mask-' + Math.random().toString(36).slice(2, 8);
    var maskEl = document.createElementNS(SVG_NS, 'mask');
    maskEl.setAttribute('id', maskId);
    var baseRect = document.createElementNS(SVG_NS, 'rect');
    baseRect.setAttribute('x', '0'); baseRect.setAttribute('y', '0');
    baseRect.setAttribute('width', '100%'); baseRect.setAttribute('height', '100%');
    baseRect.setAttribute('fill', 'white'); // white = dark overlay shows here
    maskEl.appendChild(baseRect);
    var defs = document.createElementNS(SVG_NS, 'defs');
    defs.appendChild(maskEl);
    var dimRect = document.createElementNS(SVG_NS, 'rect');
    dimRect.setAttribute('x', '0'); dimRect.setAttribute('y', '0');
    dimRect.setAttribute('width', '100%'); dimRect.setAttribute('height', '100%');
    dimRect.setAttribute('fill', 'black');
    dimRect.setAttribute('fill-opacity', '0.62');
    dimRect.setAttribute('mask', 'url(#' + maskId + ')');
    _dimSvg.appendChild(defs);
    _dimSvg.appendChild(dimRect);
    _maskEl = maskEl;

    _tip = document.createElement('div');
    _tip.className = 'tour-tooltip';

    document.body.appendChild(_overlay);
    document.body.appendChild(_dimSvg);
    document.body.appendChild(_tip);
  }

  /* ─── Spotlight pool — a step can highlight more than one element at
     once (e.g. the map controls AND the search box together). ─────── */
  function _normalizeTargets(s) {
    if (Array.isArray(s.targets)) return s.targets;
    if (s.target) return [{ selector: s.target, padding: s.padding || 0 }];
    return [];
  }

  function _ensureSpots(n) {
    while (_spots.length < n) {
      var el = document.createElement('div');
      el.className = 'tour-spotlight';
      document.body.appendChild(el);
      _spots.push(el);
    }
  }

  function _positionSpots(targets) {
    // Rebuild the mask's cutout rects (everything after the base white rect).
    while (_maskEl.children.length > 1) _maskEl.removeChild(_maskEl.lastChild);

    var rects = [];
    targets.forEach(function (t2) {
      var node = t2.selector ? document.querySelector(t2.selector) : null;
      var rect = node ? node.getBoundingClientRect() : null;
      if (!rect || (!rect.width && !rect.height)) return;
      var p = t2.padding || 0;
      rects.push({
        left:   rect.left   - p,
        top:    rect.top    - p,
        width:  rect.width  + p * 2,
        height: rect.height + p * 2,
      });
    });

    rects.forEach(function (r) {
      var cut = document.createElementNS(SVG_NS, 'rect');
      cut.setAttribute('x', r.left);
      cut.setAttribute('y', r.top);
      cut.setAttribute('width', r.width);
      cut.setAttribute('height', r.height);
      cut.setAttribute('rx', 10);
      cut.setAttribute('fill', 'black'); // black in a mask = hidden = the cutout
      _maskEl.appendChild(cut);
    });

    // Decorative glow border per cutout (visual only — the SVG layer above
    // does the actual dimming).
    _ensureSpots(rects.length);
    _spots.forEach(function (el, i) {
      if (i >= rects.length) { el.classList.remove('visible'); return; }
      var r = rects[i];
      el.style.left   = r.left   + 'px';
      el.style.top    = r.top    + 'px';
      el.style.width  = r.width  + 'px';
      el.style.height = r.height + 'px';
      el.classList.add('visible');
    });
  }

  function _hideSpots() {
    _spots.forEach(function (el) { el.classList.remove('visible'); el.style.cssText = ''; });
    if (_maskEl) { while (_maskEl.children.length > 1) _maskEl.removeChild(_maskEl.lastChild); }
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

    var targets = _normalizeTargets(s);
    _positionSpots(targets);
    _positionTip();

    // Re-position after transitions settle (sidebar slide-in, menu/Anne
    // opening, overlay iframe loading, learning mode rendering, …).
    setTimeout(function () {
      _positionSpots(_normalizeTargets(s));
      _positionTip();
    }, 420);

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
    if (_dimSvg) _dimSvg.classList.add('visible');
    _tip.classList.add('visible');
  }

  /* ─── Leave a step (run after hook) ───────────────────────── */
  function _leave(idx) {
    var s = STEPS[idx];
    if (s && s.after) s.after();
  }

  function _hide() {
    if (_overlay) _overlay.classList.remove('visible');
    if (_dimSvg)  _dimSvg.classList.remove('visible');
    _hideSpots();
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
  // Anne stays hidden for the whole tour except while step 3 is explaining
  // her — otherwise her avatar sits there fully visible and clickable
  // underneath every other step's "highlight".
  function _hideAnne() {
    if (window.Anne && window.Anne.setVisible) window.Anne.setVisible(false);
  }
  function _restoreAnne() {
    if (window.Anne && window.Anne.setVisible) window.Anne.setVisible(true);
  }

  window.Tour = {
    start: function () {
      STEPS = _buildSteps();
      if (!_overlay) _createDOM();
      _hideAnne();
      _show(0);
    },
    restart: function () {
      _markDone(false);
      STEPS = _buildSteps();
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
