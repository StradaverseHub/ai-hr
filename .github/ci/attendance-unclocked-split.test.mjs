/** In-memory omissions/financial-guard negative controls; no app/database/compiler calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {readUnclockedSplitSources,verifyUnclockedSplit} from './attendance-unclocked-source-proof.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
test('all32original registrations retain exact table values, callbacks, financial controls and per-case resets',()=>{
 const p=verifyUnclockedSplit(readUnclockedSplitSources(root));assert.equal(p.remainingCases+p.financialCases,p.originalCases);assert.equal(p.originalCases,32);assert.equal(p.releaseAuthorized,false);
});
for(const [label,key,from,to] of [
 ['reset omission','financial','await resetDb();',''],
 ['changed cash assertion','financial',"expectedMoney=roundMode==='none'?(requestedWinner?'18.00':'36.00'):(requestedWinner?'27.00':'45.00')","expectedMoney='0.00'"],
 ['favorable-clock substitution','financial',"day(-1),true,true","day(1),true,true"],
 ['changed135minute test value','financial',"roundMode==='up'?125:135","roundMode==='up'?125:120"],
 ['changed other owner-scope assertion','remaining',"it('requires real financial scope", "it.skip('requires real financial scope"],
 ['modified source oracle','baseline','updateLeaveType','editedLeaveType'],
])test('refuse '+label,()=>{const s=readUnclockedSplitSources(root);assert(s[key].includes(from),'Negative-control boundary is nonempty');s[key]=s[key].replace(from,to);assert.throws(()=>verifyUnclockedSplit(s));});
