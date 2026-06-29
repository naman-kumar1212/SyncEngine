/**
 * Test helpers: permutation generation, random string/op generation.
 */

import type { InsertOperation, DeleteOperation, RGAOperation, UID } from '../../src/shared/types/operation';

/**
 * Generates all permutations of an array.
 * Used in convergence tests to prove order-independence.
 */
export function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of permutations(rest)) {
      result.push([arr[i], ...perm]);
    }
  }
  return result;
}

/**
 * Generates a random alphanumeric string for doc IDs and site IDs.
 */
export function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Generates a random UUID-like site ID.
 */
export function randomSiteId(): string {
  const hex = () => Math.random().toString(16).slice(2, 10).padStart(8, '0');
  return `${hex()}-${hex().slice(0, 4)}-${hex().slice(0, 4)}-${hex().slice(0, 4)}-${hex()}`;
}

/**
 * Builds a sequence of insert operations that spell out `text`,
 * each character inserted after the previous one.
 */
export function buildInsertOps(text: string, siteId: string, startClock = 1): InsertOperation[] {
  const ops: InsertOperation[] = [];
  let prevUID: UID | null = null;

  for (let i = 0; i < text.length; i++) {
    const uid: UID = { clock: startClock + i, siteId };
    ops.push({ type: 'INSERT', uid, after: prevUID, value: text[i] });
    prevUID = uid;
  }

  return ops;
}

/**
 * Builds a delete operation for the given UID.
 */
export function buildDeleteOp(uid: UID): DeleteOperation {
  return { type: 'DELETE', uid };
}

/**
 * Shuffles an array in place using Fisher-Yates.
 */
export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Runs an async operation with a timeout.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms),
    ),
  ]);
}
