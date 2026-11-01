import {randomUUID} from 'node:crypto';
import {getTranslations} from 'next-intl/server';
import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {Card} from '@/components/ui';
import {ReviewShell} from '@/components/ai-centre/review-shell';
import {PeopleGeneralPolicyPanel} from '@/components/assistant/people-general-policy-panel';
import {readPeopleGeneralPolicyAvailability} from '@/core/assistant-actions/people-general-policy-availability';
/** GET reads authorized current policy only; explicit POST owns preparation and native confirmation. */
export default async function PeopleGeneralPolicyPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.peopleGeneralPolicy'),sp=await searchParams,resume=z.guid().optional().safeParse(sp.review),session=await getBrowserCommandSession(),initial=await readPeopleGeneralPolicyAvailability(session);
 return <ReviewShell title={t('title')} description={t('description')} back={{href:'/assistant/org',label:t('back')}}><Card className="p-5">{resume.success?<PeopleGeneralPolicyPanel key={randomUUID()} initial={initial} resumeActionId={resume.data}/>:<p role="alert">{t('unavailable')}</p>}</Card></ReviewShell>;
}
