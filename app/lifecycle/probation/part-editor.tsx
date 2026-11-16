'use client';
import { ActionButton } from '@/components/ui/action-button';
import Link from 'next/link';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Plus,ArrowLeft} from 'lucide-react';
import type {ProbationCaseView,ProbationPartView,ProbationPart} from '@/packs/probation/service';
import type {Assessment} from '@/lib/probation-model';
import {scoreProbationForm} from '@/lib/probation-form';
import {coveredRoleKeys} from './signing-role-labels';
import {pendingSigningSteps,signingSendBack,signingStepAction} from '@/lib/document-signing-model';
import {SignatureInput,type SignatureInputLabels} from '@/components/lifecycle-v9/signature-input';
import {SignerControls} from './signer-controls';
import {EvidenceUpload} from './evidence-upload';
import {ProbationFacts} from './facts';
import {DraftGuard} from './draft-guard';
import {saveDraft,performReview,adjudicateOfflineFinal} from './actions';
import {OfflineFinalProposal} from './intake/offline-final-proposal';
import {probationDate,probationTimestamp} from '@/lib/probation-display';
import {CriteriaGrid,GuideDrawer,ScoreTiles,type ProbationGuideTarget} from './case-review-grid';
import {probationPartDone,probationPartWaiting} from './case-stage';
import {useProbationWaitingLabel} from './case-labels';

/**
 * One review part (lane M2; prototype Part1Tab and ReviewTab). Part 1: A. KPIs table, B. planned support, C. meeting
 * acknowledgement. Parts 2 and 3: review date, the A/B criteria grid with both raters' columns, C. result tiles beside the
 * outcome choice, D. comments; then signatures, the signing panel and the bottom action bar. Every save and command goes
 * through the same server actions as before, which authorize and validate; the screen only lays them out.
 * `embedded`: inside the case view's part tab, whose header already shows the facts, notices and the parts stepper.
 */
export function PartEditor({view,part,actor,signerCandidates,embedded=false}:{view:ProbationCaseView;part:ProbationPartView;actor:{id:string;name:string};signerCandidates?:{id:string;name:string}[];embedded?:boolean}){
 const t=useTranslations('probation'),s=useTranslations('documentSigning'),f=useTranslations('probation.caseView.form'),c=useTranslations('probation.caseView'),router=useRouter(),waitingLabel=useProbationWaitingLabel(view);
 const [draft,setDraft]=useState<ProbationPart>(()=>structuredClone(part)),[dirty,setDirty]=useState(false),[busy,start]=useTransition(),[error,setError]=useState(''),[saved,setSaved]=useState(false),[reason,setReason]=useState(''),[owner,setOwner]=useState<'employee'|'lm'>('lm'),[confirmedMonths,setConfirmedMonths]=useState<number|null>(part.extensionMonths);
 const [comment,setComment]=useState(''),[guide,setGuide]=useState<ProbationGuideTarget|null>(null);
 const [signerDirty,setSignerDirty]=useState(false),[evidenceDirty,setEvidenceDirty]=useState(false),[paperDirty,setPaperDirty]=useState(false);
 const [rater,setRater]=useState<'employee'|'lm'>(part.canEditManager||!part.canEditEmployee&&view.roles.includes('lm')?'lm':'employee');
 const editable=rater==='lm'?part.canEditManager:part.canEditEmployee;
 const kpiEditable=rater==='lm'&&part.canEditManager;
 const selfEditable=part.canEditEmployee&&part.canEditSelfAssessment&&!part.staffSubmittedAt;
 const mode=rater==='employee'&&selfEditable?'self':rater==='lm'&&part.canEditManager?'lm':'view';
 const showEmployee=mode==='self'||part.selfVisible,showManager=mode==='lm'||part.managerVisible;
 const lockedKpis=view.parts.find(p=>p.type===1&&p.acknowledgedAt);
 const score=scoreProbationForm(view.form,draft.manager),suggestion=score?(part.type===2?(score.band>=3?'satisfactory':score.band===2?'development':'at_risk'):(score.band>=3?'confirm':score.band===2?'extend':'not_confirm')):null;
 const pending=part.signing?pendingSigningSteps({...part.signing.document,route:part.route}):[],step=pending.find(p=>p.holderId===actor.id);
 const managerCanStart=!part.signing&&part.canEditManager;
 const signatureCandidate=step?(step.role==='lm'?'submit_manager':step.role==='employee'?'acknowledge':'approve'):managerCanStart?'submit_manager':null;
 const allowedCandidate=signatureCandidate&&part.allowedCommands.includes(signatureCandidate)?signatureCandidate:null;
 // 5756: a Review step and an Approve step without a signature record a decision; every other step signs.
 const decision=allowedCandidate==='approve'&&step&&part.signing?signingStepAction(part.signing.document,step):'signed';
 const signatureCommand=decision==='signed'?allowedCandidate:null,decisionCommand=decision!=='signed'?allowedCandidate:null;
 const roleLabel=(p:{role:string;label?:string})=>p.label??(t.has('roles.'+p.role)?t('roles.'+p.role):/^(routing:|group:)/.test(p.role)?t('roles.approver'):p.role);
 const missingAckComments=signatureCommand==='acknowledge'&&part.type!==1&&view.form.employeeCommentsRequired&&!part.employeeComments.trim();
 const issueLabel=(issue:string)=>{const[criterion,rawKind]=issue.split(':');const kind=rawKind==='evidence_required'?'evidence':rawKind==='invalid_rating'?'unrated':rawKind;const field=view.form.criteria.find(c=>c.id===criterion);return field&&['unrated','evidence'].includes(kind)?field.title+': '+t('issues.'+kind):t.has('issues.'+issue)?t('issues.'+issue):issue.replace(/_/g,' ');};
 const paperOnly=part.state==='completed_offline'&&!part.staffSubmittedAt&&!part.managerSubmittedAt,paper=part.offlineDecision,paperFile=view.files.find(file=>file.id===(paper?.fileId??part.offlinePdfId));
 const controls=part.allowedCommands.filter(command=>!['submit_employee','submit_manager','acknowledge','approve','return'].includes(command));
 const issues=rater==='lm'?part.managerIssues:part.employeeIssues;
 const labels=Object.fromEntries(['title','method','typed','drawn','fullName','canvas','clear','consent','submit'].map(key=>[key,s(key)])) as SignatureInputLabels;
 const coveredRoles=step?coveredRoleKeys(part.route,step):[];
 if(coveredRoles.length>1) labels.consent=t('signing.combinedConsent',{roles:coveredRoles.map(role=>t.has('roles.'+role)?t('roles.'+role):role).join(', ')});
 const blocked=busy||signerDirty||evidenceDirty;
 const update=(patch:Partial<ProbationPart>)=>{setDraft(v=>({...v,...patch}));setDirty(true);setSaved(false);};
 const rate=(criterion:string,patch:{rating?:number|null;evidence?:string})=>{
  const current:Assessment=mode==='self'?draft.employee:draft.manager,item=current[criterion]??{rating:null,evidence:''},next:Assessment={...current,[criterion]:{...item,...patch}};
  update(mode==='self'?{employee:next}:{manager:next});
 };
 const run=(command:Parameters<typeof performReview>[0]['command'],extra:Partial<Parameters<typeof performReview>[0]>={})=>{
  setError('');start(async()=>{const result=await performReview({caseId:view.record.id,partId:part.id,revision:part.storageRevision,command,reason,...extra});if(!result.ok){setError(result.detail??t('errors.unavailable'));return;}setDirty(false);setReason('');router.refresh();});
 };
 const save=()=>{
  const patch:Partial<ProbationPart>=rater==='employee'?{...(part.canEditSelfAssessment&&!part.staffSubmittedAt?{employee:draft.employee}:{}),...(part.canEditEmployeeComments?{employeeComments:draft.employeeComments}:{})}:part.type===1?{kpis:draft.kpis,support:draft.support}:{manager:draft.manager,reviewOn:draft.reviewOn,conductedBy:actor.id,strengths:draft.strengths,development:draft.development,managerComments:draft.managerComments,outcome:draft.outcome,midpointStatus:draft.midpointStatus,justification:draft.justification,extensionMonths:draft.extensionMonths};
  setError('');start(async()=>{const result=await saveDraft({caseId:view.record.id,partId:part.id,revision:part.storageRevision,rater,patch});if(!result.ok){setError(result.detail??t('errors.unavailable'));return;}setDirty(false);setSaved(true);router.refresh();});
 };
 const partName=part.cycle>1&&part.type===3?f('cycle',{part:c('stage.3'),count:part.cycle-1}):c('stage.'+part.type);
 const sendBack=part.state==='returned'&&part.signing?signingSendBack(part.signing.document):null;
 const signedAction=(stepId:string)=>part.signing?.document.actions.find(a=>(a.stepId===stepId||a.coveredStepIds?.includes(stepId))&&a.contentRevision===part.signing!.document.contentRevision&&a.contentHash===part.signing!.document.contentHash&&['signed','declined','reviewed','approved'].includes(a.action));
 const conductedBy=signedAction('lm')?.actorName??(part.conductedBy?view.holderNames[part.conductedBy]:null)??(view.roles.includes('lm')?actor.name:'—');
 const scheduled=part.state==='not_issued'&&!part.canEditEmployee&&!part.canEditManager;
 const canSave=part.type===1?kpiEditable||rater==='employee'&&part.canEditEmployeeComments:editable;
 const canSubmitSelf=part.allowedCommands.includes('submit_employee')&&rater==='employee';
 // The bottom note (prototype .actions .note and WaitNote): what this viewer is doing, else who the part waits on.
 const waitingFor=probationPartWaiting(view,part),waitingWho=waitingFor&&waitingFor.what!=='opens'?waitingLabel(waitingFor):null;
 const note=canSubmitSelf||mode==='self'?f('notes.self'):part.type===1&&kpiEditable?f('notes.lmKpis'):part.type!==1&&mode==='lm'?f('notes.lm',{name:view.record.facts.employeeName}):signatureCommand==='acknowledge'?f(part.type===1?'notes.ack1':'notes.ack'):decisionCommand?f(decision==='reviewed'?'notes.review':'notes.approve')
  :probationPartDone(part)?f(part.type===1?'notes.locked1':'notes.locked'):waitingWho?f('notes.waiting',{who:waitingWho.who,what:waitingWho.what}):waitingFor?.what==='opens'?c('opens',{date:probationDate(waitingFor.date)}):f('notes.nothing');
 const ackComments=(label:string,required:boolean)=><label className="pcc-field"><span>{label}{required?' *':''}</span><textarea readOnly={!(rater==='employee'&&part.canEditEmployeeComments)} disabled={blocked} placeholder={rater==='employee'&&part.canEditEmployeeComments&&!required?f('optional'):undefined} value={draft.employeeComments} maxLength={10000} onChange={e=>update({employeeComments:e.target.value})}/></label>;
 const narrative=(key:'strengths'|'development'|'managerComments',label:string)=><label className="pcc-field" key={key}><span>{label} *</span><textarea readOnly={mode!=='lm'} disabled={blocked} value={draft[key]} maxLength={10000} onChange={e=>update({[key]:e.target.value})}/></label>;
 const choice=(part.type===2?draft.midpointStatus:draft.outcome)??'';
 const extensionsFull=view.record.extensionCount>=view.record.config.maxExtensions;
 const months=view.record.config.extensionMonths;
 const choices:readonly string[]=part.type===2?['satisfactory','development','at_risk']:['confirm','extend','not_confirm','other'];
 const Root=embedded?'div':'main';
 return <Root className={'pcc'+(embedded?' probation-tabpanel':'')} data-part-type={part.type}><DraftGuard dirty={dirty||signerDirty||evidenceDirty}/>
  {!embedded&&<header className="v9-heading"><div><h1>{t('partTitle',{part:part.type})}</h1><p>{view.record.facts.employeeName} · {view.record.facts.employeeCode??'—'} · {t('cycle',{cycle:part.cycle})}</p></div><Link className="v9-button" href={'/lifecycle/probation/'+view.record.id}><ArrowLeft size={16}/>{t('backCase')}</Link></header>}
  {!embedded&&<section className="pcc-card"><ProbationFacts view={view} part={part}/>{part.submittedFacts&&<p className="pcc-small pcc-muted">{t('assessment.frozenFacts')}</p>}</section>}
  {embedded&&part.submittedFacts&&<details className="pcc-card"><summary className="pcc-small">{t('assessment.frozenFacts')}</summary><ProbationFacts view={view} part={part}/></details>}
  {!embedded&&!view.runtimeEnabled&&<p className="pcc-banner">{t(view.sourceMoved?'sourceMoved':'runtimePaused')}</p>}
  {error&&<div className="pcc-banner pcc-banner-bad" role="alert">{error} <button type="button" className="v9-button" onClick={()=>router.refresh()}>{t('reload')}</button></div>}
  {!embedded&&view.record.facts.gradeId!==view.record.facts.currentGradeId&&<p className="pcc-banner pcc-banner-warn">{t('gradeChanged')}</p>}
  {!embedded&&view.record.planFlag&&<p className="pcc-banner pcc-banner-warn">{t('planFlag')}</p>}
  {part.state==='returned'&&<div className="pcc-banner pcc-banner-warn" role="status">{sendBack?<><b>{f('returnedBy',{name:sendBack.actorName})}</b><span>{sendBack.comment}</span></>:<b>{t('partStates.returned')}</b>}<small>{f('returnedNote')}</small></div>}
  {!paperOnly&&!scheduled&&part.type!==1&&!view.record.kpiAcknowledged&&<p className="pcc-banner pcc-banner-warn">{t('kpiGate.'+view.record.config.kpiGate)}</p>}
  {!embedded&&<nav className="probation-steps" aria-label={t('reviewPlan')}>{view.parts.map(p=><Link key={p.id} href={'/lifecycle/probation/'+view.record.id+'/'+p.id} aria-current={p.id===part.id?'step':undefined}>{t('partTitle',{part:p.type})} · {t('partStates.'+p.state)}</Link>)}</nav>}
  {!paperOnly&&!scheduled&&part.canEditEmployee&&part.canEditManager&&<div className="pcc-chips" role="group" aria-label={t('assessment.owner')}>{(['employee','lm'] as const).map(role=><button className="pcc-chip" aria-pressed={rater===role} key={role} type="button" onClick={()=>{if(dirty&&!window.confirm(t('leaveUnsaved')))return;setDraft(structuredClone(part));setDirty(false);setRater(role);}}>{t('roles.'+role)}</button>)}</div>}

  {!paperOnly&&scheduled&&<section className="pcc-card" aria-labelledby={'pcc-part-'+part.id}><h2 id={'pcc-part-'+part.id}>{partName}</h2>
   <p>{f('scheduled',{opens:probationDate(part.issueOn),lead:view.record.config.issueLeadDays,due:probationDate(part.dueOn)})}</p>
   {part.type!==1&&!view.record.kpiAcknowledged&&view.record.config.kpiGate==='block'&&<p className="pcc-small pcc-muted">{f('gateBlocks')}</p>}
  </section>}

  {!paperOnly&&!scheduled&&part.type===1&&<>
   <section className="pcc-card" aria-labelledby={'pcc-kpis-'+part.id}><div><h2 id={'pcc-kpis-'+part.id}>{f('kpiHeading')}</h2><p className="pcc-sub">{f('kpiSub')}</p></div>
    <div className="pcc-tw"><table className="pcc-table"><thead><tr><th scope="col">{f('kpiCols.no')}</th>{(['accountability','measure','target','targetDate'] as const).map(key=><th scope="col" key={key}>{f('kpiCols.'+key)}</th>)}{kpiEditable&&<th scope="col"><span className="sr-only">{f('kpiRemove')}</span></th>}</tr></thead><tbody>
     {draft.kpis.map((k,index)=><tr key={k.id}><td className="pcc-num">{index+1}</td>
      {kpiEditable?<>{(['accountability','measure','target'] as const).map(key=><td key={key}><input aria-label={f('kpiField',{field:f('kpiCols.'+key),index:index+1})} value={k[key]} maxLength={5000} required disabled={blocked} onChange={e=>update({kpis:draft.kpis.map(item=>item.id===k.id?{...item,[key]:e.target.value}:item)})}/></td>)}
       <td><input type="date" aria-label={f('kpiField',{field:f('kpiCols.targetDate'),index:index+1})} value={k.targetDate} required disabled={blocked} onChange={e=>update({kpis:draft.kpis.map(item=>item.id===k.id?{...item,targetDate:e.target.value}:item)})}/></td>
       <td><button type="button" className="pcc-link" style={{marginInlineStart:0}} aria-label={f('kpiRemoveRow',{index:index+1})} disabled={blocked} onClick={()=>update({kpis:draft.kpis.filter(item=>item.id!==k.id)})}>{f('kpiRemove')}</button></td></>
      :<><td>{k.accountability}</td><td>{k.measure}</td><td>{k.target}</td><td className="pcc-num">{probationDate(k.targetDate)}</td></>}</tr>)}
     {!draft.kpis.length&&<tr><td colSpan={kpiEditable?6:5} className="pcc-muted">{f('kpiEmpty')}</td></tr>}
    </tbody></table></div>
    {kpiEditable&&<div><ActionButton guardNavigation aria-busy={busy} className="v9-button" type="button" disabled={blocked||draft.kpis.length>=5} onClick={()=>update({kpis:[...draft.kpis,{id:crypto.randomUUID(),accountability:'',measure:'',target:'',targetDate:''}]})}><Plus size={16}/>{f('kpiAdd')}</ActionButton></div>}
   </section>
   <section className="pcc-card"><h2>{f('supportHeading')}</h2><div className="pcc-grid2">
    {(['coaching','access','checkins','other'] as const).map(key=><label className="pcc-field" key={key}><span>{f('supportLabels.'+key)} *</span><textarea placeholder={kpiEditable?f('supportPlaceholder'):undefined} value={draft.support[key]} maxLength={5000} readOnly={!kpiEditable} disabled={blocked} onChange={e=>update({support:{...draft.support,[key]:e.target.value}})}/></label>)}
   </div></section>
   <section className="pcc-card"><h2>{f('meetingHeading')}</h2>
    <div className="pcc-field"><label className="pcc-field"><span>{t('employeeComments')}</span><textarea readOnly={!part.canEditEmployeeComments} disabled={blocked} value={draft.employeeComments} maxLength={10000} onChange={e=>update({employeeComments:e.target.value})}/></label><span className="pcc-hint">{f('meetingHint')}</span></div>
    <p className="pcc-small pcc-muted">{f('meetingNote')}</p>
   </section>
  </>}

  {!paperOnly&&!scheduled&&part.type!==1&&<>
   <section className="pcc-card" aria-labelledby={'pcc-part-'+part.id}>
    <div className="pcc-row pcc-between"><h2 id={'pcc-part-'+part.id}>{partName}</h2><div className="pcc-row">{mode==='self'&&<span className="pcc-pill pcc-pill-info">{f('yourSelf')}</span>}{mode==='lm'&&<span className="pcc-pill pcc-pill-info">{f('yourLm')}</span>}<span className="pcc-pill">{f('status',{state:t('partStates.'+part.state),date:probationDate(part.dueOn)})}</span></div></div>
    {mode!=='self'&&showManager&&<div className="pcc-grid2">
     <label className="pcc-field"><span>{t('reviewDate')}{mode==='lm'?' *':''}</span><input type="date" readOnly={mode!=='lm'} disabled={blocked} value={draft.reviewOn} onChange={e=>update({reviewOn:e.target.value,conductedBy:actor.id})}/></label>
     <label className="pcc-field"><span>{t('conductedBy')}</span><input readOnly value={mode==='lm'?actor.name:conductedBy}/></label>
    </div>}
    <div><h3>{f('sections.'+part.type,{count:view.form.criteria.filter(c=>c.section==='principles').length})}</h3><p className="pcc-sub">{mode==='view'?f('readHelp'):f('rateHelp')}</p></div>
    <CriteriaGrid form={view.form} employee={draft.employee} manager={draft.manager} mode={mode} showEmployee={showEmployee} showManager={showManager} disabled={blocked} kpiEvidence={mode==='lm'&&!view.record.kpiAcknowledged&&view.record.config.kpiGate==='warn'}
     kpiCount={(part.acknowledgedKpis??lockedKpis?.kpis??[]).length} onRate={(criterion,rating)=>rate(criterion,{rating})} onEvidence={(criterion,evidence)=>rate(criterion,{evidence})} onGuide={setGuide}/>
   </section>
   {mode!=='self'&&showManager&&<div className="pcc-grid2">
    <section className="pcc-card"><div><h2>{f('result.'+part.type)}</h2><p className="pcc-sub">{f('resultSub')}</p></div>
     <ScoreTiles form={view.form} manager={draft.manager} employee={part.employee} showEmployee={part.selfVisible&&!!part.staffSubmittedAt} lowBand={view.record.config.lowBand}/>
     <label className="pcc-field"><span>{f('justification.'+part.type)}{part.type===3||!!suggestion&&!!choice&&suggestion!==choice?' *':''}</span><textarea readOnly={mode!=='lm'} disabled={blocked} placeholder={mode==='lm'&&(part.type===3||!!suggestion&&!!choice&&suggestion!==choice)?f('justificationRequired'):undefined} value={draft.justification} maxLength={10000} onChange={e=>update({justification:e.target.value})}/></label>
     {part.type===2&&<p className="pcc-small pcc-muted">{f('noMidpointOutcome')}</p>}
    </section>
    <section className="pcc-card"><fieldset className="pcc-opts" disabled={mode!=='lm'||busy}><legend className="pcc-legend">{f('choice.'+part.type)}</legend>
     {choices.map(value=>{const off=value==='extend'&&extensionsFull;return <label key={value} className="pcc-opt" data-on={choice===value} data-disabled={off&&choice!==value?true:undefined}>
      <input type="radio" name={'pcc-choice-'+part.id} value={value} checked={choice===value} disabled={off&&choice!==value} onChange={()=>update(part.type===2?{midpointStatus:value as ProbationPart['midpointStatus']}:{outcome:value as ProbationPart['outcome']})}/>
      <span>{f('options.'+value)}{value==='extend'&&months.length===2?' · '+f('extendHint',{first:months[0],second:months[1]}):''}{value==='other'?' · '+f('otherHint'):''}</span>
      {suggestion===value&&<span className="pcc-pill pcc-pill-ok">{f('suggested')}</span>}
      {value==='extend'&&extensionsFull&&<span className="pcc-small pcc-muted">{f('extensionsUsed',{count:view.record.extensionCount,max:view.record.config.maxExtensions})}</span>}
     </label>;})}
    </fieldset>
     {part.type===3&&draft.outcome==='extend'&&<label className="pcc-field"><span>{f('extensionLength')} *</span><select value={draft.extensionMonths??''} disabled={mode!=='lm'||busy} onChange={e=>update({extensionMonths:e.target.value?Number(e.target.value):null})}><option value="">{t('choose')}</option>{months.map(n=><option key={n} value={n}>{f('monthsOption',{months:n})}</option>)}</select></label>}
     <p className="pcc-small pcc-muted">{mode==='lm'?f('nothingPreselected')+' ':''}{f('choiceNote')}</p>
     {part.type===2&&narrative('managerComments',f('managerComments'))}
    </section>
   </div>}
   {part.type===2&&(mode!=='self'&&showManager||rater==='employee'&&part.canEditEmployeeComments)&&<section className="pcc-card"><h2>{f('coaching')}</h2>
    {mode!=='self'&&showManager&&<div className="pcc-grid2">{narrative('strengths',f('strengths'))}{narrative('development',f('development'))}</div>}
    {ackComments(f('employeeComments2'),view.form.employeeCommentsRequired)}
   </section>}
   {part.type===3&&(mode!=='self'&&showManager||rater==='employee'&&part.canEditEmployeeComments)&&<section className="pcc-card"><h2>{f('ackHeading')}</h2>
    {ackComments(f('employeeComments3'),view.form.employeeCommentsRequired)}
    <p className="pcc-small pcc-muted">{f('ackNote')}</p>
   </section>}
  </>}

  {!paperOnly&&!scheduled&&<>
   <section className="pcc-card" aria-labelledby={'pcc-sigs-'+part.id}><h3 id={'pcc-sigs-'+part.id}>{f('signatures')}</h3><ol className="pcc-siglist">{part.route.steps.map(p=>{const signed=signedAction(p.id),own=signed&&signed.stepId===p.id?signed:null;return <li key={p.id}>
    <b>{roleLabel(p)}{p.kind==='review'||p.signature===false?' · '+t(p.kind==='review'?'signing.reviewStep':'signing.approveStep'):''}</b>
    {own?.signature?.method==='typed'&&own.signature.value?<span className="pcc-sigtxt">{own.signature.value}</span>:null}
    <span className="pcc-small">{own?own.actorName+' · '+probationTimestamp(own.at):(p.holderId&&view.holderNames[p.holderId]?view.holderNames[p.holderId]+' · ':'')+(signed||p.coveredByStepId?t('signing.combinedHistory'):!p.holderId?t('signing.missing'):t('signing.pending'))}</span>
    <span className="pcc-small pcc-muted">{own?[t('signing.'+own.action),own.signature?f('methods.'+own.signature.method):null,own.comment||null].filter(Boolean).join(' · '):null}{p.representedId&&p.representedId!==p.holderId?(own?' · ':'')+t('signing.onBehalfOf',{name:view.holderNames[p.representedId]??t('signing.missing')}):''}</span>
    {p.meantFor&&<span className="pcc-small pcc-muted">{t('signing.meantFor',{who:p.meantFor})}</span>}
   </li>;})}</ol></section>
   {editable&&issues.length>0&&<div className="pcc-issues" role="status"><b>{f('issuesTitle',{count:issues.length})}</b><p className="sr-only">{t('beforeSubmit')}</p><ul>{issues.map(issue=><li key={issue}>{issueLabel(issue)}</li>)}</ul></div>}
   {dirty&&(signatureCommand||canSubmitSelf)&&<p className="pcc-banner pcc-banner-info">{t('saveBeforeSign')}</p>}
   {missingAckComments&&<p className="pcc-banner pcc-banner-warn">{t('issues.employee_comments')}</p>}
   {signatureCommand&&!dirty&&<div className="pcc-sig"><div className="pcc-row pcc-between"><h3>{f('signHeading')}</h3><span className="pcc-small pcc-muted">{f('signNote')}</span></div>
    <div className="pcc-small"><p>{f('signWho',{name:actor.name,role:step?roleLabel(step):t('roles.lm')})}</p><p className="pcc-muted">{f('signFingerprint')}</p></div>
    <SignatureInput resetDrawnOnMethodChange key={part.storageRevision+':'+signatureCommand} name={actor.name} busy={blocked||missingAckComments||signatureCommand==='submit_manager'&&part.managerIssues.length>0} labels={labels} submit={signature=>run(signatureCommand,{...signature,stepId:step?.id,actionId:crypto.randomUUID(),...(signatureCommand==='approve'?{coveredStepIds:step?.coveredStepIds??[]}:{} )})}/>
   </div>}
   {decisionCommand&&!dirty&&step&&<section className="pcc-card" data-decision-step={step.id}><h3>{f('decisionHeading')}</h3><label className="pcc-field"><span>{t('signing.decisionComment')}</span><textarea value={comment} maxLength={5000} disabled={blocked} onChange={e=>setComment(e.target.value)}/></label><div><ActionButton guardNavigation aria-busy={busy} type="button" className="v9-button v9-button-primary" disabled={blocked} onClick={()=>run('approve',{reason:comment||undefined,stepId:step.id,actionId:crypto.randomUUID(),coveredStepIds:step.coveredStepIds??[]})}>{t(decision==='reviewed'?'signing.markReviewed':'signing.markApproved')}</ActionButton></div></section>}
   {step&&part.allowedCommands.includes('return')&&<section className="pcc-card"><div><h3>{f('returnHeading')}</h3><p className="pcc-sub">{f('returnHelp')}</p></div><label className="pcc-field"><span>{t('returnReason')}</span><textarea value={reason} maxLength={5000} disabled={blocked} onChange={e=>setReason(e.target.value)}/></label><div><ActionButton guardNavigation aria-busy={busy} className="v9-button v9-button-danger" type="button" disabled={blocked||dirty||!reason.trim()} onClick={()=>run('return',{stepId:step.id})}>{t('returnReview')}</ActionButton></div></section>}
   <div className="pcc-actions" data-testid="probation-part-actions"><span className="pcc-note">{note}</span>
    {canSave&&<><span role="status">{busy?t('saving'):dirty?t('unsaved'):saved?t('saved'):t('draftSaved')}</span><ActionButton guardNavigation aria-busy={busy} type="button" className="v9-button" disabled={blocked||!dirty} onClick={save}>{t('saveDraft')}</ActionButton></>}
    {canSubmitSelf&&<ActionButton guardNavigation aria-busy={busy} type="button" className="v9-button v9-button-primary" disabled={blocked||dirty||part.employeeIssues.length>0} onClick={()=>run('submit_employee')}>{t('submitSelf')}</ActionButton>}
   </div>
  </>}

  {paperOnly&&<section className="pcc-card"><h2>{t(paper?'intake.paperFinalTitle':'intake.completedOffline')}</h2>
   {paper&&<><p><strong>{t('outcomes.'+paper.outcome)}</strong> · {paper.periodStart} – {paper.periodEnd}{paper.extensionMonths?' · '+t('planMonths',{months:paper.extensionMonths}):''}</p><p className="probation-note">{paper.reason}</p><p>{t(paper.acceptedAt?'intake.paperFinalAccepted':'intake.paperFinalWaiting')}</p></>}
   {paperFile&&<div><a className="v9-button" href={'/lifecycle/probation/'+view.record.id+'/files/'+paperFile.id} target="_blank" rel="noreferrer">{paperFile.name}</a></div>}
   {part.canAdjudicateOfflineDecision&&paperFile&&<OfflineFinalProposal mode="adjudication" evidence={paperFile} blocked={blocked||dirty||!!reason.trim()} onDirtyChange={setPaperDirty} onSave={value=>value.outcome==='other'?Promise.resolve({ok:false}):adjudicateOfflineFinal({caseId:view.record.id,partId:part.id,revision:part.storageRevision,outcome:value.outcome,extensionMonths:value.extensionMonths,reason:value.reason})}/>}
  </section>}
  {controls.length>0&&<section className="pcc-card"><div><h2>{t('controls.title')}</h2><p className="pcc-sub">{t('controls.help')}</p></div><label className="pcc-field"><span>{t('reason')} *</span><textarea maxLength={5000} value={reason} disabled={blocked||paperDirty} onChange={e=>setReason(e.target.value)}/></label>{controls.includes('confirm_extension')&&<label className="pcc-field"><span>{t('extensionMonths')} *</span><select value={confirmedMonths??''} disabled={blocked||paperDirty} onChange={e=>setConfirmedMonths(e.target.value?Number(e.target.value):null)}><option value="">{t('choose')}</option>{view.record.config.extensionMonths.map(months=><option key={months} value={months}>{t('planMonths',{months})}</option>)}</select></label>}{controls.includes('unlock')&&<label className="pcc-field"><span>{t('controls.owner')}</span><select value={owner} disabled={blocked||paperDirty} onChange={e=>setOwner(e.target.value as 'employee'|'lm')}><option value="employee">{t('roles.employee')}</option><option value="lm">{t('roles.lm')}</option></select></label>}<div className="pcc-row">{controls.map(command=><ActionButton guardNavigation aria-busy={busy} type="button" className="v9-button" key={command} disabled={blocked||dirty||paperDirty||reason.trim().length<3||command==='confirm_extension'&&!confirmedMonths} onClick={()=>run(command,{owner,months:confirmedMonths??undefined})}>{t(command==='record'&&paper?'intake.paperFinalAccept':'commands.'+command)}</ActionButton>)}</div></section>}
  {view.runtimeEnabled&&signerCandidates&&view.roles.some(role=>role==='pbp'||role==='gbs')&&!['locked','recorded','completed_offline','cancelled'].includes(part.state)&&<SignerControls blocked={busy||dirty||evidenceDirty} partId={part.id} revision={part.storageRevision} route={part.route} signing={part.signing?.document} candidates={signerCandidates} canOverride={view.roles.includes('pbp')&&!part.managerSubmittedAt} onDirtyChange={setSignerDirty}/>}
  {part.state==='locked'&&!view.files.some(file=>file.partId===part.id&&file.kind==='completed_part'&&file.revision===part.contentRevision&&file.filingState==='filed')&&<p className="pcc-banner" role="status">{t('files.pendingPdf')}</p>}
  {view.runtimeEnabled&&view.roles.some(role=>role==='pbp'||role==='gbs')&&['not_issued','issued'].includes(part.state)&&!part.staffSubmittedAt&&!part.managerSubmittedAt&&<EvidenceUpload blocked={busy||dirty||signerDirty} onDirtyChange={setEvidenceDirty} caseId={view.record.id} partId={part.id} revision={part.storageRevision}/>}
  {guide&&<GuideDrawer target={guide} form={view.form} kpis={part.acknowledgedKpis??lockedKpis?.kpis??[]} support={lockedKpis?.support??null} onClose={()=>setGuide(null)}/>}
 </Root>;
}
