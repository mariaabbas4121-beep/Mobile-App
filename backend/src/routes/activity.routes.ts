import { Router } from 'express';
import { z } from 'zod';
import type { AuthGateway } from '../auth/auth.types.js';
import { getAuth, requireAuth } from '../middleware/auth.middleware.js';
import { parseOrThrow } from '../listings/listing.schemas.js';
import type { ActivityService } from '../activity/activity.js';

export interface ActivityRouteDeps {
  gateway: AuthGateway;
  activity: ActivityService;
}

const activityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// The signed-in caller's own recent activity. Takes no user id: whose
// activity it is comes from the access token alone.
export function activityRoutes({ gateway, activity }: ActivityRouteDeps) {
  const router = Router();

  router.get('/', requireAuth(gateway), async (req, res) => {
    const { limit } = parseOrThrow(activityQuery, req.query);
    const { user, accessToken } = getAuth(req);
    const feed = await activity.recent({ userId: user.id, accessToken }, limit);
    res.status(200).json({ success: true, data: feed });
  });

  return router;
}
