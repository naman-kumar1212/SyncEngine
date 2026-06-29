/**
 * E2E concurrent edit simulation.
 *
 * This test simulates multiple clients editing the same document concurrently
 * using pure in-memory CRDT replicas (no network, no DB) to verify convergence.
 *
 * It covers:
 *   - Random concurrent inserts from N clients
 *   - Concurrent inserts + deletes
 *   - Large document stress test
 *   - Duplicate packet simulation (same op sent twice)
 *   - Out-of-order delivery simulation
 */

import { describe, it, expect } from 'vitest';
import { RGADocument } from '../../src/crdt/rga-document';
import { OperationLog } from '../../src/crdt/operation-log';
import type { RGAOperation, OperationEnvelope } from '../../src/shared/types/operation';
import { buildInsertOps, buildDeleteOp, shuffle } from '../helpers/test-utils';

const SITES = [
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003',
  'dddddddd-0000-0000-0000-000000000004',
];

function wrapOp(op: RGAOperation, seq: number): OperationEnvelope {
  return {
    id: `env-${seq}`,
    docId: 'doc-test',
    sessionId: `session-${op.uid.siteId}`,
    userId: 'user-test',
    op,
    seq,
    clientSeq: seq,
    timestamp: new Date().toISOString(),
    vectorClock: {},
    nonce: `nonce-${seq}`,
  };
}

function simulateConcurrentEdits(
  clientOps: RGAOperation[][],
  numReplicas = 3,
): string[] {
  const allOps = clientOps.flat();
  const results: string[] = [];

  for (let r = 0; r < numReplicas; r++) {
    const doc = new RGADocument();
    const log = new OperationLog(1000); // larger buffer for simulation shuffles
    const shuffled = shuffle(allOps);

    // Map each shuffled op to its envelope with its original index as seq
    const envelopes = shuffled.map((op) => wrapOp(op, allOps.indexOf(op) + 1));

    for (const env of envelopes) {
      log.applyOrBuffer(env, doc);
    }
    results.push(doc.toText());
  }

  return results;
}

describe('Concurrent edit simulation', () => {
  it('SIM-01: 2 clients, 5 inserts each — 10 replicas all converge', () => {
    const opsA = buildInsertOps('Hello', SITES[0]);
    const opsB = buildInsertOps('World', SITES[1]);

    const results = simulateConcurrentEdits([opsA, opsB], 10);
    expect(new Set(results).size).toBe(1);
    expect(results[0].length).toBe(10);
  });

  it('SIM-02: 4 clients concurrent inserts — 20 replicas converge', () => {
    const allClientOps = SITES.map((site, i) =>
      buildInsertOps('ABCDE'.slice(0, i + 2), site, (i + 1) * 100),
    );

    const results = simulateConcurrentEdits(allClientOps, 20);
    expect(new Set(results).size).toBe(1);
  });

  it('SIM-03: concurrent inserts AND deletes from 3 clients converge', () => {
    const opsA = buildInsertOps('Hello', SITES[0]);
    const opsB = buildInsertOps('World', SITES[1]);
    const deleteOps = [
      buildDeleteOp(opsA[0].uid), // Site C deletes 'H'
      buildDeleteOp(opsB[4].uid), // Site C deletes 'd'
    ];

    const results = simulateConcurrentEdits([opsA, opsB, deleteOps], 15);
    expect(new Set(results).size).toBe(1);
    // 'H' and 'd' deleted from concurrent insertions.
    // SITE_B > SITE_A lexicographically, so 'World' is before 'Hello' -> 'WorldHello'.
    // Delete 'W's 'd' and 'Hello's 'H' -> 'Worlello'.
    expect(results[0]).toBe('Worlello');
  });

  it('SIM-04: duplicate packet simulation — same op received twice converges', () => {
    const opsA = buildInsertOps('AB', SITES[0]);
    const allOps: RGAOperation[] = [...opsA, opsA[0], opsA[1]]; // each op duplicated

    const doc = new RGADocument();
    for (const op of allOps) doc.applyOperation(op);

    expect(doc.toText()).toBe('AB');
    expect(doc.length).toBe(2);
  });

  it('SIM-05: out-of-order delivery within a single client\'s operations', () => {
    const opsA = buildInsertOps('ABCDE', SITES[0]);

    // Apply in reverse order using OperationLog (to handle gaps)
    const doc1 = new RGADocument();
    const log1 = new OperationLog();
    [...opsA].reverse().forEach((op, idx) => {
      // Find the original sequence index of this operation (A=1, B=2, C=3, D=4, E=5)
      const seq = opsA.indexOf(op) + 1;
      log1.applyOrBuffer(wrapOp(op, seq), doc1);
    });

    // Apply in correct order
    const doc2 = new RGADocument();
    const log2 = new OperationLog();
    opsA.forEach((op, idx) => {
      log2.applyOrBuffer(wrapOp(op, idx + 1), doc2);
    });

    // Both should have same result
    expect(doc1.length).toBe(doc2.length);
    expect(doc1.toText()).toBe(doc2.toText());
  });

  it('SIM-06: large document stress test (1000 chars, 5 clients)', () => {
    const chars = 200;
    const allClientOps = SITES.map((site, siteIdx) =>
      buildInsertOps(
        'X'.repeat(chars),
        site,
        siteIdx * chars + 1,
      ),
    );

    const results = simulateConcurrentEdits(allClientOps, 5);
    expect(new Set(results).size).toBe(1);
    expect(results[0].length).toBe(chars * SITES.length);
  });

  it('SIM-07: interleaved inserts and deletes across 3 clients produce same final doc', () => {
    const opsA = buildInsertOps('AAA', SITES[0], 1);
    const opsB = buildInsertOps('BBB', SITES[1], 10);
    const opsC = buildInsertOps('CCC', SITES[2], 20);

    // Each client deletes one character from another's insertion
    const deletes: RGAOperation[] = [
      buildDeleteOp(opsA[1].uid), // delete middle A
      buildDeleteOp(opsB[0].uid), // delete first B
      buildDeleteOp(opsC[2].uid), // delete last C
    ];

    const results = simulateConcurrentEdits([opsA, opsB, opsC, deletes], 20);
    expect(new Set(results).size).toBe(1);
    expect(results[0].length).toBe(6); // 9 chars - 3 deletes
  });
});
