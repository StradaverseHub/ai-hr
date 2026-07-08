'use client';

import { useState } from 'react';
import { Badge, Button, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
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
};

export type TemplateManagerLabels = {
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
  hr: string;
  add: string;
  moveUp: string;
  moveDown: string;
  remove: string;
  dragToReorder: string;
};

type Actions = {
  saveTemplate: (fd: FormData) => void | Promise<void>;
  duplicateTemplate: (fd: FormData) => void | Promise<void>;
  setActive: (fd: FormData) => void | Promise<void>;
  deleteTemplate: (fd: FormData) => void | Promise<void>;
  setDefault: (fd: FormData) => void | Promise<void>;
  assign: (fd: FormData) => void | Promise<void>;
  unassign: (fd: FormData) => void | Promise<void>;
  setMultiApproval: (fd: FormData) => void | Promise<void>;
};

/**
 * 6fadb036 (R17) — Approval Workflow Enhancement. Two cards on the Approval Workflow tab, above the
 * per-company editors: (1) reusable Approval Templates (CRUD, duplicate, activate/deactivate, set org-wide
 * default, drag-and-drop steps) and (2) an Assignments table that maps templates to many (company × leave
 * type) pairs in one action. The per-company default chain + scoped exception rules stay below, untouched.
 */
export function ApprovalTemplateManager({
  templates,
  assignments,
  companies,
  leaveTypes,
  companyMultiApproval,
  actions,
  labels,
}: {
  templates: TemplateRow[];
  assignments: AssignmentRow[];
  companies: Option[];
  leaveTypes: Option[];
  companyMultiApproval: Record<string, boolean>;
  actions: Actions;
  labels: TemplateManagerLabels;
}) {
  const [editing, setEditing] = useState<TemplateRow | 'new' | null>(null);
  const [assigning, setAssigning] = useState(false);

  const stepLabels = {
    chain: labels.chain,
    empty: labels.empty,
    manager: labels.manager,
    hr: labels.hr,
    add: labels.add,
    moveUp: labels.moveUp,
    moveDown: labels.moveDown,
    remove: labels.remove,
    dragToReorder: labels.dragToReorder,
  };
  const kindLabel = (k: string) => (k === 'hr_admin' ? labels.hr : labels.manager);
  const stepsPreview = (levels: string[]) => levels.map(kindLabel).join(' → ');
  const nameOf = (opts: Option[], id: string | null) => (id ? (opts.find((o) => o.id === id)?.label ?? id) : '—');
  const templateName = (id: string) => templates.find((t) => t.id === id)?.name ?? id;

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

      {/* ── Assignments ── */}
      <div className="rounded-2xl border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <div className="text-sm font-semibold">{labels.assignmentsTitle}</div>
            <p className="text-xs text-muted-foreground">{labels.assignmentsHint}</p>
          </div>
          {!assigning && templates.some((t) => t.active) && (
            <Button type="button" variant="outline" size="sm" onClick={() => setAssigning(true)}>
              {labels.assign}
            </Button>
          )}
        </div>

        <div className="space-y-4 p-4">
          {assignments.length === 0 ? (
            <p className="text-sm text-muted-foreground">{labels.noAssignments}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3">{labels.templateCol}</th>
                    <th className="py-2 pr-3">{labels.leaveTypeCol}</th>
                    <th className="py-2 pr-3">{labels.companyCol}</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {assignments.map((a) => (
                    <tr key={a.ruleId} className="border-b border-border/60">
                      <td className="py-2 pr-3 font-medium">{templateName(a.templateId)}</td>
                      <td className="py-2 pr-3">
                        <Badge variant="accent">{nameOf(leaveTypes, a.leaveTypeId)}</Badge>
                      </td>
                      <td className="py-2 pr-3">{nameOf(companies, a.companyId)}</td>
                      <td className="py-2 text-right">
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
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {assigning && (
            <AssignForm
              templates={templates.filter((t) => t.active)}
              companies={companies}
              leaveTypes={leaveTypes}
              companyMultiApproval={companyMultiApproval}
              assignAction={actions.assign}
              multiApprovalAction={actions.setMultiApproval}
              labels={labels}
              onCancel={() => setAssigning(false)}
            />
          )}
        </div>
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

      <StepListEditor levels={levels} setLevels={setLevels} labels={stepLabels} />

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={levels.length === 0}>
          {labels.save}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {labels.cancel}
        </Button>
      </div>
    </form>
  );
}

function AssignForm({
  templates,
  companies,
  leaveTypes,
  companyMultiApproval,
  assignAction,
  multiApprovalAction,
  labels,
  onCancel,
}: {
  templates: TemplateRow[];
  companies: Option[];
  leaveTypes: Option[];
  companyMultiApproval: Record<string, boolean>;
  assignAction: (fd: FormData) => void | Promise<void>;
  multiApprovalAction: (fd: FormData) => void | Promise<void>;
  labels: TemplateManagerLabels;
  onCancel: () => void;
}) {
  const [selectedCompanies, setSelectedCompanies] = useState<string[]>([]);
  const toggle = (id: string) =>
    setSelectedCompanies((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

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

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium text-muted-foreground">{labels.selectCompanies}</legend>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border bg-background p-2">
              {companies.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="companyIds"
                    value={c.id}
                    checked={selectedCompanies.includes(c.id)}
                    onChange={() => toggle(c.id)}
                    className="h-4 w-4 rounded border-border"
                  />
                  <span>{c.label}</span>
                  {!companyMultiApproval[c.id] && <Badge variant="default">{labels.multiApprovalOff}</Badge>}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium text-muted-foreground">{labels.selectLeaveTypes}</legend>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border bg-background p-2">
              {leaveTypes.map((lt) => (
                <label key={lt.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="leaveTypeIds" value={lt.id} className="h-4 w-4 rounded border-border" />
                  <span>{lt.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="flex items-center gap-2">
          <Button type="submit" size="sm">
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
