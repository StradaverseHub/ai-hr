/* OneHR date picker (2026-10-28). Replaces the browser's own date box on every date and date-time field.
 *
 * Progressive enhancement: the original <input type="date"> / <input type="datetime-local"> stays in the form as the
 * source of truth (same name, same ISO value yyyy-mm-dd / yyyy-mm-ddTHH:MM), visually hidden but in the DOM, so
 * required / min / max / form submission all keep working and the server sees no change. The picker writes
 * input.value and fires bubbling "input" and "change" events, so every existing listener keeps working.
 *
 * Opt out: data-native-date on an input. Default time: data-odp-time="HH:MM" on a datetime-local input (0-23 : 0-59;
 * anything else is ignored) is the time the popover starts with while the input has NO value (e.g. "closes" fields
 * use 23:59); an input with a value keeps its own time; no attribute = 00:00. Range: a wrapper with data-odp-range around two inputs (from, to), optional
 * data-odp-label, data-odp-cycle-start="yyyy-mm-dd" (adds the "This cycle" preset). Inputs added later are enhanced
 * (MutationObserver); window.OneHRDate.enhance(root) does a subtree by hand. "Today" is MYT, from <body data-today>
 * (the server's _today_myt()), never the browser's clock (the clock is only a fallback if the attribute is missing).
 * Look: static/style.css, the .odp- block; the layout follows the approved canvas of 2026-10-28.
 */
(function () {
  'use strict';
  if (window.OneHRDate) return;

  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DOWS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  var ICON_CAL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" style="stroke:var(--accent-ink)" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M3 10h18M8 3v4M16 3v4"></path></svg>';
  var ICON_DOWN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="stroke:var(--muted)" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';
  var ICON_PREV = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="stroke:var(--accent-ink)" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m15 6-6 6 6 6"></path></svg>';
  var ICON_NEXT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="stroke:var(--accent-ink)" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>';

  // ---- dates are integers yyyymmdd; all arithmetic in UTC so the browser's zone and DST never matter ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function key(y, m, d) { return y * 10000 + (m + 1) * 100 + d; }
  function parts(k) { return [Math.floor(k / 10000), Math.floor(k / 100) % 100 - 1, k % 100]; }
  function utc(k) { var p = parts(k); return Date.UTC(p[0], p[1], p[2]); }
  function fromUtc(ms) { var d = new Date(ms); return key(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
  function addDays(k, n) { return fromUtc(utc(k) + n * 864e5); }
  function dow(k) { return (new Date(utc(k)).getUTCDay() + 6) % 7; }   // Monday = 0
  function dim(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }
  function addMonths(k, n) {
    var p = parts(k), t = p[0] * 12 + p[1] + n, y = Math.floor(t / 12), m = ((t % 12) + 12) % 12;
    return key(y, m, Math.min(p[2], dim(y, m)));
  }
  function between(a, b) { return Math.round((utc(b) - utc(a)) / 864e5); }
  function toISO(k) { var p = parts(k); return p[0] + '-' + pad(p[1] + 1) + '-' + pad(p[2]); }
  function valid(y, m, d) { return y >= 1000 && y <= 9999 && m >= 0 && m <= 11 && d >= 1 && d <= dim(y, m); }
  function fromISO(s) {
    var r = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
    return r && valid(+r[1], +r[2] - 1, +r[3]) ? key(+r[1], +r[2] - 1, +r[3]) : null;
  }
  function parseDMY(s) {
    var r = /^\s*(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\s*$/.exec(s || '');
    return r && valid(+r[3], +r[2] - 1, +r[1]) ? key(+r[3], +r[2] - 1, +r[1]) : null;
  }
  function fmt(k, noYear) { var p = parts(k); return p[2] + ' ' + MON[p[1]] + (noYear ? '' : ' ' + p[0]); }
  function dmy(k) { if (!k) return ''; var p = parts(k); return pad(p[2]) + '/' + pad(p[1] + 1) + '/' + p[0]; }

  function todayKey() {
    var t = fromISO(document.body && document.body.getAttribute('data-today'));
    if (t) return t;
    var d = new Date();   // fallback only: a page that forgot data-today
    return key(d.getFullYear(), d.getMonth(), d.getDate());
  }

  var valDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  var cur = null;   // the open popover: {f, pop, st, ...}

  function fire(input) {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  // ---- one enhanced field -------------------------------------------------------------------------------------
  function limits(f) {
    var a = f.inputs[0], b = f.inputs[f.inputs.length - 1];
    return {
      min: fromISO(a.getAttribute('min')) || fromISO(b.getAttribute('min')),
      max: fromISO(b.getAttribute('max')) || fromISO(a.getAttribute('max'))
    };
  }
  function inRange(k, lim) { return !((lim.min && k < lim.min) || (lim.max && k > lim.max)); }

  function defaultTime(inp) {
    var m = /^(\d{1,2}):(\d{2})$/.exec((inp.getAttribute('data-odp-time') || '').trim());
    if (!m || +m[1] > 23 || +m[2] > 59) return [0, 0];
    return [+m[1], +m[2]];
  }
  function readSingle(f) {
    var v = f.inputs[0].value, k = fromISO(v);
    if (!k) { var d = defaultTime(f.inputs[0]); return { k: null, hh: d[0], mm: d[1] }; }
    var t = /T(\d{2}):(\d{2})/.exec(v);
    return { k: k, hh: t ? +t[1] : 0, mm: t ? +t[2] : 0 };
  }
  function readRange(f) {
    return { s: fromISO(f.inputs[0].value), e: fromISO(f.inputs[1].value) };
  }

  function triggerText(f) {
    if (f.type === 'range') {
      var r = readRange(f);
      if (!r.s && !r.e) return { t: 'Any date', ph: false };
      if (r.s && !r.e) return { t: 'From ' + fmt(r.s), ph: false };
      if (!r.s && r.e) return { t: 'Until ' + fmt(r.e), ph: false };
      if (r.s === r.e) return { t: fmt(r.s), ph: false };
      return { t: parts(r.s)[0] === parts(r.e)[0] ? fmt(r.s, true) + ' – ' + fmt(r.e) : fmt(r.s) + ' – ' + fmt(r.e), ph: false };
    }
    var v = readSingle(f);
    if (!v.k) return { t: 'Pick a date', ph: true };
    return { t: fmt(v.k) + (f.type === 'datetime' ? ', ' + pad(v.hh) + ':' + pad(v.mm) : ''), ph: false };
  }
  function refresh(f) {
    var t = triggerText(f), span = f.trig.querySelector('.odp-val');
    span.textContent = t.t;
    span.classList.toggle('odp-ph', t.ph);
  }

  function syncState(f) {
    var inp = f.inputs[0];
    f.trig.disabled = f.inputs.every(function (i) { return i.disabled; });
    f.trig.hidden = inp.hidden;
    if (f.trig.disabled || f.trig.hidden) { if (cur && cur.f === f) close(false); }
  }

  function labelOf(f) {
    var a = f.inputs[0].getAttribute('aria-label');
    if (f.type === 'range') return f.wrap.getAttribute('data-odp-label') || a || 'Dates';
    return a || null;
  }

  function build(f) {
    var trig = el('button', 'odp-trig');
    trig.type = 'button';
    trig.setAttribute('data-odp', f.type);
    trig.setAttribute('aria-haspopup', 'dialog');
    trig.setAttribute('aria-expanded', 'false');
    trig.innerHTML = ICON_CAL + '<span class="odp-val"></span>' + (f.type === 'range' ? ICON_DOWN : '');
    var lab = labelOf(f);
    if (lab) trig.setAttribute('aria-label', lab);
    f.trig = trig;
    var first = f.inputs[0];
    first.parentNode.insertBefore(trig, first);
    f.inputs.forEach(function (inp) {
      inp.classList.add('odp-native');
      inp.tabIndex = -1;
      inp.setAttribute('aria-hidden', 'true');
      inp._odp = f;
      // programmatic `input.value = x` keeps the trigger's text in step
      Object.defineProperty(inp, 'value', {
        configurable: true,
        get: function () { return valDesc.get.call(inp); },
        set: function (v) { valDesc.set.call(inp, v); refresh(f); }
      });
      // a label's for= or a script's focus() lands on the trigger, not the hidden box
      inp.focus = function () { trig.focus(); };
      inp.addEventListener('focus', function () { trig.focus(); setTimeout(function () { if (document.activeElement === inp) trig.focus(); }, 0); });
      // required + empty on submit: the browser's own bubble can't point at a hidden box, so mark the trigger
      inp.addEventListener('invalid', function (e) {
        e.preventDefault();
        var form = inp.form, firstBad = !(form && form.querySelector('.odp-trig.odp-bad'));
        trig.classList.add('odp-bad');
        if (firstBad) trig.focus();
      });
      inp.addEventListener('change', function () { trig.classList.remove('odp-bad'); refresh(f); });
      new MutationObserver(function () { syncState(f); }).observe(inp, { attributes: true, attributeFilter: ['disabled', 'hidden'] });
    });
    trig.addEventListener('click', function () {
      if (cur && cur.f === f) close(true); else open(f);
    });
    refresh(f);
    syncState(f);
  }

  function setupSingle(inp) {
    if (inp._odp || inp.hasAttribute('data-native-date')) return;
    var f = { type: inp.type === 'datetime-local' ? 'datetime' : 'date', inputs: [inp] };
    build(f);
  }
  function setupRange(wrap) {
    if (wrap._odpRange) return;
    var ins = Array.prototype.filter.call(wrap.querySelectorAll('input[type=date]'), function (i) { return !i._odp && !i.hasAttribute('data-native-date'); });
    if (ins.length !== 2) return;
    wrap._odpRange = true;
    build({ type: 'range', inputs: ins, wrap: wrap });
  }

  function enhance(root) {
    root = root || document;
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    var ws = Array.prototype.slice.call(root.querySelectorAll('[data-odp-range]'));
    if (root.matches && root.matches('[data-odp-range]')) ws.push(root);
    ws.forEach(setupRange);
    var ins = Array.prototype.slice.call(root.querySelectorAll('input[type=date],input[type=datetime-local]'));
    if (root.matches && root.matches('input[type=date],input[type=datetime-local]')) ins.push(root);
    ins.forEach(setupSingle);
  }

  // ---- the popover --------------------------------------------------------------------------------------------
  function close(returnFocus) {
    if (!cur) return;
    var c = cur; cur = null;
    document.removeEventListener('mousedown', c.onDown, true);
    document.removeEventListener('keydown', c.onKey, true);
    document.removeEventListener('focusin', c.onFocusIn, true);
    window.removeEventListener('scroll', c.onMove, true);
    window.removeEventListener('resize', c.onMove);
    if (c.pop.parentNode) c.pop.parentNode.removeChild(c.pop);
    c.f.trig.setAttribute('aria-expanded', 'false');
    if (returnFocus && document.contains(c.f.trig)) c.f.trig.focus();
  }

  function place(c) {
    var pop = c.pop, r = c.f.trig.getBoundingClientRect();
    if (!document.contains(c.f.trig) || (!r.width && !r.height)) { close(false); return; }
    var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    var w = pop.offsetWidth, h = pop.offsetHeight, gap = 6, edge = 8;
    var below = vh - r.bottom - gap - edge, above = r.top - gap - edge, top;
    if (h <= below) top = r.bottom + gap;
    else if (h <= above) top = r.top - gap - h;
    else top = below >= above ? r.bottom + gap : r.top - gap - h;
    top = Math.max(edge, Math.min(top, vh - h - edge));
    var left = Math.max(edge, Math.min(r.left, vw - w - edge));
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
  }

  function chev(dir, label) { return '<button type="button" class="odp-nav" data-nav="' + dir + '" aria-label="' + label + '">' + (dir < 0 ? ICON_PREV : ICON_NEXT) + '</button>'; }

  function open(f) {
    if (cur) close(false);
    var lim = limits(f), T = todayKey();
    var st = { lim: lim, T: T };
    var pop = el('div', 'odp-pop odp-' + f.type);
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', f.type === 'range' ? 'Pick a date range' : f.type === 'datetime' ? 'Pick a date and time' : 'Pick a date');
    var c = { f: f, pop: pop, st: st };
    var months, foot = {};

    function clamp(k) { if (lim.min && k < lim.min) return lim.min; if (lim.max && k > lim.max) return lim.max; return k; }

    // ---- state per kind
    if (f.type === 'range') {
      var r = readRange(f);
      st.s = r.s; st.e = r.e;
      var anchor = st.e || st.s || clamp(T);
      st.left = addMonths(key(parts(anchor)[0], parts(anchor)[1], 1), -1);
      st.cur = clamp(st.e || st.s || T);
      st.cycle = fromISO(f.wrap.getAttribute('data-odp-cycle-start'));
    } else {
      var v = readSingle(f);
      st.v = v.k; st.hh = v.hh; st.mm = v.mm;
      st.left = key(parts(v.k || clamp(T))[0], parts(v.k || clamp(T))[1], 1);
      st.cur = clamp(v.k || T);
    }

    // ---- skeleton, built once
    if (f.type === 'range') {
      pop.innerHTML =
        '<div class="odp-body"><div class="odp-presets"></div><div class="odp-months">' +
        '<div class="odp-month" data-i="0"><div class="odp-head">' + chev(-1, 'Previous month') + '<strong class="odp-title"></strong><span class="odp-navgap"></span></div><div class="odp-grid"></div></div>' +
        '<div class="odp-month" data-i="1"><div class="odp-head"><span class="odp-navgap"></span><strong class="odp-title"></strong>' + chev(1, 'Next month') + '</div><div class="odp-grid"></div></div>' +
        '</div></div>' +
        '<div class="odp-foot">' +
        '<label class="odp-fl">From <input type="text" class="odp-text" data-end="s" placeholder="dd/mm/yyyy" maxlength="10" autocomplete="off"></label>' +
        '<label class="odp-fl odp-fl2">To <input type="text" class="odp-text" data-end="e" placeholder="dd/mm/yyyy" maxlength="10" autocomplete="off"></label>' +
        '<span class="odp-span" aria-live="polite"></span>' +
        '<button type="button" class="odp-btn" data-act="clear">Clear</button>' +
        '<button type="button" class="odp-btn odp-primary" data-act="apply">Apply</button></div>';
    } else {
      var hasChips = f.type === 'date';
      var clearable = f.type === 'date' || !f.inputs[0].required;
      var foot2;
      if (f.type === 'date') {
        foot2 = '<div class="odp-foot"><input type="text" class="odp-text" data-end="v" aria-label="Type a date" placeholder="dd/mm/yyyy" maxlength="10" autocomplete="off"><span class="odp-grow"></span><button type="button" class="odp-btn odp-sm" data-act="clear">Clear</button></div>';
      } else {
        var hrs = '', mins = '', mset = {0: 1, 15: 1, 30: 1, 45: 1}, i;
        for (i = 0; i < 24; i++) hrs += '<option value="' + i + '">' + pad(i) + '</option>';
        var mlist = [0, 15, 30, 45]; if (!mset[st.mm]) { mlist.push(st.mm); mlist.sort(function (a, b) { return a - b; }); }
        mlist.forEach(function (m) { mins += '<option value="' + m + '">' + pad(m) + '</option>'; });
        foot2 = '<div class="odp-foot odp-foot-t"><label class="odp-tl">Time <select class="odp-tsel" data-t="hh" aria-label="Hour">' + hrs + '</select></label><span>:</span>' +
          '<select class="odp-tsel" data-t="mm" aria-label="Minute">' + mins + '</select><span class="odp-grow odp-tz">MYT</span>' +
          '<button type="button" class="odp-btn odp-primary odp-sm" data-act="apply">Apply</button></div>' +
          (clearable ? '<div class="odp-foot odp-foot-c"><button type="button" class="odp-btn odp-sm" data-act="clear">Clear</button></div>' : '');
      }
      pop.innerHTML = (hasChips ? '<div class="odp-chips"></div>' : '') +
        '<div class="odp-month" data-i="0"><div class="odp-head">' + chev(-1, 'Previous month') + '<strong class="odp-title" aria-live="polite"></strong>' + chev(1, 'Next month') + '</div><div class="odp-grid"></div></div>' + foot2;
    }
    document.body.appendChild(pop);
    months = pop.querySelectorAll('.odp-month');
    var hhSel = pop.querySelector('[data-t=hh]'), mmSel = pop.querySelector('[data-t=mm]');
    if (hhSel) { hhSel.value = String(st.hh); mmSel.value = String(st.mm); }

    // ---- painting
    function dayHTML(k, y, m, mode) {
      var cls = 'odp-day', off = !inRange(k, lim), sel, mid = false;
      if (mode === 'range') {
        sel = k === st.s || k === st.e;
        mid = !!(st.s && st.e && k > st.s && k < st.e);
      } else sel = k === st.v;
      if (off) cls += ' odp-off';
      if (sel) cls += ' odp-sel'; else if (mid) cls += ' odp-mid';
      if (k === T && !sel) cls += ' odp-today';
      var p = parts(k);
      return '<button type="button" class="' + cls + '" data-k="' + k + '" tabindex="' + (k === st.cur ? 0 : -1) + '" aria-label="' + p[2] + ' ' + FULL[p[1]] + ' ' + p[0] +
        (off ? ', not available' : '') + (sel ? ', selected' : '') + '">' + p[2] + '</button>';
    }
    function gridHTML(first, mode) {
      var y = parts(first)[0], m = parts(first)[1], off = dow(first), n = dim(y, m), h = '', i;
      for (i = 0; i < DOWS.length; i++) h += '<span class="odp-dow">' + DOWS[i] + '</span>';
      for (i = 0; i < off; i++) h += '<span class="odp-blank"></span>';
      for (i = 1; i <= n; i++) h += dayHTML(key(y, m, i), y, m, mode);
      return h;
    }
    function paint() {
      var mode = f.type === 'range' ? 'range' : 'one';
      var n = f.type === 'range' ? 2 : 1, i;
      for (i = 0; i < n; i++) {
        var first = addMonths(st.left, i), p = parts(first);
        months[i].querySelector('.odp-title').textContent = FULL[p[1]] + ' ' + p[0];
        months[i].querySelector('.odp-grid').innerHTML = gridHTML(first, mode);
      }
      // a month with every day off would leave no tab stop: give the first pickable day one
      if (!pop.querySelector('.odp-day[tabindex="0"]')) {
        var any = pop.querySelector('.odp-day:not(.odp-off)') || pop.querySelector('.odp-day');
        if (any) any.tabIndex = 0;
      }
      paintExtras();
      place(c);
    }
    function paintExtras() {
      var q;
      if (f.type === 'range') {
        var defs = presetDefs(), ph = '';
        defs.forEach(function (d, i) {
          var on = d.s === st.s && d.e === st.e && !(d.id !== 'any' && !d.s);
          ph += '<button type="button" class="odp-preset' + (on ? ' on' : '') + '" data-p="' + i + '">' + d.label + '</button>';
        });
        pop.querySelector('.odp-presets').innerHTML = ph;
        foot.defs = defs;
        setText(pop.querySelector('[data-end=s]'), dmy(st.s));
        setText(pop.querySelector('[data-end=e]'), dmy(st.e));
        var days = st.s && st.e ? between(st.s, st.e) + 1 : 0;
        pop.querySelector('.odp-span').textContent = !st.s ? 'Every date' : !st.e ? 'Now pick the last day' : days + (days === 1 ? ' day' : ' days');
      } else if (f.type === 'date') {
        setText(pop.querySelector('[data-end=v]'), dmy(st.v));
        q = pop.querySelector('.odp-chips');
        var ch = '', seen = {};
        quickDates().forEach(function (d) {
          if (!inRange(d.k, lim) || seen[d.k]) return;
          seen[d.k] = 1;
          ch += '<button type="button" class="odp-chip' + (st.v === d.k ? ' on' : '') + '" data-q="' + d.k + '">' + d.label + '</button>';
        });
        q.innerHTML = ch;
        q.hidden = !ch;
      }
    }
    function setText(inp, v) { if (inp && document.activeElement !== inp) { inp.value = v; inp.classList.remove('odp-bad'); } }
    function quickDates() {
      var nm = addDays(T, 7 - dow(T));   // the Monday after today (a Monday today gives the next one)
      return [{ label: 'Today', k: T }, { label: 'Tomorrow', k: addDays(T, 1) }, { label: 'Next Monday', k: nm }];
    }
    function presetDefs() {
      var t = lim.max && lim.max < T ? lim.max : T, p = parts(t), d = [];
      function c(s, e) { if (s && lim.min && s < lim.min) s = lim.min; if (e && lim.max && e > lim.max) e = lim.max; return { s: s, e: e }; }
      function add(id, label, s, e) { var x = c(s, e); d.push({ id: id, label: label, s: x.s, e: x.e }); }
      add('any', 'Any date', null, null);
      add('t', 'Today', t, t);
      add('l7', 'Last 7 days', addDays(t, -6), t);
      add('l30', 'Last 30 days', addDays(t, -29), t);
      add('tm', 'This month', key(p[0], p[1], 1), t);
      var pm = addMonths(key(p[0], p[1], 1), -1);
      add('lm', 'Last month', pm, key(parts(pm)[0], parts(pm)[1], dim(parts(pm)[0], parts(pm)[1])));
      if (st.cycle && st.cycle <= t) add('cy', 'This cycle', st.cycle, t);
      return d;
    }

    // ---- committing
    function writeSingle(k, hh, mm) {
      var inp = f.inputs[0], nv = k ? toISO(k) + (f.type === 'datetime' ? 'T' + pad(hh) + ':' + pad(mm) : '') : '';
      var changed = nv !== valDesc.get.call(inp);
      valDesc.set.call(inp, nv);
      refresh(f);
      if (changed) fire(inp);
    }
    function writeRange() {
      var vals = [st.s ? toISO(st.s) : '', st.e ? toISO(st.e) : ''];
      f.inputs.forEach(function (inp, i) {
        var changed = vals[i] !== valDesc.get.call(inp);
        valDesc.set.call(inp, vals[i]);
        if (changed) fire(inp);
      });
      refresh(f);
    }
    function showMonthOf(k, keepLeft) {
      var first = key(parts(k)[0], parts(k)[1], 1);
      if (f.type === 'range') {
        var right = addMonths(st.left, 1);
        if (first < st.left) st.left = first;
        else if (first > right) st.left = addMonths(first, -1);
      } else st.left = first;
    }
    function moveRangeView(d) { st.left = addMonths(st.left, d); }

    function pick(k) {
      if (!inRange(k, lim)) return;
      st.cur = k;
      if (f.type === 'date') { writeSingle(k); close(true); return; }
      if (f.type === 'datetime') { st.v = k; paint(); return; }
      if (!st.s || st.e) { st.s = k; st.e = null; }
      else if (k < st.s) st.s = k;
      else st.e = k;
      if (st.s && st.e) writeRange();
      paint();
    }
    function typed(inp, closeAfter) {
      var raw = inp.value.trim(), end = inp.getAttribute('data-end');
      if (!raw) { inp.classList.remove('odp-bad'); return; }
      var k = parseDMY(raw);
      if (!k || !inRange(k, lim) || (end === 'e' && st.s && k < st.s)) { inp.classList.add('odp-bad'); return; }
      inp.classList.remove('odp-bad');
      st.cur = k;
      showMonthOf(k);
      if (end === 'v') { if (closeAfter) { writeSingle(k); close(true); } else { st.v = k; writeSingle(k); paint(); } return; }
      if (end === 's') { st.s = k; if (st.e && st.e < k) st.e = null; }
      else st.e = k;
      if ((st.s && st.e) || (!st.s && !st.e)) writeRange();
      var was = document.activeElement; paint(); if (was && was !== document.body && document.contains(was)) { try { was.focus(); } catch (x) { } }
    }
    function doClear() {
      if (f.type === 'range') { st.s = null; st.e = null; writeRange(); paint(); return; }
      st.v = null; writeSingle(null); close(true);
    }

    // ---- events
    pop.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || !pop.contains(b)) return;
      if (b.classList.contains('odp-day')) { pick(+b.getAttribute('data-k')); return; }
      if (b.hasAttribute('data-nav')) {
        var d = +b.getAttribute('data-nav');
        if (f.type === 'range') moveRangeView(d); else st.left = addMonths(st.left, d);
        var shown = parts(st.cur), lo = st.left, hi = f.type === 'range' ? addMonths(st.left, 1) : st.left;
        var ck = key(shown[0], shown[1], 1);
        if (ck < lo || ck > hi) st.cur = key(parts(lo)[0], parts(lo)[1], Math.min(shown[2], dim(parts(lo)[0], parts(lo)[1])));
        paint();
        return;
      }
      if (b.hasAttribute('data-q')) { var qk = +b.getAttribute('data-q'); writeSingle(qk); close(true); return; }
      if (b.hasAttribute('data-p')) {
        var def = foot.defs[+b.getAttribute('data-p')];
        st.s = def.s; st.e = def.e;
        if (def.e) { st.cur = def.e; var ea = key(parts(def.e)[0], parts(def.e)[1], 1); st.left = addMonths(ea, -1); }
        writeRange(); paint();
        return;
      }
      var act = b.getAttribute('data-act');
      if (act === 'clear') doClear();
      else if (act === 'apply') {
        if (f.type === 'datetime') {
          if (!st.v) { var g = pop.querySelector('.odp-day[tabindex="0"]'); if (g) g.focus(); return; }
          writeSingle(st.v, +hhSel.value, +mmSel.value);
        }
        close(true);
      }
    });
    pop.addEventListener('change', function (e) {
      if (e.target === hhSel || e.target === mmSel) { st.hh = +hhSel.value; st.mm = +mmSel.value; }
    });
    pop.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t.classList && t.classList.contains('odp-text')) {
        if (e.key === 'Enter') { e.preventDefault(); typed(t, true); }
        else t.classList.remove('odp-bad');
        return;
      }
      if (!(t.classList && t.classList.contains('odp-day'))) return;
      var k = +t.getAttribute('data-k'), n = null;
      switch (e.key) {
        case 'ArrowLeft': n = addDays(k, -1); break;
        case 'ArrowRight': n = addDays(k, 1); break;
        case 'ArrowUp': n = addDays(k, -7); break;
        case 'ArrowDown': n = addDays(k, 7); break;
        case 'Home': n = addDays(k, -dow(k)); break;
        case 'End': n = addDays(k, 6 - dow(k)); break;
        case 'PageUp': n = addMonths(k, -1); break;
        case 'PageDown': n = addMonths(k, 1); break;
        default: return;
      }
      e.preventDefault();
      n = clamp(n);
      if (n === k) return;
      st.cur = n;
      showMonthOf(n);
      paint();
      var nb = pop.querySelector('.odp-day[data-k="' + n + '"]');
      if (nb) nb.focus();
    });
    pop.addEventListener('focusout', function (e) {
      var t = e.target;
      if (t.classList && t.classList.contains('odp-text')) typed(t, false);
    });

    c.onDown = function (e) { if (!pop.contains(e.target) && !f.trig.contains(e.target)) close(false); };
    c.onKey = function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } };
    c.onFocusIn = function (e) { if (!pop.contains(e.target) && !f.trig.contains(e.target)) close(false); };
    c.onMove = function (e) { if (cur === c && !(e && e.target && pop.contains(e.target))) place(c); };
    document.addEventListener('mousedown', c.onDown, true);
    document.addEventListener('keydown', c.onKey, true);
    document.addEventListener('focusin', c.onFocusIn, true);
    window.addEventListener('scroll', c.onMove, true);
    window.addEventListener('resize', c.onMove);

    cur = c;
    f.trig.setAttribute('aria-expanded', 'true');
    paint();
    var tab = pop.querySelector('.odp-day[tabindex="0"]');
    if (tab) tab.focus();
  }

  window.OneHRDate = { enhance: enhance };

  function start() {
    enhance(document);
    new MutationObserver(function (list) {
      list.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes, function (n) { if (n.nodeType === 1 && !(n.classList && n.classList.contains('odp-pop'))) enhance(n); });
      });
    }).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('reset', function (e) {
      setTimeout(function () {
        Array.prototype.forEach.call(e.target.querySelectorAll ? e.target.querySelectorAll('.odp-native') : [], function (i) { if (i._odp) { refresh(i._odp); i._odp.trig.classList.remove('odp-bad'); } });
      }, 0);
    });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
