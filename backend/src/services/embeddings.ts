/**
 * Embeddings Service
 * 
 * Uses Gemini embeddings and text generation for semantic commit search.
 * Gracefully degrades to no-op if GEMINI_API_KEY is not set.
 */

import { GoogleGenAI } from '@google/genai';
import { buildGeminiThinkingConfig } from './gemini-orchestration';

const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const gemini = apiKey ? new GoogleGenAI({ apiKey }) : null;

const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
const EMBEDDING_DIMENSIONS = 1536;

export interface EmbeddingResult {
  embedding: number[] | null;
  summary: string;
  tags: string[];
}

/**
 * Check if embeddings are available
 */
export function isEmbeddingsEnabled(): boolean {
  return gemini !== null;
}

/**
 * Generate embedding for commit content
 * Returns null embedding if Gemini is not configured
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!gemini) {
    return null;
  }

  try {
    const response = await gemini.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: text.slice(0, 8000),
      config: {
        outputDimensionality: EMBEDDING_DIMENSIONS,
      },
    });

    const values =
      ((response as any).embeddings?.[0]?.values as number[] | undefined) ??
      ((response as any).embedding?.values as number[] | undefined) ??
      null;
    return values;
  } catch (error: any) {
    console.error('Embedding generation failed:', error.message);
    return null;
  }
}

/**
 * Generate semantic summary and tags for commit content
 * Uses Gemini for intelligent summarization
 */
export async function generateSemanticMetadata(
  content: string,
  message: string
): Promise<{ summary: string; tags: string[] }> {
  if (!gemini) {
    // Fallback: use message as summary, extract simple tags
    const tags = extractSimpleTags(content, message);
    return { summary: message, tags };
  }

  try {
    const response = await gemini.models.generateContent({
      model: process.env.GEMINI_MODEL_FAST || 'gemini-2.5-flash-lite',
      contents: `Commit message: ${message}\n\nContent:\n${content.slice(0, 4000)}`,
      config: {
        systemInstruction:
          'You summarize code commits. Return strict JSON only. Keep summary concise and tags lowercase-hyphenated.',
        thinkingConfig: buildGeminiThinkingConfig(
          process.env.GEMINI_MODEL_FAST || 'gemini-2.5-flash-lite',
          'low',
        ),
        responseMimeType: 'application/json',
        responseJsonSchema: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['summary', 'tags'],
        },
      },
    });

    const result = JSON.parse((response.text || '{}') as string);
    return {
      summary: result.summary || message,
      tags: Array.isArray(result.tags) ? result.tags : [],
    };
  } catch (error: any) {
    console.error('Semantic metadata generation failed:', error.message);
    const tags = extractSimpleTags(content, message);
    return { summary: message, tags };
  }
}

/**
 * Process commit for semantic features (embedding + summary + tags)
 */
export async function processCommitSemantics(
  content: string,
  message: string
): Promise<EmbeddingResult> {
  // Generate embedding and metadata in parallel
  const [embedding, metadata] = await Promise.all([
    generateEmbedding(`${message}\n\n${content}`),
    generateSemanticMetadata(content, message),
  ]);

  return {
    embedding,
    summary: metadata.summary,
    tags: metadata.tags,
  };
}

/**
 * Compute cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Simple tag extraction fallback (no LLM)
 */
function extractSimpleTags(content: string, message: string): string[] {
  const text = `${message} ${content}`.toLowerCase();
  const tags: string[] = [];

  // Language detection
  if (text.includes('solidity') || text.includes('.sol') || text.includes('pragma')) {
    tags.push('solidity');
  }
  if (text.includes('typescript') || text.includes('.ts')) {
    tags.push('typescript');
  }
  if (text.includes('javascript') || text.includes('.js')) {
    tags.push('javascript');
  }
  if (text.includes('python') || text.includes('.py')) {
    tags.push('python');
  }

  // Domain detection
  if (text.includes('smart contract') || text.includes('erc20') || text.includes('erc721')) {
    tags.push('smart-contracts');
  }
  if (text.includes('audit') || text.includes('security') || text.includes('vulnerability')) {
    tags.push('security');
  }
  if (text.includes('test') || text.includes('spec')) {
    tags.push('testing');
  }
  if (text.includes('fix') || text.includes('bug') || text.includes('patch')) {
    tags.push('bugfix');
  }
  if (text.includes('feature') || text.includes('add') || text.includes('implement')) {
    tags.push('feature');
  }
  if (text.includes('refactor') || text.includes('cleanup') || text.includes('improve')) {
    tags.push('refactor');
  }
  if (text.includes('research') || text.includes('analysis') || text.includes('study')) {
    tags.push('research');
  }

  return tags.slice(0, 7);
}
