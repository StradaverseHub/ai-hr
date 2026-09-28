/* Standalone verification of the new test's logic. NOT vitest: no DB, no cluster, no worker. */
import fs from 'node:fs';
import { PDFDocument, PDFRawStream, decodePDFRawStream, type PDFArray } from 'pdf-lib';
import { foldWinAnsi, renderPcbDetailPdf } from './app/payroll/pcb-detail/slip-pdf';
import { pcbFormulaBlocks } from './app/payroll/pcb-detail/formulas';
import { explainPcb, type PcbExplanation, type PcbReliefBreakdown } from './core/pcb-explain';
import { pcbMonth } from './localization/my/payroll';

let fails = 0;
const eq = (a: unknown, b: unknown, m: string) => { if (a !== b) { fails++; console.log('FAIL', m, JSON.stringify(a), '!=', JSON.stringify(b)); } };
const has = (s: string, p: string, m: string) => { if (!s.includes(p)) { fails++; console.log('FAIL', m, 'missing', JSON.stringify(p)); } };
const hasnt = (s: string, p: string, m: string) => { if (s.includes(p)) { fails++; console.log('FAIL', m, 'contains', JSON.stringify(p)); } };

const CURRENT: PcbReliefBreakdown = { individual: 9000, spouse: 0, children: 0, disabledIndividual: 0, disabledSpouse: 0, lp: 0, total: 9000 };
const b2 = (v: number) => v.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (r: number) => `${(r * 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
const FMT = { b2, pct, int: (v: number) => `${v}` };

function bonusMonth() {
  const r = pcbMonth({ monthlyWage: 14000, epfMonthly: 1540, month: 7, profile: { category: 2, children: 3 },
    acc: { netRemuneration: 63000, epfClaimed: 800, pcbPaid: 4100, zakatPaid: 250, lpAccumulated: 480 },
    additional: 26000, epfOnAdditional: 600, lpCurrent: 90, zakatCurrent: 60 });
  const x = explainPcb({ pcb: r.total, pcbBonus: r.additional, epfEmployee: 1540, zakat: 60, lp: 570, pcbMeta: r.snapshot }, CURRENT);
  if (x.kind !== 'mtd') throw new Error('x'); return x;
}
function plainMonth() {
  const r = pcbMonth({ monthlyWage: 9000, epfMonthly: 990, month: 4, profile: { category: 2, children: 1 },
    acc: { netRemuneration: 24000, epfClaimed: 2970, pcbPaid: 600, zakatPaid: 0, lpAccumulated: 0 } });
  const x = explainPcb({ pcb: r.total, epfEmployee: 990, pcbMeta: r.snapshot }, CURRENT);
  if (x.kind !== 'mtd') throw new Error('x'); return x;
}
async function drawnText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const out: string[] = [];
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFRawStream ? [contents] : (contents as PDFArray).asArray().map((ref) => doc.context.lookup(ref) as PDFRawStream);
    for (const st of streams) {
      const body = Buffer.from(decodePDFRawStream(st).decode()).toString('latin1');
      for (const m of body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(Buffer.from(m[1], 'hex').toString('latin1'));
    }
  }
  return out.join('\n');
}
const foldBefore = (s: string) => (s ?? '').replace(/[–—−]/g, '-').replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

async function main() {
  // (a)
  eq(foldBefore('Σ(Y−K)'), '?(Y-K)', 'foldBefore SumYK');
  eq(foldBefore('ΣLP'), '?LP', 'foldBefore SumLP');
  eq(foldBefore('Y₁ − K₁'), 'Y? - K?', 'foldBefore Y1K1');
  eq(foldWinAnsi('Σ(Y−K)'), 'Sum(Y-K)', 'fold SumYK');
  eq(foldWinAnsi('ΣLP'), 'SumLP', 'fold SumLP');
  eq(foldWinAnsi('Y₁ − K₁'), 'Y1 - K1', 'fold Y1K1');
  eq(foldWinAnsi('∑LP'), 'SumLP', 'fold U2211');
  eq(foldWinAnsi('K₂ₜ'), 'K2t', 'fold K2t');
  eq(foldWinAnsi('P₂ = Σ(Y − K*) + (Yₜ − Kₜ*)'), 'P2 = Sum(Y - K*) + (Yt - Kt*)', 'fold p2');

  const strings: [string, string][] = [];
  const walk = (w: string, n: unknown) => { if (typeof n === 'string') strings.push([w, n]); else if (n && typeof n === 'object') for (const [k, v] of Object.entries(n as Record<string, unknown>)) walk(`${w}.${k}`, v); };
  for (const loc of ['en', 'ms']) {
    const j = JSON.parse(fs.readFileSync(`messages/${loc}.json`, 'utf8'));
    walk(`${loc}.pcbDetail`, j.payroll.pcbDetail); walk(`${loc}.taxRelief`, j.taxRelief);
  }
  console.log('catalogue strings swept:', strings.length);
  for (const [w, v] of strings) { if (v.includes('?')) continue; hasnt(foldWinAnsi(v), '?', `catalogue ${w}`); }

  const explain = fs.readFileSync('core/pcb-explain.ts', 'utf8');
  const symbols = [...explain.matchAll(/symbol: '([^']*)'/g)].map((m) => m[1]);
  console.log('symbols:', symbols.length);
  for (const s of symbols) hasnt(foldWinAnsi(s), '?', `symbol ${s}`);
  for (const x of [plainMonth(), bonusMonth()]) for (const fb of pcbFormulaBlocks(x, FMT)) for (const s of [fb.substituted, fb.calculation]) { if (s == null) continue; hasnt(foldWinAnsi(s), '?', `expr ${fb.key}`); }

  // (b)
  const x = bonusMonth(); const blocks = pcbFormulaBlocks(x, FMT);
  const bytes = await renderPcbDetailPdf({
    title: 'PCB / MTD calculation detail', subtitle: 'Employee · Company · 2026-07',
    sections: [
      { heading: 'LHDN worksheet', columns: ['Amount'], rows: [
        { line: 'Σ(Y−K)', label: 'Accumulated remuneration after EPF', cells: ['63,000.00'] },
        { line: 'ΣLP', label: 'Accumulated optional deductions', cells: ['480.00'] },
        { line: 'K2t', label: 'Re-estimated projected EPF', cells: ['0.00'] }] },
      ...blocks.map((fb) => ({ heading: fb.heading, columns: ['Amount'], rows: [
        { line: '', label: `Formula:  ${fb.formula}`, cells: [] },
        { line: '', label: `Actual values:  ${fb.substituted ?? 'Not recorded'}`, cells: [] },
        ...(fb.calculation === undefined ? [] : [{ line: '', label: `Calculation:  ${fb.calculation}`, cells: [] }])] })),
    ], provenance: ['Our rendering, not the agency’s form.'],
  });
  eq(Buffer.from(bytes).subarray(0, 5).toString(), '%PDF-', 'pdf header');
  const text = await drawnText(bytes);
  console.log('drawn text length:', text.length);
  hasnt(text, '?', 'no question mark on the document');
  for (const p of ['Sum(Y-K)', 'SumLP', 'K2t']) has(text, p, 'symbol drawn');

  const en = JSON.parse(fs.readFileSync('messages/en.json','utf8')).payroll.pcbDetail as Record<string,string>;
  const bytes2 = await renderPcbDetailPdf({ title: 'T', subtitle: 'E', sections: blocks.map((fb) => ({ heading: en[fb.heading], columns: ['Amount'], rows: [
    { line: '', label: `Formula:  ${en[fb.formula]}`, cells: [] },
    { line: '', label: `Actual values:  ${fb.substituted ?? 'Not recorded'}`, cells: [] },
    { line: '', label: 'Result', cells: [fb.result === null ? 'Not recorded' : b2(fb.result)] }] })), provenance: ['x'] });
  const text2 = await drawnText(bytes2);
  for (const tok of ['Sum(Y', 'K2t*)', 'max(', 'DU', 'SU', 'QC']) has(text2, tok, 'token');
  has(text2, b2(x.chargeableIncome), 'P drawn');
  has(text2, b2(x.chargeableIncomeWithAdditional!), 'P2 drawn');

  // (c)
  const px = plainMonth(); const pb = pcbFormulaBlocks(px, FMT);
  eq(px.chargeableIncomeWithAdditional, null, 'no D2');
  const p1 = pb.find((b) => b.key === 'p1')!;
  has(p1.substituted!, '( 0.00 − 0.00 )', 'zero limb');
  eq(p1.legend, 'pLegNormal', 'legend');
  eq(pb.some((b) => b.key === 'p2'), false, 'no p2 block');

  const bb = pcbFormulaBlocks(x, FMT); const t = x.trace!;
  const bp1 = bb.find((b) => b.key === 'p1')!; const bp2 = bb.find((b) => b.key === 'p2')!;
  if (!(t.Yt > 0)) { fails++; console.log('FAIL fixture pays no bonus'); }
  has(bp1.substituted!, '( 0.00 − 0.00 )', 'bonus month p1 zero limb');
  hasnt(bp1.substituted!, b2(t.Yt), 'p1 must not carry the bonus');
  eq(bp1.result, x.chargeableIncome, 'p1 result');
  has(bp2.substituted!, `( ${b2(t.Yt)} − ${b2(t.Kt)} )`, 'p2 limb');
  has(bp2.substituted!, b2(t.K2t), 'p2 K2t');
  eq(bp2.result, x.chargeableIncomeWithAdditional, 'p2 result');
  eq(bp2.formula, 'p2Formula', 'p2 formula key');
  const by = new Map(bb.map((b) => [b.key, b]));
  has(by.get('mtd')!.calculation!, b2(t.taxOnP1), 'mtd calc taxOnP1');
  has(by.get('net')!.calculation!, b2(t.zakatLeftover), 'net calc leftover');
  eq(by.get('year')!.calculation, undefined, 'year no calc');
  eq(by.get('year')!.result, t.totalMtdYear, 'year result');

  const py = pcbFormulaBlocks(px, FMT).find((b) => b.key === 'year')!;
  eq(px.trace!.totalMtdYear, null, 'plain month totalMtdYear null');
  eq(py.formula, 'yearFormula', 'year formula key');
  eq(py.substituted, null, 'year substituted null');
  eq(py.result, null, 'year result null');
  eq(py.notes.includes('yearNoAdditional'), true, 'year note');
  // the catalogue sweep the test now performs
  const keys = new Set<string>();
  for (const xx of [plainMonth(), bonusMonth()]) for (const fb of pcbFormulaBlocks(xx, FMT)) { keys.add(fb.heading); keys.add(fb.formula); keys.add(fb.resultLabel); if (fb.legend) keys.add(fb.legend); for (const n of fb.notes) keys.add(n); }
  console.log('assembly keys:', keys.size, [...keys].join(' '));
  for (const loc of ['en','ms','ta','th','vi','zh']) {
    const blk = JSON.parse(fs.readFileSync(`messages/${loc}.json`,'utf8')).payroll.pcbDetail as Record<string,string>;
    for (const k of keys) { if (!blk[k]) { fails++; console.log('FAIL missing key', loc, k); } else if (/[{}]/.test(blk[k])) { fails++; console.log('FAIL ICU', loc, k); } }
  }

  const nt = explainPcb({ pcb: 402.65, epfEmployee: 0, zakat: 15, pcbMeta: { month: 1, n: 11, ytdNet: 1234.5, epfClaimed: 200, pcbPaid: 90, P1: 75956.07,
    reliefs: { individual: 9000, spouse: 0, children: 0, disabledIndividual: 0, disabledSpouse: 0, lp: 0, total: 9000 } } }, CURRENT);
  if (nt.kind !== 'mtd') throw new Error('x');
  eq(nt.trace, null, 'no trace');
  for (const fb of pcbFormulaBlocks(nt, FMT)) { eq(fb.substituted, null, `no-trace ${fb.key} substituted`); eq(fb.calculation, undefined, `no-trace ${fb.key} calculation`); }

  console.log(fails === 0 ? 'ALL CHECKS PASS' : `${fails} FAILURES`);
  // sample output for the eye
  console.log('\n--- p1 substituted ---\n' + bp1.substituted);
  console.log('\n--- p1 calculation ---\n' + bp1.calculation);
  console.log('\n--- mtd substituted ---\n' + by.get('mtd')!.substituted);
  console.log('\n--- mtd calculation ---\n' + by.get('mtd')!.calculation);
  console.log('\n--- net substituted ---\n' + by.get('net')!.substituted);
  console.log('\n--- net calculation ---\n' + by.get('net')!.calculation);
  console.log('\n--- year substituted ---\n' + by.get('year')!.substituted);
}
main();
