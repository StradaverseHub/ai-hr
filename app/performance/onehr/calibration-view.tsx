import {AssessmentMutationForm} from './mutation-form';
import { CalibrationPersonCard } from './calibration-person-detail';
import { GroupCalibration } from './group-calibration';
import { CalibrationRoster,type CalibrationBoard,type CalibrationRosterRow } from './calibration-roster';
import { TalentBoard } from './talent-board';
import { getTranslations } from 'next-intl/server';
import type { getOnehrCalibration } from '@/packs/performance/service';
import { pmBands, potentialBands, potentialReferenceCurve, talentCategory, type PMBand, type PotentialBand } from '@/packs/performance/onehr/model';
import { Button, Card, ErrorBanner, Field, PageHeader, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { onehrCalibrationAction } from '../onehr-actions';
import type { WorkspaceAxis } from '@/packs/performance/onehr/workspace-model';
/**
 * `standalone` is the Talent Box route (/performance/calibration/talent-box): the embedded board and person panel,
 * without the workspace help line, and with the whole-scope lock in the board's bar at BG as well as BU and Group
 * (the same lock the session page offers there; a selected business unit still shows its own lock).
 */
export async function AssessmentCalibrationView({v,error,embedded=false,standalone=false,returnTo,axis='both'}:{v:Awaited<ReturnType<typeof getOnehrCalibration>>;error?:string;embedded?:boolean;standalone?:boolean;returnTo?:string;axis?:WorkspaceAxis}){
  const sessionId=v.session.id,t=await getTranslations('onehr');
  const fields=<><input type="hidden" name="sessionId" value={sessionId}/><input type="hidden" name="revision" value={v.session.revision}/>{returnTo&&<input type="hidden" name="returnTo" value={returnTo}/>}</>;
  const axisSelect=(pm:boolean,pot:boolean)=>embedded?<input type="hidden" name="axis" value={pm&&pot?'both':pm?'performance':'potential'}/>:<Field label={t('assessmentAxis')}><select aria-label={t('assessmentAxis')} name="axis" defaultValue={pm&&pot?'both':pm?'performance':'potential'} className={inputCls}>{pm&&pot&&<option value="both">{t('bothAxes')}</option>}{pm&&<option value="performance">{t('performance')}</option>}{pot&&<option value="potential">{t('potential')}</option>}</select></Field>;
  // The Group PM table is the performance-only part; a Group part over both axes is the Group Talent Box (OneHR C10).
  const groupPerformance=embedded&&v.session.tier==='group'&&axis==='performance';
  const axes={pm:v.axes.pm&&axis!=='potential',pot:v.axes.pot&&axis!=='performance'};
  const pmOpen=axes.pm&&!v.session.performanceLockedAt,potOpen=axes.pot&&!v.session.potentialLockedAt;
  const pmSubmit=pmOpen&&v.canSubmit?.pm!==false,potSubmit=potOpen&&v.canSubmit?.pot!==false;
  const held=v.held?.[axis]??{lines:[],focus:null,requestId:null,navigation:false};
  // The board replaces the count grid wherever it showed: both axes calibrated, PM and TM both on (no PM-only box, C1).
  const boxOn=!groupPerformance&&axis==='both'&&v.modules.pm&&v.modules.tm;
  const lockable=!groupPerformance&&v.canLockCohort!==false&&!v.session.lockedAt&&(pmSubmit||potSubmit);
  const lockForm=<AssessmentMutationForm action={onehrCalibrationAction} className="flex flex-wrap items-end gap-2">{fields}<input type="hidden" name="action" value="lock"/>{axisSelect(pmSubmit,potSubmit)}{v.session.tier==='bu'&&<label className="text-xs font-medium">{t('overrideReason')}<input aria-label={t('overrideReason')} name="reason" maxLength={4000} className={`${inputCls} mt-1`}/></label>}<ConfirmSubmit description={t(v.session.tier==='hod'?'calibrationRoster.submitConfirm':'lockConfirm')}>{t(v.session.tier==='hod'?'calibrationRoster.submitDepartment':'lockCalibration')}</ConfirmSubmit></AssessmentMutationForm>;
  const unitLock=(unit:{id:string;name:string;locked:boolean})=><AssessmentMutationForm action={onehrCalibrationAction} className="flex items-center gap-2">{fields}<input type="hidden" name="action" value="lock"/><input type="hidden" name="axis" value="both"/><input type="hidden" name="companyId" value={unit.id}/>{unit.locked?<span className="text-xs text-muted-foreground">{t('locked')}</span>:<ConfirmSubmit description={t('calibrationRoster.lockUnitConfirm',{name:unit.name})} variant="secondary">{t('lockBusinessUnit')}</ConfirmSubmit>}</AssessmentMutationForm>;
  // Named reviewer or live seat holder, decided in SQL (app.onehr_calibration_reviewer, WP-B2).
  const reviewer=!!v.isReviewer;
  const board:CalibrationBoard|undefined=boxOn?{grid:v.talentBox?.grid??9,scope:{name:v.session.name,cycle:v.cycle.name},tier:v.session.tier,locked:!!v.session.lockedAt,showUnits:['bg','group','final'].includes(v.session.tier),
   // A Group or final scope spans business groups with different profit figures: no single reference, as in the source.
   reference:['group','final'].includes(v.session.tier)?null:v.reference,unitReferences:v.session.tier==='bg'?Object.fromEntries(v.units.map(u=>[u.id,u.profit.reference])):undefined,
   cap:v.talentBox?.cap??null,movable:['bu','bg','group'].includes(v.session.tier)&&reviewer,footer:lockable&&!(embedded&&!standalone&&v.session.tier==='bg')?lockForm:undefined}:undefined;
  const rosterRows:CalibrationRosterRow[]=v.rows.map(r=>({id:r.entry.reviewId,name:r.name,grade:r.grade,companyId:r.companyId,company:v.units.find(u=>u.id===r.companyId)?.name??'',department:r.department??'',fromCategory:r.movement?.fromCategory??null,from:r.movement?.from??null,bandTrails:r.bandTrails,canMove:!r.finalized&&!v.session.lockedAt&&!(r.entry.performanceLockedAt||v.session.performanceLockedAt||r.entry.potentialLockedAt||v.session.potentialLockedAt)&&r.canWrite?.pm!==false&&r.canWrite?.pot!==false,performance:(r.entry.performance??r.currentPerformance) as PMBand|null,potential:(r.entry.potential??r.currentPotential) as PotentialBand|null,performanceSource:r.entry.performancePinned?r.entry.performancePinSource:r.entry.performance!=null?'reviewer':r.performanceSource,potentialSource:r.entry.potentialPinned?r.entry.potentialPinSource:r.entry.potential!=null?'reviewer':r.potentialSource,readOnly:axis==='performance'?r.canWrite?.pm===false:axis==='potential'?r.canWrite?.pot===false:r.canWrite?.pm===false&&r.canWrite?.pot===false,moved:r.movement?.moved??false,locked:!!(axis==='performance'?r.entry.performanceLockedAt||v.session.performanceLockedAt:axis==='potential'?r.entry.potentialLockedAt||v.session.potentialLockedAt:r.entry.lockedAt||v.session.lockedAt),journey:r.journey??[{tier:'manager',performance:r.managerPerformance,potential:r.managerPotential}],potentialPct:r.potentialPct??null}));
  return <div className={embedded?"space-y-5":"mx-auto max-w-5xl space-y-5"}>
    {!embedded&&<PageHeader back={{href:'/me/performance',label:t('back')}} title={`${v.session.name} · ${v.cycle.name}`} description={t(`tiers.${v.session.tier}`)}/>}
    <ErrorBanner message={error}/>{!standalone&&!(embedded&&['bg','group'].includes(v.session.tier))&&<p className={embedded?'px-5 pt-3 text-sm text-muted-foreground':'text-sm text-muted-foreground'}>{t(embedded&&v.session.tier==='hod'?'calibrationRoster.departmentHelp':'calibrationHelp')}</p>}
    {!embedded&&axes.pm&&v.reference&&<Card className="space-y-2 p-5"><h2 className="font-semibold">{t('referenceCurve')}</h2><div className="flex flex-wrap gap-5">{pmBands.map(b=><p key={b}>{b}: {v.reference![b]}%</p>)}</div></Card>}
    {!embedded&&axes.pot&&!groupPerformance&&<Card className="space-y-2 p-5"><h2 className="font-semibold">{t('potentialReference')}</h2><div className="flex flex-wrap gap-5">{potentialBands.map(b=><p key={b}>{b}: {potentialReferenceCurve[b]}%</p>)}</div></Card>}
    {!embedded&&board&&<Card className="overflow-hidden p-0"><TalentBoard rows={rosterRows} sessionId={sessionId} revision={v.session.revision} grid={board.grid} scope={board.scope} tier={board.tier} locked={board.locked} units={v.units.map(u=>({id:u.id,name:u.name}))} showUnits={board.showUnits} reference={board.reference} unitReferences={board.unitReferences} cap={board.cap} movable={board.movable} footer={board.footer} unitFooters={v.session.tier==='bg'&&!v.session.lockedAt?Object.fromEntries(v.units.map(unit=>[unit.id,unitLock(unit)])):undefined}/></Card>}
    {groupPerformance?<GroupCalibration sessionId={sessionId} revision={v.session.revision} returnTo={returnTo} mode={v.session.mode} rows={v.rows.map(r=>({id:r.entry.reviewId,name:r.name,grade:r.grade,companyId:r.companyId,company:v.units.find(u=>u.id===r.companyId)?.name??'',department:r.department??'',businessGroupId:r.businessGroupId??'',businessGroup:r.businessGroup??'',manager:r.managerPerformance,bg:r.priorPerformance??r.managerPerformance,mine:r.entry.performance??r.managerPerformance,locked:!!(r.entry.performanceLockedAt||v.session.performanceLockedAt),canWrite:r.canWrite?.pm??!r.finalized}))}/>:embedded?<CalibrationRoster fitAxes={{pm:v.rows.some(r=>r.canWrite.pm),pot:v.rows.some(r=>r.canWrite.pot)}} allowFit={['bu','bg'].includes(v.session.tier)} talentInsight={v.session.tier==='bg'&&axes.pm&&axes.pot} key={`${v.actorUserId}.${v.session.id}.${axis}.${held.requestId??'none'}`} sessionId={sessionId} revision={v.session.revision} curves={{policy:v.curvePolicy,units:v.units}} unitActions={v.session.tier==='bg'&&!v.session.lockedAt?v.units.map(unit=>({id:unit.id,node:unitLock(unit)})):undefined} board={board} initialFocus={held.focus} agree={v.session.tier==='hod'&&axis!=='both'&&!v.session.lockedAt&&!(axis==='performance'?v.session.performanceLockedAt:v.session.potentialLockedAt)?{sessionId,revision:v.session.revision,axis,returnTo,eligibleIds:v.rows.filter(r=>!r.finalized&&(axis==='performance'?r.canAgreePerformance&&(r.canWrite?.pm??true)&&!r.entry.performanceLockedAt:r.canAgreePotential&&(r.canWrite?.pot??true)&&!r.entry.potentialLockedAt)).map(r=>r.entry.reviewId)}:undefined} rows={rosterRows} detail={{axis,returnTo}} axes={axes} grid={boxOn} reference={v.session.tier==='bu'?(axes.pm?v.reference??{}:potentialReferenceCurve):{}}/>:v.rows.map(r=>r.talent?<CalibrationPersonCard key={r.entry.id} data={{row:{...r,entry:{...r.entry,...r.talent.actions},talent:r.talent},session:v.session,actorUserId:v.actorUserId,canReopen:v.canReopen,axes:v.axes,held}} axis={axis} returnTo={returnTo}/>:null)}
    {v.session.tier==='bg'&&!v.session.lockedAt&&!boxOn&&<section className="space-y-3 p-5"><h2 className="font-semibold">{t('lockBusinessUnits')}</h2>{v.units.map(unit=><AssessmentMutationForm key={unit.id} action={onehrCalibrationAction} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">{fields}<input type="hidden" name="action" value="lock"/><input type="hidden" name="axis" value="both"/><input type="hidden" name="companyId" value={unit.id}/><span className="text-sm">{unit.name}</span>{unit.locked?<span className="text-xs text-muted-foreground">{t('locked')}</span>:<ConfirmSubmit description={t('calibrationRoster.lockUnitConfirm',{name:unit.name})} variant="secondary">{t('lockBusinessUnit')}</ConfirmSubmit>}</AssessmentMutationForm>)}</section>}
    {!boxOn&&lockable&&<Card className="p-5"><AssessmentMutationForm action={onehrCalibrationAction} className="space-y-4">{fields}<input type="hidden" name="action" value="lock"/>{axisSelect(pmSubmit,potSubmit)}{v.session.tier==='bu'&&<Field label={t('overrideReason')}><textarea aria-label={t('overrideReason')} name="reason" maxLength={4000} className={inputCls}/></Field>}<ConfirmSubmit description={t(v.session.tier==='hod'?'calibrationRoster.submitConfirm':'lockConfirm')} variant="secondary">{t(v.session.tier==='hod'?'calibrationRoster.submitDepartment':'lockCalibration')}</ConfirmSubmit></AssessmentMutationForm></Card>}
    {!groupPerformance&&['bg','group','final'].includes(v.session.tier)&&v.session.lockedAt&&<section className="space-y-5 border-t border-border p-5">
      <p className="text-sm text-muted-foreground">{t('talentListHelp')}</p>
      {(['pip','promotion'] as const).map(kind=>{
        const locked=kind==='pip'?v.session.pipLockedAt:v.session.promotionLockedAt;
        const waiting=embedded&&kind==='promotion'&&!v.session.pipLockedAt;
        const candidates=v.rows.filter(r=>kind==='promotion'?r.talent?.promotionEligible:talentCategory((r.entry.performance??r.currentPerformance) as PMBand|null,(r.entry.potential??r.currentPotential) as PotentialBand|null)==='PIP/Improvement');
        const selected=candidates.filter(r=>r.entry[kind]).length;
        return <section key={kind} className="space-y-3">
          <h2 className="font-semibold">{t(kind)} {locked&&<span className="text-xs text-muted-foreground">· {t('confirmed')}</span>}</h2>
          {waiting?<p className="text-sm text-muted-foreground">{t('promotionWaiting')}</p>:<>
            <p className="text-sm text-muted-foreground">{t('talentSelectionCount',{selected,total:v.rows.length,percent:v.rows.length?Math.round(selected/v.rows.length*1000)/10:0})}</p>
            {!candidates.length&&<p className="text-sm">{t('noTalentCandidates')}</p>}
            {candidates.map(r=><AssessmentMutationForm action={onehrCalibrationAction} key={r.entry.id} className="space-y-3 rounded-lg border border-border p-4">
              {fields}<input type="hidden" name="action" value="talent-save"/><input type="hidden" name="kind" value={kind}/><input type="hidden" name="reviewId" value={r.entry.reviewId}/><input type="hidden" name="talentRevision" value={r.talent?.revision}/>
              <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="selected" defaultChecked={r.entry[kind]} disabled={!!locked||r.finalized}/>{r.name}</label>
              {kind==='promotion'&&<>
                <p className="text-sm text-muted-foreground">{(r.talent?.actions.nominations??[]).length?t('nominationCount',{count:(r.talent?.actions.nominations??[]).length}):r.talent?.standingReason}</p>
                {(r.talent?.actions.nominations??[]).map(n=><p key={n.userId} className="text-sm">{[n.grade,n.title,n.reason].filter(Boolean).join(' · ')}</p>)}
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
