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

/**
 * aggregateType → the human label + the route it links to (id appended). No `href` = not linkable.
 *
 * 47609f53 — `adminOnly` records WHO MAY OPEN the href, on the SAME record as the href itself so the
 * two can never drift. It is not a permission: the destination page is the authority (each one is
 * cited below). This flag only decides whether the reader is OFFERED the link, so a reader who would
 * be bounced sees the plain label instead of a link back to where they started.
 *
 *   /admin/personnel/{id}    → scopedAdmin() (lib/scope.ts) → requireAdmin → redirect('/')   admin-only
 *   /payroll/{id}            → requireAdmin()                                                admin-only
 *   /performance/{id}        → requireAdmin()                                                admin-only
 *   /performance/review/{id} → getSession() + reviewForViewer (RLS: performance_review_rls is
 *                              USING can_see_employment — the SAME predicate domain_event_read
 *                              filters this feed by), so anyone who can SEE the row can OPEN it.
 *                              NOT admin-only, and must stay linked for subject + reviewer.
 */
const AGGREGATE: Record<string, { label: string; href?: (id: string) => string; adminOnly?: boolean }> = {
  employee: { label: 'Employee', href: (id) => `/admin/personnel/${id}`, adminOnly: true },
  employment: { label: 'Employee', href: (id) => `/admin/personnel/${id}`, adminOnly: true },
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
  // f1b994e3 — the six leave aggregates the retired Leave Audit page could never show (its own
  // hardcoded eight-type list gated them out). They are options in the Area=Leave record-type filter
  // now, so they get real labels instead of the humanizeEvent slug fallback, for the reason the
  // 4ec5a940 note above gives.
  'scheme-leave-entitlement': { label: 'Entitlement scheme' },
  'leave-ledger': { label: 'Leave balance' },
  'leave-approval-template': { label: 'Approval template' },
  'scheme-leave-combined-limit': { label: 'Combined limit' },
  'leave-shared-group': { label: 'Shared leave group' },
  'holiday-group-holiday': { label: 'Holiday calendar entry' },
  attendance: { label: 'Attendance' },
  'attendance-correction': { label: 'Attendance correction' },
  'profile-change': { label: 'Profile change' },
  'payroll-batch': { label: 'Payroll batch', href: (id) => `/payroll/${id}`, adminOnly: true },
  payslip: { label: 'Payslip' },
  compensation: { label: 'Basic salary' },
  'employee-statutory-my': { label: 'Statutory profile' },
  'company-statutory-my': { label: 'Company statutory' },
  'role-assignment': { label: 'Role assignment' },
  'reporting-line': { label: 'Reporting line' },
  'statutory-report': { label: 'Statutory report' },
  'employee-import': { label: 'Employee import' },
  'review-cycle': { label: 'Review cycle', href: (id) => `/performance/${id}`, adminOnly: true },
  'performance-review': { label: 'Performance review', href: (id) => `/performance/review/${id}` },
};

export function aggregateLabel(type: string): string {
  return AGGREGATE[type]?.label ?? humanizeEvent(type);
}
export function aggregateHref(type: string, id: string): string | undefined {
  return AGGREGATE[type]?.href?.(id);
}

/**
 * 47609f53 — may THIS reader open the aggregate's destination? False for an unlinkable type (there is
 * nothing to open) and for an `adminOnly` destination when the reader is not an admin.
 *
 * Deliberately takes a plain boolean rather than a SessionContext: this module is pure (no DB, no
 * server imports, safe in a client component per the header note) and importing lib/authz would drag
 * next/navigation + core/entitlements in with it. Callers pass `isAdmin(s)`.
 *
 * The dashboard's Recent activity card is the reason this exists. Its feed is RLS-confined by
 * domain_event_read (0037), which for a non-admin admits only rows whose subject they can see — in
 * practice `employment` rows (whose href is the admin Personnel screen) and `performance-review` rows
 * (whose href they CAN open). The employment rows were rendered as links to a page that redirects
 * them straight back to the dashboard; they now render as plain text. Nothing is hidden and nobody
 * gains access — only whether a row LOOKS clickable changes.
 */
export function canOpenAggregate(type: string, viewerIsAdmin: boolean): boolean {
  const e = AGGREGATE[type];
  if (e?.href == null) return false;
  return e.adminOnly !== true || viewerIsAdmin;
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
  // f1b994e3 — the mapping gap the retired Leave Audit page hid. These six aggregate types were written
  // to the ledger by the leave services but had no module, so they chipped `Other` on the central page
  // and were excluded outright by the leave page's hardcoded eight-type list — 394 production rows
  // invisible on both, including the newest leave-config changes on the system. They are leave.
  'scheme-leave-entitlement': 'leave',
  'leave-ledger': 'leave',
  'leave-approval-template': 'leave',
  'scheme-leave-combined-limit': 'leave',
  'leave-shared-group': 'leave',
  'holiday-group-holiday': 'leave',
  // f1b994e3 — the SEVENTH entry, beyond the six the plan enumerates. The plan's promised Leave count
  // (1,231) is arithmetic that only closes if leave-cancellation-request counts as leave, and
  // lib/approval-history.ts ALREADY maps it to the leave module (aggregateTypesOfModule('leave') is
  // ['leave-request', 'leave-cancellation-request']). Leaving it out would chip a cancellation `Other`
  // while its sibling request chips `Leave`, which is the exact disagreement this item removes.
  'leave-cancellation-request': 'leave',
  // NOTE: `job-grade` deliberately stays `organization` above. The retired leave page listed grade
  // changes among its leave rows, but the central page has always CHIPPED them Organization — honouring
  // the one mapping removes that contradiction rather than creating one (f1b994e3 plan, "Good to know").
  attendance: 'attendance',
  'attendance-correction': 'attendance',
  // 1c1b321a — a recompute run is filed as its own aggregate so the whole run is one audit row rather
  // than one per changed day. Without this it chips as 'Other' and the Attendance area filter cannot
  // find it, which the plan promised it would.
  'attendance-recompute': 'attendance',
  // 23390097 — roster writes (single cell, row Edit, and one row per upload) carry before/after. Same
  // reason: the plan promises they appear under Attendance in the Audit Trail.
  'roster-assignment': 'attendance',
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

/** Is `v` one of the Area (module) slugs? Guards the `?module=` query param on the Audit Trail. */
export function isModuleKey(v: string | null | undefined): v is ModuleKey {
  return v != null && (MODULE_KEYS as readonly string[]).includes(v);
}

/**
 * f1b994e3 — every aggregate type belonging to `module`, DERIVED FROM AGGREGATE_MODULE rather than
 * hand-listed. This is the whole point: the Area filter that finds a row and the module chip the row
 * renders read the same map, so they cannot disagree — the failure the retired Leave Audit page had,
 * where its own hardcoded eight-type list both hid 404 real leave rows and listed job-grade rows that
 * the chip called Organization.
 *
 * `other` is the RESIDUAL bucket and owns no entries of its own: it means "no mapping", so a caller
 * filtering for it must ask for the COMPLEMENT of MAPPED_AGGREGATE_TYPES (core/read.ts's auditWhere
 * does exactly that). This function honestly returns [] for it rather than pretending otherwise.
 */
export function aggregateTypesForModule(module: ModuleKey): string[] {
  return Object.keys(AGGREGATE_MODULE).filter((t) => AGGREGATE_MODULE[t] === module);
}

/** Every aggregate type that HAS a module mapping. Its complement is exactly what chips `other`. */
export const MAPPED_AGGREGATE_TYPES: readonly string[] = Object.keys(AGGREGATE_MODULE);

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
  // ADR-0078 — the per-day/per-hour rate is money and masks alongside basicSalary. payMode / paymentTerm
  // are non-sensitive enum names and deliberately render in clear.
  'rateAmount',
  'rate_amount',
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

/** Feedback f1701466 — human labels for the leave-year deletion-reason codes recorded on the
 *  `leave-year.deleted` payload, so the audit tab and its CSV/XLSX/PDF exports read "Wrongly Created"
 *  instead of ["wrongly_created"]. English only, like the rest of audit formatting. Unknown codes pass
 *  through raw. */
const REASON_CODE_LABEL: Record<string, string> = {
  wrongly_created: 'Wrongly Created',
  duplicate: 'Duplicate Leave Year Configuration',
};

/** Render a payload value for the audit detail, masking sensitive fields. */
export function maskValue(key: string, value: unknown): string {
  if (value == null) return '—';
  if (SENSITIVE.has(key)) {
    const s = String(value);
    return s.length > 4 ? `•••• ${s.slice(-4)}` : '••••';
  }
  if (key === 'reasons' && Array.isArray(value)) {
    return truncate(value.map((v) => REASON_CODE_LABEL[String(v)] ?? String(v)).join(', '));
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
