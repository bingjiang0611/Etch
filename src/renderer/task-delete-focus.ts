// After a delete the removed row is gone, so focus has to land on a neighbouring card instead of
// the page header; the following card keeps the reading position, and the previous one covers the tail.
export function deleteFocusNeighborId(taskIds: readonly string[], deletedTaskId: string): string | undefined {
  const index = taskIds.indexOf(deletedTaskId)
  if (index < 0) return undefined
  return taskIds[index + 1] ?? taskIds[index - 1]
}
