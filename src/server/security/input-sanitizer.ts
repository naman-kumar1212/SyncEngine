/**
 * Input validation and sanitization using Zod schemas.
 */

import { z } from 'zod';

// UID schema
const UIDSchema = z.object({
  clock: z.number().int().nonnegative(),
  siteId: z.string().uuid(),
});

// RGA Operation schemas
const InsertOpSchema = z.object({
  type: z.literal('INSERT'),
  uid: UIDSchema,
  after: UIDSchema.nullable(),
  value: z
    .string()
    .min(1)
    .max(4)
    .refine(
      (v) => {
        // Must be a single Unicode codepoint (1-4 UTF-8 bytes)
        const codePoints = [...v].length;
        return codePoints === 1;
      },
      { message: 'value must be exactly one Unicode codepoint' },
    )
    .refine(
      (v) => {
        // Reject control characters except newline and tab
        const code = v.codePointAt(0)!;
        if (code < 32 && code !== 9 && code !== 10) return false;
        return true;
      },
      { message: 'value contains disallowed control character' },
    ),
});

const DeleteOpSchema = z.object({
  type: z.literal('DELETE'),
  uid: UIDSchema,
});

export const RGAOperationSchema = z.discriminatedUnion('type', [
  InsertOpSchema,
  DeleteOpSchema,
]);

// WebSocket message schemas
export const OperationMessageSchema = z.object({
  type: z.literal('OPERATION'),
  docId: z.string().uuid(),
  clientSeq: z.number().int().positive(),
  op: RGAOperationSchema,
  vectorClock: z.record(z.string(), z.number().int().nonnegative()),
  nonce: z.string().uuid(),
});

export const JoinMessageSchema = z.object({
  type: z.literal('JOIN'),
  docId: z.string().uuid().optional(),
  token: z.string().min(1),
  lastSeq: z.number().int().nonnegative(),
  clientId: z.string().uuid(),
});

export const PresenceMessageSchema = z.object({
  type: z.literal('PRESENCE'),
  docId: z.string().uuid(),
  update: z.object({
    sessionId: z.string().uuid(),
    cursor: z
      .object({
        afterUid: UIDSchema.nullable(),
        anchorUid: UIDSchema.nullable(),
      })
      .nullable(),
    isTyping: z.boolean(),
  }),
});

export const PingMessageSchema = z.object({
  type: z.literal('PING'),
  timestamp: z.number().int().positive(),
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  JoinMessageSchema,
  OperationMessageSchema,
  PresenceMessageSchema,
  PingMessageSchema,
]);

// REST API schemas
export const CreateDocumentSchema = z.object({
  title: z.string().min(1).max(200).trim(),
});

export const RestoreRevisionSchema = z.object({
  targetSeq: z.number().int().positive(),
  label: z.string().max(100).optional(),
});

export const RegisterSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(100).trim(),
  password: z.string().min(8).max(128),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
});

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type ValidatedOperationMessage = z.infer<typeof OperationMessageSchema>;
export type ValidatedJoinMessage = z.infer<typeof JoinMessageSchema>;
