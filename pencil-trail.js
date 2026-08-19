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
  var drawing = false;
  var lastOverText = false;

  var RELEASE_FADE_MS = 1000;
  var segments = []; // {x1,y1,x2,y2,hueT,releasedAt}

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

  // green -> rose, ping-ponging as you draw
  var CYAN = [71, 163, 135];
  var MAGENTA = [217, 76, 97];
  var hueT = 0;
  var hueDir = 1;

  function colorAt(t, alpha) {
    var r = Math.round(CYAN[0] + (MAGENTA[0] - CYAN[0]) * t);
    var g = Math.round(CYAN[1] + (MAGENTA[1] - CYAN[1]) * t);
    var b = Math.round(CYAN[2] + (MAGENTA[2] - CYAN[2]) * t);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function addSegment(x1, y1, x2, y2) {
    var dist = Math.hypot(x2 - x1, y2 - y1);
    hueT += hueDir * Math.min(0.08, dist * 0.01);
    if (hueT >= 1) { hueT = 1; hueDir = -1; }
    if (hueT <= 0) { hueT = 0; hueDir = 1; }
    segments.push({ x1: x1, y1: y1, x2: x2, y2: y2, hueT: hueT, releasedAt: null });
  }

  function render() {
    var now = performance.now();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // segments hold at full life while still being drawn (releasedAt is
    // null); only once the mouse comes up do they start their one-second
    // fade, all together, from that moment
    segments = segments.filter(function (s) {
      return s.releasedAt === null || now - s.releasedAt < RELEASE_FADE_MS;
    });

    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      var life = s.releasedAt === null ? 1 : 1 - (now - s.releasedAt) / RELEASE_FADE_MS;

      ctx.strokeStyle = colorAt(s.hueT, 0.45 * life);
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();

      ctx.strokeStyle = colorAt(s.hueT, 0.22 * life);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(s.x1 + 0.6, s.y1 - 0.6);
      ctx.lineTo(s.x2 + 0.6, s.y2 - 0.6);
      ctx.stroke();
    }

    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  document.addEventListener('mousedown', function (e) {
    drawing = true;
    lastOverText = isOverText(e.target);
    lastX = e.clientX;
    lastY = e.clientY;
  });

  document.addEventListener('mouseup', function () {
    drawing = false;
    var now = performance.now();
    segments.forEach(function (s) {
      if (s.releasedAt === null) s.releasedAt = now;
    });
    lastX = null;
    lastY = null;
  });

  document.addEventListener('mousemove', function (e) {
    if (drawing && lastX !== null) {
      // over readable text the pencil turns into a highlighter (see CSS) and
      // can't lay down ink — skip the segment if either end was over text,
      // so nothing draws across the boundary either
      var overText = isOverText(e.target);
      if (!overText && !lastOverText) {
        addSegment(lastX, lastY, e.clientX, e.clientY);
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
  });

  window.addEventListener('scroll', function () {
    segments = [];
    lastX = null;
  }, { passive: true });
})();
