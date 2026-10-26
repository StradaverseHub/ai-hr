/** An inactive optional vendor stack must not prevent established clocking from loading. */
import {describe,expect,it,vi} from 'vitest';
vi.mock('../core/mobile-apple-enrollment',()=>{throw new Error('Optional Apple enrollment stack unavailable');});
vi.mock('../core/mobile-apple-clock-assertion',()=>{throw new Error('Optional Apple assertion stack unavailable');});
describe('legacy attendance loading without integrity activation',()=>{
  it('loads its ordinary public facade without evaluating optional vendor owners',async()=>{
    const services=await import('../packs/attendance/service');expect(typeof services.captureNativeClock).toBe('function');
  });
  it('loads the established v1 clock handler without optional vendor owners',async()=>{
    const route=await import('../app/api/mobile/v1/clock/route');expect(typeof route.POST).toBe('function');
  });
});
