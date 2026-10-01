// Rounded text-selection highlights, shared by every page and tool.
//
// CSS can't round a selection's corners (::selection takes no
// border-radius), so this hides the browser's own selection color and draws
// the highlight itself: one rounded bar per line of selected text, spaces
// included, line breaks between paragraphs left out. Works for ordinary
// text, contenteditable editors, and textareas/text inputs (measured
// through an invisible copy, since their text isn't in the page's DOM).
//
// Each page picks its color on the script tag:
//   <script src="/selection-highlight.js" data-color="#ddc9f7" defer></script>
(function () {
  var script = document.currentScript;
  var COLOR = (script && script.dataset.color) || '#b3d4fc';
  var RADIUS = 4;  // px, capped at a third of the bar's height
  var PAD_X = 1.5; // px the bar reaches past the first and last letter

  var css = document.createElement('style');
  css.textContent =
    '::selection { background: transparent; }' +
    '::-moz-selection { background: transparent; }' +
    // inputs this doesn't draw for (numbers, dates…) keep a plain highlight
    'input:not([type=text]):not([type=search]):not([type=url]):not([type=tel]):not([type=email]):not([type=password]):not(:not([type]))::selection { background: ' + COLOR + '; }' +
    '.sel-hl-layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; }' +
    '.sel-hl-layer.light { mix-blend-mode: multiply; }' +
    '.sel-hl-layer.dark { mix-blend-mode: screen; }' +
    '.sel-hl-layer > div { position: absolute; }' +
    '@media print { .sel-hl-layer { display: none; } }';
  document.head.appendChild(css);

  // Two layers: multiply keeps dark text dark on a light page; screen keeps
  // light text light on a dark one.
  var layers = {};
  ['light', 'dark'].forEach(function (k) {
    var d = document.createElement('div');
    d.className = 'sel-hl-layer ' + k;
    d.setAttribute('aria-hidden', 'true');
    layers[k] = d;
  });
  function mount() { document.body.appendChild(layers.light); document.body.appendChild(layers.dark); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  var rgb = parseColor(COLOR);
  var DARK_COLOR = 'rgb(' + rgb.map(function (c) { return Math.round(c * 0.45); }).join(',') + ')';

  function parseColor(c) {
    var probe = document.createElement('canvas').getContext('2d');
    probe.fillStyle = c;
    var v = probe.fillStyle; // normalized to #rrggbb or rgba(...)
    if (v.charAt(0) === '#') return [1, 3, 5].map(function (i) { return parseInt(v.substr(i, 2), 16); });
    return v.match(/[\d.]+/g).slice(0, 3).map(Number);
  }

  // ---- per-pass caches (cleared on every redraw) ----
  var bgCache, clipCache, skipCache;

  function isDarkBg(el) {
    if (bgCache.has(el)) return bgCache.get(el);
    var dark = false;
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var m = getComputedStyle(n).backgroundColor.match(/[\d.]+/g);
      if (m && (m.length < 4 || Number(m[3]) > 0.5)) {
        dark = (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) < 110;
        break;
      }
    }
    bgCache.set(el, dark);
    return dark;
  }

  // The part of the window an element's text can actually be seen in: inside
  // every scrolling or clipping box around it.
  function clipFor(el) {
    if (clipCache.has(el)) return clipCache.get(el);
    var c = { l: 0, t: 0, r: window.innerWidth, b: window.innerHeight };
    for (var n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      var s = getComputedStyle(n);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
        var r = n.getBoundingClientRect();
        c = { l: Math.max(c.l, r.left), t: Math.max(c.t, r.top), r: Math.min(c.r, r.right), b: Math.min(c.b, r.bottom) };
      }
      if (s.position === 'fixed') break;
    }
    clipCache.set(el, c);
    return c;
  }

  // Text the browser wouldn't highlight either.
  function skipped(el) {
    if (skipCache.has(el)) return skipCache.get(el);
    var s = getComputedStyle(el);
    var skip = (s.userSelect || s.webkitUserSelect) === 'none' || s.visibility === 'hidden';
    skipCache.set(el, skip);
    return skip;
  }

  var spaceWidths = {};
  var measureCtx = document.createElement('canvas').getContext('2d');
  function spaceWidth(el) {
    var s = getComputedStyle(el);
    var font = s.fontStyle + ' ' + s.fontWeight + ' ' + s.fontSize + ' ' + s.fontFamily;
    if (!(font in spaceWidths)) { measureCtx.font = font; spaceWidths[font] = measureCtx.measureText(' ').width; }
    return spaceWidths[font];
  }

  // Rectangles for the selected part of one text node, one per run between
  // newlines (a newline itself is never highlighted). A space the line
  // wrapped at has no width of its own; it gets a space's width so it shows.
  function textRects(node, start, end, el, out) {
    var text = node.data, range = document.createRange();
    var a = start;
    while (a < end) {
      var nl = text.indexOf('\n', a);
      var b = nl === -1 || nl >= end ? end : nl;
      if (b > a) {
        range.setStart(node, a); range.setEnd(node, b);
        var rs = range.getClientRects(), sw = null;
        for (var i = 0; i < rs.length; i++) {
          var r = rs[i];
          if (r.height === 0) continue;
          var left = r.left, right = r.right;
          if (right - left < 0.5) {
            if (sw === null) sw = spaceWidth(el);
            right = left + sw;
          }
          out.push({ l: left, r: right, t: r.top, b: r.bottom, el: el });
        }
      }
      a = b + 1;
    }
  }

  function rangeRects(range, out) {
    var root = range.commonAncestorContainer;
    if (root.nodeType === 3) {
      var p = root.parentElement;
      if (p && !skipped(p)) textRects(root, range.startOffset, range.endOffset, p, out);
      return;
    }
    // walk from where the selection starts, not from the top of the editor
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var first = range.startContainer;
    if (first.nodeType !== 3) first = first.childNodes[range.startOffset] || first;
    walker.currentNode = first;
    var vh = window.innerHeight, seen = false;
    for (var n = first.nodeType === 3 ? first : walker.nextNode(); n; n = walker.nextNode()) {
      if (!range.intersectsNode(n)) { if (seen) break; continue; }
      seen = true;
      if (!n.data.length) continue;
      var el = n.parentElement;
      if (!el || skipped(el)) continue;
      var box = el.getBoundingClientRect();
      if (box.bottom < 0 || box.top > vh) continue; // off screen: nothing to draw
      var s = n === range.startContainer ? range.startOffset : 0;
      var e = n === range.endContainer ? range.endOffset : n.data.length;
      if (e > s) textRects(n, s, e, el, out);
    }
  }

  // ---- textareas and text inputs: measure through an invisible copy ----
  var mirror = null;
  var COPY = ['boxSizing', 'width', 'height', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderTopStyle', 'borderRightStyle',
    'borderBottomStyle', 'borderLeftStyle', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize',
    'fontFamily', 'fontKerning', 'fontFeatureSettings', 'fontVariationSettings', 'lineHeight', 'letterSpacing',
    'wordSpacing', 'textIndent', 'textTransform', 'textAlign', 'tabSize', 'direction', 'overflowWrap', 'wordBreak', 'hyphens'];

  function fieldRects(field, out) {
    var start = field.selectionStart, end = field.selectionEnd;
    if (start == null || start === end || skipped(field)) return;
    if (!mirror) {
      mirror = document.createElement('div');
      mirror.setAttribute('aria-hidden', 'true');
      mirror.appendChild(document.createElement('div'));
      document.body.appendChild(mirror);
    }
    var s = getComputedStyle(field), ms = mirror.style;
    COPY.forEach(function (p) { ms[p] = s[p]; });
    var box = field.getBoundingClientRect();
    var isArea = field.tagName === 'TEXTAREA';
    ms.position = 'fixed';
    ms.left = box.left + 'px';
    ms.top = box.top + 'px';
    ms.visibility = 'hidden';
    ms.overflow = 'hidden';
    ms.pointerEvents = 'none';
    ms.borderColor = 'transparent';
    ms.whiteSpace = isArea ? 'pre-wrap' : 'pre';
    ms.zIndex = '-1';
    var inner = mirror.firstChild;
    // a textarea's scrollbar narrows its text column; match it
    inner.style.width = isArea ? field.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) + 'px' : '';
    inner.style.transform = 'translate(' + -field.scrollLeft + 'px,' + -field.scrollTop + 'px)';
    if (!isArea) {
      // an input centers its one line vertically
      var lh = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.2;
      var avail = field.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom);
      inner.style.paddingTop = Math.max(0, (avail - lh) / 2) + 'px';
      inner.style.lineHeight = lh + 'px';
    }
    var value = field.value;
    if (field.type === 'password') value = value.replace(/./g, '•');
    inner.textContent = value + '​';
    var node = inner.firstChild;
    var from = out.length;
    textRects(node, start, end, field, out);
    // keep the bars inside the field's text area
    var c = clipFor(field);
    var fc = {
      l: Math.max(c.l, box.left + field.clientLeft), t: Math.max(c.t, box.top + field.clientTop),
      r: Math.min(c.r, box.left + field.clientLeft + field.clientWidth), b: Math.min(c.b, box.top + field.clientTop + field.clientHeight)
    };
    for (var i = from; i < out.length; i++) out[i].clip = fc;
  }

  function isTextField(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && /^(text|search|url|tel|email|password|)$/.test(el.type || '');
  }

  // ---- drawing ----
  function draw() {
    bgCache = new WeakMap(); clipCache = new WeakMap(); skipCache = new WeakMap();
    var rects = [];
    var active = document.activeElement;
    if (isTextField(active)) {
      try { fieldRects(active, rects); } catch (e) {}
    } else {
      var sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        for (var i = 0; i < sel.rangeCount; i++) rangeRects(sel.getRangeAt(i), rects);
      }
    }
    var bars = joinLines(rects);
    var html = { light: '', dark: '' };
    bars.forEach(function (b) {
      var c = b.clip || clipFor(b.el);
      var l = Math.max(b.l - PAD_X, c.l), r = Math.min(b.r + PAD_X, c.r);
      var t = Math.max(b.t, c.t), btm = Math.min(b.b, c.b);
      if (r - l < 1 || btm - t < 1) return;
      if (covered(b.el, l, t, r, btm)) return;
      var dark = isDarkBg(b.el);
      var rad = Math.min(RADIUS, (b.b - b.t) / 3);
      html[dark ? 'dark' : 'light'] += '<div style="left:' + l + 'px;top:' + t + 'px;width:' + (r - l) + 'px;height:' + (btm - t) +
        'px;border-radius:' + rad + 'px;background:' + (dark ? DARK_COLOR : COLOR) + '"></div>';
    });
    if (layers.light.innerHTML !== html.light) layers.light.innerHTML = html.light;
    if (layers.dark.innerHTML !== html.dark) layers.dark.innerHTML = html.dark;
  }

  // Text behind something opaque (a dialog, a sign-in screen) is selected
  // but can't be seen, so it gets no bar either.
  function covered(el, l, t, r, b) {
    var y = (t + b) / 2;
    var xs = [l + 2, (l + r) / 2, r - 2];
    for (var i = 0; i < xs.length; i++) {
      var top = document.elementFromPoint(xs[i], y);
      if (!top || top === el || el.contains(top) || top.contains(el)) return false;
    }
    return true;
  }

  // Pieces on the same line become one bar, so the gaps between words (and
  // between differently styled words) are filled. Pieces far apart on a
  // line, like two columns, stay separate bars.
  function joinLines(rects) {
    rects.sort(function (a, b) { return a.t - b.t || a.l - b.l; });
    var lines = [];
    rects.forEach(function (r) {
      var mid = (r.t + r.b) / 2;
      for (var i = lines.length - 1; i >= 0 && i >= lines.length - 4; i--) {
        var L = lines[i];
        var gap = Math.max(r.l - L.r, L.l - r.r);
        if (mid > L.t && mid < L.b && gap < (L.b - L.t) * 1.5 && r.clip === L.clip) {
          L.l = Math.min(L.l, r.l); L.r = Math.max(L.r, r.r);
          L.t = Math.min(L.t, r.t); L.b = Math.max(L.b, r.b);
          return;
        }
      }
      lines.push({ l: r.l, r: r.r, t: r.t, b: r.b, el: r.el, clip: r.clip });
    });
    return lines;
  }

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; draw(); });
  }
  ['selectionchange', 'select', 'input', 'keyup', 'mouseup', 'focusin', 'focusout'].forEach(function (ev) {
    document.addEventListener(ev, schedule, true);
  });
  document.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
  // Layout can shift under a selection without any event (a panel opening,
  // a picture loading); keep checking while something is selected.
  setInterval(function () {
    if (layers.light.firstChild || layers.dark.firstChild) schedule();
  }, 500);
})();
