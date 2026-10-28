import {expect,it} from 'vitest';
import {buildXlsx,workbookToCsvTexts} from '../lib/spreadsheet';
import {ALLOCATION_COLUMNS,ALLOCATION_SHEET,ALLOCATION_REFERENCE_SHEET,ALLOCATION_INSTRUCTIONS_SHEET} from '../lib/employment-cost-allocation';
import {allocationWorkbookSheets,allocationHeaderRow} from '../lib/cost-allocation-workbook';
import {parseCostAllocationCsv,allocationBindingKey,LEGACY_ALLOCATION_LAYOUT_MESSAGE} from '../lib/cost-allocation-import';
const references={companies:[{code:'ACME',name:'Acme Sdn Bhd'},{code:'201901000001',name:'No Label Bhd'}],costCenters:[{companyCode:'ACME',code:'CC-REAL',label:'Friendly display label'}]};
it('c4055300: one template for every company with Company Code captions, a Reference sheet and instructions',async()=>{
 const sheets=allocationWorkbookSheets(references,'Explain every column.');
 expect(sheets.map(s=>s.name)).toEqual([ALLOCATION_SHEET,ALLOCATION_REFERENCE_SHEET,ALLOCATION_INSTRUCTIONS_SHEET]);
 expect(sheets[0].rows[0]).toEqual(['Company Code','Employee ID','Effective Date','Operation','Cost Center Code','Percentage']);
 expect(sheets[0].validationLists?.find(l=>l.column===0)?.values).toEqual(['ACME','201901000001']);
 expect(sheets[0].validationLists?.find(l=>l.column===3)?.values).toEqual(['Replace','Clear']);
 expect(sheets[0].validationLists?.find(l=>l.column===4)?.values).toEqual(['CC-REAL']);
 // A company without cost centres is still listed so its Company Code can be looked up.
 expect(sheets[1].rows).toEqual([['Company Code','Company','Cost Center Code','Cost Center Description'],['ACME','Acme Sdn Bhd','CC-REAL','Friendly display label'],['201901000001','No Label Bhd','','']]);
 expect(JSON.stringify(sheets)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
});
it('round-trips a genuine workbook with friendly captions and preserved employee IDs',async()=>{
 const sheets=allocationWorkbookSheets(references,'Instructions');
 const bytes=await buildXlsx(allocationHeaderRow(),[['ACME','00017','2026-01-01','Replace','CC-REAL','33.33'],['acme','00017','2026-01-01','replace','CC-SECOND','66.67']],{sheetName:ALLOCATION_SHEET,textColumns:[0,1,2,3,4,5],extraSheets:sheets.slice(1)});
 expect(bytes[0]).toBe(0x50);expect(bytes[1]).toBe(0x4b);
 const decoded=await workbookToCsvTexts(bytes,[ALLOCATION_REFERENCE_SHEET]);const rows=parseCostAllocationCsv(decoded.first);
 expect(rows).toMatchObject([{company_code:'ACME',employee_code:'00017',operation:'replace',cost_center_code:'CC-REAL',percentage:'33.33'},{company_code:'acme',employee_code:'00017',operation:'replace',cost_center_code:'CC-SECOND',percentage:'66.67'}]);
 expect(decoded.extra[ALLOCATION_REFERENCE_SHEET]).toContain('CC-REAL');
 expect(parseCostAllocationCsv(allocationHeaderRow().join(',')+'\n')).toEqual([]);
});
it('accepts the column keys as headers too, in any order',()=>{
 const rows=parseCostAllocationCsv('percentage,cost_center_code,operation,effective_date,employee_code,company_code\n50,CC,Clear,2026-01-01,e1,ACME');
 expect(rows[0]).toEqual({percentage:'50',cost_center_code:'CC',operation:'clear',effective_date:'2026-01-01',employee_code:'E1',company_code:'ACME'});
});
it('refuses the old company_id layout with a message naming the new template',()=>{
 expect(()=>parseCostAllocationCsv('company_id,employee_code,effective_date,operation,cost_center_code,percentage\n00000000-0000-4000-8000-000000000001,E1,2026-01-01,replace,CC,100')).toThrow(LEGACY_ALLOCATION_LAYOUT_MESSAGE);
 expect(()=>parseCostAllocationCsv('Company ID,Employee ID,Effective Date,Operation,Cost Center Code,Percentage\n')).toThrow(/Download the new template/);
});
it('refuses ambiguous or misplaced master-sheet columns instead of treating repeated employee rows as new hires',()=>{
 expect(()=>parseCostAllocationCsv('full_name,email\nExample,person@example.test')).toThrow(/Missing allocation columns/);expect(()=>parseCostAllocationCsv(ALLOCATION_COLUMNS.join(',')+',basic_salary\n')).toThrow(/Unexpected allocation columns/);
});
it('rejects duplicate normalized headers instead of accepting a last-wins identity column',()=>{
 expect(()=>parseCostAllocationCsv(ALLOCATION_COLUMNS.join(',')+', COMPANY CODE\n')).toThrow(/Duplicate allocation column/);
 expect(()=>parseCostAllocationCsv(ALLOCATION_COLUMNS.join(',')+',Employee ID\n')).toThrow(/Duplicate allocation column/);
});
it('normalizes allocation Employee IDs using the canonical case rule without dropping leading zeroes',()=>{const csv=ALLOCATION_COLUMNS.join(',')+'\nACME, 00017-ab ,2026-01-01,replace,CC-REAL,100';expect(parseCostAllocationCsv(csv)[0].employee_code).toBe('00017-AB');expect(allocationBindingKey('company','00017-ab')).toBe(allocationBindingKey('company','00017-AB'));});
