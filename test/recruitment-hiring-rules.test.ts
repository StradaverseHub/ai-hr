/**
 * Recruitment slices 2–4 — the deterministic rules (packs/recruitment/hiring-model.ts) behind acceptance cases 12,
 * 13, 14 and 17 (docs/recruitment-reconstruction/specification.md "Slices 2–4 acceptance cases"). No database and no
 * clock: "now" and "today" are passed in. test/recruitment-slices-service.test.ts proves the same rules end to end,
 * under row security and against the 5702–5704 guards.
 */
import { describe, expect, it } from 'vitest';
import { RecruitmentError } from '../packs/recruitment/model';
import {
  DEFAULT_EVALUATION_FORM, DEFAULT_OFFER_FIELDS, approvalFieldsChanged, approvalSteps, canMoveRequisition, canonicalDecimal, decideApproval,
  effectiveRequisitionStatus, feedbackEditable, formatFormDefinition, hireHandoffEligible, interviewStatus, jobAccess, klLocalToInstant, offerExpiresOn,
  offerLabel, parseFormDefinition, requiredRequisitionFieldsChanged, requisitionMoves, sectionTotals, startApproval, vacancyCounts, validateInterviewInput,
  validateOfferValues, validateRequisitionInput, validateScorecard, withdrawApproval, type OfferFieldDef, type OfferValue,
} from '../packs/recruitment/hiring-model';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const refusal = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof RecruitmentError ? e.code : `not a RecruitmentError: ${String(e)}`; }
  return 'no refusal';
};

describe('slice 2 — team access mirror', () => {
  it('recruiter/assistant operate; hiring manager reviews; an interviewer only reads what they interview', () => {
    expect(jobAccess(false, ['recruiter'])).toEqual({ operate: true, review: true, read: true });
    expect(jobAccess(false, ['assistant'])).toEqual({ operate: true, review: true, read: true });
    expect(jobAccess(false, ['hiring_manager'])).toEqual({ operate: false, review: true, read: true });
    expect(jobAccess(false, ['interviewer'])).toEqual({ operate: false, review: false, read: false });
    expect(jobAccess(false, ['interviewer'], true)).toEqual({ operate: false, review: false, read: true });
    expect(jobAccess(true, [])).toEqual({ operate: true, review: true, read: true });
  });
});

describe('case 12 — interview status is derived', () => {
  const start = '2026-11-10T02:00:00.000Z'; // 10:00 Kuala Lumpur
  const base = { startsAt: start, durationMinutes: 60, cancelled: false, interviewers: 2, submitted: 0 };
  it('Scheduled before its start', () => {
    expect(interviewStatus(base, new Date('2026-11-10T01:59:59.000Z'))).toBe('scheduled');
  });
  it('In progress between start and end', () => {
    expect(interviewStatus(base, new Date('2026-11-10T02:30:00.000Z'))).toBe('in_progress');
  });
  it('Awaiting feedback after its end while any interviewer has not submitted', () => {
    expect(interviewStatus(base, new Date('2026-11-10T03:00:00.000Z'))).toBe('awaiting_feedback');
    expect(interviewStatus({ ...base, submitted: 1 }, new Date('2026-11-10T05:00:00.000Z'))).toBe('awaiting_feedback');
  });
  it('Feedback complete once every interviewer has submitted, and Cancelled overrides all', () => {
    expect(interviewStatus({ ...base, submitted: 2 }, new Date('2026-11-10T05:00:00.000Z'))).toBe('feedback_complete');
    expect(interviewStatus({ ...base, cancelled: true, submitted: 2 }, new Date('2026-11-10T05:00:00.000Z'))).toBe('cancelled');
  });
  it('reads the scheduling field as Kuala Lumpur wall-clock time', () => {
    expect(klLocalToInstant('2026-11-10T10:00')?.toISOString()).toBe(start);
    expect(klLocalToInstant('10/11/2026 10:00')).toBeNull();
  });
  it('validates an interview: interviewers, start and type are required; values are bounded', () => {
    const ok = validateInterviewInput({ applicationId: id(1), type: 'video', startsAt: '2026-11-10T10:00', interviewerIds: [id(2), id(2), id(3)] });
    expect(ok).toMatchObject({ ok: true, value: { roundNo: 1, durationMinutes: 60, interviewerIds: [id(2), id(3)] } });
    expect(validateInterviewInput({ applicationId: id(1), type: 'video', startsAt: '2026-11-10T10:00' })).toMatchObject({ ok: false, code: 'missing_fields', fields: ['interviewers'] });
    expect(validateInterviewInput({ applicationId: id(1), type: 'teleport', startsAt: '2026-11-10T10:00', interviewerIds: [id(2)], durationMinutes: '1' }))
      .toMatchObject({ ok: false, code: 'invalid_input', fields: ['type', 'duration'] });
  });
});

describe('scorecards — forms, validation and totals (no model involved)', () => {
  it('the seeded form is a generic five-criterion foundational assessment', () => {
    expect(DEFAULT_EVALUATION_FORM.definition.sections).toHaveLength(1);
    expect(DEFAULT_EVALUATION_FORM.definition.sections[0].criteria).toHaveLength(5);
  });
  it('the editor text round-trips into positional keys', () => {
    const def = parseFormDefinition('Technical\nProblem solving | Describe a hard problem.\nCode quality\n\nValues\nOwnership');
    expect(def.sections.map((s) => [s.key, s.title, s.criteria.map((c) => c.key)])).toEqual([['s1', 'Technical', ['s1c1', 's1c2']], ['s2', 'Values', ['s2c1']]]);
    expect(def.sections[0].criteria[0].question).toBe('Describe a hard problem.');
    expect(parseFormDefinition(formatFormDefinition(def))).toEqual(def);
    expect(refusal(() => parseFormDefinition('Only a title'))).toBe('invalid_form');
  });
  it('every criterion needs a whole 1–5 rating; notes are at most 500 words; the result follows the company setting', () => {
    const def = DEFAULT_EVALUATION_FORM.definition;
    const all = (r: unknown) => Object.fromEntries(def.sections[0].criteria.map((c) => [c.key, { rating: r }]));
    expect(validateScorecard(def, { ratings: all('4') }, true)).toMatchObject({ ok: false, code: 'missing_fields', fields: ['result'] });
    expect(validateScorecard(def, { ratings: all('4') }, false)).toMatchObject({ ok: true });
    expect(validateScorecard(def, { ratings: all('6'), result: 'recommended' }, true)).toMatchObject({ ok: false, code: 'invalid_input' });
    const long = { ...all('3'), c1: { rating: '3', notes: Array(501).fill('word').join(' ') } };
    expect(validateScorecard(def, { ratings: long, result: 'keep_in_view' }, true)).toMatchObject({ ok: false, code: 'invalid_input', fields: ['c1.notes'] });
  });
  it('a section total is the sum over 5 × criteria', () => {
    const def = DEFAULT_EVALUATION_FORM.definition;
    expect(sectionTotals(def, { c1: { rating: 5 }, c2: { rating: 4 }, c3: { rating: 3 }, c4: { rating: 2 }, c5: { rating: 1 } }))
      .toEqual([{ key: 's1', title: 'Foundational assessment', sum: 15, max: 25, rated: 5 }]);
  });
});

describe('case 13 — feedback edit lock', () => {
  const at = (stage: string, position: number | null, state: 'active' | 'hired' | 'archived' = 'active') => ({ state, currentStageId: stage, currentPosition: position });
  const interview = { stageId: 'S5', position: 5 };
  it('default: editable in the same stage or an earlier one; locked once the application moves past it or leaves the pipeline', () => {
    expect(feedbackEditable('until_stage_left', at('S5', 5), interview)).toBe(true);
    expect(feedbackEditable('until_stage_left', at('S4', 4), interview)).toBe(true);
    expect(feedbackEditable('until_stage_left', at('S6', 6), interview)).toBe(false);
    expect(feedbackEditable('until_stage_left', at('S5', 5, 'archived'), interview)).toBe(false);
    expect(feedbackEditable('until_stage_left', at('SX', null), interview)).toBe(false);
  });
  it('until archived: editable after a move, locked once archived', () => {
    expect(feedbackEditable('until_archived', at('S6', 6), interview)).toBe(true);
    expect(feedbackEditable('until_archived', at('S6', 6, 'hired'), interview)).toBe(true);
    expect(feedbackEditable('until_archived', at('S6', 6, 'archived'), interview)).toBe(false);
  });
  it('any stage: always editable', () => {
    expect(feedbackEditable('any_stage', at('S9', 9, 'archived'), interview)).toBe(true);
  });
});

describe('case 14 — ordered approval', () => {
  const [A, B, C] = [id(11), id(12), id(13)];
  it('starts at step 1; an empty flow needs no approval; the creator may not be an approver', () => {
    expect(startApproval([A, B], C)).toEqual({ approvers: [A, B], pendingPosition: 1 });
    expect(startApproval([], C)).toEqual({ approvers: [], pendingPosition: null });
    expect(refusal(() => startApproval([A, C], C))).toBe('self_approval');
  });
  it('approvers act in order, only on their own pending step; the last approval finishes', () => {
    const round = startApproval([A, B], C);
    expect(refusal(() => decideApproval(round, B, C, 'approve'))).toBe('not_your_step');
    const first = decideApproval(round, A, C, 'approve');
    expect(first).toEqual({ position: 1, decision: 'approved', pendingPosition: 2, outcome: 'pending' });
    const after = { approvers: round.approvers, pendingPosition: first.pendingPosition };
    expect(refusal(() => decideApproval(after, A, C, 'approve'))).toBe('not_your_step');
    expect(decideApproval(after, B, C, 'approve')).toEqual({ position: 2, decision: 'approved', pendingPosition: null, outcome: 'approved' });
  });
  it('a rejection ends the round (back to Draft); the creator can never decide; withdraw needs a pending step', () => {
    const round = startApproval([A, B], C);
    expect(decideApproval(round, A, C, 'reject')).toEqual({ position: 1, decision: 'rejected', pendingPosition: null, outcome: 'rejected' });
    expect(refusal(() => decideApproval({ approvers: [C], pendingPosition: 1 }, C, C, 'approve'))).toBe('self_approval');
    expect(withdrawApproval(round)).toEqual({ approvers: [A, B], pendingPosition: null });
    expect(refusal(() => withdrawApproval({ approvers: [A], pendingPosition: null }))).toBe('offer_state');
  });
  it('shows a round as approved / rejected / pending / waiting / not reached', () => {
    expect(approvalSteps({ approvers: [A, B, C], pendingPosition: 2 }, [{ position: 1, decision: 'approved' }]).map((s) => s.state))
      .toEqual(['approved', 'pending', 'waiting']);
    expect(approvalSteps({ approvers: [A, B, C], pendingPosition: null }, [{ position: 1, decision: 'rejected' }]).map((s) => s.state))
      .toEqual(['rejected', 'not_reached', 'not_reached']);
  });
  it('only a change to a field that NEEDS approval re-runs approval', () => {
    const fields: OfferFieldDef[] = [
      { id: 'f1', label: 'Basic salary', type: 'money', choices: [], required: true, needsApproval: true, private: true, enabled: true },
      { id: 'f2', label: 'Department', type: 'text', choices: [], required: false, needsApproval: false, private: false, enabled: true },
    ];
    const before = new Map<string, OfferValue>([['f1', { kind: 'money', amount: '5000.00', currency: 'MYR' }], ['f2', { kind: 'text', text: 'Finance' }]]);
    expect(approvalFieldsChanged(fields, before, new Map([...before, ['f2', { kind: 'text', text: 'Operations' }]]))).toBe(false);
    expect(approvalFieldsChanged(fields, before, new Map([...before, ['f1', { kind: 'money', amount: '5200.00', currency: 'MYR' }]]))).toBe(true);
  });
});

describe('offers — values are typed, money stays decimal text, and nothing is computed', () => {
  const fields: OfferFieldDef[] = DEFAULT_OFFER_FIELDS.map((f, i) => ({ id: `f${i}`, label: f.label, type: f.type, choices: [], required: f.required, needsApproval: f.needsApproval, private: f.private, enabled: true }));
  const byLabel = (label: string) => fields.find((f) => f.label === label)!.id;
  it('seeds generic fields; basic salary is a private money field that needs approval', () => {
    expect(DEFAULT_OFFER_FIELDS.find((f) => f.seedKey === 'basic_salary')).toMatchObject({ type: 'money', private: true, needsApproval: true, required: true });
  });
  it('refuses missing required values and wrong types; keeps amounts as canonical decimal strings', () => {
    expect(validateOfferValues(fields, {})).toMatchObject({ ok: false, code: 'missing_fields' });
    const input = {
      [byLabel('Job offered')]: { text: 'Fictional analyst' }, [byLabel('Commencement date')]: { text: '2026-12-01' },
      [byLabel('Basic salary')]: { amount: '0005,250.5', currency: 'myr' }, [byLabel('Probation (months)')]: { text: '3' },
    };
    const ok = validateOfferValues(fields, input);
    expect(ok.ok && ok.values.get(byLabel('Basic salary'))).toEqual({ kind: 'money', amount: '5250.50', currency: 'MYR' });
    expect(ok.ok && ok.values.get(byLabel('Probation (months)'))).toEqual({ kind: 'number', number: '3.0000' });
    expect(validateOfferValues(fields, { ...input, [byLabel('Commencement date')]: { text: '2026-02-30' } })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(validateOfferValues(fields, { ...input, [byLabel('Basic salary')]: { amount: '1e5', currency: 'MYR' } })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(canonicalDecimal('007.1', 2)).toBe('7.10');
  });
  it('the expiry is a label: sent day + validity days; decided offers show the decision', () => {
    expect(offerExpiresOn('2026-11-10', 15)).toBe('2026-11-25');
    const sent = { status: 'approved' as const, sentOnKl: '2026-11-10', validDays: 15, decision: 'pending' as const };
    expect(offerLabel(sent, '2026-11-25')).toBe('sent');
    expect(offerLabel(sent, '2026-11-26')).toBe('expired');
    expect(offerLabel({ ...sent, decision: 'accepted' }, '2026-12-30')).toBe('accepted');
    expect(offerLabel({ status: 'pending', sentOnKl: null, validDays: null, decision: 'pending' }, '2026-11-10')).toBe('pending');
  });
  it('"Start new hire" applies only at Onboarding or hired', () => {
    expect(hireHandoffEligible({ state: 'active', stageSystemKey: 'onboarding' })).toBe(true);
    expect(hireHandoffEligible({ state: 'hired', stageSystemKey: 'onboarding' })).toBe(true);
    expect(hireHandoffEligible({ state: 'active', stageSystemKey: null })).toBe(false);
    expect(hireHandoffEligible({ state: 'archived', stageSystemKey: 'onboarding' })).toBe(false);
  });
});

describe('case 17 — requisition statuses and vacancy counts', () => {
  const today = '2026-11-10';
  it('allowed manual moves; Draft leaves only by submitting; terminal statuses refuse everything', () => {
    expect(requisitionMoves('draft', null, today)).toEqual(['completed', 'cancelled']);
    expect(canMoveRequisition('draft', 'not_started', null, today)).toBe(false);
    expect(canMoveRequisition('not_started', 'in_progress', null, today)).toBe(true);
    expect(canMoveRequisition('in_progress', 'paused', null, today)).toBe(true);
    expect(canMoveRequisition('paused', 'in_progress', null, today)).toBe(true);
    expect(canMoveRequisition('paused', 'not_started', null, today)).toBe(false);
    expect(canMoveRequisition('not_started', 'paused', null, today)).toBe(false);
    for (const s of ['draft', 'not_started', 'in_progress', 'paused'] as const) {
      expect(canMoveRequisition(s, 'completed', null, today)).toBe(true);
      expect(canMoveRequisition(s, 'cancelled', null, today)).toBe(true);
    }
    expect(requisitionMoves('completed', null, today)).toEqual([]);
    expect(requisitionMoves('cancelled', null, today)).toEqual([]);
  });
  it('Expired is set only by date, never on a terminal requisition, and then allows only Completed or Cancelled', () => {
    expect(effectiveRequisitionStatus('in_progress', '2026-11-09', today)).toBe('expired');
    expect(effectiveRequisitionStatus('in_progress', '2026-11-10', today)).toBe('in_progress');
    expect(effectiveRequisitionStatus('completed', '2026-01-01', today)).toBe('completed');
    expect(requisitionMoves('in_progress', '2026-11-09', today)).toEqual(['completed', 'cancelled']);
  });
  it('remaining offers = vacancies − onboarded − offers in process; remaining onboarding = vacancies − onboarded; never shown below 0', () => {
    expect(vacancyCounts({ vacancies: 5, onboarded: 2, offersInProcess: 1 })).toEqual({ remainingOffers: 2, remainingOnboarding: 3, shownOffers: 2, shownOnboarding: 3, overFilled: false });
    expect(vacancyCounts({ vacancies: 2, onboarded: 1, offersInProcess: 3 })).toEqual({ remainingOffers: -2, remainingOnboarding: 1, shownOffers: 0, shownOnboarding: 1, overFilled: true });
  });
  it('validates a requisition: required fields, vacancies ≥ 1 and min ≤ max salary', () => {
    const vocab = { employmentTypes: ['full_time'], recruitmentTypes: ['budgeted'] };
    const base = { title: 'Fictional analyst', vacancies: '2', workLocation: 'Kuala Lumpur', employmentType: 'full_time', recruitmentType: 'budgeted' };
    expect(validateRequisitionInput({ ...base, title: '' }, vocab)).toMatchObject({ ok: false, code: 'missing_fields', fields: ['title'] });
    expect(validateRequisitionInput({ ...base, vacancies: '0' }, vocab)).toMatchObject({ ok: false, code: 'invalid_input', fields: ['vacancies'] });
    expect(validateRequisitionInput({ ...base, salaryMin: '5000', salaryMax: '4000', salaryCurrency: 'MYR' }, vocab)).toMatchObject({ ok: false, fields: ['salaryMax'] });
    const ok = validateRequisitionInput({ ...base, salaryMin: '4000', salaryMax: '6000.5', salaryCurrency: 'myr' }, vocab);
    expect(ok).toMatchObject({ ok: true, value: { vacancies: 2, salaryMin: '4000.00', salaryMax: '6000.50', salaryCurrency: 'MYR' } });
    const v = ok.ok ? ok.value : null;
    const benefitsOnly = { ...v!, benefits: 'Changed' };
    const moreVacancies = { ...v!, vacancies: 3 };
    expect(requiredRequisitionFieldsChanged(v!, benefitsOnly)).toBe(false);
    expect(requiredRequisitionFieldsChanged(v!, moreVacancies)).toBe(true);
  });
});
