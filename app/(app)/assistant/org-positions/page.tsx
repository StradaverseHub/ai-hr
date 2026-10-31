import {randomUUID} from 'node:crypto';
import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {Card,PageHeader} from '@/components/ui';
import {PositionArchivePanel} from '@/components/assistant/position-archive-panel';
import {readPositionArchiveChoices} from '@/core/assistant-actions/position-archive-review-store';
/** GET composes only current guarded choices. POST owns all human review custody and native writes. */
export default async function PositionArchivePage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.positionArchive'),sp=await searchParams,resume=z.guid().optional().safeParse(sp.review);
 const session=await getBrowserCommandSession();
 const choices=await readPositionArchiveChoices(session);
 return <div className="mx-auto max-w-3xl space-y-5"><Link href="/assistant/org" className="inline-flex min-h-11 items-center underline">{t('back')}</Link><PageHeader title={t('title')} description={t('description')}/><Card className="p-5">{resume.success?<PositionArchivePanel key={randomUUID()} initialChoices={choices} resumeActionId={resume.data}/>:<p role="alert">{t('unavailable')}</p>}</Card></div>;
}
