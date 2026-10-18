'use server';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { onboardingCommand, onboardingSaveConfig, onboardingSaveChecklistTasks, onboardingNote, onboardingSetup, onboardingDetail, onboardingMarkSeen, type OnboardingCommand, type OnboardingConfig } from '@/packs/lifecycle/service';
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
        return { detail: await onboardingDetail(await getSession(), id, 'task'), error: null };
    }
    catch (e) {
        return { detail: null, ...failure(e) };
    }
}
export async function markOnboardingSeen(id: string) { await onboardingMarkSeen(await getSession(), id); revalidatePath('/lifecycle/onboarding'); }
