/** The cards in the order of `ids` (a reorder in flight); a card the order does not know (added meanwhile) keeps its place at the end. */
export function inOrder<T extends { id: string }>(cards: readonly T[], ids: readonly string[]): T[] {
  const byId = new Map(cards.map((c) => [c.id, c]))
  const ordered = ids.flatMap((id) => {
    const card = byId.get(id)
    return card ? [card] : []
  })
  const known = new Set(ids)
  return [...ordered, ...cards.filter((c) => !known.has(c.id))]
}
