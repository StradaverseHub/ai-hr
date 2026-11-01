/** Step 5c — the model comparison report (ADR-0170 §3.12 Harness row, §11.3 change 4).
 *
 *   node --import tsx scripts/teras/compare-models.ts CURRENT CANDIDATE [--out .improve/teras/compare.json]
 *
 * CURRENT and CANDIDATE are probe outputs from test/assistant-model-ceiling.eval.test.ts: a GitHub Actions job
 * log (gh api repos/OWNER/REPO/actions/jobs/JOB/logs), a file holding the AIHR_ASSISTANT_MODEL_CEILING line, or
 * that line's JSON. A job log also gives the probe's wall time. Prints the plain-text report; --out writes the
 * JSON report as a local file (scripts/teras/output.ts). Reads files only: it fetches nothing, switches no
 * model and changes no spec. Exits 0 whatever it recommends; a person decides. */
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {compareRuns,renderComparison,type ProbeOutput,type ProbeRun} from '../../core/improvement/compare';
import {writeLocalOutput} from './output';

const MARKER='AIHR_ASSISTANT_MODEL_CEILING ';
/** One probe output from a log, a marker line or bare JSON. */
export function parseProbe(text:string,label:string):ProbeRun{
 const line=text.split('\n').find(row=>row.includes(MARKER));
 const json=line?line.slice(line.indexOf(MARKER)+MARKER.length):text.trim();
 const output=JSON.parse(json) as ProbeOutput;
 if(!output?.stability?.behaviour?.reviewedIdeals||!Array.isArray(output.ledger))throw Error(label+' is not a probe output.');
 // Vitest's per-test line: "✓ runs every corpus … 1038710ms" (colour codes stripped).
 const plain=text.replace(/\u001b\[[0-9;]*m/g,''),timed=/runs every corpus[^\n]*?(\d+)ms/.exec(plain);
 return{label,output,wallSeconds:timed?Math.round(Number(timed[1])/1000):null};
}

function main(argv:readonly string[]){
 const files=argv.filter(arg=>!arg.startsWith('--')),out=argv.includes('--out')?argv[argv.indexOf('--out')+1]:null;
 const positional=files.filter(file=>file!==out);
 if(positional.length!==2){console.error('usage: compare-models.ts CURRENT CANDIDATE [--out .improve/teras/compare.json]');process.exit(2);}
 const [current,candidate]=positional.map(file=>parseProbe(readFileSync(file,'utf8'),basename(file).replace(/\.(log|line|json|txt)$/,'')));
 const report=compareRuns(current,candidate);
 process.stdout.write(renderComparison(report)+'\n');
 if(out)console.error('wrote '+writeLocalOutput(out,JSON.stringify(report,null,1)));
}
if(process.argv[1]&&import.meta.url.endsWith(basename(process.argv[1])))main(process.argv.slice(2));
