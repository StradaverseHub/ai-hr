/**
 * Create New Employee — drafts (item 6d671f44, reshaped by 06f0cb8f).
 *
 * ITEM 06f0cb8f INVERTED EXACTLY ONE CLAUSE OF THE PARAGRAPH BELOW, and left the rest standing.
 * A draft used to consume nothing at all, Employee ID included. The reporter's whole request is that the
 * ID be taken THE MOMENT the record is created — because HR knows the name and the email at the moment
 * the offer is accepted, and the number has to be theirs from then on. So `createEmployeeDraftWithReservedCode`
 * asks four questions (Company, Employee ID, Full Name, Email), issues the ID and HOLDS it on the row.
 * `completeEmployeeDraft` then hands that same held code to `hireEmployee` rather than letting it generate
 * a second one, and `discardEmployeeDraft` gives the number back when it was the last one issued.
 *
 * A HELD NUMBER CAN STILL LEAVE A GAP, and the plan says so in the reporter's own words rather than
 * pretending otherwise: if a draft is abandoned AFTER somebody else has been created behind it, its number
 * is spent and the sequence skips it. Rolling back anything other than the tip would hand out an ID that
 * is already on an employee. The alternative — settle the ID only at Activate, gapless but late — is the
 * option the plan offered as a reject path and the reporter did not take.
 *
 * A DRAFT IS CAPTURED INPUT, NOT A RECORD. Nothing is created until `completeEmployeeDraft`, and when
 * it is, it goes through the SAME writers the single-hire form and the bulk importer use —
 * `hireEmployee` → the company pack's `statutory.set` → `setCompensation` (+ the IC-derived date of
 * birth autofill) — so a wizard-created employee is indistinguishable from a hand-entered or imported
 * one, events included. This is the plan's explicit requirement ("Creation on completion must go
 * through the existing writers, not a bespoke insert") and it is what makes the r73 Decision 3 failure
 * mode — a writer silently dropping a column it predates — impossible to reintroduce here: there is no
 * second writer to fall behind.
 *
 * IT ALSO DOES NOT EMIT A MOVEMENT EVENT. The initial assignment IS the Hired row, which
 * `core/movement.ts` synthesizes from the employment itself with a pseudo-id; emitting an event for it
 * would give every new employee a spurious second history row — the exact fault r78 (`4d391ab7`) fixed
 * for the reporting line. `hireEmployee` already tags its inline `reporting-line.set` as `secondary`;
 * nothing here untags or duplicates it.
 *
 * WHY THE DRAFT IS NOT AN EMPLOYMENT WITH A FLAG — see migration 0337's header. In short: every list
 * read in the product joins `employment`, so a flag would need a new exclusion in each of them forever,
 * and the failure mode is a half-entered person appearing in a headcount or a payroll run.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { company, employeeDraft, employeeIdConfig, person, tenantCounter } from '../db/schema';
import { appendEvent, actorOf } from '../db/events';
import { hireEmployee } from './org';
import { issueLegacyEmployeeCode, setCompensation } from './comp';
import { setPersonComplianceFields } from './profile';
import { listLeaveTypes } from './read';
import { issueEmployeeCode, listConfigs, resolveEmployeeIdRule } from './employee-id-config';
// 06f0cb8f — "is this Employee ID free?" spans employment AND employee_draft now. One definition, in its
// own module, shared with core/org.ts (which cannot import this file: it is the other end of the cycle).
import { findEmployeeCodeClaim } from './employee-code-claims';
import { requirePackFor } from '../localization/registry';
import { normalizeEmployeeCode, requireEmployeeCode } from '../lib/employee-code';
import { resolveEmployeeIdMode, type EmployeeIdRule } from '../lib/employee-id-mode';
import {
  draftFamily,
  draftLabel,
  missingForCreation,
  missingToCreate,
  stepKey,
  type EmployeeDraftData,
  type EmployeeDraftFamilyMember,
} from '../lib/employee-draft-schema';
// 759dfc7d — the family the draft captured becomes real rows at Activate. Both of these live in
// core/dependents.ts on purpose: `addDependent` and the materialisation share ONE column mapping, ONE
// set of normalisers and ONE event, so a field the Personnel screen gains cannot be dropped here.
import { assertDependentsValid, materialiseDependents, type DependentInput } from './dependents';

/** Standing entitlements granted on hire — the same three the hire form and the importer grant. */
const STANDING_GRANTS = new Set(['ANNUAL', 'SICK', 'HOSPITALIZATION']);

export type EmployeeDraftRow = {
  id: string;
  label: string;
  companyId: string | null;
  companyName: string | null;
  currentStep: number;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** The held Employee ID (item 06f0cb8f), or null on a draft that predates the hold. */
  reservedEmployeeCode: string | null;
  /** Outstanding required fields, recomputed on read so an old draft is judged by today's rules. */
  missing: string[];
};

const asData = (v: unknown): EmployeeDraftData => (v && typeof v === 'object' ? (v as EmployeeDraftData) : {});
const str = (v: string | undefined) => {
  const s = (v ?? '').trim();
  return s === '' ? undefined : s;
};

/** Drafts visible to the caller, most recently touched first. RLS (0337) is the authority: an author
 *  sees their own, an admin sees the tenant's. */
export function listEmployeeDrafts(ctx: SessionContext): Promise<EmployeeDraftRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: employeeDraft.id,
        label: employeeDraft.label,
        companyId: employeeDraft.companyId,
        companyName: company.legalName,
        currentStep: employeeDraft.currentStep,
        createdByName: person.fullName,
        createdAt: employeeDraft.createdAt,
        updatedAt: employeeDraft.updatedAt,
        reservedEmployeeCode: employeeDraft.reservedEmployeeCode,
        data: employeeDraft.data,
      })
      .from(employeeDraft)
      .leftJoin(company, eq(company.id, employeeDraft.companyId))
      .leftJoin(person, eq(person.id, employeeDraft.createdByPersonId))
      .orderBy(desc(employeeDraft.updatedAt));
    return rows.map(({ data, ...r }) => ({ ...r, missing: missingForCreation(asData(data)) }));
  });
}

export type EmployeeDraftDetail = {
  id: string;
  data: EmployeeDraftData;
  currentStep: number;
  companyId: string | null;
  /** The held Employee ID. THE AUTHORITY on which ID this draft owns — `data.profile.employeeCode` is
   *  only a mirror of it, kept so the form can render the value without a second prop. */
  reservedEmployeeCode: string | null;
};

export function getEmployeeDraft(ctx: SessionContext, id: string): Promise<EmployeeDraftDetail | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        id: employeeDraft.id,
        data: employeeDraft.data,
        currentStep: employeeDraft.currentStep,
        companyId: employeeDraft.companyId,
        reservedEmployeeCode: employeeDraft.reservedEmployeeCode,
      })
      .from(employeeDraft)
      .where(eq(employeeDraft.id, id))
      .limit(1);
    return row
      ? {
          id: row.id,
          data: asData(row.data),
          currentStep: row.currentStep,
          companyId: row.companyId,
          reservedEmployeeCode: row.reservedEmployeeCode,
        }
      : null;
  });
}

/**
 * Create or update a draft. Returns its id so the wizard can keep saving into the same one.
 *
 * `label` and `companyId` are DERIVED from the payload here rather than passed in, so the list can
 * never show a name the draft does not actually contain.
 *
 * ON A RESERVED DRAFT (item 06f0cb8f) TWO VALUES ARE PINNED and the client cannot move them: the COMPANY,
 * because it is the numbering rule the held ID came from and a draft pointing at a different company
 * would be holding a number from a sequence it no longer belongs to; and the EMPLOYEE ID mirror in
 * `data.profile.employeeCode`, because the held code lives in its own column and a payload disagreeing
 * with it would show HR one ID while another was being kept for them. The continue form renders both
 * read-only, so this is the server refusing to be told otherwise rather than a rule HR can trip over.
 */
export async function saveEmployeeDraft(
  ctx: SessionContext,
  p: { id?: string; data: EmployeeDraftData; currentStep: number },
): Promise<{ id: string }> {
  assertAdmin(ctx);
  const currentStep = Math.min(Math.max(Math.trunc(p.currentStep) || 1, 1), 20);
  const existing = p.id ? await getEmployeeDraft(ctx, p.id) : null;
  const data =
    existing?.reservedEmployeeCode
      ? {
          ...p.data,
          profile: { ...(p.data.profile ?? {}), employeeCode: existing.reservedEmployeeCode },
          employment: { ...(p.data.employment ?? {}), companyId: existing.companyId ?? undefined },
        }
      : p.data;
  const label = draftLabel(data);
  const companyId = str(data.employment?.companyId) ?? null;
  return withTenant(ctx, async (tx) => {
    let id = p.id;
    if (id) {
      // RLS decides whether this row is even visible; `returning` tells us whether it applied.
      const updated = await tx
        .update(employeeDraft)
        .set({ label, companyId, data, currentStep, updatedAt: new Date() })
        .where(eq(employeeDraft.id, id))
        .returning({ id: employeeDraft.id });
      if (updated.length === 0) throw new Error('Draft not found (or not visible).');
    } else {
      const [row] = await tx
        .insert(employeeDraft)
        .values({
          tenantId: ctx.tenantId,
          companyId,
          createdByPersonId: ctx.personId ?? null,
          label,
          data,
          currentStep,
        })
        .returning({ id: employeeDraft.id });
      id = row.id;
    }
    // One event per explicit save (the wizard saves on a button press, not on a keystroke), so the
    // audit trail records that a draft was worked on without recording what was typed into it.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-draft',
      aggregateId: id,
      eventType: p.id ? 'employee-draft.updated' : 'employee-draft.created',
      actor: actorOf(ctx),
      payload: { currentStep, step: stepKey(currentStep), companyId, hasLabel: label !== '' },
    });
    return { id };
  });
}

/**
 * The Employee ID rule in force for one company RIGHT NOW (item bd271009).
 *
 * Read at every decision point rather than stored on the draft: an administrator may edit the setup
 * screen between a draft being saved and being created, and a remembered rule would let the wizard
 * promise a number the engine would not issue.
 */
export async function employeeIdRuleFor(ctx: SessionContext, companyId: string): Promise<EmployeeIdRule> {
  return resolveEmployeeIdRule(await listConfigs(ctx), companyId);
}

/**
 * Is this Employee ID already taken? Powers the Create screen's on-blur look-ahead (item bd271009), so a
 * clash is named while HR is still in the field instead of at the final button.
 *
 * IT CONSULTS BOTH TABLES SINCE 06f0cb8f (`findEmployeeCodeClaim`): an ID held by an unfinished Draft is
 * taken, which is the whole point of holding it. `excludeDraftId` lets a draft ignore its own hold.
 *
 * ADVISORY ONLY. `hireEmployee`'s `assertEmployeeCodeUnique`, the reservation check inside
 * `createEmployeeDraftWithReservedCode`, and the two unique indexes remain the authority — this read can
 * go stale between the blur and the create, and is allowed to.
 */
export async function isEmployeeCodeTaken(
  ctx: SessionContext,
  raw: string,
  opts: { excludeDraftId?: string } = {},
): Promise<boolean> {
  const code = normalizeEmployeeCode(raw);
  if (!code) return false;
  return withTenant(
    ctx,
    async (tx) => (await findEmployeeCodeClaim(tx, ctx.tenantId, code, opts)) !== null,
  );
}

/**
 * Create the Draft and TAKE its Employee ID, in one transaction (item 06f0cb8f).
 *
 * This is the reporter's simplified first screen: four questions, then the record exists and its number
 * is theirs. Everything else — profile details, department, salary, bank — is filled in afterwards on the
 * continue form and checked at Activate.
 *
 * THE RULE IS RESOLVED FROM THE LIVE SETUP, exactly as `completeEmployeeDraft` has always done, and for
 * the same reason: a rule remembered on a draft would go stale the moment an administrator edited the
 * setup screen. That decision now happens HERE instead of at the end, which is the actual behaviour
 * change — the ID is judged, issued and held while HR is still looking at the form that asked for it.
 */
/** 06f0cb8f — how many taken running numbers the auto path will step over before giving up. Bounded so a
 *  namespace somebody is actively filling makes the create FAIL with a sentence rather than hang. */
const MAX_AUTO_CODE_SKIPS = 50;

export async function createEmployeeDraftWithReservedCode(
  ctx: SessionContext,
  p: {
    companyId: string;
    fullName: string;
    primaryEmail: string;
    employeeIdMode?: string;
    employeeCode?: string;
  },
): Promise<{ id: string; employeeCode: string }> {
  assertAdmin(ctx);
  const companyId = str(p.companyId);
  if (!companyId) throw new Error('Cannot create the employee record yet: company');

  const rule = await employeeIdRuleFor(ctx, companyId);
  const data: EmployeeDraftData = {
    profile: {
      fullName: str(p.fullName),
      primaryEmail: str(p.primaryEmail),
      employeeCode: str(p.employeeCode),
      employeeIdMode: str(p.employeeIdMode),
    },
    employment: { companyId },
  };
  // The client renders the same four rules; the client is not trusted, so re-run them here.
  const missing = missingToCreate(data, { employeeIdRule: rule });
  if (missing.length > 0) throw new Error(`Cannot create the employee record yet: ${missing.join(', ')}`);

  const decision = resolveEmployeeIdMode(rule, {
    chosen: str(p.employeeIdMode),
    hasCode: str(p.employeeCode) !== undefined,
  });
  const typedCode = str(p.employeeCode);
  // Same refusal `completeEmployeeDraft` has made since bd271009, moved to the screen that now asks:
  // HR typed an ID on purpose and must be told it will not be used, rather than have it quietly dropped.
  if (typedCode && decision.forcedBecause === 'manualNotAllowed') {
    throw new Error(
      `Employee ID "${typedCode}" was entered by hand, but the selected company's Employee ID Auto Running Number Setup does not allow manual entry. Remove it and the next running number will be issued automatically.`,
    );
  }

  return withTenant(ctx, async (tx) => {
    let code: string;
    let configId: string | null = null;
    let number: number | null = null;
    if (decision.mode === 'manual') {
      code = requireEmployeeCode(typedCode);
      const claim = await findEmployeeCodeClaim(tx, ctx.tenantId, code);
      if (claim === 'employment') throw new Error(`Employee ID "${code}" is already in use`);
      if (claim === 'draft') throw new Error(`Employee ID "${code}" is reserved by a draft employee record`);
    } else {
      // Auto. The counter advances INSIDE this transaction, so a refusal further down rolls it back —
      // the same atomicity `hireEmployee` has always had, now anchored to Create instead of to the hire.
      // 06f0cb8f — THE AUTO BRANCH MUST ASK THE SAME QUESTION THE MANUAL ONE DOES.
      //
      // Found in verification. A running number and a hand-keyed code live in the same namespace: this
      // tenant has 22 employments at ISEDECOR numbered A0001..A0014 by hand plus assorted others, and a
      // company WITH a setup can still carry legacy codes from before it. So a counter sitting at 4 can
      // issue ABC0005 when an employment already holds ABC0005 — and because nothing checked, HR was shown
      // that number as "issued and reserved for you" and only found out at Activate, when hireEmployee's
      // own uniqueness check refused. The reservation was never usable and the work is lost late.
      //
      // Skipping a taken number is the right answer rather than failing: the counter is a sequence, gaps in
      // it are already accepted (see the release rule above), and the alternative is a create HR cannot
      // complete without an administrator editing the counter by hand. Bounded, because an unbounded loop
      // against a namespace someone is actively filling is how a create hangs instead of failing.
      let issued = await issueEmployeeCode(tx, ctx.tenantId, companyId);
      for (let attempt = 0; issued && attempt < MAX_AUTO_CODE_SKIPS; attempt += 1) {
        if ((await findEmployeeCodeClaim(tx, ctx.tenantId, issued.code)) === null) break;
        issued = await issueEmployeeCode(tx, ctx.tenantId, companyId);
        if (attempt === MAX_AUTO_CODE_SKIPS - 1 && issued && (await findEmployeeCodeClaim(tx, ctx.tenantId, issued.code)) !== null) {
          throw new Error(
            `The next ${MAX_AUTO_CODE_SKIPS} running numbers for this company are already taken by existing ` +
              `employees or draft records. Check the Employee ID Auto Running Number Setup — its counter is ` +
              `behind the IDs already in use.`,
          );
        }
      }
      if (issued) {
        ({ code, configId, number } = issued);
      } else {
        // A RACE, NOT THE NO-SETUP CASE. Auto mode is only reachable when a rule resolved with
        // `hasConfig` (see `resolveEmployeeIdMode`) — a company with no setup is forced to Manual and the
        // ID is required, which is bd271009's rule and is deliberately not relaxed here: falling silently
        // through to EMP-#### is where the unrecognised IDs used to come from. We land here only if the
        // setup was deactivated between reading the rule and opening this transaction. Issuing the legacy
        // number rather than throwing mirrors `hireEmployee`'s own fallback, so the outcome is an ID that
        // is merely unfashionable instead of a create that fails for reasons HR cannot see.
        // `reserved_config_id` stays null, and the release path reads that null to know it is
        // `tenant_counter` that has to be rolled back.
        const legacy = await issueLegacyEmployeeCode(tx, ctx.tenantId);
        code = legacy.code;
        number = legacy.number;
      }
    }
    data.profile!.employeeCode = code;

    // `employee_draft_reserved_code_uq` (0415) is the race net the check above cannot be: two
    // administrators pressing Create on the same hand-keyed ID in the same second both pass the read and
    // serialize HERE. Caught so the loser gets the sentence the winner's clash would have given them,
    // rather than a raw 23505 — mirroring `isEmployeeCodeUniqueViolation` in core/org.ts.
    let row: { id: string };
    try {
      [row] = await tx
        .insert(employeeDraft)
        .values({
          tenantId: ctx.tenantId,
          companyId,
          createdByPersonId: ctx.personId ?? null,
          label: draftLabel(data),
          data,
          currentStep: 1,
          reservedEmployeeCode: code,
          reservedAt: new Date(),
          reservedConfigId: configId,
          reservedNumber: number,
        })
        .returning({ id: employeeDraft.id });
    } catch (e) {
      if (isReservedCodeUniqueViolation(e)) {
        throw new Error(`Employee ID "${code}" is reserved by a draft employee record`);
      }
      throw e;
    }

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-draft',
      aggregateId: row.id,
      eventType: 'employee-draft.created',
      actor: actorOf(ctx),
      // The reserved code IS on the audit trail, unlike the rest of the payload: an Employee ID that
      // exists but belongs to nobody yet is exactly the thing somebody will later have to account for.
      payload: { companyId, reservedEmployeeCode: code, mode: decision.mode, hasLabel: true },
    });
    return { id: row.id, employeeCode: code };
  });
}

export async function discardEmployeeDraft(ctx: SessionContext, id: string): Promise<void> {
  assertAdmin(ctx);
  await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        reservedEmployeeCode: employeeDraft.reservedEmployeeCode,
        reservedConfigId: employeeDraft.reservedConfigId,
        reservedNumber: employeeDraft.reservedNumber,
      })
      .from(employeeDraft)
      .where(eq(employeeDraft.id, id))
      .limit(1);
    const deleted = await tx
      .delete(employeeDraft)
      .where(eq(employeeDraft.id, id))
      .returning({ id: employeeDraft.id });
    if (deleted.length === 0) throw new Error('Draft not found (or not visible).');
    const released = row ? await releaseReservedNumber(tx, ctx.tenantId, row) : false;
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-draft',
      aggregateId: id,
      eventType: 'employee-draft.discarded',
      actor: actorOf(ctx),
      // `released: false` on a draft that held a number is the GAP, recorded rather than hidden — it is
      // the answer to "why does the sequence skip 0042".
      payload: row?.reservedEmployeeCode
        ? { reservedEmployeeCode: row.reservedEmployeeCode, released }
        : {},
    });
  });
}

/**
 * Give a held number back — ONLY when it is still the tip of its sequence (item 06f0cb8f).
 *
 * THE TRADE-OFF, STATED PLAINLY, because the plan states it to the reporter in the same words: reserving
 * a number early can leave a GAP. If somebody else was created behind this draft, the number in front is
 * already on an employee and rolling the counter back would hand the NEXT hire an ID that exists. So the
 * rollback is conditional in SQL — `where current_running_number = reserved_number` — and any other case
 * simply leaves the gap. That is a documented cost, not a silent failure: the discard event records
 * `released: false`.
 *
 * Returns whether the number was actually given back.
 */
async function releaseReservedNumber(
  tx: Tx,
  tenantId: string,
  r: { reservedEmployeeCode: string | null; reservedConfigId: string | null; reservedNumber: number | null },
): Promise<boolean> {
  if (!r.reservedEmployeeCode || r.reservedNumber == null) return false;
  if (r.reservedConfigId) {
    // Row-locked so a concurrent issue cannot slip between the read and the write and be un-issued.
    const rolled = await tx
      .update(employeeIdConfig)
      .set({
        currentRunningNumber: sql`${employeeIdConfig.currentRunningNumber} - ${employeeIdConfig.increment}`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(employeeIdConfig.id, r.reservedConfigId),
          eq(employeeIdConfig.tenantId, tenantId),
          eq(employeeIdConfig.currentRunningNumber, r.reservedNumber),
        ),
      )
      .returning({ id: employeeIdConfig.id });
    return rolled.length > 0;
  }
  // The legacy per-tenant EMP-#### counter (core/comp.ts). Same shape, same condition: only at the tip.
  const rolled = await tx
    .update(tenantCounter)
    .set({ value: sql`${tenantCounter.value} - 1` })
    .where(
      and(
        eq(tenantCounter.tenantId, tenantId),
        eq(tenantCounter.kind, 'employee_code'),
        eq(tenantCounter.value, r.reservedNumber),
      ),
    )
    .returning({ tenantId: tenantCounter.tenantId });
  return rolled.length > 0;
}

/**
 * Turn a completed draft into a real employee.
 *
 * NOT one transaction, and that is deliberate rather than an oversight: each writer owns its own
 * transaction (this is the same composition `commitEmployeeImport` performs, for the same reason —
 * the services are the contract, not their internals). The consequence is honest and worth stating:
 * if the statutory or compensation write fails, the EMPLOYEE EXISTS and the draft is kept, so HR can
 * see what is missing and finish it on the profile screen. Deleting the employee to "roll back" would
 * be worse — it would silently discard an employment that other tables may already reference.
 *
 * The draft is deleted only after every writer has succeeded.
 */
export async function completeEmployeeDraft(
  ctx: SessionContext,
  id: string,
): Promise<{ employmentId: string }> {
  assertAdmin(ctx);
  const draft = await getEmployeeDraft(ctx, id);
  if (!draft) throw new Error('Draft not found (or not visible).');
  const data = draft.data;

  const p = data.profile ?? {};
  const e = data.employment ?? {};
  const s = data.statutory ?? {};
  const pay = data.payroll ?? {};

  // ── Employee ID (item bd271009, reshaped by 06f0cb8f) ──────────────────────────────────────────
  // A RESERVED DRAFT'S ID IS SETTLED. It was judged against the live setup at Create, issued, and has
  // been held on the row ever since — so it is used verbatim and the numbering rule is NOT consulted
  // again. Re-resolving it here is what would break the reporter's guarantee: an administrator editing
  // the setup between Create and Activate could otherwise change, or refuse, an ID HR has already been
  // shown and may already have printed on an offer letter.
  //
  // A DRAFT WITH NO RESERVATION — every draft written before this item, including the one sitting on
  // production — still takes the bd271009 path below, unchanged, so it activates exactly as it always
  // would have. That is why this is a fork and not a replacement.
  const chosenCompanyId = str(e.companyId);
  const reservedCode = str(draft.reservedEmployeeCode ?? undefined);
  const rule = !reservedCode && chosenCompanyId ? await employeeIdRuleFor(ctx, chosenCompanyId) : null;

  // The client renders the same rules, but the client is not trusted: re-run them here. BOTH rules run —
  // the four Create fields and everything Activate needs — so nothing that used to be checked before an
  // employee existed has stopped being checked. The Employee ID is judged only when it is not already
  // held AND a company is known: demanding an ID before the company that decides its rule has been
  // chosen would report a fault the reporter cannot act on.
  const judgeTheId = !reservedCode && chosenCompanyId !== undefined;
  const missing = [
    ...missingToCreate(data, judgeTheId ? { employeeIdRule: rule } : {}),
    ...missingForCreation(data),
  ];
  if (missing.length > 0) throw new Error(`Cannot create the employee yet: ${missing.join(', ')}`);

  const companyId = chosenCompanyId!;
  const hiredOn = str(e.hiredOn)!;

  const decision = resolveEmployeeIdMode(rule, {
    chosen: p.employeeIdMode,
    hasCode: str(p.employeeCode) !== undefined,
  });
  const typedCode = str(p.employeeCode);
  // "Allow manual override" is OFF for this company's setup — obeyed for the first time (the switch has
  // been stored and displayed since 0261 and read by nothing). Refusing LOUDLY rather than quietly
  // dropping the typed value: HR typed an ID on purpose and must be told it will not be used.
  if (!reservedCode && typedCode && decision.forcedBecause === 'manualNotAllowed') {
    throw new Error(
      `Employee ID "${typedCode}" was entered by hand, but the selected company's Employee ID Auto Running Number Setup does not allow manual entry. Remove it and the next running number will be issued automatically.`,
    );
  }
  // The held code, NEVER blank — handing `hireEmployee` an empty value would run the generator and
  // advance the counter a second time, giving the employee a different ID from the one that has been
  // reserved for them since Create. On an unreserved (pre-06f0cb8f) draft the bd271009 rule still
  // decides: in Auto mode we send NO code, so `hireEmployee` runs the generator, and a code left behind
  // by someone who switched Manual → Auto is ignored rather than used.
  const employeeCodeToIssue = reservedCode ?? (decision.mode === 'manual' ? typedCode : undefined);

  // The company's country pack owns the IC rules (ADR-0080 D1/D6) — resolved from the COMPANY, never
  // from a hardcoded jurisdiction, and fail-loud when the country resolves nothing.
  const country = await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ country: company.country })
      .from(company)
      .where(eq(company.id, companyId))
      .limit(1);
    if (!row) throw new Error('Company not found (or not visible).');
    return row.country;
  });
  const pack = requirePackFor(country);
  const icNumber = str(p.icNumber);
  // Optional (item e3ce0d4d — a non-Malaysian passport holder has no IC) but validated when supplied,
  // because an invalid IC stored now is a payroll fault later.
  if (icNumber && !pack.statutory.validateIC(icNumber)) throw new Error(`Invalid identity number "${icNumber}".`);

  const nationality = str(p.nationality);

  // ── The family, judged BEFORE anything is created (item 759dfc7d) ───────────────────────────────
  // `materialiseDependents` can only run once a PERSON exists, which is to say after `hireEmployee` has
  // committed. So every refusal the dependent writer is capable of has to be provoked HERE, while the
  // cost of one is still nothing: a gender outside the set, a relationship that is neither built-in nor
  // an active catalog option, a relief share that is neither 100 nor 50. The name / relationship /
  // date-format rules were already covered by `missingForCreation` above — between the two, nothing the
  // writer can reject survives to the far side of the hire.
  const family = draftFamilyToDependents(data);
  await assertDependentsValid(ctx, family);

  const types = await listLeaveTypes(ctx);
  const { employmentId, personId } = await hireEmployee(ctx, {
    // 35b7af0a group 8 — the nationality is seeded on the person HERE, at creation, because everything
    // downstream keys on it: the Personnel screen decides NRIC-vs-passport from `person.nationality`, and
    // before this the wizard left it NULL, so a hire it created showed NO Identity No card at all and the
    // number it had just collected was invisible until somebody set a nationality by hand. Undefined on a
    // draft saved before this change ⇒ null ⇒ byte-identical to what the wizard always did.
    person: {
      fullName: str(p.fullName)!,
      primaryEmail: str(p.primaryEmail)!,
      phone: str(p.phone),
      nationality,
    },
    // The ID the draft has been holding since Create (item 06f0cb8f) — so the counter does NOT advance
    // again here, and the employee gets the number HR was promised. On an unreserved pre-06f0cb8f draft
    // this is bd271009's answer instead, and blank ⇒ hireEmployee generates the next code, which is that
    // item's rule that such a draft consumes no Employee ID until this call.
    employeeCode: employeeCodeToIssue,
    // Without this the two-table uniqueness check would refuse the activation on the grounds that the ID
    // is taken — by the very draft being activated.
    fromEmployeeDraftId: reservedCode ? id : undefined,
    companyId,
    departmentId: str(e.departmentId)!,
    positionId: str(e.positionId),
    costCenterId: str(e.costCenterId),
    gradeId: str(e.gradeId) ?? null,
    reportingManagerEmploymentId: str(e.reportingManagerEmploymentId),
    employmentType: (str(e.employmentType) ?? 'full_time') as 'full_time' | 'part_time' | 'contract' | 'intern',
    hiredOn,
    provisionalEndOn: str(e.provisionalEndOn) ?? null,
    grantLeaveTypes: types
      .filter((t) => STANDING_GRANTS.has(t.code))
      .map((t) => ({ id: t.id, code: t.code, yearCycleOverride: t.yearCycleOverride })),
  });

  if (icNumber || hasAnyStatutory(s)) {
    await pack.statutory.set(ctx, {
      personId,
      // Item 35524d1f — null, not ''. The setter used to reject a blank IC, so a draft carrying any statutory
      // detail (an EPF number, a bank account) but no Identity No failed HERE, after hireEmployee had already
      // committed the employee. Nothing in the wizard marks Identity No required, and e3ce0d4d made it
      // optional for passport holders; the statutory row is now stored with a null IC instead.
      icNumber: icNumber ?? null,
      epfNumber: str(s.epfNumber),
      // 35b7af0a group 8 — the SAME IC-derived default `setStatutoryAction` applies on the Personnel card
      // (PERKESO registers locals under their MyKad). It lives in the WRITER, not only in the shared field
      // group, because the group's controlled mode DISPLAYS a default without committing it: an HR user who
      // never touches the box would otherwise create a hire showing a SOCSO number and storing none. Group 7
      // could not do this at all — the default keys on nationality and the wizard did not collect one.
      socsoNumber: pack.statutory.defaultSocsoEisNumber({
        socsoNumber: str(s.socsoNumber),
        icNumber,
        nationality,
      }),
      taxNumber: str(s.taxNumber),
      taxCategory: numOrUndef(s.taxCategory),
      numChildren: numOrUndef(s.numChildren),
      // 35b7af0a group 7 — the wizard now sends the CATEGORY, matching the Personnel screen and item
      // a7271737's consolidation. setStatutoryProfileMY derives the legacy booleans from it.
      //
      // BACK-COMPAT, and it is the whole reason this is not a one-line swap: a draft saved BEFORE this
      // change carries the legacy `eisEligible: 'yes' | 'no'` and no categories at all. Map it forward
      // so that draft still creates exactly the employee it always would have — 'no' is the scheme off,
      // anything else is the automatic derivation, which is what boolOrUndef(...)===false meant.
      socsoCategory: str(s.socsoCategory) as 'auto' | 'first' | 'second' | 'none' | undefined,
      eisCategory:
        (str(s.eisCategory) as 'auto' | 'none' | undefined) ??
        (boolOrUndef(s.eisEligible) === false ? 'none' : undefined),
      isResident: boolOrUndef(s.isResident),
      epfCitizenship: citizenship(s.epfCitizenship),
      bankName: str(s.bankName),
      bankAccountNo: str(s.bankAccountNo),
    });
  }

  // Gender / marital status / date of birth are compliance-gated fields with their own writer. An
  // explicitly typed DOB wins; otherwise the IC derives one, exactly as setIcAction and the importer
  // do (`dobOnlyIfEmpty` guarantees a real value is never overwritten).
  const typedDob = str(p.dateOfBirth);
  const derivedDob = icNumber ? pack.statutory.dobFromIC(icNumber) : null;
  const dob = typedDob ?? derivedDob ?? undefined;
  if (str(p.gender) || str(p.maritalStatus) || dob) {
    try {
      await setPersonComplianceFields(ctx, {
        employmentId,
        ...(str(p.gender) ? { gender: str(p.gender) } : {}),
        ...(str(p.maritalStatus) ? { maritalStatus: str(p.maritalStatus) } : {}),
        ...(dob ? { dateOfBirth: dob, dobOnlyIfEmpty: !typedDob } : {}),
      });
    } catch {
      // Best-effort, matching commitEmployeeImport: the employee exists and is payable; a rejected
      // profile detail must not strand the whole creation.
    }
  }

  await setCompensation(ctx, {
    employmentId,
    basicSalary: Number((pay.basicSalary ?? '').replace(/[,_]/g, '')),
    monthlyAllowance: numOrUndef(pay.monthlyAllowance),
    payMode: str(pay.payMode),
    paymentTerm: str(pay.paymentTerm),
    rateAmount: numOrUndef(pay.rateAmount),
    effectiveFrom: hiredOn,
    remarks: str(pay.remarks),
  });

  // ── MATERIALISE THE FAMILY (item 759dfc7d) ─────────────────────────────────────────────────────
  // The last write before the draft stops existing, and the reason it is last is the child-relief sync:
  // `materialiseDependents` refreshes `employee_statutory_my.num_children` from the register when the
  // person is on automatic child relief, so it has to run AFTER `pack.statutory.set` has written that
  // row — the other order would have the statutory writer overwrite what the family just derived.
  //
  // ALL-OR-NOTHING AMONG THE MEMBERS: every insert is in ONE transaction inside that service, so a
  // failure on the fourth child cannot leave three behind with nothing on screen to say which. It is not,
  // and cannot be, one transaction with the hire — this function has never been one transaction (see the
  // header) and making it one would mean reaching inside four services that own their own. What replaces
  // that guarantee is the `assertDependentsValid` pre-flight above: the set is judged while nothing has
  // been written, so the realistic ways this could fail late have already been spent.
  await materialiseDependents(ctx, { personId, members: family });

  // Only now: the draft has become an employee, so it stops existing as a draft. THE RESERVATION GOES
  // WITH IT — deleting the row releases the held code, and it must, because the employment now carries
  // that same code and two live claims on one ID is the state the hold exists to prevent. Deliberately
  // NOT `releaseReservedNumber`: the number was SPENT, not abandoned, so the counter stays where it is.
  await withTenant(ctx, async (tx) => {
    await tx.delete(employeeDraft).where(eq(employeeDraft.id, id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-draft',
      aggregateId: id,
      eventType: 'employee-draft.completed',
      actor: actorOf(ctx),
      subjectEmploymentId: employmentId,
      payload: { employmentId, companyId, ...(reservedCode ? { reservedEmployeeCode: reservedCode } : {}) },
    });
  });

  return { employmentId };
}

/**
 * THE DRAFT'S FAMILY → THE DEPENDENT WRITER'S INPUT, field for field (item 759dfc7d).
 *
 * EXPORTED SO IT CAN BE TESTED WITHOUT A DATABASE, and tested it is: `test/employee-draft-family.test.ts`
 * §2 walks `DependentInput`'s own keys and fails if any one of them is not carried across. That is the
 * point of the function existing at all rather than being an inline object literal — a field that the
 * Personnel screen gains and this mapping forgets is exactly the silent drop the reporter is describing
 * ("The system should retain all information already entered during Draft status"), and an inline literal
 * gives a test nothing to walk.
 *
 * The conversions are the only judgement here, and each is the same one the rest of this file already
 * makes: '' means absent (`str`), a number arrives as the `<select>`'s string (`numOrUndef`), and an
 * unticked checkbox is `false`/`null` exactly as `extraColumnsForAdd` defaults it. Nothing is dropped
 * for being empty — `null` is passed through so the writer stores a null rather than skipping a column.
 */
export function draftFamilyToDependents(data: EmployeeDraftData): DependentInput[] {
  return draftFamily(data).map(
    (m: EmployeeDraftFamilyMember): DependentInput => ({
      fullName: (m.fullName ?? '').trim(),
      relationship: (m.relationship ?? '').trim(),
      dateOfBirth: str(m.dateOfBirth) ?? null,
      gender: str(m.gender) ?? null,
      icOrPassport: str(m.icOrPassport) ?? null,
      isBeneficiary: m.isBeneficiary ?? false,
      phone: str(m.phone) ?? null,
      remarks: str(m.remarks) ?? null,
      passportNumber: str(m.passportNumber) ?? null,
      residentialAddress: str(m.residentialAddress) ?? null,
      isDeceased: m.isDeceased ?? false,
      deceasedOn: str(m.deceasedOn) ?? null,
      marriageDate: str(m.marriageDate) ?? null,
      marriageStatus: str(m.marriageStatus) ?? null,
      spouseWorking: m.spouseWorking ?? null,
      occupation: str(m.occupation) ?? null,
      companyName: str(m.companyName) ?? null,
      employerAddress: str(m.employerAddress) ?? null,
      isStudent: m.isStudent ?? null,
      schoolName: str(m.schoolName) ?? null,
      studyLevel: str(m.studyLevel) ?? null,
      studyCountry: str(m.studyCountry) ?? null,
      childReliefCategory: str(m.childReliefCategory) ?? null,
      childTaxRelief: m.childTaxRelief ?? null,
      childReliefPercentage: numOrUndef(m.childReliefPercentage) ?? null,
    }),
  );
}

function hasAnyStatutory(s: Record<string, string | undefined>): boolean {
  return Object.values(s).some((v) => (v ?? '').trim() !== '');
}
function numOrUndef(v: string | undefined): number | undefined {
  const s = (v ?? '').replace(/[,_]/g, '').trim();
  if (s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
function boolOrUndef(v: string | undefined): boolean | undefined {
  const s = (v ?? '').trim().toLowerCase();
  if (s === '') return undefined;
  return ['true', 'yes', 'y', '1'].includes(s);
}
function citizenship(v: string | undefined): 'citizen' | 'pr' | 'non_citizen' | undefined {
  const s = (v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (s === 'citizen' || s === 'pr' || s === 'non_citizen') return s;
  return undefined;
}

/**
 * Postgres 23505 on the reservation index specifically.
 *
 * TWO TRAPS, both of which make a naive version silently never match. The driver wraps the Postgres
 * error inside `cause` (the top-level error is a "Failed query:" envelope with no code at all), so the
 * chain has to be walked. And `postgres.js` names the field `constraint_name`, not the `constraint` that
 * node-postgres uses — `core/org.ts`'s twin only appears to work because it falls back to `?? true` and
 * therefore matches ANY unique violation. Both spellings are accepted here so this cannot regress into
 * quietly re-throwing the raw error the day the driver changes.
 */
function isReservedCodeUniqueViolation(e: unknown): boolean {
  type PgErr = { code?: string; constraint?: string; constraint_name?: string; cause?: unknown };
  let cur = e as PgErr | null | undefined;
  for (let i = 0; cur && i < 4; i++) {
    const name = cur.constraint_name ?? cur.constraint ?? '';
    if (cur.code === '23505' && name.includes('reserved_code')) return true;
    cur = cur.cause as PgErr | null | undefined;
  }
  return false;
}

function assertAdmin(ctx: SessionContext): void {
  const roles = ctx.roles ?? [];
  if (!(roles.includes('super_admin') || roles.includes('hr_admin'))) {
    throw new Error('Only an admin can create employees.');
  }
}
