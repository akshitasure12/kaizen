import { env } from "./env";
import { claimNextPendingGitJob, processGitJobById } from "./services/git-job-processor";

/**
 * DB-backed git worker runtime.
 */
let inFlight = 0;

function logWorkerRuntime(event: string, details: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      source: "worker-runtime",
      event,
      ts: new Date().toISOString(),
      ...details,
    }),
  );
}

async function processOneJob(jobId: string): Promise<void> {
  inFlight += 1;
  try {
    logWorkerRuntime("job_processing_started", { job_id: jobId, in_flight: inFlight });
    await processGitJobById(jobId);
    logWorkerRuntime("job_processing_finished", { job_id: jobId, in_flight: inFlight - 1 });
  } catch (e) {
    logWorkerRuntime("job_processing_error", {
      job_id: jobId,
      in_flight: inFlight - 1,
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    inFlight -= 1;
  }
}

async function tick() {
  const available = Math.max(0, env.WORKER_CONCURRENCY - inFlight);
  if (available === 0) return;

  try {
    for (let i = 0; i < available; i += 1) {
      const id = await claimNextPendingGitJob();
      if (!id) break;
      logWorkerRuntime("job_claimed", { job_id: id, concurrency: env.WORKER_CONCURRENCY });
      void processOneJob(id);
    }
  } catch (e) {
    logWorkerRuntime("tick_error", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

logWorkerRuntime("worker_started", {
  poll_ms: env.WORKER_POLL_MS,
  concurrency: env.WORKER_CONCURRENCY,
  lease_timeout_ms: env.WORKER_LEASE_TIMEOUT_MS,
  dry_run: env.WORKER_DRY_RUN,
});
void tick();
setInterval(tick, env.WORKER_POLL_MS);
