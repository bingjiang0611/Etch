import { readFile } from 'node:fs/promises'
import { AppSettingsSchema, defaultSettings, type AppSettings } from '../../shared/settings-schema'
import { writeJsonAtomic } from './atomic-json'

export class SettingsStore {
  constructor(readonly path: string, readonly homeDirectory: string) {}

  async load(): Promise<AppSettings> {
    try {
      return AppSettingsSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return defaultSettings(this.homeDirectory)
    }
  }

  async save(settings: AppSettings): Promise<void> {
    await writeJsonAtomic(this.path, AppSettingsSchema.parse(settings))
  }
}
