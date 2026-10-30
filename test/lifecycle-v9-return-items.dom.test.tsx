import { expect,it,vi } from 'vitest';
import { render,screen,fireEvent,waitFor } from '@testing-library/react';
import { ReturnItems } from '../components/lifecycle-v9/return-items';
import type { Item } from '../lib/lifecycle-v9-model';
const device:Item={id:'device',name:'Fictional device',kind:'device',sourceId:null,group:'team',assignee:'team-owner',dueOn:'2026-11-30',status:'todo',reason:''};
it('keeps a rejected declaration editable and separates reporting from actual recovery',async()=>{
  const report=vi.fn().mockResolvedValueOnce({ok:false,error:'Case changed. Refresh before saving.'}).mockResolvedValueOnce({ok:true});
  const view=render(<ReturnItems items={[device,{...device,id:'system',name:'Fictional access',kind:'system'}]} own open busy={false} report={report}/>);
  expect(screen.getAllByRole('button',{name:'I returned this item'})).toHaveLength(1);
  fireEvent.click(screen.getByRole('button',{name:'I returned this item'}));fireEvent.change(screen.getByRole('textbox',{name:'Return note (optional)'}),{target:{value:'Fictional receipt'}});fireEvent.click(screen.getByRole('button',{name:'Confirm I returned it'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Case changed');expect(screen.getByRole('textbox')).toHaveValue('Fictional receipt');
  fireEvent.click(screen.getByRole('button',{name:'Confirm I returned it'}));await waitFor(()=>expect(screen.queryByRole('textbox')).not.toBeInTheDocument());expect(report).toHaveBeenLastCalledWith('device','Fictional receipt');
  view.rerender(<ReturnItems items={[{...device,returnReported:{at:'2026-10-30T12:00:00Z',by:'employee',note:'Fictional receipt'}}]} own open busy={false} report={report}/>);
  expect(screen.getByText('Waiting for the team to confirm')).toBeVisible();expect(screen.queryByRole('button',{name:'I returned this item'})).not.toBeInTheDocument();expect(screen.queryByText('Returned',{exact:true})).not.toBeInTheDocument();
});
it('does not let assigned colleagues declare the subject’s return or change resolved items',()=>{
  render(<ReturnItems items={[device,{...device,id:'done',status:'done'},{...device,id:'missing',status:'notReturned'}]} own={false} open busy={false} report={vi.fn()}/>);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();expect(screen.getByText('Returned',{exact:true})).toBeVisible();expect(screen.getByText('Marked not returned')).toBeVisible();
});

it('shows team confirmation only for a current assigned-item capability and retains rejected work',async()=>{
  const complete=vi.fn().mockResolvedValueOnce({ok:false,error:'Refresh your assignment.'}).mockResolvedValueOnce({ok:true});
  render(<ReturnItems items={[{...device,canFulfil:true},{...device,id:'viewer',name:'Read-only item'},{...device,id:'done',status:'done',canFulfil:true}]} own={false} open busy={false} report={vi.fn()} complete={complete}/>);
  expect(screen.queryByRole('button',{name:'I returned this item'})).not.toBeInTheDocument();
  expect(screen.getAllByRole('button',{name:/Update return work for/})).toHaveLength(1);
  fireEvent.click(screen.getByRole('button',{name:'Update return work for Fictional device'}));
  fireEvent.change(screen.getByRole('combobox',{name:'Work status'}),{target:{value:'done'}});
  fireEvent.change(screen.getByRole('textbox',{name:'Team recovery note (optional)'}),{target:{value:'Fictional recovery receipt'}});
  fireEvent.click(screen.getByRole('button',{name:'Save return work'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Refresh your assignment.');
  expect(screen.getByRole('textbox')).toHaveValue('Fictional recovery receipt');
  fireEvent.click(screen.getByRole('button',{name:'Save return work'}));
  await waitFor(()=>expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
  expect(complete).toHaveBeenLastCalledWith('device','done','Fictional recovery receipt');
});
