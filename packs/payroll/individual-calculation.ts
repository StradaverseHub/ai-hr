/** Explicit entry pricing. Legacy ledger rows keep their original payroll interpretation. */
import {and,asc,eq,inArray,isNotNull,isNull,or,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {payComponent,payrollIndividualTxn} from '../../db/schema';
import {deriveIndividualTxnAmountTx,TxnQuantityRequiredError} from '../../core/pay-components';
import {payRuleDerivesAmount,payRuleInputUnit} from '../../core/pay-rule';
import {isDatabaseError} from '../../lib/db-error';
import {PayFormulaError} from '../../lib/pay-formula-model';
import {isTransactionEffectiveDate} from '../../lib/transaction-effective-date';
import {lockPayComponentCatalogReadTx} from '../../core/pay-component-catalog-lock';
import {assertPayComponentCompaniesTx} from '../../core/pay-component-company';
import type {PayRule} from '../../core/pay-rule';
import {loadSavedFormulaProgramTx} from '../../core/pay-formula';
import {simulatePayFormulaTx} from '../../core/pay-formula-runtime';

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
 const formula=await loadSavedFormulaProgramTx(tx,ctx,item.rule.formulaId,p.companyId);
 // The selected payroll month owns payroll sources; retain an out-of-month work date on the ledger.
 const end=new Date(Date.UTC(Number(p.payPeriod.slice(0,4)),Number(p.payPeriod.slice(5)),0)).toISOString().slice(0,10);
 const result=await simulatePayFormulaTx(tx,ctx,formula,{companyId:p.companyId,employmentId:p.employmentId,period:p.payPeriod,asOf:p.txnDate.startsWith(p.payPeriod+'-')?p.txnDate:end,cycleId,currentCode:item.code,input:String(p.quantity),...(p.batchId?{batchId:p.batchId}:{})});
 if(!result.passed||result.amount==null)throw new PayFormulaError(result.error??'The saved formula could not calculate this transaction.');
 const amount=Number(result.amount);if(!Number.isFinite(amount)||amount<=0)throw new PayFormulaError('The formula must produce a positive transaction amount.');
 return {amount,calculationMethod:'formula' as const,formulaId:formula.id,formulaRevisionId:formula.revisionId};
}
export function previewIndividualTxnInput(ctx:SessionContext,p:IndividualCalculationInput){return withTenant(ctx,tx=>priceIndividualTxnInputTx(tx,ctx,p));}

// ── 792053e5 — re-pricing a one-off transaction from its saved quantity with the latest saved formula ─────────────
//
// ROOT CAUSE. A one-off row on a Pay Item that works out its own amount is priced ONCE, when it is keyed or imported,
// and the payroll kernel then pays that STORED amount (core/payroll.ts: rule null for anything but a Pay Formula
// Builder row without an input method). Correcting the formula marked the processed run as needing recalculation, but
// reprocessing paid the same stored figure again. The fix: every row whose amount a Pay Item formula produced carries
// a pricing marker (draft migration 9730), and processing or reprocessing an OPEN run re-prices exactly those rows,
// through the same two pricing owners that priced them at entry, before the run reads its ledger. Hand-typed amounts
// and rows of unknown origin carry no marker and are never touched. A closed run is never generated, so its rows,
// payslips and history stay exactly as they were.

const NO_MARKER={pricingSource:null,pricingRef:null,pricedAt:null} as const;
export type IndividualTxnPricingMarker={pricingSource:'pay_item_rule'|'saved_formula'|null;pricingRef:string|null;pricedAt:Date|null};
const ledgerMoney=(v:number)=>Number(v).toFixed(2);
const ruleHashSql=sql<string|null>`encode(sha256(convert_to(${payComponent.rule}::text,'UTF8')),'hex')`;

/** The marker a ledger writer stores beside the amount it is about to write. Saved-formula rows carry the formula
 * revision that priced them. A legacy row (no input method) is marked only when its Pay Item rule derives the amount
 * from these exact inputs and produces exactly this amount, so a typed figure is never mistaken for a calculated one.
 * Read-only; `rules` caches each Pay Item's rule for one submission. */
export async function individualTxnPricingMarkerTx(tx:Tx,ctx:SessionContext,p:{componentId:string|null;employmentId:string;companyId:string;payPeriod:string;txnDate:string;quantity:number|null;unit:string|null;amount:number;calculationMethod:IndividualCalculationMethod|null;formulaRevisionId?:string|null},rules=new Map<string,{rule:PayRule|null;hash:string|null}|null>()):Promise<IndividualTxnPricingMarker>{
 if(p.calculationMethod==='formula')return p.formulaRevisionId?{pricingSource:'saved_formula',pricingRef:p.formulaRevisionId,pricedAt:new Date()}:NO_MARKER;
 if(p.calculationMethod!=null||!p.componentId||!(p.amount>0))return NO_MARKER;
 if(!rules.has(p.componentId)){
  const [item]=await tx.select({rule:payComponent.rule,hash:ruleHashSql}).from(payComponent).where(and(eq(payComponent.id,p.componentId),eq(payComponent.tenantId,ctx.tenantId))).limit(1);
  rules.set(p.componentId,item?{rule:item.rule as PayRule|null,hash:item.hash}:null);
 }
 const item=rules.get(p.componentId);
 if(!item?.hash||!payRuleDerivesAmount(item.rule)||item.rule?.kind==='formula_builder')return NO_MARKER;
 const inputUnit=payRuleInputUnit(item.rule);
 if(inputUnit!=null&&(p.unit!==inputUnit||p.quantity==null||!(p.quantity>0)))return NO_MARKER;
 try{
  const d=await deriveIndividualTxnAmountTx(tx,ctx,{componentId:p.componentId,employmentId:p.employmentId,companyId:p.companyId,payPeriod:p.payPeriod,quantity:p.quantity,unit:p.unit,effectiveDate:p.txnDate});
  if(!d.derived||d.zeroDivisor||ledgerMoney(d.amount)!==ledgerMoney(p.amount))return NO_MARKER;
 }catch{return NO_MARKER;}
 return {pricingSource:'pay_item_rule',pricingRef:'rule:'+item.hash,pricedAt:new Date()};
}

export type PayItemRepriceReason='formula_failed'|'not_positive'|'zero_divisor'|'input_missing'|'no_longer_calculates';
/** The updated Pay Item formula could not price one or more of an employee's transactions. Never a silent fallback to
 * the previous figure: a reprocess maps it to a Configuration incomplete outcome (core/payroll.ts) and keeps the run
 * marked; a whole-run processing job fails with this message and the run returns to draft. */
export class PayItemFormulaRepriceError extends Error{
 constructor(public readonly employmentId:string,public readonly componentId:string,public readonly code:string,public readonly itemName:string,
  public readonly dates:string[],public readonly reason:PayItemRepriceReason,public readonly detail:string|null){
  const why={formula_failed:'The formula could not be calculated for these inputs.',not_positive:'The formula did not produce a positive amount.',
   zero_divisor:'The formula divides by zero for these inputs.',input_missing:'The transaction has no Hours, Days or Quantity the formula needs.',
   no_longer_calculates:'The Pay Item no longer calculates its amount from a formula.'}[reason];
  super(`${itemName} (${code}): the updated formula could not calculate ${dates.length} transaction${dates.length===1?'':'s'} (${dates.join(', ')}). ${why}${detail?` ${detail}`:''} Correct the formula in Payroll > Settings > Pay Items and process again.`);
  this.name='PayItemFormulaRepriceError';
 }
}
export type RepricedPayItem={componentId:string;code:string;name:string;count:number;quantity:number;unit:string|null;before:number;after:number};

/**
 * Re-price the marked one-off rows of these employments on this run, in the caller's generation transaction (the run's
 * catalogue and company/month keys are already held, the run is draft, processing or processed). Rows another run
 * already paid are excluded. Writes only when the amount or the pricing reference changes, with one reference-only
 * `payroll.individual-txn.repriced` event per changed row (ADR-0030 Layer 0). Returns, per employment, the Pay Items
 * whose amount moved; throws PayItemFormulaRepriceError (nothing written: the caller's transaction or savepoint rolls
 * back) when the updated formula cannot price a row. Deterministic pricing owners only.
 */
export async function repriceIndividualLedgerTx(tx:Tx,ctx:SessionContext,p:{batch:{id:string;companyId:string;payPeriod:string;payrollCycleId:string|null};employmentIds:readonly string[]}):Promise<Map<string,RepricedPayItem[]>>{
 const out=new Map<string,RepricedPayItem[]>();
 if(!p.employmentIds.length)return out;
 const rows=await tx.select({id:payrollIndividualTxn.id,employmentId:payrollIndividualTxn.employmentId,componentId:payrollIndividualTxn.componentId,txnDate:payrollIndividualTxn.txnDate,
  quantity:payrollIndividualTxn.quantity,unit:payrollIndividualTxn.unit,amount:payrollIndividualTxn.amount,pricingSource:payrollIndividualTxn.pricingSource,pricingRef:payrollIndividualTxn.pricingRef,
  intendedCycleId:payrollIndividualTxn.intendedCycleId,code:payComponent.code,name:payComponent.name,ruleHash:ruleHashSql})
  .from(payrollIndividualTxn).innerJoin(payComponent,eq(payComponent.id,payrollIndividualTxn.componentId))
  .where(and(eq(payrollIndividualTxn.batchId,p.batch.id),or(isNull(payrollIndividualTxn.consumedBatchId),eq(payrollIndividualTxn.consumedBatchId,p.batch.id)),
   inArray(payrollIndividualTxn.employmentId,[...p.employmentIds]),isNotNull(payrollIndividualTxn.pricingSource)))
  .orderBy(asc(payrollIndividualTxn.employmentId),asc(payrollIndividualTxn.txnDate),asc(payrollIndividualTxn.id));
 if(!rows.length)return out;
 const failures=new Map<string,{row:typeof rows[number];dates:string[];reason:PayItemRepriceReason;detail:string|null}>();
 const changes:{row:typeof rows[number];amount:string;ref:string}[]=[];
 for(const row of rows){
  const quantity=row.quantity==null?null:Number(row.quantity);
  let priced:{amount:number;ref:string}|{reason:PayItemRepriceReason;detail:string|null};
  if(row.pricingSource==='pay_item_rule'){
   try{
    const d=await deriveIndividualTxnAmountTx(tx,ctx,{componentId:row.componentId!,employmentId:row.employmentId,companyId:p.batch.companyId,payPeriod:p.batch.payPeriod,quantity,unit:row.unit,effectiveDate:row.txnDate});
    priced=!d.derived?{reason:'no_longer_calculates',detail:null}:d.zeroDivisor?{reason:'zero_divisor',detail:null}
     :!(Number(ledgerMoney(d.amount))>0)?{reason:'not_positive',detail:null}:{amount:d.amount,ref:'rule:'+row.ruleHash};
   }catch(e){
    if(!(e instanceof Error)||isDatabaseError(e))throw e;
    priced=e instanceof TxnQuantityRequiredError?{reason:'input_missing',detail:null}:{reason:'formula_failed',detail:e.message};
   }
  }else{
   try{
    const r=await priceIndividualTxnInputTx(tx,ctx,{componentId:row.componentId,employmentId:row.employmentId,companyId:p.batch.companyId,payPeriod:p.batch.payPeriod,txnDate:row.txnDate,
     quantity,unit:row.unit,amount:Number(row.amount),cycleId:p.batch.payrollCycleId??row.intendedCycleId,batchId:p.batch.id,method:'formula'});
    priced={amount:r.amount,ref:'formulaRevisionId' in r&&r.formulaRevisionId?r.formulaRevisionId:row.pricingRef!};
   }catch(e){
    if(!(e instanceof PayFormulaError))throw e;
    priced={reason:'formula_failed',detail:e.message};
   }
  }
  if('reason' in priced){
   const key=row.employmentId+':'+row.componentId;const f=failures.get(key);
   if(f)f.dates.push(row.txnDate);else failures.set(key,{row,dates:[row.txnDate],reason:priced.reason,detail:priced.detail});
   continue;
  }
  const amount=ledgerMoney(priced.amount);
  if(amount!==ledgerMoney(Number(row.amount))||priced.ref!==row.pricingRef)changes.push({row,amount,ref:priced.ref});
 }
 if(failures.size){const f=[...failures.values()][0];throw new PayItemFormulaRepriceError(f.row.employmentId,f.row.componentId!,f.row.code,f.row.name,f.dates,f.reason,f.detail);}
 const pricedAt=new Date();
 for(const {row,amount,ref} of changes){
  await tx.update(payrollIndividualTxn).set({amount,pricingRef:ref,pricedAt}).where(eq(payrollIndividualTxn.id,row.id));
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-individual-txn',aggregateId:row.id,eventType:'payroll.individual-txn.repriced',actor:actorOf(ctx),subjectEmploymentId:row.employmentId,
   payload:{batchId:p.batch.id,componentId:row.componentId,pricingSource:row.pricingSource,previousPricingRef:row.pricingRef,pricingRef:ref,reason:ref!==row.pricingRef?'formula-updated':'inputs-changed'}});
  if(amount===ledgerMoney(Number(row.amount)))continue;
  const items=out.get(row.employmentId)??[];out.set(row.employmentId,items);
  let item=items.find(i=>i.componentId===row.componentId);
  if(!item){item={componentId:row.componentId!,code:row.code,name:row.name,count:0,quantity:0,unit:row.unit,before:0,after:0};items.push(item);}
  item.count++;item.quantity=Math.round((item.quantity+Number(row.quantity??0))*100)/100;
  item.before=Math.round((item.before+Number(row.amount))*100)/100;item.after=Math.round((item.after+Number(amount))*100)/100;
  if(item.unit!==row.unit)item.unit=null;
 }
 return out;
}
