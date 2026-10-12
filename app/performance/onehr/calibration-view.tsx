import { getTranslations } from 'next-intl/server';
import type { getOnehrCalibration } from '@/packs/performance/service';
import { pmBands, potentialBands, talentCategory, type PMBand, type PotentialBand } from '@/packs/performance/onehr/model';
import { Button, Card, ErrorBanner, Field, PageHeader, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { onehrCalibrationAction } from '../onehr-actions';
import { TalentGrid } from './talent-grid';
export async function AssessmentCalibrationView({v,error,embedded=false,returnTo}:{v:Awaited<ReturnType<typeof getOnehrCalibration>>;error?:string;embedded?:boolean;returnTo?:string}){
  const sessionId=v.session.id,t=await getTranslations('onehr');
  const fields=<><input type="hidden" name="sessionId" value={sessionId}/><input type="hidden" name="revision" value={v.session.revision}/>{returnTo&&<input type="hidden" name="returnTo" value={returnTo}/>}</>;
  const axisSelect=(pm:boolean,pot:boolean)=><Field label={t('assessmentAxis')}><select name="axis" defaultValue={pm&&pot?'both':pm?'performance':'potential'} className={inputCls}>{pm&&pot&&<option value="both">{t('bothAxes')}</option>}{pm&&<option value="performance">{t('performance')}</option>}{pot&&<option value="potential">{t('potential')}</option>}</select></Field>;
  const groupPerformance=embedded&&v.session.tier==='group';
  const pmOpen=v.axes.pm&&!v.session.performanceLockedAt,potOpen=v.axes.pot&&!groupPerformance&&!v.session.potentialLockedAt;
  return <div className={embedded?"space-y-5":"mx-auto max-w-5xl space-y-5"}>
    {!embedded&&<PageHeader back={{href:'/me/performance',label:t('back')}} title={`${v.session.name} · ${v.cycle.name}`} description={t(`tiers.${v.session.tier}`)}/>}
    <ErrorBanner message={error}/><p className="text-sm text-muted-foreground">{t('calibrationHelp')}</p>
    {v.reference&&<Card className="space-y-2 p-5"><h2 className="font-semibold">{t('referenceCurve')}</h2><div className="flex flex-wrap gap-5">{pmBands.map(b=><p key={b}>{b}: {v.reference![b]}%</p>)}</div></Card>}
    {!groupPerformance&&v.modules.pm&&v.modules.tm&&<TalentGrid rows={v.rows.map(r=>({id:r.entry.reviewId,name:r.name,performance:(r.entry.performance??r.currentPerformance) as PMBand|null,potential:(r.entry.potential??r.currentPotential) as PotentialBand|null}))} labels={{title:t('talentGrid'),layout:t('gridLayout'),performance:t('performance'),potential:t('potential'),low:t('gridLow'),mid:t('gridMid'),high:t('gridHigh'),unrated:t('gridUnrated')}}/>}
    {v.rows.map(r=>{
      const pm=pmOpen&&(!r.entry.performanceLockedAt||v.session.tier==='final'),pot=potOpen&&(!r.entry.potentialLockedAt||v.session.tier==='final');
      const editable=!r.finalized&&!v.session.lockedAt&&(pm||pot);
      const category=talentCategory((r.entry.performance??r.currentPerformance) as PMBand|null,(r.entry.potential??r.currentPotential) as PotentialBand|null);
      const pinsOpen=!groupPerformance&&!r.entry.lockedAt&&!v.session.lockedAt&&!r.finalized&&category!=null&&category!=='PIP/Improvement';
      const ownNomination=r.entry.nominations.find(n=>n.userId===v.actorUserId);
      return <Card id={`assessment-${r.entry.reviewId}`} key={r.entry.id} className="space-y-4 p-5">
        <h2 className="font-semibold">{r.name} · {r.grade}</h2>
        {v.canReopen&&!r.finalized&&(v.axes.pm&&(v.session.performanceLockedAt||r.entry.performanceLockedAt)||v.axes.pot&&(v.session.potentialLockedAt||r.entry.potentialLockedAt))&&<details><summary className="cursor-pointer text-sm font-medium">{t('reopenCalibration')}</summary><form action={onehrCalibrationAction} className="mt-3 space-y-3">{fields}<input type="hidden" name="action" value="unlock"/><input type="hidden" name="reviewId" value={r.entry.reviewId}/>{axisSelect(v.axes.pm&&!!(v.session.performanceLockedAt||r.entry.performanceLockedAt),v.axes.pot&&!!(v.session.potentialLockedAt||r.entry.potentialLockedAt))}<p className="text-sm text-muted-foreground">{t('reopenCalibrationHelp')}</p><Field label={t('reason')}><textarea required name="reason" maxLength={4000} className={inputCls}/></Field><ConfirmSubmit description={t('reopenCalibrationHelp')} variant="secondary">{t('reopenCalibration')}</ConfirmSubmit></form></details>}
        <p className="text-sm">{t('managerAssessment')}: {r.managerPerformance??'—'} · {t('managerPotential')}: {r.managerPotential??'—'}</p>
        <p className="text-sm">{t('effectiveAssessment')}: {r.currentPerformance??'—'} · {r.currentPotential??'—'}</p>
        {pinsOpen&&['bu','bg','group','final'].includes(v.session.tier)&&<form action={onehrCalibrationAction} className="flex flex-wrap items-end gap-3">{fields}<input type="hidden" name="action" value="talent-save"/><input type="hidden" name="kind" value="specialReward"/><input type="hidden" name="talentRevision" value={r.talent.revision}/><input type="hidden" name="reviewId" value={r.entry.reviewId}/><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="selected" defaultChecked={r.entry.specialReward}/>{t('specialReward')}</label><Field label={t('reason')}><textarea name="reason" defaultValue={r.entry.specialRewardReason} maxLength={2000} className={inputCls}/></Field><Button type="submit" variant="secondary">{t('save')}</Button></form>}
        {pinsOpen&&v.session.tier==='bg'&&<form action={onehrCalibrationAction} className="grid gap-3 rounded-md border border-border p-4 sm:grid-cols-2">
          {fields}<input type="hidden" name="action" value="talent-save"/><input type="hidden" name="kind" value="nomination"/><input type="hidden" name="reviewId" value={r.entry.reviewId}/><input type="hidden" name="talentRevision" value={r.talent.revision}/>
          <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="selected" defaultChecked={!!ownNomination}/>{t('nominatePromotion')}</label>
          <Field label={t('proposedGrade')}><input name="grade" maxLength={20} defaultValue={ownNomination?.grade} className={inputCls}/></Field>
          <Field label={t('proposedTitle')}><input name="title" maxLength={120} defaultValue={ownNomination?.title} className={inputCls}/></Field>
          <Field label={t('reason')}><textarea name="reason" maxLength={2000} defaultValue={ownNomination?.reason} className={inputCls}/></Field>
          <div className="flex items-end justify-end"><Button type="submit" variant="secondary">{t('save')}</Button></div>
        </form>}
        {!editable?<p>{t('locked')} · {r.entry.performance??'—'} · {r.entry.potential??'—'}</p>:<>
          <form action={onehrCalibrationAction} className="space-y-4">{fields}
            <input type="hidden" name="action" value="save"/><input type="hidden" name="reviewId" value={r.entry.reviewId}/>
            {axisSelect(pm,pot)}
            <div className="grid gap-4 sm:grid-cols-2">
              {pm&&<><Field label={t('performance')}><select name="performance" defaultValue={r.entry.performance??''} className={inputCls}><option value="">{t('keepPrevious')}</option>{pmBands.map(b=><option key={b}>{b}</option>)}</select></Field><Field label={t('performanceReason')}><textarea name="performanceNote" maxLength={4000} defaultValue={r.entry.performanceNote} className={inputCls}/></Field></>}
              {pot&&<><Field label={t('potential')}><select name="potential" defaultValue={r.entry.potential??''} className={inputCls}><option value="">{t('keepPrevious')}</option>{potentialBands.map(b=><option key={b}>{b}</option>)}</select></Field><Field label={t('potentialReason')}><textarea name="potentialNote" maxLength={4000} defaultValue={r.entry.potentialNote} className={inputCls}/></Field></>}
            </div>

            <Button type="submit">{v.session.tier==='final'?t('confirmAssessment'):t('save')}</Button>
          </form>
          {v.session.tier==='group'&&<form action={onehrCalibrationAction} className="space-y-3">{fields}<input type="hidden" name="action" value="lock"/><input type="hidden" name="reviewId" value={r.entry.reviewId}/>{axisSelect(pm,pot)}<Field label={t('overrideReason')}><textarea name="reason" maxLength={4000} className={inputCls}/></Field><ConfirmSubmit description={t('lockConfirm')} variant="secondary">{t('lockPerson')}</ConfirmSubmit></form>}
        </>}
      </Card>;
    })}
    {v.session.tier==='bg'&&!v.session.lockedAt&&<section className="space-y-3 p-5"><h2 className="font-semibold">{t('lockBusinessUnits')}</h2>{v.units.map(unit=><form key={unit.id} action={onehrCalibrationAction} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">{fields}<input type="hidden" name="action" value="lock"/><input type="hidden" name="axis" value="both"/><input type="hidden" name="companyId" value={unit.id}/><span className="text-sm">{unit.name}</span>{unit.locked?<span className="text-xs text-muted-foreground">{t('locked')}</span>:<ConfirmSubmit description={t('lockConfirm')} variant="secondary">{t('lockBusinessUnit')}</ConfirmSubmit>}</form>)}</section>}
    {v.canLockCohort!==false&&!v.session.lockedAt&&(pmOpen||potOpen)&&<Card className="p-5"><form action={onehrCalibrationAction} className="space-y-4">{fields}<input type="hidden" name="action" value="lock"/>{axisSelect(pmOpen,potOpen)}<Field label={t('overrideReason')}><textarea name="reason" maxLength={4000} className={inputCls}/></Field><ConfirmSubmit description={t('lockConfirm')} variant="secondary">{t('lockCalibration')}</ConfirmSubmit></form></Card>}
    {['bg','group','final'].includes(v.session.tier)&&v.session.lockedAt&&<section className="space-y-5 border-t border-border p-5">
      <p className="text-sm text-muted-foreground">{t('talentListHelp')}</p>
      {(['pip','promotion'] as const).map(kind=>{
        const locked=kind==='pip'?v.session.pipLockedAt:v.session.promotionLockedAt;
        const waiting=embedded&&kind==='promotion'&&!v.session.pipLockedAt;
        const candidates=v.rows.filter(r=>kind==='promotion'?r.talent.promotionEligible:talentCategory((r.entry.performance??r.currentPerformance) as PMBand|null,(r.entry.potential??r.currentPotential) as PotentialBand|null)==='PIP/Improvement');
        const selected=candidates.filter(r=>r.entry[kind]).length;
        return <section key={kind} className="space-y-3">
          <h2 className="font-semibold">{t(kind)} {locked&&<span className="text-xs text-muted-foreground">· {t('confirmed')}</span>}</h2>
          {waiting?<p className="text-sm text-muted-foreground">{t('promotionWaiting')}</p>:<>
            <p className="text-sm text-muted-foreground">{t('talentSelectionCount',{selected,total:v.rows.length,percent:v.rows.length?Math.round(selected/v.rows.length*1000)/10:0})}</p>
            {!candidates.length&&<p className="text-sm">{t('noTalentCandidates')}</p>}
            {candidates.map(r=><form action={onehrCalibrationAction} key={r.entry.id} className="space-y-3 rounded-lg border border-border p-4">
              {fields}<input type="hidden" name="action" value="talent-save"/><input type="hidden" name="kind" value={kind}/><input type="hidden" name="reviewId" value={r.entry.reviewId}/><input type="hidden" name="talentRevision" value={r.talent.revision}/>
              <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="selected" defaultChecked={r.entry[kind]} disabled={!!locked||r.finalized}/>{r.name}</label>
              {kind==='promotion'&&<>
                <p className="text-sm text-muted-foreground">{r.entry.nominations.length?t('nominationCount',{count:r.entry.nominations.length}):r.talent.standingReason}</p>
                {r.entry.nominations.map(n=><p key={n.userId} className="text-sm">{[n.grade,n.title,n.reason].filter(Boolean).join(' · ')}</p>)}
                <div className="grid gap-3 sm:grid-cols-2"><Field label={t('confirmedGrade')}><input name="grade" maxLength={20} defaultValue={r.entry.confirmedGrade} disabled={!!locked||r.finalized} className={inputCls}/></Field><Field label={t('confirmedTitle')}><input name="title" maxLength={120} defaultValue={r.entry.confirmedTitle} disabled={!!locked||r.finalized} className={inputCls}/></Field></div>
              </>}
              <Field label={t('reason')}><textarea name="reason" defaultValue={kind==='pip'?r.entry.pipReason:r.entry.promotionReason} maxLength={2000} disabled={!!locked||r.finalized} className={inputCls}/></Field>
              {!locked&&!r.finalized&&<div className="flex justify-end"><Button type="submit" variant="secondary">{t('save')}</Button></div>}
            </form>)}
          </>}
          {!waiting&&v.canLockCohort&&!v.rows.some(r=>r.finalized)&&<form action={onehrCalibrationAction} className="space-y-3">
            {fields}<input type="hidden" name="kind" value={kind}/><input type="hidden" name="action" value={locked?'talent-reopen':'talent-lock'}/>
            <div className="flex justify-end"><ConfirmSubmit description={t('talentListHelp')} variant="secondary">{locked?t('reopenList'):t('confirmList')}</ConfirmSubmit></div>
          </form>}
        </section>;
      })}
    </section>}
  </div>;
}
