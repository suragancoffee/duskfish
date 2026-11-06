/**
 * Pure, DOM-free rules for the dusk ranch: interaction picking, the slow fall of night,
 * lantern brightness, slow-motion pacing and woodpile layout. Unit-tested in tests/rules.test.ts.
 */

export type SpotKind = 'chop' | 'sit' | 'lantern'

export type Spot = {
  id: string
  kind: SpotKind
  x: number
  z: number
  /** How close the fish must stand (metres from spot centre) to interact. */
  reach: number
}

/** Closest spot the player can reach, or null. */
export function nearestSpot(spots: readonly Spot[], x: number, z: number): Spot | null {
  let best: Spot | null = null
  let bestD = Infinity
  for (const s of spots) {
    const d = Math.hypot(s.x - x, s.z - z)
    if (d <= s.reach && d < bestD) {
      best = s
      bestD = d
    }
  }
  return best
}

/**
 * Night depth 0 (golden dusk) → 1 (deep night) over `minutes`, holds for a while, then a dreamlike
 * drift back to dusk so a long idle session keeps changing. Returns 0..1.
 */
export function nightAt(seconds: number, minutes: number): number {
  const fall = Math.max(1, minutes * 60)
  const hold = fall * 0.5
  const rise = fall * 0.4
  const cycle = fall + hold + rise
  const t = ((seconds % cycle) + cycle) % cycle
  if (t < fall) return smooth(t / fall)
  if (t < fall + hold) return 1
  return 1 - smooth((t - fall - hold) / rise)
}

export type LanternLevel = 0 | 1 | 2

export function nextLanternLevel(level: LanternLevel): LanternLevel {
  return level === 0 ? 1 : level === 1 ? 2 : 0
}

/** Point-light intensity: higher wick levels, and a deeper night makes the same flame matter more. */
export function lanternIntensity(level: LanternLevel, night: number): number {
  if (level === 0) return 0
  const base = level === 1 ? 2.2 : 5.5
  return base * (0.7 + 0.6 * clamp01(night))
}

/** Chop timeline (seconds of chop time): windup, swing, impact at CHOP_IMPACT, recovery. */
export const CHOP_IMPACT = 1.05
export const CHOP_DURATION = 2.6

/** Time scale during a chop: real-time windup, eased into slow motion around the impact. */
export function chopTimeScale(t: number, slow: number): number {
  const a = CHOP_IMPACT - 0.2
  const b = CHOP_IMPACT + 0.28
  if (t <= a - 0.1 || t >= b + 0.25) return 1
  if (t < a) return lerp(1, slow, (t - (a - 0.1)) / 0.1)
  if (t <= b) return slow
  return lerp(slow, 1, (t - b) / 0.25)
}

/** Pile slot for the n-th split piece: rows of 6 laid along x, alternating layer offsets. */
export const PILE_COLUMNS = 6
export const PILE_LAYERS = 9
export const PILE_CAPACITY = PILE_COLUMNS * PILE_LAYERS

export function pileSlot(index: number): { x: number; y: number; z: number; flip: boolean } {
  const i = Math.max(0, Math.min(PILE_CAPACITY - 1, Math.floor(index)))
  const layer = Math.floor(i / PILE_COLUMNS)
  const col = i % PILE_COLUMNS
  const offset = layer % 2 === 0 ? 0 : 0.16
  return { x: (col - (PILE_COLUMNS - 1) / 2) * 0.32 + offset, y: layer * 0.155, z: 0, flip: (i + layer) % 2 === 1 }
}

/** "mm:ss" for the gentle zone-out timer. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** Resolve a point out of a circle (2D, xz). Returns the corrected position. */
export function pushOutOfCircle(x: number, z: number, cx: number, cz: number, r: number): { x: number; z: number } {
  const dx = x - cx
  const dz = z - cz
  const d = Math.hypot(dx, dz)
  if (d >= r) return { x, z }
  if (d < 1e-6) return { x: cx + r, z: cz }
  return { x: cx + (dx / d) * r, z: cz + (dz / d) * r }
}

/** Shortest signed angle from a to b (radians). */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t)
}

export function smooth(t: number): number {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}
