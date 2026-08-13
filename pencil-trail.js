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
  var startX = null;
  var startY = null;
  var drawing = false;
  var moved = false;
  var lastOverText = false;

  var FADE_MS = 5000;
  var BONE_FADE_MS = 4500;
  var CLICK_SLOP = 12; // px of movement still counted as a "point" click
  var segments = []; // {x1,y1,x2,y2,t,hueT}
  var bones = []; // {id,x,y,t}
  var boneIdCounter = 0;

  // same selector the CSS uses to swap the cursor to the highlighter — kept
  // in one place so "can't draw here" always matches "cursor says so"
  var TEXT_SELECTOR = '.prose p, li, .lede, .section-label, .entry-meta, .prose a, .lede a, ul.entry-list a';
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
    segments.push({ x1: x1, y1: y1, x2: x2, y2: y2, hueT: hueT, t: performance.now() });
  }

  function drawBone(x, y, alpha) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.3);
    ctx.fillStyle = 'rgba(255,255,255,' + alpha + ')';
    ctx.strokeStyle = 'rgba(19,19,19,' + alpha + ')';
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(-11, -1.8);
    ctx.bezierCurveTo(-11, -3.8, -9, -5, -7.3, -3.7);
    ctx.bezierCurveTo(-6.3, -3, -5, -2.6, -3.5, -2.6);
    ctx.lineTo(3.5, -2.6);
    ctx.bezierCurveTo(5, -2.6, 6.3, -3, 7.3, -3.7);
    ctx.bezierCurveTo(9, -5, 11, -3.8, 11, -1.8);
    ctx.bezierCurveTo(11, -0.4, 10, 0.4, 8.8, 0.6);
    ctx.bezierCurveTo(10, 0.8, 11, 1.6, 11, 3);
    ctx.bezierCurveTo(11, 5, 9, 6.2, 7.3, 4.9);
    ctx.bezierCurveTo(6.3, 4.2, 5, 3.8, 3.5, 3.8);
    ctx.lineTo(-3.5, 3.8);
    ctx.bezierCurveTo(-5, 3.8, -6.3, 4.2, -7.3, 4.9);
    ctx.bezierCurveTo(-9, 6.2, -11, 5, -11, 3);
    ctx.bezierCurveTo(-11, 1.6, -10, 0.8, -8.8, 0.6);
    ctx.bezierCurveTo(-10, 0.4, -11, -0.4, -11, -1.8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function render() {
    var now = performance.now();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    segments = segments.filter(function (s) { return now - s.t < FADE_MS; });
    bones = bones.filter(function (b) { return now - b.t < BONE_FADE_MS; });

    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      var life = 1 - (now - s.t) / FADE_MS; // 1 -> fresh, 0 -> gone

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

    for (var j = 0; j < bones.length; j++) {
      var b = bones[j];
      var blife = 1 - (now - b.t) / BONE_FADE_MS;
      drawBone(b.x, b.y, blife);
    }

    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  document.addEventListener('mousedown', function (e) {
    drawing = true;
    moved = false;
    lastOverText = isOverText(e.target);
    startX = e.clientX;
    startY = e.clientY;
    lastX = e.clientX;
    lastY = e.clientY;
  });

  document.addEventListener('mouseup', function (e) {
    drawing = false;
    if (!moved) {
      var id = ++boneIdCounter;
      bones.push({ id: id, x: e.clientX, y: e.clientY, t: performance.now() });
      window.dispatchEvent(new CustomEvent('pencil-bone', { detail: { x: e.clientX, y: e.clientY, id: id } }));
    }
    lastX = null;
    lastY = null;
    startX = null;
    startY = null;
  });

  // Bernie's head just reached this exact bone (dipped down onto it) —
  // remove it in place, right now, rather than waiting for its own slow
  // ambient fade timer. His head is physically over it at this instant,
  // so nothing appears to move, resize, or jump.
  window.addEventListener('bone-eaten', function (e) {
    var id = e.detail.id;
    bones = bones.filter(function (b) { return b.id !== id; });
  });

  document.addEventListener('mousemove', function (e) {
    if (drawing && lastX !== null) {
      if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) > CLICK_SLOP) {
        moved = true;
      }
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
    startX = null;
    startY = null;
  });

  window.addEventListener('scroll', function () {
    segments = [];
    lastX = null;
    lastY = null;
  }, { passive: true });
})();
