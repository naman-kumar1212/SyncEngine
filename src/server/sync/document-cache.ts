/**
 * In-memory LRU cache of RGADocument replicas.
 *
 * Each worker maintains an in-memory copy of recently active documents.
 * On first access (cache miss), the document is loaded from PostgreSQL
 * using the latest snapshot + delta operations.
 *
 * Cache eviction is time-based (TTL) + capacity-based (LRU).
 * On eviction, no data is lost — the authoritative state is always in PostgreSQL.
 *
 * Thread-safety note: Node.js is single-threaded, so no mutex needed.
 * Concurrent async operations on the same docId are serialized by the
 * loading promise (using a Map of pending promises to prevent cache stampede).
 */

import { LRUCache } from 'lru-cache';
import { RGADocument } from '../../crdt/rga-document';
import { loadLatestSnapshot } from '../persistence/snapshot-store';
import { loadOperationsAfterSeq, getMaxSeq } from '../persistence/operation-store';
import { config } from '../config';
import { logger } from '../logger';

export interface CachedDocument {
  doc: RGADocument;
  lastSeq: number;
  opsSinceSnapshot: number;  // Counter for triggering snapshot compaction
  loadedAt: number;           // Unix ms
}

// LRU cache: docId → CachedDocument
const cache = new LRUCache<string, CachedDocument>({
  max: config.crdt.documentCacheMaxSize,
  ttl: config.crdt.documentCacheTtlMs,
  updateAgeOnGet: true,
  dispose: (doc, key) => {
    logger.debug({ docId: key }, 'Document evicted from cache');
  },
});

// Prevents cache stampede: tracks in-flight load promises per docId
const loadingPromises: Map<string, Promise<CachedDocument>> = new Map();

/**
 * Returns the cached document, loading it from PostgreSQL if necessary.
 *
 * @throws {Error} if the document does not exist in the database
 */
export async function getOrLoadDocument(docId: string): Promise<CachedDocument> {
  const cached = cache.get(docId);
  if (cached) return cached;

  // Prevent stampede: if another async call is already loading, wait for it
  const existingLoad = loadingPromises.get(docId);
  if (existingLoad) return existingLoad;

  const loadPromise = loadDocumentFromDB(docId);
  loadingPromises.set(docId, loadPromise);

  try {
    const result = await loadPromise;
    cache.set(docId, result);
    return result;
  } finally {
    loadingPromises.delete(docId);
  }
}

async function loadDocumentFromDB(docId: string): Promise<CachedDocument> {
  logger.debug({ docId }, 'Loading document from database');

  const snapshot = await loadLatestSnapshot(docId);

  let doc: RGADocument;
  let fromSeq: number;

  if (snapshot) {
    doc = RGADocument.deserialize(snapshot.data);
    fromSeq = snapshot.seq + 1;
    logger.debug({ docId, snapshotSeq: snapshot.seq }, 'Loaded from snapshot');
  } else {
    doc = new RGADocument();
    fromSeq = 1;
    logger.debug({ docId }, 'No snapshot found, starting from empty document');
  }

  // Apply any ops since the snapshot
  const deltaOps = await loadOperationsAfterSeq(docId, fromSeq - 1);
  let lastSeq = snapshot?.seq ?? 0;

  for (const envelope of deltaOps) {
    doc.applyOperation(envelope.op);
    lastSeq = Math.max(lastSeq, envelope.seq);
  }

  const entry: CachedDocument = {
    doc,
    lastSeq,
    opsSinceSnapshot: deltaOps.length,
    loadedAt: Date.now(),
  };

  logger.info({ docId, lastSeq, deltaOps: deltaOps.length }, 'Document loaded into cache');
  return entry;
}

/**
 * Updates the cache after applying a new operation.
 * This is called by the OperationHandler after persisting to PostgreSQL.
 */
export function updateCachedDocument(
  docId: string,
  mutator: (entry: CachedDocument) => void,
): void {
  const entry = cache.get(docId);
  if (entry) {
    mutator(entry);
    cache.set(docId, entry); // refresh TTL
  }
}

/**
 * Evicts a document from the cache (e.g., after a rollback that replaces state).
 * The document will be re-loaded from PostgreSQL on next access.
 */
export function invalidateDocument(docId: string): void {
  cache.delete(docId);
  logger.debug({ docId }, 'Document cache invalidated');
}

/**
 * Returns cache statistics for monitoring.
 */
export function getCacheStats() {
  return {
    size: cache.size,
    maxSize: config.crdt.documentCacheMaxSize,
    keys: [...cache.keys()],
  };
}
