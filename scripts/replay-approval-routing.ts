// APPROVAL-ROUTING REPLAY (feedback item a6fe37fc, Round 1) — the acceptance test for the Leave
// Configuration replacement, built BEFORE the thing it tests. Building it last would mean discovering a
// routing change after it had shipped.
//
// THE PROMISE THIS DISCHARGES, in the reporter's own terms: every one of the 261 approval rules must still
// reach the same approver, for the same real employee, before and after. So it does not compare the rules.
// IT COMPARES THE ANSWERS. A rule is only correct through the chain it produces for a real person, and
// comparing rows would pass a migration that rewrote two rules into one with the same routing — or, worse,
// fail one that was identical in effect. The grid is (routing subject × leave type × day probe), which is a
// SUPERSET of the rules: every rule that can win for anybody wins somewhere in it.
//
// ⚠️ IT CONNECTS TO THE PRODUCTION DATABASE ITSELF, NOT A COPY, AND THAT IS DELIBERATE. There is no
// rehearsal copy of this tenant's data, and a replay run against one would prove nothing about the rows
// that route real requests. What makes it safe is not the target but the SHAPE, and every part of the shape
// is load-bearing:
//   · READS ONLY — Postgres itself is told `SET TRANSACTION READ ONLY` before a single row is read, and
//     this script aborts the tenant if the database does not confirm it. It is not a promise in a comment.
//   · ONE TRANSACTION PER TENANT THAT ALWAYS ROLLS BACK — `replayApprovalRouting` leaves its transaction by
//     throwing, so there is no commit path for a later edit to hang a write on.
//   · THERE IS NO APPLY MODE, AND MUST NEVER BE ONE. scripts/convert-approval-rules.ts has one because it
//     converts; this one replays. Malformed options are REJECTED rather than guessed at — an unknown flag,
//     and a `--baseline`/`--verify` whose filename is missing, both exit 2 — so an operator who reaches for
//     a write flag out of habit gets an error instead of a surprise.
//   · A SHORT TRANSACTION. It issues a CONSTANT eight statements per tenant however large the grid is (the
//     rules are read once and the grid is resolved afterwards, in memory), so it does not hold a long
//     transaction open against the customer's database or pin its vacuum horizon.
// Tenants are enumerated through MIGRATION_DATABASE_URL exactly as convert-approval-rules.ts does; the
// resolution itself runs on the ordinary app connection, under RLS, so it sees exactly what a real leave
// request sees.
//
// HOW TO RUN IT ON THE SERVER — AND THE FORM MATTERS. `node --env-file=` EXITS 9 on that box: it is node
// v18.19.1 and the flag arrived in node 20 (AGENTS.md rule 21). 23 scripts in scripts/ document that broken
// invocation and not one of them works as written; this is not the 24th. SOURCE the env file instead, which
// also keeps the credentials on the box:
//
//   cd /opt/ai-hr && set -a && . ./.env.production && set +a && \
//     node --import tsx scripts/replay-approval-routing.ts --baseline docs/baselines/a6fe37fc-approval-baseline.json
//
// ⚠️ THE BASELINE PATH MUST BE INSIDE THE REPOSITORY, AND THAT IS NOT A STYLE PREFERENCE.
// r259 wrote it to /opt/ai-hr/approval-baseline.json — the server root — and the next deploy
// DELETED it: the deploy rsync carries --delete (AGENTS 8), so anything on the box that is not in
// the tree is removed. `--verify` then failed with "no such baseline file" on the very run that was
// meant to prove the deploy changed no approver. Under docs/baselines/ the file is version-controlled,
// travels with every deploy, and is tamper-evident — which is the whole point of a "before" picture.
//
//   cd /opt/ai-hr && set -a && . ./.env.production && set +a && \
//     node --import tsx scripts/replay-approval-routing.ts --verify docs/baselines/a6fe37fc-approval-baseline.json
//
//   cd /opt/ai-hr && set -a && . ./.env.production && set +a && \
//     node --import tsx scripts/replay-approval-routing.ts --coverage
//
// `--baseline <file>` writes the answers as they stand today — once, before Round 2, and the file is
// committed. `--verify <file>` re-resolves and reports every case whose chain moved (company · employment ·
// leave type · days · before → after, NAMED rather than counted so the operator can look the employee up)
// and exits 1 if there is one. `--coverage` additionally reports which rules ever WIN, because a replay
// over rules that never match proves nothing about them; it combines with either mode.
//
// A BASELINE CASE IS MATCHED BY ITS ROUTING TUPLE, NOT BY THE PERSON IT IS NAMED AFTER. The grid collapses
// employments to one representative per distinct set of routing attributes, and which colleague represents
// a tuple is arbitrary and changes with ordinary staff turnover. So the baseline stores each tuple's
// attributes — its identity — and a case counts as "no longer checked" only when NOTHING active is in that
// tuple. Keyed by the representative alone, a verify would report "every case still reaches the same
// approver" while the colleagues of a departed representative had had their approver moved.
//
// PROVING THE HARNESS CAN FAIL (migration order §2.4) IS DELIBERATELY NOT A MODE OF THIS SCRIPT. The
// injection §2.4 describes — blanking one targeted rule's leave_type_id, which this codebase reads as the
// company-wide wildcard rather than as a non-match — is a WRITE, and this script does not write. It lives
// in test/leave-approval-replay.test.ts against the seeded tenant and runs on every gate, so the claim
// "this comparison can fail" is re-proven continuously rather than once by hand.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createDb } from '../db/client';
import { company, leaveType, tenant } from '../db/schema';
// Through the pack FACADE, not the implementation module directly (ADR-0080 D9). Leave services have one
// front door and an operator script is as much a consumer as a screen is.
import {
  replayApprovalRouting,
  replayVerdictFails,
  verifyApprovalRouting,
  type ApprovalMatchAttrs,
  type ApprovalRoutingCoverage,
  type RoutingDifference,
} from '../packs/leave/service';

/** The committed baseline: one tenant's resolved answers, plus the grid they were resolved over. */
type BaselineTenant = {
  tenantId: string;
  tenantName: string;
  employmentsCovered: number;
  /** One entry per ROUTING TUPLE: the attributes that decide the answer (the tuple's identity, so a verify
   *  can still find the tuple after the employment named here has left), plus a representative to name it
   *  by. The attributes are never replayed — a verify resolves against today's org data. */
  subjects: { employmentId: string; companyId: string; attrs: ApprovalMatchAttrs }[];
  leaveTypeIds: string[];
  dayProbes: number[];
  /** `employmentId|leaveTypeId|days` → chain. */
  chains: Record<string, string>;
};

type BaselineFile = {
  kind: 'approval-routing-baseline';
  version: 2;
  capturedAt: string;
  tenants: BaselineTenant[];
};

const BASELINE_KIND = 'approval-routing-baseline';
/** Bumped from 1 in the a6fe37fc Round 1 fix pass: a version-1 baseline stored no tuple attributes, so a
 *  verify against one could not tell "this tuple's representative left, and her colleagues are still in it"
 *  from "this tuple is empty" — and reported a live employee's moved approver as `gone` rather than as a
 *  failure. Such a file cannot be verified safely and is refused rather than read on a best-effort basis. */
const BASELINE_VERSION = 2;
/** Differences are named, not counted — but a wall of 50,000 lines helps nobody either. */
const MAX_DIFFERENCES_PRINTED = 200;
const MAX_UNREACHED_RULES_PRINTED = 50;

const USAGE = [
  'usage: node --import tsx scripts/replay-approval-routing.ts [--baseline <file> | --verify <file>] [--coverage]',
  '',
  '  --baseline <file>  write the resolved approval routing as it stands now (refuses to overwrite)',
  '  --verify <file>    re-resolve and report every routing case whose chain moved; exits 1 if any did',
  '  --coverage         also report which rules ever win, and which never do',
  '',
  '  <file> is required where shown; a following option is not a filename.',
  '',
  '  There is no apply mode. This script only reads, inside a transaction that always rolls back.',
].join('\n');

type Parsed = {
  baselineOut: string | null;
  verifyIn: string | null;
  coverage: boolean;
  bad: string[];
  /** Options given without the filename they require. */
  needsValue: string[];
};

/** Unknown options are collected and REFUSED, never ignored: an operator reaching for a write flag must get
 *  an error, not silence.
 *
 *  So is a MISSING filename. `--baseline` used to take the next argv element whatever it was, so
 *  `--baseline --coverage` wrote a production baseline to a file literally named `--coverage` with the
 *  coverage report silently switched off — guessing at malformed input, which is the opposite of what this
 *  script advertises. A following option is not a filename; say so and exit. */
function parseArgs(argv: string[]): Parsed {
  const known = new Set(['--baseline', '--verify', '--coverage']);
  const out: Parsed = { baselineOut: null, verifyIn: null, coverage: false, bad: [], needsValue: [] };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const at = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = at >= 0 ? raw.slice(0, at) : raw;
    const inline = at >= 0 ? raw.slice(at + 1) : null;
    if (!known.has(flag)) {
      out.bad.push(raw);
      continue;
    }
    if (flag === '--coverage') {
      out.coverage = true;
      continue;
    }
    let value = inline;
    if (value === null) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i += 1;
      }
    }
    if (value === null || value === '') {
      out.needsValue.push(flag);
      continue;
    }
    if (flag === '--baseline') out.baselineOut = value;
    else out.verifyIn = value;
  }
  return out;
}

function describeDifference(d: RoutingDifference, companyName: (id: string) => string, typeName: (id: string) => string): string {
  return `${companyName(d.companyId)} · employment ${d.employmentId} · ${typeName(d.leaveTypeId)} · ${d.days}d: ${d.before} → ${d.after}`;
}

function printCoverage(
  cov: ApprovalRoutingCoverage,
  companyName: (id: string) => string,
  typeName: (id: string | null) => string,
): void {
  const reached = cov.rules.filter((r) => r.wins > 0);
  const unreached = cov.rules.filter((r) => r.wins === 0);
  console.log(
    `      coverage: ${cov.decisions} resolution(s) — ${cov.bySource.rule} won by a rule, ` +
      `${cov.bySource['tenant-default']} by the tenant-default template, ${cov.bySource.fallback} by the built-in chain`,
  );
  console.log(`      of ${cov.rules.length} active rule(s), ${reached.length} ever win and ${unreached.length} never do`);
  if (unreached.length) {
    console.log(
      '      A rule that never wins is unreachable TODAY — scoped to something no active employment has, or',
    );
    console.log(
      '      shadowed by a more specific rule. The replay proves it unchanged only in the sense that it',
    );
    console.log('      reached nobody before and reaches nobody now:');
    for (const r of unreached.slice(0, MAX_UNREACHED_RULES_PRINTED)) {
      console.log(
        `        · ${companyName(r.companyId)} / ${typeName(r.leaveTypeId)} — ${r.ruleName ?? '(unnamed rule)'} [${r.ruleId}]`,
      );
    }
    if (unreached.length > MAX_UNREACHED_RULES_PRINTED) {
      console.log(`        … and ${unreached.length - MAX_UNREACHED_RULES_PRINTED} more`);
    }
  }
}

async function main() {
  const { baselineOut, verifyIn, coverage, bad, needsValue } = parseArgs(process.argv.slice(2));
  if (bad.length) {
    console.error(`replay-approval-routing: unknown option(s): ${bad.join(' ')}`);
    console.error(USAGE);
    process.exit(2);
  }
  if (needsValue.length) {
    console.error(
      `replay-approval-routing: ${needsValue.join(' and ')} require(s) a filename, and a following option is ` +
        'not one. Malformed input is refused here, never guessed at.',
    );
    console.error(USAGE);
    process.exit(2);
  }
  if (baselineOut && verifyIn) {
    console.error('replay-approval-routing: --baseline and --verify are separate runs; pass one or the other.');
    process.exit(2);
  }
  if (!baselineOut && !verifyIn && !coverage) {
    console.error(USAGE);
    process.exit(2);
  }
  if (baselineOut && existsSync(baselineOut)) {
    console.error(
      `replay-approval-routing: refusing to overwrite ${baselineOut}. A baseline is the record the cutover ` +
        'is checked against — move the old one aside deliberately.',
    );
    process.exit(2);
  }

  let baseline: BaselineFile | null = null;
  if (verifyIn) {
    if (!existsSync(verifyIn)) {
      console.error(`replay-approval-routing: no such baseline file: ${verifyIn}`);
      process.exit(2);
    }
    const parsed = JSON.parse(readFileSync(verifyIn, 'utf8')) as BaselineFile;
    if (parsed?.kind !== BASELINE_KIND) {
      console.error(`replay-approval-routing: ${verifyIn} is not an approval-routing baseline.`);
      process.exit(2);
    }
    if (parsed.version !== BASELINE_VERSION) {
      // Refused, not read on a best-effort basis. A version-1 file has no tuple attributes, and a verify
      // that cannot identify a tuple cannot tell a live employee's moved approver from a departure.
      console.error(
        `replay-approval-routing: ${verifyIn} is a version-${String(parsed.version)} baseline; this script ` +
          `reads version ${BASELINE_VERSION}. Re-capture it with --baseline — an older baseline cannot be ` +
          'verified against, only guessed at.',
      );
      process.exit(2);
    }
    baseline = parsed;
    console.log(`replay-approval-routing — verifying against ${verifyIn} (captured ${baseline.capturedAt})`);
  }

  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('replay-approval-routing requires MIGRATION_DATABASE_URL (owner role) to enumerate tenants.');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);
  const tenants = await owner.db.select({ id: tenant.id, name: tenant.name }).from(tenant);
  console.log(
    `replay-approval-routing — ${tenants.length} tenant(s), mode=${baselineOut ? 'baseline' : verifyIn ? 'verify' : 'coverage'}` +
      `${coverage && (baselineOut || verifyIn) ? ' + coverage' : ''}. READ-ONLY; every transaction is rolled back.`,
  );

  const captured: BaselineTenant[] = [];
  let failures = 0;
  let changedTotal = 0;

  for (const t of tenants) {
    // Names for the report — a list of uuids is not something an operator can confirm against.
    const companies = await owner.db
      .select({ id: company.id, name: company.legalName })
      .from(company)
      .where(eq(company.tenantId, t.id));
    const types = await owner.db
      .select({ id: leaveType.id, code: leaveType.code })
      .from(leaveType)
      .where(eq(leaveType.tenantId, t.id));
    const companyName = (id: string) => companies.find((c) => c.id === id)?.name ?? (id || '(unknown company)');
    const typeName = (id: string | null) => (id === null ? 'every leave type' : (types.find((x) => x.id === id)?.code ?? id));

    const priorEntry = baseline?.tenants.find((x) => x.tenantId === t.id) ?? null;
    try {
      // SYSTEM context: hr_admin authorises the read, no userId ⇒ nothing is attributed to a person. It
      // carries NO `entitlementsExempt` marker, for the same reason convert-approval-rules.ts does not: the
      // marker makes every module read as enabled, and a replay passes through no entitlement gate at all.
      //
      // The baseline's grid is unioned in on a verify so the two snapshots line up key-for-key even when a
      // leave type or a day-range bound has been added since. It can only ADD cases to check.
      const replay = await replayApprovalRouting(
        { tenantId: t.id, roles: ['hr_admin'] },
        {
          extraLeaveTypeIds: priorEntry?.leaveTypeIds,
          extraDayProbes: priorEntry?.dayProbes,
          coverage,
        },
      );
      if (!replay.readOnlyEnforced) {
        // The safety property this script's whole case rests on did not hold. Say so and fail, rather than
        // print a reassuring result from a transaction that could have written.
        failures += 1;
        console.error(
          `  ✗ ${t.name}: the database did not confirm a READ ONLY transaction — refusing to report this tenant.`,
        );
        continue;
      }
      console.log(
        `  ${t.name}: ${replay.chains.size} routing case(s) — ${replay.subjects.length} distinct routing tuple(s) ` +
          `standing for ${replay.employmentsCovered} active employment(s), ${replay.leaveTypeIds.length} leave type(s), ` +
          `day probes [${replay.dayProbes.join(', ')}]`,
      );

      if (baselineOut) {
        captured.push({
          tenantId: t.id,
          tenantName: t.name,
          employmentsCovered: replay.employmentsCovered,
          // The tuple's ATTRIBUTES are stored, and they are the tuple's identity — not a chain to replay.
          // A verify still resolves against today's org data (an employee who changed department gets a
          // different chain tomorrow, and correctly so — migration order §2.5); what the attributes buy is
          // the ability to recognise the SAME tuple tomorrow when the employment named beside them has
          // left and a colleague represents it instead.
          subjects: replay.subjects.map((s) => ({
            employmentId: s.employmentId,
            companyId: s.companyId,
            attrs: s.attrs,
          })),
          leaveTypeIds: replay.leaveTypeIds,
          dayProbes: replay.dayProbes,
          chains: Object.fromEntries(replay.chains),
        });
      }

      if (verifyIn) {
        if (!priorEntry) {
          console.log('      no baseline entry for this tenant — it postdates the baseline; nothing to compare.');
        } else {
          // The judgement about what counts as a FAILURE lives in core (and runs on every gate), not here:
          // a chain that moved for a live employee breaks the promise; one belonging to somebody who has
          // since left does not.
          const verdict = verifyApprovalRouting(
            new Map(Object.entries(priorEntry.chains)),
            replay,
            priorEntry.subjects,
          );
          const { changed, gone, added, unmatched } = verdict;

          // The exit code is `replayVerdictFails`, which the gate asserts — not a condition written out
          // again here where nothing checks it. The ✓ is printed only when the verdict actually passes.
          if (replayVerdictFails(verdict)) {
            failures += 1;
            changedTotal += changed.length;
          }
          if (changed.length) {
            console.error(`  ✗ ${t.name}: ${changed.length} routing case(s) reach a DIFFERENT approver than the baseline:`);
            for (const d of changed.slice(0, MAX_DIFFERENCES_PRINTED)) {
              console.error(`      ${describeDifference(d, companyName, (id) => typeName(id))}`);
            }
            if (changed.length > MAX_DIFFERENCES_PRINTED) {
              console.error(`      … and ${changed.length - MAX_DIFFERENCES_PRINTED} more`);
            }
          }
          if (unmatched.length) {
            console.error(
              `  ✗ ${t.name}: ${unmatched.length} baseline case(s) name an employment the baseline's own ` +
                'subject list does not contain, so they could not be checked at all. The baseline file is ' +
                'truncated or hand-edited; re-capture it.',
            );
          }
          if (!replayVerdictFails(verdict)) {
            console.log(`      ✓ every baseline routing case still reaches the same approver.`);
          }
          if (gone.length) {
            const employments = new Set(gone.map((d) => d.employmentId));
            console.log(
              `      ${employments.size} baseline routing tuple(s) have no active employment left in them ` +
                `(${gone.length} case(s) not compared — nobody is routed by them). Represented at baseline by: ` +
                `${[...employments].slice(0, 10).join(', ')}${employments.size > 10 ? ' …' : ''}`,
            );
          }
          if (added) console.log(`      ${added} routing case(s) are new since the baseline (a new employment or leave type).`);
        }
      }

      if (replay.coverage) printCoverage(replay.coverage, companyName, typeName);
    } catch (e) {
      failures += 1;
      console.error(`  ✗ ${t.name}: ${(e as Error).message}`);
    }
  }

  // A tenant that is in the baseline but no longer in the database would otherwise be skipped in silence —
  // the loop above walks the LIVE tenants. A whole tenant's proof going missing is exactly the kind of
  // absence a cutover gate must shout about rather than pass over.
  if (baseline) {
    const live = new Set(tenants.map((t) => t.id));
    for (const b of baseline.tenants) {
      if (live.has(b.tenantId)) continue;
      failures += 1;
      console.error(
        `  ✗ ${b.tenantName} (${b.tenantId}) is in the baseline but not in the database — ` +
          `${Object.keys(b.chains).length} routing case(s) were NOT verified.`,
      );
    }
  }

  if (baselineOut && failures === 0) {
    const file: BaselineFile = {
      kind: BASELINE_KIND,
      version: BASELINE_VERSION,
      capturedAt: new Date().toISOString(),
      tenants: captured,
    };
    writeFileSync(baselineOut, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    console.log(`baseline written to ${baselineOut} — ${captured.length} tenant(s). Commit it: it is what the cutover is checked against.`);
  } else if (baselineOut) {
    console.error('baseline NOT written — a tenant failed to replay, and a partial baseline is worse than none.');
  }

  console.log(
    `replay-approval-routing done — ${failures} failure(s)` +
      `${verifyIn ? `, ${changedTotal} routing case(s) changed` : ''}. Nothing was written to the database.`,
  );
  await owner.client.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
