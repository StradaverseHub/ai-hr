'use client';

import { useMemo, useState, useTransition } from 'react';
import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import * as Dialog from '@radix-ui/react-dialog';
import { GripVertical } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ServiceBand } from '@/core/leave-compute';
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
};
type Entitlement = {
  id: string;
  benefitSchemeId: string;
  leaveTypeId: string;
  leaveTypeName: string | null;
  serviceBands: ServiceBand[];
};
type CombinedLimit = {
  id: string;
  benefitSchemeId: string;
  name: string;
  totalLimitDays: number;
  leaveTypeIds: string[];
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
  updateCombinedLimit: (fd: FormData) => void | Promise<void>;
  deleteCombinedLimit: (fd: FormData) => void | Promise<void>;
  // R47 d6f88c2f — DnD grouping writes: move one leave type between pools (blank target = ungroup) and
  // create a pool from dragged rows (server detaches them from any previous pool).
  moveCombinedLimitMember: (fd: FormData) => void | Promise<void>;
  groupLeaveTypes: (fd: FormData) => void | Promise<void>;
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
  combinedLimits,
  actions,
}: {
  companies: Company[];
  grades: Grade[];
  leaveTypes: LeaveType[];
  gradeGroups: GradeGroup[];
  schemes: Scheme[];
  entitlements: Entitlement[];
  combinedLimits: CombinedLimit[];
  actions: Actions;
}) {
  const t = useTranslations('admin.benefitScheme');
  const companyName = useMemo(() => new Map(companies.map((c) => [c.id, c.name])), [companies]);
  const groupName = useMemo(() => new Map(gradeGroups.map((g) => [g.id, g.name])), [gradeGroups]);
  const activeGroups = gradeGroups.filter((g) => !g.archived);
  const empTypeLabel = (v: string) => t(`empType_${v}` as `empType_${(typeof EMPLOYMENT_TYPES)[number]}`);

  // R44 02a7082b: group the flat scheme list by company into collapsible per-company sections (companies
  // ordered A–Z; schemes already asc(name) from the loader). Presentation only — no data change.
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
  const selectedEnts = entitlements.filter((e) => e.benefitSchemeId === selectedSchemeId);

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
  // only — re-sorts automatically on add/update/delete via re-render. Default ascending.
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
      {/* ── Grade Groups ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t('groupsTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('groupsHelp')}</p>
        </div>
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
                <div className="mt-3 space-y-3">
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
                    </div>
                  </form>
                  <form action={actions.deleteGradeGroup}>
                    <input type="hidden" name="id" value={g.id} />
                    <Button type="submit" variant="ghost" size="sm">{t('delete')}</Button>
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
      </section>

      {/* ── Benefit Schemes ──────────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t('schemesTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('schemesHelp')}</p>
        </div>
        {schemes.length === 0 ? (
          <p className="rounded-lg border border-border px-3 py-4 text-center text-sm text-muted-foreground">
            {t('noSchemes')}
          </p>
        ) : (
          <div className="space-y-3">
            {schemesByCompany.map((group) => (
              <details key={group.companyId} open className="overflow-hidden rounded-lg border border-border">
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
      </section>

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
                  {schemes.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </Field>
              <div className="flex items-end gap-3">
                <Field label={t('entSortLabel')}>
                  <select
                    value={entSort}
                    onChange={(e) => setEntSort(e.target.value as 'asc' | 'desc')}
                    className={`${inputCls} w-48`}
                  >
                    <option value="asc">{t('entSortAsc')}</option>
                    <option value="desc">{t('entSortDesc')}</option>
                  </select>
                </Field>
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
            {/* R47 d6f88c2f — the standalone Combined Leave Limits section is gone: shared caps are now
                configured by dragging entitlement rows together, directly in this table. */}
            <EntitlementDndTable
              schemeId={selectedSchemeId}
              ents={sortedEnts}
              pools={combinedLimits.filter((cl) => cl.benefitSchemeId === selectedSchemeId)}
              headerTiers={headerTiers}
              actions={actions}
              t={t}
            />
            <EntitlementForm
              action={actions.upsertEntitlement}
              schemeId={selectedSchemeId}
              leaveTypes={leaveTypes}
              existingLeaveTypeIds={selectedEnts.map((e) => e.leaveTypeId)}
              t={t}
            />
          </>
        )}
      </section>
    </div>
  );
}

/**
 * EntitlementDndTable (R47 d6f88c2f) — the per-scheme entitlement table with drag-and-drop leave-type
 * grouping, replacing the R44 4c48fd1f standalone Combined Leave Limits section. Every row is draggable:
 * drop it on an ungrouped row to form a new pool (auto-named from the members, editable in the confirm
 * dialog — the total limit HAS to be asked for there since a silent default would cap real leave), or on a
 * group / grouped row to MOVE it into that pool (a type is in at most one pool per scheme). Grouped rows
 * render banded + contiguous with an inline-renameable name and a shared editable Total Limit column
 * (scheme_leave_combined_limit.total_limit_days). Ungroup per row (moveCombinedLimitMember with a blank
 * target) and per group (deleteCombinedLimit). Enforcement (core/leave.ts) reads the same tables and is
 * untouched.
 */
function EntitlementDndTable({
  schemeId,
  ents,
  pools,
  headerTiers,
  actions,
  t,
}: {
  schemeId: string;
  /** The selected scheme's entitlements, ALREADY sorted by the A–Z/Z–A toggle. */
  ents: Entitlement[];
  pools: CombinedLimit[];
  headerTiers: { n1: number; n2: number };
  actions: Actions;
  t: ReturnType<typeof useTranslations>;
}) {
  const [, startTransition] = useTransition();
  // A small activation distance keeps plain clicks (Edit/Delete/inputs) from starting a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const poolByTypeId = useMemo(() => {
    const m = new Map<string, CombinedLimit>();
    for (const p of pools) for (const id of p.leaveTypeIds) m.set(id, p);
    return m;
  }, [pools]);
  const entById = useMemo(() => new Map(ents.map((e) => [e.id, e])), [ents]);
  const hasPools = pools.length > 0;
  const colCount = hasPools ? 6 : 5;

  // Sorting vs grouping (approved decision): grouped rows must stay CONTIGUOUS while the A–Z/Z–A toggle
  // stays useful. Walking the direction-sorted rows in order, a group block is ANCHORED at its first
  // member's sorted position (later members join that block) and ungrouped rows keep their own slot —
  // so members sort within their group and blocks interleave with singles by the same sort key.
  type Block = { pool: CombinedLimit | null; ents: Entitlement[] };
  const blocks = useMemo<Block[]>(() => {
    const out: Block[] = [];
    const byPool = new Map<string, Block>();
    for (const e of ents) {
      const pool = poolByTypeId.get(e.leaveTypeId) ?? null;
      if (!pool) {
        out.push({ pool: null, ents: [e] });
        continue;
      }
      const existing = byPool.get(pool.id);
      if (existing) {
        existing.ents.push(e);
      } else {
        const blk: Block = { pool, ents: [e] };
        byPool.set(pool.id, blk);
        out.push(blk);
      }
    }
    return out;
  }, [ents, poolByTypeId]);

  const [active, setActive] = useState<Entitlement | null>(null);
  const [pendingGroup, setPendingGroup] = useState<[Entitlement, Entitlement] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const activePoolId = active ? (poolByTypeId.get(active.leaveTypeId)?.id ?? null) : null;

  const onDragStart = (e: DragStartEvent) => {
    setNotice(null);
    setActive(entById.get(String(e.active.id)) ?? null);
  };
  const onDragEnd = (e: DragEndEvent) => {
    const src = active;
    setActive(null);
    if (!src || !e.over) return;
    const overId = String(e.over.id);
    const srcPool = poolByTypeId.get(src.leaveTypeId) ?? null;
    let targetPool: CombinedLimit | null = null;
    let targetEnt: Entitlement | null = null;
    if (overId.startsWith('pool:')) {
      targetPool = pools.find((p) => p.id === overId.slice(5)) ?? null;
    } else if (overId.startsWith('row:')) {
      targetEnt = entById.get(overId.slice(4)) ?? null;
      if (!targetEnt || targetEnt.id === src.id) return;
      targetPool = poolByTypeId.get(targetEnt.leaveTypeId) ?? null;
    }
    if (targetPool) {
      // Dropping onto a group (band or member row) MOVES the type there — unless it is already a member.
      if (srcPool?.id === targetPool.id) {
        setNotice(t('groupConflict'));
        return;
      }
      const fd = new FormData();
      fd.set('benefitSchemeId', schemeId);
      fd.set('leaveTypeId', src.leaveTypeId);
      fd.set('toCombinedLimitId', targetPool.id);
      startTransition(() => {
        void actions.moveCombinedLimitMember(fd);
      });
      return;
    }
    // Dropping onto an ungrouped row proposes a NEW group — confirmed in a dialog because the shared
    // total limit needs a value (no safe default) and the auto-name should be reviewable.
    if (targetEnt) setPendingGroup([src, targetEnt]);
  };

  return (
    <>
      <p className="text-xs text-muted-foreground">{t('dragHint')}</p>
      {notice && <p className="text-xs text-destructive">{notice}</p>}
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActive(null)}
      >
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">{t('colLeaveType')}</th>
                <th className="px-3 py-2 font-medium">{t('tierUnder', { n1: headerTiers.n1, n2: headerTiers.n2 })}</th>
                <th className="px-3 py-2 font-medium">{t('tierMid', { n1: headerTiers.n1, n2: headerTiers.n2 })}</th>
                <th className="px-3 py-2 font-medium">{t('tierOver', { n1: headerTiers.n1, n2: headerTiers.n2 })}</th>
                {hasPools && <th className="px-3 py-2 font-medium">{t('colTotalLimit')}</th>}
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {ents.length === 0 && (
                <tr>
                  <td colSpan={colCount} className="px-3 py-4 text-center text-muted-foreground">{t('noEntitlements')}</td>
                </tr>
              )}
              {blocks.map((blk) =>
                blk.pool ? (
                  <GroupBlock
                    key={`g-${blk.pool.id}`}
                    pool={blk.pool}
                    ents={blk.ents}
                    schemeId={schemeId}
                    colCount={colCount}
                    hasPools={hasPools}
                    activeEnt={active}
                    activePoolId={activePoolId}
                    actions={actions}
                    t={t}
                  />
                ) : (
                  <EntitlementRow
                    key={blk.ents[0].id}
                    ent={blk.ents[0]}
                    pool={null}
                    isFirstOfGroup={false}
                    groupSize={0}
                    schemeId={schemeId}
                    hasPools={hasPools}
                    activeEnt={active}
                    activePoolId={activePoolId}
                    actions={actions}
                    t={t}
                  />
                ),
              )}
            </tbody>
          </table>
        </div>
      </DndContext>
      {pendingGroup && (
        <CreateGroupDialog
          schemeId={schemeId}
          members={pendingGroup}
          action={actions.groupLeaveTypes}
          onClose={() => setPendingGroup(null)}
          t={t}
        />
      )}
    </>
  );
}

/** A pool's banded block: a full-width header row (droppable target, inline rename, dissolve) followed by
 *  its member rows, the first of which carries the shared Total Limit cell (rowSpan). */
function GroupBlock({
  pool,
  ents,
  schemeId,
  colCount,
  hasPools,
  activeEnt,
  activePoolId,
  actions,
  t,
}: {
  pool: CombinedLimit;
  ents: Entitlement[];
  schemeId: string;
  colCount: number;
  hasPools: boolean;
  activeEnt: Entitlement | null;
  activePoolId: string | null;
  actions: Actions;
  t: ReturnType<typeof useTranslations>;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: `pool:${pool.id}` });
  const validTarget = !!activeEnt && activePoolId !== pool.id;
  return (
    <>
      <tr
        ref={setNodeRef}
        className={`border-b border-border bg-muted/40 ${
          validTarget ? (isOver ? 'bg-primary/15' : 'bg-primary/5') : ''
        }`}
      >
        <td colSpan={colCount} className="px-3 py-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <form action={actions.updateCombinedLimit} className="flex items-center gap-1.5">
              <input type="hidden" name="id" value={pool.id} />
              <input type="hidden" name="totalLimitDays" value={String(pool.totalLimitDays)} />
              {pool.leaveTypeIds.map((id) => (
                <input key={id} type="hidden" name="leaveTypeIds" value={id} />
              ))}
              <input
                name="name"
                required
                defaultValue={pool.name}
                aria-label={t('renameGroup')}
                className={`${inputCls} h-7 w-56 text-xs font-medium`}
              />
              <Button type="submit" variant="ghost" size="sm">{t('save')}</Button>
            </form>
            <form action={actions.deleteCombinedLimit}>
              <input type="hidden" name="id" value={pool.id} />
              <ConfirmSubmit
                size="sm"
                variant="ghost"
                title={t('dissolveGroupConfirmTitle')}
                description={t('dissolveGroupConfirmDescription')}
                confirmLabel={t('dissolveGroup')}
              >
                {t('dissolveGroup')}
              </ConfirmSubmit>
            </form>
          </div>
        </td>
      </tr>
      {ents.map((e, i) => (
        <EntitlementRow
          key={e.id}
          ent={e}
          pool={pool}
          isFirstOfGroup={i === 0}
          groupSize={ents.length}
          schemeId={schemeId}
          hasPools={hasPools}
          activeEnt={activeEnt}
          activePoolId={activePoolId}
          actions={actions}
          t={t}
        />
      ))}
    </>
  );
}

/** One entitlement row — draggable (grip handle) AND a drop target. Grouped rows band with the pool
 *  colour, carry an Ungroup action, and the first row of a group hosts the shared Total Limit cell. */
function EntitlementRow({
  ent,
  pool,
  isFirstOfGroup,
  groupSize,
  schemeId,
  hasPools,
  activeEnt,
  activePoolId,
  actions,
  t,
}: {
  ent: Entitlement;
  pool: CombinedLimit | null;
  isFirstOfGroup: boolean;
  groupSize: number;
  schemeId: string;
  hasPools: boolean;
  activeEnt: Entitlement | null;
  activePoolId: string | null;
  actions: Actions;
  t: ReturnType<typeof useTranslations>;
}) {
  const { attributes, listeners, setNodeRef: setDragRef, setActivatorNodeRef, transform, isDragging } = useDraggable({
    id: ent.id,
  });
  const { isOver, setNodeRef: setDropRef } = useDroppable({ id: `row:${ent.id}` });
  const ti = tiersFromBands(ent.serviceBands);
  // Valid target = not the dragged row itself, and not a sibling of the dragged row's own pool.
  const validTarget =
    !!activeEnt && activeEnt.id !== ent.id && (pool ? pool.id !== activePoolId : true);
  const banded = pool ? 'bg-muted/30' : '';
  const highlight = validTarget ? (isOver ? 'bg-primary/15' : 'bg-primary/5') : '';
  return (
    <tr
      ref={(node) => {
        setDragRef(node);
        setDropRef(node);
      }}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={`border-b border-border last:border-0 ${banded} ${highlight} ${
        isDragging ? 'relative z-10 opacity-60' : ''
      }`}
    >
      <td className="px-3 py-2 font-medium">
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            ref={setActivatorNodeRef}
            aria-label={t('dragHandleAria')}
            className="grid size-6 shrink-0 cursor-grab touch-none place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing focus:outline-none focus:ring-2 focus:ring-primary/40"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-3.5" />
          </button>
          {ent.leaveTypeName ?? '—'}
        </span>
      </td>
      <td className="px-3 py-2">{ti.d0 || '0'}</td>
      <td className="px-3 py-2">{ti.d1 || '0'}</td>
      <td className="px-3 py-2">{ti.d2 || '0'}</td>
      {hasPools &&
        (pool ? (
          isFirstOfGroup ? (
            <td rowSpan={groupSize} className="border-l border-border bg-muted/30 px-3 py-2 align-middle">
              {/* The shared cap: scheme_leave_combined_limit.total_limit_days, editable in place. */}
              <form action={actions.updateCombinedLimit} className="flex flex-col items-start gap-1.5">
                <input type="hidden" name="id" value={pool.id} />
                <input type="hidden" name="name" value={pool.name} />
                {pool.leaveTypeIds.map((id) => (
                  <input key={id} type="hidden" name="leaveTypeIds" value={id} />
                ))}
                <input
                  name="totalLimitDays"
                  type="number"
                  min={0.5}
                  step="0.5"
                  required
                  defaultValue={String(pool.totalLimitDays)}
                  aria-label={t('colTotalLimit')}
                  className={`${inputCls} h-7 w-20 text-xs`}
                />
                <Button type="submit" variant="ghost" size="sm">{t('save')}</Button>
              </form>
            </td>
          ) : null
        ) : (
          <td className="px-3 py-2 text-muted-foreground">—</td>
        ))}
      <td className="px-3 py-2 text-right">
        {/* R47 edb0309d: Edit reopens the row in a pre-filled dialog (the R44 dup guard closed the old
            re-add-to-overwrite path); Delete confirms like its R44 sibling delete surfaces. */}
        <div className="inline-flex items-center gap-1">
          <EntitlementEditDialog entitlement={ent} action={actions.upsertEntitlement} t={t} />
          {pool && (
            <form action={actions.moveCombinedLimitMember} className="inline">
              <input type="hidden" name="benefitSchemeId" value={schemeId} />
              <input type="hidden" name="leaveTypeId" value={ent.leaveTypeId} />
              <input type="hidden" name="toCombinedLimitId" value="" />
              <Button type="submit" variant="ghost" size="sm">{t('ungroupRow')}</Button>
            </form>
          )}
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

/** Confirm dialog for a drag-created group: members fixed (the two dragged rows), name auto-generated
 *  from the member leave-type names (approved decision — editable before save), total limit REQUIRED
 *  (a silent default would cap real leave). Posts groupSchemeLeaveTypesAction, which detaches the
 *  members from any previous pool server-side. */
function CreateGroupDialog({
  schemeId,
  members,
  action,
  onClose,
  t,
}: {
  schemeId: string;
  members: [Entitlement, Entitlement];
  action: (fd: FormData) => void | Promise<void>;
  onClose: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const autoName = members
    .map((m) => m.leaveTypeName ?? '—')
    .join(' + ')
    .slice(0, 120);
  return (
    <Dialog.Root
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg">
          <Dialog.Title className="text-base font-semibold">{t('createGroupTitle')}</Dialog.Title>
          <p className="mt-1 text-xs text-muted-foreground">{t('createGroupHelp')}</p>
          <form
            action={(fd) => {
              onClose();
              return action(fd);
            }}
            className="mt-4 space-y-3"
          >
            <input type="hidden" name="benefitSchemeId" value={schemeId} />
            {members.map((m) => (
              <input key={m.id} type="hidden" name="leaveTypeIds" value={m.leaveTypeId} />
            ))}
            <div className="flex flex-wrap gap-2">
              {members.map((m) => (
                <Badge key={m.id}>{m.leaveTypeName ?? '—'}</Badge>
              ))}
            </div>
            <Field label={t('groupNameLabel')}>
              <input name="name" required defaultValue={autoName} className={inputCls} />
            </Field>
            <Field label={t('totalLimitPerYear')}>
              <input name="totalLimitDays" type="number" min={0.5} step="0.5" required className={`${inputCls} w-28`} />
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <Dialog.Close asChild>
                <Button type="button" size="sm" variant="outline">{t('cancel')}</Button>
              </Dialog.Close>
              <Button type="submit" size="sm">{t('createGroupConfirm')}</Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * SchemeForm grid per host (item 0ad01560). Static class lookup — Tailwind cannot JIT a runtime-interpolated
 * class string (same discipline as the dashboard-customizer GRID_COLS fix).
 *  - 'inline': the full-width add-scheme row under the list — six columns across at lg fit comfortably there.
 *  - 'dialog': the Edit popup (max-w-3xl) — six columns squeezed every dropdown to ~100px and truncated long
 *    company / grade-group / scheme names, so the dialog gets two comfortable columns instead.
 */
const SCHEME_FORM_GRID: Record<'inline' | 'dialog', string> = {
  inline: 'grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-6 lg:items-end',
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
        <select name="employmentType" defaultValue={scheme?.employmentType ?? 'full_time'} className={inputCls}>
          {EMPLOYMENT_TYPES.map((v) => (
            <option key={v} value={v}>{empTypeLabel(v)}</option>
          ))}
        </select>
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
        <input name="name" defaultValue={scheme?.name ?? ''} required placeholder={t('schemeNamePlaceholder')} className={inputCls} />
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

function EntitlementForm({
  action,
  schemeId,
  leaveTypes,
  existingLeaveTypeIds,
  entitlement = null,
  t,
}: {
  action: (fd: FormData) => void | Promise<void>;
  schemeId: string;
  leaveTypes: LeaveType[];
  existingLeaveTypeIds: string[];
  /** R47 edb0309d: when set, the form EDITS this row — leave type locked, day values pre-filled from its
   *  stored serviceBands (including legacy non-2/5 cutoffs, which are preserved on save). */
  entitlement?: Entitlement | null;
  t: ReturnType<typeof useTranslations>;
}) {
  // Fixed three-band day entry (R44 6421c888): service bands are hardcoded at 0–2 / 2–5 / 5+ years — HR
  // types the days directly into each predefined range, no tier-cutoff inputs. The 0/2/5 shape satisfies
  // validateBands and is the SAME contiguous ServiceBand[] the resolver reads. Legacy rows stored with other
  // cutoffs keep their own values + calculate correctly (read-side table derives each row's own labels).
  // In EDIT mode the row's OWN cutoffs (tiersFromBands) seed both the values and the band shape written back.
  const editTiers = entitlement ? tiersFromBands(entitlement.serviceBands) : null;
  const [leaveTypeId, setLeaveTypeId] = useState(entitlement?.leaveTypeId ?? '');
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
