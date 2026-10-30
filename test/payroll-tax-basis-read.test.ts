import {describe,it,expect} from 'vitest';
import type {SessionContext,Tx} from '../db/client';
import {readEffectiveTaxBasesTx,taxBasisSourceHashTx,validatedTaxBasis} from '../core/payroll-tax-basis-read';
const tenant='11111111-1111-4111-8111-111111111111',company='22222222-2222-4222-8222-222222222222',employment='33333333-3333-4333-8333-333333333333';
const ctx={tenantId:tenant}as SessionContext;
const fixture=(n:number)=>({id:`44444444-4444-4444-8444-${String(n).padStart(12,'0')}`,employmentId:employment,companyId:company,period:'2026-01',source:{statutory:{pcb:10,epfEmployee:550,bases:{pcb:5000,epf:5000}}},batch:{id:`batch-${n}`},importRevision:`source-revision-${n}`});
const basis={version:1,period:'2026-01',pcb:5500,normal:5000,additional:500,exempt:0,exemptionUsed:{},lp:0,items:[],rulesHash:'exact-rules'};
const txRows=(results:unknown[][])=>{let i=0;return {execute:async()=>{if(i>=results.length)throw Error('Unexpected query');return results[i++];}}as unknown as Tx;};
async function correction(n:number){const source=fixture(n);return{id:`correction-${n}`,batchId:'correction-batch',payslipId:source.id,sourceHash:await taxBasisSourceHashTx(txRows([[source]]),source.id),basis:{...basis}};}
describe('exact effective tax basis reads',()=>{
 it('reads each corrected cycle separately and the combined month without treating an unrequested valid cycle as stale',async()=>{
  const one=fixture(1),two=fixture(2),a=await correction(1),b=await correction(2);
  const readOne=await readEffectiveTaxBasesTx(txRows([[one],[a,b],[two]]),ctx,[one.id]);
  expect([...readOne.keys()]).toEqual([one.id]);expect(readOne.get(one.id)?.statutory).toMatchObject({pcb:10,epfEmployee:550,bases:{pcb:5500,epf:5000}});
  const readTwo=await readEffectiveTaxBasesTx(txRows([[two],[a,b],[one]]),ctx,[two.id]);expect([...readTwo.keys()]).toEqual([two.id]);
  const combined=await readEffectiveTaxBasesTx(txRows([[one,two],[a,b]]),ctx,[one.id,two.id]);expect([...combined.keys()]).toEqual([one.id,two.id]);
  expect(one.source.statutory.bases.pcb).toBe(5000);
 });
 it('refuses an orphaned correction when an import replacement hides the old snapshot',async()=>{
  const current=fixture(2),orphan=await correction(1);
  await expect(readEffectiveTaxBasesTx(txRows([[current],[orphan],[]]),ctx,[current.id])).rejects.toThrow(/Saved payroll changed/);
 });
 it('refuses changed source revision provenance even with unchanged payroll money',async()=>{
  const source=fixture(1),saved=await correction(1);source.importRevision='later-revert';
  await expect(readEffectiveTaxBasesTx(txRows([[source],[saved]]),ctx,[source.id])).rejects.toThrow(/Saved payroll changed/);
 });
 it('keeps explicit stale-lineage supersession effective after another same-source correction',async()=>{
  const source=fixture(2),old=await correction(1),fresh=await correction(2);
  const prior={...fresh,id:'prior-correction',basis:{...basis,supersedes:[old.id]}};
  const result=await readEffectiveTaxBasesTx(txRows([[source],[old,fresh,prior],[]]),ctx,[source.id]);
  expect(result.get(source.id)?.correction.id).toBe(fresh.id);
 });
 it('rejects malformed corrections and unreconciled remuneration totals',()=>{
  expect(()=>validatedTaxBasis({...basis,pcb:5501})).toThrow(/reconcile/);
  expect(()=>validatedTaxBasis({...basis,exemptionUsed:{PCB_TRA_BUSINESS:-1}})).toThrow(/malformed/);
  expect(()=>validatedTaxBasis({...basis,normal:NaN})).toThrow(/malformed/);
 });
});
