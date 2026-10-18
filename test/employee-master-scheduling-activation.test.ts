/** Actual activation owner with fictional process/filesystem adapters; no host/root/DB operations. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({command:vi.fn(),lstat:vi.fn(),open:vi.fn(),readFile:vi.fn(),readdir:vi.fn(),readlink:vi.fn(),realpath:vi.fn(),mkdir:vi.fn(),writeFile:vi.fn(),rename:vi.fn(),unlink:vi.fn(),link:vi.fn(),chmod:vi.fn(),trusted:vi.fn(),parents:vi.fn(),pins:vi.fn()}));
vi.mock('node:child_process',()=>({execFileSync:m.command}));
vi.mock('node:fs/promises',()=>({lstat:m.lstat,open:m.open,readFile:m.readFile,readdir:m.readdir,readlink:m.readlink,realpath:m.realpath,mkdir:m.mkdir,writeFile:m.writeFile,rename:m.rename,unlink:m.unlink,link:m.link,chmod:m.chmod}));
vi.mock('../lib/employee-master-dispatch',async importOriginal=>({...await importOriginal<typeof import('../lib/employee-master-dispatch')>(),readTrustedDispatchFile:m.trusted,assertDispatchRootParents:m.parents,readDispatchSourcePins:m.pins}));
import {activateReportScheduling,planReportScheduling} from '../deploy/identity-email/report-scheduling';
import {internalReportRunnerEnvironment} from '../deploy/identity-email/internal-report-install-model';
import {INTERNAL_REPORT_DISPATCH_ROOT as ROOT,INTERNAL_REPORT_DISPATCH_MARKER as MARKER,INTERNAL_REPORT_DISPATCH_CRON as CRON,INTERNAL_REPORT_DISPATCH_CRON_SOURCE as CRON_SOURCE,INTERNAL_REPORT_DISPATCH_LEGACY_LINE as LEGACY_LINE,INTERNAL_REPORT_DISPATCH_LAUNCHER as LAUNCHER} from '../lib/employee-master-dispatch';
const pins={'lib/employee-master-dispatch.ts':'a'.repeat(64),'scripts/provision-runner.ts':'b'.repeat(64)},unit='fictional-web.service',runnerPath='/etc/aihr-internal-report/runner.env';
const app='postgres://ai_hr_app:fictional@127.0.0.1:5432/fictional_report',owner=app.replace('ai_hr_app','fictional_owner');
let files:Map<string,Buffer>,webFlag:string|undefined,runnerFlag:boolean,driftOnDrain:(()=>void)|undefined;
const missing=()=>Object.assign(new Error('Absent fictional file'),{code:'ENOENT'});
const runner=()=>Buffer.from(internalReportRunnerEnvironment({origin:'https://fictional.invalid',appDatabase:app,ownerDatabase:owner,scheduledEmailEnabled:runnerFlag}));
beforeEach(()=>{
 vi.clearAllMocks();files=new Map();webFlag='true';runnerFlag=true;driftOnDrain=undefined;
 m.pins.mockResolvedValue(pins);m.parents.mockResolvedValue(undefined);m.mkdir.mockResolvedValue(undefined);m.chmod.mockResolvedValue(undefined);
 m.command.mockImplementation((program:string,args:string[])=>{
  if(program==='systemctl'){
   if(['list-unit-files','list-units'].includes(args[0]))return '';
   const property=args.find(value=>value.startsWith('--property='))?.slice(11);
   const values:Record<string,string>={LoadState:'loaded',ActiveState:'active',WorkingDirectory:ROOT,User:'fictional-web',Group:'fictional-web',MainPID:'1234',DynamicUser:'no'};
   if(args[0]==='show'&&args[1]===unit&&property&&Object.hasOwn(values,property))return values[property]+'\n';
  }
  if(program==='id'&&args.join(' ')==='-u fictional-web')return '1001\n';
  if(program==='getent'){
   if(args.join(' ')==='passwd')return 'fictional-runner:x:1002:1002:Fixture:/nonexistent:/usr/sbin/nologin\n';
   if(args.join(' ')==='group fictional-web')return 'fictional-web:x:1001:\n';
   if(args[0]==='group'&&['1002','fictional-runner'].includes(args[1]))return 'fictional-runner:x:1002:\n';
  }
  if(program==='crontab'&&args.join(' ')==='-u fictional-runner -l')return LEGACY_LINE+'\n';
  throw new Error('Unexpected command in activation fixture: '+program+' '+args.join(' '));
 });
 m.lstat.mockImplementation(async(path:string)=>{
  if(path===MARKER||path===CRON){if(!files.has(path))throw missing();return {uid:0,mode:0o644};}
  if(path==='/proc/1234')return {uid:1001};
  if(path==='/proc/777')return {uid:1002};
  if(path==='/run/aihr-internal-report.sock')return {isSocket:()=>true,mode:0o660,gid:1002};
  if(path==='/var/lib/aihr-internal-report-schedule')return {isDirectory:()=>true,uid:0,mode:0o700};
  throw new Error('Unexpected lstat: '+path);
 });
 m.readFile.mockImplementation(async(path:string)=>{
  if(path==='/proc/1234/cgroup')return '0::/system.slice/'+unit+'\n';
  if(path==='/proc/1234/environ')return Object.entries({AUTH_PROVIDER:'internal',AUTH_PUBLIC_ORIGIN:'https://fictional.invalid',AUTH_SESSION_KEY:'a'.repeat(64),DATABASE_URL:app,...(webFlag===undefined?{}:{EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED:webFlag})}).map(([key,value])=>key+'='+value).join('\0')+'\0';
  throw new Error('Unexpected readFile: '+path);
 });
 m.trusted.mockImplementation(async(path:string,max:number,mode:number)=>{
  if(path===runnerPath){expect(max).toBe(16384);expect(mode).toBe(0o600);return runner();}
  if(path===LAUNCHER)return Buffer.from('fictional installed launcher');
  const value=files.get(path);if(!value)throw missing();return value;
 });
 m.realpath.mockImplementation(async(path:string)=>path);
 m.readdir.mockImplementation(async(path:string)=>{if(path==='/proc'){driftOnDrain?.();return [];}if(path==='/etc/cron.d')return [];throw new Error('Unexpected readdir: '+path);});
 m.open.mockImplementation(async(path:string)=>{
  const bytes=path==='/etc/crontab'?Buffer.alloc(0):path==='/proc/777/cmdline'?Buffer.from('/opt/node20/bin/node\0--env-file=.env.production\0--import\0tsx\0scripts/provision-runner.ts\0'):Buffer.from('fictional executable');
  const stat={isFile:()=>true,uid:0,mode:0o100755,size:bytes.length,ino:1,mtimeMs:1,ctimeMs:1};
  return {stat:async(options?:{bigint?:boolean})=>options?.bigint?{...stat,uid:BigInt(0),mode:BigInt(stat.mode),size:BigInt(bytes.length),ino:BigInt(1),mtimeNs:BigInt(1),ctimeNs:BigInt(1)}:stat,read:async(buffer:Buffer,offset:number,length:number,position:number)=>({bytesRead:bytes.copy(buffer,offset,position,Math.min(bytes.length,position+length))}),close:vi.fn().mockResolvedValue(undefined)};
 });
 m.writeFile.mockImplementation(async(path:string,bytes:Uint8Array)=>{if(files.has(path))throw new Error('Unexpected overwrite');files.set(path,Buffer.from(bytes));});
 m.link.mockImplementation(async(from:string,to:string)=>{if(files.has(to)||!files.has(from))throw new Error('Unexpected link');files.set(to,Buffer.from(files.get(from)!));});
 m.rename.mockImplementation(async(from:string,to:string)=>{if(!files.has(from))throw missing();files.set(to,files.get(from)!);files.delete(from);});
 m.unlink.mockImplementation(async(path:string)=>{if(!files.delete(path))throw missing();});
});
describe('root scheduling capability admission and drain recheck',()=>{
 it.each([undefined,'false','TRUE','1'])('permits read-only planning but refuses held actual-web value %s before publication',async value=>{
  webFlag=value;const plan=await planReportScheduling(unit,pins);
  await expect(activateReportScheduling(unit,pins,plan.inventorySha256)).rejects.toThrow('held');expect(m.writeFile).not.toHaveBeenCalled();expect(files.size).toBe(0);
 });
 it('ignores a caller opt-in when the actual PID environment holds scheduling',async()=>{
  vi.stubEnv('EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED','true');webFlag='false';
  try{const plan=await planReportScheduling(unit,pins);await expect(activateReportScheduling(unit,pins,plan.inventorySha256)).rejects.toThrow('held');expect(m.writeFile).not.toHaveBeenCalled();}finally{vi.unstubAllEnvs();}
 });
 it('refuses a stale held installed runner even when actual web is enabled',async()=>{
  runnerFlag=false;const plan=await planReportScheduling(unit,pins);await expect(activateReportScheduling(unit,pins,plan.inventorySha256)).rejects.toThrow('held');expect(m.writeFile).not.toHaveBeenCalled();
 });
 it.each(['web','runner'] as const)('retains paused admission without publishing cron when %s is held during drain',async source=>{
  const plan=await planReportScheduling(unit,pins);driftOnDrain=()=>{if(source==='web')webFlag='false';else runnerFlag=false;};
  await expect(activateReportScheduling(unit,pins,plan.inventorySha256)).rejects.toThrow('held');
  expect(JSON.parse(files.get(MARKER)!.toString()).state).toBe('paused');expect(files.has(CRON)).toBe(false);expect(m.rename).not.toHaveBeenCalled();
 });
 it('rechecks the hold after a pinned pre-handoff process actually leaves the drain set',async()=>{
  const plan=await planReportScheduling(unit,pins);let scans=0,statReads=0;
  const fields=['S',...Array.from({length:18},()=> '0'),'12345','0'],stat='777 (fixture node) '+fields.join(' ');
  const baseRead=m.readFile.getMockImplementation()!;
  m.readlink.mockImplementation(async(path:string)=>path.endsWith('/cwd')?ROOT:'/opt/node20/bin/node');
  m.readdir.mockImplementation(async(path:string)=>{if(path==='/etc/cron.d')return [];if(path==='/proc'){scans++;if(scans===1)return ['777'];webFlag='false';return [];}throw new Error('Unexpected process scan');});
  // The initial scan pins this exact process. It disappears before the drain's lifetime recheck.
  m.readFile.mockImplementation(async(path:string)=>{if(path==='/proc/777/stat'){statReads++;if(statReads>1)throw missing();return stat;}return baseRead(path);});
  await expect(activateReportScheduling(unit,pins,plan.inventorySha256)).rejects.toThrow('held');
  expect(scans).toBe(2);expect(statReads).toBe(2);expect(JSON.parse(files.get(MARKER)!.toString()).state).toBe('paused');expect(files.has(CRON)).toBe(false);
 });
 it('publishes canonical active dispatch only after matching true configuration survives drain',async()=>{
  const plan=await planReportScheduling(unit,pins),result=await activateReportScheduling(unit,pins,plan.inventorySha256);
  expect(JSON.parse(files.get(MARKER)!.toString())).toMatchObject({installationId:result.installationId,state:'active',sourcePins:pins});expect(files.get(CRON)?.toString()).toBe(CRON_SOURCE);
  expect(m.trusted.mock.calls.filter(([path])=>path===runnerPath)).toHaveLength(2);expect(m.readdir.mock.calls.filter(([path])=>path==='/proc')).toHaveLength(2);
  const writes=m.writeFile.mock.calls.map(([,bytes])=>Buffer.from(bytes).toString());expect(writes.filter(value=>value.startsWith('{')&&JSON.parse(value).purpose==='aihr-internal-report-dispatch').map(value=>JSON.parse(value).state)).toEqual(['paused','active']);
 });
});
