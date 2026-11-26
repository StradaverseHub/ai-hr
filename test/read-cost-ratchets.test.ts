/** ADR 0181 read-cost standard (docs/architecture/FUTURE-BUILD-CONTRACT.md, "Database read cost"): ratchets that keep
 * the old read patterns from growing back while the rollout converts the app area by area. No database.
 *
 * Each ratchet counts today's uses of an old pattern against a checked-in allowlist in test/read-cost-ratchets/
 * (seeded from origin/alpha at release 9). A new use fails; a removed use also fails until the allowlist is lowered, so
 * the lists only shrink. The failure prints every new site with file and line, or, for a shrink, the replacement
 * allowlist to check in. The scanners are in test/helpers/read-cost-ratchet.ts; the policy ratchet, which needs the
 * migrated database, is test/read-cost-policy-authority.test.ts. How to shrink each list: test/read-cost-ratchets/README.md. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';
import * as rc from './helpers/read-cost-ratchet';

const root=fileURLToPath(new URL('..',import.meta.url)).replace(/[\\/]+$/,'');
const DIR='test/read-cost-ratchets';
const load=<T,>(name:string):T=>JSON.parse(readFileSync(join(root,DIR,name),'utf8')) as T;
const CONTRACT='docs/architecture/FUTURE-BUILD-CONTRACT.md ("Database read cost")';

/** A count ratchet: the found counts against the allowlist, with the report as the assertion message. */
function expectRatchet(o:{name:string;file:string;rule:string;sites:rc.Site[];allowed:rc.Counts}){
 const found=rc.countSites(o.sites);
 const diff=rc.compareCounts(found,o.allowed);
 const report=rc.ratchetReport({name:o.name,allowlist:`${DIR}/${o.file}`,rule:o.rule,diff,sites:o.sites,
  shrunkAllowlist:diff.shrunk.length?rc.json(rc.shrunkCounts(found,o.allowed)).trimEnd():undefined});
 expect([...diff.grown,...diff.shrunk].map(d=>d.key),report).toEqual([]);
}
/** A set ratchet (one entry per use). */
function expectSetRatchet(o:{name:string;file:string;rule:string;found:string[];allowed:string[]}){
 const diff=rc.compareCounts(rc.asCounts(o.found),rc.asCounts(o.allowed));
 const keep=new Set(o.found);
 const report=rc.ratchetReport({name:o.name,allowlist:`${DIR}/${o.file}`,rule:o.rule,diff,
  shrunkAllowlist:diff.shrunk.length?rc.json(o.allowed.filter(k=>keep.has(k))).trimEnd():undefined});
 expect([...diff.grown,...diff.shrunk].map(d=>d.key),report).toEqual([]);
}

describe('read-cost detectors (fixtures)',()=>{
 it('finds the per-company fan-out behind the employee import page and the per-row Approvals breakdown',()=>{
  const importPage=`export default async function Page(){
 const s=await requireAdmin();
 const companies=await listCompanies(s);
 // for (each company) we used to read four catalogues
 const byCompany=Object.fromEntries(await Promise.all(companies.map(async co=>{
  const [ds,ps]=await Promise.all([listDepartments(s,{companyIds:[co.id]}),listPositions(s,{companyIds:[co.id]})]);
  return [co.id,{ds,ps}] as const;
 })));
}`;
  expect(rc.requestLoopSites('app/x/page.tsx',importPage).map(s=>s.line)).toEqual([5]);
  const approvals=`const breakdowns=await Promise.all(pendingLeave.map((r) => leaveRequestDateBreakdown(s, r.id)));`;
  expect(rc.requestLoopSites('app/x/page.tsx',approvals)).toHaveLength(1);
  const serial=`for (const id of ids) {\n  await markNotificationRead(ctx, id);\n}`;
  expect(rc.requestLoopSites('core/mobile-x.ts',serial).map(s=>s.line)).toEqual([1]);
  const tx=`await inTransaction(s, async tx=>{ for (const row of rows) await tx.execute(sql\`select 1\`); });`;
  expect(rc.requestLoopSites('app/x/actions.ts',tx)).toHaveLength(1);
 });
 it('leaves set-based reads, stream reads, pure maps, comments and strings alone',()=>{
  const fine=[
   `const breakdowns=await leaveRequestDateBreakdowns(s, pendingLeave.map((r) => r.id));`,
   `for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;}`,
   `const labels=rows.map(row=>label(row.code));`,
   `// await Promise.all(companies.map(c=>getCompanyConfig(s,c.id)))`,
   `const help='for (const c of companies) await getCompanyConfig(s, c.id)';`,
   `const [a,b]=await Promise.all([listCompanies(s),listDepartments(s)]);`,
  ];
  for(const text of fine)expect(rc.requestLoopSites('app/x/page.tsx',text),text).toEqual([]);
 });
 it('counts page-by-number paging, exact page totals, in-memory pages and OFFSET, not their keyset replacements',()=>{
  const text=`const q=parsePageQuery(sp);const state=pageState(q,total,rows.length);
const k=parseKeysetPageQuery(sp);const ks=keysetPageState(k,read,ids);
const page=paginateRows(all,q);
await db.select().from(t).limit(q.limit).offset(q.offset);
await tx.execute(sql\`select 1 from t limit \${q.limit} offset \${q.offset}\`);
// .offset(…) in a comment is not a use`;
  expect(rc.countSites(rc.pagingSites('app/x/page.tsx',text))).toEqual({
   'app/x/page.tsx | page-number query':1,'app/x/page.tsx | exact-total page state':1,'app/x/page.tsx | in-memory page':1,'app/x/page.tsx | OFFSET':2});
 });
 it('counts layout-wide revalidatePath only',()=>{
  const text=`revalidatePath('/', 'layout');revalidatePath(\`/payroll/\${id}\`);revalidatePath(PAGE,'layout');
revalidatePath(
  '/rewards',
  "layout",
);
// revalidatePath('/', 'layout') in a comment`;
  expect(rc.layoutRevalidateSites('app/x/actions.ts',text).map(s=>s.line)).toEqual([1,1,2]);
 });
 it('treats a policy call as per-row only when its arguments name a column',()=>{
  const authority=(_schema:string|null,name:string)=>['can_see_employment','has_capability','effective_companies','can_admin_payroll_for'].includes(name);
  expect(rc.perRowAuthorityCalls(`((tenant_id = app.current_tenant_id()) AND app.can_see_employment(employment_id))`,authority))
   .toEqual(['app.can_see_employment']);
  expect(rc.perRowAuthorityCalls(`(company_id = ANY (( SELECT app.effective_companies('workforce.view'::text) AS effective_companies)))`,authority)).toEqual([]);
  expect(rc.perRowAuthorityCalls(`app.has_capability('payroll.admin'::text, NULL::uuid)`,authority)).toEqual([]);
  expect(rc.perRowAuthorityCalls(`(EXISTS ( SELECT 1 FROM payroll_batch b WHERE ((b.id = payslip.batch_id) AND app.can_admin_payroll_for(b.company_id))))`,authority))
   .toEqual(['app.can_admin_payroll_for']);
  expect(rc.perRowAuthorityCalls(null,authority)).toEqual([]);
 });
 it('reports growth with sites and no replacement list, and a shrink with the lowered list',()=>{
  const sites:rc.Site[]=[{key:'a.ts',file:'a.ts',line:3,text:'x'},{key:'a.ts',file:'a.ts',line:9,text:'y'}];
  const grown=rc.compareCounts(rc.countSites(sites),{'a.ts':1,'b.ts':2});
  expect(grown).toEqual({grown:[{key:'a.ts',allowed:1,found:2}],shrunk:[{key:'b.ts',allowed:2,found:0}]});
  const report=rc.ratchetReport({name:'n',allowlist:'l.json',rule:'r',diff:grown,sites,shrunkAllowlist:rc.json(rc.shrunkCounts(rc.countSites(sites),{'a.ts':1,'b.ts':2}))});
  expect(report).toContain('a.ts:9  y');
  expect(report).toContain('"a.ts": 1');
  expect(report).not.toContain('"b.ts"');
 });
});

describe('read-cost ratchets on the current tree (allowlists only shrink)',()=>{
 it('adds no page-by-number list, exact list total, in-memory page or OFFSET',()=>{
  // Guards count what was scanned, never the old pattern itself: these counts are meant to reach zero. The fixture
  // tests above prove each detector finds its pattern through the same functions.
  expect(rc.sourceFiles(root,rc.PAGING_DIRS).length).toBeGreaterThan(1000);
  const sites=rc.scanPaging(root);
  expectRatchet({name:'Page-by-number lists',file:'page-by-number.json',sites,allowed:load('page-by-number.json'),
   rule:`Lists use parseKeysetPageQuery, keysetSlice and keysetPageState from lib/pagination.ts with cappedTotal ("1,000+" and "Count exactly"); see ${CONTRACT}.`});
 });
 it('adds no layout-wide revalidatePath',()=>{
  expect(rc.sourceFiles(root,rc.REVALIDATE_DIRS).length).toBeGreaterThan(1000);
  const sites=rc.scanLayoutRevalidate(root);
  expectRatchet({name:'Layout-wide revalidatePath',file:'layout-revalidate.json',sites,allowed:load('layout-revalidate.json'),
   rule:`A save returns its result and the next address (lib/action-navigation.ts, components/action-navigate-form.tsx) so the frame is not redrawn; see ${CONTRACT}.`});
 });
 it('adds no per-company or per-row data loop to a request path',()=>{
  const files=rc.requestPathFiles(root);
  expect(files.length).toBeGreaterThan(1000);
  const sites=files.flatMap(file=>rc.requestLoopSites(file,rc.read(root,file)));
  expectRatchet({name:'Request-path loops',file:'request-loops.json',sites,allowed:load('request-loops.json'),
   rule:`Read the set once (one statement with an id array; company lists take one array parameter, db/sql-arrays.ts) instead of one call per company or row; see docs/SCALE-AND-RELEASE-RULES.md rule 2 and ${CONTRACT}.`});
 });
 it('gives every page route and server action a measured read budget',()=>{
  const inventory=[...rc.pageRoutes(root),...rc.serverActions(root)];
  expect(rc.pageRoutes(root).length).toBeGreaterThan(400);
  expect(rc.serverActions(root).length).toBeGreaterThan(1000);
  const registry=load<Record<string,string>>('read-budget-registry.json');
  const unbudgeted=load<string[]>('unbudgeted-routes.json');
  const known=new Set(inventory);
  const problems=Object.entries(registry).map(([key,test])=>known.has(key)?rc.budgetEvidenceProblem(root,key,test):`${key}: no such page or action`)
   .filter((p):p is string=>p!==null);
  expect(problems,`${DIR}/read-budget-registry.json entries must name a test that measures them with observeStatements`).toEqual([]);
  const both=unbudgeted.filter(key=>key in registry);
  expect(both,`Registered keys must be removed from ${DIR}/unbudgeted-routes.json`).toEqual([]);
  expectSetRatchet({name:'Routes without a read budget',file:'unbudgeted-routes.json',allowed:unbudgeted,
   found:inventory.filter(key=>!(key in registry)),
   rule:`Register the new page (its page.tsx path) or server action (file#name) in ${DIR}/read-budget-registry.json with the test that measures its transactions and statements (test/helpers/statement-observer.ts) against a recorded budget; see ${CONTRACT}.`});
 });
 it('gives every migration that rewrites access-rule text a scale timing test',()=>{
  const authority=load<string[]>('policy-authority.json').map(key=>key.split(' | ')[2].replace(/^.*\./,''));
  const statementFunctions=rc.policyStatementFunctions(root);
  // Applied migrations are immutable, so the functions their policy statements name never shrink.
  expect(statementFunctions.size).toBeGreaterThan(50);
  const functions=new Set([...statementFunctions,...authority]);
  const rewrites=rc.policyRewriteMigrations(root,functions);
  const evidence=load<Record<string,string>>('policy-rewrite-evidence.json');
  const problems=Object.entries(evidence).map(([migration,test])=>rc.rewriteEvidenceProblem(root,migration,test)).filter((p):p is string=>p!==null);
  expect(problems,`${DIR}/policy-rewrite-evidence.json entries must name a scale timing test`).toEqual([]);
  const reasons=new Map(rewrites.map(r=>[r.file,r.reason]));
  const found=rewrites.map(r=>r.file).filter(file=>!(file in evidence));
  const allowed=load<string[]>('policy-rewrite-migrations.json');
  const diff=rc.compareCounts(rc.asCounts(found),rc.asCounts(allowed));
  const report=rc.ratchetReport({name:'Access-rule rewrites without timing evidence',allowlist:`${DIR}/policy-rewrite-migrations.json`,
   rule:`Add an entry to ${DIR}/policy-rewrite-evidence.json naming the test that times the old and new rule text with EXPLAIN ANALYZE on the 70-company scale fixture, including the payslip/employment/person joins; see ${CONTRACT}.`,
   diff,sites:diff.grown.map(g=>({key:g.key,file:`db/migrations/${g.key}`,line:1,text:reasons.get(g.key)??''})),
   shrunkAllowlist:diff.shrunk.length?rc.json(allowed.filter(f=>found.includes(f))).trimEnd():undefined});
  expect([...diff.grown,...diff.shrunk].map(d=>d.key),report).toEqual([]);
 });
});
