import { Router } from 'express';

// Liveness check: confirms the API process is running. It does not contact
// Supabase and reports no configuration details.
export function healthRoutes() {
  const router = Router();
  router.get('/', (_req, res) => {
    res.status(200).json({ success: true, data: { status: 'ok' } });
  });
  return router;
}
