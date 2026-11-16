// "N more" opens in place; Show less at the end of the list folds it again (Chris, 2026-10-19: "after clicking the
// '12 more' or '+3', it will list down the item, then at the bottom of the list, show button to minimize it, apply to
// all screens with this sort of expansion"). A fold is <details class="fold">: its summary ("12 more job families")
// hides while it is open, and a [data-fold-less] button inside, last, closes it. Script-built lists do the same with
// their own buttons (journey_chat.js, dashboard.js). Loaded in base.html's head; listens on the document.
(function () {
  if (window.__fold) return;
  window.__fold = true;
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('[data-fold-less]');
    if (!b) return;
    var d = b.closest('details');
    if (!d) return;
    e.preventDefault();
    d.open = false;
    var s = d.querySelector(':scope > summary');
    if (s) {
      // back where the list started, so the page doesn't leave you below it
      var top = s.getBoundingClientRect().top;
      if (top < 60) s.scrollIntoView({ block: 'center' });
      s.focus({ preventScroll: true });
    }
  });
})();
