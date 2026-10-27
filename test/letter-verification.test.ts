import {beforeEach,afterAll,it,expect} from 'vitest';
import {randomBytes} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {client} from '../db/client';
import {verifyPublicLetter} from '../core/letter-verification';
import {resetDb,closeAll,owner} from './harness';
beforeEach(resetDb);afterAll(closeAll);
it('allows only minimal status through the anonymous purpose boundary and limits repeated verification',async()=>{
 const token=randomBytes(32).toString('base64url');const responses=await Promise.all(Array.from({length:25},()=>verifyPublicLetter(token)));expect(responses.filter(value=>value==='invalid')).toHaveLength(20);expect(responses.filter(value=>value==='limited')).toHaveLength(5);
 await expect(client.unsafe('select * from letter_verification_rate')).rejects.toMatchObject({code:'42501'});await expect(client.unsafe('select * from letter_artifact')).resolves.toEqual([]);
});
it('bounds anonymous counter growth and total requests across distinct opaque tokens',async()=>{
 for(let index=0;index<120;index++)expect(await verifyPublicLetter(randomBytes(32).toString('base64url'))).toBe('invalid');expect(await verifyPublicLetter(randomBytes(32).toString('base64url'))).toBe('limited');
 const rows=await owner.db.execute(sql`select count(*)::integer as count from letter_verification_rate`);expect(rows[0]).toEqual({count:121});
});
