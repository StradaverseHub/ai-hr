/**
 * Recruitment rules for slices 2–4 (docs/recruitment-reconstruction/specification.md "Slices 2–4") — pure,
 * deterministic and client-safe. No database, no model. "Now" and "today" are always passed in: the service takes
 * them from the clock and lib/hr-date, so every rule here can be tested with fixed values.
 *
 * The database guards in migrations 4402–4404 refuse the same illegal states independently. Seeded content below is
 * generic and editable; behaviour never keys off a label, only off ids, types, keys and flags.
 */
import { RecruitmentError, isUuid, type JobMemberRole } from './model';

// ── Team access (slice 2) ─────────────────────────────────────────────────────────────────────────────────

/** What a viewer may do on one job. The database predicates (4402) decide; this mirrors them for the screens. */
export type JobAccess = { read: boolean; review: boolean; operate: boolean };
export function jobAccess(admin: boolean, roles: readonly JobMemberRole[], interviewsHere = false): JobAccess {
  const operate = admin || roles.includes('recruiter') || roles.includes('assistant');
  const review = operate || roles.includes('hiring_manager');
  return { operate, review, read: review || interviewsHere };
}

// ── Interviews ────────────────────────────────────────────────────────────────────────────────────────────

export const INTERVIEW_TYPES = ['onsite', 'video', 'phone'] as const;
export type InterviewType = (typeof INTERVIEW_TYPES)[number];
export const CANDIDATE_RESPONSES = ['pending', 'accepted', 'declined'] as const;
export type CandidateResponse = (typeof CANDIDATE_RESPONSES)[number];
export const EVALUATION_RESULTS = ['recommended', 'keep_in_view', 'not_suitable'] as const;
export type EvaluationResult = (typeof EVALUATION_RESULTS)[number];
export const FEEDBACK_EDIT_LOCKS = ['any_stage', 'until_stage_left', 'until_archived'] as const;
export type FeedbackEditLock = (typeof FEEDBACK_EDIT_LOCKS)[number];
/** The default interview plan when a job has none: 1st, 2nd and 3rd round. */
export const DEFAULT_ROUNDS = [1, 2, 3] as const;

export type InterviewStatus = 'scheduled' | 'in_progress' | 'awaiting_feedback' | 'feedback_complete' | 'cancelled';

/**
 * The interview's status, derived, never stored:
 *   Cancelled; Feedback complete once every interviewer has submitted; otherwise Scheduled before its start,
 *   In progress between start and end, and Awaiting feedback after its end.
 */
export function interviewStatus(
  i: { startsAt: Date | string; durationMinutes: number; cancelled: boolean; interviewers: number; submitted: number },
  now: Date,
): InterviewStatus {
  if (i.cancelled) return 'cancelled';
  if (i.interviewers > 0 && i.submitted >= i.interviewers) return 'feedback_complete';
  const start = new Date(i.startsAt).getTime();
  const end = start + i.durationMinutes * 60_000;
  if (now.getTime() < start) return 'scheduled';
  if (now.getTime() < end) return 'in_progress';
  return 'awaiting_feedback';
}

/** A Kuala Lumpur wall-clock "YYYY-MM-DDTHH:mm" (the datetime-local field) as an instant. Malaysia has no DST. */
export function klLocalToInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const d = new Date(`${value}:00+08:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type InterviewInput = {
  applicationId?: unknown; roundNo?: unknown; type?: unknown; startsAt?: unknown; durationMinutes?: unknown;
  site?: unknown; meetingRoom?: unknown; interviewerIds?: unknown; formId?: unknown;
};
export type ValidInterview = {
  applicationId: string; roundNo: number; type: InterviewType; startsAt: Date; durationMinutes: number;
  site: string | null; meetingRoom: string | null; interviewerIds: string[]; formId: string | null;
};
const text = (value: unknown, max: number): string | null | 'invalid' => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return 'invalid';
  const t = value.trim();
  if (!t) return null;
  return t.length <= max ? t : 'invalid';
};
const int = (value: unknown, min: number, max: number): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,6}$/.test(value.trim()) ? Number(value.trim()) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

export function validateInterviewInput(input: InterviewInput): { ok: true; value: ValidInterview } | { ok: false; code: 'missing_fields' | 'invalid_input'; fields: string[] } {
  const missing: string[] = [];
  if (!isUuid(input.applicationId)) missing.push('application');
  const ids = (Array.isArray(input.interviewerIds) ? input.interviewerIds : input.interviewerIds == null || input.interviewerIds === '' ? [] : [input.interviewerIds])
    .filter((v) => v !== '');
  const interviewerIds = [...new Set(ids)];
  if (!interviewerIds.length) missing.push('interviewers');
  if (input.startsAt == null || input.startsAt === '') missing.push('startsAt');
  if (input.type == null || input.type === '') missing.push('type');
  if (missing.length) return { ok: false, code: 'missing_fields', fields: missing };
  const invalid: string[] = [];
  const roundNo = input.roundNo == null || input.roundNo === '' ? 1 : int(input.roundNo, 1, 20);
  if (roundNo == null) invalid.push('round');
  const type = (INTERVIEW_TYPES as readonly unknown[]).includes(input.type) ? (input.type as InterviewType) : null;
  if (!type) invalid.push('type');
  const startsAt = input.startsAt instanceof Date ? input.startsAt : klLocalToInstant(input.startsAt);
  if (!startsAt) invalid.push('startsAt');
  const durationMinutes = input.durationMinutes == null || input.durationMinutes === '' ? 60 : int(input.durationMinutes, 5, 720);
  if (durationMinutes == null) invalid.push('duration');
  const site = text(input.site, 200);
  if (site === 'invalid') invalid.push('site');
  const meetingRoom = text(input.meetingRoom, 120);
  if (meetingRoom === 'invalid') invalid.push('meetingRoom');
  if (interviewerIds.length > 20 || !interviewerIds.every(isUuid)) invalid.push('interviewers');
  const formId = input.formId == null || input.formId === '' ? null : isUuid(input.formId) ? input.formId : 'invalid';
  if (formId === 'invalid') invalid.push('form');
  if (invalid.length) return { ok: false, code: 'invalid_input', fields: invalid };
  return {
    ok: true,
    value: {
      applicationId: input.applicationId as string, roundNo: roundNo!, type: type!, startsAt: startsAt!, durationMinutes: durationMinutes!,
      site: site as string | null, meetingRoom: meetingRoom as string | null, interviewerIds: interviewerIds as string[], formId: formId as string | null,
    },
  };
}

// ── Evaluation forms and scorecards ───────────────────────────────────────────────────────────────────────

export type FormCriterion = { key: string; label: string; question?: string };
export type FormSection = { key: string; title: string; criteria: FormCriterion[] };
export type EvaluationFormDefinition = { sections: FormSection[] };

/** The seeded default form: a generic five-criterion foundational assessment. Editable; not any company's own text. */
export const DEFAULT_EVALUATION_FORM: { seedKey: string; name: string; definition: EvaluationFormDefinition } = {
  seedKey: 'interview_evaluation',
  name: 'Interview evaluation',
  definition: {
    sections: [{
      key: 's1', title: 'Foundational assessment',
      criteria: [
        { key: 'c1', label: 'Role knowledge', question: 'Walk us through a piece of work you are proud of.' },
        { key: 'c2', label: 'Problem solving', question: 'Describe a difficult problem you solved and how.' },
        { key: 'c3', label: 'Communication', question: 'How would you explain your work to someone outside your field?' },
        { key: 'c4', label: 'Collaboration', question: 'Tell us about a disagreement in a team and how it ended.' },
        { key: 'c5', label: 'Motivation and fit', question: 'What would you want to achieve in your first months?' },
      ],
    }],
  },
};

/**
 * Parse the form editor: one block per section separated by a blank line; the first line of a block is the section
 * title, each further line a criterion as "Criterion | suggested question" (the question is optional). Keys are
 * positional (s1, s1c1 …), so the stored shape never depends on wording.
 */
export function parseFormDefinition(source: unknown): EvaluationFormDefinition {
  if (typeof source !== 'string' || source.length > 20000) throw new RecruitmentError('invalid_form');
  const blocks = source.replace(/\r\n/g, '\n').split(/\n\s*\n/).map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean)).filter((b) => b.length);
  if (!blocks.length || blocks.length > 20) throw new RecruitmentError('invalid_form');
  const sections = blocks.map((lines, si) => {
    const [title, ...rows] = lines;
    if (!rows.length || rows.length > 30 || title.length > 200) throw new RecruitmentError('invalid_form');
    return {
      key: `s${si + 1}`, title,
      criteria: rows.map((row, ci) => {
        const [label, ...rest] = row.split('|');
        const question = rest.join('|').trim();
        if (!label.trim() || label.trim().length > 200 || question.length > 500) throw new RecruitmentError('invalid_form');
        return { key: `s${si + 1}c${ci + 1}`, label: label.trim(), ...(question ? { question } : {}) };
      }),
    };
  });
  return { sections };
}
/** The editor text for a stored definition (the inverse of parseFormDefinition). */
export function formatFormDefinition(def: EvaluationFormDefinition): string {
  return def.sections.map((s) => [s.title, ...s.criteria.map((c) => (c.question ? `${c.label} | ${c.question}` : c.label))].join('\n')).join('\n\n');
}
/** A stored definition is trusted only after this check (it is jsonb from the database). */
export function readFormDefinition(value: unknown): EvaluationFormDefinition {
  const v = value as EvaluationFormDefinition;
  if (!v || !Array.isArray(v.sections) || !v.sections.every((s) => typeof s?.key === 'string' && typeof s.title === 'string' && Array.isArray(s.criteria)
    && s.criteria.every((c) => typeof c?.key === 'string' && typeof c.label === 'string'))) throw new RecruitmentError('invalid_form');
  return v;
}

export const NOTES_MAX_WORDS = 500;
export const wordCount = (value: string): number => (value.trim() ? value.trim().split(/\s+/).length : 0);

export type CriterionRating = { rating: number; notes?: string };
export type ScorecardInput = { ratings?: Record<string, { rating?: unknown; notes?: unknown }>; result?: unknown; overview?: unknown };
export type ValidScorecard = { ratings: Record<string, CriterionRating>; result: EvaluationResult | null; overview: string | null };

/**
 * Validate feedback against its form: every criterion needs a whole-number rating 1–5; notes are optional and at most
 * 500 words; the overall result is required when the company says so; the overview is optional (≤ 5000 characters).
 */
export function validateScorecard(def: EvaluationFormDefinition, input: ScorecardInput, resultRequired: boolean): { ok: true; value: ValidScorecard } | { ok: false; code: 'missing_fields' | 'invalid_input'; fields: string[] } {
  const missing: string[] = [];
  const invalid: string[] = [];
  const ratings: Record<string, CriterionRating> = {};
  for (const section of def.sections) {
    for (const c of section.criteria) {
      const raw = input.ratings?.[c.key];
      const rating = raw?.rating == null || raw.rating === '' ? null : int(raw.rating, 1, 5);
      if (raw?.rating == null || raw.rating === '') { missing.push(c.key); continue; }
      if (rating == null) { invalid.push(c.key); continue; }
      const notes = raw?.notes == null || raw.notes === '' ? '' : typeof raw.notes === 'string' ? raw.notes.trim() : null;
      if (notes == null || wordCount(notes) > NOTES_MAX_WORDS || notes.length > 5000) { invalid.push(`${c.key}.notes`); continue; }
      ratings[c.key] = notes ? { rating, notes } : { rating };
    }
  }
  const result = input.result == null || input.result === '' ? null : (EVALUATION_RESULTS as readonly unknown[]).includes(input.result) ? (input.result as EvaluationResult) : 'invalid';
  if (result === 'invalid') invalid.push('result');
  else if (result == null && resultRequired) missing.push('result');
  const overview = input.overview == null || input.overview === '' ? null : typeof input.overview === 'string' && input.overview.trim().length <= 5000 ? input.overview.trim() || null : 'invalid';
  if (overview === 'invalid') invalid.push('overview');
  if (missing.length) return { ok: false, code: 'missing_fields', fields: missing };
  if (invalid.length) return { ok: false, code: 'invalid_input', fields: invalid };
  return { ok: true, value: { ratings, result: result as EvaluationResult | null, overview: overview as string | null } };
}

/** Section totals as sum / (5 × criteria). Deterministic arithmetic over whole-number ratings — never a model. */
export function sectionTotals(def: EvaluationFormDefinition, ratings: Record<string, CriterionRating | undefined>): { key: string; title: string; sum: number; max: number; rated: number }[] {
  return def.sections.map((s) => {
    let sum = 0; let rated = 0;
    for (const c of s.criteria) {
      const r = ratings[c.key]?.rating;
      if (Number.isInteger(r) && r! >= 1 && r! <= 5) { sum += r!; rated += 1; }
    }
    return { key: s.key, title: s.title, sum, max: 5 * s.criteria.length, rated };
  });
}

/**
 * May submitted feedback still be EDITED? (The first submission is always allowed on an open interview.)
 *   any_stage         always;
 *   until_stage_left  while the application is active and not at a later stage than the interview's (default);
 *   until_archived    while the application is not archived.
 * Positions are the stages' places in the job's process; an unknown position counts as "left" unless the
 * application is still in the interview's own stage. The 4402 scorecard guard applies the same rule.
 */
export function feedbackEditable(
  lock: FeedbackEditLock,
  app: { state: 'active' | 'hired' | 'archived'; currentStageId: string; currentPosition: number | null },
  interview: { stageId: string; position: number | null },
): boolean {
  if (lock === 'any_stage') return true;
  if (lock === 'until_archived') return app.state !== 'archived';
  if (app.state !== 'active') return false;
  if (app.currentStageId === interview.stageId) return true;
  if (app.currentPosition == null || interview.position == null) return false;
  return app.currentPosition <= interview.position;
}

// ── Offers (slice 3) ──────────────────────────────────────────────────────────────────────────────────────

export const OFFER_FIELD_TYPES = ['text', 'number', 'date', 'single_choice', 'money'] as const;
export type OfferFieldType = (typeof OFFER_FIELD_TYPES)[number];
export const OFFER_STATUSES = ['draft', 'pending', 'approved'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];
export const OFFER_SEND_CHANNELS = ['email', 'sms', 'other'] as const;
export type OfferSendChannel = (typeof OFFER_SEND_CHANNELS)[number];
export const CANDIDATE_DECISIONS = ['pending', 'accepted', 'declined'] as const;
export type CandidateDecision = (typeof CANDIDATE_DECISIONS)[number];
export const DEFAULT_OFFER_VALID_DAYS = 15;

export type OfferFieldDef = {
  id: string; label: string; type: OfferFieldType; choices: string[]; required: boolean; needsApproval: boolean; private: boolean; enabled: boolean;
};
/** The seeded, generic offer-field set. Pay is a money field a person types; nothing computes it. */
export const DEFAULT_OFFER_FIELDS: readonly { seedKey: string; label: string; type: OfferFieldType; required: boolean; needsApproval: boolean; private: boolean }[] = [
  { seedKey: 'job_offered', label: 'Job offered', type: 'text', required: true, needsApproval: true, private: false },
  { seedKey: 'department', label: 'Department', type: 'text', required: false, needsApproval: false, private: false },
  { seedKey: 'reporting_to', label: 'Reporting to', type: 'text', required: false, needsApproval: false, private: false },
  { seedKey: 'job_level', label: 'Job level', type: 'text', required: false, needsApproval: true, private: false },
  { seedKey: 'commencement_date', label: 'Commencement date', type: 'date', required: true, needsApproval: true, private: false },
  { seedKey: 'work_location', label: 'Work location', type: 'text', required: false, needsApproval: false, private: false },
  { seedKey: 'basic_salary', label: 'Basic salary', type: 'money', required: true, needsApproval: true, private: true },
  { seedKey: 'probation_months', label: 'Probation (months)', type: 'number', required: false, needsApproval: true, private: false },
];
/** The candidate-side archive reason the decline automation uses; seeded only when that automation is switched on. */
export const OFFER_DECLINED_REASON = { seedKey: 'offer_declined', internal: 'Candidate declined the offer', external: 'Candidate declined the offer' } as const;

/** A stored value, typed by its field. Amounts and numbers stay decimal STRINGS end to end — never floats. */
export type OfferValue =
  | { kind: 'text'; text: string }
  | { kind: 'number'; number: string }
  | { kind: 'date'; date: string }
  | { kind: 'money'; amount: string; currency: string };

const DECIMAL_AMOUNT = /^\d{1,16}(\.\d{1,2})?$/;
const DECIMAL_NUMBER = /^-?\d{1,12}(\.\d{1,4})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (v: string) => ISO_DATE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** Canonical decimal text (no leading zeros, fixed scale) so equal amounts compare equal. */
export function canonicalDecimal(value: string, scale: number): string {
  const negative = value.startsWith('-');
  const [whole, frac = ''] = (negative ? value.slice(1) : value).split('.');
  const w = whole.replace(/^0+(?=\d)/, '') || '0';
  const f = (frac + '0'.repeat(scale)).slice(0, scale);
  const out = scale ? `${w}.${f}` : w;
  return negative && /[1-9]/.test(out) ? `-${out}` : out;
}

export type OfferValueInput = Record<string, { text?: unknown; amount?: unknown; currency?: unknown } | undefined>;

/**
 * Validate the offer's values against the enabled fields. Required fields must be present; a value must match its
 * field's type. Returns the typed values by field id; an omitted optional field is simply absent.
 */
export function validateOfferValues(fields: readonly OfferFieldDef[], input: OfferValueInput): { ok: true; values: Map<string, OfferValue> } | { ok: false; code: 'missing_fields' | 'invalid_input'; fields: string[] } {
  const values = new Map<string, OfferValue>();
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const f of fields.filter((x) => x.enabled)) {
    const raw = input[f.id];
    const t = typeof raw?.text === 'string' ? raw.text.trim() : raw?.text == null ? '' : null;
    const amount = typeof raw?.amount === 'string' ? raw.amount.trim().replace(/,/g, '') : raw?.amount == null ? '' : null;
    const currency = typeof raw?.currency === 'string' ? raw.currency.trim().toUpperCase() : '';
    if (t == null || amount == null) { invalid.push(f.id); continue; }
    const empty = f.type === 'money' ? amount === '' : t === '';
    if (empty) { if (f.required) missing.push(f.id); continue; }
    if (f.type === 'text') { if (t.length > 2000) invalid.push(f.id); else values.set(f.id, { kind: 'text', text: t }); }
    else if (f.type === 'single_choice') { if (!f.choices.includes(t)) invalid.push(f.id); else values.set(f.id, { kind: 'text', text: t }); }
    else if (f.type === 'number') { if (!DECIMAL_NUMBER.test(t)) invalid.push(f.id); else values.set(f.id, { kind: 'number', number: canonicalDecimal(t, 4) }); }
    else if (f.type === 'date') { if (!validDate(t)) invalid.push(f.id); else values.set(f.id, { kind: 'date', date: t }); }
    else if (!DECIMAL_AMOUNT.test(amount) || !/^[A-Z]{3}$/.test(currency)) invalid.push(f.id);
    else values.set(f.id, { kind: 'money', amount: canonicalDecimal(amount, 2), currency });
  }
  if (missing.length) return { ok: false, code: 'missing_fields', fields: missing };
  if (invalid.length) return { ok: false, code: 'invalid_input', fields: invalid };
  return { ok: true, values };
}

const sameValue = (a: OfferValue | undefined, b: OfferValue | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** Did any field that NEEDS APPROVAL change? A change re-runs approval from step 1. */
export function approvalFieldsChanged(fields: readonly OfferFieldDef[], before: ReadonlyMap<string, OfferValue>, after: ReadonlyMap<string, OfferValue>): boolean {
  return fields.some((f) => f.needsApproval && !sameValue(before.get(f.id), after.get(f.id)));
}

// ── Ordered approval (offers and requisitions) ────────────────────────────────────────────────────────────

/**
 * One submission round: the ordered approvers (copied from the company flow at submission) and the position of the
 * pending step (1-based; null when no step is pending). Stored on the offer / requisition row (4403/4404).
 */
export type ApprovalRound = { approvers: string[]; pendingPosition: number | null };
export type ApprovalDecision = 'approved' | 'rejected';
export type ApprovalStepView = { position: number; approverUserId: string; state: 'approved' | 'rejected' | 'pending' | 'waiting' | 'not_reached' };

/**
 * A new round from the company flow: step 1 pending. An empty flow needs no approval (pendingPosition null). The
 * creator may not be one of the approvers — they could never approve their own item.
 */
export function startApproval(flow: readonly string[], creatorUserId: string): ApprovalRound {
  if (flow.includes(creatorUserId)) throw new RecruitmentError('self_approval');
  if (new Set(flow).size !== flow.length || flow.length > 20) throw new RecruitmentError('invalid_input', ['approvers']);
  return { approvers: [...flow], pendingPosition: flow.length ? 1 : null };
}

/**
 * One approver's decision. Only the approver of the PENDING step may act, and never the creator. Approving moves to
 * the next step, or finishes (approved) after the last; rejecting ends the round (rejected: back to Draft).
 */
export function decideApproval(round: ApprovalRound, actorUserId: string, creatorUserId: string, decision: 'approve' | 'reject'):
  { position: number; decision: ApprovalDecision; pendingPosition: number | null; outcome: 'pending' | 'approved' | 'rejected' } {
  const position = round.pendingPosition;
  if (position == null || round.approvers[position - 1] !== actorUserId) throw new RecruitmentError('not_your_step');
  if (actorUserId === creatorUserId) throw new RecruitmentError('self_approval');
  if (decision === 'reject') return { position, decision: 'rejected', pendingPosition: null, outcome: 'rejected' };
  const last = position >= round.approvers.length;
  return { position, decision: 'approved', pendingPosition: last ? null : position + 1, outcome: last ? 'approved' : 'pending' };
}

/** Withdraw is available only while a step is pending; the item returns to Draft. */
export function withdrawApproval(round: ApprovalRound): ApprovalRound {
  if (round.pendingPosition == null) throw new RecruitmentError('offer_state');
  return { approvers: round.approvers, pendingPosition: null };
}

/** The steps of a round as a screen shows them, from the round and its decision log. */
export function approvalSteps(round: ApprovalRound, decisions: readonly { position: number; decision: ApprovalDecision }[]): ApprovalStepView[] {
  return round.approvers.map((approverUserId, i) => {
    const position = i + 1;
    const d = decisions.find((x) => x.position === position);
    if (d) return { position, approverUserId, state: d.decision };
    if (round.pendingPosition === position) return { position, approverUserId, state: 'pending' };
    if (round.pendingPosition != null && position > round.pendingPosition) return { position, approverUserId, state: 'waiting' };
    return { position, approverUserId, state: 'not_reached' };
  });
}

/** The offer's expiry day: the Kuala Lumpur day it was sent plus the validity days. Only a label; nothing is sent. */
export function offerExpiresOn(sentOnKl: string, validDays: number): string {
  const d = new Date(`${sentOnKl}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + validDays);
  return d.toISOString().slice(0, 10);
}
export type OfferLabel = 'draft' | 'pending' | 'approved' | 'sent' | 'expired' | 'accepted' | 'declined';
export function offerLabel(o: { status: OfferStatus; sentOnKl: string | null; validDays: number | null; decision: CandidateDecision }, todayKl: string): OfferLabel {
  if (o.decision !== 'pending') return o.decision;
  if (o.sentOnKl && o.validDays) return todayKl > offerExpiresOn(o.sentOnKl, o.validDays) ? 'expired' : 'sent';
  return o.status;
}

/** "Start new hire" is offered only for an application at Onboarding or already hired. */
export function hireHandoffEligible(app: { state: 'active' | 'hired' | 'archived'; stageSystemKey: string | null }): boolean {
  return app.state === 'hired' || (app.state === 'active' && app.stageSystemKey === 'onboarding');
}

// ── Job requisitions (slice 4) ────────────────────────────────────────────────────────────────────────────

export const REQUISITION_STATUSES = ['draft', 'not_started', 'in_progress', 'paused', 'completed', 'cancelled'] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];
export type EffectiveRequisitionStatus = RequisitionStatus | 'expired';
export const REQUISITION_TABS: readonly EffectiveRequisitionStatus[] = ['draft', 'not_started', 'in_progress', 'paused', 'expired', 'completed', 'cancelled'];
export const REQUISITION_TERMINAL: readonly RequisitionStatus[] = ['completed', 'cancelled'];
export const REQUISITION_APPROVAL_STATUSES = ['not_submitted', 'pending', 'approved', 'rejected', 'not_required'] as const;
export type RequisitionApprovalStatus = (typeof REQUISITION_APPROVAL_STATUSES)[number];

/** Expired is never stored: a non-terminal requisition whose target on-board date is before today (Kuala Lumpur). */
export function effectiveRequisitionStatus(status: RequisitionStatus, targetOnboardDate: string | null, todayKl: string): EffectiveRequisitionStatus {
  if (REQUISITION_TERMINAL.includes(status)) return status;
  return targetOnboardDate && targetOnboardDate < todayKl ? 'expired' : status;
}

/** Manual moves: Not started ↔ In progress ↔ Paused; any non-terminal → Completed or Cancelled. Draft leaves only by submitting. */
const MANUAL_MOVES: Readonly<Record<RequisitionStatus, readonly RequisitionStatus[]>> = {
  draft: ['completed', 'cancelled'],
  not_started: ['in_progress', 'completed', 'cancelled'],
  in_progress: ['not_started', 'paused', 'completed', 'cancelled'],
  paused: ['in_progress', 'completed', 'cancelled'],
  completed: [],
  cancelled: [],
};
export function requisitionMoves(status: RequisitionStatus, targetOnboardDate: string | null, todayKl: string): RequisitionStatus[] {
  const effective = effectiveRequisitionStatus(status, targetOnboardDate, todayKl);
  if (effective === 'expired') return ['completed', 'cancelled'];
  return [...MANUAL_MOVES[status]];
}
export function canMoveRequisition(status: RequisitionStatus, to: RequisitionStatus, targetOnboardDate: string | null, todayKl: string): boolean {
  return requisitionMoves(status, targetOnboardDate, todayKl).includes(to);
}

/**
 * The vacancy table. Both are deterministic counts:
 *   remaining offers available = vacancies − hires already onboarded − offers in process;
 *   remaining capacity for onboarding = vacancies − hires already onboarded.
 * A negative is shown as 0 with an over-filled warning.
 */
export function vacancyCounts(v: { vacancies: number; onboarded: number; offersInProcess: number }) {
  const remainingOffers = v.vacancies - v.onboarded - v.offersInProcess;
  const remainingOnboarding = v.vacancies - v.onboarded;
  return {
    remainingOffers, remainingOnboarding,
    shownOffers: Math.max(0, remainingOffers), shownOnboarding: Math.max(0, remainingOnboarding),
    overFilled: remainingOffers < 0 || remainingOnboarding < 0,
  };
}

export const REQUISITION_REQUIRED_FIELDS = ['title', 'vacancies', 'workLocation', 'employmentType', 'recruitmentType'] as const;
export type RequisitionInput = Record<string, unknown>;
export type ValidRequisition = {
  title: string; description: string | null; vacancies: number; jobGradeIds: string[]; hiringManagerUserId: string | null;
  partnerUserId: string | null; recruiterUserId: string | null; workLocation: string; employmentType: string; recruitmentType: string;
  replacedEmploymentId: string | null; departmentId: string | null; dateOpened: string | null; targetOnboardDate: string | null;
  yearsExperience: number | null; education: string | null; salaryMin: string | null; salaryMax: string | null; salaryCurrency: string | null;
  workingDays: string | null; workingHours: string | null; mandatorySkills: string | null; preferredSkills: string | null; benefits: string | null;
};

/** Validate a requisition. Salary is a monthly range a person enters (min ≤ max), stored as decimals; never computed. */
export function validateRequisitionInput(input: RequisitionInput, vocab: { employmentTypes: readonly string[]; recruitmentTypes: readonly string[] }):
  { ok: true; value: ValidRequisition } | { ok: false; code: 'missing_fields' | 'invalid_input'; fields: string[] } {
  const missing: string[] = [];
  const invalid: string[] = [];
  const title = text(input.title, 200);
  if (!title) missing.push('title'); else if (title === 'invalid') invalid.push('title');
  const vacanciesRaw = input.vacancies;
  const vacancies = vacanciesRaw == null || vacanciesRaw === '' ? null : int(vacanciesRaw, 1, 10000);
  if (vacanciesRaw == null || vacanciesRaw === '') missing.push('vacancies'); else if (vacancies == null) invalid.push('vacancies');
  const workLocation = text(input.workLocation, 200);
  if (!workLocation) missing.push('workLocation'); else if (workLocation === 'invalid') invalid.push('workLocation');
  const employmentType = vocab.employmentTypes.includes(input.employmentType as string) ? (input.employmentType as string) : null;
  if (input.employmentType == null || input.employmentType === '') missing.push('employmentType'); else if (!employmentType) invalid.push('employmentType');
  const recruitmentType = vocab.recruitmentTypes.includes(input.recruitmentType as string) ? (input.recruitmentType as string) : null;
  if (input.recruitmentType == null || input.recruitmentType === '') missing.push('recruitmentType'); else if (!recruitmentType) invalid.push('recruitmentType');
  if (missing.length) return { ok: false, code: 'missing_fields', fields: missing };

  const optionalId = (key: string) => {
    const v = input[key];
    if (v == null || v === '') return null;
    if (!isUuid(v)) { invalid.push(key); return null; }
    return v;
  };
  const optionalText = (key: string, max: number) => {
    const v = text(input[key], max);
    if (v === 'invalid') { invalid.push(key); return null; }
    return v;
  };
  const optionalDate = (key: string) => {
    const v = input[key];
    if (v == null || v === '') return null;
    if (typeof v !== 'string' || !validDate(v)) { invalid.push(key); return null; }
    return v;
  };
  const grades = (Array.isArray(input.jobGradeIds) ? input.jobGradeIds : input.jobGradeIds == null || input.jobGradeIds === '' ? [] : [input.jobGradeIds]).filter((g) => g !== '');
  const jobGradeIds = [...new Set(grades)];
  if (jobGradeIds.length > 50 || !jobGradeIds.every(isUuid)) invalid.push('jobLevel');
  const description = input.description == null || input.description === '' ? null : typeof input.description === 'string' && input.description.length <= 20000 ? input.description : (invalid.push('description'), null);
  const dateOpened = optionalDate('dateOpened');
  const targetOnboardDate = optionalDate('targetOnboardDate');
  if (dateOpened && targetOnboardDate && dateOpened > targetOnboardDate) invalid.push('targetOnboardDate');
  const yearsRaw = input.yearsExperience;
  const yearsExperience = yearsRaw == null || yearsRaw === '' ? null : int(yearsRaw, 0, 60);
  if (yearsRaw != null && yearsRaw !== '' && yearsExperience == null) invalid.push('yearsExperience');
  const money = (key: string) => {
    const v = input[key];
    if (v == null || v === '') return null;
    const s = typeof v === 'string' ? v.trim().replace(/,/g, '') : '';
    if (!DECIMAL_AMOUNT.test(s)) { invalid.push(key); return null; }
    return canonicalDecimal(s, 2);
  };
  const salaryMin = money('salaryMin');
  const salaryMax = money('salaryMax');
  const currencyRaw = typeof input.salaryCurrency === 'string' ? input.salaryCurrency.trim().toUpperCase() : '';
  const salaryCurrency = salaryMin || salaryMax ? (/^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : (invalid.push('salaryCurrency'), null)) : null;
  if (salaryMin && salaryMax && Number(salaryMin) > Number(salaryMax)) invalid.push('salaryMax');
  const value: ValidRequisition = {
    title: title as string, description, vacancies: vacancies!, jobGradeIds: jobGradeIds as string[],
    hiringManagerUserId: optionalId('hiringManagerUserId'), partnerUserId: optionalId('partnerUserId'), recruiterUserId: optionalId('recruiterUserId'),
    workLocation: workLocation as string, employmentType: employmentType!, recruitmentType: recruitmentType!,
    replacedEmploymentId: optionalId('replacedEmploymentId'), departmentId: optionalId('departmentId'), dateOpened, targetOnboardDate,
    yearsExperience, education: optionalText('education', 200), salaryMin, salaryMax, salaryCurrency,
    workingDays: optionalText('workingDays', 200), workingHours: optionalText('workingHours', 200),
    mandatorySkills: optionalText('mandatorySkills', 4000), preferredSkills: optionalText('preferredSkills', 4000), benefits: optionalText('benefits', 4000),
  };
  if (invalid.length) return { ok: false, code: 'invalid_input', fields: [...new Set(invalid)] };
  return { ok: true, value };
}

/** Did a REQUIRED field change? Outside Draft that resets approval (when a flow exists). */
export function requiredRequisitionFieldsChanged(before: Pick<ValidRequisition, (typeof REQUISITION_REQUIRED_FIELDS)[number]>, after: Pick<ValidRequisition, (typeof REQUISITION_REQUIRED_FIELDS)[number]>): boolean {
  return REQUISITION_REQUIRED_FIELDS.some((k) => String(before[k]) !== String(after[k]));
}
