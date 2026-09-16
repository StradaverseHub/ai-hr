'use client';

import { useState } from 'react';
import { Badge, Button, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { StepListEditor, type StepListLabels } from './step-list-editor';

type Option = { id: string; label: string };
export type RuleRow = {
  id: string;
  ruleName: string | null;
  leaveTypeId: string | null;
  businessUnitId: string | null;
  departmentId: string | null;
  positionId: string | null;
  gradeId: string | null;
  employmentType: string | null;
  minDays: number | null;
  maxDays: number | null;
  levels: string[];
};

/** r293 — the shared step-editor bag is INTERSECTED rather than re-listed. The fourteen fields it used to
 *  spell out by hand are the same fourteen `StepListLabels` declares, and the builder's five new ones
 *  (level number template, the two badges, the flow end caps, the per-kind hints) would have had to be
 *  added here a second time to stay compilable — which is how a label bag and its consumer drift. */
export type RuleBuilderLabels = StepListLabels & {
  rulesTitle: string;
  addRule: string;
  editRule: string;
  archiveRule: string;
  archiveConfirm: string;
  company: string;
  ruleName: string;
  ruleNamePlaceholder: string;
  leaveType: string;
  businessUnit: string;
  department: string;
  position: string;
  jobGrade: string;
  employmentType: string;
  minDays: string;
  maxDays: string;
  anyScope: string;
  save: string;
  cancel: string;
  noRules: string;
  steps: string;
  fullTime: string;
  partTime: string;
  contract: string;
  intern: string;
  // 4ec5a940 — optional "why the change was made" note surfaced in the audit trail.
  reason: string;
  reasonPlaceholder: string;
};

const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern'] as const;

/** ADR-0071 — the per-company rule builder. Lists the company's scoped rules and offers an inline
 *  add/edit form (scoping dropdowns + day range + the ordered step editor). The company DEFAULT chain is
 *  edited separately by the LeaveApprovalEditor above; this manages the more-specific rules. */
export function RuleBuilder({
  companyId,
  companies,
  rules,
  leaveTypes,
  businessUnits,
  departments,
  positions,
  grades,
  saveAction,
  archiveAction,
  labels,
}: {
  companyId: string;
  companies: Option[];
  rules: RuleRow[];
  leaveTypes: Option[];
  businessUnits: Option[];
  departments: Option[];
  positions: Option[];
  grades: Option[];
  saveAction: (fd: FormData) => void | Promise<void>;
  archiveAction: (fd: FormData) => void | Promise<void>;
  labels: RuleBuilderLabels;
}) {
  const [editing, setEditing] = useState<RuleRow | 'new' | null>(null);

  const kindLabel = (k: string) => (k === 'hr_admin' ? labels.hr : labels.manager);
  const nameOf = (opts: Option[], id: string | null) => (id ? (opts.find((o) => o.id === id)?.label ?? id) : null);
  const empLabel = (t: string | null) =>
    t === 'full_time' ? labels.fullTime : t === 'part_time' ? labels.partTime : t === 'contract' ? labels.contract : t === 'intern' ? labels.intern : null;

  const dayRange = (min: number | null, max: number | null) => {
    if (min == null && max == null) return null;
    if (min != null && max != null) return `${min}–${max}`;
    if (min != null) return `≥ ${min}`;
    return `≤ ${max}`;
  };

  return (
    <div className="space-y-4 border-t border-border p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{labels.rulesTitle}</div>
        {editing === null && (
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing('new')}>
            {labels.addRule}
          </Button>
        )}
      </div>

      {rules.length === 0 && editing === null ? (
        <p className="text-sm text-muted-foreground">{labels.noRules}</p>
      ) : (
        <ul className="space-y-2">
          {rules.map((r) => {
            const chips = [
              nameOf(leaveTypes, r.leaveTypeId),
              nameOf(businessUnits, r.businessUnitId),
              nameOf(departments, r.departmentId),
              nameOf(positions, r.positionId),
              nameOf(grades, r.gradeId),
              empLabel(r.employmentType),
              dayRange(r.minDays, r.maxDays),
            ].filter(Boolean) as string[];
            return (
              <li key={r.id} className="rounded-lg border border-border bg-muted/10 p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1.5">
                    <div className="font-medium">{r.ruleName || labels.anyScope}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {chips.length === 0 ? (
                        <Badge variant="info">{labels.anyScope}</Badge>
                      ) : (
                        chips.map((c, i) => (
                          <Badge key={i} variant="accent">
                            {c}
                          </Badge>
                        ))
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {labels.steps}: {r.levels.map(kindLabel).join(' → ')}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button type="button" variant="outline" size="sm" onClick={() => setEditing(r)}>
                      {labels.editRule}
                    </Button>
                    <form action={archiveAction}>
                      <input type="hidden" name="companyId" value={companyId} />
                      <input type="hidden" name="ruleId" value={r.id} />
                      <ConfirmSubmit size="sm" title={labels.archiveRule} description={labels.archiveConfirm} confirmLabel={labels.archiveRule}>
                        {labels.archiveRule}
                      </ConfirmSubmit>
                    </form>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editing !== null && (
        <RuleForm
          key={editing === 'new' ? 'new' : editing.id}
          companyId={companyId}
          companies={companies}
          rule={editing === 'new' ? null : editing}
          leaveTypes={leaveTypes}
          businessUnits={businessUnits}
          departments={departments}
          positions={positions}
          grades={grades}
          saveAction={saveAction}
          labels={labels}
          kindLabel={kindLabel}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function RuleForm({
  companyId,
  companies,
  rule,
  leaveTypes,
  businessUnits,
  departments,
  positions,
  grades,
  saveAction,
  labels,
  kindLabel,
  onCancel,
}: {
  companyId: string;
  companies: Option[];
  rule: RuleRow | null;
  leaveTypes: Option[];
  businessUnits: Option[];
  departments: Option[];
  positions: Option[];
  grades: Option[];
  saveAction: (fd: FormData) => void | Promise<void>;
  labels: RuleBuilderLabels;
  kindLabel: (k: string) => string;
  onCancel: () => void;
}) {
  const [levels, setLevels] = useState<string[]>(rule?.levels ?? ['direct_manager', 'hr_admin']);

  const Select = ({ name, label, opts, initial }: { name: string; label: string; opts: Option[]; initial: string | null }) => (
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

  return (
    <form action={saveAction} className="space-y-4 rounded-lg border border-indigo-200 bg-indigo-50/40 p-4 dark:border-indigo-900 dark:bg-indigo-950/20">
      {rule && <input type="hidden" name="ruleId" value={rule.id} />}
      <input type="hidden" name="levels" value={levels.join(',')} />

      <div className="text-sm font-semibold">{rule ? labels.editRule : labels.addRule}</div>

      <label className="block space-y-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">{labels.company}</span>
        <select name="companyId" defaultValue={companyId} required className={inputCls}>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      <label className="block space-y-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">{labels.ruleName}</span>
        <input name="ruleName" defaultValue={rule?.ruleName ?? ''} placeholder={labels.ruleNamePlaceholder} className={inputCls} />
      </label>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Select name="leaveTypeId" label={labels.leaveType} opts={leaveTypes} initial={rule?.leaveTypeId ?? null} />
        <Select name="businessUnitId" label={labels.businessUnit} opts={businessUnits} initial={rule?.businessUnitId ?? null} />
        <Select name="departmentId" label={labels.department} opts={departments} initial={rule?.departmentId ?? null} />
        <Select name="positionId" label={labels.position} opts={positions} initial={rule?.positionId ?? null} />
        <Select name="gradeId" label={labels.jobGrade} opts={grades} initial={rule?.gradeId ?? null} />
        <label className="block space-y-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">{labels.employmentType}</span>
          <select name="employmentType" defaultValue={rule?.employmentType ?? ''} className={inputCls}>
            <option value="">{labels.anyScope}</option>
            {EMPLOYMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t === 'full_time' ? labels.fullTime : t === 'part_time' ? labels.partTime : t === 'contract' ? labels.contract : labels.intern}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">{labels.minDays}</span>
          <input name="minDays" type="number" min={0} step={1} defaultValue={rule?.minDays ?? ''} className={inputCls} />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">{labels.maxDays}</span>
          <input name="maxDays" type="number" min={0} step={1} defaultValue={rule?.maxDays ?? ''} className={inputCls} />
        </label>
      </div>

      <StepListEditor levels={levels} setLevels={setLevels} labels={labels} />

      {/* 4ec5a940 — optional "why the change was made" note; recorded on the audit event. */}
      <label className="block space-y-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">{labels.reason}</span>
        <input name="reason" type="text" maxLength={500} placeholder={labels.reasonPlaceholder} className={inputCls} />
      </label>

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
