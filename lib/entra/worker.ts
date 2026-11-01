import { client } from '../../db/client';
import { todayInKualaLumpur } from '../hr-date';
import { connector, assertProvisioning } from './store';
import { EntraError, type WorkforceRecord } from './model';
import { graphToken, upload, reconcile, confirmedDirectoryObject } from './graph';
export async function runEntraWorker(limit=50,fetcher:typeof fetch=fetch) {
  let processed=0;const deadline=Date.now()+45_000;
  while(Date.now()<deadline&&processed<Math.min(500,Math.max(1,limit))){
    const rows=await client.unsafe<WorkforceRecord[]>('select * from app.entra_claim($1::date)',[todayInKualaLumpur()]);
    if(!rows[0])break;
    const record=rows[0];
    let status='failed',location=record.last_location,delay=60;
    try{
      const config=await connector(record.tenant_id);
      if(!config?.provisioningEnabled)throw new EntraError('forbidden');
      await assertProvisioning(config);
      if(record.last_status==='uncertain'&&!location){status='uncertain';delay=3600;}
      else {
        let token:string;try{token=await graphToken(config,fetcher);}catch(e){if(e instanceof EntraError&&e.code==='uncertain')throw new EntraError('unavailable',e.retryAfter);throw e;}
        let directoryComplete=record.last_status==='awaiting-sync';
        if(location&&['submitted','uncertain'].includes(record.last_status)){
          const result=await reconcile(config,record,token,fetcher);
          if(result.state==='complete'){
            location=null;
            if(Number(record.submitted_revision)!==Number(record.revision))status='pending';
            else directoryComplete=true;
          }else status=result.state==='pending'?'submitted':'rejected';
        }else if(!directoryComplete){
          await assertProvisioning(config);location=await upload(config,record,token,fetcher);status='submitted';
        }
        if(directoryComplete){
            const object=await confirmedDirectoryObject(config,record,token,fetcher);
            if(!object)status='awaiting-sync';
            else {
              await assertProvisioning(config);
              if(!config.enabled){status=record.active?'ready':'disabled';}
              else {
              const linked=await client.unsafe('select app.entra_auto_bind($1::uuid,$2::uuid,$3::bigint,$4::uuid,$5::uuid) linked',[record.tenant_id,record.person_id,record.revision,record.lease,object]);
              status=!record.active?'disabled':linked[0]?.linked?'ready':'awaiting-link';
              }
            }
        }
      }
    }catch(e){
      status=e instanceof EntraError&&e.code==='unavailable'?(record.last_status==='awaiting-sync'?'awaiting-sync':record.last_location?'submitted':'pending'):e instanceof EntraError&&e.code==='throttled'?(record.last_location?'submitted':'pending'):e instanceof EntraError&&e.code==='uncertain'?'uncertain':'failed';
      delay=e instanceof EntraError?e.retryAfter:60;
    }
    const active=record.last_location?record.last_active:record.active;
    await client.unsafe('select app.entra_finish($1::uuid,$2::uuid,$3::bigint,$4::uuid,$5,$6,$7,$8::int)',[record.tenant_id,record.person_id,record.revision,record.lease,status,location,active,delay]);
    processed++;
  }
  return {processed};
}
