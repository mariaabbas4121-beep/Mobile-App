// Development-time connection checks. The most common reason sign-in "hangs"
// in development is an EXPO_PUBLIC_API_URL that points at an address the
// phone cannot reach (typically the computer's old Wi-Fi IP): every request
// then waits for its timeout. These checks say so at startup instead.
// Nothing here logs tokens, credentials or request bodies.

const PRIVATE_IPV4 = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

function hostOf(urlOrHostPort: string): string | null {
  try {
    return new URL(urlOrHostPort.includes('://') ? urlOrHostPort : `http://${urlOrHostPort}`).hostname;
  } catch {
    return null;
  }
}

// Metro serves the app from the computer's current LAN address (expo-constants
// `hostUri`, e.g. "10.172.18.160:8081"). If the API URL names a different LAN
// address, the computer's IP has probably changed since .env was written.
export function apiHostMismatch(apiUrl: string | null, metroHostUri: string | null | undefined): string | null {
  if (!apiUrl || !metroHostUri) return null;
  const apiHost = hostOf(apiUrl);
  const metroHost = hostOf(metroHostUri);
  if (!apiHost || !metroHost || apiHost === metroHost) return null;
  if (!PRIVATE_IPV4.test(apiHost) || !PRIVATE_IPV4.test(metroHost)) return null;
  return (
    `EXPO_PUBLIC_API_URL uses ${apiHost}, but this app was loaded from ${metroHost}. ` +
    `If the API runs on the same computer as Metro, set EXPO_PUBLIC_API_URL=http://${metroHost}:<port> in frontend/.env ` +
    'and restart with "npx expo start -c".'
  );
}

export interface ApiProbe {
  reachable: boolean;
  durationMs: number;
  code?: string;
}

// Calls GET /health (no Supabase involved) once.
export async function probeApi(health: () => Promise<unknown>, now: () => number = Date.now): Promise<ApiProbe> {
  const started = now();
  try {
    await health();
    return { reachable: true, durationMs: now() - started };
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : 'UNKNOWN';
    return { reachable: false, durationMs: now() - started, code };
  }
}

export async function runStartupDiagnostics(deps: {
  apiUrl: string | null;
  metroHostUri: string | null | undefined;
  health: () => Promise<unknown>;
  warn: (message: string) => void;
  info: (message: string) => void;
}): Promise<void> {
  const mismatch = apiHostMismatch(deps.apiUrl, deps.metroHostUri);
  if (mismatch) deps.warn(`[api] ${mismatch}`);
  if (!deps.apiUrl) return;
  const probe = await probeApi(deps.health);
  if (probe.reachable) {
    deps.info(`[api] ${deps.apiUrl} reachable (health ${probe.durationMs} ms)`);
  } else {
    deps.warn(
      `[api] Cannot reach ${deps.apiUrl}/api/v1/health (${probe.code} after ${probe.durationMs} ms). ` +
        'Sign-in will wait for its timeout and then fail. Check that the API is running, that EXPO_PUBLIC_API_URL ' +
        "is this computer's current address, and that the phone is on the same network.",
    );
  }
}

// fetch with an upper time limit, for clients (such as the Supabase SDK used
// for Google sign-in) that otherwise wait as long as the network does. An
// aborted request rejects, so callers' loading states end.
export function fetchWithTimeout(timeoutMs: number, fetchImpl: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const outer = init?.signal;
    if (outer) {
      if (outer.aborted) controller.abort();
      else outer.addEventListener('abort', () => controller.abort(), { once: true });
    }
    return fetchImpl(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  };
}
