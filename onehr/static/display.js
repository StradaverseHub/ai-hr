/* Display: the Account menu's Text size and Theme controls (Chris, 2026-11-01; canvas [design canvas link removed]
   boards A1 and A2).
   A choice applies at once (data-text / data-theme on <html>, which style.css scales and repaints by) and is then saved to the
   person's account (POST /me/display, the form's csrf_token like every other post; one field a post, the server takes either
   alone). If the save fails the old choice comes back and the menu says so (an inline message, never an alert). Arrow keys move
   within a group. One save at a time per group: a quick run of clicks sends the last one. The two groups are the same control,
   so they share this code and differ only in what they name. */
(function () {
  "use strict";
  var root = document.documentElement;
  var err = document.getElementById("acct-disp-err");
  function say(msg) {
    if (!err) return;
    err.textContent = msg || "";
    err.hidden = !msg;
  }
  function token() {
    var m = document.querySelector('meta[name="csrf-token"]');
    return (m && m.content) || "";
  }
  /* spec: { sel: the group's attribute, pick: the button attribute, field: the form field, attr: the <html> attribute, noun: for the
     message, def: the value if the page carries none } */
  function control(spec) {
    var grp = document.querySelector(spec.sel);
    if (!grp) return;
    var btns = [].slice.call(grp.querySelectorAll("[" + spec.pick + "]"));
    var vals = btns.map(function (b) { return b.getAttribute(spec.pick); });
    var confirmed = root.getAttribute(spec.attr) || spec.def;   // the last value the server accepted
    var desired = confirmed, busy = false;

    function paint(v) {
      root.setAttribute(spec.attr, v);
      btns.forEach(function (b) {
        var on = b.getAttribute(spec.pick) === v;
        b.classList.toggle("on", on);
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.tabIndex = on ? 0 : -1;
      });
    }
    function labelOf(v) {
      var b = btns.filter(function (x) { return x.getAttribute(spec.pick) === v; })[0];
      return b ? b.getAttribute("data-label") : v;
    }
    function fail() {
      desired = confirmed;
      paint(confirmed);
      say("The " + spec.noun + " didn’t save, so it is back to " + labelOf(confirmed) + ". Try again.");
    }
    function flush() {
      if (busy || desired === confirmed) return;
      var sending = desired;
      busy = true;
      var fd = new FormData();
      fd.append("csrf_token", token());
      fd.append(spec.field, sending);
      fetch("/me/display", { method: "POST", body: fd, credentials: "same-origin",
                             headers: { "X-Requested-With": "XMLHttpRequest", "Accept": "application/json" } })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok && j && j.ok, j: j }; }); })
        .then(function (res) {
          busy = false;
          if (!res.ok) { fail(); return; }
          confirmed = sending;
          flush();
        })
        .catch(function () { busy = false; fail(); });
    }
    function pick(v) {
      if (vals.indexOf(v) < 0) return;
      say("");
      desired = v;
      paint(v);
      flush();
    }
    btns.forEach(function (b) {
      b.addEventListener("click", function () { pick(b.getAttribute(spec.pick)); });
    });
    grp.addEventListener("keydown", function (e) {
      var i = vals.indexOf(desired), n = vals.length, to = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") to = (i + 1) % n;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = (i - 1 + n) % n;
      else if (e.key === "Home") to = 0;
      else if (e.key === "End") to = n - 1;
      if (to < 0) return;
      e.preventDefault();
      e.stopPropagation();
      pick(vals[to]);
      btns[to].focus();
    });
  }
  control({ sel: "[data-display-text]", pick: "data-text-size", field: "text", attr: "data-text", noun: "text size", def: "m" });
  control({ sel: "[data-display-theme]", pick: "data-theme-pick", field: "theme", attr: "data-theme", noun: "theme", def: "light" });
})();
