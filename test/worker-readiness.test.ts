import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({get:vi.fn(),loads:0,fail:false}));
beforeEach(()=>{
 vi.resetModules();state.get.mockReset();state.loads=0;state.fail=false;
 delete (globalThis as {__aihrHomeStartupReadiness?:unknown}).__aihrHomeStartupReadiness;
 vi.doMock('../app/api/home/sharing-initial/route',()=>{
  state.loads++;
  if(state.fail)throw Error('Fictional initialization failure');
  return {GET:state.get};
 });
});
afterEach(()=>{
 vi.doUnmock('../app/api/home/sharing-initial/route');
 delete (globalThis as {__aihrHomeStartupReadiness?:unknown}).__aihrHomeStartupReadiness;
});
describe('worker code readiness',()=>{
 it('shares concurrent initialization and never invokes the real request handler',async()=>{
  const {initializeHomeReadModule}=await import('../lib/worker-readiness');
  const first=initializeHomeReadModule(),second=initializeHomeReadModule();
  expect(second).toBe(first);await Promise.all([first,second]);await initializeHomeReadModule();
  expect(state.loads).toBe(1);expect(state.get).not.toHaveBeenCalled();
  const evidence=(globalThis as {__aihrHomeStartupReadiness?:{moduleMs:number;handlersInvoked:0}}).__aihrHomeStartupReadiness;
  expect(evidence?.moduleMs).toBeGreaterThanOrEqual(0);expect(evidence?.handlersInvoked).toBe(0);
  expect(Object.keys(evidence??{}).sort()).toEqual(['handlersInvoked','moduleMs']);
 });
 it('retains a failed initialization rather than claiming readiness or invoking a handler',async()=>{
  state.fail=true;
  const {initializeHomeReadModule}=await import('../lib/worker-readiness');
  const failed=initializeHomeReadModule();
  await expect(failed).rejects.toThrow();
  expect(initializeHomeReadModule()).toBe(failed);await expect(failed).rejects.toThrow();
  expect(state.loads).toBe(1);expect(state.get).not.toHaveBeenCalled();
  expect((globalThis as {__aihrHomeStartupReadiness?:unknown}).__aihrHomeStartupReadiness).toBeUndefined();
 });
});
