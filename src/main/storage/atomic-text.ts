import { writeAtomic } from './atomic-write'

export async function writeTextAtomic(path: string, value: string): Promise<void> {
  await writeAtomic(path, value)
}
