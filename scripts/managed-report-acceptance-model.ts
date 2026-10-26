/** Import-safe contract for one owned disposable internal-mode Linux journey. No Auth/DB runtime. */
import {z} from 'zod';
import {LEGACY_MODULE_ENV_GATES,LEGACY_SETTING_ENV_GATES} from '../packs/catalog';
import {employeeMasterScheduledEmailEnabled} from '../lib/employee-master-scheduled-email';
export const REPORT_ACCEPTANCE_DATABASE='ai_hr_report_delivery_acceptance';
export const REPORT_ACCEPTANCE_ORIGIN='https://localhost:3543';
export const REPORT_ACCEPTANCE_TENANT='Managed Reports acceptance fictional tenant';
export const REPORT_ACCEPTANCE_EMAILS={owner:'owner@report-acceptance.invalid',recipient:'recipient@report-acceptance.invalid'} as const;
export const REPORT_ACCEPTANCE_ROOT='/opt/ai-hr',REPORT_ACCEPTANCE_STAGING='/root/aihr-report-acceptance';
const hash=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.uuid();
export const internalReportAcceptanceMarker=z.object({version:z.literal(2),purpose:z.literal('disposable-internal-report-acceptance'),vm:z.literal('board16-report-linux'),database:z.literal(REPORT_ACCEPTANCE_DATABASE),candidateRoot:z.literal(REPORT_ACCEPTANCE_ROOT),origin:z.literal(REPORT_ACCEPTANCE_ORIGIN),runId:uuid,candidateSha:z.string().regex(/^[a-f0-9]{40}$/),machineSha256:hash,fixtureSha256:hash,installerSha256:hash,componentsSha256:hash,caSha256:hash,certificateSha256:hash,serverKeySha256:hash,nodeSha256:hash,runtimePath:z.string().regex(/^\/[a-zA-Z0-9_./-]+$/).max(4096).refine(value=>!value.split('/').includes('..')),webUnit:z.literal('aihr-report-acceptance.service')}).strict();
export const reportAcceptanceHumanReady=z.object({version:z.literal(1),runId:uuid,candidateSha:z.string().regex(/^[a-f0-9]{40}$/),reviewedInventorySha256:hash,reports:z.object({weekly:z.object({reportId:uuid,scheduleId:uuid}).strict(),monthly:z.object({reportId:uuid,scheduleId:uuid}).strict()}).strict()}).strict().refine(value=>value.reports.weekly.reportId!==value.reports.monthly.reportId&&value.reports.weekly.scheduleId!==value.reports.monthly.scheduleId);
export type ReportAcceptanceHumanReady=z.infer<typeof reportAcceptanceHumanReady>;
export function reportAcceptanceMode(args:readonly string[]):'prepare'|'configure'|'verify'|'verify-residual'{if(args.length!==1||!['prepare','configure','verify','verify-residual'].includes(args[0]))throw new Error('Choose one closed report acceptance stage.');return args[0] as 'prepare'|'configure'|'verify'|'verify-residual';}
export function reportAcceptanceDatabase(value:string,role?:string){const url=new URL(value);if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||(url.port||'5432')!=='5432'||url.pathname!=='/'+REPORT_ACCEPTANCE_DATABASE||url.search||url.hash||!url.username||!url.password||role&&decodeURIComponent(url.username)!==role)throw new Error('Only the reviewed disposable database and actual role are permitted.');return url;}
export function reportAcceptanceSameEndpoint(a:URL,b:URL){if(a.hostname!==b.hostname||(a.port||'5432')!==(b.port||'5432')||a.pathname!==b.pathname||a.username===b.username)throw new Error('Require separate roles on one exact disposable database endpoint.');}

/** Pure projection from a copied caller snapshot and the reviewed active web environment. This does
 * not decide module availability: it copies the complete catalog inputs for the isolated fixture.
 * Scheduling capability is separate: derive the canonical literal from verified web, never caller.
 * Validate every caller authority value before returning any mutation plan; errors contain no values. */
export function reportAcceptanceEnvironmentProjection(caller:Readonly<Record<string,string|undefined>>,web:Readonly<Record<string,string>>,migrationUrl:string){
 for(const name of ['AUTH_PROVIDER','AUTH_PUBLIC_ORIGIN','AUTH_SESSION_KEY','DATABASE_URL'] as const){
  if(caller[name]!==undefined&&caller[name]!==web[name])throw new Error('Caller cannot override active web Auth/database authority.');
 }
 const capability='EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED',enabled=employeeMasterScheduledEmailEnabled(web)?'true':'false';
 if(caller[capability]!==undefined&&caller[capability]!==enabled)throw new Error('Caller cannot override active web report scheduling capability.');
 const assign:Record<string,string|undefined>={AUTH_PROVIDER:web.AUTH_PROVIDER,AUTH_PUBLIC_ORIGIN:web.AUTH_PUBLIC_ORIGIN,AUTH_SESSION_KEY:web.AUTH_SESSION_KEY,DATABASE_URL:web.DATABASE_URL,[capability]:enabled};
 const clear=[...new Set([...Object.values(LEGACY_MODULE_ENV_GATES),...Object.values(LEGACY_SETTING_ENV_GATES)])].filter((name):name is string=>typeof name==='string'&&name.length>0);
 for(const name of clear)if(web[name]!==undefined)assign[name]=web[name];
 clear.push(capability,'DEV_TENANT_ID','DEV_USER_ID');
 Object.assign(assign,{ALLOW_DEMO_SESSION:'false',NODE_ENV:web.NODE_ENV??'production',MIGRATION_DATABASE_URL:migrationUrl});
 return {clear,assign};
}

const actor=z.object({userId:uuid,personId:uuid,employmentId:uuid}).strict();
export const reportAcceptanceBase=z.object({version:z.literal(2),candidateSha:z.string().regex(/^[a-f0-9]{40}$/),runId:uuid,tenantId:uuid,companyId:uuid,date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),owner:actor,recipient:actor,routes:z.object({login:z.string().refine(value=>value===REPORT_ACCEPTANCE_ORIGIN+'/login'),email:z.string().refine(value=>value===REPORT_ACCEPTANCE_ORIGIN+'/admin/settings/email'),policy:z.string().refine(value=>value===REPORT_ACCEPTANCE_ORIGIN+'/admin/settings/notifications'),consent:z.string().refine(value=>value===REPORT_ACCEPTANCE_ORIGIN+'/me/notifications'),newReport:z.string().refine(value=>value===REPORT_ACCEPTANCE_ORIGIN+'/reports/employee-master/new')}).strict()}).strict().refine(value=>value.owner.userId!==value.recipient.userId&&value.owner.personId!==value.recipient.personId&&value.owner.employmentId!==value.recipient.employmentId);
export type ReportAcceptanceBase=z.infer<typeof reportAcceptanceBase>;

export const reportAcceptanceComponents=z.object({'smtp-token-peer.py':hash,'internal-report-agent.cjs':hash,'report-auth-broker.cjs':hash,'report-renderer.cjs':hash,'internal-report-schedule.cjs':hash,'internal-report-tick':hash,'report-auth-peer.py':hash,'renderer-peer.py':hash,'verify-internal-report-isolation.py':hash}).strict();
