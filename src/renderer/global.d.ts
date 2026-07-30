import type { EtchApi } from '../shared/ipc'

declare global {
  interface Window {
    etch: EtchApi
  }
}

export {}
