import { z } from 'zod';
import type { MessageCursor } from './chat.types.js';

export const MAX_MESSAGE_LENGTH = 2000;
export const DEFAULT_HISTORY_PAGE = 30;
export const MAX_HISTORY_PAGE = 100;

// Control characters other than tab and newline have no place in a chat
// message and can upset terminals and logs.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// Counted in characters (code points), as PostgreSQL's char_length does, so
// the API and the database agree on the limit.
const characters = (s: string) => [...s].length;

export const messageBody = z
  .string({ error: 'must be text' })
  .transform((s) => s.replace(/\r\n?/g, '\n').replace(CONTROL, '').trim())
  .pipe(
    z
      .string()
      .min(1, { error: 'must not be empty' })
      .refine((s) => characters(s) <= MAX_MESSAGE_LENGTH, { error: `must be at most ${MAX_MESSAGE_LENGTH} characters` }),
  );

// Strict: the sender and conversation never come from the body.
export const sendMessageBody = z
  .object({
    clientId: z.uuid({ error: 'must be a valid id' }),
    body: messageBody,
  })
  .strict();

export type SendMessageBody = z.infer<typeof sendMessageBody>;

export const openConversationBody = z.object({ borrowRequestId: z.uuid({ error: 'must be a valid id' }) }).strict();

export const conversationParams = z.object({ id: z.uuid({ error: 'must be a valid id' }) });

export const conversationListQuery = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

// Cursors are opaque to clients: base64url of the last message's exact
// timestamp and id.
export function encodeCursor(c: MessageCursor): string {
  return Buffer.from(JSON.stringify([c.createdAt, c.id])).toString('base64url');
}

const cursorShape = z.tuple([z.string().min(1).max(64), z.uuid()]);

export function decodeCursor(value: string): MessageCursor | null {
  try {
    const parsed = cursorShape.safeParse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    if (!parsed.success || Number.isNaN(Date.parse(parsed.data[0]))) return null;
    return { createdAt: parsed.data[0], id: parsed.data[1] };
  } catch {
    return null;
  }
}

export const messageHistoryQuery = z.object({
  before: z
    .string()
    .max(200)
    .transform((v, ctx) => {
      const cursor = decodeCursor(v);
      if (!cursor) {
        ctx.addIssue({ code: 'custom', message: 'is not a valid cursor' });
        return z.NEVER;
      }
      return cursor;
    })
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_HISTORY_PAGE).default(DEFAULT_HISTORY_PAGE),
});
