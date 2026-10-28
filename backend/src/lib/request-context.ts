import { AsyncLocalStorage } from 'node:async_hooks';

// The id of the HTTP request being served, available to code that has no
// access to `req` (Supabase gateways, repositories), so their log lines can
// be matched to the request's own log line and X-Request-Id header.
interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
