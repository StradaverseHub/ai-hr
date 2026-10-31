'use client';
import {todayInKualaLumpur} from '@/lib/hr-date';
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Card, Field, SectionHeader, inputCls } from '@/components/ui';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { rewardRoles, type RewardRole } from '@/packs/rewards/model';
import type { RewardAccessAdministration, RewardAccessChange, RewardAccessCopyProposal } from '@/packs/rewards/service';
import { previewRewardAccessBatchAction, previewRewardAccessCopyAction, saveRewardAccessBatchAction } from './actions';
/** f38e5d8e — one person, one role, many exact Draft reviews; or a reviewed copy of an earlier cycle. Each is one
 *  all-or-nothing batch: preview lists every assignment, and the save enacts exactly the previewed batch. */
type Value = RewardAccessAdministration;
type Labels = { name: (userId: string) => string; scope: (unitId: string) => string };
const MAX = 500;
function BatchPreview({ changes, labels, onSaved }: { changes: RewardAccessChange[]; labels: Labels; onSaved: (reviews: number) => void }) {
    const t = useTranslations('rewardsAccess'), b = useTranslations('rewardsAccessBatch'), r = useTranslations('rewards');
    const [preview, setPreview] = useState<{ key: string; submitted: RewardAccessChange[]; changes: RewardAccessChange[]; alreadyPresent: RewardAccessChange[]; digest: string } | null>(null);
    const [error, setError] = useState(''), [busy, start] = useTransition();
    const key = JSON.stringify(changes), current = preview?.key === key ? preview : null;
    const line = (c: RewardAccessChange) => `${c.after ? labels.name(c.after.userId) : ''} · ${c.after ? r(`roles.${c.after.role}`) : ''} · ${labels.scope(c.unitId)}`;
    return <div className="mt-5 space-y-3">
  {changes.length > MAX && <p role="alert" className="text-sm text-destructive">{b('tooMany')}</p>}
  <div className="flex justify-end"><Button type="button" disabled={busy || !changes.length || changes.length > MAX} onClick={() => start(async () => {
        setError(''); setPreview(null);
        try {
            const result = await previewRewardAccessBatchAction({ changes });
            if (result.ok) setPreview({ key, submitted: changes, ...result.preview });
            else setError(result.error);
        }
        catch { setError('system'); }
    })}>{t('preview')}</Button></div>
  {error && <p role="alert" className="text-sm text-destructive">{t(`errors.${error}`)}</p>}
  {current && <section className="space-y-3 rounded-md border p-4" aria-label={t('previewTitle')}><h3 className="font-semibold">{t('previewTitle')}</h3>
   <p className="text-sm">{b('newCount', { count: current.changes.length })} · {b('presentCount', { count: current.alreadyPresent.length })}</p>
   {current.changes.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm">{current.changes.map(c => <li key={`${c.unitId}:${c.after?.userId}:${c.after?.role}`}>{line(c)}</li>)}</ul>}
   {current.alreadyPresent.length > 0 && <div><p className="text-xs font-medium text-muted-foreground">{b('presentTitle')}</p><ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">{current.alreadyPresent.map(c => <li key={`${c.unitId}:${c.after?.userId}:${c.after?.role}`}>{line(c)}</li>)}</ul></div>}
   <p className="text-xs text-muted-foreground">{b('allOrNone')} {t('history')}</p>
   <Button type="button" disabled={busy || !current.changes.length} onClick={() => start(async () => {
        setError('');
        try {
            const result = await saveRewardAccessBatchAction({ changes: current.submitted }, current.digest);
            setPreview(null);
            if (result.ok) onSaved(result.result.reviews);
            else setError(result.error);
        }
        catch { setPreview(null); setError('system'); }
    })}>{t('save')}</Button></section>}
 </div>;
}
export function BatchAddAccess({ value, accounts, labels, onSaved, onCancel }: { value: Value; accounts: ComboboxOption[]; labels: Labels; onSaved: (reviews: number) => void; onCancel: () => void }) {
    const t = useTranslations('rewardsAccess'), b = useTranslations('rewardsAccessBatch'), r = useTranslations('rewards');
    const c=useTranslations('rewardsAccessControl'),[validFrom,setValidFrom]=useState(todayInKualaLumpur()),[validTo,setValidTo]=useState(''),[coversUserId,setCoversUserId]=useState('');
    const [userId, setUserId] = useState(''), [role, setRole] = useState<RewardRole>('bu'), [ticked, setTicked] = useState<string[]>([]), [suggested, setSuggested] = useState<string[]>([]), [search, setSearch] = useState('');
    const drafts = value.reviews.filter(x => x.status === 'draft');
    const shown = value.reviews.filter(x => labels.scope(x.id).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
    const tick = (ids: string[], on = true) => setTicked(prev => on ? [...new Set([...prev, ...ids])] : prev.filter(id => !ids.includes(id)));
    const revision = (unitId: string) => value.reviews.find(x => x.id === unitId)?.revision ?? 0;
    // BU head suggestions are offered only for the BU CEO seat, and only take effect when ticked here.
    const offers = role === 'bu' ? value.suggestions.filter(s => ticked.includes(s.unitId) && s.userId !== userId) : [];
    const changes: RewardAccessChange[] = [...(userId ? ticked.map(unitId => ({ unitId, revision: revision(unitId), before: null, after: { userId, role,validFrom,validTo:validTo||null,coversUserId:coversUserId||null } })) : []), ...offers.filter(s => suggested.includes(s.unitId)).map(s => ({ unitId: s.unitId, revision: revision(s.unitId), before: null, after: { userId: s.userId, role: 'bu' as const } }))];
    const unique = (field: 'companyId' | 'cycleId') => [...new Map(drafts.map(x => [x[field], x])).values()];
    return <Card className="p-5"><SectionHeader title={t('add')}/><p className="mb-4 max-w-3xl text-sm text-muted-foreground">{b('bounded')}</p>
  <div className="grid gap-4 md:grid-cols-2">
   <div><Field label={t('person')}><Combobox value={userId} options={accounts} placeholder={t('chooseAccount')} searchPlaceholder={t('personSearch')} noResultsLabel={t('noPeople')} legacySuffix="" onValueChange={v => { if (!v.startsWith('no-login:')) setUserId(v); }}/></Field>{value.candidates.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{t('noLoginHelp')}</p>}</div>
   <Field label={t('role')}><select className={inputCls} value={role} onChange={e => setRole(e.target.value as RewardRole)}>{rewardRoles.map(x => <option key={x} value={x}>{r(`roles.${x}`)}</option>)}</select></Field>
   <Field label={c('validFrom')}><input type="date" className={inputCls} value={validFrom} onChange={e=>setValidFrom(e.target.value)}/></Field><Field label={c('validTo')}><input type="date" min={validFrom} className={inputCls} value={validTo} onChange={e=>setValidTo(e.target.value)}/></Field><Field label={c('covers')}><select className={inputCls} value={coversUserId} onChange={e=>setCoversUserId(e.target.value)}><option value="">{c('notProxy')}</option>{[...new Map(value.members.filter(m=>m.role===role&&m.userId!==userId).map(m=>[m.userId,m])).values()].map(m=><option key={m.userId} value={m.userId}>{labels.name(m.userId)}</option>)}</select></Field>
  </div>
  <fieldset className="mt-4 space-y-3 rounded-md border p-4"><legend className="px-1 text-sm font-semibold">{t('scope')}</legend>
   <div className="flex flex-wrap items-end gap-3">
    <Field label={b('searchReviews')}><input type="search" className={inputCls} value={search} onChange={e => setSearch(e.target.value)}/></Field>
    <Field label={b('allDraftInCycle')}><select className={inputCls} value="" onChange={e => tick(drafts.filter(x => x.cycleId === e.target.value).map(x => x.id))}><option value="">{b('chooseShortcut')}</option>{unique('cycleId').map(x => <option key={x.cycleId} value={x.cycleId}>{x.cycle}</option>)}</select></Field>
    <Field label={b('allDraftInCompany')}><select className={inputCls} value="" onChange={e => tick(drafts.filter(x => x.companyId === e.target.value).map(x => x.id))}><option value="">{b('chooseShortcut')}</option>{unique('companyId').map(x => <option key={x.companyId} value={x.companyId}>{x.company}</option>)}</select></Field>
    <Button type="button" variant="ghost" size="sm" disabled={!ticked.length} onClick={() => setTicked([])}>{b('clear')}</Button>
   </div>
   <p role="status" className="text-xs text-muted-foreground">{b('selected', { count: ticked.length })}</p>
   <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">{shown.map(x => <li key={x.id}><label className={`flex items-center gap-2 ${x.status !== 'draft' ? 'text-muted-foreground' : ''}`}><input type="checkbox" checked={ticked.includes(x.id)} disabled={x.status !== 'draft'} onChange={e => tick([x.id], e.target.checked)}/>{labels.scope(x.id)}{x.status !== 'draft' && <span className="text-xs">· {r(`stages.${x.status}`)} ({b('lockedReview')})</span>}</label></li>)}</ul>
  </fieldset>
  {offers.length > 0 && <fieldset className="mt-4 space-y-2 rounded-md border p-4"><legend className="px-1 text-sm font-semibold">{b('suggestionsTitle')}</legend><p className="text-xs text-muted-foreground">{b('suggestionsHelp')}</p>
   {offers.map(s => <label key={s.unitId} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={suggested.includes(s.unitId)} onChange={e => setSuggested(prev => e.target.checked ? [...prev, s.unitId] : prev.filter(id => id !== s.unitId))}/>{b('suggestFor', { name: labels.name(s.userId), scope: labels.scope(s.unitId) })}<span className="rounded-full bg-muted px-2 py-0.5 text-xs">{b('suggestedTag')}</span></label>)}
  </fieldset>}
  <div className="mt-4 flex justify-end"><Button type="button" variant="outline" onClick={onCancel}>{t('cancel')}</Button></div>
  <BatchPreview changes={changes} labels={labels} onSaved={onSaved}/>
 </Card>;
}
type Copy = { proposals: RewardAccessCopyProposal[]; alreadyPresent: RewardAccessChange[]; skipped: { unitId: string; role: RewardRole; name: string | null; email: string | null }[]; unmatched: string[] };
export function CopyAccess({ value, labels, onSaved, onCancel }: { value: Value; labels: Labels; onSaved: (reviews: number) => void; onCancel: () => void }) {
    const t = useTranslations('rewardsAccess'), b = useTranslations('rewardsAccessBatch'), r = useTranslations('rewards');
    const cycles = [...new Map(value.reviews.filter(x => x.kind === 'annual').map(x => [x.cycleId, x])).values()];
    const [from, setFrom] = useState(''), [to, setTo] = useState(''), [copy, setCopy] = useState<Copy | null>(null), [picked, setPicked] = useState<number[]>([]), [error, setError] = useState(''), [busy, start] = useTransition();
    const reset = () => { setCopy(null); setPicked([]); setError(''); };
    const changes = copy ? copy.proposals.filter((_, i) => picked.includes(i)).map(p => p.change) : [];
    return <Card className="p-5"><SectionHeader title={b('copyTitle')}/><p className="mb-4 max-w-3xl text-sm text-muted-foreground">{b('copyHelp')}</p>
  <div className="flex flex-wrap items-end gap-3">
   <Field label={b('from')}><select className={inputCls} value={from} onChange={e => { setFrom(e.target.value); reset(); }}><option value="">{b('chooseCycle')}</option>{cycles.map(x => <option key={x.cycleId} value={x.cycleId}>{x.cycle}</option>)}</select></Field>
   <Field label={b('to')}><select className={inputCls} value={to} onChange={e => { setTo(e.target.value); reset(); }}><option value="">{b('chooseCycle')}</option>{cycles.filter(x => x.cycleId !== from).map(x => <option key={x.cycleId} value={x.cycleId}>{x.cycle}</option>)}</select></Field>
   <Button type="button" disabled={busy || !from || !to || from === to} onClick={() => start(async () => {
        reset();
        try {
            const result = await previewRewardAccessCopyAction({ fromCycleId: from, toCycleId: to, companyIds: [...new Set(value.reviews.map(x => x.companyId))] });
            // Copied seats start ticked; a BU-head suggestion needs its own explicit tick.
            if (result.ok) { setCopy(result.copy); setPicked(result.copy.proposals.flatMap((p, i) => p.suggested ? [] : [i])); }
            else setError(result.error);
        }
        catch { setError('system'); }
    })}>{b('findMatches')}</Button>
   <Button type="button" variant="outline" onClick={onCancel}>{t('cancel')}</Button>
  </div>
  {error && <p role="alert" className="mt-3 text-sm text-destructive">{t(`errors.${error}`)}</p>}
  {copy && <div className="mt-4 space-y-3">
   {copy.proposals.length ? <fieldset className="space-y-1 rounded-md border p-4"><legend className="px-1 text-sm font-semibold">{b('proposalsTitle')}</legend>{copy.proposals.map((p, i) => <label key={i} className="flex flex-wrap items-center gap-2 text-sm"><input type="checkbox" checked={picked.includes(i)} onChange={e => setPicked(prev => e.target.checked ? [...prev, i] : prev.filter(x => x !== i))}/>{labels.name(p.change.after!.userId)} · {r(`roles.${p.change.after!.role}`)} · {labels.scope(p.change.unitId)}{p.suggested && <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{b('suggestedTag')}</span>}</label>)}</fieldset> : <p className="text-sm text-muted-foreground">{b('noProposals')}</p>}
   {copy.alreadyPresent.length > 0 && <p className="text-xs text-muted-foreground">{b('presentCount', { count: copy.alreadyPresent.length })}</p>}
   {copy.skipped.length > 0 && <div><p className="text-sm font-medium">{b('skippedTitle')}</p><ul className="list-disc pl-5 text-xs text-muted-foreground">{copy.skipped.map((s, i) => <li key={i}>{s.name ?? s.email ?? t('unnamed')} · {r(`roles.${s.role}`)} · {labels.scope(s.unitId)}</li>)}</ul></div>}
   {copy.unmatched.length > 0 && <p className="text-xs text-muted-foreground">{b('unmatched', { count: copy.unmatched.length })}</p>}
   <BatchPreview changes={changes} labels={labels} onSaved={onSaved}/>
  </div>}
 </Card>;
}
