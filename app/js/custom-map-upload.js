/* ═══════════════════════════════════════════════════════════════
   CUSTOM MAP — UPLOAD MODULE
   Owns: upload form, file parsing, metadata collection,
         kicking off the import API call.
   Calls: window.CMReview.show() when import results arrive.
   ═══════════════════════════════════════════════════════════════ */

window.CMUpload = (function () {

  var _selectedColor = 'terra';
  var _parsedTerms   = null;   // [{label, breadcrumb?}]
  var _subsetId      = null;

  /* ── Init ──────────────────────────────────────────────────── */
  function init() {
    _bindColorChips();
    _bindDropZone();
    _bindSubmit();
    document.getElementById('cm-upload-view').style.display = '';
    document.getElementById('cm-review-view').style.display = 'none';
  }

  /* ── Color chips ───────────────────────────────────────────── */
  function _bindColorChips() {
    document.querySelectorAll('.cm-color-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        document.querySelectorAll('.cm-color-chip').forEach(function (c) { c.classList.remove('selected'); });
        chip.classList.add('selected');
        _selectedColor = chip.dataset.color;
      });
    });
    // Select first chip by default
    var first = document.querySelector('.cm-color-chip');
    if (first) first.classList.add('selected');
  }

  /* ── Drop zone + file picker ───────────────────────────────── */
  function _bindDropZone() {
    var zone  = document.getElementById('cm-drop-zone');
    var input = document.getElementById('cm-file-input');
    var label = document.getElementById('cm-file-chosen');

    zone.addEventListener('click', function () { input.click(); });
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', function () { zone.classList.remove('drag-over'); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('drag-over');
      var file = e.dataTransfer.files[0];
      if (file) _handleFile(file, label);
    });
    input.addEventListener('change', function () {
      if (input.files[0]) _handleFile(input.files[0], label);
    });
  }

  function _handleFile(file, labelEl) {
    _parsedTerms = null;
    var reader = new FileReader();
    reader.onload = function (e) {
      var text = e.target.result;
      try {
        var terms = file.name.endsWith('.csv') ? _parseCSV(text) : _parseJSON(text);
        if (!terms.length) throw new Error('No valid entries found');
        _parsedTerms = terms;
        labelEl.textContent = file.name + ' — ' + terms.length + ' term' + (terms.length !== 1 ? 's' : '') + ' ready';
        labelEl.style.color = '#2E7A2E';
        _showMessage('', '');
      } catch (err) {
        labelEl.textContent = 'Error: ' + err.message;
        labelEl.style.color = '#8A3020';
        _parsedTerms = null;
      }
    };
    reader.readAsText(file);
  }

  /* ── File parsers ──────────────────────────────────────────── */
  function _parseJSON(text) {
    var data = JSON.parse(text);
    var nodes = Array.isArray(data) ? data : (data.nodes || []);
    return nodes
      .filter(function (n) { return n && typeof n.label === 'string' && n.label.trim(); })
      .map(function (n) { return { label: n.label.trim(), breadcrumb: (n.breadcrumb || '').trim() || undefined }; });
  }

  function _parseCSV(text) {
    var lines  = text.split(/\r?\n/);
    var header = lines[0].split(',').map(function (h) { return h.trim().toLowerCase(); });
    var li = header.indexOf('label');
    var bi = header.indexOf('breadcrumb');
    if (li === -1) throw new Error('CSV must have a "label" column');
    var terms = [];
    for (var i = 1; i < lines.length; i++) {
      var cols = _splitCSVLine(lines[i]);
      if (!cols[li] || !cols[li].trim()) continue;
      var entry = { label: cols[li].trim() };
      if (bi !== -1 && cols[bi] && cols[bi].trim()) entry.breadcrumb = cols[bi].trim();
      terms.push(entry);
    }
    return terms;
  }

  function _splitCSVLine(line) {
    var result = [];
    var cur = '';
    var inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { result.push(cur); cur = ''; continue; }
      cur += ch;
    }
    result.push(cur);
    return result;
  }

  /* ── Submit ────────────────────────────────────────────────── */
  function _bindSubmit() {
    document.getElementById('cm-import-btn').addEventListener('click', _submit);
  }

  async function _submit() {
    var name = document.getElementById('cm-name').value.trim();
    if (!name) { _showMessage('error', 'Please enter a name for this map.'); return; }

    var manual = window.CMManual && window.CMManual.isActive();
    var terms;
    if (manual) {
      terms = window.CMManual.getTerms();
      if (!terms.length) { _showMessage('error', 'Please add at least one node.'); return; }
    } else {
      if (!_parsedTerms || !_parsedTerms.length) { _showMessage('error', 'Please upload a JSON or CSV file first.'); return; }
      terms = _parsedTerms;
    }

    var btn     = document.getElementById('cm-import-btn');
    var spinner = document.getElementById('cm-spinner');
    btn.disabled = true;
    spinner.style.display = 'inline-block';
    _showMessage('', '');

    try {
      // Step 1: create subset
      var createRes = await _fetch('POST', '/api/subsets', {
        name: name,
        description: document.getElementById('cm-description').value.trim() || undefined,
        icon_color: _selectedColor,
      });
      _subsetId = createRes.id;

      // Step 2: run import + matching
      _showMessage('', '');
      var importRes = await _fetch('POST', '/api/subsets/' + _subsetId + '/import', {
        terms: terms,
      });

      // Hand off to review module
      window.CMReview.show(_subsetId, importRes.stagingRows);
    } catch (err) {
      _showMessage('error', 'Import failed: ' + err.message);
      btn.disabled = false;
      spinner.style.display = 'none';
    }
  }

  /* ── Helpers ───────────────────────────────────────────────── */
  function _showMessage(type, text) {
    var el = document.getElementById('cm-message');
    el.className = 'cm-message' + (type ? ' ' + type : '');
    el.textContent = text;
    el.style.display = type ? 'block' : 'none';
  }

  async function _fetch(method, url, body) {
    var r = await fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      var err = await r.json().catch(function () { return {}; });
      throw new Error(err.error || r.status);
    }
    return r.json();
  }

  return { init: init };

})();
