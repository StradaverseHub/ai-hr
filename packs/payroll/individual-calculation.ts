/** Explicit entry pricing. Legacy ledger rows keep their original payroll interpretation. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {PayFormulaError} from '../../lib/pay-formula-model';
import {isTransactionEffectiveDate} from '../../lib/transaction-effective-date';
import {lockPayComponentCatalogReadTx} from '../../core/pay-component-catalog-lock';
import {assertPayComponentCompaniesTx} from '../../core/pay-component-company';
import type {PayRule} from '../../core/pay-rule';

export type IndividualCalculationMethod='amount'|'formula';
export type IndividualCalculationInput={componentId:string|null;employmentId:string;companyId:string;payPeriod:string;txnDate:string;quantity:number|null;unit:string|null;amount:number;cycleId?:string|null;batchId?:string|null;method:IndividualCalculationMethod};

export async function priceIndividualTxnInputTx(tx:Tx,ctx:SessionContext,p:IndividualCalculationInput){
 if(!['amount','formula'].includes(p.method))throw new PayFormulaError('Choose a supported transaction input method.');
 if(!p.componentId)throw new PayFormulaError('Choose a Pay Item with an assigned Formula ID.');
 await lockPayComponentCatalogReadTx(tx,ctx);
 const [item]=await tx.execute<{code:string;rule:PayRule|null}>(sql`select code,rule from pay_component where id=${p.componentId}::uuid and tenant_id=${ctx.tenantId}::uuid and archived_at is null`);
 if(!item)throw new PayFormulaError('The selected Pay Item is unavailable.');
 if(item.rule?.kind!=='formula_builder')throw new PayFormulaError('The Pay Item no longer has an assigned Formula ID. Reopen the transaction.');
 const [allowed]=await tx.execute<{ok:boolean}>(sql`select app.can_admin_payroll_for(${p.companyId}::uuid) and exists(select 1 from employment where id=${p.employmentId}::uuid and company_id=${p.companyId}::uuid and tenant_id=${ctx.tenantId}::uuid) as ok`);
 if(!allowed?.ok)throw new PayFormulaError('Transaction calculation is unavailable.');
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(p.payPeriod)||!isTransactionEffectiveDate(p.txnDate))throw new PayFormulaError('Choose a valid payroll month and effective date.');
 await assertPayComponentCompaniesTx(tx,ctx,[{componentId:p.componentId,employmentId:p.employmentId,effectiveDate:p.txnDate}]);
 if(p.method==='amount'){
  if(p.unit!=='amount'||p.quantity!=null)throw new PayFormulaError('Amount input must not include a quantity.');
  if(!Number.isFinite(p.amount)||p.amount<=0)throw new PayFormulaError('Enter a positive transaction amount.');
  return {amount:p.amount,calculationMethod:'amount' as const};
 }
 if(!['qty','hours','days','units'].includes(p.unit??'')||!Number.isFinite(p.quantity)||!(p.quantity!>0))throw new PayFormulaError('Enter a positive quantity, hours, days or units.');
 if(Number(p.quantity!.toFixed(2))!==p.quantity)throw new PayFormulaError('Enter a quantity with at most two decimal places.');
 let cycleId=p.cycleId??null;
 if(p.batchId){
  const [batch]=await tx.execute<{cycleId:string|null;runType:string}>(sql`select payroll_cycle_id as "cycleId",run_type as "runType" from payroll_batch where id=${p.batchId}::uuid and company_id=${p.companyId}::uuid and tenant_id=${ctx.tenantId}::uuid and pay_period=${p.payPeriod}`);
  if(!batch)throw new PayFormulaError('The selected payroll run is unavailable.');
  if(batch.cycleId&&cycleId&&batch.cycleId!==cycleId)throw new PayFormulaError('The transaction cycle does not match its payroll run.');
  cycleId=batch.cycleId??cycleId;
  if(!cycleId){const cycles=await tx.execute<{id:string}>(sql`select id from payroll_cycle where company_id=${p.companyId}::uuid and tenant_id=${ctx.tenantId}::uuid and archived_at is null and run_type=${batch.runType}`);if(cycles.length!==1)throw new PayFormulaError('Choose the exact configured payroll cycle before calculating.');cycleId=cycles[0].id;}
 }
 if(!cycleId){const cycles=await tx.execute<{id:string}>(sql`select id from payroll_cycle where company_id=${p.companyId}::uuid and tenant_id=${ctx.tenantId}::uuid and archived_at is null and run_type='regular'`);if(cycles.length!==1)throw new PayFormulaError('Choose the configured payroll cycle before calculating.');cycleId=cycles[0].id;}
 const {loadSavedFormulaProgramTx}=await import('../../core/pay-formula');
 const {simulatePayFormulaTx}=await import('../../core/pay-formula-runtime');
 const formula=await loadSavedFormulaProgramTx(tx,ctx,item.rule.formulaId,p.companyId);
 // The selected payroll month owns payroll sources; retain an out-of-month work date on the ledger.
 const end=new Date(Date.UTC(Number(p.payPeriod.slice(0,4)),Number(p.payPeriod.slice(5)),0)).toISOString().slice(0,10);
 const result=await simulatePayFormulaTx(tx,ctx,formula,{companyId:p.companyId,employmentId:p.employmentId,period:p.payPeriod,asOf:p.txnDate.startsWith(p.payPeriod+'-')?p.txnDate:end,cycleId,currentCode:item.code,input:String(p.quantity),...(p.batchId?{batchId:p.batchId}:{})});
 if(!result.passed||result.amount==null)throw new PayFormulaError(result.error??'The saved formula could not calculate this transaction.');
 const amount=Number(result.amount);if(!Number.isFinite(amount)||amount<=0)throw new PayFormulaError('The formula must produce a positive transaction amount.');
 return {amount,calculationMethod:'formula' as const,formulaId:formula.id,formulaRevisionId:formula.revisionId};
}
export function previewIndividualTxnInput(ctx:SessionContext,p:IndividualCalculationInput){return withTenant(ctx,tx=>priceIndividualTxnInputTx(tx,ctx,p));}
