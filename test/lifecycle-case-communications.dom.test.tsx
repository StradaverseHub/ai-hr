import {afterEach,beforeAll,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {CaseCommunications} from '../app/lifecycle/v9/case-communications';
import {communicationsFixture} from './helpers/communications-fixture';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/lifecycle/v9/actions',()=>({readV9Email:vi.fn(),readV9Workflow:vi.fn(),readV9UpdatedEmail:vi.fn()}));
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLElement.prototype.scrollIntoView=vi.fn();});afterEach(cleanup);
function setup(canUploadFiles=false){const fixture=communicationsFixture(),command=vi.fn().mockResolvedValue({ok:false,error:'Keep this review.'}),onDocument=vi.fn();const view=render(<NextIntlClientProvider locale="en" messages={messages}><div className="v9-workspace"><CaseCommunications {...fixture} busy={false} writableKeys={['mobile']} users={[{id:'hr',name:'Fictional HR'}]} command={command} onDocument={onDocument} canUploadFiles={canUploadFiles} today="2026-11-27"/></div></NextIntlClientProvider>);return{...fixture,command,onDocument,...view};}
it('defaults to Schedule, hides tests, shares exact filter counts and opens the existing recipient fixing surface without a write',async()=>{
 const {command}=setup();expect(screen.getByRole('tab',{name:'Schedule 3'})).toHaveAttribute('aria-selected','true');expect(screen.queryByText('Fictional test only')).not.toBeVisible();
 expect(screen.getByRole('button',{name:'All 3'})).toHaveAttribute('aria-pressed','true');fireEvent.click(screen.getByRole('button',{name:'Needs attention 1'}));expect(screen.getAllByRole('listitem').filter(node=>node.id.startsWith('communications-schedule-')).filter(node=>!node.hidden)).toHaveLength(1);
 fireEvent.click(screen.getAllByRole('button',{name:'Resolve recipient'})[0]);await screen.findByRole('button',{name:'Save recipients for this case'});expect(command).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('checkbox',{name:'Show test workflows (1)'}));expect(screen.getByRole('tab',{name:'Schedule 4'})).toBeVisible();
});
it('retains every document operation and takes exact document / Used by / sent receipt links across tabs',async()=>{
 const {onDocument}=setup();fireEvent.click(screen.getByRole('button',{name:/Fictional acceptance letter · v1 · signed/i}));expect(onDocument).toHaveBeenCalledWith(expect.objectContaining({id:'saved-letter',version:1}));
 fireEvent.click(screen.getByRole('button',{name:'Used by: Fictional welcome email'}));await act(async()=>{await new Promise(resolve=>requestAnimationFrame(resolve));});expect(screen.getByRole('tab',{name:'Schedule 3'})).toHaveAttribute('aria-selected','true');
 fireEvent.click(screen.getByRole('button',{name:'View in sent log'}));await act(async()=>{await new Promise(resolve=>requestAnimationFrame(resolve));});expect(screen.getByRole('tab',{name:'Sent log 2'})).toHaveAttribute('aria-selected','true');expect(document.getElementById('delivery-receipt')?.querySelector('details')).toHaveAttribute('open');
 const rows=[...screen.getByRole('list',{name:'Email delivery history'}).children];expect(rows.map(row=>row.id)).toEqual(['delivery-test-mail','delivery-receipt']);expect(within(rows[0] as HTMLElement).getByText('Test send')).toBeVisible();
});
it('retains Personnel selections and review values when switching tabs; has no upload without the explicit capability',()=>{
 setup();fireEvent.click(screen.getByRole('tab',{name:'Personnel changes 1'}));const selected=screen.getByRole('checkbox',{name:'Push mobile to Personnel Management'});fireEvent.click(selected);expect(selected).not.toBeChecked();
 fireEvent.click(screen.getByRole('tab',{name:'Documents & files 2'}));expect(screen.queryByRole('button',{name:'Upload file'})).not.toBeInTheDocument();fireEvent.click(screen.getByRole('tab',{name:'Personnel changes 1'}));expect(selected).not.toBeChecked();expect(screen.getAllByText('Not recorded').length).toBeGreaterThanOrEqual(2);
});
it('uses the selected configured slot and existing validated POST for dropped files, retaining refused uploads',async()=>{
 setup(true);fireEvent.click(screen.getByRole('tab',{name:'Documents & files 2'}));fireEvent.change(screen.getByRole('combobox',{name:'Attachment for'}),{target:{value:'welcome:support'}});
 const file=new File(['%PDF-1.4 fictional'],'Fictional dropped.pdf',{type:'application/pdf'});fireEvent.drop(screen.getByRole('form',{name:'Upload file'}),{dataTransfer:{files:[file]}});
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:false,json:async()=>({error:'The case changed.'})} as Response);fireEvent.submit(screen.getByRole('form',{name:'Upload file'}));await screen.findByRole('alert');expect(fetch).toHaveBeenCalledWith('/lifecycle/v9/files/communications-off',expect.objectContaining({method:'POST',body:expect.any(FormData)}));const sent=fetch.mock.calls[0][1]!.body as FormData;expect(sent.get('slot')).toBe('welcome:support');expect(sent.get('revision')).toBe('1');expect(screen.getByText('Fictional dropped.pdf')).toBeVisible();fetch.mockRestore();
});
it('uses keyboard tab navigation and hides the Personnel tab when no changes exist',()=>{
 const {c,config,rerender}=setup();const schedule=screen.getByRole('tab',{name:'Schedule 3'});fireEvent.keyDown(schedule,{key:'ArrowRight'});expect(screen.getByRole('tab',{name:'Documents & files 2'})).toHaveFocus();
 rerender(<NextIntlClientProvider locale="en" messages={messages}><CaseCommunications c={{...c,pmChanges:[]}} config={config} busy={false} command={vi.fn()} users={[]} writableKeys={[]} onDocument={vi.fn()}/></NextIntlClientProvider>);expect(screen.queryByRole('tab',{name:/Personnel changes/})).not.toBeInTheDocument();
});
