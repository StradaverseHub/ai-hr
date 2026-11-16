/* A calibration panel's three steps (Chris, 2026-10-26; canvas [design canvas link removed]).
   Step 1: the units ticked narrow the calibrator search (or the whole business group) and the PAT curve's list. Step 2:
   a card per calibrator chosen, with the departments of the units ticked and people by name. Step 3: the server's own
   plan of the form (bu_panel_preview: who each calibrator has, the people they share, the weights), drawn here with a
   weight box for each calibrator sharing people. Nothing is written before Save, which goes through OneHR's confirm box
   and is checked again on the server. */
(function () {
  var UNITS = {};
  try { UNITS = JSON.parse((document.getElementById("bp-units") || {}).textContent || "{}"); } catch (e) { UNITS = {}; }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function chipsOf(box) {   // the people a multi picker holds, as [{eid, name}]
    var out = [];
    if (!box) return out;
    box.querySelectorAll(".pick-chip").forEach(function (c) {
      var sm = c.querySelector("small");
      var eid = sm ? sm.textContent.trim() : "";
      var name = (c.firstChild && c.firstChild.nodeType === 3 ? c.firstChild.textContent : "").trim();
      if (eid) out.push({ eid: eid, name: name || eid });
    });
    return out;
  }

  document.querySelectorAll("form[data-bp-form]").forEach(function (f) {
    var init = { cals: [], weights: {} }, taken = {};
    try { init = JSON.parse(f.querySelector("[data-bp-init]").textContent) || init; } catch (e) { /* keep empty */ }
    try { taken = JSON.parse(f.querySelector("[data-bp-taken]").textContent) || {}; } catch (e) { taken = {}; }
    var NCURL = "";
    try { NCURL = JSON.parse(f.querySelector("[data-bp-nc-url]").textContent) || ""; } catch (e) { NCURL = ""; }
    var DPURL = "";
    try { DPURL = JSON.parse(f.querySelector("[data-bp-dp-url]").textContent) || ""; } catch (e) { DPURL = ""; }
    var dpCache = {};   // "unit||department" -> the people (a promise), loaded on the first unfold and kept for the page
    function deptPeople(u, d) {
      var k = u + "||" + d;
      if (!dpCache[k]) {
        dpCache[k] = fetch(DPURL + "&unit=" + encodeURIComponent(u) + "&dept=" + encodeURIComponent(d),
                           { credentials: "same-origin", headers: { "X-Requested-With": "fetch" } })
          .then(function (r) { if (!r.ok) throw new Error("x"); return r.json(); })
          .then(function (j) { return j.people || []; })
          .catch(function () { delete dpCache[k]; throw new Error("x"); });
      }
      return dpCache[k];
    }
    function fillDeptPeople(box, u, d) {   // a department's people, view only: Name, Employee ID, Job title
      box.innerHTML = "";
      box.appendChild(el("p", "muted small bp-dp-msg", "Loading…"));
      deptPeople(u, d).then(function (ppl) {
        box.innerHTML = "";
        if (!ppl.length) { box.appendChild(el("p", "muted small bp-dp-msg", "Nobody in this department.")); return; }
        var wrap = el("div", "bp-dp-scroll"), tb = document.createElement("table");
        tb.className = "bp-dp-table";
        var hr = document.createElement("tr");
        ["Name", "Employee ID", "Job title"].forEach(function (h) { var th = document.createElement("th"); th.textContent = h; hr.appendChild(th); });
        var th0 = document.createElement("thead"); th0.appendChild(hr); tb.appendChild(th0);
        var tbd = document.createElement("tbody");
        ppl.forEach(function (p) {
          var tr = document.createElement("tr");
          [[p.name, "bp-dp-name"], [p.eid, "bp-dp-eid"], [p.title || "", "bp-dp-title"]].forEach(function (c) {
            var td = el("td", c[1], c[0]); if (c[0]) td.title = c[0]; tr.appendChild(td);
          });
          tbd.appendChild(tr);
        });
        tb.appendChild(tbd); wrap.appendChild(tb); box.appendChild(wrap);
      }, function () {
        box.innerHTML = "";
        box.appendChild(el("p", "muted small bp-dp-msg", "Couldn't load the people of this department. Fold it and unfold again to retry."));
      });
    }
    var pidEl = f.querySelector('[name="panel_id"]'), PID = pidEl ? pidEl.value : "";
    var nc = null, ncState = "idle";   // "Not covered yet": the server's people of each unit no other panel holds
    // per calibrator (Employee ID): the departments ticked, the people by name, and the units they take everyone left in
    var state = {}, names = {};
    (init.cals || []).forEach(function (c) {
      var ds = {}, ls = {};
      (c.dept_keys || []).forEach(function (k) { ds[k] = true; });
      (c.left_units || []).forEach(function (u) { ls[u] = true; });
      state[c.eid] = { depts: ds, people: c.people_init || [], left: ls };
      names[c.eid] = c.name;
    });
    var step = 1;
    var err = f.querySelector("[data-bp-err]"), calBox = f.querySelector("[data-bp-calpick]");
    var anyone = f.querySelector("[data-bp-anyone]"), curve = f.querySelector("[data-bp-curve]");
    var where = f.querySelector("[data-bp-pickwhere]");
    var cards = f.querySelector("[data-bp-cards]"), planBox = f.querySelector("[data-bp-plan]");
    var nextB = f.querySelector("[data-bp-next]"), backB = f.querySelector("[data-bp-back]");
    var saveB = f.querySelector("[data-bp-save]");

    function say(msg) { err.textContent = msg || ""; err.hidden = !msg; }
    function units() {
      return Array.prototype.map.call(f.querySelectorAll('input[name="panel_unit"]:checked'), function (x) { return x.value; });
    }
    function whole() { return anyone.getAttribute("aria-pressed") === "true"; }
    function syncUnits() {
      var us = units(), on = {};
      us.forEach(function (u) { on[u] = 1; });
      calBox.setAttribute("data-pick-units", whole() ? "" : us.join("||"));
      Array.prototype.forEach.call(curve.options, function (o) { if (o.value) o.disabled = us.length > 0 && !on[o.value]; });
      if (curve.value && us.length && !on[curve.value]) curve.value = "";
      if (!curve.value && us.length === 1) curve.value = us[0];
    }
    anyone.addEventListener("click", function () {
      var w = !whole();
      anyone.setAttribute("aria-pressed", w ? "true" : "false");
      anyone.textContent = w ? "Search only the units ticked" : "Search the whole business group instead";
      where.textContent = w ? "Search anyone in the business group; add as many as you need."
                            : "Search the people of the units ticked above; add as many as you need.";
      syncUnits();
    });
    f.addEventListener("change", function (e) { if (e.target.name === "panel_unit") syncUnits(); });
    // the tag picked on step 1 (BGCFO tag, 2026-11-04): step 3's note follows with no reload; the words sit in the
    // page's own <template data-bp-cg-tpl="CG|BGCFO">, the server having drawn the stored tag's
    var cgNote = f.querySelector("[data-bp-cg-note]");
    f.addEventListener("change", function (e) {
      if (e.target.name !== "panel_tag" || !e.target.checked || !cgNote) return;
      var tpl = f.querySelector('template[data-bp-cg-tpl="' + e.target.value + '"]');
      if (tpl) cgNote.innerHTML = tpl.innerHTML;
    });
    calBox.addEventListener("pick", function (e) { if (e.detail && e.detail.eid) names[e.detail.eid] = e.detail.name; });

    function cals() {   // the calibrators chosen, in the order they were picked
      var v = (calBox.querySelector(".pick-val") || {}).value || "";
      chipsOf(calBox).forEach(function (c) { if (!names[c.eid]) names[c.eid] = c.name; });
      return v ? v.split(",").filter(Boolean) : [];
    }
    function readCards() {   // keep what step 2 holds, before it is drawn again
      cards.querySelectorAll("[data-bp-card]").forEach(function (card) {
        var eid = card.getAttribute("data-bp-card"), st = state[eid] || (state[eid] = { depts: {}, people: [], left: {} });
        st.depts = {}; st.left = {};
        card.querySelectorAll('input[name^="dept_"]:checked').forEach(function (c) { st.depts[c.value] = true; });
        card.querySelectorAll('input[name^="left_"]:checked').forEach(function (c) { st.left[c.value] = true; });
        st.people = chipsOf(card.querySelector("[data-pick]"));
      });
    }
    function count() {   // a count to go by (people of the departments ticked, and the names); step 3 has the exact one
      cards.querySelectorAll("[data-bp-card]").forEach(function (card) {
        var n = 0, nl = 0;
        card.querySelectorAll('input[name^="dept_"]:checked:not(:disabled)').forEach(function (c) { n += parseInt(c.getAttribute("data-n"), 10) || 0; });
        card.querySelectorAll('input[name^="left_"]:checked').forEach(function () { nl++; });
        var pv = card.querySelector(".pick-val");
        n += pv && pv.value ? pv.value.split(",").filter(Boolean).length : 0;
        card.querySelector(".bp-card-n").textContent = n + (n === 1 ? " person" : " people") +
          (nl ? " + everyone left in " + (nl === 1 ? "a unit" : nl + " units") : "");
      });
    }
    function cardsOf() { return Array.prototype.slice.call(cards.querySelectorAll("[data-bp-card]")); }
    function valsOf(card) { var pv = card.querySelector(".pick-val"); return pv && pv.value ? pv.value.split(",").filter(Boolean) : []; }
    function claimedElsewhere(card, u) {
      // what the OTHER cards of this form hold in a unit: departments ticked, people named, and who takes everyone left
      var depts = {}, named = {}, left = [];
      cardsOf().forEach(function (o) {
        if (o === card) return;
        o.querySelectorAll('input[name^="dept_"]:checked:not(:disabled)').forEach(function (c) { depts[c.value] = true; });
        valsOf(o).forEach(function (e) { named[e] = true; });
        var lc = o.querySelector('input[name^="left_"][value="' + u.replace(/"/g, '\\"') + '"]');
        if (lc && lc.checked) left.push(names[o.getAttribute("data-bp-card")] || "another calibrator");
      });
      return { depts: depts, named: named, left: left };
    }
    function listOf(card, u) {   // the people of unit u still to give: not another panel's, not another card's by dept or name
      var d = nc && nc.units && nc.units[u];
      if (!d) return [];
      var cl = claimedElsewhere(card, u), mine = {};
      card.querySelectorAll('input[name^="dept_"]:checked:not(:disabled)').forEach(function (c) { mine[c.value] = true; });
      return d.people.filter(function (p) { return !cl.named[p.eid] && !cl.depts[u + "||" + p.dept] && !mine[u + "||" + p.dept]; });
    }
    function fillList(card, u) {
      var box = card.querySelector('[data-bp-nc="' + u.replace(/"/g, '\\"') + '"]');
      if (!box) return;
      var body = box.querySelector(".bp-nc-body"), chip = box.querySelector(".bp-nc-n"), q = box.querySelector(".bp-nc-q");
      var tickAll = box.querySelector(".bp-nc-all"), hint = box.querySelector(".bp-nc-hint");
      var uname = (UNITS[u] || {}).label || u;
      var lc = card.querySelector('input[name^="left_"][value="' + u.replace(/"/g, '\\"') + '"]');
      var off = !!(lc && lc.checked);
      box.classList.toggle("is-off", off);
      q.disabled = off || !nc;
      var scroll = body.scrollTop;
      body.innerHTML = "";
      if (ncState === "loading") { chip.textContent = "…"; hint.textContent = "Loading the people of " + uname + "…"; tickAll.hidden = true; return; }
      if (ncState === "error" || !nc || !nc.units || !nc.units[u]) {
        chip.textContent = "?"; hint.textContent = "Couldn't load who is not covered yet. Go back and Next to try again."; tickAll.hidden = true; return;
      }
      var d = nc.units[u], cl = claimedElsewhere(card, u), mine = valsOf(card);
      if (d.left_in) {
        chip.textContent = "0"; tickAll.hidden = true;
        hint.textContent = "Everyone left on " + (d.left_by || "another calibrator") + " (" + d.left_in + ") covers them.";
        return;
      }
      if (!off && cl.left.length) {
        chip.textContent = "0"; tickAll.hidden = true;
        hint.textContent = "Everyone left on " + cl.left.join(" and ") + " covers them. Tick Everyone left here too to share them.";
        return;
      }
      hint.textContent = off ? "This calibrator takes everyone left in " + uname + ", so nobody is picked one by one here."
        : "In " + uname + ", given to no calibrator in this or another panel. Ticked people go to this calibrator by name.";
      var rows = listOf(card, u), term = (q.value || "").trim().toLowerCase(), todo = 0, shown = 0;
      rows.forEach(function (p) {
        var on = mine.indexOf(p.eid) >= 0;
        if (!on) todo++;
        if (term && (p.name + " " + p.eid + " " + p.dept_label).toLowerCase().indexOf(term) < 0) return;
        shown++;
        var lab = el("label", "bp-nc-row" + (on ? " is-on" : "")), cb = document.createElement("input");
        cb.type = "checkbox"; cb.className = "bp-nc-cb"; cb.checked = on; cb.disabled = off;
        cb.setAttribute("data-eid", p.eid); cb.setAttribute("data-name", p.name);
        lab.appendChild(cb);
        var nm = el("span", "bp-nc-name", p.name); nm.title = p.name; lab.appendChild(nm);
        lab.appendChild(el("span", "bp-nc-eid", p.eid));
        var dp = el("span", "bp-nc-dept", p.dept_label); dp.title = p.dept_label; lab.appendChild(dp);
        body.appendChild(lab);
      });
      if (!shown) body.appendChild(el("p", "muted small bp-nc-none", rows.length ? "Nobody matches." : "Everyone in " + uname + " is covered."));
      body.scrollTop = scroll;
      chip.textContent = String(todo);
      var visTodo = body.querySelectorAll(".bp-nc-cb:not(:checked)").length;
      tickAll.hidden = !visTodo || off;
      tickAll.textContent = "Tick all " + visTodo;
    }
    function leftCount(card, u) {   // "N now" under Everyone left: in no other card's departments or names, nor another panel's
      var d = nc && nc.units && nc.units[u];
      if (!d) return null;
      var cl = claimedElsewhere(card, u);
      return d.people.filter(function (p) { return !cl.named[p.eid] && !cl.depts[u + "||" + p.dept]; }).length;
    }
    function fillLeft(card, u) {
      var line = card.querySelector('[data-bp-leftn="' + u.replace(/"/g, '\\"') + '"]');
      if (!line) return;
      var n = leftCount(card, u), uname = (UNITS[u] || {}).label || u;
      var held = nc && nc.units && nc.units[u] && nc.units[u].left_in;
      if (held) { line.textContent = "Everyone left in " + uname + " is with " + held; return; }
      line.textContent = (n == null ? (ncState === "loading" ? "…" : "?") : n) + " now: everyone in no other calibrator's departments or names. Whoever joins later and is not given to someone else comes here too.";
    }
    function applyLeft(card) {   // Everyone left ticked: that unit's departments grey out (disabled), as the list does
      card.querySelectorAll("[data-bp-unit]").forEach(function (blk) {
        var u = blk.getAttribute("data-bp-unit"), lc = blk.querySelector('input[name^="left_"]');
        var d = nc && nc.units && nc.units[u], held = !!(d && d.left_in);
        if (lc) { if (held) { lc.checked = false; lc.disabled = true; } else lc.disabled = false; }
        var on = !!(lc && lc.checked);
        blk.classList.toggle("is-left", on);
        blk.querySelectorAll('input[name^="dept_"]').forEach(function (cb) {
          if (on) { if (!cb.disabled) { cb.disabled = true; cb.setAttribute("data-by-left", "1"); } }
          else if (cb.getAttribute("data-by-left")) { cb.disabled = false; cb.removeAttribute("data-by-left"); }
        });
      });
    }
    function refresh() {   // every card's lists, after any tick on any card
      cardsOf().forEach(function (card) {
        applyLeft(card);
        card.querySelectorAll("[data-bp-unit]").forEach(function (blk) {
          var u = blk.getAttribute("data-bp-unit");
          fillLeft(card, u); fillList(card, u);
        });
      });
      count();
    }
    function loadNc(us) {
      if (!NCURL || !us.length) { nc = { units: {} }; ncState = "ok"; return Promise.resolve(); }
      ncState = "loading";
      return fetch(NCURL + "&units=" + encodeURIComponent(us.join("||")) + (PID ? "&panel=" + encodeURIComponent(PID) : ""),
                   { credentials: "same-origin", headers: { "X-Requested-With": "fetch" } })
        .then(function (r) { if (!r.ok) throw new Error("x"); return r.json(); })
        .then(function (d) { nc = d; ncState = "ok"; })
        .catch(function () { nc = null; ncState = "error"; });
    }
    function drawCards() {
      readCards();
      cards.innerHTML = "";
      var us = units();
      cals().forEach(function (eid, i) {
        var st = state[eid] || (state[eid] = { depts: {}, people: [], left: {} });
        var card = el("section", "bp-card");
        card.setAttribute("data-bp-card", eid);
        var head = el("div", "bp-card-head");
        head.appendChild(el("b", null, names[eid] || eid));
        head.appendChild(el("span", "bp-card-n"));
        card.appendChild(head);
        var grid = el("div", "bp-card-grid");
        us.forEach(function (u) {
          var ui = UNITS[u];
          if (!ui) return;
          var col = el("div", "bp-card-unit");
          col.setAttribute("data-bp-unit", u);
          col.appendChild(el("span", "bp-card-ulab", ui.label));
          // Everyone left in the unit (2026-10-27): a rule, not a list of names, so whoever joins later follows it
          var lw = el("label", "adm-ptick bp-left"), lcb = document.createElement("input");
          lcb.type = "checkbox"; lcb.name = "left_" + eid; lcb.value = u; lcb.className = "bp-left-cb";
          if (st.left && st.left[u]) lcb.checked = true;
          lw.appendChild(lcb);
          var lt = el("span", "bp-left-t");
          lt.appendChild(el("b", null, "Everyone left in " + ui.label));
          var ln = el("span", "muted small bp-left-n"); ln.setAttribute("data-bp-leftn", u);
          lt.appendChild(ln);
          lw.appendChild(lt);
          col.appendChild(lw);
          var dg = el("div", "bp-dept-grid");
          ui.depts.forEach(function (d) {
            var key = u + "||" + d[0], item = el("div", "bp-dept-item"), lab = el("label", "adm-ptick bp-tick"), cb = document.createElement("input");
            cb.type = "checkbox"; cb.name = "dept_" + eid; cb.value = key; cb.setAttribute("data-n", d[2]);
            if (st.depts[key]) cb.checked = true;
            if (taken[key]) cb.disabled = true;
            lab.appendChild(cb);
            var tx = el("span", null, " " + d[1]);
            if (taken[key]) tx.appendChild(el("span", "muted small", " · in " + taken[key]));
            lab.appendChild(tx);
            item.appendChild(lab);
            // the count is a button: it unfolds the department's people under the tick, view only (2026-10-27)
            var pb = el("button", "btn-link bp-dp-btn", d[2] + (String(d[2]) === "1" ? " person" : " people"));
            pb.type = "button"; pb.setAttribute("aria-expanded", "false");
            pb.setAttribute("data-bp-dp", key); pb.setAttribute("data-bp-dp-u", u); pb.setAttribute("data-bp-dp-d", d[0]);
            pb.title = "See the people of " + d[1];
            item.appendChild(pb);
            dg.appendChild(item);
          });
          col.appendChild(dg);
          // Not covered yet: who of the unit no calibrator of any panel holds; tick to give them to this calibrator by name
          var nb = el("div", "bp-nc");
          nb.setAttribute("data-bp-nc", u);
          var nh = el("div", "bp-nc-head");
          nh.appendChild(el("b", null, "Not covered yet"));
          nh.appendChild(el("span", "bp-nc-n", "…"));
          nb.appendChild(nh);
          nb.appendChild(el("p", "muted small bp-nc-hint"));
          var tools = el("div", "bp-nc-tools");
          var sl = el("label", "bp-nc-sl"); sl.appendChild(el("span", null, "Search in"));
          var qi = document.createElement("input");
          qi.type = "text"; qi.className = "bp-nc-q"; qi.placeholder = "Name, Employee ID or department"; qi.autocomplete = "off";
          qi.setAttribute("aria-label", "Search in the people not covered yet in " + ui.label);
          sl.appendChild(qi); tools.appendChild(sl);
          var ta = el("button", "btn-link bp-nc-all", "Tick all"); ta.type = "button"; ta.hidden = true;
          tools.appendChild(ta);
          nb.appendChild(tools);
          nb.appendChild(el("div", "bp-nc-body"));
          col.appendChild(nb);
          grid.appendChild(col);
        });
        card.appendChild(grid);
        var pw = el("div", "adm-pform bp-people"), lid = "bp-pl-" + (f.querySelector('[name="panel_id"]') || { value: "new" }).value + "-" + i;
        var plab = el("label", "bp-plab", "And people by name");
        plab.id = lid;
        pw.appendChild(plab);
        var box = el("span", "pick pick-multi");
        box.setAttribute("data-pick", ""); box.setAttribute("data-pick-multi", "");
        box.setAttribute("data-pick-bg", calBox.getAttribute("data-pick-bg") || "");
        box.setAttribute("data-pick-units", us.join("||"));
        box.setAttribute("data-pick-init", JSON.stringify(st.people || []));
        var q = document.createElement("input");
        q.type = "text"; q.className = "pick-q"; q.placeholder = "Search the people of the units ticked…";
        q.autocomplete = "off"; q.setAttribute("aria-labelledby", lid);
        var hv = document.createElement("input");
        hv.type = "hidden"; hv.className = "pick-val"; hv.name = "people_" + eid;
        box.appendChild(q); box.appendChild(hv);
        pw.appendChild(box);
        card.appendChild(pw);
        cards.appendChild(card);
      });
      if (window.onehrPick) window.onehrPick(cards);
      refresh();
      loadNc(us).then(function () { if (cards.isConnected) refresh(); });
    }
    cards.addEventListener("change", function (e) {
      var t = e.target;
      if (t.classList && t.classList.contains("bp-nc-cb")) {   // a person ticked in Not covered yet: by name, on this card
        var card = t.closest("[data-bp-card]"), api = (card.querySelector("[data-pick]") || {})._pickApi;
        if (api) { if (t.checked) api.add({ eid: t.getAttribute("data-eid"), name: t.getAttribute("data-name") }); else api.remove(t.getAttribute("data-eid")); }
      }
      refresh();
    });
    cards.addEventListener("keydown", function (e) {   // Enter in a list's search never saves the panel
      if (e.key === "Enter" && e.target.classList && e.target.classList.contains("bp-nc-q")) e.preventDefault();
    });
    cards.addEventListener("input", function (e) {
      if (e.target.classList && e.target.classList.contains("bp-nc-q")) {
        var blk = e.target.closest("[data-bp-unit]"), card = e.target.closest("[data-bp-card]");
        fillList(card, blk.getAttribute("data-bp-unit"));
      }
    });
    cards.addEventListener("click", function (e) {
      var dpb = e.target.closest(".bp-dp-btn");
      if (dpb) {   // a department's people: unfold or fold, view only
        e.preventDefault();
        var it = dpb.closest(".bp-dept-item"), bx = it.querySelector(".bp-dp-box"), open = dpb.getAttribute("aria-expanded") === "true";
        if (open) { dpb.setAttribute("aria-expanded", "false"); it.classList.remove("is-open"); if (bx) bx.hidden = true; return; }
        if (!bx) { bx = el("div", "bp-dp-box"); it.appendChild(bx); }
        bx.hidden = false; it.classList.add("is-open"); dpb.setAttribute("aria-expanded", "true");
        fillDeptPeople(bx, dpb.getAttribute("data-bp-dp-u"), dpb.getAttribute("data-bp-dp-d"));
        return;
      }
      var all = e.target.closest(".bp-nc-all");
      if (all) {   // every person showing, to this calibrator by name
        var card = all.closest("[data-bp-card]"), api = (card.querySelector("[data-pick]") || {})._pickApi;
        all.closest(".bp-nc").querySelectorAll(".bp-nc-cb:not(:checked):not(:disabled)").forEach(function (cb) {
          if (api) api.add({ eid: cb.getAttribute("data-eid"), name: cb.getAttribute("data-name") });
        });
        refresh();
        return;
      }
      if (e.target.closest(".pick-chip button")) setTimeout(refresh, 0);
    });
    cards.addEventListener("pick", function () { setTimeout(refresh, 0); });

    function show(n) {
      step = n;
      f.querySelectorAll("[data-bp-pane]").forEach(function (p) { p.hidden = p.getAttribute("data-bp-pane") !== String(n); });
      f.querySelectorAll("[data-bp-dot]").forEach(function (d) {
        var k = parseInt(d.getAttribute("data-bp-dot"), 10);
        d.classList.toggle("is-on", k === n); d.classList.toggle("is-done", k < n);
        if (k === n) d.setAttribute("aria-current", "step"); else d.removeAttribute("aria-current");
      });
      backB.hidden = n === 1; nextB.hidden = n === 3; saveB.hidden = n !== 3;
      nextB.textContent = n === 1 ? "Next: who each calibrates" : "Next: how the band is decided";
      say("");
      var body = f.querySelector(".adm-panel-body");
      if (body) body.scrollTop = 0;
    }
    function drawPlan(d) {
      planBox.innerHTML = "";
      if (d.single && d.single.length) {
        var t = el("table", "admin-table bp-plan-t"), th = el("thead"), hr = el("tr");
        ["Calibrated by", "Who", "People", "The band"].forEach(function (h, i) {
          var c = el("th", i >= 2 ? "bp-num" : null, h); hr.appendChild(c);
        });
        th.appendChild(hr); t.appendChild(th);
        var tb = el("tbody");
        d.single.forEach(function (s) {
          var tr = el("tr");
          var c1 = el("td"); c1.appendChild(el("b", null, s.name)); if (s.title) c1.appendChild(el("span", "bp-sub", s.title));
          tr.appendChild(c1);
          tr.appendChild(el("td", "bp-where", s.where));
          tr.appendChild(el("td", "bp-num", String(s.n)));
          tr.appendChild(el("td", "bp-num", "100%"));
          tb.appendChild(tr);
        });
        t.appendChild(tb);
        planBox.appendChild(t);
      }
      (d.combos || []).forEach(function (c) {
        var sec = el("section", "bp-share");
        var head = el("div", "bp-share-head");
        head.appendChild(el("b", null, "Shared by " + c.cals.map(function (x) { return x.name; }).join(" and ")));
        head.appendChild(el("span", "bp-card-n", c.n + (c.n === 1 ? " person" : " people")));
        sec.appendChild(head);
        sec.appendChild(el("p", "bp-where", c.where));
        var row = el("div", "bp-wrow");
        c.cals.forEach(function (x) {
          var lab = el("label", "bp-w");
          lab.appendChild(el("span", null, x.name));
          var inp = document.createElement("input");
          inp.type = "number"; inp.min = "1"; inp.max = "99"; inp.step = "1"; inp.className = "bp-wnum";
          inp.name = "w:" + c.key + ":" + x.eid; inp.value = c.weights[x.eid];
          inp.setAttribute("aria-label", x.name + "'s weight for these people");
          lab.appendChild(inp); lab.appendChild(el("span", null, "%"));
          row.appendChild(lab);
        });
        var sum = el("span", "bp-wsum");
        row.appendChild(sum);
        sec.appendChild(row);
        function tally() {
          var tot = 0;
          row.querySelectorAll("input").forEach(function (i) { tot += parseInt(i.value, 10) || 0; });
          sum.textContent = tot === 100 ? "100 ✓" : tot + " of 100";
          sum.classList.toggle("is-bad", tot !== 100);
        }
        row.addEventListener("input", tally);
        tally();
        planBox.appendChild(sec);
      });
      planBox.appendChild(el("p", "muted small bp-total", d.total + (d.total === 1 ? " person" : " people") +
        " leave their BU CEO's calibration" + (d.shared ? ", " + d.shared + " shared" : "") + ". Their BU CEOs see them read only."));
    }
    function preview() {
      readCards();
      var fd = new FormData(f);
      fd.set("action", "bu_panel_preview");
      nextB.disabled = true;
      fetch(location.pathname + location.search, { method: "POST", body: fd, credentials: "same-origin",
                                                   headers: { "X-Requested-With": "fetch" } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          nextB.disabled = false;
          if (!d.ok) { say(d.error || "That doesn't work yet."); return; }
          drawPlan(d); show(3);
        })
        .catch(function () { nextB.disabled = false; say("Couldn't check the panel just now. Try again."); });
    }
    nextB.addEventListener("click", function () {
      if (step === 1) {
        if (!units().length) { say("Tick at least one business unit."); return; }
        if (!cals().length) { say("Pick at least one calibrator."); return; }
        if (!curve.value) { say("Pick whose PAT curve they follow."); return; }
        if (!f.querySelector('input[name="name"]').value.trim()) { say("Name the panel."); return; }
        drawCards(); show(2);
        return;
      }
      if (step === 2) preview();
    });
    backB.addEventListener("click", function () {
      if (step === 3) show(2);
      else if (step === 2) { readCards(); show(1); }
    });
    syncUnits();
  });
})();
