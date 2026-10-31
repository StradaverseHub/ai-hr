import {randomUUID} from 'node:crypto';
import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {Card,PageHeader} from '@/components/ui';
import {PeopleGeneralPolicyPanel} from '@/components/assistant/people-general-policy-panel';
import {readPeopleGeneralPolicyAvailability} from '@/core/assistant-actions/people-general-policy-availability';
/** GET reads authorized current policy only; explicit POST owns preparation and native confirmation. */
export default async function PeopleGeneralPolicyPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.peopleGeneralPolicy'),sp=await searchParams,resume=z.guid().optional().safeParse(sp.review),session=await getBrowserCommandSession(),initial=await readPeopleGeneralPolicyAvailability(session);
 return <div className="mx-auto max-w-3xl space-y-5"><Link href="/assistant/org" className="inline-flex min-h-11 items-center underline">{t('back')}</Link><PageHeader title={t('title')} description={t('description')}/><Card className="p-5">{resume.success?<PeopleGeneralPolicyPanel key={randomUUID()} initial={initial} resumeActionId={resume.data}/>:<p role="alert">{t('unavailable')}</p>}</Card></div>;
}
