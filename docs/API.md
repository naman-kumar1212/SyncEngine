# REST and WebSocket API Reference

This document outlines the API contracts for the REST endpoints and the real-time WebSocket protocol.

---

## 1. REST API

All REST API endpoints are prefixed with `/api`. Authenticated endpoints require a `Authorization: Bearer <token>` header.

### 1.1 Authentication

#### `POST /api/auth/register`
Registers a new user.
- **Request Body**:
  ```json
  {
    "email": "user@example.com",
    "displayName": "Alice",
    "password": "password123"
  }
  ```
- **Response (201)**:
  ```json
  {
    "userId": "22222222-2222-2222-2222-222222222222"
  }
  ```

#### `POST /api/auth/login`
Authenticates a user and sets an HttpOnly refresh cookie.
- **Request Body**:
  ```json
  {
    "email": "user@example.com",
    "password": "password123"
  }
  ```
- **Response (200)**:
  ```json
  {
    "accessToken": "eyJhbGci...",
    "expiresIn": 900
  }
  ```

#### `POST /api/auth/refresh`
Rotates refresh tokens and returns a new access token. Requires the `refreshToken` HttpOnly cookie.
- **Response (200)**:
  ```json
  {
    "accessToken": "eyJhbGci...",
    "expiresIn": 900
  }
  ```

#### `POST /api/auth/logout`
Clears the `refreshToken` HttpOnly cookie.
- **Response (200)**:
  ```json
  {
    "ok": true
  }
  ```

---

### 1.2 Documents

#### `POST /api/docs` (Auth Required)
Creates a new shared document.
- **Request Body**:
  ```json
  {
    "title": "Project Goals"
  }
  ```
- **Response (201)**:
  ```json
  {
    "id": "11111111-1111-1111-1111-111111111111",
    "title": "Project Goals",
    "ownerId": "22222222-2222-2222-2222-222222222222",
    "createdAt": "2026-06-29T11:00:00.000Z",
    "updatedAt": "2026-06-29T11:00:00.000Z"
  }
  ```

#### `GET /api/docs` (Auth Required)
Lists all documents accessible to the current user.
- **Response (200)**:
  ```json
  [
    {
      "id": "11111111-1111-1111-1111-111111111111",
      "title": "Project Goals",
      "role": "owner"
    }
  ]
  ```

---

### 1.3 History & Rollback

#### `GET /api/docs/:id/history` (Auth Required)
Retrieves paginated operations logs.
- **Query Parameters**:
  - `page` (optional, default: 0)
  - `pageSize` (optional, default: 50, max: 200)
- **Response (200)**:
  ```json
  [
    {
      "id": "uuid",
      "docId": "uuid",
      "sessionId": "uuid",
      "userId": "uuid",
      "seq": 1,
      "clientSeq": 1,
      "op": { "type": "INSERT", "uid": { "clock": 1, "siteId": "site-1" }, "after": null, "value": "a" },
      "vectorClock": {},
      "timestamp": "2026-06-29T11:00:00.000Z"
    }
  ]
  ```

#### `POST /api/docs/:id/restore` (Auth Required)
Rolls back a document to a specific sequence number. Inserts a synthetic `ROLLBACK` delete operation to converge all connected clients.
- **Request Body**:
  ```json
  {
    "targetSeq": 5
  }
  ```
- **Response (200)**:
  ```json
  {
    "ok": true,
    "newSeq": 6,
    "targetSeq": 5,
    "textLength": 105,
    "preview": "Restored text preview..."
  }
  ```

---

## 2. WebSocket Protocol (`/ws`)

Clients authenticate by sending a `JOIN` message as the first message over the socket.

### 2.1 Client → Server Messages

#### `JOIN`
Sent upon socket connection.
```json
{
  "type": "JOIN",
  "docId": "11111111-1111-1111-1111-111111111111",
  "token": "eyJhbGci...",
  "lastSeq": 42,
  "clientId": "33333333-3333-3333-3333-333333333333"
}
```

#### `OPERATION`
Sent when the client modifies the document.
```json
{
  "type": "OPERATION",
  "docId": "11111111-1111-1111-1111-111111111111",
  "clientSeq": 5,
  "op": {
    "type": "INSERT",
    "uid": { "clock": 10, "siteId": "33333333-3333-3333-3333-333333333333" },
    "after": { "clock": 9, "siteId": "33333333-3333-3333-3333-333333333333" },
    "value": "b"
  },
  "vectorClock": { "site-1": 10 },
  "nonce": "uuid-nonce"
}
```

#### `PRESENCE`
Sent when the client's cursor position or typing state changes.
```json
{
  "type": "PRESENCE",
  "docId": "uuid",
  "update": {
    "sessionId": "uuid",
    "cursor": {
      "afterUid": { "clock": 10, "siteId": "33333333-3333-3333-3333-333333333333" },
      "anchorUid": null
    },
    "isTyping": true
  }
}
```

---

### 2.2 Server → Client Messages

#### `JOIN_ACK`
Confirms the user has joined and loads the initial state.
```json
{
  "type": "JOIN_ACK",
  "sessionId": "uuid-session",
  "siteId": "33333333-3333-3333-3333-333333333333",
  "snapshot": {
    "seq": 42,
    "nodes": [
      { "clock": 1, "siteId": "x", "value": "a", "tombstoned": false }
    ]
  },
  "missedOps": [],
  "presence": []
}
```

#### `OP_ACK`
Acknowledges processing of a client's operation.
```json
{
  "type": "OP_ACK",
  "clientSeq": 5,
  "serverSeq": 43,
  "timestamp": "2026-06-29T11:00:00.000Z"
}
```

#### `BROADCAST`
Sent to all clients connected to the document when a peer edits.
```json
{
  "type": "BROADCAST",
  "envelope": {
    "id": "uuid-env",
    "docId": "uuid",
    "sessionId": "uuid-session",
    "userId": "uuid-user",
    "seq": 43,
    "clientSeq": 5,
    "op": { "type": "INSERT", "uid": { "clock": 10, "siteId": "x" }, "after": null, "value": "a" },
    "vectorClock": {},
    "timestamp": "2026-06-29T11:00:00.000Z"
  }
}
```

#### `PRESENCE_UPDATE`
Sent when a peer's cursor position or typing state changes.
```json
{
  "type": "PRESENCE_UPDATE",
  "presence": {
    "sessionId": "uuid",
    "userId": "uuid",
    "displayName": "Bob",
    "color": "#00ff00",
    "cursor": { "afterUid": { "clock": 1, "siteId": "x" }, "anchorUid": null },
    "isTyping": true,
    "lastSeen": "2026-06-29T11:00:00.000Z"
  }
}
```
