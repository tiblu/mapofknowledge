/* ══════════════════════════════════════════════════════════════════════════
   KNOWLEDGE ESTIMATION ADD-ON — js/knowledge-estimate.js
   ──────────────────────────────────────────────────────────────────────────
   Self-contained modal, built entirely in JS (no static markup needed on the
   host page — just this <script> tag). Two entry points:
     window.KnowledgeEstimate.maybePromptFirstTime()  — called once by tour.js
       right after the tour finishes/is skipped; no-ops if already prompted
       or the role gate excludes this user.
     window.KnowledgeEstimate.openManual()            — called from the
       Qualifications card's own trigger icon, any time later.

   Flow: intro -> entry (repeatable qualification rows) -> loading (server
   runs the two-pass LLM estimation) -> review (grouped/collapsible, all
   toggled on by default, running counter) -> commit -> done. Nothing is
   written to user_node_knowledge until the user confirms the review step.

   ROLE GATE (temporary — remove to enable for everyone):
   Visible only to admin/super_admin while this feature is being reviewed.
   To enable for all users once reviewed, delete the two lines marked below.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  // TEMPORARY ROLE GATE — delete this line and the `if` line inside
  // _roleAllowed() below to enable this feature for every user tier.
  var ROLE_GATE_ENABLED = true;
  function _roleAllowed(role) {
    if (!ROLE_GATE_ENABLED) return true;
    return role === 'admin' || role === 'super_admin';
  }

  var MAX_TEXT_CHARS = 4000; // matches server/routes/api.js's MAX_FREE_TEXT_CHARS

  var _modal = null;
  var _mode = 'manual'; // 'firsttime' | 'manual'
  var _rowSeq = 0;
  var _credentialIds = [];
  var _candidates = [];
  var _approved = null; // Set of candidate ids currently toggled on

  function _icon() {
    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none">'
      + '<path d="M10 2L3 6v5c0 4 3 6.5 7 7 4-0.5 7-3 7-7V6l-7-4z" stroke="white" stroke-width="1.3" stroke-linejoin="round"/>'
      + '<path d="M7 10l2 2 4-4" stroke="white" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
      + '</svg>';
  }

  function _qualRowHtml(id) {
    return '<div class="ke-qual-row" data-row-id="' + id + '">'
      + '<button type="button" class="ke-qual-row-remove" data-remove="' + id + '" aria-label="Remove">×</button>'
      + '<input type="text" class="ke-q-title" maxlength="255" placeholder="' + t('placeholder.ke_qualification') + '">'
      + '<input type="text" class="ke-q-issuer" maxlength="255" placeholder="' + t('placeholder.ke_issuer') + '">'
      + '<input type="number" class="ke-q-year" min="1900" max="2099" placeholder="' + t('placeholder.ke_year') + '">'
      + '<input type="text" class="ke-q-details" maxlength="500" placeholder="' + t('placeholder.ke_details') + '">'
      + '</div>';
  }

  function _buildModal() {
    var el = document.createElement('div');
    el.id = 'ke-modal';
    el.className = 'ke-modal';
    el.innerHTML =
      '<div class="ke-box">' +

      '<div class="ke-step" data-step="intro">' +
        '<div class="ke-icon-wrap">' + _icon() + '</div>' +
        '<div class="ke-title" id="ke-intro-title"></div>' +
        '<div class="ke-text" id="ke-intro-text"></div>' +
        '<div class="ke-actions">' +
          '<button class="ke-btn ke-btn-primary" id="ke-intro-start"></button>' +
          '<button class="ke-btn ke-btn-secondary" id="ke-intro-skip"></button>' +
        '</div>' +
      '</div>' +

      '<div class="ke-step" data-step="entry">' +
        '<div class="ke-title" data-i18n="label.ke_entry_title">' + t('label.ke_entry_title') + '</div>' +
        '<div class="ke-text" data-i18n="msg.ke_entry_text">' + t('msg.ke_entry_text') + '</div>' +
        '<div class="ke-qual-rows" id="ke-qual-rows"></div>' +
        '<button type="button" class="ke-add-row-btn" id="ke-add-row">' + t('btn.ke_add_another') + '</button>' +
        '<div class="ke-actions-row" style="margin-top:12px">' +
          '<button class="ke-btn ke-btn-secondary" id="ke-entry-cancel">' + t('btn.cancel') + '</button>' +
          '<button class="ke-btn ke-btn-primary" id="ke-entry-submit">' + t('btn.ke_estimate') + '</button>' +
        '</div>' +
      '</div>' +

      '<div class="ke-step ke-loading-wrap" data-step="loading">' +
        '<div class="ke-title">' + t('msg.ke_loading_title') + '</div>' +
        '<div class="ke-text">' + t('msg.ke_loading_text') + '</div>' +
        '<div class="ke-loading-dots"><span></span><span></span><span></span></div>' +
      '</div>' +

      '<div class="ke-step" data-step="review">' +
        '<div class="ke-title">' + t('label.ke_review_title') + '</div>' +
        '<div class="ke-review-bar">' +
          '<span class="ke-counter" id="ke-counter"></span>' +
          '<div class="ke-collapse-links">' +
            '<button type="button" id="ke-expand-all">' + t('btn.ke_expand_all') + '</button>' +
            '<button type="button" id="ke-collapse-all">' + t('btn.ke_collapse_all') + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="ke-review-list" id="ke-review-list"></div>' +
        '<div class="ke-actions-row">' +
          '<button class="ke-btn ke-btn-secondary" id="ke-review-cancel">' + t('btn.cancel') + '</button>' +
          '<button class="ke-btn ke-btn-primary" id="ke-review-confirm"></button>' +
        '</div>' +
      '</div>' +

      '<div class="ke-step" data-step="empty">' +
        '<div class="ke-title">' + t('label.ke_empty_title') + '</div>' +
        '<div class="ke-text">' + t('msg.ke_empty_text') + '</div>' +
        '<div class="ke-actions"><button class="ke-btn ke-btn-primary" id="ke-empty-close">' + t('btn.close') + '</button></div>' +
      '</div>' +

      '<div class="ke-step" data-step="error">' +
        '<div class="ke-title">' + t('label.ke_error_title') + '</div>' +
        '<div class="ke-text">' + t('msg.ke_error_text') + '</div>' +
        '<div class="ke-actions"><button class="ke-btn ke-btn-primary" id="ke-error-close">' + t('btn.close') + '</button></div>' +
      '</div>' +

      '<div class="ke-step" data-step="done">' +
        '<div class="ke-title">' + t('label.ke_done_title') + '</div>' +
        '<div class="ke-text" id="ke-done-text"></div>' +
        '<div class="ke-actions"><button class="ke-btn ke-btn-primary" id="ke-done-close">' + t('btn.close') + '</button></div>' +
      '</div>' +

      '</div>';
    document.body.appendChild(el);
    _wireStaticEvents(el);
    return el;
  }

  function _ensureModal() {
    if (!_modal) _modal = _buildModal();
    return _modal;
  }

  function _showStep(name) {
    var steps = _modal.querySelectorAll('.ke-step');
    for (var i = 0; i < steps.length; i++) steps[i].classList.toggle('active', steps[i].getAttribute('data-step') === name);
  }

  function _open() {
    _ensureModal().classList.add('active');
  }
  function _close() {
    if (_modal) _modal.classList.remove('active');
  }

  function _resetEntryStep() {
    var wrap = document.getElementById('ke-qual-rows');
    wrap.innerHTML = '';
    _rowSeq = 0;
    _addRow();
  }

  function _addRow() {
    _rowSeq++;
    var wrap = document.getElementById('ke-qual-rows');
    var div = document.createElement('div');
    div.innerHTML = _qualRowHtml(_rowSeq);
    wrap.appendChild(div.firstChild);
  }

  function _collectRows() {
    var rows = document.querySelectorAll('.ke-qual-row');
    var out = [];
    rows.forEach(function (row) {
      var title = row.querySelector('.ke-q-title').value.trim();
      if (!title) return;
      out.push({
        title: title.slice(0, 255),
        issuer: row.querySelector('.ke-q-issuer').value.trim().slice(0, 255),
        year: row.querySelector('.ke-q-year').value.trim(),
        details: row.querySelector('.ke-q-details').value.trim().slice(0, MAX_TEXT_CHARS),
      });
    });
    return out;
  }

  function _submitEntry() {
    var newQualifications = _collectRows();
    _showStep('loading');
    fetch('/api/knowledge-estimate/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newQualifications: newQualifications }),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) { _showStep('error'); return; }
        _credentialIds = res.d.credentialIds || [];
        _candidates = res.d.candidates || [];
        if (!_candidates.length) { _showStep('empty'); return; }
        _approved = new Set(_candidates.map(function (c) { return c.id; }));
        _renderReview();
        _showStep('review');
      })
      .catch(function () { _showStep('error'); });
  }

  function _renderReview() {
    var groups = {}, order = [];
    _candidates.forEach(function (c) {
      var d = c.domain || 'Other';
      if (!groups[d]) { groups[d] = []; order.push(d); }
      groups[d].push(c);
    });
    var domainList = order.map(function (d) {
      var members = groups[d];
      var avg = Math.round(members.reduce(function (s, c) { return s + c.percentage; }, 0) / members.length);
      return { domain: d, members: members, avg: avg };
    });
    domainList.sort(function (a, b) { return b.avg - a.avg; });

    var html = domainList.map(function (g) {
      var rows = g.members.map(function (c) {
        return '<div class="ke-leaf-row" data-leaf-id="' + c.id + '">' +
          '<button type="button" class="ke-toggle on" data-toggle-id="' + c.id + '"><div class="ke-toggle-thumb"></div></button>' +
          '<span class="ke-leaf-label" title="' + _esc(c.breadcrumb) + '">' + _esc(c.label) + '</span>' +
          '<span class="ke-leaf-pct">' + c.percentage + '%</span>' +
        '</div>';
      }).join('');
      return '<div class="ke-domain-group">' +
        '<div class="ke-domain-heading" data-toggle-group="1">' +
          '<span class="ke-domain-chevron"><svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M2 3l2.5 3L7 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' +
          '<span class="ke-domain-name">' + _esc(g.domain) + '</span>' +
          '<span class="ke-domain-count">' + g.members.length + '</span>' +
        '</div>' +
        '<div class="ke-domain-members">' + rows + '</div>' +
      '</div>';
    }).join('');

    document.getElementById('ke-review-list').innerHTML = html;
    _updateCounter();
  }

  function _esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function _updateCounter() {
    var el = document.getElementById('ke-counter');
    if (el) el.textContent = _approved.size + ' ' + t('label.ke_of') + ' ' + _candidates.length + ' ' + t('label.ke_selected');
  }

  function _submitReview() {
    var approvedLeaves = _candidates
      .filter(function (c) { return _approved.has(c.id); })
      .map(function (c) { return { id: c.id, percentage: c.percentage, retention: c.retention }; });

    var btn = document.getElementById('ke-review-confirm');
    btn.disabled = true;
    fetch('/api/knowledge-estimate/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credentialIds: _credentialIds, approved: approvedLeaves }),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        btn.disabled = false;
        if (!res.ok) { _showStep('error'); return; }
        document.getElementById('ke-done-text').textContent =
          (res.d.written || 0) + ' ' + t('msg.ke_done_text_suffix');
        _showStep('done');
        if (window.MapView && window.MapView.refreshProgress) window.MapView.refreshProgress();
      })
      .catch(function () { btn.disabled = false; _showStep('error'); });
  }

  function _markPrompted() {
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'knowledge_estimation_prompted', value: '1' }),
    }).catch(function () {});
  }

  function _wireStaticEvents(el) {
    document.getElementById('ke-add-row').addEventListener('click', _addRow);

    document.getElementById('ke-qual-rows').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-remove]');
      if (!btn) return;
      var rows = document.querySelectorAll('.ke-qual-row');
      if (rows.length <= 1) return; // always keep at least one row
      btn.closest('.ke-qual-row').remove();
    });

    document.getElementById('ke-entry-cancel').addEventListener('click', _close);
    document.getElementById('ke-entry-submit').addEventListener('click', _submitEntry);
    document.getElementById('ke-review-cancel').addEventListener('click', _close);
    document.getElementById('ke-review-confirm').addEventListener('click', _submitReview);
    document.getElementById('ke-empty-close').addEventListener('click', _close);
    document.getElementById('ke-error-close').addEventListener('click', _close);
    document.getElementById('ke-done-close').addEventListener('click', _close);

    document.getElementById('ke-intro-start').addEventListener('click', function () {
      _resetEntryStep();
      _showStep('entry');
    });
    document.getElementById('ke-intro-skip').addEventListener('click', function () {
      _markPrompted();
      _close();
    });

    document.getElementById('ke-review-list').addEventListener('click', function (e) {
      var toggleBtn = e.target.closest('[data-toggle-id]');
      if (toggleBtn) {
        var id = toggleBtn.getAttribute('data-toggle-id');
        var isOn = toggleBtn.classList.toggle('on');
        if (isOn) _approved.add(id); else _approved.delete(id);
        _updateCounter();
        return;
      }
      var heading = e.target.closest('[data-toggle-group]');
      if (heading) heading.closest('.ke-domain-group').classList.toggle('collapsed');
    });

    document.getElementById('ke-expand-all').addEventListener('click', function () {
      document.querySelectorAll('.ke-domain-group').forEach(function (g) { g.classList.remove('collapsed'); });
    });
    document.getElementById('ke-collapse-all').addEventListener('click', function () {
      document.querySelectorAll('.ke-domain-group').forEach(function (g) { g.classList.add('collapsed'); });
    });
  }

  function _setIntroCopy(mode) {
    var title = mode === 'firsttime' ? t('label.ke_intro_firsttime_title') : t('label.ke_intro_manual_title');
    var text  = mode === 'firsttime' ? t('msg.ke_intro_firsttime_text')  : t('msg.ke_intro_manual_text');
    document.getElementById('ke-intro-title').textContent = title;
    document.getElementById('ke-intro-text').textContent = text;
    document.getElementById('ke-intro-start').textContent = t('btn.ke_add_education');
    document.getElementById('ke-intro-skip').textContent = mode === 'firsttime' ? t('btn.ke_skip_for_now') : t('btn.cancel');
    document.getElementById('ke-review-confirm').textContent = t('btn.ke_add_to_knowledge');
  }

  window.KnowledgeEstimate = {
    maybePromptFirstTime: function () {
      fetch('/auth/me').then(function (r) { return r.json(); }).then(function (user) {
        if (!user || !_roleAllowed(user.role)) return;
        fetch('/api/settings').then(function (r) { return r.json(); }).then(function (settings) {
          if (settings && settings.knowledge_estimation_prompted === '1') return;
          _mode = 'firsttime';
          _ensureModal();
          _setIntroCopy('firsttime');
          _open();
          _showStep('intro');
        }).catch(function () {});
      }).catch(function () {});
    },
    openManual: function () {
      _mode = 'manual';
      _ensureModal();
      _setIntroCopy('manual');
      _open();
      _showStep('intro');
    },
    isRoleAllowed: _roleAllowed,
  };
}());
