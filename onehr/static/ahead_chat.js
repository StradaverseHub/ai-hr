/* The conversational AHEAD (IDP) agent's client -- the development plan.
 *
 * A plain chat: render the transcript, send the employee's message to
 * /review/ahead/chat, append the agent's reply, show its quick-reply chips.
 * The SERVER decides everything -- what a goal needs before it can be shared is
 * pm_idp_share_validate(), the same rule the /idp page applies -- so this file
 * computes nothing. It sends text, paints bubbles, shows the pinned plan, and
 * posts the human Share.
 *
 * A separate file from review_chat.js / setting_chat.js / competency_chat.js:
 * the plan is its own conversation, one GOAL at a time across four fields
 * rather than one answer per row. Reuses the rv-* CSS.
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
  var SHOW_RE = /\b(show|see|view|list|display|pull up|bring up|open|what(?:'?s| is| are))\b[^.?!]{0,30}\b(plan|goal|plans|goals)/i;

  function bubble(role, text) {
    var d = document.createElement("div");
    d.className = "rv-msg rv-msg-" + (role === "user" ? "user" : "agent");
    d.textContent = text;
    log.appendChild(d);
    scrollToBottom();
    return d;
  }

  /* ---- the pinned plan: a LIVE widget, ONE GOAL at a time ------------------- *
   * Each goal is four things -- the area plus the three 70:20:10 actions -- so the
   * card shows one goal with a row per field, rebuilt from the server's `overview`
   * every turn. A field's chip composes a sentence and sends it to the agent; the
   * server still validates + writes (one path).                                  */

  // The plan can be expanded/minimized; the choice is remembered per browser.
  var tableOpen = true;
  try { tableOpen = localStorage.getItem("rv-idp-open") !== "0"; } catch (e) {}
  function paintToggle(tog) {
    tog.setAttribute("aria-expanded", tableOpen ? "true" : "false");
    tog.title = tableOpen ? "Hide the plan" : "Show the plan";
    tog.innerHTML = (tableOpen ? ICON.eye : ICON.eyeOff) +
      '<span class="rv-toggle-lbl">Plan</span>';
  }
  function setTableOpen(open) {
    tableOpen = !!open;
    try { localStorage.setItem("rv-idp-open", tableOpen ? "1" : "0"); } catch (e) {}
    if (tableEl) tableEl.hidden = !tableOpen;
    syncLogInset();
    var tog = pin && pin.querySelector(".rv-table-toggle");
    if (tog) paintToggle(tog);
  }

  // The slim summary line: "Ready X / N", a Draft / Shared / Closed chip, and the
  // expand/minimize toggle. The counts come from the server -- nothing recomputed.
  function buildStatusHeader(data) {
    var wrap = document.createElement("div"); wrap.className = "rv-status";
    var ready = (data && data.ready) || 0, total = (data && data.total) || 0;
    var min = (data && data.min_goals) || 1;
    var done = total > 0 && ready >= total && total >= min;
    var prog = document.createElement("div");
    prog.className = "rv-weight-total " + (done ? "rv-weight-ok" : "rv-weight-short");
    var pl = document.createElement("span"); pl.className = "rv-weight-lbl"; pl.textContent = "Ready";
    var pn = document.createElement("span"); pn.className = "rv-weight-num"; pn.textContent = ready + " / " + total;
    prog.appendChild(pl); prog.appendChild(pn); wrap.appendChild(prog);

    var now = document.createElement("span"); now.className = "rv-now";
    now.textContent = !total ? "No goals yet"
      : done ? "Ready to share" : (total - ready) + " still to finish";
    wrap.appendChild(now);

    var st = data && data.status, chip = document.createElement("span");
    if (st === "closed") { chip.className = "rv-confirm-state rv-confirm-state-done"; chip.textContent = "Closed"; }
    else if (st === "shared") { chip.className = "rv-confirm-state rv-confirm-state-done"; chip.textContent = "Shared"; }
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

  // The floating card shows ONE goal at a time, with prev/next in the top-right
  // corner. It FOLLOWS the conversation: when the agent moves to another goal
  // (data.focus_goal_id), the card jumps there; otherwise the person's manual
  // paging is kept. Rebuilt each turn -- every control is a chip that sends a
  // sentence, so nothing unsaved is ever lost.
  var tableEl = null, curGoal = 0, lastFocusId = null, lastData = null;

  function goalIndexOf(goals, id) {
    for (var i = 0; i < goals.length; i++) { if (goals[i].goal_id === id) return i; }
    return 0;
  }

  // One field row: its label, what is there now, and -- while editable -- a chip
  // that asks the agent for that field. The chip never writes; it talks.
  function fieldRow(tb, label, hint, value, phrase, editable) {
    var tr = document.createElement("tr");
    var lc = document.createElement("td"); lc.className = "rv-kpi-cell";
    var nm = document.createElement("div"); nm.className = "rv-kpi-name"; nm.textContent = label;
    lc.appendChild(nm);
    if (hint) { var h = document.createElement("div"); h.className = "rv-kpi-meta"; h.textContent = hint; lc.appendChild(h); }
    tr.appendChild(lc);
    var vc = document.createElement("td");
    if (value) {
      var d = document.createElement("div"); d.className = "rv-kpi-desc"; d.textContent = value; vc.appendChild(d);
    } else if (editable) {
      var b = document.createElement("button"); b.type = "button"; b.className = "rv-chip rv-lib-add";
      b.textContent = "Add";
      b.addEventListener("click", function () { if (!busy) sendTurn(phrase); });
      vc.appendChild(b);
    } else {
      vc.textContent = DASH;
    }
    tr.appendChild(vc); tb.appendChild(tr);
  }

  function buildGoalCard(data) {
    var goals = (data && data.goals) || [];
    if (!goals.length) return null;
    if (curGoal >= goals.length) curGoal = goals.length - 1;
    if (curGoal < 0) curGoal = 0;
    var g = goals[curGoal];
    var editable = !!(data && data.editable);
    var area = g.area || ("Goal " + g.seq);

    var wrap = document.createElement("div");
    wrap.className = "rv-card rv-kpi-overview rv-kpi-inline rv-set-table rv-tc-table";
    if (data && data.focus_goal_id === g.goal_id) wrap.className += " rv-tc-focus";

    var bar = document.createElement("div"); bar.className = "rv-tc-navbar";
    var lbl = document.createElement("div"); lbl.className = "rv-tc-navlbl";
    var nm = document.createElement("span"); nm.className = "rv-tc-navname"; nm.textContent = area;
    var ct = document.createElement("span"); ct.className = "rv-tc-navcount";
    ct.textContent = "(" + (curGoal + 1) + " of " + goals.length + ")" + (g.ready ? " · ready" : "");
    lbl.appendChild(nm); lbl.appendChild(ct); bar.appendChild(lbl);
    var nav = document.createElement("div"); nav.className = "rv-tc-nav";
    var prev = document.createElement("button"); prev.type = "button"; prev.className = "rv-tc-navbtn";
    prev.innerHTML = ICON.prev; prev.title = "Previous goal"; prev.setAttribute("aria-label", "Previous goal");
    prev.disabled = curGoal <= 0;
    prev.addEventListener("click", function () { if (curGoal > 0) { curGoal--; rerenderGoal(); } });
    var next = document.createElement("button"); next.type = "button"; next.className = "rv-tc-navbtn";
    next.innerHTML = ICON.next; next.title = "Next goal"; next.setAttribute("aria-label", "Next goal");
    next.disabled = curGoal >= goals.length - 1;
    next.addEventListener("click", function () { if (curGoal < goals.length - 1) { curGoal++; rerenderGoal(); } });
    nav.appendChild(prev); nav.appendChild(next); bar.appendChild(nav);
    wrap.appendChild(bar);

    var tbl = document.createElement("table"); tbl.className = "rv-scorecard rv-kpi-flat";
    var thead = document.createElement("thead"); var hr = document.createElement("tr");
    ["", "This goal"].forEach(function (h) { hr.appendChild(th(h)); });
    thead.appendChild(hr); tbl.appendChild(thead);
    var tb = document.createElement("tbody");
    fieldRow(tb, "Area", "What you want to develop", g.area,
             'I want to change the area for "' + area + '".', editable);
    fieldRow(tb, "Target date", "Optional", g.target_date,
             'Let\'s set a target date for "' + area + '".', editable);
    (g.actions || []).forEach(function (a) {
      fieldRow(tb, a.label + " (" + a.pct + "%)", a.hint, a.value,
               'Help me with the "' + a.label + '" action for "' + area + '".', editable);
    });
    tbl.appendChild(tb); wrap.appendChild(tbl);
    return wrap;
  }

  // Rebuild the floating goal card in place (keeps the pinned header + the scroll).
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

  function rerenderGoal() {
    if (!lastData) return;
    var fresh = buildGoalCard(lastData);
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
    // plan and the floating card off the screen on a transient model hiccup.
    // null still means genuinely nothing and still clears.
    if (data === undefined) return;
    lastData = data;
    if (!data) { pin.innerHTML = ""; if (tableEl) { tableEl.remove(); tableEl = null; } syncLogInset(); return; }
    pin.innerHTML = "";
    pin.appendChild(buildStatusHeader(data));
    var goals = data.goals || [];
    if (!goals.length) { if (tableEl) { tableEl.remove(); tableEl = null; } return; }
    // Follow the conversation: jump to the focus goal when it moves.
    if (data.focus_goal_id && data.focus_goal_id !== lastFocusId) {
      curGoal = goalIndexOf(goals, data.focus_goal_id);
    }
    lastFocusId = data.focus_goal_id;
    var first = !tableEl;
    rerenderGoal();
    if (first) scrollSoon();
  }

  // The read-only plan snapshot for the share card: every goal, its actions, and
  // whether it is finished.
  function snapshotTable(d) {
    var frag = document.createDocumentFragment();
    var tbl = document.createElement("table"); tbl.className = "rv-scorecard rv-kpi-flat";
    var thead = document.createElement("thead"); var hr = document.createElement("tr");
    ["Goal", "Actions"].forEach(function (h) { hr.appendChild(th(h)); });
    thead.appendChild(hr); tbl.appendChild(thead);
    var tb = document.createElement("tbody");
    ((d && d.goals) || []).forEach(function (g) {
      var tr = document.createElement("tr");
      var kc = document.createElement("td"); kc.className = "rv-kpi-cell";
      var nm = document.createElement("div"); nm.className = "rv-kpi-name";
      nm.textContent = g.area || ("Goal " + g.seq); kc.appendChild(nm);
      if (g.target_date) {
        var m = document.createElement("div"); m.className = "rv-kpi-meta";
        m.textContent = "by " + g.target_date; kc.appendChild(m);
      }
      tr.appendChild(kc);
      var ac = document.createElement("td");
      var any = false;
      (g.actions || []).forEach(function (a) {
        if (!a.value) return;
        any = true;
        var d2 = document.createElement("div"); d2.className = "rv-kpi-desc";
        d2.textContent = a.label + ": " + a.value; ac.appendChild(d2);
      });
      if (!any) ac.textContent = DASH;
      tr.appendChild(ac); tb.appendChild(tr);
    });
    tbl.appendChild(tb); frag.appendChild(tbl);
    var o = document.createElement("div"); o.className = "rv-scorecard-overall";
    o.textContent = "Ready " + ((d && d.ready) || 0) + " / " + ((d && d.total) || 0);
    frag.appendChild(o);
    return frag;
  }

  // The gap card: the person's OWN evidence, browsable, with an Add chip that
  // sends a sentence back through the chat (so the write is still the agent's).
  function buildGapsCard(d) {
    var wrap = document.createElement("div");
    wrap.className = "rv-msg rv-msg-agent rv-card rv-lib-card";
    var items = (d && d.items) || [], future = (d && d.future) || [];
    if (!items.length && !future.length) {
      var p = document.createElement("div");
      p.textContent = "Nothing has come back yet from your 360 or your competency review, "
        + "so let's start from what you want to get better at.";
      wrap.appendChild(p); return wrap;
    }
    function section(title, rows) {
      if (!rows.length) return;
      var h = document.createElement("div"); h.className = "rv-confirm-head";
      h.textContent = title; wrap.appendChild(h);
      var tbl = document.createElement("table"); tbl.className = "rv-scorecard rv-lib-table";
      var tb = document.createElement("tbody");
      rows.forEach(function (l) {
        var tr = document.createElement("tr");
        var td = document.createElement("td");
        var nm = document.createElement("div"); nm.className = "rv-kpi-name"; nm.textContent = l.label; td.appendChild(nm);
        if (l.note) { var m = document.createElement("div"); m.className = "rv-kpi-meta"; m.textContent = l.note; td.appendChild(m); }
        if (l.detail) { var dd = document.createElement("div"); dd.className = "rv-kpi-desc"; dd.textContent = l.detail; td.appendChild(dd); }
        tr.appendChild(td);
        var act = document.createElement("td");
        var b = document.createElement("button"); b.type = "button"; b.className = "rv-chip rv-lib-add";
        b.textContent = "Add";
        b.addEventListener("click", function () { if (!busy) sendTurn('Add a goal for "' + l.label + '".'); });
        act.appendChild(b); tr.appendChild(act); tb.appendChild(tr);
      });
      tbl.appendChild(tb); wrap.appendChild(tbl);
    }
    section("From your feedback and review", items);
    section("To grow into", future);
    return wrap;
  }

  // The final SHARE card: what sharing means, the plan snapshot, and a single
  // "Share with my manager" button.
  function buildShareCard(d) {
    var wrap = document.createElement("div");
    wrap.className = "rv-msg rv-msg-agent rv-card rv-confirm";
    var warn = document.createElement("div"); warn.className = "rv-confirm-warn";
    warn.textContent = "Sharing sends your plan to your manager so they can book your career "
      + "conversation. It isn't a hand-over — you can keep editing it until that conversation.";
    wrap.appendChild(warn);
    var h = document.createElement("div"); h.className = "rv-confirm-head";
    h.textContent = "Your development plan"; wrap.appendChild(h);
    wrap.appendChild(snapshotTable(d));
    var actions = document.createElement("div"); actions.className = "rv-confirm-actions";
    var yes = document.createElement("button"); yes.type = "button";
    yes.className = "rv-confirm-yes"; yes.textContent = "Share with my manager";
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
          bubble("agent", "Shared — your plan is with your manager. You can still change it before your career conversation.");
          if (j.overview) refreshOverview(j.overview);
          scrollSoon();
        } else {
          btn.disabled = false;
          bubble("agent", (j && j.error) || "Couldn't share — please try again.");
        }
      })
      .catch(function () { btn.disabled = false; bubble("agent", "Couldn't share — please try again."); });
  }

  function renderCard(card) {
    if (!card) return;
    if (card.type === "idp_confirm") {
      log.appendChild(buildShareCard(card.data || {})); scrollSoon(); return;
    }
    if (card.type === "idp_gaps") {
      log.appendChild(buildGapsCard(card.data || {})); scrollSoon(); return;
    }
    if (card.type !== "idp_plan") return;
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
          bubble("agent", "The development-plan assistant isn't switched on yet — ask your admin to enable it.");
        }
        input.disabled = true; send.disabled = true;
        return;
      }
      if (!msgs.length) sendTurn();
    });
})();
