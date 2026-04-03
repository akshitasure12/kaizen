import { env } from "./env";

/**
 * Git worker (plan Phase 2): in-memory queue, temp clone, agent + judge — not implemented yet.
 */
function tick() {
  const hasDb = Boolean(env.DATABASE_URL);
  const hasGh = Boolean(env.GITHUB_APP_ID && env.GITHUB_PRIVATE_KEY);
  console.log(
    `[worker] idle scaffold poll=${env.WORKER_POLL_MS}ms db=${hasDb} github=${hasGh} env=${env.NODE_ENV}`,
  );
}

console.log("[worker] starting (scaffold)");
tick();
setInterval(tick, env.WORKER_POLL_MS);
