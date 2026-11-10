/**
 * Recruitment slice 1 — the deterministic rules (packs/recruitment/model.ts) behind acceptance cases 2–7 and 9
 * (docs/recruitment-reconstruction/specification.md "Slice 1 acceptance cases"). No database: the service runs
 * every write through these functions and test/recruitment-service.test.ts proves the same refusals end to end
 * and under row security.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ARCHIVE_REASONS, DEFAULT_PROCESS, DEFAULT_STAGES, JOB_STATUSES, RecruitmentError, appliedEvent, canChangeJobStatus,
  enabledStagesInOrder, firstStage, jobTab, moveEvent, planMoveForward, planMoveTo, planReject, processChangeRefused, rejectEvent,
  validateCandidateInput, validateJobInput, type JobStatus, type ProcessStage,
} from '../packs/recruitment/model';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const COMPANY = id(900), GRADE = id(901), PROCESS = id(902);
const validJob = {
  companyId: COMPANY, title: 'Fictional payroll analyst', jobGradeIds: [GRADE], workLocation: 'Kuala Lumpur',
  recruitmentType: 'budgeted', employmentType: 'full_time',
};
const refusal = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof RecruitmentError ? e.code : `not a RecruitmentError: ${String(e)}`; }
  return 'no refusal';
};

describe('case 2 — seed defaults', () => {
  it('nine ordered stages with types, the two system defaults first and last; Hired and Archived are not stages', () => {
    expect(DEFAULT_STAGES.map((s) => s.name)).toEqual([
      'Application Review', "Recruiter's Screening", 'AI Interview', 'Hiring Manager Review', 'Interview', 'Offer',
      'Medical check-up', 'Background check', 'Onboarding',
    ]);
    expect(DEFAULT_STAGES.filter((s) => s.systemKey).map((s) => [s.name, s.type, s.systemKey])).toEqual([
      ['Application Review', 'system_default', 'application_review'], ['Onboarding', 'system_default', 'onboarding'],
    ]);
    expect(DEFAULT_STAGES.map((s) => s.type)).toEqual(['system_default', 'screening', 'test', 'screening', 'interview', 'offer', 'none', 'none', 'system_default']);
    expect(DEFAULT_STAGES.some((s) => /hired|archived/i.test(s.name))).toBe(false);
    expect(new Set(DEFAULT_STAGES.map((s) => s.seedKey)).size).toBe(DEFAULT_STAGES.length);
    expect(DEFAULT_PROCESS.name).toBe('Recruitment process');
  });

  it('seven default archive reasons, the first with a distinct internal reason', () => {
    expect(DEFAULT_ARCHIVE_REASONS.map((r) => r.external)).toEqual([
      'Skills or experience mismatch', 'No response', 'Job requisition has been changed', 'Package mismatch',
      'Company culture mismatch', 'Reject', 'Other',
    ]);
    expect(DEFAULT_ARCHIVE_REASONS[0].internal).toBe('Lack of capacity');
    expect(new Set(DEFAULT_ARCHIVE_REASONS.map((r) => r.seedKey)).size).toBe(7);
  });
});

describe('case 3 — required job fields are refused by the rule, not only the form', () => {
  it('accepts the six required fields and defaults the rest', () => {
    const result = validateJobInput(validJob);
    expect(result).toEqual({ ok: true, value: expect.objectContaining({
      companyId: COMPANY, title: 'Fictional payroll analyst', jobGradeIds: [GRADE], positionAttribute: 'regular', processId: null,
      description: null, departmentId: null, businessUnitId: null, replacedEmploymentId: null, autoArchiveAfterReject: false,
    }) });
  });

  it.each([
    ['company', { companyId: '' }], ['title', { title: '   ' }], ['jobLevel', { jobGradeIds: [] }], ['workLocation', { workLocation: '' }],
    ['recruitmentType', { recruitmentType: 'whatever' }], ['employmentType', { employmentType: undefined }],
  ])('refuses a missing %s', (field, change) => {
    const result = validateJobInput({ ...validJob, ...change });
    expect(result).toEqual({ ok: false, code: 'missing_fields', fields: [field] });
  });

  it('names every missing field at once', () => {
    expect(validateJobInput({})).toEqual({ ok: false, code: 'missing_fields', fields: ['company', 'title', 'jobLevel', 'workLocation', 'recruitmentType', 'employmentType'] });
  });

  it('refuses malformed references and attributes', () => {
    expect(validateJobInput({ ...validJob, jobGradeIds: ['not-a-uuid'] })).toMatchObject({ ok: false, code: 'invalid_input', fields: ['jobLevel'] });
    expect(validateJobInput({ ...validJob, positionAttribute: 'temporary' })).toMatchObject({ ok: false, fields: ['positionAttribute'] });
    expect(validateJobInput({ ...validJob, departmentId: 'x' })).toMatchObject({ ok: false, fields: ['departmentId'] });
    expect(validateJobInput({ ...validJob, processId: PROCESS, positionAttribute: 'evergreen' })).toMatchObject({ ok: true, value: { processId: PROCESS, positionAttribute: 'evergreen' } });
  });
});

describe('case 4 — job status machine and tabs', () => {
  const allowed: [JobStatus, JobStatus][] = [['open', 'on_hold'], ['on_hold', 'open'], ['open', 'closed'], ['on_hold', 'closed'], ['closed', 'open']];
  it('allows exactly Open ↔ On hold, Open/On hold → Closed and the Closed → Open reopen decision', () => {
    for (const from of JOB_STATUSES) for (const to of JOB_STATUSES) {
      expect(canChangeJobStatus(from, to), `${from} → ${to}`).toBe(allowed.some(([a, b]) => a === from && b === to));
    }
  });
  it('Opening holds Open and On hold; Closed holds Closed', () => {
    expect(JOB_STATUSES.map(jobTab)).toEqual(['opening', 'opening', 'closed']);
  });
});

describe('case 5 — the process is fixed once a job has an application', () => {
  it('refuses only a real change on a job with applications', () => {
    expect(processChangeRefused(PROCESS, id(903), true)).toBe(true);
    expect(processChangeRefused(PROCESS, id(903), false)).toBe(false);
    expect(processChangeRefused(PROCESS, PROCESS, true)).toBe(false);
  });
});

describe('case 6 — start and move forward', () => {
  const stages: ProcessStage[] = [
    { stageId: id(1), position: 1, enabled: true },
    { stageId: id(2), position: 2, enabled: false },
    { stageId: id(3), position: 3, enabled: true },
    { stageId: id(4), position: 4, enabled: true },
  ];
  it('starts at the first ENABLED stage', () => {
    expect(firstStage(stages)).toBe(id(1));
    expect(firstStage([{ ...stages[0], enabled: false }, ...stages.slice(1)])).toBe(id(3));
    expect(firstStage([])).toBeNull();
    expect(enabledStagesInOrder([...stages].reverse()).map((s) => s.stageId)).toEqual([id(1), id(3), id(4)]);
  });
  it('moves forward to the next enabled stage, skipping a disabled one, and hires from the last', () => {
    expect(planMoveForward(stages, id(1))).toEqual({ kind: 'moved', from: id(1), to: id(3) });
    expect(planMoveForward(stages, id(3))).toEqual({ kind: 'moved', from: id(3), to: id(4) });
    expect(planMoveForward(stages, id(4))).toEqual({ kind: 'hired', from: id(4) });
  });
  it('an application left in a stage disabled after it entered still moves on', () => {
    expect(planMoveForward(stages, id(2))).toEqual({ kind: 'moved', from: id(2), to: id(3) });
  });
  it('a chosen target must be another enabled stage of the same process', () => {
    expect(planMoveTo(stages, id(1), id(4))).toEqual({ kind: 'moved', from: id(1), to: id(4) });
    expect(planMoveTo(stages, id(4), id(1))).toEqual({ kind: 'moved', from: id(4), to: id(1) });
    expect(refusal(() => planMoveTo(stages, id(1), id(2)))).toBe('stage_unavailable');
    expect(refusal(() => planMoveTo(stages, id(1), id(1)))).toBe('stage_unavailable');
    expect(refusal(() => planMoveTo(stages, id(1), id(99)))).toBe('stage_not_in_process');
    expect(refusal(() => planMoveForward(stages, id(99)))).toBe('stage_not_in_process');
  });
});

describe('case 7 — reject needs a reason and keeps the stage left', () => {
  it('refuses without a reason', () => {
    expect(refusal(() => planReject(id(3), undefined))).toBe('reason_required');
    expect(refusal(() => planReject(id(3), ''))).toBe('reason_required');
    expect(refusal(() => planReject(id(3), 'Other'))).toBe('reason_required');
  });
  it('records the stage left', () => {
    expect(planReject(id(3), id(50))).toEqual({ stageLeft: id(3), reasonId: id(50) });
  });
});

describe('case 9 — every move and rejection has one history shape', () => {
  it('maps apply, move, hire and reject onto the append-only event shapes', () => {
    expect(appliedEvent(id(1))).toEqual({ kind: 'applied', fromStageId: null, toStageId: id(1), fromState: null, toState: 'active', archiveReasonId: null });
    expect(moveEvent({ kind: 'moved', from: id(1), to: id(3) })).toEqual({ kind: 'moved', fromStageId: id(1), toStageId: id(3), fromState: 'active', toState: 'active', archiveReasonId: null });
    expect(moveEvent({ kind: 'hired', from: id(4) })).toEqual({ kind: 'hired', fromStageId: id(4), toStageId: null, fromState: 'active', toState: 'hired', archiveReasonId: null });
    expect(rejectEvent({ stageLeft: id(3), reasonId: id(50) })).toEqual({ kind: 'rejected', fromStageId: id(3), toStageId: null, fromState: 'active', toState: 'archived', archiveReasonId: id(50) });
  });
});

describe('add application — candidate fields', () => {
  it('requires a name and refuses malformed contact details', () => {
    expect(validateCandidateInput({ fullName: ' Fictional Candidate ', email: 'Fictional@Example.test' })).toEqual({ ok: true, value: { fullName: 'Fictional Candidate', email: 'fictional@example.test', phone: null, source: null } });
    expect(validateCandidateInput({ fullName: '' })).toEqual({ ok: false, fields: ['fullName'] });
    expect(validateCandidateInput({ fullName: 'A', email: 'no-at-sign' })).toEqual({ ok: false, fields: ['email'] });
  });
});
