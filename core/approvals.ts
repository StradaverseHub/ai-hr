/**
 * Shared approval authorization (used by leave + attendance corrections).
 *
 * RLS already controls *visibility* (an employee can read their own rows, a manager
 * their reports', an admin everything), and it makes self rows *writable* — so the
 * decide path must add the policy guard the database can't express:
 *   - no self-approval (super_admin keeps a sole-admin escape hatch for tiny firms);
 *   - only an admin or the subject's *active administrative* manager may decide.
 * Every decision is still evented with the real actor.
 */
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { employment, reportingLine } from '../db/schema';
import {AssignedWorkPrincipalUnavailableError} from '../lib/assigned-work';

/** Task metadata is not an approval capability. Recheck actual login/claims and any JS person binding
 * before asking the canonical current-decision guard; broader HR visibility is not an own identity.
 */
export async function assertAssignedWorkPrincipalTx(tx:Tx,ctx:SessionContext){
 const [proof]=await tx.execute(sql`SELECT (app.principal_snapshot_current()
  AND (${ctx.personId??null}::uuid IS NULL OR app.is_self_person(${ctx.personId??null}::uuid))) AS ok`) as unknown as {ok:boolean}[];
 if(!ctx.userId||!proof?.ok)throw new AssignedWorkPrincipalUnavailableError();
}

/** Only this gate's explicit authority refusals may be omitted from an actionable read. Database,
 * configuration and unknown-subject failures must propagate rather than masquerading as no tasks. */
export function isApprovalDecisionRefusal(error:unknown,label:string):boolean{
 return error instanceof Error&&error.constructor===Error&&[
  `You cannot decide your own ${label}`,
  `Only an admin or the administrative manager can decide this ${label}`,
 ].includes(error.message);
}

/** The same canonical guard supports one command or a metadata batch. Authority is recomputed
 * in the caller's transaction on every call; no permission result survives this invocation. */
export async function decisionEmploymentAuthorityTx(
 tx:Tx,ctx:SessionContext,employmentIds:readonly string[],scope?:{module:string;taskType:string},
):Promise<{allowed:Set<string>;self:Set<string>}>{
 const allowed=new Set<string>(),self=new Set<string>(),ids=[...new Set(employmentIds)];
 const roles=ctx.roles??[],superAdmin=roles.includes('super_admin'),admin=superAdmin||roles.includes('hr_admin');
 for(let offset=0;offset<ids.length;offset+=1000){
  const chunk=ids.slice(offset,offset+1000);
  const subjects=await tx.select({id:employment.id,personId:employment.personId}).from(employment).where(inArray(employment.id,chunk));
  if(ctx.personId!=null&&!superAdmin)for(const subject of subjects)if(subject.personId===ctx.personId)self.add(subject.id);
  const candidates=chunk.filter(id=>!self.has(id));if(!candidates.length)continue;
  if(admin){candidates.forEach(id=>allowed.add(id));continue;}
  if(!ctx.personId)continue;
  // Identical current administrative-manager predicates to the scalar command guard.
  const managers=await tx.selectDistinct({id:reportingLine.subordinateEmploymentId}).from(reportingLine)
   .innerJoin(employment,eq(employment.id,reportingLine.managerEmploymentId)).where(and(
    inArray(reportingLine.subordinateEmploymentId,candidates),eq(reportingLine.lineType,'administrative'),
    lte(reportingLine.validFrom,sql`current_date`),or(isNull(reportingLine.validTo),sql`${reportingLine.validTo}>current_date`),
    isNull(reportingLine.supersededAt),eq(employment.personId,ctx.personId),
   ));
  managers.forEach(row=>allowed.add(row.id));
  const delegated=candidates.filter(id=>!allowed.has(id));if(!delegated.length)continue;
  // Always the canonical three-argument owner: current direct manager, active one-hop edge,
  // optional task/module coverage and delegation org coverage. Self remains excluded above.
  const rows=await tx.execute(sql`select subject.id,app.can_decide_via_delegation(subject.id,${scope?.module??null},${scope?.taskType??null}) as ok
   from (values ${sql.join(delegated.map(id=>sql`(${id}::uuid)`),sql`,`)}) as subject(id)`);
  for(const row of rows as unknown as {id:string;ok:boolean}[])if(row.ok)allowed.add(row.id);
 }
 return {allowed,self};
}

export async function assertCanDecide(tx:Tx,ctx:SessionContext,subjectEmploymentId:string,label:string,scope?:{module:string;taskType:string}):Promise<void>{
 const authority=await decisionEmploymentAuthorityTx(tx,ctx,[subjectEmploymentId],scope);
 if(authority.self.has(subjectEmploymentId))throw new Error(`You cannot decide your own ${label}`);
 if(!authority.allowed.has(subjectEmploymentId))throw new Error(`Only an admin or the administrative manager can decide this ${label}`);
}

/**
 * R51 (baf56348) — org-scope filter for the DELEGATE-facing pending lists (leave / attendance corrections /
 * claims). RLS row visibility deliberately stays unchanged (the 1-arg visibility form is untouched — 0230's
 * precedent of authority being narrower than visibility), so a delegation-routed row is still READABLE; this
 * app-level predicate keeps it OUT of the approver's to-do list when the subject sits outside the
 * delegation's org coverage, so the stand-in is never teased with items they cannot act on. Rows the caller
 * can see in their OWN right (self / admin downline / admin role) always pass. The decide-time guard remains
 * the backstop for a raced decide.
 */
export async function filterDelegationOrgScopeTx<T>(
  tx: Tx,
  ctx: SessionContext,
  rows: T[],
  subjectOf: (row: T) => string,
): Promise<T[]> {
  const roles = ctx.roles ?? [];
  if (rows.length === 0 || roles.includes('hr_admin') || roles.includes('super_admin')) return rows;
  const ids = [...new Set(rows.map(subjectOf))];
  // One round trip; each id bound as its own parameter (VALUES list — no array-binding dependency).
  const res = await tx.execute(sql`
    SELECT s.id AS id,
           app.can_see_employment(s.id) AS visible,
           app.can_decide_via_delegation(s.id, NULL, NULL) AS del_ok
    FROM (VALUES ${sql.join(ids.map((i) => sql`(${i}::uuid)`), sql`, `)}) AS s(id)
  `);
  const allowed = new Set(
    (res as unknown as { id: string; visible: boolean; del_ok: boolean }[])
      .filter((r) => r.visible || r.del_ok)
      .map((r) => r.id),
  );
  return rows.filter((r) => allowed.has(subjectOf(r)));
}
