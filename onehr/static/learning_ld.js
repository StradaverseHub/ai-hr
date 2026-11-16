/* The L&D agent (AI+ Learning S15, 2026-10-22, board 14): its conversation on Learning › Overview. The opening and the
   history come from the page's own address (?data=1), a turn is a POST. Rows come back as a table card built from
   OneHR's own records; a drafted email as a card L&D checks, copies or sends themselves (double-confirmed in OneHR's
   own box). The agent never sends anything. */
(function () {
  "use strict";
  var root = document.getElementById("ld");
  if (!root) return;
  var log = document.getElementById("ld-log"), chips = document.getElementById("ld-chips"),
      form = document.getElementById("ld-form"), input = document.getElementById("ld-input"),
      send = form ? form.querySelector(".ld-send") : null, url = root.getAttribute("data-url"),
      live = root.getAttribute("data-available") === "1", busy = false;

  function token() {
    var m = document.querySelector('input[name="csrf_token"]');
    if (m) return m.value;
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute("content") : "";
  }
  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }
  function toEnd() { log.scrollTop = log.scrollHeight; }
  function spark() {
    var s = el("span", "ld-av");
    s.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C12.6 7.4 16.6 11.4 22 12C16.6 12.6 ' +
      '12.6 16.6 12 22C11.4 16.6 7.4 12.6 2 12C7.4 11.4 11.4 7.4 12 2Z"></path></svg>';
    return s;
  }
  // rows from OneHR's records, as a table under the answer
  function tableCard(c) {
    var d = el("div", "ld-card");
    d.appendChild(el("span", "ld-k", c.title));
    var t = el("table", "admin-table no-auto-table ld-table"), th = el("thead"), hr = el("tr");
    (c.cols || []).forEach(function (h) { var x = el("th", null, h); x.scope = "col"; hr.appendChild(x); });
    th.appendChild(hr); t.appendChild(th);
    var tb = el("tbody");
    (c.rows || []).forEach(function (r) {
      var tr = el("tr");
      r.forEach(function (v) { tr.appendChild(el("td", null, v == null ? "" : String(v))); });
      tb.appendChild(tr);
    });
    if (!(c.rows || []).length) {
      var tr0 = el("tr"), td0 = el("td", "muted", "Nothing to show.");
      td0.colSpan = (c.cols || []).length || 1; tr0.appendChild(td0); tb.appendChild(tr0);
    }
    t.appendChild(tb);
    d.appendChild(t);
    var foot = el("div", "ld-card-foot");
    if (c.more) foot.appendChild(el("span", "muted small", c.more + " more on the page"));
    if (c.link) { var a = el("a", "btn-link", c.link_label || "Open it"); a.href = c.link; foot.appendChild(a); }
    if (foot.childNodes.length) d.appendChild(foot);
    return d;
  }
  // a drafted email: L&D checks it, then copies it or sends it (double-confirmed); nothing goes by itself
  function emailCard(c) {
    var f = el("form", "ld-card ld-email");
    f.setAttribute("data-confirm", "Send this email to " + c.to + "? It goes only where this server sends email.");
    f.setAttribute("data-confirm-ok", "Send");
    var head = el("div", "ld-email-h");
    head.appendChild(el("span", "ld-k", "Draft · email to " + c.to));
    head.appendChild(el("span", "ld-chip", "Not sent"));
    f.appendChild(head);
    var sl = el("label", "ld-field"); sl.appendChild(el("span", null, "Subject"));
    var subj = el("input"); subj.name = "subject"; subj.value = c.subject; subj.maxLength = 150; sl.appendChild(subj);
    f.appendChild(sl);
    var bl = el("label", "ld-field"); bl.appendChild(el("span", null, "Email"));
    var body = el("textarea"); body.name = "body"; body.rows = 6; body.maxLength = 2000; body.value = c.body;
    bl.appendChild(body); f.appendChild(bl);
    var msg = el("p", "ld-msg"); msg.hidden = true; f.appendChild(msg);
    var acts = el("div", "ld-acts");
    acts.appendChild(el("span", "muted small", c.can_send ? "Sending is your click, with a confirm." :
      "Group People L&D sends it; copy it to pass it on."));
    var cp = el("button", "btn-link", "Copy"); cp.type = "button";
    cp.addEventListener("click", function () {
      var txt = subj.value + "\n\n" + body.value;
      function done() { cp.textContent = "Copied"; setTimeout(function () { cp.textContent = "Copy"; }, 2000); }
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(txt).then(done, function () {});
      else { body.select(); try { document.execCommand("copy"); done(); } catch (e) { /* nothing */ } }
    });
    acts.appendChild(cp);
    if (c.can_send) {
      var sb = el("button", "primary", "Send…"); sb.type = "submit"; acts.appendChild(sb);
      f.addEventListener("submit", function (e) {
        if (e.defaultPrevented) return;          // OneHR's confirm box asks first, then replays this submit
        e.preventDefault();
        sb.disabled = true;
        var fd = new FormData();
        fd.append("csrf_token", token()); fd.append("bg", c.bg); fd.append("subject", subj.value); fd.append("body", body.value);
        fetch(c.send_url, { method: "POST", body: fd, credentials: "same-origin" })
          .then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function (j) {
            msg.textContent = (j && j.message) || "That didn't send. Try again.";
            msg.hidden = false;
            msg.className = "ld-msg" + (j && j.ok ? " is-ok" : " is-err");
            sb.disabled = !!(j && j.ok);
          })
          .catch(function () { msg.textContent = "That didn't send. Try again."; msg.hidden = false; sb.disabled = false; });
      });
    }
    f.appendChild(acts);
    return f;
  }
  function agent(text, cards) {
    var row = el("div", "ld-ai"), b = el("div", "ld-ai-b");
    row.appendChild(spark());
    if (text) b.appendChild(el("div", "ld-bub", text));
    (cards || []).forEach(function (c) {
      if (c.kind === "table") b.appendChild(tableCard(c));
      else if (c.kind === "email") b.appendChild(emailCard(c));
    });
    row.appendChild(b);
    log.appendChild(row);
    toEnd();
  }
  function user(text) { log.appendChild(el("div", "ld-me", text)); toEnd(); }
  function setChips(items) {
    chips.innerHTML = "";
    (items || []).forEach(function (t) {
      var b = el("button", "ld-ask", t); b.type = "button"; b.disabled = !live;
      b.addEventListener("click", function () { turn(t); });
      chips.appendChild(b);
    });
  }
  function turn(text) {
    text = (text || "").trim();
    if (!text || busy || !live) return;
    busy = true;
    if (send) send.disabled = true;
    user(text);
    setChips([]);
    var thinking = el("p", "ld-thinking", "Looking…");
    log.appendChild(thinking);
    toEnd();
    var f = new FormData();
    f.append("csrf_token", token());
    f.append("message", text);
    fetch(url, { method: "POST", body: f, credentials: "same-origin" })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        thinking.remove();
        if (j && j.slowed) input.value = text;
        agent((j && j.say) || "Sorry, I lost the thread there. Could you say that again?", j && j.cards);
        setChips(j && j.quick_replies);
      })
      .catch(function () { thinking.remove(); agent("Connection lost. Try again in a moment."); })
      .then(function () { busy = false; if (send) send.disabled = !live; });
  }
  if (form) form.addEventListener("submit", function (e) {
    e.preventDefault();
    var t = input.value;
    input.value = "";
    turn(t);
  });
  Array.prototype.forEach.call(document.querySelectorAll(".ld-left .ld-ask[data-ask]"), function (b) {
    b.addEventListener("click", function () { turn(b.getAttribute("data-ask")); });
  });

  fetch(url + "?data=1", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j || !j.ok) return;
      agent(j.opening.say, j.opening.cards);
      var last = j.opening.quick_replies;
      (j.messages || []).forEach(function (m) {
        if (m.role === "user") user(m.content);
        else { agent(m.content, m.cards); last = m.quick_replies; }
      });
      setChips(last);
    })
    .catch(function () { agent("The agent couldn't load just now."); });
})();
