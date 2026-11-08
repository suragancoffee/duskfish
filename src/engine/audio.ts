/**
 * Web Audio mixer: music bus (acoustic guitar loop), ambience bus (crickets, follows the SFX
 * slider and swells with night) and one-shot SFX buffers. The context is created on the first
 * user gesture (`unlock`) to satisfy browser autoplay rules; loads before that are decoded lazily.
 */
export type SoundName = 'chop' | 'step' | 'puff' | 'lantern' | 'stack' | 'sit'

export class Audio {
  private ctx?: AudioContext
  private master?: GainNode
  private musicBus?: GainNode
  private sfxBus?: GainNode
  private ambBus?: GainNode
  private raw = new Map<string, Promise<ArrayBuffer>>()
  private buffers = new Map<string, AudioBuffer>()
  private urls = new Map<string, string>()
  private musicSource?: AudioBufferSourceNode
  private ambSource?: AudioBufferSourceNode
  private wantMusic = false
  private volumes = { music: 0.7, sfx: 0.85, muted: false }
  private ambLevel = 0.6
  private duck = 1
  private plucks = new Map<number, AudioBuffer>()
  private fireGain?: GainNode
  private noise?: AudioBuffer

  /** Register a sound and start fetching its bytes immediately. */
  register(name: string, url: string): Promise<void> {
    this.urls.set(name, url)
    const p = fetch(url).then(r => {
      if (!r.ok) throw new Error(`Audio ${name}: HTTP ${r.status}`)
      return r.arrayBuffer()
    })
    this.raw.set(name, p)
    return p.then(() => (this.ctx ? this.decode(name) : undefined))
  }

  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      this.ctx = new Ctor()
      this.master = this.ctx.createGain()
      this.master.connect(this.ctx.destination)
      this.musicBus = this.ctx.createGain()
      this.sfxBus = this.ctx.createGain()
      this.ambBus = this.ctx.createGain()
      this.musicBus.connect(this.master)
      this.sfxBus.connect(this.master)
      this.ambBus.connect(this.master)
      this.applyVolumes()
      for (const name of this.raw.keys()) void this.decode(name)
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  private async decode(name: string): Promise<void> {
    if (!this.ctx || this.buffers.has(name)) return
    try {
      const bytes = await this.raw.get(name)
      if (!bytes || this.buffers.has(name)) return
      const buffer = await this.ctx.decodeAudioData(bytes.slice(0))
      this.buffers.set(name, buffer)
      if (name === 'bgm' && this.wantMusic) this.startMusic()
      if (name === 'amb') this.startAmbience()
    } catch (err) {
      console.warn('audio decode failed', name, err)
    }
  }

  setVolumes(music: number, sfx: number, muted: boolean): void {
    this.volumes = { music, sfx, muted }
    this.applyVolumes()
  }

  private applyVolumes(): void {
    if (!this.ctx || !this.master || !this.musicBus || !this.sfxBus || !this.ambBus) return
    const t = this.ctx.currentTime
    this.master.gain.setTargetAtTime(this.volumes.muted ? 0 : 1, t, 0.05)
    this.musicBus.gain.setTargetAtTime(this.volumes.music * 0.55 * this.duck, t, 0.4)
    this.sfxBus.gain.setTargetAtTime(this.volumes.sfx, t, 0.05)
    this.ambBus.gain.setTargetAtTime(this.volumes.sfx * this.ambLevel * 0.5, t, 0.6)
  }

  /** 0..1 — crickets get louder as night deepens. */
  setAmbience(level: number): void {
    const next = Math.max(0, Math.min(1, level))
    if (Math.abs(next - this.ambLevel) < 0.01) return
    this.ambLevel = next
    this.applyVolumes()
  }

  /** Lower the background guitar while the tuna plays its own (1 = normal). */
  setMusicDuck(level: number): void {
    if (Math.abs(level - this.duck) < 0.01) return
    this.duck = level
    this.applyVolumes()
  }

  /** Karplus–Strong plucked string, cached per frequency. */
  private pluckBuffer(freq: number): AudioBuffer | undefined {
    if (!this.ctx) return undefined
    const key = Math.round(freq * 10)
    const hit = this.plucks.get(key)
    if (hit) return hit
    const sr = this.ctx.sampleRate
    const len = Math.floor(sr * 2.6)
    const buf = this.ctx.createBuffer(1, len, sr)
    const out = buf.getChannelData(0)
    const n = Math.max(2, Math.round(sr / freq))
    const ring = new Float32Array(n)
    // Soft pick: low-passed noise burst.
    let prev = 0
    for (let i = 0; i < ring.length; i++) {
      const w = Math.random() * 2 - 1
      prev = prev * 0.45 + w * 0.55
      ring[i] = prev
    }
    const decay = 0.9965 - Math.max(0, (freq - 200) / 4000)
    let idx = 0
    for (let i = 0; i < len; i++) {
      const a = ring[idx]
      const b = ring[(idx + 1) % n]
      ring[idx] = (a + b) * 0.5 * decay
      out[i] = a
      idx = (idx + 1) % n
    }
    // Body resonance: gentle fade-in avoids clicks.
    for (let i = 0; i < 64; i++) out[i] *= i / 64
    this.plucks.set(key, buf)
    return buf
  }

  /** Strum a chord (string frequencies low→high). Down strokes go low→high, up strokes reverse. */
  strum(freqs: number[], down: boolean, gain = 0.5): void {
    if (!this.ctx || !this.sfxBus) return
    const order = down ? freqs : [...freqs].reverse().slice(0, 4)
    const t0 = this.ctx.currentTime + 0.005
    order.forEach((f, i) => {
      const buf = this.pluckBuffer(f)
      if (!buf) return
      const src = this.ctx!.createBufferSource()
      src.buffer = buf
      const g = this.ctx!.createGain()
      g.gain.value = gain * (down ? 1 : 0.6) * (0.85 + Math.random() * 0.3)
      const tone = this.ctx!.createBiquadFilter()
      tone.type = 'lowpass'
      tone.frequency.value = down ? 3200 : 4200
      src.connect(tone).connect(g).connect(this.sfxBus!)
      src.start(t0 + i * (down ? 0.014 : 0.01))
    })
  }

  /** Ice against glass: a few bright, quickly decaying partials. */
  clink(gain = 0.25): void {
    if (!this.ctx || !this.sfxBus) return
    const t0 = this.ctx.currentTime + 0.005
    for (const [f, d] of [[2900, 0.25], [4100, 0.18], [5300, 0.12]] as const) {
      for (let k = 0; k < 2; k++) {
        const o = this.ctx.createOscillator()
        o.frequency.value = f * (0.97 + Math.random() * 0.06)
        const g = this.ctx.createGain()
        const t = t0 + k * (0.07 + Math.random() * 0.05)
        g.gain.setValueAtTime(0, t)
        g.gain.linearRampToValueAtTime(gain * (k ? 0.5 : 1) / 3, t + 0.003)
        g.gain.exponentialRampToValueAtTime(0.0001, t + d)
        o.connect(g).connect(this.sfxBus)
        o.start(t)
        o.stop(t + d + 0.05)
      }
    }
  }

  /** Whisky pour: band-passed noise glugs. */
  pour(gain = 0.3): void {
    if (!this.ctx || !this.sfxBus) return
    const len = Math.floor(this.ctx.sampleRate * 1.1)
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < len; i++) {
      const t = i / this.ctx.sampleRate
      const glug = 0.55 + 0.45 * Math.sin(t * Math.PI * 2 * 7.5)
      d[i] = (Math.random() * 2 - 1) * glug * Math.min(1, t * 12) * Math.min(1, (1.1 - t) * 6)
    }
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    const bp = this.ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 900
    bp.Q.value = 1.4
    const g = this.ctx.createGain()
    g.gain.value = gain
    src.connect(bp).connect(g).connect(this.sfxBus)
    src.start()
  }

  /** Two-note friendly whistle for the shrimp's hello. */
  chirp(gain = 0.18): void {
    if (!this.ctx || !this.sfxBus) return
    const t0 = this.ctx.currentTime + 0.01
    ;[[880, 1320, 0], [1100, 1650, 0.16]].forEach(([a, b, dt]) => {
      const o = this.ctx!.createOscillator()
      o.type = 'triangle'
      const t = t0 + dt
      o.frequency.setValueAtTime(a, t)
      o.frequency.exponentialRampToValueAtTime(b, t + 0.12)
      const g = this.ctx!.createGain()
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(gain, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
      o.connect(g).connect(this.sfxBus!)
      o.start(t)
      o.stop(t + 0.2)
    })
  }

  /** Campfire crackle: random filtered noise pops; call each frame with a 0..1 level. */
  fire(level: number, dt: number): void {
    if (!this.ctx || !this.sfxBus) return
    if (!this.noise) {
      const len = Math.floor(this.ctx.sampleRate * 0.05)
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
      const d = this.noise.getChannelData(0)
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.12))
      this.fireGain = this.ctx.createGain()
      this.fireGain.connect(this.sfxBus)
    }
    this.fireGain!.gain.setTargetAtTime(level * 0.7, this.ctx.currentTime, 0.3)
    if (level < 0.02 || Math.random() > dt * 9) return
    const src = this.ctx.createBufferSource()
    src.buffer = this.noise
    src.playbackRate.value = 0.5 + Math.random() * 1.6
    const bp = this.ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 900 + Math.random() * 3500
    bp.Q.value = 1.2
    const g = this.ctx.createGain()
    g.gain.value = 0.25 + Math.random() * 0.6
    src.connect(bp).connect(g).connect(this.fireGain!)
    src.start()
  }

  startMusic(): void {
    this.wantMusic = true
    this.startAmbience()
    if (!this.ctx || !this.musicBus || this.musicSource) return
    const buffer = this.buffers.get('bgm')
    if (!buffer) return
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.loop = true
    const fade = this.ctx.createGain()
    fade.gain.setValueAtTime(0, this.ctx.currentTime)
    fade.gain.linearRampToValueAtTime(1, this.ctx.currentTime + 3)
    src.connect(fade).connect(this.musicBus)
    src.start()
    this.musicSource = src
  }

  private startAmbience(): void {
    if (!this.ctx || !this.ambBus || this.ambSource) return
    const buffer = this.buffers.get('amb')
    if (!buffer) return
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.loop = true
    src.connect(this.ambBus)
    src.start()
    this.ambSource = src
  }

  /** One-shot SFX. `rate` < 1 slows/deepens (used during slow motion). */
  play(name: SoundName, opts: { volume?: number; rate?: number; jitter?: number } = {}): void {
    if (!this.ctx || !this.sfxBus) return
    const buffer = this.buffers.get(name)
    if (!buffer) return
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    const jitter = opts.jitter ?? 0.06
    src.playbackRate.value = (opts.rate ?? 1) * (1 + (Math.random() * 2 - 1) * jitter)
    const gain = this.ctx.createGain()
    gain.gain.value = opts.volume ?? 1
    src.connect(gain).connect(this.sfxBus)
    src.start()
  }

  get ready(): boolean {
    return !!this.ctx
  }
}
