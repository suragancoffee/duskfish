/**
 * Tunable numbers for the dusk ranch. `CONFIG` is live (the tuning panel writes into it);
 * `DEFAULT_CONFIG` keeps the shipped values for comparison and reset.
 */
const defaults = {
  player: {
    /** Slow, swaggering western amble. */
    walkSpeed: 1.8,
    /** Holding Shift: a brisker trot. */
    trotSpeed: 3.0,
    turnRate: 7,
    strideLength: 0.62,
  },
  camera: {
    fov: 48,
    distance: 6.2,
    height: 2.4,
    follow: 5,
  },
  world: {
    /** Real minutes for dusk to fall into deep night. */
    nightMinutes: 6,
    /** Slow-motion factor at the moment the axe bites. */
    slowMotion: 0.22,
  },
}

type Config = typeof defaults
const clone = (c: Config): Config => JSON.parse(JSON.stringify(c)) as Config

export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze(clone(defaults))
export const CONFIG: Config = clone(defaults)
