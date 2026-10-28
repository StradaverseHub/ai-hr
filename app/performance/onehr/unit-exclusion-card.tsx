'use client';
/**
 * D-P1-22 X5 (ADR-0150, APR-024) — "Units not taking part": the cycle exclusion rules of one cycle, their history,
 * and (for a tenant-wide HR administrator while the cycle is open or in calibration) leaving a unit out through
 * preview → confirmation → save, and bringing one back.
 *
 * Every number shown is the service's own (the preview's counts, or counts of its rows). The save sends exactly
 * the previewed scope with the preview's digest and the cycle revision; the service refuses a stale one and the
 * refusal is shown inline. Changing the selection discards the preview, so a preview is never saved for another
 * scope. Write controls render only when the screen says the viewer may write now.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, ErrorBanner, Field, inputCls } from '@/components/ui';
import { ConfirmDialog } from '@/components/ui/confirm-submit';
import { StatCells } from '@/components/ui/stat-cells';
import { formatDmy } from '@/lib/date-display';
import type { UnitExclusionPreviewView, UnitExclusionRuleView, UnitExclusionScreen } from '@/packs/performance/service';
import { endUnitExclusionAction, previewUnitExclusionAction, saveUnitExclusionAction } from '../unit-exclusion-actions';

const thCls = 'whitespace-nowrap p-3 font-medium';
const tdCls = 'p-3 align-top';
const SEAT_TYPES = ['bu_ceo', 'bg_ceo', 'group_chief'] as const;

export function UnitExclusionCard({ screen }: { screen: UnitExclusionScreen }) {
  const t = useTranslations('onehr.unitExclusion');
  const router = useRouter();
  const { cycle, editable } = screen;
  const active = screen.rules.filter((r) => r.active);
  const ended = screen.rules.filter((r) => !r.active);
  const [companyId, setCompanyId] = useState('');
  const [mode, setMode] = useState<'company' | 'department'>('company');
  const [departmentId, setDepartmentId] = useState('');
  const [preview, setPreview] = useState<UnitExclusionPreviewView | null>(null);
  const [formError, setFormError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [rulesError, setRulesError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [bringBack, setBringBack] = useState<UnitExclusionRuleView | null>(null);

  const chosen = screen.companies.find((c) => c.id === companyId);
  const ready = !!chosen && (mode === 'company' || chosen.departments.some((d) => d.id === departmentId));
  const ruleScope = (r: UnitExclusionRuleView) => r.departmentName ?? t('wholeCompany');
  const ruleLabel = (r: UnitExclusionRuleView) => (r.departmentName ? t('scopeDepartment', { department: r.departmentName, company: r.companyName ?? '' }) : r.companyName ?? t('wholeCompany'));
  const previewLabel = (p: UnitExclusionPreviewView) => {
    const unit = screen.companies.find((c) => c.id === p.companyId);
    const dept = p.departmentId ? unit?.departments.find((d) => d.id === p.departmentId)?.name : null;
    return dept ? t('scopeDepartment', { department: dept, company: unit?.name ?? '' }) : unit?.name ?? t('wholeCompany');
  };
  const reset = () => { setPreview(null); setSaveError(undefined); setFormError(undefined); setNotice(undefined); };

  async function runPreview() {
    if (!ready || busy) return;
    setBusy(true); reset();
    try {
      const result = await previewUnitExclusionAction({ cycleId: cycle.id, companyId, departmentId: mode === 'department' ? departmentId : null });
      if ('error' in result) setFormError(result.error); else setPreview(result.data);
    } catch { setFormError(t('failed')); } finally { setBusy(false); }
  }
  async function runSave() {
    if (!preview || busy) return;
    setConfirming(false); setBusy(true); setSaveError(undefined);
    try {
      const result = await saveUnitExclusionAction({ cycleId: cycle.id, companyId: preview.companyId, departmentId: preview.departmentId, digest: preview.digest, revision: preview.revision });
      if ('error' in result) setSaveError(result.error);
      else { setPreview(null); setCompanyId(''); setMode('company'); setDepartmentId(''); setNotice(result.data.alreadyActive ? t('alreadyActive') : t('saved')); router.refresh(); }
    } catch { setSaveError(t('failed')); } finally { setBusy(false); }
  }
  async function runBringBack(rule: UnitExclusionRuleView) {
    setBringBack(null); setBusy(true); setRulesError(undefined); setNotice(undefined);
    try {
      const result = await endUnitExclusionAction({ cycleId: cycle.id, ruleId: rule.id, revision: cycle.revision });
      if ('error' in result) setRulesError(result.error); else { setNotice(t('broughtBack')); router.refresh(); }
    } catch { setRulesError(t('failed')); } finally { setBusy(false); }
  }

  const c = preview?.counts;
  const seatParts = preview ? [
    ...SEAT_TYPES.flatMap((k) => { const n = preview.seatsByType.find((s) => s.seatType === k)?.count ?? 0; return n ? [`${t(`seatTypes.${k}`)} ${n}`] : []; }),
    ...(c!.hodOut ? [`${t('seatTypes.hod')} ${c!.hodOut}`] : []),
    ...(preview.hodSessionsOut ? [`${t('seatTypes.hodSession')} ${preview.hodSessionsOut}`] : []),
    ...(preview.seatsByType.filter((s) => !(SEAT_TYPES as readonly string[]).includes(s.seatType)).map((s) => `${s.seatType} ${s.count}`)),
  ] : [];

  return (
    <div className="min-w-0 space-y-6">
      <div className="space-y-1">
        <h2 className="font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('help')}</p>
      </div>
      {notice && <p role="status" className="text-sm">{notice}</p>}

      <section aria-label={t('rulesTitle')} className="space-y-3">
        <ErrorBanner message={rulesError} />
        {active.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead><tr><th className={thCls}>{t('company')}</th><th className={thCls}>{t('scope')}</th><th className={thCls}>{t('setBy')}</th><th className={thCls}>{t('on')}</th>{editable && <th className={thCls}><span className="sr-only">{t('actions')}</span></th>}</tr></thead>
              <tbody className="divide-y divide-border">
                {active.map((r) => (
                  <tr key={r.id}>
                    <td className={tdCls}>{r.companyName ?? '—'}</td>
                    <td className={tdCls}>{ruleScope(r)}</td>
                    <td className={tdCls}>{r.createdByName ?? '—'}</td>
                    <td className={`${tdCls} whitespace-nowrap`}>{formatDmy(r.createdAt)}</td>
                    {editable && <td className={tdCls}><Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => setBringBack(r)}>{t('bringBack')}</Button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-muted-foreground">{t('none')}</p>}
        {ended.length > 0 && (
          <details>
            <summary className="cursor-pointer text-sm font-medium">{t('history', { count: ended.length })}</summary>
            <p className="mt-2 text-sm text-muted-foreground">{t('historyHelp')}</p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr><th className={thCls}>{t('company')}</th><th className={thCls}>{t('scope')}</th><th className={thCls}>{t('set')}</th><th className={thCls}>{t('ended')}</th><th className={thCls}>{t('why')}</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {ended.map((r) => (
                    <tr key={r.id}>
                      <td className={tdCls}>{r.companyName ?? '—'}</td>
                      <td className={tdCls}>{ruleScope(r)}</td>
                      <td className={`${tdCls} whitespace-nowrap`}>{formatDmy(r.createdAt)}</td>
                      <td className={`${tdCls} whitespace-nowrap`}>{formatDmy(r.endedAt)}</td>
                      <td className={tdCls}>{r.endReason ? t(`endReasons.${r.endReason}`) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </section>

      {editable && (
        <section aria-label={t('leaveOutTitle')} className="space-y-4 border-t border-border pt-5">
          <h3 className="text-sm font-semibold">{t('leaveOutTitle')}</h3>
          <Field label={t('company')}>
            <select value={companyId} disabled={busy} onChange={(e) => { setCompanyId(e.target.value); setDepartmentId(''); reset(); }} className={inputCls}>
              <option value="">{t('chooseCompany')}</option>
              {screen.companies.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
          <fieldset className="space-y-3" disabled={busy || !chosen}>
            <legend className="mb-2 text-sm font-medium">{t('scope')}</legend>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <label className="flex items-center gap-2 text-sm"><input type="radio" name="unit-exclusion-scope" checked={mode === 'company'} onChange={() => { setMode('company'); setDepartmentId(''); reset(); }} />{t('wholeCompany')}</label>
              <label className="flex items-center gap-2 text-sm"><input type="radio" name="unit-exclusion-scope" checked={mode === 'department'} disabled={!chosen?.departments.length} onChange={() => { setMode('department'); reset(); }} />{t('departments')}</label>
            </div>
            {mode === 'department' && chosen && (
              <div role="radiogroup" aria-label={t('departments')} className="flex flex-wrap gap-2">
                {chosen.departments.map((d) => (
                  <label key={d.id} className="inline-flex cursor-pointer items-center rounded-full border border-border px-3 py-1 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
                    <input type="radio" name="unit-exclusion-department" value={d.id} checked={departmentId === d.id} onChange={() => { setDepartmentId(d.id); reset(); }} className="sr-only" />
                    {t('departmentPeople', { name: d.name, count: d.people })}
                  </label>
                ))}
              </div>
            )}
            {chosen && !chosen.departments.length && <p className="text-sm text-muted-foreground">{t('noDepartments')}</p>}
          </fieldset>
          <ErrorBanner message={formError} />
          <Button type="button" variant="outline" disabled={!ready || busy} onClick={runPreview}>{t('preview')}</Button>
        </section>
      )}

      {editable && preview && c && (
        <section aria-label={t('previewTitle')} className="space-y-4 border-t border-border pt-5">
          <h3 className="text-sm font-semibold">{t('previewTitle')}: {previewLabel(preview)}</h3>
          <p className="text-sm text-muted-foreground">{t('previewHelp')}</p>
          {preview.alreadyActive && <p className="text-sm">{t('alreadyActive')}</p>}
          <StatCells cells={[
            { label: t('tiles.people'), value: c.people },
            { label: t('tiles.places'), value: <>{c.places}<span className="mt-1 block text-xs font-normal text-muted-foreground">{t('tiles.placesDetail', { submitted: preview.submittedPlaces, below: c.belowFullPanel })}</span></> },
            { label: t('tiles.own'), value: c.own },
            { label: t('tiles.oneLevelUp'), value: c.oneLevelUp },
          ]} />
          {preview.oneLevelUp.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr><th className={thCls}>{t('person')}</th><th className={thCls}>{t('reviewerNow')}</th><th className={thCls}>{t('becomes')}</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {preview.oneLevelUp.map((r) => <tr key={r.reviewId}><td className={tdCls}>{r.person ?? '—'}</td><td className={tdCls}>{r.from ?? '—'}</td><td className={tdCls}>{r.to ?? '—'}</td></tr>)}
                </tbody>
              </table>
            </div>
          )}
          <ul className="space-y-2 text-sm">
            {c.moves > 0 && <li>{t('kpiMoves', { count: c.moves })}</li>}
            {preview.subsumed > 0 && <li>{t('subsumed', { count: preview.subsumed })}</li>}
            {seatParts.length > 0 && <li>{t('seats', { seats: seatParts.join(' · ') })} <Link href="/performance/leaders" className="text-primary hover:underline">{t('leadersLink')}</Link></li>}
            {c.sessionReviewersOut > 0 && <li>{t('sessionReviewers', { count: c.sessionReviewersOut })}</li>}
            {preview.nobodyAbove.length > 0 && (
              <li>
                {t('nobodyAbove')}
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {preview.nobodyAbove.map((r) => <li key={`${r.reviewId}:${r.reason}`}>{r.person ?? '—'} · {t(`nobodyReasons.${r.reason}`)}</li>)}
                </ul>
              </li>
            )}
            {(c.frozenPeople > 0 || c.frozenSkipped > 0) && <li className="text-muted-foreground">{t('frozen', { people: c.frozenPeople, rows: c.frozenSkipped })}</li>}
            <li className="text-muted-foreground">{t('nothingDeleted')}</li>
          </ul>
          <ErrorBanner message={saveError} />
          <div className="flex flex-wrap gap-3">
            <Button type="button" variant="outline" disabled={busy} onClick={reset}>{t('cancel')}</Button>
            <Button type="button" disabled={busy} onClick={() => setConfirming(true)}>{t('continue')}</Button>
          </div>
        </section>
      )}

      {confirming && preview && c && (
        <ConfirmDialog
          title={t('confirmTitle', { scope: previewLabel(preview), cycle: cycle.name })}
          description={t('confirmBody', { people: c.people, places: c.places, own: c.own, moves: c.moves, oneLevelUp: c.oneLevelUp })}
          cancelLabel={t('back')}
          confirmLabel={t('leaveOut')}
          variant="destructive"
          onConfirm={runSave}
          onCancel={() => setConfirming(false)}
        />
      )}
      {bringBack && (
        <ConfirmDialog
          title={t('bringBackTitle', { scope: ruleLabel(bringBack), cycle: cycle.name })}
          description={t('bringBackBody')}
          cancelLabel={t('back')}
          confirmLabel={t('bringBack')}
          variant="default"
          onConfirm={() => runBringBack(bringBack)}
          onCancel={() => setBringBack(null)}
        />
      )}
    </div>
  );
}
