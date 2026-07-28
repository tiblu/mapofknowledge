/* ═══════════════════════════════════════════════════════════════
   CUSTOM MAP — MANUAL (SEARCH & ADD) MODULE
   Owns: the "Add nodes" tab — a search box (like the map's own)
         that adds real, exact nodes one at a time as rows.
   Exposes: isActive(), getTerms() — read by custom-map-upload.js
            at submit time to decide which input method to use.
   ═══════════════════════════════════════════════════════════════ */

window.CMManual = (function () {

  var _allNodes  = {};   // id -> { label, level }
  var _parentOf  = {};   // id -> parent id
  var _loaded    = false;
  var _rows      = [];   // [{ id, label, path }]  path = ancestor labels, root first, excluding self
  var _dropdownIdx = -1;

  var searchInput, dropdown, rowsEl;

  function init() {
    searchInput = document.getElementById('cm-manual-search');
    dropdown    = document.getElementById('cm-manual-dropdown');
    rowsEl      = document.getElementById('cm-manual-rows');
    if (!searchInput) return;

    _bindTabs();
    _bindSearch();
    _bindRowRemoval();
  }

  /* ── Method tabs ───────────────────────────────────────────── */
  function _bindTabs() {
    var uploadBtn = document.getElementById('cm-method-upload-btn');
    var searchBtn = document.getElementById('cm-method-search-btn');
    var uploadView = document.getElementById('cm-method-upload-view');
    var searchView = document.getElementById('cm-method-search-view');
    if (!uploadBtn || !searchBtn) return;

    uploadBtn.addEventListener('click', function () {
      uploadBtn.classList.add('active');
      searchBtn.classList.remove('active');
      uploadView.style.display = '';
      searchView.style.display = 'none';
    });
    searchBtn.addEventListener('click', function () {
      searchBtn.classList.add('active');
      uploadBtn.classList.remove('active');
      searchView.style.display = '';
      uploadView.style.display = 'none';
      _ensureLoaded();
    });
  }

  function isActive() {
    var btn = document.getElementById('cm-method-search-btn');
    return !!(btn && btn.classList.contains('active'));
  }

  /* ── Node data (fetched once, lazily) ────────────────────────── */
  function _ensureLoaded() {
    if (_loaded) return;
    _loaded = true;
    fetch('/api/map').then(function (r) { return r.json(); }).then(function (data) {
      (data.nodes || []).forEach(function (n) { _allNodes[n.id] = { label: n.label, level: n.level }; });
      (data.edges || []).forEach(function (e) { _parentOf[e.target] = e.source; });
    }).catch(function () {});
  }

  function _ancestorLabels(id) {
    var chain = [];
    var cur = _parentOf[id];
    var seen = {};
    while (cur !== undefined && !seen[cur]) {
      seen[cur] = true;
      var n = _allNodes[cur];
      if (!n) break;
      chain.unshift(n.label);
      cur = _parentOf[cur];
    }
    return chain;
  }

  /* ── Search box ────────────────────────────────────────────── */
  function _bindSearch() {
    searchInput.addEventListener('input', function () {
      _dropdownIdx = -1;
      var q = this.value.trim().toLowerCase();
      if (!q) { _closeDropdown(); return; }

      var addedIds = _rows.map(function (r) { return r.id; });
      var matches = Object.keys(_allNodes)
        .filter(function (id) { return _allNodes[id].label.toLowerCase().includes(q) && addedIds.indexOf(id) === -1; })
        .slice(0, 8);

      if (!matches.length) { _closeDropdown(); return; }

      dropdown.innerHTML = matches.map(function (id) {
        var path = _ancestorLabels(id).join(' › ');
        return '<div class="cm-manual-dropdown-item" data-node-id="' + _esc(id) + '">'
          + '<span class="cm-manual-dropdown-label">' + _esc(_allNodes[id].label) + '</span>'
          + (path ? '<span class="cm-manual-dropdown-path">' + _esc(path) + '</span>' : '')
          + '</div>';
      }).join('');
      dropdown.classList.add('visible');
    });

    dropdown.addEventListener('click', function (e) {
      var item = e.target.closest('.cm-manual-dropdown-item');
      if (!item) return;
      _addNode(item.dataset.nodeId);
    });

    searchInput.addEventListener('keydown', function (e) {
      var items = _dropdownItems();
      if (items.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        var next = e.key === 'ArrowDown'
          ? Math.min(_dropdownIdx + 1, items.length - 1)
          : Math.max(_dropdownIdx - 1, 0);
        _setDropdownActive(next);
        return;
      }
      if (e.key === 'Escape') { _closeDropdown(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();

      if (_dropdownIdx >= 0 && items[_dropdownIdx]) {
        _addNode(items[_dropdownIdx].dataset.nodeId);
        return;
      }
      // Enter with no highlighted item: single unambiguous match
      if (items.length === 1) _addNode(items[0].dataset.nodeId);
    });

    document.addEventListener('click', function (e) {
      if (!e.target.closest('.cm-manual-search-row')) _closeDropdown();
    });
  }

  function _dropdownItems() {
    return Array.from(dropdown.querySelectorAll('.cm-manual-dropdown-item'));
  }

  function _setDropdownActive(idx) {
    _dropdownItems().forEach(function (el, i) { el.classList.toggle('active', i === idx); });
    _dropdownIdx = idx;
  }

  function _closeDropdown() {
    dropdown.classList.remove('visible');
    dropdown.innerHTML = '';
    _dropdownIdx = -1;
  }

  /* ── Add / remove rows ────────────────────────────────────────── */
  function _addNode(id) {
    var n = _allNodes[id];
    if (!n) return;
    _rows.push({ id: id, label: n.label, path: _ancestorLabels(id) });
    searchInput.value = '';
    _closeDropdown();
    _renderRows();
    searchInput.focus();
  }

  function _bindRowRemoval() {
    rowsEl.addEventListener('click', function (e) {
      var btn = e.target.closest('.cm-manual-row-remove');
      if (!btn) return;
      var row = btn.closest('.cm-manual-row');
      var id = row.dataset.nodeId;
      _rows = _rows.filter(function (r) { return r.id !== id; });
      _renderRows();
    });
  }

  function _renderRows() {
    rowsEl.innerHTML = _rows.map(function (r) {
      var pathStr = r.path.join(' › ');
      return '<div class="cm-manual-row" data-node-id="' + _esc(r.id) + '">'
        + '<div class="cm-manual-row-text">'
        + '<div class="cm-manual-row-label">' + _esc(r.label) + '</div>'
        + (pathStr ? '<div class="cm-manual-row-path">' + _esc(pathStr) + '</div>' : '')
        + '</div>'
        + '<button type="button" class="cm-manual-row-remove" title="' + _esc(t('btn.remove')) + '">×</button>'
        + '</div>';
    }).join('');
  }

  /* ── Read out for submit ──────────────────────────────────────── */
  function getTerms() {
    return _rows.map(function (r) {
      return { label: r.label, breadcrumb: r.path.length ? r.path.join(' > ') : undefined };
    });
  }

  function _esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return { init: init, isActive: isActive, getTerms: getTerms };

})();
