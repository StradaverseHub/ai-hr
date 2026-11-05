/** Shared grade and classification rules. No employee pay or effective grade is changed here. */
import { z } from 'zod';
export const ARCHITECTURE_GRADES = ['H', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23'] as const;
export type ArchitectureGrade = typeof ARCHITECTURE_GRADES[number];
export const FUTURE_TRACKS = ['H1','H2','H3','H4','T1','T2','T3','T4','S1','S2','S3','S4'] as const;
export function isFutureArchitectureGrade(raw:string):boolean{return (FUTURE_TRACKS as readonly string[]).includes(raw.trim().toUpperCase().replace(/^JG\s*/,''));}
export const FUTURE_CROSSWALK = {H3:'12',T3:'12',S3:'12',H4:'13',T4:'13',S4:'13'} as const;
export const gradeSchema = z.enum(ARCHITECTURE_GRADES);
export function architectureGrade(raw: string): ArchitectureGrade | null {
 const code=raw.trim().toUpperCase().replace(/^JG\s*/, '');
 return ARCHITECTURE_GRADES.includes(code as ArchitectureGrade)?code as ArchitectureGrade:null;
}
export const nodeKinds=['family','subfamily','specialisation','unit'] as const;
const short=z.string().trim().min(1).max(160),uuid=z.uuid();
export const catalogueNodeSchema=z.object({
 id:uuid,kind:z.enum(nodeKinds),code:z.string().trim().regex(/^[A-Z0-9][A-Z0-9._-]{0,59}$/),title:short,
 parentId:uuid.nullable(),minGrade:gradeSchema.nullable(),maxGrade:gradeSchema.nullable(),
 statutory:z.boolean(),sme:z.boolean(),description:z.string().trim().max(4000),
}).strict();
export type CatalogueNode=z.infer<typeof catalogueNodeSchema>;
export const ladderEntrySchema=z.object({gradeId:uuid,code:gradeSchema,name:short,complexity:z.string().trim().min(1).max(2000),authority:z.string().trim().min(1).max(2000),people:z.string().trim().min(1).max(2000),impact:z.string().trim().min(1).max(2000),qualifications:z.string().trim().min(1).max(2000)}).strict();
export type LadderEntry=z.infer<typeof ladderEntrySchema>;
export const architectureCatalogueSchema=z.object({nodes:z.array(catalogueNodeSchema).max(20000),ladder:z.array(ladderEntrySchema).max(13)}).strict();
export type ArchitectureCatalogue=z.infer<typeof architectureCatalogueSchema>;
export class ArchitectureError extends Error{constructor(public code:'invalid'|'forbidden'|'changed'|'independent'|'missing',message:string){super(message);this.name='ArchitectureError';}}
function invalid(message:string):never{throw new ArchitectureError('invalid',message);}
export function gradeInRange(grade:ArchitectureGrade,min:ArchitectureGrade,max:ArchitectureGrade):boolean {
 const n=ARCHITECTURE_GRADES.indexOf(grade);return n>=ARCHITECTURE_GRADES.indexOf(min)&&n<=ARCHITECTURE_GRADES.indexOf(max);
}
export function validateArchitectureCatalogue(raw:unknown):ArchitectureCatalogue {
 const value=architectureCatalogueSchema.parse(raw),byId=new Map(value.nodes.map(n=>[n.id,n]));
 if(byId.size!==value.nodes.length)invalid('Each catalogue record needs its own identity.');
 const codes=new Set<string>(),unitTitles=new Set<string>();
 for(const node of value.nodes){
  if(codes.has(node.code))invalid('Catalogue codes must be unique.');codes.add(node.code);
  const depth=nodeKinds.indexOf(node.kind),parent=node.parentId?byId.get(node.parentId):null;
  if(depth===0?node.parentId!==null:!parent||nodeKinds.indexOf(parent.kind)!==depth-1)invalid('Each catalogue level must belong to the preceding level.');
  if(node.kind==='unit'){
   if(!node.minGrade||!node.maxGrade||!gradeInRange(node.minGrade,node.minGrade,node.maxGrade))invalid('Choose an ordered active grade range for each job unit.');
   if(unitTitles.has(node.title))invalid('A standard job unit title belongs to one catalogue branch.');unitTitles.add(node.title);
   if(node.sme&&ARCHITECTURE_GRADES.indexOf(node.maxGrade)>ARCHITECTURE_GRADES.indexOf('19'))invalid('Group-wide SME job units cannot be graded above JG 19.');
  }else if(node.minGrade||node.maxGrade||node.statutory||node.sme)invalid('Grade ranges and role flags belong to job units.');
 }
 const ladderCodes=new Set(value.ladder.map(g=>g.code)),gradeIds=new Set(value.ladder.map(g=>g.gradeId));
 if(ladderCodes.size!==value.ladder.length||gradeIds.size!==value.ladder.length)invalid('Each active grade needs one ladder entry.');
 return value;
}
export function cataloguePath(nodes:readonly CatalogueNode[],unitId:string):CatalogueNode[]{
 const byId=new Map(nodes.map(n=>[n.id,n])),seen=new Set<string>(),path:CatalogueNode[]=[];let n=byId.get(unitId);
 while(n){if(seen.has(n.id))invalid('The catalogue contains a cycle.');seen.add(n.id);path.unshift(n);n=n.parentId?byId.get(n.parentId):undefined;}
 return path;
}
export const positionMappingSchema=z.object({positionId:uuid,companyId:uuid,businessUnitId:uuid.nullable(),reportsToPositionId:uuid.nullable(),jobUnitId:uuid,gradeId:uuid,grade:gradeSchema,status:z.enum(['filled','vacant','frozen'])}).strict();
export type PositionMapping=z.infer<typeof positionMappingSchema>;
export function validatePositionMappings(raw:unknown,nodes:readonly CatalogueNode[]):PositionMapping[]{
 const mappings=z.array(positionMappingSchema).max(20000).parse(raw),byId=new Map(mappings.map(m=>[m.companyId+':'+m.positionId,m])),units=new Map(nodes.filter(n=>n.kind==='unit').map(n=>[n.id,n]));
 if(byId.size!==mappings.length)invalid('A position can be mapped only once in a proposal.');
 for(const m of mappings){const unit=units.get(m.jobUnitId);if(!unit||!unit.minGrade||!unit.maxGrade)invalid('Choose an approved job unit.');
  if(!gradeInRange(m.grade,unit.minGrade!,unit.maxGrade!))invalid('Position grade must be within its job unit range.');
  const seen=new Set<string>([m.positionId]);let id=m.reportsToPositionId;
  while(id){if(seen.has(id))invalid('Reporting positions cannot form a cycle.');seen.add(id);id=byId.get(m.companyId+':'+id)?.reportsToPositionId??null;}
 }
 return mappings;
}
export type ArchitecturePosition={id:string;title:string;companyId:string;mapping:PositionMapping|null};
export type ArchitectureEmployee={id:string;companyId:string;positionId:string|null;grade:ArchitectureGrade|null};
export function employeeGradeMismatches(positions:readonly ArchitecturePosition[],employees:readonly ArchitectureEmployee[]){
 const byPosition=new Map(positions.map(p=>[p.companyId+':'+p.id,p]));
 return employees.flatMap(e=>{const p=e.positionId?byPosition.get(e.companyId+':'+e.positionId):null;return p?.mapping&&e.grade!==p.mapping.grade?[{employeeId:e.id,positionId:p.id,companyId:e.companyId}]:[];});
}
export const outlierTypes=['title_grade_spread','employee_grade','unit_grade','statutory_h','sme_grade','classification_gap','empty_branch','duplicate_unit_title','unused_unit','unmapped_position'] as const;
export type ArchitectureOutlier={fingerprint:string;type:typeof outlierTypes[number];companyIds:string[];recordIds:string[];migrationOnly:boolean};
/** Input must already be authorized. Names or grades outside the caller's scope never enter aggregates. */
export function scanArchitectureOutliers(nodes:readonly CatalogueNode[],positions:readonly ArchitecturePosition[],employees:readonly ArchitectureEmployee[]):ArchitectureOutlier[]{
 const result:ArchitectureOutlier[]=[],byNode=new Map(nodes.map(n=>[n.id,n]));
 const add=(type:ArchitectureOutlier['type'],ids:string[],companies:string[],migrationOnly=false)=>{const recordIds=[...new Set(ids)].sort();result.push({type,recordIds,companyIds:[...new Set(companies)].sort(),migrationOnly,fingerprint:type+':'+[...new Set(companies)].sort().join(',')+':'+recordIds.join(':')});};
 const titles=new Map<string,ArchitecturePosition[]>();
 for(const p of positions){const same=titles.get(p.title)??[];same.push(p);titles.set(p.title,same);const m=p.mapping,u=m?byNode.get(m.jobUnitId):null;
  if(!m){add('unmapped_position',[p.id],[p.companyId]);continue;}
  if(!u||u.kind!=='unit'){add('classification_gap',[p.id,m.jobUnitId],[p.companyId]);continue;}
  if(!u.minGrade||!u.maxGrade||!gradeInRange(m.grade,u.minGrade,u.maxGrade))add('unit_grade',[p.id,u.id],[p.companyId]);
  if(u.statutory&&m.grade==='H')add('statutory_h',[p.id,u.id],[p.companyId],true);
  if(u.sme&&ARCHITECTURE_GRADES.indexOf(m.grade)>ARCHITECTURE_GRADES.indexOf('19'))add('sme_grade',[p.id,u.id],[p.companyId]);
 }
 for(const group of titles.values())if(new Set(group.flatMap(p=>p.mapping?[p.mapping.grade]:[])).size>1)add('title_grade_spread',group.map(p=>p.id),group.map(p=>p.companyId));
 for(const mismatch of employeeGradeMismatches(positions,employees))add('employee_grade',[mismatch.employeeId,mismatch.positionId],[mismatch.companyId]);
 const unitTitles=new Map<string,CatalogueNode[]>();
 for(const n of nodes){const level=nodeKinds.indexOf(n.kind),parent=n.parentId?byNode.get(n.parentId):null;
  if(level>0&&(!parent||nodeKinds.indexOf(parent.kind)!==level-1))add('classification_gap',[n.id],[]);
  if(n.kind==='unit'){const same=unitTitles.get(n.title)??[];same.push(n);unitTitles.set(n.title,same);if(!positions.some(p=>p.mapping?.jobUnitId===n.id))add('unused_unit',[n.id],[]);}
  else if(!nodes.some(u=>u.kind==='unit'&&cataloguePath(nodes,u.id).some(a=>a.id===n.id)))add('empty_branch',[n.id],[]);
 }
 for(const group of unitTitles.values())if(group.length>1)add('duplicate_unit_title',group.map(n=>n.id),[]);
 return result.sort((a,b)=>a.fingerprint.localeCompare(b.fingerprint));
}
export function assertIndependentChecker(actorId:string,contributors:readonly string[]):void{if(contributors.includes(actorId))throw new ArchitectureError('independent','A different authorized person must confirm this change.');}
export const architectureSuggestionSchema=z.object({positionId:uuid,jobUnitId:uuid,grade:gradeSchema,confidence:z.enum(['high','medium','low']),reasons:z.array(z.string().trim().min(1).max(600)).min(1).max(3)}).strict();
export function validateArchitectureSuggestion(raw:unknown,nodes:readonly CatalogueNode[],allowedPositionIds:ReadonlySet<string>){
 const p=architectureSuggestionSchema.parse(raw),u=nodes.find(n=>n.id===p.jobUnitId&&n.kind==='unit');
 if(!allowedPositionIds.has(p.positionId)||!u||!u.minGrade||!u.maxGrade||!gradeInRange(p.grade,u.minGrade,u.maxGrade)||u.sme&&ARCHITECTURE_GRADES.indexOf(p.grade)>ARCHITECTURE_GRADES.indexOf('19'))invalid('Suggestion does not match an authorized position and approved active grade range.');
 return {...p,statutoryMigrationReview:!!u.statutory&&p.grade==='H',advisoryOnly:true as const};
}
/** Publishing the official ladder is monotonic. Later edits cannot reopen legacy grade assignment. */
export function assertLadderContinuity(previous:ArchitectureCatalogue,next:ArchitectureCatalogue):void{
 const official=previous.ladder.length===ARCHITECTURE_GRADES.length&&ARCHITECTURE_GRADES.every(code=>previous.ladder.some(g=>g.code===code));
 if(official&&(!ARCHITECTURE_GRADES.every(code=>next.ladder.some(g=>g.code===code&&g.gradeId===previous.ladder.find(p=>p.code===code)!.gradeId))||next.ladder.length!==ARCHITECTURE_GRADES.length))throw new ArchitectureError('invalid','The official ladder must retain all active grade identities. A separately reviewed grade migration is required to replace them.');
}
