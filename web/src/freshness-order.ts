/** Sources with the oldest reading first, so the one that needs attention leads. A source never read comes before all the others. */
export function oldestFirst<T extends { lastUpdatedAt: string | null }>(sources: readonly T[]): T[] {
  return [...sources].sort((a, b) => (a.lastUpdatedAt === null ? -Infinity : Date.parse(a.lastUpdatedAt)) - (b.lastUpdatedAt === null ? -Infinity : Date.parse(b.lastUpdatedAt)) || 0);
}
