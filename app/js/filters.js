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
      backgroundHidden: false,
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
    try { return localStorage.getItem('kq_ring_color_' + filterId) || null; }
    catch(e) { return null; }
  }
  function setRingColorOverride(filterId, color) {
    try { localStorage.setItem('kq_ring_color_' + filterId, color); } catch(e) {}
  }

  function getColorOverride(filterId) {
    try { return localStorage.getItem('kq_color_' + filterId) || null; }
    catch(e) { return null; }
  }
  function setColorOverride(filterId, color) {
    try { localStorage.setItem('kq_color_' + filterId, color); } catch(e) {}
  }

  (function loadDBSubsets() {
    var hidden;
    try { hidden = JSON.parse(localStorage.getItem('kq_filter_hidden') || '[]'); }
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
      })
      .catch(function() {});
  })();

  /* ─── Apply visibility from localStorage ────────────────────────────── */
  (function applyVisibility() {
    var hidden;
    try { hidden = JSON.parse(localStorage.getItem('kq_filter_hidden') || '[]'); }
    catch(e) { hidden = []; }
    if (!hidden.length) return;
    document.querySelectorAll('.fp-item').forEach(function(item) {
      if (hidden.indexOf(item.dataset.filterId) !== -1) {
        item.style.display = 'none';
      }
    });
  })();

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
      } else {
        baseFilterId = fid;
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

  function deactivateAll() {
    baseFilterId = null;
    overlayFilterIds.clear();
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
