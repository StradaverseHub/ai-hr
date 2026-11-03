'use client';
import {useRef,useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import type {contractAdmissionChoices,contractCompanies,ContractSource} from '@/packs/contracts/service';
import {WorkflowField,WorkflowButton} from '../../workflow-editor-shell';
import {ContractNavigation,contractDay,contractMoney,useContractCommand} from '../shared';
import {readContractRetirementContext} from '../actions';
import {PendingRetirementEvidence} from './health-evidence';

type Props={companies:Awaited<ReturnType<typeof contractCompanies>>[number][];employees:{companyId:string;rows:Awaited<ReturnType<typeof contractAdmissionChoices>>[number][]}[]};
type Retirement=Extract<Awaited<ReturnType<typeof readContractRetirementContext>>,{ok:true}>;
export function ContractIntake({companies,employees}:Props){
 const t=useTranslations('contractManagement'),router=useRouter(),ui=useContractCommand();
 const [companyId,setCompany]=useState(companies[0]?.id??''),[employmentId,setEmployee]=useState(''),[kind,setKind]=useState<'maternity_cover'|'project'|'post_retirement'>('project');
 const [source,setSource]=useState<ContractSource|null>(null),[retirement,setRetirement]=useState<Retirement|null>(null),[custody,setCustody]=useState('');
 const [retirementId,setRetirementId]=useState(''),[approval,setApproval]=useState(''),[health,setHealth]=useState(''),[reason,setReason]=useState('');
 const [pending,start]=useTransition(),[error,setError]=useState(''),selection=useRef('');
 const company=companies.find(c=>c.id===companyId),busy=ui.pending||pending;
 const sourceIssueKey=source?.sourceIssue==='unsupported_pay_basis'?'sourcePayBasisUnsupported':source?.sourceIssue==='unsupported_currency'?'sourceCurrencyUnsupported':null;
 const sourceComplete=source!==null&&!source.sourceIssue&&!!source.startOn&&!!source.endOn&&source.salaryCents!=null&&source.allowanceCents!=null;
 const proofRequired=source?.retirementProofRequired===true,healthPending=source?.retirementHealthPending===true,lockedKind=proofRequired||healthPending;
 const currentEvidence=retirement?.evidence.filter(row=>row.sourceRevision===source?.sourceRevision)??[];
 const waitingEvidence=currentEvidence.filter(row=>!row.verifiedBy),verifiedEvidence=currentEvidence.filter(row=>row.verifiedBy&&row.approvalEventId&&row.healthEventId);
 const verified=verifiedEvidence.find(row=>row.id===custody);
 const canCapture=retirement?.choices.canCapture&&!proofRequired&&waitingEvidence.every(row=>!row.canAttachHealth&&!row.canWithdraw);
 const canOpen=sourceComplete&&!source?.ended&&!healthPending&&(!proofRequired||kind==='post_retirement'&&!!verified);
 function selectEmployee(id:string){
  selection.current=id;if(lockedKind)setKind('project');setEmployee(id);setSource(null);setRetirement(null);setCustody('');setRetirementId('');setApproval('');setHealth('');setReason('');setError('');ui.clear();
 }
 function acceptSource(next:ContractSource){setSource(next);if(next.retirementHealthPending||next.retirementProofRequired)setKind('post_retirement');}
 function preview(){const id=employmentId;ui.run('previewIntake',id,result=>{if(selection.current!==id)return;acceptSource(result as ContractSource);setRetirement(null);setCustody('');});}
 function readEvidence(){
  const id=employmentId;start(async()=>{setError('');try{
   const result=await readContractRetirementContext(id);if(selection.current!==id)return;
   if(!result.ok){setError(t(result.error));return;}
   setRetirement(result);acceptSource(result.choices.source);
   setCustody(current=>result.evidence.some(e=>e.id===current&&e.sourceRevision===result.choices.source.sourceRevision&&e.verifiedBy&&e.approvalEventId&&e.healthEventId)?current:'');
  }catch{if(selection.current===id)setError(t('failed'));}});
 }
 return <div className="v9-stack">
  <header className="v9-heading"><div><h1>{t('intakeTitle')}</h1><p className="v9-muted">{t('intakeIntro')}</p></div></header>
  <ContractNavigation intake configure={!!company?.configure} templates={!!company?.gbs}/>
  <section className="v9-panel v9-stack">
   <div className="grid gap-4 sm:grid-cols-3">
    <WorkflowField label={t('company')}><select className="v9-input" value={companyId} disabled={busy} onChange={e=>{setCompany(e.target.value);selectEmployee('');}}>{companies.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></WorkflowField>
    <WorkflowField label={t('employee')}><select className="v9-input" value={employmentId} disabled={busy} onChange={e=>selectEmployee(e.target.value)}><option value="">{t('choose')}</option>{employees.find(c=>c.companyId===companyId)?.rows.map(e=><option value={e.id} key={e.id}>{e.name} · {e.employeeId} · {contractDay(e.endOn)}</option>)}</select></WorkflowField>
    <WorkflowField label={t('contractType')}><select className="v9-input" value={kind} disabled={busy||lockedKind} onChange={e=>{setKind(e.target.value as typeof kind);setRetirement(null);setCustody('');}}>{['maternity_cover','project','post_retirement'].map(k=><option key={k} value={k}>{t('kind.'+k)}</option>)}</select></WorkflowField>
   </div>
   <WorkflowButton disabled={busy||!employmentId} onClick={preview}>{t('previewSource')}</WorkflowButton>
   {source&&<>
    <h2>{t('verifiedSource')}</h2>
    <dl className="grid gap-4 sm:grid-cols-2">{[['employee',source.name],['period',contractDay(source.startOn)+' – '+contractDay(source.endOn)],['basicSalary',source.sourceIssue==='unsupported_currency'?'—':contractMoney(source.salaryCents)],['fixedAllowance',source.sourceIssue==='unsupported_currency'?'—':contractMoney(source.allowanceCents)]].map(([key,value])=><div key={key}><dt className="v9-muted">{t(key)}</dt><dd>{value}</dd></div>)}</dl>
    {!sourceComplete&&<p className="v9-error" role="alert">{t(sourceIssueKey??'sourceIncomplete')}</p>}
    {source.ended&&<p className="v9-error">{t('sourceEnded')}</p>}
    {lockedKind&&!retirement&&<p className="v9-notice" role="status">{t('retirementEvidencePending')}</p>}
    {kind==='post_retirement'&&<section className="v9-stack">
     <p className="v9-notice">{t('retirementNote')}</p>
     <WorkflowButton disabled={busy} onClick={readEvidence}>{t('readEvidence')}</WorkflowButton>
     {retirement&&<>
      <WorkflowField label={t('verifiedRetirement')}><select className="v9-input" value={custody} disabled={busy} onChange={e=>setCustody(e.target.value)}><option value="" disabled={proofRequired}>{t(proofRequired?'chooseVerifiedEvidence':'normalFlow')}</option>{verifiedEvidence.map(e=><option key={e.id} value={e.id}>{retirement.choices.documents.find(d=>d.id===e.approvalDocumentId)?.title??t('verifiedEvidence')}</option>)}</select></WorkflowField>
      {waitingEvidence.map(e=><PendingRetirementEvidence key={e.id} evidence={e} documents={retirement.choices.documents} busy={busy} onAttach={input=>ui.run('attachHealth',input,readEvidence)} onWithdraw={input=>ui.run('withdrawEvidence',input,readEvidence)}/>)}
      {canCapture&&<section className="v9-stack">
       <h3>{t('captureEvidence')}</h3>
       <WorkflowField label={t('retirementCase')}><select className="v9-input" value={retirementId} disabled={busy} onChange={e=>setRetirementId(e.target.value)}><option value="">{t('choose')}</option>{retirement.choices.retirements.map(r=><option key={r.id} value={r.id}>{r.number}</option>)}</select></WorkflowField>
       {(['approval','health'] as const).map(k=><WorkflowField label={t(k==='approval'?'approvalDocument':'healthDocument')} key={k}><select className="v9-input" value={k==='approval'?approval:health} disabled={busy} onChange={e=>k==='approval'?setApproval(e.target.value):setHealth(e.target.value)}><option value="">{t(k==='health'?'optionalHealth':'choose')}</option>{retirement.choices.documents.filter(d=>k==='approval'||d.id!==approval).map(d=><option key={d.id} value={d.id}>{d.title} · {d.fileName}</option>)}</select></WorkflowField>)}
       <WorkflowField label={t('evidenceReason')}><textarea className="v9-input" value={reason} disabled={busy} maxLength={5000} onChange={e=>setReason(e.target.value)}/></WorkflowField>
       <WorkflowButton disabled={busy||!sourceComplete||source.ended||!retirementId||!approval||approval===health||reason.trim().length<20} onClick={()=>ui.run('captureEvidence',{employmentId,retirementCaseId:retirementId,approvalDocumentId:approval,healthDocumentId:health||null,sourceRevision:source.sourceRevision,reason},readEvidence)}>{t('captureEvidence')}</WorkflowButton>
      </section>}
      {retirement.choices.canVerify&&waitingEvidence.some(e=>e.healthDocumentId)&&<section className="v9-stack">
       <h3>{t('verifyEvidence')}</h3><p className="v9-muted">{t('independentVerification')}</p>
       <WorkflowField label={t('evidenceReason')}><textarea className="v9-input" value={reason} disabled={busy} maxLength={5000} onChange={e=>setReason(e.target.value)}/></WorkflowField>
       {waitingEvidence.filter(e=>e.healthDocumentId).map(e=><WorkflowButton key={e.id} disabled={busy||!sourceComplete||source.ended||reason.trim().length<20} onClick={()=>ui.run('verifyEvidence',{custodyId:e.id,reason},readEvidence)}>{t('verifyEvidence')}</WorkflowButton>)}
      </section>}
     </>}
    </section>}
    {company?.canIntake&&<WorkflowButton primary disabled={busy||!canOpen} onClick={()=>ui.run('intake',{employmentId,kind,sourceRevision:source.sourceRevision,retirementApprovalId:verified?.approvalEventId??null,healthCheckId:verified?.healthEventId??null},result=>router.push('/lifecycle/contracts/'+(result as {id:string}).id))}>{t('openCase')}</WorkflowButton>}
   </>}
  </section>
  {error&&<p role="alert" className="v9-error">{error}</p>}{ui.feedback}
 </div>;
}
