import './styles/main.css'
import { Assets } from './engine/assets'
import { Audio } from './engine/audio'
import { I18n } from './engine/i18n'
import { Input } from './engine/input'
import { GameLoop } from './engine/loop'
import { SAVE_KEY, SaveStore, type SaveData } from './engine/save'
import { assetUrl, MODELS, SOUNDS, STREAMED_SOUNDS, type ModelName } from './game/assetTable'
import type { Game } from './game/game'
import type { Models } from './game/world'
import { TouchControls } from './ui/touch'
import { Ui } from './ui/ui'

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#game')!
  const firstRun = safeGet(SAVE_KEY) === null
  const save = new SaveStore()
  const i18n = new I18n()
  const input = new Input(canvas)
  const audio = new Audio()
  let game: Game | undefined
  let pendingWood = 0
  let pendingZone = 0

  const flushProgress = () => {
    if (pendingWood === 0 && pendingZone < 1) return
    save.update({ wood: save.data.wood + pendingWood, zoneSeconds: save.data.zoneSeconds + pendingZone })
    pendingWood = 0
    pendingZone = 0
  }
  window.setInterval(flushProgress, 5000)
  window.addEventListener('pagehide', flushProgress)

  const applySettings = (d: SaveData) => {
    input.sensitivity = d.sensitivity
    input.invertY = d.invertY
    audio.setVolumes(d.musicVolume, d.sfxVolume, d.muted)
    if (game) game.reducedMotion = d.reducedMotion
  }

  let sessionZone = 0
  const pause = () => {
    if (game?.mode !== 'playing') return
    game.pause()
    flushProgress()
    ui.setPauseStats(game.hud().wood, sessionZone)
    ui.show('pause')
  }
  const resume = () => {
    if (game?.mode !== 'paused') return
    game.resume()
    ui.show('hud')
    loop.resetAccumulator()
  }

  const ui = new Ui(i18n, save, audio, input, {
    play: () => {
      if (!game) return
      audio.unlock()
      audio.startMusic()
      if (game.mode === 'title') game.start()
      ui.show('hud')
      loop.resetAccumulator()
    },
    resume,
    quit: () => {
      flushProgress()
      game?.toTitle()
      ui.show('title')
    },
    settings: patch => {
      const qualityChanged = patch.quality !== undefined && patch.quality !== save.data.quality
      save.update(patch)
      applySettings(save.data)
      if (qualityChanged) game?.setQuality(save.data.quality)
    },
  })
  ui.show('boot')
  applySettings(save.data)

  // Boot: code chunks, fonts, all models (the playable scene) and short SFX behind real progress.
  const assets = new Assets()
  const names = Object.keys(MODELS) as ModelName[]
  let done = 0
  const total = names.length + Object.keys(SOUNDS).length + 3
  const tick = () => ui.setBootProgress(0.05 + (++done / total) * 0.95)
  ui.setBootProgress(0.05)
  for (const [name, rel] of Object.entries(SOUNDS)) audio.register(name, assetUrl(rel)).then(tick, err => (console.warn(err), tick()))
  const [{ Game }, { Renderer, suggestQuality }, gltfs] = await Promise.all([
    import('./game/game').then(m => (tick(), m)),
    import('./engine/renderer').then(m => (tick(), m)),
    Promise.all(names.map(n => assets.gltf(assetUrl(MODELS[n])).then(g => (tick(), [n, g] as const)))),
    document.fonts.ready.then(tick),
  ])
  // Large streamed audio starts after the scene is ready; music begins when it arrives.
  for (const [name, rel] of Object.entries(STREAMED_SOUNDS)) audio.register(name, assetUrl(rel)).catch(err => console.warn(err))

  if (firstRun) {
    save.update({ quality: suggestQuality() })
    ui.refreshSettings()
  }
  const renderer = new Renderer(canvas, save.data.quality)
  const models = Object.fromEntries(gltfs) as Models
  game = new Game(renderer, input, audio, models, {
    toast: key => ui.toast(key),
    hint: key => ui.hint(key),
    zoneLine: key => ui.zoneLine(key),
    cinematic: on => ui.cinematic(on),
    addWood: n => (pendingWood += n),
    addZone: s => {
      pendingZone += s
      sessionZone += s
    },
  }, save.data.quality, k => i18n.t(k))
  game.reducedMotion = save.data.reducedMotion
  renderer.gl.compile(game.scene, game.camera)

  if (import.meta.env.DEV) {
    const [{ registerGameTuning }, { tuning }] = await Promise.all([
      import('../scripts/manus-tuning/adapter.js'), import('./game/tuning'),
    ])
    await registerGameTuning(tuning)
  }

  const g = game
  const loop = new GameLoop({
    beforeFrame: frameSeconds => input.update(frameSeconds),
    step: () => undefined,
    render: (_alpha, frameSeconds) => {
      if (input.consume('pause')) {
        if (g.mode === 'playing') pause()
        else if (g.mode === 'paused' && ui.screen === 'pause') resume()
      }
      g.frame(frameSeconds)
      if (g.mode === 'playing') ui.updateHud(g.hud())
      input.endFrame()
    },
  })
  loop.start()
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause()
  })
  window.addEventListener('game:pause', pause)
  new TouchControls(document.getElementById('ui')!, input, () => g.mode === 'playing')
  window.setTimeout(() => ui.show('title'), 300)
  // Debug/test hook (read-only use): smoke tests inspect state through it.
  ;(window as unknown as { __game: unknown }).__game = { game: g, ui, input, save, debug: () => g.debug() }
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

boot().catch(err => {
  console.error(err)
  const el = document.getElementById('ui')
  if (el) el.innerHTML = `<div class="fatal">시작하지 못했어요: ${String((err as Error)?.message ?? err).replace(/[<>&]/g, '')}</div>`
})
