/** @vitest-environment jsdom */
/** Authored UNRUN: choice-reset behavior is not source authorization or independent evaluation. */
import {afterEach,expect,it} from 'vitest';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {SpecialistCandidateChoices} from '../components/assistant/specialist-candidate-choices';
afterEach(cleanup);
it('shows only matching module evidence, requires a fresh choice after edits and never submits a hidden stale reference',()=>{
 const {container}=render(<SpecialistCandidateChoices modules={[{value:'leave:1',module:'leave',label:'Leave'},{value:'claims:2',module:'claims',label:'Claims'},{value:'system_explorer:1',module:'system_explorer',label:'Explorer'}]} evidence={[{value:'own-leave-link',module:'leave',label:'Submitted Leave'},{value:'own-claim-link',module:'claims',label:'Saved claim'}]} messages={{module:'Module',nativeTitle:'Evidence',nativeIntro:'Rechecked on submission',nativeNone:'None'}}/>);
 const form=()=>{const f=document.createElement('form');f.innerHTML=container.innerHTML;return new FormData(f);};
 const module=container.querySelector<HTMLSelectElement>('[name="moduleVersion"]')!,native=()=>container.querySelector<HTMLSelectElement>('[name="nativeSignalId"]')!;
 expect(native().value).toBe('');expect([...native().options].map(option=>option.value)).toEqual(['','own-leave-link']);
 fireEvent.change(native(),{target:{value:'own-leave-link'}});expect(native().value).toBe('own-leave-link');
 fireEvent.change(module,{target:{value:'claims:2'}});expect(native().value).toBe('');expect([...native().options].map(option=>option.value)).toEqual(['','own-claim-link']);
 fireEvent.change(native(),{target:{value:'own-claim-link'}});fireEvent.change(module,{target:{value:'system_explorer:1'}});expect(container.querySelector('[name="nativeSignalId"]')).toBeNull();expect(form().has('nativeSignalId')).toBe(false);
 fireEvent.change(module,{target:{value:'leave:1'}});expect(native().value).toBe('');
});
