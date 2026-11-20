import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { ClockingImport } from '../app/attendance/import/clocking-import';
import messages from '../messages/en.json';

const { validate } = vi.hoisted(() => ({
  validate: vi.fn(async (_mapping: string, _text: string) => ({ ok: false, error: 'fileTooLarge' })),
}));
vi.mock('../app/attendance/import/actions', () => ({
  validateClockingImportAction: validate,
  commitClockingImportAction: vi.fn(),
}));
vi.mock('../components/assistant/import-handoff', () => ({ useAssistantImportIntake: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

it('accepts the mapping and file on the first interaction after hydration', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"jobs":[]}')));
  const tree = (
    <NextIntlClientProvider locale="en" messages={messages}>
      <ClockingImport mappings={[
        { id: 'default', label: 'Default mapping', encoding: 'utf-8' },
        { id: 'device', label: 'Device mapping', encoding: 'utf-8' },
      ]} />
    </NextIntlClientProvider>
  );
  const host = document.createElement('div');
  document.body.append(host);
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    host.innerHTML = renderToString(tree);
    const form = within(host);
    const mapping = form.getByRole('combobox');
    const dropTarget = form.getByRole('button', { name: /drop.*file/i });
    const fileInput = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(mapping).toBeDisabled();
    expect(fileInput).toBeDisabled();
    expect(dropTarget).toHaveAttribute('aria-disabled', 'true');

    await act(async () => { root = hydrateRoot(host, tree); });
    expect(mapping).toBeEnabled();
    expect(fileInput).toBeEnabled();
    expect(dropTarget).toHaveAttribute('aria-disabled', 'false');
    const user = userEvent.setup();
    await user.selectOptions(mapping, 'device');
    const text = 'card,date,time\n1,2026-11-20,08:00';
    const file = new File([text], 'device.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(text).buffer });
    await user.upload(fileInput, file);
    await screen.findByText(file.name);
    await user.click(form.getByRole('button', { name: 'Validate', exact: true }));
    expect(validate).toHaveBeenCalledExactlyOnceWith('device', text);
  } finally {
    await act(async () => root?.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
