/** Dedicated server-rendered human navigation. No subject parameters, client capability or fact cards. */
import 'server-only';
import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import {Card} from '@/components/ui';
import {getAgentAction} from '@/lib/ai/agent-action-registry';
import {availablePersonnelReviewNavigation,type PersonnelReviewNavigationAction} from '@/core/assistant-actions/personnel-review-navigation';
const titles:Record<PersonnelReviewNavigationAction,'workforceProfileMaintenance.title'|'employeeCodeMaintenance.title'>={
 'employees.workforce_profile.maintain':'workforceProfileMaintenance.title',
 'employees.code.maintain':'employeeCodeMaintenance.title',
};
export async function PersonnelReviewNavigation({ctx}:{ctx:SessionContext}){
 const actions=await availablePersonnelReviewNavigation(ctx);if(!actions.length)return null;
 const t=await getTranslations('assistant.workspace');
 return <Card className="space-y-3 p-5"><h2 id="assistant-personnel-review-navigation" className="text-base font-semibold">{t('jobs.reviewAction')}</h2><p className="text-sm text-muted-foreground">{t('jobs.humanReviewNote')}</p>
  <nav aria-labelledby="assistant-personnel-review-navigation" className="flex flex-wrap gap-x-5 gap-y-2">{actions.map(action=><Link key={action} href={getAgentAction(action).review.route} className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t(titles[action])}</Link>)}</nav>
 </Card>;
}
