/* Transferred (2026-11-03): the person page's Performance tab card. It opens and closes the form, keeps "Year-End weight" at
   100 minus the Mid-Year weight, keeps the confirm box's words in step, and asks the SERVER for the result preview (the page
   works no figure out). Delegated, so a card loaded into a side panel works too. */
(function () {
  "use strict";
  if (window.__splitYear) return;
  window.__splitYear = true;
  var timer = null, seq = 0;

  function card(el) { return el && el.closest ? el.closest("#pp-split") : null; }
  function form(c) { return c ? c.querySelector("#pp-split-form") : null; }
  function weight(f) {
    var v = f.querySelector("#pp-split-w"), n = parseInt(v.value, 10);
    return (/^\d+$/.test(String(v.value).trim()) && n >= 1 && n <= 99) ? n : null;
  }
  function on(c) { return c.classList.contains("is-on"); }

  function say(c) {   // the live words: Year-End weight, the confirm box's message
    var f = form(c), w = weight(f), wy = f.querySelector("#pp-split-wy");
    wy.textContent = w == null ? "—" : (100 - w) + "%";
    var who = c.getAttribute("data-split-name") || "";
    f.setAttribute("data-confirm", (on(c) ? "Change " + who + ": Mid-Year " : "Mark " + who + " as transferred: Mid-Year ")
      + (w == null ? "?" : w) + "% / Year-End " + (w == null ? "?" : 100 - w) + "%?");
    if (w == null) return;
    clearTimeout(timer);
    timer = setTimeout(function () { preview(c, f, w); }, 250);
  }

  function preview(c, f, w) {
    var url = c.getAttribute("data-preview");
    if (!url || !window.fetch) return;
    var mine = ++seq;
    fetch(url + "?w=" + w, { credentials: "same-origin", headers: { "X-Requested-With": "fetch" } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (mine !== seq || !j || !j.ok) return;
        var res = f.querySelector("#pp-split-res"), b = f.querySelector("#pp-split-resb"), calc = f.querySelector("#pp-split-calc");
        res.textContent = j.figure || (j.band ? "" : "—");
        if (j.band) { b.hidden = false; b.textContent = j.band; b.setAttribute("data-band", j.band); } else { b.hidden = true; }
        calc.textContent = (j.text || "") + (j.text && !j.final ? " (Year-End lines not all moderated yet)" : "");
      }, function () { /* the preview is a nicety: the save still works and the server decides */ });
  }

  // The Mid-Year | Year-End toggle (the person page's Performance tab): both halves are in the page, the switch only shows one.
  document.addEventListener("click", function (e) {
    var hb = e.target.closest ? e.target.closest("#pp-half-seg [data-half]") : null;
    if (!hb) return;
    var half = hb.getAttribute("data-half");
    [].forEach.call(hb.parentNode.querySelectorAll("[data-half]"), function (b) {
      var on = b === hb; b.classList.toggle("on", on); b.setAttribute("aria-checked", on ? "true" : "false");
    });
    var ye = document.getElementById("pp-half-ye"), mid = document.getElementById("pp-half-mid"), note = document.getElementById("pp-half-ye-note");
    if (ye) ye.hidden = half !== "ye";
    if (mid) mid.hidden = half !== "mid";
    if (note) note.hidden = half !== "ye";
  });
  document.addEventListener("click", function (e) {
    var t = e.target.closest ? e.target.closest("[data-split-open],[data-split-close]") : null;
    if (!t) return;
    var c = card(t), f = form(c);
    if (!f) return;
    if (t.hasAttribute("data-split-close")) { f.hidden = true; return; }
    f.hidden = false;
    var w = f.querySelector("#pp-split-w"); if (w) w.focus();
    say(c);
  });
  document.addEventListener("input", function (e) {
    if (e.target && e.target.id === "pp-split-w") say(card(e.target));
  });
})();
