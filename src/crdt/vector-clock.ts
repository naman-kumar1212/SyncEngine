/**
 * Vector Clock implementation for causal ordering in the distributed system.
 *
 * A vector clock V[S] is a map from siteId → logical clock.
 * It tracks the causal history of a site's knowledge about other sites.
 *
 * Uses:
 *   - Determining which operations a reconnecting client has missed
 *   - Causal delivery ordering (ensure op's dependencies arrive before it)
 *   - Diagnosing reordering in test scenarios
 */

import type { VectorClock } from '../shared/types/operation';

export class VectorClockManager {
  private clock: Map<string, number>;

  constructor(initial?: VectorClock) {
    this.clock = new Map(Object.entries(initial ?? {}));
  }

  /**
   * Increments this site's entry and returns the new clock snapshot.
   */
  tick(siteId: string): VectorClock {
    this.clock.set(siteId, (this.clock.get(siteId) ?? 0) + 1);
    return this.toObject();
  }

  /**
   * Updates this clock by merging a received remote clock.
   * Per vector clock rule: for each site, take the max of local and remote.
   */
  merge(remote: VectorClock): VectorClock {
    for (const [site, remoteClock] of Object.entries(remote)) {
      const local = this.clock.get(site) ?? 0;
      if (remoteClock > local) this.clock.set(site, remoteClock);
    }
    return this.toObject();
  }

  /**
   * Returns the current clock value for a given site.
   */
  get(siteId: string): number {
    return this.clock.get(siteId) ?? 0;
  }

  /**
   * Serializable snapshot of the current vector clock.
   */
  toObject(): VectorClock {
    return Object.fromEntries(this.clock.entries());
  }

  /**
   * Returns true if this clock has seen all operations that `other` has seen.
   * i.e., this >= other component-wise.
   */
  dominates(other: VectorClock): boolean {
    for (const [site, remoteClock] of Object.entries(other)) {
      if ((this.clock.get(site) ?? 0) < remoteClock) return false;
    }
    return true;
  }

  /**
   * Returns true if an operation with the given clock is causally ready to apply:
   * all operations that causally precede it have already been applied.
   *
   * For an op from site S with clock C and vectorClock V:
   *   - This site's entry for S must be C-1 (exactly preceding)
   *   - For all other sites T: local[T] >= V[T]
   */
  isCausallyReady(opSiteId: string, opClock: number, opVectorClock: VectorClock): boolean {
    // Check that we've seen exactly the predecessor from opSiteId
    const localSiteClock = this.clock.get(opSiteId) ?? 0;
    if (localSiteClock !== opClock - 1 && opClock !== 1) {
      // Allow op if the site's clock is already advanced (idempotent)
      if (localSiteClock < opClock - 1) return false;
    }

    // Check all other sites
    for (const [site, remoteClock] of Object.entries(opVectorClock)) {
      if (site === opSiteId) continue;
      if ((this.clock.get(site) ?? 0) < remoteClock) return false;
    }

    return true;
  }

  clone(): VectorClockManager {
    return new VectorClockManager(this.toObject());
  }
}

/**
 * Standalone merge of two VectorClock objects (immutable, returns new object).
 */
export function mergeClocks(a: VectorClock, b: VectorClock): VectorClock {
  const result: Record<string, number> = { ...a };
  for (const [site, clock] of Object.entries(b)) {
    result[site] = Math.max(result[site] ?? 0, clock);
  }
  return result;
}
