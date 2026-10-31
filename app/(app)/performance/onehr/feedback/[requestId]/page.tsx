import { redirect } from 'next/navigation';
export default async function LegacyAssessmentRoute({params}:{params:Promise<{requestId:string}>}){
 const {requestId}=await params;redirect(`/performance/assessment/feedback/${requestId}`);
}
