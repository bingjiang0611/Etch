import { z } from 'zod'

// 提示词里的字段上限、枚举值曾经是手抄 schema 的，抄漏一处模型就永远猜不到那条约束。
// 这里直接从 zod schema 渲染契约文本，保证提示词与本地校验器同源。

// 修复轮里允许带多少校验失败详情：宁愿多花几百 token，也不能把枚举可选值、字段路径这类关键信息截掉。
export const VALIDATION_FAILURE_PROMPT_LIMIT = 1500

// 提取模型输出中第一个匹配的完整 JSON object；字符串里的花括号与对象后解释不参与边界计算。
export function extractJsonObject(
  text: string,
  missingMessage = '输出中没有合法 JSON 对象',
  predicate?: (parsed: Record<string, unknown>) => boolean
): string {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let quoted = false
    let escaped = false
    for (let index = start; index < text.length; index += 1) {
      const character = text[index]
      if (quoted) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') quoted = false
        continue
      }
      if (character === '"') quoted = true
      else if (character === '{') depth += 1
      else if (character === '}' && --depth === 0) {
        const candidate = text.slice(start, index + 1)
        try {
          const parsed: unknown = JSON.parse(candidate)
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            !Array.isArray(parsed) &&
            (!predicate || predicate(parsed as Record<string, unknown>))
          ) return candidate
        } catch {
          // 常见的前置说明会带 {field} 这类花括号；继续寻找后续真正的 JSON object。
        }
        break
      }
    }
  }
  throw new Error(missingMessage)
}

interface Bounds {
  min?: number
  max?: number
  pattern?: string
}

function bounds(definition: { checks?: readonly unknown[] }): Bounds {
  const result: Bounds = {}
  for (const check of definition.checks ?? []) {
    const inner = (check as { _zod?: { def?: Record<string, unknown> } })._zod?.def
    if (!inner) continue
    if (inner.check === 'min_length' || inner.check === 'greater_than') {
      result.min = Number(inner.minimum ?? inner.value)
    }
    if (inner.check === 'max_length' || inner.check === 'less_than') {
      result.max = Number(inner.maximum ?? inner.value)
    }
    if (inner.check === 'string_format' && inner.pattern instanceof RegExp) {
      result.pattern = inner.pattern.source
    }
  }
  return result
}

function range(unit: string, { min, max }: Bounds): string {
  if (min !== undefined && max !== undefined) return min === max ? `${min} ${unit}` : `${min}-${max} ${unit}`
  if (max !== undefined) return `最多 ${max} ${unit}`
  if (min !== undefined) return `至少 ${min} ${unit}`
  return ''
}

function describe(schema: unknown, depth = 0): string {
  const definition = (schema as { def?: Record<string, unknown> }).def
  if (!definition) return '值'
  switch (definition.type) {
    case 'pipe':
      // z.preprocess 归一化后仍按输出类型对外声明契约。
      return describe(definition.out, depth)
    case 'optional':
    case 'nullable':
      return `${describe(definition.innerType, depth)}（可省略）`
    case 'default': {
      const fallback = typeof definition.defaultValue === 'function'
        ? (definition.defaultValue as () => unknown)()
        : definition.defaultValue
      const shown = typeof fallback === 'string' ? `"${fallback}"` : JSON.stringify(fallback)
      return `${describe(definition.innerType, depth)}（可省略，默认 ${shown}）`
    }
    case 'string': {
      const limits = bounds(definition as { checks?: readonly unknown[] })
      const detail = [range('字符', limits), limits.pattern ? `匹配 ${limits.pattern}` : ''].filter(Boolean).join('，')
      return detail ? `字符串（${detail}）` : '字符串'
    }
    case 'number': {
      const { min, max } = bounds(definition as { checks?: readonly unknown[] })
      if (min !== undefined && max !== undefined) return `数字（${min} 到 ${max}）`
      if (max !== undefined) return `数字（不超过 ${max}）`
      if (min !== undefined) return `数字（不小于 ${min}）`
      return '数字'
    }
    case 'boolean':
      return '布尔值'
    case 'literal':
      return `固定值 ${(definition.values as readonly unknown[]).map((value) => JSON.stringify(value)).join(' 或 ')}`
    case 'enum':
      return `只能取 ${Object.values(definition.entries as Record<string, unknown>).map((value) => String(value)).join('、')}`
    case 'array': {
      const detail = range('项', bounds(definition as { checks?: readonly unknown[] }))
      return `数组（${detail || '不限项数'}），每项是${describe(definition.element, depth + 1)}`
    }
    case 'record':
      return `对象（键${describe(definition.keyType, depth + 1)}），每个值是${describe(definition.valueType, depth + 1)}`
    case 'object': {
      const shape = definition.shape as Record<string, unknown>
      const fields = Object.entries(shape).map(([key, value]) => `${key}=${describe(value, depth + 1)}`)
      return `对象{ ${fields.join('；')} }`
    }
    default:
      return '值'
  }
}

/**
 * 把一个 zod object schema 渲染成逐字段的中文契约清单，直接拼进提示词。
 */
export function jsonContract(schema: z.ZodObject): string {
  const shape = schema.def.shape as Record<string, unknown>
  return Object.entries(shape).map(([key, value]) => `- ${key}：${describe(value)}`).join('\n')
}

// zod 原始报错是几千字符的 issue JSON，截断后关键信息（枚举可选值、字段路径）正好被切掉，
// 重试就成了盲改；这里压成逐条中文，让每一条链的修复轮都能拿到契约差异。
// 非 zod 错误原文返回，所以可以无差别包在任何校验失败处。
export function describeValidationFailure(error: unknown, limit = 8): string {
  if (!(error instanceof z.ZodError)) return error instanceof Error ? error.message : String(error)
  const lines = error.issues.slice(0, limit).map((issue) => {
    const location = issue.path.length
      ? issue.path.map((key) => typeof key === 'number' ? `[${key}]` : `.${String(key)}`).join('').replace(/^\./u, '')
      : '根对象'
    if (issue.code === 'invalid_value') return `${location}：只能取 ${issue.values.map((value) => String(value)).join('、')}`
    if (issue.code === 'invalid_type') return `${location}：类型必须是 ${issue.expected}`
    if (issue.code === 'too_big') return `${location}：${issue.origin === 'string' ? '文本长度' : '数量'}超过上限 ${String(issue.maximum)}`
    if (issue.code === 'too_small') return `${location}：${issue.origin === 'string' ? '文本长度' : '数量'}低于下限 ${String(issue.minimum)}`
    if (issue.code === 'unrecognized_keys') return `${location}：出现契约外的键 ${issue.keys.join('、')}`
    return `${location}：${issue.message}`
  })
  const rest = error.issues.length - lines.length
  return [...lines, rest > 0 ? `其余 ${rest} 处问题同理` : ''].filter(Boolean).join('；')
}
