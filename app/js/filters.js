/* ═══════════════════════════════════════════════════════════════
   FILTERS  —  filters.js  (Map View sub-module)
   ───────────────────────────────────────────────────────────────
   Owns  : filter panel UI, filter set definitions, active state
   Calls : window.setMapFilter(descriptors[])
           window.setKnowledgeFilter(progress, threshold)
           window.clearKnowledgeFilter()
           window.updateRingColor(filterId, color)
   Never : touch D3 internals, learning.js, test.js
   ═══════════════════════════════════════════════════════════════ */

(function () {

  /* ─── Built-in filter definitions ───────────────────────────────────────
     My Knowledge is hardcoded here; DB-backed subsets are loaded below.
  ──────────────────────────────────────────────────────────────────────── */
  var FILTERS = {
    'my-knowledge': {
      label:           'My Knowledge',
      color:           '#9B8FB5',
      dynamic:         true,
      isOverlay:       true,
      displayMode:     'ring',
      backgroundHidden: true,
      ringColor:       '#9B8FB5',
      labels:          new Set()
    }
  };

  /* ─── DB-backed subsets ──────────────────────────────────────────────── */
  var COLOR_HEX = { terra: '#C4826A', sage: '#8BAD7E', amber: '#C4A55A', lavender: '#9B8FB5' };
  function resolveColor(iconColor) {
    return COLOR_HEX[iconColor] || (iconColor && iconColor[0] === '#' ? iconColor : COLOR_HEX.terra);
  }

  function getRingColorOverride(filterId) {
    try { return localStorage.getItem(window.lsKey('kq_ring_color_' + filterId)) || null; }
    catch(e) { return null; }
  }
  function setRingColorOverride(filterId, color) {
    try { localStorage.setItem(window.lsKey('kq_ring_color_' + filterId), color); } catch(e) {}
    _syncToServer('kq_ring_color_' + filterId, color);
  }

  function getColorOverride(filterId) {
    try { return localStorage.getItem(window.lsKey('kq_color_' + filterId)) || null; }
    catch(e) { return null; }
  }
  function setColorOverride(filterId, color) {
    try { localStorage.setItem(window.lsKey('kq_color_' + filterId), color); } catch(e) {}
    _syncToServer('kq_color_' + filterId, color);
  }

  // Mirrors the corresponding /api/settings row into localStorage so a saved
  // preference survives a cleared cache or a different browser, not just a
  // refresh. /api/settings already exists and accepts arbitrary key/value
  // pairs (used for locale/font-size/palette elsewhere) — no backend change
  // needed. Ported from KnobitMap.
  function _syncToServer(key, value) {
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key, value: value }),
    }).catch(function() {});
  }

  function _primeFromServer(s) {
    ['kq_filter_hidden', 'kq_base_filter'].forEach(function(k) {
      if (s[k] !== undefined) { try { localStorage.setItem(window.lsKey(k), s[k]); } catch(e) {} }
    });
    Object.keys(s).forEach(function(k) {
      if (k.indexOf('kq_ring_color_') === 0 || k.indexOf('kq_color_') === 0) {
        try { localStorage.setItem(window.lsKey(k), s[k]); } catch(e) {}
      }
    });
  }

  function loadDBSubsets() {
    var hidden;
    try { hidden = JSON.parse(localStorage.getItem(window.lsKey('kq_filter_hidden')) || '[]'); }
    catch(e) { hidden = []; }

    fetch('/api/subsets')
      .then(function(r) { return r.json(); })
      .then(function(subsets) {
        var list = document.querySelector('#filter-panel .fp-list');
        subsets.forEach(function(s) {
          var filterId = 'db-' + s.id;
          var baseColor = resolveColor(s.icon_color);
          var colorOverride = getColorOverride(filterId);
          var ringOverride  = getRingColorOverride(filterId);
          var color = colorOverride || baseColor;
          FILTERS[filterId] = {
            label:           s.name,
            color:           color,
            dbId:            s.id,
            labels:          null,
            isOverlay:       !!s.is_overlay,
            displayMode:     s.display_mode || 'color',
            backgroundHidden: !!s.background_hidden,
            ringColor:       ringOverride || s.ring_color || baseColor
          };
          var div = document.createElement('div');
          div.className = 'fp-item';
          div.dataset.filterId = filterId;
          div.style.setProperty('--fi-color', color);
          if (hidden.indexOf(filterId) !== -1) div.style.display = 'none';
          div.innerHTML = '<div class="fp-radio"></div><div class="fp-dot"></div>'
                        + '<span class="fp-label">' + s.name + '</span>';
          list.appendChild(div);
        });

        // Restore saved filter, if any. There's no universal default any
        // more — subsets are one-per-grade/subject, so defaulting everyone
        // to the first one would silently apply it to every brand-new
        // account. Ported from KnobitMap.
        var saved;
        try { saved = localStorage.getItem(window.lsKey('kq_base_filter')); } catch(e) { saved = null; }
        if (saved && saved !== 'none' && FILTERS[saved]) {
          baseFilterId = saved;
          ensureFilterLabels(saved, FILTERS[saved]);
          updateActiveUI();
        }
      })
      .catch(function() {});
  }

  /* ─── Apply visibility from localStorage ────────────────────────────── */
  function applyVisibility() {
    var hidden;
    try { hidden = JSON.parse(localStorage.getItem(window.lsKey('kq_filter_hidden')) || '[]'); }
    catch(e) { hidden = []; }
    if (!hidden.length) return;
    document.querySelectorAll('.fp-item').forEach(function(item) {
      if (hidden.indexOf(item.dataset.filterId) !== -1) {
        item.style.display = 'none';
      }
    });
  }

  // Wait for user ID, then prime localStorage from server settings and
  // initialise — ensures window.lsKey() uses the real user id (not the
  // 'anon' fallback) before anything reads/writes a saved preference.
  // Ported from KnobitMap.
  Promise.all([
    window._userIdReady,
    fetch('/api/settings').then(function(r) { return r.json(); }).catch(function() { return {}; }),
  ]).then(function(results) {
    _primeFromServer(results[1]);
    loadDBSubsets();
    applyVisibility();
  });

  /* ─── State ──────────────────────────────────────────────────────────── */
  var baseFilterId     = null;       // one non-overlay active filter or null
  var overlayFilterIds = new Set();  // active overlay filters (any number)

  /* ─── DOM refs ───────────────────────────────────────────────────────── */
  var panel     = document.getElementById('filter-panel');
  var filterBtn = document.getElementById('filter-btn');
  var clearBtn  = document.getElementById('fp-clear');
  var list      = document.querySelector('#filter-panel .fp-list');

  /* ─── Filter panel toggle ────────────────────────────────────────────── */
  filterBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var lp = document.getElementById('layer-panel');
    var lb = document.getElementById('layers-btn');
    if (lp) lp.classList.remove('open');
    if (lb) lb.classList.remove('active');
    panel.classList.toggle('open');
    filterBtn.classList.toggle('active', panel.classList.contains('open'));
  });

  document.addEventListener('click', function (e) {
    if (!panel.contains(e.target) && e.target !== filterBtn) {
      panel.classList.remove('open');
      filterBtn.classList.remove('active');
    }
  });

  /* ─── Filter item clicks (delegated) ────────────────────────────────── */
  list.addEventListener('click', function (e) {
    // color picker clicks are handled separately — don't treat as filter toggle
    if (e.target.closest('.fp-color-swatch')) return;

    var item = e.target.closest('.fp-item');
    if (!item) return;
    e.stopPropagation();
    var fid    = item.dataset.filterId;
    var filter = FILTERS[fid];
    if (!filter) return;

    if (filter.isOverlay) {
      if (overlayFilterIds.has(fid)) {
        overlayFilterIds.delete(fid);
      } else {
        overlayFilterIds.add(fid);
        ensureFilterLabels(fid, filter);
      }
    } else {
      if (baseFilterId === fid) {
        baseFilterId = null;
        saveBaseFilter('none');
      } else {
        baseFilterId = fid;
        saveBaseFilter(fid);
        ensureFilterLabels(fid, filter);
      }
    }

    updateActiveUI();
    pushToMap();
  });

  /* ─── Clear button ───────────────────────────────────────────────────── */
  if (clearBtn) {
    clearBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      deactivateAll();
    });
  }

  /* ─── Color swatch (delegated, filter panel) ─────────────────────────── */
  list.addEventListener('change', function (e) {
    var swatch = e.target.closest('.fp-color-swatch');
    if (!swatch) return;
    var fid    = swatch.dataset.filterId;
    var filter = FILTERS[fid];
    var color  = e.target.value;
    if (!filter) return;

    if (filter.displayMode === 'ring') {
      filter.ringColor = color;
      setRingColorOverride(fid, color);
      if (typeof window.updateRingColor === 'function') window.updateRingColor(fid, color);
    } else {
      filter.color = color;
      setColorOverride(fid, color);
      if (typeof window.updateFilterColor === 'function') window.updateFilterColor(fid, color);
      var item = swatch.closest('.fp-item');
      if (item) item.style.setProperty('--fi-color', color);
    }
  });

  /* ─── Helpers ────────────────────────────────────────────────────────── */
  function ensureFilterLabels(fid, filter) {
    if (filter.dynamic || filter.labels) return; // already loaded or dynamic
    if (!filter.dbId) return;
    fetch('/api/subsets/' + filter.dbId + '/nodes')
      .then(function(r) { return r.json(); })
      .then(function(labels) {
        filter.labels = new Set(labels);
        pushToMap();
      })
      .catch(function() {});
  }

  function saveBaseFilter(fid) {
    var val = fid || 'none';
    try { localStorage.setItem(window.lsKey('kq_base_filter'), val); } catch(e) {}
    _syncToServer('kq_base_filter', val);
  }

  function deactivateAll() {
    baseFilterId = null;
    overlayFilterIds.clear();
    saveBaseFilter('none');
    updateActiveUI();
    pushToMap();
    if (typeof window.clearKnowledgeFilter === 'function') window.clearKnowledgeFilter();
  }

  window.clearActiveFilter = deactivateAll;

  function updateActiveUI() {
    var anyActive = baseFilterId || overlayFilterIds.size > 0;
    if (clearBtn) clearBtn.classList.toggle('hidden', !anyActive);

    document.querySelectorAll('.fp-item').forEach(function(el) {
      var fid    = el.dataset.filterId;
      var active = fid === baseFilterId || overlayFilterIds.has(fid);
      el.classList.toggle('active', active);

      // show/hide color swatch (ring color in ring mode, base color in color mode)
      var filter = FILTERS[fid];
      var swatch = el.querySelector('.fp-color-swatch');
      if (filter) {
        var isRingMode = filter.displayMode === 'ring';
        var swatchColor = isRingMode ? (filter.ringColor || '#9B8FB5') : (filter.color || '#9B8FB5');
        if (!swatch) {
          swatch = document.createElement('label');
          swatch.className = 'fp-color-swatch';
          swatch.dataset.filterId = fid;
          var inp = document.createElement('input');
          inp.type = 'color';
          swatch.appendChild(inp);
          el.appendChild(swatch);
        }
        swatch.title = t ? t(isRingMode ? 'filter.ring_color_label' : 'filter.map_color_label')
                          : (isRingMode ? 'Ring colour' : 'Map colour');
        swatch.querySelector('input').value = swatchColor;
        swatch.style.display = active ? '' : 'none';
      } else if (swatch) {
        swatch.style.display = 'none';
      }
    });
  }

  function buildDescriptors() {
    var descs = [];

    if (baseFilterId) {
      var f = FILTERS[baseFilterId];
      if (f) {
        descs.push({
          id:               baseFilterId,
          labelSet:         f.dynamic ? null : (f.labels || null),
          color:            f.color,
          ringColor:        f.ringColor,
          displayMode:      f.displayMode,
          backgroundHidden: f.backgroundHidden,
          isOverlay:        false
        });
      }
    }

    overlayFilterIds.forEach(function(fid) {
      var f = FILTERS[fid];
      if (f) {
        descs.push({
          id:               fid,
          labelSet:         f.dynamic ? null : (f.labels || null),
          color:            f.color,
          ringColor:        f.ringColor,
          displayMode:      f.displayMode,
          backgroundHidden: f.backgroundHidden,
          isOverlay:        true
        });
      }
    });

    return descs;
  }

  function pushToMap() {
    var descs = buildDescriptors();

    // Drive My Knowledge data fetch when it's an active overlay
    var mkActive = overlayFilterIds.has('my-knowledge') ||
                   baseFilterId === 'my-knowledge';
    if (mkActive) {
      fetch('/api/map/progress')
        .then(function(r) { return r.json(); })
        .then(function(progress) {
          if (typeof window.setKnowledgeFilter === 'function') {
            window.setKnowledgeFilter(progress, 50);
          }
          // setMapFilter is also called inside setKnowledgeFilter via refreshNodeColors,
          // but we still push descriptors so app.js knows the display mode
          if (typeof window.setMapFilter === 'function') window.setMapFilter(descs);
        })
        .catch(function() {});
    } else {
      if (typeof window.clearKnowledgeFilter === 'function') window.clearKnowledgeFilter();
      if (typeof window.setMapFilter === 'function') window.setMapFilter(descs);
    }
  }

  /* ─── Called from settings.html after a settings PATCH ──────────────── */
  window.updateFilterSettings = function(dbId, settings) {
    var fid = 'db-' + dbId;
    var f   = FILTERS[fid];
    if (!f) return;
    if (settings.background_hidden !== undefined) f.backgroundHidden = !!settings.background_hidden;
    if (settings.display_mode      !== undefined) f.displayMode      = settings.display_mode;
    if (settings.is_overlay        !== undefined) f.isOverlay        = !!settings.is_overlay;
    if (settings.ring_color        !== undefined) f.ringColor        = settings.ring_color;
    // Re-render swatch state
    updateActiveUI();
    // If this filter is currently active, re-push to map
    if (fid === baseFilterId || overlayFilterIds.has(fid)) pushToMap();
  };

})();
