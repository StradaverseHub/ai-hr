import {expect,it} from 'vitest';
import {validateProbationLetterFields} from '../lib/probation-letter-document';
import type {Field} from '../lib/lifecycle-v9-model';
const employee:Field={id:'employeeAnswer',label:'Employee answer',type:'text',owner:'employee',pmKey:null,required:true,sensitive:false,options:[],section:'main',when:null};
it('defers employee-required values at preparation but refuses any signature until they are completed',()=>{
 expect(()=>validateProbationLetterFields([employee],{},{preparing:true})).not.toThrow();
 expect(()=>validateProbationLetterFields([employee],{})).toThrow('Complete every required');
 expect(()=>validateProbationLetterFields([employee],{employeeAnswer:'Acknowledged'})).not.toThrow();
 const hr={...employee,id:'hrAnswer',owner:'hr' as const};
 expect(()=>validateProbationLetterFields([hr],{},{preparing:true})).toThrow('Complete every required');
});
it('keeps type and conditional checks deterministic for employee fields',()=>{
 const check={...employee,id:'employeeCheck',type:'checkbox' as const};
 expect(()=>validateProbationLetterFields([check],{employeeCheck:'invalid'},{preparing:true})).toThrow('valid value');
 expect(()=>validateProbationLetterFields([check],{employeeCheck:'false'})).toThrow('Complete every required');
 const conditional={...employee,when:{field:'control',value:'yes'}};
 expect(()=>validateProbationLetterFields([conditional],{control:'no'})).not.toThrow();
});
