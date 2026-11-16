import {ProbationCasePage} from '../case-page';
export default async function Page({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const[{id},query]=await Promise.all([params,searchParams]);
 return <ProbationCasePage id={id} tab={typeof query.tab==='string'?query.tab:undefined}/>;
}
