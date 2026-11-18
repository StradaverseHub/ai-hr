import {fictionalV9Case} from '../fixtures/lifecycle-v9/case';
import {v9Defaults} from '../../lib/lifecycle-v9-defaults';
import type {Document,Mail,Module,Workflow} from '../../lib/lifecycle-v9-model';
export function communicationsFixture(module:Module='off'){
 const config=v9Defaults();config.workflows=[];config.emails=[];config.templates=[];config.groups=[{id:'people',name:'Fictional People Ops',members:['hr'],limit:10}];
 const c=fictionalV9Case({module,id:'communications-'+module,facts:{...fictionalV9Case().facts,name:'Fictional Jordan',joinDate:'2026-11-30',lastDay:'2026-11-30',employeeUserId:'employee'}});
 const template={id:'letter',name:'Fictional acceptance letter',module,type:'Letter' as const,rules:{},hrStep:'before' as const,employeeAck:true,retired:false,versions:[{version:1,state:'published' as const,at:'2026-10-01T00:00:00Z',by:'Fictional HR',blocks:[{id:'body',type:'text' as const,text:'Dear {fullName}',section:'main' as const}],fields:[]}],currentVersion:1};config.templates=[template];
 const email={id:'welcome',name:'Fictional welcome email',module,active:true,sender:'noreply',cc:['peopleOps' as const],subject:'A fictional welcome',body:'Welcome to the fictional case.',links:['letter'],attachments:[],slots:[{id:'support',label:'Supporting PDF',required:false}]};
 config.emails=[email,{...email,id:'unused',name:'Fictional unscheduled email',slots:[]}];
 const trigger={event:module==='onb'?'beforeJoin' as const:'beforeLWD' as const,days:3,workdays:false,repeat:false,skipIf:'' as const};
 const workflow:Workflow={id:'welcome-flow',name:'Fictional welcome workflow',module,status:'published',trigger,conditions:[],steps:[{id:'email-step',type:'email',template:'welcome',to:['supervisor'],cc:['peopleOps']}],description:'Fictional workflow'};
 const completed:Workflow={...workflow,id:'release-flow',name:'Fictional release workflow',trigger:{...trigger,days:0},steps:[{id:'release',type:'doc',template:'letter',release:true},{id:'receipt',type:'email',template:'welcome',to:['employee'],cc:[]}]};
 config.workflows=[workflow,completed];
 c.runs=[{id:'held-run',workflowId:workflow.id,revision:1,date:'2026-11-27',status:'waiting',cursor:0,reason:'Line manager has no work email.',at:'2026-11-27T02:00:00Z',definition:structuredClone(workflow),hold:{stepId:'email-step',at:'2026-11-27T02:00:00Z',missing:[{role:'supervisor',label:'Line manager',reason:'Line manager has no work email.'}]}},{id:'finished-run',workflowId:completed.id,revision:1,date:'2026-11-30',status:'done',cursor:2,reason:'',at:'2026-11-30T02:00:00Z',definition:structuredClone(completed)}];
 const document:Document={id:'saved-letter',templateId:'letter',version:1,name:template.name,status:'signed',blocks:template.versions[0].blocks,fields:[],values:{},edits:{},hrSignature:null,employeeSignature:null,createdAt:'2026-11-30T02:00:00Z',sentAt:'2026-11-30T02:00:00Z',hrStep:'before',employeeAck:true,templateType:'Letter'};
 c.documents=[document];c.files=[{id:'file',storageId:'file',slot:'welcome:support',name:'Fictional evidence.pdf'}];
 const mail:Mail={id:'receipt',key:'finished-run:receipt:employee',workflowId:completed.id,templateId:email.id,to:['employee'],cc:[],subject:'Fictional released letter',body:'The saved original message.',documentIds:[document.id],fileIds:['file'],status:'sent',test:false,at:'2026-11-30T02:00:00Z',deliveredAt:'2026-11-30T02:01:00Z',failure:null,delivery:{version:1,queuedBy:{id:'hr',name:'Fictional HR'},sender:'noreply',linkDocumentIds:[document.id],pdfDocumentIds:[],toNames:['Fictional Jordan'],ccNames:[]}};
 c.mails=[mail,{...mail,id:'test-mail',key:'test:sample',test:true,workflowId:null,documentIds:[],at:'2026-12-01T02:00:00Z',subject:'Fictional test only'}];
 c.pmChanges=[{id:'change',documentId:document.id,field:'mobile',before:'0111111111',after:'0222222222',status:'proposed',sourceRevision:'source-1'}];
 return{c,config,workflow,completed,document,mail};
}
