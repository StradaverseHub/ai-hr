import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { SlideConfirm } from '../components/mobile-preview/slide-confirm';
import { ClockCard } from '../components/mobile-preview/clock-card';
import { useMobileClock } from '../components/mobile-preview/use-mobile-clock';
import '../app/globals.css';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const receipt = (direction = 'in') => ({ receipt: { id: 'server-capture', direction, date: '2026-10-09', recordedAt: '2026-10-09T01:23:45Z' } });
const policy = (setting = 'not_required', locationValid = true) => ({ attendancePhotoSetting: setting, locationValid });
const provider = (ui: React.ReactNode) => <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Kuala_Lumpur"><div style={{ width: 320 }}>{ui}</div></NextIntlClientProvider>;
const recorded = vi.fn();
function App({ clockedIn = false }: { clockedIn?: boolean }) {
  const capture = useMobileClock(recorded);
  return <ClockCard clock={{ date: '2026-10-09', clockedIn, shiftStart: '09:00', shiftEnd: '18:00', events: clockedIn ? [{ direction: 'in', time: '08:54' }] : [] }}
    company="Synthetic Employer" layout="flow" capture={capture} onHistory={() => {}} showBothActions />;
}
function mount(clockedIn = false) { return render(provider(<App clockedIn={clockedIn} />)); }
function finish(ui: ReturnType<typeof render>, direction: 'in' | 'out' = 'in') {
  const slider = ui.getByRole('slider', { name: direction === 'in' ? 'Slide to clock in' : 'Slide to confirm OUT' });
  fireEvent.keyDown(slider, { key: 'End' }); fireEvent.keyDown(slider, { key: 'Enter' });
}
beforeEach(() => {
  recorded.mockClear();
  vi.spyOn(navigator.geolocation, 'getCurrentPosition').mockImplementation(success => success({ coords: { latitude: 3.15, longitude: 101.71, accuracy: 8 } } as GeolocationPosition));
});

describe('Monolith deliberate confirmation gesture', () => {
  it('does not confirm on track click, partial drag, cancellation, or reaching the end without confirmation', () => {
    const confirm = vi.fn(), ui = render(provider(<SlideConfirm direction="in" onConfirm={confirm} />));
    const slider = ui.getByRole('slider'), track = slider.parentElement!;
    vi.spyOn(slider, 'setPointerCapture').mockImplementation(() => {});
    fireEvent.click(track); expect(confirm).not.toHaveBeenCalled();
    const left = slider.getBoundingClientRect().left;
    fireEvent.pointerDown(slider, { button: 0, pointerId: 1, clientX: left, isPrimary: true });
    fireEvent.pointerMove(slider, { pointerId: 1, clientX: left + 40 });
    fireEvent.pointerUp(slider, { pointerId: 1, clientX: left + 40 });
    expect(slider.getAttribute('aria-valuenow')).toBe('0'); expect(confirm).not.toHaveBeenCalled();
    fireEvent.pointerDown(slider, { button: 0, pointerId: 2, clientX: left, isPrimary: true });
    fireEvent.pointerMove(slider, { pointerId: 2, clientX: left + 500 });
    fireEvent.pointerCancel(slider, { pointerId: 2 }); expect(confirm).not.toHaveBeenCalled();
    fireEvent.keyDown(slider, { key: 'End' }); expect(confirm).not.toHaveBeenCalled();
    fireEvent.keyDown(slider, { key: 'Escape' }); expect(slider.getAttribute('aria-valuenow')).toBe('0');
    fireEvent.keyDown(slider, { key: 'Enter' }); expect(confirm).not.toHaveBeenCalled();
    fireEvent.keyDown(slider, { key: 'End' }); fireEvent.keyDown(slider, { key: 'Enter' });
    fireEvent.keyDown(slider, { key: 'Enter' }); expect(confirm).toHaveBeenCalledTimes(1);
  });
  it('ignores a second pointer and confirms once on a full thumb drag; the tap alternative is equivalent', () => {
    const confirm = vi.fn(), ui = render(provider(<SlideConfirm direction="out" onConfirm={confirm} />));
    const slider = ui.getByRole('slider'); vi.spyOn(slider, 'setPointerCapture').mockImplementation(() => {});
    fireEvent.pointerDown(slider, { button: 0, pointerId: 1, clientX: 0, isPrimary: true });
    fireEvent.pointerMove(slider, { pointerId: 2, clientX: 500 });
    fireEvent.pointerUp(slider, { pointerId: 2, clientX: 500 }); expect(confirm).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider, { pointerId: 1, clientX: 500 }); expect(confirm).toHaveBeenCalledTimes(1);
    fireEvent.click(ui.getByRole('button', { name: 'Confirm clock-out with a tap' })); expect(confirm).toHaveBeenCalledTimes(1);
  });
});

describe('Real attendance through the existing server contract', () => {
  it('waits for a server receipt, sends no employee selector or client clock, and does not claim a photo was saved', async () => {
    let resolve!: (value: Response) => void;
    const post = new Promise<Response>(r => { resolve = r; });
    const fetcher = vi.fn((url: string, options?: RequestInit) => options?.method === 'POST' ? post : Promise.resolve(response(policy())));
    vi.stubGlobal('fetch', fetcher);
    const ui = mount(); finish(ui);
    await ui.findByText('Waiting for server confirmation…');
    expect(ui.queryByText('Confirmed by the server')).toBeNull(); expect(recorded).not.toHaveBeenCalled();
    const calls = fetcher.mock.calls.filter(([, options]) => options?.method === 'POST'); expect(calls).toHaveLength(1);
    const body = calls[0][1]!.body as FormData;
    expect([...body.keys()].sort()).toEqual(['accuracy', 'action', 'lat', 'lng', 'requestId']);
    expect(body.get('action')).toBe('in'); expect(body.get('requestId')).toMatch(/^[0-9a-f-]{36}$/);
    resolve(response(receipt())); await ui.findByText('Confirmed by the server');
    expect(ui.getByText('Clock-in recorded at 09:23:45.')).toBeTruthy();
    expect(ui.container.textContent).not.toContain('photo saved'); expect(recorded).toHaveBeenCalledTimes(1);
  });
  it('reviews clock-out without submitting, cancels to the same live record, then submits out explicitly', async () => {
    const fetcher = vi.fn((url: string, options?: RequestInit) => Promise.resolve(response(options?.method === 'POST' ? receipt('out') : policy())));
    vi.stubGlobal('fetch', fetcher);
    const ui = mount(true); fireEvent.click(ui.getByRole('button', { name: 'Finish my workday' }));
    expect(ui.getByText('Finish your day.')).toBeTruthy(); expect(ui.getByText('08:54')).toBeTruthy();
    fireEvent.click(ui.getByRole('button', { name: 'Keep working' })); expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(ui.getByRole('button', { name: 'Finish my workday' })); finish(ui, 'out');
    await ui.findByText('Clock-out recorded at 09:23:45.');
    expect((fetcher.mock.calls.find(([, options]) => options?.method === 'POST')![1]!.body as FormData).get('action')).toBe('out');
  });
  it.each(['network', 'server', 'malformed'])('retains one immutable request after an uncertain %s response', async mode => {
    const bodies: FormData[] = [];
    const fetcher = vi.fn((url: string, options?: RequestInit) => {
      if (options?.method !== 'POST') return Promise.resolve(response(policy()));
      bodies.push(options.body as FormData);
      if (bodies.length > 1) return Promise.resolve(response(receipt()));
      return mode === 'network' ? Promise.reject(new Error('lost connection')) : Promise.resolve(response(mode === 'server' ? {} : { receipt: { direction: 'in' } }, mode === 'server' ? 503 : 200));
    });
    vi.stubGlobal('fetch', fetcher);
    const ui = mount(); finish(ui); await ui.findByRole('alert');
    expect(ui.queryByText('Confirmed by the server')).toBeNull(); expect(recorded).not.toHaveBeenCalled();
    const before = fetcher.mock.calls.length;
    fireEvent.click(ui.getByRole('button', { name: 'Retry the same punch' })); await ui.findByText('Confirmed by the server');
    expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]); expect(fetcher.mock.calls.length).toBe(before + 1);
    expect(navigator.geolocation.getCurrentPosition).toHaveBeenCalledTimes(1);
  });
  it('a definitive refusal starts a fresh request only after another explicit retry', async () => {
    const ids: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
      if (options?.method !== 'POST') return Promise.resolve(response(policy()));
      ids.push(String((options.body as FormData).get('requestId')));
      return Promise.resolve(response(ids.length === 1 ? { error: 'outsideGeofence' } : receipt(), ids.length === 1 ? 400 : 200));
    }));
    const ui = mount(); finish(ui); await ui.findByRole('alert'); expect(ids).toHaveLength(1);
    fireEvent.click(ui.getByRole('button', { name: 'Try again' })); await ui.findByText('Confirmed by the server');
    expect(ids).toHaveLength(2); expect(ids[1]).not.toBe(ids[0]);
  });
  it.each(['authentication', 'outside', 'location'])('fails closed on %s before posting a punch', async mode => {
    if (mode === 'location') vi.mocked(navigator.geolocation.getCurrentPosition).mockImplementation((success, failure) => failure?.({ code: 1 } as GeolocationPositionError));
    const fetcher = vi.fn((url: string, options?: RequestInit) => Promise.resolve(response(mode === 'authentication' ? {} : policy('not_required', mode !== 'outside'), mode === 'authentication' ? 401 : 200)));
    vi.stubGlobal('fetch', fetcher);
    const ui = mount(); finish(ui); await ui.findByRole('alert');
    expect(fetcher.mock.calls.every(call => !(call[1] as RequestInit | undefined)?.method)).toBe(true);
    expect(recorded).not.toHaveBeenCalled(); expect(ui.queryByText('Confirmed by the server')).toBeNull();
  });
  it('optional photos require an explicit choice, and a changed required-photo policy still refuses a skip', async () => {
    let read = 0;
    const fetcher = vi.fn((url: string, options?: RequestInit) => {
      expect(options?.method).not.toBe('POST'); return Promise.resolve(response(policy(++read === 1 ? 'optional' : 'required')));
    });
    vi.stubGlobal('fetch', fetcher);
    const ui = mount(); finish(ui); await ui.findByText(en.attendance.clock.photoOptionalPrompt);
    expect(navigator.geolocation.getCurrentPosition).not.toHaveBeenCalled();
    fireEvent.click(ui.getByRole('button', { name: en.attendance.clock.skipPhoto })); await ui.findByRole('alert');
    expect(recorded).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('a required photo cannot be bypassed by camera refusal', async () => {
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockRejectedValue(new Error('denied'));
    const fetcher = vi.fn(() => Promise.resolve(response(policy('required')))); vi.stubGlobal('fetch', fetcher);
    const ui = mount(); finish(ui); await ui.findByRole('alert');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(recorded).not.toHaveBeenCalled();
  });
  it('keeps the same photo and request on retry, stops the camera, and releases the preview URL', async () => {
    const stop = vi.fn(), track = { stop }, stream = new MediaStream();
    vi.spyOn(stream, 'getTracks').mockReturnValue([track as unknown as MediaStreamTrack]);
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(stream);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const photo = new Blob(['synthetic-photo'], { type: 'image/jpeg' });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(photo));
    const revoke = vi.spyOn(URL, 'revokeObjectURL'), bodies: FormData[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
      if (options?.method !== 'POST') return Promise.resolve(response(policy('required')));
      bodies.push(options.body as FormData);
      return bodies.length === 1 ? Promise.reject(new Error('uncertain')) : Promise.resolve(response(receipt()));
    }));
    const ui = mount(); finish(ui);
    const video = await ui.findByLabelText(en.attendance.clock.liveFront);
    Object.defineProperties(video, { videoWidth: { value: 640 }, videoHeight: { value: 480 } });
    fireEvent.click(ui.getByRole('button', { name: en.attendance.clock.takePhoto }));
    await ui.findByAltText(en.attendance.clock.photoReview); expect(stop).toHaveBeenCalledTimes(1);
    finish(ui); await ui.findByRole('alert'); fireEvent.click(ui.getByRole('button', { name: 'Retry the same punch' }));
    await ui.findByText('Confirmed by the server'); expect(bodies[1]).toBe(bodies[0]);
    expect(await (bodies[0].get('photo') as Blob).text()).toBe('synthetic-photo');
    await waitFor(() => expect(revoke).toHaveBeenCalled());
  });
  it('stops a camera acquired after the preview unmounts and never submits it', async () => {
    let resolve!: (stream: MediaStream) => void;
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(() => new Promise(r => { resolve = r; }));
    const fetcher = vi.fn(() => Promise.resolve(response(policy('required')))); vi.stubGlobal('fetch', fetcher);
    const ui = mount(); finish(ui); await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());
    ui.unmount(); const stop = vi.fn(); resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await waitFor(() => expect(stop).toHaveBeenCalled()); expect(fetcher).toHaveBeenCalledTimes(1); expect(recorded).not.toHaveBeenCalled();
  });
});
