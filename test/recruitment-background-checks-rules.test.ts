/**
 * Recruitment slice 12 pure rules (no database): the status machine, the stage rule, the Kuala Lumpur overdue boundary, the
 * card marker, the inputs, the to-do vocabulary and the words every locale needs. The database behaviour (cases 82–86) is
 * test/recruitment-background-checks.test.ts. Every value is fictional.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PACK_TASK_KINDS, RECRUITMENT_TASK_KINDS } from '../lib/assigned-work';
import {
  AUTHORISATION_METHODS, CHECK_OUTCOMES, CHECK_STATUSES, CHECK_TRANSITIONS, DEFAULT_CHECK_TYPES, PERSONAL_TODO_KINDS, RECRUITMENT_ERROR_CODES, TODO_KINDS,
  canMoveCheck, checkMarker, checkOverdue, checkStageAllowed, checkStatusCounts, isFinalCheck, overdueFrom, todoHref, todoToPackTask, validateAddCheckInput,
  validateAuthorisationInput, validateCancelInput, validateCheckTypeInput, validateCompleteInput, type RecruitmentTodo,
} from '../packs/recruitment/service';
import { todayInKualaLumpur } from '../lib/hr-date';

const root = fileURLToPath(new URL('..', import.meta.url));
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('status machine (case 83)', () => {
  it('moves only awaiting → in progress → completed, or to cancelled from an open state; completed and cancelled are final', () => {
    const allowed = CHECK_STATUSES.flatMap((from) => CHECK_STATUSES.filter((to) => canMoveCheck(from, to)).map((to) => `${from}>${to}`));
    expect(allowed).toEqual(['awaiting_authorisation>in_progress', 'awaiting_authorisation>cancelled', 'in_progress>completed', 'in_progress>cancelled']);
    expect(CHECK_STATUSES.filter(isFinalCheck)).toEqual(['completed', 'cancelled']);
    expect(CHECK_TRANSITIONS.completed).toEqual([]);
    // Awaiting authorisation never jumps to completed.
    expect(canMoveCheck('awaiting_authorisation', 'completed')).toBe(false);
  });
});

describe('the stage rule (case 83)', () => {
  const at = (stageType: string, stageSeedKey: string | null, stagePosition: number | null, offerPosition: number | null) =>
    checkStageAllowed({ stageType, stageSeedKey, stagePosition, offerPosition });
  it('allows an Offer-type stage, any stage at or after the first Offer-type stage, or the seeded Background check stage', () => {
    expect(at('offer', 'offer', 6, 6)).toBe(true);
    expect(at('offer', null, null, null)).toBe(true); // an Offer-type stage outside the process still counts
    expect(at('none', 'medical_check_up', 7, 6)).toBe(true);
    expect(at('system_default', 'onboarding', 9, 6)).toBe(true);
    expect(at('none', 'background_check', 8, 6)).toBe(true);
    // The seeded Background check stage counts wherever it sits and whatever it is called (a process with no Offer stage).
    expect(at('none', 'background_check', 2, null)).toBe(true);
  });
  it('refuses earlier stages, a process with no Offer-type stage, a stage outside the process — and never looks at a name', () => {
    expect(at('interview', 'interview', 5, 6)).toBe(false);
    expect(at('system_default', 'application_review', 1, 6)).toBe(false);
    expect(at('none', 'medical_check_up', 7, null)).toBe(false);
    expect(at('none', null, null, 6)).toBe(false);
    // A company stage named "Background screening" before the offer is not a background-check stage (names are editable).
    expect(checkStageAllowed({ stageType: 'none', stageSeedKey: null, stagePosition: 2, offerPosition: 6, ...({ stageName: 'Background screening' } as object) })).toBe(false);
  });
});

describe('the recorder\'s overdue to-do: more than 14 Kuala Lumpur days in progress (case 85)', () => {
  it('starts on the 15th Kuala Lumpur day after the start day, not before', () => {
    expect(checkOverdue('2026-11-01', '2026-11-15')).toBe(false); // 14 days
    expect(checkOverdue('2026-11-01', '2026-11-16')).toBe(true); // 15 days
    expect(overdueFrom('2026-11-01')).toBe('2026-11-16');
    expect(overdueFrom('2026-12-25')).toBe('2027-01-09');
    expect(overdueFrom('2028-02-20')).toBe('2028-03-06'); // leap year
  });
  it('a start at 23:30 on 1 Nov in Kuala Lumpur (15:30 UTC) is KL day 1 Nov; at 00:30 on 2 Nov KL (16:30 UTC on 1 Nov) it is KL day 2 Nov', () => {
    const late = todayInKualaLumpur(new Date('2026-11-01T15:30:00Z'));
    const early = todayInKualaLumpur(new Date('2026-11-01T16:30:00Z'));
    expect([late, early]).toEqual(['2026-11-01', '2026-11-02']);
    const day16 = todayInKualaLumpur(new Date('2026-11-15T16:00:00Z')); // 00:00 on 16 Nov in Kuala Lumpur
    expect(day16).toBe('2026-11-16');
    expect(checkOverdue(late, day16)).toBe(true);
    expect(checkOverdue(early, day16)).toBe(false);
  });
});

describe('the card marker (operators and administrators)', () => {
  it('Concerns found wins over In progress; Clear, Could not verify, awaiting and cancelled checks show nothing', () => {
    expect(checkMarker([])).toBeNull();
    expect(checkMarker([{ status: 'awaiting_authorisation', outcome: null }, { status: 'cancelled', outcome: null }])).toBeNull();
    expect(checkMarker([{ status: 'completed', outcome: 'clear' }, { status: 'completed', outcome: 'could_not_verify' }])).toBeNull();
    expect(checkMarker([{ status: 'in_progress', outcome: null }])).toBe('in_progress');
    expect(checkMarker([{ status: 'in_progress', outcome: null }, { status: 'completed', outcome: 'concerns_found' }])).toBe('concerns_found');
  });
});

describe('inputs', () => {
  it('a type needs a name of at most 80 characters and an optional description of at most 500', () => {
    expect(validateCheckTypeInput({ name: '  ' })).toEqual({ ok: false, code: 'missing_fields', fields: ['name'] });
    expect(validateCheckTypeInput({ name: 'x'.repeat(81) })).toMatchObject({ ok: false, code: 'invalid_input', fields: ['name'] });
    expect(validateCheckTypeInput({ name: 'Fictional type', description: 'y'.repeat(501) })).toMatchObject({ ok: false, fields: ['description'] });
    expect(validateCheckTypeInput({ name: ' Fictional type ', description: '', enabled: 'on' })).toEqual({ ok: true, value: { name: 'Fictional type', description: null, enabled: true } });
    expect(validateCheckTypeInput({ name: 'Fictional type', enabled: false })).toMatchObject({ ok: true, value: { enabled: false } });
  });
  it('a check needs the application, at least one type and the provider; the reference is optional and bounded', () => {
    expect(validateAddCheckInput({})).toEqual({ ok: false, code: 'missing_fields', fields: ['application', 'types', 'provider'] });
    expect(validateAddCheckInput({ applicationId: U(1), typeIds: ['nope'], provider: 'Fictional Screening Sdn Bhd' })).toMatchObject({ ok: false, fields: ['types'] });
    expect(validateAddCheckInput({ applicationId: U(1), typeIds: [U(2)], provider: 'p'.repeat(121) })).toMatchObject({ ok: false, fields: ['provider'] });
    expect(validateAddCheckInput({ applicationId: U(1), typeIds: [U(2)], provider: 'P', providerReference: 'r'.repeat(121) })).toMatchObject({ ok: false, fields: ['providerReference'] });
    expect(validateAddCheckInput({ applicationId: U(1), typeIds: [U(2), U(2), U(3)], provider: ' Fictional Screening ' })).toEqual({
      ok: true, value: { applicationId: U(1), typeIds: [U(2), U(3)], provider: 'Fictional Screening', providerReference: null },
    });
  });
  it('the authorisation needs a real date no later than today in Kuala Lumpur and one of three methods', () => {
    expect(AUTHORISATION_METHODS).toEqual(['signed_form', 'email', 'online_form']);
    expect(validateAuthorisationInput({}, '2026-11-12')).toEqual({ ok: false, code: 'missing_fields', fields: ['authorisedOn', 'method'] });
    expect(validateAuthorisationInput({ authorisedOn: '2026-11-13', method: 'email' }, '2026-11-12')).toMatchObject({ ok: false, fields: ['authorisedOn'] });
    expect(validateAuthorisationInput({ authorisedOn: '2026-02-30', method: 'email' }, '2026-11-12')).toMatchObject({ ok: false, fields: ['authorisedOn'] });
    expect(validateAuthorisationInput({ authorisedOn: '2026-11-12', method: 'verbal' }, '2026-11-12')).toMatchObject({ ok: false, fields: ['method'] });
    expect(validateAuthorisationInput({ authorisedOn: '2026-11-12', method: 'signed_form', start: 'on' }, '2026-11-12'))
      .toEqual({ ok: true, value: { authorisedOn: '2026-11-12', method: 'signed_form', providerReference: null, start: true } });
  });
  it('completing needs one of three outcomes; the summary is optional and at most 2,000 characters; a cancellation needs a reason', () => {
    expect(CHECK_OUTCOMES).toEqual(['clear', 'concerns_found', 'could_not_verify']);
    expect(validateCompleteInput({ summary: 'Fictional' })).toEqual({ ok: false, code: 'missing_fields', fields: ['outcome'] });
    expect(validateCompleteInput({ outcome: 'passed' })).toMatchObject({ ok: false, fields: ['outcome'] });
    expect(validateCompleteInput({ outcome: 'clear', summary: 's'.repeat(2001) })).toMatchObject({ ok: false, fields: ['summary'] });
    expect(validateCompleteInput({ outcome: 'clear', summary: 's'.repeat(2000) })).toMatchObject({ ok: true });
    expect(validateCancelInput({ reason: ' ' })).toEqual({ ok: false, code: 'missing_fields', fields: ['reason'] });
    expect(validateCancelInput({ reason: 'r'.repeat(501) })).toMatchObject({ ok: false, fields: ['reason'] });
    expect(validateCancelInput({ reason: ' Candidate withdrew ' })).toEqual({ ok: true, value: { reason: 'Candidate withdrew' } });
  });
  it('counts by status cover every status, zero when absent', () => {
    expect(checkStatusCounts([{ status: 'in_progress', n: 2 }, { status: 'completed', n: 1 }]))
      .toEqual({ awaiting_authorisation: 0, in_progress: 2, completed: 1, cancelled: 0 });
  });
});

describe('to-dos and the bell', () => {
  const todo = (over: Partial<RecruitmentTodo>): RecruitmentTodo => ({
    kind: 'backgroundCheckAuthorisation', id: U(7), companyId: U(1), jobId: U(2), title: 'Fictional analyst', number: 'MJ000001', candidateName: 'Fictional Person',
    candidateRemoved: false, count: null, step: null, at: '2026-11-11T01:00:00.000Z', href: '/x', applicationId: U(3), ...over,
  });
  it('the two personal kinds link to the check on the application and map to their own bell kinds', () => {
    expect(PERSONAL_TODO_KINDS).toEqual(expect.arrayContaining(['backgroundCheckAuthorisation', 'backgroundCheckOverdue']));
    expect(TODO_KINDS).toEqual(expect.arrayContaining(['backgroundCheckAuthorisation', 'backgroundCheckOverdue']));
    expect(todoHref('backgroundCheckOverdue', { id: U(7), applicationId: U(3) })).toBe(`/recruitment/applications/${U(3)}?tab=checks#check-${U(7)}`);
    expect(todoToPackTask(todo({}))).toEqual({ id: `backgroundCheckAuthorisation:${U(7)}`, kind: 'recruitmentBackgroundCheckAuthorisation',
      subjectName: 'Fictional Person · Fictional analyst', createdAt: '2026-11-11T01:00:00.000Z', linkPath: '/x' });
    expect(todoToPackTask(todo({ kind: 'backgroundCheckOverdue' }))!.kind).toBe('recruitmentBackgroundCheckOverdue');
    for (const k of ['recruitmentBackgroundCheckAuthorisation', 'recruitmentBackgroundCheckOverdue'] as const) {
      expect(RECRUITMENT_TASK_KINDS).toContain(k);
      expect(PACK_TASK_KINDS).toContain(k);
    }
  });
});

describe('words in every locale', () => {
  type Msgs = { recruitment: { errors: Record<string, string>; checks: Record<string, unknown> & { status: Record<string, string>; outcome: Record<string, string>;
    settings: { defaults: Record<string, string> } }; tasks: { todo: Record<string, string> } }; notifications: { task: Record<string, string>; taskAction: Record<string, string> } };
  const read = (locale: string) => JSON.parse(readFileSync(join(root, `messages/${locale}.json`), 'utf8')) as Msgs;
  const en = read('en');
  it('every new error code, status, outcome, default type, to-do and bell kind has a sentence, translated outside English', () => {
    const NEW_CODES = ['check_stage', 'check_closed', 'check_state', 'authorisation_required', 'check_type_unavailable', 'type_in_use'];
    expect(RECRUITMENT_ERROR_CODES).toEqual(expect.arrayContaining(NEW_CODES));
    for (const locale of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const m = read(locale);
      const pairs: [string, string | undefined, string | undefined][] = [
        ...NEW_CODES.map((c) => [`errors.${c}`, m.recruitment.errors[c], en.recruitment.errors[c]] as [string, string | undefined, string | undefined]),
        ...CHECK_STATUSES.map((st) => [`status.${st}`, m.recruitment.checks.status[st], en.recruitment.checks.status[st]] as [string, string | undefined, string | undefined]),
        ...CHECK_OUTCOMES.map((o) => [`outcome.${o}`, m.recruitment.checks.outcome[o], en.recruitment.checks.outcome[o]] as [string, string | undefined, string | undefined]),
        ...DEFAULT_CHECK_TYPES.map((d) => [`defaults.${d.seedKey}`, m.recruitment.checks.settings.defaults[d.seedKey], en.recruitment.checks.settings.defaults[d.seedKey]] as [string, string | undefined, string | undefined]),
        ...['backgroundCheckAuthorisation', 'backgroundCheckOverdue'].map((k) => [`todo.${k}`, m.recruitment.tasks.todo[k], en.recruitment.tasks.todo[k]] as [string, string | undefined, string | undefined]),
        ...['recruitmentBackgroundCheckAuthorisation', 'recruitmentBackgroundCheckOverdue'].flatMap((k) => [
          [`task.${k}`, m.notifications.task[k], en.notifications.task[k]], [`taskAction.${k}`, m.notifications.taskAction[k], en.notifications.taskAction[k]],
        ] as [string, string | undefined, string | undefined][]),
      ];
      for (const [key, value, english] of pairs) {
        expect(value, `${locale} ${key}`).toBeTruthy();
        if (locale !== 'en') expect(value, `${locale} ${key} is still English`).not.toBe(english);
      }
    }
  });
  it('the default type names in the catalogue match the offered seeds', () => {
    expect(DEFAULT_CHECK_TYPES.map((d) => en.recruitment.checks.settings.defaults[d.seedKey])).toEqual(DEFAULT_CHECK_TYPES.map((d) => d.name));
  });
});
