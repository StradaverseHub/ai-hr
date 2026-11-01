import {getTranslations as cancellationTranslations} from 'next-intl/server';
import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';
import {ReviewShell} from '@/components/ai-centre/review-shell';
import {ModuleRewardsPostActionSection} from '@/components/assistant/module-rewards-post-action-section';
/** GET only renders choices and recovery controls. A separate human-confirmed POST submits the actual whole-unit Rewards posting. */
export default async function AssistantRewardsPostPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const t=await getTranslations('assistant.workspace.rewardsActions'),query=await searchParams,c=await cancellationTranslations('assistant.workspace.rewardsCancellation'),calendar=await getTranslations('assistant.workspace.rewardsCalendar'),annualReturn=await getTranslations('assistant.workspace.rewardsAnnualReturn');return <ReviewShell title={t('title')} description={t('description')} back={{href:'/assistant?job=rewards',label:t('back')}} width="wide"><Link href="/assistant/rewards/cancel" className="inline-flex min-h-11 items-center text-sm underline">{c('title')}</Link><Link href="/assistant/rewards/calendar" className="inline-flex min-h-11 items-center text-sm underline">{calendar('title')}</Link><Link href="/assistant/rewards/return" className="inline-flex min-h-11 items-center text-sm underline">{annualReturn('title')}</Link><Card className="p-5"><ModuleRewardsPostActionSection resumeActionId={query.review}/></Card></ReviewShell>;}
