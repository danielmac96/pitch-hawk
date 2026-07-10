// Resilient JSON fetch for every upstream call (MLB, ESPN, Kalshi, The Odds API).
//
// A slow or hung upstream must never burn the ~55s pg_net / edge budget, so each
// request is bounded by an AbortSignal timeout and retried with backoff on
// transient failures (network error, timeout, 429, 5xx). 4xx (other than 429)
// are treated as permanent and surfaced immediately.

export interface FetchJsonOpts {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: BodyInit | null;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Retryable: network/timeout errors, 429, and 5xx. Everything else is fatal.
function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  return true; // AbortError / TypeError (network) / etc.
}

export async function fetchJson<T = any>(url: string | URL, opts: FetchJsonOpts = {}): Promise<T> {
  const { timeoutMs = 10_000, retries = 2, backoffMs = 400, headers, method, body } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, {
        method,
        body,
        headers: { Accept: "application/json", ...(headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) {
        // Drain the body so the connection can be reused.
        await r.text().catch(() => {});
        throw new HttpError(r.status, `${method ?? "GET"} ${url} -> ${r.status}`);
      }
      return await r.json() as T;
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetryable(err)) break;
      await sleep(backoffMs * Math.pow(2, attempt)); // 400ms, 800ms, 1600ms, …
    }
  }
  throw lastErr;
}
