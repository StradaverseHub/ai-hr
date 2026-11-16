/* Learning › Settings › Certificates (2026-10-23, LMS canvas board 20F): Group People L&D places the fields OneHR fills
   in on CHART's design. Each field is a box on the design, as fractions of the page from its top left (what the server
   stores and the PDF draws from); drag a box to move it, its right edge to widen it. The side lists what OneHR fills in
   (ticked = on the certificate) and L&D's own words; the picked box's font, size, bold, colour and alignment are set
   beside it. Save and Preview send the boxes as JSON; the server checks every one. */
(function () {
  "use strict";
  var ed = document.querySelector("[data-cx-ed]");
  if (!ed) return;
  function readJson(id) {
    var n = document.getElementById(id);
    try { return n ? JSON.parse(n.textContent) : null; } catch (e) { return null; }
  }
  var init = readJson("cx-init") || {}, dataRows = readJson("cx-data") || [], colours = {};
  (readJson("cx-colours") || []).forEach(function (c) { colours[c[0]] = c[1]; });
  var can = !!init.can, stage = ed.querySelector("[data-cx-stage]"), ownBox = ed.querySelector("[data-cx-own]"),
      style = ed.querySelector("[data-cx-style]"), labels = {}, samples = {};
  dataRows.forEach(function (r) { labels[r[0]] = r[1]; samples[r[0]] = r[2]; });
  var fields = (init.fields || []).map(function (f) { return Object.assign({}, f); });
  var picked = null, PAGE_PT = init.portrait ? 595 : 842;

  function defaults(key, text) {
    return {key: key, x: 0.14, y: 0.45, w: 0.72, size: key === "own" ? 12 : 14, font: "sans", bold: false,
            color: "ink", align: "center", text: text};
  }
  function scale() { return stage.clientWidth / PAGE_PT; }
  function textOf(f) { return f.key === "own" ? f.text : samples[f.key]; }

  function draw() {
    Array.prototype.forEach.call(stage.querySelectorAll(".cx-box"), function (b) { b.remove(); });
    var W = stage.clientWidth, H = stage.clientHeight, k = scale();
    fields.forEach(function (f, i) {
      var b = document.createElement("div");
      b.className = "cx-box" + (picked === i ? " is-picked" : "");
      b.style.left = (f.x * W) + "px";
      b.style.top = (f.y * H) + "px";
      b.style.width = (f.w * W) + "px";
      b.style.fontSize = (f.size * k) + "px";
      b.style.fontFamily = f.font === "serif" ? "Georgia, 'Times New Roman', serif" : "Helvetica, Arial, sans-serif";
      b.style.fontWeight = f.bold ? "700" : "400";
      b.style.color = colours[f.color] || "#1F2330";
      b.style.textAlign = f.align;
      b.setAttribute("data-i", i);
      var t = document.createElement("span");
      t.className = "cx-text";
      t.textContent = textOf(f) || "";
      b.appendChild(t);
      var tag = document.createElement("span");
      tag.className = "cx-tag";
      tag.textContent = f.key === "own" ? "Your words" : labels[f.key];
      b.appendChild(tag);
      if (can) {
        var h = document.createElement("span");
        h.className = "cx-grip";
        h.setAttribute("data-grip", "1");
        b.appendChild(h);
      }
      stage.appendChild(b);
    });
    // the side's ticks follow the boxes
    Array.prototype.forEach.call(ed.querySelectorAll("[data-cx-data]"), function (cb) {
      cb.checked = fields.some(function (f) { return f.key === cb.getAttribute("data-cx-data"); });
    });
    drawOwn();
    drawStyle();
  }

  function drawOwn() {
    ownBox.innerHTML = "";
    fields.forEach(function (f, i) {
      if (f.key !== "own") return;
      var row = document.createElement("div");
      row.className = "cx-own" + (picked === i ? " is-picked" : "");
      var inp = document.createElement("input");
      inp.type = "text";
      inp.maxLength = 120;
      inp.value = f.text || "";
      inp.setAttribute("aria-label", "Your own words");
      inp.disabled = !can;
      inp.addEventListener("input", function () { f.text = inp.value; redrawText(i); });
      inp.addEventListener("focus", function () { pick(i, true); });
      row.appendChild(inp);
      if (can) {
        var x = document.createElement("button");
        x.type = "button";
        x.className = "cx-x";
        x.setAttribute("aria-label", "Take these words off");
        x.textContent = "×";
        x.addEventListener("click", function () { fields.splice(i, 1); picked = null; draw(); });
        row.appendChild(x);
      }
      ownBox.appendChild(row);
    });
  }

  function redrawText(i) {
    var b = stage.querySelector('.cx-box[data-i="' + i + '"] .cx-text');
    if (b) b.textContent = textOf(fields[i]) || "";
  }

  function drawStyle() {
    if (picked === null || !fields[picked]) { style.hidden = true; return; }
    var f = fields[picked];
    style.hidden = false;
    style.querySelector("[data-cx-style-name]").textContent = f.key === "own" ? "Your words" : labels[f.key];
    style.querySelector("[data-cx-size-v]").textContent = f.size;
    Array.prototype.forEach.call(style.querySelectorAll("[data-cx-set]"), function (grp) {
      var prop = grp.getAttribute("data-cx-set"), cur = prop === "bold" ? (f.bold ? "1" : "0") : f[prop];
      Array.prototype.forEach.call(grp.querySelectorAll("button"), function (b) {
        b.classList.toggle("is-on", b.getAttribute("data-v") === String(cur));
        b.disabled = !can;
      });
    });
  }

  function pick(i, keepOwn) {
    picked = i;
    Array.prototype.forEach.call(stage.querySelectorAll(".cx-box"), function (b) {
      b.classList.toggle("is-picked", Number(b.getAttribute("data-i")) === i);
    });
    if (!keepOwn) drawOwn();
    drawStyle();
  }

  // the side: what OneHR fills in, on or off
  Array.prototype.forEach.call(ed.querySelectorAll("[data-cx-data]"), function (cb) {
    cb.addEventListener("change", function () {
      var key = cb.getAttribute("data-cx-data");
      if (cb.checked) {
        fields.push(defaults(key));
        picked = fields.length - 1;
      } else {
        fields = fields.filter(function (f) { return f.key !== key; });
        picked = null;
      }
      draw();
    });
  });
  var add = ed.querySelector("[data-cx-add]");
  if (add) add.addEventListener("click", function () {
    fields.push(defaults("own", "Your words"));
    picked = fields.length - 1;
    draw();
    var last = ownBox.querySelector(".cx-own:last-child input");
    if (last) { last.focus(); last.select(); }
  });

  // the picked box's style
  Array.prototype.forEach.call(style.querySelectorAll("[data-cx-set] button"), function (b) {
    b.addEventListener("click", function () {
      if (picked === null) return;
      var prop = b.parentNode.getAttribute("data-cx-set"), v = b.getAttribute("data-v");
      fields[picked][prop] = prop === "bold" ? v === "1" : v;
      draw();
    });
  });
  Array.prototype.forEach.call(style.querySelectorAll("[data-cx-size]"), function (b) {
    b.addEventListener("click", function () {
      if (picked === null) return;
      var f = fields[picked];
      f.size = Math.max(6, Math.min(72, f.size + Number(b.getAttribute("data-cx-size")) * (f.size >= 20 ? 2 : 1)));
      draw();
    });
  });

  // dragging: move a box, or widen it by its right edge; kept on the page
  var drag = null;
  stage.addEventListener("pointerdown", function (e) {
    var b = e.target.closest(".cx-box");
    if (!b) { pick(null); return; }
    var i = Number(b.getAttribute("data-i"));
    pick(i);
    if (!can) return;
    e.preventDefault();
    drag = {i: i, grip: !!e.target.getAttribute("data-grip"), x0: e.clientX, y0: e.clientY,
            f0: Object.assign({}, fields[i]), W: stage.clientWidth, H: stage.clientHeight, b: b};
    b.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", function (e) {
    if (!drag) return;
    var f = fields[drag.i], dx = (e.clientX - drag.x0) / drag.W, dy = (e.clientY - drag.y0) / drag.H;
    if (drag.grip) {
      f.w = Math.max(0.05, Math.min(1 - f.x, drag.f0.w + dx));
      drag.b.style.width = (f.w * drag.W) + "px";
    } else {
      f.x = Math.max(0, Math.min(1 - f.w, drag.f0.x + dx));
      f.y = Math.max(0, Math.min(0.97, drag.f0.y + dy));
      drag.b.style.left = (f.x * drag.W) + "px";
      drag.b.style.top = (f.y * drag.H) + "px";
    }
  });
  function endDrag() {
    if (!drag) return;
    var f = fields[drag.i];
    ["x", "y", "w"].forEach(function (k) { f[k] = Math.round(f[k] * 10000) / 10000; });
    drag = null;
  }
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  // arrows nudge the picked box, for a precise place
  document.addEventListener("keydown", function (e) {
    if (picked === null || !can || !/^Arrow/.test(e.key) || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    var f = fields[picked], st = e.shiftKey ? 0.01 : 0.002;
    if (e.key === "ArrowLeft") f.x = Math.max(0, f.x - st);
    if (e.key === "ArrowRight") f.x = Math.min(1 - f.w, f.x + st);
    if (e.key === "ArrowUp") f.y = Math.max(0, f.y - st);
    if (e.key === "ArrowDown") f.y = Math.min(0.97, f.y + st);
    e.preventDefault();
    draw();
  });

  // Save and Preview carry the boxes
  Array.prototype.forEach.call(document.querySelectorAll("[data-cx-form]"), function (form) {
    form.addEventListener("submit", function () {
      var payload = JSON.stringify(fields.map(function (f) {
        var o = {key: f.key, x: f.x, y: f.y, w: f.w, size: f.size, font: f.font, bold: !!f.bold, color: f.color,
                 align: f.align};
        if (f.key === "own") o.text = f.text;
        return o;
      }));
      Array.prototype.forEach.call(form.querySelectorAll("[data-cx-json]"), function (h) { h.value = payload; });
    }, true);
  });

  var raf = null;
  window.addEventListener("resize", function () {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(draw);
  });
  draw();
})();
