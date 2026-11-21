/**
 * Production 13 Nov 2026: an admin added the termination reason "BETTER OFFER" and every Movement workbook
 * downloaded earlier was refused with workbook_catalogue_changed. Adding a reason cannot change what an existing
 * row means, so a workbook downloaded before the reason was created stays usable. Every other catalogue change
 * (rename, removal, built-in override, a reason older than the download, a changed type) still needs a new
 * download. Synthetic fixtures and key material only.
 */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {buildMovementWorkbook,movementWorkbookCatalogue,movementWorkbookCatalogueCurrent,readMovementWorkbookRows} from '../lib/movement-workbook.server';
import type {MovementImportCatalog} from '../core/movement-import';
import type {MovementWorkbookReason,MovementWorkbookType} from '../lib/movement-workbook-layout';

const tenant='11111111-1111-4111-8111-111111111111';
const resolve=(_key:string,fallback:string)=>fallback;
const reason=(code:string,label:string,builtIn=false):MovementWorkbookReason=>({code,label,category:'voluntary',builtIn});
const typesWith=(reasons:MovementWorkbookReason[],transferLabel='Transfer'):MovementWorkbookType[]=>[
 {code:'termination',label:'Termination',behaviour:'termination',reasons},
 {code:'transfer',label:transferLabel,behaviour:'transfer'},
];
const original=[reason('resignation','Resignation',true),reason('misconduct','Misconduct')];
const catalog:MovementImportCatalog={types:typesWith(original),companies:[{value:tenant,label:'Fictional Co'}],fields:{}};
const later=()=>new Date(Date.now()+60_000).toISOString(),earlier='2020-01-01T00:00:00.000Z';
const read=(bytes:Buffer,types:MovementWorkbookType[],reasonCreatedAt?:Record<string,string>)=>readMovementWorkbookRows(bytes,{tenantId:tenant,types,reasonCreatedAt});
const download=()=>buildMovementWorkbook({tenantId:tenant,types:catalog.types,companies:[{companyId:tenant,code:'FIC',name:'Fictional Co',catalog}],resolve});

beforeEach(()=>{vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY',Buffer.alloc(32,4).toString('base64url'));vi.stubEnv('MOVEMENT_IMPORT_WORKBOOK_KEY_ID','public-fixture-only');});
afterEach(()=>{vi.unstubAllEnvs();});

describe('a workbook downloaded before a termination reason was added',()=>{
 it('is still accepted when the only change is reasons created after the download',async()=>{
  const bytes=await download();
  const now=typesWith([...original,reason('better_offer','BETTER OFFER')]);
  await expect(read(bytes,now,{misconduct:earlier,better_offer:later()})).resolves.toEqual([]);
  // Two added reasons, one placed between existing ones, are still only additions.
  const two=typesWith([original[0],reason('relocation','Relocation'),original[1],reason('better_offer','BETTER OFFER')]);
  await expect(read(bytes,two,{misconduct:earlier,relocation:later(),better_offer:later()})).resolves.toEqual([]);
 });

 it('is still refused for every other catalogue change',async()=>{
  const bytes=await download();
  const added=reason('better_offer','BETTER OFFER');
  // No creation times supplied (the strict caller): unchanged behaviour.
  await expect(read(bytes,typesWith([...original,added]))).rejects.toThrow('workbook_catalogue_changed');
  // The "new" reason existed before the download (e.g. reactivated or newly offered to the type).
  await expect(read(bytes,typesWith([...original,added]),{misconduct:earlier,better_offer:earlier})).rejects.toThrow('workbook_catalogue_changed');
  // An existing reason renamed alongside the addition.
  await expect(read(bytes,typesWith([original[0],reason('misconduct','Gross Misconduct'),added]),{misconduct:earlier,better_offer:later()})).rejects.toThrow('workbook_catalogue_changed');
  // An existing reason removed alongside the addition.
  await expect(read(bytes,typesWith([original[0],added]),{misconduct:earlier,better_offer:later()})).rejects.toThrow('workbook_catalogue_changed');
  // A built-in reason overridden after the download is a change to an existing reason, not an addition.
  await expect(read(bytes,typesWith([reason('resignation','Resigned',true),original[1]]),{resignation:later(),misconduct:earlier})).rejects.toThrow('workbook_catalogue_changed');
  // A changed type alongside the addition.
  await expect(read(bytes,typesWith([...original,added],'Inter-company Transfer'),{misconduct:earlier,better_offer:later()})).rejects.toThrow('workbook_catalogue_changed');
 });

 it('compares fingerprints, not trust in the supplied list',()=>{
  const signed=movementWorkbookCatalogue({types:typesWith(original)}),at='2026-11-13T01:50:00.000Z';
  expect(movementWorkbookCatalogueCurrent(signed,at,typesWith(original))).toBe(true);
  expect(movementWorkbookCatalogueCurrent(signed,at,typesWith([...original,reason('x','X')]),{x:'2026-11-13T02:00:59.000Z'})).toBe(true);
  expect(movementWorkbookCatalogueCurrent(signed,at,typesWith([...original,reason('x','X')]),{x:'2026-11-13T01:49:59.000Z'})).toBe(false);
  expect(movementWorkbookCatalogueCurrent(signed,'not-a-date',typesWith([...original,reason('x','X')]),{x:'2026-11-13T02:00:59.000Z'})).toBe(false);
  expect(movementWorkbookCatalogueCurrent('0'.repeat(64),at,typesWith(original),{misconduct:'2026-11-13T02:00:00.000Z'})).toBe(false);
 });
});
