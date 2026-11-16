/* Calibration & Talent > Settings > Filters, the per-viewer tabs (Chris, 2026-11-02; canvas "OneHR Calibration Filters by Viewer").
   A calibrator's panel, a Group Chief group's panel and the Executive Chairman's list each post ONE viewer's ticks to
   admin_calib_viewer_filter. This script only tells the person what saving would do: it keeps Save off until a tick changes,
   writes the confirm box's words (data-confirm and data-confirm-list: base.html reads them BEFORE the box opens) naming who and
   each filter that goes on or off, and draws the "what they will see" filter line from the ticks. The server writes every key and
   refuses what it should not. */
(function () {
  "use strict";
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function chip(label, n) {
    var c = el("span", "cfr-chip");
    c.setAttribute("aria-hidden", "true");
    c.appendChild(document.createTextNode(label + " "));
    c.appendChild(el("b", null, String(n)));
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "12"); svg.setAttribute("height", "12"); svg.setAttribute("viewBox", "0 0 24 24");
    var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", "M6 9l6 6 6-6"); svg.appendChild(p); c.appendChild(svg);
    return c;
  }
  function wire(form) {
    var who = form.getAttribute("data-vf-who") || "this viewer";
    var wasSet = form.getAttribute("data-vf-set") === "1";
    var ticks = [].slice.call(form.querySelectorAll("[data-vf-tick]"));
    var save = form.querySelector("[data-vf-save]"), status = form.querySelector("[data-vf-status]");
    var prev = form.querySelector("[data-vf-prev]");
    var base = "Nothing has changed for " + who + ".";
    function rowOf(t) { return t.closest("[data-vf-row]"); }
    function label(t) { return rowOf(t).getAttribute("data-label"); }
    function sync() {
      var lines = [], n = 0;
      ticks.forEach(function (t) {
        var was = t.getAttribute("data-was") === "1", now = !!(t.checked && !t.disabled);
        var row = rowOf(t);
        if (row) row.classList.toggle("is-changed", was !== now);
        if (was !== now) { n++; lines.push(label(t) + ": " + (now ? "shown" : "hidden") + " (was " + (was ? "shown" : "hidden") + ")"); }
      });
      save.disabled = !n;
      status.textContent = n ? n + (n === 1 ? " change" : " changes") + " not saved" : "Nothing changed yet.";
      form.setAttribute("data-confirm", n
        ? "Save filters for " + who + "? It changes what they see the next time they open the screen. No band, lock or move changes."
          + (wasSet ? "" : " They then keep these filters of their own.") + " You can set it back here at any time."
        : base);
      form.setAttribute("data-confirm-list", JSON.stringify(lines));
      form.setAttribute("data-confirm-list-label", n ? "What changes" : "");
      if (prev) {
        var holder = prev.querySelector("[data-vf-chips]"), none = prev.querySelector("[data-vf-none]");
        var count = parseInt(prev.getAttribute("data-n") || "0", 10), shown = 0;
        holder.textContent = "";
        ticks.forEach(function (t) {
          if (!(t.checked && !t.disabled)) return;
          var row = rowOf(t);
          holder.appendChild(chip("All " + row.getAttribute("data-plural"), count));
          shown++;
        });
        var lead = prev.querySelectorAll("[data-vf-lead]").length;
        if (none) {
          none.hidden = !!(shown || lead);
          none.textContent = shown || lead ? "" : "No filter line: nothing is ticked.";
        }
      }
    }
    form.addEventListener("change", sync);
    form.addEventListener("reset", function () { setTimeout(sync, 0); });
    sync();
  }
  function boot() { [].forEach.call(document.querySelectorAll("form[data-vf-form]"), wire); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
