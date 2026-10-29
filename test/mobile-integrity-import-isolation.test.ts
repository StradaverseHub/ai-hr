/** An inactive optional vendor stack must not prevent established clocking from loading. */
import {describe,expect,it,vi} from 'vitest';
vi.mock('../core/mobile-apple-enrollment',()=>{throw new Error('Optional Apple enrollment stack unavailable');});
vi.mock('../core/mobile-apple-clock-assertion',()=>{throw new Error('Optional Apple assertion stack unavailable');});
describe('legacy attendance loading without integrity activation',()=>{
  it('loads its ordinary public facade without evaluating optional vendor owners',async()=>{
    const services=await import('../packs/attendance/service');expect(typeof services.captureNativeClock).toBe('function');
  });
  it('loads key recovery routes without evaluating either optional vendor owner',async()=>{
    const keys=await import('../app/api/mobile/v1/integrity/keys/route');
    const revoke=await import('../app/api/mobile/v1/integrity/revoke/route');
    const receipt=await import('../app/api/mobile/v1/integrity/key-receipt/route');
    expect(typeof keys.GET).toBe('function');expect(typeof revoke.POST).toBe('function');
    expect(Object.keys(keys)).toEqual(['GET']);expect(Object.keys(revoke)).toEqual(['POST']);expect(Object.keys(receipt)).toEqual(['POST']);
  });
  it('loads the established v1 clock handler without optional vendor owners',async()=>{
    const route=await import('../app/api/mobile/v1/clock/route');expect(typeof route.POST).toBe('function');
  });
});
