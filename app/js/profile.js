/* ══════════════════════════════════════════════
   LEARNER PASSPORT  —  js/profile.js
   Loads real data from /api/profile and renders
   each section, replacing the static mockup.
   ══════════════════════════════════════════════ */

(function () {

  /* ─── Helpers ─────────────────────────────────────────────────── */
  function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function initials(name) {
    if (!name) return '?';
    return name.trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  }

  function fmtDate(d) {
    if (!d) return '';
    try { return new Date(d).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch { return String(d).substring(0, 7); }
  }

  function empty(msg) {
    return `<div class="p-empty">${esc(msg)}</div>`;
  }

  /* ─── Render functions ────────────────────────────────────────── */

  function renderIdentity(passport) {
    const name  = passport.display_name || t('label.your_name');
    const about = passport.about || '';

    // Top-bar banner
    const banner = document.querySelector('.topbar-banner-inner');
    if (banner) banner.innerHTML = `<span class="topbar-banner-dot"></span>${t('label.learner_passport')} — ${esc(name)}`;

    // Left nav
    const avatarCircle = document.querySelector('.pnav-avatar-circle');
    if (avatarCircle) avatarCircle.textContent = initials(name);
    const navName = document.querySelector('.pnav-name');
    if (navName) navName.textContent = name;
    const navTagline = document.querySelector('.pnav-tagline');
    if (navTagline) navTagline.textContent = passport.location || '';

    // Identity card
    const idCard = document.getElementById('identity-card');
    if (idCard) {
      idCard.innerHTML = `
        <div class="p-card-title">${t('section.identity')}</div>
        <div class="p-kv">
          <div class="p-kv-label">${t('label.full_name')}</div>
          <div class="p-kv-value" data-field="display_name">${esc(passport.display_name || '')}</div>
          <div class="p-kv-label">${t('label.year_of_birth')}</div>
          <div class="p-kv-value" data-field="birth_year">${esc(passport.birth_year || '')}</div>
          <div class="p-kv-label">${t('label.language')}</div>
          <div class="p-kv-value" data-field="location">${esc(passport.location || '')}</div>
          <div class="p-kv-label">${t('label.culture')}</div>
          <div class="p-kv-value" data-field="cultural_background">${esc(passport.cultural_background || '')}</div>
          <div class="p-kv-label">${t('label.id_number')}</div>
          <div class="p-kv-value" data-field="id_number">${esc(passport.id_number || '')}</div>
        </div>
        <button class="p-edit-btn" onclick="window.editIdentity()">${t('btn.edit')}</button>`;
    }

    // Learning needs and preferences card
    const aboutCard = document.getElementById('about-card');
    if (aboutCard) {
      aboutCard.innerHTML = `<div class="p-card-title">${t('section.learning_needs')}</div>` + (about
        ? `<div class="p-kv-value p-about-text">${esc(about)}</div>
           <button class="p-edit-btn" onclick="window.editAbout()">${t('btn.edit')}</button>`
        : `${empty(t('placeholder.about'))}
           <button class="p-edit-btn" onclick="window.editAbout()">${t('btn.add')}</button>`);
    }
  }

  function renderInterests(tags) {
    const interests = (tags || []).filter(t => t.type === 'interest');
    const values    = (tags || []).filter(t => t.type === 'value');

    const card = document.getElementById('interests-card');
    if (!card) return;

    const iHtml = interests.length
      ? interests.map(t => `<span class="p-tag interest">${esc(t.text)}</span>`).join('')
      : `<span class="p-tag-empty">${window.t('msg.none_added_yet')}</span>`;
    const vHtml = values.length
      ? values.map(t => `<span class="p-tag value">${esc(t.text)}</span>`).join('')
      : `<span class="p-tag-empty">${window.t('msg.none_added_yet')}</span>`;

    card.innerHTML = `
      <div class="p-subsection-block-sm">
        <div class="p-subsection-label">${window.t('label.core_interests')}</div>
        <div class="p-tags">${iHtml}</div>
      </div>
      <div>
        <div class="p-subsection-label">${window.t('label.values')}</div>
        <div class="p-tags">${vHtml}</div>
      </div>
      <button class="p-edit-btn" onclick="window.editInterests()">${window.t('btn.edit')}</button>`;
  }

  window.editInterests = function () {
    const card = document.getElementById('interests-card');
    if (!card) return;

    function tagRow(t) {
      return `<span class="p-tag ${esc(t.type)} p-tag-removable">
        ${esc(t.text)}
        <button onclick="window.deleteTag(${t.id})" class="p-tag-remove-btn" title="Remove">×</button>
      </span>`;
    }

    function addRow(type) {
      var placeholderKey = 'placeholder.add_' + type;
      return `<div class="p-tag-add-row">
        <input id="tag-input-${type}" class="p-edit-input p-flex-1" placeholder="${esc(window.t(placeholderKey))}" onkeydown="if(event.key==='Enter')window.addTag('${type}')">
        <button class="p-edit-btn primary p-edit-btn-inline p-edit-btn-nowrap" onclick="window.addTag('${type}')">+ ${window.t('btn.add')}</button>
      </div>`;
    }

    function rebuild() {
      fetch('/api/profile').then(r => r.json()).then(d => {
        const interests = (d.tags || []).filter(t => t.type === 'interest');
        const values    = (d.tags || []).filter(t => t.type === 'value');
        document.getElementById('tag-list-interest').innerHTML =
          interests.length ? interests.map(tagRow).join('') : `<span class="p-tag-empty">${window.t('msg.none_yet')}</span>`;
        document.getElementById('tag-list-value').innerHTML =
          values.length ? values.map(tagRow).join('') : `<span class="p-tag-empty">${window.t('msg.none_yet')}</span>`;
      });
    }
    window._rebuildTags = rebuild;

    fetch('/api/profile').then(r => r.json()).then(d => {
      const interests = (d.tags || []).filter(t => t.type === 'interest');
      const values    = (d.tags || []).filter(t => t.type === 'value');
      card.innerHTML = `
        <div class="p-subsection-block">
          <div class="p-subsection-label">${window.t('label.core_interests')}</div>
          <div class="p-tags" id="tag-list-interest">${interests.length ? interests.map(tagRow).join('') : `<span class="p-tag-empty">${window.t('msg.none_yet')}</span>`}</div>
          ${addRow('interest')}
        </div>
        <div>
          <div class="p-subsection-label">${window.t('label.values')}</div>
          <div class="p-tags" id="tag-list-value">${values.length ? values.map(tagRow).join('') : `<span class="p-tag-empty">${window.t('msg.none_yet')}</span>`}</div>
          ${addRow('value')}
        </div>
        <button class="p-edit-btn p-edit-btn-done" onclick="window.loadProfile()">${window.t('btn.done')}</button>`;
    });
  };

  window.addTag = function (type) {
    const inp = document.getElementById('tag-input-' + type);
    const text = inp ? inp.value.trim() : '';
    if (!text) return;
    inp.value = '';
    fetch('/api/profile/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, text }),
    }).then(() => { if (window._rebuildTags) window._rebuildTags(); })
      .catch(() => {});
  };

  window.deleteTag = function (id) {
    fetch('/api/profile/tags/' + id, { method: 'DELETE' })
      .then(() => { if (window._rebuildTags) window._rebuildTags(); })
      .catch(() => {});
  };

  function renderLearningStyle(style) {
    const card = document.getElementById('learning-style-card');
    if (!card) return;
    if (!style) {
      card.innerHTML = `${empty(t('msg.learning_style_empty'))}
        <button class="p-edit-btn" onclick="window.editLearningStyle()">${t('btn.add_learning_style')}</button>`;
      return;
    }
    const rows = [
      [t('label.modalities'),     style.modalities],
      [t('label.peak_time'),      style.peak_time],
      [t('label.session_length'), style.session_length],
      [t('label.works_best'),     style.works_best],
      [t('label.needs'),          style.needs],
      [t('label.accessibility'),  style.accessibility],
    ].filter(([, v]) => v);
    card.innerHTML = `<div class="p-kv">
      ${rows.map(([k, v]) => `<div class="p-kv-label">${esc(k)}</div><div class="p-kv-value">${esc(v)}</div>`).join('')}
    </div>
    <button class="p-edit-btn" onclick="window.editLearningStyle()">${t('btn.edit')}</button>`;
  }

  // ── Events state ──────────────────────────────────────────────────
  var _allEvents  = [];
  var _evShowing  = 5;
  var _evFilter   = { type: 'all', dateFrom: '', dateTo: '' };

  function _evDate(ev) { return (ev.event_date || '').toString().split('T')[0]; }

  function _filteredEvents() {
    return _allEvents.filter(function(ev) {
      if (_evFilter.type !== 'all' && ev.type !== _evFilter.type) return false;
      const d = _evDate(ev);
      if (_evFilter.dateFrom && d < _evFilter.dateFrom) return false;
      if (_evFilter.dateTo   && d > _evFilter.dateTo)   return false;
      return true;
    });
  }

  function _renderEventsWithState() {
    const ledger = document.getElementById('events-ledger');
    if (!ledger) return;

    const filtered = _filteredEvents();

    // Type filter pills
    const typePills = ['all','activity','assessment','evidence'].map(function(type) {
      const label  = type === 'all' ? window.t('tab.all') : (window.t('label.' + type) || (type.charAt(0).toUpperCase() + type.slice(1)));
      const active = _evFilter.type === type;
      return `<button onclick="window.setEvTypeFilter('${type}')" class="p-ev-pill ${active ? 'p-ev-pill-active' : 'p-ev-pill-inactive'}">${label}</button>`;
    }).join('');

    const hasDates  = _evFilter.dateFrom || _evFilter.dateTo;
    const clearBtn  = hasDates
      ? `<button onclick="window.clearEvDates()" title="Clear date filter" class="p-ev-clear-btn">✕</button>`
      : '';

    const filterRow = `
      <div class="p-ev-filter-row">
        <div class="p-ev-type-pills">${typePills}</div>
        <div class="p-ev-date-row">
          <input type="date" class="p-edit-input p-ev-date-input"
            value="${_evFilter.dateFrom}" onblur="window.setEvDateFilter('from',this.value)">
          <span class="p-ev-date-sep">–</span>
          <input type="date" class="p-edit-input p-ev-date-input"
            value="${_evFilter.dateTo}" onblur="window.setEvDateFilter('to',this.value)">
          ${clearBtn}
        </div>
      </div>`;

    const rowsHtml = !filtered.length
      ? empty(_allEvents.length ? t('msg.no_events_filter') : t('msg.no_events'))
      : filtered.map(function(ev) {
          var titleHtml = esc(ev.title);
          if (ev.node_external_id) {
            var sep = ev.title.indexOf(': ');
            if (sep !== -1) {
              titleHtml = esc(ev.title.slice(0, sep + 2)) +
                `<a class="p-event-node-link" href="/app/?node=${esc(ev.node_external_id)}">${esc(ev.title.slice(sep + 2))}</a>`;
            }
          }
          var delBtn = ev.user_created
            ? `<button onclick="window.deleteEvent(${ev.id})" title="Remove" class="p-row-delete-btn">×</button>`
            : '';
          return `<div class="p-ledger-row">
            <div class="p-ledger-date">${fmtDate(ev.event_date)}</div>
            <div class="p-ledger-info">
              <div class="p-ledger-title">${titleHtml}${delBtn}</div>
              ${ev.institution ? `<div class="p-ledger-sub">${esc(ev.institution)}</div>` : ''}
              ${ev.result ? `<div class="p-ledger-result">${esc(ev.result)}</div>` : ''}
            </div>
            <span class="p-type ${esc(ev.type)}">${esc(ev.type.charAt(0).toUpperCase() + ev.type.slice(1))}</span>
          </div>`;
        }).join('');

    const scrollList = `<div class="p-scroll-lg">${rowsHtml}</div>`;

    const today   = new Date().toISOString().split('T')[0];
    const srcOpts = ['Book','YouTube video','Conference','Workshop','Self-study period','Other']
      .map(function(s) { return `<option value="${s}">${s}</option>`; }).join('');

    ledger.innerHTML = `<div class="p-card-title">${t('section.events') || 'Events'}</div>` + filterRow + scrollList + `
      <button class="p-edit-btn p-ev-add-btn" id="ev-add-btn"
        onclick="document.getElementById('ev-form').style.display='';this.style.display='none';document.getElementById('ev-title').focus()">
        ${t('btn.add_activity')}
      </button>
      <div id="ev-form" style="display:none" class="p-ev-form">
        <div class="p-form-grid">
          <input id="ev-title" class="p-edit-input" placeholder="${esc(t('placeholder.event_title'))}">
          <div class="p-flex-row">
            <select id="ev-source" class="p-edit-input p-flex-1">${srcOpts}</select>
            <input id="ev-provider" class="p-edit-input p-flex-1-5" placeholder="${esc(t('placeholder.event_provider'))}">
          </div>
          <div class="p-flex-row">
            <input id="ev-date" type="date" class="p-edit-input p-flex-1" value="${today}">
            <input id="ev-notes" class="p-edit-input p-flex-2" placeholder="${esc(t('placeholder.event_notes'))}">
          </div>
          <textarea id="ev-reflection" class="p-edit-input p-textarea-full"
            placeholder="${esc(t('placeholder.event_reflection'))}"></textarea>
          <div class="p-form-btn-row">
            <button class="p-edit-btn primary p-edit-btn-inline" onclick="window.saveManualEvent()">${t('btn.add')}</button>
            <button class="p-edit-btn p-edit-btn-inline" onclick="document.getElementById('ev-form').style.display='none';document.getElementById('ev-add-btn').style.display=''">${t('btn.cancel')}</button>
          </div>
        </div>
      </div>`;
  }

  function renderEvents(events) {
    _allEvents  = events || [];
    _evShowing  = 5;
    _renderEventsWithState();
  }

  window.setEvTypeFilter = function(type) {
    _evFilter.type = type; _renderEventsWithState();
  };
  window.setEvDateFilter = function(which, val) {
    if (which === 'from') _evFilter.dateFrom = val;
    else _evFilter.dateTo = val;
    _renderEventsWithState();
  };
  window.clearEvDates = function() {
    _evFilter.dateFrom = ''; _evFilter.dateTo = ''; _renderEventsWithState();
  };

  window.saveManualEvent = function () {
    const title      = document.getElementById('ev-title').value.trim();
    if (!title) { document.getElementById('ev-title').focus(); return; }
    const source     = document.getElementById('ev-source').value;
    const provider   = document.getElementById('ev-provider').value.trim();
    const date       = document.getElementById('ev-date').value;
    const notes      = document.getElementById('ev-notes').value.trim();
    const reflection = document.getElementById('ev-reflection').value.trim();
    const institution = source + (provider ? ' — ' + provider : '');
    fetch('/api/profile/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, institution, result: notes || null, event_date: date, reflection: reflection || null }),
    }).then(() => window.loadProfile()).catch(() => {});
  };

  window.deleteEvent = function (id) {
    fetch('/api/profile/events/' + id, { method: 'DELETE' })
      .then(() => window.loadProfile()).catch(() => {});
  };

  function renderRelationships(relationships) {
    var individuals = (relationships || []).filter(function(r) { return r.type === 'individual'; });
    var groups      = (relationships || []).filter(function(r) { return r.type === 'group'; });
    var providers   = (relationships || []).filter(function(r) { return r.type === 'institution' || r.type === 'tool'; });

    function delBtn(id) {
      return `<button onclick="window.deleteRelationship(${id})" title="Remove" class="p-row-delete-btn">×</button>`;
    }

    function addForm(type, fields, btnLabel) {
      var inputs = fields.map(function(f) {
        if (f.type === 'select') {
          var opts = f.options.map(function(o) { return `<option value="${o.v}">${o.l}</option>`; }).join('');
          return `<select id="rel-${f.id}" class="p-edit-input">${opts}</select>`;
        }
        return `<input id="rel-${f.id}" class="p-edit-input" placeholder="${esc(f.label)}">`;
      }).join('');
      return `
        <button class="p-edit-btn p-rel-add-btn" id="rel-add-btn-${type}"
          onclick="document.getElementById('rel-form-${type}').style.display='';this.style.display='none';document.getElementById('rel-f0-${type}').focus()">
          + ${t('btn.add')}
        </button>
        <div id="rel-form-${type}" style="display:none" class="p-rel-form">
          <div class="p-form-grid-sm">${inputs}
            <div class="p-flex-row-sm">
              <button class="p-edit-btn primary p-edit-btn-inline" onclick="window.saveRelationship('${type}')">${btnLabel}</button>
              <button class="p-edit-btn p-edit-btn-inline" onclick="document.getElementById('rel-form-${type}').style.display='none';document.getElementById('rel-add-btn-${type}').style.display=''">${t('btn.cancel')}</button>
            </div>
          </div>
        </div>`;
    }

    // ── Profs, mentors, role models ──
    var indCard = document.getElementById('individuals-card');
    if (indCard) {
      var indRows = !individuals.length
        ? empty(t('msg.no_individuals'))
        : individuals.map(function(r) {
            return `<div class="p-person p-person-row">
              <div class="p-person-avatar">${esc(r.name.split(' ').map(function(w){return w[0];}).slice(0,2).join('').toUpperCase())}</div>
              <div class="p-flex-1-noclip">
                <div class="p-person-name">${esc(r.name)}${delBtn(r.id)}</div>
                ${r.role_description ? `<div class="p-person-role">${esc(r.role_description)}</div>` : ''}
              </div>
            </div>`;
          }).join('');
      indCard.innerHTML = `<div class="p-card-title">${t('section.individuals')}</div>
        <div class="p-scroll-md">${indRows}</div>` +
        addForm('individual', [
          {id:'f0-individual', label: t('label.full_name')},
          {id:'f1-individual', label: t('placeholder.individual_role')},
        ], t('btn.add'));
    }

    // ── Study Groups ──
    var grpCard = document.getElementById('groups-card');
    if (grpCard) {
      var grpRows = !groups.length
        ? empty(t('msg.no_groups'))
        : groups.map(function(r) {
            var badge = r.status === 'active'
              ? `<span class="p-badge active">${t('label.active')}</span>`
              : r.status === 'concluded' ? `<span class="p-badge done">${t('label.concluded')}</span>` : '';
            return `<div class="p-entry">
              <div class="p-entry-header">
                <div class="p-entry-title">${esc(r.name)}${delBtn(r.id)}</div>
                ${badge}
              </div>
              ${r.role_description ? `<div class="p-entry-sub">${esc(r.role_description)}</div>` : ''}
            </div>`;
          }).join('');
      grpCard.innerHTML = `<div class="p-card-title">${t('section.study_groups')}</div>
        <div class="p-scroll-md">${grpRows}</div>` +
        addForm('group', [
          {id:'f0-group', label: t('placeholder.group_name')},
          {id:'f1-group', label: t('placeholder.group_desc')},
          {id:'f2-group', type:'select', options:[{v:'',l: t('placeholder.status_opt') || 'Status (optional)'},{v:'active',l: t('label.active')},{v:'concluded',l: t('label.concluded')}]},
        ], t('btn.add'));
    }

    // ── Learning providers ──
    var provCard = document.getElementById('providers-card');
    if (provCard) {
      var provRows = !providers.length
        ? empty(t('msg.no_providers'))
        : providers.map(function(r) {
            var catBadge = `<span class="p-provider-type">${r.type === 'tool' ? t('label.tool') : t('label.institution')}</span>`;
            return `<div class="p-entry">
              <div class="p-entry-header">
                <div class="p-entry-title">${esc(r.name)}${catBadge}${delBtn(r.id)}</div>
              </div>
              ${r.role_description ? `<div class="p-entry-sub">${esc(r.role_description)}</div>` : ''}
            </div>`;
          }).join('');
      provCard.innerHTML = `<div class="p-card-title">${t('section.learning_providers')}</div>
        <div class="p-scroll-md">${provRows}</div>` +
        addForm('provider', [
          {id:'f0-provider', label: t('placeholder.provider_name')},
          {id:'f1-provider', label: t('placeholder.provider_desc')},
          {id:'f2-provider', type:'select', options:[{v:'institution',l: t('label.institution')},{v:'tool',l: t('label.tool')}]},
        ], t('btn.add'));
    }
  }

  window.saveRelationship = function(type) {
    var name = document.getElementById('rel-f0-' + type);
    if (!name || !name.value.trim()) { if (name) name.focus(); return; }
    var roleEl   = document.getElementById('rel-f1-' + type);
    var statusEl = document.getElementById('rel-f2-' + type);
    var actualType = type === 'provider'
      ? (statusEl ? statusEl.value : 'institution')
      : type;
    var status = type === 'group' && statusEl ? statusEl.value : null;
    fetch('/api/profile/relationships', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: actualType,
        name: name.value.trim(),
        role_description: roleEl ? roleEl.value.trim() || null : null,
        status: status || null,
      }),
    }).then(() => window.loadProfile()).catch(() => {});
  };

  window.deleteRelationship = function(id) {
    fetch('/api/profile/relationships/' + id, { method: 'DELETE' })
      .then(() => window.loadProfile()).catch(() => {});
  };

  function renderCredentials(credentials, mapKnowledge) {
    var creds = credentials || [];

    function credDelBtn(id) {
      return `<button onclick="window.deleteCredential(${id})" title="Remove" class="p-row-delete-btn">×</button>`;
    }

    function credAddForm(type, hasMonth) {
      var dateField = hasMonth
        ? `<input id="cred-date-${type}" type="month" class="p-edit-input p-cred-date-month">`
        : `<input id="cred-date-${type}" type="number" class="p-edit-input p-cred-date-year" min="1900" max="2099" placeholder="Year">`;
      return `
        <button class="p-edit-btn p-rel-add-btn" id="cred-add-btn-${type}"
          onclick="document.getElementById('cred-form-${type}').style.display='';this.style.display='none';document.getElementById('cred-title-${type}').focus()">
          + ${t('btn.add')}
        </button>
        <div id="cred-form-${type}" style="display:none" class="p-rel-form">
          <div class="p-form-grid-sm">
            <input id="cred-title-${type}" class="p-edit-input" placeholder="${esc(t('placeholder.cred_title'))}">
            <input id="cred-issuer-${type}" class="p-edit-input" placeholder="${esc(t('placeholder.cred_issuer'))}">
            <div>${dateField}</div>
            <div class="p-flex-row-sm">
              <button class="p-edit-btn primary p-edit-btn-inline" onclick="window.saveCredential('${type}')">${t('btn.add')}</button>
              <button class="p-edit-btn p-edit-btn-inline" onclick="document.getElementById('cred-form-${type}').style.display='none';document.getElementById('cred-add-btn-${type}').style.display=''">${t('btn.cancel')}</button>
            </div>
          </div>
        </div>`;
    }

    // ── Map of Knowledge Credentials (platform, read-only) ──
    var platform = creds.filter(function(c) { return c.type === 'platform'; });
    var platformCard = document.getElementById('platform-credentials-card');
    if (platformCard) {
      var platRows = !platform.length
        ? empty(t('msg.no_platform_creds'))
        : platform.map(function(c) {
            return `<div class="p-cred">
              <div class="p-cred-icon internal">🗺️</div>
              <div>
                <div class="p-cred-title">${esc(c.title)}</div>
                <div class="p-cred-issuer">${esc(c.issuer || 'Map of Knowledge · KaiQ Platform')}</div>
                <div class="p-cred-date">${fmtDate(c.awarded_date)}${c.score_pct ? ` · Score: ${c.score_pct}%` : ''}</div>
                ${c.blockchain_hash ? `<div class="p-cred-hash">${esc(c.blockchain_hash)}…</div>` : ''}
              </div>
            </div>`;
          }).join('');
      platformCard.innerHTML = `<div class="p-card-title">${t('section.platform_creds')}</div>
        <div class="p-scroll-sm">${platRows}</div>`;
    }

    // ── Qualifications ──
    var quals = creds.filter(function(c) { return c.type === 'qualification'; });
    var qualCard = document.getElementById('qualifications-card');
    if (qualCard) {
      var qualRows = !quals.length
        ? empty(t('msg.no_qualifications'))
        : quals.map(function(c) {
            return `<div class="p-cred">
              <div class="p-cred-icon qual">🎓</div>
              <div class="p-flex-1-noclip">
                <div class="p-cred-title">${esc(c.title)}${credDelBtn(c.id)}</div>
                ${c.issuer ? `<div class="p-cred-issuer">${esc(c.issuer)}</div>` : ''}
                <div class="p-cred-date">${fmtDate(c.awarded_date)}${c.grade ? ` · ${esc(c.grade)}` : ''}</div>
              </div>
            </div>`;
          }).join('');
      qualCard.innerHTML = `<div class="p-card-title">${t('section.qualifications')}</div>
        <div class="p-scroll-sm">${qualRows}</div>` + credAddForm('qualification', false);
    }

    // ── Awards & Endorsements ──
    var awards = creds.filter(function(c) { return c.type === 'award'; });
    var awardsCard = document.getElementById('awards-card');
    if (awardsCard) {
      var awardsRows = !awards.length
        ? empty(t('msg.no_awards'))
        : awards.map(function(c) {
            return `<div class="p-cred">
              <div class="p-cred-icon award">⭐</div>
              <div class="p-flex-1-noclip">
                <div class="p-cred-title">${esc(c.title)}${credDelBtn(c.id)}</div>
                ${c.issuer ? `<div class="p-cred-issuer">${esc(c.issuer)}</div>` : ''}
                <div class="p-cred-date">${fmtDate(c.awarded_date)}${c.grade ? ` · ${esc(c.grade)}` : ''}</div>
              </div>
            </div>`;
          }).join('');
      awardsCard.innerHTML = `<div class="p-card-title">${t('section.awards')}</div>
        <div class="p-scroll-sm">${awardsRows}</div>` + credAddForm('award', false);
    }

    // ── Certifications & Badges ──
    var certs = creds.filter(function(c) { return c.type === 'certification'; });
    var certsCard = document.getElementById('certifications-card');
    if (certsCard) {
      var certRows = !certs.length
        ? empty(t('msg.no_certifications'))
        : certs.map(function(c) {
            return `<div class="p-cred">
              <div class="p-cred-icon cert">📋</div>
              <div class="p-flex-1-noclip">
                <div class="p-cred-title">${esc(c.title)}${credDelBtn(c.id)}</div>
                ${c.issuer ? `<div class="p-cred-issuer">${esc(c.issuer)}</div>` : ''}
                <div class="p-cred-date">${fmtDate(c.awarded_date)}${c.grade ? ` · ${esc(c.grade)}` : ''}</div>
              </div>
            </div>`;
          }).join('');
      certsCard.innerHTML = `<div class="p-card-title">${t('section.certifications')}</div>
        <div class="p-scroll-sm">${certRows}</div>` + credAddForm('certification', true);
    }
  }

  window.saveCredential = function(type) {
    var titleEl  = document.getElementById('cred-title-' + type);
    var issuerEl = document.getElementById('cred-issuer-' + type);
    var dateEl   = document.getElementById('cred-date-' + type);
    if (!titleEl || !titleEl.value.trim()) { if (titleEl) titleEl.focus(); return; }
    var dateVal = dateEl ? dateEl.value.trim() : '';
    if (dateVal && dateVal.length === 4) dateVal = dateVal + '-01';
    fetch('/api/profile/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: type,
        title:        titleEl.value.trim(),
        issuer:       issuerEl ? issuerEl.value.trim() || null : null,
        awarded_date: dateVal || null,
      }),
    }).then(function() { window.loadProfile(); }).catch(function() {});
  };

  window.deleteCredential = function(id) {
    fetch('/api/profile/credentials/' + id, { method: 'DELETE' })
      .then(function() { window.loadProfile(); }).catch(function() {});
  };

  var _allKnowledge  = [];
  var _knowledgeView = 'pct'; // 'pct' | 'domain'

  var KNOWLEDGE_BAR_COLORS = {
    tested:        'var(--color-success)',
    self_reported: 'var(--accent)',
    estimated:     'var(--c7)',
  };

  function _knowledgeRow(k) {
    var pct      = Math.round(k.percentage) || 0;
    var barColor = KNOWLEDGE_BAR_COLORS[k.source] || KNOWLEDGE_BAR_COLORS.estimated;
    var srcClass = k.source === 'tested' ? 'tested' : 'self-reported';
    var srcLabel = k.source === 'tested' ? t('label.tested') : k.source === 'self_reported' ? t('label.self_reported') : t('label.estimated');
    return `<div class="p-prof-row">
      <div class="p-prof-info p-flex-1-noclip">
        <div class="p-prof-name">${esc(k.label)}</div>
        ${k.breadcrumb ? `<div class="p-prof-sub">${esc(k.breadcrumb)}</div>` : ''}
        <span class="p-source ${srcClass}">${srcLabel}</span>
      </div>
      <div class="p-bar-wrap">
        <div class="p-bar-track">
          <div class="p-bar-fill" style="width:${pct}%;background:${barColor}"></div>
        </div>
        <span class="p-bar-pct">${pct}%</span>
      </div>
    </div>`;
  }

  function _renderKnowledgeByPct(items) {
    return items.map(_knowledgeRow).join('');
  }

  function _renderKnowledgeByDomain(items) {
    // Items arrive already sorted percentage-desc (server query), so a
    // plain grouping pass keeps that order within each domain for free.
    var groups = {};
    var order  = [];
    items.forEach(function (k) {
      var d = k.domain || k.label;
      if (!groups[d]) { groups[d] = []; order.push(d); }
      groups[d].push(k);
    });

    var domains = order.map(function (d) {
      var members = groups[d];
      var avg = Math.round(members.reduce(function (s, k) { return s + (Number(k.percentage) || 0); }, 0) / members.length);
      return { domain: d, members: members, avg: avg };
    });
    domains.sort(function (a, b) { return b.avg - a.avg; });

    return domains.map(function (d) {
      return `<div class="p-domain-group">
        <div class="p-domain-heading" onclick="this.closest('.p-domain-group').classList.toggle('collapsed')">
          <span class="p-domain-chevron">
            <svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M2 3l2.5 3L7 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
          <span class="p-domain-name">${esc(d.domain)}</span>
          <span class="p-domain-avg">${t('label.avg_short')} ${d.avg}%</span>
        </div>
        <div class="p-domain-members">${d.members.map(_knowledgeRow).join('')}</div>
      </div>`;
    }).join('');
  }

  window._setKnowledgeView = function (view) {
    _knowledgeView = view;
    _renderKnowledgeWithState();
  };

  function _renderKnowledgeWithState() {
    var knowledgeCard = document.getElementById('knowledge-card');
    if (!knowledgeCard) return;

    var items = _allKnowledge;
    if (!items.length) {
      knowledgeCard.innerHTML = `<div class="p-card-title">${t('section.knowledge')}</div>` +
        empty(t('msg.no_knowledge'));
      return;
    }

    var toggle = `<div class="p-ev-type-pills p-knowledge-toggle">
      <button class="p-ev-pill ${_knowledgeView === 'pct' ? 'p-ev-pill-active' : 'p-ev-pill-inactive'}" onclick="window._setKnowledgeView('pct')">${t('btn.view_by_percentage')}</button>
      <button class="p-ev-pill ${_knowledgeView === 'domain' ? 'p-ev-pill-active' : 'p-ev-pill-inactive'}" onclick="window._setKnowledgeView('domain')">${t('btn.view_by_domain')}</button>
    </div>`;

    var rows = _knowledgeView === 'domain' ? _renderKnowledgeByDomain(items) : _renderKnowledgeByPct(items);

    knowledgeCard.innerHTML = `<div class="p-card-title">${t('section.knowledge')}</div>
      ${toggle}
      <div class="p-scroll-xl">${rows}</div>`;
  }

  function renderCompetence(competence, mapKnowledge) {
    // Hide Skills card — no longer shown
    var skillsCard = document.getElementById('skills-card');
    if (skillsCard) skillsCard.style.display = 'none';

    _allKnowledge = mapKnowledge || [];
    _renderKnowledgeWithState();
  }

  var _allReflections = [];
  var _reflShowing    = 5;

  function _renderReflectionsWithState() {
    const card = document.getElementById('reflections-card');
    if (!card) return;
    const showing   = _allReflections.slice(0, _reflShowing);
    const remaining = Math.max(0, _allReflections.length - _reflShowing);

    const rowsHtml = !showing.length
      ? empty(t('msg.no_reflections'))
      : showing.map(function(r) {
          var eventLine = r.event_title
            ? `<div class="p-quote-event-line">On: <em>${esc(r.event_title)}</em>${r.event_date ? ' · ' + fmtDate(r.event_date) : ''}</div>`
            : '';
          return `<div class="p-quote p-quote-entry">
            <div class="p-quote-date">${fmtDate(r.created_at)}</div>
            "${esc(r.text)}"
            ${eventLine}
          </div>`;
        }).join('');

    const moreBtn = remaining > 0
      ? `<button class="p-edit-btn p-edit-btn-load-more" onclick="window.loadMoreReflections()">
           ${t('btn.load_more')} (${remaining} ${t('label.remaining')})
         </button>`
      : '';

    card.innerHTML = `<div class="p-card-title">${t('section.reflections')}</div>
      <div class="p-scroll-lg">${rowsHtml}</div>` + moreBtn;
  }

  function renderReflections(reflections) {
    _allReflections = reflections || [];
    _reflShowing    = 5;
    _renderReflectionsWithState();
  }

  window.loadMoreReflections = function() {
    _reflShowing += 5; _renderReflectionsWithState();
  };

  function renderGoals(goals) {
    // Hide legacy cards
    ['objectives-card','plans-card'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });

    var card = document.getElementById('goals-card');
    if (!card) return;

    var all      = goals || [];
    var active   = all.filter(function(g) { return g.status === 'in_progress'; });
    var done     = all.filter(function(g) { return g.status === 'completed'; });

    var warning = active.length >= 4
      ? `<div class="p-goal-warning">⚠️ You have ${active.length} active goals. Research shows that focusing on fewer goals leads to better outcomes — consider completing one before adding more.</div>`
      : '';

    function goalRow(g) {
      var isDone   = g.status === 'completed';
      var setDate  = g.created_at ? 'Set: ' + fmtDate(g.created_at) : '';
      var doneDate = g.completed_at ? ' · Completed: ' + fmtDate(g.completed_at) : '';
      var badge    = isDone
        ? `<span class="p-goal-badge-done">${t('label.completed_badge')}</span>`
        : `<span class="p-goal-badge-active">${t('label.in_progress')}</span>`;
      var completeBtn = !isDone
        ? `<button onclick="window.completeGoal(${g.id})" title="Mark as completed" class="p-goal-complete-btn">${t('btn.complete')}</button>`
        : '';
      var delBtn = `<button onclick="window.deleteGoal(${g.id})" title="Remove" class="p-goal-delete-btn">×</button>`;
      return `<div class="p-goal-card ${isDone ? 'p-goal-card-done' : 'p-goal-card-active'}">
        <div class="p-goal-text">${esc(g.text)}</div>
        <div class="p-goal-footer">
          <span class="p-goal-date">${setDate}${doneDate}</span>
          <div class="p-goal-actions">${badge}${completeBtn}${delBtn}</div>
        </div>
      </div>`;
    }

    var activeRows = active.length
      ? active.map(goalRow).join('')
      : `<div class="p-no-goals-text">${t('msg.no_active_goals')}</div>`;
    var doneRows = done.length
      ? `<div class="p-goals-completed-label">${t('label.completed')}</div>` + done.map(goalRow).join('')
      : '';

    var addForm = `
      <button class="p-edit-btn p-rel-add-btn" id="goal-add-btn"
        onclick="document.getElementById('goal-form').style.display='';this.style.display='none';document.getElementById('goal-textarea').focus()">
        ${t('btn.add_goal')}
      </button>
      <div id="goal-form" style="display:none" class="p-rel-form">
        <textarea id="goal-textarea" class="p-edit-input p-textarea-full"
          placeholder="${esc(t('placeholder.goal_text'))}"></textarea>
        <div class="p-goal-smart-hint">${t('msg.smart_hint')}</div>
        <div class="p-flex-row-sm">
          <button class="p-edit-btn primary p-edit-btn-inline" onclick="window.saveGoal()">${t('btn.add')}</button>
          <button class="p-edit-btn p-edit-btn-inline" onclick="document.getElementById('goal-form').style.display='none';document.getElementById('goal-add-btn').style.display=''">${t('btn.cancel')}</button>
        </div>
      </div>`;

    card.innerHTML = `<div class="p-card-title">${t('section.goals')}</div>` +
      warning + activeRows + doneRows + addForm;
  }

  window.saveGoal = function() {
    var ta = document.getElementById('goal-textarea');
    if (!ta || !ta.value.trim()) { if (ta) ta.focus(); return; }
    fetch('/api/profile/goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: ta.value.trim() }),
    }).then(function() { window.loadProfile(); }).catch(function() {});
  };

  window.completeGoal = function(id) {
    fetch('/api/profile/goals/' + id + '/complete', { method: 'POST' })
      .then(function() { window.loadProfile(); }).catch(function() {});
  };

  window.deleteGoal = function(id) {
    fetch('/api/profile/goals/' + id, { method: 'DELETE' })
      .then(function() { window.loadProfile(); }).catch(function() {});
  };

  /* ─── Inline edit for identity ───────────────────────────────── */
  window.editIdentity = function () {
    const card = document.getElementById('identity-card');
    if (!card) return;
    const vals = {};
    card.querySelectorAll('[data-field]').forEach(el => { vals[el.dataset.field] = el.textContent.trim(); });

    // Year of birth dropdown
    const curYear = new Date().getFullYear();
    var yearOpts = '<option value="">—</option>';
    for (var y = curYear - 14; y >= 1930; y--) {
      yearOpts += '<option value="' + y + '"' + (String(vals.birth_year) === String(y) ? ' selected' : '') + '>' + y + '</option>';
    }

    // Language dropdown — value is display name; locale code resolved via LANG_LOCALE map
    var LANGUAGES = [['English', 'en'], ['Estonian', 'et']];
    var langOpts = '<option value="">—</option>' + LANGUAGES.map(function(pair) {
      return '<option value="' + pair[0] + '"' + (vals.location === pair[0] ? ' selected' : '') + '>' + pair[0] + '</option>';
    }).join('');

    card.innerHTML = `
      <div class="p-kv">
        <div class="p-kv-label">${t('label.full_name')}</div>
        <div class="p-kv-value">
          <input class="p-edit-input" data-field="display_name" value="${esc(vals.display_name || '')}" placeholder="${esc(t('label.full_name'))}">
        </div>
        <div class="p-kv-label">${t('label.year_of_birth')}</div>
        <div class="p-kv-value">
          <select class="p-edit-input" data-field="birth_year">${yearOpts}</select>
        </div>
        <div class="p-kv-label">${t('label.language')}</div>
        <div class="p-kv-value">
          <select class="p-edit-input" data-field="location" onchange="window._applyLangLocale(this.value)">${langOpts}</select>
        </div>
        <div class="p-kv-label">
          ${t('label.culture')}
          <span class="p-tip" data-tip="We use this to personalise your learning content. It can indicate your nationality, geographic region, religion, or other cultural context — leave blank if you prefer not to share.">ⓘ</span>
        </div>
        <div class="p-kv-value">
          <input class="p-edit-input" data-field="cultural_background" value="${esc(vals.cultural_background || '')}" placeholder="${esc(t('placeholder.optional'))}">
        </div>
        <div class="p-kv-label">
          ${t('label.id_number')}
          <span class="p-tip" data-tip="Your national ID, social security, driver's licence or similar. Used to resolve identity disputes, if needed.">ⓘ</span>
        </div>
        <div class="p-kv-value">
          <input class="p-edit-input" data-field="id_number" value="${esc(vals.id_number || '')}" placeholder="${esc(t('placeholder.optional'))}">
        </div>
      </div>
      <button class="p-edit-btn primary" onclick="window.saveIdentity()">${t('btn.save')}</button>
      <button class="p-edit-btn" onclick="window.loadProfile()">${t('btn.cancel')}</button>`;
  };

  window._applyLangLocale = function (langName) {
    var LANG_LOCALE = { 'English': 'en', 'Estonian': 'et' };
    var locale = LANG_LOCALE[langName] || 'en';
    window._uiLocale = locale === 'en' ? null : locale;
    window.reloadStrings && window.reloadStrings();
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'ui_locale', value: locale }),
    });
  };

  window.saveIdentity = function () {
    const card = document.getElementById('identity-card');
    if (!card) return;
    const data = {};
    card.querySelectorAll('.p-edit-input[data-field]').forEach(el => { data[el.dataset.field] = el.value.trim(); });
    fetch('/api/profile/identity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(() => window.loadProfile()).catch(() => alert(t('msg.save_failed')));
  };

  window.editAbout = function () {
    const card = document.getElementById('about-card');
    if (!card) return;
    const current = card.querySelector('.p-about-text')?.textContent.trim() || '';
    card.innerHTML = `
      <textarea class="p-edit-input p-about-edit-textarea" placeholder="${esc(t('placeholder.about'))}">${esc(current)}</textarea>
      <button class="p-edit-btn primary" onclick="window.saveAbout(this)">${t('btn.save')}</button>
      <button class="p-edit-btn" onclick="window.loadProfile()">${t('btn.cancel')}</button>`;
  };

  window.saveAbout = function (btn) {
    const card = document.getElementById('about-card');
    const about = card.querySelector('textarea').value.trim();
    fetch('/api/profile/identity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ about }),
    }).then(() => window.loadProfile()).catch(() => alert(t('msg.save_failed_short')));
  };

  /* ─── Suggestions (Section 7) ────────────────────────────────────
     Node-only deep links (no per-knobit resume link exists) — same
     pattern notifications.html's clickable cards use: close the
     overlay iframe and let the parent map zoom/open the node, or do
     a full navigation when this page isn't embedded in the map. */
  window._suggestGoToNode = function (nodeId) {
    if (!nodeId) return;
    if (window.parent !== window && window.parent.closeOverlay) {
      window.parent.closeOverlay();
      if (window.parent.MapView && window.parent.MapView.navigateToNode) {
        window.parent.MapView.navigateToNode(nodeId);
      }
    } else {
      window.location.href = '/app/?node=' + encodeURIComponent(nodeId);
    }
  };

  function renderSuggestions(suggestions) {
    var s = suggestions || {};

    var unfinishedCard = document.getElementById('unfinished-knobits-card');
    if (unfinishedCard) {
      var uk = s.unfinishedKnobits || [];
      var ukRows = uk.length
        ? uk.map(function (k) {
            return `<div class="p-suggest-row" onclick="window._suggestGoToNode('${esc(k.nodeId)}')">
              <div class="p-suggest-row-main">
                <div class="p-suggest-row-title">${esc(k.title)}</div>
                <div class="p-suggest-row-sub">${esc(k.nodeLabel)}</div>
              </div>
            </div>`;
          }).join('')
        : empty(t('msg.no_unfinished_knobits'));
      unfinishedCard.innerHTML = `
        <div class="p-card-title">${t('section.suggest_unfinished_title')}</div>
        <div class="p-suggest-intro">${t('msg.suggest_unfinished_intro')}</div>
        ${ukRows}`;
    }

    var pathsCard = document.getElementById('incomplete-paths-card');
    if (pathsCard) {
      var ip = s.incompletePaths || [];
      var ipRows = ip.length
        ? ip.map(function (p) {
            return `<div class="p-suggest-row" onclick="window._suggestGoToNode('${esc(p.nodeId)}')">
              <div class="p-suggest-row-main">
                <div class="p-suggest-row-title">${esc(p.nodeLabel)}</div>
              </div>
              <div class="p-suggest-row-meta">${p.done} / ${p.total}</div>
            </div>`;
          }).join('')
        : empty(t('msg.no_incomplete_paths'));
      pathsCard.innerHTML = `
        <div class="p-card-title">${t('section.suggest_paths_title')}</div>
        <div class="p-suggest-intro">${t('msg.suggest_paths_intro')}</div>
        ${ipRows}`;
    }

    var repeatCard = document.getElementById('repeat-content-card');
    if (repeatCard) {
      repeatCard.innerHTML = `
        <div class="p-card-title">${t('section.suggest_repeat_title')}</div>
        ${empty(t('msg.suggest_repeat_coming'))}`;
    }
  }

  /* ─── Section 8 — Streak (real data) ─────────────────────────────── */
  function renderStreak(streak) {
    var card = document.getElementById('qst-streak-card');
    if (!card) return;
    var s = streak || {};
    var cur     = s.currentStreak || 0;
    var longest = s.longestStreak || 0;
    var savers  = s.streakSavers  || 0;

    var lit = Math.min(cur, 7);
    var dots = '';
    for (var i = 0; i < 7; i++) {
      dots += `<span class="qst-day${i >= 7 - lit ? ' on' : ''}"></span>`;
    }

    var longestHtml = '';
    if (longest > 0 && cur === longest) {
      longestHtml = `<div class="qst-streak-longest best">🏆 ${esc(t('quesst.longest_ever'))}</div>`;
    } else if (longest > 0) {
      longestHtml = `<div class="qst-streak-longest">${esc(t('quesst.longest_streak_label'))}: ${longest}</div>`;
    }

    var zeroHtml = cur === 0
      ? `<div class="qst-streak-zero">${esc(t('quesst.streak_zero'))}</div>`
      : '';

    card.innerHTML = `
      <div class="p-card-title-row">
        <div class="p-card-title">${esc(t('quesst.streak_title'))}</div>
        <button type="button" class="qst-info-btn" id="qst-streak-info-btn" aria-label="${esc(t('quesst.streak_rules_title'))}">i</button>
      </div>
      <div class="qst-streak-hero">
        <div class="qst-streak-count-row">
          <span class="qst-streak-flame${cur === 0 ? ' off' : ''}">🔥</span>
          <span class="qst-streak-count">${cur}</span>
          <span class="qst-streak-label">${esc(t('quesst.day_streak'))}</span>
        </div>
      </div>
      <div class="qst-streak-days">${dots}</div>
      ${zeroHtml}
      ${longestHtml}
      <div class="qst-streak-savers">🛡️ ${savers}/3 ${esc(t('quesst.streak_savers_label'))}</div>
      <div class="qst-info-popover" id="qst-streak-popover" style="display:none">
        <div class="qst-info-popover-title">${esc(t('quesst.streak_rules_title'))}</div>
        <ul>
          <li>${esc(t('quesst.streak_rule_1'))}</li>
          <li>${esc(t('quesst.streak_rule_2'))}</li>
          <li>${esc(t('quesst.streak_rule_3'))}</li>
          <li>${esc(t('quesst.streak_rule_4'))}</li>
        </ul>
      </div>`;

    var infoBtn  = document.getElementById('qst-streak-info-btn');
    var popover  = document.getElementById('qst-streak-popover');
    if (infoBtn && popover) {
      infoBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        popover.style.display = popover.style.display === 'none' ? 'block' : 'none';
      });
      document.addEventListener('click', function (e) {
        if (popover.style.display !== 'none' && !popover.contains(e.target) && e.target !== infoBtn) {
          popover.style.display = 'none';
        }
      });
    }
  }

  // The learner's own local calendar date — no timezone is stored anywhere
  // server-side, so this is the only place that actually knows what day it
  // is for them. Used purely for streak bookkeeping (see Section 8).
  function _localDateStr() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  /* ─── Main load ───────────────────────────────────────────────── */
  window.loadProfile = function () {
    fetch('/api/profile?localDate=' + encodeURIComponent(_localDateStr()))
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(d => {
        renderIdentity(d.passport || {});
        renderInterests(d.tags);
        renderRelationships(d.relationships);
        renderEvents(d.events);
        renderCredentials(d.credentials, d.mapKnowledge);
        renderCompetence(d.competence, d.mapKnowledge);
        renderReflections(d.reflections);
        renderGoals(d.goals);
        renderSuggestions(d.suggestions);
        renderStreak(d.streak);
        renderLumens(d.game);
      })
      .catch(err => {
        console.error('Profile load failed:', err);
      });
  };

  /* ─── Section 8 — Quesst intro video lightbox ───────────────────── */
  (function () {
    var openBtn  = document.getElementById('qst-video-open');
    var closeBtn = document.getElementById('qst-video-close');
    var lightbox = document.getElementById('qst-video-lightbox');
    var frame    = document.getElementById('qst-video-frame');
    if (!openBtn || !lightbox || !frame) return;

    function open() {
      frame.innerHTML = '<iframe src="https://www.youtube.com/embed/WyFXIwr1eD0?autoplay=1&rel=0" ' +
        'title="Quesst intro" frameborder="0" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>';
      lightbox.style.display = 'flex';
    }
    function close() {
      lightbox.style.display = 'none';
      frame.innerHTML = ''; // stop playback
    }

    openBtn.addEventListener('click', open);
    if (closeBtn) closeBtn.addEventListener('click', close);
    lightbox.addEventListener('click', function (e) {
      if (e.target === lightbox) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && lightbox.style.display !== 'none') close();
    });
  })();

  /* ─── Section 8 — Lumens & Rank (real data) ──────────────────────── */
  function renderLumens(game) {
    var card = document.getElementById('qst-lumens-card');
    if (!card) return;
    var g       = game || {};
    var lumens  = g.lumens  || 0;
    var rank    = g.rank    || 'Wanderer';
    var rankMin = g.rankMin || 0;
    var next    = g.nextRank || null;

    var pct = 100;
    if (next && next.min > rankMin) {
      pct = Math.max(0, Math.min(100, Math.round(((lumens - rankMin) / (next.min - rankMin)) * 100)));
    }
    var nextLabel = next ? esc(next.title) : esc(t('quesst.max_rank_label'));

    card.innerHTML = `
      <div class="p-card-title-row">
        <div class="p-card-title">${esc(t('quesst.lumens_title'))}</div>
        <button type="button" class="qst-info-btn" id="qst-lumens-info-btn" aria-label="${esc(t('quesst.lumens_rules_title'))}">i</button>
      </div>
      <div class="qst-lumens-hero">
        <div class="qst-lumens-count-row">
          <span class="qst-lumens-icon">✦</span>
          <span class="qst-lumens-count">${lumens.toLocaleString()}</span>
        </div>
        <div class="qst-lumens-label">${esc(t('quesst.lumens_label'))}</div>
      </div>
      <div class="qst-rank-row">
        <span class="qst-rank-badge">${esc(rank)}</span>
        <div class="qst-rank-bar"><div class="qst-rank-fill" style="width:${pct}%"></div></div>
        <span class="qst-rank-next">${nextLabel}</span>
      </div>
      <div class="qst-info-popover" id="qst-lumens-popover" style="display:none">
        <div class="qst-info-popover-title">${esc(t('quesst.lumens_rules_title'))}</div>
        <ul>
          <li>${esc(t('quesst.lumens_rule_1'))}</li>
          <li>${esc(t('quesst.lumens_rule_2'))}</li>
          <li>${esc(t('quesst.lumens_rule_3'))}</li>
          <li>${esc(t('quesst.lumens_rule_4'))}</li>
          <li>${esc(t('quesst.lumens_rule_5'))}</li>
          <li>${esc(t('quesst.lumens_rule_6'))}</li>
          <li>${esc(t('quesst.lumens_rule_7'))}</li>
        </ul>
      </div>`;

    var infoBtn = document.getElementById('qst-lumens-info-btn');
    var popover = document.getElementById('qst-lumens-popover');
    if (infoBtn && popover) {
      infoBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        popover.style.display = popover.style.display === 'none' ? 'block' : 'none';
      });
      document.addEventListener('click', function (e) {
        if (popover.style.display !== 'none' && !popover.contains(e.target) && e.target !== infoBtn) {
          popover.style.display = 'none';
        }
      });
    }
  }

  /* ─── Section 8 — Leaderboard (real data) ────────────────────────── */
  function _lbShortName(fullName, isYou) {
    if (isYou) return t('quesst.you_label');
    var name = (fullName || '').trim();
    if (!name) return t('quesst.anon_learner');
    return name.split(/\s+/)[0];
  }

  function renderLeaderboard(data) {
    var card = document.getElementById('qst-leaderboard-card');
    if (!card) return;
    var d      = data || {};
    var top    = d.top || [];
    var you    = d.you || null;
    var myId   = d.passportId;

    if (!top.length) {
      card.innerHTML = `<div class="p-card-title">${esc(t('quesst.leaderboard_title'))}</div>` +
        empty(t('quesst.leaderboard_empty'));
      return;
    }

    function row(r) {
      var isYou = !!(myId && r.passportId === myId);
      var name  = _lbShortName(r.displayName, isYou);
      return `<div class="qst-lb-row${isYou ? ' you' : ''}">
        <span class="qst-lb-rank">${r.rank}.</span>
        <div class="qst-lb-info">
          <span class="qst-lb-name">${esc(name)}</span>
          <span class="qst-lb-rank-title">${esc(r.rankTitle || '')}</span>
        </div>
        <span class="qst-lb-lumens"><span class="qst-lb-lumens-icon">✦</span> ${(r.lumens || 0).toLocaleString()}</span>
      </div>`;
    }

    var html = `<div class="p-card-title">${esc(t('quesst.leaderboard_title'))}</div>`;
    html += top.map(row).join('');
    if (you) html += '<div class="qst-lb-gap">···</div>' + row(you);
    card.innerHTML = html;
  }

  /* ─── Section 8 — Achievements (real data) ───────────────────────── */
  function renderAchievements(list) {
    var card = document.getElementById('qst-achievements-card');
    if (!card) return;
    // Unlocked first (stable sort keeps definition order within each group)
    // so earned medals lead the grid.
    var items = (list || []).slice().sort(function (a, b) {
      return (b.unlocked ? 1 : 0) - (a.unlocked ? 1 : 0);
    });

    function cellHtml(a) {
      var stateClass = a.unlocked ? 'unlocked' : 'locked';
      return `<div class="qst-ach ${stateClass}" title="${esc(a.name)}">
        <div class="qst-ach-icon">${a.icon || '🏅'}</div>
        <div class="qst-ach-name">${esc(a.name)}</div>
      </div>`;
    }

    card.innerHTML = `<div class="p-card-title">${esc(t('quesst.achievements_title'))}</div>` +
      `<div class="qst-ach-grid">${items.map(cellHtml).join('')}</div>`;
  }

  // Boot
  window.loadProfile();
  fetch('/api/leaderboard')
    .then(r => r.json())
    .then(renderLeaderboard)
    .catch(() => {});
  fetch('/api/game/achievements')
    .then(r => r.json())
    .then(renderAchievements)
    .catch(() => {});

})();
