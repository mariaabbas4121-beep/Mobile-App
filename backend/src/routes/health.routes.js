import { Router } from 'express';

const router = Router();

// Liveness check: confirms the API process is running. It does not contact
// Supabase and reports no configuration details.
router.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'NeighborShare API is running',
  });
});

export default router;
