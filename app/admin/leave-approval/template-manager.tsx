'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { groupTemplateAssignments } from './assignment-groups';
import { StepListEditor } from './step-list-editor';

type Option = { id: string; label: string };
export type TemplateRow = {
  id: string;
  name: string;
  description: string | null;
  levels: string[];
  isTenantDefault: boolean;
  active: boolean;
  assignedCount: number;
};
export type AssignmentRow = {
  ruleId: string;
  templateId: string;
  companyId: string;
  leaveTypeId: string | null;
  /** bb3938b9 — the criteria the Assign Template panels carry (null = applies to all). 22de47c4 made the
   *  employee scope a BENEFIT SCHEME, which on the rule is its grade group + employment type; `gradeId`
   *  survives only to label assignments written before that change. */
  gradeId: string | null;
  gradeGroupId: string | null;
  employmentType: string | null;
  minDays: number | null;
  maxDays: number | null;
};

/** 22de47c4 — one benefit scheme as the Assign Template picker offers it. `gradeGroupId` + `employmentType`
 *  are what an assignment to this scheme actually writes, and so also how a saved assignment is matched back
 *  to the scheme it names.
 *
 *  r76 22de47c4 — TWO strings, on purpose. `name` is the scheme's own name and nothing else: it is all the
 *  PICKER shows, one line per scheme. `label` still spells out the grade group + employment type as well,
 *  because the saved-assignments table names an assignment's target with it and needs to say which scope
 *  was written. The item asked for the picker; keeping them apart is what stops it changing anything else. */
export type SchemeOption = {
  id: string;
  companyId: string;
  name: string;
  label: string;
  gradeGroupId: string | null;
  employmentType: string;
};

export type TemplateManagerLabels = {
  /** "Require multi-step approval" (d4735493) — the explicit single-vs-chain choice. */
  requireMultiStep: string;
  templatesTitle: string;
  templatesHint: string;
  addTemplate: string;
  editTemplate: string;
  duplicateTemplate: string;
  deleteTemplate: string;
  deleteTemplateConfirm: string;
  deactivateTemplate: string;
  activateTemplate: string;
  templateName: string;
  templateNamePlaceholder: string;
  templateDescription: string;
  statusActive: string;
  statusInactive: string;
  tenantDefault: string;
  tenantDefaultHint: string;
  setTenantDefault: string;
  unsetTenantDefault: string;
  assignmentsTitle: string;
  assignmentsHint: string;
  assign: string;
  assignTemplate: string;
  selectTemplate: string;
  selectCompanies: string;
  selectLeaveTypes: string;
  // bb3938b9 — the two criteria panels added to the Assign Template row, plus their shared panel controls.
  // 22de47c4 — the employee-scope panel lists BENEFIT SCHEMES; `legacyGradeScope` labels an assignment
  // written against a job grade before that change, and `schemeScopeUnknown` an assignment whose scope no
  // longer matches any scheme (the "fail loudly at configuration time" case).
  selectBenefitSchemes: string;
  selectAll: string;
  deselectAll: string;
  panelNoneMeansAll: string;
  panelPickAtLeastOne: string;
  noBenefitSchemes: string;
  schemeNoGradeGroup: string;
  legacyGradeScope: string;
  schemeScopeUnknown: string;
  conditions: string;
  addCondition: string;
  conditionOperator: string;
  conditionValue: string;
  opGreaterThan: string;
  opLessThan: string;
  opBetween: string;
  leaveDuration: string;
  valueDays: string;
  templateCol: string;
  leaveTypeCol: string;
  companyCol: string;
  noTemplates: string;
  noAssignments: string;
  unassign: string;
  unassignConfirm: string;
  multiApprovalOff: string;
  enableMultiApproval: string;
  rolesGatedNote: string;
  save: string;
  cancel: string;
  // StepListEditor bag
  chain: string;
  empty: string;
  manager: string;
  departmentHead: string;
  businessUnitHead: string;
  hr: string;
  hrManager: string;
  payroll: string;
  customRole: string;
  add: string;
  moveUp: string;
  moveDown: string;
  remove: string;
  dragToReorder: string;
};

/** Approval Template Creation actions (9b0d99f3 — section 1 of the Approval Workflow tab). */
export type TemplateActions = {
  saveTemplate: (fd: FormData) => void | Promise<void>;
  duplicateTemplate: (fd: FormData) => void | Promise<void>;
  setActive: (fd: FormData) => void | Promise<void>;
  deleteTemplate: (fd: FormData) => void | Promise<void>;
  setDefault: (fd: FormData) => void | Promise<void>;
};

/** Assignment Template actions (9b0d99f3 — section 2 of the Approval Workflow tab). */
export type AssignmentActions = {
  assign: (fd: FormData) => void | Promise<void>;
  unassign: (fd: FormData) => void | Promise<void>;
  setMultiApproval: (fd: FormData) => void | Promise<void>;
};

const stepLabelBag = (labels: TemplateManagerLabels) => ({
  chain: labels.chain,
  empty: labels.empty,
  manager: labels.manager,
  departmentHead: labels.departmentHead,
  businessUnitHead: labels.businessUnitHead,
  hr: labels.hr,
  hrManager: labels.hrManager,
  payroll: labels.payroll,
  customRole: labels.customRole,
  add: labels.add,
  moveUp: labels.moveUp,
  moveDown: labels.moveDown,
  remove: labels.remove,
  dragToReorder: labels.dragToReorder,
});

const nameOf = (opts: Option[], id: string | null) => (id ? (opts.find((o) => o.id === id)?.label ?? id) : '—');

/**
 * 6fadb036 (R17) — Approval Workflow Enhancement: reusable Approval Templates (CRUD, duplicate,
 * activate/deactivate, set org-wide default, drag-and-drop steps).
 *
 * 9b0d99f3 — this component is now ONLY the "Approval Template Creation" card. The assignments table
 * (which template covers which company × leave type) split out into ApprovalAssignmentManager below,
 * so the page can head the two concerns separately. No behaviour changed on either side.
 */
export function ApprovalTemplateManager({
  templates,
  actions,
  labels,
}: {
  templates: TemplateRow[];
  actions: TemplateActions;
  labels: TemplateManagerLabels;
}) {
  const [editing, setEditing] = useState<TemplateRow | 'new' | null>(null);

  const stepLabels = stepLabelBag(labels);
  // 6fadb036 (gap-close): full 7-role vocabulary preview labels.
  const kindLabel = (k: string): string => {
    switch (k) {
      case 'department_head':
        return labels.departmentHead;
      case 'business_unit_head':
        return labels.businessUnitHead;
      case 'hr_admin':
        return labels.hr;
      case 'hr_manager':
        return labels.hrManager;
      case 'payroll':
        return labels.payroll;
      case 'custom_role':
        return labels.customRole;
      default:
        return labels.manager;
    }
  };
  const stepsPreview = (levels: string[]) => levels.map(kindLabel).join(' → ');

  return (
    <div className="space-y-6">
      {/* ── Approval templates ── */}
      <div className="rounded-2xl border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <div className="text-sm font-semibold">{labels.templatesTitle}</div>
            <p className="text-xs text-muted-foreground">{labels.templatesHint}</p>
          </div>
          {editing === null && (
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing('new')}>
              {labels.addTemplate}
            </Button>
          )}
        </div>

        <div className="space-y-3 p-4">
          {templates.length === 0 && editing === null ? (
            <p className="text-sm text-muted-foreground">{labels.noTemplates}</p>
          ) : (
            <ul className="space-y-2">
              {templates.map((t) => (
                <li key={t.id} className="rounded-xl border border-border bg-muted/10 p-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{t.name}</span>
                        {t.isTenantDefault && <Badge variant="info">{labels.tenantDefault}</Badge>}
                        <Badge variant={t.active ? 'accent' : 'default'}>
                          {t.active ? labels.statusActive : labels.statusInactive}
                        </Badge>
                      </div>
                      {t.description && <div className="text-xs text-muted-foreground">{t.description}</div>}
                      <div className="text-xs text-muted-foreground">{stepsPreview(t.levels)}</div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      <Button type="button" variant="outline" size="sm" onClick={() => setEditing(t)}>
                        {labels.editTemplate}
                      </Button>
                      <form action={actions.duplicateTemplate}>
                        <input type="hidden" name="templateId" value={t.id} />
                        <Button type="submit" variant="ghost" size="sm">
                          {labels.duplicateTemplate}
                        </Button>
                      </form>
                      {t.active && (
                        <form action={actions.setDefault}>
                          {!t.isTenantDefault && <input type="hidden" name="templateId" value={t.id} />}
                          <Button type="submit" variant="ghost" size="sm">
                            {t.isTenantDefault ? labels.unsetTenantDefault : labels.setTenantDefault}
                          </Button>
                        </form>
                      )}
                      <form action={actions.setActive}>
                        <input type="hidden" name="templateId" value={t.id} />
                        <input type="hidden" name="active" value={t.active ? '0' : '1'} />
                        <Button type="submit" variant="ghost" size="sm">
                          {t.active ? labels.deactivateTemplate : labels.activateTemplate}
                        </Button>
                      </form>
                      <form action={actions.deleteTemplate}>
                        <input type="hidden" name="templateId" value={t.id} />
                        <ConfirmSubmit
                          size="sm"
                          title={labels.deleteTemplate}
                          description={labels.deleteTemplateConfirm}
                          confirmLabel={labels.deleteTemplate}
                        >
                          {labels.deleteTemplate}
                        </ConfirmSubmit>
                      </form>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {editing !== null && (
            <TemplateForm
              key={editing === 'new' ? 'new' : editing.id}
              template={editing === 'new' ? null : editing}
              action={actions.saveTemplate}
              stepLabels={stepLabels}
              labels={labels}
              onCancel={() => setEditing(null)}
            />
          )}

          <p className="text-[11px] text-muted-foreground">{labels.rolesGatedNote}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * 9b0d99f3 — the "Assignment Template" assignments list (split out of ApprovalTemplateManager).
 *
 * The table is COLLAPSED to one line per (company × template): first leave type + a "+N more"
 * disclosure, so a company with many leave types no longer prints a screenful of rows. Expanding a
 * line lists EVERY row of the group by ruleId, each keeping its own unassign — nothing hidden,
 * nothing deduped. Assignment itself (AssignForm, its multi-step-off warning and the explicit
 * enable-multi-approval button) is unchanged.
 */
export function ApprovalAssignmentManager({
  templates,
  assignments,
  companies,
  leaveTypes,
  grades,
  schemes,
  companyMultiApproval,
  actions,
  labels,
}: {
  templates: TemplateRow[];
  assignments: AssignmentRow[];
  companies: Option[];
  leaveTypes: Option[];
  /** Job grades — no longer a criteria panel (22de47c4), kept only to NAME a legacy grade-scoped row. */
  grades: Option[];
  /** 22de47c4 — benefit schemes, the employee-scope criteria panel of the Assign Template row. */
  schemes: SchemeOption[];
  companyMultiApproval: Record<string, boolean>;
  actions: AssignmentActions;
  labels: TemplateManagerLabels;
}) {
  const t = useTranslations('leaveApproval');
  const [assigning, setAssigning] = useState(false);
  const templateName = (id: string) => templates.find((x) => x.id === id)?.name ?? id;
  const groups = groupTemplateAssignments(assignments);

  // bb3938b9 — an assignment scoped by employee population or duration must SAY so; a bare leave-type badge
  // would read as "covers everyone", which is exactly the silent-scope-change risk this item had to avoid.
  const conditionText = (a: AssignmentRow): string | null => {
    if (a.minDays == null && a.maxDays == null) return null;
    if (a.minDays != null && a.maxDays != null) return `${labels.leaveDuration} ${a.minDays}–${a.maxDays}`;
    if (a.minDays != null) return `${labels.leaveDuration} > ${a.minDays}`;
    return `${labels.leaveDuration} < ${a.maxDays}`;
  };

  /** 22de47c4 — the benefit scheme an assignment row targets, matched back on the two dimensions the
   *  assignment writes. A scoped row that matches NO scheme (its group was re-pointed, the scheme was
   *  deleted) is labelled as unresolvable rather than shown as unscoped: an assignment whose target cannot
   *  be named is exactly what has to fail loudly at configuration time instead of quietly at approval time. */
  const schemeText = (a: AssignmentRow): { label: string; unresolved: boolean } | null => {
    if (a.gradeGroupId == null && a.employmentType == null) return null;
    const hit = schemes.find(
      (s) =>
        s.companyId === a.companyId &&
        s.gradeGroupId === a.gradeGroupId &&
        s.employmentType === a.employmentType,
    );
    return hit ? { label: hit.label, unresolved: false } : { label: labels.schemeScopeUnknown, unresolved: true };
  };

  return (
    <div className="rounded-2xl border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <div className="text-sm font-semibold">{labels.assignmentsTitle}</div>
          <p className="text-xs text-muted-foreground">{labels.assignmentsHint}</p>
        </div>
        {!assigning && templates.some((x) => x.active) && (
          <Button type="button" variant="outline" size="sm" onClick={() => setAssigning(true)}>
            {labels.assign}
          </Button>
        )}
      </div>

      <div className="space-y-4 p-4">
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">{labels.noAssignments}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3">{labels.companyCol}</th>
                  <th className="py-2 pr-3">{labels.leaveTypeCol}</th>
                  <th className="py-2 pr-3">{labels.templateCol}</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.key} className="border-b border-border/60 align-top">
                    <td className="py-2 pr-3">{nameOf(companies, g.companyId)}</td>
                    <td className="py-2 pr-3">
                      <details className="group">
                        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-1.5 [&::-webkit-details-marker]:hidden">
                          <Badge variant="accent">{nameOf(leaveTypes, g.firstLeaveTypeId)}</Badge>
                          {g.overflowCount > 0 && (
                            <span className="text-xs text-muted-foreground underline decoration-dotted">
                              {t('leaveTypesMore', { n: g.overflowCount })}
                            </span>
                          )}
                          <span aria-hidden className="text-xs text-muted-foreground group-open:rotate-180">
                            ▾
                          </span>
                        </summary>
                        <ul className="mt-2 space-y-1.5 border-l border-border pl-3">
                          {g.rows.map((a) => (
                            <li key={a.ruleId} className="flex flex-wrap items-center gap-2">
                              <Badge variant="accent">{nameOf(leaveTypes, a.leaveTypeId)}</Badge>
                              {schemeText(a) && (
                                <Badge variant={schemeText(a)!.unresolved ? 'warning' : 'default'}>
                                  {schemeText(a)!.label}
                                </Badge>
                              )}
                              {/* An assignment written before 22de47c4 still targets a job grade. It keeps
                                  routing exactly as it did, so it is shown — with a badge saying it is on
                                  the old basis — instead of being converted behind the administrator's
                                  back or, worse, hidden while it still decides who approves. */}
                              {a.gradeId && (
                                <>
                                  <Badge variant="default">{nameOf(grades, a.gradeId)}</Badge>
                                  <Badge variant="warning">{labels.legacyGradeScope}</Badge>
                                </>
                              )}
                              {conditionText(a) && <Badge variant="default">{conditionText(a)}</Badge>}
                              <form action={actions.unassign}>
                                <input type="hidden" name="ruleId" value={a.ruleId} />
                                <input type="hidden" name="companyId" value={a.companyId} />
                                <ConfirmSubmit
                                  size="sm"
                                  title={labels.unassign}
                                  description={labels.unassignConfirm}
                                  confirmLabel={labels.unassign}
                                >
                                  {labels.unassign}
                                </ConfirmSubmit>
                              </form>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </td>
                    <td className="py-2 pr-3 font-medium">{templateName(g.templateId)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {assigning && (
          <AssignForm
            templates={templates.filter((x) => x.active)}
            companies={companies}
            leaveTypes={leaveTypes}
            schemes={schemes}
            companyMultiApproval={companyMultiApproval}
            assignAction={actions.assign}
            multiApprovalAction={actions.setMultiApproval}
            labels={labels}
            onCancel={() => setAssigning(false)}
          />
        )}
      </div>
    </div>
  );
}

function TemplateForm({
  template,
  action,
  stepLabels,
  labels,
  onCancel,
}: {
  template: TemplateRow | null;
  action: (fd: FormData) => void | Promise<void>;
  stepLabels: React.ComponentProps<typeof StepListEditor>['labels'];
  labels: TemplateManagerLabels;
  onCancel: () => void;
}) {
  const [levels, setLevels] = useState<string[]>(template?.levels ?? ['direct_manager', 'hr_admin']);
  /**
   * "Require multi-step approval" (feedback d4735493).
   *
   * The engine has always supported an ordered chain — `ApprovalTemplate.levels` is a list and
   * resolveApprovalChain consumes it in order — and this form has always let you add and remove steps.
   * What was missing is the DECISION being explicit. The editor simply opened on a two-step default, so
   * an administrator who wanted one approver had to notice a second row and delete it, and one who
   * wanted several had no signal that was expected rather than accidental.
   *
   * DERIVED from the template being edited rather than defaulted to a constant, so opening an existing
   * single-step template does not silently present it as multi-step (and vice versa). A new template
   * opens multi-step, preserving today's two-step default exactly — this adds a control, it does not
   * change what a new template starts as.
   */
  const [multiStep, setMultiStep] = useState<boolean>((template?.levels?.length ?? 2) > 1);

  /** Collapse to the first step, or restore a second, WITHOUT discarding what was already chosen. */
  function toggleMultiStep(next: boolean) {
    setMultiStep(next);
    setLevels((prev) => {
      if (next) return prev.length > 1 ? prev : [...prev, 'hr_admin'];
      // Keep the FIRST step rather than resetting to a default: unticking the box means "one approver",
      // not "start again", and silently replacing a chosen first approver would be a data change the
      // administrator did not ask for.
      return prev.slice(0, 1);
    });
  }

  return (
    <form
      action={action}
      className="space-y-4 rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 dark:border-indigo-900 dark:bg-indigo-950/20"
    >
      {template && <input type="hidden" name="templateId" value={template.id} />}
      <input type="hidden" name="levels" value={levels.join(',')} />

      <div className="text-sm font-semibold">{template ? labels.editTemplate : labels.addTemplate}</div>

      <label className="block space-y-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">{labels.templateName}</span>
        <input name="name" defaultValue={template?.name ?? ''} placeholder={labels.templateNamePlaceholder} required className={inputCls} />
      </label>

      <label className="block space-y-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">{labels.templateDescription}</span>
        <input name="description" defaultValue={template?.description ?? ''} className={inputCls} />
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={multiStep}
          onChange={(e) => toggleMultiStep(e.target.checked)}
          className="size-4 rounded border-border"
        />
        <span>{labels.requireMultiStep}</span>
      </label>

      {/* Single-step still renders the SAME editor, capped at one row, rather than a separate control:
          two ways to pick an approver would be two places for the value to diverge. */}
      <StepListEditor levels={levels} setLevels={setLevels} labels={stepLabels} maxSteps={multiStep ? undefined : 1} />

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={levels.length === 0 || (multiStep && levels.length < 2)}>
          {labels.save}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {labels.cancel}
        </Button>
      </div>
    </form>
  );
}

/**
 * bb3938b9 — ONE criteria panel of the Assign Template row. Every panel is the same object: a legend with
 * Select all / Deselect all, a fixed-height scrolling checkbox list, and the "none = applies to all" note —
 * so the four sit in the row at identical width and height however many options each holds. The checkboxes
 * post their own `name`, so the enclosing form submits them with no extra wiring.
 */
function CriteriaPanel({
  name,
  legend,
  options,
  selected,
  setSelected,
  labels,
  hint,
  emptyText,
  renderExtra,
}: {
  name: string;
  legend: string;
  options: Option[];
  selected: string[];
  setSelected: (next: string[]) => void;
  labels: TemplateManagerLabels;
  /** Every panel carries a footnote, so the four end at the same height — and because "none" does NOT mean
   *  the same thing everywhere: companies and leave types are required, grade and condition are not. */
  hint: string;
  emptyText?: string;
  /** Companies append their multi-approval-off marker; the other panels pass nothing. */
  renderExtra?: (o: Option) => React.ReactNode;
}) {
  const allSelected = options.length > 0 && selected.length === options.length;
  return (
    <fieldset className="flex min-w-0 flex-col space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <legend className="text-xs font-medium text-muted-foreground">{legend}</legend>
        {options.length > 0 && (
          <button
            type="button"
            onClick={() => setSelected(allSelected ? [] : options.map((o) => o.id))}
            className="text-[11px] font-medium text-primary underline-offset-2 hover:underline"
          >
            {allSelected ? labels.deselectAll : labels.selectAll}
          </button>
        )}
      </div>
      <div className="h-48 space-y-1 overflow-y-auto rounded-lg border border-border bg-background p-2">
        {options.length === 0 ? (
          <p className="text-xs text-muted-foreground">{emptyText}</p>
        ) : (
          options.map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name={name}
                value={o.id}
                checked={selected.includes(o.id)}
                onChange={() =>
                  setSelected(selected.includes(o.id) ? selected.filter((x) => x !== o.id) : [...selected, o.id])
                }
                className="h-4 w-4 shrink-0 rounded border-border"
              />
              <span className="min-w-0 truncate">{o.label}</span>
              {renderExtra?.(o)}
            </label>
          ))
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </fieldset>
  );
}

function AssignForm({
  templates,
  companies,
  leaveTypes,
  schemes,
  companyMultiApproval,
  assignAction,
  multiApprovalAction,
  labels,
  onCancel,
}: {
  templates: TemplateRow[];
  companies: Option[];
  leaveTypes: Option[];
  schemes: SchemeOption[];
  companyMultiApproval: Record<string, boolean>;
  assignAction: (fd: FormData) => void | Promise<void>;
  multiApprovalAction: (fd: FormData) => void | Promise<void>;
  labels: TemplateManagerLabels;
  onCancel: () => void;
}) {
  const [selectedCompanies, setSelectedCompanies] = useState<string[]>([]);
  const [selectedLeaveTypes, setSelectedLeaveTypes] = useState<string[]>([]);
  const [selectedSchemes, setSelectedSchemes] = useState<string[]>([]);

  // 22de47c4 — a scheme belongs to ONE company, so the panel narrows to the companies actually chosen.
  // Offering every scheme would invite picking one the assignment then quietly drops.
  //
  // r76 22de47c4 — each option is the scheme's NAME, nothing beneath it: one line per scheme. The grade
  // group and employment type used to be appended here, which restated what the tenant had already typed
  // into the name. The order is the shared display order (lib/benefit-scheme-label), already applied by the
  // page — the list arrives sorted, so the panel does not re-sort it.
  const schemeOptions: Option[] = (
    selectedCompanies.length === 0 ? schemes : schemes.filter((s) => selectedCompanies.includes(s.companyId))
  ).map((s) => ({ id: s.id, label: s.name }));
  // A scheme with no grade group covers the UNGROUPED population, which the rule matrix cannot express (a
  // null grade group there is a wildcard). The service refuses it; saying so on the tick rather than after
  // a failed save is the difference between a rule and a puzzle.
  const ungroupedScheme = (id: string) => schemes.find((s) => s.id === id)?.gradeGroupId == null;
  const pickedUngrouped = selectedSchemes.filter(ungroupedScheme);

  // Conditions panel — the leave-duration range the rule matrix already scopes on (min/max days). Off by
  // default, which posts empty strings and so keeps the assignment unbounded exactly as before.
  const [condOn, setCondOn] = useState(false);
  const [operator, setOperator] = useState<'gte' | 'lte' | 'between'>('gte');
  const [v1, setV1] = useState('');
  const [v2, setV2] = useState('');
  const minDays = !condOn ? '' : operator === 'lte' ? '' : v1;
  const maxDays = !condOn ? '' : operator === 'gte' ? '' : operator === 'lte' ? v1 : v2;

  // Companies chosen for assignment that don't yet have multi-step approval on — the assignment would never
  // fire for them until it's enabled (core/leave.ts gates on company.leaveMultiApproval).
  const offCompanies = selectedCompanies.filter((id) => !companyMultiApproval[id]);

  return (
    <div className="space-y-4 rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 dark:border-indigo-900 dark:bg-indigo-950/20">
      <div className="text-sm font-semibold">{labels.assignTemplate}</div>

      <form action={assignAction} className="space-y-4">
        <label className="block space-y-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">{labels.selectTemplate}</span>
          <select name="templateId" required className={inputCls} defaultValue="">
            <option value="" disabled>
              —
            </option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        {/* bb3938b9 — all four assignment criteria in ONE row of equally sized panels. Four abreast needs
            roughly 1280px to stay readable, so the row folds to 2×2 on a tablet and stacks on a phone
            rather than squeezing four scroll lists into an unusable strip. */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <CriteriaPanel
            name="companyIds"
            legend={labels.selectCompanies}
            options={companies}
            selected={selectedCompanies}
            setSelected={setSelectedCompanies}
            labels={labels}
            hint={labels.panelPickAtLeastOne}
            renderExtra={(c) =>
              !companyMultiApproval[c.id] ? <Badge variant="default">{labels.multiApprovalOff}</Badge> : null
            }
          />

          <CriteriaPanel
            name="leaveTypeIds"
            legend={labels.selectLeaveTypes}
            options={leaveTypes}
            selected={selectedLeaveTypes}
            setSelected={setSelectedLeaveTypes}
            labels={labels}
            hint={labels.panelPickAtLeastOne}
          />

          {/* 22de47c4 — the employee scope is the BENEFIT SCHEME, the same thing leave eligibility and
              entitlement are driven by, so a grade added to a scheme is picked up by approval routing
              without anyone opening this screen. */}
          <CriteriaPanel
            name="benefitSchemeIds"
            legend={labels.selectBenefitSchemes}
            options={schemeOptions}
            selected={selectedSchemes}
            setSelected={setSelectedSchemes}
            labels={labels}
            hint={labels.panelNoneMeansAll}
            emptyText={labels.noBenefitSchemes}
            /* r76 22de47c4 — the descriptive text is gone from the option; this badge is KEPT. It is not a
               description of the scheme, it is the reason Assign is disabled two elements below
               (`disabled={pickedUngrouped.length > 0}`): a scheme with no grade group matches nobody, and
               the service refuses it. Removing it would leave a dead button with no stated cause. Same
               reasoning as the Companies panel's multi-approval-off marker. */
            renderExtra={(o) =>
              ungroupedScheme(o.id) ? <Badge variant="warning">{labels.schemeNoGradeGroup}</Badge> : null
            }
          />

          {/* Conditions is the one criterion that is not a list: the rule matrix scopes duration as a
              range, so the panel offers the same operator + value the workflow popup does. Same frame and
              height as its three neighbours so the row still reads as one set of panels. */}
          <fieldset className="flex min-w-0 flex-col space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <legend className="text-xs font-medium text-muted-foreground">{labels.conditions}</legend>
            </div>
            <div className="h-48 space-y-2 overflow-y-auto rounded-lg border border-border bg-background p-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={condOn}
                  onChange={(e) => setCondOn(e.target.checked)}
                  className="h-4 w-4 shrink-0 rounded border-border"
                />
                <span className="min-w-0 truncate">{labels.addCondition}</span>
              </label>
              {condOn && (
                <div className="space-y-2">
                  <div className="text-xs text-muted-foreground">{labels.leaveDuration}</div>
                  <select
                    value={operator}
                    onChange={(e) => setOperator(e.target.value as typeof operator)}
                    className={inputCls}
                    aria-label={labels.conditionOperator}
                  >
                    <option value="gte">{labels.opGreaterThan}</option>
                    <option value="lte">{labels.opLessThan}</option>
                    <option value="between">{labels.opBetween}</option>
                  </select>
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
                    <span className="text-xs text-muted-foreground">{labels.valueDays}</span>
                  </div>
                </div>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">{labels.panelNoneMeansAll}</p>
          </fieldset>
        </div>

        {/* Derived from the operator/value pair above, exactly as the workflow popup does it. */}
        <input type="hidden" name="minDays" value={minDays} />
        <input type="hidden" name="maxDays" value={maxDays} />

        {pickedUngrouped.length > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">{labels.schemeNoGradeGroup}</p>
        )}
        <div className="flex items-center gap-2">
          {/* The service refuses an ungrouped scheme too — this only saves the round trip. */}
          <Button type="submit" size="sm" disabled={pickedUngrouped.length > 0}>
            {labels.assign}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {labels.cancel}
          </Button>
        </div>
      </form>

      {offCompanies.length > 0 && (
        <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50/60 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/20">
          <p className="text-xs text-amber-800 dark:text-amber-300">{labels.multiApprovalOff}</p>
          <div className="flex flex-wrap gap-2">
            {offCompanies.map((id) => (
              <form key={id} action={multiApprovalAction}>
                <input type="hidden" name="companyId" value={id} />
                <input type="hidden" name="enabled" value="1" />
                <Button type="submit" variant="outline" size="sm">
                  {labels.enableMultiApproval}: {companies.find((c) => c.id === id)?.label ?? id}
                </Button>
              </form>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
