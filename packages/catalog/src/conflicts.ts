import type { CatalogEntry, ConflictDetail, ConflictFootprint } from './types.js'

const DIMENSIONS: readonly (keyof ConflictFootprint)[] = [
  'entryIds',
  'httpRoutes',
  'panelIds',
  'exclusiveSlots',
  'shortcuts',
  'serviceNames',
]

function routesOverlap(a: string, b: string): boolean {
  const normA = a.replace(/\/+$/, '')
  const normB = b.replace(/\/+$/, '')
  return normA === normB || normA.startsWith(`${normB}/`) || normB.startsWith(`${normA}/`)
}

/** Six-dimension static conflict checker across a candidate combination. */
export function findCombinationConflicts(entries: readonly CatalogEntry[]): ConflictDetail[] {
  const conflicts: ConflictDetail[] = []
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i]!
      const b = entries[j]!
      for (const dim of DIMENSIONS) {
        const listA = a.footprint[dim]
        const listB = b.footprint[dim]
        if (dim === 'httpRoutes') {
          for (const routeA of listA) {
            for (const routeB of listB) {
              if (routesOverlap(routeA, routeB)) {
                conflicts.push({
                  dimension: dim,
                  value: `${routeA} <-> ${routeB}`,
                  pluginA: a.id,
                  pluginB: b.id,
                })
              }
            }
          }
          continue
        }
        const setB = new Set(listB.map((v) => v.toLowerCase()))
        for (const item of listA) {
          if (setB.has(item.toLowerCase())) {
            conflicts.push({
              dimension: dim,
              value: item,
              pluginA: a.id,
              pluginB: b.id,
            })
          }
        }
      }
    }
  }
  return conflicts
}
