import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { PILE_CAPACITY, pileSlot } from './rules'

const POINT_VERT = `attribute float aSize; attribute float aAlpha; attribute float aSeed;
uniform float uScale; varying float vAlpha; varying float vSeed;
void main(){ vAlpha = aAlpha; vSeed = aSeed; vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * uScale / max(0.1, -mv.z), 0.0, 512.0); gl_Position = projectionMatrix * mv; }`

const SMOKE_FRAG = `uniform vec3 uColor; varying float vAlpha; varying float vSeed;
void main(){ vec2 p = gl_PointCoord - 0.5; float r = length(p);
  float wob = 0.06 * sin(atan(p.y, p.x) * 3.0 + vSeed * 6.283);
  float a = smoothstep(0.5 + wob, 0.0, r); a *= a;
  gl_FragColor = vec4(uColor, a * vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

const GLOW_FRAG = `uniform vec3 uColor; varying float vAlpha; varying float vSeed;
void main(){ vec2 p = gl_PointCoord - 0.5; float r = length(p);
  float a = smoothstep(0.5, 0.0, r); a = a * a * a;
  gl_FragColor = vec4(uColor * (1.0 + vSeed * 0.3) * a * vAlpha, 1.0);
}`

type P = { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; age: number; size: number; grow: number; alpha: number; drag: number; lift: number; seed: number }

/** GPU point cloud with per-particle size and alpha; CPU integrates motion. */
export class PointPool {
  readonly points: THREE.Points
  private readonly parts: P[] = []
  private readonly pos: Float32Array
  private readonly size: Float32Array
  private readonly alpha: Float32Array
  private readonly seed: Float32Array
  readonly material: THREE.ShaderMaterial

  constructor(private readonly max: number, frag: string, color: THREE.Color, additive: boolean) {
    const geo = new THREE.BufferGeometry()
    this.pos = new Float32Array(max * 3)
    this.size = new Float32Array(max)
    this.alpha = new Float32Array(max)
    this.seed = new Float32Array(max)
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1).setUsage(THREE.DynamicDrawUsage))
    this.material = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color }, uScale: { value: 400 } },
      vertexShader: POINT_VERT,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    })
    this.points = new THREE.Points(geo, this.material)
    this.points.frustumCulled = false
    this.points.renderOrder = additive ? 6 : 5
  }

  emit(p: Partial<P> & { x: number; y: number; z: number }): void {
    if (this.parts.length >= this.max) this.parts.shift()
    this.parts.push({ vx: 0, vy: 0, vz: 0, life: 2, age: 0, size: 0.2, grow: 0, alpha: 1, drag: 0.5, lift: 0, seed: Math.random(), ...p })
  }

  update(dt: number, wind: THREE.Vector3, envelope: (age: number) => number): void {
    let n = 0
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i]
      p.age += dt
      if (p.age >= p.life) {
        this.parts.splice(i, 1)
        continue
      }
      const damp = Math.exp(-p.drag * dt)
      p.vx = (p.vx + wind.x * dt) * damp
      p.vy = (p.vy + p.lift * dt) * damp
      p.vz = (p.vz + wind.z * dt) * damp
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      p.size += p.grow * dt
    }
    for (const p of this.parts) {
      const k = p.age / p.life
      this.pos[n * 3] = p.x
      this.pos[n * 3 + 1] = p.y
      this.pos[n * 3 + 2] = p.z
      this.size[n] = p.size
      this.alpha[n] = p.alpha * envelope(k)
      this.seed[n] = p.seed
      n++
    }
    const geo = this.points.geometry
    geo.setDrawRange(0, n)
    for (const name of ['position', 'aSize', 'aAlpha', 'aSeed']) (geo.attributes[name] as THREE.BufferAttribute).needsUpdate = true
  }

  get count(): number {
    return this.parts.length
  }

  clear(): void {
    this.parts.length = 0
  }
}

type Chip = { alive: boolean; p: THREE.Vector3; v: THREE.Vector3; r: THREE.Euler; w: THREE.Vector3; age: number; life: number; s: number }

/** Smoke, glow (fireflies, embers, sparks) and physical wood chips. */
export class Effects {
  readonly group = new THREE.Group()
  readonly smoke: PointPool
  readonly glow: PointPool
  private readonly chips: THREE.InstancedMesh
  private readonly chipData: Chip[] = []
  private readonly wind = new THREE.Vector3(0.12, 0, 0.05)
  private fireflies: Array<{ base: THREE.Vector3; phase: number; speed: number; amp: number }> = []
  private readonly ff: PointPool
  private dummy = new THREE.Object3D()

  constructor(quality: 'low' | 'medium' | 'high') {
    this.smoke = new PointPool(quality === 'low' ? 220 : 420, SMOKE_FRAG, new THREE.Color(0.55, 0.5, 0.56), false)
    this.glow = new PointPool(160, GLOW_FRAG, new THREE.Color(2.4, 1.2, 0.45), true)
    this.ff = new PointPool(64, GLOW_FRAG, new THREE.Color(1.4, 1.9, 0.6), true)
    this.group.add(this.smoke.points, this.glow.points, this.ff.points)
    const chipGeo = new THREE.BoxGeometry(0.05, 0.016, 0.03)
    const chipMat = new THREE.MeshStandardMaterial({ color: 0xc9a273, roughness: 0.9 })
    this.chips = new THREE.InstancedMesh(chipGeo, chipMat, 140)
    this.chips.castShadow = true
    this.chips.frustumCulled = false
    const col = new THREE.Color()
    for (let i = 0; i < 140; i++) {
      this.chipData.push({ alive: false, p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), w: new THREE.Vector3(), age: 0, life: 1, s: 1 })
      col.setHSL(0.08 + Math.random() * 0.03, 0.45, i % 4 === 0 ? 0.25 : 0.5 + Math.random() * 0.15)
      this.chips.setColorAt(i, col)
      this.dummy.scale.setScalar(0)
      this.dummy.updateMatrix()
      this.chips.setMatrixAt(i, this.dummy.matrix)
    }
    this.group.add(this.chips)
    for (let i = 0; i < 36; i++) {
      const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 9
      this.fireflies.push({ base: new THREE.Vector3(Math.cos(a) * r, 0.4 + Math.random() * 1.4, Math.sin(a) * r - 1), phase: Math.random() * 100, speed: 0.2 + Math.random() * 0.4, amp: 0.4 + Math.random() * 0.9 })
    }
  }

  setViewportHeight(px: number, fov: number): void {
    const scale = px / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2))
    this.smoke.material.uniforms.uScale.value = scale
    this.glow.material.uniforms.uScale.value = scale
    this.ff.material.uniforms.uScale.value = scale
  }

  /** Thin cigarette wisp; `strength` > 1 for an exhaled puff. */
  wisp(at: THREE.Vector3, strength = 1): void {
    this.smoke.emit({ x: at.x + (Math.random() - 0.5) * 0.01, y: at.y, z: at.z, vx: (Math.random() - 0.5) * 0.05, vy: 0.12 + Math.random() * 0.08, vz: (Math.random() - 0.5) * 0.05,
      life: 2.6 + Math.random() * 1.6, size: 0.035 * strength, grow: 0.09 * strength, alpha: 0.32, drag: 0.6, lift: 0.05 })
  }

  puff(at: THREE.Vector3, dir: THREE.Vector3): void {
    for (let i = 0; i < 14; i++) {
      const s = 0.4 + Math.random() * 0.6
      this.smoke.emit({ x: at.x, y: at.y, z: at.z, vx: dir.x * s + (Math.random() - 0.5) * 0.15, vy: dir.y * s + 0.08 + Math.random() * 0.1, vz: dir.z * s + (Math.random() - 0.5) * 0.15,
        life: 3 + Math.random() * 2, size: 0.07 + Math.random() * 0.05, grow: 0.22, alpha: 0.36, drag: 1.4, lift: 0.08 })
    }
  }

  /** Lazy lantern chimney smoke and low ground mist. */
  ambient(lanternTop: THREE.Vector3, lanternOn: boolean, mistCenter: THREE.Vector3): void {
    if (lanternOn && Math.random() < 0.18) {
      this.smoke.emit({ x: lanternTop.x, y: lanternTop.y, z: lanternTop.z, vy: 0.1, life: 2.2, size: 0.03, grow: 0.06, alpha: 0.18, drag: 0.6, lift: 0.04 })
    }
    if (Math.random() < 0.05) {
      const a = Math.random() * Math.PI * 2, r = 3 + Math.random() * 9
      this.smoke.emit({ x: mistCenter.x + Math.cos(a) * r, y: 0.15 + Math.random() * 0.2, z: mistCenter.z + Math.sin(a) * r, vx: 0.05, life: 9 + Math.random() * 5, size: 1.4 + Math.random(), grow: 0.25, alpha: 0.07, drag: 0.1 })
    }
  }

  ember(at: THREE.Vector3, vel: THREE.Vector3, life = 0.8): void {
    this.glow.emit({ x: at.x, y: at.y, z: at.z, vx: vel.x, vy: vel.y, vz: vel.z, life, size: 0.025, alpha: 1, drag: 1.5, lift: -1.5 })
  }

  /** Wood-chip spray at the axe impact. */
  chipBurst(at: THREE.Vector3, count: number, power = 1): void {
    let made = 0
    for (const c of this.chipData) {
      if (made >= count) break
      if (c.alive) continue
      c.alive = true
      c.age = 0
      c.life = 2.2 + Math.random() * 1.5
      c.s = 0.6 + Math.random() * 1.1
      c.p.copy(at).add(new THREE.Vector3((Math.random() - 0.5) * 0.1, 0, (Math.random() - 0.5) * 0.1))
      const a = Math.random() * Math.PI * 2
      const sp = (0.8 + Math.random() * 2.2) * power
      c.v.set(Math.cos(a) * sp, (1.2 + Math.random() * 2.4) * power, Math.sin(a) * sp)
      c.r.set(Math.random() * 6, Math.random() * 6, Math.random() * 6)
      c.w.set((Math.random() - 0.5) * 22, (Math.random() - 0.5) * 22, (Math.random() - 0.5) * 22)
      made++
    }
    for (let i = 0; i < 6 * power; i++) this.ember(at, new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2), 0.5)
  }

  update(dt: number, night: number, time: number): void {
    const fade = (k: number) => Math.min(1, k * 6) * (1 - k)
    this.smoke.material.uniforms.uColor.value.setRGB(0.6 - night * 0.35, 0.52 - night * 0.3, 0.56 - night * 0.26)
    this.smoke.update(dt, this.wind, k => Math.min(1, k * 5) * (1 - k) * (1 - k))
    this.glow.update(dt, this.wind, fade)
    // Fireflies drift on smooth noise; they appear as night falls.
    const ffAlpha = THREE.MathUtils.smoothstep(night, 0.25, 0.75)
    this.ff.clear()
    for (let i = 0; i < this.fireflies.length; i++) {
      const f = this.fireflies[i]
      const t = time * f.speed + f.phase
      const blink = Math.max(0, Math.sin(t * 2.3 + i)) ** 3
      this.ff.emit({ x: f.base.x + Math.sin(t) * f.amp, y: f.base.y + Math.sin(t * 1.7) * 0.3, z: f.base.z + Math.cos(t * 0.8) * f.amp, life: 0.0001, size: 0.05, alpha: ffAlpha * blink })
    }
    this.ff.update(0, this.wind, () => 1)
    // Chips: gravity, bounce on the ground, then settle and fade.
    for (let i = 0; i < this.chipData.length; i++) {
      const c = this.chipData[i]
      if (!c.alive) continue
      c.age += dt
      if (c.age >= c.life) {
        c.alive = false
        this.dummy.scale.setScalar(0)
      } else {
        c.v.y -= 9.8 * dt
        c.p.addScaledVector(c.v, dt)
        if (c.p.y < 0.01) {
          c.p.y = 0.01
          c.v.y *= -0.3
          c.v.x *= 0.5
          c.v.z *= 0.5
          c.w.multiplyScalar(0.5)
        }
        c.r.x += c.w.x * dt
        c.r.y += c.w.y * dt
        c.r.z += c.w.z * dt
        this.dummy.position.copy(c.p)
        this.dummy.rotation.copy(c.r)
        const shrink = c.age > c.life - 0.6 ? (c.life - c.age) / 0.6 : 1
        this.dummy.scale.setScalar(c.s * shrink)
      }
      this.dummy.updateMatrix()
      this.chips.setMatrixAt(i, this.dummy.matrix)
    }
    this.chips.instanceMatrix.needsUpdate = true
  }
}

/** Split-log piece: bark half-cylinder plus pale cut faces. */
export function pieceGeometry(radius: number, length: number): THREE.BufferGeometry {
  const side = new THREE.CylinderGeometry(radius, radius, length, 12, 1, true, 0, Math.PI)
  const capA = new THREE.CircleGeometry(radius, 12, -Math.PI / 2, Math.PI)
  capA.rotateX(-Math.PI / 2)
  capA.translate(0, length / 2, 0)
  const capB = capA.clone()
  capB.rotateX(Math.PI)
  const cut = new THREE.PlaneGeometry(radius * 2, length)
  cut.rotateY(-Math.PI / 2)
  const nonIndexed = [side, capA, capB, cut].map(g => (g.index ? g.toNonIndexed() : g))
  const merged = mergeGeometries([nonIndexed[0], mergeGeometries(nonIndexed.slice(1))!], true)!
  // Lay along Z with the flat cut face down (bark on top).
  merged.rotateX(Math.PI / 2)
  merged.rotateZ(Math.PI / 2)
  return merged
}

export function cutWoodMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0xd8b585, roughness: 0.85 })
}

/** Instanced stack of split pieces next to the stump. */
export class WoodPile {
  readonly mesh: THREE.InstancedMesh
  private shown = 0
  private readonly dummy = new THREE.Object3D()

  constructor(readonly origin: THREE.Vector3, bark: THREE.Material) {
    const geo = pieceGeometry(0.15, 0.4)
    this.mesh = new THREE.InstancedMesh(geo, [bark, cutWoodMaterial()], PILE_CAPACITY)
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
    this.mesh.count = 0
  }

  slotWorld(index: number): { pos: THREE.Vector3; rotZ: number } {
    const s = pileSlot(index)
    return { pos: new THREE.Vector3(this.origin.x + s.x, 0.18 + s.y + (s.flip ? 0.15 : 0), this.origin.z + s.z), rotZ: s.flip ? Math.PI : 0 }
  }

  get count(): number {
    return this.shown
  }

  setCount(n: number): void {
    const target = Math.max(0, Math.min(PILE_CAPACITY, n))
    for (let i = this.shown; i < target; i++) {
      const { pos, rotZ } = this.slotWorld(i)
      this.dummy.position.copy(pos)
      this.dummy.rotation.set(0, (Math.sin(i * 12.9) * 0.08), rotZ + Math.sin(i * 7.1) * 0.05)
      this.dummy.updateMatrix()
      this.mesh.setMatrixAt(i, this.dummy.matrix)
    }
    this.shown = target
    this.mesh.count = target
    this.mesh.instanceMatrix.needsUpdate = true
  }
}
