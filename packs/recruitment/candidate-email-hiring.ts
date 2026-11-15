/**
 * Candidate e-mail about interviews and offers (slice 20, D-063, D-065; docs/adr/2026-11-14-recruitment-candidate-email.md): the
 * invitation a person ticks when scheduling an interview (with the reminder that follows it), the cancellation a person ticks when
 * cancelling one, and the offer e-mail a person sends for an Approved offer. Reached from outside the pack only through ./service;
 * ./interviews and ./offers call the *Tx functions inside their own transactions. Delivery is 5720's sweep (./candidate-email-delivery);
 * db/migrations/5721_recruitment_candidate_email_interviews_offers.sql refuses every illegal queue again.
 *
 * What a person previews is what is frozen:
 *   invitation   — the schedule form asks previewInterviewInvitation (a server action, as the person types) for the e-mail of what is
 *                  typed, shows it, and posts the subject and text it showed; the saved interview is rendered with the same function
 *                  (renderInterviewEmail, ./candidate-email-model) and a difference refuses (email_changed): wording, sender, address,
 *                  room or map link changed in between;
 *   cancellation — rendered here per open interview with a fingerprint, posted with the cancel form (as slice 19's rejection);
 *   offer        — rendered here with a fingerprint, posted with "Send offer by e-mail".
 * The reminder is automatic (D-063): rendered and frozen with the invitation, due at the interview's start minus the company's hours,
 * withdrawn by 5721's trigger if the interview is cancelled first.
 *
 * The offer e-mail states only the fields the company marks "In e-mail", each as people entered it (money as its currency and amount;
 * nothing computed). A marked private field the sender cannot see refuses the send (email_private_field) rather than leaving it out.
 * No model is involved; people decide every e-mail but the reminder that follows an invitation they chose to send.
 */
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvents } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import { messagesForLocale } from '../../i18n/catalogs';
import { candidateEmailAvailable } from '../../lib/recruitment-candidate-email-ipc';
import { createHash } from 'node:crypto';
import { appOrigin, configuredPublicOrigin } from '../../lib/real-auth';
import { internalSelected } from '../../lib/internal-auth/config';
import { newCareersToken } from '../../lib/careers-client';
import { RecruitmentError, isUuid } from './model';
import {
  CANDIDATE_EMAIL_HOURLY_CAP, interviewFactsFromForm, linkish, linkishExcept, offerDetailsText, responseLinkValue, reminderDueAt, renderCandidateEmail, renderInterviewEmail, usableRecipient,
  type CandidateEmailKind, type CandidateEmailLocale, type InterviewEmailFacts, type InterviewEmailLabels,
  type InterviewPlaceOption, type OfferEmailLine, type RenderedCandidateEmail,
} from './candidate-email-model';
import { composersTx, ids, previewFingerprint, queueRefusal, userOf, type CandidateEmailComposer } from './candidate-email';
import { validateInterviewInput } from './hiring-model';

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

// ── Slice 21b: response links (5723) ────────────────────────────────────────────────────────────────────────────
/** A preview shows this in place of the candidate's personal token (which exists only once the e-mail is queued); the frozen e-mail
 *  differs from the preview by exactly the token. */
export const PREVIEW_RESPONSE_TOKEN = 'your-personal-link-appears-here-when-sent--';
/** The installation's https origin, or null (no link is then offered). */
function responseOrigin(): string | null {
  // The embedded sign-in's origin, or an explicitly configured AUTH_PUBLIC_ORIGIN; never a legacy fallback.
  const origin = internalSelected() ? appOrigin() : configuredPublicOrigin();
  return origin && /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(origin) ? origin : null;
}
const usesResponseLink = (t: { subject: string; body: string }) => `${t.subject}\n${t.body}`.includes('{responseLink}');
async function responseSentence(locale: CandidateEmailLocale, kind: 'interview' | 'offer'): Promise<string> {
  const m = await messagesForLocale(locale) as unknown as { recruitment: { candidateEmail: { responseLine: Record<'interview' | 'offer', string> } } };
  return m.recruitment.candidateEmail.responseLine[kind];
}
/** The preview's stand-in link, or null when no link would be sent. */
function previewResponseUrl(template: { subject: string; body: string }): string | null {
  const origin = responseOrigin();
  return origin && usesResponseLink(template) ? `${origin}/careers/r/${PREVIEW_RESPONSE_TOKEN}` : null;
}
/** Issue the real link for an interview just scheduled or an offer just sent (5723 checks both), returning its URL; the stand-in URL in
 *  the rendered preview is then replaced by it. */
async function issueResponseLink(tx: Tx, kind: 'interview' | 'offer', targetId: string): Promise<string> {
  const origin = responseOrigin();
  if (!origin) throw new RecruitmentError('email_changed');
  const token = newCareersToken();
  await tx.execute(sql`select app.recruitment_response_link_issue(${kind}, ${targetId}::uuid, ${createHash('sha256').update(token, 'utf8').digest('hex')})`);
  return `${origin}/careers/r/${token}`;
}
const swapLink = (m: RenderedCandidateEmail, from: string, to: string): RenderedCandidateEmail =>
  ({ subject: m.subject.split(from).join(to), text: m.text.split(from).join(to), html: m.html.split(from).join(to) });
/** The words interview values are made of, in an e-mail language (messages recruitment.candidateEmail.interview; read raw — the
 *  {names} are the model's, not ICU arguments). */
export async function interviewEmailLabels(locale: CandidateEmailLocale): Promise<InterviewEmailLabels> {
  const m = await messagesForLocale(locale) as unknown as { recruitment: { candidateEmail: { interview: Omit<InterviewEmailLabels, 'weekdays'> & { weekdays: Record<string, string> } } } };
  const i = m.recruitment.candidateEmail.interview;
  return { round: i.round, types: i.types, weekdays: WEEKDAYS.map((d) => i.weekdays[d]), date: i.date, time: i.time, duration: i.duration, remote: i.remote,
    map: i.map, noPlace: i.noPlace };
}

/** One interview with its application's candidate and job and its place, read under the caller's row security. */
type InterviewRow = {
  id: string; company_id: string; job_id: string; application_id: string; candidate_id: string; round_no: number; interview_type: 'onsite' | 'video' | 'phone';
  starts_at: string | Date; duration_minutes: number; site: string | null; meeting_room: string | null; cancelled: boolean;
  room_name: string | null; address_name: string | null; address_text: string | null; region: string | null; map_url: string | null;
  full_name: string; email: string | null; destroyed: boolean; title: string;
};
async function interviewRowsTx(tx: Tx, tenantId: string, where: { interviewId?: string; applicationId?: string }): Promise<InterviewRow[]> {
  return tx.execute<InterviewRow>(sql`
    select i.id, i.company_id, i.job_id, i.application_id, a.candidate_id, i.round_no, i.interview_type, i.starts_at, i.duration_minutes, i.site, i.meeting_room,
      i.cancelled_at is not null as cancelled, r.name as room_name, ad.name as address_name, ad.address as address_text, ad.region, ad.map_url,
      c.full_name, c.email, c.destroyed_at is not null as destroyed, j.title
    from recruitment_interview i
    join recruitment_application a on a.id = i.application_id and a.tenant_id = i.tenant_id
    join recruitment_candidate c on c.id = a.candidate_id and c.tenant_id = a.tenant_id
    join recruitment_job_opening j on j.id = a.job_id and j.tenant_id = a.tenant_id
    left join recruitment_interview_address ad on ad.id = i.address_id and ad.tenant_id = i.tenant_id and i.interview_type = 'onsite'
    left join recruitment_interview_room r on r.id = i.room_id and r.tenant_id = i.tenant_id and i.interview_type = 'onsite'
    where i.tenant_id = ${tenantId}::uuid
      ${where.interviewId ? sql`and i.id = ${where.interviewId}::uuid` : sql``}
      ${where.applicationId ? sql`and i.application_id = ${where.applicationId}::uuid` : sql``}
      and app.can_operate_recruitment_job(i.company_id, i.job_id)
    order by i.starts_at, i.id`);
}
const factsOf = (r: InterviewRow): InterviewEmailFacts => ({
  roundNo: Number(r.round_no), type: r.interview_type, startsAt: new Date(r.starts_at), durationMinutes: Number(r.duration_minutes),
  room: r.room_name ?? r.meeting_room,
  address: r.address_name ? { name: r.address_name, address: r.address_text ?? '', region: r.region ?? '', mapUrl: r.map_url } : null,
  site: r.site, meetingRoom: r.meeting_room,
});
const baseOf = (c: CandidateEmailComposer, r: { full_name: string; title: string }) =>
  ({ candidateName: r.full_name, jobTitle: r.title, companyName: c.companyName, senderName: c.senderName });

/** Insert a set of e-mails of ONE company in one statement (5721 checks the set once) after the per-company hourly cap, and write one
 *  event per e-mail. Each row is fully rendered; nothing here decides content. */
type Row = {
  kind: CandidateEmailKind; job_id: string; application_id: string; candidate_id: string; recipient: string; mail: RenderedCandidateEmail;
  interview_id?: string | null; interview_starts_at?: string | null; offer_id?: string | null; map_url?: string | null; next_attempt_at?: string | null;
  response_url?: string | null;
};
async function insertEmailsTx(tx: Tx, s: SessionContext, companyId: string, composers: ReadonlyMap<CandidateEmailKind, CandidateEmailComposer>, rows: readonly Row[]): Promise<string[]> {
  if (!rows.length) return [];
  const user = userOf(s);
  const [count] = await tx.execute<{ n: number }>(sql`select app.recruitment_candidate_email_hour_count(${companyId}::uuid) as n`);
  if (Number(count?.n ?? 0) + rows.length > CANDIDATE_EMAIL_HOURLY_CAP) throw new RecruitmentError('email_hourly_limit');
  const set = rows.map((r) => {
    const c = composers.get(r.kind)!;
    return { kind: r.kind, locale: c.locale, sender_name: c.senderName, reply_to: c.replyTo, job_id: r.job_id, application_id: r.application_id,
      candidate_id: r.candidate_id, recipient: r.recipient, subject: r.mail.subject, body_text: r.mail.text, body_html: r.mail.html,
      interview_id: r.interview_id ?? null, interview_starts_at: r.interview_starts_at ?? null, offer_id: r.offer_id ?? null, map_url: r.map_url ?? null,
      next_attempt_at: r.next_attempt_at ?? null, response_url: r.response_url ?? null };
  });
  const inserted = await tx.execute<{ id: string; application_id: string; kind: string }>(sql`
    insert into recruitment_candidate_email (tenant_id, company_id, job_id, application_id, candidate_id, kind, locale, recipient, subject, body_text, body_html,
      sender_name, reply_to, queued_by_user_id, next_attempt_at, interview_id, interview_starts_at, offer_id, map_url, response_url)
    select ${s.tenantId}::uuid, ${companyId}::uuid, x.job_id, x.application_id, x.candidate_id, x.kind, x.locale, x.recipient, x.subject, x.body_text, x.body_html,
      x.sender_name, x.reply_to, ${user}::uuid, coalesce(x.next_attempt_at, now()), x.interview_id, x.interview_starts_at, x.offer_id, x.map_url, x.response_url
    from jsonb_to_recordset(${JSON.stringify(set)}::jsonb) as x(kind text, locale text, sender_name text, reply_to text, job_id uuid, application_id uuid,
      candidate_id uuid, recipient text, subject text, body_text text, body_html text, interview_id uuid, interview_starts_at timestamptz, offer_id uuid,
      map_url text, next_attempt_at timestamptz, response_url text)
    returning id, application_id, kind`).catch(queueRefusal);
  await appendEvents(tx, inserted.map((r) => ({
    tenantId: s.tenantId, aggregateType: 'recruitment-application', aggregateId: r.application_id, eventType: 'recruitment-candidate-email.queued',
    actor: actorOf(s), payload: { companyId, emailId: r.id, kind: r.kind },
  })));
  return inserted.map((r) => r.id);
}

async function composerOf(tx: Tx, s: SessionContext, companyId: string, kind: CandidateEmailKind): Promise<CandidateEmailComposer | null> {
  return (await composersTx(tx, s.tenantId, [companyId], kind)).get(companyId) ?? null;
}

// ── Invitations and reminders ───────────────────────────────────────────────────────────────────────────────────────

/** What the schedule form offers about the invitation before anything is typed: the candidate's usable address (null: the tick is
 *  offered disabled), the sender line, and the reminder that would follow (hours, or null when the company's reminders are off). */
export type InvitationOffer = { recipient: string | null; senderName: string; replyTo: string; reminderHours: number | null };
type ApplicationForEmail = { company_id: string; job_id: string; full_name: string; email: string | null; destroyed: boolean; title: string; operate: boolean };
async function applicationForEmailTx(tx: Tx, s: SessionContext, applicationId: string): Promise<ApplicationForEmail | null> {
  const [a] = await tx.execute<ApplicationForEmail>(sql`
    select a.company_id, a.job_id, c.full_name, c.email, c.destroyed_at is not null as destroyed, j.title,
      app.can_operate_recruitment_job(a.company_id, a.job_id) as operate
    from recruitment_application a
    join recruitment_candidate c on c.id = a.candidate_id and c.tenant_id = a.tenant_id
    join recruitment_job_opening j on j.id = a.job_id and j.tenant_id = a.tenant_id
    where a.id = ${applicationId}::uuid and a.tenant_id = ${s.tenantId}::uuid`);
  return a ?? null;
}
/** Null while this installation cannot send, the company's candidate e-mail is off, or the candidate was removed. The job's operators
 *  only (they schedule). Read-only. */
export async function invitationOffer(s: SessionContext, applicationId: unknown): Promise<InvitationOffer | null> {
  if (!isUuid(applicationId) || !(await candidateEmailAvailable(s.tenantId))) return null;
  return withRecruitmentTenant(s, async (tx) => {
    const a = await applicationForEmailTx(tx, s, applicationId);
    if (!a?.operate || a.destroyed) return null;
    const c = await composerOf(tx, s, a.company_id, 'interview_invitation');
    if (!c) return null;
    return { recipient: usableRecipient(a.email) ? a.email : null, senderName: c.senderName, replyTo: c.replyTo, reminderHours: c.reminderEnabled ? c.reminderHours : null };
  });
}

export type InvitationPreview = { status: 'ready'; subject: string; text: string; blocked: 'no_address' | 'value_link' | null } | { status: 'incomplete' } | { status: 'unavailable' };
/**
 * The invitation the schedule form would send for what is typed so far (round, type, date and time, duration, address, room, site,
 * meeting room), rendered with the same function and the same stored wording, sender, address and room as the e-mail frozen when the
 * interview is saved — the form shows it and posts its subject and text, and a difference at save refuses (email_changed). `incomplete`
 * until a valid date and time are typed; `unavailable` when no invitation can be offered. The job's operators only. Read-only.
 */
export async function previewInterviewInvitation(s: SessionContext, input: { applicationId?: unknown; roundNo?: unknown; type?: unknown; startsAt?: unknown;
  durationMinutes?: unknown; addressId?: unknown; roomId?: unknown; site?: unknown; meetingRoom?: unknown }): Promise<InvitationPreview> {
  if (!isUuid(input.applicationId) || !(await candidateEmailAvailable(s.tenantId))) return { status: 'unavailable' };
  const v = validateInterviewInput({ ...input, interviewerIds: [ZERO_UUID] });
  if (!v.ok) return { status: 'incomplete' };
  const applicationId = input.applicationId;
  return withRecruitmentTenant(s, async (tx) => {
    const a = await applicationForEmailTx(tx, s, applicationId);
    if (!a?.operate || a.destroyed) return { status: 'unavailable' };
    const c = await composerOf(tx, s, a.company_id, 'interview_invitation');
    if (!c) return { status: 'unavailable' };
    const wanted = [v.value.addressId, v.value.roomId].filter((x): x is string => !!x);
    const places = wanted.length ? await placesTx(tx, s, a.company_id, wanted) : [];
    const facts = interviewFactsFromForm(v.value, places);
    const { mail, valueLink } = renderInterviewEmail('interview_invitation', c.locale, c.template, baseOf(c, a), facts, await interviewEmailLabels(c.locale),
      { sentence: await responseSentence(c.locale, 'interview'), url: previewResponseUrl(c.template) });
    return { status: 'ready', subject: mail.subject, text: mail.text, blocked: !usableRecipient(a.email) ? 'no_address' : valueLink ? 'value_link' : null };
  });
}
const ZERO_UUID = '00000000-0000-4000-8000-000000000000';
/** The company's addresses named by id or by one of their rooms, with their enabled rooms (what scheduling may name). */
async function placesTx(tx: Tx, s: SessionContext, companyId: string, wanted: readonly string[]): Promise<InterviewPlaceOption[]> {
  const rows = await tx.execute<{ id: string; name: string; address: string; region: string; map_url: string | null; rooms: { id: string; name: string }[] | null }>(sql`
    select ad.id, ad.name, ad.address, ad.region, ad.map_url,
      (select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name) order by r.name) from recruitment_interview_room r
        where r.address_id = ad.id and r.tenant_id = ad.tenant_id and r.enabled) as rooms
    from recruitment_interview_address ad
    where ad.company_id = ${companyId}::uuid and ad.tenant_id = ${s.tenantId}::uuid
      and (ad.id = any(${ids(wanted)}::uuid[]) or exists (select 1 from recruitment_interview_room r where r.address_id = ad.id and r.id = any(${ids(wanted)}::uuid[])))`);
  return rows.map((p) => ({ id: p.id, name: p.name, address: p.address, region: p.region, mapUrl: p.map_url, rooms: p.rooms ?? [] }));
}

export type InterviewEmailOutcome = 'queued' | 'no_email' | 'value_link';
/**
 * Queue the invitation for an interview the caller has JUST scheduled in this transaction, and the reminder that follows it when the
 * company's reminders are on and the reminder time is still ahead. `posted` is the subject and text the form showed: a difference from
 * what the saved interview renders to refuses the whole scheduling (email_changed). A candidate without a usable address, or a value
 * that would make the e-mail link-like, queues nothing and schedules anyway (the person is told). Refused outright: the installation
 * cannot send (email_unavailable), candidate e-mail is off (email_off), the hourly cap (email_hourly_limit).
 */
export async function queueInterviewInvitationTx(tx: Tx, s: SessionContext, interviewId: string, posted: { subject: string; text: string }): Promise<InterviewEmailOutcome> {
  if (!(await candidateEmailAvailable(s.tenantId))) throw new RecruitmentError('email_unavailable');
  const [row] = await interviewRowsTx(tx, s.tenantId, { interviewId });
  if (!row) throw new RecruitmentError('not_found');
  const invitation = await composerOf(tx, s, row.company_id, 'interview_invitation');
  if (!invitation) throw new RecruitmentError('email_off');
  if (row.destroyed || !usableRecipient(row.email)) return 'no_email';
  const facts = factsOf(row);
  const stand = previewResponseUrl(invitation.template);
  const inv = renderInterviewEmail('interview_invitation', invitation.locale, invitation.template, baseOf(invitation, row), facts, await interviewEmailLabels(invitation.locale),
    { sentence: await responseSentence(invitation.locale, 'interview'), url: stand });
  if (inv.valueLink) return 'value_link';
  if (posted.subject !== inv.mail.subject || posted.text !== inv.mail.text) throw new RecruitmentError('email_changed');
  // Slice 21b: the candidate's own link replaces the preview's stand-in (5723 confirms it was issued for this interview now).
  const responseUrl = stand ? await issueResponseLink(tx, 'interview', row.id) : null;
  if (stand && responseUrl) inv.mail = swapLink(inv.mail, stand, responseUrl);
  const startsAt = facts.startsAt.toISOString();
  const rows: Row[] = [{ kind: 'interview_invitation', job_id: row.job_id, application_id: row.application_id, candidate_id: row.candidate_id, recipient: row.email!,
    mail: inv.mail, interview_id: row.id, interview_starts_at: startsAt, map_url: inv.mapUrl, response_url: responseUrl }];
  const composers = new Map<CandidateEmailKind, CandidateEmailComposer>([['interview_invitation', invitation]]);
  const due = invitation.reminderEnabled ? reminderDueAt(facts.startsAt, invitation.reminderHours, new Date()) : null;
  if (due) {
    const reminder = await composerOf(tx, s, row.company_id, 'interview_reminder');
    const rem = reminder && renderInterviewEmail('interview_reminder', reminder.locale, reminder.template, baseOf(reminder, row), facts, await interviewEmailLabels(reminder.locale));
    // A reminder whose own wording would be link-like is not queued; the invitation still is.
    if (reminder && rem && !rem.valueLink) {
      composers.set('interview_reminder', reminder);
      rows.push({ kind: 'interview_reminder', job_id: row.job_id, application_id: row.application_id, candidate_id: row.candidate_id, recipient: row.email!,
        mail: rem.mail, interview_id: row.id, interview_starts_at: startsAt, map_url: rem.mapUrl, next_attempt_at: due.toISOString() });
    }
  }
  await insertEmailsTx(tx, s, row.company_id, composers, rows);
  return 'queued';
}

// ── Cancellations ───────────────────────────────────────────────────────────────────────────────────────────────────

export type CancellationEmailPreview = { recipient: string | null; blocked: 'no_address' | 'value_link' | null; subject: string; text: string; fingerprint: string };
/** The cancellation e-mail each OPEN interview of an application would send, by interview — for the job's operators (who cancel), only
 *  while the company's candidate e-mail is on and this installation can send. Read-only. */
export async function interviewCancellationPreviews(s: SessionContext, applicationId: unknown): Promise<Record<string, CancellationEmailPreview>> {
  if (!isUuid(applicationId) || !(await candidateEmailAvailable(s.tenantId))) return {};
  return withRecruitmentTenant(s, async (tx) => {
    const rows = (await interviewRowsTx(tx, s.tenantId, { applicationId })).filter((r) => !r.cancelled && !r.destroyed);
    if (!rows.length) return {};
    const c = await composerOf(tx, s, rows[0].company_id, 'interview_cancelled');
    if (!c) return {};
    const labels = await interviewEmailLabels(c.locale);
    const out: Record<string, CancellationEmailPreview> = {};
    for (const r of rows) {
      const { mail, valueLink } = renderInterviewEmail('interview_cancelled', c.locale, c.template, baseOf(c, r), factsOf(r), labels);
      const usable = usableRecipient(r.email);
      out[r.id] = { recipient: usable ? r.email : null, blocked: !usable ? 'no_address' : valueLink ? 'value_link' : null, subject: mail.subject, text: mail.text,
        fingerprint: usable ? previewFingerprint(c, r.email!, mail) : '' };
    }
    return out;
  });
}

/** Queue the cancellation e-mail of an interview the caller has JUST cancelled in this transaction, after the preview whose fingerprint
 *  the form posted (a difference refuses: email_changed). No usable address or a link-like value queues nothing (the person is told). */
export async function queueInterviewCancellationTx(tx: Tx, s: SessionContext, interviewId: string, fingerprint: string): Promise<InterviewEmailOutcome> {
  if (!(await candidateEmailAvailable(s.tenantId))) throw new RecruitmentError('email_unavailable');
  const [row] = await interviewRowsTx(tx, s.tenantId, { interviewId });
  if (!row) throw new RecruitmentError('not_found');
  const c = await composerOf(tx, s, row.company_id, 'interview_cancelled');
  if (!c) throw new RecruitmentError('email_off');
  if (row.destroyed || !usableRecipient(row.email)) return 'no_email';
  const { mail, valueLink } = renderInterviewEmail('interview_cancelled', c.locale, c.template, baseOf(c, row), factsOf(row), await interviewEmailLabels(c.locale));
  if (valueLink) return 'value_link';
  if (fingerprint !== previewFingerprint(c, row.email!, mail)) throw new RecruitmentError('email_changed');
  await insertEmailsTx(tx, s, row.company_id, new Map([['interview_cancelled', c]]), [{ kind: 'interview_cancelled', job_id: row.job_id,
    application_id: row.application_id, candidate_id: row.candidate_id, recipient: row.email!, mail, interview_id: row.id,
    interview_starts_at: new Date(row.starts_at).toISOString(), map_url: null }]);
  return 'queued';
}

// ── Offers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type OfferEmailBlock = 'no_address' | 'value_link' | 'private_hidden' | 'too_long';
export type OfferEmailPreview = {
  offerId: string; recipient: string | null; blocked: OfferEmailBlock | null; subject: string; text: string; senderName: string; replyTo: string;
  fingerprint: string; fieldsInEmail: number;
  /** The rendered HTML (what is frozen with the text; the page shows the text). */
  html: string;
  /** Slice 21b: the stand-in link the preview shows (the frozen e-mail carries the candidate's own), or null without a link. */
  previewResponseUrl: string | null;
};
/**
 * The offer e-mail of an application's offer as "Send offer by e-mail" shows it, read inside `tx` under the caller's row security: only
 * for an Approved, unsent offer with no candidate decision, for the job's operators, while candidate e-mail is on (null otherwise). The
 * details are the enabled fields marked "In e-mail", in the company's order, each with the value people entered (a marked field with no
 * value is left out); a marked PRIVATE field the caller cannot see blocks the send.
 */
export async function offerEmailPreviewTx(tx: Tx, s: SessionContext, applicationId: string): Promise<OfferEmailPreview | null> {
  const [o] = await tx.execute<{ id: string; company_id: string; job_id: string; status: string; sent: boolean; decision: string; operate: boolean;
    full_name: string; email: string | null; destroyed: boolean; title: string; sees_private: boolean }>(sql`
    select o.id, o.company_id, o.job_id, o.status, o.sent_at is not null as sent, o.candidate_decision as decision,
      app.can_operate_recruitment_job(o.company_id, o.job_id) as operate, c.full_name, c.email, c.destroyed_at is not null as destroyed, j.title,
      -- The 5703 private-value predicate (as ./offers seesPrivateTx).
      (app.can_admin_recruitment_for(o.company_id) or app.recruitment_has_job_role(o.job_id, array['recruiter']) or o.created_by_user_id = app.current_user_id()) as sees_private
    from recruitment_offer o
    join recruitment_application a on a.id = o.application_id and a.tenant_id = o.tenant_id
    join recruitment_candidate c on c.id = a.candidate_id and c.tenant_id = a.tenant_id
    join recruitment_job_opening j on j.id = a.job_id and j.tenant_id = a.tenant_id
    where o.application_id = ${applicationId}::uuid and o.tenant_id = ${s.tenantId}::uuid`);
  if (!o || !o.operate || o.status !== 'approved' || o.sent || o.decision !== 'pending' || o.destroyed) return null;
  const c = await composerOf(tx, s, o.company_id, 'offer');
  if (!c) return null;
  const fields = await tx.execute<{ id: string; label: string; private: boolean; has_value: boolean; value: string | null }>(sql`
    select f.id, f.label, f.private, v.id is not null as has_value,
      case when v.value_amount is not null then v.currency || ' ' || v.value_amount::text
        when v.value_number is not null then v.value_number::text
        when v.value_date is not null then to_char(v.value_date, 'YYYY-MM-DD')
        else v.value_text end as value
    from recruitment_offer_field f
    left join recruitment_offer_value v on v.field_id = f.id and v.offer_id = ${o.id}::uuid and v.tenant_id = f.tenant_id
    where f.company_id = ${o.company_id}::uuid and f.tenant_id = ${s.tenantId}::uuid and f.enabled and f.include_in_email
    order by f.position, f.label`);
  const lines: OfferEmailLine[] = fields.filter((f) => f.has_value && f.value !== null).map((f) => ({ label: f.label, value: f.value! }));
  const hidden = !o.sees_private && fields.some((f) => f.private);
  const details = offerDetailsText(lines);
  const stand = previewResponseUrl(c.template);
  const responseLink = responseLinkValue(await responseSentence(c.locale, 'offer'), stand);
  const mail = renderCandidateEmail('offer', c.locale, c.template, { ...baseOf(c, o), offerDetails: details ?? '', responseLink });
  const usable = usableRecipient(o.email);
  const blocked: OfferEmailBlock | null = !usable ? 'no_address' : hidden ? 'private_hidden' : details === null ? 'too_long'
    : linkish(mail.subject) || linkishExcept(mail.text, null, stand) ? 'value_link' : null;
  return { offerId: o.id, recipient: usable ? o.email : null, blocked, subject: mail.subject, text: mail.text, html: mail.html, senderName: c.senderName,
    replyTo: c.replyTo, fingerprint: usable && !blocked ? previewFingerprint(c, o.email!, mail) : '', fieldsInEmail: fields.length, previewResponseUrl: stand };
}
export async function offerEmailPreview(s: SessionContext, applicationId: unknown): Promise<OfferEmailPreview | null> {
  if (!isUuid(applicationId) || !(await candidateEmailAvailable(s.tenantId))) return null;
  return withRecruitmentTenant(s, (tx) => offerEmailPreviewTx(tx, s, applicationId));
}

const BLOCK_ERROR = { no_address: 'email_no_address', value_link: 'email_value_link', private_hidden: 'email_private_field', too_long: 'email_too_long' } as const;
/**
 * Queue the offer e-mail inside the transaction that has JUST recorded the offer as sent by e-mail (./offers sendOfferByEmail): the
 * preview is rendered again from what the caller may read now and must have the fingerprint the form posted (email_changed otherwise);
 * a blocked e-mail refuses the whole send with its reason.
 */
export async function queueOfferEmailTx(tx: Tx, s: SessionContext, offer: { id: string; applicationId: string; companyId: string; jobId: string; candidateId: string },
  preview: OfferEmailPreview, fingerprint: string): Promise<void> {
  if (preview.blocked) throw new RecruitmentError(BLOCK_ERROR[preview.blocked]);
  if (!fingerprint || fingerprint !== preview.fingerprint) throw new RecruitmentError('email_changed');
  const c = await composerOf(tx, s, offer.companyId, 'offer');
  if (!c) throw new RecruitmentError('email_off');
  // Slice 21b: the candidate's own link replaces the preview's stand-in (5723 confirms it was issued for this offer's send now).
  const responseUrl = preview.previewResponseUrl ? await issueResponseLink(tx, 'offer', offer.id) : null;
  const mail = preview.previewResponseUrl && responseUrl ? swapLink(preview, preview.previewResponseUrl, responseUrl) : { subject: preview.subject, text: preview.text, html: preview.html };
  await insertEmailsTx(tx, s, offer.companyId, new Map([['offer', c]]), [{ kind: 'offer', job_id: offer.jobId, application_id: offer.applicationId,
    candidate_id: offer.candidateId, recipient: preview.recipient!, mail, offer_id: offer.id, response_url: responseUrl }]);
}
