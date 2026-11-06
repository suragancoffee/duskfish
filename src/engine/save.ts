/**
 * Versioned settings + gentle progress persisted to localStorage. Corrupt, missing or older data
 * falls back to defaults per field so a bad write never bricks the game.
 */
export type Quality = 'low' | 'medium' | 'high'

export type SaveData = {
  version: 1
  musicVolume: number
  sfxVolume: number
  muted: boolean
  quality: Quality
  reducedMotion: boolean
  sensitivity: number
  invertY: boolean
  /** Lifetime split pieces (never a score; just a cosy tally). */
  wood: number
  /** Lifetime seconds spent zoning out on the rock or fence. */
  zoneSeconds: number
  hintsSeen: boolean
}

export const SAVE_KEY = 'duskfish.save.v1'

export const DEFAULT_SAVE: Readonly<SaveData> = Object.freeze({
  version: 1,
  musicVolume: 0.7,
  sfxVolume: 0.85,
  muted: false,
  quality: 'high',
  reducedMotion: false,
  sensitivity: 1,
  invertY: false,
  wood: 0,
  zoneSeconds: 0,
  hintsSeen: false,
})

const num = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback

export function parseSave(raw: string | null): SaveData {
  let obj: Record<string, unknown> = {}
  try {
    const parsed = raw ? JSON.parse(raw) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>
  } catch {
    obj = {}
  }
  const d = DEFAULT_SAVE
  return {
    version: 1,
    musicVolume: num(obj.musicVolume, 0, 1, d.musicVolume),
    sfxVolume: num(obj.sfxVolume, 0, 1, d.sfxVolume),
    muted: typeof obj.muted === 'boolean' ? obj.muted : d.muted,
    quality: obj.quality === 'low' || obj.quality === 'medium' || obj.quality === 'high' ? obj.quality : d.quality,
    reducedMotion: typeof obj.reducedMotion === 'boolean' ? obj.reducedMotion : d.reducedMotion,
    sensitivity: num(obj.sensitivity, 0.2, 3, d.sensitivity),
    invertY: typeof obj.invertY === 'boolean' ? obj.invertY : d.invertY,
    wood: Math.floor(num(obj.wood, 0, 1e9, d.wood)),
    zoneSeconds: num(obj.zoneSeconds, 0, 1e9, d.zoneSeconds),
    hintsSeen: typeof obj.hintsSeen === 'boolean' ? obj.hintsSeen : d.hintsSeen,
  }
}

export class SaveStore {
  data: SaveData
  constructor(private readonly key = SAVE_KEY) {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(key)
    } catch {
      raw = null
    }
    this.data = parseSave(raw)
  }
  update(patch: Partial<SaveData>): void {
    this.data = parseSave(JSON.stringify({ ...this.data, ...patch }))
    try {
      localStorage.setItem(this.key, JSON.stringify(this.data))
    } catch {
      // Private mode / quota: keep running with in-memory settings.
    }
  }
}
