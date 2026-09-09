/**
 * 6fadb036 (R17) — Approval Workflow Enhancement under Leave Config.
 *
 * REUSABLE APPROVAL TEMPLATES + a tenant-wide DEFAULT chain + BULK assignment, layered on top of the
 * existing ADR-0071 scoped rule matrix (core/leave-approval-policy.ts). A template is a named, tenant-level
 * ordered chain (same 'direct_manager' | 'hr_admin' vocabulary — the additional approver roles the reporter
 * listed, Dept Head / BU Head / HR Manager / Payroll / Custom Role, remain gated in ADR-0071 §(i) pending
 * org-chart primitives + HR sign-off). "Assigning" a template to a (company × leave-type) pair simply writes
 * a leave_approval_policy row (leave-type-scoped, all other dims wildcard) whose `template_id` points at the
 * template and whose own `levels` is cleared to [] — the template is the single source of truth. Resolution
 * (resolveApprovalChain) is reused unchanged: the template's levels become the effective chain, and the
 * single `is_tenant_default` template sits just above the built-in fallback.
 *
 * Substrate discipline: every write appends a DomainEvent (aggregate 'leave-approval-template' for template
 * mutations; 'leave-approval-policy' for the per-assignment rows, reusing the rule events).
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  employmentTypeEnum,
  entitlementEligibilityRule,
  gradeGroup,
  gradeGroupMember,
  leaveApprovalPolicy,
  leaveApprovalTemplate,
} from '../db/schema';
import { sanitizeLevels, type LeaveLevelKind } from './leave-approval-policy';
import { narrowedOrgCriteriaAxes, type OrgCriteria } from './org-criteria';

type EmploymentType = (typeof employmentTypeEnum.enumValues)[number];

export type ApprovalTemplate = {
  id: string;
  name: string;
  description: string | null;
  levels: LeaveLevelKind[];
  isTenantDefault: boolean;
  active: boolean;
  /** How many active leave_approval_policy rows currently reference this template. */
  assignedCount: number;
};

export type ApprovalTemplateInput = {
  name: string;
  description?: string | null;
  levels: string[];
};

/** Postgres unique-violation (the partial unique index on active template names). Drizzle wraps the
 *  PostgresError, so walk the cause chain for code 23505. */
function isUniqueViolation(e: unknown): boolean {
  let cur = e as { code?: string; cause?: unknown } | null | undefined;
  for (let i = 0; cur && i < 4; i++) {
    if (cur.code === '23505') return true;
    cur = cur.cause as { code?: string; cause?: unknown } | null | undefined;
  }
  return false;
}

function cleanTemplate(p: ApprovalTemplateInput) {
  const name = (p.name ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('Template name is required');
  const levels = sanitizeLevels(p.levels);
  if (levels.length === 0) throw new Error('A template needs at least one approval step');
  const description = p.description?.trim() ? p.description.trim() : null;
  return { name, description, levels };
}

/** SQL predicate isolating a template ASSIGNMENT row: the org-chart dims stay wildcard, while the dims the
 *  Assignment Template screen exposes — leave type, the employee scope and the leave-duration condition —
 *  are matched EXACTLY (`is not distinct from`, so null matches null). With all of them left
 *  unset this is byte-for-byte the old fully-wildcard bucket, which is why pre-existing assignments still
 *  upsert onto their own row instead of forking a duplicate (leave_approval_policy_wildcard_uq guarantees
 *  at most one such row per company × leave type). A scope- or condition-scoped assignment gets its own
 *  row and is resolved by the normal ADR-0071 specificity ladder — no resolution change.
 *
 *  22de47c4 — the employee scope is (employment type, grade group), so the bucket has to key on those two
 *  dims. `grade_id is null` keeps LEGACY grade-scoped assignments (written before that item) out of every
 *  bucket: they are never silently upserted onto, so they stay visible in the assignments list until an
 *  administrator re-assigns them deliberately. The PICKER that supplies the pair changed in 6e9a126e
 *  release three (benefit scheme → entitlement eligibility rule); these two columns did not, which is why
 *  every assignment already saved kept routing untouched across that release. */
function assignmentBucketFilter(
  gradeGroupId: string | null,
  employmentType: EmploymentType | null,
  minDays: number | null,
  maxDays: number | null,
) {
  return sql`business_unit_id is null and department_id is null and position_id is null and grade_id is null
    and grade_group_id is not distinct from ${gradeGroupId}::uuid
    and employment_type is not distinct from ${employmentType}::employment_type
    and min_days is not distinct from ${minDays}::int
    and max_days is not distinct from ${maxDays}::int`;
}

/** List the tenant's templates (active first, then by name), each with its live assignment count. */
export async function listApprovalTemplates(ctx: SessionContext): Promise<ApprovalTemplate[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: leaveApprovalTemplate.id,
        name: leaveApprovalTemplate.name,
        description: leaveApprovalTemplate.description,
        levels: leaveApprovalTemplate.levels,
        isTenantDefault: leaveApprovalTemplate.isTenantDefault,
        active: leaveApprovalTemplate.active,
        assignedCount: sql<number>`(
          select count(*)::int from leave_approval_policy p
          where p.template_id = ${leaveApprovalTemplate.id} and p.active = true
        )`,
      })
      .from(leaveApprovalTemplate)
      .orderBy(sql`${leaveApprovalTemplate.active} desc`, sql`lower(${leaveApprovalTemplate.name})`);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      levels: sanitizeLevels(r.levels),
      isTenantDefault: r.isTenantDefault,
      active: r.active,
      assignedCount: Number(r.assignedCount ?? 0),
    }));
  });
}

/** One assignment row for the assignments screen: which template covers which (company, leave-type).
 *  bb3938b9 adds the criteria the Assignment Template panels carry — the employee scope and the
 *  leave-duration condition — so the list can show what an assignment is actually scoped to instead of
 *  implying "all". That employee scope is the row's grade group + employment type (22de47c4), whatever
 *  named population supplied them; `gradeId` stays on the type so a legacy grade-scoped assignment can
 *  still be listed (and re-assigned) rather than becoming invisible config that keeps routing. */
export type TemplateAssignment = {
  ruleId: string;
  templateId: string;
  companyId: string;
  leaveTypeId: string | null;
  gradeId: string | null;
  gradeGroupId: string | null;
  employmentType: EmploymentType | null;
  minDays: number | null;
  maxDays: number | null;
};

/** List every active template-driven assignment row (across the tenant), for the assignments table. */
export async function listTemplateAssignments(ctx: SessionContext): Promise<TemplateAssignment[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        ruleId: leaveApprovalPolicy.id,
        templateId: leaveApprovalPolicy.templateId,
        companyId: leaveApprovalPolicy.companyId,
        leaveTypeId: leaveApprovalPolicy.leaveTypeId,
        gradeId: leaveApprovalPolicy.gradeId,
        gradeGroupId: leaveApprovalPolicy.gradeGroupId,
        employmentType: leaveApprovalPolicy.employmentType,
        minDays: leaveApprovalPolicy.minDays,
        maxDays: leaveApprovalPolicy.maxDays,
      })
      .from(leaveApprovalPolicy)
      .where(and(eq(leaveApprovalPolicy.active, true), sql`${leaveApprovalPolicy.templateId} is not null`));
    return rows.map((r) => ({
      ruleId: r.ruleId,
      templateId: r.templateId as string,
      companyId: r.companyId,
      leaveTypeId: r.leaveTypeId,
      gradeId: r.gradeId,
      gradeGroupId: r.gradeGroupId,
      employmentType: r.employmentType,
      minDays: r.minDays,
      maxDays: r.maxDays,
    }));
  });
}

/**
 * a6fe37fc R4 FIX — EVERY ACTIVE RULE THAT NARROWS BY BUSINESS UNIT, DEPARTMENT OR POSITION, whatever
 * built it. A read-only projection: it enumerates rows, it ranks nothing.
 *
 * ⚠️ WHY THIS EXISTS BESIDE `listTemplateAssignments`, WHICH READS THE SAME TABLE. That list describes an
 * assignment by its template, company, leave type and EMPLOYEE scope (grade / grade group / employment
 * type / day range) — it deliberately selects none of the three ORG columns, and the assignment table
 * renders none of them. `ruleMatches` reads all three on every request (core/leave-approval-policy.ts),
 * so they decide who approves; since `706d34e8` removed the Workflow Matrix nothing has displayed them
 * (IA §4.1).
 *
 * ⚠️ AND WHY `listLegacyApprovalRules` CANNOT FIND THEM. Its predicate is
 * `template_id is null or leave_type_id is null`, but `convertLegacyApprovalRules` COPIES
 * business_unit_id / department_id / position_id onto each row it expands and STAMPS a template_id
 * (core/leave-approval-consolidation.ts). On a converted tenant — which production is, r94 ran
 * scripts/convert-approval-rules.ts there: 51 assignments converted, and afterwards zero active rules
 * matched that predicate — every org-scoped rule carries a template and a leave type, so that enumeration
 * returns none of them. Filtering it is how the restoration ended up showing nothing on exactly the data
 * it was built for.
 *
 * Tenant-wide, like `listTemplateAssignments`: `leave_approval_policy` is readable across the tenant (the
 * requester resolves their own chain in their own transaction), so the CALLER must trim the result to the
 * companies in view — see app/admin/leave-config/approval-readout.tsx.
 */
export type OrgScopedApprovalRule = {
  id: string;
  companyId: string;
  ruleName: string | null;
  /** null = the rule applies to EVERY leave type. */
  leaveTypeId: string | null;
  businessUnitId: string | null;
  departmentId: string | null;
  positionId: string | null;
  gradeId: string | null;
  gradeGroupId: string | null;
  employmentType: EmploymentType | null;
  minDays: number | null;
  maxDays: number | null;
  /** The row's OWN chain. Empty on a template-driven row, whose effective chain is the template's. */
  levels: LeaveLevelKind[];
  templateId: string | null;
};

/** Every ACTIVE rule carrying at least one of the three org-scope columns, across the tenant. */
export async function listOrgScopedApprovalRules(ctx: SessionContext): Promise<OrgScopedApprovalRule[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: leaveApprovalPolicy.id,
        companyId: leaveApprovalPolicy.companyId,
        ruleName: leaveApprovalPolicy.ruleName,
        leaveTypeId: leaveApprovalPolicy.leaveTypeId,
        businessUnitId: leaveApprovalPolicy.businessUnitId,
        departmentId: leaveApprovalPolicy.departmentId,
        positionId: leaveApprovalPolicy.positionId,
        gradeId: leaveApprovalPolicy.gradeId,
        gradeGroupId: leaveApprovalPolicy.gradeGroupId,
        employmentType: leaveApprovalPolicy.employmentType,
        minDays: leaveApprovalPolicy.minDays,
        maxDays: leaveApprovalPolicy.maxDays,
        levels: leaveApprovalPolicy.levels,
        templateId: leaveApprovalPolicy.templateId,
      })
      .from(leaveApprovalPolicy)
      .where(
        and(
          eq(leaveApprovalPolicy.active, true),
          sql`(${leaveApprovalPolicy.businessUnitId} is not null
               or ${leaveApprovalPolicy.departmentId} is not null
               or ${leaveApprovalPolicy.positionId} is not null)`,
        ),
      )
      .orderBy(leaveApprovalPolicy.companyId, leaveApprovalPolicy.createdAt);
    return rows.map((r) => ({ ...r, levels: sanitizeLevels(r.levels) }));
  });
}

export async function createApprovalTemplate(ctx: SessionContext, p: ApprovalTemplateInput) {
  const c = cleanTemplate(p);
  return withTenant(ctx, async (tx) => {
    let row: { id: string };
    try {
      [row] = await tx
        .insert(leaveApprovalTemplate)
        .values({ tenantId: ctx.tenantId, name: c.name, description: c.description, levels: c.levels })
        .returning({ id: leaveApprovalTemplate.id });
    } catch (e) {
      if (isUniqueViolation(e)) throw new Error('A template with that name already exists');
      throw e;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-approval-template',
      aggregateId: row.id,
      eventType: 'leave-approval-template.created',
      actor: actorOf(ctx),
      payload: { name: c.name, description: c.description, levels: c.levels },
    });
    return { id: row.id };
  });
}

export async function updateApprovalTemplate(ctx: SessionContext, id: string, p: ApprovalTemplateInput) {
  const c = cleanTemplate(p);
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select({ levels: leaveApprovalTemplate.levels, name: leaveApprovalTemplate.name })
      .from(leaveApprovalTemplate)
      .where(eq(leaveApprovalTemplate.id, id))
      .limit(1);
    if (!before) throw new Error('Template not found');
    try {
      await tx
        .update(leaveApprovalTemplate)
        .set({ name: c.name, description: c.description, levels: c.levels, updatedAt: sql`now()` })
        .where(eq(leaveApprovalTemplate.id, id));
    } catch (e) {
      if (isUniqueViolation(e)) throw new Error('A template with that name already exists');
      throw e;
    }
    // Editing levels intentionally changes every assignment's FUTURE resolutions; pending requests keep
    // their snapshotted steps (ADR-0071 §g).
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-approval-template',
      aggregateId: id,
      eventType: 'leave-approval-template.updated',
      actor: actorOf(ctx),
      payload: { before: { name: before.name, levels: sanitizeLevels(before.levels) }, after: c },
    });
    return { id };
  });
}

export async function duplicateApprovalTemplate(ctx: SessionContext, id: string) {
  return withTenant(ctx, async (tx) => {
    const [src] = await tx
      .select({
        name: leaveApprovalTemplate.name,
        description: leaveApprovalTemplate.description,
        levels: leaveApprovalTemplate.levels,
      })
      .from(leaveApprovalTemplate)
      .where(eq(leaveApprovalTemplate.id, id))
      .limit(1);
    if (!src) throw new Error('Template not found');
    // De-dup the "(copy)" suffix among ACTIVE templates so the unique-name index never trips.
    const active = await tx
      .select({ name: leaveApprovalTemplate.name })
      .from(leaveApprovalTemplate)
      .where(eq(leaveApprovalTemplate.active, true));
    const taken = new Set(active.map((a) => a.name.toLowerCase()));
    let name = `${src.name} (copy)`;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${src.name} (copy ${n})`;
    const [row] = await tx
      .insert(leaveApprovalTemplate)
      .values({
        tenantId: ctx.tenantId,
        name,
        description: src.description,
        levels: sanitizeLevels(src.levels),
        isTenantDefault: false,
      })
      .returning({ id: leaveApprovalTemplate.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-approval-template',
      aggregateId: row.id,
      eventType: 'leave-approval-template.duplicated',
      actor: actorOf(ctx),
      payload: { sourceId: id, name },
    });
    return { id: row.id };
  });
}

export async function setApprovalTemplateActive(ctx: SessionContext, id: string, active: boolean) {
  return withTenant(ctx, async (tx) => {
    if (!active) {
      // Block deactivation while any ACTIVE rule references the template — admin must reassign first
      // (deterministic; avoids silently repointing live routing to the fallback chain).
      const [ref] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(leaveApprovalPolicy)
        .where(and(eq(leaveApprovalPolicy.templateId, id), eq(leaveApprovalPolicy.active, true)));
      if (Number(ref?.n ?? 0) > 0) {
        throw new Error('Reassign the leave types using this template before deactivating it');
      }
    }
    await tx
      .update(leaveApprovalTemplate)
      // Deactivating also clears the org-wide-default flag (an inactive template cannot be the default).
      .set({ active, isTenantDefault: active ? undefined : false, updatedAt: sql`now()` })
      .where(eq(leaveApprovalTemplate.id, id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-approval-template',
      aggregateId: id,
      eventType: active ? 'leave-approval-template.activated' : 'leave-approval-template.deactivated',
      actor: actorOf(ctx),
      payload: { active },
    });
    return { id };
  });
}

export async function deleteApprovalTemplate(ctx: SessionContext, id: string) {
  return withTenant(ctx, async (tx) => {
    // Hard delete only when NO policy row (active OR archived) references it — the FK enforces this too,
    // but a pre-check gives a friendly error instead of a raw constraint failure.
    const [ref] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(leaveApprovalPolicy)
      .where(eq(leaveApprovalPolicy.templateId, id));
    if (Number(ref?.n ?? 0) > 0) {
      throw new Error('This template is still assigned — unassign it everywhere, then delete');
    }
    await tx.delete(leaveApprovalTemplate).where(eq(leaveApprovalTemplate.id, id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-approval-template',
      aggregateId: id,
      eventType: 'leave-approval-template.deleted',
      actor: actorOf(ctx),
      payload: { id },
    });
    return { id };
  });
}

/** Set (or clear, with null) the tenant's single org-wide-default template. Flips the flag atomically:
 *  the previous holder is unset in the same transaction. An inactive template cannot become default. */
export async function setTenantDefaultTemplate(ctx: SessionContext, id: string | null) {
  return withTenant(ctx, async (tx) => {
    // Clear whoever currently holds the flag (there is at most one).
    await tx
      .update(leaveApprovalTemplate)
      .set({ isTenantDefault: false, updatedAt: sql`now()` })
      .where(eq(leaveApprovalTemplate.isTenantDefault, true));
    if (id) {
      const [tpl] = await tx
        .select({ active: leaveApprovalTemplate.active })
        .from(leaveApprovalTemplate)
        .where(eq(leaveApprovalTemplate.id, id))
        .limit(1);
      if (!tpl) throw new Error('Template not found');
      if (!tpl.active) throw new Error('Activate the template before making it the default');
      await tx
        .update(leaveApprovalTemplate)
        .set({ isTenantDefault: true, updatedAt: sql`now()` })
        .where(eq(leaveApprovalTemplate.id, id));
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-approval-template',
      aggregateId: id ?? '00000000-0000-0000-0000-000000000000',
      eventType: id ? 'leave-approval-template.tenant-default.set' : 'leave-approval-template.tenant-default.unset',
      actor: actorOf(ctx),
      payload: { templateId: id },
    });
    return { id };
  });
}

// ── THE ASSIGN TEMPLATE PICKER — entitlement eligibility rules, read in the rule matrix's vocabulary ──
//
// 6e9a126e release three — THE PICKER MOVED; THE ROWS DID NOT. This screen used to pick a `benefit_scheme`
// and write the (grade group, employment type) pair that scheme stood for. There has never been a
// `benefit_scheme_id` column on `leave_approval_policy`, so when that layer was removed every assignment
// already saved kept routing exactly as it did — only the SOURCE of the pair changed. It is now the
// ENTITLEMENT ELIGIBILITY RULE (`entitlement_eligibility_rule`), which is where "who is this population" is
// configured after the reset. That is 22de47c4's own reason, pointed at the layer that replaced the one it
// named: pick the thing entitlement is already driven by, so a grade added to a population is picked up by
// approval routing without anyone opening this screen.
//
// AN ELIGIBILITY RULE IS RICHER THAN THE RULE MATRIX, AND THAT IS THE WHOLE DIFFICULTY. A scheme WAS
// (company, employment type, grade group) — the translation was total, three columns to three columns. A
// rule carries the full `OrgCriteria` vocabulary: department, position, division, gender, minimum service,
// probation and the rest. An assignment bucket has exactly two dimensions to put any of that in. Widening
// a rule to the two axes it *does* express would hand the template to every employee the rule deliberately
// left out — the same silent mis-route 22de47c4's ungrouped-scheme refusal existed to prevent. So a rule
// the matrix cannot carry is REFUSED AND NAMED, never approximated.

/** The criteria axes an assignment row can carry. `companyIds` is matched against the companies chosen on
 *  the form (an assignment row already names one company); `employmentTypes` and `gradeIds` become the two
 *  dimensions the bucket writes. Every other axis has nowhere to go — see the block above. */
const ASSIGNABLE_ELIGIBILITY_AXES: ReadonlySet<string> = new Set(['companyIds', 'employmentTypes', 'gradeIds']);

/** `departmentIds` → "department", `minYearsOfService` → "min years of service". Derived from the field
 *  name so an axis added to OrgCriteria reads sensibly in a refusal with no second list to maintain. */
function axisLabel(field: string): string {
  return field
    .replace(/Ids$/, '')
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase()
    .trim();
}

/** One eligibility rule as the Assign Template picker offers it, ALREADY translated into the rule matrix's
 *  vocabulary — so the screen and the service can never disagree about what picking it would write. */
export type EligibilityRuleScope = {
  /** The rule LINEAGE, not a version id. Eligibility rules are effective-dated and an edit closes the
   *  running version and inserts a successor (core/entitlement-template.ts), so the form has to post the
   *  identity that survives an edit — the same reason a rule points at a template lineage rather than a
   *  template row. */
  lineageId: string;
  name: string;
  /** The companies the rule narrows to. EMPTY means the rule names no company axis, i.e. every company. */
  companyIds: string[];
  /** The (grade group × employment type) pairs this rule becomes on `leave_approval_policy`. A rule naming
   *  two employment types is two scopes, exactly as two schemes used to be two scopes. */
  scopes: { gradeGroupId: string | null; employmentType: EmploymentType | null }[];
  /** Why this rule cannot be assigned, or null when it can. One sentence with one source: the screen greys
   *  the tick on it, the service throws it. */
  refusal: string | null;
};

/** Translate the RUNNING version of each eligibility rule into assignment scopes. `lineageIds` omitted =
 *  every rule, which is what the picker lists. */
async function resolveEligibilityRuleScopes(tx: Tx, lineageIds?: string[]): Promise<EligibilityRuleScope[]> {
  const conds = [isNull(entitlementEligibilityRule.validTo)];
  if (lineageIds) conds.push(inArray(entitlementEligibilityRule.lineageId, lineageIds));
  const rules = await tx
    .select({
      lineageId: entitlementEligibilityRule.lineageId,
      name: entitlementEligibilityRule.name,
      criteria: entitlementEligibilityRule.criteria,
    })
    .from(entitlementEligibilityRule)
    .where(and(...conds))
    .orderBy(asc(entitlementEligibilityRule.name));
  if (rules.length === 0) return [];

  // Grade → its group AND group → its full membership, read once. The containment test needs BOTH
  // directions: a rule may only be assigned to a grade group whose every member it names.
  const members = await tx
    .select({ gradeId: gradeGroupMember.gradeId, gradeGroupId: gradeGroupMember.gradeGroupId })
    .from(gradeGroupMember);
  const groupOfGrade = new Map(members.map((m) => [m.gradeId, m.gradeGroupId]));
  const gradesOfGroup = new Map<string, string[]>();
  for (const m of members) gradesOfGroup.set(m.gradeGroupId, [...(gradesOfGroup.get(m.gradeGroupId) ?? []), m.gradeId]);
  const groupNames = new Map(
    (await tx.select({ id: gradeGroup.id, name: gradeGroup.name }).from(gradeGroup)).map((g) => [g.id, g.name]),
  );
  const knownTypes = employmentTypeEnum.enumValues as readonly string[];

  return rules.map((r) => {
    const criteria = (r.criteria ?? {}) as OrgCriteria;
    const out: EligibilityRuleScope = {
      lineageId: r.lineageId,
      name: r.name,
      companyIds: criteria.companyIds ?? [],
      scopes: [],
      refusal: null,
    };
    // A refused rule keeps an EMPTY scope list on purpose: there is no half-assignment to fall back to.
    const refuse = (why: string) => {
      out.refusal = `“${r.name}” ${why}`;
      return out;
    };

    const unexpressible = narrowedOrgCriteriaAxes(criteria).filter((a) => !ASSIGNABLE_ELIGIBILITY_AXES.has(a));
    if (unexpressible.length) {
      return refuse(
        `narrows by ${unexpressible.map(axisLabel).join(', ')}, which an approval rule has no column to scope on. ` +
          `Assigning it would give the template to employees the rule leaves out.`,
      );
    }

    const employmentTypes = criteria.employmentTypes ?? [];
    const unknown = employmentTypes.filter((t) => !knownTypes.includes(t));
    if (unknown.length) return refuse(`names an employment type this system does not have (${unknown.join(', ')}).`);

    const gradeIds = criteria.gradeIds ?? [];
    let gradeGroupIds: (string | null)[] = [null];
    if (gradeIds.length) {
      // NOTE the asymmetry with the scheme refusal this replaces. A scheme with no grade group meant "the
      // UNGROUPED population", which a null on the rule (a wildcard) would have widened — so it was refused.
      // A rule that names no grade at all genuinely means "any grade", and a wildcard says exactly that. It
      // is the rule that names SOME grades that has to be checked, below.
      const ungrouped = gradeIds.filter((g) => !groupOfGrade.has(g));
      if (ungrouped.length) {
        return refuse(
          `lists job grades that are in no grade group. Approval routing scopes by grade GROUP, so put every ` +
            `grade the rule names into a group first.`,
        );
      }
      const picked = [...new Set(gradeIds.map((g) => groupOfGrade.get(g)!))];
      const named = new Set(gradeIds);
      const partial = picked.filter((gg) => (gradesOfGroup.get(gg) ?? []).some((g) => !named.has(g)));
      if (partial.length) {
        return refuse(
          `covers only part of grade group ${partial.map((gg) => `“${groupNames.get(gg) ?? gg}”`).join(', ')}. ` +
            `An approval rule can only scope to a WHOLE grade group, so assigning it would reach grades the ` +
            `rule does not cover.`,
        );
      }
      gradeGroupIds = picked;
    }

    out.scopes = gradeGroupIds.flatMap((gradeGroupId) =>
      (employmentTypes.length ? employmentTypes : [null]).map((employmentType) => ({
        gradeGroupId,
        employmentType: employmentType as EmploymentType | null,
      })),
    );
    return out;
  });
}

/** The picker's feed. The SAME translation the assignment itself runs, so the screen can never offer a rule
 *  the service would refuse — nor hide one it would accept. */
export async function listEligibilityRuleScopes(ctx: SessionContext): Promise<EligibilityRuleScope[]> {
  return withTenant(ctx, (tx) => resolveEligibilityRuleScopes(tx));
}

/** Bulk-assign a template to every (company × leave-type × eligibility-rule scope) combination. For each
 *  one, upserts the matching assignment row to point at the template and clears its own levels to [].
 *  Admin-only; the leave_approval_policy RLS WITH CHECK (is_admin_for(company_id)) rejects any company
 *  outside the caller's scope.
 *
 *  bb3938b9 — the employee scope and the leave-duration condition (`minDays`/`maxDays`) are OPTIONAL
 *  criteria alongside companies and leave types. Selecting none of a criterion means "applies to all",
 *  which writes null on that dimension — i.e. exactly the row this function has always written, so existing
 *  assignments keep resolving to the same employees.
 *
 *  22de47c4 — that scope is the employee POPULATION rather than the individual job grade, and it needed no
 *  new dimension and no resolver change: the rule matrix already scopes on grade group (R41 72800eda) and
 *  employment type, both resolved at submit time from the requester's own assignment. So "assign to this
 *  population" translates into "grade_group_id + employment_type of that population", and an employee
 *  inherits the template of the population they are in, by construction. See the block above for what now
 *  names that population, and for the rules that cannot be translated and are refused instead. */
export async function assignApprovalTemplate(
  ctx: SessionContext,
  p: {
    templateId: string;
    companyIds: string[];
    leaveTypeIds: string[];
    eligibilityRuleIds?: string[];
    minDays?: number | null;
    maxDays?: number | null;
  },
) {
  const companyIds = [...new Set(p.companyIds.filter(Boolean))];
  const leaveTypeIds = [...new Set(p.leaveTypeIds.filter(Boolean))];
  const eligibilityRuleIds = [...new Set((p.eligibilityRuleIds ?? []).filter(Boolean))];
  const minDays = p.minDays ?? null;
  const maxDays = p.maxDays ?? null;
  if (!p.templateId) throw new Error('Choose a template to assign');
  if (companyIds.length === 0) throw new Error('Choose at least one company');
  if (leaveTypeIds.length === 0) throw new Error('Choose at least one leave type');
  if (minDays !== null && (!Number.isInteger(minDays) || minDays < 0)) throw new Error('Condition days must be a whole number of 0 or more');
  if (maxDays !== null && (!Number.isInteger(maxDays) || maxDays < 0)) throw new Error('Condition days must be a whole number of 0 or more');
  if (minDays !== null && maxDays !== null && minDays > maxDays) throw new Error('The condition range starts after it ends');
  return withTenant(ctx, async (tx) => {
    const [tpl] = await tx
      .select({ id: leaveApprovalTemplate.id, active: leaveApprovalTemplate.active })
      .from(leaveApprovalTemplate)
      .where(eq(leaveApprovalTemplate.id, p.templateId))
      .limit(1);
    if (!tpl) throw new Error('Template not found');
    if (!tpl.active) throw new Error('Activate the template before assigning it');

    // The chosen rules, translated to the two rule dimensions they stand for. Read once, BEFORE any write,
    // so a refusal leaves nothing half-assigned behind it.
    const picked = eligibilityRuleIds.length ? await resolveEligibilityRuleScopes(tx, eligibilityRuleIds) : [];
    if (picked.length !== eligibilityRuleIds.length) throw new Error('Eligibility rule not found');
    const refused = picked.filter((r) => r.refusal);
    if (refused.length) throw new Error(refused.map((r) => r.refusal).join(' '));

    // Empty rule selection ⇒ the single wildcard scope (null, null), the pre-bb3938b9 shape.
    type Scope = { ruleLineageId: string | null; gradeGroupId: string | null; employmentType: EmploymentType | null };
    const scopesFor = (companyId: string): Scope[] => {
      if (picked.length === 0) return [{ ruleLineageId: null, gradeGroupId: null, employmentType: null }];
      const out: Scope[] = [];
      const seen = new Set<string>();
      for (const r of picked) {
        // A rule that NAMES companies applies to those; one that names none applies to every company and so
        // pairs with whichever companies the form chose. Pairing a company-scoped rule with a company it
        // does not name would write a scope that company has no employees in; silently skipping is right
        // here — the form offers the rules of the chosen companies, so it only happens on a stale submit.
        if (r.companyIds.length && !r.companyIds.includes(companyId)) continue;
        for (const s of r.scopes) {
          // Two rules can land on the SAME (grade group, employment type) pair — they are different names
          // for one population as far as approval routing is concerned. One bucket is one row, so writing
          // it twice would double the audit trail and hand the same ruleId back twice.
          const key = `${s.gradeGroupId ?? ''}|${s.employmentType ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ ruleLineageId: r.lineageId, gradeGroupId: s.gradeGroupId, employmentType: s.employmentType });
        }
      }
      return out;
    };

    const ruleIds: string[] = [];
    for (const companyId of companyIds) {
      for (const leaveTypeId of leaveTypeIds) {
        for (const scope of scopesFor(companyId)) {
          const [existing] = await tx
            .select({ id: leaveApprovalPolicy.id, templateId: leaveApprovalPolicy.templateId })
            .from(leaveApprovalPolicy)
            .where(
              and(
                eq(leaveApprovalPolicy.companyId, companyId),
                eq(leaveApprovalPolicy.leaveTypeId, leaveTypeId),
                assignmentBucketFilter(scope.gradeGroupId, scope.employmentType, minDays, maxDays),
              ),
            )
            .limit(1);
          let ruleId: string;
          let created: boolean;
          if (existing) {
            await tx
              .update(leaveApprovalPolicy)
              .set({ templateId: p.templateId, levels: [], active: true, updatedAt: sql`now()` })
              .where(eq(leaveApprovalPolicy.id, existing.id));
            ruleId = existing.id;
            created = false;
          } else {
            const [ins] = await tx
              .insert(leaveApprovalPolicy)
              .values({
                tenantId: ctx.tenantId,
                companyId,
                leaveTypeId,
                gradeGroupId: scope.gradeGroupId,
                employmentType: scope.employmentType,
                minDays,
                maxDays,
                templateId: p.templateId,
                levels: [],
                active: true,
              })
              .returning({ id: leaveApprovalPolicy.id });
            ruleId = ins.id;
            created = true;
          }
          ruleIds.push(ruleId);
          // Per-row substrate event on the policy aggregate (reuse the rule events with before/after). The
          // eligibility-rule lineage rides along so the audit trail says WHICH population was assigned, not
          // just the two dimensions it resolved to.
          await appendEvent(tx, {
            tenantId: ctx.tenantId,
            aggregateType: 'leave-approval-policy',
            aggregateId: ruleId,
            eventType: created ? 'leave-approval-rule.created' : 'leave-approval-rule.updated',
            actor: actorOf(ctx),
            payload: {
              companyId,
              leaveTypeId,
              eligibilityRuleId: scope.ruleLineageId,
              gradeGroupId: scope.gradeGroupId,
              employmentType: scope.employmentType,
              minDays,
              maxDays,
              before: existing ? { templateId: existing.templateId } : null,
              after: { templateId: p.templateId },
            },
          });
        }
      }
    }
    // Command-level event on the template aggregate.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-approval-template',
      aggregateId: p.templateId,
      eventType: 'leave-approval-template.assigned',
      actor: actorOf(ctx),
      payload: { templateId: p.templateId, companyIds, leaveTypeIds, eligibilityRuleIds, minDays, maxDays, ruleIds },
    });
    return { ruleIds };
  });
}

/** Unassign a template from one (company, leave-type): soft-archive the assignment row so resolution
 *  falls back to the company default / tenant default. */
export async function unassignApprovalTemplate(ctx: SessionContext, ruleId: string, companyId: string) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ templateId: leaveApprovalPolicy.templateId, leaveTypeId: leaveApprovalPolicy.leaveTypeId })
      .from(leaveApprovalPolicy)
      .where(and(eq(leaveApprovalPolicy.id, ruleId), eq(leaveApprovalPolicy.companyId, companyId)))
      .limit(1);
    await tx
      .update(leaveApprovalPolicy)
      .set({ active: false, updatedAt: sql`now()` })
      .where(and(eq(leaveApprovalPolicy.id, ruleId), eq(leaveApprovalPolicy.companyId, companyId)));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-approval-policy',
      aggregateId: ruleId,
      eventType: 'leave-approval-rule.archived',
      actor: actorOf(ctx),
      payload: { companyId, templateId: row?.templateId ?? null, leaveTypeId: row?.leaveTypeId ?? null },
    });
    return { id: ruleId };
  });
}
