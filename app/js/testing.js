/* ═══════════════════════════════════════════════════════════════
   TESTING MODE  —  testing.js
   ───────────────────────────────────────────────────────────────
   Owns  : #testing-mode overlay, tm-path / tm-knobit / tm-complete
           views, 4-tier diagnostic flow (Q1 Factual → Q4 Analytical)
   Exposes: window.Test.open(node, crumb)
            window.Test.close()
            window.Test.showView(id)
   Calls  : /api/test/question, /api/test/evaluate
   Never  : touch app.js map rendering or #learning-mode
   ═══════════════════════════════════════════════════════════════ */

(function () {

  /* ─── State ──────────────────────────────────────────────────── */
  var _node             = null;
  var _crumb            = '';
  var _questionNum      = 0;
  var _history          = [];
  var _currentQuestion  = null;
  var _loading          = false;
  var _questionFetching = false;
  var _autoRetryCount   = 0;
  var _MAX_AUTO_RETRY   = 3;
  var _awaitingAnswer   = false;
  var _streamBlocks     = [];
  var _testComplete     = false;
  var _testQuitCallback = null;

  var _PHASES = ['q1', 'q2', 'q3', 'q4'];

  function _tierName(num) {
    var keys = ['', 'label.factual', 'label.conceptual', 'label.procedural', 'label.analytical'];
    return keys[num] ? t(keys[num]) : '';
  }

  /* ─── API helpers ─────────────────────────────────────────────── */
  // Carries the HTTP status onto the rejected Error so callers can special-case
  // 429 (per-user LLM rate limit — see server/middleware/llmRateLimit.js) with
  // a distinct, non-auto-retrying message instead of the generic connection-error path.
  function _httpError(r) {
    var e = new Error('HTTP ' + r.status);
    e.status = r.status;
    return e;
  }

  // Streams raw JSON tokens, accumulates, parses on [DONE].
  function _apiStream(url, body, onStatus) {
    return fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(Object.assign({}, body, { stream: true })),
    }).then(function (r) {
      if (!r.ok) throw _httpError(r);
      if (!r.body) throw new Error('No stream');
      var reader  = r.body.getReader();
      var decoder = new TextDecoder();
      var buf = '', fullText = '';
      function pump() {
        return reader.read().then(function (result) {
          if (result.done) return JSON.parse(fullText);
          buf += decoder.decode(result.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line.startsWith('data: ')) continue;
            var data = line.slice(6);
            if (data === '[DONE]') {
              var s = fullText.trim()
                .replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
              return JSON.parse(s);
            }
            try {
              var obj = JSON.parse(data);
              if (obj.error) throw new Error('stream-error');
              if (obj.t) fullText += obj.t;
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

  function apiQuestion(questionNum, history) {
    return fetch('/api/test/question', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ nodeId: _node.id, questionNum: questionNum, history: history }),
    }).then(function (r) {
      if (!r.ok) throw _httpError(r);
      return r.json();
    });
  }

  function apiEvaluate(questionNum, question, options, userAnswer, history, correctIndex) {
    return _apiStream('/api/test/evaluate', {
      nodeId:       _node.id,
      questionNum:  questionNum,
      question:     question,
      options:      options || null,
      userAnswer:   userAnswer,
      history:      history,
      correctIndex: typeof correctIndex === 'number' ? correctIndex : undefined,
    }, _setLoadingStatus);
  }

  /* ─── Entry / exit ────────────────────────────────────────────── */
  var _searchWrap = null;

  window.openTestingMode = function (node, crumb) {
    _searchWrap = document.querySelector('.topbar-search-wrap');
    if (_searchWrap) _searchWrap.style.display = 'none';
    // Localise Q-chip labels: K1–K4 in Estonian, Q1–Q4 elsewhere.
    var qPrefix = window._uiLocale === 'et' ? 'K' : 'Q';
    [1, 2, 3, 4].forEach(function (n) {
      var chip = document.getElementById('tm-chip-q' + n);
      if (chip) chip.textContent = qPrefix + n;
    });
    _node  = node;
    _crumb = crumb || '';

    var hex   = (node && node.color) ? node.color : '#C4826A';
    var r     = parseInt(hex.slice(1, 3), 16);
    var g     = parseInt(hex.slice(3, 5), 16);
    var b     = parseInt(hex.slice(5, 7), 16);
    var alpha = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--node-alpha').trim()) || 0.13;
    var tm    = document.getElementById('testing-mode');
    tm.style.setProperty('--lm-accent', hex);
    tm.style.setProperty('--lm-accent-soft', 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')');

    _buildPathView();
    showTmView('tm-path');
    var overlay = document.getElementById('testing-mode');
    if (overlay) overlay.classList.add('active');
    // Anne stays visible in testing mode — only the product tour hides her now.
  };

  window.closeTestingMode = function () {
    var overlay = document.getElementById('testing-mode');
    if (overlay) overlay.classList.remove('active');
    if (window.Anne) window.Anne.setVisible(true);
    var sw = _searchWrap || document.querySelector('.topbar-search-wrap');
    if (sw) sw.style.display = '';
    _searchWrap       = null;
    _node             = null;
    _history          = [];
    _questionNum      = 0;
    _awaitingAnswer   = false;
    _questionFetching = false;
    _testComplete     = false;
    _testQuitCallback = null;
    // Refresh sidebar so tested score hides the "I know this" toggle
    if (window.MapView && window.MapView.refreshCurrentNodeKnowledge) {
      window.MapView.refreshCurrentNodeKnowledge();
    }
  };

  function _tryQuitTest(callback) {
    if (_questionNum === 0 || _testComplete) {
      callback();
      return;
    }
    _testQuitCallback = callback;
    var modal = document.getElementById('quit-test-modal');
    if (modal) modal.style.display = 'flex';
  }

  window.tryCloseTestingMode = function () {
    _tryQuitTest(window.closeTestingMode);
  };

  window.tryLeaveTestQuestion = function () {
    _tryQuitTest(function () { showTmView('tm-path'); });
  };

  /* ─── View switching ──────────────────────────────────────────── */
  window.showTmView = function (id) {
    ['tm-path', 'tm-knobit', 'tm-complete'].forEach(function (v) {
      var el = document.getElementById(v);
      if (el) el.classList.toggle('active', v === id);
    });
  };

  /* ─── View 1 — Intro / path ───────────────────────────────────── */
  function _buildPathView() {
    var crumbEl = document.getElementById('tm-path-crumb');
    var titleEl = document.getElementById('tm-path-title');
    var fillEl  = document.getElementById('tm-progress-fill');
    var labelEl = document.getElementById('tm-progress-label');
    var listEl  = document.getElementById('tm-knobit-list');

    if (crumbEl) crumbEl.textContent = _crumb;
    if (titleEl) titleEl.textContent = _node ? _node.label : '';
    if (fillEl)  fillEl.style.width  = '0%';
    if (labelEl) labelEl.textContent = t('msg.test_intro');

    var startLabel = document.getElementById('tm-start-btn-label');
    if (startLabel) startLabel.textContent = t('btn.start_test');

    if (!listEl) return;
    listEl.innerHTML = '';

    var tierDescs = [
      t('label.tier1_desc'),
      t('label.tier2_desc'),
      t('label.tier3_desc'),
      t('label.tier4_desc'),
    ];

    [1, 2, 3, 4].forEach(function (num) {
      var item = document.createElement('div');
      item.className = 'lm-knobit-item tm-path-item';

      var numEl = document.createElement('div');
      numEl.className = 'lm-knobit-num';
      numEl.textContent = String(num);
      item.appendChild(numEl);

      var info = document.createElement('div');
      info.style.flex = '1';

      var name = document.createElement('div');
      name.className = 'lm-knobit-name';
      name.textContent = _tierName(num);
      info.appendChild(name);

      var desc = document.createElement('div');
      desc.style.cssText = 'font-size:12px;color:#9A8E86;margin-top:2px';
      desc.textContent = tierDescs[num - 1];
      info.appendChild(desc);

      item.appendChild(info);
      listEl.appendChild(item);
    });
  }

  /* ─── View 2 — Question flow ──────────────────────────────────── */
  window.startTestKnobit = function () {
    _questionNum      = 0;
    _history          = [];
    _currentQuestion  = null;
    _awaitingAnswer   = false;
    _streamBlocks     = [];
    _loading          = false;
    _questionFetching = false;
    _testComplete     = false;

    var stream = document.getElementById('tn-stream');
    if (stream) stream.innerHTML = '';

    _setChip(null);
    _setAnswerInputState(false);
    showTmView('tm-knobit');

    _advanceQuestion();
  };

  function _advanceQuestion() {
    if (_questionFetching) return;
    _questionFetching = true;
    _questionNum++;
    _updateProgressBar();
    _setChip('q' + _questionNum);

    var navLabel = document.getElementById('tm-knobit-nav-label');
    if (navLabel) navLabel.textContent = _node ? _node.label : '';

    _showLoadingBlock();
    apiQuestion(_questionNum, _history)
      .then(function (q) {
        _questionFetching = false;
        _autoRetryCount = 0;
        _removeLoadingBlock();
        if (q.type === 'mcq' && Array.isArray(q.options) && q.options.length === 4 && typeof q.correctIndex === 'number') {
          var correctOptionText = q.options[q.correctIndex];
          var opts = q.options.slice();
          for (var i = opts.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var tmp = opts[i]; opts[i] = opts[j]; opts[j] = tmp;
          }
          q = { question: q.question, type: q.type, options: opts, correctIndex: opts.indexOf(correctOptionText) };
        }
        _currentQuestion = q;
        _appendQuestionBlock(q);
        _setAnswerInputState(true, q.type === 'mcq');
      }).catch(function (err) {
        _questionFetching = false;
        _questionNum--;
        _removeLoadingBlock();
        if (err && err.status === 429) {
          // Rate-limited — don't auto-retry into the same limit.
          _autoRetryCount = 0;
          _appendBlock({ type: 'note', rawHtml:
            '<span>' + t('msg.slow_down') + '</span> ' +
            '<button class="kn-retry-btn" onclick="window._testRetryQuestion()">' + t('btn.retry') + '</button>'
          });
        } else if (_autoRetryCount < _MAX_AUTO_RETRY) {
          _autoRetryCount++;
          _showLoadingBlock();
          setTimeout(_advanceQuestion, 2000);
        } else {
          _autoRetryCount = 0;
          _appendBlock({ type: 'note', rawHtml:
            '<span>' + t('msg.connection_error') + '</span> ' +
            '<button class="kn-retry-btn" onclick="window._testRetryQuestion()">' + t('btn.retry') + '</button>'
          });
        }
      });
  }

  function _appendQuestionBlock(q) {
    var qPrefix = window._uiLocale === 'et' ? 'K' : 'Q';
    _appendPhaseDivider(qPrefix + _questionNum + ' — ' + _tierName(_questionNum));

    var text = q.question || '';
    if (q.type === 'mcq' && q.options && q.options.length) {
      text += '\n\n' + q.options.map(function (o, i) {
        return String.fromCharCode(65 + i) + '. ' + o;
      }).join('\n');
    }
    _appendBlock({ type: 'byte', content: text });
    _awaitingAnswer = true;
  }

  window._testRetryQuestion = function () {
    document.querySelectorAll('.kn-retry-btn').forEach(function (b) { b.disabled = true; });
    _advanceQuestion();
  };

  window.testSendAsk = function () {
    if (!_awaitingAnswer) return;
    var inp = document.getElementById('tm-ask-input');
    var ans = inp ? inp.value.trim() : '';
    if (!ans) return;
    if (inp) inp.value = '';

    _awaitingAnswer = false;
    _setAnswerInputState(false);
    _appendBlock({ type: 'user', content: ans });
    _showLoadingBlock();

    var q = _currentQuestion || {};
    var capturedQ = q, capturedAns = ans;
    function doEvaluate() {
      apiEvaluate(_questionNum, capturedQ.question || '', capturedQ.options || null, capturedAns, _history,
        capturedQ.type === 'mcq' ? capturedQ.correctIndex : undefined)
        .then(function (result) {
          _autoRetryCount = 0;
          _removeLoadingBlock();

          var _hItem = {
            question: capturedQ.question || '',
            answer:   capturedAns,
            correct:  result.correct || false,
          };
          if (result.partial)                   _hItem.partial = true;
          if (typeof result.score === 'number') _hItem.score   = result.score;
          _history.push(_hItem);

          var icon     = result.correct ? '✓' : (result.partial ? '~' : '✗');
          var subClass = result.correct ? 'feedback-correct' : (result.partial ? 'feedback-partial' : 'feedback-incorrect');
          _appendBlock({ type: 'feedback', content: icon + ' ' + (result.feedback || ''), subClass: subClass });

          if (_questionNum === 4) {
            _updateProgressBar();
            setTimeout(function () { _showFinalScore(result); }, 700);
          } else {
            setTimeout(_advanceQuestion, 1000);
          }
        }).catch(function (err) {
          _removeLoadingBlock();
          if (err && err.status === 429) {
            // Rate-limited — don't auto-retry into the same limit.
            _autoRetryCount = 0;
            _awaitingAnswer = true;
            _setAnswerInputState(true, capturedQ.type === 'mcq');
            _appendBlock({ type: 'note', content: t('msg.slow_down') });
          } else if (_autoRetryCount < _MAX_AUTO_RETRY) {
            _autoRetryCount++;
            _showLoadingBlock();
            setTimeout(doEvaluate, 2000);
          } else {
            _autoRetryCount = 0;
            _awaitingAnswer = true;
            _setAnswerInputState(true, capturedQ.type === 'mcq');
            _appendBlock({ type: 'note', content: t('msg.connection_error') });
          }
        });
    }
    doEvaluate();
  };

  function _showFinalScore(result) {
    var score     = result.finalScore !== undefined ? result.finalScore : '?';
    var breakdown = result.scoreBreakdown || '';

    _appendPhaseDivider(t('label.result'));
    _appendBlock({ type: 'meaning', content: score + '% — ' + breakdown });

    // Pre-populate the complete screen while the user reads the breakdown
    var correctCount = _history.filter(function (h) { return h.correct; }).length;
    var titleEl = document.querySelector('#testing-mode .lm-complete-title');
    var sub     = document.querySelector('#testing-mode .lm-complete-sub');
    if (titleEl) titleEl.textContent = t('msg.diagnostic_complete');
    if (sub)     sub.textContent     = breakdown;
    var stat = document.querySelector('#testing-mode .lm-complete-stats');
    if (stat) {
      var cards = stat.querySelectorAll('.lm-complete-stat');
      if (cards[0]) cards[0].innerHTML = '<div class="lm-cstat-num">4/4</div><div class="lm-cstat-label">' + t('label.questions_answered') + '</div>';
      if (cards[1]) cards[1].innerHTML = '<div class="lm-cstat-num">' + score + '%</div><div class="lm-cstat-label">' + t('label.mastery_score') + '</div>';
      if (cards[2]) cards[2].innerHTML = '<div class="lm-cstat-num">' + correctCount + '/4</div><div class="lm-cstat-label">' + t('label.questions_correct') + '</div>';
    }
    _testComplete = true;
    setTimeout(_appendResultsButton, 600);
  }

  function _appendResultsButton() {
    var s = document.getElementById('tn-stream');
    if (!s) return;
    var wrap = document.createElement('div');
    wrap.className = 'tm-results-btn-wrap';
    wrap.innerHTML = '<button class="tm-results-btn" onclick="window._goToComplete()">' + t('btn.view_results') + '</button>';
    wrap.style.opacity   = '0';
    wrap.style.transform = 'translateY(8px)';
    s.appendChild(wrap);
    requestAnimationFrame(function () {
      wrap.style.transition = 'opacity 0.35s ease, transform 0.35s ease';
      wrap.style.opacity    = '1';
      wrap.style.transform  = 'translateY(0)';
    });
    _scrollStream();
  }

  window._goToComplete = function () {
    showTmView('tm-complete');
  };

  /* ─── Progress bar ────────────────────────────────────────────── */
  function _updateProgressBar() {
    var pct   = Math.round((_questionNum / 4) * 100);
    var barEl = document.getElementById('tn-progress-fill-bar');
    var fillEl = document.getElementById('tm-progress-fill');
    if (barEl)  barEl.style.width  = pct + '%';
    if (fillEl) fillEl.style.width = pct + '%';
  }

  /* ─── Chip management ─────────────────────────────────────────── */
  function _setChip(activePhase) {
    var overlay = document.getElementById('testing-mode');
    if (!overlay) return;
    overlay.querySelectorAll('.kn-chip').forEach(function (chip) {
      var cp = chip.dataset.phase;
      var pi = _PHASES.indexOf(activePhase);
      var ci = _PHASES.indexOf(cp);
      chip.classList.remove('active', 'done-chip');
      if (cp === activePhase) chip.classList.add('active');
      else if (activePhase && ci >= 0 && ci < pi) chip.classList.add('done-chip');
    });
  }

  /* ─── Answer input ────────────────────────────────────────────── */
  function _setAnswerInputState(enabled, isMcq) {
    var inp = document.getElementById('tm-ask-input');
    var btn = document.getElementById('tm-ask-send');
    if (!inp) return;
    inp.disabled = !enabled;
    if (btn) btn.disabled = !enabled;
    if (enabled) {
      inp.placeholder = isMcq ? t('placeholder.mcq_answer') : t('placeholder.type_answer');
      inp.focus();
    } else {
      inp.placeholder = t('placeholder.waiting');
    }
  }

  /* ─── Block stream ────────────────────────────────────────────── */
  function _appendPhaseDivider(name) {
    var s = document.getElementById('tn-stream');
    if (!s) return;
    var d = document.createElement('div');
    d.className   = 'phase-divider';
    d.textContent = '── ' + name + ' ──';
    s.appendChild(d);
    _scrollStream();
  }

  function _appendBlock(block) {
    var s = document.getElementById('tn-stream');
    if (!s) return null;
    _streamBlocks.push(block);

    var el = document.createElement('div');
    el.className = 'block block-' + block.type + (block.subClass ? ' ' + block.subClass : '');

    if (block.rawHtml) {
      el.innerHTML = block.rawHtml;
    } else {
      el.style.whiteSpace = 'pre-wrap';
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

  function _showLoadingBlock() {
    if (_loading) return;
    _loading = true;
    var s = document.getElementById('tn-stream');
    if (!s) return;
    var d = document.createElement('div');
    d.id        = 'tn-loading-block';
    d.className = 'block block-loading';
    d.innerHTML = '<span class="loading-dot"></span><span class="loading-dot"></span><span class="loading-dot"></span>' +
                  '<span class="loading-status"></span>';
    s.appendChild(d);
    _scrollStream();
  }

  // Updates the text next to the loading dots while a non-English second pass runs.
  function _setLoadingStatus(key) {
    var el = document.getElementById('tn-loading-block');
    if (!el) return;
    var span = el.querySelector('.loading-status');
    if (span) span.textContent = t('status.' + key);
  }

  function _removeLoadingBlock() {
    _loading = false;
    var el = document.getElementById('tn-loading-block');
    if (el) el.remove();
  }

  function _scrollStream() {
    var s = document.getElementById('tn-stream');
    if (!s) return;
    if (s.scrollHeight - s.scrollTop - s.clientHeight < 160) {
      s.scrollTop = s.scrollHeight;
    }
  }

  /* ─── Static event wiring ─────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', function () {
    var askInp = document.getElementById('tm-ask-input');
    if (askInp) askInp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.testSendAsk(); }
    });

    var askSend = document.getElementById('tm-ask-send');
    if (askSend) askSend.addEventListener('click', window.testSendAsk);

    var startBtn = document.querySelector('#testing-mode .lm-start-btn');
    if (startBtn) startBtn.addEventListener('click', window.startTestKnobit);

    var quitTestConfirm = document.getElementById('quit-test-confirm');
    if (quitTestConfirm) quitTestConfirm.addEventListener('click', function () {
      var modal = document.getElementById('quit-test-modal');
      if (modal) modal.style.display = 'none';
      if (_testQuitCallback) { _testQuitCallback(); _testQuitCallback = null; }
    });
    var quitTestCancel = document.getElementById('quit-test-cancel');
    if (quitTestCancel) quitTestCancel.addEventListener('click', function () {
      var modal = document.getElementById('quit-test-modal');
      if (modal) modal.style.display = 'none';
      _testQuitCallback = null;
    });

    var mapBtn = document.querySelector('#testing-mode .lm-complete-btn-primary');
    if (mapBtn) mapBtn.addEventListener('click', window.closeTestingMode);

  });

})();

/* ─── public namespace ────────────────────────────────────────── */
window.Test = {
  open:     window.openTestingMode,
  close:    window.closeTestingMode,
  showView: window.showTmView,
};
