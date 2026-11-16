/* What's new, the release log (Chris, 2026-11-03, canvas [design canvas link removed] boards P1, M1, M2).
   Two things, on every page after sign-in:
   1. the pop-out (.wn-dlg, drawn by the server on the dashboard and admin Home only, for the real account's unseen notes): it opens
      on load, holds the focus, and posts "seen" however it closes (Got it, the x, Esc, the dark around it, or a note's button, which
      then goes where it points);
   2. the panel the account menu's What's new row opens (#oh-whatsnew, Help's shell): it fetches GET /me/whats-new, draws the notes
      by day with a New tag on the unseen, then posts the ones it showed as seen and clears the menu's count.
   Text is set with textContent only: a note's words are never markup. No model here. */
(function () {
  "use strict";

  function token() {
    var m = document.querySelector('input[name="csrf_token"]');
    if (m && m.value) return m.value;
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute("content") : "";
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // the three tiles, as the server's _whatsnew.html draws them (mega = the notice bar's megaphone)
  var NS = "http://www.w3.org/2000/svg";
  var ICON = {
    mega: ["M3 10v4a1 1 0 0 0 1 1h2l6 4V5L6 9H4a1 1 0 0 0-1 1z", "M16 9a3.5 3.5 0 0 1 0 6", "M19 6a8 8 0 0 1 0 12"],
    list: ["M9 6h11M9 12h11M9 18h11", "M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"],
    clock: ["M12 7v5l3 2"]
  };
  function icon(name) {
    var s = document.createElementNS(NS, "svg");
    s.setAttribute("width", "18"); s.setAttribute("height", "18"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
    if (name === "clock") {
      var c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", "12"); c.setAttribute("cy", "12"); c.setAttribute("r", "9"); s.appendChild(c);
    }
    (ICON[name] || ICON.mega).forEach(function (d) {
      var p = document.createElementNS(NS, "path"); p.setAttribute("d", d); s.appendChild(p);
    });
    return s;
  }
  function noteEl(n) {
    var row = el("div", "wn-note");
    var tile = el("span", "wn-ic"); tile.setAttribute("aria-hidden", "true"); tile.appendChild(icon(n.icon));
    var box = el("div", "wn-nt");
    box.appendChild(el("h3", "wn-h", n.title));
    box.appendChild(el("p", "wn-p", n.body));
    if (n.link && n.link.url) {
      var a = el("a", "wn-go", n.link.label); a.href = n.link.url; box.appendChild(a);
    }
    row.appendChild(tile); row.appendChild(box);
    return row;
  }
  // tell the server which notes were seen (the one writer, POST /me/whats-new/seen); resolves whatever happens
  function markSeen(url, ids) {
    if (!url || !ids) return Promise.resolve();
    var fd = new FormData();
    fd.append("csrf_token", token()); fd.append("ids", ids);
    return fetch(url, { method: "POST", body: fd, credentials: "same-origin", keepalive: true })
      .then(function () {}, function () {});
  }
  function focusables(root) {
    return Array.prototype.filter.call(root.querySelectorAll("button, a[href], [tabindex='0']"), function (n) {
      return !n.disabled && n.offsetParent !== null;
    });
  }

  /* ---- 1. the pop-out ---- */
  var dlg = document.querySelector("[data-wn-dlg]");
  if (dlg) {
    (function () {
      var card = dlg.querySelector(".modal-card");
      var ids = dlg.getAttribute("data-wn-ids"), url = dlg.getAttribute("data-wn-url");
      var root = document.documentElement, saved = root.style.overflow, done = false;
      var opener = document.activeElement;
      root.style.overflow = "hidden";
      function finish(after) {
        if (done) return;
        done = true;
        root.style.overflow = saved;
        document.removeEventListener("keydown", onKey, true);
        if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
        if (opener && opener.focus && document.contains(opener)) { try { opener.focus(); } catch (e) {} }
        var seen = markSeen(url, ids);
        if (after) {   // a note's button: seen first, then on to the page (never held up for more than a moment)
          Promise.race([seen, new Promise(function (r) { setTimeout(r, 1500); })]).then(after);
        }
        clearCount();
      }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(); return; }
        if (e.key !== "Tab") return;
        var f = focusables(card);
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1], a = document.activeElement;
        if (e.shiftKey && (a === first || !card.contains(a))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (a === last || !card.contains(a))) { e.preventDefault(); first.focus(); }
      }
      document.addEventListener("keydown", onKey, true);
      Array.prototype.forEach.call(dlg.querySelectorAll("[data-wn-close]"), function (b) {
        b.addEventListener("click", function () { finish(); });
      });
      dlg.addEventListener("click", function (e) { if (e.target === dlg) finish(); });
      Array.prototype.forEach.call(dlg.querySelectorAll("[data-wn-go]"), function (a) {
        a.addEventListener("click", function (e) {
          if (e.metaKey || e.ctrlKey || e.shiftKey) return;
          e.preventDefault();
          var href = a.getAttribute("href");
          finish(function () { window.location.href = href; });
        });
      });
      var x = dlg.querySelector(".kpi-dlg-x");
      if (x) x.focus();
    })();
  }

  function clearCount() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-wn-count]"), function (c) { c.hidden = true; c.textContent = "0"; });
    Array.prototype.forEach.call(document.querySelectorAll("[data-wn-sub]"), function (s) { s.textContent = "What changed in AI+ OneHR"; });
  }

  /* ---- 2. the panel ---- */
  var panel = document.getElementById("oh-whatsnew");
  if (!panel) return;
  var dim = document.querySelector("[data-wn-dim]");
  var body = panel.querySelector("[data-wn-body]");
  var listUrl = panel.getAttribute("data-list-url"), seenUrl = panel.getAttribute("data-seen-url");
  var opener = null;

  function place() {   // under the top bar, as Help's panel does
    var bar = document.querySelector(".topbar, .adm-topbar, header.top, nav.topbar");
    var top = bar ? Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) : 0;
    panel.style.top = top + "px";
    if (dim) dim.style.top = top + "px";
  }
  function render(d) {
    body.textContent = "";
    if (!d || !d.days || !d.days.length) {
      body.appendChild(el("p", "wn-empty", (d && d.empty) || "Nothing new yet. When AI+ OneHR adds something you can use, it shows here."));
      return;
    }
    d.days.forEach(function (day) {
      var rel = el("section", "wn-rel");
      var head = el("div", "wn-rel-d", day.label);
      if (day.new) head.appendChild(el("span", "wn-new", "New"));
      rel.appendChild(head);
      day.notes.forEach(function (n) { rel.appendChild(noteEl(n)); });
      body.appendChild(rel);
    });
  }
  var backLayer = null;
  function open() {
    var help = document.getElementById("oh-help");
    if (help && !help.hidden && window.ohHelp) window.ohHelp.close();
    opener = document.activeElement;
    place();
    if (panel.hidden && !backLayer && typeof window.onehrBackLayer === "function") backLayer = window.onehrBackLayer(function () { backLayer = null; close(); });   // the phone's back gesture (move_in.js)
    panel.hidden = false;
    if (dim) dim.hidden = false;
    var menu = document.getElementById("acct-menu"), trig = document.getElementById("acct-trigger");
    if (menu) menu.hidden = true;
    if (trig) trig.setAttribute("aria-expanded", "false");
    var h = panel.querySelector(".hp-h");
    if (h) { try { h.focus({ preventScroll: true }); } catch (e) { h.focus(); } }
    fetch(listUrl, { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        render(d);
        if (d && d.new_ids && d.new_ids.length) { markSeen(seenUrl, d.new_ids.join(",")); clearCount(); }
      })
      .catch(function () { render(null); });
  }
  function close() {
    if (backLayer) { var bl = backLayer; backLayer = null; bl.done(); }
    panel.hidden = true;
    if (dim) dim.hidden = true;
    if (opener && opener.focus) { try { opener.focus(); } catch (e) {} }
  }
  // the account menu stops its clicks at its own edge (base.html's dropdowns), so its row has its own listener, as Help's does
  Array.prototype.forEach.call(document.querySelectorAll("[data-wn-open]"), function (a) {
    a.addEventListener("click", function (e) { e.preventDefault(); open(); });
  });
  Array.prototype.forEach.call(panel.querySelectorAll("[data-wn-panel-close]"), function (b) { b.addEventListener("click", close); });
  if (dim) dim.addEventListener("click", close);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !panel.hidden) { e.preventDefault(); close(); }
  });
  // Help opening over it closes it (the two share the right-hand side)
  document.addEventListener("click", function (e) {
    if (!panel.hidden && e.target.closest && e.target.closest("[data-help-open]")) close();
  }, true);
  window.addEventListener("resize", function () { if (!panel.hidden) place(); });
  window.ohWhatsNew = { open: open, close: close };
  // ?whatsnew=1 (a Banner button, or a link): open it on arrival, and take the mark out of the address
  try {
    var q = new URLSearchParams(window.location.search);
    if (q.get("whatsnew") === "1") {
      open();
      q.delete("whatsnew");
      var qs = q.toString();
      history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : "") + window.location.hash);
    }
  } catch (e) { /* an old browser: the panel opens from the menu */ }
})();
