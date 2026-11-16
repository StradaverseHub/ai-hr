// The layout sweep (Chris, 2026-10-20: "run proper check to ensure all pages are alright and box are adequately
// separated with clear gap"). Crawls every page each persona reaches by GET links on a LOCAL QC copy (never a server),
// at 1280x800, and measures every card-like box (a block with a radius and a border, shadow or background, at least
// 150x40, not in a fixed / absolute / sticky layer or a folded <details>): two boxes overlapping, a box closer than 8px to
// the one below it, side-by-side boxes of one row whose tops don't line up, sideways scroll, and the stacked-card
// wrapper rule landing on a positioned layer. Writes <out>/report.json and a full-page screenshot of each page with a
// finding. The pages are the QC copy's, so they show its database: keep the output out of git.
//
// And the text on every page (Chris, 2026-10-26: "always check for the UI on the text separation, allow enough space for
// clean and simplistic look"; "add the text-separation check to the layout sweep and run it across every page and
// persona"): where text is drawn, not its boxes. A pill, chip or button counts by its outline, plain text by its
// glyphs, clipped to what its scroll / overflow boxes let show; words of one sentence are never compared. Kinds:
//   text-overlap    two pieces of text on one line drawn over each other
//   text-tight      side by side on one line, under 8px apart (MIN_GAP), or under 6px from a chip's outline
//   text-overlap-v  two lines drawn into each other (more than 2px)
//   heading-wraps   a table's column heading on more than one line
//   text-cut        text cut off with no "…"
//   text-cut-no-hover  a "…" with no full words on hover (no title / aria-label on it or the two boxes above)
//   word-split      one word (a run of letters / digits, 3 or more characters) drawn on two or more lines with no hyphen or
//                   soft hyphen at the break ("Performanc" / "e" in a narrow menu): a box too narrow for its longest word.
//                   Counts as S2. Text in a hidden or folded element, <textarea>, <input> or <select> is skipped; a long
//                   URL in an overflow-wrap:anywhere cell is reported on purpose, so it is seen. Reports the word and the
//                   width of its box.
// Writes <out>/text-summary.json too: each pattern once, with its pages, for triage. TEXT=0 skips the text check.
//
// usage: node tools/layout_sweep.js <base url> <out dir> '<personas JSON>'
//   personas: [{"name": "super", "uid": <user id>, "start": ["/admin"], "only": ["/admin"], "max": 450}, ...]
//   ("only" / "never": path prefixes to follow or skip; "max": pages per persona). The base URL must serve the
//   harness's scratch login (/__scratch_login/<uid>), as the QC copies in /private/tmp/onehr-tests do.
// env: PLAYWRIGHT_DIR (a node_modules/playwright folder), CHROME_PATH (a Chromium binary it can drive), VIEWPORT
// (WIDTHxHEIGHT, default 1280x800).
//   THEME     light (default) | dark: sets <html data-theme> on every page the sweep loads. ("auto" is not offered: it
//             follows the computer, so a run would not repeat.)
//   TEXTSIZE  s | m (default, Standard) | l | xl (the largest): sets <html data-text>, which scales the root font size
//             (87.5%, 100%, 112.5%, 125%).
//   Both are forced in the browser only (an init script, set again after load): nothing is written to the database or to
//   the account's saved choice. With neither set the page is left exactly as the account renders it. A run with a
//   non-default value puts "-<theme>-<size>" in its screenshot names, and report.json records theme and textsize.
// QC standard for a UI change: 1280x800 in light and dark, at Standard and the largest text size.
const { chromium } = require(process.env.PLAYWRIGHT_DIR || '/path/to/tool');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2];
const OUT = process.argv[3];
const PERSONAS = JSON.parse(process.argv[4]);
const MIN_GAP = 8;
// VIEWPORT=1024x768 sweeps another desktop width (default 1280x800, the QC standard)
const [VW, VH] = (process.env.VIEWPORT || '1280x800').split('x').map(Number);
const THEME = process.env.THEME || 'light';
const TEXTSIZE = process.env.TEXTSIZE || 'm';
const THEMES_OK = ['light', 'dark'], SIZES_OK = ['s', 'm', 'l', 'xl'];
if (!THEMES_OK.includes(THEME)) { console.error('layout_sweep: THEME "' + THEME + '" is not one of ' + THEMES_OK.join(' | ')); process.exit(2); }
if (!SIZES_OK.includes(TEXTSIZE)) { console.error('layout_sweep: TEXTSIZE "' + TEXTSIZE + '" is not one of ' + SIZES_OK.join(' | ')); process.exit(2); }
// forced only when asked for; with neither set the page renders as the account has it (results as before)
const FORCE = { theme: process.env.THEME ? THEME : null, text: process.env.TEXTSIZE ? TEXTSIZE : null };
const SUFFIX = (THEME !== 'light' || TEXTSIZE !== 'm') ? '-' + THEME + '-' + TEXTSIZE : '';
const applyDisplay = (f) => {
  const r = document.documentElement;
  if (!r) return;
  if (f.theme) r.setAttribute('data-theme', f.theme);
  if (f.text) r.setAttribute('data-text', f.text);
};
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE || '')) {
  console.error('layout_sweep: a local QC copy only (http://localhost:<port>), never a server');
  process.exit(2);
}

const SKIP = /\/(logout|__scratch_login|demo\/|export|download|static\/|api\/|uploads?\/)|\.(xlsx|csv|pdf|png|svg|json)(\?|$)|\/fragment|[?&]fragment=1|[?&](format|download)=/i;
const DROP_KEYS = new Set(['bg', 'fbg', 'fbu', 'fdept', 'fcompany', 'unit', 'q', 'qin', 'sort', 'dir', 'page', 'pp',
  'show', 'role', 'dept_f', 'rows', 'cycle', 'next', 'company', 'dept', 'fjg', 'fstatus', 'femail', 'year', 'bu', 'sel']);

function key(u) {
  const x = new URL(u);
  const p = x.pathname.replace(/\/\d+(?=\/|$)/g, '/N');
  const ks = [...x.searchParams.keys()].filter(k => !DROP_KEYS.has(k)).sort().map(k => k + '=' + x.searchParams.get(k));
  return p + (ks.length ? '?' + ks.join('&') : '');
}

const AUDIT = () => {
  const SEL = 'div,section,aside,article,form,header,footer,nav,details,fieldset,main';
  const inLayer = (el) => {
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.position === 'fixed' || cs.position === 'absolute' || cs.position === 'sticky') return true;
      if (a.hidden || cs.display === 'none') return true;
    }
    return false;
  };
  const desc = (el) => {
    const c = [...el.classList].slice(0, 3).join('.');
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (c ? '.' + c : '');
  };
  // what a box's scroll / overflow boxes let show: a message scrolled out of a chat log is hidden, not under the tabs
  const clipOf = (el) => {
    let k = { l: -1e9, r: 1e9, t: -1e9, b: 1e9 };
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const c = getComputedStyle(a);
      if (c.overflowX !== 'visible' || c.overflowY !== 'visible') {
        const r = a.getBoundingClientRect();
        k = { l: Math.max(k.l, r.left), r: Math.min(k.r, r.right), t: Math.max(k.t, r.top), b: Math.min(k.b, r.bottom) };
      }
    }
    return k;
  };
  const boxes = [];
  for (const el of document.querySelectorAll(SEL)) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.display.startsWith('inline') || cs.display === 'contents') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 150 || r.height < 40) continue;
    const radius = parseFloat(cs.borderTopLeftRadius) || 0;
    if (radius < 4) continue;
    const border = ['Top', 'Right', 'Bottom', 'Left'].some(s => parseFloat(cs['border' + s + 'Width']) > 0
      && cs['border' + s + 'Style'] !== 'none' && cs['border' + s + 'Color'] !== 'rgba(0, 0, 0, 0)');
    const shadow = cs.boxShadow && cs.boxShadow !== 'none';
    const bg = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
    if (!(border || shadow || bg)) continue;
    if (inLayer(el)) continue;
    const shut = el.parentElement && el.parentElement.closest('details:not([open])');
    if (shut && !el.closest('summary')) continue;   // folded away: not on screen
    const k = clipOf(el);
    const v = { t: Math.max(r.top, k.t), b: Math.min(r.bottom, k.b), l: Math.max(r.left, k.l), rt: Math.min(r.right, k.r) };
    if (v.b - v.t < 4 || v.rt - v.l < 4) continue;   // scrolled out of its box: not on screen
    boxes.push({ el, r: { t: v.t + scrollY, b: v.b + scrollY, l: v.l, rt: v.rt }, d: desc(el) });
  }
  const out = [];
  const contains = (a, b) => a.el.contains(b.el) || b.el.contains(a.el);
  for (let i = 0; i < boxes.length; i++) {
    const A = boxes[i];
    let below = null, bestGap = Infinity;
    for (let j = 0; j < boxes.length; j++) {
      if (i === j) continue;
      const B = boxes[j];
      if (contains(A, B)) continue;
      const xo = Math.min(A.r.rt, B.r.rt) - Math.max(A.r.l, B.r.l);
      const yo = Math.min(A.r.b, B.r.b) - Math.max(A.r.t, B.r.t);
      if (j > i && xo > 2 && yo > 2) out.push({ kind: 'overlap', a: A.d, b: B.d, px: Math.round(Math.min(xo, yo)) });
      // the nearest box straight below A
      if (xo > 20 && B.r.t >= A.r.b - 2) {
        const g = B.r.t - A.r.b;
        if (g < bestGap) { bestGap = g; below = B; }
      }
      // side by side in one row of the same parent: tops should line up
      if (j > i && A.el.parentElement === B.el.parentElement && yo > 0 && xo < 0) {
        const pcs = getComputedStyle(A.el.parentElement);
        const al = pcs.alignItems;
        const flowRow = (pcs.display.includes('flex') && pcs.flexDirection.startsWith('row')) || pcs.display.includes('grid');
        if (flowRow && !/center|end|baseline/.test(al) && Math.abs(A.r.t - B.r.t) > 2) {
          out.push({ kind: 'misaligned', a: A.d, b: B.d, px: Math.round(Math.abs(A.r.t - B.r.t)) });
        }
      }
    }
    if (below && bestGap < 8) out.push({ kind: 'tight', a: A.d, b: below.d, px: Math.round(bestGap) });
  }
  // the wrapper gap rule must never move a positioned layer
  for (const w of document.querySelectorAll('.adm-main > .admin-card + *')) {
    const cs = getComputedStyle(w);
    if ((cs.position === 'fixed' || cs.position === 'absolute') && parseFloat(cs.marginTop) !== 0)
      out.push({ kind: 'gap-rule-on-layer', a: desc(w), b: cs.position, px: parseFloat(cs.marginTop) });
  }
  const sideways = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
  if (sideways) out.push({ kind: 'sideways', a: 'document', b: '', px: document.documentElement.scrollWidth - document.documentElement.clientWidth });
  return { n: boxes.length, issues: out, title: document.title };
};

const TEXT_AUDIT = (MIN) => {
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'OPTION', 'SELECT', 'NOSCRIPT', 'TEMPLATE', 'svg', 'SVG', 'TITLE']);
  const csOf = new Map();
  const cs = (el) => { let c = csOf.get(el); if (!c) { c = getComputedStyle(el); csOf.set(el, c); } return c; };
  const visMemo = new Map();
  const visible = (el) => {
    if (!el || el === document.documentElement || el === document.body) return true;
    if (visMemo.has(el)) return visMemo.get(el);
    const c = cs(el);
    let v = !(el.hidden || c.display === 'none' || c.visibility === 'hidden' || c.opacity === '0'
      || (el.getAttribute && el.getAttribute('aria-hidden') === 'true'));
    // the content of a folded <details> (its summary stays)
    if (v && el.parentElement && el.parentElement.tagName === 'DETAILS' && !el.parentElement.open && el.tagName !== 'SUMMARY') v = false;
    if (v) v = visible(el.parentElement);
    visMemo.set(el, v);
    return v;
  };
  const paints = (c) => (c.backgroundColor && c.backgroundColor !== 'rgba(0, 0, 0, 0)' && c.backgroundColor !== 'transparent')
    || ['Top', 'Right', 'Bottom', 'Left'].some(sd => parseFloat(c['border' + sd + 'Width']) > 0 && c['border' + sd + 'Style'] !== 'none'
      && c['border' + sd + 'Color'] !== 'rgba(0, 0, 0, 0)');
  // the box a piece of text belongs to: the nearest block-level box, or a painted inline box (a pill, a chip, a button)
  const ownerMemo = new Map();
  const owner = (el) => {
    if (ownerMemo.has(el)) return ownerMemo.get(el);
    let o = null;
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const c = cs(a), d = c.display;
      const inline = d === 'inline' || d === 'contents';
      const inlineBox = d.startsWith('inline-');
      if (!inline && !inlineBox) {
        // a chip in a row of chips is a flex item, so block-level: a small painted box with round corners (or a button)
        // is still a chip, never a table cell or a card
        const r = a.getBoundingClientRect();
        const chip = paints(c) && !/^table/.test(d) && r.height <= 44 && r.width <= 420
          && (parseFloat(c.borderTopLeftRadius) >= 4 || a.tagName === 'BUTTON');
        o = { el: a, decorated: chip }; break;
      }
      if ((inlineBox || inline) && paints(c) && !/^(A|CODE|MARK|KBD|B|STRONG|EM|I|S|U)$/.test(a.tagName)) { o = { el: a, decorated: true }; break; }
      if (a.tagName === 'BUTTON' || (a.tagName === 'A' && inlineBox && paints(c))) { o = { el: a, decorated: true }; break; }
    }
    ownerMemo.set(el, o);
    return o;
  };
  // the part of the page an element can show through: its overflow boxes, intersected
  const clipMemo = new Map();
  const clipOf = (el) => {
    if (!el || el === document.documentElement) return { l: -1e9, r: 1e9, t: -1e9, b: 1e9 };
    if (clipMemo.has(el)) return clipMemo.get(el);
    const up = clipOf(el.parentElement);
    const c = cs(el);
    let k = up;
    if ((c.overflowX !== 'visible' || c.overflowY !== 'visible') && el !== document.body) {
      const r = el.getBoundingClientRect();
      k = { l: Math.max(up.l, r.left), r: Math.min(up.r, r.right), t: Math.max(up.t, r.top), b: Math.min(up.b, r.bottom) };
    }
    clipMemo.set(el, k);
    return k;
  };
  const layerMemo = new Map();
  const layer = (el) => {   // the fixed / sticky / absolute layer it sits in, or the page
    if (!el || el === document.body || el === document.documentElement) return document.body;
    if (layerMemo.has(el)) return layerMemo.get(el);
    const p = cs(el).position;
    const l = (p === 'fixed' || p === 'sticky' || p === 'absolute') ? el : layer(el.parentElement);
    layerMemo.set(el, l);
    return l;
  };
  const desc1 = (el) => {
    const c = [...el.classList].slice(0, 2).join('.'), role = el.getAttribute('role');
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (c ? '.' + c : '') + (role ? '[' + role + ']' : '');
  };
  // a box with no class or id is named by its parent too ("div.od-bu-r > span[columnheader]")
  const desc = (el) => (el.classList.length || el.id || !el.parentElement) ? desc1(el) : desc1(el.parentElement) + ' > ' + desc1(el);
  const sample = (t) => t.replace(/\s+/g, ' ').trim().slice(0, 28);
  const spans = [];
  const splits = [];
  const splitSeen = new Set();
  // a word is a run of letters / digits; a hyphen, soft hyphen, zero-width space or slash ends it, so a break there is
  // not a broken word. Only a text node drawn on 2 or more lines is looked at word by word.
  const WORD = /[\p{L}\p{N}\p{M}]{3,}/gu;
  const lineCount = (rects) => {
    const lines = [];
    for (const r of [...rects].sort((x, y) => x.top - y.top)) {
      if (r.width < 0.5 || r.height < 1) continue;
      const L = lines.find(l => Math.min(l.b, r.bottom) - Math.max(l.t, r.top) >= 0.5 * Math.min(l.b - l.t, r.height));
      if (L) { L.t = Math.min(L.t, r.top); L.b = Math.max(L.b, r.bottom); } else lines.push({ t: r.top, b: r.bottom });
    }
    return lines.length;
  };
  const wordSplits = (n, el) => {
    if (cs(el).hyphens === 'auto') return;   // the browser puts the hyphen in itself
    const whole = document.createRange(); whole.selectNodeContents(n);
    if (lineCount(whole.getClientRects()) < 2) return;
    const t = n.nodeValue;
    let m;
    WORD.lastIndex = 0;
    while ((m = WORD.exec(t))) {
      const rg = document.createRange(); rg.setStart(n, m.index); rg.setEnd(n, m.index + m[0].length);
      let rs = [...rg.getClientRects()];
      // after a soft hyphen the browser draws the hyphen at the end of the line above, and that mark counts as the
      // start of this range: it is the break, not a split
      if (t[m.index - 1] === '\u00AD' && rs.length > 1) rs = rs.sort((x, y) => x.top - y.top).slice(1);
      if (lineCount(rs) < 2) continue;
      const blk = (owner(el) || { el }).el;
      const key = desc(blk) + '|' + m[0];
      if (splitSeen.has(key)) continue; splitSeen.add(key);
      splits.push({ kind: 'word-split', a: desc(blk) + ' "' + m[0].slice(0, 28) + '"', b: '', px: Math.round(blk.getBoundingClientRect().width) });
    }
  };
  const decoDone = new Set();
  const textOf = new Map();
  const W = innerWidth;
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = tw.nextNode())) {
    const t = n.nodeValue;
    if (!t || !t.trim()) continue;
    const el = n.parentElement;
    if (!el || SKIP_TAGS.has(el.tagName) || el.closest('svg, select, textarea, script, style')) continue;
    if (!visible(el)) continue;
    const o = owner(el);
    if (!o) continue;
    textOf.set(o.el, (textOf.get(o.el) || '') + t);
    wordSplits(n, el);
    const k = clipOf(el), ly = layer(el);
    if (o.decorated) {
      if (decoDone.has(o.el)) continue;
      decoDone.add(o.el);
      const r = o.el.getBoundingClientRect();
      const s_ = { l: Math.max(r.left, k.l), r: Math.min(r.right, k.r), t: Math.max(r.top, k.t), b: Math.min(r.bottom, k.b) };
      if (s_.r - s_.l > 2 && s_.b - s_.t > 2 && s_.r > 0 && s_.l < W) spans.push(Object.assign(s_, { o: o.el, ly, node: n, deco: true }));
      continue;
    }
    // the words only: a space before or after them is part of the gap, not the text
    const a0 = t.search(/\S/), a1 = t.length - t.split('').reverse().join('').search(/\S/);
    const rg = document.createRange(); rg.setStart(n, a0); rg.setEnd(n, a1);
    for (const r of rg.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      const s_ = { l: Math.max(r.left, k.l), r: Math.min(r.right, k.r), t: Math.max(r.top, k.t), b: Math.min(r.bottom, k.b) };
      if (s_.r - s_.l > 2 && s_.b - s_.t > 2 && s_.r > 0 && s_.l < W) spans.push(Object.assign(s_, { o: o.el, ly, node: n }));
    }
  }
  const out = [];
  const label = (sp) => desc(sp.o) + ' "' + sample(textOf.get(sp.o) || sp.node.nodeValue) + '"';
  const contains = (a, b) => a !== b && (a.contains(b) || b.contains(a));
  spans.sort((a, b) => a.t - b.t);
  const seen = new Set();
  for (let i = 0; i < spans.length; i++) {
    const A = spans[i];
    for (let j = i + 1; j < spans.length && spans[j].t < A.b; j++) {
      const B = spans[j];
      if (A.o === B.o || A.ly !== B.ly) continue;
      const v = Math.min(A.b, B.b) - Math.max(A.t, B.t);
      const minH = Math.min(A.b - A.t, B.b - B.t);
      const [L, R] = A.l <= B.l ? [A, B] : [B, A];
      const gap = R.l - L.r;
      // text inside a painted box (a pill, a chip, a button) is part of it, never its neighbour
      const inside = (outer, inner) => outer.deco && outer.o.contains(inner.o) && inner.l >= outer.l - 1 && inner.r <= outer.r + 1;
      if (inside(A, B) || inside(B, A)) continue;
      if (v >= 0.5 * minH) {
        // next to an outline (a chip, a pill, a button) 6px will do: the outline marks the edge and its padding keeps its
        // own words further off. Two outlines touching side by side are one joined control (Grid | List), on purpose.
        const need = (L.deco || R.deco) ? Math.min(MIN, 6) : MIN;
        if (L.deco && R.deco && Math.abs(gap) <= 1 && L.o.parentElement === R.o.parentElement) continue;
        if (gap < need) {
          const key = (gap < -1 ? 'o' : 't') + desc(L.o) + '|' + desc(R.o);
          if (seen.has(key)) continue; seen.add(key);
          out.push({ kind: gap < -1 ? 'text-overlap' : 'text-tight', a: label(L), b: label(R), px: Math.round(gap) });
        }
      } else if (v > Math.max(2, 0.15 * Math.max(A.b - A.t, B.b - B.t)) && Math.min(A.r, B.r) - Math.max(A.l, B.l) > 2
                 && !contains(A.o, B.o)) {   // a large figure's box holds empty room above its digits: only more than that
        const key = 'v' + desc(A.o) + '|' + desc(B.o);
        if (seen.has(key)) continue; seen.add(key);
        out.push({ kind: 'text-overlap-v', a: label(A), b: label(B), px: Math.round(v) });
      }
    }
  }
  // a table's COLUMN headings on one line (a row's own heading, a long unit name, may wrap). Lines are told apart by
  // overlap, not by their tops: a sort arrow in a smaller type sits a few pixels off the word it follows.
  const colHeads = new Set(document.querySelectorAll('thead th, th[scope=col], [role=columnheader]'));
  for (const t of document.querySelectorAll('table')) {
    if (t.tHead) continue;
    const r1 = t.rows && t.rows[0];
    if (r1 && [...r1.cells].every(c => c.tagName === 'TH')) [...r1.cells].forEach(c => colHeads.add(c));
  }
  const absInside = (el, top) => { for (let a = el; a && a !== top; a = a.parentElement) { const p = cs(a).position; if (p === 'absolute' || p === 'fixed') return true; } return false; };
  for (const h of colHeads) {
    if (!visible(h) || !h.textContent.trim()) continue;
    const rects = [];
    const w2 = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
    let tn;
    while ((tn = w2.nextNode())) {
      if (!tn.nodeValue.trim() || !visible(tn.parentElement) || absInside(tn.parentElement, h)) continue;
      const rg = document.createRange(); rg.selectNodeContents(tn);
      for (const r of rg.getClientRects()) if (r.width > 1 && r.height > 1) rects.push({ t: r.top, b: r.bottom });
    }
    const lines = [];
    for (const r of rects.sort((x, y) => x.t - y.t)) {
      const L = lines.find(l => Math.min(l.b, r.b) - Math.max(l.t, r.t) >= 0.5 * Math.min(l.b - l.t, r.b - r.t));
      if (L) { L.t = Math.min(L.t, r.t); L.b = Math.max(L.b, r.b); } else lines.push({ t: r.t, b: r.b });
    }
    if (lines.length > 1) out.push({ kind: 'heading-wraps', a: desc(h) + ' "' + sample(h.textContent) + '"', b: '', px: lines.length });
  }
  // text cut off: with no "…", or a "…" nobody can read in full
  for (const el of textOf.keys()) {
    const c = cs(el);
    if (!(c.overflowX === 'hidden' || c.overflowX === 'clip')) continue;
    if (el.scrollWidth <= el.clientWidth + 1 || el.clientWidth < 4) continue;
    const hover = [el, el.parentElement, el.parentElement && el.parentElement.parentElement]
      .some(a => a && (a.title || (a.getAttribute && a.getAttribute('aria-label'))));
    if (c.textOverflow !== 'ellipsis') out.push({ kind: 'text-cut', a: desc(el) + ' "' + sample(textOf.get(el)) + '"', b: '', px: el.scrollWidth - el.clientWidth });
    else if (!hover) out.push({ kind: 'text-cut-no-hover', a: desc(el) + ' "' + sample(textOf.get(el)) + '"', b: '', px: el.scrollWidth - el.clientWidth });
  }
  out.push(...splits);
  return { spans: spans.length, issues: out.slice(0, 60), more: Math.max(0, out.length - 60) };
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const report = [];
  for (const p of PERSONAS) {
    const ctx = await browser.newContext({ viewport: { width: VW, height: VH } });
    if (FORCE.theme || FORCE.text) {
      // before the page's own scripts, and again whenever the root appears (a navigation starts with no root)
      await ctx.addInitScript(({ f, src }) => {
        const fn = eval('(' + src + ')');
        fn(f);
        if (!document.documentElement) new MutationObserver((_, o) => { if (document.documentElement) { fn(f); o.disconnect(); } }).observe(document, { childList: true });
      }, { f: FORCE, src: applyDisplay.toString() });
    }
    const page = await ctx.newPage();
    page.on('dialog', d => d.dismiss().catch(() => {}));
    await page.goto(BASE + '/__scratch_login/' + p.uid, { waitUntil: 'load' });
    const seen = new Set();
    const queue = p.start.map(s => BASE + s);
    let visited = 0;
    while (queue.length && visited < p.max) {
      const u = queue.shift();
      const k = key(u);
      if (seen.has(k)) continue;
      seen.add(k);
      let status = 0;
      try {
        const resp = await page.goto(u, { waitUntil: 'load', timeout: 30000 });
        status = resp ? resp.status() : 0;
        await page.waitForTimeout(350);
      } catch (e) { report.push({ persona: p.name, url: u, error: String(e).slice(0, 160) }); continue; }
      const finalUrl = page.url();
      if (!finalUrl.startsWith(BASE) || status >= 400) { report.push({ persona: p.name, url: u, status }); continue; }
      const ct = await page.evaluate(() => document.contentType);
      if (ct !== 'text/html') continue;
      visited++;
      if (FORCE.theme || FORCE.text) await page.evaluate(applyDisplay, FORCE);
      // finish animations so the layout is settled
      await page.evaluate(() => document.getAnimations().forEach(a => { try { a.finish(); } catch (e) {} }));
      const res = await page.evaluate(AUDIT);
      const txt = process.env.TEXT === '0' ? { spans: 0, issues: [], more: 0 } : await page.evaluate(TEXT_AUDIT, MIN_GAP);
      const eff = await page.evaluate(() => ({ theme: document.documentElement.getAttribute('data-theme'),
        text: document.documentElement.getAttribute('data-text'), rootPx: parseFloat(getComputedStyle(document.documentElement).fontSize) }));
      const row = { persona: p.name, theme: eff.theme, textsize: eff.text, root_px: eff.rootPx, url: u.replace(BASE, ''), final: finalUrl.replace(BASE, ''), status, boxes: res.n, issues: res.issues,
        text: txt.issues, text_more: txt.more };
      if (res.issues.length || txt.issues.length) {
        const shot = path.join(OUT, p.name + '-' + visited + SUFFIX + '.png');
        await page.screenshot({ path: shot, fullPage: true });
        row.shot = shot;
      }
      report.push(row);
      const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.href));
      for (const l of links) {
        if (!l.startsWith(BASE)) continue;
        const x = new URL(l); x.hash = '';
        const s = x.toString();
        if (SKIP.test(s)) continue;
        if (p.only && !p.only.some(pre => x.pathname.startsWith(pre))) continue;
        if (p.never && p.never.some(pre => x.pathname.startsWith(pre))) continue;
        if (!seen.has(key(s))) queue.push(s);
      }
    }
    report.push({ persona: p.name, visited, queued_left: queue.length });
    await ctx.close();
  }
  await browser.close();
  report.unshift({ settings: { theme: THEME, textsize: TEXTSIZE, forced: FORCE, viewport: VW + 'x' + VH } });
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  console.log('theme', THEME, 'textsize', TEXTSIZE, FORCE.theme || FORCE.text ? '(forced)' : '(as the account has it)', 'viewport', VW + 'x' + VH);
  const pages = report.filter(r => r.issues);
  const bad = pages.filter(r => r.issues.length);
  console.log('pages', pages.length, 'with issues', bad.length);
  // the text findings, each pattern once (its kind and the two boxes' kinds), with how many pages and personas show it
  const pat = new Map();
  for (const r of pages) for (const t of (r.text || [])) {
    const k = t.kind + ' ' + t.a.replace(/ ".*$/, '') + ' | ' + t.b.replace(/ ".*$/, '');
    const e = pat.get(k) || { kind: t.kind, pattern: k, pages: 0, personas: new Set(), px: [], example: null };
    e.pages++; e.personas.add(r.persona); e.px.push(t.px);
    if (!e.example) e.example = { url: r.url, persona: r.persona, a: t.a, b: t.b, px: t.px };
    pat.set(k, e);
  }
  const summary = [...pat.values()].map(e => Object.assign(e, { personas: [...e.personas], px: [Math.min(...e.px), Math.max(...e.px)] }))
    .sort((a, b) => b.pages - a.pages);
  fs.writeFileSync(path.join(OUT, 'text-summary.json'), JSON.stringify(summary, null, 1));
  const byKind = {};
  for (const e of summary) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  console.log('text: pages with a finding', pages.filter(r => (r.text || []).length).length, '· patterns', summary.length, JSON.stringify(byKind));
  for (const p of PERSONAS) {
    const s = report.find(r => r.persona === p.name && r.visited !== undefined);
    console.log(p.name, 'visited', s && s.visited, 'left in queue', s && s.queued_left);
  }
})();
