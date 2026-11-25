/** ADR 0181 Phase 4, list-only filters: the People directory island refreshes only its list.
 *
 * A pager step, a page-size change, a filter submit and a chip removal each POST the address's parameters to
 * /personnel/list, replace the list from the answer and push the answered address; nothing asks the router for a page
 * render. Back re-reads the list for the restored address without pushing. A failed list read falls back to an
 * ordinary navigation, so the page's own sign-in and error handling decide (fail closed). All names are invented. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import type {ReactNode} from 'react';

const router=vi.hoisted(()=>({push:vi.fn(),replace:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>router}));
vi.mock('next/link',()=>({default:({href,children,...rest}:{href:string;children:ReactNode})=><a href={href} {...rest}>{children}</a>}));
vi.mock('next/form',()=>({default:({children,...rest}:{children:ReactNode})=><form {...rest}>{children}</form>}));

import {DirectoryChips,DirectoryHeaderActions,DirectoryListProvider,DirectoryTable} from '../app/personnel/directory-list';
import type {DirectoryView} from '../app/personnel/directory-view';
import type {FilterField} from '../components/filter-panel';

const A='0b6f1d1e-3c55-4c6a-9a43-0d2f0c6f1a01',B='7d1e9b2a-5f0c-4e8b-8a7d-2b9c4e1f3a02';
const link=(label:string,href:string|null)=>({label,href});
function view(name:string,href:string,over:Partial<DirectoryView>={}):DirectoryView{
 return {href,filters:{},headerCount:`${name} count`,emptyText:null,
  rows:[{employmentId:name===' first'?A:B,name:`Fictional${name}`,email:'f@fixture.test',employeeCode:'FX-1',department:null,company:'Fictional Sdn Bhd',
   status:'active',statusLabel:'Active',hiredOn:'2024-01-01',photoUrl:null}],
  pager:{rangeText:`${name} range`,compactRange:`${name} compact`,previousPage:'Previous page',nextPage:'Next page',rowsPerPage:'Rows',size:'25',
   sizeOptions:[{value:'25',label:'25',href:'/personnel?size=25'},{value:'50',label:'50',href:'/personnel?size=50'}],
   first:link('« First',null),prev:link('← Previous',null),next:link('Next →',`/personnel?page=1&size=25&after=${A}`),last:link('Last »',null),
   countExactly:null,truncatedText:null},...over};
}
const fields:FilterField[]=[{kind:'search',name:'q',label:'Search',placeholder:'Name',ariaLabel:'Search people',removeAriaLabel:'Remove search'}];
const labels={filter:'Filter',apply:'Apply',clearAll:'Clear all',activeCount:{0:'0 filters',1:'1 filter'}};
function renderIsland(initial:DirectoryView,theme='classic'){
 return render(<DirectoryListProvider initial={initial}>
  <DirectoryHeaderActions fields={fields} labels={labels}/>
  <DirectoryChips fields={fields} labels={labels}/>
  <DirectoryTable theme={theme} columns={{code:'Code',name:'Name',department:'Department',company:'Company',status:'Status',hired:'Hired'}}/>
 </DirectoryListProvider>);
}
let fetchMock:ReturnType<typeof vi.fn>,assign:ReturnType<typeof vi.fn>;
const originalLocation=window.location;
beforeEach(()=>{
 fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
 assign=vi.fn();Object.defineProperty(window,'location',{configurable:true,value:{...window.location,assign,origin:'http://localhost',pathname:'/personnel',search:''}});
 vi.spyOn(window.history,'pushState').mockImplementation(()=>{});
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();router.push.mockClear();Object.defineProperty(window,'location',{configurable:true,value:originalLocation});});
const answer=(v:DirectoryView)=>fetchMock.mockResolvedValueOnce({ok:true,json:async()=>v});

describe('People directory list-only island',()=>{
 it('a pager step reads only the list and pushes its address; the router renders nothing',async()=>{
  renderIsland(view(' first','/personnel'));
  answer(view(' second',`/personnel?page=1&size=25&after=${A}`));
  fireEvent.click(screen.getByText('Next →'));
  await screen.findByText('Fictional second');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url,init]=fetchMock.mock.calls[0];
  expect(url).toBe('/personnel/list');
  expect(init.method).toBe('POST');
  expect(JSON.parse(init.body)).toEqual({page:'1',size:'25',after:A});
  expect(window.history.pushState).toHaveBeenCalledWith(null,'',`/personnel?page=1&size=25&after=${A}`);
  expect(screen.getByText('second count')).toBeInTheDocument();
  expect(screen.getByText('second range')).toBeInTheDocument();
  expect(router.push).not.toHaveBeenCalled();
 });

 it('page size and the filter panel go to the list, not the router',async()=>{
  renderIsland(view(' first','/personnel'));
  answer(view(' second','/personnel?size=50'));
  fireEvent.change(screen.getByRole('combobox',{name:'Rows'}),{target:{value:'50'}});
  await screen.findByText('Fictional second');
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({size:'50'});
  answer(view(' first','/personnel?q=tan',{filters:{q:'tan'}}));
  fireEvent.click(screen.getByRole('button',{name:/Filter/}));
  fireEvent.change(screen.getByPlaceholderText('Name'),{target:{value:'tan'}});
  fireEvent.click(screen.getByRole('button',{name:'Apply'}));
  await screen.findByText('Fictional first');
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({q:'tan'});
  expect(router.push).not.toHaveBeenCalled();
  // The applied search shows as a chip; removing it reads the unfiltered list.
  answer(view(' second','/personnel'));
  fireEvent.click(screen.getByRole('link',{name:'Remove search'}));
  await screen.findByText('Fictional second');
  expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({});
 });

 it('Back re-reads the list for the restored address without pushing another entry',async()=>{
  renderIsland(view(' first','/personnel'));
  answer(view(' second',`/personnel?page=1&after=${A}`));
  Object.assign(window.location,{search:`?page=1&after=${A}`});
  await act(async()=>{window.dispatchEvent(new PopStateEvent('popstate'));});
  await screen.findByText('Fictional second');
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({page:'1',after:A});
  expect(window.history.pushState).not.toHaveBeenCalled();
 });

 it('fails closed: a refused or failed list read opens the address through the page',async()=>{
  renderIsland(view(' first','/personnel'));
  fetchMock.mockResolvedValueOnce({ok:false,status:401,json:async()=>({error:'authentication'})});
  fireEvent.click(screen.getByText('Next →'));
  await waitFor(()=>expect(assign).toHaveBeenCalledWith(`/personnel?page=1&size=25&after=${A}`));
  expect(screen.getByText('Fictional first')).toBeInTheDocument();
 });

 it('renders the Atelier compact pager with the same list-only steps',async()=>{
  renderIsland(view(' first','/personnel'),'atelier');
  expect(screen.getByText('first compact')).toBeInTheDocument();
  answer(view(' second',`/personnel?page=1&size=25&after=${A}`));
  fireEvent.click(screen.getByRole('link',{name:'Next page'}));
  await screen.findByText('Fictional second');
  expect(screen.getByRole('button',{name:'Previous page'})).toBeDisabled();
 });

 it('a modified click still opens the address itself (new tab)',()=>{
  renderIsland(view(' first','/personnel'));
  fireEvent.click(screen.getByText('Next →'),{ctrlKey:true});
  expect(fetchMock).not.toHaveBeenCalled();
 });
});
