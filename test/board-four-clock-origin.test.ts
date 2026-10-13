import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ session: vi.fn(async () => null), capture: vi.fn() }));
vi.mock('../lib/attendance-clock-session', () => ({ clockApiSession: calls.session }));
vi.mock('../packs/attendance/service', () => ({
  ownClockReceipt: vi.fn(), captureEmployeeClock: calls.capture,
  ClockConflictError: class extends Error {}, CorrectedClockConflictError: class extends Error {},
  ClockLocationError: class extends Error {}, ClockContextChangedError: class extends Error {},
  AttendancePhotoRequiredError: class extends Error {}, GeolocationRequiredError: class extends Error {},
  OutsideGeofenceError: class extends Error {},
}));
import { POST } from '../app/api/attendance/clock/route';

beforeEach(() => vi.clearAllMocks());
const publicOrigin = 'https://clock.example.test';
const internalUrl = 'https://localhost:3000/api/attendance/clock';

describe('clocking address validation through the real route', () => {
  it('accepts the browser-facing Host even when Next reconstructs its internal localhost URL', async () => {
    const response = await POST(new Request(internalUrl, { method: 'POST', headers: {
      origin: publicOrigin, host: 'clock.example.test', 'x-forwarded-proto': 'https',
    } }));
    // Reaching authentication proves the address guard passed; no employee clocking is fabricated.
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'authentication' });
    expect(calls.session).toHaveBeenCalledOnce();
    expect(calls.capture).not.toHaveBeenCalled();
  });

  it('retains direct same-origin behavior without a separate Host header', async () => {
    const response = await POST(new Request(internalUrl, { method: 'POST', headers: { origin: 'https://localhost:3000' } }));
    expect(response.status).toBe(401);
    expect(calls.session).toHaveBeenCalledOnce();
  });

  it.each<Record<string, string>>([
    { origin: 'https://unrelated.example.test', host: 'clock.example.test' },
    { origin: 'null', host: 'clock.example.test' },
    { host: 'clock.example.test' },
    { origin: 'https://unrelated.example.test', host: 'clock.example.test', 'x-forwarded-host': 'unrelated.example.test' },
  ])('refuses unrelated, absent or opaque origins before authentication: %j', async headers => {
    const response = await POST(new Request(internalUrl, { method: 'POST', headers }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'origin' });
    expect(calls.session).not.toHaveBeenCalled();
    expect(calls.capture).not.toHaveBeenCalled();
  });
});
