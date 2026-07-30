export interface InitialToolDetectionOptions<T> {
  attempts?: number
  delayMs?: number
  complete: (result: readonly T[]) => boolean
  wait?: (delayMs: number) => Promise<void>
  shouldContinue?: () => boolean
}

const wait = (delayMs: number): Promise<void> => new Promise((resolve) => globalThis.setTimeout(resolve, delayMs))

export async function detectInitialToolsWithRetry<T>(
  detect: () => Promise<T[]>,
  options: InitialToolDetectionOptions<T>
): Promise<T[]> {
  const attempts = Math.max(1, options.attempts ?? 3)
  const delayMs = Math.max(0, options.delayMs ?? 600)
  const pause = options.wait ?? wait
  let latestResult: T[] | undefined
  let latestError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1 && options.shouldContinue?.() === false) {
      if (latestResult) return latestResult
      throw latestError ?? new Error('初始工具检测已取消')
    }
    try {
      const result = await detect()
      latestResult = result
      if (options.complete(result) || attempt === attempts || options.shouldContinue?.() === false) return result
    } catch (error) {
      latestError = error
      if (attempt === attempts || options.shouldContinue?.() === false) throw error
    }
    await pause(delayMs)
  }
  throw new Error('初始工具检测没有返回结果')
}
