/** Owned-database, plan-phase-only logging. This grants no application capability. */
import {createHash} from 'node:crypto';
import {expect} from 'vitest';
import {owner} from '../harness';
const changes={session_preload_libraries:'auto_explain','auto_explain.log_min_duration':'0','auto_explain.log_parameter_max_length':'0',
 'auto_explain.log_analyze':'on','auto_explain.log_buffers':'on','auto_explain.log_settings':'on','auto_explain.log_format':'json',
 'auto_explain.log_timing':'off','auto_explain.log_nested_statements':'on','auto_explain.sample_rate':'1'}as const;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const literal=(value:string)=>"'"+value.replace(/'/g,"''")+"'";
async function settings(){const [row]=await owner.client`select coalesce((select s.setconfig from pg_db_role_setting s
 where s.setdatabase=(select oid from pg_database where datname=current_database()) and s.setrole=0),'{}'::text[]) as config`;
 const value:unknown=row?.config;if(!Array.isArray(value)||value.some(entry=>typeof entry!=='string'||entry.indexOf('=')<1))throw Error('Native database settings array required');
 return value.map(entry=>String(entry));}
export async function employeeChoicePlanLogging(database:string){
 expect(database).toMatch(/^ai_hr_test_w(?:_[a-z0-9_]{1,20})?[1-9][0-9]*$/);
 const [identity]=await owner.client`select current_user as role,current_database() as database,inet_server_addr()='127.0.0.1'::inet as loopback`;
 expect(identity).toEqual({role:'postgres',database,loopback:true});
 const before=await settings(),previous=new Map(before.map(value=>{const index=value.indexOf('=');return[value.slice(0,index),value.slice(index+1)];}));
 expect(previous.get('session_preload_libraries')??'').toBe('');
 const expected=[...before];
 for(const [key,value]of Object.entries(changes)){
  const index=expected.findIndex(entry=>entry.startsWith(key+'='));if(index<0)expected.push(key+'='+value);else expected[index]=key+'='+value;
 }
 await owner.client.begin(async tx=>{
  expect(await settings()).toEqual(before);
  for(const [key,value]of Object.entries(changes))await tx.unsafe('alter database "'+database+'" set "'+key+'" to '+literal(value));
  const [after]=await tx`select setconfig as config from pg_db_role_setting where setdatabase=(select oid from pg_database where datname=current_database()) and setrole=0`;
  expect(after.config).toEqual(expected);
 });
 let restored=false;
 return {settings:changes,beforeSha256:hash(before),instrumentedSha256:hash(expected),
  async restore(){
   if(restored)return;
   await owner.client.begin(async tx=>{
    expect(await settings()).toEqual(expected); // Refuse unknown/concurrent changes; never RESET ALL.
    for(const key of Object.keys(changes).reverse()){
     const prior=previous.get(key);
     await tx.unsafe('alter database "'+database+'" '+(prior===undefined?'reset "'+key+'"':'set "'+key+'" to '+literal(prior)));
    }
    const [after]=await tx`select coalesce((select setconfig from pg_db_role_setting where setdatabase=(select oid from pg_database where datname=current_database()) and setrole=0),'{}'::text[]) as config`;
    expect(after.config).toEqual(before);
   });
   restored=true;
  }};
}

