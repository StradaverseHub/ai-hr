/**
 * fe9c73bc — an eligibility rule's criteria IN WORDS, for the entitlement-configuration reset's archive.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS SMALL. The product explains a rule's scope on screen through
 * `buildOrgCriteriaSections` (core/org-criteria-form.ts) — the axis order, the axis labels and the value
 * labels — plus the two labellers in app/admin/leave/entitlements/templates/leave-type-conditions.ts. That
 * IS the vocabulary, and this file invents none of its own. But those are fed by next-intl translators and
 * session-scoped catalogue reads, neither of which an operator script running as the owner role has, and
 * nothing in core/ turns an `OrgCriteria` object into a sentence. So this helper does exactly that and no
 * more: it REUSES `buildOrgCriteriaSections` (fed with the English strings read straight off
 * messages/en.json and catalogues read as the owner) and `narrowedOrgCriteriaAxes` (which axes a rule
 * actually narrows, in the vocabulary's own order), and joins the result into one line.
 *
 * It lives beside the script rather than in core/ because the reset tool is its only caller. A screen that
 * needs the same sentence should lift `renderCriteriaInWords` into core/org-criteria-form.ts, not import
 * from scripts/.
 *
 * CATALOGUES ARE READ WHOLE, ARCHIVED ROWS INCLUDED, and every profile option is presented as active. The
 * screens filter to active options because they are PICKING; this is NAMING what a rule referenced on the
 * day it was archived, and a value retired since must still be written out rather than left as its raw id.
 */
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  businessUnit,
  company,
  costCenter,
  department,
  jobGrade,
  location,
  position,
  profileOption,
} from '../db/schema';
import { isUnrestrictedOrgCriteria, narrowedOrgCriteriaAxes, type OrgCriteria } from '../core/org-criteria';
import {
  buildOrgCriteriaSections,
  type CriteriaSection,
  type OrgCriteriaCatalogues,
  type OrgCriteriaLabels,
} from '../core/org-criteria-form';
import type { ProfileOptionCategory, ProfileOptionRow } from '../core/profile-options';

/** The sentence an EMPTY criteria object renders to — a real, meaningful value, never a blank cell. */
export const EVERYONE_TEXT = 'Everyone (no restriction)';

/**
 * The three label functions `buildOrgCriteriaSections` wants, read off the English catalogue on disk —
 * the SAME namespaces the adjustments, generate and entitlement-tables screens hand it via next-intl
 * (`admin.leave.adjustmentsCriteria`, `admin.profileOptions.category`, `people.wizard.employmentType`).
 * An unknown key falls back to the key itself, so a missing string can never throw inside a transaction.
 */
export function englishCriteriaLabels(messagesJsonPath: string): OrgCriteriaLabels {
  const m = JSON.parse(readFileSync(messagesJsonPath, 'utf8')) as {
    admin: { leave: { adjustmentsCriteria: Record<string, string> }; profileOptions: { category: Record<string, string> } };
    people: { wizard: { employmentType: Record<string, string> } };
  };
  const crit = m.admin.leave.adjustmentsCriteria;
  const org = m.admin.profileOptions.category;
  const et = m.people.wizard.employmentType;
  return {
    crit: (k) => crit[k] ?? k,
    org: (k) => org[k] ?? k,
    employmentType: (k) => et[k] ?? k,
  };
}

/** Every catalogue a rule can name, for one tenant, read inside the caller's transaction. */
export async function loadCriteriaCatalogues(tx: Tx, tenantId: string): Promise<OrgCriteriaCatalogues> {
  const [companies, departments, grades, positions, costCenters, businessUnits, locations, options] =
    await Promise.all([
      tx
        .select({ id: company.id, name: sql<string>`coalesce(${company.companyLabel}, ${company.legalName})` })
        .from(company)
        .where(eq(company.tenantId, tenantId)),
      tx.select({ id: department.id, name: department.name }).from(department).where(eq(department.tenantId, tenantId)),
      tx.select({ id: jobGrade.id, name: jobGrade.name }).from(jobGrade).where(eq(jobGrade.tenantId, tenantId)),
      tx.select({ id: position.id, title: position.title }).from(position).where(eq(position.tenantId, tenantId)),
      tx
        .select({ id: costCenter.id, code: costCenter.code, name: costCenter.name })
        .from(costCenter)
        .where(eq(costCenter.tenantId, tenantId)),
      tx
        .select({ id: businessUnit.id, code: businessUnit.code, name: businessUnit.name })
        .from(businessUnit)
        .where(eq(businessUnit.tenantId, tenantId)),
      tx
        .select({ id: location.id, code: location.code, name: location.name })
        .from(location)
        .where(eq(location.tenantId, tenantId)),
      tx
        .select({
          id: profileOption.id,
          category: profileOption.category,
          value: profileOption.value,
          label: profileOption.label,
          description: profileOption.description,
          sortOrder: profileOption.sortOrder,
        })
        .from(profileOption)
        .where(eq(profileOption.tenantId, tenantId)),
    ]);
  const profileOptions: Partial<Record<ProfileOptionCategory, ProfileOptionRow[]>> = {};
  for (const o of options) {
    const cat = o.category as ProfileOptionCategory;
    (profileOptions[cat] ??= []).push({ ...o, category: cat, isActive: true });
  }
  return { companies, departments, grades, positions, costCenters, businessUnits, locations, profileOptions };
}

/** The product's own criteria sections — one call, so the two names above cannot be paired wrongly. */
export function criteriaSectionsFor(c: OrgCriteriaCatalogues, labels: OrgCriteriaLabels): CriteriaSection[] {
  return buildOrgCriteriaSections(c, labels);
}

/**
 * `{ gradeIds: [g1], companyIds: [c1] }` → "Company: Acme Sdn Bhd · Job Grade: Grade 1".
 * Axis order and labels are the sections'; a value the catalogue cannot name is written as its raw value
 * rather than dropped, so the record never says less than the rule did.
 */
export function renderCriteriaInWords(
  criteria: OrgCriteria | null | undefined,
  sections: readonly CriteriaSection[],
): string {
  if (isUnrestrictedOrgCriteria(criteria)) return EVERYONE_TEXT;
  const fields = new Map(sections.flatMap((s) => s.fields.map((f) => [f.name, f] as const)));
  const c = (criteria ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  for (const axis of narrowedOrgCriteriaAxes(criteria)) {
    const f = fields.get(axis);
    const label = f?.label ?? axis;
    const raw = c[axis];
    if (Array.isArray(raw)) {
      const values = raw
        .filter((v) => v != null && v !== '')
        .map((v) => f?.options?.find((o) => o.value === String(v))?.label ?? String(v));
      parts.push(`${label}: ${values.join(', ')}`);
    } else {
      parts.push(`${label}: ${String(raw)}`);
    }
  }
  return parts.join(' · ');
}
