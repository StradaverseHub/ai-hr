import {ContractManagementError} from '@/lib/contract-management-model';
import {ZodError} from 'zod';
import {notFound,redirect} from 'next/navigation';
import {getSession} from '@/lib/session';
import {contractCase} from '@/packs/contracts/service';
import {templateLabels} from '@/app/letters/templates/labels';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {ContractCaseDetail} from './detail';
import '../../v9/workspace.css';
export default async function Page({params}:{params:Promise<{caseId:string}>}){const session=await getSession();if(!session)redirect('/login');const {caseId}=await params;let view;try{view=await contractCase(session,caseId);}catch(error){if(error instanceof ZodError||error instanceof ContractManagementError&&error.code==='forbidden')notFound();throw error;}return <main className="v9-workspace"><ContractCaseDetail key={view.record.id+':'+view.record.revision} view={view} editorLabels={view.gbs?(await templateLabels()).editor:null} today={todayInKualaLumpur()}/></main>;}
