'use server';

import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getTranslations} from 'next-intl/server';
import {getBrowserCommandSession} from '@/lib/session';
import {delegateOwnJob,stopOwnJob} from '@/core/digest/own-digest';

/** Admin Today's morning summary (owner decision, 11 Nov 2026). The job type is fixed here, never read from the form:
 * the only job these buttons start or stop is the viewer's own daily digest. The service checks the administrator role
 * (again in the database, in the grant's own transaction), both keys and the stop switch, and audits the change. */
const JOB='daily_digest';
const HASH='#today-morning';

export async function startMorningSummaryAction(){
 const t=await getTranslations('today.admin.morning');
 let ok=true;
 try{await delegateOwnJob(await getBrowserCommandSession(),{jobType:JOB});}catch{ok=false;}
 revalidatePath('/');
 redirect(ok?`/?toast=${encodeURIComponent(t('started'))}${HASH}`:`/?error=${encodeURIComponent(t('startFailed'))}${HASH}`);
}

export async function stopMorningSummaryAction(){
 const t=await getTranslations('today.admin.morning');
 let ok=true;
 try{await stopOwnJob(await getBrowserCommandSession(),{jobType:JOB});}catch{ok=false;}
 revalidatePath('/');
 redirect(ok?`/?toast=${encodeURIComponent(t('stoppedToast'))}${HASH}`:`/?error=${encodeURIComponent(t('stopFailed'))}${HASH}`);
}
