/**
 * Board 74a7a074 — names for the record references on ONE page of Audit Trail rows.
 *
 * Presentation only. It reads no domain_event row: it receives the rows the page already loaded through
 * core/read.ts auditEvents (whose filter decides which events a viewer sees), and it looks up the records
 * those rows point at. Nothing here widens or narrows which audit rows are visible.
 *
 * Scale (docs/SCALE-AND-RELEASE-RULES.md rules 2 and 6): one transaction, and at most ONE statement per
 * record kind present on the page, each a set-based `id = any($1::uuid[])` lookup. The statement count is
 * bounded by the number of kinds (AUDIT_ENTITY_KINDS), never by the number of rows, up to the 2,000-row
 * ceiling (lib/pagination.ts ALL_ROW_CEILING). withTenant sets the tenant, row security and jit=off.
 *
 * Scope. Every lookup runs as the viewer under row-level security, so a record the viewer may not read is
 * simply not returned. GLOSSARY: USER, PERSON, EMPLOYEE and EMPLOYMENT are distinct, and person is readable
 * by any admin tenant-wide, so:
 *   - an employment resolves through employment joined to person (employment is company-scoped);
 *   - a personId or userId resolves to a name ONLY when the viewer can see one of that person's
 *     employments (an EXISTS over employment, under the same row security); otherwise it is unavailable.
 * An id that is not returned — deleted, voided or out of scope — is absent from the result, and the screen
 * shows one neutral "Record not available" for all of them, so it never reveals whether a hidden record
 * exists. Company, department and position names are tenant-wide reference data under their own policies.
 *
 * Names are the records' CURRENT names (there is no name history); the screen says so.
 */
import { sql, type SQL } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { auditReferences, structurePayload, type AuditStructureSource } from '../lib/audit-format';
import { isUuid, type AuditEntityKind, type AuditLabels, type AuditResolvedLabel } from '../lib/audit-fields';

type Row = { id: string; label: string | null; code: string | null };

/** One set-based statement per kind. `$ids` is a single uuid[] parameter, never a per-id list. */
const LOOKUPS: Readonly<Record<AuditEntityKind, (ids: SQL) => SQL>> = {
  company: (ids) => sql`select c.id, c.legal_name as label, c.company_label as code from company c where c.id = any(${ids})`,
  employment: (ids) =>
    sql`select e.id, p.full_name as label, e.employee_code as code from employment e join person p on p.id = e.person_id where e.id = any(${ids})`,
  person: (ids) =>
    sql`select p.id, p.full_name as label, null::text as code from person p where p.id = any(${ids})
        and exists (select 1 from employment e where e.person_id = p.id and e.tenant_id = p.tenant_id)`,
  user: (ids) =>
    sql`select u.id, p.full_name as label, null::text as code from app_user u join person p on p.id = u.person_id where u.id = any(${ids})
        and exists (select 1 from employment e where e.person_id = u.person_id and e.tenant_id = u.tenant_id)`,
  department: (ids) => sql`select d.id, d.name as label, d.label as code from department d where d.id = any(${ids})`,
  businessUnit: (ids) => sql`select b.id, b.name as label, b.code from business_unit b where b.id = any(${ids})`,
  position: (ids) => sql`select p.id, p.title as label, p.label as code from "position" p where p.id = any(${ids})`,
  grade: (ids) => sql`select g.id, g.name as label, g.code from job_grade g where g.id = any(${ids})`,
  costCenter: (ids) => sql`select c.id, c.name as label, c.code from cost_center c where c.id = any(${ids})`,
  location: (ids) => sql`select l.id, l.name as label, l.code from location l where l.id = any(${ids})`,
  leaveType: (ids) => sql`select t.id, t.name as label, t.code from leave_type t where t.id = any(${ids})`,
  leaveRequest: (ids) =>
    sql`select r.id, t.name as label, r.start_date::text || ' – ' || r.end_date::text as code
        from leave_request r join leave_type t on t.id = r.leave_type_id where r.id = any(${ids})`,
  leaveApprovalTemplate: (ids) =>
    sql`select a.id, a.name as label, null::text as code from leave_approval_template a where a.id = any(${ids})`,
  payrollBatch: (ids) =>
    sql`select b.id, b.pay_period as label, b.run_seq::text as code from payroll_batch b where b.id = any(${ids})`,
  payComponent: (ids) => sql`select c.id, c.name as label, c.code from pay_component c where c.id = any(${ids})`,
  reviewCycle: (ids) => sql`select c.id, c.name as label, null::text as code from review_cycle c where c.id = any(${ids})`,
};

/** A PostgreSQL uuid[] literal from validated ids (anything not a uuid was never collected). */
const uuidArray = (ids: Iterable<string>) => `{${[...ids].filter(isUuid).join(',')}}`;

/** Resolve every reference in `refs` inside `tx`. Kinds with no ids send no statement. */
export async function resolveAuditReferencesTx(tx: Tx, refs: ReadonlyMap<AuditEntityKind, ReadonlySet<string>>): Promise<AuditLabels> {
  const out: AuditLabels = {};
  for (const [kind, set] of refs) {
    if (set.size === 0) continue;
    const rows = await tx.execute<Row>(LOOKUPS[kind](sql`${uuidArray(set)}::uuid[]`));
    const found: Record<string, AuditResolvedLabel> = {};
    for (const r of rows) if (r.label != null) found[String(r.id).toLowerCase()] = { label: r.label, code: r.code ?? null };
    out[kind] = found;
  }
  return out;
}

/** Names for every record the given (already loaded, already authorized) audit rows point at. */
export async function resolveAuditLabels(ctx: SessionContext, rows: readonly AuditStructureSource[]): Promise<AuditLabels> {
  const refs = auditReferences(rows.map(structurePayload));
  if (refs.size === 0) return {};
  return withTenant(ctx, (tx) => resolveAuditReferencesTx(tx, refs));
}
