/**
 * Operation log tests: duplicate detection, causal buffering, out-of-order delivery.
 */

import { describe, it, expect } from 'vitest';
import { OperationLog } from '../../../src/crdt/operation-log';
import { RGADocument } from '../../../src/crdt/rga-document';
import type { OperationEnvelope } from '../../../src/shared/types/operation';
import { buildInsertOps } from '../../helpers/test-utils';

const SITE_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const SITE_B = 'bbbbbbbb-0000-0000-0000-000000000002';

function makeEnvelope(
  op: ReturnType<typeof buildInsertOps>[number],
  seq: number,
  clientSeq: number,
  sessionId = 'session-1',
): OperationEnvelope {
  return {
    id: `env-${seq}`,
    docId: 'doc-1',
    sessionId,
    userId: 'user-1',
    op,
    seq,
    clientSeq,
    timestamp: new Date().toISOString(),
    vectorClock: { [SITE_A]: seq },
    nonce: `nonce-${seq}-${Math.random()}`,
  };
}

describe('OperationLog', () => {
  it('applies operations in order and tracks max seq', () => {
    const log = new OperationLog();
    const doc = new RGADocument();
    const ops = buildInsertOps('Hello', SITE_A);

    ops.forEach((op, i) => {
      const applied = log.applyOrBuffer(makeEnvelope(op, i + 1, i + 1), doc);
      expect(applied).toBe(true);
    });

    expect(doc.toText()).toBe('Hello');
    expect(log.getMaxAppliedSeq()).toBe(5);
  });

  it('rejects duplicate operations by seq', () => {
    const log = new OperationLog();
    const doc = new RGADocument();
    const [op] = buildInsertOps('X', SITE_A);
    const env = makeEnvelope(op, 1, 1);

    log.applyOrBuffer(env, doc);
    log.applyOrBuffer(env, doc); // duplicate
    log.applyOrBuffer(env, doc); // duplicate again

    expect(doc.toText()).toBe('X');
    expect(doc.length).toBe(1);
  });

  it('rejects duplicate operations by clientSeq within same session', () => {
    const log = new OperationLog();
    const doc = new RGADocument();
    const [op] = buildInsertOps('Y', SITE_A);

    const env1 = makeEnvelope(op, 1, 42, 'session-X');
    const env2 = { ...makeEnvelope(op, 0, 42, 'session-X'), id: 'env-2' }; // same clientSeq, no serverSeq yet

    log.applyOrBuffer(env1, doc);
    log.applyOrBuffer(env2, doc); // duplicate clientSeq

    expect(doc.length).toBe(1);
  });

  it('buffers operations with causal gaps and applies when gap is resolved', () => {
    const log = new OperationLog();
    const doc = new RGADocument();

    const [op1, op2] = buildInsertOps('AB', SITE_A);

    // op2 depends on op1 (inserts after op1.uid)
    // Apply op2 first (causal gap)
    const applied1 = log.applyOrBuffer(makeEnvelope(op2, 2, 2), doc);
    expect(applied1).toBe(false); // buffered — after node not found

    // Now apply op1 — should trigger flush of op2 from buffer
    const applied2 = log.applyOrBuffer(makeEnvelope(op1, 1, 1), doc);
    expect(applied2).toBe(true);

    // After flush, op2 should also be applied
    expect(doc.toText()).toBe('AB');
  });
});
