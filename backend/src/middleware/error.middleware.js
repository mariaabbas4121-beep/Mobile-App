import { config } from '../config/env.js';

export function notFound(req, res) {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.path}`,
  });
}

// Express recognises error handlers by their four parameters, so `next` must
// stay in the signature even though it is unused.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = Number(err.statusCode || err.status) || 500;
  const statusCode = status >= 400 && status < 600 ? status : 500;

  // Only messages marked safe (`expose`) reach the client; anything else may
  // contain internal details, so it is replaced and logged instead.
  const message = err.expose ? err.message : 'Internal server error';

  if (statusCode >= 500 && config.nodeEnv !== 'test') {
    console.error(err);
  }

  res.status(statusCode).json({ success: false, message });
}
