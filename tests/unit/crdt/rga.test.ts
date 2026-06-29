/**
 * RGA unit tests: insert, delete, tombstone, idempotency, ordering.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RGADocument } from '../../../src/crdt/rga-document';
import type { InsertOperation, DeleteOperation } from '../../../src/shared/types/operation';
import { buildInsertOps, buildDeleteOp } from '../../helpers/test-utils';

const SITE_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const SITE_B = 'bbbbbbbb-0000-0000-0000-000000000002';

describe('RGADocument — basic operations', () => {
  let doc: RGADocument;

  beforeEach(() => {
    doc = new RGADocument();
  });

  it('starts empty', () => {
    expect(doc.toText()).toBe('');
    expect(doc.length).toBe(0);
  });

  it('inserts a single character at the start', () => {
    const op: InsertOperation = {
      type: 'INSERT',
      uid: { clock: 1, siteId: SITE_A },
      after: null,
      value: 'H',
    };
    doc.applyInsert(op);
    expect(doc.toText()).toBe('H');
    expect(doc.length).toBe(1);
  });

  it('inserts multiple characters in sequence', () => {
    const ops = buildInsertOps('Hello', SITE_A);
    ops.forEach((op) => doc.applyInsert(op));
    expect(doc.toText()).toBe('Hello');
    expect(doc.length).toBe(5);
  });

  it('deletes a character (tombstone)', () => {
    const ops = buildInsertOps('AB', SITE_A);
    ops.forEach((op) => doc.applyInsert(op));
    expect(doc.toText()).toBe('AB');

    const delOp: DeleteOperation = buildDeleteOp(ops[0].uid); // delete 'A'
    doc.applyDelete(delOp);
    expect(doc.toText()).toBe('B');
    expect(doc.length).toBe(1);
    // Node count includes tombstoned nodes
    expect(doc.nodeCount).toBe(2);
  });

  it('deleting the same node twice is idempotent', () => {
    const ops = buildInsertOps('X', SITE_A);
    doc.applyInsert(ops[0]);
    const del = buildDeleteOp(ops[0].uid);
    doc.applyDelete(del);
    doc.applyDelete(del); // second delete — should be no-op
    expect(doc.toText()).toBe('');
    expect(doc.length).toBe(0);
  });

  it('inserting the same node twice is idempotent', () => {
    const op = buildInsertOps('Z', SITE_A)[0];
    doc.applyInsert(op);
    doc.applyInsert(op); // duplicate
    expect(doc.toText()).toBe('Z');
    expect(doc.length).toBe(1);
  });

  it('handles unicode characters (emoji)', () => {
    const op: InsertOperation = {
      type: 'INSERT',
      uid: { clock: 1, siteId: SITE_A },
      after: null,
      value: '🚀',
    };
    doc.applyInsert(op);
    expect(doc.toText()).toBe('🚀');
  });

  it('inserts at the correct position between existing nodes', () => {
    const [opA, opC] = buildInsertOps('AC', SITE_A);
    doc.applyInsert(opA);
    doc.applyInsert(opC);

    // Insert 'B' between A and C
    const opB: InsertOperation = {
      type: 'INSERT',
      uid: { clock: 3, siteId: SITE_A },
      after: opA.uid,
      value: 'B',
    };
    doc.applyInsert(opB);

    expect(doc.toText()).toBe('ABC');
  });

  it('toText excludes tombstoned nodes', () => {
    const ops = buildInsertOps('ABCD', SITE_A);
    ops.forEach((op) => doc.applyInsert(op));

    // Delete B and D
    doc.applyDelete(buildDeleteOp(ops[1].uid)); // B
    doc.applyDelete(buildDeleteOp(ops[3].uid)); // D

    expect(doc.toText()).toBe('AC');
    expect(doc.length).toBe(2);
    expect(doc.nodeCount).toBe(4); // all nodes still in list
  });
});

describe('RGADocument — serialization', () => {
  it('serialize/deserialize roundtrip preserves text', () => {
    const doc = new RGADocument();
    buildInsertOps('Hello World', SITE_A).forEach((op) => doc.applyInsert(op));
    doc.applyDelete(buildDeleteOp({ clock: 6, siteId: SITE_A })); // delete space

    const nodes = doc.serialize();
    const restored = RGADocument.deserialize(nodes);

    expect(restored.toText()).toBe(doc.toText());
    expect(restored.length).toBe(doc.length);
  });

  it('clone produces an independent copy', () => {
    const doc = new RGADocument();
    buildInsertOps('CRDT', SITE_A).forEach((op) => doc.applyInsert(op));

    const clone = doc.clone();
    // Modify original
    doc.applyDelete(buildDeleteOp({ clock: 1, siteId: SITE_A }));

    // Clone is unaffected
    expect(clone.toText()).toBe('CRDT');
    expect(doc.toText()).toBe('RDT');
  });
});

describe('RGADocument — UID indexing', () => {
  it('uidToIndex returns correct character offset', () => {
    const doc = new RGADocument();
    const ops = buildInsertOps('abc', SITE_A);
    ops.forEach((op) => doc.applyInsert(op));

    expect(doc.uidToIndex(ops[0].uid)).toBe(0); // 'a' at index 0
    expect(doc.uidToIndex(ops[1].uid)).toBe(1); // 'b' at index 1
    expect(doc.uidToIndex(ops[2].uid)).toBe(2); // 'c' at index 2
  });

  it('indexToUID roundtrips with uidToIndex', () => {
    const doc = new RGADocument();
    const ops = buildInsertOps('hello', SITE_A);
    ops.forEach((op) => doc.applyInsert(op));

    for (let i = 1; i <= 5; i++) {
      const uid = doc.indexToUID(i);
      expect(uid).not.toBeNull();
      expect(doc.uidToIndex(uid!)).toBe(i - 1);
    }
  });
});
