import {it,expect} from 'vitest';
import {personnelFamilyValues,personnelFamilyCatalogErrors} from '../lib/personnel-family-import';
import {DEPENDENT_IMPORT_COLUMNS} from '../lib/import-schema';
import {personnelImportFields} from '../lib/personnel-import-contract';
it('includes each editable Family owner field and preserves register-specific fields',()=>{
 const columns=[...DEPENDENT_IMPORT_COLUMNS.required,...DEPENDENT_IMPORT_COLUMNS.optional];
 for(const field of personnelImportFields('family'))expect(columns).toContain(field.import.column);
 expect(personnelFamilyValues({relationship:'child',full_name:'Fictional child',is_student:'yes',school_name:'Fictional school',study_country:'Malaysia',child_relief_category:'study_tertiary',child_tax_relief:'no',child_relief_percentage:'50'})).toEqual({values:{relationship:'child',fullName:'Fictional child',isStudent:true,schoolName:'Fictional school',studyCountry:'Malaysia',childReliefCategory:'study_tertiary',childTaxRelief:false,childReliefPercentage:50},errors:[]});
});
it('refuses wrong-relationship cells and impossible dates instead of dropping values',()=>{
 expect(personnelFamilyValues({relationship:'parent',marriage_date:'2025-02-29',is_student:'yes'}).errors).toHaveLength(2);
 expect(personnelFamilyValues({relationship:'spouse',marriage_date:'2025-02-29'}).errors[0]).toContain('real date');
 expect(personnelFamilyValues({relationship:'child',child_relief_percentage:'55'}).errors[0]).toContain('Unknown');
});
it('retains custom relationships for the canonical catalog owner and uses active study-country options',()=>{
 expect(personnelFamilyValues({relationship:'legal_guardian'}).errors).toEqual([]);
 expect(personnelFamilyCatalogErrors({study_country:'Mistyped'},new Map([['country',new Set(['Malaysia'])]]))).not.toEqual([]);
 expect(personnelFamilyCatalogErrors({study_country:'Malaysia'},new Map([['country',new Set(['Malaysia'])]]))).toEqual([]);
});
