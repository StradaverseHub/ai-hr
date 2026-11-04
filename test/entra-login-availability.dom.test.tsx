import {afterEach,describe,it,expect,vi} from 'vitest';
import {cleanup,render,screen,waitFor,fireEvent,act} from '@testing-library/react';
import {useMicrosoftLogin} from '../lib/entra/use-microsoft-login';
function Choice({organization='acme',origin='',fetcher=fetch}:{organization?:string;origin?:string;fetcher?:typeof fetch}){
 return useMicrosoftLogin(organization,origin,fetcher)?<button>Microsoft</button>:<span>Local login</span>;
}
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('shared web/native Microsoft visibility',()=>{
 it('discards a late enabled response after changing organizations or API origins',async()=>{
  let resolve!:(response:Response)=>void;
  const fetcher=vi.fn().mockImplementationOnce(()=>new Promise<Response>(r=>{resolve=r;})).mockImplementation(async()=>Response.json({microsoft:false}));
  const view=render(<Choice organization="first" origin="https://first.test" fetcher={fetcher}/>);
  await waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());
  view.rerender(<Choice organization="second" origin="https://second.test" fetcher={fetcher}/>);
  await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));
  await act(async()=>{resolve(Response.json({microsoft:true}));});
  expect(screen.queryByRole('button',{name:'Microsoft'})).not.toBeInTheDocument();
  expect(fetcher.mock.calls[1][0]).toBe('https://second.test/login/entra/options?organization=second');
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
 });
 it('refreshes current activation on focus and hides a newly disabled option',async()=>{
  const fetcher=vi.fn().mockImplementationOnce(async()=>Response.json({microsoft:true})).mockImplementation(async()=>Response.json({microsoft:false}));
  render(<Choice fetcher={fetcher}/>);await screen.findByRole('button',{name:'Microsoft'});
  fireEvent.focus(window);await waitFor(()=>expect(screen.queryByRole('button',{name:'Microsoft'})).not.toBeInTheDocument());
  expect(fetcher.mock.calls[0][1]).toMatchObject({credentials:'omit',redirect:'error',cache:'no-store'});
 });
 it('never looks up a blank organization',async()=>{
  const fetcher=vi.fn();render(<Choice organization="" fetcher={fetcher}/>);expect(screen.queryByRole('button',{name:'Microsoft'})).not.toBeInTheDocument();expect(fetcher).not.toHaveBeenCalled();
 });
});
