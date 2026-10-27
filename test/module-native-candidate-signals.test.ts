/** Authored UNRUN: this pure contract proves no canonical execution or candidate evaluation. */
import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {captureNativeCandidateSignalIds,captureNativeCandidateSignals} from '../lib/ai/module-native-signals';
const signal=()=>({associationId:randomUUID(),jobId:randomUUID(),associationReceiptDigest:'a'.repeat(64),nativeDigest:'b'.repeat(64),jobReceiptDigest:'c'.repeat(64),action:'leave.apply',module:'leave',expiresAt:new Date(Date.now()+3600_000).toISOString()});
describe('closed historical native completion references',()=>{
 it('captures one source immutably, normalizes IDs and preserves no HR values',()=>{const raw=signal(),ref=captureNativeCandidateSignals([raw]);raw.module='payroll';expect(ref[0].module).toBe('leave');expect(Object.isFrozen(ref)).toBe(true);expect(Object.isFrozen(ref[0])).toBe(true);expect(captureNativeCandidateSignalIds([ref[0].associationId.toUpperCase()])).toEqual([ref[0].associationId]);});
 it('rejects unions of independent subject ownership and posted ratings, values or receipt text',()=>{const raw=signal();expect(()=>captureNativeCandidateSignalIds([randomUUID(),randomUUID()])).toThrow();expect(()=>captureNativeCandidateSignals([raw,signal()])).toThrow();for(const extra of [{quality:'passed'},{salary:3000},{receipt:'arbitrary'},{causalCredit:true}])expect(()=>captureNativeCandidateSignals([{...raw,...extra}])).toThrow();});
 it('rejects wrong-module, unknown-action, malformed digest/time and non-ID paths',()=>{const raw=signal();for(const change of [{module:'payroll'},{action:'anything.execute'},{nativeDigest:'model-pass'},{expiresAt:'tomorrow'}])expect(()=>captureNativeCandidateSignals([{...raw,...change}])).toThrow();for(const id of ['../source',{},42])expect(()=>captureNativeCandidateSignalIds([id])).toThrow();});
 it('keeps absent native evidence distinct from completed evidence; never invents a score',()=>{expect(captureNativeCandidateSignalIds(undefined)).toEqual([]);expect(captureNativeCandidateSignals(undefined)).toEqual([]);expect(captureNativeCandidateSignals([signal()])[0]).not.toHaveProperty('quality');});
});
