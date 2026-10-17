import { expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { PERSONNEL_FIELDS } from '../lib/personnel-field-registry';
import { defaultMasterColumn, runEmployeeMasterProjection, type EmployeeMasterSpec, type MasterSubject } from '../lib/employee-master-report';
import { serializeEmployeeMaster } from '../lib/employee-master-export';
import { todayInKualaLumpur } from '../lib/hr-date';
const find = (owner: string, name: string) => PERSONNEL_FIELDS.find(field => field.owner === owner && field.ownerField === name)!;
const code=find('employment','employeeCode'),name=find('person','fullName'),amount=find('compensation','incrementAmount'),adjustment=find('leaveBalance','adjustments');
const fields=[code,name,amount,adjustment],today=todayInKualaLumpur(),company='00000000-0000-4000-8000-000000000001';
function fixture(raw: string, decimals: number, format: 'auto'|'number'|'text' = 'auto') {
 const spec: EmployeeMasterSpec={v:2,asAt:today,companyIds:[company],includeDrafts:false,columns:[defaultMasterColumn(code),defaultMasterColumn(name),{...defaultMasterColumn(amount),format,decimals,sum:true}],expression:{id:'root',type:'group',logic:'and',children:[]},sorts:[{field:amount.id,dir:'asc'}],groups:[code.id],pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false}};
 const subjects: MasterSubject[]=[{id:'fictional-employment',personId:'fictional-person',companyId:company,kind:'employment',owners:{employment:[{id:'employment',values:{employeeCode:{value:'000007'}}}],person:[{id:'person',values:{fullName:{value:'-12.5'}}}],compensation:[{id:'recorded-increment',currency:'MYR',values:{incrementAmount:{value:raw,currency:'MYR'}}}],leaveBalance:[{id:'adjustment',values:{adjustments:{value:'0.0004',unit:'days'}}}]}}];
 return {spec,subjects,run:runEmployeeMasterProjection(spec,fields,subjects,today)};
}
async function asciiDrawing(bytes: Uint8Array) {
 const pdf=await PDFDocument.load(bytes);
 return pdf.context.enumerateIndirectObjects().flatMap(([,object])=>object instanceof PDFRawStream?[Buffer.from(decodePDFRawStream(object).decode()).toString('latin1')]:[]).join('\n').toUpperCase();
}
it.each([
 ['4321.25',3,'4321.250'],['1.005',2,'1.01'],['-12.5',3,'-12.500'],['0',3,'0.000'],['12.5',0,'13'],['12.345678',6,'12.345678'],
] as const)('presents %s at %i decimals as %s in data, subtotal and grand total without rounding stored values',async(raw,decimals,expected)=>{
 const {spec,run}=fixture(raw,decimals),before=JSON.stringify(run);
 const csv=Buffer.from((await serializeEmployeeMaster(run,spec,fields,'Recorded numeric presentation','csv')).bytes).toString('utf8');
 expect(csv.split('"'+expected+'"')).toHaveLength(4); // Three numeric cells: value + subtotal + grand total.
 expect(csv).toContain('"\'-12.5"'); expect(csv).toContain('"000007"');
 if(raw.startsWith('-'))expect(csv).not.toContain('"\''+expected+'"');
 const book=XLSX.read((await serializeEmployeeMaster(run,spec,fields,'Recorded numeric presentation','xlsx')).bytes,{type:'array',cellNF:true}),sheet=book.Sheets[book.SheetNames[0]],mask=decimals?'0.'+'0'.repeat(decimals):'0';
 for(const address of ['C5','C7','C9'])expect(sheet[address]).toMatchObject({t:'n',v:Number(raw),z:mask});
 expect(sheet.B5).toMatchObject({t:'s',v:'-12.5'});expect(sheet.B5.f).toBeUndefined();
 const drawing=await asciiDrawing((await serializeEmployeeMaster(run,spec,fields,'Recorded numeric presentation','pdf')).bytes);
 expect(drawing).toContain('<'+Buffer.from(expected).toString('hex').toUpperCase()+'> TJ');
 expect(drawing).toContain(Buffer.from('MYR '+expected).toString('hex').toUpperCase());
 expect(JSON.stringify(run)).toBe(before);expect(run.employeeCount).toBe(1);expect(run.sections[0].groups).toHaveLength(1);
});
it.each(['4321.25','0'])('honours explicit Text for %s instead of applying decimal padding',async raw=>{
 const {spec,run}=fixture(raw,3,'text'),before=JSON.stringify(run),csv=Buffer.from((await serializeEmployeeMaster(run,spec,fields,'Explicit Text','csv')).bytes).toString('utf8');
 expect(csv).toContain('"'+raw+'"');
 const book=XLSX.read((await serializeEmployeeMaster(run,spec,fields,'Explicit Text','xlsx')).bytes,{type:'array'}),sheet=book.Sheets[book.SheetNames[0]];
 expect(sheet.C5).toMatchObject({t:'s',v:raw});expect(sheet.C7).toMatchObject({t:'s',v:run.sections[0].totals[0].value});expect(sheet.C9).toMatchObject({t:'s',v:run.sections[0].totals[0].value});
 expect(await asciiDrawing((await serializeEmployeeMaster(run,spec,fields,'Explicit Text','pdf')).bytes)).toContain('<'+Buffer.from(raw).toString('hex').toUpperCase()+'> TJ');
 expect(JSON.stringify(run)).toBe(before);
});
it('retains exact numeric group identities instead of rounding keys using a measure display',async()=>{
 const {spec,subjects}=fixture('12.5',3);spec.groups=[adjustment.id];
 const second:MasterSubject={...subjects[0],id:'second-employment',personId:'second-person',owners:{...subjects[0].owners,employment:[{id:'second-employment',values:{employeeCode:{value:'000008'}}}],compensation:[{id:'second-increment',currency:'MYR',values:{incrementAmount:{value:'12.5',currency:'MYR'}}}],leaveBalance:[{id:'second-adjustment',values:{adjustments:{value:'0.00049',unit:'days'}}}]}};
 const run=runEmployeeMasterProjection(spec,fields,[subjects[0],second],today),before=JSON.stringify(run),csv=Buffer.from((await serializeEmployeeMaster(run,spec,fields,'Distinct group facts','csv')).bytes).toString('utf8');
 expect(csv).toContain('0.0004 · 1 employments');expect(csv).toContain('0.00049 · 1 employments');expect(run.sections[0].groups).toHaveLength(2);expect(JSON.stringify(run)).toBe(before);
});
it('formats the canonical total instead of recomputing it from rounded row displays',async()=>{
 const {spec,subjects}=fixture('1.005',2);
 const second:MasterSubject={...subjects[0],id:'second-employment',personId:'second-person',owners:{...subjects[0].owners,employment:[{id:'second-employment',values:{employeeCode:{value:'000008'}}}],compensation:[{id:'second-increment',currency:'MYR',values:{incrementAmount:{value:'1.005',currency:'MYR'}}}]}};
 const run=runEmployeeMasterProjection(spec,fields,[subjects[0],second],today),before=JSON.stringify(run);
 expect(run.sections[0].totals[0].value).toBe('2.010000');
 const csv=Buffer.from((await serializeEmployeeMaster(run,spec,fields,'Owner total precision','csv')).bytes).toString('utf8');
 expect(csv).toContain('"1.01"');expect(csv).toContain('"2.01"');expect(csv).not.toContain('"2.02"');expect(JSON.stringify(run)).toBe(before);
});
