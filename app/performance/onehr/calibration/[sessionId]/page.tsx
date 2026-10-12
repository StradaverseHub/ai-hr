import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { getOnehrCalibration } from '@/packs/performance/service';
import { pmBands, potentialBands } from '@/packs/performance/onehr/model';
import { Button, Card, ErrorBanner, Field, PageHeader, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { onehrCalibrationAction } from '../../../onehr-actions';

export default async function OnehrCalibrationPage({params,searchParams}:{params:Promise<{sessionId:string}>;searchParams:Promise<{error?:string}>}) {
  const {s}=await scopedSession();
  const {sessionId}=await params,{error}=await searchParams,t=await getTranslations('onehr');
  const v=await getOnehrCalibration(s,sessionId);
  const fields=<><input type="hidden" name="sessionId" value={sessionId}/><input type="hidden" name="revision" value={v.session.revision}/></>;
  const axisSelect=(pm:boolean,pot:boolean)=><Field label={t('assessmentAxis')}><select name="axis" defaultValue={pm&&pot?'both':pm?'performance':'potential'} className={inputCls}>{pm&&pot&&<option value="both">{t('bothAxes')}</option>}{pm&&<option value="performance">{t('performance')}</option>}{pot&&<option value="potential">{t('potential')}</option>}</select></Field>;
  const pmOpen=v.modules.pm&&!v.session.performanceLockedAt,potOpen=v.modules.tm&&!v.session.potentialLockedAt;
  return <div className="mx-auto max-w-5xl space-y-5">
    <PageHeader back={{href:'/me/performance',label:t('back')}} title={`${v.session.name} · ${v.cycle.name}`} description={t(`tiers.${v.session.tier}`)}/>
    <ErrorBanner message={error}/><p className="text-sm text-muted-foreground">{t('calibrationHelp')}</p>
    {v.reference&&<Card className="space-y-2 p-5"><h2 className="font-semibold">{t('referenceCurve')}</h2><div className="flex flex-wrap gap-5">{pmBands.map(b=><p key={b}>{b}: {v.reference![b]}%</p>)}</div></Card>}
    {v.rows.map(r=>{
      const pm=pmOpen&&(!r.entry.performanceLockedAt||v.session.tier==='final'),pot=potOpen&&(!r.entry.potentialLockedAt||v.session.tier==='final');
      const editable=!r.finalized&&!v.session.lockedAt&&(pm||pot);
      return <Card key={r.entry.id} className="space-y-4 p-5">
        <h2 className="font-semibold">{r.name} · {r.grade}</h2>
        {v.canReopen&&!r.finalized&&(v.modules.pm&&(v.session.performanceLockedAt||r.entry.performanceLockedAt)||v.modules.tm&&(v.session.potentialLockedAt||r.entry.potentialLockedAt))&&<details><summary className="cursor-pointer text-sm font-medium">{t('reopenCalibration')}</summary><form action={onehrCalibrationAction} className="mt-3 space-y-3">{fields}<input type="hidden" name="action" value="unlock"/><input type="hidden" name="reviewId" value={r.entry.reviewId}/>{axisSelect(v.modules.pm&&!!(v.session.performanceLockedAt||r.entry.performanceLockedAt),v.modules.tm&&!!(v.session.potentialLockedAt||r.entry.potentialLockedAt))}<p className="text-sm text-muted-foreground">{t('reopenCalibrationHelp')}</p><Field label={t('reason')}><textarea required name="reason" maxLength={4000} className={inputCls}/></Field><ConfirmSubmit description={t('reopenCalibrationHelp')} variant="secondary">{t('reopenCalibration')}</ConfirmSubmit></form></details>}
        <p className="text-sm">{t('managerAssessment')}: {r.managerPerformance??'—'} · {t('managerPotential')}: {r.managerPotential??'—'}</p>
        <p className="text-sm">{t('effectiveAssessment')}: {r.currentPerformance??'—'} · {r.currentPotential??'—'}</p>
        {!editable?<p>{t('locked')} · {r.entry.performance??'—'} · {r.entry.potential??'—'}</p>:<>
          <form action={onehrCalibrationAction} className="space-y-4">{fields}
            <input type="hidden" name="action" value="save"/><input type="hidden" name="reviewId" value={r.entry.reviewId}/>
            {axisSelect(pm,pot)}
            <div className="grid gap-4 sm:grid-cols-2">
              {pm&&<><Field label={t('performance')}><select name="performance" defaultValue={r.entry.performance??''} className={inputCls}><option value="">{t('keepPrevious')}</option>{pmBands.map(b=><option key={b}>{b}</option>)}</select></Field><Field label={t('performanceReason')}><textarea name="performanceNote" maxLength={4000} defaultValue={r.entry.performanceNote} className={inputCls}/></Field></>}
              {pot&&<><Field label={t('potential')}><select name="potential" defaultValue={r.entry.potential??''} className={inputCls}><option value="">{t('keepPrevious')}</option>{potentialBands.map(b=><option key={b}>{b}</option>)}</select></Field><Field label={t('potentialReason')}><textarea name="potentialNote" maxLength={4000} defaultValue={r.entry.potentialNote} className={inputCls}/></Field></>}
            </div>
            {['bg','group','final'].includes(v.session.tier)&&(!v.modules.pm||pm||!!r.entry.performanceLockedAt)&&(!v.modules.tm||pot||!!r.entry.potentialLockedAt)&&<fieldset className="space-y-2"><input type="hidden" name="confirmTalentDecisions" value="true"/><legend className="mb-2 font-medium">{t('explicitDecisions')}</legend>{(['pip','promotion','specialReward'] as const).map(k=><label className="flex gap-2 text-sm" key={k}><input type="checkbox" name={k} defaultChecked={r.entry[k]}/>{t(k)}</label>)}</fieldset>}
            <Button type="submit">{v.session.tier==='final'?t('confirmAssessment'):t('save')}</Button>
          </form>
          {v.session.tier==='group'&&<form action={onehrCalibrationAction} className="space-y-3">{fields}<input type="hidden" name="action" value="lock"/><input type="hidden" name="reviewId" value={r.entry.reviewId}/>{axisSelect(pm,pot)}<Field label={t('overrideReason')}><textarea name="reason" maxLength={4000} className={inputCls}/></Field><ConfirmSubmit description={t('lockConfirm')} variant="secondary">{t('lockPerson')}</ConfirmSubmit></form>}
        </>}
      </Card>;
    })}
    {v.canLockCohort!==false&&!v.session.lockedAt&&(pmOpen||potOpen)&&<Card className="p-5"><form action={onehrCalibrationAction} className="space-y-4">{fields}<input type="hidden" name="action" value="lock"/>{axisSelect(pmOpen,potOpen)}<Field label={t('overrideReason')}><textarea name="reason" maxLength={4000} className={inputCls}/></Field><ConfirmSubmit description={t('lockConfirm')} variant="secondary">{t('lockCalibration')}</ConfirmSubmit></form></Card>}
  </div>;
}
