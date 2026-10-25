import { describe, expect, it } from 'vitest';
import { DEFAULT_LOGIN_PRESENTATION, validateLoginPresentation } from '../lib/login-presentation';
const image = { mediaType: 'image', mediaUrl: 'https://assets.example.test/welcome.png', alt: 'Our workspace', iconUrl: 'https://assets.example.test/icon.png' };
describe('public login presentation input', () => {
  it.each(['image', 'gif', 'video'])('accepts explicit %s media and an independent browser icon', mediaType => {
    expect(validateLoginPresentation({ ...image, mediaType })).toEqual({ ...image, mediaType });
  });
  it('clears media independently from the browser icon and strips unrecognized data', () => {
    expect(validateLoginPresentation({ ...image, mediaType: 'none', private: 'never publish' })).toEqual({ ...DEFAULT_LOGIN_PRESENTATION, iconUrl: image.iconUrl });
    expect(validateLoginPresentation({ ...image, iconUrl: '' }).iconUrl).toBe('');
  });
  it.each(['javascript:alert(1)', 'data:image/svg+xml,fixture', 'http://assets.example.test/media', '//assets.example.test/media', 'https://user:secret@example.test/media', 'https://example.test/media#secret'])('rejects unsafe URL %s for media and icon', url => {
    expect(() => validateLoginPresentation({ ...image, mediaUrl: url })).toThrow('invalid');
    expect(() => validateLoginPresentation({ ...image, iconUrl: url })).toThrow('invalid');
  });
  it('requires a description and bounds every public string', () => {
    for (const value of [null, [], { ...image, mediaType: 'html' }, { ...image, alt: '' }, { ...image, alt: 'x'.repeat(241) }, { ...image, mediaUrl: 'https://example.test/' + 'x'.repeat(2048) }, { ...image, iconUrl: 'https://example.test/' + 'x'.repeat(2048) }]) {
      expect(() => validateLoginPresentation(value)).toThrow('invalid');
    }
  });
});
