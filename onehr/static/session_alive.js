/* OneHR signs someone out after an hour with no activity (app.py SESSION_IDLE_MIN, Chris 2026-11-02; canvas
   [design canvas link removed]). Ten minutes before (SESSION_WARN_MIN) this raises a box, "Are you still
   there?", with a live countdown and two buttons: Log me out, Stay signed in. base.html loads it only for who the idle limit
   covers (not the super admin, system admin or an admin whose role has Inactivity sign-out off) and passes data-idle-sec, data-warn-sec and the three addresses.

   Activity is shared by every OneHR tab of the browser through localStorage (onehr.idle.last, the newest wins), so working in
   one tab keeps the others from asking. Typing, clicking, the wheel, touching and (a few seconds apart) moving the pointer
   count, though they send nothing: someone writing a long remark is not signed out under it. At most once a minute that
   activity pings /session/alive, which the server counts, so its clock stays within a minute of the page's. While the box is
   open nothing but Stay counts (Esc, Enter on Stay, a click outside the box are all Stay): moving the pointer toward
   Log me out must not close it. Scrolling is NOT listened for: a capture listener hears every element's scroll, programmatic
   ones too (a chat scrolling itself as a reply streams), so a page could count itself active with nobody there. A person's own
   scrolling starts with the wheel, a key, a touch or a pointerdown (a scrollbar drag), all of which count.

   At the hour the page goes to the sign-out address with ?why=idle (a same-origin GET the server allows for it), which ends the
   session and lands on the sign-in page with its one sentence.
   Other tabs hear it (onehr.idle.out) and follow. Log me out is the normal sign-out (a POST with the form token, no message). */
(function () {
  'use strict';
  var me = document.currentScript;
  if (!me) return;
  function num(a, d) { var n = parseInt(me.getAttribute(a), 10); return n > 0 ? n : d; }
  var IDLE = num('data-idle-sec', 3600) * 1000;
  var WARN = Math.min(num('data-warn-sec', 600) * 1000, IDLE - 1000);
  var ALIVE = me.getAttribute('data-alive') || '/session/alive';
  var LOGOUT = me.getAttribute('data-logout');
  if (!LOGOUT) return;                                            // base.html always gives it; without it there is nothing to sign out with
  var LOGIN = me.getAttribute('data-login') || '/login';
  var KEY = 'onehr.idle.last', OUT = 'onehr.idle.out';
  var PING_EVERY = 60000, MOVE_EVERY = 5000, WRITE_EVERY = 1000, SLOW_TICK = 15000, PEEK_EVERY = 15000;

  // localStorage, every access guarded: a private window or blocked storage falls back to this tab's own memory
  var mem = {};
  function lsGet(k) { try { var v = localStorage.getItem(k); if (v !== null) return v; } catch (e) { /* blocked */ } return mem[k] === undefined ? null : mem[k]; }
  function lsSet(k, v) { mem[k] = v; try { localStorage.setItem(k, v); } catch (e) { /* blocked */ } }

  var now0 = Date.now();
  var localLast = now0, lastWrite = 0, lastMove = 0, lastPing = now0, busy = false;   // the page's own load was activity
  var box = null, boxRefs = null, lastFocus = null, timer = null, srvDeadline = null, lastPeek = 0, lastMinute = null;
  var leaving = false, told = false, exempt = false;   // exempt: the server says this account is no longer covered (a role switched off while the page was open)

  function lastActivity() {
    var v = Number(lsGet(KEY));            // shared with every tab (this tab's own writes are mirrored in mem); localLast only before the first write
    return v > 0 && isFinite(v) ? v : localLast;
  }
  function idleMs() { return Math.max(0, Date.now() - lastActivity()); }

  function touch(force) {
    var t = Date.now();
    localLast = t;
    if (force || t - lastWrite >= WRITE_EVERY) { lastWrite = t; lsSet(KEY, String(t)); }
  }

  // ---- the server's clock ------------------------------------------------------------------------------------------
  function ended(d) {
    if (d.why === 'idle' || box) { toLogin(); return; }
    if (!told && window.openNotice) { told = true; window.openNotice(d.say); }   // another reason (password changed, signed out elsewhere)
  }
  function toLogin() {
    if (leaving) return;
    leaving = true;
    lsSet(OUT, 'idle|' + Date.now());
    location.replace(LOGIN + '?signed_out=idle');
  }
  function ask(url, done) {
    fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) { if (d.signed_in === false) ended(d); else if (done) done(d); } })
      .catch(function () { /* offline: the next activity asks again */ });
  }
  function ping(force) {
    var t = Date.now();
    if (leaving || (!force && (busy || t - lastPing < PING_EVERY))) return;
    lastPing = t; busy = true;
    fetch(ALIVE, { credentials: 'same-origin', cache: 'no-store', headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.signed_in === false) ended(d); })
      .catch(function () { /* offline: the next activity asks again */ })
      .then(function () { busy = false; });
  }
  // while the box shows, read the server's own count (it counts nothing): if the server's clock is the shorter, that is the time left
  function peek() {
    lastPeek = Date.now();
    ask(ALIVE + (ALIVE.indexOf('?') < 0 ? '?peek=1' : '&peek=1'), function (d) {
      if (d.idle_left === null) { exempt = true; closeBox(); clearTimeout(timer); return; }   // no longer covered: no box, no time-out from this page
      if (box && typeof d.idle_left === 'number') srvDeadline = Date.now() + d.idle_left * 1000;
    });
  }

  // ---- the box -----------------------------------------------------------------------------------------------------
  function mmss(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function minutesWords(ms) {
    var m = Math.max(1, Math.round(ms / 60000));
    return m + (m === 1 ? ' minute' : ' minutes');
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function openBox() {
    if (box) return;
    lastFocus = document.activeElement;
    var ov = el('div', 'modal-overlay confirm-dialog idle-dialog');
    var card = el('div', 'modal-card');
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'idle-dialog-title');
    card.setAttribute('aria-describedby', 'idle-dialog-msg');
    var head = el('div', 'confirm-dialog__head');
    var icon = el('span', 'confirm-dialog__icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
    var h = el('h2', '', 'Are you still there?');
    h.id = 'idle-dialog-title';
    head.appendChild(icon); head.appendChild(h);
    var p = el('p', 'confirm-dialog__msg', "You've been inactive for a while now. We'll sign you out if there's no activity in the next " + minutesWords(WARN) + '.');
    p.id = 'idle-dialog-msg';
    var count = el('div', 'idle-count');
    var row = el('div', 'idle-count__row');
    var lab = el('span', 'idle-count__label', 'Signing you out in');
    var time = el('span', 'idle-count__time', mmss(WARN));
    time.setAttribute('aria-live', 'off');
    row.appendChild(lab); row.appendChild(time);
    var bar = el('div', 'idle-count__bar');
    var fill = el('span', 'idle-count__fill');
    bar.appendChild(fill);
    count.appendChild(row); count.appendChild(bar);
    var sr = el('div', 'sr-only');
    sr.setAttribute('aria-live', 'polite');
    var acts = el('div', 'modal-actions');
    var out = el('button', 'btn-link', 'Log me out'); out.type = 'button';
    var stayB = el('button', 'primary', 'Stay signed in'); stayB.type = 'button';
    acts.appendChild(out); acts.appendChild(stayB);
    card.appendChild(head); card.appendChild(p); card.appendChild(count); card.appendChild(sr); card.appendChild(acts);
    ov.appendChild(card);
    document.body.appendChild(ov);
    box = ov; boxRefs = { time: time, fill: fill, sr: sr, out: out, stay: stayB };
    lastMinute = null; srvDeadline = null;
    stayB.addEventListener('click', stay);
    out.addEventListener('click', logOut);
    ov.addEventListener('click', function (ev) { if (ev.target === ov) stay(); });
    setTimeout(function () { if (box === ov) stayB.focus(); }, 30);
    peek();
  }
  function closeBox() {
    if (!box) return;
    box.remove(); box = null; boxRefs = null; srvDeadline = null;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* gone */ } }
  }
  function render() {
    var deadline = lastActivity() + IDLE;
    if (srvDeadline && srvDeadline < deadline) deadline = srvDeadline;
    var left = deadline - Date.now();
    if (left <= 0) { timeOut(); return; }
    boxRefs.time.textContent = mmss(left);
    boxRefs.fill.style.width = Math.max(0, Math.min(100, left / WARN * 100)) + '%';
    var m = Math.ceil(left / 60000);
    if (lastMinute !== null && m !== lastMinute) boxRefs.sr.textContent = 'Signing you out in ' + minutesWords(left) + '.';
    lastMinute = m;
    if (Date.now() - lastPeek >= PEEK_EVERY) peek();
  }

  // ---- what ends it ------------------------------------------------------------------------------------------------
  function stay() {
    touch(true);
    ping(true);
    closeBox();
    check();
  }
  function logOut() {
    if (leaving) return;
    leaving = true;
    lsSet(OUT, 'out|' + Date.now());
    var m = document.querySelector('meta[name="csrf-token"]');
    var f = document.createElement('form');
    f.method = 'post'; f.action = LOGOUT; f.hidden = true;
    var i = document.createElement('input');
    i.type = 'hidden'; i.name = 'csrf_token'; i.value = m ? m.getAttribute('content') : '';
    f.appendChild(i); document.body.appendChild(f);
    f.submit();
  }
  function timeOut() {
    if (leaving) return;
    leaving = true;
    lsSet(OUT, 'idle|' + Date.now());
    location.replace(LOGOUT + '?why=idle');
  }

  // ---- the clock ---------------------------------------------------------------------------------------------------
  function check() {
    if (leaving || exempt) return;
    clearTimeout(timer);
    var idle = idleMs();
    if (idle >= IDLE) { timeOut(); return; }
    if (idle >= IDLE - WARN) { if (!box) openBox(); render(); }
    else if (box) closeBox();
    if (leaving) return;
    timer = setTimeout(check, box ? 1000 : Math.max(500, Math.min(SLOW_TICK, IDLE - WARN - idle)));
  }

  function onActivity(e) {
    if (leaving || box || exempt) return;                         // while the box is open only its own buttons count
    var t = Date.now();
    if (e.type === 'pointermove') { if (t - lastMove < MOVE_EVERY) return; lastMove = t; }
    if (idleMs() >= IDLE) { timeOut(); return; }                  // woke after the hour: out, not saved by a keypress
    touch(false);
    ping(false);
  }
  ['keydown', 'pointerdown', 'wheel', 'input', 'touchstart', 'pointermove'].forEach(function (ev) {
    document.addEventListener(ev, onActivity, { capture: true, passive: true });
  });

  document.addEventListener('keydown', function (ev) {
    if (!box) return;
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); stay(); return; }
    if (ev.key === 'Tab') {                                       // keep focus inside the box
      var a = boxRefs.out, b = boxRefs.stay, cur = document.activeElement;
      if (ev.shiftKey && cur === a) { ev.preventDefault(); b.focus(); }
      else if (!ev.shiftKey && cur === b) { ev.preventDefault(); a.focus(); }
      else if (cur !== a && cur !== b) { ev.preventDefault(); b.focus(); }
    }
  }, true);

  window.addEventListener('storage', function (ev) {
    if (ev.key === KEY) { check(); return; }                      // activity or Stay in another tab
    if (ev.key === OUT && ev.newValue && !leaving) {
      leaving = true;
      location.replace(ev.newValue.indexOf('idle') === 0 ? LOGOUT + '?why=idle' : LOGOUT);
    }
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
  window.addEventListener('focus', check);
  window.addEventListener('pageshow', check);

  touch(true);
  check();
})();
