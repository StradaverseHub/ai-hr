import {ProbationCasePage} from '../../case-page';
/** A part's own address keeps working (task links use it): the case view opened on that part's tab, any cycle. */
export default async function Page({params}:{params:Promise<{id:string;partId:string}>}){
 const{id,partId}=await params;
 return <ProbationCasePage id={id} partId={partId}/>;
}
