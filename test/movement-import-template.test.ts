import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import {SaxesParser} from 'saxes';
import {buildMovementWorkbook,readMovementWorkbook} from '../lib/movement-workbook.server';
import {movementWorkbookLayout,movementWorkbookRequirements} from '../lib/movement-workbook-layout';
import {parseMovementTypeCsv,movementTypeCsvTemplate,movementInputRecord} from '../lib/movement-type-csv';
import {personnelImportLabelResolvers} from '../lib/personnel-import-labels.server';
import type {MovementImportCatalog} from '../core/movement-import';
import type {MovementImportRecord,MovementImportEmployee} from '../lib/movement-import-contract';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',department='33333333-3333-4333-8333-333333333333';
const catalog:MovementImportCatalog={types:[{code:'increment',label:'Increment',behaviour:'increment'},{code:'custom_increment',label:'Increment',behaviour:'increment'},{code:'resignation',label:'Resignation',behaviour:'resignation'}],companies:[{value:a,label:'Fictional A'}],fields:{departmentId:[{value:department,codes:['FIN'],label:'Finance'}]}};
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
 it('opens protected grey/yellow/green scaffolding, shows Reference and hides list mechanics, keeps no raw UUID and skips two untouched employees',async()=>{
  const bytes=await make(),wb=XLSX.read(bytes,{type:'buffer',cellFormula:true}),zip=await JSZip.loadAsync(bytes);
  expect(wb.SheetNames).toEqual(['Instructions','Increment','Reference','Lists','_meta']);expect(wb.Workbook?.Sheets?.find(s=>s.name==='Reference')?.Hidden??0).toBe(0);expect(wb.Workbook?.Sheets?.filter(s=>['Lists','_meta'].includes(s.name!)).every(s=>s.Hidden===1)).toBe(true);
  const xml=await zip.file('xl/worksheets/sheet2.xml')!.async('string');expect(xml).toContain('sheetProtection');expect(xml).toContain('state="frozen"');expect(xml).toContain('<f>');
  for(const entry of Object.values(zip.files).filter(f=>!f.dir&&f.name.endsWith('.xml')))expect(await entry.async('string')).not.toContain(a);
  const columns=movementWorkbookLayout(catalog.types[0],resolve),amount=columns.findIndex(c=>c.key==='incrementAmount'),date=columns.findIndex(c=>c.key==='effectiveDate');
  const edited=await edit(bytes,book=>{for(let r=5;r<8;r++){book.Sheets.Increment[XLSX.utils.encode_cell({r,c:amount})]={t:'n',v:100};book.Sheets.Increment[XLSX.utils.encode_cell({r,c:date})]={t:'s',v:'01-Nov-2026'};}});
  const parsed=await parse(edited);expect(parsed.fileErrors).toEqual([]);expect(parsed.records).toHaveLength(3);expect(parsed.records.every(r=>r.incrementAmount==='100'&&r.cells.kind==='increment')).toBe(true);expect(parsed.records.map(r=>r.source?.row)).toEqual([6,7,8]);
 });
 it('round-trips the explicit resignation lifecycle dates including Excel numeric dates',async()=>{
  const bytes=await buildMovementWorkbook({tenantId:a,companyId:a,companyName:'Fictional A',catalog,subjects,typeCode:'resignation',resolve});
  const columns=movementWorkbookLayout(catalog.types.find(type=>type.code==='resignation')!,resolve);
  const edited=await edit(bytes,book=>{
   const sheet=book.Sheets.Resignation;
   for(const [key,value]of Object.entries({tenderResignationDate:(Date.UTC(2026,9,1)-Date.UTC(1899,11,30))/86400000,resignationEffectiveDate:'15-Oct-2026',endDate:'20-Oct-2026',effectiveDate:'01-Nov-2026'}))sheet[XLSX.utils.encode_cell({r:5,c:columns.findIndex(column=>column.key===key)})]=typeof value==='number'?{t:'n',v:value}:{t:'s',v:value};
  });
  const parsed=await parse(edited);expect(parsed.fileErrors).toEqual([]);expect(parsed.records).toHaveLength(1);expect(parsed.records[0].cells).toMatchObject({kind:'resignation',tenderResignationDate:'2026-10-01',resignationEffectiveDate:'15-Oct-2026',endDate:'20-Oct-2026',effectiveDate:'01-Nov-2026'});
 });
 it('serializes formula notes as initially hidden VML shapes while retaining note text and sheet protection',async()=>{
  const bytes=await make(),zip=await JSZip.loadAsync(bytes),wb=XLSX.read(bytes,{type:'buffer',cellFormula:true});
  const drawings=Object.values(zip.files).filter(entry=>/^xl\/drawings\/.*\.vml$/.test(entry.name)),comments=Object.values(zip.files).filter(entry=>/^xl\/comments\d+\.xml$/.test(entry.name));expect(drawings).toHaveLength(1);expect(comments).toHaveLength(1);
  const vml=await drawings[0].async('string'),commentXml=await comments[0].async('string'),shapes=[...vml.matchAll(/<v:shape\b[^>]*\bstyle="([^"]*)"[^>]*>/g)];
  expect(shapes).toHaveLength(400);expect(shapes.every(shape=>/(?:^|;)\s*visibility:hidden(?:;|$)/.test(shape[1]))).toBe(true);expect(vml).not.toMatch(/<x:Visible\b/);expect(commentXml.match(/<comment\b/g)).toHaveLength(400);expect(commentXml).toContain('<author>AIHR</author>');
  const columns=movementWorkbookLayout(catalog.types[0],resolve),column=columns.findIndex(c=>c.key==='calculated.basicSalary');
  for(const row of [5,204]){const cell=wb.Sheets.Increment[XLSX.utils.encode_cell({r:row,c:column})];expect(cell.f).toBeTruthy();expect(cell.c?.[0].t).toContain('Display only. The server recalculates from authoritative records');expect(cell.c?.[0].t).toContain('Check and preview supplies the authoritative salary baseline');}
  const sheetXml=await zip.file('xl/worksheets/sheet2.xml')!.async('string');expect(sheetXml).toContain('<sheetProtection sheet="1"');expect(sheetXml).not.toMatch(/<sheetProtection[^>]*(?:password|hashValue)=/);
 });
 it('serializes localized deduplicated business reasons in a readable protected Errors column without changing source tab/row/input bindings',async()=>{
  const original=await buildMovementWorkbook({tenantId:a,companyId:a,companyName:'Fictional A',catalog,subjects:[],resolve}),bindings=(await parse(original)).metadata.sheets;
  const records:MovementImportRecord[]=[{row:1,employeeCode:'EX-001',cells:{kind:'increment',effectiveDate:'2026-11-01'},incrementAmount:'25.13',errors:[],importVersion:2,source:{sheet:'Increment',row:6}},{row:2,employeeCode:'EX-002',cells:{kind:'custom_increment',effectiveDate:'2026-11-01'},incrementAmount:'10.00',errors:[],importVersion:2,source:{sheet:'Increment (2)',row:6}}];
  const employees:MovementImportEmployee[]=records.map(record=>({employeeCode:record.employeeCode,employmentId:null,name:null,fingerprint:null,rows:[{row:record.row,employeeCode:record.employeeCode,eventType:record.cells.kind!,effectiveDate:record.cells.effectiveDate!,status:'excluded',source:record.source,errors:record.row===1?['unknown_reference:departmentId; unknown_reference:departmentId','required:remarks']:[]}]}));
  const local=(key:string,fallback:string)=>key==='people.import.movement.issues.unknown_reference'?'Localized reference needed':key==='people.import.movement.issues.required'?'Localized required entry':key==='people.import.movement.errors'?'Localized Errors':fallback;
  const bytes=await buildMovementWorkbook({tenantId:a,companyId:a,companyName:'Fictional A',catalog,subjects:[],sourceBindings:bindings,records,employees,resolve:local}),wb=XLSX.read(bytes,{type:'buffer',cellNF:true,cellStyles:true,cellFormula:true}),columns=movementWorkbookLayout(catalog.types[0],resolve),errorAddress=XLSX.utils.encode_cell({r:5,c:columns.length});
  expect(wb.SheetNames).toEqual(XLSX.read(original,{type:'buffer'}).SheetNames);expect(wb.Sheets.Increment[errorAddress].v).toBe('Localized reference needed · Department; Localized required entry · Remarks');expect(wb.Sheets.Increment[errorAddress].v).not.toContain('unknown_reference');expect(wb.Sheets['Increment (2)'][errorAddress]?.v??'').toBe('');
  expect(wb.Sheets.Increment['!cols']?.[columns.length].wch).toBeGreaterThanOrEqual(60);expect(wb.Sheets.Increment['!rows']?.[5].hpt).toBeGreaterThanOrEqual(30);
  const zip=await JSZip.loadAsync(bytes),sheetXml=await zip.file('xl/worksheets/sheet2.xml')!.async('string'),styles=await zip.file('xl/styles.xml')!.async('string'),entry=new RegExp('<c\\b[^>]*r="'+errorAddress+'"[^>]*>').exec(sheetXml)![0],styleIndex=Number(/\bs="(\d+)"/.exec(entry)![1]),xfs=/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)![1].match(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g)!;
  expect(xfs[styleIndex]).toMatch(/<alignment[^>]*vertical="top"[^>]*wrapText="1"/);expect(xfs[styleIndex]).toContain('locked="1"');expect(sheetXml).toContain('<sheetProtection sheet="1"');
  const reread=await readMovementWorkbook(bytes,{tenantId:a,companyId:a,catalog,resolve:local});expect(reread.records.map(record=>({employeeCode:record.employeeCode,incrementAmount:record.incrementAmount,kind:record.cells.kind,source:record.source}))).toEqual(records.map(record=>({employeeCode:record.employeeCode,incrementAmount:record.incrementAmount,kind:record.cells.kind,source:record.source})));expect(reread.metadata.sheets.map(s=>({sheet:s.sheet,columns:s.columns,captions:s.captions}))).toEqual(bindings.map(s=>({sheet:s.sheet,columns:s.columns,captions:s.captions})));
 });
 it('accepts an unused macro-enabled extension declaration while refusing a real part that uses it',async()=>{
  const zip=await JSZip.loadAsync(await make()),entry=zip.file('[Content_Types].xml')!;
  // The ordinary SheetJS package already contains an unused BIN default; another unused declaration is equally inert.
  zip.file('[Content_Types].xml',(await entry.async('string')).replace('</Types>','<Default Extension="aihr-unused" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/></Types>'));
  const harmless=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});await expect(parse(harmless)).resolves.toMatchObject({fileErrors:['no_data_rows'],records:[]});
  zip.file('xl/fictional-payload.aihr-unused',Buffer.from('fictional inert bytes'));await expect(parse(await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}))).rejects.toThrow();
 });
 it.each(["'Lists'",'Lists'])('admits the exact native Excel-compatible %s absolute named-list form without changing inputs',async sheetName=>{
  const columns=movementWorkbookLayout(catalog.types[0],resolve),entered=await edit(await make(),wb=>{for(const [key,value]of [['incrementAmount','25.13'],['effectiveDate','2026-10-18']])wb.Sheets.Increment[XLSX.utils.encode_cell({r:5,c:columns.findIndex(c=>c.key===key)})]={t:'s',v:value};});
  const zip=await JSZip.loadAsync(entered),entry=zip.file('xl/workbook.xml')!,original=await entry.async('string');let names=0;
  zip.file('xl/workbook.xml',original.replace(/(<definedName\b[^>]*>)([\s\S]*?)(<\/definedName>)/g,(_all,open,ref,close)=>{names++;expect(ref).toMatch(/^(?:&apos;Lists&apos;|'Lists'|Lists)!/);return open+ref.replace(/^(?:&apos;Lists&apos;|'Lists'|Lists)!/,sheetName+'!')+close;}));expect(names).toBeGreaterThan(0);
  const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),parsed=await parse(bytes);expect(parsed.fileErrors).toEqual([]);expect(parsed.records).toHaveLength(1);expect(parsed.records[0]).toMatchObject({employeeCode:subjects[0].employeeCode,incrementAmount:'25.13',cells:{effectiveDate:'2026-10-18'},errors:[]});
 });
 it.each(['Other!$A$2:$A$4',"'Other'!$A$2:$A$4",'[other.xlsx]Lists!$A$2:$A$4','Lists!A2:A4','Lists!$A$2:A$4','Lists!$A$1:$A$4','Lists!$A$2:$A$100000','Lists!$A$2:$A$0','SUM(Lists!$A$2:$A$4)','Lists!$A$2:$A$4,Lists!$B$2:$B$4',"'Lists'!$A$2:$A$4+1","'Lists!$A$2:$A$4",'Lists !$A$2:$A$4'])('refuses nonliteral, foreign, relative or malformed named-list reference %s',async ref=>{
  const zip=await JSZip.loadAsync(await make()),entry=zip.file('xl/workbook.xml')!;let changed=false;
  zip.file('xl/workbook.xml',(await entry.async('string')).replace(/(<definedName\b[^>]*>)([\s\S]*?)(<\/definedName>)/,(_all,open,_old,close)=>{changed=true;return open+ref+close;}));expect(changed).toBe(true);
  await expect(parse(await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}))).rejects.toThrow('workbook_structure_invalid');
 });
 it('keeps the generated defined-name whitelist when accepting unquoted Lists references',async()=>{
  const zip=await JSZip.loadAsync(await make()),entry=zip.file('xl/workbook.xml')!;
  zip.file('xl/workbook.xml',(await entry.async('string')).replace(/(<definedName\b[^>]*name=")AIHR_Movement_List_\d+("[^>]*>)/,'$1Other_List$2'));
  await expect(parse(await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}))).rejects.toThrow('workbook_structure_invalid');
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
  expect(wb.SheetNames).toEqual(['Instructions','Increment','Increment (2)','Resignation','Reference','Lists','_meta']);
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
  const typedCatalog={...catalog,fields:{...catalog.fields,gradeId:[{value:b,codes:['G2'],label:'Grade Two',aliases:['G2','Grade Two']}]}},bytes=await buildMovementWorkbook({tenantId:a,companyId:a,companyName:'Fictional A',catalog:typedCatalog,subjects,typeCode:'increment',resolve}),zip=await JSZip.loadAsync(bytes),xml=await zip.file('xl/worksheets/sheet2.xml')!.async('string');
  const validations=xml.match(/<dataValidation\b[^>]*>/g)??[];expect(validations.length).toBeGreaterThan(0);expect(validations.every(tag=>tag.includes('showErrorMessage="0"'))).toBe(true);
  const columns=movementWorkbookLayout(catalog.types[0],resolve),changed=await edit(bytes,wb=>{for(const [key,value]of [['incrementAmount','100'],['effectiveDate','2026-11-01'],['gradeId','G2']])wb.Sheets.Increment[XLSX.utils.encode_cell({r:5,c:columns.findIndex(c=>c.key===key)})]={t:'s',v:value};});
  expect((await readMovementWorkbook(changed,{tenantId:a,companyId:a,catalog:typedCatalog,resolve})).records[0]).toMatchObject({errors:[],cells:{gradeId:'G2'}});
 });
 it('uses only exact reference codes in every native validation and pairs them with readable Reference labels',async()=>{
  const type={code:'promotion',label:'Promotion',behaviour:'promotion'};
  const fields={...catalog.fields,departmentId:[{value:department,codes:['D&<001>'],label:'Shared label'}],positionId:[{value:b,codes:['P001'],label:'Shared label'}],businessUnitId:[{value:b,codes:['0007'],label:'Friendly unit'}],gradeId:[{value:b,codes:['G01'],label:'Shared label'},{value:department,codes:['G02'],label:'Shared label'}],locationId:[{value:b,codes:['LOC1'],label:'Office'}],managerEmploymentId:[{value:b,codes:['EMP0002'],label:'EMP0002 · Fictional manager',companyId:a,eligible:true,isTestRecord:false},{value:department,codes:['TEST01'],label:'Test manager',companyId:a,eligible:true,isTestRecord:true},{value:'66666666-6666-4666-8666-666666666666',label:'No assigned Employee ID',companyId:a,eligible:true,isTestRecord:false}],orgBase:[{value:'BASE001',label:'Shared label'},{value:'BASE002',label:'Shared label'}]};
  const codeCatalog={...catalog,types:[type],fields},bytes=await buildMovementWorkbook({tenantId:a,companyId:a,companyName:'Fictional A',catalog:codeCatalog,subjects:[],resolve}),wb=XLSX.read(bytes,{type:'buffer',cellNF:true}),zip=await JSZip.loadAsync(bytes),sheetXml=await zip.file('xl/worksheets/sheet2.xml')!.async('string'),columns=movementWorkbookLayout(type,resolve);
  const valuesFor=(field:string)=>{
   const address=XLSX.utils.encode_col(columns.findIndex(column=>column.key===field)),tag=[...sheetXml.matchAll(/<dataValidation\b[^>]*sqref="([^"]+)"[^>]*><formula1>([^<]+)<\/formula1><\/dataValidation>/g)].find(match=>match[1]===address+'6:'+address+'205');expect(tag).toBeDefined();
   const name=wb.Workbook?.Names?.find(name=>name.Name===tag![2]);expect(name?.Ref).toMatch(/^'Lists'!/);const range=XLSX.utils.decode_range(name!.Ref.replace(/^'Lists'!/,''));return Array.from({length:range.e.r-range.s.r+1},(_,i)=>wb.Sheets.Lists[XLSX.utils.encode_cell({r:range.s.r+i,c:range.s.c})].v);
  };
  for(const [field,expected]of Object.entries({departmentId:['D&<001>'],positionId:['P001'],businessUnitId:['0007'],gradeId:['G01','G02'],locationId:['LOC1'],managerEmploymentId:['EMP0002'],orgBase:['BASE001','BASE002'],employmentType:['full_time','part_time','contract','intern']})){
   expect(columns.some(column=>column.key===field)).toBe(true);expect(valuesFor(field)).toEqual(expected);
  }
  const reference=XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Reference,{header:1,defval:''});
  for(const pair of [['G01','Shared label'],['G02','Shared label'],['0007','Friendly unit'],['D&<001>','Shared label'],['BASE001','Shared label'],['EMP0002','EMP0002 · Fictional manager']])expect(reference.some(row=>row.some((code,i)=>code===pair[0]&&row[i+1]===pair[1]&&row[i+2]==='Fictional A'))).toBe(true);
  expect(JSON.stringify(reference)).not.toContain('TEST01');expect(JSON.stringify(reference)).not.toContain('66666666-6666-4666-8666-666666666666');const codeCell=Object.values(wb.Sheets.Reference).find(cell=>cell&&typeof cell==='object'&&'v'in cell&&cell.v==='0007');expect(codeCell).toMatchObject({t:'s',v:'0007',z:'@'});
  await expect(readMovementWorkbook(bytes,{tenantId:a,companyId:a,catalog:codeCatalog,resolve})).resolves.toMatchObject({records:[],fileErrors:['no_data_rows']});
  const selected={employeeCode:'EX-001',effectiveDate:'2026-01-01',departmentId:valuesFor('departmentId')[0],positionId:valuesFor('positionId')[0],businessUnitId:valuesFor('businessUnitId')[0],gradeId:valuesFor('gradeId')[0],locationId:valuesFor('locationId')[0],managerEmploymentId:valuesFor('managerEmploymentId')[0],orgBase:valuesFor('orgBase')[0],employmentType:valuesFor('employmentType')[0]};
  const completed=await edit(bytes,book=>{for(const [key,value]of Object.entries(selected))book.Sheets.Promotion[XLSX.utils.encode_cell({r:5,c:columns.findIndex(column=>column.key===key)})]={t:'s',v:value};});
  const imported=await readMovementWorkbook(completed,{tenantId:a,companyId:a,catalog:codeCatalog,resolve});expect(imported.fileErrors).toEqual([]);expect(imported.records[0]).toMatchObject({employeeCode:'EX-001',errors:[],cells:{kind:'promotion',departmentId:'D&<001>',businessUnitId:'0007',gradeId:'G01',positionId:'P001',managerEmploymentId:'EMP0002',orgBase:'BASE001',employmentType:'full_time'}});
 });
 it('keeps destination company guidance outside the code value and preserves per-employee manager exclusions',async()=>{
  const type={code:'entityTransfer',label:'Entity transfer',behaviour:'entityTransfer'},companyB={value:b,label:'Fictional B'},sourceManager={value:'44444444-4444-4444-8444-444444444444',codes:['M001'],label:'Source manager',companyId:a,eligible:true},targetManager={value:'55555555-5555-4555-8555-555555555555',codes:['M002'],label:'Target manager',companyId:b,eligible:true};
  const source={...catalog,types:[type],companies:[...catalog.companies,companyB],fields:{departmentId:[{value:department,codes:['D001'],label:'Shared department'}],managerEmploymentId:[sourceManager,targetManager]}},target={...source,fields:{departmentId:[{value:b,codes:['D001'],label:'Shared department'}],managerEmploymentId:[targetManager]}};
  const bytes=await buildMovementWorkbook({tenantId:a,companyId:a,companyName:'Fictional A',catalog:source,destinationCatalogs:{[a]:source,[b]:target},typeCode:type.code,subjects:[{...subjects[0],managerExclusions:[sourceManager.value]}],resolve}),wb=XLSX.read(bytes,{type:'buffer'}),zip=await JSZip.loadAsync(bytes),sheetXml=await zip.file('xl/worksheets/sheet2.xml')!.async('string'),columns=movementWorkbookLayout(type,resolve),managerColumn=XLSX.utils.encode_col(columns.findIndex(column=>column.key==='managerEmploymentId'));
  const rowValidation=[...sheetXml.matchAll(/<dataValidation\b[^>]*sqref="([^"]+)"[^>]*><formula1>([^<]+)<\/formula1><\/dataValidation>/g)].find(match=>match[1]===managerColumn+'6:'+managerColumn+'6');expect(rowValidation).toBeDefined();const name=wb.Workbook?.Names?.find(name=>name.Name===rowValidation![2]),range=XLSX.utils.decode_range(name!.Ref.replace(/^'Lists'!/,''));expect(wb.Sheets.Lists[XLSX.utils.encode_cell(range.s)].v).toBe('M002');expect(range.e.r).toBe(range.s.r);
  const refs=XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Reference,{header:1,defval:''});for(const company of ['Fictional A','Fictional B'])expect(refs.some(row=>row.some((value,i)=>value==='D001'&&row[i+1]==='Shared department'&&row[i+2]===company))).toBe(true);
  const listValues=XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Lists,{header:1}).slice(1).flat();expect(listValues).toContain('D001');expect(listValues).not.toContain('Fictional B · Shared department');expect(listValues).not.toContain(a);expect(listValues).not.toContain(b);
 });
 it('rejects oversized reference catalogues without offering a truncated list and refuses formulas on Reference',async()=>{
  const oversized={...catalog,fields:{...catalog.fields,orgBase:Array.from({length:10001},(_,i)=>({value:'B'+i,label:'Base '+i}))}};
  await expect(buildMovementWorkbook({tenantId:a,companyId:a,companyName:'Fictional A',catalog:oversized,subjects:[],typeCode:'increment',resolve})).rejects.toThrow('movement_reference_catalog_too_large');
  await expect(parse(await edit(await make(),book=>{book.Sheets.Reference.A3={t:'n',v:1,f:'1+0'};}))).rejects.toThrow('formula_input');
 });
 it.each(personnelImportLabelResolvers.map((resolve,index)=>({resolve,index})))('keeps codes unchanged in localized workbook $index',async({resolve})=>{
  const typedCatalog={...catalog,fields:{...catalog.fields,orgBase:[{value:'0008&<',label:''}]}},bytes=await buildMovementWorkbook({tenantId:a,companyId:a,companyName:'Fictional A',catalog:typedCatalog,subjects:[],typeCode:'increment',resolve}),wb=XLSX.read(bytes,{type:'buffer',cellNF:true});
  const rows=XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Reference,{header:1,defval:''});expect(rows[1]).toContain(resolve('admin.systemLabels.col.code','Code'));expect(rows.some(row=>row.some((value,i)=>value==='0008&<'&&row[i+1]==='0008&<'))).toBe(true);
  expect(XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Lists,{header:1}).slice(1).flat()).toContain('0008&<');await expect(readMovementWorkbook(bytes,{tenantId:a,companyId:a,catalog:typedCatalog,resolve})).resolves.toMatchObject({records:[]});
 });
 it('reserves Reference for guidance while preserving previously bound source tabs with that name',async()=>{
  const type={code:'increment',label:'Reference',behaviour:'increment'},typedCatalog={...catalog,types:[type]},columns=movementWorkbookLayout(type,resolve),sourceBindings=[{sheet:'Reference',code:type.code,behaviour:type.behaviour,columns:columns.map(column=>column.key),captions:columns.map(column=>column.label),identities:[]}];
  const current=await buildMovementWorkbook({tenantId:a,companyId:a,companyName:'Fictional A',catalog:typedCatalog,subjects:[],resolve});expect(XLSX.read(current,{type:'buffer'}).SheetNames).toEqual(['Instructions','Reference (2)','Reference','Lists','_meta']);
  const annotated=await buildMovementWorkbook({tenantId:a,companyId:a,companyName:'Fictional A',catalog:typedCatalog,subjects:[],sourceBindings,resolve});expect(XLSX.read(annotated,{type:'buffer'}).SheetNames).toEqual(['Instructions','Reference','Reference (2)','Lists','_meta']);await expect(readMovementWorkbook(annotated,{tenantId:a,companyId:a,catalog:typedCatalog,resolve})).resolves.toMatchObject({records:[]});
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
