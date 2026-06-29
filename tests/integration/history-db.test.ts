import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query } from '../../src/server/persistence/db';
import { reconstructAtSeq, restoreToRevision } from '../../src/server/persistence/history-service';
import { appendOperation } from '../../src/server/persistence/operation-store';
import { saveSnapshot, loadLatestSnapshot } from '../../src/server/persistence/snapshot-store';
import { RGADocument } from '../../src/crdt/rga-document';
import { v4 as uuidv4 } from 'uuid';

describe('Real Database History & Rollback Integration', () => {
  const userId = uuidv4();
  const docId = uuidv4();
  const sessionId = uuidv4();
  const siteId = uuidv4();

  beforeAll(async () => {
    // 1. Insert a temporary user
    await query(
      `INSERT INTO users (id, email, display_name, password_hash)
       VALUES ($1, $2, $3, $4)`,
      [userId, `test-user-${userId}@example.com`, 'Test DB User', 'hashed-pass'],
    );

    // 2. Insert a temporary document owned by this user
    await query(
      `INSERT INTO documents (id, title, owner_id)
       VALUES ($1, $2, $3)`,
      [docId, 'Integration Test Doc', userId],
    );
  });

  afterAll(async () => {
    // Clean up all data related to this test run
    // CASCADE constraints in schema will clean up operations, snapshots, etc.
    await query(`DELETE FROM documents WHERE id = $1`, [docId]);
    await query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  it('performs incremental edits, builds snapshots, and reconstructs correct intermediate states', async () => {
    // Let's create an RGA document representing the user actions: typing "ABC"
    const doc = new RGADocument();

    // 1st insert: 'A'
    const op1 = {
      type: 'INSERT' as const,
      uid: { clock: 1, siteId },
      after: null,
      value: 'A',
    };
    doc.applyOperation(op1);
    const env1 = await appendOperation({
      docId,
      sessionId,
      userId,
      clientSeq: 1,
      op: op1,
      vectorClock: {},
      nonce: uuidv4(),
    });

    // 2nd insert: 'B'
    const op2 = {
      type: 'INSERT' as const,
      uid: { clock: 2, siteId },
      after: op1.uid,
      value: 'B',
    };
    doc.applyOperation(op2);
    const env2 = await appendOperation({
      docId,
      sessionId,
      userId,
      clientSeq: 2,
      op: op2,
      vectorClock: {},
      nonce: uuidv4(),
    });

    // 3rd insert: 'C'
    const op3 = {
      type: 'INSERT' as const,
      uid: { clock: 3, siteId },
      after: op2.uid,
      value: 'C',
    };
    doc.applyOperation(op3);
    const env3 = await appendOperation({
      docId,
      sessionId,
      userId,
      clientSeq: 3,
      op: op3,
      vectorClock: {},
      nonce: uuidv4(),
    });

    expect(doc.toText()).toBe('ABC');
    expect(env1.seq).toBe(1);
    expect(env2.seq).toBe(2);
    expect(env3.seq).toBe(3);

    // Save a snapshot at seq 2 ("AB")
    const docAtSeq2 = new RGADocument();
    docAtSeq2.applyOperation(op1);
    docAtSeq2.applyOperation(op2);
    await saveSnapshot(docId, docAtSeq2, 2);

    // Verify reconstructAtSeq at targetSeq = 2 (reloaded from snapshot)
    const recon2 = await reconstructAtSeq(docId, 2);
    expect(recon2.doc.toText()).toBe('AB');
    expect(recon2.snapshot).not.toBeNull();
    expect(recon2.snapshot?.seq).toBe(2);

    // Verify reconstructAtSeq at targetSeq = 1 (no snapshot <= 1 exists, replayed from start)
    const recon1 = await reconstructAtSeq(docId, 1);
    expect(recon1.doc.toText()).toBe('A');
    expect(recon1.snapshot).toBeNull();

    // Verify reconstructAtSeq at targetSeq = 3 (snapshot @ 2 + replay seq 3)
    const recon3 = await reconstructAtSeq(docId, 3);
    expect(recon3.doc.toText()).toBe('ABC');
    expect(recon3.snapshot?.seq).toBe(2);
  });

  it('successfully restores/reverts document to an earlier point in history', async () => {
    // Target is sequence 2 ("AB")
    const restoreResult = await restoreToRevision({
      docId,
      targetSeq: 2,
      userId,
      sessionId,
    });

    expect(restoreResult.restoredText).toBe('AB');
    expect(restoreResult.newSeq).toBe(4); // original ops: 1, 2, 3. Rollback makes it 4.

    // A snapshot should have been saved automatically at the new sequence (4)
    const latestSnapshot = await loadLatestSnapshot(docId);
    expect(latestSnapshot).not.toBeNull();
    expect(latestSnapshot?.seq).toBe(4);

    // Reconstructing at seq 4 should produce "AB"
    const recon4 = await reconstructAtSeq(docId, 4);
    expect(recon4.doc.toText()).toBe('AB');
    expect(recon4.doc.toText().length).toBe(2);
  });
});
