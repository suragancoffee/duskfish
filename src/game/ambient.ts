import * as THREE from 'three'

/**
 * Fireflies drifting over the grass. One Points draw call; each fly wanders on smooth
 * sine paths and blinks. Count fades in with the night and grows when the lantern is dim.
 */
const MAX = 70

const VERT = `attribute float aGlow;
varying float vGlow;
uniform float uScale;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uScale * 0.11 * (0.4 + aGlow) / -mv.z;
  vGlow = aGlow;
  gl_Position = projectionMatrix * mv;
}`
const FRAG = `varying float vGlow;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  float core = smoothstep(0.5, 0.0, r);
  float a = core * core * vGlow;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vec3(0.85, 1.0, 0.35) * (0.6 + core), a);
}`

export class Fireflies {
  readonly points: THREE.Points
  private readonly pos = new Float32Array(MAX * 3)
  private readonly glow = new Float32Array(MAX)
  private readonly seeds: { cx: number; cz: number; r: number; fx: number; fz: number; fy: number; ph: number; blink: number }[] = []
  private readonly material: THREE.ShaderMaterial
  private t = 0
  private level = 0

  constructor() {
    for (let i = 0; i < MAX; i++) {
      // Spread around the clearing, avoiding nothing in particular: they are tiny.
      const a = Math.random() * Math.PI * 2, d = 2 + Math.random() * 9
      this.seeds.push({ cx: Math.cos(a) * d, cz: 1 + Math.sin(a) * d, r: 0.4 + Math.random() * 1.2,
        fx: 0.08 + Math.random() * 0.15, fz: 0.07 + Math.random() * 0.15, fy: 0.2 + Math.random() * 0.3,
        ph: Math.random() * 100, blink: 0.25 + Math.random() * 0.35 })
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aGlow', new THREE.BufferAttribute(this.glow, 1).setUsage(THREE.DynamicDrawUsage))
    this.material = new THREE.ShaderMaterial({ uniforms: { uScale: { value: 400 } }, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    this.points = new THREE.Points(geo, this.material)
    this.points.frustumCulled = false
    this.points.renderOrder = 7
  }

  setViewport(scale: number): void {
    this.material.uniforms.uScale.value = scale
  }

  /** night 0..1; lanternLevel 0 (off) .. 2 (bright). */
  update(dt: number, night: number, lanternLevel: number): void {
    this.t += dt
    const want = THREE.MathUtils.smoothstep(night, 0.3, 0.75) * (lanternLevel === 0 ? 1 : lanternLevel === 1 ? 0.6 : 0.3)
    this.level += (want - this.level) * Math.min(1, dt * 0.5)
    const active = this.level * MAX
    const t = this.t
    for (let i = 0; i < MAX; i++) {
      const s = this.seeds[i]
      const k = t + s.ph
      this.pos[i * 3] = s.cx + Math.sin(k * s.fx * 6.28) * s.r + Math.sin(k * 0.71) * 0.15
      this.pos[i * 3 + 1] = 0.35 + Math.sin(k * s.fy * 6.28) * 0.25 + Math.max(0, Math.sin(k * 0.13)) * 0.6
      this.pos[i * 3 + 2] = s.cz + Math.cos(k * s.fz * 6.28) * s.r
      // Slow pulse with a dark rest; flies beyond the active count fade out.
      const pulse = Math.max(0, Math.sin(k * s.blink * 6.28)) ** 3
      this.glow[i] = pulse * THREE.MathUtils.clamp(active - i, 0, 1)
    }
    const g = this.points.geometry
    g.attributes.position.needsUpdate = true
    g.attributes.aGlow.needsUpdate = true
  }
}
