'use server';
import { revalidatePath } from 'next/cache';
import { companyContextForPage } from '@/lib/scope';
import { lifecycleTaskCardDocuments } from '@/packs/lifecycle/service';
import { getSession } from '@/lib/session';
import { onboardingCommand, onboardingSaveConfig, onboardingSaveChecklistTasks, onboardingNote, onboardingSetup, onboardingDetail, onboardingMarkSeen, searchOnboardingRecipientUsers, type OnboardingCommand, type OnboardingConfig } from '@/packs/lifecycle/service';
import type { TaskDef } from '@/lib/onboarding-model';
import { OnboardingError } from '@/lib/onboarding-model';
import { ZodError } from 'zod';
const failure = (e: unknown) => ({ code: e instanceof OnboardingError ? e.code : e instanceof ZodError ? 'invalid' : 'unknown', fields: e instanceof OnboardingError ? e.fields : [], error: e instanceof OnboardingError ? e.message : e instanceof ZodError ? 'Check the highlighted values and try again.' : 'The change could not be saved. Reload and try again.' });
const refresh = () => { revalidatePath('/lifecycle'); revalidatePath('/tasks'); revalidatePath('/admin/lifecycle/onboarding'); };
export async function changeOnboarding(id: string, revision: number, command: OnboardingCommand) {
    try {
        const result = await onboardingCommand(await getSession(), id, revision, command);
        refresh();
        return { ...result, error: null, fields: [] as string[] };
    }
    catch (e) {
        return { ...failure(e), revision: null };
    }
}
export async function saveOnboardingConfig(revision: number, config: OnboardingConfig, replacements: Record<string, string> = {}, flagRetired = false) {
    try {
        const result = await onboardingSaveConfig(await getSession(), revision, config, replacements, flagRetired);
        refresh();
        return { ...result, error: null };
    }
    catch (e) {
        return { ...failure(e), revision: null };
    }
}
export async function saveOnboardingChecklistTasks(revision: number, checklistId: string, tasks: TaskDef[]) {
    try {
        const result = await onboardingSaveChecklistTasks(await getSession(), revision, checklistId, tasks);
        refresh();
        return { ...result, error: null };
    }
    catch (e) {
        return { ...failure(e), revision: null };
    }
}
export async function writeOnboardingNote(caseId: string, input: {
    id?: string;
    context: string;
    body: string;
    mentions: string[];
    deleted?: boolean;
    resolve?: boolean;
}) {
    try {
        await onboardingNote(await getSession(), caseId, input);
        refresh();
        return { error: null };
    }
    catch (e) {
        return failure(e);
    }
}
export async function setupOnboarding() {
    try {
        await onboardingSetup(await getSession());
        refresh();
        return { error: null };
    }
    catch (e) {
        return failure(e);
    }
}
export async function loadOnboardingTask(id: string) {
    try {
        const session=await getSession(),detail=await onboardingDetail(session,id,'task');
        const scope=await companyContextForPage(session),documents=await lifecycleTaskCardDocuments(session,{companyIds:scope.scopeIds,refs:detail.case.tasks.filter(task=>task.documentTemplate).map(task=>({caseId:id,taskId:task.id}))});
        return { detail, documents, error: null };
    }
    catch (e) {
        return { detail: null, documents:[], ...failure(e) };
    }
}
export async function markOnboardingSeen(id: string) { await onboardingMarkSeen(await getSession(), id); revalidatePath('/lifecycle/onboarding'); }

/** Read-only, authorized bounded search; the selected UUID is validated again when saving the case. */
export async function searchOnboardingTaUsers(caseId: string, query: string) {
    try { return { users: await searchOnboardingRecipientUsers(await getSession(), caseId, query), error: null }; }
    catch { return { users: [], error: 'TA_SEARCH_UNAVAILABLE' }; }
}
