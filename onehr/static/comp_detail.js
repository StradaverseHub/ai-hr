/* The person page's Competency tab (2026-10-27, canvas "Person competency tab"; markup: templates/person/_competency.html
   and _comp_finds.html, answers: admin_person_competency_find).
   1. A competency's name ([data-cd-open], its detail in data-cd-json) opens that detail in the page's one side panel
      ("cdetail", the app's own panel, peeking so the names behind stay clickable); another name switches it, the bezel
      and Esc close it. Inside another panel (a person opened from a list) only one panel can be open, so the same detail
      opens under its row instead.
   2. The panel's Add / For their future role press the library row's own buttons (same POST, same confirm box).
   3. Both searches answer as you type: from 2 letters, after 250 ms. Job profiles drop down under the field (arrows,
      Enter, Esc; a pick goes to the same &profile= preview the result list links to); the library box refills in place.
      Without this script the GET forms still work on Enter. Nothing here writes. */
(function () {
  if (window.onehrCompDetail) { window.onehrCompDetail.init(); return; }
  var activeRow = null, activeSid = null, seq = 0;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function panelEl() { return document.querySelector('.adm-panel[data-panel="cdetail"]'); }
  function parse(btn) { try { return JSON.parse(btn.getAttribute("data-cd-json") || "null"); } catch (e) { return null; } }
  function rowOf(btn) { return btn.closest("[data-cd-row], .pp-lr"); }

  function levels(d, into) {
    (d.levels || []).forEach(function (l) {
      var c = el("section", "cd-lv"), h = el("div", "cd-lv-h");
      h.appendChild(el("b", "cd-lv-n", l.lv));
      h.appendChild(el("span", "cd-tag " + (l.tag === "Now" ? "is-now" : l.tag === "This entry" ? "is-this" : "is-next"), l.tag));
      h.appendChild(el("span", "cd-code", l.code || ""));
      c.appendChild(h);
      c.appendChild(l.desc ? el("p", "cd-desc", l.desc) : el("p", "cd-desc muted", "No description is written for this level yet."));
      [["Abilities", l.abil], ["Knowledge", l.know]].forEach(function (g) {
        if (!g[1] || !g[1].length) return;
        c.appendChild(el("span", "cd-k", g[0]));
        var ul = el("ul", "cd-list");
        g[1].forEach(function (t) { ul.appendChild(el("li", null, t)); });
        c.appendChild(ul);
      });
      into.appendChild(c);
    });
  }
  function libHref(root, d) {
    var base = (root && root.getAttribute("data-lib-url")) || "";
    return base + "?skill=" + encodeURIComponent(d.lib || "") + "&panel=skill";
  }

  /* ---- the side panel ---- */
  function fill(p, d, btn) {
    var root = document.querySelector("[data-cd-root]");
    p.querySelector(".adm-panel-k").textContent = "Competency · " + (d.cat || "");
    p.querySelector(".adm-panel-h").textContent = d.title || "";
    var sub = p.querySelector(".adm-panel-sub"); sub.textContent = d.sub || ""; sub.hidden = !sub.textContent;
    var body = p.querySelector("[data-cd-body]"); body.textContent = ""; levels(d, body); body.scrollTop = 0;
    p.querySelector("[data-cd-lib]").setAttribute("href", libHref(root, d));
    var add = p.querySelector("[data-cd-add]"), fut = p.querySelector("[data-cd-future]");
    var rowAdd = btn && rowOf(btn) ? rowOf(btn).querySelector("[data-cd-rowadd]") : null;
    var rowFut = btn && rowOf(btn) ? rowOf(btn).querySelector("[data-cd-rowfuture]") : null;
    add.hidden = !(d.add && rowAdd); fut.hidden = !(d.add && rowFut);
    if (rowAdd) add.disabled = rowAdd.disabled;
    if (rowFut) fut.disabled = rowFut.disabled;
  }
  function mark(row) {
    document.querySelectorAll(".is-open[data-cd-row], .pp-lr.is-open").forEach(function (n) { n.classList.remove("is-open"); });
    if (row) row.classList.add("is-open");
    activeRow = row || null;
    activeSid = row && row.getAttribute("data-sid") || null;
  }
  function setCd(key) {
    try {
      var u = new URL(location.href);
      if (key) u.searchParams.set("cd", key); else u.searchParams.delete("cd");
      history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    } catch (e) {}
  }

  /* ---- inside another panel: the detail opens under its row ---- */
  function inline(btn, d, row) {
    var root = btn.closest("[data-cd-root]");
    var had = row.nextElementSibling && row.nextElementSibling.classList.contains("cd-inline");
    root.querySelectorAll(".cd-inline").forEach(function (n) { n.remove(); });
    mark(null);
    if (had) return;
    var box = el("div", "cd-inline");
    levels(d, box);
    var a = el("a", "cd-inline-lib", "Open in the library ›"); a.href = libHref(root, d);
    box.appendChild(a);
    row.insertAdjacentElement("afterend", box);
    mark(row);
  }

  function openDetail(btn) {
    var d = parse(btn), row = rowOf(btn);
    if (!d || !row) return;
    var p = panelEl();
    if (!p || !window.onehrPanel || btn.closest("[data-cd-inline]")) { inline(btn, d, row); return; }
    fill(p, d, btn); mark(row);
    window.onehrPanel.open("cdetail", btn);
    setCd(row.hasAttribute("data-cd-row") ? row.getAttribute("data-cd-row") : "");
  }

  /* ---- search as you type ---- */
  function debounce(fn, ms) { var t; return function () { var a = arguments; clearTimeout(t); t = setTimeout(function () { fn.apply(null, a); }, ms); }; }
  function get(url, as) {
    return fetch(url, { credentials: "same-origin", headers: { "X-Requested-With": "fetch" } })
      .then(function (r) { if (!r.ok || r.redirected) throw new Error(String(r.status)); return r[as](); });
  }

  function libSearch(form, root) {
    var input = form.querySelector('input[name="sq"]'), out = root.querySelector("[data-lib-results]");
    if (!input || !out) return;
    var run = debounce(function () {
      var q = input.value.trim(), mine = ++seq;
      get(root.getAttribute("data-find-url") + "?kind=skills&q=" + encodeURIComponent(q), "text").then(function (html) {
        if (mine !== seq) return;
        out.innerHTML = html;
        if (window.onehrPanel && window.onehrPanel.adopt) window.onehrPanel.adopt(out);
        if (activeSid) {   // the open detail's row, if it is still listed
          var again = out.querySelector('.pp-lr[data-sid="' + activeSid + '"]');
          if (again) again.classList.add("is-open");
          var p = panelEl();
          if (p && p.classList.contains("is-on")) {
            var b = p.querySelector("[data-cd-add]"), f = p.querySelector("[data-cd-future]");
            if (!again) { b.hidden = f.hidden = true; } else activeRow = again;
          }
        }
      }).catch(function () {});
    }, 250);
    input.addEventListener("input", run);
  }

  function profSearch(form, root) {
    var input = form.querySelector('input[name="pq"]');
    if (!input) return;
    form.style.position = "relative";
    var box = el("div", "pp-sug"); box.setAttribute("role", "listbox"); box.id = "pp-sug-" + Math.random().toString(36).slice(2, 7);
    box.hidden = true; form.appendChild(box);
    input.setAttribute("aria-controls", box.id);
    var items = [], at = -1;
    function close() { box.hidden = true; at = -1; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); }
    function mk(it, i) {
      var b = el("button", "pp-sug-o"); b.type = "button"; b.setAttribute("role", "option"); b.id = box.id + "-" + i;
      var t = el("span", "pp-sug-t");
      t.appendChild(document.createTextNode(it.pre));
      if (it.hit) t.appendChild(el("b", null, it.hit));
      t.appendChild(document.createTextNode(it.post));
      b.appendChild(t); b.appendChild(el("span", "pp-sug-m", it.meta));
      b.addEventListener("mousedown", function (e) { e.preventDefault(); });   // keep the field's focus
      b.addEventListener("click", function () { pick(it); });
      return b;
    }
    function show(q) {
      box.textContent = ""; at = -1;
      if (!items.length) box.appendChild(el("span", "pp-sug-none", "No job profile matches “" + q + "”."));
      items.forEach(function (it, i) { box.appendChild(mk(it, i)); });
      box.appendChild(el("span", "pp-sug-hint", "↑ ↓ to move · Enter to pick · Esc to close"));
      box.hidden = false; input.setAttribute("aria-expanded", "true");
    }
    function move(d) {
      var opts = box.querySelectorAll(".pp-sug-o"); if (!opts.length) return;
      at = (at + d + opts.length) % opts.length;
      opts.forEach(function (o, i) { o.classList.toggle("is-on", i === at); o.setAttribute("aria-selected", i === at ? "true" : "false"); });
      input.setAttribute("aria-activedescendant", opts[at].id); opts[at].scrollIntoView({ block: "nearest" });
    }
    function pick(it) {
      close();
      var a = el("a"); a.href = it.href; a.hidden = true; form.appendChild(a); a.click(); a.remove();   // the preview link, as the list's
    }
    var run = debounce(function () {
      var q = input.value.trim(), mine = ++seq;
      if (q.length < 2) { close(); return; }
      get(root.getAttribute("data-find-url") + "?kind=profiles&q=" + encodeURIComponent(q), "json").then(function (j) {
        if (mine !== seq || document.activeElement !== input) return;
        items = j.items || []; show(q);
      }).catch(function () {});
    }, 250);
    input.addEventListener("input", run);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !box.hidden) { e.preventDefault(); close(); return; }
      if (box.hidden) { if (e.key === "ArrowDown" && items.length && input.value.trim().length >= 2) { show(input.value.trim()); move(1); e.preventDefault(); } return; }
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "Enter" && at >= 0) { e.preventDefault(); pick(items[at]); }
    });
    input.addEventListener("blur", function () { setTimeout(close, 120); });
  }

  // the library card ends at the bottom of the screen: the right column sticks under the top bar, and the card takes
  // what is left below the cards above it; its list scrolls inside
  function fit(root) {
    var lib = root.querySelector(".pp-lib"), col = lib && lib.closest(".pp-col");
    if (!lib || root.hasAttribute("data-cd-inline")) return;
    var bar = document.querySelector(".topbar"), top = (bar ? bar.getBoundingClientRect().height : 56) + 12;
    var above = lib.getBoundingClientRect().top - col.getBoundingClientRect().top;
    lib.style.height = Math.max(220, window.innerHeight - 16 - top - above) + "px";
    lib.style.maxHeight = "none";
  }
  function watchFit(root) {
    var lib = root.querySelector(".pp-lib");
    if (!lib) return;
    fit(root);
    window.addEventListener("resize", function () { fit(root); });
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { fit(root); });
      [].forEach.call(lib.closest(".pp-col").children, function (c) { if (c !== lib) ro.observe(c); });
    }
  }

  function init() {
    document.querySelectorAll("[data-cd-root]").forEach(function (root) {
      if (root._cd) return;
      root._cd = true;
      watchFit(root);
      root.querySelectorAll("form[data-find]").forEach(function (f) {
        if (f.getAttribute("data-find") === "skills") libSearch(f, root); else profSearch(f, root);
      });
    });
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-cd-open]");
    if (b) { e.preventDefault(); openDetail(b); return; }
    var p = panelEl(), proxy = e.target.closest && e.target.closest("[data-cd-add], [data-cd-future]");
    if (proxy && p && p.contains(proxy)) {
      e.preventDefault();
      var row = activeRow && document.contains(activeRow) ? activeRow
        : activeSid ? document.querySelector('.pp-lr[data-sid="' + activeSid + '"]') : null;
      var real = row && row.querySelector(proxy.hasAttribute("data-cd-add") ? "[data-cd-rowadd]" : "[data-cd-rowfuture]");
      if (real && !real.disabled) real.click();
    }
  });
  // the panel closing (bezel, Esc) takes the highlight off the row
  (function () {
    var p = panelEl();
    if (!p || !window.MutationObserver) return;
    new MutationObserver(function () { if (!p.classList.contains("is-on")) mark(null); })
      .observe(p, { attributes: true, attributeFilter: ["class"] });
  })();
  // a reload with the panel open (?panel=cdetail&cd=<line>) fills it before the panel code opens it; without a line to
  // show the address drops the panel, so it never opens empty
  (function () {
    if (document.readyState !== "loading") return;
    try {
      var u = new URL(location.href), p = panelEl();
      if (u.searchParams.get("panel") !== "cdetail") return;
      var k = u.searchParams.get("cd"), row = k && document.querySelector('[data-cd-row="' + String(k).replace(/[^\w-]/g, "") + '"]');
      var btn = row && row.querySelector("[data-cd-open]"), d = btn && parse(btn);
      if (p && d) { fill(p, d, btn); mark(row); return; }
      u.searchParams.delete("panel"); u.searchParams.delete("cd");
      history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    } catch (e) {}
  })();

  window.onehrCompDetail = { init: init };
  init();
})();
