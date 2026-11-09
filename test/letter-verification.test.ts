import {beforeEach,afterAll,it,expect} from 'vitest';
import {randomBytes} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {client} from '../db/client';
import {verifyPublicLetter} from '../core/letter-verification';
import {resetDb,closeAll,owner} from './harness';
beforeEach(resetDb);afterAll(closeAll);

async function verificationMinute(): Promise<number> {
  const [row] = await owner.db.execute<{ minute: number }>(sql`
    select floor(extract(epoch from clock_timestamp()) / 60)::integer as minute
  `);
  return row.minute;
}

async function withinVerificationMinute<T>(run: () => Promise<T>): Promise<T> {
  const minute = await verificationMinute();
  const result = await run();
  if (await verificationMinute() === minute) return result;

  // The limiter resets at a database-clock minute boundary. Discard only a run that crossed it.
  await owner.db.execute(sql`delete from letter_verification_rate`);
  const freshMinute = await verificationMinute();
  const freshResult = await run();
  expect(await verificationMinute()).toBe(freshMinute);
  return freshResult;
}

it('allows only minimal status through the anonymous purpose boundary and limits repeated verification',async()=>{
 const token=randomBytes(32).toString('base64url');
 const responses = await withinVerificationMinute(() => Promise.all(Array.from({length:25},()=>verifyPublicLetter(token))));
 expect(responses.filter(value=>value==='invalid')).toHaveLength(20);expect(responses.filter(value=>value==='limited')).toHaveLength(5);
 await expect(client.unsafe('select * from letter_verification_rate')).rejects.toMatchObject({code:'42501'});await expect(client.unsafe('select * from letter_artifact')).resolves.toEqual([]);
});
it('bounds anonymous counter growth and total requests across distinct opaque tokens',async()=>{
 const responses = await withinVerificationMinute(async () => {
   const outcomes = [];
   for (let index = 0; index <= 120; index++) {
     outcomes.push(await verifyPublicLetter(randomBytes(32).toString('base64url')));
   }
   return outcomes;
 });
 expect(responses.slice(0, 120)).toEqual(Array(120).fill('invalid'));
 expect(responses[120]).toBe('limited');
 const rows=await owner.db.execute(sql`select count(*)::integer as count from letter_verification_rate`);expect(rows[0]).toEqual({count:121});
});
