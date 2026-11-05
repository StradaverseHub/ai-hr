import {afterEach,expect,it,vi} from 'vitest';
import {act,fireEvent,render,screen,waitFor,cleanup} from '@testing-library/react';
import {OrgChartExplorer} from '../components/org-chart-explorer';
import type {OrgWindow} from '../lib/org-chart-window';
vi.mock('next-intl',()=>({useTranslations:()=> (key:string)=>key}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function windowData(view:OrgWindow['view']='roots',name='Root',focus:OrgWindow['focus']=null):OrgWindow{
 const node={employmentId:id(1),name,employeeCode:null,role:null,department:null,assignmentCount:0};
 return {version:1,view,focus,items:[{key:id(1),node,otherEmploymentId:id(1),type:null,direction:null,inSelectedScope:true}],totalPeople:1,totalItems:1,pageSize:50,nextCursor:null};
}
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('keeps typing immediate, submits one search and suppresses late responses',async()=>{
 const calls:{url:string;options:RequestInit;resolve:(value:unknown)=>void}[]=[];
 vi.stubGlobal('fetch',vi.fn((url:string,options:RequestInit)=>new Promise(resolve=>calls.push({url,options,resolve}))));
 render(<OrgChartExplorer initial={windowData()}/>);const search=screen.getByRole('textbox');
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
 render(<OrgChartExplorer initial={windowData()}/>);
 fireEvent.click(screen.getByRole('button',{name:'explorer.allPeople'}));expect(await screen.findByRole('alert')).toHaveTextContent('explorer.failed');expect(screen.queryByText('noMatch')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'explorer.retry'}));await waitFor(()=>expect(screen.queryByText('Root')).not.toBeInTheDocument());expect(screen.getByRole('alert')).toHaveTextContent('explorer.accessChanged');
});
it('renders only the current fifty rows and supports cursor paging, focus and returning',async()=>{
 const initial=windowData();initial.items=Array.from({length:50},(_,n)=>({key:id(n+1),node:{...initial.items[0].node!,employmentId:id(n+1),name:`Person ${n+1}`},otherEmploymentId:id(n+1),type:null,direction:null,inSelectedScope:true}));initial.totalPeople=1000000;initial.totalItems=1000000;initial.nextCursor=id(50);
 const next=windowData('roots','Last page');const focused=windowData('children','Report',next.items[0].node);
 const fetcher=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>next}).mockResolvedValueOnce({ok:true,json:async()=>focused}).mockResolvedValueOnce({ok:true,json:async()=>next});vi.stubGlobal('fetch',fetcher);
 const {container}=render(<OrgChartExplorer initial={initial}/>);expect(container.querySelectorAll('[data-org-item]')).toHaveLength(50);
 fireEvent.click(screen.getByRole('button',{name:'explorer.next'}));expect(await screen.findByText('Last page')).toBeInTheDocument();expect(fetcher.mock.calls[0][0]).toContain(`after=${id(50)}`);expect(container.querySelectorAll('[data-org-item]')).toHaveLength(1);expect(screen.queryByText('Person 1')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'explorer.explore'}));expect(await screen.findByText('Report')).toBeInTheDocument();expect(screen.getByRole('link',{name:'explorer.profile'})).toHaveAttribute('href',`/personnel/${id(1)}?from=org`);
 fireEvent.click(screen.getByRole('button',{name:'explorer.back'}));await waitFor(()=>expect(screen.queryByText('Report')).not.toBeInTheDocument());expect(screen.getByText('Last page')).toBeInTheDocument();
});
