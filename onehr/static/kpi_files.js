/* Add a file to a KPI line, for an admin whose role has People > Add and remove KPI files (Remarks and files, 2026-11-07, canvas A2b).
 * "+ Add a file" (data-fadd-open) opens OneHR's own box in the confirm dialog's look: the file (the page's hidden file input, so
 * the choice is posted as it is), then why (required, 500 characters at most). Add file writes the reason into the line's form and
 * posts it. The server checks everything again: the types, the 5 MB, up to 4 a line, results not out, the reason. Plain DOM; the
 * click is delegated, so a panel that loads this tab later works too. */
(function () {
  if (window.__ppFileAdd) return;
  window.__ppFileAdd = true;
  var TYPES = "PDF, an image, Word, Excel, PowerPoint, CSV or TXT";
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function size(n) { return n < 1024 ? n + " B" : n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1).replace(/\.0$/, "") + " MB"; }
  function open(form) {
    var input = form.querySelector('input[type="file"]');
    var reasonField = form.querySelector('input[name="reason"]');
    var max = parseInt(form.getAttribute("data-fadd-max"), 10) || 5242880;
    var kpi = form.getAttribute("data-fadd-name") || "this KPI", who = form.getAttribute("data-fadd-who") || "them";
    input.value = "";
    var ov = el("div", "modal-overlay confirm-dialog");
    var card = el("div", "modal-card"); card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true");
    var head = el("div", "confirm-dialog__head");
    var icon = el("span", "confirm-dialog__icon"); icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.5l-8.5 8.5a6 6 0 01-8.5-8.5l9-9a4 4 0 015.7 5.7l-9 9a2 2 0 01-2.8-2.8l8.3-8.3"/></svg>';
    var h = el("h2", null, "Add a file to " + kpi + "?"); h.id = "pp-fadd-title"; card.setAttribute("aria-labelledby", h.id);
    head.appendChild(icon); head.appendChild(h);
    var msg = el("p", "confirm-dialog__msg", "It goes on " + who + "'s KPI as a supporting file, tagged Group People. They and their managers see it, and AI+ reads it again.");
    var fl = el("label", "confirm-dialog__reason", "File");
    var pick = el("div", "pp-fadd-pick");
    var pbtn = el("button", "pp-fadd-choose", "Choose a file"); pbtn.type = "button";
    var pname = el("span", "pp-fadd-name", PICK_HINT());
    pick.appendChild(pbtn); pick.appendChild(pname); fl.appendChild(pick);
    var err = el("p", "pp-fadd-err"); err.hidden = true; err.setAttribute("role", "alert");
    var rl = el("label", "confirm-dialog__reason", "Why you're adding it");
    var ta = el("textarea"); ta.rows = 3; ta.maxLength = 500; ta.placeholder = "Required: it goes in the audit trail"; rl.appendChild(ta);
    var acts = el("div", "modal-actions");
    var cancel = el("button", "btn-link", "Cancel"); cancel.type = "button";
    var ok = el("button", "primary", "Add file"); ok.type = "button"; ok.disabled = true;
    acts.appendChild(cancel); acts.appendChild(ok);
    [head, msg, fl, err, rl, acts].forEach(function (n) { card.appendChild(n); });
    ov.appendChild(card); document.body.appendChild(ov);
    function PICK_HINT() { return TYPES + " · " + size(max) + " at most"; }
    var last = document.activeElement;
    function close() { ov.remove(); document.removeEventListener("keydown", onKey); if (last && last.focus) last.focus(); }
    function onKey(e) { if (e.key === "Escape") { input.value = ""; close(); } }
    function sync() {
      var f = input.files && input.files[0], bad = "";
      if (f) {
        var ext = (f.name.split(".").pop() || "").toLowerCase();
        if (!/^(pdf|png|jpe?g|gif|webp|docx?|xlsx?|pptx?|csv|txt)$/.test(ext)) bad = "That kind of file can't be added. Use " + TYPES + ".";
        else if (f.size > max) bad = "That file is too large: " + size(max) + " is the limit.";
        pname.textContent = f.name + " · " + size(f.size); pname.title = f.name;
      } else { pname.textContent = PICK_HINT(); pname.title = ""; }
      err.hidden = !bad; err.textContent = bad;
      ok.disabled = !(f && !bad && ta.value.trim());
    }
    pbtn.addEventListener("click", function () { input.click(); });
    input.addEventListener("change", sync);
    ta.addEventListener("input", sync);
    cancel.addEventListener("click", function () { input.value = ""; close(); });
    ov.addEventListener("click", function (e) { if (e.target === ov) { input.value = ""; close(); } });
    document.addEventListener("keydown", onKey);
    ok.addEventListener("click", function () {
      if (ok.disabled) return;
      reasonField.value = ta.value.trim();
      ok.disabled = true; cancel.disabled = true;
      ov.remove(); document.removeEventListener("keydown", onKey);
      HTMLFormElement.prototype.submit.call(form);
    });
    setTimeout(function () { pbtn.focus(); }, 30);
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-fadd-open]");
    if (!b) return;
    var form = b.parentNode && b.parentNode.querySelector("form.pp-fadd");
    if (!form) return;
    e.preventDefault();
    open(form);
  });
})();
