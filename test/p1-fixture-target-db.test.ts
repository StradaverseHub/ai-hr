/** Read-only target admission on an invocation-created database; no demo/product seed is run. */
import {it,expect,afterAll} from 'vitest';
import {createDb} from '../db/client';
import {owner,closeAll} from './harness';
import {assertDisposableDemoUrl,attestDisposableDemoDatabase} from '../scripts/lib/disposable-demo-fixture';
afterAll(closeAll);
it('attests the actual named database owner and refuses foreign tenancy without changing rows',async()=>{
 const name='ai_hr_fixture_onehr',url=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);url.pathname='/'+name;url.search='';
 const target=assertDisposableDemoUrl(url.toString(),'onehr');
 let created=false,fixture:ReturnType<typeof createDb>|undefined;
 try {
  // No IF EXISTS/DROP before creation: a collision is foreign custody and must fail without cleanup.
  await owner.client.unsafe(`create database "${name}"`);created=true;fixture=createDb(url.toString());
  await fixture.client`create table tenant(id uuid primary key)`;
  await fixture.client`insert into tenant(id) values('11111111-1111-1111-1111-111111111111'),('00000000-0000-0000-0000-000000000000')`;
  await expect(attestDisposableDemoDatabase(fixture.client,target)).resolves.toBeUndefined();
  await fixture.client`insert into tenant(id) values('22222222-2222-2222-2222-222222222222')`;
  const before=await fixture.client`select id from tenant order by id`;
  await expect(attestDisposableDemoDatabase(fixture.client,target)).rejects.toThrow('attestation refused');
  expect(await fixture.client`select id from tenant order by id`).toEqual(before);
 } finally {if(fixture)await fixture.client.end();if(created)await owner.client.unsafe(`drop database "${name}"`);}
});
