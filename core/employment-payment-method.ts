import {employment} from '../db/schema';
import {eq} from 'drizzle-orm';
import {lockPayrollInputsTx} from './payroll-inputs-lock';
import {preserveMovementPayrollTx} from './movement-payroll-protection';
import {sql,type SQL} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {withPersonnelRead} from './personnel-read-bounds';
import {assertWorkforceEmploymentTx} from './workforce-access';
import {isCalendarDate} from '../lib/calendar-date';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {PaymentMethod} from '../lib/payment-methods';

/** One indexed dated owner. A recorded null clears the method; a missing historical date remains unknown. */
export function employmentPaymentMethodOnSql(employmentId:SQL,date:string=todayInKualaLumpur()){
 return sql<PaymentMethod|null>`app.employment_payment_method_on(${employmentId},${date}::date)`;
}
export async function employmentPaymentMethodOnTx(tx:Tx,employmentId:string,date:string){
 if(!isCalendarDate(date))throw new Error('Enter a valid payment method effective date.');
 const [row]=await tx.execute<{method:PaymentMethod|null}>(sql`select app.employment_payment_method_on(${employmentId}::uuid,${date}::date) as method`);
 return row?.method??null;
}
export function employmentPaymentMethodHistory(ctx:SessionContext,employmentId:string){
 return withPersonnelRead(ctx,async tx=>{
  await assertWorkforceEmploymentTx(tx,ctx,employmentId,'view');
  return Array.from(await tx.execute<{id:string;effectiveOn:string;paymentMethod:PaymentMethod|null;recordedAt:string;recordedBy:string|null;supersededAt:string|null;source:string}>(sql`
   select id,effective_on::text as "effectiveOn",payment_method as "paymentMethod",recorded_at::text as "recordedAt",
    recorded_by as "recordedBy",superseded_at::text as "supersededAt",source
   from employment_payment_method_history where tenant_id=app.current_tenant_id() and employment_id=${employmentId}::uuid
   order by effective_on desc,recorded_at desc,id desc`));
 });
}

/** Trusted dated sweep projection. History remains the fact owner; this refreshes the legacy current
 * column consumed by older SQL reports. It emits evidence, never another method-history decision. */
export async function projectEmploymentPaymentMethodTx(tx:Tx,ctx:SessionContext,employmentId:string,asOf:string){
 if(!isCalendarDate(asOf))throw new Error('Invalid payment projection date.');
 await assertWorkforceEmploymentTx(tx,ctx,employmentId,'maintain');
 const [needed]=await tx.execute<{id:string}>(sql`select e.id from employment e where e.id=${employmentId}::uuid and e.tenant_id=app.current_tenant_id()
  and exists(select 1 from employment_payment_method_history h where h.employment_id=e.id and h.tenant_id=e.tenant_id and h.superseded_at is null and h.effective_on<=${asOf}::date)
  and e.payment_method is distinct from app.employment_payment_method_on(e.id,${asOf}::date)::payment_method`);
 if(!needed)return false;
 await lockPayrollInputsTx(tx,{employmentIds:[employmentId]});
 await preserveMovementPayrollTx(tx,employmentId,message=>new Error(message));
 const method=await employmentPaymentMethodOnTx(tx,employmentId,asOf);
 await tx.update(employment).set({paymentMethod:method}).where(eq(employment.id,employmentId));
 const {appendEvent,actorOf}=await import('../db/events');
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment',aggregateId:employmentId,eventType:'employment.payment-method.projected',actor:actorOf(ctx),subjectEmploymentId:employmentId,payload:{asOf,paymentMethod:method,source:'dated-history'}});
 return true;
}
