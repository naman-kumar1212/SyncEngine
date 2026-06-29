# Architectural Reference Guide: Collaborative Sync Engine

This document provides a detailed overview of the system design, conflict resolution algorithms, networking protocols, and security models implemented in the Real-Time Collaborative Sync Engine.

---

## 1. Conflict Resolution (RGA CRDT)

### Replicated Growable Array (RGA)
The core synchronization algorithm is an operation-based **Replicated Growable Array (RGA)** CRDT. RGA represents the document as a doubly-linked list of character nodes beginning with a virtual sentinel `ROOT` node.

```
[ ROOT ] <──> [ H: (1, A) ] <──> [ e: (2, A) ] <──> [ l: (3, A) ] ...
```

Each character node contains:
- `uid`: A globally unique identifier `(clock, siteId)`.
- `value`: A single character.
- `tombstoned`: A boolean representing deleted characters (soft-deleted).

### Deterministic Tie-Breaking
When two clients concurrently insert characters at the same position, they will reference the same `after` node. RGA resolves this tie deterministically by scanning rightward from the `after` node and ordering concurrent insertions by comparing UIDs lexicographically (clock descending, then siteId descending):

$$\text{compareUID}(a, b) = \begin{cases} 
a.\text{clock} - b.\text{clock} & \text{if } a.\text{clock} \neq b.\text{clock} \\
a.\text{siteId} \text{ vs } b.\text{siteId} & \text{if } a.\text{clock} = b.\text{clock}
\end{cases}$$

This total ordering ensures that all replicas, upon applying the same set of operations, construct an identical character sequence.

---

## 2. Event Sourcing & Snapshotting

The persistence layer follows an **event sourcing** pattern:
- **Operations Log**: Authoritative source of truth. Every edit is stored as an immutable event in the `operations` table. No `UPDATE` or `DELETE` queries are ever performed on this table.
- **Snapshots**: Checkpoints representing the fully serialized RGADocument sequence at a specific sequence number (`seq`). Snapshots are generated in the background by a compactor job.
- **Document Loading**: When a document is accessed, it is loaded via:
  $$\text{State} = \text{LatestSnapshot} + \sum_{seq = \text{SnapshotSeq} + 1}^{\text{LatestSeq}} \text{Operation}(seq)$$
  This keeps cold-start loads $O(\text{SnapshotSize} + \Delta)$ instead of $O(\text{TotalHistoryLength})$.

---

## 3. Scale-Out Architecture

To scale horizontally across multiple worker instances, the system decouples client connections from persistence and fan-out:

```
                  ┌──────────────┐
                  │ Load Balancer│
                  └──────┬───────┘
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
  ┌──────────┐     ┌──────────┐     ┌──────────┐
  │ Worker 1 │     │ Worker 2 │     │ Worker N │
  └────┬─────┘     └────┬─────┘     └────┬─────┘
       │                │                │
       └────────┬───────┴────────────────┘
                │
      ┌─────────▼──────────┐
      │  Redis Pub/Sub     │
      │  (Cross-worker)    │
      └────────────────────┘
```

1. **Local Socket Ingestion**: A client connects to any available worker over WebSocket and submits an operation.
2. **Persistence**: The worker validates the operation, writes it to PostgreSQL, and updates its local LRU cache.
3. **Redis Fan-out**: The worker publishes the operation envelope to a Redis channel named `doc:{docId}:ops`.
4. **Broadcast**: All workers subscribed to the Redis channel receive the envelope and broadcast it to their locally connected clients for that document.

---

## 4. Reconnection & Offline Sync

When a client loses connectivity:
1. **Optimistic UI Updates**: Local operations are immediately applied to the browser's RGA replica and placed into a localStorage-backed `OfflineQueue`.
2. **Missed Operations Retrieval**: Upon reconnecting, the client sends a `JOIN` message containing the `lastSeq` it received before disconnecting. The server queries all operations since `lastSeq` and sends them back in `JOIN_ACK`.
3. **CRDT Replay**: The client applies the missed operations. Because CRDT operations are mathematically commutative and associative, the client merges these missed operations into its local replica, and then re-submits all operations stored in its `OfflineQueue` in sequence.
4. **Server Merging**: The server processes the re-sent operations normally, persisting them and broadcasting them to other users.

---

## 5. Security & Isolation

- **Authentication**: JWT token validation is required on the REST API and on the WebSocket `JOIN` protocol.
- **Replay Protection**: A sliding-window replay guard in Redis tracks operation `nonce` values for 5 minutes, rejecting duplicates.
- **Impersonation Prevention**: The server validates that the `siteId` specified in the operation matches the authenticated session's `siteId`.
- **Rate Limiting**: Users are limited using a Redis sliding-window algorithm to 100 operations per second and 1000 operations per minute.
