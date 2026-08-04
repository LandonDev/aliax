/// <reference types="vite/client" />
import type { AliaxApi } from '../../preload'

declare global {
  interface Window {
    /** Derived from the preload bridge, so the two can never drift apart. */
    aliax: AliaxApi
  }
}

export {}
