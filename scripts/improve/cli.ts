/**
 * Improvement-loop CLI (ADR-0044). The operator (a Claude Code session) drives the loop by piping JSON
 * between these subcommands and the planning/build steps:
 *
 *   pnpm improve:pull              → JSON array of feedback awaiting a plan (open/contested)
 *   pnpm improve:pull-approved     → JSON array of approved feedback (ready to build + release)
 *   pnpm improve:pull-blocked      → JSON array of approved-but-parked feedback (waiting on an answer)
 *
 * Every pulled item carries `block_trail` (0323): each time it was parked on a question, and what the
 * reporter answered. READ IT BEFORE BUILDING — an item that was blocked and released carries its answer
 * ONLY there. `blocked_reason` is cleared on unblock, so by the time the item reaches pull-approved the
 * question and its answer have left feedback_request entirely.
 *   echo '{"id","tenantId","reporterEmploymentId","plan","model","mockupPaths"?}' | pnpm improve:push-plan
 *   echo '{"id","tenantId","reporterEmploymentId","buildRef"}'     | pnpm improve:mark-deployed
 *
 * push-plan / mark-deployed read their argument as JSON on stdin (plans contain newlines/quotes).
 *
 * `mockupPaths` (0406) is a list of image files to show the reporter WITH the plan — the design of the
 * screen it proposes, before anything is built. Of 151 attachments on production, 143 are images: the
 * reporter communicates in pictures and until now every plan answered in prose. Render them with
 * `pnpm mockup <in.html> <out.png>`, and read scripts/mockup/README.md first — a mockup is a PROMISE, and
 * a picture cannot hedge the way a sentence can.
 */
import { basename, extname } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  boardStatus,
  markBlocked,
  markBuildCompleted,
  markBuildStarted,
  markDeployed,
  markUnblocked,
  pullApproved,
  pullBlocked,
  pullPlannable,
  pushPlanWithMockups,
  raiseFeedback,
} from './remote';
import { releaseBuiltItem } from './release';

/** Mime for the handful of image types a mockup is ever going to be. Explicit rather than a lookup
 *  dependency, and it THROWS on anything else: the board renders `plan` attachments inline as an <img>,
 *  so a mislabelled octet-stream would render as a broken image on the reporter's screen. */
function mimeOf(file: string): string {
  const byExt: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
  };
  const mime = byExt[extname(file).toLowerCase()];
  if (!mime) throw new Error(`mockup ${file}: only png/jpg/webp/gif/svg can be shown inline on the board`);
  return mime;
}

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
    case 'status': {
      // The whole board at a glance: one line per status. Ids are printed for the live statuses only;
      // the closed ones (deployed / rejected / cancelled) run to hundreds and their ids say nothing.
      const closed = new Set(['deployed', 'rejected', 'cancelled']);
      for (const row of boardStatus()) {
        const ids = closed.has(row.status) ? '' : row.ids.slice(0, 12).join(' ') + (row.ids.length > 12 ? ` +${row.ids.length - 12}` : '');
        process.stdout.write(`${row.status.padEnd(10)} ${String(row.count).padStart(4)}  ${ids}\n`);
      }
      break;
    }
    case 'pull-blocked':
      process.stdout.write(JSON.stringify(pullBlocked(), null, 2) + '\n');
      break;
    case 'block': {
      // Park an approved item on an unanswered question (status → blocked), so it stops surfacing in
      // pull-approved as buildable. Reads {id, tenantId, reporterEmploymentId, reason, blockedById?}.
      const p = JSON.parse(await readStdin());
      markBlocked(p);
      console.log(`blocked ${p.id} (status → blocked): ${p.reason}`);
      break;
    }
    case 'unblock': {
      // The question was answered — return it to the build queue. Reads {id, tenantId, reporterEmploymentId, note?}.
      const p = JSON.parse(await readStdin());
      markUnblocked(p);
      console.log(`unblocked ${p.id} (status → approved)`);
      break;
    }
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
      // 0406 — `mockupPaths: ["/abs/before.png", …]` attaches design images to the plan being pushed.
      // Read here rather than passed as base64 in the JSON: a plan payload is already large, and a file
      // path is what the caller actually has. Omit the key and this is byte-identical to before.
      const mockups = (p.mockupPaths ?? []).map((f: string) => ({
        fileName: basename(f),
        mimeType: mimeOf(f),
        content: readFileSync(f),
      }));
      pushPlanWithMockups({ ...p, mockups });
      console.log(
        `pushed plan for ${p.id} (status → planned)` +
          (mockups.length ? ` with ${mockups.length} mockup(s): ${mockups.map((m: { fileName: string }) => m.fileName).join(', ')}` : ''),
      );
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
        'usage: improve <pull | pull-approved | pull-blocked | raise | push-plan | block | unblock | build-start | build-complete | release | mark-deployed>',
      );
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
