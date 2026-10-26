import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {LetterChoicePicker} from '../components/letters/choice-picker';
const labels={search:'Search choices',find:'Find',more:'More choices',choose:'Choose',loading:'Loading',empty:'No selectable choices on this page',error:'Choices unavailable'},companyId='00000000-0000-4000-8000-000000000001';
const response=(rows:unknown[],nextCursor:string|null=null)=>({ok:true,headers:new Headers({'content-type':'application/json'}),json:async()=>({rows,nextCursor})});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('searches without submitting the surrounding form and selects only on explicit choice',async()=>{
 const fetcher=vi.fn().mockResolvedValue(response([{id:'head',label:'Company letterhead'}])),choose=vi.fn(),submit=vi.fn(event=>event.preventDefault()),user=userEvent.setup();vi.stubGlobal('fetch',fetcher);
 render(<form onSubmit={submit}><LetterChoicePicker companyId={companyId} kind="letterhead" labels={labels} onChoose={choose}/></form>);await user.type(screen.getByLabelText(labels.search),'Company{Enter}');await screen.findByRole('button',{name:'Choose: Company letterhead'});expect(submit).not.toHaveBeenCalled();expect(choose).not.toHaveBeenCalled();expect(fetcher.mock.calls[0][0]).toContain('kind=letterhead&q=Company');await user.click(screen.getByRole('button',{name:'Choose: Company letterhead'}));expect(choose).toHaveBeenCalledExactlyOnceWith({id:'head',label:'Company letterhead'});
});
it('keeps pagination bound to the completed search while the user types another query',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(response([{id:'one',label:'One'}],'cursor')).mockResolvedValueOnce(response([{id:'two',label:'Two'}])),user=userEvent.setup();vi.stubGlobal('fetch',fetcher);render(<LetterChoicePicker companyId={companyId} kind="signatory" labels={labels} onChoose={()=>{}}/>);await user.type(screen.getByLabelText(labels.search),'original');await user.click(screen.getByRole('button',{name:labels.find}));await screen.findByRole('button',{name:labels.more});await user.clear(screen.getByLabelText(labels.search));await user.type(screen.getByLabelText(labels.search),'different');await user.click(screen.getByRole('button',{name:labels.more}));await screen.findByRole('button',{name:'Choose: Two'});expect(fetcher.mock.calls[1][0]).toContain('q=original&after=cursor');expect(screen.getByRole('button',{name:'Choose: One'})).toBeTruthy();
});
it('shows a closed error for an expired session instead of treating login HTML as choices',async()=>{
 const fetcher=vi.fn().mockResolvedValue({ok:false,status:401,headers:new Headers({'content-type':'text/html'})}),user=userEvent.setup();vi.stubGlobal('fetch',fetcher);render(<LetterChoicePicker companyId={companyId} kind="field" labels={labels} onChoose={()=>{}}/>);await user.click(screen.getByRole('button',{name:labels.find}));expect((await screen.findByRole('alert')).textContent).toBe(labels.error);
});

it('binds bulk choices to shown scoped results and carries the explicit employee filters',async()=>{
 const rows=[{id:'one',label:'One'},{id:'two',label:'Two'}],choose=vi.fn(),fetcher=vi.fn().mockResolvedValue(response(rows)),user=userEvent.setup();vi.stubGlobal('fetch',fetcher);
 render(<LetterChoicePicker companyId={companyId} kind="employee" labels={labels} filters={{branch:'North',hiredFrom:'2025-01-01'}} onChoose={()=>{}} onChooseMany={choose} manyLabel="Add shown employees"/>);await user.click(screen.getByRole('button',{name:labels.find}));await user.click(await screen.findByRole('button',{name:'Add shown employees'}));expect(choose).toHaveBeenCalledExactlyOnceWith(rows);const params=new URL('https://fixture.test'+fetcher.mock.calls[0][0]).searchParams;expect(params.get('branch')).toBe('North');expect(params.get('hiredFrom')).toBe('2025-01-01');expect(params.get('companyId')).toBe(companyId);
});
