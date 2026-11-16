/* Dashboard -> module: the OneHR agent hands you over (Chris, 2026-10-16: "go with A" on the canvas "OneHR Moving To
   Transition"). A click on a link into a module (the AI+ check-in, a leader view, KPI approval) puts a veil over
   everything under the top bar, with the agent's spark turning once, "Moving to <where>" and what's first there, and a
   line filling; the browser goes after a short beat, and the veil stays until the module paints, where move_in.js fades
   it away. A slow page just keeps the agent up longer. Every word is set as text. */
(function () {
  "use strict";
  var HOLD = 550;   // ms before the browser goes: long enough to read where it's taking you
  var SPARK_D = "M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z";
  // where a link goes, in words: the AI+ journey by its view (and the Mine view by its part), the two KPI-setting pages
  var VIEWS = {
    team: ["Moving to your Team review", "Your team's reviews"],
    dept: ["Moving to your Department Review", "Your department's bands"],
    bu: ["Moving to BU calibration", "Performance and potential, on the curve"],
    bg: ["Moving to the Talent Box", "One business unit at a time"],
    group: ["Moving to the group's Talent Box", "Your calibration group, batch by batch"]
  };
  var PARTS = {
    account: "Your KPI check-in", feedback: "360 feedback for your colleagues", competency: "Your competency assessment",
    career_plan: "Your Career Plan", pm_review: "Their KPI check-ins", tm_review: "Their competency assessments",
    idp_review: "Their Career Plans"
  };
  var PAGES = {
    "/review/setting": ["Moving to your KPI setting", "Build your scorecard with AI"],
    "/performance/setting/review": ["Moving to KPI approval", "Approve each scorecard, or send it back"],
    "/learning": ["Moving to AI+ Learning", "Your learning"]
  };
  // AI+ Learning's own views (2026-10-20): its Team and Dept views say whose learning it opens on
  var LEARN = { team: "Your team's learning", dept: "Your department's learning", mine: "Your learning" };

  function where(a) {
    var u;
    try { u = new URL(a.href, window.location.href); } catch (e) { return null; }
    if (u.origin !== window.location.origin) return null;
    if (u.pathname === "/learning") return [PAGES["/learning"][0], LEARN[u.searchParams.get("view") || ""] || PAGES["/learning"][1]];
    if (PAGES[u.pathname]) return PAGES[u.pathname];
    if (u.pathname !== "/review" && u.pathname.indexOf("/review/") !== 0) return null;
    if (u.pathname.indexOf("/review/") === 0 && u.pathname !== "/review/journey") return null;   // a chat's own calls
    var q = u.searchParams, v = VIEWS[q.get("view") || ""];
    var part = PARTS[q.get("stage") || ""];
    // a calibration group's calibrator reads CG, not BU (2026-10-26): the tab's own title says which
    // ...and a BG CFO's reads BGCFO (2026-11-04)
    if (v && (q.get("view") || "") === "bu" && (a.getAttribute("title") || "") === "CG Calibration")
      v = ["Moving to CG calibration", v[1]];
    else if (v && (q.get("view") || "") === "bu" && (a.getAttribute("title") || "") === "BGCFO Calibration")
      v = ["Moving to BGCFO calibration", v[1]];
    if (v) return [v[0], part || v[1]];
    return ["Moving to your AI check-in", part || "Picking up where you left off"];
  }

  var veil = null;
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }
  function show(to, sub) {
    hide();
    veil = el("div", "mv-veil");
    veil.setAttribute("role", "status");
    veil.setAttribute("aria-live", "polite");
    var stack = el("div", "mv-stack");
    var tile = el("span", "mv-tile");
    tile.setAttribute("aria-hidden", "true");
    var sv = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    sv.setAttribute("viewBox", "0 0 24 24");
    sv.setAttribute("class", "mv-spark");
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", SPARK_D);
    sv.appendChild(path);
    tile.appendChild(sv);
    stack.appendChild(tile);
    stack.appendChild(el("p", "mv-to", to));
    if (sub) stack.appendChild(el("p", "mv-sub", sub));
    var bar = el("span", "mv-bar");
    bar.setAttribute("aria-hidden", "true");
    bar.appendChild(el("span"));
    stack.appendChild(bar);
    veil.appendChild(stack);
    document.body.appendChild(veil);
  }
  function hide() { if (veil) { veil.remove(); veil = null; } }

  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest ? e.target.closest("a[href]") : null;
    if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download") || a.hasAttribute("data-no-move")) return;
    var w = where(a);
    if (!w) return;
    e.preventDefault();
    var sub = a.getAttribute("data-move-sub") || w[1];
    show(w[0], sub);
    try { sessionStorage.setItem("onehr-move", String(Date.now())); } catch (err) { /* no fade on arrival, that's all */ }
    var href = a.href;
    setTimeout(function () { window.location.assign(href); }, HOLD);
    setTimeout(hide, 15000);   // a cancelled or failed load never leaves the veil up for good
  });
  // Back to the dashboard from the module: a page restored from the back-forward cache comes back without the veil
  window.addEventListener("pageshow", function (e) { if (e.persisted) hide(); });
})();
