/* ═══════════════════════════════════════════════════════════════
   LEARNING JOURNEY TIMELINE  —  js/timeline.js
   Owns   : #timeline-lightbox overlay (opened from Section 2, Learner Passport)
   Calls  : GET /api/profile/timeline
   Exposes: window.Timeline.open()
   Ported from docs/timeline_demo.html (a standalone prototype iterated on
   with real data before being wired in here) — same visual language and
   layout math, swapped from fixed sample arrays to a live fetch.
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // Same domain→color map as the live map's CONTINENTS table in app.js,
  // keyed by the L1 node's external_id — keep in sync if that table changes.
  var DOMAIN_COLORS = {
    '1':     '#378ADD', // Mathematics
    '2':     '#9F8FE8', // Me (Mina)
    '3':     '#7ABF3C', // World (Maailm)
    '1000':  '#E84B7A', // Eesti keel
    '2000':  '#C0476E', // Kirjandus
    '3000':  '#20A89A', // Loodusõpetus
    '4000':  '#4C9E2C', // Bioloogia
    '5000':  '#D4873C', // Geograafia
    '6000':  '#E05430', // Füüsika
    '7000':  '#B040A8', // Keemia
    '8000':  '#8B5E3C', // Ajalugu
    '9000':  '#A0722A', // Ühiskonnaõpetus
    '10000': '#E8A030', // Inimeseõpetus
    '11000': '#D43EA0', // Kunstiõpetus
    '12000': '#7040C8', // Muusika
    '13000': '#2E8BC0', // Kehaline kasvatus
    '14000': '#C06830', // Käsitöö
    '15000': '#9E7030', // Tööõpetus
    '16000': '#3A9AE0', // Inglise keel
    '17000': '#5080C8', // Teine võõrkeel
    '18000': '#607080', // Tehnoloogiaõpetus
    '19000': '#A06858', // Keraamika
    '20000': '#C85858', // Toiduõpetus
  };
  var NEUTRAL_COLOR = '#B0A496';

  var PAD_X = 60, BASE_STEP = 74, GAP_SCALE = 20, GAP_CAP = 260, LANE_H = 64,
      TOP_PAD = 76, LABEL_CLOSE_GAP = 90, AXIS_PAD = 46, AXIS_GAP = 90,
      NOTCH_H = 18, KINK = 26;
  var MIN_R = 4, MAX_R = 12, DEFAULT_R = 5.5;
  var MIN_GAP_FONT = 10, MAX_GAP_FONT = 24;
  var SPEED_MS_PER_EVENT = { slow: 1100, medium: 600, fast: 320 };

  var svgNS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs) {
    var n = document.createElementNS(svgNS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  // Events are logged as e.g. "Started learning: X" / "Marked as known: X" —
  // on the graph we only want the node name "X"; full text is still the
  // native hover tooltip.
  function nodeNameOf(title) {
    var sep = title.indexOf(': ');
    return sep === -1 ? title : title.slice(sep + 2);
  }

  function fmtDate(s) {
    var dt = new Date(s);
    var dd = String(dt.getUTCDate()).padStart(2, '0');
    var mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    var yy = String(dt.getUTCFullYear()).slice(-2);
    return dd + '.' + mm + '.' + yy;
  }

  function fmtDateTime(sqlDt) {
    var dt = new Date(sqlDt.replace(' ', 'T') + 'Z');
    var dd = String(dt.getUTCDate()).padStart(2, '0');
    var mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    var yy = String(dt.getUTCFullYear()).slice(-2);
    var hh = String(dt.getUTCHours()).padStart(2, '0');
    var min = String(dt.getUTCMinutes()).padStart(2, '0');
    return dd + '.' + mm + '.' + yy + ' ' + hh + ':' + min;
  }

  // mysql2 returns DATE/DATETIME columns as JS Date objects, which res.json()
  // serializes to full ISO strings (e.g. "2026-06-04T00:00:00.000Z") — the
  // layout math below expects the plain "YYYY-MM-DD" / "YYYY-MM-DD HH:MM:SS"
  // shapes instead, so normalize once, right after the fetch.
  function normDate(v) {
    return String(v).slice(0, 10);
  }
  function normDateTime(v) {
    var s = String(v);
    return s.indexOf('T') !== -1 ? s.slice(0, 19).replace('T', ' ') : s;
  }

  var _rafId = null, _playing = false;

  function buildTimeline(rawEvents, rawCompletions) {
    var gutter = document.getElementById('tl-gutter');
    var svg    = document.getElementById('tl-canvas');
    var stage  = document.getElementById('tl-stage');
    var emptyEl = document.getElementById('tl-empty');

    // Reset from any previous open.
    if (_rafId) cancelAnimationFrame(_rafId);
    _playing = false;
    gutter.innerHTML = '';
    svg.innerHTML = '';
    gutter.style.height = '';

    if (!rawEvents.length) {
      stage.style.display = 'none';
      emptyEl.style.display = 'flex';
      emptyEl.textContent = t('msg.no_journey_yet');
      return;
    }
    stage.style.display = 'flex';
    emptyEl.style.display = 'none';

    // ── Build point layout ────────────────────────────────────────────────
    var lanes = {}, laneOrder = [], events = [];
    var prevDomain = null, curLaneIdx = 0, x = PAD_X;
    var lastLabelX = -Infinity, lastLabelSide = 1;

    rawEvents.forEach(function (raw, i) {
      var gapDays = 0;
      if (i > 0) gapDays = Math.round((new Date(raw.event_date) - new Date(rawEvents[i - 1].event_date)) / 86400000);
      var extra = i === 0 ? 0 : Math.min(GAP_CAP, Math.sqrt(Math.max(0, gapDays)) * GAP_SCALE);
      if (i > 0) x += BASE_STEP + extra;

      var domainId = raw.domainId != null ? String(raw.domainId) : null;
      var laneChanged = false;
      if (domainId) {
        if (lanes[domainId] === undefined) {
          lanes[domainId] = laneOrder.length;
          laneOrder.push({ id: domainId, label: raw.domainLabel });
        }
        if (domainId !== prevDomain && prevDomain !== null) laneChanged = true;
        curLaneIdx = lanes[domainId];
        prevDomain = domainId;
      }
      // Events with no linked node: no lane change, path runs straight through.

      var pctMatch = raw.result && raw.result.match(/(\d+)\s*%/);
      var pct = pctMatch ? Math.min(100, parseInt(pctMatch[1], 10)) : null;
      var radius = pct === null ? DEFAULT_R : MIN_R + (pct / 100) * (MAX_R - MIN_R);

      var labelSide = (x - lastLabelX < LABEL_CLOSE_GAP) ? -lastLabelSide : 1;
      lastLabelX = x; lastLabelSide = labelSide;

      events.push({
        date: raw.event_date, title: raw.title, sub: raw.result, type: raw.type,
        nodeExternalId: raw.node_external_id,
        domainId: domainId, color: domainId ? (DOMAIN_COLORS[domainId] || NEUTRAL_COLOR) : NEUTRAL_COLOR,
        x: x, y: TOP_PAD + curLaneIdx * LANE_H,
        pct: pct, radius: radius, labelSide: labelSide,
        laneChanged: laneChanged, gapDays: gapDays,
      });
    });

    // ── Day-anchor scale — used to place knobit-completion notches by
    //    time-of-day, and to correct "Completed: X" events (below). ────────
    var dayDates = [], dayXs = [];
    events.forEach(function (e) {
      if (dayDates.length === 0 || dayDates[dayDates.length - 1] !== e.date) {
        dayDates.push(e.date);
        dayXs.push(e.x);
      }
    });

    function addDays(dateStr, n) {
      var dt = new Date(dateStr + 'T00:00:00Z');
      dt.setUTCDate(dt.getUTCDate() + n);
      return dt.toISOString().slice(0, 10);
    }

    function xForDayStart(dateStr) {
      var idx = dayDates.indexOf(dateStr);
      if (idx !== -1) return dayXs[idx];
      var target = new Date(dateStr + 'T00:00:00Z').getTime();
      for (var i = 0; i < dayDates.length; i++) {
        var dt = new Date(dayDates[i] + 'T00:00:00Z').getTime();
        if (dt > target) {
          if (i === 0) return dayXs[0];
          var prevT = new Date(dayDates[i - 1] + 'T00:00:00Z').getTime();
          var frac = (target - prevT) / (dt - prevT);
          return dayXs[i - 1] + (dayXs[i] - dayXs[i - 1]) * frac;
        }
      }
      var n = dayDates.length;
      var prevT2 = new Date(dayDates[n - 2] + 'T00:00:00Z').getTime();
      var lastT2 = new Date(dayDates[n - 1] + 'T00:00:00Z').getTime();
      var pxPerMs = lastT2 > prevT2 ? (dayXs[n - 1] - dayXs[n - 2]) / (lastT2 - prevT2) : (BASE_STEP / 86400000);
      return dayXs[n - 1] + (target - lastT2) * pxPerMs;
    }

    function xForDateTime(dt) {
      var dateStr = dt.toISOString().slice(0, 10);
      var dayStartX = xForDayStart(dateStr);
      var dayEndX   = xForDayStart(addDays(dateStr, 1));
      var midnight  = new Date(dateStr + 'T00:00:00Z').getTime();
      var frac = (dt.getTime() - midnight) / 86400000;
      return dayStartX + (dayEndX - dayStartX) * frac;
    }

    // "Completed: X" events only carry a date (no time), so by default
    // they'd sit at day-start — but they really represent the moment the
    // LAST knobit for that node finished, which knobit_progress knows
    // precisely. Snap them onto that real moment.
    events.forEach(function (e, i) {
      if (e.title.indexOf('Completed: ') !== 0 || !e.nodeExternalId) return;
      var matches = rawCompletions.filter(function (c) { return c.nodeExternalId === e.nodeExternalId; });
      if (!matches.length) return;
      var lastAt = matches.reduce(function (m, c) { return c.completed_at > m ? c.completed_at : m; }, matches[0].completed_at);
      var correctedX = xForDateTime(new Date(String(lastAt).replace(' ', 'T') + 'Z'));
      if (i < events.length - 1) correctedX = Math.min(correctedX, events[i + 1].x - 8);
      e.x = Math.max(e.x, correctedX);
    });

    var totalW = Math.max(x, events[events.length - 1].x) + PAD_X;
    var chartH = TOP_PAD + Math.max(0, laneOrder.length - 1) * LANE_H + AXIS_GAP;
    var totalH = chartH + AXIS_PAD;

    var d = 'M ' + events[0].x + ' ' + events[0].y;
    for (var i = 1; i < events.length; i++) {
      var a = events[i - 1], b = events[i];
      if (b.laneChanged) {
        d += ' L ' + (a.x + KINK) + ' ' + a.y + ' L ' + (b.x - KINK) + ' ' + b.y + ' L ' + b.x + ' ' + b.y;
      } else {
        d += ' L ' + b.x + ' ' + b.y;
      }
    }

    gutter.style.height = totalH + 'px';
    laneOrder.forEach(function (lane, idx) {
      var y = TOP_PAD + idx * LANE_H;
      var laneDiv = document.createElement('div');
      laneDiv.className = 'tl-lane-label';
      laneDiv.style.top = y + 'px';
      laneDiv.innerHTML = '<span class="tl-lane-dot" style="background:' + (DOMAIN_COLORS[lane.id] || NEUTRAL_COLOR) + '"></span>';
      laneDiv.appendChild(document.createTextNode(lane.label || ''));
      gutter.appendChild(laneDiv);
    });

    svg.setAttribute('width', totalW);
    svg.setAttribute('height', totalH);
    svg.setAttribute('viewBox', '0 0 ' + totalW + ' ' + totalH);

    var defs = el('defs', {});
    var clipRect = el('rect', { x: 0, y: 0, width: 0, height: totalH });
    var clip = el('clipPath', { id: 'tl-reveal-clip' });
    clip.appendChild(clipRect);
    defs.appendChild(clip);
    svg.appendChild(defs);

    var revealed = el('g', { 'clip-path': 'url(#tl-reveal-clip)' });
    svg.appendChild(revealed);

    var trackFg = el('path', { d: d, class: 'tl-track-fg' });
    revealed.appendChild(trackFg);

    // date axis
    var axisY = chartH;
    var lastAxisX = -Infinity, lastYear = null;
    var MIN_AXIS_GAP = 58;
    events.forEach(function (e, i) {
      if (i > 0 && e.date === events[i - 1].date) return;
      if (e.x - lastAxisX < MIN_AXIS_GAP) return;
      lastAxisX = e.x;
      var dt = new Date(e.date);
      var showYear = dt.getUTCFullYear() !== lastYear;
      lastYear = dt.getUTCFullYear();
      var fmt = showYear
        ? dt.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' })
        : dt.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
      svg.appendChild(el('line', { class: 'tl-axis-tick', x1: e.x, y1: axisY, x2: e.x, y2: axisY + 8 }));
      var lbl = el('text', { class: 'tl-axis-label', x: e.x, y: axisY + 22 });
      lbl.textContent = fmt;
      svg.appendChild(lbl);
    });
    svg.appendChild(el('line', { class: 'tl-axis-tick', x1: 0, y1: axisY, x2: totalW, y2: axisY }));

    // gap labels
    events.forEach(function (e, i) {
      if (i === 0 || e.gapDays < 2) return;
      var a = events[i - 1];
      var midX = (a.x + e.x) / 2, midY = Math.min(a.y, e.y) - 38;
      var gapFont = Math.min(MAX_GAP_FONT, MIN_GAP_FONT + Math.sqrt(e.gapDays) * 1.6);
      var txt = el('text', { class: 'tl-gap-label', x: midX, y: midY, style: 'font-size:' + gapFont.toFixed(1) + 'px' });
      txt.textContent = e.gapDays + ' ' + t(e.gapDays === 1 ? 'msg.day_later' : 'msg.days_later');
      revealed.appendChild(txt);
    });

    var dotEls = events.map(function (e) {
      var r = e.radius;
      var g = el('g', { class: 'tl-evt-dot', style: '--ring-r0:' + (r + 1) + '; --ring-r1:' + (r + 14) });
      var ring = el('circle', { class: 'tl-ring', cx: e.x, cy: e.y, r: r + 1, stroke: e.color });
      g.appendChild(ring);
      var side = r * 1.7;
      var shape = e.type === 'assessment'
        ? el('rect', { x: e.x - side / 2, y: e.y - side / 2, width: side, height: side, rx: 2, transform: 'rotate(45 ' + e.x + ' ' + e.y + ')', fill: e.color, stroke: '#fff', 'stroke-width': 1.5 })
        : el('circle', { cx: e.x, cy: e.y, r: r, fill: e.color, stroke: '#fff', 'stroke-width': 1.5 });
      g.appendChild(shape);

      var titleEl = el('title', {});
      titleEl.textContent = e.title + (e.sub ? ' — ' + e.sub : '') + '\n' + e.date;
      g.appendChild(titleEl);

      revealed.appendChild(g);

      var name = nodeNameOf(e.title);
      if (name.length > 24) name = name.slice(0, 23) + '…';
      var labelY = e.labelSide > 0 ? e.y - r - 8 : e.y + r + 15;
      var label = el('text', { class: 'tl-evt-title', x: e.x, y: labelY });
      label.textContent = name;
      revealed.appendChild(label);

      return g;
    });

    // knobit-completion notches — on the axis, not the path
    var notchEls = [];
    rawCompletions.forEach(function (c) {
      var dt = new Date(String(c.completed_at).replace(' ', 'T') + 'Z');
      var cx = xForDateTime(dt);
      var domainId = c.domainId != null ? String(c.domainId) : null;
      var color = domainId ? (DOMAIN_COLORS[domainId] || NEUTRAL_COLOR) : NEUTRAL_COLOR;
      var g = el('g', { class: 'tl-knobit-notch' });
      var tick = el('line', {
        class: 'tl-notch-tick', x1: cx, y1: axisY, x2: cx, y2: axisY - NOTCH_H, stroke: color,
      });
      g.appendChild(tick);
      var titleEl = el('title', {});
      titleEl.textContent = t('msg.knobit_completed_prefix') + c.knobitTitle + '\n' +
        c.nodeLabel + (c.domainLabel ? ' · ' + c.domainLabel : '') + '\n' + fmtDateTime(c.completed_at);
      g.appendChild(titleEl);
      revealed.appendChild(g);
      notchEls.push({ el: g, x: cx });
    });

    var wavefront = el('line', { id: 'tl-wavefront', x1: 0, y1: 0, x2: 0, y2: chartH });
    svg.appendChild(wavefront);

    var pill = el('g', { id: 'tl-travel-pill', style: 'opacity:0' });
    var pillBg = el('rect', { x: -34, y: -26, width: 68, height: 20, rx: 8 });
    pill.appendChild(pillBg);
    var pillDate = el('text', { class: 'tl-pill-date', x: 0, y: -12, 'text-anchor': 'middle' });
    pill.appendChild(pillDate);
    svg.appendChild(pill);

    // ── Playback ─────────────────────────────────────────────────────────
    var startTs = null, startX = PAD_X, curX = PAD_X;
    var speedKey = 'medium';
    var speed = (totalW - PAD_X) / (events.length * SPEED_MS_PER_EVENT[speedKey]);

    var viewport = document.getElementById('tl-viewport');
    var eventCounter = document.getElementById('tl-event-counter');
    var playBtn = document.getElementById('tl-play-btn');
    var restartBtn = document.getElementById('tl-restart-btn');
    var speedGroup = document.getElementById('tl-speed-group');

    function setSpeed(key) {
      speedKey = key;
      speed = (totalW - PAD_X) / (events.length * SPEED_MS_PER_EVENT[key]);
      if (_playing) { startX = curX; startTs = null; }
      speedGroup.querySelectorAll('.tl-speed-btn').forEach(function (b) {
        b.classList.toggle('active', b.dataset.speed === key);
      });
    }
    speedGroup.querySelectorAll('.tl-speed-btn').forEach(function (b) {
      b.onclick = function () { setSpeed(b.dataset.speed); };
    });
    setSpeed('medium');

    var lastShownIdx = -1;
    eventCounter.textContent = '0 / ' + events.length;

    function applyX(px) {
      curX = Math.max(0, Math.min(totalW, px));
      clipRect.setAttribute('width', curX);
      wavefront.setAttribute('x1', curX);
      wavefront.setAttribute('x2', curX);

      var lastIdx = 0;
      events.forEach(function (e, i) {
        var shown = e.x <= curX;
        if (shown !== dotEls[i].classList.contains('visible')) dotEls[i].classList.toggle('visible', shown);
        if (shown) lastIdx = i;
      });

      notchEls.forEach(function (n) {
        var shown = n.x <= curX;
        if (shown !== n.el.classList.contains('visible')) n.el.classList.toggle('visible', shown);
      });

      if (curX <= PAD_X) {
        pill.style.opacity = 0;
      } else {
        pill.style.opacity = 1;
        var e = events[lastIdx];
        pill.setAttribute('transform', 'translate(' + curX + ',' + Math.max(34, e.y - 30) + ')');
        if (lastIdx !== lastShownIdx) {
          pillDate.textContent = fmtDate(e.date);
          eventCounter.textContent = (lastIdx + 1) + ' / ' + events.length;
          lastShownIdx = lastIdx;
        }
      }

      var targetScroll = curX - viewport.clientWidth / 2;
      viewport.scrollLeft = Math.max(0, Math.min(totalW - viewport.clientWidth, targetScroll));
    }

    function tick(ts) {
      if (startTs === null) startTs = ts;
      var elapsed = ts - startTs;
      var px = startX + elapsed * speed;
      if (px >= totalW) {
        applyX(totalW);
        _playing = false;
        playBtn.textContent = '▶';
        return;
      }
      applyX(px);
      _rafId = requestAnimationFrame(tick);
    }

    playBtn.onclick = function () {
      if (_playing) {
        _playing = false;
        playBtn.textContent = '▶';
        if (_rafId) cancelAnimationFrame(_rafId);
        return;
      }
      if (curX >= totalW) applyX(PAD_X);
      _playing = true;
      playBtn.textContent = '❚❚';
      startTs = null;
      startX = curX;
      _rafId = requestAnimationFrame(tick);
    };

    restartBtn.onclick = function () {
      _playing = false;
      playBtn.textContent = '▶';
      if (_rafId) cancelAnimationFrame(_rafId);
      lastShownIdx = -1;
      applyX(PAD_X - 1);
    };

    applyX(PAD_X - 1);
  }

  function openTimeline() {
    var overlay = document.getElementById('timeline-lightbox');
    if (!overlay) return;
    overlay.style.display = 'flex';
    fetch('/api/profile/timeline')
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (data) {
        var events = data.events || [];
        events.forEach(function (e) { e.event_date = normDate(e.event_date); });
        var completions = data.completions || [];
        completions.forEach(function (c) { c.completed_at = normDateTime(c.completed_at); });
        buildTimeline(events, completions);
      })
      .catch(function (err) {
        console.error('Timeline load failed:', err);
        var emptyEl = document.getElementById('tl-empty');
        document.getElementById('tl-stage').style.display = 'none';
        emptyEl.style.display = 'flex';
        emptyEl.textContent = t('msg.connection_error');
      });
  }

  function closeTimeline() {
    var overlay = document.getElementById('timeline-lightbox');
    if (overlay) overlay.style.display = 'none';
    if (_rafId) cancelAnimationFrame(_rafId);
    _playing = false;
  }

  document.addEventListener('DOMContentLoaded', function () {
    var trigger = document.getElementById('trigger-timeline-btn');
    if (trigger) trigger.addEventListener('click', openTimeline);

    var closeBtn = document.getElementById('tl-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', closeTimeline);

    var overlay = document.getElementById('timeline-lightbox');
    if (overlay) overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeTimeline();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay && overlay.style.display !== 'none') closeTimeline();
    });
  });

  window.Timeline = { open: openTimeline, close: closeTimeline };
}());
