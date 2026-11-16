/* The calibration screens' shared pieces (Chris, 2026-10-30, canvas "OneHR Calibration Filter Rules", boards E and F).
 *
 * ONE filter line (chips whose lists take several ticked values; a tick applies as it is made), ONE curve box (the rows of the expected
 * spread) and ONE curve dialog, used by the AI+ review journey (static/journey_chat.js: the BU CEO / calibration group
 * card and the BG CEO's Talent Box) and by the admin's read-only Talent Box (static/admin_talent_box.js). They live here,
 * outside the 15,000-line chat closure, so the admin page can draw them without loading the chat. Read only in every
 * sense: a pick only narrows what is on screen; no band, lock or move depends on it.
 *
 * A chip is { key, label, chip, bare, plural, proper, values: [keys], valueLabels: [words], all, options: [{key, label, n,
 * hint, title, ids}], notSet, search, earlier }. `values` is every value ticked and applied ([] = all); a person matches a
 * filter when they match ANY of its values, and the filters combine (the caller narrows; this file draws).
 */
(function () {
  "use strict";
  var NOTSET = "~none";   // the explicit "Not set on the roster" value of a roster column
  var DASH = "—";
  var pn = window.onehrProper || function (s) { return s; };
  function rmkEl(tag, cls, text) {
    var e = document.createElement(tag); if (cls) e.className = cls;
    if (text != null) e.textContent = text; return e;
  }
  function svgEl(name, attrs) {
    var e = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }

  /* ================= THE FILTER LINE =================
     ONE line of filter chips on the calibration screens: a label, one chip per filter switched on for the unit, then
     "Showing N of M" and, once something is picked, Clear. A chip opens a listbox: "All <plural>", each value with its
     count (counted within the picks BEFORE it), "Not set on the roster" where someone has none, a search box from 9 values.
     Every value has a tick box and a tick APPLIES AS IT IS MADE (Chris, 2026-10-31: "live"): each tick, "All <plural>" and the
     list's Clear hand the picks to the caller (`onPick`) after 250 ms, so quick ticks make one call, and not at all when the set
     is what is applied already. The foot says "2 picked . 11 people"; Done closes the list (Enter on a row is Done), and Done,
     Esc, an outside click and Tab all hand a pending pick on first, so nothing ticked is ever undone. The list FOLLOWS ITS
     CHIP: it is placed again whenever the page or any container scrolls, it closes when the chip scrolls out of sight, and it
     stays open (search, ticks, scroll, keyboard focus) when the caller redraws the line after a pick: the new chip with the
     same key takes the list over. A caller whose pick reloads the page (the admin's Talent Box) passes `live: false` and gets
     the picks when the list closes instead. The BU CEO's card narrows its rows on the client; the Talent Boxes ask the
     server. */
  var flPop = null;   // the open list: { el, chip, key, ctx, flush, pending, resync, place, onDoc, onKey, onResize, onScroll, watch }
  var FL_WAIT = 250;  // ms a tick waits for the next one before the pick is handed on
  // drop = true: the pending pick is not handed on (the line's own Clear is about to replace every pick)
  function flClose(refocus, drop) {
    if (!flPop) return;
    var p = flPop;
    if (!drop) p.flush();   // the pick still waiting goes first; the caller may redraw the chip, which p.chip then follows
    flPop = null;
    clearInterval(p.watch);
    document.removeEventListener("mousedown", p.onDoc, true);
    document.removeEventListener("keydown", p.onKey, true);
    document.removeEventListener("scroll", p.onScroll, true);
    window.removeEventListener("resize", p.onResize);
    if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
    if (p.chip && document.body.contains(p.chip)) {
      p.chip.setAttribute("aria-expanded", "false"); p.chip.classList.remove("is-open");
      if (refocus) p.chip.focus();
    }
  }
  // is the list of this filter open? (a caller's focus-back after a pick must not pull focus out of an open list)
  function flIsOpen(key) { return !!flPop && (key == null || flPop.key === key); }
  // a chip is in view when it meets the window and every scrolling container it sits in
  function flChipVisible(chip) {
    var r = chip.getBoundingClientRect();
    var L = 0, T = 0, R = window.innerWidth, B = window.innerHeight;
    for (var el = chip.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      var cs = window.getComputedStyle(el);
      if (/(auto|scroll|hidden|clip)/.test(cs.overflow + cs.overflowX + cs.overflowY)) {
        var e = el.getBoundingClientRect();
        L = Math.max(L, e.left); T = Math.max(T, e.top); R = Math.min(R, e.right); B = Math.min(B, e.bottom);
      }
    }
    return r.right > L && r.left < R && r.bottom > T && r.top < B;
  }
  function flText(c, s) { return c.proper ? pn(s) : s; }
  function flVals(c) { return (c.values || []).slice(); }
  // the words of one applied value: "Not set" for the explicit pick, else the label the caller gave, else the option's own
  function flValLabel(c, k, i) {
    if (k === NOTSET) return "Not set";
    var o = (c.options || []).filter(function (x) { return x.key === k; })[0];
    return flText(c, (c.valueLabels && c.valueLabels[i]) || (o && o.label) || k);
  }
  // how many people a set of ticked values holds (counted within the picks before this chip): a calibrator can hold the same
  // person as another, so options that carry their `ids` are united; the rest are disjoint and add up
  function flMatchN(c, keys) {
    if (!keys.length) return c.all;
    var byKey = {}, withIds = false;
    (c.options || []).forEach(function (o) { byKey[o.key] = o; if (o.ids) withIds = true; });
    if (withIds) {
      var seen = {}, n = 0;
      keys.forEach(function (k) { ((byKey[k] || {}).ids || []).forEach(function (id) { if (!seen[id]) { seen[id] = 1; n += 1; } }); });
      return n;
    }
    return keys.reduce(function (n, k) { return n + (k === NOTSET ? (c.notSet || 0) : ((byKey[k] || {}).n || 0)); }, 0);
  }
  function flCountOf(c) { return flMatchN(c, flVals(c)); }
  // "2 cost centres" / the lone value's words: what the title bar, the people panel and "Counted within" say of a pick
  function pickWords(c) {
    var v = flVals(c);
    if (!v.length) return "";
    if (v.length > 1) return v.length + " " + c.plural;
    return v[0] === NOTSET ? "no " + c.label.toLowerCase() : flValLabel(c, v[0], 0);
  }
  function flChip(c, onPick, live) {
    var vals = flVals(c);
    var b = document.createElement("button"); b.type = "button";
    b.className = "rv-cal-chip" + (vals.length ? " is-picked" : "");
    b.setAttribute("data-fkey", c.key);
    b.setAttribute("aria-haspopup", "listbox"); b.setAttribute("aria-expanded", "false");
    var t = rmkEl("span", "rv-cal-chip-t");
    if (vals.length > 1) {   // several: "CC: 2 picked"; every value is in the hover
      t.appendChild(rmkEl("span", "rv-cal-chip-k", c.chip + ": "));
      t.appendChild(rmkEl("span", "rv-cal-chip-v", vals.length + " picked"));
    } else if (vals.length) {   // the name gives way first when the line is tight, never the value picked
      var vt = flValLabel(c, vals[0], 0);
      // "CC: North - Sales"; a bare filter's value that already starts with its chip words shows alone ("JG 12–14")
      t.appendChild(rmkEl("span", "rv-cal-chip-k", c.bare && vt.indexOf(c.chip + " ") === 0 ? "" : c.chip + ": "));
      t.appendChild(rmkEl("span", "rv-cal-chip-v", vt));
    } else {   // "All cost centres", or just "Cost centre" when the line is too tight for every chip (flFit)
      t.appendChild(rmkEl("span", "rv-cal-t-long", "All " + c.plural));
      t.appendChild(rmkEl("span", "rv-cal-t-short", c.chip || c.label));
    }
    b.appendChild(t);
    b.appendChild(rmkEl("span", "rv-cal-chip-n", String(flCountOf(c))));
    var ch = svgEl("svg", { viewBox: "0 0 24 24", "class": "rv-cal-chip-chev", "aria-hidden": "true" });
    ch.appendChild(svgEl("path", { d: "M6 9l6 6 6-6" })); b.appendChild(ch);
    b.title = c.label + (vals.length ? ": " + vals.map(function (k, i) {
      return k === NOTSET ? "Not set on the roster" : flValLabel(c, k, i); }).join(", ") : "");
    b.addEventListener("click", function () {
      if (flPop && flPop.chip === b) { flClose(true); return; }
      flOpen(b, c, onPick, live);
    });
    // the caller redrew the line after a pick while this filter's list is open: this chip is the list's new anchor
    if (flPop && flPop.key === c.key) {
      flPop.chip = b; b.setAttribute("aria-expanded", "true"); b.classList.add("is-open");
      flPop.adopt(c, onPick);
    }
    return b;
  }
  function flOpen(chip, c, onPick, live) {
    flClose(false);
    // what the list is working from; a redrawn line hands it its new chip's `c` and `onPick` (adopt)
    var ctx = { c: c, onPick: onPick, live: live !== false, applied: flVals(c) };
    // the chip the list hangs from: flChip swaps it when the caller redraws the line
    Object.defineProperty(ctx, "chip", { get: function () { return flPop ? flPop.chip : chip; } });
    var pop = rmkEl("div", "rv-cal-pop"); pop.setAttribute("translate", "no");
    var pend = {};   // the ticks as they stand: key -> true
    ctx.applied.forEach(function (k) { pend[k] = true; });
    var q = null;
    if (c.search) {
      q = document.createElement("input"); q.type = "search"; q.className = "rv-cal-pop-q";
      q.placeholder = "Find a " + c.label.toLowerCase(); q.setAttribute("aria-label", "Find a " + c.label.toLowerCase());
      q.setAttribute("autocomplete", "off");
      pop.appendChild(q);
    }
    var list = rmkEl("div", "rv-cal-pop-list"); list.setAttribute("role", "listbox"); list.setAttribute("aria-label", c.label);
    list.setAttribute("aria-multiselectable", "true");
    var rows = [{ key: "", label: "All " + c.plural, n: c.all, all: true }].concat(c.options || []);
    if (c.notSet) rows.push({ key: NOTSET, label: "Not set on the roster", n: c.notSet, quiet: true });
    var opts = [];
    var ticked = function () { return rows.filter(function (o) { return !o.all && pend[o.key]; }).map(function (o) { return o.key; }); };
    var sum = rmkEl("span", "rv-cal-pop-sum"); sum.setAttribute("role", "status");
    var paint = function () {
      var keys = ticked();
      opts.forEach(function (r) {
        var k = r.getAttribute("data-fval"), on = k === "" ? !keys.length : !!pend[k];
        r.classList.toggle("is-on", on); r.setAttribute("aria-selected", on ? "true" : "false");
      });
      var m = flMatchN(ctx.c, keys);
      sum.textContent = (keys.length ? keys.length + " picked" : "None picked") + " · " + m + (m === 1 ? " person" : " people");
    };
    // the pick: handed on after a short wait so quick ticks are one call, and never when it is what is applied already
    var timer = 0;
    var flush = function () {
      clearTimeout(timer); timer = 0;
      var keys = ticked(), was = ctx.applied;
      if (keys.length === was.length && keys.every(function (k) { return was.indexOf(k) >= 0; })) return;
      ctx.applied = keys;
      ctx.onPick(ctx.c.key, keys);
    };
    var later = function () { if (ctx.live) { clearTimeout(timer); timer = setTimeout(flush, FL_WAIT); } };
    var toggle = function (k) {
      if (k === "") pend = {};   // "All": no tick left on this filter
      else if (pend[k]) delete pend[k]; else pend[k] = true;
      paint(); later();
    };
    rows.forEach(function (o) {
      var r = document.createElement("div");
      r.className = "rv-cal-opt" + (o.quiet ? " is-quiet" : "");
      r.setAttribute("role", "option"); r.setAttribute("aria-selected", "false"); r.tabIndex = -1;
      r.setAttribute("data-fval", o.key);
      r.setAttribute("data-ftext", (o.label || "").toLowerCase());
      var bx = rmkEl("span", "rv-cal-opt-box"); bx.setAttribute("aria-hidden", "true");
      var tk = svgEl("svg", { viewBox: "0 0 24 24", "class": "rv-cal-opt-tick", "aria-hidden": "true" });
      tk.appendChild(svgEl("path", { d: "M5 12l5 5 9-10" })); bx.appendChild(tk);
      r.appendChild(bx);
      var ot = rmkEl("span", "rv-cal-opt-t", o.all || o.quiet ? o.label : flText(c, o.label));
      ot.title = ot.textContent;   // a long value ends in "..." with its full words on hover
      r.appendChild(ot);
      if (o.hint) r.appendChild(rmkEl("span", "rv-cal-opt-h", o.hint));
      r.appendChild(rmkEl("span", "rv-cal-opt-n", String(o.n || 0)));
      if (o.title) r.title = o.title;
      r.addEventListener("click", function () { toggle(o.key); });
      list.appendChild(r); opts.push(r);
    });
    pop.appendChild(list);
    if (c.earlier && c.earlier.length) {
      pop.appendChild(rmkEl("div", "rv-cal-pop-foot", "Counted within " + c.earlier.map(function (e) {
        return e === NOTSET ? "Not set" : e; }).join(" · ")));
    }
    var act = rmkEl("div", "rv-cal-pop-act");
    act.appendChild(sum);
    var btns = rmkEl("span", "rv-cal-pop-btns");
    var clr = rmkEl("button", "rv-cal-pop-clear", "Clear"); clr.type = "button";
    clr.setAttribute("aria-label", "Untick every " + c.label.toLowerCase());
    clr.addEventListener("click", function () { pend = {}; paint(); later(); });
    var ok = rmkEl("button", "rv-cal-pop-apply", "Done"); ok.type = "button";
    // Done: any pending pick goes first (flClose), then back to the chip this list opened from
    var done = function () { flClose(true); };
    ok.addEventListener("click", done);
    btns.appendChild(clr); btns.appendChild(ok); act.appendChild(btns);
    pop.appendChild(act);
    paint();
    document.body.appendChild(pop);
    var place = function () {
      var r = ctx.chip.getBoundingClientRect(), w = 300;
      var left = Math.max(8, Math.min(r.left, document.documentElement.clientWidth - w - 8));
      pop.style.left = left + "px";
      var h = pop.offsetHeight, below = window.innerHeight - r.bottom - 6;
      pop.style.top = (below >= h || r.top < h + 6 ? r.bottom + 6 : r.top - h - 6) + "px";
    };
    place();
    chip.setAttribute("aria-expanded", "true"); chip.classList.add("is-open");
    var visible = function () { return opts.filter(function (o) { return !o.hidden; }); };
    var onKey = function (e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); flClose(true); return; }   // closes; a pick waiting is handed on first
      if (e.key === "Tab") { flClose(false); return; }
      var items = visible(), i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); (items[Math.min(items.length - 1, i + 1)] || items[0]).focus(); }
      else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (i <= 0 && q) q.focus(); else (items[Math.max(0, i - 1)] || items[0]).focus();
      }
      else if (e.key === " " && i >= 0) { e.preventDefault(); toggle(items[i].getAttribute("data-fval")); }   // Space ticks the row
      else if (e.key === "Enter" && !(e.target && e.target.tagName === "BUTTON")) { e.preventDefault(); done(); }   // Enter is Done
    };
    var onDoc = function (e) { if (!pop.contains(e.target) && !ctx.chip.contains(e.target)) flClose(false); };
    var onResize = function () { place(); };
    // the list follows its chip: any scroll (the window, or a container the page keeps inside itself) places it again, and a
    // chip scrolled out of sight takes the list with it; the list's own scrolling is its own
    var onScroll = function (e) {
      if (pop.contains(e.target) || !document.body.contains(ctx.chip)) return;
      if (!flChipVisible(ctx.chip)) { flClose(false); return; }
      place();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    // the caller redraws the line after a pick: the chip it replaced is gone, and the new one (flChip) is adopted. A chip that
    // never comes back (the server dropped the filter) ends the list; the line's own size changes move it
    var watch = setInterval(function () {
      if (!document.body.contains(ctx.chip)) { flClose(false, true); return; }
      place();
    }, 200);
    flPop = {
      el: pop, chip: chip, key: c.key, ctx: ctx, flush: flush, place: place, watch: watch,
      onDoc: onDoc, onKey: onKey, onResize: onResize, onScroll: onScroll,
      adopt: function (nc, np) {
        ctx.c = nc; ctx.onPick = np;
        if (!timer) {   // nothing newer is waiting: the ticks follow what the line now holds (a value the server dropped goes)
          ctx.applied = flVals(nc); pend = {}; ctx.applied.forEach(function (k) { pend[k] = true; }); paint();
        }
        setTimeout(function () { if (flPop && flPop.ctx === ctx) place(); }, 0);
      }
    };
    if (q) {
      q.addEventListener("input", function () {   // the search only hides rows: what is ticked stays ticked
        var t = q.value.trim().toLowerCase();
        opts.forEach(function (o) {
          o.hidden = !!t && (o.getAttribute("data-fval") === "" || o.getAttribute("data-ftext").indexOf(t) < 0);
        });
        place();
      });
      q.focus();
    } else {
      var cur = opts.filter(function (o) { return o.classList.contains("is-on"); })[0] || opts[0];
      if (cur) cur.focus();
    }
  }
  // cfg: { chips: [chip as above], onPick(key, [values]), onClear(), showN, showM, picked, live (false: picks go on when the list closes) }
  function flLine(cfg) {
    var line = rmkEl("div", "rv-cal-fline"); line.setAttribute("role", "group"); line.setAttribute("aria-label", "Filter");
    line.appendChild(rmkEl("span", "rv-cal-flbl", "Filter"));
    cfg.chips.forEach(function (c) { line.appendChild(flChip(c, cfg.onPick, cfg.live)); });
    line.appendChild(rmkEl("span", "rv-cal-fgrow"));
    var cnt = rmkEl("span", "rv-cal-fcount", "Showing " + cfg.showN + " of " + cfg.showM);
    cnt.setAttribute("role", "status");
    line.appendChild(cnt);
    if (cfg.picked) {
      var clr = rmkEl("button", "rv-cal-fclear", "Clear"); clr.type = "button";
      clr.setAttribute("aria-label", "Clear every filter");
      clr.addEventListener("click", function () { flClose(false, true); cfg.onClear(); });
      line.appendChild(clr);
    }
    // never clipped, never two lines: when the chips do not fit the room the line has (the Talent Box's is narrower than the
    // BU CEO's), the unpicked ones say just their name; and if that is still too wide, the chips shrink and a long pick
    // ends in "..." with its full words on hover
    var fit = function () {
      line.classList.remove("is-tight", "is-tighter");
      if (line.scrollWidth <= line.clientWidth + 1) return;
      line.classList.add("is-tight");
      if (line.scrollWidth > line.clientWidth + 1) line.classList.add("is-tighter");
    };
    setTimeout(fit, 0);
    if (window.ResizeObserver) new ResizeObserver(fit).observe(line);
    return line;
  }
  // The server's chip (_journey_talent_box_overview "filters") as the chip above
  function chipFromServer(f) {
    return { key: f.key, label: f.label, chip: f.chip || f.label, bare: !!f.bare, plural: f.plural, proper: !!f.proper,
             values: (f.values || (f.value ? [f.value] : [])).slice(), valueLabels: (f.value_labels || (f.value_label ? [f.value_label] : [])).slice(),
             all: f.all, options: f.options || [], notSet: f.not_set || 0, search: !!f.search, earlier: f.earlier || [] };
  }


  /* ================= WHAT THE BOX IS SHOWING, IN WORDS ================= */
  // the title bar's count line: a cost centre / branch, and any filter with several values ("2 job grades")
  function xWords(d) {
    return (d.filters || []).filter(function (f) { return f.key === "cc" || f.key === "branch" || (f.values || []).length > 1; })
      .map(function (f) {
        var w = pickWords(chipFromServer(f));
        return w ? " \u00b7 " + (w.indexOf("no ") === 0 ? "No " + w.slice(3) : w) : "";
      }).join("");
  }
  // several departments picked: "2 departments" (one is d.dept, in proper words)
  function deptMulti(d) {
    var f = (d.filters || []).filter(function (x) { return x.key === "dept" && (x.values || []).length > 1; })[0];
    return f ? pickWords(chipFromServer(f)) : "";
  }
  function scopeName(d) {
    // a Group Chief's box and the Chairman's name every pick in words, the server's (2026-11-02): "People, Technology, Data (2 business groups)"
    if (d.pick_words && d.pick_words.length) return (d.company_label || "") + " (" + d.pick_words.join(", ") + ")";
    var cl = d.cal && (d.bu_level || []).find(function (x) { return x.key === d.cal; });
    // the roster picks (Cost centre, Branch; 2026-10-30) ride along in words: "Summit Cement (CC-104, Ipoh)", and any
    // filter with several values as its count: "(2 cost centres)"
    var xs = (d.filters || []).filter(function (f) { return f.key === "cc" || f.key === "branch" || (f.key !== "dept" && (f.values || []).length > 1); })
      .map(function (f) { return pickWords(chipFromServer(f)); }).filter(Boolean);
    var tail = xs.length ? " (" + xs.join(", ") + ")" : "";
    var dm = deptMulti(d);
    if (cl) return (cl.key === "ceo" ? "the BU CEO's people" : cl.who + "\u2019s people") + " in "
      + (d.dept ? pn(d.dept) + ", " : dm ? dm + ", " : "") + (d.company_label || "") + tail;
    return (d.dept ? pn(d.dept) + " in " + (d.company_label || "") : dm ? dm + " in " + (d.company_label || "")
      : (d.company_label || "Whole BG")) + tail;
  }

  /* ================= THE CURVE ================= */
  // PHONE (piece C): one band's gap against the expected spread, from the server's own figures (n people now, `gap` = expected - n
  // as the server worked it out). The chip says how many more (+) or fewer (\u2212) people sit there than expected; the title carries the
  // expected share and count and the full words. Shown by the phone section of style.css only.
  function gapWords(d, n, tgt, gap, total) {
    if (!total || d.small) return { chip: DASH, cls: "is-onTarget", title: "Counts only: too few to read a curve" };
    var more = -gap, exp = n + gap;
    var words = more > 0 ? more + " more than expected" : more < 0 ? (-more) + " fewer than expected" : "As expected";
    return { chip: more > 0 ? "+" + more : more < 0 ? "\u2212" + (-more) : "0", cls: more ? "is-off" : "is-onTarget",
             title: "Expected " + tgt + "% (" + exp + ") \u00b7 " + words };
  }
  // the one line under the pinned "Your band" on a phone: "Meet Expectation now 12 \u00b7 expected 14 (\u22122)", what the server's curve says of that band now
  function bandLine(d, b) {
    if (!b || !d.total || d.small) return "";
    var n = (d.distribution || {})[b] || 0, gap = (d.gaps || {})[b] || 0, more = -gap;
    return ((d.label_names || {})[b] || b) + " now " + n + " \u00b7 expected " + (n + gap) + " (" + (more > 0 ? "+" + more : more < 0 ? "\u2212" + (-more) : "0") + ")";
  }
  function calibDistBox(d, opts) {
    var box = document.createElement("div"); box.className = "rv-calib-dist" + (opts && opts.phone ? " is-ph" : "");
    var order = d.band_order || [], labels = d.label_names || {}, total = d.total || 0;
    var h = document.createElement("h4"); h.className = opts && opts.compact ? "rv-sr" : "rv-cal-h4";
    h.textContent = (opts && opts.heading) || ("Calibration curve: " + (d.dept || "your team") + " vs the expected spread" + (d.curve && d.curve.label ? " (" + d.curve.label + ")" : ""));
    box.appendChild(h);
    order.forEach(function (b) {
      var n = (d.distribution || {})[b] || 0, tgt = (d.target || {})[b] || 0, gap = (d.gaps || {})[b] || 0;
      var pct = total ? Math.round(n / total * 100) : 0;
      var row = document.createElement("div"); row.className = "calib-dist-row";
      row.setAttribute("data-key", "b:" + b);
      var lab = document.createElement("span"); lab.className = "calib-dist-band"; lab.textContent = labels[b] || b;
      row.appendChild(lab);
      var bar = document.createElement("div"); bar.className = "calib-dist-bar";
      var fill = document.createElement("span"); fill.className = "calib-dist-fill calib-dist-" + b.toLowerCase();
      fill.style.width = pct + "%"; bar.appendChild(fill);
      var tick = document.createElement("span"); tick.className = "calib-dist-tick";
      tick.style.left = tgt + "%"; tick.title = "Expected: " + tgt + "%"; bar.appendChild(tick);
      if (opts && opts.unit) {   // a department on the curve: where the whole unit sits, faintly (2026-10-13)
        var ut = opts.unit.total || 0, un = (opts.unit.distribution || {})[b] || 0;
        var um = document.createElement("span"); um.className = "calib-dist-unit";
        um.style.left = (ut ? Math.round(un / ut * 100) : 0) + "%";
        um.title = "Whole unit: " + (ut ? Math.round(un / ut * 100) : 0) + "%"; bar.appendChild(um);
      }
      row.appendChild(bar);
      var pctl = document.createElement("span"); pctl.className = "calib-dist-pct";
      pctl.appendChild(document.createTextNode(n + " · " + pct + "% "));
      var tg = document.createElement("span"); tg.className = "rv-cal-soft"; tg.textContent = "(expected " + tgt + "%)";
      pctl.appendChild(tg); row.appendChild(pctl);
      var g = document.createElement("span");
      // byBreach (the admin's cards, canvas board F): amber only for a band outside the tolerance, grey otherwise
      g.className = "calib-dist-gap " + (d.small ? "is-onTarget" : (opts && opts.byBreach) ? ((d.breaches || {})[b] != null ? "is-short" : "is-onTarget")
        : gap > 0 ? "is-short" : gap < 0 ? "is-over" : "is-onTarget");
      g.textContent = (!total || d.small) ? DASH   // a small JG group: counts only (2026-10-21)
        : gap > 0 ? (gap + " fewer than expected") : gap < 0 ? ((-gap) + " more than expected") : "As expected";
      row.appendChild(g);
      if (opts && opts.phone) {   // PHONE (piece C): the gap as a chip on the bar's right, "+1" / "\u22122" / "0"; the server's own gap, only its sign turned and its words shortened
        var gw = gapWords(d, n, tgt, gap, total);
        var gc = document.createElement("span"); gc.className = "rv-ph-gap " + gw.cls; gc.hidden = true;
        gc.textContent = gw.chip; gc.title = gw.title; row.appendChild(gc);
      }
      if (opts && opts.pick) calPickRow(row, b, n, labels[b] || b, opts);
      box.appendChild(row);
    });
    if (opts && opts.pick && opts.picked) {   // what the roster shows now, and the way back
      box.classList.add("has-pick");
      var pk = opts.pickedN || 0;
      box.appendChild(rmkEl("div", "rv-cal-pickhint", "Showing " + (labels[opts.picked] || opts.picked) + " only: " + pk
        + (pk === 1 ? " person" : " people") + ". Click it again to show everyone."));
    }
    if (opts && opts.noVerdict) return box;   // the admin's cards draw the rows alone (canvas board F)
    var off = Object.keys(d.breaches || {});
    var tol = d.tolerance, tolw = tol + " " + (tol === 1 ? "person" : "people");
    var note = document.createElement("div");
    note.className = "rv-calib-verdict " + (off.length ? "is-off" : total ? "is-ok" : "is-empty");
    var who = d.dept ? d.dept + ": " : "";   // already in proper words where they are a name (calFiltered); a code is left alone
    if (d.locked) note.textContent = d._ro ? "Read only: their BU CEO sets these bands." : "Locked.";
    else if (!total) note.textContent = who + "No one is on the curve yet — set their bands below.";
    else if (d.small) {   // too few to read a curve: the counts show, the verdict is the whole unit's (2026-10-21)
      var uo = d.unit_off || [], ut = d.unit_tol, utw = ut + " " + (ut === 1 ? "person" : "people");
      note.className = "rv-calib-verdict " + (uo.length ? "is-off" : "is-ok");
      note.textContent = who + "Too few to read a curve (" + total + (total === 1 ? " person" : " people") + "). Your whole unit: "
        + (uo.length ? "outside the expected spread in " + uo.map(function (b) { return labels[b] || b; }).join(", ")
           + " (by more than " + utw + ")." : "every band is within " + utw + " of the expected spread.");
    }
    else if (!off.length) note.textContent = who + "Every band is within " + tolw + " of the expected spread.";
    else note.textContent = who + "Outside the expected spread in " + off.map(function (b) { return labels[b] || b; }).join(", ")
      + " (by more than " + tolw + ").";
    if (d.dept && !d.locked && !d.small) note.textContent += d.join ? " Your lock covers all the units calibrated together."
      : " Your lock covers the whole unit.";
    if (opts && opts.tools) {
      var vr = rmkEl("div", "rv-cal-vline"); vr.appendChild(note); vr.appendChild(opts.tools); box.appendChild(vr);
    } else box.appendChild(note);
    return box;
  }
  // THE CURVE AS A FILTER (Chris, 2026-10-22: "for BUCEO calibration, can we make the bar and the label UA, BE, ME
  // clickable and acts as filter? similar like HOD filter, click once to select, click again to deselect"): a band's row
  // (its label and its bar) narrows the roster to the people counted in it, one band at a time; the lit row clicked
  // again shows everyone. A band nobody sits in isn't a button. The curve itself never narrows.
  function calPickRow(row, b, n, label, opts) {
    var on = opts.picked === b;
    row.classList.add("is-filter"); row.setAttribute("data-code", b);
    if (on) row.classList.add("is-on");
    if (!n && !on) { row.classList.add("is-empty"); return; }
    row.tabIndex = 0; row.setAttribute("role", "button"); row.setAttribute("aria-pressed", on ? "true" : "false");
    row.title = on ? "Show everyone again" : "Show only " + label + " (" + n + ")";
    var go = function () { opts.pick(on ? "" : b); };
    row.addEventListener("click", go);
    row.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
  }

  /* ================= THE CURVE DIALOG ================= */
  function patWords(pct) {
    if (pct == null) return "PAT not entered";
    var v = Math.abs(pct) >= 10 || pct === Math.round(pct) ? Math.round(pct) : Math.round(pct * 10) / 10;
    return "PAT " + v + "%";
  }
  function modal(cls, title, lead, opener) {
    var overlay = document.createElement("div"); overlay.className = "modal-overlay";
    var card = document.createElement("div"); card.className = "modal-card notranslate " + cls;
    card.setAttribute("translate", "no"); card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true");
    var h = document.createElement("h2"); h.textContent = title; card.appendChild(h);
    card.setAttribute("aria-label", title);
    if (lead) card.appendChild(rmkEl("p", "rv-fit-lead", lead));
    var body = rmkEl("div", "rv-tbox-dlgbody"); card.appendChild(body);
    var acts = document.createElement("div"); acts.className = "modal-actions";
    var shut = document.createElement("button"); shut.type = "button"; shut.className = "primary"; shut.textContent = "Close";
    acts.appendChild(shut); card.appendChild(acts); overlay.appendChild(card);
    var bk = null;   // the phone's back gesture closes the pop-out (static/move_in.js, onehrBackLayer)
    function close() {
      document.removeEventListener("keydown", onKey);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (bk) { var b0 = bk; bk = null; b0.done(); }
      if (opener && document.body.contains(opener)) opener.focus();
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    shut.addEventListener("click", close);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    if (typeof window.onehrBackLayer === "function") bk = window.onehrBackLayer(function () { bk = null; close(); });
    shut.focus();
    return { body: body, close: close };
  }
  // One axis's spread against its expected curve, in a pop-out (read only: moves happen on the box). Back on the axis
  // title (2026-10-07), after the curve buttons came off the title bar.
  function curveDialog(axis, cv, where, opener, hooks) {
    if (document.querySelector(".modal-overlay")) return;
    if (hooks && hooks.before) hooks.before();   // the chat closes its Move pop-up and band trail first
    var c = cv.curve || {}, pat = "entered" in c   // performance only: the PAT that picked this curve
      ? " \u00b7 " + (c.entered && c.pct != null ? patWords(c.pct) : "PAT not entered") : "";
    var m = modal("rv-tbox-curvedlg", axis + " distribution \u2014 " + where,
      cv.total + (cv.total === 1 ? " person" : " people") + " against the expected spread"
      + (c.label ? " (" + c.label + ")" : "") + pat, opener);
    m.body.appendChild(calibDistBox(cv, { compact: true, byBreach: !!(hooks && hooks.byBreach) }));
  }

  window.OneHRCalib = {
    NOTSET: NOTSET, rmkEl: rmkEl, flLine: flLine, flChip: flChip, flOpen: flOpen, flClose: flClose, flIsOpen: flIsOpen, flCountOf: flCountOf,
    flMatchN: flMatchN, pickWords: pickWords, chipFromServer: chipFromServer, calibDistBox: calibDistBox, bandLine: bandLine,
    curveDialog: curveDialog, patWords: patWords, modal: modal, xWords: xWords, deptMulti: deptMulti, scopeName: scopeName
  };
})();
