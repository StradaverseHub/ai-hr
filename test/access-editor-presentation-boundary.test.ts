/** Adapter protocol controls only; native authority lives in the separate native cases. */
import {beforeEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PgDialect} from 'drizzle-orm/pg-core';
import type {SQL} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
const port=vi.hoisted(()=>({withTenant:vi.fn()}));
vi.mock('../db/client',()=>port);
import {readAccessConfigurationEditor} from '../core/access-configuration-editor';
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const context=():SessionContext=>({tenantId:id(1),userId:id(2),roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]});
const initialized=()=>({read_status:'initialized',state:{snapshot:{tenantId:id(1),revision:id(5),users:[{id:id(2),active:true}],groups:[{id:id(3),name:'Fictional group',retired:false,systemAdministrator:true,grants:[]}],memberships:[],overrides:[]},catalog:[{id:'access.configure',scope:'tenant',supported:true,bindings:[{owner:'native-access-owner',operation:'write'}]}],companyIds:[id(4)],coverage:[],recoveryUserIds:[id(2)],scopeFingerprint:'a'.repeat(64)},metadata:{users:[{id:id(2),label:'Fictional owner'}],companies:[{id:id(4),label:'Fictional company'}],history:[]}});
const uninitialized=()=>({read_status:'uninitialized',state:null,metadata:null});
const dialect=new PgDialect();
let statements:string[],contexts:SessionContext[];
function replies(values:(unknown[]|Error)[]){
 port.withTenant.mockImplementation(async(ctx:SessionContext,read:(tx:Tx)=>Promise<unknown>)=>{
  contexts.push(ctx);const value=values.shift();
  const tx={execute:async(query:SQL)=>{statements.push(dialect.sqlToQuery(query).sql);if(value instanceof Error)throw value;return value;}} as unknown as Tx;
  return read(tx);
 });
}
beforeEach(()=>{port.withTenant.mockReset();statements=[];contexts=[];});
it('pins the independently frozen old locked editor',()=>{
 // d9dfbaf15 (reader/writer Access lock) renamed the exclusive lock lockAccessConfigurationTx to
 // lockAccessConfigurationWriteTx in the frozen editor too: the same EXCLUSIVE hold, so the frozen behaviour is unchanged.
 const frozen=readFileSync('test/fixtures/access-editor-locked-baseline.ts','utf8');
 expect(frozen).toContain('await lockAccessConfigurationWriteTx(tx,ctx.tenantId);');
 expect(createHash('sha256').update(frozen).digest('hex')).toBe('9623ca8823b6b7dea97602d82171a6bc9e3f81019dda01828180161650873677');
});
it('uses one RR/RO read for initialized state and exposes only existing minimized editor props',async()=>{
 replies([[initialized()]]);const page=await readAccessConfigurationEditor(context());
 expect(port.withTenant).toHaveBeenCalledTimes(1);expect(port.withTenant.mock.calls[0][2]).toEqual({readOnlySnapshot:true});
 expect(statements).toEqual(['select * from app.access_editor_presentation_v1()']);
 expect(page.capabilities).toEqual([{id:'access.configure',scope:'tenant',supported:true}]);
 for(const privateKey of ['catalog','bindings','evidence','recoveryUserIds','companyIds','coverage'])expect(page).not.toHaveProperty(privateKey);
 expect(page.users).toEqual([{id:id(2),label:'Fictional owner'}]);
});
it('only explicit native uninitialized performs the unchanged RC command then a fresh RR/RO read with captured context',async()=>{
 replies([[uninitialized()],[{access_configuration_initialize:true}],[initialized()]]);
 const supplied=context(),pending=readAccessConfigurationEditor(supplied);
 supplied.tenantId=id(99);supplied.userId=id(98);supplied.roles![0]='employee';supplied.grants![0].role='employee';
 const page=await pending;expect(page.snapshot.tenantId).toBe(id(1));
 expect(statements).toEqual(['select * from app.access_editor_presentation_v1()','select app.access_configuration_initialize()','select * from app.access_editor_presentation_v1()']);
 expect(port.withTenant.mock.calls.map(call=>call[2])).toEqual([{readOnlySnapshot:true},undefined,{readOnlySnapshot:true}]);
 expect(contexts).toEqual([context(),context(),context()]);
});
it('refuses missing, repeated, unknown or malformed native statuses without bootstrapping',async()=>{
 for(const rows of [[],[initialized(),initialized()],[null],[{...uninitialized(),state:{}}],[{...uninitialized(),metadata:{}}],[{...uninitialized(),extra:true}],[{...uninitialized(),read_status:'unknown'}],[{read_status:'uninitialized'}],[{...initialized(),state:null}],[{...initialized(),metadata:null}]]){
  port.withTenant.mockReset();statements=[];replies([rows]);await expect(readAccessConfigurationEditor(context())).rejects.toMatchObject({code:'invalid'});
  expect(statements).toEqual(['select * from app.access_editor_presentation_v1()']);
 }
});
it('does not turn permission, storage, lock or transport failures into first use',async()=>{
 for(const code of ['42501','55000','55P03','XX000','ECONNRESET']){
  const failure=Object.assign(Error('Fictional native refusal'),{code});port.withTenant.mockReset();statements=[];replies([failure]);
  const pending=readAccessConfigurationEditor(context());if(code==='42501')await expect(pending).rejects.toMatchObject({code:'ceiling'});else await expect(pending).rejects.toBe(failure);
  expect(statements).toEqual(['select * from app.access_editor_presentation_v1()']);
 }
});
it('preserves permission refusal if authority is lost at initialization and refuses a second uninitialized result',async()=>{
 replies([[uninitialized()],Object.assign(Error('Fictional revoked bootstrap'),{code:'42501'})]);
 await expect(readAccessConfigurationEditor(context())).rejects.toMatchObject({code:'ceiling'});expect(statements).toHaveLength(2);
 port.withTenant.mockReset();statements=[];replies([[uninitialized()],[{access_configuration_initialize:false}],[uninitialized()]]);
 await expect(readAccessConfigurationEditor(context())).rejects.toMatchObject({code:'invalid'});expect(statements).toHaveLength(3);
});
