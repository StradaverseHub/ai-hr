/**
 * Recruitment slice 20 — the pure rules of candidate e-mail about interviews and offers (packs/recruitment/candidate-email-model.ts) and
 * their agreement with db/migrations/5721_recruitment_candidate_email_interviews_offers.sql. No database. Fictional values only; expected
 * times are computed with Intl, never with the module's helpers.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_EMAIL_KINDS, CANDIDATE_EMAIL_LOCALES, CANDIDATE_EMAIL_PLACEHOLDERS, HTML_GRAMMAR, INTERVIEW_PLACEHOLDERS, REMINDER_HOURS_DEFAULT, interviewEmailValues,
  interviewFactsFromForm, klParts, linkishExcept, offerDetailsText, parseReminderHours, reminderDueAt, renderCandidateEmail, renderInterviewEmail,
  validateCandidateEmailSettings, validateCandidateEmailTemplate, type InterviewEmailLabels,
} from '../packs/recruitment/candidate-email-model';
import { RECRUITMENT_ERROR_CODES } from '../packs/recruitment/model';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(`${root}${p}`, 'utf8');
const m5721 = read('db/migrations/5721_recruitment_candidate_email_interviews_offers.sql');
/** The latest restatement of the placeholder allowlist (5724, slice 22, added the survey's {surveyLink}; 5723 added {responseLink}), every
 *  run of whitespace made one space (its long arrays wrap across lines). */
const m5724 = read('db/migrations/5724_recruitment_candidate_survey.sql');
const flat5721 = m5724.replace(/,\s+/g, ',').replace(/\s+/g, ' ');
const messages = (l: string) => JSON.parse(read(`messages/${l}.json`)) as {
  recruitment: { candidateEmail: { interview: Omit<InterviewEmailLabels, 'weekdays'> & { weekdays: Record<string, string> }; defaults: Record<string, { subject: string; body: string }> };
    errors: Record<string, string>; offer: Record<string, unknown> } };
const labelsOf = (l: string): InterviewEmailLabels => {
  const i = messages(l).recruitment.candidateEmail.interview;
  return { ...i, weekdays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => i.weekdays[d]) };
};
const base = { candidateName: 'Fictional QZG Applicant', jobTitle: 'QZG Fictional analyst', companyName: 'QZG Fictional Sdn Bhd', senderName: 'QZG Talent' };
const MAP = 'https://maps.example.test/qzg?a=1&b=2';
const facts = (over: Record<string, unknown> = {}) => ({
  roundNo: 2, type: 'onsite' as const, startsAt: new Date('2026-11-20T02:30:00Z'), durationMinutes: 45, room: 'Room QZG',
  address: { name: 'QZG Head office', address: '1 Fictional Road', region: 'Kuala Lumpur', mapUrl: MAP }, site: null, meetingRoom: null, ...over,
});

describe('kinds and placeholders agree with 5721', () => {
  it('lists the six kinds in the template and delivery CHECKs (5721), and all seven with the survey (5724)', () => {
    const six = CANDIDATE_EMAIL_KINDS.filter((k) => k !== 'survey').map((k) => `'${k}'`).join(',');
    expect(m5721).toContain(`CHECK (kind IN (${six}))`);
    expect(m5721.split(`CHECK (kind IN (${six}))`)).toHaveLength(3);
    const list = CANDIDATE_EMAIL_KINDS.map((k) => `'${k}'`).join(',');
    expect(m5724.split(`CHECK (kind IN (${list}))`)).toHaveLength(3);
  });
  it('restates each kind\'s placeholder allowlist exactly as the model (latest restatement, 5724)', () => {
    for (const kind of ['interview_invitation', 'interview_reminder', 'interview_cancelled', 'offer', 'survey'] as const) {
      expect(flat5721).toContain(`WHEN '${kind}' THEN ARRAY[${CANDIDATE_EMAIL_PLACEHOLDERS[kind].map((p) => `'${p}'`).join(',')}]`);
    }
    expect(CANDIDATE_EMAIL_PLACEHOLDERS.interview_cancelled).not.toContain('interviewPlace');
    expect(CANDIDATE_EMAIL_PLACEHOLDERS.offer).toContain('offerDetails');
    // Nothing a candidate e-mail can name is about the interviewers.
    for (const k of CANDIDATE_EMAIL_KINDS) expect(CANDIDATE_EMAIL_PLACEHOLDERS[k].join(' ')).not.toMatch(/interviewer/i);
  });
  it('keeps every frozen-content rule of 5720 and adds only the map-link exemption, the new state and the subjects', () => {
    expect(m5721).toContain("NOT app.recruitment_candidate_email_linkish(CASE WHEN map_url IS NULL THEN body_text ELSE replace(body_text, map_url, ' ') END)");
    expect(m5721).toContain("(map_url IS NULL OR kind IN ('interview_invitation','interview_reminder'))");
    expect(m5721).toContain("status IN ('queued','leased','sending','sent','retry','failed','uncertain','withdrawn')");
    for (const f of ['target(uuid, uuid)', 'finish(uuid, uuid, text, text)', 'purge(integer)']) {
      expect(m5721).toContain(`REVOKE ALL ON FUNCTION app.recruitment_candidate_email_${f} FROM PUBLIC, ai_hr_app;`);
      expect(m5721).not.toContain(`GRANT EXECUTE ON FUNCTION app.recruitment_candidate_email_${f}`);
    }
    expect(m5721).toContain('REVOKE ALL ON FUNCTION app.recruitment_withdraw_interview_emails() FROM PUBLIC, ai_hr_app;');
    expect(m5721).toContain('REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT');
  });
  it('restates 5720\'s guard and statement check with their bodies kept (every 5720 refusal still raised)', () => {
    const m5720 = read('db/migrations/5720_recruitment_candidate_email.sql');
    for (const sentence of ["'A rejection e-mail is sent at most three days later'", "'A candidate e-mail is queued by the current user'", "'A queued candidate e-mail is immutable'",
      "'A purged candidate e-mail stays purged'", "'Only a failed or uncertain e-mail can be retried, by an administrator'",
      "'A candidate e-mail names its application, job and candidate'", "CONSTRAINT = 'recruitment_candidate_email_recipient'",
      "CONSTRAINT = 'recruitment_candidate_email_settings'", "CONSTRAINT = 'recruitment_candidate_email_hourly_limit'"]) {
      expect(m5720, sentence).toContain(sentence);
      expect(m5721, sentence).toContain(sentence);
    }
  });
});

describe('interview values: Kuala Lumpur time without Intl, the place and the one map link', () => {
  it('formats the KL date, weekday and time as Intl does, every hour of a day', () => {
    for (let h = 0; h < 24; h++) {
      const at = new Date(Date.UTC(2026, 11, 31, h, 5));
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(at);
      const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kuala_Lumpur' }).format(at);
      const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'Asia/Kuala_Lumpur' }).format(at);
      const p = klParts(at);
      expect([p.date, p.time, labelsOf('en').weekdays[p.weekday]]).toEqual([date, time, weekday]);
    }
  });
  it('states the round, type, date, time (zone named), duration and on-site place with the map link', () => {
    const { values, mapUrl } = interviewEmailValues(facts(), labelsOf('en'));
    expect(values).toEqual({
      interviewRound: 'Round 2', interviewType: 'On-site interview', interviewDate: 'Friday, 2026-11-20',
      interviewTime: '10:30 to 11:15, Kuala Lumpur time (GMT+8)', interviewDuration: '45 minutes',
      interviewPlace: `Room QZG, QZG Head office, 1 Fictional Road, Kuala Lumpur · Map: ${MAP}`,
    });
    expect(mapUrl).toBe(MAP);
  });
  it('a video or phone interview names no place or link; without an address the free text is used', () => {
    expect(interviewEmailValues(facts({ type: 'video', address: null, room: null }), labelsOf('en')))
      .toMatchObject({ mapUrl: null, values: { interviewPlace: 'By video call: we will send you the joining details by reply.' } });
    expect(interviewEmailValues(facts({ address: null, room: 'Room 9', site: 'Level 3,  Fictional Tower', meetingRoom: 'Room 9' }), labelsOf('en')).values.interviewPlace)
      .toBe('Room 9, Level 3, Fictional Tower');
    expect(interviewEmailValues(facts({ address: null, room: null }), labelsOf('en')).values.interviewPlace).toBe('We will send you the address by reply.');
  });
  it('exempts exactly the frozen map link: any other link in the place still blocks', () => {
    const d = messages('en').recruitment.candidateEmail.defaults.interview_invitation;
    const ok = renderInterviewEmail('interview_invitation', 'en', d, base, facts(), labelsOf('en'));
    expect(ok.valueLink).toBe(false);
    expect(ok.mail.text).toContain(MAP);
    expect(ok.mail.html).toMatch(new RegExp(HTML_GRAMMAR));
    expect(ok.mail.html).toContain('https://maps.example.test/qzg?a=1&amp;b=2');
    const bad = renderInterviewEmail('interview_invitation', 'en', d, base, facts({ address: { ...facts().address, address: 'see evil.example/login' } }), labelsOf('en'));
    expect(bad.valueLink).toBe(true);
    expect(linkishExcept(`x ${MAP} y`, MAP)).toBe(false);
    expect(linkishExcept(`x ${MAP} https://other.example/`, MAP)).toBe(true);
    // A cancellation never carries the link.
    const c = renderInterviewEmail('interview_cancelled', 'en', messages('en').recruitment.candidateEmail.defaults.interview_cancelled, base, facts(), labelsOf('en'));
    expect(c.mapUrl).toBeNull();
    expect(c.mail.text).not.toContain('maps.example.test');
  });
  it('a room names its address in the form preview, as slice 18 resolves it; no place unless on-site', () => {
    const places = [{ id: 'a1', name: 'QZG Head office', address: '1 Fictional Road', region: 'Kuala Lumpur', mapUrl: MAP, rooms: [{ id: 'r1', name: 'Room QZG' }] }];
    const f = { roundNo: 2, type: 'onsite' as const, startsAt: new Date(), durationMinutes: 45, addressId: null, roomId: 'r1', site: null, meetingRoom: null };
    expect(interviewFactsFromForm(f, places)).toMatchObject({ room: 'Room QZG', address: { name: 'QZG Head office', mapUrl: MAP } });
    expect(interviewFactsFromForm({ ...f, type: 'video' }, places)).toMatchObject({ room: null, address: null });
  });
  it('every language has the interview words and valid default wording for the new kinds', () => {
    for (const l of CANDIDATE_EMAIL_LOCALES) {
      const labels = labelsOf(l);
      expect(labels.weekdays.every(Boolean), l).toBe(true);
      expect(labels.time, l).toContain('{start}');
      expect(labels.map, l).toContain('{url}');
      for (const kind of ['interview_invitation', 'interview_reminder', 'interview_cancelled', 'offer'] as const) {
        const d = messages(l).recruitment.candidateEmail.defaults[kind];
        expect(validateCandidateEmailTemplate(kind, d).ok, `${l} ${kind}`).toBe(true);
        // The rendered default with realistic values is not link-like other than by the map link.
        const r = kind === 'offer' ? null : renderInterviewEmail(kind, l, d, base, facts(), labels);
        if (r) expect(r.valueLink, `${l} ${kind}`).toBe(false);
      }
      for (const c of ['email_no_address', 'email_value_link', 'email_private_field', 'email_use_send']) {
        expect(messages(l).recruitment.errors[c], `${l} ${c}`).toBeTruthy();
        expect(RECRUITMENT_ERROR_CODES).toContain(c);
      }
    }
    expect(INTERVIEW_PLACEHOLDERS).toHaveLength(6);
  });
});

describe('reminders and offers', () => {
  it('a reminder is due at start minus the hours, only while that is ahead; hours 2–72, default 24, on by default', () => {
    const start = new Date('2026-11-20T02:30:00Z');
    expect(reminderDueAt(start, 24, new Date('2026-11-18T00:00:00Z'))?.toISOString()).toBe('2026-11-19T02:30:00.000Z');
    expect(reminderDueAt(start, 24, new Date('2026-11-19T02:30:00Z'))).toBeNull();
    expect(['2', '72', 24, '24'].map(parseReminderHours)).toEqual([2, 72, 24, 24]);
    expect(['1', '73', '2.5', 'x', ''].map(parseReminderHours)).toEqual([null, null, null, null, null]);
    expect(validateCandidateEmailSettings({})).toMatchObject({ ok: true, value: { reminderEnabled: true, reminderHours: REMINDER_HOURS_DEFAULT } });
    expect(validateCandidateEmailSettings({ reminderEnabled: false, reminderHours: '6' })).toMatchObject({ ok: true, value: { reminderEnabled: false, reminderHours: 6 } });
    expect(validateCandidateEmailSettings({ reminderHours: '80' })).toMatchObject({ ok: false, fields: ['reminderHours'] });
  });
  it('states each marked field as entered, one per line (a <br> in HTML), and refuses rather than cuts an over-long block', () => {
    const text = offerDetailsText([{ label: 'Basic salary', value: 'MYR 5000.50' }, { label: 'Start  date', value: '2026-12-01' }]);
    expect(text).toBe('Basic salary: MYR 5000.50\nStart date: 2026-12-01');
    const mail = renderCandidateEmail('offer', 'en', { subject: 'Offer', body: 'Dear {candidateName},\n\n{offerDetails}' }, { ...base, offerDetails: text! });
    expect(mail.html).toContain('<p>Basic salary: MYR 5000.50<br>Start date: 2026-12-01</p>');
    expect(mail.html).toMatch(new RegExp(HTML_GRAMMAR));
    expect(offerDetailsText([{ label: 'Notes', value: 'x'.repeat(10_001) }])).toBeNull();
  });
});
