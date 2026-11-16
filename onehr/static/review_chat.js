/* The conversational review agent's client.
 *
 * A plain chat: render the stored transcript, send the employee's message to
 * /review/chat, append the agent's reply, show its quick-reply chips. The SERVER
 * decides everything -- what to ask, what to record, the rating -- so this file
 * computes nothing. It only sends text, paints bubbles, and shows the KPI card.
 */
(function () {
  "use strict";
  var root = document.getElementById("rv-chat");
  if (!root) return;
  var log = document.getElementById("rv-chat-log");
  var pin = document.getElementById("rv-kpi-pin");   // the pinned KPI table (above the log)
  var quick = document.getElementById("rv-chat-quick");
  var form = document.getElementById("rv-chat-form");
  var input = document.getElementById("rv-chat-input");
  var send = document.getElementById("rv-chat-send");
  var sendUrl = root.getAttribute("data-send-url");
  var histUrl = root.getAttribute("data-history-url");

  function token() {
    var m = document.querySelector('input[name="csrf_token"]');
    if (m) return m.value;
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute("content") : "";
  }

  var DASH = "—";
  function cell(v) { return (v === null || v === undefined || v === "") ? DASH : String(v); }

  // Inline-SVG icons for the JS-rendered action buttons -- dependency-free, the
  // same feather-style paths as templates/_review_icons.html so they can't drift.
  // stroke:currentColor, so each icon takes its button's colour.
  function icon(inner) {
    return '<svg class="rv-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' +
      ' aria-hidden="true" focusable="false">' + inner + '</svg>';
  }
  var ICON = {
    check: icon('<path d="M20 6 9 17 4 12"/>'),
    paperclip: icon('<path d="M21.44 11.05 12.25 20.24a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
    eye: icon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'),
    eyeOff: icon('<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-8-10-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>')
  };

  // Keep the newest content in view. Called again AFTER the quick-reply chips
  // render, because the chips shrink the flex log and a scroll done before they
  // appear ends up short -- leaving the last reply hidden behind them.
  function scrollToBottom() { log.scrollTop = log.scrollHeight; }
  function scrollSoon() {
    scrollToBottom();
    if (window.requestAnimationFrame) requestAnimationFrame(scrollToBottom);
    else setTimeout(scrollToBottom, 0);
  }
  // "Show my KPIs" scrolls to the inline KPI table and briefly highlights it.
  function flashPin() {
    var el = tableEl || pin;
    if (!el) return;
    if (el.scrollIntoView) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el.classList.remove("rv-kpi-pin-flash");
    void el.offsetWidth;                 // restart the animation
    el.classList.add("rv-kpi-pin-flash");
  }
  // Does the message read as "show me my KPIs"? (Client-side, model-independent.)
  var SHOW_KPIS_RE = /\b(show|see|view|list|display|pull up|bring up|open|what(?:'?s| is| are))\b[^.?!]{0,25}\bkpi/i;

  function bubble(role, text) {
    var d = document.createElement("div");
    d.className = "rv-msg rv-msg-" + (role === "user" ? "user" : "agent");
    d.textContent = text;
    log.appendChild(d);
    scrollToBottom();
    return d;
  }

  /* ---- the pinned KPI table: a LIVE widget, one flat row per KPI ---------- *
   * Every KPI with its weight, the rating scale inline, a result field, and the
   * computed rating + band -- rendered into #rv-kpi-pin above the log so it is
   * always visible. Rebuilt from the server's `overview` payload every turn, so
   * a result recorded through the chat shows up here immediately. The result
   * field just composes a sentence and sends it to the agent -- the server still
   * records and rates it (one write path).                                     */

  // The rating scale as EQUAL-WIDTH columns (a clean strip), like the PM report:
  // Mech A -> five columns R1..R5, each a rung label over its value, the landed
  // rung filled; Mech B -> a column per part (Threshold / Target / Excellence).
  function scaleStrip(line) {
    var box = document.createElement("div");
    box.className = "rv-scale-grid";
    var cols = [];
    if ((line.scale || []).length) {
      line.scale.forEach(function (r) {
        cols.push({ label: "R" + r.n, value: r.value, hit: line.achieved_n === r.n });
      });
    } else if ((line.scale_b || []).length) {
      line.scale_b.forEach(function (r) { cols.push({ label: r.label, value: r.value, hit: false }); });
    }
    if (!cols.length) { box.textContent = DASH; return box; }
    box.style.gridTemplateColumns = "repeat(" + cols.length + ", 1fr)";
    cols.forEach(function (c) {
      var col = document.createElement("div");
      col.className = "rv-scale-col" + (c.hit ? " rv-scale-hit" : "");
      var l = document.createElement("span"); l.className = "rv-scale-lbl"; l.textContent = c.label;
      var v = document.createElement("span"); v.className = "rv-scale-val"; v.textContent = c.value;
      col.appendChild(l); col.appendChild(v);
      box.appendChild(col);
    });
    return box;
  }

  // The band as the same pill the rest of PM uses (colour keyed on data-band).
  function bandPill(code, title) {
    if (!code) return null;
    var pill = document.createElement("span");
    pill.className = "potential-pill";
    pill.setAttribute("data-band", code);
    if (title) pill.title = title;
    pill.textContent = code;
    return pill;
  }

  function resultCell(line) {
    var box = document.createElement("div");
    // Already keyed: show the value (the rating/band live in their own column).
    if (line.result !== null && line.result !== undefined) {
      var val = document.createElement("div");
      val.className = "rv-res-val";
      val.textContent = line.rating_line ? "Rating " + line.result : line.result + (line.unit ? " " + line.unit : "");
      box.appendChild(val);
      return box;
    }
    // Not keyed and not yours to key.
    if (!line.editable) { box.textContent = DASH; return box; }
    // A 1-5 rating line (2026-10-30): picked from the KPI's own words, never typed; the pick composes the same sentence.
    if (line.rating_line && window.onehrKpiLine && window.onehrKpiLine.pick) {
      var pk = window.onehrKpiLine.pick(line, { onPick: function (n) {
        if (busy) return;
        pk.disabled = true;
        sendTurn('My actual result for "' + line.kpi + '" is ' + n + ".");
      } });
      box.appendChild(pk);
      return box;
    }
    // Fillable: an input + Save that composes a sentence for the agent.
    var wrap = document.createElement("div"); wrap.className = "rv-res-entry";
    var inp = document.createElement("input");
    inp.type = "text"; inp.className = "rv-res-input"; inp.setAttribute("inputmode", "decimal");
    inp.placeholder = line.unit ? ("Result (" + line.unit + ")") : "Enter result";
    inp.setAttribute("aria-label", "Result for " + line.kpi);
    var btn = document.createElement("button");
    btn.type = "button"; btn.className = "rv-res-save";
    btn.innerHTML = ICON.check; btn.setAttribute("aria-label", "Save"); btn.title = "Save";
    function fire() {
      var v = (inp.value || "").trim();
      if (!v || busy) return;
      inp.disabled = true; btn.disabled = true;
      sendTurn('My actual result for "' + line.kpi + '" is ' + v + ".");
    }
    btn.addEventListener("click", fire);
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); fire(); }
    });
    wrap.appendChild(inp); wrap.appendChild(btn);
    box.appendChild(wrap);
    return box;
  }

  // The FINAL SCORE as a standing stat in the status header (weighted overall,
  // server-computed). Coverage shown while partial, so a partial is never a total.
  function finalStat(overall) {
    var box = document.createElement("div"); box.className = "rv-final-stat";
    var lbl = document.createElement("span"); lbl.className = "rv-final-lbl"; lbl.textContent = "Final";
    box.appendChild(lbl);
    if (!overall) {
      var d = document.createElement("span"); d.className = "rv-final-num"; d.textContent = DASH;
      box.appendChild(d); return box;
    }
    var v = document.createElement("span"); v.className = "rv-final-num";
    v.textContent = overall.value + (overall.mechanism === "B" ? "" : " / 5");
    box.appendChild(v);
    var pill = bandPill(overall.band_code, overall.band);
    if (pill) box.appendChild(pill);
    if (overall.covered != null && overall.total && overall.covered < overall.total) {
      var cov = document.createElement("span"); cov.className = "rv-final-cov";
      cov.textContent = "covering " + Math.round(overall.covered) + "%";
      box.appendChild(cov);
    }
    return box;
  }

  // The current KPI = the first line that is yours to key and not yet keyed.
  function firstCurrent(lines) {
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].editable && (lines[i].result === null || lines[i].result === undefined)) return lines[i];
    }
    return null;
  }

  // The KPI table can be expanded/minimized; the choice is remembered per browser
  // (localStorage, never the DOM -- the header is rebuilt every turn).
  var tableOpen = true;
  try { tableOpen = localStorage.getItem("rv-kpi-open") !== "0"; } catch (e) {}
  // The toggle shows the table's STATE as an eye (shown) / eye-off (hidden) icon
  // beside a constant "KPIs" label; the action verb lives in the title + aria.
  function paintToggle(tog) {
    tog.setAttribute("aria-expanded", tableOpen ? "true" : "false");
    tog.title = tableOpen ? "Hide the KPI table" : "Show the KPI table";
    tog.innerHTML = (tableOpen ? ICON.eye : ICON.eyeOff) +
      '<span class="rv-toggle-lbl">KPIs</span>';
  }
  function setTableOpen(open) {
    tableOpen = !!open;
    try { localStorage.setItem("rv-kpi-open", tableOpen ? "1" : "0"); } catch (e) {}
    if (tableEl) tableEl.hidden = !tableOpen;
    var tog = pin && pin.querySelector(".rv-table-toggle");
    if (tog) paintToggle(tog);
    syncLogInset();
  }

  // The slim summary line: progress dots, the current KPI, the Final stat, and a
  // toggle to expand/minimize the KPI table. No editable state -- rebuilt each turn.
  function buildStatusHeader(data) {
    var lines = (data && data.lines) || [];
    var current = firstCurrent(lines);
    var wrap = document.createElement("div"); wrap.className = "rv-status";

    var dots = document.createElement("div"); dots.className = "rv-dots";
    lines.forEach(function (l) {
      var dot = document.createElement("span"); dot.className = "rv-dot"; dot.title = l.kpi;
      if (l.result !== null && l.result !== undefined) {
        dot.classList.add("rv-dot-done");
        if (l.band_code) dot.setAttribute("data-band", l.band_code);
      } else if (current && l.kpi_id === current.kpi_id) {
        dot.classList.add("rv-dot-current");
      }
      dots.appendChild(dot);
    });
    wrap.appendChild(dots);

    var now = document.createElement("span"); now.className = "rv-now";
    if (current) {
      var lbl = document.createElement("span"); lbl.className = "rv-now-lbl"; lbl.textContent = "Now: ";
      var nm = document.createElement("span"); nm.className = "rv-now-kpi"; nm.textContent = current.kpi;
      now.appendChild(lbl); now.appendChild(nm);
    } else {
      now.textContent = lines.length ? "All results recorded" : "No KPIs this period";
    }
    wrap.appendChild(now);

    // Pending confirmation vs Confirmed -- the sign-off state, once anything is keyed.
    var locked = !!(data && data.locked);
    var anyKeyed = lines.some(function (l) { return l.result !== null && l.result !== undefined; });
    if (locked || anyKeyed) {
      var stateChip = document.createElement("span");
      stateChip.className = "rv-confirm-state " + (locked ? "rv-confirm-state-done" : "rv-confirm-state-pending");
      stateChip.textContent = locked ? "Confirmed" : "Pending confirmation";
      wrap.appendChild(stateChip);
    }

    var right = document.createElement("div"); right.className = "rv-status-right";
    right.appendChild(finalStat(data && data.overall));
    var tog = document.createElement("button");
    tog.type = "button"; tog.className = "rv-table-toggle";
    paintToggle(tog);
    tog.addEventListener("click", function () { setTableOpen(!tableOpen); });
    right.appendChild(tog);
    wrap.appendChild(right);
    return wrap;
  }

  function th(text, opts) {
    var el = document.createElement("th");
    if (text) el.textContent = text;
    if (opts && opts.colspan) el.colSpan = opts.colspan;
    if (opts && opts.rowspan) el.rowSpan = opts.rowspan;
    if (opts && opts.cls) el.className = opts.cls;
    return el;
  }

  // The full KPI table shown INLINE in the chat -- every KPI, all fillable at once.
  // Mech A heads the rungs 1-5 (landed rung band-coloured, no rating column); Mech B
  // heads its references + a Rating column; a mix falls back to one scale-strip column
  // + a Rating column. The Result column is the editable field on every editable KPI.
  var tableEl = null, tableCtx = null, rowById = {}, rowVal = {};

  // the KPI, its Focus tag and the person's description (static/kpi_line.js; board 22)
  function klName(el_, l, full) { var K = window.onehrKpiLine; if (K) K.name(el_, l, full); else el_.textContent = full || ""; return el_; }
  function klDesc(l, cls) { var K = window.onehrKpiLine; return K ? K.desc(l, cls) : null; }
  function rowCells(tr, l, ctx) {
    tr.innerHTML = "";
    tr.setAttribute("data-kpi", l.kpi_id);
    var kc = document.createElement("td"); kc.className = "rv-kpi-cell";
    var nm = document.createElement("div"); nm.className = "rv-kpi-name"; klName(nm, l, l.kpi); kc.appendChild(nm);
    var meta = [l.direction_say || l.direction, l.category].filter(Boolean).join(" · ");
    if (meta) { var m = document.createElement("div"); m.className = "rv-kpi-meta"; m.textContent = meta; kc.appendChild(m); }
    var dsc = klDesc(l) || (l.detail ? (function () { var x = document.createElement("div"); x.className = "rv-kpi-desc"; x.textContent = l.detail; return x; })() : null);
    if (dsc) kc.appendChild(dsc);
    tr.appendChild(kc);
    var wc = document.createElement("td"); wc.textContent = (l.weight != null ? l.weight + "%" : DASH); tr.appendChild(wc);
    if (ctx.mechA) {
      var byN = {}; (l.scale || []).forEach(function (r) { byN[r.n] = r.value; });
      [1, 2, 3, 4, 5].forEach(function (n) {
        var td = document.createElement("td");
        td.className = "rv-rung" + (l.achieved_n === n ? " rv-scale-hit" : "");
        if (l.achieved_n === n && l.band_code) td.setAttribute("data-band", l.band_code);
        td.textContent = (byN[n] != null ? byN[n] : DASH);
        tr.appendChild(td);
      });
    } else if (ctx.mechB) {
      var byLab = {}; (l.scale_b || []).forEach(function (r) { byLab[r.label] = r.value; });
      ctx.bLabels.forEach(function (lab) {
        var td = document.createElement("td"); td.className = "rv-rung";
        td.textContent = (byLab[lab] != null ? byLab[lab] : DASH);
        tr.appendChild(td);
      });
    } else {
      var scd = document.createElement("td"); scd.className = "rv-scale-cell"; scd.appendChild(scaleStrip(l)); tr.appendChild(scd);
    }
    // Result -- the EDITABLE field (input if yours + unkeyed, value if keyed).
    var rc = document.createElement("td"); rc.className = "rv-kpi-result"; rc.appendChild(resultCell(l)); tr.appendChild(rc);
    if (!ctx.mechA) {
      var rat = document.createElement("td"); rat.className = "rv-rating-cell";
      if (l.rating) {
        if (l.band_code) rat.setAttribute("data-band", l.band_code);
        var rv = document.createElement("span"); rv.className = "rv-rating-val"; rv.textContent = l.rating; rat.appendChild(rv);
        var bp = bandPill(l.band_code, l.band); if (bp) { bp.classList.add("rv-rating-pill"); rat.appendChild(bp); }
      } else { rat.textContent = DASH; }
      tr.appendChild(rat);
    }
  }

  function buildKpiTable(data) {
    var lines = (data && data.lines) || [];
    var mechA = lines.length > 0 && lines.every(function (l) { return (l.scale || []).length === 5; });
    var mechB = !mechA && lines.length > 0 && lines.every(function (l) { return (l.scale_b || []).length > 0; });
    var bLabels = mechB ? (lines[0].scale_b || []).map(function (r) { return r.label; }) : [];
    tableCtx = { mechA: mechA, mechB: mechB, bLabels: bLabels };
    var wrap = document.createElement("div"); wrap.className = "rv-card rv-kpi-overview rv-kpi-inline";
    var tbl = document.createElement("table");
    tbl.className = "rv-scorecard rv-kpi-flat" + (mechA ? " rv-kpi-mechA" : mechB ? " rv-kpi-mechB" : "");
    var thead = document.createElement("thead");
    if (mechA) {
      var ar1 = document.createElement("tr");
      ar1.appendChild(th("KPI", { rowspan: 2 })); ar1.appendChild(th("Weight", { rowspan: 2 }));
      ar1.appendChild(th("Rating scale", { colspan: 5, cls: "rv-scale-grouphead" }));
      ar1.appendChild(th("Result", { rowspan: 2, cls: "rv-kpi-result" }));
      var ar2 = document.createElement("tr");
      [1, 2, 3, 4, 5].forEach(function (n) { ar2.appendChild(th(String(n), { cls: "rv-rung-head" })); });
      thead.appendChild(ar1); thead.appendChild(ar2);
    } else if (mechB) {
      var br1 = document.createElement("tr");
      br1.appendChild(th("KPI", { rowspan: 2 })); br1.appendChild(th("Weight", { rowspan: 2 }));
      br1.appendChild(th("Rating scale", { colspan: bLabels.length || 1, cls: "rv-scale-grouphead" }));
      br1.appendChild(th("Result", { rowspan: 2, cls: "rv-kpi-result" })); br1.appendChild(th("Rating", { rowspan: 2 }));
      var br2 = document.createElement("tr");
      bLabels.forEach(function (lab) { br2.appendChild(th(lab, { cls: "rv-rung-head" })); });
      thead.appendChild(br1); thead.appendChild(br2);
    } else {
      var hr = document.createElement("tr");
      ["KPI", "Weight", "Rating scale", "Result", "Rating"].forEach(function (h) { hr.appendChild(th(h)); });
      thead.appendChild(hr);
    }
    tbl.appendChild(thead);
    var tb = document.createElement("tbody");
    rowById = {}; rowVal = {};
    lines.forEach(function (l) {
      var tr = document.createElement("tr"); rowCells(tr, l, tableCtx); tb.appendChild(tr);
      rowById[l.kpi_id] = tr; rowVal[l.kpi_id] = (l.result != null ? l.result : null);
    });
    tbl.appendChild(tb); wrap.appendChild(tbl);
    return wrap;
  }

  // Update recorded rows in place -- never rebuild an unfilled row (its open input,
  // and any half-typed value, must survive turns).
  function refreshTableRows(data) {
    var lines = (data && data.lines) || [];
    lines.forEach(function (l) {
      var tr = rowById[l.kpi_id]; if (!tr) return;
      var nv = (l.result != null ? l.result : null);
      if (rowVal[l.kpi_id] !== nv) { rowCells(tr, l, tableCtx); rowVal[l.kpi_id] = nv; }
    });
  }

  // Inset the log by the floating card's height WHILE the card is actually overlaying
  // (position:absolute), so the opening message isn't hidden under it; cleared on
  // mobile (static) / no card. Recomputed each refresh and, debounced, on resize.
  function syncLogInset() {
    if (!log) return;
    var overlaying = tableEl && !tableEl.hidden &&
      getComputedStyle(tableEl).position === "absolute";
    log.style.paddingTop = overlaying
      ? (Math.round(tableEl.getBoundingClientRect().height) + 18) + "px" : "";
  }

  // #rv-kpi-pin holds the slim summary line (rebuilt each turn). The full editable
  // KPI table lives in the chat log (built once, rows updated in place), so the user
  // keys in all results at once and half-typed inputs survive turns.
  function refreshOverview(data) {
    if (!pin) return;
    // ABSENT is not EMPTY: a degraded turn returns no overview; ignoring undefined
    // keeps the pinned KPI table on screen. null / no lines still clears.
    if (data === undefined) return;
    if (!data || !((data.lines || []).length)) {
      pin.innerHTML = ""; if (tableEl) { tableEl.remove(); tableEl = null; } syncLogInset(); return;
    }
    pin.innerHTML = "";
    pin.appendChild(buildStatusHeader(data));
    if (!tableEl) {
      tableEl = buildKpiTable(data);
      // FLOAT it over the chat (a child of #rv-chat, absolutely positioned) rather
      // than inserting it into the log flow -- so toggling "KPIs" does NOT push the
      // conversation down; the dialogue stays put and the table overlays the top.
      root.insertBefore(tableEl, root.firstChild);
      scrollSoon();
    } else {
      refreshTableRows(data);
    }
    tableEl.hidden = !tableOpen;   // re-apply the expand/minimize choice each turn
    syncLogInset();
  }

  // The scorecard table (KPI · Weight · Actual · Rating · Band + an overall line),
  // shared by the show_scorecard card and the final confirm card. Returns a fragment.
  var BU_ACTUAL_TITLE = "Group People fills this once for everyone who shares the unit's result";
  function scorecardTable(d, overallLabel) {
    var frag = document.createDocumentFragment();
    var tbl = document.createElement("table"); tbl.className = "rv-scorecard";
    var thead = document.createElement("thead"); var htr = document.createElement("tr");
    ["KPI", "Weight", "Actual", "Rating", "Band"].forEach(function (h) {
      var th = document.createElement("th"); th.textContent = h; htr.appendChild(th);
    });
    thead.appendChild(htr); tbl.appendChild(thead);
    var tb = document.createElement("tbody");
    (d.lines || []).forEach(function (l) {
      var tr = document.createElement("tr");
      [l.kpi, (l.weight != null ? l.weight + "%" : DASH),
       (l.actual != null ? l.actual : (l.bu_level ? "Group People" : DASH)),
       cell(l.rating), cell(l.band)].forEach(function (v, i) {
        var td = document.createElement("td"); td.textContent = v;
        if (i === 2 && l.actual == null && l.bu_level) td.title = BU_ACTUAL_TITLE;   // the BU line's Actual cell: why it is not the person's to key
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); frag.appendChild(tbl);
    if (d.overall) {
      var o = document.createElement("div"); o.className = "rv-scorecard-overall";
      var txt = (overallLabel || "Overall so far: ") + d.overall.value +
                (d.overall.band ? " · " + d.overall.band : "");
      if (d.overall.covered && d.overall.total && d.overall.covered < d.overall.total) {
        txt += " (covering " + Math.round(d.overall.covered) + "% of "
             + Math.round(d.overall.total) + "%)";
      }
      o.textContent = txt; frag.appendChild(o);
    }
    // The overall remark that goes with the results -- always shown, so nothing reaches the approver
    // under their name that they didn't see on this card (Chris, 2026-09-24).
    if (d.overall_remark) {
      var rem = document.createElement("div"); rem.className = "rv-sc-remark";
      var rh = document.createElement("div"); rh.className = "rv-sc-remark-h"; rh.textContent = "Overall remark";
      var rb = document.createElement("div"); rb.textContent = d.overall_remark;
      rem.appendChild(rh); rem.appendChild(rb); frag.appendChild(rem);
    }
    return frag;
  }

  // The FINAL sign-off card: a warning, the final scorecard, the justification recap,
  // and a Confirm / Not-yet choice. Confirm posts to /review/confirm (the one lock).
  function buildConfirmCard(d, done) {
    var wrap = document.createElement("div");
    wrap.className = "rv-msg rv-msg-agent rv-card rv-confirm" + (done ? " rv-confirm-done" : "");
    if (!done) {
      var warn = document.createElement("div"); warn.className = "rv-confirm-warn";
      warn.textContent = "Review carefully — once you confirm, your results and remark are submitted "
                       + "and locked. You won't be able to change them after this.";
      wrap.appendChild(warn);
    }
    var h = document.createElement("div"); h.className = "rv-confirm-head";
    h.textContent = "Your final scorecard"; wrap.appendChild(h);
    wrap.appendChild(scorecardTable(d, "Overall: "));
    var just = d.justification || [];
    if (just.length) {
      var jh = document.createElement("div"); jh.className = "rv-confirm-subhead";
      jh.textContent = "What backs it"; wrap.appendChild(jh);
      var ul = document.createElement("ul"); ul.className = "rv-confirm-just";
      just.forEach(function (j) {
        var li = document.createElement("li");
        if (j.kpi) { var b = document.createElement("strong"); b.textContent = j.kpi + ": "; li.appendChild(b); }
        li.appendChild(document.createTextNode(j.text || "")); ul.appendChild(li);
      });
      wrap.appendChild(ul);
    }
    if (done) {   // already confirmed: the final card, no button (Chris, 2026-09-24)
      var lk = document.createElement("div"); lk.className = "rv-confirm-locked";
      lk.textContent = "Submitted — locked in."; wrap.appendChild(lk);
      return wrap;
    }
    var actions = document.createElement("div"); actions.className = "rv-confirm-actions";
    var yes = document.createElement("button"); yes.type = "button";
    yes.className = "rv-confirm-yes"; yes.textContent = "Confirm & submit";
    yes.addEventListener("click", function () { doConfirm(yes, wrap); });
    // No "Not yet" -- to change anything the person just keeps chatting (Chris).
    actions.appendChild(yes); wrap.appendChild(actions);
    return wrap;
  }

  function doConfirm(btn, wrap) {
    btn.disabled = true;
    var f = new FormData(); f.append("csrf_token", token());
    fetch("/review/confirm", { method: "POST", body: f, credentials: "same-origin" })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (j && j.ok && j.locked) {
          var a = wrap.querySelector(".rv-confirm-actions"); if (a) a.remove();
          var w0 = wrap.querySelector(".rv-confirm-warn"); if (w0) w0.remove();
          wrap.classList.add("rv-confirm-done");
          if (!wrap.querySelector(".rv-confirm-locked")) {
            var lk = document.createElement("div"); lk.className = "rv-confirm-locked";
            lk.textContent = "Submitted — locked in."; wrap.appendChild(lk);
          }
          bubble("agent", "Locked in — your results and remark are submitted. You can no longer change them.");
          if (j.overview) refreshOverview(j.overview);
          scrollSoon();
        } else {
          btn.disabled = false;
          bubble("agent", (j && j.error) || "Couldn't confirm — please try again.");
        }
      })
      .catch(function () { btn.disabled = false; bubble("agent", "Couldn't confirm — please try again."); });
  }

  // A card shown IN the chat (a point-in-time snapshot, part of the transcript).
  function renderCard(card, locked) {
    if (!card) return;
    // Legacy persisted kpi_overview cards -- the live KPI table is now inline
    // (buildKpiTable); render any old stored one as a read-only snapshot.
    if (card.type === "kpi_overview") {
      log.appendChild(buildKpiTable(card.data || {})); scrollToBottom(); return;
    }
    if (card.type === "confirm") {
      var cd = card.data || {};
      log.appendChild(buildConfirmCard(cd, !!(locked || cd.submitted))); scrollSoon(); return;
    }
    if (card.type !== "scorecard") return;
    var wrap = document.createElement("div");
    wrap.className = "rv-msg rv-msg-agent rv-card";
    wrap.appendChild(scorecardTable(card.data || {}));
    log.appendChild(wrap); log.scrollTop = log.scrollHeight;
  }

  function setQuick(items) {
    quick.innerHTML = "";
    (items || []).forEach(function (t) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "rv-chip";
      b.textContent = t;
      b.addEventListener("click", function () { sendTurn(t); });
      quick.appendChild(b);
    });
  }

  // After an example is logged, offer to attach a supporting file to THAT item.
  // A chip-styled <label> wrapping a hidden file input (the server's types and caps; a photo shrinks first).
  function showAttach(eid) {
    if (!eid) return;
    var lab = document.createElement("label");
    lab.className = "rv-chip rv-attach";
    lab.setAttribute("aria-label", "Attach a file");
    lab.title = "Attach a file";
    // Labelled control (paperclip + text): a file can't be pasted into the chat.
    lab.innerHTML = ICON.paperclip + "<span class=\"rv-attach-lbl\">Attach a file</span>";
    var inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt";
    inp.style.display = "none";
    inp.addEventListener("change", function () {
      if (inp.files && inp.files[0]) uploadAttachment(eid, inp.files[0], lab);
    });
    lab.appendChild(inp);
    quick.appendChild(lab);
  }

  function uploadAttachment(eid, file0, lab) {
    // Icon-only chip: signal progress with a busy class + tooltip, and report the
    // outcome in a bubble (there is no visible text to swap).
    lab.classList.add("rv-attach-busy");
    lab.title = "Uploading " + file0.name + "…";
    (window.onehrShrink ? window.onehrShrink.file(file0) : Promise.resolve(file0)).then(function (file) { uploadAttachmentNow(eid, file, lab); });
  }
  function uploadAttachmentNow(eid, file, lab) {
    var f = new FormData();
    f.append("csrf_token", token());
    f.append("file", file);
    fetch("/review/evidence/" + eid + "/attach",
          { method: "POST", body: f, credentials: "same-origin" })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (j && j.ok) {
          bubble("agent", "Attached: " + (j.filename || file.name));
          lab.remove();
          scrollSoon();
        } else {
          lab.classList.remove("rv-attach-busy");
          lab.title = "Attach a file";
          bubble("agent", (j && j.error) || "Couldn't attach that file.");
        }
      })
      .catch(function () {
        lab.classList.remove("rv-attach-busy");
        lab.title = "Attach a file";
        bubble("agent", "Couldn't attach that file — try again.");
      });
  }

  var busy = false;
  // sendTurn(explicit) posts a turn. With no argument it reads the composer; with a
  // string it sends that exact message (used by quick-replies and the result
  // field) without disturbing what the person may be typing.
  function sendTurn(explicit) {
    if (busy) return;
    if (winClosed) { bubble("agent", winClosed); scrollSoon(); return; }
    var fromInput = (explicit === undefined);
    var msg = fromInput ? (input.value || "").trim() : String(explicit);
    // An empty send is allowed ONLY as the very first turn (to get the greeting).
    // Gate on actual message bubbles, not any child -- the pinned KPI island is
    // the log's first child now, so log.children is never empty.
    if (!msg && log.querySelector(".rv-msg")) return;
    if (msg) bubble("user", msg);
    if (fromInput) { input.value = ""; input.style.height = ""; }
    setQuick([]);
    busy = true;
    send_btn_disabled(true);
    var typing = bubble("agent", "…");
    typing.classList.add("rv-typing");
    var f = new FormData();
    f.append("csrf_token", token());
    f.append("message", msg);
    fetch(sendUrl, { method: "POST", body: f, credentials: "same-origin" })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        typing.remove();
        if (j && j.say) bubble("agent", j.say);
        if (j && j.window_closed) lockClosed(j.window_note);
        (j && j.renders || []).forEach(function (c) { renderCard(c); });   // live: never pass forEach's index as `locked`
        refreshOverview(j && j.overview);
        setQuick(j && j.quick_replies);
        if (j && j.attach_to) showAttach(j.attach_to);   // offer to attach a file
        if (j && j.rail_html) swapRail(j.rail_html);
        // The KPI table is pinned at the top; if they asked to see it, flash it.
        if (SHOW_KPIS_RE.test(msg)) flashPin();
        scrollSoon();
      })
      .catch(function () { typing.remove(); bubble("agent", "(connection lost — try again)"); })
      .then(function () { busy = false; send_btn_disabled(false); });
  }

  function send_btn_disabled(v) { send.disabled = v || !!winClosed; }
  // A closed part (its window on the admin's Calendar; Chris, 2026-10-20): the box takes nothing more and the
  // conversation stays to read. The server refuses a message that still arrives (window_closed in its reply).
  var winClosed = root.getAttribute("data-window-closed") || null;
  function lockClosed(note) {
    winClosed = note || winClosed || "This part is closed.";
    input.value = ""; input.disabled = true; send.disabled = true; input.placeholder = winClosed;
    setQuick([]);
  }

  // Live-refresh the rail so its KPI counts tick down as we record.
  function swapRail(html) {
    var old = document.querySelector(".rv-rail");
    if (!old) return;
    var tmp = document.createElement("div");
    tmp.innerHTML = html;
    var fresh = tmp.querySelector(".rv-rail");
    if (fresh) old.replaceWith(fresh);
  }

  form.addEventListener("submit", function (e) { e.preventDefault(); sendTurn(); });
  // Enter sends; Shift+Enter is a newline. Grow the box a little as you type.
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTurn(); }
  });
  input.addEventListener("input", function () {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  });
  var _insetTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(_insetTimer);
    _insetTimer = setTimeout(syncLogInset, 120);
  });

  // Load the transcript, then greet if it is empty.
  fetch(histUrl, { credentials: "same-origin" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (!j) return;
      var msgs = j.messages || [];
      var isLocked = !!(j.overview && j.overview.locked);
      msgs.forEach(function (m) {
        bubble(m.role, m.content);
        (m.card || []).forEach(function (c) { renderCard(c, isLocked); });   // persisted cards; a confirmed
      });                                                                   // check-in replays its card locked
      if (msgs.length) refreshOverview(j.overview);   // the live KPI widget
      var last = msgs[msgs.length - 1];
      if (last && last.role === "agent" && last.quick_replies) setQuick(last.quick_replies);
      scrollSoon();   // land at the newest turn, below the restored chips
      if (winClosed) {   // closed: no opening turn, the box locked
        if (!msgs.length) bubble("agent", winClosed + " You can still look through it.");
        lockClosed(winClosed);
        return;
      }
      if (root.getAttribute("data-unavailable")) {
        if (!msgs.length) {
          bubble("agent", "The review assistant isn't switched on yet — ask your admin to enable it.");
        }
        input.disabled = true; send.disabled = true;
        return;
      }
      if (!msgs.length) sendTurn();   // empty conversation -> get the opener (+ the card)
    });
})();
