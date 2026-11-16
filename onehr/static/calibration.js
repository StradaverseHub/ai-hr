/* Auto-save + live distribution + a pop-out justification editor for the
 * Calibration module's tier views.
 *
 * Distribution has two modes, chosen by markup already on the page:
 *  - LEGACY (HOD / BG views): delta-vs-page-load (data-baseline / data-target).
 *  - OVERLAY (company/BUCEO view): #calib-dist-box.dept-mode + a .calib-dist-ref
 *    per band -- SOLID = the rows currently in view (column filters), faded
 *    GHOST = company overall; recomputed on filter/sort (MutationObserver) and
 *    on every adjustment.
 *
 * Justification is written in a shared pop-out editor: each row's form has a
 * hidden `justification` input + a .calib-just-btn; clicking it opens a floating
 * textarea, and committing it (Done / click-away) writes back and autosaves.
 * Templates that still use a plain visible justification input keep working via
 * the blur fallback.
 */
(function () {
  var distBox = document.getElementById('calib-dist-box');
  var table = document.getElementById('calib-table');
  if (!table) return;
  var tbody = table.querySelector('tbody');

  // BGCEO view has no single distribution box -- it renders one panel per
  // selected business unit into #calib-panels instead.
  var panelsBox = document.getElementById('calib-panels');
  var panelsMode = !!panelsBox;
  var target = (distBox && distBox.dataset.target) ? JSON.parse(distBox.dataset.target)
    : (panelsBox && panelsBox.dataset.target) ? JSON.parse(panelsBox.dataset.target) : null;
  var scopeEl = document.getElementById('calib-dist-scope');
  var overlayMode = !!(distBox && distBox.classList.contains('dept-mode'));
  // Bands are config-driven so this one file serves both calibration modules:
  // 360 potential is Low/Mid/High, performance is UA/BE/ME/AE/OU. Everything
  // below counts and renders off BANDS rather than three named keys, so neither
  // module can drift from the other's behaviour.
  var CFG = window.CALIB_CONFIG || {};
  var BANDS = CFG.bands || ['Low', 'Mid', 'High'];
  var BAND_NAMES = CFG.bandNames || {};        // acronym -> full label, if any
  var TARGET_LABEL = CFG.targetLabel || '';    // e.g. '15 / 70 / 15'
  function z() { var o = {}; BANDS.forEach(function (b) { o[b] = 0; }); return o; }
  function sum(o) { var t = 0; BANDS.forEach(function (b) { t += (o[b] || 0); }); return t; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  // Tier-relative wording, set per template so this one file serves every
  // roll-up view: BUCEO -> "company"/"HOD's note"/"Company note", BGCEO ->
  // "group"/"Company's note"/"Business Group note".
  var scopeWord = (distBox && distBox.dataset.scope) || 'company';
  var prevNoteLabel = table.dataset.prevNoteLabel || 'Note:';
  var ownNoteLabel = table.dataset.ownNoteLabel || 'Note:';

  function csrfToken() {
    var m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.content : '';
  }

  function updateLabels(row, band, count, pct, total) {
    var pctEl = row.querySelector('.calib-dist-pct');
    if (pctEl) {
      pctEl.innerHTML = count + ' · ' + Math.round(pct) + '% ' +
        '<span class="muted small">(target ' + target[band] + '%)</span>';
    }
    var gapEl = row.querySelector('.calib-dist-gap');
    if (gapEl) {
      gapEl.classList.remove('is-short', 'is-over', 'is-onTarget');
      if (total === 0) { gapEl.textContent = '—'; return; }
      var gap = Math.round(target[band] / 100 * total) - count;
      if (gap > 0) { gapEl.textContent = 'Need +' + gap + ' more'; gapEl.classList.add('is-short'); }
      else if (gap < 0) { gapEl.textContent = (-gap) + ' over target'; gapEl.classList.add('is-over'); }
      else { gapEl.textContent = 'On target'; gapEl.classList.add('is-onTarget'); }
    }
  }

  // Count bands off the rows by a data-attribute (data-band = current call,
  // data-prev-band = the band this tier inherited), over score-valid rows that
  // pass `pred`. Reading straight from the DOM every render is what makes the
  // "growth" delta persist across refreshes and survive filters/sorts.
  function tallyRows(attr, pred) {
    var d = z();
    tbody.querySelectorAll('tr.data-row').forEach(function (tr) {
      if (tr.dataset.scoreValid !== '1') return;
      if (pred && !pred(tr)) return;
      var b = tr.dataset[attr];
      if (b && d[b] !== undefined) d[b] += 1;
    });
    return d;
  }
  function paintDelta(row, band, base, cur, total) {
    var curPct = total ? cur / total * 100 : 0;
    var basePct = total ? base / total * 100 : 0;
    var fill = row.querySelector('.calib-dist-fill');
    var up = row.querySelector('.calib-dist-delta-up');
    var down = row.querySelector('.calib-dist-delta-down');
    if (cur >= base) {
      if (fill) fill.style.width = basePct + '%';
      if (up) { if (curPct > basePct) { up.style.left = basePct + '%'; up.style.width = (curPct - basePct) + '%'; up.style.display = 'block'; } else { up.style.display = 'none'; } }
      if (down) down.style.display = 'none';
    } else {
      if (fill) fill.style.width = curPct + '%';
      if (down) { down.style.left = curPct + '%'; down.style.width = (basePct - curPct) + '%'; down.style.display = 'block'; }
      if (up) up.style.display = 'none';
    }
    return curPct;
  }

  /* ---- Legacy distribution (HOD): total movement from the incoming bands -- */
  function renderLegacy() {
    if (!distBox) return;
    var base = tallyRows('prevBand');   // bands entering this tier (raw self for HOD)
    var cur = tallyRows('band');        // bands after this tier's adjustments
    var total = sum(cur);
    BANDS.forEach(function (band) {
      var row = distBox.querySelector('.calib-dist-row[data-band-row="' + band + '"]');
      if (!row) return;
      var curPct = paintDelta(row, band, base[band], cur[band], total);
      updateLabels(row, band, cur[band], curPct, total);
    });
  }

  /* ---- Overlay distribution (company): in-view growth vs company ghost ---- */
  function visible(tr) { return tr.style.display !== 'none'; }
  // renderOverlay ignores its argument (kept for existing callers): the baseline
  // is the in-view INCOMING distribution (data-prev-band), derived live -- so the
  // growth delta persists across refresh and just recomputes on filter/sort.
  function renderOverlay() {
    var sel = tallyRows('band', visible);       // in-view current call
    var selBase = tallyRows('prevBand', visible); // in-view band coming in from HOD
    var all = tallyRows('band');                 // whole-company current (ghost)
    var selTotal = sum(sel);
    var allTotal = sum(all);
    var isAll = selTotal === allTotal;
    BANDS.forEach(function (band) {
      var row = distBox.querySelector('.calib-dist-row[data-band-row="' + band + '"]');
      if (!row) return;
      var curPct = paintDelta(row, band, selBase[band], sel[band], selTotal);
      var ref = row.querySelector('.calib-dist-ref');
      if (ref) { ref.style.width = (allTotal ? all[band] / allTotal * 100 : 0) + '%'; ref.style.display = isAll ? 'none' : 'block'; }
      updateLabels(row, band, sel[band], curPct, selTotal);
    });
    if (scopeEl) scopeEl.textContent = isAll ? '· ' + scopeWord + '-wide' : '· ' + selTotal + ' in view vs ' + scopeWord;
  }

  /* ---- Panels distribution (BGCEO): one curve per selected business unit -- */
  function selectedBUs() {
    return Array.prototype.slice.call(document.querySelectorAll('#calib-bu-pills .bu-pill[data-bu].is-on'))
      .map(function (p) { return p.dataset.bu; });
  }
  function panelHtml(label, cur, base, reference) {
    var total = sum(cur);
    var bars = BANDS.map(function (band) {
      var bl = band.toLowerCase();
      var n = cur[band], pct = total ? Math.round(n / total * 100) : 0;
      var bn = base[band], basePct = total ? Math.round(bn / total * 100) : 0;
      var tgt = target ? target[band] : 0;
      // The 15/70/15 target applies to any population, including the all-BU
      // roll-up -- it used to be suppressed there as "just a reference", which
      // meant a BG with no business units (every person on a blank company)
      // saw no target guidance at all, on the very page whose job is to hit it.
      var tick = '<span class="calib-dist-tick" style="left:' + tgt + '%"></span>';
      var gap = '';
      if (total) {
        var need = Math.round(tgt / 100 * total) - n;
        gap = need > 0 ? '<span class="calib-dist-gap is-short">Need +' + need + '</span>'
          : need < 0 ? '<span class="calib-dist-gap is-over">' + (-need) + ' over</span>'
          : '<span class="calib-dist-gap is-onTarget">On target</span>';
      }
      // fill = the band coming in from the company tier; a delta segment shows
      // this BG pass's growth/shrink on top of it.
      var fillW, delta = '';
      if (n >= bn) {
        fillW = basePct;
        if (pct > basePct) delta = '<span class="calib-dist-delta-up calib-delta-' + bl + '" style="left:' + basePct + '%;width:' + (pct - basePct) + '%;display:block"></span>';
      } else {
        fillW = pct;
        delta = '<span class="calib-dist-delta-down calib-delta-' + bl + '" style="left:' + pct + '%;width:' + (basePct - pct) + '%;display:block"></span>';
      }
      return '<div class="calib-dist-row"><span class="calib-dist-label">' + band + '</span>'
        + '<div class="calib-dist-bar"><span class="calib-dist-fill calib-dist-' + bl + '" style="width:' + fillW + '%"></span>' + delta + tick + '</div>'
        + '<span class="calib-dist-pct">' + n + ' &middot; ' + pct + '%</span>' + gap + '</div>';
    }).join('');
    return '<div class="calib-panel' + (reference ? ' calib-panel--ref' : '') + '">'
      + '<div class="calib-panel__title">' + esc(label) + ' <span class="muted small">&middot; ' + total + ' scored</span></div>'
      + bars + '</div>';
  }
  function renderPanels() {
    if (!panelsBox) return;
    var bus = selectedBUs();
    
    var cur = {}, base = {}, allCur = z(), allBase = z();
    tbody.querySelectorAll('tr.data-row').forEach(function (tr) {
      if (tr.style.display === 'none' || tr.dataset.scoreValid !== '1') return;
      var co = tr.dataset.company || '', b = tr.dataset.band, p = tr.dataset.prevBand;
      if (BANDS.indexOf(b) >= 0) { (cur[co] = cur[co] || z())[b]++; allCur[b]++; }
      if (BANDS.indexOf(p) >= 0) { (base[co] = base[co] || z())[p]++; allBase[p]++; }
    });
    panelsBox.innerHTML = bus.length
      ? bus.map(function (bu) { return panelHtml(bu, cur[bu] || z(), base[bu] || z(), false); }).join('')
      : panelHtml('All business units', allCur, allBase, true);
    panelsBox.className = 'calib-panels' + (bus.length > 1 ? ' is-multi' : '');
  }

  function recomputeDist(rebaseline) {
    if (overlayMode) renderOverlay(rebaseline);
    else if (panelsMode) renderPanels();
  }

  var buPills = document.getElementById('calib-bu-pills');
  if (buPills) {
    var MAX_BU = 1;               // one BU in focus at a time (else "All")
    var buOrder = [];            // selection order, so a new pick bumps the oldest
    var allPill = buPills.querySelector('.bu-pill[data-all]');
    function pillByBu(bu) {
      return Array.prototype.slice.call(buPills.querySelectorAll('.bu-pill[data-bu]'))
        .filter(function (x) { return x.dataset.bu === bu; })[0];
    }
    buPills.querySelectorAll('.bu-pill').forEach(function (p) {
      p.addEventListener('click', function () {
        if (p.hasAttribute('data-all')) {
          buOrder = [];
          buPills.querySelectorAll('.bu-pill').forEach(function (x) { x.classList.toggle('is-on', x === p); });
        } else {
          var bu = p.dataset.bu;
          if (p.classList.contains('is-on')) {
            p.classList.remove('is-on');
            buOrder = buOrder.filter(function (b) { return b !== bu; });
          } else {
            p.classList.add('is-on');
            buOrder.push(bu);
            while (buOrder.length > MAX_BU) {
              var old = pillByBu(buOrder.shift());
              if (old) old.classList.remove('is-on');
            }
          }
          if (allPill) allPill.classList.toggle('is-on', buOrder.length === 0);
        }
        if (window.colMenuSetClientFilter) window.colMenuSetClientFilter('company', selectedBUs());
        renderPanels();
      });
    });
    // The strip's own left/right arrows live in pillscroller.js, shared with
    // the performance-calibration and Talent Box company rows so all three
    // page identically. This file keeps only the BU *selection* behaviour.
  }

  var renderAll = overlayMode ? function () { renderOverlay(true); }
    : panelsMode ? renderPanels : renderLegacy;

  if ((overlayMode || panelsMode) && tbody) {
    var scheduled = false;
    // Watch ONLY row show/hide (inline style on a <tr>), so a column/BU filter
    // reshapes the curve/panels. Deliberately NOT childList/text: the
    // "Saving…/Saved" status text mutates inside a row and must not re-baseline.
    new MutationObserver(function (muts) {
      var rowToggled = muts.some(function (m) {
        return m.target && m.target.matches && m.target.matches('tr.data-row');
      });
      if (!rowToggled || scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () { scheduled = false; recomputeDist(true); });
    }).observe(tbody, { subtree: true, attributes: true, attributeFilter: ['style'] });
    // Run once at init. recomputeDist() has the correct zero-population guard
    // (it renders an em-dash rather than a gap), but it only ever ran from the
    // observer above, so on first paint the user saw the server's text instead.
    recomputeDist(true);
  }

  /* ---- Lock / Reset confirmation summary --------------------------------- */
  function bandTally() {
    var d = z(), changed = 0;
    tbody.querySelectorAll('tr.data-row').forEach(function (tr) {
      if (tr.dataset.scoreValid !== '1') return;
      var b = tr.dataset.band;
      if (d[b] !== undefined) d[b] += 1;
      var incoming = tr.dataset.prevBand || tr.dataset.hodBand || tr.dataset.originalBand || b;
      if (b && incoming && b !== incoming) changed += 1;
    });
    return { d: d, changed: changed, total: sum(d) };
  }
  function refreshConfirmSummary() {
    var t = bandTally();
    var pct = function (n) { return t.total ? Math.round(n / t.total * 100) : 0; };
    var lockForm = document.querySelector('.calib-lock-form');
    if (lockForm) {
      var base = lockForm.getAttribute('data-confirm-base') || 'Lock this calibration?';
      lockForm.setAttribute('data-confirm', base + '\n\nSUMMARY\n' +
        '• Bands changed from the roll-up: ' + t.changed + ' of ' + t.total + '\n' +
        '• Calibrated distribution' + (TARGET_LABEL ? ' (target ' + TARGET_LABEL + ')' : '') + ':\n' +
        BANDS.map(function (b) {
          return '    ' + (b + '     ').slice(0, 5) + ' ' + t.d[b] + '  (' + pct(t.d[b]) + '%)';
        }).join('\n') + '\n\n' +
        'This becomes the locked value; a super-admin can unlock later.');
    }
    var resetForm = document.querySelector('.calib-reset-form');
    if (resetForm) {
      var rbase = resetForm.getAttribute('data-confirm-base') || 'Reset all adjustments?';
      resetForm.setAttribute('data-confirm', rbase + '\n\nThis clears ' + t.changed +
        ' change' + (t.changed === 1 ? '' : 's') + ' and reverts everyone to the roll-up. This can\'t be undone.');
    }
  }

  /* ---- Combined note popover (HOD's note + Company note) ----------------- */
  // One hover on the "HOD's call" cell shows both tiers' justifications, each
  // labelled. Rebuilt with textContent (never innerHTML) so a note can't inject
  // markup. Creates/removes the icon as notes appear/clear.
  var NOTE_IC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.6" r="0.7" fill="currentColor" stroke="none"/></svg>';
  function noteRow(label, text) {
    var r = document.createElement('span');
    r.className = 'cnt-row';
    var s = document.createElement('strong');
    s.textContent = label + ' ';
    r.appendChild(s);
    r.appendChild(document.createTextNode(text));
    return r;
  }
  function updateComboNote(line, prevNote, ownNote) {
    if (!line) return;
    var note = line.querySelector('.calib-note');
    if (!prevNote && !ownNote) { if (note) note.parentNode.removeChild(note); return; }
    if (!note) {
      note = document.createElement('span');
      note.className = 'calib-note';
      var ic = document.createElement('span');
      ic.className = 'calib-note-ic';
      ic.tabIndex = 0; ic.setAttribute('role', 'button'); ic.setAttribute('aria-label', 'Show notes');
      ic.innerHTML = NOTE_IC_SVG;
      note.appendChild(ic);
      line.appendChild(note);
    }
    var old = note.querySelector('.calib-note-tip');
    if (old) note.removeChild(old);
    var tip = document.createElement('span');
    tip.className = 'calib-note-tip';
    if (prevNote) tip.appendChild(noteRow(prevNoteLabel, prevNote));
    if (ownNote) tip.appendChild(noteRow(ownNoteLabel, ownNote));
    note.appendChild(tip);
  }

  /* ---- Adjust auto-save ------------------------------------------------- */
  // The super admin acting at this tier gives a remark first (the form carries data-confirm-reason only for them; the
  // server refuses their band change without one, 2026-10-18). Cancel puts the band back.
  function saveRow(form, tr) {
    var sel = form.querySelector('[name="adjusted_band"]');
    if (form.getAttribute('data-confirm-reason') && window.askFormReason) {
      var was = tr.dataset.band;
      window.askFormReason(form, 'Change ' + (tr.dataset.name || 'this person') + '\'s band' +
        (sel && sel.value ? ' to ' + sel.value : '') + '? You are acting for this tier as the super admin; your remark ' +
        'goes in the audit trail with the change.', function () { postRow(form, tr); },
        function () { if (sel) sel.value = was; });
      return;
    }
    postRow(form, tr);
  }
  function postRow(form, tr) {
    var select = form.querySelector('[name="adjusted_band"]');
    var status = form.querySelector('.calib-save-status');
    var oldBand = tr.dataset.band, newBand = select.value;
    if (status) { status.textContent = 'Saving…'; status.classList.remove('is-error'); }
    fetch(form.getAttribute('action'), {
      method: 'POST', credentials: 'same-origin', body: new FormData(form),
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) {
          if (status) { status.textContent = data.error || 'Could not save.'; status.classList.add('is-error'); }
          select.value = oldBand; return;
        }
        if (status) {
          status.textContent = 'Saved'; status.classList.remove('is-error');
          setTimeout(function () { if (status.textContent === 'Saved') status.textContent = ''; }, 1500);
        }
        tr.dataset.band = newBand;
        // A successful save always means this row now counts toward the
        // distribution -- either it already had a valid score, or it's now
        // manually overridden. Without this, a first-ever assignment to a
        // "No Data" row wouldn't be reflected until a full page reload.
        tr.dataset.scoreValid = '1';
        // All three tier views share the "Potential band" chain: the own tier's
        // fixed slot is the only live one -- a ringed pill when your call differs
        // from the band coming in (data-prev-band = chain_incoming), else a dash.
        var ownSlot = tr.querySelector('.cchain-own-slot');
        if (ownSlot) {
          // inc can be '' (no incoming band at all -- a from-scratch assignment):
          // that must still show the ringed pill, not the dash, so compare loosely
          // rather than requiring inc to be truthy first.
          var inc = tr.dataset.prevBand;
          ownSlot.innerHTML = (inc !== newBand)
            ? '<span class="potential-pill cchain-ring" data-band="' + newBand + '">' + newBand + '</span>'
            : '<span class="cchain-dash">–</span>';
        }
        // Keep the note popover in sync when this reviewer edits their own note
        // (the chain cell hosts the tier notes in one hover).
        var hodLine = tr.querySelector('.calib-hod-cell .calib-hod-line');
        if (hodLine) {
          var ownNote = (form.querySelector('[name="justification"]') || {}).value || '';
          updateComboNote(hodLine, tr.dataset.prevNote || '', ownNote);
        }
        if (oldBand !== newBand) {
          if (overlayMode) renderOverlay();
          else if (panelsMode) renderPanels();
          else renderLegacy();
        }
        refreshConfirmSummary();
      })
      .catch(function () {
        if (status) { status.textContent = 'Network error — not saved.'; status.classList.add('is-error'); }
        select.value = oldBand;
      });
  }

  /* ---- Note popover: viewport-anchored so the table's scroll container can't
     clip it. CSS keeps .calib-note-tip position:fixed + hidden; this places it
     next to the icon on hover/focus (below if it fits, else above). ---------- */
  function positionNoteTip(ic) {
    var tip = ic.parentNode.querySelector('.calib-note-tip');
    if (!tip) return;
    var r = ic.getBoundingClientRect();
    var w = tip.offsetWidth || 240, h = tip.offsetHeight || 72;
    var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    tip.style.left = Math.max(8, Math.min(r.left, vw - w - 8)) + 'px';
    tip.style.top = ((r.bottom + h + 8 <= vh) ? (r.bottom + 6) : (r.top - h - 6)) + 'px';
  }
  ['mouseover', 'focusin'].forEach(function (evt) {
    document.addEventListener(evt, function (e) {
      var ic = e.target.closest && e.target.closest('.calib-note-ic');
      if (ic) positionNoteTip(ic);
    });
  });

  /* ---- Pop-out justification editor (shared, one floating panel) --------- */
  var editor = null, editorActive = null;
  function buildEditor() {
    editor = document.createElement('div');
    editor.className = 'calib-just-editor'; editor.hidden = true;
    editor.innerHTML =
      '<textarea class="cje-text" rows="4" placeholder="Write the justification for this band…"></textarea>' +
      '<div class="cje-foot"><button type="button" class="cje-clear">Clear</button>' +
      '<button type="button" class="cje-done primary">Done</button></div>';
    document.body.appendChild(editor);
    editor.addEventListener('click', function (e) { e.stopPropagation(); });
    editor.querySelector('.cje-done').addEventListener('click', function () { commitEditor(); closeEditor(); });
    editor.querySelector('.cje-clear').addEventListener('click', function () {
      var ta = editor.querySelector('.cje-text'); ta.value = ''; ta.focus();
    });
  }
  function setJustBtn(btn, val) {
    btn.classList.toggle('has-note', !!val);
    var l = btn.querySelector('.cjb-label'); if (l) l.textContent = val ? 'Note' : 'Add note';
    btn.setAttribute('title', val || '');
  }
  function positionEditor(btn) {
    var rc = btn.getBoundingClientRect();
    editor.hidden = false;
    var w = editor.offsetWidth, h = editor.offsetHeight;
    var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    editor.style.left = Math.max(8, Math.min(window.scrollX + rc.left, window.scrollX + vw - w - 8)) + 'px';
    var below = vh - rc.bottom - 12;
    editor.style.top = ((h <= below || below >= rc.top - 12)
      ? (window.scrollY + rc.bottom + 4)
      : (window.scrollY + rc.top - h - 4)) + 'px';
  }
  function openEditor(btn, form, tr) {
    if (!editor) buildEditor();
    var hidden = form.querySelector('[name="justification"]');
    editorActive = { form: form, tr: tr, hidden: hidden, btn: btn };
    editor.querySelector('.cje-text').value = hidden ? (hidden.value || '') : '';
    positionEditor(btn);
    editor.querySelector('.cje-text').focus();
  }
  function commitEditor() {
    if (!editorActive) return;
    var val = editor.querySelector('.cje-text').value.trim();
    var cur = editorActive.hidden ? (editorActive.hidden.value || '') : '';
    if (val !== cur) {
      if (editorActive.hidden) editorActive.hidden.value = val;
      setJustBtn(editorActive.btn, val);
      saveRow(editorActive.form, editorActive.tr);
    }
  }
  function closeEditor() { if (editor) editor.hidden = true; editorActive = null; }
  document.addEventListener('click', function () { if (editor && !editor.hidden) { commitEditor(); closeEditor(); } });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && editor && !editor.hidden) closeEditor(); });

  /* ---- Wire each row's form --------------------------------------------- */
  table.querySelectorAll('.calib-adjust-form').forEach(function (form) {
    var tr = form.closest('tr');
    if (!tr || form.hasAttribute('data-no-autosave')) return;   // the super override saves by its own button
    var select = form.querySelector('[name="adjusted_band"]');
    if (select) select.addEventListener('change', function () { saveRow(form, tr); });

    var justBtn = form.querySelector('.calib-just-btn');
    if (justBtn) {
      var hid = form.querySelector('[name="justification"]');
      setJustBtn(justBtn, hid ? hid.value : '');
      justBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (editor && !editor.hidden) { commitEditor(); closeEditor(); }
        openEditor(justBtn, form, tr);
      });
    } else {
      var justInput = form.querySelector('input[name="justification"]:not([type="hidden"])');
      if (justInput) {
        var last = justInput.value;
        justInput.addEventListener('blur', function () {
          if (justInput.value !== last) { last = justInput.value; saveRow(form, tr); }
        });
        justInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); justInput.blur(); }
        });
      }
    }
  });

  renderAll();
  // The lock/reset forms are parsed AFTER this script tag, so on first load
  // they aren't in the DOM yet -- defer the initial summary write until the
  // rest of the page has parsed, or it silently no-ops until the first adjust.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refreshConfirmSummary);
  } else {
    refreshConfirmSummary();
  }
})();
