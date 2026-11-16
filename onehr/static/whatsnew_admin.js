/* Admin › Comms › What's new: the write-a-note panel (Chris, 2026-11-03, canvas [design canvas link removed]
   boards S2 and S3). Keeps three things in step with the picks as they change: the words' counter, "As they'll see it" (the same
   box the dashboard pops out, drawn from the same classes; the words go in with textContent, never as markup), and the Publish
   button's confirm words (the count it will reach and the time, in Malaysia time). The button's page is a strict pick from the
   Banner's list: typed text that isn't a pick stops the form. The server checks everything again. */
(function () {
  "use strict";
  var f = document.getElementById("wn-form");
  if (!f) return;
  var NS = "http://www.w3.org/2000/svg";
  var ICON = {
    mega: ["M3 10v4a1 1 0 0 0 1 1h2l6 4V5L6 9H4a1 1 0 0 0-1 1z", "M16 9a3.5 3.5 0 0 1 0 6", "M19 6a8 8 0 0 1 0 12"],
    list: ["M9 6h11M9 12h11M9 18h11", "M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"],
    clock: ["M12 7v5l3 2"]
  };
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function icon(name) {
    var s = document.createElementNS(NS, "svg");
    s.setAttribute("width", "18"); s.setAttribute("height", "18"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
    if (name === "clock") {
      var c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", "12"); c.setAttribute("cy", "12"); c.setAttribute("r", "9"); s.appendChild(c);
    }
    (ICON[name] || ICON.mega).forEach(function (d) { var p = document.createElementNS(NS, "path"); p.setAttribute("d", d); s.appendChild(p); });
    return s;
  }
  var title = f.elements.title, body = f.elements.body;
  var cnt = f.querySelector("[data-wn-cnt]");
  var prev = document.querySelector("[data-wn-prev]");
  var at = f.elements.shows_at;
  var atRow = f.querySelector("[data-wn-at]");
  var pub = document.querySelector("[data-wn-publish]");
  var words = f.querySelector("[data-wn-words]"), wordsT = f.querySelector("[data-wn-words-t]");
  var targets = [];
  try { targets = JSON.parse(document.getElementById("wn-link-targets").textContent) || []; } catch (e) { targets = []; }

  function audience() { return f.querySelector('input[name="audience"]:checked'); }
  function showsMode() { var r = f.querySelector('input[name="shows"]:checked'); return r ? r.value : "now"; }
  function parts(v) {   // "2026-11-05T20:15" (Malaysia time, as typed) -> {y, m, d, hh, mm}
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(v || "");
    return m ? { y: +m[1], m: +m[2] - 1, d: +m[3], hh: m[4], mm: m[5] } : null;
  }
  function dayWord(p) { return p.d + " " + MON[p.m] + " " + p.y; }
  function whenWord(p) {
    var wd = DOW[new Date(Date.UTC(p.y, p.m, p.d)).getUTCDay()];
    return wd + " " + p.d + " " + MON[p.m] + ", " + p.hh + ":" + p.mm;
  }
  function today() { var p = parts((f.getAttribute("data-today") || "") + "T00:00"); return p; }

  function paintPreview() {
    if (!prev) return;
    var tt = (title.value || "").replace(/\s+/g, " ").trim() || "Your title";
    var bb = (body.value || "").replace(/\s+/g, " ").trim() || "What you write shows here, as people will read it.";
    var a = audience();
    var h = prev.querySelector(".wn-h"), p = prev.querySelector(".wn-p");
    if (h) h.textContent = tt;
    if (p) p.textContent = bb;
    var tile = prev.querySelector(".wn-ic");
    if (tile) { tile.textContent = ""; tile.appendChild(icon(a ? a.getAttribute("data-icon") : "mega")); }
    var nt = prev.querySelector(".wn-nt"), go = prev.querySelector(".wn-go");
    var val = f.elements.link_target.value, hit = targets.filter(function (x) { return x.key === val; })[0];
    if (go && !hit) go.remove();
    if (hit) {
      if (!go) { go = el("a", "wn-go"); go.href = "#"; go.tabIndex = -1; nt.appendChild(go); }
      go.textContent = hit.words;
    }
    var ey = prev.querySelector("[data-wn-eyebrow]");
    var d = (showsMode() === "at" && at && parts(at.value)) || today();
    if (ey && d) ey.textContent = "What's new · " + dayWord(d);
  }
  function paintCount() {
    if (cnt) cnt.textContent = body.value.length.toLocaleString() + " / " + (body.maxLength > 0 ? body.maxLength : 600).toLocaleString();
  }
  function paintConfirm() {
    if (!pub) return;
    var a = audience(), tt = (title.value || "").replace(/\s+/g, " ").trim();
    var when;
    if (showsMode() === "at" && at && parts(at.value)) when = " from " + whenWord(parts(at.value)) + " (Malaysia time)";
    else when = " from now";
    var who = a ? "the " + a.getAttribute("data-n") + " people in “" + a.getAttribute("data-label") + "”" : "the people it is for";
    var msg = "It pops out once for " + who + ", at their next visit" + when + ", and stays in their What's new. " +
      "You can correct the words later. Who it's for can't change once it's published.";
    if (a && a.getAttribute("data-n") === "0") msg += " Nobody can use that feature today, so it shows to no one until they can.";
    pub.setAttribute("data-confirm", msg);
    pub.setAttribute("data-confirm-title", tt ? "Publish “" + tt + "”?" : "Publish this note?");
  }
  function paintShows() { if (atRow) atRow.hidden = showsMode() !== "at"; }
  function all() { paintCount(); paintPreview(); paintConfirm(); paintShows(); }

  f.addEventListener("input", all);
  f.addEventListener("change", all);

  /* the button's page: picked from the Banner's list, searched as you type; typed text that isn't a pick stops the form */
  var box = document.getElementById("wn-page");
  if (box) {
    var q = box.querySelector(".pick-q"), val = box.querySelector(".pick-val");
    var items = [], active = -1;
    var list = document.createElement("ul");
    list.className = "pick-list"; list.id = "wn-page-list"; list.setAttribute("role", "listbox"); list.hidden = true;
    box.appendChild(list);
    q.setAttribute("role", "combobox"); q.setAttribute("aria-autocomplete", "list");
    q.setAttribute("aria-controls", list.id); q.setAttribute("aria-expanded", "false");
    var check = function () { q.setCustomValidity(q.value.trim() && !val.value ? "Pick the page from the list: type part of its name, then choose it." : ""); };
    var shut = function () { list.hidden = true; q.setAttribute("aria-expanded", "false"); active = -1; q.removeAttribute("aria-activedescendant"); };
    var mark = function () {
      Array.prototype.forEach.call(list.children, function (li, i) { li.classList.toggle("is-on", i === active); li.setAttribute("aria-selected", i === active ? "true" : "false"); });
      if (active >= 0) q.setAttribute("aria-activedescendant", list.id + "-" + active);
    };
    var render = function () {
      list.textContent = "";
      if (!items.length) list.appendChild(el("li", "pick-none", "Nothing matches. Only OneHR's own pages are here."));
      items.forEach(function (x, i) {
        var li = el("li"), b = el("b", null, x.name), sm = el("small", null, x.kind);
        li.id = list.id + "-" + i; li.setAttribute("role", "option");
        li.appendChild(b); li.appendChild(sm);
        li.addEventListener("mousedown", function (e) { e.preventDefault(); choose(i); });
        list.appendChild(li);
      });
      list.hidden = false; q.setAttribute("aria-expanded", "true"); active = -1; mark();
    };
    var find = function (t) {
      t = t.toLowerCase();
      return targets.filter(function (x) { return !t || (x.name + " " + x.kind).toLowerCase().indexOf(t) >= 0; }).slice(0, 40);
    };
    var choose = function (i) {
      var x = items[i];
      if (!x) return;
      val.value = x.key; q.value = x.name;
      if (words && wordsT) { wordsT.textContent = x.words; words.hidden = false; }
      shut(); check(); all();
    };
    q.addEventListener("input", function () {
      val.value = ""; if (words) words.hidden = true; check(); items = find(q.value.trim()); render();
      paintPreview();
    });
    q.addEventListener("focus", function () { if (!val.value) { items = find(q.value.trim()); render(); } });
    q.addEventListener("keydown", function (e) {
      if (list.hidden) return;
      if (e.key === "ArrowDown") { active = Math.min(items.length - 1, active + 1); mark(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); mark(); e.preventDefault(); }
      else if (e.key === "Enter" && active >= 0) { choose(active); e.preventDefault(); }
      else if (e.key === "Escape") { shut(); e.preventDefault(); e.stopPropagation(); }
    });
    q.addEventListener("blur", function () { setTimeout(shut, 120); });
    check();
  }
  all();
})();
