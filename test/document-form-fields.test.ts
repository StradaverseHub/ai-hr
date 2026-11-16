import {describe,expect,it} from 'vitest';
import {documentFieldValueProblem,documentRequiredFieldProblems,documentResponsePatch,derivedDocumentKind} from '../lib/document-form-fields';
import {validateFieldValue,type Field,type Block} from '../lib/lifecycle-v9-model';

const field=(patch:Partial<Field>={}):Field=>({id:'answer',label:'Answer',type:'text',owner:'employee',pmKey:null,required:false,sensitive:false,options:[],section:'main',when:null,...patch});
const block=(patch:Partial<Block>={}):Block=>({id:'body',type:'text',text:'Existing wording',section:'main',...patch});
describe('shared document field rules extracted from the V9 owner',()=>{
 it('keeps V9 value validation and error messages for typed answers',()=>{
  const cases:[Field,string][]=[
   [field({type:'select',options:['One']}),'Two'],[field({type:'date'}),'2026-02-30'],[field({type:'checkbox'}),'yes'],
   [field({type:'email'}),'someone'],[field({type:'number'}),'Infinity'],[field({type:'table',columns:['One','Two']}),'[["one"]]'],
  ];
  for(const [definition,value] of cases){const message=documentFieldValueProblem(definition,value);expect(message).toBeTruthy();expect(()=>validateFieldValue(definition,value)).toThrow(message!);}
  expect(documentFieldValueProblem(field({type:'table',columns:['One','Two']}),'[["one","two"]]')).toBeNull();
 });
 it('uses show-when only for active requiredness and requires a checked required consent',()=>{
  const fields=[field({id:'show',type:'select',options:['Yes','No']}),field({required:true,when:{field:'show',value:'Yes'}}),field({id:'consent',type:'checkbox',required:true})];
  expect(documentRequiredFieldProblems(fields,{show:'No',answer:'',consent:'true'})).toEqual([]);
  expect(documentRequiredFieldProblems(fields,{show:'Yes',answer:'',consent:'false'})).toEqual(['Complete Answer before signing.']);
  expect(documentRequiredFieldProblems([field({owner:'employee',required:true})],{},'hr')).toEqual([]);
  expect(documentRequiredFieldProblems([field({owner:'hr',required:true})],{},'employee')).toEqual(['Complete Answer before signing.']);
 });
 it('accepts only native-adjudicated owned field IDs and never Personnel-locked or unknown fields',()=>{
  const fields=[field(),field({id:'hr',owner:'hr'}),field({id:'locked',owner:'pmLocked',pmKey:'employee.name'})];
  expect(documentResponsePatch(fields,{answer:'old'},{answer:'new'},['answer'])).toEqual({values:{answer:'new'},problems:[]});
  expect(documentResponsePatch(fields,{},{hr:'attempt',locked:'attempt',unknown:'attempt'},['answer','locked']).problems).toEqual(['This field cannot be changed.']);
  const special=field({id:'constructor'});const patched=documentResponsePatch([special],{},JSON.parse('{"constructor":"An actual answer"}'),['constructor']);
  expect(Object.hasOwn(patched.values,'constructor')).toBe(true);expect(patched.values.constructor).toBe('An actual answer');
 });
 it('derives kind from actual field and signature blocks and Employee routing steps',()=>{
  expect(derivedDocumentKind([block({type:'field',fieldId:'answer'})])).toBe('Form');
  expect(derivedDocumentKind([block({type:'signature',role:'employee'})])).toBe('Acknowledgement');
  expect(derivedDocumentKind([block({type:'signature',role:'step:employee-step'})],['employee-step'])).toBe('Acknowledgement');
  expect(derivedDocumentKind([block({type:'signature',role:'step:bp-step'})],['employee-step'])).toBe('Letter');
 });
});
