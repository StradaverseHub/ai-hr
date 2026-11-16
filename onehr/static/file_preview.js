/* KPI files open in a preview box over the same page (Chris, 2026-11-07, canvas "File preview canvas 2026-11-07").
 *
 * Every place a KPI line's file opens (the admin person page's Remarks and files, the employee's check-in Files column, the
 * manager's and the leaders' journey views, the calibration report) draws the file as a link:
 *   <a href="<the plain DOWNLOAD url>" data-fpv-src="<the same url with ?disp=inline>" data-fpv-name="<file name>"
 *      data-fpv-kpi="<KPI name>" data-fpv-size="<212 KB>" data-fpv-gp="1">
 * One delegated click handler (here, loaded once from base.html) opens the box when the file's extension previews (the list
 * below mirrors app.py _ATTACH_INLINE_EXTS, tests/test_file_preview.py lints that they are equal); anything else, and any
 * click with Ctrl / Cmd / Shift / Alt or a non-primary button, is left to the browser, so Word, Excel, PowerPoint and CSV
 * download as before and with no script every link simply downloads.
 *
 * The box is OneHR's own dialog (the KPI description pop-out's shell: .modal-overlay.confirm-dialog.kpi-dlg > .modal-card, plus
 * .fpv-dlg for the size). A PDF or text file is a same-origin iframe, an image an <img> fitted and never enlarged. Closes on x,
 * Close, Esc or a click on the dark area; the page behind does not scroll or move; focus returns to the clicked link. The
 * server's routes are unchanged: the box only asks for ?disp=inline, so the admin audit row is written as for any open.
 * ONLY ONEHR'S OWN ADDRESSES open in the box (2026-11-11): the link's data-fpv-src (and its href, used for Download) is resolved
 * against the page, and the box opens only when the result is http: or https: and has this page's own origin (sameOrigin below);
 * a javascript: or data: address, another site, or one that does not parse is left to the browser as an ordinary link (no
 * preventDefault), and window.onehrFilePreview.open refuses it too. Nothing foreign is ever put in the frame, the image or
 * "Open in a new tab". Plain DOM, no libraries; no browser dialogs. */
(function () {
  "use strict";
  if (window.onehrFilePreview) return;

  // = app.py _ATTACH_INLINE_EXTS (a lint holds the two equal)
  var PREVIEW_EXTS = ["pdf", "png", "jpg", "jpeg", "gif", "webp", "txt"];
  var IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp"];

  function extOf(name) {
    var s = String(name || ""), i = s.lastIndexOf(".");
    return i >= 0 ? s.slice(i + 1).toLowerCase() : "";
  }
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function xIcon() {
    var NS = "http://www.w3.org/2000/svg", sv = document.createElementNS(NS, "svg"), pa = document.createElementNS(NS, "path");
    sv.setAttribute("width", "16"); sv.setAttribute("height", "16"); sv.setAttribute("viewBox", "0 0 24 24"); sv.setAttribute("fill", "none");
    sv.setAttribute("stroke", "currentColor"); sv.setAttribute("stroke-width", "2"); sv.setAttribute("stroke-linecap", "round");
    sv.setAttribute("aria-hidden", "true"); pa.setAttribute("d", "M6 6l12 12M18 6 6 18"); sv.appendChild(pa);
    return sv;
  }
  // 212 KB, 1.4 MB: the same rule as app.py _rf_size
  function fmtSize(n) {
    n = +n;
    if (!isFinite(n) || n < 0) return "";
    if (n < 1024) return Math.round(n) + " B";
    if (n < 1048576) return Math.round(n / 1024) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  // the address resolved against this page: the resolved text when it is http(s) on THIS origin, else "" (never a foreign one)
  function sameOrigin(u) {
    try {
      if (!String(u == null ? "" : u).trim()) return "";   // an empty address would resolve to this very page
      var r = new URL(String(u), location.href);
      if ((r.protocol === "http:" || r.protocol === "https:") && r.origin === location.origin) return r.href;
    } catch (e) { /* does not parse: not ours */ }
    return "";
  }

  var counter = 0;

  function open(a) {
    if (!a || !a.getAttribute) return false;
    var src = sameOrigin(a.getAttribute("data-fpv-src")), name = a.getAttribute("data-fpv-name") || "File";
    if (!src) return false;   // a foreign, unparsable or non-http(s) address never opens in the box
    var kpi = a.getAttribute("data-fpv-kpi") || "", size = a.getAttribute("data-fpv-size") || "";
    var gp = a.getAttribute("data-fpv-gp") === "1", dl = sameOrigin(a.getAttribute("href")) || src;
    var ext = extOf(name), isImg = IMAGE_EXTS.indexOf(ext) >= 0;

    var old = document.querySelector(".fpv-dlg");
    if (old && old._fpvClose) old._fpvClose(); else if (old && old.parentNode) old.parentNode.removeChild(old);

    var ov = el("div", "modal-overlay confirm-dialog kpi-dlg fpv-dlg");
    var card = el("div", "modal-card"); card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true");
    var hid = "fpv-h-" + (++counter); card.setAttribute("aria-labelledby", hid);
    var head = el("div", "kpi-dlg-head fpv-head"), body = el("div", "fpv-body"), foot = el("div", "kpi-dlg-foot fpv-foot");

    var x = el("button", "kpi-dlg-x"); x.type = "button"; x.setAttribute("aria-label", "Close"); x.appendChild(xIcon());
    head.appendChild(x);
    if (kpi) { var eb = el("p", "kpi-dlg-eyebrow fpv-eyebrow", kpi); eb.title = kpi; head.appendChild(eb); }
    var h = el("h2", "kpi-dlg-title fpv-title", name); h.id = hid; h.title = name; head.appendChild(h);
    var meta = el("p", "kpi-dlg-meta fpv-meta");
    if (size) meta.appendChild(el("span", "fpv-size", size));
    var px = el("span", "fpv-px"); px.hidden = true; meta.appendChild(px);
    if (gp) meta.appendChild(el("span", "fpv-tag", "Added by Group People"));
    head.appendChild(meta);

    var frame = null, img = null;
    if (isImg) {
      img = el("img", "fpv-img"); img.alt = name; img.decoding = "async";
      img.addEventListener("load", function () {
        if (img.naturalWidth) { px.textContent = img.naturalWidth + " × " + img.naturalHeight; px.hidden = false; }
      });
      img.addEventListener("error", function () {
        if (img.parentNode) img.parentNode.removeChild(img);
        body.appendChild(el("p", "fpv-fail", "This file could not be shown. Use Download to save it."));
      });
      img.src = src;
      body.className += " is-img"; body.appendChild(img);
    } else {
      frame = el("iframe", "fpv-frame"); frame.title = name; frame.src = src;
      body.className += " is-frame"; body.appendChild(frame);
    }

    var nt = el("a", "fpv-newtab", "Open in a new tab ↗"); nt.href = src; nt.target = "_blank"; nt.rel = "noopener";
    var acts = el("div", "fpv-acts");
    var dla = el("a", "fpv-btn", "Download"); dla.href = dl; dla.setAttribute("download", name);
    var cb = el("button", "fpv-btn is-pri", "Close"); cb.type = "button";
    acts.appendChild(dla); acts.appendChild(cb); foot.appendChild(nt); foot.appendChild(acts);
    card.appendChild(head); card.appendChild(body); card.appendChild(foot); ov.appendChild(card); document.body.appendChild(ov);

    // the page behind stays still while the box is open (as the KPI pop-out does)
    var root = document.documentElement, savedOverflow = root.style.overflow; root.style.overflow = "hidden";
    var done = false, bk = null;   // bk: the phone's back gesture closes the box first (static/move_in.js, onehrBackLayer)
    var close = function () {
      if (done) return; done = true;
      document.removeEventListener("keydown", onKey, true);
      if (frame) { try { frame.src = "about:blank"; } catch (e) { /* gone with the box anyway */ } }
      root.style.overflow = savedOverflow;
      if (ov.parentNode) ov.parentNode.removeChild(ov);
      if (bk) bk.done();
      if (a && a.focus && document.contains(a)) { try { a.focus({ preventScroll: true }); } catch (e) { a.focus(); } }
    };
    var tabs = frame ? [x, frame, nt, dla, cb] : [x, nt, dla, cb];   // the frame is a stop of its own, so Tab never skips the foot
    var onKey = function (e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "Tab") {
        var cur = document.activeElement, ix = tabs.indexOf(cur);
        if (ix < 0 || !card.contains(cur)) { e.preventDefault(); (e.shiftKey ? cb : x).focus(); }
        else if (e.shiftKey && ix === 0) { e.preventDefault(); cb.focus(); }
        else if (!e.shiftKey && ix === tabs.length - 1) { e.preventDefault(); x.focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    ov._fpvClose = close;
    if (typeof window.onehrBackLayer === "function") bk = window.onehrBackLayer(function () { close(); });
    x.addEventListener("click", close); cb.addEventListener("click", close);
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    // a text file is same-origin: Esc works from inside it too (the browser's PDF viewer keeps its own keys)
    if (frame) frame.addEventListener("load", function () {
      try { frame.contentDocument.addEventListener("keydown", onKey, true); } catch (e) { /* a viewer we cannot reach */ }
    });
    x.focus({ preventScroll: true });
    return true;
  }

  // capture phase: a link's own click handler (the manager's chips stop propagation so the row does not toggle) must not hide it
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    var t = e.target, a = t && t.closest ? t.closest("a[data-fpv-src]") : null;
    if (!a) return;
    if (PREVIEW_EXTS.indexOf(extOf(a.getAttribute("data-fpv-name"))) < 0) return;   // Word, Excel, ...: the link downloads
    if (!sameOrigin(a.getAttribute("data-fpv-src"))) return;   // not OneHR's own address: the link behaves as a plain link
    e.preventDefault(); e.stopPropagation();
    open(a);
  }, true);

  window.onehrFilePreview = { open: open, exts: PREVIEW_EXTS.slice(), fmtSize: fmtSize, sameOrigin: sameOrigin };
})();
