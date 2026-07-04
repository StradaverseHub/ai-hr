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
  attendance: { label: 'Attendance' },
  'attendance-correction': { label: 'Attendance correction' },
  'profile-change': { label: 'Profile change' },
  'payroll-batch': { label: 'Payroll batch', href: (id) => `/payroll/${id}` },
  payslip: { label: 'Payslip' },
  compensation: { label: 'Compensation' },
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

/** Render a payload value for the audit detail, masking sensitive fields. */
export function maskValue(key: string, value: unknown): string {
  if (value == null) return '—';
  if (SENSITIVE.has(key)) {
    const s = String(value);
    return s.length > 4 ? `•••• ${s.slice(-4)}` : '••••';
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Flatten an event payload into readable "key: value" lines for the expandable detail.
 *  Understands the { before, after, diff } convention and the { fields: [...] } convention. */
export function describePayload(payload: unknown): { key: string; value: string }[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (Array.isArray(p.fields)) {
    return [{ key: 'changed fields', value: (p.fields as string[]).join(', ') }];
  }
  const diff = (p.diff ?? null) as Record<string, { from?: unknown; to?: unknown }> | null;
  if (diff && typeof diff === 'object') {
    return Object.entries(diff).map(([k, v]) => ({
      key: k,
      value: `${maskValue(k, v?.from)} → ${maskValue(k, v?.to)}`,
    }));
  }
  return Object.entries(p)
    .filter(([k]) => k !== 'before' && k !== 'after')
    .map(([k, v]) => ({ key: k, value: maskValue(k, v) }));
}
