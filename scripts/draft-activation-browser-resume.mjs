import {createHash} from 'node:crypto';
/** Closed local verification target; no arbitrary database, path, port or fixture flags. */
export const DRAFT_ACTIVATION_BROWSER_TARGET = Object.freeze({database:'ai_hr_board15_activation_browser',namespace:'board15activation',port:3204,scratchpad:'scratchpad/board15-draft-activation'});
export function draftActivationBrowserOptions(args, {allowWorker=false} = {}) {
  if (!Array.isArray(args) || args.some(arg=>typeof arg!=='string') || new Set(args).size!==args.length || args.some(arg=>arg!=='--resume' && !(allowWorker && arg==='--held-lock-worker'))) throw new Error('Unknown or duplicate Draft browser argument.');
  return Object.freeze({resume:args.includes('--resume'),heldLockWorker:args.includes('--held-lock-worker')});
}
const sha=value=>typeof value==='string' && /^[0-9a-f]{40}$/.test(value);
const uuid=value=>typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const record=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refuse=()=>{throw new Error('Draft resume requires exact preparation and current owned cleanup receipts; preserve this target.');};
export function draftActivationResumeReceiptName(name,candidate) {
  return sha(candidate) && typeof name==='string' && /^browser-resume-[0-9a-f]{40}-[0-9]{13}\.json$/.test(name) && name.startsWith('browser-resume-'+candidate+'-');
}
/** Only local provenance, never current Draft contents or application authorization.
 * Draft preparation intentionally has no OT date/setupOnly/foreignTenant contract.
 * @param {{fixture:Record<string,unknown>,browser:Record<string,unknown>,stopped:Record<string,unknown>,resumeRecords?:Record<string,Record<string,unknown>>,root:string}} receipts
 */
export function validateDraftActivationResumeReceipts({fixture,browser,stopped,resumeRecords={},root}) {
  if (![fixture,browser,stopped,resumeRecords].every(record) || typeof root!=='string' || !root.startsWith('/')) refuse();
  const {database,namespace,port}=DRAFT_ACTIVATION_BROWSER_TARGET;
  const bound=value=>record(value) && value.root===root && value.database===database && value.namespace===namespace && value.port===port;
  if (!bound(fixture) || !bound(browser) || fixture.tenantId!=='11111111-1111-1111-1111-111111111111' || browser.fixtureRuns!==2 || !sha(browser.candidate) || JSON.stringify(browser.fixture)!==JSON.stringify(fixture)) refuse();
  if (!Array.isArray(fixture.locales) || JSON.stringify(fixture.locales)!==JSON.stringify(['en','ms','zh','ta','th','vi']) || !record(fixture.companies) || Object.keys(fixture.companies).sort().join(',')!=='Foreign,Main' || !uuid(fixture.companies.Main) || !uuid(fixture.companies.Foreign) || fixture.companies.Main===fixture.companies.Foreign || !record(fixture.people) || !record(fixture.drafts)) refuse();
  const actors={HR:'hr_admin',Manager:'manager',Employee:'employee',ForeignHR:'hr_admin',ForeignEmployee:'employee'};
  if (Object.keys(fixture.people).sort().join(',')!==Object.keys(actors).sort().join(',')) refuse();
  const users=new Set();
  for (const [key,role] of Object.entries(actors)) {
    const actor=fixture.people[key];
    if (!record(actor) || !['userId','personId','employmentId'].every(field=>uuid(actor[field])) || actor.role!==role || actor.login!=='activation15-fixture:'+key || actor.employeeCode!=='ACT15-'+key.toUpperCase() || actor.companyId!==fixture.companies[key.startsWith('Foreign')?'Foreign':'Main'] || users.has(actor.userId)) refuse();
    users.add(actor.userId);
  }
  const cases=['valid','optionalBlank','invalidIdentity','missingRequired','stalePolicy','locale_en','locale_ms','locale_zh','locale_ta','locale_th','locale_vi','deleteCancel','deleteConfirm','foreign'];
  if (Object.keys(fixture.drafts).sort().join(',')!==cases.sort().join(',')) refuse();
  const drafts=new Set();
  for (const [key,draft] of Object.entries(fixture.drafts)) {
    if (!record(draft) || !uuid(draft.id) || drafts.has(draft.id) || !uuid(draft.reservedConfigId) || !Number.isSafeInteger(draft.reservedNumber) || draft.reservedNumber<1 || !Number.isSafeInteger(draft.currentStep) || draft.currentStep<1 || draft.currentStep>6 || draft.companyId!==fixture.companies[key==='foreign'?'Foreign':'Main'] || typeof draft.employeeCode!=='string' || !draft.employeeCode.startsWith('ACT15-') || !record(draft.data) || !record(draft.routes) || typeof draft.dataSha256!=='string' || !/^[0-9a-f]{64}$/.test(draft.dataSha256)) refuse();
    for (const locale of fixture.locales) if (draft.routes[locale]!=='/admin/personnel/new?draft='+draft.id) refuse();
    drafts.add(draft.id);
  }
  const preparationBrowserDigest=digest(browser),preparationFixtureDigest=digest(fixture);
  const visited=new Set(),names=Object.keys(resumeRecords);
  if (names.length>64) refuse();
  const visitStop=stop=>{
    if (!record(stop) || !sha(stop.candidate) || stop.database!==database || stop.port!==port || stop.ownedServerStopped!==true || typeof stop.stoppedAt!=='string' || !Number.isFinite(Date.parse(stop.stoppedAt))) refuse();
    for (const [key,expected] of [['root',root],['namespace',namespace],['preparationCandidate',browser.candidate]]) if (stop[key]!==undefined && stop[key]!==expected) refuse();
    if (stop.outcome!==undefined && (!['stopped','failed'].includes(stop.outcome) || stop.cleanupSucceeded!==true || stop.exitCode!==(stop.outcome==='failed'?1:0))) refuse();
    if (stop.serverPid!==undefined && (!Number.isSafeInteger(stop.serverPid) || stop.serverPid<=1)) refuse();
    if (stop.resumeReceipt===undefined) {
      if (stop.candidate!==browser.candidate) refuse();
      const legacyKeys=['candidate','database','port','ownedServerStopped','stoppedAt'];
      const legacy=Object.keys(stop).length===legacyKeys.length && legacyKeys.every(key=>Object.hasOwn(stop,key));
      if (!legacy && (!bound(stop) || stop.preparationCandidate!==browser.candidate || stop.outcome===undefined || stop.serverPid===undefined)) refuse();
      return;
    }
    if (!bound(stop) || stop.preparationCandidate!==browser.candidate || stop.outcome===undefined || stop.serverPid===undefined) refuse();
    const name=stop.resumeReceipt;
    if (!draftActivationResumeReceiptName(name,stop.candidate) || visited.has(name)) refuse();
    const previous=resumeRecords[name];
    if (!bound(previous) || previous.candidate!==stop.candidate || previous.preparationCandidate!==browser.candidate || previous.preparationBrowserDigest!==preparationBrowserDigest || previous.preparationFixtureDigest!==preparationFixtureDigest || !record(previous.priorStoppedReceipt) || previous.resumedFromCandidate!==previous.priorStoppedReceipt.candidate || previous.fixtureRunsThisCandidate!==0 || previous.preparationManifest!=='browser-manifest.json' || previous.applicationAcceptance!=='UNVERIFIED' || typeof previous.resumedAt!=='string' || !Number.isFinite(Date.parse(previous.resumedAt))) refuse();
    visited.add(name);visitStop(previous.priorStoppedReceipt);
  };
  visitStop(stopped);
  if (names.some(name=>!visited.has(name))) refuse(); // A failed/newer orphan cannot be hidden by an older stop.
  return {preparationCandidate:browser.candidate,resumedFromCandidate:stopped.candidate,preparationBrowserDigest,preparationFixtureDigest};
}
