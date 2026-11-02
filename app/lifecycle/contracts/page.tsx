import {redirect} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {contractCompanies,contractCases,contractTemplates} from '@/packs/contracts/service';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {ContractCases} from './cases';
import '../v9/workspace.css';
export default async function Page(){const session=await requireScopedLifecycleModule();if(!session)redirect('/login');const companies=Array.from(await contractCompanies(session));const templatesAvailable=companies.some(c=>c.gbs)||(await contractTemplates(session)).length>0;const rows=Array.from(await contractCases(session,companies.map(c=>c.id)));return <main className="v9-workspace"><ContractCases rows={rows} templatesAvailable={templatesAvailable} companies={companies} today={todayInKualaLumpur()}/></main>;}
