import {describe,expect,it} from 'vitest';
import {assertProbationDeploymentTarget,parseProbationRuntimeTarget,ProbationRuntimeRefused} from '../scripts/operator/probation-runtime-target';
const source='a'.repeat(40),build='fictional-build_1',origin='https://fictional.invalid';
const target=['--operation','activate','--tenant','11111111-1111-4111-8111-111111111111','--company','22222222-2222-4222-8222-222222222222','--origin',origin,'--source',source,'--build',build];
const installed=`state=ok\nphase=complete\nref=${source}\nexit_code=0\nbuild_id=${build}\nbuilt_ref=${source}\nbuilt_build_id=${build}\nstale_build=0`;
describe('explicit target fence for reviewed Probation operations',()=>{
 it('defaults to a read-only identity check and refuses apply without named approval and database evidence',()=>{
  expect(parseProbationRuntimeTarget(target)).toMatchObject({apply:false,operation:'activate',origin,source,build});
  expect(()=>parseProbationRuntimeTarget([...target,'--apply'])).toThrow(ProbationRuntimeRefused);
  expect(parseProbationRuntimeTarget([...target,'--apply','--database-identity','b'.repeat(64),'--reference','Fictional accepted installation','--approval','33333333-3333-4333-8333-333333333333','--digest','c'.repeat(64)])).toMatchObject({apply:true,operation:'activate',digest:'c'.repeat(64)});
 });
 it('refuses ambiguous command flags and stale or foreign source/build/origin',()=>{
  expect(()=>parseProbationRuntimeTarget([...target,'--origin','https://different.invalid'])).toThrow(ProbationRuntimeRefused);
  expect(()=>assertProbationDeploymentTarget(installed,origin,{source,origin,build})).not.toThrow();
  expect(()=>assertProbationDeploymentTarget(installed,'https://different.invalid',{source,origin,build})).toThrow(ProbationRuntimeRefused);
  expect(()=>assertProbationDeploymentTarget(installed.replace('stale_build=0','stale_build=1'),origin,{source,origin,build})).toThrow(ProbationRuntimeRefused);
  expect(()=>assertProbationDeploymentTarget(installed.replace('built_build_id='+build,'built_build_id=different'),origin,{source,origin,build})).toThrow(ProbationRuntimeRefused);
  expect(()=>assertProbationDeploymentTarget(installed+'\nstate=ok',origin,{source,origin,build})).toThrow(ProbationRuntimeRefused);
 });
});
