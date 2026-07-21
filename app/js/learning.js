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
  // Fallback for knobits generated before target_bytes existed, and an
  // absolute safety ceiling regardless of what the server sends.
  var MAX_EXPLAIN_BYTES = 6;
  var ABSOLUTE_MAX_EXPLAIN_BYTES = 12;
  // Per-knobit target, predicted by the LLM alongside the knobit's title
  // (see generateKnobits in llm.js) — how many bytes THIS knobit genuinely
  // needs, not a one-size-fits-all count. Set in startKnobit/_resumeFromSession.
  var _targetBytes = MAX_EXPLAIN_BYTES;

  var _knobitStarted  = false;
  var _streamButtonEl = null;
  var _quitCallback   = null;
  var _resumeSession  = null;   // { knobitId, blocks: [...] } from server, or null
  var _practiceInputEl = null;  // current practice-answer textarea (each round creates a new one, same id)
  var _activeLiveEl    = null;  // DOM element of the in-flight streaming block, cleared on success, removed on error

  // Tracks consecutive 'simpler' or 'complex' clicks; reset on 'ok'/'no' or new knobit
  var _rephraseRun = { type: null, count: 0 };

  // URLs of visuals already shown in the current knobit — sent to server to avoid duplicates
  var _seenVisualUrls = [];

  // ── Tree mode (L3/L4 entry — Explorer-style table of contents) ──────────────
  var _treeMode              = false;
  var _activeLeafNode        = null;  // the L5 node whose knobit list is currently active, or null
  var _treeActiveContainerEl = null;  // that L5's .lm-tree-children element, refreshed on return

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
  // Calls onChunk(text) for each token, and optionally onStatus(key) for
  // out-of-band progress updates (e.g. while a non-English locale runs its
  // generate-then-edit pass before any real content chunk arrives).
  // Returns a Promise that resolves when done.
  function apiInteractStream(params, onChunk, onStatus) {
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
              else if (obj.status && onStatus) onStatus(obj.status);
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
    _activeLiveEl = el;
    return { el: el, block: block };
  }

  function _updateLiveBlock(el, block, text) {
    // LLM output occasionally leaks a literal "\n" (two chars) instead of a real newline
    text = text.replace(/\\n/g, '\n');
    block.content = text;
    if (!el) return;
    el.innerHTML = _renderTextWithLists(text);
    _scrollStream();
  }

  function apiComplete(knobitId) {
    return fetch('/api/learn/knobit/' + knobitId + '/complete', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.goalCompleted) _showGoalCelebration(data.goalCompleted);
      })
      .catch(function () {});
  }

  function _showGoalCelebration(goal) {
    var overlay = document.getElementById('goal-celebration-overlay');
    if (!overlay) return;
    var label = overlay.querySelector('.goal-cel-label');
    if (label) label.textContent = goal.nodeLabel || '';
    overlay.classList.add('active');
    setTimeout(function () { overlay.classList.remove('active'); }, 4500);
  }

  /* ─── Entry / exit ────────────────────────────────────────────── */
  var _searchWrap = null;

  // Shared overlay chrome — accent colour, search-box hide, Anne hide, fullscreen
  // tip, ambient sound. Used by both flat (L5) and tree (L3/L4) entry points.
  function _openOverlayChrome(node) {
    _searchWrap = document.querySelector('.topbar-search-wrap');
    if (_searchWrap) _searchWrap.style.display = 'none';

    // Accent colours from node — set on #learning-mode so CSS palette default wins before a node is chosen
    var hex   = (node && node.color) ? node.color : '#C4826A';
    var r     = parseInt(hex.slice(1,3), 16);
    var g     = parseInt(hex.slice(3,5), 16);
    var b     = parseInt(hex.slice(5,7), 16);
    var alpha = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--node-alpha').trim()) || 0.13;
    var lm    = document.getElementById('learning-mode');
    lm.style.setProperty('--lm-accent', hex);
    lm.style.setProperty('--lm-accent-soft', 'rgba('+r+','+g+','+b+','+alpha+')');

    var overlay = document.getElementById('learning-mode');
    if (overlay) overlay.classList.add('active');
    if (window.Anne) window.Anne.setVisible(false);

    // Show one-time fullscreen tip
    if (!localStorage.getItem(window.lsKey('lm_fs_tip_shown'))) {
      var tip = document.getElementById('lm-fs-tip');
      if (tip) tip.style.display = '';
    }

    _ambientStart();
  }

  window.openLearningMode = function (node, crumb, knobits, resumeSession) {
    _treeMode          = false;
    _activeLeafNode        = null;
    _treeActiveContainerEl = null;
    _node             = node;
    _crumb            = crumb || '';
    KNOBITS            = Array.isArray(knobits) && knobits.length ? knobits : [];
    KNOBIT_TOTAL       = KNOBITS.length;
    KNOBIT_DONE_COUNT  = KNOBITS.filter(function(k) { return k.done; }).length;
    CURRENT_KNOBIT_IDX = KNOBIT_DONE_COUNT < KNOBIT_TOTAL ? KNOBIT_DONE_COUNT : 0;
    _resumeSession     = resumeSession || null;

    _openOverlayChrome(node);
    _buildPathView();
    showLmView('lm-path');
  };

  // Entry point for L3/L4 nodes — Explorer-style nested table of contents
  // instead of a flat knobit list. See _buildTreeRootView and friends below.
  window.openLearningModeTree = function (node, crumb) {
    _treeMode              = true;
    _activeLeafNode        = null;
    _treeActiveContainerEl = null;
    _node  = node;
    _crumb = crumb || '';
    KNOBITS = [];

    _openOverlayChrome(node);
    _buildTreeRootView();
    showLmView('lm-tree');
  };

  window.closeLearningMode = function () {
    _knobitStarted = false;
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    _ambientStop();
    _stopFocusTimer();
    var overlay = document.getElementById('learning-mode');
    if (overlay) overlay.classList.remove('active');
    if (window.Anne) window.Anne.setVisible(true);
    // Restore search box — always, whether hidden by learning or test mode
    var sw = _searchWrap || document.querySelector('.topbar-search-wrap');
    if (sw) sw.style.display = '';
    _searchWrap = null;
    _node   = null;
    KNOBITS = [];
    _treeMode              = false;
    _activeLeafNode        = null;
    _treeActiveContainerEl = null;
    var pending = window._pendingSuggestNode;
    if (pending) {
      window._pendingSuggestNode = null;
      setTimeout(function () {
        if (window.MapView && window.MapView.navigateToNode) {
          window.MapView.navigateToNode(pending);
        }
      }, 120);
    }
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
    localStorage.setItem(window.lsKey('lm_fs_tip_shown'), '1');
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
    return localStorage.getItem(window.lsKey('lm_ambient_muted')) === '1';
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
    localStorage.setItem(window.lsKey('lm_ambient_muted'), muted ? '0' : '1');
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

  /* ─── Focus timer (evidence-based focus/break cycling) ───────────── */
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
    ['lm-path', 'lm-knobit', 'lm-complete', 'lm-tree'].forEach(function (v) {
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
      listEl.appendChild(_buildKnobitRow(k, i, KNOBIT_DONE_COUNT, CURRENT_KNOBIT_IDX, _resumeSession, window.startKnobit));
    });
  }

  // Builds one knobit row — shared by the flat path view (lm-path) and, nested
  // inside a tree branch, the tree view's expanded L5 knobit lists.
  function _buildKnobitRow(k, i, doneCount, currentIdx, resumeSession, onClickCurrent) {
    var done    = i < doneCount;
    var current = i === currentIdx;
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
      item.addEventListener('click', onClickCurrent);
      if (resumeSession && resumeSession.knobitId === k.id && resumeSession.blocks && resumeSession.blocks.length) {
        var resumeBadge = document.createElement('div');
        resumeBadge.className = 'lm-knobit-resume-badge';
        resumeBadge.textContent = t('label.continue');
        item.appendChild(resumeBadge);
      }
    }
    return item;
  }

  /* ─── View "Tree" — Explorer-style table of contents (L3/L4 entry) ──────
     Dispatches purely on level: an L4 branch's expand fetches child-order
     and recurses; an L5 branch's expand fetches/generates its knobit list.
     Ordering and knobit generation both reuse existing, already-cached
     server endpoints — nothing new is generated here beyond what those
     endpoints already do on first request. ───────────────────────────── */

  function _buildTreeRootView() {
    var crumbEl = document.getElementById('lm-tree-crumb');
    var titleEl = document.getElementById('lm-tree-title');
    if (crumbEl) crumbEl.textContent = _crumb;
    if (titleEl) titleEl.textContent = _node ? _node.label : '';

    var listEl = document.getElementById('lm-tree-list');
    if (!listEl || !_node) return;
    listEl.innerHTML = '';
    _loadAndRenderChildren(_node.id, _node.level + 1, listEl).then(_autoExpandFirst);
  }

  // Walks exactly one path — the first row at each level — open on initial
  // load, so the learner lands on a populated knobit list without clicking.
  // Everything else stays collapsed and unfetched until clicked.
  function _autoExpandFirst(rows) {
    if (!rows || !rows.length) return;
    rows[0].expand().then(function (childRows) {
      if (Array.isArray(childRows)) _autoExpandFirst(childRows);
    });
  }

  // Fetches and renders one level of ordered children into containerEl.
  // Returns a Promise resolving to the created row objects (for further
  // auto-expand cascading), or [] on empty/error.
  function _loadAndRenderChildren(parentExtId, childLevel, containerEl) {
    containerEl.innerHTML = '<div class="lm-tree-loading">' + t('msg.loading') + '</div>';
    return fetch('/api/nodes/' + encodeURIComponent(parentExtId) + '/child-order')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var order = data.order || [];
        containerEl.innerHTML = '';
        if (!order.length) {
          containerEl.innerHTML = '<div class="lm-tree-empty">' + t('msg.no_content_yet') + '</div>';
          return [];
        }
        return order.map(function (child) {
          var rowObj = _buildTreeRow(child, childLevel);
          containerEl.appendChild(rowObj.el);
          return rowObj;
        });
      })
      .catch(function () {
        containerEl.innerHTML = '<div class="lm-tree-empty">' + t('msg.connection_error') + '</div>';
        return [];
      });
  }

  // One expandable row: a branch (level < 5, expands into more rows) or a
  // leaf (level === 5, expands into its knobit list). expand() is idempotent
  // and returns a Promise so callers can chain/cascade off it.
  function _buildTreeRow(node, level) {
    var branch = document.createElement('div');
    branch.className = 'lm-tree-branch';

    var row = document.createElement('div');
    row.className = 'lm-tree-row';
    row.tabIndex  = 0;

    var chevron = document.createElement('span');
    chevron.className = 'lm-tree-chevron';
    row.appendChild(chevron);

    // Empty placeholder — a completion checkmark/icon can be dropped in here later
    // once per-node progress rollup exists; intentionally inert for now.
    var status = document.createElement('span');
    status.className = 'lm-tree-status';
    row.appendChild(status);

    var labelEl = document.createElement('span');
    labelEl.className = 'lm-tree-label';
    labelEl.textContent = node.label;
    row.appendChild(labelEl);

    var childrenEl = document.createElement('div');
    childrenEl.className = 'lm-tree-children';
    childrenEl.style.display = 'none';

    var expanded = false;
    var loaded   = false;

    function expand() {
      if (expanded) return Promise.resolve();
      expanded = true;
      row.classList.add('expanded');
      childrenEl.style.display = '';
      if (loaded) return Promise.resolve();
      loaded = true;
      if (level === 5) {
        return _loadLeafKnobits(node, childrenEl).then(function () { return null; });
      }
      return _loadAndRenderChildren(node.id, level + 1, childrenEl);
    }
    function collapse() {
      expanded = false;
      row.classList.remove('expanded');
      childrenEl.style.display = 'none';
    }

    row.addEventListener('click', function () {
      if (expanded) collapse(); else expand();
    });

    branch.appendChild(row);
    branch.appendChild(childrenEl);
    return { el: branch, expand: expand, node: node, level: level };
  }

  // Fetches (generating on first request, same as the flat L5 flow) the
  // knobit list + resume session for one L5 leaf, then renders it inline.
  function _loadLeafKnobits(node, containerEl) {
    containerEl.innerHTML = '<div class="lm-tree-loading">' + t('msg.loading') + '</div>';
    return fetch('/api/nodes/' + encodeURIComponent(node.id) + '/learn', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var knobits       = Array.isArray(data.knobits) ? data.knobits : [];
        var resumeSession = data.resumeSession || null;
        _renderLeafKnobitList(node, knobits, resumeSession, containerEl);
      })
      .catch(function () {
        containerEl.innerHTML = '<div class="lm-tree-empty">' + t('msg.connection_error') + '</div>';
      });
  }

  function _renderLeafKnobitList(node, knobits, resumeSession, containerEl) {
    containerEl.innerHTML = '';
    if (!knobits.length) {
      containerEl.innerHTML = '<div class="lm-tree-empty">' + t('msg.no_content_yet') + '</div>';
      return;
    }
    var doneCount  = knobits.filter(function (k) { return k.done; }).length;
    var currentIdx = doneCount < knobits.length ? doneCount : 0;

    var wrap = document.createElement('div');
    wrap.className = 'lm-tree-knobits';

    // Same "already started" signal the L5 sidebar button already uses to relabel
    // itself — here it surfaces as a standalone pill above that leaf's knobit rows.
    if (doneCount > 0 && doneCount < knobits.length) {
      var pill = document.createElement('button');
      pill.className   = 'lm-tree-jatka-btn';
      pill.textContent = t('label.continue') + ' (' + doneCount + '/' + knobits.length + ')';
      pill.addEventListener('click', function () {
        _startLeafKnobit(node, knobits, resumeSession, currentIdx, containerEl);
      });
      wrap.appendChild(pill);
    }

    knobits.forEach(function (k, i) {
      wrap.appendChild(_buildKnobitRow(k, i, doneCount, currentIdx, resumeSession, function () {
        _startLeafKnobit(node, knobits, resumeSession, i, containerEl);
      }));
    });

    containerEl.appendChild(wrap);
  }

  function _startLeafKnobit(node, knobits, resumeSession, idx, containerEl) {
    _activeLeafNode        = node;
    _treeActiveContainerEl = containerEl;
    KNOBITS            = knobits;
    KNOBIT_TOTAL       = knobits.length;
    KNOBIT_DONE_COUNT  = knobits.filter(function (k) { return k.done; }).length;
    CURRENT_KNOBIT_IDX = idx;
    _resumeSession = (resumeSession && resumeSession.knobitId === knobits[idx].id) ? resumeSession : null;
    window.startKnobit();
  }

  // Back from an active knobit (leave or complete) while in tree mode — re-fetch
  // that leaf's fresh progress (cheap: knobits already exist, no LLM call) and
  // re-render its rows in place, rather than rebuilding the whole tree.
  function _returnToTree() {
    showLmView('lm-tree');
    var node = _activeLeafNode, containerEl = _treeActiveContainerEl;
    _activeLeafNode        = null;
    _treeActiveContainerEl = null;
    if (node && containerEl) _loadLeafKnobits(node, containerEl);
  }

  /* ─── View 2 — Knobit lesson ──────────────────────────────────── */
  window.startKnobit = function () {
    if (!KNOBITS.length || _starting) return;
    _starting = true;
    _knobitStarted  = true;
    _streamButtonEl = null;
    var k = KNOBITS[CURRENT_KNOBIT_IDX];
    _targetBytes = (Number.isInteger(k.target_bytes) && k.target_bytes > 0)
      ? Math.min(ABSOLUTE_MAX_EXPLAIN_BYTES, k.target_bytes)
      : MAX_EXPLAIN_BYTES;

    var stream = document.getElementById('kn-stream');
    if (stream) stream.innerHTML = '';
    var navLabel = document.getElementById('lm-knobit-nav-label');
    if (navLabel) navLabel.textContent = k.title || '';

    showLmView('lm-knobit');
    _continueOrStartFocusTimer();

    if (_resumeSession && _resumeSession.knobitId === k.id && _resumeSession.blocks && _resumeSession.blocks.length) {
      _resumeFromSession(_resumeSession);
      _starting = false;
      return;
    }

    _streamBlocks   = [];
    _priorChoices   = [];
    _byteIdx        = 0;
    _demoIdx        = 0;
    _practiceIdx    = 0;
    _pendingPractice  = null;
    _rephraseRun      = { type: null, count: 0 };
    _seenVisualUrls   = [];
    _practiceInputEl  = null;
    _lastDemoBody     = '';

    _setPhase('explain');
    _setButtonRow('');
    _appendPhaseDivider(t('phase.step_1'));
    _fetchInitialExplain();
  };

  // Reconstruct the DOM from stored knobit_interactions rows — no LLM calls.
  function _resumeFromSession(session) {
    _streamBlocks   = [];
    _priorChoices   = [];
    _byteIdx        = 0;
    _demoIdx        = 0;
    _practiceIdx    = 0;
    _pendingPractice  = null;
    _rephraseRun      = { type: null, count: 0 };
    _seenVisualUrls   = [];
    _practiceInputEl  = null;
    _lastDemoBody     = '';

    var lastPhase = null;
    var lastBlockType = null;
    var blocks = session.blocks;

    blocks.forEach(function (row) {
      if (row.phase !== lastPhase) {
        _appendPhaseDivider(t('phase.step_' + (_PHASES.indexOf(row.phase) + 1)));
        _setPhase(row.phase);
        lastPhase = row.phase;
      }

      if (row.block_type === 'byte') {
        _byteIdx = row.block_index;
        _appendBlock({ type: 'byte', content: row.content });
      } else if (row.block_type === 'visual') {
        var v = JSON.parse(row.content || '{}');
        var vHtml = '';
        if (v.type === 'image' && v.url) {
          vHtml = '<img class="lm-visual-img" src="' + _escHtml(v.url) + '" alt="' + _escHtml(v.caption || '') + '" loading="lazy" onerror="this.closest(\'.block-visual\').style.display=\'none\'">' +
                  (v.caption ? '<div class="lm-visual-caption">' + _escHtml(v.caption) + '</div>' : '');
        } else if (v.type === 'video' && v.url) {
          vHtml = '<a class="lm-visual-video" href="' + _escHtml(v.url) + '" target="_blank" rel="noopener">' +
                  '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6.5" stroke="currentColor" stroke-width="1.1"/><path d="M5.5 4.5l5 2.5-5 2.5V4.5z" fill="currentColor"/></svg>' +
                  _escHtml(v.caption || t('label.watch_video')) + '</a>';
        }
        if (vHtml) { _appendBlock({ type: 'visual', rawHtml: vHtml }); _seenVisualUrls.push(v.url); }
      } else if (row.block_type === 'example') {
        var ex = JSON.parse(row.content || '{}');
        var html = '<strong>' + _escHtml(t('label.example')) + ' ' + (row.block_index + 1) + '</strong><br>' +
                   _escHtml(ex.body || '') +
                   (ex.whatIDid ? '<br><em class="lm-demo-what-i-did">' + _escHtml(t('label.what_i_did')) + ' ' + _escHtml(ex.whatIDid) + '</em>' : '');
        _appendBlock({ type: 'example', rawHtml: html });
        _demoIdx = row.block_index;
        _lastDemoBody = ex.body || '';
      } else if (row.block_type === 'practice') {
        var prob = JSON.parse(row.content || '{}');
        _pendingPractice = prob;
        _practiceIdx = row.block_index;
        var wrapper = _appendBlock({ type: 'practice', content: t('label.problem') + ' ' + (row.block_index + 1) + ': ' + (prob.question || '') });
        if (wrapper) {
          var inp         = document.createElement('textarea');
          inp.id          = 'kn-practice-input';
          inp.className   = 'kn-answer-input';
          inp.placeholder = t('placeholder.your_answer');
          inp.rows        = 2;
          wrapper.appendChild(inp);
          _practiceInputEl = inp;
        }
      } else if (row.block_type === 'feedback') {
        var grade = JSON.parse(row.content || '{}');
        _appendBlock({ type: 'feedback', content: (grade.correct ? '✓ ' : '✗ ') + (grade.feedback || '') });
        if (_practiceInputEl) { _practiceInputEl.value = row.answer_text || ''; _practiceInputEl.disabled = true; }
      } else if (row.block_type === 'meaning') {
        _appendBlock({ type: 'meaning', content: row.content });
      } else if (row.block_type === 'user' || row.block_type === 'note') {
        _appendBlock({ type: row.block_type, content: row.content });
      }

      // A visual is a decorative addition to the current byte, and an ask-bar
      // question/answer is a side conversation — neither is a phase
      // advancement, so don't let them override which button row to restore.
      if (row.block_type !== 'visual' && row.block_type !== 'user' && row.block_type !== 'note') lastBlockType = row.block_type;
    });

    if (lastBlockType === 'byte') {
      _setButtonRow('explain-options');
    } else if (lastBlockType === 'example') {
      _setButtonRow(_demoIdx === 0 ? 'demo-1' : _demoIdx === 1 ? 'demo-2' : 'demo-3');
    } else if (lastBlockType === 'practice') {
      _setButtonRow('practice-submit');
    } else if (lastBlockType === 'feedback') {
      _setButtonRow('practice-next');
    } else if (lastBlockType === 'meaning') {
      _setButtonRow('meaning-options');
    }

    _knobitStarted = true;
    _resumeSession = null;
  }

  function _fetchInitialExplain() {
    _retryFn = _fetchInitialExplain;
    _showLoadingBlock();
    var live = null, fullText = '';
    apiInteractStream({ phase: 'explain', byteIndex: 0, priorChoices: [] }, function (chunk) {
      fullText += chunk;
      if (!live) { _removeLoadingBlock(); live = _appendLiveBlock('byte'); }
      _updateLiveBlock(live.el, live.block, fullText);
    }, _setLoadingStatus).then(function () {
      _starting = false; _retryFn = null; _activeLiveEl = null;
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

    if (opt === 'simpler' || opt === 'complex') {
      if (opt === _rephraseRun.type) { _rephraseRun.count++; } else { _rephraseRun = { type: opt, count: 1 }; }
      if (_rephraseRun.count > 3) { _showRephraseLimit(opt, 'explain'); return; }
    } else {
      _rephraseRun = { type: null, count: 0 };
    }

    if (opt === 'ok') {
      _byteIdx++;
      if (_byteIdx >= _targetBytes) {
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
      }, _setLoadingStatus).then(function () {
        _retryFn = null; _activeLiveEl = null;
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
        var html = '<strong>' + _escHtml(t('label.example')) + ' ' + (_demoIdx + 1) + '</strong><br>' +
                   _escHtml(ex.body || '') +
                   (ex.whatIDid ? '<br><em class="lm-demo-what-i-did">' + _escHtml(t('label.what_i_did')) + ' ' + _escHtml(ex.whatIDid) + '</em>' : '');
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
      _appendBlock({ type: 'note', content: t('msg.try_youtube') + ' "' + ((_activeLeafNode || _node) ? (_activeLeafNode || _node).label : '') + ' ' + t('msg.explained') + '"' });
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

        var wrapper = _appendBlock({ type: 'practice', content: t('label.problem') + ' ' + (_practiceIdx + 1) + ': ' + (prob.question || '') });
        if (wrapper) {
          var inp         = document.createElement('textarea');
          inp.id          = 'kn-practice-input';
          inp.className   = 'kn-answer-input';
          inp.placeholder = t('placeholder.your_answer');
          inp.rows        = 2;
          wrapper.appendChild(inp);
          _practiceInputEl = inp;
        }
        _retryFn = null;
        _setButtonRow('practice-submit');
      }).catch(_onApiError);
  }

  window.practiceSubmit = function () {
    var inp = _practiceInputEl;
    var ans = inp ? inp.value.trim() : '';
    if (!ans) return;
    if (inp) inp.disabled = true;
    _lockButtons();
    _setButtonRow('');

    var prob = _pendingPractice || {};
    var capturedAns = ans, capturedProb = prob;
    _retryFn = function () {
      _showLoadingBlock();
      apiInteract({ phase: 'practice', action: 'grade', byteIndex: _practiceIdx, question: capturedProb.question || '', expected: capturedProb.expected || '', userAnswer: capturedAns })
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
    }, _setLoadingStatus).then(function () {
      _retryFn = null; _activeLiveEl = null;
      if (!live) { _removeLoadingBlock(); _appendBlock({ type: 'meaning', content: fullText }); }
      _setButtonRow('meaning-options');
    }).catch(_onApiError);
  }

  window.meaningOpt = function (opt) {
    if (opt === 'ok') {
      _lockButtons();
      _setButtonRow('');
      _rephraseRun = { type: null, count: 0 };
      _showDownloadOffer();
      return;
    }
    _lockButtons();

    if (opt === 'simpler' || opt === 'complex') {
      if (opt === _rephraseRun.type) { _rephraseRun.count++; } else { _rephraseRun = { type: opt, count: 1 }; }
      if (_rephraseRun.count > 3) { _showRephraseLimit(opt, 'meaning'); return; }
    } else {
      _rephraseRun = { type: null, count: 0 };
    }

    var capturedOpt = opt, capturedContent = _getLastContent(['meaning']);
    _retryFn = function () {
      var live2 = null, fullText2 = '';
      _showLoadingBlock();
      apiInteractStream({ phase: 'meaning', action: capturedOpt, original: capturedContent }, function (chunk) {
        fullText2 += chunk;
        if (!live2) { _removeLoadingBlock(); live2 = _appendLiveBlock('meaning'); }
        _updateLiveBlock(live2.el, live2.block, fullText2);
      }, _setLoadingStatus).then(function () {
        _retryFn = null; _activeLiveEl = null;
        if (!live2) { _removeLoadingBlock(); _appendBlock({ type: 'meaning', content: fullText2 }); }
        _setButtonRow('meaning-options');
      }).catch(_onApiError);
    };
    _retryFn();
  };

  /* ─── Download offer (shown once, right after meaning is confirmed,
         before the knobit is marked complete and its interaction data
         is cleared server-side). The .docx itself is built server-side
         from knobit_interactions — see server/services/knobitDocx.js —
         since that's the same canonical data source the resume feature
         uses, and it must be read before /complete deletes it. ──────── */
  function _showDownloadOffer() {
    var modal = document.getElementById('knobit-download-modal');
    if (modal) modal.style.display = 'flex';
  }

  window._downloadKnobitTranscript = function () {
    var btn = document.getElementById('knobit-download-btn');
    var k = KNOBITS[CURRENT_KNOBIT_IDX];
    if (!k) return;
    if (btn) btn.disabled = true;

    fetch('/api/learn/knobit/' + k.id + '/download')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var disposition = r.headers.get('Content-Disposition') || '';
        var match = disposition.match(/filename\*=UTF-8''([^;]+)/);
        var filename = match ? decodeURIComponent(match[1]) : 'knobit.docx';
        return r.blob().then(function (blob) { return { blob: blob, filename: filename }; });
      })
      .then(function (result) {
        var url = URL.createObjectURL(result.blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = result.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      })
      .catch(function () {
        // Non-critical — the learner can still continue without a download.
      })
      .finally(function () {
        if (btn) btn.disabled = false;
      });
  };

  /* ─── Knobit completion ───────────────────────────────────────── */
  function _completeKnobit() {
    _knobitStarted = false;
    // Deliberately NOT stopping the focus timer here — the learner is very
    // likely about to start another knobit, and the countdown should keep
    // running across that boundary (see _continueOrStartFocusTimer). It
    // still gets stopped properly on a real exit via closeLearningMode().
    var k = KNOBITS[CURRENT_KNOBIT_IDX];
    KNOBIT_DONE_COUNT++;
    apiComplete(k.id);

    if (_treeMode) {
      // Finishing one L5's knobits doesn't mean the whole tree is done — other
      // branches may still be untouched — so just return to the tree instead
      // of the flat "unit complete" screen.
      _returnToTree();
      return;
    }

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
        _retryFn = null; _activeLiveEl = null;
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

    // "3 / 8" progress — _byteIdx is 0-based and already reflects this
    // specific byte at every call site (live generation, non-stream
    // fallback, and session-resume replay all update it before appending).
    if (block.type === 'byte') {
      var progress = document.createElement('div');
      progress.className = 'kn-byte-progress';
      progress.textContent = (_byteIdx + 1) + ' / ' + _targetBytes;
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
        .replace(/<[^>]*>/g, '')
        .replace(/\\n/g, '\n'); // LLM output occasionally leaks a literal "\n" (two chars) instead of a real newline
      el.innerHTML = _renderTextWithLists(safe);
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
    loaderEl.innerHTML = '<span class="visual-loading-icon">⏳</span><span>' + t('lm.finding_visual') + '</span>';
    s.insertBefore(loaderEl, _streamButtonEl || null);
    _scrollStream();

    apiInteract({ phase: 'explain', action: 'visual', original: byteText, seenUrls: _seenVisualUrls.slice() })
      .then(function (d) {
        if (!loaderEl.parentNode) return;
        var v = d && d.visual;
        if (v && v.url) {
          _seenVisualUrls.push(v.url);
          var html;
          if (v.type === 'image') {
            html = '<img class="lm-visual-img" src="' + _escHtml(v.url) + '" alt="' + _escHtml(v.caption || '') + '" loading="lazy" onerror="this.closest(\'.block-visual\').style.display=\'none\'">' +
                   (v.caption ? '<div class="lm-visual-caption">' + _escHtml(v.caption) + '</div>' : '');
          } else if (v.type === 'video') {
            html = '<a class="lm-visual-video" href="' + _escHtml(v.url) + '" target="_blank" rel="noopener">' +
                   '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6.5" stroke="currentColor" stroke-width="1.1"/><path d="M5.5 4.5l5 2.5-5 2.5V4.5z" fill="currentColor"/></svg>' +
                   _escHtml(v.caption || t('label.watch_video')) + '</a>';
            if (html) {
              loaderEl.className = 'block block-visual';
              loaderEl.innerHTML = html;
              _appendVideoReflection();
              _scrollStream();
              return;
            }
          } else {
            html = null;
          }
          if (html) {
            loaderEl.className = 'block block-visual';
            loaderEl.innerHTML = html;
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

  function _showRephraseLimit(direction, phase) {
    var isComplex = (direction === 'complex');
    _appendBlock({ type: 'note', content: t(isComplex ? 'lm.limit_reached_complex' : 'lm.limit_reached_simple') });

    var dir = isComplex ? 'easier' : 'harder';
    var activeNode = _activeLeafNode || _node;
    var nodeId = activeNode && activeNode.id;
    if (!nodeId) { _appendSuggestionCard(null, direction, phase); return; }

    fetch('/api/nodes/' + encodeURIComponent(nodeId) + '/suggest?direction=' + dir)
      .then(function (r) { return r.json(); })
      .then(function (d) { _appendSuggestionCard(d && d.suggestion, direction, phase); })
      .catch(function ()  { _appendSuggestionCard(null, direction, phase); });
  }

  function _appendSuggestionCard(suggestion, direction, phase) {
    var isComplex = (direction === 'complex');
    var s = document.getElementById('kn-stream');
    if (!s) return;

    var el = document.createElement('div');
    el.className = 'block block-suggestion-card';

    if (suggestion) {
      var lbl = document.createElement('div');
      lbl.className   = 'suggestion-label';
      lbl.textContent = t(isComplex ? 'lm.suggest_try_first' : 'lm.suggest_try_next');

      var card = document.createElement('div');
      card.className = 'suggestion-node-card';

      var nodeLabel = document.createElement('div');
      nodeLabel.className   = 'suggestion-node-label';
      nodeLabel.textContent = suggestion.label;

      var crumb = document.createElement('div');
      crumb.className   = 'suggestion-node-crumb';
      crumb.textContent = suggestion.breadcrumb;

      var goBtn = document.createElement('button');
      goBtn.className   = 'kn-option-btn btn-understand suggestion-go-btn';
      goBtn.textContent = t('btn.go_to_topic');
      goBtn.addEventListener('click', function () {
        window._pendingSuggestNode = suggestion.id;
        window.closeLearningMode();
      });

      card.appendChild(nodeLabel);
      card.appendChild(crumb);
      card.appendChild(goBtn);
      el.appendChild(lbl);
      el.appendChild(card);
    } else {
      var noSug = document.createElement('div');
      noSug.className   = 'suggestion-label';
      noSug.textContent = t(isComplex ? 'lm.no_suggestion_complex' : 'lm.no_suggestion_simple');
      el.appendChild(noSug);
    }

    var continueBtn = document.createElement('button');
    continueBtn.className   = 'kn-option-btn btn-other suggestion-continue-btn';
    continueBtn.textContent = t('btn.continue_to_examples');
    continueBtn.addEventListener('click', function () {
      el.remove();
      if (phase === 'meaning') { _completeKnobit(); } else { _enterDemonstrate(); }
    });
    el.appendChild(continueBtn);

    s.appendChild(el);
    _scrollStream();
  }

  function _appendVideoReflection() {
    var s = document.getElementById('kn-stream');
    if (!s) return;

    var el = document.createElement('div');
    el.className = 'block block-video-reflection';

    var label    = document.createElement('div');
    label.className = 'video-reflection-label';
    label.textContent = t('lm.video_reflection_prompt');

    var textarea    = document.createElement('textarea');
    textarea.className   = 'kn-answer-input video-reflection-input';
    textarea.placeholder = t('placeholder.reflection');
    textarea.rows        = 2;

    var saveBtn = document.createElement('button');
    saveBtn.className   = 'kn-option-btn btn-understand video-reflection-save';
    saveBtn.textContent = t('btn.save');

    saveBtn.addEventListener('click', function () {
      var text = textarea.value.trim();
      if (!text) return;
      fetch('/api/profile/reflections', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text: text }),
      }).catch(function () {});
      saveBtn.textContent = t('msg.saved');
      saveBtn.disabled    = true;
      textarea.disabled   = true;
    });

    el.appendChild(label);
    el.appendChild(textarea);
    el.appendChild(saveBtn);
    s.insertBefore(el, _streamButtonEl || null);
    _scrollStream();
  }

  function _showLoadingBlock() {
    if (_loading) return;
    _loading = true;
    var s = document.getElementById('kn-stream');
    if (!s) return;
    var d       = document.createElement('div');
    d.id        = 'loading-block';
    d.className = 'block block-loading';
    d.innerHTML = '<span class="loading-dot"></span><span class="loading-dot"></span><span class="loading-dot"></span>' +
                  '<span class="loading-status"></span>';
    s.appendChild(d);
    _scrollStream();
  }

  // Updates the text next to the loading dots (e.g. while a non-English second
  // pass runs before any real content chunk arrives). No-op if the loading
  // block isn't showing — a status frame arriving after content has already
  // started should never resurrect it.
  function _setLoadingStatus(key) {
    var el = document.getElementById('loading-block');
    if (!el) return;
    var span = el.querySelector('.loading-status');
    if (span) span.textContent = t('status.' + key);
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

  // _streamBlocks is reset at the start of every knobit (startKnobit /
  // _resumeFromSession), so this is always scoped to the current knobit only.
  function _getAllContent(types) {
    return _streamBlocks
      .filter(function (b) { return !types || types.indexOf(b.type) !== -1; })
      .map(function (b) { return b.content || ''; })
      .join('\n\n');
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

  // The LLM is told not to use markdown, but occasionally slips in **bold** anyway —
  // render it properly instead of showing literal asterisks. Safe to run post-escape
  // since escaping never introduces new "**" sequences.
  function _mdBold(escapedText) {
    return escapedText.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }

  // Renders byte/note text, turning "- item" / "1. item" lines into a real <ul>/<ol>
  // (the LLM is allowed to use lists for genuine enumeration — see llm.js prompts).
  // Everything else stays flowing prose with <br> between lines, same as before.
  function _renderTextWithLists(text) {
    var lines = String(text || '').split('\n');
    var html = '';
    var listType = null; // 'ul' | 'ol' | null
    function closeList() {
      if (listType) { html += '</' + listType + '>'; listType = null; }
    }
    lines.forEach(function (line) {
      var bulletMatch = line.match(/^-\s+(.*)/);
      var numberMatch = line.match(/^\d+\.\s+(.*)/);
      if (bulletMatch) {
        if (listType !== 'ul') { closeList(); html += '<ul class="kn-byte-list">'; listType = 'ul'; }
        html += '<li>' + _mdBold(_escHtml(bulletMatch[1])) + '</li>';
      } else if (numberMatch) {
        if (listType !== 'ol') { closeList(); html += '<ol class="kn-byte-list">'; listType = 'ol'; }
        html += '<li>' + _mdBold(_escHtml(numberMatch[1])) + '</li>';
      } else {
        closeList();
        if (line.trim() === '') return;
        html += _mdBold(_escHtml(line)) + '<br>';
      }
    });
    closeList();
    return html;
  }

  function _onApiError() {
    _removeLoadingBlock();
    // A stream that broke mid-response leaves a half-written block behind — discard it
    // so a retry doesn't leave the incomplete fragment sitting above the fresh one.
    if (_activeLiveEl) {
      if (_activeLiveEl.parentNode) _activeLiveEl.parentNode.removeChild(_activeLiveEl);
      if (_streamBlocks.length && _streamBlocks[_streamBlocks.length - 1]) _streamBlocks.pop();
      _activeLiveEl = null;
    }
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
      if (_treeMode) {
        _returnToTree();
      } else {
        _buildPathView();
        showLmView('lm-path');
      }
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

    var quitConfirm = document.getElementById('quit-modal-confirm');
    if (quitConfirm) quitConfirm.addEventListener('click', function () {
      var modal = document.getElementById('quit-knobit-modal');
      if (modal) modal.style.display = 'none';
      _knobitStarted = false;
      _stopFocusTimer();
      if (_quitCallback) { _quitCallback(); _quitCallback = null; }
    });

    var breakIgnore = document.getElementById('focus-break-ignore');
    if (breakIgnore) breakIgnore.addEventListener('click', function () {
      _startFocusTimer(); // resets and restarts the focus cycle
    });

    var quitCancel = document.getElementById('quit-modal-cancel');
    if (quitCancel) quitCancel.addEventListener('click', function () {
      var modal = document.getElementById('quit-knobit-modal');
      if (modal) modal.style.display = 'none';
      _quitCallback = null;
    });

    var downloadBtn = document.getElementById('knobit-download-btn');
    if (downloadBtn) downloadBtn.addEventListener('click', function () {
      window._downloadKnobitTranscript();
    });

    var downloadContinue = document.getElementById('knobit-download-continue');
    if (downloadContinue) downloadContinue.addEventListener('click', function () {
      var modal = document.getElementById('knobit-download-modal');
      if (modal) modal.style.display = 'none';
      _completeKnobit();
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
  openTree: window.openLearningModeTree,
  close:    window.closeLearningMode,
  showView: window.showLmView,
};
