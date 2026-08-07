import type { ToolHealthSnapshot } from '../shared/ipc'

// Pipeline stages detect tools while they run, so a task failure like `未找到 ffmpeg` carries
// fresher truth than the last full sweep. Merging that single snapshot keeps the footer and the
// settings rows honest without re-probing all nine tools.
export function mergeToolHealth(
  current: readonly ToolHealthSnapshot[],
  health: ToolHealthSnapshot
): ToolHealthSnapshot[] {
  if (!current.some((item) => item.tool === health.tool)) return [...current, health]
  return current.map((item) => item.tool === health.tool ? health : item)
}
