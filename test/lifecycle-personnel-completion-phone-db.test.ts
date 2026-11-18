import {afterAll,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {sql} from 'drizzle-orm';
import {parsePhoneNumberWithError} from 'libphonenumber-js/max';
import {owner,closeAll} from './harness';
import {normalizeCompletionPhone} from '../lib/lifecycle-v9-personnel-completion';
const require=createRequire(import.meta.url);
const examples=JSON.parse(readFileSync(require.resolve('libphonenumber-js/mobile/examples'), 'utf8')) as Record<string,string>;
const metadata=JSON.parse(readFileSync(require.resolve('libphonenumber-js/metadata.max.json'),'utf8')) as {countries:Record<string,[string,...unknown[]]>};
afterAll(closeAll);
it('matches pinned full numbering-plan validation across every supplied country example in one bounded database request',async()=>{
 const records=Object.entries(examples).map(([country,national])=>{
  const value='+'+metadata.countries[country][0]+national;
  return {country,value,expected:parsePhoneNumberWithError(value).isValid()};
 });
 expect(records.length).toBeGreaterThan(200);expect(records.every(record=>record.expected)).toBe(true);
 const rows=await owner.db.execute<{country:string;valid:boolean}>(sql`select x.country,app.personnel_completion_phone_valid(x.value) as valid from jsonb_to_recordset(${JSON.stringify(records)}::jsonb) x(country text,value text) order by x.country`);
 expect(rows.map(row=>row.country)).toEqual(records.map(row=>row.country).sort());expect(rows.every(row=>row.valid)).toBe(true);
});
it('accepts canonicalized jurisdictional numbers and rejects forged length-only, national, extension and malformed SQL inputs',async()=>{
 const values=[normalizeCompletionPhone('012 345 6789','MY'),normalizeCompletionPhone('+65 8123 4567','MY'),'+600001234567','+6512345678','0123456789','+60123456789 ext 1','+60123456789junk','',null];
 const rows=await owner.db.execute<{value:string|null;valid:boolean}>(sql`select x.value,app.personnel_completion_phone_valid(x.value) as valid from jsonb_array_elements_text(${JSON.stringify(values)}::jsonb) with ordinality x(value,ordinality) order by x.ordinality`);
 expect(rows.map(row=>row.valid)).toEqual([true,true,false,false,false,false,false,false,false]);
});
