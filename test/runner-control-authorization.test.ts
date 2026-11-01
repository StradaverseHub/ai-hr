import {describe,it,expect,vi} from 'vitest';
vi.mock('server-only',()=>({}));
vi.mock('../lib/demo-mode',()=>({isDemoDeployment:()=>false}));
import {configureRunner} from '../lib/runner-control';
import type {SessionContext} from '../db/client';
describe('runner control server authorization',()=>{
 it('refuses customer admin and flattened operator role before contacting the scheduler port',async()=>{
  const input={id:'reviews',revision:'a'.repeat(64),enabled:true,schedule:null};
  for(const grants of [[],[{role:'hr_admin',companyId:null}],[{role:'super_admin',companyId:null}]]){
   await expect(configureRunner({tenantId:'11111111-1111-1111-1111-111111111111',userId:'22222222-2222-2222-2222-222222222222',roles:['operator'],grants} as SessionContext,input)).rejects.toThrow('Only an installation operator');
  }
 });
});
