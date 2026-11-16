/* Stop someone's reminder emails (Chris, 2026-11-01, canvas boards A2 / A3; templates/person/_overview.html, the panel
 * "emailoff"). The form is plain HTML that posts to admin_person_lines (action email_optout_set); the server re-checks every
 * rule (email_optout_set). This script only writes OneHR's own confirm box from what is ticked, as the form's data-confirm-*
 * attributes (base.html's dialog reads them at submit): the title, what happens, and the reason quoted; and keeps the
 * button off while no email is ticked.
 */
(function () {
  'use strict';
  var form = document.querySelector('[data-eoff-form]');
  if (!form) return;
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var name = form.getAttribute('data-eoff-name') || 'them';
  var box = document.getElementById('pp-eoff-box');
  var submit = form.querySelector('button[type="submit"]');

  function nextDay(v) {   // "2026-11-15" -> "16 Nov 2026" (the day after: the date is the end of that day, MYT)
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
    if (!m) return '';
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1));
    return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  function sync() {
    var ticked = Array.prototype.filter.call(form.querySelectorAll('[data-eoff-kind]'), function (c) { return c.checked; })
      .map(function (c) { return c.getAttribute('data-eoff-kind'); });
    var until = (form.querySelector('[data-eoff-until]') || {}).value || '';
    var why = ((form.querySelector('[data-eoff-why]') || {}).value || '').trim();
    var back = nextDay(until);
    var what = ticked.join(' and ') || 'No email';
    var verb = ticked.length === 1 ? 'stops' : 'stop';
    form.setAttribute('data-confirm-title', 'Stop reminder emails to ' + name + '?');
    form.setAttribute('data-confirm', what + ' ' + verb + ' now and ' + (back ? 'come' + (ticked.length === 1 ? 's' : '') + ' back on ' + back
      : 'stay' + (ticked.length === 1 ? 's' : '') + ' off until you turn ' + (ticked.length === 1 ? 'it' : 'them') + ' back on') +
      ". Any already queued for them is dropped. They aren't told. It's in the audit log.");
    if (box) {
      box.textContent = '';
      var lab = document.createElement('div'); lab.className = 'pp-eoff-boxk'; lab.textContent = 'Your reason';
      var qt = document.createElement('div'); qt.className = 'pp-eoff-boxq'; qt.textContent = why;
      box.appendChild(lab); box.appendChild(qt);
    }
    if (submit) submit.disabled = !ticked.length;
  }
  form.addEventListener('change', sync);
  form.addEventListener('input', sync);
  sync();
})();
