/** Shared formatting for the domain-event log — used by the dashboard widget, the global
 *  audit view, and per-record history cards. Pure (no DB), safe in client or server. */

export function humanizeEvent(type: string): string {
  return type
    .split('.')
    .join(' ')
    .replace(/-/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function relativeTime(d: Date | string, nowMs: number): string {
  const t = typeof d === 'string' ? new Date(d) : d;
  const mins = Math.round((nowMs - t.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days < 30 ? `${days}d ago` : t.toLocaleDateString();
}

export const ACTOR_DOT: Record<string, string> = {
  USER: 'bg-primary',
  SYSTEM: 'bg-muted-foreground',
  AGENT: 'bg-violet-500',
  EXTERNAL: 'bg-amber-500',
  // tolerate lowercase from older rows
  user: 'bg-primary',
  system: 'bg-muted-foreground',
  agent: 'bg-violet-500',
  external: 'bg-amber-500',
};

export const ACTOR_LABEL: Record<string, string> = {
  SYSTEM: 'System',
  AGENT: 'Agent',
  EXTERNAL: 'External',
};

/** aggregateType → the human label + the route it links to (id appended). null = not linkable. */
const AGGREGATE: Record<string, { label: string; href?: (id: string) => string }> = {
  employee: { label: 'Employee', href: (id) => `/admin/personnel/${id}` },
  employment: { label: 'Employee', href: (id) => `/admin/personnel/${id}` },
  person: { label: 'Person' },
  company: { label: 'Company' },
  department: { label: 'Department' },
  position: { label: 'Position' },
  'cost-center': { label: 'Cost center' },
  'leave-request': { label: 'Leave request' },
  'leave-type': { label: 'Leave type' },
  'leave-policy': { label: 'Leave policy' },
  // 4ec5a940 — the remaining leave-config aggregates surfaced on the Leave Audit tab; without these the
  // labels fell back to humanizeEvent (raw slug), which read poorly in the record-type filter + rows.
  'leave-approval-policy': { label: 'Approval policy' },
  'leave-year': { label: 'Leave year' },
  'leave-encashment-policy': { label: 'Encashment policy' },
  'leave-grant': { label: 'Leave grant' },
  'leave-ledger-import': { label: 'Leave balance import' },
  'job-grade': { label: 'Job grade' },
  holiday: { label: 'Holiday' },
  'holiday-group': { label: 'Holiday group' },
  attendance: { label: 'Attendance' },
  'attendance-correction': { label: 'Attendance correction' },
  'profile-change': { label: 'Profile change' },
  'payroll-batch': { label: 'Payroll batch', href: (id) => `/payroll/${id}` },
  payslip: { label: 'Payslip' },
  compensation: { label: 'Basic salary' },
  'employee-statutory-my': { label: 'Statutory profile' },
  'company-statutory-my': { label: 'Company statutory' },
  'role-assignment': { label: 'Role assignment' },
  'reporting-line': { label: 'Reporting line' },
  'statutory-report': { label: 'Statutory report' },
  'employee-import': { label: 'Employee import' },
  'review-cycle': { label: 'Review cycle', href: (id) => `/performance/${id}` },
  'performance-review': { label: 'Performance review', href: (id) => `/performance/review/${id}` },
};

export function aggregateLabel(type: string): string {
  return AGGREGATE[type]?.label ?? humanizeEvent(type);
}
export function aggregateHref(type: string, id: string): string | undefined {
  return AGGREGATE[type]?.href?.(id);
}

/** The module (bounded context) each aggregate belongs to — a stable slug the UI localizes and the CSV
 *  export prints via MODULE_LABEL_EN. New aggregates default to `other` until mapped. (4ec5a940) */
const AGGREGATE_MODULE: Record<string, string> = {
  employee: 'organization',
  employment: 'organization',
  person: 'organization',
  company: 'organization',
  department: 'organization',
  position: 'organization',
  'cost-center': 'organization',
  'job-grade': 'organization',
  'role-assignment': 'organization',
  'reporting-line': 'organization',
  'employee-import': 'organization',
  'profile-change': 'organization',
  'leave-request': 'leave',
  'leave-type': 'leave',
  'leave-policy': 'leave',
  'leave-approval-policy': 'leave',
  'leave-year': 'leave',
  'leave-encashment-policy': 'leave',
  'leave-grant': 'leave',
  'leave-ledger-import': 'leave',
  holiday: 'leave',
  'holiday-group': 'leave',
  attendance: 'attendance',
  'attendance-correction': 'attendance',
  'payroll-batch': 'payroll',
  payslip: 'payroll',
  compensation: 'payroll',
  'employee-statutory-my': 'payroll',
  'company-statutory-my': 'payroll',
  'statutory-report': 'payroll',
  'review-cycle': 'performance',
  'performance-review': 'performance',
};

export const MODULE_KEYS = ['leave', 'organization', 'payroll', 'attendance', 'performance', 'other'] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

/** The stable module slug for an aggregate type (drives the module chip + the module column of the export). */
export function moduleKeyOf(type: string): ModuleKey {
  return (AGGREGATE_MODULE[type] as ModuleKey) ?? 'other';
}

/** English module labels — used by the CSV/XLSX/PDF export headers (kept English for byte-stable,
 *  external-consumer output, mirroring ADR-0047). The on-screen chip is localized in the component. */
export const MODULE_LABEL_EN: Record<ModuleKey, string> = {
  leave: 'Leave',
  organization: 'Organization',
  payroll: 'Payroll',
  attendance: 'Attendance',
  performance: 'Performance',
  other: 'Other',
};

export const ACTION_KINDS = [
  'created',
  'updated',
  'deleted',
  'archived',
  'unarchived',
  'superseded',
  'other',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Classify an event type into a coarse action, from its last dot-segment. Powers the action badge and
 *  the action filter. Archive/unarchive cover activation/deactivation (the codebase soft-archives). */
export function actionOf(eventType: string): ActionKind {
  const last = eventType.split('.').pop() ?? '';
  switch (last) {
    case 'created':
    case 'added':
    case 'granted':
    case 'assigned':
    case 'imported':
      return 'created';
    case 'updated':
    case 'changed':
    case 'edited':
    case 'recalculated':
      return 'updated';
    case 'deleted':
    case 'removed':
    case 'revoked':
      return 'deleted';
    case 'archived':
    case 'deactivated':
    case 'disabled':
      return 'archived';
    case 'unarchived':
    case 'restored':
    case 'activated':
    case 'enabled':
      return 'unarchived';
    case 'superseded':
      return 'superseded';
    default:
      return 'other';
  }
}

/** High-impact actions get an accent in the UI (irreversible or approval-chain changes). */
export function isHighImpactAction(kind: ActionKind): boolean {
  return kind === 'deleted' || kind === 'superseded' || kind === 'archived';
}

/** Field names whose values must never render in the audit UI (PII / financial). */
const SENSITIVE = new Set([
  'bankAccountNo',
  'bank_account_no',
  'icNumber',
  'ic_number',
  'basicSalary',
  'basic_salary',
  'monthlyAllowance',
  'netPay',
  'grossPay',
  'taxNumber',
]);

/** Cap a rendered value so a JSON blob (eligibility rules, service bands) never blows up a row. */
const MAX_VALUE_LEN = 120;
function truncate(s: string): string {
  return s.length > MAX_VALUE_LEN ? `${s.slice(0, MAX_VALUE_LEN - 1)}…` : s;
}

/** Render a payload value for the audit detail, masking sensitive fields. */
export function maskValue(key: string, value: unknown): string {
  if (value == null) return '—';
  if (SENSITIVE.has(key)) {
    const s = String(value);
    return s.length > 4 ? `•••• ${s.slice(-4)}` : '••••';
  }
  if (typeof value === 'object') return truncate(JSON.stringify(value));
  return truncate(String(value));
}

const OBJ = (v: unknown): v is Record<string, unknown> =>
  v != null && typeof v === 'object' && !Array.isArray(v);

/** A single detail line. `changed` marks a before→after comparison (rendered with an accent). */
export type AuditDetailLine = { key: string; value: string; changed?: boolean };

/** Flatten an event payload into readable "key: value" lines for the expandable detail.
 *  Understands, in priority order: the { before, after } snapshot convention (renders a real
 *  "old → new" comparison, changed keys only — 4ec5a940), the { diff: { k: {from,to} } } convention,
 *  the { fields: [...] } names-only convention, then a flat key dump. All values run through maskValue
 *  so any PII/financial key that appears anywhere in a payload (incl. inside a diff) stays masked. */
export function describePayload(payload: unknown): AuditDetailLine[] {
  const p = (payload ?? {}) as Record<string, unknown>;

  // { before, after } snapshot — the richest convention (leave-type / leave-policy / approval / grade /
  // encashment updates). Either side may be null (e.g. a first-time upsert has before = null). Emit one
  // line per key whose serialized value actually changed, old → new; then any remaining flat keys
  // (companyId, recalc, reason, …) after the comparison.
  const before = p.before;
  const after = p.after;
  if (OBJ(before) || OBJ(after)) {
    const b = OBJ(before) ? before : {};
    const a = OBJ(after) ? after : {};
    const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)]));
    const lines: AuditDetailLine[] = [];
    for (const k of keys) {
      const bv = b[k];
      const av = a[k];
      if (JSON.stringify(bv) === JSON.stringify(av)) continue;
      lines.push({ key: k, value: `${maskValue(k, bv)} → ${maskValue(k, av)}`, changed: true });
    }
    if (lines.length === 0 && (OBJ(before) || OBJ(after))) {
      // A before/after pair with no field-level change (e.g. a no-op save) — say so rather than render blank.
      lines.push({ key: 'changed', value: '—' });
    }
    for (const [k, v] of Object.entries(p)) {
      if (k === 'before' || k === 'after') continue;
      lines.push({ key: k, value: maskValue(k, v) });
    }
    return lines;
  }

  if (Array.isArray(p.fields)) {
    return [{ key: 'changed fields', value: (p.fields as string[]).join(', ') }];
  }
  const diff = (p.diff ?? null) as Record<string, { from?: unknown; to?: unknown }> | null;
  if (diff && typeof diff === 'object') {
    return Object.entries(diff).map(([k, v]) => ({
      key: k,
      value: `${maskValue(k, v?.from)} → ${maskValue(k, v?.to)}`,
      changed: true,
    }));
  }
  return Object.entries(p).map(([k, v]) => ({ key: k, value: maskValue(k, v) }));
}
