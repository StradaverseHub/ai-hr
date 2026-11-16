/* Ask OneHR -- the guide panel on the dashboard's left (Chris, 2026-10-15: "make the ai chat a permanent display on the
   left panel ... it should help navigate the user to the right view or open the side panel or go to the right
   module"; the "Ask OneHR guide panel and top bar" canvas). The conversation lives in this tab: each turn posts the
   question and the last few messages to /ask; the server builds the facts from this person's own dashboard every
   time, and they hold no result. Every answer is rendered as text (never HTML). Its cards go somewhere only this
   dashboard goes: one of its own panels (data-panel, opened by dashboard.js), a page on this site, or a card it marks.
   It folds to a rail, remembered in this browser only. */
(function () {
  "use strict";
  var panel = document.getElementById("ask-panel");
  var rail = document.getElementById("gp-rail");
  if (!panel || !rail) return;
  var log = document.getElementById("ask-log");
  var form = document.getElementById("ask-form");
  var input = document.getElementById("ask-input");
  var send = form.querySelector(".gp-send");
  var history = [];
  var busy = false;
  var FOLD_KEY = "onehr.guide.folded";

  // the cards an answer can mark, by the key the server sends (ASK_MARKS in app.py): the first that is on the page
  var MARKS = {
    here: [".od-here"], rail: [".od-rail"], stand: [".od-stand", ".od-bu", ".od-bg", ".od-notin"],
    own: [".od-bu", ".od-stand"],   // a CEO's card, opened on Own (2026-10-26); anyone else's Where you stand
    res: [".od-res"], led: [".od-led"], hist: [".od-hist"], tools: [".od-tools"],
    plan: ['.od-tcard[data-panel="plan"]', ".od-planc", ".od-tools"],
    report: ['.od-tcard[data-panel="report"]', ".od-tools"],
    learning: [".od-learn", '.od-tcard[data-panel="learning"]', ".od-tools"],
    subs: ["[data-subs-strip]", "[data-subs-entry]"],   // Who has submitted: a leader's card strip, or an HOD's row in Your tools (2026-11-02)
    gradeh: [".ghl-card"],   // a line manager's Grade H Appraisal card (2026-10-28)
    // the Executive Chairman's dashboard (P5, 2026-10-29)
    chairye: [".ec-top"], chairins: ["[data-chair-insight]"], chairbg: [".ec-bgs"]
  };

  function csrf() {
    var m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.getAttribute("content") : "";
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function scrollDown() { log.scrollTop = log.scrollHeight; }

  // ---- marking a card ----------------------------------------------------------------------------------------------
  function unmark() {
    Array.prototype.forEach.call(document.querySelectorAll(".gp-marked"), function (n) { n.classList.remove("gp-marked"); });
  }
  function mark(key) {
    unmark();
    var sels = MARKS[key] || [];
    for (var i = 0; i < sels.length; i++) {
      var n = document.querySelector(sels[i]);
      if (n) {
        if (key === "own") {   // a CEO's card switches to their own results
          var own = n.querySelector('[data-lt-tab="own"]');
          if (own && own.getAttribute("aria-selected") !== "true") own.click();
        }
        n.classList.add("gp-marked");
        try { n.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (e) { n.scrollIntoView(); }
        return n;
      }
    }
    return null;
  }

  // ---- folding -----------------------------------------------------------------------------------------------------
  function fold(on) {
    panel.hidden = !!on;
    rail.hidden = !on;
    try { localStorage.setItem(FOLD_KEY, on ? "1" : "0"); } catch (e) { /* storage blocked: it just won't remember */ }
    if (on) { unmark(); document.getElementById("gp-open").focus(); }
    else input.focus();
  }
  // ---- on a phone (under 1024px, 2026-11-07): closed until asked, opened as a bottom sheet -----------------------------
  // The card at the foot of the dashboard ("Any questions? Ask OneHR") opens the same panel as a sheet; the x, the dim
  // behind it, Esc, and choosing one of its cards close it. A phone never folds the panel to its rail and never touches
  // the saved fold, so a desktop that is open stays open. The panel's own rules (form, routes, cards) are unchanged.
  var scrim = document.getElementById("gp-scrim");
  var footBtn = document.getElementById("ask-foot-open");
  function phone() { return typeof window.onehrIsPhone === "function" && window.onehrIsPhone(); }
  var askBk = null;   // the phone's back gesture closes the sheet first (static/move_in.js, onehrBackLayer)
  function sheet(on) {
    if (on && !askBk && !panel.classList.contains("is-sheet") && typeof window.onehrBackLayer === "function") askBk = window.onehrBackLayer(function () { askBk = null; sheet(false); });
    if (!on && askBk) { var b0 = askBk; askBk = null; b0.done(); }
    panel.classList.toggle("is-sheet", !!on);
    if (scrim) scrim.hidden = !on;
    document.documentElement.classList.toggle("gp-sheet-open", !!on);
    if (on) { input.focus(); }
    else { unmark(); if (footBtn && phone()) footBtn.focus(); }
  }
  if (footBtn) footBtn.addEventListener("click", function () { sheet(true); });
  if (scrim) scrim.addEventListener("click", function () { sheet(false); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && panel.classList.contains("is-sheet")) { e.preventDefault(); sheet(false); }
  });
  log.addEventListener("click", function (e) {
    var c = e.target.closest ? e.target.closest("a.gp-card, button.gp-card") : null;
    if (c && panel.classList.contains("is-sheet")) setTimeout(function () { sheet(false); }, 0);
  });
  if (typeof window.onehrOnPhoneChange === "function") window.onehrOnPhoneChange(function (p) { if (!p) sheet(false); });

  document.getElementById("gp-fold").addEventListener("click", function () { if (phone()) sheet(false); else fold(true); });
  document.getElementById("gp-open").addEventListener("click", function () { fold(false); });

  // ---- the conversation --------------------------------------------------------------------------------------------
  // An answer's way on is a card (Chris, 2026-10-16, option A of the canvas "OneHR Ask OneHR Answer Cards"): the whole
  // card is the link. A kicker says what it is (a red spark when it opens an AI conversation), then its name, one line,
  // and Go / Open / Show me; only the first card's is solid. Every piece is set as text.
  var SPARK_D = "M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z";
  function card(c, primary) {
    var b, verb;
    if (c.help) {   // Get Help's panel (2026-10-22): help.js opens it from data-help-open, on Report a problem
      b = el("button", "gp-card");
      b.type = "button";
      b.setAttribute("data-help-open", c.help === "report" ? "report" : "home");
      b.setAttribute("aria-haspopup", "dialog");
      verb = "Open";
    } else if (c.panel) {   // one of the dashboard's own panels: dashboard.js opens it from data-panel
      b = el("button", "gp-card");
      b.type = "button";
      b.setAttribute("data-panel", c.panel);
      if (c.arg !== null && c.arg !== undefined) b.setAttribute("data-arg", String(c.arg));
      b.setAttribute("aria-haspopup", "dialog");
      verb = "Open";
    } else if (c.href && c.href.charAt(0) === "/" && c.href.charAt(1) !== "/") {   // a page on this site only
      b = el("a", "gp-card");
      b.href = c.href;
      if (c.title) b.setAttribute("data-move-sub", c.title);   // what the agent's hand-over says is first (move.js)
      verb = "Go";
    } else if (c.mark && MARKS[c.mark]) {   // a card on this page: mark it again
      b = el("button", "gp-card");
      b.type = "button";
      b.addEventListener("click", function () { mark(c.mark); });
      verb = "Show me";
    } else if (c.type === "info") {   // a fact with nowhere to go: tonight's upgrade (the release window, 2026-10-26)
      b = el("div", "gp-card gp-card-info");
      verb = "";
    } else {
      return null;
    }
    var t = el("span", "gp-card-t");
    var kicker = c.kicker || c.source;
    if (kicker) {
      var k = el("span", "gp-card-k");
      if (c.ai) {
        var sv = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        sv.setAttribute("viewBox", "0 0 24 24");
        sv.setAttribute("aria-hidden", "true");
        var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", SPARK_D);
        sv.appendChild(path);
        k.appendChild(sv);
      }
      k.appendChild(document.createTextNode(kicker));
      t.appendChild(k);
    }
    t.appendChild(el("b", null, c.title || c.label || ""));
    if (c.sub) t.appendChild(el("span", "gp-card-s", c.sub));
    b.appendChild(t);
    if (!verb) return b;
    var go = el("span", "gp-card-go" + (primary ? " is-primary" : ""), verb + (verb === "Show me" ? "" : " ›"));
    go.setAttribute("aria-hidden", "true");   // the card's name is what it is, not the verb
    b.appendChild(go);
    return b;
  }
  function answer(d, q) {
    var wrap = el("div", "gp-a");
    wrap.appendChild(el("p", null, d.say || ""));
    var list = el("div", "gp-cards");
    var n = 0;
    (d.cards || []).forEach(function (c) {
      if (c.type === "guide") {
        var g = el("div", "gp-guide");
        g.appendChild(el("b", null, c.label));
        if (c.body) g.appendChild(el("span", null, c.body));
        g.appendChild(el("small", null, c.source || "OneHR guide"));
        wrap.appendChild(g);
        return;
      }
      var b = card(c, n === 0);
      if (b) { list.appendChild(b); n += 1; }
    });
    if (n) wrap.appendChild(list);
    (d.waits || []).forEach(function (w) {   // what they're waiting on someone else for, under the cards
      var p = el("p", "gp-wait");
      p.appendChild(el("b", null, "Waiting"));
      p.appendChild(document.createTextNode(" · " + w));
      wrap.appendChild(p);
    });
    if (d.unanswered) wrap.appendChild(el("span", "gp-note", "Sent to Group People's list of questions I couldn't answer"));
    var quick = (d.quick_replies || []).slice();
    // no way on and nothing to try: offer what's pending, unless that was the question
    if (!n && !quick.length && !/pending/i.test(q || "")) quick.push("What's pending for me?");
    if (quick.length) {
      var chips = el("div", "gp-chips");
      quick.forEach(function (t) {
        var c = el("button", "gp-chip", t);
        c.type = "button";
        c.addEventListener("click", function () { ask(t); });
        chips.appendChild(c);
      });
      wrap.appendChild(chips);
    }
    log.appendChild(wrap);
    var m = d.mark || ((d.cards || []).filter(function (c) { return c.mark; })[0] || {}).mark;
    if (m) mark(m); else unmark();
    scrollDown();
  }
  function ask(text) {
    text = (text || "").trim();
    if (!text || busy) return;
    var rest = document.getElementById("gp-rest");
    if (rest) rest.hidden = true;   // at rest only until the first question; the answers take its place
    busy = true;
    send.disabled = true;
    unmark();
    log.appendChild(el("p", "gp-q", text));
    var thinking = el("p", "gp-thinking", panel.getAttribute("data-available") === "1" ? "Finding it…" : "Searching…");
    log.appendChild(thinking);
    scrollDown();
    var body = new FormData();
    body.append("csrf_token", csrf());
    body.append("message", text);
    body.append("history", JSON.stringify(history.slice(-10)));
    fetch(panel.getAttribute("data-endpoint"), { method: "POST", body: body, credentials: "same-origin" })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) {
        thinking.remove();
        if (!d || (!d.ok && !d.say)) {
          answer({ say: (d && d.error) || "Sorry, that didn't go through. Try again in a moment." }, text);
          return;
        }
        answer(d, text);
        if (d.slowed) { input.value = text; return; }   // six a minute (2026-10-11): back in the box, not in the history
        history.push({ role: "user", content: text });
        history.push({ role: "agent", content: d.say || "" });
      })
      .catch(function () {
        thinking.remove();
        answer({ say: "The connection dropped. Your question is back in the box; try again." }, text);
        input.value = text;
      })
      .then(function () { busy = false; send.disabled = false; });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var t = input.value;
    input.value = "";
    ask(t);
  });
  panel.addEventListener("click", function (e) {
    var s = e.target.closest && e.target.closest(".ask-sugg");
    if (s) ask(s.getAttribute("data-q"));
  });
  // the look around again (2026-10-15): the server starts the tour over, and the page shows it
  var again = document.getElementById("gp-tour-again");
  if (again) again.addEventListener("click", function () {
    var body = new FormData();
    body.append("csrf_token", csrf());
    body.append("again", "1");
    fetch(again.getAttribute("data-url"), { method: "POST", body: body, credentials: "same-origin" })
      .then(function () { window.location.reload(); });
  });
})();
