import {expect,it} from 'vitest';
import {employeeChoiceNativeObjectOid} from './performance/employee-choice-native-object-identity';
it('retains actual canonical native decimal-text OIDs exactly including the uint32 boundary',()=>{
 for(const value of ['1','72965','4294967295'])expect(employeeChoiceNativeObjectOid(value)).toBe(value);
 const raw={oid:'72965',proowner:'10',prosrc:'fixed complete source'};const before={...raw};
 expect(employeeChoiceNativeObjectOid(raw.oid)).toBe('72965');expect(raw).toEqual(before);
});
it('accepts only safe positive integral numeric alternatives without loosening the native identity',()=>{
 for(const value of [1,72965,4294967295])expect(employeeChoiceNativeObjectOid(value)).toBe(String(value));
 for(const value of [0,-0,-1,1.5,4294967296,Number.MAX_SAFE_INTEGER,NaN,Infinity,-Infinity])expect(()=>employeeChoiceNativeObjectOid(value)).toThrow('uint32');
});
it('rejects malformed, clipped, coercible and noncanonical OIDs without invoking user conversion',()=>{
 let coerced=0;const hostile={toString(){coerced++;return'72965';},valueOf(){coerced++;return 72965;}};
 for(const value of ['', '0','01','+1','-1','1.0','1e3',' 1','1 ','4294967296','10000000000','１','1\0',null,undefined,true,BigInt(1),[],['72965'],hostile,Symbol('private')])expect(()=>employeeChoiceNativeObjectOid(value)).toThrow('uint32');
 expect(coerced).toBe(0);
});
