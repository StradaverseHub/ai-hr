'use client';
import {useEffect,useState} from 'react';
import {useTranslations} from 'next-intl';
import type {getAssessmentCalibrationPerson} from '@/packs/performance/service';
import {assessmentCalibrationPersonAction,onehrCalibrationAction} from '../onehr-actions';
import {AssessmentMutationForm} from './mutation-form';
import {CalibrationBandForm} from './calibration-band-form';
import {PerformanceInsight} from './performance-insight';
import {PotentialInsight} from './potential-insight';
import {WrittenRemarks} from './written-remarks';
import {pmBands,potentialBands,talentCategory,type PMBand,type PotentialBand} from '@/packs/performance/onehr/model';
import {Button,Card,Field,inputCls} from '@/components/ui';
import {ConfirmSubmit} from '@/components/ui/confirm-submit';
import type {WorkspaceAxis} from '@/packs/performance/onehr/workspace-model';
type Person=Awaited<ReturnType<typeof getAssessmentCalibrationPerson>>;
export function CalibrationPersonDetail({sessionId,reviewId,axis,revision,returnTo}:{sessionId:string;reviewId:string;axis:WorkspaceAxis;revision:number;returnTo?:string}){
 const t=useTranslations('onehr'),[result,setResult]=useState<{data?:Person;error?:string}|null>(null);
 useEffect(()=>{let active=true;setResult(null);assessmentCalibrationPersonAction(sessionId,reviewId,axis).then(value=>{if(active)setResult('error' in value?value:{data:value});}).catch(()=>{if(active)setResult({error:t('insight.unavailable')});});return()=>{active=false;};},[sessionId,reviewId,axis,revision,t]);
 if(result?.error)return <p role="alert" className="p-5 text-sm text-destructive">{result.error}</p>;
 if(!result?.data)return <p role="status" className="p-5 text-sm">{t('insight.working')}</p>;
 return <CalibrationPersonCard key={`${reviewId}.${result.data.session.revision}`} data={result.data} embedded axis={axis} returnTo={returnTo}/>;
}
export function CalibrationPersonCard({data:v,embedded=false,axis='both',returnTo}:{data:Person;embedded?:boolean;axis?:WorkspaceAxis;returnTo?:string}){
 const t=useTranslations('onehr'),r=v.row,sessionId=v.session.id,held=v.held;
 const fields=<><input type="hidden" name="sessionId" value={sessionId}/><input type="hidden" name="revision" value={v.session.revision}/>{returnTo&&<input type="hidden" name="returnTo" value={returnTo}/>}</>;
 const axisSelect=(pm:boolean,pot:boolean)=>embedded?<input type="hidden" name="axis" value={pm&&pot?'both':pm?'performance':'potential'}/>:<Field label={t('assessmentAxis')}><select aria-label={t('assessmentAxis')} name="axis" defaultValue={pm&&pot?'both':pm?'performance':'potential'} className={inputCls}>{pm&&pot&&<option value="both">{t('bothAxes')}</option>}{pm&&<option value="performance">{t('performance')}</option>}{pot&&<option value="potential">{t('potential')}</option>}</select></Field>;
 const groupPerformance=embedded&&v.session.tier==='group'&&axis==='performance',axes={pm:v.axes.pm&&axis!=='potential',pot:v.axes.pot&&axis!=='performance'},pmOpen=axes.pm&&!v.session.performanceLockedAt,potOpen=axes.pot&&!groupPerformance&&!v.session.potentialLockedAt;
      const heldPm=held.lines.find(l=>l.reviewId===r.entry.reviewId&&l.axis==='performance'),heldPot=held.lines.find(l=>l.reviewId===r.entry.reviewId&&l.axis==='potential');
      const pm=pmOpen&&(r.canWrite?.pm??true)&&(!r.entry.performanceLockedAt||v.session.tier==='final'),pot=potOpen&&(r.canWrite?.pot??true)&&(!r.entry.potentialLockedAt||v.session.tier==='final');
      const editable=!r.finalized&&!v.session.lockedAt&&(pm||pot);
      const category=talentCategory((r.entry.performance??r.currentPerformance) as PMBand|null,(r.entry.potential??r.currentPotential) as PotentialBand|null);
      const pinsOpen=!groupPerformance&&!r.entry.lockedAt&&!v.session.lockedAt&&!r.finalized&&category!=null&&category!=='PIP/Improvement';
      const ownNomination=r.entry.nominations.find(n=>n.userId===v.actorUserId);
      return <Card id={`${embedded?'assessment-detail':'assessment'}-${r.entry.reviewId}`} key={r.entry.id} className="space-y-4 p-5">
        <h2 className="font-semibold">{r.name} · {r.grade}</h2>
        {!embedded&&axes.pm&&<PerformanceInsight reviewId={r.entry.reviewId} contextId={sessionId}/>}{!embedded&&axes.pot&&<PotentialInsight reviewId={r.entry.reviewId} sessionId={sessionId}/>}{!embedded&&axes.pm&&<WrittenRemarks reviewId={r.entry.reviewId} sessionId={sessionId} axis="pm"/>}{!embedded&&axes.pot&&<WrittenRemarks reviewId={r.entry.reviewId} sessionId={sessionId} axis="pot"/>}
        {v.canReopen&&!r.finalized&&(axes.pm&&(v.session.performanceLockedAt||r.entry.performanceLockedAt)||axes.pot&&(v.session.potentialLockedAt||r.entry.potentialLockedAt))&&<details><summary className="cursor-pointer text-sm font-medium">{t('reopenCalibration')}</summary><AssessmentMutationForm action={onehrCalibrationAction} className="mt-3 space-y-3">{fields}<input type="hidden" name="action" value="unlock"/><input type="hidden" name="reviewId" value={r.entry.reviewId}/>{axisSelect(axes.pm&&!!(v.session.performanceLockedAt||r.entry.performanceLockedAt),axes.pot&&!!(v.session.potentialLockedAt||r.entry.potentialLockedAt))}<p className="text-sm text-muted-foreground">{t('reopenCalibrationHelp')}</p><Field label={t('reason')}><textarea aria-label={t('reason')} required name="reason" maxLength={4000} className={inputCls}/></Field><ConfirmSubmit description={t('reopenCalibrationHelp')} variant="secondary">{t('reopenCalibration')}</ConfirmSubmit></AssessmentMutationForm></details>}
        <p className="text-sm">{axes.pm&&<>{t('managerAssessment')}: {r.managerPerformance??'—'}</>}{axes.pm&&axes.pot&&' · '}{axes.pot&&<>{t('managerPotential')}: {r.managerPotential??'—'}</>}</p>
        <p className="text-sm">{t('effectiveAssessment')}: {axes.pm&&<>{r.currentPerformance??'—'}</>}{axes.pm&&axes.pot&&' · '}{axes.pot&&<>{r.currentPotential??'—'}</>}</p>
        {pinsOpen&&['bu','bg','group','final'].includes(v.session.tier)&&<AssessmentMutationForm action={onehrCalibrationAction} className="flex flex-wrap items-end gap-3">{fields}<input type="hidden" name="action" value="talent-save"/><input type="hidden" name="kind" value="specialReward"/><input type="hidden" name="talentRevision" value={r.talent.revision}/><input type="hidden" name="reviewId" value={r.entry.reviewId}/><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="selected" defaultChecked={r.entry.specialReward}/>{t('specialReward')}</label><Field label={t('reason')}><textarea aria-label={t('reason')} name="reason" defaultValue={r.entry.specialRewardReason} maxLength={2000} className={inputCls}/></Field><Button type="submit" variant="secondary">{t('save')}</Button></AssessmentMutationForm>}
        {pinsOpen&&v.session.tier==='bg'&&<AssessmentMutationForm action={onehrCalibrationAction} className="grid gap-3 rounded-md border border-border p-4 sm:grid-cols-2">
          {fields}<input type="hidden" name="action" value="talent-save"/><input type="hidden" name="kind" value="nomination"/><input type="hidden" name="reviewId" value={r.entry.reviewId}/><input type="hidden" name="talentRevision" value={r.talent.revision}/>
          <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="selected" defaultChecked={!!ownNomination}/>{t('nominatePromotion')}</label>
          <Field label={t('proposedGrade')}><input name="grade" maxLength={20} defaultValue={ownNomination?.grade} className={inputCls}/></Field>
          <Field label={t('proposedTitle')}><input name="title" maxLength={120} defaultValue={ownNomination?.title} className={inputCls}/></Field>
          <Field label={t('reason')}><textarea aria-label={t('reason')} name="reason" maxLength={2000} defaultValue={ownNomination?.reason} className={inputCls}/></Field>
          <div className="flex items-end justify-end"><Button type="submit" variant="secondary">{t('save')}</Button></div>
        </AssessmentMutationForm>}
        {!editable?<p>{t(r.finalized||r.entry.lockedAt||axes.pm&&(r.entry.performanceLockedAt||v.session.performanceLockedAt)||axes.pot&&(r.entry.potentialLockedAt||v.session.potentialLockedAt)?'locked':'calibrationRoster.readOnly')}{axes.pm&&<> · {r.entry.performance??'—'}</>}{axes.pot&&<> · {r.entry.potential??'—'}</>}</p>:<>
          <CalibrationBandForm action={onehrCalibrationAction} preserveView={embedded&&axis==='both'&&v.session.tier==='bg'} className="space-y-4">{fields}
            <input type="hidden" name="action" value="save"/><input type="hidden" name="reviewId" value={r.entry.reviewId}/>
            {axisSelect(pm,pot)}
            <div className="grid gap-4 sm:grid-cols-2">
              {pm&&<><Field label={t('performance')}><select aria-label={t('performance')} name="performance" defaultValue={heldPm?.band??r.entry.performance??''} className={inputCls}><option value="">{t('keepPrevious')}</option>{pmBands.map(b=><option key={b}>{b}</option>)}</select></Field><Field label={t('performanceReason')}><textarea aria-label={t('performanceReason')} name="performanceNote" maxLength={4000} defaultValue={heldPm?.reason??r.entry.performanceNote} className={inputCls}/></Field></>}
              {pot&&<><Field label={t('potential')}><select aria-label={t('potential')} name="potential" defaultValue={heldPot?.band??r.entry.potential??''} className={inputCls}><option value="">{t('keepPrevious')}</option>{potentialBands.map(b=><option key={b}>{b}</option>)}</select></Field><Field label={t('potentialReason')}><textarea aria-label={t('potentialReason')} name="potentialNote" maxLength={4000} defaultValue={heldPot?.reason??r.entry.potentialNote} className={inputCls}/></Field></>}
            </div>

            {v.session.tier==='hod'?<ConfirmSubmit description={t('confirmAssessment')}>{t('save')}</ConfirmSubmit>:<Button type="submit">{v.session.tier==='final'?t('confirmAssessment'):t('save')}</Button>}
          </CalibrationBandForm>
          {v.session.tier==='group'&&<AssessmentMutationForm action={onehrCalibrationAction} className="space-y-3">{fields}<input type="hidden" name="action" value="lock"/><input type="hidden" name="reviewId" value={r.entry.reviewId}/>{axisSelect(pm,pot)}<ConfirmSubmit description={t('calibrationRoster.lockPersonConfirm',{name:r.name})} variant="secondary">{t('lockPerson')}</ConfirmSubmit></AssessmentMutationForm>}
        </>}
      </Card>;

}
