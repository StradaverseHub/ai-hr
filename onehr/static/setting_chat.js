/* The conversational KPI-SETTING agent's client.
 *
 * A plain chat: render the stored transcript, send the employee's message to
 * /review/setting/chat, append the agent's reply, show its quick-reply chips. The
 * SERVER decides everything -- what to add, the 100%-weight rule, completeness --
 * so this file computes nothing. It sends text, paints bubbles, shows the
 * scorecard-being-built, and (on the confirm card) posts the human Submit.
 *
 * Deliberately a SEPARATE file from review_chat.js: the check-in is live, and its
 * widget (a rating scale + result field) is a different thing from this one (a
 * weight total + completeness). It reuses the same rv-* CSS classes.
 */
(function () {
  "use strict";
  var root = document.getElementById("rv-chat");
  if (!root) return;
  var log = document.getElementById("rv-chat-log");
  var pin = document.getElementById("rv-kpi-pin");   // the pinned scorecard summary
  var quick = document.getElementById("rv-chat-quick");
  var form = document.getElementById("rv-chat-form");
  var input = document.getElementById("rv-chat-input");
  var send = document.getElementById("rv-chat-send");
  var sendUrl = root.getAttribute("data-send-url");
  var histUrl = root.getAttribute("data-history-url");
  var proposeUrl = root.getAttribute("data-propose-url");
  var unitUrl = root.getAttribute("data-unit-url");

  function token() {
    var m = document.querySelector('input[name="csrf_token"]');
    if (m) return m.value;
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute("content") : "";
  }

  var DASH = "—";
  function cell(v) { return (v === null || v === undefined || v === "") ? DASH : String(v); }

  function icon(inner) {
    return '<svg class="rv-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' +
      ' aria-hidden="true" focusable="false">' + inner + '</svg>';
  }
  var ICON = {
    check: icon('<path d="M20 6 9 17 4 12"/>'),
    eye: icon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'),
    eyeOff: icon('<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-8-10-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>')
  };

  function scrollToBottom() { log.scrollTop = log.scrollHeight; }
  function scrollSoon() {
    scrollToBottom();
    if (window.requestAnimationFrame) requestAnimationFrame(scrollToBottom);
    else setTimeout(scrollToBottom, 0);
  }
  function flashPin() {
    var el = tableEl || pin;
    if (!el) return;
    if (el.scrollIntoView) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el.classList.remove("rv-kpi-pin-flash");
    void el.offsetWidth;
    el.classList.add("rv-kpi-pin-flash");
  }
  var SHOW_KPIS_RE = /\b(show|see|view|list|display|pull up|bring up|open|what(?:'?s| is| are))\b[^.?!]{0,30}\b(kpi|scorecard)/i;

  function bubble(role, text) {
    var d = document.createElement("div");
    d.className = "rv-msg rv-msg-" + (role === "user" ? "user" : "agent");
    d.textContent = text;
    log.appendChild(d);
    scrollToBottom();
    return d;
  }

  /* ---- the pinned scorecard-being-built: a LIVE widget ---------------------- *
   * Every chosen KPI with its weight, its target scale, and whether it is
   * complete -- rebuilt from the server's `overview` payload every turn, so an
   * add / weight / target set through the chat shows up here immediately. The
   * weight cell composes a sentence and sends it to the agent (one write path).  */

  // The rating scale as equal-width columns (reference only, no landed rung):
  // Mech A -> R1..R5, Mech B -> Threshold / Target / Excellence|Multiplier.
  function scaleStrip(line) {
    var box = document.createElement("div");
    box.className = "rv-scale-grid";
    var cols = [];
    if ((line.scale || []).length) {
      line.scale.forEach(function (r) { cols.push({ label: "R" + r.n, value: r.value }); });
    } else if ((line.scale_b || []).length) {
      line.scale_b.forEach(function (r) { cols.push({ label: r.label, value: r.value }); });
    }
    if (!cols.length) { box.textContent = "no target yet"; box.className = "rv-scale-empty"; return box; }
    box.style.gridTemplateColumns = "repeat(" + cols.length + ", 1fr)";
    cols.forEach(function (c) {
      var col = document.createElement("div"); col.className = "rv-scale-col";
      var l = document.createElement("span"); l.className = "rv-scale-lbl"; l.textContent = c.label;
      var v = document.createElement("span"); v.className = "rv-scale-val"; v.textContent = c.value;
      col.appendChild(l); col.appendChild(v); box.appendChild(col);
    });
    return box;
  }

  // The weight cell: read-only text once the set is locked; otherwise an input +
  // Save that composes a sentence for the agent (the server validates + writes).
  function weightCell(line, editable) {
    var box = document.createElement("div");
    if (!editable) {
      box.textContent = (line.weight ? line.weight + "%" : DASH);
      return box;
    }
    var wrap = document.createElement("div"); wrap.className = "rv-res-entry";
    var inp = document.createElement("input");
    inp.type = "text"; inp.className = "rv-res-input rv-weight-input";
    inp.setAttribute("inputmode", "decimal");
    inp.value = (line.weight ? line.weight : "");
    inp.setAttribute("aria-label", "Weight for " + line.kpi);
    var pct = document.createElement("span"); pct.className = "rv-weight-pct"; pct.textContent = "%";
    var btn = document.createElement("button");
    btn.type = "button"; btn.className = "rv-res-save";
    btn.innerHTML = ICON.check; btn.setAttribute("aria-label", "Save weight"); btn.title = "Save weight";
    function fire() {
      var v = (inp.value || "").trim();
      if (!v || busy) return;
      inp.disabled = true; btn.disabled = true;
      sendTurn('Set the weight for "' + line.kpi + '" to ' + v + "%.");
    }
    btn.addEventListener("click", fire);
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); fire(); }
    });
    wrap.appendChild(inp); wrap.appendChild(pct); wrap.appendChild(btn);
    box.appendChild(wrap);
    return box;
  }

  // The KPI table can be expanded/minimized; the choice is remembered per browser.
  var tableOpen = true;
  try { tableOpen = localStorage.getItem("rv-set-open") !== "0"; } catch (e) {}
  function paintToggle(tog) {
    tog.setAttribute("aria-expanded", tableOpen ? "true" : "false");
    tog.title = tableOpen ? "Hide the scorecard" : "Show the scorecard";
    tog.innerHTML = (tableOpen ? ICON.eye : ICON.eyeOff) +
      '<span class="rv-toggle-lbl">KPIs</span>';
  }
  function setTableOpen(open) {
    tableOpen = !!open;
    try { localStorage.setItem("rv-set-open", tableOpen ? "1" : "0"); } catch (e) {}
    if (tableEl) tableEl.hidden = !tableOpen;
    var tog = pin && pin.querySelector(".rv-table-toggle");
    if (tog) paintToggle(tog);
    syncLogInset();
  }

  // The slim summary line: the running WEIGHT TOTAL with a 100% indicator, a
  // count still to complete, the state chip, and the expand/minimize toggle.
  function buildStatusHeader(data) {
    var lines = (data && data.lines) || [];
    var wrap = document.createElement("div"); wrap.className = "rv-status";

    var tv = (data && data.total_weight != null) ? data.total_weight : 0;
    var wt = document.createElement("div");
    wt.className = "rv-weight-total " + (data && data.weight_ok ? "rv-weight-ok" : "rv-weight-short");
    var wl = document.createElement("span"); wl.className = "rv-weight-lbl"; wl.textContent = "Weight";
    var wn = document.createElement("span"); wn.className = "rv-weight-num"; wn.textContent = tv + "% / 100%";
    wt.appendChild(wl); wt.appendChild(wn); wrap.appendChild(wt);

    var now = document.createElement("span"); now.className = "rv-now";
    if (!lines.length) now.textContent = "No KPIs yet";
    else if (data.n_incomplete) now.textContent = data.n_incomplete + " still to complete";
    else if (!data.weight_ok) now.textContent = "Adjust weights to 100%";
    else now.textContent = "Ready to submit";
    wrap.appendChild(now);

    var chip = document.createElement("span");
    var st = data && data.state, label;
    if (st === "proposed") { chip.className = "rv-confirm-state rv-confirm-state-done"; label = "With " + ((data && data.blocked_on) || "your approver"); }
    else if (st === "returned") { chip.className = "rv-confirm-state rv-confirm-state-pending"; label = "Returned — revise"; }
    else if (data && !data.editable && lines.length) { chip.className = "rv-confirm-state rv-confirm-state-done"; label = "Agreed"; }
    else { chip.className = "rv-confirm-state rv-confirm-state-pending"; label = "Draft"; }
    chip.textContent = label; wrap.appendChild(chip);

    var right = document.createElement("div"); right.className = "rv-status-right";
    var tog = document.createElement("button");
    tog.type = "button"; tog.className = "rv-table-toggle"; paintToggle(tog);
    tog.addEventListener("click", function () { setTableOpen(!tableOpen); });
    right.appendChild(tog); wrap.appendChild(right);
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

  // The scorecard-being-built table: KPI (name · direction/category · description) ·
  // Weight (editable) · the rating scale as 1-5 (Mech A) or reference (Mech B) COLUMN
  // HEADERS -- the same flat layout as the check-in table -- · Status.
  var tableEl = null, tableCtx = null, rowById = {}, rowSig = {};

  function rowSignature(l) {
    return JSON.stringify([l.weight, l.complete, l.scale, l.scale_b, l.detail, l.unit]);
  }

  // the KPI, its Focus tag and the person's description (static/kpi_line.js; board 22)
  function klName(el_, l, full) { var K = window.onehrKpiLine; if (K) K.name(el_, l, full); else el_.textContent = full || ""; return el_; }
  function klDesc(l, cls) { var K = window.onehrKpiLine; return K ? K.desc(l, cls) : null; }
  // The unit offers, a strip under the card's header, one a line (2026-10-18, board 23): "Sales revenue: these figures
  // are in the millions. Show them in RM (mil)? 15,900,000 becomes 15.9." Use moves the line and its figures
  // (/review/setting/unit, the agent's set_unit writer); Keep hides it for this visit. Nothing changes without a click.
  var unitKept = {};
  function unitOffers(data) {
    var box = document.createElement("div"); box.className = "ku-offers";
    if (data.editable) (data.lines || []).forEach(function (l) { var b = unitOffer(l); if (b) box.appendChild(b); });
    return box.children.length ? box : null;
  }
  function unitOffer(l) {
    var o = l.unit_offer;
    if (!o || !unitUrl || unitKept[l.kpi_id + ">" + o.unit]) return null;
    var bar = document.createElement("div"); bar.className = "ku-bar"; bar.setAttribute("role", "status");
    var txt = document.createElement("span"); txt.className = "ku-txt";
    var nm = document.createElement("b"); nm.textContent = (l.base || l.kpi) + (l.focus ? " · " + l.focus : "") + ": ";
    txt.appendChild(nm);
    txt.appendChild(document.createTextNode(o.words + " Show them in " + o.unit + "? " + o.was + " becomes " + o.now + "."));
    var use = document.createElement("button"); use.type = "button"; use.className = "ku-use"; use.textContent = "Use " + o.unit;
    var keep = document.createElement("button"); keep.type = "button"; keep.className = "btn-link ku-keep"; keep.textContent = "Keep " + o.from;
    use.addEventListener("click", function () {
      if (busy) return;
      use.disabled = true;
      var f = new FormData();
      f.append("csrf_token", token()); f.append("kpi_id", l.kpi_id); f.append("unit", o.unit);
      fetch(unitUrl, { method: "POST", body: f, credentials: "same-origin" })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) {
          if (j && j.error) { bubble("agent", j.error); use.disabled = false; }
          refreshOverview(j && j.overview);
        })
        .catch(function () { use.disabled = false; bubble("agent", "(connection lost — try again)"); });
    });
    keep.addEventListener("click", function () {
      unitKept[l.kpi_id + ">" + o.unit] = 1;
      var box = bar.parentNode; bar.remove();
      if (box && !box.children.length) box.remove();
      syncLogInset();
    });
    bar.appendChild(txt); bar.appendChild(use); bar.appendChild(keep);
    return bar;
  }
  function rowCells(tr, l, ctx) {
    tr.innerHTML = "";
    tr.setAttribute("data-kpi", l.kpi_id);
    var kc = document.createElement("td"); kc.className = "rv-kpi-cell";
    var nm = document.createElement("div"); nm.className = "rv-kpi-name"; klName(nm, l, l.kpi); kc.appendChild(nm);
    var meta = [l.unit, l.direction, l.category].filter(Boolean).join(" · ");
    if (meta) { var m = document.createElement("div"); m.className = "rv-kpi-meta"; m.textContent = meta; kc.appendChild(m); }
    var d = klDesc(l) || (l.detail ? (function () { var x = document.createElement("div"); x.className = "rv-kpi-desc"; x.textContent = l.detail; return x; })() : null);
    if (d) kc.appendChild(d);
    tr.appendChild(kc);
    var wc = document.createElement("td"); wc.className = "rv-kpi-weight"; wc.appendChild(weightCell(l, ctx.editable)); tr.appendChild(wc);
    if (ctx.mechA) {
      var byN = {}; (l.scale || []).forEach(function (r) { byN[r.n] = r.value; });
      [1, 2, 3, 4, 5].forEach(function (n) {
        var td = document.createElement("td"); td.className = "rv-rung";
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
  }

  function buildKpiTable(data) {
    var lines = (data && data.lines) || [];
    // All lines share the BG mechanism, so the header is uniform: Mech A -> five
    // rung columns headed 1-5; Mech B -> a column per reference (Threshold/Target/...).
    var mechA = lines.length > 0 && lines.every(function (l) { return (l.scale || []).length === 5; });
    var mechB = !mechA && lines.length > 0 && lines.every(function (l) { return (l.scale_b || []).length > 0; });
    var bLabels = mechB ? (lines[0].scale_b || []).map(function (r) { return r.label; }) : [];
    tableCtx = { editable: !!(data && data.editable), mechA: mechA, mechB: mechB, bLabels: bLabels };
    var wrap = document.createElement("div"); wrap.className = "rv-card rv-kpi-overview rv-kpi-inline rv-set-table";
    var tbl = document.createElement("table");
    tbl.className = "rv-scorecard rv-kpi-flat" + (mechA ? " rv-kpi-mechA" : mechB ? " rv-kpi-mechB" : "");
    var thead = document.createElement("thead");
    if (mechA) {
      var ar1 = document.createElement("tr");
      ar1.appendChild(th("KPI", { rowspan: 2 })); ar1.appendChild(th("Weight", { rowspan: 2 }));
      ar1.appendChild(th("Rating scale", { colspan: 5, cls: "rv-scale-grouphead" }));
      var ar2 = document.createElement("tr");
      [1, 2, 3, 4, 5].forEach(function (n) { ar2.appendChild(th(String(n), { cls: "rv-rung-head" })); });
      thead.appendChild(ar1); thead.appendChild(ar2);
    } else if (mechB) {
      var br1 = document.createElement("tr");
      br1.appendChild(th("KPI", { rowspan: 2 })); br1.appendChild(th("Weight", { rowspan: 2 }));
      br1.appendChild(th("Rating scale", { colspan: bLabels.length || 1, cls: "rv-scale-grouphead" }));
      var br2 = document.createElement("tr");
      bLabels.forEach(function (lab) { br2.appendChild(th(lab, { cls: "rv-rung-head" })); });
      thead.appendChild(br1); thead.appendChild(br2);
    } else {
      var hr = document.createElement("tr");
      ["KPI", "Weight", "Rating scale"].forEach(function (h) { hr.appendChild(th(h)); });
      thead.appendChild(hr);
    }
    tbl.appendChild(thead);
    var tb = document.createElement("tbody");
    rowById = {}; rowSig = {};
    lines.forEach(function (l) {
      var tr = document.createElement("tr"); rowCells(tr, l, tableCtx); tb.appendChild(tr);
      rowById[l.kpi_id] = tr; rowSig[l.kpi_id] = rowSignature(l);
    });
    tbl.appendChild(tb); wrap.appendChild(tbl);
    return wrap;
  }

  // Update changed rows in place (weight / target / completeness). A row whose
  // server signature is unchanged is left alone, so a half-typed weight in a
  // DIFFERENT row survives the turn.
  function refreshTableRows(data) {
    var lines = (data && data.lines) || [];
    var ids = {};
    lines.forEach(function (l) {
      ids[l.kpi_id] = true;
      var tr = rowById[l.kpi_id];
      var sig = rowSignature(l);
      if (!tr) { return; }             // new rows handled by a full rebuild below
      if (rowSig[l.kpi_id] !== sig) { rowCells(tr, l, tableCtx); rowSig[l.kpi_id] = sig; }
    });
    // A KPI added or removed changes the row set -> rebuild the whole table.
    var known = Object.keys(rowById);
    if (known.length !== lines.length || known.some(function (k) { return !ids[k]; })) {
      rebuildTable(data);
    }
  }

  // Inset the log by the floating card's height WHILE the card is actually overlaying
  // (position:absolute), so the opening message isn't hidden under it; cleared on
  // mobile (static) / no card. Recomputed on rebuild and, debounced, on resize.
  function syncLogInset() {
    if (!log) return;
    var overlaying = tableEl && !tableEl.hidden &&
      getComputedStyle(tableEl).position === "absolute";
    log.style.paddingTop = overlaying
      ? (Math.round(tableEl.getBoundingClientRect().height) + 18) + "px" : "";
  }

  function rebuildTable(data) {
    var fresh = buildKpiTable(data);
    if (tableEl && tableEl.parentNode) tableEl.parentNode.replaceChild(fresh, tableEl);
    else root.insertBefore(fresh, root.firstChild);
    tableEl = fresh;
    tableEl.hidden = !tableOpen;
    syncLogInset();
  }

  function refreshOverview(data) {
    if (!pin) return;
    // ABSENT is not EMPTY: a degraded turn returns no overview; ignoring undefined
    // keeps the pinned scorecard on screen. null still clears.
    if (data === undefined) return;
    if (!data) { pin.innerHTML = ""; if (tableEl) { tableEl.remove(); tableEl = null; } syncLogInset(); return; }
    pin.innerHTML = "";
    pin.appendChild(buildStatusHeader(data));
    var offers = unitOffers(data);
    if (offers) pin.appendChild(offers);
    if (!(data.lines || []).length) {
      // Nothing chosen yet -> no table, just the header nudging to add a KPI.
      if (tableEl) { tableEl.remove(); tableEl = null; }
      syncLogInset();
      return;
    }
    if (!tableEl) {
      tableEl = buildKpiTable(data);
      root.insertBefore(tableEl, root.firstChild);
      scrollSoon();
    } else if (tableCtx && tableCtx.editable !== !!data.editable) {
      rebuildTable(data);           // editability changed (e.g. after Submit)
    } else {
      refreshTableRows(data);
    }
    tableEl.hidden = !tableOpen;
    syncLogInset();
  }

  // The read-only scorecard snapshot for the propose card: KPI · Weight · the rating
  // scale (1-5 for Mech A / Threshold·Target·… for Mech B), the SAME shape as the
  // pinned table, plus the running weight total. No target/status column -- a setting
  // exercise shows the scale, not a result.
  function scorecardTable(d) {
    var frag = document.createDocumentFragment();
    var lines = d.lines || [];
    var mechA = lines.length > 0 && lines.every(function (l) { return (l.scale || []).length === 5; });
    var mechB = !mechA && lines.length > 0 && lines.every(function (l) { return (l.scale_b || []).length > 0; });
    var bLabels = mechB ? (lines[0].scale_b || []).map(function (r) { return r.label; }) : [];
    var tbl = document.createElement("table");
    tbl.className = "rv-scorecard rv-kpi-flat" + (mechA ? " rv-kpi-mechA" : mechB ? " rv-kpi-mechB" : "");
    var thead = document.createElement("thead");
    if (mechA) {
      var ar1 = document.createElement("tr");
      ar1.appendChild(th("KPI", { rowspan: 2 })); ar1.appendChild(th("Weight", { rowspan: 2 }));
      ar1.appendChild(th("Rating scale", { colspan: 5, cls: "rv-scale-grouphead" }));
      var ar2 = document.createElement("tr");
      [1, 2, 3, 4, 5].forEach(function (n) { ar2.appendChild(th(String(n), { cls: "rv-rung-head" })); });
      thead.appendChild(ar1); thead.appendChild(ar2);
    } else if (mechB) {
      var br1 = document.createElement("tr");
      br1.appendChild(th("KPI", { rowspan: 2 })); br1.appendChild(th("Weight", { rowspan: 2 }));
      br1.appendChild(th("Rating scale", { colspan: bLabels.length || 1, cls: "rv-scale-grouphead" }));
      var br2 = document.createElement("tr");
      bLabels.forEach(function (lab) { br2.appendChild(th(lab, { cls: "rv-rung-head" })); });
      thead.appendChild(br1); thead.appendChild(br2);
    } else {
      var hr = document.createElement("tr");
      ["KPI", "Weight", "Rating scale"].forEach(function (h) { hr.appendChild(th(h)); });
      thead.appendChild(hr);
    }
    tbl.appendChild(thead);
    var tb = document.createElement("tbody");
    lines.forEach(function (l) {
      var tr = document.createElement("tr");
      var kc = document.createElement("td"); kc.className = "rv-kpi-cell";
      var nm = document.createElement("div"); nm.className = "rv-kpi-name"; klName(nm, l, l.kpi); kc.appendChild(nm);
      var nd = klDesc(l); if (nd) kc.appendChild(nd);
      tr.appendChild(kc);
      var wc = document.createElement("td"); wc.textContent = (l.weight != null ? l.weight + "%" : DASH); tr.appendChild(wc);
      if (mechA) {
        var byN = {}; (l.scale || []).forEach(function (r) { byN[r.n] = r.value; });
        [1, 2, 3, 4, 5].forEach(function (n) {
          var td = document.createElement("td"); td.className = "rv-rung";
          td.textContent = (byN[n] != null ? byN[n] : DASH); tr.appendChild(td);
        });
      } else if (mechB) {
        var byLab = {}; (l.scale_b || []).forEach(function (r) { byLab[r.label] = r.value; });
        bLabels.forEach(function (lab) {
          var td = document.createElement("td"); td.className = "rv-rung";
          td.textContent = (byLab[lab] != null ? byLab[lab] : DASH); tr.appendChild(td);
        });
      } else {
        var scd = document.createElement("td"); scd.className = "rv-scale-cell"; scd.appendChild(scaleStrip(l)); tr.appendChild(scd);
      }
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); frag.appendChild(tbl);
    var o = document.createElement("div");
    o.className = "rv-scorecard-overall " + (d.weight_ok ? "" : "rv-weight-short");
    o.textContent = "Total weight: " + (d.total_weight != null ? d.total_weight : 0) + "% / 100%"
      + (d.weight_ok ? "" : " — must total 100%");
    frag.appendChild(o);
    return frag;
  }

  // The final SUBMIT card: a warning, the scorecard, who it goes to, and a
  // Submit / Not-yet choice. Submit posts to /review/setting/propose (the one propose).
  function buildProposeCard(d) {
    var wrap = document.createElement("div");
    wrap.className = "rv-msg rv-msg-agent rv-card rv-confirm";
    var warn = document.createElement("div"); warn.className = "rv-confirm-warn";
    warn.textContent = "Once you submit, your scorecard goes for approval and you can't "
      + "change it while it's being reviewed.";
    wrap.appendChild(warn);
    var h = document.createElement("div"); h.className = "rv-confirm-head";
    h.textContent = "Your scorecard"; wrap.appendChild(h);
    wrap.appendChild(scorecardTable(d));
    if (d.approver) {
      var who = document.createElement("div"); who.className = "rv-confirm-subhead";
      who.textContent = "Goes to " + d.approver + " for approval."; wrap.appendChild(who);
    }
    var actions = document.createElement("div"); actions.className = "rv-confirm-actions";
    var yes = document.createElement("button"); yes.type = "button";
    yes.className = "rv-confirm-yes"; yes.textContent = "Submit for approval";
    yes.addEventListener("click", function () { doPropose(yes, wrap); });
    // No "Not yet" -- to make a change the person just keeps chatting (Chris).
    actions.appendChild(yes); wrap.appendChild(actions);
    return wrap;
  }

  function doPropose(btn, wrap) {
    btn.disabled = true;
    var f = new FormData(); f.append("csrf_token", token());
    fetch(proposeUrl, { method: "POST", body: f, credentials: "same-origin" })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (j && j.ok && j.proposed) {
          var a = wrap.querySelector(".rv-confirm-actions"); if (a) a.remove();
          wrap.classList.add("rv-confirm-done");
          bubble("agent", j.warn
            ? "Submitted — your scorecard is proposed. " + j.warn
            : "Submitted — your scorecard is now with your approver. You'll be able to edit it again if it's returned.");
          if (j.overview) refreshOverview(j.overview);
          scrollSoon();
        } else {
          btn.disabled = false;
          bubble("agent", (j && j.error) || "Couldn't submit — please try again.");
        }
      })
      .catch(function () { btn.disabled = false; bubble("agent", "Couldn't submit — please try again."); });
  }

  // The eligible KPI LIBRARY as a browsable card: Category · KPI · Scope
  // · direction, with an Add chip on each not-yet-chosen row that sends "Add ..."
  // through the chat (→ the validated add_kpi, one write path).
  function buildLibraryCard(d) {
    var wrap = document.createElement("div");
    wrap.className = "rv-msg rv-msg-agent rv-card rv-lib-card";
    var lines = (d && d.lines) || [];
    if (!lines.length) {
      var p = document.createElement("div"); p.textContent = "There are no library KPIs for your role yet.";
      wrap.appendChild(p); return wrap;
    }
    var h = document.createElement("div"); h.className = "rv-confirm-head";
    h.textContent = "KPIs you can choose from"; wrap.appendChild(h);
    var tbl = document.createElement("table"); tbl.className = "rv-scorecard rv-lib-table";
    var thead = document.createElement("thead"); var hr = document.createElement("tr");
    ["Category", "KPI", "Scope", ""].forEach(function (x) {
      var t = document.createElement("th"); t.textContent = x; hr.appendChild(t);
    });
    thead.appendChild(hr); tbl.appendChild(thead);
    var tb = document.createElement("tbody");
    lines.forEach(function (l) {
      var tr = document.createElement("tr");
      [l.category || DASH, l.name, l.scope || DASH].forEach(function (v, i) {
        var td = document.createElement("td");
        if (i === 1) {
          var nm = document.createElement("div"); nm.className = "rv-kpi-name"; nm.textContent = v; td.appendChild(nm);
          if (l.direction) { var m = document.createElement("div"); m.className = "rv-kpi-meta"; m.textContent = l.direction; td.appendChild(m); }
        } else { td.textContent = v; }
        tr.appendChild(td);
      });
      var act = document.createElement("td");
      if (l.already_chosen) {
        var on = document.createElement("span"); on.className = "rv-lib-on"; on.textContent = "Added"; act.appendChild(on);
      } else {
        var b = document.createElement("button"); b.type = "button"; b.className = "rv-chip rv-lib-add";
        b.textContent = "Add";
        b.addEventListener("click", function () { if (!busy) sendTurn('Add "' + l.name + '".'); });
        act.appendChild(b);
      }
      tr.appendChild(act); tb.appendChild(tr);
    });
    tbl.appendChild(tb); wrap.appendChild(tbl);
    return wrap;
  }

  function renderCard(card) {
    if (!card) return;
    if (card.type === "setting_confirm") {
      log.appendChild(buildProposeCard(card.data || {})); scrollSoon(); return;
    }
    if (card.type === "setting_library") {
      log.appendChild(buildLibraryCard(card.data || {})); scrollSoon(); return;
    }
    if (card.type !== "setting_scorecard") return;
    var wrap = document.createElement("div");
    wrap.className = "rv-msg rv-msg-agent rv-card";
    wrap.appendChild(scorecardTable(card.data || {}));
    log.appendChild(wrap); log.scrollTop = log.scrollHeight;
  }

  function setQuick(items) {
    quick.innerHTML = "";
    (items || []).forEach(function (t) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "rv-chip"; b.textContent = t;
      b.addEventListener("click", function () { sendTurn(t); });
      quick.appendChild(b);
    });
  }

  var busy = false;
  function sendTurn(explicit) {
    if (busy) return;
    if (winClosed) { bubble("agent", winClosed); scrollSoon(); return; }
    var fromInput = (explicit === undefined);
    var msg = fromInput ? (input.value || "").trim() : String(explicit);
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
        (j && j.renders || []).forEach(renderCard);
        refreshOverview(j && j.overview);
        setQuick(j && j.quick_replies);
        if (j && j.rail_html) swapRail(j.rail_html);
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

  function swapRail(html) {
    var old = document.querySelector(".rv-rail");
    if (!old) return;
    var tmp = document.createElement("div");
    tmp.innerHTML = html;
    var fresh = tmp.querySelector(".rv-rail");
    if (fresh) old.replaceWith(fresh);
  }

  form.addEventListener("submit", function (e) { e.preventDefault(); sendTurn(); });
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

  fetch(histUrl, { credentials: "same-origin" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (!j) return;
      var msgs = j.messages || [];
      msgs.forEach(function (m) {
        bubble(m.role, m.content);
        (m.card || []).forEach(renderCard);
      });
      if (msgs.length) refreshOverview(j.overview);
      var last = msgs[msgs.length - 1];
      if (last && last.role === "agent" && last.quick_replies) setQuick(last.quick_replies);
      scrollSoon();
      if (winClosed) {   // closed: no opening turn, the box locked
        if (!msgs.length) bubble("agent", winClosed + " You can still look through it.");
        lockClosed(winClosed);
        return;
      }
      if (root.getAttribute("data-unavailable")) {
        if (!msgs.length) {
          bubble("agent", "The setting assistant isn't switched on yet — ask your admin to enable it.");
        }
        input.disabled = true; send.disabled = true;
        return;
      }
      if (!msgs.length) sendTurn();
    });
})();
