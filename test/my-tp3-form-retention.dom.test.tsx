import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
import {Tp3DeclarationFields} from '../components/tp3-declaration-fields';
import {MyTp3EditableForm} from '../app/(app)/me/tp3/form-client';
import {amountField,employerNameField,employerTinField,subField} from '../lib/tp3-form-input';
import {todayInKualaLumpur} from '../lib/hr-date';

const {action}=vi.hoisted(()=>({action:vi.fn()}));
vi.mock('../app/(app)/me/tp3/actions',()=>({myTp3FormAction:action}));
vi.mock('next-intl',()=>({useTranslations:()=>((key:string)=>key)}));
vi.mock('next-intl/server',()=>({getLocale:async()=> 'en',getTranslations:async()=>((key:string)=>key)}));
vi.mock('../packs/payroll/service',async()=>{
 const actual=await vi.importActual<typeof import('../core/tp3')>('../core/tp3');
 return{deriveAccumulatorSeed:actual.deriveAccumulatorSeed,tp3EpfReliefCap:actual.tp3EpfReliefCap,
  tp3ExemptionOverLimits:actual.tp3ExemptionOverLimits,tp3LineNumber:actual.tp3LineNumber,
  TP3_MAX_EMPLOYERS:actual.TP3_MAX_EMPLOYERS,TP3_SECTION_C:actual.TP3_SECTION_C,TP3_SECTION_D:actual.TP3_SECTION_D};
});
const identity={employee:{name:'Fictional TP3 employee',idNumber:null,tin:null},stored:{tp3Year:null,netRemuneration:null,epfClaimed:null,pcbPaid:null,zakatPaid:null,lp:null}};
const named=(name:string)=>document.querySelector(`[name="${name}"]`) as HTMLInputElement;
beforeEach(()=>{action.mockReset();action.mockResolvedValue({error:'Fictional server validation refusal'});});

it('retains the actual shared personal TP3 fields through refusal and submits the corrected declaration',async()=>{
 const fields=await Tp3DeclarationFields({record:null,identity,selectedYear:Number(todayInKualaLumpur().slice(0,4)),mode:'personal'});
 render(<MyTp3EditableForm>{fields}</MyTp3EditableForm>);
 const values=[
  [employerNameField(1),'Fictional former employer'],[employerTinField(1),'F1234567'],
  [amountField('c','c1'),'12345.67'],[subField('c','c2','i'),'7000.00'],[amountField('d','c2'),'888.80'],
 ] as const;
 for(const [name,value] of values){expect(named(name)).not.toBeNull();fireEvent.change(named(name),{target:{value}});}
 fireEvent.change(named('deductionMonth'),{target:{value:'3'}});
 const declaration=screen.getByRole('checkbox',{name:'tp3.declarationTick'});fireEvent.click(declaration);
 fireEvent.click(screen.getByRole('button',{name:'submit'}));
 await screen.findByText('Fictional server validation refusal');
 await waitFor(()=>expect(screen.getByRole('button',{name:'submit'})).not.toBeDisabled());
 for(const [name,value] of values)expect(named(name).value).toBe(value);
 expect(named('deductionMonth').value).toBe('3');expect(declaration).toBeChecked();
 expect(document.activeElement).toContainElement(screen.getByText('Fictional server validation refusal'));
 fireEvent.change(named(amountField('c','c1')),{target:{value:'13000.00'}});
 fireEvent.click(screen.getByRole('button',{name:'submit'}));
 await waitFor(()=>expect(action).toHaveBeenCalledTimes(2));
 const submitted=action.mock.calls[1][1] as FormData;
 expect(submitted.get(amountField('c','c1'))).toBe('13000.00');
 expect(submitted.get(employerNameField(1))).toBe('Fictional former employer');
 expect(submitted.get('deductionMonth')).toBe('3');expect(submitted.getAll('declarationAccepted')).toEqual(['no','yes']);
});

it('retains an explicit blank deduction month and unticked declaration after a refused draft save',async()=>{
 const fields=await Tp3DeclarationFields({record:null,identity,selectedYear:Number(todayInKualaLumpur().slice(0,4)),mode:'personal'});
 render(<MyTp3EditableForm>{fields}</MyTp3EditableForm>);
 fireEvent.change(named(employerNameField(1)),{target:{value:'Fictional employer without a chosen month'}});
 fireEvent.click(screen.getByRole('button',{name:'saveDraft'}));
 await screen.findByText('Fictional server validation refusal');
 expect(named(employerNameField(1)).value).toBe('Fictional employer without a chosen month');
 expect(named('deductionMonth').value).toBe('');expect(screen.getByRole('checkbox',{name:'tp3.declarationTick'})).not.toBeChecked();
 const submitted=action.mock.calls[0][1] as FormData;
 expect(submitted.get('deductionMonth')).toBe('');expect(submitted.getAll('declarationAccepted')).toEqual(['no']);
});

it('gives every canonical numeric TP3 field its unique section code and translated description',async()=>{
 render(<MyTp3EditableForm>{await Tp3DeclarationFields({record:null,identity,selectedYear:Number(todayInKualaLumpur().slice(0,4)),mode:'personal'})}</MyTp3EditableForm>);
 const fields=screen.getAllByRole('spinbutton');
 expect(fields).toHaveLength(44);
 const labels=fields.map(field=>field.getAttribute('aria-label'));
 expect(labels.every(label=>!!label&&/^[CD]\d+(\([a-z]+\))? · .+/.test(label))).toBe(true);
 expect(new Set(labels).size).toBe(fields.length);
 expect(screen.getByRole('spinbutton',{name:'C1 · tp3.money.c1.label'})).toHaveAttribute('name',amountField('c','c1'));
});
