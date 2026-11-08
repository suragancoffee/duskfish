import * as THREE from 'three'
import type { Audio } from '../engine/audio'
import type { Input } from '../engine/input'
import type { Renderer } from '../engine/renderer'
import type { Quality } from '../engine/save'
import { makeAxe, HEAD_FRACTION } from './axe'
import { CONFIG } from './config'
import { cutWoodMaterial, Effects, pieceGeometry, WoodPile } from './fx'
import {
  angleDelta, CHOP_DURATION, CHOP_IMPACT, lerp, nearestSpot, nextLanternLevel, nightAt,
  PILE_CAPACITY, pushOutOfCircle, smooth, type LanternLevel, type Spot,
} from './rules'
import { Bar, BAR, Campfire, CAMPFIRE } from './props'
import { Fireflies } from './ambient'
import { Shrimp } from './shrimp'
import { Tuna } from './tuna'
import { duskEnvironment, LAYOUT, World, type Models } from './world'

export type GameMode = 'title' | 'playing' | 'paused'
type Activity = 'free' | 'chop' | 'sitIn' | 'sitting' | 'sitOut'

export type HudState = {
  wood: number
  night: number
  prompt: string | null
  sitting: boolean
  zoneSeconds: number
}

export type GameEvents = {
  toast(key: string): void
  hint(key: string | null): void
  zoneLine(key: string): void
  cinematic(on: boolean): void
  addWood(n: number): void
  addZone(seconds: number): void
}

type Seat = { id: string; pos: THREE.Vector3; rootY: number; heading: number; standAt: THREE.Vector3; promptKey: string }

type Half = {
  group: THREE.Group
  plane: THREE.Plane
  normal: THREE.Vector3
  side: 1 | -1
  slot: number
  start: THREE.Vector3
  startQ: THREE.Quaternion
  done: boolean
}

type Flyer = { mesh: THREE.Mesh; from: THREE.Vector3; slot: number; t: number; dur: number; fromQ: THREE.Quaternion; toQ: THREE.Quaternion }

const tmpV = new THREE.Vector3()
const tmpQ = new THREE.Quaternion()

export class Game {
  mode: GameMode = 'title'
  reducedMotion = false
  readonly camera = new THREE.PerspectiveCamera(48, 1, 0.05, 900)
  private readonly world: World
  private readonly fx: Effects
  private readonly tuna: Tuna
  private readonly shrimp: Shrimp
  private readonly pile: WoodPile
  private readonly axe: THREE.Group
  private readonly axeStuck = new THREE.Matrix4()
  private readonly seats: Seat[]
  private activity: Activity = 'free'
  private elapsed = 0
  private night = 0
  private velocity = new THREE.Vector3()
  private vy = 0
  private grounded = true
  private land = 0
  private sessionWood = 0
  private reservedSlots = 0
  private chopCount = 0
  private shrimpImpacts = 0
  private nightHintShown = false
  private sitHintShown = false
  /** Set by E (or walking away) during a chop session; the current swing finishes first. */
  private chopStop = false
  // Chop
  private ct = 0
  private chopFrom = new THREE.Vector3()
  private chopFromHeading = 0
  private impactDone = false
  private halves: Half[] = []
  private newLogT = -1
  private flyers: Flyer[] = []
  private shake = 0
  // Sitting
  private seat?: Seat
  private sitT = 0
  private sitFrom = new THREE.Vector3()
  private sitFromHeading = 0
  private puffT = 4
  private puffPhase: 'idle' | 'inhale' | 'hold' = 'idle'
  private zoneLineT = 6
  private zoneSession = 0
  private wispT = 0
  private walkPuffT = 10
  // Camera
  private camYaw = 0.25
  private camPitch = 0.3
  private camDist = CONFIG.camera.distance
  private camPos = new THREE.Vector3(6, 3, 8)
  private camLook = new THREE.Vector3(0, 1, -2)
  private nearest: Spot | null = null
  private readonly campfire: Campfire
  private readonly bar: Bar
  private readonly guitar: THREE.Group
  private strumT = 0
  private strumKick = 0
  private sipT = 0
  private sips = 0
  private readonly fireflies = new Fireflies()
  private barVisitCd = 0
  private danceCd = 0
  private greetT = 0
  private greetCool = 0
  private greetIdx = 0
  private readonly shrimpSpot: Spot = { id: 'shrimp', kind: 'greet', x: 999, z: 999, reach: 1.7 }
  private readonly cutMat = cutWoodMaterial()
  private readonly barkMat: THREE.Material
  private readonly pieceGeo = pieceGeometry(0.15, 0.4)

  constructor(private readonly renderer: Renderer, private readonly input: Input, private readonly audio: Audio,
    models: Models, private readonly events: GameEvents, quality: Quality, private readonly t: (k: string) => string) {
    this.world = new World(models, quality)
    const scene = this.world.scene
    scene.environment = duskEnvironment(renderer.gl)
    scene.environmentIntensity = 0.55
    this.cutMat.map = ringTexture()

    this.fx = new Effects(quality)
    scene.add(this.fx.group)

    this.tuna = new Tuna(models.tuna, models.boot)
    this.tuna.root.position.set(1.2, 0, 2.6)
    this.tuna.heading = Math.PI
    this.tuna.onFootfall = (_side, strength) => {
      if (this.activity === 'free' || this.activity === 'chop') this.audio.play('step', { volume: 0.45 * strength, jitter: 0.12 })
    }
    scene.add(this.tuna.root)

    this.shrimp = new Shrimp(models.shrimp, models.axe, LAYOUT.shrimpBlock, 0.6, new THREE.Vector3(-1.75, 0, 0.15))
    this.shrimp.onChopImpact = () => this.onShrimpImpact()
    scene.add(this.shrimp.root)

    this.axe = makeAxe(models.axe, 0.8)
    this.axe.traverse(o => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).castShadow = true) : undefined))
    scene.add(this.axe)
    // Stuck pose: blade bitten into the stump rim, handle angled up toward the player.
    const stuck = new THREE.Object3D()
    stuck.rotation.set(0.95, Math.PI + 0.5, 0, 'YXZ')
    stuck.updateMatrix()
    const headOffset = new THREE.Vector3(0, -0.02, 0.8 * HEAD_FRACTION).applyQuaternion(stuck.quaternion)
    const bite = new THREE.Vector3(LAYOUT.stump.x + 0.28, LAYOUT.stumpTop - 0.05, LAYOUT.stump.z + 0.12)
    stuck.position.copy(bite).sub(headOffset)
    stuck.updateMatrix()
    this.axeStuck.copy(stuck.matrix)
    this.applyAxeMatrix(this.axeStuck)

    let bark: THREE.Material | undefined
    models.log.scene.traverse(o => {
      if (!bark && (o as THREE.Mesh).isMesh) bark = (o as THREE.Mesh).material as THREE.Material
    })
    this.barkMat = bark ?? new THREE.MeshStandardMaterial({ color: 0x6b4a2e })
    this.pile = new WoodPile(LAYOUT.pile, this.barkMat)
    scene.add(this.pile.mesh)

    this.seats = [
      { id: 'rock', pos: LAYOUT.rockSeat.clone(), rootY: 0.56, heading: Math.PI, standAt: new THREE.Vector3(LAYOUT.rock.x + 0.2, 0, LAYOUT.rock.z - 1.25), promptKey: 'prompt.sit.rock' },
      { id: 'fence', pos: LAYOUT.fenceSeat.clone(), rootY: 0.74, heading: Math.PI, standAt: new THREE.Vector3(LAYOUT.fenceSeat.x, 0, LAYOUT.fenceZ + 0.75), promptKey: 'prompt.sit.fence' },
    ]
    this.campfire = new Campfire(models, this.world.colliders)
    scene.add(this.campfire.group)
    this.bar = new Bar(this.world.colliders)
    scene.add(this.bar.group)
    this.seats.push({ id: 'campfire', pos: CAMPFIRE.seat.clone(), rootY: CAMPFIRE.seatTop - 0.02, heading: Math.PI,
      standAt: new THREE.Vector3(CAMPFIRE.seat.x + 1.0, 0, CAMPFIRE.seat.z + 0.45), promptKey: 'prompt.sit.campfire' })
    this.world.spots.push({ id: 'campfire', kind: 'sit', x: CAMPFIRE.seat.x, z: CAMPFIRE.seat.z + 0.25, reach: 1.25 })
    this.seats.push({ id: 'bar', pos: BAR.stool.clone(), rootY: BAR.stoolTop - 0.02, heading: -Math.PI / 2,
      standAt: new THREE.Vector3(BAR.stool.x + 0.85, 0, BAR.stool.z + 0.2), promptKey: 'prompt.sit.bar' })
    this.world.spots.push({ id: 'bar', kind: 'sit', x: BAR.stool.x + 0.35, z: BAR.stool.z, reach: 1.1 })
    this.world.spots.push(this.shrimpSpot)
    this.world.spots.push({ id: 'feed', kind: 'feed', x: CAMPFIRE.pos.x - 0.95, z: CAMPFIRE.pos.z, reach: 0.85 })
    scene.add(this.fireflies.points)
    this.shrimp.onToastArrive = () => {
      if (this.seat?.id !== 'bar' || this.activity !== 'sitting') return
      window.setTimeout(() => { this.sipT = 0.25 }, 600)
      window.setTimeout(() => {
        this.audio.clink(0.32)
        this.events.toast('toast.cheers')
      }, 1700)
    }
    this.guitar = makeGuitar(models.guitar)
    this.guitar.visible = false
    this.tuna.body.add(this.guitar)
    this.world.update(0, 0, false)
  }

  get scene(): THREE.Scene {
    return this.world.scene
  }

  /** Read-only state for the HUD. */
  hud(): HudState {
    let prompt: string | null = null
    if (this.activity === 'sitting') prompt = this.t('prompt.stand')
    else if (this.activity === 'chop') prompt = this.chopStop ? null : this.t('prompt.chop.stop')
    else if (this.activity === 'free' && this.nearest) prompt = this.promptFor(this.nearest)
    return { wood: this.sessionWood, night: this.night, prompt, sitting: this.activity === 'sitting' || this.activity === 'sitIn', zoneSeconds: this.zoneSession }
  }

  /** Test/debug snapshot. */
  debug(): Record<string, unknown> {
    return { activity: this.activity, mode: this.mode, wood: this.sessionWood, pile: this.pile.count, night: this.night,
      tuna: this.tuna.root.position.toArray(), shrimp: this.shrimp.state, lantern: this.world.lanternLevel, nearest: this.nearest?.id ?? null, ct: this.ct }
  }

  private promptFor(spot: Spot): string {
    if (spot.kind === 'chop') return this.t('prompt.chop')
    if (spot.kind === 'greet') return this.t('prompt.greet')
    if (spot.kind === 'feed') return this.pile.count > 0 ? `${this.t('prompt.feed')} (${this.pile.count})` : this.t('prompt.feed.empty')
    if (spot.kind === 'lantern') return this.t(this.world.lanternLevel === 0 ? 'prompt.lantern.on' : this.world.lanternLevel === 1 ? 'prompt.lantern.up' : 'prompt.lantern.off')
    const seat = this.seats.find(s => s.id === spot.id)
    return this.t(seat?.promptKey ?? 'prompt.sit.rock')
  }

  start(): void {
    this.mode = 'playing'
    this.events.hint('hint.welcome')
    window.setTimeout(() => this.events.hint(null), 9000)
  }

  pause(): void {
    if (this.mode === 'playing') this.mode = 'paused'
  }

  resume(): void {
    if (this.mode === 'paused') this.mode = 'playing'
  }

  toTitle(): void {
    if (this.activity === 'sitting' || this.activity === 'sitIn') this.events.cinematic(false)
    this.mode = 'title'
  }

  setQuality(q: Quality): void {
    this.renderer.applyQuality(q)
  }

  /** One rendered frame. Slow motion scales world time; UI and camera smoothing use real time. */
  frame(realDt: number): void {
    const playing = this.mode === 'playing'
    const paused = this.mode === 'paused'
    let scale = 1
    const dt = paused ? 0 : realDt * scale

    if (!paused) {
      this.elapsed += dt
      this.night = nightAt(this.elapsed, CONFIG.world.nightMinutes)
    }
    if (playing) this.updatePlay(dt, realDt)
    else if (!paused) this.tuna.update(dt, 0, this.reducedMotion)

    if (!paused) {
      this.shrimp.update(dt, this.tuna.root.position)
      const sp = this.shrimp.collider
      this.shrimpSpot.x = this.shrimp.canGreet && this.greetCool <= 0 ? sp.x : 999
      this.shrimpSpot.z = sp.z
      this.greetCool -= dt
      this.world.update(dt, this.night, this.reducedMotion)
      this.updateSmoke(dt)
      this.updateFlyers(dt)
      this.fx.update(dt, this.night, this.elapsed)
      this.fireflies.update(dt, this.night, this.world.lanternLevel)
      this.updateVisits(dt)
      this.campfire.update(dt, this.night, p => this.fx.wisp(p, 3), (p, v) => this.fx.ember(p, v, 1.3))
      this.bar.update(this.elapsed, this.night)
      const fd = this.tuna.root.position.distanceTo(CAMPFIRE.pos)
      this.audio.fire((playing ? Math.max(0, 1 - fd / 9) : 0.15) * (1 + this.campfire.fuel * 0.6), dt)
      this.audio.setAmbience(0.45 + this.night * 0.55)
      if (playing && !this.nightHintShown && this.night > 0.62 && this.world.lanternLevel < 2) {
        this.nightHintShown = true
        this.events.hint('hint.night')
        window.setTimeout(() => this.events.hint(null), 8000)
      }
    }
    this.updateCamera(realDt, dt)
    this.fx.setViewportHeight(this.renderer.canvas.clientHeight || window.innerHeight, this.camera.fov)
    this.campfire.setViewport((this.renderer.canvas.clientHeight || window.innerHeight) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)))
    this.fireflies.setViewport((this.renderer.canvas.clientHeight || window.innerHeight) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)))
    this.renderer.render(this.world.scene, this.camera)
  }

  private updatePlay(dt: number, realDt: number): void {
    const interact = this.input.consume('interact')
    switch (this.activity) {
      case 'free':
        this.updateFree(dt, interact)
        break
      case 'chop':
        if (interact || Math.hypot(this.input.move.x, this.input.move.y) > 0.5) this.chopStop = true
        this.updateChop(dt)
        this.tuna.update(dt, 0, this.reducedMotion)
        break
      case 'sitIn':
      case 'sitOut':
        this.updateSitTransition(dt)
        break
      case 'sitting':
        this.updateSitting(dt, realDt, interact)
        break
    }
  }

  // ---------------------------------------------------------------- free roaming
  private updateFree(dt: number, interact: boolean): void {
    const look = this.input.takeLook()
    this.camYaw -= look.x
    this.camPitch = THREE.MathUtils.clamp(this.camPitch + look.y * 0.6, 0.05, 0.95)
    this.camDist = THREE.MathUtils.clamp(this.camDist + this.input.takeZoom(), 3, 11)
    const mx = this.input.move.x, my = this.input.move.y
    const fwd = new THREE.Vector3(-Math.sin(this.camYaw), 0, -Math.cos(this.camYaw))
    const right = new THREE.Vector3(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw))
    const wish = fwd.multiplyScalar(my).add(right.multiplyScalar(mx))
    const mag = Math.min(1, wish.length())
    const speed = (this.input.held('sprint') ? CONFIG.player.trotSpeed : CONFIG.player.walkSpeed) * mag
    const targetV = mag > 0.01 ? wish.normalize().multiplyScalar(speed) : new THREE.Vector3()
    this.velocity.lerp(targetV, Math.min(1, dt * 6))
    const pos = this.tuna.root.position
    pos.addScaledVector(this.velocity, dt)
    this.collide(pos)
    // Jump: a hop on the boots; landing thumps.
    if (this.input.consume('jump') && this.grounded) {
      this.vy = 3.3
      this.grounded = false
      this.audio.play('step', { volume: 0.4, rate: 1.2 })
    }
    if (!this.grounded) {
      this.vy -= 9.8 * dt
      pos.y += this.vy * dt
      if (pos.y <= 0) {
        pos.y = 0
        this.vy = 0
        this.grounded = true
        this.land = 1
        this.audio.play('step', { volume: 0.8, rate: 0.85 })
        this.audio.play('step', { volume: 0.6, rate: 0.95 })
      }
    }
    this.tuna.air += ((this.grounded ? 0 : 1) - this.tuna.air) * Math.min(1, dt * 12)
    this.land *= Math.exp(-dt * 8)
    const sp = this.velocity.length()
    if (sp > 0.15) {
      const h = Math.atan2(this.velocity.x, this.velocity.z)
      this.tuna.heading += angleDelta(this.tuna.heading, h) * Math.min(1, dt * CONFIG.player.turnRate)
    }
    if (this.greetT > 0) {
      // Face the shrimp and give two slow cowboy nods (the hat dips with the head).
      this.greetT = Math.max(0, this.greetT - dt)
      const d = this.shrimp.collider
      const want = Math.atan2(d.x - pos.x, d.z - pos.z)
      this.tuna.heading += angleDelta(this.tuna.heading, want) * Math.min(1, dt * 6)
      const k = 1.6 - this.greetT
      this.tuna.pitch = k > 0.2 && k < 1.4 ? Math.sin((k - 0.2) * Math.PI * 2 / 1.2) ** 2 * 0.22 : 0
    }
    this.tuna.update(dt, this.grounded ? sp : 0, this.reducedMotion)
    this.tuna.hips.position.y -= this.land * 0.06

    this.nearest = this.grounded ? nearestSpot(this.world.spots, pos.x, pos.z) : null
    if (interact && this.nearest) this.interact(this.nearest)
  }

  private collide(pos: THREE.Vector3): void {
    const r = 0.38
    for (const c of [...this.world.colliders, this.shrimp.collider]) {
      const p = pushOutOfCircle(pos.x, pos.z, c.x, c.z, c.r + r)
      pos.x = p.x
      pos.z = p.z
    }
    pos.z = Math.max(pos.z, LAYOUT.fenceZ + 0.42)
    pos.x = Math.max(pos.x, LAYOUT.sideFenceX + 0.42)
    const d = Math.hypot(pos.x, pos.z - 1)
    if (d > 11.5) {
      pos.x *= 11.5 / d
      pos.z = 1 + (pos.z - 1) * (11.5 / d)
    }
  }

  private interact(spot: Spot): void {
    if (spot.kind === 'greet') this.greet()
    else if (spot.kind === 'feed') this.feedFire()
    else if (spot.kind === 'chop') this.beginChop()
    else if (spot.kind === 'lantern') {
      const next = nextLanternLevel(this.world.lanternLevel) as LanternLevel
      this.world.setLantern(next)
      this.audio.play('lantern', { volume: 0.8 })
      this.events.toast(`toast.lantern.${next}`)
    } else {
      const seat = this.seats.find(s => s.id === spot.id)
      if (seat) this.beginSit(seat)
    }
  }

  // ---------------------------------------------------------------- chopping
  private feedFire(): void {
    const c = CAMPFIRE.pos
    this.tuna.heading = Math.atan2(c.x - this.tuna.root.position.x, c.z - this.tuna.root.position.z)
    if (this.pile.count <= 0) {
      this.events.toast('toast.feed.empty')
      return
    }
    this.pile.setCount(this.pile.count - 1)
    this.reservedSlots = Math.max(this.pile.count, this.reservedSlots - 1)
    this.campfire.feed()
    this.audio.play('stack', { volume: 0.6, rate: 0.8 })
    for (let i = 0; i < 14; i++) {
      this.fx.ember(new THREE.Vector3(c.x, 0.3, c.z), new THREE.Vector3((Math.random() - 0.5) * 1.2, 1.5 + Math.random() * 1.5, (Math.random() - 0.5) * 1.2), 1.6)
    }
    this.events.toast(this.campfire.fuel > 0.9 ? 'toast.feed.big' : 'toast.feed')
  }

  /** Shrimp comes over to clink glasses at the bar, or dances while the tuna strums. */
  private updateVisits(dt: number): void {
    const sitting = this.activity === 'sitting' && this.seat
    this.barVisitCd -= dt
    this.danceCd -= dt
    if (!sitting) {
      this.shrimp.leave()
      return
    }
    if (this.seat!.id === 'bar' && this.sitT > 5 && this.barVisitCd <= 0) {
      const to = new THREE.Vector3(BAR.stool2.x, BAR.stoolTop, BAR.stool2.z)
      if (this.shrimp.visit(to, BAR.stool, 'toast')) this.barVisitCd = 40
      else this.barVisitCd = 3
    } else if (this.seat!.id === 'campfire' && this.sitT > 2.5 && this.danceCd <= 0 && !this.shrimp.visiting) {
      const to = new THREE.Vector3(CAMPFIRE.seat.x - 1.3, 0, CAMPFIRE.seat.z - 0.45)
      if (this.shrimp.visit(to, CAMPFIRE.seat, 'dance')) this.events.toast('toast.dance')
      this.danceCd = 3
    } else if (this.seat!.id !== 'campfire' && this.seat!.id !== 'bar') {
      this.shrimp.leave()
    }
  }

  private greet(): void {
    if (!this.shrimp.greet()) return
    this.greetT = 1.6
    this.greetCool = 3.5
    this.velocity.set(0, 0, 0)
    this.audio.play('step', { volume: 0.35, rate: 1.3 })
    window.setTimeout(() => this.audio.chirp(), 350)
    const night = this.night > 0.6
    const n = night ? 6 : 5
    this.greetIdx = (this.greetIdx + 1 + Math.floor(Math.random() * (n - 1))) % n
    this.events.toast(night ? `greet.night.${this.greetIdx}` : `greet.dusk.${this.greetIdx}`)
  }

  private beginChop(): void {
    this.chopStop = false
    this.activity = 'chop'
    this.ct = 0
    this.impactDone = false
    this.velocity.set(0, 0, 0)
    this.chopFrom.copy(this.tuna.root.position)
    this.chopFromHeading = this.tuna.heading
    this.nearest = null
    this.events.hint(null)
  }

  private chopSpot(): THREE.Vector3 {
    return new THREE.Vector3(LAYOUT.stump.x, 0, LAYOUT.stump.z + 1.25)
  }

  private updateChop(dt: number): void {
    this.ct += dt
    const ct = this.ct
    const spot = this.chopSpot()
    const tuna = this.tuna
    // Step in to the chopping position facing the stump (-Z).
    const k = smooth(ct / 0.3)
    tuna.root.position.lerpVectors(this.chopFrom, spot, k)
    tuna.heading = this.chopFromHeading + angleDelta(this.chopFromHeading, Math.PI) * k

    // Axe & body keyframes in tuna space: grip position (local) and axe pitch.
    type K = { t: number; grip: [number, number, number]; rx: number; pitch: number }
    const keys: K[] = [
      { t: 0.3, grip: [0.1, 0.95, 0.5], rx: -0.9, pitch: 0 },
      { t: CHOP_IMPACT - 0.22, grip: [0.06, 1.32, 0.22], rx: -2.35, pitch: -0.38 },
      { t: CHOP_IMPACT, grip: [0.02, 0.98, 0.56], rx: 0.02, pitch: 0.3 },
      { t: 1.5, grip: [0.02, 0.99, 0.55], rx: 0.08, pitch: 0.22 },
    ]
    let pitch = 0
    const local = new THREE.Object3D()
    if (ct < 0.3) {
      this.blendAxe(this.axeStuck, this.axeInTuna(keys[0]), smooth(ct / 0.3))
    } else if (ct < 1.5) {
      let i = 0
      while (i < keys.length - 2 && ct > keys[i + 1].t) i++
      const a = keys[i], b = keys[i + 1]
      let u = THREE.MathUtils.clamp((ct - a.t) / (b.t - a.t), 0, 1)
      u = b.t === CHOP_IMPACT ? u * u * u : smooth(u)
      local.position.set(lerp(a.grip[0], b.grip[0], u), lerp(a.grip[1], b.grip[1], u), lerp(a.grip[2], b.grip[2], u))
      local.rotation.set(lerp(a.rx, b.rx, u), 0, 0)
      pitch = lerp(a.pitch, b.pitch, u)
      this.applyAxeMatrix(this.tunaMatrix(local))
    } else if (ct < 2.25) {
      const u = smooth((ct - 1.5) / 0.75)
      this.blendAxe(this.axeInTuna(keys[3]), this.axeStuck, u)
      pitch = lerp(0.22, 0, u)
    } else {
      this.applyAxeMatrix(this.axeStuck)
    }
    tuna.pitch = pitch
    if (!this.impactDone && ct >= CHOP_IMPACT) {
      this.impactDone = true
      this.onImpact()
    }
    this.updateHalves()
    this.updateNewLog(dt)
    if (ct >= CHOP_DURATION) {
      this.chopCount++
      if (!this.chopStop) {
        // Keep chopping: next log is already on the stump.
        this.ct = 0
        this.impactDone = false
        this.chopFrom.copy(tuna.root.position)
        this.chopFromHeading = tuna.heading
        return
      }
      this.activity = 'free'
      tuna.pitch = 0
      if (this.chopCount === 2 && !this.sitHintShown) {
        this.sitHintShown = true
        this.events.hint('hint.sit')
        window.setTimeout(() => this.events.hint(null), 8000)
      }
    }
  }

  private tunaMatrix(local: THREE.Object3D): THREE.Matrix4 {
    local.updateMatrix()
    const root = new THREE.Matrix4().compose(this.tuna.root.position, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.tuna.heading), new THREE.Vector3(1, 1, 1))
    return root.multiply(local.matrix)
  }

  private axeInTuna(k: { grip: [number, number, number]; rx: number }): THREE.Matrix4 {
    const o = new THREE.Object3D()
    o.position.set(...k.grip)
    o.rotation.set(k.rx, 0, 0)
    return this.tunaMatrix(o)
  }

  private applyAxeMatrix(m: THREE.Matrix4): void {
    m.decompose(this.axe.position, this.axe.quaternion, this.axe.scale)
  }

  private blendAxe(a: THREE.Matrix4, b: THREE.Matrix4, u: number): void {
    const pa = new THREE.Vector3(), qa = new THREE.Quaternion(), pb = new THREE.Vector3(), qb = new THREE.Quaternion(), s = new THREE.Vector3()
    a.decompose(pa, qa, s)
    b.decompose(pb, qb, s)
    this.axe.position.lerpVectors(pa, pb, u)
    this.axe.position.y += Math.sin(u * Math.PI) * 0.15
    this.axe.quaternion.slerpQuaternions(qa, qb, u)
  }

  private onImpact(): void {
    const top = new THREE.Vector3(LAYOUT.stump.x, LAYOUT.stumpTop + LAYOUT.logHeight, LAYOUT.stump.z)
    this.audio.play('chop', { volume: 1, rate: 0.92, jitter: 0.04 })
    this.fx.chipBurst(top, 46, 1)
    this.shake = this.reducedMotion ? 0 : 1
    // Replace the whole log by two clipped halves that fall apart, then fly onto the pile.
    this.world.logOnStump.visible = false
    for (const side of [1, -1] as const) {
      const g = this.world.makeLog(LAYOUT.logHeight)
      const normal = new THREE.Vector3(side, 0, 0)
      const plane = new THREE.Plane()
      g.traverse(o => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(m => {
          const c = m.clone()
          c.clippingPlanes = [plane]
          c.clipShadows = true
          c.side = THREE.DoubleSide
          return c
        })
        mesh.material = Array.isArray(mesh.material) ? mats : mats[0]
      })
      const box = new THREE.Box3().setFromObject(g)
      const size = box.getSize(new THREE.Vector3())
      const cap = new THREE.Mesh(new THREE.PlaneGeometry(size.z * 0.9, size.y * 0.98), this.cutMat)
      cap.position.set(0.002 * side, size.y / 2, 0)
      cap.rotation.y = side === 1 ? -Math.PI / 2 : Math.PI / 2
      cap.castShadow = true
      g.add(cap)
      g.position.set(LAYOUT.stump.x, LAYOUT.stumpTop - 0.01, LAYOUT.stump.z)
      this.world.scene.add(g)
      const slot = this.reserveSlot()
      this.halves.push({ group: g, plane, normal, side, slot, start: g.position.clone(), startQ: g.quaternion.clone(), done: false })
    }
    this.newLogT = 0
    if (this.shrimp.state === 'watch' && this.shrimp.position.distanceTo(this.tuna.root.position) < 7 && Math.random() < 0.6) this.shrimp.cheer()
  }

  private reserveSlot(): number {
    const s = this.reservedSlots
    this.reservedSlots++
    return s
  }

  private updateHalves(): void {
    const since = this.ct - CHOP_IMPACT
    if (since < 0) return
    for (const h of this.halves) {
      if (h.done) continue
      const g = h.group
      if (since < 0.6) {
        // Topple apart around the bottom outer edge.
        const a = smooth(since / 0.6) * 1.15
        g.rotation.set(0, 0, -h.side * a)
        g.position.set(h.start.x + h.side * (0.06 + a * 0.16), h.start.y + Math.sin(a) * 0.06 - a * 0.02, h.start.z)
        h.startQ.copy(g.quaternion)
        h.start.copy(g.position)
        h.start.x = LAYOUT.stump.x
        h.start.y = LAYOUT.stumpTop - 0.01
      } else {
        const u = Math.min(1, (since - 0.6 - (h.side === 1 ? 0 : 0.18)) / 0.85)
        if (u > 0) {
          const from = new THREE.Vector3(LAYOUT.stump.x + h.side * 0.24, LAYOUT.stumpTop + 0.02, LAYOUT.stump.z)
          const slot = this.pile.slotWorld(Math.min(PILE_CAPACITY - 1, h.slot))
          const e = smooth(u)
          g.position.lerpVectors(from, slot.pos, e)
          g.position.y += Math.sin(e * Math.PI) * 1.1
          // Lie down along Z, cut face downward (half +X keeps x>0, its cut faces -X).
          const lie = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, h.side === 1 ? Math.PI / 2 : -Math.PI / 2, 'ZXY'))
          if (slot.rotZ) lie.premultiply(tmpQ.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI))
          const settle = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -h.side * 1.15))
          g.quaternion.slerpQuaternions(settle, lie, e)
          // Shrink toward the pile-piece size; recentre: the group origin is the log base axis.
          const s = lerp(1, 0.78, e)
          g.scale.setScalar(s)
          g.position.y -= e * 0.0
          if (u >= 1) this.landHalf(h)
        }
      }
      g.updateMatrixWorld(true)
      h.plane.setFromNormalAndCoplanarPoint(h.normal, new THREE.Vector3()).applyMatrix4(g.matrixWorld)
    }
    if (this.halves.length && this.halves.every(h => h.done)) this.halves = []
  }

  private landHalf(h: Half): void {
    h.done = true
    this.world.scene.remove(h.group)
    this.addPieces(1)
  }

  private addPieces(n: number): void {
    const before = this.pile.count
    this.sessionWood += n
    this.events.addWood(n)
    this.pile.setCount(before + n)
    this.audio.play('stack', { volume: 0.55 })
    if (before < PILE_CAPACITY && before + n >= PILE_CAPACITY) this.events.toast('toast.pileFull')
    if (this.reservedSlots < this.pile.count) this.reservedSlots = this.pile.count
  }

  private updateNewLog(dt: number): void {
    if (this.newLogT < 0) return
    this.newLogT += dt
    const log = this.world.logOnStump
    const appear = CHOP_DURATION - CHOP_IMPACT - 0.75
    const t = this.newLogT - appear
    if (t < 0) return
    log.visible = true
    const fall = 0.45
    const baseY = LAYOUT.stumpTop - 0.01
    if (t < fall) {
      const u = t / fall
      log.position.y = baseY + (1 - u * u) * 1.3
    } else {
      const b = t - fall
      log.position.y = baseY + Math.max(0, Math.sin(b * 14) * 0.035 * Math.exp(-b * 9))
      if (b > 0.5) {
        log.position.y = baseY
        this.newLogT = -1
      }
    }
  }

  private onShrimpImpact(): void {
    const top = this.shrimp.blockImpactPoint
    this.fx.chipBurst(top, 10, 0.55)
    const d = this.camPos.distanceTo(top)
    this.audio.play('chop', { volume: Math.max(0.08, 0.5 - d * 0.03), rate: 1.12, jitter: 0.08 })
    this.shrimpImpacts++
    if (this.mode === 'playing' && this.shrimpImpacts % 3 === 0) {
      const mesh = new THREE.Mesh(this.pieceGeo, [this.barkMat, this.cutMat])
      mesh.castShadow = true
      mesh.position.copy(top)
      this.world.scene.add(mesh)
      const slot = this.reserveSlot()
      const toQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, this.pile.slotWorld(Math.min(PILE_CAPACITY - 1, slot)).rotZ))
      this.flyers.push({ mesh, from: top.clone(), slot, t: 0, dur: 1.1, fromQ: new THREE.Quaternion().setFromEuler(new THREE.Euler(1.2, 0.4, 0)), toQ })
      this.events.toast('toast.shrimp')
    }
  }

  private updateFlyers(dt: number): void {
    for (let i = this.flyers.length - 1; i >= 0; i--) {
      const f = this.flyers[i]
      f.t += dt
      const u = Math.min(1, f.t / f.dur)
      const e = smooth(u)
      const to = this.pile.slotWorld(Math.min(PILE_CAPACITY - 1, f.slot)).pos
      f.mesh.position.lerpVectors(f.from, to, e)
      f.mesh.position.y += Math.sin(e * Math.PI) * 1.4
      f.mesh.quaternion.slerpQuaternions(f.fromQ, f.toQ, e)
      if (u >= 1) {
        this.world.scene.remove(f.mesh)
        this.flyers.splice(i, 1)
        this.addPieces(1)
      }
    }
  }

  // ---------------------------------------------------------------- sitting & smoking
  private beginSit(seat: Seat): void {
    this.seat = seat
    this.activity = 'sitIn'
    this.sitT = 0
    this.sitFrom.copy(this.tuna.root.position)
    this.sitFromHeading = this.tuna.heading
    this.velocity.set(0, 0, 0)
    this.nearest = null
    this.zoneSession = 0
    this.zoneLineT = 5
    this.puffT = 2.5
    this.strumT = -1.2
    this.guitar.visible = seat.id === 'campfire'
    this.sipT = -1.0
    if (seat.id === 'bar') {
      this.sips = 0
      this.bar.liquid.scale.y = 1
      this.audio.pour(0.28)
      window.setTimeout(() => this.audio.clink(0.22), 900)
      this.events.toast('toast.whisky.pour')
    }
    this.audio.play('sit', { volume: 0.7 })
    this.events.cinematic(true)
    this.events.hint(null)
  }

  private updateSitTransition(dt: number): void {
    const seat = this.seat!
    this.sitT += dt
    const dur = this.activity === 'sitIn' ? 0.9 : 0.7
    const u = Math.min(1, this.sitT / dur)
    const e = smooth(u)
    const tuna = this.tuna
    if (this.activity === 'sitIn') {
      const to = new THREE.Vector3(seat.pos.x, seat.rootY, seat.pos.z)
      tuna.root.position.lerpVectors(this.sitFrom, to, e)
      tuna.root.position.y = lerp(0, seat.rootY, e) + Math.sin(e * Math.PI) * 0.35
      tuna.heading = this.sitFromHeading + angleDelta(this.sitFromHeading, seat.heading) * e
      tuna.sit = e
    } else {
      const from = new THREE.Vector3(seat.pos.x, seat.rootY, seat.pos.z)
      tuna.root.position.lerpVectors(from, seat.standAt, e)
      tuna.root.position.y = lerp(seat.rootY, 0, e) + Math.sin(e * Math.PI) * 0.3
      tuna.sit = 1 - e
    }
    tuna.update(dt, 0, this.reducedMotion)
    if (u >= 1) {
      if (this.activity === 'sitIn') this.activity = 'sitting'
      else {
        this.activity = 'free'
        tuna.sit = 0
        tuna.root.position.y = 0
        this.seat = undefined
        this.guitar.visible = false
        this.audio.setMusicDuck(1)
        this.resetDrink()
        tuna.body.rotation.z = 0
      }
    }
  }

  private updateSitting(dt: number, realDt: number, interact: boolean): void {
    const tuna = this.tuna
    this.zoneSession += realDt
    this.events.addZone(realDt)
    this.sitT += dt
    tuna.update(dt, 0, this.reducedMotion)
    tuna.pitch = -0.08 + Math.sin(this.sitT * 0.4) * 0.03
    this.input.takeLook()
    this.input.takeZoom()
    if (this.seat?.id === 'campfire') this.playGuitar(dt)
    if (this.seat?.id === 'bar') this.drinkWhisky(dt)
    // Smoke rhythm: inhale (ember brightens), hold, exhale a puff.
    this.puffT -= this.seat?.id === 'campfire' || this.seat?.id === 'bar' ? dt * 0.5 : dt
    if (this.puffPhase === 'idle' && this.puffT <= 0) {
      this.puffPhase = 'inhale'
      this.puffT = 1.5
      this.audio.play('puff', { volume: 0.6 })
    } else if (this.puffPhase === 'inhale') {
      tuna.emberGlow = lerp(tuna.emberGlow, 1.8, dt * 2.2)
      if (this.puffT <= 0) {
        this.puffPhase = 'hold'
        this.puffT = 0.5
      }
    } else if (this.puffPhase === 'hold' && this.puffT <= 0) {
      this.puffPhase = 'idle'
      this.puffT = 5.5 + Math.random() * 3
      const dir = tuna.forward(new THREE.Vector3()).multiplyScalar(0.35).add(new THREE.Vector3(0, 0.25, 0))
      this.fx.puff(tuna.tipWorld(new THREE.Vector3()), dir)
    }
    if (this.puffPhase !== 'inhale') tuna.emberGlow = lerp(tuna.emberGlow, 0.35, dt * 0.8)
    this.zoneLineT -= realDt
    if (this.zoneLineT <= 0) {
      this.zoneLineT = 9 + Math.random() * 5
      const night = this.night > 0.6
      const pool = night ? [0, 1, 3, 5, 6, 7] : [0, 1, 2, 3, 4, 5, 6]
      this.events.zoneLine(`zone.line.${pool[Math.floor(Math.random() * pool.length)]}`)
    }
    const moving = Math.hypot(this.input.move.x, this.input.move.y) > 0.5
    if ((interact || moving) && this.sitT > 1.2) {
      this.activity = 'sitOut'
      this.sitT = 0
      this.resetDrink()
      this.puffPhase = 'idle'
      this.events.cinematic(false)
      this.audio.play('sit', { volume: 0.5, rate: 1.1 })
      this.camYaw = 0.2
    }
  }

  /**
   * On the rocks, slowly: lift the glass to the mouth, tip it back, set it down with an ice
   * clink, then rest a while. Four sips empty it; the tuna pours himself another.
   */
  private drinkWhisky(dt: number): void {
    const CYCLE = 9
    const prev = this.sipT
    this.sipT += dt
    if (this.sipT >= CYCLE) this.sipT -= CYCLE
    const t = Math.max(0, this.sipT)
    const g = this.bar.drink
    const tuna = this.tuna
    const fwd = tuna.forward(new THREE.Vector3())
    const mouth = tuna.glassAtMouthWorld(new THREE.Vector3())
    let lift = 0, tilt = 0
    if (t < 1.1) lift = smooth(t / 1.1)
    else if (t < 2.6) { lift = 1; tilt = Math.sin(((t - 1.1) / 1.5) * Math.PI) }
    else if (t < 3.6) lift = 1 - smooth((t - 2.6) / 1.0)
    g.position.lerpVectors(this.bar.drinkRest, mouth, lift)
    g.position.y += Math.sin(lift * Math.PI) * 0.06
    const axis = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize()
    g.quaternion.setFromAxisAngle(axis, 0.25 * lift + 0.85 * tilt)
    tuna.pitch = -0.08 - tilt * 0.12
    // Liquid drains during the tip; set-down clinks the ice.
    if (tilt > 0) this.bar.liquid.scale.y = Math.max(0.05, this.bar.liquid.scale.y - dt * 0.17)
    if (prev < 3.6 && this.sipT >= 3.6) {
      this.audio.clink(0.2)
      this.sips++
      if (this.sips >= 4) {
        this.sips = 0
        window.setTimeout(() => {
          if (this.seat?.id !== 'bar') return
          this.audio.pour(0.26)
          this.bar.liquid.scale.y = 1
          this.events.toast('toast.whisky.again')
        }, 1400)
      }
    }
    if (prev < 1.6 && this.sipT >= 1.6) this.audio.play('puff', { volume: 0.25, rate: 0.7 })
  }

  private resetDrink(): void {
    this.bar.drink.position.copy(this.bar.drinkRest)
    this.bar.drink.quaternion.identity()
  }

  /** Western strum: G G C C G G D D Em Em C D, pattern D . D U . U D U at 84 bpm. */
  private playGuitar(dt: number): void {
    this.audio.setMusicDuck(0.3)
    const beat = 60 / 84
    const prev = this.strumT
    this.strumT += dt
    const PATTERN: Array<[number, boolean]> = [[0, true], [1, true], [1.5, false], [2.5, false], [3, true], [3.5, false]]
    const PROG = ['G', 'G', 'C', 'C', 'G', 'G', 'D', 'D', 'Em', 'Em', 'C', 'D']
    const CHORDS: Record<string, number[]> = {
      G: [98.0, 123.47, 146.83, 196.0, 246.94, 392.0],
      C: [130.81, 164.81, 196.0, 261.63, 329.63],
      D: [146.83, 220.0, 293.66, 369.99],
      Em: [82.41, 123.47, 164.81, 196.0, 246.94, 329.63],
    }
    if (this.strumT >= 0) {
      const barLen = 4 * beat
      for (const [b, down] of PATTERN) {
        const at = b * beat
        const bar = Math.floor(this.strumT / barLen)
        const tIn = this.strumT - bar * barLen
        const pIn = prev - bar * barLen
        if (pIn < at && tIn >= at) {
          const chord = PROG[bar % PROG.length]
          this.audio.strum(CHORDS[chord], down, down ? 0.42 : 0.3)
          this.strumKick = down ? 1 : -0.7
        }
      }
    }
    this.strumKick *= Math.exp(-dt * 9)
    const g = this.guitar
    g.rotation.z = GUITAR_REST.rz + this.strumKick * 0.06
    g.position.y = GUITAR_REST.y - Math.abs(this.strumKick) * 0.008
    // Sway with the beat.
    this.tuna.body.rotation.z = Math.sin(this.strumT * Math.PI / beat / 2) * 0.05
  }

  private updateSmoke(dt: number): void {
    const tuna = this.tuna
    this.wispT -= dt
    if (this.wispT <= 0) {
      this.wispT = 0.14
      this.fx.wisp(tuna.tipWorld(tmpV))
    }
    // While roaming, an occasional casual puff.
    if (this.activity === 'free' && this.mode === 'playing') {
      this.walkPuffT -= dt
      if (this.walkPuffT < 1.2) tuna.emberGlow = lerp(tuna.emberGlow, 1.3, dt * 2)
      else tuna.emberGlow = lerp(tuna.emberGlow, 0.35, dt)
      if (this.walkPuffT <= 0) {
        this.walkPuffT = 12 + Math.random() * 8
        this.fx.puff(tuna.tipWorld(new THREE.Vector3()), tuna.forward(new THREE.Vector3()).multiplyScalar(0.2).add(new THREE.Vector3(0, 0.2, 0)))
      }
    }
    const lt = new THREE.Vector3(LAYOUT.lantern.x, 0.53, LAYOUT.lantern.z)
    this.fx.ambient(lt, this.world.lanternLevel > 0, new THREE.Vector3(0, 0, -2))
  }

  // ---------------------------------------------------------------- camera
  private updateCamera(realDt: number, dt: number): void {
    const cam = this.camera
    const tunaPos = this.tuna.root.position
    let pos: THREE.Vector3
    let look: THREE.Vector3
    let fov = CONFIG.camera.fov
    let rate = CONFIG.camera.follow
    if (this.mode === 'title') {
      const a = Math.sin(this.elapsed * 0.05) * 0.5 + 0.35
      pos = new THREE.Vector3(Math.sin(a) * 8.5, 1.9, -1 + Math.cos(a) * 8.5)
      look = new THREE.Vector3(0, 1.3, -3)
      fov = 46
      rate = 1.5
    } else if (this.activity === 'chop') {
      const ct = this.ct
      const close = smooth((ct - 0.5) / 0.4) * (1 - smooth((ct - 1.9) / 0.6))
      const base = new THREE.Vector3(LAYOUT.stump.x, 0, LAYOUT.stump.z)
      const wide = new THREE.Vector3(base.x + 2.6, 1.7, base.z + 3.2)
      const tight = new THREE.Vector3(base.x + 1.75, 1.05, base.z + 1.2)
      pos = wide.lerp(tight, close)
      look = new THREE.Vector3(base.x - 0.05, 0.82, base.z + 0.45)
      fov = lerp(44, 34, close)
      rate = 4
    } else if (this.seat && (this.activity === 'sitting' || this.activity === 'sitIn')) {
      const s = this.seat
      const t = this.activity === 'sitting' ? this.sitT : 0
      const pull = smooth(t / 8)
      const orb = 0.42 + Math.sin(this.elapsed * 0.045) * 0.22
      const d = lerp(2.4, 7.8, pull)
      const sy = s.rootY
      if (s.id === 'campfire') {
        // Front three-quarter view across the fire so the guitar on his chest is visible.
        const a = 0.62 + Math.sin(this.elapsed * 0.05) * 0.15
        const dc = lerp(2.0, 3.4, pull)
        pos = new THREE.Vector3(s.pos.x + Math.sin(a) * dc, sy + lerp(0.55, 1.0, pull), s.pos.z - Math.cos(a) * dc)
        look = new THREE.Vector3(s.pos.x, sy + lerp(0.4, 0.55, pull), s.pos.z - 0.3)
      } else {
        pos = new THREE.Vector3(s.pos.x + Math.sin(orb) * d, sy + lerp(0.75, 1.35, pull), s.pos.z + Math.cos(orb) * d)
        look = new THREE.Vector3(s.pos.x - Math.sin(orb) * 2.5, sy + lerp(0.7, 2.2, pull), s.pos.z - 7)
      }
      fov = lerp(44, 40, pull)
      rate = this.activity === 'sitIn' ? 2.5 : 1.2
    } else {
      const d = this.camDist * (CONFIG.camera.distance / 6.2)
      const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch)
      const target = tunaPos.clone().add(new THREE.Vector3(0, 0.75, 0))
      pos = target.clone().add(new THREE.Vector3(Math.sin(this.camYaw) * d * cp, d * sp + (CONFIG.camera.height - 2.4) * 0.5, Math.cos(this.camYaw) * d * cp))
      pos.y = Math.max(0.5, pos.y)
      look = target.add(new THREE.Vector3(-Math.sin(this.camYaw) * 1.2, 0.35, -Math.cos(this.camYaw) * 1.2))
    }
    const k = 1 - Math.exp(-rate * realDt)
    this.camPos.lerp(pos, k)
    this.camLook.lerp(look, k)
    cam.position.copy(this.camPos)
    if (this.shake > 0.001) {
      cam.position.add(new THREE.Vector3((Math.random() - 0.5) * 0.05, (Math.random() - 0.5) * 0.05, 0).multiplyScalar(this.shake))
      this.shake *= Math.exp(-dt * 10)
    }
    cam.lookAt(this.camLook)
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov += (fov - cam.fov) * k
      cam.updateProjectionMatrix()
    }
  }
}

let rings: THREE.Texture | undefined
function ringTexture(): THREE.Texture {
  if (rings) return rings
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')!
  g.fillStyle = '#dcb98a'
  g.fillRect(0, 0, 256, 256)
  for (let r = 6; r < 128; r += 5 + Math.random() * 6) {
    g.strokeStyle = `rgba(${150 + Math.random() * 30},${100 + Math.random() * 20},${60},${0.35 + Math.random() * 0.3})`
    g.lineWidth = 1 + Math.random() * 1.5
    g.beginPath()
    g.ellipse(128 + Math.random() * 2, 128 + Math.random() * 2, r, r * (0.96 + Math.random() * 0.06), 0, 0, Math.PI * 2)
    g.stroke()
  }
  g.strokeStyle = 'rgba(90,60,30,0.5)'
  g.lineWidth = 2
  g.beginPath()
  g.moveTo(128, 128)
  g.lineTo(220, 60)
  g.stroke()
  rings = new THREE.CanvasTexture(c)
  rings.colorSpace = THREE.SRGBColorSpace
  return rings
}

/** Held in front of the chest: neck across to the side and slightly up, soundboard facing forward. */
const GUITAR_REST = { x: -0.08, y: -0.15, z: 0.36, rx: 0, ry: -Math.PI / 2, rz: -0.3 }

/**
 * Guitar held against the tuna's flank (the side facing the camera when seated): neck along
 * +Z (forward, angled up past the head), soundboard facing outward (+X).
 */
function makeGuitar(gltf: { scene: THREE.Object3D }): THREE.Group {
  const src = gltf.scene.clone()
  src.updateMatrixWorld(true)
  const size = new THREE.Box3().setFromObject(src).getSize(new THREE.Vector3())
  const dims = [size.x, size.y, size.z]
  const order = [0, 1, 2].sort((i, j) => dims[j] - dims[i])
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]
  const long = axes[order[0]], thin = axes[order[2]]
  const up = new THREE.Vector3().crossVectors(long, thin)
  // Rows map source axes to target: thin → X, up → Y, long → Z.
  const m = new THREE.Matrix4().set(thin.x, thin.y, thin.z, 0, up.x, up.y, up.z, 0, long.x, long.y, long.z, 0, 0, 0, 0, 1)
  src.quaternion.setFromRotationMatrix(m)
  src.updateMatrixWorld(true)
  const wrap = new THREE.Group()
  wrap.add(src)
  wrap.updateMatrixWorld(true)
  const sz = new THREE.Box3().setFromObject(wrap).getSize(new THREE.Vector3())
  src.scale.multiplyScalar(0.7 / Math.max(sz.x, sz.y, sz.z))
  wrap.updateMatrixWorld(true)
  // Body (wide end) toward the tail: put the centre of mass behind the holder origin.
  const box = new THREE.Box3().setFromObject(wrap)
  const c = box.getCenter(new THREE.Vector3())
  src.position.sub(c)
  wrap.updateMatrixWorld(true)
  let front = 0, back = 0
  const v = new THREE.Vector3()
  src.traverse(o => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.castShadow = true
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i += 4) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
      if (v.z > 0) front++
      else back++
    }
  })
  // Vertex density is higher on the neck (frets, tuners) for this model; checked visually: neck forward (+Z).
  if (front < back) wrap.rotation.y = Math.PI
  const holder = new THREE.Group()
  holder.add(wrap)
  holder.position.set(GUITAR_REST.x, GUITAR_REST.y, GUITAR_REST.z)
  holder.rotation.set(GUITAR_REST.rx, GUITAR_REST.ry, GUITAR_REST.rz, 'ZYX')
  return holder
}
