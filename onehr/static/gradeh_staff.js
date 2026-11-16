/* My Appraisal / Penilaian Saya (Grade H Appraisal's staff page). Small and optional: every form also works with no script.
   - folds open at desktop width (1024px); the account panel closes on an outside tap or Esc
   - the acknowledge button wakes when the box is ticked (the server asks for the tick again)
   - KPI entry: the figures save as they are typed (blur) and the weighted result comes from the SERVER (/kpi/preview)
   - Ask OneHR: fixed answers from POST /my-appraisal/ask; on a phone its button opens the panel under the page
   - Look around: the page opened with ?tour=1 carries its words and stops in data-tour; the tour runs over the real page (it writes
     nothing: the Start button's POST already stamped the first sign-in) */
(function () {
  "use strict";
  var tokEl = document.querySelector('meta[name="csrf-token"]');
  var TOK = tokEl ? tokEl.getAttribute("content") : "";
  var wide = window.matchMedia ? window.matchMedia("(min-width: 1024px)") : null;

  /* folds: the phone keeps them closed; from 1024px (the desktop view) they are open, with no chevron (CSS), and stay open */
  var folds = [].slice.call(document.querySelectorAll("details[data-open-wide]"));
  var isWide = function () { return wide ? wide.matches : true; };
  var autoOpened = [];
  var syncFolds = function () {
    folds.forEach(function (d) {
      if (isWide()) { if (!d.open) { d.open = true; if (autoOpened.indexOf(d) < 0) autoOpened.push(d); } }
      else if (autoOpened.indexOf(d) >= 0) { d.open = false; autoOpened.splice(autoOpened.indexOf(d), 1); }
    });
  };
  folds.forEach(function (d) { d.addEventListener("toggle", function () { if (isWide() && !d.open) d.open = true; }); });
  if (wide && wide.addEventListener) wide.addEventListener("change", syncFolds); else if (wide && wide.addListener) wide.addListener(syncFolds);
  syncFolds();

  var acct = document.getElementById("gh-acct");
  if (acct) {
    document.addEventListener("click", function (e) { if (acct.open && !acct.contains(e.target)) acct.open = false; });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && acct.open) { acct.open = false; var s = acct.querySelector("summary"); if (s) s.focus(); } });
  }

  var ack = document.getElementById("gh-ack"), ackBtn = document.getElementById("gh-ack-btn");
  if (ack && ackBtn) {
    var sync = function () { ackBtn.disabled = !ack.checked; };
    ack.addEventListener("change", sync); sync();
  }

  /* ---- "I do not agree": the second pane of the acknowledge card (without a script the button is a link to ?disagree=1) ----
     Send wakes when the box is ticked and a reason is written and within 300 words; the count is the words typed; the server asks for
     all of it again, and OneHR's own confirm box (data-confirm on the form) asks before it is sent. */
  var disOpen = document.getElementById("gh-dis-open"), disBack = document.getElementById("gh-dis-back");
  var paneMain = document.getElementById("gh-ack-main"), paneDis = document.getElementById("gh-dis");
  var disTick = document.getElementById("gh-dis-ck"), disWhy = document.getElementById("gh-dis-why");
  var disSend = document.getElementById("gh-dis-send"), disCount = document.getElementById("gh-dis-count");
  var words = function (t) { t = (t || "").trim(); return t ? t.split(/\s+/).length : 0; };
  var disSync = function () {
    if (!disWhy) return;
    var n = words(disWhy.value);
    if (disCount) {
      disCount.textContent = (disCount.getAttribute("data-tpl") || "{n}").replace("{n}", n);
      disCount.classList.toggle("is-over", n > 300);
    }
    if (disSend) disSend.disabled = !(disTick && disTick.checked && n > 0 && n <= 300);
  };
  if (disTick) disTick.addEventListener("change", disSync);
  if (disWhy) disWhy.addEventListener("input", disSync);
  disSync();
  var showPane = function (dis) {
    if (!paneMain || !paneDis) return;
    paneMain.hidden = dis; paneDis.hidden = !dis;
    var target = dis ? (disWhy || paneDis) : (ack || paneMain);
    try { target.focus({ preventScroll: false }); } catch (e) { /* old browser */ }
  };
  if (disOpen && paneMain && paneDis) disOpen.addEventListener("click", function (e) { e.preventDefault(); showPane(true); });
  if (disBack && paneMain && paneDis) disBack.addEventListener("click", function (e) { e.preventDefault(); showPane(false); });

  /* ---- KPI entry ---- */
  var form = document.getElementById("gh-kpi");
  if (form) {
    var result = document.getElementById("gh-result");
    var busy = false, again = false, timer = null;
    var post = function (url, extra) {
      var fd = new FormData(form);
      if (extra) Object.keys(extra).forEach(function (k) { fd.append(k, extra[k]); });
      return fetch(url, { method: "POST", body: fd, credentials: "same-origin", headers: { "Accept": "application/json" } })
        .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
    };
    var showResult = function (j) {
      if (!result || !j) return;
      result.textContent = "";
      var span = document.createElement("span");
      if (j.ok && j.result !== null && j.result !== undefined) {
        span.textContent = j.label || "";
        var b = document.createElement("b"); b.textContent = j.result + "%";
        result.appendChild(span); result.appendChild(b);
      } else { span.textContent = j.text || ""; result.appendChild(span); }
    };
    var preview = function () {
      post(form.getAttribute("data-preview"), {}).then(function (j) { showResult(j); });
    };
    var mark = function (id, text, err) {
      var el = document.getElementById("gh-saved-" + id);
      if (!el) return; el.textContent = text || ""; el.className = "gh-saved" + (err ? " is-err" : "");
    };
    var save = function () {
      if (busy) { again = true; return; }
      busy = true;
      post(form.getAttribute("data-save"), { json: "1" }).then(function (j) {
        busy = false;
        if (j && j.ok) {
          var savedWord = form.getAttribute("data-saved") || "";
          [].forEach.call(form.querySelectorAll(".gh-kpi"), function (card) {
            var id = card.getAttribute("data-line");
            var inp = card.querySelector("input");
            mark(id, (inp && inp.value.trim() !== "" && j.saved && j.saved.indexOf(parseInt(id, 10)) >= 0) ? savedWord : "", false);
          });
        } else if (j && j.line) { mark(j.line, j.say, true); }
        if (again) { again = false; save(); }
      }).catch(function () { busy = false; });
    };
    [].forEach.call(form.querySelectorAll(".gh-kpi input"), function (inp) {
      inp.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(preview, 350); });
      inp.addEventListener("change", save);
    });
    var note = document.getElementById("gh-note");
    if (note) note.addEventListener("change", save);
  }

  /* ---- Ask OneHR ---- */
  var ask = document.getElementById("gh-ask");
  if (ask) {
    var log = document.getElementById("gh-ask-log"), input = document.getElementById("gh-ask-in");
    var open = document.getElementById("gh-ask-open"), askForm = document.getElementById("gh-ask-form");
    var add = function (cls, text) { var p = document.createElement("p"); p.className = cls; p.textContent = text; log.insertBefore(p, document.getElementById("gh-ask-chips")); return p; };
    var send = function (text) {
      text = (text || "").trim(); if (!text) return;
      add("gh-ask-me", text);
      var fd = new FormData(); fd.append("csrf_token", TOK); fd.append("message", text);
      fetch(ask.getAttribute("data-url"), { method: "POST", body: fd, credentials: "same-origin" })
        .then(function (r) { return r.json(); }).then(function (j) { add("gh-ask-ai", j && j.say ? j.say : ""); })
        .catch(function () { /* stay quiet: the chips still work */ });
    };
    if (open) open.addEventListener("click", function () {
      var on = !ask.classList.contains("is-open");
      ask.classList.toggle("is-open", on); open.setAttribute("aria-expanded", on ? "true" : "false");
      if (on) { try { ask.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) { ask.scrollIntoView(); } if (input) input.focus({ preventScroll: true }); }
    });
    [].forEach.call(ask.querySelectorAll(".gh-ask-q"), function (b) { b.addEventListener("click", function () { send(b.textContent); }); });
    if (askForm) askForm.addEventListener("submit", function (e) { e.preventDefault(); var t = input.value; input.value = ""; send(t); });
  }
  /* ---- Look around: a real tour over the page (canvases D2, P2) ----
     The page dimmed, each stop lifted out of the dim with a ring; "n of N" over the stops that are on screen. From 1024px the card
     takes the Ask OneHR column's place; under it, a sheet at the foot. Esc = Skip. The page's own controls are inert meanwhile. */
  var pageEl = document.getElementById("gh-page");
  var TOUR = null;
  try { TOUR = JSON.parse((pageEl && pageEl.getAttribute("data-tour")) || "null"); } catch (e) { TOUR = null; }
  if (TOUR && TOUR.stops && TOUR.stops.length) startTour(TOUR);

  function startTour(T) {
    var mq = window.matchMedia ? window.matchMedia("(min-width: 1024px)") : null;
    var isWide = function () { return mq ? mq.matches : true; };
    var root = document.documentElement, ui = T.ui || {};
    var seen = function (el) { return !!el && el.getClientRects().length > 0 && !el.closest("[hidden]"); };
    var target = function (st) {
      var order = isWide() ? [st.sel, st.sel_phone] : [st.sel_phone, st.sel];
      for (var i = 0; i < order.length; i++) {
        if (!order[i]) continue;
        var el = document.querySelector(order[i]);
        if (seen(el)) return el;
      }
      return null;
    };
    var stops = T.stops.filter(function (st) { return target(st); });
    if (!stops.length) return;
    // the tour is for this visit only: a reload of this address does not run it again
    try { var u = new URL(window.location.href); u.searchParams.delete("tour"); window.history.replaceState(null, "", u.pathname + u.search + u.hash); } catch (e) { /* old browser */ }

    var at = 0, spot = null, resizeTimer = null, wasWide = isWide();
    var ask = document.getElementById("gh-ask"), askSub = ask ? ask.querySelector(".gh-ask-hn span") : null, askSubWas = askSub ? askSub.textContent : "";
    var main = document.querySelector(".gh-main"), bar = document.querySelector(".gh-bar"), slot = document.getElementById("site-notice-slot");
    var inerts = [main, bar, slot].filter(Boolean);
    var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    var dim = el("div", "gh-tour-dim"); dim.setAttribute("aria-hidden", "true");
    var card = el("section", "gh-tourcard");
    card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-labelledby", "gh-tour-t"); card.tabIndex = -1;
    var kEl = el("span", "gh-tour-k"), tEl = el("b", "gh-tour-t"), xEl = el("p", "gh-tour-x"), dots = el("div", "gh-tour-dots");
    tEl.id = "gh-tour-t"; dots.setAttribute("aria-hidden", "true");
    var live = el("div"); live.setAttribute("aria-live", "polite"); live.appendChild(kEl); live.appendChild(tEl); live.appendChild(xEl);
    var acts = el("div", "gh-tour-acts"), nextB = el("button", "gh-tour-next"), skipB = el("button", "gh-tour-skip", ui.skip || "Skip");
    nextB.type = "button"; skipB.type = "button";
    acts.appendChild(nextB); acts.appendChild(skipB);
    card.appendChild(live); card.appendChild(dots); card.appendChild(acts);
    var rest = el("p", "gh-tour-rest");
    document.body.appendChild(dim);
    root.classList.add("gh-touring");
    inerts.forEach(function (n) { n.setAttribute("inert", ""); });

    // the card's home: the Ask OneHR column from 1024px (its chat steps aside), else a sheet fixed to the foot of the screen
    var place = function () {
      var col = isWide() && ask;
      if (col) {
        ask.classList.add("is-touring");
        if (askSub) askSub.textContent = ui.sub || askSubWas;
        card.classList.add("is-col"); rest.classList.add("is-col");
        if (card.parentNode !== ask) { ask.insertBefore(card, ask.querySelector(".gh-ask-log")); }
        if (rest.parentNode !== ask) { ask.insertBefore(rest, ask.querySelector(".gh-ask-log")); }
        root.style.removeProperty("--gh-sheet-h");
      } else {
        if (ask) { ask.classList.remove("is-touring"); if (askSub) askSub.textContent = askSubWas; }
        card.classList.remove("is-col"); rest.classList.remove("is-col");
        if (card.parentNode !== document.body) document.body.appendChild(card);
        if (rest.parentNode) rest.parentNode.removeChild(rest);
        root.style.setProperty("--gh-sheet-h", card.offsetHeight + "px");
      }
    };
    var unspot = function () {
      if (spot) { spot.classList.remove("gh-tour-spot"); spot = null; }
    };
    // scroll the stop into the free band between the pinned bar (and banner) and the sheet: centred when it fits, else its top at the band's top
    var reveal = function (node) {
      if (node.closest(".gh-bar") || (isWide() && node === ask)) return;
      var top = 0;
      [bar, slot].forEach(function (b) { if (b) { var r = b.getBoundingClientRect(); if (r.height) top = Math.max(top, r.bottom); } });
      top += 10;
      var bottom = isWide() ? window.innerHeight - 10 : card.getBoundingClientRect().top - 10;
      var r = node.getBoundingClientRect(), room = bottom - top;
      var want = r.height <= room ? top + (room - r.height) / 2 : top;
      var calm = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      try { window.scrollBy({ top: r.top - want, behavior: calm ? "auto" : "smooth" }); } catch (e) { window.scrollBy(0, r.top - want); }
    };
    var show = function () {
      var st = stops[at], node = target(st);
      if (!node) {   // its element is not on screen at this width: on to the next
        if (at < stops.length - 1) { at += 1; show(); } else finish();
        return;
      }
      unspot(); place();
      spot = node; node.classList.add("gh-tour-spot");
      kEl.textContent = (ui.k || "Look around · {n} of {m}").replace("{n}", at + 1).replace("{m}", stops.length);
      tEl.textContent = st.t; xEl.textContent = st.x;
      nextB.textContent = at === stops.length - 1 ? (ui.done || "Done") : (ui.next || "Next");
      dots.textContent = "";
      stops.forEach(function (_s, i) { dots.appendChild(el("span", i === at ? "is-on" : "")); });
      var left = stops.slice(at + 1).map(function (x) { return x.t; });
      rest.textContent = left.length ? (ui.rest || "Next stops: {list}.").replace("{list}", left.join(", ")) : "";
      if (!isWide()) root.style.setProperty("--gh-sheet-h", card.offsetHeight + "px");
      reveal(node);
    };
    function finish() {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      unspot();
      if (ask) { ask.classList.remove("is-touring"); if (askSub) askSub.textContent = askSubWas; }
      [card, rest, dim].forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
      root.classList.remove("gh-touring"); root.style.removeProperty("--gh-sheet-h");
      inerts.forEach(function (n) { n.removeAttribute("inert"); });
      var first = document.querySelector(".gh-main h1, .gh-hi");
      if (first) { first.setAttribute("tabindex", "-1"); try { first.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(); }
    }
    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { if (wasWide !== isWide()) wasWide = isWide(); show(); }, 150);
    }
    nextB.addEventListener("click", function () { if (at < stops.length - 1) { at += 1; show(); } else finish(); });
    skipB.addEventListener("click", finish);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    show();
    card.focus({ preventScroll: true });
  }
})();
