/* Grade H Appraisal, People & progress (2026-10-31, canvas A1 / A1b): picking several people, and the bulk Set appraiser's confirm box.
   The ticks, the pick-all (this page) and the bar are plain DOM; "Set appraiser for N" reloads the page with the bulk panel open
   (?panel=bulk&pick=<ids>), which the server draws (who is left out comes from the writer's own check). */
(function () {
  var bar = document.querySelector("[data-gh-bar]");
  if (bar) {
    var boxes = [].slice.call(document.querySelectorAll("input[data-gh-pick]")), all = document.querySelector("[data-gh-all]");
    var idle = bar.querySelector("[data-gh-idle]"), on = bar.querySelector("[data-gh-on]"), count = bar.querySelector("[data-gh-count]");
    var go = bar.querySelector("[data-gh-go]"), clear = bar.querySelector("[data-gh-clear]"), goHod = bar.querySelector("[data-gh-go-hod]");
    var picked = function () { return boxes.filter(function (b) { return b.checked; }); };
    var paint = function () {
      var p = picked(), n = p.length;
      boxes.forEach(function (b) { var tr = b.closest("tr"); if (tr) tr.classList.toggle("is-sel", b.checked); });
      if (all) { all.checked = n > 0 && n === boxes.length; all.indeterminate = n > 0 && n < boxes.length; }
      bar.classList.toggle("is-on", n > 0);
      idle.hidden = n > 0; on.hidden = n === 0;
      count.textContent = n + " picked";
      go.textContent = "Set appraiser for " + n;
      if (goHod) goHod.textContent = "Set HOD for " + n;
    };
    boxes.forEach(function (b) { b.addEventListener("change", paint); });
    if (all) all.addEventListener("change", function () { boxes.forEach(function (b) { b.checked = all.checked; }); paint(); });
    clear.addEventListener("click", function () { boxes.forEach(function (b) { b.checked = false; }); paint(); });
    go.addEventListener("click", function () {
      var ids = picked().map(function (b) { return b.value; });
      if (!ids.length) return;
      window.location.href = bar.getAttribute("data-gh-bulk-url") + "&pick=" + ids.join(",");
    });
    // Set HOD for several (2026-11-03, board H5): the same ticks, the bulk HOD panel
    if (goHod) goHod.addEventListener("click", function () {
      var ids = picked().map(function (b) { return b.value; });
      if (!ids.length) return;
      window.location.href = bar.getAttribute("data-gh-bulk-hod-url") + "&pick=" + ids.join(",");
    });
    paint();
  }
  // the bulk panel: the confirm box names the appraiser once one is picked (the picker says so with a "pick" event)
  var form = document.getElementById("gh-bulk-form");
  if (form) {
    var of = form.getAttribute("data-confirm-of") || "";
    form.addEventListener("pick", function (e) {
      var who = e.detail && e.detail.name ? e.detail.name : "the person you picked";
      form.setAttribute("data-confirm", "Make " + who + " the appraiser of " + of + "? They will see them in their Grade H list.");
    });
  }
  // the Set HOD for several panel (2026-11-03, board H5): the confirm box names the count and the picked HOD(s); the split opens once a second HOD
  // is picked; "Take away any second HOD" and a second HOD are one or the other
  var bform = document.getElementById("gh-bulkhod-form");
  if (bform) {
    var bof = bform.getAttribute("data-confirm-of") || "";
    var b1 = "", b2 = "";
    var bsel = bform.querySelector("[data-gh-split]"), bone = bform.querySelector("[data-gh-pick-1]"), btwo = bform.querySelector("[data-gh-pick-2]");
    var btick = bform.querySelector("[data-gh-clear2]"), bq2 = bform.querySelector("[data-gh-q2]"), bv2 = btwo ? btwo.querySelector(".pick-val") : null;
    var bnm = function (e) { return e && e.detail && e.detail.name ? e.detail.name + (e.detail.eid ? " (" + e.detail.eid + ")" : "") : ""; };
    var bwords = function () {
      var sp = bsel ? parseInt(bsel.value, 10) : 50, a = b1 || "the person you picked";
      var tail = " Their HOD in the main review does not change.";
      if (b2 && !(btick && btick.checked)) {
        bform.setAttribute("data-confirm", a + " and " + b2 + " will both calibrate " + bof + ", " + sp + " : " + (100 - sp) + "." + tail);
      } else if (btick && btick.checked) {
        bform.setAttribute("data-confirm", "Make " + a + " the Grade H HOD of " + bof + ", and take away any second HOD they have? Bands already set stay as they are." + tail);
      } else {
        bform.setAttribute("data-confirm", "Make " + a + " the Grade H HOD of " + bof + "? They will see them under Grade H. A second HOD a person already has stays." + tail);
      }
    };
    bform.addEventListener("pick", function (e) {
      var who = bnm(e) || "the person you picked";
      if (btwo && btwo.contains(e.target)) { b2 = who; if (bsel) bsel.disabled = false; if (btick) btick.checked = false; }
      else if (bone && bone.contains(e.target)) { b1 = who; }
      bwords();
    });
    if (bsel) bsel.addEventListener("change", bwords);
    if (btick) btick.addEventListener("change", function () {
      if (btick.checked) {   // a second HOD and taking it away are one or the other
        b2 = ""; if (bq2) bq2.value = ""; if (bv2) bv2.value = ""; if (bsel) bsel.disabled = true;
      }
      bwords();
    });
  }
  // the Set HODs form (2026-11-03): the confirm box names the picked HODs and the split; the split opens once a second HOD is picked. It is on the
  // Set HOD side panel (drawn with the page) and in the person panel's Change view (loaded after it): `window.onehrGradehWire(root)` wires the form
  // found under `root`, once, and the person panel's fragment calls it when it loads.
  function wireHod(hform) {
    if (!hform || hform._ghWired) return;
    hform._ghWired = true;
    var hfor = hform.getAttribute("data-confirm-for") || "";
    var n1 = hform.getAttribute("data-hod1") || "", n2 = hform.getAttribute("data-hod2") || "";
    var sel = hform.querySelector("[data-gh-split]");
    var one = hform.querySelector("[data-gh-pick-1]"), two = hform.querySelector("[data-gh-pick-2]");
    var nm = function (e) { return e && e.detail && e.detail.name ? e.detail.name + (e.detail.eid ? " (" + e.detail.eid + ")" : "") : ""; };
    var words = function () {
      var a = n1 || "their HOD", b = n2, sp = sel ? parseInt(sel.value, 10) : 50;
      if (b) {
        hform.setAttribute("data-confirm", a + " and " + b + " will both calibrate " + hfor + ", " + sp + " : " + (100 - sp) +
          ". Bands either HOD has already set stay as they are. Their HOD in the main review does not change.");
      } else {
        hform.setAttribute("data-confirm", "Make " + (n1 || "the person you picked") + " the Grade H HOD of " + hfor + "? They will see " + hfor +
          " under Grade H. Their HOD in the main review does not change.");
      }
    };
    hform.addEventListener("pick", function (e) {
      var who = nm(e) || "the person you picked";
      if (two && two.contains(e.target)) { n2 = who; if (sel) sel.disabled = false; }
      else if (one && one.contains(e.target)) { n1 = who; }
      words();
    });
    if (sel) sel.addEventListener("change", words);
  }
  window.onehrGradehWire = function (root) { wireHod((root || document).querySelector("#gh-hod-form")); };
  window.onehrGradehWire(document);
})();
