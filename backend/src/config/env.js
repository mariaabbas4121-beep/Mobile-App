import 'dotenv/config';

const list = (value) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

export const config = {
  port: Number(process.env.PORT) || 4000,
  nodeEnv: process.env.NODE_ENV || 'development',
  corsOrigins: list(process.env.FRONTEND_ORIGIN || 'http://localhost:8081'),
  supabase: {
    url: process.env.SUPABASE_URL?.trim() || '',
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY?.trim() || '',
    secretKey: process.env.SUPABASE_SECRET_KEY?.trim() || '',
  },
};
