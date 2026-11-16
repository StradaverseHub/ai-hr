/* Help (2026-10-22, canvas [design canvas link removed]): the panel Help in the account menu
   opens from the right, on every page. Three views: Help (the quick answers /help/answers picks for this page, view and
   part; Report a problem; their reports), Report a problem (a topic, their words, the page's details if ticked, one
   screenshot pasted from the clipboard or picked), and Sent (the reference and what happens next). OneHR Agent's Go
   card opens it on Report a problem through window.ohHelp.open("report"). No model here: Help has no chat of its own. */
(function () {
  "use strict";
  var panel = document.getElementById("oh-help");
  if (!panel) return;
  var dim = document.querySelector("[data-hp-dim]");
  var answersUrl = panel.getAttribute("data-answers-url");
  var reportUrl = panel.getAttribute("data-report-url");
  var form = panel.querySelector("[data-hp-form]");
  var detail = panel.querySelector("[data-hp-detail]");
  var count = panel.querySelector("[data-hp-count]");
  var aboutBox = panel.querySelector("[data-hp-about]");
  var errEl = panel.querySelector("[data-hp-err]");
  var fileIn = panel.querySelector("[data-hp-file]");
  var zone = panel.querySelector("[data-hp-shotzone]");
  var sendBtn = panel.querySelector("[data-hp-send]");
  var state = { data: null, view: "home", shot: null, shotUrl: null, opener: null, busy: false };
  var MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

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
  function ctx() {
    var c = (typeof window.ohHelpCtx === "function" && window.ohHelpCtx()) || {};
    return { ep: panel.getAttribute("data-ep") || "", view: c.view || "", stage: c.stage || "" };
  }
  function place() {   // under the top bar, as drawn: the bar stays in view
    var bar = document.querySelector(".topbar, .adm-topbar, header.top, nav.topbar");
    var top = bar ? Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) : 0;
    panel.style.top = top + "px";
    if (dim) dim.style.top = top + "px";
  }

  /* ---- the views ---- */
  function show(v) {
    state.view = v;
    Array.prototype.forEach.call(panel.querySelectorAll("[data-hp-view]"), function (s) {
      s.hidden = s.getAttribute("data-hp-view") !== v;
    });
    var h = panel.querySelector('[data-hp-view="' + v + '"] .hp-h');
    if (h) { try { h.focus({ preventScroll: true }); } catch (e) { h.focus(); } }
    if (v === "report") { setTimeout(function () { if (!aboutBox.querySelector("input:checked")) {
      var f = aboutBox.querySelector("input"); if (f) f.focus(); } else detail.focus(); }, 30); }
  }

  function renderAnswers(d) {
    panel.querySelector("[data-hp-label]").textContent = d.label ? "· " + d.label : "";
    var qa = panel.querySelector("[data-hp-qa]");
    qa.textContent = "";
    (d.items || []).forEach(function (it, i) {
      var row = el("div", "hp-qi" + (i === 0 ? " is-open" : ""));
      var b = el("button", "hp-q");
      b.type = "button";
      b.setAttribute("aria-expanded", i === 0 ? "true" : "false");
      var id = "hp-a-" + i;
      b.setAttribute("aria-controls", id);
      b.appendChild(el("span", "hp-q-t", it.q));
      b.appendChild(el("span", "hp-q-s", i === 0 ? "−" : "+"));
      var a = el("p", "hp-a", it.a);
      a.id = id;
      a.hidden = i !== 0;
      b.addEventListener("click", function () {
        var open = b.getAttribute("aria-expanded") !== "true";
        b.setAttribute("aria-expanded", open ? "true" : "false");
        b.lastChild.textContent = open ? "−" : "+";
        a.hidden = !open;
        row.classList.toggle("is-open", open);
      });
      row.appendChild(b);
      row.appendChild(a);
      qa.appendChild(row);
    });
    var hint = panel.querySelector("[data-hp-hint]");
    hint.textContent = d.hint || "";
    hint.hidden = !d.hint;
    // the report form's topics, built once
    if (!aboutBox.firstChild) {
      (d.about || []).forEach(function (t) {
        var lab = el("label", "hp-chip");
        var r = document.createElement("input");
        r.type = "radio"; r.name = "about"; r.value = t.key;
        r.addEventListener("change", function () {
          Array.prototype.forEach.call(aboutBox.querySelectorAll(".hp-chip"), function (c) {
            c.classList.toggle("is-on", c.querySelector("input").checked);
          });
        });
        lab.appendChild(r);
        lab.appendChild(document.createTextNode(t.label));
        aboutBox.appendChild(lab);
      });
    }
    detail.maxLength = d.max_text || 1000;
    panel.querySelector("[data-hp-where]").textContent = d.where || document.title.replace(/\s*[—-]\s*OneHR.*$/, "") || "This page";
    panel.querySelector("[data-hp-shotnote]").textContent = "Take a screenshot and paste it here, or choose a file. One image, up to "
      + (d.max_shot_mb || 2) + " MB. Check it shows nothing you'd rather not share.";
    renderMine(d.mine || []);
    countNow();
  }

  function renderMine(list) {
    Array.prototype.forEach.call(panel.querySelectorAll("[data-hp-mine-card]"), function (card) {
      card.hidden = !list.length;
      var box = card.querySelector("[data-hp-mine]");
      box.textContent = "";
      list.forEach(function (m) {
        var row = el("div", "hp-mrow");
        var top = el("div", "hp-mtop");
        top.appendChild(el("b", "hp-mref", m.ref));
        top.appendChild(el("span", "hp-mabout", m.about));
        var st = el("span", "hp-mst is-" + m.status, m.status === "new" ? "Received" : m.status_label + (m.when ? " · " + m.when : ""));
        top.appendChild(st);
        row.appendChild(top);
        if (m.reply) row.appendChild(el("p", "hp-mreply", m.reply));
        box.appendChild(row);
      });
    });
  }

  function load() {
    var c = ctx();
    var q = "?ep=" + encodeURIComponent(c.ep) + "&view=" + encodeURIComponent(c.view) + "&stage=" + encodeURIComponent(c.stage);
    return fetch(answersUrl + q, { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.ok) { state.data = d; renderAnswers(d); } return d; })
      .catch(function () { return null; });
  }

  /* ---- open / close ---- */
  var backLayer = null;   // the phone's back gesture closes the panel first (static/move_in.js, onehrBackLayer)
  function open(view, about) {
    state.opener = document.activeElement;
    place();
    if (panel.hidden && !backLayer && typeof window.onehrBackLayer === "function") backLayer = window.onehrBackLayer(function () { backLayer = null; close(); });
    panel.hidden = false;
    if (dim) dim.hidden = false;
    document.documentElement.classList.add("hp-on");
    show(view === "report" ? "report" : "home");
    load().then(function () { if (state.view === "report") { clearErr(); clearFields(); pickAbout(about); } });
  }
  // a door that knows what the report is about picks its topic (the Profile's "Report it with Help", 2026-10-22)
  function pickAbout(key) {
    var r = key && aboutBox.querySelector('input[value="' + key + '"]');
    if (!r) return;
    r.checked = true;
    Array.prototype.forEach.call(aboutBox.querySelectorAll(".hp-chip"), function (c) {
      c.classList.toggle("is-on", c.querySelector("input").checked);
    });
    fieldErr("about", false); missingNote();
    detail.focus();
  }
  function close() {
    if (backLayer) { var bl = backLayer; backLayer = null; bl.done(); }
    panel.hidden = true;
    if (dim) dim.hidden = true;
    document.documentElement.classList.remove("hp-on");
    if (state.opener && state.opener.focus) { try { state.opener.focus(); } catch (e) {} }
  }

  /* ---- the report ---- */
  function countNow() {
    var n = detail.value.length, max = detail.maxLength > 0 ? detail.maxLength : 1000;
    count.textContent = n.toLocaleString() + " / " + max.toLocaleString();
  }
  function clearErr() { errEl.hidden = true; errEl.textContent = ""; }
  function err(t) { errEl.textContent = t; errEl.hidden = false; }
  // the required fields (2026-10-22, Chris: "link them to it and red highlight the section"): an empty one turns red
  // with its message under it, Send report scrolls to the first and puts the cursor there, and the note at the foot
  // links each one; a field clears as soon as it's filled
  var FIELDS = ["about", "detail"];
  function fieldBox(k) { return panel.querySelector('[data-hp-field="' + k + '"]'); }
  function fieldErr(k, on) {
    var box = fieldBox(k), msg = panel.querySelector('[data-hp-ferr="' + k + '"]');
    if (box) box.classList.toggle("is-invalid", !!on);
    if (msg) msg.hidden = !on;
    if (k === "detail") { if (on) detail.setAttribute("aria-invalid", "true"); else detail.removeAttribute("aria-invalid"); }
  }
  function goField(k) {
    var box = fieldBox(k);
    if (!box) return;
    try { box.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { box.scrollIntoView(); }
    var f = k === "detail" ? detail : (aboutBox.querySelector("input:checked") || aboutBox.querySelector("input"));
    if (f) { try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); } }
  }
  function missingNote() {
    var left = FIELDS.filter(function (k) { var b = fieldBox(k); return b && b.classList.contains("is-invalid"); });
    if (!left.length) { clearErr(); return; }
    errEl.textContent = "";
    errEl.appendChild(document.createTextNode(left.length === 1 ? "One thing to fill in: " : "Fill these in: "));
    left.forEach(function (k, i) {
      if (i) errEl.appendChild(document.createTextNode(" · "));
      var a = el("button", "hp-errlink", (fieldBox(k).querySelector(".hp-label") || {}).textContent || k);
      a.type = "button";
      a.addEventListener("click", function () { goField(k); });
      errEl.appendChild(a);
    });
    errEl.hidden = false;
  }
  function clearFields() { FIELDS.forEach(function (k) { fieldErr(k, false); }); }
  var MAXB = function () { return ((state.data && state.data.max_shot_mb) || 2) * 1024 * 1024; };
  var TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  function setShot(file) {
    if (!file) return;
    if (TYPES.indexOf(file.type) < 0) { err("The screenshot must be an image: PNG, JPG, GIF or WebP."); return; }
    if (file.size > MAXB()) { err("That image is over " + (MAXB() / 1048576) + " MB. Take a smaller one, or leave it out."); return; }
    clearErr();
    if (state.shotUrl) URL.revokeObjectURL(state.shotUrl);
    state.shot = file;
    state.shotUrl = URL.createObjectURL(file);
    panel.querySelector("[data-hp-shotimg]").src = state.shotUrl;
    panel.querySelector("[data-hp-shotsize]").textContent = Math.max(1, Math.round(file.size / 1024)) + " KB";
    panel.querySelector("[data-hp-shotempty]").hidden = true;
    panel.querySelector("[data-hp-shothas]").hidden = false;
  }
  function dropShot() {
    if (state.shotUrl) URL.revokeObjectURL(state.shotUrl);
    state.shot = state.shotUrl = null;
    panel.querySelector("[data-hp-shotimg]").removeAttribute("src");
    panel.querySelector("[data-hp-shotempty]").hidden = false;
    panel.querySelector("[data-hp-shothas]").hidden = true;
    fileIn.value = "";
  }
  function resetForm() {
    form.reset();
    Array.prototype.forEach.call(aboutBox.querySelectorAll(".hp-chip"), function (c) { c.classList.remove("is-on"); });
    dropShot(); clearErr(); clearFields(); countNow();
  }

  function send() {
    if (state.busy) return;
    var about = aboutBox.querySelector("input:checked");
    var text = detail.value.trim();
    var missing = FIELDS.filter(function (k) { return k === "about" ? !about : !text; });
    FIELDS.forEach(function (k) { fieldErr(k, missing.indexOf(k) >= 0); });
    if (missing.length) { missingNote(); goField(missing[0]); return; }
    var c = ctx();
    var fd = new FormData();
    fd.append("csrf_token", token());
    fd.append("about", about.value);
    fd.append("detail", text);
    if (panel.querySelector("[data-hp-addpage]").checked) {
      fd.append("add_page", "1");
      fd.append("ep", c.ep); fd.append("view", c.view); fd.append("stage", c.stage);
      fd.append("path", location.pathname);
      fd.append("title", document.title || "");
    }
    if (state.shot) fd.append("shot", state.shot, "screenshot." + (state.shot.type.split("/")[1] || "png"));
    state.busy = true;
    sendBtn.disabled = true;
    sendBtn.textContent = "Sending…";
    fetch(reportUrl, { method: "POST", body: fd, credentials: "same-origin", headers: { "X-Requested-With": "fetch" } })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: "That didn't go through. Try again in a moment." }; }); })
      .then(function (j) {
        if (!j || !j.ok) { err((j && j.error) || "That didn't go through. Try again in a moment."); return; }
        sent(j);
        resetForm();
      })
      .catch(function () { err("That didn't go through: check your connection and try again."); })
      .then(function () { state.busy = false; sendBtn.disabled = false; sendBtn.textContent = "Send report"; });
  }

  function sent(j) {
    panel.querySelector("[data-hp-thanks]").textContent = (j.first ? "Thanks, " + j.first + "." : "Thanks.") + " We've got it.";
    var line = panel.querySelector("[data-hp-refline]");
    line.textContent = "";
    line.appendChild(document.createTextNode("Your reference is "));
    line.appendChild(el("strong", "hp-ref", j.ref));
    line.appendChild(document.createTextNode(j.copied ? ". A copy is on its way to your email." : ". Keep it: Group People's reply shows under Your reports here."));
    var ol = panel.querySelector("[data-hp-next]");
    ol.textContent = "";
    ["Group People's OneHR team will look at it.",
     "If they need more, they'll contact you, quoting " + j.ref + ".",
     "When it's sorted, their reply shows under Your reports here" + (j.copied ? ", and comes to your email." : ".")
    ].forEach(function (t) { ol.appendChild(el("li", null, t)); });
    renderMine(j.mine || []);
    show("sent");
  }

  /* ---- wiring ---- */
  function opener(e) {
    var t = e.target.closest && e.target.closest("[data-help-open]");
    if (!t) return false;
    e.preventDefault();
    var menu = document.getElementById("acct-menu"), trig = document.getElementById("acct-trigger");
    if (menu) menu.hidden = true;
    if (trig) trig.setAttribute("aria-expanded", "false");
    open(t.getAttribute("data-help-open") || "home", t.getAttribute("data-help-about"));
    return true;
  }
  // the account menu stops its clicks at its own edge (base.html's dropdowns), so its Help item has its own listener
  Array.prototype.forEach.call(document.querySelectorAll("#acct-menu [data-help-open]"), function (a) {
    a.addEventListener("click", opener);
  });
  document.addEventListener("click", function (e) {
    if (opener(e)) return;
    if (panel.hidden) return;
    var go = e.target.closest && e.target.closest("[data-hp-go]");
    if (go && panel.contains(go)) {
      if (go.hasAttribute("data-hp-fresh")) resetForm();
      show(go.getAttribute("data-hp-go"));
      return;
    }
    if (e.target.closest && e.target.closest("[data-hp-close]") && panel.contains(e.target)) { close(); return; }
  });
  if (dim) dim.addEventListener("click", close);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !panel.hidden) { e.preventDefault(); close(); }
  });
  detail.addEventListener("input", function () {
    countNow();
    if (detail.value.trim()) fieldErr("detail", false);
    missingNote();
  });
  aboutBox.addEventListener("change", function () { fieldErr("about", false); missingNote(); });
  sendBtn.addEventListener("click", send);
  form.addEventListener("submit", function (e) { e.preventDefault(); send(); });
  panel.querySelector("[data-hp-pick]").addEventListener("click", function () { fileIn.click(); });
  fileIn.addEventListener("change", function () { if (fileIn.files && fileIn.files[0]) setShot(fileIn.files[0]); });
  panel.querySelector("[data-hp-shotrm]").addEventListener("click", dropShot);
  panel.querySelector("[data-hp-key]").textContent = MAC ? "⌘V" : "Ctrl+V";
  // a screenshot pasted anywhere while the report is open (not text into the box: that stays text)
  document.addEventListener("paste", function (e) {
    if (panel.hidden || state.view !== "report") return;
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === "file" && /^image\//.test(items[i].type)) {
        var f = items[i].getAsFile();
        if (f) { e.preventDefault(); setShot(f); return; }
      }
    }
  });
  zone.addEventListener("dragover", function (e) { e.preventDefault(); zone.classList.add("is-over"); });
  zone.addEventListener("dragleave", function () { zone.classList.remove("is-over"); });
  zone.addEventListener("drop", function (e) {
    e.preventDefault(); zone.classList.remove("is-over");
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) setShot(f);
  });
  window.addEventListener("resize", function () { if (!panel.hidden) place(); });

  window.ohHelp = { open: open, close: close };
})();
