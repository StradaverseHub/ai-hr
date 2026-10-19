import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import {SaxesParser} from 'saxes';
import {buildMovementWorkbook,readMovementWorkbook} from '../lib/movement-workbook.server';
import {movementWorkbookLayout,movementWorkbookRequirements} from '../lib/movement-workbook-layout';
import {parseMovementTypeCsv,movementTypeCsvTemplate,movementInputRecord} from '../lib/movement-type-csv';
import type {MovementImportCatalog} from '../core/movement-import';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',department='33333333-3333-4333-8333-333333333333';
const catalog:MovementImportCatalog={types:[{code:'increment',label:'Increment',behaviour:'increment'},{code:'custom_increment',label:'Increment',behaviour:'increment'},{code:'resignation',label:'Resignation',behaviour:'resignation'}],companies:[{value:a,label:'Fictional A'}],fields:{departmentId:[{value:department,label:'Finance'}]}};
const resolve=(_key:string,fallback:string)=>fallback;
const subjects=Array.from({length:5},(_,i)=>({employeeCode:'EX-00'+i,name:'Fictional '+i,current:{departmentId:'Finance',gradeId:'G2',basicSalary:'3000.00',currency:'MYR'}}));
const make=()=>buildMovementWorkbook({tenantId:a,companyId:a,companyName:'Fictional A',catalog,subjects,typeCode:'increment',resolve});
const parse=(bytes:Buffer)=>readMovementWorkbook(bytes,{tenantId:a,companyId:a,catalog,resolve});
async function edit(bytes:Buffer,patch:(wb:XLSX.WorkBook)=>void){const wb=XLSX.read(bytes,{type:'buffer',cellFormula:true});patch(wb);return Buffer.from(XLSX.write(wb,{type:'buffer',bookType:'xlsx',compression:true}));}
beforeEach(()=>{vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY',Buffer.alloc(32,7).toString('base64url'));vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY_ID','public-fixture-only');});afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers();});
describe('authenticated per-type Movement workbook',()=>{
 it('uses one live layout for inherited types and keeps CSV single-type with no Event Type input',()=>{
  expect(movementWorkbookLayout(catalog.types[0],resolve).map(c=>c.key)).toEqual(movementWorkbookLayout(catalog.types[1],resolve).map(c=>c.key));
  const csv=movementTypeCsvTemplate(catalog.types[0],resolve);expect(csv).not.toMatch(/EventType|event_type/);expect(parseMovementTypeCsv('Employee ID,EventType\nEX-001,increment',catalog.types[0],resolve).fileErrors).toEqual(['wrong_type_columns']);
  expect(parseMovementTypeCsv('Employee ID,Increment Amount,EffectiveDate\nEX-001,"unclosed',catalog.types[0],resolve).fileErrors).toContain('malformed_csv');
 });
 it('opens protected grey/yellow/green scaffolding, hides references, keeps no raw UUID and skips two untouched employees',async()=>{
  const bytes=await make(),wb=XLSX.read(bytes,{type:'buffer',cellFormula:true}),zip=await JSZip.loadAsync(bytes);
  expect(wb.SheetNames).toEqual(['Instructions','Increment','Lists','_meta']);expect(wb.Workbook?.Sheets?.filter(s=>['Lists','_meta'].includes(s.name!)).every(s=>s.Hidden===1)).toBe(true);
  const xml=await zip.file('xl/worksheets/sheet2.xml')!.async('string');expect(xml).toContain('sheetProtection');expect(xml).toContain('state="frozen"');expect(xml).toContain('<f>');
  for(const entry of Object.values(zip.files).filter(f=>!f.dir&&f.name.endsWith('.xml')))expect(await entry.async('string')).not.toContain(a);
  const columns=movementWorkbookLayout(catalog.types[0],resolve),amount=columns.findIndex(c=>c.key==='incrementAmount'),date=columns.findIndex(c=>c.key==='effectiveDate');
  const edited=await edit(bytes,book=>{for(let r=5;r<8;r++){book.Sheets.Increment[XLSX.utils.encode_cell({r,c:amount})]={t:'n',v:100};book.Sheets.Increment[XLSX.utils.encode_cell({r,c:date})]={t:'s',v:'01-Nov-2026'};}});
  const parsed=await parse(edited);expect(parsed.fileErrors).toEqual([]);expect(parsed.records).toHaveLength(3);expect(parsed.records.every(r=>r.incrementAmount==='100'&&r.cells.kind==='increment')).toBe(true);expect(parsed.records.map(r=>r.source?.row)).toEqual([6,7,8]);
 });
 it('accepts an unused macro-enabled extension declaration while refusing a real part that uses it',async()=>{
  const zip=await JSZip.loadAsync(await make()),entry=zip.file('[Content_Types].xml')!;
  // The ordinary SheetJS package already contains an unused BIN default; another unused declaration is equally inert.
  zip.file('[Content_Types].xml',(await entry.async('string')).replace('</Types>','<Default Extension="aihr-unused" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/></Types>'));
  const harmless=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});await expect(parse(harmless)).resolves.toMatchObject({fileErrors:['no_data_rows'],records:[]});
  zip.file('xl/fictional-payload.aihr-unused',Buffer.from('fictional inert bytes'));await expect(parse(await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}))).rejects.toThrow();
 });
 it('binds physical headings across uploader locale and refuses swapping yellow captions or prefilled identity',async()=>{
  const bytes=await make();await expect(readMovementWorkbook(bytes,{tenantId:a,companyId:a,catalog,resolve:(_k,f)=>'Localized '+f})).resolves.toMatchObject({fileErrors:['no_data_rows']});
  const columns=movementWorkbookLayout(catalog.types[0],resolve),x=columns.findIndex(c=>c.key==='incrementAmount'),y=columns.findIndex(c=>c.key==='effectiveDate');
  await expect(parse(await edit(bytes,wb=>{const s=wb.Sheets.Increment,c=XLSX.utils.encode_cell({r:4,c:x}),d=XLSX.utils.encode_cell({r:4,c:y}),old=s[c];s[c]=s[d];s[d]=old;}))).rejects.toThrow('workbook_columns_changed');
  await expect(parse(await edit(bytes,wb=>{wb.Sheets.Increment.A6={t:'s',v:'OTHER'};}))).rejects.toThrow('workbook_identity_changed');
 });
 it('refuses modified metadata, wrong company, key rotation and formulas outside sanctioned green cells',async()=>{
  const bytes=await make();await expect(readMovementWorkbook(bytes,{tenantId:a,companyId:b,catalog,resolve})).rejects.toThrow('workbook_company_mismatch');
  const columns=movementWorkbookLayout(catalog.types[0],resolve),c=columns.findIndex(x=>x.key==='incrementAmount');
  await expect(parse(await edit(bytes,wb=>{wb.Sheets.Increment[XLSX.utils.encode_cell({r:5,c})]={t:'n',v:100,f:'1+99'};}))).rejects.toThrow('formula_input');
  await expect(parse(await edit(bytes,wb=>{wb.Sheets.Instructions.A1={t:'n',v:1,f:'1+1'};}))).rejects.toThrow('formula_input');
  await expect(parse(await edit(bytes,wb=>{wb.Sheets._meta.A1.v=String(wb.Sheets._meta.A1.v).replace('Fictional A','Tampered');}))).rejects.toThrow('workbook_metadata_invalid');
  vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY_ID','rotated-fixture');await expect(parse(bytes)).rejects.toThrow('workbook_metadata_invalid');
 });
 it('keeps all active custom tabs collision-safe and binds duplicate Excel row numbers to different normalized records',async()=>{
  const bytes=await buildMovementWorkbook({tenantId:a,companyId:a,companyName:'Fictional A',catalog,subjects:[],resolve}),wb=XLSX.read(bytes,{type:'buffer'});
  expect(wb.SheetNames).toEqual(['Instructions','Increment','Increment (2)','Resignation','Lists','_meta']);
  const changed=await edit(bytes,book=>{for(const name of ['Increment','Increment (2)']){const columns=movementWorkbookLayout(catalog.types[name==='Increment'?0:1],resolve);book.Sheets[name].A6={t:'s',v:'EX-001'};for(const [key,value]of [['incrementAmount','100'],['effectiveDate','2026-11-01']])book.Sheets[name][XLSX.utils.encode_cell({r:5,c:columns.findIndex(c=>c.key===key)})]={t:'s',v:value};}});
  const parsed=await parse(changed);expect(parsed.records).toHaveLength(2);expect(new Set(parsed.records.map(r=>r.row)).size).toBe(2);expect(parsed.records.map(r=>r.source?.row)).toEqual([6,6]);
 });
 it('does not use passwords, caches or altered grey/green values as authority',async()=>{
  const bytes=await make(),columns=movementWorkbookLayout(catalog.types[0],resolve),amount=columns.findIndex(c=>c.key==='incrementAmount'),date=columns.findIndex(c=>c.key==='effectiveDate'),grey=columns.findIndex(c=>c.key==='current.basicSalary');
  const changed=await edit(bytes,wb=>{const s=wb.Sheets.Increment;s[XLSX.utils.encode_cell({r:5,c:grey})]={t:'n',v:9999999};s[XLSX.utils.encode_cell({r:5,c:amount})]={t:'s',v:'10.13'};s[XLSX.utils.encode_cell({r:5,c:date})]={t:'s',v:'2026-11-01'};});
  const row=(await parse(changed)).records[0];expect(row.incrementAmount).toBe('10.13');expect(row.cells.basicSalary).toBeUndefined();
 });
 it('keeps explicit dd-mmm-yyyy on populated and empty date cells while retaining numeric zero and text/code styles',async()=>{
  const type={code:'confirmation',label:'Confirmation',behaviour:'confirmation'},columns=movementWorkbookLayout(type,resolve),address=(key:string,row=5)=>XLSX.utils.encode_cell({r:row,c:columns.findIndex(c=>c.key===key)});
  const bytes=await buildMovementWorkbook({tenantId:a,companyId:a,companyName:'Fictional A',catalog:{...catalog,types:[type]},subjects:[{...subjects[0],current:{...subjects[0].current,joinDate:'2026-01-06',probationEndDate:'2026-11-01',basicSalary:'0'}}],typeCode:type.code,resolve});
  const wb=XLSX.read(bytes,{type:'buffer',cellNF:true,cellFormula:true}),sheet=wb.Sheets.Confirmation,zip=await JSZip.loadAsync(bytes),styles=await zip.file('xl/styles.xml')!.async('string'),xml=await zip.file('xl/worksheets/sheet2.xml')!.async('string');
  const formats=new Map<string,string>(),xfs:Record<string,string>[]=[],cellStyles=new Map<string,number>();let inCellXfs=false,currentStyle:Record<string,string>|undefined;
  const styleParser=new SaxesParser({xmlns:true});styleParser.on('opentag',tag=>{
   const attrs=Object.fromEntries(Object.values(tag.attributes).map(a=>[a.local,a.value]));
   if(tag.local==='numFmt'){expect(formats.has(attrs.numFmtId)).toBe(false);formats.set(attrs.numFmtId,attrs.formatCode);}
   if(tag.local==='cellXfs')inCellXfs=true;
   if(tag.local==='xf'&&inCellXfs){currentStyle=attrs;xfs.push(attrs);}
   if(tag.local==='protection'&&currentStyle)Object.assign(currentStyle,attrs);
  });styleParser.on('closetag',tag=>{if(tag.local==='cellXfs')inCellXfs=false;if(tag.local==='xf')currentStyle=undefined;});styleParser.write(styles).close();
  const sheetParser=new SaxesParser({xmlns:true});sheetParser.on('opentag',tag=>{if(tag.local==='c'){const attrs=Object.fromEntries(Object.values(tag.attributes).map(a=>[a.local,a.value]));cellStyles.set(attrs.r,Number(attrs.s??0));}});sheetParser.write(xml).close();
  const style=(cell:string)=>{const id=cellStyles.get(cell);expect(id).toBeDefined();expect(xfs[id!]).toBeDefined();return xfs[id!];};
  // SheetJS may retain an unused format60 declaration. Inspect the final cell XF reference, not the first matching declaration.
  const dateFormatId=style(address('effectiveDate')).numFmtId;expect(Number(dateFormatId)).toBeGreaterThanOrEqual(164);expect(formats.get(dateFormatId)).toBe('dd-mmm-yyyy');
  for(const key of ['current.joinDate','current.probationEndDate','effectiveDate']){const cell=address(key);expect(sheet[cell].z).toBe('dd-mmm-yyyy');expect(style(cell)).toMatchObject({numFmtId:dateFormatId,applyNumberFormat:'1',locked:key==='effectiveDate'?'0':'1'});}
  expect(sheet[address('current.joinDate')].t).toBe('n');expect(sheet[address('current.joinDate')].v).toBe((Date.parse('2026-01-06T00:00:00Z')-Date.UTC(1899,11,30))/86400000);expect(sheet[address('effectiveDate')].v).toBe('');
  expect(sheet[address('effectiveDate',204)].z).toBe('dd-mmm-yyyy');expect(style(address('employeeCode')).numFmtId).toBe('49');expect(style(address('employeeName')).numFmtId).toBe('49');expect(style(address('current.basicSalary')).numFmtId).toBe('2');expect(sheet[address('current.basicSalary')].v).toBe('0');
 });
 it('leaves green salary and difference blank without a baseline while preserving a recorded zero baseline',async()=>{
  for(const [code,behaviour,formulaKey,inputKey]of [['increment','increment','calculated.basicSalary','incrementAmount'],['salaryAdjustment','salaryAdjustment','calculated.difference','basicSalary']]){
   const type={code,label:code,behaviour},columns=movementWorkbookLayout(type,resolve),cell=(key:string)=>XLSX.utils.encode_cell({r:5,c:columns.findIndex(c=>c.key===key)}),baseline=cell('current.basicSalary'),input=cell(inputKey);
   const expected=`IF(OR(${input}="",${baseline}=""),"",${formulaKey==='calculated.basicSalary'?baseline+'+'+input:input+'-'+baseline})`;
   for(const salary of [null,'0']){
    const bytes=await buildMovementWorkbook({tenantId:a,companyId:a,companyName:'Fictional A',catalog:{...catalog,types:[type]},subjects:[{...subjects[0],current:{...subjects[0].current,basicSalary:salary}}],typeCode:code,resolve});
    const wb=XLSX.read(bytes,{type:'buffer',cellFormula:true}),sheet=wb.Sheets[code];expect(sheet[cell(formulaKey)].f).toBe(expected);expect(sheet[baseline]?.v??'').toBe(salary??'');
    expect(sheet[cell(formulaKey)].c?.[0].t).toContain('Check and preview supplies the authoritative salary baseline');
    expect(XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Instructions,{header:1}).flat().join(' ')).toContain('A recorded zero remains a salary baseline.');
   }
  }
 });
 it('provides protected but usable rows6–205, locking only bound identities and skipping untouched scaffolding',async()=>{
  const bytes=await buildMovementWorkbook({tenantId:a,companyId:a,companyName:'Fictional A',catalog,subjects:subjects.slice(0,1),typeCode:'increment',resolve}),zip=await JSZip.loadAsync(bytes);
  const xml=await zip.file('xl/worksheets/sheet2.xml')!.async('string'),styles=await zip.file('xl/styles.xml')!.async('string'),xfs=/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)![1].match(/<xf\b[^>]*(?:\/>|>[\s\S]*?<\/xf>)/g)!;
  const locked=(address:string)=>{const cell=new RegExp('<c\\b[^>]*r="'+address+'"[^>]*>').exec(xml)?.[0],style=/\bs="(\d+)"/.exec(cell??'');expect(style).not.toBeNull();return /<protection[^>]*locked="1"/.test(xfs[Number(style![1])]);};
  const columns=movementWorkbookLayout(catalog.types[0],resolve),amount=columns.findIndex(c=>c.key==='incrementAmount');
  expect(locked('A6')).toBe(true);expect(locked('A7')).toBe(false);expect(locked('A205')).toBe(false);expect(locked(XLSX.utils.encode_col(amount)+'205')).toBe(false);expect(locked('B205')).toBe(true);
  expect((await parse(bytes)).records).toEqual([]);
  const entered=await edit(bytes,wb=>{for(const [key,value]of [['employeeCode',subjects[0].employeeCode],['incrementAmount','100'],['effectiveDate','2026-11-01']])wb.Sheets.Increment[XLSX.utils.encode_cell({r:204,c:columns.findIndex(c=>c.key===key)})]={t:'s',v:value};});
  expect((await parse(entered)).records).toMatchObject([{employeeCode:subjects[0].employeeCode,errors:[],source:{sheet:'Increment',row:205}}]);
 });
 it('explains the Blacklisted-or-Remarks requirement in actual localized workbook Instructions',async()=>{
  const type={code:'blacklist',label:'Blacklist',behaviour:'blacklist'},local=(_key:string,fallback:string)=>_key==='people.import.movement.issues.blacklist_input_required'?'Localized: choose status OR enter remarks':fallback;
  const guide=movementWorkbookRequirements(type,movementWorkbookLayout(type,local));expect(guide.required).toEqual(['Employee ID']);expect(guide.requiredEither).toHaveLength(2);
  const bytes=await buildMovementWorkbook({tenantId:a,companyId:a,companyName:'Fictional A',catalog:{...catalog,types:[type]},subjects:[],resolve:local});
  const wb=XLSX.read(bytes,{type:'buffer'}),rows=XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Instructions,{header:1}),row=rows.find(row=>row[0]==='Blacklist');
  expect(row?.[1]).toBe('Employee ID · Localized: choose status OR enter remarks');expect(row?.[2].split(' · ')).toEqual(guide.requiredEither);
 });
 it('keeps native dropdowns as suggestions while accepting a supported hand-entered code for server preview',async()=>{
  const typedCatalog={...catalog,fields:{...catalog.fields,gradeId:[{value:b,label:'G2 · Grade Two',aliases:['G2','Grade Two']}]}},bytes=await buildMovementWorkbook({tenantId:a,companyId:a,companyName:'Fictional A',catalog:typedCatalog,subjects,typeCode:'increment',resolve}),zip=await JSZip.loadAsync(bytes),xml=await zip.file('xl/worksheets/sheet2.xml')!.async('string');
  const validations=xml.match(/<dataValidation\b[^>]*>/g)??[];expect(validations.length).toBeGreaterThan(0);expect(validations.every(tag=>tag.includes('showErrorMessage="0"'))).toBe(true);
  const columns=movementWorkbookLayout(catalog.types[0],resolve),changed=await edit(bytes,wb=>{for(const [key,value]of [['incrementAmount','100'],['effectiveDate','2026-11-01'],['gradeId','G2']])wb.Sheets.Increment[XLSX.utils.encode_cell({r:5,c:columns.findIndex(c=>c.key===key)})]={t:'s',v:value};});
  expect((await readMovementWorkbook(changed,{tenantId:a,companyId:a,catalog:typedCatalog,resolve})).records[0]).toMatchObject({errors:[],cells:{gradeId:'G2'}});
 });
 it('retains ID-only blank Blacklist rows as incomplete, while explicit status or remarks preserve canonical intent',async()=>{
  const type={code:'blacklist',label:'Blacklist',behaviour:'blacklist'},blacklistCatalog={...catalog,types:[...catalog.types,type]},columns=movementWorkbookLayout(type,resolve);
  const bytes=await buildMovementWorkbook({tenantId:a,companyId:a,companyName:'Fictional A',catalog:blacklistCatalog,subjects:[],resolve});
  const idOnly=await edit(bytes,wb=>{wb.Sheets.Blacklist.A6={t:'s',v:'EX-001'};});
  const parsed=await readMovementWorkbook(idOnly,{tenantId:a,companyId:a,catalog:blacklistCatalog,resolve});
  expect(parsed.records).toHaveLength(1);expect(parsed.records[0]).toMatchObject({employeeCode:'EX-001',source:{sheet:'Blacklist',row:6},errors:['blacklist_input_required']});
  expect(parsed.records[0].cells.effectiveDate).toBeDefined();expect(parsed.records[0].cells.blacklisted).toBeUndefined();
  const greyOnly=await edit(idOnly,wb=>{wb.Sheets.Blacklist.B6={t:'s',v:'Fictional employee'};wb.Sheets.Blacklist[XLSX.utils.encode_cell({r:5,c:columns.findIndex(c=>c.key==='current.blacklistedAt')})]={t:'s',v:'2026-10-18'};});
  expect((await readMovementWorkbook(greyOnly,{tenantId:a,companyId:a,catalog:blacklistCatalog,resolve})).records[0].errors).toEqual(['blacklist_input_required']);
  for(const [field,value]of [['blacklisted','true'],['blacklisted','false'],['remarks','Deliberate fictional blacklist instruction']]){
   const entered=await edit(idOnly,wb=>{wb.Sheets.Blacklist[XLSX.utils.encode_cell({r:5,c:columns.findIndex(c=>c.key===field)})]={t:'s',v:value};});
   const result=await readMovementWorkbook(entered,{tenantId:a,companyId:a,catalog:blacklistCatalog,resolve});expect(result.records[0].errors).toEqual([]);expect(result.records[0].cells[field as 'blacklisted'|'remarks']).toBe(value);
  }
 });
 it('refuses ID-only single-type CSV/Paste Blacklist rows without requiring a status when remarks deliberately use its default',()=>{
  const type={code:'blacklist',label:'Blacklist',behaviour:'blacklist'};
  for(const csv of ['Employee ID\nEX-001','Employee ID,Blacklisted,Remarks\nEX-001, , ']){
   const parsed=parseMovementTypeCsv(csv,type,resolve);expect(parsed.fileErrors).toEqual([]);expect(parsed.records).toHaveLength(1);expect(parsed.records[0].errors).toEqual(['blacklist_input_required']);
  }
  for(const [field,value]of [['blacklisted','true'],['blacklisted','false'],['remarks','Deliberate fictional blacklist instruction']]){
   const parsed=parseMovementTypeCsv('employeeCode,'+field+'\nEX-001,'+value,type,resolve);expect(parsed.records[0].errors).toEqual([]);expect(parsed.records[0].cells[field as 'blacklisted'|'remarks']).toBe(value);
  }
 });
 it('normalizes every resolved blacklist behaviour to the fresh KL day ahead of future rows, including across midnight',()=>{
  const before=new Date();before.setUTCHours(15,59,59,0);vi.useFakeTimers();vi.setSystemTime(before);
  const type={code:'custom_blacklist_fixture',label:'Fictional custom blacklist',behaviour:'blacklist'},columns=movementWorkbookLayout(type,resolve),values=columns.map(c=>c.key==='employeeCode'?'EX-001':c.key==='blacklisted'?'true':'');
  const first=movementInputRecord(type,columns,values,1,{sheet:'Fictional custom blacklist',row:6});expect(first.cells.effectiveDate).toBeDefined();expect(columns.some(c=>c.key==='effectiveDate')).toBe(false);
  const future=new Date(before.getTime()+7*86400000).toISOString().slice(0,10);expect(first.cells.effectiveDate!<future).toBe(true);
  vi.setSystemTime(new Date(before.getTime()+2000));const second=movementInputRecord(type,columns,values,1,{sheet:'Fictional custom blacklist',row:6});expect(second.cells.effectiveDate).not.toBe(first.cells.effectiveDate);
  // Normalized input changes as well as the locked core's blacklist-day fingerprint: an old preview cannot be reused.
  expect(JSON.stringify(second)).not.toBe(JSON.stringify(first));
 });
});
