// A KPI line's name cell, the same on every KPI table (2026-10-18, the libraries canvas board 22): the KPI in bold, its
// Focus as a tag after it, the person's own description under it clamped (Read all opens the rest in a pop-out). The payloads
// carry `base` (the KPI without its Focus), `focus` and `detail` beside the full name, which stays each row's key.
(function () {
  if (window.onehrKpiLine) return;
  window.onehrKpiLine = {
    // fill a name element: the KPI and its Focus tag; an older payload (no base) prints the full name as before.
    // {tag: false} leaves the Focus out of the name, for a table that says it in meta() under it.
    name: function (el, l, full, opts) {
      var hasParts = l && l.focus && l.base;
      el.textContent = hasParts ? l.base : (full || "");
      if (hasParts && !(opts && opts.tag === false)) {
        var f = document.createElement("span"); f.className = "kpi-focus"; f.textContent = l.focus;
        f.title = "Focus: " + l.focus;
        el.appendChild(f);
      }
      return el;
    },
    // the quiet line under the name on the check-in's KPI tables (2026-10-22, canvas "OneHR KPI Table Refresh"): its
    // Focus, which way is better, and a unit-wide line's note; null when there is nothing to say
    // A 1-5 rating line says how it is rated instead (2026-10-30, Option B): `direction_say` on the table, the longer
    // `direction_say_full` in the hover title and, with `full`, in the Read all pop-out's meta line.
    meta: function (l, full) {
      if (!l) return null;
      var bits = [];
      if (l.focus && l.base) bits.push(l.focus);
      if (l.direction_say) bits.push(full && l.direction_say_full ? l.direction_say_full : l.direction_say);
      else if (l.direction) bits.push(l.direction);
      if (l.bu_level) bits.push("the whole unit's figure");
      if (!bits.length) return null;
      var m = document.createElement("div"); m.className = "kpi-meta"; m.textContent = bits.join(" \u00b7 ");
      if (l.direction_say_full && !full) {
        var tl = []; if (l.focus && l.base) tl.push(l.focus); tl.push(l.direction_say_full);
        if (l.bu_level) tl.push("the whole unit's figure");
        m.title = tl.join(" \u00b7 ");
      }
      return m;
    },
    // the person's description, clamped (one line on the check-in tables, two elsewhere); null when there is none.
    // Returns ONE element, a wrapper holding the clamped text and, only when the text is really cut, a "Read all"
    // button that opens the pop-out (Chris, 2026-10-29, canvas [design canvas link removed])
    desc: function (l, cls) {
      if (!l || !l.detail) return null;
      var d = document.createElement("div");
      d.className = (cls || "rv-kpi-desc") + " kpi-desc";
      d.textContent = l.detail;
      return window.onehrKpiLine.cut(d, l);
    },
    // THE ONE cut-check (2026-11-04): wraps a clamped description element in .kpi-desc-wrap and adds the "Read all" button,
    // shown only when the text is really cut. desc() builds its element here; server-drawn markup
    // (<div class="rv-kpi-desc kpi-desc" data-kpi-read ...>, the admin person page and the calibration KPI report) comes
    // through enhance() below. If d is already in the page it is swapped for the wrapper.
    cut: function (d, l) {
      var wrap = document.createElement("div"); wrap.className = "kpi-desc-wrap";
      var b = document.createElement("button"); b.type = "button"; b.className = "kpi-desc-more"; b.textContent = "Read all";
      b.hidden = true;
      var open = function (e) { if (e) e.stopPropagation(); window.onehrKpiLine.open(l, b); };
      b.addEventListener("click", open);
      d.addEventListener("click", function (e) { if (d.classList.contains("is-cut")) open(e); });
      var check = function () {
        var cut = d.clientHeight > 0 && d.scrollHeight > d.clientHeight + 1;
        d.classList.toggle("is-cut", cut);
        b.hidden = !cut;
      };
      if (d.parentNode) d.parentNode.replaceChild(wrap, d);
      wrap.appendChild(d); wrap.appendChild(b);
      if (typeof ResizeObserver === "function") new ResizeObserver(check).observe(d);
      else window.setTimeout(check, 0);
      // a size observer fires only when the box changes size: a page that settles later (fonts, styles, a hidden tab shown)
      // is measured again once it has loaded
      if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(check);
      if (document.readyState !== "complete") window.addEventListener("load", check);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(check);
      return wrap;
    },
    // Server-drawn descriptions: every [data-kpi-read] not yet done gets the same Read all. The element's text is the
    // description; data-kpi-name (pop-out title), data-kpi-weight and data-kpi-meta (the line under the title) come with it.
    enhance: function (root) {
      var K = window.onehrKpiLine;
      [].forEach.call((root || document).querySelectorAll("[data-kpi-read]:not([data-kpi-read-done])"), function (d) {
        d.setAttribute("data-kpi-read-done", "1");
        var w = parseFloat(d.getAttribute("data-kpi-weight"));
        var meta = d.getAttribute("data-kpi-meta") || "";
        var l = { detail: d.textContent.trim(), name: d.getAttribute("data-kpi-name") || "KPI", weight: isFinite(w) ? w : undefined };
        if (meta) l.direction = meta;
        if (l.detail) K.cut(d, l);
      });
    },
    // The rating lines inside a description: {intro, ratings}; ratings is null with fewer than two markers.
    // Markers: "Rating 3 =", "rate 1:", "R2 -", "Rating 3 (Target):", "(4) ". Order is as written.
    parseRatings: function (text) {
      var t = String(text == null ? "" : text);
      var re = /(?:\b(?:Rating|Rate|R)\s*([1-5])\b(\s*\([^)]{0,20}\))?\s*[:=\-–]|\(\s*([1-5])\s*\)\s)/gi;
      var hits = [], m;
      while ((m = re.exec(t)) !== null) {
        hits.push({ at: m.index, end: m.index + m[0].length, n: parseInt(m[1] || m[3], 10), target: /target/i.test(m[2] || "") });
      }
      if (hits.length < 2) return { intro: t.trim(), ratings: null };
      var intro = t.slice(0, hits[0].at).trim(), prev;
      do {
        prev = intro;
        intro = intro.replace(/(?:\bRatings?(?:\s+Scale)?)?\s*(?::-|:|\u2022)\s*$/i, "").trim();
      } while (intro !== prev);
      var ratings = hits.map(function (h, i) {
        var body = t.slice(h.end, i + 1 < hits.length ? hits[i + 1].at : t.length);
        body = body.replace(/\s+/g, " ").replace(/^[•;,\-\s]+|[•;,\-\s]+$/g, "");
        body = body.charAt(0).toUpperCase() + body.slice(1);
        return { n: h.n, text: body, target: h.target };
      });
      return { intro: intro, ratings: ratings };
    },
    // THE 1-5 PICK (Chris, 2026-10-30, Option B): the Result of a rating line is chosen, not typed. ONE builder for every
    // KPI table (the employee's check-in, the line manager's moderation, the on-behalf and the classic chat), so they cannot
    // drift. Returns a button.kpi-pick (168 x 38) that opens a listbox of the KPI's own rating words (parseRatings of the
    // description). opts: value (1-5 or null), placeholder ("Pick 1 to 5"; the line manager's "keep Rating 4"), theirs (a
    // rating, tagged "Theirs"), emptyIs (the rating shown selected while no value is set), onPick(n). The button has
    // setValue(n|null) so a table can repaint it from the hidden input that carries the value.
    pick: function (l, opts) {
      opts = opts || {};
      var K = window.onehrKpiLine, NS = "http://www.w3.org/2000/svg";
      var el = function (tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
      var icon = function (d, w, color) {
        var sv = document.createElementNS(NS, "svg"), pa = document.createElementNS(NS, "path");
        sv.setAttribute("width", "16"); sv.setAttribute("height", "16"); sv.setAttribute("viewBox", "0 0 24 24"); sv.setAttribute("fill", "none");
        sv.setAttribute("stroke", color || "currentColor"); sv.setAttribute("stroke-width", w || "2"); sv.setAttribute("stroke-linecap", "round");
        sv.setAttribute("stroke-linejoin", "round"); sv.setAttribute("aria-hidden", "true"); pa.setAttribute("d", d); sv.appendChild(pa); return sv;
      };
      var whole = function (v) { var n = Math.round(Number(v)); return (v !== null && v !== undefined && v !== "" && isFinite(Number(v)) && n >= 1 && n <= 5) ? n : null; };
      var value = whole(opts.value), name = l.base || l.kpi || l.name || "this KPI";
      var btn = el("button", "kpi-pick"); btn.type = "button";
      btn.setAttribute("aria-haspopup", "listbox"); btn.setAttribute("aria-expanded", "false");
      var lab = el("span", "kpi-pick-v"), chev = icon("m6 9 6 6 6-6");
      chev.setAttribute("class", "kpi-pick-chev");
      btn.appendChild(lab); btn.appendChild(chev);
      var paint = function () {
        lab.textContent = value != null ? "Rating " + value : (opts.placeholder || "Pick 1 to 5");
        btn.classList.toggle("is-empty", value == null);
        btn.setAttribute("aria-label", value != null ? "Rating for " + name + ": Rating " + value
          : (opts.placeholder ? name + ": " + opts.placeholder : "Pick a rating for " + name));
        chev.firstChild.setAttribute("d", btn.getAttribute("aria-expanded") === "true" ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6");
      };
      btn.setValue = function (v) { value = whole(v); paint(); };
      btn.getValue = function () { return value; };
      var pop = null, onDoc = null, onKey = null, onMove = null;
      var close = function (refocus) {
        if (!pop) return;
        var p = pop; pop = null;
        document.removeEventListener("mousedown", onDoc, true); document.removeEventListener("keydown", onKey, true);
        window.removeEventListener("resize", onMove); window.removeEventListener("scroll", onMove, true);
        if (p.parentNode) p.parentNode.removeChild(p);
        if (K._pickClose === close) K._pickClose = null;
        btn.setAttribute("aria-expanded", "false"); btn.classList.remove("is-picking"); paint();
        if (refocus && document.contains(btn)) btn.focus();
      };
      var place = function () {
        if (!pop) return;
        if (!document.contains(btn)) { close(false); return; }
        var r = btn.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
        var w = Math.min(420, vw - 24); pop.style.width = w + "px";
        var left = Math.max(12, Math.min(r.right - w, vw - w - 12));
        var h = pop.offsetHeight, top = r.bottom + 6;
        if (top + h > vh - 12 && r.top - 6 - h >= 12) top = r.top - 6 - h;   // no room below: flip above
        pop.style.left = left + "px"; pop.style.top = Math.max(12, top) + "px";
      };
      var open = function () {
        if (pop) return;
        if (K._pickClose) K._pickClose(false);   // one popover at a time
        var pr = K.parseRatings(l.detail || ""), words = {};
        if (pr.ratings) pr.ratings.forEach(function (r) { if (!words[r.n]) words[r.n] = r; });
        var has = !!pr.ratings, sel = value != null ? value : whole(opts.emptyIs);
        pop = el("div", "kpi-pick-pop"); pop.setAttribute("role", "listbox");
        pop.setAttribute("aria-label", (has ? "How it's rated: " : "Pick a rating: ") + name);
        var head = el("div", "kpi-pick-head");
        head.appendChild(el("span", "kpi-pick-lbl", has ? "How it's rated" : "Pick a rating"));
        head.appendChild(el("span", "kpi-pick-best", "5 is best"));
        pop.appendChild(head);
        var opt = [];
        [1, 2, 3, 4, 5].forEach(function (n) {
          var b = el("button", "kpi-pick-opt" + (n === sel ? " is-sel" : "")); b.type = "button";
          b.setAttribute("role", "option"); b.setAttribute("aria-selected", n === sel ? "true" : "false"); b.tabIndex = -1;
          b.appendChild(el("span", "kpi-pick-chip", "Rating " + n));
          var w = words[n], tx = el("span", "kpi-pick-text");
          if (w) { tx.appendChild(document.createTextNode(w.text)); if (w.target) tx.appendChild(el("span", "kpi-dlg-target", "Target")); }
          else if (!has && (n === 1 || n === 5)) { tx.className += " is-soft"; tx.appendChild(document.createTextNode(n === 1 ? "Lowest" : "Best")); }
          if (opts.theirs != null && whole(opts.theirs) === n) tx.appendChild(el("span", "kpi-pick-theirs", "Theirs"));
          b.appendChild(tx);
          if (n === sel) { var tk = icon("M5 12.5 10 17 19 7", "2.4", "currentColor"); tk.setAttribute("class", "kpi-pick-tick"); b.appendChild(tk); }
          b.addEventListener("click", function () { value = n; close(true); paint(); if (opts.onPick) opts.onPick(n); });
          pop.appendChild(b); opt.push(b);
        });
        if (l.detail) {   // the foot: where the words come from, and the way to read them all (2026-10-30)
          var foot = el("div", "kpi-pick-foot");
          var ra = el("button", "kpi-pick-readall", has ? "Read all" : "Read all for what this KPI means"); ra.type = "button";
          ra.addEventListener("click", function () { close(false); K.open(l, btn); });
          if (has) foot.appendChild(el("span", null, "From this KPI's own words"));
          foot.appendChild(ra); pop.appendChild(foot);
        }
        document.body.appendChild(pop);
        btn.setAttribute("aria-expanded", "true"); btn.classList.add("is-picking"); paint();
        place();
        onDoc = function (e) { if (pop && !pop.contains(e.target) && !btn.contains(e.target)) close(false); };
        onKey = function (e) {
          if (!pop) return;
          var i = opt.indexOf(document.activeElement);
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
          else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault(); e.stopPropagation();
            opt[(i < 0 ? (e.key === "ArrowDown" ? 0 : 4) : (i + (e.key === "ArrowDown" ? 1 : 4)) % 5)].focus();
          }
          else if (e.key === "Home") { e.preventDefault(); opt[0].focus(); }
          else if (e.key === "End") { e.preventDefault(); opt[4].focus(); }
          else if (e.key === "Tab") close(false);
        };
        onMove = function () { place(); };
        document.addEventListener("mousedown", onDoc, true); document.addEventListener("keydown", onKey, true);
        window.addEventListener("resize", onMove); window.addEventListener("scroll", onMove, true);
        K._pickClose = close;
        (sel ? opt[sel - 1] : opt[0]).focus();
      };
      btn.addEventListener("click", function (e) { e.preventDefault(); if (pop) close(true); else open(); });
      btn.addEventListener("keydown", function (e) {
        if (e.key === "ArrowDown" && !pop) { e.preventDefault(); open(); }
      });
      paint();
      return btn;
    },
    // The pop-out: the whole description, with a rating table when the text carries rating lines. `fromEl` (the
    // Read all button) gets the focus back on close; one dialog at a time.
    open: function (l, fromEl) {
      if (!l || !l.detail) return;
      // an open one closes through its own path, so the page's scroll setting is put back first
      var old = document.querySelector(".kpi-dlg");
      if (old && old._kpiClose) old._kpiClose(); else if (old && old.parentNode) old.parentNode.removeChild(old);
      var K = window.onehrKpiLine;
      var el = function (tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
      // place among the KPI rows of its table (best effort) and the weight, when the payload has a number
      var nOf = null, total = null;
      var tr = fromEl && fromEl.closest ? fromEl.closest("tr") : null, tbl = tr && tr.closest ? tr.closest("table") : null;
      if (tr && tbl) {
        var rows = [].filter.call(tbl.querySelectorAll("tbody tr"), function (r) {
          return r.querySelector(".kpi-desc-wrap, .rv-kpi-name, .od-kn, .od-kt-n");
        });
        var ix = rows.indexOf(tr);
        if (ix >= 0) { nOf = ix + 1; total = rows.length; }
      }
      var wv = [l.weight, l.weightage, l.weight_pct].filter(function (v) { return typeof v === "number" || (typeof v === "string" && v.trim() !== "" && isFinite(v)); })[0];
      var eyebrow = [];
      if (nOf) eyebrow.push("KPI " + nOf + " of " + total);
      if (wv !== undefined) eyebrow.push("Weight " + (+wv) + "%");
      var ov = el("div", "modal-overlay confirm-dialog kpi-dlg");
      var card = el("div", "modal-card"); card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true");
      var hid = "kpi-dlg-h-" + Date.now(); card.setAttribute("aria-labelledby", hid);
      var x = el("button", "kpi-dlg-x"); x.type = "button"; x.setAttribute("aria-label", "Close");
      var NS = "http://www.w3.org/2000/svg", sv = document.createElementNS(NS, "svg"), pa = document.createElementNS(NS, "path");
      sv.setAttribute("width", "16"); sv.setAttribute("height", "16"); sv.setAttribute("viewBox", "0 0 24 24"); sv.setAttribute("fill", "none");
      sv.setAttribute("stroke", "currentColor"); sv.setAttribute("stroke-width", "2"); sv.setAttribute("stroke-linecap", "round");
      sv.setAttribute("aria-hidden", "true"); pa.setAttribute("d", "M6 6l12 12M18 6 6 18"); sv.appendChild(pa); x.appendChild(sv);
      // three parts: the head and the foot stay put, the body scrolls inside the box
      var head = el("div", "kpi-dlg-head"), body = el("div", "kpi-dlg-body"), foot = el("div", "kpi-dlg-foot");
      body.setAttribute("tabindex", "0"); body.setAttribute("role", "region"); body.setAttribute("aria-label", "Description");
      head.appendChild(x);
      if (eyebrow.length) head.appendChild(el("p", "kpi-dlg-eyebrow", eyebrow.join(" · ")));
      var h = el("h2", "kpi-dlg-title", l.base || l.kpi || l.name || "KPI"); h.id = hid; head.appendChild(h);
      var mt = K.meta(l, true);
      if (mt) head.appendChild(el("p", "kpi-dlg-meta", mt.textContent)); else h.className += " is-alone";
      var pr = K.parseRatings(l.detail);
      if (pr.ratings) {
        if (pr.intro) body.appendChild(el("p", "kpi-dlg-intro", pr.intro));
        body.appendChild(el("p", "kpi-dlg-label", "How it's rated"));
        var ol = el("ol", "kpi-dlg-rates");
        pr.ratings.forEach(function (r) {
          var li = el("li");
          li.appendChild(el("span", "kpi-dlg-chip", "Rating " + r.n));
          var tx = el("span", "kpi-dlg-text", r.text);
          if (r.target) tx.appendChild(el("span", "kpi-dlg-target", "Target"));
          li.appendChild(tx); ol.appendChild(li);
        });
        body.appendChild(ol);
      } else {
        String(l.detail).split(/\n\s*\n/).forEach(function (para) {
          if (para.trim()) body.appendChild(el("p", "kpi-dlg-para", para.trim()));
        });
      }
      var acts = el("div", "modal-actions"); var cb = el("button", null, "Close"); cb.type = "button"; acts.appendChild(cb);
      foot.appendChild(acts); card.appendChild(head); card.appendChild(body); card.appendChild(foot);
      ov.appendChild(card); document.body.appendChild(ov);
      // the page behind stays still while the pop-out is open
      var root = document.documentElement, savedOverflow = root.style.overflow; root.style.overflow = "hidden";
      // a hairline under the head while scrolled down, above the foot while there is more below
      var edges = function () {
        card.classList.toggle("is-top-shadow", body.scrollTop > 0);
        card.classList.toggle("is-bottom-shadow", body.scrollTop + body.clientHeight < body.scrollHeight - 1);
      };
      body.addEventListener("scroll", edges);
      var ro = typeof ResizeObserver === "function" ? new ResizeObserver(edges) : null;
      if (ro) ro.observe(body);
      edges();
      var done = false, bk = null;   // bk: the phone's back gesture closes the pop-out first (static/move_in.js, onehrBackLayer)
      var close = function () {
        if (done) return; done = true;
        if (ro) ro.disconnect();
        root.style.overflow = savedOverflow;
        document.removeEventListener("keydown", onKey, true);
        if (ov.parentNode) ov.parentNode.removeChild(ov);
        if (bk) bk.done();
        if (fromEl && fromEl.focus && document.contains(fromEl)) fromEl.focus();
      };
      var onKey = function (e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
        else if (e.key === "Tab") {
          var a = document.activeElement;
          if (e.shiftKey && a === x) { e.preventDefault(); cb.focus(); }
          else if (!e.shiftKey && a === cb) { e.preventDefault(); x.focus(); }
          else if (!card.contains(a)) { e.preventDefault(); x.focus(); }
        }
      };
      document.addEventListener("keydown", onKey, true);
      ov._kpiClose = close;
      if (typeof window.onehrBackLayer === "function") bk = window.onehrBackLayer(function () { close(); });
      x.addEventListener("click", close); cb.addEventListener("click", close);
      ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
      x.focus();
    }
  };
  // server-drawn descriptions: at load, and in any fragment fetched in later (the calibration KPI report panel)
  var go = function () {
    window.onehrKpiLine.enhance(document);
    if (typeof MutationObserver === "function" && document.body) {
      new MutationObserver(function () {
        if (document.querySelector("[data-kpi-read]:not([data-kpi-read-done])")) window.onehrKpiLine.enhance(document);
      }).observe(document.body, { childList: true, subtree: true });
    }
  };
  if (typeof document === "undefined") return;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();
})();