/**
 * Recruitment slice 19 — the pure candidate e-mail rules (packs/recruitment/candidate-email-model.ts), the code-owned default wording in
 * the six messages files, the transport's per-message display name and reply-to (lib/internal-auth/smtp.ts, nodemailer faked), and the
 * 5720 restatements of the candidate removal and company delete (byte for byte plus added steps). No database. Fictional values only.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const smtp = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn(), close: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: smtp.create } }));
// The internal-auth sender reads the tenant's relay and the installation origin: faked (no database, no environment).
vi.mock('../lib/internal-auth/store', () => ({ admittedAuthSql: {} }));
vi.mock('../lib/internal-auth/active-relay', () => ({ readLifecycleRelayTx: async () => ({ revision: 'rev-fixture-1', relay: { config: {} } }) }));
vi.mock('../lib/internal-auth/config', () => ({ internalConfig: () => ({ origin: 'https://hr.example.test' }), internalSelected: () => true }));
import { sendSmtp, type Mail, type Relay } from '../lib/internal-auth/smtp';
import { internalCandidateEmailSender } from '../lib/internal-auth/recruitment-candidate-mail';
import { CandidateMailNotSent, type CandidateMail } from '../lib/recruitment-candidate-email-ipc';
import { EmailSettingsError } from '../lib/identity/email-model';
import {
  BASE_PLACEHOLDERS, CANDIDATE_EMAIL_FROZEN_HTML_MAX, CANDIDATE_EMAIL_FROZEN_SUBJECT_MAX, CANDIDATE_EMAIL_FROZEN_TEXT_MAX, CANDIDATE_EMAIL_VALUE_MAX, HTML_GRAMMAR,
  LINK_PATTERN, SENDER_NAME_REFUSED, defaultSenderName, linkish, usableRecipient, worstCaseLength, CANDIDATE_EMAIL_HOURLY_CAP, CANDIDATE_EMAIL_KINDS, CANDIDATE_EMAIL_LOCALES, CANDIDATE_EMAIL_PLACEHOLDERS, candidateEmailBackoffSeconds,
  candidateEmailDisplayState, candidateEmailRetryable, parseRejectionDelay, renderCandidateEmail, templatePlaceholders, validReplyTo,
  validateCandidateEmailSettings, validateCandidateEmailTemplate,
} from '../packs/recruitment/candidate-email-model';
import { RECRUITMENT_ERROR_CODES } from '../packs/recruitment/model';
import { validManagedEmailSenderName } from '../lib/managed-email-policy';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const messages = (locale: string) => JSON.parse(read(`messages/${locale}.json`)) as { recruitment: Record<string, any> };
const values = { candidateName: 'Fictional QZE Applicant', jobTitle: 'QZE Fictional analyst', companyName: 'Fictional QZE Sdn Bhd', senderName: 'QZE Talent team' };

describe('templates: placeholders, limits and links', () => {
  it('accepts plain text with the kind\'s placeholders and normalises line endings', () => {
    const v = validateCandidateEmailTemplate('rejection', { subject: '  About {jobTitle}  ', body: 'Dear {candidateName},\r\n\r\nFrom {senderName} at {companyName}.\r\n' });
    expect(v).toEqual({ ok: true, value: { subject: 'About {jobTitle}', body: 'Dear {candidateName},\n\nFrom {senderName} at {companyName}.' } });
  });
  it.each([
    ['an unknown placeholder', { subject: 'Offer {salary}', body: 'x' }, 'email_placeholder', ['subject']],
    ['a misspelt placeholder', { subject: 's', body: 'Dear {candidatename}' }, 'email_placeholder', ['body']],
    ['a stray brace', { subject: 's', body: 'Dear {candidateName' }, 'email_placeholder', ['body']],
    ['an empty pair', { subject: '{}', body: 'x' }, 'email_placeholder', ['subject']],
    ['a link', { subject: 's', body: 'See https://fictional.example.test' }, 'email_link', ['body']],
    ['a www link', { subject: 'www.fictional.example.test', body: 'x' }, 'email_link', ['subject']],
    ['a missing subject', { subject: '  ', body: 'x' }, 'missing_fields', ['subject']],
    ['a missing body', { subject: 's', body: '\n\n' }, 'missing_fields', ['body']],
    ['a long subject', { subject: 'x'.repeat(201), body: 'x' }, 'invalid_input', ['subject']],
    ['a long body', { subject: 's', body: 'x'.repeat(5001) }, 'invalid_input', ['body']],
    ['a control character in the subject', { subject: 'a\tb', body: 'x' }, 'invalid_input', ['subject']],
    ['a control character in the body', { subject: 's', body: 'a\u0007b' }, 'invalid_input', ['body']],
  ])('refuses %s', (_n, input, code, fields) => {
    expect(validateCandidateEmailTemplate('application_received', input)).toEqual({ ok: false, code, fields });
  });
  it.each([
    'See evil.example/login', 'mailto:someone', 'MAILTO:someone', 'ftp:files', 'tel:+60123456789', 'sms:+601', 'data:text/html,x', 'javascript:alert(1)',
    'vbscript:x', 'file:x', 'https://fictional.example.test', 'x://y', '//host.example', 'see //host', '(//host)', 'www.example', 'www。example', 'WWW．EXAMPLE',
    'www｡example', 'xn--80ak6aa92e', 'go to a．example/x', 'evil。example/x', 'Apply: hr.example/jobs',
  ])('treats %j as link-like (TS; SQL uses the same pattern)', (text) => {
    expect(linkish(text)).toBe(true);
    expect(validateCandidateEmailTemplate('rejection', { subject: 's', body: text })).toMatchObject({ ok: false, code: 'email_link' });
  });
  it.each([
    'S.Kumar', 'Mohd.Ali', 'Dr.Tan Wei', 'Node.js Developer', 'ASP.NET Engineer', 'M.Sc Researcher', 'Fictional Sdn.Bhd.', 'Position:Analyst', 'Ref:HR-12',
    'Job:{jobTitle}', 'Re: {jobTitle}', 'Dear {candidateName},', 'At 10:30, e.g. today.', 'Kind regards,\n{senderName}', 'Fictional Sdn. Bhd.', '编号：123',
    'Hotel:Grand', 'Metadata:none', 'reply to talent@example.test', 'Visit FICTIONAL.EXAMPLE today', 'and/or', 'A/B testing', 'C++ / C# Developer',
  ])('does not treat %j as link-like', (text) => expect(linkish(text)).toBe(false));
  it('refuses a template whose longest possible rendering would not fit what is stored', () => {
    const subject = '{candidateName}'.repeat(5) + 'x';
    expect(worstCaseLength('rejection', subject)).toBe(5 * CANDIDATE_EMAIL_VALUE_MAX.candidateName + 1);
    expect(validateCandidateEmailTemplate('rejection', { subject, body: 'x' })).toEqual({ ok: false, code: 'email_too_long', fields: ['subject'] });
    expect(validateCandidateEmailTemplate('rejection', { subject: '{candidateName}'.repeat(4), body: 'x' }).ok).toBe(true);
    const body = '{jobTitle}'.repeat(101);
    expect(validateCandidateEmailTemplate('rejection', { subject: 's', body })).toEqual({ ok: false, code: 'email_too_long', fields: ['body'] });
    // The largest accepted template with the longest, most-escaped values still fits every frozen column.
    const accepted = ('{companyName}' + '\n').repeat(97) + '"'.repeat(200);
    expect(validateCandidateEmailTemplate('rejection', { subject: '{candidateName}'.repeat(4) + '<'.repeat(130), body: accepted }).ok).toBe(true);
    const worst = { candidateName: '&'.repeat(300), jobTitle: '"'.repeat(300), companyName: "'".repeat(300), senderName: '<'.repeat(80) };
    const m = renderCandidateEmail('rejection', 'en', { subject: '{candidateName}'.repeat(4) + '<'.repeat(130), body: accepted }, worst);
    expect([...m.subject].length).toBeLessThanOrEqual(CANDIDATE_EMAIL_FROZEN_SUBJECT_MAX);
    expect([...m.text].length).toBeLessThanOrEqual(CANDIDATE_EMAIL_FROZEN_TEXT_MAX);
    expect(m.html.length).toBeLessThanOrEqual(CANDIDATE_EMAIL_FROZEN_HTML_MAX);
    expect(new RegExp(HTML_GRAMMAR).test(m.html)).toBe(true);
    // Values are cut to their maxima (the company name has no stored limit).
    expect(m.text.startsWith("'".repeat(200) + '\n')).toBe(true);
  });
  it('counts characters, not UTF-16 units, against the limits', () => {
    expect(validateCandidateEmailTemplate('rejection', { subject: '你'.repeat(200), body: '😀'.repeat(5000) }).ok).toBe(true);
  });
  it('finds placeholders and stray braces', () => {
    expect(templatePlaceholders('{a} and {b}')).toEqual({ names: ['a', 'b'], stray: false });
    expect(templatePlaceholders('}{a}')).toEqual({ names: ['a'], stray: true });
  });
  it('both kinds allow exactly the four base placeholders (slice 20 adds kinds with their own)', () => {
    expect(CANDIDATE_EMAIL_KINDS).toEqual(['application_received', 'rejection']);
    for (const k of CANDIDATE_EMAIL_KINDS) expect([...CANDIDATE_EMAIL_PLACEHOLDERS[k]]).toEqual(['candidateName', 'jobTitle', 'companyName', 'senderName']);
  });
});

describe('the renderer: what is previewed is what is sent', () => {
  it('fills the values once, escapes every character into HTML, and keeps only paragraphs and line breaks', () => {
    const hostile = { ...values, candidateName: '<script>alert(1)</script> & "QZE" {jobTitle}' };
    const m = renderCandidateEmail('rejection', 'en', { subject: 'Re: {jobTitle}', body: 'Dear {candidateName},\n\nLine one\nLine <b>two</b>\n\n\nKind regards,\n{senderName}' }, hostile);
    expect(m.subject).toBe('Re: QZE Fictional analyst');
    // Text: values as they are, no second expansion of "{jobTitle}" inside a value.
    expect(m.text).toBe('Dear <script>alert(1)</script> & "QZE" {jobTitle},\n\nLine one\nLine <b>two</b>\n\n\nKind regards,\nQZE Talent team');
    expect(m.html).toBe('<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>'
      + '<p>Dear &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;QZE&quot; {jobTitle},</p><p>Line one<br>Line &lt;b&gt;two&lt;/b&gt;</p><p>Kind regards,<br>QZE Talent team</p></body></html>');
    expect(m.html).not.toMatch(/<(a|img|script|style|b)\b|href=|src=/i);
    expect(new RegExp(HTML_GRAMMAR).test(m.html)).toBe(true);
  });
  it('makes control characters in the subject spaces (no header injection)', () => {
    const m = renderCandidateEmail('application_received', 'en', { subject: 'Hi {candidateName}', body: 'x' }, { ...values, candidateName: 'A\r\nBcc: someone@example.test' });
    expect(m.subject).toBe('Hi A Bcc: someone@example.test');
    expect(m.subject).not.toMatch(/[\r\n]/);
  });
  it('renders a placeholder outside the allowlist as nothing (a code default never has one; saves refuse it)', () => {
    expect(renderCandidateEmail('rejection', 'en', { subject: '{nope}x', body: '{nope}y' }, values)).toMatchObject({ subject: 'x', text: 'y' });
  });
});

describe('settings, delays, states and backoff', () => {
  it('needs a reply-to to switch on; the sender name and language are bounded', () => {
    expect(validateCandidateEmailSettings({ enabled: 'on' })).toEqual({ ok: false, code: 'missing_fields', fields: ['replyTo'] });
    expect(validateCandidateEmailSettings({ enabled: 'on', replyTo: 'Talent <talent@example.test>' })).toMatchObject({ ok: false, fields: ['replyTo'] });
    expect(validateCandidateEmailSettings({ enabled: false, senderName: 'x'.repeat(81) })).toMatchObject({ ok: false, fields: ['senderName'] });
    expect(validateCandidateEmailSettings({ enabled: false, locale: 'fr' })).toMatchObject({ ok: false, fields: ['locale'] });
    expect(validateCandidateEmailSettings({ enabled: 'on', replyTo: ' Talent@Example.TEST ', senderName: ' QZE Talent ', locale: 'ms' }))
      .toEqual({ ok: true, value: { enabled: true, replyTo: 'talent@example.test', senderName: 'QZE Talent', locale: 'ms' } });
    expect(validateCandidateEmailSettings({})).toEqual({ ok: true, value: { enabled: false, replyTo: null, senderName: null, locale: 'en' } });
    expect(validReplyTo('talent@example.test')).toBe(true);
    expect(validReplyTo('talent@localhost')).toBe(false);
    expect(validReplyTo('qzé@example.test')).toBe(false);
  });
  it('uses the transport\'s canonical rule for recipients: anything else is no usable address', () => {
    expect(usableRecipient('qze.applicant@example.test')).toBe(true);
    for (const bad of [null, '', 'Fictional <qze@example.test>', 'qze applicant@example.test', 'qzé@example.test', `${'q'.repeat(250)}@example.test`]) {
      expect(usableRecipient(bad), String(bad)).toBe(false);
    }
  });
  it('cuts the default sender name at 80 and trims Unicode spaces after the cut (as 5720 does)', () => {
    expect(defaultSenderName('\u3000 Fictional QZE\u00a0')).toBe('Fictional QZE');
    const name = 'Q'.repeat(79) + '\u00a0' + 'tail';
    expect(defaultSenderName(name)).toBe('Q'.repeat(79));
    expect(defaultSenderName('A\nB')).toBe('A B');
    expect(read('db/migrations/5720_recruitment_candidate_email.sql')).toContain('\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff');
  });
  it('refuses a sender name the transport refuses (@ < > " and control characters); every accepted name passes the transport rule', () => {
    for (const bad of ['QZE@Talent', 'talent@example.test', 'QZE <Talent>', 'QZE Talent >', 'QZE "Talent"', '"', 'QZE\tTalent', 'QZE\u0085Talent']) {
      expect(validateCandidateEmailSettings({ enabled: false, senderName: bad }), JSON.stringify(bad)).toEqual({ ok: false, code: 'invalid_input', fields: ['senderName'] });
      // The transport refuses each of these too (C1 controls are refused here only, as 5720 refuses them).
      if (!/[\u0080-\u009f]/.test(bad)) expect(validManagedEmailSenderName(bad.trim()), JSON.stringify(bad)).not.toBe(bad.trim());
    }
    for (const good of ['QZE Talent & Co.', 'Fictional QZE (Talent)', "O'Brien QZE", 'QZE 人才团队', 'Q'.repeat(80), '\u00a0QZE Talent\u3000']) {
      const v = validateCandidateEmailSettings({ enabled: false, senderName: good });
      expect(v.ok, JSON.stringify(good)).toBe(true);
      const name = v.ok ? v.value.senderName : null;
      expect(validManagedEmailSenderName(name), JSON.stringify(good)).toBe(name);
    }
  });
  it('makes the company name safe as the default sender name (D-064): refused characters made spaces, runs of spaces made one', () => {
    expect(defaultSenderName('Fictional "QZE" Sdn Bhd')).toBe('Fictional QZE Sdn Bhd');
    expect(defaultSenderName('QZE@Work Sdn Bhd')).toBe('QZE Work Sdn Bhd');
    expect(defaultSenderName('<QZE>  Fictional\n\nSdn Bhd')).toBe('QZE Fictional Sdn Bhd');
    expect(defaultSenderName(' "QZE" ')).toBe('QZE');
    expect(defaultSenderName(`${'Q'.repeat(79)}"tail`)).toBe('Q'.repeat(79));
    expect(defaultSenderName('"@<>"')).toBe('');
    for (const name of ['Fictional "QZE" Sdn Bhd', 'QZE@Work Sdn Bhd', '<QZE> Sdn Bhd', `${'@'.repeat(40)}${'Q'.repeat(100)}`, 'QZE\u0001\u007f\u009f x', '\u3000"QZE"\u00a0']) {
      const d = defaultSenderName(name);
      expect(d, JSON.stringify(name)).not.toBe('');
      expect(validManagedEmailSenderName(d), JSON.stringify(name)).toBe(d);
    }
  });
  it('5720 refuses the same characters in both sender CHECKs and makes them spaces in the default (one class, as the model)', () => {
    expect(SENDER_NAME_REFUSED.source).toBe('[\\u0001-\\u001f\\u007f-\\u009f@<>"]');
    const m = read('db/migrations/5720_recruitment_candidate_email.sql');
    const cls = `'[\\x01-\\x1f\\x7f-\\x9f@<>"]'`;
    expect(m).toContain(`AND sender_name !~ ${cls})),`);
    expect(m).toContain(`sender_name text NOT NULL CHECK (char_length(sender_name) BETWEEN 1 AND 80 AND sender_name !~ ${cls}`);
    expect(m).toContain(`coalesce(p_company_name, ''), ${cls}, ' ', 'g'), ' {2,}', ' ', 'g'),`);
    expect(m.match(/sender_name !~ '\[\\x01-\\x1f\\x7f-\\x9f\]'/g)).toBeNull();
  });
  it('rejection delays are now or 1–3 days', () => {
    expect(['0', '1', '2', '3', 2].map(parseRejectionDelay)).toEqual([0, 1, 2, 3, 2]);
    expect(['4', '-1', '1.5', 'x', ''].map(parseRejectionDelay)).toEqual([null, null, null, null, null]);
  });
  it('shows retry as queued and leased as sending; only failed or uncertain e-mails with content kept are retried', () => {
    expect((['queued', 'leased', 'sending', 'sent', 'retry', 'failed', 'uncertain'] as const).map(candidateEmailDisplayState))
      .toEqual(['queued', 'sending', 'sending', 'sent', 'queued', 'failed', 'uncertain']);
    expect(candidateEmailRetryable('failed', false)).toBe(true);
    expect(candidateEmailRetryable('uncertain', false)).toBe(true);
    expect(candidateEmailRetryable('uncertain', true)).toBe(false);
    expect(candidateEmailRetryable('sent', false)).toBe(false);
  });
  it('backs off min(3600, 60·2^attempts) seconds', () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(candidateEmailBackoffSeconds)).toEqual([120, 240, 480, 960, 1920, 3600, 3600]);
  });
});

describe('default wording in the six languages', () => {
  const en = messages('en').recruitment.candidateEmail;
  const keys = (o: Record<string, unknown>, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]));
  it.each(CANDIDATE_EMAIL_LOCALES)('%s: every kind has valid default wording and the same keys as English', (locale) => {
    const m = messages(locale).recruitment;
    expect(keys(m.candidateEmail).sort()).toEqual(keys(en).sort());
    for (const kind of CANDIDATE_EMAIL_KINDS) {
      const d = m.candidateEmail.defaults[kind];
      const v = validateCandidateEmailTemplate(kind, d);
      expect(v.ok, `${locale} ${kind}`).toBe(true);
      // Every default names the candidate and the sender; none names anything outside the allowlist.
      expect(templatePlaceholders(d.body).names).toEqual(expect.arrayContaining(['candidateName', 'senderName']));
    }
    for (const c of ['email_unavailable', 'email_off', 'email_placeholder', 'email_link', 'email_hourly_limit', 'email_changed', 'email_not_retryable']) {
      expect(m.errors[c], `${locale} ${c}`).toBeTruthy();
      expect(RECRUITMENT_ERROR_CODES).toContain(c);
    }
    expect(m.settings.section.email).toBeTruthy();
  });
});

describe('5720 agrees with the model', () => {
  const m = read('db/migrations/5720_recruitment_candidate_email.sql');
  it('uses the same link pattern and HTML grammar as the model, and has no careers receipt path (D-064)', () => {
    expect(m).toContain(`SELECT p_text ~* '${LINK_PATTERN}';`);
    expect(m).toContain(`body_html ~ '${HTML_GRAMMAR}'`);
    expect(m).not.toMatch(/recruitment_careers_receipt|receipt_pending|recruitment_email_receipt|ON public\.recruitment_careers_application/);
    expect(m).toContain('CREATE UNIQUE INDEX recruitment_candidate_email_rejection_uq');
    expect(m).toContain("lease_until = clock_timestamp() + interval '5 minutes'");
  });
  it('names the same kinds, placeholders, languages and hourly cap', () => {
    expect(m).toContain("kind IN ('application_received','rejection')");
    expect(m).toContain(`ARRAY[${BASE_PLACEHOLDERS.map((p) => `'${p}'`).join(',')}]`);
    expect(m).toContain(`locale IN (${CANDIDATE_EMAIL_LOCALES.map((l) => `'${l}'`).join(',')})`);
    expect(m).toContain(`app.recruitment_candidate_email_hour_count(x.company_id) > ${CANDIDATE_EMAIL_HOURLY_CAP}`);
    expect(m).toContain('REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT');
    expect(m).toContain('least(3600, 60 * power(2, x.attempts))');
  });
  it('restates the candidate removal (5717) and the company delete (5719) byte for byte with added steps only', () => {
    const fn = (source: string, name: string) => {
      const start = source.lastIndexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      return source.slice(start, source.indexOf('END $$;', start) + 'END $$;'.length);
    };
    const added = (prior: string, name: string) => {
      const b = fn(read(`db/migrations/${prior}`), name).split('\n');
      const a = fn(m, name).split('\n');
      let i = 0;
      while (i < b.length && a[i] === b[i]) i++;
      let j = 0;
      while (j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
      expect(i + j, name).toBe(b.length);
      expect(b.length).toBeGreaterThan(90);
      return a.slice(i, a.length - j);
    };
    const destroy = added('5717_recruitment_import_export.sql', 'app.recruitment_destroy_candidate');
    expect(destroy.filter((l) => /DELETE FROM/.test(l)).map((l) => l.trim().split(' ')[2])).toEqual(['public.recruitment_candidate_email']);
    expect(destroy).toHaveLength(4);
    const del = added('5719_recruitment_interview_setup.sql', 'app.recruitment_delete_company_setup');
    expect(del.filter((l) => /DELETE FROM/.test(l)).map((l) => l.trim().split(' ')[2])).toEqual(['public.recruitment_candidate_email',
      'public.recruitment_candidate_email_template', 'public.recruitment_candidate_email_setting']);
    expect(del).toHaveLength(9);
  });
  it('gives the sweep functions no grant to the app role, and never takes an address or content', () => {
    for (const f of ['claim(integer)', 'target(uuid, uuid)', 'start(uuid, uuid, text)', 'finish(uuid, uuid, text, text)', 'purge(integer)']) {
      expect(m).toContain(`REVOKE ALL ON FUNCTION app.recruitment_candidate_email_${f} FROM PUBLIC, ai_hr_app;`);
      expect(m).not.toContain(`GRANT EXECUTE ON FUNCTION app.recruitment_candidate_email_${f}`);
    }
  });
});

describe('the transport: a per-message display name and reply-to, nothing else changes', () => {
  const relay: Relay = { config: { host: 'smtp.fixture.invalid', port: 465, security: 'tls', from: 'verified@fixture.invalid', fromName: 'Fictional relay name', replyTo: 'relay-replies@fixture.invalid', auth: false, user: '' } };
  const to = 'qze.applicant@example.test';
  const mail = (over: Record<string, unknown> = {}) => ({ to, subject: 'QZE subject', text: 'QZE text', html: '<p>QZE</p>', attachments: [], messageId: '<recruitment-candidate-email.fixture@fixture.invalid>', ...over }) as unknown as Mail;
  beforeEach(() => { vi.resetAllMocks(); smtp.create.mockReturnValue({ sendMail: smtp.send, close: smtp.close }); smtp.send.mockResolvedValue({ accepted: [to] }); });
  it('uses the company\'s display name and reply-to with the relay\'s From address', async () => {
    await sendSmtp(relay, mail({ senderName: 'QZE Talent team', replyTo: 'talent@example.test' }));
    expect(smtp.send.mock.calls[0][0]).toMatchObject({ from: { name: 'QZE Talent team', address: relay.config.from }, replyTo: 'talent@example.test', to,
      envelope: { from: relay.config.from, to: [to] }, messageId: '<recruitment-candidate-email.fixture@fixture.invalid>', html: '<p>QZE</p>' });
  });
  it('without them, keeps the relay\'s name and reply-to (existing callers unchanged)', async () => {
    await sendSmtp(relay, mail());
    expect(smtp.send.mock.calls[0][0]).toMatchObject({ from: { name: 'Fictional relay name', address: relay.config.from }, replyTo: 'relay-replies@fixture.invalid' });
    // Main's transport has no per-message sender profile any more (one On/Off Boarding sender name per tenant): the field is refused.
    await expect(sendSmtp(relay, mail({ senderProfile: 'onboarding' }))).rejects.toMatchObject({ code: 'invalid' });
    expect(smtp.send).toHaveBeenCalledOnce();
  });
  it('tells the caller when it starts connecting; nothing before that reaches the relay', async () => {
    const connecting = vi.fn();
    await sendSmtp(relay, mail(), { connecting });
    expect(connecting).toHaveBeenCalledOnce();
    connecting.mockClear();
    await expect(sendSmtp(relay, mail({ senderName: 'QZE\nx' }), { connecting })).rejects.toMatchObject({ code: 'invalid' });
    expect(connecting).not.toHaveBeenCalled();
  });
  it('the candidate sender records a failure before any connection as not sent, with its own code', async () => {
    const m: CandidateMail = { to, subject: 's', text: 't', html: '<p>t</p>', senderName: 'QZE', replyTo: 'talent@example.test', messageId: '<x.y@hr.example.test>' };
    const invalid = await internalCandidateEmailSender('6a3f9a52-8b7e-4d2a-9f1e-1c2d3e4f5a6b', async () => { throw new EmailSettingsError('invalid'); });
    expect(invalid).toMatchObject({ revision: 'rev-fixture-1', host: 'hr.example.test' });
    await expect(invalid!.send(m)).rejects.toEqual(new CandidateMailNotSent('invalidMessage'));
    const prep = await internalCandidateEmailSender('6a3f9a52-8b7e-4d2a-9f1e-1c2d3e4f5a6b', async () => { throw new EmailSettingsError('authenticationFailed'); });
    await expect(prep!.send(m)).rejects.toBeInstanceOf(CandidateMailNotSent);
    await expect(prep!.send(m)).rejects.toMatchObject({ code: 'relayPreparation' });
    const late = Object.assign(new Error('socket closed'), {});
    const during = await internalCandidateEmailSender('6a3f9a52-8b7e-4d2a-9f1e-1c2d3e4f5a6b', async (_r, _m, o) => { o?.connecting?.(); throw late; });
    await expect(during!.send(m)).rejects.toBe(late);
  });
  it.each([
    ['a display name with a line break', { senderName: 'QZE\r\nBcc: x@example.test' }],
    ['a display name over 160 characters', { senderName: 'x'.repeat(161) }],
    ['a display name with @', { senderName: 'QZE@Talent' }],
    ['a display name with < and >', { senderName: 'QZE <Talent>' }],
    ['a display name with a double quote', { senderName: 'QZE "Talent"' }],
    ['a display name with surrounding space', { senderName: ' QZE Talent' }],
    ['a reply-to with a display name', { replyTo: 'Talent <talent@example.test>' }],
    ['a display name outside managed delivery', { attachments: undefined, senderName: 'QZE' }],
    ['a reply-to outside managed delivery', { attachments: undefined, replyTo: 'talent@example.test' }],
  ])('refuses %s before opening SMTP', async (_n, over) => {
    await expect(sendSmtp(relay, mail(over))).rejects.toMatchObject({ code: 'invalid' });
    expect(smtp.create).not.toHaveBeenCalled();
  });
});
