import { TASK_CATEGORY_COLORS, TASK_CATEGORY_MAX, TASK_CATEGORY_NAME_MAX, type TaskCategory } from '../shared/settings-schema'

// 「全部任务」与「未分类」不是真分类，用保留 tab id 表示；其余就是分类 id。
export const ALL_TASKS_TAB = 'all'
export const UNSORTED_TAB = 'unsorted'
export type CategoryTab = typeof ALL_TASKS_TAB | typeof UNSORTED_TAB | string

export function findCategory(categories: readonly TaskCategory[], id: string): TaskCategory | undefined {
  return id ? categories.find((category) => category.id === id) : undefined
}

// 引用已删除分类的任务按未分类处理，避免任务在任何 tab 下都看不见。
export function effectiveCategory(categories: readonly TaskCategory[], category: string): string {
  return findCategory(categories, category) ? category : ''
}

export function taskMatchesTab(categories: readonly TaskCategory[], category: string, tab: CategoryTab): boolean {
  if (tab === ALL_TASKS_TAB) return true
  const effective = effectiveCategory(categories, category)
  return tab === UNSORTED_TAB ? effective === '' : effective === tab
}

export function categoryCounts(
  categories: readonly TaskCategory[],
  tasks: readonly { category: string }[]
): { total: number; unsorted: number; byCategory: Record<string, number> } {
  const byCategory: Record<string, number> = Object.fromEntries(categories.map((category) => [category.id, 0]))
  let unsorted = 0
  for (const task of tasks) {
    const effective = effectiveCategory(categories, task.category)
    if (!effective) unsorted += 1
    else byCategory[effective] += 1
  }
  return { total: tasks.length, unsorted, byCategory }
}

// 分类被删或任务被移走后，停留在空 tab 上会看不到任何任务，所以回落到「全部任务」。
export function resolveTab(categories: readonly TaskCategory[], tab: CategoryTab, unsorted: number): CategoryTab {
  if (tab === UNSORTED_TAB) return unsorted ? UNSORTED_TAB : ALL_TASKS_TAB
  if (tab === ALL_TASKS_TAB) return ALL_TASKS_TAB
  return findCategory(categories, tab) ? tab : ALL_TASKS_TAB
}

export function nextCategoryColor(categories: readonly TaskCategory[]): TaskCategory['color'] {
  return TASK_CATEGORY_COLORS[categories.length % TASK_CATEGORY_COLORS.length]
}

export type CategoryDraftResult = { category: TaskCategory } | { error: string }

export function createCategoryDraft(categories: readonly TaskCategory[], name: string, now = Date.now()): CategoryDraftResult {
  const trimmed = name.trim()
  if (!trimmed) return { error: '分类名称不能为空' }
  if (trimmed.length > TASK_CATEGORY_NAME_MAX) return { error: `分类名称不能超过 ${TASK_CATEGORY_NAME_MAX} 个字` }
  if (categories.some((category) => category.name === trimmed)) return { error: `已经有叫「${trimmed}」的分类了` }
  if (categories.length >= TASK_CATEGORY_MAX) return { error: `最多只能有 ${TASK_CATEGORY_MAX} 个分类` }
  return { category: { id: `c${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: trimmed, color: nextCategoryColor(categories) } }
}

export function renameCategoryDraft(categories: readonly TaskCategory[], id: string, name: string): TaskCategory[] | { error: string } {
  const trimmed = name.trim()
  if (!trimmed) return { error: '分类名称不能为空' }
  if (categories.some((category) => category.id !== id && category.name === trimmed)) return { error: `已经有叫「${trimmed}」的分类了` }
  return categories.map((category) => (category.id === id ? { ...category, name: trimmed } : category))
}

export function moveCategory(categories: readonly TaskCategory[], id: string, delta: -1 | 1): TaskCategory[] {
  const index = categories.findIndex((category) => category.id === id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= categories.length) return [...categories]
  const next = [...categories]
  next.splice(target, 0, next.splice(index, 1)[0])
  return next
}
