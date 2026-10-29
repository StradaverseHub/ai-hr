/** WP12 (R20): the server-side AI alert check behind scripts/ai-alerts.ts, routed to humans by deploy/cron-alert.sh.
 *
 * OWNER CONNECTION, READ ONLY. It reads, per active tenant, the last 24 hours of ai_model_run, this Kuala Lumpur
 * month's private USD allocation ledger against the tenant monthly cap, and the configured-vs-effective drift that
 * SQL alone can see (a `feature:` policy row for a setting-backed feature, which admission ignores since 0692). The
 * thresholds and the evaluation are the AI management banner's (lib/ai/ai-inventory.ts evaluateAiAlerts).
 *
 * Covered here: failure rate, scheduled-agent refusals, this month's USD allocation against the tenant cap (and a
 * breach), and switch drift by the stale-override rule (staleOverrideDisagrees, the banner's own rule).
 * NOT covered here (the banner covers them for a signed-in group administrator): token/request allowance meters
 * per login/company, module-off or platform-restricted switches, and unattributed agent switches — each needs
 * the tenant's entitlement resolution in a session context.
 *
 * Output names a tenant id and alert kinds and counts only: no person, model text or HR value.
 */
import {sql} from 'drizzle-orm';
import type {Db} from '../db/client';
import {evaluateAiAlerts,staleOverrideDisagrees,type AiAlert,type SwitchDrift} from '../lib/ai/ai-inventory';

export type AiAlertSweep={tenantsChecked:number;tenantsFailed:number;tenantsAlerting:number;alerts:{tenantId:string;alert:AiAlert}[]};
const MONTH_START=sql`(date_trunc('month',now() at time zone 'Asia/Kuala_Lumpur') at time zone 'Asia/Kuala_Lumpur')`;

export async function aiAlertSweep(owner:Db,log:(line:string)=>void=()=>{}):Promise<AiAlertSweep>{
 const tenants=Array.from(await owner.execute<{id:string}>(sql`select id from tenant where status in ('active','trial') order by id`));
 const out:AiAlertSweep={tenantsChecked:0,tenantsFailed:0,tenantsAlerting:0,alerts:[]};
 for(const {id} of tenants){
  try{
   const alerts=await owner.transaction(async tx=>{
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const [runs]=await tx.execute<{admitted:string;failed:string;principal:string}>(sql`select
      count(*) filter(where state<>'blocked') as admitted,count(*) filter(where state='failed') as failed,
      count(*) filter(where state='blocked' and user_id is null) as principal
     from ai_model_run where tenant_id=${id}::uuid and operation<>'probe' and started_at>=now()-interval '24 hours'`);
    const [spend]=await tx.execute<{cap:string|null;used:string|null;breached:boolean}>(sql`select
      (select monthly_nanos::text from app.ai_spend_budget where tenant_id=${id}::uuid and scope_key='tenant') as cap,
      (select coalesce(sum(coalesce(confirmed_nanos,reserved_nanos)),0)::text from app.ai_spend_reservation
        where tenant_id=${id}::uuid and state in ('held','confirmed','breach') and created_at>=${MONTH_START}) as used,
      exists(select 1 from app.ai_spend_reservation where tenant_id=${id}::uuid and state='breach') as breached`);
    // The setting is resolved with the entitlement snapshot's provenance rule (core/entitlements.ts snapshotQuery, 0692):
    // a customer-written row on a platform-scoped key is not a value; no stored value means the default.
    const stale=Array.from(await tx.execute<{feature_id:string;override_on:boolean;switch_on:boolean}>(sql`select p.feature_id,p.enabled as override_on,
      coalesce((select nullif(t.value,'null'::jsonb) from tenant_setting t where t.tenant_id=p.tenant_id and t.key=d.key and (d.scope='tenant' or t.source<>'customer')),d.default_value)='true'::jsonb as switch_on
      from ai_control_policy p join app.ai_feature_setting s on s.feature_id=p.feature_id join setting_definition d on d.key=s.setting_key
      where p.tenant_id=${id}::uuid and p.kind='feature' order by p.feature_id`));
    const drift:SwitchDrift[]=stale.filter(r=>staleOverrideDisagrees(r.override_on===true,r.switch_on===true)).map(r=>({featureId:r.feature_id,reason:'stale_override'}));
    return evaluateAiAlerts({runs24h:{admitted:Number(runs?.admitted??0),failed:Number(runs?.failed??0)},principalRefusals24h:Number(runs?.principal??0),
     spend:spend?.cap!=null?{usedNanos:BigInt(spend.used??'0'),capNanos:BigInt(spend.cap)}:null,spendBreached:spend?.breached===true,
     allowancesAt:0,allowancesNear:0,drift});
   });
   out.tenantsChecked++;
   if(alerts.length){out.tenantsAlerting++;for(const alert of alerts){out.alerts.push({tenantId:id,alert});log(`ai-alert tenant=${id} kind=${alert.kind} level=${alert.level} count=${alert.count}${alert.detail?` detail=${alert.detail}`:''}`);}}
  }catch(error){
   out.tenantsFailed++;
   log(`ai-alert tenant=${id} check-failed ${(error as Error).name}`);
  }
 }
 return out;
}

/** 0 nothing to report; 3 at least one alert (deploy/cron-alert.sh alerts on non-zero); 2 a tenant could not be
 * checked, which outranks a finding (same convention as scripts/entitlement-alarm.ts). */
export function aiAlertExitCode(run:Pick<AiAlertSweep,'tenantsFailed'|'alerts'>):0|2|3{
 return run.tenantsFailed>0?2:run.alerts.length>0?3:0;
}
