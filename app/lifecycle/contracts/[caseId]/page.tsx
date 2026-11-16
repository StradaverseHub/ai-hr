import {automationEmailCaseFilePage} from '@/packs/automation/service';
import {ContractEmailCaseFiles} from '@/app/automation/templates/automation-email-assets';
import {ContractManagementError} from '@/lib/contract-management-model';
import {ZodError} from 'zod';
import {notFound,redirect} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {contractCase,contractCases,contractCompanies,contractTemplates,contractSharedWorkspace} from '@/packs/contracts/service';
import {templateLabels} from '@/app/letters/templates/labels';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {ContractCaseDetail} from './detail';
import {SharedContractDetail} from './shared-detail';
import '../../v9/workspace.css';
import '../shared-contract.css';
export default async function Page({params,searchParams}:{params:Promise<{caseId:string}>;searchParams:Promise<{legacy?:string}>}){
 const session=await requireScopedLifecycleModule();if(!session)redirect('/login');const {caseId}=await params;
 if((await searchParams).legacy!=='1'){
  try{const workspace=await contractSharedWorkspace(session,caseId),files=workspace.view.flow&&workspace.view.permissions.includes('manual')?await automationEmailCaseFilePage(session,caseId,{limit:50,offset:0}):null;return <main className="v9-workspace"><SharedContractDetail key={caseId+':'+workspace.view.flow?.revision} workspace={workspace} caseFiles={files?.items.length?<ContractEmailCaseFiles caseId={caseId} items={files.items} editable/>:undefined} today={todayInKualaLumpur()}/></main>;}
  catch(error){if(error instanceof ZodError)notFound();if(!(error instanceof ContractManagementError&&error.code==='forbidden'))throw error;}
 }
 let view;try{view=await contractCase(session,caseId);}catch(error){if(error instanceof ZodError||error instanceof ContractManagementError&&error.code==='forbidden')notFound();throw error;}
 const terms=(await contractCases(session,[view.record.term.companyId])).filter(row=>row.record.term.employmentId===view.record.term.employmentId).map(({record:r})=>({id:r.id,number:r.number,version:r.term.version,startOn:r.term.startOn,endOn:r.term.endOn,state:r.state,manualHandoff:!!r.effects.manualHandoff}));
 return <main className="v9-workspace"><ContractCaseDetail key={view.record.id+':'+view.record.revision} view={{...view,documents:Array.from(view.documents),activity:Array.from(view.activity),effects:Array.from(view.effects)}} terms={terms} templatesAvailable={(await contractCompanies(session)).some(c=>c.gbs)||(await contractTemplates(session)).length>0} editorLabels={view.gbs?(await templateLabels()).editor:null} today={todayInKualaLumpur()}/></main>;
}
