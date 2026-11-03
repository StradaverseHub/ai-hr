import {getLocale,getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import {PageHeader} from '@/components/ui';
import {readMyPayrollReadiness} from '@/core/pre-salary/person-items';
import {MyPayrollReadiness} from '@/components/pre-salary/payroll-readiness';

/** AI v2 Phase 2 — AI Centre › Insights, a view of /assistant for every signed-in person (approved mock-ups,
 * "Operations ▾ · Policies · Insights").
 *
 * P2-3: "My payroll readiness", the person's own "Before payroll" checklist (owner decision 7), read as them by
 * core/pre-salary/person-items.ts. It shows nothing the person could not already open: each item is their own, and
 * the approvals are the ones the approvals owner assigns them. Administrators see the same for themselves.
 * Administrator sections (P2-4, the HR capacity ledger) are added below by their own workstream, each with its own
 * guard; this view grants nothing. */
export async function AiCentreInsights({session,scopeIds}:{session:SessionContext;scopeIds?:readonly string[]}){
 const [t,locale]=await Promise.all([getTranslations('aiCentre.insights'),getLocale()]);
 const readiness=await readMyPayrollReadiness(session,{scopeIds,locale}).catch(()=>null);
 return <div data-ai-centre-insights className="space-y-6">
  <PageHeader title={t('title')} description={t('description')}/>
  <MyPayrollReadiness readiness={readiness} locale={locale}/>
 </div>;
}
