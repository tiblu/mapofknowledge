(function () {
  function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmtDate(d) { if(!d) return ''; try { return new Date(d).toLocaleDateString('et-EE',{year:'numeric',month:'short',day:'numeric'}); } catch { return String(d).slice(0,10); } }
  function empty(msg) { return '<div class="p-empty">' + esc(msg) + '</div>'; }

  var _children = [];
  var _selected = null;

  function loadChildren() {
    fetch('/api/parent/children')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        _children = d.children || [];
        renderChildList();
        if (_children.length) selectChild(_children[0].passport_id);
      })
      .catch(function() {
        document.getElementById('child-list').innerHTML = empty(t('parent.no_children'));
      });
  }

  function renderChildList() {
    var list = document.getElementById('child-list');
    if (!list) return;
    if (!_children.length) {
      list.innerHTML = empty(t('parent.no_children'));
      return;
    }
    list.innerHTML = _children.map(function(c) {
      var active = _selected === c.passport_id ? ' student-item-active' : '';
      return '<div class="student-item' + active + '" onclick="window.selectChild(' + c.passport_id + ')">' +
        '<div class="student-item-name">' + esc(c.display_name || '?') + '</div>' +
        '<div class="student-item-meta">' + (c.lumens || 0) + ' ' + t('game.lumens') + ' · ' + c.active_goals + ' ' + t('teacher.active_goals_n') + '</div>' +
        '</div>';
    }).join('');
  }

  window.selectChild = function(passportId) {
    _selected = passportId;
    renderChildList();
    fetch('/api/parent/children/' + passportId)
      .then(function(r) { return r.json(); })
      .then(renderChildDetail)
      .catch(function() {
        document.getElementById('parent-detail').innerHTML = empty(t('msg.error_loading'));
      });
  };

  function renderChildDetail(d) {
    var detail = document.getElementById('parent-detail');
    if (!detail) return;
    var passport  = d.passport || {};
    var gs        = d.gameState || {};
    var goals     = d.goals || [];
    var events    = d.events || [];

    var rankTitle = gs.rankTitle_et || gs.rankTitle || '';
    var streak    = gs.momentum ? gs.momentum.streakDays : 0;
    var lumens    = gs.lumens || 0;

    var statsHtml =
      '<div class="parent-stats-row">' +
        '<div class="parent-stat"><div class="parent-stat-val">' + lumens + '</div><div class="parent-stat-label">' + t('game.lumens') + '</div></div>' +
        '<div class="parent-stat"><div class="parent-stat-val">' + streak + '</div><div class="parent-stat-label">' + t('parent.streak') + '</div></div>' +
        '<div class="parent-stat"><div class="parent-stat-val">' + esc(rankTitle) + '</div><div class="parent-stat-label">' + t('game.your_rank') + '</div></div>' +
      '</div>';

    var goalsHtml = goals.filter(function(g){ return g.status==='in_progress'; }).length
      ? goals.filter(function(g){ return g.status==='in_progress'; }).map(function(g) {
          var pct = Math.round(Number(g.progress)||0);
          var label = g.node_breadcrumb || g.node_label || g.text;
          return '<div class="teacher-goal-row">' +
            '<div class="teacher-goal-label">' + esc(label) + '</div>' +
            '<div class="p-bar-track"><div class="p-bar-fill" style="width:' + pct + '%;background:var(--accent)"></div></div>' +
            '<div class="teacher-goal-pct">' + pct + '%</div>' +
            '</div>';
        }).join('')
      : empty(t('msg.no_active_goals'));

    var eventsHtml = events.length
      ? events.map(function(ev) {
          return '<div class="p-ledger-row">' +
            '<div class="p-ledger-date">' + fmtDate(ev.event_date) + '</div>' +
            '<div class="p-ledger-info"><div class="p-ledger-title">' + esc(ev.title) + '</div></div>' +
            '</div>';
        }).join('')
      : empty(t('msg.no_events'));

    detail.innerHTML =
      '<div class="teacher-detail-header">' +
        '<div class="teacher-student-name">' + esc(passport.display_name || '?') + '</div>' +
      '</div>' +
      statsHtml +
      '<div class="p-card-title">' + t('parent.active_goals') + '</div>' +
      goalsHtml +
      '<div class="p-card-title" style="margin-top:24px">' + t('parent.recent_activity') + '</div>' +
      '<div class="p-scroll-lg">' + eventsHtml + '</div>';
  }

  window.showInviteModal = function(role) {
    fetch('/api/links/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: role }),
    }).then(function(r) { return r.json(); })
      .then(function(d) {
        document.getElementById('invite-code-display').textContent = d.invite_code || '';
        document.getElementById('invite-modal').style.display = '';
      }).catch(function() {});
  };

  loadChildren();
})();
