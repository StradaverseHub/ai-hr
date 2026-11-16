/* Performance > Settings > Scoring: the picked group's band bars, the Check a score box, and the rule panel (Chris,
   2026-10-29; canvas [design canvas link removed]). The page draws everything from numbers the server
   sent; nothing here decides a band that is kept -- the server refuses a bad rule again, and the label a person reads is
   always pm_bands_for()'s. The preview (what changes now) comes from the rule-preview route, which writes nothing. */
(function () {
  "use strict";
  var dataEl = document.getElementById("br-data");
  var D = {};
  try { D = JSON.parse(dataEl.textContent) || {}; } catch (e) { D = {}; }
  var LAB = ["UA", "BE", "ME", "AE", "OU"];
  // the band chip colours are theme tokens (static/style.css, written by tools/css_tokens.py): light and dark come from there
  var COL = {};
  ["UA", "BE", "ME", "AE", "OU"].forEach(function (k) {
    var t = k.toLowerCase();
    COL[k] = { bg: "var(--" + t + "-bg)", fg: "var(--" + t + "-fg)", dot: "var(--" + t + "-dot)" };
  });
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function num(v) { var n = parseFloat(String(v).replace(/,/g, "")); return isFinite(n) ? n : null; }
  function fmt(n) { return String(Math.round(n * 100) / 100); }

  // a row of the method table opens its group, as its name does
  document.addEventListener("click", function (e) {
    var tr = e.target.closest && e.target.closest("tr.br-row");
    if (!tr || e.target.closest("a, button, select, input, form, label")) return;
    var u = tr.getAttribute("data-pick");
    if (u) location.href = u;
  });

  // ---- the coloured bar: five segments, each to the next one's start ----
  function drawBar(bar) {
    var raw = (bar.getAttribute("data-starts") || "").split(",").map(num);
    var five = bar.getAttribute("data-bar") === "five";
    bar.textContent = "";
    if (raw.length !== 5 || raw.some(function (x) { return x === null; })) return;
    var lo = five ? 1 : 0, top = five ? 5 : 150, labels = bar.getAttribute("data-labels") === "1" || !bar.classList.contains("br-bar-s");
    LAB.forEach(function (k, i) {
      var a = Math.max(raw[i], lo), b = Math.min(i < 4 ? raw[i + 1] : top, top);
      var w = Math.max(0, (b - a) / (top - lo) * 100);
      var seg = el("div", "br-seg", labels && w > 6 ? k : "");
      seg.style.width = w.toFixed(2) + "%";
      if (bar.classList.contains("br-bar-s")) seg.style.background = COL[k].dot;
      else { seg.style.background = COL[k].bg; seg.style.color = COL[k].fg; }
      seg.title = k + " from " + fmt(raw[i]) + (five ? "" : "%");
      bar.appendChild(seg);
    });
  }
  function drawAll() { document.querySelectorAll(".br-bar[data-bar]").forEach(drawBar); }

  function floorLabel(starts, v) {
    var lab = null;
    for (var i = 0; i < 5; i++) { if (starts[i] <= v) lab = LAB[i]; else break; }
    return lab;
  }

  // ---- Check a score (the group default's inputs, or the 5-point table) ----
  function groupStarts() {
    var five = document.querySelector(".br-five");
    if (five) {   // the 5-point table: the inputs when the super admin can change it, else the stored starts
      return LAB.map(function (k) {
        var inp = document.querySelector('[data-start-in="' + k + '"]');
        if (inp) return num(inp.value);
        var n = document.querySelector('[data-start-five][data-band="' + k + '"]');
        return n ? num(n.getAttribute("data-start-five")) : null;
      });
    }
    var out = [];
    for (var i = 0; i < 5; i++) {
      var inp = document.querySelector('#br-default-form [data-start="' + LAB[i] + '"]');
      var v = inp ? num("value" in inp ? inp.value : inp.textContent) : null;
      out.push(i === 0 ? 0 : v);
    }
    return out;
  }
  function updateCheck() {
    var box = document.querySelector("[data-check]");
    if (!box) return;
    var five = !!document.querySelector(".br-five");
    var st = groupStarts(), v = num(box.value);
    var chip = document.querySelector("[data-check-band]"), rng = document.querySelector("[data-check-range]");
    var ok = v !== null && st.every(function (x) { return x !== null; });
    var lab = ok ? floorLabel(st, v) : null;
    chip.textContent = lab || "";
    chip.style.background = lab ? COL[lab].bg : "transparent";
    chip.style.color = lab ? COL[lab].fg : "inherit";
    chip.hidden = !lab;
    if (!ok || !lab) { rng.textContent = ""; return; }
    var i = LAB.indexOf(lab), unit = five ? "" : "%";
    rng.textContent = lab + " runs from " + (five ? st[i].toFixed(2) : fmt(st[i]) + unit) +
      (i < 4 ? " to under " + (five ? st[i + 1].toFixed(2) : fmt(st[i + 1]) + unit) : " and up") + ".";
  }
  document.addEventListener("input", function (e) {
    var t = e.target;
    if (t.matches && t.matches("[data-check]")) { updateCheck(); return; }
    if (t.matches && t.matches("[data-start-in]")) { fiveInput(); return; }
    if (t.matches && t.matches("#br-default-form [data-start]")) {
      var bar = document.querySelector("#br-default-form .br-bar");
      if (bar) {
        bar.setAttribute("data-starts", groupStarts().map(function (x) { return x === null ? "" : x; }).join(","));
        drawBar(bar);
      }
      updateCheck();
    }
  });

  // ---- the rule panel ----
  // A rule reaches a unit's whole, chosen departments, or only named people (2026-11-02); the chosen departments and the
  // named people live in `picked` and `named`, and the chips are only buttons: the server reads real named fields (rule_dept,
  // rule_person), kept in step with every change and written again just before the form is sent. The people picker is fed
  // from the page (D.units[].people), strict like the other pickers: a typed name that is not a pick stops the form.
  var form = document.getElementById("br-rule-form");
  if (form) {
    var panel = form.closest(".adm-panel");
    var unitSel = document.getElementById("br-unit"), chips = document.getElementById("br-chips");
    var note = document.getElementById("br-scope-note"), saveBtn = document.getElementById("br-save");
    var footNote = document.getElementById("br-foot-note");
    var ruleId = form.querySelector('[name="rule_id"]');
    var pstart = {}; LAB.forEach(function (l) { pstart[l] = form.querySelector('[data-pstart="' + l + '"]'); });
    var defaults = []; try { defaults = JSON.parse(document.getElementById("br-root").getAttribute("data-defaults")) || []; } catch (e) {}
    var picked = {}, named = {}, seq = 0, timer = null, last = null, editingId = null, savedStarts = null, sameRules = [], alsoOff = {};
    var title = panel.querySelector(".adm-panel-h");
    var pbox = document.getElementById("br-people"), pickBox = document.getElementById("br-pick"), pickQ = document.getElementById("br-pick-q");
    var pickList = null, pickItems = [], pickActive = -1, pickTimer = null;
    var o1 = document.getElementById("br-o1"), o1All = document.getElementById("br-o1-all"), o1Rows = document.getElementById("br-o1-rows");

    function unitInfo(co) { return (D.units || []).filter(function (u) { return u.company === co; })[0] || null; }
    function scope() { var r = form.querySelector('[name="rule_scope"]:checked'); return r ? r.value : "unit"; }
    function setScope(v) { [].forEach.call(form.querySelectorAll('[name="rule_scope"]'), function (r) { r.checked = r.value === v; }); }
    function namedList() { return Object.keys(named).map(function (k) { return named[k]; }); }
    function startsVals() { return LAB.map(function (l, i) { return i === 0 ? 0 : num(pstart[l].value); }); }
    function startsError() {
      var v = startsVals();
      for (var i = 1; i < 5; i++) {
        if (v[i] === null) return "Enter where " + LAB[i] + " starts.";
        if (!(v[i] > v[i - 1])) return LAB[i] + " must start higher than " + LAB[i - 1] + " (" + fmt(v[i - 1]) + ").";
      }
      return "";
    }
    function startsChanged() {
      if (!savedStarts) return false;
      var v = startsVals();
      return v.some(function (x, i) { return x === null || Math.abs(x - savedStarts[i]) > 1e-9; });
    }
    function drawRuleBar() {
      var v = startsVals(), bar = document.getElementById("br-bar-rule");
      bar.setAttribute("data-starts", v.map(function (x) { return x === null ? "" : x; }).join(","));
      var err = startsError();
      if (err && v.some(function (x) { return x === null; })) bar.textContent = ""; else drawBar(bar);
      var e = document.getElementById("br-starts-err"); e.textContent = err; e.hidden = !err || v.slice(1).every(function (x) { return x === null; });
    }
    function syncFields() {
      [].forEach.call(form.querySelectorAll('input[data-rd], input[data-rp]'), function (n) { n.parentNode.removeChild(n); });
      if (scope() === "depts") Object.keys(picked).sort().forEach(function (d) {
        var h = el("input"); h.type = "hidden"; h.name = "rule_dept"; h.value = d; h.setAttribute("data-rd", "1"); form.appendChild(h);
      });
      if (scope() !== "unit") Object.keys(named).sort().forEach(function (k) {
        var h = el("input"); h.type = "hidden"; h.name = "rule_person"; h.value = k; h.setAttribute("data-rp", "1"); form.appendChild(h);
      });
    }
    // a person in a department this rule holds is on it already: taken off the list when that department is chosen
    function dropHeldNamed() {
      if (scope() !== "depts") return;
      Object.keys(named).forEach(function (k) { if (picked[named[k].dept]) delete named[k]; });
    }
    function renderChips() {
      syncFields();
      var u = unitInfo(unitSel.value);
      chips.textContent = ""; note.hidden = true;
      var depts = scope() === "depts";
      chips.hidden = !depts || !u;
      var whole = form.querySelector('[name="rule_scope"][value="unit"]');
      var deptRadio = form.querySelector('[name="rule_scope"][value="depts"]');
      var peopleRadio = form.querySelector('[name="rule_scope"][value="people"]');
      whole.disabled = !!(u && u.whole_rule && u.whole_rule !== editingId);
      deptRadio.disabled = !!(u && !u.depts.length);
      peopleRadio.disabled = !!(u && !(u.people || []).length);
      if (deptRadio.disabled && scope() === "depts") { setScope("unit"); depts = false; chips.hidden = true; }
      if (u && whole.disabled && scope() === "unit") { setScope(deptRadio.disabled ? "people" : "depts"); depts = scope() === "depts"; chips.hidden = !depts; }
      if (u && whole.disabled) { note.textContent = "The whole unit already has a rule. Edit or remove it to give it another."; note.hidden = false; }
      if (u && !u.depts.length) { note.textContent = "Nobody in this unit has a department on file, so a rule can only cover the whole unit or named people."; note.hidden = false; }
      if (depts && u) {
        u.depts.forEach(function (d) {
          var taken = d.rule && d.rule !== editingId;
          var on = !!picked[d.d] && !taken;
          var nm = d.label || d.d;
          var b = el("button", "br-dchip" + (on ? " is-on" : ""), (on ? "✓ " : "") + nm + " · " + (taken ? "has a rule" : d.n));
          b.type = "button"; b.disabled = !!taken; b.setAttribute("aria-pressed", on ? "true" : "false");
          if (taken) b.title = nm + " already has its own rule";
          b.addEventListener("click", function () { if (picked[d.d]) delete picked[d.d]; else picked[d.d] = 1; dropHeldNamed(); renderChips(); refresh(); });
          chips.appendChild(b);
        });
      }
      renderPeople();
    }

    // ---- the named people: chips above a search box, a list of the unit's people that leaves out who cannot be picked ----
    function peopleAvail() {
      var u = unitInfo(unitSel.value); if (!u) return [];
      return (u.people || []).map(function (p) { return { eid: p[0], name: p[1], dept: p[2], deptLabel: p[3], job: p[4], on: p[5] }; });
    }
    function renderPeople() {
      var sc = scope(), u = unitInfo(unitSel.value);
      pbox.hidden = !u || sc === "unit";
      var chipsEl = pickBox.querySelector(".pick-chips");
      if (!chipsEl) { chipsEl = el("span", "pick-chips"); chipsEl.setAttribute("aria-live", "polite"); pickBox.insertBefore(chipsEl, pickBox.firstChild); }
      chipsEl.textContent = "";
      if (!u || sc === "unit") { setPickValidity(); return; }
      var list = namedList().sort(function (x, y) { return x.name < y.name ? -1 : 1; });
      list.forEach(function (p) {
        var c = el("span", "pick-chip");
        c.appendChild(document.createTextNode(p.name + " "));
        c.appendChild(el("small", null, "· " + p.eid + (p.deptLabel ? " · " + p.deptLabel : "")));
        var x = el("button", null, "×"); x.type = "button"; x.setAttribute("aria-label", "Take " + p.name + " off");
        x.addEventListener("click", function () { delete named[p.eid]; renderPeople(); syncFields(); refresh(); pickQ.focus(); });
        c.appendChild(x); chipsEl.appendChild(c);
      });
      pickBox.classList.toggle("has-chips", list.length > 0);
      var label = document.getElementById("br-people-lbl"), cnt = document.getElementById("br-people-n");
      var h1 = document.getElementById("br-people-help1"), h2 = document.getElementById("br-people-help2");
      if (sc === "people") {
        label.textContent = "Named people"; cnt.textContent = list.length + " picked";
        h1.textContent = "People of " + u.label + " only. Pick at least one."; h2.textContent = ""; h2.hidden = true;
      } else {
        label.textContent = "Named people"; cnt.textContent = "optional · " + list.length;
        h1.textContent = "For someone whose department stays on another band. People of " + u.label + " only.";
        h2.textContent = "A named person's rule wins over their department's. They stay on it while they work in " + u.label + "; a move out takes them off.";
        h2.hidden = false;
      }
      setPickValidity();
    }
    function setPickValidity() {
      var typed = pickQ.value.trim(), msg = "";
      if (!pbox.hidden && typed) msg = "Choose the person from the list, or clear what you typed.";
      else if (!pbox.hidden && scope() === "people" && !namedList().length) msg = "Choose at least one person from the list.";
      pickQ.setCustomValidity(msg);
    }
    function pickClose() { if (pickList) pickList.hidden = true; pickQ.setAttribute("aria-expanded", "false"); pickActive = -1; }
    function pickMark() {
      if (!pickList) return;
      [].forEach.call(pickList.children, function (li, i) { li.classList.toggle("is-on", i === pickActive); });
    }
    function pickChoose(i) {
      var p = pickItems[i]; if (!p || p.off) return;
      named[p.eid] = p; pickQ.value = ""; pickClose(); renderPeople(); syncFields(); refresh();
    }
    function pickRender() {
      var t = pickQ.value.trim().toLowerCase();
      setPickValidity();
      if (!pickList) { pickList = el("ul", "pick-list"); pickList.setAttribute("role", "listbox"); pickBox.appendChild(pickList); }
      if (!t) { pickClose(); return; }
      var heldDepts = scope() === "depts" ? picked : {};
      var all = peopleAvail().filter(function (p) {
        return !named[p.eid] && !heldDepts[p.dept] &&
          ((p.name || "").toLowerCase().indexOf(t) >= 0 || (p.eid || "").toLowerCase().indexOf(t) >= 0 || (p.job || "").toLowerCase().indexOf(t) >= 0);
      });
      all.forEach(function (p) { p.off = !!(p.on && p.on !== editingId); });
      all.sort(function (x, y) { return (x.off - y.off) || (x.name < y.name ? -1 : 1); });
      pickItems = all.slice(0, 40);
      pickList.textContent = "";
      if (!pickItems.length) { pickList.appendChild(el("li", "pick-none", "Nobody matches")); }
      pickItems.forEach(function (p, i) {
        var li = el("li", p.off ? "pick-off" : null);
        li.setAttribute("role", "option");
        if (p.off) li.setAttribute("aria-disabled", "true");
        li.appendChild(el("b", null, p.name)); li.appendChild(document.createTextNode(" ")); li.appendChild(el("span", null, "· " + p.eid));
        li.appendChild(el("small", null, [p.deptLabel, p.job].filter(Boolean).join(" · ") + (p.off ? (p.deptLabel || p.job ? " · " : "") + "named on another rule already" : "")));
        if (!p.off) li.addEventListener("mousedown", function (e) { e.preventDefault(); pickChoose(i); });
        pickList.appendChild(li);
      });
      pickList.hidden = false; pickQ.setAttribute("aria-expanded", "true"); pickActive = -1;
    }
    pickQ.addEventListener("input", function () { clearTimeout(pickTimer); pickTimer = setTimeout(pickRender, 80); setPickValidity(); validate(); });
    pickQ.addEventListener("focus", function () { if (pickQ.value.trim()) pickRender(); });
    pickQ.addEventListener("blur", function () { setTimeout(pickClose, 120); });
    pickQ.addEventListener("keydown", function (e) {
      if (e.key === "Backspace" && !pickQ.value) { var ks = Object.keys(named); if (ks.length) { delete named[ks[ks.length - 1]]; renderPeople(); syncFields(); refresh(); } return; }
      if (!pickList || pickList.hidden) return;
      var sel = function (i) { var n = pickItems.length, k = i; while (k >= 0 && k < n && pickItems[k].off) k += (i >= pickActive ? 1 : -1); return k; };
      if (e.key === "ArrowDown") { pickActive = Math.min(pickItems.length - 1, sel(pickActive + 1)); pickMark(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { pickActive = Math.max(0, sel(pickActive - 1)); pickMark(); e.preventDefault(); }
      else if (e.key === "Enter" && pickActive >= 0) { pickChoose(pickActive); e.preventDefault(); }
      else if (e.key === "Escape" && !pickList.hidden) { pickClose(); e.preventDefault(); e.stopPropagation(); }
    });

    function placeReady() {
      var u = unitInfo(unitSel.value);
      if (!u) return false;
      var sc = scope();
      if (sc === "unit") return !(u.whole_rule && u.whole_rule !== editingId);
      if (sc === "depts") return Object.keys(picked).length > 0;
      return namedList().length > 0;
    }
    function alsoIds() {
      if (!o1 || o1.hidden || !o1All.checked) return [];
      return [].map.call(o1Rows.querySelectorAll('input[name="also_rule"]:checked'), function (i) { return i.value; });
    }
    function query() {
      var p = new URLSearchParams();
      p.set("bg", D.bg); p.set("cycle", D.cycle); if (editingId) p.set("rule_id", editingId);
      p.set("rule_unit", unitSel.value); p.set("rule_scope", scope());
      if (scope() === "depts") Object.keys(picked).forEach(function (d) { p.append("rule_dept", d); });
      if (scope() !== "unit") Object.keys(named).forEach(function (k) { p.append("rule_person", k); });
      alsoIds().forEach(function (i) { p.append("also_rule", i); });
      LAB.forEach(function (l, i) { if (i) p.set("min_" + l, pstart[l].value); });
      return p;
    }
    function unitLabel() { var u = unitInfo(unitSel.value); return u ? u.label : ""; }
    function deptWords() {
      var u = unitInfo(unitSel.value); if (!u || scope() !== "depts") return "";
      return (u.depts || []).filter(function (d) { return picked[d.d]; }).map(function (d) { return d.label || d.d; }).join(", ");
    }
    function startsWords(v) { return LAB.map(function (l, i) { return l + " " + fmt(v[i]); }).join(" · "); }
    function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

    // ---- O1: the same new starts for the rules that start where this one did (an edit whose starts differ from the saved ones) ----
    function o1Update() {
      if (!o1) return;
      var show = !!editingId && sameRules.length > 0 && startsChanged() && !startsError();
      if (!show) { o1.hidden = true; return; }
      if (o1.hidden || o1.getAttribute("data-for") !== String(editingId)) { o1Build(); }
      o1.hidden = false;
    }
    function o1Build() {
      o1.setAttribute("data-for", String(editingId));
      o1Rows.textContent = "";
      document.getElementById("br-o1-t").textContent = "Give these starts to " + plural(sameRules.length, "other rule", "other rules") + " too";
      document.getElementById("br-o1-note").textContent = "The rules in " + D.cycleName + " that start where this one did. Untick any to leave it.";
      o1All.checked = true;
      var row = function (r) {
        var lab = el("label", "br-o1-row");
        var cb = el("input"); cb.type = "checkbox"; cb.name = "also_rule"; cb.value = r.id; cb.checked = !alsoOff[r.id];
        lab.appendChild(cb);
        lab.appendChild(el("span", "br-o1-w", r.unit + " · " + r.scope));
        lab.appendChild(el("span", "br-o1-n muted small", plural(r.people, "person", "people")));
        return lab;
      };
      var shown = sameRules.slice(0, 4), more = sameRules.slice(4);
      shown.forEach(function (r) { o1Rows.appendChild(row(r)); });
      if (more.length) {
        var d = el("details", "fold br-o1-fold"); d.appendChild(el("summary", null, more.length + " more"));
        var inner = el("div", "br-o1-rows"); more.forEach(function (r) { inner.appendChild(row(r)); }); d.appendChild(inner);
        var less = el("button", "btn-link", "Show less"); less.type = "button"; less.setAttribute("data-fold-less", ""); d.appendChild(less);
        o1Rows.appendChild(d);
      }
    }
    if (o1) {
      o1.addEventListener("change", function (e) {
        if (e.target === o1All) { [].forEach.call(o1Rows.querySelectorAll('input[name="also_rule"]'), function (i) { i.disabled = !o1All.checked; }); }
        else if (e.target.name === "also_rule") { alsoOff[e.target.value] = !e.target.checked; }
        refresh();
      });
    }

    function confirmBody() {
      var box = document.getElementById("br-rule-body"); box.textContent = "";
      var r = last || {}, n = r.people != null ? r.people : 0, v = startsVals();
      var many = r.rules && r.rules.length > 1;
      var remark = form.querySelector("#br-remark").value.trim();
      if (many) {
        var ul = el("ul", "br-cdiff");
        r.rules.forEach(function (x) {
          var li = el("li"); li.appendChild(el("strong", null, x.unit + " · " + x.scope));
          li.appendChild(document.createTextNode(" · " + plural(x.people, "person", "people"))); ul.appendChild(li);
        });
        box.appendChild(ul);
        box.appendChild(el("p", null, (savedStarts ? startsWords(savedStarts) + " → " : "") + startsWords(v)));
      } else {
        var ul2 = el("ul", "br-cdiff"), rc = r.reach || {};
        if (scope() === "unit" || (rc.dept_people != null && (rc.dept_people > 0 || !(rc.named || []).length))) {
          var dn = scope() === "unit" ? n : rc.dept_people;
          var l1 = el("li"); l1.appendChild(el("strong", null, String(dn))); l1.appendChild(document.createTextNode(" in " + (scope() === "unit" ? "all departments" : deptWords())));
          ul2.appendChild(l1);
        }
        if (rc.named && rc.named.length) {
          var byDept = []; rc.named.forEach(function (x) { if (byDept.indexOf(x.dept_label) < 0 && x.dept_label) byDept.push(x.dept_label); });
          var l2 = el("li"); l2.appendChild(el("strong", null, String(rc.named.length)));
          l2.appendChild(document.createTextNode(" named " + (rc.named.length === 1 ? "person" : "people") + " in " + (byDept.join(", ") || "their departments") + ": " +
            rc.named.map(function (x) { return x.name; }).join(", ")));
          ul2.appendChild(l2);
        }
        box.appendChild(ul2);
        box.appendChild(el("p", null, startsWords(v)));
      }
      var keys = Object.keys(r.moves || {}).sort();
      box.appendChild(el("p", "muted small", r.changes ? (keys.length ? keys.map(function (k) { return k + " " + r.moves[k]; }).join(" · ") + "." : "No one changes band.") : ""));
      var rp = el("p", null); rp.appendChild(el("strong", null, "Remark: ")); rp.appendChild(document.createTextNode(remark)); box.appendChild(rp);
    }
    function setConfirm() {
      var n = last && last.people != null ? last.people : null, many = last && last.rules && last.rules.length > 1;
      var cn = D.cycleName;
      if (many) {
        form.setAttribute("data-confirm", "Each of these " + last.rules.length + " rules uses the new starts, for " + plural(n, "person", "people") + ":");
        form.setAttribute("data-confirm-title", "Save the new starts for " + last.rules.length + " rules in " + cn + "?");
        form.setAttribute("data-confirm-ok", "Save " + last.rules.length + " rules");
      } else {
        form.setAttribute("data-confirm", (n != null ? n + (n === 1 ? " person uses" : " people use") : "These people use") + " these bands:");
        form.setAttribute("data-confirm-title", "Save the rule for " + unitLabel() + " in " + cn + "?");
        form.setAttribute("data-confirm-ok", "Save rule");
      }
      confirmBody();
    }
    function validate() {
      var remark = form.querySelector("#br-remark").value.trim();
      var typed = pickQ.value.trim();
      var ok = placeReady() && !startsError() && !(last && last.ok === false) && remark.length > 0 && !typed;
      saveBtn.disabled = !ok;
      var nr = (last && last.rules && last.rules.length > 1) ? last.rules.length : 0;
      saveBtn.textContent = nr ? "Save " + nr + " rules" : "Save rule";
      setConfirm();
      footNote.textContent = !unitSel.value ? "Pick a unit to see what changes."
        : !placeReady() ? (scope() === "people" ? "Pick at least one person." : scope() === "depts" ? "Pick at least one department." : "The whole unit already has a rule.")
        : startsError() ? startsError()
        : typed ? "Choose the person from the list, or clear what you typed."
        : (last && last.ok === false) ? ""
        : !remark ? "Write your remark to save."
        : nr ? nr + " rules get these starts." : "You'll confirm on the next step.";
    }
    function tile(id, v) { document.getElementById(id).textContent = v == null ? "–" : String(v); }
    function renderPreview(r) {
      last = r;
      var perr = document.getElementById("br-place-err");
      perr.textContent = r && r.ok === false ? (r.error || "") : ""; perr.hidden = !perr.textContent;
      tile("br-n-people", r ? r.people : null); tile("br-n-res", r ? r.with_results : null);
      document.getElementById("br-n-people-l").textContent = r && r.rules && r.rules.length > 1 ? "people on " + r.rules.length + " rules" : "people on this rule";
      var chg = r && r.changes ? r.changes : null;
      tile("br-n-chg", chg ? chg.length : null);
      var mv = document.getElementById("br-moves"), fold = document.getElementById("br-fold");
      mv.textContent = ""; fold.hidden = true;
      if (r && chg) {
        var keys = Object.keys(r.moves || {}).sort();
        mv.textContent = keys.length ? keys.map(function (k) { return k + " " + r.moves[k]; }).join(" · ") + "." : (r.with_results ? "Nobody changes band." : "");
        if (chg.length) {
          fold.hidden = false;
          document.getElementById("br-fold-s").textContent = chg.length + " change band";
          var ul = document.getElementById("br-fold-l"); ul.textContent = "";
          chg.forEach(function (c) {
            var li = el("li"); li.appendChild(document.createTextNode(c.name + (c.dept ? " · " + (c.dept_label || c.dept) : "") + ": "));
            li.appendChild(el("strong", null, c.from)); li.appendChild(document.createTextNode(" → ")); li.appendChild(el("strong", null, c.to));
            ul.appendChild(li);
          });
        }
      } else if (r && r.starts_error) { mv.textContent = "Set valid starts to see who changes band."; }
      // who it reaches: "N people: X in Y departments and Z named"
      var rbox = document.getElementById("br-reach"), rt = document.getElementById("br-reach-t");
      var rc = r && r.reach; rt.textContent = ""; rbox.hidden = true;
      if (rc && (rc.named || []).length) {
        rbox.hidden = false;
        // THIS rule's own reach, never the O1 total (the tiles keep that): its departments' people and the people it names
        var nn = rc.named.length, own = (rc.dept_people || 0) + nn, strong = el("strong", null, plural(own, "person", "people"));
        rt.appendChild(document.createTextNode("This rule reaches ")); rt.appendChild(strong);
        var words;
        if (!rc.dept_people) words = nn === 1 ? ", named." : ", all named.";
        else words = ": " + rc.dept_people + " in " + plural((rc.depts || []).length, "department", "departments") + " and " + nn + " named.";
        rt.appendChild(document.createTextNode(words));
        if (rc.other) rt.appendChild(document.createTextNode(" The other " + rc.other.n + " in " + rc.other.dept_label + " stay on " + (D.bgLabel || "the group") + "'s bands."));
      }
      // the highest score possible here
      var box = document.getElementById("br-highest"), t = document.getElementById("br-highest-t");
      var h = r && r.highest; box.hidden = !h; t.textContent = "";
      if (h) {
        var strong2 = el("strong");
        if (h.kind === "open") {
          strong2.textContent = "No cap above target.";
          t.appendChild(strong2); t.appendChild(document.createTextNode(" These KPI lines let a score pass 100%, so the group's bands can be reached here."));
        } else {
          strong2.textContent = "Highest score possible here: " + fmt(h.pct) + "%.";
          t.appendChild(strong2);
          t.appendChild(document.createTextNode(h.kind === "capped"
            ? " Every KPI line for these " + (r.people === 1 ? "person" : r.people + " people") + " has multiplier 0, so nobody can score above target."
            : " The KPI lines stop at their excellence figure, so nobody can score above that."));
          if (h.top_default) t.appendChild(document.createTextNode(" With the group default they top out at " + h.top_default + "."));
        }
      }
      validate();
    }
    function refresh() {
      o1Update();
      validate();
      clearTimeout(timer);
      if (!unitSel.value || !placeReady()) { last = null; renderPreview(null); return; }
      var me = ++seq;
      timer = setTimeout(function () {
        fetch(D.previewUrl + "?" + query().toString(), { headers: { "X-Requested-With": "fetch", "Accept": "application/json" }, credentials: "same-origin" })
          .then(function (r) { return r.json().catch(function () { return { ok: false, error: "The preview could not be read." }; }); })
          .then(function (j) { if (me === seq) renderPreview(j); })
          .catch(function () { if (me === seq) renderPreview({ ok: false, error: "The preview could not be loaded. Try again." }); });
      }, 250);
    }

    // state = {id, company, scope, whole, depts, people[Employee IDs], same[], also[], starts[5], remark}: a new rule starts from the
    // group default, an edit from the rule's own, a refused save from what was entered (the server's data-draft)
    function reset(st) {
      editingId = st.id || null; ruleId.value = editingId || "";
      picked = {}; named = {}; alsoOff = {}; last = null;
      sameRules = st.same || [];
      savedStarts = editingId && st.saved ? st.saved : (editingId ? (st.starts || null) : null);
      title.textContent = editingId ? "Edit the rule" : "Add a rule";
      unitSel.value = st.company || "";
      setScope(st.scope || (st.whole === false ? "depts" : "unit"));
      (st.depts || []).forEach(function (d) { picked[d] = 1; });
      var avail = peopleAvail(), byEid = {}; avail.forEach(function (p) { byEid[p.eid] = p; });
      (st.people || []).forEach(function (e) { if (byEid[e]) named[e] = byEid[e]; });
      if (st.also && st.also.length) sameRules.forEach(function (r) { alsoOff[r.id] = st.also.indexOf(r.id) < 0; });
      LAB.forEach(function (l, i) {
        if (!i) return;
        var v = st.starts ? st.starts[i] : "";
        pstart[l].value = v === null || v === undefined ? "" : v;
      });
      if (o1) { o1.hidden = true; o1.removeAttribute("data-for"); }
      pickQ.value = "";
      form.querySelector("#br-remark").value = st.remark || "";
      renderChips(); drawRuleBar(); renderPreview(null); o1Update();
      if (unitSel.value) refresh();
    }
    function blank() { return { id: null, company: "", scope: "unit", whole: true, depts: [], people: [], starts: defaults.length === 5 ? defaults : null, remark: "" }; }
    // set up before admin.js opens the panel (capture phase)
    document.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-band-add], [data-band-edit]");
      if (!b) return;
      if (b.hasAttribute("data-band-add")) reset(blank());
      else { var r = null; try { r = JSON.parse(b.getAttribute("data-rule")); } catch (er) {} reset(r || blank()); }
    }, true);
    unitSel.addEventListener("change", function () { picked = {}; named = {}; renderChips(); refresh(); });
    form.addEventListener("change", function (e) {
      if (e.target.name === "rule_scope") {
        if (scope() !== "depts") picked = scope() === "people" ? {} : picked;
        if (scope() === "unit") named = {};
        dropHeldNamed(); renderChips(); refresh();
      }
    });
    form.addEventListener("input", function (e) {
      if (e.target.matches && e.target.matches("[data-pstart]")) { drawRuleBar(); refresh(); }
      else if (e.target.id === "br-remark") validate();
    });
    document.getElementById("br-fill").addEventListener("click", function () {
      if (defaults.length !== 5) return;
      LAB.forEach(function (l, i) { if (i) pstart[l].value = defaults[i]; });
      drawRuleBar(); refresh();
    });
    form.addEventListener("submit", function (e) {
      // the server checks it all again; this only stops a send the panel already knows is wrong
      if (saveBtn.disabled) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      syncFields();   // before the confirm box and before the send: the departments and the people are in the form
      setConfirm();
    }, true);
    // a refused save comes back with the panel open and what was entered
    var draft = null;
    try { draft = JSON.parse(form.getAttribute("data-draft") || "null"); } catch (er) { draft = null; }
    if (draft) { var rr = null; if (draft.id) { var eb = document.querySelector('[data-rule-row="' + draft.id + '"] [data-band-edit]'); try { rr = eb ? JSON.parse(eb.getAttribute("data-rule")) : null; } catch (er2) { rr = null; } }
      draft.same = rr ? rr.same : []; draft.saved = rr ? rr.starts : null; reset(draft); }
    else { drawRuleBar(); renderChips(); }
  }

  // ---- the 5-point table (a 5-point group's card b): editable by the super admin while the cycle's starts may change ----
  // Everything here only helps: the bar and Check a score follow the inputs, Save waits for a valid change and for the
  // preview of who changes, and the server checks the starts, the remark and the cycle's window again.
  var f5 = document.getElementById("br-five-form");
  var five = f5 && f5.tagName === "FORM" ? {
    form: f5, err: document.getElementById("br-five-err"), status: document.getElementById("br-five-status"),
    undo: document.getElementById("br-five-undo"), save: document.getElementById("br-five-save"),
    body: document.getElementById("br-five-body"), saved: [], seq: 0, timer: null, ready: false
  } : null;
  if (five) {
    try { five.saved = JSON.parse(f5.getAttribute("data-saved")) || []; } catch (e) { five.saved = []; }
  }
  function f2(n) { return (Math.round(n * 100) / 100).toFixed(2); }
  function fiveVals() { return LAB.map(function (k, i) { return i === 0 ? 1 : num(f5.querySelector('[data-start-in="' + k + '"]').value); }); }
  function fiveError(v) {
    for (var i = 1; i < 5; i++) {
      if (v[i] === null) return "Enter where " + LAB[i] + " starts.";
      if (v[i] < 1 || v[i] > 5) return LAB[i] + " must start between 1.00 and 5.00.";
      if (Math.abs(v[i] * 100 - Math.round(v[i] * 100)) > 1e-6) return LAB[i] + " must use at most two decimals (e.g. " + f2(v[i]) + ").";
      if (!(v[i] > v[i - 1])) return LAB[i] + " must start higher than " + LAB[i - 1] + " (" + f2(v[i - 1]) + ").";
    }
    return "";
  }
  function fiveDirty(v) { return v.some(function (x, i) { return x === null || Math.abs(x - five.saved[i]) > 1e-9; }); }
  function fiveBody(r, v) {
    var b = five.body; b.textContent = "";
    var ul = el("ul", "br-cdiff");
    LAB.forEach(function (k, i) {
      if (i && Math.abs(v[i] - five.saved[i]) > 1e-9) {
        var li = el("li"); li.appendChild(el("strong", null, k)); li.appendChild(document.createTextNode(" starts at " + f2(five.saved[i]) + " \u2192 " + f2(v[i])));
        ul.appendChild(li);
      }
    });
    b.appendChild(ul);
    var tiles = el("div", "br-tiles");
    [[r.people, "people on the 5-point rating"], [r.with_results, "with a KPI result so far"], [(r.changes || []).length, "change band"]].forEach(function (t) {
      var tl = el("div", "br-tile"); tl.appendChild(el("div", "br-tn", String(t[0]).replace(/\B(?=(\d{3})+(?!\d))/g, ",")));
      tl.appendChild(el("div", "muted small", t[1])); tiles.appendChild(tl);
    });
    b.appendChild(tiles);
    var keys = Object.keys(r.moves || {}).sort();
    var mv = el("p", "muted small br-cmoves", keys.length ? keys.map(function (k) { return k + " " + r.moves[k]; }).join(" \u00b7 ") + "." : (r.with_results ? "Nobody changes band." : "No one has a KPI result yet, so nobody changes band now."));
    b.appendChild(mv);
    var ch = r.changes || [];
    if (ch.length) {
      var d = el("details", "fold br-fold"); d.appendChild(el("summary", null, ch.length + " change band"));
      var ul2 = el("ul");
      ch.forEach(function (c) {
        var li = el("li"); li.appendChild(document.createTextNode(c.name + (c.dept ? " \u00b7 " + (c.dept_label || c.dept) : "") + ": "));
        li.appendChild(el("strong", null, c.from)); li.appendChild(document.createTextNode(" \u2192 ")); li.appendChild(el("strong", null, c.to)); ul2.appendChild(li);
      });
      d.appendChild(ul2);
      var less = el("button", "btn-link", "Show less"); less.type = "button"; less.setAttribute("data-fold-less", ""); d.appendChild(less);
      b.appendChild(d);
    }
    b.appendChild(el("p", "muted small br-cnote", "A band already moved in a Department Review or Talent Box, or released, stays as it is."));
  }
  function fiveQuery(v) {
    var p = new URLSearchParams(); p.set("cycle", D.cycle);
    LAB.forEach(function (k, i) { if (i) p.set("min_" + k, f2(v[i])); });
    return p;
  }
  function fiveInput() {
    if (!five) return;
    var v = fiveVals(), bar = document.querySelector("#br-five-form .br-bar");
    if (bar) { bar.setAttribute("data-starts", v.map(function (x) { return x === null ? "" : x; }).join(",")); drawBar(bar); }
    updateCheck();
    var err = fiveError(v), dirty = fiveDirty(v);
    var anyBlank = v.slice(1).some(function (x) { return x === null; });
    five.err.textContent = err; five.err.hidden = !err || (anyBlank && !dirty);
    five.undo.hidden = !dirty;
    five.save.disabled = true; five.ready = false;
    clearTimeout(five.timer); five.seq++;
    if (err) { five.status.textContent = dirty ? "Fix the starts to save." : "No change yet."; return; }
    if (!dirty) { five.status.textContent = "No change yet."; five.body.textContent = ""; return; }
    five.status.textContent = "Checking who changes band\u2026";
    var me = five.seq;
    five.timer = setTimeout(function () {
      fetch(D.fiveUrl + "?" + fiveQuery(v).toString(), { headers: { "X-Requested-With": "fetch", "Accept": "application/json" }, credentials: "same-origin" })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (j) {
          if (me !== five.seq) return;
          if (!j || j.starts_error || j.ok === false) { five.status.textContent = (j && j.error) || "The preview could not be read. Try again."; return; }
          fiveBody(j, v);
          var n = (j.changes || []).length;
          five.status.textContent = n ? n + (n === 1 ? " person changes band." : " people change band.") : "Nobody changes band now.";
          five.save.disabled = false; five.ready = true;
        })
        .catch(function () { if (me === five.seq) five.status.textContent = "The preview could not be loaded. Try again."; });
    }, 250);
  }
  if (five) {
    five.undo.addEventListener("click", function () {
      LAB.forEach(function (k, i) { if (i) f5.querySelector('[data-start-in="' + k + '"]').value = f2(five.saved[i]); });
      fiveInput();
    });
    f5.addEventListener("submit", function (e) {
      // only a valid, previewed change is sent; the server checks it all again
      if (!five.ready) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
  }

  drawAll();
  updateCheck();
})();
