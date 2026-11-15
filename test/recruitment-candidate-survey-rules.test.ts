/**
 * Recruitment slice 22 — the anonymous candidate survey's pure rules (docs/recruitment-reconstruction/specification.md "Slice 22"): the
 * survey template's link placeholder, the link the sweep puts in, the survey form, the results' minimums and figures, the public path,
 * the six languages, and 5724's agreement with the model. Expected figures are computed here from the raw answers, independently of
 * the module's tally code. Every value is fictional (QZS).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isCareersRoute } from '../lib/careers-route';
import {
  CANDIDATE_EMAIL_PLACEHOLDERS, SURVEY_COMMENT_MAX, SURVEY_MIN_RESPONSES, SURVEY_RATINGS, parseSurveyDelay, summarizeSurvey, surveyFigures,
  validateCandidateEmailTemplate, validateCandidateEmailSettings, validateSurveyAnswers, withSurveyLink, emptySurveyTally,
  type SurveyTally,
} from '../packs/recruitment/candidate-email-model';
import { RECRUITMENT_ERROR_CODES } from '../packs/recruitment/model';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(`${root}${p}`, 'utf8');
const m5724 = read('db/migrations/5724_recruitment_candidate_survey.sql');
const LINK = `https://hr.qzs.example.test/careers/s/${'Ab_-'.repeat(10)}xyz`;

type Answer = { outcome: 'hired' | 'rejected'; overall: number; communication: number | null; respect: number | null; process: number | null; recommend: 'yes' | 'no' | 'unsure' | null };
/** The tally of raw answers, written out here (the database aggregates these in the module). */
function tallyOf(rows: Answer[]): SurveyTally {
  const t = emptySurveyTally();
  for (const r of rows) {
    t.responses += 1;
    t.overall[r.overall - 1] += 1;
    for (const q of SURVEY_RATINGS) {
      const v = r[q];
      if (v !== null) { t.ratings[q].count += 1; t.ratings[q].sum += v; }
    }
    if (r.recommend) t.recommend[r.recommend] += 1;
  }
  return t;
}
const answer = (o: Partial<Answer> = {}): Answer => ({ outcome: 'hired', overall: 4, communication: null, respect: null, process: null, recommend: null, ...o });

describe('the survey template', () => {
  it('names {surveyLink} exactly once in the body and never in the subject', () => {
    expect(CANDIDATE_EMAIL_PLACEHOLDERS.survey).toEqual(['candidateName', 'jobTitle', 'companyName', 'senderName', 'surveyLink']);
    expect(validateCandidateEmailTemplate('survey', { subject: 'QZS survey', body: 'Dear {candidateName}\n\n{surveyLink}' }).ok).toBe(true);
    expect(validateCandidateEmailTemplate('survey', { subject: 'QZS survey', body: 'Dear {candidateName}' })).toEqual({ ok: false, code: 'email_survey_link', fields: ['body'] });
    expect(validateCandidateEmailTemplate('survey', { subject: 'QZS survey', body: '{surveyLink} and {surveyLink}' })).toEqual({ ok: false, code: 'email_survey_link', fields: ['body'] });
    expect(validateCandidateEmailTemplate('survey', { subject: 'Go {surveyLink}', body: '{surveyLink}' })).toEqual({ ok: false, code: 'email_survey_link', fields: ['subject'] });
    // Another kind may not name it at all.
    expect(validateCandidateEmailTemplate('rejection', { subject: 'QZS', body: '{surveyLink}' })).toMatchObject({ ok: false, code: 'email_placeholder' });
    expect(RECRUITMENT_ERROR_CODES).toContain('email_survey_link');
  });
  it('takes the sweep\'s link once, in the text and the HTML, and refuses anything else', () => {
    const m = { subject: 'QZS', text: 'Hello\n{surveyLink}\nBye', html: '<p>Hello<br>{surveyLink}</p>' };
    expect(withSurveyLink(m, LINK)).toEqual({ subject: 'QZS', text: `Hello\n${LINK}\nBye`, html: `<p>Hello<br>${LINK}</p>` });
    expect(withSurveyLink(m, 'http://hr.qzs.example.test/careers/s/x')).toBeNull();
    expect(withSurveyLink(m, `${LINK}/more`)).toBeNull();
    expect(withSurveyLink({ ...m, text: '{surveyLink}{surveyLink}' }, LINK)).toBeNull();
    expect(withSurveyLink({ ...m, html: '<p></p>' }, LINK)).toBeNull();
    expect(withSurveyLink({ ...m, subject: '{surveyLink}' }, LINK)).toBeNull();
  });
  it('is sent 1–14 days after the decision (default 3), and off until ticked', () => {
    expect([0, 1, 14, 15, '3', ' 7 ', '2.5', 'x'].map(parseSurveyDelay)).toEqual([null, 1, 14, null, 3, 7, null, null]);
    expect(validateCandidateEmailSettings({})).toMatchObject({ ok: true, value: { surveyHired: false, surveyRejected: false, surveyDelayDays: 3 } });
    expect(validateCandidateEmailSettings({ surveyHired: 'on', surveyRejected: true, surveyDelayDays: '14' }))
      .toMatchObject({ ok: true, value: { surveyHired: true, surveyRejected: true, surveyDelayDays: 14 } });
    expect(validateCandidateEmailSettings({ surveyDelayDays: '15' })).toEqual({ ok: false, code: 'invalid_input', fields: ['surveyDelayDays'] });
  });
});

describe('the survey form', () => {
  it('needs an overall rating of 1–5; the rest are optional and checked', () => {
    expect(validateSurveyAnswers({ overall: '5' })).toEqual({ ok: true, value: { overall: 5 } });
    expect(validateSurveyAnswers({})).toEqual({ ok: false, fields: ['overall'] });
    expect(validateSurveyAnswers({ overall: '6', communication: '0', respect: '2', process: 'x', recommend: 'maybe' }))
      .toEqual({ ok: false, fields: ['overall', 'communication', 'process', 'recommend'] });
    expect(validateSurveyAnswers({ overall: '3', communication: '', respect: '4', process: '1', recommend: 'unsure', comment: '  QZS was fine\r\nthanks  ' }))
      .toEqual({ ok: true, value: { overall: 3, respect: 4, process: 1, recommend: 'unsure', comment: 'QZS was fine\nthanks' } });
    expect(validateSurveyAnswers({ overall: '3', comment: '   ' })).toEqual({ ok: true, value: { overall: 3 } });
    expect(validateSurveyAnswers({ overall: '3', comment: 'a'.repeat(SURVEY_COMMENT_MAX) }).ok).toBe(true);
    expect(validateSurveyAnswers({ overall: '3', comment: 'a'.repeat(SURVEY_COMMENT_MAX + 1) })).toEqual({ ok: false, fields: ['comment'] });
    expect(validateSurveyAnswers({ overall: '3', comment: 'bell\u0007' })).toEqual({ ok: false, fields: ['comment'] });
  });
});

describe('results', () => {
  it('shows nothing below the minimum, the split only when each side reaches it', () => {
    expect(SURVEY_MIN_RESPONSES).toBe(5);
    const four = Array.from({ length: 4 }, () => answer());
    expect(summarizeSurvey({ hired: tallyOf(four), rejected: emptySurveyTally() }, ['QZS'])).toEqual({ shown: false, minimum: 5 });
    const five = [...four, answer({ outcome: 'rejected' })];
    const s5 = summarizeSurvey({ hired: tallyOf(five.filter((a) => a.outcome === 'hired')), rejected: tallyOf(five.filter((a) => a.outcome === 'rejected')) }, ['QZS one']);
    expect(s5).toMatchObject({ shown: true, split: null, comments: ['QZS one'] });
    const ten = [...Array.from({ length: 5 }, () => answer()), ...Array.from({ length: 5 }, () => answer({ outcome: 'rejected', overall: 2 }))];
    const s10 = summarizeSurvey({ hired: tallyOf(ten.slice(0, 5)), rejected: tallyOf(ten.slice(5)) }, []);
    expect(s10.shown && s10.split?.hired.averages.overall).toBe(4);
    expect(s10.shown && s10.split?.rejected.averages.overall).toBe(2);
    expect(s10.shown && s10.all.averages.overall).toBe(3);
  });
  it('averages each rating over the answers that gave it, one decimal; shares of recommend among those who answered it', () => {
    const rows = [
      answer({ overall: 5, communication: 4, recommend: 'yes' }), answer({ overall: 4, communication: 5, recommend: 'yes' }),
      answer({ overall: 4, respect: 3, recommend: 'no' }), answer({ overall: 2 }), answer({ overall: 1, process: 2, recommend: 'unsure' }),
      answer({ overall: 5, communication: 3 }),
    ];
    const f = surveyFigures(tallyOf(rows));
    // overall (5+4+4+2+1+5)/6 = 3.5; communication (4+5+3)/3 = 4; respect 3; process 2.
    expect(f.averages).toEqual({ overall: 3.5, communication: 4, respect: 3, process: 2 });
    expect(f.overallDistribution).toEqual([1, 1, 0, 2, 2]);
    expect(f.recommend).toEqual({ answered: 4, yes: 0.5, no: 0.25, unsure: 0.25 });
    expect(surveyFigures(tallyOf([answer({ overall: 3 })])).recommend).toEqual({ answered: 0, yes: null, no: null, unsure: null });
    // 13/3 = 4.333… → 4.3
    expect(surveyFigures(tallyOf([answer({ overall: 4 }), answer({ overall: 4 }), answer({ overall: 5 })])).averages.overall).toBe(4.3);
  });
});

describe('the public path', () => {
  it('admits exactly /careers/s/<43 base64url characters> for GET, HEAD and POST', () => {
    const t = 'Ab_-'.repeat(10) + 'xyz';
    for (const m of ['GET', 'HEAD', 'POST']) expect(isCareersRoute(`/careers/s/${t}`, m)).toBe(true);
    for (const p of [`/careers/s/${t.slice(1)}`, `/careers/s/${t}A`, `/careers/s/${t}/`, '/careers/s', `/careers/S/${t}`]) expect(isCareersRoute(p, 'GET'), p).toBe(false);
    expect(isCareersRoute(`/careers/s/${t}`, 'DELETE')).toBe(false);
  });
});

describe('six languages', () => {
  const messages = (l: string) => JSON.parse(read(`messages/${l}.json`)) as Record<string, Record<string, Record<string, unknown>>>;
  const keys = (o: unknown, p = ''): string[] => (o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => keys(v, `${p}${k}.`)) : [p.slice(0, -1)]);
  it.each(['ms', 'zh', 'vi', 'ta', 'th'])('%s has every survey text English has', (l) => {
    const en = messages('en'), m = messages(l);
    expect(keys(m.careersPublic.survey).sort()).toEqual(keys(en.careersPublic.survey).sort());
    expect(keys(m.recruitment.reports.candidateSurvey).sort()).toEqual(keys(en.recruitment.reports.candidateSurvey).sort());
    expect(typeof m.recruitment.reports.survey).toBe('string');
    expect(m.recruitment.errors.email_survey_link).toBeTruthy();
    // ICU messages must not carry a literal {surveyLink} argument.
    expect(String(m.recruitment.errors.email_survey_link)).not.toContain('{');
  });
});

describe('5724 agrees with the model', () => {
  const flat = m5724.replace(/,\s+/g, ',').replace(/\s+/g, ' ');
  it('restates the allowlist with the survey and checks the frozen placeholder (12 characters) once in text and HTML', () => {
    expect(flat).toContain(`WHEN 'survey' THEN ARRAY[${CANDIDATE_EMAIL_PLACEHOLDERS.survey.map((p) => `'${p}'`).join(',')}]`);
    expect('{surveyLink}').toHaveLength(12);
    expect(m5724).toContain("char_length(n.body_text) - char_length(replace(n.body_text, '{surveyLink}', '')) <> 12");
    expect(m5724).toContain("char_length(n.body_html) - char_length(replace(n.body_html, '{surveyLink}', '')) <> 12");
    expect(m5724).toContain("strpos(n.subject, '{surveyLink}') > 0");
    expect(m5724).toContain('CHECK (survey_delay_days BETWEEN 1 AND 14)');
    expect(m5724).toContain("interval '17 days 1 minute'");
  });
  it('keeps every earlier refusal of the restated guard and check', () => {
    const m5723 = read('db/migrations/5723_recruitment_candidate_response_links.sql');
    for (const sentence of ["'A rejection e-mail is sent at most three days later'", "'A candidate e-mail is queued by the current user'", "'A queued candidate e-mail is immutable'",
      "'A purged candidate e-mail stays purged'", "'Only a failed or uncertain e-mail can be retried, by an administrator'",
      "CONSTRAINT = 'recruitment_candidate_email_response_link'", "CONSTRAINT = 'recruitment_candidate_email_reminder_time'",
      "CONSTRAINT = 'recruitment_candidate_email_interview'", "CONSTRAINT = 'recruitment_candidate_email_offer'",
      "CONSTRAINT = 'recruitment_candidate_email_recipient'", "CONSTRAINT = 'recruitment_candidate_email_settings'", "CONSTRAINT = 'recruitment_candidate_email_hourly_limit'"]) {
      expect(m5723, sentence).toContain(sentence);
      expect(m5724, sentence).toContain(sentence);
    }
  });
  it('grants the anonymous view and answer only; the sweep\'s issue, the prune and the live-link read stay owner-only', () => {
    for (const f of ['recruitment_survey_view(text)', 'recruitment_survey_answer(text, jsonb, text)']) {
      expect(m5724).toContain(`GRANT EXECUTE ON FUNCTION app.${f} TO ai_hr_app;`);
    }
    for (const f of ['recruitment_survey_issue(uuid, uuid, text)', 'recruitment_survey_prune()', 'recruitment_survey_live(text)']) {
      expect(m5724).toContain(`REVOKE ALL ON FUNCTION app.${f} FROM PUBLIC, ai_hr_app;`);
      expect(m5724).not.toContain(`GRANT EXECUTE ON FUNCTION app.${f}`);
    }
    // An answer row names no application, candidate, job, e-mail, link or time.
    const table = m5724.slice(m5724.indexOf('CREATE TABLE public.recruitment_candidate_survey_response'), m5724.indexOf('CREATE INDEX recruitment_candidate_survey_response_company_idx'));
    expect(table).not.toMatch(/application|candidate_id|job_id|email_id|token|_at\b|timestamptz/);
    // No domain event is written for an answer.
    const answerFn = m5724.slice(m5724.indexOf('CREATE FUNCTION app.recruitment_survey_answer'), m5724.indexOf('GRANT EXECUTE ON FUNCTION app.recruitment_survey_answer'));
    expect(answerFn).not.toContain('domain_event');
  });
});
