/**
 * Lifecycle configuration (ADR-0095) — Module Config: staff, step lists, checklists, access systems,
 * approval levels, custom fields and the request catalogue.
 *
 * Reads fall back to the built-in CHGB defaults (core/lifecycle-defaults.ts) while a tenant has no rows of
 * its own; the first admin save writes the tenant's rows and from then on they are the truth. `loadHandoverDefaults`
 * writes the defaults explicitly (idempotent) for a tenant that wants them as editable rows from day one.
 */
import { and, asc, eq, isNull, notInArray, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import {
  appUser, company, itAssetCatalogue, itProvisionDef, lcCompanyConfig, lcCustomField, lcStaff, lcStepDef, person,
} from '../db/schema';
import {
  ACCESS_SYSTEMS_BY_COMPANY, APPROVAL_LEVELS_BY_COMPANY, ASSET_CATALOGUE, CUSTOM_FIELDS_BY_COMPANY,
  DEFAULT_ACCESS_SYSTEMS, DEFAULT_APPROVAL_LEVELS, OFFBOARDING_PHASES, OFFBOARDING_STEPS, ONBOARDING_PHASES,
  ONBOARDING_STEPS, REQUISITION_BY_COMPANY, REQUISITION_COMMON, RETURN_BY_COMPANY, RETURN_COMMON,
  normaliseCompanyCode, type CaseKind, type CustomFieldType, type ProvisionDefault, type StepDefault, type StepRule,
} from './lifecycle-defaults';
import type { StepDef } from './lifecycle-rules';
import { LEVEL, LifecycleError, clean, recordConfig, requireLevel, withTenant } from './lifecycle-base';

const RULES: readonly StepRule[] = ['always', 'carpark', 'laptop', 'outcome_accepted', 'outcome_rejected'];
export const MAX_STEPS = 60;
export const MAX_CUSTOM_FIELDS = 40;
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

export const slugKey = (label: string): string =>
  label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^([^a-z])/, 'x_$1').slice(0, 40) || 'item';

// ───────────────────────────── module staff ─────────────────────────────
/** Logins an administrator may name as module staff (name + id only). */
export async function listAssignableUsers(ctx: SessionContext): Promise<{ userId: string; name: string }[]> {
  return withTenant(ctx, async (tx) => {
    await requireLevel(tx, null, LEVEL.admin, 'only an administrator manages module staff');
    const rows = await tx.select({ id: appUser.id, name: person.fullName }).from(appUser).leftJoin(person, eq(person.id, appUser.personId)).orderBy(asc(person.fullName), asc(appUser.id)).limit(500);
    return rows.map((r) => ({ userId: r.id, name: r.name ?? 'User' }));
  });
}

export type StaffRow = { id: string; userId: string; name: string; companyId: string | null; level: 'agent' | 'manager' };

export async function listStaff(ctx: SessionContext): Promise<StaffRow[]> {
  return withTenant(ctx, async (tx) => {
    await requireLevel(tx, null, LEVEL.admin, 'only an administrator manages module staff');
    const rows = await tx
      .select({ id: lcStaff.id, userId: lcStaff.userId, companyId: lcStaff.companyId, level: lcStaff.level, name: person.fullName })
      .from(lcStaff)
      .innerJoin(appUser, eq(appUser.id, lcStaff.userId))
      .leftJoin(person, eq(person.id, appUser.personId))
      .orderBy(asc(person.fullName), asc(lcStaff.id));
    return rows.map((r) => ({ ...r, name: r.name ?? 'User', level: r.level as 'agent' | 'manager' }));
  });
}

export async function setStaff(
  ctx: SessionContext,
  p: { userId: string; companyId: string | null; level: 'agent' | 'manager' | null },
): Promise<void> {
  if (p.level !== null && p.level !== 'agent' && p.level !== 'manager') throw new LifecycleError('Level must be agent or manager.');
  await withTenant(ctx, async (tx) => {
    // Group-wide staff need a group admin; a company's staff need that company's admin. RLS also enforces it.
    await requireLevel(tx, p.companyId, LEVEL.admin, 'only an administrator of that company manages its module staff');
    const [u] = await tx.select({ id: appUser.id }).from(appUser).where(eq(appUser.id, p.userId)).limit(1);
    if (!u) throw new LifecycleError('User not found.', 'not_found');
    const scope = p.companyId ? eq(lcStaff.companyId, p.companyId) : isNull(lcStaff.companyId);
    const [existing] = await tx.select({ id: lcStaff.id }).from(lcStaff).where(and(eq(lcStaff.userId, p.userId), scope)).limit(1);
    if (p.level === null) {
      if (existing) await tx.delete(lcStaff).where(eq(lcStaff.id, existing.id));
      return;
    }
    if (existing) await tx.update(lcStaff).set({ level: p.level }).where(eq(lcStaff.id, existing.id));
    else await tx.insert(lcStaff).values({ tenantId: ctx.tenantId, userId: p.userId, companyId: p.companyId, level: p.level });
  });
}

/** Everyone who can be named a handler / assignee for a company: module staff plus administrators. */
export async function staffDirectory(ctx: SessionContext, companyId: string): Promise<{ userId: string; name: string; level: string }[]> {
  return withTenant(ctx, async (tx) => {
    const rows = (await tx.execute(sql`select user_id, full_name, level from app.lc_staff_directory(${companyId}::uuid)`)) as unknown as { user_id: string; full_name: string | null; level: string }[];
    return rows.map((r) => ({ userId: r.user_id, name: r.full_name ?? 'User', level: r.level }));
  });
}

export type CompanyChoice = { id: string; name: string; code: string };

/** Companies the caller serves as module staff (level >= min), for the create forms' company pickers. */
export async function listMyCompanies(ctx: SessionContext, min: number = LEVEL.agent): Promise<CompanyChoice[]> {
  return withTenant(ctx, async (tx) => {
    const rows = (await tx.execute(sql`select c.id, coalesce(c.company_label, c.legal_name) as name, c.company_label as code from company c where app.lc_level(c.id) >= ${min} order by 2`)) as unknown as { id: string; name: string; code: string | null }[];
    return rows.map((r) => ({ id: r.id, name: r.name, code: normaliseCompanyCode(r.code) }));
  });
}

/** Companies the caller is employed by, for the asset request form. */
export async function listMyEmployerCompanies(ctx: SessionContext): Promise<CompanyChoice[]> {
  return withTenant(ctx, async (tx) => {
    if (!ctx.personId) return [];
    const rows = (await tx.execute(sql`select distinct c.id, coalesce(c.company_label, c.legal_name) as name, c.company_label as code from employment e join company c on c.id = e.company_id where e.person_id = ${ctx.personId}::uuid order by 2`)) as unknown as { id: string; name: string; code: string | null }[];
    return rows.map((r) => ({ id: r.id, name: r.name, code: normaliseCompanyCode(r.code) }));
  });
}

/** The caller's own level, for deciding what to show. 0 = a plain requester. */
export async function myLifecycleLevel(ctx: SessionContext, companyId: string | null = null): Promise<number> {
  return withTenant(ctx, async (tx) => (await import('./lifecycle-base')).levelOf(tx, companyId));
}

// ───────────────────────────── step definitions ─────────────────────────────
const toStepDef = (d: StepDefault, i: number): StepDef => ({
  key: d.key, phase: d.phase, label: d.label, ownerTeam: d.ownerTeam, hrms: d.hrms === true, rule: d.rule, sort: (i + 1) * 10,
});
export const defaultStepDefs = (kind: CaseKind): StepDef[] => (kind === 'onboarding' ? ONBOARDING_STEPS : OFFBOARDING_STEPS).map(toStepDef);
export const phaseLabels = (kind: CaseKind): Record<number, string> => (kind === 'onboarding' ? ONBOARDING_PHASES : OFFBOARDING_PHASES);

/** All definitions for a kind INCLUDING inactive (removed) ones; defaults when the tenant has no rows. */
export async function loadStepDefsTx(tx: Tx, kind: CaseKind): Promise<(StepDef & { active: boolean })[]> {
  const rows = await tx.select().from(lcStepDef).where(eq(lcStepDef.kind, kind)).orderBy(asc(lcStepDef.phase), asc(lcStepDef.sort), asc(lcStepDef.stepKey));
  if (rows.length === 0) return defaultStepDefs(kind).map((d) => ({ ...d, active: true }));
  return rows.map((r) => ({
    key: r.stepKey, phase: r.phase, label: r.label, ownerTeam: r.ownerTeam, hrms: r.hrms, rule: r.rule as StepRule, sort: r.sort, active: r.active,
  }));
}

export async function listStepDefs(ctx: SessionContext, kind: CaseKind): Promise<(StepDef & { active: boolean })[]> {
  return withTenant(ctx, async (tx) => {
    await requireLevel(tx, null, LEVEL.agent, 'staff only');
    return loadStepDefsTx(tx, kind);
  });
}

export type StepInput = { key?: string; phase: number; label: string; ownerTeam?: string; hrms?: boolean; rule?: StepRule };

/**
 * Replace a kind's step list (admin). Keys are permanent once used: an existing key keeps its identity and
 * only its wording / owner / phase / order may change; a key absent from the new list is deactivated, never
 * deleted, so steps already ticked on a case stay in that case's history.
 */
export async function saveStepDefs(ctx: SessionContext, kind: CaseKind, steps: StepInput[]): Promise<void> {
  const phases = phaseLabels(kind);
  if (steps.length === 0 || steps.length > MAX_STEPS) throw new LifecycleError(`A checklist needs between 1 and ${MAX_STEPS} steps.`);
  await withTenant(ctx, async (tx) => {
    await requireLevel(tx, null, LEVEL.admin, 'only an administrator edits checklists');
    const current = await loadStepDefsTx(tx, kind);
    const known = new Set(current.map((c) => c.key));
    const seen = new Set<string>();
    const out: StepDef[] = steps.map((s, i) => {
      const label = clean(s.label, 300);
      if (!label) throw new LifecycleError('Every step needs wording.');
      if (!(s.phase in phases)) throw new LifecycleError(`Unknown phase ${s.phase}.`);
      const rule = s.rule ?? 'always';
      if (!RULES.includes(rule)) throw new LifecycleError(`Unknown rule ${rule}.`);
      if (kind === 'onboarding' && (rule === 'outcome_accepted' || rule === 'outcome_rejected')) throw new LifecycleError('Outcome rules apply to offboarding only.');
      if (kind === 'offboarding' && (rule === 'carpark' || rule === 'laptop')) throw new LifecycleError('Car park and laptop rules apply to onboarding only.');
      let key = s.key && KEY_RE.test(s.key) ? s.key : slugKey(label);
      if (!s.key) { let n = 2; const base = key; while (seen.has(key) || known.has(key)) key = `${base}_${n++}`.slice(0, 40); }
      if (seen.has(key)) throw new LifecycleError(`Duplicate step key ${key}.`);
      seen.add(key);
      return { key, phase: s.phase, label, ownerTeam: clean(s.ownerTeam, 100) ?? '', hrms: s.hrms === true, rule, sort: (i + 1) * 10 };
    });
    // Materialise the defaults first so a first-ever save does not silently drop built-in steps it omitted.
    for (const c of current) {
      await tx.insert(lcStepDef).values({ tenantId: ctx.tenantId, kind, stepKey: c.key, phase: c.phase, label: c.label, ownerTeam: c.ownerTeam, hrms: c.hrms, rule: c.rule, sort: c.sort, active: c.active })
        .onConflictDoNothing();
    }
    for (const d of out) {
      const upd = await tx.update(lcStepDef).set({ phase: d.phase, label: d.label, ownerTeam: d.ownerTeam, hrms: d.hrms, rule: d.rule, sort: d.sort, active: true })
        .where(and(eq(lcStepDef.kind, kind), eq(lcStepDef.stepKey, d.key), isNull(lcStepDef.companyId))).returning({ k: lcStepDef.stepKey });
      if (upd.length === 0) {
        await tx.insert(lcStepDef).values({ tenantId: ctx.tenantId, kind, stepKey: d.key, phase: d.phase, label: d.label, ownerTeam: d.ownerTeam, hrms: d.hrms, rule: d.rule, sort: d.sort, active: true });
      }
    }
    const keep = out.map((d) => d.key);
    await tx.update(lcStepDef).set({ active: false }).where(and(eq(lcStepDef.kind, kind), notInArray(lcStepDef.stepKey, keep)));
    await recordConfig(tx, ctx, { eventType: 'lifecycle-config.steps-saved', eventRef: { kind, count: out.length } });
  });
}

export async function resetStepDefs(ctx: SessionContext, kind: CaseKind): Promise<void> {
  await withTenant(ctx, async (tx) => {
    await requireLevel(tx, null, LEVEL.admin, 'only an administrator edits checklists');
    await tx.delete(lcStepDef).where(eq(lcStepDef.kind, kind));
    await recordConfig(tx, ctx, { eventType: 'lifecycle-config.steps-reset', eventRef: { kind } });
  });
}

// ───────────────────────────── provisioning checklists ─────────────────────────────
export type ProvisionItem = { key: string; name: string; sort: number };

async function companyCodeTx(tx: Tx, companyId: string): Promise<string> {
  const [c] = await tx.select({ label: company.companyLabel }).from(company).where(eq(company.id, companyId)).limit(1);
  return normaliseCompanyCode(c?.label);
}

/** The checklist for a requisition or return: common list + the company's extras. Defaults until edited. */
export async function loadProvisionListTx(tx: Tx, kind: 'requisition' | 'return', companyId: string): Promise<ProvisionItem[]> {
  // "No rows at all" means the tenant never edited: read the defaults. Rows that are ALL inactive mean the
  // admin switched everything off, which must not silently fall back to the built-ins.
  const all = await tx.select().from(itProvisionDef).where(eq(itProvisionDef.kind, kind));
  const rows = all.filter((r) => r.active);
  if (all.length === 0) {
    const code = await companyCodeTx(tx, companyId);
    const common = kind === 'requisition' ? REQUISITION_COMMON : RETURN_COMMON;
    const extra = (kind === 'requisition' ? REQUISITION_BY_COMPANY : RETURN_BY_COMPANY)[code] ?? [];
    return [...common, ...extra].map((d) => ({ ...d })).sort((a, b) => a.sort - b.sort);
  }
  return rows
    .filter((r) => r.companyId === null || r.companyId === companyId)
    .map((r) => ({ key: r.itemKey, name: r.name, sort: r.sort }))
    .sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key));
}

export async function listProvisionDefs(ctx: SessionContext, kind: 'requisition' | 'return', companyId: string | null) {
  return withTenant(ctx, async (tx) => {
    await requireLevel(tx, null, LEVEL.agent, 'staff only');
    const rows = await tx.select().from(itProvisionDef).where(eq(itProvisionDef.kind, kind)).orderBy(asc(itProvisionDef.sort));
    if (rows.length === 0) {
      if (companyId === null) return (kind === 'requisition' ? REQUISITION_COMMON : RETURN_COMMON).map((d) => ({ ...d, active: true }));
      const code = await companyCodeTx(tx, companyId);
      return ((kind === 'requisition' ? REQUISITION_BY_COMPANY : RETURN_BY_COMPANY)[code] ?? []).map((d) => ({ ...d, active: true }));
    }
    return rows
      .filter((r) => (companyId === null ? r.companyId === null : r.companyId === companyId))
      .map((r) => ({ key: r.itemKey, name: r.name, sort: r.sort, active: r.active }));
  });
}

/** Replace one scope's list (companyId null = common). An item's key is permanent; absent keys are deactivated. */
export async function saveProvisionDefs(
  ctx: SessionContext, kind: 'requisition' | 'return', companyId: string | null, items: { key?: string; name: string }[],
): Promise<void> {
  if (items.length > 100) throw new LifecycleError('Too many checklist items.');
  await withTenant(ctx, async (tx) => {
    await requireLevel(tx, null, LEVEL.admin, 'only an administrator edits checklists');
    // First-ever save: materialise the built-in lists so the other scopes are not lost.
    const existing = await tx.select().from(itProvisionDef).where(eq(itProvisionDef.kind, kind));
    if (existing.length === 0) await materialiseProvisionDefaultsTx(tx, ctx, kind);
    const scope = companyId ? eq(itProvisionDef.companyId, companyId) : isNull(itProvisionDef.companyId);
    const base = (await tx.select().from(itProvisionDef).where(and(eq(itProvisionDef.kind, kind), scope)));
    const seen = new Set<string>();
    const keepKeys: string[] = [];
    let i = 0;
    for (const it of items) {
      const name = clean(it.name, 200);
      if (!name) throw new LifecycleError('Every checklist item needs a name.');
      let key = it.key && KEY_RE.test(it.key) ? it.key : slugKey(name);
      if (!it.key) { let n = 2; const b = key; while (seen.has(key) || base.some((x) => x.itemKey === key)) key = `${b}_${n++}`.slice(0, 40); }
      if (seen.has(key)) throw new LifecycleError(`Duplicate item key ${key}.`);
      seen.add(key);
      keepKeys.push(key);
      const sort = (++i) * 10;
      const hit = base.find((x) => x.itemKey === key);
      if (hit) await tx.update(itProvisionDef).set({ name, sort, active: true }).where(eq(itProvisionDef.id, hit.id));
      else await tx.insert(itProvisionDef).values({ tenantId: ctx.tenantId, kind, companyId, itemKey: key, name, sort, active: true });
    }
    for (const b of base) if (!keepKeys.includes(b.itemKey)) await tx.update(itProvisionDef).set({ active: false }).where(eq(itProvisionDef.id, b.id));
    await recordConfig(tx, ctx, { eventType: 'lifecycle-config.provisions-saved', eventRef: { kind, count: items.length } });
  });
}

async function materialiseProvisionDefaultsTx(tx: Tx, ctx: SessionContext, kind: 'requisition' | 'return'): Promise<void> {
  const common: readonly ProvisionDefault[] = kind === 'requisition' ? REQUISITION_COMMON : RETURN_COMMON;
  const byCode = kind === 'requisition' ? REQUISITION_BY_COMPANY : RETURN_BY_COMPANY;
  for (const d of common) {
    await tx.insert(itProvisionDef).values({ tenantId: ctx.tenantId, kind, companyId: null, itemKey: d.key, name: d.name, sort: d.sort, active: true }).onConflictDoNothing();
  }
  const companies = await tx.select({ id: company.id, label: company.companyLabel }).from(company);
  for (const c of companies) {
    for (const d of byCode[normaliseCompanyCode(c.label)] ?? []) {
      await tx.insert(itProvisionDef).values({ tenantId: ctx.tenantId, kind, companyId: c.id, itemKey: d.key, name: d.name, sort: d.sort, active: true }).onConflictDoNothing();
    }
  }
}

// ───────────────────────────── per-company: approval levels, access systems ─────────────────────────────
export async function loadCompanyConfigTx(tx: Tx, companyId: string): Promise<{ approvalLevels: 0 | 1 | 2; accessSystems: string[] }> {
  const [row] = await tx.select().from(lcCompanyConfig).where(eq(lcCompanyConfig.companyId, companyId)).limit(1);
  if (row) return { approvalLevels: row.approvalLevels as 0 | 1 | 2, accessSystems: row.accessSystems };
  const code = await companyCodeTx(tx, companyId);
  return {
    approvalLevels: (APPROVAL_LEVELS_BY_COMPANY[code] ?? DEFAULT_APPROVAL_LEVELS) as 0 | 1 | 2,
    accessSystems: [...(ACCESS_SYSTEMS_BY_COMPANY[code] ?? DEFAULT_ACCESS_SYSTEMS)],
  };
}

export async function getCompanyConfig(ctx: SessionContext, companyId: string) {
  return withTenant(ctx, async (tx) => {
    await requireLevel(tx, companyId, LEVEL.agent, 'staff only');
    return loadCompanyConfigTx(tx, companyId);
  });
}

export async function saveCompanyConfig(
  ctx: SessionContext, companyId: string, p: { approvalLevels: number; accessSystems: string[] },
): Promise<void> {
  if (![0, 1, 2].includes(p.approvalLevels)) throw new LifecycleError('Approval levels must be 0, 1 or 2.');
  const systems = [...new Set(p.accessSystems.map((x) => clean(x, 100)).filter((x): x is string => !!x))].slice(0, 60);
  await withTenant(ctx, async (tx) => {
    await requireLevel(tx, companyId, LEVEL.admin, 'only an administrator of the company edits its IT settings');
    await tx.insert(lcCompanyConfig).values({ companyId, tenantId: ctx.tenantId, approvalLevels: p.approvalLevels, accessSystems: systems })
      .onConflictDoUpdate({ target: lcCompanyConfig.companyId, set: { approvalLevels: p.approvalLevels, accessSystems: systems } });
    await recordConfig(tx, ctx, { aggregateId: companyId, eventType: 'lifecycle-config.company-saved', eventRef: { approvalLevels: p.approvalLevels } });
  });
}

// ───────────────────────────── custom fields ─────────────────────────────
export type CustomFieldDef = {
  key: string; label: string; type: CustomFieldType; required: boolean; options: string[]; companyIds: string[]; sort: number; active: boolean;
};
const FIELD_TYPES: readonly CustomFieldType[] = ['text', 'longtext', 'number', 'date', 'yesno', 'choice'];

export async function loadCustomFieldsTx(tx: Tx, kind: CaseKind): Promise<CustomFieldDef[]> {
  const rows = await tx.select().from(lcCustomField).where(eq(lcCustomField.kind, kind)).orderBy(asc(lcCustomField.sort), asc(lcCustomField.fieldKey));
  return rows.map((r) => ({ key: r.fieldKey, label: r.label, type: r.fieldType as CustomFieldType, required: r.required, options: r.options, companyIds: r.companyIds, sort: r.sort, active: r.active }));
}

export async function listCustomFields(ctx: SessionContext, kind: CaseKind): Promise<CustomFieldDef[]> {
  return withTenant(ctx, async (tx) => {
    await requireLevel(tx, null, LEVEL.agent, 'staff only');
    return loadCustomFieldsTx(tx, kind);
  });
}

export async function saveCustomFields(ctx: SessionContext, kind: CaseKind, fields: Partial<CustomFieldDef>[]): Promise<void> {
  if (fields.length > MAX_CUSTOM_FIELDS) throw new LifecycleError(`At most ${MAX_CUSTOM_FIELDS} custom fields per case type.`);
  await withTenant(ctx, async (tx) => {
    await requireLevel(tx, null, LEVEL.admin, 'only an administrator edits custom fields');
    const existing = await loadCustomFieldsTx(tx, kind);
    const seen = new Set<string>();
    const out = fields.map((f, i) => {
      const label = clean(f.label, 120);
      if (!label) throw new LifecycleError('Every custom field needs a name.');
      const type = (f.type ?? 'text') as CustomFieldType;
      if (!FIELD_TYPES.includes(type)) throw new LifecycleError(`Unknown field type ${type}.`);
      const options = (f.options ?? []).map((o) => clean(o, 100)).filter((o): o is string => !!o);
      if (type === 'choice' && options.length === 0) throw new LifecycleError(`Choice field "${label}" needs at least one option.`);
      let key = f.key && KEY_RE.test(f.key) ? f.key : slugKey(label);
      if (!f.key) { const b = key; let n = 2; while (seen.has(key) || existing.some((e) => e.key === key)) key = `${b}_${n++}`.slice(0, 40); }
      if (seen.has(key)) throw new LifecycleError(`Duplicate field key ${key}.`);
      seen.add(key);
      return { key, label, type, required: f.required === true, options: type === 'choice' ? options : [], companyIds: f.companyIds ?? [], sort: (i + 1) * 10 };
    });
    for (const d of out) {
      const row = { tenantId: ctx.tenantId, kind, fieldKey: d.key, label: d.label, fieldType: d.type, required: d.required, options: d.options, companyIds: d.companyIds, sort: d.sort, active: true };
      await tx.insert(lcCustomField).values(row).onConflictDoUpdate({
        target: [lcCustomField.tenantId, lcCustomField.kind, lcCustomField.fieldKey],
        set: { label: d.label, fieldType: d.type, required: d.required, options: d.options, companyIds: d.companyIds, sort: d.sort, active: true },
      });
    }
    // A removed field is deactivated, not deleted: values already stored on cases stay readable as history.
    const keep = out.map((d) => d.key);
    if (existing.length) await tx.update(lcCustomField).set({ active: false }).where(and(eq(lcCustomField.kind, kind), notInArray(lcCustomField.fieldKey, keep)));
    await recordConfig(tx, ctx, { eventType: 'lifecycle-config.fields-saved', eventRef: { kind, count: out.length } });
  });
}

/** Fields that apply to a company (an empty `companyIds` means every company). */
export const fieldsFor = (defs: CustomFieldDef[], companyId: string): CustomFieldDef[] =>
  defs.filter((d) => d.active && (d.companyIds.length === 0 || d.companyIds.includes(companyId)));

/** Validate submitted custom values against the definitions that apply; returns the cleaned map. */
export function cleanCustomValues(defs: CustomFieldDef[], companyId: string, input: Record<string, unknown> | undefined, previous: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...previous };
  const applicable = fieldsFor(defs, companyId);
  for (const f of applicable) {
    const raw = input?.[f.key];
    if (raw === undefined) {
      if (f.required && (out[f.key] === undefined || out[f.key] === '')) throw new LifecycleError(`${f.label} is required.`);
      continue;
    }
    const v = typeof raw === 'string' ? raw.trim() : raw;
    if (v === '' || v === null) {
      if (f.required) throw new LifecycleError(`${f.label} is required.`);
      delete out[f.key];
      continue;
    }
    switch (f.type) {
      case 'number': if (typeof v === 'boolean' || Number.isNaN(Number(v))) throw new LifecycleError(`${f.label} must be a number.`); out[f.key] = Number(v); break;
      case 'date': if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new LifecycleError(`${f.label} must be a date.`); out[f.key] = v; break;
      case 'yesno': out[f.key] = v === true || v === 'Yes' || v === 'yes' || v === 'true' ? 'Yes' : 'No'; break;
      case 'choice': if (!f.options.includes(String(v))) throw new LifecycleError(`${f.label} must be one of: ${f.options.join(', ')}.`); out[f.key] = String(v); break;
      default: out[f.key] = String(v).slice(0, f.type === 'longtext' ? 4000 : 500);
    }
  }
  return out;
}

// ───────────────────────────── request catalogue ─────────────────────────────
export type CatalogueItem = { id: string; itemCode: string; itemName: string; category: 'hardware' | 'software'; description: string | null; approvalLevels: number; active: boolean };

/** Active items for a requester; managers also see inactive ones. Empty until a manager opens Module Config. */
export async function listCatalogue(ctx: SessionContext): Promise<CatalogueItem[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.select().from(itAssetCatalogue).orderBy(asc(itAssetCatalogue.itemCode));
    return rows.map((r) => ({ id: r.id, itemCode: r.itemCode, itemName: r.itemName, category: r.category as 'hardware' | 'software', description: r.description, approvalLevels: r.approvalLevels, active: r.active }));
  });
}

export async function ensureCatalogue(ctx: SessionContext): Promise<number> {
  return withTenant(ctx, async (tx) => {
    await requireLevel(tx, null, LEVEL.manager, 'only a manager maintains the request catalogue');
    const ex = await tx.select({ id: itAssetCatalogue.id }).from(itAssetCatalogue).limit(1);
    if (ex.length) return 0;
    for (const c of ASSET_CATALOGUE) {
      await tx.insert(itAssetCatalogue).values({ tenantId: ctx.tenantId, itemCode: c.itemCode, itemName: c.itemName, category: c.category, description: c.description, approvalLevels: c.approvalLevels });
    }
    await recordConfig(tx, ctx, { eventType: 'lifecycle-config.catalogue-loaded', eventRef: { count: ASSET_CATALOGUE.length } });
    return ASSET_CATALOGUE.length;
  });
}

export async function saveCatalogueItem(
  ctx: SessionContext,
  p: { id?: string; itemCode: string; itemName: string; category: 'hardware' | 'software'; description?: string | null; approvalLevels: number; active?: boolean },
): Promise<{ id: string }> {
  const code = clean(p.itemCode, 20)?.toUpperCase();
  const name = clean(p.itemName, 120);
  if (!code || !name) throw new LifecycleError('Item code and name are required.');
  if (p.category !== 'hardware' && p.category !== 'software') throw new LifecycleError('Category must be hardware or software.');
  if (![1, 2].includes(p.approvalLevels)) throw new LifecycleError('Approval levels must be 1 or 2.');
  return withTenant(ctx, async (tx) => {
    await requireLevel(tx, null, LEVEL.manager, 'only a manager maintains the request catalogue');
    const vals = { itemCode: code, itemName: name, category: p.category, description: clean(p.description, 300), approvalLevels: p.approvalLevels, active: p.active !== false };
    if (p.id) {
      const r = await tx.update(itAssetCatalogue).set(vals).where(eq(itAssetCatalogue.id, p.id)).returning({ id: itAssetCatalogue.id });
      if (!r[0]) throw new LifecycleError('Catalogue item not found.', 'not_found');
      return { id: r[0].id };
    }
    const dup = await tx.select({ id: itAssetCatalogue.id }).from(itAssetCatalogue).where(eq(itAssetCatalogue.itemCode, code)).limit(1);
    if (dup[0]) throw new LifecycleError(`Item code ${code} already exists.`, 'conflict');
    const [r] = await tx.insert(itAssetCatalogue).values({ tenantId: ctx.tenantId, ...vals }).returning({ id: itAssetCatalogue.id });
    return { id: r!.id };
  });
}

// ───────────────────────────── load the CHGB handover defaults as rows ─────────────────────────────
/** Write the built-in reference data as editable rows (idempotent). Admin only. */
export async function loadHandoverDefaults(ctx: SessionContext): Promise<{ steps: number; provisions: number; fields: number; companies: number; catalogue: number }> {
  return withTenant(ctx, async (tx) => {
    await requireLevel(tx, null, LEVEL.admin, 'only an administrator loads reference data');
    let steps = 0;
    for (const kind of ['onboarding', 'offboarding'] as const) {
      for (const d of defaultStepDefs(kind)) {
        const r = await tx.insert(lcStepDef).values({ tenantId: ctx.tenantId, kind, stepKey: d.key, phase: d.phase, label: d.label, ownerTeam: d.ownerTeam, hrms: d.hrms, rule: d.rule, sort: d.sort }).onConflictDoNothing().returning({ k: lcStepDef.stepKey });
        steps += r.length;
      }
    }
    const before = (await tx.select({ id: itProvisionDef.id }).from(itProvisionDef)).length;
    for (const kind of ['requisition', 'return'] as const) await materialiseProvisionDefaultsTx(tx, ctx, kind);
    const provisions = (await tx.select({ id: itProvisionDef.id }).from(itProvisionDef)).length - before;
    const companies = await tx.select({ id: company.id, label: company.companyLabel }).from(company);
    let fields = 0; let cfg = 0;
    for (const c of companies) {
      const code = normaliseCompanyCode(c.label);
      if (!code) continue;
      const hasConfig = APPROVAL_LEVELS_BY_COMPANY[code] !== undefined || ACCESS_SYSTEMS_BY_COMPANY[code] !== undefined;
      if (hasConfig) {
        const r = await tx.insert(lcCompanyConfig).values({ companyId: c.id, tenantId: ctx.tenantId, approvalLevels: APPROVAL_LEVELS_BY_COMPANY[code] ?? DEFAULT_APPROVAL_LEVELS, accessSystems: [...(ACCESS_SYSTEMS_BY_COMPANY[code] ?? DEFAULT_ACCESS_SYSTEMS)] }).onConflictDoNothing().returning({ id: lcCompanyConfig.companyId });
        cfg += r.length;
      }
      for (const kind of ['onboarding', 'offboarding'] as const) {
        for (const [i, f] of (CUSTOM_FIELDS_BY_COMPANY[code]?.[kind] ?? []).entries()) {
          const r = await tx.insert(lcCustomField).values({ tenantId: ctx.tenantId, kind, fieldKey: `${code.toLowerCase()}_${f.key}`.slice(0, 40), label: f.label, fieldType: f.type, options: f.options ?? [], companyIds: [c.id], sort: 100 + i }).onConflictDoNothing().returning({ id: lcCustomField.id });
          fields += r.length;
        }
      }
    }
    let catalogue = 0;
    const ex = await tx.select({ id: itAssetCatalogue.id }).from(itAssetCatalogue).limit(1);
    if (!ex.length) {
      for (const c of ASSET_CATALOGUE) await tx.insert(itAssetCatalogue).values({ tenantId: ctx.tenantId, itemCode: c.itemCode, itemName: c.itemName, category: c.category, description: c.description, approvalLevels: c.approvalLevels });
      catalogue = ASSET_CATALOGUE.length;
    }
    await recordConfig(tx, ctx, { eventType: 'lifecycle-config.defaults-loaded', eventRef: { steps, provisions, fields, catalogue } });
    return { steps, provisions, fields, companies: cfg, catalogue };
  });
}
