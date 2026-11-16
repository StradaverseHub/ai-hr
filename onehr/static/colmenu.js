/* Generic column menu for admin tables.
 *
 * Driven by window.COLMENU_CONFIGS = [{ ... }, { ... }] -- one entry per table,
 * so a page may carry as many as it likes. A single window.COLMENU_CONFIG = {...}
 * is still accepted for the pages written before that was possible.
 *
 * Each entry: {
 *   tableId: 'subjects-table',
 *   base: [['scope','all'], ['q','...'], ['per_page',30]],   // carried into filter URLs
 *   cols: {
 *     company: { mode:'server', param:'fcompany', type:'text', sortAttr:'company',
 *                values:[...all values...], active:[...selected...] },
 *     score:   { mode:'sort',   type:'num',  sortAttr:'score' },
 *     name:    { mode:'sort',   type:'text', sortAttr:'name'  }
 *   }
 * }
 *
 * mode 'server'      -> sort buttons + a persistent value filter (checkbox list
 *                        from the FULL value set; Apply/Clear navigate, so the
 *                        filter spans every page and survives pagination).
 *                        Typing in the value search auto-selects the matches.
 * mode 'clientFilter' -> same checkbox-list UI as 'server', but Apply/Clear
 *                        hide/show <tr class="data-row"> elements on the
 *                        CURRENT page instead of navigating -- for tables with
 *                        no pagination, where a full reload just to toggle a
 *                        filter would be needless. `values` is optional here:
 *                        if omitted, the distinct value set is derived from
 *                        the rendered rows' own data-{sortAttr} attributes.
 *                        Multiple clientFilter columns combine with AND, each
 *                        column's own selected values combine with OR --
 *                        same semantics 'server' mode gets from its query params.
 * mode 'sort'         -> sort buttons only (no value filter).
 * Sorting is always client-side on the current page -- it reorders whole
 * <tr class="data-row"> elements, so it assumes one row = one record. Set
 * noSort:true on a column (any mode) to omit the sort buttons entirely; use
 * this for tables with rowspan-merged cells, where reordering individual
 * rows would misalign the merged spans.
 */
(function () {
function initColMenu(CFG) {
  if (!CFG) return null;
  var table = document.getElementById(CFG.tableId);
  if (!table) return null;
  var tbody = table.querySelector('tbody');
  if (!tbody) return null;
  var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr.data-row'));
  // Scoped to THIS table rather than the document: with two tables on a page
  // the second would otherwise hide/show the first one's no-match row. Pages
  // written before this carry id="no-filter-match" inside the table and are
  // still found; new tables should use the class, since an id may appear once.
  var noMatch = table.querySelector('.no-filter-match')
             || table.querySelector('#no-filter-match');
  // A row's own detail rows (the plain <tr>s straight after it, before the next data row: an edit form, a note) travel
  // with it when the table is sorted and hide with it when filtered (the KPI library's Edit rows, 2026-10-11). Before
  // this a sort left every Edit row stranded at the top, under the wrong KPI.
  function followers(r) {
    var out = [], n = r.nextElementSibling;
    while (n && n.tagName === 'TR' && !n.classList.contains('data-row') && n !== noMatch) { out.push(n); n = n.nextElementSibling; }
    return out;
  }
  rows.forEach(function (r) { r.__cmFollow = followers(r); });
  // One popup per table. The first instance adopts a hand-written #col-menu if
  // the page has one -- every existing adopter does -- and any instance after
  // that builds its own. That is what lets a page carry several tables without
  // two of them fighting over a single element, and means a new page needs no
  // menu markup at all.
  var menu = document.getElementById('col-menu');
  if (!menu || menu.__cmClaimed) {
    menu = document.createElement('div');
    menu.className = 'col-menu';
  }
  menu.__cmClaimed = true;
  menu.hidden = true;
  document.body.appendChild(menu); // avoid clipping by table/container
  var COLS = CFG.cols || {};
  var BASE = CFG.base || [];

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function sortKey(col, r) {
    var c = COLS[col];
    var raw = c.sortAttr ? r.dataset[c.sortAttr] : '';
    if (raw === undefined || raw === null) raw = '';
    if (c.type === 'num') { var n = parseFloat(raw); return isNaN(n) ? -Infinity : n; }
    if (c.order) { var i = c.order.indexOf(raw); return i === -1 ? -Infinity : i; }
    return String(raw).toLowerCase();
  }

  function buildUrl(changedCol, selected) {
    var pairs = BASE.slice();
    Object.keys(COLS).forEach(function (col) {
      var c = COLS[col];
      if (c.mode !== 'server') return;
      var vals = (col === changedCol) ? selected : (c.active || []);
      vals.forEach(function (v) { pairs.push([c.param, v]); });
    });
    pairs.push(['page', '1']);
    return '?' + pairs.map(function (p) { return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]); }).join('&');
  }

  function applySort(col, dir) {
    rows.slice().sort(function (a, b) {
      var va = sortKey(col, a), vb = sortKey(col, b), cmp;
      if (COLS[col].type === 'num' || COLS[col].order) { cmp = va - vb; }
      else { cmp = String(va).localeCompare(String(vb)); }
      return dir === 'asc' ? cmp : -cmp;
    }).forEach(function (r) {
      tbody.insertBefore(r, noMatch);
      (r.__cmFollow || []).forEach(function (f) { tbody.insertBefore(f, noMatch); });
    });
    Object.keys(COLS).forEach(function (c) {
      var b = table.querySelector('.col-menu-btn[data-col="' + c + '"]');
      if (b) { b.classList.remove('sort-asc', 'sort-desc'); if (c === col) b.classList.add(dir === 'asc' ? 'sort-asc' : 'sort-desc'); }
    });
  }

  // clientFilter state: col -> selected values, or [] (falsy-length) = no filter.
  var activeFilters = {};
  // Extra row tests contributed by the PAGE, ANDed with the column filters.
  // Several pages carry their own free-text search that hid rows by writing
  // row.style.display directly -- the same property this file writes. Left
  // alone the two fight: the search hides a row, then the next column filter
  // shows it again. A predicate composes instead, exactly like the BU pills.
  var predicates = [];

  function clientFilterValues(col) {
    var c = COLS[col];
    if (c.values) return c.values.slice();
    var seen = {}, out = [];
    rows.forEach(function (r) {
      var v = c.sortAttr ? (r.dataset[c.sortAttr] || '') : '';
      if (!seen[v]) { seen[v] = true; out.push(v); }
    });
    return out.sort();
  }

  function applyClientFilters() {
    var cols = Object.keys(COLS).filter(function (c) { return COLS[c].mode === 'clientFilter'; });
    var any = false;
    rows.forEach(function (r) {
      var visible = cols.every(function (col) {
        var sel = activeFilters[col];
        if (!sel || !sel.length) return true;
        var raw = COLS[col].sortAttr ? (r.dataset[COLS[col].sortAttr] || '') : '';
        return sel.indexOf(raw) !== -1;
      }) && predicates.every(function (fn) { return fn(r); });
      r.style.display = visible ? '' : 'none';
      (r.__cmFollow || []).forEach(function (f) { f.style.display = visible ? '' : 'none'; });
      if (visible) any = true;
    });
    if (noMatch) noMatch.hidden = any;
  }

  function markIndicators() {
    Object.keys(COLS).forEach(function (col) {
      var b = table.querySelector('.col-menu-btn[data-col="' + col + '"]');
      if (!b) return;
      var c = COLS[col];
      b.classList.toggle('has-filter',
        (c.mode === 'server' && c.active && c.active.length > 0) ||
        (c.mode === 'clientFilter' && activeFilters[col] && activeFilters[col].length > 0));
    });
  }
  markIndicators();

  function closeMenu() { menu.hidden = true; menu.innerHTML = ''; menu.removeAttribute('data-col'); }

  function openMenu(col, btn) {
    var c = COLS[col];
    var numLabel = c.type === 'num';
    var ascLabel = c.order ? (c.order[0] + ' → ' + c.order[c.order.length - 1]) : (numLabel ? 'smallest → largest' : 'A → Z');
    var descLabel = c.order ? (c.order[c.order.length - 1] + ' → ' + c.order[0]) : (numLabel ? 'largest → smallest' : 'Z → A');
    var html = '';
    if (!c.noSort) {
      html +=
          '<div class="cm-sort">'
        +   '<button type="button" data-sort="asc">&#9650; Sort ' + ascLabel + '</button>'
        +   '<button type="button" data-sort="desc">&#9660; Sort ' + descLabel + '</button>'
        + '</div>';
    }
    var isFilter = c.mode === 'server' || c.mode === 'clientFilter';
    if (isFilter) {
      var values = c.mode === 'clientFilter' ? clientFilterValues(col) : (c.values || []).slice();
      var activeVals = c.mode === 'clientFilter' ? activeFilters[col] : c.active;
      var current = (activeVals && activeVals.length) ? activeVals : null;  // null = all (no filter)
      html +=
          '<div class="cm-search"><input type="text" placeholder="Search values…" aria-label="Search values"></div>'
        + '<label class="cm-all"><input type="checkbox" class="cm-selall"> <strong>(Select all)</strong></label>'
        + '<div class="cm-list">'
        +   values.map(function (v) {
              var on = !current || current.indexOf(v) !== -1;
              return '<label><input type="checkbox" value="' + encodeURIComponent(v) + '"' + (on ? ' checked' : '') + '> ' + esc(v === '' ? '(blank)' : v) + '</label>';
            }).join('')
        + '</div>'
        + '<div class="cm-foot"><button type="button" class="cm-clear">Clear filter</button>'
        +   (c.mode === 'clientFilter'
              ? '<button type="button" class="cm-done primary">Done</button>'
              : '<button type="button" class="cm-apply primary">Apply</button>')
        + '</div>';
    }
    menu.innerHTML = html;
    menu.setAttribute('data-col', col);

    var rc = btn.getBoundingClientRect();
    menu.hidden = false;
    menu.style.maxHeight = '';
    var left = Math.min(window.scrollX + rc.left, window.scrollX + document.documentElement.clientWidth - menu.offsetWidth - 8);
    menu.style.left = Math.max(8, left) + 'px';
    // Vertical: keep the whole menu on-screen. Open below when it fits, else
    // flip above the button; cap the height to the available space so the value
    // list scrolls internally rather than the menu spilling past the viewport.
    var vh = document.documentElement.clientHeight;
    var spaceBelow = vh - rc.bottom - 12;
    var spaceAbove = rc.top - 12;
    if (menu.offsetHeight <= spaceBelow || spaceBelow >= spaceAbove) {
      menu.style.maxHeight = spaceBelow + 'px';
      menu.style.top = (window.scrollY + rc.bottom + 4) + 'px';
    } else {
      menu.style.maxHeight = spaceAbove + 'px';
      menu.style.top = (window.scrollY + rc.top - menu.offsetHeight - 4) + 'px';
    }

    menu.querySelectorAll('.cm-sort button').forEach(function (b) {
      b.addEventListener('click', function () { applySort(col, b.getAttribute('data-sort')); closeMenu(); });
    });
    if (!isFilter) return;

    var boxes = function () { return Array.prototype.slice.call(menu.querySelectorAll('.cm-list input')); };
    var selAll = menu.querySelector('.cm-selall');
    function shownBoxes() { return boxes().filter(function (x) { return x.parentElement.style.display !== 'none'; }); }
    function refreshAll() { var s = shownBoxes(), on = s.filter(function (x) { return x.checked; }).length; selAll.checked = on === s.length && s.length > 0; selAll.indeterminate = on > 0 && on < s.length; }
    // clientFilter columns apply LIVE: as you tick/untick or type in the search,
    // the table filters immediately -- no Apply click needed. Clicking outside
    // (or Done) just closes; the filter is already in effect.
    function liveApply() {
      var all = boxes(), chosen = all.filter(function (x) { return x.checked; }).map(function (x) { return decodeURIComponent(x.value); });
      activeFilters[col] = (chosen.length === all.length) ? [] : chosen;  // all checked = no filter
      applyClientFilters(); markIndicators();
    }
    var live = c.mode === 'clientFilter';
    refreshAll();
    selAll.addEventListener('change', function () {
      shownBoxes().forEach(function (x) { x.checked = selAll.checked; });
      if (live) liveApply();
    });
    menu.querySelector('.cm-list').addEventListener('change', function () {
      refreshAll();
      if (live) liveApply();
    });
    menu.querySelector('.cm-search input').addEventListener('input', function (e) {
      var q = e.target.value.toLowerCase();
      // selection follows the search: only visible matches stay selected
      boxes().forEach(function (x) {
        var m = x.parentElement.textContent.toLowerCase().indexOf(q) !== -1;
        x.parentElement.style.display = m ? '' : 'none';
        x.checked = m;
      });
      refreshAll();
      if (live) liveApply();
    });
    if (live) {
      menu.querySelector('.cm-clear').addEventListener('click', function () {
        // reset to no filter, but keep the menu open so they can re-pick
        boxes().forEach(function (x) { x.checked = true; x.parentElement.style.display = ''; });
        menu.querySelector('.cm-search input').value = '';
        refreshAll();
        activeFilters[col] = []; applyClientFilters(); markIndicators();
      });
      menu.querySelector('.cm-done').addEventListener('click', closeMenu);
    } else {
      menu.querySelector('.cm-clear').addEventListener('click', function () { window.keepPlace && window.keepPlace(); window.location = buildUrl(col, []); });
      menu.querySelector('.cm-apply').addEventListener('click', function () {
        var all = boxes(), chosen = all.filter(function (x) { return x.checked; }).map(function (x) { return decodeURIComponent(x.value); });
        window.keepPlace && window.keepPlace();
        window.location = buildUrl(col, chosen.length === all.length ? [] : chosen);  // all checked = no filter
      });
    }
    menu.querySelector('.cm-search input').focus();
  }

  table.querySelectorAll('.col-menu-btn').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var col = btn.getAttribute('data-col');
      if (!menu.hidden && menu.getAttribute('data-col') === col) { closeMenu(); return; }
      openMenu(col, btn);
    });
  });
  menu.addEventListener('click', function (e) { e.stopPropagation(); });
  document.addEventListener('click', function () { if (!menu.hidden) closeMenu(); });
  window.addEventListener('resize', closeMenu);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });

  // Let an external control (e.g. the BGCEO business-unit pills) drive a
  // clientFilter column that has no header button of its own -- it flows through
  // the same AND-across-columns visibility pass every menu filter uses, so pills
  // + Dept/JG menus compose instead of fighting over row display.
  function setClientFilter(col, values) {
    if (!COLS[col] || COLS[col].mode !== 'clientFilter') return;
    activeFilters[col] = (values || []).slice();
    applyClientFilters();
    markIndicators();
  }

  return {
    tableId: CFG.tableId,
    setClientFilter: setClientFilter,
    addPredicate: function (fn) { predicates.push(fn); applyClientFilters(); },
    refresh: function () { applyClientFilters(); }
  };
}

// COLMENU_CONFIGS (a list) is the current form. COLMENU_CONFIG (one) is kept
// because ten pages were written against it and none of them should have to
// change to gain nothing.
// MERGED, not either/or. admin_reminders is the first page to carry both a
// hand-written COLMENU_CONFIG (written before this file took a list) and a
// macro-generated COLMENU_CONFIGS entry; picking one would have silently
// dropped the other table's menu, with nothing on screen to say so.
var cfgs = (window.COLMENU_CONFIGS || [])
  .concat(window.COLMENU_CONFIG ? [window.COLMENU_CONFIG] : []);
var instances = [];
cfgs.forEach(function (c) { var i = initColMenu(c); if (i) instances.push(i); });

// tableId is optional and falls back to the first table: the two callers that
// exist -- optcols.js and calibration.js -- are on single-table pages and were
// written when there was nothing to choose between.
window.colMenuSetClientFilter = function (col, values, tableId) {
  instances.forEach(function (i, n) {
    if (tableId ? i.tableId === tableId : n === 0) i.setClientFilter(col, values);
  });
};

// A page registers its own row test here -- a free-text search box, typically --
// and calls colMenuRefresh() when the test's answer changes. The predicate is
// ANDed with the column filters, so searching and filtering narrow together
// rather than overwriting each other's work.
window.colMenuAddPredicate = function (tableId, fn) {
  var i = instances.filter(function (x) { return x.tableId === tableId; })[0];
  if (i) i.addPredicate(fn);
};
window.colMenuRefresh = function (tableId) {
  var i = instances.filter(function (x) { return x.tableId === tableId; })[0];
  if (i) i.refresh();
};
})();
