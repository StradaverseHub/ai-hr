'use server';
import { revalidatePath } from 'next/cache';
import { requireModule } from '@/lib/authz';
import { v9OwnDocument, v9OwnTask } from '@/packs/lifecycle/service';
import type { Signature } from '@/lib/lifecycle-v9-model';
export async function saveOwnLifecycleDocument(input: { caseId: string; revision: number; documentId: string; values: Record<string, string>; signature?: Pick<Signature, 'method' | 'value' | 'consent'> }) {
  try { await v9OwnDocument(await requireModule('lifecycle'), input); revalidatePath('/me/lifecycle'); revalidatePath('/lifecycle/v9'); return { ok: true as const }; }
  catch { return { ok: false as const, error: 'The document could not be saved. Check required fields, refresh the case and try again.' }; }
}
export async function updateOwnLifecycleTask(input: { caseId: string; revision: number; taskId: string; status: 'todo' | 'progress' | 'done'; reason: string }) {
  try { await v9OwnTask(await requireModule('lifecycle'), input); revalidatePath('/me/lifecycle'); revalidatePath('/lifecycle/v9'); return { ok: true as const }; }
  catch { return { ok: false as const, error: 'The task could not be updated. Refresh and check whether it has opened or has a linked document.' }; }
}
