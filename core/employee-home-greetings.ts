/** Explicit own-Home command adapter. SQL owns actual identity/cohort/privacy and transaction-bound
 * delivery admission; the notification owner projects only generic copy. No event contains a message. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {requireOwnHomeSubject} from './employee-home';
import {assertModuleEnabled} from './entitlements';
import {projectHomeGreetingInTx} from './notifications';
import {validateHomeGreetingCommand,validateHomeGreetingReceipt,validateHomeGreetingView} from '../lib/employee-home-greeting';

export async function sendHomeGreeting(ctx:SessionContext,raw:unknown){
 const command=validateHomeGreetingCommand(raw);
 await requireOwnHomeSubject(ctx,command.employmentId);
 assertModuleEnabled(ctx,'notifications');
 return withTenant(ctx,async tx=>{
  const [row]=await tx.execute<{receipt:unknown}>(sql`SELECT app.home_greeting_send_begin(${command.employmentId}::uuid,
   ${command.recipientEmploymentId}::uuid,${command.kind},${command.occurrenceDate}::date,${command.nonce}::uuid,${command.message}) AS receipt`);
  const receipt=validateHomeGreetingReceipt(row?.receipt,command);
  if(receipt.state==='sent')await projectHomeGreetingInTx(tx,receipt.greetingId);
  return receipt;
 });
}
export async function readHomeGreeting(ctx:SessionContext,employmentId:string,greetingId:string){
 const subject=await requireOwnHomeSubject(ctx,employmentId);
 if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(greetingId))throw Error('Greeting unavailable');
 return withTenant(ctx,async tx=>{
  const [row]=await tx.execute<{projection:unknown}>(sql`SELECT app.home_greeting_read(${subject.employmentId}::uuid,${greetingId}::uuid) AS projection`);
  return validateHomeGreetingView(row?.projection,{employmentId:subject.employmentId,greetingId});
 });
}
