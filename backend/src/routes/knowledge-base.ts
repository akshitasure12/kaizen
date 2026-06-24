import {
  FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { queryOne } from "../db/client";
import { parseListPagination, paginationMeta } from "../lib/pagination";
import { requireAuth } from "../middleware/auth";
import {
  buildKnowledgeSnippetsForIssue,
  deleteKnowledgeDocument,
  ingestKnowledgeDocument,
  listKnowledgeDocuments,
  type KnowledgeSnippet,
} from "../services/knowledge-base";

async function requireRepoImportedByUser(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!req.user?.userId) {
    return reply.status(401).send({ error: "Authentication required" });
  }

  const { repoId } = req.params as { repoId: string };
  const ok = await queryOne<{ id: string }>(
    "SELECT id FROM repositories WHERE id = $1 AND imported_by_user_id = $2",
    [repoId, req.user.userId],
  );
  if (!ok) {
    return reply.status(404).send({ error: "Repository not found" });
  }
}

const repoUserAuth = [requireAuth, requireRepoImportedByUser] as const;

function toPositiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.min(max, Math.floor(value));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(max, parsed);
    }
  }
  return fallback;
}

export async function knowledgeBaseRoutes(app: FastifyInstance) {
  app.post(
    "/:repoId/knowledge-base/documents",
    { preHandler: [...repoUserAuth] },
    async (req, reply) => {
      const { repoId } = req.params as { repoId: string };
      const body = (req.body || {}) as {
        title?: string;
        filename?: string;
        mime_type?: string;
        content?: string;
        file_base64?: string;
        metadata?: Record<string, unknown>;
      };

      try {
        const created = await ingestKnowledgeDocument({
          repoId,
          userId: req.user!.userId,
          title: body.title,
          filename: body.filename,
          mimeType: body.mime_type,
          content: body.content,
          fileBase64: body.file_base64,
          metadata: body.metadata,
        });
        return reply.status(201).send(created);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.status(400).send({ error: message });
      }
    },
  );

  app.get(
    "/:repoId/knowledge-base/documents",
    { preHandler: [...repoUserAuth] },
    async (req) => {
      const { repoId } = req.params as { repoId: string };
      const { limit, offset } = parseListPagination(req.query as Record<string, unknown>, {
        limit: 20,
        maxLimit: 100,
      });

      const result = await listKnowledgeDocuments({
        repoId,
        userId: req.user!.userId,
        limit,
        offset,
      });

      return {
        data: result.data,
        pagination: paginationMeta(result.total, limit, offset),
      };
    },
  );

  app.post(
    "/:repoId/knowledge-base/search",
    { preHandler: [...repoUserAuth] },
    async (req, reply) => {
      const { repoId } = req.params as { repoId: string };
      const body = (req.body || {}) as {
        query?: string;
        limit?: number;
      };

      const queryText = (body.query || "").trim();
      if (!queryText) {
        return reply.status(400).send({ error: "query is required" });
      }

      const snippets: KnowledgeSnippet[] = await buildKnowledgeSnippetsForIssue({
        repoId,
        userId: req.user!.userId,
        issueTitle: queryText,
        issueBody: "",
        limit: toPositiveInt(body.limit, 8, 30),
      });

      return {
        query: queryText,
        results: snippets,
      };
    },
  );

  app.delete(
    "/:repoId/knowledge-base/documents/:documentId",
    { preHandler: [...repoUserAuth] },
    async (req, reply) => {
      const { repoId, documentId } = req.params as {
        repoId: string;
        documentId: string;
      };

      const ok = await deleteKnowledgeDocument({
        repoId,
        userId: req.user!.userId,
        documentId,
      });

      if (!ok) {
        return reply.status(404).send({ error: "Knowledge document not found" });
      }

      return { ok: true, soft_deleted: true };
    },
  );
}
