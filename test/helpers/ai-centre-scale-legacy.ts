/** VERBATIM REFERENCES of the owners this branch changed, as they stood at f7ee5177 (the deployed release), for the
 * equivalence test only (test/ai-centre-scale-equivalence.test.ts). Only imports and names differ: each is renamed legacy*
 * and imports the unchanged per-company helpers it called. Never imported by product code. */
import {and,desc,eq,gte,inArray,isNull,ne,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {appUser,company,employment,person} from '../../db/schema';
import {terasLoopAction,terasLoopActionUndo} from '../../db/teras-autonomy-schema';
import {isAdmin,isGroupAdmin} from '../../lib/authz-model';
import {isLoopId,type LoopId} from '../../core/loops/types';
import {SITE_EXIT_RECORDED,type AutonomyLevel} from '../../core/loops/autonomy-types';
import {PROMOTION_RULES,isCappedLoop,maxLevel,promotableTo,usesCondition,LOOP_AUTONOMY} from '../../core/loops/autonomy';
import {currentWeekStart,weeklySampleTx} from '../../core/loops/samples';
import {LOOP_IDS} from '../../core/loops/types';
import {latestLevelChangesTx,levelIn,loopLevelsTx} from '../../core/loops/levels';
import {LoopViewRefused} from '../../core/loops/views';
import type {AutonomyActionView,AutonomySample,LoopAutonomyDetail,LoopCompanyLevel,LoopLevelSummary} from '../../core/loops/autonomy-views';
import {acknowledgedBlocks} from '../../core/loops/grouped-dispositions';
import * as schema from '../../db/schema';
import type {OpenExceptionRow,QueueRow,SkippedDetector} from '../../core/payroll-anomaly';
import type {Disposition,Severity} from '../../core/payroll-anomaly-detectors';
import {GAP_BLOCKS,PEOPLE_PER_GAP,gapsForRecord,type ReadinessGap,type ReadinessGapId,type ReadinessInput,type ReadinessPerson,type ReadinessView,type ReadinessBlocks} from '../../core/record-readiness';

const DAY_MS=86_400_000;
const RECENT=20;
const requireAdmin=(ctx:SessionContext)=>{if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new LoopViewRefused('not_administrator');};

async function namesTx(tx:Tx,userIds:readonly string[]){
 if(!userIds.length)return new Map<string,string|null>();
 const rows=await tx.select({id:appUser.id,name:person.fullName}).from(appUser).leftJoin(person,eq(person.id,appUser.personId)).where(inArray(appUser.id,[...userIds]));
 return new Map(rows.map(row=>[row.id,row.name??null]));
}

export async function legacyLoopAutonomyDetail(ctx:SessionContext,workerId:unknown,options:Readonly<{now?:Date}>={}):Promise<LoopAutonomyDetail>{
 requireAdmin(ctx);
 if(!isLoopId(workerId))throw new LoopViewRefused('not_found');
 const now=options.now??new Date(),since=new Date(now.getTime()-PROMOTION_RULES.windowDays*DAY_MS);
 return withTenant(ctx,async tx=>{
  const companies=Array.from(await tx.execute(sql`select c.id,c.legal_name from public.company c where c.tenant_id=${ctx.tenantId}::uuid and app.is_admin_for(c.id)
   order by c.legal_name,c.id`) as unknown as {id:string;legal_name:string}[]);
  const levels=await loopLevelsTx(tx,ctx.tenantId,workerId);
  const changes=await latestLevelChangesTx(tx,ctx.tenantId,workerId,companies.map(item=>item.id));
  const names=await namesTx(tx,[...new Set([...levels.values()].flatMap(row=>[row.changedByUserId,row.conditionSetByUserId].filter((id):id is string=>!!id)))]);
  const select=()=>tx.select({id:terasLoopAction.id,at:terasLoopAction.createdAt,personName:person.fullName,personId:employment.personId,companyName:company.legalName,
   state:terasLoopAction.state,reason:terasLoopAction.reason,facts:terasLoopAction.facts,employmentId:terasLoopAction.employmentId,undoUntil:terasLoopAction.undoUntil,peopleChangedAt:terasLoopAction.peopleChangedAt,
   undoneBy:terasLoopActionUndo.undoneBy,undoneAt:terasLoopActionUndo.undoneAt,admin:sql<boolean>`app.can_admin_employment(${terasLoopAction.employmentId})`})
   .from(terasLoopAction).leftJoin(terasLoopActionUndo,eq(terasLoopActionUndo.actionId,terasLoopAction.id))
   .leftJoin(employment,eq(employment.id,terasLoopAction.employmentId)).leftJoin(person,eq(person.id,employment.personId))
   .leftJoin(company,eq(company.id,terasLoopAction.companyId));
  const rows=await select().where(and(eq(terasLoopAction.tenantId,ctx.tenantId),eq(terasLoopAction.workerId,workerId))).orderBy(desc(terasLoopAction.createdAt),desc(terasLoopAction.id)).limit(RECENT);
  const applied=await tx.select({undoneBy:terasLoopActionUndo.undoneBy,changedAt:terasLoopAction.peopleChangedAt}).from(terasLoopAction)
   .leftJoin(terasLoopActionUndo,eq(terasLoopActionUndo.actionId,terasLoopAction.id))
   .where(and(eq(terasLoopAction.tenantId,ctx.tenantId),eq(terasLoopAction.workerId,workerId),eq(terasLoopAction.state,'applied'),gte(terasLoopAction.appliedAt,since)));
  const corrected=applied.filter(row=>row.undoneBy!==null||row.changedAt!==null).length;
  const view=(row:(typeof rows)[number]):AutonomyActionView=>{
   const own=!!ctx.personId&&row.personId===ctx.personId;
   const undo=row.undoneBy&&row.undoneAt?Object.freeze({by:row.undoneBy,at:row.undoneAt}):null;
   return Object.freeze({id:row.id,at:row.at,personName:row.personName??null,companyName:row.companyName??null,state:row.state,reason:row.reason??null,facts:row.facts,
    undoUntil:row.undoUntil,undo,peopleChanged:row.peopleChangedAt!==null,
    ...(workerId==='loop_missed_clock_outs'&&row.admin===true&&typeof row.facts.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(row.facts.date)?{reviewHref:`/attendance/individual/${row.facts.date}?emp=${encodeURIComponent(row.employmentId)}`} : {}),
    canUndo:workerId!=='loop_missed_clock_outs'&&row.state==='applied'&&!undo&&now.getTime()<=row.undoUntil.getTime()&&row.admin===true&&!own});
  };
  // Level 3: each company's weekly sample, for HR to review instead of every action.
  const weekStart=currentWeekStart(now),samples:AutonomySample[]=[];
  for(const item of companies.filter(entry=>levelIn(levels,entry.id)===3)){
   const sample=await weeklySampleTx(tx,ctx.tenantId,workerId,item.id,weekStart);
   const sampled=sample.actionIds.length?await select().where(and(eq(terasLoopAction.tenantId,ctx.tenantId),inArray(terasLoopAction.id,[...sample.actionIds]))):[];
   const order=new Map(sample.actionIds.map((id,index)=>[id,index]));
   const reviewer=sample.reviewed?(await namesTx(tx,[sample.reviewed.byUserId])).get(sample.reviewed.byUserId)??null:null;
   samples.push(Object.freeze({companyId:item.id,companyName:item.legal_name,weekStart,total:sample.total,
    actions:Object.freeze(sampled.sort((a,b)=>(order.get(a.id)??0)-(order.get(b.id)??0)).map(view)),
    reviewed:sample.reviewed?Object.freeze({byName:reviewer,at:sample.reviewed.at,covered:sample.reviewed.actionIds.length}):null,canReview:sample.actionIds.length>0}));
  }
  return Object.freeze({workerId,maxLevel:maxLevel(workerId),promotableTo:promotableTo(workerId),capped:isCappedLoop(workerId),hasActor:LOOP_AUTONOMY[workerId].actor,
   canChange:isGroupAdmin(ctx),usesCondition:usesCondition(workerId),siteExitRecorded:SITE_EXIT_RECORDED,windowDays:PROMOTION_RULES.windowDays,
   companies:Object.freeze(companies.map(item=>{
    const row=levels.get(item.id),change=changes.get(item.id);
    return Object.freeze({companyId:item.id,companyName:item.legal_name,level:levelIn(levels,item.id),limits:row?.limits??null,changedAt:row?.changedAt??null,
     changedBy:row?.changedBy??null,changedByName:row?.changedByUserId?names.get(row.changedByUserId)??null:null,lastChange:change?.kind??null,
     conditionSetByName:row?.conditionSetByUserId?names.get(row.conditionSetByUserId)??null:null,conditionSetAt:row?.conditionSetAt??null});
   })),
   actions:Object.freeze(rows.map(view)),samples:Object.freeze(samples),
   figures:Object.freeze({applied:applied.length,corrected,undoneByEmployee:applied.filter(row=>row.undoneBy==='employee').length,
    correctedShare:applied.length>0?corrected/applied.length:null})});
 });
}

export async function legacyLoopLevelSummaries(ctx:SessionContext):Promise<Readonly<Record<LoopId,readonly LoopLevelSummary[]>>>{
 requireAdmin(ctx);
 return withTenant(ctx,async tx=>{
  const companies=Array.from(await tx.execute(sql`select c.id from public.company c where c.tenant_id=${ctx.tenantId}::uuid and app.is_admin_for(c.id)`) as unknown as {id:string}[]);
  const out={} as Record<LoopId,readonly LoopLevelSummary[]>;
  for(const id of LOOP_IDS){
   const levels=await loopLevelsTx(tx,ctx.tenantId,id),counts=new Map<AutonomyLevel,number>();
   for(const item of companies){const level=levelIn(levels,item.id);counts.set(level,(counts.get(level)??0)+1);}
   out[id]=Object.freeze([...counts].sort((a,b)=>b[0]-a[0]).map(([level,count])=>Object.freeze({level,count})));
  }
  return Object.freeze(out);
 });
}

/** Per loop, each company the viewer administers (by name) with the loop's level there; a company with no stored level
 * is at Prepare (core/loops/levels.ts levelIn). For the loops overview read (core/semantic-model/entities-loops.ts):
 * company names and levels only. */
export async function legacyLoopCompanyLevels(ctx:SessionContext):Promise<Readonly<Record<LoopId,readonly LoopCompanyLevel[]>>>{
 requireAdmin(ctx);
 return withTenant(ctx,async tx=>{
  const companies=Array.from(await tx.execute(sql`select c.id,c.legal_name from public.company c where c.tenant_id=${ctx.tenantId}::uuid and app.is_admin_for(c.id) order by c.legal_name,c.id`) as unknown as {id:string;legal_name:string}[]);
  const out={} as Record<LoopId,readonly LoopCompanyLevel[]>;
  for(const id of LOOP_IDS){
   const levels=await loopLevelsTx(tx,ctx.tenantId,id);
   out[id]=Object.freeze(companies.map(item=>Object.freeze({companyName:item.legal_name,level:levelIn(levels,item.id)})));
  }
  return Object.freeze(out);
 });
}

/** app/control-tower/exceptions/page.tsx at f7ee5177: one acknowledgedBlocks transaction per month, all at once. */
export async function legacyExceptionsAcknowledged(s:SessionContext,companies:readonly string[],periods:readonly string[]){
 return companies.length
  ? (await Promise.all(periods.map(payPeriod => acknowledgedBlocks(s, { companyIds: companies, payPeriod }).then(list => list.map(block => ({ ...block, payPeriod })))))).flat()
  : [];
}

/** core/payroll-anomaly.ts openExceptionsAcrossRuns at f7ee5177: every live unresolved verdict read, sorted and sliced in memory. */
export async function legacyOpenExceptionsAcrossRuns(
  ctx: SessionContext,
  p?: { limit?: number },
): Promise<{ rows: OpenExceptionRow[]; total: number; blocking: number; cappedOut: boolean }> {
  const limit = p?.limit ?? 100;
  return withTenant(ctx, async (tx) => {
    const verdicts = await tx
      .select({
        verdictId: schema.payrollAnomalyVerdict.id,
        employmentId: schema.payrollAnomalyVerdict.employmentId,
        batchId: schema.payrollAnomalyVerdict.batchId,
        disposition: schema.payrollAnomalyVerdict.disposition,
        computedAt: schema.payrollAnomalyVerdict.computedAt,
        resolution: schema.payrollAnomalyVerdict.resolution,
        resolvedAt: schema.payrollAnomalyVerdict.resolvedAt,
        detectorsRun: schema.payrollAnomalyVerdict.detectorsRun,
        detectorsSkipped: schema.payrollAnomalyVerdict.detectorsSkipped,
        employeeName: schema.person.fullName,
        employeeCode: schema.employment.employeeCode,
        payPeriod: schema.payrollBatch.payPeriod,
      })
      .from(schema.payrollAnomalyVerdict)
      .innerJoin(schema.employment, eq(schema.employment.id, schema.payrollAnomalyVerdict.employmentId))
      .innerJoin(schema.person, eq(schema.person.id, schema.employment.personId))
      .innerJoin(schema.payrollBatch, eq(schema.payrollBatch.id, schema.payrollAnomalyVerdict.batchId))
      .where(
        and(
          // LIVE only: a superseded verdict is what the system believed before the last re-evaluation,
          // and resolving one would stamp a judgement on a reading nobody is looking at.
          isNull(schema.payrollAnomalyVerdict.supersededAt),
          // UNRESOLVED only. This queue is work outstanding; what has been decided belongs to its run.
          isNull(schema.payrollAnomalyVerdict.resolvedAt),
          // Auto-cleared rows are excluded HERE and deliberately, unlike the per-run screen which lists
          // them so a human can raise a false negative. That affordance is per-run by nature — it needs
          // the whole run in front of you to notice an omission — and a cross-run list of everything the
          // system cleared would be thousands of rows nobody is being asked to act on.
          ne(schema.payrollAnomalyVerdict.disposition, 'auto_clear'),
        ),
      );
    if (verdicts.length === 0) return { rows: [], total: 0, blocking: 0, cappedOut: false };

    const rank: Record<string, number> = { block: 0, review: 1, auto_clear: 2 };
    const ordered = verdicts.sort((x, y) => {
      const d = (rank[x.disposition] ?? 9) - (rank[y.disposition] ?? 9);
      if (d !== 0) return d;
      return x.computedAt.getTime() - y.computedAt.getTime();
    });
    // ⚠️ CAPPED, AND THE COUNT IS RETURNED SO THE SCREEN CAN SAY SO. A page that silently shows the first
    // hundred of nine hundred reads as a queue somebody has nearly finished (AGENTS: no silent caps).
    const page = ordered.slice(0, limit);

    // One read for every finding on the page, then grouped in memory — the same no-N+1 discipline
    // `anomalyQueue` follows, for the same reason.
    const findings = await tx
      .select({
        id: schema.payrollAnomalyFinding.id,
        verdictId: schema.payrollAnomalyFinding.verdictId,
        detectorId: schema.payrollAnomalyFinding.detectorId,
        severity: schema.payrollAnomalyFinding.severity,
        facts: schema.payrollAnomalyFinding.facts,
        suggestedAction: schema.payrollAnomalyFinding.suggestedAction,
        narrative: schema.payrollAnomalyFinding.narrative,
      })
      .from(schema.payrollAnomalyFinding)
      .where(
        inArray(
          schema.payrollAnomalyFinding.verdictId,
          page.map((v) => v.verdictId),
        ),
      );
    const byVerdict = new Map<string, QueueRow['findings']>();
    for (const f of findings) {
      const list = byVerdict.get(f.verdictId) ?? [];
      list.push({
        id: f.id,
        detectorId: f.detectorId,
        severity: f.severity as Severity,
        facts: (f.facts ?? {}) as Record<string, string | number>,
        suggestedAction: f.suggestedAction,
        narrative: f.narrative,
      });
      byVerdict.set(f.verdictId, list);
    }

    return {
      rows: page.map((v) => ({
        verdictId: v.verdictId,
        employmentId: v.employmentId,
        employeeName: v.employeeName,
        employeeCode: v.employeeCode,
        disposition: v.disposition as Disposition,
        computedAt: v.computedAt,
        resolution: v.resolution,
        resolvedAt: v.resolvedAt,
        detectorsRunCount: (v.detectorsRun as string[] | null)?.length ?? 0,
        detectorsSkipped: (v.detectorsSkipped as SkippedDetector[] | null) ?? [],
        findings: byVerdict.get(v.verdictId) ?? [],
        payPeriod: v.payPeriod,
        batchId: v.batchId,
      })),
      total: ordered.length,
      blocking: ordered.filter((v) => v.disposition === 'block').length,
      cappedOut: ordered.length > page.length,
    };
  });
}


/** core/record-readiness.ts recordReadiness at f7ee5177 (its row fields, predicate and summary verbatim): the compensation EXISTS
 * without OFFSET 0, planned with JIT. */
export async function legacyRecordReadiness(
  ctx: SessionContext,
  /**
   * How many names each gap carries back. Defaults to `PEOPLE_PER_GAP`, which exists so a SCREEN stays
   * readable — the `count` beside it is always the true total.
   *
   * ⚠️ A NON-SCREEN CALLER MUST PASS ITS OWN LIMIT. ADR-0084's nudge agent iterated the default list and
   * therefore chased only the first 25 people per gap, silently, on a tenant of any size — a sample
   * treated as a total, which is the exact failure the `count`/`people` split was introduced to prevent
   * and which it caused here instead. Caught by `test/readiness-nudge.test.ts`'s blast-radius case.
   */
  opts?: { peopleLimit?: number },
): Promise<ReadinessView> {
  const peopleLimit = opts?.peopleLimit ?? PEOPLE_PER_GAP;
  return withTenant(ctx, async (tx) => (await legacyReadinessSnapshot(tx, peopleLimit)).view);
}

async function legacyReadinessSnapshot(tx: Tx, peopleLimit = PEOPLE_PER_GAP, adminOnly = false,
  scope?: { employmentIds?: readonly string[]; personId?: string }) {
    const rows = await tx
      .select(READINESS_ROW_FIELDS)
      .from(schema.employment)
      .innerJoin(schema.person, eq(schema.person.id, schema.employment.personId))
      .innerJoin(schema.company, eq(schema.company.id, schema.employment.companyId))
      .leftJoin(
        schema.employeeStatutoryMy,
        eq(schema.employeeStatutoryMy.personId, schema.employment.personId),
      )
      .where(readinessRowWhere(adminOnly, scope));
    return summarizeReadiness(rows, peopleLimit);
}
const BLOCK_RANK: Record<ReadinessBlocks, number> = { payroll: 0, payment: 1, statutory_filing: 2 };
const READINESS_ROW_FIELDS = {
        employmentId: schema.employment.id,
        name: schema.person.fullName,
        employeeCode: schema.employment.employeeCode,
        company: schema.company.legalName,
        paymentMethod: schema.employment.paymentMethod,
        ic: schema.employeeStatutoryMy.icNumber,
        passport: schema.employeeStatutoryMy.passportNumber,
        taxNumber: schema.employeeStatutoryMy.taxNumber,
        epfNumber: schema.employeeStatutoryMy.epfNumber,
        socsoNumber: schema.employeeStatutoryMy.socsoNumber,
        bankAccountNo: schema.employeeStatutoryMy.bankAccountNo,
        epfMode: schema.employeeStatutoryMy.epfMode,
        subjectToSocso: schema.employeeStatutoryMy.subjectToSocso,
        eisEligible: schema.employeeStatutoryMy.eisEligible,
        // EXISTS rather than a join: an employment may carry many compensation rows over time and a join
        // would multiply every employee by their salary history before the gaps were even counted.
        hasComp: sql<boolean>`exists (
          select 1 from ${schema.compensation} c where c.employment_id = ${schema.employment.id}
        )`,
};
const readinessRowWhere = (adminOnly: boolean, scope?: { employmentIds?: readonly string[]; personId?: string }) =>
      // ACTIVE ONLY. A leaver with no SOCSO number is a historical record, not a thing to go and fix, and
      // listing them would bury the people whose next payslip actually depends on it.
      and(isNull(schema.employment.terminatedOn),
        scope?.employmentIds ? inArray(schema.employment.id, [...scope.employmentIds]) : undefined,
        scope?.personId ? eq(schema.employment.personId, scope.personId) : undefined,
        adminOnly ? sql`app.can_admin_employment(${schema.employment.id})` : undefined);
function summarizeReadiness(rows: (ReadinessInput & { employmentId: string; name: string; employeeCode: string | null; company: string })[],
  peopleLimit: number) {
    const buckets = new Map<ReadinessGapId, ReadinessPerson[]>();
    const add = (id: ReadinessGapId, p: ReadinessPerson) => {
      const list = buckets.get(id) ?? [];
      list.push(p);
      buckets.set(id, list);
    };

    let ready = 0;
    for (const r of rows) {
      const who: ReadinessPerson = {
        employmentId: r.employmentId,
        name: r.name,
        employeeCode: r.employeeCode,
        company: r.company,
      };
      const gaps = gapsForRecord(r);
      for (const id of gaps) add(id, who);
      if (gaps.length === 0) ready++;
    }

    const gaps: ReadinessGap[] = [...buckets.entries()]
      .map(([id, people]) => ({
        id,
        blocks: GAP_BLOCKS[id],
        count: people.length,
        // Sorted before capping, so the names shown are stable between loads rather than whatever the
        // query happened to return first.
        people: [...people].sort((a, b) => a.name.localeCompare(b.name)).slice(0, peopleLimit),
      }))
      // Worst consequence first, then biggest — "payroll cannot run for these 3" outranks "40 are missing
      // a SOCSO number", because one stops a cycle and the other stops a filing.
      .sort((a, b) => BLOCK_RANK[a.blocks] - BLOCK_RANK[b.blocks] || b.count - a.count);

    return { view: { employees: rows.length, ready, gaps }, activeEmploymentIds: rows.map(r => r.employmentId) };
}
