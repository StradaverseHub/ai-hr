/* The sign-in, forgot-password and reset pages (redesigned 2026-10-15, the canvas "OneHR AI+ Sign-in").
   - Forgot password opens as a pop-out on the sign-in page and posts to /forgot, which answers with the same one
     answer its own page gives (it never says whether an account exists). With no script, the links go to /forgot.
   - "First time signing in?" shows a one-line note: sign-in follows the main AI-HR app.
   - The assistant animation can be paused (it stands still anyway for anyone whose device asks for less motion).
   - The reset page ticks its two rules as the person types.
   - Get help turns the assistant card into the sign-in help desk (2026-10-19). */
(function () {
  "use strict";

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function showErr(el, msg, input) {
    if (!el) return;
    el.textContent = msg;
    el.hidden = !msg;
    if (input) {
      if (msg) { input.setAttribute("aria-invalid", "true"); input.setAttribute("aria-describedby", el.id); }
      else { input.removeAttribute("aria-invalid"); input.removeAttribute("aria-describedby"); }
    }
  }

  // ---- sign in: say what's missing on the page rather than a browser bubble -----------------------------------
  var signin = $("#ax-signin");
  if (signin) {
    var su = $("#ax-user"), sp = $("#ax-pass"), se = $("#ax-signin-err");
    signin.addEventListener("submit", function (e) {
      [su, sp].forEach(function (i) { i.removeAttribute("aria-invalid"); i.removeAttribute("aria-describedby"); });
      if (!su.value.trim()) { e.preventDefault(); showErr(se, "Enter your Employee ID.", su); su.focus(); return; }
      if (!sp.value) { e.preventDefault(); showErr(se, "Enter your password.", sp); sp.focus(); return; }
      showErr(se, "");
    });
    [su, sp].forEach(function (i) {
      i.addEventListener("input", function () { if (!se.hidden) showErr(se, "", i); });
    });
  }

  // ---- first time signing in ------------------------------------------------------------------------------
  var first = $("#ax-first"), firstPanel = $("#ax-first-panel");
  if (first && firstPanel) {
    first.addEventListener("click", function () {
      var open = first.getAttribute("aria-expanded") !== "true";
      first.setAttribute("aria-expanded", open ? "true" : "false");
      firstPanel.hidden = !open;
    });
  }

  // ---- the assistant animation: pause / play --------------------------------------------------------------
  var demo = $("#ax-demo"), pause = $("#ax-demo-pause");
  if (demo && pause) {
    pause.addEventListener("click", function () {
      var paused = demo.classList.toggle("is-paused");
      pause.setAttribute("aria-pressed", paused ? "true" : "false");
      pause.setAttribute("aria-label", paused ? "Play the animation" : "Pause the animation");
    });
  }

  // ---- the easter egg: five quick taps on AI+ ---------------------------------------------------------------
  // Each tap turns the spark a fifth and fills a dot; taps more than 2 seconds apart start again. The fifth sets off a
  // burst of sparks from the pill, then the sail stripes sweep in across the panel, settle, and sweep away, and it's
  // ready again. The assistant card says one line of its own meanwhile (Chris, 2026-10-16: "change the chat too to like
  // you have found me, let's move to sign in"); no other words change. It sends nothing and never touches the form.
  // Mouse and touch only (no tab stop of its own before the Employee ID field).
  var egg = $(".ax-aiplus[data-egg]"), brand = $(".ax-brand");
  if (egg && brand) {
    var SPARK = '<path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z"/>';
    var LINE = "You found me! Now let's get you signed in.";
    // The OneHR mascot (Chris, 2026-10-19, canvas "OneHR Easter Egg Mascot": "out of the pill then rides the stripes"):
    // the AI+ spark with a face, in the brand guide's colours. Its right arm is its own group, so it can wave.
    var M_UP = "M76 110 Q86 62 100 16 Q114 62 124 110 Z", M_DN = "M78 110 Q88 160 100 198 Q112 160 122 110 Z",
        M_L = "M100 90 Q56 100 14 110 Q56 120 100 130 Z", M_R = "M100 90 Q144 100 186 110 Q144 120 100 130 Z";
    var MASCOT =
      '<g fill="#282460" stroke="#282460" stroke-width="10" stroke-linejoin="round"><path d="' + M_UP + '"/><path d="' +
        M_DN + '"/><path d="' + M_L + '"/><circle cx="100" cy="110" r="42"/></g>' +
      '<g class="ax-egg-arm"><path d="' + M_R + '" fill="#282460" stroke="#282460" stroke-width="10" ' +
        'stroke-linejoin="round"/><path d="' + M_R + '" fill="#fff"/></g>' +
      '<g fill="#fff"><path d="' + M_UP + '"/><path d="' + M_DN + '"/><path d="' + M_L + '"/>' +
        '<circle cx="100" cy="110" r="42"/></g>' +
      '<g class="ax-egg-eyes"><ellipse cx="86" cy="104" rx="5.5" ry="7.5" fill="#282460"/>' +
        '<ellipse cx="114" cy="104" rx="5.5" ry="7.5" fill="#282460"/><circle cx="88" cy="101" r="2" fill="#fff"/>' +
        '<circle cx="116" cy="101" r="2" fill="#fff"/></g>' +
      '<ellipse cx="74" cy="118" rx="7" ry="4.5" fill="#F4A3A6"/><ellipse cx="126" cy="118" rx="7" ry="4.5" fill="#F4A3A6"/>' +
      '<path d="M88 117 Q100 131 112 117" fill="none" stroke="#282460" stroke-width="4.5" stroke-linecap="round"/>' +
      '<path d="M156 26 L159.5 36.5 L170 40 L159.5 43.5 L156 54 L152.5 43.5 L142 40 L152.5 36.5 Z" fill="#DF1E26"/>';
    var ROT = egg.querySelector("svg");
    var taps = 0, lastTap = 0, firing = false, idle = null, dots = null;

    function turn(deg, still) {
      if (!ROT) return;
      if (still) { ROT.style.transition = "none"; }
      ROT.style.transform = deg ? "rotate(" + deg + "deg)" : "";
      if (still) { void ROT.getBoundingClientRect(); ROT.style.transition = ""; }
    }
    function showDots(n) {
      if (!dots) {
        dots = document.createElement("span");
        dots.className = "ax-egg-dots";
        dots.setAttribute("aria-hidden", "true");
        for (var i = 0; i < 5; i++) dots.appendChild(document.createElement("i"));
        egg.appendChild(dots);
      }
      Array.prototype.forEach.call(dots.children, function (d, i) { d.classList.toggle("is-on", i < n); });
    }
    function clearDots() { if (dots) { dots.remove(); dots = null; } }
    function restart() { taps = 0; clearDots(); turn(0); }

    function burst() {
      var box = document.createElement("span");
      box.className = "ax-egg-burst";
      box.setAttribute("aria-hidden", "true");
      var cols = ["#DF1E26", "#FFFFFF", "#F7B5B8", "#DF1E26", "#CFD1EC"];
      for (var i = 0; i < 22; i++) {
        var a = (i * 360 / 22 + (i % 3) * 9) * Math.PI / 180, dist = 140 + (i * 53) % 280, size = 12 + (i * 7) % 16;
        var sv = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        sv.setAttribute("class", "ax-egg-spark");
        sv.setAttribute("viewBox", "0 0 24 24");
        sv.setAttribute("width", size);
        sv.setAttribute("height", size);
        sv.setAttribute("fill", cols[i % cols.length]);
        sv.innerHTML = SPARK;
        sv.style.setProperty("--dx", Math.round(Math.cos(a) * dist) + "px");
        sv.style.setProperty("--dy", Math.round(Math.sin(a) * dist * 0.85) + "px");
        sv.style.setProperty("--r", ((i % 2 ? 1 : -1) * (120 + (i * 37) % 200)) + "deg");
        sv.style.setProperty("--d", (((i * 7) % 10) / 40) + "s");
        box.appendChild(sv);
      }
      egg.appendChild(box);
      return box;
    }
    function sea() {
      var s = document.createElement("div");
      s.className = "ax-egg-sea";
      s.setAttribute("aria-hidden", "true");
      [["is-white", "2%", "140px"], ["is-red", "18%", "40px"], ["is-lilac", "30%", "220px"],
       ["is-glass", "58%", "70px"], ["is-red", "70%", "26px"], ["is-white", "80%", "260px"]].forEach(function (b, i) {
        var band = document.createElement("span");
        band.className = "ax-egg-band " + b[0];
        band.style.setProperty("--l", b[1]);
        band.style.setProperty("--w", b[2]);
        band.style.setProperty("--d", (i * 0.07) + "s");
        s.appendChild(band);
      });
      var sail = brand.querySelector(".ax-sail-2") || brand.querySelector(".ax-sail");
      brand.insertBefore(s, sail ? sail.nextSibling : brand.firstChild);   // behind the words, which stay as they are
      return s;
    }
    function chat() {   // the assistant card's own line, in the same place as its loop's scenes, which wait meanwhile
      var demo = $("#ax-demo"), scenes = demo && demo.querySelector(".ax-scenes");
      if (!scenes) return null;
      var scene = document.createElement("div");
      scene.className = "ax-scene ax-egg-scene";
      var line = document.createElement("p");
      line.className = "ax-bub ax-egg-say";
      line.textContent = LINE;
      scene.appendChild(line);
      scenes.appendChild(scene);
      demo.classList.add("is-egg");
      return function () { demo.classList.remove("is-egg"); scene.remove(); };
    }
    // The mascot: out of the pill, a hop onto the right-hand red stripe as it settles, a ride down its slope, then it
    // stands beside the agent card (or on its corner when the panel is narrow) and waves; at 6s it rides out with the
    // stripe. On a phone (no agent card) it hops to the header's edge and says the card's line in a small bubble.
    // Measured at fire time, so the path follows the real layout. Reduced motion: it simply appears at its spot.
    function mascot() {
      var box = brand.getBoundingClientRect(), bw = box.width, bh = box.height;
      var pr = egg.getBoundingClientRect(), px = pr.left - box.left + pr.width / 2, py = pr.top - box.top + pr.height / 2;
      var demo = $("#ax-demo"), card = demo && demo.offsetParent ? demo.getBoundingClientRect() : null;
      var phone = !card || window.matchMedia("(max-width: 900px)").matches;
      var still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      var el = document.createElement("span");
      el.className = "ax-egg-mascot" + (phone ? " is-phone" : "");
      el.setAttribute("aria-hidden", "true");
      var sv = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      sv.setAttribute("viewBox", "0 0 200 220");
      sv.innerHTML = MASCOT;
      el.appendChild(sv);
      brand.appendChild(el);
      var w = el.offsetWidth, h = el.offsetHeight, bub = null;
      function at(x, y, r, sx, sy) {   // the mascot's centre at (x, y)
        return "translate(" + Math.round(x - w / 2) + "px," + Math.round(y - h / 2) + "px) rotate(" + (r || 0) +
          "deg) scale(" + (sx == null ? 1 : sx) + "," + (sy == null ? (sx == null ? 1 : sx) : sy) + ")";
      }
      var rest, keys;
      if (phone) {
        rest = { x: bw - w / 2 - 12, y: Math.max(h / 2 + 6, py + 4) };
        bub = document.createElement("p");
        bub.className = "ax-egg-bubble";
        bub.setAttribute("aria-hidden", "true");
        bub.textContent = LINE;
        bub.style.top = Math.round(rest.y + h / 2 - 4) + "px";
        brand.appendChild(bub);
        keys = [
          { offset: 0, transform: at(px, py, 0, 0.12), opacity: 0 },
          { offset: 0.03, transform: at(px, py, 0, 0.3), opacity: 1 },
          { offset: 0.09, transform: at(px, py - 6, 0, 1.06), opacity: 1 },
          { offset: 0.13, transform: at((px + rest.x) / 2, Math.max(h / 2, Math.min(py, rest.y) - 26), 0, 1), opacity: 1 },
          { offset: 0.17, transform: at(rest.x, rest.y, 0, 1.06, 0.94), opacity: 1 },
          { offset: 0.19, transform: at(rest.x, rest.y), opacity: 1 },
          { offset: 0.86, transform: at(rest.x, rest.y), opacity: 1 },
          { offset: 0.93, transform: at((px + rest.x) / 2, Math.max(h / 2, Math.min(py, rest.y) - 26), 0, 0.7), opacity: 1 },
          { offset: 1, transform: at(px, py, 0, 0.12), opacity: 0 }
        ];
      } else {
        // the right-hand red stripe (70%, 26px wide), settled: skewX(-32deg) about its centre, so along it x = cx - dy * tan 32
        var bcx = 0.70 * bw + 13, bcy = 0.5 * bh, k = Math.tan(32 * Math.PI / 180);
        var ride = function (y) { return bcx - (y - bcy) * k; };
        var cr = { l: card.left - box.left, r: card.right - box.left, t: card.top - box.top, b: card.bottom - box.top };
        var free = bw - cr.r;
        // beside the card when there is room; else under it, right of the logo; only as a last resort on its corner
        // (there it would sit over the end of the words above the card)
        rest = free >= w + 24 ? { x: cr.r + free / 2, y: cr.t + 120 }
          : bh - cr.b >= h + 24 ? { x: cr.r - w / 2 - 8, y: cr.b + 12 + h / 2 }
          : { x: cr.r - w * 0.3, y: cr.t - h * 0.38 };
        var sy = Math.max(h / 2 + 8, bcy - (bw - w / 2 - 12 - bcx) / k), ey = Math.max(sy + 40, cr.t + 30);
        var s = { x: ride(sy), y: sy }, e = { x: ride(ey), y: ey }, x1 = { x: ride(rest.y), y: rest.y };
        var away = 0.6 * window.innerWidth;
        var T = 7.2, o = function (t) { return t / T; };
        // the pill sits near the panel's top edge, so it comes out to the pill's right, never up past the edge
        var p = { x: px + w * 0.8, y: Math.max(h / 2 + 8, py + 6) };
        keys = [
          { offset: 0, transform: at(px, py, 0, 0.12), opacity: 0 },
          { offset: o(0.12), transform: at(px + 10, py, 0, 0.3), opacity: 1 },
          { offset: o(0.5), transform: at(p.x, p.y, 0, 1.08), opacity: 1 },
          { offset: o(0.65), transform: at(p.x, p.y), opacity: 1 },
          { offset: o(1.1), transform: at((p.x + s.x) / 2, Math.max(h / 2 + 4, Math.min(p.y, s.y) - 40), 12), opacity: 1 },
          { offset: o(1.5), transform: at(s.x, s.y, 0, 1.05, 0.95), opacity: 1 },
          { offset: o(1.9), transform: at(s.x, s.y - 8), opacity: 1 },
          { offset: o(2.3), transform: at(s.x, s.y, -18), opacity: 1, easing: "cubic-bezier(.4,0,.6,1)" },
          { offset: o(3.05), transform: at(e.x, e.y, -18), opacity: 1 },
          { offset: o(3.18), transform: at((e.x + rest.x) / 2, Math.min(e.y, rest.y) - 46), opacity: 1 },
          { offset: o(3.3), transform: at(rest.x, rest.y, 0, 1.06, 0.94), opacity: 1 },
          { offset: o(3.42), transform: at(rest.x, rest.y), opacity: 1 },
          { offset: o(5.95), transform: at(rest.x, rest.y), opacity: 1 },
          { offset: o(6.12), transform: at((rest.x + x1.x) / 2, rest.y - 34), opacity: 1 },
          { offset: o(6.28), transform: at(x1.x, x1.y, -18), opacity: 1, easing: "ease-in" },
          { offset: 1, transform: at(x1.x - away, x1.y, -18), opacity: 0 }
        ];
      }
      var anim = null;
      if (still) { el.style.transform = at(rest.x, rest.y); }
      else if (el.animate) { anim = el.animate(keys, { duration: phone ? 7000 : 7200, fill: "forwards" }); }
      else { el.style.transform = at(rest.x, rest.y); }
      return function () { if (anim) anim.cancel(); el.remove(); if (bub) bub.remove(); };
    }
    function fire() {
      firing = true;
      clearDots();
      turn(360);
      egg.classList.add("is-egg");
      var sparks = burst(), stripes = sea(), unsay = chat(), unmascot = mascot();
      setTimeout(function () { stripes.classList.add("is-in"); }, 1000);     // after the spark, the stripes sweep in
      setTimeout(function () { stripes.classList.remove("is-in"); stripes.classList.add("is-out"); }, 6000);
      setTimeout(function () {
        sparks.remove();
        stripes.remove();
        if (unsay) unsay();
        unmascot();
        egg.classList.remove("is-egg");
        turn(0, true);
        taps = 0;
        firing = false;
      }, 7400);
    }

    egg.addEventListener("mousedown", function (e) { if (e.detail > 1) e.preventDefault(); });   // no text selection
    egg.addEventListener("click", function () {
      if (firing) return;
      var now = Date.now();
      taps = (now - lastTap > 2000 ? 0 : taps) + 1;
      lastTap = now;
      clearTimeout(idle);
      if (taps >= 5) { fire(); return; }
      turn(taps * 72);
      showDots(taps);
      idle = setTimeout(restart, 2000);
    });
  }

  // ---- forgot password, as a pop-out -----------------------------------------------------------------------
  var modal = $("#ax-forgot");
  if (modal) {
    var dialog = $(".ax-dialog", modal);
    var form = $("#ax-forgot-form");
    var fu = $("#axf-user"), fe = $("#axf-email"), ferr = $("#axf-err"), send = $("#axf-send");
    var lastFocus = null, sending = false;
    var startPane = form ? "form" : "nomail";

    function pane(name) {
      $all(".ax-pane", modal).forEach(function (p) { p.hidden = p.getAttribute("data-pane") !== name; });
      var h = $('.ax-pane[data-pane="' + name + '"] h2', modal);
      if (h) dialog.setAttribute("aria-labelledby", h.id);
      return h;
    }

    function focusables() {
      return $all('a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), [tabindex]:not([tabindex="-1"])', dialog)
        .filter(function (el) { return el.offsetParent !== null; });
    }

    function open(e) {
      if (e) e.preventDefault();
      lastFocus = document.activeElement;
      pane(startPane);
      if (form) {
        showErr(ferr, "");
        [fu, fe].forEach(function (i) { i.removeAttribute("aria-invalid"); i.removeAttribute("aria-describedby"); });
        var typed = $("#ax-user");
        if (typed && typed.value.trim() && !fu.value.trim()) fu.value = typed.value.trim();
      }
      modal.hidden = false;
      document.body.classList.add("ax-modal-open");
      var target = form ? (fu.value.trim() ? fe : fu) : $('.ax-pane[data-pane="nomail"] .ax-btn', modal);
      if (target) target.focus();
    }

    function close() {
      if (modal.hidden) return;
      modal.hidden = true;
      document.body.classList.remove("ax-modal-open");
      if (location.search.indexOf("forgot=1") !== -1 && window.history.replaceState) {
        window.history.replaceState(null, "", location.pathname);   // a reload doesn't open it again
      }
      var back = (lastFocus && document.body.contains(lastFocus)) ? lastFocus : $("[data-forgot-open]");
      if (back) back.focus();
    }

    $all("[data-forgot-open]").forEach(function (a) { a.addEventListener("click", open); });
    $all("[data-forgot-close]", modal).forEach(function (b) { b.addEventListener("click", close); });

    // a click on the dimmed page closes it; a drag that starts inside the box and ends outside does not
    var downOnBackdrop = false;
    modal.addEventListener("mousedown", function (e) { downOnBackdrop = e.target === modal; });
    modal.addEventListener("click", function (e) { if (e.target === modal && downOnBackdrop) close(); });

    document.addEventListener("keydown", function (e) {
      if (modal.hidden) return;
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key !== "Tab") return;
      var f = focusables();
      if (!f.length) return;
      var firstEl = f[0], lastEl = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === firstEl || !dialog.contains(document.activeElement))) {
        e.preventDefault(); lastEl.focus();
      } else if (!e.shiftKey && (document.activeElement === lastEl || !dialog.contains(document.activeElement))) {
        e.preventDefault(); firstEl.focus();
      }
    });

    if (form) {
      [fu, fe].forEach(function (i) {
        i.addEventListener("input", function () { if (!ferr.hidden) showErr(ferr, "", i); });
      });

      form.addEventListener("submit", function (e) {
        e.preventDefault();
        if (sending) return;
        [fu, fe].forEach(function (i) { i.removeAttribute("aria-invalid"); i.removeAttribute("aria-describedby"); });
        if (!fu.value.trim()) { showErr(ferr, "Enter your Employee ID.", fu); fu.focus(); return; }
        var em = fe.value.trim();
        if (!em) { showErr(ferr, "Enter the work email on your OneHR account.", fe); fe.focus(); return; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { showErr(ferr, "That doesn't look like an email address.", fe); fe.focus(); return; }
        showErr(ferr, "");

        sending = true;
        send.disabled = true;
        var label = send.textContent;
        send.textContent = "Sending…";
        fetch(form.action, {
          method: "POST", body: new FormData(form), credentials: "same-origin",
          headers: { "X-Requested-With": "fetch", "Accept": "application/json" }
        }).then(function (r) {
          if (r.status === 400) throw { msg: "Your session expired. Refresh the page and try again." };
          if (!r.ok) throw { msg: "Something went wrong on our side. Try again in a moment." };
          return r.json();
        }).then(function (j) {
          var h;
          if (j && j.outcome === "nomail") {
            h = pane("nomail");
          } else {
            h = pane("sent");
            var dev = $("#axf-dev"), devLink = $("#axf-dev-link");
            if (dev && devLink) {
              if (j && j.dev_link) { devLink.href = j.dev_link; devLink.textContent = j.dev_link; dev.hidden = false; }
              else { dev.hidden = true; }
            }
            fe.value = "";
          }
          if (h) h.focus();
        }).catch(function (err) {
          showErr(ferr, (err && err.msg) || "We couldn't reach OneHR. Check your connection and try again.");
        }).then(function () {
          sending = false;
          send.disabled = false;
          send.textContent = label;
        });
      });
    }

    if (modal.hasAttribute("data-open-on-load")) open();
  }

  // ---- sign-in help (2026-10-19, option C of canvas [design canvas link removed]) --------------
  // Get help turns the assistant card into a help desk. It is a script, not an AI model: nobody on this page has signed
  // in. It sorts what it can here (a reset link through /forgot, the lock-out) and raises the rest
  // as a request to /signin-help, which emails the People team. While it's open the card glows, and a dotted line runs
  // from Get help to it for three seconds. On a narrow screen, where the card isn't shown, Get help opens the page of
  // its own instead.
  function counter(t) {
    var n = t && t.parentNode && t.parentNode.querySelector("[data-count-n]");
    if (n) n.textContent = t.value.length;
  }
  document.addEventListener("input", function (e) { if (e.target.matches && e.target.matches("textarea[data-count]")) counter(e.target); });

  var help = $("#ax-help"), helpBtn = $("#ax-help-open"), card = $("#ax-demo");
  if (help && helpBtn && card) {
    var feed = $("#axh-feed"), sayForm = $("#axh-say"), sayIn = $("#axh-say-in");
    var nameEl = $("#ax-demo-name"), backBtn = $("#axh-back"), restartBtn = $("#axh-restart");
    var head = $("#ax-headline"), lede = $("#ax-lede"), panel = $(".ax-brand");
    var orig = { name: nameEl ? nameEl.textContent : "", head: head ? head.textContent : "", lede: lede ? lede.textContent : "" };
    var N = { fails: help.getAttribute("data-fails"), win: help.getAttribute("data-window"),
              ttl: help.getAttribute("data-ttl"), reset: help.getAttribute("data-reset") === "1" };
    var reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    var ISSUE = { password: "Forgot my password", locked: "Account locked", first: "First time signing in",
                  id: "Employee ID isn't recognised", email: "Reset email didn't arrive", other: "Something else" };
    var open = false, timers = [], line = null;

    function later(fn, ms) { var t = setTimeout(fn, ms); timers.push(t); return t; }
    function end() { feed.scrollTop = feed.scrollHeight; }
    function bubble(text, me) {
      var p = document.createElement("p");
      p.className = "ax-bub axh-bub" + (me ? " ax-bub-me" : "");
      p.textContent = text;
      feed.appendChild(p); end();
      return p;
    }
    function say(text, then) {   // a moment of typing dots, then the line
      var dots = document.createElement("span");
      dots.className = "axh-typing";
      dots.setAttribute("aria-hidden", "true");
      dots.innerHTML = "<i></i><i></i><i></i>";
      feed.appendChild(dots); end();
      later(function () { dots.remove(); bubble(text); if (then) then(); }, reduce ? 0 : 450);
    }
    function retire() { $all(".axh-choices", feed).forEach(function (b) { b.remove(); }); }
    function choices(list, focus) {   // [[label, what it does, quiet]]: a choice made becomes their own bubble
      var box = document.createElement("div");
      box.className = "axh-chips axh-choices";
      list.forEach(function (c) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "axh-choice" + (c[2] ? " is-quiet" : "");
        b.textContent = c[0];
        b.addEventListener("click", function () { retire(); bubble(c[0], true); c[1](); });
        box.appendChild(b);
      });
      feed.appendChild(box); end();
      if (focus) { var f = box.querySelector("button"); if (f) f.focus(); }
    }
    function cardFrom(sel) {   // a form from its template, the one live card in the chat
      $all(".axh-card.is-live", feed).forEach(function (c) { c.classList.remove("is-live"); });
      var f = document.importNode($(sel).content, true).firstElementChild;
      f.classList.add("is-live");
      feed.appendChild(f);
      feed.scrollTop = f.offsetTop;   // the card from its top: what it's about, then its fields
      return f;
    }
    function settle(f, text) {   // a card that has done its job: read only, with what it did
      $all("input, textarea, button", f).forEach(function (el) { el.disabled = true; });
      var acts = $(".axh-acts", f);
      if (acts) {
        acts.innerHTML = '<span class="axh-ok"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg></span>';
        acts.firstChild.appendChild(document.createTextNode(text));
      }
      f.classList.remove("is-live");
      f.classList.add("is-done");
    }
    function post(f, btn, err, ok) {
      var label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Sending…";
      fetch(f.action, { method: "POST", body: new FormData(f), credentials: "same-origin",
                        headers: { "X-Requested-With": "fetch", "Accept": "application/json" } })
        .then(function (r) {
          if (r.status === 400) throw { msg: "Your session expired. Refresh the page and try again." };
          if (r.status === 422) return r.json().then(function (j) { throw { msg: j && j.error }; });
          if (!r.ok) throw { msg: "Something went wrong on our side. Try again in a moment." };
          return r.json();
        })
        .then(function (j) { btn.disabled = false; btn.textContent = label; ok(j || {}); })
        .catch(function (e) {
          btn.disabled = false; btn.textContent = label;
          showErr(err, (e && e.msg) || "We couldn't reach OneHR. Check your connection and try again.");
        });
    }
    function heading(h, l) { if (head) head.textContent = h; if (lede) lede.textContent = l; }
    function signIn() {   // "Back to sign in": the tour again, and the Employee ID field
      close();
      var u = $("#ax-user");
      if (u) u.focus();
    }

    function start() {
      say("Trouble signing in? Tell me what's happening. I'll fix what I can right here, and pass anything else to the People team.",
        function () { menu(true); });
    }
    function menu(focus) {
      choices([["I forgot my password", forgot], ["My account is locked", locked], ["It's my first time signing in", firstTime],
               ["My Employee ID isn't recognised", badId], ["The reset email didn't arrive", noMail],
               ["Something else", function () { ticket("other"); }]], focus);
    }
    function forgot() {
      if (!N.reset) {
        say("Resetting a password by email isn't available just now, so I'll pass this to the People team.",
          function () { ticket("password"); });
        return;
      }
      say("I can sort that now. Your Employee ID and the work email on your OneHR account, and I'll email you a link to set a new one.", function () {
        var f = cardFrom("#axh-forgot-tpl"), u = $('[name="username"]', f), e = $('[name="email"]', f);
        var err = $(".axh-err", f), btn = $('button[type="submit"]', f), typed = $("#ax-user");
        if (typed && typed.value.trim()) u.value = typed.value.trim();
        (u.value ? e : u).focus();
        f.addEventListener("submit", function (ev) {
          ev.preventDefault();
          [u, e].forEach(function (i) { i.removeAttribute("aria-invalid"); });
          if (!u.value.trim()) { showErr(err, "Enter your Employee ID.", u); u.focus(); return; }
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.value.trim())) { showErr(err, "Enter the work email on your OneHR account.", e); e.focus(); return; }
          showErr(err, "");
          post(f, btn, err, function (j) {
            if (j.outcome === "nomail") {
              settle(f, "Not sent");
              say("Resetting by email isn't available just now, so I'll pass this to the People team.", function () { ticket("password"); });
              return;
            }
            settle(f, "Reset link requested");
            say("Done. If those match your account, the link is on its way. It works once, for " + N.ttl + " minutes, so check your junk folder too.", function () {
              if (j.dev_link) {   // a laptop with no email: the link on screen, as the Forgot pop-out does
                var a = document.createElement("a"); a.href = j.dev_link; a.textContent = j.dev_link; a.className = "axh-dev";
                feed.appendChild(a); end();
              }
              choices([["It didn't arrive", function () { ticket("email"); }],
                       ["I have no work email on file", function () { ticket("password", "I have no work email on file."); }],
                       ["Back to sign in", signIn, true]], true);
            });
          });
        });
      });
    }
    function locked() {
      say("After " + N.fails + " wrong tries OneHR pauses sign-in for " + N.win + " minutes, but the browser you usually use still works. You can also reset your password now.", function () {
        choices([["Reset my password", forgot], ["I've waited, and it's still locked", function () { ticket("locked"); }]], true);
      });
    }
    function firstTime() {
      var fb = $("#ax-first"), fp = $("#ax-first-panel");
      if (fb && fp && fp.hidden) fb.click();
      say("Sign-in follows the main AI-HR app. I've opened a note under the sign-in form.", function () {
        if (fp) { fp.classList.remove("axh-flash"); void fp.offsetWidth; fp.classList.add("axh-flash"); }
        choices([["It doesn't work", function () { ticket("first"); }], ["Back to sign in", signIn, true]], true);
      });
    }
    function badId() {
      say("Use your Employee ID exactly as it is on your employment record, with no spaces. If you joined recently, the People team may still be adding you.", function () {
        choices([["Raise a request", function () { ticket("id"); }], ["Back to sign in", signIn, true]], true);
      });
    }
    function noMail() {
      say("Reset links can take a few minutes, and sometimes land in junk. A link only goes out when the email you give is the one on your OneHR account.", function () {
        choices([["Send another link", forgot], ["Raise a request", function () { ticket("email"); }]], true);
      });
    }
    function ticket(issue, detail) {
      say(issue === "other" ? "Tell the People team what's happening, and I'll pass it on."
                            : "Let's get the People team on it. I've started your request: check it and send.", function () {
        var f = cardFrom("#axh-ticket-tpl"), err = $(".axh-err", f), btn = $('button[type="submit"]', f);
        var pick = $('input[name="issue"][value="' + issue + '"]', f);
        if (pick) pick.checked = true;
        var id = $('[name="employee_id"]', f), d = $('[name="detail"]', f), typed = $("#ax-user");
        if (typed && typed.value.trim()) id.value = typed.value.trim();
        if (detail) d.value = detail;
        counter(d);
        $('[name="full_name"]', f).focus();
        $("[data-axh-cancel]", f).addEventListener("click", function () {
          f.remove();
          say("No problem. Anything else?", function () { menu(true); });
        });
        f.addEventListener("submit", function (ev) {
          ev.preventDefault();
          var need = [["full_name", "Put in your name."], ["employee_id", "Put in your Employee ID."],
                      ["email", "Put in your work email, so the People team can reply."]];
          for (var i = 0; i < need.length; i++) {
            var el = $('[name="' + need[i][0] + '"]', f);
            if (!el.value.trim()) { showErr(err, need[i][1], el); el.focus(); return; }
          }
          var em = $('[name="email"]', f);
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em.value.trim())) { showErr(err, "That doesn't look like an email address.", em); em.focus(); return; }
          showErr(err, "");
          post(f, btn, err, function (j) {
            var chosen = $('input[name="issue"]:checked', f);
            settle(f, "Sent: " + ISSUE[chosen ? chosen.value : "other"]);
            heading("Help is on its way.", "The People team has your request, and they'll reply by email.");
            say(j.ref ? "Sent. Your reference is " + j.ref + "." : "Got it. The People team already has your request, and they'll reply by email.", function () {
              var done = document.createElement("div");
              done.className = "axh-done";
              ["The People team has it", "A short notice is on its way to you, if that's the email on your OneHR account",
               "They'll reply to that email"].forEach(function (t) {
                var r = document.createElement("span");
                r.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';
                r.appendChild(document.createTextNode(t));
                done.appendChild(r);
              });
              feed.appendChild(done); end();
              say("Nothing else to do here. If your password gets reset meanwhile, you can sign in as usual.", function () {
                choices([["Back to sign in", signIn], ["Something else", function () { start(); }, true]], true);
              });
            });
          });
        });
      });
    }
    // in their own words: matched by a few words, never sent anywhere until they send a request
    function route(text) {
      var t = text.toLowerCase();
      if (/(didn.?t (get|arrive|come)|not (receive|arrive|get)|no (email|link)|email|link)/.test(t)) return noMail();
      if (/(lock|too many|attempt)/.test(t)) return locked();
      if (/(forgot|password|reset)/.test(t)) return forgot();
      if (/(first|new joiner|joined)/.test(t)) return firstTime();
      if (/(employee id|recogni|not found|wrong id|my id)/.test(t)) return badId();
      ticket("other", text.slice(0, 500));
    }
    sayForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = sayIn.value.trim();
      if (!text) return;
      retire();
      bubble(text, true);
      sayIn.value = "";
      route(text);
    });

    function drawLine() {   // from Get help, round under the form, to the card: drawn, held, then gone
      removeLine();
      var b = helpBtn.getBoundingClientRect(), c = card.getBoundingClientRect();
      if (!b.width || !c.width || b.left < c.right + 40) return;
      var sx = b.left + 14, sy = b.bottom, ex = c.right + 10, ey = Math.min(c.top + c.height * 0.7, sy - 40);
      var dx = sx - ex, minX = ex - 12, minY = Math.min(ey, sy) - 16, W = sx + 12 - minX, H = sy + 80 - minY;
      function P(x, y) { return Math.round(x - minX) + " " + Math.round(y - minY); }
      var d = "M" + P(sx, sy) + " C" + P(sx, sy + 55) + " " + P(sx - 0.4 * dx, sy + 65) + " " + P(sx - 0.6 * dx, sy + 40)
            + " C" + P(sx - 0.78 * dx, sy + 18) + " " + P(ex + 30, ey + 64) + " " + P(ex, ey);
      var ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
      svg.setAttribute("class", "axh-line");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("width", W); svg.setAttribute("height", H);
      svg.setAttribute("viewBox", "0 0 " + W + " " + H);
      svg.style.left = minX + "px"; svg.style.top = minY + "px";
      svg.innerHTML = '<defs><marker id="axh-head" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#DF1E26"/></marker></defs>'
        + '<path d="' + d + '" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-dasharray="0.1 9" opacity="0.9"/>'
        + '<path d="' + d + '" fill="none" stroke="#DF1E26" stroke-width="3" stroke-linecap="round" stroke-dasharray="0.1 9" marker-end="url(#axh-head)"/>'
        + '<circle cx="' + (W - 12) + '" cy="' + Math.round(sy - minY) + '" r="3.5" fill="#DF1E26"/>';
      document.body.appendChild(svg);
      line = svg;
      void svg.getBoundingClientRect();
      svg.classList.add("is-in");
      later(function () { svg.classList.add("is-out"); }, 2800);
      later(function () { if (line === svg) removeLine(); }, 3300);
    }
    function removeLine() { if (line) { line.remove(); line = null; } }

    function openHelp(e) {
      if (e) e.preventDefault();
      if (open) { close(); helpBtn.focus(); return; }
      if (!card.offsetParent) { window.location.href = helpBtn.href; return; }   // the card isn't shown: the page instead
      open = true;
      card.classList.add("is-help");
      if (panel) panel.classList.add("is-help");
      if (!reduce) { card.classList.add("is-help-pulse"); later(function () { card.classList.remove("is-help-pulse"); }, 1600); }
      help.hidden = false;
      backBtn.hidden = false;
      restartBtn.hidden = false;
      if (nameEl) nameEl.textContent = "OneHR AI Agent · sign-in help";
      helpBtn.setAttribute("aria-expanded", "true");
      heading("Let's get you signed in.", "Tell the assistant what's happening. It sorts what it can on the spot, and passes the rest to the People team.");
      feed.textContent = "";
      drawLine();
      start();
    }
    function close() {
      open = false;
      timers.forEach(clearTimeout); timers = [];
      removeLine();
      feed.textContent = "";
      card.classList.remove("is-help", "is-help-pulse");
      if (panel) panel.classList.remove("is-help");
      help.hidden = true;
      backBtn.hidden = true;
      restartBtn.hidden = true;
      if (nameEl) nameEl.textContent = orig.name;
      helpBtn.setAttribute("aria-expanded", "false");
      heading(orig.head, orig.lede);
    }
    helpBtn.addEventListener("click", openHelp);
    backBtn.addEventListener("click", function () { close(); helpBtn.focus(); });
    restartBtn.addEventListener("click", function () { timers.forEach(clearTimeout); timers = []; feed.textContent = ""; heading("Let's get you signed in.", "Tell the assistant what's happening. It sorts what it can on the spot, and passes the rest to the People team."); start(); });
    window.addEventListener("resize", removeLine);
  }

  // ---- reset: tick the rules as they type ------------------------------------------------------------------
  var reset = $("#ax-reset");
  if (reset) {
    var pn = $("#rp-new"), pc = $("#rp-confirm"), rl = $("#rp-rule-len"), rm = $("#rp-rule-match");
    function rule(li, met, tried) {
      li.classList.toggle("is-met", met);
      li.classList.toggle("is-bad", !met && tried);
      var st = $("[data-rule-state]", li);
      if (st) st.textContent = met ? " (done)" : "";
    }
    var tried = false;
    function check() {
      var lenOk = pn.value.length >= 8, matchOk = pc.value.length > 0 && pn.value === pc.value;
      rule(rl, lenOk, tried);
      rule(rm, matchOk, tried);
      return lenOk && matchOk;
    }
    pn.addEventListener("input", check);
    pc.addEventListener("input", check);
    reset.addEventListener("submit", function (e) {
      tried = true;
      if (!check()) {
        e.preventDefault();
        (pn.value.length >= 8 ? pc : pn).focus();
      }
    });
  }
})();
