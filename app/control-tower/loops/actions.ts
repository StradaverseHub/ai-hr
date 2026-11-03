'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getBrowserCommandSession } from '@/lib/session';
import { isAdmin, isGroupAdmin } from '@/lib/authz-model';
import { setWorkerSwitch, WorkerControlRefused } from '@/core/agent-registry/controls';
import { LoopControlRefused, setLoopPause } from '@/core/loops/controls';
import { isLoopId } from '@/core/loops/types';

/** AI v2 W8 — AI Centre › Operations › Loops. Two commands, each re-checked by its service and by the database:
 *  - a group administrator switches a loop on or off for the whole group (the registry switch, setWorkerSwitch, which
 *    checks the role and the loop's module again, audits the change and records it); whoever switches it on becomes
 *    its sponsor;
 *  - an administrator of a company pauses or resumes a loop for that company (setLoopPause).
 * Each returns to the page it was posted from with a closed result code the page translates; no other text crosses. */
const PAGE = '/control-tower/loops';
const back = (loop: unknown, from: unknown) => (from === 'detail' && isLoopId(loop) ? `${PAGE}/${loop}` : PAGE);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function setLoopSwitchAction(formData: FormData) {
  const loop = formData.get('loop'), enabled = formData.get('enabled'), target = back(loop, formData.get('from'));
  let error: 'invalid' | 'refused' | 'module' | 'failed' | null = null;
  try {
    if (!isLoopId(loop) || (enabled !== 'true' && enabled !== 'false')) throw new LoopControlRefused('invalid');
    const s = await getBrowserCommandSession();
    if (!s.userId || s.agent || !isGroupAdmin(s)) throw new WorkerControlRefused('not_administrator');
    await setWorkerSwitch(s, { workerId: loop, enabled: enabled === 'true' });
  } catch (e) {
    error = e instanceof LoopControlRefused ? 'invalid' : e instanceof WorkerControlRefused ? (e.reason === 'module_not_enabled' ? 'module' : 'refused') : 'failed';
  }
  revalidatePath(PAGE, 'layout');
  redirect(`${target}?${new URLSearchParams(error ? { error } : { saved: 'switch' })}`);
}

export async function setLoopPauseAction(formData: FormData) {
  const loop = formData.get('loop'), company = formData.get('company'), paused = formData.get('paused'), target = back(loop, formData.get('from'));
  let error: 'invalid' | 'refused' | 'failed' | null = null;
  try {
    if (!isLoopId(loop) || typeof company !== 'string' || !UUID.test(company) || (paused !== 'true' && paused !== 'false')) throw new LoopControlRefused('invalid');
    const s = await getBrowserCommandSession();
    if (!s.userId || s.agent || !isAdmin(s)) throw new LoopControlRefused('not_administrator');
    await setLoopPause(s, { workerId: loop, companyId: company, paused: paused === 'true' });
  } catch (e) {
    error = e instanceof LoopControlRefused ? (e.reason === 'invalid' ? 'invalid' : 'refused') : 'failed';
  }
  revalidatePath(PAGE, 'layout');
  redirect(`${target}?${new URLSearchParams(error ? { error } : { saved: 'pause' })}`);
}
