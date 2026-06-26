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

  // Apply any saved color overrides to static filters on load
  Object.keys(FILTERS).forEach(function(fid) {
    var ov = getColorOverride(fid) || getRingColorOverride(fid);
    if (ov) { FILTERS[fid].color = ov; FILTERS[fid].ringColor = ov; }
  });

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
    try { return localStorage.getItem('kq_filter_color_' + filterId) || null; }
    catch(e) { return null; }
  }
  function setColorOverride(filterId, color) {
    try { localStorage.setItem('kq_filter_color_' + filterId, color); } catch(e) {}
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
          var color        = resolveColor(s.icon_color);
          var colorOverride   = getColorOverride(filterId) || getRingColorOverride(filterId);
          var overlayOverride = null;
          try { overlayOverride = localStorage.getItem('kq_is_overlay_' + filterId); } catch(e) {}
          FILTERS[filterId] = {
            label:           s.name,
            color:           colorOverride || color,
            dbId:            s.id,
            labels:          null,
            isOverlay:       overlayOverride !== null ? !!parseInt(overlayOverride) : !!s.is_overlay,
            displayMode:     s.display_mode || 'color',
            backgroundHidden: !!s.background_hidden,
            ringColor:       colorOverride || s.ring_color || color
          };
          var div = document.createElement('div');
          div.className = 'fp-item';
          div.dataset.filterId = filterId;
          div.style.setProperty('--fi-color', colorOverride || color);
          if (hidden.indexOf(filterId) !== -1) div.style.display = 'none';
          div.innerHTML = '<div class="fp-radio"></div><div class="fp-dot"></div>'
                        + '<span class="fp-label">' + s.name + '</span>';
          list.appendChild(div);
        });

        // Restore saved filter, or default to Estonian Basic School 2023 (db-1)
        var saved;
        try { saved = localStorage.getItem('kq_base_filter'); } catch(e) { saved = null; }
        if (saved === null) saved = 'db-1';   // first visit default
        if (saved && saved !== 'none' && FILTERS[saved]) {
          baseFilterId = saved;
          ensureFilterLabels(saved, FILTERS[saved]);
          updateActiveUI();
        }
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
    // ring color picker clicks are handled separately — don't treat as filter toggle
    if (e.target.closest('.fp-ring-swatch')) return;

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

  /* ─── Filter color swatch (delegated, filter panel) ─────────────────── */
  list.addEventListener('change', function (e) {
    var swatch = e.target.closest('.fp-ring-swatch');
    if (!swatch) return;
    var fid = swatch.dataset.filterId;
    var color = e.target.value;
    if (FILTERS[fid]) {
      FILTERS[fid].color = color;
      FILTERS[fid].ringColor = color;
    }
    setColorOverride(fid, color);
    var item = document.querySelector('.fp-item[data-filter-id="' + fid + '"]');
    if (item) item.style.setProperty('--fi-color', color);
    pushToMap();
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
    try { localStorage.setItem('kq_base_filter', fid || 'none'); } catch(e) {}
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

      // show/hide filter color swatch (all display modes)
      var filter = FILTERS[fid];
      var swatch = el.querySelector('.fp-ring-swatch');
      if (filter) {
        if (!swatch) {
          swatch = document.createElement('label');
          swatch.className = 'fp-ring-swatch';
          swatch.dataset.filterId = fid;
          swatch.title = t ? t('filter.ring_color_label') : 'Filter colour';
          var inp = document.createElement('input');
          inp.type = 'color';
          inp.value = filter.color || filter.ringColor || '#C4826A';
          swatch.appendChild(inp);
          el.appendChild(swatch);
        }
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
