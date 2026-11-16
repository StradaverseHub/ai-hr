/* The dashboard's right-hand panel (Chris, 2026-10-08: "For the past or completed reports, build a new view that
   slides from the right when clicked, and also add in AI element to the history record"; 2026-10-09: the tools and the
   full record open in it too -- "it will open the right pop out window with the person's career plan with the year
   selection ... for 360, similarly it will show the person's 360 report in the same view with the year selection", "the
   full history record, it should open on the right slide panel the list of historical records"; designed on the canvases
   "OneHR Tools Slide-out Panels" and "OneHR Full Record Panel").

   One panel, seven views, all read-only on the server (the first five self-scoped, the sixth the leader's own people):
     record   one cycle of the history  -- GET /me/record/<cycle> (+ its AI snapshot, POST .../snapshot)
     present  this cycle in detail      -- GET /me/record/current
     list     the full record, by year  -- the page's own rows (#od-records-tpl); a year opens to its cycles
     plan     the Career Plan by year   -- GET /me/plan?year=
     report   the 360 report by cycle   -- GET /me/report360?cycle=
     led      the people a leader is over (2026-10-12, "What you led") -- GET /me/led?cycle=&tab=, a person's movement
              GET /me/led/<id>; a wider panel
   A record opened from the list carries "‹ Full record"; its 360 opens in place with "‹ <cycle>". Escape, the scrim and
   the close bezel down its left edge close it and give focus back to what opened it. Every person-written string is set
   with textContent. The trend line above the history rows is written the same way, once. */
(function () {
  "use strict";
  var drawer = document.querySelector("[data-od-drawer]");
  var scrim = document.querySelector("[data-od-scrim]");
  if (!drawer || !scrim) return;
  var body = drawer.querySelector("[data-od-body]");
  var linksEl = drawer.querySelector("[data-od-links]");
  var sub = drawer.querySelector("[data-od-sub]");
  var title = drawer.querySelector(".od-dr-title");
  var pick = drawer.querySelector("[data-od-pick]");
  var bBack = drawer.querySelector("[data-od-back]");
  var bNewer = drawer.querySelector("[data-od-newer]");
  var bOlder = drawer.querySelector("[data-od-older]");
  var bClose = drawer.querySelector("[data-od-close]");
  var opener = null, current = null, seq = 0, mode = null;
  var back = null;   // where "‹" goes: {kind: "list"} or {kind: "record", key, name, viaList}
  var wantTab = null;   // the tab This cycle in detail opens on (a Where you stand row, a guide card; 2026-10-18)
  var BANDS = { UA: "Unacceptable", BE: "Below Expectation", ME: "Meet Expectation", AE: "Above Expectation",
                OU: "Outstanding" };
  var SPARK = '<svg class="od-spark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.3 6.2 6.2 2.3-6.2 2.3L12 19.5l-2.3-6.2L3.5 11l6.2-2.3z"></path></svg>';

  function token() {
    var m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.getAttribute("content") : "";
  }
  function klName(el_, l, full) { var K = window.onehrKpiLine; if (K) K.name(el_, l, full); else el_.textContent = full || ""; return el_; }
  function klDesc(l, cls) { var K = window.onehrKpiLine; return K ? K.desc(l, cls) : null; }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function pill(band, text) {
    var p = el("span", "potential-pill", text || band);
    p.setAttribute("data-band", band);
    return p;
  }
  function fig(v) {
    if (v == null || v === "") return "";
    var n = Number(v);
    if (isNaN(n)) return String(v);
    return (Math.round(n * 100) / 100).toString();
  }
  function getJSON(url) {
    return fetch(url, { credentials: "same-origin", headers: { "Accept": "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
  }

  // the panel in, once; every view starts from a clean header. Opening again while it is still sliding out cancels
  // the hide (a close then a quick reopen left it hidden).
  var hideT = null;
  function show(from) {
    if (from) opener = from;
    if (hideT) { clearTimeout(hideT); hideT = null; }
    if (drawer.hidden) { drawer.hidden = false; scrim.hidden = false; }
    requestAnimationFrame(function () { drawer.classList.add("is-on"); scrim.classList.add("is-on"); });
    document.body.style.overflow = "hidden";
    setTimeout(function () { drawer.focus(); }, 30);
  }
  function head(t, s) {
    closeMenu();
    drawer.classList.remove("is-wide");   // only the What you led and Who has submitted views are wide
    Array.prototype.forEach.call(drawer.querySelectorAll(".sb-dn"), function (n) { n.remove(); });
    title.textContent = t; sub.textContent = s || "";
    pick.hidden = true; pick.textContent = ""; pick.removeAttribute("aria-label");
    bBack.hidden = true; bBack.onclick = null;
    bNewer.hidden = bOlder.hidden = true;
    body.textContent = ""; linksEl.textContent = "";
    body.scrollTop = 0;
  }
  function backButton(label, go) {
    bBack.textContent = "‹ " + label;
    bBack.hidden = false;
    bBack.onclick = go;
  }
  // The year / cycle picker: one dropdown (Chris, 2026-10-10: "a cycle year dropdown list instead of showing all ...
  // Same for the career plan cycle year selection"), grouped by year when the options carry one. The 360's also steps
  // to the newer / older cycle with the arrows beside it.
  var menuOpen = null;
  var CHEV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>';
  function closeMenu(refocus) {
    if (!menuOpen) return;
    var m = menuOpen; menuOpen = null;
    m.menu.hidden = true; m.btn.setAttribute("aria-expanded", "false");
    if (refocus) m.btn.focus();
  }
  function picker(label, items, stepper) {
    closeMenu();
    pick.textContent = "";
    pick.setAttribute("aria-label", label);
    pick.hidden = !items.length;
    if (!items.length) return;
    pick.appendChild(el("span", "lab", label));
    var at = 0;
    items.forEach(function (it, i) { if (it.on) at = i; });
    var cur = items[at];
    var dd = el("div", "od-dd");
    function step(to, txt, aria) {
      var b = el("button", "od-dd-step", txt);
      b.type = "button"; b.setAttribute("aria-label", aria);
      if (to) b.addEventListener("click", function () { to.go(); }); else b.disabled = true;
      return b;
    }
    if (stepper) dd.appendChild(step(items[at - 1], "‹", "Newer " + label.toLowerCase()));
    var btn = el("button", "od-dd-btn");
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "listbox"); btn.setAttribute("aria-expanded", "false");
    btn.appendChild(el("span", "v", cur.label));
    var tw = el("span", "tw"); tw.appendChild(el("span", "t", cur.tag || "")); tw.insertAdjacentHTML("beforeend", CHEV);
    btn.appendChild(tw);
    var menu = el("div", "od-dd-menu");
    menu.hidden = true; menu.setAttribute("role", "listbox"); menu.setAttribute("aria-label", label);
    var group = null;
    items.forEach(function (it) {
      if (it.group != null && it.group !== group) { group = it.group; menu.appendChild(el("p", "od-dd-g", String(group))); }
      var o = el("button", "od-dd-o" + (it.on ? " is-on" : ""));
      o.type = "button"; o.setAttribute("role", "option"); o.setAttribute("aria-selected", it.on ? "true" : "false");
      o.appendChild(el("span", "v", it.short || it.label));
      o.appendChild(el("span", "t", it.tag || ""));
      o.addEventListener("click", function () { closeMenu(); if (!it.on) it.go(); });
      menu.appendChild(o);
    });
    menu.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      var os = Array.prototype.slice.call(menu.querySelectorAll(".od-dd-o"));
      var i = os.indexOf(document.activeElement);
      var n = os[Math.max(0, Math.min(os.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (n) n.focus();
    });
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (menuOpen) { closeMenu(); return; }
      menu.hidden = false; btn.setAttribute("aria-expanded", "true");
      menuOpen = { menu: menu, btn: btn };
      var on = menu.querySelector(".od-dd-o.is-on") || menu.querySelector(".od-dd-o");
      if (on) { on.focus(); on.scrollIntoView({ block: "nearest" }); }
    });
    var box = el("div", "od-dd-box");
    box.appendChild(btn); box.appendChild(menu);
    dd.appendChild(box);
    if (stepper) dd.appendChild(step(items[at + 1], "›", "Older " + label.toLowerCase()));
    pick.appendChild(dd);
  }
  document.addEventListener("click", function (e) {
    if (menuOpen && !menuOpen.menu.contains(e.target) && !menuOpen.btn.contains(e.target)) closeMenu();
  });

  function open(key, from, viaList) {
    show(from);
    mode = "record";
    back = viaList ? { kind: "list" } : null;
    lastListKey = viaList ? String(key) : null;
    markRow(key);
    load(key);
  }
  function markRow(key) {
    document.querySelectorAll(".od-row.is-open").forEach(function (r) { r.classList.remove("is-open"); });
    var row = document.querySelector('.od-strip .od-row[data-record="' + key + '"]');   // the this-cycle link has no row
    if (row) row.classList.add("is-open");
  }
  function close() {
    drawer.classList.remove("is-on"); scrim.classList.remove("is-on");
    document.body.style.overflow = "";
    document.querySelectorAll(".od-row.is-open").forEach(function (r) { r.classList.remove("is-open"); });
    hideT = setTimeout(function () { hideT = null; drawer.hidden = true; scrim.hidden = true; }, 240);
    if (opener && opener.focus) opener.focus();
    current = null; mode = null; back = null;
  }

  function load(key) {
    var my = ++seq;
    current = key;
    var via = back;
    head("Loading…", "");
    getJSON("/me/record/" + encodeURIComponent(key))
      .then(function (d) { if (my === seq) { back = via; render(d); } })
      .catch(function () {
        if (my !== seq) return;
        title.textContent = "Your record";
        body.appendChild(el("p", "od-err", "This cycle couldn't be opened right now."));
      });
  }

  function snapshotBlock(d) {
    var box = el("section", "od-ai");
    box.setAttribute("aria-label", "AI snapshot");
    var k = el("p", "od-kick");
    k.innerHTML = SPARK; k.appendChild(document.createTextNode("AI read of your result"));
    var t = el("p", "t");
    var f = el("p", "f", "From what was released to you, your 360 and your plan. The bands below are the record.");
    box.appendChild(k); box.appendChild(t); box.appendChild(f);
    function show(text, source) {
      t.classList.remove("is-wait");
      t.textContent = text || "Nothing from this cycle has been released to you yet.";
      if (source !== "ai") {
        box.classList.add("is-plain"); k.classList.add("is-plain");
        k.textContent = "Snapshot from your figures";
      }
    }
    if (d.snapshot && d.snapshot.text) {
      show(d.snapshot.text, d.snapshot.source);
    } else {
      t.classList.add("is-wait");
      t.textContent = "Reading your record…";
      var key = d.key, my = seq;
      var f2 = new FormData(); f2.append("csrf_token", token());
      fetch("/me/record/" + encodeURIComponent(key) + "/snapshot", { method: "POST", body: f2, credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (my !== seq) return;
          if (j && j.ok) show(j.text, j.source);
          else { t.classList.add("is-wait"); t.textContent = (j && j.error) || "The snapshot isn't available right now."; }
        })
        .catch(function () { if (my === seq) t.textContent = "The snapshot isn't available right now."; });
    }
    return box;
  }

  // The record of a cycle: its FINAL bands after calibration and its talent status, each only once released -- never a
  // line manager's score or a KPI table (Chris, 2026-10-08).
  function glance(d) {
    var g = el("div", "od-glance");
    var fin = d.final || {};
    // a past Year-End imported from Group People's records before OneHR: its talent status (2026-10-14), and Group People's two bands
    // where the record has them (2026-10-22)
    var imp = !!(d.talent && d.talent.imported);
    var noBand = "No band was recorded that year";
    var hrNote = "From Group People's records before OneHR";
    var p = el("div", "od-g"); p.appendChild(el("p", "k", "Performance"));
    var pv = el("p", "v");
    if (fin.pm) pv.appendChild(pill(fin.pm.band)); else pv.appendChild(el("span", "od-dash", imp ? "—" : "Not released"));
    var after = d.mid_year ? "the HOD's review" : "calibration";   // Mid-Year has no calibration (2026-10-12)
    p.appendChild(pv); p.appendChild(el("p", "n", fin.pm ? fin.pm.name + (imp ? " · from Group People's records before OneHR" : " · final after " + after)
      : imp ? noBand : "Final band after " + after));
    g.appendChild(p);
    var q = el("div", "od-g"); q.appendChild(el("p", "k", "Potential"));
    var qv = el("p", "v");
    // a cycle with no potential result: none is coming, so never "Not released" (2026-10-14)
    var noPot = !!d.no_pot;
    if (fin.pot) qv.appendChild(pill(fin.pot)); else qv.appendChild(el("span", "od-dash", (imp || noPot) ? "—" : "Not released"));
    q.appendChild(qv); q.appendChild(el("p", "n", fin.pot ? fin.pot + " potential · " + (imp ? "from Group People's records before OneHR" : "final after " + after) : imp ? noBand
      : noPot ? "No potential band this cycle: it ran no competency" : "Final band after " + after));
    g.appendChild(q);
    var s = el("div", "od-g"); s.appendChild(el("p", "k", "Talent status"));
    var sv = el("p", "v");
    if (imp && !(d.talent.perf && d.talent.pot)) {   // status only: nothing to place on the grid
      sv.appendChild(talPill(d.talent));
      s.appendChild(sv); s.appendChild(el("p", "n", hrNote));
      g.appendChild(s);
      return g;
    }
    if (d.talent) {
      var tg = el("span", "dash-tgrid od-tg"); tg.setAttribute("aria-hidden", "true");
      ["High", "Mid", "Low"].forEach(function (row) {
        ["UA", "BE", "ME", "AE", "OU"].forEach(function (col) {
          tg.appendChild(el("i", (d.talent.perf === col && d.talent.pot === row) ? ("you tbox-cat-" + d.talent.slug) : ""));
        });
      });
      sv.appendChild(tg); sv.appendChild(document.createTextNode(d.talent.name));
    } else sv.appendChild(el("span", "od-dash", noPot ? "—" : "Not released"));
    s.appendChild(sv);
    if (imp) s.appendChild(el("p", "n", hrNote));
    if (!d.talent && noPot) s.appendChild(el("p", "n", "No talent status: no potential band this cycle"));
    g.appendChild(s);
    return g;
  }

  // THIS cycle, up to the line manager's level (2026-10-08): their KPI lines with the manager's figure once locked,
  // the overall the manager approved and their remarks; their competency with the manager's calls once reviewed.
  // The KPI table, as a node: one half's lines (Year-End's, or a transferred person's Mid-Year).
  function kpiTable(lines) {
    var t = el("table", "od-kt");
    var hd = el("tr");
    ["KPI", "Weight", "You entered", "Approved", "Rating"].forEach(function (h, i) { hd.appendChild(el("th", i >= 2 ? "r" : null, h)); });
    var th_ = el("thead"); th_.appendChild(hd); t.appendChild(th_);
    var tb = el("tbody");
    lines.forEach(function (ln) {
      var tr = el("tr");
      // the KPI, its Focus tag and the person's description (static/kpi_line.js; board 22)
      var nc = el("td"); nc.appendChild(klName(el("div", "od-kn"), ln, ln.name));
      var nd = klDesc(ln, "od-kd"); if (nd) nc.appendChild(nd);
      tr.appendChild(nc);
      tr.appendChild(el("td", null, fig(ln.weightage) + "%"));
      tr.appendChild(el("td", "r", ln.self != null ? fig(ln.self) + (ln.unit ? " " + ln.unit : "") : "—"));
      tr.appendChild(el("td", "r", ln.moderated != null ? fig(ln.moderated) + (ln.unit ? " " + ln.unit : "") : (ln.locked ? "—" : "Waiting")));
      var rr = el("td", "r");
      if (ln.label && ln.locked) rr.appendChild(pill(ln.label)); else rr.appendChild(el("span", "od-dash", "—"));
      tr.appendChild(rr);
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    return t;
  }
  function kpis(d) {
    var pf = d.perf || {};
    var lines = pf.lines || [];
    if (!lines.length) return null;
    var sec = el("section", "od-sec");
    sec.appendChild(el("h3", null, "Your KPIs"));
    var ov = pf.overall, sm = pf.split_mid;
    var head = el("p", "od-line");
    var fmtOv = function (o) { return o.value == null ? "" : o.mechanism === "A" ? Number(o.value).toFixed(1) + " / 5 " : fig(o.value) + "% "; };
    var blendNote = null;
    if (ov && ov.split && sm) {   // a transferred person (2026-11-03): this line is the Year-End half; the result below it counts both
      head.appendChild(document.createTextNode("Year-End KPIs, approved by your line manager: " + (ov.split.ye_text || "") + (ov.mechanism === "A" && !ov.split.mixed ? " / 5" : "")));
      blendNote = el("p", "od-line", "Your result counts your Mid-Year: " + ov.split.text + " ");
      blendNote.appendChild(pill(ov.label, ov.label_name));
    } else if (ov) {
      head.appendChild(document.createTextNode("Approved by your line manager: " + fmtOv(ov)));
      head.appendChild(pill(ov.label, ov.label_name));
    } else {
      head.textContent = "Your line manager hasn't approved every line yet.";
      if (sm) blendNote = el("p", "od-by", "Your result will count Mid-Year " + sm.weight_mid + "% + Year-End " + sm.weight_ye + "%");
    }
    if (!sm || !sm.summary) {   // not transferred, or their result is out (no Mid-Year view then): as it always was
      sec.appendChild(head); if (blendNote) sec.appendChild(blendNote); sec.appendChild(kpiTable(lines));
    } else {
      // THE TOGGLE (2026-11-03): Year-End (first) | Mid-Year, the Mid-Year half read only with its own figures; shown until the result is released
      var ye = el("div", "od-half-ye"); ye.appendChild(head); if (blendNote) ye.appendChild(blendNote); ye.appendChild(kpiTable(lines));
      var mid = el("div", "od-half-mid"); mid.hidden = true;
      mid.appendChild(el("p", "od-by", sm.title));
      var mo = sm.summary.overall, mh = el("p", "od-line");
      if (mo) {
        mh.appendChild(document.createTextNode("Approved by your line manager: " +
          (mo.value == null ? "" : mo.mechanism === "A" ? Number(mo.value).toFixed(1) + " / 5 " : fig(mo.value) + "% ")));
        mh.appendChild(pill(mo.label, mo.label_name));
      } else mh.textContent = "No overall for " + sm.cycle + ".";
      mid.appendChild(mh); mid.appendChild(kpiTable(sm.summary.lines || []));
      if (sm.final && sm.final.band) { var fb = el("p", "od-line", "Final band: "); fb.appendChild(pill(sm.final.band)); mid.appendChild(fb); }
      var seg = el("div", "acct-seg od-half-seg"); seg.setAttribute("role", "radiogroup"); seg.setAttribute("aria-label", "Which half of the year to show");
      var btns = {};
      [["ye", "Year-End"], ["mid", "Mid-Year"]].forEach(function (h) {
        var b = el("button", "acct-seg-b" + (h[0] === "ye" ? " on" : ""), h[1]); b.type = "button";
        b.setAttribute("role", "radio"); b.setAttribute("aria-checked", h[0] === "ye" ? "true" : "false");
        b.addEventListener("click", function () {
          Object.keys(btns).forEach(function (k) { btns[k].classList.toggle("on", k === h[0]); btns[k].setAttribute("aria-checked", k === h[0] ? "true" : "false"); });
          ye.hidden = h[0] !== "ye"; mid.hidden = h[0] !== "mid";
        });
        btns[h[0]] = b; seg.appendChild(b);
      });
      sec.appendChild(seg); sec.appendChild(ye); sec.appendChild(mid);
    }
    (pf.lm_remarks || []).forEach(function (m) {
      sec.appendChild(el("p", "od-by", m.author + " wrote"));
      sec.appendChild(el("p", "od-quote", m.remark));
    });
    if (pf.own_remark) { sec.appendChild(el("p", "od-by", "Your overall remark")); sec.appendChild(el("p", "od-quote", pf.own_remark)); }
    return sec;
  }

  function competency(d) {
    var c = d.competency;
    if (!c) return null;
    var sec = el("section", "od-sec");
    sec.appendChild(el("h3", null, "Your competencies"));
    var answered = 0;
    c.items.forEach(function (it) { it.you.forEach(function (a) { if (a === "yes" || a === "no") answered++; }); });
    sec.appendChild(el("p", "od-line", c.reviewed ? ("Reviewed by your line manager: " + c.lm_yes + " of " + c.total + " demonstrated")
      : (c.final ? "Submitted — nobody reviews it, so your own answers count"
        : c.status === "submitted" ? "Submitted — your line manager reviews it next"
        : "Not submitted yet · " + answered + " of " + c.total + " answered")));
    var ul = el("ul", "od-comp");
    c.items.forEach(function (it) {
      var li = el("li");
      li.appendChild(el("span", "nm", it.title));
      var calls = el("span", "cl");
      if (!c.reviewed && !it.you.some(function (a) { return a === "yes" || a === "no"; })) {
        calls.appendChild(el("span", "od-dash", "Not answered"));
        li.appendChild(calls); ul.appendChild(li); return;
      }
      it.you.forEach(function (a, i) {
        var mine = a === "yes" ? "Demonstrate" : (a === "no" ? "Developing" : "—");
        var lm = c.reviewed ? it.lm[i] : null;
        var tag = el("span", "od-call" + (lm ? (lm === "yes" ? " is-yes" : " is-no") : (a === "yes" ? " is-yes" : a === "no" ? " is-no" : "")),
          lm ? ("Your manager: " + (lm === "yes" ? "Demonstrate" : "Developing")) : ("You: " + mine));
        if (lm) tag.title = "You: " + mine;
        calls.appendChild(tag);
      });
      li.appendChild(calls);
      ul.appendChild(li);
    });
    sec.appendChild(ul);
    if (c.lm_remark) { sec.appendChild(el("p", "od-by", "Your line manager wrote")); sec.appendChild(el("p", "od-quote", c.lm_remark)); }
    if (c.own_remark) { sec.appendChild(el("p", "od-by", "Your overall remark")); sec.appendChild(el("p", "od-quote", c.own_remark)); }
    return sec;
  }

  // The line manager's review of their competencies once released, in words only (Chris, 2026-10-18): strongest =
  // already showing the next level; to grow = still developing at their level. Titles only, never a score or count.
  function calls(d) {
    var cc = d.comp_calls;
    if (!cc) return null;
    var g = el("div", "od-calls");
    [["Where you're strongest", "Your line manager's review: you already show the next level", cc.strong],
     ["Where to grow next", "Your line manager's review: still developing at your level", cc.grow]].forEach(function (c) {
      g.appendChild(el("h3", null, c[0]));
    });
    [cc.strong, cc.grow].forEach(function (x, i) {
      g.appendChild(el("p", "od-calls-s", i ? "Your line manager's review: still developing at your level"
                                           : "Your line manager's review: you already show the next level"));
    });
    [cc.strong, cc.grow].forEach(function (x) {
      var ul = el("ul", "od-calls-l");
      if (!(x || []).length) ul.appendChild(el("li", "is-none", "None this time"));
      (x || []).forEach(function (t) { ul.appendChild(el("li", null, t)); });
      g.appendChild(ul);
    });
    return g;
  }

  // While the cycle hasn't opened (2026-10-18, canvas boards 2-3): each KPI with its targets, by the group's scale --
  // the figure for each rating 1-5, or threshold / target / excellence (a cap multiple where the group caps).
  function kpiTargets(d) {
    var pf = d.perf || {}, lines = pf.lines || [];
    if (!lines.length) return null;
    var sc = pf.scale || {}, mech = sc.mechanism || (lines[0] && lines[0].mech) || "A", cap = sc.variant === "base";
    var sec = el("section", "od-sec");
    var hd = el("div", "od-sechd"); hd.appendChild(el("h3", null, "Your KPIs"));
    var w = 0; lines.forEach(function (ln) { w += Number(ln.weightage) || 0; });
    hd.appendChild(el("span", "od-muted", lines.length + (lines.length === 1 ? " line · " : " lines · ") + fig(w) + "% weight · " +
      (mech === "B" ? "threshold, target, " + (cap ? "cap" : "excellence") : "rated 1 to 5")));
    sec.appendChild(hd);
    sec.appendChild(el("p", "od-line", mech === "B"
      ? "Each line is scored on how far you get from its threshold to its target and beyond. Your results go in when the Performance check-in opens."
      : "Each line shows the figure for each rating. Rating 3 is the target. Your results go in when the Performance check-in opens."));
    var cols = mech === "B" ? ["Threshold", "Target", cap ? "Cap" : "Excellence"] : ["1", "2", "3", "4", "5"];
    var tgt = mech === "B" ? 1 : 2;
    var t = el("table", "od-kt od-kt-tg");
    var hr = el("tr");
    ["KPI", "Weight", "Better when"].concat(cols).forEach(function (h, i) {
      hr.appendChild(el("th", (i === 0 || i === 2 ? "" : "r") + (i - 3 === tgt ? " is-tgt" : ""), h));
    });
    var th_ = el("thead"); th_.appendChild(hr); t.appendChild(th_);
    var tb = el("tbody");
    function cell(v) { return (v === null || v === undefined || v === "") ? "—" : fig(v); }
    lines.forEach(function (ln) {
      var tr = el("tr");
      var nm = el("td"); nm.appendChild(klName(el("div", "od-kt-n"), ln, ln.name));
      var meta = [ln.unit, ln.category].filter(function (x) { return x; }).join(" · ");
      if (meta) nm.appendChild(el("div", "od-kt-m", meta));
      var kd = klDesc(ln, "od-kd"); if (kd) nm.appendChild(kd);
      tr.appendChild(nm);
      tr.appendChild(el("td", "r", fig(ln.weightage) + "%"));
      tr.appendChild(el("td", null, ln.method === "less" ? "Lower" : "Higher"));
      var vals = mech === "B" ? [ln.threshold, ln.target, cap ? (ln.multiple ? "×" + fig(ln.multiple) : null) : ln.excellence]
                              : (ln.rates || []);
      for (var i = 0; i < cols.length; i++) {
        var v = vals[i];
        tr.appendChild(el("td", "r" + (i === tgt ? " is-tgt" : ""), typeof v === "string" ? v : cell(v)));
      }
      tb.appendChild(tr);
    });
    t.appendChild(tb); sec.appendChild(t);
    var bands = sc.bands || [];
    if (mech === "B" && bands.length) {
      var box = el("div", "od-bands");
      box.appendChild(el("p", "od-bands-h", "How your achievement becomes a rating (your group's scale)"));
      var gr = el("div", "od-bands-g");
      bands.forEach(function (b, i) {
        var nx = bands[i + 1];
        var txt = i === 0 && nx ? "below " + fig(nx.min) + "%" : nx ? fig(b.min) + " – " + fig(nx.min - 1) + "%" : fig(b.min) + "% and up";
        var c = el("div", "od-band"); c.appendChild(el("b", null, b.label)); c.appendChild(el("span", null, txt)); gr.appendChild(c);
      });
      box.appendChild(gr); sec.appendChild(box);
    }
    return sec;
  }

  // While the cycle hasn't opened (2026-10-18, canvas board 4): the 5 competencies for their job, each folding open to
  // what the level they're expected at means and the next level up -- the description, then the abilities that show it
  // (as the evaluation card has them). The first opens; the rest fold.
  function compLevels(d) {
    var c = d.competency;
    if (!c || !c.items.length) return null;
    var sec = el("section", "od-sec");
    var hd = el("div", "od-sechd"); hd.appendChild(el("h3", null, "Your competencies"));
    if (d.job && d.job.title) hd.appendChild(el("span", "od-muted", d.job.title + (d.job.grade ? " · JG " + d.job.grade : "")));
    sec.appendChild(hd);
    function lv(it, fut) { return (it.levels || []).filter(function (x) { return !!x.future === fut; })[0]; }
    var n0 = lv(c.items[0], false), x0 = lv(c.items[0], true);
    sec.appendChild(el("p", "od-line", "The " + c.items.length + " that matter most in your job, each with what your grade expects now" +
      (n0 ? " (Level " + n0.level + ")" : "") + (x0 ? " and your next step (Level " + x0.level + ")" : "") +
      ": the description, then the abilities that show it. Open one to read it. You assess yourself on them when the competency part opens, and your line manager reviews it."));
    c.items.forEach(function (it, i) {
      var now = lv(it, false), nxt = lv(it, true);
      var box = el("div", "od-cl");
      var h = el("button", "od-cl-h"); h.type = "button";
      h.appendChild(el("span", "t", it.title));
      h.appendChild(el("span", "l", now ? ("Level " + now.level + (nxt ? " → " + nxt.level : "")) : ""));
      var act = el("span", "a", i === 0 ? "Hide" : "Show"); h.appendChild(act);
      h.setAttribute("aria-expanded", i === 0 ? "true" : "false");
      var b = el("div", "od-cl-b"); b.hidden = i !== 0;
      [[now, "Now"], [nxt, "Next"]].forEach(function (p) {
        if (!p[0]) return;
        var cellEl = el("div", "od-cl-c");
        cellEl.appendChild(el("p", "k", p[1] + " · Level " + p[0].level));
        if (p[0].desc) cellEl.appendChild(el("p", "d", p[0].desc));
        if ((p[0].abilities || []).length) {
          // three abilities, the rest behind "+N more" (Chris, 2026-10-27)
          var ul = el("ul"); p[0].abilities.forEach(function (a, ai) { var li = el("li", null, a); li.hidden = ai >= 3; ul.appendChild(li); });
          cellEl.appendChild(ul);
          var extra = p[0].abilities.length - 3;
          if (extra > 0) {
            var more = el("button", "rv-tc-more", "+" + extra + " more"); more.type = "button"; more.setAttribute("aria-expanded", "false");
            more.addEventListener("click", function () {
              var open_ = more.getAttribute("aria-expanded") !== "true";
              Array.prototype.forEach.call(ul.children, function (li, ai) { li.hidden = !open_ && ai >= 3; });
              more.setAttribute("aria-expanded", open_ ? "true" : "false");
              more.textContent = open_ ? "Show less" : "+" + extra + " more";
            });
            cellEl.appendChild(more);
          }
        }
        b.appendChild(cellEl);
      });
      if (now && !nxt) b.appendChild(el("p", "od-cl-top", "Level " + now.level + " is the top of the scale: no level above it."));
      h.addEventListener("click", function () {
        var open_ = b.hidden; b.hidden = !open_; h.setAttribute("aria-expanded", open_ ? "true" : "false");
        act.textContent = open_ ? "Hide" : "Show";
      });
      box.appendChild(h); box.appendChild(b); sec.appendChild(box);
    });
    return sec;
  }

  function report(d) {
    var rp = d.report;
    if (!rp) return null;
    var sec = el("section", "od-sec");
    sec.appendChild(el("h3", null, "Your 360"));
    var c = el("div", "od-pchips");
    (rp.strong || []).forEach(function (x) { var p = el("span", "od-pchip", "Strongest: " + x.name); p.title = x.words; c.appendChild(p); });
    (rp.grow || []).forEach(function (x) { var p = el("span", "od-pchip is-grow", "To grow: " + x.name); p.title = x.words; c.appendChild(p); });
    if (rp.even) c.appendChild(el("span", "od-pchip", "Your colleagues saw every principle about the same"));
    if (!(rp.strong || []).length && !(rp.grow || []).length && !rp.even)
      c.appendChild(el("span", "od-pchip", "Released — open the report for the detail"));
    sec.appendChild(c);
    return sec;
  }

  // The development plan in full, with the line manager's remark (2026-10-08: "User gets to see their full IDP
  // history in details and their LM remarks on it").
  function plan(d) {
    var pl = d.plan;
    if (!pl || !pl.goals || !pl.goals.length) return null;
    var sec = el("section", "od-sec");
    sec.appendChild(el("h3", null, "Your " + pl.year + " development plan · " + pl.status_label));
    pl.goals.forEach(function (g) {
      var box = el("div", "od-goal");
      var top = el("p", "od-goal-h", g.area);
      if (g.progress) top.appendChild(el("span", "od-goal-st", g.progress));
      box.appendChild(top);
      if (g.target_date) box.appendChild(el("p", "od-goal-m", "By " + g.target_date));
      (g.actions || []).forEach(function (a) {
        var ln = el("p", "od-goal-a");
        ln.appendChild(el("b", null, a.label + " (" + a.pct + "%): "));
        ln.appendChild(document.createTextNode(a.text));
        box.appendChild(ln);
      });
      if (g.progress_note) box.appendChild(el("p", "od-goal-m", g.progress_note));
      if (g.lm_comment) { box.appendChild(el("p", "od-by", "Your line manager")); box.appendChild(el("p", "od-quote", g.lm_comment)); }
      sec.appendChild(box);
    });
    if (pl.lm_remark) { sec.appendChild(el("p", "od-by", "Your line manager's remark on the plan")); sec.appendChild(el("p", "od-quote", pl.lm_remark)); }
    else if (pl.lm_pending) sec.appendChild(el("p", "od-goal-m", "Your line manager's remark shows here once your plan is approved."));
    return sec;
  }

  function render(d) {
    var via = back;
    head(d.mode === "present" ? (d.name + " — this cycle") : d.name, "");
    if (via && via.kind === "list") backButton("Full record", function () { showList(); });
    var nav = d.mode !== "present";
    bNewer.hidden = bOlder.hidden = !nav;
    if (d.mode === "present") sub.textContent = d.awaiting ? "Not open yet · you can look through it; there's nothing to fill in until Group People opens it"
      : "Up to your line manager's review · calibrated results reach your history once released";
    else sub.textContent = (d.current ? "This cycle · released to you" : (d.closed_on ? "Closed " + d.closed_on : "Closed")) +
      " · cycle " + d.position + " of " + d.count + " in your record";
    bNewer.disabled = !d.newer; bOlder.disabled = !d.older;
    var viaList = !!(via && via.kind === "list");
    bNewer.onclick = d.newer ? function () { open(d.newer, null, viaList); } : null;
    bOlder.onclick = d.older ? function () { open(d.older, null, viaList); } : null;
    if (d.mode === "present") {
      renderPresent(d, viaList);
      return;   // the 360 and the plan open from their own tabs
    } else {
      // a released cycle is off-cycle (Chris, 2026-10-18): the AI read, the final bands and talent status, the line
      // manager's strongest / to grow and the 360 in words -- never the KPI lines or a band along the way; the plan
      // stays in its own Career Plan card
      body.appendChild(snapshotBlock(d));
      body.appendChild(glance(d));
      [calls(d), report(d)].forEach(function (s) { if (s) body.appendChild(s); });
      body.appendChild(el("p", "od-offnote", "Once results are released, your KPI lines, the ratings along the way and any scores are no longer shown."));
    }
    var links = d.links || {};
    // the 360 opens in this panel, on this cycle -- never the classic report page (2026-10-09)
    var rc = links.report_cycle || (d.report && d.report.cycle);
    if (rc) {
      var a = el("button", "od-lk", "Open the 360 report ›");
      a.type = "button";
      a.addEventListener("click", function () {
        loadReport(rc, { kind: "record", key: d.mode === "present" ? "current" : d.key, name: d.mode === "present" ? "This cycle" : d.name,
                         viaList: viaList });
      });
      linksEl.appendChild(a);
    }
    if (links.conversation) { var b = el("a", "od-lk", "Read the review conversation"); b.href = links.conversation; linksEl.appendChild(b); }
  }

  // ---- This cycle in detail: the AI read first, then Summary · KPI · 360 · Competency · Career Plan (Chris, 2026-10-11:
  // "should also show the 360 of present cycle, and career plan of current cycle, serves with AI summary first, then the
  // toggle to switch between summary, KPI, 360, Competency, and Career Plan"; the canvas's row C) ----
  function presentSnapshot(d) {
    var box = el("section", "od-ai");
    box.setAttribute("aria-label", "AI read of this cycle so far");
    var k = el("p", "od-kick");
    k.innerHTML = SPARK; k.appendChild(document.createTextNode("AI read of this cycle so far"));
    var t = el("p", "t");
    var f = el("p", "f", "From what you can see in this cycle only · never a calibrated band");
    box.appendChild(k); box.appendChild(t); box.appendChild(f);
    function show(text, source) {
      t.classList.remove("is-wait");
      t.textContent = text || "Nothing in this cycle yet.";
      if (source !== "ai") { box.classList.add("is-plain"); k.classList.add("is-plain"); k.textContent = "This cycle from your figures"; }
    }
    if (d.snapshot && d.snapshot.text) show(d.snapshot.text, d.snapshot.source);
    else {
      t.classList.add("is-wait"); t.textContent = "Reading your cycle…";
      var my = seq, f2 = new FormData(); f2.append("csrf_token", token());
      fetch("/me/record/current/snapshot", { method: "POST", body: f2, credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (j) { if (my !== seq) return; if (j && j.ok) show(j.text, j.source); else t.textContent = (j && j.error) || "The summary isn't available right now."; })
        .catch(function () { if (my === seq) t.textContent = "The summary isn't available right now."; });
    }
    return box;
  }
  function presentTiles(d, pick) {
    var g = el("div", "od-ptiles");
    function tile(tab, k, big, line, tone) {
      var b = el("button", "od-ptile" + (tone ? " is-" + tone : ""));
      b.type = "button";
      b.appendChild(el("span", "k", k)); b.appendChild(el("b", null, big)); b.appendChild(el("span", "l", line));
      b.appendChild(el("span", "go", "Open the " + k + " tab ›"));
      b.addEventListener("click", function () { pick(tab); });
      g.appendChild(b);
    }
    var pf = d.perf || {}, lines = pf.lines || [];
    if (d.awaiting) {   // 2026-10-18: what is set for them, nothing to do
      var cn = (d.competency && d.competency.items) || [];
      tile("kpi", "KPI", lines.length ? lines.length + " set" : "None set yet", lines.length ? "Targets set by Group People · nothing to do yet" : "Group People sets them before it opens", "");
      tile("f360", "360", "Not open yet", "It opens when Group People opens it", "wait");
      tile("comp", "Competency", cn.length ? cn.length + " for your job" : "None yet", cn.length ? "Now and next level, with what each means" : "Set before it opens", "");
      tile("plan", "Career Plan", "Not open yet", "It opens when Group People opens it", "none");
      return g;
    }
    var ok = lines.filter(function (ln) { return ln.locked; }).length;
    tile("kpi", "KPI", lines.length ? ok + " of " + lines.length + " approved" : "No KPI lines yet",
         pf.overall ? "Overall so far: " + (pf.overall.label_name || pf.overall.label) + " (your line manager's)"
                    : (lines.length ? "With your line manager" : "They show here once set"), lines.length && ok === lines.length ? "ok" : "");
    var rp = d.report;
    tile("f360", "360", rp ? "Released" : "Not released yet",
         rp ? ((rp.strong || [])[0] ? "Strongest: " + rp.strong[0].name : "Open it for the detail") : "Group People releases it after calibration", rp ? "ok" : "wait");
    var c = d.competency;
    if (c) {
      var answered = 0; c.items.forEach(function (it) { it.you.forEach(function (a) { if (a === "yes" || a === "no") answered++; }); });
      tile("comp", "Competency", c.reviewed ? c.lm_yes + " of " + c.total + " demonstrated" : (c.status === "submitted" ? "Submitted" : "Not submitted yet"),
           c.reviewed ? "Reviewed by your line manager" : (c.final ? "Final, nobody reviews it" : c.status === "submitted" ? "With your line manager" : answered + " of " + c.total + " answered"),
           c.reviewed || c.final ? "ok" : "");
    } else tile("comp", "Competency", "None this cycle", "No competencies to assess", "none");
    var pl = d.plan;
    tile("plan", "Career Plan", pl ? pl.year + " plan · " + pl.status_label : (d.plan_year ? d.plan_year + " plan" : "Your plan"),
         pl ? (pl.goals || []).length + " goal" + ((pl.goals || []).length === 1 ? "" : "s") : "Not started yet", pl ? "" : "none");
    return g;
  }
  function presentEmpty(text, btnLabel, onClick) {
    var sec = el("section", "od-sec");
    sec.appendChild(el("p", "od-empty", text));
    if (btnLabel) { var b = el("button", "od-lk", btnLabel); b.type = "button"; b.addEventListener("click", onClick); sec.appendChild(b); }
    return sec;
  }
  function renderPresent(d, viaList) {
    var back = { kind: "record", key: "current", name: "This cycle", viaList: viaList };
    var TABS = [["summary", "Summary"], ["kpi", "KPI"], ["f360", "360"], ["comp", "Competency"], ["plan", "Career Plan"]];
    var bar = el("div", "od-tabs");
    bar.setAttribute("role", "tablist"); bar.setAttribute("aria-label", "This cycle");
    var btns = {}, panes = {};
    function pick(key) {
      TABS.forEach(function (t) {
        var on = t[0] === key;
        btns[t[0]].setAttribute("aria-selected", on ? "true" : "false");
        btns[t[0]].tabIndex = on ? 0 : -1;
        panes[t[0]].hidden = !on;
      });
      body.scrollTop = 0;
    }
    var shut = d.awaiting ? { f360: 1, plan: 1 } : {};   // parts with nothing to show until they open (2026-10-18)
    TABS.forEach(function (t, i) {
      var b = el("button", "od-tab" + (shut[t[0]] ? " is-shut" : ""), t[1]);
      b.type = "button"; b.id = "od-tab-" + t[0];
      if (shut[t[0]]) b.title = "Not open yet";
      b.setAttribute("role", "tab"); b.setAttribute("aria-controls", "od-pane-" + t[0]);
      b.addEventListener("click", function () { pick(t[0]); });
      b.addEventListener("keydown", function (e) {   // arrow keys move along the tabs
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        var j = (i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
        pick(TABS[j][0]); btns[TABS[j][0]].focus();
      });
      btns[t[0]] = b; bar.appendChild(b);
    });
    body.appendChild(bar);
    function pane(key, nodes) {
      var p = el("div", "od-pane");
      p.id = "od-pane-" + key; p.setAttribute("role", "tabpanel"); p.setAttribute("aria-labelledby", "od-tab-" + key);
      nodes.forEach(function (n) { if (n) p.appendChild(n); });
      panes[key] = p; body.appendChild(p);
    }
    if (d.awaiting) {   // started, nothing open: no AI read yet (nothing has happened), the targets and the competencies
      pane("summary", [presentTiles(d, pick)]);
      pane("kpi", [kpiTargets(d) || presentEmpty("No KPI lines in this cycle yet. Group People sets them before the Performance check-in opens.")]);
      pane("f360", [presentEmpty("Your " + d.name + " 360 isn't open yet. It opens when Group People opens it.")]);
      pane("comp", [compLevels(d) || presentEmpty("No competencies for this cycle yet.")]);
      pane("plan", [presentEmpty("Your Career Plan for this cycle isn't open yet. It opens when Group People opens it.")]);
      pick(wantTab && panes[wantTab] ? wantTab : "summary"); wantTab = null;
      return;
    }
    pane("summary", [presentSnapshot(d), presentTiles(d, pick)]);
    pane("kpi", [kpis(d) || presentEmpty("No KPI lines in this cycle yet. They show here once you set them in your AI check-in.")]);
    var rp = report(d);
    if (rp) {
      var ob = el("button", "od-lk", "Open the 360 report ›"); ob.type = "button";
      ob.addEventListener("click", function () { loadReport(d.report.cycle, back); });
      rp.appendChild(ob);
    }
    pane("f360", [rp || presentEmpty("Your " + d.name + " 360 isn't released yet. Group People releases it after calibration, and it shows here in words: " +
                                     "what colleagues see as your strengths and where they'd like to see you grow. Never a score, a count or who said what.",
                                     d.report_last ? "Open your " + d.report_last.name + " 360 ›" : null,
                                     function () { loadReport(d.report_last.cycle, back); })]);
    pane("comp", [competency(d) || presentEmpty("No competencies to assess in this cycle.")]);
    // the plan as it stands, read here only: no way into the plan's own panel or its check-ins from a cycle's record
    // (Chris, 2026-10-12: check-ins are "done only during the off cycle", through the Career Plan card)
    var pl = plan(d);
    var py = (d.plan && d.plan.year) || d.plan_year;
    pane("plan", [pl || presentEmpty("Your " + (py || "") + " plan isn't started yet. You write it in your AI check-in.")]);
    pick(wantTab && panes[wantTab] ? wantTab : "summary"); wantTab = null;
  }

  // ---- the full record, by YEAR (2026-10-14, board A of "OneHR Full Record by Year"): each year shows its Year-End
  // result, which decides the reward; opening it shows the Year-End ("Final") and the Mid-Year ("Checkpoint"), each
  // opening its record. The years left open, and the cycle last opened from here, are kept for the way back. ----
  var openYears = {}, lastListKey = null;
  function setYear(g, on) {
    var b = g.querySelector(".od-yr"), c = g.querySelector(".od-yc");
    if (!b || !c) return;
    b.setAttribute("aria-expanded", on ? "true" : "false");
    c.hidden = !on;
    g.classList.toggle("is-open", on);
    openYears[g.getAttribute("data-year")] = on;
  }
  function showList(year) {   // year: open the full record at that year (the history card's year rows)
    ++seq; mode = "list"; current = null; back = null;
    markRow(null);
    head("Your full record", "");
    var tpl = document.getElementById("od-records-tpl");
    var frag = tpl ? tpl.content.cloneNode(true) : null;
    var n = frag ? frag.querySelectorAll(".od-yg").length : 0;
    sub.textContent = n + (n === 1 ? " year" : " years") + ", newest first · each year shows its Year-End result, " +
      "which decides your reward · open a year for its Mid-Year checkpoint";
    if (!n) { body.appendChild(el("p", "od-err", "Your past cycles appear here once you have one.")); return; }
    var tr = document.querySelector(".od-trend");   // the history card's read across the years, when it has one
    if (tr && !tr.hidden && (tr.querySelector(".od-trend-txt") || {}).textContent) {
      var trc = tr.cloneNode(true);
      trc.removeAttribute("data-load"); trc.removeAttribute("data-trend-url");
      body.appendChild(trc);
    }
    var hd = el("div", "od-lhead");
    hd.setAttribute("aria-hidden", "true");
    ["Year", "Performance", "Potential", "Talent status", ""].forEach(function (h) { hd.appendChild(el("span", null, h)); });
    body.appendChild(hd);
    var rows = el("div", "od-years");
    rows.appendChild(frag);
    body.appendChild(rows);
    var aim = lastListKey ? rows.querySelector('.od-crow[data-record="' + lastListKey + '"]') : null;
    var aimYear = (!aim && year) ? rows.querySelector('.od-yg[data-year="' + String(year) + '"]') : null;
    rows.querySelectorAll(".od-yg").forEach(function (g) {
      setYear(g, !!openYears[g.getAttribute("data-year")] || !!(aim && g.contains(aim)) || g === aimYear);
    });
    rows.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest(".od-yr");
      if (!b) return;
      e.preventDefault();
      var g = b.closest(".od-yg");
      setYear(g, b.getAttribute("aria-expanded") !== "true");
    });
    if (aim) {
      aim.classList.add("is-last");
      aim.scrollIntoView({ block: "nearest" });
      aim.focus();
    } else if (aimYear) {   // after show() has focused the panel (30ms), so the year they clicked has focus
      var yb = aimYear.querySelector(".od-yr"), my = seq;
      aimYear.scrollIntoView({ block: "nearest" });
      setTimeout(function () { if (yb && my === seq) yb.focus(); }, 60);
    }
    body.appendChild(el("p", "od-note", "A Year-End or a Mid-Year opens with its AI snapshot, your 360 in words and your development plan with your line manager's remark."));
  }

  // ---- the Career Plan, by plan year ----
  function loadPlan(year) {
    var my = ++seq; mode = "plan"; current = null; back = null;
    markRow(null);
    head("Your Career Plan", "Loading…");
    getJSON("/me/plan" + (year ? "?year=" + encodeURIComponent(year) : ""))
      .then(function (d) { if (my === seq) renderPlan(d); })
      .catch(function () { if (my === seq) { sub.textContent = ""; body.appendChild(el("p", "od-err", "Your Career Plan couldn't be opened right now.")); } });
  }
  function planSub(d) {
    var pl = d.plan;
    if (!d.year) return "No plan yet";
    if (!pl) return d.year + " plan · not started yet";
    if (pl.status === "draft") return d.year + " plan · draft · only you can see it until you share it";
    if (pl.status === "shared") return d.year + (pl.final ? " plan · shared, final" : " plan · shared with your line manager") + (pl.shared_on ? " on " + pl.shared_on : "");
    if (pl.status === "closed") return d.year + " plan · " + (pl.status_label || "Closed").toLowerCase() + (pl.closed_on ? " on " + pl.closed_on : "");
    return d.year + " plan";
  }
  function dl(rows) {
    var g = el("dl", "od-dl");
    rows.forEach(function (r) {
      g.appendChild(el("dt", null, r[0]));
      var dd = el("dd", r[1] ? null : "is-none", r[1] || "Not set yet");
      g.appendChild(dd);
    });
    return g;
  }
  function renderPlan(d) {
    head("Your Career Plan", planSub(d));
    picker("Plan year", (d.years || []).map(function (y) {
      return { label: String(y.year), tag: y.tag, on: y.year === d.year, go: function () { loadPlan(y.year); } };
    }), false);
    if (d.edit_url) {
      var bn = el("div", "od-banner");
      bn.appendChild(el("p", null, "You're writing your " + d.year + " plan in your AI check-in. Only you can see it until you share it with your line manager."));
      var a = el("a", "od-btn-ai is-outline is-sm"); a.href = d.edit_url;
      a.innerHTML = SPARK; a.appendChild(document.createTextNode(d.edit_label || "Open your AI check-in"));
      bn.appendChild(a);
      body.appendChild(bn);
    }
    if (d.profile) {
      var pr = el("section", "od-sec");
      pr.appendChild(el("h3", null, "Where you want to go"));
      pr.appendChild(dl([["Next move (1–3 years)", d.profile.next], ["Longer term (5+ years)", d.profile.longer],
                         ["Target role", d.profile.target], ["How far you'd move", d.profile.mobility]]));
      // an aim, never a promotion (Chris, 2026-10-22, canvas YMhfwSUFFkt94d5inNB6k8)
      var an = el("div", "rv-aim-note");
      an.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="9"/>'
        + '<circle cx="12" cy="12" r="4.5"/><circle class="c" cx="12" cy="12" r="1.2"/></svg>';
      an.appendChild(el("span", null, "Where you're aiming guides your development. It isn't a promotion or a promise of a move."));
      pr.appendChild(an);
      body.appendChild(pr);
    }
    var pl = d.plan;
    if (!pl) {
      body.appendChild(el("p", "od-err", d.year ? "There's no " + d.year + " plan yet." : "Your plan appears here once you write one in your AI check-in at Year-End."));
      return;
    }
    var sec = el("section", "od-sec");
    var gh = el("div", "od-ghd");
    gh.appendChild(el("h3", null, "Development goals · " + pl.goals.length));
    if (pl.can_checkin) gh.appendChild(el("span", "od-note", pl.last_checkin ? "Last check-in " + pl.last_checkin : "No check-in yet"));
    else if (pl.checkin_paused) gh.appendChild(el("span", "od-note", "Check-ins open between cycles"));
    else if (pl.checkin_ended) gh.appendChild(el("span", "od-note", "Read only: its year is over"));
    else if (pl.status === "closed") gh.appendChild(el("span", "od-note", "Read only: this plan is closed"));
    sec.appendChild(gh);
    if (!pl.goals.length) sec.appendChild(el("p", "od-note", "No goals in this plan yet."));
    pl.goals.forEach(function (g) {
      var box = el("div", "od-goal");
      var top = el("div", "od-goal-h");
      top.appendChild(el("span", "a", g.area));
      if (pl.can_checkin || g.progress) top.appendChild(el("span", "od-gst is-" + (g.status || "not_started"), g.progress || "Not started"));
      if (pl.can_checkin) {
        var cb = el("button", "od-ck-btn", "Check in");
        cb.type = "button";
        cb.setAttribute("aria-label", "Check in on " + g.area);
        cb.addEventListener("click", function () { openCheckin(box, g, d); });
        top.appendChild(cb);
      }
      box.appendChild(top);
      if (g.target_date) box.appendChild(el("p", "od-goal-m", "Target " + g.target_date));
      if ((g.actions || []).length) {
        var ac = el("dl", "od-acts7");
        g.actions.forEach(function (a) { ac.appendChild(el("dt", null, String(a.pct))); var dd = el("dd"); dd.appendChild(el("b", null, a.label + ": ")); dd.appendChild(document.createTextNode(a.text)); ac.appendChild(dd); });
        box.appendChild(ac);
      }
      box.appendChild(checkinLog(g));
      if (d.learning_on) box.appendChild(goalLearning(g, d, pl));
      if (g.lm_comment) { box.appendChild(el("p", "od-by", "Your line manager")); box.appendChild(el("p", "od-quote", g.lm_comment)); }
      sec.appendChild(box);
    });
    body.appendChild(sec);
    if ((d.gained || []).length) body.appendChild(gainedSection(d));
    var rm = el("section", "od-sec");
    rm.appendChild(el("h3", null, "Your line manager's remark"));
    if (pl.lm_remark) rm.appendChild(el("p", "od-quote", pl.lm_remark));
    else rm.appendChild(el("p", "od-note", pl.status === "closed" ? "No remark was written on this plan."
      : "Your line manager's remark shows here once your plan is approved."));
    body.appendChild(rm);
  }

  // AI+ Learning on the Career Plan (2026-10-22, S10, board 1D): each goal's learning -- asked for, booked, attended,
  // applied with the level confirmed -- and, for a goal with none on an open plan, the way to find some
  function goalLearning(g, d, pl) {
    var wrap = el("div", "od-learn");
    (g.learning || []).forEach(function (x) {
      var ln = el("div", "od-learn-ln is-" + x.state);
      ln.appendChild(el("span", "dot"));
      var t = el("span", "t");
      t.appendChild(el("b", null, x.title));
      if (x.when) t.appendChild(document.createTextNode(" · " + (x.state === "attended" || x.state === "applied" ? "attended " : "") + x.when));
      ln.appendChild(t);
      ln.appendChild(el("span", "od-chip" + (x.state === "applied" || x.state === "ojt" ? " is-ok" : ""), x.state === "applied" && x.level ? "Applied · L" + x.level + " confirmed" : x.label));
      wrap.appendChild(ln);
    });
    if (!(g.learning || []).length && pl.status !== "closed") {
      var no = el("div", "od-learn-ln is-none");
      no.appendChild(el("span", "t", "No learning for this goal yet"));
      var a = el("a", "od-btn-nv is-outline is-sm", "Find a programme"); a.href = d.find_url;
      no.appendChild(a);
      wrap.appendChild(no);
    }
    return wrap;
  }
  // what they've gained beyond their plan: a competency their line manager confirmed after training; "Add to my plan"
  // while next year's plan is being written
  function gainedSection(d) {
    var sec = el("section", "od-sec od-gained");
    sec.appendChild(el("h3", null, "Gained beyond your plan"));
    var err = el("p", "od-err"); err.hidden = true;
    d.gained.forEach(function (g) {
      var box = el("div", "od-goal is-gained");
      var top = el("div", "od-goal-h");
      top.appendChild(el("span", "a", g.title + (g.level ? " · L" + g.level : "")));
      top.appendChild(el("span", "od-chip is-ok", "Gained"));
      box.appendChild(top);
      box.appendChild(el("p", "od-goal-m", "From " + g.src + (g.on ? " · your line manager confirmed you use it, " + g.on : "")));
      if ((g.roles || []).length || d.gained_add) {
        var row = el("div", "od-gained-row");
        row.appendChild(el("span", "t", (g.roles || []).length ? "Also used in: " + g.roles.join(", ") : ""));
        if (d.gained_add) {
          var b = el("button", "od-btn-nv is-outline is-sm", "Add to my plan"); b.type = "button";
          b.addEventListener("click", function () {
            b.disabled = true; err.hidden = true;
            var fd = new FormData(); fd.append("csrf_token", token()); fd.append("key", g.key); fd.append("year", d.year || "");
            var my = seq;
            fetch(d.gained_url, { method: "POST", body: fd, credentials: "same-origin" })
              .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
              .then(function (x) {
                if (my !== seq) return;
                if (!x.ok || !x.j || !x.j.ok) { err.textContent = (x.j && x.j.message) || "That didn't save. Try again."; err.hidden = false; b.disabled = false; return; }
                var top_ = body.scrollTop; renderPlan(x.j.panel); body.scrollTop = top_;
                sub.textContent = x.j.message;
              })
              .catch(function () { if (my === seq) { err.textContent = "That didn't save. Try again."; err.hidden = false; b.disabled = false; } });
          });
          row.appendChild(b);
        }
        box.appendChild(row);
      }
      sec.appendChild(box);
    });
    sec.appendChild(err);
    sec.appendChild(el("p", "od-note", (d.gained_add ? "\u201cAdd to my plan\u201d adds it as a goal you've already reached. " : "") +
      "Gained learning is never part of your performance or potential rating."));
    return sec;
  }

  // A goal's check-ins, newest first: the three latest, the rest a click away.
  function checkinLog(g) {
    var wrap = el("div", "od-cklog");
    var list = g.checkins || [];
    if (!list.length) { wrap.appendChild(el("p", "od-ck-none", "No check-in yet")); return wrap; }
    var ol = el("ol");
    list.forEach(function (c, i) {
      var li = el("li", i >= 3 ? "is-more" : null);
      if (i >= 3) li.hidden = true;
      li.appendChild(el("span", "d", c.on));
      li.appendChild(el("b", null, c.label));
      li.appendChild(el("span", "n", c.note || ""));
      ol.appendChild(li);
    });
    wrap.appendChild(ol);
    if (list.length > 3) {
      var more = el("button", "od-ck-more", "Show " + (list.length - 3) + " earlier");
      more.type = "button";
      more.addEventListener("click", function () {
        ol.querySelectorAll("li.is-more").forEach(function (x) { x.hidden = false; });
        more.remove();
      });
      wrap.appendChild(more);
    }
    return wrap;
  }
  // One goal's check-in: where it is now and what moved, saved as a dated entry (POST /me/plan/checkin).
  function openCheckin(box, g, d) {
    body.querySelectorAll(".od-ckf").forEach(function (f) { f.remove(); });
    body.querySelectorAll(".od-ck-btn").forEach(function (b) { b.hidden = false; });
    var btn = box.querySelector(".od-ck-btn"); if (btn) btn.hidden = true;
    var f = el("form", "od-ckf");
    var fs = el("fieldset");
    fs.appendChild(el("legend", null, "Where is it now?"));
    var cur = g.status || "not_started";
    (d.progress || []).forEach(function (p) {
      var lab = el("label", "od-ck-opt");
      var r = el("input"); r.type = "radio"; r.name = "status"; r.value = p.key; r.checked = p.key === cur;
      lab.appendChild(r); lab.appendChild(document.createTextNode(p.label));
      fs.appendChild(lab);
    });
    f.appendChild(fs);
    var nl = el("label", "od-ck-note");
    nl.appendChild(document.createTextNode("What moved since your last check-in?"));
    var ta = el("textarea"); ta.name = "note"; ta.rows = 2; ta.maxLength = 2000;
    ta.placeholder = "e.g. Presented the Q3 result to the leadership team; the feedback was to lead with the variance.";
    nl.appendChild(ta);
    f.appendChild(nl);
    var err = el("p", "od-err"); err.hidden = true; f.appendChild(err);
    var row = el("div", "od-ck-acts");
    var save = el("button", "od-btn-nv is-sm", "Save check-in"); save.type = "submit";
    var cancel = el("button", "od-ck-cancel", "Cancel"); cancel.type = "button";
    cancel.addEventListener("click", function () { f.remove(); if (btn) { btn.hidden = false; btn.focus(); } });
    row.appendChild(save); row.appendChild(cancel);
    row.appendChild(el("span", "od-note", "Your line manager sees where each goal is."));
    f.appendChild(row);
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var st = f.querySelector("input[name=status]:checked");
      if (!st) { err.textContent = "Pick where the goal is now."; err.hidden = false; return; }
      save.disabled = true;
      var fd = new FormData();
      fd.append("csrf_token", token()); fd.append("goal_id", g.id); fd.append("status", st.value); fd.append("note", ta.value);
      var my = seq;
      fetch("/me/plan/checkin", { method: "POST", body: fd, credentials: "same-origin" })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (x) {
          if (my !== seq) return;
          if (!x.ok || !x.j || !x.j.ok) { err.textContent = (x.j && x.j.error) || "That didn't save. Try again."; err.hidden = false; save.disabled = false; return; }
          var top = body.scrollTop;
          renderPlan(x.j.panel);
          body.scrollTop = top;
          sub.textContent = "Check-in saved · " + planSub(x.j.panel);
        })
        .catch(function () { if (my === seq) { err.textContent = "That didn't save. Try again."; err.hidden = false; save.disabled = false; } });
    });
    box.insertBefore(f, box.querySelector(".od-cklog"));
    var first = f.querySelector("input[name=status]:checked") || f.querySelector("input[name=status]");
    if (first) first.focus();
  }

  // ---- the 360 report, by cycle ----
  function loadReport(cycle, backTo) {
    var my = ++seq; mode = "report"; current = null;
    back = backTo || null;
    markRow(null);
    head("Your 360 report", "Loading…");
    var via = back;
    getJSON("/me/report360" + (cycle ? "?cycle=" + encodeURIComponent(cycle) : ""))
      .then(function (d) { if (my === seq) { back = via; renderReport(d); } })
      .catch(function () { if (my === seq) { sub.textContent = ""; body.appendChild(el("p", "od-err", "Your 360 report couldn't be opened right now.")); } });
  }
  function meter(level) {
    var m = el("span", "od-meter");
    m.setAttribute("aria-hidden", "true");
    for (var i = 1; i <= 4; i++) m.appendChild(el("i", i <= level ? "on" : null));
    return m;
  }
  function renderReport(d) {
    var via = back;
    head("Your 360 report", !d.cycles || !d.cycles.length ? "No 360 report yet"
      : d.released ? ("Released to you" + (d.released_on ? " on " + d.released_on : "")) : "Not released yet · Group People releases it after calibration");
    if (via && via.kind === "record") backButton(via.name, function () {
      if (via.key === "current") { mode = "present"; back = null; load("current"); } else open(via.key, null, via.viaList);
    });
    picker("Cycle", (d.cycles || []).map(function (c) {
      return { label: c.name, short: c.half || c.name, group: c.year, tag: c.tag, on: c.id === d.cycle,
               go: function () { loadReport(c.id, via); } };
    }), true);
    if (!d.cycles || !d.cycles.length) { body.appendChild(el("p", "od-err", "Your 360 report appears here once one is released to you.")); return; }
    if (!d.released) {
      var nr = el("div", "od-empty");
      nr.appendChild(el("b", null, "Not released yet"));
      nr.appendChild(el("p", null, "Your " + d.name + " report comes out once Group People releases it after calibration. It will show here, beside your earlier reports."));
      body.appendChild(nr);
      return;
    }
    var br = el("div", "od-bandrow");
    br.appendChild(el("span", "k", "Potential"));
    if (d.band) { br.appendChild(pill(d.band)); br.appendChild(el("span", "n", "final band after calibration")); }
    else br.appendChild(el("span", "n", "Your final potential band isn't released yet"));
    body.appendChild(br);
    if ((d.strong || []).length || (d.grow || []).length || d.even) {
      var sw = el("section", "od-sec");
      sw.appendChild(el("h3", null, "At a glance"));
      var c = el("div", "od-pchips");
      (d.strong || []).forEach(function (x) { var p = el("span", "od-pchip", "Strongest: " + x.name); p.title = x.short + " · " + x.words; c.appendChild(p); });
      (d.grow || []).forEach(function (x) { var p = el("span", "od-pchip is-grow", "To grow: " + x.name); p.title = x.short + " · " + x.words; c.appendChild(p); });
      if (d.even) c.appendChild(el("span", "od-pchip", "Your colleagues saw every principle about the same"));
      sw.appendChild(c);
      body.appendChild(sw);
    }
    var sec = el("section", "od-sec");
    sec.appendChild(el("h3", null, "Principle by principle"));
    (d.principles || []).forEach(function (p) {
      var box = el("div", "od-prin");
      var hd = el("div", "od-prin-h");
      var nm = el("span", "nm"); nm.appendChild(el("b", null, p.name)); if (p.short && p.short !== p.name) nm.appendChild(el("small", null, p.short));
      hd.appendChild(nm); hd.appendChild(meter(p.level)); hd.appendChild(el("span", "w", p.words));
      box.appendChild(hd);
      if ((p.behaviours || []).length) {
        var ul = el("ul", "od-beh");
        p.behaviours.forEach(function (b) {
          var li = el("li");
          var t = el("span", "tx", b.text);
          if (b.next) t.appendChild(el("em", null, "next level"));
          li.appendChild(t); li.appendChild(el("span", "w", b.words));
          ul.appendChild(li);
        });
        box.appendChild(ul);
      }
      (p.comments || []).forEach(function (q) { box.appendChild(el("p", "od-quote", "“" + q + "”")); });
      sec.appendChild(box);
    });
    body.appendChild(sec);
    body.appendChild(el("p", "od-note", "Colleagues' words are shown without names. Agreement is in words, never a score."));
  }

  // ---- What you led (Chris, 2026-10-12; canvas boards W2-W5): the people a leader is over, tab by seat. Each row: their
  // talent status and final bands once Group People releases them to the leader (the BG CEO, who decided them, at once), else the
  // bands up to the leader's own step and "In calibration". Opening a row shows how both bands moved, step by step, with
  // each tier's reason -- fetched for that one person (/me/led/<id>), so the list stays light. ----
  var led = { d: null, f: { row: "", q: "", band: "", moved: false, tal: "" }, shown: 50, open: {} };
  var LED_STEP_NOTE = { set: "", kept: "kept", moved: "", none: "", hidden: "" };
  function loadLed(cycle, tab, keep) {
    var my = ++seq;
    mode = "led"; back = null;
    head("Your people's results", "Loading…");
    drawer.classList.add("is-wide");
    if (!keep) { led.f = { row: "", q: "", band: "", moved: false, tal: "" }; }
    led.shown = 50; led.open = {};
    var q = [];
    if (cycle) q.push("cycle=" + encodeURIComponent(cycle));
    if (tab) q.push("tab=" + encodeURIComponent(tab));
    getJSON("/me/led" + (q.length ? "?" + q.join("&") : ""))
      .then(function (d) { if (my === seq) renderLed(d); })
      .catch(function () {
        if (my !== seq) return;
        sub.textContent = "";
        body.appendChild(el("p", "od-err", "Your people couldn't be opened right now."));
      });
  }
  function ledSub(d) {
    if (d.at_once) return "You decided these, so you see them now · open one to see how both bands moved";
    if (d.state === "before") return "Each person's talent status and final bands show once Group People releases them to you · open one to see how their bands moved up to your step";
    if (d.state === "mixed") return d.n_full + " of " + (d.n_res || d.people.length) + " released to you · open one to see how both bands moved";
    return "Released to you by Group People · open one to see how both bands moved";
  }
  function talPill(t) {
    var p = el("span", "tcat-pill tbox-cat-" + (t.slug || ""), t.name);
    return p;
  }
  function ledRowsFiltered(withTal) {
    var d = led.d, f = led.f, q = f.q.trim().toLowerCase();
    return d.people.filter(function (p) {
      if (f.row && d.filter && p[d.filter.key] !== f.row) return false;
      if (!withTal) return true;
      if (q && (p.name + " " + p.meta).toLowerCase().indexOf(q) < 0) return false;
      if (f.band && p.pm !== f.band && p.pot !== f.band) return false;
      if (f.moved && !p.moves) return false;
      if (f.tal && (!p.talent || p.talent.name !== f.tal)) return false;
      return true;
    });
  }
  function scrollRow(items, label, onPick, on) {
    var row = el("div", "od-led-frow");
    row.appendChild(el("span", "k", label));
    var prev = el("button", "od-led-nav", "‹"); prev.type = "button"; prev.setAttribute("aria-label", "Earlier");
    var next = el("button", "od-led-nav", "›"); next.type = "button"; next.setAttribute("aria-label", "More");
    var strip = el("div", "od-led-strip");
    items.forEach(function (it) {
      var b = el("button", "od-led-pill" + (it.v === on ? " is-on" : ""));
      b.type = "button"; b.setAttribute("aria-pressed", it.v === on ? "true" : "false");
      b.appendChild(document.createTextNode(it.label + " "));
      b.appendChild(el("span", "n", String(it.n)));
      b.addEventListener("click", function () { onPick(it.v); });
      strip.appendChild(b);
    });
    function sync() {
      var over = strip.scrollWidth > strip.clientWidth + 2;
      prev.hidden = next.hidden = !over;
      prev.disabled = strip.scrollLeft <= 1;
      next.disabled = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
    }
    prev.addEventListener("click", function () { strip.scrollBy({ left: -strip.clientWidth * 0.7, behavior: "smooth" }); });
    next.addEventListener("click", function () { strip.scrollBy({ left: strip.clientWidth * 0.7, behavior: "smooth" }); });
    strip.addEventListener("scroll", sync);
    row.appendChild(prev); row.appendChild(strip); row.appendChild(next);
    setTimeout(function () {
      var lit = strip.querySelector(".is-on");
      if (lit) strip.scrollLeft = Math.max(0, lit.offsetLeft - strip.clientWidth / 2 + lit.offsetWidth / 2);
      sync();
    }, 0);
    return row;
  }
  function renderLed(d) {
    led.d = d;
    head("Your people's results", ledSub(d));
    drawer.classList.add("is-wide");
    picker("Cycle", (d.cycles || []).map(function (c) {
      return { label: c.name, tag: c.active ? "this cycle" : "", on: c.id === d.cycle,
               go: function () { loadLed(c.id, d.tab, true); } };
    }), true);
    var tabs = el("div", "od-led-tabs");
    tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Whose results");
    d.tabs.forEach(function (t) {
      var b = el("button", "od-led-tab" + (t.key === d.tab ? " is-on" : ""), t.label + " · " + t.n);
      b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", t.key === d.tab ? "true" : "false");
      b.addEventListener("click", function () { if (t.key !== d.tab) loadLed(d.cycle, t.key); });
      tabs.appendChild(b);
    });
    body.appendChild(tabs);
    var top = el("div", "od-led-top");
    body.appendChild(top);
    var ctl = el("div", "od-led-ctl");
    var sl = el("label", "od-led-search");
    sl.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>');
    var si = el("input"); si.type = "search"; si.placeholder = "Search a name or department"; si.value = led.f.q;
    si.setAttribute("aria-label", "Search a name or department");
    si.addEventListener("input", function () { led.f.q = si.value; led.shown = 50; draw(); });
    sl.appendChild(si); ctl.appendChild(sl);
    var bl = el("label", "od-led-band", "Final band ");
    var bs = el("select");
    var any = el("option", null, "Any"); any.value = ""; bs.appendChild(any);
    [["Performance", d.bands.pm], ["Potential", d.bands.pot]].forEach(function (g) {
      var og = document.createElement("optgroup"); og.label = g[0];
      g[1].forEach(function (b) { var o = el("option", null, b); o.value = b; if (b === led.f.band) o.selected = true; og.appendChild(o); });
      bs.appendChild(og);
    });
    bs.addEventListener("change", function () { led.f.band = bs.value; led.shown = 50; draw(); });
    bl.appendChild(bs); ctl.appendChild(bl);
    var ml = el("label", "od-led-moved");
    var mc = el("input"); mc.type = "checkbox"; mc.checked = led.f.moved;
    mc.addEventListener("change", function () { led.f.moved = mc.checked; led.shown = 50; draw(); });
    ml.appendChild(mc); ml.appendChild(document.createTextNode(" Moved only"));
    ctl.appendChild(ml);
    var count = el("span", "od-led-count"); count.setAttribute("aria-live", "polite");
    ctl.appendChild(count);
    body.appendChild(ctl);
    if (d.state !== "after" && !d.at_once) {
      var nt = el("div", "od-led-note");
      nt.appendChild(el("b", null, d.state === "before" ? "Not released to you yet." : "Some aren't released to you yet."));
      nt.appendChild(document.createTextNode(" Each person's talent status and final bands show here once Group People releases the results to leaders. Until then you see the bands up to your own step, so you can talk each one through before it reaches the person."));
      body.appendChild(nt);
    }
    var you = d.at_once ? "" : " · you";
    var hd = el("div", "od-led-hd");
    ["Person", "Talent status", d.state === "after" ? "Performance" : "Performance" + you,
     d.state === "after" ? "Potential" : "Potential" + you, "How it moved", ""].forEach(function (h) { hd.appendChild(el("span", null, h)); });
    var list = el("div", "od-led-list");
    var more = el("div", "od-led-more");
    body.appendChild(hd); body.appendChild(list); body.appendChild(more);

    function draw() {
      top.textContent = "";
      if (d.filter && d.filter.items.length > 1) {
        top.appendChild(scrollRow([{ v: "", label: "All", n: d.people.length }].concat(d.filter.items), d.filter.label,
          function (v) { led.f.row = v; led.f.tal = ""; led.shown = 50; draw(); }, led.f.row));
      }
      var base = ledRowsFiltered(false);
      var tally = {};
      base.forEach(function (p) { if (p.talent) tally[p.talent.name] = (tally[p.talent.name] || 0) + 1; });
      var cats = (d.talent_order || []).filter(function (c) { return tally[c]; });
      if (cats.length) {
        var tr = el("div", "od-led-tal");
        var rowLab = d.filter && led.f.row ? (d.filter.items.filter(function (x) { return x.v === led.f.row; })[0] || {}).label : "";
        tr.appendChild(el("span", "k", "Talent status" + (rowLab ? " · " + rowLab : "")));
        cats.forEach(function (c) {
          var b = el("button", "od-led-tchip" + (led.f.tal === c ? " is-on" : ""));
          b.type = "button"; b.setAttribute("aria-pressed", led.f.tal === c ? "true" : "false");
          b.appendChild(document.createTextNode(c + " ")); b.appendChild(el("b", null, String(tally[c])));
          b.addEventListener("click", function () { led.f.tal = led.f.tal === c ? "" : c; led.shown = 50; draw(); });
          tr.appendChild(b);
        });
        top.appendChild(tr);
      }
      var rows = ledRowsFiltered(true);
      count.textContent = rows.length + " of " + d.people.length + " shown";
      list.textContent = "";
      if (!rows.length) list.appendChild(el("p", "od-led-empty", d.people.length ? "Nobody matches these filters." : "Nobody to show for this cycle."));
      rows.slice(0, led.shown).forEach(function (p) { list.appendChild(ledRow(p)); });
      more.textContent = "";
      if (rows.length > led.shown) {
        more.appendChild(el("span", null, "Showing " + Math.min(led.shown, rows.length) + " of " + rows.length));
        var mb = el("button", "od-btn-nv is-outline is-sm", "Show " + Math.min(50, rows.length - led.shown) + " more");
        mb.type = "button";
        mb.addEventListener("click", function () { led.shown += 50; draw(); });
        more.appendChild(mb);
      }
      if (led.shown > 50 && rows.length > 50) {   // fold back to the first page (Chris, 2026-10-19)
        var lb = el("button", "fold-less", "Show less");
        lb.type = "button";
        lb.addEventListener("click", function () { led.shown = 50; draw(); });
        more.appendChild(lb);
      }
    }
    draw();
  }
  function ledRow(p) {
    var d = led.d;
    var row = el("div", "od-led-row" + (led.open[p.id] ? " is-open" : ""));
    var line = el("div", "od-led-line");
    var who = el("div", "od-led-who");
    who.appendChild(el("b", null, p.name));
    if (p.meta) who.appendChild(el("span", "m", p.meta));
    who.appendChild(el("span", "r is-" + p.rel_tone, p.rel));
    line.appendChild(who);
    var tc = el("span", "c");
    if (p.talent) tc.appendChild(talPill(p.talent));
    else if (p.none) tc.appendChild(el("span", "od-dash", "No result yet"));
    else tc.appendChild(el("span", "od-led-incal", d.mid_year ? "With the HOD" : "In calibration"));
    line.appendChild(tc);
    ["pm", "pot"].forEach(function (k) {
      var c = el("span", "c");
      if (p[k]) c.appendChild(pill(p[k], p[k])); else c.appendChild(el("span", "od-dash", "—"));
      line.appendChild(c);
    });
    var mv = el("span", "c mv" + (p.moves ? " is-moved" : ""));
    if (p.imported) mv.textContent = "Before OneHR";
    else if (p.full) mv.textContent = p.moves ? (p.moves + (p.moves === 1 ? " move" : " moves")) : "No moves";
    else mv.textContent = p.you.length ? "You moved " + (p.you.length === 2 ? "both" : p.you[0]) : (p.none ? "" : "No moves by you");
    line.appendChild(mv);
    var tg = el("button", "od-led-chev", led.open[p.id] ? "▾" : "▸");
    tg.type = "button";
    tg.setAttribute("aria-expanded", led.open[p.id] ? "true" : "false");
    tg.setAttribute("aria-label", "Show how " + p.name + "'s bands moved");
    line.appendChild(tg);
    row.appendChild(line);
    var box = el("div", "od-led-chain");
    box.hidden = !led.open[p.id];
    row.appendChild(box);
    function toggle() {
      led.open[p.id] = !led.open[p.id];
      row.classList.toggle("is-open", !!led.open[p.id]);
      tg.textContent = led.open[p.id] ? "▾" : "▸";
      tg.setAttribute("aria-expanded", led.open[p.id] ? "true" : "false");
      box.hidden = !led.open[p.id];
      if (led.open[p.id] && !box.childNodes.length) {
        box.appendChild(el("p", "od-led-loading", "Reading their record…"));
        getJSON("/me/led/" + p.id + "?cycle=" + encodeURIComponent(d.cycle))
          .then(function (x) { box.textContent = ""; ledChain(box, x, d); })
          .catch(function () { box.textContent = ""; box.appendChild(el("p", "od-err", "This person's record couldn't be read right now.")); });
      }
    }
    tg.addEventListener("click", toggle);
    line.addEventListener("click", function (e) { if (!e.target.closest("button")) toggle(); });
    return row;
  }
  function ledChain(box, x, d) {
    if (x.imported) {   // a year from before OneHR: its talent status (2026-10-14), with Group People's bands where recorded (2026-10-22)
      box.appendChild(el("p", "od-led-loading", x.imported_perf
        ? "Talent status " + x.imported + " (performance " + x.imported_perf + ", potential " + x.imported_pot +
          "), from Group People's records before OneHR. No band movement was recorded that year."
        : "Talent status " + x.imported + ", from Group People's records before OneHR. No band or band movement was recorded that year."));
      return;
    }
    if (!x.axes || !x.axes.length) { box.appendChild(el("p", "od-led-loading", "Nothing recorded for this cycle yet.")); return; }
    var cols = [];
    x.axes.forEach(function (a) { a.steps.forEach(function (st) { if (cols.indexOf(st.step) < 0) cols.push(st.step); }); });
    var labels = {};
    x.axes.forEach(function (a) { a.steps.forEach(function (st) { labels[st.step] = st.label + (st.you ? " · you" : ""); }); });
    var anyFinal = x.axes.some(function (a) { return a.full; });
    var g = el("div", "od-led-grid");
    g.style.gridTemplateColumns = "84px repeat(" + (cols.length + 1) + ", minmax(0, 1fr))";
    g.appendChild(el("span", "h", ""));
    cols.forEach(function (k) { g.appendChild(el("span", "h", labels[k])); });
    g.appendChild(el("span", "h", "Final"));
    x.axes.forEach(function (a) {
      g.appendChild(el("span", "ax", a.label));
      cols.forEach(function (k) {
        var st = a.steps.filter(function (z) { return z.step === k; })[0];
        var c = el("span", "cell" + (st && st.state === "hidden" ? " is-hidden" : ""));
        if (!st) c.appendChild(el("span", "od-dash", "—"));
        else if (st.state === "hidden") c.appendChild(el("span", "w", x.mid_year ? "With the HOD" : "In calibration"));
        else if (!st.band) c.appendChild(el("span", "od-dash", "—"));
        else {
          var pp = pill(st.band, st.band);
          if (st.state === "moved") pp.classList.add("is-moved");
          c.appendChild(pp);
          var note = st.state === "moved" ? (st.dir === "up" ? "↑" : st.dir === "down" ? "↓" : "moved") : (LED_STEP_NOTE[st.state] || "");
          if (note) c.appendChild(el("span", "w" + (st.state === "moved" ? " is-moved" : ""), note));
        }
        g.appendChild(c);
      });
      var fc = el("span", "cell" + (a.full ? "" : " is-hidden"));
      if (a.full && a.final) fc.appendChild(pill(a.final, a.final));
      else fc.appendChild(el("span", "w", a.full ? "—" : x.mid_year ? "Not released yet" : "In calibration"));
      g.appendChild(fc);
    });
    box.appendChild(g);
    var whys = [];
    x.axes.forEach(function (a) {
      var before = null;
      a.steps.forEach(function (st) {
        if (st.state === "hidden") return;
        if (st.why && st.band) {
          whys.push({ k: st.label + (st.you ? " · you" : ""),
                      what: a.label + (st.state === "moved" && before ? " " + before + " → " + st.band + "." : st.state === "kept" ? " kept " + st.band + "." : " " + st.band + "."),
                      why: st.why });
        }
        before = st.band || before;
      });
    });
    if (whys.length) {
      var w = el("dl", "od-led-why");
      whys.forEach(function (r) {
        w.appendChild(el("dt", null, r.k));
        var dd = el("dd");
        dd.appendChild(el("b", null, r.what + " "));
        dd.appendChild(document.createTextNode("“" + r.why + "”"));
        w.appendChild(dd);
      });
      box.appendChild(w);
    }
    if (!anyFinal) box.appendChild(el("p", "od-led-loading", "The steps after yours show once Group People releases the results to you."));
  }

  // AI+ Learning (2026-10-20): the Learning panel, rendered by the server (/learning/panel?tab=); its tabs, search and
  // interest buttons are data-lm-* hooks, handled below. Marking interest keeps the reader's place and says what it did.
  var lm = { tab: "plan", q: "", key: "" };
  function loadLearning(tab, q, key, keep, note) {
    var my = ++seq; mode = "learning"; current = null; back = null;
    markRow(null);
    lm = { tab: tab || "plan", q: q || "", key: key || "" };
    var top = keep ? body.scrollTop : 0;
    if (!keep) head("Your learning", "Loading…");
    getJSON("/learning/panel?tab=" + encodeURIComponent(lm.tab) + (lm.q ? "&q=" + encodeURIComponent(lm.q) : "") +
            (lm.key ? "&key=" + encodeURIComponent(lm.key) : ""))
      .then(function (d) {
        if (my !== seq) return;
        head(d.title || "Your learning", d.sub || "");
        body.innerHTML = d.html || "";
        body.scrollTop = top;
        var m = note && body.querySelector("[data-lm-msg]");
        if (m) { m.textContent = note; m.hidden = false; }
      })
      .catch(function () { if (my === seq) { head("Your learning", ""); body.appendChild(el("p", "od-err", "Your learning couldn't be opened right now.")); } });
  }
  body.addEventListener("click", function (e) {
    if (mode !== "learning") return;
    var t = e.target.closest("[data-lm-tab]");
    if (t) { e.preventDefault(); loadLearning(t.getAttribute("data-lm-tab")); return; }
    var k = e.target.closest("[data-lm-key]");
    if (k) { e.preventDefault(); loadLearning("explore", lm.q, k.getAttribute("data-lm-key"), true); return; }
    var b = e.target.closest("[data-lm-interest]");
    if (!b || b.disabled) return;
    e.preventDefault();
    b.disabled = true;
    var f = new FormData();
    f.append("csrf_token", token());
    f.append("kind", b.getAttribute("data-kind") || "");
    if (b.getAttribute("data-programme")) f.append("programme_id", b.getAttribute("data-programme"));
    if (b.getAttribute("data-key")) f.append("comp_key", b.getAttribute("data-key"));
    f.append("on", b.getAttribute("data-on") || "1");
    fetch("/learning/interest", { method: "POST", body: f, credentials: "same-origin", headers: { "Accept": "application/json" } })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) {
        if (d.ok) { loadLearning(lm.tab, lm.q, lm.key, true, d.message); return; }
        b.disabled = false;
        var m = body.querySelector("[data-lm-msg]");
        if (m) { m.textContent = d.message || "That didn't go through. Try again."; m.hidden = false; }
      })
      .catch(function () { b.disabled = false; });
  });
  body.addEventListener("submit", function (e) {
    if (mode !== "learning") return;
    var f = e.target.closest("[data-lm-search]");
    if (!f) return;
    e.preventDefault();
    var qi = f.querySelector("input[name=q]");
    loadLearning(lm.tab, qi ? qi.value.trim() : "", "", true);
  });

  // ---- Who has submitted (Chris, 2026-11-02; canvas boards A1 Main, A2 Leaders, A3 Group, E1 Entry): the leader's own people,
  // part by part, from GET /me/progress?scope=. One payload a scope; the search, the department / unit pick and the
  // "Yet to submit" quick filter all work on it in the page. Names, ID and job grade, and each part's state (done and
  // when, not yet, late pass, done by the line manager, not part of it): never a band, score, rating or remark, and
  // nothing to download. Every string is set with textContent. ----
  var sb = { d: null, tab: "staff", f: { q: "", g: "", yet: "any" }, lf: { q: "", g: "", yet: "any" }, closed: {}, opened: {},
             lm: {}, key: "" };
  var SB_CAP = 60, SB_CAP_FOLD = 30;
  function loadSubs(scope, keep) {
    var my = ++seq;
    mode = "subs"; back = null;
    head("Who has submitted", "Loading…");
    drawer.classList.add("is-wide");
    if (!keep) { sb.tab = "staff"; sb.f = { q: "", g: "", yet: "any" }; sb.lf = { q: "", g: "", yet: "any" }; sb.closed = {}; sb.opened = {}; sb.lm = {}; }
    getJSON("/me/progress" + (scope ? "?scope=" + encodeURIComponent(scope) : ""))
      .then(function (d) { if (my === seq) renderSubs(d); })
      .catch(function () {
        if (my !== seq) return;
        sub.textContent = "";
        body.appendChild(el("p", "od-err", "Who has submitted couldn't be opened right now."));
      });
  }
  function sbYet(c) { return c[0] === 0 || c[0] === 2; }
  function sbRowYet(r, only) {
    for (var i = 0; i < r.c.length; i++) { if ((only == null || only === i) && sbYet(r.c[i])) return true; }
    return false;
  }
  function sbCell(part, c) {
    var w = el("span", "sb-c");
    var k = part.key, t, cls;
    if (c[0] === 1) {
      cls = "sb-ok";
      t = k === "f360" ? "✓ " + c[2] + " of " + c[3] : "✓ " + (k === "idp_self" ? "Shared " : "") + c[1];
    } else if (c[0] === 3) { cls = "sb-by"; t = "✓ By LM " + c[1]; }
    else if (c[0] === 2) { cls = "sb-lp"; t = "Late pass · " + c[1]; }
    else if (c[0] === 4) { cls = "sb-na"; t = "–"; }
    else { cls = "sb-no"; t = k === "f360" ? c[2] + " of " + c[3] : (part.closed ? (k === "idp_self" ? "Not shared" : "Not submitted") : "Not yet"); }
    var s = el("span", cls, t);
    var tip = c[0] === 1 ? (k === "f360" ? "Gave all " + c[3] + " of the 360 ratings asked of them" : (k === "idp_self" ? "Shared " : "Submitted ") + c[1]) :
      c[0] === 3 ? "Their line manager assessed it on their behalf, " + c[1] :
      c[0] === 2 ? (k === "f360" ? "Group People gave them more time to give their ratings" : "Group People gave them more time, until " + c[1]) :
      c[0] === 4 ? "Not part of their review" : (k === "f360" ? "Gave " + c[2] + " of the " + c[3] + " 360 ratings asked of them" : t);
    s.title = tip;
    w.appendChild(s);
    return w;
  }
  function sbTemplate(nParts, lmCol) {
    return lmCol ? "minmax(0,1.3fr) minmax(0,.9fr) repeat(" + nParts + ",minmax(0,1.1fr))" : "minmax(0,1.4fr) repeat(" + nParts + ",minmax(0,1.1fr))";
  }
  function sbChip(label, n, on, go) {
    var b = el("button", "sb-chip" + (on ? " is-on" : ""));
    b.type = "button"; b.setAttribute("aria-pressed", on ? "true" : "false");
    b.appendChild(document.createTextNode(label + " "));
    b.appendChild(el("span", "n", String(n)));
    b.addEventListener("click", go);
    return b;
  }
  function sbTiles(tiles, onTile, unit) {
    var g = el("div", "sb-tiles");
    g.style.setProperty("--sb-n", String(Math.max(1, Math.min(4, tiles.length))));
    tiles.forEach(function (t) {
      var a = el("button", "sb-tile"); a.type = "button";
      a.title = "Show who is yet to do " + t.name.toLowerCase();
      a.appendChild(el("span", "k", t.name));
      var v = el("span", "v", t.done + " of " + t.n + (unit ? " " + unit : "") + " ");
      v.appendChild(el("span", "p", "· " + t.pct + "%"));
      a.appendChild(v);
      var bar = el("span", "sb-bar"); var fill = el("i"); fill.style.width = t.pct + "%"; bar.appendChild(fill); a.appendChild(bar);
      var note = t.note || "";
      if (t.given) note = (note ? note + " · " : "") + t.given[0] + " of " + t.given[1] + " ratings";
      if (t.people) note = (note ? note + " · " : "") + t.people[0] + " of " + t.people[1] + " people";
      a.appendChild(el("span", "n", note));
      a.addEventListener("click", function () { onTile(t.key); });
      g.appendChild(a);
    });
    return g;
  }
  function renderSubs(d) {
    sb.d = d; sb.key = d.key;
    head("Who has submitted", d.full + " · " + d.n + " " + (d.n === 1 ? "person" : "people") + " taking part · " + d.cycle.name);
    drawer.classList.add("is-wide");
    var nav = drawer.querySelector(".od-dnav");
    if (nav) {
      Array.prototype.forEach.call(nav.querySelectorAll(".sb-dn"), function (n) { n.remove(); });
      if (d.scopes.length > 1) {
        var pills = el("div", "sb-pills sb-dn"); pills.setAttribute("role", "group"); pills.setAttribute("aria-label", "Your scopes");
        d.scopes.forEach(function (s) {
          var b = el("button", "sb-pill" + (s.key === d.key ? " is-on" : ""), s.label + " · " + s.n);
          b.type = "button"; b.title = s.full; b.setAttribute("aria-pressed", s.key === d.key ? "true" : "false");
          b.addEventListener("click", function () { if (s.key !== d.key) loadSubs(s.key); });
          pills.appendChild(b);
        });
        nav.appendChild(pills);
      }
    }
    if (d.lm) {
      var tabs = el("div", "od-led-tabs sb-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Whose parts");
      [["staff", "Staff · " + d.n], ["lm", "Line managers · " + d.lm.rows.length]].forEach(function (t) {
        var b = el("button", "od-led-tab" + (sb.tab === t[0] ? " is-on" : ""), t[1]);
        b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", sb.tab === t[0] ? "true" : "false");
        b.addEventListener("click", function () { if (sb.tab !== t[0]) { sb.tab = t[0]; renderSubs(d); } });
        tabs.appendChild(b);
      });
      body.appendChild(tabs);
    } else { sb.tab = "staff"; }
    if (sb.tab === "lm") sbLM(d); else sbStaff(d);
  }
  function sbControls(f, groups, label, placeholder, redraw, host) {
    var ctl = el("div", "sb-ctl");
    var sl = el("label", "od-led-search");
    sl.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>');
    var si = el("input"); si.type = "search"; si.placeholder = placeholder; si.value = f.q; si.setAttribute("aria-label", placeholder);
    si.addEventListener("input", function () { f.q = si.value; redraw(); });
    sl.appendChild(si); ctl.appendChild(sl);
    if (groups.length > 1) {
      var sel = el("select", "sb-sel"); sel.setAttribute("aria-label", label);
      var o0 = el("option", null, "All " + label.toLowerCase() + " · " + groups.length); o0.value = ""; sel.appendChild(o0);
      groups.forEach(function (g) { var o = el("option", null, g[1]); o.value = g[0]; if (f.g === g[0]) o.selected = true; sel.appendChild(o); });
      sel.addEventListener("change", function () { f.g = sel.value; redraw(); });
      ctl.appendChild(sel);
    }
    host.appendChild(ctl);
  }
  function sbQuick(host, opts, f, label, redraw) {
    var q = el("div", "sb-quick"); q.setAttribute("role", "group"); q.setAttribute("aria-label", "Quick filter");
    q.appendChild(el("span", "k", label));
    opts.forEach(function (o) { q.appendChild(sbChip(o.t, o.n, f.yet === o.v, function () { f.yet = o.v; redraw(); })); });
    host.appendChild(q);
    return q;
  }
  function sbStaff(d) {
    var parts = d.parts, f = sb.f, nP = parts.length;
    var lmCol = d.kind !== "hod";
    var onTile = function (k) { f.yet = k; draw(); };
    body.appendChild(sbTiles(d.tiles, onTile));
    var ctlHost = el("div", "sb-top"); body.appendChild(ctlHost);
    var quickHost = el("div", "sb-qhost"); body.appendChild(quickHost);
    var box = el("div", "sb-box"); body.appendChild(box);
    var hd = el("div", "sb-r sb-h"); hd.style.gridTemplateColumns = sbTemplate(nP, lmCol);
    hd.appendChild(el("span", null, d.fold ? (d.kind === "gc" ? "Batch / person" : "Unit / person") : "Person"));
    if (lmCol) { var lh = el("span", null, d.kind === "bg" ? "BU CEO / LM" : "Line manager"); if (d.kind === "bg") lh.title = "BU CEO on a unit's row; a person's line manager on theirs"; hd.appendChild(lh); }
    parts.forEach(function (p) { var s = el("span", null, p.name); s.title = p.name + (p.closes ? " · " + p.closes : ""); hd.appendChild(s); });
    box.appendChild(hd);
    var scroll = el("div", "sb-scroll"); box.appendChild(scroll);
    body.appendChild(el("p", "sb-foot", d.fold ?
      "Units start folded, with their counts; open one to see its people. Who has done each part and when, never a score or a band. Nothing to download; reminders come from Group People." :
      "Who has done each part and when, never a score or a band. A name opens nothing more; nothing to download. Reminders come from Group People."));
    function pass(r) {
      var q = f.q.trim().toLowerCase();
      if (q && (r.n + " " + r.eid).toLowerCase().indexOf(q) < 0) return false;
      return true;
    }
    function want(r) {
      if (f.yet === "all") return true;
      if (f.yet === "any") return sbRowYet(r, null);
      var i = parts.map(function (p) { return p.key; }).indexOf(f.yet);
      return i >= 0 && sbRowYet(r, i);
    }
    function inGroup(g) { return !f.g || g.key === f.g; }
    function draw() {
      // counts follow the search and the group pick, never the quick filter itself
      var pool = [];
      d.groups.forEach(function (g) { if (inGroup(g)) g.rows.forEach(function (r) { if (pass(r)) pool.push(r); }); });
      var cnt = { any: 0, all: pool.length };
      parts.forEach(function (p, i) { cnt[p.key] = 0; });
      pool.forEach(function (r) {
        if (sbRowYet(r, null)) cnt.any++;
        parts.forEach(function (p, i) { if (sbYet(r.c[i])) cnt[p.key]++; });
      });
      ctlHost.textContent = ""; quickHost.textContent = "";
      sbControls(f, d.groups.map(function (g) { return [g.key, g.name]; }), d.by === "Business unit" ? "Units" : d.by === "Batch" ? "Batches" : d.by === "Department" ? "Departments" : "Teams",
        "Find a person or Employee ID", function () { draw(); var i = ctlHost.querySelector("input"); if (i) { i.focus(); } }, ctlHost);
      var opts = [{ v: "any", t: "Any part", n: cnt.any }].concat(parts.map(function (p) { return { v: p.key, t: p.name, n: cnt[p.key] }; }), [{ v: "all", t: "Everyone", n: cnt.all }]);
      sbQuick(quickHost, opts, f, "Yet to submit", draw);
      scroll.textContent = "";
      var shown = 0;
      d.groups.forEach(function (g) {
        if (!inGroup(g)) return;
        var rows = g.rows.filter(function (r) { return pass(r) && want(r); });
        var searching = !!f.q.trim();
        // a team with nobody left to do still shows (header "0 not done of N", members with their dates), unless searching or folded
        var allDone = !rows.length && !d.fold && !searching && f.yet !== "all" && g.rows.length > 0;
        if (allDone) rows = g.rows;
        if (!rows.length && (!d.fold || searching || f.yet !== "all")) { if (!(d.fold && !searching && f.yet === "any" && !g.rows.length)) { if (!rows.length) return; } }
        shown += rows.length;
        var yet = g.rows.filter(function (r) { return sbRowYet(r, null); }).length;
        var gk = d.key + "|" + g.key;
        var isOpen = d.fold ? !!sb.opened[gk] : !sb.closed[gk];
        var h = el(d.fold ? "button" : "button", "sb-g" + (d.fold ? " sb-gf sb-r" : ""));
        h.type = "button"; h.setAttribute("aria-expanded", isOpen ? "true" : "false");
        var chev = el("span", "sb-chev" + (isOpen ? " is-open" : ""));
        chev.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>');
        if (d.fold) {
          h.style.gridTemplateColumns = sbTemplate(nP, true);
          var c1 = el("span", "nm"); c1.appendChild(chev);
          var tw = el("span", "tw"); tw.title = g.name; tw.appendChild(document.createTextNode(g.name));
          tw.appendChild(el("span", "sub", g.n + " people")); c1.appendChild(tw); h.appendChild(c1);
          var c2 = el("span", "mu", g.sub); c2.title = g.sub; h.appendChild(c2);
          g.t.forEach(function (t) { var c = el("span", "cnt"); c.appendChild(el("b", null, String(t[0]))); c.appendChild(document.createTextNode(" of " + t[1])); h.appendChild(c); });
        } else {
          h.appendChild(chev);
          h.appendChild(el("b", null, g.name));
          if (g.sub) h.appendChild(el("span", "mu", g.sub));
          h.appendChild(el("span", "sp"));
          h.appendChild(el("span", "mu", yet + " not done of " + g.n));
        }
        h.addEventListener("click", function () {
          if (d.fold) sb.opened[gk] = !isOpen; else sb.closed[gk] = isOpen;
          var st = scroll.scrollTop; draw(); scroll.scrollTop = st;
        });
        scroll.appendChild(h);
        if (!isOpen && !(searching || (d.fold && f.yet !== "any" && false))) return;
        if (!isOpen) return;
        var cap = d.fold ? SB_CAP_FOLD : SB_CAP;
        function mkRow(r) {
          var row = el("div", "sb-r sb-p"); row.style.gridTemplateColumns = sbTemplate(nP, lmCol);
          var nm = el("span", "nm"); nm.title = r.n;
          nm.appendChild(document.createTextNode(r.n));
          var meta = r.eid + (r.jg ? " · JG " + r.jg : "") + (d.fold && r.dept ? " · " + r.dept : "");
          nm.appendChild(el("span", "sub", meta)); row.appendChild(nm);
          if (lmCol) { var lm = el("span", "mu", r.lm); lm.title = r.lm; row.appendChild(lm); }
          parts.forEach(function (p, i) { row.appendChild(sbCell(p, r.c[i])); });
          return row;
        }
        rows.slice(0, cap).forEach(function (r) { scroll.appendChild(mkRow(r)); });
        if (rows.length > cap) {   // the rest is "N more", a fold; its rows are built the first time it opens
          var more = el("details", "fold sb-fold"), rest = rows.slice(cap);
          more.appendChild(el("summary", "sb-more", rest.length + " more" + (f.yet === "all" || allDone ? "" : " not done")));
          more.addEventListener("toggle", function () {
            if (!more.open || more.getAttribute("data-built")) return;
            more.setAttribute("data-built", "1");
            rest.forEach(function (r) { more.appendChild(mkRow(r)); });
            var less = el("button", "od-linkbtn sb-less", "Show less"); less.type = "button"; less.setAttribute("data-fold-less", "");
            more.appendChild(less);
          });
          scroll.appendChild(more);
        }
      });
      if (!scroll.children.length) {
        scroll.appendChild(el("p", "sb-empty", f.q.trim() ? "Nobody matches that." : (f.yet === "all" ? "Nobody here." : "Nobody is yet to submit. Everyone has done what is open.")));
      }
    }
    draw();
  }
  function sbLM(d) {
    var lm = d.lm, f = sb.lf, parts = lm.parts, nP = parts.length;
    var onTile = function (k) { f.yet = k; draw(); };
    body.appendChild(sbTiles(lm.tiles.map(function (t) { return { key: t.key, name: t.name, done: t.done, n: t.n, pct: t.pct, note: t.note, people: t.people }; }), onTile, "line managers"));
    var ctlHost = el("div", "sb-top"); body.appendChild(ctlHost);
    var quickHost = el("div", "sb-qhost"); body.appendChild(quickHost);
    var box = el("div", "sb-box"); body.appendChild(box);
    var tpl = "minmax(0,1.4fr) minmax(0,.9fr) 5.5rem repeat(" + nP + ",minmax(0,1.3fr))";
    var hd = el("div", "sb-r sb-h"); hd.style.gridTemplateColumns = tpl;
    ["Line manager", "Department", "Team"].concat(parts.map(function (p) { return p.name; })).forEach(function (t) { var s = el("span", null, t); s.title = t; hd.appendChild(s); });
    box.appendChild(hd);
    var scroll = el("div", "sb-scroll"); box.appendChild(scroll);
    body.appendChild(el("p", "sb-foot", "A line manager's row opens their team. Done means moderated or reviewed, never the result. Reminders come from Group People."));
    function pass(r) {
      var q = f.q.trim().toLowerCase();
      if (q && (r.n + " " + r.eid).toLowerCase().indexOf(q) < 0) return false;
      return true;
    }
    function inGroup(r) { return !f.g || r.dept === f.g; }
    function yetOf(r, i) { var c = r.c[i]; return c[1] > 0 && c[0] < c[1]; }
    function want(r) {
      if (f.yet === "all") return true;
      if (f.yet === "any") return r.c.some(function (c, i) { return yetOf(r, i); });
      var ix = parts.map(function (p) { return p.key; }).indexOf(f.yet);
      return ix >= 0 && yetOf(r, ix);
    }
    function mcell(r, i) {
      var c = r.c[i], w = el("span", "sb-c");
      if (!c[1]) w.appendChild(el("span", "sb-na", "–"));
      else if (c[0] >= c[1]) w.appendChild(el("span", "sb-ok", "✓ All " + c[1]));
      else w.appendChild(el("span", "sb-no", c[0] + " of " + c[1]));
      return w;
    }
    function draw() {
      var depts = {}; lm.rows.forEach(function (r) { if (r.dept) depts[r.dept] = 1; });
      var pool = lm.rows.filter(function (r) { return inGroup(r) && pass(r); });
      var cnt = { any: 0, all: pool.length };
      parts.forEach(function (p) { cnt[p.key] = 0; });
      pool.forEach(function (r) { var a = false; parts.forEach(function (p, i) { if (yetOf(r, i)) { cnt[p.key]++; a = true; } }); if (a) cnt.any++; });
      ctlHost.textContent = ""; quickHost.textContent = "";
      sbControls(f, Object.keys(depts).sort().map(function (k) { return [k, k]; }), "Departments", "Find a line manager or Employee ID", function () { draw(); var i = ctlHost.querySelector("input"); if (i) i.focus(); }, ctlHost);
      sbQuick(quickHost, [{ v: "any", t: "Either part", n: cnt.any }].concat(parts.map(function (p) { return { v: p.key, t: p.name, n: cnt[p.key] }; }), [{ v: "all", t: "Everyone", n: cnt.all }]), f, "Yet to finish", draw);
      scroll.textContent = "";
      var rows = pool.filter(want);
      rows.forEach(function (r) {
        var ok = d.key + "|lm|" + r.id, open = !!sb.lm[ok];
        var row = el("button", "sb-r sb-lmr"); row.type = "button"; row.setAttribute("aria-expanded", open ? "true" : "false");
        row.style.gridTemplateColumns = tpl;
        var nm = el("span", "nm"); var chev = el("span", "sb-chev" + (open ? " is-open" : ""));
        chev.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>');
        nm.appendChild(chev); var tw = el("span", "tw"); tw.title = r.n; tw.appendChild(document.createTextNode(r.n)); if (r.eid) tw.appendChild(el("span", "sub", r.eid)); nm.appendChild(tw); row.appendChild(nm);
        var dp = el("span", "mu", r.dept); dp.title = r.dept; row.appendChild(dp);
        row.appendChild(el("span", "mu", r.team + (r.team === 1 ? " person" : " people")));
        parts.forEach(function (p, i) { row.appendChild(mcell(r, i)); });
        row.addEventListener("click", function () { sb.lm[ok] = !open; var st = scroll.scrollTop; draw(); scroll.scrollTop = st; });
        scroll.appendChild(row);
        if (!open) return;
        function mkT(p) {
          var t = el("div", "sb-r sb-t"); t.style.gridTemplateColumns = tpl;
          var n = el("span", "nm", p.n); n.title = p.n; n.appendChild(el("span", "sub", p.eid)); t.appendChild(n);
          t.appendChild(el("span")); t.appendChild(el("span"));
          p.c.forEach(function (c, i) {
            var w = el("span", "sb-c"), part = parts[i];
            var word = part.key === "pm_approve" ? "Moderated " : "Reviewed ";
            if (c[0] === 1) w.appendChild(el("span", "sb-ok", "✓ " + word + c[1]));
            else if (c[0] === 4) { var s = el("span", "sb-na", "– Not submitted by them"); s.title = "They haven't submitted, so there is nothing to " + (part.key === "pm_approve" ? "moderate" : "review") + " yet"; w.appendChild(s); }
            else if (c[0] === 2) w.appendChild(el("span", "sb-lp", "Late pass · " + c[1]));
            else w.appendChild(el("span", "sb-no", part.closed ? "Not done" : "Not yet"));
            t.appendChild(w);
          });
          return t;
        }
        r.people.slice(0, SB_CAP).forEach(function (p) { scroll.appendChild(mkT(p)); });
        if (r.people.length > SB_CAP) {   // "N more" is a fold, its people built the first time it opens
          var more = el("details", "fold sb-fold"), rest = r.people.slice(SB_CAP);
          more.appendChild(el("summary", "sb-more", rest.length + " more"));
          more.addEventListener("toggle", function () {
            if (!more.open || more.getAttribute("data-built")) return;
            more.setAttribute("data-built", "1");
            rest.forEach(function (p) { more.appendChild(mkT(p)); });
            var less = el("button", "od-linkbtn sb-less", "Show less"); less.type = "button"; less.setAttribute("data-fold-less", "");
            more.appendChild(less);
          });
          scroll.appendChild(more);
        }
      });
      if (!rows.length) scroll.appendChild(el("p", "sb-empty", f.q.trim() ? "Nobody matches that." : "Every line manager has finished what is open."));
    }
    draw();
  }

  function openPanel(kind, arg, from) {
    show(from);
    if (kind === "records") { lastListKey = null; showList(arg); }
    else if (kind === "plan") loadPlan(arg);
    else if (kind === "report") loadReport(arg, null);
    else if (kind === "led") loadLed(arg, null);
    else if (kind === "subs") loadSubs(arg || "");
    else if (kind === "learning") loadLearning(/^(explore|catalogue|progress)$/.test(arg || "") ? arg : "plan");
  }

  document.addEventListener("click", function (e) {
    var t = e.target.closest && e.target.closest("[data-panel]");
    if (t && !t.closest("[data-od-drawer]")) {
      e.preventDefault();
      var arg = t.getAttribute("data-arg");
      if (t.getAttribute("data-panel") === "current") { wantTab = arg || null; open("current", t); return; }   // a guide card
      // the Learning panel takes a tab by name (2026-10-20: the card's "Find one" / "Browse"); the others a number
      openPanel(t.getAttribute("data-panel"), /^(learning|subs)$/.test(t.getAttribute("data-panel")) ? arg : (arg ? Number(arg) : null), t);
      return;
    }
    var row = e.target.closest && e.target.closest("[data-record]");
    if (!row) return;
    if (!row.closest("[data-od-drawer]")) { e.preventDefault(); wantTab = row.getAttribute("data-tab") || null; open(row.getAttribute("data-record"), row); }
    else if (mode === "list") { e.preventDefault(); open(row.getAttribute("data-record"), null, true); }
  });
  bClose.addEventListener("click", close);
  scrim.addEventListener("click", close);
  document.addEventListener("keydown", function (e) {
    if (drawer.hidden) return;
    if (e.key === "Escape") {
      if (document.querySelector('.js-dd[aria-expanded="true"]')) return;   // a header menu takes that Escape first
      if (menuOpen) { e.preventDefault(); closeMenu(true); return; }     // ...and the panel's own dropdown
      e.preventDefault(); close(); return;
    }
    if (e.key === "Tab") {   // keep focus inside the panel while it is open
      var f = drawer.querySelectorAll('button:not([disabled]):not([hidden]), a[href], [tabindex="0"]');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === drawer)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // A link to a past half's classic scorecard lands here as /dashboard?record=<cycle> (the classic pages archived as
  // redirects, 2026-10-08): open that cycle's panel. ?panel=plan|report|records|learning (&year= / &cycle=) open the others.
  var q = null;
  try { q = new URLSearchParams(window.location.search); } catch (e) { q = null; }
  var want = q ? q.get("record") : null;
  if (want && (/^\d+$/.test(want) || want === "current")) {
    open(want, document.querySelector('.od-row[data-record="' + want + '"]'));
  } else if (q && q.get("panel") === "subs") {   // Who has submitted: ?panel=subs (&scope=)
    openPanel("subs", q.get("scope") || "", null);
  } else if (q && /^(plan|report|records|led|learning)$/.test(q.get("panel") || "")) {   // learning: from AI+ Learning
    var a2 = /^(plan|records)$/.test(q.get("panel")) ? q.get("year") : q.get("cycle");   // led: ?cycle= too
    if (q.get("panel") === "learning") openPanel("learning", q.get("tab"), null);   // &tab=progress, from the Mine page
    else openPanel(q.get("panel"), a2 && /^\d+$/.test(a2) ? Number(a2) : null, null);
  }

  // A BG CEO's record: pick a business unit and its Talent Box shows (canvas board I: "show the BU first and make them
  // selectable to display on the talent box").
  document.querySelectorAll(".od-box-u[data-unit]").forEach(function (b) {
    b.addEventListener("click", function () {
      var k = b.getAttribute("data-unit");
      document.querySelectorAll(".od-box-u[data-unit]").forEach(function (x) {
        var on = x === b; x.classList.toggle("is-on", on); x.setAttribute("aria-pressed", on ? "true" : "false");
      });
      document.querySelectorAll(".od-box-g[data-unit-box]").forEach(function (g) { g.hidden = g.getAttribute("data-unit-box") !== k; });
    });
  });

  // Between cycles, the last cycle's AI read: written once by the server (AI, else from the figures), then cached.
  var snap = document.querySelector(".od-snap[data-load='1']");
  if (snap) {
    var f4 = new FormData(); f4.append("csrf_token", token());
    fetch(snap.getAttribute("data-snap-url"), { method: "POST", body: f4, credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var t = snap.querySelector(".od-snap-t"), k = snap.querySelector(".od-snap-k");
        if (!j || !j.ok || !j.text) { t.textContent = "Open this cycle's record for the full picture."; return; }
        t.textContent = j.text;
        if (j.source !== "ai") { k.classList.remove("is-ai"); k.textContent = "This cycle at a glance"; }
      })
      .catch(function () { snap.querySelector(".od-snap-t").textContent = "Open this cycle's record for the full picture."; });
  }

  // The history card's trend line: written once by the server (AI, else from the figures), then cached.
  var trend = document.querySelector(".od-trend[data-load='1']");
  if (trend) {
    var f3 = new FormData(); f3.append("csrf_token", token());
    fetch(trend.getAttribute("data-trend-url"), { method: "POST", body: f3, credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok || !j.text) return;
        var tag = trend.querySelector(".od-trend-tag");
        if (j.source === "ai") { tag.classList.add("is-ai"); tag.innerHTML = SPARK; tag.appendChild(document.createTextNode("AI read")); }
        else tag.textContent = "Trend";
        trend.querySelector(".od-trend-txt").textContent = j.text;
        trend.hidden = false;
      })
      .catch(function () {});
  }
})();

/* The Learning card's tabs (AI+ Learning on the dashboard, 2026-10-20): Your department / Your team / Yours. One pane
   shows at a time; the arrow keys move along the tabs, as a tablist's should. */
(function () {
  "use strict";
  function pick(tab, focus) {
    var list = tab.closest(".od-lt-tabs"), card = tab.closest(".od-card");
    if (!list || !card) return;
    list.querySelectorAll("[data-lt-tab]").forEach(function (b) {
      var on = b === tab;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
      var pane = card.querySelector("#" + b.getAttribute("aria-controls"));
      if (pane) pane.hidden = !on;
    });
    // a CEO's card, BU / Own (2026-10-26): its title and the line under it follow the view
    var want = tab.getAttribute("data-lt-tab");
    card.querySelectorAll("[data-lt-for]").forEach(function (n) { n.hidden = n.getAttribute("data-lt-for") !== want; });
    if (focus) tab.focus();
  }
  document.querySelectorAll(".od-lt-tabs").forEach(function (list) {
    list.querySelectorAll("[data-lt-tab]").forEach(function (b, i) { b.tabIndex = i === 0 ? 0 : -1; });
  });
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-lt-tab]");
    if (b) { e.preventDefault(); pick(b, false); }
  });
  document.addEventListener("keydown", function (e) {
    var b = e.target.closest && e.target.closest("[data-lt-tab]");
    if (!b || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
    var all = Array.prototype.slice.call(b.closest(".od-lt-tabs").querySelectorAll("[data-lt-tab]"));
    var i = all.indexOf(b) + (e.key === "ArrowRight" ? 1 : -1);
    e.preventDefault();
    pick(all[(i + all.length) % all.length], true);
  });
})();

/* A BG CEO's business units, while a cycle runs (AI+ Learning on the dashboard, 2026-10-20; Chris: "use the same BU
   table selection to change the view for the talent box and the learning progress"): one pick drives the card, whose
   switch shows that unit's Learning or (where it's on) its Talent Box. */
(function () {
  "use strict";
  var card = document.querySelector(".od-bgl");
  if (!card) return;
  var wrap = card.parentElement, unit = "all", view = "lrn";
  function show() {
    card.querySelectorAll("[data-lpane]").forEach(function (p) { p.hidden = p.getAttribute("data-lpane") !== unit + "|" + view; });
    card.querySelectorAll("[data-lview]").forEach(function (b) {
      var on = b.getAttribute("data-lview") === view;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    card.querySelectorAll("[data-lview-title]").forEach(function (s) { s.hidden = s.getAttribute("data-lview-title") !== view; });
    wrap.querySelectorAll("[data-lview-only]").forEach(function (s) { s.hidden = s.getAttribute("data-lview-only") !== view; });
    wrap.querySelectorAll(".od-lu[data-lunit]").forEach(function (b) {
      var on = b.getAttribute("data-lunit") === unit;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      if (on) { var nm = card.querySelector("[data-lunit-name]"); if (nm) nm.textContent = b.getAttribute("data-lunit-label"); }
    });
  }
  // Your next step's "Show <unit>'s learning" (between cycles): pick that unit and bring the card into view
  document.addEventListener("click", function (e) {
    var go = e.target.closest && e.target.closest("[data-lunit-go]");
    if (!go) return;
    e.preventDefault();
    unit = go.getAttribute("data-lunit-go"); view = "lrn"; show();
    wrap.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  wrap.addEventListener("click", function (e) {
    var u = e.target.closest && e.target.closest(".od-lu[data-lunit]");
    if (u) { e.preventDefault(); unit = u.getAttribute("data-lunit"); show(); return; }
    var v = e.target.closest && e.target.closest("[data-lview]");
    if (v) { e.preventDefault(); view = v.getAttribute("data-lview"); show(); }
  });
})();

// The Executive Chairman's AI insight card (P3, 2026-10-29): the page draws the counted facts in fixed sentences first; when the
// server says the model's words are not cached yet (data-pending) this asks its own POST route once, after the page has drawn,
// and swaps in what comes back (sentences that held the facts, the heading and the stamp). A failure leaves the fixed sentences.
(function () {
  var card = document.querySelector("[data-chair-insight][data-pending]");
  if (!card) return;
  var url = card.getAttribute("data-make-url");
  var tok = (document.querySelector('meta[name="csrf-token"]') || {}).content || "";
  var f = new FormData(); f.append("csrf_token", tok);
  fetch(url, { method: "POST", body: f, credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j || !j.ok || !j.card) return;
      (j.items || []).forEach(function (it) {
        var el = card.querySelector('[data-ins-key="' + it.key + '"] [data-ins-text]');
        if (el) el.textContent = it.text;
      });
      var t = card.querySelector("[data-ins-title]"); if (t) t.textContent = j.card.title;
      var s = card.querySelector("[data-ins-stamp]"); if (s) s.textContent = j.card.stamp;
      card.classList.toggle("is-fixed", !j.card.ai);
      card.setAttribute("data-source", j.card.source);
      card.removeAttribute("data-pending");
    })
    .catch(function () { card.classList.add("is-fixed"); });
})();
