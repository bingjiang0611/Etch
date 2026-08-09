export function parseTaskUrls(value: string): string[] {
  const lines = value.split(/\r?\n/u)
  const urls: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines[index].trim()
    if (!candidate) continue
    let parsed: URL
    try {
      parsed = new URL(candidate)
    } catch {
      throw new Error(`第 ${index + 1} 行不是有效的内容链接`)
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`第 ${index + 1} 行只支持 http 或 https 链接`)
    }
    const normalized = parsed.toString()
    if (!seen.has(normalized)) {
      seen.add(normalized)
      urls.push(normalized)
    }
  }
  if (!urls.length) throw new Error('请至少输入一个内容链接')
  if (urls.length > 50) throw new Error('一次最多新建 50 个任务')
  return urls
}
