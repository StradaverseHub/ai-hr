'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Badge, Button, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { StepListEditor, type StepListLabels } from './step-list-editor';

type Option = { id: string; label: string };
type ScopedOption = { id: string; label: string; companyId: string };

/** One configured approval workflow (a leave_approval_policy rule) as a summary-table row. */
export type WorkflowRow = {
  id: string;
  companyId: string;
  ruleName: string | null;
  leaveTypeId: string | null;
  gradeGroupId: string | null;
  businessUnitId: string | null;
  departmentId: string | null;
  positionId: string | null;
  gradeId: string | null;
  employmentType: string | null;
  minDays: number | null;
  maxDays: number | null;
  levels: string[];
  templateId: string | null;
};

export type WorkflowMatrixLabels = {
  workflowsTitle: string;
  workflowsHint: string;
  addWorkflow: string;
  colCompany: string;
  colLeaveType: string;
  colGradeGroup: string;
  colWorkflowType: string;
  colConditions: string;
  view: string;
  edit: string;
  delete: string;
  deleteConfirm: string;
  noWorkflows: string;
  anyScope: string;
  // Popup sections
  editTitle: string;
  addTitle: string;
  basicInfo: string;
  sectionWorkflowType: string;
  sectionConditions: string;
  workflowTypeDefault: string;
  workflowTypeCustom: string;
  workflowTypeDefaultHint: string;
  workflowTypeCustomHint: string;
  selectTemplate: string;
  noActiveTemplates: string;
  addCondition: string;
  conditionField: string;
  conditionOperator: string;
  conditionValue: string;
  leaveDuration: string;
  opGreaterThan: string;
  opLessThan: string;
  opBetween: string;
  valueDays: string;
  advancedScope: string;
  company: string;
  ruleName: string;
  ruleNamePlaceholder: string;
  leaveType: string;
  gradeGroup: string;
  businessUnit: string;
  department: string;
  position: string;
  jobGrade: string;
  employmentType: string;
  save: string;
  cancel: string;
  saveConfirmTitle: string;
  saveConfirmBody: string;
  saveConfirm: string;
  workflowTypeDefaultBadge: string;
  workflowTypeCustomBadge: string;
  fullTime: string;
  partTime: string;
  contract: string;
  intern: string;
  // StepListEditor bag
  step: StepListLabels;
};

type Actions = {
  save: (fd: FormData) => void | Promise<void>;
  archive: (fd: FormData) => void | Promise<void>;
};

const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern'] as const;

/**
 * R41 72800eda — Approval Workflow Configuration Enhancement.
 *
 * A single scannable SUMMARY TABLE of every configured approval workflow (each leave_approval_policy scoped
 * rule), across all in-scope companies. Columns are deliberately summary-only — Company / Leave Type / Grade
 * Group / Workflow Type / Conditions — the detailed approval levels appear only when HR opens the View/Edit
 * POPUP (a Radix Dialog, no page navigation). Section 1 Basic Info (Company / Leave Type / Grade Group,
 * advanced scope tucked away), Section 2 Workflow Type (Default = pick a reusable template; Custom = build
 * the ordered chain with the shared StepListEditor), Section 3 Approval Conditions (Leave Duration, mapped to
 * the existing min/max day-range — a fully-generic Field/Operator/Value engine is a documented follow-up).
 * Saving posts the existing saveLeaveApprovalRuleAction; deleting archives via archiveLeaveApprovalRuleAction.
 */
export function WorkflowMatrix({
  rows,
  companies,
  leaveTypes,
  gradeGroups,
  grades,
  businessUnits,
  departments,
  positions,
  templates,
  actions,
  labels,
}: {
  rows: WorkflowRow[];
  companies: Option[];
  leaveTypes: Option[];
  gradeGroups: Option[];
  grades: Option[];
  businessUnits: ScopedOption[];
  departments: ScopedOption[];
  positions: ScopedOption[];
  templates: Option[]; // active templates only { id, label:name }
  actions: Actions;
  labels: WorkflowMatrixLabels;
}) {
  const [editing, setEditing] = useState<WorkflowRow | 'new' | null>(null);

  const nameOf = (opts: { id: string; label: string }[], id: string | null) =>
    id ? (opts.find((o) => o.id === id)?.label ?? id) : null;
  const companyName = (id: string) => nameOf(companies, id) ?? id;

  const conditionSummary = (r: WorkflowRow): string | null => {
    if (r.minDays == null && r.maxDays == null) return null;
    if (r.minDays != null && r.maxDays != null) return `${labels.leaveDuration} ${r.minDays}–${r.maxDays}`;
    if (r.minDays != null) return `${labels.leaveDuration} > ${r.minDays}`;
    return `${labels.leaveDuration} < ${r.maxDays}`;
  };

  return (
    <div className="rounded-2xl border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <div className="text-sm font-semibold">{labels.workflowsTitle}</div>
          <p className="text-xs text-muted-foreground">{labels.workflowsHint}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setEditing('new')}>
          {labels.addWorkflow}
        </Button>
      </div>

      <div className="p-4">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{labels.noWorkflows}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3">{labels.colCompany}</th>
                  <th className="py-2 pr-3">{labels.colLeaveType}</th>
                  <th className="py-2 pr-3">{labels.colGradeGroup}</th>
                  <th className="py-2 pr-3">{labels.colWorkflowType}</th>
                  <th className="py-2 pr-3">{labels.colConditions}</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const cond = conditionSummary(r);
                  return (
                    <tr key={r.id} className="border-b border-border/60">
                      <td className="py-2 pr-3 font-medium">{companyName(r.companyId)}</td>
                      <td className="py-2 pr-3">{nameOf(leaveTypes, r.leaveTypeId) ?? labels.anyScope}</td>
                      <td className="py-2 pr-3">{nameOf(gradeGroups, r.gradeGroupId) ?? labels.anyScope}</td>
                      <td className="py-2 pr-3">
                        {r.templateId ? (
                          <Badge variant="info">
                            {labels.workflowTypeDefaultBadge}: {nameOf(templates, r.templateId) ?? '—'}
                          </Badge>
                        ) : (
                          <Badge variant="accent">{labels.workflowTypeCustomBadge}</Badge>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        {cond ? <Badge variant="default">{cond}</Badge> : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="py-2 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(r)}>
                            {labels.edit}
                          </Button>
                          <form action={actions.archive}>
                            <input type="hidden" name="companyId" value={r.companyId} />
                            <input type="hidden" name="ruleId" value={r.id} />
                            <ConfirmSubmit size="sm" title={labels.delete} description={labels.deleteConfirm} confirmLabel={labels.delete}>
                              {labels.delete}
                            </ConfirmSubmit>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing !== null && (
        <WorkflowDialog
          key={editing === 'new' ? 'new' : editing.id}
          row={editing === 'new' ? null : editing}
          companies={companies}
          leaveTypes={leaveTypes}
          gradeGroups={gradeGroups}
          grades={grades}
          businessUnits={businessUnits}
          departments={departments}
          positions={positions}
          templates={templates}
          saveAction={actions.save}
          labels={labels}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function WorkflowDialog({
  row,
  companies,
  leaveTypes,
  gradeGroups,
  grades,
  businessUnits,
  departments,
  positions,
  templates,
  saveAction,
  labels,
  onClose,
}: {
  row: WorkflowRow | null;
  companies: Option[];
  leaveTypes: Option[];
  gradeGroups: Option[];
  grades: Option[];
  businessUnits: ScopedOption[];
  departments: ScopedOption[];
  positions: ScopedOption[];
  templates: Option[];
  saveAction: (fd: FormData) => void | Promise<void>;
  labels: WorkflowMatrixLabels;
  onClose: () => void;
}) {
  const [companyId, setCompanyId] = useState<string>(row?.companyId ?? companies[0]?.id ?? '');
  const [workflowType, setWorkflowType] = useState<'default' | 'custom'>(row?.templateId ? 'default' : 'custom');
  const [templateId, setTemplateId] = useState<string>(row?.templateId ?? '');
  const [levels, setLevels] = useState<string[]>(row?.levels?.length ? row.levels : ['direct_manager', 'hr_admin']);

  // Condition (Leave Duration → min/max) — v1 exposes the existing day-range as one condition.
  const initCond = (row?.minDays ?? null) != null || (row?.maxDays ?? null) != null;
  const initOp: 'gte' | 'lte' | 'between' =
    row?.minDays != null && row?.maxDays != null ? 'between' : row?.maxDays != null ? 'lte' : 'gte';
  const [condOn, setCondOn] = useState(initCond);
  const [operator, setOperator] = useState<'gte' | 'lte' | 'between'>(initOp);
  const [v1, setV1] = useState<string>(
    initOp === 'lte' ? String(row?.maxDays ?? '') : String(row?.minDays ?? ''),
  );
  const [v2, setV2] = useState<string>(String(row?.maxDays ?? ''));

  const [advancedOpen, setAdvancedOpen] = useState(
    !!(row?.businessUnitId || row?.departmentId || row?.positionId || row?.gradeId || row?.employmentType),
  );

  // Derived hidden min/max so the existing action reads them unchanged.
  const minDays = !condOn ? '' : operator === 'lte' ? '' : v1;
  const maxDays = !condOn ? '' : operator === 'gte' ? '' : operator === 'lte' ? v1 : v2;

  const buForCompany = businessUnits.filter((x) => x.companyId === companyId);
  const deptForCompany = departments.filter((x) => x.companyId === companyId);
  const posForCompany = positions.filter((x) => x.companyId === companyId);

  const Scope = ({ name, label, opts, initial }: { name: string; label: string; opts: Option[]; initial: string | null }) => (
    <label className="block space-y-1 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <select name={name} defaultValue={initial ?? ''} className={inputCls}>
        <option value="">{labels.anyScope}</option>
        {opts.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );

  const empLabel = (t: string) =>
    t === 'full_time' ? labels.fullTime : t === 'part_time' ? labels.partTime : t === 'contract' ? labels.contract : labels.intern;

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[88vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg">
          <Dialog.Title className="text-base font-semibold">{row ? labels.editTitle : labels.addTitle}</Dialog.Title>

          <form action={saveAction} className="mt-4 space-y-5">
            {row && <input type="hidden" name="ruleId" value={row.id} />}
            {/* Condition hidden fields (mapped from operator/value UI) */}
            <input type="hidden" name="minDays" value={minDays} />
            <input type="hidden" name="maxDays" value={maxDays} />
            {/* Workflow-type hidden fields: only ONE of templateId / levels reaches the server. */}
            {workflowType === 'default' ? (
              <input type="hidden" name="templateId" value={templateId} />
            ) : (
              <input type="hidden" name="levels" value={levels.join(',')} />
            )}

            {/* ── Section 1: Basic Info ── */}
            <section className="space-y-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{labels.basicInfo}</div>

              <label className="block space-y-1 text-sm">
                <span className="text-xs font-medium text-muted-foreground">{labels.company}</span>
                <select
                  name="companyId"
                  required
                  value={companyId}
                  onChange={(e) => setCompanyId(e.target.value)}
                  className={inputCls}
                >
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Scope name="leaveTypeId" label={labels.leaveType} opts={leaveTypes} initial={row?.leaveTypeId ?? null} />
                <Scope name="gradeGroupId" label={labels.gradeGroup} opts={gradeGroups} initial={row?.gradeGroupId ?? null} />
              </div>

              <label className="block space-y-1 text-sm">
                <span className="text-xs font-medium text-muted-foreground">{labels.ruleName}</span>
                <input name="ruleName" defaultValue={row?.ruleName ?? ''} placeholder={labels.ruleNamePlaceholder} className={inputCls} />
              </label>

              {/* Advanced scope (BU / dept / position / individual grade / employment type) */}
              <div className="rounded-lg border border-border/70 bg-muted/10">
                <button
                  type="button"
                  onClick={() => setAdvancedOpen((v) => !v)}
                  className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground"
                >
                  <span>{labels.advancedScope}</span>
                  <span aria-hidden>{advancedOpen ? '▲' : '▼'}</span>
                </button>
                {advancedOpen && (
                  <div className="grid grid-cols-1 gap-3 border-t border-border/70 p-3 sm:grid-cols-2">
                    <Scope name="businessUnitId" label={labels.businessUnit} opts={buForCompany} initial={row?.businessUnitId ?? null} />
                    <Scope name="departmentId" label={labels.department} opts={deptForCompany} initial={row?.departmentId ?? null} />
                    <Scope name="positionId" label={labels.position} opts={posForCompany} initial={row?.positionId ?? null} />
                    <Scope name="gradeId" label={labels.jobGrade} opts={grades} initial={row?.gradeId ?? null} />
                    <label className="block space-y-1 text-sm">
                      <span className="text-xs font-medium text-muted-foreground">{labels.employmentType}</span>
                      <select name="employmentType" defaultValue={row?.employmentType ?? ''} className={inputCls}>
                        <option value="">{labels.anyScope}</option>
                        {EMPLOYMENT_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {empLabel(t)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
              </div>
            </section>

            {/* ── Section 2: Workflow Type ── */}
            <section className="space-y-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{labels.sectionWorkflowType}</div>
              <div className="flex flex-col gap-2">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="__workflowType"
                    checked={workflowType === 'default'}
                    onChange={() => setWorkflowType('default')}
                    className="mt-0.5 h-4 w-4"
                  />
                  <span>
                    <span className="font-medium">{labels.workflowTypeDefault}</span>
                    <span className="block text-xs text-muted-foreground">{labels.workflowTypeDefaultHint}</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="__workflowType"
                    checked={workflowType === 'custom'}
                    onChange={() => setWorkflowType('custom')}
                    className="mt-0.5 h-4 w-4"
                  />
                  <span>
                    <span className="font-medium">{labels.workflowTypeCustom}</span>
                    <span className="block text-xs text-muted-foreground">{labels.workflowTypeCustomHint}</span>
                  </span>
                </label>
              </div>

              {workflowType === 'default' ? (
                <label className="block space-y-1 text-sm">
                  <span className="text-xs font-medium text-muted-foreground">{labels.selectTemplate}</span>
                  {templates.length === 0 ? (
                    <p className="text-xs text-amber-700 dark:text-amber-400">{labels.noActiveTemplates}</p>
                  ) : (
                    <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} required className={inputCls}>
                      <option value="" disabled>
                        —
                      </option>
                      {templates.map((tpl) => (
                        <option key={tpl.id} value={tpl.id}>
                          {tpl.label}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
              ) : (
                <StepListEditor levels={levels} setLevels={setLevels} labels={labels.step} />
              )}
            </section>

            {/* ── Section 3: Approval Conditions ── */}
            <section className="space-y-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{labels.sectionConditions}</div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={condOn} onChange={(e) => setCondOn(e.target.checked)} className="h-4 w-4 rounded border-border" />
                <span>{labels.addCondition}</span>
              </label>
              {condOn && (
                <div className="grid grid-cols-1 gap-3 rounded-lg border border-border/70 bg-muted/10 p-3 sm:grid-cols-3">
                  <label className="block space-y-1 text-sm">
                    <span className="text-xs font-medium text-muted-foreground">{labels.conditionField}</span>
                    <select disabled className={inputCls} value="leave_duration">
                      <option value="leave_duration">{labels.leaveDuration}</option>
                    </select>
                  </label>
                  <label className="block space-y-1 text-sm">
                    <span className="text-xs font-medium text-muted-foreground">{labels.conditionOperator}</span>
                    <select value={operator} onChange={(e) => setOperator(e.target.value as typeof operator)} className={inputCls}>
                      <option value="gte">{labels.opGreaterThan}</option>
                      <option value="lte">{labels.opLessThan}</option>
                      <option value="between">{labels.opBetween}</option>
                    </select>
                  </label>
                  <label className="block space-y-1 text-sm">
                    <span className="text-xs font-medium text-muted-foreground">{labels.conditionValue}</span>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={v1}
                        onChange={(e) => setV1(e.target.value)}
                        className={inputCls}
                        aria-label={labels.conditionValue}
                      />
                      {operator === 'between' && (
                        <>
                          <span className="text-xs text-muted-foreground">–</span>
                          <input
                            type="number"
                            min={0}
                            step={1}
                            value={v2}
                            onChange={(e) => setV2(e.target.value)}
                            className={inputCls}
                            aria-label={labels.conditionValue}
                          />
                        </>
                      )}
                    </div>
                  </label>
                </div>
              )}
            </section>

            <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
              <Dialog.Close asChild>
                <Button type="button" variant="ghost" size="sm">
                  {labels.cancel}
                </Button>
              </Dialog.Close>
              <ConfirmSubmit
                variant="default"
                size="sm"
                title={labels.saveConfirmTitle}
                description={labels.saveConfirmBody}
                confirmLabel={labels.saveConfirm}
                disabled={workflowType === 'custom' ? levels.length === 0 : templates.length === 0}
              >
                {labels.save}
              </ConfirmSubmit>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
