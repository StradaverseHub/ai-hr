/* The learning coach (2026-10-22, boards 8B, 8C, 2C): Ask OneHR's panel on the left, for AI+ Learning. The opening
   and the conversation come from /learning/coach (GET); a turn is a POST. Runs and requests come back as cards built
   from OneHR's own facts; the coach never registers anyone (Register opens the person's own request). */
(function () {
  "use strict";
  var panel = document.getElementById("lco");
  // the cards are shared with the AI+ Learning shell (learning_shell.js, 2026-10-22): build(card, hooks) draws any of
  // them; hooks.api is the coach's address (the month's arrows), hooks.show opens a run as a programme card in the
  // conversation, hooks.go brings a card on the page into view
  window.lcCards = { run: runCard, request: requestCard, build: buildCard };
  if (!panel) return;
  var log = document.getElementById("lco-log"), quick = document.getElementById("lco-quick"),
      form = document.getElementById("lco-form"), input = document.getElementById("lco-input"),
      send = form ? form.querySelector(".gp-send") : null, rail = document.getElementById("lco-rail"),
      url = panel.getAttribute("data-url"), page = panel.getAttribute("data-page"),
      live = panel.getAttribute("data-available") === "1", busy = false, FOLD_KEY = "onehr.coach.folded";

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
  function scroll() { log.scrollTop = log.scrollHeight; }
  function link(href, label, primary) {
    var a = el("a", "gp-act" + (primary ? " is-primary" : ""), label);
    a.href = href;
    return a;
  }
  function runCard(c) {
    var d = el("div", "lco-card");
    var h = el("div", "lco-card-h");
    h.appendChild(el("b", null, c.title));
    h.appendChild(el("span", "lco-seats" + (c.mine ? " is-mine" : ""), c.mine ? c.mine :
      (c.left == null ? "Open" : c.left + " seat" + (c.left === 1 ? "" : "s"))));
    d.appendChild(h);
    d.appendChild(el("p", "lco-line", c.line + " · " + c.format));
    (c.builds || []).forEach(function (b) {
      var p = el("p", "lco-builds");
      p.appendChild(document.createTextNode("Builds "));
      p.appendChild(el("b", null, b.title));
      p.appendChild(document.createTextNode(" to L" + b.level + (b.yours === "plan" ? " · your goal" : "")));
      if (b.desc) p.appendChild(el("span", "lco-desc", "L" + b.level + ": " + b.desc));
      d.appendChild(p);
    });
    if (c.closes && !c.mine) d.appendChild(el("p", "lco-note", "Registration closes " + c.closes));
    var acts = el("div", "gp-acts");
    acts.appendChild(link(c.page, "Open the programme", false));
    if (c.register) acts.appendChild(link(c.register, "Register", true));
    d.appendChild(acts);
    return d;
  }
  function requestCard(c) {
    var d = el("div", "lco-card is-request");
    d.appendChild(el("span", "lco-kick", "Training request · your own"));
    d.appendChild(el("b", "lco-card-t", c.title));
    d.appendChild(el("p", "lco-line", c.line));
    if (c.goal) d.appendChild(el("p", "lco-row", "For your goal: " + c.goal));
    d.appendChild(el("p", "lco-row", "Approval: " + c.approval + (c.full ? " · full, so the waiting list" : "")));
    var acts = el("div", "gp-acts");
    acts.appendChild(link(c.register, "Check and send", true));
    acts.appendChild(link(c.page, "Open the programme", false));
    d.appendChild(acts);
    return d;
  }
  // a month of the calendar (board 17B): the grid in the shell's conversation, its runs as a list in a narrow panel;
  // a run opens as a programme card where the page can (hooks.show), else the calendar picks it
  function monthCard(c, hooks) {
    // (no var outside a function here: the shell's page returns before this file's vars are set, and only its
    // function declarations are hoisted)
    var DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    hooks = hooks || {};
    var d = el("div", "lcm");
    function evLink(ev, cls, label) {
      var a = el("a", cls + " is-" + ev.st);
      a.href = c.url + "&s=" + ev.sid;
      a.title = ev.t + " · " + ev.sub;
      label(a);
      if (hooks.show) a.addEventListener("click", function (e) {
        e.preventDefault();
        hooks.show("prog:" + ev.pid + ":" + ev.sid, "Open " + ev.t);
      });
      return a;
    }
    function draw(c_) {
      c = c_;
      d.innerHTML = "";
      var h = el("div", "lcm-h");
      function nav(m, label, sign) {
        var b = el("button", "lcm-nav", sign);
        b.type = "button";
        b.setAttribute("aria-label", label);
        b.addEventListener("click", function () {
          b.disabled = true;
          fetch(hooks.api + "?month=" + encodeURIComponent(m), { credentials: "same-origin" })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (j && j.ok && j.card) draw(j.card); else b.disabled = false; })
            .catch(function () { b.disabled = false; });
        });
        return b;
      }
      if (hooks.api) h.appendChild(nav(c.prev, "Previous month", "\u2039"));
      h.appendChild(el("b", "lcm-t", c.label));
      if (hooks.api) h.appendChild(nav(c.next, "Next month", "\u203a"));
      h.appendChild(el("span", "lcm-sub", c.n ? (c.n === 1 ? "1 run" : c.n + " runs") + " open to you" : "Nothing open to you"));
      h.appendChild(el("span", "lcm-grow"));
      h.appendChild(link(c.url, "Open the full calendar", false));
      d.appendChild(h);
      var g = el("div", "lcm-grid");
      DOW.forEach(function (x) { g.appendChild(el("span", "lcm-dw", x)); });
      (c.weeks || []).forEach(function (w) {
        w.forEach(function (day) {
          var cell = el("div", "lcm-d" + (day["in"] ? "" : " is-out") + (day.we ? " is-we" : "") + (day.today ? " is-today" : ""));
          cell.appendChild(el("span", "lcm-n", String(day.d)));
          (day.ev || []).forEach(function (ev) {
            cell.appendChild(evLink(ev, "lc-ev lcm-ev", function (a) { a.appendChild(el("b", null, ev.t)); }));
          });
          if (day.more) cell.appendChild(el("span", "lcm-more", "+" + day.more));
          g.appendChild(cell);
        });
      });
      d.appendChild(g);
      var l = el("div", "lcm-list");
      (c.list || []).forEach(function (ev) {
        l.appendChild(evLink(ev, "lcm-li", function (a) {
          a.appendChild(el("span", "lcm-li-d", ev.day));
          a.appendChild(el("b", null, ev.t));
          a.appendChild(el("span", "lcm-li-s", ev.sub));
        }));
      });
      if (!(c.list || []).length) l.appendChild(el("p", "lco-note", "Nothing open to you this month."));
      d.appendChild(l);
      var k = el("div", "lcm-key");
      [["is-plan", "Your plan"], ["", "Open to you"], ["is-full", "Full: the waiting list"], ["is-registered", "Yours"]]
        .forEach(function (x) {
          var s = el("span");
          s.appendChild(el("i", "lc-sw " + x[0]));
          s.appendChild(document.createTextNode(x[1]));
          k.appendChild(s);
        });
      d.appendChild(k);
    }
    draw(c);
    return d;
  }
  // a programme (board 17B): the page's photo, its format, summary, what it builds for them and the run to register for
  function programmeCard(c) {
    var d = el("div", "lcp");
    var ph = el("div", "lcp-ph" + (c.photo ? "" : " is-blank"));
    if (c.photo) {
      var im = el("img");
      im.src = c.photo;
      im.alt = "";
      ph.appendChild(im);
    }
    d.appendChild(ph);
    var b = el("div", "lcp-b");
    b.appendChild(el("span", "lco-kick", c.kicker));
    b.appendChild(el("b", "lcp-t", c.title));
    if (c.summary) b.appendChild(el("p", "lcp-s", c.summary));
    var chips = el("div", "lcp-chips");
    (c.chips || []).forEach(function (x) { chips.appendChild(el("span", "lcp-chip", x)); });
    if (c.builds) chips.appendChild(el("span", "lcp-chip is-goal", c.builds));
    if (chips.childNodes.length) b.appendChild(chips);
    if (c.run) b.appendChild(el("p", "lco-line", c.run + (c.seats ? " · " + c.seats : "")));
    if (c.mine) b.appendChild(el("p", "lco-line", "Yours: " + c.mine));
    if (!c.open_to_you) b.appendChild(el("p", "lco-note", "Not open to your group, unit or grade."));
    else if (!c.register && !c.mine) b.appendChild(el("p", "lco-note", "No run open to register for right now."));
    var acts = el("div", "gp-acts");
    if (c.brochure) {
      var br = link(c.brochure, "Brochure (PDF)", false);
      br.target = "_blank";
      br.rel = "noopener";
      acts.appendChild(br);
    }
    acts.appendChild(link(c.page, "The full page", false));
    if (c.register) acts.appendChild(link(c.register, c.register_label || "Register", true));
    b.appendChild(acts);
    d.appendChild(b);
    return d;
  }
  // something already on their page: Go to it opens its tab and marks it (hooks.go), else follows its address
  function gotoCard(c, hooks) {
    var d = el("div", "lco-card lcg");
    d.appendChild(el("span", "lco-kick", "On your page" + (c.where ? " · " + c.where : "")));
    d.appendChild(el("b", "lco-card-t", c.title));
    if (c.sub) d.appendChild(el("p", "lco-line", c.sub));
    var acts = el("div", "gp-acts");
    var go = link(c.url, "Go to it", true);
    go.addEventListener("click", function (e) {
      if (hooks && hooks.go && hooks.go(c.anchor)) e.preventDefault();
    });
    acts.appendChild(go);
    d.appendChild(acts);
    return d;
  }
  // learning on the job, drafted from their own words (S11, board 4E): a form they check and send themselves; the
  // server screens it again and only their line manager confirms it
  function ojtCard(c) {
    var f = el("form", "lco-card lcj le-form");
    f.method = "post";
    f.action = c.action;
    f.setAttribute("data-confirm", "Send this to your line manager to confirm?");
    f.setAttribute("data-confirm-ok", "Send");
    var tk = el("input"); tk.type = "hidden"; tk.name = "csrf_token"; tk.value = token(); f.appendChild(tk);
    f.appendChild(el("span", "lco-kick", "Learning on the job · for your line manager to confirm"));
    var seg = el("fieldset", "ln-seg");
    seg.appendChild(el("legend", null, "Kind"));
    (c.kinds || []).forEach(function (k) {
      var lab = el("label"), r = el("input");
      r.type = "radio"; r.name = "kind"; r.value = k[0]; r.checked = k[0] === c.ojt_kind; r.required = true;
      lab.appendChild(r); lab.appendChild(el("span", null, k[1]));
      seg.appendChild(lab);
    });
    f.appendChild(seg);
    function field(label, name, val, area, max) {
      var l = el("label", "ls-full");
      l.appendChild(el("span", null, label));
      var i = el(area ? "textarea" : "input");
      i.name = name; i.value = val || ""; i.maxLength = max; i.required = name !== "when";
      if (area) i.rows = 2;
      l.appendChild(i);
      f.appendChild(l);
    }
    field("What was it?", "what", c.what, false, 200);
    field("Your example: what you did", "example", c.example, true, 400);
    var gl = el("label", "ls-full");
    gl.appendChild(el("span", null, "For your goal"));
    var sel = el("select", "modern-select"); sel.name = "goal_id";
    var none = el("option", null, "None of my goals"); none.value = ""; sel.appendChild(none);
    (c.goals || []).forEach(function (g) {
      var o = el("option", null, g.area); o.value = g.id; o.selected = g.id === c.goal_id; sel.appendChild(o);
    });
    gl.appendChild(sel);
    f.appendChild(gl);
    field("When", "when", c.when, false, 80);
    var acts = el("div", "le-acts");
    acts.appendChild(el("span", "ls-note", "+" + c.xp + " XP when your line manager confirms."));
    var b = el("button", "primary", "Send to your line manager"); b.type = "submit";
    acts.appendChild(b);
    f.appendChild(acts);
    return f;
  }
  function buildCard(c, hooks) {
    if (!c) return null;
    if (c.kind === "run") return runCard(c);
    if (c.kind === "request") return requestCard(c);
    if (c.kind === "month") return monthCard(c, hooks);
    if (c.kind === "programme") return programmeCard(c);
    if (c.kind === "goto") return gotoCard(c, hooks);
    if (c.kind === "ojt") return ojtCard(c);
    return null;
  }
  function agent(text, cards) {
    var a = el("div", "gp-a");
    if (text) a.appendChild(el("p", null, text));
    (cards || []).forEach(function (c) {
      var d = buildCard(c, { api: url });
      if (d) a.appendChild(d);
    });
    log.appendChild(a);
    scroll();
    return a;
  }
  function user(text) { log.appendChild(el("p", "gp-q", text)); scroll(); }
  function chips(items) {
    quick.innerHTML = "";
    (items || []).forEach(function (t) {
      var b = el("button", "gp-chip", t);
      b.type = "button";
      b.disabled = !live;
      b.addEventListener("click", function () { turn(t); });
      quick.appendChild(b);
    });
  }
  function turn(text) {
    text = (text || "").trim();
    if (!text || busy || !live) return;
    busy = true;
    if (send) send.disabled = true;
    user(text);
    chips([]);
    var thinking = el("p", "gp-thinking", "Looking…");
    log.appendChild(thinking);
    scroll();
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
        chips(j && j.quick_replies);
      })
      .catch(function () { thinking.remove(); agent("Connection lost. Try again in a moment."); })
      .then(function () { busy = false; if (send) send.disabled = !live; });
  }
  if (form) form.addEventListener("submit", function (e) {
    e.preventDefault();
    var t = input.value;
    input.value = "";
    turn(t);
  });
  function fold(on) {
    panel.hidden = !!on;
    if (rail) rail.hidden = !on;
    try { localStorage.setItem(FOLD_KEY, on ? "1" : "0"); } catch (e) { /* this browser only */ }
  }
  var fb = document.getElementById("lco-fold"), ob = document.getElementById("lco-open");
  if (fb) fb.addEventListener("click", function () { fold(true); });
  if (ob) ob.addEventListener("click", function () { fold(false); if (live) input.focus(); });

  fetch(url + "?page=" + encodeURIComponent(page), { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j || !j.ok) return;
      page = j.page || page;
      agent(j.opening.say, j.opening.cards);
      var last = j.opening.quick_replies;
      (j.messages || []).forEach(function (m) {
        if (m.role === "user") user(m.content);
        else { agent(m.content, m.cards); last = m.quick_replies; }
      });
      chips(last);
    })
    .catch(function () { agent("The coach couldn't load just now."); });
})();
