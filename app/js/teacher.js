(function () {
  function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmtDate(d) { if(!d) return ''; try { return new Date(d).toLocaleDateString('et-EE',{year:'numeric',month:'short',day:'numeric'}); } catch { return String(d).slice(0,10); } }
  function empty(msg) { return '<div class="p-empty">' + esc(msg) + '</div>'; }

  var _students = [];
  var _selected = null;

  function loadStudents() {
    fetch('/api/teacher/students')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        _students = d.students || [];
        renderStudentList();
        if (_students.length) selectStudent(_students[0].passport_id);
      })
      .catch(function() {
        document.getElementById('student-list').innerHTML = empty(t('teacher.no_students'));
      });
  }

  function renderStudentList() {
    var list = document.getElementById('student-list');
    if (!list) return;
    if (!_students.length) {
      list.innerHTML = empty(t('teacher.no_students'));
      return;
    }
    list.innerHTML = _students.map(function(s) {
      var active = _selected === s.passport_id ? ' student-item-active' : '';
      var lastStr = s.last_active ? fmtDate(s.last_active) : t('teacher.never_active');
      return '<div class="student-item' + active + '" onclick="window.selectStudent(' + s.passport_id + ')">' +
        '<div class="student-item-name">' + esc(s.display_name || '?') + '</div>' +
        '<div class="student-item-meta">' + s.active_goals + ' ' + t('teacher.active_goals_n') + ' · ' + lastStr + '</div>' +
        '</div>';
    }).join('');
  }

  window.selectStudent = function(passportId) {
    _selected = passportId;
    renderStudentList();
    fetch('/api/teacher/students/' + passportId)
      .then(function(r) { return r.json(); })
      .then(renderStudentDetail)
      .catch(function() {
        document.getElementById('teacher-detail').innerHTML = empty(t('msg.error_loading'));
      });
  };

  function renderStudentDetail(d) {
    var detail = document.getElementById('teacher-detail');
    if (!detail) return;
    var passport = d.passport || {};
    var goals    = d.goals || [];
    var events   = d.events || [];

    var goalsHtml = goals.length
      ? goals.map(function(g) {
          var pct = Math.round(Number(g.progress)||0);
          var label = g.node_breadcrumb || g.node_label || g.text;
          return '<div class="teacher-goal-row">' +
            '<div class="teacher-goal-label">' + esc(label) + '</div>' +
            '<div class="p-bar-track"><div class="p-bar-fill" style="width:' + pct + '%;background:var(--accent)"></div></div>' +
            '<div class="teacher-goal-pct">' + pct + '%</div>' +
            (g.target_date ? '<div class="teacher-goal-target">' + t('label.goal_target_date') + ': ' + fmtDate(g.target_date) + '</div>' : '') +
            '</div>';
        }).join('')
      : empty(t('msg.no_active_goals'));

    var eventsHtml = events.length
      ? events.map(function(ev) {
          return '<div class="p-ledger-row">' +
            '<div class="p-ledger-date">' + fmtDate(ev.event_date) + '</div>' +
            '<div class="p-ledger-info"><div class="p-ledger-title">' + esc(ev.title) + '</div>' +
            (ev.institution ? '<div class="p-ledger-sub">' + esc(ev.institution) + '</div>' : '') + '</div>' +
            '</div>';
        }).join('')
      : empty(t('msg.no_events'));

    detail.innerHTML =
      '<div class="teacher-detail-header">' +
        '<div class="teacher-student-name">' + esc(passport.display_name || '?') + '</div>' +
        '<button class="p-edit-btn" onclick="window.showSuggestGoal(' + _selected + ')">' + t('teacher.suggest_goal') + '</button>' +
      '</div>' +
      '<div class="p-card-title">' + t('section.goals') + '</div>' +
      goalsHtml +
      '<div class="p-card-title" style="margin-top:24px">' + t('label.recent_activity') + '</div>' +
      '<div class="p-scroll-lg">' + eventsHtml + '</div>';
  }

  window.showSuggestGoal = function(passportId) {
    var nodeId = prompt(t('teacher.suggest_goal_prompt'));
    if (!nodeId) return;
    var deadlineStr = prompt(t('teacher.suggest_goal_deadline'), '');
    fetch('/api/teacher/students/' + passportId + '/goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_external_id: nodeId.trim(), target_date: deadlineStr || null }),
    }).then(function() { window.selectStudent(passportId); }).catch(function() {});
  };

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

  loadStudents();
})();
