/* Builds one Catalogue × Swatch combination from a small config, plus its
   Tweaks panel. Pages stay deliberately spare: the bio, the work and the
   pictures, with no intro lines or hints. Everything the panel changes is
   a CSS variable or a body class (see combo.css). */
(function () {
  var J = window.JG;

  /* palettes: four kind colors each as [base, deep, tint, on]
     (k1 poems, k2 translation, k3 nonfiction, k4 comics) */
  var INK = "#1f2326";
  var PAL = {
    primaries: { name: "Primaries", paper: "#ffffff", paper2: "#f3f2ef", card: "#ffffff", ink: INK, soft: "#565b61", line: "#dcdcd8",
      k: [["#d94c61", "#943442", "#f8dfe3", "#fff"], ["#47a387", "#306f5c", "#deeee9", "#fff"], [INK, INK, "#e6e6e3", "#fff"], ["#ffdd00", "#7d6a00", "#fff9d1", INK]] },
    earth: { name: "Earth", paper: "#f3ecdc", paper2: "#ebe2cc", card: "#fffdf7", ink: "#3a2a1c", soft: "#6e5c49", line: "#d6c9ad",
      k: [["#5f7a3a", "#435729", "#dfe5cf", "#fffdf7"], ["#2f6f6a", "#1f4c48", "#d3e3df", "#fffdf7"], ["#b0532c", "#7d3a1e", "#f0d9cb", "#fffdf7"], ["#c99a2e", "#7d5f17", "#f3e6c2", "#3a2a1c"]] },
    vermeer: { name: "Vermeer", paper: "#efe9da", paper2: "#e3dbc6", card: "#f8f4ea", ink: "#1d2230", soft: "#5b6070", line: "#d6ccb5",
      k: [["#2a4a9b", "#1b2f6b", "#dce3f3", "#fff"], ["#7d8a6e", "#56604b", "#e2e6da", "#fff"], ["#9e3b2e", "#6e271e", "#f1d9d3", "#fff"], ["#e8c13f", "#8a6a12", "#f8ecc3", "#1d2230"]] },
    bauhaus: { name: "Bauhaus", paper: "#f4f1ea", paper2: "#e9e5da", card: "#fbf9f4", ink: "#1a1a1a", soft: "#5b5952", line: "#d5d0c4",
      k: [["#d6402b", "#9a2c1c", "#f6d6d0", "#fff"], ["#2557a7", "#183c76", "#d8e2f3", "#fff"], ["#1a1a1a", "#000", "#e2e0da", "#fff"], ["#f1c232", "#7b6013", "#fbefc6", "#1a1a1a"]] },
    garden: { name: "Garden", paper: "#fbfaf5", paper2: "#eff0e6", card: "#ffffff", ink: "#1f2a22", soft: "#58645b", line: "#dcdfd3",
      k: [["#e07a5f", "#9c4a34", "#f8e0d8", "#fff"], ["#4f8a5b", "#365f3e", "#dceadf", "#fff"], ["#3d5a80", "#283d58", "#dbe3ee", "#fff"], ["#f2c14e", "#7f6116", "#fbefcc", "#1f2a22"]] },
    newsprint: { name: "Newsprint", paper: "#f7f2e6", paper2: "#ece5d4", card: "#fbf8f0", ink: "#1c1b19", soft: "#5a5650", line: "#ddd5c3",
      k: [["#e2402f", "#a32a1d", "#f8d6cf", "#fff"], ["#2f62c9", "#1f4490", "#d6e1f6", "#fff"], ["#1c1b19", "#000", "#e4dfd3", "#fff"], ["#f6c93b", "#806410", "#fcefc4", "#1c1b19"]] },
    spring: { name: "Spring", paper: "#f8f5ee", paper2: "#efeadf", card: "#fffdf8", ink: "#2c3a33", soft: "#63706a", line: "#dcd6c8",
      k: [["#e8a0a6", "#a85a62", "#f8e3e5", "#2c3a33"], ["#8bab7d", "#5a7a4d", "#e5eedf", "#2c3a33"], ["#7aa6c9", "#4a7699", "#dfeaf3", "#2c3a33"], ["#e9c46a", "#7f6420", "#f9eccb", "#2c3a33"]] },
    riso: { name: "Riso", paper: "#f7f1e3", paper2: "#efe6d1", card: "#fbf7ec", ink: "#1d2a6b", soft: "#4d5893", line: "#d6d4dd",
      k: [["#ff4f8b", "#c42a62", "#ffd7e5", "#1d2a6b"], ["#3b4fb8", "#1d2a6b", "#dde1f5", "#fff"], ["#1d2a6b", "#121a45", "#dde1f5", "#fff"], ["#ffe23d", "#8a7a00", "#fff6b8", "#1d2a6b"]] }
  };

  window.Combo = function (cfg) {
    var D = Object.assign({ bw: 3, r: 0, gap: 22, pad: 20, marquee: true, triband: true, bernie: true }, cfg.defaults || {});
    var hasBand = cfg.header === "band", hasBernie = cfg.filter === "bernie";
    var b = document.body;
    b.dataset.header = cfg.header; b.dataset.mark = cfg.mark; b.dataset.nav = cfg.nav;
    b.dataset.lede = cfg.lede; b.dataset.me = cfg.me; b.dataset.feature = cfg.feature;
    b.dataset.cards = cfg.cards || "tab"; b.dataset.pics = cfg.pics;
    b.dataset.dots = cfg.dots ? "on" : "off"; b.dataset.pressed = cfg.pressed || "ink";

    var tri = "<span></span>".repeat(9);
    b.insertAdjacentHTML("afterbegin",
      (hasBand ? '<div class="triband" aria-hidden="true">' + tri + '</div><div class="marquee" aria-hidden="true"><div class="track"><span>' + J.poemLine + ' ✦ </span><span>' + J.poemLine + " ✦ </span></div></div>" : "") +
      '<header class="hdr"><div class="wrap head-in"><a class="wordmark" href="#me">Jake Goldwasser<span class="chips"><i></i><i></i><i></i><i></i></span></a>' +
      '<nav class="nav"><a href="#me" data-nav="me">Me</a><a href="#words" data-nav="words">Words</a><a href="#pictures" data-nav="pictures">Pictures</a><a data-bookbug href="#">Bookbug</a></nav></div></header>' +
      '<main class="wrap">' +
        '<section data-view="me"><div class="me"><div><p class="lede" id="bio"></p>' + (cfg.facts ? '<ul class="facts" id="facts"></ul>' : "") + '</div><figure class="feature" id="feature"></figure></div><div id="extra"></div></section>' +
        '<section data-view="words"><div class="filters" id="filters" role="group" aria-label="Show"></div><div id="work"></div></section>' +
        '<section data-view="pictures"><div class="gallery" id="gallery"></div></section>' +
      "</main>" +
      '<footer><div class="wrap foot-in"><span>&copy; Jake Goldwasser 2026</span><a data-ig href="#">Instagram</a></div></footer>');
    // the wordmark's chip strip sits under the name, so it goes on its own line
    var mark = b.querySelector(".wordmark"), chips = mark.querySelector(".chips");
    if (cfg.mark === "inline") mark.insertBefore(chips, mark.firstChild);

    /* ---------- Me ---------- */
    document.getElementById("bio").innerHTML = J.bioHTML();
    var bl = document.querySelectorAll("#bio a");
    bl[0].dataset.k = "poem"; bl[1].dataset.k = "comic"; bl[2].dataset.k = "trans";
    if (cfg.facts) document.getElementById("facts").innerHTML = J.facts.map(function (f) { return "<li><b>" + f[0] + "</b><span>" + f[1] + "</span></li>"; }).join("");
    document.getElementById("feature").innerHTML = J.pic(J.FEATURE, "", 1500) + "<figcaption><span>" + J.pictures[J.FEATURE].t + "</span></figcaption>";
    function card(w) {
      var tag = w.url ? "a" : "div", attrs = w.url ? ' href="' + w.url + '" target="_blank" rel="noopener"' : "";
      return "<" + tag + ' class="card" data-k="' + w.k + '"' + attrs + '><span class="k">' + J.kinds[w.k].one + '</span><p class="t">' + J.title(w) + '</p><span class="v">' + J.sub(w) + "</span></" + tag + ">";
    }
    var extra = document.getElementById("extra");
    if (cfg.extra === "card4") extra.innerHTML = '<div class="card4">' + J.order.map(function (k) {
      return '<a href="#words/' + k + '" data-k="' + k + '"><span class="chip"></span><span class="meta"><span class="nm">' + J.kinds[k].label + '</span><span class="ct">' + J.byKind(k).length + "</span></span></a>";
    }).join("") + "</div>";
    if (cfg.extra === "lately") extra.innerHTML = '<h2 class="sec">Lately</h2><div class="cards">' + J.order.map(function (k) { return card(J.byKind(k)[0]); }).join("") + "</div>";

    /* ---------- Words ---------- */
    var filters = document.getElementById("filters"), work = document.getElementById("work");
    filters.innerHTML = '<button type="button" data-f="all" aria-pressed="true"><i></i>All</button>' +
      J.order.map(function (k) { return '<button type="button" data-f="' + k + '" data-k="' + k + '" aria-pressed="false"><i></i>' + J.kinds[k].label + "</button>"; }).join("") +
      (hasBernie ? '<div class="bernie" id="bernie" aria-hidden="true"><img src="../dog.svg" alt=""></div>' : "");
    if (cfg.words === "shelves") {
      work.className = "shelves";
      work.innerHTML = J.order.map(function (k) {
        var list = J.byKind(k);
        return '<div class="shelf" data-k="' + k + '"><h2>' + J.kinds[k].label + "<span>" + list.length + "</span></h2><ul>" + list.map(function (w) {
          return "<li>" + J.a(w, J.title(w), "t") + '<span class="v">' + J.sub(w) + "</span></li>";
        }).join("") + "</ul></div>";
      }).join("");
    } else {
      work.className = "cards";
      work.innerHTML = J.works.map(card).join("");
    }
    var bernie = document.getElementById("bernie"), chosen = "all";
    function placeBernie(trot) {
      if (!bernie) return;
      var btn = filters.querySelector('[data-f="' + chosen + '"]');
      bernie.style.transform = "translateX(" + (btn.offsetLeft + btn.offsetWidth / 2 - bernie.offsetWidth / 2) + "px)";
      if (trot) { bernie.classList.remove("trot"); void bernie.offsetWidth; bernie.classList.add("trot"); }
    }
    function choose(f) {
      chosen = f || "all";
      var btn = filters.querySelector('[data-f="' + chosen + '"]') || filters.querySelector("button");
      chosen = btn.dataset.f;
      filters.querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-pressed", x === btn); });
      work.querySelectorAll("[data-k]").forEach(function (c) { c.hidden = !(chosen === "all" || c.dataset.k === chosen); });
      if (cfg.words === "shelves") work.classList.toggle("one", chosen !== "all");
      placeBernie(true);
      filters.scrollTo({ left: btn.offsetLeft - 16, behavior: "smooth" });
    }
    filters.addEventListener("click", function (e) {
      var btn = e.target.closest("button"); if (!btn) return;
      history.replaceState(null, "", "#words" + (btn.dataset.f === "all" ? "" : "/" + btn.dataset.f));
      choose(btn.dataset.f);
    });
    J.onView(function (v, p) { if (v === "words") choose(p); });

    J.gallery(document.getElementById("gallery"), { row: 230, gap: function () { return state ? state.gap : 22; } });

    /* ---------- Tweaks ---------- */
    var keys = cfg.palettes, key = "jg-combo:" + location.pathname, state;
    try { state = JSON.parse(localStorage.getItem(key)); } catch (e) {}
    state = Object.assign({ pal: 0 }, D, state || {});
    function apply() {
      var p = PAL[keys[state.pal]] || PAL[keys[0]], st = document.documentElement.style;
      st.setProperty("--paper", p.paper); st.setProperty("--paper-2", p.paper2); st.setProperty("--card", p.card);
      st.setProperty("--ink", p.ink); st.setProperty("--ink-soft", p.soft); st.setProperty("--line", p.line);
      p.k.forEach(function (c, i) {
        var n = "--k" + (i + 1);
        st.setProperty(n, c[0]); st.setProperty(n + "-deep", c[1]); st.setProperty(n + "-tint", c[2]); st.setProperty(n + "-on", c[3]);
      });
      st.setProperty("--bw", state.bw + "px"); st.setProperty("--r", state.r + "px");
      st.setProperty("--gap", state.gap + "px"); st.setProperty("--pad", state.pad + "px");
      b.classList.toggle("no-marquee", !state.marquee); b.classList.toggle("no-triband", !state.triband);
      b.classList.toggle("has-bernie", hasBernie && state.bernie);
      try { localStorage.setItem(key, JSON.stringify(state)); } catch (e) {}
      sync();
      J.relayout();
      placeBernie(false);
    }
    var tw = document.createElement("div");
    tw.className = "tw";
    function chipsOf(p) { return [p.k[0][0], p.k[1][0], p.k[3][0]].map(function (c) { return '<b style="background:' + c + '"></b>'; }).join(""); }
    var sliders = [["bw", "Line width", 0, 6, 1], ["r", "Corners", 0, 28, 1], ["gap", "Spacing", 0, 48, 2], ["pad", "Padding", 10, 40, 2]];
    var toggles = (hasBand ? [["marquee", "Marquee"], ["triband", "Color band"]] : []).concat(hasBernie ? [["bernie", "Bernie"]] : []);
    tw.innerHTML = '<div class="tw-panel" hidden>' +
      '<div class="tw-row"><div class="tw-pal">' + keys.map(function (k, i) { return '<button type="button" data-pal="' + i + '"><span>' + chipsOf(PAL[k]) + "</span>" + PAL[k].name + "</button>"; }).join("") + "</div></div>" +
      sliders.map(function (s) { return '<div class="tw-row"><label for="tw-' + s[0] + '">' + s[1] + '<output id="tw-o-' + s[0] + '"></output></label><input type="range" id="tw-' + s[0] + '" data-k="' + s[0] + '" min="' + s[2] + '" max="' + s[3] + '" step="' + s[4] + '"></div>'; }).join("") +
      (toggles.length ? '<div class="tw-toggles">' + toggles.map(function (t) { return '<label><input type="checkbox" data-t="' + t[0] + '">' + t[1] + "</label>"; }).join("") + "</div>" : "") +
      '<button type="button" class="tw-reset">Reset</button></div>' +
      '<button type="button" class="tw-btn" aria-expanded="false"><i></i>Tweaks</button>';
    b.appendChild(tw);
    var panel = tw.querySelector(".tw-panel"), open = tw.querySelector(".tw-btn");
    function sync() {
      tw.querySelectorAll("[data-pal]").forEach(function (x) { x.setAttribute("aria-pressed", +x.dataset.pal === state.pal); });
      sliders.forEach(function (s) { tw.querySelector("#tw-" + s[0]).value = state[s[0]]; tw.querySelector("#tw-o-" + s[0]).textContent = state[s[0]] + "px"; });
      tw.querySelectorAll("[data-t]").forEach(function (x) { x.checked = !!state[x.dataset.t]; });
      open.querySelector("i").innerHTML = chipsOf(PAL[keys[state.pal]]);
    }
    open.onclick = function () { panel.hidden = !panel.hidden; open.setAttribute("aria-expanded", !panel.hidden); };
    tw.addEventListener("input", function (e) {
      if (e.target.dataset.k) { state[e.target.dataset.k] = +e.target.value; apply(); }
      if (e.target.dataset.t) { state[e.target.dataset.t] = e.target.checked; apply(); }
    });
    tw.addEventListener("click", function (e) {
      var p = e.target.closest("[data-pal]");
      if (p) { state.pal = +p.dataset.pal; apply(); }
      if (e.target.closest(".tw-reset")) { state = Object.assign({ pal: 0 }, D); apply(); }
    });
    // C steps through colorways
    document.addEventListener("keydown", function (e) {
      if ((e.key === "c" || e.key === "C") && !e.metaKey && !e.ctrlKey && !e.altKey && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { state.pal = (state.pal + 1) % keys.length; apply(); }
    });

    apply();
    J.init();
  };
})();
