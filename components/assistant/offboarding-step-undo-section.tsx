import 'server-only';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {withTenant} from '@/db/client';
import {withAgentActionGuard} from '@/core/assistant-actions/agent-action-guard';
import {OffboardingStepUndo as C} from '@/lib/assistant-actions/offboarding-step-undo-contract';
import {getTranslations} from 'next-intl/server';
import {OffboardingStepUndoPanel} from './offboarding-step-undo-panel';
export async function OffboardingStepUndoSection({resumeActionId}:{resumeActionId?:unknown}){
 const t=await getTranslations('assistant.workspace.offboardingStepUndo');
 try{const id=z.guid().optional().parse(resumeActionId),ctx=await getBrowserCommandSession();await withTenant(ctx,tx=>withAgentActionGuard(tx,ctx,C.action));return <OffboardingStepUndoPanel key={randomUUID()} resumeActionId={id}/>;}catch{return <p role="alert">{t('unavailable')}</p>;}
}
