import type { Audio } from '../engine/audio'
import type { I18n } from '../engine/i18n'
import type { Input } from '../engine/input'
import type { Quality, SaveData, SaveStore } from '../engine/save'
import type { HudState } from '../game/game'
import { formatDuration } from '../game/rules'

export type Screen = 'boot' | 'title' | 'hud' | 'pause' | 'settings'

export type UiActions = {
  play(): void
  resume(): void
  quit(): void
  settings(patch: Partial<SaveData>): void
}

const NIGHT_KEYS = ['hud.night.dusk', 'hud.night.twilight', 'hud.night.night', 'hud.night.deep']

/** DOM overlay. Screens are sibling sections toggled by `data-screen`; game state is read-only here. */
export class Ui {
  screen: Screen = 'boot'
  private readonly root: HTMLElement
  private settingsReturn: Screen = 'title'
  private toastTimer = 0
  private lineTimer = 0
  private lastPrompt = ''

  constructor(private readonly i18n: I18n, private readonly save: SaveStore, private readonly audio: Audio,
    private readonly input: Input, private readonly actions: UiActions) {
    this.root = document.getElementById('ui')!
    this.render()
    window.addEventListener('keydown', e => this.onKey(e))
  }

  private t(k: string, v?: Record<string, string | number>): string {
    return this.i18n.t(k, v)
  }

  private render(): void {
    const t = (k: string) => this.t(k)
    this.root.innerHTML = `
      <div class="grain"></div><div class="vignette"></div>
      <div class="letterbox top"></div><div class="letterbox bottom"></div>
      <section class="screen boot" data-screen="boot">
        <img class="boot-icon" src="./favicon.svg" alt="" />
        <h1 class="title">${t('game.title')}</h1>
        <div class="bar"><i></i></div>
        <p class="boot-note">${t('boot.loading')}</p>
      </section>
      <section class="screen title-screen" data-screen="title">
        <div class="title-card">
          <p class="kicker">Lo-Fi Western · Dusk Ranch</p>
          <h1 class="title">${t('game.title')}</h1>
          <p class="subtitle">${t('game.subtitle')}</p>
          <div class="menu">
            <button class="btn primary" data-act="play">${t('title.start')}</button>
            <button class="btn" data-act="settings">${t('title.settings')}</button>
          </div>
          <p class="blurb">${t('title.blurb')}</p>
          <p class="tally" data-tally></p>
        </div>
      </section>
      <section class="screen hud" data-screen="hud">
        <div class="hud-top">
          <div class="chip wood"><span class="ico log"></span><b data-wood>0</b><small>${t('hud.wood')}</small></div>
          <div class="chip sky"><span class="moon" data-moon></span><span data-night></span></div>
          <button class="chip menu-btn" data-act="pause" aria-label="menu">❚❚</button>
        </div>
        <div class="hint" data-hint></div>
        <div class="toast" data-toast></div>
        <div class="zone" data-zone><span data-zone-line></span></div>
        <div class="zone-timer" data-zone-timer></div>
        <div class="prompt" data-prompt><kbd>E</kbd><span data-prompt-text></span></div>
        <div class="controls" data-controls></div>
        <div class="touch">
          <div class="touch-stick"><i></i></div>
          <button class="touch-btn interact" data-touch="interact">${t('touch.interact')}</button>
          <button class="touch-btn trot" data-touch="sprint">${t('touch.trot')}</button>
        </div>
      </section>
      <section class="screen pause" data-screen="pause">
        <div class="panel">
          <h2>${t('pause.title')}</h2>
          <p class="stats" data-pause-stats></p>
          <div class="menu">
            <button class="btn primary" data-act="resume">${t('pause.resume')}</button>
            <button class="btn" data-act="settings">${t('pause.settings')}</button>
            <button class="btn" data-act="quit">${t('pause.title.screen')}</button>
          </div>
        </div>
      </section>
      <section class="screen settings" data-screen="settings">
        <div class="panel">
          <h2>${t('settings.title')}</h2>
          <label class="row"><span>${t('settings.music')}</span><input type="range" min="0" max="1" step="0.05" data-set="musicVolume" /></label>
          <label class="row"><span>${t('settings.sfx')}</span><input type="range" min="0" max="1" step="0.05" data-set="sfxVolume" /></label>
          <label class="row"><span>${t('settings.sensitivity')}</span><input type="range" min="0.2" max="3" step="0.1" data-set="sensitivity" /></label>
          <div class="row"><span>${t('settings.quality')}</span>
            <div class="seg" data-quality>
              ${(['low', 'medium', 'high'] as Quality[]).map(q => `<button class="btn small" data-q="${q}">${t(`settings.quality.${q}`)}</button>`).join('')}
            </div>
          </div>
          <label class="row check"><span>${t('settings.mute')}</span><input type="checkbox" data-set="muted" /></label>
          <label class="row check"><span>${t('settings.reducedMotion')}</span><input type="checkbox" data-set="reducedMotion" /></label>
          <div class="menu"><button class="btn primary" data-act="back">${t('settings.back')}</button></div>
        </div>
      </section>`

    this.root.addEventListener('click', e => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
      if (!el) return
      this.audio.unlock()
      const act = el.dataset.act
      if (act === 'play') this.actions.play()
      else if (act === 'resume') this.actions.resume()
      else if (act === 'quit') this.actions.quit()
      else if (act === 'pause') window.dispatchEvent(new Event('game:pause'))
      else if (act === 'settings') {
        this.settingsReturn = this.screen
        this.show('settings')
      } else if (act === 'back') this.show(this.settingsReturn)
    })
    for (const el of this.root.querySelectorAll<HTMLInputElement>('[data-set]')) {
      el.addEventListener('input', () => {
        const key = el.dataset.set as keyof SaveData
        const value = el.type === 'checkbox' ? el.checked : Number(el.value)
        this.actions.settings({ [key]: value } as Partial<SaveData>)
      })
    }
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-q]')) {
      el.addEventListener('click', () => {
        this.actions.settings({ quality: el.dataset.q as Quality })
        this.refreshSettings()
      })
    }
    this.refreshSettings()
  }

  refreshSettings(): void {
    const d = this.save.data
    for (const el of this.root.querySelectorAll<HTMLInputElement>('[data-set]')) {
      const v = d[el.dataset.set as keyof SaveData]
      if (el.type === 'checkbox') el.checked = Boolean(v)
      else el.value = String(v)
    }
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-q]')) el.classList.toggle('on', el.dataset.q === d.quality)
  }

  show(screen: Screen): void {
    this.screen = screen
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-screen]')) el.classList.toggle('on', el.dataset.screen === screen)
    document.body.dataset.screen = screen
    if (screen === 'title') {
      const d = this.save.data
      this.q('[data-tally]').textContent = d.wood > 0 || d.zoneSeconds > 0 ? this.t('title.tally', { wood: d.wood, zone: formatDuration(d.zoneSeconds) }) : ''
      window.setTimeout(() => this.q<HTMLButtonElement>('[data-act="play"]').focus(), 50)
    }
    if (screen === 'pause') window.setTimeout(() => this.q<HTMLButtonElement>('.pause [data-act="resume"]').focus(), 50)
    if (screen === 'settings') this.refreshSettings()
  }

  private q<T extends HTMLElement = HTMLElement>(sel: string): T {
    return this.root.querySelector<T>(sel)!
  }

  setBootProgress(p: number): void {
    this.q('.boot .bar i').style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`
  }

  setPauseStats(wood: number, zone: number): void {
    this.q('[data-pause-stats]').textContent = this.t('pause.stats', { wood, zone: formatDuration(zone) })
  }

  toast(key: string): void {
    const el = this.q('[data-toast]')
    el.textContent = this.t(key)
    el.classList.remove('on')
    void el.offsetWidth
    el.classList.add('on')
    window.clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => el.classList.remove('on'), 2600)
  }

  hint(key: string | null): void {
    const el = this.q('[data-hint]')
    if (key) el.textContent = this.t(key)
    el.classList.toggle('on', !!key)
  }

  zoneLine(key: string): void {
    const el = this.q('[data-zone-line]')
    el.textContent = this.t(key)
    const wrap = this.q('[data-zone]')
    wrap.classList.remove('on')
    void wrap.offsetWidth
    wrap.classList.add('on')
    window.clearTimeout(this.lineTimer)
    this.lineTimer = window.setTimeout(() => wrap.classList.remove('on'), 5200)
  }

  cinematic(on: boolean): void {
    document.body.classList.toggle('cinematic', on)
    if (!on) this.q('[data-zone]').classList.remove('on')
  }

  updateHud(h: HudState): void {
    this.q('[data-wood]').textContent = String(h.wood)
    const idx = h.night < 0.25 ? 0 : h.night < 0.5 ? 1 : h.night < 0.8 ? 2 : 3
    this.q('[data-night]').textContent = this.t(NIGHT_KEYS[idx])
    this.q('[data-moon]').style.setProperty('--n', String(h.night))
    const prompt = this.q('[data-prompt]')
    const text = h.prompt ?? ''
    if (text !== this.lastPrompt) {
      this.lastPrompt = text
      this.q('[data-prompt-text]').textContent = text
      prompt.classList.toggle('on', !!text)
    }
    const timer = this.q('[data-zone-timer]')
    timer.textContent = h.sitting ? this.t('zone.timer', { time: formatDuration(h.zoneSeconds) }) : ''
    this.q('[data-controls]').textContent = this.input.method === 'touch' ? this.t('hud.controls.touch') : this.t('hud.controls')
  }

  private onKey(e: KeyboardEvent): void {
    if (this.screen === 'settings' && (e.code === 'Escape' || e.code === 'Backspace')) {
      e.preventDefault()
      this.show(this.settingsReturn)
    } else if (this.screen === 'title' && (e.code === 'Enter' || e.code === 'Space') && document.activeElement === document.body) {
      this.actions.play()
    }
  }
}
