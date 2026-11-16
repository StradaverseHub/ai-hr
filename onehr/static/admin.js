/* The admin shell's client side (2026-10-10, the "OneHR Admin Revamp" canvas):
 *   - the search (C1): pages, settings with how they read now, and downloads, from /admin/search.json, fetched once
 *     when it first opens; opened from the top bar or with Cmd/Ctrl+K; arrows move, Enter opens, Esc closes;
 *   - the sheet of every setting (C2): its module and scope chips and its search filter the rows in the page.
 * Plain DOM, no framework, like the rest of the app's scripts. */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- the search --------------------------------------------------------------------------------------------
  var box = document.getElementById('adm-search');
  var opener = document.getElementById('adm-search-open');
  var q = document.getElementById('adm-search-q');
  var list = document.getElementById('adm-search-list');
  var items = null, loading = false, cur = -1, shown = [], lastFocus = null;
  var searchBk = null;   // the phone's back gesture closes the search first (static/move_in.js, onehrBackLayer)
  var GROUPS = [['setting', 'Settings'], ['page', 'Pages'], ['report', 'Reports']];

  function load() {
    if (items || loading || !box) return;
    loading = true;
    fetch(box.getAttribute('data-src'), { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : { items: [] }; })
      .then(function (d) { items = (d && d.items) || []; loading = false; render(); })
      .catch(function () { items = []; loading = false; render(); });
  }

  function matches(it, words) {
    var hay = (it.label + ' ' + (it.path || '') + ' ' + (it.value || '')).toLowerCase();
    for (var i = 0; i < words.length; i++) { if (hay.indexOf(words[i]) < 0) return false; }
    return true;
  }

  function render() {
    if (!list) return;
    if (!items) { list.innerHTML = '<p class="adm-search-empty">Loading…</p>'; return; }
    var words = (q.value || '').toLowerCase().split(/\s+/).filter(Boolean);
    var html = '';
    shown = [];
    GROUPS.forEach(function (gr) {
      var hits = items.filter(function (it) { return it.kind === gr[0] && (!words.length || matches(it, words)); });
      if (!words.length && gr[0] !== 'page') hits = [];      // nothing typed: the pages, as a map of the admin
      if (!hits.length) return;
      hits = hits.slice(0, words.length ? 8 : 40);
      html += '<div class="adm-search-grp" role="presentation">' + esc(gr[1]) + '</div>';
      hits.forEach(function (it) {
        var n = shown.length;
        shown.push(it);
        html += '<a class="adm-search-opt" role="option" id="adm-opt-' + n + '" data-n="' + n + '" href="' +
          esc(it.href) + '"><span class="adm-side-sq" style="background:' + esc(it.color || 'var(--d-bg-8a90a2)') +
          '" aria-hidden="true"></span><span class="adm-search-txt"><b>' + esc(it.label) + '</b>' +
          (it.path ? '<small>' + esc(it.path) + '</small>' : '') + '</span>' +
          (it.value ? '<span class="adm-search-val">' + esc(it.value) + '</span>' : '') + '</a>';
      });
    });
    if (!shown.length) {
      html = '<p class="adm-search-empty">Nothing matches “' + esc(q.value) + '”.</p>';
    }
    if (words.length && window.admAgentAsk) {      // the words can always go to the Admin Agent instead
      var n2 = shown.length;
      shown.push({ ask: q.value.trim() });
      html += '<a class="adm-search-opt adm-search-ask" role="option" id="adm-opt-' + n2 + '" data-n="' + n2 +
        '" href="#"><span aria-hidden="true">✦</span><span class="adm-search-txt"><b>Ask the Admin Agent: “' +
        esc(q.value.trim()) + '”</b><small>It finds, opens and builds reports</small></span></a>';
    }
    list.innerHTML = html;
    move(shown.length ? 0 : -1);
  }

  function move(n) {
    var opts = list.querySelectorAll('.adm-search-opt');
    if (!opts.length) { cur = -1; q.removeAttribute('aria-activedescendant'); return; }
    cur = (n + opts.length) % opts.length;
    for (var i = 0; i < opts.length; i++) {
      opts[i].classList.toggle('is-cur', i === cur);
      opts[i].setAttribute('aria-selected', i === cur ? 'true' : 'false');
    }
    q.setAttribute('aria-activedescendant', 'adm-opt-' + cur);
    opts[cur].scrollIntoView({ block: 'nearest' });
  }

  function open() {
    if (!box) return;
    lastFocus = document.activeElement;
    box.hidden = false;
    if (!searchBk && typeof window.onehrBackLayer === 'function') searchBk = window.onehrBackLayer(function () { searchBk = null; close(); });
    q.value = '';
    load();
    render();
    q.focus();
  }

  function go(it) {
    if (it && it.ask) { close(); window.admAgentAsk(it.ask); return; }
    if (it && it.href) window.location.href = it.href;
  }

  function close() {
    if (!box || box.hidden) return;
    box.hidden = true;
    if (searchBk) { var sb = searchBk; searchBk = null; sb.done(); }
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  if (box && q && list) {
    if (opener) opener.addEventListener('click', open);
    list.addEventListener('click', function (e) {
      var a = e.target.closest('.adm-search-ask');
      if (a) { e.preventDefault(); go(shown[+a.getAttribute('data-n')]); }
    });
    q.addEventListener('input', render);
    q.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(cur + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(cur - 1); }
      else if (e.key === 'Enter') {
        if (cur >= 0 && shown[cur]) { e.preventDefault(); go(shown[cur]); }
      } else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    box.addEventListener('mousedown', function (e) { if (e.target === box) close(); });
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (box.hidden) open(); else close();
      } else if (e.key === 'Escape' && !box.hidden) { close(); }
    });
  }

  // ---- the sheet of every setting -------------------------------------------------------------------------
  var sheet = document.getElementById('adm-sheet');
  if (sheet) {
    var state = { module: '', scope: '', q: '' };
    var sq = document.getElementById('adm-sheet-q');
    var count = document.getElementById('adm-sheet-n');
    var none = sheet.querySelector('.adm-sheet-none');
    var rows = Array.prototype.slice.call(sheet.querySelectorAll('tbody tr[data-module]'));
    var apply = function () {
      var words = state.q.toLowerCase().split(/\s+/).filter(Boolean), n = 0;
      rows.forEach(function (tr) {
        var ok = (!state.module || tr.getAttribute('data-module') === state.module) &&
          (!state.scope || tr.getAttribute('data-scope') === state.scope) &&
          words.every(function (w) { return tr.getAttribute('data-text').indexOf(w) >= 0; });
        tr.hidden = !ok;
        if (ok) n++;
      });
      if (count) count.textContent = n;
      if (none) none.hidden = n > 0;
    };
    Array.prototype.forEach.call(document.querySelectorAll('.adm-chips[data-filter]'), function (grp) {
      var key = grp.getAttribute('data-filter');
      grp.addEventListener('click', function (e) {
        var b = e.target.closest('.adm-chip');
        if (!b) return;
        Array.prototype.forEach.call(grp.querySelectorAll('.adm-chip'), function (x) {
          x.classList.toggle('is-on', x === b);
          x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
        });
        state[key] = b.getAttribute('data-v') || '';
        apply();
      });
    });
    if (sq) sq.addEventListener('input', function () { state.q = sq.value || ''; apply(); });
  }
  // ---- the OneHR Admin Agent --------------------------------------------------------------------------------
  // Docked on every admin page: finds, opens, builds reports, never saves a setting. The conversation lives in this
  // tab (sessionStorage), so it survives the page it opens; only the person's words and the agent's go back to the
  // server -- every tool runs there, read-only, in this admin's scope.
  var agent = document.getElementById('adm-agent');
  if (agent) {
    var KEY = 'admAgent.v1';
    var log = document.getElementById('adm-agent-log');
    var form = document.getElementById('adm-agent-form');
    var aq = document.getElementById('adm-agent-q');
    var trig = document.getElementById('adm-agent-open');
    var busy = false;
    var agentBk = null;   // the phone's back gesture closes the panel first (static/move_in.js, onehrBackLayer)
    var st = (function () { try { return JSON.parse(sessionStorage.getItem(KEY)) || null; } catch (e) { return null; } })()
      || { open: false, log: [] };
    var save = function () { try { sessionStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* private mode */ } };
    var SUGGEST = ['Where do I set the potential thresholds?', "What's still to do this cycle?",
      'Performance progress by business group, as Excel', 'Which units have no PAT figure yet?'];

    var card = function (c) {
      if (c.type === 'built') {
        var head = '<tr>' + (c.columns || []).map(function (x) { return '<th>' + esc(x) + '</th>'; }).join('') + '</tr>';
        var body = (c.rows || []).map(function (r) {
          return '<tr>' + r.map(function (x) { return '<td>' + esc(x) + '</td>'; }).join('') + '</tr>';
        }).join('');
        return '<div class="adm-ac adm-ac-built"><b>' + esc(c.label) + '</b><div class="adm-ac-scroll"><table>' +
          '<thead>' + head + '</thead><tbody>' + body + '</tbody></table></div><span class="adm-ac-sub">' +
          esc(c.total) + ' row' + (c.total === 1 ? '' : 's') + (c.total > 6 ? ' in all' : '') + '</span>' +
          '<span class="adm-ac-btns"><a class="adm-ac-solid" href="' + esc(c.xlsx) + '">Download Excel</a>' +
          '<a class="adm-ac-line" href="' + esc(c.page) + '">Open as a page ›</a></span></div>';
      }
      if (c.type === 'status') {
        return '<div class="adm-ac"><b>' + esc(c.label) + '</b><ul class="adm-ac-steps">' + (c.steps || []).map(function (s2) {
          return '<li><span>' + esc(s2.module) + '</span> ' + esc(s2.label) + ' <small>' + esc(s2.detail) + '</small>' +
            (s2.href ? ' <a href="' + esc(s2.href) + '">Open ›</a>' : '') + '</li>';
        }).join('') + '</ul></div>';
      }
      var eyebrow = esc(c.path || '') + (c.scope ? ' · ' + esc(c.scope) : '');
      var go = c.type === 'report' ? 'Download' : (c.type === 'setting' ? 'Open this setting ›' : 'Open ›');
      return '<div class="adm-ac"><span class="adm-ac-eyebrow" style="--mc:' + esc(c.color || 'var(--muted)') + '">' +
        eyebrow + '</span><b>' + esc(c.label) + '</b>' + (c.value ? '<span class="adm-ac-val">' + esc(c.value) + '</span>' : '') +
        (c.desc ? '<span class="adm-ac-sub">' + esc(c.desc) + '</span>' : '') +
        (c.type === 'setting' && c.can_edit === false ? '<span class="adm-ac-sub">Only a super admin changes this.</span>' : '') +
        '<a class="adm-ac-line" href="' + esc(c.href) + '">' + go + '</a></div>';
    };

    var draw = function () {
      if (!st.log.length) {
        log.innerHTML = '<div class="adm-agent-hello"><p>Ask where something is set, what is left to do, or for a ' +
          'report. I open the page for you; you make the change.</p><div class="adm-agent-chips">' +
          SUGGEST.map(function (x) { return '<button type="button" class="adm-agent-chip">' + esc(x) + '</button>'; }).join('') +
          '</div></div>';
        return;
      }
      log.innerHTML = st.log.map(function (m) {
        if (m.role === 'user') return '<div class="adm-am-user">' + esc(m.text) + '</div>';
        return '<div class="adm-am-agent"><span class="adm-agent-mark is-sm" aria-hidden="true">✦</span><div>' +
          '<p>' + esc(m.say) + '</p>' + (m.cards || []).map(card).join('') +
          ((m.qr && m.qr.length) ? '<div class="adm-agent-chips">' + m.qr.map(function (x) {
            return '<button type="button" class="adm-agent-chip">' + esc(x) + '</button>'; }).join('') + '</div>' : '') +
          '</div></div>';
      }).join('') + (busy ? '<div class="adm-am-agent is-busy"><span class="adm-agent-mark is-sm" aria-hidden="true">✦</span>' +
        '<div><p>Looking…</p></div></div>' : '');
      log.scrollTop = log.scrollHeight;
    };

    var show = function (on) {
      agent.hidden = !on;
      document.body.classList.toggle('adm-agent-on', on);
      if (trig) {   // the floating icon becomes the panel's close button (2026-10-12, canvas board A3)
        trig.setAttribute('aria-expanded', on ? 'true' : 'false');
        trig.setAttribute('aria-label', on ? 'Close the Admin Agent' : 'Admin Agent');
      }
      st.open = on;
      save();
      if (on && !agentBk && typeof window.onehrBackLayer === 'function') agentBk = window.onehrBackLayer(function () { agentBk = null; show(false); });
      if (!on && agentBk) { var ab = agentBk; agentBk = null; ab.done(); }
      if (on) { draw(); aq.focus(); }
    };

    var send = function (text) {
      text = (text || '').trim();
      if (!text || busy) return;
      st.log.push({ role: 'user', text: text });
      busy = true;
      save();
      draw();
      var hist = st.log.slice(0, -1).slice(-12).map(function (m) {
        return { role: m.role, content: m.role === 'user' ? m.text : m.say };
      });
      var fd = new FormData();
      var meta = document.querySelector('meta[name="csrf-token"]');
      fd.append('csrf_token', meta ? meta.getAttribute('content') : '');
      fd.append('message', text);
      fd.append('history', JSON.stringify(hist));
      fetch(agent.getAttribute('data-src'), { method: 'POST', body: fd, credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          busy = false;
          st.log.push({ role: 'agent', say: d.say || d.error || 'Sorry, something went wrong.', cards: d.cards || [],
            qr: d.quick_replies || [] });
          st.log = st.log.slice(-30);
          save();
          draw();
          var here = location.pathname + location.search + location.hash;
          if (d.open && d.open !== here) setTimeout(function () { window.location.href = d.open; }, 700);
        })
        .catch(function () {
          busy = false;
          st.log.push({ role: 'agent', say: 'Sorry, I couldn’t reach the server. Try again in a moment.', cards: [] });
          save();
          draw();
        });
    };
    window.admAgentAsk = function (text) { show(true); send(text); };

    if (trig) trig.addEventListener('click', function () { show(agent.hidden); });
    try {   // its name shows once, on a first visit (canvas board A1)
      if (trig && !localStorage.getItem('onehr.fab.admin-agent')) {
        trig.classList.add('is-intro');
        setTimeout(function () { trig.classList.remove('is-intro'); }, 4000);
        localStorage.setItem('onehr.fab.admin-agent', '1');
      }
    } catch (e) { /* storage blocked: no intro */ }
    document.getElementById('adm-agent-close').addEventListener('click', function () { show(false); if (trig) trig.focus(); });
    document.getElementById('adm-agent-new').addEventListener('click', function () { st.log = []; save(); draw(); aq.focus(); });
    form.addEventListener('submit', function (e) { e.preventDefault(); var t = aq.value; aq.value = ''; send(t); });
    aq.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit')); }
      else if (e.key === 'Escape') { show(false); if (trig) trig.focus(); }
    });
    log.addEventListener('click', function (e) {
      var b = e.target.closest('.adm-agent-chip');
      if (b) send(b.textContent);
    });
    if (st.open) show(true);
  }

  // ---- the filter rows (canvas K2, 2026-10-10): business group, then unit, then department, each ONE row; the < >
  // show only when a row doesn't fit, and the picked option is brought into view -----------------------------------
  Array.prototype.forEach.call(document.querySelectorAll('.adm-frow-track'), function (tr) {
    var pills = tr.querySelector('.adm-frow-pills');
    var prev = tr.querySelector('.adm-frow-nav.is-prev'), next = tr.querySelector('.adm-frow-nav.is-next');
    if (!pills || !prev || !next) return;
    function sync() {
      var max = pills.scrollWidth - pills.clientWidth;
      tr.classList.toggle('is-overflow', max > 2);
      prev.disabled = pills.scrollLeft <= 2;
      next.disabled = pills.scrollLeft >= max - 2;
    }
    [prev, next].forEach(function (b, i) {
      b.addEventListener('click', function () {
        pills.scrollBy({ left: (i ? 1 : -1) * Math.max(120, Math.round(pills.clientWidth * 0.7)), behavior: 'smooth' });
      });
    });
    pills.addEventListener('scroll', sync, { passive: true });
    sync();  // show the < > first: they narrow the row, so measure after them (8 Nov: a last lit pill sat 68px cut off)
    var on = pills.querySelector('.adm-frow-pill.is-on');
    // where the lit pill sits inside the row (offsetLeft would count from the card, past the label and the arrow)
    var at = on ? on.getBoundingClientRect().left - pills.getBoundingClientRect().left + pills.scrollLeft : 0;
    if (on && at + on.offsetWidth > pills.clientWidth) pills.scrollLeft = Math.max(0, at - 40);
    sync();
    if (window.ResizeObserver) new ResizeObserver(sync).observe(pills);
  });

  // ---- a date that locks after save (the Calendar's This cycle card, All cycles' overrides): "Change" opens it -----
  Array.prototype.forEach.call(document.querySelectorAll('.inline-when'), function (f) {
    var inp = f.querySelector('.when-input'), edit = f.querySelector('.when-edit'), save = f.querySelector('.when-save');
    if (!inp || !edit || !save || edit.__wired) return;
    edit.__wired = true;
    edit.addEventListener('click', function () {
      inp.disabled = false; inp.classList.add('editing'); edit.hidden = true; save.hidden = false; inp.focus();
    });
  });
})();

/* ---- The admin table standard (Chris, 2026-10-11, canvas B2: "table should have max view of 15 rows and the column
   header to behave like excel-like sort and filter") ----------------------------------------------------------------
   Every admin data table gets it here, so no template can forget: a table whose headers aren't already an Excel menu
   (colth/colmenu, .col-menu-btn) gets one built from its cells -- sort A-Z / Z-A, and a search + tick-box filter with
   counts -- and every table shows at most 15 rows, the header frozen and the rest scrolling. Business group, unit and
   department columns sort but never filter: those three are the filter rows above the table. Opt a table out with
   class "no-auto-table" (a fixed config grid, a band ladder). Built from DOM nodes only, never HTML strings. */
(function () {
  "use strict";
  var ROWS_IN_VIEW = 15;
  // business group and department sort only (their filter rows sit above the table); a business unit column sorts AND
  // filters (Chris, 2026-10-20: "the BU should be sort and filter on this leader hod setting page and also all other
  // admin pages with BU column")
  var ROW_DIM = /business group|department/i;
  var menu = null, openBtn = null;

  function txt(cell) { return (cell ? (cell.innerText || cell.textContent || "") : "").replace(/\s+/g, " ").trim(); }
  function firstLine(cell) {
    if (!cell) return "";
    var t = (cell.innerText || cell.textContent || "").split("\n").map(function (x) { return x.trim(); })
      .filter(Boolean);
    return t.length ? t[0] : "";
  }
  function num(v) {
    var m = String(v).replace(/,/g, "").match(/^[-+]?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }
  function bodyRows(table) {
    var tb = table.tBodies[0];
    return tb ? Array.prototype.filter.call(tb.rows, function (r) { return !r.classList.contains("no-filter-match") &&
      !r.classList.contains("auto-nomatch"); }) : [];
  }
  function eligible(table) {
    if (table.classList.contains("no-auto-table") || !table.tHead || !table.tBodies[0]) return false;
    if (table.querySelector("thead .col-menu-btn")) return false;   // already has the Excel menu
    var rows = bodyRows(table);
    if (rows.length < 2) return false;
    var ncols = table.tHead.rows[0].cells.length;
    // detail / edit rows spanning the table, or merged cells, can't be reordered row by row
    return !rows.some(function (r) {
      return r.cells.length !== ncols || Array.prototype.some.call(r.cells, function (c) { return c.rowSpan > 1; });
    });
  }

  function closeMenu() {
    if (menu) { menu.remove(); menu = null; }
    if (openBtn) { openBtn.setAttribute("aria-expanded", "false"); openBtn = null; }
  }
  document.addEventListener("click", function (e) {
    if (menu && !menu.contains(e.target) && !(openBtn && openBtn.contains(e.target))) closeMenu();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && menu) closeMenu(); });

  function enhance(table) {
    var heads = Array.prototype.slice.call(table.tHead.rows[0].cells);
    var state = { filters: {}, sort: null };
    heads.forEach(function (th, ci) {
      var label = txt(th);
      var seen = th.cloneNode(true);
      seen.querySelectorAll(".sr-only").forEach(function (x) { x.remove(); });
      if (!txt(seen) || th.querySelector("button, a, input, select")) return;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "col-menu-btn auto-cm";
      btn.setAttribute("aria-haspopup", "true");
      btn.setAttribute("aria-expanded", "false");
      var lab = document.createElement("span"); lab.className = "cm-label"; lab.textContent = label;
      var car = document.createElement("span"); car.className = "cm-caret"; car.setAttribute("aria-hidden", "true");
      btn.appendChild(lab); btn.appendChild(car);
      // a short heading ("W") keeps its full word for the hover and a screen reader (data-full, 2026-10-23)
      if (th.getAttribute("data-full")) btn.setAttribute("aria-label", th.getAttribute("data-full"));
      th.textContent = "";
      th.appendChild(btn);
      // a group / unit / department header filters too where the table asks for it (data-col-filter; Chris,
      // 2026-10-20, the module Progress list: "split unit and department into two columns, so admin can filter and
      // sort for each")
      var filterable = th.hasAttribute("data-col-filter") || !ROW_DIM.test(label);
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (openBtn === btn) { closeMenu(); return; }
        closeMenu();
        openMenu(table, btn, ci, filterable, state, heads);
      });
    });
  }

  function apply(table, state, heads) {
    var rows = bodyRows(table);
    var tb = table.tBodies[0];
    if (state.sort) {
      var ci = state.sort.col, dir = state.sort.dir;
      var vals = rows.map(function (r) { return firstLine(r.cells[ci]); });
      var numeric = vals.filter(function (v) { return v !== "" && v !== "—"; })
        .every(function (v) { return num(v) !== null; });
      var order = rows.map(function (r, i) { return { r: r, v: vals[i], i: i }; });
      order.sort(function (a, b) {
        var x = a.v, y = b.v, c;
        if (numeric) { c = (num(x) === null ? -Infinity : num(x)) - (num(y) === null ? -Infinity : num(y)); }
        else { c = x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" }); }
        return (c || (a.i - b.i)) * dir;
      });
      var tail = tb.querySelector(".no-filter-match, .auto-nomatch");
      order.forEach(function (o) { tb.insertBefore(o.r, tail); });
    }
    var shown = 0;
    rows.forEach(function (r) {
      var ok = Object.keys(state.filters).every(function (ci) {
        var set = state.filters[ci];
        return !set || set.indexOf(firstLine(r.cells[ci])) >= 0;
      });
      r.style.display = ok ? "" : "none";
      if (ok) shown++;
    });
    var nm = tb.querySelector(".auto-nomatch");
    if (!nm) {
      nm = document.createElement("tr"); nm.className = "auto-nomatch";
      var td = document.createElement("td"); td.colSpan = heads.length; td.className = "muted";
      td.textContent = "No rows match the filters.";
      nm.appendChild(td); tb.appendChild(nm);
    }
    nm.hidden = shown > 0;
    heads.forEach(function (th, ci) {
      var b = th.querySelector(".auto-cm");
      if (!b) return;
      b.classList.toggle("has-filter", !!state.filters[ci]);
      b.classList.toggle("sort-asc", !!(state.sort && state.sort.col === ci && state.sort.dir === 1));
      b.classList.toggle("sort-desc", !!(state.sort && state.sort.col === ci && state.sort.dir === -1));
    });
    cap(table);
  }

  function openMenu(table, btn, ci, filterable, state, heads) {
    menu = document.createElement("div");
    menu.className = "col-menu auto-colmenu";
    menu.setAttribute("role", "dialog");
    openBtn = btn;
    btn.setAttribute("aria-expanded", "true");
    var sortBox = document.createElement("div"); sortBox.className = "cm-sort";
    [["Sort A → Z", 1], ["Sort Z → A", -1]].forEach(function (s) {
      var b = document.createElement("button"); b.type = "button"; b.textContent = s[0];
      b.addEventListener("click", function () { state.sort = { col: ci, dir: s[1] }; apply(table, state, heads); closeMenu(); });
      sortBox.appendChild(b);
    });
    menu.appendChild(sortBox);
    if (filterable) {
      var counts = {};
      bodyRows(table).forEach(function (r) { var v = firstLine(r.cells[ci]); counts[v] = (counts[v] || 0) + 1; });
      var values = Object.keys(counts).sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); });
      var cur = state.filters[ci];
      var search = document.createElement("div"); search.className = "cm-search";
      var si = document.createElement("input"); si.type = "text"; si.placeholder = "Search values…";
      si.setAttribute("aria-label", "Search values"); search.appendChild(si); menu.appendChild(search);
      var allL = document.createElement("label"); allL.className = "cm-all";
      var allC = document.createElement("input"); allC.type = "checkbox"; allC.checked = !cur;
      allL.appendChild(allC); allL.appendChild(document.createTextNode(" (Select all)")); menu.appendChild(allL);
      var list = document.createElement("div"); list.className = "cm-list";
      var boxes = values.map(function (v) {
        var l = document.createElement("label");
        var c = document.createElement("input"); c.type = "checkbox"; c.value = v; c.checked = !cur || cur.indexOf(v) >= 0;
        l.appendChild(c); l.appendChild(document.createTextNode(" " + (v || "(blank)") + "  "));
        var n = document.createElement("span"); n.className = "muted small"; n.textContent = String(counts[v]);
        l.appendChild(n); list.appendChild(l);
        return c;
      });
      menu.appendChild(list);
      si.addEventListener("input", function () {
        var q = si.value.toLowerCase();
        boxes.forEach(function (c) { c.parentNode.style.display = c.value.toLowerCase().indexOf(q) >= 0 ? "" : "none"; });
      });
      allC.addEventListener("change", function () {
        boxes.forEach(function (c) { if (c.parentNode.style.display !== "none") c.checked = allC.checked; });
      });
      var foot = document.createElement("div"); foot.className = "cm-foot";
      var clr = document.createElement("button"); clr.type = "button"; clr.className = "cm-clear"; clr.textContent = "Clear filter";
      var ap = document.createElement("button"); ap.type = "button"; ap.className = "cm-apply primary"; ap.textContent = "Apply";
      clr.addEventListener("click", function () { delete state.filters[ci]; apply(table, state, heads); closeMenu(); });
      ap.addEventListener("click", function () {
        var picked = boxes.filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
        if (picked.length === boxes.length) delete state.filters[ci]; else state.filters[ci] = picked;
        apply(table, state, heads); closeMenu();
      });
      foot.appendChild(clr); foot.appendChild(ap); menu.appendChild(foot);
    } else {
      var note = document.createElement("p"); note.className = "muted small"; note.style.margin = "6px";
      note.textContent = "Filter by business group, unit and department with the rows above the table.";
      menu.appendChild(note);
    }
    document.body.appendChild(menu);
    var r = btn.getBoundingClientRect();
    menu.style.position = "absolute";
    menu.style.top = (window.scrollY + r.bottom + 4) + "px";
    menu.style.left = Math.max(8, Math.min(window.scrollX + r.left, window.scrollX + document.documentElement.clientWidth - menu.offsetWidth - 8)) + "px";
    var f = menu.querySelector("input[type=text], button"); if (f) f.focus();
  }

  // 15 rows in view: the header plus the first 15 rows showing set the height; the rest scroll, the header frozen
  function cap(table) {
    var box = table.parentElement;
    if (!box || !box.classList.contains("table-scroll")) {
      box = document.createElement("div");
      box.className = "table-scroll";
      table.parentNode.insertBefore(box, table);
      box.appendChild(table);
    }
    // a row a page's own filter hides (the hidden attribute, e.g. Leaders' HOD units) counts as not showing too
    var vis = bodyRows(table).filter(function (r) { return r.style.display !== "none" && !r.hidden; });
    // a table may ask for fewer rows in view (data-rows-in-view="10": AI+ feedback's written lines, Chris 2026-11-06)
    var inView = parseInt(table.getAttribute("data-rows-in-view"), 10) || ROWS_IN_VIEW;
    if (vis.length <= inView) { box.classList.remove("table-cap15"); box.style.maxHeight = ""; return; }
    // a table in a side panel that isn't open yet has no height to measure (it capped at 2px, 2026-10-22): cap it
    // when it shows
    if (!table.offsetParent) {
      if (window.ResizeObserver && !table._capWait) {
        table._capWait = new ResizeObserver(function () {
          if (!table.offsetParent) return;
          table._capWait.disconnect(); table._capWait = null; cap(table);
        });
        table._capWait.observe(table);
      }
      return;
    }
    var h = (table.tHead ? table.tHead.offsetHeight : 0);
    for (var i = 0; i < inView; i++) h += vis[i].offsetHeight;
    box.classList.add("table-cap15");
    box.style.maxHeight = (h + 2) + "px";
  }

  var main = document.querySelector(".adm-main, main") || document.body;
  Array.prototype.forEach.call(main.querySelectorAll("table.admin-table"), function (t) {
    if (t.closest(".col-menu, .no-auto-table-zone")) return;
    if (eligible(t)) enhance(t);
    cap(t);
  });
  // a table built later (the Reports people list, a pop-out) can ask for the standard itself
  window.onehrTableStandard = function (t) { if (eligible(t)) enhance(t); cap(t); };
})();


/* The people picker (admin round 4, canvas D2/D3): a manager picked "by name, ID or job", not an Employee ID typed from
   memory. Markup: <span class="pick" data-pick><input class="pick-q"> <input type="hidden" class="pick-val"></span>.
   Typing searches /admin/people/find.json (this admin's own scope); a pick fills the hidden Employee ID.
   Strict (Chris, 2026-10-19: "it should run as dropdown for selection to ensure data validation ... should use search
   function to find from our user pool"): typed text that isn't a pick stops the form (the browser's own check, before
   OneHR's confirm box), so only someone from the list is ever sent.
   data-pick-multi: several people as chips, their Employee IDs comma-joined in the hidden field; data-pick-required:
   at least one. A picker inside a scrolling table opens its list over the page (fixed), so the table never clips it.
   data-pick-bg="<business group>": only that group's people come up (a BU group's picks, 2026-10-22); data-pick-units:
   "unit||unit", only those units' people (a panel's calibrators, 2026-10-26; read at each search); data-pick-init:
   the chips it opens with, as JSON [{eid, name}] (editing a group). data-pick-xbu="<a saved BU KPI's id>": the people who could join that
   BU KPI as a guest from another unit of its group, each with the server's own words when they cannot (greyed, not pickable). */
(function () {
  var seq = 0;
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function init(box) {
    if (box._pick) return; box._pick = true;
    var q = box.querySelector(".pick-q"), val = box.querySelector(".pick-val");
    if (!q || !val) return;
    var multi = box.hasAttribute("data-pick-multi"), need = box.hasAttribute("data-pick-required"), chosen = [];
    var list = document.createElement("ul"), id = "pick-" + (++seq), active = -1, items = [], timer = null, chips = null;
    list.className = "pick-list"; list.id = id; list.setAttribute("role", "listbox"); list.hidden = true;
    box.appendChild(list);
    if (multi) {
      chips = document.createElement("span"); chips.className = "pick-chips"; chips.setAttribute("aria-live", "polite");
      box.insertBefore(chips, box.firstChild);
      try { chosen = JSON.parse(box.getAttribute("data-pick-init") || "[]") || []; } catch (e) { chosen = []; }
    }
    var onlyBg = box.getAttribute("data-pick-bg") || "", xbu = box.getAttribute("data-pick-xbu") || "";   // xbu: a saved BU KPI's id (2026-11-07)
    q.setAttribute("role", "combobox"); q.setAttribute("aria-autocomplete", "list");
    q.setAttribute("aria-expanded", "false"); q.setAttribute("aria-controls", id);
    function check() {   // the browser's own form check carries the message, so nothing unpicked is ever sent
      var typed = q.value.trim(), msg = "";
      if (typed && (multi || !val.value)) msg = multi ? "Choose the person from the list, or clear what you typed."
        : "Choose a person from the list: type a name or Employee ID, then pick them.";
      else if (multi && need && !chosen.length) msg = "Choose at least one person from the list.";
      q.setCustomValidity(msg);
    }
    function close() { list.hidden = true; q.setAttribute("aria-expanded", "false"); active = -1; q.removeAttribute("aria-activedescendant"); }
    function mark() {
      [].forEach.call(list.children, function (li, i) { li.classList.toggle("is-on", i === active); li.setAttribute("aria-selected", i === active ? "true" : "false"); });
      if (active >= 0) q.setAttribute("aria-activedescendant", id + "-" + active);
    }
    function paint() {
      val.value = chosen.map(function (p) { return p.eid; }).join(",");
      chips.innerHTML = "";
      chosen.forEach(function (p, i) {
        var c = document.createElement("span"); c.className = "pick-chip";
        c.innerHTML = esc(p.name) + " <small>" + esc(p.eid) + "</small>";
        var x = document.createElement("button"); x.type = "button"; x.setAttribute("aria-label", "Take " + p.name + " off"); x.textContent = "×";
        x.addEventListener("click", function () { chosen.splice(i, 1); paint(); check(); q.focus(); });
        c.appendChild(x); chips.appendChild(c);
      });
      box.classList.toggle("has-chips", chosen.length > 0);
    }
    function choose(i) {
      var p = items[i]; if (!p || p.why) return;   // a person the server says cannot be picked (data-pick-xbu) is greyed, never chosen
      if (multi) {
        if (!chosen.some(function (c) { return c.eid === p.eid; })) chosen.push(p);
        q.value = ""; paint();
      } else { val.value = p.eid; q.value = p.name; }
      close(); check();
      box.dispatchEvent(new CustomEvent("pick", { bubbles: true, detail: p }));
    }
    function render() {
      list.innerHTML = "";
      var shown = multi ? items.filter(function (p) { return !chosen.some(function (c) { return c.eid === p.eid; }); }) : items;
      items = shown;
      if (!items.length) { list.innerHTML = '<li class="pick-none">Nobody matches</li>'; list.hidden = false; place(); return; }
      items.forEach(function (p, i) {
        var li = document.createElement("li"); li.id = id + "-" + i; li.setAttribute("role", "option");
        var lead = p.heads ? "HOD of " + p.heads : (p.leads ? "leads " + p.leads : "");
        if (xbu) {   // BU KPI card, "From another unit": their unit, grade and what they hold, or the writer's own words for why not
          li.className = p.why ? "pick-off" : ""; if (p.why) li.setAttribute("aria-disabled", "true");
          li.innerHTML = "<b>" + esc(p.name) + "</b> <span>· " + esc(p.eid) + "</span><small>" +
            esc([p.unit, p.jg, p.dept, p.why ? "" : (p.kn + ", " + p.w + "%")].filter(Boolean).join(" · ")) + "</small>" +
            (p.why ? "<small class=\"pick-why\">" + esc(p.why) + "</small>" : "");
        } else li.innerHTML = "<b>" + esc(p.name) + "</b> <span>· " + esc(p.eid) + "</span><small>" +
          esc([p.title, p.dept, p.unit, lead].filter(Boolean).join(" · ")) + "</small>";
        li.addEventListener("mousedown", function (e) { e.preventDefault(); choose(i); });
        list.appendChild(li);
      });
      list.hidden = false; q.setAttribute("aria-expanded", "true"); active = -1; mark();
      place();
    }
    var scroller = box.closest(".table-scroll");
    function place() {   // keep the list on screen: it opens to the left when the field sits near the right edge
      if (scroller) {      // over the page, so the table's own scroll box never clips it
        var b = q.getBoundingClientRect();
        list.style.position = "fixed"; list.style.top = (b.bottom + 4) + "px"; list.style.minWidth = b.width + "px";
        list.style.left = b.left + "px"; list.style.right = "auto";
        var w = list.getBoundingClientRect();
        if (w.right > window.innerWidth - 8) list.style.left = Math.max(8, b.right - w.width) + "px";
        return;
      }
      list.style.left = "0"; list.style.right = "auto";
      var r = list.getBoundingClientRect();
      if (r.right > window.innerWidth - 8) { list.style.left = "auto"; list.style.right = "0"; }
    }
    if (scroller) scroller.addEventListener("scroll", close, { passive: true });
    q.addEventListener("input", function () {
      if (!multi) val.value = "";
      check(); clearTimeout(timer);
      var t = q.value.trim(); if (t.length < 2) { close(); return; }
      timer = setTimeout(function () {
        var onlyUnits = box.getAttribute("data-pick-units") || "";   // read each time: the units ticked can change
        fetch("/admin/people/find.json?q=" + encodeURIComponent(t) + (onlyBg ? "&bg=" + encodeURIComponent(onlyBg) : "") +
              (onlyUnits ? "&units=" + encodeURIComponent(onlyUnits) : "") + (xbu ? "&xbu=" + encodeURIComponent(xbu) : ""), { credentials: "same-origin" })
          .then(function (r) { return r.json(); }).then(function (d) { if (q.value.trim() === t) { items = d.people || []; render(); } })
          .catch(function () {});
      }, 200);
    });
    q.addEventListener("keydown", function (e) {
      if (multi && e.key === "Backspace" && !q.value && chosen.length) { chosen.pop(); paint(); check(); return; }
      if (list.hidden) return;
      if (e.key === "ArrowDown") { active = Math.min(items.length - 1, active + 1); mark(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); mark(); e.preventDefault(); }
      else if (e.key === "Enter" && active >= 0) { choose(active); e.preventDefault(); }
      else if (e.key === "Escape") { close(); e.preventDefault(); e.stopPropagation(); }
    });
    q.addEventListener("blur", function () { setTimeout(close, 120); });
    var form = box.closest("form");
    if (form) form.addEventListener("reset", function () { setTimeout(function () { chosen = []; if (multi) paint(); check(); }, 0); });
    if (multi && chosen.length) paint();
    check();
    // a page's own list can add or take off a chip (a panel's "Not covered yet", 2026-10-27)
    box._pickApi = !multi ? null : {
      add: function (p) { if (p && p.eid && !chosen.some(function (c) { return c.eid === p.eid; })) { chosen.push({ eid: p.eid, name: p.name || p.eid }); paint(); check(); } },
      remove: function (eid) { chosen = chosen.filter(function (c) { return c.eid !== eid; }); paint(); check(); }
    };
  }
  function scan(root) { (root || document).querySelectorAll("[data-pick]").forEach(init); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { scan(); }); else scan();
  window.onehrPick = scan;
})();

/* Choose from the list, or name a new one (2026-10-19): <select data-choose-new> whose "__new__" option shows the
   [data-new-input] beside it (required while shown); the server reads the select, and its *_new field for "__new__".
   data-list-for="<unit select>" + data-list-map="<json script>": the options are that unit's ({unit: [[name, people]]}),
   rebuilt when the unit changes, keeping what was chosen (or what the person has now, marked "now"). */
(function () {
  function sync(sel) {
    var box = sel.closest("[data-choose-new-box]") || sel.parentNode, inp = box && box.querySelector("[data-new-input]");
    if (!inp) return;
    var on = sel.value === "__new__";
    inp.hidden = !on; inp.required = on && sel.hasAttribute("data-new-required"); inp.disabled = !on;
    if (on && document.activeElement === sel) inp.focus();
  }
  function opt(sel, v, t) { var o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o); return o; }
  function lists(sel) {
    var unit = document.querySelector(sel.getAttribute("data-list-for")), src = document.querySelector(sel.getAttribute("data-list-map"));
    var map = {}; try { map = JSON.parse((src && src.textContent) || "{}"); } catch (e) { map = {}; }
    var cur = sel.getAttribute("data-current") || "", what = sel.getAttribute("data-list-what") || "one";
    function build() {
      var keep = sel.value && sel.value !== "__new__" ? sel.value : cur, wasNew = sel.value === "__new__";
      var list = map[unit ? unit.value : ""] || [], hit = "";
      sel.textContent = "";
      var nonew = sel.hasAttribute("data-list-nonew");
      opt(sel, "", unit && !unit.value && !list.length ? (nonew ? "Choose a department first" : "Choose a business unit first")
                                                      : (nonew ? "Choose…" : "None"));
      list.forEach(function (d) {
        opt(sel, d[0], d[0] + " · " + d[1] + (d[1] === 1 ? " person" : " people"));
        if (keep && d[0].toLowerCase() === keep.toLowerCase()) hit = d[0];
      });
      if (keep && !hit && keep === cur) { opt(sel, cur, cur + " (now)"); hit = cur; }
      if (!nonew) opt(sel, "__new__", "A new " + what + "…");
      sel.value = wasNew ? "__new__" : hit;
      sync(sel);
    }
    if (unit) unit.addEventListener("change", build);
    build();
  }
  function scan(root) { (root || document).querySelectorAll("select[data-choose-new]").forEach(function (s) {
    if (s._cn) return; s._cn = true;
    if (s.hasAttribute("data-list-for")) lists(s);
    s.addEventListener("change", function () { sync(s); }); sync(s); }); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { scan(); }); else scan();
  window.onehrChooseNew = scan;
})();

/* Edit details' business group (2026-10-27, the super admin's): <select data-bg-units="<json script>" data-unit-select="<unit
   select>">. Picking a group rebuilds the unit list from {group: [[unit, shown name]]}, keeps the unit chosen when the new
   group has it (else its first) and fires the unit's change, which rebuilds the department and job title lists. */
(function () {
  document.addEventListener("change", function (e) {
    var bg = e.target;
    if (!bg || !bg.getAttribute || !bg.hasAttribute("data-bg-units")) return;
    var src = document.querySelector(bg.getAttribute("data-bg-units")), unit = document.querySelector(bg.getAttribute("data-unit-select"));
    var map = {}; try { map = JSON.parse((src && src.textContent) || "{}"); } catch (err) { map = {}; }
    if (!unit) return;
    var was = unit.value, list = map[bg.value] || [];
    unit.textContent = "";
    list.forEach(function (u) { var o = document.createElement("option"); o.value = u[0]; o.textContent = u[1]; unit.appendChild(o); });
    var hit = list.some(function (u) { return u[0] === was; });
    if (list.length) unit.value = hit ? was : list[0][0];
    unit.dispatchEvent(new Event("change", {bubbles: true}));
  });
})();

/* People > Users: the column menus (admin round 4, row 8) -- type to narrow the list of ticks; one menu open at a time;
   Escape or a click outside closes it */
(function () {
  document.addEventListener("input", function (e) {
    var q = e.target.closest && e.target.closest("[data-colf-q]");
    if (!q) return;
    var v = q.value.trim().toLowerCase();
    q.closest(".adm-colf-pop").querySelectorAll(".adm-colf-opt").forEach(function (o) {
      o.hidden = !!v && o.textContent.toLowerCase().indexOf(v) < 0;
    });
  });
  // the table scrolls in its own 15-row box, which would clip the menu: it floats above the page instead, under its
  // column, kept on screen
  function place(d) {
    var pop = d.querySelector(".adm-colf-pop"), s = d.querySelector("summary");
    if (!pop || !s) return;
    var r = s.getBoundingClientRect(), w = pop.offsetWidth || 300;
    pop.style.position = "fixed";
    pop.style.top = Math.round(r.bottom + 6) + "px";
    pop.style.left = Math.round(Math.max(8, Math.min(r.left - 6, window.innerWidth - w - 8))) + "px";
  }
  document.addEventListener("toggle", function (e) {
    var d = e.target;
    if (!d.classList || !d.classList.contains("adm-colf") || !d.open) return;
    document.querySelectorAll("details.adm-colf[open]").forEach(function (x) { if (x !== d) x.open = false; });
    place(d);
    var q = d.querySelector("[data-colf-q]");
    if (q) q.focus();
  }, true);
  window.addEventListener("scroll", function (e) {   // the page or the table moved: the menu would float off its column
    var t = e.target;
    document.querySelectorAll("details.adm-colf[open]").forEach(function (x) {
      if (!(t && t.nodeType === 1 && x.contains(t))) x.open = false;   // scrolling its own list keeps it open
    });
  }, true);
  document.addEventListener("click", function (e) {
    document.querySelectorAll("details.adm-colf[open]").forEach(function (x) { if (!x.contains(e.target)) x.open = false; });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    document.querySelectorAll("details.adm-colf[open]").forEach(function (x) {
      x.open = false; var s = x.querySelector("summary"); if (s) s.focus();
    });
  });
})();

/* The admin side panel (Chris, 2026-10-17, canvas "OneHR Admin Side Panels"; markup: templates/_adm_panel.html). A
   summary stays on the page and the change opens beside it: [data-panel-open="<key>"] opens .adm-panel[data-panel=key],
   and so do ?panel=<key> and data-panel-autoopen (a preview step comes back with its panel open). The bezel, Done /
   Cancel, the dimmed page and Esc close it, and focus goes back to the button that opened it. A modal panel makes the
   page behind inert; a `peek` one (a list's) leaves it clickable. data-panel-src loads a person's tab into the panel the
   first time it opens: its scripts run, a POST form in it carries the session token and panel=<key>, a `next` back to
   the person points where the panel is open, and a GET form or a link to the same tab reloads inside the panel.
   Phase 2, a person opened from a list: [data-person-open="<id>"] on a row's link loads that link's tab into the list's
   one "person" panel (?panel=person&pp=<id>), the row marked, Previous / Next stepping through the rows on the page; a
   form in it carries panel_back (this list's address), so its save comes back here with the panel open. */
(function () {
  var cur = null, opener = null, scrim = null, inerted = [];
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function key(p) { return p.getAttribute("data-panel"); }
  function find(k) { return k ? document.querySelector('.adm-panel[data-panel="' + String(k).replace(/[^\w-]/g, "") + '"]') : null; }
  // ---- Full width / Back to the side (Chris, 2026-11-04) -------------------------------------------------------
  // every panel carries a toggle in its head; the choice is kept per panel key in localStorage (onehr.panel.max.<key>) and
  // applied whenever that panel opens. Storage can be blocked or empty: every read and write is guarded, the page works without.
  var MAX_KEY = "onehr.panel.max.";
  function maxGet(k) { try { return window.localStorage.getItem(MAX_KEY + k) === "1"; } catch (e) { return false; } }
  function maxSet(k, on) { try { if (on) window.localStorage.setItem(MAX_KEY + k, "1"); else window.localStorage.removeItem(MAX_KEY + k); } catch (e) {} }
  function maxApply(p, on) {
    p.classList.toggle("is-max", !!on);
    var b = p.querySelector("[data-panel-max]"); if (!b) return;
    var say = on ? "Back to the side" : "Full width";
    b.setAttribute("aria-pressed", on ? "true" : "false"); b.setAttribute("aria-label", say); b.setAttribute("title", say);
  }
  // ---- keep the place after a save from inside a panel (Chris, 2026-11-04) --------------------------------------
  // A POST from a form in a panel reloads the page and the panel reopens at the top. Just before it goes, the panel body's
  // scroll and each table's scroll are put in sessionStorage; the same panel reopening on the same page within 2 minutes
  // puts them back (once). Hooks: the submit event in the BUBBLE phase (base.html's data-confirm handler stops the first,
  // unconfirmed submit at the capture phase, so only a real one gets here: a plain form, or the replay after OK), and
  // HTMLFormElement.submit() itself (a data-prompt or date prompt, the line-manager check: they send with form.submit(),
  // which fires no submit event).
  var SCROLL_KEY = "onehr.panel.scroll", SCROLL_MS = 120000;
  function scrollSave(f) {
    try {
      var p = f && f.closest && f.closest(".adm-panel");
      if (!p || (f.getAttribute("method") || "get").toLowerCase() !== "post") return;
      var body = slotOf(p), tabs = [];
      p.querySelectorAll(".table-scroll").forEach(function (t) { tabs.push([t.scrollTop, t.scrollLeft]); });
      window.sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ path: location.pathname, panel: key(p), src: p._src || "",
        body: body ? body.scrollTop : 0, tables: tabs, at: Date.now() }));
    } catch (e) {}
  }
  function scrollPut(p, d) {
    var body = slotOf(p); if (body) body.scrollTop = d.body || 0;
    var tabs = p.querySelectorAll(".table-scroll");
    (d.tables || []).forEach(function (v, i) { if (tabs[i]) { tabs[i].scrollTop = v[0] || 0; tabs[i].scrollLeft = v[1] || 0; } });
  }
  function scrollRestore(p) {
    var d = null;
    try { d = JSON.parse(window.sessionStorage.getItem(SCROLL_KEY) || "null"); } catch (e) { d = null; }
    if (!d) return;
    if (Date.now() - (d.at || 0) > SCROLL_MS || d.path !== location.pathname) { try { window.sessionStorage.removeItem(SCROLL_KEY); } catch (e) {} return; }
    if (d.panel !== key(p) || (d.src || "") !== (p._src || "")) return;   // another panel, or a list not yet at the person it held
    try { window.sessionStorage.removeItem(SCROLL_KEY); } catch (e) {}
    scrollPut(p, d);
    // once more when the table has settled and after the browser's own #group-<id> jump (it lands at load)
    var again = function () { if (cur === p) scrollPut(p, d); };
    setTimeout(again, 120);
    if (document.readyState !== "complete") window.addEventListener("load", function () { setTimeout(again, 0); }, { once: true });
  }
  document.addEventListener("submit", function (e) { if (!e.defaultPrevented) scrollSave(e.target); });
  try {
    var nativeSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () { scrollSave(this); return nativeSubmit.apply(this, arguments); };
  } catch (e) {}
  function topOf() { var t = document.querySelector(".topbar"); return t ? Math.max(0, Math.round(t.getBoundingClientRect().bottom)) : 0; }
  function isPerson(p) { return p && key(p) === "person"; }
  function isList(p) { return p && key(p) === "list"; }
  function listPersonMode(p) { return isList(p) && p._mode === "person"; }
  // the address is the page the panels belong to (data-panel-home): a preview step renders at its POST route, which a
  // refresh or a shared link can't GET. A list's person panel adds pp=<id>.
  function setUrl(k, pp, drop) {
    try {
      var home = document.querySelector("[data-panel-home]"), u = new URL(location.href);
      if (home && u.pathname !== home.getAttribute("data-panel-home")) u = new URL(home.getAttribute("data-panel-home") + u.hash, location.href);
      if (k) u.searchParams.set("panel", k); else u.searchParams.delete("panel");
      if (pp) u.searchParams.set("pp", pp); else u.searchParams.delete("pp");
      // the list panel (2026-10-20) also says which list: ls=<its address>, so a reload or a save comes back to it
      var lp = k === "list" ? find("list") : null;
      if (lp && lp._list) u.searchParams.set("ls", lp._list.src); else u.searchParams.delete("ls");
      // a closing panel drops what opened it: its preview's parameters, and a #id inside it (phase 3)
      if (drop) {
        (drop.getAttribute("data-panel-params") || "").split(/\s+/).forEach(function (q) { if (q) u.searchParams.delete(q); });
        var t = u.hash.length > 1 && document.getElementById(decodeURIComponent(u.hash.slice(1)));
        if (t && drop.contains(t)) u.hash = "";
      }
      history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    } catch (e) {}
  }
  // everything outside the panel goes inert while it is open: each ancestor's other children, up to <body>
  function lock(p) {
    inerted = [];
    for (var n = p; n && n !== document.body; n = n.parentElement) {
      var par = n.parentElement; if (!par) break;
      [].forEach.call(par.children, function (el) {
        // the confirm box, and a table's column menu (colmenu.js puts it on <body>), stay live over the panel
        if (el === n || el === scrim || el.inert || el.tagName === "SCRIPT" || el.classList.contains("modal-overlay")
            || el.classList.contains("col-menu")) return;
        el.inert = true; inerted.push(el);
      });
    }
    document.documentElement.classList.add("adm-panel-lock");
  }
  function unlock() {
    inerted.forEach(function (el) { el.inert = false; }); inerted = [];
    document.documentElement.classList.remove("adm-panel-lock");
  }
  function open(p, from, pp) {
    if (!p) return;
    if (cur === p) return;
    if (cur) close(true);
    cur = p; opener = from || null;
    maxApply(p, maxGet(key(p)));
    if (isList(p) && !p._bk && typeof window.onehrBackLayer === "function") p._bk = window.onehrBackLayer(function () { p._bk = null; if (cur === p) close(); });   // the phone's back gesture closes the list panel (static/move_in.js)
    var peek = p.hasAttribute("data-panel-peek"), top = topOf() + "px";
    p.style.top = top;
    if (!peek) {
      if (!scrim) {
        scrim = document.createElement("div"); scrim.className = "adm-panel-scrim"; scrim.setAttribute("aria-hidden", "true");
        scrim.addEventListener("click", function () { close(); });
      }
      p.parentNode.insertBefore(scrim, p);
      scrim.style.top = top; scrim.hidden = false;
    }
    p.hidden = false;
    void p.offsetWidth;   // the slide starts from off screen (no rAF: a hidden pane doesn't run one)
    p.classList.add("is-on"); if (!peek) scrim.classList.add("is-on");
    if (!peek) lock(p);
    setUrl(key(p), pp);
    p._back = location.pathname + location.search;
    var hs = from && from.tagName === "A" && from.hash.length > 1 ? from.hash : "";
    if (p.hasAttribute("data-panel-src") && !p._loaded) load(p, p.getAttribute("data-panel-src"), hs);
    else if (hs) reveal(slotOf(p), hs);
    var h = p.querySelector(".adm-panel-h"); if (h) h.focus({ preventScroll: true });
    if (!p.hasAttribute("data-panel-src")) scrollRestore(p);   // a loaded panel puts it back once its body has come
  }
  function close(switching) {
    var p = cur; if (!p) return;
    cur = null;
    if (p._bk) { var pb = p._bk; p._bk = null; pb.done(); }
    p.classList.remove("is-on"); if (scrim) scrim.classList.remove("is-on");
    unlock();
    if (isPerson(p)) mark(null);
    if (isList(p)) { p._mode = "list"; p._list = null; }
    var done = function () {
      if (cur !== p) p.hidden = true;
      if (scrim && !cur) scrim.hidden = true;
    };
    if (reduce || switching) done(); else setTimeout(done, 240);
    if (!switching) {
      setUrl("", null, p);
      if (opener && document.contains(opener) && opener.focus) opener.focus({ preventScroll: true });
    }
    opener = null;
  }
  function slotOf(p) { return p.querySelector("[data-panel-slot]") || p.querySelector(".adm-panel-body"); }
  // where the loaded tab lives: its path (the person's page) and its tab
  function srcOf(p) {
    try { var u = new URL(p._src || p.getAttribute("data-panel-src") || location.href, location.href);
      return { path: u.pathname, tab: u.searchParams.get("tab") || "overview" }; } catch (e) { return { path: location.pathname, tab: "" }; }
  }
  // the #id inside a panel a link pointed at: a <details> opens, and it scrolls into view
  function reveal(slot, hash) {
    var id = (hash || "").slice(1), t = null;
    try { t = id && document.getElementById(decodeURIComponent(id)); } catch (e) {}
    if (!t || !slot.contains(t)) return false;
    if (t.tagName === "DETAILS") t.open = true;
    t.scrollIntoView({ block: "start" });
    return true;
  }
  function load(p, src, hash, done) {
    var slot = slotOf(p), u;
    try { u = new URL(src, location.href); } catch (e) { return; }
    u.searchParams.set("fragment", "1");
    p._loaded = true; p._src = u.pathname + u.search; p.setAttribute("aria-busy", "true");
    // a list reloaded with a chip or a search (2026-11-03, Email › Sent) is still THAT list: Back from a person returns to it
    if (isList(p) && !listPersonMode(p) && p._list && u.pathname.indexOf("/admin/list/") === 0) {
      p._list.src = (u.pathname + u.search).replace(/([?&])fragment=1(&|$)/, "$1").replace(/[?&]$/, "");
      setUrl("list", null);
    }
    var want = p._src;
    fetch(u.pathname + u.search, { credentials: "same-origin", headers: { "X-Requested-With": "fetch" } })
      .then(function (r) { if (!r.ok || r.redirected) throw new Error(String(r.status)); return r.text(); })
      .then(function (html) {
        if (p._src !== want) return;   // Next was pressed again before this one came back
        slot.innerHTML = html;
        // the partials' own scripts run, as they do on the tab page
        slot.querySelectorAll("script").forEach(function (old) {
          var s = document.createElement("script");
          [].forEach.call(old.attributes, function (a) { s.setAttribute(a.name, a.value); });
          s.text = old.textContent; old.parentNode.replaceChild(s, old);
        });
        // a list's panel is headed by the person the fragment is about
        var who = slot.querySelector("[data-name]");
        var lst = isList(p) && !listPersonMode(p) ? slot.querySelector("[data-list-title]") : null;
        if (lst) listHead(p, lst);
        if (who && (isPerson(p) || listPersonMode(p))) {
          p.querySelector(".adm-panel-h").textContent = who.getAttribute("data-name");
          var sub = p.querySelector(".adm-panel-sub"); sub.textContent = who.getAttribute("data-sub") || ""; sub.hidden = !sub.textContent;
        }
        adopt(p, slot);
        p.removeAttribute("aria-busy");
        if (!reveal(slot, hash || location.hash)) slot.scrollTop = 0;
        if (cur === p) scrollRestore(p);
        if (done) done();
      })
      .catch(function () {
        if (p._src !== want) return;
        p._loaded = false; p.removeAttribute("aria-busy");
        u.searchParams.delete("fragment");
        slot.innerHTML = '<p class="muted">This didn\'t load. <a href="' + u.pathname + u.search + '">Open it as a page</a>.</p>';
      });
  }
  function hidden(f, name, value) {
    var i = f.querySelector('input[name="' + name + '"]');
    if (!i) { i = document.createElement("input"); i.type = "hidden"; i.name = name; f.appendChild(i); }
    i.value = value;
  }
  function adopt(p, root) {
    var k = key(p), here = srcOf(p).path, back = p._back || (location.pathname + location.search);
    var meta = document.querySelector('meta[name="csrf-token"]');
    root.querySelectorAll("form").forEach(function (f) {
      if ((f.getAttribute("method") || "get").toLowerCase() !== "post") return;
      // base.html stamps the session token on the forms there at load; these came later ("Session expired" without it)
      if (meta && !f.querySelector('input[name="csrf_token"]')) {
        var t = document.createElement("input"); t.type = "hidden"; t.name = "csrf_token"; t.value = meta.getAttribute("content");
        f.appendChild(t);
      }
      if (!f.querySelector('input[name="panel"]')) hidden(f, "panel", k);
      if (isPerson(p) || listPersonMode(p)) hidden(f, "panel_back", back);
      f.querySelectorAll('input[name="next"]').forEach(function (n) {
        var v = n.value || "", rest = v.slice(here.length);
        if (v.indexOf(here) === 0 && (!rest || rest[0] === "?" || rest[0] === "#")) {
          var at = v.indexOf("#");
          n.value = back + (at >= 0 ? v.slice(at) : "");
        }
      });
    });
    if (window.onehrPick) window.onehrPick(root); if (window.onehrChooseNew) window.onehrChooseNew(root);
    if (window.onehrTableStandard) root.querySelectorAll("table.admin-table").forEach(function (t) {
      if (!t.closest(".col-menu, .no-auto-table-zone")) window.onehrTableStandard(t);
    });
  }
  // ---- a count opens its people (Chris, 2026-10-20, canvas "OneHR Admin Counts Open Panels") -----------------------
  // [data-list-open="<the list's ?fragment=1 address>"] on a tile loads that list into the page's one "list" panel,
  // headed by what the list says it is; a person in it opens in the SAME panel with Back and Previous / Next through
  // the list; their tab's forms carry panel_back (?panel=list&ls=<list>&pp=<id>), so a save comes back here, the list
  // and the person open again, the count on the page fresh.
  function kicker(p, text) {
    var k = p.querySelector(".adm-panel-k"); if (!k) return;
    var tn = k.firstChild && k.firstChild.nodeType === 3 ? k.firstChild : k.insertBefore(document.createTextNode(""), k.firstChild);
    tn.nodeValue = text || "";
  }
  function listHead(p, el) {
    var t = el.getAttribute("data-list-title") || "", sub = p.querySelector(".adm-panel-sub");
    kicker(p, el.getAttribute("data-list-kicker"));
    p.querySelector(".adm-panel-h").textContent = t;
    sub.textContent = el.getAttribute("data-list-sub") || ""; sub.hidden = !sub.textContent;
    var full = p.querySelector("[data-list-page]");
    if (full) { full.setAttribute("href", el.getAttribute("data-list-full") || "#"); full.textContent = el.getAttribute("data-list-full-label") || "Open as a full page \u2197"; full.hidden = false; }   // (the team panel's bar hides it while people are ticked, 2026-11-09)
    var n = el.getAttribute("data-list-n"), bl = p.querySelector("[data-list-backlabel]");
    if (bl) bl.textContent = n ? "Back to the " + Number(n).toLocaleString() : "Back to the list";
    p._list.title = t;
    // a list that steps (Email > Schedule's day panel, 2026-11-09): its arrow buttons load the previous / next list, say "day" not "person"
    var sp = el.getAttribute("data-step-prev"), sn = el.getAttribute("data-step-next"), sw = el.getAttribute("data-step-label") || "person";
    p._step = sp || sn ? { prev: sp || "", next: sn || "" } : null;
    var pv = p.querySelector("[data-panel-prev]"), nx = p.querySelector("[data-panel-next]");
    if (pv) { pv.disabled = !(sp); pv.setAttribute("aria-label", "Previous " + sw); }
    if (nx) { nx.disabled = !(sn); nx.setAttribute("aria-label", "Next " + sw); }
    // the foot's own controls (Email > Schedule, 2026-11-09): a <template data-list-foot> in the list puts its buttons in the panel's foot before
    // Done ("+ Add an email on <day>", Cancel and Save the email); data-list-foot-replace hides Done while they are there. Cleared on every load.
    var foot = p.querySelector(".adm-panel-foot");
    if (foot) {
      [].slice.call(foot.querySelectorAll("[data-list-footx]")).forEach(function (n) { n.remove(); });
      foot.classList.remove("is-lmt-bar");   // the team panel's bar (static/lm_team.js) ends with its list
      var done = foot.querySelector(".primary[data-panel-close]"), ft = el.querySelector("template[data-list-foot]");
      if (done) done.hidden = false;
      if (ft) {
        [].slice.call(ft.content.cloneNode(true).children).forEach(function (n) {
          n.setAttribute("data-list-footx", ""); foot.insertBefore(n, done || null);
        });
        if (done && ft.hasAttribute("data-list-foot-replace")) done.hidden = true;
      }
    }
    // the list this one was opened from (a day's People >): Back returns to it
    var br = p.querySelector("[data-list-backrow]");
    if (br && p._ret && p._list.src !== p._ret.src) {
      br.hidden = false;
      if (bl) bl.textContent = p._ret.label;
    }
  }
  function listMode(p) {
    p._mode = "list"; p._uid = null;
    var br = p.querySelector("[data-list-backrow]"); if (br) br.hidden = true;
    var pos = p.querySelector(".adm-panel-pos"); if (pos) pos.textContent = "";
    var pv = p.querySelector("[data-panel-prev]"), nx = p.querySelector("[data-panel-next]");
    if (pv) pv.disabled = true; if (nx) nx.disabled = true;
  }
  function listRows(p) {   // the people in the loaded list, in the order it shows them (a sorted table re-reads)
    var seen = {}, out = [];
    slotOf(p).querySelectorAll("[data-person-open]").forEach(function (a) {
      var id = a.getAttribute("data-person-open");
      if (!seen[id]) { seen[id] = 1; out.push({ id: id, href: a.getAttribute("href") }); }
    });
    return out;
  }
  function openList(src, from, then) {
    var p = find("list"); if (!p || !src || src.indexOf("/admin/list/") !== 0) return;
    p._list = { src: src.replace(/([?&])fragment=1(&|$)/, "$1").replace(/[?&]$/, "") };
    p._rows = null; p._ret = null; p._step = null; listMode(p);
    if (cur !== p) open(p, from || null); 
    setUrl("list", null);
    p._back = location.pathname + location.search;
    load(p, p._list.src, "", then);
  }
  function listPerson(p, id, a, focusHead) {
    if (!p._rows || p._mode !== "person") p._rows = listRows(p);
    var ix = -1; p._rows.forEach(function (r, i) { if (r.id === String(id)) ix = i; });
    if (ix < 0) return;
    p._mode = "person"; p._uid = String(id);
    var br = p.querySelector("[data-list-backrow]"); if (br) br.hidden = false;
    var pos = p.querySelector(".adm-panel-pos"); if (pos) pos.textContent = " · " + (ix + 1) + " of " + p._rows.length;
    var pv = p.querySelector("[data-panel-prev]"), nx = p.querySelector("[data-panel-next]");
    if (pv) pv.disabled = ix <= 0; if (nx) nx.disabled = ix >= p._rows.length - 1;
    kicker(p, p._list && p._list.title ? p._list.title : "");
    var full = p.querySelector("[data-list-page]");
    if (full) { full.setAttribute("href", p._rows[ix].href); full.textContent = "Open their full page \u2197"; }
    setUrl("list", id);
    p._back = location.pathname + location.search;
    load(p, p._rows[ix].href);
    if (focusHead) { var h = p.querySelector(".adm-panel-h"); if (h) h.focus({ preventScroll: true }); }
  }
  function listBack(p) {
    if (!p._list) return;
    // from a day's People > the Back goes to the day, not to the run's own list
    if (!listPersonMode(p) && p._ret && p._list.src !== p._ret.src) {
      var r = p._ret; p._ret = null; p._list.src = r.src;
      listMode(p); setUrl("list", null); p._back = location.pathname + location.search;
      load(p, r.src);
      return;
    }
    listMode(p); setUrl("list", null); p._back = location.pathname + location.search;
    load(p, p._list.src);
  }
  function listStep(p, d) {
    if (!p._rows) return;
    var ix = -1; p._rows.forEach(function (r, i) { if (r.id === p._uid) ix = i; });
    var r = p._rows[ix + d]; if (r) listPerson(p, r.id, null, false);
  }
  // ---- a person opened from a list ------------------------------------------------------------------------------
  function rows() {   // one entry a person, in the order the list shows them (a sorted table re-reads its rows)
    var seen = {}, out = [];
    document.querySelectorAll("[data-person-open]").forEach(function (a) {
      if (a.closest(".adm-panel")) return;
      var id = a.getAttribute("data-person-open");
      if (!seen[id]) { seen[id] = 1; out.push(a); }
    });
    return out;
  }
  function rowOf(a) { return a && (a.closest("tr, .fb-grid, [data-person-row]") || a); }
  function mark(id) {
    document.querySelectorAll(".is-peek-row").forEach(function (r) { r.classList.remove("is-peek-row"); });
    document.querySelectorAll("[data-person-open][aria-current]").forEach(function (a) { a.removeAttribute("aria-current"); });
    if (!id) return;
    document.querySelectorAll('[data-person-open="' + id + '"]').forEach(function (a) {
      if (a.closest(".adm-panel")) return;
      a.setAttribute("aria-current", "true"); rowOf(a).classList.add("is-peek-row");
    });
  }
  function openPerson(id, from, focusHead) {
    var p = find("person"); if (!p || !id) return;
    var list = rows(), ix = -1;
    list.forEach(function (a, i) { if (a.getAttribute("data-person-open") === String(id)) ix = i; });
    var a = from || list[ix], src = a ? a.getAttribute("href") : "/admin/users/" + encodeURIComponent(id);
    p._uid = String(id);
    if (cur !== p) open(p, from || null, id); else setUrl("person", id);
    p._back = location.pathname + location.search;
    var pos = p.querySelector(".adm-panel-pos");
    if (pos) pos.textContent = ix >= 0 ? " · " + (ix + 1) + " of " + list.length + " on this page" : "";
    var pv = p.querySelector("[data-panel-prev]"), nx = p.querySelector("[data-panel-next]");
    if (pv) pv.disabled = ix <= 0;
    if (nx) nx.disabled = ix < 0 || ix >= list.length - 1;
    var page = p.querySelector("[data-person-page]");
    if (page) page.setAttribute("href", src);
    mark(id);
    load(p, src);
    if (a && ix >= 0) { var r = rowOf(a); if (r.scrollIntoView) r.scrollIntoView({ block: "nearest" }); }
    if (focusHead) { var h = p.querySelector(".adm-panel-h"); if (h) h.focus({ preventScroll: true }); }
  }
  function step(d) {
    if (listPersonMode(cur)) { listStep(cur, d); return; }
    if (isList(cur) && cur._step) {   // the day panel: another day, same panel
      var to = d < 0 ? cur._step.prev : cur._step.next;
      cur._ret = null;
      if (to) load(cur, to);
      return;
    }
    var p = find("person"); if (!p || cur !== p) return;
    var list = rows(), ix = -1;
    list.forEach(function (a, i) { if (a.getAttribute("data-person-open") === p._uid) ix = i; });
    var a = list[ix + d]; if (a) openPerson(a.getAttribute("data-person-open"), a, false);
  }
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button) return;
    var mx = e.target.closest && e.target.closest("[data-panel-max]");
    if (mx) {
      var mp = mx.closest(".adm-panel");
      if (mp) { e.preventDefault(); var on = !mp.classList.contains("is-max"); maxApply(mp, on); maxSet(key(mp), on); }
      return;
    }
    var lo = e.target.closest && e.target.closest("[data-list-open]");
    // a whole row that opens its list (Leaders > BU CEOs): a click on a button, link or field inside it is that control's own
    if (lo && lo.tagName === "TR" && e.target.closest("a, button, input, select, textarea, label, summary, .col-menu")) lo = null;
    // a link inside another side panel opens the list only when it opts in (the Roles panel's LM / HOD counts, 2026-11-06)
    if (lo && (!lo.closest(".adm-panel") || (lo.hasAttribute("data-list-from-panel") && lo.closest(".adm-panel") !== find("list"))) && find("list")) {
      if (lo.tagName === "A" && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) return;   // a new tab gets the page
      e.preventDefault(); openList(lo.getAttribute("data-list-open"), lo); return;
    }
    if (e.target.closest && e.target.closest("[data-list-back]") && isList(cur)) { e.preventDefault(); listBack(cur); return; }
    // a link inside the list that reloads the list itself with other parameters (a chip: ?show=failed): the same panel, no new tab
    var lr = e.target.closest && e.target.closest("[data-list-reload]");
    if (lr && isList(cur) && cur.contains(lr) && !listPersonMode(cur)) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      // data-list-keep="Back to Sat 14 Nov": this reload leaves a list the reader wants to come back to (the day panel's People >)
      if (lr.hasAttribute("data-list-keep") && cur._list) cur._ret = { src: cur._list.src, label: lr.getAttribute("data-list-keep") };
      e.preventDefault(); load(cur, lr.getAttribute("href")); return;
    }
    var po = e.target.closest && e.target.closest("[data-person-open]");
    if (po && isList(cur) && cur.contains(po)) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault(); listPerson(cur, po.getAttribute("data-person-open"), po, true); return;
    }
    if (po && !po.closest(".adm-panel") && find("person")) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;   // a new tab gets the page
      e.preventDefault(); openPerson(po.getAttribute("data-person-open"), po, true); return;
    }
    var sp = e.target.closest && e.target.closest("[data-panel-prev], [data-panel-next]");
    if (sp) { e.preventDefault(); step(sp.hasAttribute("data-panel-prev") ? -1 : 1); return; }
    var b = e.target.closest && e.target.closest("[data-panel-open]");
    if (b) {
      if (b.tagName === "A" && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) return;
      var p = find(b.getAttribute("data-panel-open"));
      if (p) { e.preventDefault(); open(p, b); }
      return;
    }
    var c = e.target.closest && e.target.closest("[data-panel-close]");
    if (c && cur && cur.contains(c)) { e.preventDefault(); close(); return; }
    // a link inside a loaded tab to the same tab (a search result, a cycle, a record) reloads in the panel
    var a = e.target.closest && e.target.closest("[data-panel-slot] a[href]");
    if (!a || a.target || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var pn = a.closest(".adm-panel"), u;
    if (!pn || !pn._src) return;
    try { u = new URL(a.href, location.href); } catch (er) { return; }
    var sr = srcOf(pn);
    if (u.origin !== location.origin || u.pathname !== sr.path || (u.searchParams.get("tab") || "overview") !== sr.tab) return;
    if (!u.searchParams.get("tab")) return;   // the person page itself (the summary's links) leaves the list
    e.preventDefault(); load(pn, u.pathname + u.search, u.hash);
  });
  document.addEventListener("submit", function (e) {
    var f = e.target, p = f.closest && f.closest(".adm-panel");
    if (!p || !p._src || e.defaultPrevented || (f.getAttribute("method") || "get").toLowerCase() !== "get") return;
    e.preventDefault();
    var sr = srcOf(p), u = new URL(f.getAttribute("action") || sr.path, location.href);
    u.search = new URLSearchParams(new FormData(f)).toString();
    if (u.pathname === sr.path && !u.searchParams.get("tab") && !(isList(p) && !listPersonMode(p))) u.searchParams.set("tab", sr.tab);
    load(p, u.pathname + u.search);
  });
  // Esc closes the panel only when nothing inside it is open: the confirm box, a column menu, a people picker's list.
  // In the capture phase, so it sees them before their own Esc closes them.
  var POPUPS = ".modal-overlay, .col-menu:not([hidden]), .pick-list:not([hidden]), .ld-results:not([hidden]), " +
               "details.adm-colf[open], .pp-sug:not([hidden])";
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || !cur || document.querySelector(POPUPS)) return;
    e.preventDefault(); close();
  }, true);
  window.addEventListener("resize", function () {
    if (!cur) return;
    var top = topOf() + "px"; cur.style.top = top; if (scrim) scrim.style.top = top;
  });
  function flashInto(p) {   // what the last step said shows in the panel too, not only on the page behind it
    var head = p.querySelector(".adm-panel-head");
    [].slice.call(document.querySelectorAll("main .flash")).reverse().forEach(function (f) {
      var c = f.cloneNode(true); c.classList.add("adm-panel-flash"); c.removeAttribute("role"); c.removeAttribute("aria-live");
      head.insertAdjacentElement("afterend", c);
    });
  }
  function boot() {
    // a form in an item panel says which panel it came from, so a failed step (or a Roles change) comes back to it
    document.querySelectorAll(".adm-panel:not([data-panel-src]) form").forEach(function (f) {
      if ((f.getAttribute("method") || "get").toLowerCase() !== "post" || f.querySelector('input[name="panel"]')) return;
      hidden(f, "panel", key(f.closest(".adm-panel")));
    });
    var q = null;
    try { q = new URL(location.href).searchParams; } catch (e) {}
    var want = q && q.get("panel");
    if (want === "person" && q.get("pp") && find("person")) { flashInto(find("person")); openPerson(q.get("pp"), null, true); return; }
    // a list panel (and the person in it) comes back after a reload or a save (2026-10-20)
    if (want === "list" && (q.get("ls") || "").indexOf("/admin/list/") === 0 && find("list")) {
      var lp = find("list"), pp = q.get("pp");
      flashInto(lp);
      openList(q.get("ls"), null, pp ? function () { listPerson(lp, pp, null, true); } : null);
      return;
    }
    var p = document.querySelector(".adm-panel[data-panel-autoopen]") || (want !== "person" && find(want));
    // an older link to the person page's #roles or #account opens that panel
    if (!p && /^#(roles|account)$/.test(location.hash)) p = find(location.hash.slice(1));
    // a save that lands on #<id> of something inside a panel (a calibration group's #group-<id>) opens it again
    if (!p && location.hash.length > 1) {
      var tg = null; try { tg = document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch (e) {}
      p = tg && tg.closest(".adm-panel[data-panel]");
    }
    if (!p) return;
    flashInto(p);
    open(p, null);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  window.onehrPanel = { open: function (k, from) { open(find(k), from); }, close: function () { close(); },
                        person: function (id) { openPerson(id, null, true); },
                        adopt: function (root) { var pn = root && root.closest && root.closest(".adm-panel"); if (pn && pn._src) adopt(pn, root); },
                        list: function (src) { openList(src, null); } };
})();

// View only (Chris, 2026-10-19: "BG and BU admins will only have view access to the admin portal"; they "can view and
// download the reports"). For them every form that changes something loses its buttons and its fields go read only;
// filters (GET forms), links and downloads are untouched, and a proposal form (data-viewonly-ok) still sends. The
// server refuses their writes whatever the page shows (admin_required). Forms a panel loads later are caught too.
// An admin whose role gives some changes (data-adm-access, window.ADM_ACCESS: their role's items and every admin
// write route's rule; Roles & access, 2026-10-20) keeps the forms their role covers; a form doing several things (its `action`) keeps
// only the buttons and choices they may use.
(function () {
  var main = document.getElementById('main');
  if (!main) return;
  var acc = main.hasAttribute('data-adm-access') ? window.ADM_ACCESS : null;
  if (!main.hasAttribute('data-adm-viewonly') && !acc) return;
  var routes = acc ? acc.routes.map(function (r) { return [new RegExp(r[0]), r[1]]; }) : [];
  function can(spec) {
    if (spec === 'always') return true;
    if (spec === 'lms') return !!(acc && acc.lms);
    if (!acc || !spec || !Array.isArray(spec)) return false;
    // their role's items (Roles & access, 2026-10-20): ["items", [item, ...]] needs every one
    if (spec[0] === 'items') return spec[1].every(function (k) { return (acc.items || []).indexOf(k) >= 0; });
    return false;
  }
  function specOf(f) {
    if (!acc) return 'super';
    var pn = f.closest('.adm-panel'), base = (pn && pn._src) || location.href, path;
    try { path = new URL(f.getAttribute('action') || base, location.href).pathname; } catch (e) { return 'super'; }
    for (var i = 0; i < routes.length; i++) if (routes[i][0].test(path)) return routes[i][1];
    return 'super';
  }
  function pick(spec, v) {   // a rule per action -> this action's rule
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec;
    v = String(v || '').split(':')[0];
    return Object.prototype.hasOwnProperty.call(spec.m, v) ? spec.m[v] : spec.d;
  }
  function isSubmit(el) { return (el.tagName === 'BUTTON' && el.getAttribute('type') !== 'button') || el.type === 'submit'; }
  function offBtn(b) { b.disabled = true; b.classList.add('is-viewonly-btn'); }
  // whether the form may still send, switching off the buttons and choices it may not use
  function allowed(f) {
    var spec = specOf(f);
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return can(spec);
    var els = [].slice.call(f.elements).concat([].slice.call(document.querySelectorAll('[form="' + (f.id || '\u0000') + '"]')));
    var named = els.filter(function (el) { return el.name === spec.f; }), any = false, field = false;
    named.forEach(function (el) {
      if (isSubmit(el)) {
        if (can(pick(spec, el.value))) any = true; else offBtn(el);
      } else if (el.tagName === 'SELECT') {
        field = true;
        [].forEach.call(el.options, function (o) { if (can(pick(spec, o.value))) any = true; else o.disabled = true; });
      } else if (el.type === 'radio') {
        field = true;
        if (can(pick(spec, el.value))) any = true; else el.disabled = true;
      } else {
        field = true;
        if (can(pick(spec, el.value))) any = true;
      }
    });
    return named.length ? any : can(spec.d);
  }
  function lockForm(f) {
    f.classList.add('is-viewonly');
    Array.prototype.forEach.call(f.elements, function (el) {
      // a plain button only opens or folds something on the page: it stays. One that sends the form by script
      // (data-sends: an import's Preview, Participants' Add / Take out; QC 2026-10-24) goes like a submit button.
      if (el.type === 'hidden' || (el.tagName === 'BUTTON' && el.getAttribute('type') === 'button'
                                   && !el.hasAttribute('data-sends'))) return;
      el.disabled = true;
      if (el.hasAttribute('data-sends')) el.classList.add('is-viewonly-btn');
    });
  }
  // The page's own chrome is never an admin write (Chris, 2026-11-03: "the log out button disappears from the CHCE bghr
  // admin page"). Log out has been a POST form in the top bar's Account menu since 31 Oct, so the lock below hid it for every
  // admin but the super and system admin. The top bar holds only the Account menu, the cycle switch and staging's demo
  // controls; the Help panel's report form, the Admin Agent's form and the sign-out the idle box builds are not POST forms
  // the lock reads (or only submit by script). Admin content, list panels (.adm-panel) and #main stay locked as before.
  var CHROME = '.topbar';
  function lock(root) {
    var forms = (root.matches && root.matches('form')) ? [root] : root.querySelectorAll ? root.querySelectorAll('form') : [];
    Array.prototype.forEach.call(forms, function (f) {
      if ((f.getAttribute('method') || 'get').toLowerCase() !== 'post' || f.closest('[data-viewonly-ok]') || f.closest(CHROME)) return;
      if (f.classList.contains('is-viewonly') || f.hasAttribute('data-adm-ok')) return;
      if (acc && allowed(f)) { f.setAttribute('data-adm-ok', ''); return; }
      lockForm(f);
    });
    // a control outside its form (form="…") follows that form: a button goes, a box or field stays to be read
    // (the leader progress page's ticks sit in their own cards, 2026-10-19)
    Array.prototype.forEach.call(document.querySelectorAll('button[form], input[form], select[form], textarea[form]'),
      function (b) {
        if (!b.form || !b.form.classList.contains('is-viewonly')) return;
        b.disabled = true;
        if (b.tagName === 'BUTTON' || b.type === 'submit') b.classList.add('is-viewonly-btn');
      });
  }
  lock(document);
  if (window.MutationObserver) {
    new MutationObserver(function (muts) {
      muts.forEach(function (m) { Array.prototype.forEach.call(m.addedNodes, function (n) { if (n.nodeType === 1) lock(n); }); });
    }).observe(document.body, { childList: true, subtree: true });
  }
})();

/* The active menu item is never left behind the floating Back button (2026-10-28): on load, if it sits below the sidebar's
 * visible area (or under Back), the SIDEBAR scrolls (scrollTop, no animation) to bring it fully above Back. The page never moves. */
(function () {
  'use strict';
  function reveal() {
    var side = document.querySelector('.adm-side-in');
    var item = side && side.querySelector('.adm-side-item.is-active, .adm-side-grp.is-active');
    if (!item) return;
    var back = document.getElementById('floating-back');
    var floor = Math.min(window.innerHeight, back ? back.getBoundingClientRect().top : window.innerHeight) - 8;
    var r = item.getBoundingClientRect();
    if (r.bottom > floor) side.scrollTop += Math.ceil(r.bottom - floor);
    else if (r.top < side.getBoundingClientRect().top) side.scrollTop -= Math.ceil(side.getBoundingClientRect().top - r.top);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reveal); else reveal();
})();

/* The sidebar's groups (2026-10-28): a click on a group row opens its flyout, one at a time; a click outside, Esc, a resize or a
 * scroll of the sidebar closes it (Esc gives the focus back to the row). The flyout is fixed: 8px right of the sidebar, level
 * with the row (8px above it), kept inside the viewport.
 * PHONE VIEW, PIECE E (2026-11-08): under 1024px (window.onehrIsPhone(), static/move_in.js) the side menu is a bottom sheet the
 * Menu button opens (#adm-menu-open -> nav.adm-side.is-menu-open): a group opens IN PLACE under its row (no positioning, and a click or
 * scroll inside the sheet never closes it); the sheet closes with its x, the dim, Esc, choosing a page and the phone back gesture
 * (onehrBackLayer), keeps the focus inside while open (role="dialog" + aria-modal only then), and closes cleanly when the window
 * turns to a desktop width. The desktop path below the phone checks is the flyout exactly as before. */
(function () {
  'use strict';
  var nav = document.querySelector('.adm-side');
  if (!nav) return;
  var side = nav.querySelector('.adm-side-in');
  var openBtn = null;
  var menuBtn = document.getElementById('adm-menu-open');
  var scrim = document.getElementById('adm-menu-scrim');
  var xBtn = document.getElementById('adm-menu-close');
  var menuBk = null;   // the phone's back gesture closes the sheet first (static/move_in.js, onehrBackLayer)
  function phone() { return typeof window.onehrIsPhone === 'function' && window.onehrIsPhone(); }
  function sheetOpen() { return nav.classList.contains('is-menu-open'); }
  function fly(btn) { return document.getElementById(btn.getAttribute('aria-controls')); }
  function place(btn, f) {
    var sr = nav.getBoundingClientRect(), br = btn.getBoundingClientRect();
    var h = f.offsetHeight, top = br.top - 8;
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    f.style.left = Math.round(sr.right + 8) + 'px';
    f.style.top = Math.round(top) + 'px';
  }
  function close(refocus) {
    if (!openBtn) return;
    var b = openBtn; openBtn = null;
    b.setAttribute('aria-expanded', 'false');
    fly(b).hidden = true;
    if (refocus) b.focus();
  }
  function open(btn) {
    close(false);
    var f = fly(btn);
    f.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    if (!phone()) place(btn, f);   // on a phone the group opens in place under its row: nothing to position
    openBtn = btn;
  }
  // ---- the phone's sheet ----
  function focusables() {
    return Array.prototype.filter.call(nav.querySelectorAll('a[href], button:not([disabled])'), function (el) { return el.offsetParent !== null; });
  }
  function openSheet() {
    if (!menuBtn || !phone() || sheetOpen()) return;
    nav.classList.add('is-menu-open');
    nav.setAttribute('role', 'dialog'); nav.setAttribute('aria-modal', 'true'); nav.setAttribute('aria-label', 'Admin menu');
    if (scrim) scrim.hidden = false;
    document.documentElement.classList.add('adm-menu-open');
    menuBtn.setAttribute('aria-expanded', 'true');
    var cur = nav.querySelector('.adm-side-grp[data-current="1"]');   // the group holding this page starts open
    if (cur) open(cur);
    var on = nav.querySelector('.adm-fly-row.is-active, .adm-side-item.is-active');
    if (on && side && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    if (typeof window.onehrBackLayer === 'function') menuBk = window.onehrBackLayer(function () { menuBk = null; closeSheet(true); });
    if (xBtn) xBtn.focus();
  }
  function closeSheet(refocus) {
    if (!sheetOpen()) return;
    var bk = menuBk; menuBk = null;
    nav.classList.remove('is-menu-open');
    nav.removeAttribute('role'); nav.removeAttribute('aria-modal');
    nav.setAttribute('aria-label', 'Admin');
    if (scrim) scrim.hidden = true;
    document.documentElement.classList.remove('adm-menu-open');
    if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
    close(false);
    if (bk) bk.done();
    if (refocus && menuBtn) menuBtn.focus();
  }
  if (menuBtn) menuBtn.addEventListener('click', function () { if (sheetOpen()) closeSheet(true); else openSheet(); });
  if (xBtn) xBtn.addEventListener('click', function () { closeSheet(true); });
  if (scrim) scrim.addEventListener('click', function () { closeSheet(true); });
  nav.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab' || !sheetOpen()) return;
    var f = focusables(); if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !nav.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !nav.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  });
  if (typeof window.onehrOnPhoneChange === 'function') window.onehrOnPhoneChange(function (p) {
    if (!p) closeSheet(false);
    close(false);   // a window crossed the line: no sheet (a desktop width), no group left open, the flyout is its own again
    Array.prototype.forEach.call(nav.querySelectorAll('.adm-fly'), function (f) { f.style.left = ''; f.style.top = ''; });
  });
  nav.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.adm-side-grp');
    if (!btn) return;
    e.preventDefault();
    if (openBtn === btn) close(false); else open(btn);
  });
  document.addEventListener('click', function (e) {
    if (!openBtn || phone()) return;   // a phone's groups stay open in the sheet until the person closes them
    if (e.target.closest && (e.target.closest('.adm-side-grp') || e.target.closest('.adm-fly'))) return;
    close(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (sheetOpen()) { e.preventDefault(); closeSheet(true); return; }
    if (openBtn) { e.preventDefault(); close(true); }
  });
  window.addEventListener('resize', function () { if (!phone()) close(false); });
  if (side) side.addEventListener('scroll', function () { if (!phone()) close(false); });
})();

/* A person's AI insight (Chris, 2026-11-06): the seat switch shows blocks already drawn; the panel's part tabs load that part's
   block (the server reads the cache, never the model); a Read link points the one panel at its own part before it opens.
   Delegated, so it works in a panel's fetched content and on a tab's card alike. */
(function () {
  function pick(btn) {
    var root = btn.closest("[data-ais-root]");
    if (!root) return;
    var key = btn.getAttribute("data-ais-pick");
    root.querySelectorAll("[data-ais-pick]").forEach(function (b) {
      var on = b === btn;
      b.classList.toggle("is-on", on); b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    root.querySelectorAll("[data-ais-seat]").forEach(function (s) { s.hidden = s.getAttribute("data-ais-seat") !== key; });
  }
  function syncFoot(panel, root) {
    var a = panel && panel.querySelector("[data-ais-open]");
    if (a && root && root.getAttribute("data-open-href")) {
      a.setAttribute("href", root.getAttribute("data-open-href")); a.textContent = root.getAttribute("data-open-label") || a.textContent;
    }
  }
  document.addEventListener("click", function (e) {
    var t = e.target.closest && e.target.closest("[data-ais-pick]");
    if (t) { e.preventDefault(); pick(t); return; }
    var tab = e.target.closest && e.target.closest("[data-ais-tab]");
    if (tab) {
      e.preventDefault();
      var root = tab.closest(".ais-panel"), panel = tab.closest(".adm-panel");
      if (!root) return;
      root.setAttribute("aria-busy", "true");
      fetch(tab.getAttribute("data-ais-tab"), { credentials: "same-origin", headers: { "X-Requested-With": "fetch" } })
        .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
        .then(function (html) {
          var tmp = document.createElement("div"); tmp.innerHTML = html;
          var fresh = tmp.querySelector(".ais-panel");
          if (!fresh) throw new Error("no block");
          root.replaceWith(fresh); syncFoot(panel, fresh);
        })
        .catch(function () { root.removeAttribute("aria-busy"); });
    }
  });
  // a Read link on the Overview points the panel at its part, before admin.js opens it (capture phase)
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("[data-ais-src]");
    if (!a) return;
    var p = document.getElementById("pnl-insight");
    if (!p) return;
    var want = a.getAttribute("data-ais-src");
    if (p.getAttribute("data-panel-src") !== want) { p.setAttribute("data-panel-src", want); p._loaded = false; }
    var m = /[?&]part=(\w+)/.exec(want), tabs = { pm: ["performance", "Performance"], tc: ["competency", "Competency"],
                                                 idp: ["plan", "Career Plan"], pot: ["f360", "360 Feedback"] };
    var foot = p.querySelector("[data-ais-open]");
    if (foot && m && tabs[m[1]]) {
      foot.setAttribute("href", foot.getAttribute("href").replace(/tab=\w+/, "tab=" + tabs[m[1]][0]));
      foot.textContent = "Open the " + tabs[m[1]][1] + " tab";
    }
  }, true);
  document.querySelectorAll("#pnl-insight .ais-panel").forEach(function (r) { syncFoot(r.closest(".adm-panel"), r); });
})();


/* Roles suggested for one person (Chris, 2026-11-07; person page > Career Plan, super admin only): "+ Suggest a role" opens
   the strict role picker in place. Same look and rules as the people picker above (.pick, .pick-q, .pick-list, hidden
   .pick-val; typed text that isn't a pick sends nothing), but its list is the roles the page carries as JSON
   (templates/person/_suggest_roles.html: active architecture roles from the person's grade to two up, each with its skills
   match), searched here by title or job code, so nothing is fetched. Rows that can't be suggested are greyed with
   the reason and can't be picked. The form's confirm text names the role once one is picked. Delegated, so a Career Plan
   opened in a list's side panel works too. */
(function () {
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  var CHOOSE = "Choose a role from the list: type a title or job code, then pick it.";
  var SHOWN = 40;
  function setup(form) {
    if (form._rpick) return form._rpick;
    var box = form.querySelector("[data-rpick]"), q = box && box.querySelector(".pick-q"), val = box && box.querySelector(".pick-val");
    var dataEl = form.querySelector(".sg-data"), go = form.querySelector("[data-rpick-go]");
    if (!q || !val || !dataEl) return null;
    var data = {}; try { data = JSON.parse(dataEl.textContent || "{}") || {}; } catch (e) { data = {}; }
    var roles = data.roles || [], range = data.range || "";
    var list = document.createElement("ul"), id = "rpick-" + Math.floor(Math.random() * 1e9), shown = [], active = -1;
    list.className = "pick-list"; list.id = id; list.setAttribute("role", "listbox"); list.hidden = true;
    box.appendChild(list);
    q.setAttribute("role", "combobox"); q.setAttribute("aria-autocomplete", "list"); q.setAttribute("aria-expanded", "false");
    q.setAttribute("aria-controls", id);
    var name = form.getAttribute("data-name") || "them";
    function close() { list.hidden = true; q.setAttribute("aria-expanded", "false"); active = -1; }
    function check() {
      q.setCustomValidity(q.value.trim() && !val.value ? CHOOSE : "");
      if (go) go.disabled = !val.value;
    }
    function mark() {
      [].forEach.call(list.querySelectorAll("li[role=option]"), function (li) {
        var on = +li.getAttribute("data-i") === active; li.classList.toggle("is-on", on); li.setAttribute("aria-selected", on ? "true" : "false");
      });
    }
    function render() {
      var terms = q.value.toLowerCase().split(/\s+/).filter(Boolean);
      var hits = roles.filter(function (r) {
        var hay = (r.title + " " + r.code + " " + (r.fam || "")).toLowerCase();
        return terms.every(function (t) { return hay.indexOf(t) >= 0; });
      });
      shown = hits.slice(0, SHOWN);
      list.innerHTML = "";
      if (range) { var g = document.createElement("li"); g.className = "pick-grp"; g.textContent = range + ", their grade to two up"; list.appendChild(g); }
      if (!shown.length) { var n = document.createElement("li"); n.className = "pick-none"; n.textContent = "No role matches"; list.appendChild(n); }
      shown.forEach(function (r, i) {
        var li = document.createElement("li"); li.setAttribute("role", "option"); li.setAttribute("data-i", i);
        li.className = r.off ? "pick-off" : "";
        if (r.off) li.setAttribute("aria-disabled", "true");
        li.innerHTML = "<b>" + esc(r.title) + "</b> <span>· " + esc(r.code) + "</span><small>" +
          esc(r.off ? r.off : "JG " + r.grade + (r.fam ? " · " + r.fam : "") + " · " + r.match) + "</small>";
        if (!r.off) li.addEventListener("mousedown", function (e) { e.preventDefault(); choose(i); });
        list.appendChild(li);
      });
      if (hits.length > shown.length) {
        var more = document.createElement("li"); more.className = "pick-none";
        more.textContent = (hits.length - shown.length) + " more match: keep typing to narrow them"; list.appendChild(more);
      }
      list.hidden = false; q.setAttribute("aria-expanded", "true"); active = -1; mark();
    }
    function choose(i) {
      var r = shown[i]; if (!r || r.off) return;
      val.value = String(r.id); q.value = r.title + " · " + r.code;
      form.setAttribute("data-confirm", "Add " + r.title + " (JG " + r.grade + ") to " + name + "'s Career Plan? It shows to them as " +
        "Suggested by Group People, for them alone. Their job, their competencies and everyone else's plan stay as they are.");
      close(); check();
    }
    function step(d) {
      var i = active;
      do { i += d; } while (i >= 0 && i < shown.length && shown[i].off);
      if (i >= 0 && i < shown.length) { active = i; mark(); var el = list.querySelector('li[data-i="' + i + '"]'); if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" }); }
    }
    q.addEventListener("input", function () { val.value = ""; check(); render(); });
    q.addEventListener("focus", function () { if (!val.value) render(); });
    q.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !list.hidden) { close(); e.preventDefault(); e.stopPropagation(); return; }
      if (list.hidden) return;
      if (e.key === "ArrowDown") { step(1); e.preventDefault(); }
      else if (e.key === "ArrowUp") { step(-1); e.preventDefault(); }
      else if (e.key === "Enter" && active >= 0) { choose(active); e.preventDefault(); }
    });
    q.addEventListener("blur", function () { setTimeout(close, 120); });
    form.addEventListener("reset", function () { setTimeout(function () { val.value = ""; q.setCustomValidity(""); if (go) go.disabled = true; }, 0); });
    check();
    form._rpick = { reset: function () { q.value = ""; val.value = ""; close(); check(); }, focus: function () { q.focus(); } };
    return form._rpick;
  }
  document.addEventListener("click", function (e) {
    var open = e.target.closest && e.target.closest("[data-rpick-open]");
    var cancel = e.target.closest && e.target.closest("[data-rpick-cancel]");
    var blockEl = (open || cancel) && (open || cancel).closest("[data-rpick-block]");
    var form = blockEl && blockEl.querySelector("[data-rpick-form]");
    if (!form) return;
    var api = setup(form);
    if (open) {
      var show = form.hidden; form.hidden = !show; open.setAttribute("aria-expanded", show ? "true" : "false");
      if (show && api) api.focus(); else if (api) api.reset();
    } else if (cancel) {
      form.hidden = true; var o = blockEl.querySelector("[data-rpick-open]"); if (o) { o.setAttribute("aria-expanded", "false"); o.focus(); }
      if (api) api.reset();
    }
  });
})();
