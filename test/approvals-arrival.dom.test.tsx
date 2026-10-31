import * as React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,render} from '@testing-library/react';
import {AttentionOnArrival} from '../app/(app)/approvals/attention-on-arrival';
const id='21d29ae1-dc1c-4479-a7bf-cb882f12ef66';
let scroll:ReturnType<typeof vi.fn>;
beforeEach(()=>{
 vi.useFakeTimers();scroll=vi.fn();
 vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>window.setTimeout(()=>fn(0),0));
 vi.stubGlobal('cancelAnimationFrame',(token:number)=>window.clearTimeout(token));
 vi.stubGlobal('matchMedia',vi.fn(()=>({matches:true})));
 Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{value:scroll,configurable:true});
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();window.history.replaceState(null,'','/');});
function arrive(hash:string,withRow=true){
 window.history.replaceState(null,'','/approvals#'+hash);
 render(<><section id="approvals-leave" tabIndex={-1}>{withRow&&<article id={'approval-row-'+id} tabIndex={-1}>Fictional assigned request</article>}</section><AttentionOnArrival/></>);
 act(()=>{vi.advanceTimersByTime(1);});
}
describe('approval arrival focuses the actual request',()=>{
 it('moves focus and reduced-motion scrolling to the request in a legacy composite hash',()=>{
  arrive('approvals-leave--'+id);
  const row=document.getElementById('approval-row-'+id)!;
  expect(document.activeElement).toBe(row);expect(scroll.mock.instances).toEqual([row]);
  expect(scroll).toHaveBeenCalledWith({behavior:'auto',block:'start'});
  expect(row).toHaveClass('approvals-row-attention');
  act(()=>{vi.advanceTimersByTime(4500);});expect(row).not.toHaveClass('approvals-row-attention');
 });
 it('supports the exact request anchor used for non-leave assignments',()=>{
  arrive('approval-row-'+id);expect(document.activeElement).toBe(document.getElementById('approval-row-'+id));
 });
 it('retains a usable section fallback when an old bookmarked request has disappeared',()=>{
  arrive('approvals-leave--'+id,false);expect(document.activeElement).toBe(document.getElementById('approvals-leave'));
 });
 it('does not move focus for a malformed foreign anchor',()=>{
  arrive('approval-row-'+id+'/unexpected');expect(scroll).not.toHaveBeenCalled();expect(document.activeElement).toBe(document.body);
 });
});
