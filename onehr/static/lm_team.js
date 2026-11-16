// The line manager's team (Chris, 2026-11-09; templates/_lm_team_panel.html and _lm_team_step2.html): the LM of N list panel in team
// mode. Step 1: ticking people turns the panel's foot into the bar (N ticked, the part chips, "Reopen or give time...") and the button
// opens step 2 in the same panel (a GET fragment, window.onehrPanel.list). Step 2: the reason box enables the foot's red-confirm button.
// This file only shows and collects; every rule is the server's (_lm_team_plan / _lm_team_apply). Built from DOM nodes, never HTML strings.
(function () {
  "use strict";
  var ORDER = ["pm_mod", "tc_review", "idp_review"];

  function boot() {
    // the fragment's own script runs before the panel's foot controls are in place: look once it is settled
    setTimeout(function () {
      var panel = document.getElementById("pnl-list");
      var root = panel && panel.querySelector(".lmt");
      if (!root || root.__lmt) return;
      root.__lmt = true;
      var foot = panel.querySelector(".adm-panel-foot");
      var nEl = foot.querySelector("[data-lmt-n]"), chipsEl = foot.querySelector("[data-lmt-chips]");
      var goEl = foot.querySelector("[data-lmt-go]");
      var page = foot.querySelector("[data-list-page]"), done = foot.querySelector(".primary[data-panel-close]");
      var picks = [].slice.call(root.querySelectorAll(".lmt-pick")).filter(function (c) { return !c.disabled; });
      var all = root.querySelector(".lmt-all");
      var chips = [].slice.call(foot.querySelectorAll("[data-lmt-chip]"));
      var on = {}, touched = false;
      if (all) all.disabled = !picks.length;

      function acts(c) { return (c.getAttribute("data-acts") || "").split(",").filter(Boolean); }
      function update() {
        var ticked = picks.filter(function (c) { return c.checked; });
        var avail = {};
        ticked.forEach(function (c) { acts(c).forEach(function (p) { avail[p] = true; }); });
        if (!touched) { on = {}; Object.keys(avail).forEach(function (p) { on[p] = true; }); }
        else Object.keys(on).forEach(function (p) { if (!avail[p]) delete on[p]; });
        var has = ticked.length > 0;
        picks.forEach(function (c) { var tr = c.closest("tr"); if (tr) tr.classList.toggle("is-picked", c.checked); });
        if (all) {
          all.checked = has && ticked.length === picks.length;
          all.indeterminate = has && ticked.length < picks.length;
        }
        if (nEl) { nEl.hidden = !has; nEl.firstChild.textContent = ticked.length + " ticked"; }
        if (chipsEl) chipsEl.hidden = !has;
        chips.forEach(function (b) {
          var p = b.getAttribute("data-lmt-chip");
          b.disabled = !avail[p];
          b.classList.toggle("is-on", !!on[p]);
          b.setAttribute("aria-pressed", on[p] ? "true" : "false");
        });
        if (goEl) { goEl.hidden = !has; goEl.disabled = !Object.keys(on).length; }
        if (page) page.hidden = has;
        if (done) done.hidden = has;
        foot.classList.toggle("is-lmt-bar", has);
      }
      picks.forEach(function (c) { c.addEventListener("change", update); });
      if (all) all.addEventListener("change", function () { picks.forEach(function (c) { c.checked = all.checked; }); update(); });
      chips.forEach(function (b) {
        b.addEventListener("click", function () {
          var p = b.getAttribute("data-lmt-chip");
          if (b.disabled) return;
          touched = true;
          if (on[p]) delete on[p]; else on[p] = true;
          update();
        });
      });
      if (goEl) goEl.addEventListener("click", function () {
        var ids = picks.filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
        var parts = ORDER.filter(function (p) { return on[p]; });
        if (!ids.length || !parts.length || !window.onehrPanel) return;
        window.onehrPanel.list(root.getAttribute("data-lmt-src") + "&step=2&ids=" + ids.join(",") + "&parts=" + parts.join(","));
      });
      update();
    }, 0);
  }

  function boot2() {
    setTimeout(function () {
      var panel = document.getElementById("pnl-list");
      var root = panel && panel.querySelector(".lmt-s2");
      if (!root || root.__lmt) return;
      root.__lmt = true;
      var foot = panel.querySelector(".adm-panel-foot");
      var page = foot.querySelector("[data-list-page]");
      if (page) page.hidden = true;
      var send = foot.querySelector("[data-lmt-send]"), ta = root.querySelector("#lmt-why");
      var cnt = root.querySelector("[data-lmt-count]");
      if (!send || !ta) return;
      function sync() {
        var n = ta.value.length;
        if (cnt) cnt.textContent = String(n);
        send.disabled = send.hasAttribute("data-lmt-none") || !ta.value.trim();
      }
      ta.addEventListener("input", sync);
      sync();
    }, 0);
  }
  window.lmTeamBoot = boot;
  window.lmTeamBoot2 = boot2;
})();
