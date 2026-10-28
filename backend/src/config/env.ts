import { z } from 'zod';

// Values copied from .env.example that were never replaced. They are treated
// as missing so the server cannot start against a placeholder project.
const PLACEHOLDER = /YOUR_PROJECT|YOUR_PUBLISHABLE_KEY|YOUR_SECRET_KEY/;

const emptyToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const secret = () =>
  z
    .string()
    .trim()
    .min(20, { error: 'looks too short to be a valid key' })
    .refine((v) => !PLACEHOLDER.test(v), { error: 'still contains the placeholder value' });

const httpUrl = z
  .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
  .refine((v) => !PLACEHOLDER.test(v), { error: 'still contains the placeholder value' });

const origin = z
  .url({ protocol: /^https?$/ })
  .transform((v) => new URL(v).origin);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.preprocess(
      emptyToUndefined,
      z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
    ),
    // Comma-separated browser origins allowed by CORS. Native mobile clients
    // send no Origin header and are unaffected.
    FRONTEND_ORIGIN: z
      .string()
      .default('http://localhost:8081')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
      .pipe(z.array(origin)),
    // Number of reverse-proxy hops to trust for the client IP (rate limiting).
    // 0 means the API is reached directly.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

    SUPABASE_URL: z.preprocess(emptyToUndefined, httpUrl),
    SUPABASE_PUBLISHABLE_KEY: z.preprocess(emptyToUndefined, secret()),
    // Bypasses Row-Level Security. Optional: features that need it report a
    // 503 configuration error when it is absent.
    SUPABASE_SECRET_KEY: z.preprocess(emptyToUndefined, secret().optional()),

    // Where the link in the confirmation email sends the user after Supabase
    // verifies it. Must also be listed under Auth -> URL Configuration ->
    // Redirect URLs in the Supabase dashboard. Unset uses the project Site URL.
    AUTH_EMAIL_REDIRECT_URL: z.preprocess(emptyToUndefined, httpUrlOrDeepLink().optional()),
    // Where Google OAuth returns after consent. Same dashboard allow-list rule.
    AUTH_OAUTH_REDIRECT_URL: z.preprocess(emptyToUndefined, httpUrlOrDeepLink().optional()),

    // Phone verification. The cooldown must be at least Supabase's "SMS max
    // frequency" (Auth -> Rate Limits), or Supabase refuses some resends.
    PHONE_OTP_RESEND_COOLDOWN_SECONDS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(30).max(3600).default(60)),
    // Must match the "SMS OTP length" set in Supabase (Auth -> Providers -> Phone).
    PHONE_OTP_LENGTH: z.preprocess(emptyToUndefined, z.coerce.number().int().min(6).max(10).default(6)),
    // Comma-separated country calling codes SMS may be sent to (e.g. "92").
    // Empty allows every country; limiting it reduces SMS-pumping fraud.
    PHONE_ALLOWED_COUNTRY_CODES: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim().replace(/^\+/, ''))
          .filter(Boolean),
      )
      .pipe(z.array(z.string().regex(/^[1-9][0-9]{0,2}$/, { error: 'must be country calling codes such as 92,971' }))),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.SUPABASE_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['SUPABASE_URL'], message: 'must use https in production' });
    }
  });

// Mobile deep links (neighborshare://...) are valid redirect targets as well
// as web URLs.
function httpUrlOrDeepLink() {
  return z
    .string()
    .trim()
    .refine(
      (v) => {
        try {
          const url = new URL(v);
          return url.protocol !== 'javascript:' && url.protocol !== 'data:';
        } catch {
          return false;
        }
      },
      { error: 'must be an absolute URL or app deep link' },
    );
}

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  corsOrigins: string[];
  trustProxyHops: number;
  supabase: {
    url: string;
    publishableKey: string;
    secretKey: string | undefined;
  };
  auth: {
    emailRedirectUrl: string | undefined;
    oauthRedirectUrl: string | undefined;
  };
  phoneVerification: {
    resendCooldownSeconds: number;
    otpLength: number;
    // Calling codes without "+"; empty means any.
    allowedCountryCodes: string[];
  };
}

// Raised when the environment is invalid. The message names variables and
// what is wrong with them, never their values, so it is safe to print.
export class ConfigValidationError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid server configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigValidationError';
    this.problems = problems;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(environment)';
      // Zod messages describe the rule, not the input; the value is never printed.
      const raw = env[String(issue.path[0])];
      const missing = raw === undefined || raw.trim() === '';
      const message = issue.code === 'invalid_type' ? (missing ? 'is required' : 'has an invalid value') : issue.message;
      return `${name} ${message}`;
    });
    throw new ConfigValidationError(problems);
  }

  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === 'test' ? 'silent' : 'info'),
    corsOrigins: e.FRONTEND_ORIGIN,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    supabase: {
      url: e.SUPABASE_URL.replace(/\/+$/, ''),
      publishableKey: e.SUPABASE_PUBLISHABLE_KEY,
      secretKey: e.SUPABASE_SECRET_KEY,
    },
    auth: {
      emailRedirectUrl: e.AUTH_EMAIL_REDIRECT_URL,
      oauthRedirectUrl: e.AUTH_OAUTH_REDIRECT_URL,
    },
    phoneVerification: {
      resendCooldownSeconds: e.PHONE_OTP_RESEND_COOLDOWN_SECONDS,
      otpLength: e.PHONE_OTP_LENGTH,
      allowedCountryCodes: e.PHONE_ALLOWED_COUNTRY_CODES,
    },
  };
}
