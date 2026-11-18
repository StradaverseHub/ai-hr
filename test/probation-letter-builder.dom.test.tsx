import {useState} from 'react';
import {expect,it} from 'vitest';
import {fireEvent,render,screen} from '@testing-library/react';
import {TemplateVersionEditor} from '../app/lifecycle/v9/template-version-editor';
import {probationLetterMergeGroups,probationLetterSampleValues} from '../lib/probation-letter-builder';
import type {TemplateVersion} from '../lib/lifecycle-v9-model';

function Harness(){
 const [version,setVersion]=useState<TemplateVersion>({version:1,state:'draft',at:'',by:'',blocks:[{id:'text',type:'text',text:'Dear ',section:'main'}],fields:[]});
 return <><TemplateVersionEditor personnelPicker mergeGroups={probationLetterMergeGroups} previewValues={{...probationLetterSampleValues}} version={version} name="Sample outcome" disabled={false} change={change=>setVersion(value=>{const next=structuredClone(value);change(next);return next;})}/><output data-testid="saved">{JSON.stringify(version)}</output></>;
}
it('inserts a registered Probation field at the cursor without exposing unrelated Personnel fields',()=>{
 render(<Harness/>);
 const text=screen.getByLabelText('Text 1') as HTMLTextAreaElement;
 fireEvent.focus(text);text.setSelectionRange(5,5);
 fireEvent.change(screen.getByLabelText('Search merge fields'),{target:{value:'Extension months'}});
 fireEvent.click(screen.getByRole('button',{name:'Extension months',exact:true}));
 expect(JSON.parse(screen.getByTestId('saved').textContent!).blocks[0].text).toBe('Dear {extensionMonths}');
 expect(screen.queryByRole('button',{name:'IC number',exact:true})).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('tab',{name:'Preview'}));
 expect(screen.getByText('Dear 3')).toBeInTheDocument();
});
it('uses the same typed Personnel field picker for registered case fields with sample date preview',()=>{
 render(<Harness/>);
 fireEvent.change(screen.getByLabelText('Search merge fields'),{target:{value:'Probation start'}});
 fireEvent.click(screen.getByRole('button',{name:'Add Probation start as a pre-filled field'}));
 fireEvent.click(screen.getByRole('tab',{name:'Fields'}));
 expect(screen.getByLabelText('Field 1 Personnel field')).toHaveValue('startOn');
 expect(screen.getByLabelText('Field 1 completed by')).toHaveValue('pmLocked');
 fireEvent.click(screen.getByRole('tab',{name:'Preview'}));
 expect(screen.getByDisplayValue('2026-01-01')).toBeDisabled();
});
