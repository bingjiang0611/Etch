import type { BilibiliPartition } from '../shared/bilibili'

export interface BilibiliPartitionGroup {
  name: string
  partitions: BilibiliPartition[]
}

export function bilibiliPartitionGroupName(partition: BilibiliPartition): string {
  return partition.parentName || partition.name
}

export function bilibiliPartitionLabel(partition: BilibiliPartition): string {
  return partition.parentName ? `${partition.parentName} · ${partition.name}` : partition.name
}

export function groupBilibiliPartitions(partitions: readonly BilibiliPartition[]): BilibiliPartitionGroup[] {
  const groups: BilibiliPartitionGroup[] = []
  for (const partition of partitions) {
    const name = bilibiliPartitionGroupName(partition)
    const group = groups.find((item) => item.name === name)
    if (group) group.partitions.push(partition)
    else groups.push({ name, partitions: [partition] })
  }
  return groups
}
