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

// A tool failure writes the detector's own `summaryZh` into the stage `errorCode`, so matching that
// wording identifies which tool blocked the stage. A ready snapshot for it means the failure is
// stale: the pipeline always pushes its own failed snapshot, so only a fresh detection turns it
// green again.
export function recoveredToolForStageFailure(
  errorCode: string | undefined,
  health: readonly ToolHealthSnapshot[]
): ToolHealthSnapshot | undefined {
  if (!errorCode) return undefined
  return health.find((item) => item.status === 'ready'
    && (errorCode === `未找到 ${item.tool}` || errorCode.startsWith(`${item.tool} `)))
}
