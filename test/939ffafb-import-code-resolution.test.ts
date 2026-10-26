import {describe,it,expect} from 'vitest';
import {PersonnelImportLookup,personnelImportOptionLookup} from '../lib/personnel-import-lookup';
import {PersonnelImportCatalog,normalizePersonnelCatalogRecord} from '../lib/personnel-import-catalog';

describe('939ffafb canonical import reference resolution',()=>{
 it('keeps canonical codes ahead of labels and compatibility aliases',()=>{
  for(const reversed of [false,true]){
   const options=[
    {value:'target-a',label:'Shared label',codes:['0007'],aliases:['Old label']},
    {value:'target-b',label:'0007',codes:['B&<>'],aliases:['0007']},
    {value:'target-c',label:'Shared label',codes:['C']},
   ];
   const lookup=personnelImportOptionLookup(reversed?[...options].reverse():options);
   expect(lookup.get(' 0007 ')).toBe('target-a');
   expect(lookup.get('b&<>')).toBe('target-b');
   expect(lookup.get('Old label')).toBe('target-a');
   expect(lookup.get('target-b · 0007')).toBe('target-b');
   expect(lookup.get('target-a · 0007')).toBe('target-a');
   expect(lookup.get('target-a · Old label')).toBe('target-a');
   expect(lookup.get('Shared label')).toBeUndefined();expect(lookup.isAmbiguous('Shared label')).toBe(true);
   expect(lookup.get('7')).toBeUndefined();
  }
 });
 it('refuses invalid duplicate codes even when only one has a matching display label',()=>{
  for(const reversed of [false,true]){
   const options=[{value:'a',label:'DUP',codes:['DUP']},{value:'b',label:'Other',codes:[' dup ']}];
   const lookup=personnelImportOptionLookup(reversed?[...options].reverse():options);
   expect(lookup.get('DUP')).toBeUndefined();expect(lookup.isAmbiguous('DUP')).toBe(true);
   expect(lookup.get('Other')).toBe('b');expect(lookup.get('a')).toBe('a');
  }
 });
 it('does not let a unique label salvage an ambiguous identifier tier',()=>{
  const lookup=new PersonnelImportLookup<string>();
  lookup.add('a','a',{codes:['COLLIDE'],names:['A']}).add('b','b',{codes:['COLLIDE'],names:['COLLIDE']});
  expect(lookup.get('COLLIDE')).toBeUndefined();expect(lookup.isAmbiguous('COLLIDE')).toBe(true);
 });
 it('normalizes every configured organisation column using codes before shared label fallback',()=>{
  for(const [column,category] of [['org_division','division'],['org_branch','branch'],['org_region','region'],['org_line','line'],['org_section','section'],['org_team','team'],['org_base','base'],['employment_category','category']]){
   const catalog=new PersonnelImportCatalog();
   catalog.addOption({category,value:'001',label:'Same'});
   catalog.addOption({category,value:'Same',label:'Unique label'});
   catalog.addOption({category,value:'003',label:'Same'});
   catalog.addOption({category,value:'OLD',label:'Retired',isActive:false});
   expect(normalizePersonnelCatalogRecord({[column]:'Same'},'employee',catalog)).toEqual({record:{[column]:'Same'},errors:[]});
   expect(normalizePersonnelCatalogRecord({[column]:'Unique label'},'employee',catalog).record[column]).toBe('Same');
   expect(catalog.resolve(category,'Retired').value).toBeUndefined();
  }
 });
 it('retains ambiguity for case-colliding configured codes and does not merge categories',()=>{
  const catalog=new PersonnelImportCatalog();
  catalog.addOption({category:'base',value:'CASE',label:'First'});
  catalog.addOption({category:'base',value:'case',label:'Second'});
  catalog.addOption({category:'division',value:'CASE',label:'First'});
  expect(normalizePersonnelCatalogRecord({org_base:'CASE'},'employee',catalog).errors).toHaveLength(1);
  expect(normalizePersonnelCatalogRecord({org_division:'CASE'},'employee',catalog)).toEqual({record:{org_division:'CASE'},errors:[]});
 });
});
