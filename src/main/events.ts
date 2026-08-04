/**
 * Tiny main-process event sink, so modules like the tray can poke the renderer
 * without importing index.ts (which would be an import cycle).
 */
let sink: (channel: string, payload?: unknown) => void = () => {}

export function setBroadcast(fn: (channel: string, payload?: unknown) => void): void {
  sink = fn
}

/** Send a signal, and optionally a payload, to every renderer. */
export function broadcast(channel: string, payload?: unknown): void {
  sink(channel, payload)
}
