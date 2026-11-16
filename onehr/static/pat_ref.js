/* PAT Ref (Calibration & Talent > Run, 2026-10-27): the one Save for the whole table. As an admin types a figure, its row
   shows a changed state, the curve cell reads "old -> new" when the curve changes and "was X%" follows the %; the foot bar
   counts the changes and sets the Save form's confirm box (data-confirm, -list, -ok) BEFORE it opens (base.html reads them
   when the submit fires). Discard puts every figure back; leaving with unsaved changes asks first. Thresholds follow
   pm_curve_key_for_pct: under 70 negative, over 130 positive, else normal; blank = not entered (the normal curve). */
(function () {
  var table = document.getElementById('calib-pbt');
  var form = document.getElementById('pat-save');
  if (!table || !form) return;
  var curves = {}, bands = [];
  try { curves = JSON.parse(table.getAttribute('data-curves') || '{}'); bands = JSON.parse(table.getAttribute('data-bands') || '[]'); } catch (e) { return; }
  var msg = document.getElementById('pat-foot-msg');
  var submit = document.getElementById('pat-submit');
  var discard = document.getElementById('pat-discard');
  var base = form.getAttribute('data-confirm');
  var inputs = Array.prototype.slice.call(table.querySelectorAll('input.pat-input'));
  var NAMES = { negative: 'Negatively skewed', normal: 'Normal', positive: 'Positively skewed' };

  function num(v) { v = (v || '').trim(); if (v === '') return null; var n = parseFloat(v.replace(/,/g, '')); return isNaN(n) ? null : n; }
  function keyOf(n) { return n < 70 ? 'negative' : (n > 130 ? 'positive' : 'normal'); }
  function same(a, b) { return (a === null) === (b === null) && (a === null || Math.abs(a - b) < 1e-9); }
  function fig(n) { return n === null ? 'not entered' : String(n) + '%'; }
  function title(k) { var d = curves[k] && curves[k].title || {}; return bands.map(function (b) { return b + ' ' + d[b] + '%'; }).join(' · '); }
  function chip(k) {
    var s = document.createElement('span');
    s.className = 'status-pill ' + curves[k].cls; s.textContent = curves[k].label; s.title = title(k);
    return s;
  }
  function plain(text) { var s = document.createElement('span'); s.className = 'muted small'; s.textContent = text; return s; }
  function state(n) { return n === null ? null : keyOf(n); }

  function paintRow(inp) {
    var row = inp.closest('tr'), cell = row.querySelector('.pat-curvecell'), was = row.querySelector('.pat-was');
    var o = num(inp.getAttribute('data-orig')), n = num(inp.value);
    var changed = !same(o, n);
    row.classList.toggle('is-changed', changed);
    inp.classList.toggle('is-changed', changed);
    was.hidden = !changed;
    was.textContent = changed ? 'was ' + (o === null ? 'not entered' : String(o) + '%') : '';
    if (!cell.__orig) cell.__orig = cell.innerHTML;
    var so = state(o), sn = state(n);
    if (!changed || so === sn) { cell.innerHTML = cell.__orig; return changed; }
    cell.innerHTML = '';
    var w = document.createElement('span'); w.className = 'pat-chips';
    w.appendChild(so === null ? plain('Not entered') : chip(so));
    var ar = document.createElement('span'); ar.className = 'pat-arrow'; ar.setAttribute('aria-hidden', 'true'); ar.textContent = '→';
    w.appendChild(ar);
    w.appendChild(sn === null ? plain('Not entered · normal curve') : chip(sn));
    cell.appendChild(w);
    return changed;
  }

  function refresh() {
    var rows = [];
    inputs.forEach(function (inp) {
      if (paintRow(inp)) rows.push(inp);
      var r = inp.closest('tr'); r.setAttribute('data-pbt', inp.value);
    });
    var n = rows.length;
    submit.disabled = discard.disabled = n === 0;
    form.classList.toggle('has-changes', n > 0);
    msg.innerHTML = '';
    if (!n) { msg.appendChild(plain('No changes yet')); }
    else {
      var names = rows.map(function (i) { return i.getAttribute('data-unit-name'); });
      var b = document.createElement('b'); b.textContent = n + (n === 1 ? ' change' : ' changes');
      var rest = document.createElement('span'); rest.className = 'pat-foot-names';
      rest.textContent = ' not saved yet · ' + names.join(', '); rest.title = names.join(', ');
      msg.appendChild(b); msg.appendChild(rest);
    }
    // the confirm box's words, set now so they are there when the submit fires
    var list = [], locked = [];
    rows.forEach(function (i) {
      var o = num(i.getAttribute('data-orig')), nn = num(i.value), so = state(o), sn = state(nn);
      list.push(i.getAttribute('data-unit-name') + ' · ' + (o === null ? 'not entered' : o + '%') + ' → ' + (nn === null ? 'cleared' : nn + '%')
        + ' · ' + (so === null ? 'Normal (not entered)' : NAMES[so]) + ' → ' + (sn === null ? 'Normal (not entered)' : NAMES[sn]));
      if (i.getAttribute('data-locked')) locked.push(i.getAttribute('data-unit-name') + "'s BU CEO locked its calibration on " + i.getAttribute('data-locked') + ', on the ' + i.getAttribute('data-locked-curve') + ' curve');
    });
    var g = form.getAttribute('data-group');
    var text = 'Save the PAT achievement for ' + n + ' unit' + (n === 1 ? '' : 's') + ' in ' + g
      + "? It picks the curve each unit's performance ratings are calibrated against. A blank figure clears it and the unit goes back to the normal curve.";
    if (locked.length) text += ' ' + locked.join(', ') + ". If this changes the curve, the locked result stays as it is and sits off the new one: the unit is flagged here, and you can fit it to the new curve with AI, with your remark.";
    form.setAttribute('data-confirm', n ? text : base);
    form.setAttribute('data-confirm-list', JSON.stringify(list));
    form.setAttribute('data-confirm-ok', 'Save ' + n + ' unit' + (n === 1 ? '' : 's'));
    return n;
  }

  inputs.forEach(function (i) { i.addEventListener('input', refresh); i.addEventListener('change', refresh); });
  discard.addEventListener('click', function () {
    inputs.forEach(function (i) { i.value = i.getAttribute('data-orig'); });
    refresh();
  });
  window.addEventListener('beforeunload', function (e) {
    if (form.__confirmed || !form.classList.contains('has-changes')) return;
    e.preventDefault(); e.returnValue = '';
  });
  refresh();
})();
