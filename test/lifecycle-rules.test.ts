/**
 * Lifecycle rules (ADR-0095) — the pure decisions: which steps apply, which are locked, when a case is
 * complete, the approval chain, and the reference data's own consistency with the handover.
 */
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_LEVELS_BY_COMPANY, ASSET_CATALOGUE, OFFBOARDING_STEPS, ONBOARDING_STEPS, REQUISITION_BY_COMPANY, REQUISITION_COMMON, RETURN_BY_COMPANY, RETURN_COMMON,
} from '../core/lifecycle-defaults';
import {
  buildStepViews, canAdvanceRequest, daysBetween, initialApprovalStatus, isCaseComplete, maskId, nextApproval, phaseUnlocked, progressOf, type CaseFacts, type StepDef,
} from '../core/lifecycle-rules';

const toDefs = (steps: typeof ONBOARDING_STEPS): StepDef[] =>
  steps.map((d, i) => ({ key: d.key, phase: d.phase, label: d.label, ownerTeam: d.ownerTeam, hrms: d.hrms === true, rule: d.rule, sort: (i + 1) * 10 }));
const onb = (o: Partial<CaseFacts> = {}): CaseFacts => ({ kind: 'onboarding', status: 'in_progress', laptopRequired: true, carparkRequired: true, outcome: 'pending', ...o });
const ofb = (o: Partial<CaseFacts> = {}): CaseFacts => ({ kind: 'offboarding', status: 'in_progress', laptopRequired: false, carparkRequired: false, outcome: 'pending', ...o });

describe('reference data matches the handover', () => {
  it('has 20 onboarding steps in 3 phases and 21 offboarding steps in 2', () => {
    expect(ONBOARDING_STEPS).toHaveLength(20);
    expect(new Set(ONBOARDING_STEPS.map((s) => s.phase))).toEqual(new Set([0, 1, 2]));
    expect(OFFBOARDING_STEPS).toHaveLength(21);
    expect(new Set(OFFBOARDING_STEPS.map((s) => s.phase))).toEqual(new Set([0, 1]));
  });
  it('has 6 retention steps and 11 processing steps', () => {
    expect(OFFBOARDING_STEPS.filter((s) => s.rule === 'outcome_rejected')).toHaveLength(6);
    expect(OFFBOARDING_STEPS.filter((s) => s.rule === 'outcome_accepted')).toHaveLength(11);
  });
  it('keys are unique per list', () => {
    expect(new Set(ONBOARDING_STEPS.map((s) => s.key)).size).toBe(20);
    expect(new Set(OFFBOARDING_STEPS.map((s) => s.key)).size).toBe(21);
  });
  it('has the checklists, approval levels and catalogue of the handover', () => {
    expect(REQUISITION_COMMON).toHaveLength(8);
    expect(RETURN_COMMON).toHaveLength(12);
    expect(REQUISITION_BY_COMPANY.CHGP).toHaveLength(4);
    expect(REQUISITION_BY_COMPANY.SIGN).toHaveLength(5);
    expect(RETURN_BY_COMPANY.CHGP).toHaveLength(4);
    expect(RETURN_BY_COMPANY.SIGN).toHaveLength(5);
    expect(APPROVAL_LEVELS_BY_COMPANY).toEqual({ CHBM: 2, CHCE: 2, CHGP: 0, SIGN: 1, FIAMMA: 1 });
    expect(ASSET_CATALOGUE).toHaveLength(12);
    expect(ASSET_CATALOGUE.filter((c) => c.approvalLevels === 2).map((c) => c.itemCode)).toEqual(['HW-001', 'HW-002', 'HW-005', 'HW-006', 'SW-004']);
  });
});

describe('onboarding step rules', () => {
  it('skips the car park step without a car park and the acknowledgement without a laptop', () => {
    const views = buildStepViews(toDefs(ONBOARDING_STEPS), [], onb({ carparkRequired: false, laptopRequired: false }));
    expect(views.find((v) => v.key === 'carpark')!.applicability).toBe('na');
    expect(views.find((v) => v.key === 'daa_ack')!.applicability).toBe('na');
    expect(views.find((v) => v.key === 'carpark')!.blocked).toBe('not_applicable');
  });
  it('keeps both applicable when required', () => {
    const views = buildStepViews(toDefs(ONBOARDING_STEPS), [], onb());
    expect(views.find((v) => v.key === 'carpark')!.applicability).toBe('applicable');
    expect(views.find((v) => v.key === 'daa_ack')!.applicability).toBe('applicable');
  });
  it('locks Day 1 until every applicable pre-onboarding step is done', () => {
    const defs = toDefs(ONBOARDING_STEPS);
    const phase0 = defs.filter((d) => d.phase === 0).map((d) => ({ key: d.key, done: true }));
    const almost = phase0.map((r) => (r.key === 'welcome_mail' ? { ...r, done: false } : r));
    expect(buildStepViews(defs, almost, onb()).find((v) => v.key === 'tour')!.blocked).toBe('phase_locked');
    expect(buildStepViews(defs, phase0, onb()).find((v) => v.key === 'tour')!.blocked).toBeNull();
  });
  it('does not let a skipped step hold a phase lock', () => {
    const defs = toDefs(ONBOARDING_STEPS);
    const phase0 = defs.filter((d) => d.phase === 0 && d.key !== 'carpark').map((d) => ({ key: d.key, done: true }));
    expect(buildStepViews(defs, phase0, onb({ carparkRequired: false })).find((v) => v.key === 'tour')!.blocked).toBeNull();
  });
  it('locks Day 7-14 until Day 1 is done', () => {
    const defs = toDefs(ONBOARDING_STEPS);
    const through0 = defs.filter((d) => d.phase === 0).map((d) => ({ key: d.key, done: true }));
    expect(buildStepViews(defs, through0, onb()).find((v) => v.key === 'bg_intro')!.blocked).toBe('phase_locked');
  });
  it('refuses everything on a cancelled case', () => {
    const views = buildStepViews(toDefs(ONBOARDING_STEPS), [], onb({ status: 'cancelled' }));
    expect(views.every((v) => v.blocked === 'cancelled')).toBe(true);
  });
  it('completes only when every applicable step is done', () => {
    const defs = toDefs(ONBOARDING_STEPS);
    const all = defs.map((d) => ({ key: d.key, done: true }));
    expect(isCaseComplete(buildStepViews(defs, all, onb()), { kind: 'onboarding', outcome: 'pending' })).toBe(true);
    expect(isCaseComplete(buildStepViews(defs, all.slice(1), onb()), { kind: 'onboarding', outcome: 'pending' })).toBe(false);
    expect(progressOf(buildStepViews(defs, all, onb()))).toEqual({ done: 20, total: 20, percent: 100 });
  });
});

describe('offboarding outcome rules', () => {
  const defs = toDefs(OFFBOARDING_STEPS);
  it('Pending: retention steps workable, processing steps locked (not N/A)', () => {
    const v = buildStepViews(defs, [], ofb());
    expect(v.find((x) => x.key === 'retention_bg_approval')!.blocked).toBeNull();
    expect(v.find((x) => x.key === 'it_asset_return')!.blocked).toBe('outcome_pending');
    expect(v.find((x) => x.key === 'it_asset_return')!.applicability).toBe('pending_outcome');
  });
  it('Accepted: retention N/A, processing applicable', () => {
    const v = buildStepViews(defs, [], ofb({ outcome: 'accepted' }));
    expect(v.filter((x) => x.rule === 'outcome_rejected').every((x) => x.applicability === 'na')).toBe(true);
    expect(v.filter((x) => x.rule === 'outcome_accepted').every((x) => x.applicability === 'applicable')).toBe(true);
    expect(progressOf(v).total).toBe(4 + 11);
  });
  it('Rejected: processing N/A, retention applicable', () => {
    const v = buildStepViews(defs, [], ofb({ outcome: 'rejected' }));
    expect(v.filter((x) => x.rule === 'outcome_accepted').every((x) => x.applicability === 'na')).toBe(true);
    expect(progressOf(v).total).toBe(4 + 6);
  });
  it('is never complete while the outcome is pending', () => {
    const all = defs.map((d) => ({ key: d.key, done: true }));
    expect(isCaseComplete(buildStepViews(defs, all, ofb()), { kind: 'offboarding', outcome: 'pending' })).toBe(false);
    expect(isCaseComplete(buildStepViews(defs, all, ofb({ outcome: 'accepted' })), { kind: 'offboarding', outcome: 'accepted' })).toBe(true);
  });
  it('has no phase lock beyond the outcome (offboarding is not phase-chained)', () => {
    expect(phaseUnlocked(0, [])).toBe(true);
  });
});

describe('approval chain', () => {
  const s = (o: Partial<Parameters<typeof nextApproval>[0]> = {}) => ({ levels: 2, status: 'pending' as const, l1Action: null, l2Action: null, l1By: null, ...o });
  it('zero levels counts as approved and cannot be decided', () => {
    expect(initialApprovalStatus(0)).toBe('approved');
    expect(initialApprovalStatus(1)).toBe('pending');
    expect(nextApproval(s({ levels: 0, status: 'approved' }), 'approve', 'a', 'x')).toEqual({ ok: false, error: 'no_approval_needed' });
  });
  it('one level approves straight through', () => {
    expect(nextApproval(s({ levels: 1 }), 'approve', 'a', 'x')).toEqual({ ok: true, level: 1, status: 'approved' });
  });
  it('two levels: L1 gives pending L2, then L2 approves; the chain cannot be skipped', () => {
    expect(nextApproval(s(), 'approve', 'a', 'x')).toEqual({ ok: true, level: 1, status: 'pending_l2' });
    expect(nextApproval(s({ status: 'pending_l2', l1By: 'a' }), 'approve', 'b', 'x')).toEqual({ ok: true, level: 2, status: 'approved' });
  });
  it('rejection is possible at either level', () => {
    expect(nextApproval(s(), 'reject', 'a', 'x')).toEqual({ ok: true, level: 1, status: 'rejected' });
    expect(nextApproval(s({ status: 'pending_l2', l1By: 'a' }), 'reject', 'b', 'x')).toEqual({ ok: true, level: 2, status: 'rejected' });
  });
  it('refuses self-approval, the same person at both levels, and a second decision', () => {
    expect(nextApproval(s(), 'approve', 'x', 'x')).toEqual({ ok: false, error: 'self_approval' });
    expect(nextApproval(s({ status: 'pending_l2', l1By: 'a' }), 'approve', 'a', 'x')).toEqual({ ok: false, error: 'same_approver' });
    expect(nextApproval(s({ status: 'approved' }), 'approve', 'a', 'x')).toEqual({ ok: false, error: 'already_decided' });
    expect(nextApproval(s({ status: 'rejected' }), 'approve', 'a', 'x')).toEqual({ ok: false, error: 'already_decided' });
  });
});

describe('asset request fulfilment', () => {
  it('moves forward one step at a time, only from approved', () => {
    expect(canAdvanceRequest('approved', 'procured')).toBe(true);
    expect(canAdvanceRequest('procured', 'tagged')).toBe(true);
    expect(canAdvanceRequest('tagged', 'assigned')).toBe(true);
    expect(canAdvanceRequest('assigned', 'completed')).toBe(true);
    expect(canAdvanceRequest('approved', 'assigned')).toBe(false);
    expect(canAdvanceRequest('requested', 'procured')).toBe(false);
    expect(canAdvanceRequest('pending_approval', 'procured')).toBe(false);
    expect(canAdvanceRequest('tagged', 'procured')).toBe(false);
  });
});

describe('helpers', () => {
  it('counts days and masks identity numbers to the last four', () => {
    expect(daysBetween('2026-10-08', '2026-10-11')).toBe(3);
    expect(daysBetween('2026-10-11', '2026-10-08')).toBe(-3);
    expect(maskId('900101-14-5678')).toBe('**********5678');
    expect(maskId('AB1')).toBe('****');
    expect(maskId(null)).toBe('');
  });
});
