import * as THREE from 'three'
import { PointPool } from './fx'
import type { Collider } from './world'
import { fitModel, type Models } from './world'

export const CAMPFIRE = {
  pos: new THREE.Vector3(3.9, 0, 1.3),
  /** Bench log the tuna sits on, facing the fire and the sunset (-Z). */
  seat: new THREE.Vector3(3.9, 0, 2.55),
  seatTop: 0.34,
}

export const BAR = {
  /** Counter centre; it runs along Z with the customer side facing +X. */
  pos: new THREE.Vector3(-6.4, 0, -1.6),
  length: 2.8,
  height: 1.08,
  depth: 0.6,
}

const FLAME_FRAG = `varying float vAlpha; varying float vSeed;
void main(){ vec2 p = gl_PointCoord - 0.5; float r = length(p);
  float a = smoothstep(0.5, 0.0, r); a = a * a;
  vec3 hot = vec3(4.0, 2.4, 0.8), cool = vec3(2.2, 0.55, 0.12);
  vec3 c = mix(cool, hot, clamp(vAlpha * 1.3, 0.0, 1.0));
  gl_FragColor = vec4(c * a * vAlpha, 1.0);
}`

/** Ring of stones, crossed logs, flame/ember particles, a flickering light and smoke. */
export class Campfire {
  readonly group = new THREE.Group()
  readonly light: THREE.PointLight
  readonly flames: PointPool
  private t = 0

  constructor(models: Models, colliders: Collider[]) {
    const c = CAMPFIRE.pos
    // Stones
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2
      const s = fitModel(models.rock.scene.clone(), 'x', 0.22 + (i % 3) * 0.04, { shadow: false })
      s.position.set(c.x + Math.cos(a) * 0.42, -0.02, c.z + Math.sin(a) * 0.42)
      s.rotation.y = a * 2.3
      this.group.add(s)
    }
    // Teepee of thin logs leaning in over the coals.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.3
      const pivot = new THREE.Group()
      pivot.position.set(c.x + Math.sin(a) * 0.26, 0, c.z + Math.cos(a) * 0.26)
      pivot.rotation.y = a
      const log = fitModel(models.log.scene.clone(), 'y', 0.55, { shadow: false })
      log.scale.x *= 0.22
      log.scale.z *= 0.22
      log.rotation.x = -0.62
      pivot.add(log)
      this.group.add(pivot)
    }
    // Glowing coal bed
    const coals = new THREE.Mesh(new THREE.CircleGeometry(0.28, 20), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.35, 0.08) }))
    coals.rotation.x = -Math.PI / 2
    coals.position.set(c.x, 0.015, c.z)
    this.group.add(coals)
    // Bench log
    const bench = fitModel(models.log.scene.clone(), 'y', 1.3)
    bench.scale.set(0.5, 1, 0.5)
    bench.rotation.z = Math.PI / 2
    bench.position.set(CAMPFIRE.seat.x + 0.65, 0.17, CAMPFIRE.seat.z + 0.05)
    this.group.add(bench)

    this.light = new THREE.PointLight(0xff7a2e, 5, 11, 1.5)
    this.light.position.set(c.x, 0.55, c.z)
    this.group.add(this.light)
    this.flames = new PointPool(220, FLAME_FRAG, new THREE.Color(1, 1, 1), true)
    this.group.add(this.flames.points)
    colliders.push({ x: c.x, z: c.z, r: 0.55 }, { x: CAMPFIRE.seat.x - 0.35, z: CAMPFIRE.seat.z + 0.05, r: 0.25 }, { x: CAMPFIRE.seat.x + 0.35, z: CAMPFIRE.seat.z + 0.05, r: 0.25 })
  }

  setViewport(scale: number): void {
    this.flames.material.uniforms.uScale.value = scale
  }

  update(dt: number, night: number, emitSmoke: (p: THREE.Vector3) => void, ember: (p: THREE.Vector3, v: THREE.Vector3) => void): void {
    this.t += dt
    const c = CAMPFIRE.pos
    const n = Math.min(14, Math.floor(dt * 110 + Math.random()))
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * 0.14
      this.flames.emit({ x: c.x + Math.cos(a) * r, y: 0.05, z: c.z + Math.sin(a) * r, vx: -Math.cos(a) * 0.12, vy: 0.5 + Math.random() * 0.45, vz: -Math.sin(a) * 0.12,
        life: 0.5 + Math.random() * 0.45, size: 0.34 + Math.random() * 0.2, grow: -0.42, alpha: 0.8, drag: 1.2, lift: 0.35 })
    }
    this.flames.update(dt, new THREE.Vector3(0.05, 0, 0.02), k => (1 - k) * Math.min(1, k * 8))
    if (Math.random() < dt * 7) ember(new THREE.Vector3(c.x, 0.3, c.z), new THREE.Vector3((Math.random() - 0.5) * 0.4, 1.2 + Math.random(), (Math.random() - 0.5) * 0.4))
    if (Math.random() < dt * 2.5) emitSmoke(new THREE.Vector3(c.x, 0.8, c.z))
    const f = 0.85 + Math.sin(this.t * 11) * 0.06 + Math.sin(this.t * 17.3) * 0.05 + Math.random() * 0.06
    this.light.intensity = (3.5 + night * 4) * f
  }
}

function woodTexture(base: string, dark: string, planks: number, vertical = false): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 512
  const g = c.getContext('2d')!
  g.fillStyle = base
  g.fillRect(0, 0, 512, 512)
  const w = 512 / planks
  for (let p = 0; p < planks; p++) {
    const shade = 0.85 + Math.random() * 0.3
    g.fillStyle = `rgba(0,0,0,${(1 - shade) * 0.8 + 0.05})`
    if (vertical) g.fillRect(p * w, 0, w, 512)
    else g.fillRect(0, p * w, 512, w)
    g.strokeStyle = dark
    g.lineWidth = 3
    g.beginPath()
    if (vertical) { g.moveTo(p * w, 0); g.lineTo(p * w, 512) } else { g.moveTo(0, p * w); g.lineTo(512, p * w) }
    g.stroke()
    for (let k = 0; k < 14; k++) {
      g.strokeStyle = `rgba(30,15,5,${0.08 + Math.random() * 0.12})`
      g.lineWidth = 1
      g.beginPath()
      const o = p * w + Math.random() * w
      if (vertical) { g.moveTo(o, 0); g.bezierCurveTo(o + 6, 170, o - 6, 340, o + 3, 512) } else { g.moveTo(0, o); g.bezierCurveTo(170, o + 6, 340, o - 6, 512, o + 3) }
      g.stroke()
    }
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  return t
}

/**
 * Small saloon bar: plank counter with a varnished top and brass foot rail, and a back
 * cabinet with three shelves of bottles (one instanced mesh per glass colour).
 */
export class Bar {
  readonly group = new THREE.Group()
  readonly candle: THREE.PointLight

  constructor(colliders: Collider[]) {
    const b = BAR
    const side = new THREE.MeshStandardMaterial({ map: woodTexture('#6b4026', '#2a160b', 7, true), roughness: 0.8 })
    const top = new THREE.MeshStandardMaterial({ map: woodTexture('#4a2614', '#1e0e06', 3), roughness: 0.35, metalness: 0.05 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a170c, roughness: 0.85 })
    const brass = new THREE.MeshStandardMaterial({ color: 0xc89a4a, roughness: 0.35, metalness: 0.9 })
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat)
      m.position.set(b.pos.x + x, y, b.pos.z + z)
      m.castShadow = true
      m.receiveShadow = true
      this.group.add(m)
      return m
    }
    ;(side.map as THREE.Texture).repeat.set(2, 1)
    add(new THREE.BoxGeometry(b.depth, b.height - 0.06, b.length), side, 0, (b.height - 0.06) / 2, 0)
    add(new THREE.BoxGeometry(b.depth + 0.16, 0.06, b.length + 0.16), top, 0.04, b.height - 0.03, 0)
    add(new THREE.BoxGeometry(0.06, 0.1, b.length), dark, b.depth / 2 + 0.02, 0.05, 0)
    const rail = add(new THREE.CylinderGeometry(0.022, 0.022, b.length - 0.1, 10), brass, b.depth / 2 + 0.16, 0.2, 0)
    rail.rotation.x = Math.PI / 2
    for (const z of [-b.length / 2 + 0.2, 0, b.length / 2 - 0.2]) add(new THREE.CylinderGeometry(0.015, 0.015, 0.2, 8), brass, b.depth / 2 + 0.1, 0.1, z).rotation.z = Math.PI / 2.6

    // Back cabinet
    const cx = -1.15, cw = 2.4, ch = 2.1, cd = 0.36
    add(new THREE.BoxGeometry(0.05, ch, cw), side, cx - cd / 2, ch / 2, 0)
    add(new THREE.BoxGeometry(cd, ch, 0.06), dark, cx, ch / 2, -cw / 2)
    add(new THREE.BoxGeometry(cd, ch, 0.06), dark, cx, ch / 2, cw / 2)
    add(new THREE.BoxGeometry(cd + 0.08, 0.08, cw + 0.12), top, cx, ch + 0.04, 0)
    add(new THREE.BoxGeometry(cd, 0.75, cw), side, cx, 0.375, 0)
    const shelves = [0.78, 1.25, 1.7]
    for (const y of shelves) add(new THREE.BoxGeometry(cd, 0.04, cw), top, cx, y, 0)

    // Bottles: lathe profile, instanced per glass colour.
    const profile = [
      [0, 0], [0.04, 0], [0.042, 0.01], [0.042, 0.17], [0.036, 0.2], [0.016, 0.24], [0.014, 0.31], [0.017, 0.315], [0.017, 0.33], [0, 0.33],
    ].map(([x, y]) => new THREE.Vector2(x, y))
    const bottleGeo = new THREE.LatheGeometry(profile, 12)
    const glass = [0x5a2a0a, 0x2f4a1e, 0x8a5a1a, 0x3a1810, 0xb0c8c0, 0x6b2a1a]
    const slots: Array<{ x: number; y: number; z: number; s: number }> = []
    for (const y of shelves) {
      for (let i = 0; i < 9; i++) {
        if (Math.random() < 0.15) continue
        slots.push({ x: cx + 0.02 + (Math.random() - 0.5) * 0.08, y: y + 0.02, z: -cw / 2 + 0.18 + i * ((cw - 0.36) / 8) + (Math.random() - 0.5) * 0.05, s: 0.8 + Math.random() * 0.5 })
      }
    }
    const dummy = new THREE.Object3D()
    glass.forEach((col, gi) => {
      const mine = slots.filter((_, i) => i % glass.length === gi)
      const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.88, emissive: col, emissiveIntensity: 0.08 })
      const inst = new THREE.InstancedMesh(bottleGeo, mat, mine.length)
      mine.forEach((p, i) => {
        dummy.position.set(b.pos.x + p.x, p.y, b.pos.z + p.z)
        dummy.scale.set(p.s * 0.9, p.s, p.s * 0.9)
        dummy.rotation.y = Math.random() * 6
        dummy.updateMatrix()
        inst.setMatrixAt(i, dummy.matrix)
      })
      inst.castShadow = true
      this.group.add(inst)
    })
    // Labels as small pale boxes on a few bottles would cost draw calls; skip. A couple of
    // glasses and a bottle on the counter set the scene.
    const tumbler = new THREE.LatheGeometry([[0, 0], [0.036, 0], [0.04, 0.08], [0.037, 0.08], [0.033, 0.006], [0, 0.006]].map(([x, y]) => new THREE.Vector2(x, y)), 14)
    const glassMat = new THREE.MeshStandardMaterial({ color: 0xd8e4e4, roughness: 0.05, transparent: true, opacity: 0.35 })
    for (const z of [-0.6, -0.42, 0.5]) add(tumbler, glassMat, 0.05, b.height, z)
    const whisky = add(bottleGeo, new THREE.MeshStandardMaterial({ color: 0x8a4a12, roughness: 0.1, transparent: true, opacity: 0.9 }), -0.05, b.height, 0.2)
    whisky.scale.setScalar(1.1)
    // Candle in a jar for night light at the bar.
    const candleMesh = add(new THREE.CylinderGeometry(0.03, 0.03, 0.08, 10), new THREE.MeshStandardMaterial({ color: 0xf0e2c0, roughness: 0.6 }), 0.05, b.height + 0.04, 1.0)
    candleMesh.castShadow = false
    const flame = add(new THREE.SphereGeometry(0.012, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 2, 0.6) }), 0.05, b.height + 0.1, 1.0)
    flame.scale.y = 1.8
    this.candle = new THREE.PointLight(0xffa050, 1.2, 4.5, 1.6)
    this.candle.position.set(b.pos.x + 0.05, b.height + 0.2, b.pos.z + 1.0)
    this.group.add(this.candle)

    for (let i = 0; i < 6; i++) colliders.push({ x: b.pos.x, z: b.pos.z - b.length / 2 + 0.25 + i * ((b.length - 0.5) / 5), r: 0.36 })
    for (let i = 0; i < 5; i++) colliders.push({ x: b.pos.x + cx, z: b.pos.z - cw / 2 + 0.2 + i * ((cw - 0.4) / 4), r: 0.3 })
  }

  update(t: number, night: number): void {
    this.candle.intensity = (0.6 + night * 1.6) * (0.9 + Math.sin(t * 9) * 0.06 + Math.sin(t * 15.7) * 0.04)
  }
}
