/** Real memory-hard work: small admitted login bursts must not fail while CPU/memory stay bounded. */
import {expect,it} from 'vitest';
import {passwordHash,passwordMatches} from '../lib/internal-auth/crypto';
it('completes four simultaneous valid password checks without rejecting the second pair',async()=>{
 const password='Fictional burst password 2026!';const encoded=await passwordHash(password);
 const results=await Promise.allSettled(Array.from({length:4},()=>passwordMatches(password,encoded)));
 expect(results.map(result=>result.status)).toEqual(['fulfilled','fulfilled','fulfilled','fulfilled']);
 for(const result of results)if(result.status==='fulfilled')expect(result.value).toBe(true);
},15000);
