/* AI+ Learning in the AI+ check-in's own shell (2026-10-22, canvas section 17): the tabs, Go to it from the queue, and
   the learning coach's conversation under the open tab's cards. Each tab talks to its own coach page (Find: the
   calendar's coach; Apply and Progress: Mine's; Team / Dept: the leader's). The cards on the page are the server's;
   the coach's turns append below them. */
(function () {
  "use strict";
  var root = document.getElementById("ln");
  if (!root) return;
  var log = document.getElementById("ln-log"), chat = document.getElementById("ln-chat"),
      chips = document.getElementById("ln-chips"), form = document.getElementById("ln-form"),
      input = document.getElementById("ln-input"), send = form ? form.querySelector(".ln-send") : null,
      url = root.getAttribute("data-coach-url"), live = root.getAttribute("data-available") === "1",
      view = root.getAttribute("data-view"), page = null, busy = false, cards = window.lcCards || {};

  function token() {
    var m = document.querySelector('input[name="csrf_token"]');
    if (m) return m.value;
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute("content") : "";
  }
  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }
  function spark() {
    var s = el("span", "ln-av");
    s.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C12.6 7.4 16.6 11.4 22 12C16.6 12.6 ' +
      '12.6 16.6 12 22C11.4 16.6 7.4 12.6 2 12C7.4 11.4 11.4 7.4 12 2Z"></path></svg>';
    return s;
  }
  var quiet = false;           // while a tab's history loads, the page stays at its cards
  function toEnd() { if (!quiet) log.scrollTop = log.scrollHeight; }
  function agent(text, list) {
    var row = el("div", "ln-ai"), body = el("div", "ln-ai-b");
    row.appendChild(spark());
    if (text) body.appendChild(el("div", "ln-bub", text));
    (list || []).forEach(function (c) {
      var card = cards.build ? cards.build(c, { api: url, show: show, go: goTo }) : null;
      if (card) body.appendChild(card);
    });
    row.appendChild(body);
    chat.appendChild(row);
    toEnd();
  }
  function user(text) { chat.appendChild(el("div", "ln-me", text)); toEnd(); }
  function setChips(items) {
    chips.innerHTML = "";
    (items || []).forEach(function (t) {
      var b = el("button", "ln-chip", t);
      b.type = "button";
      b.disabled = !live;
      b.addEventListener("click", function () { turn(t); });
      chips.appendChild(b);
    });
  }

  // the coach: a tab's conversation, loaded when the tab opens
  function load(p) {
    if (!url || p === page) return;
    page = p;
    chat.innerHTML = "";
    setChips([]);
    fetch(url + "?page=" + encodeURIComponent(p), { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok || page !== p) return;
        var last = j.opening ? j.opening.quick_replies : [];
        quiet = true;
        (j.messages || []).forEach(function (m) {
          if (m.role === "user") user(m.content);
          else { agent(m.content, m.cards); last = m.quick_replies; }
        });
        quiet = false;
        setChips(last);
      })
      .catch(function () { /* the cards above still work without the coach */ });
  }
  function turn(text) {
    text = (text || "").trim();
    if (!text || busy || !live || !page) return;
    busy = true;
    if (send) send.disabled = true;
    user(text);
    setChips([]);
    var thinking = el("p", "ln-thinking", "Looking…");
    chat.appendChild(thinking);
    toEnd();
    var f = new FormData();
    f.append("csrf_token", token());
    f.append("page", page);
    f.append("message", text);
    fetch(url, { method: "POST", body: f, credentials: "same-origin" })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        thinking.remove();
        if (j && j.slowed) input.value = text;
        agent((j && j.say) || "Sorry, I lost the thread there. Could you say that again?", j && j.cards);
        setChips(j && j.quick_replies);
      })
      .catch(function () { thinking.remove(); agent("Connection lost. Try again in a moment."); })
      .then(function () { busy = false; if (send) send.disabled = !live; });
  }
  // a card opened from a card (a run on the month card): answered in code by OneHR, kept in the conversation
  function show(what, ask) {
    if (busy || !page) return;
    busy = true;
    user(ask);
    setChips([]);
    var f = new FormData();
    f.append("csrf_token", token());
    f.append("page", page);
    f.append("show", what);
    fetch(url, { method: "POST", body: f, credentials: "same-origin" })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        agent((j && j.say) || "That didn't open. Try again in a moment.", j && j.cards);
        setChips(j && j.quick_replies);
      })
      .catch(function () { agent("Connection lost. Try again in a moment."); })
      .then(function () { busy = false; });
  }
  if (form) form.addEventListener("submit", function (e) {
    e.preventDefault();
    var t = input.value;
    input.value = "";
    turn(t);
  });

  // the tabs: one open at a time, its steps showing; the address keeps it, so a reload lands on it
  var tabs = Array.prototype.slice.call(root.querySelectorAll(".ln-tab[data-tab]"));
  // decide in bulk (2026-10-23): Tick all, and how many are ticked
  Array.prototype.forEach.call(root.querySelectorAll("[data-bulk]"), function (f) {
    var all = f.querySelector("[data-bulk-all]"), n = f.querySelector("[data-bulk-n]");
    function ones() { return Array.prototype.slice.call(root.querySelectorAll('input[data-bulk-one][form="' + f.id + '"]')); }

    function said(list) {
      var n = list.length, who = list.slice(0, 3).join(", ") + (n > 3 ? " and " + (n - 3) + " more" : "");
      return n + " request" + (n === 1 ? "" : "s") + " (" + who + ")";
    }
    function words(list) {
      var w = list.length ? said(list) : null;
      var t = {
        approve: w ? "Approve " + w + "? Each goes to its next step or is confirmed; on a full run it joins the waiting list." : "Tick at least one request first.",
        "return": w ? "Return " + w + " with your note? Each person can change theirs and send it again." : "Tick at least one request first.",
        decline: w ? "Decline " + w + "? It's final: each person reads your note, and any place they held goes to the waiting list." : "Tick at least one request first."
      };
      Array.prototype.forEach.call(f.querySelectorAll("button[name=bulk]"), function (b) { b.setAttribute("data-confirm", t[b.value]); });
    }
    function count() {
      var on = ones().filter(function (b) { return b.checked; }), k = on.length;
      n.textContent = k ? k + " ticked" : "None ticked";
      if (all) all.checked = k > 0 && k === ones().length;
      words(on.map(function (b) { return b.getAttribute("data-bulk-name") || "one"; }));
    }
    if (all) all.addEventListener("change", function () { ones().forEach(function (b) { b.checked = all.checked; }); count(); });
    root.addEventListener("change", function (e) { if (e.target && e.target.hasAttribute && e.target.hasAttribute("data-bulk-one")) count(); });
    count();
  });
  // Get Help's quick answers follow the view and the open tab (help.js asks)
  window.ohHelpCtx = function () {
    var on = tabs.filter(function (t) { return t.classList.contains("is-open"); })[0];
    return { view: view || "mine", stage: on ? on.getAttribute("data-tab") : "" };
  };
  function open(key, quiet) {
    var tab = tabs.filter(function (t) { return t.getAttribute("data-tab") === key; })[0];
    if (!tab) return false;
    tabs.forEach(function (t) {
      var on = t === tab;
      t.classList.toggle("is-open", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    Array.prototype.forEach.call(root.querySelectorAll(".ln-panel"), function (p) {
      p.hidden = p.getAttribute("data-panel") !== key;
    });
    if (!quiet && window.history && history.replaceState) {
      var u = new URL(window.location.href);
      u.searchParams.set("view", view);
      u.searchParams.set("tab", key);
      u.hash = "";
      history.replaceState(null, "", u.toString());
    }
    load(tab.getAttribute("data-coach-page"));
    return true;
  }
  tabs.forEach(function (t) {
    t.addEventListener("click", function () { open(t.getAttribute("data-tab")); log.scrollTop = 0; });
  });

  // Go to it: open the card's tab, bring the card into view and mark it a moment
  function goTo(anchor) {
    var target = anchor && document.getElementById(anchor);
    if (!target) return false;
    var panel = target.closest(".ln-panel");
    if (panel) open(panel.getAttribute("data-panel"));         // the address follows, so a reload stays on its tab
    if (target.tagName === "DETAILS") target.open = true;     // a sent check-in's Change it
    target.scrollIntoView({ block: "start" });
    target.classList.add("is-marked");
    window.setTimeout(function () { target.classList.remove("is-marked"); }, 1800);
    return true;
  }
  Array.prototype.forEach.call(root.querySelectorAll("[data-go]"), function (a) {
    a.addEventListener("click", function (e) {
      if (goTo(a.getAttribute("data-go"))) e.preventDefault();
    });
  });

  // an HOD's round: the search under a run filters its folded list of the department (2026-10-23, board 18B)
  Array.prototype.forEach.call(root.querySelectorAll("[data-filter-list]"), function (inp) {
    var list = inp.nextElementSibling;
    if (!list) return;
    inp.addEventListener("input", function () {
      var q = inp.value.trim().toLowerCase();
      Array.prototype.forEach.call(list.querySelectorAll(".ls-pk"), function (row) {
        var hit = !q || row.textContent.toLowerCase().indexOf(q) !== -1 || row.querySelector("input:checked");
        row.hidden = !hit;
      });
    });
  });

  // first paint: the open tab's coach; a #card in the address (a redirect after a save) opens its tab
  var first = tabs.filter(function (t) { return t.classList.contains("is-open"); })[0] || tabs[0];
  if (first) load(first.getAttribute("data-coach-page"));
  if (window.location.hash) goTo(window.location.hash.slice(1));
})();
