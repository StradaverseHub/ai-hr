import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CaseNotes } from '../app/lifecycle/v9/case-notes';
import { fictionalV9Case } from './fixtures/lifecycle-v9/case';
vi.mock('../lib/onboarding-copy',()=>({useOnboardingCopy:()=>((text:string)=>text)}));
it('retains a failed note and offers editing only for the actual author',async()=>{
 const command=vi.fn().mockResolvedValue({ok:false,error:'This case changed.'}),actor={id:'hr',name:'HR'};
 const c=fictionalV9Case({notes:[{id:'other-note',context:'task',body:'Other author',by:'other',name:'Other HR',at:'2026-10-30T00:00:00Z',mentions:[],resolved:[],edited:false,deleted:false}]});
 render(<CaseNotes c={c} context="task" label="Fictional task" actor={actor} users={[actor]} busy={false} command={command}/>);
 expect(screen.queryByRole('button',{name:'Edit note'})).not.toBeInTheDocument();
 fireEvent.click(screen.getByText('1 note'));
 fireEvent.change(screen.getByLabelText('Add a note on Fictional task'),{target:{value:'Fictional retained note'}});
 fireEvent.click(screen.getByRole('button',{name:'Send note'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('This case changed.');
 expect(screen.getByLabelText('Add a note on Fictional task')).toHaveValue('Fictional retained note');
 expect(command).toHaveBeenCalledWith({type:'note',context:'task',body:'Fictional retained note',mentions:[]});
});
