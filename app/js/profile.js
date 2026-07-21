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
    var loc = (window._uiLocale === 'et') ? 'et-EE' : 'en-GB';
    try { return new Date(d).toLocaleDateString(loc, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch { return String(d).substring(0, 7); }
  }

  function empty(msg) {
    return `<div class="p-empty">${esc(msg)}</div>`;
  }

  /* ─── Render functions ────────────────────────────────────────── */

  function renderIdentity(passport) {
    const name  = passport.display_name || t('label.your_name');
    const about = passport.about || '';


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
      ? `<button onclick="window.clearEvDates()" title="${t('btn.clear_date_filter')}" class="p-ev-clear-btn">✕</button>`
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
            <span class="p-type ${esc(ev.type)}">${esc(window.t('label.' + ev.type) || ev.type.charAt(0).toUpperCase() + ev.type.slice(1))}</span>
          </div>`;
        }).join('');

    const scrollList = `<div class="p-scroll-lg">${rowsHtml}</div>`;

    const today   = new Date().toISOString().split('T')[0];
    const SRC_KEYS = [
      ['Book',             'ev.source.book'],
      ['YouTube video',    'ev.source.youtube'],
      ['Conference',       'ev.source.conference'],
      ['Workshop',         'ev.source.workshop'],
      ['Self-study period','ev.source.selfstudy'],
      ['Other',            'ev.source.other'],
    ];
    const srcOpts = SRC_KEYS
      .map(function(p) { return `<option value="${p[0]}">${window.t(p[1]) || p[0]}</option>`; }).join('');

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

    // ── KnoBitz Credentials (platform, read-only) ──
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
                <div class="p-cred-issuer">${esc(c.issuer || 'KnoBitz platvorm')}</div>
                <div class="p-cred-date">${fmtDate(c.awarded_date)}${c.score_pct ? ` · Score: ${c.score_pct}%` : ''}</div>
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

  function renderCompetence(competence, mapKnowledge) {
    // Hide Skills card — no longer shown
    var skillsCard = document.getElementById('skills-card');
    if (skillsCard) skillsCard.style.display = 'none';

    var knowledgeCard = document.getElementById('knowledge-card');
    if (!knowledgeCard) return;

    var items = mapKnowledge || [];
    if (!items.length) {
      knowledgeCard.innerHTML = `<div class="p-card-title">${t('section.knowledge')}</div>` +
        empty(t('msg.no_knowledge'));
      return;
    }

    var BAR_COLORS = {
      tested:        'var(--color-success)',
      self_reported: 'var(--accent)',
      estimated:     'var(--c7)',
    };

    var rows = items.map(function(k) {
      var pct      = Math.round(k.percentage) || 0;
      var barColor = BAR_COLORS[k.source] || BAR_COLORS.estimated;
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
    }).join('');

    knowledgeCard.innerHTML = `<div class="p-card-title">${t('section.knowledge')}</div>
      <div class="p-scroll-xl">${rows}</div>`;
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
            ? `<div class="p-quote-event-line">${window.t('label.ev_on') || 'On:'} <em>${esc(r.event_title)}</em>${r.event_date ? ' · ' + fmtDate(r.event_date) : ''}</div>`
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

  function fmtEta(minutes) {
    if (!minutes && minutes !== 0) return '';
    if (minutes === 0) return t('label.eta_done');
    if (minutes < 60) return 'ETA: ' + minutes + ' ' + t('label.min');
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    return 'ETA: ' + h + ' ' + t('label.h') + (m ? ' ' + m + ' ' + t('label.min') : '');
  }

  function renderGoals(goals) {
    ['objectives-card','plans-card'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });

    var card = document.getElementById('goals-card');
    if (!card) return;

    var all    = goals || [];
    var active = all.filter(function(g) { return g.status === 'in_progress'; });
    var done   = all.filter(function(g) { return g.status === 'completed'; });

    var warning = active.length >= 4
      ? `<div class="p-goal-warning">${t('msg.too_many_goals').replace('{n}', active.length)}</div>`
      : '';

    function goalRow(g) {
      var isDone     = g.status === 'completed';
      var isNodeGoal = !!g.node_external_id;
      var doneDate   = g.completed_at ? ' · ' + fmtDate(g.completed_at) : '';
      var setDate    = g.created_at ? fmtDate(g.created_at) : '';
      var badge      = isDone
        ? `<span class="p-goal-badge-done">${t('label.completed_badge')}</span>`
        : `<span class="p-goal-badge-active">${t('label.in_progress')}</span>`;
      var completeBtn = !isDone
        ? `<button onclick="window.completeGoal(${g.id})" class="p-goal-complete-btn">${t('btn.complete')}</button>`
        : '';
      var delBtn = `<button onclick="window.deleteGoal(${g.id})" class="p-goal-delete-btn">×</button>`;

      if (isNodeGoal) {
        var pct    = Math.round(Number(g.progress) || 0);
        var eta    = fmtEta(g.eta_minutes);
        var crumb  = g.node_breadcrumb || g.node_label || g.text;
        var target = g.target_date
          ? `<span class="p-goal-target">${t('label.goal_target_date')}: ${fmtDate(g.target_date)}</span>`
          : '';
        var mapLink = !isDone
          ? `<a class="p-goal-map-link" href="/app/?node=${esc(g.node_external_id)}">${t('btn.go_to_map')}</a>`
          : '';
        var setBy = g.suggested_by_role === 'teacher'
          ? `<div class="p-goal-set-by">${t('label.goal_set_by_teacher').replace('{name}', esc(g.suggested_by_name || ''))}</div>`
          : '';
        return `<div class="p-goal-card p-goal-card-node ${isDone ? 'p-goal-card-done' : 'p-goal-card-active'}">
          <div class="p-goal-node-header">
            <div class="p-goal-node-crumb">${esc(crumb)}</div>
            ${!isDone ? `<div class="p-goal-eta">${eta}</div>` : ''}
          </div>
          ${setBy}
          ${!isDone ? `<div class="p-goal-bar-track"><div class="p-goal-bar-fill" style="width:${pct}%"></div></div>
          <div class="p-goal-bar-label">${pct}% ${t('label.goal_progress')}</div>` : ''}
          <div class="p-goal-footer">
            <div class="p-goal-meta">${target}${setDate ? `<span class="p-goal-date">${setDate}${doneDate}</span>` : ''}</div>
            <div class="p-goal-actions">${badge}${mapLink}${completeBtn}${delBtn}</div>
          </div>
        </div>`;
      }

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

    var hintHtml = `<div class="p-goal-map-hint">${t('msg.goal_map_hint')}</div>`;

    card.innerHTML = `<div class="p-card-title">${t('section.goals')}</div>` +
      warning + hintHtml + activeRows + doneRows;
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
          <span class="p-tip" data-tip="${esc(t('tip.cultural_background'))}">ⓘ</span>
        </div>
        <div class="p-kv-value">
          <input class="p-edit-input" data-field="cultural_background" value="${esc(vals.cultural_background || '')}" placeholder="${esc(t('placeholder.optional'))}">
        </div>
        <div class="p-kv-label">
          ${t('label.id_number')}
          <span class="p-tip" data-tip="${esc(t('tip.id_number'))}">ⓘ</span>
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

  function renderGameState(state, achievements) {
    var gsCard = document.getElementById('game-state-card');
    var achCard = document.getElementById('game-achievements-card');

    if (gsCard) {
      if (!state) {
        gsCard.innerHTML = `<div class="p-card-title">${t('game.your_rank')}</div>${empty(t('msg.game_no_data'))}`;
      } else {
        var lumens     = state.lumens || 0;
        var rankKey    = state.rank || '';
        var rankTitle  = state.rankTitle_et || state.rankTitle || rankKey;
        var nextTitle  = state.nextRank ? (state.nextRank.title_et || state.nextRank.title || '') : '';
        var rankMin    = state.rankMin || 0;
        var nextMin    = state.nextRank ? state.nextRank.min : lumens;
        var pct        = nextMin > rankMin
          ? Math.min(100, Math.round(((lumens - rankMin) / (nextMin - rankMin)) * 100))
          : 100;
        var momKey     = state.momentum ? state.momentum.label : '';
        var momLabel   = momKey ? t(momKey) : '';
        var streak     = state.momentum ? state.momentum.streakDays : 0;
        gsCard.innerHTML = `
          <div class="p-card-title">${t('game.your_rank')}</div>
          <div class="p-game-rank-row">
            <div class="p-game-rank-badge">${esc(rankTitle)}</div>
            <div class="p-game-lumens">${lumens} ${t('game.lumens_unit')}</div>
          </div>
          ${nextTitle ? `<div class="p-game-next-label">${t('game.next_rank')}: ${esc(nextTitle)}</div>` : ''}
          <div class="p-bar-track p-game-bar">
            <div class="p-bar-fill" style="width:${pct}%;background:var(--accent)"></div>
          </div>
          <div class="p-game-meta">
            ${momLabel ? `<span class="p-game-momentum">${esc(momLabel)}</span>` : ''}
            ${streak ? `<span class="p-game-streak">${streak}${t('label.day_streak')}</span>` : ''}
          </div>`;
      }
    }

    if (achCard) {
      var all = Array.isArray(achievements) ? achievements : [];
      var unlocked = all.filter(function(a) { return a.unlocked; });
      var locked   = all.filter(function(a) { return !a.unlocked; });
      var achHtml  = '';
      unlocked.forEach(function(a) {
        achHtml += `<div class="p-ach p-ach-unlocked">
          <div class="p-ach-icon">${esc(a.icon || '🏅')}</div>
          <div class="p-ach-name">${esc(a.name_et || a.name)}</div>
        </div>`;
      });
      locked.slice(0, 6).forEach(function(a) {
        achHtml += `<div class="p-ach p-ach-locked">
          <div class="p-ach-icon p-ach-icon-locked">${esc(a.icon || '🔒')}</div>
          <div class="p-ach-name p-ach-name-locked">${esc(a.name_et || a.name)}</div>
        </div>`;
      });
      achCard.innerHTML = `<div class="p-card-title">${t('game.achievements')}</div>
        <div class="p-ach-grid">${achHtml || empty(t('msg.no_achievements'))}</div>`;
    }
  }

  /* ─── Main load ───────────────────────────────────────────────── */
  window.loadProfile = function () {
    fetch('/api/profile')
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
      })
      .catch(err => {
        console.error('Profile load failed:', err);
      });

    Promise.all([
      fetch('/api/game/state').then(r => r.json()).catch(() => null),
      fetch('/api/game/achievements').then(r => r.json()).catch(() => []),
    ]).then(function(results) {
      renderGameState(results[0], results[1]);
    });
  };

  // Boot — render immediately, then re-render once the correct-locale strings arrive
  window.loadProfile();
  window._onStringsLoad = window.loadProfile;

})();
