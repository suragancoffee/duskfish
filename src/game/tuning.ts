import { CONFIG, DEFAULT_CONFIG } from './config'

type Mode = 'LIVE' | 'NEXT_ACTION' | 'NEXT_RUN'
type Boundary = 'run'
type Control = { id: string; type: 'number'; category: string; label: string; description: string; unit: string;
  default: number; min: number; max: number; step: number; applyMode: Mode; integrity: 'COSMETIC' | 'GAMEPLAY' }
type Binding = { control: Control; boundary?: Boundary; read(): number; write(value: number): void }

const bindings: Binding[] = []
const CATEGORY = { player: 'Movement', camera: 'Camera', world: 'Atmosphere' } as const

function number<S extends keyof typeof CONFIG>(section: S, key: keyof typeof CONFIG[S] & string,
  label: string, min: number, max: number, step: number, unit: string): void {
  const values = CONFIG[section] as Record<string, number>
  const defaults = DEFAULT_CONFIG[section] as Record<string, number>
  bindings.push({ control: Object.freeze({ id: `${section}.${key}`, type: 'number', category: CATEGORY[section],
    label, description: 'Updates this preview immediately.', unit, default: defaults[key], min, max, step,
    applyMode: 'LIVE', integrity: section === 'player' ? 'GAMEPLAY' : 'COSMETIC' }),
    read: () => values[key], write: value => { values[key] = value } })
}

number('player', 'walkSpeed', 'Amble speed', 0.6, 4, 0.1, 'm/s')
number('player', 'trotSpeed', 'Trot speed (Shift)', 1, 6, 0.1, 'm/s')
number('player', 'strideLength', 'Boot stride length', 0.3, 1.2, 0.02, 'm')
number('camera', 'fov', 'Field of view', 30, 80, 1, '°')
number('camera', 'distance', 'Camera distance', 3, 12, 0.1, 'm')
number('camera', 'height', 'Camera height', 0.8, 6, 0.1, 'm')
number('world', 'nightMinutes', 'Minutes until deep night', 1, 20, 0.5, 'min')
number('world', 'slowMotion', 'Axe slow-motion factor', 0.05, 1, 0.01, '×')

const byId = new Map(bindings.map(binding => [binding.control.id, binding]))
let requested = Object.fromEntries(bindings.map(({ control }) => [control.id, control.default]))
const valid = (values: Record<string, number>) => values['player.walkSpeed'] <= values['player.trotSpeed']
let unranked = false
const gameplayModified = () => bindings.some(binding => binding.control.integrity === 'GAMEPLAY' && binding.read() !== binding.control.default)

export const tuning = {
  get unranked(): boolean { return unranked },
  controls: Object.freeze(bindings.map(binding => binding.control)),
  read() {
    return { requested: { ...requested }, active: Object.fromEntries(bindings.map(binding => [binding.control.id, binding.read()])) }
  },
  apply(patch: unknown): void {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid patch')
    const entries = Object.entries(patch)
    if (entries.length > bindings.length) throw new Error('Invalid patch')
    for (const [id, value] of entries) {
      const control = byId.get(id)?.control
      if (!control || typeof value !== 'number' || !Number.isFinite(value) || value < control.min || value > control.max) throw new Error('Invalid value')
      const steps = (value - control.min) / control.step
      if (value !== control.default && Math.abs(steps - Math.round(steps)) > 1e-7) throw new Error('Invalid increment')
    }
    const candidate = { ...requested, ...patch } as Record<string, number>
    if (!valid(candidate)) throw new Error('Amble speed must not exceed trot speed')
    requested = candidate
    for (const [id, value] of entries) byId.get(id)!.write(value)
    unranked ||= gameplayModified()
  },
  activate(boundary: Boundary): void {
    for (const binding of bindings) if (binding.boundary === boundary) binding.write(requested[binding.control.id])
    unranked = gameplayModified()
  },
}
