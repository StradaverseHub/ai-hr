'use client';
import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { AssistantConversation } from './assistant-conversation';
import { Button } from './ui/button';
import { firstDirtyGuard } from '@/lib/unsaved-changes';
/** Same conversation owner as /assistant. Closing with an unsent question requires its own discard control. */
export function HomeAssistant({ workspaceKey, scopeNames, canReviewPayroll }: {
    workspaceKey: string;
    scopeNames: readonly string[];
    canReviewPayroll: boolean;
}) {
    const t = useTranslations('home'), [open, setOpen] = useState(false);
    const change = (next: boolean) => { if (!next) {
        const guard = firstDirtyGuard();
        if (guard) {
            guard.prompt(() => setOpen(false));
            return;
        }
    } setOpen(next); };
    return <Dialog.Root open={open} onOpenChange={change}><Dialog.Trigger asChild><Button type="button" className="min-h-11 w-full sm:w-auto">{t('ask')}</Button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-40 bg-black/40"/><Dialog.Content className="fixed inset-x-2 bottom-2 z-40 max-h-[95dvh] overflow-y-auto rounded-xl bg-background shadow-xl sm:inset-y-3 sm:left-auto sm:right-3 sm:w-[min(44rem,calc(100%-1.5rem))]"><div className="flex items-center justify-between gap-3 p-3"><Dialog.Title className="sr-only">{t('ask')}</Dialog.Title><Dialog.Description className="text-xs text-muted-foreground">{t('assistantHelp')}</Dialog.Description><Dialog.Close asChild><Button variant="ghost" className="min-h-11">{t('close')}</Button></Dialog.Close></div><AssistantConversation key={workspaceKey} compact scopeNames={scopeNames} canReviewPayroll={canReviewPayroll} suggestions={[t('suggestLeave'), t('suggestPayslip')]}/></Dialog.Content></Dialog.Portal></Dialog.Root>;
}
