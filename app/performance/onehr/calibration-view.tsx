import {AssessmentMutationForm} from './mutation-form';
import { WrittenRemarks } from './written-remarks';
import { PotentialInsight } from './potential-insight';
import { GroupCalibration } from './group-calibration';
import { CalibrationBandForm } from './calibration-band-form';
import { CalibrationRoster } from './calibration-roster';
import { PerformanceInsight } from './performance-insight';
import { getTranslations } from 'next-intl/server';
import type { getOnehrCalibration } from '@/packs/performance/service';
import { pmBands, potentialBands, potentialReferenceCurve, talentCategory, type PMBand, type PotentialBand } from '@/packs/performance/onehr/model';
import { Button, Card, ErrorBanner, Field, PageHeader, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { onehrCalibrationAction } from '../onehr-actions';
import type { WorkspaceAxis } from '@/packs/performance/onehr/workspace-model';
import { TalentGrid } from './talent-grid';
export async function AssessmentCalibrationView({v,error,embedded=false,returnTo,axis='both'}:{v:Awaited<ReturnType<typeof getOnehrCalibration>>;error?:string;embedded?:boolean;returnTo?:string;axis?:WorkspaceAxis}){
  const sessionId=v.session.id,t=await getTranslations('onehr');
  const fields=<><input type="hidden" name="sessionId" value={sessionId}/><input type="hidden" name="revision" value={v.session.revision}/>{returnTo&&<input type="hidden" name="returnTo" value={returnTo}/>}</>;
  const axisSelect=(pm:boolean,pot:boolean)=>embedded?<input type="hidden" name="axis" value={pm&&pot?'both':pm?'performance':'potential'}/>:<Field label={t('assessmentAxis')}><select aria-label={t('assessmentAxis')} name="axis" defaultValue={pm&&pot?'both':pm?'performance':'potential'} className={inputCls}>{pm&&pot&&<option value="both">{t('bothAxes')}</option>}{pm&&<option value="performance">{t('performance')}</option>}{pot&&<option value="potential">{t('potential')}</option>}</select></Field>;
  const groupPerformance=embedded&&v.session.tier==='group';
  const axes={pm:v.axes.pm&&axis!=='potential',pot:v.axes.pot&&axis!=='performance'};
  const pmOpen=axes.pm&&!v.session.performanceLockedAt,potOpen=axes.pot&&!groupPerformance&&!v.session.potentialLockedAt;
  const pmSubmit=pmOpen&&v.canSubmit?.pm!==false,potSubmit=potOpen&&v.canSubmit?.pot!==false;
  const held=v.held?.[axis]??{lines:[],focus:null,requestId:null};
  const personCards=v.rows.map(r=>{
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
    });
  return <div className={embedded?"space-y-5":"mx-auto max-w-5xl space-y-5"}>
    {!embedded&&<PageHeader back={{href:'/me/performance',label:t('back')}} title={`${v.session.name} · ${v.cycle.name}`} description={t(`tiers.${v.session.tier}`)}/>}
    <ErrorBanner message={error}/>{!(embedded&&['bg','group'].includes(v.session.tier))&&<p className={embedded?'px-5 pt-3 text-sm text-muted-foreground':'text-sm text-muted-foreground'}>{t(embedded&&v.session.tier==='hod'?'calibrationRoster.departmentHelp':'calibrationHelp')}</p>}
    {!embedded&&axes.pm&&v.reference&&<Card className="space-y-2 p-5"><h2 className="font-semibold">{t('referenceCurve')}</h2><div className="flex flex-wrap gap-5">{pmBands.map(b=><p key={b}>{b}: {v.reference![b]}%</p>)}</div></Card>}
    {!embedded&&axes.pot&&!groupPerformance&&<Card className="space-y-2 p-5"><h2 className="font-semibold">{t('potentialReference')}</h2><div className="flex flex-wrap gap-5">{potentialBands.map(b=><p key={b}>{b}: {potentialReferenceCurve[b]}%</p>)}</div></Card>}
    {!embedded&&!groupPerformance&&axis==='both'&&v.modules.pm&&v.modules.tm&&<TalentGrid rows={v.rows.map(r=>({id:r.entry.reviewId,name:r.name,performance:(r.entry.performance??r.currentPerformance) as PMBand|null,potential:(r.entry.potential??r.currentPotential) as PotentialBand|null}))} labels={{title:t('talentGrid'),layout:t('gridLayout'),performance:t('performance'),potential:t('potential'),low:t('gridLow'),mid:t('gridMid'),high:t('gridHigh'),unrated:t('gridUnrated')}}/>}
    {groupPerformance?<GroupCalibration sessionId={sessionId} revision={v.session.revision} returnTo={returnTo} mode={v.session.mode} rows={v.rows.map(r=>({id:r.entry.reviewId,name:r.name,grade:r.grade,companyId:r.companyId,company:v.units.find(u=>u.id===r.companyId)?.name??'',department:r.department??'',businessGroupId:r.businessGroupId??'',businessGroup:r.businessGroup??'',manager:r.managerPerformance,bg:r.priorPerformance??r.managerPerformance,mine:r.entry.performance??r.managerPerformance,locked:!!(r.entry.performanceLockedAt||v.session.performanceLockedAt),canWrite:r.canWrite?.pm??!r.finalized}))}/>:embedded?<CalibrationRoster talentInsight={v.session.tier==='bg'&&axes.pm&&axes.pot} key={`${v.actorUserId}.${v.session.id}.${axis}.${held.requestId??'none'}`} sessionId={sessionId} revision={v.session.revision} curves={{policy:v.curvePolicy,units:v.units}} unitActions={v.session.tier==='bg'&&!v.session.lockedAt?v.units.map(unit=>({id:unit.id,node:<AssessmentMutationForm action={onehrCalibrationAction} className="flex items-center gap-2">{fields}<input type="hidden" name="action" value="lock"/><input type="hidden" name="axis" value="both"/><input type="hidden" name="companyId" value={unit.id}/>{unit.locked?<span className="text-xs text-muted-foreground">{t('locked')}</span>:<ConfirmSubmit description={t('calibrationRoster.lockUnitConfirm',{name:unit.name})} variant="secondary">{t('lockBusinessUnit')}</ConfirmSubmit>}</AssessmentMutationForm>})):undefined} initialFocus={held.focus} agree={v.session.tier==='hod'&&axis!=='both'&&!v.session.lockedAt&&!(axis==='performance'?v.session.performanceLockedAt:v.session.potentialLockedAt)?{sessionId,revision:v.session.revision,axis,returnTo,eligibleIds:v.rows.filter(r=>!r.finalized&&(axis==='performance'?r.canAgreePerformance&&(r.canWrite?.pm??true)&&!r.entry.performanceLockedAt:r.canAgreePotential&&(r.canWrite?.pot??true)&&!r.entry.potentialLockedAt)).map(r=>r.entry.reviewId)}:undefined} rows={v.rows.map(r=>({id:r.entry.reviewId,name:r.name,grade:r.grade,companyId:r.companyId,company:v.units.find(u=>u.id===r.companyId)?.name??'',department:r.department??'',fromCategory:r.movement?.fromCategory??null,bandTrails:r.bandTrails,canMove:!r.finalized&&!v.session.lockedAt&&!(r.entry.performanceLockedAt||v.session.performanceLockedAt||r.entry.potentialLockedAt||v.session.potentialLockedAt)&&r.canWrite?.pm!==false&&r.canWrite?.pot!==false,performance:r.entry.performance??r.currentPerformance,potential:r.entry.potential??r.currentPotential,performanceSource:r.entry.performancePinned?r.entry.performancePinSource:r.entry.performance!=null?'reviewer':r.performanceSource,potentialSource:r.entry.potentialPinned?r.entry.potentialPinSource:r.entry.potential!=null?'reviewer':r.potentialSource,readOnly:axis==='performance'?r.canWrite?.pm===false:axis==='potential'?r.canWrite?.pot===false:r.canWrite?.pm===false&&r.canWrite?.pot===false,moved:r.movement?.moved??false,locked:!!(axis==='performance'?r.entry.performanceLockedAt||v.session.performanceLockedAt:axis==='potential'?r.entry.potentialLockedAt||v.session.potentialLockedAt:r.entry.lockedAt||v.session.lockedAt),journey:r.journey??[{tier:'manager',performance:r.managerPerformance,potential:r.managerPotential}],potentialPct:r.potentialPct??null}))} cards={v.rows.map((r,i)=>({id:r.entry.reviewId,content:personCards[i]}))} axes={axes} grid={!groupPerformance&&axis==='both'&&v.modules.pm&&v.modules.tm} reference={v.session.tier==='bu'?(axes.pm?v.reference??{}:potentialReferenceCurve):{}}/>:personCards}
    {v.session.tier==='bg'&&!v.session.lockedAt&&!(embedded&&axis==='both'&&v.modules.pm&&v.modules.tm)&&<section className="space-y-3 p-5"><h2 className="font-semibold">{t('lockBusinessUnits')}</h2>{v.units.map(unit=><AssessmentMutationForm key={unit.id} action={onehrCalibrationAction} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">{fields}<input type="hidden" name="action" value="lock"/><input type="hidden" name="axis" value="both"/><input type="hidden" name="companyId" value={unit.id}/><span className="text-sm">{unit.name}</span>{unit.locked?<span className="text-xs text-muted-foreground">{t('locked')}</span>:<ConfirmSubmit description={t('calibrationRoster.lockUnitConfirm',{name:unit.name})} variant="secondary">{t('lockBusinessUnit')}</ConfirmSubmit>}</AssessmentMutationForm>)}</section>}
    {!groupPerformance&&!(embedded&&v.session.tier==='bg'&&axis==='both'&&v.modules.pm&&v.modules.tm)&&v.canLockCohort!==false&&!v.session.lockedAt&&(pmSubmit||potSubmit)&&<Card className="p-5"><AssessmentMutationForm action={onehrCalibrationAction} className="space-y-4">{fields}<input type="hidden" name="action" value="lock"/>{axisSelect(pmSubmit,potSubmit)}{v.session.tier==='bu'&&<Field label={t('overrideReason')}><textarea aria-label={t('overrideReason')} name="reason" maxLength={4000} className={inputCls}/></Field>}<ConfirmSubmit description={t(v.session.tier==='hod'?'calibrationRoster.submitConfirm':'lockConfirm')} variant="secondary">{t(v.session.tier==='hod'?'calibrationRoster.submitDepartment':'lockCalibration')}</ConfirmSubmit></AssessmentMutationForm></Card>}
    {!groupPerformance&&['bg','group','final'].includes(v.session.tier)&&v.session.lockedAt&&<section className="space-y-5 border-t border-border p-5">
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
            {candidates.map(r=><AssessmentMutationForm action={onehrCalibrationAction} key={r.entry.id} className="space-y-3 rounded-lg border border-border p-4">
              {fields}<input type="hidden" name="action" value="talent-save"/><input type="hidden" name="kind" value={kind}/><input type="hidden" name="reviewId" value={r.entry.reviewId}/><input type="hidden" name="talentRevision" value={r.talent.revision}/>
              <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="selected" defaultChecked={r.entry[kind]} disabled={!!locked||r.finalized}/>{r.name}</label>
              {kind==='promotion'&&<>
                <p className="text-sm text-muted-foreground">{r.entry.nominations.length?t('nominationCount',{count:r.entry.nominations.length}):r.talent.standingReason}</p>
                {r.entry.nominations.map(n=><p key={n.userId} className="text-sm">{[n.grade,n.title,n.reason].filter(Boolean).join(' · ')}</p>)}
                <div className="grid gap-3 sm:grid-cols-2"><Field label={t('confirmedGrade')}><input name="grade" maxLength={20} defaultValue={r.entry.confirmedGrade} disabled={!!locked||r.finalized} className={inputCls}/></Field><Field label={t('confirmedTitle')}><input name="title" maxLength={120} defaultValue={r.entry.confirmedTitle} disabled={!!locked||r.finalized} className={inputCls}/></Field></div>
              </>}
              <Field label={t('reason')}><textarea aria-label={t('reason')} name="reason" defaultValue={kind==='pip'?r.entry.pipReason:r.entry.promotionReason} maxLength={2000} disabled={!!locked||r.finalized} className={inputCls}/></Field>
              {!locked&&!r.finalized&&<div className="flex justify-end"><Button type="submit" variant="secondary">{t('save')}</Button></div>}
            </AssessmentMutationForm>)}
          </>}
          {!waiting&&v.canLockCohort&&!v.rows.some(r=>r.finalized)&&<AssessmentMutationForm action={onehrCalibrationAction} className="space-y-3">
            {fields}<input type="hidden" name="kind" value={kind}/><input type="hidden" name="action" value={locked?'talent-reopen':'talent-lock'}/>
            <div className="flex justify-end"><ConfirmSubmit description={t('talentListHelp')} variant="secondary">{locked?t('reopenList'):t('confirmList')}</ConfirmSubmit></div>
          </AssessmentMutationForm>}
        </section>;
      })}
    </section>}
  </div>;
}
