// Offline copy of the app (the same file serves Bookbug, Luddite and their
// HM copies; each folder has its own). The page and everything it loads --
// its fonts, scripts and icons, Google Fonts, cdnjs -- are kept as they're
// fetched, so the app opens with no connection. The page itself comes from
// the network first, so it's always the newest one when online, and from
// the cache only when the network can't be reached. Nothing else is kept:
// the apps' servers, Google sign-in and Drive always go to the network.
var SCOPE = self.registration.scope;
var CACHE = 'offline-v1 ' + SCOPE;   // one cache per app: several share an origin
var KEPT = /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)\//;
var PAGE_WAIT_MS = 10000;            // a connection this slow counts as none

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.add(new Request(SCOPE, { cache: 'reload' })); }).catch(function () {}));
  self.skipWaiting();
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE && /^offline-v\d+ /.test(k) && k.slice(k.indexOf(' ') + 1) === SCOPE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function keep(req, res) {
  if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { return c.put(req, copy); }).catch(function () {});
  }
  return res;
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  var url = new URL(req.url);
  var same = url.origin === self.location.origin;

  // The page: the network's copy, else the one kept (whatever its ?query).
  if (req.mode === 'navigate') {
    if (!same || req.url.indexOf(SCOPE) !== 0) return;
    var key = url.origin + url.pathname.replace(/index\.html$/, '');
    var kept = function () { return caches.open(CACHE).then(function (c) { return c.match(key, { ignoreSearch: true }); }); };
    e.respondWith(new Promise(function (resolve) {
      var done = false;
      function answer(r) { if (r && !done) { done = true; resolve(r); } }
      var timer = setTimeout(function () { kept().then(answer); }, PAGE_WAIT_MS);
      fetch(req).then(function (res) {
        clearTimeout(timer);
        if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { return c.put(key, copy); }).catch(function () {}); }
        answer(res);
      }).catch(function () {
        clearTimeout(timer);
        kept().then(function (r) {
          answer(r || new Response('You’re offline, and this page hasn’t been saved on this device yet. Open it once while online.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
        });
      });
    }));
    return;
  }

  // The page's own files, Google Fonts and cdnjs: the kept copy at once if
  // there is one (brought up to date behind it), else the network's.
  if (!same && !KEPT.test(req.url)) return;
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(req.url).then(function (hit) {
      var net = fetchToKeep(req.url, same ? req : null);
      if (hit) { net.catch(function () {}); return hit; }
      return net;
    });
  }));
});

// Fetched and kept under its address. Another site's file is asked for
// openly (CORS): a stylesheet's plain request gets an answer that can't be
// read, so can't be kept.
function fetchToKeep(url, req) {
  var r = req || new Request(url, { mode: 'cors', credentials: 'omit' });
  return fetch(r).then(function (res) { return keep(url, res); });
}

// The page sends what it loaded before this worker was looking after it
// (the first visit), so that's kept too.
self.addEventListener('message', function (e) {
  var urls = e.data && e.data.keep;
  if (!Array.isArray(urls)) return;
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(urls.filter(function (u) {
      return typeof u === 'string' && (u.indexOf(self.location.origin + '/') === 0 || KEPT.test(u));
    }).map(function (u) {
      return c.match(u).then(function (hit) { return hit || fetchToKeep(u, u.indexOf(self.location.origin + '/') === 0 ? new Request(u) : null).catch(function () {}); });
    }));
  }));
});
