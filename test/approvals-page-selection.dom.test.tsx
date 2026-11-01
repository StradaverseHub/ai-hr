/** Owner decision1November: bulk selection is explicit and limited to displayed rows. */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import type {BulkRow} from '../lib/approvals-bulk';
vi.mock('../app/approvals/actions',()=>({bulkDecideAction:vi.fn()}));
import {BulkSelectionProvider,BulkSelectAllToggle,BulkSectionSelectAll,BulkRowCheckbox} from '../app/approvals/bulk-selection';
afterEach(cleanup);
const ids=Array.from({length:5},(_,i)=>'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'));
const claim=(id:string):BulkRow=>({id,type:'claim',category:'claim'});
const leave:BulkRow={id:ids[2],type:'leave',category:'leave'};
function Fixture({rows}:{rows:BulkRow[]}){
 return <NextIntlClientProvider locale="en" timeZone="Asia/Kuala_Lumpur" messages={messages}>
  <BulkSelectionProvider rows={rows}>
   <section aria-label="Queue selection"><BulkSelectAllToggle/></section>
   <section aria-label="Claims selection"><BulkSectionSelectAll type="claim"/></section>
   {rows.map(row=><fieldset key={row.id} aria-label={row.id}><BulkRowCheckbox id={row.id} type={row.type}/></fieldset>)}
  </BulkSelectionProvider>
 </NextIntlClientProvider>;
}
const selectPage=()=>fireEvent.click(within(screen.getByRole('region',{name:'Queue selection'})).getByRole('checkbox',{name:'Select all on this page'}));
const selected=(id:string)=>(within(screen.getByRole('group',{name:id})).getByRole('checkbox') as HTMLInputElement).checked;
function confirmItems(){
 fireEvent.click(screen.getByRole('button',{name:'Approve selected'}));
 const dialog=screen.getByRole('dialog',{name:'Confirm bulk approval'});
 const input=dialog.querySelector<HTMLInputElement>('input[name="items"]');expect(input).not.toBeNull();
 return JSON.parse(input!.value) as {type:string;id:string}[];
}
it('labels Select all as current-page scope and confirms only the displayed IDs',()=>{
 render(<Fixture rows={[claim(ids[0]),claim(ids[1]),leave]}/>);selectPage();
 expect([ids[0],ids[1],ids[2]].map(selected)).toEqual([true,true,true]);
 expect(confirmItems()).toEqual([{type:'claim',id:ids[0]},{type:'claim',id:ids[1]},{type:'leave',id:ids[2]}]);
});
it('drops Claims from the previous page and never adds newly displayed rows until selected',()=>{
 const view=render(<Fixture rows={[claim(ids[0]),claim(ids[1]),leave]}/>);selectPage();
 view.rerender(<Fixture rows={[claim(ids[3]),claim(ids[4]),leave]}/>);
 expect(screen.queryByRole('group',{name:ids[0]})).toBeNull();
 expect([ids[3],ids[4],ids[2]].map(selected)).toEqual([false,false,true]);
 selectPage();expect(confirmItems()).toEqual([{type:'claim',id:ids[3]},{type:'claim',id:ids[4]},{type:'leave',id:ids[2]}]);
});
it('keeps section selection within the current Claims slice and retains mandatory rejection reasons',()=>{
 render(<Fixture rows={[claim(ids[0]),claim(ids[1]),leave]}/>);
 fireEvent.click(within(screen.getByRole('region',{name:'Claims selection'})).getByRole('checkbox',{name:'Select all on this page'}));
 expect([ids[0],ids[1],ids[2]].map(selected)).toEqual([true,true,false]);
 fireEvent.click(screen.getByRole('button',{name:'Reject selected'}));
 const dialog=screen.getByRole('dialog',{name:'Confirm bulk rejection'});
 expect(within(dialog).getByRole('button',{name:'Confirm'}).hasAttribute('disabled')).toBe(true);
 fireEvent.change(within(dialog).getByRole('textbox'),{target:{value:'Fictional reviewed reason'}});
 expect(within(dialog).getByRole('button',{name:'Confirm'}).hasAttribute('disabled')).toBe(false);
 expect(JSON.parse(dialog.querySelector<HTMLInputElement>('input[name="items"]')!.value)).toEqual([{type:'claim',id:ids[0]},{type:'claim',id:ids[1]}]);
});
