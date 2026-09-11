/**
 * fe9c73bc — THE STAGED, ARCHIVE-FIRST ENTITLEMENT-CONFIGURATION RESET.
 *
 * ON THE BOX (CLAUDE.md §7 form — the default node there is v18 and lacks --env-file, so the env is sourced):
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && \
 *     /opt/node20/bin/node --import tsx scripts/reset-entitlement-configuration.ts
 *       → SURVEY: every tenant with its template / rule / accrual / ledger counts. Writes nothing.
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && \
 *     /opt/node20/bin/node --import tsx scripts/reset-entitlement-configuration.ts --tenant=<uuid> --stage=config
 *     /opt/node20/bin/node --import tsx scripts/reset-entitlement-configuration.ts --tenant=<uuid> --stage=accruals
 *       → DRY RUN of one stage: the full census per leave type, every refusal check, and the sentence
 *         "Nothing was written." Exit 1 if the stage WOULD be refused, so a rehearsal fails loudly.
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && \
 *     /opt/node20/bin/node --import tsx scripts/reset-entitlement-configuration.ts --tenant=<uuid> --stage=config   --apply [--tag <text>]
 *     /opt/node20/bin/node --import tsx scripts/reset-entitlement-configuration.ts --tenant=<uuid> --stage=accruals --apply [--tag <text>]
 *       → THE RESET, one stage, ONE transaction: archive → VERIFY → delete → event.
 *
 * REPORT-ONLY BY DEFAULT, like scripts/reset-medical-hospitalization-ledger.ts (c8052ae3, "the r180 script"),
 * which this file copies in shape and posture. Read that file's header before this one: it is the argument
 * for why a deletion from an append-only ledger can ever be defensible, and every condition it names that
 * still applies here is re-checked at run time below.
 *
 * WHAT THE REPORTER APPROVED (plan fe9c73bc): clear the tenant's entitlement CONFIGURATION — every
 * entitlement table and every eligibility rule — and, as a SEPARATE stage, the entitlement the system
 * GENERATED from it (the accrual rows); KEEP leave actually taken (debits) and every manual adjustment;
 * take a written record in the existing archive screens before anything is deleted; and do it in two
 * stages so the reporter sees Leave Balance Health flip to "not configured" before any balance moves.
 * Balances of anyone who took leave WILL read negative after stage two until fresh entitlement is
 * generated — the plan says so in those words, and this script does not paper over it.
 *
 * ── STAGE `config` ──────────────────────────────────────────────────────────────────────────────────
 *   SCOPE: EVERY entitlement_template row of the tenant — all versions: in force, ended, not yet started
 *   (the reporter asked for a clean state and the archive keeps the history) — and EVERY
 *   entitlement_eligibility_rule row. Nothing holds a foreign key into either table (a rule points at a
 *   template LINEAGE id, not a row), so the delete is closed over these two tables alone.
 *   ARCHIVE: entitlement_reset_archive, layers 'template' and 'rule', rendered to text: the bands in the
 *   words migration 0398 used ("0-2 yrs: 14 days, max brought forward 5"), the criteria in the words the
 *   rule screen uses (scripts/entitlement-criteria-words.ts). Read at /admin/leave-config/records/entitlement.
 *   ORDER: archive → verify → delete rules → delete templates → the health verdict, computed INSIDE the
 *   transaction with lib/leave-config-health.ts (every leave type must read `no_entitlement_table`, or the
 *   whole thing rolls back) → ONE domain event `entitlement-config.reset`.
 *   ⚠️ entitlement_reset_archive.layer carries a CHECK from migration 0397 that admits only 'scheme' and
 *   'policy'. Until a migration widens it to admit 'template' and 'rule', this stage REFUSES before writing
 *   anything and says so in one sentence (`layerCheckAdmits`). This item carries no migration; that is the
 *   parent's call, and the refusal is what keeps the tool honest in the meantime.
 *
 * ── STAGE `accruals` ────────────────────────────────────────────────────────────────────────────────
 *   SCOPE: leave_ledger rows with entry_type = 'accrual' for the tenant — ONLY those. Never
 *   'in_lieu_accrual' (time off in lieu somebody worked for), never 'adjustment' (a decision HR made by
 *   hand), never 'debit' (leave somebody took). Plus the leave_entitlement_recalc_audit rows whose
 *   ledger_id points at one of those accruals, so no audit row is left describing a row that is gone.
 *   ARCHIVE: leave_ledger_reset_archive, layers 'ledger' and 'recalc_audit' — the names migration 0416's
 *   CHECK admits — rendered exactly as app.capture_leave_ledger_reset_archive renders them. The SQL is
 *   COPIED rather than the function called, because that function selects by leave TYPE and would sweep
 *   in the debits and adjustments this plan keeps. Read at /admin/leave-config/records/balances.
 *   ORDER: archive → verify → delete audit rows → delete accrual rows → survivor check (no accrual left,
 *   and exactly the kept rows remain) → ONE domain event `entitlement-accruals.reset`.
 *
 * ── REFUSALS — fail closed: nothing written, the counts printed ─────────────────────────────────────
 *   · any to-be-deleted accrual carrying a source_request_id (an accrual sourced from a leave request is
 *     not "generated from configuration"; production shows none, and if one appears a human decides);
 *   · any toil_accrual referencing a to-be-deleted ledger row (the only foreign key into leave_ledger);
 *   · any leave_encashment_snapshot row for the tenant (ADR-0069 freezes those balances with a DB trigger,
 *     `leave_ledger_frozen_guard`; refusing here turns a trigger error into a sentence — the parent decides);
 *   · the capture tag already used in the target archive (a re-run is a NEW record, never an interleave);
 *   · (config) the layer CHECK not yet widened — see above.
 *   REPORTED, NOT REFUSED — these exist here BY DESIGN and are KEPT: debit rows and approved leave
 *   requests. The r180 script refused on both because its plan promised nothing taken was at stake; this
 *   plan promises the opposite, that taken leave survives.
 *
 * ENV CONTRACT: MIGRATION_DATABASE_URL (owner role), exactly as the r180 script. There is no session, so
 * there is no RLS tenant to inherit: every statement is scoped by tenant_id explicitly, and the tenant is
 * named on the command line and echoed back BY NAME before anything happens. A session-scoped delete would
 * silently under-delete; the owner role is the point, not a convenience.
 *
 * IT IMPORTS NO LEAVE-PACK BOUNDARY MODULE (test/leave-pack-drift.test.ts scans scripts/): db/schema,
 * db/events, lib/hr-date, lib/leave-config-health (a pure verdict that writes nothing) and the criteria
 * vocabulary only. It calls NO entitlement generation, no year-open and no accrual: after stage two the
 * ledger reads what it reads because the rows are gone, not because something granted zero.
 */
import { fileURLToPath } from 'node:url';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { createDb, type Tx } from '../db/client';
import { appendEvent } from '../db/events';
import {
  entitlementEligibilityRule,
  entitlementResetArchive,
  entitlementTemplate,
  jobGrade,
  leaveEntitlementRecalcAudit,
  leaveLedger,
  leaveLedgerResetArchive,
  leaveRequest,
  leaveType,
  tenant,
} from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';
import { leaveConfigHealthAll, type LeaveConfigHealth } from '../lib/leave-config-health';
import {
  criteriaSectionsFor,
  englishCriteriaLabels,
  loadCriteriaCatalogues,
  renderCriteriaInWords,
} from './entitlement-criteria-words';

export type Stage = 'config' | 'accruals';
export const STAGES: readonly Stage[] = ['config', 'accruals'];

/** The English catalogue the criteria words are labelled from — the product's own strings, off disk. */
const EN_MESSAGES_PATH = fileURLToPath(new URL('../messages/en.json', import.meta.url));

function loadEnv() {
  try {
    process.loadEnvFile('.env.production');
  } catch {
    try {
      process.loadEnvFile('.env.local');
    } catch {
      // env supplied directly
    }
  }
}

/**
 * A Postgres uuid[] bound from a JS array. ⚠️ `sql`${ids}::uuid[]`` does NOT work — drizzle spreads the
 * array into one placeholder per element and Postgres answers `malformed array literal`. Found by
 * test/leave-ledger-reset-archive.test.ts; carried here verbatim from the r180 script.
 */
const uuidArray = (ids: string[]) => sql`array[${sql.join(ids.map((v) => sql`${v}::uuid`), sql`, `)}]::uuid[]`;

/** `--flag value` and `--flag=value` both work; the brief documents the `=` form for --tenant / --stage. */
export const argOf = (flag: string, argv: string[] = process.argv): string | null => {
  const eqForm = argv.find((a) => a.startsWith(`${flag}=`));
  if (eqForm) return eqForm.slice(flag.length + 1);
  const i = argv.indexOf(flag);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};

export const defaultTag = (stage: Stage, today = todayInKualaLumpur()) => `fe9c73bc-${stage}-${today}`;

/**
 * The band table in words — the SAME wording migration 0398 rendered `scheme_leave_entitlement.service_bands`
 * with ("0-2 yrs: 14 days, max brought forward 5, max entitled + brought forward 20 | 3-no limit yrs: …"),
 * written in TypeScript because that plpgsql reads tables migration 0405 dropped. A malformed value is
 * recorded as stored rather than dropped: the archive's only promise is completeness.
 */
export function renderServiceBands(bands: unknown): string {
  if (!Array.isArray(bands)) return `service_bands is not an array — recorded as stored: ${JSON.stringify(bands)}`;
  if (bands.length === 0) return 'no bands';
  return bands
    .map((b) => {
      const o = (b ?? {}) as Record<string, unknown>;
      const v = (k: string) => (o[k] == null || o[k] === '' ? null : String(o[k]));
      let s = `${v('fromYears') ?? '?'}-${v('toYears') ?? 'no limit'} yrs: ${v('days') ?? '?'} days`;
      if (v('carryForwardDays') != null) s += `, max brought forward ${v('carryForwardDays')}`;
      if (v('maxBalanceDays') != null) s += `, max entitled + brought forward ${v('maxBalanceDays')}`;
      if (v('carryForwardExpiryDay') != null && v('carryForwardExpiryMonth') != null) {
        s += `, carry expires ${v('carryForwardExpiryDay')}/${v('carryForwardExpiryMonth')}`;
      }
      return s;
    })
    .join(' | ');
}

/** In force / ended / not yet — the SAME dating rule lib/leave-config-health.ts applies (validTo exclusive). */
export type ForceStatus = 'in force' | 'ended' | 'not yet in force';
export function forceStatus(row: { validFrom: string; validTo: string | null }, today: string): ForceStatus {
  if (row.validFrom > today) return 'not yet in force';
  if (row.validTo != null && row.validTo <= today) return 'ended';
  return 'in force';
}

export type LedgerKindCount = { entryType: string; rows: number; days: number };
export type PerLeaveType = {
  /** null = rules whose template lineage no longer has any version (orphans — still archived and cleared). */
  leaveTypeId: string | null;
  code: string;
  name: string;
  archived: boolean;
  templatesInForce: number;
  templatesEnded: number;
  templatesNotYet: number;
  rulesInForce: number;
  rulesEnded: number;
  rulesNotYet: number;
  ledger: LedgerKindCount[];
  accrualRows: number;
  accrualDays: number;
  adjustmentsWithBatch: number;
  adjustmentsWithoutBatch: number;
  adjustmentReasons: { reason: string; rows: number; days: number }[];
  debitRows: number;
  debitsOnApprovedRequests: number;
  auditRowsInScope: number;
  /** lib/leave-config-health.ts's verdict on the CURRENT configuration, or null for an archived type. */
  healthNow: { status: LeaveConfigHealth['status']; templateCount: number; findings: string[] } | null;
};

export type HealthLine = {
  leaveTypeId: string;
  name: string;
  status: LeaveConfigHealth['status'];
  templateCount: number;
  findings: string[];
};

export type EntitlementResetReport = {
  tenantId: string;
  tenantName: string;
  stage: Stage;
  tag: string;
  apply: boolean;
  today: string;
  types: PerLeaveType[];
  totals: {
    templates: number;
    templatesInForce: number;
    rules: number;
    rulesInForce: number;
    ledgerRows: number;
    accrualRows: number;
    accrualDays: number;
    adjustmentRows: number;
    debitRows: number;
    debitsOnApprovedRequests: number;
    inLieuRows: number;
    approvedRequests: number;
    auditRowsInScope: number;
  };
  refusalCounts: {
    requestSourcedAccruals: number;
    toilReferences: number;
    encashmentSnapshots: number;
    tagInUse: number;
    layerCheckBlocked: number;
  };
  refusals: string[];
  /** Written only by --apply: what the transaction copied and removed, by archive layer / table. */
  archived: Record<string, number> | null;
  deleted: Record<string, number> | null;
  /** config stage, --apply only: one line per (non-archived) leave type, read INSIDE the transaction. */
  healthAfter: HealthLine[] | null;
  /** True when --apply found nothing in scope and therefore wrote nothing — including no event. */
  nothingInScope: boolean;
};

/**
 * Test-only seams. `afterArchive` runs INSIDE the transaction between the archive copy and the VERIFY, so a
 * test can shorten the copy and watch the verify throw and roll everything back. Never set from the CLI.
 */
export type ResetTestHooks = { afterArchive?: (tx: Tx) => Promise<void> };

export type ResetOptions = { tenantId: string; stage: Stage; apply: boolean; tag?: string; testHooks?: ResetTestHooks };

type Db = ReturnType<typeof createDb>['db'];

/** Does entitlement_reset_archive's layer CHECK admit the two layers this stage writes? Absent CHECK = yes. */
export async function layerCheckAdmits(db: Db | Tx, layers: string[]): Promise<boolean> {
  const rows = (await db.execute(
    sql`select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'entitlement_reset_archive'::regclass and conname = 'entitlement_reset_archive_layer_check'`,
  )) as unknown as { def: string }[];
  const def = rows[0]?.def;
  if (!def) return true;
  return layers.every((l) => def.includes(`'${l}'`));
}

// ── THE SURVEY (no --tenant): who is there, and how much each carries. Writes nothing. ──────────────
export type TenantSurveyRow = {
  tenantId: string;
  name: string;
  templates: number;
  rules: number;
  accrualRows: number;
  ledgerRows: number;
};

export async function surveyTenants(url: string): Promise<TenantSurveyRow[]> {
  const owner = createDb(url);
  // Written out in SQL with the outer table ALIASED: in a single-table drizzle select a column reference
  // inside sql`` renders as a bare "id", which a correlated subquery resolves against ITS OWN table
  // (leave_ledger.id, never equal to tenant_id) and silently counts zero. Pinned by the survey test.
  const rows = (await owner.db.execute(sql`
    select tn.id as tenant_id,
           tn.name,
           (select count(*)::int from entitlement_template t where t.tenant_id = tn.id) as templates,
           (select count(*)::int from entitlement_eligibility_rule r where r.tenant_id = tn.id) as rules,
           (select count(*)::int from leave_ledger l where l.tenant_id = tn.id and l.entry_type = 'accrual') as accrual_rows,
           (select count(*)::int from leave_ledger l where l.tenant_id = tn.id) as ledger_rows
    from tenant tn
    order by tn.name asc, tn.id asc`)) as unknown as {
    tenant_id: string;
    name: string;
    templates: number;
    rules: number;
    accrual_rows: number;
    ledger_rows: number;
  }[];
  return rows.map((r) => ({
    tenantId: r.tenant_id,
    name: r.name,
    templates: Number(r.templates),
    rules: Number(r.rules),
    accrualRows: Number(r.accrual_rows),
    ledgerRows: Number(r.ledger_rows),
  }));
}

// ── THE STAGE RUNNER ──────────────────────────────────────────────────────────────────────────────────
export async function runEntitlementReset(url: string, opts: ResetOptions): Promise<EntitlementResetReport> {
  if (!STAGES.includes(opts.stage)) throw new Error(`unknown stage '${opts.stage}' — expected config | accruals`);
  const owner = createDb(url);
  const today = todayInKualaLumpur();
  const tag = opts.tag?.trim() || defaultTag(opts.stage, today);
  const tenantId = opts.tenantId;
  const refusals: string[] = [];

  // ── 1. IDENTITY. The tenant is echoed back by NAME so a wrong uuid is caught by a human reading it. ──
  const [t] = await owner.db.select({ id: tenant.id, name: tenant.name }).from(tenant).where(eq(tenant.id, tenantId));
  if (!t) throw new Error(`tenant ${tenantId} does not exist — nothing was written.`);

  // ── 2. THE CENSUS, per leave type. This is the whole of the dry-run output. ─────────────────────────
  const types = await owner.db
    .select({
      id: leaveType.id,
      code: leaveType.code,
      name: leaveType.name,
      archivedAt: leaveType.archivedAt,
      accrualMethod: leaveType.accrualMethod,
      accrualUnconfigured: leaveType.accrualUnconfigured,
    })
    .from(leaveType)
    .where(eq(leaveType.tenantId, tenantId))
    .orderBy(asc(leaveType.name), asc(leaveType.id));
  const templates = await owner.db
    .select()
    .from(entitlementTemplate)
    .where(eq(entitlementTemplate.tenantId, tenantId))
    .orderBy(asc(entitlementTemplate.leaveTypeId), asc(entitlementTemplate.lineageId), asc(entitlementTemplate.validFrom));
  const rules = await owner.db
    .select()
    .from(entitlementEligibilityRule)
    .where(eq(entitlementEligibilityRule.tenantId, tenantId))
    .orderBy(asc(entitlementEligibilityRule.lineageId), asc(entitlementEligibilityRule.validFrom));
  const grades = await owner.db
    .select({ id: jobGrade.id, name: jobGrade.name })
    .from(jobGrade)
    .where(and(eq(jobGrade.tenantId, tenantId), sql`${jobGrade.archivedAt} is null`));

  // A rule belongs to the leave type its template LINEAGE belongs to (constant across versions).
  const leaveTypeByLineage = new Map<string, string>();
  for (const tpl of templates) leaveTypeByLineage.set(tpl.lineageId, tpl.leaveTypeId);

  const ledgerByKind = await owner.db
    .select({
      leaveTypeId: leaveLedger.leaveTypeId,
      entryType: leaveLedger.entryType,
      rows: sql<number>`count(*)::int`,
      days: sql<string>`coalesce(sum(${leaveLedger.days}), 0)`,
    })
    .from(leaveLedger)
    .where(eq(leaveLedger.tenantId, tenantId))
    .groupBy(leaveLedger.leaveTypeId, leaveLedger.entryType)
    .orderBy(asc(leaveLedger.leaveTypeId), asc(leaveLedger.entryType));
  const adjustmentsByBatch = await owner.db
    .select({
      leaveTypeId: leaveLedger.leaveTypeId,
      batched: sql<boolean>`(${leaveLedger.adjustmentBatchId} is not null)`,
      rows: sql<number>`count(*)::int`,
    })
    .from(leaveLedger)
    .where(and(eq(leaveLedger.tenantId, tenantId), eq(leaveLedger.entryType, 'adjustment')))
    .groupBy(leaveLedger.leaveTypeId, sql`(${leaveLedger.adjustmentBatchId} is not null)`);
  const adjustmentsByReason = await owner.db
    .select({
      leaveTypeId: leaveLedger.leaveTypeId,
      reason: sql<string>`coalesce(${leaveLedger.reason}, '(no reason)')`,
      rows: sql<number>`count(*)::int`,
      days: sql<string>`coalesce(sum(${leaveLedger.days}), 0)`,
    })
    .from(leaveLedger)
    .where(and(eq(leaveLedger.tenantId, tenantId), eq(leaveLedger.entryType, 'adjustment')))
    .groupBy(leaveLedger.leaveTypeId, sql`coalesce(${leaveLedger.reason}, '(no reason)')`)
    .orderBy(asc(leaveLedger.leaveTypeId), sql`2`);
  const debitsOnApproved = await owner.db
    .select({ leaveTypeId: leaveLedger.leaveTypeId, rows: sql<number>`count(*)::int` })
    .from(leaveLedger)
    .innerJoin(leaveRequest, eq(leaveRequest.id, leaveLedger.sourceRequestId))
    .where(
      and(eq(leaveLedger.tenantId, tenantId), eq(leaveLedger.entryType, 'debit'), eq(leaveRequest.status, 'approved')),
    )
    .groupBy(leaveLedger.leaveTypeId);

  // The accrual scope, by id — what stage two archives and removes, and what the audit scope hangs off.
  const accruals = await owner.db
    .select({ id: leaveLedger.id, leaveTypeId: leaveLedger.leaveTypeId })
    .from(leaveLedger)
    .where(and(eq(leaveLedger.tenantId, tenantId), eq(leaveLedger.entryType, 'accrual')))
    .orderBy(asc(leaveLedger.id));
  const accrualIds = accruals.map((a) => a.id);
  const audits =
    accrualIds.length === 0
      ? []
      : await owner.db
          .select({ id: leaveEntitlementRecalcAudit.id, leaveTypeId: leaveEntitlementRecalcAudit.leaveTypeId })
          .from(leaveEntitlementRecalcAudit)
          .where(
            and(
              eq(leaveEntitlementRecalcAudit.tenantId, tenantId),
              inArray(leaveEntitlementRecalcAudit.ledgerId, accrualIds),
            ),
          )
          .orderBy(asc(leaveEntitlementRecalcAudit.id));
  const auditIds = audits.map((a) => a.id);

  const [ledgerTotalRow] = await owner.db
    .select({ n: sql<number>`count(*)::int` })
    .from(leaveLedger)
    .where(eq(leaveLedger.tenantId, tenantId));
  const ledgerRowsBefore = Number(ledgerTotalRow?.n ?? 0);
  const [approvedRow] = await owner.db
    .select({ n: sql<number>`count(*)::int` })
    .from(leaveRequest)
    .where(and(eq(leaveRequest.tenantId, tenantId), eq(leaveRequest.status, 'approved')));
  const approvedRequests = Number(approvedRow?.n ?? 0);

  // ── 3. THE REFUSAL CHECKS — the r180 script's questions, asked again now, minus the two this plan
  //       answers differently (debits and approved requests exist BY DESIGN and are kept). ────────────
  const [sourcedRow] = await owner.db
    .select({ n: sql<number>`count(*)::int` })
    .from(leaveLedger)
    .where(
      and(
        eq(leaveLedger.tenantId, tenantId),
        eq(leaveLedger.entryType, 'accrual'),
        sql`${leaveLedger.sourceRequestId} is not null`,
      ),
    );
  const requestSourcedAccruals = Number(sourcedRow?.n ?? 0);
  const [toilRow] = (await owner.db.execute(
    sql`select count(*)::int as n from toil_accrual ta
        join leave_ledger ll on ll.id = ta.ledger_entry_id
        where ll.tenant_id = ${tenantId}::uuid and ll.entry_type = 'accrual'`,
  )) as unknown as { n: number }[];
  const toilReferences = Number(toilRow?.n ?? 0);
  const [snapRow] = (await owner.db.execute(
    sql`select count(*)::int as n from leave_encashment_snapshot where tenant_id = ${tenantId}::uuid`,
  )) as unknown as { n: number }[];
  const encashmentSnapshots = Number(snapRow?.n ?? 0);
  const [tagRow] =
    opts.stage === 'config'
      ? await owner.db
          .select({ n: sql<number>`count(*)::int` })
          .from(entitlementResetArchive)
          .where(and(eq(entitlementResetArchive.tenantId, tenantId), eq(entitlementResetArchive.captureTag, tag)))
      : await owner.db
          .select({ n: sql<number>`count(*)::int` })
          .from(leaveLedgerResetArchive)
          .where(and(eq(leaveLedgerResetArchive.tenantId, tenantId), eq(leaveLedgerResetArchive.captureTag, tag)));
  const tagInUse = Number(tagRow?.n ?? 0);
  const layerCheckBlocked = opts.stage === 'config' && !(await layerCheckAdmits(owner.db, ['template', 'rule'])) ? 1 : 0;

  if (opts.stage === 'accruals') {
    if (requestSourcedAccruals > 0) {
      refusals.push(
        `${requestSourcedAccruals} accrual row(s) carry a source_request_id — an accrual sourced from a leave request is not "generated from configuration". Stopping.`,
      );
    }
    if (toilReferences > 0) {
      refusals.push(`${toilReferences} toil_accrual row(s) reference an accrual this stage would delete. Stopping.`);
    }
  }
  if (encashmentSnapshots > 0) {
    refusals.push(
      `${encashmentSnapshots} leave_encashment_snapshot row(s) exist for this tenant (ADR-0069 freezes those balances). Stopping — the parent decides.`,
    );
  }
  if (tagInUse > 0) {
    refusals.push(
      `capture tag '${tag}' is already used by ${tagInUse} archived row(s) for this tenant — a re-run is a new record; pass a fresh --tag. Stopping.`,
    );
  }
  if (layerCheckBlocked) {
    refusals.push(
      `entitlement_reset_archive.layer is constrained to ('scheme', 'policy') by migration 0397's entitlement_reset_archive_layer_check; ` +
        `the config stage writes layers 'template' and 'rule'. A migration widening that CHECK must ship first. Stopping.`,
    );
  }

  // ── 4. ASSEMBLE THE REPORT ─────────────────────────────────────────────────────────────────────────
  const healthNow = leaveConfigHealthAll({
    leaveTypes: types.map((x) => ({
      id: x.id,
      name: x.name,
      archived: x.archivedAt != null,
      accrualMethod: x.accrualMethod ?? null,
      accrualUnconfigured: x.accrualUnconfigured != null,
    })),
    templates: templates.map((x) => ({ ...x, serviceBands: bandsForHealth(x.serviceBands) })),
    rules: rules.map((x) => ({ ...x, criteria: (x.criteria ?? {}) as { gradeIds?: string[] } & Record<string, unknown> })),
    grades,
    today,
  });
  const healthByType = new Map(healthNow.map((h) => [h.leaveTypeId, h]));

  const perType = (leaveTypeId: string | null, code: string, name: string, archived: boolean): PerLeaveType => {
    const tpls = templates.filter((x) => x.leaveTypeId === leaveTypeId);
    const rls = rules.filter((r) => (leaveTypeByLineage.get(r.templateLineageId) ?? null) === leaveTypeId);
    const kinds = ledgerByKind.filter((k) => k.leaveTypeId === leaveTypeId);
    const accrual = kinds.find((k) => k.entryType === 'accrual');
    const debit = kinds.find((k) => k.entryType === 'debit');
    const h = leaveTypeId ? healthByType.get(leaveTypeId) : undefined;
    const count = (arr: { validFrom: string; validTo: string | null }[], s: ForceStatus) =>
      arr.filter((x) => forceStatus(x, today) === s).length;
    return {
      leaveTypeId,
      code,
      name,
      archived,
      templatesInForce: count(tpls, 'in force'),
      templatesEnded: count(tpls, 'ended'),
      templatesNotYet: count(tpls, 'not yet in force'),
      rulesInForce: count(rls, 'in force'),
      rulesEnded: count(rls, 'ended'),
      rulesNotYet: count(rls, 'not yet in force'),
      ledger: kinds.map((k) => ({ entryType: k.entryType, rows: Number(k.rows), days: Number(k.days) })),
      accrualRows: Number(accrual?.rows ?? 0),
      accrualDays: Number(accrual?.days ?? 0),
      adjustmentsWithBatch: Number(adjustmentsByBatch.find((a) => a.leaveTypeId === leaveTypeId && a.batched)?.rows ?? 0),
      adjustmentsWithoutBatch: Number(
        adjustmentsByBatch.find((a) => a.leaveTypeId === leaveTypeId && !a.batched)?.rows ?? 0,
      ),
      adjustmentReasons: adjustmentsByReason
        .filter((a) => a.leaveTypeId === leaveTypeId)
        .map((a) => ({ reason: a.reason, rows: Number(a.rows), days: Number(a.days) })),
      debitRows: Number(debit?.rows ?? 0),
      debitsOnApprovedRequests: Number(debitsOnApproved.find((d) => d.leaveTypeId === leaveTypeId)?.rows ?? 0),
      auditRowsInScope: audits.filter((a) => a.leaveTypeId === leaveTypeId).length,
      healthNow: h ? { status: h.status, templateCount: h.templateCount, findings: [...h.findings] } : null,
    };
  };
  const typeLines = types.map((x) => perType(x.id, x.code, x.name, x.archivedAt != null));
  const orphanRules = rules.filter((r) => !leaveTypeByLineage.has(r.templateLineageId));
  if (orphanRules.length > 0) typeLines.push(perType(null, '(none)', '(rules whose template lineage has no version)', false));

  const sumKind = (k: string) => ledgerByKind.filter((x) => x.entryType === k).reduce((n, x) => n + Number(x.rows), 0);
  const report: EntitlementResetReport = {
    tenantId,
    tenantName: t.name,
    stage: opts.stage,
    tag,
    apply: opts.apply,
    today,
    types: typeLines,
    totals: {
      templates: templates.length,
      templatesInForce: templates.filter((x) => forceStatus(x, today) === 'in force').length,
      rules: rules.length,
      rulesInForce: rules.filter((x) => forceStatus(x, today) === 'in force').length,
      ledgerRows: ledgerRowsBefore,
      accrualRows: accrualIds.length,
      accrualDays: ledgerByKind.filter((x) => x.entryType === 'accrual').reduce((n, x) => n + Number(x.days), 0),
      adjustmentRows: sumKind('adjustment'),
      debitRows: sumKind('debit'),
      debitsOnApprovedRequests: debitsOnApproved.reduce((n, x) => n + Number(x.rows), 0),
      inLieuRows: sumKind('in_lieu_accrual'),
      approvedRequests,
      auditRowsInScope: auditIds.length,
    },
    refusalCounts: { requestSourcedAccruals, toilReferences, encashmentSnapshots, tagInUse, layerCheckBlocked },
    refusals,
    archived: null,
    deleted: null,
    healthAfter: null,
    nothingInScope: false,
  };

  if (!opts.apply || refusals.length > 0) return report;

  // ── 5. THE RESET, in ONE transaction: archive → VERIFY → delete → (verdict) → event. ───────────────
  //
  // The order is the plan's and it is not arbitrary. The archive is written and its row count CHECKED
  // AGAINST THE SOURCE COUNT before any DELETE runs, so a short copy aborts the whole transaction with
  // every row still in place — a throw, not a log line. Nothing is ever discovered afterwards.
  if (opts.stage === 'config') {
    if (templates.length === 0 && rules.length === 0) {
      report.nothingInScope = true;
      return report;
    }
    await owner.db.transaction(async (tx) => {
      const typeById = new Map(types.map((x) => [x.id, x]));
      const catalogues = await loadCriteriaCatalogues(tx, tenantId);
      const sections = criteriaSectionsFor(catalogues, englishCriteriaLabels(EN_MESSAGES_PATH));
      // The template name a rule is written against: the version in force today, else the lineage's latest.
      const templateNameForLineage = (lineageId: string): string | null => {
        const versions = templates.filter((x) => x.lineageId === lineageId);
        if (versions.length === 0) return null;
        const live = versions.find((x) => forceStatus(x, today) === 'in force');
        const latest = [...versions].sort((a, b) => (a.validFrom < b.validFrom ? 1 : a.validFrom > b.validFrom ? -1 : 0))[0];
        return (live ?? latest).name;
      };
      const templateRows = templates.map((x) => {
        const lt = typeById.get(x.leaveTypeId);
        return {
          tenantId,
          captureTag: tag,
          layer: 'template',
          schemeName: x.name,
          leaveTypeName: lt?.name ?? null,
          leaveTypeCode: lt?.code ?? null,
          entitlementText: renderServiceBands(x.serviceBands),
          validFromText: x.validFrom,
          validToText: x.validTo ?? 'open',
          note: `lineage ${x.lineageId} · version ${x.id} · ${forceStatus(x, today)}`,
        };
      });
      const ruleRows = rules.map((r) => {
        const ltId = leaveTypeByLineage.get(r.templateLineageId) ?? null;
        const lt = ltId ? typeById.get(ltId) : undefined;
        const tplName = templateNameForLineage(r.templateLineageId);
        return {
          tenantId,
          captureTag: tag,
          layer: 'rule',
          schemeName: r.name,
          leaveTypeName: lt?.name ?? null,
          leaveTypeCode: lt?.code ?? null,
          entitlementText: `${renderCriteriaInWords(r.criteria as Record<string, unknown>, sections)} → ${tplName ?? '(template lineage has no version)'}`,
          validFromText: r.validFrom,
          validToText: r.validTo ?? 'open',
          note: `rule lineage ${r.lineageId} · template lineage ${r.templateLineageId}` + (tplName == null ? ' · orphan' : ''),
        };
      });
      if (templateRows.length > 0) await tx.insert(entitlementResetArchive).values(templateRows);
      if (ruleRows.length > 0) await tx.insert(entitlementResetArchive).values(ruleRows);
      await opts.testHooks?.afterArchive?.(tx);

      // THE VERIFY. Per layer, against the source count, inside the transaction.
      const archivedTemplates = await countEntitlementArchive(tx, tenantId, tag, 'template');
      if (archivedTemplates !== templates.length) {
        throw new Error(
          `ARCHIVE INCOMPLETE: ${archivedTemplates} template row(s) captured under tag '${tag}' but ${templates.length} exist. Nothing deleted.`,
        );
      }
      const archivedRules = await countEntitlementArchive(tx, tenantId, tag, 'rule');
      if (archivedRules !== rules.length) {
        throw new Error(
          `ARCHIVE INCOMPLETE: ${archivedRules} rule row(s) captured under tag '${tag}' but ${rules.length} exist. Nothing deleted.`,
        );
      }

      // Rules first (they point at template lineages), then templates. Nothing else references either.
      const deletedRules = await tx
        .delete(entitlementEligibilityRule)
        .where(eq(entitlementEligibilityRule.tenantId, tenantId))
        .returning({ id: entitlementEligibilityRule.id });
      const deletedTemplates = await tx
        .delete(entitlementTemplate)
        .where(eq(entitlementTemplate.tenantId, tenantId))
        .returning({ id: entitlementTemplate.id });
      if (deletedRules.length !== rules.length || deletedTemplates.length !== templates.length) {
        throw new Error(
          `deleted ${deletedTemplates.length} template(s) + ${deletedRules.length} rule(s) but the census counted ${templates.length} + ${rules.length} — the world moved. Rolling back.`,
        );
      }

      // THE VERDICT, read back INSIDE the transaction: what Leave Balance Health will say the moment this
      // commits. Every non-archived leave type must read `no_entitlement_table`; anything else rolls back.
      const tplAfter = await tx.select().from(entitlementTemplate).where(eq(entitlementTemplate.tenantId, tenantId));
      const rulesAfter = await tx
        .select()
        .from(entitlementEligibilityRule)
        .where(eq(entitlementEligibilityRule.tenantId, tenantId));
      const after = leaveConfigHealthAll({
        leaveTypes: types.map((x) => ({
          id: x.id,
          name: x.name,
          archived: x.archivedAt != null,
          accrualMethod: x.accrualMethod ?? null,
          accrualUnconfigured: x.accrualUnconfigured != null,
        })),
        templates: tplAfter.map((x) => ({ ...x, serviceBands: bandsForHealth(x.serviceBands) })),
        rules: rulesAfter.map((x) => ({
          ...x,
          criteria: (x.criteria ?? {}) as { gradeIds?: string[] } & Record<string, unknown>,
        })),
        grades,
        today,
      });
      const stillConfigured = after.filter((h) => h.templateCount > 0 || !h.findings.includes('no_entitlement_table'));
      if (stillConfigured.length > 0) {
        throw new Error(
          `${stillConfigured.map((h) => h.leaveTypeName).join(', ')} still read as configured after the delete — rolling back.`,
        );
      }

      await appendEvent(tx, {
        tenantId,
        aggregateType: 'leave-config',
        aggregateId: tenantId,
        eventType: 'entitlement-config.reset',
        actor: { type: 'system' },
        payload: {
          item: 'fe9c73bc',
          stage: 'config',
          captureTag: tag,
          archived: { template: archivedTemplates, rule: archivedRules },
          deleted: { template: deletedTemplates.length, rule: deletedRules.length },
          leaveTypes: after.map((h) => ({ leaveTypeId: h.leaveTypeId, name: h.leaveTypeName, status: h.status })),
        },
      });

      report.archived = { template: archivedTemplates, rule: archivedRules };
      report.deleted = { template: deletedTemplates.length, rule: deletedRules.length };
      report.healthAfter = after.map((h) => ({
        leaveTypeId: h.leaveTypeId,
        name: h.leaveTypeName,
        status: h.status,
        templateCount: h.templateCount,
        findings: [...h.findings],
      }));
    });
    return report;
  }

  // stage === 'accruals'
  if (accrualIds.length === 0) {
    report.nothingInScope = true;
    return report;
  }
  await owner.db.transaction(async (tx) => {
    // ── LEDGER LAYER — migration 0416's rendering, copied, scoped to the accrual ids and nothing else. ──
    await tx.execute(sql`
      INSERT INTO leave_ledger_reset_archive (
        tenant_id, capture_tag, layer, source_row_id, employee_name, employee_code, employee_email,
        company_name, leave_type_name, leave_type_code, entry_type, days_text, effective_on_text, reason,
        source_request_text, recorded_at_text, note
      )
      SELECT
        ll.tenant_id,
        ${tag},
        'ledger',
        ll.id::text,
        pe.full_name,
        em.employee_code,
        pe.primary_email,
        coalesce(c.company_label, c.legal_name),
        lt.name,
        lt.code,
        ll.entry_type::text,
        ll.days::text,
        ll.effective_on::text,
        ll.reason,
        CASE
          WHEN ll.source_request_id IS NULL THEN 'not sourced from a leave request'
          ELSE '⚠ sourced from leave request ' || coalesce(lr.start_date::text, '?') || ' → '
                 || coalesce(lr.end_date::text, '?') || ' (' || coalesce(lr.status::text, '?') || ')'
        END,
        ll.created_at::text,
        CASE
          WHEN ll.effective_on > (date_trunc('year', now())::date + interval '1 year')::date
            THEN 'Future-dated grant: this row was queued to land by itself in a later leave year.'
          ELSE NULL
        END
      FROM leave_ledger ll
      JOIN employment em ON em.id = ll.employment_id
      LEFT JOIN person pe ON pe.id = em.person_id
      LEFT JOIN company c ON c.id = em.company_id
      LEFT JOIN leave_type lt ON lt.id = ll.leave_type_id
      LEFT JOIN leave_request lr ON lr.id = ll.source_request_id
      WHERE ll.tenant_id = ${tenantId}::uuid
        AND ll.entry_type = 'accrual'
        AND ll.id = ANY (${uuidArray(accrualIds)})`);
    // ── RECALC-AUDIT LAYER — the rows that DESCRIBE those accruals, by id. ─────────────────────────────
    if (auditIds.length > 0) {
      await tx.execute(sql`
        INSERT INTO leave_ledger_reset_archive (
          tenant_id, capture_tag, layer, source_row_id, employee_name, employee_code, employee_email,
          company_name, leave_type_name, leave_type_code, days_text, effective_on_text, reason,
          entitlement_text, recorded_at_text, note
        )
        SELECT
          ra.tenant_id,
          ${tag},
          'recalc_audit',
          ra.id::text,
          pe.full_name,
          em.employee_code,
          pe.primary_email,
          coalesce(c.company_label, c.legal_name),
          lt.name,
          lt.code,
          ra.delta::text,
          ra.effective_on::text,
          ra.reason,
          'previous ' || ra.previous_entitlement::text || ' → new ' || ra.new_entitlement::text
            || ' (delta ' || ra.delta::text || ')',
          ra.created_at::text,
          'Describes an accrual row removed by the same reset (fe9c73bc).'
        FROM leave_entitlement_recalc_audit ra
        JOIN employment em ON em.id = ra.employment_id
        LEFT JOIN person pe ON pe.id = em.person_id
        LEFT JOIN company c ON c.id = em.company_id
        LEFT JOIN leave_type lt ON lt.id = ra.leave_type_id
        WHERE ra.tenant_id = ${tenantId}::uuid
          AND ra.id = ANY (${uuidArray(auditIds)})`);
    }
    await opts.testHooks?.afterArchive?.(tx);

    // THE VERIFY.
    const archivedLedger = await countLedgerArchive(tx, tenantId, tag, 'ledger');
    if (archivedLedger !== accrualIds.length) {
      throw new Error(
        `ARCHIVE INCOMPLETE: ${archivedLedger} ledger row(s) captured under tag '${tag}' but ${accrualIds.length} accrual row(s) exist. Nothing deleted.`,
      );
    }
    const archivedAudit = await countLedgerArchive(tx, tenantId, tag, 'recalc_audit');
    if (archivedAudit !== auditIds.length) {
      throw new Error(
        `RECALC-AUDIT ARCHIVE INCOMPLETE: ${archivedAudit} captured under tag '${tag}' but ${auditIds.length} exist. Nothing deleted.`,
      );
    }

    // Audit rows first (they describe the ledger rows), then the accruals — by id AND by entry type, so a
    // row that changed kind between census and delete is left alone and caught by the survivor check.
    const deletedAudit =
      auditIds.length === 0
        ? []
        : await tx
            .delete(leaveEntitlementRecalcAudit)
            .where(and(eq(leaveEntitlementRecalcAudit.tenantId, tenantId), inArray(leaveEntitlementRecalcAudit.id, auditIds)))
            .returning({ id: leaveEntitlementRecalcAudit.id });
    const deletedLedger = await tx
      .delete(leaveLedger)
      .where(
        and(eq(leaveLedger.tenantId, tenantId), eq(leaveLedger.entryType, 'accrual'), inArray(leaveLedger.id, accrualIds)),
      )
      .returning({ id: leaveLedger.id });

    // Belt to the braces: no accrual may survive, and EXACTLY the kept rows must remain.
    const [accrualsLeft] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(leaveLedger)
      .where(and(eq(leaveLedger.tenantId, tenantId), eq(leaveLedger.entryType, 'accrual')))) as { n: number }[];
    if (Number(accrualsLeft?.n ?? 0) !== 0) {
      throw new Error(`${accrualsLeft?.n} accrual row(s) survived the delete — rolling back.`);
    }
    const [ledgerLeft] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(leaveLedger)
      .where(eq(leaveLedger.tenantId, tenantId))) as { n: number }[];
    if (Number(ledgerLeft?.n ?? 0) !== ledgerRowsBefore - accrualIds.length) {
      throw new Error(
        `${ledgerLeft?.n} ledger row(s) remain but ${ledgerRowsBefore - accrualIds.length} were expected to be kept — rolling back.`,
      );
    }

    await appendEvent(tx, {
      tenantId,
      aggregateType: 'leave-config',
      aggregateId: tenantId,
      eventType: 'entitlement-accruals.reset',
      actor: { type: 'system' },
      payload: {
        item: 'fe9c73bc',
        stage: 'accruals',
        captureTag: tag,
        archived: { ledger: archivedLedger, recalcAudit: archivedAudit },
        deleted: { ledger: deletedLedger.length, recalcAudit: deletedAudit.length },
        kept: {
          adjustment: report.totals.adjustmentRows,
          debit: report.totals.debitRows,
          inLieuAccrual: report.totals.inLieuRows,
        },
        perLeaveType: report.types
          .filter((x) => x.leaveTypeId && x.accrualRows > 0)
          .map((x) => ({ leaveTypeId: x.leaveTypeId, code: x.code, accrualRows: x.accrualRows, accrualDays: x.accrualDays })),
      },
    });

    report.archived = { ledger: archivedLedger, recalc_audit: archivedAudit };
    report.deleted = { ledger: deletedLedger.length, recalc_audit: deletedAudit.length };
  });
  return report;
}

/** lib/leave-config-health.ts wants `{ days, maxBalanceDays? }[]`; a malformed JSONB reads as no bands. */
function bandsForHealth(bands: unknown): { days: number; maxBalanceDays?: number | null }[] {
  if (!Array.isArray(bands)) return [];
  return bands.map((b) => {
    const o = (b ?? {}) as Record<string, unknown>;
    return { days: Number(o.days ?? 0), maxBalanceDays: o.maxBalanceDays == null ? null : Number(o.maxBalanceDays) };
  });
}

async function countEntitlementArchive(tx: Tx, tenantId: string, tag: string, layer: string): Promise<number> {
  const [row] = (await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(entitlementResetArchive)
    .where(
      and(
        eq(entitlementResetArchive.tenantId, tenantId),
        eq(entitlementResetArchive.captureTag, tag),
        eq(entitlementResetArchive.layer, layer),
      ),
    )) as { n: number }[];
  return Number(row?.n ?? 0);
}

async function countLedgerArchive(tx: Tx, tenantId: string, tag: string, layer: string): Promise<number> {
  const [row] = (await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(leaveLedgerResetArchive)
    .where(
      and(
        eq(leaveLedgerResetArchive.tenantId, tenantId),
        eq(leaveLedgerResetArchive.captureTag, tag),
        eq(leaveLedgerResetArchive.layer, layer),
      ),
    )) as { n: number }[];
  return Number(row?.n ?? 0);
}

// ── PRINTING — the house layout. Exported so a test can assert the sentence, not just the numbers. ────
const pad = (s: string | number, n: number) => String(s).padStart(n);
const fmtDays = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2);

export function formatSurvey(rows: TenantSurveyRow[]): string {
  const out: string[] = [];
  out.push('\nfe9c73bc entitlement-configuration reset — SURVEY (no --tenant given; nothing is written)\n');
  out.push('  tenant                                 name                             templates  rules  accruals  ledger');
  for (const r of rows) {
    out.push(
      `  ${r.tenantId}   ${r.name.slice(0, 30).padEnd(30)}   ${pad(r.templates, 9)}  ${pad(r.rules, 5)}  ${pad(r.accrualRows, 8)}  ${pad(r.ledgerRows, 6)}`,
    );
  }
  out.push('\n  Re-run with --tenant=<uuid> --stage=config | accruals for a dry run of one stage.');
  out.push('  Nothing was written.');
  return out.join('\n');
}

export function formatReport(r: EntitlementResetReport): string {
  const out: string[] = [];
  out.push(`\nfe9c73bc entitlement-configuration reset — stage=${r.stage} mode=${r.apply ? 'APPLY' : 'DRY RUN'}`);
  out.push(`tenant ${r.tenantId} "${r.tenantName}", capture tag '${r.tag}', today ${r.today} (Kuala Lumpur)\n`);
  for (const x of r.types) {
    const flag = x.archived ? ' (archived leave type)' : '';
    out.push(`  ${x.code.padEnd(16)} ${x.name}${flag}`);
    out.push(
      `    templates: ${x.templatesInForce} in force / ${x.templatesEnded} ended / ${x.templatesNotYet} not yet` +
        `   rules: ${x.rulesInForce} in force / ${x.rulesEnded} ended / ${x.rulesNotYet} not yet`,
    );
    if (x.healthNow) out.push(`    health now: ${x.healthNow.status} (${x.healthNow.findings.join(', ') || 'no findings'})`);
    for (const k of x.ledger) out.push(`    ledger ${k.entryType.padEnd(16)} ${pad(k.rows, 5)} rows  ${pad(fmtDays(k.days), 10)} days`);
    if (x.adjustmentsWithBatch + x.adjustmentsWithoutBatch > 0) {
      out.push(`    adjustments: ${x.adjustmentsWithBatch} with a batch id / ${x.adjustmentsWithoutBatch} without`);
      for (const a of x.adjustmentReasons) out.push(`      reason "${a.reason}": ${a.rows} rows ${fmtDays(a.days)} days`);
    }
    if (x.debitRows > 0) out.push(`    debits: ${x.debitRows} rows, ${x.debitsOnApprovedRequests} on an approved request — KEPT`);
    if (x.auditRowsInScope > 0) out.push(`    recalc-audit rows describing an accrual: ${x.auditRowsInScope}`);
  }
  const t = r.totals;
  out.push('');
  out.push(`  entitlement_template rows        : ${t.templates} (${t.templatesInForce} in force)`);
  out.push(`  entitlement_eligibility_rule rows: ${t.rules} (${t.rulesInForce} in force)`);
  out.push(`  leave_ledger rows                : ${t.ledgerRows}`);
  out.push(`    accrual (stage accruals scope) : ${t.accrualRows} rows ${fmtDays(t.accrualDays)} days`);
  out.push(`    adjustment (kept)              : ${t.adjustmentRows}`);
  out.push(`    debit (kept)                   : ${t.debitRows} (${t.debitsOnApprovedRequests} on an approved request)`);
  out.push(`    in_lieu_accrual (kept)         : ${t.inLieuRows}`);
  out.push(`  approved leave requests (kept)   : ${t.approvedRequests}`);
  out.push(`  recalc-audit rows in scope       : ${t.auditRowsInScope}`);
  const c = r.refusalCounts;
  out.push('');
  out.push(`  request-sourced accruals (must be 0)      : ${c.requestSourcedAccruals}`);
  out.push(`  toil_accrual references (must be 0)       : ${c.toilReferences}`);
  out.push(`  encashment snapshots (must be 0)          : ${c.encashmentSnapshots}`);
  out.push(`  archive rows already under this tag (0)   : ${c.tagInUse}`);
  if (r.stage === 'config') out.push(`  layer CHECK blocks template/rule (must be 0): ${c.layerCheckBlocked}`);

  if (r.refusals.length > 0) {
    out.push('\nREFUSED — nothing was written:');
    for (const x of r.refusals) out.push(`  · ${x}`);
    return out.join('\n');
  }
  if (!r.apply) {
    const what =
      r.stage === 'config'
        ? `archive these ${t.templates} template(s) and ${t.rules} rule(s) into entitlement_reset_archive and then remove them`
        : `archive these ${t.accrualRows} accrual row(s) and ${t.auditRowsInScope} recalc-audit row(s) into leave_ledger_reset_archive and then remove them`;
    out.push(`\n  Nothing was written. Re-run with --apply to ${what}.`);
    return out.join('\n');
  }
  if (r.nothingInScope) {
    out.push(`\n  Nothing in scope for stage ${r.stage}: nothing was written and no event was recorded.`);
    return out.join('\n');
  }
  const a = r.archived ?? {};
  const d = r.deleted ?? {};
  out.push(`\n  ARCHIVED: ${Object.entries(a).map(([k, v]) => `${v} ${k}`).join(' + ')} row(s) under tag '${r.tag}'.`);
  out.push(`  DELETED : ${Object.entries(d).map(([k, v]) => `${v} ${k}`).join(' + ')} row(s).`);
  if (r.stage === 'config') {
    out.push('  Read the record at /admin/leave-config/records/entitlement.');
    out.push('  Leave Balance Health, read back inside the same transaction:');
    for (const h of r.healthAfter ?? []) {
      out.push(`    ${h.name.padEnd(28)} templates in force ${h.templateCount} · ${h.status} · ${h.findings.join(', ')}`);
    }
  } else {
    out.push('  Read the record at /admin/leave-config/records/balances.');
    out.push('  Debits and manual adjustments were KEPT; balances of anyone who took leave now read negative until');
    out.push('  new configuration generates fresh entitlement (plan fe9c73bc). NO entitlement generation was run.');
  }
  return out.join('\n');
}

if (process.argv[1]?.endsWith('reset-entitlement-configuration.ts')) {
  loadEnv();
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('reset-entitlement-configuration requires MIGRATION_DATABASE_URL (owner role).');
    process.exit(1);
  }
  const tenantId = argOf('--tenant');
  const stageArg = argOf('--stage');
  const apply = process.argv.includes('--apply');
  const run = async () => {
    if (!tenantId) {
      if (apply || stageArg) {
        console.error('--tenant=<uuid> is required with --stage / --apply. Run without arguments for the survey.');
        process.exit(1);
      }
      console.log(formatSurvey(await surveyTenants(url)));
      return 0;
    }
    if (!stageArg || !STAGES.includes(stageArg as Stage)) {
      console.error('--stage=config | accruals is required with --tenant.');
      process.exit(1);
    }
    const r = await runEntitlementReset(url, {
      tenantId,
      stage: stageArg as Stage,
      apply,
      tag: argOf('--tag') ?? undefined,
    });
    const text = formatReport(r);
    if (r.refusals.length > 0) {
      console.error(text);
      return 1;
    }
    console.log(text);
    return 0;
  };
  run()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
