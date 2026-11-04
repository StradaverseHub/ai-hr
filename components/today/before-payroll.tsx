import type {SessionContext} from '@/db/client';
import {readMyPayrollReadiness} from '@/core/pre-salary/person-items';
import {BeforePayrollCard} from '@/components/pre-salary/payroll-readiness';

/** AI v2 Phase 2, P2-3 — Today's "Before payroll on <date>" card for employees and managers (owner decision 7), in
 * its own Suspense boundary. The checklist is read as the viewer (core/pre-salary/person-items.ts); a read that
 * fails leaves the card out rather than taking Today with it. */
export async function BeforePayrollSection({session,employmentId,scopeIds,locale,today}:{session:SessionContext;employmentId?:string;scopeIds:readonly string[];locale:string;today:string}){
 const readiness=await readMyPayrollReadiness(session,{employmentId,scopeIds,locale,today,approvalPreview:true}).catch(()=>null);
 return <BeforePayrollCard readiness={readiness} locale={locale}/>;
}
