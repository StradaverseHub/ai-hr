/* Arriving from the dashboard through the agent's hand-over (static/move.js): loaded in <head>, before the first paint,
   so the module paints under the same veil and the agent's tile, which fade away and the module fades in. A mark older
   than six seconds (a load that failed, a tab left) is ignored. */
(function () {
  try {
    var t = +window.sessionStorage.getItem("onehr-move") || 0;
    window.sessionStorage.removeItem("onehr-move");
    if (t && Date.now() - t < 6000) document.documentElement.classList.add("mv-arrive");
  } catch (e) { /* storage blocked: no fade, the page simply shows */ }
})();

/* The ONE phone switch (phone view, piece A, 2026-11-07): under 1024px wide is the phone view, 1024px and up is the desktop.
   static/style.css holds the matching `@media (max-width: 1023.98px)` section; a script that must draw differently asks
   window.onehrIsPhone() (never its own width test) and listens with window.onehrOnPhoneChange(fn) to draw again when the
   window crosses the line (a tablet turned over, a window dragged). Loaded in <head>, so every page has it first. */
(function () {
  var mq = null;
  try { mq = window.matchMedia("(max-width: 1023.98px)"); } catch (e) { /* no matchMedia: desktop */ }
  window.onehrIsPhone = function () { return !!(mq && mq.matches); };
  window.onehrOnPhoneChange = function (fn) {
    if (!mq || typeof fn !== "function") return;
    if (mq.addEventListener) mq.addEventListener("change", function () { fn(mq.matches); });
    else if (mq.addListener) mq.addListener(function () { fn(mq.matches); });
  };
})();

/* THE PHONE BACK GESTURE (2026-11-08): on a phone the system back (Android's swipe and back button, iOS Safari's edge swipe)
   closes the TOP LAYER first, exactly as that layer's own on-screen close does; only with no layer open does it leave the page.
   Every phone layer (a sheet, a person's page, OneHR's own confirm box, the Help panel) uses this ONE helper:
       var h = window.onehrBackLayer(closeFn);   // when the layer opens, inside the person's tap
       h.done();                                 // when it closes any other way (x, Esc, the dim, a Save, a redraw)
   `closeFn` closes the layer as its own close does and may return false to refuse (a move being saved): the layer stays open
   and its entry is put back. On a desktop width it does nothing at all (no history entry is ever pushed), and done() is a no-op.
   An entry carries the SAME url (never a hash, a `?` or a path: a reload or a route never sees it). Nested layers stack: one
   back, one layer. done() drops the layer's entry with ONE history.go(-n) (a redraw that closes and opens at once reuses it),
   so closing by the screen never leaves a dead entry. `done(fn)` runs fn after the entry is gone (a confirm's OK that then
   submits: a navigation started beside the traversal would be cancelled by it). Chrome on Android skips an entry pushed without
   a tap, so no tap in the last seconds means no entry (back then leaves the page, as today). `opts.force` (2026-11-08, "Leave without
   saving?"): only the leave box and the re-arming of a layer the back just let go use it, from inside the back's own popstate, where
   there is no tap; if the browser skips such an entry nothing breaks (the layer is re-armed by its next tap, see journey_chat.js). */
(function () {
  var stack = [];            // open layers, bottom first: { fn }
  var pendingBack = 0;       // entries to drop at the next flush (several layers closing in one task go in one traversal)
  var inflight = false;      // a traversal we started has not landed yet
  var timer = null, queued = [], afterFns = [], navUntil = 0, seq = 0;   // seq: layers are numbered as they open
  var noop = { done: function (after) { if (typeof after === "function") after(); } };

  function phone() { return typeof window.onehrIsPhone === "function" && window.onehrIsPhone(); }
  function tapped() { var u = navigator.userActivation; return !u || u.isActive; }
  function runAfter() { var f = afterFns; afterFns = []; f.forEach(function (fn) { try { fn(); } catch (e) { /* its own */ } }); }
  function push(L) {
    try {
      if (pendingBack > 0) {   // a layer closed in this same task: its entry is still there, so take it over
        pendingBack--;
        history.replaceState({ onehrLayer: stack.indexOf(L) + 1 }, "", location.href);
      } else history.pushState({ onehrLayer: stack.indexOf(L) + 1 }, "", location.href);
      L.pushed = true;
    } catch (e) { var i = stack.indexOf(L); if (i >= 0) stack.splice(i, 1); }
  }
  function flush() {
    timer = null;
    if (pendingBack <= 0) { runAfter(); return; }
    var n = pendingBack; pendingBack = 0;
    if (Date.now() < navUntil) { runAfter(); return; }   // a link or form is leaving the page: a traversal would cancel it
    inflight = true;
    try { history.go(-n); } catch (e) { inflight = false; runAfter(); return; }
    setTimeout(function () { if (inflight) { inflight = false; drain(); runAfter(); } }, 600);   // never waits for a popstate that did not come
  }
  function drain() { var q = queued; queued = []; q.forEach(function (L) { if (stack.indexOf(L) >= 0 && (tapped() || L.force)) push(L); else { var i = stack.indexOf(L); if (i >= 0) stack.splice(i, 1); } }); }
  function sched() { if (!timer) timer = setTimeout(flush, 0); }

  window.onehrBackLayer = function (closeFn, opts) {
    if (!phone() || typeof closeFn !== "function") return noop;
    var L = { fn: closeFn, pushed: false, force: !!(opts && opts.force), seq: ++seq };
    if (!tapped() && pendingBack <= 0 && !L.force) return noop;
    stack.push(L);
    if (inflight) queued.push(L); else push(L);
    if (stack.indexOf(L) < 0) return noop;
    return {
      done: function (after) {
        var i = stack.indexOf(L);
        if (i < 0) { if (typeof after === "function") after(); return; }   // closed by back already, or never registered
        stack.splice(i, 1);
        var q = queued.indexOf(L); if (q >= 0) queued.splice(q, 1);
        else if (L.pushed) pendingBack++;
        if (typeof after === "function") afterFns.push(after);
        sched();
      }
    };
  };

  window.addEventListener("popstate", function (e) {
    var was = inflight; inflight = false;
    var t = (e.state && e.state.onehrLayer) || 0, born = seq;
    // a layer opened by a closeFn inside this very loop (the leave box) is never popped by it: only layers that were open when the back came
    while (stack.length > t && stack[stack.length - 1].seq <= born) {
      var L = stack.pop();
      var keep = false;
      try { keep = L.fn(true) === false; } catch (x) { /* its own close failed: it is closed as far as back goes */ }
      if (keep) { stack.push(L); try { history.pushState({ onehrLayer: stack.length }, "", location.href); } catch (y) { /* leaves */ } break; }
    }
    if (t > stack.length && !was) {   // our own entry with nothing left to close (a forward step, a restored page): on past it
      inflight = true;
      try { history.go(-(t - stack.length)); } catch (z) { inflight = false; }
      return;
    }
    drain(); runAfter();
  });
  // a reload, or a page restored with our mark in its state and nothing open: the mark goes (a back is never dead)
  // (the layer entries sit ABOVE the page's own entry, at the same url: so the page's own entry is dropped to as well, one go(-n),
  // or a back would land on the same page again, a back that does nothing visible)
  function clean() {
    var n = history.state && history.state.onehrLayer;
    if (!n || stack.length) return;
    try { history.replaceState(null, "", location.href); history.go(-n); } catch (e) { /* none */ }
  }
  clean();
  window.addEventListener("pageshow", function (e) { if (e.persisted) clean(); });
  // a link or form that leaves the page, set off by the same tap that closes a layer: never cancel it with a traversal
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var h = a.getAttribute("href") || "";
    if (h.charAt(0) === "#" || /^javascript:/i.test(h) || (a.target && a.target !== "_self")) return;
    navUntil = Date.now() + 1500;
  });
  document.addEventListener("submit", function (e) { if (!e.defaultPrevented) navUntil = Date.now() + 1500; });
  // ...and a script's own location.href = ..., where the browser has the Navigation API (it fires as the navigation starts)
  try {
    if (window.navigation && typeof window.navigation.addEventListener === "function") window.navigation.addEventListener("navigate", function (e) {
      if (e.navigationType === "traverse" || e.hashChange || (e.destination && e.destination.sameDocument)) return;
      navUntil = Date.now() + 1500;
    });
  } catch (x) { /* an older browser: the click and submit listeners above */ }
  // the window crossing to a desktop width: layers that did not close themselves lose their entries, quietly
  if (typeof window.onehrOnPhoneChange === "function") window.onehrOnPhoneChange(function (p) {
    if (p) return;
    setTimeout(function () {
      var n = stack.filter(function (L) { return L.pushed; }).length;
      stack = []; queued = [];
      if (n) { pendingBack += n; sched(); }
    }, 0);
  });
})();
