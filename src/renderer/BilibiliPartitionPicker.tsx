import { useMemo, useState, type Ref } from 'react'
import type { BilibiliPartition } from '../shared/bilibili'
import { bilibiliPartitionGroupName, groupBilibiliPartitions } from './bilibili-partition-groups'

interface BilibiliPartitionPickerProps {
  partitions: readonly BilibiliPartition[]
  tid: number | undefined
  disabled?: boolean
  loading?: boolean
  groupSelectRef?: Ref<HTMLSelectElement>
  onChange: (partition: BilibiliPartition | undefined) => void
}

export function BilibiliPartitionPicker({ partitions, tid, disabled, loading, groupSelectRef, onChange }: BilibiliPartitionPickerProps): React.JSX.Element {
  const groups = useMemo(() => groupBilibiliPartitions(partitions), [partitions])
  const [pickedGroup, setPickedGroup] = useState('')
  const selected = partitions.find((partition) => partition.tid === tid)
  const groupName = selected ? bilibiliPartitionGroupName(selected) : pickedGroup
  const children = groups.find((group) => group.name === groupName)?.partitions ?? []

  return (
    <div className="partition-picker">
      <select
        className="field-select"
        aria-label="主分区"
        ref={groupSelectRef}
        disabled={disabled || loading}
        value={groups.some((group) => group.name === groupName) ? groupName : ''}
        onChange={(event) => {
          const group = groups.find((item) => item.name === event.target.value)
          setPickedGroup(group?.name ?? '')
          onChange(group?.partitions.length === 1 ? group.partitions[0] : undefined)
        }}
      >
        <option value="">{loading ? '正在读取分区…' : '请选择主分区'}</option>
        {groups.map((group) => <option value={group.name} key={group.name}>{group.name}</option>)}
      </select>
      <select
        className="field-select"
        aria-label="子分区"
        disabled={disabled || loading || !children.length}
        value={selected ? String(selected.tid) : ''}
        onChange={(event) => onChange(children.find((partition) => String(partition.tid) === event.target.value))}
      >
        <option value="">{children.length ? '请选择子分区' : '请先选择主分区'}</option>
        {children.map((partition) => <option value={partition.tid} key={partition.tid}>{partition.name}</option>)}
      </select>
    </div>
  )
}
