/* The conversational CAREER (IDP) agent's client -- the career profile.
 *
 * A plain chat: render the transcript, send the employee's message to
 * /review/career/chat, append the agent's reply, show its quick-reply chips.
 * The SERVER validates and writes every field, so this file computes nothing.
 *
 * NO SUBMIT anywhere, deliberately: the profile has no status and no approval
 * gate, so there is no confirm card, no Share button and no submitUrl. That is
 * the one structural difference from ahead_chat.js / competency_chat.js.
 *
 * Reuses the rv-* CSS.
 */
(function () {
  "use strict";
  var root = document.getElementById("rv-chat");
  if (!root) return;
  var log = document.getElementById("rv-chat-log");
  var pin = document.getElementById("rv-kpi-pin");
  var quick = document.getElementById("rv-chat-quick");
  var form = document.getElementById("rv-chat-form");
  var input = document.getElementById("rv-chat-input");
  var send = document.getElementById("rv-chat-send");
  var sendUrl = root.getAttribute("data-send-url");
  var histUrl = root.getAttribute("data-history-url");

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
  var SHOW_RE = /\b(show|see|view|list|display|pull up|bring up|open|what(?:'?s| is| are))\b[^.?!]{0,30}\b(profile|career|answers)/i;

  function bubble(role, text) {
    var d = document.createElement("div");
    d.className = "rv-msg rv-msg-" + (role === "user" ? "user" : "agent");
    d.textContent = text;
    log.appendChild(d);
    scrollToBottom();
    return d;
  }

  /* ---- the pinned profile: a LIVE widget, ONE SECTION at a time ------------- *
   * Aspirations / mobility / what you bring. A field with no answer offers a chip
   * that asks the agent about it; mobility offers its controlled choices. Every
   * chip composes a sentence and sends it -- the server still validates + writes. */

  var tableOpen = true;
  try { tableOpen = localStorage.getItem("rv-career-open") !== "0"; } catch (e) {}
  function paintToggle(tog) {
    tog.setAttribute("aria-expanded", tableOpen ? "true" : "false");
    tog.title = tableOpen ? "Hide the profile" : "Show the profile";
    tog.innerHTML = (tableOpen ? ICON.eye : ICON.eyeOff) +
      '<span class="rv-toggle-lbl">Profile</span>';
  }
  function setTableOpen(open) {
    tableOpen = !!open;
    try { localStorage.setItem("rv-career-open", tableOpen ? "1" : "0"); } catch (e) {}
    if (tableEl) tableEl.hidden = !tableOpen;
    syncLogInset();
    var tog = pin && pin.querySelector(".rv-table-toggle");
    if (tog) paintToggle(tog);
  }

  // The slim summary line. The chip says whether HR's two required answers have
  // landed -- NOT "submitted", because nothing here is ever submitted.
  function buildStatusHeader(data) {
    var wrap = document.createElement("div"); wrap.className = "rv-status";
    var answered = (data && data.answered) || 0, total = (data && data.total) || 0;
    var complete = !!(data && data.complete);
    var prog = document.createElement("div");
    prog.className = "rv-weight-total " + (complete ? "rv-weight-ok" : "rv-weight-short");
    var pl = document.createElement("span"); pl.className = "rv-weight-lbl"; pl.textContent = "Answered";
    var pn = document.createElement("span"); pn.className = "rv-weight-num"; pn.textContent = answered + " / " + total;
    prog.appendChild(pl); prog.appendChild(pn); wrap.appendChild(prog);

    var now = document.createElement("span"); now.className = "rv-now";
    now.textContent = complete ? "Nothing outstanding — add more whenever you like"
                               : "Your document — nothing is submitted";
    wrap.appendChild(now);

    var chip = document.createElement("span");
    chip.className = "rv-confirm-state " + (complete ? "rv-confirm-state-done" : "rv-confirm-state-pending");
    chip.textContent = complete ? "Complete" : "In progress";
    wrap.appendChild(chip);

    var right = document.createElement("div"); right.className = "rv-status-right";
    var tog = document.createElement("button");
    tog.type = "button"; tog.className = "rv-table-toggle"; paintToggle(tog);
    tog.addEventListener("click", function () { setTableOpen(!tableOpen); });
    right.appendChild(tog); wrap.appendChild(right);
    return wrap;
  }

  function th(text) { var el = document.createElement("th"); if (text) el.textContent = text; return el; }

  var tableEl = null, curSection = 0, lastFocusSection = null, lastData = null;

  function sectionIndexOf(sections, key) {
    for (var i = 0; i < sections.length; i++) { if (sections[i].key === key) return i; }
    return 0;
  }

  function fieldRow(tb, it, focusField) {
    var tr = document.createElement("tr");
    if (focusField && it.field === focusField) tr.className = "rv-tc-focus";
    var lc = document.createElement("td"); lc.className = "rv-kpi-cell";
    var nm = document.createElement("div"); nm.className = "rv-kpi-name"; nm.textContent = it.label;
    lc.appendChild(nm);
    if (it.hint) { var h = document.createElement("div"); h.className = "rv-kpi-meta"; h.textContent = it.hint; lc.appendChild(h); }
    tr.appendChild(lc);
    var vc = document.createElement("td");
    if (it.answered) {
      var d = document.createElement("div"); d.className = "rv-kpi-desc"; d.textContent = it.value; vc.appendChild(d);
    } else if (it.choices) {
      // Mobility is the one controlled answer: offer its options, in their words.
      it.choices.forEach(function (c) {
        var b = document.createElement("button"); b.type = "button"; b.className = "rv-chip rv-lib-add";
        b.textContent = c.label;
        b.addEventListener("click", function () { if (!busy) sendTurn(c.label + "."); });
        vc.appendChild(b);
      });
    } else {
      var b2 = document.createElement("button"); b2.type = "button"; b2.className = "rv-chip rv-lib-add";
      b2.textContent = "Answer this";
      b2.addEventListener("click", function () {
        if (!busy) sendTurn('Ask me about "' + it.label + '".');
      });
      vc.appendChild(b2);
    }
    tr.appendChild(vc); tb.appendChild(tr);
  }

  function buildSectionCard(data) {
    var sections = (data && data.sections) || [];
    if (!sections.length) return null;
    if (curSection >= sections.length) curSection = sections.length - 1;
    if (curSection < 0) curSection = 0;
    var sec = sections[curSection];

    var wrap = document.createElement("div");
    wrap.className = "rv-card rv-kpi-overview rv-kpi-inline rv-set-table rv-tc-table";

    var bar = document.createElement("div"); bar.className = "rv-tc-navbar";
    var lbl = document.createElement("div"); lbl.className = "rv-tc-navlbl";
    var nm = document.createElement("span"); nm.className = "rv-tc-navname"; nm.textContent = sec.label;
    var ct = document.createElement("span"); ct.className = "rv-tc-navcount";
    ct.textContent = "(" + (curSection + 1) + " of " + sections.length + ")";
    lbl.appendChild(nm); lbl.appendChild(ct); bar.appendChild(lbl);
    var nav = document.createElement("div"); nav.className = "rv-tc-nav";
    var prev = document.createElement("button"); prev.type = "button"; prev.className = "rv-tc-navbtn";
    prev.innerHTML = ICON.prev; prev.title = "Previous section"; prev.setAttribute("aria-label", "Previous section");
    prev.disabled = curSection <= 0;
    prev.addEventListener("click", function () { if (curSection > 0) { curSection--; rerenderSection(); } });
    var next = document.createElement("button"); next.type = "button"; next.className = "rv-tc-navbtn";
    next.innerHTML = ICON.next; next.title = "Next section"; next.setAttribute("aria-label", "Next section");
    next.disabled = curSection >= sections.length - 1;
    next.addEventListener("click", function () { if (curSection < sections.length - 1) { curSection++; rerenderSection(); } });
    nav.appendChild(prev); nav.appendChild(next); bar.appendChild(nav);
    wrap.appendChild(bar);

    var tbl = document.createElement("table"); tbl.className = "rv-scorecard rv-kpi-flat";
    var thead = document.createElement("thead"); var hr = document.createElement("tr");
    ["", "Your answer"].forEach(function (h) { hr.appendChild(th(h)); });
    thead.appendChild(hr); tbl.appendChild(thead);
    var tb = document.createElement("tbody");
    (sec.items || []).forEach(function (it) { fieldRow(tb, it, data && data.focus_field); });
    tbl.appendChild(tb); wrap.appendChild(tbl);
    return wrap;
  }

  // The floating card is position:absolute over the top of the log (style.css
  // .rv-kpi-inline), so with only an opening message there is nothing to scroll
  // and that message sits UNDER the card, invisible. Inset the log by the card's
  // height so the conversation starts below it. Only while the card really is
  // overlaying: the mobile breakpoint makes it position:static and flow normally,
  // where an inset would just be a gap.
  function syncLogInset() {
    if (!log) return;
    var overlaying = tableEl && !tableEl.hidden &&
      getComputedStyle(tableEl).position === "absolute";
    log.style.paddingTop = overlaying
      ? (Math.round(tableEl.getBoundingClientRect().height) + 18) + "px" : "";
  }

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
    // ABSENT is not EMPTY. A degraded turn ("I lost the thread there") returns no
    // overview key at all; treating that as "nothing to show" wiped the pinned
    // profile and the floating card off the screen on a transient model hiccup.
    // null still means genuinely nothing and still clears.
    if (data === undefined) return;
    lastData = data;
    if (!data) { pin.innerHTML = ""; if (tableEl) { tableEl.remove(); tableEl = null; } syncLogInset(); return; }
    pin.innerHTML = "";
    pin.appendChild(buildStatusHeader(data));
    var sections = data.sections || [];
    if (!sections.length) { if (tableEl) { tableEl.remove(); tableEl = null; } return; }
    // Follow the conversation: jump to the focus section when it moves.
    if (data.focus_section && data.focus_section !== lastFocusSection) {
      curSection = sectionIndexOf(sections, data.focus_section);
    }
    lastFocusSection = data.focus_section;
    var first = !tableEl;
    rerenderSection();
    if (first) scrollSoon();
  }

  // The read-only profile snapshot, for show_profile{}.
  function snapshotTable(d) {
    var frag = document.createDocumentFragment();
    var tbl = document.createElement("table"); tbl.className = "rv-scorecard rv-kpi-flat";
    var tb = document.createElement("tbody");
    ((d && d.sections) || []).forEach(function (sec) {
      var ctr = document.createElement("tr"); ctr.className = "rv-tc-cat";
      var ctd = document.createElement("td"); ctd.colSpan = 2; ctd.textContent = sec.label;
      ctr.appendChild(ctd); tb.appendChild(ctr);
      (sec.items || []).forEach(function (it) {
        var tr = document.createElement("tr");
        var kc = document.createElement("td"); kc.className = "rv-kpi-cell";
        var nm = document.createElement("div"); nm.className = "rv-kpi-name"; nm.textContent = it.label;
        kc.appendChild(nm); tr.appendChild(kc);
        var vc = document.createElement("td");
        if (it.answered) { var dd = document.createElement("div"); dd.className = "rv-kpi-desc"; dd.textContent = it.value; vc.appendChild(dd); }
        else { vc.textContent = DASH; }
        tr.appendChild(vc); tb.appendChild(tr);
      });
    });
    tbl.appendChild(tb); frag.appendChild(tbl);
    return frag;
  }

  // The career map: roles the person's current skills already reach. Exploring,
  // never a promise -- so no Add chip and no action of any kind.
  function buildRoutesCard(d) {
    var wrap = document.createElement("div");
    wrap.className = "rv-msg rv-msg-agent rv-card rv-lib-card";
    var lines = (d && d.lines) || [];
    var h = document.createElement("div"); h.className = "rv-confirm-head";
    h.textContent = d && d.here ? "From " + d.here : "Where your skills reach";
    wrap.appendChild(h);
    if (!lines.length) {
      var p = document.createElement("div");
      p.textContent = "Nothing on the career map reaches out from your role yet.";
      wrap.appendChild(p); return wrap;
    }
    var tbl = document.createElement("table"); tbl.className = "rv-scorecard rv-lib-table";
    var thead = document.createElement("thead"); var hr = document.createElement("tr");
    ["Role", "Grade", d && d.ranked ? "Skills match" : "Overlap"].forEach(function (x) {
      var t = document.createElement("th"); t.textContent = x; hr.appendChild(t);
    });
    thead.appendChild(hr); tbl.appendChild(thead);
    var tb = document.createElement("tbody");
    lines.forEach(function (l) {
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      var nm = document.createElement("div"); nm.className = "rv-kpi-name"; nm.textContent = l.title || DASH;
      td.appendChild(nm);
      if (l.group) { var m = document.createElement("div"); m.className = "rv-kpi-meta"; m.textContent = l.group; td.appendChild(m); }
      tr.appendChild(td);
      var gd = document.createElement("td"); gd.textContent = l.grade || DASH; tr.appendChild(gd);
      var rd = document.createElement("td");
      rd.textContent = (l.skills_match != null ? l.skills_match + "%"
                        : (l.overlap != null ? l.overlap + "%" : DASH));
      tr.appendChild(rd); tb.appendChild(tr);
    });
    tbl.appendChild(tb); wrap.appendChild(tbl);
    var note = document.createElement("div"); note.className = "rv-kpi-meta";
    note.textContent = "For exploring — not a shortlist, and not a promise of a role.";
    wrap.appendChild(note);
    return wrap;
  }

  function renderCard(card) {
    if (!card) return;
    if (card.type === "career_routes") {
      log.appendChild(buildRoutesCard(card.data || {})); scrollSoon(); return;
    }
    if (card.type !== "career_profile") return;
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
  function sendTurn(explicit) {
    if (busy) return;
    if (winClosed) { bubble("agent", winClosed); scrollSoon(); return; }
    var fromInput = (explicit === undefined);
    var msg = fromInput ? (input.value || "").trim() : String(explicit);
    if (!msg && log.querySelector(".rv-msg")) return;
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
    fetch(sendUrl, { method: "POST", body: f, credentials: "same-origin" })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        typing.remove();
        if (j && j.say) bubble("agent", j.say);
        if (j && j.window_closed) lockClosed(j.window_note);
        (j && j.renders || []).forEach(renderCard);
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

  // The inset depends on the card's height AND on whether it is overlaying at
  // all, and the mobile breakpoint changes both -- so recompute on resize, or a
  // desktop-width inset survives into a layout that no longer overlaps.
  var _insetTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(_insetTimer);
    _insetTimer = setTimeout(syncLogInset, 120);
  });

  form.addEventListener("submit", function (e) { e.preventDefault(); sendTurn(); });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTurn(); }
  });
  input.addEventListener("input", function () {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  });

  fetch(histUrl, { credentials: "same-origin" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (!j) return;
      var msgs = j.messages || [];
      msgs.forEach(function (m) {
        bubble(m.role, m.content);
        (m.card || []).forEach(renderCard);
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
          bubble("agent", "The career assistant isn't switched on yet — ask your admin to enable it.");
        }
        input.disabled = true; send.disabled = true;
        return;
      }
      if (!msgs.length) sendTurn();
    });
})();
