import {describe,expect,it,vi} from 'vitest';
import {render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {LetterView} from '../app/lifecycle/probation/letter-view';
import {probationLetterDocument} from '../lib/probation-letter-document';
import {v9SignaturePresentation} from '../lib/lifecycle-v9-signature-presentation';
import type {Block} from '../lib/lifecycle-v9-model';
import type {SigningDocument,SigningRoute} from '../lib/document-signing-model';
import type {ProbationLetterSigner,ProbationLetterView} from '../packs/probation/service';
vi.mock('../app/lifecycle/probation/actions',()=>({signLetter:vi.fn(),resendLetter:vi.fn(),releaseLetter:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));

// Fictional people only.
const reviewer='reviewer-user',partner='partner-user',delegate='delegate-user',staff='staff-user';
const route:SigningRoute={version:1,steps:[
 {id:'review',role:'people',kind:'review',stage:1,holderId:reviewer,required:true,owner:true},
 {id:'sign-hr',role:'routing:bp-routing',kind:'sign',stage:2,holderId:delegate,representedId:partner,required:true},
 {id:'sign-ops',role:'group:ops',kind:'sign',stage:2,holderId:null,required:true},
 {id:'sign-staff',role:'employee',kind:'sign',stage:3,holderId:staff,required:true},
]};
const signers:Record<string,ProbationLetterSigner>={
 review:{holderId:reviewer,name:'Fictional Reviewer',title:null,label:null,role:'people',representedName:null},
 'sign-hr':{holderId:delegate,name:'Fictional Delegate',title:'Fictional HR Manager',label:'BP by business group',role:'routing:bp-routing',representedName:'Fictional Partner'},
 'sign-ops':{holderId:null,name:null,title:null,label:null,role:'pbp',representedName:null},
 'sign-staff':{holderId:staff,name:'Fictional Staff',title:null,label:null,role:'employee',representedName:null},
};
const blocks:Block[]=[{id:'body',type:'text',text:'Dear Fictional Staff',section:'main'},
 ...(['sign-hr','sign-ops','sign-staff'] as const).map(step=>({id:'sig-'+step,type:'signature' as const,text:'',section:'',role:'step:'+step,label:step==='sign-staff'?'Employee acknowledgement':'People Business Partner'}))];
function letter(actions:SigningDocument['actions']=[]):ProbationLetterView{
 const signing:SigningDocument={tenantId:'tenant',companyId:'company',subjectId:'letter',subjectType:'probation',contentRevision:1,contentHash:'a'.repeat(64),route,actions,routing:{templateId:'confirm',templateVersion:2,caseOwnerId:reviewer,fallbackGroupId:'ops'}};
 const merge={'company.name':'Fictional Company'};
 return{routed:true,contentVisible:true,owner:{stepId:'review',userId:reviewer},canEditContent:false,unresolved:[],sourceMoved:false,runtimeEnabled:true,id:'letter',caseId:'case',outcomeId:'outcome',outcomeRevision:4,storageRevision:3,state:'pending_approval',createdAt:'',name:'Confirmation letter',templateId:'template',templateVersion:2,blocks,fields:[],merge,signing:{id:'signing',document:signing},route,canPrepare:false,canRelease:false,signers,
  document:probationLetterDocument({id:'letter',name:'Confirmation letter',templateId:'template',templateVersion:2,blocks,fields:[],merge,createdAt:'',signing,signers})};
}
const reviewed={id:'a1',stepId:'review',contentRevision:1,contentHash:'a'.repeat(64),actorId:reviewer,actorPersonId:'p1',actorName:'Fictional Reviewer',representedId:reviewer,role:'people',at:'2026-11-16T04:11:00.000Z',action:'reviewed' as const,comment:'',signature:null};

describe('letters name their signers (L3, L4)',()=>{
 it('prints the holder, else the routing or role, in an unsigned signature block and never "[Signatory]"',()=>{
  const document=letter().document;
  expect(v9SignaturePresentation(document,'step:sign-hr')).toMatchObject({name:'Fictional Delegate',detail:'Fictional HR Manager, Fictional Company',status:'Not signed yet'});
  // Nobody holds the step yet: the role it is routed to, not a placeholder.
  expect(v9SignaturePresentation(document,'step:sign-ops').name).toBe('People Business Partner');
  expect(v9SignaturePresentation(document,'step:sign-staff').name).toBe('Fictional Staff');
  // A document without signer values (another module) keeps today's placeholder.
  expect(v9SignaturePresentation({...document,mergeValues:{}},'step:sign-hr').name).toBe('[Signatory]');
  // Signed: the authenticated receipt, never the anticipated title.
  const signed=letter([reviewed,{...reviewed,id:'a2',stepId:'sign-hr',actorId:delegate,actorName:'Fictional Delegate',role:'routing:bp-routing',action:'signed',signature:{method:'typed',value:'Fictional Delegate',consent:true}}]).document;
  expect(v9SignaturePresentation(signed,'step:sign-hr')).toMatchObject({name:'Fictional Delegate',detail:'Fictional Company'});
  expect(v9SignaturePresentation(signed,'step:sign-hr').status).toMatch(/^Signed electronically/);
 });
 it('names who holds each pending step under Required signers, and the rendered letter shows the signers',()=>{
  render(<NextIntlClientProvider locale="en" messages={messages}><LetterView letter={letter([reviewed])} actor={{id:'viewer',name:'Fictional Viewer'}}/></NextIntlClientProvider>);
  const list=screen.getByRole('heading',{name:messages.probation.letters.signingHistory}).closest('section')!;
  const rows=within(list).getAllByRole('listitem').map(item=>item.textContent);
  expect(rows).toEqual([
   'Review · Fictional Reviewer · 16/11/2026 12:11',
   'Sign · Fictional Delegate on behalf of Fictional Partner · Awaiting signature',
   'Sign · '+messages.probation.letters.missingHolder,
   'Sign · Fictional Staff · Awaiting signature',
  ]);
  expect(screen.queryByText('[Signatory]')).not.toBeInTheDocument();
  // The rendered letter: each signature block's printed name (the <strong> under the line).
  const printed=Array.from(document.querySelectorAll('.v9-signature strong')).map(node=>node.textContent);
  expect(printed).toEqual(['Fictional Delegate','People Business Partner','Fictional Staff']);
 });
});
