import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {readMyPayrollReadiness} from '@/core/pre-salary/person-items';
import {MyPayrollReadiness} from '@/components/pre-salary/payroll-readiness';

/** AI Centre restructure (owner decision 27, 4 November 2026) — "My payroll readiness", the person's own page: every one
 * of their own "Before payroll" items for this month, grouped, and the decisions waiting on them as an approver (links to
 * the approvals owner's own pages). Moved here from AI Centre › Insights, which is now for administrators only; Today's
 * "Before payroll" card opens it with "See all", and the Assistant's my_payroll_readiness read links it.
 *
 * Every signed-in person, for themselves only (scopedSession; listed in lib/permissions.ts). The read is the same owner
 * as before (core/pre-salary/person-items.ts readMyPayrollReadiness), as the person, under their row-level security,
 * with the approvals following their company scope as Today's do. No pay figure is ever read into it. Nothing here is
 * written except through each row's own owner (the missed clock-out Confirm card, the TP3 one-tap question). */
export default async function MyPayrollReadinessPage(){
 const {s,scopeIds}=await scopedSession();
 const [t,locale]=await Promise.all([getTranslations('payrollReadiness'),getLocale()]);
 const readiness=await readMyPayrollReadiness(s,{scopeIds,locale,approvalPreview:true}).catch(()=>null);
 return <div data-my-payroll-readiness-page className="mx-auto max-w-5xl space-y-5">
  <Link href="/" className="inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4">{t('backToToday')}</Link>
  <MyPayrollReadiness readiness={readiness} locale={locale} headingLevel={1}/>
 </div>;
}
