/* The first sign-in, in the guide panel (Chris, 2026-10-15; canvas "OneHR Display Name and Avatar"): what to call them,
   then a picture, then a look around the dashboard, one part at a time. The rest of the page is dimmed and inert until
   it is done. Every step is answered by the server without a model (/onboard/name, /onboard/picture, /onboard/tour);
   a finished step reloads the page, which renders the next one. Text from the server is drawn as text, never HTML. */
(function () {
  "use strict";
  var panel = document.getElementById("ob-panel");
  if (!panel) return;
  var log = document.getElementById("ob-log");
  var step = panel.getAttribute("data-step");
  var busy = false;

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
  function post(url, fields) {
    var body = new FormData();
    body.append("csrf_token", csrf());
    Object.keys(fields).forEach(function (k) { body.append(k, fields[k]); });
    return fetch(url, { method: "POST", body: body, credentials: "same-origin",
                        headers: { "X-Requested-With": "fetch" } })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  function scrollDown() { log.scrollTop = log.scrollHeight; }
  function lost() {
    log.appendChild(el("p", "gp-lead", "That didn't go through. Try again in a moment."));
    scrollDown();
  }

  // ---- 1. the name ------------------------------------------------------------------------------------------------
  if (step === "name") {
    var form = document.getElementById("ob-form");
    var input = document.getElementById("ob-input");
    var send = form.querySelector(".gp-send");
    var urlName = panel.getAttribute("data-url-name");

    var confirmName = function (name) {
      busy = true;
      post(urlName, { name: name, confirm: "1" }).then(function (d) {
        if (d && d.ok) { window.location.reload(); return; }
        busy = false;
        log.appendChild(el("p", "gp-lead", (d && d.say) || "That didn't go through. Try again in a moment."));
        scrollDown();
      }, function () { busy = false; lost(); });
    };
    var check = function (text) {
      text = (text || "").trim();
      if (!text || busy) return;
      busy = true;
      send.disabled = true;
      log.appendChild(el("p", "gp-q", text));
      scrollDown();
      post(urlName, { name: text }).then(function (d) {
        busy = false;
        send.disabled = false;
        if (!d || !d.ok) {
          log.appendChild(el("p", "gp-lead", (d && d.say) || "What should I call you?"));
          scrollDown();
          input.focus();
          return;
        }
        var wrap = el("div", "gp-a");
        var p = el("p", null, "Shall I call you ");
        p.appendChild(el("strong", null, d.confirm));
        p.appendChild(document.createTextNode("?"));
        wrap.appendChild(p);
        var row = el("div", "gp-acts");
        var yes = el("button", "gp-act is-primary", "Yes, call me " + d.confirm);
        yes.type = "button";
        yes.addEventListener("click", function () { yes.disabled = true; confirmName(d.confirm); });
        var no = el("button", "gp-act", "Change it");
        no.type = "button";
        no.addEventListener("click", function () {
          wrap.remove();
          log.appendChild(el("p", "gp-lead", "No problem. What should I call you?"));
          scrollDown();
          input.focus();
        });
        row.appendChild(yes);
        row.appendChild(no);
        wrap.appendChild(row);
        log.appendChild(wrap);
        scrollDown();
        yes.focus();
      }, function () { busy = false; send.disabled = false; lost(); });
    };
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var t = input.value;
      input.value = "";
      check(t);
    });
    panel.addEventListener("click", function (e) {
      var s = e.target.closest && e.target.closest(".ob-suggest");
      if (s) check(s.getAttribute("data-name"));
    });
    setTimeout(function () { input.focus(); }, 60);
    return;
  }

  // ---- 2. the picture ---------------------------------------------------------------------------------------------
  if (step === "picture") {
    var urlPic = panel.getAttribute("data-url-picture");
    var pics = Array.prototype.slice.call(panel.querySelectorAll(".ob-pic input"));
    pics.forEach(function (r) {
      r.addEventListener("change", function () {
        pics.forEach(function (x) { x.closest(".ob-pic").classList.toggle("is-on", x.checked); });
      });
    });
    var save = function (n) {
      if (busy) return;
      busy = true;
      post(urlPic, { avatar: String(n) }).then(function (d) {
        if (d && d.ok) { window.location.reload(); return; }
        busy = false;
        lost();
      }, function () { busy = false; lost(); });
    };
    document.getElementById("ob-pic-use").addEventListener("click", function () {
      var on = pics.filter(function (x) { return x.checked; })[0];
      save(on ? on.value : 0);
    });
    document.getElementById("ob-pic-keep").addEventListener("click", function () { save(0); });
    return;
  }

  // ---- 3. a look around: each part lifted out of the dim in turn --------------------------------------------------
  var running = panel.getAttribute("data-mode") === "running";
  var STOPS = [
    { sel: [".topbar"], title: "The top bar",
      text: "The pill says where the cycle is and when your part closes. Your picture opens Account, where your " +
            "Profile shows your work details and changes your name or your picture." },
    { sel: ["#acct-trigger"], title: "What's new and Get Help",
      text: "Also in Account: What's new, the changes in AI+ OneHR that you can use (a new one pops out once on your dashboard), " +
            "and Get Help, with quick answers for the page you're on and Report a problem if something isn't working. " +
            "Group People replies to you there." },
    // the Executive Chairman's own stops (P5, 2026-10-29): his dashboard has these cards and nobody else's does, so they show
    // for him alone (only: the stop needs it on the page; not: the stop is for everyone else's page, not his)
    // AI+ OneHR, his talent chat (2026-10-30; the panel carries the class ecp while ONEHR_EC_PA is on): the left panel is his talent
    // partner, so the stop shows for him alone, and only while the chat is there
    { only: "#ask-panel.ecp", sel: ["#ask-panel.ecp"], title: "AI+ OneHR, your talent partner",
      text: "Ask it who fits a position, for someone's history, years with us and talent status, how to fill a new role, or who is " +
            "key. It never shows 360 remarks, KPI lines, competency remarks or Career Plan text. Drag its right edge to widen it, " +
            "or press Expand." },
    { only: ".ec-top", sel: [".ec-top"], title: "Your Year-End",
      text: "Your part of the Year-End: your 360 ratings, your leaders' Talent Box (where you place your BG CEOs, Group " +
            "Chiefs and senior leaders, then lock), and when results go to leaders. Between cycles it shows your last Year-End's " +
            "steps. Each step opens where it is done." },
    { only: ".ec-top", sel: ["[data-chair-insight]"], title: "The AI insight",
      text: "A few findings counted from the latest released Year-End, worded by AI+. Each from this cycle has a link that " +
            "opens the people behind it in the Group Talent Box." },
    { only: ".ec-top", sel: [".ec-bgs"], title: "Talent by business group",
      text: "A card for each business group. A card opens that group in the Group Talent Box: every group, read only, " +
            "with a short summary behind each name and the Stars and Super Stars in Excel. It shows once results go to leaders." },
    { only: ".ec-top", sel: ['[data-chair-step="leaders"]'], title: "Your leaders' Talent Box",
      text: "Your BG CEOs, Group Chiefs and the senior leaders Group People adds, and each BU CEO once their BG CEO has locked their unit. Place or move them " +
            "with a short reason, then Lock Talent Box: the lock is final. It opens with the BG CEO Talent Box; until then its step shows the date." },
    { not: ".ec-top", sel: [".od-rail"], title: running ? "The cycle, step by step" : "Your last cycle, step by step",
      text: running ? "Every part of the cycle, who does it, and where you are in it. Each step opens where it is done."
                    : "What happened at each step of your last cycle, and when." },
    { sel: [".od-here"], title: "You are here",
      text: "What needs you now. The red button opens your AI check-in, where you do the work with the AI." },
    { sel: [".od-res"], title: "Your results",
      text: "Your last cycle's results show here once Group People releases them: your final bands, your talent status and an AI " +
            "read of how it went." },
    { sel: [".od-led"], title: "What you led", text: "Your people's results, once they are released to you." },
    { sel: [".od-stand"], title: "Where you stand",
      text: "Your own results this cycle, up to your line manager. Your final bands reach your history once " +
            "Group People releases them." },
    { sel: [".od-bu", ".od-bg"], title: "Where your business is",
      text: "Where your units, or your Calibration Group, stand in the reviews and calibration, and whether each is ready " +
            "to lock. On a business unit's card, Own shows your own results this cycle. A calibration group's card has it too." },
    { sel: ["[data-subs-strip]", "[data-subs-entry]"], title: "Who has submitted",   // dropped where neither is on the page
      text: "Your own people, part by part: who has submitted, who is yet to, and who has more time. It shows who has done a part " +
            "and when, never a result, and nothing downloads from it." },
    { sel: [".od-notin"], title: "Not in this cycle's review", text: "Why you aren't reviewed this cycle, and what is still yours." },
    { sel: [".od-planc"], title: "This year's plan", text: "Your Career Plan for the year, and your check-ins on it." },
    { sel: [".od-learn"], title: "Your learning",
      text: "AI+ Learning: courses that build your Career Plan, your requests, and what you've used from them. " +
            "Open AI+ Learning to find a course or check in." },
    { sel: [".ghl-card"], title: "Grade H Appraisal",
      text: "Your Grade H staff to appraise: how many are ready for you, with their staff, and done. Open Grade H Appraisal " +
            "to appraise them." },
    { sel: [".od-hist", ".od-tools"], all: true, title: "Your history and your tools",
      text: "Your past cycles by year, your Career Plan and your 360 report. Each opens beside the dashboard." },
    // on a phone (2026-11-07) Ask OneHR is the card at the foot of the dashboard, so the last stop points there
    { sel: ["#ob-panel"], phone: [".od-askfoot"], title: "And me",
      text: "Ask me where anything is, or what is pending, and I will take you there. That's the tour." }
  ];
  var stops = STOPS.filter(function (s) {
    return (!s.only || document.querySelector(s.only)) && (!s.not || !document.querySelector(s.not));
  }).map(function (s) {
    var nodes = [];
    var sels = (window.onehrIsPhone && window.onehrIsPhone() && s.phone) ? s.phone : s.sel;
    for (var i = 0; i < sels.length; i++) {
      // a stop never points at something that is not drawn (a phone hides some desktop pieces): only visible nodes count
      var found = Array.prototype.slice.call(document.querySelectorAll(sels[i])).filter(function (n) { return n.getClientRects().length > 0; });
      if (found.length) { nodes = nodes.concat(s.all ? found : [found[0]]); if (!s.all) break; }
    }
    return { title: s.title, text: s.text, nodes: nodes };
  }).filter(function (s) { return s.nodes.length; });
  var at = 0;
  var kEl = document.getElementById("ob-tour-k");
  var tEl = document.getElementById("ob-tour-t");
  var xEl = document.getElementById("ob-tour-x");
  var next = document.getElementById("ob-tour-next");
  var urlTour = panel.getAttribute("data-url-tour");

  function unspot() {
    Array.prototype.forEach.call(document.querySelectorAll(".ob-spot"), function (n) { n.classList.remove("ob-spot"); });
  }
  function show() {
    var s = stops[at];
    unspot();
    s.nodes.forEach(function (n) { n.classList.add("ob-spot"); });
    var ph = !!(window.onehrIsPhone && window.onehrIsPhone());   // on a phone the panel is a sheet over the foot: bring the spot to the top
    try { s.nodes[0].scrollIntoView({ block: ph ? "start" : "nearest", behavior: "smooth" }); } catch (e) { s.nodes[0].scrollIntoView(); }
    kEl.textContent = "A look around · " + (at + 1) + " of " + stops.length;
    tEl.textContent = s.title;
    xEl.textContent = s.text;
    next.textContent = at === stops.length - 1 ? "Start using OneHR" : "Next ›";
    next.focus();
  }
  function finish() {
    if (busy) return;
    busy = true;
    unspot();
    post(urlTour, {}).then(function () { window.location.reload(); }, function () { busy = false; lost(); });
  }
  next.addEventListener("click", function () {
    if (at < stops.length - 1) { at += 1; show(); } else { finish(); }
  });
  document.getElementById("ob-tour-skip").addEventListener("click", finish);
  show();
})();
