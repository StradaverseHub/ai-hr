/** The frozen SQL snapshot must consume the same declared nullable fields and retention duration. */
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import policy from '../lib/pdpa-erasure-policy.json';

describe('privacy erasure policy cross-owner contract',()=>{
 it('keeps SQL preparation identical to the canonical service declaration',()=>{
  const source=readFileSync('db/migrations/0579_configurable_access.sql','utf8');
  const definition=source.match(/CREATE FUNCTION app\.access_privacy_erasure_policy\(\) RETURNS jsonb[\s\S]*?SELECT '((?:[^']|'')*)'::jsonb;/);
  expect(definition,'privacy owner SQL declaration missing').not.toBeNull();
  expect(JSON.parse(definition![1].replaceAll("''","'"))).toEqual(policy);
 });
 it('does not expand erasure into retained non-null identity, employment or unrelated register values',()=>{
  expect(policy.fields.some(field=>['fullName','primaryEmail','icNumber','disabledIndividual','disabledSpouse'].includes(field.key))).toBe(false);
  expect(policy.fields.find(field=>field.key==='dateOfBirth')).toMatchObject({table:'person',statutoryLocked:true,scopes:['identity']});
  expect(policy.dependentContact).toEqual(['phone','residentialAddress','companyName','employerAddress']);
  expect(policy.dependentIdentity).toEqual(['icOrPassport','passportNumber']);
 });
});
