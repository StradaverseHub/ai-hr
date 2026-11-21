import {useState} from 'react';
import {expect,it} from 'vitest';
import {fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {TemplateRoutingEditor} from '../app/lifecycle/probation/templates/routing-editor';
import type {DocumentRouting} from '../lib/document-signing-routing';
import type {Block} from '../lib/lifecycle-v9-model';
function Harness(){
 const[routing,setRouting]=useState<DocumentRouting>([{id:'ack',order:1,action:'acknowledge',who:{kind:'employee'},owner:false}]);
 const[blocks,setBlocks]=useState<Block[]>([{id:'sig',type:'signature',role:'step:ack',text:'',section:'main'}]);
 return <><TemplateRoutingEditor value={routing} blocks={blocks} choices={{routings:[],groups:[],people:[]}} editable onChange={setRouting} onBlocksChange={setBlocks} newId={()=>'next'}/><output data-testid="routing">{JSON.stringify(routing)}</output></>;
}
it('shows acknowledgement in the single routing editor and defaults old steps to Required',()=>{
 render(<NextIntlClientProvider locale="en" messages={messages}><Harness/></NextIntlClientProvider>);
 const step=within(screen.getByRole('group',{name:'Step 1'}));
 expect(step.getByRole('combobox',{name:'Action'})).toHaveValue('acknowledge');
 expect(step.getByRole('checkbox',{name:'Required'})).toBeChecked();
 expect(screen.queryByRole('alert')).not.toBeInTheDocument();
 fireEvent.click(step.getByRole('checkbox',{name:'Required'}));
 expect(JSON.parse(screen.getByTestId('routing').textContent!)[0].required).toBe(false);
 expect(screen.getByRole('alert')).toHaveTextContent('At least one step must be a Sign step');
});
