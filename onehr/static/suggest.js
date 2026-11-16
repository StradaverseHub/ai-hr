/* Search as you type (2026-10-27): any input[data-suggest="<kind>"] suggests from 2 letters, after 250 ms, up to 8 in a
   dropdown under the box (the look of the person page's job-profile suggest: .pp-sug). Up / Down move, Enter or a
   click on a suggestion fills the box and submits ITS OWN form (the page's existing search), Esc closes, Enter with
   nothing highlighted submits as it always did, a click outside closes. An older answer never replaces a newer one.
   Delegated on the document, so a box that arrives later (a panel, the Learning drawer) works without a re-init.
   The one route is data-suggest-url (/suggest); the people boxes send their "Search in" field (qin) and the page's
   own view / show, so the suggestions are what that list's search would find. Nothing here writes; without this
   script the GET forms work on Enter as they did. */
(function () {
  if (window.onehrSuggest) return;
  var MIN = 2, WAIT = 250, MAX = 8, seq = 0, uid = 0, live = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function isBox(n) { return n && n.matches && n.matches("input[data-suggest]"); }

  function state(input) {
    if (input._sg) return input._sg;
    var p = input.parentNode;
    if (window.getComputedStyle(p).position === "static") p.style.position = "relative";
    var box = el("div", "pp-sug pp-sug-in");
    box.setAttribute("role", "listbox");
    box.id = "sg-" + (++uid);
    box.hidden = true;
    input.insertAdjacentElement("afterend", box);
    input.setAttribute("autocomplete", "off");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", box.id);
    input.setAttribute("aria-expanded", "false");
    box.addEventListener("mousedown", function (e) { e.preventDefault(); });   // keep the field's focus
    input._sg = { box: box, items: [], at: -1, timer: 0 };
    return input._sg;
  }

  function close(input) {
    var s = input._sg;
    if (!s) return;
    s.box.hidden = true; s.at = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    if (live === input) live = null;
  }
  function closeAll(except) {
    document.querySelectorAll("input[data-suggest]").forEach(function (i) { if (i !== except) close(i); });
  }

  function place(input, box) {
    var vw = document.documentElement.clientWidth, lim = vw - 8;
    box.style.right = "auto";
    box.style.top = (input.offsetTop + input.offsetHeight + 4) + "px";
    box.style.left = input.offsetLeft + "px";
    box.style.minWidth = input.offsetWidth + "px";
    box.style.maxWidth = Math.max(input.offsetWidth, Math.min(440, vw - 16)) + "px";
    var r = box.getBoundingClientRect();
    if (r.right > lim) {   // a box at the page's right edge: grow leftward, right edges together
      box.style.left = (input.offsetLeft + input.offsetWidth - r.width) + "px";
      r = box.getBoundingClientRect();
      if (r.right > lim) { box.style.left = (parseFloat(box.style.left) - (r.right - lim)) + "px"; r = box.getBoundingClientRect(); }
    }
    if (r.left < 8) box.style.left = (parseFloat(box.style.left) + 8 - r.left) + "px";   // never past the left edge either
    var low = r.bottom - (window.innerHeight - 8);   // the whole list on screen: the page moves up for it
    if (low > 0) window.scrollBy(0, Math.min(low, Math.max(0, r.top - 60)));
  }

  function label(it, q) {
    var t = el("span", "pp-sug-t"), i = it.v.toLowerCase().indexOf(q);
    if (i < 0) { t.textContent = it.v; return t; }
    t.appendChild(document.createTextNode(it.v.slice(0, i)));
    t.appendChild(el("b", null, it.v.slice(i, i + q.length)));
    t.appendChild(document.createTextNode(it.v.slice(i + q.length)));
    return t;
  }

  function show(input, q) {
    var s = state(input), box = s.box;
    box.textContent = ""; s.at = -1;
    if (!s.items.length) { close(input); return; }
    s.items.forEach(function (it, i) {
      var b = el("button", "pp-sug-o");
      b.type = "button"; b.setAttribute("role", "option"); b.id = box.id + "-" + i;
      b.setAttribute("aria-selected", "false");
      b.appendChild(label(it, q));
      if (it.m) b.appendChild(el("span", "pp-sug-m", it.m));
      b.addEventListener("click", function () { pick(input, it); });
      box.appendChild(b);
    });
    box.appendChild(el("span", "pp-sug-hint", "↑ ↓ to move · Enter to pick · Esc to close"));
    closeAll(input);
    box.hidden = false; live = input;
    input.setAttribute("aria-expanded", "true");
    place(input, box);
  }

  function move(input, d) {
    var s = state(input), opts = s.box.querySelectorAll(".pp-sug-o");
    if (!opts.length) return;
    s.at = (s.at + d + opts.length) % opts.length;
    opts.forEach(function (o, i) { o.classList.toggle("is-on", i === s.at); o.setAttribute("aria-selected", i === s.at ? "true" : "false"); });
    input.setAttribute("aria-activedescendant", opts[s.at].id);
    opts[s.at].scrollIntoView({ block: "nearest" });
  }

  function pick(input, it) {
    input.value = it.v;
    close(input);
    var f = input.form;
    if (f) { if (f.requestSubmit) f.requestSubmit(); else f.submit(); }   // the page's own search, as Enter would
  }

  function url(input, q) {
    var f = input.form, u = new URLSearchParams();
    u.set("kind", input.getAttribute("data-suggest")); u.set("q", q);
    ["src", "key"].forEach(function (k) {
      var v = input.getAttribute("data-suggest-" + k); if (v) u.set(k, v);
    });
    var qin = f && f.querySelector('[name="qin"]');
    if (qin && qin.value) u.set("qin", qin.value);   // the field picked in Search in
    try {
      var here = new URLSearchParams(location.search);
      ["view", "show"].forEach(function (k) { if (here.get(k)) u.set(k, here.get(k)); });
    } catch (e) {}
    return (input.getAttribute("data-suggest-url") || "/suggest") + "?" + u.toString();
  }

  function run(input) {
    var q = input.value.trim().replace(/\s+/g, " ").toLowerCase(), mine = ++seq;
    if (q.length < MIN) { close(input); return; }
    fetch(url(input, q), { credentials: "same-origin", headers: { "X-Requested-With": "fetch" } })
      .then(function (r) { if (!r.ok || r.redirected) throw new Error(String(r.status)); return r.json(); })
      .then(function (j) {
        if (mine !== seq || document.activeElement !== input) return;   // a newer answer or another box took over
        state(input).items = (j || []).slice(0, MAX);
        show(input, q);
      }).catch(function () { close(input); });
  }

  document.addEventListener("input", function (e) {
    var i = e.target;
    if (!isBox(i)) return;
    var s = state(i);
    clearTimeout(s.timer);
    s.timer = setTimeout(function () { run(i); }, WAIT);
  });
  document.addEventListener("keydown", function (e) {
    var i = e.target;
    if (!isBox(i) || e.isComposing) return;
    var s = state(i), open = !s.box.hidden;
    if (e.key === "Escape") { if (open) { e.preventDefault(); e.stopPropagation(); close(i); } return; }
    if (!open) {
      if (e.key === "ArrowDown" && s.items.length && i.value.trim().length >= MIN) {
        e.preventDefault(); show(i, i.value.trim().replace(/\s+/g, " ").toLowerCase()); move(i, 1);
      }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); move(i, 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(i, -1); }
    else if (e.key === "Enter" && s.at >= 0) { e.preventDefault(); pick(i, s.items[s.at]); }
  }, true);
  document.addEventListener("focusin", function (e) { if (isBox(e.target)) state(e.target); });   // aria-controls ready
  document.addEventListener("focusout", function (e) {
    var i = e.target;
    if (isBox(i)) setTimeout(function () { if (document.activeElement !== i) close(i); }, 150);
  });
  document.addEventListener("mousedown", function (e) {
    if (live && e.target !== live && !(live._sg && live._sg.box.contains(e.target))) close(live);   // outside
  });

  window.onehrSuggest = { closeAll: function () { closeAll(null); } };
})();
