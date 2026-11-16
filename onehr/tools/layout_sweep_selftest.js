// usage: node tools/layout_sweep_selftest.js tools/layout_sweep.js   (env CHROME_PATH, PLAYWRIGHT_DIR as the sweep)
// Proves each kind of the layout sweep's text check on a fixture page: every case fires or stays quiet as it should.
const { chromium } = require(process.env.PLAYWRIGHT_DIR || '/path/to/tool');
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf-8');
const m = src.match(/const TEXT_AUDIT = ([\s\S]*?\n};)\n/);
if (!m) { console.log('TEXT_AUDIT not found'); process.exit(2); }
const fnSrc = m[1].replace(/;$/, '');
const CASES = [
  ['tight', '<div style="display:flex;gap:4px"><span>Alpha</span><span>Beta</span></div>', 'text-tight'],
  ['spaced', '<div style="display:flex;gap:14px"><span>Alpha</span><span>Beta</span></div>', null],
  ['sentence', '<p>You have <b>3</b> items <a href="#">here</a> today</p>', null],
  ['pill', '<p>Gross Profit <span style="display:inline-block;background:#eee;border-radius:9px;padding:0 6px;margin-left:10px">Unit</span></p>', null],
  ['pill-tight', '<p>Gross Profit<span style="display:inline-block;background:#eee;border-radius:9px;padding:0 6px;margin-left:2px">Unit</span></p>', 'text-tight'],
  ['overlap', '<div style="display:grid;grid-template-columns:40px 80px"><span style="white-space:nowrap">Business unit long</span><span>Reviews</span></div>', 'text-overlap'],
  ['th-wrap', '<table style="width:120px;border-collapse:collapse"><tr><th>You entered value</th><th>X</th></tr><tr><td>1</td><td>2</td></tr></table>', 'heading-wraps'],
  ['th-arrow', '<table style="border-spacing:16px 0"><thead><tr><th>Person<span style="font-size:9px;vertical-align:top">&#9662;</span></th><th>Status</th></tr></thead></table>', null],
  ['row-head', '<table style="width:160px"><tbody><tr><td>x</td></tr><tr><th>A very long unit name that wraps</th><td>1</td></tr></tbody></table>', null],
  ['pill-space', '<p><span style="display:inline-block;background:#eee;border-radius:9px;padding:0 6px">Every rating in</span> 287</p>', 'text-tight'],
  ['pill-inner', '<p><span style="display:inline-block;background:#eee;border-radius:9px;padding:0 6px">Low<span style="display:inline-block"> potential</span></span></p>', null],
  ['big-figure', '<div style="font-size:11px">360 SCORE</div><div style="font-size:35px;line-height:1;margin-top:-3px">—</div>', null],
  ['chip-row', '<div style="display:flex;gap:10px"><a style="display:inline-flex;gap:6px;border:1px solid #ccc;border-radius:99px;padding:4px 12px">Atlas<span>91</span></a><a style="display:inline-flex;gap:6px;border:1px solid #ccc;border-radius:99px;padding:4px 12px">Beacon<span>12</span></a></div>', null],
  ['chip-row-tight', '<div style="display:flex;gap:3px"><span style="background:#eee;border-radius:99px;padding:2px 8px">LM</span><span style="background:#eee;border-radius:99px;padding:2px 8px">HOD</span></div>', 'text-tight'],
  ['th-bg', '<table style="border-collapse:collapse"><thead><tr><th style="background:#f4f5f9;padding:4px 10px">Name</th><th style="background:#f4f5f9;padding:4px 10px">Unit</th></tr></thead></table>', null],
  ['chips-6px', '<div style="display:flex;gap:6px"><span style="background:#eee;border-radius:99px;padding:2px 8px">LM</span><span style="background:#eee;border-radius:99px;padding:2px 8px">HOD</span></div>', null],
  ['segmented', '<span role="group" style="display:inline-flex"><button style="border:1px solid #ccc;border-radius:6px 0 0 6px;padding:4px 12px">Grid</button><button style="border:1px solid #ccc;border-left:0;border-radius:0 6px 6px 0;padding:4px 12px">List</button></span>', null],
  ['text-7px', '<div style="display:flex;gap:7px"><span>Approved</span><span>Rating</span></div>', 'text-tight'],
  ['cut-nohover', '<div style="width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">A long long name here</div>', 'text-cut-no-hover'],
  ['cut-hover', '<div title="A long long name here" style="width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">A long long name here</div>', null],
  ['cut-hard', '<div style="width:60px;overflow:hidden;white-space:nowrap">A long long name here</div>', 'text-cut'],
  ['v-overlap', '<div>Top line text</div><div style="margin-top:-6px">Under line text</div>', 'text-overlap-v'],
  ['sr-only', '<p>Visible words<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Hidden words</span></p>', null],
  ['hidden', '<div style="display:flex;gap:2px"><span>Shown</span><span hidden>Gone</span><span style="display:none">Gone</span></div>', null],
  ['split-word', '<div style="width:50px;word-break:break-all">Performance</div>', 'word-split'],
  ['wrap-words', '<p style="width:90px">Alpha Beta Gamma Delta Epsilon</p>', null],
  ['hyphen-break', '<p style="width:60px">Self-service-portal-access</p>', null],
  ['soft-hyphen', '<p style="width:70px;font-size:14px">Per&shy;formance</p>', null],
  ['url-anywhere', '<div style="width:80px;overflow-wrap:anywhere">https://example.com/averyveryverylongpathsegmentwithoutbreaks</div>', 'word-split'],
  ['split-folded', '<details><summary>More</summary><div style="width:50px;word-break:break-all">Performance</div></details>', null],
  ['split-hidden', '<div hidden style="width:50px;word-break:break-all">Performance</div><div style="display:none;width:50px;word-break:break-all">Performance</div>', null],
  ['split-textarea', '<textarea style="width:60px;height:60px">Performance reviews Performance</textarea>', null],
  ['split-2chars', '<div style="width:6px;word-break:break-all">Ab</div>', null],
];
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const pg = await b.newPage({ viewport: { width: 1280, height: 800 } });
  const fn = eval('(' + fnSrc + ')');
  let bad = 0;
  for (const [name, html, want] of CASES) {
    await pg.setContent('<!doctype html><html><body style="font:14px Arial;margin:20px">' + html + '</body></html>');
    const r = await pg.evaluate(fn, 8);
    const kinds = [...new Set(r.issues.map(i => i.kind))];
    const ok = want ? kinds.length === 1 && kinds[0] === want : kinds.length === 0;
    if (!ok) bad++;
    console.log((ok ? 'PASS ' : 'FAIL ') + name.padEnd(12) + ' want ' + (want || 'nothing') + ' got ' + (kinds.join(',') || 'nothing') + (r.issues[0] ? ' (' + r.issues[0].px + 'px)' : ''));
  }
  await b.close();
  console.log(bad ? bad + ' failed' : 'all ' + CASES.length + ' cases as they should be');
  process.exit(bad ? 1 : 0);
})();
