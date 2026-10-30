/** Public descriptor/policy projection only. This measures CPU, not authorized HTTP capacity. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {essEditableFields,essVisibleFields,resolveEssEditableIds,resolveEssPrimaryEditableIds} from '../../lib/personnel-ess-contract';
import {resolveEssVisibleIds} from '../../lib/personnel-ess-visibility';
import {effectiveProfileFieldPermission,profileGroupPermission,isProfileVisibilityPolicyValue,type ProfileVisibilityPolicyValue} from '../../lib/profile-edit-policy-value';

// Exact previous complete-policy loops, retained solely for the reversible comparison.
function previous(raw:ProfileVisibilityPolicyValue){
 const editable=new Set(essEditableFields().filter(field=>effectiveProfileFieldPermission(raw,field)==='editable'&&resolveEssVisibleIds(raw).has(field.id)).map(field=>field.id));
 const primary=new Set(essEditableFields().filter(field=>field.ess.legacyPrimaryKey).filter(field=>effectiveProfileFieldPermission(raw,field)==='viewOnly'&&profileGroupPermission(raw,field)==='editable'&&raw.primaryOnly.includes(field.id)&&resolveEssVisibleIds(raw).has(field.id)).map(field=>field.id));
 return {editable,primary};
}
const current=(raw:ProfileVisibilityPolicyValue)=>({editable:resolveEssEditableIds(raw),primary:resolveEssPrimaryEditableIds(raw)});
it('compares repeated complete-policy field projections without retaining permission results',()=>{
 const fields=Object.fromEntries(essVisibleFields().map(field=>[field.id,field.ess.legacyPrimaryKey?'viewOnly' as const:'editable' as const]));
 const primaryOnly=essEditableFields().filter(field=>field.ess.legacyPrimaryKey).map(field=>field.id);
 const policies:ProfileVisibilityPolicyValue[]=[
  {version:3,fields,primaryOnly},
  {version:4,fields,primaryOnly,groups:{}},
  {version:5,fields,primaryOnly,groups:{},approvals:{}},
 ];
 const measures=[];
 for(const policy of policies){
  expect(isProfileVisibilityPolicyValue(policy)).toBe(true);
  const expected=previous(policy),unchanged=JSON.stringify(policy);
  expect(expected.editable.size).toBeGreaterThan(50);expect(expected.primary.size).toBeGreaterThan(0);
  expect(current(policy)).toEqual(expected);
  const phases:Record<string,unknown>={};
  for(const phase of ['previous-before','current','previous-after']){
   const project=phase==='current'?current:previous,times=[];
   for(let warm=0;warm<5;warm++)project(policy);
   for(let i=0;i<100;i++){
    const started=performance.now(),result=project(policy);times.push(performance.now()-started);
    expect(result).toEqual(expected);
   }
   times.sort((a,b)=>a-b);phases[phase]={operations:times.length,p50Ms:times[49],p95Ms:times[94],maxMs:times.at(-1),editable:expected.editable.size,primary:expected.primary.size};
  }
  expect(JSON.stringify(policy)).toBe(unchanged);
  // A later call must see a changed policy; sharing a computed set across calls would fail this.
  const hidden={...policy,fields:Object.fromEntries(Object.keys(fields).map(id=>[id,'hide' as const]))};
  expect(current(hidden)).toEqual({editable:new Set(),primary:new Set()});
  expect(current(policy)).toEqual(expected);
  measures.push({version:policy.version,fields:Object.keys(fields).length,phases});
 }
 writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'ess-field-projection.json'),JSON.stringify({kind:'PUBLIC_POLICY_PROJECTION_CPU',releaseEligible:false,measures},null,2));
},180000);
