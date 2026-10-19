/**
 * The release's CI check: ship only a commit that GitHub Actions' `gate` workflow passed (CLAUDE.md §4).
 *
 * The workflow tests a ready pull request's own head commit, and main only moves by `--ff-only`, so the
 * commit being released is the commit CI ran. A green run for any other commit — the PR's synthetic merge,
 * an earlier push, a branch with the same tree — does not count.
 *
 * One override exists, for a GitHub outage: AIHR_RELEASE_WITHOUT_CI=github-outage, which falls back to the
 * local gate receipt and says so loudly. Nothing else skips the check.
 */
import { execFileSync } from 'node:child_process';

export const CI_WORKFLOW = 'gate';
export const CI_OVERRIDE = 'github-outage';

export type CiRun = {
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  event: string;
  /** Conclusion of the run's `verify` job; a run whose jobs were all skipped (a draft PR) has none. */
  verify?: string | null;
};

export type CiDecision = { ok: boolean; lines: string[] };

const HOW = [
  '  To get a CI run: push the branch and mark its pull request ready for review',
  '  (draft PRs run nothing). The gate workflow re-runs on every push to a ready PR.',
];

export function decideCiGate(p: { head: string; runs: CiRun[] | null; error?: string }): CiDecision {
  const short = p.head.slice(0, 7);
  if (!p.runs) {
    return { ok: false, lines: [`✗ REFUSED: could not read CI runs for ${short} (${p.error ?? 'unknown error'}).`, ...HOW] };
  }
  const mine = p.runs.filter((r) => r.name === CI_WORKFLOW && r.head_sha === p.head);
  // `verify` is the job that checks every shard ran and every job passed. A run can report success with
  // all its jobs skipped (a draft PR), so the run's own conclusion is not enough.
  const green = mine.find((r) => r.status === 'completed' && r.conclusion === 'success' && r.verify === 'success');
  if (green) return { ok: true, lines: [`→ CI: ${CI_WORKFLOW} passed for HEAD ${short} (${green.html_url})`] };
  if (!mine.length) return { ok: false, lines: [`✗ REFUSED: no ${CI_WORKFLOW} run for HEAD ${short}.`, ...HOW] };
  return {
    ok: false,
    lines: [
      `✗ REFUSED: no green ${CI_WORKFLOW} run for HEAD ${short}:`,
      ...mine.map((r) => `    ${r.status}${r.conclusion ? '/' + r.conclusion : ''}  verify=${r.verify ?? 'none'}  ${r.event}  ${r.html_url}`),
      '  Fix the failing checks and push again, or wait for a run still in progress.',
    ],
  };
}

/** owner/name of the `origin` remote, e.g. zenlam/ai-hr. */
export function originSlug(cwd: string): string {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8' }).trim();
  const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`origin is not a GitHub remote: ${url}`);
  return m[1]!;
}

export function fetchCiRuns(head: string, cwd: string): CiRun[] {
  const slug = originSlug(cwd);
  const gh = (path: string, jq: string) =>
    execFileSync('gh', ['api', path, '--jq', jq], { cwd, encoding: 'utf8', timeout: 30_000 });
  const runs = JSON.parse(gh(`repos/${slug}/actions/runs?head_sha=${head}&per_page=100`, '.workflow_runs')) as
    (CiRun & { id: number })[];
  for (const r of runs) {
    if (r.name !== CI_WORKFLOW || r.head_sha !== head || r.conclusion !== 'success') continue;
    const verify = gh(`repos/${slug}/actions/runs/${r.id}/jobs?per_page=100`,
      '[.jobs[] | select(.name=="verify") | .conclusion][0]').trim();
    r.verify = verify === 'null' || verify === '' ? null : verify;
  }
  return runs;
}

/** The release's CI verdict for HEAD; `override` is the value of AIHR_RELEASE_WITHOUT_CI. */
export function ciGate(p: { head: string; cwd: string; override?: string; fetch?: typeof fetchCiRuns }):
  CiDecision & { overridden: boolean } {
  if (p.override !== undefined && p.override !== '') {
    if (p.override !== CI_OVERRIDE) {
      return {
        ok: false,
        overridden: false,
        lines: [`✗ REFUSED: AIHR_RELEASE_WITHOUT_CI must be exactly '${CI_OVERRIDE}' (got '${p.override}').`],
      };
    }
    return {
      ok: true,
      overridden: true,
      lines: [
        '⚠ CI CHECK OVERRIDDEN (AIHR_RELEASE_WITHOUT_CI=github-outage): shipping on the local gate receipt.',
        '  Use this only while GitHub Actions is down, and record it in the round entry.',
      ],
    };
  }
  let runs: CiRun[] | null = null;
  let error: string | undefined;
  try {
    runs = (p.fetch ?? fetchCiRuns)(p.head, p.cwd);
  } catch (e) {
    error = e instanceof Error ? e.message.split('\n')[0] : String(e);
  }
  return { ...decideCiGate({ head: p.head, runs, error }), overridden: false };
}
