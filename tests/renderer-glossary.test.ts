import { describe, expect, it } from 'vitest'
import { glossaryImpactCounts } from '../src/renderer/glossary-impact'
import type { GlossaryImpactPreview } from '../src/shared/ipc'

function preview(
  impacts: GlossaryImpactPreview['impacts'],
  finalCues: GlossaryImpactPreview['finalCues']
): GlossaryImpactPreview {
  return {
    taskId: crypto.randomUUID(),
    revision: 1,
    impactFingerprint: '1'.repeat(64),
    finalCues,
    impacts
  }
}

describe('glossaryImpactCounts', () => {
  it('counts each cue once when one glossary edit changes it and another edit is unmatched', () => {
    const result = glossaryImpactCounts(preview([
      {
        index: 0,
        source: 'agent',
        previousTarget: '智能体',
        nextTarget: '代理',
        cues: [{ cueId: 1, before: '智能体', after: '代理', matched: true, matchedVariant: '智能体', reason: 'matched-target' }]
      },
      {
        index: 1,
        source: 'broker',
        previousTarget: '经纪人',
        nextTarget: '代理人',
        cues: [{ cueId: 1, before: '智能体', after: '智能体', matched: false, reason: 'target-not-found' }]
      }
    ], [{ cueId: 1, before: '智能体', after: '代理' }]))

    expect(result).toEqual({ changed: 1, unmatched: 1 })
  })

  it('does not double-count one cue changed by two non-overlapping glossary edits', () => {
    const result = glossaryImpactCounts(preview([
      {
        index: 0,
        source: 'agent',
        previousTarget: '智能体',
        nextTarget: '代理',
        cues: [{ cueId: 1, before: '智能体连接代理。', after: '代理连接代理。', matched: true, matchedVariant: '智能体', reason: 'matched-target' }]
      },
      {
        index: 1,
        source: 'proxy',
        previousTarget: '代理',
        nextTarget: '经纪人',
        cues: [{ cueId: 1, before: '智能体连接代理。', after: '智能体连接经纪人。', matched: true, matchedVariant: '代理', reason: 'matched-target' }]
      }
    ], [{ cueId: 1, before: '智能体连接代理。', after: '代理连接经纪人。' }]))

    expect(result).toEqual({ changed: 1, unmatched: 0 })
  })

  it('uses the merged final cue result instead of counting per-edit partial previews', () => {
    const result = glossaryImpactCounts(preview([
      {
        index: 0,
        source: 'agent',
        previousTarget: '智能体',
        nextTarget: '代理',
        cues: [{ cueId: 1, before: '智能体', after: '代理', matched: true, matchedVariant: '智能体', reason: 'matched-target' }]
      }
    ], [{ cueId: 1, before: '智能体', after: '智能体' }]))

    expect(result).toEqual({ changed: 0, unmatched: 0 })
  })
})
