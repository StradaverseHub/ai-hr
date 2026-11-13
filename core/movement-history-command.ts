/**
 * Board 154511c4 — New Event's "Record history": HR names a comparison event type, its effective date and what
 * the employee had BEFORE that date; the After side is what is on record on the date. The same writer as the
 * Movement import (core/movement-history.ts) checks and writes it, in one tenant transaction under the same
 * locks the company leg of an Entity Transfer takes.
 */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import {isComparisonKind} from './movement-kinds';
import {resolveMovementEventTypeTx} from './movement-type';
import {HISTORY_FIELDS,MovementHistoryError,historyVersionsTx,recordHistoryMovementTx,type HistoryField,type HistoryValues} from './movement-history';

export async function recordHistoryMovement(ctx:SessionContext,p:{employmentId:string;typeCode:string;effectiveDate:string;before:Record<string,string|null>;remarks?:string|null}){
 const fields=Object.keys(p.before);
 if(!fields.length||!fields.every(field=>(HISTORY_FIELDS as readonly string[]).includes(field)))throw new MovementHistoryError('movement_history_fields');
 return withTenant(ctx,async tx=>{
  await tx.execute(sql`select app.access_configuration_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
  const type=await resolveMovementEventTypeTx(tx,ctx.tenantId,p.typeCode);
  if(!type?.active||!isComparisonKind(type.behaviourKind))throw new MovementHistoryError('movement_history_fields');
  const versions=await historyVersionsTx(tx,p.employmentId);
  const on=versions.find(v=>v.validFrom<=p.effectiveDate&&(v.validTo===null||v.validTo>p.effectiveDate));
  if(!on)throw new MovementHistoryError('movement_history_no_period');
  const after=Object.fromEntries(fields.map(field=>[field,on[field as HistoryField]??null])) as HistoryValues;
  return recordHistoryMovementTx(tx,ctx,{employmentId:p.employmentId,kind:type.behaviourKind,typeCode:type.code,effectiveDate:p.effectiveDate,after,before:p.before as HistoryValues,remarks:p.remarks??null});
 });
}
