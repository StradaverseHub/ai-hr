/**
 * Feedback 9b0d99f3 — Approval Workflow Refactoring & Assignment Simplification.
 *
 * The Assignment Template list used to print ONE ROW PER LEAVE TYPE, so a company with many leave
 * types produced a very long table. This pure helper collapses the same rows to ONE LINE per
 * (company × template) pair: the first leave type stays visible and the rest hide behind a
 * "+N more" disclosure.
 *
 * Deliberately pure (no React, no db, no i18n) so it can be unit-tested directly and imported from
 * the client component. Rows are kept KEYED BY ruleId and never deduped by leave-type name — a
 * scoped rule (createLeaveApprovalRule also stamps template_id, so it shows up in
 * listTemplateAssignments) that happens to share a leave type with the wildcard-bucket rule must
 * stay individually listed and individually unassignable. Nothing is hidden, only folded.
 */

/** The four columns listTemplateAssignments returns (core/leave-approval-template.ts). */
export type AssignmentLike = {
  ruleId: string;
  templateId: string;
  companyId: string;
  leaveTypeId: string | null;
};

export type AssignmentGroup<T extends AssignmentLike = AssignmentLike> = {
  /** Stable render key — exactly one group per (company, template) pair. */
  key: string;
  companyId: string;
  templateId: string;
  /** EVERY row of the group, in input order, each still carrying its own ruleId. */
  rows: T[];
  /** Leave type shown on the collapsed line (the group's first row). */
  firstLeaveTypeId: string | null;
  /** What the "+N more" marker stands for: rows.length - 1 (0 ⇒ no marker). */
  overflowCount: number;
};

/** Group assignment rows by (companyId, templateId), preserving first-seen order. */
export function groupTemplateAssignments<T extends AssignmentLike>(rows: readonly T[]): AssignmentGroup<T>[] {
  const byKey = new Map<string, AssignmentGroup<T>>();
  for (const row of rows) {
    const key = `${row.companyId}::${row.templateId}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.rows.push(row);
      existing.overflowCount = existing.rows.length - 1;
    } else {
      byKey.set(key, {
        key,
        companyId: row.companyId,
        templateId: row.templateId,
        rows: [row],
        firstLeaveTypeId: row.leaveTypeId,
        overflowCount: 0,
      });
    }
  }
  return [...byKey.values()];
}
