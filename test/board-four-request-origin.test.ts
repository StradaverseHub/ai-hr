import { describe, expect, it } from 'vitest';
import { isSameOriginBrowserRequest } from '../lib/request-origin';

describe('browser request origin contract', () => {
  it.each([
    ['https://clock.example.test', 'clock.example.test'],
    ['https://clock.example.test', 'CLOCK.EXAMPLE.TEST'],
    ['https://clock.example.test', 'clock.example.test:443'],
    ['https://clock.example.test:8443', 'clock.example.test:8443'],
    ['https://[::1]:3000', '[::1]:3000'],
  ])('accepts only the complete addressed authority: %s, %s', (origin, host) => {
    expect(isSameOriginBrowserRequest(new Request('https://localhost:3000/api/attendance/clock', { headers: { origin, host } }))).toBe(true);
  });

  it.each([
    ['https://other.example.test', 'clock.example.test'],
    ['https://clock.example.test:8443', 'clock.example.test'],
    ['http://clock.example.test', 'clock.example.test'],
    ['https://clock.example.test/', 'clock.example.test'],
    ['https://user@clock.example.test', 'clock.example.test'],
    ['https://clock.example.test?query', 'clock.example.test'],
    ['https://clock.example.test#fragment', 'clock.example.test'],
    ['null', 'clock.example.test'],
    ['https://clock.example.test', 'clock.example.test, other.example.test'],
    ['https://clock.example.test', 'clock.example.test/ignored'],
    ['https://clock.example.test', 'user@clock.example.test'],
    ['https://clock.example.test', 'clock.example.test\\ignored'],
    ['https://clock.example.test', ''],
  ])('rejects malformed or different origins/authorities: %s, %s', (origin, host) => {
    expect(isSameOriginBrowserRequest(new Request('https://localhost:3000/api/attendance/clock', { headers: { origin, host } }))).toBe(false);
  });
});
