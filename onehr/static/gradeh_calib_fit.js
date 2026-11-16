/* AI+ fit to curve, on the Grade H HOD stage page and the BU CEO's Talent Box (2 Nov 2026; canvas "AI fit to curve").
   The left panel: the server's suggestion (POST mode=preview, write-free), a tick, a REQUIRED remark and a Why fold for each move, the
   curve after the moves, and Apply, which asks the app's own confirm box (a form with data-confirm) and then posts the moves the leader
   kept, each with their remark (mode=apply). A fixed rule on the server, no model: the suggested wording is placeholder text only and
   is never filled in. Nothing is written until Apply. */
(function () {
  "use strict";
  var mount = document.getElementById("ghf");
  var openBtn = document.getElementById("ghf-open");
  if (!mount || !openBtn) return;
  var KIND = mount.getAttribute("data-kind");
  var URL = mount.getAttribute("data-url");
  var TOKEN = mount.getAttribute("data-csrf");
  var axis = mount.getAttribute("data-axis");           // hod: the stage's axis (fixed); unit: pot | perf (the switch)
  var panel = null, body = null, foot = null, busy = false, data = null, seq = 0;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function axisName(a) { return a === "pot" ? "Potential" : "Performance"; }
  function post(extra) {
    var f = new FormData();
    f.append("csrf_token", TOKEN);
    if (KIND === "hod") f.append("stage", mount.getAttribute("data-stage"));
    else { f.append("unit", mount.getAttribute("data-unit")); f.append("axis", axis); }
    Object.keys(extra || {}).forEach(function (k) { f.append(k, extra[k]); });
    return fetch(URL, { method: "POST", body: f, credentials: "same-origin" })
      .then(function (r) { return r.json().catch(function () { return {}; }); });
  }
  function pill(b) {
    var f = document.createDocumentFragment();
    var RANK = { UA: 1, BE: 2, ME: 3, AE: 4, OU: 5 };
    if (axis === "perf") { f.appendChild(el("b", null, String(RANK[b]))); f.appendChild(document.createTextNode(" ")); }
    var s = el("span", "potential-pill ghc-band", b); s.setAttribute("data-band", b);
    f.appendChild(s);
    return f;
  }

  function build() {
    panel = el("aside", "ghf");
    panel.id = "ghf-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "AI+ fit to curve");
    var head = el("div", "ghf-head");
    var top = el("div", "ghf-top");
    top.appendChild(el("span", "rv-ai-kicker", "AI+ suggestion"));
    var x = el("button", "ghf-x", "×"); x.type = "button"; x.setAttribute("aria-label", "Close");
    x.addEventListener("click", close);
    top.appendChild(x);
    head.appendChild(top);
    var h = el("h2", "ghf-title", "AI+ fit to curve · " + axisName(axis)); h.id = "ghf-title"; h.tabIndex = -1;
    head.appendChild(h);
    if (KIND === "unit") {
      var tg = el("div", "rv-tbox-views ghf-axis"); tg.setAttribute("role", "group"); tg.setAttribute("aria-label", "Axis");
      ["perf", "pot"].forEach(function (a) {
        var b = el("button", "rv-tbox-view", axisName(a)); b.type = "button"; b.setAttribute("data-axis", a);
        b.setAttribute("aria-pressed", a === axis ? "true" : "false");
        b.addEventListener("click", function () { if (a !== axis && !busy) { axis = a; load(); } });
        tg.appendChild(b);
      });
      head.appendChild(tg);
    }
    var lede = el("p", "ghf-lede"); lede.appendChild(el("b", null, "AI+ suggests; you decide.")); lede.appendChild(document.createTextNode(" Nothing changes until you apply."));
    head.appendChild(lede);
    head.appendChild(el("p", "ghf-aim", "Fewest moves, one band at a time, to bring each band within the expected spread."));
    panel.appendChild(head);
    body = el("div", "ghf-body"); panel.appendChild(body);
    foot = el("div", "ghf-foot"); foot.hidden = true; panel.appendChild(foot);
    document.body.appendChild(panel);
    document.addEventListener("keydown", onKey);
  }
  function onKey(e) {
    if (e.key === "Escape" && panel && !busy && !document.querySelector(".modal-overlay")) close();
  }
  function close() {
    document.removeEventListener("keydown", onKey);
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = body = foot = null; data = null;
    openBtn.setAttribute("aria-expanded", "false");
    openBtn.focus();
  }
  function setTitle() {
    var h = document.getElementById("ghf-title");
    if (h) h.textContent = "AI+ fit to curve · " + axisName(axis);
    [].forEach.call(panel.querySelectorAll(".ghf-axis .rv-tbox-view"), function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-axis") === axis ? "true" : "false");
    });
  }

  function state(text, withRetry) {
    body.textContent = ""; foot.hidden = true; foot.textContent = "";
    var s = el("div", "ghf-state");
    s.appendChild(el("p", null, text));
    if (withRetry) {
      var b = el("button", "ghc-btn is-outline", "Try again"); b.type = "button"; b.addEventListener("click", load);
      var w = el("div"); w.appendChild(b); s.appendChild(w);
    }
    body.appendChild(s);
  }
  function working() {
    body.textContent = ""; foot.hidden = true;
    var s = el("div", "ghf-state"), p = el("p");
    p.appendChild(el("span", "ghf-spin")); p.appendChild(document.createTextNode("Working out the moves…"));
    s.appendChild(p); body.appendChild(s);
  }

  function load() {
    if (!panel) return;
    var mine = ++seq;
    busy = true; setTitle(); working();
    post({ mode: "preview" }).then(function (j) {
      if (mine !== seq || !panel) return;
      busy = false;
      if (!j || !j.ok) { state((j && j.error) ? j.error : "AI+ couldn’t suggest moves just now. Try again.", !(j && j.error)); return; }
      data = j; render(j);
    }).catch(function () {
      if (mine !== seq || !panel) return;
      busy = false; state("AI+ couldn’t suggest moves just now. Try again.", true);
    });
  }

  function render(j) {
    body.textContent = ""; foot.textContent = ""; foot.hidden = true;
    if (j.state !== "ok") {
      var s = el("div", "ghf-state"); s.appendChild(el("p", null, j.message)); body.appendChild(s);
      if (j.note) body.appendChild(el("p", "ghf-note", j.note));
      return;
    }
    var n = j.moves.length;
    var cnt = el("div", "ghf-count", n + " move" + (n === 1 ? "" : "s") + " suggested");
    cnt.appendChild(el("span", null, j.scope));
    body.appendChild(cnt);
    j.moves.forEach(function (m) {
      var row = el("div", "ghf-row"); row.setAttribute("data-pid", m.id);
      var r1 = el("div", "ghf-r1");
      var tick = document.createElement("input"); tick.type = "checkbox"; tick.checked = true; tick.setAttribute("aria-label", "Move " + m.name);
      tick.addEventListener("change", function () { row.classList.toggle("is-off", !tick.checked); update(); });
      r1.appendChild(tick); r1.appendChild(el("span", "ghf-who", m.name));
      var mv = el("span", "ghf-mv");
      mv.appendChild(pill(m.from)); mv.appendChild(el("span", "ghf-arrow", "→")); mv.appendChild(pill(m.to));
      mv.appendChild(el("span", "ghf-dir is-" + m.dir, m.dir));
      r1.appendChild(mv); row.appendChild(r1);
      row.appendChild(el("p", "ghf-case", m.line));
      var lab = el("label", "ghf-lab", "Your remark (needed to move a band)");
      var ta = document.createElement("textarea"); ta.rows = 2; ta.maxLength = 2500; ta.setAttribute("placeholder", m.ph);
      ta.addEventListener("input", update);
      lab.appendChild(ta); row.appendChild(lab);
      var d = el("details", "ghf-why"); d.appendChild(el("summary", null, "Why"));
      var ul = document.createElement("ul"); m.why.forEach(function (w) { ul.appendChild(el("li", null, w)); });
      d.appendChild(ul); row.appendChild(d);
      row._m = m; row._tick = tick; row._ta = ta;
      body.appendChild(row);
    });
    var after = el("div", "ghf-after"); after.appendChild(el("h3", null, "Curve after these moves"));
    j.order.forEach(function (b) {
      var line = el("div", "ghf-bar"); line.appendChild(el("span", "ghf-bl", b));
      var bar = el("div", "calib-dist-bar");
      var fill = el("span", "calib-dist-fill calib-dist-" + b.toLowerCase()); fill.style.width = Math.min(100, j.total ? j.after[b] * 100 / j.total : 0) + "%";
      var tk = el("span", "calib-dist-tick"); tk.style.left = Math.min(100, j.total ? j.expected[b] * 100 / j.total : 0) + "%";
      bar.appendChild(fill); bar.appendChild(tk); line.appendChild(bar);
      var t = el("span", "ghf-bn"); t.appendChild(document.createTextNode(j.before[b] + " → "));
      t.appendChild(el("b", null, String(j.after[b]))); t.appendChild(document.createTextNode(" · expected " + j.expected[b]));
      line.appendChild(t); after.appendChild(line);
    });
    after.appendChild(el("p", "ghf-verdict", j.within_after ? "Within the expected spread after these moves." : "Closer to the expected spread; the rest needs your judgement."));
    body.appendChild(after);
    if (j.note) body.appendChild(el("p", "ghf-note", j.note));
    // foot: what is still to write, Close, and Apply as a real form so the app's own confirm box asks first
    foot.hidden = false;
    foot.appendChild(el("p", "ghf-need"));
    var acts = el("div", "ghf-acts");
    var cl = el("button", "ghc-btn is-outline", "Close"); cl.type = "button"; cl.addEventListener("click", close);
    var form = document.createElement("form"); form.className = "ghc-inline"; form.id = "ghf-form"; form.action = "#"; form.method = "post";
    var ap = el("button", "ghc-btn", "Apply"); ap.type = "submit"; ap.id = "ghf-apply";
    form.appendChild(ap);
    form.addEventListener("submit", function (e) {
      e.preventDefault();             // the base page's confirm box runs first (capture phase) and replays this once confirmed
      form.__confirmed = false;
      send(kept());
    });
    acts.appendChild(cl); acts.appendChild(form); foot.appendChild(acts);
    update();
  }

  function rows() { return [].slice.call(body.querySelectorAll(".ghf-row")); }
  function kept() { return rows().filter(function (r) { return r._tick.checked; }); }
  function update() {
    if (!panel || !foot || foot.hidden) return;
    var k = kept(), need = k.filter(function (r) { return !r._ta.value.trim(); }).length;
    rows().forEach(function (r) { r._ta.classList.toggle("is-need", r._tick.checked && !r._ta.value.trim() && !!r._ta.dataset.touched); });
    var ap = document.getElementById("ghf-apply"), form = document.getElementById("ghf-form"), nd = foot.querySelector(".ghf-need");
    ap.textContent = "Apply " + k.length + " move" + (k.length === 1 ? "" : "s");
    ap.disabled = !k.length || need > 0 || busy;
    nd.textContent = !k.length ? "Tick at least one move to apply." : need ? need + " remark" + (need === 1 ? "" : "s") + " still to write. Untick a move to leave that person as they are." : "";
    var names = k.map(function (r) { return r._m.name + ": " + r._m.from + " to " + r._m.to; });
    var same = k.length && k.every(function (r) { return r._m.from === k[0]._m.from && r._m.to === k[0]._m.to; });
    form.setAttribute("data-confirm-title", "Apply " + k.length + " move" + (k.length === 1 ? "" : "s") + "?");
    form.setAttribute("data-confirm", "Move " + k.length + (k.length === 1 ? " person" : " people") + (same ? " from " + k[0]._m.from + " to " + k[0]._m.to : "")
      + " on Grade H " + axisName(axis).toLowerCase() + ". Each move is saved with your remark, as if you had changed it yourself. "
      + "You can still change a band until you sign off.");
    form.setAttribute("data-confirm-list-label", "What changes");
    form.setAttribute("data-confirm-list", JSON.stringify(names));
    form.setAttribute("data-confirm-ok", "Apply " + k.length + " move" + (k.length === 1 ? "" : "s"));
  }

  function send(k) {
    if (busy || !k.length) return;
    busy = true; update();
    var moves = k.map(function (r) { return { id: r._m.id, from: r._m.from, to: r._m.to, remark: r._ta.value }; });
    post({ mode: "apply", moves: JSON.stringify(moves) }).then(function (j) {
      busy = false;
      if (j && j.ok && j.applied) { window.location.reload(); return; }   // the page's own message says what was applied
      var nd = foot && foot.querySelector(".ghf-need");
      var why = (j && j.skipped && j.skipped.length) ? j.skipped.map(function (s) { return s.name + ": " + s.why; }).join(" ") : ((j && j.error) || "Couldn’t apply the moves.");
      if (nd) nd.textContent = "Nothing was applied. " + why;
      var ap = document.getElementById("ghf-apply"); if (ap) ap.disabled = false;
    }).catch(function () {
      busy = false;
      var nd = foot && foot.querySelector(".ghf-need"); if (nd) nd.textContent = "Couldn’t apply the moves. Try again.";
      var ap = document.getElementById("ghf-apply"); if (ap) ap.disabled = false;
    });
  }

  openBtn.addEventListener("click", function () {
    if (panel) { close(); return; }
    build(); openBtn.setAttribute("aria-expanded", "true");
    var h = document.getElementById("ghf-title"); if (h) h.focus();
    load();
  });
  // a remark box shows it is needed only once the leader has touched it
  document.addEventListener("focusout", function (e) {
    if (e.target && e.target.matches && e.target.matches(".ghf-lab textarea")) { e.target.dataset.touched = "1"; update(); }
  });
})();
