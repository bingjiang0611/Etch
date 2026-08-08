const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MIN_IMAGE_BYTES = 10 * 1024
const TARGET_RATIO = 16 / 9
const RATIO_TOLERANCE = 0.03

export interface PngDimensions { width: number; height: number }

export function pngDimensions(bytes: Buffer): PngDimensions {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('配图不是合法 PNG 文件')
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') throw new Error('配图 PNG 缺少 IHDR 头')
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (!width || !height) throw new Error('配图 PNG 尺寸无效')
  return { width, height }
}

// 生成器返回的横图比例不会精确等于 16:9（实测 1792×1024 = 1.75），留 3% 容差。
export function imageIssues(bytes: Buffer): string[] {
  const issues: string[] = []
  if (bytes.length < MIN_IMAGE_BYTES) issues.push(`配图只有 ${bytes.length} bytes，小于 10 KB`)
  let dimensions: PngDimensions | undefined
  try {
    dimensions = pngDimensions(bytes)
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error))
  }
  if (dimensions) {
    const ratio = dimensions.width / dimensions.height
    if (Math.abs(ratio - TARGET_RATIO) / TARGET_RATIO > RATIO_TOLERANCE) {
      issues.push(`配图不是 16:9 横图（${dimensions.width}×${dimensions.height}）`)
    }
  }
  return issues
}

export function assertImageUsable(filename: string, bytes: Buffer): void {
  const issues = imageIssues(bytes)
  if (issues.length) throw new Error(`${filename} 未通过配图验收：${issues.join('；')}`)
}
