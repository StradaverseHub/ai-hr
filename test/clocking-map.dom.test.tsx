/**
 * fa2db8cb rev 2 (r279) — THE TWO CLOCKING-LOCATION ISLANDS, MOUNTED.
 *
 * The source-shape half of this round is in test/clocking-map.test.ts; this file drives the behaviour
 * the reporter actually asked for, in a real DOM:
 *
 *   • the circle follows the radius box LIVE, so 100 m can be seen to cover the office and not the car
 *     park next door — which is the entire reason the item exists;
 *   • the address search runs ON SUBMIT ONLY (the free geocoder's usage policy forbids
 *     search-as-you-type) and neither the Search button nor Enter submits the enclosing form;
 *   • picking a result fills address, latitude and longitude and LEAVES THEM EDITABLE;
 *   • the Satellite control renders DISABLED with no key, and genuinely swaps the tile source when a
 *     satellite URL is configured — proving the disabled state is the seam reporting, not a hardcoded
 *     dead button.
 *
 * ⚠️ THE HARNESS BUILDS ITS INPUTS FROM `CLOCKING_FIELDS`, not from a hand-copied list. The islands find
 * the fields through the enclosing <form> (app/admin/locations/clocking/form-bridge.ts), so a test form
 * whose field names had drifted from the real one would pass while the screen was broken.
 *
 * ⚠️ LEAFLET IS FAKED. The real library wants a layout engine jsdom does not have, and the point here is
 * not that Leaflet draws circles — it is that THIS code asks it to, with the right centre and the right
 * radius in metres, at the right moments. The fake records the asks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { ClockingAddressSearch } from '../app/admin/locations/clocking/address-search';
import { ClockingMap } from '../app/admin/locations/clocking/clocking-map';
import { OSM_PROVIDER, type MapProvider } from '../app/admin/locations/clocking/map-provider';
import { CLOCKING_FIELDS } from '../app/admin/locations/clocking/form-fields';

type FakeState = {
  mapOptions: Record<string, unknown> | null;
  tileUrls: string[];
  marker: { latLng: [number, number] | null; onMap: boolean } | null;
  circle: { latLng: [number, number] | null; radius: number; onMap: boolean } | null;
  views: [number, number][];
  fits: number;
  invalidated: number;
  removed: number;
};

vi.mock('leaflet', () => {
  const state: FakeState = {
    mapOptions: null,
    tileUrls: [],
    marker: null,
    circle: null,
    views: [],
    fits: 0,
    invalidated: 0,
    removed: 0,
  };
  let onMap = new Set<object>();

  const mapApi = {
    hasLayer: (l: object) => onMap.has(l),
    setView(ll: { lat: number; lng: number }) {
      state.views.push([ll.lat, ll.lng]);
      return mapApi;
    },
    fitBounds() {
      state.fits += 1;
      return mapApi;
    },
    getZoom: () => 14,
    invalidateSize() {
      state.invalidated += 1;
    },
    remove() {
      state.removed += 1;
    },
  };

  const leaflet = {
    map(_el: unknown, options: Record<string, unknown>) {
      state.mapOptions = options;
      return mapApi;
    },
    tileLayer(url: string, _options: unknown) {
      state.tileUrls.push(url);
      const layer = {
        addTo: () => layer,
        setUrl(next: string) {
          state.tileUrls.push(next);
          return layer;
        },
      };
      return layer;
    },
    divIcon: (o: unknown) => o,
    latLng: (lat: number, lng: number) => ({ lat, lng }),
    marker(start: [number, number]) {
      const rec = { latLng: start, onMap: false };
      state.marker = rec;
      const m = {
        setLatLng(ll: { lat: number; lng: number }) {
          rec.latLng = [ll.lat, ll.lng];
          return m;
        },
        addTo() {
          onMap.add(m);
          rec.onMap = true;
          return m;
        },
        remove() {
          onMap.delete(m);
          rec.onMap = false;
          return m;
        },
      };
      return m;
    },
    circle(start: [number, number], options: { radius: number }) {
      const rec = { latLng: start, onMap: false, radius: options.radius };
      state.circle = rec;
      const c = {
        setLatLng(ll: { lat: number; lng: number }) {
          rec.latLng = [ll.lat, ll.lng];
          return c;
        },
        setRadius(r: number) {
          rec.radius = r;
          return c;
        },
        getBounds: () => ({ kind: 'bounds' }),
        addTo() {
          onMap.add(c);
          rec.onMap = true;
          return c;
        },
        remove() {
          onMap.delete(c);
          rec.onMap = false;
          return c;
        },
      };
      return c;
    },
  };

  return {
    default: leaflet,
    __state: state,
    __reset() {
      onMap = new Set<object>();
      Object.assign(state, {
        mapOptions: null,
        tileUrls: [],
        marker: null,
        circle: null,
        views: [],
        fits: 0,
        invalidated: 0,
        removed: 0,
      });
    },
  };
});

import * as leafletModule from 'leaflet';
const fake = leafletModule as unknown as { __state: FakeState; __reset: () => void };

/** A point that is NOT the island's fallback centre, so "the marker moved" cannot pass by accident. */
const PENANG = { lat: '5.4141', lng: '100.3288' } as const;

const messages = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../messages/en.json'), 'utf8')) as Record<string, unknown>;

/** The provider a paid account would produce — the ONLY difference that matters here is the satellite URL. */
const KEYED: MapProvider = {
  ...OSM_PROVIDER,
  id: 'configured',
  tileUrl: 'https://tiles.example/{z}/{x}/{y}.png?key=K3Y',
  attribution: '© Example Maps',
  satelliteTileUrl: 'https://tiles.example/sat/{z}/{x}/{y}.jpg?key=K3Y',
  satelliteAttribution: '© Example Maps',
};

const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());

function Harness({ provider }: { provider: MapProvider }) {
  return (
    <NextIntlClientProvider locale="en" timeZone="Asia/Kuala_Lumpur" messages={messages}>
      <form onSubmit={onSubmit}>
        <ClockingAddressSearch provider={provider} />
        {CLOCKING_FIELDS.map((f) =>
          f === 'address' ? (
            <textarea key={f} name={f} aria-label={f} defaultValue="" />
          ) : (
            <input key={f} name={f} aria-label={f} defaultValue="" />
          ),
        )}
        <ClockingMap provider={provider} />
        <button type="submit">Save</button>
      </form>
    </NextIntlClientProvider>
  );
}

const boxes = () => ({
  address: screen.getByLabelText('address') as HTMLTextAreaElement,
  lat: screen.getByLabelText('lat') as HTMLInputElement,
  lng: screen.getByLabelText('lng') as HTMLInputElement,
  radiusM: screen.getByLabelText('radiusM') as HTMLInputElement,
});
/** Type into a box the way a person does: a native, bubbling `input`, which is what the map listens for. */
const typeInto = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => fireEvent.input(el, { target: { value } });
const mapReady = () => waitFor(() => expect(fake.__state.mapOptions).not.toBeNull());

beforeEach(() => {
  fake.__reset();
  onSubmit.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fa2db8cb rev 2 — the map: a marker, the radius as a circle, and a Satellite control that tells the truth', () => {
  it('with NO key the Satellite control renders, is DISABLED, and says why — the map still draws', async () => {
    render(<Harness provider={OSM_PROVIDER} />);
    await mapReady();

    const satellite = screen.getByRole('button', { name: 'Satellite' });
    expect(satellite, 'rendered, not dropped').toBeInTheDocument();
    expect(satellite).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Map' })).toBeEnabled();
    expect(screen.getByText(/Satellite view is off/)).toBeInTheDocument();
    expect(screen.getByText('© OpenStreetMap contributors'), 'attribution is always visible').toBeInTheDocument();
    expect(fake.__state.tileUrls[0]).toBe(OSM_PROVIDER.tileUrl);
    expect(fake.__state.mapOptions?.attributionControl, 'ours is rendered instead, so it survives Leaflet not loading').toBe(false);
  });

  it('the SAME control is enabled and genuinely swaps the tile source once the seam reports a satellite URL', async () => {
    const user = userEvent.setup();
    render(<Harness provider={KEYED} />);
    await mapReady();

    const satellite = screen.getByRole('button', { name: 'Satellite' });
    expect(satellite, 'the disabled state is the SEAM reporting, not a dead button').toBeEnabled();
    expect(screen.queryByText(/Satellite view is off/)).toBeNull();
    expect(screen.getByText('© Example Maps')).toBeInTheDocument();

    await user.click(satellite);
    await waitFor(() => expect(fake.__state.tileUrls.at(-1)).toBe(KEYED.satelliteTileUrl));
    await user.click(screen.getByRole('button', { name: 'Map' }));
    await waitFor(() => expect(fake.__state.tileUrls.at(-1)).toBe(KEYED.tileUrl));
    expect(onSubmit, 'a view control never posts the form').not.toHaveBeenCalled();
  });

  it('the circle follows the radius box LIVE, in metres, and the boxes stay the thing that gets saved', async () => {
    render(<Harness provider={OSM_PROVIDER} />);
    await mapReady();
    const b = boxes();

    // Nothing typed yet: no point to draw, and the map says so rather than inventing one.
    expect(fake.__state.marker?.onMap ?? false).toBe(false);
    expect(screen.getByText(/Enter a latitude and longitude/)).toBeInTheDocument();

    // ⚠️ NOT Kuala Lumpur: the island opens on KL when the boxes are empty, so asserting a KL point had
    // moved the marker would pass on the fallback centre alone. Penang is the point nothing defaults to.
    typeInto(b.lat, PENANG.lat);
    typeInto(b.lng, PENANG.lng);
    await waitFor(() => expect(fake.__state.marker?.onMap).toBe(true));
    expect(fake.__state.marker?.latLng).toEqual([Number(PENANG.lat), Number(PENANG.lng)]);

    typeInto(b.radiusM, '150');
    await waitFor(() => expect(fake.__state.circle?.radius).toBe(150));
    expect(fake.__state.circle?.onMap, 'a radius that exists is drawn').toBe(true);
    expect(fake.__state.circle?.latLng).toEqual([Number(PENANG.lat), Number(PENANG.lng)]);

    typeInto(b.radiusM, '400');
    await waitFor(() => expect(fake.__state.circle?.radius).toBe(400));

    // Clearing the radius removes the circle rather than drawing a default nobody typed.
    typeInto(b.radiusM, '');
    await waitFor(() => expect(fake.__state.circle?.onMap).toBe(false));

    // ⚠️ The island owns the PICTURE, never the VALUES: the raw strings are exactly what was typed, so a
    // refused save can still echo them back and a person can still type coordinates by hand.
    expect(b.lat.value).toBe(PENANG.lat);
    expect(b.lng.value).toBe(PENANG.lng);
    expect(b.radiusM.value).toBe('');
  });

  it('a half-typed or out-of-range coordinate draws nothing — it is not a location yet', async () => {
    render(<Harness provider={OSM_PROVIDER} />);
    await mapReady();
    const b = boxes();
    typeInto(b.lat, PENANG.lat);
    typeInto(b.lng, PENANG.lng);
    await waitFor(() => expect(fake.__state.marker?.onMap).toBe(true));

    // '3.' is deliberately absent: Number('3.') is 3, so it IS a latitude and drawing it is correct.
    for (const junk of ['', '-', 'north-ish', '95']) {
      typeInto(b.lat, junk);
      await waitFor(() => expect(fake.__state.marker?.onMap, `${JSON.stringify(junk)} is not a latitude`).toBe(false));
      typeInto(b.lat, PENANG.lat);
      await waitFor(() => expect(fake.__state.marker?.onMap).toBe(true));
    }
  });
});

describe('fa2db8cb rev 2 — the address search: on submit only, and it fills in three boxes it does not own', () => {
  const hit = { display_name: 'Menara KL, Jalan Punchak, Kuala Lumpur', lat: '3.1528', lon: '101.7038' };

  it('typing starts NO request — the free geocoder forbids search-as-you-type', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness provider={OSM_PROVIDER} />);

    await user.type(screen.getByLabelText('Find an address'), 'Menara KL');
    // Well past any debounce a future round might be tempted to add.
    await new Promise((r) => setTimeout(r, 400));
    expect(fetchMock, 'not one request until Search is pressed').not.toHaveBeenCalled();
  });

  it('Search fetches once, the result fills address / lat / lng, and the map reframes on the new point', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [hit] });
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness provider={OSM_PROVIDER} />);
    await mapReady();
    // A radius is already typed, as it would be: the reframe the reporter asked for is the CIRCLE being
    // brought into view, which is what `fitBounds` is and what `setView` on a bare point is not.
    typeInto(boxes().radiusM, '150');
    const fitsBefore = fake.__state.fits;

    await user.type(screen.getByLabelText('Find an address'), 'Menara KL');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    const result = await screen.findByRole('button', { name: /Menara KL, Jalan Punchak/ });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0]), 'the query is encoded, once').toContain('q=Menara%20KL');
    expect(onSubmit, 'Search is not a submit button').not.toHaveBeenCalled();

    await user.click(result);
    const b = boxes();
    expect(b.address.value).toBe(hit.display_name);
    expect(b.lat.value).toBe('3.1528');
    expect(b.lng.value).toBe('101.7038');
    await waitFor(() => expect(fake.__state.marker?.latLng).toEqual([3.1528, 101.7038]));
    expect(fake.__state.fits, 'a picked result REFRAMES rather than merely nudging').toBeGreaterThan(fitsBefore);

    // Still editable afterwards — the search fills the boxes in, it does not take them over.
    typeInto(b.lat, '4.2105');
    await waitFor(() => expect(fake.__state.marker?.latLng).toEqual([4.2105, 101.7038]));
    expect(b.lat.value).toBe('4.2105');
  });

  it('Enter in the box searches and does NOT post the half-filled form', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [hit] });
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness provider={OSM_PROVIDER} />);

    await user.type(screen.getByLabelText('Find an address'), 'Menara KL{Enter}');
    await screen.findByRole('button', { name: /Menara KL, Jalan Punchak/ });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onSubmit, 'Enter in a text box submits a form by default — this one preventDefaults first').not.toHaveBeenCalled();
  });

  it('an empty box, no match, and a supplier that is simply down each say so and touch nothing', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness provider={OSM_PROVIDER} />);
    const search = screen.getByRole('button', { name: 'Search' });

    await user.click(search);
    expect(await screen.findByText('Type an address to search for.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    await user.type(screen.getByLabelText('Find an address'), 'nowhere at all');
    await user.click(search);
    expect(await screen.findByText(/No match found/)).toBeInTheDocument();

    // No availability guarantee is one of the three things the plan told the reporter to expect.
    fetchMock.mockRejectedValue(new Error('offline'));
    await user.click(search);
    expect(await screen.findByText(/Address search is unavailable right now/)).toBeInTheDocument();

    const b = boxes();
    expect([b.address.value, b.lat.value, b.lng.value], 'a failed search writes nothing').toEqual(['', '', '']);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
