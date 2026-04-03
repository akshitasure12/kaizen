/**
 * Polls `git_jobs` for pending rows (plan Phase 2 — DB-backed queue).
 * Run: npm run worker (from backend) or root dev:worker.
 */
import { env } from "./env";
import { claimNextPendingGitJob, processGitJobById } from "./services/git-job-processor";

async function tick() {
  try {
    const id = await claimNextPendingGitJob();
    if (id) {
      console.log(`[worker] processing git_job ${id}`);
      await processGitJobById(id);
      console.log(`[worker] finished git_job ${id}`);
    }
  } catch (e) {
    console.error("[worker] tick error", e);
  }
}

console.log(`[worker] poll every ${env.WORKER_POLL_MS}ms`);
void tick();
setInterval(tick, env.WORKER_POLL_MS);
