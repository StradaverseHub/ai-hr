/** Standalone staging operator CLI for the Noveri conversation switch. NEVER import db/client (its singleton
 * application pools are unrelated). See scripts/operator/teras-conversation-switch-core.ts for the rules.
 *
 *   TERAS_SWITCH_OWNER_DATABASE_URL=… node --import tsx scripts/operator/teras-conversation-switch.ts \
 *     --environment staging --operator <label>                       # dry run: identity and every tenant's state
 *   … --apply --expected-database-identity <hex> --confirm-fictional-data   # switch on for every staging tenant
 *   … --apply --off --expected-database-identity <hex>                       # switch off again
 *
 * The URL is the table owner's (row-level security does not apply to it); it is read from the environment, never
 * from the command line. Follow the shared staging queue and lease (docs/STAGING-RELEASE-QUEUE.md). */
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import postgres from 'postgres';
import {parseSwitchArguments,runSwitch,SwitchRefused,type SwitchDatabase} from './teras-conversation-switch-core';

export function switchDatabase(sql:ReturnType<typeof postgres>):SwitchDatabase{
 return{
  async identity(){
   const [row]=await sql<{id:string;name:string}[]>`select d.oid::text||':'||coalesce(inet_server_addr()::text,'local')||':'||coalesce(inet_server_port()::text,'') as id,d.datname as name
    from pg_database d where d.datname=current_database()`;
   return createHash('sha256').update('teras-conversation-switch\n'+row.id+'\n'+row.name).digest('hex');
  },
  async tenants(){
   const rows=await sql<{tenant_id:string;tenant_name:string;enabled:boolean|null}[]>`select t.id as tenant_id,t.name as tenant_name,c.enabled
    from public.tenant t left join public.teras_worker_control c on c.tenant_id=t.id and c.worker_id='conversation' order by t.name,t.id`;
   return rows.map(row=>({tenantId:row.tenant_id,tenantName:row.tenant_name,enabled:row.enabled===true}));
  },
  async apply(tenantId,enabled,operator,from){
   return sql.begin(async tx=>{
    const [row]=await tx<{version:number}[]>`insert into public.teras_worker_control(tenant_id,worker_id,enabled,changed_by_user_id,changed_by_operator,attested_provider,changed_at)
     values(${tenantId},'conversation',${enabled},null,${operator},null,now())
     on conflict(tenant_id,worker_id) do update set enabled=excluded.enabled,changed_by_user_id=null,changed_by_operator=excluded.changed_by_operator,attested_provider=null,changed_at=now()
     returning version`;
    await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
     values(${tenantId},'teras-worker',${tenantId},${enabled?'teras-worker.enabled':'teras-worker.disabled'},'system',null,
      ${tx.json({workerId:'conversation',from,to:enabled,version:row.version,operator,environment:'staging',attestedProvider:null})})`;
    return row.version;
   }) as Promise<number>;
  },
 };
}

async function main(args:readonly string[]){
 const options=parseSwitchArguments(args);
 const url=process.env.TERAS_SWITCH_OWNER_DATABASE_URL;if(!url)throw new SwitchRefused('TERAS_SWITCH_OWNER_DATABASE_URL is not set');
 const sql=postgres(url,{max:1,connect_timeout:5,idle_timeout:5,onnotice:()=>{}});
 try{process.stdout.write(JSON.stringify(await runSwitch(switchDatabase(sql),options),null,1)+'\n');}
 finally{await sql.end({timeout:5});}
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)main(process.argv.slice(2)).catch(error=>{process.stderr.write((error instanceof SwitchRefused?error.message:'Conversation switch failed. Nothing was confirmed as changed.')+'\n');process.exitCode=1;});
