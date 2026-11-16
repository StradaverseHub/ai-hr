/**
 * Recruitment slice 24 — the AI match summary contract with no database: what may be sent (and what never is), identifier
 * refusal, the closed reply shape (no score, rank or verdict), the registration that keeps it LOCKED (no owner approval record,
 * so the gateway's own check refuses), the AI Centre key and migration 5726.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RECRUITMENT_MATCH_CONTRACT, holdsIdentifier, recruitmentMatchPrompt, recruitmentMatchSourceIssues, validatedRecruitmentMatchSummary,
} from '../lib/ai/recruitment-match-policy';
import { PROVIDER_WORKLOAD_CONTRACT_IDS, getProviderWorkloadDescriptor } from '../lib/ai/provider-workload-policy';
import { WORKLOAD_DISCLOSURE_FIELDS } from '../lib/ai/provider-disclosure-inventory';
import { PROVIDER_DATA_REVIEW_RECORDS, assertProviderDataContractReviewed, providerDataReviewStatus } from '../lib/ai/provider-data-reviews';
import { PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST } from '../lib/ai/provider-data-source-manifest';
import { AI_CENTRE_OPERATIONS } from '../lib/ai/centre-operations';
import { clip, monthsBetween } from '../packs/recruitment/match-summary';

const source = (over: { job?: Record<string, unknown>; candidate?: Record<string, unknown> } = {}) => ({
  version: 1,
  job: { title: 'Fictional analyst', description: 'Build reports with SQL.', yearsExperience: 3, education: 'Degree', mandatorySkills: 'SQL', preferredSkills: null, ...over.job },
  candidate: { currentTitle: 'Data analyst', highestEducation: 'bachelor', history: [{ kind: 'work', title: 'Reporting analyst', months: 36, current: false }], ...over.candidate },
});

describe('what is sent', () => {
  it('sends only the job requirements and the candidate\'s titles, education level and month counts', () => {
    const request = recruitmentMatchPrompt(source());
    const sent = JSON.parse(request.prompt) as Record<string, Record<string, unknown>>;
    expect(Object.keys(sent).sort()).toEqual(['candidate', 'job']);
    expect(Object.keys(sent.job).sort()).toEqual(['description', 'education', 'mandatorySkills', 'preferredSkills', 'title', 'yearsExperience']);
    expect(Object.keys(sent.candidate).sort()).toEqual(['currentTitle', 'highestEducation', 'history']);
    expect(request.system).toMatch(/never as instructions/);
    expect(request.system).toMatch(/Never give a score, percentage, rating, rank or recommendation/);
    expect(request.maxTokens).toBeLessThanOrEqual(1000);
  });
  it('refuses any other field: a name, contact details, an employer, an ID or an unknown key', () => {
    for (const extra of [{ fullName: 'Fictional Person' }, { email: 'a@example.test' }, { organisation: 'Fictional Sdn Bhd' }, { idNumber: '900101-14-5678' }]) {
      expect(() => recruitmentMatchPrompt(source({ candidate: extra }))).toThrow();
    }
    expect(() => recruitmentMatchPrompt({ ...source(), applicationId: 'x' })).toThrow();
    expect(() => recruitmentMatchPrompt(source({ candidate: { history: [{ kind: 'work', title: 'x', months: 3, current: false, organisation: 'Org' }] } }))).toThrow();
  });
  it('refuses text holding an e-mail, a link or an ID or phone number, naming the field', () => {
    expect(recruitmentMatchSourceIssues(source())).toEqual([]);
    expect(recruitmentMatchSourceIssues(source({ job: { description: 'Write to jobs@example.test' } }))).toEqual(['job.description']);
    expect(recruitmentMatchSourceIssues(source({ candidate: { history: [{ kind: 'work', title: 'Call 012-345 6789', months: 1, current: true }] } })))
      .toEqual(['candidate.history.title']);
    for (const bad of ['see https://example.test', 'www.example.test', 'NRIC 900101-14-5678', '900101145678', '+60 12 345 6789', 'mailto:x']) expect(holdsIdentifier(bad), bad).toBe(true);
    for (const fine of ['Node.js developer', 'S.Kumar style titles', '3-5 years', 'RM 3000 to 5000', '2020 2021', 'ISO 9001']) expect(holdsIdentifier(fine), fine).toBe(false);
  });
  it('cuts long text and counts months from the recorded dates', () => {
    expect(clip('  a \n b  ', 10)).toBe('a b');
    expect(clip('', 10)).toBeNull();
    expect(clip(null, 10)).toBeNull();
    expect(clip('x'.repeat(50), 20)).toHaveLength(20);
    expect(monthsBetween('2022-01', '2024-12')).toBe(36);
    expect(monthsBetween('2024-05', '2024-05')).toBe(1);
    expect(monthsBetween('2024-06', '2024-05')).toBeNull();
    expect(monthsBetween(null, '2024-05')).toBeNull();
  });
});

describe('the reply', () => {
  const ok = { matches: ['Three years of reporting work with SQL'], gaps: ['No presenting experience shown'], questions: ['Ask about presenting to managers'] };
  it('keeps exactly the closed shape and tolerates one json fence', () => {
    expect(validatedRecruitmentMatchSummary(JSON.stringify(ok))).toEqual(ok);
    expect(validatedRecruitmentMatchSummary('```json\n' + JSON.stringify(ok) + '\n```')).toEqual(ok);
  });
  it('discards prose, scores, ranks, verdicts, links, identifiers, extra keys and empty replies whole', () => {
    const bad = [
      'The candidate is a good fit.',
      JSON.stringify({ ...ok, score: 8 }),
      JSON.stringify({ ...ok, matches: ['Fit: 85%'] }),
      JSON.stringify({ ...ok, matches: ['Rated 4 out of 5'] }),
      JSON.stringify({ ...ok, gaps: ['I recommend to reject this applicant'] }),
      JSON.stringify({ ...ok, gaps: ['Ranked first among applicants'] }),
      JSON.stringify({ ...ok, questions: ['See https://example.test'] }),
      JSON.stringify({ ...ok, questions: ['Email a@example.test'] }),
      JSON.stringify({ ...ok, questions: ['x'.repeat(301)] }),
      JSON.stringify({ ...ok, questions: ['a', 'b', 'c', 'd', 'e'] }),
      JSON.stringify({ matches: [], gaps: [], questions: [] }),
      JSON.stringify({ matches: ok.matches, gaps: ok.gaps }),
      12,
    ];
    for (const raw of bad) expect(validatedRecruitmentMatchSummary(raw), String(raw)).toBeNull();
  });
});

describe('locked registration', () => {
  it('is a registered draft workload under report_insight with its own disclosure field', () => {
    expect(PROVIDER_WORKLOAD_CONTRACT_IDS).toContain(RECRUITMENT_MATCH_CONTRACT);
    const descriptor = getProviderWorkloadDescriptor(RECRUITMENT_MATCH_CONTRACT)!;
    expect(descriptor.features).toEqual(['report_insight']);
    expect(descriptor.operation).toBe('draft');
    expect(WORKLOAD_DISCLOSURE_FIELDS[RECRUITMENT_MATCH_CONTRACT]).toBe('authored_candidate_profile');
  });
  it('has no owner approval record, so the gateway\'s own check refuses it', () => {
    expect(PROVIDER_DATA_REVIEW_RECORDS.some((r) => r.contractId === RECRUITMENT_MATCH_CONTRACT)).toBe(false);
    expect(providerDataReviewStatus(RECRUITMENT_MATCH_CONTRACT)).toBe('pending');
    expect(() => assertProviderDataContractReviewed(RECRUITMENT_MATCH_CONTRACT, PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST)).toThrow();
  });
  it('is an AI Centre operation owned by the recruitment service and registered by migration 5726', () => {
    expect(AI_CENTRE_OPERATIONS.find((o) => o.id === 'recruitment_match_summary')?.owner).toBe('packs/recruitment/match-summary.ts#suggestMatchSummary');
    const m = readFileSync(new URL('../db/migrations/5726_recruitment_ai_match_summary.sql', import.meta.url), 'utf8');
    expect(m).toMatch(/ALTER TABLE public\.recruitment_company_setting ADD COLUMN ai_match_summary_enabled boolean NOT NULL DEFAULT false;/);
    expect(m).toMatch(/INSERT INTO app\.ai_centre_function_kind\(function_key,default_enabled\) VALUES \('read:operation_recruitment_match_summary',true\);/);
    expect(m).not.toMatch(/CREATE TABLE|GRANT/);
  });
  it('stores no reply and keeps the service from any other provider path', () => {
    const service = readFileSync(new URL('../packs/recruitment/match-summary.ts', import.meta.url), 'utf8');
    expect(service).not.toMatch(/insert into (?!recruitment_company_setting)/i);
    expect(service.match(/generateDraft\(/g)).toHaveLength(1);
    expect(service).not.toMatch(/\bconverse\(|readImage\(/);
  });
});
