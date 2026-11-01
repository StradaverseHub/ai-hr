import * as React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeMobileDesign, DEFAULT_MOBILE_DESIGN, type MobileBuilderState } from '../lib/mobile-design';
import type { MobilePreviewData } from '../components/mobile-preview/types';
import en from '../messages/en.json';
const ports = vi.hoisted(() => ({ save: vi.fn(), upload: vi.fn() }));
vi.mock('../app/mobile-preview/actions', () => ({ changeMobileDesignAction: ports.save, uploadMobileBackgroundAction: ports.upload }));
vi.mock('../components/mobile-preview/mobile-app', () => ({ MobileApp: ({ design, previewAppearance }: any) => <div data-testid="preview" data-background={design.backgrounds?.[previewAppearance] ?? ''} /> }));
import { MobileBuilder } from '../components/mobile-preview/mobile-builder';
const assetId = '11111111-1111-4111-8111-111111111111';
function mount(background = false) {
  const draft = composeMobileDesign(DEFAULT_MOBILE_DESIGN);
  if (background) draft.backgrounds = { dark: assetId, light: null };
  const state: MobileBuilderState = { tenantName: 'Synthetic customer', draft, draftRevision: 0, releases: [] };
  return render(<NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Kuala_Lumpur"><MobileBuilder initial={state} data={{} as MobilePreviewData} /></NextIntlClientProvider>);
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('customer background upload controls', () => {
  it('previews an uploaded background as an unsaved draft without automatically saving or publishing', async () => {
    ports.upload.mockResolvedValueOnce({ ok: true, asset: { id: assetId } });
    mount();
    const file = new File(['synthetic image upload'], 'workplace.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Dark background'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId('preview').getAttribute('data-background')).toBe(assetId));
    expect(ports.upload).toHaveBeenCalledOnce(); expect(ports.upload.mock.calls[0][0].get('file')).toBe(file);
    expect(ports.save).not.toHaveBeenCalled(); expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('retains the current background when an upload is refused', async () => {
    ports.upload.mockResolvedValueOnce({ ok: false, error: 'backgroundInvalid' });
    mount(true);
    fireEvent.change(screen.getByLabelText('Dark background'), { target: { files: [new File(['invalid'], 'bad.png', { type: 'image/png' })] } });
    await screen.findByText(en.mobilePreview.builder.backgroundInvalid);
    expect(screen.getByTestId('preview').getAttribute('data-background')).toBe(assetId); expect(ports.save).not.toHaveBeenCalled();
  });
  it('can return to the default and undo that draft change', () => {
    mount(true); fireEvent.click(screen.getByRole('button', { name: 'Use default city background' }));
    expect(screen.getByTestId('preview').getAttribute('data-background')).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByTestId('preview').getAttribute('data-background')).toBe(assetId); expect(ports.save).not.toHaveBeenCalled();
  });
});
