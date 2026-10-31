import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {withTenant} from '@/db/client';
import {getBrowserCommandSession} from '@/lib/session';
import {readRewardsCancelChoicesTx} from '@/core/assistant-actions/rewards-cancel-source';
import {RewardsCancelPanel} from '@/components/assistant/rewards-cancel-panel';
export default async function RewardsCancelPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.rewardsCancellation'),query=await searchParams,resume=z.guid().optional().safeParse(query.review);let choices=null;
 try{const ctx=await getBrowserCommandSession();choices=await withTenant(ctx,tx=>readRewardsCancelChoicesTx(tx,ctx));}catch{}
 if(!resume.success)return <p role="alert">{t('unavailable')}</p>;
 return <div className="mx-auto max-w-3xl space-y-5"><Link href="/assistant?job=rewards" className="inline-flex min-h-11 items-center text-sm underline">{t('back')}</Link><RewardsCancelPanel key={randomUUID()} choices={choices} resumeActionId={resume.data}/></div>;
}
