import { Buffer } from "buffer";
import type { PoolClient } from "pg";
import { query, queryOne, withTransaction } from "../db/client";
import { env } from "../env";
import { generateEmbedding, isEmbeddingsEnabled } from "./embeddings";
import { storeContent } from "./fileverse";

export interface KnowledgeDocument {
  id: string;
  repo_id: string;
  owner_user_id: string;
  title: string;
  source_filename: string | null;
  source_mime_type: string | null;
  content_ref: string;
  byte_size: number;
  metadata: Record<string, unknown>;
  status: "active" | "deleted";
  created_at: string;
  updated_at: string;
  chunk_count?: number;
}

export interface KnowledgeSnippet {
  document_id: string;
  chunk_id: string;
  title: string;
  source_filename: string | null;
  content: string;
  score: number;
}

export interface IngestKnowledgeDocumentInput {
  repoId: string;
  userId: string;
  title?: string;
  filename?: string;
  mimeType?: string;
  content?: string;
  fileBase64?: string;
  metadata?: Record<string, unknown>;
}

interface ParsedDocumentPayload {
  text: string;
  byteSize: number;
  sourceMimeType: string;
}

interface SearchRow {
  chunk_id: string;
  document_id: string;
  title: string;
  source_filename: string | null;
  content: string;
  similarity?: number | null;
  rank?: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function toTitle(input: {
  providedTitle?: string;
  filename?: string;
  text: string;
}): string {
  const explicit = input.providedTitle?.trim();
  if (explicit) return explicit.slice(0, 255);

  const filename = input.filename?.trim();
  if (filename) {
    const withoutExt = filename.replace(/\.[a-zA-Z0-9]+$/, "");
    const normalized = normalizeSpace(withoutExt);
    if (normalized) return normalized.slice(0, 255);
  }

  const firstLine = normalizeSpace(input.text.split("\n")[0] || "");
  if (firstLine) return firstLine.slice(0, 255);
  return "Knowledge document";
}

function inferMimeType(input: { mimeType?: string; filename?: string }): string {
  const direct = (input.mimeType || "").trim().toLowerCase();
  if (direct) return direct;

  const filename = (input.filename || "").toLowerCase().trim();
  if (filename.endsWith(".pdf")) return "application/pdf";
  if (filename.endsWith(".md") || filename.endsWith(".markdown")) return "text/markdown";
  if (filename.endsWith(".json")) return "application/json";
  if (filename.endsWith(".txt")) return "text/plain";
  return "text/plain";
}

function enforceTextByteLimit(text: string): { text: string; byteSize: number } {
  const normalized = normalizeLineEndings(text).trim();
  if (!normalized) {
    throw new Error("Document content is required");
  }
  const byteSize = Buffer.byteLength(normalized, "utf8");
  if (byteSize > env.KB_MAX_DOCUMENT_BYTES) {
    throw new Error(`Document exceeds KB_MAX_DOCUMENT_BYTES (${env.KB_MAX_DOCUMENT_BYTES})`);
  }
  return { text: normalized, byteSize };
}

export function splitKnowledgeTextIntoChunks(
  text: string,
  options: { chunkSize: number; overlap: number },
): string[] {
  return splitIntoChunks(text, options);
}

function splitIntoChunks(text: string, options: { chunkSize: number; overlap: number }): string[] {
  const normalized = normalizeLineEndings(text).trim();
  if (!normalized) return [];

  const out: string[] = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    const hardEnd = Math.min(normalized.length, cursor + options.chunkSize);
    let end = hardEnd;

    if (hardEnd < normalized.length) {
      const paragraphBreak = normalized.lastIndexOf("\n\n", hardEnd);
      if (paragraphBreak > cursor + Math.floor(options.chunkSize * 0.55)) {
        end = paragraphBreak;
      } else {
        const lineBreak = normalized.lastIndexOf("\n", hardEnd);
        if (lineBreak > cursor + Math.floor(options.chunkSize * 0.55)) {
          end = lineBreak;
        }
      }
    }

    const slice = normalized.slice(cursor, end).trim();
    if (slice.length > 0) {
      out.push(slice);
    }

    if (end >= normalized.length) {
      break;
    }

    const next = Math.max(end - options.overlap, cursor + 1);
    cursor = next;
  }

  return out;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function truncateSnippet(content: string, maxChars: number): string {
  const normalized = normalizeSpace(content);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(40, maxChars - 1)).trimEnd()}…`;
}

async function parsePdfFromBase64(base64Data: string): Promise<ParsedDocumentPayload> {
  const normalized = base64Data.includes(",") ? base64Data.split(",").pop() || "" : base64Data;
  const buffer = Buffer.from(normalized, "base64");
  if (!buffer.length) {
    throw new Error("Invalid PDF payload: file_base64 is empty");
  }

  if (buffer.length > env.KB_MAX_DOCUMENT_BYTES) {
    throw new Error(`Document exceeds KB_MAX_DOCUMENT_BYTES (${env.KB_MAX_DOCUMENT_BYTES})`);
  }

  let parser: ((data: Buffer) => Promise<{ text?: string }>) | null = null;
  try {
    const mod = (await import("pdf-parse")) as unknown as {
      default?: (data: Buffer) => Promise<{ text?: string }>;
    };
    parser = mod.default || null;
  } catch (error) {
    throw new Error(
      `PDF parser unavailable. Install backend dependency 'pdf-parse'. (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  if (!parser) {
    throw new Error("PDF parser unavailable: missing default export");
  }

  const result = await parser(buffer);
  const limited = enforceTextByteLimit((result.text || "").trim());

  return {
    text: limited.text,
    byteSize: buffer.length,
    sourceMimeType: "application/pdf",
  };
}

async function parseDocumentPayload(input: IngestKnowledgeDocumentInput): Promise<ParsedDocumentPayload> {
  const sourceMimeType = inferMimeType({
    mimeType: input.mimeType,
    filename: input.filename,
  });

  if (sourceMimeType === "application/pdf") {
    if (!input.fileBase64) {
      throw new Error("PDF uploads require file_base64 in request body");
    }
    return parsePdfFromBase64(input.fileBase64);
  }

  let text = "";
  if (typeof input.content === "string" && input.content.trim().length > 0) {
    text = input.content;
  } else if (typeof input.fileBase64 === "string" && input.fileBase64.trim().length > 0) {
    const normalized = input.fileBase64.includes(",")
      ? input.fileBase64.split(",").pop() || ""
      : input.fileBase64;
    text = Buffer.from(normalized, "base64").toString("utf8");
  }

  text = normalizeLineEndings(text).trim();
  const limited = enforceTextByteLimit(text);

  return {
    text: limited.text,
    byteSize: limited.byteSize,
    sourceMimeType,
  };
}

function normalizeMetadata(metadata: unknown): Record<string, unknown> {
  if (!isRecord(metadata)) return {};
  return metadata;
}

export function isKnowledgeBaseEnabled(): boolean {
  return env.KB_RAG_ENABLED;
}

export async function ingestKnowledgeDocument(
  input: IngestKnowledgeDocumentInput,
): Promise<KnowledgeDocument> {
  if (!isKnowledgeBaseEnabled()) {
    throw new Error("Knowledge base is disabled (KB_RAG_ENABLED=false)");
  }

  const parsed = await parseDocumentPayload(input);
  const title = toTitle({
    providedTitle: input.title,
    filename: input.filename,
    text: parsed.text,
  });

  const contentRef = await storeContent(parsed.text);
  const metadata = normalizeMetadata(input.metadata);

  const chunkSize = env.KB_CHUNK_SIZE_CHARS;
  const overlap = Math.min(env.KB_CHUNK_OVERLAP_CHARS, Math.floor(chunkSize / 3));
  const chunks = splitIntoChunks(parsed.text, { chunkSize, overlap });

  const chunkEmbeddings: Array<string | null> = [];
  for (const content of chunks) {
    const embedding = isEmbeddingsEnabled() ? await generateEmbedding(content) : null;
    chunkEmbeddings.push(embedding ? `[${embedding.join(",")}]` : null);
  }

  const documentId = await withTransaction(async (client: PoolClient) => {
    const docResult = await client.query<KnowledgeDocument>(
      `INSERT INTO kb_documents (
         repo_id,
         owner_user_id,
         title,
         source_filename,
         source_mime_type,
         content_ref,
         byte_size,
         metadata,
         status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'active')
       RETURNING *`,
      [
        input.repoId,
        input.userId,
        title,
        input.filename?.trim() || null,
        parsed.sourceMimeType,
        contentRef,
        parsed.byteSize,
        JSON.stringify(metadata),
      ],
    );

    const created = docResult.rows[0];
    if (!created) {
      throw new Error("Failed to create knowledge document");
    }

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const content = chunks[chunkIndex]!;
      await client.query(
        `INSERT INTO kb_chunks (
           document_id,
           repo_id,
           owner_user_id,
           chunk_index,
           content,
           token_estimate,
           embedding,
           metadata
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8::jsonb)`,
        [
          created.id,
          input.repoId,
          input.userId,
          chunkIndex,
          content,
          estimateTokens(content),
          chunkEmbeddings[chunkIndex] ?? null,
          JSON.stringify({
            title,
            source_filename: input.filename?.trim() || null,
          }),
        ],
      );
    }

    return created.id;
  });

  const row = await queryOne<KnowledgeDocument & { chunk_count: number }>(
    `SELECT d.*, COUNT(c.id)::int AS chunk_count
     FROM kb_documents d
     LEFT JOIN kb_chunks c ON c.document_id = d.id
     WHERE d.id = $1
     GROUP BY d.id`,
    [documentId],
  );

  if (!row) {
    throw new Error("Failed to load created knowledge document");
  }

  return row;
}

export async function listKnowledgeDocuments(params: {
  repoId: string;
  userId: string;
  limit: number;
  offset: number;
}): Promise<{ data: KnowledgeDocument[]; total: number }> {
  const docs = await query<KnowledgeDocument & { chunk_count: number }>(
    `SELECT d.*, COUNT(c.id)::int AS chunk_count
     FROM kb_documents d
     LEFT JOIN kb_chunks c ON c.document_id = d.id
     WHERE d.repo_id = $1
       AND d.owner_user_id = $2
       AND d.status = 'active'
     GROUP BY d.id
     ORDER BY d.created_at DESC
     LIMIT $3 OFFSET $4`,
    [params.repoId, params.userId, params.limit, params.offset],
  );

  const countRow = await queryOne<{ total: string }>(
    `SELECT COUNT(*)::text AS total
     FROM kb_documents
     WHERE repo_id = $1
       AND owner_user_id = $2
       AND status = 'active'`,
    [params.repoId, params.userId],
  );

  return {
    data: docs,
    total: Number(countRow?.total || "0"),
  };
}

export async function deleteKnowledgeDocument(params: {
  repoId: string;
  userId: string;
  documentId: string;
}): Promise<boolean> {
  const deleted = await queryOne<{ id: string }>(
    `UPDATE kb_documents
     SET status = 'deleted', updated_at = NOW()
     WHERE id = $1
       AND repo_id = $2
       AND owner_user_id = $3
       AND status = 'active'
     RETURNING id`,
    [params.documentId, params.repoId, params.userId],
  );
  return Boolean(deleted?.id);
}

export async function searchKnowledgeSnippets(params: {
  repoId: string;
  userId: string;
  queryText: string;
  limit?: number;
  maxSnippetChars?: number;
}): Promise<KnowledgeSnippet[]> {
  if (!isKnowledgeBaseEnabled()) return [];

  const queryText = normalizeSpace(params.queryText || "");
  if (!queryText) return [];

  const limit = Math.max(1, Math.min(30, params.limit ?? env.KB_RETRIEVAL_TOP_K));
  const maxSnippetChars = Math.max(80, Math.min(2000, params.maxSnippetChars ?? env.KB_HINT_SNIPPET_MAX_CHARS));

  let rows: SearchRow[] = [];
  if (isEmbeddingsEnabled()) {
    const embedding = await generateEmbedding(queryText);
    if (embedding) {
      rows = await query<SearchRow>(
        `SELECT
           c.id AS chunk_id,
           c.document_id,
           d.title,
           d.source_filename,
           c.content,
           1 - (c.embedding <=> $1::vector) AS similarity
         FROM kb_chunks c
         JOIN kb_documents d ON d.id = c.document_id
         WHERE c.repo_id = $2
           AND c.owner_user_id = $3
           AND d.status = 'active'
           AND c.embedding IS NOT NULL
         ORDER BY c.embedding <=> $1::vector
         LIMIT $4`,
        [`[${embedding.join(",")}]`, params.repoId, params.userId, limit],
      );
    }
  }

  if (rows.length === 0) {
    rows = await query<SearchRow>(
      `SELECT
         c.id AS chunk_id,
         c.document_id,
         d.title,
         d.source_filename,
         c.content,
         ts_rank(c.search_vector, plainto_tsquery('english', $1)) AS rank
       FROM kb_chunks c
       JOIN kb_documents d ON d.id = c.document_id
       WHERE c.repo_id = $2
         AND c.owner_user_id = $3
         AND d.status = 'active'
         AND c.search_vector @@ plainto_tsquery('english', $1)
       ORDER BY rank DESC
       LIMIT $4`,
      [queryText, params.repoId, params.userId, limit],
    );
  }

  return rows.map((row) => {
    const rawScore = row.similarity ?? row.rank ?? 0;
    const score = row.similarity != null ? clamp01(rawScore) : clamp01(rawScore / 5);
    return {
      chunk_id: row.chunk_id,
      document_id: row.document_id,
      title: row.title,
      source_filename: row.source_filename,
      content: truncateSnippet(row.content, maxSnippetChars),
      score: Number(score.toFixed(4)),
    };
  });
}

export async function buildKnowledgeSnippetsForIssue(params: {
  repoId: string;
  userId: string;
  issueTitle: string;
  issueBody?: string;
  limit?: number;
  maxSnippetChars?: number;
}): Promise<KnowledgeSnippet[]> {
  const queryText = `${params.issueTitle}\n\n${params.issueBody || ""}`.trim();
  if (!queryText) return [];
  return searchKnowledgeSnippets({
    repoId: params.repoId,
    userId: params.userId,
    queryText,
    limit: params.limit,
    maxSnippetChars: params.maxSnippetChars,
  });
}

export function formatKnowledgeSnippetsForPrompt(params: {
  snippets: KnowledgeSnippet[];
  maxChars?: number;
}): string {
  const maxChars = Math.max(240, Math.min(20000, params.maxChars ?? env.KB_JUDGE_CONTEXT_MAX_CHARS));
  if (!params.snippets.length) return "";

  const lines: string[] = ["## Repository knowledge snippets"]; 
  let usedChars = lines[0]!.length + 1;

  for (const snippet of params.snippets) {
    const labelParts: string[] = [snippet.title.trim()];
    if (snippet.source_filename) {
      labelParts.push(`source: ${snippet.source_filename}`);
    }
    labelParts.push(`score: ${snippet.score.toFixed(2)}`);

    const line = `- ${labelParts.join(" | ")}\n  ${snippet.content}`;
    if (usedChars + line.length > maxChars) {
      break;
    }
    lines.push(line);
    usedChars += line.length + 1;
  }

  if (lines.length === 1) return "";
  return lines.join("\n");
}
