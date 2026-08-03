import type { Input } from 'electron'

export function isVideoFullscreenEscape(htmlFullscreen: boolean, input: Pick<Input, 'type' | 'key' | 'code'>): boolean {
  if (!htmlFullscreen || !['rawKeyDown', 'keyDown'].includes(input.type)) return false
  return input.key === 'Escape' || input.code === 'Escape' || input.key === '\u001b'
}
