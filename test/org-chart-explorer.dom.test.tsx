import {afterEach,expect,it,vi} from 'vitest';
import {act,fireEvent,render,screen,waitFor,cleanup} from '@testing-library/react';
import {OrgChartExplorer} from '../components/org-chart-explorer';
import type {OrgWindow} from '../lib/org-chart-window';
vi.mock('next-intl',()=>({useTranslations:()=> (key:string)=>key}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function windowData(view:OrgWindow['view']='roots',name='Root',focus:OrgWindow['focus']=null):OrgWindow&{browserKey:string}{
 const node={employmentId:id(1),name,employeeCode:null,role:null,department:null,assignmentCount:0};
 return {browserKey:'current',version:1,view,focus,items:[{key:id(1),node,otherEmploymentId:id(1),type:null,direction:null,inSelectedScope:true}],totalPeople:1,totalItems:1,pageSize:50,nextCursor:null};
}
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});
it('keeps typing immediate, submits one search and suppresses late responses',async()=>{
 const calls:{url:string;options:RequestInit;resolve:(value:unknown)=>void}[]=[];
 vi.stubGlobal('fetch',vi.fn((url:string,options:RequestInit)=>new Promise(resolve=>calls.push({url,options,resolve}))));
 render(<OrgChartExplorer browserKey="current" initial={windowData()}/>);const search=screen.getByRole('textbox');
 fireEvent.change(search,{target:{value:'first'}});expect(calls).toHaveLength(0);
 fireEvent.submit(search.closest('form')!);expect(calls).toHaveLength(1);expect(calls[0].options.cache).toBe('no-store');
 fireEvent.change(search,{target:{value:'second'}});fireEvent.submit(search.closest('form')!);expect(calls).toHaveLength(2);expect(calls[0].options.signal?.aborted).toBe(true);
 await act(async()=>calls[1].resolve({ok:true,json:async()=>windowData('search','Current')}));
 expect(await screen.findByText('Current')).toBeInTheDocument();
 await act(async()=>calls[0].resolve({ok:true,json:async()=>windowData('search','Stale')}));
 expect(screen.queryByText('Stale')).not.toBeInTheDocument();expect(screen.getByText('Current')).toBeInTheDocument();
});
it('clears private rows after access changes and never converts a server failure to no matches',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce({ok:false,status:503}).mockResolvedValueOnce({ok:false,status:403});vi.stubGlobal('fetch',fetcher);
 render(<OrgChartExplorer browserKey="current" initial={windowData()}/>);
 fireEvent.click(screen.getByRole('button',{name:'explorer.allPeople'}));expect(await screen.findByRole('alert')).toHaveTextContent('explorer.failed');expect(screen.queryByText('noMatch')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'explorer.retry'}));await waitFor(()=>expect(screen.queryByText('Root')).not.toBeInTheDocument());expect(screen.getByRole('alert')).toHaveTextContent('explorer.accessChanged');
});
it('renders only the current fifty rows and supports cursor paging, focus and returning',async()=>{
 const initial=windowData();initial.items=Array.from({length:50},(_,n)=>({key:id(n+1),node:{...initial.items[0].node!,employmentId:id(n+1),name:`Person ${n+1}`},otherEmploymentId:id(n+1),type:null,direction:null,inSelectedScope:true}));initial.totalPeople=1000000;initial.totalItems=1000000;initial.nextCursor=id(50);
 const next=windowData('roots','Last page');const focused=windowData('children','Report',next.items[0].node);
 const fetcher=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>next}).mockResolvedValueOnce({ok:true,json:async()=>focused}).mockResolvedValueOnce({ok:true,json:async()=>next});vi.stubGlobal('fetch',fetcher);
 const {container}=render(<OrgChartExplorer browserKey="current" initial={initial}/>);expect(container.querySelectorAll('[data-org-item]')).toHaveLength(50);
 fireEvent.click(screen.getByRole('button',{name:'explorer.next'}));expect(await screen.findByText('Last page')).toBeInTheDocument();expect(fetcher.mock.calls[0][0]).toContain(`after=${id(50)}`);expect(container.querySelectorAll('[data-org-item]')).toHaveLength(1);expect(screen.queryByText('Person 1')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'explorer.explore'}));expect(await screen.findByText('Report')).toBeInTheDocument();expect(screen.getByRole('link',{name:'explorer.profile'})).toHaveAttribute('href',`/personnel/${id(1)}?from=org`);
 fireEvent.click(screen.getByRole('button',{name:'explorer.back'}));await waitFor(()=>expect(screen.queryByText('Report')).not.toBeInTheDocument());expect(screen.getByText('Last page')).toBeInTheDocument();
});

it('ends a hung request in an explicit retry state and ignores its late response',async()=>{
 vi.useFakeTimers();let resolve!:(value:unknown)=>void;
 vi.stubGlobal('fetch',vi.fn(()=>new Promise(done=>{resolve=done;})));
 render(<OrgChartExplorer browserKey="current" initial={windowData()}/>);
 fireEvent.click(screen.getByRole('button',{name:'explorer.allPeople'}));expect(screen.getByText('explorer.loading')).toBeInTheDocument();
 await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});
 expect(screen.getByRole('alert')).toHaveTextContent('explorer.failed');expect(screen.getByRole('button',{name:'explorer.allPeople'})).not.toBeDisabled();
 await act(async()=>resolve({ok:true,json:async()=>windowData('search','Too late')}));
 expect(screen.queryByText('Too late')).not.toBeInTheDocument();expect(screen.getByText('Root')).toBeInTheDocument();expect(screen.queryByText('noMatch')).not.toBeInTheDocument();
});
it('keeps breadcrumb rendering bounded while Back still reaches earlier visited levels',async()=>{
 const person=(n:number)=>({employmentId:id(n),name:`Node ${n}`,employeeCode:null,role:null,department:null,assignmentCount:0});
 const initial:OrgWindow={...windowData(),items:[{key:id(1),node:person(1),otherEmploymentId:id(1),type:null,direction:null,inSelectedScope:true}],totalPeople:1000};
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
  const params=new URL(url,'https://example.test').searchParams;
  if(params.get('view')==='roots')return {ok:true,json:async()=>initial};
  const current=Number(params.get('focusId')!.slice(-12)),child=person(current+1);
  return {ok:true,json:async()=>({...windowData('children',child.name,person(current)),totalPeople:1000,items:[{key:child.employmentId,node:child,otherEmploymentId:child.employmentId,type:'administrative',direction:'outgoing',inSelectedScope:true}]})};
 }));
 render(<OrgChartExplorer browserKey="current" initial={initial}/>);
 for(let n=1;n<=12;n++){
  fireEvent.click(screen.getByRole('button',{name:'explorer.explore'}));
  expect(await screen.findByRole('heading',{level:3,name:`Node ${n+1}`})).toBeInTheDocument();
 }
 const crumbs=screen.getByRole('navigation',{name:'explorer.history'});expect(crumbs.querySelectorAll('button')).toHaveLength(8);expect([...crumbs.querySelectorAll('button')].map(button=>button.textContent)).toEqual(Array.from({length:8},(_,index)=>`Node ${index+5}`));
 for(let n=12;n>0;n--){fireEvent.click(screen.getByRole('button',{name:'explorer.back'}));expect(await screen.findByRole('heading',{level:3,name:`Node ${n}`})).toBeInTheDocument();}
 expect(screen.queryByRole('navigation',{name:'explorer.history'})).not.toBeInTheDocument();
});

it('clears previously visible people and navigation history when fresh API context changes',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({...windowData('search','New actor only'),browserKey:'different-actor-or-scope'})}));
 render(<OrgChartExplorer browserKey="current" initial={windowData()}/>);
 fireEvent.click(screen.getByRole('button',{name:'explorer.allPeople'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('explorer.accessChanged');expect(screen.queryByText('Root')).not.toBeInTheDocument();expect(screen.queryByText('New actor only')).not.toBeInTheDocument();
 expect(screen.queryByRole('navigation',{name:'explorer.history'})).not.toBeInTheDocument();
});
