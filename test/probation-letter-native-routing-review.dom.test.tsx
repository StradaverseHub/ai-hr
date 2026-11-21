import {expect,it,vi} from 'vitest';
import {fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {LegacyLetterRoutingReview} from '../app/lifecycle/probation/templates/legacy-routing-review';
import {newProbationLetterTemplate} from '../lib/probation-letter-template';
it('requires an explicit PBP mapping and preserves the original route/version content',()=>{
 const template=newProbationLetterTemplate('confirm','saved-id','Saved letter'),frozen=structuredClone(template),apply=vi.fn();
 render(<NextIntlClientProvider locale="en" messages={messages}><LegacyLetterRoutingReview template={template} choices={{routings:[{id:'native-route',name:'Native BP route'}],groups:[],people:[]}} disabled={false} onApply={apply}/></NextIntlClientProvider>);
 const button=screen.getByRole('button',{name:'Use reviewed mapping'});
 expect(button).toBeDisabled();
 // A similarly named native route is offered; it is never selected from its name automatically.
 fireEvent.change(screen.getAllByRole('combobox')[0],{target:{value:'routing:native-route'}});
 expect(button).not.toBeDisabled();fireEvent.click(button);
 expect(apply).toHaveBeenCalledOnce();
 expect(apply.mock.calls[0][0]).toEqual([{id:'pbp',order:1,action:'sign',required:true,owner:false,who:{kind:'routing',routingId:'native-route'}},{id:'employee',order:2,action:'acknowledge',required:true,owner:false,who:{kind:'employee'}}]);
 expect(apply.mock.calls[0][1].filter((block:{type:string})=>block.type==='signature').map((block:{role:string})=>block.role)).toEqual(['step:pbp','step:employee']);
 expect(template).toEqual(frozen);
});
