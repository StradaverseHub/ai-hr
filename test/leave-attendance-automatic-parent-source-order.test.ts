/** Pure source-order guard (no database). ADR-0131 named four automatic Attendance parents as still
 * requiring leave dependency owner integration: checkOutTx, the attendance-correction decision,
 * approved-plan application and imported-punch batches. This pins that each parent joins the interval
 * (Access -> exclusive leave configuration -> employee) as its FIRST transaction work, before its
 * protected reads and before the existing Attendance/credit subject key, Payroll and row locks; and that
 * approved-plan application and automatic Leave Credit banking are reachable only from those parents.
 * Source order is not runtime proof: the actual interleavings are in
 * leave-attendance-automatic-parent-dependency-participation.test.ts. */
import {readdirSync,readFileSync} from 'node:fs';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';

const root=fileURLToPath(new URL('..',import.meta.url));
const read=(rel:string)=>readFileSync(join(root,rel),'utf8');
const attendance=read('core/attendance.ts');
const clockingImport=read('core/attendance-clocking-import.ts');

/** One top-level declaration, from its unique header to the next top-level declaration. Both ends must
 * be found and the slice must be substantial: a renamed marker must fail, never pass on empty text. */
function declaration(source:string,header:string,minLength:number){
 const start=source.indexOf(header);
 expect(start,`${header} not found`).toBeGreaterThanOrEqual(0);
 expect(source.indexOf(header,start+1),`${header} is not unique`).toBe(-1);
 const next=source.slice(start+header.length).search(/\n(?:export )?(?:async )?function |\nexport (?:const|class) /);
 expect(next,`${header} has no following declaration`).toBeGreaterThanOrEqual(0);
 const text=source.slice(start,start+header.length+next);
 expect(text.length,`${header} slice is implausibly short`).toBeGreaterThan(minLength);
 return {start,end:start+text.length,text};
}
/** Every marker present; each FIRST occurrence strictly after the previous marker's first occurrence. */
function inOrder(text:string,markers:readonly string[]){
 let previous=-1;
 for(const marker of markers){
  const at=text.indexOf(marker);
  expect(at,`missing ${marker}`).toBeGreaterThanOrEqual(0);
  expect(at,`${marker} precedes the earlier step`).toBeGreaterThan(previous);
  previous=at;
 }
}
/** Nothing awaited and no transaction use before the join: no protected read can precede it. */
function nothingBefore(text:string,join:string){
 const at=text.indexOf(join);
 expect(at,`missing ${join}`).toBeGreaterThan(0);
 expect(text.slice(0,at)).not.toMatch(/\bawait\b|\btx\s*\./);
}
function callSites(source:string,name:string){
 const sites:number[]=[];const pattern=new RegExp(`\\b${name}\\(`,'g');
 for(let match=pattern.exec(source);match;match=pattern.exec(source))sites.push(match.index);
 return sites;
}
const checkOut=declaration(attendance,'export async function checkOutTx(',3000);
const decide=declaration(attendance,'export async function decideAttendanceCorrection(',10000);
const batch=declaration(attendance,'export async function addImportedPunchesBatchTx(',5000);
const plan=declaration(attendance,'async function applyApprovedOtPlanTx(',3000);

describe('automatic Attendance parents join the leave dependency interval first',()=>{
 it('the shared Attendance join is Access, then EXCLUSIVE configuration, then ordered employees',()=>{
  const join=declaration(attendance,'export async function lockAttendanceLeaveDependenciesTx(',200).text;
  inOrder(join,['await lockAccessConfigurationTx(tx, tenantId);','await lockLeaveDependencyConfigurationTx(tx, tenantId);','if (ids.length) await lockLeaveDependenciesTx(tx, tenantId, ids);']);
  expect(join).not.toContain('lockLeaveDependencyReadConfigurationTx');
 });
 it('checkOutTx joins before the subject key, device gate, day reads, plan application and credit banking',()=>{
  nothingBefore(checkOut.text,'await lockAttendanceLeaveDependenciesTx(tx, ctx, [p.employmentId]);');
  inOrder(checkOut.text,['const perform = async (tx: Tx) => {','await lockAttendanceLeaveDependenciesTx(tx, ctx, [p.employmentId]);','pg_advisory_xact_lock(',
   'enforceDeviceGateTx(','assertDayNotOwnedByCorrectionTx(','.from(attendance)','scheduleFor(tx, p.employmentId, p.date)','applyApprovedOtPlanTx(','maybeAutoAccrueOnApprovalTx(',
   "eventType: 'attendance.checked-out'",'return existingTx ? perform(existingTx) : withTenant(ctx, perform);']);
 });
 it('the decision owns the application interval before authority, workflow, schedule, plan and credit work',()=>{
  const owner=declaration(attendance,'async function lockAttendanceApplicationTx(',300).text;
  nothingBefore(owner,'await lockAttendanceLeaveDependenciesTx(tx, ctx, []);');
  inOrder(owner,['await lockAttendanceLeaveDependenciesTx(tx, ctx, []);','.from(attendanceCorrection)','await lockLeaveDependenciesTx(tx, ctx.tenantId, [visible.employmentId]);','pg_advisory_xact_lock(',".for('update')"]);
  nothingBefore(decide.text,'await lockAttendanceApplicationTx(tx, ctx, p.correctionId)');
  inOrder(decide.text,['await lockAttendanceApplicationTx(tx, ctx, p.correctionId)','assertCanDecideAttendanceApplicationTx(','decideAttendanceWorkflowStageTx(',
   'scheduleFor(tx, cor.employmentId, cor.attendanceDate)','applyApprovedOtPlanTx(','maybeAutoAccrueOnApprovalTx(','return existingTx?decide(existingTx):withTenant(ctx,decide);']);
 });
 it('imported-punch batches join before policy, day, plan and credit work, and the file command joins before mapping',()=>{
  nothingBefore(batch.text,'await lockAttendanceLeaveDependenciesTx(tx, ctx, days.map(day=>day.employmentId));');
  inOrder(batch.text,['await lockAttendanceLeaveDependenciesTx(tx, ctx, days.map(day=>day.employmentId));','lockAttendancePolicyImportTx(','.from(attendance)','applyApprovedOtPlanTx(','maybeAutoAccrueOnApprovalTx(']);
  const command=declaration(clockingImport,'export async function commitClockingImport(',2000).text;
  expect(command).toMatch(/return await withTenant\(ctx, async \(tx\) => \{\s*await lockAttendanceLeaveDependenciesTx\(tx,ctx,\[\]\);/);
  inOrder(command,['await lockAttendanceLeaveDependenciesTx(tx,ctx,[]);','await resolveMapping(tx, p.mappingId)','await decideLines(tx, mapping.def, p.text, ctx.tenantId)','.insert(clockingImportRun)','await addImportedPunchesBatchTx(tx, ctx, {']);
  const lines=declaration(clockingImport,'async function decideLines(',3000).text;
  // Nomination under the command's exclusive configuration, employee ownership, then a fresh comparison.
  inOrder(lines,['const emps = await readEmployments();','await lockLeaveDependenciesTx(tx,lockTenantId,ids);','const fresh=await readEmployments();','throw new LeaveDependencyUnavailable();','pg_advisory_xact_lock(','await assignPunchBusinessDays(']);
 });
 it('approved-plan application and automatic Leave Credit banking are reachable only from joined parents',()=>{
  expect(attendance).not.toContain('export async function applyApprovedOtPlanTx(');
  const parents=[checkOut,decide,batch];
  const planCalls=callSites(attendance,'applyApprovedOtPlanTx').filter(at=>at!==plan.start+'async function '.length);
  expect(planCalls).toHaveLength(4);
  for(const at of planCalls)expect(parents.some(parent=>at>parent.start&&at<parent.end),`unjoined plan application at offset ${at}`).toBe(true);
  const creditCalls=callSites(attendance,'maybeAutoAccrueOnApprovalTx');
  expect(creditCalls).toHaveLength(4);
  for(const at of creditCalls)expect([...parents,plan].some(parent=>at>parent.start&&at<parent.end),`unjoined automatic credit at offset ${at}`).toBe(true);
  // No other production source may call the automatic banking leaf around these parents.
  const files:string[]=[];
  const walk=(dir:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){
   if(entry.name==='node_modules'||entry.name.startsWith('.'))continue;
   const path=join(dir,entry.name);if(entry.isDirectory())walk(path);else if(/\.tsx?$/.test(entry.name))files.push(path);
  }};
  for(const dir of ['core','packs','app','lib','scripts'])walk(join(root,dir));
  expect(files.length).toBeGreaterThan(1000);
  const callers=files.filter(file=>readFileSync(file,'utf8').includes('maybeAutoAccrueOnApprovalTx(')).map(file=>relative(root,file).split('\\').join('/')).sort();
  expect(callers).toEqual(['core/attendance.ts','core/toil.ts']);
 });
});
