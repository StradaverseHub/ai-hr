/* Admin > Calibration & Talent > Run > Talent Box (Chris, 2026-10-30, canvas board F: "use the design of BGCEO, and also the
 * potential and performance calibration curves"). READ ONLY: the BG CEO's own Talent Box card as the admin reads it.
 *
 * The page (templates/admin_talent_box.html) draws the card's frame, the unit pills, the 3x3 and the foot with the BG CEO's
 * own classes (.rv-tbox-*), from the same builder as the BG CEO's card; this file does what the chat's talentBoxWidget does
 * and nothing else: the Filter line and the curve rows are the SHARED ones (static/calib_shared.js: flLine, calibDistBox,
 * curveDialog -- the BG CEO's own code), and the people panel, the list and Show moved are drawn from the page's one JSON. No
 * Move, no Lock, no insight reads. A filter pick reloads the page with the picks as repeated params (?cc=a&cc=b), as the
 * server's one builder reads them.
 *
 * TALENT BOX ROUND 2 (Chris, 2026-11-14, piece 2; canvas boards A-E, I, J): the same card also draws the actual PAT's strip (its live
 * "as you type" curve and confirm text), a shifted unit's Do Round 2 here / Push to BG CEO, and -- only for the super admin on an
 * 'admin' round (or a pushed one past its lock-by day), D.r2.editable -- the ONE editable card: a per-person Move (a pop-out under the
 * person's button, the BG CEO's own classes; the round's one remark rides on every move, the server adds it), Suggest with AI (read only
 * until Apply all), "+n suggested" on each cell's second row and "AI: -> ME" on each person, all shown only after Suggest with AI is
 * clicked. Every write is the server's one writer (the Round 2 routes, /talent-box/bg/<bg>/move, /talent-box/round2/apply); a move or an
 * apply reloads the page, so the cells, the counts and both curves are the server's own.
 */
(function () {
  "use strict";
  var CAL = window.OneHRCalib, root = document.getElementById("atb"), dataEl = document.getElementById("atb-data");
  if (!CAL || !root || !dataEl) return;
  var D = JSON.parse(dataEl.textContent);
  var pn = window.onehrProper || function (s) { return s; };
  var el = CAL.rmkEl;
  var DASH = "—";
  var FKEYS = ["dept", "cal", "jg", "cc", "branch"];
  var st = { sel: null, hl: false, q: "", dmax: 60, view: "grid", lmax: 100, sort: { k: "box", dir: -1 } };
  var RANK = { "PIP/Improvement": 0, "Solid Core": 1, "Star": 2, "Super Star": 3 }, POT_RANK = { Low: 0, Mid: 1, High: 2 };
  // where a band came from (the chat's TB_SRC): the first record found, highest first
  var SRC = { "super": "Group People’s override", group: "the calibration group", bgceo: "the BG CEO", buceo: "the BU CEO’s calibration",
              hod: "the HOD’s review", lm: "the line manager", self: "their own fill-in", "default": "by default, no record yet",
              top: "the group level" };

  var R = D.r2 || null, ED = !!(R && R.editable), R2 = !!(R && R.n === 2 && R.state !== "none");   // R2: the people's "moved" is since Round 1
  var CSRF = (document.querySelector('meta[name="csrf-token"]') || {}).content || "";
  var MVWHO = R2 ? "since Round 1" : "by the BG CEO";
  var ai = null;   // Suggest with AI's answer, after it is clicked: {moves, byId, byCell, curve, message}
  var mv = null;   // the open Move: {id, tgt, pick, err, saving, el, side, out, key, scr, res}

  function slug(cat) { return String(cat || "").toLowerCase().replace(/[^a-z]+/g, "-"); }
  function initials(name) {
    var w = String(name || "").trim().split(/\s+/).filter(function (x) { return /^[A-Za-z]/.test(x); });
    if (!w.length) return "?";
    return (w[0].charAt(0) + (w.length > 1 ? w[w.length - 1].charAt(0) : "")).toUpperCase();
  }
  function cellOf(key) { return (D.cells || []).filter(function (c) { return c.key === key; })[0] || null; }
  function colOf(key) { return (D.cols || []).filter(function (c) { return c.key === key; })[0] || null; }
  function keyOfPerson(id) {
    var k = null;
    (D.cells || []).forEach(function (c) { (c.people || []).forEach(function (x) { if (x.id === id) k = c.key; }); });
    return k;
  }
  function pctOf(n) { return D.placed ? Math.round(n / D.placed * 100) : 0; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function shortCat(c) { return c === "PIP/Improvement" ? "PIP" : (c || ""); }
  function scopeWords() {   // the same words the BG CEO's card uses for what it is showing
    return CAL.scopeName(D);
  }
  function anyPick() { return !!D.dept || (D.filters || []).some(function (f) { return (f.values || []).length > 0; }); }
  function picksWords() {   // "JG 12-14", "2 cost centres": every pick, in the filter line's order
    return (D.filters || []).map(function (f) { return CAL.pickWords(CAL.chipFromServer(f)); }).filter(Boolean)
      .map(function (w) { return w.indexOf("no ") === 0 ? "No " + w.slice(3) : w; });
  }

  /* ---- the title bar's count line: "unit . picks . PAT n% . N placed . n not placed yet" */
  (function () {
    var c = document.getElementById("atb-count");
    if (!c) return;
    c.textContent = (D.company_label || "Whole BG") + (D.dept ? " · " + pn(D.dept) : "") + CAL.xWords(D) + " · " + CAL.patWords(D.pat)
      + " · " + D.placed + " placed" + ((D.unplaced || []).length ? " · " + D.unplaced.length + " not placed yet" : "");
    c.title = c.textContent;   // the line may end in "…" beside the two toggles: the whole of it on hover
  })();

  /* ---- the BU row: paged with < > when the pills do not all fit (the chat's syncNav) */
  (function () {
    var brow = document.getElementById("atb-busrow"); if (!brow) return;
    var pills = brow.querySelector(".rv-tbox-bus"), prev = brow.querySelector(".is-prev"), next = brow.querySelector(".is-next");
    var sync = function () {
      var max = pills.scrollWidth - pills.clientWidth;
      brow.classList.toggle("is-overflow", max > 2);
      prev.disabled = pills.scrollLeft <= 2; next.disabled = pills.scrollLeft >= max - 2;
    };
    [prev, next].forEach(function (b) {
      b.addEventListener("click", function () {
        pills.scrollBy({ left: (b === prev ? -1 : 1) * Math.max(120, Math.round(pills.clientWidth * 0.7)), behavior: "smooth" });
      });
    });
    pills.addEventListener("scroll", sync, { passive: true });
    setTimeout(function () {
      sync();
      var on = pills.querySelector(".rv-tbox-bu.is-on");
      if (on && (on.offsetLeft < pills.scrollLeft || on.offsetLeft + on.offsetWidth > pills.scrollLeft + pills.clientWidth)) {
        pills.scrollLeft = Math.max(0, on.offsetLeft - (pills.clientWidth - on.offsetWidth) / 2);
      }
      sync();
    }, 0);
    if (window.ResizeObserver) new ResizeObserver(sync).observe(pills);
  })();

  /* ---- the Filter line: the shared chips; a pick reloads the page with every value as a repeated param */
  (function () {
    var box = document.getElementById("atb-filter"); if (!box) return;
    var chips = (D.filters || []).map(CAL.chipFromServer);
    if (!chips.length) { box.hidden = true; return; }   // nothing to choose between: no strip, as on the BG CEO's card
    var reload = function (mut) {
      var u = new URL(window.location.href);
      mut(u.searchParams);
      window.keepPlace && window.keepPlace();
      window.location.href = u.pathname + (u.searchParams.toString() ? "?" + u.searchParams.toString() : "");
    };
    box.appendChild(CAL.flLine({
      live: false,   // a pick reloads the page, so the list hands its ticks on when it closes (a live tick would close it)
      chips: chips, picked: chips.some(function (c) { return c.values.length > 0; }),
      showN: D.show_n != null ? D.show_n : 0, showM: D.show_m != null ? D.show_m : 0,
      onPick: function (key, vals) {
        reload(function (q) { q.delete(key); vals.forEach(function (v) { q.append(key, v); }); });
      },
      onClear: function () { reload(function (q) { FKEYS.forEach(function (k) { q.delete(k); }); }); }
    }));
  })();

  /* ---- the 3x3: a box picked lists its people in the panel beside it; Show moved lists everyone moved */
  var body = document.getElementById("atb-body"), drawer = document.getElementById("atb-drawer"), listwrap = document.getElementById("atb-list");
  var cells = [].slice.call(document.querySelectorAll("#atb-grid .rv-tbox-cell[data-key]"));
  function movedGroup() {
    var boxes = (D.cells || []).filter(function (c) { return (c.people || []).some(function (p) { return p.moved; }); }), ppl = [];
    boxes.forEach(function (c) { (c.people || []).forEach(function (p) { if (p.moved) ppl.push(p); }); });
    ppl.sort(function (a, b) { return String(a.name || "").localeCompare(String(b.name || "")); });
    return { label: "Moved", n: ppl.length, people: ppl, boxes: boxes, moved: true };
  }
  function paintMarks() {
    cells.forEach(function (c) {
      var k = c.getAttribute("data-key"), cell = cellOf(k), on = !st.hl && k === st.sel;
      c.classList.toggle("is-on", on); c.setAttribute("aria-pressed", on ? "true" : "false");
      c.classList.toggle("is-dim", st.hl && !!cell && !cell.moved);
      c.classList.toggle("is-faded", !st.hl && !!st.sel && k !== st.sel);
    });
  }
  cells.forEach(function (c) {
    c.addEventListener("click", function () {
      st.sel = c.getAttribute("data-key"); st.hl = false; st.q = ""; st.dmax = 60;
      var mvb = document.getElementById("atb-moved"); if (mvb) mvb.setAttribute("aria-pressed", "false");
      try { window.sessionStorage.setItem("onehr.atb.sel", st.sel); } catch (e) { /* private window */ }
      paintMarks(); paintDrawer();
    });
  });
  function defaultBox() {   // the top box when anyone is in it, else the first box with people
    var top = cellOf("high|High");
    if (top && top.n) return top.key;
    var hit = (D.cells || []).filter(function (c) { return c.n; })[0];
    return hit ? hit.key : "high|High";
  }

  /* ---- the people panel */
  function boxWhere(key) {
    var k = String(key || "").split("|"), col = colOf(k[0]);
    return k.length < 2 ? "" : k[1] + " potential · " + (col ? col.label : k[0]) + " performance";
  }
  function moveFromTo(p) {   // "Moved from X to Y", both ends by their category, the axis that changed where the names match
    if (!p || !p.moved || !p.from_cat) return null;
    var toKey = keyOfPerson(p.id), toCell = toKey ? cellOf(toKey) : null, to = (toCell && toCell.label) || p.category || "";
    var fk = String(p.from_key || "").split("|"), tk = String(toKey || "").split("|");
    var same = !!to && to === p.from_cat && fk.length === 2 && tk.length === 2;
    var at = function (k) {
      if (!same) return "";
      var parts = [];
      if (fk[1] !== tk[1]) parts.push(k[1] + " potential");
      if (fk[0] !== tk[0]) { var c = colOf(k[0]); parts.push((c ? c.label : k[0]) + " performance"); }
      return parts.length ? " (" + parts.join(" · ") + ")" : "";
    };
    var who = R2 ? "Moved since Round 1" : "The BG CEO moved them";
    return {
      text: R2 ? "was " + p.from_cat + at(fk) : (p.up ? "↑" : "↓") + " Moved from " + p.from_cat + at(fk) + (to ? " to " + to + at(tk) : ""),
      title: who + ": from " + p.from_cat + (p.from_key ? " (" + boxWhere(p.from_key) + ")" : "")
        + (to ? " to " + to + (toKey ? " (" + boxWhere(toKey) + ")" : "") : "") + "."
    };
  }
  function defaultText(p) {
    var a = [];
    if (p.perf_src === "default") a.push((p.perf || "UA") + " by default");
    if (p.pot_src === "default") a.push((p.pot || "Low") + " by default");
    return a.length ? a.join(", ") + " — no record yet" : "";
  }
  function bandsTitle(p) {
    return "Performance " + (p.perf || DASH) + " — " + (SRC[p.perf_src] || p.perf_src || "") + "\nPotential " + (p.pot || DASH)
      + " — " + (SRC[p.pot_src] || p.pot_src || "");
  }
  // "No KPI lines" / "No 360" / "No KPI \u00b7 No 360" (2026-11-02): amber; on a panel row it takes the place of the default words
  function nodataEl(kind) {
    var kw = { both: "No KPI \u00b7 No 360", kpi: "No KPI lines", "360": "No 360" };
    var tk = "Taking part this cycle with no KPI lines, so no performance figure: set their performance band yourself";
    var t3 = "Taking part this cycle with no 360 panel, so no potential score: set their potential band yourself";
    var nd = el("span", "rv-cal-notetag rv-newconf rv-nodata", kw[kind] || "");
    nd.title = kind === "both" ? tk + ". " + t3 : kind === "kpi" ? tk : t3;
    return nd;
  }
  function tags(p, into) {   // the small grey tags a row can carry
    if (p.newly) {
      var n = el("span", "rv-cal-notetag rv-newconf", "Newly confirmed");
      n.title = "Added to this cycle on confirming, with a Confirmation rating Group People rated on their behalf"; into.appendChild(n);
    }
    if (p.behalf_lm) {
      var b = el("span", "rv-cal-notetag rv-behalf-lm", "LM, on their behalf");
      b.title = "They didn't submit by their deadline, so their line manager assessed them on their behalf: the figures, "
        + "levels and remark are the line manager's"; into.appendChild(b);
    }
    if (p.transfer) {   // Transferred (2026-11-03): the same pill, the hover and the screen reader say who and the figures
      var tr = el("span", "rv-cal-notetag rv-newconf rv-transfer", "Transferred"); tr.title = p.transfer;
      tr.appendChild(el("span", "rv-sr", String(p.transfer).replace(/^Transferred/, ""))); into.appendChild(tr);
    }
    if (p.bugrp) { var g = el("span", "rv-cal-notetag rv-newconf rv-tbox-bytag", p.bugrp.by || "Group"); g.title = p.bugrp.by_title || ""; into.appendChild(g); }
  }
  function nameLink(p) {
    var a = el("a", "rv-tbox-pname", p.name); a.href = p.url; a.title = "Open " + p.name + "’s page: the bands’ trail";
    return a;
  }
  function personRow(p) {
    var row = el("div", "rv-tbox-prow");
    var av = el("span", "rv-tbox-av", initials(p.name)); av.setAttribute("aria-hidden", "true"); row.appendChild(av);
    var who = el("span", "rv-tbox-who"), line = el("span", "rv-tbox-pline");
    line.appendChild(nameLink(p)); who.appendChild(line);
    var sub = el("span", "rv-tbox-psub"), bands = el("span", "rv-tbox-bands");
    bands.appendChild(el("span", p.perf_src === "default" ? "rv-tbox-dflt" : null, p.perf || DASH));
    bands.appendChild(document.createTextNode(" · "));
    bands.appendChild(el("span", p.pot_src === "default" ? "rv-tbox-dflt" : null, p.pot || DASH));
    bands.title = bandsTitle(p); sub.appendChild(bands);
    tags(p, sub);
    var where = [p.bu || p.company, pn(p.dept)].filter(Boolean).join(" · ");
    if (where) { var w = el("span", "rv-tbox-where", where); w.title = where; sub.appendChild(w); }
    who.appendChild(sub);
    var mft = moveFromTo(p);
    if (mft) { var mt = el("span", "rv-tbox-ptag", mft.text); mt.title = mft.title; who.appendChild(mt); }
    var sg = ai && ai.byId[p.id];   // Suggest with AI's mark, only once it is clicked: "AI: → ME"
    if (sg) { var sgt = el("span", "atb-sugg", "AI: → " + sg.to); sgt.title = "AI+ would move them from " + sg.from + " to " + sg.to + (sg.why ? ": " + sg.why : ""); who.appendChild(sgt); }
    var dt = defaultText(p);
    if (p.nodata) who.appendChild(nodataEl(p.nodata));   // in place of the default words
    else if (dt) who.appendChild(el("span", "rv-tbox-ptag is-default", dt));
    row.appendChild(who);
    var acts = el("span", "rv-tbox-acts");   // no Move here: the BG CEO places; an admin reads (but an admin Round 2 for the super admin, below). The arrow opens their page.
    if (ED) acts.appendChild(moveBtn(p));
    var op = el("a", "rv-tbox-open", "›"); op.href = p.url; op.setAttribute("aria-label", "Open " + p.name + "’s page");
    op.title = "Open their page"; acts.appendChild(op); row.appendChild(acts);
    return row;
  }
  function matches(p, q) { return !q || [p.name, p.bu, p.company, p.dept, p.grade].join(" ").toLowerCase().indexOf(q) >= 0; }
  function paintPeople(cell, list) {
    list.innerHTML = "";
    var q = (st.q || "").trim().toLowerCase(), ppl = (cell.people || []).filter(function (p) { return matches(p, q); });
    var noun = cell.moved ? "the people moved " + MVWHO : "this box";
    if (!ppl.length) {
      list.appendChild(el("p", "rv-tbox-none", cell.moved ? (q ? "No one moved matches that." : R2 ? "No one has moved since Round 1." : "The BG CEO hasn’t moved anyone here yet.")
        : q ? "No one in " + noun + " matches that." : "No one is in " + noun + "."));
      return;
    }
    var max = st.dmax || 60;
    ppl.slice(0, max).forEach(function (p) { list.appendChild(personRow(p)); });
    if (ppl.length > max) {
      var more = el("button", "rv-cal-link rv-tbox-showmore", "Show " + Math.min(60, ppl.length - max) + " more"); more.type = "button";
      more.addEventListener("click", function () { st.dmax = max + 60; paintPeople(cell, list); });
      list.appendChild(more);
    }
    if (max > 60) {
      var less = el("button", "fold-less", "Show less"); less.type = "button";
      less.addEventListener("click", function () { st.dmax = 60; paintPeople(cell, list); });
      list.appendChild(less);
    }
    if (mv) syncMove();   // an open Move follows its person's new row
  }
  function search(label, value, onInput) {
    var l = el("label", "rv-tbox-search"), ic = el("span", "rv-tbox-sico");
    ic.innerHTML = '<svg class="rv-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/></svg>';
    l.appendChild(ic);
    var i = document.createElement("input"); i.type = "search"; i.placeholder = label; i.value = value || ""; i.setAttribute("aria-label", label);
    i.addEventListener("input", function () { onInput(i.value); });
    l.appendChild(i);
    return l;
  }
  function paintDrawer() {
    if (!drawer) return;
    drawer.innerHTML = "";
    var cell = st.hl ? movedGroup() : cellOf(st.sel);
    if (!cell) { drawer.appendChild(el("p", "rv-tbox-none", "Pick a box to see who is in it.")); return; }
    var hd = el("div", "rv-tbox-dhead"), top = el("div", "rv-tbox-dtop");
    var pill = el("span", "rv-tbox-dpill", cell.label || ""); pill.setAttribute("data-cat", slug(cell.label)); top.appendChild(pill);
    top.appendChild(el("span", "rv-tbox-dn", plural(cell.n, "person", "people") + " · " + pctOf(cell.n) + "% of " + scopeWords()));
    hd.appendChild(top);
    var one = cell.boxes ? (cell.boxes.length === 1 ? cell.boxes[0] : null) : cell, col = one ? colOf(one.col) : null;
    hd.appendChild(el("h4", "rv-tbox-dtitle", cell.moved ? (R2 ? "Everyone moved since Round 1" : "Everyone the BG CEO moved")
      + (cell.boxes.length > 1 ? " · across " + cell.boxes.length + " boxes" : cell.boxes.length ? " · in one box" : "")
      : one.pot + " potential · " + (col ? col.label + " performance (" + col.bands.join(" · ") + ")" : "")));
    var list = el("div", "rv-tbox-plist");
    if (cell.n > 6) hd.appendChild(search("Find a name, BU or department", st.q, function (v) { st.q = v; st.dmax = 60; paintPeople(cell, list); }));
    drawer.appendChild(hd); drawer.appendChild(list);
    paintPeople(cell, list);
  }

  /* ---- Show moved: lights the boxes holding anyone the BG CEO moved, lists them, narrows the list view */
  var movedBtn = document.getElementById("atb-moved");
  if (movedBtn) movedBtn.addEventListener("click", function () {
    st.hl = !st.hl; st.q = ""; st.dmax = 60; st.lmax = 100;
    movedBtn.setAttribute("aria-pressed", st.hl ? "true" : "false");
    paintMarks(); paintDrawer(); if (st.view === "list") paintList();
  });

  /* ---- the List view: everyone in the scope, sortable by a heading (the Filter line is the filter) */
  var LCOLS = [["name", "Name"], ["dept", "Department"], ["grade", "Grade"], ["perf", "Performance"], ["pot", "Potential"], ["box", "Box"]];
  function lAll() {
    var all = [];
    (D.cells || []).forEach(function (c) { (c.people || []).forEach(function (p) { all.push({ p: p, cell: c }); }); });
    return all;
  }
  function sortVal(x, k) {
    var p = x.p;
    if (k === "grade") return p.grade == null ? "" : String(p.grade);
    if (k === "perf") return (D.band_order || []).indexOf(p.perf);
    if (k === "pot") return POT_RANK[p.pot] == null ? -1 : POT_RANK[p.pot];
    if (k === "box") return (RANK[x.cell.label] || 0) * 100 + (POT_RANK[x.cell.pot] || 0) * 10 + ["low", "mid", "high"].indexOf(x.cell.col);
    if (k === "dept") return String(p.dept || "").toLowerCase();
    return String(p.name || "").toLowerCase();
  }
  function bandTd(p, ax) {
    var perf = ax === "perf", band = perf ? p.perf : p.pot, src = perf ? p.perf_src : p.pot_src;
    var td = el("td", "rv-tbox-tdband"), w = el("span", "rv-tbox-bandw");
    var pill = el("span", "rv-tbox-band" + (src === "default" ? " is-default" : ""), band || DASH);
    pill.title = (band || DASH) + (perf && band && D.label_names && D.label_names[band] ? " (" + D.label_names[band] + ")" : "") + " — " + (SRC[src] || src || "");
    w.appendChild(pill); td.appendChild(w);
    return td;
  }
  function paintList() {
    if (!listwrap) return;
    listwrap.innerHTML = "";
    var bar = el("div", "rv-tbox-lbar"), cnt = el("span", "rv-tbox-lcount", ""); bar.appendChild(cnt); listwrap.appendChild(bar);
    var sc = el("div", "rv-tbox-lscroll"), tbl = el("table", "rv-tbox-table"), cg = el("colgroup");
    var cols = ED ? LCOLS.concat([["act", ""]]) : LCOLS;   // an admin Round 2 adds a Move column at the right
    cols.forEach(function (c) { cg.appendChild(el("col", "rv-tbox-col-" + c[0])); });
    tbl.appendChild(cg);
    var thead = el("thead"), hr = el("tr");
    cols.forEach(function (c) {
      var th = el("th", "rv-tbox-th-" + c[0]); th.scope = "col";
      if (c[0] === "act") { th.appendChild(el("span", "rv-sr", "Move")); hr.appendChild(th); return; }
      var on = st.sort.k === c[0];
      th.setAttribute("aria-sort", on ? (st.sort.dir > 0 ? "ascending" : "descending") : "none");
      var b = el("button", "col-menu-btn" + (on ? (st.sort.dir > 0 ? " sort-asc" : " sort-desc") : "")); b.type = "button";
      b.setAttribute("data-col", c[0]); b.setAttribute("aria-label", "Sort by " + c[1].toLowerCase());
      b.appendChild(el("span", "cm-label", c[1])); b.appendChild(el("span", "cm-caret"));
      b.addEventListener("click", function () {
        st.sort = { k: c[0], dir: st.sort.k === c[0] ? -st.sort.dir : 1 }; paintList();
        var nb = listwrap.querySelector('.col-menu-btn[data-col="' + c[0] + '"]'); if (nb) nb.focus({ preventScroll: true });
      });
      th.appendChild(b); hr.appendChild(th);
    });
    thead.appendChild(hr); tbl.appendChild(thead);
    var tbody = el("tbody"), all = lAll(), rows = all.filter(function (x) { return !st.hl || x.p.moved; });
    rows.sort(function (a, b) {
      var va = sortVal(a, st.sort.k), vb = sortVal(b, st.sort.k), r;
      if (typeof va === "number" && typeof vb === "number") r = (va - vb) * st.sort.dir;
      else if (va === "" || vb === "") r = va === vb ? 0 : va === "" ? 1 : -1;   // blanks last either way
      else r = String(va).localeCompare(String(vb), undefined, { numeric: true }) * st.sort.dir;
      return r || String(a.p.name).localeCompare(String(b.p.name));
    });
    cnt.textContent = rows.length === all.length ? plural(all.length, "person", "people") : rows.length + " of " + all.length + " people";
    if (!rows.length) {
      var tr0 = el("tr"), td0 = el("td", "rv-tbox-none", "No one is here."); td0.colSpan = cols.length; tr0.appendChild(td0); tbody.appendChild(tr0);
    }
    var max = st.lmax || 100;
    rows.slice(0, max).forEach(function (x) {
      var p = x.p, tr = el("tr"), tdn = el("td", "rv-tbox-tdname"), ln = el("span", "rv-tbox-pline");
      ln.appendChild(nameLink(p)); tdn.appendChild(ln); tr.appendChild(tdn);
      var tdd = el("td", "rv-tbox-tddept", pn(p.dept) || DASH); if (p.dept) tdd.title = pn(p.dept); tr.appendChild(tdd);
      tr.appendChild(el("td", "rv-tbox-tdgrade", p.grade == null || p.grade === "" ? DASH : String(p.grade)));
      tr.appendChild(bandTd(p, "perf")); tr.appendChild(bandTd(p, "pot"));
      var tdb = el("td"), bx = el("span", "rv-tbox-boxc"), gl = el("span", "rv-tbox-glyph"); gl.setAttribute("aria-hidden", "true");
      ["High", "Mid", "Low"].forEach(function (pt) { ["low", "mid", "high"].forEach(function (cl) {
        gl.appendChild(el("i", x.cell.key === cl + "|" + pt ? "is-on" : null)); }); });
      bx.appendChild(gl);
      var bc = el("span", "rv-tbox-boxcat", shortCat(x.cell.label)); bc.setAttribute("data-cat", slug(x.cell.label)); bx.appendChild(bc);
      bx.title = (x.cell.label || "") + ": " + x.cell.pot + " potential, " + ((colOf(x.cell.col) || {}).label || "") + " performance";
      tdb.appendChild(bx);
      var mft = moveFromTo(p);
      if (mft) { var fr = el("div", "rv-tbox-boxfrom", R2 ? "was " + shortCat(p.from_cat) : (p.up ? "↑" : "↓") + " from " + shortCat(p.from_cat)); fr.title = mft.title; tdb.appendChild(fr); }
      var sgl = ai && ai.byId[p.id];
      if (sgl) { var sgx = el("div", "atb-sugg is-list", "AI: → " + sgl.to); sgx.title = "AI+ would move them from " + sgl.from + " to " + sgl.to; tdb.appendChild(sgx); }
      tr.appendChild(tdb);
      if (ED) { var tda = el("td", "rv-tbox-tdact"); tda.appendChild(moveBtn(p)); tr.appendChild(tda); }
      tbody.appendChild(tr);
    });
    if (rows.length > max) {
      var trm = el("tr"), tdm = el("td"); tdm.colSpan = cols.length;
      var more = el("button", "rv-cal-link rv-tbox-showmore", "Show " + Math.min(100, rows.length - max) + " more"); more.type = "button";
      more.addEventListener("click", function () { st.lmax = max + 100; paintList(); });
      tdm.appendChild(more); trm.appendChild(tdm); tbody.appendChild(trm);
    }
    tbl.appendChild(tbody); sc.appendChild(tbl); listwrap.appendChild(sc);
    if (mv) syncMove();
  }

  /* ---- Grid | List: the viewer's last pick, in this browser only (the BG CEO's own key) */
  function setView(v) {
    st.view = v === "list" ? "list" : "grid";
    body.classList.toggle("is-grid", st.view === "grid"); body.classList.toggle("is-list", st.view === "list");
    document.getElementById("atb-grid").hidden = st.view !== "grid"; drawer.hidden = st.view !== "grid"; listwrap.hidden = st.view !== "list";
    [].forEach.call(root.querySelectorAll(".rv-tbox-view[data-view]"), function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-view") === st.view ? "true" : "false");
    });
    if (st.view === "list") paintList();
  }
  [].forEach.call(root.querySelectorAll(".rv-tbox-view[data-view]"), function (b) {
    b.addEventListener("click", function () {
      var v = b.getAttribute("data-view");
      if (v === st.view) return;
      try { window.localStorage.setItem("onehr.tbox.view", v); } catch (e) { /* private window: this visit only */ }
      setView(v);
    });
  });

  /* ---- the axes: each title opens its distribution curve, the BG CEO's own dialog */
  [].forEach.call(root.querySelectorAll(".rv-tbox-axbtn[data-axis]"), function (b) {
    var perf = b.getAttribute("data-axis") === "perf", cv = perf ? D.perf_curve : D.pot_curve;
    if (!cv) { b.disabled = true; return; }
    b.addEventListener("click", function () {
      CAL.curveDialog(perf ? "Performance" : "Potential", cv, anyPick() ? scopeWords() : (D.company_label || ""), b, { byBreach: true });
    });
  });

  /* ---- both curves, always in view below the card: the BG CEO's rows, following the picks */
  function curveCard(id, cv, name) {
    var host = document.getElementById("atb-curve-" + id), sub = document.getElementById("atb-curve-" + id + "-s");
    if (!host || !cv) return;
    var picks = picksWords(), c = cv.curve || {};
    var pat = "entered" in c ? " · " + (c.entered && c.pct != null ? CAL.patWords(c.pct) : "PAT not entered") : "";
    if (sub) sub.textContent = plural(cv.total, "person", "people") + (picks.length ? " (" + picks.join(" · ") + ")" : "")
      + " against the expected spread" + (c.label ? " (" + c.label + ")" : "") + pat;
    host.appendChild(CAL.calibDistBox(cv, { compact: true, noVerdict: true, byBreach: true, heading: name + " distribution" }));
  }
  curveCard("perf", D.perf_curve, "Performance");
  curveCard("pot", D.pot_curve, "Potential");

  /* ---- Round 2: the strip, the foot, the Move, Suggest with AI */
  /* ---- Round 2's actual PAT: the curve its figure picks as you type, and the confirm box's words (canvas boards B, J) */
  (function () {
    var f = document.getElementById("atb-actual"); if (!f) return;
    var inp = f.querySelector('input[name="actual_pct"]'), say = document.getElementById("atb-live"), save = document.getElementById("atb-actual-save");
    var before = f.getAttribute("data-before") || "", fc = f.getAttribute("data-forecast") || "";
    var cuts = (f.getAttribute("data-cuts") || "70,130").split(",").map(Number);
    var NAMES = { negative: ["Negatively skewed", "under " + cuts[0] + "%"], normal: ["Normal", cuts[0] + " to " + cuts[1] + "%"],
                  positive: ["Positively skewed", "over " + cuts[1] + "%"] };
    var base = f.getAttribute("data-confirm"), hint = say ? say.textContent : "";
    function keyOf(v) { return v < cuts[0] ? "negative" : v > cuts[1] ? "positive" : "normal"; }
    function paint() {
      var raw = inp.value.trim(), v = raw === "" ? NaN : Number(raw), ok = isFinite(v) && v >= 0;
      if (save) save.disabled = !ok;
      if (!say) return;
      say.textContent = "";
      if (!ok) { say.textContent = hint; f.setAttribute("data-confirm", base); return; }
      var nm = NAMES[keyOf(v)], shifts = nm[0] !== before, shown = String(Math.round(v * 100) / 100);
      say.appendChild(document.createTextNode("As you type: "));
      say.appendChild(el("b", null, nm[0]));
      say.appendChild(document.createTextNode(" (" + nm[1] + "). "));
      say.appendChild(el("span", "atb-tag " + (shifts ? "is-warn" : "is-ok"), shifts ? "Curve shifts" : "Same curve"));
      f.setAttribute("data-confirm", "Forecast " + fc + " (" + before + ") → actual " + shown + "% (" + nm[0] + "). "
        + (shifts ? "The curve shifts. " : "The curve stays the same: Round 1 stands. ") + "Nothing in the box moves yet.");
    }
    inp.addEventListener("input", paint); paint();
  })();
  [].forEach.call(root.querySelectorAll("[data-atb-change]"), function (b) {   // a typo in the actual PAT, before Round 2 opens
    b.addEventListener("click", function () {
      var f = document.getElementById("atb-actual"); if (!f) return;
      f.hidden = !f.hidden; b.setAttribute("aria-expanded", f.hidden ? "false" : "true");
      if (!f.hidden) { var i = f.querySelector("input"); if (i) i.focus(); }
    });
  });
  (function () {   // Push to BG CEO: the lock-by day goes into the confirm box's words
    var f = document.getElementById("atb-push"); if (!f) return;
    var d = f.querySelector('input[name="due_on"]'), base = f.getAttribute("data-confirm") || "";
    var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    function words(iso) {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ""); if (!m) return "";
      return DAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()] + " " + (+m[3]) + " " + MON[+m[2] - 1] + " " + m[1];
    }
    function sync() { f.setAttribute("data-confirm", base + (d.value ? " Lock by " + words(d.value) + "." : "")); }
    d.addEventListener("input", sync); d.addEventListener("change", sync); sync();
  })();

  /* ---- where the unit stands against the expected curve: the waiting strip's words and each column foot's gap (canvas board C) */
  function curveGaps() {   // [{col, n, exp, d}] per column against the curve the PAT picks, or null when there is none
    var t = D.perf_curve && D.perf_curve.target; if (!t || !D.placed) return null;
    return (D.cols || []).map(function (c) {
      var exp = D.placed * (c.bands || []).reduce(function (a, b) { return a + (t[b] || 0); }, 0) / 100;
      return { col: c, exp: exp, d: Math.round(c.n - exp) };
    });
  }
  (function () {
    var g = document.getElementById("atb-gap-s"), gaps = curveGaps();
    if (g && gaps && !anyPick()) {
      var parts = [];
      gaps.forEach(function (x) { if (x.d > 0) parts.push(x.d + " too many " + x.col.label); else if (x.d < 0) parts.push(-x.d + " too few " + x.col.label); });
      if (parts.length) g.textContent = "Round 1 sits outside the new curve: " + parts.join(", ") + ".";
    }
    if (R2 && R.state !== "same" && gaps) {
      var feet = [].slice.call(root.querySelectorAll(".rv-tbox-colf .rv-tbox-axn"));
      gaps.forEach(function (x, i) {
        var f = feet[i]; if (!f) return;
        var sp = el("span", "atb-vs " + (x.d === 0 ? "is-good" : "is-bad"),
          " · " + (x.d === 0 ? "on curve" : x.d > 0 ? x.d + " more than the new curve" : -x.d + " fewer than the new curve"));
        f.appendChild(sp);
      });
    }
  })();

  /* ---- Move (an admin Round 2 only): the BG CEO's pop-out, drawn with its classes; the round's one remark rides on the move
     (the server adds it: the form names the round). Saved, the page reloads, so every count and curve is the server's. */
  function limState(cat) { return (R && R.limits && R.limits.full && R.limits.full[cat]) || ""; }
  function limFull(p, cat) { return !!limState(cat) && p.category !== cat; }
  function moveBtn(p) {
    var b = el("button", "rv-tbox-mvbtn", "Move"); b.type = "button";
    b.setAttribute("data-move", String(p.id)); b.setAttribute("aria-haspopup", "dialog"); b.setAttribute("aria-label", "Move " + p.name);
    b.setAttribute("aria-expanded", mv && mv.id === p.id ? "true" : "false");
    if (mv && mv.id === p.id) b.classList.add("is-open");
    b.addEventListener("click", function () { if (mv && mv.id === p.id) endMove(true); else startMove(p); });
    return b;
  }
  function mvBtnOf(id) { return id != null ? root.querySelector('.rv-tbox-mvbtn[data-move="' + id + '"]') : null; }
  function markMoving(id, on) {
    var b = mvBtnOf(id); if (!b) return;
    b.setAttribute("aria-expanded", on ? "true" : "false"); b.classList.toggle("is-open", !!on);
    var row = b.closest("tr, .rv-tbox-prow"); if (row) row.classList.toggle("is-moving", !!on);
  }
  function personById(id) {
    var hit = null;
    (D.cells || []).forEach(function (c) { (c.people || []).forEach(function (x) { if (x.id === id) hit = x; }); });
    return hit;
  }
  function startMove(p) {
    if (mv) endMove(false);
    var m = { id: p.id, tgt: null, pick: null, err: "", saving: false };
    mv = m;
    var pop = el("div", "rv-tbox-mvpop notranslate"); pop.setAttribute("translate", "no"); pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Move " + p.name);
    pop.appendChild(movePanel(p));
    document.body.appendChild(pop); m.el = pop;
    m.out = function (e) {
      if (pop.contains(e.target)) return;
      var b = mvBtnOf(m.id); if (b && b.contains(e.target)) return;   // its own button toggles it
      if (!m.saving) endMove(false);
    };
    m.key = function (e) { if (e.key === "Escape" && !m.saving) { e.preventDefault(); e.stopPropagation(); endMove(true); } };
    m.scr = placeMove; m.res = placeMove;
    document.addEventListener("mousedown", m.out, true); document.addEventListener("keydown", m.key, true);
    window.addEventListener("scroll", m.scr, true); window.addEventListener("resize", m.res);
    markMoving(p.id, true); placeMove();
    var first = pop.querySelector(".rv-tbox-pk:not(.is-now):not(:disabled)"); if (first) first.focus({ preventScroll: true });
  }
  function endMove(refocus) {
    var m = mv; if (!m) return;
    mv = null;
    if (m.el && m.el.parentNode) m.el.parentNode.removeChild(m.el);
    document.removeEventListener("mousedown", m.out, true); document.removeEventListener("keydown", m.key, true);
    window.removeEventListener("scroll", m.scr, true); window.removeEventListener("resize", m.res);
    markMoving(m.id, false);
    var b = refocus !== false ? mvBtnOf(m.id) : null; if (b) b.focus({ preventScroll: true });
  }
  function syncMove() {   // after the panel or the list redraws: an open Move follows its new button, or closes when its row is gone
    if (!mv) return;
    if (!mvBtnOf(mv.id)) { endMove(false); return; }
    markMoving(mv.id, true); placeMove();
  }
  function placeMove() {   // under its button, right edges aligned; above it when there is no room (picked once, so it never flips under the mouse)
    if (!mv) return;
    var b = mvBtnOf(mv.id); if (!b) { endMove(false); return; }
    var br = b.getBoundingClientRect(), clips = [b.closest(".rv-tbox-lscroll"), b.closest(".rv-tbox-plist")];
    for (var i = 0; i < clips.length; i++) {
      if (!clips[i]) continue;
      var cr = clips[i].getBoundingClientRect();
      if (br.bottom < cr.top + 4 || br.top > cr.bottom - 4) { endMove(false); return; }
    }
    var pop = mv.el, inner = pop.querySelector(".rv-tbox-move"), w = pop.offsetWidth;
    var vw = document.documentElement.clientWidth, vh = window.innerHeight, below = vh - br.bottom - 16, above = br.top - 16;
    if (!mv.side) {
      var need = pop.offsetHeight + (mv.tgt ? 0 : 130);
      mv.side = need <= below ? "down" : need <= above ? "up" : (above > below ? "up" : "down");
    }
    var up = mv.side === "up";
    pop.classList.toggle("is-up", up);
    if (inner) inner.style.maxHeight = Math.max(160, up ? above : below) + "px";
    var h = pop.offsetHeight, left = Math.max(8, Math.min(br.right - w, vw - w - 8)), top = up ? Math.max(8, br.top - 8 - h) : br.bottom + 8;
    pop.style.left = Math.round(left) + "px"; pop.style.top = Math.round(top) + "px";
    pop.style.setProperty("--tb-caret", Math.round(Math.min(Math.max(br.left + br.width / 2 - left, 18), w - 18)) + "px");
  }
  function repaintMove(focusSel) {
    var p = mv ? personById(mv.id) : null, old = mv && mv.el.querySelector(".rv-tbox-move");
    if (!old || !p) return;
    var fresh = movePanel(p); old.parentNode.replaceChild(fresh, old); placeMove();
    var f = focusSel && fresh.querySelector(focusSel); if (f) f.focus({ preventScroll: true });
  }
  function movePanel(p) {
    var nowKey = keyOfPerson(p.id) || "", nowCell = cellOf(nowKey);
    var pan = el("div", "rv-tbox-move is-pop"); pan.setAttribute("role", "group"); pan.setAttribute("aria-label", "Move " + p.name);
    var hd = el("div", "rv-tbox-mvhead");
    hd.appendChild(el("span", "rv-tbox-mvtitle", "Move " + p.name));
    hd.appendChild(el("span", "rv-tbox-mvnow", "Now " + ((nowCell && nowCell.label) || "not placed") + " · " + (p.perf || DASH) + " · " + (p.pot || DASH)));
    pan.appendChild(hd);
    var body = el("div", "rv-tbox-mvbody"), pw = el("div", "rv-tbox-pkwrap"), pk = el("div", "rv-tbox-pick");
    pk.setAttribute("role", "group"); pk.setAttribute("aria-label", "Where they should sit");
    (D.rows || []).forEach(function (rw) {
      (D.cols || []).forEach(function (c) {
        var key = c.key + "|" + rw.key, cell = cellOf(key), cat = (cell && cell.label) || "", full = key !== nowKey && limFull(p, cat);
        var b = el("button", "rv-tbox-pk" + (key === nowKey ? " is-now" : "") + (full ? " is-full" : "")); b.type = "button";
        b.setAttribute("data-key", key); b.setAttribute("data-cat", slug(cat));
        b.appendChild(el("span", null, shortCat(cat)));
        if (key === nowKey) b.appendChild(el("small", null, "now")); else if (full) b.appendChild(el("small", "rv-tbox-pkfull", "full"));
        b.setAttribute("aria-pressed", mv.tgt === key ? "true" : "false");
        b.setAttribute("aria-label", (key === nowKey ? "Now in " : full ? "Can’t move to " : "Move to ") + cat + ", " + rw.key.toLowerCase()
          + " potential, " + c.label.toLowerCase() + " performance" + (full ? ", full" : ""));
        b.title = full ? (R.limits.msg || {})[cat] || cat : cat;
        if (key === nowKey || full) b.disabled = true;
        else b.addEventListener("click", function () { mv.tgt = mv.tgt === key ? null : key; mv.pick = null; mv.err = ""; repaintMove('.rv-tbox-pk[data-key="' + key + '"]'); });
        pk.appendChild(b);
      });
    });
    pw.appendChild(pk); pw.appendChild(el("span", "rv-tbox-pkcap", "Potential ↑ · performance →")); body.appendChild(pw);
    var side = el("div", "rv-tbox-mvside"), tcell = mv.tgt ? cellOf(mv.tgt) : null, perfNew = p.perf, potNew = p.pot;
    if (!tcell) side.appendChild(el("p", "rv-tbox-mvhint", "Pick the box they should sit in."));
    else {
      var nc = nowKey ? nowKey.split("|")[0] : "", colT = colOf(tcell.col), line = el("p", "rv-tbox-mvline");
      potNew = tcell.pot;
      line.appendChild(el("b", null, (nowCell && nowCell.label) || "Not placed")); line.appendChild(document.createTextNode(" → ")); line.appendChild(el("b", null, tcell.label || ""));
      side.appendChild(line);
      var g = el("div", "rv-tbox-mvgrid"); g.appendChild(el("span", "rv-tbox-mvk", "Performance"));
      if (tcell.col === nc || !colT) g.appendChild(el("span", null, (p.perf || DASH) + " (no change)"));
      else {
        var bands = colT.bands, dflt = tcell.col === "high" ? bands[0] : bands[bands.length - 1], v = el("span", "rv-tbox-mvv", (p.perf || DASH) + " → ");
        perfNew = mv.pick && bands.indexOf(mv.pick) >= 0 ? mv.pick : dflt;
        if (bands.length > 1) {
          var segs = el("span", "rv-tbox-segs"); segs.setAttribute("role", "group"); segs.setAttribute("aria-label", "New performance band");
          bands.forEach(function (bd) {
            var s2 = el("button", "rv-tbox-seg", bd); s2.type = "button"; s2.setAttribute("data-band", bd); s2.setAttribute("aria-pressed", bd === perfNew ? "true" : "false");
            if (D.label_names && D.label_names[bd]) s2.title = D.label_names[bd];
            s2.addEventListener("click", function () { mv.pick = bd; repaintMove('.rv-tbox-seg[data-band="' + bd + '"]'); });
            segs.appendChild(s2);
          });
          v.appendChild(segs);
        } else v.appendChild(el("b", null, perfNew));
        g.appendChild(v);
      }
      g.appendChild(el("span", "rv-tbox-mvk", "Potential"));
      if (potNew === p.pot) g.appendChild(el("span", null, (p.pot || DASH) + " (no change)"));
      else { var pv = el("span", null, (p.pot || DASH) + " → "); pv.appendChild(el("b", null, potNew)); g.appendChild(pv); }
      side.appendChild(g);
      side.appendChild(el("p", "rv-tbox-mvcap", "Your Round 2 remark goes on this move."));
    }
    if (R.limits) {
      var full = ["Super Star", "Star"].filter(function (cat) { return limFull(p, cat); });
      if (full.length) side.appendChild(el("p", "rv-tbox-mvcap is-bad", (R.limits.msg || {})[full[0]] || "Full: move someone out first."));
    }
    body.appendChild(side); pan.appendChild(body);
    var err = el("p", "rv-tbox-err", mv.err || ""); err.setAttribute("role", "alert"); pan.appendChild(err);
    var acts = el("div", "rv-tbox-mvacts"), cancel = el("button", "rv-tbox-cancel", "Cancel"); cancel.type = "button";
    cancel.addEventListener("click", function () { if (!mv.saving) endMove(true); });
    var save = el("button", "rv-tbox-save", "Save move"); save.type = "button"; save.disabled = !tcell || !!mv.saving;
    save.addEventListener("click", function () {
      if (mv.saving || !tcell) return;
      var np = perfNew !== p.perf ? perfNew : "", nq = potNew !== p.pot ? potNew : "";
      if (!np && !nq) { endMove(true); return; }
      mv.saving = true; save.disabled = true; cancel.disabled = true; save.textContent = "Saving…"; err.textContent = "";
      var fail = function (t) { mv.saving = false; mv.err = t; save.disabled = false; cancel.disabled = false; save.textContent = "Save move"; err.textContent = t; placeMove(); };
      var f = new FormData(); f.append("csrf_token", CSRF); f.append("subject_id", String(p.id));
      if (np) f.append("performance_band", np); if (nq) f.append("potential_band", nq);
      f.append("justification", ""); f.append("company", R.company || ""); f.append("round_id", R.round_id != null ? String(R.round_id) : "");
      fetch(R.move_url, { method: "POST", body: f, credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) {
          if (!j || !j.ok) { fail((j && j.error) || "Couldn’t move them: please try again."); return; }
          reloadWith(p.name + " moved to " + (tcell.label || "their new box") + ".");
        })
        .catch(function () { fail("Couldn’t move them: please try again."); });
    });
    acts.appendChild(cancel); acts.appendChild(save); pan.appendChild(acts);
    return pan;
  }
  function reloadWith(msg) {   // the page is the server's: a move or an apply reloads it, and says what was done once
    try { window.sessionStorage.setItem("onehr.atb.msg", msg); } catch (e) { /* private window */ }
    window.keepPlace && window.keepPlace();
    window.location.reload();
  }
  (function () {   // what the last move / apply did, said once at the top of the card
    var msg = null;
    try { msg = window.sessionStorage.getItem("onehr.atb.msg"); window.sessionStorage.removeItem("onehr.atb.msg"); } catch (e) { msg = null; }
    if (!msg) return;
    var n = el("div", "flash flash-ok atb-note", msg); n.setAttribute("role", "status");
    root.parentNode.insertBefore(n, root);
    setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, 8000);
  })();

  /* ---- Suggest with AI: proposes only. The marks (the cells' "+n suggested" on their second row, "AI: → ME" on each person) and the
     strip show only after it is clicked, and Dismiss hides them again; Apply all posts what it showed and the server works the fit out
     again and applies only what still matches (each through the one move writer). */
  var sBtn = document.getElementById("atb-suggest"), aiBox = document.getElementById("atb-ai");
  function bandName(b) { return (D.label_names && D.label_names[b]) || b; }
  function colOfBand(b) { return (D.cols || []).filter(function (c) { return (c.bands || []).indexOf(b) >= 0; })[0] || null; }
  function paintAi() {
    cells.forEach(function (c) {
      var row = c.querySelector(".atb-sgrow"); if (!row) return;
      row.hidden = !ai; row.textContent = "";
      var n = ai ? (ai.byCell[c.getAttribute("data-key")] || 0) : 0;
      if (n) row.appendChild(el("span", "atb-sg", "+" + n + " suggested"));
    });
    if (aiBox) {
      aiBox.hidden = !ai;
      if (ai) {
        var say = document.getElementById("atb-ai-say"), list = document.getElementById("atb-ai-list"), apply = document.getElementById("atb-ai-apply");
        say.textContent = ""; list.textContent = "";
        if (ai.error) { say.appendChild(document.createTextNode(ai.error)); apply.hidden = true; }
        else if (!ai.n) { say.appendChild(el("b", null, "AI+ has no moves to suggest")); say.appendChild(document.createTextNode(ai.message ? ". " + ai.message : ".")); apply.hidden = true; }
        else {
          say.appendChild(el("b", null, "AI+ suggests " + ai.n + (ai.n === 1 ? " move" : " moves")));
          say.appendChild(document.createTextNode(" to fit " + (ai.curve || "the new curve") + ". Nothing has moved yet."));
          apply.hidden = false; apply.textContent = "Apply all " + ai.n;
          ai.groups.forEach(function (g) { list.appendChild(el("li", null, g.n + (g.n === 1 ? " person " : " people ") + bandName(g.from) + " → " + bandName(g.to))); });
        }
      }
    }
    paintDrawer(); if (st.view === "list") paintList();
  }
  if (sBtn) sBtn.addEventListener("click", function () {
    var tx = sBtn.lastChild, was = tx ? tx.nodeValue : "";
    sBtn.disabled = true; if (tx) tx.nodeValue = "Suggesting…";
    fetch(R.suggest_url + "?bg=" + encodeURIComponent(R.bg) + "&company=" + encodeURIComponent(R.company),
          { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        sBtn.disabled = false; if (tx) tx.nodeValue = was;
        if (!j || !j.ok) { ai = { error: (j && j.error) || "AI+ couldn’t suggest now: please try again.", n: 0, byId: {}, byCell: {}, groups: [], moves: [] }; paintAi(); return; }
        var byId = {}, byCell = {}, gr = {}, moves = j.moves || [];
        moves.forEach(function (m) {
          byId[m.id] = { from: m.from, to: m.to, why: [].concat(m.reasons || []).join("; ") };
          var k = keyOfPerson(m.id), col = colOfBand(m.to);
          if (k && col) { var dk = col.key + "|" + k.split("|")[1]; if (dk !== k) byCell[dk] = (byCell[dk] || 0) + 1; }
          var gk = m.from + ">" + m.to; gr[gk] = gr[gk] || { from: m.from, to: m.to, n: 0 }; gr[gk].n++;
        });
        var groups = Object.keys(gr).map(function (k) { return gr[k]; }).sort(function (a, b) { return b.n - a.n; });
        ai = { n: moves.length, moves: moves, byId: byId, byCell: byCell, groups: groups, curve: j.curve, message: j.message };
        paintAi();
      })
      .catch(function () { sBtn.disabled = false; if (tx) tx.nodeValue = was; ai = { error: "AI+ couldn’t suggest now: please try again.", n: 0, byId: {}, byCell: {}, groups: [], moves: [] }; paintAi(); });
  });
  var aiNo = document.getElementById("atb-ai-dismiss");
  if (aiNo) aiNo.addEventListener("click", function () { ai = null; paintAi(); if (sBtn) sBtn.focus(); });
  var aiGo = document.getElementById("atb-ai-apply");
  if (aiGo) aiGo.addEventListener("click", function () {
    if (!ai || !ai.n) return;
    var n = ai.n;
    window.askConfirm("Apply all " + n + " suggested " + (n === 1 ? "move" : "moves") + " to " + (R.unit || "this unit") + "? Each is a Round 2 move with your remark. Nothing is final until you lock Round 2.",
      "Apply all " + n, function () {
        aiGo.disabled = true; aiGo.textContent = "Applying…";
        var f = new FormData(); f.append("csrf_token", CSRF); f.append("bg", R.bg); f.append("company", R.company);
        f.append("round_id", R.round_id != null ? String(R.round_id) : "");
        f.append("moves", JSON.stringify(ai.moves.map(function (m) { return { id: m.id, from: m.from, to: m.to }; })));
        fetch(R.apply_url, { method: "POST", body: f, credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } })
          .then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function (j) {
            if (!j || !j.ok) {
              aiGo.disabled = false; aiGo.textContent = "Apply all " + n;
              ai.error = (j && j.error) || "Couldn’t apply them: please try again."; ai.n = 0; paintAi(); return;
            }
            reloadWith("AI+ suggestions applied: " + j.applied + (j.applied === 1 ? " move" : " moves") + " made"
              + (j.skipped ? ", " + j.skipped + " skipped" + ((j.skipped_why || []).length ? " (" + j.skipped_why[0] + ")" : "") : "") + ". Nothing is final until you lock Round 2.");
          })
          .catch(function () { aiGo.disabled = false; aiGo.textContent = "Apply all " + n; ai.error = "Couldn’t apply them: please try again."; ai.n = 0; paintAi(); });
      }, false, { title: "Apply the AI+ suggestions?" });
  });

  /* ---- start: the saved view, the top box (or the first with people) picked */
  st.sel = defaultBox();
  try { var keep = window.sessionStorage.getItem("onehr.atb.sel"); if (keep && cellOf(keep)) st.sel = keep; } catch (e) { /* private window */ }
  var saved = null;
  try { saved = window.localStorage.getItem("onehr.tbox.view"); } catch (e) { saved = null; }
  paintMarks(); paintDrawer(); setView(saved === "list" ? "list" : "grid");
})();
