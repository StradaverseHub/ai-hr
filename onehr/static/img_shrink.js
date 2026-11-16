/* A photo shrinks in the browser before it uploads (Chris, 2026-10-23: "shrink photos in the browser, raise the cap to
   5 MB"). A phone photo is 2-6 MB; redrawn at 2000 px on its long side as a JPEG it is usually well under 1 MB and
   still sharp enough to read (the manager's insight transcribes it), and the redraw drops the photo's hidden details
   (where it was taken, the camera). Only a JPEG / PNG / WebP over 1 MB or over 2000 px is redrawn; a GIF (it may move)
   and every other file go as they are. Anything that fails -- a browser that can't draw it, a result no smaller --
   sends the original, and the server's cap decides. window.onehrShrink: plan (pure, the suite runs it), file, all. */
(function () {
  "use strict";
  var MAX_SIDE = 2000, MIN_BYTES = 1024 * 1024, QUALITY = 0.85;
  var TYPES = /^image\/(jpeg|png|webp)$/i, EXTS = /\.(jpe?g|png|webp)$/i;

  // {w, h} to redraw at, or null to send the file as it is.
  function plan(w, h, bytes) {
    if (!(w > 0 && h > 0)) return null;
    var side = Math.max(w, h);
    if (side <= MAX_SIDE && bytes <= MIN_BYTES) return null;
    var k = Math.min(1, MAX_SIDE / side);
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }

  function isPhoto(file) {
    return !!file && (TYPES.test(file.type || "") || EXTS.test(file.name || ""));
  }

  function jpgName(name) {
    var n = name || "photo";
    return /\.[^.\/]+$/.test(n) ? n.replace(/\.[^.\/]+$/, ".jpg") : n + ".jpg";
  }

  // A Promise of the file to upload: the redrawn JPEG, or the original.
  function file(f) {
    return new Promise(function (resolve) {
      if (!isPhoto(f) || typeof document === "undefined" || !window.URL || !URL.createObjectURL) { resolve(f); return; }
      var url = URL.createObjectURL(f), img = new Image(), done = false;
      function give(out) {
        if (done) return;
        done = true; clearTimeout(timer);
        try { URL.revokeObjectURL(url); } catch (e) { /* nothing to free */ }
        resolve(out);
      }
      var timer = setTimeout(function () { give(f); }, 15000);
      img.onerror = function () { give(f); };
      img.onload = function () {
        var p = plan(img.naturalWidth, img.naturalHeight, f.size);
        if (!p) { give(f); return; }
        try {
          var c = document.createElement("canvas");
          c.width = p.w; c.height = p.h;
          var g = c.getContext("2d");
          g.fillStyle = "#fff"; g.fillRect(0, 0, p.w, p.h);   // a PNG's see-through parts turn white, not black
          g.drawImage(img, 0, 0, p.w, p.h);                   // the browser turns a phone photo the right way up
          c.toBlob(function (b) {
            if (!b || b.size >= f.size) { give(f); return; }
            try { give(new File([b], jpgName(f.name), { type: "image/jpeg", lastModified: Date.now() })); }
            catch (e) { give(f); }
          }, "image/jpeg", QUALITY);
        } catch (e) { give(f); }
      };
      img.src = url;
    });
  }

  // One at a time, so a pick of several big photos never holds them all decoded at once.
  function all(files) {
    var out = [];
    return (files || []).reduce(function (p, f) {
      return p.then(function () { return file(f); }).then(function (g) { out.push(g); });
    }, Promise.resolve()).then(function () { return out; });
  }

  window.onehrShrink = { plan: plan, file: file, all: all, MAX_SIDE: MAX_SIDE, MIN_BYTES: MIN_BYTES };
})();
