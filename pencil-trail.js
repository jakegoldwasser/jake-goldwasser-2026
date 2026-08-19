(function () {
  var canvas = document.createElement('canvas');
  canvas.id = 'pencil-trail-canvas';
  canvas.style.position = 'fixed';
  canvas.style.inset = '0';
  canvas.style.width = '100vw';
  canvas.style.height = '100vh';
  canvas.style.zIndex = '9999';
  canvas.style.pointerEvents = 'none';
  document.body.appendChild(canvas);

  var ctx = canvas.getContext('2d');
  var dpr = Math.max(1, window.devicePixelRatio || 1);
  var lastX = null;
  var lastY = null;
  var midX = null; // midpoint between the previous two raw points — the
  var midY = null; // start of the next smoothed curve segment
  var drawing = false;
  var lastOverText = false;
  var currentStroke = null;

  var RELEASE_FADE_MS = 1000;
  var SMOOTH = 0.25; // lower = smoother/laggier line, higher = more responsive
  // each stroke is ONE continuous path (a run of quadratic curves sharing a
  // single moveTo) — drawing it as one path, not one stroke() call per tiny
  // segment, is what keeps the line clean: separate round-capped strokes
  // bulge slightly at every join, which is what produced the tick marks
  var strokes = []; // {points: [[cx,cy,x,y], ...], startX, startY, releasedAt}

  // same selector the CSS uses to swap the cursor to the highlighter — kept
  // in sync by hand so "can't draw here" always matches "cursor says so"
  var TEXT_SELECTOR = '.prose, .prose p, li, .lede, .section-label, .entry-meta, .prose a, .lede a, ul.entry-list, ul.entry-list a';
  function isOverText(el) {
    return !!(el && el.closest && el.closest(TEXT_SELECTOR));
  }

  function resize() {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }
  resize();
  window.addEventListener('resize', resize);

  var LAVENDER = [152, 110, 207];
  function lavender(alpha) {
    return 'rgba(' + LAVENDER[0] + ',' + LAVENDER[1] + ',' + LAVENDER[2] + ',' + alpha + ')';
  }

  function startStroke(x, y) {
    currentStroke = { startX: x, startY: y, points: [], releasedAt: null };
    strokes.push(currentStroke);
  }

  // quadratic curve from the previous midpoint, through the actual point in
  // between, to the new midpoint — the standard trick for turning a jagged
  // point-to-point polyline into a smooth freehand-looking curve. Appended
  // to the current stroke's own point list, not drawn as its own path.
  function addPoint(cx, cy, x, y) {
    if (currentStroke) currentStroke.points.push([cx, cy, x, y]);
  }

  function render() {
    var now = performance.now();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    strokes = strokes.filter(function (s) {
      return s.releasedAt === null || now - s.releasedAt < RELEASE_FADE_MS;
    });

    for (var i = 0; i < strokes.length; i++) {
      var s = strokes[i];
      if (!s.points.length) continue;
      var life = s.releasedAt === null ? 1 : 1 - (now - s.releasedAt) / RELEASE_FADE_MS;

      ctx.strokeStyle = lavender(0.8 * life);
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(s.startX, s.startY);
      for (var j = 0; j < s.points.length; j++) {
        var p = s.points[j];
        ctx.quadraticCurveTo(p[0], p[1], p[2], p[3]);
      }
      ctx.stroke();
    }

    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  document.addEventListener('mousedown', function (e) {
    drawing = true;
    var overText = isOverText(e.target);
    lastOverText = overText;
    // starting a stroke with the pencil shouldn't also select text as you
    // drag; starting with the highlighter (over text) should still let the
    // browser's native selection happen, same lavender as the cursor itself
    if (!overText) {
      e.preventDefault();
    }
    lastX = e.clientX;
    lastY = e.clientY;
    midX = null;
    midY = null;
    currentStroke = null;
  });

  document.addEventListener('mouseup', function () {
    drawing = false;
    var now = performance.now();
    strokes.forEach(function (s) {
      if (s.releasedAt === null) s.releasedAt = now;
    });
    lastX = null;
    lastY = null;
    midX = null;
    midY = null;
    currentStroke = null;
  });

  document.addEventListener('mousemove', function (e) {
    if (drawing && lastX !== null) {
      // over readable text the pencil turns into a highlighter (see CSS) and
      // can't lay down ink — skip the segment if either end was over text,
      // so nothing draws across the boundary either
      var overText = isOverText(e.target);
      if (!overText && !lastOverText) {
        // low-pass filter the raw point before curving through it — this
        // lags behind small jitter instead of tracing it exactly, on top
        // of the midpoint-curve smoothing below, for a noticeably calmer
        // line without losing the overall gesture
        var smX = lastX + (e.clientX - lastX) * SMOOTH;
        var smY = lastY + (e.clientY - lastY) * SMOOTH;
        var newMidX = (lastX + smX) / 2;
        var newMidY = (lastY + smY) / 2;
        // first segment of a stroke (or right after crossing back from a
        // text boundary) has no previous midpoint yet — start a fresh
        // continuous path from the point itself rather than skipping it
        if (midX === null) {
          midX = lastX;
          midY = lastY;
          startStroke(midX, midY);
        }
        addPoint(lastX, lastY, newMidX, newMidY);
        midX = newMidX;
        midY = newMidY;
        lastOverText = overText;
        lastX = smX;
        lastY = smY;
        return;
      } else {
        midX = null;
        midY = null;
        currentStroke = null;
      }
      lastOverText = overText;
    }
    lastX = e.clientX;
    lastY = e.clientY;
  });

  document.addEventListener('mouseleave', function () {
    drawing = false;
    lastX = null;
    lastY = null;
    midX = null;
    midY = null;
    currentStroke = null;
  });

  window.addEventListener('scroll', function () {
    strokes = [];
    lastX = null;
    midX = null;
    currentStroke = null;
  }, { passive: true });
})();
