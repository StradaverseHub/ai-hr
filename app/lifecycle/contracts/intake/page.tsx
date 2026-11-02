import {redirect,notFound} from 'next/navigation';
import {getSession} from '@/lib/session';
import {contractCompanies,contractAdmissionChoices} from '@/packs/contracts/service';
import {ContractIntake} from './intake';
import '../../v9/workspace.css';
export default async function Page(){const s=await getSession();if(!s)redirect('/login');const companies=(await contractCompanies(s)).filter(c=>c.canIntake||c.canCapturePbp);if(!companies.length)notFound();const employees=await Promise.all(companies.map(async c=>({companyId:c.id,rows:await contractAdmissionChoices(s,c.id)})));return <main className="v9-workspace"><ContractIntake companies={companies} employees={employees}/></main>;}
