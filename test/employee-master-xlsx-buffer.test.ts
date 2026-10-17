/** Real SheetJS representation compatibility and serializer wiring; not a Linux memory receipt. */
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe,it,expect} from 'vitest';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import ts from 'typescript';

function workbook(){
 const book=XLSX.utils.book_new(),date=new Date('2024-01-02T00:00:00.000Z');
 const sheet=XLSX.utils.aoa_to_sheet([
  ['Employee ID','Name','Hire date','Amount','Confirmed'],
  ['000123','தமிழ் 中文 José',date,1200.5,true],
  ['000124','=HYPERLINK("https://example.invalid")',null,-12.375,false],
 ]);
 sheet.C2={t:'d',v:date,z:'dd/mm/yyyy'};sheet.D2={t:'n',v:1200.5,z:'0.000'};sheet.D3={t:'n',v:-12.375,z:'0.000'};
 sheet['!autofilter']={ref:'A1:E3'};sheet['!cols']=[{wch:14},{wch:40},{wch:16},{wch:20},{wch:12}];
 XLSX.utils.book_append_sheet(book,sheet,'Fictional people');
 book.Props={Title:'Fictional Unicode/date/number export',CreatedDate:date,ModifiedDate:date};
 return book;
}
describe('Employee Master native XLSX intermediate',()=>{
 it('produces byte-identical real ZIPs from native buffer and legacy array while retaining typed cells',async()=>{
  const native=XLSX.write(workbook(),{type:'buffer',bookType:'xlsx',cellDates:true}),legacy=XLSX.write(workbook(),{type:'array',bookType:'xlsx',cellDates:true});
  expect(Buffer.isBuffer(native)).toBe(true);expect(legacy).toBeInstanceOf(ArrayBuffer);expect(native).toEqual(Buffer.from(legacy));
  const zip=await JSZip.loadAsync(native),xml=await zip.file('xl/worksheets/sheet1.xml')!.async('string');expect(xml).toContain('<autoFilter ref="A1:E3"');
  const book=XLSX.read(native,{type:'buffer',cellDates:true,cellNF:true}),sheet=book.Sheets['Fictional people'];
  expect(sheet.A2).toMatchObject({t:'s',v:'000123'});expect(sheet.B2).toMatchObject({t:'s',v:'தமிழ் 中文 José'});
  expect(sheet.C2).toMatchObject({t:'d',v:new Date('2024-01-02T00:00:00.000Z'),z:'dd/mm/yyyy'});expect(sheet.D2).toMatchObject({t:'n',v:1200.5,z:'0.000'});expect(sheet.D3).toMatchObject({t:'n',v:-12.375,z:'0.000'});
  expect(sheet.B3).toMatchObject({t:'s',v:'=HYPERLINK("https://example.invalid")'});expect(sheet.B3.f).toBeUndefined();expect(sheet.E2).toMatchObject({t:'b',v:true});
 });
 it('feeds JSZip the actual serializer native SheetJS buffer, avoiding the legacy per-byte character array',()=>{
  const text=readFileSync(path.join(process.cwd(),'lib/employee-master-export.ts'),'utf8'),source=ts.createSourceFile('employee-master-export.ts',text,ts.ScriptTarget.Latest,true);
  const excel=source.statements.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text==='excel');expect(excel?.body).toBeTruthy();
  const calls:ts.CallExpression[]=[];function visit(node:ts.Node){if(ts.isCallExpression(node))calls.push(node);ts.forEachChild(node,visit);}visit(excel!.body!);
  const named=(call:ts.CallExpression,owner:string,name:string)=>ts.isPropertyAccessExpression(call.expression)&&ts.isIdentifier(call.expression.expression)&&call.expression.expression.text===owner&&call.expression.name.text===name;
  const writes=calls.filter(call=>named(call,'XLSX','write'));expect(writes).toHaveLength(1);
  const options=writes[0].arguments[1];expect(ts.isObjectLiteralExpression(options)).toBe(true);
  const type=(options as ts.ObjectLiteralExpression).properties.find((node):node is ts.PropertyAssignment=>ts.isPropertyAssignment(node)&&ts.isIdentifier(node.name)&&node.name.text==='type');
  expect(type&&ts.isStringLiteral(type.initializer)?type.initializer.text:null).toBe('buffer');
  expect(calls.some(call=>named(call,'JSZip','loadAsync')&&call.arguments[0]===writes[0])).toBe(true);
 });
});
