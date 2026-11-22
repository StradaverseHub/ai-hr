import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import { PrintButton } from '../app/admin/job-descriptions/[id]/print/print-button';
import messages from '../messages/en.json';

it('enables printing when the client handler can receive clicks', async () => {
  const view = (
    <NextIntlClientProvider locale="en" messages={messages}>
      <PrintButton />
    </NextIntlClientProvider>
  );
  const server = document.createElement('div');
  server.innerHTML = renderToStaticMarkup(view);
  expect(server.querySelector('button')).toBeDisabled();

  const print = vi.spyOn(window, 'print').mockImplementation(() => {});
  try {
    render(view);
    const button = screen.getByRole('button', { name: messages.jobDescriptions.print });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(print).toHaveBeenCalledOnce();
  } finally {
    print.mockRestore();
  }
});
