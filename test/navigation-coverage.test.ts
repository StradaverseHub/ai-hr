import {describe,it,expect} from 'vitest';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {declaredNavigationCatalogue,resolveNavigationCatalogue,type NavigationCatalogue} from '../lib/navigation/catalogue';
import {auditNavigationCoverage,discoverPageRoutes,pageRouteMatches,type CoverageLedger,type RecordedRuntimeClaim} from '../scripts/performance/navigation-coverage';

const candidateSha='1234567890abcdef1234567890abcdef12345678';
const ledger=()=>JSON.parse(readFileSync(new URL('../scripts/performance/navigation-coverage-ledger.json',import.meta.url),'utf8')) as CoverageLedger;
const audit=(review=ledger(),catalogue=declaredNavigationCatalogue())=>auditNavigationCoverage({catalogue,ledger:review,pages:discoverPageRoutes(process.cwd()),candidateSha});
describe('navigation coverage separates source integrity from runtime acceptance',()=>{
 it('allows an honestly reviewed structural backlog while refusing required runtime coverage',()=>{
  const report=audit();expect(report.structural.errors).toEqual([]);
  expect(report.structural.passed).toBe(true);expect(report.runtimeAcceptance.passed).toBe(false);
  expect(report.runtimeAcceptance.verifierUnavailable).toBe(true);expect(report.runtimeAcceptance.verifiedReceiptCount).toBe(0);
  expect(report.runtimeAcceptance.missingExecutedUsableContent.length).toBeGreaterThan(100);
  expect(report.runtimeAcceptance.incompleteRegistries.some(item=>item.id==='nested-submenus')).toBe(true);
 });
 it('requires an authenticated verifier independently of whether any destination is missing evidence',()=>{
  const review=ledger();review.entries=[];
  const report=audit(review,{declarations:[],issues:[]});
  expect(report.structural.passed).toBe(true);
  expect(report.runtimeAcceptance.missingExecutedUsableContent).toEqual([]);
  expect(report.runtimeAcceptance.verifierUnavailable).toBe(true);
  expect(report.runtimeAcceptance.verifiedReceiptCount).toBe(0);
  expect(report.runtimeAcceptance.passed).toBe(false);
 });
 it('fails missing/stale ledger entries and duplicate identity or provenance',()=>{
  const missing=ledger();missing.entries.shift();expect(audit(missing).structural.passed).toBe(false);
  const stale=ledger();stale.entries[0].declaredHref='/changed-address';expect(audit(stale).structural.errors.some(error=>error.startsWith('stale ledger provenance/address'))).toBe(true);
  const duplicate=ledger();duplicate.entries.push(duplicate.entries[0]);expect(audit(duplicate).structural.errors.some(error=>error.startsWith('duplicate ledger ID'))).toBe(true);
 });
 it('fails structural integrity for runtime binding failures and missing placement/provenance',()=>{
  const catalogue=declaredNavigationCatalogue(),review=ledger();
  const report=auditNavigationCoverage({catalogue,ledger:review,pages:discoverPageRoutes(process.cwd()),candidateSha,
   runtimeIssues:[{code:'unmapped-runtime-row',detail:'new runtime-only descriptor'}]});
  expect(report.structural.passed).toBe(false);
  const first=catalogue.declarations[0];
  catalogue.declarations[0]={...first,sourceOwner:'',placement:undefined};
  expect(audit(review,catalogue).structural.errors).toContain(`missing provenance: ${first.id}`);
  expect(audit(review,catalogue).structural.errors).toContain(`missing placement: ${first.id}`);
 });
 it('a new leaf without a reviewed stable identity and ledger entry fails the gate',()=>{
  const catalogue=declaredNavigationCatalogue(),first=catalogue.declarations[0];
  const injected:NavigationCatalogue={issues:[],declarations:[...catalogue.declarations,{...first,id:'shell.reviewRequired',sourceKey:'review-required',declaredHref:'/unreviewed',navigationHref:'/unreviewed'}]};
  expect(audit(ledger(),injected).structural.errors).toContain('missing ledger entry: shell.reviewRequired');
 });
 it('cannot promote plausible, fabricated or mere-heading claims into executed coverage',()=>{
  const review=ledger(),entry=review.entries[0],baseline=audit(review);
  const plausible:RecordedRuntimeClaim={destinationId:entry.id,navigationHref:entry.declaredHref,candidateSha,environment:'fictional-test-installation',
   runUrl:'https://github.com/StradaverseHub/ai-hr/actions/runs/123456789',executedAt:'2026-11-07T00:00:00Z',outcome:'passed',scenarioId:'dashboard-usable-content',
   usableContent:{selector:'main [data-ready]',assertion:'Expected independent data and a usable action',observedNonempty:true,artifactUrl:'https://github.com/StradaverseHub/ai-hr/actions/runs/123456789/artifacts/123'}};
  const fabricated={...plausible,runUrl:'https://example.invalid/runs/1',usableContent:{selector:'main h1',assertion:'A heading exists',observedNonempty:true,artifactUrl:'https://example.invalid/artifact/1'}};
  for(const claim of [plausible,fabricated,{...fabricated,outcome:'failed' as const},{...plausible,candidateSha:'0'.repeat(40)}]){
   entry.status='claimed';entry.claims=[claim];
   const report=audit(review);
   expect(report.structural.passed).toBe(true);
   expect(report.recordedClaims.total).toBe(1);
   expect(report.runtimeAcceptance.missingExecutedUsableContent).toEqual(baseline.runtimeAcceptance.missingExecutedUsableContent);
   expect(report.runtimeAcceptance.verifierUnavailable).toBe(true);
   expect(report.runtimeAcceptance.verifiedReceiptCount).toBe(0);
   expect(report.runtimeAcceptance.passed).toBe(false);
  }
 });
 it('ignores legacy receipt-shaped payloads and caller-provided verification flags',()=>{
  const review=ledger(),entry=review.entries[0],baseline=audit(review);
  Object.assign(entry,{status:'covered',verified:true,receipts:[{destinationId:entry.id,candidateSha,
   navigationHref:entry.declaredHref,outcome:'passed',verified:true,
   runUrl:'https://example.invalid/runs/legacy',usableContent:{selector:'main h1',observedNonempty:true}}]});
  const report=audit(review);
  expect(report.runtimeAcceptance.missingExecutedUsableContent).toEqual(baseline.runtimeAcceptance.missingExecutedUsableContent);
  expect(report.runtimeAcceptance.verifiedReceiptCount).toBe(0);
  expect(report.runtimeAcceptance.verifierUnavailable).toBe(true);
  expect(report.runtimeAcceptance.passed).toBe(false);
 });
 it('treats every recorded claim as unverified even when every active destination claims a successful run',()=>{
  const review=ledger(),catalogue=declaredNavigationCatalogue();
  for(const entry of review.entries){entry.status='claimed';entry.claims=[{
   destinationId:entry.id,navigationHref:entry.declaredHref,candidateSha,environment:'fictional-test-installation',
   runUrl:'https://example.invalid/runs/2',executedAt:'2026-11-07T00:00:00Z',outcome:'passed',scenarioId:'declared-scenario',
   usableContent:{selector:'main h1',assertion:'A heading exists',observedNonempty:true,artifactUrl:'https://example.invalid/artifact/2'},
  }];}
  const report=audit(review,catalogue);
  expect(report.structural.passed).toBe(true);
  expect(report.runtimeAcceptance.missingExecutedUsableContent).toEqual(catalogue.declarations.filter(row=>row.status==='declared'&&!row.disabled).map(row=>row.id));
  expect(report.recordedClaims.total).toBe(review.entries.length);
  expect(report.runtimeAcceptance.verifiedReceiptCount).toBe(0);
  expect(report.runtimeAcceptance.verifierUnavailable).toBe(true);
  expect(report.runtimeAcceptance.passed).toBe(false);
 });
 it('reports substituted cycle-admin click expectations as metadata while its claim remains unverified',()=>{
  const review=ledger(),catalogue=declaredNavigationCatalogue();
  const latest='/performance/11111111-2222-4333-8444-555555555555/cycle/calendar';
  const resolved=resolveNavigationCatalogue({isAdmin:false,canAdministerOnehr:true,performanceAdminHref:latest});
  const admin=resolved.rows.find(row=>row.navigationHref===latest)!;
  const entry=review.entries.find(row=>row.id===admin.declaration.id)!;entry.status='claimed';
  entry.claims=[{destinationId:entry.id,navigationHref:latest,candidateSha,environment:'fictional-test-installation',runUrl:'https://example.invalid/runs/3',executedAt:'2026-11-07T00:00:00Z',outcome:'passed',scenarioId:'cycle-calendar',usableContent:{selector:'main h1',assertion:'Expected cycle calendar heading',observedNonempty:true,artifactUrl:'https://example.invalid/artifact/3'}}];
  const report=auditNavigationCoverage({catalogue,ledger:review,pages:discoverPageRoutes(process.cwd()),candidateSha,runtimeRows:resolved.rows});
  expect(report.runtimeExpectations.destinations.find(row=>row.destinationId===entry.id)?.navigationHrefs).toEqual([latest]);
  expect(report.runtimeAcceptance.missingExecutedUsableContent).toContain(entry.id);
  expect(report.runtimeAcceptance.verifiedReceiptCount).toBe(0);
 });
 it('classifies actual filesystem redirect/factory source separately and matches dynamic route shapes',()=>{
  const root=mkdtempSync(join(tmpdir(),'navigation-page-source-'));
  try{
   mkdirSync(join(root,'app','items','[id]'),{recursive:true});writeFileSync(join(root,'app','items','[id]','page.tsx'),'export default createDetailPage();');
   mkdirSync(join(root,'app','old'),{recursive:true});writeFileSync(join(root,'app','old','page.tsx'),'export default function Page(){redirect("/items")}');
   const routes=discoverPageRoutes(root);
   expect(routes.find(row=>row.route==='/items/[id]')?.kind).toBe('dynamic-route-factory');
   expect(routes.find(row=>row.route==='/old')?.kind).toBe('redirect');
   expect(pageRouteMatches('/items/[id]','/items/real-record?view=detail')).toBe(true);
   expect(pageRouteMatches('/items/[id]','/items')).toBe(false);
   expect(pageRouteMatches('/items/[[...path]]','/items')).toBe(true);
  }finally{rmSync(root,{recursive:true,force:true});}
 });
});
