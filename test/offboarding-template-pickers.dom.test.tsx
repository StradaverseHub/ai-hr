import { useState } from 'react';
import { expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { TemplateVersionEditor } from '../app/lifecycle/v9/template-version-editor';
import type { TemplateVersion } from '../lib/lifecycle-v9-model';

const initial:TemplateVersion={version:1,state:'draft',at:'',by:'',blocks:[{id:'sig',type:'signature',role:'hr',label:'HR signature',text:'',section:'main'}],fields:[],routing:[
  {id:'review',order:1,action:'review',who:{kind:'directSuperior'},owner:true},
  {id:'employee',order:3,action:'sign',who:{kind:'employee'},owner:false},
  {id:'manager',order:2,action:'sign',who:{kind:'directSuperior'},owner:false},
]};
function Harness({routed=false}:{routed?:boolean}){
  const [version,setVersion]=useState<TemplateVersion>(structuredClone(initial));
  return <><TemplateVersionEditor version={version} name="Fictional letter" disabled={false} useRoutingSigners={routed} change={change=>setVersion(old=>{const next=structuredClone(old);change(next);return next;})}/><output data-testid="version">{JSON.stringify(version)}</output></>;
}
it('offers only Sign steps and links new signatures to the first Sign step without rewriting legacy content',()=>{
  render(<Harness routed/>);
  const signer=screen.getByLabelText('Signer 1');
  expect(signer).toHaveValue('hr');
  expect(within(signer).getByRole('option',{name:'hr · choose a signing step'})).toBeInTheDocument();
  expect(within(signer).queryByRole('option',{name:/Step 1/})).not.toBeInTheDocument();
  expect(within(signer).getByRole('option',{name:'Step 2 · Sign · Direct Superior'})).toHaveValue('step:manager');
  fireEvent.change(screen.getByLabelText('Add block'),{target:{value:'signature'}});
  expect(screen.getByLabelText('Signer 2')).toHaveValue('step:manager');
  expect(JSON.parse(screen.getByTestId('version').textContent!).blocks[0].role).toBe('hr');
  fireEvent.change(signer,{target:{value:'step:employee'}});
  expect(JSON.parse(screen.getByTestId('version').textContent!).blocks[0].role).toBe('step:employee');
});
it('keeps existing HR and employee signature choices without routing opt-in',()=>{
  render(<Harness/>);
  expect(screen.getByLabelText('Signer 1')).toHaveValue('hr');
  expect(within(screen.getByLabelText('Signer 1')).getAllByRole('option').map(option=>option.getAttribute('value'))).toEqual(['employee','hr']);
  fireEvent.change(screen.getByLabelText('Add block'),{target:{value:'signature'}});
  expect(screen.getByLabelText('Signer 2')).toHaveValue('employee');
});
