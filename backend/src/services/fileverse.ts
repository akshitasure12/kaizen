/**
 * Fileverse Service — Real dDocs API Integration (v7)
 *
 * Connects to the Fileverse dDocs local API server for content-addressed
 * blob storage. Falls back to in-memory mock if the server isn't running
 * or FILEVERSE_API_KEY is not set.
 *
 * Usage:
 *   Start the local server first:
 *     fileverse-api --apiKey="<your-key>"
 *
 *   Then this service auto-connects to http://localhost:3030
 */

import crypto from 'crypto';

// ─── Configuration ──────────────────────────────────────────────────────────

const FILEVERSE_API_URL = process.env.FILEVERSE_API_URL || 'http://localhost:3030';
const FILEVERSE_API_KEY = process.env.FILEVERSE_API_KEY || '';

/** In-memory fallback store (used when dDocs server is unavailable) */
const memoryStore = new Map<string, string>();

/** Whether we've confirmed the dDocs server is reachable */
let serverAvailable: boolean | null = null;

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockCid(content: string): string {
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  return `fv_mock_${hash}`;
}

/**
 * Check whether the Fileverse dDocs local server is reachable.
 * Caches the result so we only probe once per process lifecycle.
 */
async function checkServer(): Promise<boolean> {
  if (serverAvailable !== null) return serverAvailable;

  if (!FILEVERSE_API_KEY) {
    serverAvailable = false;
    return false;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${FILEVERSE_API_URL}/health`, {
      signal: controller.signal,
      headers: { 'x-api-key': FILEVERSE_API_KEY },
    });
    clearTimeout(timeout);
    serverAvailable = res.ok;
  } catch {
    serverAvailable = false;
  }

  if (serverAvailable) {
    console.log('[fileverse] Connected to dDocs server at', FILEVERSE_API_URL);
  } else {
    console.log('[fileverse] dDocs server not available — using in-memory fallback');
  }

  return serverAvailable;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Store content blob and return a content-addressed reference (CID).
 *
 * When the dDocs server is running, creates a new document via the API
 * and returns the document ID. Otherwise, falls back to in-memory with
 * a SHA-256 mock CID.
 */
export async function storeContent(content: string): Promise<string> {
  const live = await checkServer();

  if (live) {
    try {
      const res = await fetch(`${FILEVERSE_API_URL}/api/docs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': FILEVERSE_API_KEY,
        },
        body: JSON.stringify({
          title: `blob-${Date.now()}`,
          content,
          metadata: {
            type: 'agentbranch-blob',
            created: new Date().toISOString(),
          },
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as { id?: string; documentId?: string };
        const docId = data.documentId || data.id;
        if (docId) return `fv_${docId}`;
      }

      // Non-ok response — fall through to mock
      console.error('[fileverse] storeContent API error:', res.status, await res.text().catch(() => ''));
    } catch (err) {
      console.error('[fileverse] storeContent fetch error:', err);
    }
  }

  // Fallback: in-memory mock
  const cid = mockCid(content);
  memoryStore.set(cid, content);
  return cid;
}

/**
 * Retrieve content blob by its CID / document ID.
 */
export async function retrieveContent(cid: string): Promise<string | null> {
  // Check in-memory first (covers mocks and locally-cached docs)
  if (memoryStore.has(cid)) return memoryStore.get(cid)!;

  const live = await checkServer();

  if (live && cid.startsWith('fv_')) {
    const docId = cid.replace(/^fv_/, '');
    try {
      const res = await fetch(`${FILEVERSE_API_URL}/api/docs/${docId}`, {
        headers: { 'x-api-key': FILEVERSE_API_KEY },
      });

      if (res.ok) {
        const data = (await res.json()) as { content?: string };
        if (data.content !== undefined) {
          memoryStore.set(cid, data.content); // cache locally
          return data.content;
        }
      }
    } catch (err) {
      console.error('[fileverse] retrieveContent fetch error:', err);
    }
  }

  return null;
}

/**
 * Store a named document (used by fileverse-store for table persistence).
 * Creates or updates a document identified by `name`.
 */
export async function storeNamedDoc(name: string, content: string): Promise<string> {
  const live = await checkServer();

  if (live) {
    try {
      const res = await fetch(`${FILEVERSE_API_URL}/api/docs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': FILEVERSE_API_KEY,
        },
        body: JSON.stringify({
          title: `agentbranch-table-${name}`,
          content,
          metadata: {
            type: 'agentbranch-table',
            table_name: name,
            updated: new Date().toISOString(),
          },
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as { id?: string; documentId?: string };
        return data.documentId || data.id || name;
      }
    } catch (err) {
      console.error(`[fileverse] storeNamedDoc(${name}) error:`, err);
    }
  }

  // Fallback: in-memory
  memoryStore.set(`table:${name}`, content);
  return name;
}

/**
 * Retrieve a named document.
 */
export async function retrieveNamedDoc(name: string): Promise<string | null> {
  // Check in-memory
  const memKey = `table:${name}`;
  if (memoryStore.has(memKey)) return memoryStore.get(memKey)!;

  const live = await checkServer();

  if (live) {
    try {
      // Search for the document by title
      const res = await fetch(`${FILEVERSE_API_URL}/api/docs?title=agentbranch-table-${name}`, {
        headers: { 'x-api-key': FILEVERSE_API_KEY },
      });

      if (res.ok) {
        const data = (await res.json()) as { docs?: Array<{ content?: string }> };
        if (data.docs && data.docs.length > 0 && data.docs[0].content) {
          memoryStore.set(memKey, data.docs[0].content);
          return data.docs[0].content;
        }
      }
    } catch (err) {
      console.error(`[fileverse] retrieveNamedDoc(${name}) error:`, err);
    }
  }

  return null;
}

/**
 * Check if running in demo/mock mode.
 */
export function isDemo(): boolean {
  return process.env.FILEVERSE_DEMO === 'true' || !FILEVERSE_API_KEY;
}

/**
 * Check if Fileverse is connected to the live dDocs server.
 */
export function isFileverseConnected(): boolean {
  return serverAvailable === true;
}

/**
 * Initialize the Fileverse service — probes the dDocs server.
 * Call this during server startup.
 */
export async function initFileverse(): Promise<void> {
  await checkServer();
}
