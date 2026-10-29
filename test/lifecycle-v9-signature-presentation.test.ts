import {expect,it} from 'vitest';
import {v9SignaturePresentation} from '../lib/lifecycle-v9-signature-presentation';
import type {Document} from '../lib/lifecycle-v9-model';
const document={signatoryUserId:'designated',hrSignature:null,employeeSignature:null,mergeValues:{'employee.name':'Fictional employee','employee.icNo':'FICTIONAL-ID','signatory.name':'Designated HR','signatory.title':'Saved title','company.name':'Fictional company'}} as unknown as Document;
it('prints the saved designated identity without implying an unsigned draft is signed',()=>{
  expect(v9SignaturePresentation(document,'hr')).toMatchObject({signature:null,name:'Designated HR',detail:'Saved title, Fictional company',status:'Not signed yet'});
  expect(v9SignaturePresentation(document,'employee')).toMatchObject({signature:null,name:'Fictional employee',detail:'NRIC: FICTIONAL-ID',status:'Not signed yet'});
});
it('uses the actual countersigner and frozen printed title instead of another signer’s title',()=>{
  const signed={...document,hrSignature:{by:{id:'reviewer',name:'Actual HR reviewer'},at:'2026-10-30T01:02:00Z',method:'typed' as const,value:'Typed mark',consent:true as const,printedTitle:'Counter reviewer'}};
  expect(v9SignaturePresentation(signed,'hr')).toMatchObject({name:'Actual HR reviewer',detail:'Counter reviewer, Fictional company',status:'Signed electronically on 30 Oct 2026, 09:02'});
  delete (signed.hrSignature as {printedTitle?:string}).printedTitle;
  expect(v9SignaturePresentation(signed,'hr').detail).toBe('Fictional company');
});
