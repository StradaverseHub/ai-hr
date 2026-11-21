/**
 * Recruitment refusals travel in `?problem=<code>`, never `?error=` (rendering review of slice 10).
 *
 * The global ToastFromQuery (components/ui/toast-trigger.tsx) consumes every `?error=`: it shows the RAW code as a toast and
 * strips the parameter, which also wipes the page's ErrorBanner sentence. Recruitment therefore uses its own parameter,
 * produced by app/recruitment/actions.ts and read by every Recruitment page through recruitmentErrorText. The global toast is
 * unchanged for other modules. app/me/referrals reports refusals through form state, and the careers route handlers render
 * their HTML themselves (no app layout, no toast), so neither reads a query parameter for errors.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
});
const TREES = ['app/recruitment', 'app/me/referrals', 'app/careers'];
const files = TREES.flatMap((tree) => walk(join(root, tree))).map((path) => ({ rel: relative(root, path), source: readFileSync(path, 'utf8') }));
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

describe('Recruitment refusals use ?problem=, never the global toast\'s ?error=', () => {
  it('finds the files it guards (non-vacuous)', () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files.map((f) => f.rel)).toEqual(expect.arrayContaining(['app/recruitment/actions.ts', 'app/recruitment/shared.tsx', 'app/recruitment/candidates/page.tsx']));
  });

  it('no Recruitment, referral or careers file produces or reads an ?error= query parameter', () => {
    const offenders = files.filter((f) => {
      const c = code(f.source);
      return /[?&]error=/.test(c) || /withParam\([^)]*'error'/.test(c) || /\bsp\.error\b/.test(c) || /searchParams[^;]*\berror\?: string/.test(c)
        || /type Search = [^;]*\berror\?: string/.test(c) || /\.get\('error'\)/.test(c);
    }).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('every action redirect with a refusal uses the problem parameter', () => {
    const actions = code(files.find((f) => f.rel === 'app/recruitment/actions.ts')!.source);
    expect(actions).toMatch(/const PROBLEM_PARAM = 'problem';/);
    const refusals = actions.match(/redirect\([^;]*errorCode\(e\)[^;]*\);/g) ?? [];
    expect(refusals.length).toBeGreaterThanOrEqual(5);
    for (const r of refusals) expect(r, r).toMatch(/PROBLEM_PARAM/);
  });

  it('every page that shows a refusal from the URL reads sp.problem into recruitmentErrorText, and declares it', () => {
    // Reports passes a code it computes itself (a report over its time budget), not one from the URL.
    const pages = files.filter((f) => f.rel.endsWith('page.tsx') && /recruitmentErrorText\(sp\./.test(f.source));
    expect(pages.length).toBeGreaterThanOrEqual(15);
    expect(files.filter((f) => f.rel.endsWith('page.tsx') && f.source.includes('recruitmentErrorText(') && !/recruitmentErrorText\(sp\./.test(f.source))
      .map((f) => f.rel)).toEqual(['app/recruitment/reports/page.tsx']);
    for (const p of pages) {
      expect(p.source, p.rel).toMatch(/recruitmentErrorText\(sp\.problem\)/);
      expect(p.source, p.rel).toMatch(/problem\?: string/);
    }
  });

  it('the global toast keeps consuming ?error= and does not touch ?problem=', () => {
    const toast = readFileSync(join(root, 'components/ui/toast-trigger.tsx'), 'utf8');
    expect(toast).toContain("params.get('error')");
    expect(toast).not.toContain('problem');
  });
});

describe('rendering review of slice 10 — labels, not codes', () => {
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
  it('the application page names its source from the candidate-source vocabulary', () => {
    const page = read('app/recruitment/applications/[id]/page.tsx');
    for (const key of ['referral', 'career_page', 'agency']) expect(page).toContain(`t('cand.sources.${key}')`);
    expect(page).not.toMatch(/t\('(agency|referral|careers)\.source'\)/);
  });
  it('the agency submission page does not add a second colon after "Matches on:"', () => {
    const page = read('app/recruitment/agency-submissions/[id]/page.tsx');
    expect(page).not.toMatch(/tc\('dup\.matchedOn'\)\}:/);
    for (const locale of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const m = JSON.parse(read(`messages/${locale}.json`)) as { recruitment: { cand: { dup: { matchedOn: string } } } };
      expect(m.recruitment.cand.dup.matchedOn, locale).toMatch(/[:：]$/);
    }
  });
  it('My tasks gives the two agency kinds (and slice 11\'s screening and slice 12\'s background check kinds) their own action labels in every locale', () => {
    expect(read('app/tasks/tasks-view.tsx')).toMatch(/i\.kind==='recruitmentAgencyReview'\|\|i\.kind==='recruitmentContractExpiry'\|\|i\.kind==='recruitmentScreening'\|\|i\.kind==='recruitmentBackgroundCheckAuthorisation'\|\|i\.kind==='recruitmentBackgroundCheckOverdue'\?tAction\(i\.kind\)/);
    const en = JSON.parse(read('messages/en.json')) as { notifications: { taskAction: Record<string, string> } };
    expect(en.notifications.taskAction).toEqual({
      recruitmentAgencyReview: 'Review submission', recruitmentContractExpiry: 'Open contract', recruitmentScreening: 'Give feedback',
      recruitmentBackgroundCheckAuthorisation: 'Open check', recruitmentBackgroundCheckOverdue: 'Open check',
    });
    for (const locale of ['ms', 'ta', 'th', 'vi', 'zh']) {
      const m = JSON.parse(read(`messages/${locale}.json`)) as { notifications: { taskAction: Record<string, string> } };
      for (const kind of ['recruitmentAgencyReview', 'recruitmentContractExpiry', 'recruitmentScreening', 'recruitmentBackgroundCheckAuthorisation', 'recruitmentBackgroundCheckOverdue']) {
        expect(m.notifications.taskAction[kind], `${locale} ${kind}`).toBeTruthy();
        expect(m.notifications.taskAction[kind], `${locale} ${kind}`).not.toBe(en.notifications.taskAction[kind]);
      }
    }
  });
});
