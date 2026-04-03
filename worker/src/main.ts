import { env } from "./env";

/**
 * Git worker (plan Phase 2): in-memory queue, temp clone, agent + judge — not implemented yet.
 */
function tick() {
  const hasDb = Boolean(env.DATABASE_URL);
  console.log(
    `[worker] alias: use npm run dev:worker (backend worker-cli) — poll=${env.WORKER_POLL_MS}ms db=${hasDb} env=${env.NODE_ENV}`,
  );
}

console.log("[worker] starting (scaffold)");
tick();
setInterval(tick, env.WORKER_POLL_MS);
