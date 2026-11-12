import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {lockLeaveDependencyConfigurationTx,lockLeaveDependenciesWaitTx} from './leave-dependency-lock';
import {isCarrierPrincipalCurrentTx} from './carrier-principal';
import {acquireBoundedAdvisoryLockTx,lockAccessConfigurationTx} from './access-configuration-lock';
import {lockPayrollInputsTx} from './payroll-inputs-lock';
/** Native callers keep their existing RLS/field-owner authority. This interval creates no marker,
 * role or table grant. Null-user provisioning keeps its original SYSTEM semantics. */
export const captureStatutorySourceContext=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
/** The person (or, for an employment-scoped tax selection, the employment) whose statutory facts a native
 * writer changes. */
export type StatutorySubject=Readonly<{personId?:string|null;employmentId?:string|null}>;
const uuidText=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** NATIVE statutory writers (profile, tax selection, hire/transfer initialization, TP3, split cards).
 * A USER carrier must pass the shared ordinary principal proof under the barrier: every claimed role/grant
 * actually held now (a stale or forged role string is refused), and a personId only when the context
 * supplies one. Otherwise the writer's existing RLS, field-owner and own-identity checks stay the authority
 * and keep their outcomes (not_found etc.).
 *
 * With a subject (reader/writer wave 4) the interval is narrowed to what it protects:
 * - the SHARED Access lock, so statutory writers for different people (an employee import writes one per
 *   row) overlap each other and only an access configuration editor or a reviewed (Assistant custody)
 *   owner, which holds it exclusively, excludes them;
 * - the leave-dependency configuration lock in SHARED mode, waiting with the bound. Statutory values feed
 *   no leave cohort; the lock only keeps a configuration editor out, so taking it exclusively on every
 *   import row refused concurrent leave and statutory writers as busy for nothing;
 * - the payroll inputs key of every company employing the subject, so a change waits for an in-flight
 *   run instead of landing behind it unmarked;
 * - one subject lock, which serialises writers of the same person's statutory row (several setters
 *   read the current row and write it back whole).
 * Without a subject (bulk operator corrections) the interval stays exclusive, exactly as before. */
export async function lockStatutorySourceTx(tx:Tx,ctx:SessionContext,subject?:StatutorySubject){
 ctx=captureStatutorySourceContext(ctx);
 const personId=typeof subject?.personId==='string'&&uuidText.test(subject.personId)?subject.personId.toLowerCase():null;
 const employmentId=typeof subject?.employmentId==='string'&&uuidText.test(subject.employmentId)?subject.employmentId.toLowerCase():null;
 if(!personId&&!employmentId){
  await tx.execute(sql`select app.access_configuration_write_lock()`);
  if(ctx.userId&&!(await isCarrierPrincipalCurrentTx(tx,ctx)))throw new Error('Statutory authority unavailable');
  await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
  return;
 }
 await lockAccessConfigurationTx(tx,ctx.tenantId);
 // Same barrier rows as the exclusive interval (a stale REPEATABLE READ writer still refuses), shared.
 await tx.execute(sql`select app.access_workforce_write_lock()`);
 if(ctx.userId&&!(await isCarrierPrincipalCurrentTx(tx,ctx)))throw new Error('Statutory authority unavailable');
 await lockLeaveDependenciesWaitTx(tx,ctx.tenantId,[]);
 await lockPayrollInputsTx(tx,{personId,employmentIds:employmentId?[employmentId]:[]});
 let owner=personId;
 if(!owner&&employmentId){const [row]=await tx.execute<{personId:string}>(sql`select person_id::text as "personId" from public.employment where id=${employmentId}::uuid and tenant_id=${ctx.tenantId}::uuid`);owner=row?.personId??null;}
 const tenant=ctx.tenantId.toLowerCase();
 await acquireBoundedAdvisoryLockTx(tx,owner?`statutory-subject:${tenant}:person:${owner}`:`statutory-subject:${tenant}:employment:${employmentId}`,false);
}
/** REVIEWED (Assistant custody) statutory owners: the same interval, but a USER carrier must still match
 * the actual current principal before any protected stored/default/epoch read. Exclusive: custody reads
 * stored facts and defaults across the subject's records and must exclude every native writer. */
export async function lockReviewedStatutorySourceTx(tx:Tx,ctx:SessionContext){
 ctx=captureStatutorySourceContext(ctx);
 await tx.execute(sql`select app.access_configuration_write_lock()`);
 if(ctx.userId){const [principal]=await tx.execute<{ok:boolean}>(sql`select app.current_tenant_id()=${ctx.tenantId}::uuid and app.current_user_id()=${ctx.userId}::uuid and exists(select 1 from public.app_user u where u.id=${ctx.userId}::uuid and u.tenant_id=${ctx.tenantId}::uuid and u.person_id is not distinct from ${ctx.personId??null}::uuid and u.archived_at is null and not app.login_blocked(u.id)) and app.principal_snapshot_current() as ok`);if(principal?.ok!==true)throw new Error('Statutory authority unavailable');}
 await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
}
