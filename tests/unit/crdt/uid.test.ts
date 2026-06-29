import { describe, it, expect } from 'vitest';
import { compareUID, uidKey } from '../../../src/shared/types/operation';

describe('compareUID', () => {
  it('compares clocks first', () => {
    const a = { clock: 1, siteId: 'site-a' };
    const b = { clock: 2, siteId: 'site-a' };
    expect(compareUID(a, b)).toBeLessThan(0);
    expect(compareUID(b, a)).toBeGreaterThan(0);
  });

  it('compares siteIds when clocks are equal', () => {
    const a = { clock: 5, siteId: 'site-a' };
    const b = { clock: 5, siteId: 'site-b' };
    expect(compareUID(a, b)).toBeLessThan(0);
    expect(compareUID(b, a)).toBeGreaterThan(0);
  });

  it('returns 0 when clock and siteId are equal', () => {
    const a = { clock: 5, siteId: 'site-a' };
    const b = { clock: 5, siteId: 'site-a' };
    expect(compareUID(a, b)).toBe(0);
  });
});

describe('uidKey', () => {
  it('produces a unique string key', () => {
    const uid = { clock: 10, siteId: 'site-x' };
    expect(uidKey(uid)).toBe('10:site-x');
  });
});
