'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Badge, Button, ErrorBanner, inputCls } from '@/components/ui';
import { ConfirmDialog, ConfirmSubmit } from '@/components/ui/confirm-submit';
import { Drawer } from '@/components/ui/drawer';
import { groupTemplateAssignments } from './assignment-groups';
import { StepListEditor, kindLabelOf, type StepListLabels } from './step-list-editor';
import { approversOf, isFixedLevelKind, type ApprovalLevel } from '@/lib/leave-approval-kinds';
import type { EmployeeSearchOption } from '@/components/employee-search-field';

type Option = { id: string; label: string };
export type TemplateRow = {
  id: string;
  name: string;
  description: string | null;
  /** r293 phase 3 — a level is a kind plus, for a named-approver level, the employment it points at. */
  levels: ApprovalLevel[];
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

/** 22de47c4 — one named employee POPULATION as the Assign Template picker offers it. 6e9a126e release three
 *  made that population an entitlement ELIGIBILITY RULE (it was a benefit scheme, and that layer is gone);
 *  `id` is therefore the rule's LINEAGE id, the identity that survives an edit.
 *
 *  `scopes` is what an assignment to this population actually writes, and so also how a saved assignment is
 *  matched back to the population it names. It is a LIST because a rule may name several employment types
 *  or several grade groups, where a scheme was always exactly one pair. EMPTY means the rule cannot be
 *  expressed on the rule matrix at all — the tick is disabled and the service refuses it with the reason.
 *
 *  `companyIds` EMPTY means the rule names no company axis, i.e. it applies to every company. */
export type EligibilityRuleOption = {
  id: string;
  name: string;
  companyIds: string[];
  scopes: { gradeGroupId: string | null; employmentType: string | null }[];
  assignable: boolean;
};

/** r293 — intersects the shared step-editor bag (`StepListLabels`) instead of re-listing its fields, so a
 *  label the builder needs cannot be forgotten here and default to undefined on the screen. */
export type TemplateManagerLabels = StepListLabels & {
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
  // 22de47c4 — the employee-scope panel lists named POPULATIONS (entitlement eligibility rules since
  // 6e9a126e release three); `legacyGradeScope` labels an assignment written against a job grade before
  // that change, and `ruleScopeUnknown` an assignment whose scope no longer matches any rule (the "fail
  // loudly at configuration time" case).
  selectEligibilityRules: string;
  selectAll: string;
  deselectAll: string;
  panelNoneMeansAll: string;
  panelPickAtLeastOne: string;
  noEligibilityRules: string;
  ruleNotAssignable: string;
  legacyGradeScope: string;
  ruleScopeUnknown: string;
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
  rolesGatedNote: string;
  save: string;
  cancel: string;
};

/** r304 — what `saveApprovalTemplateAction` answers. A refusal carries the SERVICE's message; a success
 *  carries the saved row's id (a created row does not exist on the client until the refresh lands, and
 *  focus has to find it) and its name as stored. */
export type SaveTemplateResult =
  | { ok: true; id: string; name: string; created: boolean }
  | { ok: false; error: string };

/** Approval Template Creation actions (9b0d99f3 — section 1 of the Approval Workflow tab). */
export type TemplateActions = {
  /** r304 — RETURNS instead of redirecting, so a refused save keeps the drawer and its edits. */
  saveTemplate: (fd: FormData) => Promise<SaveTemplateResult>;
  duplicateTemplate: (fd: FormData) => void | Promise<void>;
  setActive: (fd: FormData) => void | Promise<void>;
  deleteTemplate: (fd: FormData) => void | Promise<void>;
  setDefault: (fd: FormData) => void | Promise<void>;
};

/** Assignment Template actions (9b0d99f3 — section 2 of the Approval Workflow tab).
 *  r79 0322 — the action that flipped the per-company Multi-Step Approval switch is gone with the switch. */
export type AssignmentActions = {
  assign: (fd: FormData) => void | Promise<void>;
  unassign: (fd: FormData) => void | Promise<void>;
};

/** r293 — the bag IS the labels now that TemplateManagerLabels intersects StepListLabels. Kept as a named
 *  projection (rather than passing `labels` straight through) so the editor keeps receiving exactly the
 *  fields it declares and nothing else, and so the call sites did not have to change. */
const stepLabelBag = (labels: TemplateManagerLabels): StepListLabels => labels;

const nameOf = (opts: Option[], id: string | null) => (id ? (opts.find((o) => o.id === id)?.label ?? id) : '—');

/**
 * 6fadb036 (R17) — Approval Workflow Enhancement: reusable Approval Templates (CRUD, duplicate,
 * activate/deactivate, set org-wide default, drag-and-drop steps).
 *
 * 9b0d99f3 — this component is now ONLY the "Approval Template Creation" card. The assignments table
 * (which template covers which company × leave type) split out into ApprovalAssignmentManager below,
 * so the page can head the two concerns separately. No behaviour changed on either side.
 *
 * r304 (board 85875e4b) — EDIT AND ADD OPEN THE FORM IN A SIDE DRAWER (components/ui/drawer.tsx), not
 * inline under the list. The list stays behind it, dimmed, with the row being edited marked; a refused save
 * keeps the drawer, the edits and the service's reason; a successful one closes it, refreshes the list,
 * confirms "<name> updated" in the viewer's language and puts focus on that row's Edit button. Closing with
 * unsaved changes asks first. ONE drawer: with a modal overlay nothing behind it can be clicked, so a second
 * cannot open. The row actions (Duplicate, Set as default, Deactivate, Delete) are untouched — pinned
 * byte-for-byte against main by test/r304-approval-template-drawer.dom.test.tsx.
 */
export function ApprovalTemplateManager({
  templates,
  actions,
  labels,
  employees = [],
  endedEmploymentIds = [],
}: {
  templates: TemplateRow[];
  actions: TemplateActions;
  labels: TemplateManagerLabels;
  /** r293 phase 3 — the population a named-approver level may point at, already scope-fenced. */
  employees?: EmployeeSearchOption[];
  /** Of those, the ones no longer in an active employment — what the departed-approver warning reads. */
  endedEmploymentIds?: readonly string[];
}) {
  const t = useTranslations('leaveApproval');
  const router = useRouter();
  const [editing, setEditing] = useState<TemplateRow | 'new' | null>(null);
  /* What the drawer SHOWS. It outlives `editing` by the length of the exit animation, so the panel slides
     out with its form in it rather than emptying first. */
  const [shown, setShown] = useState<TemplateRow | 'new' | null>(null);
  /* Bumped on every open and used as the form's key: reopening the same template — even mid-exit — starts
     from the saved values, never from a discarded session's state. */
  const [session, setSession] = useState(0);
  const [formStatus, setFormStatus] = useState<TemplateFormStatus>({ dirty: false, canSave: true });
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [justSaved, setJustSaved] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  /** The row whose Edit button takes focus once the drawer has finished closing after a save. */
  const pendingFocus = useRef<string | null>(null);
  const drawerSettled = useRef(true);
  const [closedTick, setClosedTick] = useState(0);
  /** Where the keyboard was when a close was asked for — "Keep editing" puts it back there. */
  const beforeConfirm = useRef<HTMLElement | null>(null);

  const stepLabels = stepLabelBag(labels);
  const employeeName = (id: string) => {
    const hit = employees.find((e) => e.value === id);
    return hit ? (hit.employeeCode ? `${hit.employeeCode} · ${hit.name}` : hit.name) : null;
  };
  // r293 — ONE mapping, in step-list-editor.tsx. This file carried its own copy of the switch, and it
  // is why the template list printed "Direct manager" for a Manager's-Manager level.
  const kindLabel = (k: string) => kindLabelOf(k, stepLabels);
  /** The one-line chain under a template's name. A fixed level prints the PERSON, not the kind: two
   *  templates that both read "… → Named approver" would be indistinguishable in the list. */
  const approverText = (a: { kind: string; employmentId: string | null }) =>
    a.employmentId ? (employeeName(a.employmentId) ?? kindLabel(a.kind)) : kindLabel(a.kind);
  /* r293 phase 4 — an ANY-ONE level prints all of its approvers joined by "or". The list one-liner is how
     an administrator tells two templates apart at a glance, and a level that routes to either of two
     people while the line names only one is the same lie the Dynamic/Fixed badge exists to prevent. */
  const stepsPreview = (levels: ApprovalLevel[]) =>
    levels.map((l) => approversOf(l).map(approverText).join(` ${labels.orLabel} `)).join(' → ');

  function openDrawer(target: TemplateRow | 'new') {
    drawerSettled.current = false;
    pendingFocus.current = null;
    setEditing(target);
    setShown(target);
    setSession((n) => n + 1);
    setFormStatus({ dirty: false, canSave: true });
    setError(null);
    setJustSaved(null);
    setConfirmDiscard(false);
  }

  function closeDrawer() {
    setEditing(null);
    setConfirmDiscard(false);
  }

  /** X, Cancel, Escape and a click on the dimmed list all come here. Unsaved changes ask first. */
  function requestClose() {
    if (saving) return;
    if (!formStatus.dirty) {
      closeDrawer();
      return;
    }
    const active = document.activeElement;
    beforeConfirm.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setConfirmDiscard(true);
  }

  function save(fd: FormData) {
    setError(null);
    startSaving(async () => {
      const result = await actions.saveTemplate(fd);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      pendingFocus.current = result.id;
      setJustSaved(result.id);
      closeDrawer();
      router.refresh();
      toast.success(
        result.created
          ? t('templateCreatedToast', { name: result.name })
          : t('templateUpdatedToast', { name: result.name }),
      );
    });
  }

  /* Focus the saved row's Edit button once the drawer is GONE (focusing it while the drawer is still sliding
     out would be undone by the drawer's own focus return). A created row only exists after the refresh
     lands, so this re-runs when `templates` changes. */
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id || !drawerSettled.current) return;
    const button = editButtons.current.get(id);
    if (!button) return;
    button.focus();
    pendingFocus.current = null;
  }, [closedTick, templates]);

  /* The saved row's highlight is brief: it says "this one", then gets out of the way. */
  useEffect(() => {
    if (!justSaved) return;
    const timer = window.setTimeout(() => setJustSaved(null), 2500);
    return () => window.clearTimeout(timer);
  }, [justSaved]);

  const editingId = editing && editing !== 'new' ? editing.id : null;

  return (
    <div className="space-y-6">
      {/* ── Approval templates ── */}
      <div className="rounded-2xl border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <div className="text-sm font-semibold">{labels.templatesTitle}</div>
            <p className="text-xs text-muted-foreground">{labels.templatesHint}</p>
          </div>
          {/* r304 — no longer hidden while a template is open: the drawer's overlay already keeps it out of
              reach, and a button that disappears and comes back moves the header under the pointer. */}
          <Button type="button" variant="outline" size="sm" onClick={() => openDrawer('new')}>
            {labels.addTemplate}
          </Button>
        </div>

        <div className="space-y-3 p-4">
          {templates.length === 0 ? (
            <p className="text-sm text-muted-foreground">{labels.noTemplates}</p>
          ) : (
            <ul className="space-y-2">
              {templates.map((tpl) => {
                const isEditing = editingId === tpl.id;
                const isSaved = justSaved === tpl.id;
                return (
                  <li
                    key={tpl.id}
                    data-editing={isEditing ? '' : undefined}
                    data-saved={isSaved ? '' : undefined}
                    className={`rounded-xl border p-3 text-sm transition-colors ${
                      isEditing
                        ? 'border-border border-l-4 border-l-primary bg-primary/5'
                        : isSaved
                          ? 'border-primary/40 bg-primary/5 ring-2 ring-primary/30'
                          : 'border-border bg-muted/10'
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{tpl.name}</span>
                          {tpl.isTenantDefault && <Badge variant="info">{labels.tenantDefault}</Badge>}
                          <Badge variant={tpl.active ? 'accent' : 'default'}>
                            {tpl.active ? labels.statusActive : labels.statusInactive}
                          </Badge>
                        </div>
                        {tpl.description && <div className="text-xs text-muted-foreground">{tpl.description}</div>}
                        <div className="text-xs text-muted-foreground">{stepsPreview(tpl.levels)}</div>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        <Button
                          ref={(el) => {
                            if (el) editButtons.current.set(tpl.id, el);
                            else editButtons.current.delete(tpl.id);
                          }}
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => openDrawer(tpl)}
                        >
                          {labels.editTemplate}
                        </Button>
                        <form action={actions.duplicateTemplate}>
                          <input type="hidden" name="templateId" value={tpl.id} />
                          <Button type="submit" variant="ghost" size="sm">
                            {labels.duplicateTemplate}
                          </Button>
                        </form>
                        {tpl.active && (
                          <form action={actions.setDefault}>
                            {!tpl.isTenantDefault && <input type="hidden" name="templateId" value={tpl.id} />}
                            <Button type="submit" variant="ghost" size="sm">
                              {tpl.isTenantDefault ? labels.unsetTenantDefault : labels.setTenantDefault}
                            </Button>
                          </form>
                        )}
                        <form action={actions.setActive}>
                          <input type="hidden" name="templateId" value={tpl.id} />
                          <input type="hidden" name="active" value={tpl.active ? '0' : '1'} />
                          <Button type="submit" variant="ghost" size="sm">
                            {tpl.active ? labels.deactivateTemplate : labels.activateTemplate}
                          </Button>
                        </form>
                        <form action={actions.deleteTemplate}>
                          <input type="hidden" name="templateId" value={tpl.id} />
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
                );
              })}
            </ul>
          )}

          <p className="text-[11px] text-muted-foreground">{labels.rolesGatedNote}</p>
        </div>
      </div>

      <Drawer
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next) requestClose();
        }}
        title={shown === null || shown === 'new' ? labels.addTemplate : t('drawerEditTitle', { name: shown.name })}
        onCloseAutoFocus={(event) => {
          drawerSettled.current = true;
          if (!pendingFocus.current) return;
          event.preventDefault();
          setClosedTick((n) => n + 1);
        }}
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={requestClose} disabled={saving}>
              {labels.cancel}
            </Button>
            {/* A named-approver level with nobody named is refused by the service (it would be a step that can
                never be decided and can never be dropped), so the button says so BEFORE the round trip. */}
            <Button type="submit" form={TEMPLATE_FORM_ID} size="sm" disabled={!formStatus.canSave || saving}>
              {labels.save}
            </Button>
          </div>
        }
      >
        {error && (
          <div role="alert" className="mb-4">
            <ErrorBanner message={error} />
          </div>
        )}
        {shown !== null && (
          <TemplateForm
            key={session}
            formId={TEMPLATE_FORM_ID}
            template={shown === 'new' ? null : shown}
            onSubmit={save}
            onStatusChange={setFormStatus}
            stepLabels={stepLabels}
            labels={labels}
            employees={employees}
            endedEmploymentIds={endedEmploymentIds}
          />
        )}
      </Drawer>

      {confirmDiscard && (
        <ConfirmDialog
          title={t('discardTitle')}
          description={t('discardBody')}
          cancelLabel={t('discardKeep')}
          confirmLabel={t('discardConfirm')}
          onConfirm={() => {
            beforeConfirm.current = null;
            closeDrawer();
          }}
          onCancel={() => setConfirmDiscard(false)}
          onCloseAutoFocus={(event) => {
            // "Keep editing": back to the field or button the close was asked from. "Discard": the drawer
            // is closing and returns focus itself.
            const back = beforeConfirm.current;
            beforeConfirm.current = null;
            if (back?.isConnected) {
              event.preventDefault();
              back.focus();
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * 9b0d99f3 — the "Assignment Template" assignments list (split out of ApprovalTemplateManager).
 *
 * The table is COLLAPSED to one line per (company × template): first leave type + a "+N more"
 * disclosure, so a company with many leave types no longer prints a screenful of rows. Expanding a
 * line lists EVERY row of the group by ruleId, each keeping its own unassign — nothing hidden,
 * nothing deduped.
 *
 * r79 0322 — the AssignForm's multi-step-off warning and its enable-multi-approval button are GONE with
 * the per-company switch: an assignment now fires on its own, so there is no "this will not take effect"
 * state left to warn about. `escalation` is the slot the Approval Escalation Settings moved INTO — the
 * settings are per-company but they describe what happens to an assigned chain that stalls, so they now
 * sit beside the assignment criteria rather than in a company section of their own.
 */
export function ApprovalAssignmentManager({
  templates,
  assignments,
  companies,
  leaveTypes,
  grades,
  eligibilityRules,
  escalation,
  actions,
  labels,
}: {
  templates: TemplateRow[];
  assignments: AssignmentRow[];
  companies: Option[];
  leaveTypes: Option[];
  /** Job grades — no longer a criteria panel (22de47c4), kept only to NAME a legacy grade-scoped row. */
  grades: Option[];
  /** 22de47c4 — the named populations that are the employee-scope criteria panel of the Assign Template
   *  row. Entitlement eligibility rules since 6e9a126e release three. */
  eligibilityRules: EligibilityRuleOption[];
  /** r79 0322 — the relocated Approval Escalation Settings, rendered by the page (server) and slotted in
   *  here. A slot, not a re-implementation: the editor component and its server action are untouched, so
   *  the settings the nightly sweep reads stay readable through the move. */
  escalation?: React.ReactNode;
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

  /** 22de47c4 — the named population an assignment row targets, matched back on the two dimensions the
   *  assignment writes. A scoped row that matches NO rule (its group was re-pointed, the rule was retired)
   *  is labelled as unresolvable rather than shown as unscoped: an assignment whose target cannot be named
   *  is exactly what has to fail loudly at configuration time instead of quietly at approval time.
   *
   *  FIRST match wins, and the row is named after it. Two rules CAN resolve to one pair — approval routing
   *  cannot tell them apart, which is why the assignment writes one row for both (see `scopesFor` in
   *  core/leave-approval-template.ts). Naming one of them is honest about what the row actually scopes to. */
  const ruleText = (a: AssignmentRow): { label: string; unresolved: boolean } | null => {
    if (a.gradeGroupId == null && a.employmentType == null) return null;
    const hit = eligibilityRules.find(
      (r) =>
        (r.companyIds.length === 0 || r.companyIds.includes(a.companyId)) &&
        r.scopes.some((s) => s.gradeGroupId === a.gradeGroupId && s.employmentType === a.employmentType),
    );
    return hit ? { label: hit.name, unresolved: false } : { label: labels.ruleScopeUnknown, unresolved: true };
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
                              {ruleText(a) && (
                                <Badge variant={ruleText(a)!.unresolved ? 'warning' : 'default'}>
                                  {ruleText(a)!.label}
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
            eligibilityRules={eligibilityRules}
            assignAction={actions.assign}
            labels={labels}
            onCancel={() => setAssigning(false)}
          />
        )}
      </div>

      {/* r79 0322 — Approval Escalation Settings, relocated here from the per-company section. */}
      {escalation}
    </div>
  );
}

/** r304 — the form's own read of itself, reported up to the drawer that holds its Save button. */
type TemplateFormStatus = { dirty: boolean; canSave: boolean };

/** The drawer's sticky Save sits OUTSIDE the scrolling body, so it reaches the form by id. One drawer, one id. */
const TEMPLATE_FORM_ID = 'approval-template-form';

/** A level list as a comparable string: kind and named approver per level, alternates included, in order. A
 *  tuple rather than `JSON.stringify(levels)` so key order inside a level object can never read as a change. */
const levelsKey = (levels: ApprovalLevel[]) =>
  JSON.stringify(
    levels.map((l) => [l.kind, l.employmentId ?? null, l.alternates.map((a) => [a.kind, a.employmentId ?? null])]),
  );

function TemplateForm({
  template,
  formId,
  onSubmit,
  onStatusChange,
  stepLabels,
  labels,
  employees,
  endedEmploymentIds,
}: {
  template: TemplateRow | null;
  formId: string;
  /** r304 — the form no longer posts itself: the drawer awaits the action's answer to keep or close. */
  onSubmit: (fd: FormData) => void;
  onStatusChange: (status: TemplateFormStatus) => void;
  stepLabels: React.ComponentProps<typeof StepListEditor>['labels'];
  labels: TemplateManagerLabels;
  employees: EmployeeSearchOption[];
  endedEmploymentIds: readonly string[];
}) {
  /* r304 — THE VALUES THE FORM OPENED WITH, captured once. The dirty check compares against these and
     nothing else: opening a template and closing it untouched must never ask "discard your changes?". */
  const [initial] = useState(() => {
    const levels: ApprovalLevel[] = template?.levels ?? [
      { kind: 'direct_manager', employmentId: null, alternates: [] },
      { kind: 'hr_admin', employmentId: null, alternates: [] },
    ];
    return {
      name: template?.name ?? '',
      description: template?.description ?? '',
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
      multiStep: (template?.levels?.length ?? 2) > 1,
      levels,
    };
  });
  /* Controlled since r304 (they were `defaultValue`): the dirty check has to read them, and a refused save
     must leave exactly what was typed in place. */
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [levels, setLevels] = useState<ApprovalLevel[]>(initial.levels);
  const [multiStep, setMultiStep] = useState<boolean>(initial.multiStep);

  /** Collapse to the first step, or restore a second, WITHOUT discarding what was already chosen. */
  function toggleMultiStep(next: boolean) {
    setMultiStep(next);
    setLevels((prev) => {
      if (next) return prev.length > 1 ? prev : [...prev, { kind: 'hr_admin' as const, employmentId: null, alternates: [] }];
      // Keep the FIRST step rather than resetting to a default: unticking the box means "one approver",
      // not "start again", and silently replacing a chosen first approver would be a data change the
      // administrator did not ask for.
      return prev.slice(0, 1);
    });
  }

  const dirty =
    name !== initial.name ||
    description !== initial.description ||
    multiStep !== initial.multiStep ||
    levelsKey(levels) !== levelsKey(initial.levels);
  const canSave = !(
    levels.length === 0 ||
    (multiStep && levels.length < 2) ||
    levels.some((l) => isFixedLevelKind(l.kind) && !l.employmentId)
  );
  useEffect(() => {
    onStatusChange({ dirty, canSave });
  }, [dirty, canSave, onStatusChange]);

  return (
    <form
      id={formId}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(new FormData(e.currentTarget));
      }}
      className="space-y-4"
    >
      {template && <input type="hidden" name="templateId" value={template.id} />}
      {/* r293 phase 3 — JSON, not the old CSV of kinds: a level can now carry a named approver and a
          comma-separated list of kinds has nowhere to put one. The server action still accepts the CSV
          shape (parseLevels), so the two unmounted CSV surfaces are unaffected. */}
      <input type="hidden" name="levels" value={JSON.stringify(levels)} />

      <label className="block space-y-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">{labels.templateName}</span>
        <input
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={labels.templateNamePlaceholder}
          required
          className={inputCls}
        />
      </label>

      <label className="block space-y-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">{labels.templateDescription}</span>
        <input
          name="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={inputCls}
        />
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
      <StepListEditor
        levels={levels}
        setLevels={setLevels}
        labels={stepLabels}
        maxSteps={multiStep ? undefined : 1}
        employees={employees}
        endedEmploymentIds={endedEmploymentIds}
      />
      {/* r304 — Save and Cancel are in the drawer's sticky footer (the Save button posts this form by id). */}
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
  eligibilityRules,
  assignAction,
  labels,
  onCancel,
}: {
  templates: TemplateRow[];
  companies: Option[];
  leaveTypes: Option[];
  eligibilityRules: EligibilityRuleOption[];
  assignAction: (fd: FormData) => void | Promise<void>;
  labels: TemplateManagerLabels;
  onCancel: () => void;
}) {
  const [selectedCompanies, setSelectedCompanies] = useState<string[]>([]);
  const [selectedLeaveTypes, setSelectedLeaveTypes] = useState<string[]>([]);
  const [selectedRules, setSelectedRules] = useState<string[]>([]);

  // 22de47c4 — the panel narrows to the companies actually chosen. Offering a population from a company
  // nobody selected would invite picking one the assignment then quietly drops. A rule that names NO
  // company applies to every company, so it is always offered.
  //
  // r76 22de47c4 — each option is the population's NAME, nothing beneath it: one line each. The grade group
  // and employment type used to be appended here, which restated what the tenant had already typed into the
  // name — and an eligibility rule's name IS the tenant's word for that population ("Executives,
  // Peninsular"). The list arrives sorted by name from core, so the panel does not re-sort it.
  const ruleOptions: Option[] = (
    selectedCompanies.length === 0
      ? eligibilityRules
      : eligibilityRules.filter(
          (r) => r.companyIds.length === 0 || r.companyIds.some((c) => selectedCompanies.includes(c)),
        )
  ).map((r) => ({ id: r.id, label: r.name }));
  // A rule that narrows by something the rule matrix has no column for (department, gender, service length)
  // cannot be turned into an assignment without covering the employees it leaves out. The service refuses it
  // with the reason; saying so on the tick rather than after a failed save is the difference between a rule
  // and a puzzle.
  const notAssignable = (id: string) => eligibilityRules.find((r) => r.id === id)?.assignable === false;
  const pickedNotAssignable = selectedRules.filter(notAssignable);

  // Conditions panel — the leave-duration range the rule matrix already scopes on (min/max days). Off by
  // default, which posts empty strings and so keeps the assignment unbounded exactly as before.
  const [condOn, setCondOn] = useState(false);
  const [operator, setOperator] = useState<'gte' | 'lte' | 'between'>('gte');
  const [v1, setV1] = useState('');
  const [v2, setV2] = useState('');
  const minDays = !condOn ? '' : operator === 'lte' ? '' : v1;
  const maxDays = !condOn ? '' : operator === 'gte' ? '' : operator === 'lte' ? v1 : v2;

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

          {/* 22de47c4 — the employee scope is the named population that entitlement is already driven by
              (the entitlement eligibility rule, since 6e9a126e release three), so a grade added to that
              population is picked up by approval routing without anyone opening this screen. */}
          <CriteriaPanel
            name="eligibilityRuleIds"
            legend={labels.selectEligibilityRules}
            options={ruleOptions}
            selected={selectedRules}
            setSelected={setSelectedRules}
            labels={labels}
            hint={labels.panelNoneMeansAll}
            emptyText={labels.noEligibilityRules}
            /* r76 22de47c4 — the descriptive text is gone from the option; this badge is KEPT. It is not a
               description of the population, it is the reason Assign is disabled two elements below
               (`disabled={pickedNotAssignable.length > 0}`): the rule matrix cannot scope on what this rule
               narrows by, and the service refuses it. Removing it would leave a dead button with no stated
               cause. Same reasoning as the Companies panel's multi-approval-off marker. */
            renderExtra={(o) =>
              notAssignable(o.id) ? <Badge variant="warning">{labels.ruleNotAssignable}</Badge> : null
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

        {pickedNotAssignable.length > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">{labels.ruleNotAssignable}</p>
        )}
        <div className="flex items-center gap-2">
          {/* The service refuses such a rule too, and names the axis — this only saves the round trip. */}
          <Button type="submit" size="sm" disabled={pickedNotAssignable.length > 0}>
            {labels.assign}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {labels.cancel}
          </Button>
        </div>
      </form>
    </div>
  );
}
