import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { mayUseAssistant } from '@/core/assistant-grant';
import { Card, PageHeader } from '@/components/ui';
import { AssistantConversation } from '@/components/assistant-conversation';
import { assistantWorkspaceView } from '@/lib/assistant-session';
import {isAdmin} from '@/lib/authz-model';
import {isModuleEnabledOrFalse} from '@/core/entitlements';
export default async function AssistantPage() {
    const ctx = await getSession(), access = await mayUseAssistant(ctx), t = await getTranslations('assistant');
    if (!access.allowed)
        return <div data-tour="intelligence-assistant" className="mx-auto max-w-2xl space-y-5"><PageHeader title={t('title')} description={t('description')}/><Card className="p-6"><p className="text-sm text-muted-foreground">{t(`denied_${access.reason}`)}</p></Card></div>;
    // History is loaded by the sign-in-bound owner, never by a tenant/admin audit listing.
    const workspace = await assistantWorkspaceView().catch(() => null);
    return <div data-tour="intelligence-assistant" className="mx-auto w-full max-w-4xl"><AssistantConversation key={workspace?.key ?? 'unresolved-signin'} scopeNames={workspace?.companyNames??[]} canReviewPayroll={isAdmin(ctx)&&isModuleEnabledOrFalse(ctx,'payroll')}/></div>;
}
