// The KPI panels of the person page's Performance tab (2026-10-30, canvas [design canvas link removed];
// markup: templates/person/_kpi_panels.html). Per panel form (form.kpe): the live "On the table" summary, the weight total
// (a warning, never a block), the description box that grows with a "How staff will see it" preview and the staff pop-out,
// the strict library search (Add and "Pick another library KPI": only a listed KPI can be chosen, nothing typed is saved),
// the moderator cards, and the footer's "Changed: ..." with the same words in the Save confirm. Method and Unit are picked here
// (2026-11-04, canvas [design canvas link removed]): the line says when it differs from the KPI library
// (compared with the library's method and unit the form carries), warns when the rates run the wrong way for the method (and
// offers to reverse them), and a method or unit change on a line the person has entered something on asks for a reason in the confirm.
// A weight-only form (data-kpe="bu": a BU KPI line, or a line filled for the unit) asks for a reason in the confirm when the weight moves
// on a line with a result or check-in (2026-11-05). The super admin, outside an Early Year, also finds the unit's saved BU KPIs in the Add
// search (2026-11-07, canvas "BU KPI from person page"): a pick swaps the form below the search for the unit's read-only facts and one
// Weight box, and the same form posts action=add_bu (bu_setup, weight). The server decides everything; this only shows it as you type.
(function () {
  if (window.__kpeLoaded) return;
  window.__kpeLoaded = true;
  var K = function () { return window.onehrKpiLine; };
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function num(v) {
    v = String(v == null ? "" : v).replace(/,/g, "").trim().replace(/%$/, "");
    if (v === "") return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  function fmt(n) { return n.toLocaleString("en-US", { maximumFractionDigits: 10 }); }
  function pct(n) { return fmt(Math.round(n * 100) / 100); }

  var LIB = null;
  function lib() {
    if (LIB) return LIB;
    var s = document.getElementById("kpe-lib");
    try { LIB = JSON.parse(s.textContent); } catch (e) { LIB = { items: [], dept: "", n: 0 }; }
    LIB.byId = {};
    LIB.items.forEach(function (x) { LIB.byId[x.id] = x; });
    return LIB;
  }

  // ---- the staff preview: intro, "How it's rated" and the rating list, as the pop-out draws them ----
  function renderPreview(box, text) {
    box.textContent = "";
    text = String(text || "");
    if (!text.trim()) { box.appendChild(el("p", "kpe-pv-empty", "Nothing written yet: staff see no description.")); return; }
    var pr = K() ? K().parseRatings(text) : { intro: text.trim(), ratings: null };
    if (pr.ratings) {
      if (pr.intro) box.appendChild(el("p", "kpe-pv-intro", pr.intro));
      box.appendChild(el("p", "kpe-pv-lab", "How it's rated"));
      var ol = el("ol", "kpi-dlg-rates");
      pr.ratings.forEach(function (r) {
        var li = el("li");
        li.appendChild(el("span", "kpi-dlg-chip", "Rating " + r.n));
        var tx = el("span", "kpi-dlg-text", r.text);
        if (r.target) tx.appendChild(el("span", "kpi-dlg-target", "Target"));
        li.appendChild(tx); ol.appendChild(li);
      });
      box.appendChild(ol);
    } else {
      text.split(/\n\s*\n/).forEach(function (para) { if (para.trim()) box.appendChild(el("p", "kpe-pv-intro", para.trim())); });
    }
  }

  function grow(ta) {
    ta.style.height = "auto";
    var max = Math.round(window.innerHeight * 0.7);
    ta.style.height = Math.min(ta.scrollHeight + 2, max) + "px";
    ta.style.overflowY = ta.scrollHeight + 2 > max ? "auto" : "hidden";
  }

  function init(f) {
    if (f._kpe) return;
    f._kpe = true;
    var kind = f.getAttribute("data-kpe"), who = f.getAttribute("data-kpe-who") || "They";
    var mech = f.getAttribute("data-kpe-mech") || "", variant = f.getAttribute("data-kpe-variant") || "";
    var total = num(f.getAttribute("data-kpe-total")) || 0, was = num(f.getAttribute("data-kpe-was")) || 0;
    var state = { unit: f.getAttribute("data-kpe-unit") || "", picked: null };
    var q = function (s) { return f.querySelector(s); };
    var qa = function (s) { return [].slice.call(f.querySelectorAll(s)); };
    var panel = f.closest(".adm-panel") || f;
    var desc = q("[data-kpe-desc]"), prev = panel.querySelector("[data-kpe-prev]"), wline = qa("[data-kpe-wline]");
    var fig = {};
    qa("[data-kpe-fig]").forEach(function (i) { fig[i.getAttribute("data-kpe-fig")] = i; });
    var weight = q("[data-kpe-weight]");
    // Method and Unit (this line only) and the library's own, which the line is compared with; a re-point swaps the library's
    var selM = q('[data-kpe-sel="method"]'), selU = q('[data-kpe-sel="unit"]');
    var muWhy = q("[data-kpe-muwhy]"), dirLine = q("[data-kpe-dirline]"), restrip = q("[data-kpe-restrip]");
    var hasInput = f.getAttribute("data-kpe-input") === "1", selfFig = f.getAttribute("data-kpe-self") || "";
    var libMU = { has: f.getAttribute("data-kpe-haslib") === "1", m: f.getAttribute("data-kpe-libm") || "more",
                  u: f.getAttribute("data-kpe-libu") || "" };
    var MWORD = { more: "More is better", less: "Less is better" };
    var revUndo = null, libMU0 = { has: libMU.has, m: libMU.m, u: libMU.u };
    if (selM) selM.addEventListener("change", function () { revUndo = null; });

    // what a field held when the panel opened
    qa("[data-kpe-track]").forEach(function (i) {
      i._was = (i.type === "radio" || i.type === "checkbox") ? i.checked : i.value;
    });

    function tableText() {
      var t;
      if (mech === "A") {
        var rs = ["r1", "r2", "r3", "r4", "r5"].map(function (k) { return fig[k] ? num(fig[k].value) : null; });
        if (rs.every(function (v) { return v === null; })) return "—";
        t = rs.map(function (v) { return v === null ? "—" : fmt(v); }).join(" · ");
      } else if (mech === "B") {
        var th = fig.th ? num(fig.th.value) : null, tg = fig.tg ? num(fig.tg.value) : null;
        if (th === null && tg === null) return "—";
        t = (th === null ? "—" : fmt(th)) + " → " + (tg === null ? "—" : fmt(tg));
        if (variant === "excellence") { var ex = fig.ex ? num(fig.ex.value) : null; if (ex !== null) t += " · excellence " + fmt(ex); }
        else { var mu = fig.mu ? num(fig.mu.value) : null; if (mu) t += " · ×" + fmt(Math.trunc(mu)); }
      } else return "—";
      return t + (state.unit ? " " + state.unit : "");
    }

    function weightLine() {
      if (!wline.length) return;
      var w = weight ? num(weight.value) : null, bad;
      var html;
      if (w === null) {
        html = kind === "add" ? "Their weights add up to <b>" + pct(total) + "%</b> now. Other lines are not re-balanced for you."
                              : "Their weights add up to <b>" + pct(total) + "%</b>. Other lines are not re-balanced for you.";
        bad = false;
      } else {
        var nt = total - was + w; bad = Math.abs(nt - 100) >= 0.01;
        if (!bad) html = "Their weights add up to <span class=\"kpe-ok\">100% ✓</span>. Other lines are not re-balanced for you.";
        else if (kind === "add" || Math.abs(nt - total) >= 0.01)
          html = "With " + pct(w) + "% here their weights add up to <span class=\"kpe-bad\">" + pct(nt) + "%</span> (" + (kind === "add" ? "now " : "was ") + pct(total) + "%). Other lines are not re-balanced for you.";
        else html = "Their weights add up to <span class=\"kpe-bad\">" + pct(nt) + "%</span>, not 100%. Other lines are not re-balanced for you.";
      }
      wline.forEach(function (e) { e.innerHTML = html; });
    }

    function charCount() {
      var c = q("[data-kpe-count]");
      if (!c || !desc) return;
      var pr = K() ? K().parseRatings(desc.value) : { ratings: null };
      var n = desc.value.length;
      c.textContent = fmt(n) + " character" + (n === 1 ? "" : "s") + (pr.ratings ? " · " + pr.ratings.length + " rating lines" : "");
    }

    function basics() { return { base: nameNow(), focus: (q('[name="focus"]') || {}).value || "", weight: weight ? num(weight.value) : null, detail: desc ? desc.value : "" }; }
    function nameNow() { var o = q('[data-kpe-o="name"]'); return o ? o.textContent : ""; }

    // ---- Method and Unit: the library's, this line's, the scale direction ----
    function optHas(sel, v) { return [].some.call(sel.options, function (o) { return o.value === v; }); }
    function setUnit(v) {   // a unit off the list is added "as entered"; a held (disabled) step is never chosen from here
      if (!selU) return false;
      if (v && !optHas(selU, v)) { var o = document.createElement("option"); o.value = v; o.textContent = v + " (as entered)"; selU.insertBefore(o, selU.options[1] || null); }
      var op = [].filter.call(selU.options, function (x) { return x.value === v; })[0];
      if (!op || op.disabled) return false;
      selU.value = v; return true;
    }
    function methodNow() { return selM ? selM.value : "more"; }
    function unitNow() { return selU ? selU.value : ""; }
    function differs() { return libMU.has && (methodNow() !== libMU.m || unitNow() !== libMU.u); }
    function libSay() { return (MWORD[libMU.m] || MWORD.more) + " \u00b7 " + (libMU.u || "No unit"); }
    function muLine() {
      if (!muWhy) return;
      muWhy.textContent = "";
      if (!libMU.has && kind === "edit") { muWhy.appendChild(document.createTextNode("This KPI isn't in the library, so there is nothing to compare it with. A change here is for this line only.")); return; }
      if (differs()) {
        muWhy.appendChild(el("span", "kpe-chip is-warn", "Differs from the library"));
        muWhy.appendChild(document.createTextNode(" The library's: " + libSay() + ". This line only; the library stays as it is. "));
        var a = el("a", "kpe-lk", "Put back the library's"); a.href = "#"; a.setAttribute("data-kpe-putback", ""); muWhy.appendChild(a);
      } else muWhy.appendChild(document.createTextNode("Method and unit start as the KPI library's. A change here is for this line only: the library, and everyone else on this KPI, stay as they are."));
    }
    // the rates (or threshold and target) against the method: the same direction rule as the server's pm_scale_error, shown as
    // a line with the way out. Never a block: the server refuses a wrong scale whatever the page shows.
    function dirProblem() {
      var more = methodNow() !== "less";
      if (mech === "A") {
        var rs = ["r1", "r2", "r3", "r4", "r5"].map(function (k) { return fig[k] ? num(fig[k].value) : null; });
        if (rs.some(function (v) { return v === null; })) return null;
        var rise = rs.every(function (v, i) { return i === 0 || v >= rs[i - 1]; }) && rs[4] > rs[0];
        var fall = rs.every(function (v, i) { return i === 0 || v <= rs[i - 1]; }) && rs[4] < rs[0];
        if (more && fall) return { head: "The rates fall, but more is better now:", rest: " the figures must rise from Rate 1 to Rate 5.", rev: "Reverse the rates", to: rs[4] + " \u2192 " + rs[0] };
        if (!more && rise) return { head: "The rates rise, but less is better now:", rest: " the figures must fall from Rate 1 to Rate 5.", rev: "Reverse the rates", to: rs[4] + " \u2192 " + rs[0] };
      } else if (mech === "B") {
        var th = fig.th ? num(fig.th.value) : null, tg = fig.tg ? num(fig.tg.value) : null;
        if (th === null || tg === null) return null;
        var swap = variant === "excellence" ? null : "Swap threshold and target";
        if (more && th > tg) return { head: "The threshold is above the target, but more is better now:", rest: " the threshold must sit below the target.", rev: swap };
        if (!more && th < tg) return { head: "The threshold is below the target, but less is better now:", rest: " the threshold must sit above the target.", rev: swap };
      }
      return null;
    }
    function dirText() {
      if (!dirLine) return;
      var p = dirProblem();
      dirLine.textContent = "";
      if (!p && !revUndo) { dirLine.hidden = true; return; }
      dirLine.hidden = false;
      if (p) {
        dirLine.appendChild(el("span", "kpe-bad", p.head)); dirLine.appendChild(document.createTextNode(p.rest + " "));
        if (p.rev) {
          var a = el("a", "kpe-lk", p.rev); a.href = "#"; a.setAttribute("data-kpe-rev", ""); dirLine.appendChild(a);
          if (p.to) dirLine.appendChild(document.createTextNode(" (" + p.to + "), or type new ones."));
        } else dirLine.appendChild(document.createTextNode("Type new ones."));
      } else {
        dirLine.appendChild(document.createTextNode(mech === "A" ? "Rates reversed for " + (MWORD[methodNow()] || "").toLowerCase() + ". " : "Threshold and target swapped. "));
        var u = el("a", "kpe-lk", "Undo"); u.href = "#"; u.setAttribute("data-kpe-revundo", ""); dirLine.appendChild(u);
      }
    }
    f._kpeReverse = function () {
      var keys = mech === "A" ? ["r1", "r2", "r3", "r4", "r5"] : ["th", "tg"];
      var els = keys.map(function (k) { return fig[k]; });
      if (els.some(function (e) { return !e; })) return;
      revUndo = els.map(function (e) { return e.value; });
      var vals = revUndo.slice().reverse();
      els.forEach(function (e, i) { e.value = vals[i]; });
      f.dispatchEvent(new Event("input", { bubbles: true }));
    };
    f._kpeReverseUndo = function () {
      var keys = mech === "A" ? ["r1", "r2", "r3", "r4", "r5"] : ["th", "tg"];
      if (!revUndo) return;
      keys.forEach(function (k, i) { if (fig[k]) fig[k].value = revUndo[i]; });
      revUndo = null;
      f.dispatchEvent(new Event("input", { bubbles: true }));
    };
    f._kpePutBack = function () {
      if (selM) selM.value = libMU.m;
      setUnit(libMU.u);
      f.dispatchEvent(new Event("change", { bubbles: true }));
    };
    f._kpeLibRestore = function () { libMU = { has: libMU0.has, m: libMU0.m, u: libMU0.u }; };
    f._kpeLibMU = function (it) {   // a re-point or a pick: the library's own method and unit, and the selects start as them
      libMU = { has: true, m: it.method || "more", u: it.unit || "" };
      if (selM) selM.value = libMU.m;
      if (selU) {
        if (!libMU.u) { if (!optHas(selU, "")) { var o = document.createElement("option"); o.value = ""; o.textContent = "No unit"; selU.insertBefore(o, selU.firstChild); } selU.value = ""; }
        else setUnit(libMU.u);
        if (libMU.u) [].slice.call(selU.options).forEach(function (o) { if (o.value === "" && !o.selected) o.remove(); });
      }
    };

    // ---- the footer's "Changed: ..." and the same words in the confirm box ----
    function changes() {
      var out = [], seen = {};
      qa("[data-kpe-track]").forEach(function (i) {
        var lab = i.getAttribute("data-kpe-track"), now = (i.type === "radio" || i.type === "checkbox") ? i.checked : i.value;
        if (now !== i._was && !seen[lab]) { seen[lab] = true; out.push(lab); }
      });
      if (state.picked && kind === "edit") out.unshift("Library KPI");
      return out;
    }
    function listLines(ch) {
      var lines = [];
      var movedMU = ch.indexOf("Method") >= 0 || ch.indexOf("Unit") >= 0;
      ch.forEach(function (lab) {
        if (lab === "Weight" && weight) {
          var w = num(weight.value), nt = total - was + (w || 0);
          lines.push("Weight " + pct(was) + "% → " + (w === null ? "none" : pct(w) + "%") + ": their weights add up to " + pct(nt) + "%" + (Math.abs(nt - 100) >= 0.01 ? ", not 100%" : ""));
        } else if (lab === "Description" && desc) {
          var pr = K() ? K().parseRatings(desc.value) : { ratings: null };
          lines.push("Description rewritten (" + fmt(desc.value.length) + " characters" + (pr.ratings ? ", " + pr.ratings.length + " rating lines" : "") + ")");
        } else if (lab === "Method" && selM) {
          lines.push("Method " + MWORD[selM._was] + " \u2192 " + MWORD[selM.value] + (hasInput ? ": " + who + "'s result is scored again by the new method" : ""));
        } else if (lab === "Unit" && selU) {
          var uw = selU._was || "No unit", un = selU.value || "No unit";
          lines.push("Unit " + uw + " \u2192 " + un + (hasInput ? (selfFig ? ": their result, " + selfFig + ", now reads " + selfFig + (selU.value ? " " + selU.value : "")
            : ": their check-in stays as they entered it") : ""));
        } else if (lab === "Targets") lines.push("Targets now " + tableText());
        else if (lab === "Focus") lines.push("Focus: " + ((q('[name="focus"]') || {}).value || "none"));
        else if (lab === "Moderated by") {
          var m = q('input[name="moderator"]:checked');
          lines.push("Moderated by the " + (m && m.value === "matrix" ? "matrix manager" : "line manager") + "; any draft the old moderator wrote is discarded");
        } else if (lab === "Library KPI" && state.picked)
          lines.push("Re-pointed to the library KPI '" + state.picked.name + "' (targets, description, weight, Focus and moderator stay)");
      });
      if (movedMU && differs()) lines.push("This line now differs from the KPI library, which stays " + libSay());
      if ((ch.indexOf("Method") >= 0 || ch.indexOf("Unit") >= 0) && hasInput) lines.push(who + " gets a note in OneHR that this line is now " + (ch.indexOf("Method") >= 0 && ch.indexOf("Unit") >= 0 ? "scored the other way and measured in " + (selU.value || "no unit") : (ch.indexOf("Method") >= 0 ? "scored the other way" : "measured in " + (selU.value || "no unit"))) + ". No email.");
      return lines;
    }
    function refresh() {
      var s = q("[data-kpe-sum]"); if (s) s.textContent = tableText();
      weightLine();
      if (desc) { grow(desc); charCount(); if (prev) renderPreview(prev, desc.value); }
      muLine(); dirText();
      var methodMoved = !!(selM && selM.value !== selM._was), unitMoved = !!(selU && selU.value !== selU._was);
      if (restrip) restrip.hidden = !(hasInput && (methodMoved || unitMoved));
      if (kind === "edit" && hasInput) {   // a method or unit change on a line they have entered something on asks why, in the confirm
        if (methodMoved || unitMoved) {
          f.setAttribute("data-confirm-reason", "Why it changes");
          f.setAttribute("data-confirm-reason-placeholder", "Required, because " + who + " has entered something on this KPI. Kept in the trail.");
        } else { f.removeAttribute("data-confirm-reason"); f.removeAttribute("data-confirm-reason-placeholder"); }
      }
      var weightMoved = !!(kind === "bu" && weight && weight.value !== weight._was);
      if (kind === "bu" && hasInput) {   // a weight change on a unit's line (BU KPI or filled for the unit) with a result or check-in asks why too
        if (weightMoved) {
          f.setAttribute("data-confirm-reason", "Why the weight changes");
          f.setAttribute("data-confirm-reason-placeholder", "Required, because this KPI already has a result or a check-in. Kept in the trail.");
        } else { f.removeAttribute("data-confirm-reason"); f.removeAttribute("data-confirm-reason-placeholder"); }
      }
      if (kind === "edit" || kind === "bu") {
        var ch = changes(), c = q("[data-kpe-changed]");
        if (c) c.textContent = ch.length ? "Changed: " + ch.join(", ") : "No changes yet";
        f.setAttribute("data-confirm-list", JSON.stringify(listLines(ch)));
        f.setAttribute("data-confirm-list-label", ch.length ? "What changes" : "");
      }
    }
    f._kpeRefresh = refresh;
    // Add: nothing to add until a library KPI is picked (kpi_scale.js re-enables submit buttons, so this runs after it)
    if (kind === "add") {
      var buBox = q("[data-kpe-bu]"), buW = q("[data-kpe-buw]"), buSetup = q("[data-kpe-busetup]"), actIn = q("[data-kpe-action]"), after = q("[data-kpe-after]");
      var confirmKeep = {};   // the form's own confirm words (and the Email them tick), put back when a library KPI is picked again
      ["data-confirm", "data-confirm-notify", "data-confirm-notify-sub", "data-confirm-notify-off"].forEach(function (a) { if (f.hasAttribute(a)) confirmKeep[a] = f.getAttribute(a); });
      var poss = function (n) { return n + (/s$/i.test(n) ? "'" : "'s"); };
      var buWeight = function () { return buW ? num(buW.value) : null; };
      var buOk = function () { var w = buWeight(), x = state.bu; return !!(x && w !== null && w > 0 && total + w <= 100.001); };
      var buLive = function () {
        var live = q("[data-kpe-bulive]"), x = state.bu, w = buWeight();
        if (!live || !x) return;
        var room = Math.max(0, 100 - total);
        if (w === null || w <= 0) live.innerHTML = "Their KPIs add up to <b>" + pct(total) + "%</b> now. At most " + pct(room) + "%.";
        else if (total + w > 100.001) live.innerHTML = "<span class=\"kpe-bad\">At most " + pct(room) + "%: their KPIs hold " + pct(total) + "%.</span>";
        else live.innerHTML = "Their KPIs add up to <b>" + (Math.abs(total + w - 100) < 0.01 ? "<span class=\"kpe-ok\">100% \u2713</span>" : pct(total + w) + "%") + "</b> with this. At most " + pct(room) + "%.";
        var w2 = w === null ? "" : pct(w);
        if (x.other_unit) f.setAttribute("data-confirm", "Add " + x.name + " to " + who + " (" + (lib().bu_unit || "their unit") + ")'s " + (f.getAttribute("data-kpe-cyc") || "this cycle") + " KPIs at " + w2 + "%? It's " +
          poss(x.unit_name) + " BU KPI: it goes on at their target (" + x.target + ") and Group People fills its result. Their other weights are not re-balanced for you.");
        else f.setAttribute("data-confirm", "Add " + x.name + " to " + who + "'s " + (f.getAttribute("data-kpe-cyc") || "this cycle") + " KPIs at " + w2 + "%? It goes on at " + poss(x.unit_name) +
          " target (" + x.target + ") and Group People fills its result. They see it at once; their other weights are not re-balanced for you.");
      };
      var afterDisable = function (dis) {   // the library form's boxes stay out of the post (and out of native validation) while a BU KPI is picked
        if (!after) return;
        [].forEach.call(after.querySelectorAll("input, select, textarea"), function (e) {
          if (dis) { if (e._buWas === undefined) e._buWas = e.disabled; e.disabled = true; }
          else if (e._buWas !== undefined) { e.disabled = e._buWas; delete e._buWas; }
        });
      };
      f._kpeBuOn = function (x) {
        if (!buBox) return;
        state.bu = x; state.picked = null; state.unit = "";
        if (after) after.hidden = true;
        afterDisable(true);
        var strip = q("[data-kpe-bu-strip]");
        strip.textContent = "";
        if (x.other_unit) {   // another unit of their group (2026-11-07, canvas A2): a guest carrier, at their own weight
          strip.appendChild(el("b", null, "A BU KPI of " + x.unit_name + ", another unit in " + (lib().bu_group || "their group") + "."));
          strip.appendChild(document.createTextNode(" They join the " + x.n + " who carry it, at " + poss(x.unit_name) + " target. Group People fills its result, so they enter no figure. Their weight is their own. " +
            "Their line manager and BU CEO stay as they are. Its target changes only on "));
        } else {
          strip.appendChild(el("b", null, "A BU KPI of " + x.unit_name + "."));
          strip.appendChild(document.createTextNode(" They get a new line at the unit's target" + (x.n ? ", like the " + x.n + (x.n === 1 ? " who carries it" : " who carry it") : "") +
            ". Group People fills its result, so they enter no figure and attach no file. Its target, method and unit change only on "));
        }
        buBox.querySelectorAll("[data-kpe-bu-badge]").forEach(function (e) { e.textContent = (x.other_unit ? poss(x.unit_name) : "The unit's") + " \u00b7 read only"; });
        var a = el("a", "kpe-lk", "BU KPI setup \u203a"); a.href = x.url; a.target = "_blank"; a.rel = "noopener"; strip.appendChild(a);
        var o = function (k, v) { buBox.querySelectorAll('[data-kpe-bu-o="' + k + '"]').forEach(function (e) { e.textContent = v; }); };
        o("name", x.name); o("family", x.family || "Not set"); o("method", x.method === "less" ? "Less is better" : "More is better");
        o("unit", x.unit || "No unit"); o("target", x.target && x.unit && x.target !== "\u2014" && x.target.indexOf(x.unit) < 0 ? x.target + " " + x.unit : (x.target || "\u2014"));
        buBox.hidden = false;
        buW.disabled = false; buW.value = ""; buW.placeholder = "\u2264 " + pct(x.room);
        buSetup.disabled = false; buSetup.value = String(x.sid);
        if (actIn) actIn.value = "add_bu";
        ["data-confirm-notify", "data-confirm-notify-sub", "data-confirm-notify-off"].forEach(function (a_) { f.removeAttribute(a_); });
        buLive();
        setTimeout(gate, 0);
      };
      f._kpeBuOff = function () {
        if (!state.bu) return;
        state.bu = null;
        if (buBox) buBox.hidden = true;
        if (buW) { buW.disabled = true; buW.value = ""; }
        if (buSetup) { buSetup.disabled = true; buSetup.value = ""; }
        if (actIn) actIn.value = "add";
        Object.keys(confirmKeep).forEach(function (a_) { f.setAttribute(a_, confirmKeep[a_]); });
        afterDisable(false);
        setTimeout(gate, 0);
      };
      if (buW) buW.addEventListener("input", function () { buLive(); setTimeout(gate, 0); });
      var gate = function () {
        var ab = q("[data-kpe-addbtn]"), l = q("[data-kpe-lid]");
        if (state.bu) { if (ab) ab.disabled = !buOk(); return; }
        if (ab && l) ab.disabled = !l.value || !!q("[data-kpi-scale-bad]");
      };
      f.addEventListener("input", function () { setTimeout(gate, 0); });
      f.addEventListener("change", function () { setTimeout(gate, 0); });
      f.addEventListener("submit", function (e) { var l = q("[data-kpe-lid]"); if (state.bu ? !buOk() : (l && !l.value)) { e.preventDefault(); e.stopPropagation(); } }, true);
      setTimeout(gate, 0);
    }
    // a panel that was hidden has no width yet: the box grows to its text when it shows
    if (desc && typeof ResizeObserver === "function") {
      var lastW = 0;
      new ResizeObserver(function () { var w = desc.clientWidth; if (w && w !== lastW) { lastW = w; grow(desc); } }).observe(desc);
    }
    f.addEventListener("input", refresh);
    f.addEventListener("change", refresh);

    // ---- the pop-out ----
    var pop = q("[data-kpe-pop]");
    if (pop) pop.addEventListener("click", function (e) {
      e.preventDefault();
      var b = basics();
      if (!K()) return;
      if (!String(b.detail).trim()) { return; }
      K().open({ base: b.base, focus: b.focus, detail: b.detail, weight: b.weight === null ? undefined : b.weight,
                 direction: (q('[name="method"]') || {}).value === "less" ? "lower is better" : "higher is better" }, pop);
    });

    // ---- moderator cards ----
    qa(".kpe-mod input[type=radio]").forEach(function (r) {
      r.addEventListener("change", function () {
        qa(".kpe-mod").forEach(function (c) { c.classList.toggle("on", !!c.querySelector("input:checked")); });
        if (r.value === "matrix" && r.checked) { var pq = q(".pick-q"); if (pq) pq.focus(); }
      });
    });
    var pq = q(".kpe-mod .pick-q");
    if (pq) pq.addEventListener("focus", function () {
      var m = q('input[name="moderator"][value="matrix"]');
      if (m && !m.checked) { m.checked = true; m.dispatchEvent(new Event("change", { bubbles: true })); }
    });

    // ---- the strict library search ----
    var pick = q("[data-kpe-pick]");
    if (pick) initPick(f, pick, state, refresh, kind);
    refresh();
  }

  function initPick(f, box, state, refresh, kind) {
    var input = box.querySelector("[data-kpe-q]"), list = box.querySelector("[data-kpe-list]"), lid = box.querySelector("[data-kpe-lid]");
    var who = f.getAttribute("data-kpe-who") || "they";
    var items = [], active = -1;
    function toks() { return input.value.toLowerCase().split(/\s+/).filter(Boolean); }
    function hit(it, t) { var hay = (it.name + " " + it.family + (it.other_unit ? " " + it.unit_name : "")).toLowerCase(); return t.every(function (w) { return hay.indexOf(w) >= 0; }); }
    function mark(parent, text, t) {
      if (!t.length) { parent.appendChild(document.createTextNode(text)); return; }
      var low = text.toLowerCase(), i = 0;
      while (i < text.length) {
        var best = -1, bl = 0;
        t.forEach(function (w) { var p = low.indexOf(w, i); if (p >= 0 && (best < 0 || p < best || (p === best && w.length > bl))) { best = p; bl = w.length; } });
        if (best < 0) { parent.appendChild(document.createTextNode(text.slice(i))); break; }
        if (best > i) parent.appendChild(document.createTextNode(text.slice(i, best)));
        parent.appendChild(el("mark", null, text.slice(best, best + bl)));
        i = best + bl;
      }
    }
    function row(it, t) {
      var r = el("div", "kpe-li"); r.setAttribute("role", "option"); r._it = it;
      var n = el("span", "kpe-li-n"); mark(n, it.name, t); r.appendChild(n);
      var meta = [it.family, it.scope].filter(Boolean);
      if (it.n && lib().dept) meta.push(it.n + " in " + lib().dept + " hold it");
      r.appendChild(el("span", "kpe-li-m", meta.join(" · ")));
      r.addEventListener("mousedown", function (e) { e.preventDefault(); choose(it); });
      return r;
    }
    function buRow(x, t) {   // a BU KPI of the unit: pickable, or greyed with the refusal's own words
      var r = el("div", "kpe-li" + (x.why ? " is-off" : "")); r.setAttribute("role", "option"); r._it = x;
      var n = el("span", "kpe-li-n has-chip"), nm = el("span"); mark(nm, x.name, t); n.appendChild(nm); n.appendChild(el("span", "kpe-badge", "BU KPI"));
      if (x.other_unit) n.appendChild(el("span", "kpe-badge is-unit", x.unit_name));   // the unit's outlined chip, 8px after the grey one
      r.appendChild(n);
      if (x.why) {
        r.setAttribute("aria-disabled", "true");
        var w = el("span", "kpe-li-why"); w.appendChild(document.createTextNode(x.why + " "));
        if (x.sid === null && x.url) { var u = el("a", "kpe-lk", "Open it on BU KPI setup \u203a"); u.href = x.url; u.target = "_blank"; u.rel = "noopener"; w.appendChild(u); }
        r.appendChild(w);
        r.addEventListener("mousedown", function (e) { e.preventDefault(); });
      } else {
        r.appendChild(el("span", "kpe-li-m", [x.short, x.n + (x.n === 1 ? " carries it" : " carry it") + (x.guests ? ", " + (x.guests === 1 ? "1 from another unit" : x.guests + " from other units") : ""), "Group People fills its result"].filter(Boolean).join(" \u00b7 ")));
        r.addEventListener("mousedown", function (e) { e.preventDefault(); chooseBu(x); });
      }
      return r;
    }
    function chooseBu(x) {
      lid.value = ""; input.value = x.name; hide();
      if (f._kpeBuOn) f._kpeBuOn(x);
    }
    function build() {
      var t = toks(), L = lib(); list.textContent = ""; items = [];
      var sugg = L.items.filter(function (x) { return x.n > 0 && hit(x, t); }).sort(function (a, b) { return b.n - a.n || a.name.localeCompare(b.name); });
      var rest = L.items.filter(function (x) { return !(x.n > 0) && hit(x, t); });
      if (sugg.length) {
        list.appendChild(el("div", "kpe-li-h", "Suggested · held by others in their department"));
        sugg.forEach(function (x) { var r = row(x, t); list.appendChild(r); items.push(r); });
      }
      if (rest.length) {
        list.appendChild(el("div", "kpe-li-h", "All " + L.n + " library KPIs " + who + " may take"));
        rest.forEach(function (x) { var r = row(x, t); list.appendChild(r); items.push(r); });
      }
      if (!items.length) list.appendChild(el("div", "kpe-li-none", "No library KPI matches “" + input.value.trim() + "”."));
      // the super admin, outside an Early Year (2026-11-07): the unit's saved BU KPIs are rows to pick, greyed with why when they cannot go on
      if (kind === "add" && L.bu_items) {
        var bm = L.bu_items.filter(function (x) { return !x.other_unit && hit(x, t); });
        if (bm.length) {
          list.appendChild(el("div", "kpe-li-h", "BU KPIs of " + L.bu_unit + " \u00b7 the unit's target"));
          bm.forEach(function (x) { var r = buRow(x, t); list.appendChild(r); if (!x.why) items.push(r); });
        }
        var bo = L.bu_items.filter(function (x) { return x.other_unit && hit(x, t); });   // the other units of their group (2026-11-07, canvas A1)
        if (bo.length) {
          list.appendChild(el("div", "kpe-li-h", "Other units in " + (L.bu_group || "their group") + " \u00b7 their unit's target"));
          bo.forEach(function (x) { var r = buRow(x, t); list.appendChild(r); if (!x.why) items.push(r); });
        }
      } else
      // a BU KPI is not picked here: its target is the unit's, so it is put on from BU KPI setup (2026-11-06)
      if (t.length) (L.bu || []).filter(function (n) { var low = n.toLowerCase(); return t.every(function (w) { return low.indexOf(w) >= 0; }); }).slice(0, 3).forEach(function (n) {
        var b = el("div", "kpe-li-bu");
        b.appendChild(el("b", null, n));
        b.appendChild(document.createTextNode(L.bu_url
          ? " is a BU KPI: its target is the unit's, so it's put on from BU KPI setup. "
          : " is a BU KPI: its target is the unit's, so it's put on by the super admin from BU KPI setup."));
        if (L.bu_url) { var u = el("a", "kpe-lk", "Open BU KPI setup ›"); u.href = L.bu_url; u.target = "_blank"; u.rel = "noopener"; b.appendChild(u); }
        list.appendChild(b);
      });
      var foot = el("div", "kpe-li-f");
      var l1 = el("span"); l1.appendChild(document.createTextNode("Not in the library? "));
      var a = el("a", "kpe-lk", "Add it to the KPI library ›"); a.target = "_blank"; a.rel = "noopener";
      a.href = box.getAttribute("data-kpe-libhref"); l1.appendChild(a);
      foot.appendChild(l1);
      foot.appendChild(el("span", "kpe-li-fs", "Opens Performance › KPI library in a new tab. The super admin adds it there; a BG or unit admin proposes it, and the super admin approves it on Requests. Once it's in, search again here and pick it."));
      list.appendChild(foot);
      active = -1;
    }
    function show() { build(); list.hidden = false; input.setAttribute("aria-expanded", "true"); }
    function hide() { list.hidden = true; input.setAttribute("aria-expanded", "false"); }
    function setActive(i) {
      items.forEach(function (r, j) { r.classList.toggle("on", j === i); });
      active = i; if (items[i]) items[i].scrollIntoView({ block: "nearest" });
    }
    function set(name, v) { f.querySelectorAll('[data-kpe-o="' + name + '"]').forEach(function (e) { e.textContent = v; e.title = v; }); }
    function choose(it) {
      if (state.bu && f._kpeBuOff) f._kpeBuOff();
      lid.value = String(it.id); state.picked = it; state.unit = it.unit || "";
      input.value = it.name; hide();
      set("name", it.name); set("family", it.family || "Not set");
      if (f._kpeLibMU) f._kpeLibMU(it);   // the Method and Unit selects start as the picked KPI's
      var k = f.querySelector('input[type=hidden][name="kpi"]'); if (k) k.value = it.name;
      var c = f.querySelector('input[type=hidden][name="category"]'); if (c) c.value = it.family || "";
      if (kind === "add") {
        var after = f.querySelector("[data-kpe-after]"); if (after) after.hidden = false;
        var d = f.querySelector("[data-kpe-desc]");
        if (d && (!d.value.trim() || d._fromLib)) { d.value = it.description || ""; d._fromLib = true; }
        var b = f.querySelector("[data-kpe-libdesc]"); if (b) b.hidden = !it.description;
        var ab = f.querySelector("[data-kpe-addbtn]"); if (ab) ab.disabled = false;
      } else {
        var rp = f.querySelector("[data-kpe-repicked]"); if (rp) rp.hidden = false;
        var nl = f.querySelector("[data-kpe-notlib]"); if (nl) { nl.hidden = true; }
      }
      refresh();
      f.dispatchEvent(new Event("input", { bubbles: true }));
    }
    box._undo = function () {
      var o = f._orig || {};
      lid.value = ""; state.picked = null; input.value = "";
      Object.keys(o).forEach(function (n) { f.querySelectorAll('[data-kpe-o="' + n + '"]').forEach(function (e) { e.textContent = o[n]; e.title = o[n]; }); });
      var h = o.hidden || {};
      Object.keys(h).forEach(function (n) { var e = f.querySelector('input[type=hidden][name="' + n + '"]'); if (e) e.value = h[n]; });
      if (f._kpeLibBack) f._kpeLibBack();
      state.unit = f.getAttribute("data-kpe-unit") || "";
      var rp = f.querySelector("[data-kpe-repicked]"); if (rp) rp.hidden = true;
      var nl = f.querySelector("[data-kpe-notlib]"); if (nl) nl.hidden = false;
      refresh();
    };
    if (kind === "edit") {   // what the line held, for Undo
      f._orig = { hidden: {} };
      ["name", "family"].forEach(function (n) { var e = f.querySelector('[data-kpe-o="' + n + '"]'); if (e) f._orig[n] = e.textContent; });
      ["kpi", "category"].forEach(function (n) { var e = f.querySelector('input[type=hidden][name="' + n + '"]'); if (e) f._orig.hidden[n] = e.value; });
      var sm = f.querySelector('[data-kpe-sel="method"]'), su = f.querySelector('[data-kpe-sel="unit"]');
      f._kpeLibBack = function () {   // Undo: the selects and the library's own go back to what the line held
        if (sm) sm.value = sm._was;
        if (su) su.value = su._was;
        f._kpeLibRestore && f._kpeLibRestore();
      };
    }
    input.addEventListener("focus", show);
    input.addEventListener("input", function () {
      if (state.bu && f._kpeBuOff) { f._kpeBuOff(); var af = f.querySelector("[data-kpe-after]"); if (af) af.hidden = true; }
      if (lid.value) { lid.value = ""; if (kind === "add") { var after = f.querySelector("[data-kpe-after]"); if (after) after.hidden = true; var ab = f.querySelector("[data-kpe-addbtn]"); if (ab) ab.disabled = true; } state.picked = null; }
      show();
    });
    input.addEventListener("blur", function () {
      setTimeout(function () {
        hide();
        // nothing typed is ever saved: a box left with words that are not a chosen KPI is cleared
        if (state.bu) input.value = state.bu.name;
        else if (!lid.value && kind === "add") input.value = "";
        else if (lid.value && state.picked) input.value = state.picked.name;
        else if (!lid.value) input.value = "";
      }, 120);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); if (list.hidden) show(); setActive(Math.min(items.length - 1, active + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(0, active - 1)); }
      else if (e.key === "Enter") { if (!list.hidden && items[active]) { e.preventDefault(); var pk_ = items[active]._it; if (pk_.sid !== undefined) chooseBu(pk_); else choose(pk_); } else e.preventDefault(); }
      else if (e.key === "Escape" && !list.hidden) { e.preventDefault(); e.stopPropagation(); hide(); }
    });
  }

  // ---- links: pick another library KPI, undo, Submitted this cycle ----
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("[data-kpe-repick]");
    if (a) {
      e.preventDefault();
      var f = a.closest("form"), box = f && f.querySelector("[data-kpe-repickbox]");
      if (box) { box.hidden = false; var qi = box.querySelector("[data-kpe-q]"); if (qi) qi.focus(); }
      return;
    }
    var pb = e.target.closest && e.target.closest("[data-kpe-putback], [data-kpe-rev], [data-kpe-revundo]");
    if (pb) {
      e.preventDefault();
      var fm = pb.closest("form");
      if (fm) {
        if (pb.hasAttribute("data-kpe-putback") && fm._kpePutBack) fm._kpePutBack();
        else if (pb.hasAttribute("data-kpe-rev") && fm._kpeReverse) fm._kpeReverse();
        else if (pb.hasAttribute("data-kpe-revundo") && fm._kpeReverseUndo) fm._kpeReverseUndo();
      }
      return;
    }
    var u = e.target.closest && e.target.closest("[data-kpe-undo]");
    if (u) {
      e.preventDefault();
      var f2 = u.closest("form"), pk = f2 && f2.querySelector("[data-kpe-pick]");
      if (pk && pk._undo) pk._undo();
      return;
    }
    var s = e.target.closest && e.target.closest("[data-kpe-subs]");
    if (s) {
      e.preventDefault();
      if (window.onehrPanel) window.onehrPanel.close();
      var t = document.getElementById("pp-subs");
      setTimeout(function () { if (t) t.scrollIntoView({ block: "start" }); }, 260);
    }
  });

  function boot() {
    [].forEach.call(document.querySelectorAll("form.kpe"), init);
    [].forEach.call(document.querySelectorAll("[data-kpe-static]"), function (b) { renderPreview(b, b.getAttribute("data-kpe-static")); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
