export function readableRemoteError(caught: unknown, fallback: string): string {
  if (!(caught instanceof Error)) return fallback
  const message = caught.message
    .replace(/^Error invoking remote method '[^']+':\s*/u, '')
    .replace(/^(?:Error|TypeError):\s*/u, '')
    .trim()
  return message || fallback
}
