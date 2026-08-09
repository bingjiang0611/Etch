export type MediaSource = 'youtube' | 'generic'

const YOUTUBE_HOSTS = ['youtube.com', 'youtu.be', 'youtube-nocookie.com'] as const
const GENERIC_MEDIA_HOSTS = ['vimeo.com', 'x.com', 'twitter.com'] as const

function matchesHost(hostname: string, hosts: readonly string[]): boolean {
  const normalized = hostname.toLocaleLowerCase('en-US').replace(/\.$/u, '')
  return hosts.some((host) => normalized === host || normalized.endsWith(`.${host}`))
}

export function classifyMediaSourceUrl(url: string): MediaSource {
  try {
    const hostname = new URL(url).hostname
    return matchesHost(hostname, YOUTUBE_HOSTS)
      ? 'youtube'
      : 'generic'
  } catch {
    return 'generic'
  }
}

export function isSupportedMediaSourceUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false
    return matchesHost(parsed.hostname, [...YOUTUBE_HOSTS, ...GENERIC_MEDIA_HOSTS])
  } catch {
    return false
  }
}
