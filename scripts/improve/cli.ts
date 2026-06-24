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
import { markDeployed, pullApproved, pullPlannable, pushPlan } from './remote';

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
    case 'push-plan': {
      const p = JSON.parse(await readStdin());
      pushPlan(p);
      console.log(`pushed plan for ${p.id} (status → planned)`);
      break;
    }
    case 'mark-deployed': {
      const p = JSON.parse(await readStdin());
      markDeployed(p);
      console.log(`marked ${p.id} deployed`);
      break;
    }
    default:
      console.error('usage: improve <pull | pull-approved | push-plan | mark-deployed>');
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
