export interface PaginationMeta {
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface PaginatedBody<T> {
  data: T[];
  pagination: PaginationMeta;
}

export function parseListPagination(
  query: Record<string, unknown>,
  defaults: { limit?: number; maxLimit?: number } = {},
): { limit: number; offset: number } {
  const maxLimit = defaults.maxLimit ?? 100;
  const defaultLimit = defaults.limit ?? 20;
  const rawLimit = parseInt(String(query.limit ?? ""), 10);
  const rawOffset = parseInt(String(query.offset ?? ""), 10);
  const limit = Math.min(
    maxLimit,
    Math.max(1, Number.isFinite(rawLimit) ? rawLimit : defaultLimit),
  );
  const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0);
  return { limit, offset };
}

export function paginationMeta(
  total: number,
  limit: number,
  offset: number,
): PaginationMeta {
  return {
    total,
    limit,
    offset,
    has_more: offset + limit < total,
  };
}
