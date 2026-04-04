import cors from "@fastify/cors";
import Fastify, { type FastifyRequest } from "fastify";
import fastifyRawBody from "fastify-raw-body";
import { env } from "./env";
import { authPlugin } from "./middleware/auth";
import { agentRoutes } from "./routes/agents";
import { repositoryRoutes } from "./routes/repositories";
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
import {
  isOnchainIndexerEnabled,
  runOnchainIndexerCycle,
} from "./services/onchain-indexer";

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

function redactHeaders(headers: FastifyRequest["headers"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower === "authorization" || lower === "cookie") {
      out[k] = "[REDACTED]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function buildApp() {
  const app = Fastify({
    logger:
      env.NODE_ENV === "development"
        ? {
            level: "info",
            serializers: {
              req(req: FastifyRequest) {
                return {
                  method: req.method,
                  url: req.url,
                  remoteAddress: req.ip,
                  remotePort: req.socket?.remotePort,
                  headers: redactHeaders(req.headers),
                };
              },
            },
          }
        : false,
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

  if (isOnchainIndexerEnabled()) {
    void runOnchainIndexerCycle().catch((e) =>
      console.warn("[onchain-indexer] initial cycle failed:", e),
    );
    setInterval(() => {
      void runOnchainIndexerCycle().catch((e) =>
        console.warn("[onchain-indexer] cycle failed:", e),
      );
    }, env.ONCHAIN_INDEXER_POLL_MS);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export { buildApp };
