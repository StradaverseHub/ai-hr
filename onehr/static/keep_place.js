/* Keep my place (Chris 2026-11-09: "currently switching between the tab, the page will refresh and bring me up to the top,
   it should stay at the same view, this should apply across all pages").
   A tab, filter or chip that reloads the SAME page with a new query string lands where you were, not at the top.
   Save: a plain left click on a same-page link, a GET form to the same page (a submit event, or form.submit() which fires
   none: patched below), and the few JS reloads, which call window.keepPlace() right before they go.
   Restore: on the way in, once, only for the same path, within 30 s, and only for a fresh navigation (a reload and the
   back / forward buttons are the browser's own).
   NOT kept (opens at the top as before): a link with a #hash, another target, a download, a list opener (data-list-open),
   anything marked data-scroll-top (pagination: the next page starts at its top), and links or forms inside a nav (the side
   menu, the phone Menu sheet, the top bar). A page that keeps its own place (BU KPI setup, Talent Box) sets
   <body data-keep-place="own"> and this script stays out of its way.
   The decision rules are plain functions of plain values, so tests/js/keep_place.test.js runs them in node. */
(function (root) {
  "use strict";
  var KEY = "keepplace", TTL = 30000;

  // does a click on this link save the place? o: {button, meta, ctrl, shift, alt, href (the attribute), base (location.href),
  // target, download, listOpen, scrollTop, inNav}
  function linkSaves(o) {
    if (!o || o.button !== 0 || o.meta || o.ctrl || o.shift || o.alt) return false;
    if (o.listOpen || o.scrollTop || o.inNav || o.download) return false;
    if (o.target && o.target !== "_self") return false;
    if (o.href == null || String(o.href).indexOf("#") !== -1) return false;
    return samePage(o.href, o.base);
  }
  // does a submit of this form save the place? o: {method, action (the attribute), base, target, scrollTop, inNav}
  function formSaves(o) {
    if (!o || o.scrollTop || o.inNav) return false;
    var m = String(o.method == null ? "" : o.method).toLowerCase();
    if (m !== "" && m !== "get") return false;
    if (o.target && o.target !== "_self") return false;
    var act = o.action == null ? "" : String(o.action);
    if (act.indexOf("#") !== -1) return false;
    return samePage(act, o.base);
  }
  function samePage(href, base) {
    var u, b;
    try { b = new URL(base); u = new URL(href, b); } catch (e) { return false; }
    return u.origin === b.origin && u.pathname === b.pathname && !u.hash;
  }
  // the y to scroll to, or null. entry: what was saved; nav: the navigation type ("navigate", "reload", "back_forward", ...)
  function restoreY(entry, pathname, now, nav) {
    if (!entry || typeof entry !== "object") return null;
    if (nav !== "navigate") return null;
    if (entry.path !== pathname) return null;
    var age = now - entry.at;
    if (!(age >= 0 && age <= TTL)) return null;
    if (typeof entry.y !== "number" || !isFinite(entry.y) || entry.y <= 0) return null;
    return entry.y;
  }

  // What the page would save if it left now. A click or submit only sets this; it is written to sessionStorage on pagehide,
  // so a navigation that never happens (another handler cancels it, "Leave without saving?" Stay) leaves nothing behind.
  // ctx: {path, y, now}
  var HOLD = 10000;
  function keeper() {
    var pending = null;
    function mk(ctx) { return {path: ctx.path, y: ctx.y, at: ctx.now}; }
    return {
      link: function (o, ctx) { pending = linkSaves(o) ? mk(ctx) : null; },
      form: function (o, ctx) { pending = formSaves(o) ? mk(ctx) : null; },
      keep: function (ctx) { pending = mk(ctx); },
      flush: function (now) {
        var e = pending; pending = null;
        return e && now - e.at >= 0 && now - e.at <= HOLD ? e : null;
      },
      peek: function () { return pending; }
    };
  }

  var api = {keeper: keeper, HOLD: HOLD, linkSaves: linkSaves, formSaves: formSaves, samePage: samePage, restoreY: restoreY, TTL: TTL, KEY: KEY};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (!root || !root.document) return;

  var doc = root.document, loc = root.location;
  var body = doc.body;
  if (body && body.getAttribute("data-keep-place") === "own") { root.keepPlace = function () {}; return; }

  var kp = keeper();
  function ctx() { return {path: loc.pathname, y: root.scrollY || root.pageYOffset || 0, now: Date.now()}; }
  function save() { kp.keep(ctx()); }
  root.keepPlace = save;
  // the page really leaves: write what is pending, once
  root.addEventListener("pagehide", function () {
    var e = kp.flush(Date.now());
    if (!e) return;
    try { root.sessionStorage.setItem(KEY, JSON.stringify(e)); } catch (x) {}
  });

  function inNav(el) { return !!(el && el.closest && el.closest("nav")); }
  function hasAttr(el, n) { return !!(el && el.closest && el.closest("[" + n + "]")); }

  root.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    kp.link({
      button: e.button, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey,
      href: a.getAttribute("href"), base: loc.href, target: a.getAttribute("target"), download: a.hasAttribute("download"),
      listOpen: a.hasAttribute("data-list-open"), scrollTop: a.hasAttribute("data-scroll-top"), inNav: inNav(a)
    }, ctx());
  }, true);

  function formNote(f, submitter) {
    var sub = submitter && submitter.getAttribute ? submitter : null;
    kp.form({
      method: sub && sub.hasAttribute("formmethod") ? sub.getAttribute("formmethod") : f.getAttribute("method"),
      action: sub && sub.hasAttribute("formaction") ? sub.getAttribute("formaction") : f.getAttribute("action"),
      base: loc.href,
      target: sub && sub.hasAttribute("formtarget") ? sub.getAttribute("formtarget") : f.getAttribute("target"),
      scrollTop: f.hasAttribute("data-scroll-top") || (sub && sub.hasAttribute("data-scroll-top")), inNav: inNav(f)
    }, ctx());
  }
  root.addEventListener("submit", function (e) {
    if (e.target && e.target.getAttribute) formNote(e.target, e.submitter);
  }, true);
  // form.submit() fires no submit event (the onchange="this.form.submit()" filters), so it is wrapped once, here
  try {
    var orig = root.HTMLFormElement.prototype.submit;
    root.HTMLFormElement.prototype.submit = function () {
      try { formNote(this, null); } catch (e) {}
      return orig.apply(this, arguments);
    };
  } catch (e) {}

  // restore, once, on the way in
  var nav = "navigate";
  try { var ne = root.performance.getEntriesByType("navigation")[0]; if (ne && ne.type) nav = ne.type; } catch (e) {}
  var raw = null;
  try { raw = root.sessionStorage.getItem(KEY); root.sessionStorage.removeItem(KEY); } catch (e) { return; }
  var entry = null;
  try { entry = raw ? JSON.parse(raw) : null; } catch (e) { return; }
  var y = restoreY(entry, loc.pathname, Date.now(), nav);
  if (y == null) return;
  // again on load: the document can still grow, and a scrollTo on a shorter page is clamped
  var go = function () { root.scrollTo(0, y); };
  root.requestAnimationFrame(go);
  root.addEventListener("load", go, {once: true});
})(typeof window !== "undefined" ? window : null);
