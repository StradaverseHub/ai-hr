import {ContractManagementError} from '@/lib/contract-management-model';
import {ZodError} from 'zod';
import {notFound,redirect} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {contractCase,contractCases,contractCompanies,contractTemplates} from '@/packs/contracts/service';
import {templateLabels} from '@/app/letters/templates/labels';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {ContractCaseDetail} from './detail';
import '../../v9/workspace.css';
export default async function Page({params}:{params:Promise<{caseId:string}>}){const session=await requireScopedLifecycleModule();if(!session)redirect('/login');const {caseId}=await params;let view;try{view=await contractCase(session,caseId);}catch(error){if(error instanceof ZodError||error instanceof ContractManagementError&&error.code==='forbidden')notFound();throw error;}const terms=(await contractCases(session,[view.record.term.companyId])).filter(row=>row.record.term.employmentId===view.record.term.employmentId).map(({record:r})=>({id:r.id,number:r.number,version:r.term.version,startOn:r.term.startOn,endOn:r.term.endOn,state:r.state,manualHandoff:!!r.effects.manualHandoff}));return <main className="v9-workspace"><ContractCaseDetail key={view.record.id+':'+view.record.revision} view={{...view,documents:Array.from(view.documents),activity:Array.from(view.activity),effects:Array.from(view.effects)}} terms={terms} templatesAvailable={(await contractCompanies(session)).some(c=>c.gbs)||(await contractTemplates(session)).length>0} editorLabels={view.gbs?(await templateLabels()).editor:null} today={todayInKualaLumpur()}/></main>;}
