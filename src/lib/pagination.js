// Cursor pagination over UUIDv7 ids (time-ordered): cursor = last id seen.
// Stable under concurrent inserts, O(limit) with the (tenant_id, id DESC) indexes.

export const pageQuery = {
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  cursor: { type: 'string', format: 'uuid' },
};

/** Schema for a paginated response of `item`. */
export const pageOf = (item) => ({
  type: 'object',
  properties: {
    data: { type: 'array', items: item },
    nextCursor: { type: ['string', 'null'] },
  },
});

/**
 * Callers fetch limit + 1 rows; the extra row only signals there is a next page.
 * @template {{ id: string }} T
 * @param {T[]} rows
 * @param {number} limit
 */
export function toPage(rows, limit) {
  const data = rows.slice(0, limit);
  return { data, nextCursor: rows.length > limit ? data.at(-1).id : null };
}
