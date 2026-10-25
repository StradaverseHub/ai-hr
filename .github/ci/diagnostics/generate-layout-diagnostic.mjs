/** DRAFT: materialize the probe into ignored candidate attachments, never edit tracked source. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const draft=dirname(fileURLToPath(import.meta.url)),cwd=process.cwd(),out=join(cwd,'.vitest-attachments');
const source=readFileSync(join(cwd,'test/topbar-identity-width.browser.test.tsx'),'utf8');
const declarations=[...source.matchAll(/export const ([A-Z_]+)\s*=([\s\S]+?);/g)].map(m=>m[0].replace('export ',''));
const required=['SHELL_BODY_CLS','SHELL_ROW_CLS','SHELL_COL_CLS','RAIL_WIDTH_CLS','RAIL_VISIBILITY_CLS','RAIL_DEFAULT_BREAKPOINT_CLS','HEADER_CLS','RIGHT_CLUSTER_CLS','DIVIDER_CLS','ICON_CLS'];
for(const name of required)if(!declarations.some(d=>d.startsWith('const '+name+' ')))throw Error('Missing exact geometry declaration '+name);
const start=source.indexOf('function MonolithShell('),end=source.indexOf("\ndescribe('Monolith top line",start);if(start<0||end<=start||end-start<1000)throw Error('Original Monolith shell markers absent');const monolithShell=source.slice(start,end);
mkdirSync(out,{recursive:true});
writeFileSync(join(out,'layout-diagnostic.browser.test.tsx'),readFileSync(join(draft,'layout-diagnostic.browser.test.tsx'),'utf8').replace('/* CLASS_DECLARATIONS */',declarations.join('\n')).replace('/* MONOLITH_SHELL */',monolithShell),{flag:'wx'});
writeFileSync(join(out,'layout-diagnostic-provenance.json'),JSON.stringify({kind:'diagnostic-only',originalTestSha256:createHash('sha256').update(source).digest('hex'),replica:'Original Classic shell with real UserMenu; tracked Schibsted proxy is explicitly NOT actual Classic Jakarta; monolith font/theme case retains original Classic geometry. An additional variant copies original MonolithShell verbatim with tracked font/theme. DM Mono compiled asset remains unavailable. Actual authenticated full app not rendered.'},null,2),{flag:'wx'});
const engine=process.env.ENGINE??'chromium';if(!['chromium','firefox','webkit'].includes(engine))throw Error('Invalid engine');
writeFileSync(join(out,'layout-diagnostic.config.mts'),`import base from '../vitest.browser.config';\nexport default {...base,test:{...base.test,include:['.vitest-attachments/layout-diagnostic.browser.test.tsx'],browser:{...base.test.browser,instances:[{browser:${JSON.stringify(engine)}}]}}};\n`,{flag:'wx'});
