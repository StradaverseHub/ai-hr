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
import { and, eq, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { employment, reportingLine } from '../db/schema';
import {AssignedWorkPrincipalUnavailableError} from '../lib/assigned-work';

/** Task metadata is not an approval capability. Recheck actual login/claims and any JS person binding
 * before asking the canonical current-decision guard; broader HR visibility is not an own identity.
 */
export async function assertAssignedWorkPrincipalTx(tx:Tx,ctx:SessionContext){
 const [proof]=await tx.execute(assignedWorkPrincipalSql(ctx)) as unknown as {ok:boolean}[];
 if(!ctx.userId||!proof?.ok)throw new AssignedWorkPrincipalUnavailableError();
}
/** The statement assertAssignedWorkPrincipalTx sends (a request preamble answers it ahead, decision 12). */
export function assignedWorkPrincipalSql(ctx:SessionContext){
 return sql`SELECT (app.principal_snapshot_current()
  AND (${ctx.personId??null}::uuid IS NULL OR app.is_self_person(${ctx.personId??null}::uuid))) AS ok`;
}

/** Only this gate's explicit authority refusals may be omitted from an actionable read. Database,
 * configuration and unknown-subject failures must propagate rather than masquerading as no tasks. */
export function isApprovalDecisionRefusal(error:unknown,label:string):boolean{
 return error instanceof Error&&error.constructor===Error&&[
  `You cannot decide your own ${label}`,
  `Only an admin or the administrative manager can decide this ${label}`,
 ].includes(error.message);
}

/** Whole-stack review H4: the subject lookup assertCanDecide makes, for many employments in one statement. Each
 * per-row statement pays the employment RLS policy setup again (about 165 ms at 2000 employments). */
export async function subjectPersonIdsTx(tx:Tx,employmentIds:readonly string[]):Promise<ReadonlyMap<string,string>>{
 if(!employmentIds.length)return new Map();
 const rows=await tx.select({id:employment.id,personId:employment.personId}).from(employment).where(inArray(employment.id,[...employmentIds]));
 return new Map(rows.map(row=>[row.id,row.personId]));
}
/** assertCanDecide's first two rules for a subject whose person is already known: 'refused' for self-approval
 * (not a super_admin), 'allowed' for an admin role, and null when the remaining rules (administrative manager,
 * delegation) must run through assertCanDecide itself. Same rules, same order; it decides nothing else. */
export function decideByRoleForKnownSubject(ctx:SessionContext,subjectPersonId:string|undefined):'allowed'|'refused'|null{
 const roles=ctx.roles??[],isSuperAdmin=roles.includes('super_admin'),isAdminRole=isSuperAdmin||roles.includes('hr_admin');
 if(ctx.personId!=null&&subjectPersonId===ctx.personId&&!isSuperAdmin)return 'refused';
 return isAdminRole&&subjectPersonId!==undefined?'allowed':null;
}

export async function assertCanDecide(
  tx: Tx,
  ctx: SessionContext,
  subjectEmploymentId: string,
  label: string,
  // R44 delegation (Phase 2): the module/task this decision belongs to. When supplied, a SCOPED delegation
  // only authorises the delegate if it covers this (module, taskType) — a whole-scope (no scope rows)
  // delegation still covers everything. When OMITTED (legacy callers: profile, performance, …) the
  // 1-arg helper runs → whole-scope behaviour, unchanged.
  scope?: { module: string; taskType: string },
): Promise<void> {
  const [subject] = await tx
    .select({ personId: employment.personId })
    .from(employment)
    .where(eq(employment.id, subjectEmploymentId))
    .limit(1);
  const roles = ctx.roles ?? [];
  const isSuperAdmin = roles.includes('super_admin');
  const isAdminRole = isSuperAdmin || roles.includes('hr_admin');
  const isSelf = ctx.personId != null && subject?.personId === ctx.personId;
  // Self-approval ban (task #84) — preserved against the SUBJECT. A delegate who is themselves the
  // subject (or routed into their own approval chain) is still blocked below by this guard, never
  // re-opened by the delegation branch.
  if (isSelf && !isSuperAdmin) throw new Error(`You cannot decide your own ${label}`);
  if (isAdminRole) return;
  const mgr = ctx.personId
    ? await tx
        .select({ id: reportingLine.id })
        .from(reportingLine)
        .innerJoin(employment, eq(employment.id, reportingLine.managerEmploymentId))
        .where(
          and(
            eq(reportingLine.subordinateEmploymentId, subjectEmploymentId),
            eq(reportingLine.lineType, 'administrative'),
            // The line must be in its effective window NOW — not future-dated, not ended. Matches
            // currentAdminManager (perf spawn); previously this checked only isNull(validTo), so a
            // not-yet-effective or future-ending line could authorise a decision.
            lte(reportingLine.validFrom, sql`current_date`),
            or(isNull(reportingLine.validTo), sql`${reportingLine.validTo} > current_date`),
            isNull(reportingLine.supersededAt),
            eq(employment.personId, ctx.personId),
          ),
        )
        .limit(1)
    : [];
  if (mgr.length > 0) return;

  // Delegation branch (ADR-0052 Step 4): the caller is a valid decider if an ACTIVE `delegate` edge
  // names them as the delegate AND the delegator is the subject's CURRENT direct administrative manager —
  // re-validated at decision time (not merely at create time), window covering current_date, delegator
  // still live, ONE hop only (no transitive chaining). This is encoded once in the SECURITY-DEFINER
  // helper app.can_decide_via_delegation, which we reuse here: the delegate cannot SEE the delegator's
  // employment under RLS (no visibility inheritance), so an in-statement join through `employment` would
  // be wrongly filtered — the definer helper resolves it without leaking visibility. The self-ban above
  // already blocked a delegate who is the subject.
  //
  // R51 (baf56348, migration 0286): ALWAYS the 3-arg overload. NULL module/task = no module filter
  // (byte-identical to the old 1-arg decide behaviour), so the legacy scope-less callers (profile,
  // performance, offboarding, employment review — travel was one until b833a077/r362 removed it) keep
  // their whole-scope semantics — while the new ORG gate
  // inside the function now applies to every decide path through this one chokepoint.
  if (ctx.personId) {
    const res = scope
      ? await tx.execute(
          sql`SELECT app.can_decide_via_delegation(${subjectEmploymentId}, ${scope.module}, ${scope.taskType}) AS ok`,
        )
      : await tx.execute(sql`SELECT app.can_decide_via_delegation(${subjectEmploymentId}, NULL, NULL) AS ok`);
    const ok = (res as unknown as { ok: boolean }[])[0]?.ok;
    if (ok) return;
  }
  throw new Error(`Only an admin or the administrative manager can decide this ${label}`);
}

/** SQL twins of the two guards above, for the one-statement Home task read (core/account-task-bundle.ts). Each is
 * the same rule in the same order, evaluated in the caller's own session, so every table read keeps the caller's
 * row-level security exactly as the TypeScript guard's statements do. A comparison the guard makes in JavaScript
 * (the subject's person against ctx.personId) compares text here; one the guard sends to SQL stays a SQL comparison.
 * The role facts come from ctx, as in the guards. test/performance/home-manager-card-reads.test.ts proves both
 * equal per fixture person. */
function decisionRoles(ctx:SessionContext){
 const roles=ctx.roles??[],superAdmin=roles.includes('super_admin');
 return {superAdmin,admin:superAdmin||roles.includes('hr_admin'),person:ctx.personId??null};
}
/** The caller's own employments visible under the caller's row-level security: the one set every "is this employment
 * the caller's person" test below reads (assertCanDecide's subject lookup, the administrative manager's person). A
 * statement reads it once (core/account-task-bundle.ts passes it to every section as `own`); without `own` each test
 * reads the employment row itself, as before. Membership in this set is exactly that row test: the same rows, the same
 * policy, the same person comparison. */
export function callerOwnEmploymentIdsSql(ctx:SessionContext):SQL{
 const person=ctx.personId??null;
 return person!=null?sql`array(select caller_own.id from public.employment caller_own where caller_own.person_id::text=${person}::text)`:sql`array[]::uuid[]`;
}
/** Whether `employment` is one of the caller's own (see callerOwnEmploymentIdsSql), never null. */
export function isCallerOwnEmploymentSql(ctx:SessionContext,employment:SQL,own?:SQL):SQL{
 const person=ctx.personId??null;
 if(person==null)return sql`false`;
 return own?sql`coalesce(${employment}=any(${own}),false)`
  :sql`exists(select 1 from public.employment caller_person where caller_person.id=${employment} and caller_person.person_id::text=${person}::text)`;
}
/** assertCanDecide's self ban: the RLS-visible subject row belongs to ctx.personId (never for a super_admin). */
export function decideSelfSql(ctx:SessionContext,subject:SQL,own?:SQL):SQL{
 const {superAdmin,person}=decisionRoles(ctx);
 if(person==null||superAdmin)return sql`false`;
 return own?isCallerOwnEmploymentSql(ctx,subject,own)
  :sql`exists(select 1 from public.employment decide_self where decide_self.id=${subject} and decide_self.person_id::text=${person}::text)`;
}
const currentAdministrativeManagerSql=(subject:SQL,person:string,own?:SQL)=>own?sql`exists(select 1 from public.reporting_line decide_line
 where decide_line.subordinate_employment_id=${subject} and decide_line.line_type='administrative'
  and decide_line.valid_from<=current_date and (decide_line.valid_to is null or decide_line.valid_to>current_date)
  and decide_line.superseded_at is null and decide_line.manager_employment_id=any(${own}))`:sql`exists(select 1 from public.reporting_line decide_line
 join public.employment decide_manager on decide_manager.id=decide_line.manager_employment_id
 where decide_line.subordinate_employment_id=${subject} and decide_line.line_type='administrative'
  and decide_line.valid_from<=current_date and (decide_line.valid_to is null or decide_line.valid_to>current_date)
  and decide_line.superseded_at is null and decide_manager.person_id=${person}::uuid)`;
/** assertCanDecide as a boolean: true where the guard returns, false where it throws one of its two refusals. `self`: the
 * subject's decideSelfSql, when the caller has already read it once for this subject; `own`: callerOwnEmploymentIdsSql. */
export function canDecideSql(ctx:SessionContext,subject:SQL,scope?:{module:string|SQL;taskType:string|SQL},self?:SQL,own?:SQL):SQL{
 const {admin,person}=decisionRoles(ctx),selfSql=self??decideSelfSql(ctx,subject,own);
 if(admin)return sql`(not ${selfSql})`;
 if(!person)return sql`false`;
 return sql`(not ${selfSql} and (${currentAdministrativeManagerSql(subject,person,own)}
  or coalesce(app.can_decide_via_delegation(${subject},${scope?.module??null}::text,${scope?.taskType??null}::text),false)))`;
}
/** decisionEmploymentAuthorityTx's `allowed` membership for one subject. The delegated set is one InitPlan per statement. */
export function decisionEmploymentAuthoritySql(ctx:SessionContext,subject:SQL,scope?:{module:string;taskType:string},own?:SQL):SQL{
 const {admin,person}=decisionRoles(ctx),self=decideSelfSql(ctx,subject,own);
 if(admin)return sql`(not ${self})`;
 if(!person)return sql`false`;
 return sql`(not ${self} and (${currentAdministrativeManagerSql(subject,person,own)}
  or ${subject}=any(cast((select app.delegated_subject_ids(${scope?.module??null}::text,${scope?.taskType??null}::text)) as uuid[]))))`;
}

/** Current authority for a bounded batch of read-only task subjects. */
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
  // The native set used by Claim RLS evaluates the same current direct-manager,
  // one-hop and module/organisation predicates as the scalar command owner.
  const rows=await tx.execute<{id:string}>(sql`select subject.id
   from unnest(app.delegated_subject_ids(${scope?.module??null},${scope?.taskType??null})) as subject(id)
   where subject.id=any(array[${sql.join(delegated.map(id=>sql`${id}::uuid`),sql`,`)}]::uuid[])`);
  for(const row of rows)allowed.add(row.id);
 }
 return {allowed,self};
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
