/** Global visibility is opt-in and applies only to aggregate statistics endpoints. */
export function globalStatisticsRequested(url) {
  return url.searchParams.get('visibility') === 'global'
}

export function tenantStatisticsDimensions(url, dimensionKey) {
  if (!globalStatisticsRequested(url)) return ['key', 'model']
  return dimensionKey === 'scope' ? ['user', 'model'] : ['model']
}

export function tenantUserLeaderboard(db, board) {
  if (!board.entries.length) return board
  const ids = board.entries.map((entry) => entry.id)
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db.prepare(`SELECT id, username FROM users WHERE id IN (${placeholders})`).all(...ids)
  const names = new Map(rows.map(({ id, username }) => [id, username]))
  return {
    ...board,
    entries: board.entries.map((entry, index) => ({
      ...entry,
      id: `rank-${index + 1}`,
      name: names.get(entry.id) || '未知',
    })),
  }
}
