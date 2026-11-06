import lock from '../../assets.lock.json'

/**
 * Runtime media lives in project Storage/CDN. The lock file maps each source path to its stable
 * `/manus-storage/...` address; the build keeps these complete paths so CDN loads stay exact.
 */
const entries = (lock as { assets: Record<string, { path: string }> }).assets

export function assetUrl(rel: string): string {
  const entry = entries[rel]
  if (!entry) throw new Error(`Unregistered asset: ${rel}`)
  return entry.path
}

export const MODELS = {
  tuna: 'assets/models/tuna.glb',
  boot: 'assets/models/boot.glb',
  shrimp: 'assets/models/prawn.glb',
  stump: 'assets/models/stump.glb',
  log: 'assets/models/log.glb',
  axe: 'assets/models/axe.glb',
  lantern: 'assets/models/lantern.glb',
  fence: 'assets/models/fence.glb',
  rock: 'assets/models/rock.glb',
  tree: 'assets/models/tree.glb',
  guitar: 'assets/models/guitar.glb',
} as const

export type ModelName = keyof typeof MODELS

export const SOUNDS = {
  chop: 'assets/audio/sfx_chop.mp3',
  step: 'assets/audio/sfx_step.mp3',
  puff: 'assets/audio/sfx_puff.mp3',
  lantern: 'assets/audio/sfx_lantern.mp3',
  stack: 'assets/audio/sfx_stack.mp3',
  sit: 'assets/audio/sfx_sit.mp3',
} as const

/** Streamed after the scene is playable (large). */
export const STREAMED_SOUNDS = {
  bgm: 'assets/audio/bgm_dusk_guitar.mp3',
  amb: 'assets/audio/amb_crickets.mp3',
} as const
