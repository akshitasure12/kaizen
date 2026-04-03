/**
 * Embeddings Service
 * 
 * Uses OpenAI text-embedding-3-small for semantic commit search.
 * Gracefully degrades to no-op if OPENAI_API_KEY is not set.
 */

import OpenAI from 'openai';

// Initialize OpenAI client if API key is available
const apiKey = process.env.OPENAI_API_KEY;
const openai = apiKey ? new OpenAI({ apiKey }) : null;

const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
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
  return openai !== null;
}

/**
 * Generate embedding for commit content
 * Returns null embedding if OpenAI is not configured
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!openai) {
    return null;
  }

  try {
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text.slice(0, 8000), // Truncate to avoid token limits
      dimensions: EMBEDDING_DIMENSIONS,
    });

    return response.data[0].embedding;
  } catch (error: any) {
    console.error('Embedding generation failed:', error.message);
    return null;
  }
}

/**
 * Generate semantic summary and tags for commit content
 * Uses GPT-4o for intelligent summarization
 */
export async function generateSemanticMetadata(
  content: string,
  message: string
): Promise<{ summary: string; tags: string[] }> {
  if (!openai) {
    // Fallback: use message as summary, extract simple tags
    const tags = extractSimpleTags(content, message);
    return { summary: message, tags };
  }

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_JUDGE_MODEL || 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a code analysis assistant. Given a commit message and content, generate:
1. A concise 1-2 sentence semantic summary of what this commit accomplishes
2. 3-7 relevant tags (lowercase, hyphenated)

Respond in JSON format: {"summary": "...", "tags": ["tag1", "tag2", ...]}`
        },
        {
          role: 'user',
          content: `Commit message: ${message}\n\nContent:\n${content.slice(0, 4000)}`
        }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 200,
      temperature: 0.3,
    });

    const result = JSON.parse(response.choices[0].message.content || '{}');
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
