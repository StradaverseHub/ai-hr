import {redirect,notFound} from 'next/navigation';
import {z} from 'zod';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {contractAdmissionPage} from '@/packs/contracts/service';
import {ContractIntake} from './intake';
import '../../v9/workspace.css';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const s=await requireScopedLifecycleModule();if(!s)redirect('/login');
 const q=await searchParams,search=typeof q.search==='string'?q.search.slice(0,100):'',parsedCompany=z.uuid().safeParse(q.companyId),companyId=parsedCompany.success?parsedCompany.data:null;
 const rawOffset=typeof q.offset==='string'&&/^\d+$/.test(q.offset)?Number(q.offset):0,offset=Number.isSafeInteger(rawOffset)?Math.min(rawOffset,100000):0;
 const page=await contractAdmissionPage(s,{search,companyId,offset});if(!page.companies.length)notFound();
 return <main className="v9-workspace"><ContractIntake key={[companyId,search,offset].join(':')} page={page} search={search} companyId={companyId}/></main>;
}
