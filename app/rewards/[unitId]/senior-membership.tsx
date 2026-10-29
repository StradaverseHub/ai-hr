'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, inputCls } from '@/components/ui';
import { previewSeniorMembershipAction, saveSeniorMembershipAction } from '../actions';
import type { getRewardSeniorMembership, previewRewardSeniorMembership } from '@/packs/rewards/service';

type Value = Awaited<ReturnType<typeof getRewardSeniorMembership>>;
type Preview = Awaited<ReturnType<typeof previewRewardSeniorMembership>>;
export function SeniorMembership({ value }: { value: Value }) {
  const t = useTranslations('rewards'), router = useRouter();
  const [selected, setSelected] = useState(() => new Set(value.rows.filter(row => row.member).map(row => row.employmentId)));
  const [query, setQuery] = useState(''), [adopt, setAdopt] = useState(false), [error, setError] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null), [saved, setSaved] = useState(false), [busy, start] = useTransition();
  const legacy = value.mode !== 'named-members';
  const selection = { employmentIds: [...selected].sort(), adoptLegacy: adopt };
  const rows = value.rows.filter(row => `${row.name} ${row.employeeCode}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const changed = preview?.rows.filter(row => row.member !== row.nextMember) ?? [];
  const clearPreview = () => { setPreview(null); setError(''); setSaved(false); };
  return <section id="senior-membership" className="space-y-4 rounded-lg border border-border p-5" aria-label={t('seniorMembershipTitle')}>
    <h2 className="font-semibold">{t('seniorMembershipTitle')}</h2>
    <p className="max-w-3xl text-sm text-muted-foreground">{t('seniorMembershipHelp')}</p>
    {legacy && <div className="space-y-3 rounded-md border border-amber-500/30 p-3 text-sm">
      <p>{t('seniorLegacyHelp')}</p>
      <label className="flex gap-2"><input type="checkbox" checked={adopt} disabled={busy || !value.canEdit} onChange={event => { setAdopt(event.target.checked); clearPreview(); }} />{t('adoptNamedMembership')}</label>
    </div>}
    <label className="block text-sm">{t('searchSeniorMembership')}<input type="search" value={query} onChange={event => setQuery(event.target.value)} className={`${inputCls} mt-1 max-w-lg`} /></label>
    <p className="text-sm text-muted-foreground" role="status">{t('selectedSeniorMembership', {count:selected.size})}</p>
    <fieldset disabled={busy || !value.canEdit || legacy && !adopt}>
      <div className="max-h-80 overflow-auto rounded-md border border-border">
        {rows.length === 0 && <p className="p-4 text-sm text-muted-foreground">{t('noSeniorMembershipMatches')}</p>}
        {rows.map(row => <label key={row.employmentId} className="flex cursor-pointer items-center gap-3 border-b border-border p-3 text-sm last:border-0">
          <input type="checkbox" disabled={!row.eligible&&!selected.has(row.employmentId)} checked={selected.has(row.employmentId)} onChange={event => {
            const checked = event.target.checked;
            setSelected(old => { const next = new Set(old); if (checked) next.add(row.employmentId); else next.delete(row.employmentId); return next; }); clearPreview();
          }} />
          <span className="min-w-0 flex-1"><span className="font-medium">{row.name}</span><span className="ml-2 text-muted-foreground">{row.employeeCode} · JG {row.grade}</span></span>
          <span className="text-muted-foreground">{t(selected.has(row.employmentId) ? 'seniorPlanMember' : 'standardPlanMember')}</span>
        </label>)}
      </div>
      <Button type="button" className="mt-3" variant="outline" onClick={() => start(async () => {
        setError(''); setSaved(false);
        const result = await previewSeniorMembershipAction(value.unitId, value.revision, selection);
        if (result.ok) setPreview(result.preview); else { setPreview(null); setError(result.error); }
      })}>{t('previewSeniorMembership')}</Button>
    </fieldset>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {preview && <div className="space-y-3 rounded-md border border-border p-4">
      <h3 className="font-medium">{t('previewSeniorMembership')}</h3>
      {changed.length === 0 ? <p className="text-sm text-muted-foreground">{t('noSeniorMembershipChanges')}</p> : <ul className="divide-y divide-border">{changed.map(row => <li key={row.employmentId} className="py-2 text-sm">
        <span className="font-medium">{row.name} · {row.employeeCode} · JG {row.grade}</span><span className="ml-2">{t(row.member ? 'seniorPlanMember' : 'standardPlanMember')} → {t(row.nextMember ? 'seniorPlanMember' : 'standardPlanMember')}</span>
      </li>)}</ul>}
      {preview.convertingLegacy && <p className="text-sm text-muted-foreground">{t('seniorLegacyHelp')}</p>}
      <Button type="button" disabled={busy || !value.canEdit} onClick={() => start(async () => {
        setError(''); const result = await saveSeniorMembershipAction(value.unitId, value.revision, selection, preview.digest);
        if (result.ok) { setPreview(null); setSaved(true); router.refresh(); } else { setPreview(null); setError(result.error); }
      })}>{t('confirmSeniorMembership')}</Button>
    </div>}
    {saved && <p role="status" className="text-sm">{t('seniorMembershipSaved')}</p>}
  </section>;
}
