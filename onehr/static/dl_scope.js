/* The download panel on Reports › Data downloads (Chris, 2026-10-23, canvas
   [design canvas link removed]): a report's Download... opens it for that report, to pick the
   cycle by the report's kind (data-dl-mode: "pick" any cycle that ran in OneHR, "active" the active one only, "roster"
   none), the business group and the units ticked in it. admin.js opens the panel; this fills it first (a capture-phase
   click), keeps "All units" and the ticks in step, counts today's people in the picks, and remembers the last picks in
   this browser only (a convenience: the server never reads it). The form is a GET to the report's own address. */
(function () {
  var dataEl = document.getElementById('dl-data');
  var panel = document.getElementById('pnl-dl');
  if (!dataEl || !panel) return;
  var D;
  try { D = JSON.parse(dataEl.textContent); } catch (e) { return; }
  var form = panel.querySelector('[data-dl-form]');
  var head = panel.querySelector('.adm-panel-h');
  var sub = panel.querySelector('.adm-panel-sub');
  var cycSel = form.querySelector('[data-dl-cycle]');
  var bgEl = form.querySelector('[data-dl-bg]');
  var KEY = 'onehr.dlPicks';
  var mode = 'pick';
  // a download whose people are not "today's people in the picks" (Grade H's) names its own counts in the page data (D.counts)
  var counts = null;
  var whatEl = form.querySelector('[data-dl-what]');
  var noteEl = form.querySelector('[data-dl-active-note]');
  var whatDefault = whatEl ? whatEl.textContent : '';
  var noteDefault = noteEl ? noteEl.textContent : '';
  // what a row counts (data-dl-unit "scope|scopes"; people by default), and the Audit log's dates, counted by the server (data-dl-remote)
  var UNIT_DEFAULT = ['person', 'people'];
  var unitW = UNIT_DEFAULT;
  var remoteUrl = '';
  var remoteSeq = 0;
  var dateInputs = form.querySelectorAll('[data-dl-dates] input[type="date"]');

  function load() {
    try { return JSON.parse(window.localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function save(p) {
    try { window.localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) { /* a private window: no memory */ }
  }
  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  function lists() { return form.querySelectorAll('[data-dl-units-of]'); }
  function listOf(bg) {
    var hit = null;
    each(lists(), function (box) { if (box.getAttribute('data-dl-units-of') === bg) hit = box; });
    return hit;
  }
  function group(bg) {
    for (var i = 0; i < D.bgs.length; i++) if (D.bgs[i].bg === bg) return D.bgs[i];
    return null;
  }
  function ran(id) {
    for (var i = 0; i < D.cycles.length; i++) if (D.cycles[i].id === id) return D.cycles[i].ran;
    return false;
  }

  // the cycles: every one, those nothing in OneHR holds (HR's years before it) greyed
  function fillCycles(want) {
    cycSel.innerHTML = '';
    var greyed = false;
    D.cycles.forEach(function (c) {
      var o = document.createElement('option');
      o.value = String(c.id);
      o.textContent = c.name + (c.active ? ' · active' : '') + (c.ran ? '' : ' · before OneHR');
      if (!c.ran) { o.disabled = true; greyed = true; }
      cycSel.appendChild(o);
    });
    var pick = [want, D.viewed, D.active].filter(function (id) { return id && ran(id); })[0];
    if (!pick) {
      var first = D.cycles.filter(function (c) { return c.ran; })[0];
      pick = first ? first.id : null;
    }
    if (pick) cycSel.value = String(pick);
    form.querySelector('[data-dl-cycle-hr]').hidden = !greyed;
  }

  function ticked(box) { return box ? box.querySelectorAll('input[name="fcompany"]:checked') : []; }

  // a download counted per cycle ({"__cycle": {id: {group: ...}}}, late passes and the feedback) reads the cycle picked in the panel
  function cur() {
    if (!counts) return null;
    return counts.__cycle ? (counts.__cycle[cycSel.value] || {}) : counts;
  }

  function bgN(b) { var c = cur(); return c ? ((c[b.bg] || {}).n || 0) : b.n; }

  // the counts beside "All units" and each unit, and what each tick adds: this report's own, else today's people
  function applyCounts() {
    each(lists(), function (box) {
      var g = group(box.getAttribute('data-dl-units-of'));
      var all = box.querySelector('[data-dl-n-all]');
      if (all && g) all.textContent = String(bgN(g));
      each(box.querySelectorAll('input[name="fcompany"]'), function (i) {
        var c = cur();
        var u = c && g ? (((c[g.bg] || {}).u || {})[i.value] || 0) : (+i.getAttribute('data-n0') || 0);
        i.setAttribute('data-n', String(u));
        var span = i.parentNode.querySelector('[data-dl-n-unit]');
        if (span) span.textContent = String(u);
      });
    });
  }

  function say(n) {
    form.querySelector('[data-dl-n]').textContent = n.toLocaleString() + ' ' + (n === 1 ? unitW[0] : unitW[1]);
  }

  // the Audit log's count is the server's, for the dates typed (the same WHERE the file reads); the last answer wins
  function remoteCount() {
    if (!remoteUrl || !window.fetch) return;
    var seq = ++remoteSeq;
    var f = dateInputs[0] ? dateInputs[0].value : '', t = dateInputs[1] ? dateInputs[1].value : '';
    window.fetch(remoteUrl + '?date_from=' + encodeURIComponent(f) + '&date_to=' + encodeURIComponent(t),
                 {credentials: 'same-origin', headers: {Accept: 'application/json'}})
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && seq === remoteSeq) say(+j.n || 0); })
      .catch(function () { /* the file still downloads; only the count is missing */ });
  }

  function count() {
    if (mode === 'dates') {
      form.querySelector('[data-dl-units-n]').textContent = '';
      remoteCount();
      return;
    }
    var bg = bgEl.value, n = 0, box = listOf(bg), t = ticked(box);
    if (!bg) D.bgs.forEach(function (b) { n += bgN(b); });
    else if (t.length) each(t, function (i) { n += +i.getAttribute('data-n') || 0; });
    else n = bgN(group(bg) || {bg: bg, n: 0});
    say(n);
    form.querySelector('[data-dl-units-n]').textContent = !bg ? '' : t.length ? '· ' + t.length + ' ticked' : '· all';
  }

  // only the picked group's list shows, and only its ticks go with the form
  function showUnits() {
    var bg = bgEl.value;
    each(lists(), function (box) {
      var on = box.getAttribute('data-dl-units-of') === bg;
      box.hidden = !on;
      each(box.querySelectorAll('input[name="fcompany"]'), function (i) { i.disabled = !on; });
    });
    form.querySelector('[data-dl-units-none]').hidden = !!bg;
    count();
  }

  function setUnits(bg, units) {
    each(lists(), function (box) {
      var mine = box.getAttribute('data-dl-units-of') === bg ? units || [] : [];
      var any = false;
      each(box.querySelectorAll('input[name="fcompany"]'), function (i) {
        i.checked = mine.indexOf(i.value) >= 0;
        any = any || i.checked;
      });
      box.querySelector('[data-dl-all]').checked = !any;
    });
  }

  // "All units" and the ticks stay in step: ticking a unit clears All; clearing the last unit ticks All again
  form.addEventListener('change', function (e) {
    var t = e.target;
    if (t.closest && t.closest('[data-dl-dates]')) { if (mode === 'dates') remoteCount(); return; }
    if (t === cycSel) { applyCounts(); count(); return; }
    if (t === bgEl) { setUnits('', []); showUnits(); return; }
    var box = t.closest && t.closest('[data-dl-units-of]');
    if (!box) return;
    if (t.hasAttribute('data-dl-all')) {
      if (t.checked) each(box.querySelectorAll('input[name="fcompany"]'), function (i) { i.checked = false; });
      else if (!ticked(box).length) t.checked = true;
    } else {
      box.querySelector('[data-dl-all]').checked = !ticked(box).length;
    }
    count();
  });

  // Download... fills the panel for its report before admin.js opens it
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-dl-href]');
    if (!b) return;
    form.setAttribute('action', b.getAttribute('data-dl-href'));
    // a download never reloads the page, so a dimmed Download Excel button (base.html's busy mark) must not outlast it
    each(form.querySelectorAll('button[type="submit"]'), function (s) { s.classList.remove('btn-busy'); });
    head.textContent = b.getAttribute('data-dl-title') || 'Download';
    sub.textContent = b.getAttribute('data-dl-desc') || '';
    sub.hidden = !sub.textContent;
    mode = b.getAttribute('data-dl-mode') || 'pick';
    var key = b.getAttribute('data-dl-count');
    counts = key ? ((D.counts || {})[key] || {}) : null;
    unitW = (b.getAttribute('data-dl-unit') || '').split('|');
    if (unitW.length !== 2) unitW = UNIT_DEFAULT;
    remoteUrl = b.getAttribute('data-dl-remote') || '';
    if (whatEl) whatEl.textContent = b.getAttribute('data-dl-what') || whatDefault;
    if (noteEl) noteEl.textContent = b.getAttribute('data-dl-note') || noteDefault;
    var dates = mode === 'dates';
    form.querySelector('[data-dl-cycle-pick]').hidden = mode !== 'pick';
    cycSel.disabled = mode !== 'pick';
    form.querySelector('[data-dl-cycle-active]').hidden = mode !== 'active';
    form.querySelector('[data-dl-cycle-none]').hidden = mode !== 'roster';
    // the dates mode: a date range and nothing else (no cycle, no business group, no units); its inputs go with the form only here
    form.querySelector('[data-dl-dates]').hidden = !dates;
    form.querySelector('[data-dl-who]').hidden = dates;
    var pn = form.querySelector('[data-dl-picks-note]');
    if (pn) pn.hidden = dates;   // the dates are never remembered (submit), so the note on last picks is not theirs
    bgEl.disabled = dates;
    each(dateInputs, function (i) { i.name = dates ? i.getAttribute('data-name') : ''; });
    var p = load();
    if (mode === 'pick') fillCycles(+p.cycle || 0);
    if (bgEl.tagName === 'SELECT') bgEl.value = !dates && p.fbg && group(p.fbg) ? p.fbg : '';
    applyCounts();
    setUnits(bgEl.value, bgEl.value === p.fbg ? p.units : []);
    showUnits();
  }, true);

  // a reload or a link with ?panel=dl opens the panel with no report in it: it closes again, and never downloads
  function noReport() {
    if (!panel.hidden && form.getAttribute('action') === '#') {
      var c = panel.querySelector('[data-panel-close]');
      if (c) c.click();
    }
  }
  window.addEventListener('load', function () { setTimeout(noReport, 0); });

  form.addEventListener('submit', function (e) {
    if (form.getAttribute('action') === '#') { e.preventDefault(); noReport(); return; }
    if (mode === 'dates') {   // the dates are not a group's picks: nothing of them is remembered, and the last picks stay
      setTimeout(function () { var c = panel.querySelector('[data-panel-close]'); if (c) c.click(); }, 600);
      return;
    }
    var p = load();
    if (mode === 'pick') p.cycle = +cycSel.value || 0;
    p.fbg = bgEl.value;
    p.units = [];
    each(ticked(listOf(bgEl.value)), function (i) { p.units.push(i.value); });
    save(p);
    // the file downloads and the page stays: close the panel once it has gone
    setTimeout(function () {
      var c = panel.querySelector('[data-panel-close]');
      if (c) c.click();
    }, 600);
  });
})();
