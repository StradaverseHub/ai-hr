'use client';

import { useMemo, useState, useTransition } from 'react';
// r88/1ef1cf95 — the whole @dnd-kit import block went with the drag-to-group interaction. This file had
// TWO DndContexts historically: the grade-card drag (removed by b1b81a08) and the entitlement pool/row
// drag (removed here, because a shared leave group is no longer a property of a benefit scheme). With
// both gone the imports were dead, and a dead drag import is how the next reader concludes the surface
// still drags.
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { resolveGradePolicy, type GradePolicyRow, type ServiceBand } from '@/core/leave-compute';
import {
  benefitSchemeDisplayName,
  bySchemeDisplayOrder,
  schemeNameIsRedundant,
  // Feedback 0890a555 — the Scheme Category "smart default". Lives in the shared naming module (the r76
  // Decision 4 contract: one place composes a scheme's identity), not inline here.
  suggestSchemeCategory,
} from '@/lib/benefit-scheme-label';
import { Badge, Button, Field, btnPrimary, inputCls } from '@/components/ui';
import { Combobox } from '@/components/ui/combobox';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';

/**
 * Benefit Scheme & Leave Entitlement Configuration (feedback b83c6a3b) — the client subsection rendered
 * AFTER the Grade catalog on the Entitlements tab. Three managers, all posting to server actions:
 *   1. Grade Groups — name + which grades belong (a grade lives in one group). Groups let a scheme cover
 *      several grades at once (e.g. "Grade 12–15").
 *   2. Benefit Schemes — Company × Employment Type × Grade Group × Name × Status. Employees auto-match to
 *      an active scheme by those axes (with a manual override on the employee record).
 *   3. Leave Entitlements — per scheme, one row per leave type with the days for three service tiers
 *      (< N1 years, N1–N2 years, ≥ N2 years). Serialised into contiguous ServiceBands (the SAME shape the
 *      engine resolves via bandDaysFor), so the day-counting engine is reused unchanged.
 * The existing Grade config above is untouched.
 *
 * Move into the Entitlement step (feedback 6c775d68): the standalone page-bottom section is gone — this
 * component now renders INSIDE each leave type's Entitlement step (below the per-type table), scoped via
 * `scopeLeaveTypeId`. Scoped means DISPLAY-scoped only: the per-scheme entitlement table shows just the
 * selected type's row, while grade-group and scheme CRUD stay full (they are structural) and every write
 * still goes through the same scheme-wide actions. Combined-limit pools that span other leave types render
 * with a "shared with <other types>" badge so a shared-cap edit from one type's step never surprises.
 *
 * Workbench (feedback 387792a4, narrowed by b1b81a08): the long vertical scroll became a side-by-side
 * grid. It was three panels — Panel A the Grade Master catalogue (a server-composed slot), Panel B Grade
 * Groups, Panel C Assignment — with one DndContext spanning them so a grade card could be dragged from
 * Panel A onto a group's drop zone in Panel B.
 *
 * b1b81a08 moved grade MASTER data out of Leave Config to Settings → System Labels → Organisation Labels
 * (grades are organisation-level master data, not leave-specific config), so Panel A and the grade drag
 * shortcut that only existed to feed it are both gone. The grid is now TWO panels — Grade Groups ·
 * Assignment — at `xl:grid-cols-2`, stacking to one column below xl with sticky panel headers. The
 * tick-box membership editor inside each group row is the surviving (and always the accessible) way to put
 * a grade into a group; it posts the same updateGradeGroup action it always did, so nothing about how
 * groups are stored changed. NOTE the SECOND DndContext further down this file is unrelated — it is the
 * per-scheme entitlement pool/row drag (R47 d6f88c2f) and is untouched.
 *
 * The per-scheme Leave Entitlements area renders full-width BELOW the workbench, unchanged; what is
 * assigned here keeps feeding the Service Based Entitlements sub-step automatically (same rows,
 * revalidated on every assignment save).
 */

type Company = { id: string; name: string };
type Grade = { id: string; name: string; code: string };
type LeaveType = { id: string; name: string; code: string };
type GradeGroup = { id: string; name: string; gradeIds: string[]; archived: boolean };
type Scheme = {
  id: string;
  companyId: string;
  employmentType: string;
  gradeGroupId: string | null;
  gradeGroupName: string | null;
  name: string;
  status: string;
  /** Feedback 0890a555: the grouping label. null ⇒ ungrouped. */
  schemeCategory: string | null;
};
type Entitlement = {
  id: string;
  benefitSchemeId: string;
  leaveTypeId: string;
  leaveTypeName: string | null;
  serviceBands: ServiceBand[];
};
type Actions = {
  createGradeGroup: (fd: FormData) => void | Promise<void>;
  updateGradeGroup: (fd: FormData) => void | Promise<void>;
  deleteGradeGroup: (fd: FormData) => void | Promise<void>;
  createScheme: (fd: FormData) => void | Promise<void>;
  updateScheme: (fd: FormData) => void | Promise<void>;
  deleteScheme: (fd: FormData) => void | Promise<void>;
  upsertEntitlement: (fd: FormData) => void | Promise<void>;
  deleteEntitlement: (fd: FormData) => void | Promise<void>;
  copyEntitlements: (fd: FormData) => void | Promise<void>;
  // r88 1ef1cf95: the five shared-group writes that used to sit here (update / delete / move member /
  // group-from-drag) are gone with the scheme-level tables. Shared groups have their own component and
  // their own actions now — this surface no longer writes to them at all.
};

const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern'] as const;

/** Read the three-tier day figures + thresholds out of a stored ServiceBand[]. Falls back to a blank
 *  0/2/5 template so a fresh entitlement renders sensible defaults. Defensive: any odd shape → template. */
function tiersFromBands(bands: ServiceBand[]): { n1: number; n2: number; d0: string; d1: string; d2: string } {
  if (Array.isArray(bands) && bands.length === 3 && bands[0].toYears != null && bands[1].toYears != null) {
    return {
      n1: Number(bands[0].toYears),
      n2: Number(bands[1].toYears),
      d0: String(bands[0].days ?? ''),
      d1: String(bands[1].days ?? ''),
      d2: String(bands[2].days ?? ''),
    };
  }
  return { n1: 2, n2: 5, d0: '', d1: '', d2: '' };
}

export function BenefitSchemeConfig({
  companies,
  grades,
  leaveTypes,
  gradeGroups,
  schemes,
  entitlements,
  actions,
  scopeLeaveTypeId,
}: {
  companies: Company[];
  grades: Grade[];
  leaveTypes: LeaveType[];
  gradeGroups: GradeGroup[];
  schemes: Scheme[];
  entitlements: Entitlement[];
  actions: Actions;
  /** 6c775d68: when set (the Entitlement-step host), the per-scheme entitlement table shows ONLY this leave
   *  type's row. Grade-group + scheme management and all writes remain scheme-wide. Absent = the full
   *  (unscoped) table. */
  scopeLeaveTypeId?: string;
}) {
  const t = useTranslations('admin.benefitScheme');
  const companyName = useMemo(() => new Map(companies.map((c) => [c.id, c.name])), [companies]);
  const groupName = useMemo(() => new Map(gradeGroups.map((g) => [g.id, g.name])), [gradeGroups]);
  const activeGroups = gradeGroups.filter((g) => !g.archived);
  const empTypeLabel = (v: string) => t(`empType_${v}` as `empType_${(typeof EMPLOYMENT_TYPES)[number]}`);

  // R44 02a7082b: group the flat scheme list by company into collapsible per-company sections (companies
  // ordered A–Z; schemes already asc(name) from the loader). Sections default to COLLAPSED (feedback
  // bca94601) so the tab opens on a titles-only overview — name + scheme count, details one click away.
  // Presentation only — no data change.
  const schemesByCompany = useMemo(() => {
    const map = new Map<string, Scheme[]>();
    for (const s of schemes) {
      const arr = map.get(s.companyId);
      if (arr) arr.push(s);
      else map.set(s.companyId, [s]);
    }
    return [...map.entries()]
      .map(([companyId, list]) => ({ companyId, name: companyName.get(companyId) ?? '—', schemes: list }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [schemes, companyName]);

  const [selectedSchemeId, setSelectedSchemeId] = useState<string>(schemes[0]?.id ?? '');
  // The selected scheme's FULL entitlement list — dup guards / counts stay scheme-wide even when scoped.
  const selectedSchemeEnts = entitlements.filter((e) => e.benefitSchemeId === selectedSchemeId);
  // 6c775d68: display scope — inside a leave type's Entitlement step only that type's row is listed.
  const selectedEnts = scopeLeaveTypeId
    ? selectedSchemeEnts.filter((e) => e.leaveTypeId === scopeLeaveTypeId)
    : selectedSchemeEnts;

  // 6c775d68: leave-type display names for the "shared with <other types>" badge on combined-limit pools.
  // leaveTypes covers active types; entitlement rows backfill names for archived pool members.
  const typeNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const lt of leaveTypes) m.set(lt.id, lt.name);
    for (const e of entitlements) if (e.leaveTypeName != null) m.set(e.leaveTypeId, e.leaveTypeName);
    return m;
  }, [leaveTypes, entitlements]);

  // Feedback b7d04d7d: per-scheme entitlement count for the row-level delete confirmation. Deleting a
  // scheme CASCADES to its scheme_leave_entitlement rows (FK ON DELETE CASCADE), so the confirm dialog
  // must name what is actually about to be lost. Derived from the already-loaded entitlement list —
  // no extra query.
  const entCountByScheme = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entitlements) m.set(e.benefitSchemeId, (m.get(e.benefitSchemeId) ?? 0) + 1);
    return m;
  }, [entitlements]);

  // R44 8d422204: client-side A–Z / Z–A sort of the entitlements table by leave-type name. Display-order
  // only — re-sorts automatically on add/update/delete via re-render. Default ascending. Feedback
  // c4014f5a: the standalone Sort dropdown is gone — direction now toggles from the Leave Type column
  // header inside EntitlementDndTable (same pattern as leave-balance-table), state still owned here.
  const [entSort, setEntSort] = useState<'asc' | 'desc'>('asc');
  const sortedEnts = useMemo(() => {
    const copy = [...selectedEnts];
    copy.sort((a, b) => (a.leaveTypeName ?? '').localeCompare(b.leaveTypeName ?? ''));
    if (entSort === 'desc') copy.reverse();
    return copy;
  }, [selectedEnts, entSort]);

  // The three service-band column headers interpolate the scheme's ACTUAL configured thresholds
  // (feedback 0aa304a1) rather than the old literal "N1"/"N2" placeholders. Thresholds live per
  // entitlement in serviceBands (n1 = bands[0].toYears, n2 = bands[1].toYears; the top band's
  // toYears is null → open-ended "{n2} years and over"). Since the headers are shared across all
  // rows of the selected scheme but each row's stored bands MAY differ, we derive the header pair
  // from the first entitlement of the selected scheme (tiersFromBands is defensive: any odd/empty
  // shape falls back to the 2/5 default). Presentation only — no entitlement value changes.
  const headerTiers = selectedEnts.length > 0 ? tiersFromBands(selectedEnts[0].serviceBands) : { n1: 2, n2: 5 };

  return (
    <div className="space-y-8" data-tour="benefit-scheme">
      {/* ── Two-panel workbench: Grade Groups · Assignment (387792a4, narrowed by b1b81a08) ──────────
          Side-by-side at xl, stacked (grid-cols-1) below with sticky panel headers. The Grade Master
          panel and the DndContext that let a grade be dragged from it into a group are gone with the
          b1b81a08 relocation; the tick-box membership editor below is the surviving assignment path. */}
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
      {/* ── Grade Groups ─────────────────────────────────────────────── */}
      <section className="min-w-0 rounded-lg border border-border xl:max-h-[42rem] xl:overflow-y-auto">
        <div className="sticky top-0 z-10 rounded-t-lg border-b border-border bg-card px-3 py-2">
          <h3 className="text-sm font-semibold text-foreground">{t('groupsTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('groupsHelp')}</p>
        </div>
        <div className="space-y-3 p-3">
        <ul className="divide-y divide-border rounded-lg border border-border">
          {gradeGroups.length === 0 && (
            <li className="px-3 py-4 text-center text-sm text-muted-foreground">{t('noGroups')}</li>
          )}
          {gradeGroups.map((g) => (
            <li key={g.id} className="px-3 py-2.5">
              <details>
                <summary className="flex cursor-pointer items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    {g.name}
                    {g.archived && <Badge variant="warning">{t('archived')}</Badge>}
                    <span className="text-xs font-normal text-muted-foreground">
                      {t('memberCount', { count: g.gradeIds.length })}
                    </span>
                  </span>
                </summary>
                <div className="mt-3">
                  <form action={actions.updateGradeGroup} className="space-y-3">
                    <input type="hidden" name="id" value={g.id} />
                    <Field label={t('groupNameLabel')}>
                      <input name="name" defaultValue={g.name} required className={inputCls} />
                    </Field>
                    <div>
                      <span className="text-xs font-medium text-muted-foreground">{t('membersLabel')}</span>
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {grades.map((gr) => (
                          <label key={gr.id} className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs">
                            <input
                              type="checkbox"
                              name="gradeIds"
                              value={gr.id}
                              defaultChecked={g.gradeIds.includes(gr.id)}
                              className="size-3.5 rounded"
                            />
                            {gr.name}
                          </label>
                        ))}
                        {grades.length === 0 && <span className="text-xs text-muted-foreground">{t('noGrades')}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button type="submit" size="sm">{t('save')}</Button>
                      {/* 9054e31c: Delete shares the Save row — a second submit button posting
                          deleteGradeGroup via formAction (same pattern as the holidays page and the TP1
                          form). The action reads only the hidden id; the extra name/gradeIds fields are
                          ignored. formNoValidate so a cleared required name input cannot block Delete. */}
                      <Button
                        type="submit"
                        variant="ghost"
                        size="sm"
                        formAction={actions.deleteGradeGroup}
                        formNoValidate
                      >
                        {t('delete')}
                      </Button>
                    </div>
                  </form>
                </div>
              </details>
            </li>
          ))}
        </ul>
        <form action={actions.createGradeGroup} className="flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-border p-3">
          <Field label={t('groupNameLabel')}>
            <input name="name" required placeholder={t('groupNamePlaceholder')} className={`${inputCls} w-56`} />
          </Field>
          <div className="min-w-0">
            <span className="text-xs font-medium text-muted-foreground">{t('membersLabel')}</span>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {grades.map((gr) => (
                <label key={gr.id} className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs">
                  <input type="checkbox" name="gradeIds" value={gr.id} className="size-3.5 rounded" />
                  {gr.name}
                </label>
              ))}
              {grades.length === 0 && <span className="text-xs text-muted-foreground">{t('noGrades')}</span>}
            </div>
          </div>
          <button className={btnPrimary}>{t('addGroup')}</button>
        </form>
        </div>
      </section>

      {/* ── Assignment (Benefit Schemes: Company × Employment Type per Grade Group) ────────── */}
      <section className="min-w-0 rounded-lg border border-border xl:max-h-[42rem] xl:overflow-y-auto">
        <div className="sticky top-0 z-10 rounded-t-lg border-b border-border bg-card px-3 py-2">
          <h3 className="text-sm font-semibold text-foreground">{t('schemesTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('schemesHelp')}</p>
        </div>
        <div className="space-y-3 p-3">
        {schemes.length === 0 ? (
          <p className="rounded-lg border border-border px-3 py-4 text-center text-sm text-muted-foreground">
            {t('noSchemes')}
          </p>
        ) : (
          <div className="space-y-3">
            {schemesByCompany.map((group) => (
              <details key={group.companyId} className="overflow-hidden rounded-lg border border-border">
                <summary className="flex cursor-pointer items-center justify-between gap-2 bg-muted/40 px-3 py-2">
                  <span className="text-sm font-semibold text-foreground">{group.name}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {t('schemeCount', { count: group.schemes.length })}
                  </span>
                </summary>
                <div className="overflow-x-auto border-t border-border">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted-foreground">
                        <th className="px-3 py-2 font-medium">{t('colEmpType')}</th>
                        {/* Feedback 0890a555: Scheme Category sits immediately after Employment Type, the
                            position the reporter tabulated. A scheme with no category reads "Ungrouped"
                            rather than blank — an empty cell in a column of names looks like missing data,
                            and "not grouped yet" is a real, chooseable state. */}
                        <th className="px-3 py-2 font-medium">{t('colSchemeCategory')}</th>
                        <th className="px-3 py-2 font-medium">{t('colGradeGroup')}</th>
                        <th className="px-3 py-2 font-medium">{t('colName')}</th>
                        <th className="px-3 py-2 font-medium">{t('colStatus')}</th>
                        <th className="px-3 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {group.schemes.map((s) => (
                        <tr key={s.id} className="border-b border-border last:border-0 align-top">
                          <td className="px-3 py-2">{empTypeLabel(s.employmentType)}</td>
                          <td className="px-3 py-2">
                            {s.schemeCategory ?? (
                              <span className="text-muted-foreground">{t('schemeCategoryUnset')}</span>
                            )}
                          </td>
                          <td className="px-3 py-2">{s.gradeGroupId ? (groupName.get(s.gradeGroupId) ?? '—') : t('anyGroup')}</td>
                          <td className="px-3 py-2 font-medium">{s.name}</td>
                          <td className="px-3 py-2">
                            <Badge variant={s.status === 'active' ? 'success' : 'default'}>
                              {t(s.status === 'active' ? 'statusActive' : 'statusInactive')}
                            </Badge>
                          </td>
                          <td className="px-3 py-2">
                            {/* Feedback b7d04d7d: Delete moved OUT of the edit dialog onto the row, next to
                                Edit, and now confirms first (the in-dialog delete was one unconfirmed click
                                that also cascaded away every entitlement under the scheme). Same server
                                action + hidden-id FormData contract, matching the entitlement row pattern. */}
                            <div className="inline-flex items-center gap-2">
                              <SchemeEditDialog
                                scheme={s}
                                companies={companies}
                                groups={activeGroups}
                                empTypeLabel={empTypeLabel}
                                updateScheme={actions.updateScheme}
                                t={t}
                              />
                              <form action={actions.deleteScheme} className="inline">
                                <input type="hidden" name="id" value={s.id} />
                                <ConfirmSubmit
                                  size="sm"
                                  variant="ghost"
                                  className="text-destructive hover:text-destructive"
                                  title={t('deleteSchemeConfirmTitle')}
                                  description={t('deleteSchemeConfirmDescription', {
                                    name: s.name,
                                    count: entCountByScheme.get(s.id) ?? 0,
                                  })}
                                  confirmLabel={t('delete')}
                                >
                                  {t('delete')}
                                </ConfirmSubmit>
                              </form>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ))}
          </div>
        )}
        {/* Feedback 0890a555 — what the new column is and, more importantly, what it is NOT. Stated on the
            screen rather than left to be inferred, because a field that looks like it decides eligibility
            and does not is exactly the kind of control that gets configured hopefully. */}
        <p className="text-xs text-muted-foreground">{t('schemeCategoryHelp')}</p>
        <div className="rounded-lg border border-dashed border-border p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">{t('addScheme')}</p>
          <SchemeForm
            action={actions.createScheme}
            companies={companies}
            groups={activeGroups}
            empTypeLabel={empTypeLabel}
            t={t}
            scheme={null}
          />
        </div>
        </div>
      </section>
      </div>

      {/* ── Leave Entitlements per scheme ────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t('entTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('entHelp')}</p>
        </div>
        {schemes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('entNeedsScheme')}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <Field label={t('selectScheme')}>
                <select
                  value={selectedSchemeId}
                  onChange={(e) => setSelectedSchemeId(e.target.value)}
                  className={`${inputCls} w-72`}
                >
                  {/* Feedback 0d1a0cfc — the Scheme picker lists the configured Benefit Schemes grouped
                      under their owning COMPANY (optgroup), so two companies with similarly named schemes
                      are no longer confusable. Same option set as the previous flat schemes.map (nothing is
                      filtered in or out), reusing the schemesByCompany memo the workbench already builds —
                      presentation only; selection state, onChange and the default remain untouched. */}
                  {schemesByCompany.map((group) => (
                    <optgroup key={group.companyId} label={group.name}>
                      {group.schemes.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </Field>
              <div className="flex items-end gap-3">
                {/* R44 ba494b21 — copy another scheme's entitlements into this one (skip-existing). */}
                <CopyEntitlementsDialog
                  targetSchemeId={selectedSchemeId}
                  schemes={schemes}
                  entitlements={entitlements}
                  action={actions.copyEntitlements}
                  t={t}
                />
              </div>
            </div>
            {/* r88 1ef1cf95 — no shared-cap column, no drag-to-group, no create-group button here. A
                shared leave group is configured once at leave type level (Shared Leave Groups, beside Add
                Leave Type) and is not owned by a scheme. */}
            <EntitlementTable
              ents={sortedEnts}
              sortDir={entSort}
              onToggleSort={() => setEntSort((d) => (d === 'asc' ? 'desc' : 'asc'))}
              headerTiers={headerTiers}
              actions={actions}
              t={t}
            />
            <EntitlementForm
              action={actions.upsertEntitlement}
              schemeId={selectedSchemeId}
              leaveTypes={leaveTypes}
              // Scheme-wide, NOT display-scoped: the dup guard must still catch a leave type whose row is
              // merely hidden by the 6c775d68 scope filter.
              existingLeaveTypeIds={selectedSchemeEnts.map((e) => e.leaveTypeId)}
              // Preselect the step's own type — only when it is an offered (active) option, so an archived
              // type's panel can't wedge the controlled select on a value with no matching <option>.
              defaultLeaveTypeId={
                scopeLeaveTypeId && leaveTypes.some((lt) => lt.id === scopeLeaveTypeId)
                  ? scopeLeaveTypeId
                  : undefined
              }
              t={t}
            />
          </>
        )}
      </section>
    </div>
  );
}

// b1b81a08 — the per-row grade-group drop-zone wrapper (which received grades dragged from the old
// Panel A) is gone with the grade master itself. Group rows are plain <li>s again; membership is edited
// through the tick-boxes inside each row, which post the same updateGradeGroup action the drop did.

/**
 * EntitlementTable — the per-scheme entitlement table: one row per leave type, three service tiers.
 *
 * r88 1ef1cf95: this used to be EntitlementDndTable, where dragging one row onto another created a SHARED
 * LEAVE GROUP scoped to the benefit scheme, with banded group blocks, an inline shared-total column, a
 * "shared with <types>" badge and a Create-group dialog. All of that is gone. The reporter rejected the
 * scheme-level shape outright — "I don't want to improve the existing Benefit Scheme selector" — and shared
 * groups are now defined once at LEAVE TYPE level (components/leave/shared-leave-group-config.tsx, backed
 * by leave_shared_group / _member). A scheme's entitlement table answers one question again: how many days
 * does this scheme give this leave type at each service tier.
 *
 * Feedback c4014f5a: the A–Z/Z–A direction toggles from the Leave Type column header (caret + aria-sort,
 * copied from leave-balance-table) — kept.
 */
function EntitlementTable({
  ents,
  sortDir,
  onToggleSort,
  headerTiers,
  actions,
  t,
}: {
  /** The selected scheme's entitlements, ALREADY sorted by the Leave Type column-header toggle. */
  ents: Entitlement[];
  /** Current sort direction of `ents` — drives the header caret + aria-sort. */
  sortDir: 'asc' | 'desc';
  /** Flips the parent-owned sort direction (asc ↔ desc). */
  onToggleSort: () => void;
  headerTiers: { n1: number; n2: number };
  actions: Actions;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            {/* c4014f5a: sortable header (leave-balance-table pattern). This table is always sorted by
                leave type, so aria-sort is permanently ascending/descending — never 'none' — and the
                caret always shows the current direction. */}
            <th scope="col" aria-sort={sortDir === 'asc' ? 'ascending' : 'descending'} className="px-3 py-2 font-medium">
              <button
                type="button"
                onClick={onToggleSort}
                aria-label={t('sortBy', { column: t('colLeaveType') })}
                className="inline-flex items-center font-medium hover:text-foreground"
              >
                {t('colLeaveType')}
                <span aria-hidden>{sortDir === 'asc' ? ' ↑' : ' ↓'}</span>
              </button>
            </th>
            <th className="px-3 py-2 font-medium">{t('tierUnder', { n1: headerTiers.n1, n2: headerTiers.n2 })}</th>
            <th className="px-3 py-2 font-medium">{t('tierMid', { n1: headerTiers.n1, n2: headerTiers.n2 })}</th>
            <th className="px-3 py-2 font-medium">{t('tierOver', { n1: headerTiers.n1, n2: headerTiers.n2 })}</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {ents.length === 0 && (
            <tr>
              <td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">{t('noEntitlements')}</td>
            </tr>
          )}
          {ents.map((ent) => (
            <EntitlementRow key={ent.id} ent={ent} actions={actions} t={t} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One entitlement row: leave type, the three tier figures, Edit + Delete. */
function EntitlementRow({
  ent,
  actions,
  t,
}: {
  ent: Entitlement;
  actions: Actions;
  t: ReturnType<typeof useTranslations>;
}) {
  const ti = tiersFromBands(ent.serviceBands);
  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-3 py-2 font-medium">{ent.leaveTypeName ?? '—'}</td>
      <td className="px-3 py-2">{ti.d0 || '0'}</td>
      <td className="px-3 py-2">{ti.d1 || '0'}</td>
      <td className="px-3 py-2">{ti.d2 || '0'}</td>
      <td className="px-3 py-2 text-right">
        {/* R47 edb0309d: Edit reopens the row in a pre-filled dialog (the R44 dup guard closed the old
            re-add-to-overwrite path); Delete confirms like its R44 sibling delete surfaces. */}
        <div className="inline-flex items-center gap-1">
          <EntitlementEditDialog entitlement={ent} action={actions.upsertEntitlement} t={t} />
          <form action={actions.deleteEntitlement} className="inline">
            <input type="hidden" name="id" value={ent.id} />
            <ConfirmSubmit
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              title={t('deleteEntitlementConfirmTitle')}
              description={t('deleteEntitlementConfirmDescription')}
              confirmLabel={t('delete')}
            >
              {t('delete')}
            </ConfirmSubmit>
          </form>
        </div>
      </td>
    </tr>
  );
}

/**
 * SchemeForm grid per host (item 0ad01560). Static class lookup — Tailwind cannot JIT a runtime-interpolated
 * class string (same discipline as the dashboard-customizer GRID_COLS fix).
 *  - 'inline': the add-scheme box inside the workbench's Assignment panel (387792a4) — the cell is a third
 *    of the row at xl, so the old six-across lg row gave way to two comfortable columns.
 *  - 'dialog': the Edit popup (max-w-3xl) — six columns squeezed every dropdown to ~100px and truncated long
 *    company / grade-group / scheme names, so the dialog gets two comfortable columns instead.
 */
const SCHEME_FORM_GRID: Record<'inline' | 'dialog', string> = {
  inline: 'grid grid-cols-1 gap-2 sm:grid-cols-2 sm:items-end',
  dialog: 'grid grid-cols-1 gap-2 sm:grid-cols-2',
};

function SchemeForm({
  action,
  companies,
  groups,
  empTypeLabel,
  t,
  scheme,
  layout = 'inline',
}: {
  action: (fd: FormData) => void | Promise<void>;
  companies: Company[];
  groups: GradeGroup[];
  empTypeLabel: (v: string) => string;
  t: ReturnType<typeof useTranslations>;
  scheme: Scheme | null;
  /** Which host renders the form — defaults to 'inline' so the add-scheme row is untouched by construction. */
  layout?: 'inline' | 'dialog';
}) {
  const inDialog = layout === 'dialog';
  // Feedback 0890a555 — the "smart default". The two inputs the suggestion is derived from (name and
  // employment type) become controlled so the suggestion can follow what is actually being typed.
  const [schemeName, setSchemeName] = useState(scheme?.name ?? '');
  const [empType, setEmpType] = useState(scheme?.employmentType ?? 'full_time');
  const [category, setCategory] = useState(scheme?.schemeCategory ?? '');
  // Once HR types in the category field, the suggestion stops writing to it — for good, including after
  // they clear it back to empty. Blank is a deliberate choice ("ungrouped"), and re-suggesting over it
  // would make the field impossible to empty.
  const [categoryTouched, setCategoryTouched] = useState(false);
  const suggestion = suggestSchemeCategory({ name: schemeName }, empTypeLabel(empType));
  // An EXISTING scheme is never overwritten by a suggestion, whatever its stored value: the tenant already
  // made this decision, and silently re-deciding it on an unrelated rename is the failure this whole
  // feature is trying to avoid. Suggestions apply to the ADD form only.
  const effectiveCategory = scheme == null && !categoryTouched ? suggestion : category;
  return (
    <form action={action} className={SCHEME_FORM_GRID[layout]}>
      {scheme && <input type="hidden" name="id" value={scheme.id} />}
      <Field label={t('colCompany')}>
        <select name="companyId" defaultValue={scheme?.companyId ?? ''} required className={inputCls}>
          <option value="" disabled>{t('selectPlaceholder')}</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </Field>
      <Field label={t('colEmpType')}>
        <select
          name="employmentType"
          value={empType}
          onChange={(e) => setEmpType(e.target.value)}
          className={inputCls}
        >
          {EMPLOYMENT_TYPES.map((v) => (
            <option key={v} value={v}>{empTypeLabel(v)}</option>
          ))}
        </select>
      </Field>
      {/* Feedback 0890a555 — Scheme Category, immediately after Employment Type as the reporter tabulated
          it. Free text with a live suggestion: on the ADD form it follows the scheme name and employment
          type until HR types here, at which point it is theirs. Blank saves as "ungrouped". */}
      <Field label={t('colSchemeCategory')}>
        <input
          name="schemeCategory"
          value={effectiveCategory}
          onChange={(e) => {
            setCategoryTouched(true);
            setCategory(e.target.value);
          }}
          maxLength={120}
          placeholder={t('schemeCategoryPlaceholder')}
          className={inputCls}
        />
      </Field>
      {/* R44 d28dffe7: searchable single-select combobox (type-ahead) replaces the plain grade-group dropdown.
          Same name/value FormData contract (hidden input carries gradeGroupId), so updateScheme is unchanged.
          Empty selection = "Any / ungrouped" (the placeholder row). Options already asc(name) from the loader. */}
      <Field label={t('colGradeGroup')}>
        <Combobox
          name="gradeGroupId"
          value={scheme?.gradeGroupId ?? ''}
          options={groups.map((g) => ({ value: g.id, label: g.name }))}
          placeholder={t('anyGroup')}
          searchPlaceholder={t('gradeGroupSearchPlaceholder')}
          noResultsLabel={t('gradeGroupNoResults')}
          legacySuffix={t('legacyValueSuffix')}
        />
      </Field>
      <Field label={t('colName')} className={inDialog ? 'sm:col-span-2' : undefined}>
        <input
          name="name"
          value={schemeName}
          onChange={(e) => setSchemeName(e.target.value)}
          required
          placeholder={t('schemeNamePlaceholder')}
          className={inputCls}
        />
      </Field>
      <Field label={t('colStatus')}>
        <select name="status" defaultValue={scheme?.status ?? 'active'} className={inputCls}>
          <option value="active">{t('statusActive')}</option>
          <option value="inactive">{t('statusInactive')}</option>
        </select>
      </Field>
      {inDialog ? (
        <div className="flex justify-end sm:col-span-2">
          <Button type="submit" size="sm">{scheme ? t('save') : t('addScheme')}</Button>
        </div>
      ) : (
        <Button type="submit" size="sm">{scheme ? t('save') : t('addScheme')}</Button>
      )}
    </form>
  );
}

/**
 * SchemeEditDialog (R44 4a97f681) — the scheme Edit form now opens in a centred Radix Dialog modal instead of
 * the cramped right-side <details> disclosure, giving the fields room to breathe. Presentation only: it hosts
 * the SAME SchemeForm + updateScheme server action. On Save it closes immediately and the action's revalidate
 * refreshes the list (staying on the page). Cancel / overlay / Esc close without saving.
 * Feedback b7d04d7d: the delete form moved OUT of this dialog onto the scheme row (with a confirmation) —
 * the dialog is now purely for editing, so its footer is just Cancel.
 */
function SchemeEditDialog({
  scheme,
  companies,
  groups,
  empTypeLabel,
  updateScheme,
  t,
}: {
  scheme: Scheme;
  companies: Company[];
  groups: GradeGroup[];
  empTypeLabel: (v: string) => string;
  updateScheme: (fd: FormData) => void | Promise<void>;
  t: ReturnType<typeof useTranslations>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="cursor-pointer text-xs text-primary hover:underline">
          {t('edit')}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        {/* max-w-3xl (item 0ad01560): a touch wider than the old max-w-2xl so long company / grade-group
            names fit; max-h + overflow-y kept so the taller two-column form scrolls rather than overflows. */}
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg">
          <Dialog.Title className="text-base font-semibold">{t('editSchemeTitle')}</Dialog.Title>
          <div className="mt-4 space-y-3">
            <SchemeForm
              action={(fd) => {
                setOpen(false);
                return updateScheme(fd);
              }}
              companies={companies}
              groups={groups}
              empTypeLabel={empTypeLabel}
              t={t}
              scheme={scheme}
              layout="dialog"
            />
            <div className="flex justify-end border-t border-border pt-3">
              <Dialog.Close asChild>
                <Button type="button" size="sm" variant="outline">{t('cancel')}</Button>
              </Dialog.Close>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * CopyEntitlementsDialog (R44 ba494b21) — copy all leave entitlements from a source scheme into the current
 * (target) scheme, SKIPPING any leave type the target already has. A preview (computed client-side from the
 * already-loaded entitlements) shows what will be copied vs skipped BEFORE the confirm submit. On confirm it
 * posts copySchemeEntitlements; the action revalidates + the list refreshes.
 */
function CopyEntitlementsDialog({
  targetSchemeId,
  schemes,
  entitlements,
  action,
  t,
}: {
  targetSchemeId: string;
  schemes: Scheme[];
  entitlements: Entitlement[];
  action: (fd: FormData) => void | Promise<void>;
  t: ReturnType<typeof useTranslations>;
}) {
  const [open, setOpen] = useState(false);
  const [sourceId, setSourceId] = useState('');

  const targetTypeIds = useMemo(
    () => new Set(entitlements.filter((e) => e.benefitSchemeId === targetSchemeId).map((e) => e.leaveTypeId)),
    [entitlements, targetSchemeId],
  );
  const preview = useMemo(() => {
    if (!sourceId) return [] as { name: string; willCopy: boolean }[];
    return entitlements
      .filter((e) => e.benefitSchemeId === sourceId)
      .map((e) => ({ name: e.leaveTypeName ?? '—', willCopy: !targetTypeIds.has(e.leaveTypeId) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [entitlements, sourceId, targetTypeIds]);
  const copyCount = preview.filter((p) => p.willCopy).length;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setSourceId('');
      }}
    >
      <Dialog.Trigger asChild>
        <Button type="button" size="sm" variant="outline">{t('copyButton')}</Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg">
          <Dialog.Title className="text-base font-semibold">{t('copyTitle')}</Dialog.Title>
          <div className="mt-4 space-y-3">
            <Field label={t('copySourceLabel')}>
              <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} className={inputCls}>
                <option value="" disabled>{t('copySourcePlaceholder')}</option>
                {schemes
                  .filter((s) => s.id !== targetSchemeId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
              </select>
            </Field>
            {!sourceId ? (
              <p className="text-xs text-muted-foreground">{t('copyEmpty')}</p>
            ) : preview.length === 0 || copyCount === 0 ? (
              <p className="text-xs text-muted-foreground">{t('copyNoneToCopy')}</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border text-sm">
                {preview.map((p, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 px-3 py-1.5">
                    <span className="text-foreground">{p.name}</span>
                    <Badge variant={p.willCopy ? 'success' : 'default'}>
                      {p.willCopy ? t('copyPreviewCopy') : t('copyPreviewSkip')}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Dialog.Close asChild>
                <Button type="button" size="sm" variant="outline">{t('cancel')}</Button>
              </Dialog.Close>
              <form
                action={(fd) => {
                  setOpen(false);
                  return action(fd);
                }}
              >
                <input type="hidden" name="sourceSchemeId" value={sourceId} />
                <input type="hidden" name="targetSchemeId" value={targetSchemeId} />
                <Button type="submit" size="sm" disabled={!sourceId || copyCount === 0}>
                  {t('copyConfirm')}
                </Button>
              </form>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * EntitlementEditDialog (R47 edb0309d) — per-row Edit for a leave entitlement. The R44 fdc3f521 dup guard
 * closed the old "re-enter the same leave type to overwrite" path, so this dialog restores editing via the
 * SAME upsertSchemeEntitlement action (onConflictDoUpdate does the update server-side). The leave type is
 * LOCKED in edit mode: changing it would be a delete-and-add and could collide with the unique
 * (scheme, leave type) index.
 */
function EntitlementEditDialog({
  entitlement,
  action,
  t,
}: {
  entitlement: Entitlement;
  action: (fd: FormData) => void | Promise<void>;
  t: ReturnType<typeof useTranslations>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button type="button" variant="ghost" size="sm">{t('edit')}</Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg">
          <Dialog.Title className="text-base font-semibold">{t('editEntitlementTitle')}</Dialog.Title>
          <div className="mt-4 space-y-3">
            <EntitlementForm
              action={(fd) => {
                setOpen(false);
                return action(fd);
              }}
              schemeId={entitlement.benefitSchemeId}
              leaveTypes={[]}
              existingLeaveTypeIds={[]}
              entitlement={entitlement}
              t={t}
            />
            <div className="flex justify-end border-t border-border pt-3">
              <Dialog.Close asChild>
                <Button type="button" size="sm" variant="outline">{t('cancel')}</Button>
              </Dialog.Close>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Restructure Leave Type Configuration Tabs (feedback 123c1e76) — the per-leave-type "Entitlement" card's
 * read-and-edit view of this type's benefit-scheme entitlement rows. Edit reuses EntitlementEditDialog — the
 * SAME upsertSchemeEntitlement action the shared Benefit Schemes table posts, so the two surfaces can never
 * diverge (both read scheme_leave_entitlement live). Scheme-wide management — adding/removing entitlements,
 * copying between schemes and combined-limit (shared-cap) grouping — deliberately stays on the Benefit
 * Schemes section of the Entitlements tab; a row inside a combined pool shows its shared cap read-only here.
 *
 * a03eff24 (Grade Group Matrix) — the flat "one row per scheme, company name repeated on every row" list is
 * now a MATRIX: company down the side (printed once per company block, blank on its following rows), the
 * scheme's grade group × employment type as the row, service tenure across the top, days typed straight into
 * the cells. That IS the shape the data already has — a benefit scheme is (company, employment type, grade
 * group), so the grade group is the row identity and the company is the only thing that repeats. Nothing
 * about storage or resolution moved: cells read and write the same scheme_leave_entitlement.serviceBands
 * through the same upsert action.
 */
export type LeaveTypeSchemeEntitlement = Entitlement & {
  /** Owning scheme's display name — the secondary line under the grade group (a scheme name is free text,
   *  so it stays visible: it is the only label an admin can search for). */
  schemeName: string;
  /** Feedback 0d1a0cfc — the owning scheme's COMPANY name. a03eff24 promoted it to the matrix's merged
   *  first column. Derived on the page from the already-loaded company list (never stored); null when the
   *  company cannot be resolved. */
  companyName: string | null;
  /** a03eff24 — the scheme's grade group and employment type: together they are the matrix ROW (the unique
   *  index on benefit_scheme is (company, employment_type, grade_group), so no two rows of one company can
   *  collide). gradeGroupName is null for a scheme that targets an ungrouped population. Both come from the
   *  benefit-scheme rows the page already loads — no new query, nothing stored. */
  gradeGroupName: string | null;
  employmentType: string;
  /** Combined-limit pool this leave type belongs to within that scheme; null = not pooled. Read-only here. */
};

/** One tenure COLUMN of the matrix — a service-band bracket read off the rows that are actually stored. */
export type TenureColumn = { fromYears: number; toYears: number | null };

/** Boundary fingerprint of a band list. Days are deliberately excluded: two schemes share a column set when
 *  their brackets start and stop in the same places, whatever days they grant. */
export function bandShapeKey(bands: ServiceBand[]): string {
  return bands.map((b) => `${Number(b.fromYears)}:${b.toYears == null ? '*' : Number(b.toYears)}`).join('|');
}

/** The bands a matrix cell edit SUBMITS: each stored band spread, with only `days` replaced by what was
 *  typed. Spreading is the whole point — a band may also carry carryForwardDays / expiry / maxBalanceDays,
 *  and rebuilding the list from scratch (the dialog form's approach) would drop them. Blank or unparseable
 *  input reads as 0, matching the `required` number inputs' own floor. */
export function matrixBandsWithDays(stored: ServiceBand[], days: string[]): ServiceBand[] {
  return stored.map((b, i) => ({ ...b, days: Number(days[i] || 0) }));
}

/** a03eff24 — the tenure columns are DERIVED, never hardcoded to 0/2/5. A tenant that configured 3/7, or
 *  four brackets, must see its own brackets; rewriting them to the reporter's example would silently change
 *  what employees are entitled to. The column set is the bracket shape the most rows already use (ties go to
 *  the first row, which is scheme-name order, so the choice is deterministic); a row on any OTHER shape keeps
 *  its own brackets and is edited through the dialog rather than flattened into columns it does not have —
 *  the same refusal isConformingServiceShape makes for the sibling company × grade table. */
export function deriveTenureColumns(
  ents: { serviceBands: ServiceBand[] }[],
): { columns: TenureColumn[]; shapeKey: string } {
  const toColumns = (bands: ServiceBand[]): TenureColumn[] =>
    bands.map((b) => ({ fromYears: Number(b.fromYears), toYears: b.toYears == null ? null : Number(b.toYears) }));
  const byShape = new Map<string, { bands: ServiceBand[]; count: number }>();
  for (const e of ents) {
    if (!Array.isArray(e.serviceBands) || e.serviceBands.length === 0) continue;
    const key = bandShapeKey(e.serviceBands);
    const hit = byShape.get(key);
    if (hit) hit.count += 1;
    else byShape.set(key, { bands: e.serviceBands, count: 1 });
  }
  let best: { key: string; bands: ServiceBand[]; count: number } | null = null;
  for (const [key, v] of byShape) if (!best || v.count > best.count) best = { key, bands: v.bands, count: v.count };
  if (!best) {
    // Every row's band list is empty or malformed — head the matrix with the 0/2/5 template the add form
    // writes, so the columns still read sensibly instead of collapsing to none.
    const template: ServiceBand[] = [
      { fromYears: 0, toYears: 2, days: 0 },
      { fromYears: 2, toYears: 5, days: 0 },
      { fromYears: 5, toYears: null, days: 0 },
    ];
    return { columns: toColumns(template), shapeKey: bandShapeKey(template) };
  }
  return { columns: toColumns(best.bands), shapeKey: best.key };
}

/** Column heading for one bracket, reusing the parameterised tier strings (0aa304a1) so a 3/7 tenant reads
 *  "Under 3 years / 3 to under 7 years / 7 years and over" with no new vocabulary. */
function tenureColumnLabel(c: TenureColumn, t: ReturnType<typeof useTranslations>): string {
  if (c.toYears == null) return c.fromYears === 0 ? t('tierAll') : t('tierOver', { n1: c.fromYears, n2: c.fromYears });
  if (c.fromYears === 0) return t('tierUnder', { n1: c.toYears, n2: c.toYears });
  return t('tierMid', { n1: c.fromYears, n2: c.toYears });
}

/** Grid shared by the matrix header and every row: company · grade group · the tenure cells · action. The
 *  tenure cells live in ONE flex track so the column COUNT can vary per tenant without a dynamic class. */
const matrixGridCls = 'grid grid-cols-[minmax(6rem,0.8fr)_minmax(9rem,1.4fr)_auto_auto] items-start gap-2';
/** 9816a5ad — the same grid without the company track. Service Based Entitlements picks ONE company in a
 *  dropdown before any row exists, so a merged company cell there would only ever be an empty column. */
const matrixCompactGridCls = 'grid grid-cols-[minmax(9rem,1.4fr)_auto_auto] items-start gap-2';

/**
 * One matrix row = one scheme's entitlement for this leave type.
 *
 * Self-contained state so an UNTOUCHED row is never written (Save stays disabled until a figure changes) —
 * the ServiceGradeRow precedent, and the reason a re-render cannot fire a spurious cohort recalc. The
 * submitted bands SPREAD each stored band and override only `days`, so per-band carry-forward and
 * max-balance settings survive a cell edit instead of being rebuilt away.
 */
function SchemeEntitlementMatrixRow({
  ent,
  columns,
  editableInline,
  companyLabel,
  gradeGroupLabel,
  action,
  compact = false,
  note = null,
  t,
}: {
  ent: LeaveTypeSchemeEntitlement;
  columns: TenureColumn[];
  /** false when this scheme's brackets differ from the matrix columns — days show read-only under their OWN
   *  labels and the dialog (which round-trips the row's own cutoffs) is the way to change them. */
  editableInline: boolean;
  /** Null on every row but the first of its company block — that blank is the "merged" company cell. */
  companyLabel: string | null;
  gradeGroupLabel: string;
  action: (fd: FormData) => void | Promise<void>;
  /** 9816a5ad — drop the company track entirely (the Service Based Entitlements table picks one company). */
  compact?: boolean;
  /** 9816a5ad — a per-row footnote under the scheme name: "not configured for this type yet", or the
   *  grade-level figure this scheme disagrees with. Nothing is written on the strength of it — it exists so
   *  a disagreement is TOLD to the admin instead of one figure quietly winning. */
  note?: React.ReactNode;
  t: ReturnType<typeof useTranslations>;
}) {
  const stored = ent.serviceBands;
  const [days, setDays] = useState<string[]>(() => stored.map((b) => String(b.days ?? '')));
  const dirty = days.some((v, i) => Number(v || 0) !== Number(stored[i]?.days ?? 0));
  const bands = matrixBandsWithDays(stored, days);
  const gridCls = compact ? matrixCompactGridCls : matrixGridCls;

  // r76 48224d12 — one scheme, said once. `gradeGroupLabel` is built by the shared naming rule
  // (lib/benefit-scheme-label), and the stored scheme name is printed beneath it ONLY when it adds
  // something: "Leadership" + "Leadership scheme" is the same words twice, "Leadership" + "Executive
  // package" is not, and dropping the second there would lose the tenant's own name. Both entitlement
  // matrices share this row, so BOTH read the same way — the two surfaces naming a scheme identically is a
  // pre-existing invariant of this file, and splitting them here would be the drift it was written to stop.
  const schemeNameLine = schemeNameIsRedundant(
    ent.schemeName,
    gradeGroupLabel,
    t(`empType_${ent.employmentType}` as `empType_${(typeof EMPLOYMENT_TYPES)[number]}`),
  )
    ? null
    : ent.schemeName;

  const identity = (
    <>
      {!compact && <span className="text-sm font-medium">{companyLabel ?? ''}</span>}
      <span className="flex flex-col">
        <span className="text-sm font-medium">{gradeGroupLabel}</span>
        {schemeNameLine != null && (
          <span className="text-xs font-normal text-muted-foreground">{schemeNameLine}</span>
        )}
        {/* r88 1ef1cf95: the "Shared limit <name>: <days> days/year" line is gone from this row. A shared
            group is no longer a property of a scheme entitlement, so a per-scheme row cannot report one. */}
        {note}
      </span>
    </>
  );

  if (!editableInline) {
    return (
      <div className={`${gridCls} border-b border-border px-3 py-2 last:border-0`}>
        {identity}
        <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {stored.map((b, i) => (
            <span key={i} className="tabular-nums">
              {tenureColumnLabel({ fromYears: Number(b.fromYears), toYears: b.toYears == null ? null : Number(b.toYears) }, t)}
              {': '}
              {Number(b.days ?? 0)}
            </span>
          ))}
          <span className="basis-full text-[11px]">{t('perTypeOtherTenure')}</span>
        </span>
        <EntitlementEditDialog entitlement={ent} action={action} t={t} />
      </div>
    );
  }

  return (
    <form action={action} className={`${gridCls} border-b border-border px-3 py-2 last:border-0`}>
      <input type="hidden" name="benefitSchemeId" value={ent.benefitSchemeId} />
      <input type="hidden" name="leaveTypeId" value={ent.leaveTypeId} />
      <input type="hidden" name="serviceBands" value={JSON.stringify(bands)} />
      {identity}
      <span className="flex gap-2">
        {columns.map((c, i) => (
          <input
            key={i}
            type="number"
            min="0"
            step="0.5"
            required
            value={days[i] ?? ''}
            onChange={(e) => setDays((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
            aria-label={t('perTypeDaysAria', { scheme: gradeGroupLabel, band: tenureColumnLabel(c, t) })}
            className={`${inputCls} w-16`}
          />
        ))}
      </span>
      <Button type="submit" size="sm" disabled={!dirty}>
        {t('save')}
      </Button>
    </form>
  );
}

export function LeaveTypeEntitlementTable({
  ents,
  upsertEntitlement,
}: {
  ents: LeaveTypeSchemeEntitlement[];
  upsertEntitlement: (fd: FormData) => void | Promise<void>;
}) {
  const t = useTranslations('admin.benefitScheme');
  const empTypeLabel = (v: string) => t(`empType_${v}` as `empType_${(typeof EMPLOYMENT_TYPES)[number]}`);
  const { columns, shapeKey } = useMemo(() => deriveTenureColumns(ents), [ents]);
  // Company blocks: every scheme of one company sits together so the name can be printed once. Unnamed
  // companies sink to the bottom rather than heading the matrix with a blank label.
  const companyBlocks = useMemo(() => {
    const byCompany = new Map<string, LeaveTypeSchemeEntitlement[]>();
    for (const e of ents) {
      const key = e.companyName ?? '';
      const arr = byCompany.get(key);
      if (arr) arr.push(e);
      else byCompany.set(key, [e]);
    }
    return [...byCompany.entries()]
      .sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0])))
      .map(([key, rows]) => ({ key, companyName: rows[0].companyName, rows }));
  }, [ents]);

  if (ents.length === 0) {
    return <p className="rounded-lg bg-background px-3 py-2 text-xs text-muted-foreground">{t('perTypeEmpty')}</p>;
  }
  return (
    <div className="space-y-1.5">
      <div className="overflow-x-auto rounded-lg border border-border">
        <div className="min-w-[44rem]">
          <div className={`${matrixGridCls} border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground`}>
            <span>{t('colCompany')}</span>
            <span>{t('colGradeGroup')}</span>
            <span className="flex gap-2">
              {columns.map((c, i) => (
                <span key={i} className="w-16 text-[11px] leading-tight">
                  {tenureColumnLabel(c, t)}
                </span>
              ))}
            </span>
            <span />
          </div>
          {companyBlocks.map((block) =>
            block.rows.map((e, i) => (
              <SchemeEntitlementMatrixRow
                // The stored days are part of the key (the ServiceGradeRow remount precedent): a row holds
                // its typed values in local state, so when the server sends a different figure — after this
                // admin's own save, or someone else's — the row remounts and re-seeds from the truth
                // instead of showing a stale draft.
                key={`${e.id}:${e.serviceBands.map((b) => b.days).join(',')}`}
                ent={e}
                columns={columns}
                editableInline={
                  Array.isArray(e.serviceBands) && e.serviceBands.length > 0 && bandShapeKey(e.serviceBands) === shapeKey
                }
                companyLabel={i === 0 ? block.companyName : null}
                /* r76 48224d12 — the shared naming rule, the same call the Service Based Entitlements table
                   makes. It replaces an inline template that appended the employment type unconditionally,
                   so a grade group already named "GRADE 12-15 (PERMANENT)" read "… (Permanent)" twice. */
                gradeGroupLabel={benefitSchemeDisplayName(
                  { name: e.schemeName, gradeGroupName: e.gradeGroupName },
                  { employmentTypeLabel: empTypeLabel(e.employmentType), allGradesLabel: t('perTypeAllGrades') },
                )}
                action={upsertEntitlement}
                t={t}
              />
            )),
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('perTypeManageNote')}</p>
    </div>
  );
}

// ─────────────────── Service-Based Entitlements (company × benefit scheme) ───────────────────
// 9816a5ad — Move Benefit Scheme Entitlement Maintenance into Service Based Entitlements.
//
// The middle column used to be the JOB GRADE, and the days typed there were written into the grade-scoped
// leave_policy store. Leave eligibility and entitlement are driven by BENEFIT SCHEME now, so the same
// figures were being maintained twice — once per grade here, once per scheme under Benefit Schemes — with
// nothing keeping them in step. The middle column is the scheme, and a row writes
// scheme_leave_entitlement.serviceBands through the SAME upsert action the Benefit Schemes surface posts:
// one store, one writer, two entry points (the a03eff24 discipline, and the reason the two cannot drift).
//
// The grade-level leave_policy rows are deliberately NOT migrated or deleted. They still resolve for anyone
// no scheme covers (a grade in no grade group matches no scheme — resolveEffectiveSchemeId is an exact
// (company, employment type, grade group) match), and they stay editable on the per-company entitlement
// timeline directly below this table. Where the two disagree for a scheme's own grades the row SAYS so
// rather than letting one figure quietly win: an entitlement figure decides how much leave someone gets,
// so a silent last-writer-wins here is the one outcome worth avoiding.

/** The minimal active/inactive policy shape the table samples (mapped from the panel's per-type
 *  EntitlementPolicy list — validTo null = active). Read-only here: it feeds the disagreement note only. */
export type ServicePolicyRow = {
  gradeId: string | null;
  companyId: string | null;
  annualDays: number;
  serviceBands: ServiceBand[] | null;
  validTo: string | null;
};

/** One benefit scheme as the Service Based Entitlements picker lists it. */
export type ServiceSchemeRow = {
  id: string;
  companyId: string;
  name: string;
  gradeGroupId: string | null;
  gradeGroupName: string | null;
  employmentType: string;
  status: string;
};

/** The service length to sample a tenure column at: the middle of a closed bracket, a year past the start
 *  of the open-ended one. Any point inside the bracket resolves to the same band, so the choice only has to
 *  be INSIDE it — 0–2 samples at 1, 2–5 at 3.5, 5+ at 6. */
export function sampleYearsForColumn(c: TenureColumn): number {
  return c.toYears == null ? c.fromYears + 1 : c.fromYears + (c.toYears - c.fromYears) / 2;
}

/** 9816a5ad — what the GRADE-level policies currently give the grades of one benefit scheme, one figure per
 *  tenure column, de-duplicated (a group whose grades all resolve alike yields a single tuple). Empty when
 *  the scheme covers no grades. Pure: this is the reconciliation the plan promises, and it only ever
 *  DISPLAYS — nothing here writes, so a disagreement is reported, never resolved by guesswork. */
export function gradeLevelServiceDays(
  rows: GradePolicyRow[],
  gradeIds: string[],
  companyId: string,
  columns: TenureColumn[],
): number[][] {
  const seen = new Set<string>();
  const out: number[][] = [];
  for (const gradeId of gradeIds) {
    const tuple = columns.map(
      (c) => resolveGradePolicy(rows, gradeId, companyId, sampleYearsForColumn(c))?.days ?? 0,
    );
    const key = tuple.join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tuple);
  }
  return out;
}

/** The stored bands a scheme with NO entitlement row for this leave type starts from: the table's own
 *  columns at zero days. Nothing is written until a figure is typed (Save stays disabled while the row is
 *  untouched), so listing an unconfigured scheme never grants days by itself — which is what keeps ADR-0066
 *  festive / ad-hoc types out of the accrual engines exactly as before. */
export function blankBandsForColumns(columns: TenureColumn[]): ServiceBand[] {
  return columns.map((c) => ({ fromYears: c.fromYears, toYears: c.toYears, days: 0 }));
}

export function ServiceEntitlementTable({
  leaveTypeId,
  leaveTypeName,
  companies,
  schemes,
  entitlements,
  upsertEntitlement,
}: {
  leaveTypeId: string;
  leaveTypeName: string;
  companies: { id: string; name: string }[];
  /** Every benefit scheme in the tenant; the picked company narrows them. */
  schemes: ServiceSchemeRow[];
  /** Grade-group membership. RETAINED and deliberately not read: it was the input to the grade-level
   *  disagreement note that r76 48224d12 removed (see the note above the rows). The wiring, the props and
   *  the pure reconciliation helpers are all left standing so putting the note back is an edit to THIS
   *  component alone — investigation 9816a5ad is asking which of the two configurations actually drives a
   *  balance, and if the answer is "the admin must be told when they disagree", nothing has to be rebuilt. */
  gradeGroups: { id: string; gradeIds: string[] }[];
  /** THIS leave type's scheme entitlement rows (the same rows the Benefit Schemes matrix renders). */
  entitlements: LeaveTypeSchemeEntitlement[];
  /** RETAINED and deliberately not read — see `gradeGroups`. */
  policies: ServicePolicyRow[];
  upsertEntitlement: (fd: FormData) => void | Promise<void>;
}) {
  const t = useTranslations('admin.leave');
  const tb = useTranslations('admin.benefitScheme');
  const [companyId, setCompanyId] = useState('');
  const empTypeLabel = (v: string) => tb(`empType_${v}` as `empType_${(typeof EMPLOYMENT_TYPES)[number]}`);

  // Only ACTIVE schemes are offered: resolveEffectiveSchemeId matches active schemes only, so an inactive
  // one grants nobody anything and editing its days here would look like a change that does nothing.
  //
  // r76 48224d12 — picking the company is the ONLY selection: every active scheme of that company is listed
  // straight away (it already was; nothing was added here). The order is the shared display order
  // (lib/benefit-scheme-label): employment type first — Permanent, Contract, Part-time, Intern — then the
  // grade wording the row shows, numerically collated so "Grade 2" precedes "Grade 12", then the scheme id.
  // Total and stable, so one company lists its schemes the same way every time; it replaces a plain
  // name.localeCompare that put every employment type in one alphabetical run.
  const companySchemes = useMemo(
    () =>
      schemes
        .filter((s) => s.companyId === companyId && s.status === 'active')
        .sort(bySchemeDisplayOrder((s) => s.gradeGroupName ?? s.name)),
    [schemes, companyId],
  );
  const entBySchemeId = useMemo(
    () => new Map(entitlements.map((e) => [e.benefitSchemeId, e])),
    [entitlements],
  );
  // Columns are DERIVED from the brackets this company's schemes actually store (a03eff24) — never the
  // hardcoded 0/2/5, which would mislabel a tenant on 3/7 and then rewrite their figures on save.
  const { columns, shapeKey } = useMemo(
    () =>
      deriveTenureColumns(
        companySchemes.flatMap((s) => {
          const e = entBySchemeId.get(s.id);
          return e ? [e] : [];
        }),
      ),
    [companySchemes, entBySchemeId],
  );

  // r76 48224d12 — the grade-level DISAGREEMENT NOTE is gone from this table, as the item asked: the
  // reporter reads this screen as the scheme figures, and the amber line about the grade-level policies was
  // not what they came for. The two memos that fed it (the active grade policies in resolveGradePolicy's
  // shape, and grade ids by group) are removed with it; `gradeLevelServiceDays` / `sampleYearsForColumn`
  // above are KEPT — they are pure, unit-tested, and they are the restoration path.
  //
  // ⚠ This was the ONLY place in the product that told an administrator the two entitlement configurations
  // disagree. Nothing about that disagreement changed — the grade-level rows still exist, still resolve for
  // anyone no scheme covers, and are still editable on the timeline below; it is only no longer ANNOUNCED
  // here. Investigation 9816a5ad is asking which configuration actually drives a balance; if its answer
  // needs the warning back, everything it needs is still in this file.
  const rows = useMemo(
    () =>
      companySchemes.map((scheme) => {
        const stored = entBySchemeId.get(scheme.id) ?? null;
        const ent: LeaveTypeSchemeEntitlement = stored ?? {
          // A scheme with no row for this leave type is still listed — that is the whole point of "the list
          // of Benefit Schemes for the company", and the upsert creates the row on first save.
          id: `unconfigured:${scheme.id}`,
          benefitSchemeId: scheme.id,
          leaveTypeId,
          leaveTypeName,
          serviceBands: blankBandsForColumns(columns),
          schemeName: scheme.name,
          companyName: null,
          gradeGroupName: scheme.gradeGroupName,
          employmentType: scheme.employmentType,
        };
        // A scheme on its own brackets is edited through the dialog rather than flattened into these
        // columns — unchanged.
        const conforming = ent.serviceBands.length > 0 && bandShapeKey(ent.serviceBands) === shapeKey;
        return { scheme, stored, ent, conforming };
      }),
    [companySchemes, entBySchemeId, columns, shapeKey, leaveTypeId, leaveTypeName],
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('serviceCompanyLabel')}>
          <select
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
            aria-label={t('serviceCompanyLabel')}
            className={`${inputCls} w-56`}
          >
            <option value="">{t('serviceSelectCompanyPlaceholder')}</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {!companyId ? (
        <p className="rounded-lg bg-background px-3 py-2 text-xs text-muted-foreground">
          {t('serviceSelectCompanyEmpty')}
        </p>
      ) : companySchemes.length === 0 ? (
        <p className="rounded-lg bg-background px-3 py-2 text-xs text-muted-foreground">
          {t('serviceNoSchemes')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <div className="min-w-[36rem]">
            <div
              className={`${matrixCompactGridCls} border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground`}
            >
              <span>{tb('perTypeColScheme')}</span>
              <span className="flex gap-2">
                {columns.map((c, i) => (
                  <span key={i} className="w-16 text-[11px] leading-tight">
                    {tenureColumnLabel(c, tb)}
                  </span>
                ))}
              </span>
              <span />
            </div>
            {rows.map(({ scheme, stored, ent, conforming }) => (
              <SchemeEntitlementMatrixRow
                // The stored days are part of the key (the a03eff24 remount precedent): when the server
                // sends a different figure — after this admin's save or someone else's — the row remounts
                // and re-seeds from the truth instead of showing a stale draft.
                key={`${scheme.id}:${ent.serviceBands.map((b) => b.days).join(',')}`}
                ent={ent}
                columns={columns}
                editableInline={conforming}
                companyLabel={null}
                compact
                /* r76 48224d12 — the shared naming rule: ONE line, the employment type said once. It
                   replaces an inline template that always appended "(Permanent)", which read
                   "GRADE 12-15 (PERMANENT) (Permanent)" for a tenant who had put the type in their own
                   grade-group name. Stored names are untouched — this is the render layer only. */
                gradeGroupLabel={benefitSchemeDisplayName(scheme, {
                  employmentTypeLabel: empTypeLabel(scheme.employmentType),
                  allGradesLabel: tb('perTypeAllGrades'),
                })}
                note={
                  stored == null ? (
                    <span className="text-xs font-normal text-muted-foreground">
                      {t('serviceSchemeUnconfigured')}
                    </span>
                  ) : null
                }
                action={upsertEntitlement}
                t={tb}
              />
            ))}
          </div>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t('serviceTableNote')}</p>
    </div>
  );
}

function EntitlementForm({
  action,
  schemeId,
  leaveTypes,
  existingLeaveTypeIds,
  entitlement = null,
  defaultLeaveTypeId,
  t,
}: {
  action: (fd: FormData) => void | Promise<void>;
  schemeId: string;
  leaveTypes: LeaveType[];
  existingLeaveTypeIds: string[];
  /** R47 edb0309d: when set, the form EDITS this row — leave type locked, day values pre-filled from its
   *  stored serviceBands (including legacy non-2/5 cutoffs, which are preserved on save). */
  entitlement?: Entitlement | null;
  /** 6c775d68: ADD-mode preselection — the scoped Entitlement step seeds its own leave type (still
   *  changeable; the dup guard fires as usual if the scheme already configures it). */
  defaultLeaveTypeId?: string;
  t: ReturnType<typeof useTranslations>;
}) {
  // Fixed three-band day entry (R44 6421c888): service bands are hardcoded at 0–2 / 2–5 / 5+ years — HR
  // types the days directly into each predefined range, no tier-cutoff inputs. The 0/2/5 shape satisfies
  // validateBands and is the SAME contiguous ServiceBand[] the resolver reads. Legacy rows stored with other
  // cutoffs keep their own values + calculate correctly (read-side table derives each row's own labels).
  // In EDIT mode the row's OWN cutoffs (tiersFromBands) seed both the values and the band shape written back.
  const editTiers = entitlement ? tiersFromBands(entitlement.serviceBands) : null;
  const [leaveTypeId, setLeaveTypeId] = useState(entitlement?.leaveTypeId ?? defaultLeaveTypeId ?? '');
  const [d0, setD0] = useState(editTiers?.d0 ?? '');
  const [d1, setD1] = useState(editTiers?.d1 ?? '');
  const [d2, setD2] = useState(editTiers?.d2 ?? '');
  const n1 = editTiers?.n1 ?? 2;
  const n2 = editTiers?.n2 ?? 5;

  // R44 fdc3f521: block adding a leave type already configured in this scheme (silent-overwrite guard). On a
  // duplicate the field shakes + an inline error shows, WITHOUT clearing the other entered values. shakeKey
  // remounts the field wrappers so the shake animation replays on repeated attempts.
  const [dupError, setDupError] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);

  // R44 a831b4ca: mandatory-field validation. On submit we collect ALL empty required fields at once and
  // highlight every one together (shake), rather than one at a time. Field keys: 'leaveType','d0','d1','d2'.
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [requiredError, setRequiredError] = useState(false);

  // R44 3d2ac99f: always present the Leave Type options alphabetically (A–Z by name) for predictable
  // scanning. Active-only filtering already happens upstream (activeTypeOptions); this is display-order only.
  const sortedLeaveTypes = useMemo(
    () => [...leaveTypes].sort((a, b) => a.name.localeCompare(b.name)),
    [leaveTypes],
  );

  const bands: ServiceBand[] = [
    { fromYears: 0, toYears: n1, days: Number(d0) || 0 },
    { fromYears: n1, toYears: n2, days: Number(d1) || 0 },
    { fromYears: n2, toYears: null, days: Number(d2) || 0 },
  ];

  // Client action wrapper: validate before delegating to the server action. Blocking simply returns without
  // calling `action`, so the entered values survive (all fields are controlled state).
  const handleAction = (fd: FormData) => {
    // 1) Mandatory fields — collect ALL empties at once so every missing one is highlighted together.
    const empty = new Set<string>();
    if (!leaveTypeId) empty.add('leaveType');
    if (d0 === '') empty.add('d0');
    if (d1 === '') empty.add('d1');
    if (d2 === '') empty.add('d2');
    if (empty.size > 0) {
      setMissing(empty);
      setRequiredError(true);
      setDupError(false);
      setShakeKey((k) => k + 1);
      return;
    }
    // 2) Duplicate leave type in this scheme — ADD mode only (R47 edb0309d): when editing, the form's
    //    leaveTypeId is by definition already configured (that IS the row being edited), so the guard must
    //    not fire; it keeps firing for genuine adds.
    if (!entitlement && leaveTypeId && existingLeaveTypeIds.includes(leaveTypeId)) {
      setDupError(true);
      setRequiredError(false);
      setMissing(new Set());
      setShakeKey((k) => k + 1);
      return;
    }
    setMissing(new Set());
    setRequiredError(false);
    setDupError(false);
    return action(fd);
  };

  // Edit mode labels interpolate the ROW's actual cutoffs (legacy rows may not be 2/5); add mode keeps the
  // fixed 0–2 / 2–5 / 5+ wording.
  const tierLabels = entitlement
    ? ([t('tierUnder', { n1, n2 }), t('tierMid', { n1, n2 }), t('tierOver', { n1, n2 })] as const)
    : ([t('tierUnderFixed'), t('tierMidFixed'), t('tierOverFixed')] as const);

  return (
    <form
      action={handleAction}
      className={entitlement ? 'space-y-3' : 'space-y-3 rounded-lg border border-dashed border-border p-3'}
    >
      <input type="hidden" name="benefitSchemeId" value={schemeId} />
      <input type="hidden" name="serviceBands" value={JSON.stringify(bands)} />
      {!entitlement && <p className="text-xs font-medium text-muted-foreground">{t('addEntitlement')}</p>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
        <div key={`lt-${shakeKey}`} className={dupError || missing.has('leaveType') ? 'animate-shake' : ''}>
          {entitlement ? (
            /* Leave type is LOCKED when editing — changing it is really delete-and-add and would collide
               with the unique (scheme, leave type) index. Hidden input keeps the FormData contract. */
            <Field label={t('colLeaveType')}>
              <>
                <input type="hidden" name="leaveTypeId" value={entitlement.leaveTypeId} />
                <input
                  value={entitlement.leaveTypeName ?? '—'}
                  readOnly
                  disabled
                  className={`${inputCls} cursor-not-allowed opacity-70`}
                />
              </>
            </Field>
          ) : (
            <Field label={t('colLeaveType')} required requiredAriaLabel={t('requiredAria')}>
              <select
                name="leaveTypeId"
                required
                value={leaveTypeId}
                onChange={(e) => {
                  setLeaveTypeId(e.target.value);
                  setDupError(false);
                  setMissing((m) => {
                    if (!m.has('leaveType')) return m;
                    const n = new Set(m);
                    n.delete('leaveType');
                    return n;
                  });
                }}
                className={inputCls}
              >
                <option value="" disabled>{t('selectPlaceholder')}</option>
                {sortedLeaveTypes.map((lt) => (
                  <option key={lt.id} value={lt.id}>{lt.name}</option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <div key={`d0-${shakeKey}`} className={missing.has('d0') ? 'animate-shake' : ''}>
          <Field label={tierLabels[0]} required requiredAriaLabel={t('requiredAria')}>
            <input type="number" min={0} step="0.5" value={d0} onChange={(e) => setD0(e.target.value)} className={`${inputCls} w-20`} />
          </Field>
        </div>
        <div key={`d1-${shakeKey}`} className={missing.has('d1') ? 'animate-shake' : ''}>
          <Field label={tierLabels[1]} required requiredAriaLabel={t('requiredAria')}>
            <input type="number" min={0} step="0.5" value={d1} onChange={(e) => setD1(e.target.value)} className={`${inputCls} w-20`} />
          </Field>
        </div>
        <div key={`d2-${shakeKey}`} className={missing.has('d2') ? 'animate-shake' : ''}>
          <Field label={tierLabels[2]} required requiredAriaLabel={t('requiredAria')}>
            <input type="number" min={0} step="0.5" value={d2} onChange={(e) => setD2(e.target.value)} className={`${inputCls} w-20`} />
          </Field>
        </div>
      </div>
      {requiredError && <p className="text-xs text-destructive">{t('requiredError')}</p>}
      {dupError && <p className="text-xs text-destructive">{t('duplicateError')}</p>}
      <Button type="submit" size="sm">{entitlement ? t('save') : t('saveEntitlement')}</Button>
    </form>
  );
}
