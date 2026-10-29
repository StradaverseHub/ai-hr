import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EquipmentReceipts } from '../components/lifecycle-v9/equipment-receipts';
it('allows receipt only after handover and preserves a rejected problem note',async()=>{
  const save=vi.fn().mockResolvedValue({ok:false,error:'The case changed.'});
  const view=render(<EquipmentReceipts busy={false} open items={[{id:'laptop',name:'Fictional laptop',kind:'device',state:'ready',approval:'approved',handedAt:null,receipt:null}]} save={save}/>);
  expect(screen.queryByRole('button',{name:'Confirm received Fictional laptop'})).not.toBeInTheDocument();
  view.rerender(<EquipmentReceipts busy={false} open items={[{id:'laptop',name:'Fictional laptop',kind:'device',state:'handed',approval:'approved',handedAt:'2026-10-30T00:00:00Z',receipt:null}]} save={save}/>);
  fireEvent.click(screen.getByRole('button',{name:'Report a problem with Fictional laptop'}));
  expect(screen.getByRole('button',{name:'Send problem report'})).toBeDisabled();
  fireEvent.change(screen.getByLabelText('What isn’t right? *'),{target:{value:'Fictional charger is missing.'}});
  fireEvent.click(screen.getByRole('button',{name:'Send problem report'}));
  await waitFor(()=>expect(save).toHaveBeenCalledWith('laptop','problem','Fictional charger is missing.'));
  expect(await screen.findByRole('alert')).toHaveTextContent('The case changed.');
  expect(screen.getByLabelText('What isn’t right? *')).toHaveValue('Fictional charger is missing.');
});
