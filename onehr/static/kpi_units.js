// KPI units as you set a KPI (Chris, 2026-10-18, the libraries canvas board 23: "if the target is more than a million,
// it goes automatically to RM (mil) ... the system will auto suggest and ask user to set the unit during the KPI setting
// time"). Works on every templates/_kpi_unit.html picker (select[data-kpi-unit]) inside a [data-kpi-scale] line or form:
//   * a bar under the figures when the target reads better in another step of its scale ("These figures are in the
//     millions. Show them in RM (mil)? 15,900,000 becomes 15.9."). Use moves every figure of the line by the same step
//     and changes the unit, so nothing changes in value; Keep hides it for that pair. Nothing changes without a click.
//     The same rule as the server's kpi_unit_suggest: the step where the target is at least 1 and under a thousand.
//   * Other: type a unit off the list. The typed box takes the select's name while it is in use.
// Loaded in base.html's head; listens on the document, so lines added later (Add a person, a panel's page) work too.
(function () {
  if (window.__kpiUnits) return;
  window.__kpiUnits = true;
  var FIGS = ['rate1', 'rate2', 'rate3', 'rate4', 'rate5', 'threshold', 'target', 'excellence'];
  var BIG = ['', 'thousands', 'millions', 'billions'];
  var OTHER = '__other';

  function field(scope, f) {
    var alt = f.indexOf('rate') === 0 ? 'rate ' + f.slice(4) : f;
    return scope.querySelector('[name="' + f + '"]') || scope.querySelector('[name="' + alt + '"]') ||
      scope.querySelector('[data-kpi-f="' + f + '"]');
  }
  function num(el) {
    if (!el) return null;
    var v = (el.value || '').replace(/,/g, '').trim();
    if (v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  // a figure moved `d` thousand-steps up its scale, by its decimal digits (15900000 up 2 -> 15.9, never 15.899999...)
  function shift(v, d) {
    var p = String(v).split('e');
    return Number(p[0] + 'e' + ((p[1] ? Number(p[1]) : 0) - 3 * d));
  }
  function fmt(n) { return n.toLocaleString('en-US', { maximumFractionDigits: 10 }); }
  function scopeOf(el) { return el && el.closest ? (el.closest('[data-kpi-scale]') || el.closest('form')) : null; }
  function picker(scope) { return scope ? scope.querySelector('select[data-kpi-unit]') : null; }

  function suggest(sel, scope) {
    var o = sel.options[sel.selectedIndex];
    if (!o || !o.hasAttribute('data-ku-fam')) return null;
    var fam = o.getAttribute('data-ku-fam'), step = +o.getAttribute('data-ku-step');
    var t = num(field(scope, 'rate3'));
    if (t === null) t = num(field(scope, 'target'));
    if (!t) return null;
    var steps = [];
    Array.prototype.forEach.call(sel.options, function (x) {
      if (x.getAttribute('data-ku-fam') === fam) steps[+x.getAttribute('data-ku-step')] = x;
    });
    var base = Math.abs(t) * Math.pow(1000, step), best = 0;
    for (var i = 0; i < steps.length; i++) if (steps[i] && base >= Math.pow(1000, i)) best = i;
    if (best === step || !steps[best]) return null;
    return { to: steps[best], from: o, d: best - step, was: t, now: shift(t, best - step), big: BIG[best] };
  }

  function barOf(scope) {
    var bar = scope.querySelector('.ku-bar');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'ku-bar';
    bar.setAttribute('role', 'status');
    var txt = document.createElement('span'); txt.className = 'ku-txt';
    var use = document.createElement('button'); use.type = 'button'; use.className = 'ku-use';
    var keep = document.createElement('button'); keep.type = 'button'; keep.className = 'btn-link ku-keep';
    bar.appendChild(txt); bar.appendChild(use); bar.appendChild(keep);
    // under the row holding the figures (the line's own child), else at the line's end
    var row = null;
    for (var i = 0; i < FIGS.length && !row; i++) row = field(scope, FIGS[i]);
    while (row && row.parentNode !== scope) row = row.parentNode;
    if (row && row.nextSibling) scope.insertBefore(bar, row.nextSibling); else scope.appendChild(bar);
    return bar;
  }

  function check(scope) {
    var sel = picker(scope);
    if (!sel || sel.disabled) return;
    var s = suggest(sel, scope);
    var keep = s && scope.getAttribute('data-ku-keep') === s.from.value + '>' + s.to.value;
    var bar = scope.querySelector('.ku-bar');
    if (!s || keep) { if (bar) bar.hidden = true; return; }
    bar = barOf(scope);
    bar.querySelector('.ku-txt').textContent = (s.d > 0 ? 'These figures are in the ' + s.big + '.' :
      'These figures are under one ' + s.from.value + '.') + ' Show them in ' + s.to.value + '? ' + fmt(s.was) +
      ' becomes ' + fmt(s.now) + '.';
    bar.querySelector('.ku-use').textContent = 'Use ' + s.to.value;
    bar.querySelector('.ku-keep').textContent = 'Keep ' + s.from.value;
    bar.hidden = false;
    bar._ku = s;
  }

  function accept(scope) {
    var sel = picker(scope), bar = scope.querySelector('.ku-bar'), s = bar && bar._ku;
    if (!sel || !s) return;
    FIGS.forEach(function (f) {
      var el = field(scope, f), v = num(el);
      if (v === null) return;
      el.value = String(shift(v, s.d));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    sel.value = s.to.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Other: the typed box takes the select's name while it is chosen
  function addOther(sel) {
    if (sel.querySelector('option[value="' + OTHER + '"]')) return;
    var o = document.createElement('option'); o.value = OTHER; o.textContent = 'Other: type it…';
    sel.appendChild(o);
  }
  function other(sel) {
    var box = sel.parentNode.querySelector('.ku-other');
    if (!box) return;
    var name = sel.getAttribute('name') || sel.getAttribute('data-ku-name');
    if (sel.value === OTHER) {
      sel.setAttribute('data-ku-name', name); sel.removeAttribute('name');
      box.name = name; box.hidden = false; box.focus();
    } else if (!sel.getAttribute('name')) {
      sel.setAttribute('name', name); box.removeAttribute('name'); box.hidden = true;
    }
  }

  document.addEventListener('focusin', function (e) {
    var t = e.target;
    if (t && t.matches && t.matches('select[data-kpi-unit]')) addOther(t);
    var sc = scopeOf(t);
    if (sc && picker(sc)) check(sc);
  });
  function onEdit(e) {
    var t = e.target;
    if (t && t.matches && t.matches('select[data-kpi-unit]')) other(t);
    var sc = scopeOf(t);
    if (sc && picker(sc)) check(sc);
  }
  document.addEventListener('input', onEdit);
  document.addEventListener('change', onEdit);
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('.ku-use, .ku-keep');
    if (!b) return;
    var sc = scopeOf(b), bar = b.closest('.ku-bar');
    if (!sc || !bar || !bar._ku) return;
    e.preventDefault();
    if (b.classList.contains('ku-use')) accept(sc);
    else { sc.setAttribute('data-ku-keep', bar._ku.from.value + '>' + bar._ku.to.value); bar.hidden = true; }
  });
  function all() {
    Array.prototype.forEach.call(document.querySelectorAll('select[data-kpi-unit]'), function (sel) {
      var sc = scopeOf(sel); if (sc) check(sc);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', all); else all();
  // a picker that arrives later (a panel's page, Add a person's new line) is checked as it lands, so an edit form
  // opens with its offer showing
  var due = null;
  if (window.MutationObserver) {
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var add = muts[i].addedNodes;
        for (var j = 0; j < add.length; j++) {
          var n = add[j];
          if (n.nodeType === 1 && (n.matches('select[data-kpi-unit]') || n.querySelector('select[data-kpi-unit]'))) {
            clearTimeout(due); due = setTimeout(all, 30); return;
          }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  window.onehrKpiUnits = { check: check, all: all };
})();
