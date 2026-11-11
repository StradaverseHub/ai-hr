import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';
import {accessLockModeHeldTx,acquireBoundedAdvisoryLockTx,inAccessDisplayRead,lockAccessConfigurationTx,lockAccessConfigurationWriteTx,lockProfileSubjectTx,lockProfileValueSharedTx,lockProfileValueWritesTx} from './access-configuration-lock';
import {LeaveDependencyUnavailable,lockLeaveDependenciesTx,lockLeaveDependenciesWaitTx,lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import {pgSqlState} from '../lib/db-error';

/**
 * Reader/writer Access lock, people and workforce wave (design mechanism C, 10 November 2026).
 *
 * Shared Workforce helpers (the Workforce authority checks, borrowed Personnel reads) are reached both from
 * converted writers, which hold the shared Access lock, and from writers that still need the exclusive lock.
 * A transaction that already holds the shared lock is an ordinary writer: it joins in shared mode and never
 * asks for the exclusive lock later, so it can never wait to upgrade behind another shared holder. Every other
 * transaction, including one that holds nothing yet, keeps the exclusive lock exactly as before. Callers that
 * want shared mode take lockAccessConfigurationTx first; nothing here makes an unconverted caller shared.
 */
export async function joinAccessConfigurationTx(tx:Tx,tenantId:string):Promise<'S'|'X'>{
 // A display read and a read-only transaction never need the exclusive lock (staging, 11 November 2026).
 const [held]=await tx.execute<{mode:'X'|'S'|null;read_only:boolean}>(sql`select app.access_lock_mode_held(${tenantId}::uuid) as mode,
  current_setting('transaction_read_only')='on' as read_only`);
 if(held?.mode==='S'||held?.mode!=='X'&&(held?.read_only===true||inAccessDisplayRead())){await lockAccessConfigurationTx(tx,tenantId);return 'S';}
 await lockAccessConfigurationWriteTx(tx,tenantId);
 return 'X';
}

/** The SQL workforce barrier in the mode this transaction holds: shared for a shared holder, otherwise the
 * exclusive editor barrier (which also pins the policy generation and configuration rows) as before. */
export async function joinWorkforceBarrierTx(tx:Tx,tenantId:string):Promise<void>{
 await tx.execute(sql`select case when app.access_lock_mode_held(${tenantId}::uuid)='S'
  then app.access_workforce_write_lock() else app.access_configuration_write_lock() end`);
}

/**
 * Leave-dependency locks for a writer of one or more employments' leave-relevant facts. `configuration` marks a
 * writer that took the configuration lock exclusively before the reader/writer lock (grade, company, dated
 * assignment, employment dates, reporting lines, termination, person master values): those facts select leave
 * cohorts and approvers, so a configuration-read interval (cohort or target discovery) must still exclude them.
 *
 * Under the shared Access lock the writer WAITS, with the Access bound, for the same locks: exclusive configuration
 * when `configuration` is set, otherwise shared configuration, and then each employment. Writers no longer meet on
 * the exclusive Access lock, so a no-wait refusal would turn two HR edits at the same moment into a false busy.
 * A transaction that holds the exclusive Access lock keeps exactly the no-wait locks it took before.
 */
export async function lockEmploymentLeaveDependenciesTx(tx:Tx,tenantId:string,employmentIds:readonly string[],options:{configuration:boolean}):Promise<void>{
 if(await accessLockModeHeldTx(tx,tenantId)==='S'){
  if(options.configuration)await lockLeaveConfigurationExclusiveWaitTx(tx,tenantId);
  await lockLeaveDependenciesWaitTx(tx,tenantId,employmentIds);
  return;
 }
 if(options.configuration)await lockLeaveDependencyConfigurationTx(tx,tenantId);
 if(employmentIds.length)await lockLeaveDependenciesTx(tx,tenantId,employmentIds);
}

/** Exclusive leave-dependency configuration with the bounded wait, for a shared Access holder. Same carrier checks
 * as the leave-dependency owner; a reached bound is the existing busy refusal, with nothing written. Taken before
 * any shared configuration or employment lock, so the holder never upgrades its own configuration lock. */
async function lockLeaveConfigurationExclusiveWaitTx(tx:Tx,tenantId:string):Promise<void>{
 tenantId=tenantId.toLowerCase();
 const [carrier]=await tx.execute<{ok:boolean}>(sql`select app.current_tenant_id()=${tenantId}::uuid
  and current_setting('transaction_isolation')='read committed'
  and current_setting('transaction_read_only')='off' as ok`);
 if(carrier?.ok!==true)throw new LeaveDependencyUnavailable('busy');
 try{await acquireBoundedAdvisoryLockTx(tx,`leave-dependency-configuration:${tenantId}`,false);}
 catch(error){if(pgSqlState(error)==='55P03')throw new LeaveDependencyUnavailable('busy');throw error;}
}

/**
 * The tenant reporting-line serialiser from 5001 (org-reporting:<tenant>), taken explicitly and with the Access
 * bound. The reporting_line statement trigger takes the same key, but only at the write. A writer that reads the
 * reporting graph first (a cycle preflight, "is a newer line already open", which lines to reopen) takes it before
 * that read, so under the shared Access lock it sees every committed reporting-line change and gives the same
 * answer the exclusive lock used to. Lock order: Access, administrator guard, leave dependencies, this, then rows.
 */
export async function lockOrgReportingTx(tx:Tx,tenantId:string):Promise<void>{
 await acquireBoundedAdvisoryLockTx(tx,`org-reporting:${tenantId.toLowerCase()}`,false);
}

/**
 * Locks for a writer of one person's master values (name, contact, address, profile fields). Under the shared
 * Access lock: personal fields select leave cohorts, so the writer keeps the exclusive leave configuration lock it
 * always took (now waiting, bounded) and then each of the person's employments; the profile-policy lock is joined
 * in shared mode, so only a policy editor is excluded; and the
 * per-person profile lock serialises this person's row and registers (single primary emergency contact) against
 * the other per-person writers. Same order as the converted register writers. A transaction that holds the
 * exclusive lock keeps exactly the exclusive leave-configuration and profile-policy locks it took before.
 */
export async function lockPersonValueWritesTx(tx:Tx,tenantId:string,personId:string):Promise<void>{
 if(await accessLockModeHeldTx(tx,tenantId)!=='S'){
  await lockLeaveDependencyConfigurationTx(tx,tenantId);
  await lockProfileValueWritesTx(tx,tenantId);
  return;
 }
 const rows=await tx.execute<{id:string}>(sql`select e.id from public.employment e where e.person_id=${personId}::uuid and e.tenant_id=${tenantId}::uuid`);
 await lockEmploymentLeaveDependenciesTx(tx,tenantId,Array.from(rows,row=>row.id),{configuration:true});
 await lockProfileValueSharedTx(tx,tenantId);
 await lockProfileSubjectTx(tx,tenantId,personId);
}

/**
 * Locks for the Personnel maintenance command (core/workforce-maintenance.ts) on one employment's subject.
 * Under the shared Access lock: a qualification belongs to the employment and takes that employment's profile
 * lock, like the qualification register writer; a person's own fields feed leave cohorts and take the person's
 * value locks (lockPersonValueWritesTx); a family or emergency-contact row takes the person's profile lock, like
 * those register writers. The SQL command then joins the profile-policy lock in value mode (5005). A
 * transaction holding the exclusive lock keeps the exclusive Access and profile-policy locks it took before.
 */
export async function lockWorkforceRecordValueWritesTx(tx:Tx,tenantId:string,employmentId:string,kind:'person'|'qualification'|'emergency'|'dependent'):Promise<void>{
 if(await accessLockModeHeldTx(tx,tenantId)!=='S'){await lockProfileValueWritesTx(tx,tenantId);return;}
 if(kind==='qualification'){await lockProfileValueSharedTx(tx,tenantId);await lockProfileSubjectTx(tx,tenantId,employmentId);return;}
 const [subject]=await tx.execute<{personId:string}>(sql`select e.person_id::text as "personId" from public.employment e where e.id=${employmentId}::uuid and e.tenant_id=${tenantId}::uuid`);
 // An unavailable employment is refused by the command itself; it still joins the shared policy lock first.
 if(!subject){await lockProfileValueSharedTx(tx,tenantId);return;}
 if(kind==='person'){await lockPersonValueWritesTx(tx,tenantId,subject.personId);return;}
 await lockProfileValueSharedTx(tx,tenantId);
 await lockProfileSubjectTx(tx,tenantId,subject.personId);
}
