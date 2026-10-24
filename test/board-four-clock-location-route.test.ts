import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const calls = vi.hoisted(() => ({ session: vi.fn(), capture: vi.fn() }));
vi.mock('../lib/attendance-clock-session', () => ({ clockApiSession: calls.session }));
vi.mock('../packs/attendance/service', () => ({
  ownClockReceipt: vi.fn(), captureEmployeeClock: calls.capture,
  ClockConflictError: class extends Error {}, CorrectedClockConflictError: class extends Error {},
  ClockLocationError: class extends Error {}, ClockContextChangedError: class extends Error {},
  AttendancePhotoRequiredError: class extends Error {}, GeolocationRequiredError: class extends Error {},
  OutsideGeofenceError: class extends Error {}, OwnClockEmploymentUnavailableError: class extends Error {},
}));
import { POST } from '../app/api/attendance/clock/route';

beforeEach(() => {
  vi.clearAllMocks();
  calls.session.mockResolvedValue({ userId: 'synthetic-authenticated-user' });
  calls.capture.mockResolvedValue({ direction: 'in', recordedAt: new Date().toISOString() });
});
const body = () => {
  const data = new FormData();
  data.set('action', 'in'); data.set('requestId', randomUUID());
  return data;
};
const post = (data: FormData) => POST(new Request('https://localhost:3000/api/attendance/clock', {
  method: 'POST', headers: { origin: 'https://clock.example.test', host: 'clock.example.test' }, body: data,
}));

describe('explicit optional web-location wire contract', () => {
  it('passes genuine absence to the policy service as three nulls, never zero coordinates', async () => {
    const response = await post(body());
    expect(response.status).toBe(200);
    expect(calls.capture.mock.calls[0][1]).toMatchObject({ lat: null, lng: null, accuracy: null });
  });
  it('retains a complete provided position', async () => {
    const data = body(); data.set('lat', '-3.25'); data.set('lng', '101.75'); data.set('accuracy', '8.5');
    expect((await post(data)).status).toBe(200);
    expect(calls.capture.mock.calls[0][1]).toMatchObject({ lat: -3.25, lng: 101.75, accuracy: 8.5 });
  });
  it.each(['lat', 'lng', 'accuracy'])('refuses a partial position missing %s', async missing => {
    const data = body();
    for (const key of ['lat', 'lng', 'accuracy']) if (key !== missing) data.set(key, '1');
    expect((await post(data)).status).toBe(400);
    expect(calls.capture).not.toHaveBeenCalled();
  });
  it('does not convert blank coordinate cells into zero', async () => {
    const data = body(); for (const key of ['lat', 'lng', 'accuracy']) data.set(key, '');
    expect((await post(data)).status).toBe(400);
    expect(calls.capture).not.toHaveBeenCalled();
  });
  it('refuses duplicated coordinate fields', async () => {
    const data = body(); for (const key of ['lat', 'lng', 'accuracy']) data.set(key, '1'); data.append('lat', '2');
    expect((await post(data)).status).toBe(400);
    expect(calls.capture).not.toHaveBeenCalled();
  });
  it('retains authentication when location is absent', async () => {
    calls.session.mockResolvedValue(null);
    expect((await post(body())).status).toBe(401);
    expect(calls.capture).not.toHaveBeenCalled();
  });
});
