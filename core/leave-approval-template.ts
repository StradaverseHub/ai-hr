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
import { and, eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { benefitScheme, employmentTypeEnum, leaveApprovalPolicy, leaveApprovalTemplate } from '../db/schema';
import { sanitizeLevels, type LeaveLevelKind } from './leave-approval-policy';

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
 *  Assignment Template screen exposes — leave type, the benefit-scheme scope and the leave-duration
 *  condition — are matched EXACTLY (`is not distinct from`, so null matches null). With all of them left
 *  unset this is byte-for-byte the old fully-wildcard bucket, which is why pre-existing assignments still
 *  upsert onto their own row instead of forking a duplicate (leave_approval_policy_wildcard_uq guarantees
 *  at most one such row per company × leave type). A scheme- or condition-scoped assignment gets its own
 *  row and is resolved by the normal ADR-0071 specificity ladder — no resolution change.
 *
 *  22de47c4 — a benefit scheme IS (company, employment type, grade group), so assigning to a scheme writes
 *  those two dims and the bucket has to key on them. `grade_id is null` keeps LEGACY grade-scoped
 *  assignments (written before this item) out of every bucket: they are never silently upserted onto, so
 *  they stay visible in the assignments list until an administrator re-assigns them deliberately. */
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
 *  implying "all". 22de47c4 made that employee scope the BENEFIT SCHEME, which on the rule is its grade
 *  group + employment type; `gradeId` stays on the type so a legacy grade-scoped assignment can still be
 *  listed (and re-assigned) rather than becoming invisible config that keeps routing. */
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

/** Bulk-assign a template to every (company × leave-type × benefit-scheme) combination. For each one,
 *  upserts the matching assignment row to point at the template and clears its own levels to []. Admin-only;
 *  the leave_approval_policy RLS WITH CHECK (is_admin_for(company_id)) rejects any company outside the
 *  caller's scope.
 *
 *  bb3938b9 — the employee scope and the leave-duration condition (`minDays`/`maxDays`) are OPTIONAL
 *  criteria alongside companies and leave types. Selecting none of a criterion means "applies to all",
 *  which writes null on that dimension — i.e. exactly the row this function has always written, so existing
 *  assignments keep resolving to the same employees.
 *
 *  22de47c4 — that scope is now the BENEFIT SCHEME rather than the individual job grade. No new dimension
 *  and no resolver change was needed: a benefit_scheme IS (company, employment_type, grade_group), and the
 *  rule matrix already scopes on grade group (R41 72800eda) and employment type, both resolved at submit
 *  time from the requester's own assignment — the SAME two axes resolveEffectiveSchemeId matches a scheme
 *  on. So "assign to this scheme" translates exactly into "grade_group_id + employment_type of that
 *  scheme", and an employee inherits the template of the scheme they are in, by construction.
 *
 *  A scheme with NO grade group is refused rather than widened: on the rule a null grade group is a
 *  WILDCARD ("any grade group"), while on a scheme it means "the ungrouped population" — assigning one
 *  would quietly hand the template to everybody in the company on that employment type. Expressing
 *  "ungrouped only" needs a resolver change, so it is reported instead of guessed at. */
export async function assignApprovalTemplate(
  ctx: SessionContext,
  p: {
    templateId: string;
    companyIds: string[];
    leaveTypeIds: string[];
    benefitSchemeIds?: string[];
    minDays?: number | null;
    maxDays?: number | null;
  },
) {
  const companyIds = [...new Set(p.companyIds.filter(Boolean))];
  const leaveTypeIds = [...new Set(p.leaveTypeIds.filter(Boolean))];
  const benefitSchemeIds = [...new Set((p.benefitSchemeIds ?? []).filter(Boolean))];
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

    // The chosen schemes, resolved to the two rule dimensions they stand for. Read once, before any write.
    const schemes = benefitSchemeIds.length
      ? await tx
          .select({
            id: benefitScheme.id,
            name: benefitScheme.name,
            companyId: benefitScheme.companyId,
            gradeGroupId: benefitScheme.gradeGroupId,
            employmentType: benefitScheme.employmentType,
          })
          .from(benefitScheme)
          .where(inArray(benefitScheme.id, benefitSchemeIds))
      : [];
    if (schemes.length !== benefitSchemeIds.length) throw new Error('Benefit scheme not found');
    const ungrouped = schemes.filter((s) => s.gradeGroupId == null);
    if (ungrouped.length) {
      throw new Error(
        `Give ${ungrouped.map((s) => `“${s.name}”`).join(', ')} a grade group before assigning an approval template to it`,
      );
    }
    // Empty scheme selection ⇒ the single wildcard scope (null, null), the pre-22de47c4 shape.
    type Scope = { schemeId: string | null; gradeGroupId: string | null; employmentType: EmploymentType | null };
    const scopesFor = (companyId: string): Scope[] => {
      if (schemes.length === 0) return [{ schemeId: null, gradeGroupId: null, employmentType: null }];
      // A scheme belongs to ONE company; pairing it with another company's rows would write a scope that
      // company has no employees in. Silently skipping is right here — the form offers the schemes of the
      // chosen companies, so a mismatch only happens on a stale submit.
      return schemes
        .filter((s) => s.companyId === companyId)
        .map((s) => ({
          schemeId: s.id,
          gradeGroupId: s.gradeGroupId,
          employmentType: s.employmentType as EmploymentType,
        }));
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
          // scheme id rides along so the audit trail says WHICH scheme was assigned, not just the two
          // dimensions it resolved to.
          await appendEvent(tx, {
            tenantId: ctx.tenantId,
            aggregateType: 'leave-approval-policy',
            aggregateId: ruleId,
            eventType: created ? 'leave-approval-rule.created' : 'leave-approval-rule.updated',
            actor: actorOf(ctx),
            payload: {
              companyId,
              leaveTypeId,
              benefitSchemeId: scope.schemeId,
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
      payload: { templateId: p.templateId, companyIds, leaveTypeIds, benefitSchemeIds, minDays, maxDays, ruleIds },
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
