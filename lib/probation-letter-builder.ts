import type {Block, Field} from './lifecycle-v9-model';
import type {ProbationTemplate} from './probation-workflow';
import {PROBATION_LETTER_KEYS} from './probation-letter-template';
import {probationOrganisationMapping} from './probation-organisation';

export type ProbationLetterMergeGroup={label:string;fields:{key:string;label:string;type?:'date'}[]};
/** These keys already use the document builder's single-brace format. No token rewrite is necessary. */
export const probationLetterMergeGroups:ProbationLetterMergeGroup[]=[
 {label:'Employee and organisation',fields:[['employeeName','Full name'],['employeeCode','Employee ID'],['companyName','Company'],['employeeJobTitle','Position'],['employeeGrade','Grade at case start'],['businessGroup','Business group'],['businessUnit','Business Unit'],['division','Division'],['department','Department']].map(([key,label])=>({key,label}))},
 {label:'Probation',fields:[['outcome','Outcome'],['startOn','Probation start'],['endOn','Probation end'],['originalEndOn','Original end date'],['extensionMonths','Extension months'],['extensionCount','Extension number'],['maxExtensions','Maximum extensions'],['extensionNewEndOn','New end date after extension'],['confirmationEffectiveOn','Confirmation effective date'],['reviewPlanMonths','Review plan months']].map(([key,label])=>({key,label,...(['startOn','endOn','originalEndOn','extensionNewEndOn','confirmationEffectiveOn'].includes(key)?{type:'date' as const}:{})}))},
 {label:'People and signatures',fields:[['lineManagerName','Line manager'],['hodName','Head of Department'],['pbpName','People Business Partner'],['signatoryName','Signatory name'],['signatoryTitle','Signatory title'],['acknowledgedBy','Acknowledged by'],['acknowledgedOn','Acknowledged on']].map(([key,label])=>({key,label}))},
 {label:'Company letterhead',fields:[['company.name','Company name'],['company.regNo','Registration number'],['company.address','Company address'],['company.color','Company colour']].map(([key,label])=>({key,label}))},
];
/** Labelled fictional data is independent of case intake, current Personnel data and live signatures. */
export const probationLetterSampleValues:Readonly<Record<typeof PROBATION_LETTER_KEYS[number],string>>={
 employeeName:'Alex Tan (sample)',employeeCode:'SAMPLE-001',companyName:'Sample Company Sdn Bhd',startOn:'2026-01-01',endOn:'2026-06-30',outcome:'Confirm',extensionMonths:'3',employeeJobTitle:'Sample coordinator',employeeGrade:'JG17',businessGroup:'SAMPLE-BU',businessUnit:'SAMPLE-BU',division:'Sample division',department:'Sample department',lineManagerName:'Lee Sample',hodName:'Morgan Sample',pbpName:'Jordan Sample',originalEndOn:'2026-06-30',reviewPlanMonths:'6',confirmationEffectiveOn:'2026-07-01',extensionNewEndOn:'2026-09-30',extensionCount:'1',maxExtensions:'2',signatoryName:'Jordan Sample',signatoryTitle:'People Business Partner',acknowledgedBy:'Alex Tan (sample)',acknowledgedOn:'2026-07-01','company.name':'Sample Company Sdn Bhd','company.regNo':'SAMPLE-REG','company.address':'Sample address — fictional preview','company.color':'#b54716',
};
export type LetterMappingDimension='businessGroup'|'businessUnit'|'company'|'department'|'grade';
export type LetterMappingCatalogue=Partial<Record<LetterMappingDimension,readonly {id:string;code?:string|null;name:string;archived?:boolean}[]>>;
export type LetterMappingRow={dimension:LetterMappingDimension;value:string;source:string;status:'sameIdentity'|'reviewRequired'|'archived';proposedId:string|null;proposedCode:string|null};
export type LetterConversionReport={templateId:string;version:number;mapping:ReturnType<typeof probationOrganisationMapping>;matching:LetterMappingRow[];fields:{key:string;supported:boolean}[];signing:{stepId:string;role:string;source:string;requiresReview:boolean}[];complete:boolean};
/** Inventory every saved value. Identity matches are the only automatic proposals; names never establish identity. */
export function probationLetterConversionReport(template:ProbationTemplate,version:number,catalogue:LetterMappingCatalogue):LetterConversionReport{
 const mapping=probationOrganisationMapping(template);
 const matching:LetterMappingRow[]=[];
 for(const dimension of ['businessGroup','businessUnit','company','department','grade'] as const){
  for(const value of template.rules[dimension]??[]){
   const candidates=(catalogue[dimension]??[]).filter(row=>row.id===value);
   // Legacy Business group is a parent-company UUID, not a Personnel Business Unit UUID.
   const sameOwner=!(mapping==='legacy-v1'&&(dimension==='businessGroup'||dimension==='businessUnit'));
   const candidate=sameOwner&&candidates.length===1?candidates[0]:null;
   matching.push({dimension,value,source:mapping==='legacy-v1'&&dimension==='businessGroup'?'Legacy parent company':mapping==='legacy-v1'&&dimension==='businessUnit'?'Legacy Business Unit':'Saved '+dimension,status:candidate?.archived?'archived':candidate?'sameIdentity':'reviewRequired',proposedId:candidate?.id??null,proposedCode:candidate?.code??null});
  }
 }
 const known=new Set<string>([...PROBATION_LETTER_KEYS,...template.fields.map(field=>field.id)]);
 const tokens=new Set<string>();
 for(const block of template.blocks)for(const text of [block.text,block.rows??'',block.label??''])for(const match of text.matchAll(/\{([^{}]+)\}/g))tokens.add(match[1]);
 for(const field of template.fields)if(field.pmKey)tokens.add(field.pmKey);
 const fields=[...tokens].map(key=>({key,supported:known.has(key)}));
 const routing=(template as ProbationTemplate&{routing?:{id:string;who:{kind:string;routingId?:string;groupId?:string}}[]}).routing;
 const signing=routing?.length?routing.map(step=>({stepId:step.id,role:step.who.kind,source:step.who.kind==='routing'?'Shared routing '+step.who.routingId:step.who.kind==='group'?'Shared assignment group '+step.who.groupId:step.who.kind,requiresReview:['routing','group','people'].includes(step.who.kind)})):template.route.steps.map(step=>({stepId:step.id,role:step.role,source:step.role==='employee'?'Probation employee':step.role==='lm'?'Personnel Direct superior':step.role==='hod'?'Probation Head of Department holder':step.role==='pbp'?'Probation People Business Partner holder':'Probation role '+step.role,requiresReview:step.role!=='employee'&&step.role!=='lm'}));
 return{templateId:template.id,version,mapping,matching,fields,signing,complete:matching.every(row=>row.status==='sameIdentity')&&fields.every(row=>row.supported)&&signing.every(row=>!row.requiresReview)};
}
/** Presentation adapter only. Original definitions, versions, routes and generated documents are untouched. */
export function probationLetterBuilderContent(template:Pick<ProbationTemplate,'blocks'|'fields'>):{blocks:Block[];fields:Field[]}{
 return{blocks:structuredClone(template.blocks),fields:structuredClone(template.fields)};
}
