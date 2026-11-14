/**
 * Candidate e-mail rules (slice 19, D-063, docs/adr/2026-11-14-recruitment-candidate-email.md). Pure and client-safe: the kinds and
 * their placeholder allowlists, the limits, template and settings validation, and the ONE renderer every candidate e-mail goes
 * through — the preview a person sees, the content frozen at queue time and the careers receipt all call renderCandidateEmail, so
 * what is previewed is what is sent. db/migrations/5720_recruitment_candidate_email.sql refuses the same illegal templates, settings
 * and rows again.
 */
import { isCanonicalEmailAddress } from '../../lib/email-address';

/** The kinds this slice sends. Slice 20 adds 'interview_invitation', 'interview_reminder', 'interview_cancelled' and 'offer'
 *  here, in CANDIDATE_EMAIL_PLACEHOLDERS (with their interview and offer fields), in the messages defaults and in 5720's CHECKs. */
export const CANDIDATE_EMAIL_KINDS = ['application_received', 'rejection'] as const;
export type CandidateEmailKind = (typeof CANDIDATE_EMAIL_KINDS)[number];

/** The six app languages a template may be written in. */
export const CANDIDATE_EMAIL_LOCALES = ['en', 'ms', 'zh', 'vi', 'ta', 'th'] as const;
export type CandidateEmailLocale = (typeof CANDIDATE_EMAIL_LOCALES)[number];

/** The values every candidate e-mail may name: the candidate's own name, the job's title, the company and the sender. */
export const BASE_PLACEHOLDERS = ['candidateName', 'jobTitle', 'companyName', 'senderName'] as const;
export type BasePlaceholder = (typeof BASE_PLACEHOLDERS)[number];
export const CANDIDATE_EMAIL_PLACEHOLDERS: Record<CandidateEmailKind, readonly string[]> = {
  application_received: BASE_PLACEHOLDERS,
  rejection: BASE_PLACEHOLDERS,
};
export type CandidateEmailValues = Record<BasePlaceholder, string>;
/** The longest value each placeholder can take: candidate names and job titles are at most 200 (5701), the sender name 80; the company
 *  name has no stored limit, so the renderer cuts every value to these lengths and a template's worst case is known at save time. */
export const CANDIDATE_EMAIL_VALUE_MAX: Record<BasePlaceholder, number> = { candidateName: 200, jobTitle: 200, companyName: 200, senderName: 80 };
/** What 5720 freezes at most: the rendered subject and text. A template whose worst case (every placeholder at its longest value)
 *  exceeds these is refused on save (email_too_long), so a render can never exceed the frozen columns. The HTML is then at most
 *  6 x the text plus its wrapper (an escaped character is at most 6 characters), well inside its 200,000. */
export const CANDIDATE_EMAIL_FROZEN_SUBJECT_MAX = 1000;
export const CANDIDATE_EMAIL_FROZEN_TEXT_MAX = 20000;
export const CANDIDATE_EMAIL_FROZEN_HTML_MAX = 200000;

export const CANDIDATE_EMAIL_SUBJECT_MAX = 200;
export const CANDIDATE_EMAIL_BODY_MAX = 5000;
export const CANDIDATE_EMAIL_SENDER_NAME_MAX = 80;
export const CANDIDATE_EMAIL_REPLY_TO_MAX = 254;
/** Per company, e-mails queued in any hour (5720 counts the same under a per-company lock). */
export const CANDIDATE_EMAIL_HOURLY_CAP = 500;
/** A rejection e-mail is sent now or 1, 2 or 3 days later, as the person chooses. */
export const REJECTION_EMAIL_DELAYS = [0, 1, 2, 3] as const;
export type RejectionEmailDelay = (typeof REJECTION_EMAIL_DELAYS)[number];
export const CANDIDATE_EMAIL_MAX_ATTEMPTS = 5;
export const CANDIDATE_EMAIL_PURGE_DAYS = 90;
/** The application page lists at most this many e-mails (an application gets a receipt and a rejection; retries reuse rows). */
export const CANDIDATE_EMAIL_LIST_LIMIT = 50;

export const CANDIDATE_EMAIL_STATES = ['queued', 'leased', 'sending', 'sent', 'retry', 'failed', 'uncertain'] as const;
export type CandidateEmailState = (typeof CANDIDATE_EMAIL_STATES)[number];
/** What a person sees: queued (waiting, or waiting to try again), sending, sent, failed or uncertain. */
export type CandidateEmailDisplayState = 'queued' | 'sending' | 'sent' | 'failed' | 'uncertain';
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
/** Link-like text, the SAME pattern as 5720's app.recruitment_candidate_email_linkish (a test compares them): a known scheme followed by
 *  ":" and more (http, https, ftp, mailto, tel, sms, data, javascript, vbscript, file), any "://", a "//" at the start or after a space
 *  or punctuation, "www" with any dot (Unicode dots too), punycode, or a bare domain followed by "/" ("evil.example/login").
 *  Case-insensitive. Ordinary names and titles ("S.Kumar", "Node.js Developer", "Ref:HR-12") are not link-like. Templates must not
 *  contain one; an e-mail whose subject or text would, once a candidate's values are filled in, is not sent to that candidate. */
export const LINK_PATTERN = '(^|[^a-z0-9])(https?|ftp|mailto|tel|sms|data|javascript|vbscript|file):\\S|://|(^|[^a-z0-9])//|www[.。．｡]|xn--|[a-z0-9-][.。．｡][a-z]{2,}/';
const LINK = new RegExp(LINK_PATTERN, 'i');
export const linkish = (text: string) => LINK.test(text);
/** The HTML grammar the renderer emits and 5720's body_html CHECK accepts (the same text): its wrapper, paragraphs, line breaks and
 *  five entities only. */
export const HTML_GRAMMAR = '^<!doctype html><html lang="(en|ms|zh|vi|ta|th)"><head><meta charset="utf-8"></head><body>(<p>([^<>&]|<br>|&(amp|lt|gt|quot|#39);)*</p>)*</body></html>$';
const PLACEHOLDER = /\{([^{}]*)\}/g;

/** The placeholders a text names, and whether a brace is left outside a {name} pair. */
export function templatePlaceholders(text: string): { names: string[]; stray: boolean } {
  const names = [...text.matchAll(PLACEHOLDER)].map((m) => m[1]);
  return { names, stray: /[{}]/.test(text.replace(PLACEHOLDER, '')) };
}

export type TemplateRefusal = 'missing_fields' | 'invalid_input' | 'email_placeholder' | 'email_link' | 'email_too_long';
const len = (s: string) => [...s].length;
/** The longest a text can render to: its own characters plus, for each placeholder, its longest value. */
export function worstCaseLength(kind: CandidateEmailKind, text: string): number {
  const allowed = new Set(CANDIDATE_EMAIL_PLACEHOLDERS[kind]);
  let n = len(text.replace(PLACEHOLDER, ''));
  for (const m of text.matchAll(PLACEHOLDER)) n += allowed.has(m[1]) ? CANDIDATE_EMAIL_VALUE_MAX[m[1] as BasePlaceholder] : 0;
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
/** A candidate's recorded e-mail the transport would accept (the same canonical rule, at most 254 as 5720 stores it); anything else
 *  counts as no usable address: the candidate is skipped and the person told. */
export function usableRecipient(email: string | null | undefined): email is string {
  return typeof email === 'string' && email.length <= CANDIDATE_EMAIL_REPLY_TO_MAX && isCanonicalEmailAddress(email);
}
/** Characters the transport refuses in a display name (lib/managed-email-policy.ts validManagedEmailSenderName: control characters
 *  and @ < > ", so a name never looks like another mailbox); the C1 controls are refused here as well. 5720's sender CHECKs use the
 *  same class. */
export const SENDER_NAME_REFUSED = /[\u0001-\u001f\u007f-\u009f@<>"]/;
/** The display name used when the company sets none — the same rule as 5720's app.recruitment_candidate_email_sender (D-064): every
 *  character the transport refuses made a space, runs of spaces made one, leading space removed, cut to 80 characters, trailing space
 *  removed (JavaScript's trim set, which includes the no-break and ideographic spaces the transport's check removes). A company name
 *  with nothing else left gives '': the company must then set its own sender name to switch candidate e-mail on. */
export function defaultSenderName(companyName: string): string {
  return [...companyName.replace(/[\u0001-\u001f\u007f-\u009f@<>"]/g, ' ').replace(/ {2,}/g, ' ').trimStart()]
    .slice(0, CANDIDATE_EMAIL_SENDER_NAME_MAX).join('').trimEnd();
}

export type CandidateEmailSettingsInput = { enabled?: unknown; senderName?: unknown; replyTo?: unknown; locale?: unknown };
export type ValidCandidateEmailSettings = { enabled: boolean; senderName: string | null; replyTo: string | null; locale: CandidateEmailLocale };
/** The company's switch, sender display name (≤80, none of the characters the transport refuses; empty = the company name),
 *  reply-to (required when on) and language. */
export function validateCandidateEmailSettings(input: CandidateEmailSettingsInput):
  { ok: true; value: ValidCandidateEmailSettings } | { ok: false; code: 'missing_fields' | 'invalid_input'; fields: string[] } {
  const enabled = input.enabled === true || input.enabled === 'on' || input.enabled === 'true';
  const senderName = typeof input.senderName === 'string' && input.senderName.trim() ? input.senderName.trim() : null;
  const replyTo = typeof input.replyTo === 'string' && input.replyTo.trim() ? input.replyTo.trim().toLowerCase() : null;
  const locale = input.locale == null || input.locale === '' ? 'en' : input.locale;
  if (enabled && !replyTo) return { ok: false, code: 'missing_fields', fields: ['replyTo'] };
  const fields = [
    ...(senderName && ([...senderName].length > CANDIDATE_EMAIL_SENDER_NAME_MAX || SENDER_NAME_REFUSED.test(senderName)) ? ['senderName'] : []),
    ...(replyTo && !validReplyTo(replyTo) ? ['replyTo'] : []),
    ...((CANDIDATE_EMAIL_LOCALES as readonly unknown[]).includes(locale) ? [] : ['locale']),
  ];
  if (fields.length) return { ok: false, code: 'invalid_input', fields };
  return { ok: true, value: { enabled, senderName, replyTo, locale: locale as CandidateEmailLocale } };
}

/** A rejection delay chosen in the dialog: 0–3 whole days. */
export function parseRejectionDelay(value: unknown): RejectionEmailDelay | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^[0-3]$/.test(value.trim()) ? Number(value.trim()) : NaN;
  return (REJECTION_EMAIL_DELAYS as readonly number[]).includes(n) ? (n as RejectionEmailDelay) : null;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const clip = (name: string, value: string) => [...value].slice(0, CANDIDATE_EMAIL_VALUE_MAX[name as BasePlaceholder] ?? 0).join('');
const fill = (template: string, values: Readonly<Record<string, string>>, allowed: ReadonlySet<string>, wrap: (v: string) => string = (v) => v) =>
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
    + paragraphs.map((p) => `<p>${p.split('\n').map((line) => fill(escapeHtml(line), values, allowed, (v) => escapeHtml(v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')))).join('<br>')}</p>`).join('')
    + '</body></html>';
  return { subject, text, html };
}
