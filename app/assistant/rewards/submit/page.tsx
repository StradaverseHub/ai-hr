import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {withTenant} from '@/db/client';
import {getBrowserCommandSession} from '@/lib/session';
import {readRewardsSubmitChoicesTx} from '@/core/assistant-actions/rewards-submit-source';
import {RewardsSubmitPanel} from '@/components/assistant/rewards-submit-panel';
export default async function RewardsSubmitPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.rewardsAnnualSubmit'),query=await searchParams,resume=z.guid().optional().safeParse(query.review);let choices=null;
 try{const ctx=await getBrowserCommandSession();choices=await withTenant(ctx,tx=>readRewardsSubmitChoicesTx(tx,ctx));}catch{}
 if(!resume.success)return <p role="alert">{t('unavailable')}</p>;
 return <div className="mx-auto max-w-3xl space-y-5"><Link href="/assistant?job=rewards" className="inline-flex min-h-11 items-center text-sm underline">{t('back')}</Link><RewardsSubmitPanel key={randomUUID()} choices={choices} resumeActionId={resume.data}/></div>;
}
