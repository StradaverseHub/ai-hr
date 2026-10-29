'use server';
import { revalidatePath } from 'next/cache';
import { requireModule } from '@/lib/authz';
import { v9CaseDetail, v9PreviewEmail, v9PreviewUpdatedEmail, v9Command, v9CreateOffboarding, v9SaveConfig, v9Setup } from '@/packs/lifecycle/service';
import type { LifecycleV9Command as Command } from '@/packs/lifecycle/service';
import type { ExitType } from '@/lib/lifecycle-v9-model';
async function execute<T>(work: () => Promise<T>) {
  try { const result = await work(); revalidatePath('/lifecycle/v9'); return { ok: true as const, result }; }
  catch (error) { return { ok: false as const, error: error instanceof Error && ['V9Error', 'ZodError'].includes(error.name) ? error.message : 'The change could not be saved. Refresh and try again.' }; }
}
export async function setupV9() { return execute(async () => v9Setup(await requireModule('lifecycle'))); }
export async function saveV9Config(revision: number, input: unknown) { return execute(async () => v9SaveConfig(await requireModule('lifecycle'), revision, input)); }
export async function createV9Offboarding(input: { employmentId: string; type: ExitType; noticeDate: string; lastDay: string }) { return execute(async () => v9CreateOffboarding(await requireModule('lifecycle'), input)); }
export async function commandV9(id: string, revision: number, command: Command) { return execute(async () => v9Command(await requireModule('lifecycle'), id, revision, command)); }
export async function readV9Case(id: string) {
  try { return { ok: true as const, detail: await v9CaseDetail(await requireModule('lifecycle'), id) }; }
  catch { return { ok: false as const, error: 'The case could not be loaded. Refresh and try again.' }; }
}

export async function readV9Email(caseId: string, emailId: string) {
  try { return { ok: true as const, preview: await v9PreviewEmail(await requireModule('lifecycle'), caseId, emailId) }; }
  catch { return { ok: false as const, error: 'The email preview could not be loaded. Refresh and try again.' }; }
}

export async function readV9UpdatedEmail(caseId:string,mailId:string) {
  try {return {ok:true as const,preview:await v9PreviewUpdatedEmail(await requireModule('lifecycle'),caseId,mailId)};}
  catch(error){return {ok:false as const,error:error instanceof Error&&error.name==='V9Error'?error.message:'The updated copy could not be prepared. Refresh and try again.'};}
}
