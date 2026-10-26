import { describe, expect, it } from 'vitest';
import { captureAgentReadBatch, serializeAgentReadResult, AGENT_READ_BATCH_LIMITS } from '../lib/ai/agent-read-batch';
const call = (input: unknown = {}) => ({ id: 'call_1', name: 'my_leave_balances', input });

describe('shared agent read proposal boundary', () => {
  it('captures immutable inputs without retargeting a retained call', () => {
    const input = { employmentId: 'original', rows: [{ day: '2026-10-26' }] };
    const source = call(input);
    const captured = captureAgentReadBatch([source]);
    input.employmentId = 'retargeted'; input.rows[0].day = '2099-01-01'; source.name = 'other';
    expect(captured[0]).toEqual(call({ employmentId: 'original', rows: [{ day: '2026-10-26' }] }));
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen((captured[0].input as typeof input).rows[0])).toBe(true);
  });
  it('preserves malformed parsed arguments for the existing dispatch error contract', () => {
    const proposal = call(); proposal.input = undefined;
    expect(captureAgentReadBatch([proposal])[0].input).toBeUndefined();
  });
  it('refuses a whole duplicate or excessive batch before its consumer can dispatch', () => {
    let dispatched = 0;
    for (const batch of [[call(), call()], Array.from({ length: 17 }, (_, i) => ({ ...call(), id: `call_${i}` }))]) {
      expect(() => { const captured = captureAgentReadBatch(batch); dispatched += captured.length; }).toThrow('proposed lookup');
    }
    expect(dispatched).toBe(0);
    expect(captureAgentReadBatch(Array.from({ length: 16 }, (_, i) => ({ ...call(), id: `call_${i}` })))).toHaveLength(16);
  });
  it('does not invoke call, array or argument getters', () => {
    let reads = 0;
    const getter = { get value() { reads++; return 'private'; } };
    const envelope = Object.defineProperty(call(), 'input', { enumerable: true, get() { reads++; return {}; } });
    const array = [call()]; Object.defineProperty(array, '0', { get() { reads++; return call(); } });
    for (const value of [[call(getter)], [envelope], array]) expect(() => captureAgentReadBatch(value)).toThrow();
    expect(reads).toBe(0);
  });
  it('refuses extra capability fields, opaque objects, sparse arrays and non-JSON values', () => {
    for (const value of [new Date(), NaN, Infinity, 1n, () => {}, [undefined], Array(1), { hidden: undefined }]) {
      expect(() => captureAgentReadBatch([call(value)])).toThrow();
    }
    expect(() => captureAgentReadBatch([{ ...call(), session: { roles: ['admin'] } }])).toThrow();
    expect(() => captureAgentReadBatch([])).toThrow();
    expect(() => captureAgentReadBatch([{ ...call(), id: 'bad\n' }])).toThrow();
  });
  it('bounds cyclic/deep data and UTF8 aggregate input bytes', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => captureAgentReadBatch([call(cycle)])).toThrow();
    expect(() => captureAgentReadBatch([call('界'.repeat(12_000))])).toThrow();
    expect(() => captureAgentReadBatch([call(Array.from({ length: 1025 }, () => 1))])).toThrow();
    expect(captureAgentReadBatch([call('valid')])[0].input).toBe('valid');
  });
  it('refuses oversized canonical outputs without partial JSON or silent truncation', () => {
    expect(serializeAgentReadResult({ ok: true, days: '12.00' })).toBe('{"ok":true,"days":"12.00"}');
    expect(() => serializeAgentReadResult({ text: '界'.repeat(23_000) })).toThrow('proposed lookup');
    expect(() => serializeAgentReadResult(undefined)).toThrow();
    expect(AGENT_READ_BATCH_LIMITS.calls).toBe(16);
  });
});
