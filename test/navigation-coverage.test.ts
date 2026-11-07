import {describe,it,expect} from 'vitest';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {declaredNavigationCatalogue,resolveNavigationCatalogue,type NavigationCatalogue} from '../lib/navigation/catalogue';
import {auditNavigationCoverage,discoverPageRoutes,pageRouteMatches,type CoverageLedger,type RuntimeReceipt} from '../scripts/performance/navigation-coverage';

const candidateSha='1234567890abcdef1234567890abcdef12345678';
const ledger=()=>JSON.parse(readFileSync(new URL('../scripts/performance/navigation-coverage-ledger.json',import.meta.url),'utf8')) as CoverageLedger;
const audit=(review=ledger(),catalogue=declaredNavigationCatalogue())=>auditNavigationCoverage({catalogue,ledger:review,pages:discoverPageRoutes(process.cwd()),candidateSha});
describe('navigation coverage separates source integrity from runtime acceptance',()=>{
 it('allows an honestly reviewed structural backlog while refusing required runtime coverage',()=>{
  const report=audit();expect(report.structural.errors).toEqual([]);
  expect(report.structural.passed).toBe(true);expect(report.runtimeAcceptance.passed).toBe(false);
  expect(report.runtimeAcceptance.missingExecutedUsableContent.length).toBeGreaterThan(100);
  expect(report.runtimeAcceptance.incompleteRegistries.some(item=>item.id==='nested-submenus')).toBe(true);
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
 it('does not count uncovered, declared scenarios, source files or failed/wrong-candidate receipts as passed',()=>{
  const review=ledger(),entry=review.entries[0];
  const receipt:RuntimeReceipt={destinationId:entry.id,navigationHref:entry.declaredHref,candidateSha,environment:'fictional-test-installation',
   runUrl:'https://example.invalid/runs/1',executedAt:'2026-11-07T00:00:00Z',outcome:'passed',scenarioId:'dashboard-usable-content',
   usableContent:{selector:'main h1',assertion:'Independent expected title and nonempty content',observedNonempty:true,artifactUrl:'https://example.invalid/artifact/1'}};
  entry.receipts=[receipt];
  expect(audit(review).runtimeAcceptance.missingExecutedUsableContent).toContain(entry.id);
  entry.status='covered';entry.receipts=[{...receipt,outcome:'failed'}];expect(audit(review).runtimeAcceptance.missingExecutedUsableContent).toContain(entry.id);
  entry.receipts=[{...receipt,candidateSha:'0'.repeat(40)}];expect(audit(review).runtimeAcceptance.missingExecutedUsableContent).toContain(entry.id);
  entry.receipts=[{...receipt,usableContent:{...receipt.usableContent,observedNonempty:false}}];expect(audit(review).runtimeAcceptance.missingExecutedUsableContent).toContain(entry.id);
  entry.receipts=[receipt];expect(audit(review).runtimeAcceptance.missingExecutedUsableContent).not.toContain(entry.id);
  expect(audit(review).runtimeAcceptance.passed).toBe(false);
 });
 it('binds executed cycle-admin clicks to the stable declared destination instead of accepting the default address',()=>{
  const review=ledger(),catalogue=declaredNavigationCatalogue();
  const latest='/performance/11111111-2222-4333-8444-555555555555/cycle/calendar';
  const resolved=resolveNavigationCatalogue({isAdmin:false,canAdministerOnehr:true,performanceAdminHref:latest});
  const admin=resolved.rows.find(row=>row.navigationHref===latest)!;
  const entry=review.entries.find(row=>row.id===admin.declaration.id)!;entry.status='covered';
  const receipt:RuntimeReceipt={destinationId:entry.id,navigationHref:latest,candidateSha,environment:'fictional-test-installation',runUrl:'https://example.invalid/runs/2',executedAt:'2026-11-07T00:00:00Z',outcome:'passed',scenarioId:'cycle-calendar',usableContent:{selector:'main h1',assertion:'Expected cycle calendar and usable content',observedNonempty:true,artifactUrl:'https://example.invalid/artifact/2'}};
  entry.receipts=[{...receipt,navigationHref:'/performance'}];
  const options={catalogue,ledger:review,pages:discoverPageRoutes(process.cwd()),candidateSha,runtimeRows:resolved.rows};
  expect(auditNavigationCoverage(options).runtimeAcceptance.missingExecutedUsableContent).toContain(entry.id);
  entry.receipts=[receipt];expect(auditNavigationCoverage(options).runtimeAcceptance.missingExecutedUsableContent).not.toContain(entry.id);
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
