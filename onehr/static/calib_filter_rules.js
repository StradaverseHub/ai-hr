/* Calibration & Talent > Settings > Filters at BU level: one filter's rule panel (Chris, 2026-10-30; canvas
   [design canvas link removed], Option 2). The panel's form posts the units ticked and the screens
   ticked; this script only tells the person what saving would do: it keeps Save off until something changes, writes the
   confirm box's words (data-confirm, data-confirm-list: base.html reads them BEFORE the box opens) naming each unit and
   screen change, and draws the "what leaders will see" preview. The server writes units x screens and refuses what it
   should not (a unit with no values, a screen the filter does not take). */
(function () {
  "use strict";
  function viewsOf(form) {
    return [].map.call(form.querySelectorAll("[data-cfr-screen]"), function (c) {
      return { key: c.getAttribute("data-cfr-screen"), short: c.getAttribute("data-cfr-short"), box: c };
    });
  }
  function wire(form) {
    var label = form.getAttribute("data-cfr-label") || "this";
    var searchMin = parseInt(form.getAttribute("data-cfr-search") || "9", 10);
    var units = [].slice.call(form.querySelectorAll("[data-cfr-unit]"));
    var save = form.querySelector("[data-cfr-save]"), status = form.querySelector("[data-cfr-status]");
    var views = viewsOf(form), base = "Nothing has changed for the " + label + " filter.";
    function name(li) { var b = li.querySelector(".cfr-uname b"); return b ? b.textContent : ""; }
    function sync() {
      var picked = {};
      views.forEach(function (v) { picked[v.key] = v.box.checked; });
      var lines = [], n = 0, tickedUnits = 0;
      units.forEach(function (li) {
        var tick = li.querySelector("[data-cfr-tick]");
        var on = tick && tick.checked && !tick.disabled;
        if (on) tickedUnits++;
        var moved = false;
        views.forEach(function (v) {
          var was = li.getAttribute("data-was-" + v.key) === "1", want = !!(on && picked[v.key]);
          if (was !== want) {
            moved = true; n++;
            lines.push(name(li) + " · " + v.short + ": " + (want ? "shown" : "hidden") + " (was " + (was ? "shown" : "hidden") + ")");
          }
        });
        li.classList.toggle("is-changed", moved);
      });
      var noScreen = tickedUnits > 0 && !views.some(function (v) { return picked[v.key]; });
      save.disabled = !n || noScreen;
      status.textContent = noScreen ? "Pick at least one screen." : n ? n + (n === 1 ? " change" : " changes") + " not saved" : "Nothing changed yet.";
      form.setAttribute("data-confirm", n
        ? "Save the " + label + " filter? It changes what leaders see the next time they open the screen. No band, lock or move changes. You can set it back here at any time."
        : base);
      form.setAttribute("data-confirm-list", JSON.stringify(lines));
      form.setAttribute("data-confirm-list-label", n ? "What changes" : "");
      // what leaders will see: the largest unit among the ticked ones (all of them with the filter available, when none is ticked)
      var pool = units.filter(function (li) { var t = li.querySelector("[data-cfr-tick]"); return t && !t.disabled && (tickedUnits ? t.checked : true); });
      var best = pool.reduce(function (b, li) {
        var k = parseInt(li.getAttribute("data-kinds") || "0", 10);
        return !b || k > b.k ? { k: k, p: parseInt(li.getAttribute("data-people") || "0", 10) } : b;
      }, null);
      var nEl = form.querySelector("[data-cfr-prev-n]"), tEl = form.querySelector("[data-cfr-prev-t]");
      if (nEl && best) nEl.textContent = String(best.p);
      if (tEl) tEl.textContent = best && best.k ? best.k + " choices, " + (best.k >= searchMin ? "so a list with search" : "a short list") : "";
    }
    form.addEventListener("change", sync);
    var all = form.querySelector("[data-cfr-all]");
    if (all) all.addEventListener("click", function () {
      units.forEach(function (li) { var t = li.querySelector("[data-cfr-tick]"); if (t && !t.disabled) t.checked = true; });
      sync();
    });
    form.addEventListener("reset", function () { setTimeout(sync, 0); });
    sync();
  }
  function boot() { [].forEach.call(document.querySelectorAll("form[data-cfr-form]"), wire); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
