import {describe,it,expect} from 'vitest';
import {lifecycleOffboardingHumanHandoff,checkedLifecycleOffboardingHumanHandoff} from '../lib/ai/lifecycle-offboarding-human-handoff';
import {moduleHumanActionHandoffs,checkedModuleHumanHandoffs} from '../lib/ai/module-human-handoffs';
import {parseModuleAgentActionNomination} from '../lib/ai/module-agent-actions';
const literal={module:'lifecycle',action:'lifecycle.offboarding.workflow',route:'/lifecycle/offboarding',requiresHumanSelection:true,effect:'none',authority:'rechecked_on_native_page'} as const;
describe('native offboarding navigation boundary',()=>{
 it('returns an immutable no-effect tuple without retaining caller identity',()=>{
  const input={...literal},result=checkedLifecycleOffboardingHumanHandoff(input);
  expect(result).toEqual(literal);expect(result).not.toBe(input);expect(Object.isFrozen(result)).toBe(true);
  expect(Reflect.set(result,'route','https://outside.test')).toBe(false);
 });
 it.each(['caseId','number','companyId','employmentId','outcome','lastWorkingDay','effectiveDate','delegate','session','grant','confirmation','phase','source','notes'])('rejects supplied %s',key=>{
  expect(()=>checkedLifecycleOffboardingHumanHandoff({...literal,[key]:'untrusted'})).toThrow();
 });
 it.each([{route:'https://outside.test'},{route:'/lifecycle/offboarding?outcome=accepted'},{module:'employees'},{effect:'write'},{requiresHumanSelection:false},{authority:'authorized'}])('refuses widened tuple %j',patch=>{
  expect(()=>checkedLifecycleOffboardingHumanHandoff({...literal,...patch})).toThrow();
 });
 it('offers the link only for lifecycle and validates the complete canonical handoff packet',()=>{
  const options=moduleHumanActionHandoffs('lifecycle');expect(options).toContainEqual(literal);
  expect(checkedModuleHumanHandoffs('lifecycle',options)).toEqual(options);
  expect(moduleHumanActionHandoffs('employees')).not.toContainEqual(literal);
  expect(()=>checkedModuleHumanHandoffs('employees',options)).toThrow();
  expect(()=>checkedModuleHumanHandoffs('lifecycle',[{...literal,caseId:'private'}])).toThrow();
 });
 it('cannot become a prepare/confirm effect or accept navigation arguments',()=>{
  expect(()=>Reflect.apply(lifecycleOffboardingHumanHandoff,null,[{outcome:'accepted'}])).toThrow();
  expect(()=>parseModuleAgentActionNomination({module:'lifecycle',action:literal.action,phase:'prepare'})).toThrow();
  expect(()=>parseModuleAgentActionNomination({module:'lifecycle',action:literal.action,phase:'confirm'})).toThrow();
 });
});
