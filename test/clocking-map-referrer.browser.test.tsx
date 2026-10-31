import '../app/globals.css';
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { ClockingMap } from '../app/(app)/admin/work-locations/clocking/clocking-map';
import { OSM_PROVIDER } from '../app/(app)/admin/work-locations/clocking/map-provider';

// Exercise real Leaflet createTile in a browser, without contacting public map servers.
const tile = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e5efdb"/></svg>');
let policy: HTMLMetaElement | undefined;
afterEach(() => { cleanup(); policy?.remove(); policy = undefined; });

function mount(tileUrl: string) {
  policy = document.createElement('meta');
  policy.name = 'referrer';
  policy.content = 'same-origin';
  document.head.append(policy);
  return render(
    <NextIntlClientProvider locale="en" timeZone="Asia/Kuala_Lumpur" messages={messages}>
      <form style={{ width: 800 }}>
        <input name="lat" defaultValue="3.139" />
        <input name="lng" defaultValue="101.6869" />
        <input name="radiusM" defaultValue="150" />
        <ClockingMap provider={{ ...OSM_PROVIDER, tileUrl }} />
      </form>
    </NextIntlClientProvider>,
  );
}

it('real Leaflet images override a same-origin document policy and retain the point/radius', async () => {
  const { container } = mount(tile);
  await waitFor(() => {
    const images = [...container.querySelectorAll<HTMLImageElement>('img.leaflet-tile')];
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image.referrerPolicy).toBe('strict-origin-when-cross-origin');
      expect(image.naturalWidth).toBe(256);
    }
    expect(container.querySelector('.leaflet-marker-pane span')).not.toBeNull();
    expect(container.querySelector('.leaflet-overlay-pane path')).not.toBeNull();
  }, { timeout: 5000 });
});

it('real image failures show the fallback while coordinates stay editable', async () => {
  const { container } = mount('/map-test-missing-tile/{z}/{x}/{y}.png');
  // An import failure also renders the fallback: require real tile elements first.
  await waitFor(() => expect(container.querySelector('img.leaflet-tile')).not.toBeNull(), { timeout: 5000 });
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('The map could not be loaded'), { timeout: 5000 });
  expect(container.querySelector<HTMLInputElement>('[name="lat"]')?.value).toBe('3.139');
  expect(container.querySelector<HTMLInputElement>('[name="radiusM"]')?.value).toBe('150');
});
