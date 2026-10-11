import { RewardSubmit } from '../../../submit-button';
import Link from 'next/link';
import { RoleComparison } from './role-comparison';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { getRewardUnit } from '@/packs/rewards/service';
import { performances, talents } from '@/packs/rewards/model';
import { Button, Card, Field, PageHeader, inputCls } from '@/components/ui';
import { entryAction } from '../../../actions';

export default async function RewardPersonPage({ params }: { params: Promise<{ unitId: string; entryId: string }> }) {
  await requireModule('rewards'); const { s } = await scopedSession(); const { unitId, entryId } = await params;
  const t = await getTranslations('rewards'); const v = await getRewardUnit(s, unitId); const e = v.rows.find(r => r.id === entryId);
  if (!e) notFound();
  const canEdit = v.unit.status === 'draft' && (v.canEdit || e.plan === 'ec' && v.roles.some(r => ['gr', 'ctro', 'ec'].includes(r)));
  const gr = v.roles.includes('gr'), r = e.recommendation, f = e.facts;
  const rm = (cents: number) => new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(cents / 100);
  const numeric = (name: string, label: string, value: number | null, scale = 100) => <Field label={label}><input type="number" min="0" step="0.01" name={name} defaultValue={value == null ? '' : value / scale} placeholder={t('automatic')} className={inputCls} /></Field>;
  return <div className="mx-auto max-w-5xl space-y-5">
    <Link href={`/rewards/${unitId}`} className="text-sm text-primary hover:underline">← {t('review')}</Link>
    <PageHeader title={e.source.name} description={`${e.source.employeeCode} · ${t('grade')} ${e.source.grade} · ${t(e.plan === 'ec' ? 'ecPlan' : e.plan)}`} />
    <Card className="p-5"><dl className="grid gap-4 text-sm sm:grid-cols-3">{[[t('currentPay'), rm(e.source.basicCents)], [t('newPay'), rm(e.newBasicCents)], [t('bonus'), rm(e.bonusCents)], [t('lumpSum'), rm(e.lumpCents)], [t('incrementEligibility'), e.incrementReason || t('eligible')], [t('bonusEligibility'), e.bonusReason || t('eligible')]].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 font-medium tabular-nums">{value}</dd></div>)}</dl></Card>
    <form action={entryAction} className="space-y-6">
      <input type="hidden" name="unitId" value={unitId} /><input type="hidden" name="revision" value={v.unit.revision} /><input type="hidden" name="entryId" value={entryId} />
      <fieldset disabled={!canEdit} className="space-y-4"><legend className="mb-3 text-base font-semibold">{t('recommendation')}</legend>
        <p className="max-w-3xl text-sm text-muted-foreground">{t('overrideHelp')}</p>
        <div className="grid gap-4 sm:grid-cols-3">{numeric('merit', `${t('merit')} (%)`, r.meritBp)}{numeric('promotion', `${t('promotion')} (%)`, r.promotionBp)}{numeric('special', `${t('special')} (%)`, r.specialBp)}
          <Field label={t('promotionGrade')}><input name="promotionGrade" defaultValue={r.promotionGrade ?? ''} maxLength={30} className={inputCls} /></Field>
          {v.unit.kind === 'annual' && numeric('multiplier', t('bonusMultiplier'), r.multiplierBp, 10000)}
          {(e.lumpEligible || e.plan === 'ec') && numeric('lump', t('lumpSum'), r.lumpCents)}
          {v.unit.kind === 'annual' && e.plan === 'ec' && numeric('bonus', t('bonus'), r.bonusCents)}
        </div>
        <Field label={t('businessCase')}><textarea name="reason" rows={3} maxLength={4000} defaultValue={r.reason} className={`${inputCls} h-auto py-2`} /></Field>
        {v.unit.kind !== 'annual' && <RoleComparison current={r.currentRoleSummary} proposed={r.proposedRoleSummary} />}
        {gr && <>
          <input type="hidden" name="facts" value="true" />
          <h2 className="pt-3 text-base font-semibold">{t('classification')}</h2><p className="max-w-3xl text-sm text-muted-foreground">{t('classificationHelp')}</p>
          {e.source.performanceReviewId && <p className="text-sm">{t('sourceRating')}: <Link href={`/performance/review/${e.source.performanceReviewId}`} className="text-primary hover:underline">{e.source.performanceRating ?? '—'}</Link></p>}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('talent')}><select name="talent" defaultValue={f.talent ?? ''} className={inputCls}><option value="">{t('notAvailable')}</option>{talents.map(k => <option key={k}>{k}</option>)}</select></Field>
            <Field label={t('performance')}><select name="performance" defaultValue={f.performance ?? ''} className={inputCls}><option value="">{t('notAvailable')}</option>{performances.map(k => <option key={k}>{k}</option>)}</select></Field>
            <Field label={t('confidentiality')}><select name="confidentiality" defaultValue={f.confidentiality} className={inputCls}>{['standard', 'bg', 'ec'].map(k => <option key={k} value={k}>{t(`visibility.${k}`)}</option>)}</select></Field>
            <Field label={t('branch')}><input name="branch" defaultValue={f.branch} maxLength={100} className={inputCls} /></Field><Field label={t('segment')}><input name="segment" defaultValue={f.segment} maxLength={80} className={inputCls} /></Field>
          </div><div className="flex flex-wrap gap-5 text-sm">{(['seniorPlan', 'erCase', 'pipCase', 'reviewed'] as const).map(key => <label key={key} className="flex items-center gap-2"><input type="checkbox" name={key} defaultChecked={f[key]} />{t(key)}</label>)}</div>
        </>}
        {(gr || v.roles.includes('bu')) && <><input type="hidden" name="cases" value="true" /><div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('erDecision')}><select name="erDecision" defaultValue={f.erDecision} className={inputCls}>{['pending', 'in', 'out'].map(k => <option key={k} value={k}>{t(`case.${k}`)}</option>)}</select></Field>
          <Field label={t('pipDecision')}><select name="pipDecision" defaultValue={f.pipDecision} className={inputCls}>{['pending', 'lift', 'confirm'].map(k => <option key={k} value={k}>{t(`case.${k}`)}</option>)}</select></Field>
        </div><Field label={t('caseReason')}><textarea name="caseReason" rows={3} defaultValue={f.caseReason} maxLength={3000} className={`${inputCls} h-auto py-2`} /></Field></>}
        {canEdit ? <RewardSubmit type="submit">{t('saveRecommendation')}</RewardSubmit> : <p className="text-sm text-muted-foreground">{t('locked')}</p>}
      </fieldset>
    </form>
  </div>;
}
