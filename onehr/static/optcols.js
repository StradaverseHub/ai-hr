/* Optional-column picker.
 *
 * Some columns are worth having but not worth the width for everyone all the
 * time -- cost centre and work location are roster attributes most reviewers
 * never look at. They now always render, hidden by default, and this button
 * decides which of them are on. That replaces the older rule (show a column
 * whenever anyone in scope carries a value), which was well meant but took the
 * choice away: a reviewer who wanted cost centre had no way to ask for it, and
 * one who didn't had no way to get the width back.
 *
 * A page opts in with one element:
 *
 *   <div class="optcols"
 *        data-optcols-key="calib"          <- preference key, shared across pages
 *        data-optcols-table="calib-table"
 *        data-optcols='[{"id":"cc","label":"Cost centre","on":false,"empty":true}]'>
 *   </div>
 *
 * and by tagging the cells: <th data-optcol="cc"> / <td data-optcol="cc">.
 * The choice is remembered per browser, per key -- deliberately shared across
 * the four calibration tiers, since "show me cost centre" is one preference
 * about calibration, not four about four pages.
 */
(function () {
  'use strict';

  var STORE = 'l360.optcols.';

  function load(key) {
    try { return JSON.parse(window.localStorage.getItem(STORE + key) || 'null') || {}; }
    catch (e) { return {}; }   // private browsing / disabled storage: just don't remember
  }

  function save(key, state) {
    try { window.localStorage.setItem(STORE + key, JSON.stringify(state)); } catch (e) {}
  }

  function init(bar) {
    var cols;
    try { cols = JSON.parse(bar.getAttribute('data-optcols') || '[]'); }
    catch (e) { return; }
    if (!cols.length) return;

    var table = document.getElementById(bar.getAttribute('data-optcols-table') || '');
    if (!table) return;
    var key = bar.getAttribute('data-optcols-key') || 'default';

    var saved = load(key);
    var state = {};
    cols.forEach(function (c) {
      state[c.id] = Object.prototype.hasOwnProperty.call(saved, c.id)
        ? !!saved[c.id] : !!c.on;
    });

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'optcols-btn';
    var btnLabel = document.createElement('span');
    btn.appendChild(btnLabel);
    var caret = document.createElement('span');
    caret.className = 'cm-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = '▾';
    btn.appendChild(caret);

    var menu = document.createElement('div');
    menu.className = 'optcols-menu';
    menu.hidden = true;
    var head = document.createElement('p');
    head.className = 'optcols-head';
    head.textContent = 'Show extra columns';
    menu.appendChild(head);

    cols.forEach(function (c) {
      var lab = document.createElement('label');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state[c.id];
      box.addEventListener('change', function () {
        state[c.id] = box.checked;
        save(key, state);
        apply();
      });
      lab.appendChild(box);
      var txt = document.createElement('span');
      txt.textContent = c.label;
      lab.appendChild(txt);
      if (c.empty) {
        // Say so rather than letting someone switch on a column of dashes and
        // wonder whether the page is broken. It stays switchable: an empty
        // column is a fair way to confirm the roster hasn't been populated yet.
        var note = document.createElement('span');
        note.className = 'muted small';
        note.textContent = 'no data here';
        lab.appendChild(note);
      }
      menu.appendChild(lab);
    });

    function apply() {
      var on = 0;
      cols.forEach(function (c) {
        var show = state[c.id];
        if (show) on++;
        var cells = table.querySelectorAll('[data-optcol="' + c.id + '"]');
        for (var i = 0; i < cells.length; i++) cells[i].hidden = !show;
        // Hiding a column while one of its values is still filtering the table
        // would silently keep rows out of view with nothing on screen to
        // explain it, so drop the filter with the column.
        if (!show && typeof window.colMenuSetClientFilter === 'function') {
          window.colMenuSetClientFilter(c.id, []);
        }
      });
      btnLabel.textContent = on ? ('Columns · ' + on) : 'Columns';
      btn.classList.toggle('is-on', on > 0);
      // The "no rows match" row spans the table, so its span has to track
      // whatever is actually showing.
      var spanners = table.querySelectorAll('[data-colspan-base]');
      for (var j = 0; j < spanners.length; j++) {
        spanners[j].colSpan = parseInt(spanners[j].getAttribute('data-colspan-base'), 10) + on;
      }
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });
    menu.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () { menu.hidden = true; });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') menu.hidden = true;
    });

    bar.appendChild(btn);
    bar.appendChild(menu);
    apply();
  }

  function boot() {
    var bars = document.querySelectorAll('.optcols[data-optcols]');
    for (var i = 0; i < bars.length; i++) init(bars[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
