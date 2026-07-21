/* ══════════════════════════════════════════════
   CONNECTIONS  —  js/connections.js
   Teacher/parent/admin ↔ learner account links. Lives in Seaded
   (settings.html). Codes are persistent and reusable — stored on the
   teacher/parent's own account (users.link_code) rather than single-use,
   so many students/children can redeem the same code until it's
   regenerated. See server/services/links.js for the redemption rules.
   ══════════════════════════════════════════════ */

(function () {
  var _role = null;
  var _isAdmin = false;
  var _myCodeAsRole = null; // admin only — which kind of code they're viewing/generating

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ── generic confirm modal (shared: disconnect, regenerate code) ── */
  function showConfirm(title, text, confirmLabel, onConfirm) {
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-text').textContent = text;
    var confirmBtn = document.getElementById('confirm-modal-confirm-btn');
    confirmBtn.textContent = confirmLabel;
    var modal = document.getElementById('confirm-modal');
    modal.classList.add('active');
    function handler() {
      modal.classList.remove('active');
      confirmBtn.removeEventListener('click', handler);
      onConfirm();
    }
    confirmBtn.addEventListener('click', handler);
  }
  var cancelBtn = document.getElementById('confirm-modal-cancel-btn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', function () {
      document.getElementById('confirm-modal').classList.remove('active');
    });
  }

  /* ── connections list ──
     item.role is the TYPE of the connection (teacher-link or parent-link),
     not the role of the person in this particular row — the badge must be
     picked relative to which side we're rendering: on my own "as student"
     side the other party IS a teacher/parent, but on my "as linked" side
     (viewing my own students/children) the other party is a learner. */
  function linkRow(item, badgeClass, badgeLabel, name) {
    return '<div class="cx-row-item">'
      + '<div class="cx-role-badge ' + badgeClass + '">' + esc(badgeLabel) + '</div>'
      + '<div class="cx-row-name">' + esc(name) + '</div>'
      + '<button class="cx-remove-btn" data-link-id="' + item.id + '" title="' + esc(t('btn.remove')) + '">×</button>'
      + '</div>';
  }

  function renderList(links) {
    var listEl = document.getElementById('connections-list');
    if (!listEl) return;
    var asStudent = links.asStudent || [];
    var asLinked  = links.asLinked  || [];
    var teacherLinks = asStudent.filter(function (l) { return l.role === 'teacher'; });
    var parentLinks  = asStudent.filter(function (l) { return l.role === 'parent'; });
    var studentLinks = asLinked.filter(function (l) { return l.role === 'teacher'; }); // I'm their teacher
    var childLinks    = asLinked.filter(function (l) { return l.role === 'parent'; }); // I'm their parent

    var html = '';
    if (!asStudent.length && !asLinked.length) {
      html = '<div class="cx-empty">' + esc(t('msg.no_links')) + '</div>';
    } else {
      if (teacherLinks.length) {
        html += '<div class="cx-group-label">' + esc(t('link.my_teachers')) + '</div>'
          + teacherLinks.map(function (l) { return linkRow(l, 'teacher', t('link.role_teacher'), l.linked_name); }).join('');
      }
      if (parentLinks.length) {
        html += '<div class="cx-group-label">' + esc(t('link.my_parents')) + '</div>'
          + parentLinks.map(function (l) { return linkRow(l, 'parent', t('link.role_parent'), l.linked_name); }).join('');
      }
      if (studentLinks.length) {
        html += '<div class="cx-group-label">' + esc(t('link.my_students')) + '</div>'
          + studentLinks.map(function (l) { return linkRow(l, 'student', t('link.role_student'), l.student_name || t('link.pending_student')); }).join('');
      }
      if (childLinks.length) {
        html += '<div class="cx-group-label">' + esc(t('link.my_children')) + '</div>'
          + childLinks.map(function (l) { return linkRow(l, 'child', t('link.role_child'), l.student_name || t('link.pending_student')); }).join('');
      }
    }
    listEl.innerHTML = html;

    listEl.querySelectorAll('[data-link-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.dataset.linkId;
        showConfirm(
          t('link.disconnect_confirm_title'),
          t('link.disconnect_confirm_text'),
          t('btn.disconnect'),
          function () {
            fetch('/api/links/' + id, { method: 'DELETE' })
              .then(function () { loadConnections(); })
              .catch(function () {});
          }
        );
      });
    });
  }

  function loadConnections() {
    fetch('/api/links').then(function (r) {
      if (!r.ok) throw new Error('load_failed');
      return r.json();
    }).then(renderList).catch(function () {
      var listEl = document.getElementById('connections-list');
      if (listEl) listEl.innerHTML = '<div class="cx-empty">' + esc(t('msg.load_failed')) + '</div>';
    });
  }

  /* ── learner: redeem a code ── */
  var redeemBtn = document.getElementById('cx-redeem-btn');
  if (redeemBtn) {
    redeemBtn.addEventListener('click', function () {
      var input = document.getElementById('cx-code-input');
      var msg   = document.getElementById('cx-redeem-msg');
      var code  = input.value.trim();
      msg.textContent = '';
      msg.className = 'cx-msg';
      if (!code) return;
      redeemBtn.disabled = true;
      fetch('/api/links/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code }),
      }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          redeemBtn.disabled = false;
          if (res.ok) {
            input.value = '';
            msg.className = 'cx-msg ok';
            msg.textContent = res.d.alreadyConnected ? t('msg.already_connected') : t('msg.link_accepted');
            loadConnections();
            return;
          }
          var messages = {
            invalid_code:        t('msg.invalid_code'),
            self:                t('msg.invalid_code'),
            role_not_allowed:    t('msg.link_role_not_allowed'),
            birth_year_required: t('msg.link_birth_year_required'),
            too_old:             t('msg.link_too_old'),
          };
          msg.className = 'cx-msg err';
          msg.textContent = messages[res.d.error] || t('msg.save_failed_short');
        })
        .catch(function () {
          redeemBtn.disabled = false;
          msg.className = 'cx-msg err';
          msg.textContent = t('msg.save_failed_short');
        });
    });
  }

  /* ── teacher/parent/admin: my code ── */
  function updateMyCodeLabel(role) {
    var label = document.getElementById('cx-mycode-label');
    if (!label) return;
    label.textContent = role === 'parent' ? t('link.my_code_parent') : t('link.my_code_teacher');
  }

  function renderMyCode(data) {
    var display = document.getElementById('cx-code-display');
    var hint    = document.getElementById('cx-mycode-hint');
    if (!display) return;

    if (data.role) {
      _myCodeAsRole = data.role;
      updateMyCodeLabel(data.role);
      var picker = document.getElementById('cx-role-picker');
      if (picker) {
        picker.querySelectorAll('[data-role]').forEach(function (b) {
          b.classList.toggle('active', b.dataset.role === data.role);
        });
      }
    }

    if (!data.code) {
      display.innerHTML = '<span class="cx-no-code">' + esc(t('link.no_code_yet')) + '</span>';
      hint.textContent = '';
      return;
    }
    display.innerHTML =
      '<span class="cx-code-value">' + esc(data.code) + '</span>'
      + '<button class="settings-save-btn settings-save-btn-inline" id="cx-copy-btn">' + esc(t('btn.copy_code')) + '</button>';
    var when = data.generatedAt ? new Date(data.generatedAt).toLocaleString() : '';
    var reusableHint = data.role === 'parent' ? t('link.code_hint_reusable_parent') : t('link.code_hint_reusable_teacher');
    hint.textContent = reusableHint + (when ? ' ' + t('link.generated_at_prefix') + ' ' + when : '');
    var copyBtn = document.getElementById('cx-copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        navigator.clipboard.writeText(data.code);
        copyBtn.textContent = t('msg.copied');
        setTimeout(function () { copyBtn.textContent = t('btn.copy_code'); }, 1500);
      });
    }
  }

  function loadMyCode() {
    fetch('/api/links/my-code').then(function (r) { return r.json(); }).then(renderMyCode).catch(function () {});
  }

  var generateBtn = document.getElementById('cx-generate-btn');
  if (generateBtn) {
    generateBtn.addEventListener('click', function () {
      if (_isAdmin && !_myCodeAsRole) {
        _myCodeAsRole = 'teacher'; // sensible default if admin never touched the picker
      }
      function doGenerate() {
        var body = _isAdmin ? { asRole: _myCodeAsRole } : {};
        fetch('/api/links/my-code/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(function (r) { return r.json(); })
          .then(function (d) { if (d.code) renderMyCode(d); })
          .catch(function () {});
      }
      fetch('/api/links/my-code').then(function (r) { return r.json(); }).then(function (existing) {
        if (existing.code) {
          showConfirm(
            t('link.regenerate_confirm_title'),
            t('link.regenerate_confirm_text'),
            t('btn.regenerate_code'),
            doGenerate
          );
        } else {
          doGenerate();
        }
      }).catch(doGenerate);
    });
  }

  /* ── init: show the right rows for this account's role ─────────────── */
  fetch('/auth/me').then(function (r) { return r.json(); }).then(function (user) {
    if (!user || !user.id) return;
    _role = user.role;
    _isAdmin = _role === 'admin' || _role === 'super_admin';

    if (_role === 'learner' || _isAdmin) {
      var row = document.getElementById('connections-redeem-row');
      if (row) row.style.display = '';
    }

    if (_role === 'teacher' || _role === 'parent' || _isAdmin) {
      var row2 = document.getElementById('connections-mycode-row');
      if (row2) row2.style.display = '';
      if (_role === 'teacher' || _role === 'parent') {
        // Label is known from the account's own role immediately — no need
        // to wait for a code to exist (renderMyCode only learns the role
        // from the fetched code, which is null before the first generate).
        updateMyCodeLabel(_role);
      }
      if (_isAdmin) {
        _myCodeAsRole = 'teacher';
        updateMyCodeLabel(_myCodeAsRole);
        var picker = document.getElementById('cx-role-picker');
        if (picker) {
          picker.style.display = '';
          picker.querySelectorAll('[data-role]').forEach(function (b) {
            b.classList.toggle('active', b.dataset.role === _myCodeAsRole);
          });
          picker.addEventListener('click', function (e) {
            var btn = e.target.closest('[data-role]');
            if (!btn) return;
            _myCodeAsRole = btn.dataset.role;
            picker.querySelectorAll('[data-role]').forEach(function (b) { b.classList.toggle('active', b === btn); });
            updateMyCodeLabel(_myCodeAsRole);
          });
        }
      }
      loadMyCode();
    }

    loadConnections();
  }).catch(function () {});
}());
