import { Router, type Request } from 'express';
import type { AuthGateway } from '../auth/auth.types.js';
import { getAuth, requireAuth } from '../middleware/auth.middleware.js';
import { validateBody } from '../middleware/validate.middleware.js';
import { parseOrThrow } from '../listings/listing.schemas.js';
import type { Caller } from '../listings/listing.types.js';
import {
  conversationListQuery,
  conversationParams,
  messageHistoryQuery,
  openConversationBody,
} from '../chat/chat.schemas.js';
import type { ChatService } from '../chat/chat.service.js';

export interface ConversationRouteDeps {
  gateway: AuthGateway;
  chat: ChatService;
}

// Private conversations between the borrower and lender of an accepted
// borrow request. Non-participants get 404, so ids reveal nothing. The same
// rules apply to the Socket.IO events (src/realtime/chat.socket.ts).
export function conversationRoutes({ gateway, chat }: ConversationRouteDeps) {
  const router = Router();
  const authenticated = requireAuth(gateway);
  const caller = (req: Request): Caller => {
    const { user, accessToken } = getAuth(req);
    return { userId: user.id, accessToken };
  };

  router.get('/', authenticated, async (req, res) => {
    const query = parseOrThrow(conversationListQuery, req.query);
    const { items, total } = await chat.list(caller(req), query);
    res.status(200).json({
      success: true,
      data: {
        items,
        pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) },
      },
    });
  });

  // Get-or-create for an accepted request; repeating it is harmless.
  router.post('/', authenticated, validateBody(openConversationBody), async (req, res) => {
    const { borrowRequestId } = req.body as { borrowRequestId: string };
    const conversation = await chat.openForRequest(caller(req), borrowRequestId);
    res.status(200).json({ success: true, data: { conversation } });
  });

  router.get('/:id', authenticated, async (req, res) => {
    const { id } = parseOrThrow(conversationParams, req.params);
    res.status(200).json({ success: true, data: { conversation: await chat.get(caller(req), id) } });
  });

  router.get('/:id/messages', authenticated, async (req, res) => {
    const { id } = parseOrThrow(conversationParams, req.params);
    const query = parseOrThrow(messageHistoryQuery, req.query);
    const page = await chat.history(caller(req), id, { before: query.before ?? null, limit: query.limit });
    res.status(200).json({ success: true, data: page });
  });

  // Fallback for when the socket is not connected. 201 for a new message,
  // 200 when this clientId was already stored (a retry).
  router.post('/:id/messages', authenticated, async (req, res) => {
    const { id } = parseOrThrow(conversationParams, req.params);
    const { message, duplicate } = await chat.send(caller(req), id, req.body);
    res.status(duplicate ? 200 : 201).json({ success: true, data: { message, duplicate } });
  });

  router.post('/:id/read', authenticated, async (req, res) => {
    const { id } = parseOrThrow(conversationParams, req.params);
    res.status(200).json({ success: true, data: { conversation: await chat.markRead(caller(req), id) } });
  });

  return router;
}
