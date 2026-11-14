/**
 * Candidate e-mail (slice 19, D-063, docs/adr/2026-11-14-recruitment-candidate-email.md): the company's sender settings and
 * templates, the composer and previews people see, queueing (receipts HR ticks and rejections, set-based, frozen at queue time), the application
 * page's list and an administrator's retry. Careers-page receipts are not in this slice (D-064: the applicant's address is not
 * verified until slice 21). Reached from outside the pack only through ./service. Delivery is
 * ./candidate-email-delivery (the sweep). db/migrations/5220_recruitment_candidate_email.sql refuses every illegal write again.
 *
 * Nothing is queued unless the installation can send (the embedded relay, AUTH_PROVIDER=internal, has an active relay for the
 * tenant: lib/recruitment-candidate-email-ipc) AND the company's switch is on. Receipts and rejections render through
 * renderCandidateEmail (./candidate-email-model) from the same composer the person previewed; a fingerprint of each application's
 * preview, posted with the form, refuses a send whose wording, sender, recipient or values changed after the preview (email_changed).
 *
 * Who reads the e-mails: the job's reviewers (administrators, recruiter, assistants, hiring managers) — the same people who may
 * reject the application and who already read the candidate's name and the job title, which is all an e-mail states besides the
 * company's wording. Interviewers read none (row security, 5220). Only administrators change settings and templates or retry.
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvents } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import { messagesForLocale } from '../../i18n/catalogs';
import { candidateEmailAvailable } from '../../lib/recruitment-candidate-email-ipc';
import { RecruitmentError, isUuid } from './model';
import {
  CANDIDATE_EMAIL_HOURLY_CAP, CANDIDATE_EMAIL_KINDS, CANDIDATE_EMAIL_LIST_LIMIT, CANDIDATE_EMAIL_LOCALES, CANDIDATE_EMAIL_PLACEHOLDERS,
  candidateEmailDisplayState, candidateEmailRetryable, parseRejectionDelay, renderCandidateEmail, validateCandidateEmailSettings,
  validateCandidateEmailTemplate,
  linkish, usableRecipient,
  type CandidateEmailDisplayState, type CandidateEmailKind, type CandidateEmailLocale, type CandidateEmailSettingsInput, type CandidateEmailState,
  type RenderedCandidateEmail, type ValidTemplate,
} from './candidate-email-model';

const ids = (values: readonly string[]) => {
  if (!values.every(isUuid)) throw new RecruitmentError('invalid_input');
  return `{${values.join(',')}}`;
};
const userOf = (s: SessionContext) => {
  if (!s.userId) throw new RecruitmentError('forbidden');
  return s.userId;
};
const isKind = (v: unknown): v is CandidateEmailKind => typeof v === 'string' && (CANDIDATE_EMAIL_KINDS as readonly string[]).includes(v);
const isLocale = (v: unknown): v is CandidateEmailLocale => typeof v === 'string' && (CANDIDATE_EMAIL_LOCALES as readonly string[]).includes(v);
const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());

async function assertAdminTx(tx: Tx, companyId: unknown): Promise<string> {
  if (!isUuid(companyId)) throw new RecruitmentError('forbidden');
  const [row] = await tx.execute<{ ok: boolean }>(sql`select app.can_admin_recruitment_for(${companyId}::uuid) as ok`);
  if (row?.ok !== true) throw new RecruitmentError('forbidden');
  return companyId;
}

/** The code-owned default wording of a kind in a language (messages/<locale>.json, recruitment.candidateEmail.defaults; a missing
 *  translation falls back to English through the catalogue). Read raw: the {placeholders} are this module's, not ICU arguments. */
export async function candidateEmailDefault(kind: CandidateEmailKind, locale: CandidateEmailLocale): Promise<ValidTemplate> {
  const messages = await messagesForLocale(locale) as unknown as { recruitment: { candidateEmail: { defaults: Record<CandidateEmailKind, ValidTemplate> } } };
  const d = messages.recruitment.candidateEmail.defaults[kind];
  return { subject: d.subject, body: d.body };
}

/** Everything a preview and a queued e-mail of one kind are rendered from, for one company whose candidate e-mail is on. */
export type CandidateEmailComposer = {
  companyId: string; kind: CandidateEmailKind; locale: CandidateEmailLocale; senderName: string; replyTo: string; companyName: string;
  template: ValidTemplate; custom: boolean;
  /** Changes whenever the wording, language or sender changes: posted with a form, it proves the preview is what will be sent. */
  fingerprint: string;
};
const fingerprintOf = (c: Omit<CandidateEmailComposer, 'fingerprint' | 'companyId' | 'custom'>) =>
  createHash('sha256').update(JSON.stringify([c.kind, c.locale, c.template.subject, c.template.body, c.senderName, c.replyTo, c.companyName])).digest('hex').slice(0, 32);

/** The composers of companies whose switch is on, read under the caller's row security (administrators and the company's job teams). */
async function composersTx(tx: Tx, tenantId: string, companyIds: readonly string[], kind: CandidateEmailKind): Promise<Map<string, CandidateEmailComposer>> {
  if (!companyIds.length) return new Map();
  const rows = await tx.execute<{ company_id: string; locale: CandidateEmailLocale; reply_to: string; sender_name: string; company_name: string; subject: string | null; body: string | null }>(sql`
    select s.company_id, s.locale, s.reply_to, app.recruitment_candidate_email_sender(s.sender_name, co.legal_name) as sender_name, co.legal_name as company_name,
      t.subject, t.body
    from recruitment_candidate_email_setting s
    join company co on co.id = s.company_id and co.tenant_id = s.tenant_id
    left join recruitment_candidate_email_template t on t.company_id = s.company_id and t.tenant_id = s.tenant_id and t.kind = ${kind} and t.locale = s.locale
    where s.tenant_id = ${tenantId}::uuid and s.company_id = any(${ids(companyIds)}::uuid[]) and s.enabled and s.reply_to is not null`);
  const out = new Map<string, CandidateEmailComposer>();
  for (const r of rows) {
    const template = r.subject !== null && r.body !== null ? { subject: r.subject, body: r.body } : await candidateEmailDefault(kind, r.locale);
    const base = { kind, locale: r.locale, senderName: r.sender_name, replyTo: r.reply_to, companyName: r.company_name, template };
    out.set(r.company_id, { ...base, companyId: r.company_id, custom: r.subject !== null, fingerprint: fingerprintOf(base) });
  }
  return out;
}

/**
 * The composers a page offers e-mail with (the reject dialog, Suggested to archive, Add application), by company: only companies
 * whose switch is on, and nothing at all while this installation cannot send. A read for the company's administrators and job teams.
 */
export async function candidateEmailComposers(s: SessionContext, companyIds: readonly string[], kind: CandidateEmailKind): Promise<Record<string, CandidateEmailComposer>> {
  const wanted = [...new Set(companyIds)].filter(isUuid);
  if (!wanted.length || !(await candidateEmailAvailable(s.tenantId))) return {};
  return withRecruitmentTenant(s, async (tx) => Object.fromEntries(await composersTx(tx, s.tenantId, wanted, kind)));
}

/** A preview: exactly what renderCandidateEmail freezes for this candidate and job when the e-mail is queued. */
export function previewCandidateEmail(c: CandidateEmailComposer, who: { candidateName: string; jobTitle: string }): RenderedCandidateEmail {
  return renderCandidateEmail(c.kind, c.locale, c.template, { candidateName: who.candidateName, jobTitle: who.jobTitle, companyName: c.companyName, senderName: c.senderName });
}
/** The fingerprint of ONE application's preview: the composer (wording, language, sender), the recipient and the rendered words. Posted
 *  with the form; any change between preview and submit (wording, sender, the candidate's name or address, the job title) refuses. */
const previewFingerprint = (c: CandidateEmailComposer, recipient: string, m: RenderedCandidateEmail) =>
  createHash('sha256').update(JSON.stringify([c.fingerprint, recipient, m.subject, m.text])).digest('hex').slice(0, 32);

/** A database refusal of a queue (5220's checks) as the person's sentence. */
function queueRefusal(e: unknown): never {
  let cur = e as { constraint_name?: unknown; cause?: unknown } | null | undefined;
  for (let i = 0; cur && typeof cur === 'object' && i < 4; i++, cur = cur.cause as typeof cur) {
    if (cur.constraint_name === 'recruitment_candidate_email_hourly_limit') throw new RecruitmentError('email_hourly_limit');
    if (cur.constraint_name === 'recruitment_candidate_email_settings' || cur.constraint_name === 'recruitment_candidate_email_recipient') throw new RecruitmentError('email_changed');
  }
  throw e;
}

type PreviewRow = { id: string; company_id: string; job_id: string; candidate_id: string; full_name: string; email: string | null; destroyed: boolean; title: string };
/** The applications' candidates and jobs, read under the caller's row security in one statement — only those the caller reviews (who
 *  may reject them): an interviewer gets nothing. */
async function previewRowsTx(tx: Tx, tenantId: string, applicationIds: readonly string[], companyId?: string): Promise<PreviewRow[]> {
  if (!applicationIds.length) return [];
  return tx.execute<PreviewRow>(sql`
    select a.id, a.company_id, a.job_id, a.candidate_id, c.full_name, c.email, c.destroyed_at is not null as destroyed, j.title
    from recruitment_application a
    join recruitment_candidate c on c.id = a.candidate_id and c.tenant_id = a.tenant_id
    join recruitment_job_opening j on j.id = a.job_id and j.tenant_id = a.tenant_id
    where a.id = any(${ids(applicationIds)}::uuid[]) and a.tenant_id = ${tenantId}::uuid ${companyId ? sql`and a.company_id = ${companyId}::uuid` : sql``}
      and app.can_review_recruitment_job(a.company_id, a.job_id)`);
}

/** One application's rejection e-mail as the dialog shows it. `blocked` when it cannot be sent: no usable address (the candidate's
 *  recorded e-mail is missing or not one the transport accepts), or the name or job title makes the e-mail link-like. */
export type RejectionEmailPreview = {
  recipient: string | null; blocked: 'no_address' | 'value_link' | null;
  subject: string; text: string; senderName: string; replyTo: string; fingerprint: string;
};
export const REJECTION_PREVIEW_LIMIT = 500;
/**
 * The rejection e-mails the reject dialogs and Suggested to archive offer, by application (at most REJECTION_PREVIEW_LIMIT, read in
 * one statement): only for companies whose candidate e-mail is on, and nothing while this installation cannot send. Read-only.
 */
export async function rejectionEmailPreviews(s: SessionContext, applicationIds: readonly string[]): Promise<Record<string, RejectionEmailPreview>> {
  const wanted = [...new Set(applicationIds)].filter(isUuid).slice(0, REJECTION_PREVIEW_LIMIT);
  if (!wanted.length || !(await candidateEmailAvailable(s.tenantId))) return {};
  return withRecruitmentTenant(s, async (tx) => {
    const rows = await previewRowsTx(tx, s.tenantId, wanted);
    const composers = await composersTx(tx, s.tenantId, [...new Set(rows.map((r) => r.company_id))], 'rejection');
    const out: Record<string, RejectionEmailPreview> = {};
    for (const r of rows) {
      const c = composers.get(r.company_id);
      if (!c || r.destroyed) continue;
      const m = previewCandidateEmail(c, { candidateName: r.full_name, jobTitle: r.title });
      const usable = usableRecipient(r.email);
      out[r.id] = { recipient: usable ? r.email : null, blocked: !usable ? 'no_address' : linkish(m.subject) || linkish(m.text) ? 'value_link' : null,
        subject: m.subject, text: m.text, senderName: c.senderName, replyTo: c.replyTo, fingerprint: usable ? previewFingerprint(c, r.email!, m) : '' };
    }
    return out;
  });
}

export type CandidateEmailQueueResult = {
  /** Applications an e-mail was queued for. Every other application is skipped with its reason, and the person is told: */
  queued: string[];
  /** …the candidate has no usable recorded e-mail (none, or not one the transport accepts) or was removed; */
  noEmail: string[];
  /** …the candidate's name or the job title would make the e-mail link-like; */
  valueLink: string[];
  /** …no preview of this application's rejection e-mail was shown (no fingerprint posted for it). */
  notPreviewed: string[];
};

/**
 * Queue one e-mail of `kind` per application, inside the caller's transaction (after the reject, archive or add it belongs to, so
 * it commits or rolls back with it). The applications are of ONE company and already locked and checked by the caller. Set-based:
 * one read of the applications, candidates and jobs, one INSERT for the set (5220 checks the set once), one event per e-mail.
 * An application that cannot be e-mailed is skipped with its reason (no usable address; a link-like name or job title; for a rejection,
 * no preview shown) while the rest are queued. The whole action is refused only when the installation cannot send
 * (email_unavailable), the company's switch is off (email_off), a POSTED preview fingerprint no longer matches what would be sent
 * (email_changed: the wording, sender, the candidate's details or address changed) or the company would pass 500 queued e-mails in the
 * hour (email_hourly_limit; counted under the same per-company lock as 5220's check, so concurrent queues cannot pass it together).
 * Receipts are queued without a preview (the person ticks "Send receipt"); rejections take `fingerprints` (application id → the
 * fingerprint of the preview shown).
 */
export async function queueCandidateEmailsTx(tx: Tx, s: SessionContext, input: {
  companyId: string; kind: CandidateEmailKind; applicationIds: readonly string[]; delayDays?: number; fingerprints?: ReadonlyMap<string, string>;
}): Promise<CandidateEmailQueueResult> {
  const user = userOf(s);
  const wanted = [...new Set(input.applicationIds)];
  if (!wanted.length) return { queued: [], noEmail: [], valueLink: [], notPreviewed: [] };
  if (!(await candidateEmailAvailable(s.tenantId))) throw new RecruitmentError('email_unavailable');
  const composer = (await composersTx(tx, s.tenantId, [input.companyId], input.kind)).get(input.companyId);
  if (!composer) throw new RecruitmentError('email_off');
  const delay = input.kind === 'rejection' ? input.delayDays ?? 0 : 0;
  if (!Number.isInteger(delay) || delay < 0 || delay > 3) throw new RecruitmentError('invalid_input', ['emailDelay']);
  const rows = await previewRowsTx(tx, s.tenantId, wanted, input.companyId);
  const withAddress = rows.filter((r) => usableRecipient(r.email) && !r.destroyed);
  const noEmail = wanted.filter((id) => !withAddress.some((r) => r.id === id));
  const valueLink: string[] = [], notPreviewed: string[] = [];
  const ready: { row: PreviewRow; mail: RenderedCandidateEmail }[] = [];
  for (const row of withAddress) {
    const mail = previewCandidateEmail(composer, { candidateName: row.full_name, jobTitle: row.title });
    if (linkish(mail.subject) || linkish(mail.text)) { valueLink.push(row.id); continue; }
    if (input.kind === 'rejection') {
      const posted = input.fingerprints?.get(row.id);
      if (posted === undefined) { notPreviewed.push(row.id); continue; }
      if (posted !== previewFingerprint(composer, row.email!, mail)) throw new RecruitmentError('email_changed');
    }
    ready.push({ row, mail });
  }
  if (!ready.length) return { queued: [], noEmail, valueLink, notPreviewed };
  const [count] = await tx.execute<{ n: number }>(sql`select app.recruitment_candidate_email_hour_count(${input.companyId}::uuid) as n`);
  if (Number(count?.n ?? 0) + ready.length > CANDIDATE_EMAIL_HOURLY_CAP) throw new RecruitmentError('email_hourly_limit');
  const set = ready.map(({ row: r, mail: m }) => ({ job_id: r.job_id, application_id: r.id, candidate_id: r.candidate_id, recipient: r.email!,
    subject: m.subject, body_text: m.text, body_html: m.html }));
  const inserted = await tx.execute<{ id: string; application_id: string }>(sql`
    insert into recruitment_candidate_email (tenant_id, company_id, job_id, application_id, candidate_id, kind, locale, recipient, subject, body_text, body_html,
      sender_name, reply_to, queued_by_user_id, next_attempt_at)
    select ${s.tenantId}::uuid, ${input.companyId}::uuid, x.job_id, x.application_id, x.candidate_id, ${input.kind}, ${composer.locale}, x.recipient, x.subject,
      x.body_text, x.body_html, ${composer.senderName}, ${composer.replyTo}, ${user}::uuid, now() + make_interval(days => ${delay}::integer)
    from jsonb_to_recordset(${JSON.stringify(set)}::jsonb) as x(job_id uuid, application_id uuid, candidate_id uuid, recipient text, subject text, body_text text, body_html text)
    returning id, application_id`).catch(queueRefusal);
  await appendEvents(tx, inserted.map((r) => ({
    tenantId: s.tenantId, aggregateType: 'recruitment-application', aggregateId: r.application_id, eventType: 'recruitment-candidate-email.queued',
    actor: actorOf(s), payload: { companyId: input.companyId, emailId: r.id, kind: input.kind, delayDays: delay },
  })));
  return { queued: inserted.map((r) => r.application_id), noEmail, valueLink, notPreviewed };
}

/** The e-mail options a reject or archive form posts: tick, delay and the fingerprint of each preview shown (`fingerprint` for the one
 *  application of a single reject, `fingerprints` by application for a bulk archive). */
export type RejectionEmailChoice = { send?: unknown; delayDays?: unknown; fingerprint?: unknown; fingerprints?: unknown };
export function parseRejectionEmailChoice(choice: RejectionEmailChoice | undefined, applicationId?: string): { delayDays: number; fingerprints: Map<string, string> } | null {
  if (!choice || !(choice.send === true || choice.send === 'on' || choice.send === 'true')) return null;
  const delayDays = parseRejectionDelay(choice.delayDays ?? 0);
  if (delayDays === null) throw new RecruitmentError('invalid_input', ['emailDelay']);
  const fingerprints = new Map<string, string>();
  if (choice.fingerprints && typeof choice.fingerprints === 'object') {
    for (const [k, v] of Object.entries(choice.fingerprints as Record<string, unknown>)) if (isUuid(k) && typeof v === 'string' && v) fingerprints.set(k, v);
  }
  if (applicationId && typeof choice.fingerprint === 'string' && choice.fingerprint) fingerprints.set(applicationId, choice.fingerprint);
  // An application without a posted fingerprint had no preview shown: it is skipped (not previewed), never sent.
  return { delayDays, fingerprints };
}

// ── Settings › Candidate e-mail (administrators) ─────────────────────────────────────────────────────────────────────

export type CandidateEmailTemplateView = { kind: CandidateEmailKind; locale: CandidateEmailLocale; default: ValidTemplate; override: ValidTemplate | null; updatedAt: string | null; updatedBy: string | null };
export type CandidateEmailSettingsView = {
  /** This installation can send (embedded relay with an active relay for the tenant). */
  available: boolean;
  enabled: boolean; senderName: string | null; replyTo: string | null; locale: CandidateEmailLocale;
  /** The display name used when none is set: the company name (≤80). */
  defaultSenderName: string;
  updatedAt: string | null; updatedBy: string | null;
  placeholders: Record<CandidateEmailKind, readonly string[]>;
  templates: CandidateEmailTemplateView[];
  /** E-mails of the last 30 days by what a person sees. */
  counts: Record<CandidateEmailDisplayState, number>;
};

async function labelsTx(tx: Tx, companyId: string, userIds: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(userIds.filter((u): u is string => !!u))];
  if (!wanted.length) return new Map();
  const rows = await tx.execute<{ app_user_id: string; full_name: string }>(sql`
    select l.app_user_id, l.full_name from app.recruitment_people_labels(${companyId}::uuid) l where l.app_user_id = any(${ids(wanted)}::uuid[])`);
  return new Map(rows.map((r) => [r.app_user_id, r.full_name]));
}

export async function candidateEmailSettings(s: SessionContext, companyId: string): Promise<CandidateEmailSettingsView> {
  const available = await candidateEmailAvailable(s.tenantId);
  return withRecruitmentTenant(s, async (tx) => {
    await assertAdminTx(tx, companyId);
    const [st] = await tx.execute<{ enabled: boolean; sender_name: string | null; reply_to: string | null; locale: CandidateEmailLocale; updated_at: string; updated_by_user_id: string }>(sql`
      select enabled, sender_name, reply_to, locale, updated_at, updated_by_user_id from recruitment_candidate_email_setting
      where company_id = ${companyId}::uuid and tenant_id = ${s.tenantId}::uuid`);
    const [co] = await tx.execute<{ name: string }>(sql`select app.recruitment_candidate_email_sender(null, co.legal_name) as name from company co
      where co.id = ${companyId}::uuid and co.tenant_id = ${s.tenantId}::uuid`);
    const overrides = await tx.execute<{ kind: CandidateEmailKind; locale: CandidateEmailLocale; subject: string; body: string; updated_at: string; updated_by_user_id: string }>(sql`
      select kind, locale, subject, body, updated_at, updated_by_user_id from recruitment_candidate_email_template
      where company_id = ${companyId}::uuid and tenant_id = ${s.tenantId}::uuid`);
    // The administrator's own read (row security); one range of the company index (status included). Read-only.
    const counted = await tx.execute<{ status: CandidateEmailState; n: number }>(sql`
      select status, count(*)::int as n from recruitment_candidate_email
      where tenant_id = ${s.tenantId}::uuid and company_id = ${companyId}::uuid and queued_at > now() - interval '30 days' group by status`);
    const labels = await labelsTx(tx, companyId, [st?.updated_by_user_id ?? null, ...overrides.map((o) => o.updated_by_user_id)]);
    const templates: CandidateEmailTemplateView[] = [];
    for (const kind of CANDIDATE_EMAIL_KINDS) {
      for (const locale of CANDIDATE_EMAIL_LOCALES) {
        const o = overrides.find((x) => x.kind === kind && x.locale === locale);
        templates.push({ kind, locale, default: await candidateEmailDefault(kind, locale), override: o ? { subject: o.subject, body: o.body } : null,
          updatedAt: o ? iso(o.updated_at) : null, updatedBy: o ? labels.get(o.updated_by_user_id) ?? null : null });
      }
    }
    const counts: Record<CandidateEmailDisplayState, number> = { queued: 0, sending: 0, sent: 0, failed: 0, uncertain: 0 };
    for (const c of counted) counts[candidateEmailDisplayState(c.status)] += Number(c.n);
    return {
      available, enabled: st?.enabled ?? false, senderName: st?.sender_name ?? null, replyTo: st?.reply_to ?? null, locale: st?.locale ?? 'en',
      defaultSenderName: co?.name ?? '', updatedAt: st ? iso(st.updated_at) : null, updatedBy: st ? labels.get(st.updated_by_user_id) ?? null : null,
      placeholders: CANDIDATE_EMAIL_PLACEHOLDERS, templates, counts,
    };
  });
}

/** Save the switch, sender name, reply-to and language. Switching on needs a reply-to and an installation that can send. */
export async function saveCandidateEmailSettings(s: SessionContext, companyId: unknown, input: CandidateEmailSettingsInput): Promise<void> {
  const user = userOf(s);
  const v = validateCandidateEmailSettings(input);
  if (!v.ok) throw new RecruitmentError(v.code, v.fields);
  if (v.value.enabled && !(await candidateEmailAvailable(s.tenantId))) throw new RecruitmentError('email_unavailable');
  await withRecruitmentTenant(s, async (tx) => {
    const company = await assertAdminTx(tx, companyId);
    await tx.execute(sql`insert into recruitment_candidate_email_setting (company_id, tenant_id, enabled, sender_name, reply_to, locale, created_by_user_id, updated_by_user_id)
      values (${company}::uuid, ${s.tenantId}::uuid, ${v.value.enabled}, ${v.value.senderName}, ${v.value.replyTo}, ${v.value.locale}, ${user}::uuid, ${user}::uuid)
      on conflict (company_id) do update set enabled = excluded.enabled, sender_name = excluded.sender_name, reply_to = excluded.reply_to, locale = excluded.locale,
        updated_by_user_id = excluded.updated_by_user_id`);
    await appendEvents(tx, [{ tenantId: s.tenantId, aggregateType: 'recruitment-company', aggregateId: company, eventType: 'recruitment-candidate-email.settings-saved',
      actor: actorOf(s), payload: { companyId: company, enabled: v.value.enabled, locale: v.value.locale, senderNameSet: v.value.senderName !== null } }]);
  });
}

/** Save a company override of one kind in one language (placeholders from the kind's allowlist only; no links). */
export async function saveCandidateEmailTemplate(s: SessionContext, input: { companyId?: unknown; kind?: unknown; locale?: unknown; subject?: unknown; body?: unknown }): Promise<void> {
  const user = userOf(s);
  if (!isKind(input.kind) || !isLocale(input.locale)) throw new RecruitmentError('invalid_input', ['kind']);
  const kind = input.kind, locale = input.locale;
  const v = validateCandidateEmailTemplate(kind, input);
  if (!v.ok) throw new RecruitmentError(v.code, v.fields);
  await withRecruitmentTenant(s, async (tx) => {
    const company = await assertAdminTx(tx, input.companyId);
    await tx.execute(sql`insert into recruitment_candidate_email_template (tenant_id, company_id, kind, locale, subject, body, created_by_user_id, updated_by_user_id)
      values (${s.tenantId}::uuid, ${company}::uuid, ${kind}, ${locale}, ${v.value.subject}, ${v.value.body}, ${user}::uuid, ${user}::uuid)
      on conflict (company_id, kind, locale) do update set subject = excluded.subject, body = excluded.body, updated_by_user_id = excluded.updated_by_user_id`);
    await appendEvents(tx, [{ tenantId: s.tenantId, aggregateType: 'recruitment-company', aggregateId: company, eventType: 'recruitment-candidate-email.template-saved',
      actor: actorOf(s), payload: { companyId: company, kind, locale } }]);
  });
}

/** Go back to the code-owned default wording for one kind in one language. */
export async function resetCandidateEmailTemplate(s: SessionContext, input: { companyId?: unknown; kind?: unknown; locale?: unknown }): Promise<void> {
  userOf(s);
  if (!isKind(input.kind) || !isLocale(input.locale)) throw new RecruitmentError('invalid_input', ['kind']);
  const kind = input.kind, locale = input.locale;
  await withRecruitmentTenant(s, async (tx) => {
    const company = await assertAdminTx(tx, input.companyId);
    const removed = await tx.execute<{ id: string }>(sql`delete from recruitment_candidate_email_template
      where company_id = ${company}::uuid and tenant_id = ${s.tenantId}::uuid and kind = ${kind} and locale = ${locale} returning id`);
    if (removed.length) await appendEvents(tx, [{ tenantId: s.tenantId, aggregateType: 'recruitment-company', aggregateId: company,
      eventType: 'recruitment-candidate-email.template-reset', actor: actorOf(s), payload: { companyId: company, kind, locale } }]);
  });
}

// ── The application page ─────────────────────────────────────────────────────────────────────────────────────────

export type CandidateEmailRow = {
  id: string; kind: CandidateEmailKind; state: CandidateEmailDisplayState; error: string | null; attempts: number;
  queuedAt: string; queuedBy: string | null; byApplicant: boolean; sendAfter: string; startedAt: string | null; completedAt: string | null;
  retriedAt: string | null; retriedBy: string | null; purged: boolean; retryable: boolean;
  /** The frozen content (null once purged 90 days after its final state). */
  recipient: string | null; subject: string | null; text: string | null;
};
export type ApplicationCandidateEmails = { canRetry: boolean; rows: CandidateEmailRow[] };

/**
 * The application's candidate e-mails, newest first (at most CANDIDATE_EMAIL_LIST_LIMIT), for the job's reviewers. Null for anyone
 * else who may read the application (an interviewer): they read no e-mail. Read-only.
 */
export async function applicationCandidateEmails(s: SessionContext, applicationId: unknown): Promise<ApplicationCandidateEmails | null> {
  if (!isUuid(applicationId)) throw new RecruitmentError('not_found');
  return withRecruitmentTenant(s, async (tx) => {
    const [a] = await tx.execute<{ company_id: string; job_id: string; review: boolean; admin: boolean }>(sql`
      select a.company_id, a.job_id, app.can_review_recruitment_job(a.company_id, a.job_id) as review, app.can_admin_recruitment_for(a.company_id) as admin
      from recruitment_application a where a.id = ${applicationId}::uuid and a.tenant_id = ${s.tenantId}::uuid`);
    if (!a) throw new RecruitmentError('not_found');
    if (!a.review) return null;
    const rows = await tx.execute<{ id: string; kind: CandidateEmailKind; status: CandidateEmailState; error_code: string | null; attempts: number;
      queued_at: string; queued_by_user_id: string | null; next_attempt_at: string; started_at: string | null; completed_at: string | null;
      retried_at: string | null; retried_by_user_id: string | null; content_purged_at: string | null; recipient: string | null; subject: string | null; body_text: string | null }>(sql`
      select id, kind, status, error_code, attempts, queued_at, queued_by_user_id, next_attempt_at, started_at, completed_at, retried_at, retried_by_user_id,
        content_purged_at, recipient, subject, body_text
      from recruitment_candidate_email where application_id = ${applicationId}::uuid and tenant_id = ${s.tenantId}::uuid
      order by queued_at desc, id limit ${CANDIDATE_EMAIL_LIST_LIMIT}`);
    const labels = await labelsTx(tx, a.company_id, rows.flatMap((r) => [r.queued_by_user_id, r.retried_by_user_id]));
    return {
      canRetry: a.admin,
      rows: rows.map((r) => ({
        id: r.id, kind: r.kind, state: candidateEmailDisplayState(r.status), error: r.error_code, attempts: r.attempts,
        queuedAt: iso(r.queued_at)!, queuedBy: r.queued_by_user_id ? labels.get(r.queued_by_user_id) ?? null : null, byApplicant: r.queued_by_user_id === null,
        sendAfter: iso(r.next_attempt_at)!, startedAt: iso(r.started_at), completedAt: iso(r.completed_at), retriedAt: iso(r.retried_at),
        retriedBy: r.retried_by_user_id ? labels.get(r.retried_by_user_id) ?? null : null, purged: r.content_purged_at !== null,
        retryable: a.admin && candidateEmailRetryable(r.status, r.content_purged_at !== null),
        recipient: r.recipient, subject: r.subject, text: r.body_text,
      })),
    };
  });
}

/**
 * An administrator sends a failed or uncertain e-mail again. An uncertain one may already have reached the candidate, and a failed
 * one may have been delivered by a relay that answered badly: the administrator must acknowledge that the candidate may receive it
 * twice (confirm_required otherwise). The frozen content is sent as it was; a purged e-mail cannot be retried.
 */
export async function retryCandidateEmail(s: SessionContext, input: { emailId?: unknown; acknowledged?: unknown }): Promise<void> {
  const user = userOf(s);
  if (!isUuid(input.emailId)) throw new RecruitmentError('not_found');
  if (!(input.acknowledged === true || input.acknowledged === 'on' || input.acknowledged === 'true')) throw new RecruitmentError('confirm_required');
  if (!(await candidateEmailAvailable(s.tenantId))) throw new RecruitmentError('email_unavailable');
  await withRecruitmentTenant(s, async (tx) => {
    // The job's reviewers may read the row; only an administrator may lock and change it (row security admits the lock to them only).
    const [seen] = await tx.execute<{ company_id: string }>(sql`select company_id from recruitment_candidate_email
      where id = ${input.emailId as string}::uuid and tenant_id = ${s.tenantId}::uuid`);
    if (!seen) throw new RecruitmentError('not_found');
    await assertAdminTx(tx, seen.company_id);
    const [e] = await tx.execute<{ id: string; company_id: string; application_id: string; kind: string; status: CandidateEmailState; purged: boolean }>(sql`
      select id, company_id, application_id, kind, status, content_purged_at is not null as purged from recruitment_candidate_email
      where id = ${input.emailId as string}::uuid and tenant_id = ${s.tenantId}::uuid for update`);
    if (!e) throw new RecruitmentError('not_found');
    if (!candidateEmailRetryable(e.status, e.purged)) throw new RecruitmentError('email_not_retryable');
    await tx.execute(sql`update recruitment_candidate_email set status = 'queued', retried_by_user_id = ${user}::uuid where id = ${e.id}::uuid`);
    await appendEvents(tx, [{ tenantId: s.tenantId, aggregateType: 'recruitment-application', aggregateId: e.application_id, eventType: 'recruitment-candidate-email.retried',
      actor: actorOf(s), payload: { companyId: e.company_id, emailId: e.id, kind: e.kind, from: e.status, duplicateAcknowledged: true } }]);
  });
}
