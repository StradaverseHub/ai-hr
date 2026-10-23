import {expect,it} from 'vitest';
import {buildXlsx,workbookToCsvTexts} from '../lib/spreadsheet';
import {ALLOCATION_COLUMNS,ALLOCATION_SHEET} from '../lib/employment-cost-allocation';
import {allocationWorkbookSheets,allocationCsvTemplate} from '../lib/cost-allocation-workbook';
import {parseCostAllocationCsv} from '../lib/cost-allocation-import';
it('round-trips a genuine repeated-row workbook and a CSV with code-only references and preserved employee IDs',async()=>{
 const companyId='00000000-0000-4000-8000-000000000001';const reference=[{companyId,id:'00000000-0000-4000-8000-000000000002',code:'CC-REAL',label:'Friendly display label'}];const sheets=allocationWorkbookSheets(reference,'Explicit replace or clear; absent sheet is unchanged.');
 const bytes=await buildXlsx([...ALLOCATION_COLUMNS],[[companyId,'00017','2026-01-01','replace','CC-REAL','33.33'],[companyId,'00017','2026-01-01','replace','CC-SECOND','66.67']],{sheetName:ALLOCATION_SHEET,textColumns:[0,1,2,3,4,5],extraSheets:sheets.slice(1)});
 expect(bytes[0]).toBe(0x50);expect(bytes[1]).toBe(0x4b);const decoded=await workbookToCsvTexts(bytes,['Allocation Codes']);const rows=parseCostAllocationCsv(decoded.first);expect(rows).toMatchObject([{employee_code:'00017',cost_center_code:'CC-REAL',percentage:'33.33'},{employee_code:'00017',cost_center_code:'CC-SECOND',percentage:'66.67'}]);
 expect(decoded.extra['Allocation Codes']).toContain('CC-REAL');expect(sheets[0].validationLists?.find(l=>l.column===4)?.values).toEqual(['CC-REAL']);expect(parseCostAllocationCsv(allocationCsvTemplate())).toEqual([]);
});
it('refuses ambiguous or misplaced master-sheet columns instead of treating repeated employee rows as new hires',()=>{
 expect(()=>parseCostAllocationCsv('full_name,email\nExample,person@example.test')).toThrow(/Missing allocation columns/);expect(()=>parseCostAllocationCsv(ALLOCATION_COLUMNS.join(',')+',basic_salary\n')).toThrow(/Unexpected allocation columns/);
});

it('rejects duplicate normalized headers instead of accepting a last-wins identity column',()=>{expect(()=>parseCostAllocationCsv(ALLOCATION_COLUMNS.join(',')+', COMPANY ID\n')).toThrow(/Duplicate allocation column/);});
