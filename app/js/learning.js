/* ═══════════════════════════════════════════════════════════════
   LEARNING MODE  —  learning.js
   ───────────────────────────────────────────────────────────────
   Owns  : #learning-mode overlay, lm-path / lm-knobit / lm-complete
           views, knobit flow (explain → demonstrate → practice → meaning)
   Exposes: window.Learn.open(node, crumb, knobits)
            window.Learn.close()
            window.Learn.showView(id)
   Calls  : window.MapView.refreshProgress()
   Never  : touch app.js map rendering, test.js, or #lm-test
   ═══════════════════════════════════════════════════════════════ */

(function () {

  /* ─── State ──────────────────────────────────────────────────── */
  var _node             = null;
  var _crumb            = '';
  var KNOBITS           = [];
  var KNOBIT_TOTAL      = 0;
  var KNOBIT_DONE_COUNT = 0;
  var CURRENT_KNOBIT_IDX = 0;

  var _phase        = null;
  var _byteIdx      = 0;
  var _demoIdx      = 0;
  var _practiceIdx  = 0;
  var _streamBlocks = [];
  var _priorChoices = [];
  var _loading      = false;
  var _starting     = false;   // guard against double-start
  var _retryFn          = null;
  var _autoRetryCount   = 0;
  var _MAX_AUTO_RETRY   = 3;
  var _pendingPractice = null;
  var _lastDemoBody    = '';   // previous example's body, sent so the next example doesn't repeat it

  var _PHASES = ['explain', 'demonstrate', 'practice', 'meaning'];
  var MAX_EXPLAIN_BYTES = 6;

  var _knobitStarted  = false;
  var _streamButtonEl = null;
  var _quitCallback   = null;

  // URLs of visuals already shown in the current knobit — sent to server to avoid duplicates
  var _seenVisualUrls = [];

  /* ─── API helper ──────────────────────────────────────────────── */
  function apiInteract(params) {
    var knobit = KNOBITS[CURRENT_KNOBIT_IDX];
    if (!knobit) return Promise.reject(new Error('No knobit'));
    var body = Object.assign({ knobitId: knobit.id }, params);
    return fetch('/api/learn/interact', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // Streaming variant: calls the same endpoint with stream:true.
  // Calls onChunk(text) for each token. Returns a Promise that resolves when done.
  function apiInteractStream(params, onChunk) {
    var knobit = KNOBITS[CURRENT_KNOBIT_IDX];
    if (!knobit) return Promise.reject(new Error('No knobit'));
    var body = Object.assign({ knobitId: knobit.id, stream: true }, params);
    return fetch('/api/learn/interact', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (!r.body) throw new Error('No stream');
      var reader  = r.body.getReader();
      var decoder = new TextDecoder();
      var buf     = '';
      function pump() {
        return reader.read().then(function (result) {
          if (result.done) return;
          buf += decoder.decode(result.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line.startsWith('data: ')) continue;
            var data = line.slice(6);
            if (data === '[DONE]') return;
            try {
              var obj = JSON.parse(data);
              if (obj.error) throw new Error('stream-error');
              if (obj.t) onChunk(obj.t);
            } catch (e) {
              if (e.message === 'stream-error') throw e;
            }
          }
          return pump();
        });
      }
      return pump();
    });
  }

  // Create an initially-empty block that will be filled by streaming tokens.
  // Returns { el, block } where block.content is kept in sync with _streamBlocks.
  function _appendLiveBlock(type) {
    var block = { type: type, content: '' };
    var el = _appendBlock(block);
    return { el: el, block: block };
  }

  function _updateLiveBlock(el, block, text) {
    block.content = text;
    if (!el) return;
    el.innerHTML = _escHtml(text).replace(/\n/g, '<br>');
    _scrollStream();
  }

  function apiComplete(knobitId) {
    return fetch('/api/learn/knobit/' + knobitId + '/complete', { method: 'POST' })
      .catch(function () {});
  }

  /* ─── Entry / exit ────────────────────────────────────────────── */
  var _searchWrap = null;

  window.openLearningMode = function (node, crumb, knobits) {
    // Hide search box — meaningless in learning view
    _searchWrap = document.querySelector('.topbar-search-wrap');
    if (_searchWrap) _searchWrap.style.display = 'none';
    _node             = node;
    _crumb            = crumb || '';
    KNOBITS            = Array.isArray(knobits) && knobits.length ? knobits : [];
    KNOBIT_TOTAL       = KNOBITS.length;
    KNOBIT_DONE_COUNT  = KNOBITS.filter(function(k) { return k.done; }).length;
    CURRENT_KNOBIT_IDX = KNOBIT_DONE_COUNT < KNOBIT_TOTAL ? KNOBIT_DONE_COUNT : 0;

    // Accent colours from node — set on #learning-mode so CSS palette default wins before a node is chosen
    var hex   = (node && node.color) ? node.color : '#C4826A';
    var r     = parseInt(hex.slice(1,3), 16);
    var g     = parseInt(hex.slice(3,5), 16);
    var b     = parseInt(hex.slice(5,7), 16);
    var alpha = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--node-alpha').trim()) || 0.13;
    var lm    = document.getElementById('learning-mode');
    lm.style.setProperty('--lm-accent', hex);
    lm.style.setProperty('--lm-accent-soft', 'rgba('+r+','+g+','+b+','+alpha+')');

    _buildPathView();
    showLmView('lm-path');
    var overlay = document.getElementById('learning-mode');
    if (overlay) overlay.classList.add('active');

    // Show one-time fullscreen tip
    if (!localStorage.getItem('lm_fs_tip_shown')) {
      var tip = document.getElementById('lm-fs-tip');
      if (tip) tip.style.display = '';
    }

    _ambientStart();
  };

  window.closeLearningMode = function () {
    _knobitStarted = false;
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    _ambientStop();
    _stopFocusTimer();
    var overlay = document.getElementById('learning-mode');
    if (overlay) overlay.classList.remove('active');
    // Restore search box — always, whether hidden by learning or test mode
    var sw = _searchWrap || document.querySelector('.topbar-search-wrap');
    if (sw) sw.style.display = '';
    _searchWrap = null;
    _node   = null;
    KNOBITS = [];
  };

  /* ─── Fullscreen ─────────────────────────────────────────────── */
  function _updateFsBtn() {
    var enter = document.getElementById('lm-fs-icon-enter');
    var exit  = document.getElementById('lm-fs-icon-exit');
    var btn   = document.getElementById('lm-fs-btn');
    var isFs  = !!document.fullscreenElement;
    if (enter) enter.style.display = isFs ? 'none' : '';
    if (exit)  exit.style.display  = isFs ? '' : 'none';
    if (btn) {
      var key = isFs ? 'lm.fullscreen_exit' : 'lm.fullscreen_enter';
      btn.title = window.t ? window.t(key) : (isFs ? 'Exit fullscreen' : 'Enter fullscreen');
      btn.setAttribute('data-i18n-title', key);
    }
  }

  window._enterLmFullscreen = function () {
    var el = document.getElementById('learning-mode') || document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen().catch(function () {});
    window._dismissFsTip();
  };

  window._toggleLmFullscreen = function () {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(function () {});
    } else {
      window._enterLmFullscreen();
    }
  };

  window._dismissFsTip = function () {
    localStorage.setItem('lm_fs_tip_shown', '1');
    var tip = document.getElementById('lm-fs-tip');
    if (tip) tip.style.display = 'none';
  };

  document.addEventListener('fullscreenchange', _updateFsBtn);

  /* ─── Ambient sound ───────────────────────────────────────────── */
  var _ambientFadeTimer = null;

  function _ambientEnabled() {
    // Default: on. Disabled only if user explicitly set 'off'.
    return !(window._loadedSettings && window._loadedSettings.ambient_sound === 'off');
  }

  function _ambientMuted() {
    return localStorage.getItem('lm_ambient_muted') === '1';
  }

  function _updateAmbientBtn() {
    var on  = document.getElementById('lm-ambient-icon-on');
    var off = document.getElementById('lm-ambient-icon-off');
    var btn = document.getElementById('lm-ambient-btn');
    var muted = _ambientMuted();
    if (on)  on.style.display  = muted ? 'none' : '';
    if (off) off.style.display = muted ? '' : 'none';
    if (btn) {
      var key = muted ? 'lm.ambient_on' : 'lm.ambient_off';
      btn.title = window.t ? window.t(key) : (muted ? 'Play café ambience' : 'Mute café ambience');
      btn.setAttribute('data-i18n-title', key);
    }
  }

  function _ambientFadeTo(audio, targetVol, duration, onDone) {
    clearInterval(_ambientFadeTimer);
    var steps = 20;
    var interval = duration / steps;
    var step = (targetVol - audio.volume) / steps;
    _ambientFadeTimer = setInterval(function () {
      var next = audio.volume + step;
      if ((step > 0 && next >= targetVol) || (step < 0 && next <= targetVol)) {
        audio.volume = targetVol;
        clearInterval(_ambientFadeTimer);
        if (onDone) onDone();
      } else {
        audio.volume = next;
      }
    }, interval);
  }

  function _ambientStart() {
    if (!_ambientEnabled() || _ambientMuted()) { _updateAmbientBtn(); return; }
    var audio = document.getElementById('lm-ambient');
    if (!audio) { _updateAmbientBtn(); return; }
    audio.volume = 0;
    audio.play().catch(function () {});
    _ambientFadeTo(audio, 0.35, 2000);
    _updateAmbientBtn();
  }

  function _ambientStop() {
    var audio = document.getElementById('lm-ambient');
    if (!audio || audio.paused) return;
    _ambientFadeTo(audio, 0, 1500, function () { audio.pause(); audio.currentTime = 0; });
  }

  window._toggleAmbient = function () {
    var muted = _ambientMuted();
    localStorage.setItem('lm_ambient_muted', muted ? '0' : '1');
    var audio = document.getElementById('lm-ambient');
    if (!audio) { _updateAmbientBtn(); return; }
    if (!muted) {
      // muting now
      _ambientFadeTo(audio, 0, 800, function () { audio.pause(); });
    } else {
      // unmuting
      audio.volume = 0;
      audio.play().catch(function () {});
      _ambientFadeTo(audio, 0.35, 1000);
    }
    _updateAmbientBtn();
  };

  /* ─── Focus timer ─────────────────────────────────────────────── */
  var _focusInterval    = null;
  var _breakInterval    = null;
  var _focusSecondsLeft = 0;
  var _breakSecondsLeft = 0;
  var BREAK_SECONDS     = 600; // 10 minutes, fixed

  function _focusTimerEnabled() {
    // Default: on. Disabled only if user explicitly set 'off'.
    return !(window._loadedSettings && window._loadedSettings.focus_timer === 'off');
  }

  function _focusTimerMinutes() {
    var m = window._loadedSettings && parseInt(window._loadedSettings.focus_timer_minutes, 10);
    return (m && m > 0) ? m : 20;
  }

  function _formatMMSS(totalSeconds) {
    var s = Math.max(0, totalSeconds);
    var m = Math.floor(s / 60);
    var sec = s % 60;
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  // Short two-tone chime, synthesized (no audio asset — Web Audio oscillators).
  // Browsers create new AudioContexts in a "suspended" state unless one is
  // created/resumed during a real user gesture; the chime otherwise fires
  // silently since it's triggered by a setInterval, not a click. So the
  // context is created once, eagerly, from _startFocusTimer() — which always
  // runs inside the click-triggered startKnobit() call chain — and reused
  // (and re-resumed, harmless if already running) here.
  var _chimeCtx = null;
  function _primeChimeContext() {
    if (_chimeCtx) { _chimeCtx.resume().catch(function () {}); return; }
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) _chimeCtx = new Ctx();
    } catch (e) { /* Web Audio unsupported */ }
  }

  function _playChime() {
    if (!_chimeCtx) { _primeChimeContext(); }
    if (!_chimeCtx) return;
    try {
      _chimeCtx.resume().catch(function () {});
      [523.25, 659.25].forEach(function (freq, i) {
        var osc  = _chimeCtx.createOscillator();
        var gain = _chimeCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        var start = _chimeCtx.currentTime + i * 0.18;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.25, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
        osc.connect(gain).connect(_chimeCtx.destination);
        osc.start(start);
        osc.stop(start + 0.55);
      });
    } catch (e) { /* Web Audio blocked — silently skip the chime */ }
  }

  function _startFocusTimer() {
    clearInterval(_focusInterval);
    clearInterval(_breakInterval);
    var modal = document.getElementById('focus-break-modal');
    if (modal) modal.style.display = 'none';
    var el = document.getElementById('lm-focus-timer');
    if (!_focusTimerEnabled()) { if (el) el.style.display = 'none'; return; }
    _primeChimeContext(); // unlock audio now, while still inside the click gesture that led here
    _focusSecondsLeft = _focusTimerMinutes() * 60;
    if (el) el.style.display = '';
    _updateFocusTimerDisplay();
    _focusInterval = setInterval(function () {
      _focusSecondsLeft--;
      _updateFocusTimerDisplay();
      if (_focusSecondsLeft <= 0) {
        clearInterval(_focusInterval);
        _showBreakDialog();
      }
    }, 1000);
  }

  // Called at the start of every knobit. Previously this always hard-reset
  // the countdown to a fresh N minutes — so a learner moving quickly from
  // knobit to knobit (each one finishing well under the limit) never
  // actually reached zero and never got prompted to take a break, since the
  // clock kept getting wound back before it could run out. Now it only
  // starts a fresh cycle if one isn't already ticking; an in-progress
  // countdown carries over across knobit boundaries untouched.
  function _continueOrStartFocusTimer() {
    if (_focusInterval) { _primeChimeContext(); return; }
    _startFocusTimer();
  }

  function _stopFocusTimer() {
    clearInterval(_focusInterval);
    clearInterval(_breakInterval);
    var el = document.getElementById('lm-focus-timer');
    if (el) el.style.display = 'none';
    var modal = document.getElementById('focus-break-modal');
    if (modal) modal.style.display = 'none';
  }

  function _updateFocusTimerDisplay() {
    var el = document.getElementById('lm-focus-timer-text');
    if (el) el.textContent = _formatMMSS(_focusSecondsLeft);
  }

  function _showBreakDialog() {
    var el = document.getElementById('lm-focus-timer');
    if (el) el.style.display = 'none';
    var modal = document.getElementById('focus-break-modal');
    if (modal) modal.style.display = 'flex';
    _breakSecondsLeft = BREAK_SECONDS;
    _updateBreakTimerDisplay();
    _breakInterval = setInterval(function () {
      _breakSecondsLeft--;
      _updateBreakTimerDisplay();
      if (_breakSecondsLeft <= 0) {
        clearInterval(_breakInterval);
        _playChime();
        var m = document.getElementById('focus-break-modal');
        if (m) m.style.display = 'none';
        _startFocusTimer();
      }
    }, 1000);
  }

  function _updateBreakTimerDisplay() {
    var el = document.getElementById('focus-break-countdown');
    if (el) el.textContent = _formatMMSS(_breakSecondsLeft);
  }

  /* ─── View switching ──────────────────────────────────────────── */
  window.showLmView = function (id) {
    ['lm-path', 'lm-knobit', 'lm-complete'].forEach(function (v) {
      var el = document.getElementById(v);
      if (el) el.classList.toggle('active', v === id);
    });
  };

  /* ─── View 1 — Learning Path ──────────────────────────────────── */
  function _buildPathView() {
    var crumbEl = document.getElementById('lm-path-crumb');
    var titleEl = document.getElementById('lm-path-title');
    var fillEl  = document.getElementById('lm-progress-fill');
    var labelEl = document.getElementById('lm-progress-label');
    var listEl  = document.getElementById('lm-knobit-list');

    if (crumbEl) crumbEl.textContent = _crumb;
    if (titleEl) titleEl.textContent = _node ? _node.label : '';

    var pct = KNOBIT_TOTAL ? Math.round((KNOBIT_DONE_COUNT / KNOBIT_TOTAL) * 100) : 0;
    if (fillEl)  fillEl.style.width   = pct + '%';
    if (labelEl) labelEl.textContent  = pct + t('msg.pct_complete_suffix') + (pct < 100 ? ' ' + t('msg.keep_going') : '');

    if (!listEl) return;
    listEl.innerHTML = '';

    if (!KNOBITS.length) {
      listEl.innerHTML = '<div class="lm-no-content">' + t('msg.no_content_yet') + '</div>';
      return;
    }

    KNOBITS.forEach(function (k, i) {
      var done    = i < KNOBIT_DONE_COUNT;
      var current = i === CURRENT_KNOBIT_IDX;
      var locked  = !done && !current;
      var item    = document.createElement('div');
      item.className = 'lm-knobit-item' + (done ? ' done' : '') + (current ? ' current' : '') + (locked ? ' locked' : '');

      var num       = document.createElement('div');
      num.className = 'lm-knobit-num';
      num.textContent = done ? '✓' : String(i + 1);
      item.appendChild(num);

      var name       = document.createElement('div');
      name.className = 'lm-knobit-name';
      name.textContent = k.title || ('Knobit ' + (i + 1));
      item.appendChild(name);

      if (current) {
        item.addEventListener('click', window.startKnobit);
      }
      listEl.appendChild(item);
    });
  }

  /* ─── View 2 — Knobit lesson ──────────────────────────────────── */
  window.startKnobit = function () {
    if (!KNOBITS.length || _starting) return;
    _starting = true;
    _knobitStarted  = true;
    _streamButtonEl = null;
    var k = KNOBITS[CURRENT_KNOBIT_IDX];

    _streamBlocks   = [];
    _priorChoices   = [];
    _byteIdx        = 0;
    _demoIdx        = 0;
    _practiceIdx    = 0;
    _pendingPractice = null;
    _lastDemoBody    = '';
    _seenVisualUrls  = [];

    var stream = document.getElementById('kn-stream');
    if (stream) stream.innerHTML = '';
    var navLabel = document.getElementById('lm-knobit-nav-label');
    if (navLabel) navLabel.textContent = k.title || '';

    _setPhase('explain');
    showLmView('lm-knobit');

    _setButtonRow('');
    _appendPhaseDivider(t('phase.step_1'));
    _continueOrStartFocusTimer();
    _fetchInitialExplain();
  };

  function _fetchInitialExplain() {
    _retryFn = _fetchInitialExplain;
    _showLoadingBlock();
    var live = null, fullText = '';
    apiInteractStream({ phase: 'explain', byteIndex: 0, priorChoices: [] }, function (chunk) {
      fullText += chunk;
      if (!live) { _removeLoadingBlock(); live = _appendLiveBlock('byte'); }
      _updateLiveBlock(live.el, live.block, fullText);
    }).then(function () {
      _starting = false; _retryFn = null;
      if (!live) { _removeLoadingBlock(); _appendBlock({ type: 'byte', content: fullText }); }
      _appendVisualLoader(fullText);
      _setButtonRow('explain-options');
    }).catch(function () {
      _starting = false;
      _onApiError();
    });
  }

  /* ─── Phase chip management ───────────────────────────────────── */
  function _setPhase(phase) {
    _phase = phase;
    var pcts = { explain: 0, demonstrate: 25, practice: 50, meaning: 75 };
    var bar  = document.getElementById('kn-progress-fill-bar');
    if (bar) bar.style.width = (pcts[phase] || 0) + '%';

    document.querySelectorAll('#lm-knobit .kn-chip').forEach(function (chip) {
      var cp  = chip.dataset.phase;
      var pi  = _PHASES.indexOf(phase);
      var ci  = _PHASES.indexOf(cp);
      chip.classList.remove('active', 'done-chip', 'locked-chip');
      if (cp === phase)   chip.classList.add('active');
      else if (ci < pi)   chip.classList.add('done-chip');
      else if (ci > pi)   chip.classList.add('locked-chip');
    });
  }

  /* ─── Button rows ─────────────────────────────────────────────── */
  function _setButtonRow(type) {
    if (_streamButtonEl && _streamButtonEl.parentNode) {
      _streamButtonEl.parentNode.removeChild(_streamButtonEl);
    }
    _streamButtonEl = null;
    if (!type) return;

    var s = document.getElementById('kn-stream');
    if (!s) return;

    var area = document.createElement('div');
    area.className = 'kn-button-row';
    _streamButtonEl = area;

    function btn(label, handler, cls) {
      var b = document.createElement('button');
      b.className   = 'kn-option-btn' + (cls ? ' ' + cls : '');
      b.textContent = label;
      b.addEventListener('click', handler);
      area.appendChild(b);
      return b;
    }

    if (type === 'explain-options') {
      btn(t('btn.i_understand'),       function () { window.explainOpt('ok');      }, 'btn-understand');
      btn(t('btn.i_dont_understand'),  function () { window.explainOpt('no');      }, 'btn-other');
      btn(t('btn.too_simplistic'),     function () { window.explainOpt('simpler'); }, 'btn-adjust');
      btn(t('btn.too_complex'),        function () { window.explainOpt('complex'); }, 'btn-adjust');
    } else if (type === 'demo-1') {
      btn(t('btn.view_next_example'),  function () { window.demoOpt('next');    }, 'btn-other');
    } else if (type === 'demo-2') {
      btn(t('btn.i_understand_no_more'), function () { window.demoOpt('ok');      }, 'btn-understand');
      btn(t('btn.give_me_another'),      function () { window.demoOpt('another'); }, 'btn-other');
    } else if (type === 'demo-3') {
      btn(t('btn.i_understand_ready'),    function () { window.demoOpt('ok');       }, 'btn-understand');
      btn(t('btn.still_dont_understand'), function () { window.demoOpt('still-no'); }, 'btn-other');
    } else if (type === 'practice-submit') {
      btn(t('btn.submit_answer'), function () { window.practiceSubmit(); });
    } else if (type === 'practice-next') {
      btn(t('btn.yes_next_problem'), function () { window.practiceNext(); }, 'btn-other');
      btn(t('btn.no_im_done'),       function () { window.practiceDone(); }, 'btn-understand');
    } else if (type === 'meaning-options') {
      btn(t('btn.i_understand'),       function () { window.meaningOpt('ok');      }, 'btn-understand');
      btn(t('btn.i_dont_understand'),  function () { window.meaningOpt('no');      }, 'btn-other');
      btn(t('btn.too_simplistic'),     function () { window.meaningOpt('simpler'); }, 'btn-adjust');
      btn(t('btn.too_complex'),        function () { window.meaningOpt('complex'); }, 'btn-adjust');
    }

    s.appendChild(area);
    _scrollStream();
  }

  /* ─── Explain ─────────────────────────────────────────────────── */
  window.explainOpt = function (opt) {
    _lockButtons();
    _priorChoices.push(opt);
    _setButtonRow('');

    if (opt === 'ok') {
      _byteIdx++;
      if (_byteIdx >= MAX_EXPLAIN_BYTES) {
        _enterDemonstrate();
        return;
      }
    }

    // Advancing to a genuinely new byte needs the FULL explanation so far, not
    // just the single most recent byte — otherwise the model loses track of
    // what's already been covered a few bytes in and starts repeating or
    // contradicting itself. Rephrasing the current byte only needs that one
    // byte's own text (it's rewriting it, not building on it).
    var lastContent = opt === 'ok' ? _getAllContent(['byte']) : _getLastContent(['byte']);
    // action mapping: 'ok' → advance (undefined), 'no' → 'rephrase', 'simpler'/'complex' → pass through
    var action = opt === 'ok' ? undefined : (opt === 'no' ? 'rephrase' : opt);
    var wantVisual = (opt === 'ok');
    var capturedContent = lastContent, capturedAction = action, capturedWantVisual = wantVisual;
    _retryFn = function () {
      var live2 = null, fullText2 = '';
      _showLoadingBlock();
      apiInteractStream({ phase: 'explain', action: capturedAction, byteIndex: _byteIdx, priorChoices: _priorChoices, original: capturedContent }, function (chunk) {
        fullText2 += chunk;
        if (!live2) { _removeLoadingBlock(); live2 = _appendLiveBlock('byte'); }
        _updateLiveBlock(live2.el, live2.block, fullText2);
      }).then(function () {
        _retryFn = null;
        if (!live2) { _removeLoadingBlock(); _appendBlock({ type: 'byte', content: fullText2 }); }
        if (capturedWantVisual) _appendVisualLoader(fullText2);
        _setButtonRow('explain-options');
      }).catch(_onApiError);
    };
    _retryFn();
  };

  /* ─── Demonstrate ─────────────────────────────────────────────── */
  function _enterDemonstrate() {
    _appendPhaseDivider(t('phase.step_2'));
    _demoIdx = 0;
    _setPhase('demonstrate');
    _fetchDemo();
  }

  function _fetchDemo() {
    _retryFn = _fetchDemo;
    _showLoadingBlock();
    apiInteract({ phase: 'demonstrate', byteIndex: _demoIdx, previousExample: _lastDemoBody })
      .then(function (d) {
        _retryFn = null;
        _removeLoadingBlock();
        var ex   = d.demonstrate || {};
        var html = '<strong>Example ' + (_demoIdx + 1) + '</strong><br>' +
                   _escHtml(ex.body || '') +
                   (ex.whatIDid ? '<br><em class="lm-demo-what-i-did">What I did: ' + _escHtml(ex.whatIDid) + '</em>' : '');
        _appendBlock({ type: 'example', rawHtml: html });
        _lastDemoBody = ex.body || '';
        var rowType = _demoIdx === 0 ? 'demo-1' : _demoIdx === 1 ? 'demo-2' : 'demo-3';
        _setButtonRow(rowType);
      }).catch(_onApiError);
  }

  window.demoOpt = function (opt) {
    if (opt === 'ok') {
      _lockButtons();
      _setButtonRow('');
      _enterPractice();
    } else if (opt === 'next' || opt === 'another') {
      _lockButtons();
      _demoIdx++;
      _setButtonRow('');
      _fetchDemo();
    } else {
      _lockButtons();
      _appendBlock({ type: 'note', content: t('msg.try_youtube') + ' "' + (_node ? _node.label : '') + ' ' + t('msg.explained') + '"' });
      _setButtonRow('');
      setTimeout(_enterPractice, 1200);
    }
  };

  /* ─── Practice ────────────────────────────────────────────────── */
  function _enterPractice() {
    _appendPhaseDivider(t('phase.step_3'));
    _practiceIdx = 0;
    _setPhase('practice');
    _fetchPractice();
  }

  function _fetchPractice() {
    _retryFn = _fetchPractice;
    _showLoadingBlock();
    apiInteract({ phase: 'practice', byteIndex: _practiceIdx })
      .then(function (d) {
        _removeLoadingBlock();
        var prob = d.practice || {};
        _pendingPractice = prob;

        var wrapper = _appendBlock({ type: 'practice', content: 'Problem ' + (_practiceIdx + 1) + ': ' + (prob.question || '') });
        if (wrapper) {
          var inp         = document.createElement('textarea');
          inp.id          = 'kn-practice-input';
          inp.className   = 'kn-answer-input';
          inp.placeholder = t('placeholder.your_answer');
          inp.rows        = 2;
          wrapper.appendChild(inp);
        }
        _retryFn = null;
        _setButtonRow('practice-submit');
      }).catch(_onApiError);
  }

  window.practiceSubmit = function () {
    var inp = document.getElementById('kn-practice-input');
    var ans = inp ? inp.value.trim() : '';
    if (!ans) return;
    if (inp) inp.disabled = true;
    _lockButtons();
    _setButtonRow('');

    var prob = _pendingPractice || {};
    var capturedAns = ans, capturedProb = prob;
    _retryFn = function () {
      _showLoadingBlock();
      apiInteract({ phase: 'practice', action: 'grade', question: capturedProb.question || '', expected: capturedProb.expected || '', userAnswer: capturedAns })
        .then(function (d) { _retryFn = null; _removeLoadingBlock(); var g = d.grade || {}; _appendBlock({ type: 'feedback', content: (g.correct ? '✓ ' : '✗ ') + (g.feedback || '') }); _setButtonRow('practice-next'); })
        .catch(_onApiError);
    };
    _retryFn();
  };

  window.practiceNext = function () {
    _lockButtons();
    _practiceIdx++;
    _setButtonRow('');
    _fetchPractice();
  };

  window.practiceDone = function () {
    _lockButtons();
    _setButtonRow('');
    _enterMeaning();
  };

  /* ─── Meaning ─────────────────────────────────────────────────── */
  function _enterMeaning() {
    _appendPhaseDivider(t('phase.step_4'));
    _setPhase('meaning');
    _fetchMeaning();
  }

  function _fetchMeaning() {
    _retryFn = _fetchMeaning;
    _showLoadingBlock();
    var live = null, fullText = '';
    apiInteractStream({ phase: 'meaning' }, function (chunk) {
      fullText += chunk;
      if (!live) { _removeLoadingBlock(); live = _appendLiveBlock('meaning'); }
      _updateLiveBlock(live.el, live.block, fullText);
    }).then(function () {
      _retryFn = null;
      if (!live) { _removeLoadingBlock(); _appendBlock({ type: 'meaning', content: fullText }); }
      _setButtonRow('meaning-options');
    }).catch(_onApiError);
  }

  window.meaningOpt = function (opt) {
    if (opt === 'ok') {
      _lockButtons();
      _setButtonRow('');
      _completeKnobit();
      return;
    }
    _lockButtons();
    var capturedOpt = opt, capturedContent = _getLastContent(['meaning']);
    _retryFn = function () {
      var live2 = null, fullText2 = '';
      _showLoadingBlock();
      apiInteractStream({ phase: 'meaning', action: capturedOpt, original: capturedContent }, function (chunk) {
        fullText2 += chunk;
        if (!live2) { _removeLoadingBlock(); live2 = _appendLiveBlock('meaning'); }
        _updateLiveBlock(live2.el, live2.block, fullText2);
      }).then(function () {
        _retryFn = null;
        if (!live2) { _removeLoadingBlock(); _appendBlock({ type: 'meaning', content: fullText2 }); }
        _setButtonRow('meaning-options');
      }).catch(_onApiError);
    };
    _retryFn();
  };

  /* ─── Knobit completion ───────────────────────────────────────── */
  function _completeKnobit() {
    _knobitStarted = false;
    var k = KNOBITS[CURRENT_KNOBIT_IDX];
    KNOBIT_DONE_COUNT++;
    apiComplete(k.id);

    if (CURRENT_KNOBIT_IDX + 1 >= KNOBIT_TOTAL) {
      _showUnitComplete();
    } else {
      CURRENT_KNOBIT_IDX++;
      _buildPathView();
      showLmView('lm-path');
    }
  }

  function _showUnitComplete() {
    var titleEl = document.querySelector('.lm-complete-title');
    var s = document.querySelector('.lm-complete-sub');
    if (titleEl) titleEl.textContent = t('msg.unit_complete');
    if (s) s.textContent = _node ? _node.label : '';

    var stat = document.querySelector('.lm-complete-stats');
    if (stat) {
      var cards = stat.querySelectorAll('.lm-complete-stat');
      if (cards[0]) cards[0].innerHTML = '<div class="lm-stat-num">' + KNOBIT_TOTAL + '</div><div class="lm-stat-label">' + t('label.knobits') + '</div>';
    }
    var reflInp = document.getElementById('lm-reflection-input');
    if (reflInp) reflInp.value = '';
    showLmView('lm-complete');
  }

  /* ─── Ask bar ─────────────────────────────────────────────────── */
  window.sendAsk = function () {
    var inp = document.getElementById('kn-ask-input');
    var q   = inp ? inp.value.trim() : '';
    if (!q) return;
    if (inp) inp.value = '';

    _appendBlock({ type: 'user', content: q });
    var capturedQ = q, capturedContext = _streamBlocks.slice(-3).map(function (b) { return b.content || ''; }).join(' '), capturedPhase = _phase;
    _retryFn = function () {
      var live2 = null, fullText2 = '';
      _showLoadingBlock();
      apiInteractStream({ phase: 'ask', action: capturedPhase, question: capturedQ, context: capturedContext }, function (chunk) {
        fullText2 += chunk;
        if (!live2) { _removeLoadingBlock(); live2 = _appendLiveBlock('note'); }
        _updateLiveBlock(live2.el, live2.block, fullText2);
      }).then(function () {
        _retryFn = null;
        if (!live2) { _removeLoadingBlock(); _appendBlock({ type: 'note', content: fullText2 }); }
        if (capturedPhase === 'explain') _setButtonRow('explain-options');
        if (capturedPhase === 'meaning') _setButtonRow('meaning-options');
      }).catch(_onApiError);
    };
    _retryFn();
  };

  /* ─── Block stream ────────────────────────────────────────────── */
  function _appendPhaseDivider(name) {
    var s = document.getElementById('kn-stream');
    if (!s) return;
    var d    = document.createElement('div');
    d.className = 'phase-divider';
    var span = document.createElement('span');
    span.textContent = name;
    d.appendChild(span);
    s.appendChild(d);
    _scrollStream();
  }

  function _appendBlock(block) {
    var s = document.getElementById('kn-stream');
    if (!s) return null;
    _streamBlocks.push(block);

    // "3 / 6" progress — _byteIdx is 0-based and already reflects this
    // specific byte at every call site.
    if (block.type === 'byte') {
      var progress = document.createElement('div');
      progress.className = 'kn-byte-progress';
      progress.textContent = (_byteIdx + 1) + ' / ' + MAX_EXPLAIN_BYTES;
      s.appendChild(progress);
    }

    var el       = document.createElement('div');
    el.className = 'block block-' + block.type;

    if (block.rawHtml) {
      el.innerHTML = block.rawHtml;
    } else if (block.type === 'byte' || block.type === 'note') {
      var safe = (block.content || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]*>/g, '');
      el.innerHTML = _escHtml(safe).replace(/\n/g, '<br>');
    } else {
      el.textContent = block.content || '';
    }

    el.style.opacity   = '0';
    el.style.transform = 'translateY(8px)';
    s.appendChild(el);
    requestAnimationFrame(function () {
      el.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
      el.style.opacity    = '1';
      el.style.transform  = 'translateY(0)';
    });
    _scrollStream();
    return el;
  }

  function _appendVisualLoader(byteText) {
    if (!byteText) return;
    var s = document.getElementById('kn-stream');
    if (!s) return;

    var loaderEl = document.createElement('div');
    loaderEl.className = 'block block-visual block-visual-loading';
    loaderEl.innerHTML = '<span class="loading-dot"></span><span class="loading-dot"></span><span class="loading-dot"></span>';
    s.insertBefore(loaderEl, _streamButtonEl || null);
    _scrollStream();

    apiInteract({ phase: 'explain', action: 'visual', original: byteText, seenUrls: _seenVisualUrls.slice() })
      .then(function (d) {
        if (!loaderEl.parentNode) return;
        var v = d && d.visual;
        if (v && v.url) {
          var html;
          if (v.type === 'image') {
            html = '<img class="lm-visual-img" src="' + _escHtml(v.url) + '" alt="' + _escHtml(v.caption || '') + '" loading="lazy" onerror="this.closest(\'.block-visual\').style.display=\'none\'">' +
                   (v.caption ? '<div class="lm-visual-caption">' + _escHtml(v.caption) + '</div>' : '');
          } else if (v.type === 'video') {
            html = '<a class="lm-visual-video" href="' + _escHtml(v.url) + '" target="_blank" rel="noopener">' +
                   '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6.5" stroke="currentColor" stroke-width="1.1"/><path d="M5.5 4.5l5 2.5-5 2.5V4.5z" fill="currentColor"/></svg>' +
                   _escHtml(v.caption || 'Watch video') + '</a>';
          } else {
            html = null;
          }
          if (html) {
            loaderEl.className = 'block block-visual';
            loaderEl.innerHTML = html;
            _seenVisualUrls.push(v.url);
          } else {
            loaderEl.parentNode.removeChild(loaderEl);
          }
        } else {
          loaderEl.parentNode.removeChild(loaderEl);
        }
        _scrollStream();
      }).catch(function () {
        if (loaderEl.parentNode) loaderEl.parentNode.removeChild(loaderEl);
      });
  }

  function _showLoadingBlock() {
    if (_loading) return;
    _loading = true;
    var s = document.getElementById('kn-stream');
    if (!s) return;
    var d       = document.createElement('div');
    d.id        = 'loading-block';
    d.className = 'block block-loading';
    d.innerHTML = '<span class="loading-dot"></span><span class="loading-dot"></span><span class="loading-dot"></span>';
    s.appendChild(d);
    _scrollStream();
  }

  function _removeLoadingBlock() {
    _loading = false;
    var el = document.getElementById('loading-block');
    if (el) el.remove();
  }

  function _lockButtons() {
    if (!_streamButtonEl) return;
    if (_streamButtonEl.parentNode) _streamButtonEl.parentNode.removeChild(_streamButtonEl);
    _streamButtonEl = null;
  }

  function _getLastContent(types) {
    for (var i = _streamBlocks.length - 1; i >= 0; i--) {
      if (!types || types.indexOf(_streamBlocks[i].type) !== -1) {
        return _streamBlocks[i].content || '';
      }
    }
    return '';
  }

  // Full accumulated content of every block of the given type(s), in order —
  // used when advancing to a new byte so the model sees everything already
  // explained (not just the last byte), and doesn't lose track or repeat itself.
  function _getAllContent(types) {
    var parts = [];
    for (var i = 0; i < _streamBlocks.length; i++) {
      if (!types || types.indexOf(_streamBlocks[i].type) !== -1) {
        parts.push(_streamBlocks[i].content || '');
      }
    }
    return parts.join('\n\n');
  }

  function _scrollStream() {
    var s = document.getElementById('kn-stream');
    if (!s) return;
    if (s.scrollHeight - s.scrollTop - s.clientHeight < 160) {
      s.scrollTop = s.scrollHeight;
    }
  }

  function _escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function _onApiError() {
    _removeLoadingBlock();
    if (_retryFn && _autoRetryCount < _MAX_AUTO_RETRY) {
      _autoRetryCount++;
      _showLoadingBlock();
      var fn = _retryFn;
      setTimeout(fn, 2000);
    } else {
      _autoRetryCount = 0;
      _appendBlock({ type: 'note', rawHtml:
        '<span>' + t('msg.connection_error') + '</span>' +
        (_retryFn ? ' <button class="kn-retry-btn" onclick="window._lmRetry()">' + t('btn.retry') + '</button>' : '')
      });
    }
  }

  window._lmRetry = function () {
    document.querySelectorAll('.kn-retry-btn').forEach(function (b) { b.disabled = true; });
    var fn = _retryFn; _retryFn = null;
    if (fn) fn();
  };

  /* ─── Quit guard ──────────────────────────────────────────────── */
  function _quitGuard(callback) {
    if (!_knobitStarted) { callback(); return; }
    _quitCallback = callback;
    var modal = document.getElementById('quit-knobit-modal');
    if (modal) modal.style.display = 'flex';
  }

  window.tryLeaveKnobit = function () {
    _quitGuard(function () {
      _buildPathView();
      showLmView('lm-path');
    });
  };

  window.tryCloseLearningMode = function () {
    _quitGuard(window.closeLearningMode);
  };

  /* ─── Static event wiring ─────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', function () {
    var askInp = document.getElementById('kn-ask-input');
    if (askInp) askInp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.sendAsk(); }
    });

    var askSend = document.getElementById('kn-ask-send');
    if (askSend) askSend.addEventListener('click', window.sendAsk);

    var startBtn = document.querySelector('.lm-start-btn');
    if (startBtn) startBtn.addEventListener('click', window.startKnobit);

    var mapBtn = document.getElementById('lm-back-to-map-btn');
    if (mapBtn) mapBtn.addEventListener('click', function () {
      var inp  = document.getElementById('lm-reflection-input');
      var text = inp ? inp.value.trim() : '';
      if (text) {
        fetch('/api/profile/reflections', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ text: text }),
        }).catch(function () {});
      }
      window.closeLearningMode();
    });

    var reviewBtn = document.querySelector('.lm-complete-btn-ghost');
    if (reviewBtn) reviewBtn.addEventListener('click', function () { showLmView('lm-path'); });

    var quitConfirm = document.getElementById('quit-modal-confirm');
    if (quitConfirm) quitConfirm.addEventListener('click', function () {
      var modal = document.getElementById('quit-knobit-modal');
      if (modal) modal.style.display = 'none';
      _knobitStarted = false;
      _stopFocusTimer();
      if (_quitCallback) { _quitCallback(); _quitCallback = null; }
    });

    var quitCancel = document.getElementById('quit-modal-cancel');
    if (quitCancel) quitCancel.addEventListener('click', function () {
      var modal = document.getElementById('quit-knobit-modal');
      if (modal) modal.style.display = 'none';
      _quitCallback = null;
    });

    var breakIgnore = document.getElementById('focus-break-ignore');
    if (breakIgnore) breakIgnore.addEventListener('click', function () {
      _startFocusTimer(); // resets and restarts the focus cycle
    });

    window.addEventListener('beforeunload', function (e) {
      if (_knobitStarted) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  });

})();

/* ─── public namespace ──────────────────────────────────────────
   Other modules call window.Learn.*  — never openLearningMode directly */
window.Learn = {
  open:     window.openLearningMode,
  close:    window.closeLearningMode,
  showView: window.showLmView,
};
