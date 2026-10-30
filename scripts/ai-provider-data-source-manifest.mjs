/** Static hashing only; no application, provider, test, compiler or database execution. */
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const names=['lib/ai/provider-data-policy.ts','lib/ai/provider-analysis-policy.ts','lib/ai/provider-analysis-coverage.ts','lib/ai/features.ts','lib/ai/module-agents.ts','lib/ai/module-jobs.ts','lib/ai/types.ts','core/ai-governance.ts','lib/ai/index.ts','lib/ai/governance.ts','lib/ai/provider-privacy-request.ts','lib/ai/provider-egress.ts','scripts/ai-provider-data-source-manifest.mjs'];
const files=names.map(name=>[name,createHash('sha256').update(readFileSync(new URL(name,root))).digest('hex')]);
const digest=createHash('sha256').update(JSON.stringify(files)).digest('hex');
const target=new URL('lib/ai/provider-data-source-manifest.ts',root);
const output='/** GENERATED exact privacy transform sources. Regenerate after any listed dependency changes. */\nexport const PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST = '+JSON.stringify(digest)+' as const;\n';
if(process.argv.includes('--check')){if(readFileSync(target,'utf8')!==output)throw Error('Provider-data transform source manifest is stale.');}
else writeFileSync(target,output);
process.stdout.write(JSON.stringify({files:files.length,digest})+'\n');
