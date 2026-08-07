import { describe, expect, it } from 'vitest'
import { bilibiliPartitionGroupName, bilibiliPartitionLabel, groupBilibiliPartitions } from '../src/renderer/bilibili-partition-groups'
import type { BilibiliPartition } from '../src/shared/bilibili'

const partitions: BilibiliPartition[] = [
  { tid: 27, name: '综合', parentName: '动画' },
  { tid: 26, name: 'MAD·AMV', parentName: '动画' },
  { tid: 138, name: '搞笑', parentName: '生活' },
  { tid: 21, name: '日常', parentName: '生活' },
  { tid: 209, name: '生活其他', parentName: '' }
]

describe('B站分区分组', () => {
  it('keeps the source order of both groups and their partitions', () => {
    expect(groupBilibiliPartitions(partitions)).toEqual([
      { name: '动画', partitions: [partitions[0], partitions[1]] },
      { name: '生活', partitions: [partitions[2], partitions[3]] },
      { name: '生活其他', partitions: [partitions[4]] }
    ])
  })

  it('groups parentless partitions under their own name', () => {
    expect(bilibiliPartitionGroupName(partitions[4])).toBe('生活其他')
    expect(bilibiliPartitionGroupName(partitions[2])).toBe('生活')
  })

  it('labels partitions with their parent only when one exists', () => {
    expect(bilibiliPartitionLabel(partitions[2])).toBe('生活 · 搞笑')
    expect(bilibiliPartitionLabel(partitions[4])).toBe('生活其他')
  })

  it('returns no group for an empty partition list', () => {
    expect(groupBilibiliPartitions([])).toEqual([])
  })
})
