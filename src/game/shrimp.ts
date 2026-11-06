import * as THREE from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { makeAxe } from './axe'
import { angleDelta } from './rules'
import { fitModel } from './world'

type State = 'watch' | 'toBlock' | 'chop' | 'toWatch' | 'cheer'

const LENGTH = 1.15
const CHOP_PERIOD = 2.4
const CHOP_IMPACT_AT = 1.55

/**
 * The companion: a real-looking prawn (static generated mesh, no humanoid skeleton). It moves
 * with procedural vertex deformation — scuttling legs, tail flicks, swaying antennae — plus
 * whole-body poses: it chops by rearing its front up with a small axe and slamming down.
 */
export class Shrimp {
  readonly root = new THREE.Group()
  readonly position = new THREE.Vector3()
  heading = 0
  state: State = 'watch'
  onChopImpact?: () => void
  /** Rear pivot carrying body pitch (rear-up) and hop. */
  private readonly pose = new THREE.Group()
  private readonly uniforms = {
    uTime: { value: 0 }, uWalk: { value: 0 }, uTail: { value: 0 }, uSway: { value: 1 },
    uBounds: { value: new THREE.Vector4(0, 1, 0, 1) },
  }
  private walk = 0
  private timer = 6
  private chopT = 0
  private chopsLeft = 0
  private cheerT = 0
  private t = 0
  private readonly axe: THREE.Group
  private readonly watchSpot: THREE.Vector3
  private readonly chopSpot: THREE.Vector3
  private readonly blockTop: THREE.Vector3

  constructor(gltf: GLTF, axeGltf: GLTF, block: THREE.Vector3, blockTopY: number, watchSpot: THREE.Vector3) {
    const src = gltf.scene
    this.orient(src)
    const model = fitModel(src, 'z', LENGTH)
    // Deformation works in the wrapper's space: record its bounds once.
    model.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(model)
    this.uniforms.uBounds.value.set(box.min.z, box.max.z, box.min.y, box.max.y)
    const meshes: THREE.Mesh[] = []
    model.traverse(o => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh)
    })
    for (const mesh of meshes) {
      // Bake the node transform into the geometry so the shader sees wrapper-space positions.
      mesh.updateMatrixWorld(true)
      const toWrap = new THREE.Matrix4().copy(model.matrixWorld).invert().multiply(mesh.matrixWorld)
      mesh.geometry = mesh.geometry.clone().applyMatrix4(toWrap)
      mesh.position.set(0, 0, 0)
      mesh.quaternion.identity()
      mesh.scale.set(1, 1, 1)
      mesh.removeFromParent()
      model.add(mesh)
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) this.deform(m as THREE.MeshStandardMaterial)
      mesh.castShadow = true
      mesh.frustumCulled = false
    }
    model.children.filter(c => !(c as THREE.Mesh).isMesh).forEach(c => c.removeFromParent())
    // Pivot at the tail end so rearing up lifts the head and front legs.
    const pivotZ = box.min.z + LENGTH * 0.28
    model.position.z -= pivotZ
    this.pose.position.z = pivotZ
    this.pose.add(model)
    this.root.add(this.pose)

    this.blockTop = new THREE.Vector3(block.x, blockTopY, block.z)
    this.chopSpot = new THREE.Vector3(block.x, 0, block.z + 0.95)
    this.watchSpot = watchSpot.clone()
    this.position.copy(watchSpot)

    // A small axe held under the head by the front legs; it rises and falls with the body.
    this.axe = makeAxe(axeGltf, 0.6, true)
    this.axe.position.set(0.05, 0.16, box.max.z - pivotZ - 0.28)
    this.axe.rotation.set(-0.2, 0, 0)
    this.axe.visible = false
    model.parent!.add(this.axe)
    this.root.position.copy(this.position)
  }

  /**
   * Lay the prawn out: longest extent → Z (body), middle → X (leg spread), shortest → Y.
   * The wide-reaching vertices are legs: they hang on the belly side (→ down) and cluster on
   * the cephalothorax (→ front, +Z).
   */
  private orient(scene: THREE.Object3D): void {
    scene.updateMatrixWorld(true)
    const size = new THREE.Box3().setFromObject(scene).getSize(new THREE.Vector3())
    const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]
    const order = [0, 1, 2].sort((i, j) => size.getComponent(j) - size.getComponent(i))
    const long = axes[order[0]], mid = axes[order[1]]
    const short = new THREE.Vector3().crossVectors(long, mid)
    // Rows: new X = mid, new Y = short, new Z = long.
    const m = new THREE.Matrix4().set(
      mid.x, mid.y, mid.z, 0,
      short.x, short.y, short.z, 0,
      long.x, long.y, long.z, 0,
      0, 0, 0, 1,
    )
    scene.quaternion.setFromRotationMatrix(m)
    scene.updateMatrixWorld(true)
    const stats = () => {
      const b = new THREE.Box3().setFromObject(scene)
      const c = b.getCenter(new THREE.Vector3())
      const half = b.getSize(new THREE.Vector3()).multiplyScalar(0.5)
      let n = 0, sy = 0, sz = 0
      const v = new THREE.Vector3()
      scene.traverse(o => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        const pos = mesh.geometry.attributes.position as THREE.BufferAttribute
        for (let i = 0; i < pos.count; i += 2) {
          v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
          if (Math.abs(v.x - c.x) > half.x * 0.55) {
            n++
            sy += v.y - c.y
            sz += v.z - c.z
          }
        }
      })
      return { y: sy / Math.max(1, n), z: sz / Math.max(1, n) }
    }
    let st = stats()
    if (st.y > 0) {
      scene.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI))
      scene.updateMatrixWorld(true)
      st = stats()
    }
    if (st.z < 0) scene.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI))
    // The leg heuristic is fooled by this model's long antennae: verified visually that the
    // result is belly-up and reversed, i.e. a half turn about X puts it upright facing +Z.
    scene.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI))
    scene.updateMatrixWorld(true)
  }

  private deform(mat: THREE.MeshStandardMaterial): void {
    const u = this.uniforms
    mat.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, u)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float uTime; uniform float uWalk; uniform float uTail; uniform float uSway; uniform vec4 uBounds;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float len = uBounds.y - uBounds.x;
          float zN = (transformed.z - uBounds.x) / len;           // 0 tail .. 1 head
          float yN = (transformed.y - uBounds.z) / (uBounds.w - uBounds.z);
          // Walking legs: low vertices in the front half scuttle in a travelling wave.
          float legMask = (1.0 - smoothstep(0.12, 0.34, yN)) * smoothstep(0.3, 0.45, zN);
          float wave = sin(uTime * 14.0 + zN * 22.0 + sign(transformed.x) * 1.6);
          transformed.z += wave * 0.035 * uWalk * legMask;
          transformed.y += max(0.0, wave) * 0.018 * uWalk * legMask;
          // Tail flick: rotate the rear about a pivot near the abdomen.
          float tailMask = 1.0 - smoothstep(0.08, 0.4, zN);
          float a = uTail * tailMask * 0.6 + sin(uTime * 1.7) * 0.04 * tailMask;
          float pz = uBounds.x + len * 0.4;
          float dz = transformed.z - pz, dy = transformed.y - uBounds.z;
          transformed.z = pz + dz * cos(a) - dy * sin(a);
          transformed.y = uBounds.z + dz * sin(a) + dy * cos(a);
          // Antennae and rostrum: high/front thin parts sway lazily.
          float antMask = smoothstep(0.55, 0.95, zN) * smoothstep(0.45, 0.9, yN);
          transformed.x += sin(uTime * 1.9 + zN * 6.0) * 0.03 * antMask * uSway;
          transformed.y += sin(uTime * 2.6 + zN * 9.0) * 0.015 * antMask * uSway;
          // Swimmerets under the abdomen ripple.
          float swim = (1.0 - smoothstep(0.1, 0.3, yN)) * (1.0 - smoothstep(0.25, 0.45, zN)) * smoothstep(0.08, 0.15, zN);
          transformed.z += sin(uTime * 9.0 + zN * 30.0) * 0.012 * swim;`)
    }
    mat.needsUpdate = true
  }

  cheer(): void {
    if (this.state !== 'watch') return
    this.state = 'cheer'
    this.cheerT = 0
  }

  get collider(): { x: number; z: number; r: number } {
    return { x: this.position.x, z: this.position.z, r: 0.42 }
  }

  get blockImpactPoint(): THREE.Vector3 {
    return this.blockTop
  }

  update(dt: number, player: THREE.Vector3): void {
    this.t += dt
    this.timer -= dt
    let moving = false
    let pitch = 0
    let hop = 0
    let tail = 0
    const walkTo = (target: THREE.Vector3, next: () => void) => {
      const d = new THREE.Vector3().subVectors(target, this.position)
      d.y = 0
      const dist = d.length()
      const want = Math.atan2(d.x, d.z)
      this.turnTo(want, dt, 5)
      if (dist < 0.05) return next()
      // Prawns scuttle once roughly facing the way.
      if (Math.abs(angleDelta(this.heading, want)) < 0.8) {
        this.position.addScaledVector(d.normalize(), Math.min(dist, 0.7 * dt))
      }
      moving = true
    }
    switch (this.state) {
      case 'watch': {
        const d = new THREE.Vector3().subVectors(player, this.position)
        this.turnTo(Math.atan2(d.x, d.z), dt, 2)
        pitch = -0.06 + Math.sin(this.t * 0.9) * 0.03
        if (this.timer <= 0) this.state = 'toBlock'
        break
      }
      case 'cheer': {
        this.cheerT += dt
        const d = new THREE.Vector3().subVectors(player, this.position)
        this.turnTo(Math.atan2(d.x, d.z), dt, 4)
        // Two happy hops with a tail flick each.
        const k = this.cheerT
        hop = Math.max(0, Math.sin(k * 7)) * 0.12 * (k < 1.8 ? 1 : 0)
        tail = Math.max(0, Math.sin(k * 7)) * (k < 1.8 ? 1 : 0)
        pitch = -0.25 * Math.max(0, Math.sin(k * 3.5))
        if (k > 2.4) {
          this.state = 'watch'
          this.timer = 5 + Math.random() * 4
        }
        break
      }
      case 'toBlock':
        walkTo(this.chopSpot, () => {
          this.state = 'chop'
          this.chopsLeft = 3
          this.chopT = 0
          this.axe.visible = true
        })
        break
      case 'chop': {
        this.turnTo(Math.PI, dt, 6)
        const prev = this.chopT
        this.chopT += dt
        const c = this.chopT % CHOP_PERIOD
        const pc = prev % CHOP_PERIOD
        // Rear up slowly, hold, then slam down onto the log.
        if (c < 1.2) pitch = -0.55 * smoothstep(c / 1.2)
        else if (c < CHOP_IMPACT_AT) pitch = -0.55 + 0.7 * Math.pow((c - 1.2) / (CHOP_IMPACT_AT - 1.2), 2)
        else pitch = 0.15 * Math.exp(-(c - CHOP_IMPACT_AT) * 6)
        tail = c < 1.2 ? -0.4 * (c / 1.2) : 0.2
        if (pc < CHOP_IMPACT_AT && c >= CHOP_IMPACT_AT) this.onChopImpact?.()
        if (c < pc) {
          this.chopsLeft--
          if (this.chopsLeft <= 0) {
            this.state = 'toWatch'
            this.axe.visible = false
          }
        }
        break
      }
      case 'toWatch':
        walkTo(this.watchSpot, () => {
          this.state = 'watch'
          this.timer = 9 + Math.random() * 6
        })
        break
    }
    this.walk += ((moving ? 1 : 0) - this.walk) * Math.min(1, dt * 6)
    const u = this.uniforms
    u.uTime.value = this.t
    u.uWalk.value = this.walk
    u.uTail.value += (tail - u.uTail.value) * Math.min(1, dt * 10)
    this.pose.rotation.x = pitch
    this.pose.position.y = hop + Math.abs(Math.sin(this.t * 14)) * 0.008 * this.walk
    this.root.position.copy(this.position)
    this.root.rotation.y = this.heading
  }

  private turnTo(target: number, dt: number, rate: number): void {
    this.heading += angleDelta(this.heading, target) * Math.min(1, dt * rate)
  }
}

function smoothstep(x: number): number {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}
