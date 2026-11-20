import { useState } from 'react';
import { beforeAll, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { WorkflowEditor } from '../app/lifecycle/v9/workflow-editor';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
import type { Workflow } from '../lib/lifecycle-v9-model';
const preview=vi.hoisted(()=>vi.fn().mockResolvedValue({ok:true,plan:{lines:[]}}));
vi.mock('../app/lifecycle/v9/actions',()=>({previewV9WorkflowPlan:preview}));
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
const messages=JSON.parse(readFileSync('messages/en.json','utf8'));
const flow=(module:'onb'|'off'):Workflow=>({id:module,name:'Fictional '+module,module,status:'draft',description:'',trigger:{event:'submitted',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[]});
function Harness(){
 const config=v9Defaults();config.workflows=[flow('onb'),flow('off')];
 const [selected,select]=useState('');
 return <NextIntlClientProvider locale="en" messages={messages}><WorkflowEditor save={{state:'saved',error:'',flush:async()=>true,retry:()=>{}}} config={config} selected={selected} select={select} module="onb" setModule={()=>{}} edit={()=>{}} editable cases={[]} users={[]} actor={{id:'hr',name:'HR'}} labels={{}} initialFilter="onb" showModuleFilter={false} allowedModules={['onb']} historyAvailable={false} previewCases={[{id:'sample',module:'onb',label:'Fictional sample case'},{id:'other',module:'off',label:'Other sample'}]}/></NextIntlClientProvider>;
}
it('embeds only Onboarding, uses sample references for dry runs, and avoids claiming absent history is empty',async()=>{
 render(<Harness/>);
 expect(screen.queryByRole('tablist',{name:'Module'})).not.toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'Fictional off'})).not.toBeInTheDocument();
 expect(screen.getByText('Open the case to view its run history.')).toBeInTheDocument();
 expect(screen.queryByText('Not run yet')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'New workflow'}));
 expect(screen.getByRole('button',{name:'For Onboarding'})).toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'For Offboarding'})).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Fictional onb'}));
 fireEvent.change(screen.getByLabelText('Test case'),{target:{value:'sample'}});
 await waitFor(()=>expect(preview).toHaveBeenCalledWith('sample',expect.objectContaining({id:'onb'})));
 expect(screen.queryByRole('option',{name:'Other sample'})).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('tab',{name:'Run history'}));
 expect(screen.queryByText('No runs yet.')).not.toBeInTheDocument();
 expect(screen.queryByRole('tab',{name:'Run history (0)'})).not.toBeInTheDocument();
});
