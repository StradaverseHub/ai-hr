/* One-row pill strip with left/right arrows.
 *
 * Shared by every place that picks a business unit: the 360 potential
 * calibration BG page, the performance calibration BG page, and the Talent
 * Box. One implementation so a company row behaves identically wherever you
 * meet it, rather than three that drift.
 *
 * The arrows page by a FULL visible row, not by one pill: a click should bring
 * the next set of companies into view, so scanning a long list is a few
 * deliberate presses rather than a nudge per unit. Overlap is deliberate at
 * zero -- a clean page keeps you oriented; leaving half a pill behind reads as
 * a rendering fault.
 *
 * Self-initialising over any .calib-bu-scroller present at load, and safe to
 * run twice (the data-pillscroller flag guards it), so a page can include this
 * alongside other scripts without ordering rules.
 */
(function () {
  function wire(scroller) {
    if (scroller.dataset.pillscroller === "1") return;
    scroller.dataset.pillscroller = "1";
    var pills = scroller.querySelector(".calib-bu-pills");
    if (!pills) return;
    var left = scroller.querySelector(".bu-nav--left");
    var right = scroller.querySelector(".bu-nav--right");

    // Tolerance for "already at the end". Deliberately several pixels rather
    // than 1: a flex row can report a small non-zero resting scrollLeft, and a
    // left arrow offering to scroll back 5px is a control that does nothing
    // visible. Still far below a pill's width, so it can never hide a real
    // scroll position.
    var EDGE = 8;

    function update() {
      // Hidden rather than disabled when there is nothing to scroll: an arrow
      // that can never do anything is furniture.
      var over = pills.scrollWidth > pills.clientWidth + EDGE;
      if (left) left.hidden = !over || pills.scrollLeft <= EDGE;
      if (right) right.hidden = !over ||
        pills.scrollLeft >= pills.scrollWidth - pills.clientWidth - EDGE;
    }
    function page(dir) {
      // Set an explicit, clamped target rather than scrollBy({behavior}):
      // the animation belongs to the stylesheet (.calib-bu-pills already has
      // scroll-behavior: smooth), so this stays smooth for a reader while
      // remaining a plain, testable assignment -- and it always lands exactly
      // on a page boundary or the end, never a fraction past it.
      var max = pills.scrollWidth - pills.clientWidth;
      var to = pills.scrollLeft + dir * pills.clientWidth;
      pills.scrollLeft = Math.max(0, Math.min(max, to));
    }
    if (left) left.addEventListener("click", function () { page(-1); });
    if (right) right.addEventListener("click", function () { page(1); });
    pills.addEventListener("scroll", update);
    window.addEventListener("resize", update);

    // Start with the selected pill in view -- on a long list the active
    // company is often off-screen at load, which reads as "nothing selected".
    // Measured with getBoundingClientRect rather than offsetLeft: the pill's
    // offsetParent is not this container, so offsetLeft is in the wrong
    // coordinate space and would scroll to the wrong place.
    var settled = false;
    function settle() {
      // At DOMContentLoaded the row can still measure zero-width, which makes
      // every measurement below meaningless -- so bail and wait for a pass
      // where the layout is real. Runs at most once for effect.
      if (settled || !pills.clientWidth) { update(); return; }
      settled = true;
      var on = pills.querySelector(".bu-pill.is-on");
      if (on) {
        var d = on.getBoundingClientRect().right - pills.getBoundingClientRect().right;
        if (d > 0) pills.scrollLeft += d + 12;
      }
      update();
    }
    settle();
    window.addEventListener("load", settle);
    // A pane that is hidden at load measures zero until it is shown, and
    // neither DOMContentLoaded nor load fires again then.
    if (window.ResizeObserver) new ResizeObserver(settle).observe(pills);
  }

  function init() {
    Array.prototype.forEach.call(
      document.querySelectorAll(".calib-bu-scroller"), wire);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
