import { Badge, Button, Card, inputCls } from '@/components/ui';
import {
  EmployeeSearchField,
  type EmployeeSearchFieldLabels,
  type EmployeeSearchOption,
} from '@/components/employee-search-field';
import { isFixedLevelKind } from '@/lib/leave-approval-kinds';
import type { ApprovalChainPreview } from '@/core/leave';

/**
 * r293 — "PREVIEW HOW A LEAVE REQUEST WILL MOVE THROUGH THE APPROVAL CHAIN", the reporter's own words.
 *
 * ⚠️ IT RESOLVES AGAINST REAL ORG DATA, AND THAT IS THE WHOLE POINT — NOT A SKETCH OF THE CHAIN.
 * `core/leave.ts previewApprovalChain` runs the SAME matcher the submission path runs
 * (`resolveRequestApprovalChain` → `resolveApprovalDecision`) and the SAME drop rule
 * (`applyChainDropRules`) that `generateApprovalSteps` filters with. A preview with a ranking or a drop
 * rule of its own would be a second source of truth about who approves — and a screen that says one thing
 * while the engine does another is worse than no screen.
 *
 * r285 IS WHY IT EXISTS. `department_head` and `business_unit_head` were silently skipped for EVERY
 * request on the customer's tenant, because no department and no business unit had a head set and the head
 * selector had been dropped from the system-labels grid (fixed in r285, 0d40ab99). Nothing in the product
 * could have shown that: the chain the administrator configured and the chain the engine ran were only
 * ever visible in a database table. This panel prints the skipped levels BY NAME, with the reason, rather
 * than quietly leaving them out of the list — a preview that hid the drops would have hidden r285 too.
 *
 * SERVER COMPONENT, and a GET form rather than a server action. The chosen employee and leave type live in
 * the query string, so the preview survives a reload, is linkable, and is readable by curl against a dev
 * server — which is how it was verified (CLAUDE.md §8: a 200 is not a render check). The only client island
 * is the shared `EmployeeSearchField`, which takes plain data and posts a hidden input.
 */
export type ChainPreviewLabels = {
  title: string;
  hint: string;
  employee: string;
  leaveType: string;
  run: string;
  /** Shown before anything is chosen. */
  idle: string;
  /** The chosen employment resolved to no company — nothing to preview. */
  noResult: string;
  /** "Level {n}" — carries its own ICU placeholder; substituted here, not by next-intl. */
  levelTemplate: string;
  badgeDynamic: string;
  badgeFixed: string;
  flowStart: string;
  flowEnd: string;
  skipped: string;
  skippedNoManager: string;
  skippedNoDepartmentHead: string;
  skippedNoBusinessUnitHead: string;
  sourceRule: string;
  sourceTenantDefault: string;
  sourceFallback: string;
  /** The resolved chain is one level, so no approval-step rows are written (single-approver path). */
  singleApprover: string;
  /** Every level was dropped — the request is approved with no step at all. */
  allDropped: string;
  /** LEVEL_KINDS value → display label. */
  kindLabels: Record<string, string>;
};

export function ApprovalChainPreview({
  employees,
  leaveTypes,
  employmentId,
  leaveTypeId,
  result,
  labels,
  searchLabels,
}: {
  /** Already scope-fenced by the page. */
  employees: EmployeeSearchOption[];
  leaveTypes: { id: string; label: string }[];
  employmentId: string | null;
  leaveTypeId: string | null;
  /** Null when nothing was chosen, or when the chosen employment is not visible. */
  result: ApprovalChainPreview | null;
  labels: ChainPreviewLabels;
  searchLabels: EmployeeSearchFieldLabels;
}) {
  const level = (n: number) => labels.levelTemplate.replace('{n}', String(n));
  const sourceLabel =
    result?.source === 'rule'
      ? labels.sourceRule
      : result?.source === 'tenant-default'
        ? labels.sourceTenantDefault
        : labels.sourceFallback;
  const dropReason = (r: string | null) =>
    r === 'no_manager'
      ? labels.skippedNoManager
      : r === 'no_department_head'
        ? labels.skippedNoDepartmentHead
        : r === 'no_business_unit_head'
          ? labels.skippedNoBusinessUnitHead
          : labels.skipped;

  const kept = result ? result.levels.filter((l) => l.kept) : [];

  return (
    <Card>
      <div className="border-b border-border px-4 py-3">
        <div className="text-sm font-semibold">{labels.title}</div>
        <p className="text-xs text-muted-foreground">{labels.hint}</p>
      </div>

      {/* GET, so the choice lands in the address bar and the page re-renders the preview server-side. */}
      <form method="get" className="flex flex-wrap items-end gap-3 px-4 py-3">
        <label className="block space-y-1 text-sm">
          <span className="block text-xs font-medium text-muted-foreground">{labels.employee}</span>
          <EmployeeSearchField
            name="previewEmployment"
            employees={employees}
            value={employmentId}
            labels={searchLabels}
            className="w-72"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="block text-xs font-medium text-muted-foreground">{labels.leaveType}</span>
          <select name="previewLeaveType" defaultValue={leaveTypeId ?? ''} className={`${inputCls} w-56`}>
            {leaveTypes.map((lt) => (
              <option key={lt.id} value={lt.id}>
                {lt.label}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" size="sm">
          {labels.run}
        </Button>
      </form>

      <div className="border-t border-border px-4 py-3">
        {!employmentId ? (
          <p className="text-sm text-muted-foreground">{labels.idle}</p>
        ) : !result ? (
          <p className="text-sm text-muted-foreground">{labels.noResult}</p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="default">{sourceLabel}</Badge>
              {!result.multiStep && <span>{labels.singleApprover}</span>}
            </div>

            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {labels.flowStart}
            </div>
            <ol className="space-y-1">
              {/* EVERY level of the resolved chain, dropped ones included and labelled. The surviving
                  numbering is what the request will actually run, so a dropped level carries no number. */}
              {result.levels.map((lv, i) => {
                const keptIndex = result.levels.slice(0, i + 1).filter((x) => x.kept).length;
                return (
                  <li
                    key={i}
                    className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                      lv.kept ? 'border-border bg-muted/20' : 'border-dashed border-border bg-transparent opacity-70'
                    }`}
                  >
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {lv.kept ? level(keptIndex) : '—'}
                    </span>
                    <span className={lv.kept ? 'font-medium' : 'font-medium line-through'}>
                      {labels.kindLabels[lv.kind] ?? lv.kind}
                    </span>
                    <Badge variant={isFixedLevelKind(lv.kind) ? 'warning' : 'info'}>
                      {isFixedLevelKind(lv.kind) ? labels.badgeFixed : labels.badgeDynamic}
                    </Badge>
                    {!lv.kept && <span className="text-xs text-amber-700 dark:text-amber-400">{dropReason(lv.droppedBecause)}</span>}
                  </li>
                );
              })}
            </ol>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {kept.length === 0 ? labels.allDropped : labels.flowEnd}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
