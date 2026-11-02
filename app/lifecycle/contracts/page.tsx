import {redirect} from 'next/navigation';
import {getSession} from '@/lib/session';
import {contractCompanies,contractCases} from '@/packs/contracts/service';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {ContractCases} from './cases';
import '../v9/workspace.css';
export default async function Page(){const session=await getSession();if(!session)redirect('/login');const companies=await contractCompanies(session);const rows=await contractCases(session,companies.map(c=>c.id));return <main className="v9-workspace"><ContractCases rows={rows} companies={companies} today={todayInKualaLumpur()}/></main>;}
