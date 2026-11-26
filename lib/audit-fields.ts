/**
 * Board 74a7a074 — the Audit Trail FIELD REGISTRY: which payload key means which business field, and which
 * kind of record its value points at. Pure (no DB, no server imports), so the on-screen structurer in
 * lib/audit-format.ts, the server resolver in core/audit-labels.ts and the tests all read one map.
 *
 * Presentation only. Nothing here decides who may see an audit row or a referenced record: the rows come
 * from core/read.ts auditEvents, and every name comes from core/audit-labels.ts under row-level security.
 *
 * GLOSSARY: USER, PERSON, EMPLOYEE and EMPLOYMENT are distinct, so they are distinct kinds here. An
 * `employment` reference is labelled "Employee" because that is what an HR reader calls one employment
 * record; a `person` or `user` reference only ever resolves through an employment the viewer can see.
 *
 * Some keys are generic across modules (`batchId`, `componentId`, `cycleId`, `templateId`, `requestId`).
 * They resolve to a record kind only inside the module whose writers use them that way; elsewhere they are
 * unknown ids, which the screen keeps under Technical details rather than guessing at a lookup.
 */
import type { ModuleKey } from './audit-format';

export const AUDIT_ENTITY_KINDS = [
  'company',
  'employment',
  'person',
  'user',
  'department',
  'businessUnit',
  'position',
  'grade',
  'costCenter',
  'location',
  'leaveType',
  'leaveRequest',
  'leaveApprovalTemplate',
  'payrollBatch',
  'payComponent',
  'reviewCycle',
] as const;
export type AuditEntityKind = (typeof AUDIT_ENTITY_KINDS)[number];

/** Label keys, each `components.auditTable.field_<key>` in all six locales. */
export const AUDIT_FIELD_LABEL_KEYS = [
  'company',
  'employee',
  'directSuperior',
  'decidedBy',
  'subordinate',
  'reviewer',
  'person',
  'user',
  'createdBy',
  'updatedBy',
  'changedBy',
  'department',
  'businessUnit',
  'position',
  'grade',
  'costCenter',
  'location',
  'leaveType',
  'leaveRequest',
  'approvalTemplate',
  'payrollRun',
  'payItem',
  'reviewCycle',
  'workflow',
  'rule',
  'effectiveDate',
  'hiredOn',
  'employmentType',
  'reason',
  'name',
  'code',
  'status',
  'description',
  'changedFields',
] as const;
export type AuditFieldLabelKey = (typeof AUDIT_FIELD_LABEL_KEYS)[number];

export type AuditFieldSection = 'record' | 'other';
export type AuditFieldDef = {
  label: AuditFieldLabelKey;
  /** The record kind the value points at. Absent for plain values (dates, codes, text). */
  kind?: AuditEntityKind;
  /** Where a flat (unchanged) value is shown: Record = which record was affected; Other details = the rest. */
  section: AuditFieldSection;
  /** The kind applies only inside these modules (generic key names); elsewhere the value is an unknown id. */
  modules?: readonly ModuleKey[];
};

const ref = (label: AuditFieldLabelKey, kind: AuditEntityKind, modules?: readonly ModuleKey[]): AuditFieldDef => ({
  label,
  kind,
  section: 'record',
  ...(modules ? { modules } : {}),
});
const who = (label: AuditFieldLabelKey): AuditFieldDef => ({ label, kind: 'user', section: 'other' });
const plain = (label: AuditFieldLabelKey): AuditFieldDef => ({ label, section: 'other' });

const FIELDS: Readonly<Record<string, AuditFieldDef>> = {
  companyId: ref('company', 'company'),
  companyIds: ref('company', 'company'),
  scopeCompanyId: ref('company', 'company'),
  employmentId: ref('employee', 'employment'),
  employmentIds: ref('employee', 'employment'),
  subjectEmploymentId: ref('employee', 'employment'),
  managerEmploymentId: { label: 'directSuperior', kind: 'employment', section: 'other' },
  deciderEmploymentId: { label: 'decidedBy', kind: 'employment', section: 'other' },
  subordinateEmploymentId: { label: 'subordinate', kind: 'employment', section: 'other' },
  reviewerEmploymentId: { label: 'reviewer', kind: 'employment', section: 'other' },
  personId: ref('person', 'person'),
  subjectPersonId: ref('person', 'person'),
  userId: who('user'),
  appUserId: who('user'),
  createdByUserId: who('createdBy'),
  updatedByUserId: who('updatedBy'),
  changedByUserId: who('changedBy'),
  departmentId: ref('department', 'department'),
  departmentIds: ref('department', 'department'),
  businessUnitId: ref('businessUnit', 'businessUnit'),
  positionId: ref('position', 'position'),
  gradeId: ref('grade', 'grade'),
  jobGradeId: ref('grade', 'grade'),
  costCenterId: ref('costCenter', 'costCenter'),
  locationId: ref('location', 'location'),
  leaveTypeId: ref('leaveType', 'leaveType'),
  leaveTypeIds: ref('leaveType', 'leaveType'),
  leaveRequestId: ref('leaveRequest', 'leaveRequest'),
  requestId: ref('leaveRequest', 'leaveRequest', ['leave']),
  templateId: ref('approvalTemplate', 'leaveApprovalTemplate', ['leave']),
  payrollBatchId: ref('payrollRun', 'payrollBatch'),
  batchId: ref('payrollRun', 'payrollBatch', ['payroll']),
  runId: ref('payrollRun', 'payrollBatch', ['payroll']),
  payComponentId: ref('payItem', 'payComponent'),
  componentId: ref('payItem', 'payComponent', ['payroll']),
  reviewCycleId: ref('reviewCycle', 'reviewCycle'),
  cycleId: ref('reviewCycle', 'reviewCycle', ['performance']),
  // Workflows and rules live in several module-owned tables with no shared owner; they get a readable
  // label now and their ids stay under Technical details until each owner offers a lookup.
  workflowId: plain('workflow'),
  ruleId: plain('rule'),
  effectiveDate: plain('effectiveDate'),
  hiredOn: plain('hiredOn'),
  employmentType: plain('employmentType'),
  reason: plain('reason'),
  name: plain('name'),
  code: plain('code'),
  status: plain('status'),
  description: plain('description'),
};

/** The registry entry for `key` in `module`, with a module-restricted kind dropped outside its module. */
export function auditFieldDef(key: string, module: ModuleKey): AuditFieldDef | null {
  const def = FIELDS[key];
  if (!def) return null;
  if (def.kind && def.modules && !def.modules.includes(module)) {
    return { label: def.label, section: 'other' };
  }
  return def;
}

/** Every key the registry knows (tests check each has a label in every locale). */
export const AUDIT_FIELD_KEYS: readonly string[] = Object.keys(FIELDS);

/** "effectiveDate" → "Effective date", "carry_forward_max" → "Carry forward max". The fallback for an
 *  unregistered key, matching the English-only humanizeEvent fallback the table already uses. */
export function humanizeFieldKey(key: string): string {
  const words = key
    .replace(/[._-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words.replace(/^\w/, (c) => c.toUpperCase());
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** The record kind an aggregate's own id points at, so the Record section can name the record itself. */
export const AGGREGATE_ENTITY: Readonly<Record<string, AuditEntityKind>> = {
  employee: 'employment',
  employment: 'employment',
  person: 'person',
  company: 'company',
  department: 'department',
  position: 'position',
  'job-grade': 'grade',
  'cost-center': 'costCenter',
  'leave-type': 'leaveType',
  'leave-request': 'leaveRequest',
  'leave-approval-template': 'leaveApprovalTemplate',
  'payroll-batch': 'payrollBatch',
  'review-cycle': 'reviewCycle',
};

/** The label a record kind takes when it names the aggregate itself. */
export const ENTITY_LABEL: Readonly<Record<AuditEntityKind, AuditFieldLabelKey>> = {
  company: 'company',
  employment: 'employee',
  person: 'person',
  user: 'user',
  department: 'department',
  businessUnit: 'businessUnit',
  position: 'position',
  grade: 'grade',
  costCenter: 'costCenter',
  location: 'location',
  leaveType: 'leaveType',
  leaveRequest: 'leaveRequest',
  leaveApprovalTemplate: 'approvalTemplate',
  payrollBatch: 'payrollRun',
  payComponent: 'payItem',
  reviewCycle: 'reviewCycle',
};

/** One resolved record: its current name and, where the record has one, its short code. */
export type AuditResolvedLabel = { label: string; code: string | null };
/** kind → id → resolved label. An id that is absent is "Record not available" — deleted and out of scope
 *  read the same, so the screen never reveals whether a hidden record exists. */
export type AuditLabels = Partial<Record<AuditEntityKind, Readonly<Record<string, AuditResolvedLabel>>>>;

/** How a resolved record reads on screen. Codes are data, not words, so this needs no translation. */
export function formatAuditEntity(kind: AuditEntityKind, r: AuditResolvedLabel): string {
  if (!r.code) return r.label;
  switch (kind) {
    case 'employment':
      return `${r.label} / ${r.code}`;
    case 'payrollBatch':
      return `${r.label} #${r.code}`;
    case 'leaveRequest':
      return `${r.label} ${r.code}`;
    default:
      return `${r.label} (${r.code})`;
  }
}
