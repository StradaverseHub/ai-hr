/** ADR-0176 decision 1: builder/integrator focused-test selection from the deterministic impact selector
 * (ADR-0114, scripts/gate-impact.ts) instead of hand-picked unions. Advisory: it selects and prints; it
 * issues no receipt, and the full release gate is still required.
 *
 *   node --import tsx scripts/release/select-focused.ts [--base origin/main] [--json]
 *        [--dispatch CANDIDATE_BRANCH] [--typecheck] [--build]
 *
 * The selection is the impact plan's `run` set (changed tests, transitive import consumers, source readers,
 * the mandatory guard and tenant/access invariants, prior failures) plus RELEASE_PROVEN_GUARDS, split into
 * canonical chunks of at most 64 files for .github/workflows/alpha-focused-checks.yml.
 *
 * --dispatch prints nothing new to decide: it pushes one CI-only ref per chunk at the SAME commit
 * (CANDIDATE_BRANCH-sel<N>), because the focused workflow keeps one pending run per candidate_ref, and
 * dispatches each chunk from main's controller. Without it, the exact commands are printed. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { collectChanges } from '../gate-tier-git';
import { planImpact } from '../gate-impact';
import { sourceFiles } from '../gate-impact-git';
import { failureHistory } from '../gate-learning';

export const CHUNK = 64;
/** Whole-repository guards that failed full gates on 2–4 November 2026 although focused unions passed, and
 * that the impact selector does not already force. Promote to ALWAYS_RUN after a validated selector change. */
export const RELEASE_PROVEN_GUARDS = [
  'test/company-referrers.test.ts',
  'test/definition-of-done-registry.test.ts',
  'test/agent-capability-inventory.test.ts',
  'test/rule-version-migration-upgrade.test.ts',
  'test/setup-copilot-destinations.test.ts',
  'test/ai-centre.test.ts',
  'test/provider-data-review-gate.test.ts',
  'test/teras-harness-units.test.ts',
] as const;

export function chunk(files: string[], size = CHUNK): string[][] {
  const sorted = [...new Set(files)].sort(), out: string[][] = [];
  for (let i = 0; i < sorted.length; i += size) out.push(sorted.slice(i, i + size));
  return out;
}

export function selection(run: string[], exists: (path: string) => boolean = existsSync) {
  const extra = RELEASE_PROVEN_GUARDS.filter((p) => exists(p) && !run.includes(p));
  const missing = RELEASE_PROVEN_GUARDS.filter((p) => !exists(p));
  return { files: [...new Set([...run, ...extra])].sort(), extra, missing };
}

function main() {
  const args = process.argv.slice(2), option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const base = option('--base') ?? 'origin/main', dispatch = option('--dispatch');
  const git = (a: string[]) => execFileSync('git', a, { encoding: 'utf8' }).trim();
  const sha = git(['rev-parse', 'HEAD']);
  if (git(['status', '--porcelain'])) console.error('WARNING: uncommitted changes are not part of the committed diff the workflow will test.');
  let history: ReturnType<typeof failureHistory> = [];
  try { history = failureHistory(); } catch { /* no local learning store: selection stays conservative */ }
  const plan = planImpact(collectChanges(base, 'HEAD'), sourceFiles(), history);
  const picked = selection(plan.run), chunks = chunk(picked.files);
  const report = { kind: 'FOCUSED_SELECTION_NOT_EVIDENCE', sha, base, tier: plan.tier, risk: plan.risk, reasons: plan.reasons, browser: plan.browser, files: picked.files.length, extra: picked.extra, missingGuards: picked.missing, chunks };
  if (args.includes('--json')) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); return; }
  console.log(`Impact selection for ${sha.slice(0, 12)} against ${base}: tier=${plan.tier} risk=${plan.risk}; ${picked.files.length} files in ${chunks.length} chunk(s) of ≤${CHUNK}`);
  for (const r of plan.reasons.slice(0, 20)) console.log('  full-verification reason: ' + r);
  if (plan.tier === 'full') console.log('  The selector requires FULL verification for this diff: focused chunks are development evidence only; plan a full gate.');
  if (plan.browser) console.log('  Interface files changed: browser tests (*.browser.test.tsx) are not dispatchable here; they run in the full gate or alpha-staging-browser-checks.');
  if (picked.missing.length) console.log('  Release-proven guards not present in this tree: ' + picked.missing.join(', '));
  const commands = chunks.map((files, i) => {
    const ref = `${dispatch ?? 'CANDIDATE_BRANCH'}-sel${i + 1}`;
    const flags = ['-f', `candidate_ref=${ref}`, '-f', `expected_sha=${sha}`, '-f', `selected_tests=${JSON.stringify(files)}`];
    if (i === 0 && args.includes('--typecheck')) flags.push('-f', 'run_typecheck=true');
    if (i === 0 && args.includes('--build')) flags.push('-f', 'run_build=true');
    return { ref, flags };
  });
  for (const { ref, flags } of commands) {
    if (!dispatch) { console.log(`git push origin ${sha}:refs/heads/${ref}\ngh workflow run alpha-focused-checks.yml --ref main ${flags.map((f) => (f === '-f' ? f : `'${f}'`)).join(' ')}`); continue; }
    execFileSync('git', ['push', '-q', 'origin', `${sha}:refs/heads/${ref}`], { stdio: 'inherit' });
    execFileSync('gh', ['workflow', 'run', 'alpha-focused-checks.yml', '--ref', 'main', ...flags], { stdio: 'inherit' });
    console.log(`dispatched ${ref}`);
  }
}

if (process.argv[1] && /select-focused\.ts$/.test(process.argv[1])) main();
