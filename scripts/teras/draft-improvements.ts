/** Step 5c — signal triage and draft improvement items, to a local file only (ADR-0170 §3.12 steps 2 and 3).
 *
 *   node --import tsx scripts/teras/draft-improvements.ts RECORDS.json [--top 5] [--out .improve/teras/drafts.json]
 *
 * RECORDS.json is an array of outcome records as core/outcome-record listOutcomeRecords returns them for one
 * tenant (an administrator's export; in the product, core/improvement/signals.ts readTenantSignals reads them as
 * the caller). Prints the aggregated signal report (counts, categories, tool and role names only) and writes
 * the top clusters as draft items in the improve loop's plan format (core/improvement/proposals.ts).
 *
 * It never pushes, raises, replies or changes a status on any feedback board: there is no board, tenant or
 * reporter id in a draft, and this command imports nothing from scripts/improve. An operator reads the file;
 * a person decides whether an item goes to a board through the existing improve commands. */
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {draftImprovements} from '../../core/improvement/proposals';
import {triageSignals,type SignalRecord} from '../../core/improvement/signals';
import {writeLocalOutput} from './output';

function main(argv:readonly string[]){
 const flag=(name:string)=>argv.includes(name)?argv[argv.indexOf(name)+1]:undefined;
 const input=argv.find((arg,index)=>!arg.startsWith('--')&&!['--top','--out'].includes(argv[index-1]??''));
 if(!input){console.error('usage: draft-improvements.ts RECORDS.json [--top 5] [--out .improve/teras/drafts.json]');process.exit(2);}
 const records=JSON.parse(readFileSync(input,'utf8')) as SignalRecord[];
 if(!Array.isArray(records))throw Error('RECORDS.json must be an array of outcome records.');
 const report=triageSignals(records),drafts=draftImprovements(report,{top:Number(flag('--top')??5)});
 process.stdout.write(JSON.stringify(report,null,1)+'\n');
 const out=flag('--out')??'.improve/teras/drafts.json';
 console.error(`wrote ${drafts.length} local draft(s) to ${writeLocalOutput(out,JSON.stringify({kind:'teras.improvement-drafts',version:1,signals:report,drafts},null,1))}; nothing was sent to any board`);
}
if(process.argv[1]&&import.meta.url.endsWith(basename(process.argv[1])))main(process.argv.slice(2));
