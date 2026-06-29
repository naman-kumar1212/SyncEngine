/**
 * Vector clock unit tests.
 */

import { describe, it, expect } from 'vitest';
import { VectorClockManager, mergeClocks } from '../../../src/crdt/vector-clock';

const SITE_A = 'site-a';
const SITE_B = 'site-b';
const SITE_C = 'site-c';

describe('VectorClockManager', () => {
  it('starts empty', () => {
    const vc = new VectorClockManager();
    expect(vc.get(SITE_A)).toBe(0);
    expect(vc.toObject()).toEqual({});
  });

  it('tick increments the given site', () => {
    const vc = new VectorClockManager();
    const snapshot1 = vc.tick(SITE_A);
    expect(snapshot1[SITE_A]).toBe(1);

    const snapshot2 = vc.tick(SITE_A);
    expect(snapshot2[SITE_A]).toBe(2);
  });

  it('merge takes component-wise max', () => {
    const vc = new VectorClockManager({ [SITE_A]: 3, [SITE_B]: 1 });
    const merged = vc.merge({ [SITE_A]: 1, [SITE_B]: 5, [SITE_C]: 2 });

    expect(merged[SITE_A]).toBe(3);
    expect(merged[SITE_B]).toBe(5);
    expect(merged[SITE_C]).toBe(2);
  });

  it('dominates returns true when local >= remote component-wise', () => {
    const local = new VectorClockManager({ [SITE_A]: 5, [SITE_B]: 3 });
    expect(local.dominates({ [SITE_A]: 5, [SITE_B]: 3 })).toBe(true);
    expect(local.dominates({ [SITE_A]: 4, [SITE_B]: 2 })).toBe(true);
    expect(local.dominates({ [SITE_A]: 6, [SITE_B]: 3 })).toBe(false);
    expect(local.dominates({ [SITE_A]: 5, [SITE_B]: 4 })).toBe(false);
  });

  it('clone is independent', () => {
    const vc = new VectorClockManager({ [SITE_A]: 2 });
    const clone = vc.clone();
    vc.tick(SITE_A);
    expect(clone.get(SITE_A)).toBe(2);
    expect(vc.get(SITE_A)).toBe(3);
  });
});

describe('mergeClocks (standalone)', () => {
  it('merges two clocks immutably', () => {
    const a = { [SITE_A]: 3, [SITE_B]: 0 };
    const b = { [SITE_A]: 1, [SITE_B]: 5 };
    const result = mergeClocks(a, b);

    expect(result[SITE_A]).toBe(3);
    expect(result[SITE_B]).toBe(5);
    // Originals unchanged
    expect(a[SITE_B]).toBe(0);
    expect(b[SITE_A]).toBe(1);
  });
});
