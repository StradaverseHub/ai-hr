/* Grade H Appraisal, the line manager's pages (piece 4). Small and optional: every form also works with no script.
   - a pick on an open attribute, and the second answer on a Leadership Principle, send the form at once (the server saves it)
   - KPI moderation: a figure equal to theirs reads "Same as theirs"; a changed one asks for its reason
   - comments: a draft saves itself (JSON) when a box is left; "Help me word this" asks the server for words for the box
     in focus and puts them in the box, nothing else: it never rates, saves or submits
   - the nomination's reason box shows when Yes; the Submit button wakes when the conversation box is ticked and a Yes has a
     reason (the server asks for both again)
   - Ask OneHR on the left: fixed answers from POST /review/gradeh/ask */
(function () {
  "use strict";
  var root = document.getElementById("ghl-page");
  if (!root) return;
  root.classList.add("js");
  var tokEl = document.querySelector('meta[name="csrf-token"]');
  var TOK = tokEl ? tokEl.getAttribute("content") : "";

  /* ---- attributes: a pick saves ---- */
  [].forEach.call(document.querySelectorAll("form.ghl-auto"), function (f) {
    f.addEventListener("change", function (e) {
      if (e.target && e.target.type === "radio") { try { f.requestSubmit(); } catch (x) { f.submit(); } }
    });
  });

  /* ---- principles: both statements answered -> save ---- */
  [].forEach.call(document.querySelectorAll("form.ghl-lpform"), function (f) {
    f.addEventListener("change", function (e) {
      if (!e.target || e.target.type !== "radio") return;
      var names = {};
      [].forEach.call(f.querySelectorAll("input[type=radio]"), function (r) { names[r.name] = names[r.name] || r.checked; });
      var all = Object.keys(names).every(function (k) { return names[k]; });
      if (all) { try { f.requestSubmit(); } catch (x) { f.submit(); } }
    });
  });

  /* ---- KPI moderation ---- */
  [].forEach.call(document.querySelectorAll("#ghl-kform tbody tr"), function (tr) {
    var inp = tr.querySelector("input[name^=f_]"), why = tr.querySelector("input[name^=w_]");
    if (!inp || !why) return;
    var theirs = tr.getAttribute("data-theirs");
    var norm = function (s) { return (s || "").replace(/%/g, "").replace(",", ".").trim(); };
    var sync = function () {
      var v = norm(inp.value);
      var same = theirs !== "" && (v === "" || parseFloat(v) === parseFloat(theirs));
      tr.classList.toggle("is-same", same);
      if (same) why.value = "";
    };
    inp.addEventListener("input", sync);
    sync();   // on load too: a page sent back after a refused save shows the reason box for a changed figure
  });

  /* ---- comments: autosave and Help me word this ---- */
  var cform = document.getElementById("ghl-cform");
  if (cform) {
    var status = document.getElementById("ghl-autosave");
    var saveTimer = null, busy = false;
    var save = function () {
      if (busy) return; busy = true;
      var fd = new FormData(cform); fd.delete("go"); fd.append("json", "1");
      fetch(cform.getAttribute("action"), { method: "POST", body: fd, credentials: "same-origin", headers: { "Accept": "application/json" } })
        .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
        .then(function (j) { busy = false; if (status) { status.textContent = j && j.ok ? j.say : ""; status.style.color = j && j.ok ? "" : "#b0141c"; if (j && !j.ok && j.say) status.textContent = j.say; } })
        .catch(function () { busy = false; });
    };
    [].forEach.call(cform.querySelectorAll("textarea, select"), function (el) {
      el.addEventListener("change", function () { clearTimeout(saveTimer); saveTimer = setTimeout(save, 200); });
    });
    var last = cform.querySelector("textarea");
    [].forEach.call(cform.querySelectorAll("textarea"), function (t) { t.addEventListener("focus", function () { last = t; }); });
    var help = document.getElementById("ghl-help"), msg = document.getElementById("ghl-help-msg");
    if (help) help.addEventListener("click", function () {
      if (!last) return;
      var fd = new FormData();
      fd.append("csrf_token", TOK); fd.append("field", last.getAttribute("data-field") || ""); fd.append("text", last.value);
      help.disabled = true; var old = help.lastChild.textContent; help.lastChild.textContent = cform.getAttribute("data-wait") || "…";
      if (msg) msg.hidden = true;
      fetch(cform.getAttribute("data-help"), { method: "POST", body: fd, credentials: "same-origin" })
        .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
        .then(function (j) {
          help.disabled = false; help.lastChild.textContent = old;
          if (j && j.ok && j.text) { last.value = j.text; last.focus(); clearTimeout(saveTimer); saveTimer = setTimeout(save, 200); }
          else if (msg) { msg.textContent = (j && j.say) || ""; msg.hidden = !msg.textContent; }
        })
        .catch(function () { help.disabled = false; help.lastChild.textContent = old; });
    });
  }

  /* ---- step 4 ---- */
  var sform = document.getElementById("ghl-submit"), sbtn = document.getElementById("ghl-submit-btn");
  if (sform && sbtn) {
    var conv = sform.querySelector("input[name=conv]");
    var yes = document.querySelector("input[name=promo][value=yes]");
    var why = document.querySelector("textarea[name=promo_reason]");
    var reasonBox = document.querySelector(".ghl-promo-reason");
    var blocked = sbtn.hasAttribute("disabled");
    var sync = function () {
      var needReason = yes && yes.checked;
      if (reasonBox) reasonBox.hidden = !needReason;
      var ok = !blocked && conv && conv.checked && !(needReason && why && !why.value.trim());
      sbtn.disabled = !ok;
    };
    [conv, why].forEach(function (el) { if (el) { el.addEventListener("input", sync); el.addEventListener("change", sync); } });
    [].forEach.call(document.querySelectorAll("input[name=promo]"), function (r) { r.addEventListener("change", sync); });
    sync();
  }
  var ack = document.querySelector(".ghl-ackform");
  if (ack) {
    var dt = ack.querySelector("input[name=on]");
    var radios = ack.querySelectorAll("input[name=agrees]");
    var picked = function () { var v = ""; [].forEach.call(radios, function (r) { if (r.checked) v = r.value; }); return v; };
    var why = ack.querySelector("textarea[name=reason]");
    /* the confirm box says what is being recorded: they agree, or they do not (and that it opens a ticket and cannot be taken back) */
    var setMsg = function () {
      var t = ack.getAttribute(picked() === "0" ? "data-dis-confirm" : "data-ack-confirm") || "";
      ack.setAttribute("data-confirm", t.replace("{d}", dt.value));
      if (why) why.required = picked() === "0";
    };
    dt.addEventListener("change", setMsg);
    [].forEach.call(radios, function (r) { r.addEventListener("change", setMsg); });
    setMsg();
  }

  /* ---- Ask OneHR ---- */
  var ask = document.getElementById("ghl-ask");
  if (ask) {
    var log = document.getElementById("ghl-log"), input = document.getElementById("ghl-ask-in"), form = document.getElementById("ghl-askform");
    var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
    var send = function (text) {
      text = (text || "").trim(); if (!text) return;
      var rest = document.getElementById("ghl-rest"); if (rest) rest.hidden = true;
      log.appendChild(el("p", "gp-q", text));
      var fd = new FormData(); fd.append("csrf_token", TOK); fd.append("message", text);
      fetch(ask.getAttribute("data-url"), { method: "POST", body: fd, credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var wrap = el("div", "gp-a"); wrap.appendChild(el("p", null, (j && j.say) || ""));
          if (j && j.chips && j.chips.length) {
            var chips = el("div", "gp-chips");
            j.chips.forEach(function (q) { var b = el("button", "gp-chip", q); b.type = "button"; b.addEventListener("click", function () { send(q); }); chips.appendChild(b); });
            wrap.appendChild(chips);
          }
          log.appendChild(wrap); log.scrollTop = log.scrollHeight;
        }).catch(function () { /* stay quiet: the chips still work */ });
    };
    [].forEach.call(ask.querySelectorAll(".ghl-q"), function (b) { b.addEventListener("click", function () { send(b.textContent); }); });
    if (form) form.addEventListener("submit", function (e) { e.preventDefault(); var t = input.value; input.value = ""; send(t); });
  }
})();
