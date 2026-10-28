'use server';
/**
 * D-P1-22 X5 (ADR-0150) — the "Units not taking part" card's actions. Each one calls the unit exclusion service as
 * the signed-in viewer and returns the service's own refusal as text: authority, the plan, the digest and the
 * revision check are decided there (and by RLS), never here.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSession } from '@/lib/session';
import { publicErrorMessage } from '@/lib/public-error';
import * as perf from '@/packs/performance/service';
import type { UnitExclusionPreviewView } from '@/packs/performance/service';

export type UnitExclusionActionResult<T = null> = { ok: true; data: T } | { error: string };
export type UnitExclusionScopeInput = { cycleId: string; companyId: string; departmentId: string | null };

const uuid = z.uuid();
async function run<T>(cycleId: string, write: boolean, body: () => Promise<T>): Promise<UnitExclusionActionResult<T>> {
  try {
    const id = uuid.parse(cycleId);
    const data = await body();
    if (write) revalidatePath(`/performance/${id}`);
    return { ok: true, data };
  } catch (error) {
    return { error: publicErrorMessage(error) };
  }
}

export async function previewUnitExclusionAction(input: UnitExclusionScopeInput): Promise<UnitExclusionActionResult<UnitExclusionPreviewView>> {
  const s = await getSession();
  return run(input.cycleId, false, () => perf.previewUnitExclusionScreen(s, input.cycleId, { companyId: input.companyId, departmentId: input.departmentId }));
}

export async function saveUnitExclusionAction(input: UnitExclusionScopeInput & { digest: string; revision: number }): Promise<UnitExclusionActionResult<{ alreadyActive: boolean }>> {
  const s = await getSession();
  return run(input.cycleId, true, async () => {
    const saved = await perf.saveUnitExclusion(s, input.cycleId, { companyId: input.companyId, departmentId: input.departmentId, digest: input.digest, revision: input.revision });
    return { alreadyActive: saved.alreadyActive };
  });
}

export async function endUnitExclusionAction(input: { cycleId: string; ruleId: string; revision: number }): Promise<UnitExclusionActionResult> {
  const s = await getSession();
  return run(input.cycleId, true, async () => { await perf.endUnitExclusion(s, input.ruleId, { revision: input.revision }); return null; });
}
