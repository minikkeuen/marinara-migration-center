(() => {
  "use strict";

  const DEFAULT_MAX_RETRIES = 4;
  const DEFAULT_MIN_INTERVAL_MS = 125;
  const DEFAULT_BACKOFF_BASE_MS = 1_000;
  const DEFAULT_MAX_BACKOFF_MS = 30_000;
  const RETRY_AFTER_SAFETY_MS = 250;

  function parseRetryAfter(value, now = Date.now()) {
    if (typeof value !== "string" || !value.trim()) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
  }

  function retryDelay(error, attempt, options = {}) {
    const baseMs = Number.isFinite(options.backoffBaseMs) ? Math.max(0, options.backoffBaseMs) : DEFAULT_BACKOFF_BASE_MS;
    const maxMs = Number.isFinite(options.maxBackoffMs) ? Math.max(baseMs, options.maxBackoffMs) : DEFAULT_MAX_BACKOFF_MS;
    const retryAfterMs = Number.isFinite(error?.retryAfterMs) ? Math.max(0, error.retryAfterMs) : null;
    const fallbackMs = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
    return Math.max(fallbackMs, retryAfterMs ?? 0) + RETRY_AFTER_SAFETY_MS;
  }

  function createRequestScheduler(options) {
    if (typeof options?.request !== "function") throw new TypeError("request 함수가 필요합니다.");
    const request = options.request;
    const wait = typeof options.wait === "function" ? options.wait : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const now = typeof options.now === "function" ? options.now : Date.now;
    const minIntervalMs = Number.isFinite(options.minIntervalMs) ? Math.max(0, options.minIntervalMs) : 0;
    const defaultMaxRetries = Number.isInteger(options.maxRetries) ? Math.max(0, options.maxRetries) : DEFAULT_MAX_RETRIES;
    let nextRequestAt = 0;

    async function waitForGate() {
      const delayMs = Math.max(0, nextRequestAt - now());
      if (delayMs > 0) await wait(delayMs);
    }

    async function run(path, requestOptions, runOptions = {}) {
      const maxRetries = Number.isInteger(runOptions.maxRetries) ? Math.max(0, runOptions.maxRetries) : defaultMaxRetries;
      let retryAttempt = 0;
      while (true) {
        await waitForGate();
        nextRequestAt = Math.max(nextRequestAt, now() + minIntervalMs);
        try {
          return await request(path, requestOptions);
        } catch (error) {
          if (error?.status !== 429) throw error;
          const delayMs = retryDelay(error, retryAttempt, options);
          nextRequestAt = Math.max(nextRequestAt, now() + delayMs);
          if (retryAttempt >= maxRetries) throw error;
          retryAttempt += 1;
          runOptions.onRetry?.({ attempt: retryAttempt, delayMs, error });
        }
      }
    }

    return { run };
  }

  globalThis.MarinaraChatImportRequestCore = Object.freeze({
    DEFAULT_MAX_RETRIES,
    DEFAULT_MIN_INTERVAL_MS,
    parseRetryAfter,
    retryDelay,
    createRequestScheduler,
  });
})();
