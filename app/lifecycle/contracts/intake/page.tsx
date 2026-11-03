import {redirect,notFound} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {contractCompanies,contractAdmissionChoices} from '@/packs/contracts/service';
import {ContractIntake} from './intake';
import '../../v9/workspace.css';
export default async function Page(){const s=await requireScopedLifecycleModule();if(!s)redirect('/login');const companies=(await contractCompanies(s)).filter(c=>c.canIntake||c.canCapturePbp);if(!companies.length)notFound();const employees=await Promise.all(companies.map(async c=>({companyId:c.id,rows:Array.from(await contractAdmissionChoices(s,c.id))})));return <main className="v9-workspace"><ContractIntake companies={companies} employees={employees}/></main>;}
