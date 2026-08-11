(function () {
  var runner = document.querySelector('.dog-runner');
  var main = document.querySelector('main');
  var flip = runner ? runner.querySelector('.dog-flip') : null;
  if (!runner || !main || !flip) return;

  var DOG_WIDTH = 138; // full padded bounding box, used only for CSS-sizing-derived math
  var DOG_VISIBLE_WIDTH = 65; // his actual drawn silhouette — most of the box is transparent viewBox padding, so this (not DOG_WIDTH) is what should count as "how much clearance he needs from the text"
  var BUFFER = 2; // small gap kept from the text column
  var MIN_RIGHT = 8;
  var EDGE_THRESHOLD = 22; // never rest facing the outer window edge within this range
  var MIN_HOP_RANGE = 90; // guaranteed minimum roaming width, even on tight margins

  var marginRight = 200;
  var safeTopPct = 4;
  var safeBottomPct = 70;

  function measure() {
    var rect = main.getBoundingClientRect();
    var scrollY = window.scrollY || window.pageYOffset;
    var docH = document.documentElement.scrollHeight || 1;
    // usable space = space outside main's box, PLUS main's own right padding
    // (that padding is empty margin, not text — safe to roam in too)
    var paddingRight = parseFloat(getComputedStyle(main).paddingRight) || 0;
    marginRight = Math.max(0, window.innerWidth - rect.right) + paddingRight;
    // stay within main's own vertical span — never over the header, the
    // marquees, or the footer, only ever over white space beside the text
    safeTopPct = ((rect.top + scrollY) / docH) * 100 + 1;
    safeBottomPct = ((rect.bottom + scrollY) / docH) * 100 - 2;
    if (safeBottomPct < safeTopPct) safeBottomPct = safeTopPct;
  }
  measure();
  window.addEventListener('resize', measure);
  window.addEventListener('load', measure);
  // catch late layout shifts (images finishing loading, fonts swapping in)
  setTimeout(measure, 800);
  setTimeout(measure, 2500);

  function maxRight() {
    return Math.max(MIN_RIGHT + MIN_HOP_RANGE, marginRight - DOG_VISIBLE_WIDTH - BUFFER);
  }

  var curTop = safeTopPct;
  var curRight = MIN_RIGHT;
  runner.style.top = curTop + '%';
  runner.style.right = curRight + 'px';

  var facingRight = true; // true = facing the screen-right (toward the outer edge)
  var stepping = false;

  function setFacing(right) {
    facingRight = right;
    flip.style.transform = facingRight ? 'scaleX(1)' : 'scaleX(-1)';
  }
  setFacing(false); // start facing the text, not the window edge

  // each animateTo call gets its own token — a stale in-flight loop from an
  // earlier call (e.g. an auto-hop interrupted by a bone-click) checks this
  // and quietly stops instead of fighting the newer loop over curRight/curTop
  var animToken = 0;

  function animateTo(newRight, newTop, duration, onDone) {
    var token = ++animToken;
    stepping = true;
    runner.classList.add('running');
    var startRight = curRight;
    var startTop = curTop;
    var startTime = null;

    function frame(now) {
      if (token !== animToken) return;
      if (startTime === null) startTime = now;
      var t = Math.min(1, (now - startTime) / duration);
      var eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      curRight = startRight + (newRight - startRight) * eased;
      curTop = startTop + (newTop - startTop) * eased;
      runner.style.right = curRight + 'px';
      runner.style.top = curTop + '%';
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        runner.classList.remove('running');
        stepping = false;
        if (onDone) onDone();
      }
    }
    requestAnimationFrame(frame);
  }

  function takeSteps() {
    if (stepping) return;

    var lo = MIN_RIGHT;
    var hi = maxRight();
    var span = Math.max(20, hi - lo);
    // a real hop: a healthy fraction of the whole roaming width, so he
    // actually crosses the space instead of inching along it
    var hopDistance = span * (0.35 + Math.random() * 0.35);

    var goRight = facingRight;
    var newRight = goRight ? curRight - hopDistance : curRight + hopDistance;
    var outOfBounds = newRight < lo || newRight > hi;
    if (outOfBounds) {
      // never face a direction with nowhere left to go — turn around instead
      goRight = !goRight;
      newRight = goRight ? curRight - hopDistance : curRight + hopDistance;
    }
    newRight = Math.min(hi, Math.max(lo, newRight));
    // never end a hop resting right up against the outer window edge —
    // there's nothing beyond it, so face inward instead
    if (newRight <= lo + EDGE_THRESHOLD) goRight = false;
    setFacing(goRight);

    // motion is primarily horizontal — only a small vertical drift per hop
    var vertRange = Math.max(0, safeBottomPct - safeTopPct);
    var drift = Math.min(vertRange * 0.15, 3.5);
    var newTop = Math.min(safeBottomPct, Math.max(safeTopPct, curTop + (Math.random() - 0.5) * 2 * drift));

    animateTo(newRight, newTop, 850 + Math.random() * 450);
  }

  function scheduleAuto() {
    var delay = 3000 + Math.random() * 3000;
    setTimeout(function () {
      takeSteps();
      scheduleAuto();
    }, delay);
  }
  scheduleAuto();

  var scrollLock = false;
  window.addEventListener('scroll', function () {
    if (scrollLock) return;
    scrollLock = true;
    setTimeout(function () { scrollLock = false; }, 1200);
    takeSteps();
  }, { passive: true });

  // run toward the exact bone dropped by a single click (ignores dragged
  // pencil lines), dip down to snatch that specific bone, and hold it
  var BONE_HOLD_MS = 2600;
  var boneHoldTimer = null;

  window.addEventListener('pencil-bone', function (e) {
    var x = e.detail.x, y = e.detail.y, boneId = e.detail.id;
    var scrollY = window.scrollY || window.pageYOffset;
    var docH = document.documentElement.scrollHeight || 1;

    // recompute the live text boundary right now so he can travel right up
    // to it — never clamped to the narrower ambient-roam floor. Use his
    // actual drawn (non-transparent) width, not the full padded viewBox
    // box, so he can close the last stretch instead of stopping short.
    var mRect = main.getBoundingClientRect();
    var mPaddingRight = parseFloat(getComputedStyle(main).paddingRight) || 0;
    var liveMarginRight = Math.max(0, window.innerWidth - mRect.right) + mPaddingRight;
    var hi = Math.max(MIN_RIGHT, liveMarginRight - DOG_VISIBLE_WIDTH);
    var lo = MIN_RIGHT;

    var targetRight = Math.min(hi, Math.max(lo, window.innerWidth - x - DOG_WIDTH / 2));
    var targetTop = Math.min(safeBottomPct, Math.max(safeTopPct, ((y + scrollY) / docH) * 100));

    setFacing(targetRight < curRight);
    runner.classList.remove('has-bone');
    runner.classList.remove('dipping');
    if (boneHoldTimer) { clearTimeout(boneHoldTimer); boneHoldTimer = null; }

    var dist = Math.hypot(targetRight - curRight, (targetTop - curTop) * (docH / 100));
    var duration = Math.min(1600, 500 + dist * 2);

    animateTo(targetRight, targetTop, duration, function () {
      // arrived — his head dips down toward the bone (a deeper torso tilt);
      // right as the dip bottoms out, the ground bone and the held bone
      // swap in the same instant, at the same spot, at the same size, so
      // nothing appears to jump — then lifting back up carries the (now
      // held) bone up with him, since it's anchored to his mouth
      runner.classList.add('dipping');
      setTimeout(function () {
        if (boneId !== undefined) {
          window.dispatchEvent(new CustomEvent('bone-eaten', { detail: { id: boneId } }));
        }
        runner.classList.add('has-bone');
        setTimeout(function () {
          runner.classList.remove('dipping'); // lift his head back up, bone in mouth
        }, 90);
        boneHoldTimer = setTimeout(function () {
          runner.classList.remove('has-bone');
          boneHoldTimer = null;
        }, BONE_HOLD_MS);
      }, 260);
    });
  });
})();
