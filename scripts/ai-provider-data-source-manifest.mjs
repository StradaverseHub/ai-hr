/** Static transitive source hashing only: no application, compiler, test, DB or provider execution. */
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,relative} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
// Literal human approval rows and generated digests cannot hash themselves. Validation DOES enter
// the closure. Editing any covered source makes the literal approval digest stale and blocks egress.
const omitted=new Set(['lib/ai/provider-data-approvals.ts','lib/ai/provider-data-source-manifest.ts','lib/ai/module-agent-source-manifest.ts']);
const roots=['package.json','pnpm-lock.yaml','core/ai-governance.ts','core/assistant.ts','core/ai-domain-analysis.ts','core/ai-workforce-analysis.ts','core/ai-payroll-comparison-analysis.ts','core/personnel-import-assistance.ts','core/input-triage.ts','core/readiness-nudge.ts','core/payroll-hypothesis.ts','core/payroll-anomaly-narrate.ts','core/pay-rule-ai.ts','core/report-ai.ts','core/feedback.ts','core/performance.ts','core/module-agent-releases.ts','packs/performance/onehr/provider-source-draft.ts','packs/performance/onehr/competency-insight-service.ts','packs/performance/onehr/rewrite-service.ts','packs/performance/onehr/guide-service.ts','packs/performance/onehr/admin-agent-service.ts','packs/performance/onehr/career-draft-service.ts','packs/performance/onehr/development-suggestion-service.ts','packs/performance/onehr/insight-service.ts','lib/ai/provider-protocol.ts','lib/ai/provider-data-policy.ts','lib/ai/provider-analysis-policy.ts','lib/ai/providers/anthropic.ts','lib/ai/providers/google.ts','lib/ai/providers/openai.ts','lib/ai/providers/openrouter.ts','lib/ai/providers/gateway.ts','lib/ai/providers/openrouter-transport.ts','scripts/ai-provider-data-source-manifest.mjs'];
const found=new Set();
function visit(name){
 if(omitted.has(name)||found.has(name))return;
 if(name.startsWith('../')||!existsSync(resolve(root,name)))throw Error('Missing privacy source dependency: '+name);
 found.add(name);const text=readFileSync(resolve(root,name),'utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/^[ \t]*\/\/.*$/gm,'');
 if(!/\.(?:ts|tsx|mjs)$/.test(name))return;
 for(const match of text.matchAll(/(?:from\s*|import\s*(?:\(\s*)?)['"]([^'"]+)['"]/g)){
  const spec=match[1];if(!spec.startsWith('.')&&!spec.startsWith('@/'))continue;
  const target=spec.startsWith('@/')?resolve(root,spec.slice(2)):resolve(root,dirname(name),spec);
  const resolved=['','.ts','.tsx','.mjs','.json','/index.ts','/index.tsx'].map(suffix=>target+suffix).find(path=>/\.(?:ts|tsx|mjs|json)$/.test(path)&&existsSync(path));
  if(!resolved)throw Error('Unresolved privacy source import: '+name+' -> '+spec);
  visit(relative(root,resolved));
 }
}
roots.forEach(visit);
const names=[...found].sort(),files=names.map(name=>[name,createHash('sha256').update(readFileSync(resolve(root,name))).digest('hex')]);
const digest=createHash('sha256').update(JSON.stringify(files)).digest('hex');
const target=resolve(root,'lib/ai/provider-data-source-manifest.ts');
const output='/** GENERATED exact privacy transform sources. Regenerate after any listed dependency changes. */\nexport const PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST = '+JSON.stringify(digest)+' as const;\n';
if(process.argv.includes('--check')){if(readFileSync(target,'utf8')!==output)throw Error('Provider-data transform source manifest is stale.');}
else writeFileSync(target,output);
process.stdout.write(JSON.stringify({files:files.length,digest,...(process.argv.includes('--list')?{sources:names}:{})})+'\n');
