'use client';
import Link from 'next/link';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {RewardAccessRequests} from './requests';
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { RewardConfidentialityRules } from './confidentiality-rules';
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button, Card, Field, SectionHeader, inputCls, tableWrapCls, theadCls, thCls, tbodyCls } from '@/components/ui';
import { rewardRoles, type RewardRole } from '@/packs/rewards/model';
import type { RewardAccessRequest,RewardAccessAdministration, RewardAccessChange } from '@/packs/rewards/service';
import { previewRewardAccessAction, saveRewardAccessAction } from '@/app/(app)/rewards/actions';
import { RewardCoveragePanel } from './coverage-panel';
import { BatchAddAccess, CopyAccess } from './batch-access';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
type Member = RewardAccessAdministration['members'][number];
type Preview = RewardAccessChange & {
    digest: string;
};
export function RewardAccessEditor({ value,requests=[],singleAdminCompanies=[] }: {
    value: RewardAccessAdministration;requests?:RewardAccessRequest[];singleAdminCompanies?:string[];
}) {
    const c=useTranslations('rewardsAccessControl');
    const t = useTranslations('rewardsAccess'), b = useTranslations('rewardsAccessBatch'), r = useTranslations('rewards'), router = useRouter();
    const [query, setQuery] = useState(''), [company, setCompany] = useState(''), [cycle, setCycle] = useState(''), [unitFilter, setUnitFilter] = useState(''), [gaps, setGaps] = useState(false);
    const [editor, setEditor] = useState<{
        before: Member | null;
        remove: boolean;
    } | null>(null);
    const [validFrom,setValidFrom]=useState(todayInKualaLumpur()),[validTo,setValidTo]=useState(''),[coversUserId,setCoversUserId]=useState(''),[restoreReason,setRestoreReason]=useState(''),[restoring,setRestoring]=useState(false);
    const [unitId, setUnitId] = useState(''), [userId, setUserId] = useState(''), [role, setRole] = useState<RewardRole>('bu');
    const [preview, setPreview] = useState<Preview | null>(null), [error, setError] = useState(''), [saved, setSaved] = useState(false), [busy, start] = useTransition();
    const editorRef = useRef<HTMLDivElement>(null), userRef = useRef<HTMLDivElement>(null), [pickerKey, setPickerKey] = useState(0), [mode, setMode] = useState<'add' | 'copy' | null>(null);
    const clear = () => { setPreview(null); setError(''); setSaved(false); };
    const open = (before: Member | null, remove = false) => { clear(); setMode(null); setEditor({ before, remove }); setUnitId(before?.unitId ?? value.reviews.find(x => x.status === 'draft')?.id ?? ''); setUserId(before?.userId ?? ''); setRole(before?.role ?? 'bu');setValidFrom(before?.validFrom??todayInKualaLumpur());setValidTo(before?.validTo??'');setCoversUserId(before?.coversUserId??'');setRestoreReason('');setRestoring(false); setPickerKey(k => k + 1); requestAnimationFrame(() => { editorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' }); userRef.current?.querySelector<HTMLElement>('button, input')?.focus(); }); };
    const review = value.reviews.find(x => x.id === unitId);
    const change: RewardAccessChange = { unitId, revision: review?.revision ?? 0, before: editor?.before ? { userId: editor.before.userId, role: editor.before.role } : null, after: editor?.remove ? null : { userId, role,validFrom,validTo:validTo||null,coversUserId:coversUserId||null,...(restoring?{restoreReason}: {}) } };
    const name = (id: string) => { const account = value.users.find(x => x.id === id) ?? value.members.find(x => x.userId === id); return account?.name ?? account?.email ?? t('unavailable', { id }); };
    const scope = (id: string) => { const row = value.reviews.find(x => x.id === id); return row ? `${row.company} / ${row.unit} · ${row.cycle} · ${row.year} · ${r(`kinds.${row.kind}`)}` : ''; };
    const inScope = (v: RewardAccessAdministration['reviews'][number]) => (!company || v.companyId === company) && (!cycle || v.cycleId === cycle) && (!unitFilter || v.businessUnitId === unitFilter) && (!gaps || !!v.coverage?.missing.length);
    const rows = value.members.filter(m => { const v = value.reviews.find(x => x.id === m.unitId); return v && inScope(v) && `${m.name ?? ''} ${m.email ?? ''} ${m.employeeCode ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()); });
    // 68c84963: searchable people picker. Identification only (employee number, title, company, BU); a person
    // without a login is listed but cannot be chosen, and prepareAccess still refuses anything but an active login.
    const facts = (x: { employeeCode: string | null; jobTitle: string | null; companyName: string | null; businessUnitName: string | null }) => [x.employeeCode, x.jobTitle, x.companyName, x.businessUnitName].filter(Boolean).join(' · ');
    const accounts: ComboboxOption[] = [...value.users.map(x => ({ value: x.id, label: x.name ?? x.email ?? t('unnamed'), description: [facts(x), x.email].filter(Boolean).join(' · '), keywords: x.employeeCode ?? '' })), ...value.candidates.map((x, i) => ({ value: `no-login:${i}`, label: x.name ?? x.email ?? t('unnamed'), description: [t('noLogin'), facts(x)].filter(Boolean).join(' · '), keywords: `${x.email ?? ''} ${x.employeeCode ?? ''}`, disabled: true }))];
    // f38e5d8e: additions and cycle copies go through one all-or-nothing batch; Edit/Remove stay single exact changes.
    const begin = (next: 'add' | 'copy') => { clear(); setEditor(null); setMode(next); requestAnimationFrame(() => editorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' })); };
    const batchSaved = () => { setMode(null); setSaved(true); router.refresh(); };
    const labels = { name, scope: (id: string) => { const row = value.reviews.find(x => x.id === id); return row ? `${row.company} / ${row.unit} · ${row.cycle}` : ''; } };
    const unique = (field: 'companyId' | 'cycleId' | 'businessUnitId') => [...new Map(value.reviews.map(x => [x[field], x])).values()];
    const unchanged = !!editor?.before && !editor.remove && editor.before.userId === userId && editor.before.role === role && (editor.before.validFrom??todayInKualaLumpur())===validFrom && (editor.before.validTo??'')===validTo && (editor.before.coversUserId??'')===coversUserId&&!restoring;
    return <div className="space-y-6">
  {singleAdminCompanies.length>0&&<p role="status" className="rounded-md border border-warning/40 p-3 text-sm">{c('singleAdmin',{companies:singleAdminCompanies.join(', ')})}</p>}
  <RewardAccessRequests requests={requests} value={value}/>
  <Link href="/admin/rewards/access/export" className="inline-flex rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted">{c('export')}</Link>
  <div className="flex flex-wrap items-end justify-between gap-3"><div className="flex flex-wrap items-end gap-3">
   <Field label={t('search')}><input type="search" value={query} onChange={e => setQuery(e.target.value)} className={inputCls}/></Field>
   <Field label={r('company')}><select className={inputCls} value={company} onChange={e => setCompany(e.target.value)}><option value="">{t('allCompanies')}</option>{unique('companyId').map(x => <option key={x.companyId} value={x.companyId}>{x.company}</option>)}</select></Field>
   <Field label={r('cycle')}><select className={inputCls} value={cycle} onChange={e => setCycle(e.target.value)}><option value="">{t('allCycles')}</option>{unique('cycleId').map(x => <option key={x.cycleId} value={x.cycleId}>{x.cycle} · {x.year}</option>)}</select></Field>
   <Field label={r('unit')}><select className={inputCls} value={unitFilter} onChange={e => setUnitFilter(e.target.value)}><option value="">{t('allUnits')}</option>{unique('businessUnitId').map(x => <option key={x.businessUnitId} value={x.businessUnitId}>{x.unit}</option>)}</select></Field>
   <Field label={t('coverageFilter')}><select className={inputCls} value={gaps ? 'missing' : ''} onChange={e => setGaps(e.target.value === 'missing')}><option value="">{t('coverageAll')}</option><option value="missing">{t('coverageMissingOnly')}</option></select></Field>
  </div><div className="flex flex-wrap gap-2"><Button type="button" disabled={busy || !value.reviews.some(x => x.status === 'draft') || !value.users.length} onClick={() => begin('add')}><Plus aria-hidden className="size-4"/>{t('add')}</Button><Button type="button" variant="outline" disabled={busy || new Set(value.reviews.filter(x => x.kind === 'annual').map(x => x.cycleId)).size < 2 || !value.reviews.some(x => x.status === 'draft')} onClick={() => begin('copy')}><Copy aria-hidden className="size-4"/>{b('copyOpen')}</Button></div></div>
  <p role="status" className="text-sm text-muted-foreground">{t('count', { count: rows.length })}</p>
  <div className={tableWrapCls}><table className="w-full text-sm"><thead className={theadCls}><tr>{['user', 'role', 'scope', 'state', 'actions'].map(k => <th key={k} className={thCls}>{t(k)}</th>)}</tr></thead><tbody className={tbodyCls}>{rows.map(m => {
            const v = value.reviews.find(x => x.id === m.unitId)!;
            const locked = v.status !== 'draft';
            // cd72f915: the server refuses losing the last active holder of any required seat (GR: any holder).
            const required = !!v.coverage?.roles.find(x => x.role === m.role)?.required;
            const lastRequired = required && (m.role === 'gr' || !m.disabled) && !value.members.some(x => x.unitId === m.unitId && x.role === m.role && x.id !== m.id && !x.disabled);
            const lastGr = lastRequired && m.role === 'gr';
            return <tr key={m.id}><td className="px-3 py-3"><span className="font-medium">{m.name ?? m.email ?? t('unavailable', { id: m.userId })}</span>{m.email && m.name && <span className="block text-xs text-muted-foreground">{m.email}</span>}<span className="block text-xs text-muted-foreground">{m.suspension?c(`suspensions.${m.suspension.reason}`,{on:m.suspension.on}):t(m.disabled?'disabled':'active')}</span><span className="block text-xs text-muted-foreground">{m.validFrom} – {m.validTo??c('openEnded')}{m.coversUserId&&` · ${c('proxyFor',{name:name(m.coversUserId)})}`}</span></td><td className="px-3 py-3">{r(`roles.${m.role}`)}{m.role === 'pbp' && <span className="block text-xs text-muted-foreground">{t('readOnly')}</span>}</td><td className="px-3 py-3"><span>{v.company} / {v.unit}</span><span className="block text-xs text-muted-foreground">{v.cycle}</span></td><td className="px-3 py-3">{r(`stages.${v.status}`)}<span className="block text-xs text-muted-foreground">{t(locked ? 'locked' : 'editable')}</span></td><td className="px-3 py-3"><div className="flex flex-wrap gap-1"><Button type="button" variant="ghost" size="sm" disabled={busy || locked} onClick={() => open(m)} aria-label={`${t('edit')} · ${name(m.userId)} · ${r(`roles.${m.role}`)}`}><Pencil aria-hidden className="size-4"/>{t('edit')}</Button><Button type="button" variant="ghost" size="sm" disabled={busy || locked || lastRequired} onClick={() => open(m, true)} aria-label={`${t('remove')} · ${name(m.userId)} · ${r(`roles.${m.role}`)}`}><Trash2 aria-hidden className="size-4"/>{t('remove')}</Button></div>{locked && <p className="max-w-xs text-xs text-muted-foreground">{t('lockedHelp')}</p>}{lastRequired && !locked && <p className="max-w-xs text-xs text-muted-foreground">{t(lastGr ? 'lastGrHelp' : 'lastRequiredHelp')}</p>}</td></tr>;
        })}</tbody></table>{!rows.length && <p className="px-5 py-10 text-sm text-muted-foreground">{t(value.reviews.length ? 'empty' : 'noScopes')}</p>}</div>
  <RewardCoveragePanel reviews={value.reviews.filter(inScope)}/>
  {saved && <p role="status" className="rounded-md border p-3 text-sm">{t('saved')}</p>}
  <div ref={editorRef}>{mode === 'add' && <BatchAddAccess value={value} accounts={accounts} labels={labels} onSaved={batchSaved} onCancel={() => setMode(null)}/>}{mode === 'copy' && <CopyAccess value={value} labels={labels} onSaved={batchSaved} onCancel={() => setMode(null)}/>}{editor && <Card className="p-5"><SectionHeader title={t(editor.remove ? 'removeTitle' : editor.before ? 'editTitle' : 'add')}/><p className="mb-4 max-w-3xl text-sm text-muted-foreground">{t('bounded')}</p>
   <fieldset disabled={busy} className="grid gap-4 md:grid-cols-2">
    <div ref={userRef}><Field label={t('person')}>{editor.remove ? <input className={inputCls} readOnly value={name(userId)}/> : <Combobox key={pickerKey} value={userId} options={accounts} placeholder={t('chooseAccount')} searchPlaceholder={t('personSearch')} noResultsLabel={t('noPeople')} legacySuffix="" onValueChange={v => { if (!v.startsWith('no-login:')) { setUserId(v); clear(); } }}/>}</Field>{!editor.remove && value.candidates.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{t('noLoginHelp')}</p>}</div>
    <Field label={t('role')}><select className={inputCls} value={role} disabled={editor.remove} onChange={e => { setRole(e.target.value as RewardRole); clear(); }}>{rewardRoles.map(x => <option key={x} value={x}>{r(`roles.${x}`)}</option>)}</select></Field>
    <Field label={t('scope')}><select className={inputCls} value={unitId} disabled={!!editor.before} onChange={e => { setUnitId(e.target.value); clear(); }}><option value="">{t('chooseScope')}</option>{value.reviews.map(x => <option key={x.id} value={x.id} disabled={x.status !== 'draft'}>{scope(x.id)}</option>)}</select></Field>
    <div className="rounded-md border p-3 text-sm"><p className="font-medium">{r(`roles.${role}`)}</p><p className="mt-1 text-muted-foreground">{t(`permissions.${role}`)}</p></div>
    {!editor.remove&&<><Field label={c('validFrom')}><input type="date" className={inputCls} value={validFrom} onChange={e=>{setValidFrom(e.target.value);clear();}}/></Field><Field label={c('validTo')}><input type="date" className={inputCls} min={validFrom} value={validTo} onChange={e=>{setValidTo(e.target.value);clear();}}/></Field><Field label={c('covers')}><select className={inputCls} value={coversUserId} onChange={e=>{setCoversUserId(e.target.value);clear();}}><option value="">{c('notProxy')}</option>{value.members.filter(m=>m.unitId===unitId&&m.role===role&&m.userId!==userId).map(m=><option key={m.id} value={m.userId}>{name(m.userId)}</option>)}</select></Field>
    {editor.before?.suspension&&['notice','assignment'].includes(editor.before.suspension.reason)&&<div className="space-y-2"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={restoring} onChange={e=>{setRestoring(e.target.checked);clear();}}/>{c('restore')}</label>{restoring&&<Field label={c('restoreReason')}><textarea className={inputCls} value={restoreReason} minLength={10} maxLength={2000} onChange={e=>{setRestoreReason(e.target.value);clear();}}/></Field>}</div>}</>}
   </fieldset>
   <div className="mt-5 flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => { setEditor(null); clear(); }}>{t('cancel')}</Button><Button type="button" disabled={busy || !review || review.status !== 'draft' || !userId || unchanged || !validFrom || (!!validTo&&validTo<validFrom) || (restoring&&restoreReason.trim().length<10)} onClick={() => start(async () => {
                clear();
                try {
                    const result = await previewRewardAccessAction(change);
                    if (result.ok)
                        setPreview(result.preview);
                    else
                        setError(result.error);
                }
                catch {
                    setError('system');
                }
            })}>{t('preview')}</Button></div>
   {error && <p role="alert" className="mt-4 text-sm text-destructive">{t(`errors.${error}`)}</p>}
   {preview && <section className="mt-5 space-y-3 rounded-md border p-4" aria-label={t('previewTitle')}><h3 className="font-semibold">{t('previewTitle')}</h3><p className="text-sm">{scope(preview.unitId)}</p><dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">{t('before')}</dt><dd className="mt-1 font-medium">{preview.before ? `${name(preview.before.userId)} · ${r(`roles.${preview.before.role}`)}` : t('none')}</dd></div><div><dt className="text-muted-foreground">{t('after')}</dt><dd className="mt-1 font-medium">{preview.after ? `${name(preview.after.userId)} · ${r(`roles.${preview.after.role}`)}` : t('revoked')}</dd></div></dl><p className="text-xs text-muted-foreground">{t('history')}</p><Button type="button" disabled={busy} variant={editor.remove ? 'destructive' : 'default'} onClick={() => start(async () => {
                    setError('');
                    try {
                        const result = await saveRewardAccessAction({ unitId: preview.unitId, revision: preview.revision, before: preview.before, after: preview.after }, preview.digest);
                        if (result.ok) {
                            setEditor(null);
                            setPreview(null);
                            setSaved(true);
                            router.refresh();
                        }
                        else {
                            setPreview(null);
                            setError(result.error);
                        }
                    }
                    catch {
                        setPreview(null);
                        setError('system');
                    }
                })}>{t('save')}</Button></section>}
  </Card>}</div>
  <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-semibold">{t('permissionsTitle')}</summary><dl className="mt-4 grid gap-4 sm:grid-cols-2">{rewardRoles.map(x => <div key={x}><dt className="text-sm font-medium">{r(`roles.${x}`)}</dt><dd className="mt-1 text-sm text-muted-foreground">{t(`permissions.${x}`)}</dd></div>)}</dl><RewardConfidentialityRules /></details>
 </div>;
}
