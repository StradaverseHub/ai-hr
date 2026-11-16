/* The conversational COMPETENCY (TM) agent's client.
 *
 * A plain chat: render the transcript, send the employee's message to
 * /review/competency/chat, append the agent's reply, show its quick-reply chips.
 * The SERVER decides everything -- the rating is a binary Demonstrate/Developing
 * the server validates and writes -- so this file computes nothing. It sends text,
 * paints bubbles, shows the pinned competency list, and posts the human Submit.
 *
 * A separate file from review_chat.js / setting_chat.js: competency is its own
 * conversation with a yes/no control grouped by category. Reuses the rv-* CSS.
 */
(function () {
  "use strict";
  var root = document.getElementById("rv-chat");
  if (!root) return;
  var log = document.getElementById("rv-chat-log");
  var pin = document.getElementById("rv-kpi-pin");
  var quick = document.getElementById("rv-chat-quick");
  var abilOpen = {};   // which items' ability folds are open, kept across re-renders
  var form = document.getElementById("rv-chat-form");
  var input = document.getElementById("rv-chat-input");
  var send = document.getElementById("rv-chat-send");
  var sendUrl = root.getAttribute("data-send-url");
  var histUrl = root.getAttribute("data-history-url");
  var submitUrl = root.getAttribute("data-submit-url");

  function token() {
    var m = document.querySelector('input[name="csrf_token"]');
    if (m) return m.value;
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute("content") : "";
  }

  var DASH = "—";

  function icon(inner) {
    return '<svg class="rv-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' +
      ' aria-hidden="true" focusable="false">' + inner + '</svg>';
  }
  var ICON = {
    eye: icon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'),
    eyeOff: icon('<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-8-10-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'),
    prev: icon('<polyline points="15 18 9 12 15 6"/>'),
    next: icon('<polyline points="9 18 15 12 9 6"/>')
  };

  function scrollToBottom() { log.scrollTop = log.scrollHeight; }
  function scrollSoon() {
    scrollToBottom();
    if (window.requestAnimationFrame) requestAnimationFrame(scrollToBottom);
    else setTimeout(scrollToBottom, 0);
  }
  function flashPin() {
    var el = tableEl || pin;
    if (!el) return;
    if (el.scrollIntoView) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el.classList.remove("rv-kpi-pin-flash");
    void el.offsetWidth;
    el.classList.add("rv-kpi-pin-flash");
  }
  var SHOW_RE = /\b(show|see|view|list|display|pull up|bring up|open|what(?:'?s| is| are))\b[^.?!]{0,30}\b(competenc|list|progress)/i;

  function bubble(role, text) {
    var d = document.createElement("div");
    d.className = "rv-msg rv-msg-" + (role === "user" ? "user" : "agent");
    d.textContent = text;
    log.appendChild(d);
    scrollToBottom();
    return d;
  }

  /* ---- the pinned competency list: a LIVE widget, grouped by category -------- *
   * Each competency with a Demonstrate / Developing control, rebuilt from the
   * server's `overview` payload every turn. Clicking a button composes a sentence
   * and sends it to the agent -- the server still validates + writes (one path).  */

  var LABEL = { yes: "Demonstrate", no: "Developing" };

  // The two-button rating control; on click it sends a sentence through the chat.
  function answerControl(it, editable) {
    var box = document.createElement("div"); box.className = "rv-tc-answer";
    if (!editable) {
      var s = document.createElement("span");
      s.className = "rv-tc-static" + (it.answer ? " rv-tc-is-" + it.answer : "");
      s.textContent = it.answer_label || DASH;
      box.appendChild(s);
      return box;
    }
    [["yes", "Demonstrate"], ["no", "Developing"]].forEach(function (pair) {
      var v = pair[0];
      var b = document.createElement("button");
      b.type = "button";
      b.className = "rv-tc-btn rv-tc-btn-" + v + (it.answer === v ? " rv-tc-on" : "");
      b.textContent = pair[1];
      b.addEventListener("click", function () {
        if (busy) return;
        var phrase = v === "yes"
          ? 'For "' + it.title + '", I demonstrate this.'
          : 'For "' + it.title + '", I\'m still developing this.';
        sendTurn(phrase);
      });
      box.appendChild(b);
    });
    return box;
  }

  // The KPI list can be expanded/minimized; the choice is remembered per browser.
  var tableOpen = true;
  try { tableOpen = localStorage.getItem("rv-tc-open") !== "0"; } catch (e) {}
  function paintToggle(tog) {
    tog.setAttribute("aria-expanded", tableOpen ? "true" : "false");
    tog.title = tableOpen ? "Hide the competency list" : "Show the competency list";
    tog.innerHTML = (tableOpen ? ICON.eye : ICON.eyeOff) +
      '<span class="rv-toggle-lbl">List</span>';
  }
  function setTableOpen(open) {
    tableOpen = !!open;
    try { localStorage.setItem("rv-tc-open", tableOpen ? "1" : "0"); } catch (e) {}
    if (tableEl) tableEl.hidden = !tableOpen;
    var tog = pin && pin.querySelector(".rv-table-toggle");
    if (tog) paintToggle(tog);
    syncLogInset();
  }

  // The slim summary line: "Answered X / N", a Draft / Submitted / Reviewed chip,
  // and the expand/minimize toggle.
  function buildStatusHeader(data) {
    var wrap = document.createElement("div"); wrap.className = "rv-status";
    var answered = (data && data.answered) || 0, total = (data && data.total) || 0;
    var done = total > 0 && answered >= total;
    var prog = document.createElement("div");
    prog.className = "rv-weight-total " + (done ? "rv-weight-ok" : "rv-weight-short");
    var pl = document.createElement("span"); pl.className = "rv-weight-lbl"; pl.textContent = "Answered";
    var pn = document.createElement("span"); pn.className = "rv-weight-num"; pn.textContent = answered + " / " + total;
    prog.appendChild(pl); prog.appendChild(pn); wrap.appendChild(prog);

    var now = document.createElement("span"); now.className = "rv-now";
    now.textContent = !total ? "No competencies assigned"
      : done ? "Ready to submit" : (total - answered) + " still to answer";
    wrap.appendChild(now);

    var st = data && data.status, chip = document.createElement("span");
    if (st === "reviewed") { chip.className = "rv-confirm-state rv-confirm-state-done"; chip.textContent = "Reviewed"; }
    else if (st === "submitted") { chip.className = "rv-confirm-state rv-confirm-state-done"; chip.textContent = "Submitted"; }
    else { chip.className = "rv-confirm-state rv-confirm-state-pending"; chip.textContent = "Draft"; }
    wrap.appendChild(chip);

    var right = document.createElement("div"); right.className = "rv-status-right";
    var tog = document.createElement("button");
    tog.type = "button"; tog.className = "rv-table-toggle"; paintToggle(tog);
    tog.addEventListener("click", function () { setTableOpen(!tableOpen); });
    right.appendChild(tog); wrap.appendChild(right);
    return wrap;
  }

  function th(text) { var el = document.createElement("th"); if (text) el.textContent = text; return el; }

  // The floating card shows ONE section (category) at a time, with prev/next in the
  // top-right corner (rv-tc-navbar). It FOLLOWS the conversation: when the agent moves
  // to a new section (data.focus_category), the card jumps there; otherwise the
  // person's manual paging is kept. Rebuilt each turn -- the yes/no control is buttons,
  // so nothing unsaved is lost.
  var tableEl = null, curSection = 0, lastFocusCat = null, lastData = null;

  function compRow(tr, it, ctx) {
    tr.innerHTML = "";
    tr.setAttribute("data-comp", it.assignment_id);
    var kc = document.createElement("td"); kc.className = "rv-kpi-cell";
    var nm = document.createElement("div"); nm.className = "rv-kpi-name"; nm.textContent = it.title; kc.appendChild(nm);
    var meta = [];
    if (it.level != null) meta.push("Level " + it.level);
    if (it.is_future) meta.push("stretch");
    if (meta.length) { var m = document.createElement("div"); m.className = "rv-kpi-meta"; m.textContent = meta.join(" · "); kc.appendChild(m); }
    if (it.detail) { var d = document.createElement("div"); d.className = "rv-kpi-desc"; d.textContent = it.detail; kc.appendChild(d); }
    // The ability items -- the behaviours that show this competency -- help the person
    // judge Demonstrate vs Developing. Informational; the rating stays per competency.
    var abil = it.ability_items || [];
    if (abil.length) {
      // three abilities, the rest behind "+N more" (Chris, 2026-10-27); kept open per item across re-renders
      var ul = document.createElement("ul"); ul.className = "rv-tc-abilities";
      var extra = abil.length - 3, fkey = String(it.assignment_id), more = null;
      var paintAbil = function () {
        var open_ = !!abilOpen[fkey];
        Array.prototype.forEach.call(ul.children, function (li, i) { li.hidden = !open_ && i >= 3; });
        if (more) { more.textContent = open_ ? "Show less" : "+" + extra + " more"; more.setAttribute("aria-expanded", open_ ? "true" : "false"); }
      };
      abil.forEach(function (x) { var li = document.createElement("li"); li.textContent = x; ul.appendChild(li); });
      kc.appendChild(ul);
      if (extra > 0) {
        more = document.createElement("button"); more.type = "button"; more.className = "rv-tc-more";
        more.addEventListener("click", function () { abilOpen[fkey] = !abilOpen[fkey]; paintAbil(); });
        kc.appendChild(more);
      }
      paintAbil();
    }
    tr.appendChild(kc);
    var ac = document.createElement("td"); ac.className = "rv-tc-answer-cell"; ac.appendChild(answerControl(it, ctx.editable)); tr.appendChild(ac);
  }

  function sectionIndexOf(groups, cat) {
    for (var i = 0; i < groups.length; i++) { if (groups[i].category === cat) return i; }
    return 0;
  }

  // The floating card for ONE section: a nav bar (category name + "(i of N)" left,
  // ◀ ▶ top-right) and that section's competency rows. The focus competency (the one
  // the agent is on) is highlighted.
  function buildSectionCard(data) {
    var groups = (data && data.groups) || [];
    if (!groups.length) return null;
    if (curSection >= groups.length) curSection = groups.length - 1;
    if (curSection < 0) curSection = 0;
    var g = groups[curSection];
    var focusId = data && data.focus_assignment_id;
    var editable = !!(data && data.editable);

    var wrap = document.createElement("div");
    wrap.className = "rv-card rv-kpi-overview rv-kpi-inline rv-set-table rv-tc-table";

    var bar = document.createElement("div"); bar.className = "rv-tc-navbar";
    var lbl = document.createElement("div"); lbl.className = "rv-tc-navlbl";
    var nm = document.createElement("span"); nm.className = "rv-tc-navname"; nm.textContent = g.category;
    var ct = document.createElement("span"); ct.className = "rv-tc-navcount";
    ct.textContent = "(" + (curSection + 1) + " of " + groups.length + ")";
    lbl.appendChild(nm); lbl.appendChild(ct); bar.appendChild(lbl);
    var nav = document.createElement("div"); nav.className = "rv-tc-nav";
    var prev = document.createElement("button"); prev.type = "button"; prev.className = "rv-tc-navbtn";
    prev.innerHTML = ICON.prev; prev.title = "Previous section"; prev.setAttribute("aria-label", "Previous section");
    prev.disabled = curSection <= 0;
    prev.addEventListener("click", function () { if (curSection > 0) { curSection--; rerenderSection(); } });
    var next = document.createElement("button"); next.type = "button"; next.className = "rv-tc-navbtn";
    next.innerHTML = ICON.next; next.title = "Next section"; next.setAttribute("aria-label", "Next section");
    next.disabled = curSection >= groups.length - 1;
    next.addEventListener("click", function () { if (curSection < groups.length - 1) { curSection++; rerenderSection(); } });
    nav.appendChild(prev); nav.appendChild(next); bar.appendChild(nav);
    wrap.appendChild(bar);

    var tbl = document.createElement("table"); tbl.className = "rv-scorecard rv-kpi-flat";
    var thead = document.createElement("thead"); var hr = document.createElement("tr");
    ["Competency", "Your rating"].forEach(function (h) { hr.appendChild(th(h)); });
    thead.appendChild(hr); tbl.appendChild(thead);
    var tb = document.createElement("tbody");
    (g.items || []).forEach(function (it) {
      var tr = document.createElement("tr"); compRow(tr, it, { editable: editable });
      if (focusId && it.assignment_id === focusId) tr.className = "rv-tc-focus";
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); wrap.appendChild(tbl);
    return wrap;
  }

  // Inset the log by the floating card's height WHILE the card is actually overlaying
  // (position:absolute), so the opening message isn't hidden under it; cleared on
  // mobile (static) / no card. Recomputed on each rerender and, debounced, on resize.
  function syncLogInset() {
    if (!log) return;
    var overlaying = tableEl && !tableEl.hidden &&
      getComputedStyle(tableEl).position === "absolute";
    log.style.paddingTop = overlaying
      ? (Math.round(tableEl.getBoundingClientRect().height) + 18) + "px" : "";
  }

  // Rebuild the floating section card in place (keeps the pinned header + the scroll).
  function rerenderSection() {
    if (!lastData) return;
    var fresh = buildSectionCard(lastData);
    if (!fresh) { if (tableEl) { tableEl.remove(); tableEl = null; } syncLogInset(); return; }
    if (tableEl && tableEl.parentNode) tableEl.parentNode.replaceChild(fresh, tableEl);
    else root.insertBefore(fresh, root.firstChild);
    tableEl = fresh; tableEl.hidden = !tableOpen;
    syncLogInset();
  }

  function refreshOverview(data) {
    if (!pin) return;
    // ABSENT is not EMPTY: a degraded turn ("I lost the thread") returns no overview;
    // ignoring undefined keeps the pinned list on screen. null still clears.
    if (data === undefined) return;
    lastData = data;
    if (!data) { pin.innerHTML = ""; if (tableEl) { tableEl.remove(); tableEl = null; } syncLogInset(); return; }
    pin.innerHTML = "";
    pin.appendChild(buildStatusHeader(data));
    var groups = data.groups || [];
    if (!groups.length) { if (tableEl) { tableEl.remove(); tableEl = null; } syncLogInset(); return; }
    // Follow the conversation: jump to the focus section when it moves (only while there
    // is a live focus -- once all answered, keep the person where they are).
    if (data.focus_assignment_id && data.focus_category && data.focus_category !== lastFocusCat) {
      curSection = sectionIndexOf(groups, data.focus_category);
    }
    lastFocusCat = data.focus_category;
    var first = !tableEl;
    rerenderSection();
    if (first) scrollSoon();
  }

  // The read-only competency snapshot for the submit card (grouped, name + answer).
  function snapshotTable(d) {
    var frag = document.createDocumentFragment();
    var tbl = document.createElement("table"); tbl.className = "rv-scorecard rv-kpi-flat";
    var thead = document.createElement("thead"); var hr = document.createElement("tr");
    ["Competency", "Your rating"].forEach(function (h) { hr.appendChild(th(h)); });
    thead.appendChild(hr); tbl.appendChild(thead);
    var tb = document.createElement("tbody");
    ((d && d.groups) || []).forEach(function (g) {
      var ctr = document.createElement("tr"); ctr.className = "rv-tc-cat";
      var ctd = document.createElement("td"); ctd.colSpan = 2; ctd.textContent = g.category; ctr.appendChild(ctd);
      tb.appendChild(ctr);
      (g.items || []).forEach(function (it) {
        var tr = document.createElement("tr");
        var kc = document.createElement("td"); kc.className = "rv-kpi-cell";
        var nm = document.createElement("div"); nm.className = "rv-kpi-name"; nm.textContent = it.title; kc.appendChild(nm);
        tr.appendChild(kc);
        var ac = document.createElement("td");
        var s = document.createElement("span");
        s.className = "rv-tc-static" + (it.answer ? " rv-tc-is-" + it.answer : "");
        s.textContent = it.answer_label || DASH; ac.appendChild(s);
        tr.appendChild(ac); tb.appendChild(tr);
      });
    });
    tbl.appendChild(tb); frag.appendChild(tbl);
    var o = document.createElement("div"); o.className = "rv-scorecard-overall";
    o.textContent = "Answered " + ((d && d.answered) || 0) + " / " + ((d && d.total) || 0);
    frag.appendChild(o);
    return frag;
  }

  // The final SUBMIT card: a warning, the competency snapshot, and a single
  // "Submit for review" button (no "Not yet" -- to change anything, keep chatting).
  function buildSubmitCard(d) {
    var wrap = document.createElement("div");
    wrap.className = "rv-msg rv-msg-agent rv-card rv-confirm";
    var warn = document.createElement("div"); warn.className = "rv-confirm-warn";
    warn.textContent = "Once you submit, your self-assessment goes to your manager to review "
      + "and you can't change it while it's being reviewed.";
    wrap.appendChild(warn);
    var h = document.createElement("div"); h.className = "rv-confirm-head";
    h.textContent = "Your competencies"; wrap.appendChild(h);
    wrap.appendChild(snapshotTable(d));
    var actions = document.createElement("div"); actions.className = "rv-confirm-actions";
    var yes = document.createElement("button"); yes.type = "button";
    yes.className = "rv-confirm-yes"; yes.textContent = "Submit for review";
    yes.addEventListener("click", function () { doSubmit(yes, wrap); });
    actions.appendChild(yes); wrap.appendChild(actions);
    return wrap;
  }

  function doSubmit(btn, wrap) {
    btn.disabled = true;
    var f = new FormData(); f.append("csrf_token", token());
    fetch(submitUrl, { method: "POST", body: f, credentials: "same-origin" })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (j && j.ok && j.submitted) {
          var a = wrap.querySelector(".rv-confirm-actions"); if (a) a.remove();
          wrap.classList.add("rv-confirm-done");
          bubble("agent", "Submitted — your self-assessment is now with your manager to review.");
          if (j.overview) refreshOverview(j.overview);
          scrollSoon();
        } else {
          btn.disabled = false;
          bubble("agent", (j && j.error) || "Couldn't submit — please try again.");
        }
      })
      .catch(function () { btn.disabled = false; bubble("agent", "Couldn't submit — please try again."); });
  }

  // The reflection DRAFT card (the "Draft with AI" aid): the agent's composed draft (or an
  // already-saved reflection) shown with the EXACT text -- always SEEN, never just narrated.
  // Save posts to /review/competency/note (the deterministic write); Tweak is a dropdown of redraft
  // intents. Mirrors the journey's competencyDraftCard.
  var TWEAK_OPTS = [
    ["Make it a bit longer using only what I've told you -- ask me if you need more detail.", "Longer"],
    ["Make it shorter and more concise.", "Shorter"],
    ["Ask me a few questions to strengthen it.", "Ask me questions"],
    ["Refine the wording for clarity.", "Refine clarity"],
    ["Make the tone more formal.", "More formal"]
  ];
  function tweakSelect(isDraft) {
    var sel = document.createElement("select");
    sel.className = "modern-select rv-tweak-select";
    var ph = document.createElement("option");
    ph.value = ""; ph.textContent = isDraft ? "Tweak…" : "Redraft…";
    ph.disabled = true; ph.selected = true;
    sel.appendChild(ph);
    TWEAK_OPTS.forEach(function (o) {
      var op = document.createElement("option"); op.value = o[0]; op.textContent = o[1];
      sel.appendChild(op);
    });
    sel.addEventListener("change", function () {
      var v = sel.value; sel.selectedIndex = 0;
      if (v && !busy) sendTurn(v);
    });
    return sel;
  }

  function reflectionCard(d) {
    d = d || {};
    var wrap = document.createElement("div");
    wrap.className = "rv-msg rv-msg-agent rv-card rv-confirm";
    var h = document.createElement("div"); h.className = "rv-confirm-head";
    h.textContent = (d.is_draft ? "Proposed remark — " : "Your saved remark — ") + (d.competency || "");
    wrap.appendChild(h);
    var body = document.createElement("div"); body.className = "rv-reflection-text";
    body.textContent = d.text || ""; wrap.appendChild(body);
    if (d.is_draft) {
      var actions = document.createElement("div"); actions.className = "rv-confirm-actions";
      var save = document.createElement("button"); save.type = "button"; save.className = "rv-confirm-yes";
      save.textContent = "Save remark";
      save.addEventListener("click", function () { saveReflection(d, save, wrap); });
      actions.appendChild(save);
      actions.appendChild(tweakSelect(d.is_draft));
      wrap.appendChild(actions);
    } else { wrap.classList.add("rv-confirm-done"); }  // saved -> no live Save/Redraft, matches confirm-card done-replay
    return wrap;
  }

  function saveReflection(d, btn, wrap) {
    btn.disabled = true;
    var f = new FormData(); f.append("csrf_token", token());
    f.append("assignment_id", d.assignment_id); f.append("text", d.text || "");
    fetch("/review/competency/note", { method: "POST", body: f, credentials: "same-origin" })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (j && j.ok) {
          var a = wrap.querySelector(".rv-confirm-actions"); if (a) a.remove();
          wrap.classList.add("rv-confirm-done");
          if (j.overview) refreshOverview(j.overview);
          // Continue the walk: a follow-up turn so the agent acknowledges it and moves on (the
          // next competency needing a reason, or submit) instead of dead-ending. after_save steers
          // the server not to re-draft the reflection just saved.
          sendTurn("", true, { after_save: d.assignment_id });
        } else {
          btn.disabled = false;
          bubble("agent", (j && j.error) || "Couldn't save — please try again.");
        }
      })
      .catch(function () { btn.disabled = false; bubble("agent", "Couldn't save — please try again."); });
  }

  function renderCard(card, saved) {
    if (!card) return;
    if (card.type === "competency_confirm") {
      log.appendChild(buildSubmitCard(card.data || {})); scrollSoon(); return;
    }
    // The reflection draft card. On the REPLAY path (saved map passed), if this reflection is
    // already saved, render the card's "saved" mode (is_draft:false -> no armed Save button, a
    // Redraft chip) with the saved text; an UNSAVED draft stays saveable. Live turns pass no map.
    if (card.type === "competency_reflection_draft") {
      var d = card.data || {};
      var s = saved && saved[d.assignment_id];
      var dd = s ? Object.assign({}, d, { is_draft: false, text: s }) : d;
      log.appendChild(reflectionCard(dd)); scrollSoon(); return;
    }
    if (card.type !== "competency_progress") return;
    var wrap = document.createElement("div");
    wrap.className = "rv-msg rv-msg-agent rv-card";
    wrap.appendChild(snapshotTable(card.data || {}));
    log.appendChild(wrap); log.scrollTop = log.scrollHeight;
  }

  function setQuick(items) {
    quick.innerHTML = "";
    (items || []).forEach(function (t) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "rv-chip"; b.textContent = t;
      b.addEventListener("click", function () { sendTurn(t); });
      quick.appendChild(b);
    });
  }

  var busy = false;
  function sendTurn(explicit, force, extra) {
    if (busy) return;
    if (winClosed) { bubble("agent", winClosed); scrollSoon(); return; }
    var fromInput = (explicit === undefined);
    var msg = fromInput ? (input.value || "").trim() : String(explicit);
    if (!msg && !force && log.querySelector(".rv-msg")) return;
    if (msg) bubble("user", msg);
    if (fromInput) { input.value = ""; input.style.height = ""; }
    setQuick([]);
    busy = true;
    send_btn_disabled(true);
    var typing = bubble("agent", "…");
    typing.classList.add("rv-typing");
    var f = new FormData();
    f.append("csrf_token", token());
    f.append("message", msg);
    // Optional per-turn hints (e.g. after_save on the forced follow-up right after a reflection
    // Save, so the server steers the agent to acknowledge it and move on rather than re-draft it).
    if (extra) { Object.keys(extra).forEach(function (k) { if (extra[k] != null) f.append(k, extra[k]); }); }
    fetch(sendUrl, { method: "POST", body: f, credentials: "same-origin" })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        typing.remove();
        if (j && j.say) bubble("agent", j.say);
        if (j && j.window_closed) lockClosed(j.window_note);
        (j && j.renders || []).forEach(function (c) { renderCard(c); });   // never pass forEach's index as `saved`
        refreshOverview(j && j.overview);
        setQuick(j && j.quick_replies);
        if (j && j.rail_html) swapRail(j.rail_html);
        if (SHOW_RE.test(msg)) flashPin();
        scrollSoon();
      })
      .catch(function () { typing.remove(); bubble("agent", "(connection lost — try again)"); })
      .then(function () { busy = false; send_btn_disabled(false); });
  }

  function send_btn_disabled(v) { send.disabled = v || !!winClosed; }
  // A closed part (its window on the admin's Calendar; Chris, 2026-10-20): the box takes nothing more and the
  // conversation stays to read. The server refuses a message that still arrives (window_closed in its reply).
  var winClosed = root.getAttribute("data-window-closed") || null;
  function lockClosed(note) {
    winClosed = note || winClosed || "This part is closed.";
    input.value = ""; input.disabled = true; send.disabled = true; input.placeholder = winClosed;
    setQuick([]);
  }

  function swapRail(html) {
    var old = document.querySelector(".rv-rail");
    if (!old) return;
    var tmp = document.createElement("div");
    tmp.innerHTML = html;
    var fresh = tmp.querySelector(".rv-rail");
    if (fresh) old.replaceWith(fresh);
  }

  form.addEventListener("submit", function (e) { e.preventDefault(); sendTurn(); });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTurn(); }
  });
  input.addEventListener("input", function () {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  });
  // Recompute the log inset on resize (the card overlays only above the mobile
  // breakpoint, so a desktop-width inset must not survive into the mobile layout).
  var _insetTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(_insetTimer);
    _insetTimer = setTimeout(syncLogInset, 120);
  });

  fetch(histUrl, { credentials: "same-origin" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (!j) return;
      var msgs = j.messages || [];
      msgs.forEach(function (m) {
        bubble(m.role, m.content);
        // Pass the saved-reflections map so a replayed draft card renders as saved (no armed Save).
        (m.card || []).forEach(function (c) { renderCard(c, j.competency_reflections); });
      });
      if (msgs.length) refreshOverview(j.overview);
      var last = msgs[msgs.length - 1];
      if (last && last.role === "agent" && last.quick_replies) setQuick(last.quick_replies);
      scrollSoon();
      if (winClosed) {   // closed: no opening turn, the box locked
        if (!msgs.length) bubble("agent", winClosed + " You can still look through it.");
        lockClosed(winClosed);
        return;
      }
      if (root.getAttribute("data-unavailable")) {
        if (!msgs.length) {
          bubble("agent", "The competency assistant isn't switched on yet — ask your admin to enable it.");
        }
        input.disabled = true; send.disabled = true;
        return;
      }
      if (!msgs.length) sendTurn();
    });
})();
