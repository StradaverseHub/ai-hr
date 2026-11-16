/* The notice bar (the release window, Chris 2026-10-26; canvas [design canvas link removed]).
   _site_notice.html draws it as the page loads; this keeps it current without a reload:
   - navy until the closing warning, counting down to the closure ("closes in 52 min"), with Hide folding it into the
     pill in the top bar, which counts down too (remembered for that notice);
   - red with a live countdown from ten minutes before, no Hide (a retired urgent fix row is red from the start);
   - "closed" once the start passes in a tab left open: a save then is held on the page with the bar's own message,
     never lost to the closed page (a form posting is stopped; a script's save answered by the closed page says so);
   - /notice.json every five minutes (every minute while closed), so a page open since before the notice shows it,
     and the bar goes once OneHR is back.
   Every word comes from the server (notice_words); this file only fills in the countdown.
   The same slot carries the announcements and the deadline reminder meant for this page (bar_items, 2026-10-26;
   canvas boards 16-16b) when no notice is current: all of them in one line, each with its icon and its button, a dot
   between, running across the bar, round and round, when the line doesn't fit (Chris: "keep them looping continuously
   for long announcement ... more than one announcement looping at once"). No Got it: each stays until it ends. A
   notice stands alone: while one is current the announcements step aside, its Hide pill included. */
(function () {
  "use strict";
  var slot = document.getElementById("site-notice-slot");
  if (!slot) return;
  var auth = slot.getAttribute("data-auth") === "1";
  var canHide = slot.getAttribute("data-hide") === "1";
  var cur = null, offset = 0, tick = null, poller = null, state = "";

  function store(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private window */ } }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function now() { return Date.now() + offset; }
  function left(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
  }
  // the time left before the closure, as notice_in says it: "52 min", "1 hr", "1 hr 5 min" (rounded up, never 0)
  function inWords(ms) {
    var m = Math.max(1, Math.ceil(ms / 60000)), h = Math.floor(m / 60);
    m = m % 60;
    return h ? h + " hr" + (m ? " " + m + " min" : "") : m + " min";
  }
  function mins(ms) {
    var m = Math.max(1, Math.ceil(ms / 60000));
    return m + (m === 1 ? " minute" : " minutes");
  }
  function hiddenKey() { return "onehr_notice_hidden_" + cur.id; }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  var ICON_CLOCK = '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>';
  var ICON_FIX = '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4 2.6-2.6z"/>';

  function bar() { return document.getElementById("site-notice"); }
  var ICON_MEGA = '<path d="M3 10v4a1 1 0 0 0 1 1h2l6 4V5L6 9H4a1 1 0 0 0-1 1z"/><path d="M16 9a3.5 3.5 0 0 1 0 6"/><path d="M19 6a8 8 0 0 1 0 12"/>';
  var ICON_CAL = '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>';
  var anns = [], annSig = "";
  var place = slot.getAttribute("data-place") || "other";
  function pill() { return document.getElementById("site-notice-pill"); }

  function ensureBar() {
    var b = bar();
    if (b && b.getAttribute("data-id") === String(cur.id)) return b;
    if (b) b.remove();
    b = el("div", "sn-bar" + (auth ? " is-auth" : ""));
    b.id = "site-notice";
    b.setAttribute("data-id", String(cur.id));
    var ns = "http://www.w3.org/2000/svg";
    var ic = document.createElementNS(ns, "svg");
    ic.setAttribute("class", "sn-ic");
    ic.setAttribute("width", "18");
    ic.setAttribute("height", "18");
    ic.setAttribute("viewBox", "0 0 24 24");
    ic.setAttribute("fill", "none");
    ic.setAttribute("stroke", "currentColor");
    ic.setAttribute("stroke-width", "2");
    ic.setAttribute("stroke-linecap", "round");
    ic.setAttribute("stroke-linejoin", "round");
    ic.setAttribute("aria-hidden", "true");
    ic.innerHTML = cur.kind === "fix" ? ICON_FIX : ICON_CLOCK;   // a fixed icon, never data
    b.appendChild(ic);
    b.appendChild(el("span", "sn-text"));
    slot.insertBefore(b, slot.firstChild);
    return b;
  }

  // the text, the sentence up to the countdown (or the first full stop) in bold, as the canvas has it
  function setText(b, lead, body) {
    var t = b.querySelector(".sn-text");
    if (t.getAttribute("data-was") === lead + "|" + body) return;   // the minute hasn't turned: nothing to say again
    t.setAttribute("data-was", lead + "|" + body);
    t.textContent = "";
    t.removeAttribute("data-fit");
    var r = el("span", "sn-run");   // one line: fitRun runs it across the bar when it doesn't fit
    t.appendChild(r);
    if (lead) {
      r.appendChild(el("b", "sn-lead", lead));
      r.appendChild(el("span", "sn-sep", " · "));
      r.appendChild(el("span", "sn-body", body));
    } else {
      var cut = body.indexOf(". ");
      var lm = body.match(/^(.*?\d+:\d\d)(.*)$/);
      if (lm && (cut < 0 || lm[1].length <= cut + 1)) {
        r.appendChild(el("b", null, lm[1]));
        r.appendChild(document.createTextNode(lm[2]));
      } else if (cut > 0) {
        r.appendChild(el("b", null, body.slice(0, cut + 1)));
        r.appendChild(document.createTextNode(body.slice(cut + 1)));
      } else {
        r.appendChild(document.createTextNode(body));
      }
    }
    fitRun(t);
  }

  // the bar is one line (Chris, 2026-10-26): words longer than the bar run across it, a second copy following the
  // first for a seamless loop (hidden from screen readers), about 55 px a second; worked out again when the words or
  // the bar's width change
  function fitRun(t) {
    if (!t || !t.clientWidth) return;   // a folded bar: measured once it shows
    var key = t.clientWidth + "|" + t.getAttribute("data-was");
    if (t.getAttribute("data-fit") === key) return;
    t.setAttribute("data-fit", key);
    var runs = t.querySelectorAll(".sn-run");
    for (var i = 1; i < runs.length; i++) runs[i].remove();
    t.classList.remove("is-running");
    t.removeAttribute("title");
    var r = runs[0];
    if (!r || r.scrollWidth <= t.clientWidth + 1) return;
    var copy = r.cloneNode(true);
    copy.setAttribute("aria-hidden", "true");
    copy.querySelectorAll("a, button").forEach(function (x) { x.setAttribute("tabindex", "-1"); });
    t.appendChild(copy);
    t.classList.add("is-running");
    t.setAttribute("title", r.textContent);
    t.style.setProperty("--sn-dur", Math.max(10, Math.round(r.getBoundingClientRect().width / 55)) + "s");
  }

  function setHide(b, on) {
    var h = b.querySelector("[data-sn-hide]");
    if (on && !h && canHide && pill()) {
      h = el("button", "sn-hide", "Hide");
      h.type = "button";
      h.setAttribute("data-sn-hide", "");
      b.appendChild(h);
    } else if (!on && h) {
      h.remove();
    }
  }

  // --- announcements and the deadline reminder ------------------------------------------------------------------
  function icon(paths, size) {
    var ns = "http://www.w3.org/2000/svg", ic = document.createElementNS(ns, "svg");
    [["class", "sn-ic"], ["width", size], ["height", size], ["viewBox", "0 0 24 24"], ["fill", "none"],
     ["stroke", "currentColor"], ["stroke-width", "2"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"],
     ["aria-hidden", "true"]].forEach(function (a) { ic.setAttribute(a[0], a[1]); });
    ic.innerHTML = paths;   // a fixed icon, never data
    return ic;
  }
  // every item in one line, as the server draws it (_site_notice.html); redrawn only when what it says changes, so a
  // line that's running keeps running
  function paintAnn() {
    var old = document.getElementById("site-ann");
    var list = cur ? [] : anns;
    if (!list.length) { if (old) old.remove(); annSig = ""; return; }
    var sig = list.map(function (x) {
      return [x.key, x.lead, x.body, x.red ? 1 : 0, x.button ? x.button.label + "|" + (x.button.url || "") : ""].join("|");
    }).join("~");
    if (old && sig === annSig) return;
    annSig = sig;
    var red = !!list[0].red;   // a deadline on its last day comes first and turns the bar red
    var b = el("div", "sn-bar sn-ann" + (red ? " is-red" : "") + (auth ? " is-auth" : ""));
    b.id = "site-ann";
    b.setAttribute("role", red ? "alert" : "status");
    var t = el("span", "sn-text"), r = el("span", "sn-run");
    list.forEach(function (it, i) {
      if (i) {
        var dot = el("span", "sn-dot");
        dot.setAttribute("aria-hidden", "true");
        r.appendChild(dot);
      }
      var item = el("span", "sn-item" + (it.red ? " is-red" : ""));
      item.setAttribute("data-key", it.key);
      item.appendChild(icon(it.icon === "cal" ? ICON_CAL : ICON_MEGA, "16"));
      item.appendChild(el("b", "sn-lead", it.lead));
      item.appendChild(el("span", "sn-sep", " · "));
      item.appendChild(el("span", "sn-body", it.body));
      var btn = it.button;
      if (btn && btn.help) {
        var h = el("button", "sn-act", btn.label);
        h.type = "button";
        h.setAttribute("data-help-open", "home");
        item.appendChild(h);
      } else if (btn && /^\/(?!\/)/.test(btn.url || "")) {   // only OneHR's own pages
        var a = el("a", "sn-act", btn.label);
        a.setAttribute("href", btn.url);
        item.appendChild(a);
      }
      r.appendChild(item);
    });
    t.appendChild(r);
    t.setAttribute("data-was", sig);
    b.appendChild(t);
    if (old) old.replaceWith(b);
    else {
      var nb = bar();
      if (nb && nb.nextSibling) slot.insertBefore(b, nb.nextSibling); else slot.appendChild(b);
    }
    document.documentElement.style.setProperty("--sn-h", b.offsetHeight + "px");
    fitRun(t);
  }

  function paint() {
    if (!cur) return;
    var w = cur.words, t = now();
    var st = cur.closes && t >= cur.start ? "closed" : (cur.closes && t >= cur.warn ? "warn" : "info");
    var b = ensureBar();
    var red = w.red || st !== "info";
    b.classList.toggle("is-red", red);
    b.setAttribute("role", red ? "alert" : "status");
    var started = t >= cur.start, until = inWords(cur.start - t);
    if (st === "info") {
      setText(b, w.lead.replace("{mins}", mins(cur.start - t)),
              started && w.info_on ? w.info_on : w.info.replace("{in}", until));
    } else if (st === "warn") {
      setText(b, "", w.warn.replace("{left}", left(cur.start - t)));
    } else {
      setText(b, "", w.closed);
    }
    var hide = st === "info" && !w.red;
    setHide(b, hide);
    var p = pill();
    var folded = hide && canHide && p && read(hiddenKey()) === "1";
    b.hidden = !!folded;
    if (!folded) {
      document.documentElement.style.setProperty("--sn-h", b.offsetHeight + "px");
      fitRun(b.querySelector(".sn-text"));
    }
    if (p) {
      p.hidden = !folded;
      var pw = (started && w.pill_on ? w.pill_on : w.pill || "").replace("{in}", until);
      var pt = p.querySelector(".sn-pill-t"), cut = pw.indexOf(" · ");
      if (pt && pt.getAttribute("data-was") !== pw) {   // the countdown in bold, as the canvas has it
        pt.textContent = "";
        if (cut > 0) {
          pt.appendChild(el("b", null, pw.slice(0, cut)));
          pt.appendChild(document.createTextNode(pw.slice(cut)));
        } else {
          pt.textContent = pw;
        }
        pt.setAttribute("data-was", pw);
        p.setAttribute("aria-label", "Show the notice: " + pw);
      }
    }
    if (st !== state) {
      if (st === "closed") startPoll(60000);
      state = st;
    }
  }

  function clear() {
    var b = bar();
    if (b) b.remove();
    var p = pill();
    if (p) p.hidden = true;
    var s = document.getElementById("site-notice-saved");
    if (s) s.remove();
    cur = null;
    state = "";
    if (tick) { clearInterval(tick); tick = null; }
    paintAnn();
  }

  function load(n) {
    if (!n) { clear(); startPoll(300000); return; }
    offset = n.now - Date.now();
    cur = n;
    paint();
    paintAnn();
    if (!tick) tick = setInterval(paint, 1000);
  }

  function ask() {
    if (document.hidden) return;
    fetch(slot.getAttribute("data-url") + (auth ? "?auth=1" : "?place=" + encodeURIComponent(place)),
          { credentials: "same-origin", cache: "no-store" })
      .then(function (r) {
        if (r.status === 503) return null;   // OneHR is closed: keep the bar as it is
        return r.ok ? r.json() : null;
      })
      .then(function (j) {
        if (j) { anns = j.ann || []; load(j.notice); if (!j.notice) startPoll(300000); }
      })
      .catch(function () { /* offline or closed: try again next time */ });
  }

  function startPoll(every) {
    if (poller && poller.every === every) return;
    if (poller) clearInterval(poller.id);
    poller = { every: every, id: setInterval(ask, every) };
  }

  // a save while OneHR is closed: held on the page with the bar's own words
  function saved() {
    if (!cur || !cur.words.saved) return;
    var s = document.getElementById("site-notice-saved");
    if (!s) {
      s = el("div", "sn-saved");
      s.id = "site-notice-saved";
      s.setAttribute("role", "alert");
      var b = bar();
      if (b && b.nextSibling) slot.insertBefore(s, b.nextSibling); else slot.appendChild(s);
    }
    s.textContent = "";
    var txt = cur.words.saved, cut = txt.indexOf(". ");
    s.appendChild(el("b", null, txt.slice(0, cut + 1)));
    s.appendChild(document.createTextNode(txt.slice(cut + 1)));
    s.scrollIntoView({ block: "nearest" });
  }
  function closedNow() { return cur && cur.closes && now() >= cur.start; }

  // a form posting while closed would leave the page for the closed page and lose what was typed: stop it here,
  // ahead of base.html's own capture-phase handler (window's capture runs first)
  window.addEventListener("submit", function (e) {
    var f = e.target;
    if (!closedNow() || !f || (f.method || "").toLowerCase() !== "post") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    saved();
  }, true);

  // a script's save answered by the closed page (503 with X-OneHR-Closed) says so on the page
  if (window.fetch) {
    var nativeFetch = window.fetch;
    window.fetch = function () {
      return nativeFetch.apply(this, arguments).then(function (r) {
        if (r.status === 503 && r.headers.get("X-OneHR-Closed") === "1") {
          if (!cur) ask();
          saved();
        }
        return r;
      });
    };
  }

  document.addEventListener("click", function (e) {
    var h = e.target.closest && e.target.closest("[data-sn-hide]");
    if (h && cur) { store(hiddenKey(), "1"); paint(); return; }
    var p = e.target.closest && e.target.closest("#site-notice-pill");
    if (p && cur) { store(hiddenKey(), null); paint(); return; }
  });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) ask(); });
  var fitTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(function () {
      document.querySelectorAll("#site-notice .sn-text, #site-ann .sn-text").forEach(fitRun);
    }, 150);
  });

  try { anns = JSON.parse(slot.getAttribute("data-ann") || "[]") || []; } catch (e) { anns = []; }
  var first = bar();
  if (first) {
    try {
      load({ id: +first.getAttribute("data-id"), start: +first.getAttribute("data-start"),
             end: +first.getAttribute("data-end"), warn: +first.getAttribute("data-warn"),
             now: +first.getAttribute("data-now"), closes: first.getAttribute("data-closes") === "1",
             kind: first.getAttribute("data-kind") || "",
             words: JSON.parse(first.getAttribute("data-words") || "{}") });
    } catch (e) { /* the server's bar stays as drawn */ }
    startPoll(state === "closed" ? 60000 : 300000);
  } else {
    startPoll(300000);
    paintAnn();
  }
})();
