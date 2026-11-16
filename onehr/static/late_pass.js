/* Give a late pass (Chris, 2026-10-31, canvas "OneHR Late pass", boards A2 / A3 / L2; templates/person/_overview.html, the
 * panel "latepass"). The form is plain HTML that posts to admin_person_late_give; the server re-checks every rule
 * (_late_give). One Give covers every part ticked (all ticked to begin with; at least one stays ticked: Give is disabled
 * with a line when none is). This script only (1) keeps the panel honest as it is filled -- the units a Talent Box pass
 * opens for each ticked part, the line manager's tick shown if ANY ticked part has a line manager step, the reason's count
 * -- and (2) writes OneHR's own confirm box from what is ticked, as the form's data-confirm-* attributes (base.html's
 * dialog reads them at submit): the title, what happens, a "What else changes" list (no line twice) and the reason
 * quoted. A Give button on the card (data-late-pick) opens the panel with ONLY its part ticked.
 */
(function () {
  'use strict';
  var form = document.querySelector('[data-late-form]');
  if (!form) return;
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var name = form.getAttribute('data-late-name') || 'them';
  var lmName = form.getAttribute('data-late-lm') || '';
  var box = document.getElementById('pp-late-box');

  function fmt(v) {   // "2026-11-13T23:59" -> "13 Nov 2026, 23:59"
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(v || '');
    return m ? (parseInt(m[3], 10) + ' ' + MON[parseInt(m[2], 10) - 1] + ' ' + m[1] + ', ' + m[4] + ':' + m[5]) : '';
  }
  function ticked() { return Array.prototype.slice.call(form.querySelectorAll('input[name="part"]:checked')); }
  function q(sel) { return form.querySelector(sel); }
  function uniq(list) { return list.filter(function (x, i) { return x && list.indexOf(x) === i; }); }
  function join(words) {   // ['a', 'b', 'c'] -> 'a, b and c'
    return words.length < 2 ? (words[0] || '') : words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1];
  }
  function cap(t) { return t ? t.charAt(0).toUpperCase() + t.slice(1) : t; }
  function at(r, k) { return r.getAttribute('data-late-' + k) || ''; }

  function sync() {
    var rs = ticked(), many = rs.length > 1;
    var none = q('[data-late-none]'), go = q('button[type="submit"]');
    if (none) none.hidden = rs.length > 0;
    if (go) go.disabled = rs.length === 0;   // at least one part stays ticked (the server refuses none too)
    var vals = rs.map(function (r) { return r.value; });
    Array.prototype.forEach.call(form.querySelectorAll('[data-late-units]'), function (el) {
      el.hidden = vals.indexOf(el.getAttribute('data-late-units')) < 0;
    });
    // the parts with a line manager step: the follow-on applies to each of them
    var lmParts = rs.filter(function (r) { return !!at(r, 'lm'); });
    var lmOk = lmParts.length > 0;
    var lmBox = q('[data-late-lmbox]'), tick = q('[data-late-lmtick]'), lmUntil = q('[data-late-lmuntil]');
    if (lmBox) lmBox.hidden = !lmOk;
    var lmOn = !!(lmOk && tick && tick.checked);
    if (lmUntil) { lmUntil.disabled = !lmOn; lmUntil.required = lmOn; }
    if (tick) { tick.disabled = !lmOk; }
    var lmLabel = q('[data-late-lmlabel]');
    if (lmLabel && lmOk) {
      lmLabel.textContent = lmParts.length > 1 ? 'Give their line manager time to review these too'
        : 'Give their line manager time to moderate it too';
    }
    var lmHelp = q('[data-late-lmhelp]');
    if (lmHelp && lmOk) {
      var closes = uniq(lmParts.map(function (r) { return at(r, 'lmclose'); }));
      if (lmParts.length === 1) {
        lmHelp.textContent = 'Used only if they submit after the line manager window closes' +
          (closes[0] ? ' (' + closes[0] + ')' : '') + '. It ends when ' + lmName + ' acts on it.';
      } else {
        lmHelp.textContent = 'For each part that has a line manager step (' +
          join(lmParts.map(function (r) { return at(r, 'what'); })) + '): used only if they submit after that step closes' +
          (closes.length === 1 ? ' (' + closes[0] + ')' : closes.length > 1 ? ' (' + join(lmParts.map(function (r) {
            return at(r, 'what') + ' ' + (at(r, 'lmclose') || 'its date');
          })) + ')' : '') + '. It ends when ' + lmName + ' acts on it.';
      }
    }
    var kinds = uniq(rs.map(function (r) { return at(r, 'kind') || 'own'; }));
    var own = rs.filter(function (r) { return (at(r, 'kind') || 'own') === 'own'; });
    var behalfParts = own.filter(function (r) { return !!at(r, 'behalf'); });
    var lead = kinds.filter(function (k) { return k !== 'own'; });
    var END = { bg: 'It ends when they lock the last open unit.', hod: 'It ends when they submit.',
      gc: 'It ends when they lock the group.', bu: 'It ends when they lock it.' };
    var help = q('[data-late-help]');
    if (help && rs.length) {
      var hs = [];
      if (own.length) {
        hs.push('Any time before results go out.');
        if (behalfParts.length === 1) hs.push("While it is open, their line manager can't assess this part on their behalf.");
        else if (behalfParts.length > 1) hs.push("While they are open, their line manager can't assess the " +
          join(behalfParts.map(function (r) { return at(r, 'what'); })) + ' on their behalf.');
      }
      if (lead.length) {
        hs.push('Any time before results are released to leaders.');
        hs.push(lead.length === 1 ? (END[lead[0]] || END.bu) : 'It ends when they lock or submit each one.');
      }
      help.textContent = hs.join(' ');
    }
    var until = form.elements.until ? fmt(form.elements.until.value) : '';
    var why = (q('[data-late-why]') || {}).value || '';
    var items = [];
    // when each part closed: one line a date, naming the parts when there are several
    var byClosed = {};
    rs.forEach(function (r) { var c = at(r, 'closed'); if (c) (byClosed[c] = byClosed[c] || []).push(at(r, 'what') || 'this part'); });
    Object.keys(byClosed).forEach(function (c) {
      items.push(many ? 'The ' + join(byClosed[c]) + ' closed on ' + c + ' and ' + (byClosed[c].length > 1 ? 'stay' : 'stays') +
        ' closed for everyone else.' : 'It closed on ' + c + ' and stays closed for everyone else.');
    });
    if (behalfParts.length && lmName) {
      items.push(many ? lmName + " can't assess the " + join(behalfParts.map(function (r) { return at(r, 'what'); })) +
        ' on their behalf while ' + (behalfParts.length > 1 ? 'the passes are' : 'the pass is') + ' open.'
        : lmName + " can't assess it on their behalf while the pass is open.");
    }
    if (lmOn) {
      lmParts.forEach(function (r) {
        var lc2 = at(r, 'lmclose');
        items.push('If they submit' + (many ? ' the ' + at(r, 'what') : '') + (lc2 ? ' after ' + lc2 : ' late') + ', ' + lmName +
          ' has until ' + (fmt(lmUntil && lmUntil.value) || 'the time you pick') + ' to ' + (at(r, 'lmverb') || 'review') + ' it.');
      });
    }
    if (kinds.indexOf('bg') >= 0) items.push('A unit that is locked stays locked.');
    if (kinds.indexOf('hod') >= 0) items.push('If their BU CEO or BG CEO locks first, it closes then: the higher tier wins.');
    items.push(name + ' gets a note in OneHR and an email with your reason.');
    items = uniq(items);
    var what = join(rs.map(function (r) { return at(r, 'what') || 'this part'; }));
    form.setAttribute('data-confirm-title', rs.length !== 1 ? 'Give ' + name + ' a late pass?'
      : 'Give ' + name + ' a late pass for the ' + what + '?');
    form.setAttribute('data-confirm', many
      ? cap(what) + ' open for them alone until ' + (until || 'the time you pick') + '. What they already entered stays as it is.'
      : 'It opens for them alone until ' + (until || 'the time you pick') + '. What they already entered stays as it is.');
    form.setAttribute('data-confirm-list', JSON.stringify(items));
    if (box) {
      box.textContent = '';
      var lab = document.createElement('div'); lab.className = 'pp-late-boxk'; lab.textContent = 'Your reason';
      var qt = document.createElement('div'); qt.className = 'pp-late-boxq'; qt.textContent = '“' + why.trim() + '”';
      box.appendChild(lab); box.appendChild(qt);
    }
    var cnt = q('[data-late-count]');
    if (cnt) cnt.textContent = why.length + ' / 500';
  }

  form.addEventListener('change', sync);
  form.addEventListener('input', sync);
  // ONLY the part `key` ticked
  function pick(key) {
    Array.prototype.forEach.call(form.querySelectorAll('input[name="part"]'), function (r) { r.checked = r.value === key; });
    sync();
  }
  // a Give button on the card picks its part, then admin.js opens the panel
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-late-pick]');
    if (!b) return;
    pick(b.getAttribute('data-late-pick'));
  });
  sync();
  // a link from a list panel on another leader's page (a BG CEO's unit, 2026-11-09): ?panel=latepass&late_pick=<cell|scope> opens the
  // page with that part picked, by the same code
  try {
    var lp = new URLSearchParams(location.search).get('late_pick');
    if (lp) pick(lp);
  } catch (er) { /* no URLSearchParams: all parts stay ticked, as before */ }
})();
