'use server';
/**
 * WP-B2 — Leaders screen actions. Each one calls the leader seat service as the signed-in viewer and returns
 * the service's own refusal as text: authority is decided there (and by RLS), never here.
 */
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { publicErrorMessage } from '@/lib/public-error';
import * as perf from '@/packs/performance/service';
import type { ActionResult, GeneratedScopesView, GroupMemberView, HodPreviewView, LeaderSeatKind } from './model';

const PATH = '/performance/leaders';
async function run<T>(write: boolean, body: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await body();
    if (write) revalidatePath(PATH);
    return { ok: true, data };
  } catch (error) {
    return { error: publicErrorMessage(error) };
  }
}

export type HodChangeRequest = { subjectEmploymentIds: string[]; hodEmploymentId: string | null };

export async function previewHodChangeAction(input: HodChangeRequest): Promise<ActionResult<HodPreviewView>> {
  const s = await getSession();
  return run(false, async () => {
    const plan = await perf.previewHodChange(s, { subjectEmploymentIds: input.subjectEmploymentIds, hodEmploymentId: input.hodEmploymentId });
    return {
      rows: plan.rows.map((r) => ({ subjectEmploymentId: r.subjectEmploymentId, subjectName: r.subjectName, subjectEmployeeCode: r.subjectEmployeeCode, companyName: r.companyName, departmentName: r.departmentName, currentHodName: r.currentHodName, nextHodName: r.nextHodName })),
      unchanged: plan.unchanged, selfExcluded: plan.selfExcluded, blockers: plan.blockers, warnings: plan.warnings, fingerprint: plan.fingerprint,
    };
  });
}

export async function applyHodChangeAction(input: HodChangeRequest & { fingerprint: string; acknowledged: boolean; overrideReason?: string }): Promise<ActionResult<{ changed: number }>> {
  const s = await getSession();
  return run(true, async () => {
    const r = await perf.applyHodChange(s, {
      subjectEmploymentIds: input.subjectEmploymentIds, hodEmploymentId: input.hodEmploymentId, fingerprint: input.fingerprint,
      acknowledged: input.acknowledged, overrideReason: input.overrideReason?.trim() || undefined,
    });
    return { changed: r.changed };
  });
}

export async function appointLeaderSeatAction(input: { seatType: LeaderSeatKind; companyId: string | null; calibrationGroupId: string | null; holderEmploymentId: string }): Promise<ActionResult<{ unchanged: boolean }>> {
  const s = await getSession();
  return run(true, async () => {
    const r = await perf.appointLeaderSeat(s, { seatType: input.seatType, companyId: input.companyId, calibrationGroupId: input.calibrationGroupId, holderEmploymentId: input.holderEmploymentId });
    return { unchanged: r.unchanged };
  });
}

export async function endLeaderSeatAction(seatId: string): Promise<ActionResult> {
  const s = await getSession();
  return run(true, async () => { await perf.endLeaderSeat(s, seatId); return null; });
}

export async function createCalibrationGroupAction(name: string): Promise<ActionResult> {
  const s = await getSession();
  return run(true, async () => { await perf.createCalibrationGroup(s, { name }); return null; });
}

export async function renameCalibrationGroupAction(groupId: string, name: string): Promise<ActionResult> {
  const s = await getSession();
  return run(true, async () => { await perf.renameCalibrationGroup(s, groupId, { name }); return null; });
}

export async function calibrationGroupMembersAction(groupId: string): Promise<ActionResult<GroupMemberView[]>> {
  const s = await getSession();
  return run(false, async () => (await perf.listCalibrationGroupMembers(s, groupId)).map((m) => ({ id: m.id, employmentId: m.employmentId, name: m.name, employeeCode: m.employeeCode })));
}

export async function addCalibrationGroupMembersAction(groupId: string, employmentIds: string[]): Promise<ActionResult> {
  const s = await getSession();
  return run(true, async () => { await perf.addCalibrationGroupMembers(s, groupId, { employmentIds }); return null; });
}

export async function endCalibrationGroupMemberAction(memberId: string): Promise<ActionResult> {
  const s = await getSession();
  return run(true, async () => { await perf.endCalibrationGroupMember(s, memberId); return null; });
}

/** Cycle administration: one anchored calibration scope per leader, idempotent; returns the counts. */
export async function generateCalibrationScopesAction(cycleId: string): Promise<ActionResult<GeneratedScopesView>> {
  const s = await getSession();
  try {
    const r = await perf.generateCalibrationScopes(s, cycleId);
    revalidatePath(`/performance/${cycleId}`);
    const added = r.extended.reduce((n, e) => n + e.added, 0);
    return { ok: true, data: { created: r.created.length, extended: r.extended.length, added, skipped: r.skipped.length, people: r.created.reduce((n, c) => n + c.people, 0) + added } };
  } catch (error) {
    return { error: publicErrorMessage(error) };
  }
}
