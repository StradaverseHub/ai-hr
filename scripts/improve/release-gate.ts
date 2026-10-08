/**
 * r417 (ADR-0094) — MAY THIS HEAD SHIP? The release's test-gate decision, as a pure function.
 *
 * Until r417 a missing or stale `.gate-receipt.json` made release.ts fall through to a bare
 * `pnpm vitest run` — the one command this machine cannot take (CLAUDE.md §4: it writes more WAL than
 * the RAM disk holds and dies with ~2,700 environment failures). Now the release NEVER runs the suite. It
 * ships only what a gate already covered:
 *
 *   • no receipt, an unreadable one, a non-PASS one, or one for another sha → REFUSE, and say which gate
 *     to run;
 *   • tier "full" (or a receipt from before tiers existed, which was always the full gate) → ship;
 *   • tier "affected" → re-judge the diff from the commit PRODUCTION RUNS to HEAD with the same
 *     classifier the gate used (scripts/gate-tier.ts). The gate judged BASE...HEAD for whatever BASE it
 *     was given; if production has moved, or the gate was pointed at the wrong base, or the receipt was
 *     hand-edited, the deployed→HEAD diff is what will actually change on the box, so that is the diff that
 *     must be presentational. If it now says FULL, or the deployed ref cannot be read, REFUSE.
 */
import type { TierVerdict } from '../gate-tier';

export interface GateReceipt {
  sha?: string;
  result?: string;
  tier?: string;
  base?: string;
}

export type DeployedVerdict = { deployedRef: string; verdict: TierVerdict } | { error: string };

export type ReleaseGateDecision =
  | { ok: true; tier: 'full' | 'affected'; lines: string[] }
  | { ok: false; lines: string[] };

const RUN_THE_GATE = [
  '  Run the gate in the worktree first (CLAUDE.md §4), then release again:',
  '    presentational-only diff:  bash scripts/gate-affected.sh > /tmp/aihr-gate-affected.log 2>&1',
  '    anything else:             CHUNKS=6 bash scripts/gate-chunked.sh > /tmp/aihr-gate/run.log 2>&1',
  '  release no longer runs the suite itself: a bare `pnpm vitest run` is the command this machine cannot take.',
];

export function decideReleaseGate(p: {
  receipt: GateReceipt | null;
  /** Why the receipt could not be read, when it could not. */
  receiptError?: string;
  head: string;
  /** Called only for an affected-tier receipt. */
  deployedVerdict: () => DeployedVerdict;
}): ReleaseGateDecision {
  const short = (s: string) => s.slice(0, 7);
  const r = p.receipt;
  if (!r) {
    return { ok: false, lines: [`✗ REFUSED: no usable .gate-receipt.json (${p.receiptError ?? 'missing'}).`, ...RUN_THE_GATE] };
  }
  if (r.result !== 'PASS') {
    return { ok: false, lines: [`✗ REFUSED: the gate receipt says result=${r.result ?? '(none)'}, not PASS.`, ...RUN_THE_GATE] };
  }
  if (!r.sha || r.sha !== p.head) {
    return {
      ok: false,
      lines: [`✗ REFUSED: the receipt is for ${r.sha ? short(r.sha) : '(no sha)'}, HEAD is ${short(p.head)} — stale.`, ...RUN_THE_GATE],
    };
  }
  if (r.tier === undefined || r.tier === 'full') {
    return {
      ok: true,
      tier: 'full',
      lines: [
        `→ final gate: tier=full covers HEAD ${short(p.head)}${r.tier === undefined ? ' (receipt predates tiers: the full gate)' : ''}`,
      ],
    };
  }
  if (r.tier !== 'affected') {
    return { ok: false, lines: [`✗ REFUSED: unknown gate tier '${r.tier}' in the receipt.`, ...RUN_THE_GATE] };
  }

  const d = p.deployedVerdict();
  if ('error' in d) {
    return {
      ok: false,
      lines: [
        `✗ REFUSED: tier=affected covers ${short(p.head)}, but the diff from the DEPLOYED commit could not be re-judged:`,
        `  ${d.error}`,
        '  An affected-tier receipt ships only once the deployed→HEAD diff is proven presentational. Run the full gate,',
        '  or fix the reason above and release again.',
      ],
    };
  }
  if (d.verdict.tier !== 'affected') {
    return {
      ok: false,
      lines: [
        `✗ REFUSED: tier=affected covers ${short(p.head)} (gated against ${r.base ? short(r.base) : '?'}), but the diff from the`,
        `  DEPLOYED commit ${short(d.deployedRef)} to HEAD now needs the FULL gate:`,
        ...d.verdict.reasons.map((x) => `    ✗ ${x}`),
        '  Run the full gate: CHUNKS=6 bash scripts/gate-chunked.sh > /tmp/aihr-gate/run.log 2>&1',
      ],
    };
  }
  return {
    ok: true,
    tier: 'affected',
    lines: [
      `→ final gate: tier=affected covers HEAD ${short(p.head)}; the deployed→HEAD diff (${short(d.deployedRef)}..${short(p.head)}, ` +
        `${d.verdict.files.length} file(s)) re-judged presentational-only`,
    ],
  };
}
