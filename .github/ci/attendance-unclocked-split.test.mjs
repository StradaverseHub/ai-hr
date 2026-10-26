/** In-memory omissions/financial-guard negative controls; no app/database/compiler calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {readUnclockedSplitSources,verifyUnclockedSplit} from './attendance-unclocked-source-proof.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
test('all32original registrations retain exact table values, callbacks, financial controls and per-case resets',()=>{
 const p=verifyUnclockedSplit(readUnclockedSplitSources(root));assert.equal(p.remainingCases+p.financialCases,p.originalCases);assert.equal(p.originalCases,32);assert.equal(p.releaseAuthorized,false);
});
test('actual case-registration expression gives disjoint cash/TOIL rows with the exact original18-row union',()=>{
 const s=readUnclockedSplitSources(root);
 const registered=(source,mode)=>{
  const start=source.indexOf(" it.each([...( ['cash','toil'] as const).flatMap(mode=>[\n"),end=source.indexOf(',async(',start);
  assert(start>=0&&end>start,'Actual financial registration boundary required');let rows;
  const code=stripTypeScriptTypes(source.slice(start,end)+',()=>{});');
  runInNewContext(code,{mode,it:{each:value=>(_title,_callback)=>{rows=JSON.parse(JSON.stringify(value));}}},{timeout:500});
  assert(Array.isArray(rows));return rows;
 };
 const original=registered(s.baseline),cash=registered(s.financialFixture,'cash'),toil=registered(s.financialFixture,'toil');
 assert.equal(original.length,18);assert.equal(cash.length,9);assert.equal(toil.length,9);
 assert(cash.every(r=>r.mode==='cash'));assert(toil.every(r=>r.mode==='toil'));
 const sorted=rows=>rows.map(r=>JSON.stringify(r)).sort();assert.deepEqual(sorted([...cash,...toil]),sorted(original));
});
for(const [label,key,from,to] of [
 ['reset omission','financialFixture','await resetDb();',''],
 ['changed cash assertion','financialFixture',"expectedMoney=roundMode==='none'?(requestedWinner?'18.00':'36.00'):(requestedWinner?'27.00':'45.00')","expectedMoney='0.00'"],
 ['favorable-clock substitution','financialFixture',"day(-1),true,true","day(1),true,true"],
 ['changed135minute test value','financialFixture',"roundMode==='up'?125:135","roundMode==='up'?125:120"],
 ['duplicate mode partition','financial',"Cases('cash')","Cases('toil')"],
 ['omitted TOIL partition','toil',"registerAttestedFinancialCases('toil');",''],
 ['changed case filter','financialFixture','row.mode===mode','true'],
 ['changed other owner-scope assertion','remaining',"it('requires real financial scope", "it.skip('requires real financial scope"],
 ['modified source oracle','baseline','updateLeaveType','editedLeaveType'],
])test('refuse '+label,()=>{const s=readUnclockedSplitSources(root);assert(s[key].includes(from),'Negative-control boundary is nonempty');s[key]=s[key].replace(from,to);assert.throws(()=>verifyUnclockedSplit(s));});
