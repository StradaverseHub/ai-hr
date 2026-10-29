import { expect, it } from 'vitest';
import { v9EmailContent, v9ImageCid, v9ImageTokens } from '../lib/lifecycle-v9-email-content';
import type { EmailAsset } from '../lib/lifecycle-v9-model';
const image: EmailAsset = { id: '9ea43e78-c325-4f88-8313-1b6fc3a1a78e', kind: 'image', name: 'Fictional logo "safe".png', mimeType: 'image/png', size: 69, contentHash: 'a'.repeat(64), at: '2026-10-29T00:00:00Z', by: 'Fictional HR' };
it('keeps ordinary messages plain and renders only owned image tokens as CID elements', () => {
  expect(v9EmailContent('Plain message\nSecond line', [])).toEqual({ text: 'Plain message\nSecond line' });
  const body = `<script>unsafe()</script>\n{image:${image.id}}\n{image:${image.id}}`;
  expect(v9ImageTokens(body)).toEqual([image.id]);
  const content = v9EmailContent(body,[image]);
  expect(content.text).toBe('<script>unsafe()</script>\n[Image: Fictional logo "safe".png]\n[Image: Fictional logo "safe".png]');
  expect(content.html).toContain('&lt;script&gt;unsafe()&lt;/script&gt;'); expect(content.html).not.toContain('<script>');
  expect(content.html).toContain(`src="cid:${v9ImageCid(image.id)}"`); expect(content.html).toContain('alt="Fictional logo &quot;safe&quot;.png"');
  expect(content.html).not.toContain('src="https:');
});
it('refuses missing or external image references rather than fetching them', () => {
  expect(() => v9EmailContent('{image:missing}',[image])).toThrow('unavailable');
  expect(() => v9EmailContent('{image:https://untrusted.invalid/image.png}',[])).toThrow('unavailable');
});
