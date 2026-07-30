import type { GlossaryImpactPreview } from '../shared/ipc'

export function glossaryImpactCounts(preview: GlossaryImpactPreview): { changed: number; unmatched: number } {
  const unmatchedCueIds = new Set<number>()
  for (const impact of preview.impacts) {
    for (const cue of impact.cues) {
      if (cue.reason === 'target-not-found') unmatchedCueIds.add(cue.cueId)
    }
  }
  return {
    changed: preview.finalCues.filter((cue) => cue.before !== cue.after).length,
    unmatched: unmatchedCueIds.size
  }
}
