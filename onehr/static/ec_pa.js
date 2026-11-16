/* AI+ OneHR -- the Executive Chairman's talent chat in the dashboard's left panel (Chris, 2026-10-30; canvas
   [design canvas link removed] boards 1 to 6; STAGING ONLY behind ONEHR_EC_PA=1). The conversation lives in this
   tab: each turn posts the question, the last ten messages and the last role reading to /ec/talent (the contract is the comment block
   above ec_talent in app.py); the server runs the tools and answers with `say`, `renders` (drawn in order beneath it), quick replies
   and `state`. Everything is set as text, never HTML. What the agent writes is never red. Width: the grip on the right edge drags it
   from 320px (up to 560px it pushes the page, wider it floats over it, up to 60% of the window); Expand jumps to 768px floating and
   Collapse goes back; Esc returns a float to the pushed width; Fold goes to the 56px rail. The width is kept in this browser only
   (blocked storage: it just starts at 320px). */
(function () {
  "use strict";
  var panel = document.getElementById("ask-panel");
  var rail = document.getElementById("gp-rail");
  if (!panel || !rail || !panel.classList.contains("ecp")) return;
  var log = document.getElementById("ask-log");
  var form = document.getElementById("ask-form");
  var input = document.getElementById("ask-input");
  var send = form.querySelector(".gp-send");
  var btnNew = document.getElementById("ecp-new");
  var btnExp = document.getElementById("ecp-expand");
  var grip = document.getElementById("ecp-grip");
  var tip = document.getElementById("ecp-wtip");
  var de = document.documentElement;
  var history = [];
  var reading = null;      // the last role reading, sent back with every turn
  var busy = false;

  var FOLD_KEY = "onehr.guide.folded", W_KEY = "onehr.ecp.w", X_KEY = "onehr.ecp.x";
  var MIN_W = 320, PUSH_MAX = 560, EXPAND_W = 768, STEP = 24;
  var w = MIN_W, expanded = false, prevW = MIN_W;

  function csrf() {
    var m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.getAttribute("content") : "";
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked: it just won't remember */ } }
  function fetchStore(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  // ---- width -------------------------------------------------------------------------------------------------------
  // the page is pushed only while it keeps 640px (what a 1024px window leaves beside a 320px panel): the 560px of the canvas on a wide
  // window, less on a narrow one; wider than that the panel floats over it
  function pushMax() { return Math.max(MIN_W, Math.min(PUSH_MAX, window.innerWidth - 40 - 640)); }
  function maxW() { return Math.max(MIN_W, Math.floor(window.innerWidth * 0.6)); }
  function clampW(v) { return Math.max(MIN_W, Math.min(Math.round(v), maxW())); }
  function applyWidth() {
    de.style.setProperty("--ecp-w", w + "px");
    de.style.setProperty("--ecp-push", Math.min(w, pushMax()) + "px");
    panel.classList.toggle("is-float", w > pushMax());
    panel.classList.toggle("is-wide", w >= 520);
    panel.classList.toggle("is-x", expanded);
    btnExp.setAttribute("aria-label", expanded ? "Back to the narrow panel" : "Expand the panel");
    btnExp.setAttribute("title", expanded ? "Collapse" : "Expand");
    btnExp.setAttribute("aria-pressed", expanded ? "true" : "false");
    grip.setAttribute("title", "Drag to " + (w >= maxW() ? "narrow" : "resize") + " the panel · " + w + "px");
    tip.textContent = w + "px";
  }
  function setWidth(v, keepExpanded) {
    w = clampW(v);
    if (!keepExpanded) expanded = false;
    applyWidth();
  }
  function remember() {
    store(W_KEY, String(expanded ? prevW : w));
    store(X_KEY, expanded ? "1" : "0");
  }
  function expand(on) {
    if (on) {
      if (!expanded) prevW = w;
      expanded = true;
      w = clampW(EXPAND_W);
    } else {
      expanded = false;
      w = clampW(prevW || MIN_W);
    }
    applyWidth();
    remember();
  }
  (function restore() {
    var sw = parseInt(fetchStore(W_KEY), 10);
    prevW = sw >= MIN_W ? sw : MIN_W;
    expanded = fetchStore(X_KEY) === "1";
    w = expanded ? clampW(EXPAND_W) : clampW(prevW);
    applyWidth();
  })();
  btnExp.addEventListener("click", function () { expand(!expanded); });
  window.addEventListener("resize", function () { w = clampW(expanded ? EXPAND_W : w); applyWidth(); });

  // the grip: drag, or Left / Right
  var dragging = false;
  grip.addEventListener("pointerdown", function (e) {
    if (e.button !== undefined && e.button !== 0) return;
    dragging = true;
    de.classList.add("ecp-dragging");
    tip.hidden = false;
    try { grip.setPointerCapture(e.pointerId); } catch (x) { /* not capturable: the move still reaches the window */ }
    e.preventDefault();
  });
  grip.addEventListener("pointermove", function (e) {
    if (!dragging) return;
    setWidth(e.clientX);
  });
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    de.classList.remove("ecp-dragging");
    tip.hidden = true;
    try { grip.releasePointerCapture(e.pointerId); } catch (x) { /* already released */ }
    prevW = w;
    remember();
  }
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);
  grip.addEventListener("keydown", function (e) {
    var d = 0;
    if (e.key === "ArrowLeft") d = -STEP; else if (e.key === "ArrowRight") d = STEP; else if (e.key === "Home") d = -9999; else if (e.key === "End") d = 9999;
    if (!d) return;
    if (e.shiftKey && Math.abs(d) === STEP) d *= 4;
    e.preventDefault();
    setWidth(w + d);
    prevW = w;
    tip.hidden = false;
    remember();
  });
  grip.addEventListener("blur", function () { if (!dragging) tip.hidden = true; });
  // Esc: an expanded panel goes back, a floating one returns to the pushed width
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || e.defaultPrevented || panel.hidden) return;
    if (document.querySelector('.confirm-dialog, dialog[open], [role="dialog"]:not([hidden])')) return;
    var t = e.target;
    if (t && t !== document.body && !panel.contains(t)) return;
    if (expanded) { expand(false); if (w > pushMax()) { setWidth(pushMax()); prevW = w; remember(); } }
    else if (w > pushMax()) { setWidth(pushMax()); prevW = w; remember(); }
  });

  // ---- folding -----------------------------------------------------------------------------------------------------
  function fold(on) {
    panel.hidden = !!on;
    rail.hidden = !on;
    store(FOLD_KEY, on ? "1" : "0");
    if (on) document.getElementById("gp-open").focus(); else input.focus();
  }
  document.getElementById("gp-fold").addEventListener("click", function () { fold(true); });
  document.getElementById("gp-open").addEventListener("click", function () { fold(false); });

  // ---- drawing -----------------------------------------------------------------------------------------------------
  function scrollDown() { log.scrollTop = log.scrollHeight; }
  var STATUS_CLS = { "super star": "ecp-ss", "star": "ecp-st", "solid core": "ecp-sc", "pip": "ecp-pip", "pip / improvement": "ecp-pip", "pip/improvement": "ecp-pip", "improvement": "ecp-pip" };
  function chip(status, title) {
    var k = STATUS_CLS[String(status || "").toLowerCase()] || "ecp-sc";
    var c = el("span", "ecp-tc " + k, status);
    if (title) c.title = title;
    return c;
  }
  function noRecord(year) {
    var c = el("span", "ecp-tc na", "No record");
    c.title = "No record for the " + year + " Year-End";
    return c;
  }
  function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }
  function yearsText(r) {
    var y = num(r.years);
    if (y === null) return "";
    return String(Math.floor(y + 0.05));   // whole years here; the full words ("8 years 4 months") are on hover
  }
  function who(r) { return [r.title, r.group, r.grade ? "JG " + r.grade : ""].filter(Boolean).join(" · "); }
  function initials(name) {
    var p = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!p.length) return "?";
    var a = p[0].charAt(0), b = p.length > 1 ? p[p.length - 1].charAt(0) : "";
    return (a + b).toUpperCase();
  }
  function nameCell(r) {
    var td = el("td", "ecp-c-nm");
    var row = el("div", "ecp-nmrow");
    var b = el("button", "ecp-nm", r.name || "");
    b.type = "button";
    b.title = (r.name || "") + (r.why ? " · key: " + r.why : "") + " · open their history";
    b.setAttribute("data-ask", "Tell me about " + (r.name || "") + (r.eid ? " (" + r.eid + ")" : ""));
    row.appendChild(b);
    if (r.key) row.appendChild(el("span", "ecp-tag", "Key"));
    td.appendChild(row);
    var s = el("span", "ecp-sub", who(r));
    s.title = who(r) + (r.incumbent ? " · holds this job now" : "");
    td.appendChild(s);
    if (r.incumbent) td.appendChild(el("span", "ecp-sub", "Holds this job now"));
    return td;
  }
  function th(long, short, title) {
    var h = el("th");
    h.scope = "col";
    if (short) {
      h.appendChild(el("span", "ecp-hl", long));
      h.appendChild(el("span", "ecp-hs", short));
    } else {
      h.textContent = long;
    }
    h.title = title || long;
    return h;
  }
  function talentYears(rows) {
    // the years to draw, oldest first: every year any row has (so each column lines up); at most the three newest
    var seen = {};
    rows.forEach(function (r) { (r.talent || []).forEach(function (t) { seen[t.year] = true; }); });
    var ys = Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
    return ys.slice(-3);
  }
  function talentCell(r, ys) {
    var td = el("td", "ecp-c-ts");
    td.setAttribute("data-l", "Talent");
    var box = el("span", "ecp-ts");
    var by = {};
    (r.talent || []).forEach(function (t) { by[t.year] = t.status; });
    ys.forEach(function (y) { box.appendChild(by[y] ? chip(by[y], y + " Year-End") : noRecord(y)); });
    if (!ys.length) box.appendChild(el("span", "ecp-muted", r.talent_line || "No record"));
    td.appendChild(box);
    return td;
  }
  function matchCell(r) {
    var td = el("td", "ecp-c-mt");
    td.setAttribute("data-l", "Match");
    if (r.match === null || r.match === undefined) { td.appendChild(el("span", "ecp-muted", "n/a")); return td; }
    var m = el("span", "ecp-mt");
    m.title = r.match_text || (r.match + "% skills match");
    m.appendChild(document.createTextNode(r.match + "%"));
    var bar = el("span", "ecp-mb");
    var f = el("i");
    f.style.width = Math.max(0, Math.min(100, r.match)) + "%";
    bar.appendChild(f);
    m.appendChild(bar);
    td.appendChild(m);
    return td;
  }
  function gapsCell(r) {
    var td = el("td", "ecp-c-gp");
    td.setAttribute("data-l", "Gaps");
    var g = (r.gaps || []).slice(0, 3);
    var txt = g.join(", ") + (r.gaps_more ? (g.length ? " +" : "+") + r.gaps_more : "");
    td.textContent = txt || "None";
    if (!txt) td.className += " ecp-muted";
    td.title = (r.gaps || []).join(", ") + (r.gaps_more ? " (+" + r.gaps_more + " more)" : "");
    return td;
  }
  function colgroup(n) {   // the widths are the stylesheet's (by the card's own width); compare sets its own
    var cg = el("colgroup");
    for (var i = 0; i < n; i++) cg.appendChild(el("col"));
    return cg;
  }
  function rowsTable(rows, kind, ys, hasMatch) {
    var t = el("table", "ecp-tbl");
    var yl = ys.length ? "Talent " + ys.join(" · ") : "Talent";
    var heads;
    if (kind === "key") {
      heads = [th("Name · now"), th("Years"), th(yl, "Talent", yl), th("Cover")];
      t.setAttribute("data-k", "key");
    } else if (hasMatch) {
      heads = [th("Name · now"), th("Years"), th(yl, "Talent", yl), th("Skills match", "Match", "Skills match"), th("Gaps")];
      t.setAttribute("data-k", "match");
    } else {
      heads = [th("Name · now"), th("Years"), th(yl, "Talent", yl)];
      t.setAttribute("data-k", "list");
    }
    t.appendChild(colgroup(heads.length));
    var hr = el("tr");
    heads.forEach(function (h) { hr.appendChild(h); });
    t.appendChild(el("thead")).appendChild(hr);
    var body = el("tbody");
    rows.forEach(function (r) {
      var tr = el("tr");
      tr.appendChild(nameCell(r));
      var yd = el("td", "ecp-c-yr", yearsText(r));
      yd.setAttribute("data-l", "Years");
      if (r.years_word) yd.title = r.years_word;
      tr.appendChild(yd);
      tr.appendChild(talentCell(r, ys));
      if (kind === "key") {
        var cd = el("td", "ecp-c-cv");
        cd.setAttribute("data-l", "Cover");
        var cv = r.cover || {};
        var cc = el("span", "ecp-cov " + (cv.none ? "none" : "some"), cv.text || (cv.none ? "No one at 70%" : ""));
        cc.title = cv.text || "";
        cd.appendChild(cc);
        tr.appendChild(cd);
      } else if (hasMatch) {
        tr.appendChild(matchCell(r));
        tr.appendChild(gapsCell(r));
      }
      body.appendChild(tr);
    });
    t.appendChild(body);
    return t;
  }
  function listCard(rd, kind) {
    var rows = rd.rows || [];
    var card = el("div", "ecp-res");
    var head = el("div", "ecp-res-h");
    var title = kind === "key" ? "Key people · " + (rd.total === undefined ? rows.length : rd.total) : (rd.title || "People");
    head.appendChild(el("b", null, title));
    var side = kind === "key" ? (rd.cover_min ? "Cover = the closest other person's skills match for their role" : "")
      : (rd.role && rd.skills_in_role ? "Skills match against " + rd.role + "'s " + rd.skills_in_role + " skills" : (rd.note || ""));
    if (side) { var s = el("span", "ecp-muted", side); s.title = side; head.appendChild(s); }
    card.appendChild(head);
    var hasMatch = kind !== "key" && !!rd.has_match;
    var ys = talentYears(rows);
    var FIRST = 6;
    card.appendChild(rowsTable(rows.slice(0, FIRST), kind, ys, hasMatch));
    if (rows.length > FIRST) {
      var d = el("details", "fold");
      d.appendChild(el("summary", null, (rows.length - FIRST) + " more"));
      d.appendChild(rowsTable(rows.slice(FIRST), kind, ys, hasMatch));
      var less = el("button", "fold-less", "Show less");
      less.type = "button";
      less.setAttribute("data-fold-less", "");
      d.appendChild(less);
      card.appendChild(d);
    }
    var foot = el("p", "ecp-src");
    var txt = kind === "key" ? (rd.rule || "") : (rd.note || "");
    if (kind === "key" && rd.rule) txt = rd.rule;
    foot.appendChild(document.createTextNode(txt ? txt + " " : ""));
    var more = (rd.total || 0) - rows.length;
    if (more > 0) {
      var mb = el("button", "ecp-more", "Show the other " + more + " →");
      mb.type = "button";
      mb.setAttribute("data-ask", "Show the other " + more + " for " + title.replace(/\s*·.*$/, ""));
      foot.appendChild(mb);
    }
    if (foot.childNodes.length) card.appendChild(foot);
    return card;
  }
  function personCard(rd) {
    var p = rd.person || {};
    var card = el("div", "ecp-res");
    var box = el("div", "ecp-pc");
    var ph = el("div", "ecp-ph");
    ph.appendChild(el("span", "ecp-pav", initials(p.name)));
    var t = el("div", "ecp-ph-t");
    t.appendChild(el("b", null, p.name || ""));
    t.appendChild(el("span", null, [p.title, p.unit, p.group, p.grade ? "JG " + p.grade : ""].filter(Boolean).join(" · ")));
    ph.appendChild(t);
    if (p.key && p.key.is_key) ph.appendChild(el("span", "ecp-key", "Key person"));
    box.appendChild(ph);
    var dl = el("dl", "ecp-facts");
    function fact(k, v, muted) {
      if (v === undefined || v === null || v === "") return;
      dl.appendChild(el("dt", null, k));
      var dd = el("dd", muted ? "ecp-muted" : null);
      if (typeof v === "string") dd.textContent = v; else dd.appendChild(v);
      dl.appendChild(dd);
    }
    var yw = null;
    if (p.years_word || num(p.years) !== null) { yw = el("b", null, p.years_word || (p.years + " years")); }
    fact("Years with us", yw);
    fact("Line manager", p.line_manager);
    fact("Last promotion", p.last_promotion, true);
    fact("Job profile", p.job_profile);
    if (p.key && p.key.why) fact("Why key", p.key.why);
    box.appendChild(dl);
    var tal = (p.talent || []).slice().sort(function (a, b) { return a.year - b.year; });
    box.appendChild(el("p", "ecp-kh", "Talent status by Year-End"));
    var yrs = el("div", "ecp-years");
    if (!tal.length) yrs.appendChild(el("span", "ecp-muted", p.talent_line || "No talent status on record"));
    tal.forEach(function (t2) {
      var y = el("div", "ecp-yr");
      y.appendChild(el("b", null, String(t2.year)));
      y.appendChild(t2.status ? chip(t2.status) : noRecord(t2.year));
      var from = /^(HR|Group People)/i.test(t2.from || "") ? "Group People's records"
        : ([t2.performance, t2.potential].filter(Boolean).join(" · ") || t2.from || "");
      if (from) y.appendChild(el("small", null, from));
      yrs.appendChild(y);
    });
    box.appendChild(yrs);
    if ((p.next_roles || []).length) {
      box.appendChild(el("p", "ecp-kh", "Closest next roles · skills match"));
      var ul = el("ul", "ecp-fit");
      p.next_roles.forEach(function (n) {
        var li = el("li");
        var tt = n.title + (n.grade ? " (JG " + n.grade + ")" : "");
        var s2 = el("span", "ecp-fit-t", tt);
        s2.title = tt + (n.gaps && n.gaps.length ? " · gaps: " + n.gaps.join(", ") + (n.gaps_more ? " +" + n.gaps_more : "") : "");
        li.appendChild(s2);
        if (n.match !== null && n.match !== undefined) {
          li.appendChild(el("b", null, n.match + "%"));
          var bar = el("span", "ecp-mb");
          var f = el("i");
          f.style.width = Math.max(0, Math.min(100, n.match)) + "%";
          bar.appendChild(f);
          li.appendChild(bar);
        } else {
          li.appendChild(el("span", "ecp-muted", n.match_text || "n/a"));
        }
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
    if (p.never_shown) box.appendChild(el("p", "ecp-not", p.never_shown));
    card.appendChild(box);
    return card;
  }
  function readingCard(rd) {
    var r = rd.reading || {};
    var card = el("div", "ecp-res");
    var head = el("div", "ecp-res-h");
    head.appendChild(el("b", null, "How I read the role"));
    card.appendChild(head);
    var dl = el("dl", "ecp-read");
    dl.appendChild(el("dt", null, "Role"));
    dl.appendChild(el("dd", null, r.title || ""));
    dl.appendChild(el("dt", null, "Grade"));
    var g = r.grade_max && r.grade_max !== r.grade_min ? "JG " + r.grade_min + " to " + r.grade_max : "JG " + r.grade_min + " and above";
    dl.appendChild(el("dd", null, g));
    dl.appendChild(el("dt", null, "Skills"));
    var dd = el("dd");
    (r.skills || []).forEach(function (s) { dd.appendChild(el("span", "ecp-sk", s)); });
    (r.new_skills || []).forEach(function (s) {
      var c = el("span", "ecp-sk is-new", s + " · new");
      c.title = "Not in the job architecture: nobody can be matched on it yet";
      dd.appendChild(c);
    });
    if (!(r.skills || []).length && !(r.new_skills || []).length) dd.appendChild(el("span", "ecp-muted", "None named yet"));
    dl.appendChild(dd);
    card.appendChild(dl);
    var acts = el("div", "ecp-acts");
    (rd.buttons || []).forEach(function (b, i) {
      var x = el("button", "ecp-btn" + (i === 0 ? " is-primary" : ""), b.label);
      x.type = "button";
      x.setAttribute("data-ask", b.message || b.label);
      if (b.action) x.setAttribute("data-action", b.action);
      acts.appendChild(x);
    });
    card.appendChild(acts);
    return card;
  }
  function compareCard(rd) {
    var people = rd.people || [];
    var card = el("div", "ecp-res");
    var head = el("div", "ecp-res-h");
    head.appendChild(el("b", null, "Side by side"));
    card.appendChild(head);
    var t = el("table", "ecp-tbl ecp-cmp");
    var first = 22, rest = Math.floor((100 - first) / Math.max(1, people.length));
    var cg = colgroup(people.length + 1);
    Array.prototype.forEach.call(cg.children, function (c, i) { c.style.width = (i === 0 ? first : rest) + "%"; });
    t.appendChild(cg);
    var hr = el("tr");
    hr.appendChild(el("th", null, ""));
    people.forEach(function (p) {
      var h = el("th", null, p.name);
      h.scope = "col";
      h.title = p.name + (p.title ? " · " + p.title : "");
      hr.appendChild(h);
    });
    t.appendChild(el("thead")).appendChild(hr);
    var body = el("tbody");
    (rd.rows || []).forEach(function (r) {
      var tr = el("tr");
      tr.appendChild(el("td", null, r.label));
      (r.values || []).forEach(function (v) { tr.appendChild(el("td", null, v)); });
      body.appendChild(tr);
    });
    t.appendChild(body);
    card.appendChild(t);
    return card;
  }
  function linkCard(rd) {
    if (!rd.href || rd.href.charAt(0) !== "/" || rd.href.charAt(1) === "/") return null;   // a page on this site only
    var a = el("a", "ecp-go", (rd.label || "Open") + " ›");
    a.href = rd.href;
    return a;
  }
  function drawRender(rd) {
    switch (rd && rd.type) {
      case "shortlist": return listCard(rd, "list");
      case "key_people": return listCard(rd, "key");
      case "person": return personCard(rd);
      case "role_reading": return readingCard(rd);
      case "compare": return compareCard(rd);
      case "link": return linkCard(rd);
      default: return null;
    }
  }
  function chipsRow(list) {
    var row = el("div", "ecp-chips");
    list.forEach(function (q) {
      var c = el("button", "gp-chip", q);
      c.type = "button";
      c.setAttribute("data-ask", q);
      row.appendChild(c);
    });
    return row;
  }
  function answer(d) {
    var wrap = el("div", "ecp-turn");
    if (d.say) wrap.appendChild(el("p", "ecp-bot" + (d.ok === false ? " ecp-err" : ""), d.say));
    (d.renders || []).forEach(function (rd) {
      var n = drawRender(rd);
      if (n) wrap.appendChild(n);
    });
    var quick = (d.quick_replies || []).filter(function (q) { return typeof q === "string" && q; }).slice(0, 3);
    if (quick.length) wrap.appendChild(chipsRow(quick));
    log.appendChild(wrap);
    scrollDown();
  }

  // ---- the conversation --------------------------------------------------------------------------------------------
  function disableOld() {
    // only the newest answer's buttons and chips act: an old role card must not be sent on its stale state
    Array.prototype.forEach.call(log.querySelectorAll(".ecp-acts .ecp-btn"), function (b) { b.disabled = true; });
  }
  function ask(text, action) {
    text = (text || "").trim();
    if (!text || busy) return;
    var rest = document.getElementById("gp-rest");
    if (rest) rest.hidden = true;   // at rest only until the first question; the answers take its place
    btnNew.hidden = false;
    busy = true;
    send.disabled = true;
    disableOld();
    log.appendChild(el("p", "ecp-me", text));
    var thinking = el("p", "ecp-thinking", panel.getAttribute("data-available") === "1" ? "Looking…" : "One moment…");
    log.appendChild(thinking);
    scrollDown();
    var body = new FormData();
    body.append("csrf_token", csrf());
    body.append("message", text);
    body.append("history", JSON.stringify(history.slice(-10)));
    if (reading) body.append("state", JSON.stringify(reading));
    if (action) body.append("action", action);
    fetch(panel.getAttribute("data-endpoint"), { method: "POST", body: body, credentials: "same-origin" })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) {
        thinking.remove();
        if (!d || (!d.ok && !d.say)) {
          answer({ ok: false, say: (d && d.error) || "Sorry, that didn't go through. Try again in a moment." });
          return;
        }
        answer(d);
        if (d.slowed) { input.value = text; return; }   // six a minute: back in the box, not in the history
        if (d.state !== undefined) reading = d.state || null;
        history.push({ role: "user", content: text });
        history.push({ role: "agent", content: d.say || "" });
      })
      .catch(function () {
        thinking.remove();
        answer({ ok: false, say: "The connection dropped. Your question is back in the box; try again." });
        input.value = text;
      })
      .then(function () { busy = false; send.disabled = false; });
  }
  function clearAll() {
    Array.prototype.slice.call(log.children).forEach(function (n) { if (n.id !== "gp-rest") n.remove(); });
    var rest = document.getElementById("gp-rest");
    if (rest) rest.hidden = false;
    history = [];
    reading = null;
    btnNew.hidden = true;
    input.value = "";
    log.scrollTop = 0;
    input.focus();
  }
  btnNew.addEventListener("click", clearAll);
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var t = input.value;
    input.value = "";
    ask(t);
  });
  panel.addEventListener("click", function (e) {
    var s = e.target.closest && e.target.closest(".ask-sugg, [data-ask]");
    if (!s || s.disabled) return;
    ask(s.getAttribute("data-q") || s.getAttribute("data-ask"), s.getAttribute("data-action") || "");
  });
})();
