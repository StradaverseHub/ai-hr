import 'server-only';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {withTenant} from '@/db/client';
import {withAgentActionGuard} from '@/core/assistant-actions/agent-action-guard';
import {OffboardingCaseCancel as C} from '@/lib/assistant-actions/offboarding-case-cancel-contract';
import {getTranslations} from 'next-intl/server';
import {OffboardingCaseCancelPanel} from './offboarding-case-cancel-panel';
export async function OffboardingCaseCancelSection({resumeActionId}:{resumeActionId?:unknown}){
 const t=await getTranslations('assistant.workspace.offboardingCaseCancel');
 try{const id=z.guid().optional().parse(resumeActionId),ctx=await getBrowserCommandSession();await withTenant(ctx,tx=>withAgentActionGuard(tx,ctx,C.action));return <OffboardingCaseCancelPanel key={randomUUID()} resumeActionId={id}/>;}catch{return <p role="alert">{t('unavailable')}</p>;}
}
