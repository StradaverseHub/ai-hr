/* The conversational PERFORMANCE-CALIBRATION assistant's client.
 *
 * A HOD/BUCEO talks the spread through with the agent. The SERVER decides
 * everything -- who is off the reference curve, what a valid move is, the
 * framework guardrail -- so this file computes nothing. It sends text, paints
 * bubbles, shows the distribution + roster being calibrated, and (on the lock
 * card) posts the human's Lock to the EXISTING lock route.
 *
 * A widget control (the per-person band select, the explain link) sends a
 * natural-language phrase into the turn loop, which the agent maps to a validated
 * tool -- the one-write-path discipline, exactly as the setting library's Add chip.
 * Reuses the rv-* chat classes and the calib-dist-* distribution classes.
 */
(function () {
  "use strict";
  var root = document.getElementById("rv-chat");
  if (!root) return;
  var log = document.getElementById("rv-chat-log");
  var pin = document.getElementById("rv-calib-pin");
  var quick = document.getElementById("rv-chat-quick");
  var form = document.getElementById("rv-chat-form");
  var input = document.getElementById("rv-chat-input");
  var send = document.getElementById("rv-chat-send");
  var sendUrl = root.getAttribute("data-send-url");
  var histUrl = root.getAttribute("data-history-url");
  var tier = root.getAttribute("data-tier");

  // The scope params echoed on every turn (never stored server-side).
  function scopeParams(f) {
    f.append("tier", tier);
    if (tier === "hod") f.append("hod_id", root.getAttribute("data-hod-id") || "");
    else { f.append("bg", root.getAttribute("data-bg") || ""); f.append("company", root.getAttribute("data-company") || ""); }
  }

  function token() {
    var m = document.querySelector('input[name="csrf_token"]');
    if (m) return m.value;
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute("content") : "";
  }

  var DASH = "—";
  function scrollToBottom() { log.scrollTop = log.scrollHeight; }
  function scrollSoon() {
    scrollToBottom();
    if (window.requestAnimationFrame) requestAnimationFrame(scrollToBottom);
    else setTimeout(scrollToBottom, 0);
  }

  function bubble(role, text) {
    var d = document.createElement("div");
    d.className = "rv-msg rv-msg-" + (role === "user" ? "user" : "agent");
    d.textContent = text;
    log.appendChild(d);
    scrollToBottom();
    return d;
  }

  function bandPill(code, label) {
    if (!code) return null;
    var s = document.createElement("span");
    s.className = "potential-pill rv-band-pill";
    s.setAttribute("data-band", code);
    s.textContent = label || code;
    return s;
  }

  /* ---- the pinned distribution + roster: a LIVE widget ---------------------- *
   * Rebuilt from the server's `overview` every turn, so a move made through the
   * chat shows up here immediately.                                             */

  // The distribution box: one bar per band vs the reference curve, reusing the
  // grid's own .calib-dist-* classes so it reads identically to the calibration page.
  function buildDistBox(d) {
    var box = document.createElement("div");
    box.className = "admin-card rv-calib-dist";
    var order = d.band_order || [];
    var labels = d.label_names || {};
    var total = d.total || 0;
    var h = document.createElement("h2");
    h.textContent = "Distribution vs. reference curve"
      + (d.curve && d.curve.label ? " (" + d.curve.label + ")" : "");
    box.appendChild(h);
    order.forEach(function (b) {
      var n = (d.distribution || {})[b] || 0;
      var tgt = (d.target || {})[b] || 0;
      var gap = (d.gaps || {})[b] || 0;
      var pct = total ? Math.round(n / total * 100) : 0;
      var row = document.createElement("div"); row.className = "calib-dist-row";
      var lab = document.createElement("span"); lab.className = "calib-dist-band"; lab.textContent = labels[b] || b;
      row.appendChild(lab);
      var bar = document.createElement("div"); bar.className = "calib-dist-bar";
      var fill = document.createElement("span");
      fill.className = "calib-dist-fill calib-dist-" + b.toLowerCase();
      fill.style.width = pct + "%"; bar.appendChild(fill);
      var tick = document.createElement("span"); tick.className = "calib-dist-tick";
      tick.style.left = tgt + "%"; tick.title = "Target: " + tgt + "%"; bar.appendChild(tick);
      row.appendChild(bar);
      var pctl = document.createElement("span"); pctl.className = "calib-dist-pct";
      pctl.innerHTML = n + " &middot; " + pct + "% <span class='muted small'>(target " + tgt + "%)</span>";
      row.appendChild(pctl);
      var g = document.createElement("span");
      g.className = "calib-dist-gap " + (gap > 0 ? "is-short" : gap < 0 ? "is-over" : "is-onTarget");
      g.textContent = !total ? DASH : gap > 0 ? ("Need +" + gap + " more") : gap < 0 ? ((-gap) + " over target") : "On target";
      row.appendChild(g);
      box.appendChild(row);
    });
    // The framework verdict line.
    var breaches = d.breaches || {};
    var off = Object.keys(breaches);
    var note = document.createElement("div");
    note.className = "rv-calib-verdict " + (off.length ? "is-off" : "is-ok");
    if (d.locked) note.textContent = "Locked.";
    else if (!off.length) note.textContent = "Within the framework (tolerance " + d.tolerance + " per band).";
    else note.textContent = "Outside the framework in " + off.map(function (b) { return (d.label_names || {})[b] || b; }).join(", ")
      + " (tolerance " + d.tolerance + " per band).";
    box.appendChild(note);
    return box;
  }

  // The roster: each person, their current band (a pill + a band select that sends
  // "Move X to Y." through the chat), what they inherited, and their cited-evidence
  // count with an "explain" link. A not-yet-finalised person can't be moved.
  function buildRoster(d) {
    var wrap = document.createElement("div"); wrap.className = "rv-calib-roster";
    var order = d.band_order || [];
    var labels = d.label_names || {};
    var tbl = document.createElement("table"); tbl.className = "rv-scorecard rv-calib-roster-tbl";
    var thead = document.createElement("thead"); var hr = document.createElement("tr");
    ["Person", "Band", "Came in as", "Evidence", ""].forEach(function (x) {
      var th = document.createElement("th"); th.textContent = x; hr.appendChild(th);
    });
    thead.appendChild(hr); tbl.appendChild(thead);
    var tb = document.createElement("tbody");
    (d.rows || []).forEach(function (r) {
      var tr = document.createElement("tr");
      var nc = document.createElement("td"); nc.className = "rv-kpi-cell";
      var nm = document.createElement("div"); nm.className = "rv-kpi-name"; nm.textContent = r.name; nc.appendChild(nm);
      tr.appendChild(nc);
      // Band cell: a select (or, when locked / not finalised, a static pill / note).
      var bc = document.createElement("td");
      if (!r.finalised) {
        var ni = document.createElement("span"); ni.className = "muted small"; ni.textContent = "not finalised"; bc.appendChild(ni);
      } else if (d.locked) {
        var pl = bandPill(r.current_band, labels[r.current_band]); if (pl) bc.appendChild(pl);
      } else {
        var sel = document.createElement("select"); sel.className = "modern-select rv-calib-band-select";
        order.forEach(function (b) {
          var o = document.createElement("option"); o.value = b; o.textContent = labels[b] || b;
          if (b === r.current_band) o.selected = true; sel.appendChild(o);
        });
        sel.setAttribute("data-name", r.name);
        sel.addEventListener("change", function () {
          if (busy) { return; }
          sel.disabled = true;
          sendTurn('Move ' + r.name + ' to ' + (labels[sel.value] || sel.value) + '.');
        });
        bc.appendChild(sel);
        if (r.adjusted) { var mv = document.createElement("span"); mv.className = "rv-calib-moved"; mv.textContent = "moved"; bc.appendChild(mv); }
      }
      tr.appendChild(bc);
      var ic = document.createElement("td"); ic.className = "muted small";
      ic.textContent = (r.incoming_band ? (labels[r.incoming_band] || r.incoming_band) : DASH); tr.appendChild(ic);
      var ec = document.createElement("td");
      ec.textContent = r.n_why ? (r.n_why + " cited") : "none";
      if (r.why_flag && r.why_flag !== "none") {
        var fl = document.createElement("span"); fl.className = "rv-calib-flag rv-calib-flag-" + r.why_flag;
        fl.textContent = r.why_flag === "both" ? "both accounts" : r.why_flag; ec.appendChild(document.createTextNode(" ")); ec.appendChild(fl);
      }
      tr.appendChild(ec);
      var xc = document.createElement("td");
      var ex = document.createElement("button"); ex.type = "button"; ex.className = "rv-chip rv-calib-explain";
      ex.textContent = "Explain";
      ex.addEventListener("click", function () { if (!busy) sendTurn('Tell me about ' + r.name + '.'); });
      xc.appendChild(ex); tr.appendChild(xc);
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); wrap.appendChild(tbl);
    return wrap;
  }

  function buildWidget(d) {
    var frag = document.createDocumentFragment();
    frag.appendChild(buildDistBox(d));
    frag.appendChild(buildRoster(d));
    return frag;
  }

  function refreshOverview(data) {
    if (!pin) return;
    // ABSENT is not EMPTY: a degraded turn returns no overview; ignoring undefined
    // keeps the pinned widget on screen. null clears.
    if (data === undefined) return;
    pin.innerHTML = "";
    if (!data) return;
    pin.appendChild(buildWidget(data));
  }

  // The distribution snapshot card (show_distribution) -- a read-only echo of the pin.
  function buildDistCard(d) {
    var wrap = document.createElement("div"); wrap.className = "rv-msg rv-msg-agent rv-card";
    wrap.appendChild(buildDistBox(d));
    wrap.appendChild(buildRoster(d));
    return wrap;
  }

  // The LOCK confirm card: the final distribution, any remaining breach, and a Lock
  // button that posts to the EXISTING lock route. When it still breaches, the
  // Phase-1.5 override affordance (.calib-override-btn) captures a reason. The agent
  // never locks -- only this human click does.
  function buildLockCard(d) {
    var wrap = document.createElement("div");
    wrap.className = "rv-msg rv-msg-agent rv-card rv-confirm";
    var h = document.createElement("div"); h.className = "rv-confirm-head"; h.textContent = "Lock this calibration";
    wrap.appendChild(h);
    wrap.appendChild(buildDistBox(d));
    var pending = d.pending || [];
    if (pending.length) {
      var pw = document.createElement("div"); pw.className = "rv-confirm-warn";
      pw.textContent = "Waiting on the tier below to lock first: " + pending.join(", ") + ".";
      wrap.appendChild(pw);
    }
    if (d.breach_message) {
      var bw = document.createElement("div"); bw.className = "rv-confirm-warn";
      bw.textContent = d.breach_message; wrap.appendChild(bw);
    }
    // The lock form posts to the existing lock route. Built in JS, so it carries its
    // own csrf_token (the load-time stamp doesn't reach a dynamically-added form).
    var f = document.createElement("form");
    f.method = "post"; f.action = d.lock_url;
    f.setAttribute("data-confirm-title", "Lock this calibration?");
    f.setAttribute("data-confirm-ok", "Lock calibration");
    f.setAttribute("data-confirm-tone", "danger");
    f.setAttribute("data-confirm", "Lock this " + (tier === "hod" ? "department" : "business unit")
      + "'s performance calibration? Your tier above can then roll it up.");
    var tok = document.createElement("input"); tok.type = "hidden"; tok.name = "csrf_token"; tok.value = token();
    f.appendChild(tok);
    var actions = document.createElement("div"); actions.className = "rv-confirm-actions";
    if (!pending.length) {
      var yes = document.createElement("button"); yes.type = "submit"; yes.className = "rv-confirm-yes primary";
      yes.textContent = "Lock calibration"; actions.appendChild(yes);
      if (d.breach_message) {
        var ovr = document.createElement("button"); ovr.type = "button";
        ovr.className = "btn-link calib-override-btn"; ovr.textContent = "Lock with override…";
        actions.appendChild(ovr);
      }
    }
    f.appendChild(actions); wrap.appendChild(f);
    return wrap;
  }

  function renderCard(card) {
    if (!card) return;
    if (card.type === "calib_distribution") { log.appendChild(buildDistCard(card.data || {})); scrollSoon(); return; }
    if (card.type === "calib_lock") { log.appendChild(buildLockCard(card.data || {})); scrollSoon(); return; }
  }

  function setQuick(items) {
    quick.innerHTML = "";
    (items || []).forEach(function (t) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "rv-chip"; b.textContent = t;
      b.addEventListener("click", function () { sendTurn(t); });
      quick.appendChild(b);
    });
  }

  var busy = false;
  function sendTurn(explicit) {
    if (busy) return;
    var fromInput = (explicit === undefined);
    var msg = fromInput ? (input.value || "").trim() : String(explicit);
    if (!msg && log.querySelector(".rv-msg")) return;
    if (msg) bubble("user", msg);
    if (fromInput) { input.value = ""; input.style.height = ""; }
    setQuick([]);
    busy = true; send.disabled = true;
    var typing = bubble("agent", "…"); typing.classList.add("rv-typing");
    var f = new FormData();
    f.append("csrf_token", token());
    f.append("message", msg);
    scopeParams(f);
    fetch(sendUrl, { method: "POST", body: f, credentials: "same-origin" })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        typing.remove();
        if (j && j.say) bubble("agent", j.say);
        (j && j.renders || []).forEach(renderCard);
        refreshOverview(j && j.overview);
        setQuick(j && j.quick_replies);
        scrollSoon();
      })
      .catch(function () { typing.remove(); bubble("agent", "(connection lost — try again)"); })
      .then(function () { busy = false; send.disabled = false; });
  }

  form.addEventListener("submit", function (e) { e.preventDefault(); sendTurn(); });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTurn(); }
  });
  input.addEventListener("input", function () {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  });

  var hf = new URLSearchParams();
  hf.append("tier", tier);
  if (tier === "hod") hf.append("hod_id", root.getAttribute("data-hod-id") || "");
  else { hf.append("bg", root.getAttribute("data-bg") || ""); hf.append("company", root.getAttribute("data-company") || ""); }
  fetch(histUrl + "?" + hf.toString(), { credentials: "same-origin" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (!j) return;
      var msgs = j.messages || [];
      msgs.forEach(function (m) {
        bubble(m.role, m.content);
        (m.card || []).forEach(renderCard);
      });
      refreshOverview(j.overview);
      var last = msgs[msgs.length - 1];
      if (last && last.role === "agent" && last.quick_replies) setQuick(last.quick_replies);
      scrollSoon();
      if (root.getAttribute("data-unavailable")) {
        if (!msgs.length) bubble("agent", "The calibration assistant isn't switched on yet — you can still use the calibration grid.");
        input.disabled = true; send.disabled = true;
        return;
      }
      if (!msgs.length) sendTurn();
    });
})();
