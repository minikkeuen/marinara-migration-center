import fs from "node:fs";
import vm from "node:vm";

const context = { globalThis: {}, Date, setTimeout };
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL("./chat-import-request-core.js", import.meta.url), "utf8"), context);
const core = context.globalThis.MarinaraChatImportRequestCore;
const checks = [];
const check = (name, condition) => {
  if (!condition) throw new Error(`Failed: ${name}`);
  checks.push(name);
};

check("Retry-After seconds are parsed", core.parseRetryAfter("7", 0) === 7_000);
check(
  "Retry-After HTTP dates are parsed",
  core.parseRetryAfter("Thu, 01 Jan 1970 00:00:08 GMT", 1_000) === 7_000,
);
check("invalid Retry-After values are ignored", core.parseRetryAfter("later", 0) === null);
check(
  "server Retry-After is not shortened by the fallback cap",
  core.retryDelay({ retryAfterMs: 60_000 }, 0) === 60_250,
);

let clock = 0;
const calls = [];
const responses = [
  Object.assign(new Error("Too many requests"), { status: 429, retryAfterMs: 2_000 }),
  { id: "message-1" },
  { id: "message-2" },
];
const scheduler = core.createRequestScheduler({
  request: async (path) => {
    calls.push({ path, at: clock });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  },
  wait: async (milliseconds) => {
    clock += milliseconds;
  },
  now: () => clock,
  minIntervalMs: core.DEFAULT_MIN_INTERVAL_MS,
});

const retried = await scheduler.run("/messages", {});
check("429 retries the same operation", retried.id === "message-1" && calls[0].path === calls[1].path);
check("Retry-After is honored", calls[1].at >= 2_250);
await scheduler.run("/messages", {});
check("bulk requests retain a 125ms minimum interval", calls[2].at - calls[1].at >= 125);

clock = 0;
const rollbackCalls = [];
const rollbackScheduler = core.createRequestScheduler({
  request: async (path) => {
    rollbackCalls.push({ path, at: clock });
    if (path === "/messages") throw Object.assign(new Error("Too many requests"), { status: 429, retryAfterMs: 3_000 });
    return null;
  },
  wait: async (milliseconds) => {
    clock += milliseconds;
  },
  now: () => clock,
});
try {
  await rollbackScheduler.run("/messages", {}, { maxRetries: 0 });
  throw new Error("Expected exhausted 429");
} catch (error) {
  check("exhausted 429 remains a failure", error.status === 429);
}
await rollbackScheduler.run("/chat", { method: "DELETE" });
check("rollback waits for the shared rate-limit gate", rollbackCalls[1].at >= 3_250);

let attempts = 0;
const exhaustedScheduler = core.createRequestScheduler({
  request: async () => {
    attempts += 1;
    throw Object.assign(new Error("Too many requests"), { status: 429, retryAfterMs: 0 });
  },
  wait: async () => {},
  now: () => 0,
  backoffBaseMs: 0,
  maxBackoffMs: 0,
});
try {
  await exhaustedScheduler.run("/messages", {});
} catch (error) {
  check("default retry limit is four retries", error.status === 429 && attempts === 5);
}

console.info(`${checks.length} chat import request regression checks passed`);
