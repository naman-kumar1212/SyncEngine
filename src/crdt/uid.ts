/**
 * UID generation utilities for the RGA CRDT.
 *
 * Each site (client instance) maintains a Lamport clock that it increments
 * before every local insert. The combination of (clock, siteId) is globally
 * unique because:
 *   1. siteId is a UUID — globally unique across all sites
 *   2. clock is strictly monotonically increasing per site
 */

import { v4 as uuidv4 } from 'uuid';
import type { UID, VectorClock } from '../shared/types/operation';
import { ROOT_UID } from '../shared/types/operation';

export { ROOT_UID };

/**
 * Generates a new Lamport-clock-based UID for a local insertion.
 *
 * The clock is computed as:
 *   max(localClock, max(allKnownClocks)) + 1
 *
 * This ensures the new UID is causally "after" all known operations,
 * preventing position ambiguity in concurrent inserts.
 *
 * @param siteId - UUID of the current client/site
 * @param localClock - Current local Lamport clock value
 * @param vectorClock - The site's full vector clock (to determine max seen clock)
 * @returns A new UID and the updated local clock
 */
export function generateUID(
  siteId: string,
  localClock: number,
  vectorClock: VectorClock,
): { uid: UID; nextClock: number } {
  const maxSeen = Math.max(localClock, ...Object.values(vectorClock));
  const nextClock = maxSeen + 1;
  return {
    uid: { clock: nextClock, siteId },
    nextClock,
  };
}

/**
 * Generates a new UUID suitable for use as a siteId.
 * Call once per client session and persist in localStorage.
 */
export function generateSiteId(): string {
  return uuidv4();
}

/**
 * Updates a Lamport clock upon receiving a remote operation.
 * Per the Lamport clock rule: localClock = max(localClock, remoteClock) + 1
 */
export function updateLamportClock(localClock: number, remoteClock: number): number {
  return Math.max(localClock, remoteClock) + 1;
}
