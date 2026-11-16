// The KPI scale check as you type (Chris, 2026-10-18: "if the kpi is higher is better, the setting should be in increment
// order and no 2 rating should share the same value ... the target should never be 0"). The same rule as the server's
// pm_scale_error, which still decides on save: a form opts in with data-kpi-scale="A" (Rate 1-5) or "B" (threshold /
// target), and reads its own method field. While a scale is wrong the box under it says why, the field is outlined and
// the form's submit buttons wait. A form holding several lines (Add a person's KPIs) puts data-kpi-scale on each line
// instead: each is checked on its own, and the form waits while any line is wrong. A formnovalidate button (a Skip)
// never waits. A form with data-kpe-dir-soft (the person page's KPI panel, where Method is picked) does not wait on a
// DIRECTION mismatch (the figures run the wrong way for the method): that panel says so itself, with the way to fix it
// (static/kpi_edit.js), and the server refuses a wrong scale whatever the page does.
(function () {
  if (window.__kpiScale) return;
  window.__kpiScale = true;
  function num(el) {
    if (!el) return null;
    var v = (el.value || '').replace(/,/g, '').trim();
    if (v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  // a field by its name, or by data-kpi-f where a form names its fields per line (BU KPI setup's k<id>_rate1)
  function field(f, names) {
    for (var i = 0; i < names.length; i++) {
      var el = f.querySelector('[name="' + names[i] + '"]') || f.querySelector('[data-kpi-f="' + names[i] + '"]');
      if (el) return el;
    }
    return null;
  }
  function problem(f) {
    var mech = f.getAttribute('data-kpi-scale');
    var m = field(f, ['method']);
    var more = !m || (m.value || 'more') !== 'less';
    if (mech === 'A') {
      var els = [], vals = [];
      for (var i = 1; i <= 5; i++) {
        var el = field(f, ['rate ' + i, 'rate' + i]);
        els.push(el); vals.push(num(el));
      }
      if (vals.some(function (v) { return v === null; })) return null;
      // the whole ladder runs the wrong way for the method (the panel can reverse it): a DIRECTION mismatch; a ladder out of
      // order in the middle is not, and still waits
      var wrongWay = more ? vals.every(function (v, k) { return k === 0 || v <= vals[k - 1]; }) && vals[4] < vals[0]
                          : vals.every(function (v, k) { return k === 0 || v >= vals[k - 1]; }) && vals[4] > vals[0];
      for (i = 1; i < 5; i++) {
        var a = vals[i - 1], b = vals[i];
        if (a === b) return [els[i], 'Rate ' + (i + 1) + " can't be the same as Rate " + i + ': each rating needs its own figure.'];
        if (more && b < a) return [els[i], 'Rate ' + (i + 1) + ' must be higher than Rate ' + i + ': higher is better, so the figures rise from Rate 1 to Rate 5.', wrongWay ? 'dir' : ''];
        if (!more && b > a) return [els[i], 'Rate ' + (i + 1) + ' must be lower than Rate ' + i + ': lower is better, so the figures fall from Rate 1 to Rate 5.', wrongWay ? 'dir' : ''];
      }
      return null;
    }
    if (mech === 'B') {
      var th = field(f, ['threshold']), tg = field(f, ['target']);
      var t = num(tg), h = num(th);
      if (t === null) return null;
      if (t === 0) return [tg, "The target can't be 0: achievement is worked out against the target."];
      if (h !== null && more && h >= t) return [th, 'The threshold must be below the target: higher is better.', h > t ? 'dir' : ''];
      if (h !== null && !more && h <= t) return [th, 'The threshold must be above the target: lower is better.', h < t ? 'dir' : ''];
      // the Excellence variant: its cap (pm_pct_b_transform, as the server's pm_scale_error) must score 100% or more
      var ex = field(f, ['excellence']), x = num(ex);
      if (x !== null) {
        var cap = (!more !== (t < 0)) ? ((1 + (1 - x / t)) * 100) : (x / t * 100);
        if (cap < 100 - 1e-9) return [ex, 'The excellence must be at or beyond the target: ' + (more ? 'higher is better, so it sits at or above the target.' : 'lower is better, so it sits at or below the target.')];
      }
    }
    return null;
  }
  function check(f) {
    var p = problem(f), isForm = f.tagName === 'FORM';
    if (p && p[2] === 'dir' && (isForm ? f : f.closest('form')) && (isForm ? f : f.closest('form')).hasAttribute('data-kpe-dir-soft')) p = null;
    Array.prototype.forEach.call(f.querySelectorAll('[data-kpi-scale-bad]'), function (el) {
      el.removeAttribute('data-kpi-scale-bad'); el.removeAttribute('aria-invalid');
    });
    var box = isForm ? f.querySelector('.kpi-scale-msg') : f.querySelector(':scope > .kpi-scale-msg');
    if (!box) {
      box = document.createElement('p');
      box.className = 'kpi-scale-msg';
      box.setAttribute('role', 'alert');
      // a form: just above the row that holds the submit button (the form's own child), else at the end; a line: its end
      var row = isForm ? f.querySelector('button[type="submit"]') : null;
      while (row && row.parentNode !== f) row = row.parentNode;
      f.insertBefore(box, row || null);
    }
    box.textContent = p ? p[1] : '';
    box.hidden = !p;
    if (p && p[0]) { p[0].setAttribute('data-kpi-scale-bad', '1'); p[0].setAttribute('aria-invalid', 'true'); }
    var form = isForm ? f : f.closest('form');
    if (!form) return;
    var bad = !!form.querySelector('[data-kpi-scale-bad]');
    Array.prototype.forEach.call(form.querySelectorAll('button[type="submit"]'), function (b) {
      if (!b.hasAttribute('formnovalidate')) b.disabled = bad;
    });
  }
  function onEdit(e) {
    var f = e.target && e.target.closest && e.target.closest('[data-kpi-scale]');
    if (f && /^[AB]$/.test(f.getAttribute('data-kpi-scale') || '')) check(f);
  }
  document.addEventListener('input', onEdit);
  document.addEventListener('change', onEdit);
})();
