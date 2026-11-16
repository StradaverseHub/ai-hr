/* Minimal, dependency-free product tour: dims the page, rings the target
   element, and shows a tooltip with Back / Skip / Next controls.

   L360Tour(steps, { onDone })
     steps: [{ el: "<css selector>", title, body, side? ("top"|"bottom") }]
     onDone(skipped): called once when the tour finishes or is skipped.
   Steps whose element isn't on the page are skipped automatically. */
(function (global) {
  function L360Tour(steps, opts) {
    opts = opts || {};
    steps = (steps || []).filter(function (s) { return document.querySelector(s.el); });
    if (!steps.length) { if (opts.onDone) opts.onDone(false); return; }
    var i = 0, ov, spot, pop;

    function mk(tag, cls, html) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (html != null) e.innerHTML = html;
      return e;
    }

    function build() {
      ov = mk("div", "tour-overlay");
      spot = mk("div", "tour-spot");
      pop = mk("div", "tour-pop");
      document.body.appendChild(ov);
      document.body.appendChild(spot);
      document.body.appendChild(pop);
      window.addEventListener("resize", reposition);
      window.addEventListener("scroll", reposition, true);
      document.addEventListener("keydown", onKey);
    }

    function onKey(e) {
      if (e.key === "Escape") finish(true);
      else if (e.key === "Enter") { e.preventDefault(); next(); }
    }

    function showStep() {
      var s = steps[i];
      var t = document.querySelector(s.el);
      if (!t) { return next(); }
      t.scrollIntoView({ block: "center", inline: "nearest" });
      pop.innerHTML = "";
      pop.appendChild(mk("div", "tour-pop-head", s.title || ""));
      pop.appendChild(mk("div", "tour-pop-body", s.body || ""));
      var foot = mk("div", "tour-pop-foot");
      foot.appendChild(mk("span", "tour-count", (i + 1) + " of " + steps.length));
      var spc = mk("span", "tour-spacer"); foot.appendChild(spc);
      var skip = mk("button", "tour-btn tour-skip", "Skip"); skip.type = "button";
      skip.onclick = function () { finish(true); }; foot.appendChild(skip);
      if (i > 0) {
        var back = mk("button", "tour-btn", "Back"); back.type = "button";
        back.onclick = prev; foot.appendChild(back);
      }
      var nx = mk("button", "tour-btn tour-next", i === steps.length - 1 ? "Done" : "Next");
      nx.type = "button"; nx.onclick = next; foot.appendChild(nx);
      pop.appendChild(foot);
      requestAnimationFrame(reposition);
    }

    function reposition() {
      var s = steps[i]; var t = s && document.querySelector(s.el);
      if (!t) return;
      var r = t.getBoundingClientRect(), pad = 6;
      spot.style.top = (r.top - pad) + "px";
      spot.style.left = (r.left - pad) + "px";
      spot.style.width = (r.width + pad * 2) + "px";
      spot.style.height = (r.height + pad * 2) + "px";

      var pw = pop.offsetWidth, ph = pop.offsetHeight, gap = 12, vw = innerWidth, vh = innerHeight;
      var below = r.bottom + gap + ph <= vh, above = r.top - gap - ph >= 0;
      var side = s.side || (below ? "bottom" : (above ? "top" : "bottom"));
      var top = side === "top" ? r.top - gap - ph : r.bottom + gap;
      if (top < 8) top = 8;
      if (top + ph > vh - 8) top = vh - ph - 8;
      var left = r.left + r.width / 2 - pw / 2;
      if (left < 8) left = 8;
      if (left + pw > vw - 8) left = vw - pw - 8;
      pop.style.top = top + "px";
      pop.style.left = left + "px";
    }

    function next() { if (i >= steps.length - 1) finish(false); else { i++; showStep(); } }
    function prev() { if (i > 0) { i--; showStep(); } }

    function finish(skipped) {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      document.removeEventListener("keydown", onKey);
      [ov, spot, pop].forEach(function (n) { if (n && n.parentNode) n.parentNode.removeChild(n); });
      if (opts.onDone) opts.onDone(!!skipped);
    }

    build();
    showStep();
  }

  /* Tell the server a tour has been seen so it won't auto-start again. */
  global.l360MarkTourSeen = function (which) {
    var tok = (document.querySelector('meta[name="csrf-token"]') || {}).content || "";
    try {
      fetch("/tour/seen", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "tour=" + encodeURIComponent(which) + "&csrf_token=" + encodeURIComponent(tok),
      });
    } catch (e) { /* non-critical */ }
  };

  global.L360Tour = L360Tour;
})(window);
