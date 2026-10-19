/** Source/validation regressions only; controlled concurrent database journeys remain separate evidence. */
import {readFileSync} from 'node:fs';
import {describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import {EMPTY_PROFILE_ROUTING} from '../lib/profile-routing-policy';
const state=vi.hoisted(()=>({policy:undefined as unknown}));
vi.mock('../core/entitlements',()=>({getSetting:()=>state.policy,resolveEntitlementsTx:vi.fn()}));
import {readProfileRoutingPolicy} from '../core/profile-routing';
const source=readFileSync(new URL('../core/profile-routing.ts',import.meta.url),'utf8');
function section(start:string,end:string){
 const first=source.indexOf(start),last=source.indexOf(end,first+start.length);
 expect(first).toBeGreaterThanOrEqual(0);expect(last).toBeGreaterThan(first);
 const body=source.slice(first,last);expect(body.length).toBeGreaterThan(100);return body;
}
describe('named route snapshot coherence',()=>{
 it('locks the subject context before choosing rules/principal, using one KL effective date',()=>{
  const body=section('export async function resolveProfileRouteTx(', 'export async function assertProfileRouteDecisionTx(');
  const snapshot=body.indexOf('await subjectContext(tx,ctx,subjectId,asOf)'),match=body.indexOf('await routeTargets(tx,rule,subjectId,asOf)'),principal=body.indexOf('await namedPrincipal(');
  expect(snapshot).toBeGreaterThanOrEqual(0);expect(match).toBeGreaterThan(snapshot);expect(principal).toBeGreaterThan(match);
  expect(body.match(/todayInKualaLumpur\(\)/g)).toHaveLength(1);
  expect(body).not.toContain('routeContext:await subjectContext');
 });
 it('fences update-only assignment rollback and fingerprints the same inclusive-date rows the criteria resolver reads',()=>{
  const body=section('async function subjectContext(', 'export async function resolveProfileRouteTx(');
  expect(body.match(/\.for\('update'\)/g)).toHaveLength(2);
  expect(body).toContain('${assignment.validTo}>=${asOf}');
  expect(body).toContain('assignments:rows');
 });
});
describe('criteria refusals before calling the organisation resolver',()=>{
 for(const criteria of [{companyIds:['not-a-uuid']},{departmentIds:['-'.repeat(36)]},{positionIds:['invalid']},{employmentTypes:['not-an-employment-type']},{orgDivision:['']}])it(`refuses ${JSON.stringify(criteria)}`,()=>{
  state.policy={...EMPTY_PROFILE_ROUTING,enabled:true,rules:[{id:'11111111-1111-4111-8111-111111111111',name:'Fictional rule',approverEmploymentId:'22222222-2222-4222-8222-222222222222',employmentIds:[],criteria}]};
  expect(()=>readProfileRoutingPolicy({tenantId:'tenant'} as SessionContext)).toThrow(expect.objectContaining({code:'invalid'}));
 });
 it('keeps PostgreSQL-valid historical UUID groups and canonical employment choices',()=>{
  state.policy={...EMPTY_PROFILE_ROUTING,enabled:true,rules:[{id:'11111111-1111-4111-8111-111111111111',name:'Fictional rule',approverEmploymentId:'22222222-2222-4222-8222-222222222222',employmentIds:[],criteria:{companyIds:['11111111-1111-1111-1111-111111111111'],employmentTypes:['full_time']}}]};
  expect(readProfileRoutingPolicy({tenantId:'tenant'} as SessionContext).enabled).toBe(true);
 });
});
