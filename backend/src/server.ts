import cors from "@fastify/cors";
import Fastify from "fastify";
import fastifyRawBody from "fastify-raw-body";
import { env } from "./env";
import { authPlugin } from "./middleware/auth";
import { agentRoutes } from "./routes/agents";
import { repositoryRoutes } from "./routes/repositories";
import { branchRoutes } from "./routes/branches";
import { commitRoutes } from "./routes/commits";
import { pullRequestRoutes } from "./routes/pullrequests";
import { authRoutes } from "./routes/auth";
import { issueRoutes } from "./routes/issues";
import { leaderboardRoutes } from "./routes/leaderboard";
import { blockchainRoutes } from "./routes/blockchain";
import { githubIntegrationRoutes } from "./routes/github";
import { githubWebhookRoutes } from "./routes/github-webhook";
import { gitJobRoutes } from "./routes/git-jobs";
import { isEmbeddingsEnabled } from "./services/embeddings";
import { isRealJudge } from "./services/judge";
import {
  isBlockchainEnabled,
  getBlockchainConfig,
} from "./services/blockchain";

function parseCorsOrigin(raw: string): boolean | string | string[] {
  const t = raw.trim();
  if (t === "*" || t === "") return true;
  const parts = t
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 1) return parts[0];
  return parts;
}

async function buildApp() {
  const app = Fastify({
    logger: env.NODE_ENV === "development",
  });

  await app.register(cors, {
    origin: parseCorsOrigin(env.CORS_ORIGIN),
  });

  await app.register(fastifyRawBody, {
    field: "rawBody",
    global: false,
    encoding: false,
    runFirst: true,
    routes: ["/integrations/github/webhook"],
  });

  await app.register(authPlugin);

  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(agentRoutes, { prefix: "/agents" });
  await app.register(repositoryRoutes, { prefix: "/repositories" });
  await app.register(branchRoutes, { prefix: "/repositories" });
  await app.register(commitRoutes, { prefix: "/repositories" });
  await app.register(pullRequestRoutes, { prefix: "/repositories" });
  await app.register(issueRoutes, { prefix: "/repositories" });
  await app.register(gitJobRoutes);
  await app.register(leaderboardRoutes, { prefix: "/leaderboard" });
  await app.register(blockchainRoutes, { prefix: "/blockchain" });
  await app.register(githubIntegrationRoutes, { prefix: "/integrations" });
  await app.register(githubWebhookRoutes, { prefix: "/integrations" });

  app.get("/health", async () => ({ ok: true }));

  app.get("/status", async () => ({
    ok: true,
    nodeEnv: env.NODE_ENV,
    hasDatabase: Boolean(env.DATABASE_URL),
    hasJwtSecret: Boolean(env.JWT_SECRET),
    hasGemini: Boolean(env.GEMINI_API_KEY),
    github: {
      webhook: Boolean(env.GITHUB_WEBHOOK_SECRET),
      webhookCallbackUrlConfigured: Boolean(env.GITHUB_WEBHOOK_CALLBACK_URL),
      importRepoAndWebhook: "POST /repositories/import-from-github",
      userApiKey: "PATCH /auth/github-api-key",
    },
    corsOrigin: env.CORS_ORIGIN === "*" ? "*" : "[set]",
    features: {
      embeddings: isEmbeddingsEnabled(),
      judge: isRealJudge() ? "gemini" : "mock",
      blockchain: isBlockchainEnabled(),
    },
    blockchain: getBlockchainConfig(),
  }));

  return app;
}

async function main() {
  const app = await buildApp();
  await app.listen({ host: env.HOST, port: env.PORT });
  app.log.info(`API listening on http://${env.HOST}:${env.PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export { buildApp };
