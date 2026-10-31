'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { scopedSession } from '@/lib/scope';
import { publicErrorMessage } from '@/lib/public-error';
import { decideRewardUnit, sendReadyRewardUnits } from '@/packs/rewards/service';

const BOARD = '/rewards/approvals';
const str = (f: FormData, key: string) => String(f.get(key) ?? '').trim();
const errorText = (e: unknown) => e instanceof ZodError ? e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : publicErrorMessage(e);
const back = (params: Record<string, string>) => `${BOARD}?${new URLSearchParams(params).toString()}`;

/** One row's decision from the board: the same decideRewardUnit call the review page's button makes. */
export async function boardDecideAction(f: FormData) {
  const { s } = await scopedSession();
  const action = str(f, 'action');
  if (action !== 'submit' && action !== 'approve') redirect(back({ error: 'Choose a decision.' }));
  try { await decideRewardUnit(s, str(f, 'unitId'), Number(str(f, 'revision')), action, ''); }
  catch (e) { redirect(back({ error: errorText(e) })); }
  revalidatePath('/rewards', 'layout');
  redirect(back({ decided: '1' }));
}

/** "Send all ready": every waiting approval-step review the viewer saw, each through decideRewardUnit. */
export async function sendReadyAction(f: FormData) {
  const { s, scopeIds } = await scopedSession();
  const seen = f.getAll('seen').map(String).map(v => { const [unitId, revision] = v.split(':'); return { unitId, revision: Number(revision) }; });
  let result: Awaited<ReturnType<typeof sendReadyRewardUnits>>;
  try { result = await sendReadyRewardUnits(s, scopeIds, seen); }
  catch (e) { redirect(back({ error: errorText(e) })); }
  revalidatePath('/rewards', 'layout');
  redirect(back({ sent: String(result.sent.length), skipped: String(result.skipped.length), refused: String(result.refused.length), ...(result.refused.length ? { refusedDetail: JSON.stringify(result.refused.map(r => [r.name, r.message])) } : {}) }));
}
