/**
 * Candidate e-mail rules (slice 19, D-063, docs/adr/2026-11-14-recruitment-candidate-email.md). Pure and client-safe: the kinds and
 * their placeholder allowlists, the limits, template and settings validation, and the ONE renderer every candidate e-mail goes
 * through — the preview a person sees, the content frozen at queue time and the careers receipt all call renderCandidateEmail, so
 * what is previewed is what is sent. db/migrations/5870_recruitment_candidate_email.sql refuses the same illegal templates, settings
 * and rows again.
 */
import { isCanonicalEmailAddress } from '../../lib/email-address';

/** The kinds candidate e-mail sends: slice 19's receipt and rejection, slice 20's interview invitation, reminder and cancellation
 *  and offer (5871 adds them to the CHECKs and restates the placeholder allowlist), and slice 22's survey (5874). */
export const CANDIDATE_EMAIL_KINDS = ['application_received', 'rejection', 'interview_invitation', 'interview_reminder', 'interview_cancelled', 'offer', 'survey'] as const;
export const INTERVIEW_EMAIL_KINDS = ['interview_invitation', 'interview_reminder', 'interview_cancelled'] as const;
export type InterviewEmailKind = (typeof INTERVIEW_EMAIL_KINDS)[number];
export type CandidateEmailKind = (typeof CANDIDATE_EMAIL_KINDS)[number];

/** The six app languages a template may be written in. */
export const CANDIDATE_EMAIL_LOCALES = ['en', 'ms', 'zh', 'vi', 'ta', 'th'] as const;
export type CandidateEmailLocale = (typeof CANDIDATE_EMAIL_LOCALES)[number];

/** The values every candidate e-mail may name: the candidate's own name, the job's title, the company and the sender. */
export const BASE_PLACEHOLDERS = ['candidateName', 'jobTitle', 'companyName', 'senderName'] as const;
export type BasePlaceholder = (typeof BASE_PLACEHOLDERS)[number];
/** Slice 20: what an interview e-mail may state — never the interviewers. The cancellation names the interview, not its place. */
export const INTERVIEW_PLACEHOLDERS = ['interviewRound', 'interviewType', 'interviewDate', 'interviewTime', 'interviewDuration', 'interviewPlace'] as const;
export type InterviewPlaceholder = (typeof INTERVIEW_PLACEHOLDERS)[number];
export const CANDIDATE_EMAIL_PLACEHOLDERS: Record<CandidateEmailKind, readonly string[]> = {
  application_received: BASE_PLACEHOLDERS,
  rejection: BASE_PLACEHOLDERS,
  interview_invitation: [...BASE_PLACEHOLDERS, ...INTERVIEW_PLACEHOLDERS, 'responseLink'],
  interview_reminder: [...BASE_PLACEHOLDERS, ...INTERVIEW_PLACEHOLDERS],
  interview_cancelled: [...BASE_PLACEHOLDERS, 'interviewRound', 'interviewType', 'interviewDate', 'interviewTime'],
  offer: [...BASE_PLACEHOLDERS, 'offerDetails', 'responseLink'],
  // Slice 22: the survey link, put in by the sweep at send time (the frozen e-mail keeps the placeholder itself).
  survey: [...BASE_PLACEHOLDERS, 'surveyLink'],
};
export type Placeholder = BasePlaceholder | InterviewPlaceholder | 'offerDetails' | 'responseLink' | 'surveyLink';
export type CandidateEmailValues = Record<BasePlaceholder, string> & Partial<Record<InterviewPlaceholder | 'offerDetails' | 'responseLink' | 'surveyLink', string>>;
/** The longest value each placeholder can take: candidate names and job titles are at most 200 (5851), the sender name 80; the company
 *  name has no stored limit, so the renderer cuts every value to these lengths and a template's worst case is known at save time.
 *  Slice 20: the interview values are formatted here (below) from bounded parts; the place is at most a room (120), an address name
 *  (120), an address (500), a region (120) and a map link (2,000) with separators; offer details are refused above 10,000 characters
 *  (offerDetailsText) rather than cut, so a cut can never change an amount. */
export const CANDIDATE_EMAIL_VALUE_MAX: Record<Placeholder, number> = {
  candidateName: 200, jobTitle: 200, companyName: 200, senderName: 80,
  interviewRound: 80, interviewType: 80, interviewDate: 120, interviewTime: 160, interviewDuration: 80, interviewPlace: 3200, offerDetails: 10000,
  // Slice 21b: one sentence with the response link (at most 400 characters, 5873).
  responseLink: 600,
  // Slice 22: the survey link the sweep puts in (https, the installation host and a 43-character token).
  surveyLink: 300,
};
/** What 5870 freezes at most: the rendered subject and text. A template whose worst case (every placeholder at its longest value)
 *  exceeds these is refused on save (email_too_long), so a render can never exceed the frozen columns. The HTML is then at most
 *  6 x the text plus its wrapper (an escaped character is at most 6 characters), well inside its 200,000. */
export const CANDIDATE_EMAIL_FROZEN_SUBJECT_MAX = 1000;
export const CANDIDATE_EMAIL_FROZEN_TEXT_MAX = 20000;
export const CANDIDATE_EMAIL_FROZEN_HTML_MAX = 200000;

export const CANDIDATE_EMAIL_SUBJECT_MAX = 200;
export const CANDIDATE_EMAIL_BODY_MAX = 5000;
export const CANDIDATE_EMAIL_SENDER_NAME_MAX = 80;
export const CANDIDATE_EMAIL_REPLY_TO_MAX = 254;
/** Per company, e-mails queued in any hour (5870 counts the same under a per-company lock). */
export const CANDIDATE_EMAIL_HOURLY_CAP = 500;
/** A rejection e-mail is sent now or 1, 2 or 3 days later, as the person chooses. */
export const REJECTION_EMAIL_DELAYS = [0, 1, 2, 3] as const;
export type RejectionEmailDelay = (typeof REJECTION_EMAIL_DELAYS)[number];
export const CANDIDATE_EMAIL_MAX_ATTEMPTS = 5;
export const CANDIDATE_EMAIL_PURGE_DAYS = 90;
/** The application page lists at most this many e-mails (an application gets a receipt and a rejection; retries reuse rows). */
export const CANDIDATE_EMAIL_LIST_LIMIT = 50;

export const CANDIDATE_EMAIL_STATES = ['queued', 'leased', 'sending', 'sent', 'retry', 'failed', 'uncertain', 'withdrawn'] as const;
export type CandidateEmailState = (typeof CANDIDATE_EMAIL_STATES)[number];
/** What a person sees: queued (waiting, or waiting to try again), sending, sent, failed, uncertain or (slice 20) withdrawn. */
export type CandidateEmailDisplayState = 'queued' | 'sending' | 'sent' | 'failed' | 'uncertain' | 'withdrawn';
export function candidateEmailDisplayState(state: CandidateEmailState): CandidateEmailDisplayState {
  return state === 'retry' ? 'queued' : state === 'leased' ? 'sending' : state;
}
/** An administrator may retry only a failed or uncertain e-mail whose content is still kept. */
export function candidateEmailRetryable(state: CandidateEmailState, purged: boolean): boolean {
  return (state === 'failed' || state === 'uncertain') && !purged;
}

/** The sweep's backoff after a temporary (4xx) refusal: min(3600, 60·2^attempts) seconds (the 0527 pattern). */
export function candidateEmailBackoffSeconds(attempts: number): number {
  return Math.min(3600, 60 * 2 ** Math.max(0, attempts));
}

const CONTROL_SUBJECT = /[\u0001-\u001f\u007f-\u009f]/;
const CONTROL_BODY = /[\u0001-\u0009\u000b-\u001f\u007f-\u009f]/;
/** Link-like text, the SAME pattern as 5870's app.recruitment_candidate_email_linkish (a test compares them): a known scheme followed by
 *  ":" and more (http, https, ftp, mailto, tel, sms, data, javascript, vbscript, file), any "://", a "//" at the start or after a space
 *  or punctuation, "www" with any dot (Unicode dots too), punycode, or a bare domain followed by "/" ("evil.example/login").
 *  Case-insensitive. Ordinary names and titles ("S.Kumar", "Node.js Developer", "Ref:HR-12") are not link-like. Templates must not
 *  contain one; an e-mail whose subject or text would, once a candidate's values are filled in, is not sent to that candidate. */
export const LINK_PATTERN = '(^|[^a-z0-9])(https?|ftp|mailto|tel|sms|data|javascript|vbscript|file):\\S|://|(^|[^a-z0-9])//|www[.。．｡]|xn--|[a-z0-9-][.。．｡][a-z]{2,}/';
const LINK = new RegExp(LINK_PATTERN, 'i');
export const linkish = (text: string) => LINK.test(text);
/** The HTML grammar the renderer emits and 5870's body_html CHECK accepts (the same text): its wrapper, paragraphs, line breaks and
 *  five entities only. */
export const HTML_GRAMMAR = '^<!doctype html><html lang="(en|ms|zh|vi|ta|th)"><head><meta charset="utf-8"></head><body>(<p>([^<>&]|<br>|&(amp|lt|gt|quot|#39);)*</p>)*</body></html>$';
const PLACEHOLDER = /\{([^{}]*)\}/g;

/** The placeholders a text names, and whether a brace is left outside a {name} pair. */
export function templatePlaceholders(text: string): { names: string[]; stray: boolean } {
  const names = [...text.matchAll(PLACEHOLDER)].map((m) => m[1]);
  return { names, stray: /[{}]/.test(text.replace(PLACEHOLDER, '')) };
}

export type TemplateRefusal = 'missing_fields' | 'invalid_input' | 'email_placeholder' | 'email_link' | 'email_too_long' | 'email_survey_link';
const SURVEY_LINK_PLACEHOLDER_NAME = 'surveyLink';
const len = (s: string) => [...s].length;
/** The longest a text can render to: its own characters plus, for each placeholder, its longest value. */
export function worstCaseLength(kind: CandidateEmailKind, text: string): number {
  const allowed = new Set(CANDIDATE_EMAIL_PLACEHOLDERS[kind]);
  let n = len(text.replace(PLACEHOLDER, ''));
  for (const m of text.matchAll(PLACEHOLDER)) n += allowed.has(m[1]) ? CANDIDATE_EMAIL_VALUE_MAX[m[1] as Placeholder] : 0;
  return n;
}
export type ValidTemplate = { subject: string; body: string };
/**
 * A company override: subject 1–200 characters on one line, body 1–5,000 characters of plain text (line breaks kept, \r\n made \n),
 * every {…} a placeholder of the kind, no stray brace, and no link (no images, attachments, links or tracking in this slice).
 */
export function validateCandidateEmailTemplate(kind: CandidateEmailKind, input: { subject?: unknown; body?: unknown }):
  { ok: true; value: ValidTemplate } | { ok: false; code: TemplateRefusal; fields: ('subject' | 'body')[] } {
  const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
  const body = typeof input.body === 'string' ? input.body.replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '') : '';
  const missing = [...(subject ? [] : ['subject' as const]), ...(body ? [] : ['body' as const])];
  if (missing.length) return { ok: false, code: 'missing_fields', fields: missing };
  const invalid = [
    ...([...subject].length > CANDIDATE_EMAIL_SUBJECT_MAX || CONTROL_SUBJECT.test(subject) ? ['subject' as const] : []),
    ...([...body].length > CANDIDATE_EMAIL_BODY_MAX || CONTROL_BODY.test(body) ? ['body' as const] : []),
  ];
  if (invalid.length) return { ok: false, code: 'invalid_input', fields: invalid };
  const allowed = new Set(CANDIDATE_EMAIL_PLACEHOLDERS[kind]);
  const bad = (['subject', 'body'] as const).filter((f) => {
    const p = templatePlaceholders(f === 'subject' ? subject : body);
    return p.stray || p.names.some((n) => !allowed.has(n));
  });
  if (bad.length) return { ok: false, code: 'email_placeholder', fields: bad };
  // Slice 22: a survey's body names {surveyLink} exactly once and its subject never (5874 checks the frozen e-mail the same way).
  if (kind === 'survey') {
    const misplaced = [
      ...(templatePlaceholders(subject).names.includes(SURVEY_LINK_PLACEHOLDER_NAME) ? ['subject' as const] : []),
      ...(templatePlaceholders(body).names.filter((n) => n === SURVEY_LINK_PLACEHOLDER_NAME).length !== 1 ? ['body' as const] : []),
    ];
    if (misplaced.length) return { ok: false, code: 'email_survey_link', fields: misplaced };
  }
  const linked = (['subject', 'body'] as const).filter((f) => linkish(f === 'subject' ? subject : body));
  if (linked.length) return { ok: false, code: 'email_link', fields: linked };
  const long = [
    ...(worstCaseLength(kind, subject) > CANDIDATE_EMAIL_FROZEN_SUBJECT_MAX ? ['subject' as const] : []),
    ...(worstCaseLength(kind, body) > CANDIDATE_EMAIL_FROZEN_TEXT_MAX ? ['body' as const] : []),
  ];
  if (long.length) return { ok: false, code: 'email_too_long', fields: long };
  return { ok: true, value: { subject, body } };
}

/** A reply-to address: the transport's canonical-address rule (lib/email-address.ts), at most 254 characters. */
export function validReplyTo(value: string): boolean {
  return value.length <= CANDIDATE_EMAIL_REPLY_TO_MAX && isCanonicalEmailAddress(value);
}
/** A candidate's recorded e-mail the transport would accept (the same canonical rule, at most 254 as 5870 stores it); anything else
 *  counts as no usable address: the candidate is skipped and the person told. */
export function usableRecipient(email: string | null | undefined): email is string {
  return typeof email === 'string' && email.length <= CANDIDATE_EMAIL_REPLY_TO_MAX && isCanonicalEmailAddress(email);
}
/** Characters the transport refuses in a display name (lib/managed-email-policy.ts validManagedEmailSenderName: control characters
 *  and @ < > ", so a name never looks like another mailbox); the C1 controls are refused here as well. 5870's sender CHECKs use the
 *  same class. */
export const SENDER_NAME_REFUSED = /[\u0001-\u001f\u007f-\u009f@<>"]/;
/** The display name used when the company sets none — the same rule as 5870's app.recruitment_candidate_email_sender (D-064): every
 *  character the transport refuses made a space, runs of spaces made one, leading space removed, cut to 80 characters, trailing space
 *  removed (JavaScript's trim set, which includes the no-break and ideographic spaces the transport's check removes). A company name
 *  with nothing else left gives '': the company must then set its own sender name to switch candidate e-mail on. */
export function defaultSenderName(companyName: string): string {
  return [...companyName.replace(/[\u0001-\u001f\u007f-\u009f@<>"]/g, ' ').replace(/ {2,}/g, ' ').trimStart()]
    .slice(0, CANDIDATE_EMAIL_SENDER_NAME_MAX).join('').trimEnd();
}

export type CandidateEmailSettingsInput = { enabled?: unknown; senderName?: unknown; replyTo?: unknown; locale?: unknown; reminderEnabled?: unknown; reminderHours?: unknown;
  surveyHired?: unknown; surveyRejected?: unknown; surveyDelayDays?: unknown };
export type ValidCandidateEmailSettings = { enabled: boolean; senderName: string | null; replyTo: string | null; locale: CandidateEmailLocale;
  reminderEnabled: boolean; reminderHours: number; surveyHired: boolean; surveyRejected: boolean; surveyDelayDays: number };
/** The company's switch, sender display name (≤80, none of the characters the transport refuses; empty = the company name),
 *  reply-to (required when on) and language. */
export function validateCandidateEmailSettings(input: CandidateEmailSettingsInput):
  { ok: true; value: ValidCandidateEmailSettings } | { ok: false; code: 'missing_fields' | 'invalid_input'; fields: string[] } {
  const enabled = input.enabled === true || input.enabled === 'on' || input.enabled === 'true';
  const senderName = typeof input.senderName === 'string' && input.senderName.trim() ? input.senderName.trim() : null;
  const replyTo = typeof input.replyTo === 'string' && input.replyTo.trim() ? input.replyTo.trim().toLowerCase() : null;
  const locale = input.locale == null || input.locale === '' ? 'en' : input.locale;
  // Slice 20: reminders are on unless switched off (an absent field keeps the default); hours 2–72, default 24.
  const reminderEnabled = input.reminderEnabled === undefined ? true : input.reminderEnabled === true || input.reminderEnabled === 'on' || input.reminderEnabled === 'true';
  const reminderHours = input.reminderHours == null || input.reminderHours === '' ? REMINDER_HOURS_DEFAULT : parseReminderHours(input.reminderHours);
  // Slice 22: the survey is off unless ticked; it is sent 1–14 days after the decision (default 3).
  const ticked = (v: unknown) => v === true || v === 'on' || v === 'true';
  const surveyDelayDays = input.surveyDelayDays == null || input.surveyDelayDays === '' ? SURVEY_DELAY_DEFAULT : parseSurveyDelay(input.surveyDelayDays);
  if (enabled && !replyTo) return { ok: false, code: 'missing_fields', fields: ['replyTo'] };
  const fields = [
    ...(senderName && ([...senderName].length > CANDIDATE_EMAIL_SENDER_NAME_MAX || SENDER_NAME_REFUSED.test(senderName)) ? ['senderName'] : []),
    ...(replyTo && !validReplyTo(replyTo) ? ['replyTo'] : []),
    ...((CANDIDATE_EMAIL_LOCALES as readonly unknown[]).includes(locale) ? [] : ['locale']),
    ...(reminderHours === null ? ['reminderHours'] : []),
    ...(surveyDelayDays === null ? ['surveyDelayDays'] : []),
  ];
  if (fields.length) return { ok: false, code: 'invalid_input', fields };
  return { ok: true, value: { enabled, senderName, replyTo, locale: locale as CandidateEmailLocale, reminderEnabled, reminderHours: reminderHours!,
    surveyHired: ticked(input.surveyHired), surveyRejected: ticked(input.surveyRejected), surveyDelayDays: surveyDelayDays! } };
}

/** A rejection delay chosen in the dialog: 0–3 whole days. */
export function parseRejectionDelay(value: unknown): RejectionEmailDelay | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^[0-3]$/.test(value.trim()) ? Number(value.trim()) : NaN;
  return (REJECTION_EMAIL_DELAYS as readonly number[]).includes(n) ? (n as RejectionEmailDelay) : null;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const clip = (name: string, value: string) => [...value].slice(0, CANDIDATE_EMAIL_VALUE_MAX[name as Placeholder] ?? 0).join('');
const fill = (template: string, values: Readonly<Record<string, string | undefined>>, allowed: ReadonlySet<string>, wrap: (v: string) => string = (v) => v) =>
  // One pass: a value that itself contains "{jobTitle}" is never expanded again. A name outside the allowlist (refused on save; a
  // code default never has one) renders as nothing.
  template.replace(PLACEHOLDER, (_m, name: string) => (allowed.has(name) ? wrap(clip(name, values[name] ?? '')) : ''));

export type RenderedCandidateEmail = { subject: string; text: string; html: string };
/**
 * The e-mail as the candidate receives it. Subject: the values filled in, control characters made spaces, trimmed. Text: the body
 * with the values. HTML: paragraphs (a blank line) and line breaks only, every character of the template and of each value escaped;
 * no link, image, style or script.
 */
export function renderCandidateEmail(kind: CandidateEmailKind, locale: CandidateEmailLocale, template: ValidTemplate, values: CandidateEmailValues): RenderedCandidateEmail {
  const allowed = new Set(CANDIDATE_EMAIL_PLACEHOLDERS[kind]);
  const subject = fill(template.subject, values, allowed).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  const body = template.body.replace(/\r\n?/g, '\n');
  const text = fill(body, values, allowed).replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ');
  const paragraphs = body.split(/\n{2,}/).map((p) => p.replace(/^\n+|\n+$/g, '')).filter((p) => p.trim() !== '');
  const html = `<!doctype html><html lang="${escapeHtml(locale)}"><head><meta charset="utf-8"></head><body>`
    + paragraphs.map((p) => `<p>${p.split('\n').map((line) => fill(escapeHtml(line), values, allowed,
      // A value's own line breaks (slice 20: one offer field per line) become <br>; every other control character a space.
      (v) => escapeHtml(v.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ')).replace(/\n/g, '<br>'))).join('<br>')}</p>`).join('')
    + '</body></html>';
  return { subject, text, html };
}

// ── Slice 20: interviews and offers ───────────────────────────────────────────────────────────────────────────────

/** Reminder settings: on by default, 24 hours before; 2–72 hours. */
export const REMINDER_HOURS_DEFAULT = 24;
export const REMINDER_HOURS_MIN = 2;
export const REMINDER_HOURS_MAX = 72;
export function parseReminderHours(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,2}$/.test(value.trim()) ? Number(value.trim()) : NaN;
  return Number.isInteger(n) && n >= REMINDER_HOURS_MIN && n <= REMINDER_HOURS_MAX ? n : null;
}
/** When a reminder is due: the interview's start minus the company's hours — or none when that moment is not ahead of `now` (an
 *  interview scheduled closer than that gets its invitation only). 5871 pins the same time. */
export function reminderDueAt(startsAt: Date, hours: number, now: Date): Date | null {
  const due = new Date(startsAt.getTime() - hours * 3_600_000);
  return due.getTime() > now.getTime() ? due : null;
}

/** The words an interview e-mail's values are made of, in the e-mail's language (messages recruitment.candidateEmail.interview). Simple
 *  {name} templates, filled here, so the preview a browser shows and the e-mail the server freezes are the same characters. */
export type InterviewEmailLabels = {
  /** "Round {round}" */
  round: string;
  types: Record<'onsite' | 'video' | 'phone', string>;
  /** Monday first … Sunday last. */
  weekdays: readonly string[];
  /** "{weekday}, {date}" with {date} as YYYY-MM-DD */
  date: string;
  /** "{start} to {end}, Kuala Lumpur time (GMT+8)" with 24-hour HH:MM */
  time: string;
  /** "{minutes} minutes" */
  duration: string;
  /** Where a video or phone interview is: the details come by reply (no link in this slice). */
  remote: Record<'video' | 'phone', string>;
  /** "Map: {url}" */
  map: string;
  /** No place was recorded for an on-site interview. */
  noPlace: string;
};
export type InterviewEmailFacts = {
  roundNo: number; type: 'onsite' | 'video' | 'phone'; startsAt: Date; durationMinutes: number;
  /** Slice 18: the address and room the interview names (on-site only), or slice 2's free-text site and meeting room. */
  room: string | null; address: { name: string; address: string; region: string; mapUrl: string | null } | null;
  site: string | null; meetingRoom: string | null;
};
const sub = (template: string, values: Record<string, string>) => template.replace(/\{([a-zA-Z]+)\}/g, (m, k: string) => (k in values ? values[k] : m));
const pad = (n: number) => String(n).padStart(2, '0');
/** Kuala Lumpur wall-clock parts of an instant: UTC+8 all year (no daylight saving), computed without Intl so every runtime agrees. */
export function klParts(at: Date): { date: string; time: string; weekday: number } {
  const kl = new Date(at.getTime() + 8 * 3_600_000);
  return { date: `${kl.getUTCFullYear()}-${pad(kl.getUTCMonth() + 1)}-${pad(kl.getUTCDate())}`, time: `${pad(kl.getUTCHours())}:${pad(kl.getUTCMinutes())}`,
    weekday: (kl.getUTCDay() + 6) % 7 };
}
const oneLine = (v: string) => v.replace(/\s+/g, ' ').trim();
/**
 * The interview values an invitation, reminder or cancellation states (never the interviewers): the round, the type, the date and
 * time in Kuala Lumpur time with the zone named, the duration, and the place — for an on-site interview the room, the address's name,
 * address and region and its https map link (the one link a candidate e-mail may carry, D-065), or the free-text site and meeting room;
 * for a video or phone interview a sentence that the details follow. `mapUrl` is the link the place names (null without one).
 */
export function interviewEmailValues(f: InterviewEmailFacts, labels: InterviewEmailLabels): { values: Record<InterviewPlaceholder, string>; mapUrl: string | null } {
  const start = klParts(f.startsAt);
  const end = klParts(new Date(f.startsAt.getTime() + f.durationMinutes * 60_000));
  let place: string;
  let mapUrl: string | null = null;
  if (f.type !== 'onsite') place = labels.remote[f.type];
  else if (f.address) {
    mapUrl = f.address.mapUrl;
    place = [f.room, f.address.name, f.address.address, f.address.region].filter((x): x is string => !!x && !!x.trim()).map(oneLine).join(', ')
      + (mapUrl ? ` · ${sub(labels.map, { url: mapUrl })}` : '');
  } else {
    const parts = [f.meetingRoom, f.site].filter((x): x is string => !!x && !!x.trim()).map(oneLine);
    place = parts.length ? parts.join(', ') : labels.noPlace;
  }
  return {
    mapUrl,
    values: {
      interviewRound: sub(labels.round, { round: String(f.roundNo) }),
      interviewType: labels.types[f.type],
      interviewDate: sub(labels.date, { weekday: labels.weekdays[start.weekday] ?? '', date: start.date }),
      interviewTime: sub(labels.time, { start: start.time, end: end.time }),
      interviewDuration: sub(labels.duration, { minutes: String(f.durationMinutes) }),
      interviewPlace: place,
    },
  };
}
/** Link-like text with exactly the given map link removed (the frozen text's rule in 5871: every other link still refuses). */
export function linkishExcept(text: string, mapUrl: string | null, responseUrl: string | null = null): boolean {
  let t = mapUrl ? text.split(mapUrl).join(' ') : text;
  if (responseUrl) t = t.split(responseUrl).join(' ');
  return linkish(t);
}
/** Slice 21b: the response link's sentence ("Accept or decline here: {url}"), or '' without a link. 5873 holds the URL itself to
 *  https://<host>/careers/r/<43-character token>. */
export const RESPONSE_URL_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?\/careers\/r\/[A-Za-z0-9_-]{43}$/;
export function responseLinkValue(sentence: string, url: string | null): string {
  return url && RESPONSE_URL_PATTERN.test(url) ? sentence.split('{url}').join(url) : '';
}

/** One offer field as an offer e-mail states it: its label and the value people entered, as entered (money as currency and amount,
 *  never computed or reformatted). */
export type OfferEmailLine = { label: string; value: string };
/** The offer details block: one "Label: value" line per field marked "include in e-mail", in the company's field order. Null when it
 *  would be longer than CANDIDATE_EMAIL_VALUE_MAX.offerDetails (refused, never cut: a cut could change an amount). */
export function offerDetailsText(lines: readonly OfferEmailLine[]): string | null {
  const text = lines.map((l) => `${oneLine(l.label)}: ${l.value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()}`).join('\n');
  return [...text].length > CANDIDATE_EMAIL_VALUE_MAX.offerDetails ? null : text;
}

/**
 * An interview e-mail as the candidate receives it — the ONE function the schedule form's live preview (in the browser), the
 * cancellation preview, the frozen invitation, reminder and cancellation all call. `mapUrl` is what 5871 freezes (never for a
 * cancellation, which names no place); `valueLink` when a value would make the subject link-like or the text link-like other than by
 * exactly that map link (the e-mail is then not sent).
 */
export function renderInterviewEmail(kind: InterviewEmailKind, locale: CandidateEmailLocale, template: ValidTemplate,
  base: Record<BasePlaceholder, string>, facts: InterviewEmailFacts, labels: InterviewEmailLabels,
  response: { sentence: string; url: string | null } | null = null): { mail: RenderedCandidateEmail; mapUrl: string | null; valueLink: boolean } {
  const iv = interviewEmailValues(facts, labels);
  const mapUrl = kind === 'interview_cancelled' ? null : iv.mapUrl;
  // Slice 21b: only an invitation carries the response link.
  const responseUrl = kind === 'interview_invitation' && response ? response.url : null;
  const responseLink = kind === 'interview_invitation' && response ? responseLinkValue(response.sentence, response.url) : '';
  const mail = renderCandidateEmail(kind, locale, template, { ...base, ...iv.values, responseLink });
  return { mail, mapUrl, valueLink: linkish(mail.subject) || linkishExcept(mail.text, mapUrl, responseUrl) };
}

/** The place an interview names, from what the schedule form offers (slice 18's resolvePlace rule: a room names its address; a place
 *  only for an on-site interview). Used by the browser preview; the server reads the saved interview's place instead. */
export type InterviewPlaceOption = { id: string; name: string; address: string; region: string; mapUrl: string | null; rooms: { id: string; name: string }[] };
export function interviewFactsFromForm(form: { roundNo: number; type: 'onsite' | 'video' | 'phone'; startsAt: Date; durationMinutes: number; addressId: string | null;
  roomId: string | null; site: string | null; meetingRoom: string | null }, places: readonly InterviewPlaceOption[]): InterviewEmailFacts {
  const onsite = form.type === 'onsite';
  const byRoom = form.roomId ? places.find((p) => p.rooms.some((r) => r.id === form.roomId)) ?? null : null;
  const place = onsite ? byRoom ?? (form.addressId ? places.find((p) => p.id === form.addressId) ?? null : null) : null;
  const room = onsite && byRoom ? byRoom.rooms.find((r) => r.id === form.roomId)?.name ?? null : null;
  return {
    roundNo: form.roundNo, type: form.type, startsAt: form.startsAt, durationMinutes: form.durationMinutes,
    room: room ?? form.meetingRoom, address: place ? { name: place.name, address: place.address, region: place.region, mapUrl: place.mapUrl } : null,
    site: form.site, meetingRoom: form.meetingRoom,
  };
}

// ── Slice 22: the anonymous candidate survey ─────────────────────────────────────────────────────────────────────

/** What the frozen survey e-mail holds where the link goes; the sweep replaces it with a fresh link when it sends (5874). */
export const SURVEY_LINK_PLACEHOLDER = '{surveyLink}';
/** Sent 1–14 days after the hire, or after the rejection e-mail; default 3. */
export const SURVEY_DELAY_DEFAULT = 3;
export const SURVEY_DELAY_MIN = 1;
export const SURVEY_DELAY_MAX = 14;
export function parseSurveyDelay(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,2}$/.test(value.trim()) ? Number(value.trim()) : NaN;
  return Number.isInteger(n) && n >= SURVEY_DELAY_MIN && n <= SURVEY_DELAY_MAX ? n : null;
}
/** The survey link the sweep makes: the installation's https origin and a 43-character token on the careers host. */
export const SURVEY_URL_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?\/careers\/s\/[A-Za-z0-9_-]{43}$/;
/** The message as sent: the frozen subject, text and HTML with the one placeholder replaced by the link (null when the frozen content
 *  does not hold it exactly once in the text and HTML and never in the subject — 5874 refuses such a row, so this is a backstop). */
export function withSurveyLink(m: RenderedCandidateEmail, url: string): RenderedCandidateEmail | null {
  const once = (t: string) => t.split(SURVEY_LINK_PLACEHOLDER).length === 2;
  if (!SURVEY_URL_PATTERN.test(url) || m.subject.includes(SURVEY_LINK_PLACEHOLDER) || !once(m.text) || !once(m.html)) return null;
  return { subject: m.subject, text: m.text.replace(SURVEY_LINK_PLACEHOLDER, url), html: m.html.replace(SURVEY_LINK_PLACEHOLDER, url) };
}

/** The rating questions (1–5; overall is required), then would-recommend and an optional comment. Code-owned (D-067). */
export const SURVEY_RATINGS = ['overall', 'communication', 'respect', 'process'] as const;
export type SurveyRating = (typeof SURVEY_RATINGS)[number];
export const SURVEY_RECOMMEND = ['yes', 'no', 'unsure'] as const;
export type SurveyRecommend = (typeof SURVEY_RECOMMEND)[number];
export const SURVEY_COMMENT_MAX = 1000;
export type SurveyAnswers = Record<'overall', number> & Partial<Record<Exclude<SurveyRating, 'overall'>, number>> & { recommend?: SurveyRecommend; comment?: string };
/** A posted survey form: each rating 1–5 (overall required), recommend yes/no/unsure, a comment of at most 1,000 characters (line breaks
 *  kept, other control characters refused, trimmed; empty = none). */
export function validateSurveyAnswers(form: Readonly<Record<string, unknown>>):
  { ok: true; value: SurveyAnswers } | { ok: false; fields: string[] } {
  const fields: string[] = [];
  const out: Record<string, unknown> = {};
  for (const q of SURVEY_RATINGS) {
    const v = form[q];
    if (v == null || v === '') { if (q === 'overall') fields.push(q); continue; }
    if (typeof v !== 'string' || !/^[1-5]$/.test(v.trim())) { fields.push(q); continue; }
    out[q] = Number(v.trim());
  }
  const r = form.recommend;
  if (r != null && r !== '') {
    if (typeof r === 'string' && (SURVEY_RECOMMEND as readonly string[]).includes(r)) out.recommend = r;
    else fields.push('recommend');
  }
  const c = form.comment;
  if (c != null) {
    const text = typeof c === 'string' ? c.replace(/\r\n?/g, '\n').trim() : null;
    if (text === null || [...text].length > SURVEY_COMMENT_MAX || /[\u0001-\u0009\u000b-\u001f\u007f-\u009f]/.test(text)) fields.push('comment');
    else if (text) out.comment = text;
  }
  return fields.length ? { ok: false, fields } : { ok: true, value: out as SurveyAnswers };
}

/** Results appear only from this many answers in the selection; the hired and rejected split only with this many on each side. */
export const SURVEY_MIN_RESPONSES = 5;
/** The comments a results page lists at most (in no particular order, without dates). */
export const SURVEY_COMMENT_LIMIT = 200;
/** The counts a results page is computed from, for one outcome (or both): how many answered, how many gave each overall rating, the
 *  count and sum of each rating that was answered, and the recommend answers. The database aggregates these; nothing per answer. */
export type SurveyTally = {
  responses: number;
  overall: [number, number, number, number, number];
  ratings: Record<SurveyRating, { count: number; sum: number }>;
  recommend: Record<SurveyRecommend, number>;
};
export const emptySurveyTally = (): SurveyTally => ({ responses: 0, overall: [0, 0, 0, 0, 0],
  ratings: { overall: { count: 0, sum: 0 }, communication: { count: 0, sum: 0 }, respect: { count: 0, sum: 0 }, process: { count: 0, sum: 0 } },
  recommend: { yes: 0, no: 0, unsure: 0 } });
export function addSurveyTallies(a: SurveyTally, b: SurveyTally): SurveyTally {
  return {
    responses: a.responses + b.responses,
    overall: a.overall.map((n, i) => n + b.overall[i]) as SurveyTally['overall'],
    ratings: Object.fromEntries(SURVEY_RATINGS.map((q) => [q, { count: a.ratings[q].count + b.ratings[q].count, sum: a.ratings[q].sum + b.ratings[q].sum }])) as SurveyTally['ratings'],
    recommend: { yes: a.recommend.yes + b.recommend.yes, no: a.recommend.no + b.recommend.no, unsure: a.recommend.unsure + b.recommend.unsure },
  };
}
export type SurveyFigures = {
  responses: number;
  /** Average of each rating over the answers that gave it (one decimal), null when none did. */
  averages: Record<SurveyRating, number | null>;
  /** How many gave each overall rating, 1 to 5. */
  overallDistribution: [number, number, number, number, number];
  /** Share (0–1) of each recommend answer among those who answered it (null when none did); `answered` is how many did. */
  recommend: { answered: number; yes: number | null; no: number | null; unsure: number | null };
};
export function surveyFigures(t: SurveyTally): SurveyFigures {
  const averages = Object.fromEntries(SURVEY_RATINGS.map((q) => [q, t.ratings[q].count ? Math.round((t.ratings[q].sum / t.ratings[q].count) * 10) / 10 : null])) as Record<SurveyRating, number | null>;
  const answered = t.recommend.yes + t.recommend.no + t.recommend.unsure;
  const share = (n: number) => (answered ? n / answered : null);
  return { responses: t.responses, averages, overallDistribution: [...t.overall] as SurveyFigures['overallDistribution'],
    recommend: { answered, yes: share(t.recommend.yes), no: share(t.recommend.no), unsure: share(t.recommend.unsure) } };
}
export type SurveySummary =
  | { shown: false; minimum: number }
  | { shown: true; all: SurveyFigures; split: { hired: SurveyFigures; rejected: SurveyFigures } | null; comments: string[] };
/** The results a page may show: nothing below SURVEY_MIN_RESPONSES answers in the selection (so no answer can be tied to the few
 *  candidates of a period), the hired and rejected split only when each side has that many, and the comments as given. */
export function summarizeSurvey(t: { hired: SurveyTally; rejected: SurveyTally }, comments: readonly string[]): SurveySummary {
  const all = addSurveyTallies(t.hired, t.rejected);
  if (all.responses < SURVEY_MIN_RESPONSES) return { shown: false, minimum: SURVEY_MIN_RESPONSES };
  return {
    shown: true, all: surveyFigures(all),
    split: t.hired.responses >= SURVEY_MIN_RESPONSES && t.rejected.responses >= SURVEY_MIN_RESPONSES ? { hired: surveyFigures(t.hired), rejected: surveyFigures(t.rejected) } : null,
    comments: comments.slice(0, SURVEY_COMMENT_LIMIT),
  };
}
