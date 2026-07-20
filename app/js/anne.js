/* ═══════════════════════════════════════════════════════════════
   ANNE  —  anne.js  (Map View sub-module)
   ───────────────────────────────────────────────────────────────
   Owns  : mentor chat widget — avatar, panel, open/minimize, chat
   Calls : window.Anne.setVisible(bool)  — map-view-only scoping,
           called from learning.js / testing.js / index.html overlay
           POST /api/anne/message (SSE), GET /api/anne/messages
   Never : touch D3 internals, sidebar, filter panel
   ═══════════════════════════════════════════════════════════════ */

(function () {

  /* ─── DOM refs ───────────────────────────────────────────────────────── */
  var widget    = document.getElementById('anne-widget');
  var avatar    = document.getElementById('anne-avatar');
  var panel     = document.getElementById('anne-panel');
  var minimize  = document.getElementById('anne-minimize');
  var messages  = document.getElementById('anne-messages');
  var input     = document.getElementById('anne-input');
  var sendBtn   = document.getElementById('anne-send');

  var _historyLoaded = false;
  var _sending        = false;

  /* ─── Open / close ───────────────────────────────────────────────────── */
  avatar.addEventListener('click', function (e) {
    e.stopPropagation();
    if (panel.classList.contains('open')) {
      panel.classList.remove('open');
      return;
    }
    panel.classList.add('open');
    if (!_historyLoaded) _loadHistory();
    setTimeout(function () { input.focus(); }, 160);
  });

  minimize.addEventListener('click', function (e) {
    e.stopPropagation();
    panel.classList.remove('open');
  });

  document.addEventListener('click', function (e) {
    if (!panel.contains(e.target) && e.target !== avatar) {
      panel.classList.remove('open');
    }
  });

  panel.addEventListener('click', function (e) { e.stopPropagation(); });

  /* ─── Rendering ──────────────────────────────────────────────────────── */
  function _escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // The model isn't told to avoid markdown here (unlike the lesson tutor prompts) —
  // render **bold** properly instead of showing literal asterisks.
  function _mdBold(escapedText) {
    return escapedText.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }

  function _renderMsgHtml(text) {
    return _mdBold(_escHtml(text)).replace(/\n/g, '<br>');
  }

  function _scrollToBottom() {
    messages.scrollTop = messages.scrollHeight;
  }

  function _appendMessage(role, text) {
    var el = document.createElement('div');
    el.className = 'anne-msg anne-msg-' + (role === 'user' ? 'user' : 'assistant');
    el.innerHTML = _renderMsgHtml(text);
    messages.appendChild(el);
    _scrollToBottom();
    return el;
  }

  function _showThinking() {
    var el = document.createElement('div');
    el.id = 'anne-thinking';
    el.className = 'block-loading';
    el.innerHTML = '<span class="loading-dot"></span><span class="loading-dot"></span><span class="loading-dot"></span>' +
                   '<span class="loading-status"></span>';
    messages.appendChild(el);
    _scrollToBottom();
  }

  function _setThinkingStatus(key) {
    var el = document.getElementById('anne-thinking');
    if (!el) return;
    var span = el.querySelector('.loading-status');
    if (span && window.t) span.textContent = window.t('status.' + key);
  }

  function _removeThinking() {
    var el = document.getElementById('anne-thinking');
    if (el) el.remove();
  }

  /* ─── History (lazy-loaded on first open) ───────────────────────────── */
  function _loadHistory() {
    _historyLoaded = true;
    fetch('/api/anne/messages')
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        if (!Array.isArray(rows)) return;
        rows.forEach(function (row) { _appendMessage(row.role, row.content); });
      })
      .catch(function () {});
  }

  /* ─── Sending ────────────────────────────────────────────────────────── */
  function _send() {
    var text = (input.value || '').trim();
    if (!text || _sending) return;
    _sending = true;
    input.value = '';
    input.disabled = true;
    sendBtn.disabled = true;

    _appendMessage('user', text);
    _showThinking();

    var replyEl = null;
    var buf = '';

    fetch('/api/anne/message', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message: text }),
    }).then(function (r) {
      if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
      var reader  = r.body.getReader();
      var decoder = new TextDecoder();
      var lineBuf = '';
      function pump() {
        return reader.read().then(function (result) {
          if (result.done) return;
          lineBuf += decoder.decode(result.value, { stream: true });
          var lines = lineBuf.split('\n');
          lineBuf = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line.startsWith('data: ')) continue;
            var data = line.slice(6);
            if (data === '[DONE]') return;
            try {
              var obj = JSON.parse(data);
              if (obj.error) throw new Error('stream-error');
              if (obj.t) {
                if (!replyEl) { _removeThinking(); replyEl = _appendMessage('assistant', ''); }
                buf += obj.t;
                replyEl.innerHTML = _renderMsgHtml(buf);
                _scrollToBottom();
              } else if (obj.status) {
                _setThinkingStatus(obj.status);
              }
            } catch (e) {
              if (e.message === 'stream-error') throw e;
            }
          }
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      _removeThinking();
      if (!replyEl) _appendMessage('assistant', (window.t ? window.t('anne.error') : 'Something went wrong — please try again.'));
    }).then(function () {
      _sending = false;
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
    });
  }

  sendBtn.addEventListener('click', _send);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); _send(); }
  });

  /* ─── Map-view-only visibility scoping ──────────────────────────────── */
  window.Anne = window.Anne || {};
  window.Anne.setVisible = function (visible) {
    widget.style.display = visible ? '' : 'none';
    if (!visible) panel.classList.remove('open');
  };

})();
