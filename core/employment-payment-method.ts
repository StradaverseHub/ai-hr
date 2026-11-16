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
