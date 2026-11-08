import * as THREE from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { CONFIG } from './config'
import { fitModel } from './world'

const BODY_Y = 0.6
const BOOT_H = 0.34

/**
 * The cowboy tuna: a generated fish (hat and cigarette baked in) riding a pair of separate
 * leather boots. Walking is procedural — boots stomp in alternation while the body bobs and
 * sways with a western swagger. All poses are written each frame from explicit parameters.
 */
export class Tuna {
  readonly root = new THREE.Group()
  /** Bobbing/rolling carrier for the fish. */
  readonly hips = new THREE.Group()
  /** Pitch pivot (chop windup / swing, looking up at the sky). */
  readonly body = new THREE.Group()
  readonly bootL: THREE.Group
  readonly bootR: THREE.Group
  readonly ember: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
  readonly emberLight: THREE.PointLight
  /** Cigarette tip in body-local space (found from the mesh). */
  readonly tipLocal = new THREE.Vector3(0, -0.02, 0.62)
  heading = 0
  phase = 0
  /** 0 = standing still, 1 = full stride. */
  gait = 0
  /** 0 = standing, 1 = sitting (boots dangle). */
  sit = 0
  pitch = 0
  /** 0..1 airborne tuck while jumping. */
  air = 0
  emberGlow = 0.35
  onFootfall?: (side: 0 | 1, strength: number) => void
  private lastSin = [0, 0]
  private t = 0

  constructor(fish: GLTF, boot: GLTF) {
    const fishModel = fitModel(fish.scene, 'z', 1.25)
    // Centre the fish vertically on the hip pivot so its belly rests on the boot tops.
    const fb = new THREE.Box3().setFromObject(fishModel)
    fishModel.position.y = -(fb.max.y - fb.min.y) / 2 + 0.02
    this.body.add(fishModel)
    this.hips.add(this.body)
    this.hips.position.y = BODY_Y
    this.root.add(this.hips)
    this.bootL = fitModel(boot.scene.clone(), 'y', BOOT_H)
    this.bootR = fitModel(boot.scene, 'y', BOOT_H)
    this.bootR.scale.x = -1
    this.root.add(this.bootL, this.bootR)
    this.stripBakedCigarette(fishModel)
    this.addCigarette()
    this.ember = new THREE.Mesh(new THREE.SphereGeometry(0.0095, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.8, 0.2), fog: false }))
    this.ember.position.copy(this.tipLocal)
    this.body.add(this.ember)
    this.emberLight = new THREE.PointLight(0xff6a2a, 0.2, 1.6, 2)
    this.emberLight.position.copy(this.tipLocal)
    this.body.add(this.emberLight)
  }

  /**
   * The generated fish has a cigarette baked in as a separate thin mesh island that pokes out
   * through the cheek. Weld vertices, find connected islands, and drop the thin one at the mouth.
   */
  private stripBakedCigarette(model: THREE.Object3D): void {
    this.root.updateMatrixWorld(true)
    const v = new THREE.Vector3()
    model.traverse(o => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || !mesh.geometry.index) return
      const g = mesh.geometry
      const pos = g.attributes.position as THREE.BufferAttribute
      const idx = g.index!.array
      const n = pos.count
      const canon = new Map<string, number>()
      const rep = new Int32Array(n)
      for (let i = 0; i < n; i++) {
        const k = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`
        if (!canon.has(k)) canon.set(k, i)
        rep[i] = canon.get(k)!
      }
      const par = Int32Array.from({ length: n }, (_, i) => i)
      const find = (x: number) => { while (par[x] !== x) x = par[x] = par[par[x]]; return x }
      for (let t = 0; t < idx.length; t += 3) {
        const a = find(rep[idx[t]])
        par[find(rep[idx[t + 1]])] = a
        par[find(rep[idx[t + 2]])] = a
      }
      const toBody = new THREE.Matrix4().copy(this.body.matrixWorld).invert().multiply(mesh.matrixWorld)
      const box = new Map<number, { tris: number; min: THREE.Vector3; max: THREE.Vector3 }>()
      for (let t = 0; t < idx.length; t += 3) {
        const r = find(rep[idx[t]])
        let b = box.get(r)
        if (!b) box.set(r, (b = { tris: 0, min: new THREE.Vector3(9, 9, 9), max: new THREE.Vector3(-9, -9, -9) }))
        b.tris++
        for (let k = 0; k < 3; k++) {
          v.fromBufferAttribute(pos, idx[t + k]).applyMatrix4(toBody)
          b.min.min(v)
          b.max.max(v)
        }
      }
      const drop = new Set<number>()
      for (const [r, b] of box) {
        const thin = b.max.y - b.min.y < 0.07
        const long = b.max.z - b.min.z > 0.15 || b.max.x - b.min.x > 0.15
        if (thin && long && b.max.z > 0.55 && b.tris < 1200) drop.add(r)
      }
      if (!drop.size) return
      const kept: number[] = []
      for (let t = 0; t < idx.length; t += 3) if (!drop.has(find(rep[idx[t]]))) kept.push(idx[t], idx[t + 1], idx[t + 2])
      g.setIndex(kept)
    })
  }

  /** A short, tidy cigarette held at the corner of the mouth; the ember sits at its tip. */
  private addCigarette(): void {
    const mouth = new THREE.Vector3(0.035, -0.005, 0.585)
    const dir = new THREE.Vector3(0.42, -0.12, 0.9).normalize()
    const paperLen = 0.085, filterLen = 0.03, r = 0.0075
    const group = new THREE.Group()
    const filter = new THREE.Mesh(new THREE.CylinderGeometry(r, r, filterLen, 12), new THREE.MeshStandardMaterial({ color: 0xd98a3a, roughness: 0.7 }))
    filter.position.y = filterLen / 2
    const paper = new THREE.Mesh(new THREE.CylinderGeometry(r, r, paperLen, 12), new THREE.MeshStandardMaterial({ color: 0xf2eee6, roughness: 0.6 }))
    paper.position.y = filterLen + paperLen / 2
    const ash = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.95, r, 0.008, 12), new THREE.MeshStandardMaterial({ color: 0x6b6460, roughness: 1 }))
    ash.position.y = filterLen + paperLen + 0.004
    group.add(filter, paper, ash)
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
    // Tuck the filter slightly into the lips.
    group.position.copy(mouth).addScaledVector(dir, -0.012)
    this.body.add(group)
    this.tipLocal.copy(group.position).addScaledVector(dir, filterLen + paperLen + 0.009)
  }

  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(Math.sin(this.heading), 0, Math.cos(this.heading))
  }

  /** Where a glass base should sit so its rim meets the lips (just below and ahead of the mouth). */
  glassAtMouthWorld(out = new THREE.Vector3()): THREE.Vector3 {
    this.body.updateMatrixWorld(true)
    return out.set(0.01, -0.115, 0.625).applyMatrix4(this.body.matrixWorld)
  }
  tipWorld(out = new THREE.Vector3()): THREE.Vector3 {
    this.root.updateMatrixWorld(true)
    return out.copy(this.tipLocal).applyMatrix4(this.body.matrixWorld)
  }

  /** Advance pose. `speed` is current ground speed (m/s). */
  update(dt: number, speed: number, reducedMotion: boolean): void {
    this.t += dt
    const targetGait = Math.min(1, speed / Math.max(0.1, CONFIG.player.walkSpeed))
    this.gait += (targetGait - this.gait) * Math.min(1, dt * 8)
    this.phase += (speed / Math.max(0.1, CONFIG.player.strideLength)) * Math.PI * dt
    const g = this.gait * (1 - this.sit)
    const sway = reducedMotion ? 0.5 : 1
    const breathe = Math.sin(this.t * 1.6) * 0.008

    // Boots: alternate lift arcs; planted boot slides back under the body.
    const stride = CONFIG.player.strideLength * 0.32
    for (let i = 0; i < 2; i++) {
      const boot = i === 0 ? this.bootL : this.bootR
      const s = Math.sin(this.phase + i * Math.PI)
      const c = Math.cos(this.phase + i * Math.PI)
      const lift = Math.max(0, s) * 0.1 * g
      const x = i === 0 ? 0.115 : -0.115
      // Standing: feet under body. Sitting: dangle forward and down, swinging lazily.
      const dangle = Math.sin(this.t * 1.3 + i * 1.9) * 0.12
      boot.position.set(
        x * (1 - this.sit * 0.15),
        lift * (1 - this.sit) + this.sit * -0.3 + this.air * 0.06,
        0.04 + c * stride * g + this.sit * 0.36,
      )
      boot.rotation.set(-Math.max(0, s) * 0.45 * g + this.sit * (0.5 + dangle) + this.air * (i === 0 ? 0.35 : -0.15), (i === 0 ? -0.06 : 0.06) * (1 - this.sit), 0)
      if (s <= 0 && this.lastSin[i] > 0 && g > 0.3) this.onFootfall?.(i as 0 | 1, g)
      this.lastSin[i] = s
    }

    // Body: bob on each step, roll side to side (swagger), tail wiggle, slight forward lean.
    const bob = Math.abs(Math.sin(this.phase)) * 0.045 * g
    this.hips.position.y = BODY_Y + bob + breathe - this.sit * 0.22
    this.hips.position.z = this.sit * 0.04
    this.hips.rotation.z = Math.sin(this.phase) * 0.075 * g * sway + Math.sin(this.t * 0.7) * 0.01
    this.body.rotation.y = Math.sin(this.phase) * 0.08 * g * sway + Math.sin(this.t * 2.1) * 0.025 * (1 - g)
    this.body.rotation.x = this.pitch - 0.04 * g - this.sit * 0.12 - this.air * 0.12
    this.root.rotation.y = this.heading

    // Ember brightness → emissive + tiny light.
    const flick = 0.9 + Math.sin(this.t * 17) * 0.06 + Math.sin(this.t * 5.3) * 0.05
    const e = this.emberGlow * flick
    this.ember.material.color.setRGB(1.2 + e * 5, 0.25 + e * 1.4, 0.05 + e * 0.3)
    this.ember.scale.setScalar(0.8 + e * 0.6)
    this.emberLight.intensity = 0.05 + e * 0.6
  }
}
