import type { Action, Input } from '../engine/input'

/**
 * On-screen touch controls: floating stick on the left, drag-to-look on the right,
 * E (interact) and trot buttons. Enabled on the first touch.
 */
export class TouchControls {
  private stickId: number | null = null
  private lookId: number | null = null
  private origin = { x: 0, y: 0 }
  private last = { x: 0, y: 0 }

  constructor(root: HTMLElement, private readonly input: Input, private readonly active: () => boolean) {
    const layer = root.querySelector<HTMLElement>('.touch')!
    const stick = layer.querySelector<HTMLElement>('.touch-stick')!
    const knob = stick.querySelector<HTMLElement>('i')!
    const radius = 56
    const enable = () => document.body.classList.add('has-touch')
    if (matchMedia('(pointer: coarse)').matches) enable()
    window.addEventListener('touchstart', enable, { once: true, passive: true })
    window.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') this.input.method = 'touch'
    }, { capture: true })
    const canvas = document.querySelector<HTMLCanvasElement>('#game')!
    canvas.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch' || !this.active()) return
      if (e.clientX < window.innerWidth * 0.45 && this.stickId === null) {
        this.stickId = e.pointerId
        this.origin = { x: e.clientX, y: e.clientY }
        stick.style.left = `${e.clientX}px`
        stick.style.top = `${e.clientY}px`
        stick.classList.add('is-active')
      } else if (this.lookId === null) {
        this.lookId = e.pointerId
        this.last = { x: e.clientX, y: e.clientY }
      }
    })
    window.addEventListener('pointermove', e => {
      if (e.pointerId === this.stickId) {
        let dx = e.clientX - this.origin.x
        let dy = e.clientY - this.origin.y
        const len = Math.hypot(dx, dy)
        if (len > radius) {
          dx = (dx / len) * radius
          dy = (dy / len) * radius
        }
        knob.style.transform = `translate(${dx}px, ${dy}px)`
        this.input.setTouchMove(dx / radius, -dy / radius)
      } else if (e.pointerId === this.lookId) {
        this.input.addTouchLook(e.clientX - this.last.x, e.clientY - this.last.y)
        this.last = { x: e.clientX, y: e.clientY }
      }
    })
    const end = (e: PointerEvent) => {
      if (e.pointerId === this.stickId) {
        this.stickId = null
        knob.style.transform = ''
        stick.classList.remove('is-active')
        this.input.setTouchMove(0, 0)
      }
      if (e.pointerId === this.lookId) this.lookId = null
    }
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    for (const btn of layer.querySelectorAll<HTMLElement>('[data-touch]')) {
      const action = btn.dataset.touch as Action
      btn.addEventListener('pointerdown', e => {
        e.preventDefault()
        btn.setPointerCapture(e.pointerId)
        btn.classList.add('is-down')
        this.input.setTouchButton(action, true)
      })
      const up = () => {
        btn.classList.remove('is-down')
        this.input.setTouchButton(action, false)
      }
      btn.addEventListener('pointerup', up)
      btn.addEventListener('pointercancel', up)
    }
  }
}
