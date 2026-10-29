import {expect,it,vi} from 'vitest';
import {fireEvent,render,screen} from '@testing-library/react';
import {UpdatedEmailReview} from '../app/lifecycle/v9/updated-email-review';
import {readV9UpdatedEmail} from '../app/lifecycle/v9/actions';
vi.mock('../app/lifecycle/v9/actions',()=>({readV9UpdatedEmail:vi.fn()}));
it('requires a reviewed preview/reason and retains both when queueing fails',async()=>{
 const token='a'.repeat(64);vi.mocked(readV9UpdatedEmail).mockResolvedValue({ok:true,preview:{sourceRevision:token,subject:'Fictional current copy',body:'Reviewed body',to:['Fictional employee'],cc:['Fictional colleague'],documents:[{name:'Saved form',version:2}],files:['current.txt']}});const command=vi.fn().mockResolvedValue({ok:false,error:'The copy changed.'});render(<UpdatedEmailReview caseId="case" mailId="mail" busy={false} command={command}/>);
 expect(screen.queryByRole('button',{name:'Queue reviewed updated copy'})).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Review updated copy'}));expect(await screen.findByText('Fictional current copy')).toBeVisible();expect(screen.getByRole('button',{name:'Queue reviewed updated copy'})).toBeDisabled();fireEvent.change(screen.getByLabelText('Updated-copy review reason *'),{target:{value:'Fictional failed copy reviewed.'}});fireEvent.click(screen.getByRole('button',{name:'Queue reviewed updated copy'}));expect(await screen.findByRole('alert')).toHaveTextContent('The copy changed.');expect(screen.getByLabelText('Updated-copy review reason *')).toHaveValue('Fictional failed copy reviewed.');expect(command).toHaveBeenCalledWith({type:'emailReplace',id:'mail',sourceRevision:token,reason:'Fictional failed copy reviewed.'});
});
