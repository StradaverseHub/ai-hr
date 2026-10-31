/** Native Family preview owner. Every invoked writer is transaction-local when outerTx is supplied:
 * dependent row/event + SQL family relief row/event. No provider, outbox, notification or independent
 * transaction is invoked. Preview rolls every write back; final execution belongs to the outer tx. */
import {and,eq,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {employeeDependent,employeeStatutoryMy} from '../db/schema';
import {addDependent,updateDependent,archiveDependent} from './dependents';
import {assertWorkforcePersonTx} from './workforce-access';
import {FamilyMaintenance as C,type FamilyMaintenanceHuman as Human} from '../lib/assistant-actions/family-maintenance-contract';
const fields=(row:Record<string,unknown>)=>C.Fields.parse(Object.fromEntries(Object.keys(C.Fields.shape).map(key=>[key,row[key]])));
export async function dependentReviewRowsTx(tx:Tx,personId:string){
 const rows=await tx.execute<{id:string;revision:string}>(sql`select id,xmin::text as revision from employee_dependent where tenant_id=app.current_tenant_id() and person_id=${personId}::uuid order by id limit 101`);
 if(rows.length>100)throw new Error('Please use the native Family register for this record count.');
 const data=await tx.select().from(employeeDependent).where(eq(employeeDependent.personId,personId));
 return rows.map(row=>{const value=data.find(r=>r.id===row.id);if(!value)throw new Error('Family source unavailable');return{id:row.id,revision:row.revision,archived:value.archivedAt!==null,fields:fields(value)};});
}
export async function previewDependentCommandTx(tx:Tx,ctx:SessionContext,human:Human){
 await assertWorkforcePersonTx(tx,ctx,human.subjectId,'maintain');
 // Acquire the native config + existing row/person/stat/payroll locks in the enclosing transaction.
 const [context]=await tx.execute<{digest:string}>(sql`select app.assistant_family_maintenance_context(${human.employmentId}::uuid) as digest`);
 // Read only the three relief fields through CURRENT native statutory RLS, never via the definer.
 const [statutoryBefore]=await tx.select({numChildren:employeeStatutoryMy.numChildren,childReliefMode:employeeStatutoryMy.childReliefMode,childReliefTable:employeeStatutoryMy.childReliefTable}).from(employeeStatutoryMy).where(and(eq(employeeStatutoryMy.personId,human.subjectId),sql`app.is_admin() and app.principal_snapshot_current() and app.can_see_person(${human.subjectId}::uuid)`));
 const before=await dependentReviewRowsTx(tx,human.subjectId),existing=before.find(row=>row.id===human.dependentId&&!row.archived);
 if(human.operation!=='add'&&!existing)throw new Error('Family record unavailable');
 const [boundary]=await tx.execute<{sequence:string}>(sql`select coalesce(max(sequence),0)::text as sequence from domain_event where tenant_id=${ctx.tenantId}::uuid`);
 await tx.execute(sql`savepoint assistant_family_preview`);
 try{
  const native=human.operation==='add'?await addDependent(ctx,{personId:human.subjectId,...human.fields!},tx):human.operation==='update'?await updateDependent(ctx,{id:human.dependentId!,...human.fields!},tx):await archiveDependent(ctx,{id:human.dependentId!},tx);
  const [row]=await tx.select().from(employeeDependent).where(and(eq(employeeDependent.id,native.id),eq(employeeDependent.personId,human.subjectId)));
  if(!row)throw new Error('Family preview unavailable');
  const changes=await tx.execute<{before:unknown;after:unknown}>(sql`select payload->'before' as before,payload->'after' as after from domain_event where tenant_id=${ctx.tenantId}::uuid and sequence>${boundary.sequence}::bigint and aggregate_type='employee-statutory' and event_type='employee.tax.updated' and payload->>'personId'=${human.subjectId} and payload->>'provenance'='auto_child_relief' and actor_id=${ctx.userId}::uuid`);
  if(native.childReliefSync.changed&&(!statutoryBefore||JSON.stringify(C.ReliefValues.parse(changes[0]?.before))!==JSON.stringify(C.ReliefValues.parse(statutoryBefore))))throw new Error('Use the native HR screen: automatic relief cannot be reviewed with current field access.');
  if(changes.length!==(native.childReliefSync.changed?1:0))throw new Error('Family consequence unavailable');
  const result={before:existing?.fields??null,after:human.operation==='archive'?null:fields(row),relief:C.Relief.parse({...native.childReliefSync,values:changes[0]??null}),sources:before,contextDigest:context.digest};
  await tx.execute(sql`rollback to savepoint assistant_family_preview`);await tx.execute(sql`release savepoint assistant_family_preview`);return result;
 }catch(error){await tx.execute(sql`rollback to savepoint assistant_family_preview`);await tx.execute(sql`release savepoint assistant_family_preview`);throw error;}
}
