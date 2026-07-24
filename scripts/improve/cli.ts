/**
 * Improvement-loop CLI (ADR-0044). The operator (a Claude Code session) drives the loop by piping JSON
 * between these subcommands and the planning/build steps:
 *
 *   pnpm improve:pull              → JSON array of feedback awaiting a plan (open/contested)
 *   pnpm improve:pull-approved     → JSON array of approved feedback (ready to build + release)
 *   echo '{"id","tenantId","reporterEmploymentId","plan","model"}' | pnpm improve:push-plan
 *   echo '{"id","tenantId","reporterEmploymentId","buildRef"}'     | pnpm improve:mark-deployed
 *
 * push-plan / mark-deployed read their argument as JSON on stdin (plans contain newlines/quotes).
 */
import { markBuildCompleted, markBuildStarted, markDeployed, pullApproved, pullPlannable, pushPlan, raiseFeedback } from './remote';
import { releaseBuiltItem } from './release';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'pull':
      process.stdout.write(JSON.stringify(pullPlannable(), null, 2) + '\n');
      break;
    case 'pull-approved':
      process.stdout.write(JSON.stringify(pullApproved(), null, 2) + '\n');
      break;
    case 'raise': {
      // Operator-raised feedback (status → open), e.g. a decision the pipeline surfaced that the reporter
      // must own. Reads {tenantId, reporterEmploymentId, reporterUserId?, category, title, description,
      // expectedBehavior?, expectedFunction?} as JSON on stdin.
      const p = JSON.parse(await readStdin());
      const { id } = raiseFeedback(p);
      console.log(`raised feedback ${id} (status → open)`);
      break;
    }
    case 'push-plan': {
      const p = JSON.parse(await readStdin());
      pushPlan(p);
      console.log(`pushed plan for ${p.id} (status → planned)`);
      break;
    }
    case 'build-start': {
      const p = JSON.parse(await readStdin());
      markBuildStarted(p);
      console.log(`build started for ${p.id} (status → building)`);
      break;
    }
    case 'build-complete': {
      const p = JSON.parse(await readStdin());
      markBuildCompleted(p);
      console.log(`build completed for ${p.id} (status → done, ref=${p.buildRef})`);
      break;
    }
    case 'release': {
      // HUMAN-GATED (ADR-0045): only run after a human has reviewed the preview + diff.
      const p = JSON.parse(await readStdin());
      await releaseBuiltItem(p);
      break;
    }
    case 'mark-deployed': {
      const p = JSON.parse(await readStdin());
      markDeployed(p);
      console.log(`marked ${p.id} deployed`);
      break;
    }
    default:
      console.error(
        'usage: improve <pull | pull-approved | push-plan | build-start | build-complete | release | mark-deployed>',
      );
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
