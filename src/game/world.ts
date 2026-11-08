import * as THREE from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { ModelName } from './assetTable'
import { lanternIntensity, type LanternLevel, type Spot } from './rules'

export type Models = Record<ModelName, GLTF>

/** Layout of the clearing (metres). The sunset lies toward -Z, beyond the back fence. */
export const LAYOUT = {
  stump: new THREE.Vector3(0, 0, -1.2),
  stumpTop: 0.41,
  logHeight: 0.42,
  lantern: new THREE.Vector3(1.3, 0, -0.7),
  rock: new THREE.Vector3(-3.4, 0, 1.2),
  rockSeat: new THREE.Vector3(-3.4, 0, 0.88),
  fenceZ: -5.2,
  fenceSeat: new THREE.Vector3(3.6, 0, -5.2),
  sideFenceX: -9.6,
  shrimpBlock: new THREE.Vector3(-2.5, 0, -2.3),
  pile: new THREE.Vector3(3.0, 0, -2.7),
  sunDir: new THREE.Vector3(0.25, 0.06, -1).normalize(),
}

export type Collider = { x: number; z: number; r: number }

/**
 * Normalise a generated model: uniform scale so `axis` spans `size` metres, base on y=0,
 * centred on x/z. Returns a wrapper so callers can freely position/rotate it.
 */
export function fitModel(source: THREE.Object3D, axis: 'x' | 'y' | 'z', size: number, opts: { shadow?: boolean; receive?: boolean } = {}): THREE.Group {
  const model = source
  model.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(model)
  const dims = box.getSize(new THREE.Vector3())
  const s = size / Math.max(1e-6, dims[axis])
  model.scale.multiplyScalar(s)
  model.updateMatrixWorld(true)
  const b2 = new THREE.Box3().setFromObject(model)
  const c = b2.getCenter(new THREE.Vector3())
  model.position.x -= c.x
  model.position.z -= c.z
  model.position.y -= b2.min.y
  model.traverse(o => {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh) {
      mesh.castShadow = opts.shadow ?? true
      mesh.receiveShadow = opts.receive ?? true
    }
  })
  const wrap = new THREE.Group()
  wrap.add(model)
  return wrap
}

const SKY_VERT = `varying vec3 vDir;
void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`

const SKY_FRAG = `uniform float uNight; uniform vec3 uSunDir; uniform float uTime;
varying vec3 vDir;
float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 duskTop = vec3(0.07, 0.07, 0.20), duskMid = vec3(0.42, 0.20, 0.32), duskHor = vec3(1.05, 0.48, 0.20);
  vec3 nightTop = vec3(0.004, 0.006, 0.025), nightMid = vec3(0.02, 0.025, 0.07), nightHor = vec3(0.09, 0.06, 0.12);
  float n = clamp(uNight, 0.0, 1.0);
  vec3 top = mix(duskTop, nightTop, n), mid = mix(duskMid, nightMid, n), hor = mix(duskHor, nightHor, smoothstep(0.0, 0.85, n));
  float sunSide = clamp(dot(normalize(vec3(d.x, 0.0, d.z) + 1e-5), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))) * 0.5 + 0.5, 0.0, 1.0);
  hor *= mix(0.45, 1.25, sunSide * sunSide);
  vec3 col = mix(hor, mid, smoothstep(-0.02, 0.22, h));
  col = mix(col, top, smoothstep(0.18, 0.75, h));
  float sd = max(dot(d, normalize(uSunDir)), 0.0);
  float dusk = 1.0 - smoothstep(0.0, 0.8, n);
  col += vec3(1.2, 0.55, 0.2) * pow(sd, 6.0) * 0.55 * dusk;
  col += vec3(2.4, 1.3, 0.55) * pow(sd, 380.0) * 2.2 * dusk;
  vec3 g = floor(d * 260.0);
  float st = hash(g);
  float tw = 0.6 + 0.4 * sin(uTime * 2.0 + st * 40.0);
  float star = step(0.993 - 0.003 * n, st) * smoothstep(0.03, 0.3, h) * smoothstep(0.2, 0.8, n) * tw;
  col += vec3(0.9, 0.92, 1.0) * star * (1.4 + st * 1.6);
  col = mix(col, hor * 0.35, smoothstep(0.0, -0.12, h));
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

function makeSkyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uNight: { value: 0 }, uSunDir: { value: LAYOUT.sunDir.clone() }, uTime: { value: 0 } },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  })
}

function groundTexture(): THREE.CanvasTexture {
  const size = 1024
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  g.fillStyle = '#2f3a1f'
  g.fillRect(0, 0, size, size)
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < 9000; i++) {
    const x = rnd() * size, y = rnd() * size, r = 2 + rnd() * 10
    const tone = rnd()
    g.fillStyle = tone < 0.5 ? `rgba(58,72,34,${0.25 + rnd() * 0.3})` : tone < 0.8 ? `rgba(36,46,24,${0.3 + rnd() * 0.3})` : `rgba(84,82,44,${0.15 + rnd() * 0.2})`
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill()
  }
  // Packed-dirt clearing around the chopping stump and the walking paths.
  const dirt = (cx: number, cy: number, rad: number, a: number) => {
    const grd = g.createRadialGradient(cx, cy, 0, cx, cy, rad)
    grd.addColorStop(0, `rgba(92,70,46,${a})`)
    grd.addColorStop(0.6, `rgba(80,62,40,${a * 0.75})`)
    grd.addColorStop(1, 'rgba(80,62,40,0)')
    g.fillStyle = grd
    g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fill()
  }
  const toPx = (x: number, z: number) => [size / 2 + (x / 60) * size, size / 2 + (z / 60) * size] as const
  const [sx, sy] = toPx(0, -1.2)
  dirt(sx, sy, 60, 0.95)
  const [px, py] = toPx(-2.5, -2.3)
  dirt(px, py, 30, 0.8)
  for (let i = 0; i < 2600; i++) {
    const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * 70
    g.fillStyle = `rgba(${120 + rnd() * 40},${96 + rnd() * 30},${66 + rnd() * 20},${0.12 + rnd() * 0.2})`
    g.fillRect(sx + Math.cos(a) * rr, sy + Math.sin(a) * rr, 1 + rnd() * 2, 1 + rnd() * 2)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

/** Instanced grass blades with a wind sway added in the vertex shader. */
function makeGrass(count: number, time: { value: number }): THREE.InstancedMesh {
  const geo = new THREE.PlaneGeometry(0.06, 0.34, 1, 3)
  geo.translate(0, 0.17, 0)
  const pos = geo.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    pos.setX(i, pos.getX(i) * (1 - y / 0.36))
  }
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, side: THREE.DoubleSide })
  mat.onBeforeCompile = shader => {
    shader.uniforms.uTime = time
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vH;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vH = clamp(position.y / 0.34, 0.0, 1.0);
        vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float w = sin(uTime * 1.3 + ip.x * 0.55 + ip.z * 0.35) * 0.6 + sin(uTime * 2.7 + ip.x * 1.7) * 0.25;
        transformed.x += w * 0.07 * vH * vH;
        transformed.z += w * 0.03 * vH * vH;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vH;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= mix(0.3, 1.0, vH);')
  }
  const mesh = new THREE.InstancedMesh(geo, mat, count)
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3()
  const color = new THREE.Color()
  let seed = 11
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  let placed = 0
  while (placed < count) {
    const a = rnd() * Math.PI * 2
    const r = 1.2 + Math.sqrt(rnd()) * 17
    const x = Math.cos(a) * r, z = Math.sin(a) * r - 1
    if (Math.hypot(x - LAYOUT.stump.x, z - LAYOUT.stump.z) < 1.9 + rnd() * 0.8) continue
    if (Math.hypot(x - LAYOUT.shrimpBlock.x, z - LAYOUT.shrimpBlock.z) < 1.0) continue
    if (z < LAYOUT.fenceZ - 0.15 && z > LAYOUT.fenceZ - 0.5) continue
    p.set(x, 0, z)
    q.setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.3, rnd() * Math.PI, (rnd() - 0.5) * 0.3))
    const k = 0.6 + rnd() * 0.9
    s.set(k, k * (0.7 + rnd() * 0.8), k)
    m.compose(p, q, s)
    mesh.setMatrixAt(placed, m)
    color.setHSL(0.2 + rnd() * 0.07, 0.35 + rnd() * 0.2, 0.17 + rnd() * 0.1)
    mesh.setColorAt(placed, color)
    placed++
  }
  mesh.instanceMatrix.needsUpdate = true
  mesh.receiveShadow = true
  mesh.frustumCulled = false
  return mesh
}

export class World {
  readonly scene = new THREE.Scene()
  readonly time = { value: 0 }
  readonly colliders: Collider[] = []
  readonly spots: Spot[] = []
  readonly sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>
  readonly hemi: THREE.HemisphereLight
  readonly sun: THREE.DirectionalLight
  readonly moon: THREE.DirectionalLight
  readonly lanternLight: THREE.PointLight
  readonly lanternFlame: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
  readonly lanternHalo: THREE.Sprite
  readonly lanternRoot: THREE.Group
  readonly stump: THREE.Group
  readonly logOnStump: THREE.Group
  readonly shrimpBlock: THREE.Group
  readonly fog: THREE.Fog
  lanternLevel: LanternLevel = 2
  private lanternShown = 0
  private grass?: THREE.InstancedMesh

  constructor(private readonly models: Models, quality: 'low' | 'medium' | 'high') {
    const scene = this.scene
    this.fog = new THREE.Fog(0x4a3048, 14, 70)
    scene.fog = this.fog

    this.sky = new THREE.Mesh(new THREE.SphereGeometry(400, 48, 24), makeSkyMaterial())
    this.sky.frustumCulled = false
    this.sky.renderOrder = -10
    scene.add(this.sky)

    this.hemi = new THREE.HemisphereLight(0xb87a8a, 0x2a2418, 0.9)
    scene.add(this.hemi)
    this.sun = new THREE.DirectionalLight(0xff9a55, 2.2)
    this.sun.position.copy(LAYOUT.sunDir).multiplyScalar(30).add(new THREE.Vector3(0, 6, 0))
    this.sun.castShadow = true
    this.sun.shadow.camera.left = -12
    this.sun.shadow.camera.right = 12
    this.sun.shadow.camera.top = 12
    this.sun.shadow.camera.bottom = -12
    this.sun.shadow.camera.far = 80
    this.sun.shadow.bias = -0.0006
    this.sun.shadow.normalBias = 0.03
    this.sun.shadow.mapSize.set(2048, 2048)
    scene.add(this.sun, this.sun.target)
    this.moon = new THREE.DirectionalLight(0x8fa6ff, 0)
    this.moon.position.set(-8, 20, 6)
    scene.add(this.moon)

    // Ground
    const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 64), new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 1 }))
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    scene.add(ground)
    this.grass = makeGrass(quality === 'low' ? 3500 : quality === 'medium' ? 7000 : 11000, this.time)
    scene.add(this.grass)

    this.buildHills()
    this.buildTrees()
    this.buildFences()

    // Chopping stump with a fresh log on top.
    this.stump = fitModel(models.stump.scene.clone(), 'x', 0.85)
    this.stump.position.copy(LAYOUT.stump)
    this.stump.rotation.y = 0.6
    scene.add(this.stump)
    this.logOnStump = this.makeLog(LAYOUT.logHeight)
    this.logOnStump.position.set(LAYOUT.stump.x, LAYOUT.stumpTop - 0.01, LAYOUT.stump.z)
    scene.add(this.logOnStump)
    this.colliders.push({ x: LAYOUT.stump.x, z: LAYOUT.stump.z, r: 0.62 })

    // The shrimp's own chopping block.
    this.shrimpBlock = fitModel(models.stump.scene.clone(), 'x', 0.62)
    this.shrimpBlock.position.copy(LAYOUT.shrimpBlock)
    this.shrimpBlock.rotation.y = 2.1
    scene.add(this.shrimpBlock)
    const shrimpLog = this.makeLog(0.32)
    shrimpLog.position.set(LAYOUT.shrimpBlock.x, 0.29, LAYOUT.shrimpBlock.z)
    shrimpLog.rotation.y = 1.3
    scene.add(shrimpLog)
    this.colliders.push({ x: LAYOUT.shrimpBlock.x, z: LAYOUT.shrimpBlock.z, r: 0.45 })

    // Rock seat
    const rock = fitModel(models.rock.scene, 'x', 1.5)
    rock.position.copy(LAYOUT.rock)
    rock.rotation.y = 0.4
    scene.add(rock)
    this.colliders.push({ x: LAYOUT.rock.x, z: LAYOUT.rock.z, r: 0.85 })

    // Oil lantern
    this.lanternRoot = fitModel(models.lantern.scene, 'y', 0.52)
    this.lanternRoot.position.copy(LAYOUT.lantern)
    this.lanternRoot.rotation.y = -0.5
    scene.add(this.lanternRoot)
    this.lanternLight = new THREE.PointLight(0xffa04a, 4, 9, 1.6)
    this.lanternLight.position.set(LAYOUT.lantern.x, 0.24, LAYOUT.lantern.z)
    this.lanternLight.castShadow = quality !== 'low'
    this.lanternLight.shadow.mapSize.set(512, 512)
    this.lanternLight.shadow.bias = -0.002
    this.lanternLight.shadow.camera.near = 0.15
    scene.add(this.lanternLight)
    this.lanternFlame = new THREE.Mesh(new THREE.SphereGeometry(0.022, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 2.2, 0.8), toneMapped: true, fog: false }))
    this.lanternFlame.scale.set(1, 1.7, 1)
    this.lanternFlame.position.set(LAYOUT.lantern.x, 0.205, LAYOUT.lantern.z)
    scene.add(this.lanternFlame)
    this.lanternHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTexture(), color: 0xffa24c, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.6, fog: false }))
    this.lanternHalo.scale.setScalar(0.9)
    this.lanternHalo.position.set(LAYOUT.lantern.x, 0.22, LAYOUT.lantern.z)
    scene.add(this.lanternHalo)
    this.colliders.push({ x: LAYOUT.lantern.x, z: LAYOUT.lantern.z, r: 0.28 })

    // Woodpile base: two rails on the ground so the stack looks deliberate.
    const rail = this.makeLog(1.95)
    rail.rotation.z = Math.PI / 2
    rail.scale.set(0.1, 1, 0.1)
    for (const dz of [-0.13, 0.13]) {
      const r = rail.clone()
      r.position.set(LAYOUT.pile.x + 0.975, 0.09, LAYOUT.pile.z + dz)
      scene.add(r)
    }
    this.colliders.push({ x: LAYOUT.pile.x - 0.55, z: LAYOUT.pile.z, r: 0.5 }, { x: LAYOUT.pile.x + 0.55, z: LAYOUT.pile.z, r: 0.5 })

    this.spots.push(
      { id: 'chop', kind: 'chop', x: LAYOUT.stump.x, z: LAYOUT.stump.z + 0.4, reach: 1.55 },
      { id: 'lantern', kind: 'lantern', x: LAYOUT.lantern.x, z: LAYOUT.lantern.z, reach: 1.05 },
      { id: 'rock', kind: 'sit', x: LAYOUT.rock.x, z: LAYOUT.rock.z, reach: 1.75 },
      { id: 'fence', kind: 'sit', x: LAYOUT.fenceSeat.x, z: LAYOUT.fenceSeat.z + 0.35, reach: 1.3 },
    )
  }

  /** A log (stump-top sized) whose height is `h` metres, base at y=0. */
  makeLog(h: number): THREE.Group {
    return fitModel(this.models.log.scene.clone(), 'y', h)
  }

  private readonly hillMeshes: THREE.Mesh[] = []

  /** Height of the terrain (flat ground or hill surface) at x/z. */
  groundHeight(x: number, z: number): number {
    const ray = new THREE.Raycaster(new THREE.Vector3(x, 200, z), new THREE.Vector3(0, -1, 0), 0, 400)
    let y = 0
    for (const h of this.hillMeshes) {
      h.updateMatrixWorld(true)
      const hit = ray.intersectObject(h, false)[0]
      if (hit) y = Math.max(y, hit.point.y)
    }
    return y
  }

  private buildHills(): void {
    const mat = new THREE.MeshStandardMaterial({ color: 0x1c2416, roughness: 1 })
    const hills: Array<[number, number, number, number, number]> = [
      [0, -26, -62, 40, 0.42], [-38, -20, -50, 30, 0.5], [40, -22, -54, 34, 0.45], [-60, -16, -10, 28, 0.6], [62, -18, -12, 30, 0.55],
    ]
    for (const [x, y, z, r, flat] of hills) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 40, 20), mat)
      m.position.set(x, y, z)
      m.scale.y = flat * 1.6
      m.receiveShadow = false
      this.scene.add(m)
      this.hillMeshes.push(m)
    }
  }

  private buildTrees(): void {
    const base = this.models.tree.scene
    const spots: Array<[number, number, number, number]> = [
      [-14, -24, 9, 0.2], [-6, -27, 11, 1.3], [5, -26, 10, 2.2], [13, -23, 8.5, 0.8], [22, -28, 12, 1.7], [-24, -22, 9, 2.6],
      [-12, -9, 6.5, 0.5], [12.5, -8.5, 7, 2.9], [-17, 2, 7.5, 1.1], [17, 3, 8, 0.3], [30, -35, 13, 1.9], [-32, -33, 12, 0.9],
    ]
    for (const [x, z, h, rot] of spots) {
      const t = fitModel(base.clone(), 'y', h, { shadow: Math.hypot(x, z) < 16, receive: false })
      // Plant on the real terrain: sample the trunk footprint and use the lowest point so no
      // side of the trunk floats on a slope, then sink the base slightly.
      const r = 0.5
      const ys = [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]].map(([dx, dz]) => this.groundHeight(x + dx, z + dz))
      t.position.set(x, Math.min(...ys) - 0.35, z)
      t.rotation.y = rot
      this.scene.add(t)
      if (Math.hypot(x, z) < 16) this.colliders.push({ x, z, r: 0.6 })
    }
  }

  private buildFences(): void {
    const seg = 2.4
    const proto = fitModel(this.models.fence.scene, 'z', seg)
    for (let i = -4; i < 4; i++) {
      const f = proto.clone()
      f.position.set((i + 0.5) * seg, 0, LAYOUT.fenceZ)
      f.rotation.y = Math.PI / 2
      this.scene.add(f)
    }
    for (let i = 0; i < 4; i++) {
      const f = proto.clone()
      f.position.set(LAYOUT.sideFenceX, 0, LAYOUT.fenceZ + 1.2 + i * seg)
      this.scene.add(f)
    }
  }

  setLantern(level: LanternLevel): void {
    this.lanternLevel = level
  }

  /** Per-frame atmosphere: night depth drives sky, fog, lights; the lantern flickers. */
  update(dt: number, night: number, reducedMotion: boolean): void {
    this.time.value += dt
    const t = this.time.value
    const n = night
    const sky = this.sky.material.uniforms
    sky.uNight.value = n
    sky.uTime.value = t
    const fogDusk = new THREE.Color(0x5a3446), fogNight = new THREE.Color(0x0b0d1c)
    this.fog.color.copy(fogDusk).lerp(fogNight, n)
    this.fog.near = 14 + n * 4
    this.fog.far = 70 - n * 25
    this.hemi.color.set(0xc08090).lerp(new THREE.Color(0x3a4a80), n)
    this.hemi.groundColor.set(0x2e2416).lerp(new THREE.Color(0x0c0c14), n)
    this.hemi.intensity = 0.95 - n * 0.6
    this.sun.intensity = Math.max(0, 2.3 * (1 - n * 1.15))
    this.sun.color.set(0xff9a55).lerp(new THREE.Color(0xff5e3a), Math.min(1, n * 1.4))
    this.moon.intensity = n * 0.55
    const target = lanternIntensity(this.lanternLevel, n)
    this.lanternShown += (target - this.lanternShown) * Math.min(1, dt * 4)
    const flicker = reducedMotion ? 1 : 0.9 + Math.sin(t * 13.0) * 0.04 + Math.sin(t * 7.3 + 1.7) * 0.05 + Math.sin(t * 23.1) * 0.02
    this.lanternLight.intensity = this.lanternShown * flicker
    const glow = this.lanternShown / 7
    this.lanternFlame.visible = this.lanternShown > 0.05
    this.lanternFlame.material.color.setRGB(4.5 * glow * flicker + 0.2, 2.4 * glow * flicker + 0.1, 0.8 * glow + 0.02)
    this.lanternHalo.material.opacity = Math.min(0.8, glow * 0.9) * flicker
    this.lanternHalo.scale.setScalar(0.6 + glow * 0.8)
  }
}

let halo: THREE.Texture | undefined
export function haloTexture(): THREE.Texture {
  if (halo) return halo
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  grd.addColorStop(0, 'rgba(255,255,255,1)')
  grd.addColorStop(0.25, 'rgba(255,255,255,0.45)')
  grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, 128, 128)
  halo = new THREE.CanvasTexture(c)
  return halo
}

/** Dusk-tinted environment map so PBR props pick up warm reflections instead of black. */
export function duskEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pm = new THREE.PMREMGenerator(renderer)
  const envScene = new THREE.Scene()
  const mat = makeSkyMaterial()
  mat.uniforms.uNight.value = 0.15
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), mat))
  const rt = pm.fromScene(envScene, 0.02)
  pm.dispose()
  return rt.texture
}
