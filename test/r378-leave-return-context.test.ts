import { describe, expect, it } from 'vitest';
import { leaveSelfReturnUrl,withLeaveEmploymentContext } from '../lib/leave-return-context';

describe('own leave action return context', () => {
  it('preserves a verified own selection without replacing warning or outcome context',()=>{
    const id='bd841cc0-3c23-43f7-aa24-996de1f5345f';
    const result=new URL(withLeaveEmploymentContext('/leave?warnHoliday=1&toast=Saved',id),'https://fixture.invalid');
    expect(result.pathname).toBe('/leave');expect(result.searchParams.get('employmentId')).toBe(id);
    expect(result.searchParams.get('toast')).toBe('Saved');expect(result.searchParams.get('warnHoliday')).toBe('1');
    expect(withLeaveEmploymentContext('/leave?error=Refused',undefined)).toBe('/leave?error=Refused');
    for(const bad of ['https://evil.invalid/leave?','//evil.invalid/leave?','/leave/foreign?'])expect(()=>withLeaveEmploymentContext(bad,id)).toThrow();
    expect(()=>withLeaveEmploymentContext('/leave?toast=Saved','not-an-id')).toThrow();
  });
  it('preserves repeated type filters and the history view on success and refusal', () => {
    const form = new FormData();
    form.set('leaveOrigin', 'history');
    form.set('leaveContext', 'hTab=pending&hType=first&hType=second&hFrom=2026-01-01&leaveYear=2026&warnHoliday=1');
    for (const key of ['toast', 'error'] as const) {
      const result = new URL(leaveSelfReturnUrl(form, key, 'result'), 'https://fixture.invalid');
      expect(result.pathname).toBe('/leave/history');
      expect(result.searchParams.getAll('hType')).toEqual(['first', 'second']);
      expect(result.searchParams.get('hTab')).toBe('pending');
      expect(result.searchParams.get('hFrom')).toBe('2026-01-01');
      expect(result.searchParams.get('leaveYear')).toBe('2026');
      expect(result.searchParams.get('warnHoliday')).toBe('1');
      expect(result.searchParams.get(key)).toBe('result');
    }
  });

  it('refuses arbitrary destinations, foreign query keys and injected outcomes', () => {
    const form = new FormData();
    form.set('leaveOrigin', 'history');
    form.set('leaveContext', 'redirect=https://evil.invalid&leaveOrigin=https://evil.invalid&toast=forged&hTab=approved&hFrom=' + 'x'.repeat(201));
    const result = new URL(leaveSelfReturnUrl(form, 'toast', 'leaveUpdated'), 'https://fixture.invalid');
    expect(result.origin).toBe('https://fixture.invalid');
    expect(result.pathname).toBe('/leave/history');
    expect([...result.searchParams.keys()]).toEqual(['hTab', 'toast']);
    expect(result.searchParams.get('toast')).toBe('leaveUpdated');
    form.set('leaveOrigin', 'https://evil.invalid');
    expect(leaveSelfReturnUrl(form, 'error', 'refused')).toBe('/leave?error=refused');
  });
});
