/* The guided review's only client-side code.
 *
 * THE CLIENT NEVER DECIDES WHAT COMES NEXT -- IT ASKS. Saving posts to the
 * module's own autosave route, and then this re-fetches /review/account/turn so
 * the SERVER recomputes review_state() and renders whatever follows.
 *
 * No percentage and no score is ever computed here. A second scoring
 * implementation in the browser would be a second source of truth about the
 * number, which is the same failure as a second source of truth about "done".
 */
(function () {
  "use strict";
  var slot = document.getElementById("rv-turn-slot");
  if (!slot) return;
  var turnUrl = slot.getAttribute("data-turn-url");

  function token() {
    var m = document.querySelector('input[name="csrf_token"]');
    if (m) return m.value;
    // The review pages carry no form, so fall back to base.html's meta tag --
    // without this every browser write (save, check-in, evidence) posts an empty
    // token and the app answers 400.
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute("content") : "";
  }

  function refresh(justId) {
    // Replace, never append. Two tabs, or the back button, and an appended turn
    // would show a question the database has already moved past.
    // Tell the server WHICH line was just saved so it can acknowledge it. It
    // never tells the server what the number means -- that is computed there.
    var u = justId ? (turnUrl + "?just=" + encodeURIComponent(justId)) : turnUrl;
    return fetch(u, { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (html) { if (html !== null) { slot.innerHTML = html; swapSays(); } });
  }

  // AI-worded agent. The turn ALWAYS renders the deterministic phrasebook line
  // first; when the AI is on (data-ai-review), swap each [data-say] line for a
  // reworded version fetched from /review/say. The FLOW never waits on the model
  // -- a slow/absent/over-quota model just leaves the phrasebook line in place.
  function swapSays() {
    if (!slot.getAttribute("data-ai-review")) return;
    var sayUrl = slot.getAttribute("data-say-url");
    if (!sayUrl) return;
    Array.prototype.forEach.call(slot.querySelectorAll("[data-say]"), function (el) {
      if (el.getAttribute("data-said")) return;   // once per line
      el.setAttribute("data-said", "1");
      var t = (el.textContent || "").trim();
      if (!t) return;
      fetch(sayUrl + "?t=" + encodeURIComponent(t), { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (j && j.ok && j.text) el.textContent = j.text; })
        .catch(function () {});
    });
  }

  slot.addEventListener("click", function (ev) {
    // --- the check-in chips ------------------------------------------------
    var chip = ev.target.closest("[data-checkin]");
    if (chip) {
      var card = chip.closest(".rv-kpi");
      var noteBox = card && card.querySelector(".rv-note");
      var f = new FormData();
      f.append("csrf_token", token());
      f.append("kpi_target_id", chip.getAttribute("data-checkin"));
      f.append("answer", chip.getAttribute("data-answer"));
      // Only sent when the person actually typed something: absent means
      // UNCHANGED on the server, which is the rule df38274 established.
      if (noteBox && noteBox.value.trim()) f.append("note", noteBox.value.trim());
      Array.prototype.forEach.call(card.querySelectorAll("[data-checkin]"),
        function (b) { b.disabled = true; });
      fetch(chip.getAttribute("data-url"),
            { method: "POST", body: f, credentials: "same-origin" })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) {
          if (j && j.ok === false) {
            Array.prototype.forEach.call(card.querySelectorAll("[data-checkin]"),
              function (b) { b.disabled = false; });
            evMsg(card, j.error);
            return;
          }
          return refresh();
        });
      return;
    }

    var btn = ev.target.closest("[data-save-kpi]");
    if (!btn) return;
    var card = btn.closest(".rv-kpi");
    var box = card && card.querySelector(".rv-actual");
    if (!box) return;
    var val = (box.value || "").trim();
    if (!val) { box.focus(); return; }
    btn.disabled = true;
    var body = new FormData();
    body.append("csrf_token", token());
    body.append("actual_value", val);
    // `note` is deliberately NOT sent. The server treats an absent field as
    // UNCHANGED (df38274) -- sending an empty one would wipe a note the person
    // wrote on /performance.
    fetch(btn.getAttribute("data-url"), {
      method: "POST", body: body, credentials: "same-origin"
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (j && j.ok === false) { btn.disabled = false; return; }
        return refresh(btn.getAttribute("data-save-kpi"));
      })
      .catch(function () { btn.disabled = false; });
  });
  // The reason a note was refused (the screen on stored text, 4-03), shown under the box it came from.
  function evMsg(box, text) {
    if (!box || !text) return;
    var m = box.querySelector(".rv-ev-err");
    if (!m) { m = document.createElement("p"); m.className = "rv-ev-err muted small"; m.setAttribute("role", "alert"); box.appendChild(m); }
    m.textContent = text;
  }
  // --- the KPI overview picker + the compliment/evidence prompt -----------
  // The client chooses WHICH kpi (?pick=) or submits a compliment, then asks
  // the server for the next turn. It never decides what comes next itself.
  slot.addEventListener("click", function (ev) {
    var pick = ev.target.closest("[data-pick]");
    if (pick) {
      Array.prototype.forEach.call(slot.querySelectorAll("[data-pick]"),
        function (b) { b.disabled = true; });
      fetch(turnUrl + "?pick=" + encodeURIComponent(pick.getAttribute("data-pick")),
            { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.text() : null; })
        .then(function (html) { if (html !== null) { slot.innerHTML = html; swapSays(); } });
      return;
    }
    var save = ev.target.closest("[data-ev-save]");
    if (save) {
      var box = save.closest(".rv-evprompt");
      var ta = box && box.querySelector(".rv-evbody");
      if (!ta || !ta.value.trim()) { if (ta) ta.focus(); return; }
      save.disabled = true;
      var f = new FormData();
      f.append("csrf_token", token());
      f.append("body", ta.value.trim());
      if (box.getAttribute("data-kpi")) f.append("kpi_target_id", box.getAttribute("data-kpi"));
      fetch(box.getAttribute("data-url"), { method: "POST", body: f, credentials: "same-origin" })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) {
          if (j && j.ok === false) { save.disabled = false; evMsg(box, j.error); return; }
          return refresh();
        })
        .catch(function () { save.disabled = false; });
      return;
    }
    if (ev.target.closest("[data-ev-skip]")) { refresh(); return; }
  });

  // --- the cite turn -------------------------------------------------------
  // A ticked box becomes a real citation through /evidence/<id>/link -- the
  // human-confirmed writer. Nothing here writes on its own; the AI only
  // pre-ticks a suggestion, which is exactly a box the person can untick.
  slot.addEventListener("change", function (ev) {
    var cb = ev.target.closest(".rv-cite-item input[type=checkbox]");
    if (!cb || cb.dataset.evid === undefined) return;
    var kpiWrap = cb.closest("[data-kpi]");
    var kpiId = kpiWrap ? kpiWrap.getAttribute("data-kpi") : "";
    var f = new FormData();
    f.append("csrf_token", token());
    f.append("target_kind", "kpi");
    f.append("target_ref", kpiId);
    cb.disabled = true;
    fetch(cb.getAttribute(cb.checked ? "data-link" : "data-unlink"),
          { method: "POST", body: f, credentials: "same-origin" })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) { if (j && j.ok === false) cb.checked = !cb.checked; })
      .catch(function () { cb.checked = !cb.checked; })
      .then(function () { cb.disabled = false; });
  });

  // Pre-tick: a SEPARATE fetch when a KPI's cite list is opened -- never on the
  // turn render, so a slow or absent model degrades this one control and
  // nothing else. AI off/down -> [] -> nothing pre-ticked -> manual.
  slot.addEventListener("toggle", function (ev) {
    var det = ev.target.closest("[data-suggest-url]");
    if (!det || !det.open || det.dataset.suggested) return;
    det.dataset.suggested = "1";   // once per open cite list
    fetch(det.getAttribute("data-suggest-url"), { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (j) {
        (j && j.suggested || []).forEach(function (eid) {
          var cb = det.querySelector('input[data-evid="' + eid + '"]');
          // Suggest only; never link on the person's behalf. An unchecked box
          // the model likes is marked, not ticked -- confirming is their act.
          if (cb && !cb.checked) cb.closest(".rv-cite-item").classList.add("rv-suggested");
        });
      }).catch(function () {});
  }, true);

  swapSays();   // reword the first turn if the AI is on

  // --- the on-demand brief -------------------------------------------------
  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-brief-url]");
    if (!btn) return;
    var out = document.getElementById(btn.getAttribute("data-brief-target"));
    if (!out) return;
    btn.disabled = true;
    fetch(btn.getAttribute("data-brief-url"), { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (html) { if (html !== null) out.innerHTML = html; })
      .then(function () { btn.disabled = false; });
  });
})();

/* Phase B step 2 -- the manager's review surface (/review/team/<id>).
 *
 * Endorse or dispute the subject's items, and record what the manager saw.
 * A separate IIFE because the turn-slot code above returns early on any page
 * without #rv-turn-slot, and this page has none. Everything it posts lands on
 * the SUBJECT's record and is visible to them -- there is no private path here.
 */
(function () {
  "use strict";
  // The reason a note was refused (the screen on stored text, 4-03), shown beside the button it came from.
  function evMsg(box, text) {
    if (!box || !text) return;
    var m = box.querySelector(".rv-ev-err");
    if (!m) { m = document.createElement("p"); m.className = "rv-ev-err muted small"; m.setAttribute("role", "alert"); box.appendChild(m); }
    m.textContent = text;
  }
  var pack = document.getElementById("rv-team-pack");
  var noteBtn = document.getElementById("rv-note-save");
  if (!pack && !noteBtn) return;

  function token() {
    var m = document.querySelector('input[name="csrf_token"]');
    if (m) return m.value;
    // The review pages carry no form, so fall back to base.html's meta tag --
    // without this every browser write (save, check-in, evidence) posts an empty
    // token and the app answers 400.
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute("content") : "";
  }

  // --- endorse / dispute ---------------------------------------------------
  if (pack) {
    pack.addEventListener("click", function (ev) {
      var btn = ev.target.closest("[data-review]");
      if (!btn) return;
      var group = btn.parentNode;
      var f = new FormData();
      f.append("csrf_token", token());
      f.append("verdict", btn.getAttribute("data-verdict"));
      Array.prototype.forEach.call(group.querySelectorAll("[data-review]"),
        function (b) { b.disabled = true; });
      fetch(btn.getAttribute("data-url"),
            { method: "POST", body: f, credentials: "same-origin" })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) {
          if (j && j.ok) {
            // The verdict is on the record now; reflect it and let the reload
            // (or next visit) render the authoritative reviewer line.
            btn.classList.add("rv-chip-done");
            Array.prototype.forEach.call(group.querySelectorAll("[data-review]"),
              function (b) { b.classList.toggle("rv-chip-on", b === btn); });
          }
        })
        .then(function () {
          Array.prototype.forEach.call(group.querySelectorAll("[data-review]"),
            function (b) { b.disabled = false; });
        });
    });
  }

  // --- record what the manager saw ----------------------------------------
  if (noteBtn) {
    noteBtn.addEventListener("click", function () {
      var body = document.getElementById("rv-note-body");
      var raised = document.getElementById("rv-note-raised");
      if (!body || !body.value.trim()) { if (body) body.focus(); return; }
      var f = new FormData();
      f.append("csrf_token", token());
      f.append("body", body.value.trim());
      f.append("kind", "behaviour");
      if (raised) f.append("raised_with_subject", raised.value);
      noteBtn.disabled = true;
      fetch(noteBtn.getAttribute("data-url"),
            { method: "POST", body: f, credentials: "same-origin" })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) {
          if (j && j.ok) { window.location.reload(); }
          else { noteBtn.disabled = false; evMsg(noteBtn.parentNode, j && j.error); }
        })
        .catch(function () { noteBtn.disabled = false; });
    });
  }
})();
