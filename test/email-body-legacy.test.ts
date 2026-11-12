import { describe, expect, it } from 'vitest';
import defaults from '../lib/lifecycle-v9-defaults.json';
import { emailBodyDocSchema } from '../lib/email-body/doc';
import { docToLegacyText, legacyBodyToDoc } from '../lib/email-body/legacy';
import { renderEmailBody } from '../lib/email-body/render';
import { merge } from '../lib/lifecycle-v9-model';

const images = [{ id: 'img-welcome', name: 'welcome-banner.png' }, { id: 'img-map', name: 'Office map' }];
const bodies = (defaults as { emails: { body: string }[] }).emails.map(email => email.body);
const corpus = [
  ...bodies,
  '', 'Single line', 'Trailing newline\n', 'Trailing blank line\n\n', '\n\nLeading blank line', '\nLeading newline',
  'Three\n\n\nnewlines', 'Four\n\n\n\nnewlines', 'Five\n\n\n\n\nnewlines', '\n\n\n', '   Leading spaces\n  and  inner  runs  ',
  'Tags <b>stay</b> & entities &amp; stay', 'Stray { braces } and {not a field} and {1bad} and {a.b.c} and {}',
  'Image {image:img-welcome} inline and {image:missing-id} unknown{image:img-map}', '{employee.name}{company.name}', 'Tab\there',
  'Unicode — café, 日本語, emoji 🎉', '{image:img-welcome}', 'a\n{employee.name}\n\n{joiner.joinDate}\n',
];

describe('legacy plain-text body <-> EmailBodyDoc', () => {
  it('has the eight default template bodies in the corpus', () => expect(bodies).toHaveLength(8));
  it.each(corpus.map(body => [JSON.stringify(body).slice(0, 60), body]))('round-trips %s exactly', (_, body) => {
    const doc = legacyBodyToDoc(body, images);
    expect(emailBodyDocSchema.safeParse(doc).success).toBe(true);
    expect(docToLegacyText(doc)).toBe(body);
  });
  it('maps blank lines to paragraphs, newlines to breaks, codes to chips and owned image tokens to images', () => {
    expect(legacyBodyToDoc('Dear {employee.name},\n\nSee {image:img-map} and {image:other}.\nThanks', images)).toEqual({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Dear ' }, { type: 'field', attrs: { key: 'employee.name' } }, { type: 'text', text: ',' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'See ' }, { type: 'image', attrs: { assetId: 'img-map', alt: 'Office map' } }, { type: 'text', text: ' and {image:other}.' }, { type: 'hardBreak' }, { type: 'text', text: 'Thanks' }] },
    ] });
    expect(legacyBodyToDoc('a\n\n\nb').content).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'paragraph', content: [{ type: 'hardBreak' }, { type: 'text', text: 'b' }] }]);
    expect(legacyBodyToDoc('a\n\n\n\nb').content[1]).toEqual({ type: 'paragraph' });
  });
  it('reads CRLF and CR line ends as LF (documented: the editor has no carriage returns)', () => {
    expect(docToLegacyText(legacyBodyToDoc('One\r\nTwo\r\n\r\nThree\rFour'))).toBe('One\nTwo\n\nThree\nFour');
  });
  it('renders an unedited default template with the same merged words as the legacy merge path', () => {
    const values = { 'employee.name': 'Aria Fenwick', 'company.name': 'Northwind Fixture Sdn Bhd', 'employee.position': 'Analyst', 'employee.department': 'Finance', 'joiner.joinDate': '2026-12-01', 'employee.supervisor': 'Tomas Reyes', 'leaver.lastDay': '2026-12-31' };
    for (const body of bodies) {
      const legacy = merge(body, values);
      const rendered = renderEmailBody(legacyBodyToDoc(body), { values });
      expect(rendered.text).toBe(legacy.text);
      expect(rendered.missing).toEqual(legacy.missing);
    }
  });
});
