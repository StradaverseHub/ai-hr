'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getBrowserCommandSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz-model';
import { CapacityRefused, parseBaselineDays, setCapacityBaseline } from '@/core/capacity/baseline';
import { CAPACITY_ITEMS } from '@/core/capacity/types';

/** AI v2 Phase 2, P2-4 — AI Centre › Insights › HR capacity: an administrator sets a company's baseline.
 *
 * The service checks the administrator again, and the database refuses a baseline for a company they do not administer
 * (migration 0966). The event log's measure is recomputed by the service, never read from the form. Returns to the
 * Insights view with a closed result code the page translates; no other text crosses. */
const PAGE = '/assistant';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: FormDataEntryValue | null) => (typeof value === 'string' ? value : '');

export async function setCapacityBaselineAction(formData: FormData) {
  const company = text(formData.get('company')), days = parseBaselineDays(formData.get('days'));
  const back = new URLSearchParams({ view: 'insights' });
  if (UUID.test(company)) back.set('company', company);
  let saved: number | null = null, error: 'invalid' | 'empty' | 'not_administrator' | 'conflict' | 'failed' | null = null;
  try {
    if (!UUID.test(company)) throw new CapacityRefused('invalid');
    const s = await getBrowserCommandSession();
    if (!s.userId || s.agent || !isAdmin(s)) throw new CapacityRefused('not_administrator');
    const entered: Record<string, string> = {};
    for (const item of CAPACITY_ITEMS) entered[item] = text(formData.get(`minutes.${item}`));
    saved = (await setCapacityBaseline(s, { companyId: company, days, minutesPerStaffAction: text(formData.get('minutesPerStaffAction')), entered })).version;
  } catch (e) {
    error = e instanceof CapacityRefused ? e.reason : 'failed';
  }
  if (error) { back.set('setup', company); back.set('days', String(days)); back.set('error', error); }
  else back.set('saved', String(saved));
  revalidatePath(PAGE);
  redirect(`${PAGE}?${back}`);
}
