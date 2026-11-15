import {redirect} from 'next/navigation';
/** The Routes page is retired: approval routing lives on each form version (Forms). Old links keep the company. */
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const company=(await searchParams).company;
 redirect('/lifecycle/probation/forms'+(typeof company==='string'&&company?'?company='+encodeURIComponent(company):''));
}
