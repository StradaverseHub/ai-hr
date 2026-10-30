import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EmailDefinition } from '../app/lifecycle/v9/email-definition';
import type { EmailAsset, EmailTemplate } from '../lib/lifecycle-v9-model';
const image: EmailAsset = { id: '9ea43e78-c325-4f88-8313-1b6fc3a1a78e', kind: 'image', name: 'Fictional logo.png', mimeType: 'image/png', size: 20, contentHash: 'a'.repeat(64), at: '2026-10-29T00:00:00Z', by: 'Fictional HR' };
const file: EmailAsset = { ...image, id: '9ea43e78-c325-4f88-8313-1b6fc3a1a78f', kind: 'file', name: 'Fictional handbook.txt', mimeType: 'text/plain' };
const initial: EmailTemplate = { id: 'email', name: 'Fictional email', module: 'onb', active: false, sender: 'onboarding', subject: 'Welcome', body: 'Dear colleague,', cc: [], links: [], attachments: [], slots: [] };
function Harness({ ready = true }: { ready?: boolean }) { const [email,setEmail] = useState(initial); return <><EmailDefinition email={email} templates={[]} disabled={false} revision={1} uploadsReady={ready} change={change=>setEmail(current=>{ const next=structuredClone(current); change(next); return next; })}/><output data-testid="email">{JSON.stringify(email)}</output></>; }
const current = () => JSON.parse(screen.getByTestId('email').textContent!) as EmailTemplate;
afterEach(()=>vi.unstubAllGlobals());
it('links the actual upload receipt without replacing the email body or per-person slots', async () => {
  const fetcher = vi.fn(async()=>({ ok: true, json: async()=>({ asset: file }) })); vi.stubGlobal('fetch',fetcher);
  render(<Harness/>);
  fireEvent.change(screen.getByLabelText('Upload a shared file'),{ target: { files: [new File(['Fictional handbook'],'Fictional handbook.txt',{type:'text/plain'})] } });
  await waitFor(()=>expect(current().files).toEqual([file]));
  expect(current().body).toBe('Dear colleague,'); expect(current().slots).toEqual([]);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('/lifecycle/v9/email-assets',expect.objectContaining({ method: 'POST', body: expect.any(FormData) }));
  expect(screen.getByRole('link',{name:file.name})).toHaveAttribute('href',`/lifecycle/v9/email-assets/${file.id}`);
  fireEvent.click(screen.getByRole('button',{name:`Remove file ${file.name}`})); expect(current().files).toEqual([]);
});
it('inserts and removes the source inline-image token without exposing a public asset URL', async () => {
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({asset:image})})));
  render(<Harness/>); fireEvent.change(screen.getByLabelText('Add image'),{target:{files:[new File(['Fictional image'],'Fictional logo.png',{type:'image/png'})]}});
  await waitFor(()=>expect(current().images).toEqual([image]));
  expect(screen.getByRole('img',{name:image.name})).toHaveAttribute('src',`/lifecycle/v9/email-assets/${image.id}`);
  fireEvent.click(screen.getByRole('button',{name:`Insert ${image.name}`})); expect(current().body).toBe(`Dear colleague,\n\n{image:${image.id}}\n`);
  fireEvent.click(screen.getByRole('button',{name:`Remove image ${image.name}`})); expect(current().images).toEqual([]); expect(current().body).not.toContain('{image:');
});
it('waits for saved settings and retains the existing content on an upload error', async () => {
  const fetcher=vi.fn(async()=>({ok:false,json:async()=>({error:'Controlled upload failure'})}));vi.stubGlobal('fetch',fetcher);
  const view=render(<Harness ready={false}/>);expect(screen.getByLabelText('Add image')).toBeDisabled();expect(screen.getByLabelText('Upload a shared file')).toBeDisabled();
  view.rerender(<Harness/>);fireEvent.change(screen.getByLabelText('Upload a shared file'),{target:{files:[new File(['Fictional'],'Fictional.txt')]}});
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Controlled upload failure'));
  expect(current().body).toBe('Dear colleague,');expect(current().files).toBeUndefined();
});
it('rejects unsupported or oversized inline images before starting a request', () => {
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);render(<Harness/>);
  fireEvent.change(screen.getByLabelText('Add image'),{target:{files:[new File(['<svg/>'],'script.svg')]}});expect(screen.getByRole('alert')).toHaveTextContent('PNG, JPG, GIF or WebP');
  fireEvent.change(screen.getByLabelText('Add image'),{target:{files:[new File([new Uint8Array(1048577)],'large.png')]}});expect(screen.getByRole('alert')).toHaveTextContent('1 MB');expect(fetcher).not.toHaveBeenCalled();
});
