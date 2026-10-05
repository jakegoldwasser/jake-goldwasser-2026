/* Shared behavior for the ten v3 options:
   - Me / Words / Pictures are views of one page, switched by the URL hash
     (#me, #words, #words/poem, #pictures), so the header never reloads and
     the nav never moves. Bookbug is a real link out.
   - Justified-row galleries (the live site's Flickr-style tiling).
   - One lightbox for every picture. Clicking a picture always opens it
     large here, never Instagram.
   Each option styles the lightbox through its own tokens: --lb-bg,
   --lb-ink, --lb-btn, --lb-btn-ink, --lb-accent and --lb-font. */
(function () {
  var J = window.JG;
  J.esc = function (s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"); };
  J.byKind = function (k) { return J.works.filter(function (w) { return w.k === k; }); };
  J.thumb = function (i, size) { return J.picBase + J.pictures[i].p + "?format=" + (size || 750) + "w"; };
  J.full = function (i) { return J.picBase + J.pictures[i].p + "?format=2500w"; };
  J.alt = function (i) { var t = J.pictures[i].t; return t ? "Drawing by Jake Goldwasser: " + t : "Drawing by Jake Goldwasser"; };
  /* a button that opens picture i in the lightbox */
  J.pic = function (i, cls, size, inner) {
    return '<button type="button" class="' + (cls || "") + '" data-pic="' + i + '"><img src="' + J.thumb(i, size) + '" alt="' + J.esc(J.alt(i)) + '" loading="' + ((size || 0) >= 1500 ? "eager" : "lazy") + '">' + (inner || "") + "</button>";
  };
  /* title link (or plain text when the piece isn't online) */
  J.a = function (w, inner, cls) {
    inner = inner || J.esc(w.t);
    return w.url
      ? '<a' + (cls ? ' class="' + cls + '"' : "") + ' href="' + w.url + '" target="_blank" rel="noopener">' + inner + "</a>"
      : '<span' + (cls ? ' class="' + cls + '"' : "") + ">" + inner + "</span>";
  };
  /* the title as the live Words page prints it: quoted poems and essays,
     plain translation titles with their author */
  J.title = function (w) {
    if (w.k === "trans") return J.esc(w.t);
    var t = "“" + J.esc(w.t) + "”";
    return w.also ? t + " &amp; “" + J.esc(w.also) + "”" : t;
  };
  J.sub = function (w) {
    var bits = [];
    if (w.by) bits.push(w.by + ", from the " + w.lang);
    bits.push(w.v);
    if (w.note) bits.push(w.note);
    return bits.map(J.esc).join(" · ");
  };

  /* ---------- views ---------- */
  var views = {}, current = null, listeners = [];
  J.onView = function (fn) { listeners.push(fn); };
  function route() {
    var h = (location.hash || "#me").slice(1).split("/");
    var v = views[h[0]] ? h[0] : "me";
    var param = h[1] || null;
    var changed = v !== current;
    Object.keys(views).forEach(function (k) { views[k].hidden = k !== v; });
    document.querySelectorAll("[data-nav]").forEach(function (a) {
      if (a.dataset.nav === v) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    document.body.dataset.view = v;
    current = v;
    if (changed) window.scrollTo(0, 0);
    listeners.forEach(function (fn) { fn(v, param, changed); });
    galleries.forEach(function (g) { g.layout(); });
  }

  /* ---------- justified rows ---------- */
  var galleries = [];
  J.gallery = function (el, opt) {
    opt = opt || {};
    // gap may be a function, so a live spacing control can change it
    function gapNow() { return typeof opt.gap === "function" ? opt.gap() : (opt.gap == null ? 16 : opt.gap); }
    var gap = gapNow();
    var list = opt.only || J.pictures.map(function (_, i) { return i; });
    var items = list.map(function (i) {
      var d = document.createElement("div");
      d.innerHTML = J.pic(i, "jg-tile", 750, opt.inner ? opt.inner(i) : "");
      var btn = d.firstChild;
      var img = btn.querySelector("img");
      img.loading = "eager"; // real sizes are needed to settle the rows
      el.appendChild(btn);
      var rec = { aspect: 1.4, weight: J.pictures[i].w || 1, btn: btn };
      img.addEventListener("load", function () { rec.aspect = img.naturalWidth / img.naturalHeight; schedule(); });
      return rec;
    });
    var timer = null;
    function schedule() { if (!timer) timer = setTimeout(function () { timer = null; layout(); }, 20); }
    function layout() {
      var width = el.clientWidth;
      if (!width) return;
      gap = gapNow(); el.style.gap = gap + "px";
      var target = width < 560 ? (opt.small || 150) : (opt.row || 240);
      var row = [], rowW = 0;
      function flush(last) {
        if (!row.length) return;
        var natural = row.reduce(function (s, r) { return s + r.aspect * target; }, 0);
        var scale = (width - gap * (row.length - 1)) / natural;
        var h = last && scale > 1.4 ? target : target * scale;
        row.forEach(function (r) { r.btn.style.width = (r.aspect * h) + "px"; r.btn.style.height = h + "px"; });
        row = []; rowW = 0;
      }
      items.forEach(function (r) {
        var w = r.aspect * target * r.weight;
        if (row.length && rowW + gap + w > width) {
          // break wherever the row ends closer to full width: taking one
          // more picture and shrinking beats leaving one blown up alone
          if (width - rowW <= rowW + gap + w - width) flush(false);
          else { row.push(r); rowW += gap + w; flush(false); return; }
        }
        row.push(r); rowW += (row.length > 1 ? gap : 0) + w;
      });
      flush(true);
    }
    el.style.display = "flex"; el.style.flexWrap = "wrap"; el.style.gap = gap + "px";
    var g = { layout: layout };
    galleries.push(g);
    window.addEventListener("resize", schedule);
    return g;
  };

  /* ---------- lightbox ----------
     Prev / next live in fixed side columns and the counter has a fixed
     width, so the arrows never move while you click through pictures of
     different shapes or captions of different lengths. */
  var css = document.createElement("style");
  css.textContent =
    ".jg-tile{display:block;padding:0;border:0;background:none;cursor:zoom-in;flex:none;overflow:hidden}" +
    ".jg-tile img{width:100%;height:100%;object-fit:cover;display:block}" +
    "[data-pic]{cursor:zoom-in}" +
    ".jg-lb{position:fixed;inset:0;z-index:1000;display:none;grid-template-columns:clamp(56px,8vw,96px) minmax(0,1fr) clamp(56px,8vw,96px);grid-template-rows:64px minmax(0,1fr) 64px;background:var(--lb-bg,#111);color:var(--lb-ink,#fff);font-family:var(--lb-font,inherit)}" +
    ".jg-lb.open{display:grid}" +
    ".jg-lb figure{grid-column:2;grid-row:2;margin:0;position:relative;min-height:0}" +
    /* absolutely centered: a picture of any shape sits in the middle of its cell */
    ".jg-lb figure img{position:absolute;inset:0;margin:auto;max-width:100%;max-height:100%;display:block;background:#fff}" +
    ".jg-lb .bar{grid-column:2;grid-row:3;display:grid;grid-template-columns:5.5em minmax(0,1fr) 5.5em;align-items:center;gap:12px;font-size:14px;letter-spacing:.04em}" +
    ".jg-lb .count{font-variant-numeric:tabular-nums;opacity:.75}" +
    ".jg-lb .cap{text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".jg-lb button{font:inherit;color:var(--lb-btn-ink,#111);background:var(--lb-btn,#fff);border:0;cursor:pointer;width:52px;height:52px;border-radius:999px;display:grid;place-items:center;font-size:22px;line-height:1;transition:background .15s,color .15s,transform .15s}" +
    ".jg-lb button:hover{background:var(--lb-accent,#ddd);transform:translateY(-2px)}" +
    ".jg-lb .prev,.jg-lb .next{grid-row:2;align-self:center;justify-self:center}" +
    ".jg-lb .prev{grid-column:1}.jg-lb .next{grid-column:3}" +
    ".jg-lb .close{grid-column:3;grid-row:1;align-self:center;justify-self:center;width:44px;height:44px}" +
    "body.jg-locked{overflow:hidden}" +
    "@media (max-width:600px){.jg-lb{grid-template-columns:8px minmax(0,1fr) 8px;grid-template-rows:56px minmax(0,1fr) 88px}" +
    ".jg-lb .bar{grid-template-columns:52px minmax(0,1fr) 52px}.jg-lb .count{grid-column:2;grid-row:1;text-align:center}.jg-lb .cap{display:none}" +
    ".jg-lb .prev,.jg-lb .next{grid-row:3;align-self:center}.jg-lb .prev{grid-column:2;justify-self:start}.jg-lb .next{grid-column:2;justify-self:end}.jg-lb .close{grid-column:2;justify-self:end}}";
  document.head.appendChild(css);

  var lb, lbImg, lbCap, lbCount, at = 0, lastFocus = null;
  function buildLightbox() {
    lb = document.createElement("div");
    lb.className = "jg-lb";
    lb.setAttribute("role", "dialog");
    lb.setAttribute("aria-modal", "true");
    lb.setAttribute("aria-label", "Picture");
    lb.innerHTML = '<button class="close" type="button" aria-label="Close">&times;</button>' +
      '<button class="prev" type="button" aria-label="Previous picture">&larr;</button>' +
      '<figure><img alt=""></figure>' +
      '<button class="next" type="button" aria-label="Next picture">&rarr;</button>' +
      '<div class="bar"><span class="count"></span><span class="cap"></span><span></span></div>';
    document.body.appendChild(lb);
    lbImg = lb.querySelector("img"); lbCap = lb.querySelector(".cap"); lbCount = lb.querySelector(".count");
    lb.querySelector(".close").onclick = close;
    lb.querySelector(".prev").onclick = function () { show(at - 1); };
    lb.querySelector(".next").onclick = function () { show(at + 1); };
    lb.addEventListener("click", function (e) { if (e.target === lb || e.target.tagName === "FIGURE") close(); });
    var x0 = null;
    lb.addEventListener("touchstart", function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    lb.addEventListener("touchend", function (e) {
      if (x0 == null) return;
      var dx = e.changedTouches[0].clientX - x0; x0 = null;
      if (Math.abs(dx) > 50) show(at + (dx < 0 ? 1 : -1));
    });
  }
  function show(i) {
    var n = J.pictures.length;
    at = (i + n) % n;
    lbImg.src = J.thumb(at, 750); // instant from cache, then sharpen
    var hi = new Image();
    var want = at;
    hi.onload = function () { if (want === at) lbImg.src = hi.src; };
    hi.src = J.full(at);
    lbImg.alt = J.alt(at);
    lbCap.textContent = J.pictures[at].t || "";
    lbCount.textContent = (at + 1) + " / " + n;
  }
  function open(i) {
    lastFocus = document.activeElement;
    show(i);
    lb.classList.add("open");
    document.body.classList.add("jg-locked");
    lb.querySelector(".next").focus();
  }
  function close() {
    lb.classList.remove("open");
    document.body.classList.remove("jg-locked");
    if (lastFocus) lastFocus.focus();
  }
  J.openPicture = open;
  J.relayout = function () { galleries.forEach(function (g) { g.layout(); }); };

  /* ---------- colorways ----------
     Each option passes a list of { name, chips: [3 colors], vars: {token:
     value} }. The first is the original (empty vars). Choosing one sets
     those tokens on <html>, so everything built on the tokens follows,
     the lightbox included. The choice is remembered per page in this
     browser; press C to step through them. */
  J.colorways = function (list) {
    var key = "jg-colorway:" + location.pathname, applied = [];
    var st = document.createElement("style");
    st.textContent =
      ".jg-cw{position:fixed;right:14px;bottom:14px;z-index:900;display:flex;align-items:center;gap:8px;padding:6px 8px 6px 14px;background:#fff;color:#1d1d1f;border:1.5px solid #1d1d1f;border-radius:999px;box-shadow:3px 3px 0 #1d1d1f;font:500 12px/1 system-ui,-apple-system,sans-serif;letter-spacing:.02em}" +
      ".jg-cw .nm{min-width:6.5em}" + /* fixed width so the chips never shift as names change */
      ".jg-cw button{display:flex;width:30px;height:30px;padding:0;border:2px solid transparent;border-radius:999px;overflow:hidden;cursor:pointer;background:none;transition:transform .15s,border-color .15s}" +
      ".jg-cw button:hover{transform:translateY(-2px)}" +
      ".jg-cw button[aria-pressed=true]{border-color:#1d1d1f}" +
      ".jg-cw button i{flex:1}" +
      "@media (max-width:600px){.jg-cw{right:8px;bottom:8px;padding-left:10px}.jg-cw .nm{display:none}.jg-cw button{width:26px;height:26px}}";
    document.head.appendChild(st);
    var bar = document.createElement("div");
    bar.className = "jg-cw";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Colorway");
    bar.innerHTML = '<span class="nm"></span>' + list.map(function (c, i) {
      return '<button type="button" data-i="' + i + '" title="' + c.name + '" aria-label="' + c.name + ' colorway">' + c.chips.map(function (x) { return '<i style="background:' + x + '"></i>'; }).join("") + "</button>";
    }).join("");
    document.body.appendChild(bar);
    var cur = 0;
    function apply(i) {
      cur = (i + list.length) % list.length;
      var root = document.documentElement.style;
      applied.forEach(function (k) { root.removeProperty(k); });
      applied = Object.keys(list[cur].vars || {});
      applied.forEach(function (k) { root.setProperty(k, list[cur].vars[k]); });
      bar.querySelector(".nm").textContent = list[cur].name;
      bar.querySelectorAll("button").forEach(function (b) { b.setAttribute("aria-pressed", +b.dataset.i === cur); });
      try { localStorage.setItem(key, cur); } catch (e) {}
    }
    bar.addEventListener("click", function (e) { var b = e.target.closest("button"); if (b) apply(+b.dataset.i); });
    document.addEventListener("keydown", function (e) {
      if ((e.key === "c" || e.key === "C") && !e.metaKey && !e.ctrlKey && !e.altKey && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) apply(cur + 1);
    });
    var saved = 0;
    try { saved = +localStorage.getItem(key) || 0; } catch (e) {}
    apply(saved < list.length ? saved : 0);
  };
  /* the Vermeer palette every option offers, in its own tokens: lapis
     ultramarine, lead-tin yellow, a plaster wall, a red-madder note */
  J.VERMEER = { ultra: "#2a4a9b", ultraDeep: "#1b2f6b", ultraTint: "#dce3f3", yellow: "#e8c13f", yellowDeep: "#8a6a12", yellowTint: "#f8ecc3", plaster: "#efe9da", plaster2: "#e3dbc6", shadow: "#1d2230", shadowSoft: "#5b6070", madder: "#9e3b2e", madderTint: "#f1d9d3", line: "#d6ccb5" };

  J.init = function () {
    document.querySelectorAll("[data-view]").forEach(function (s) { views[s.dataset.view] = s; });
    document.querySelectorAll("[data-bookbug]").forEach(function (a) { a.href = J.links.bookbug; });
    document.querySelectorAll("[data-ig]").forEach(function (a) { a.href = J.links.instagram; a.target = "_blank"; a.rel = "noopener"; });
    buildLightbox();
    document.addEventListener("click", function (e) {
      var b = e.target.closest("[data-pic]");
      if (b && !lb.contains(b)) { e.preventDefault(); open(+b.dataset.pic); }
    });
    document.addEventListener("keydown", function (e) {
      if (!lb.classList.contains("open")) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") show(at + 1);
      else if (e.key === "ArrowLeft") show(at - 1);
    });
    window.addEventListener("hashchange", route);
    route();
  };
})();
