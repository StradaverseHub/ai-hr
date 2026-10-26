import {it,expect,afterEach} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {useState} from 'react';
import {LetterConditionBuilder,type ConditionLabels} from '../components/letters/condition-builder';
import type {LetterCondition,LetterField} from '../lib/letter-model';
const labels:ConditionLabels={operator:'Operator',field:'Field',value:'Value',currency:'Currency',present:'Is present',equals:'Equals',after:'After date',greater:'Greater amount',all:'All conditions',any:'Any condition',not:'Not',add:'Add condition',remove:'Remove condition'};
const fields:LetterField[]=[{key:'name',label:'Name',description:'Name',source:'employee.name',kind:'text',editable:false,required:true,sensitive:false},{key:'hired',label:'Hire date',description:'Date',source:'employment.hiredOn',kind:'date',editable:false,required:true,sensitive:false},{key:'amount',label:'Amount',description:'Amount',source:'custom.currency',kind:'currency',editable:true,required:false,sensitive:true}];
function Form({initial}:{initial:LetterCondition}){const [condition,setCondition]=useState(initial);return <><LetterConditionBuilder condition={condition} fields={fields} labels={labels} onChange={setCondition}/><output data-testid="condition">{JSON.stringify(condition)}</output></>;}
const result=()=>JSON.parse(screen.getByTestId('condition').textContent!);
afterEach(cleanup);
it('preserves every operand when switching between all and any',async()=>{
 const user=userEvent.setup(),conditions:LetterCondition[]=[{type:'present',field:'name'},{type:'equals',field:'hired',value:{kind:'date',value:'2025-01-01'}}];render(<Form initial={{type:'all',conditions}}/>);
 await user.selectOptions(screen.getAllByLabelText('Operator')[0],'any');expect(result()).toEqual({type:'any',conditions});
 await user.selectOptions(screen.getAllByLabelText('Operator')[0],'all');expect(result()).toEqual({type:'all',conditions});
});
it('offers type-compatible operators and requires an explicit currency and amount',async()=>{
 const user=userEvent.setup();render(<Form initial={{type:'present',field:'name'}}/>);expect(screen.queryByRole('option',{name:'Greater amount'})).toBeNull();expect(screen.queryByRole('option',{name:'After date'})).toBeNull();
 await user.selectOptions(screen.getByLabelText('Field'),'hired');await user.selectOptions(screen.getByLabelText('Operator'),'after');expect(screen.getByLabelText('Value')).toHaveProperty('type','date');
 await user.selectOptions(screen.getByLabelText('Field'),'amount');expect(result()).toEqual({type:'equals',field:'amount',value:{kind:'currency',value:'',currency:''}});
 await user.selectOptions(screen.getByLabelText('Operator'),'greater');await user.type(screen.getByLabelText('Value'),'1200.50');await user.selectOptions(screen.getByLabelText('Currency'),'MYR');expect(result()).toEqual({type:'greater',field:'amount',value:{kind:'currency',value:'1200.50',currency:'MYR'}});
});
