import 'server-only';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {withTenant} from '@/db/client';
import {withAgentActionGuard} from '@/core/assistant-actions/agent-action-guard';
import {OffboardingStepCompletion as C} from '@/lib/assistant-actions/offboarding-step-completion-contract';
import {getTranslations} from 'next-intl/server';
import {OffboardingStepPanel} from './offboarding-step-panel';
export async function OffboardingStepSection({resumeActionId}:{resumeActionId?:unknown}){
 const t=await getTranslations('assistant.workspace.offboardingStep');
 try{const id=z.guid().optional().parse(resumeActionId),ctx=await getBrowserCommandSession();await withTenant(ctx,tx=>withAgentActionGuard(tx,ctx,C.action));return <OffboardingStepPanel key={randomUUID()} resumeActionId={id}/>;}catch{return <p role="alert">{t('unavailable')}</p>;}
}
