import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue }

function normalize(value: unknown, path: string): CanonicalValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`非有限数字不能参与 fingerprint：${path}`)
    return value
  }
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${path}[${index}]`))
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => {
          if (item === undefined) throw new TypeError(`undefined 不能参与 fingerprint：${path}.${key}`)
          return [key, normalize(item, `${path}.${key}`)]
        })
    )
  }
  throw new TypeError(`不支持的 fingerprint 类型：${path}`)
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, '$'))
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function fingerprint(producer: string, version: number, input: unknown): string {
  return sha256Text(canonicalJson({ producer, version, input }))
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
