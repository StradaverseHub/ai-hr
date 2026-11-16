// Reorder KPIs on the person page's Performance tab (2026-11-08, canvas [design canvas link removed] boards A1-A4;
// markup: templates/person/_performance.html, CSS: the "Reorder KPIs" block at the end of static/style.css).
// Pressing Reorder swaps the add bar for the reorder bar and gives every KPI row a grip, a live number and two arrows, on the page with no
// reload. The rows move three ways: drag the grip (pointer events), the up / down arrows, or the keyboard (Space on a grip picks the row up,
// the arrows move it, Space drops it, Esc puts it back). A row the admin moved is tinted and says "was N"; Cancel puts the saved order back;
// Save order sends the ids in order to admin_person_kpi (action=reorder) after OneHR's own confirm box, whose words are built here.
// Leaving with moves not saved asks "Leave without saving?" (Stay / Leave) in the same box. The server decides everything (_pm_kpi_reorder):
// this only shows the order as it will be saved.
(function () {
  if (window.__rordLoaded) return;
  window.__rordLoaded = true;
  var tbl = document.getElementById("pp-kpis"), bar = document.getElementById("rord-bar"), openBtn = document.getElementById("rord-open");
  var form = document.getElementById("rord-form"), orderEl = document.getElementById("rord-order");
  var save = document.getElementById("rord-save"), cancelBtn = document.getElementById("rord-cancel");
  var countEl = document.getElementById("rord-count"), live = document.getElementById("rord-live");
  if (!tbl || !bar || !openBtn || !form || !orderEl || !save) return;
  var who = bar.getAttribute("data-rord-name") || "them", cyc = bar.getAttribute("data-rord-cycle") || "this cycle";

  var on = false;            // reorder mode
  var saved = [];            // the rows in the order the page was drawn (the saved order)
  var acted = [];            // the rows the admin moved (their ids), while they sit off their saved place
  var kbd = null;            // a row picked up with Space: {row, from}
  var drag = null;           // a row being dragged: {row, from, startY, idx, moved}
  var allowLeave = false;    // Leave was chosen, or Save order went through: no more asking
  var line = document.createElement("div");
  line.className = "rord-line"; line.hidden = true;
  tbl.appendChild(line);

  function rows() {
    return [].filter.call(tbl.children, function (c) { return c.classList && c.classList.contains("pp-krow") && /^kpi-\d+$/.test(c.id); });
  }
  function rid(row) { return row.id.replace("kpi-", ""); }
  function nameOf(row) { var m = row.querySelector("[data-rord-name]"); return m ? m.getAttribute("data-rord-name") : row.id; }
  function finalRow() { return document.getElementById("kpi-final"); }
  function say(t) {   // the live region: cleared first, so the same words are read again
    if (!live) return;
    live.textContent = "";
    setTimeout(function () { live.textContent = t; }, 30);
  }
  function posWords(row) { var rs = rows(); return nameOf(row) + ", position " + (rs.indexOf(row) + 1) + " of " + rs.length; }

  // ---- what the page shows: numbers, "was N", tints, arrows, the count and Save order ----
  function render() {
    var rs = rows();
    var dirty = rs.some(function (r, i) { return saved[i] !== r; });
    var movedSet = acted.filter(function (id) {
      var r = document.getElementById("kpi-" + id);
      return r && saved.indexOf(r) !== rs.indexOf(r);
    });
    if (dirty && !movedSet.length) {   // a displaced row with no moved one (cannot happen by hand): say which sit elsewhere
      movedSet = rs.filter(function (r, i) { return saved[i] !== r; }).map(rid);
    }
    rs.forEach(function (r, i) {
      var n = r.querySelector(".pp-n"), w = r.querySelector(".pp-was");
      if (n) n.textContent = String(i + 1);
      var mv = movedSet.indexOf(rid(r)) >= 0;
      r.classList.toggle("is-moved", mv);
      if (w) w.textContent = mv ? "was " + (saved.indexOf(r) + 1) : "";
      var up = r.querySelector('[data-rord-mv="-1"]'), dn = r.querySelector('[data-rord-mv="1"]');
      if (up) up.disabled = i === 0;
      if (dn) dn.disabled = i === rs.length - 1;
    });
    if (countEl) {
      countEl.textContent = movedSet.length + " moved";
      countEl.hidden = movedSet.length === 0;
    }
    save.disabled = !dirty;
    orderEl.value = rs.map(rid).join(",");
    // the confirm box's words, read by base.html when Save order is pressed: the numbered new order, "(was N)" on the moved lines
    form.setAttribute("data-confirm", "Save the new order of " + who + "'s " + cyc + " KPIs?");
    form.setAttribute("data-confirm-list", JSON.stringify(rs.map(function (r, i) {
      return (i + 1) + ". " + nameOf(r) + (movedSet.indexOf(rid(r)) >= 0 ? " (was " + (saved.indexOf(r) + 1) + ")" : "");
    })));
    return dirty;
  }
  function unsaved() { return on && rows().some(function (r, i) { return saved[i] !== r; }); }

  // put `row` at index `idx` among the lines (the Final result row stays last)
  function moveTo(row, idx) {
    var rs = rows(), others = rs.filter(function (r) { return r !== row; });
    var ref = others[idx] || finalRow() || null;
    if (ref === row) return;
    tbl.insertBefore(row, ref);
  }
  function mark(row) { if (acted.indexOf(rid(row)) < 0) acted.push(rid(row)); }
  function refocus(el, row) {
    if (!el) return;
    if (el.disabled && row) { var other = row.querySelector('[data-rord-mv]:not(:disabled)'); if (other) other.focus(); return; }
    el.focus();
  }

  function enter() {
    if (on) return;
    on = true; allowLeave = false;
    saved = rows(); acted = [];
    tbl.classList.add("is-reorder");
    document.body.classList.add("is-kpi-reorder");
    bar.hidden = false;
    render();
    say("Reorder mode. Drag a row by its handle, or move it with the arrows.");
    var g = tbl.querySelector("[data-rord-grip]");
    if (g) g.focus();
  }
  function leaveMode(restore) {
    if (!on) return;
    if (restore) saved.forEach(function (r) { tbl.insertBefore(r, finalRow() || null); });
    kbd = null; drag = null; line.hidden = true;
    rows().forEach(function (r) { r.classList.remove("is-lifted"); r.style.transform = ""; });
    acted = [];
    render();
    on = false;
    tbl.classList.remove("is-reorder");
    document.body.classList.remove("is-kpi-reorder", "is-rord-drag");
    bar.hidden = true;
    rows().forEach(function (r) { var w = r.querySelector(".pp-was"); if (w) w.textContent = ""; r.classList.remove("is-moved"); });
    openBtn.focus();
  }
  openBtn.addEventListener("click", enter);
  if (cancelBtn) cancelBtn.addEventListener("click", function () { leaveMode(true); });

  // ---- the arrows ----
  tbl.addEventListener("click", function (e) {
    if (!on) return;
    var g = e.target.closest && e.target.closest("[data-rord-grip]");
    if (g) { e.preventDefault(); return; }   // the grip works by drag and by the keyboard, never by a click
    var b = e.target.closest && e.target.closest("[data-rord-mv]");
    if (!b || b.disabled) return;
    var row = b.closest(".pp-krow"), rs = rows(), i = rs.indexOf(row), d = parseInt(b.getAttribute("data-rord-mv"), 10);
    if (i < 0 || i + d < 0 || i + d >= rs.length) return;
    moveTo(row, i + d); mark(row); render();
    say(posWords(row));
    refocus(b, row);
  });

  // ---- the keyboard: Space picks a row up by its grip, the arrows move it, Space drops it, Esc puts it back ----
  tbl.addEventListener("keydown", function (e) {
    if (!on) return;
    var g = e.target.closest && e.target.closest("[data-rord-grip]");
    if (!g) return;
    var row = g.closest(".pp-krow"), rs = rows(), i = rs.indexOf(row);
    if (e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      if (!kbd) {
        kbd = { row: row, from: i }; row.classList.add("is-lifted"); g.setAttribute("aria-pressed", "true");
        say("Picked up " + posWords(row) + ". Move it with the up and down arrow keys, Space to drop, Escape to put it back.");
      } else { drop(g, "Dropped " + posWords(row) + "."); }
    } else if (kbd && kbd.row === row && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      var d = e.key === "ArrowUp" ? -1 : 1;
      if (i + d < 0 || i + d >= rs.length) return;
      moveTo(row, i + d); mark(row); render(); say(posWords(row)); g.focus();
    } else if (kbd && kbd.row === row && e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      moveTo(row, kbd.from); render();
      drop(g, "Put back. " + posWords(row) + ".");
    }
  });
  function drop(g, words) {
    if (kbd) { kbd.row.classList.remove("is-lifted"); }
    if (g) g.removeAttribute("aria-pressed");
    kbd = null; render(); say(words);
  }
  tbl.addEventListener("focusout", function (e) {   // focus left a picked-up row's grip: it is dropped where it is
    if (!kbd) return;
    var g = e.target.closest && e.target.closest("[data-rord-grip]");
    if (g && g.closest(".pp-krow") === kbd.row) setTimeout(function () {
      if (kbd && document.activeElement !== g) { kbd.row.classList.remove("is-lifted"); g.removeAttribute("aria-pressed"); kbd = null; }
    }, 0);
  });

  // ---- dragging: the row lifts with a shadow, a 2px accent line shows where it will land ----
  function landing(y) {   // the index among the OTHER rows the pointer is above, and the line's top
    var others = rows().filter(function (r) { return r !== drag.row; }), idx = 0, top;
    others.forEach(function (r) { var b = r.getBoundingClientRect(); if (y > b.top + b.height / 2) idx++; });
    var tr = tbl.getBoundingClientRect();
    if (idx < others.length) top = others[idx].getBoundingClientRect().top;
    else { var f = finalRow(); top = f ? f.getBoundingClientRect().top : others[others.length - 1].getBoundingClientRect().bottom; }
    return { idx: idx, top: top - tr.top };
  }
  tbl.addEventListener("pointerdown", function (e) {
    if (!on || (e.pointerType === "mouse" && e.button !== 0)) return;
    var g = e.target.closest && e.target.closest("[data-rord-grip]");
    if (!g) return;
    var row = g.closest(".pp-krow");
    e.preventDefault();
    drag = { row: row, from: rows().indexOf(row), startY: e.clientY, idx: rows().indexOf(row), moved: false };
    row.classList.add("is-lifted");
    document.body.classList.add("is-rord-drag");
    try { g.setPointerCapture(e.pointerId); } catch (er) { /* a stand-in pointer: the document listeners below still follow it */ }
  });
  function dragMove(e) {
    if (!drag) return;
    var dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(dy) < 3) return;
    drag.moved = true;
    drag.row.style.transform = "translateY(" + dy + "px)";
    var l = landing(e.clientY);
    drag.idx = l.idx;
    line.style.top = (l.top - 1) + "px"; line.hidden = false;
  }
  function dragEnd(e, cancelled) {
    if (!drag) return;
    var d = drag; drag = null;
    d.row.classList.remove("is-lifted"); d.row.style.transform = "";
    document.body.classList.remove("is-rord-drag");
    line.hidden = true;
    if (!cancelled && d.moved && d.idx !== d.from) {
      moveTo(d.row, d.idx); mark(d.row); render(); say(posWords(d.row));
    }
    var g = d.row.querySelector("[data-rord-grip]");
    if (g) g.focus();
  }
  document.addEventListener("pointermove", dragMove);
  document.addEventListener("pointerup", function (e) { dragEnd(e, false); });
  document.addEventListener("pointercancel", function (e) { dragEnd(e, true); });
  document.addEventListener("keydown", function (e) { if (drag && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dragEnd(e, true); } }, true);

  // ---- no side panel opens while the order is being changed ----
  window.addEventListener("click", function (e) {
    if (!on) return;
    var b = e.target.closest && e.target.closest("[data-panel-open]");
    if (b) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // ---- leaving with moves not saved: OneHR's own box, Stay or Leave ----
  function ask(go) {
    var msg = "Your new KPI order for " + who + " isn't saved.";
    if (typeof window.askConfirm === "function") {
      window.askConfirm(msg, "Leave", function () { allowLeave = true; go(); }, true, { title: "Leave without saving?", cancel: "Stay" });
    } else { allowLeave = true; go(); }
  }
  window.addEventListener("click", function (e) {
    if (!unsaved() || allowLeave || e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
    var h = a.getAttribute("href") || "";
    if (h === "" || h.charAt(0) === "#" || /^javascript:/i.test(h)) return;
    e.preventDefault(); e.stopPropagation();
    ask(function () { window.location.href = a.href; });
  }, true);
  document.addEventListener("submit", function (e) {
    var f = e.target;
    // Save order: base.html's confirm stops the first submit and replays it once OK is pressed, so only a submit that is still going
    // ahead a moment later is the real one (Cancel in the box leaves the guard on)
    if (f === form) { setTimeout(function () { if (!e.defaultPrevented) allowLeave = true; }, 0); return; }
    if (!unsaved() || allowLeave || !(f instanceof HTMLFormElement)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    ask(function () { if (f.requestSubmit) f.requestSubmit(); else HTMLFormElement.prototype.submit.call(f); });   // replayed, so the form's own confirm still asks
  }, true);
  window.addEventListener("beforeunload", function (e) {   // a reload, the tab or window closing, a typed address: only the browser can ask
    if (unsaved() && !allowLeave) { e.preventDefault(); e.returnValue = ""; return ""; }
  });
})();
