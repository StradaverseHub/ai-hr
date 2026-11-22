import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { ClockingImport } from '../app/attendance/import/clocking-import';
import messages from '../messages/en.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../app/attendance/import/actions', () => ({
  commitClockingImportAction: vi.fn(),
  validateClockingImportAction: vi.fn(),
}));

afterEach(() => vi.unstubAllGlobals());

it('enables Clocking Import controls when they can receive a file', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ jobs: [] }) }));
  const view = (
    <NextIntlClientProvider locale="en" messages={messages}>
      <ClockingImport mappings={[{ id: 'fictional-mapping', label: 'Fixture mapping', encoding: 'utf-8' }]} />
    </NextIntlClientProvider>
  );
  const server = document.createElement('div');
  server.innerHTML = renderToStaticMarkup(view);
  expect(server.querySelector('select')).toBeDisabled();
  expect(server.querySelector('input[type="file"]')).toBeDisabled();
  expect(server.querySelector('button:has(svg)')).toBeDisabled();

  const { container } = render(view);
  expect(screen.getByRole('combobox')).toBeEnabled();
  expect(screen.getByRole('button', { name: new RegExp(messages.clockingFile.import.dropFile) })).toBeEnabled();
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).toBeEnabled();

  const file = new File(['card,time\n'], 'fictional-clockings.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new TextEncoder().encode('card,time\n').buffer,
  });
  await userEvent.upload(input!, file);
  expect(await screen.findByText(file.name)).toBeVisible();
  expect(screen.getByRole('button', { name: messages.clockingFile.import.validate })).toBeEnabled();
});
