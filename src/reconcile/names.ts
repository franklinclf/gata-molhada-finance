/** Lowercase, accent-free, single-spaced text, used to compare names written differently by two sources. */
export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function institutionKey(institution: string): string {
  return normalizeName(institution);
}
