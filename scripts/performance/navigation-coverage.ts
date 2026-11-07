/** Read-only shell coverage audit. Run on standard hosted Actions; never writes the review ledger. */
import {readFileSync,readdirSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {declaredNavigationCatalogue,resolveNavigationCatalogue,NAVIGATION_COVERAGE_BACKLOG,type NavigationCatalogue,type CatalogueIssue} from '../../lib/navigation/catalogue';

export type RuntimeReceipt={destinationId:string;navigationHref:string;candidateSha:string;environment:string;
 runUrl:string;executedAt:string;outcome:'passed'|'failed';scenarioId:string;
 usableContent:{selector:string;assertion:string;observedNonempty:boolean;artifactUrl:string}};
export type CoverageLedgerEntry={id:string;sourceOwner:string;sourceKey:string;declaredHref:string;
 status:'uncovered'|'covered';owner:string;reason:string;receipts?:RuntimeReceipt[]};
export type CoverageLedger={schemaVersion:number;scope:string;reviewedAgainst:string;entries:CoverageLedgerEntry[];
 backlog:{id:string;owner:string;reason:string}[]};
export type PageRoute={route:string;file:string;kind:'page'|'redirect'|'dynamic-route-factory'};

/** Filesystem route shapes establish source existence only, never visibility or service permission. */
export function discoverPageRoutes(repositoryRoot:string):PageRoute[]{
 const routes:PageRoute[]=[];
 const visit=(dir:string,segments:string[])=>{for(const entry of readdirSync(dir,{withFileTypes:true})){
  if(entry.isDirectory())visit(join(dir,entry.name),[...segments,entry.name]);
  else if(/^page\.(tsx?|jsx?)$/.test(entry.name)){
   const file=join(dir,entry.name),source=readFileSync(file,'utf8');
   const route='/'+segments.filter(s=>!s.startsWith('(')&&!s.startsWith('@')).join('/');
   routes.push({route,file:relative(repositoryRoot,file),kind:/\b(?:permanentRedirect|redirect)\s*\(/.test(source)?'redirect':
    /(?:create\w*Page|make\w*Page|\w+PageFactory)\s*\(/.test(source)?'dynamic-route-factory':'page'});
  }
 }};
 visit(join(repositoryRoot,'app'),[]);return routes;
}
export function pageRouteMatches(route:string,href:string):boolean{
 const path=href.split(/[?#]/)[0];
 const parts=route.split('/').map(segment=>{
  if(/^\[\[\.\.\..+\]\]$/.test(segment))return '(?:/.*)?';
  if(/^\[\.\.\..+\]$/.test(segment))return '/.+';
  if(/^\[.+\]$/.test(segment))return '/[^/]+';
  return '/'+segment.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 }).slice(1).join('');
 return new RegExp('^'+(parts||'/')+'/?$').test(path);
}
const nonempty=(value:unknown)=>typeof value==='string'&&value.trim().length>0;
function usableReceipt(receipt:RuntimeReceipt,entry:CoverageLedgerEntry,candidateSha:string):boolean{
 const content=receipt.usableContent;
 return receipt.outcome==='passed'&&receipt.destinationId===entry.id&&receipt.candidateSha===candidateSha&&
  /^[0-9a-f]{40}$/.test(candidateSha)&&nonempty(receipt.navigationHref)&&nonempty(receipt.environment)&&
  /^https:\/\//.test(receipt.runUrl)&&nonempty(receipt.scenarioId)&&Number.isFinite(Date.parse(receipt.executedAt))&&
  !!content&&nonempty(content.selector)&&nonempty(content.assertion)&&content.observedNonempty===true&&/^https:\/\//.test(content.artifactUrl);
}
/** Structural integrity and runtime acceptance deliberately report separate outcomes. */
export function auditNavigationCoverage({catalogue,ledger,pages,candidateSha,runtimeIssues=[]}: {
 catalogue:NavigationCatalogue;ledger:CoverageLedger;pages:readonly PageRoute[];candidateSha:string;runtimeIssues?:readonly CatalogueIssue[];
}){
 const errors=[...catalogue.issues,...runtimeIssues].map(issue=>`${issue.code}: ${issue.detail}`),runtimeMissing:string[]=[];
 if(ledger.schemaVersion!==1)errors.push('unsupported ledger schema');
 if(!nonempty(ledger.scope)||!nonempty(ledger.reviewedAgainst))errors.push('missing ledger provenance');
 const declarations=new Map(catalogue.declarations.map(row=>[row.id,row]));
 for(const key of ['id','sourceKey'] as const){const seen=new Set<string>();for(const row of catalogue.declarations){
  if(seen.has(row[key]))errors.push(`duplicate declaration ${key}: ${row[key]}`);seen.add(row[key]);
 }}
 const entries=new Map<string,CoverageLedgerEntry>();
 for(const entry of ledger.entries){
  if(entries.has(entry.id))errors.push(`duplicate ledger ID: ${entry.id}`);entries.set(entry.id,entry);
  const declaration=declarations.get(entry.id);
  if(!declaration)errors.push(`stale ledger entry: ${entry.id}`);
  else if(entry.sourceOwner!==declaration.sourceOwner||entry.sourceKey!==declaration.sourceKey||entry.declaredHref!==declaration.declaredHref)
   errors.push(`stale ledger provenance/address: ${entry.id}`);
  if(!nonempty(entry.owner)||!nonempty(entry.reason)||!['covered','uncovered'].includes(entry.status))errors.push(`missing review disposition: ${entry.id}`);
 }
 for(const row of catalogue.declarations){
  const entry=entries.get(row.id);
  if(!entry)errors.push(`missing ledger entry: ${row.id}`);
  if(!row.sourceOwner||!row.sourceKey)errors.push(`missing provenance: ${row.id}`);
  if(!row.placement)errors.push(`missing placement: ${row.id}`);
  if(!pages.some(page=>pageRouteMatches(page.route,row.navigationHref)))errors.push(`missing source page: ${row.id} (${row.navigationHref})`);
  if(row.status==='declared'&&!row.disabled){
   // An uncovered disposition can never count as passed, even if someone attaches a scenario or receipt.
   if(entry?.status!=='covered'||!entry.receipts?.some(receipt=>usableReceipt(receipt,entry,candidateSha)&&receipt.navigationHref===row.navigationHref))runtimeMissing.push(row.id);
  }
 }
 for(const item of NAVIGATION_COVERAGE_BACKLOG){
  if(!ledger.backlog.some(entry=>entry.id===item.id&&nonempty(entry.owner)&&nonempty(entry.reason)))errors.push(`missing backlog review: ${item.id}`);
 }
 for(const item of ledger.backlog)if(!NAVIGATION_COVERAGE_BACKLOG.some(known=>known.id===item.id))errors.push(`stale backlog entry: ${item.id}`);
 return {scope:ledger.scope,structural:{passed:errors.length===0,errors},runtimeAcceptance:{
  passed:errors.length===0&&runtimeMissing.length===0&&ledger.backlog.length===0,
  missingExecutedUsableContent:runtimeMissing,incompleteRegistries:ledger.backlog},
  counts:{declared:catalogue.declarations.length,sourcePages:pages.length},pages};
}
export function navigationCoverageMain(args=process.argv.slice(2)){
 const repositoryRoot=resolve(process.cwd());
 const ledger=JSON.parse(readFileSync(join(repositoryRoot,'scripts/performance/navigation-coverage-ledger.json'),'utf8')) as CoverageLedger;
 const catalogue=declaredNavigationCatalogue();
 // Synthetic facts exercise binding structure only; these are never runtime content receipts.
 const runtimeChecks=[{isAdmin:false},{isAdmin:true,canApprove:true,canAdministerOnehr:true,canAccessTeam:true,
  canAdministerSecurity:true,canConfigureAccess:true,canProvisionUsers:true,canConfigurePasswordPolicy:true,
  canConfigureIdentityEmail:true,canPreviewIdentityEmail:true,canConfigureLoginPresentation:true,
  canAdministerAi:true,canConfigureAiProvider:true,canReviewProfileChanges:true,privateCaseHandler:true,
  onboardingV9Access:true,onboardingV9Navigation:{onboarding:true,offboarding:true,administration:true,records:true},
  letterDestinations:catalogue.declarations.filter(row=>row.sourceOwner==='lib/letter-navigation.ts').map(row=>row.declaredHref),
  rewardDestinations:catalogue.declarations.filter(row=>row.sourceOwner==='packs/rewards/index.ts').map(row=>row.declaredHref),
 }].flatMap(facts=>resolveNavigationCatalogue(facts).issues);
 const report=auditNavigationCoverage({catalogue,ledger,pages:discoverPageRoutes(repositoryRoot),candidateSha:process.env.AIHR_CANDIDATE_SHA??'',runtimeIssues:runtimeChecks});
 process.stdout.write(JSON.stringify(report,null,2)+'\n');
 return (args.includes('--require-runtime')?report.runtimeAcceptance.passed:report.structural.passed)?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=navigationCoverageMain();
