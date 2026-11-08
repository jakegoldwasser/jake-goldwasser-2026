// A Promise that settles without an event loop.
//
// Apps Script answers a web request with whatever doPost() returns, at
// once; it never waits for a real Promise. Every Apps Script service is
// synchronous anyway, so luddite-backend/index.mjs's async code never has
// anything to wait for. build.mjs compiles its async/await into generators
// (esbuild's target es2016) and wraps the bundle with `var Promise =
// SyncPromise`, so every `await`, `.then` and `Promise.all` in it lands
// here. Callbacks go on a queue that `drain()` empties in a loop (like the
// microtask queue), rather than running nested, so a loop of a thousand
// awaits doesn't grow the stack.
var SyncPromise = (function () {
  var queue = [], head = 0;
  function later(fn) { queue.push(fn); }
  function drain() {
    while (head < queue.length) { var fn = queue[head]; queue[head++] = null; fn(); }
    queue = []; head = 0;
  }

  function P(executor) {
    this._s = 0; // 0 pending, 1 fulfilled, 2 rejected
    this._v = undefined;
    this._cbs = [];
    var self = this, done = false;
    try {
      executor(function (v) { if (!done) { done = true; adopt(self, v); } },
               function (e) { if (!done) { done = true; settle(self, 2, e); } });
    } catch (e) { if (!done) { done = true; settle(self, 2, e); } }
  }

  function settle(p, s, v) {
    if (p._s) return;
    p._s = s; p._v = v;
    var cbs = p._cbs; p._cbs = null;
    for (var i = 0; i < cbs.length; i++) later(cbs[i]);
  }

  function adopt(p, v) {
    if (v === p) return settle(p, 2, new TypeError('A promise cannot resolve to itself'));
    if (v && (typeof v === 'object' || typeof v === 'function')) {
      var then;
      try { then = v.then; } catch (e) { return settle(p, 2, e); }
      if (typeof then === 'function') {
        var called = false;
        later(function () {
          try {
            then.call(v, function (x) { if (!called) { called = true; adopt(p, x); } },
                         function (e) { if (!called) { called = true; settle(p, 2, e); } });
          } catch (e) { if (!called) { called = true; settle(p, 2, e); } }
        });
        return;
      }
    }
    settle(p, 1, v);
  }

  P.prototype.then = function (onOk, onErr) {
    var self = this;
    return new P(function (resolve, reject) {
      function run() {
        var cb = self._s === 1 ? onOk : onErr;
        if (typeof cb !== 'function') { (self._s === 1 ? resolve : reject)(self._v); return; }
        var out;
        try { out = cb(self._v); } catch (e) { reject(e); return; }
        resolve(out);
      }
      if (self._s) later(run); else self._cbs.push(run);
    });
  };
  P.prototype['catch'] = function (onErr) { return this.then(undefined, onErr); };
  P.prototype['finally'] = function (fn) {
    return this.then(function (v) { return P.resolve(fn()).then(function () { return v; }); },
                     function (e) { return P.resolve(fn()).then(function () { throw e; }); });
  };

  P.resolve = function (v) { return v instanceof P ? v : new P(function (r) { r(v); }); };
  P.reject = function (e) { return new P(function (_, r) { r(e); }); };
  P.all = function (list) {
    return new P(function (resolve, reject) {
      var items = Array.from(list), out = new Array(items.length), left = items.length;
      if (!left) { resolve(out); return; }
      items.forEach(function (x, i) {
        P.resolve(x).then(function (v) { out[i] = v; if (--left === 0) resolve(out); }, reject);
      });
    });
  };
  P.allSettled = function (list) {
    return P.all(Array.from(list).map(function (x) {
      return P.resolve(x).then(function (value) { return { status: 'fulfilled', value: value }; },
                               function (reason) { return { status: 'rejected', reason: reason }; });
    }));
  };
  P.race = function (list) {
    return new P(function (resolve, reject) { Array.from(list).forEach(function (x) { P.resolve(x).then(resolve, reject); }); });
  };

  // Runs drain() and hands back what the promise came to, or throws.
  P.settle = function (p) {
    drain();
    if (!(p instanceof P)) return p;
    if (p._s === 1) return p._v;
    if (p._s === 2) throw p._v;
    throw new Error('A request was still waiting on something when it finished');
  };
  return P;
})();
