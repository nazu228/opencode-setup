import { Plugin } from "@opencode/plugin/tui"
import { appendFileSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

type OptimizedBuffer = {
  width: number
  height: number
  buffers: { char: Uint32Array; fg: Uint16Array; bg: Uint16Array }
  getRealCharBytes(addLineBreaks?: boolean): Uint8Array | string
}

type RGB = [number, number, number]

type Frame = {
  char: Uint32Array
  fg: Uint8Array
  bg: Uint8Array
}

type Settings = {
  playing: boolean
  panel: number
  icons: number
}

const FRAME_FILE = "./frames.bin"
const FRAME_W = 480
const FRAME_H = 270
const SPACE = 0x20
const BRAILLE_BASE = 0x2800
const DOT_BITS = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80]
const FPS = 25
const BRIGHTNESS = 1.15
const DETAIL_RANGE = 4
const SIDEBAR_WIDTH = 42
const SIDEBAR_GLASS = 0.4
const DIALOG_GLASS = 0.4

const bright = (value: number) => Math.min(255, Math.round(value * BRIGHTNESS))
const luma = (color: RGB) => color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722

const STATE = Symbol.for("mitsuha.wallpaper.state")
const DEBUG = "C:\\Users\\admin\\AppData\\Local\\Temp\\opencode\\mitsuha-v2.log"

const debug = (line: string) => {
  if (!process.env.MITSUHA_DEBUG) return
  try {
    appendFileSync(DEBUG, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

function readFrames() {
  const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL(FRAME_FILE, import.meta.url))))
  if (String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) !== "MTSH") throw new Error("bad frames file")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint16(6, true)
  const width = view.getUint16(8, true)
  const height = view.getUint16(10, true)
  const size = width * height * 4
  if (width !== FRAME_W || height !== FRAME_H || bytes.length < 12 + count * size) throw new Error("bad frames file")
  const pixels: Uint8Array[] = []
  for (let i = 0; i < count; i++) pixels.push(bytes.subarray(12 + i * size, 12 + (i + 1) * size))
  debug(`frames=${count} ${width}x${height}`)
  return pixels
}

function key(bg: Uint16Array, o: number) {
  return ((bg[o]! & 255) << 16) | ((bg[o + 1]! & 255) << 8) | (bg[o + 2]! & 255)
}

function rgb(key: number): RGB {
  return [(key >> 16) & 255, (key >> 8) & 255, key & 255]
}

function neutral(k: number, light: boolean) {
  const [r, g, b] = rgb(k)
  const luma = r * 0.2126 + g * 0.7152 + b * 0.0722
  return (light ? luma > 170 : luma < 82) && Math.max(r, g, b) - Math.min(r, g, b) < 28
}

const wide = (cp: number) =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe10 && cp <= 0xfe6f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f000 && cp <= 0x1faff) ||
  cp === 0x09

const icon = (cp: number) =>
  cp === 0x00d7 ||
  (cp >= 0x2190 && cp <= 0x21ff) ||
  (cp >= 0x2300 && cp <= 0x23ff) ||
  (cp >= 0x25a0 && cp <= 0x25ff) ||
  (cp >= 0x2600 && cp <= 0x27bf) ||
  (cp >= 0x2b00 && cp <= 0x2bff) ||
  (cp >= 0xe000 && cp <= 0xf8ff) ||
  (cp >= 0xf0000 && cp <= 0xffffd)

function buildLayer(pixels: Uint8Array, width: number, height: number): Frame {
  const char = new Uint32Array(width * height)
  const fg = new Uint8Array(width * height * 3)
  const bg = new Uint8Array(width * height * 3)
  const targetAspect = width / (height * 2)
  const sourceAspect = FRAME_W / FRAME_H
  let sx = 0
  let sy = 0
  let sw = FRAME_W
  let sh = FRAME_H
  if (sourceAspect > targetAspect) {
    sw = FRAME_H * targetAspect
    sx = (FRAME_W - sw) / 2
  } else {
    sh = FRAME_W / targetAspect
    sy = (FRAME_H - sh) / 2
  }

  const sample = (x0: number, y0: number, x1: number, y1: number): RGB => {
    const xa = Math.max(0, Math.floor(x0))
    const ya = Math.max(0, Math.floor(y0))
    const xb = Math.min(FRAME_W, Math.ceil(x1))
    const yb = Math.min(FRAME_H, Math.ceil(y1))
    let r = 0
    let g = 0
    let b = 0
    let n = 0
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        const p = (y * FRAME_W + x) * 4
        r += pixels[p]!
        g += pixels[p + 1]!
        b += pixels[p + 2]!
        n++
      }
    }
    if (!n) {
      const x = Math.min(FRAME_W - 1, Math.max(0, Math.round(x0)))
      const y = Math.min(FRAME_H - 1, Math.max(0, Math.round(y0)))
      const p = (y * FRAME_W + x) * 4
      return [bright(pixels[p]!), bright(pixels[p + 1]!), bright(pixels[p + 2]!)]
    }
    return [bright(r / n), bright(g / n), bright(b / n)]
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const cw = sw / width
      const ch = sh / height
      const dots: RGB[] = []
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 2; c++) {
          dots.push(sample(
            sx + (x + c / 2) * cw,
            sy + (y + r / 4) * ch,
            sx + (x + (c + 1) / 2) * cw,
            sy + (y + (r + 1) / 4) * ch,
          ))
        }
      }
      const ar = dots.reduce((sum, dot) => sum + dot[0], 0) / 8
      const ag = dots.reduce((sum, dot) => sum + dot[1], 0) / 8
      const ab = dots.reduce((sum, dot) => sum + dot[2], 0) / 8
      let maxRange = 0
      for (const dot of dots) {
        maxRange = Math.max(maxRange, Math.abs(dot[0] - ar), Math.abs(dot[1] - ag), Math.abs(dot[2] - ab))
      }
      const o = i * 3
      if (maxRange < DETAIL_RANGE) {
        char[i] = SPACE
        fg[o] = Math.round(ar)
        fg[o + 1] = Math.round(ag)
        fg[o + 2] = Math.round(ab)
        bg[o] = Math.round(ar)
        bg[o + 1] = Math.round(ag)
        bg[o + 2] = Math.round(ab)
        continue
      }
      const order = dots.map((_, index) => index).sort((a, b) => luma(dots[a]!) - luma(dots[b]!))
      let bestErr = Infinity
      let bestSplit = 1
      let bestFg: RGB = [0, 0, 0]
      let bestBg: RGB = [0, 0, 0]
      for (let split = 1; split < 8; split++) {
        const bgDots = order.slice(0, split)
        const fgDots = order.slice(split)
        const mean = (indices: number[]): RGB => [
          indices.reduce((sum, index) => sum + dots[index]![0], 0) / indices.length,
          indices.reduce((sum, index) => sum + dots[index]![1], 0) / indices.length,
          indices.reduce((sum, index) => sum + dots[index]![2], 0) / indices.length,
        ]
        const bgMean = mean(bgDots)
        const fgMean = mean(fgDots)
        let err = 0
        for (let d = 0; d < 8; d++) {
          const target = d < split ? bgMean : fgMean
          const dot = dots[order[d]!]!
          err += (dot[0] - target[0]) ** 2 + (dot[1] - target[1]) ** 2 + (dot[2] - target[2]) ** 2
        }
        if (err < bestErr) {
          bestErr = err
          bestSplit = split
          bestBg = bgMean
          bestFg = fgMean
        }
      }
      let mask = 0
      for (let d = 0; d < 8; d++) {
        if (d >= bestSplit) mask |= DOT_BITS[order[d]!]!
      }
      char[i] = BRAILLE_BASE | mask
      fg[o] = Math.round(bestFg[0])
      fg[o + 1] = Math.round(bestFg[1])
      fg[o + 2] = Math.round(bestFg[2])
      bg[o] = Math.round(bestBg[0])
      bg[o + 1] = Math.round(bestBg[1])
      bg[o + 2] = Math.round(bestBg[2])
    }
  }
  return { char, fg, bg }
}

function blend(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

export default Plugin.define({
  id: "mitsuha.wallpaper",
  async setup(context) {
    ;(globalThis as Record<symbol, { dispose: () => void } | undefined>)[STATE]?.dispose()
    const renderer = context.renderer as unknown as {
      postProcessFns?: unknown[]
      removePostProcessFn: (fn: unknown) => void
    }
    for (const fn of [...(renderer.postProcessFns ?? [])]) {
      if ((fn as { __mitsuha?: boolean } | undefined)?.__mitsuha) renderer.removePostProcessFn(fn)
    }
    const [settings, update] = context.storage.store<Settings>("mitsuha.wallpaper", {
      initial: { playing: true, panel: 0.6, icons: 0.65 },
    })
    const playing = () => settings.playing !== false
    const panelOpacity = () => Math.min(0.95, Math.max(0, settings.panel ?? 0.6))
    const iconOpacity = () => Math.min(1, Math.max(0, settings.icons ?? 0.65))
    const source = readFrames()
    let width = 0
    let height = 0
    let frames: Frame[] = []
    let current = 0
    let frameDirty = false
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let baseKey = -1
    let baseRGB: RGB = [10, 20, 36]
    let panelKeys = new Set<number>()
    let iconTokens = new Set<number>()
    let lastIconAt = 0
    let lastBaseAt = 0
    let failures = 0

    const interval = () => (playing() ? 1000 / FPS : 0)

    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      if (disposed) return
      const delay = interval()
      if (!delay) return
      if (frames.length === 1) return
      timer = setTimeout(() => {
        timer = undefined
        if (disposed || !playing()) return
        frameDirty = true
        context.renderer.requestRender()
        schedule()
      }, delay)
    }

    const rebuild = (w: number, h: number) => {
      width = w
      height = h
      frames = source.map((pixels) => buildLayer(pixels, w, h))
      baseKey = -1
      panelKeys = new Set()
      iconTokens = new Set()
      lastIconAt = 0
      debug(`layers ${w}x${h} frames=${frames.length}`)
    }

    const scanIcons = (buffer: OptimizedBuffer) => {
      try {
        const raw = buffer.getRealCharBytes(true)
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
        const lines = text.split("\n")
        const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
        const found = new Set<number>()
        const chars = buffer.buffers.char
        for (let y = 0; y < lines.length && y < buffer.height; y++) {
          let x = 0
          for (const part of segmenter.segment(lines[y] ?? "")) {
            const cp = part.segment.codePointAt(0) ?? 0
            const w = wide(cp) ? 2 : 1
            if (icon(cp) && x < buffer.width) found.add(chars[y * buffer.width + x]!)
            x += w
          }
        }
        iconTokens = found
        debug(`icons=${found.size}`)
      } catch (error) {
        debug(`icon scan failed ${String(error)}`)
      }
    }

    const render = (buffer: OptimizedBuffer) => {
      if (disposed || !playing()) return
      try {
        if (buffer.width !== width || buffer.height !== height) rebuild(buffer.width, buffer.height)
        if (width < 4 || height < 2 || !frames.length) return
        const { char, fg, bg } = buffer.buffers
        const cells = width * height
        const now = Date.now()
        const light = context.themeMode === "light"
        if (baseKey < 0 || now - lastBaseAt > 2000) {
          lastBaseAt = now
          const counts = new Map<number, number>()
          for (let i = 0; i < cells; i++) {
            const k = key(bg, i * 4)
            counts.set(k, (counts.get(k) ?? 0) + 1)
          }
          if (baseKey < 0 || (counts.get(baseKey) ?? 0) < cells * 0.03) {
            let best = -1
            let count = 0
            for (const [k, n] of counts) {
              if (n > count) {
                count = n
                best = k
              }
            }
            baseKey = best
            baseRGB = rgb(best)
            panelKeys = new Set()
            for (let i = 0; i < cells; i++) {
              const k = key(bg, i * 4)
              if (k !== baseKey && neutral(k, light)) panelKeys.add(k)
            }
            debug(`base=${baseKey.toString(16)} panels=${panelKeys.size} cells=${count}/${cells}`)
          }
        }
        if (iconTokens.size === 0 || now - lastIconAt > 5000) {
          lastIconAt = now
          scanIcons(buffer)
        }
        if (frameDirty) {
          current = (current + 1) % frames.length
          frameDirty = false
        }
        const layer = frames[current]!
        const cursor = context.renderer.getCursorState()
        const cx = cursor.visible ? cursor.x - 1 : -1
        const cy = cursor.visible ? cursor.y - 1 : -1
        const atCursor = (x: number, y: number) => cursor.visible && (x === cx || x === cx + 1) && (y === cy || y === cy + 1)
        const panel = panelOpacity()
        const dialogOpen = Boolean((globalThis as { __opencodeStatsDialogOpen?: boolean }).__opencodeStatsDialogOpen)
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            if (atCursor(x, y)) continue
            const i = y * width + x
            const o = i * 4
            const k = key(bg, o)
            const isBase = k === baseKey
            const isPanel = !isBase && (panelKeys.has(k) || neutral(k, light))
            if (!isBase && !isPanel) continue
            const p = i * 3
            const hasText = char[i] !== SPACE
            let near = hasText
            if (!near && x > 0 && char[i - 1] !== SPACE) near = true
            if (!near && x + 1 < width && char[i + 1] !== SPACE) near = true
            if (!near && y > 0 && char[i - width] !== SPACE) near = true
            if (!near && y + 1 < height && char[i + width] !== SPACE) near = true
            const shade = near ? 0.65 : 1
            let sr = layer.bg[p]! * shade
            let sg = layer.bg[p + 1]! * shade
            let sb = layer.bg[p + 2]! * shade
            if (isBase) {
              if (hasText) {
                const scrim = blend([sr, sg, sb], baseRGB, 0.52)
                bg[o] = Math.round(scrim[0])
                bg[o + 1] = Math.round(scrim[1])
                bg[o + 2] = Math.round(scrim[2])
                bg[o + 3] = 255
              } else {
                char[i] = layer.char[i]!
                const lf = p
                fg[o] = layer.fg[lf]!
                fg[o + 1] = layer.fg[lf + 1]!
                fg[o + 2] = layer.fg[lf + 2]!
                fg[o + 3] = 255
                bg[o] = Math.round(sr)
                bg[o + 1] = Math.round(sg)
                bg[o + 2] = Math.round(sb)
                bg[o + 3] = 255
              }
            } else {
              const pr = bg[o]! & 255
              const pg = bg[o + 1]! & 255
              const pb = bg[o + 2]! & 255
              const glassPanel = dialogOpen ? Math.min(panel, DIALOG_GLASS) : x >= width - SIDEBAR_WIDTH ? Math.min(panel, SIDEBAR_GLASS) : panel
              const glass = [pr * glassPanel + sr * (1 - glassPanel), pg * glassPanel + sg * (1 - glassPanel), pb * glassPanel + sb * (1 - glassPanel)]
              bg[o] = Math.round(glass[0]!)
              bg[o + 1] = Math.round(glass[1]!)
              bg[o + 2] = Math.round(glass[2]!)
              bg[o + 3] = 255
              if (!hasText) {
                char[i] = SPACE
                fg[o] = bg[o]!
                fg[o + 1] = bg[o + 1]!
                fg[o + 2] = bg[o + 2]!
                fg[o + 3] = 255
              }
            }
          }
        }
        if (iconOpacity() < 0.999 && iconTokens.size) {
          const mix = iconOpacity()
          for (let i = 0; i < cells; i++) {
            if (!iconTokens.has(char[i]!)) continue
            const o = i * 4
            const br = bg[o]! & 255
            const bgc = bg[o + 1]! & 255
            const bb = bg[o + 2]! & 255
            fg[o] = Math.round((fg[o]! & 255) * mix + br * (1 - mix))
            fg[o + 1] = Math.round((fg[o + 1]! & 255) * mix + bgc * (1 - mix))
            fg[o + 2] = Math.round((fg[o + 2]! & 255) * mix + bb * (1 - mix))
            fg[o + 3] = 255
          }
        }
      } catch (error) {
        failures++
        debug(`render failed ${String(error)}\n${(error as Error)?.stack ?? ""}`)
        if (failures >= 3) {
          context.renderer.removePostProcessFn(render)
          context.ui.toast.show({ title: "Mitsuha wallpaper", message: "Renderer disabled after an error", variant: "error" })
        }
      }
    }

    ;(render as unknown as { __mitsuha: boolean }).__mitsuha = true
    context.renderer.addPostProcessFn(render)
    debug(`postProcessFns=${(context.renderer as unknown as { postProcessFns?: unknown[] }).postProcessFns?.length ?? "?"}`)
    const dispose = () => {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = undefined
      context.renderer.removePostProcessFn(render)
      if ((globalThis as Record<symbol, { dispose: () => void } | undefined>)[STATE]?.dispose === dispose)
        delete (globalThis as Record<symbol, { dispose: () => void } | undefined>)[STATE]
      context.renderer.requestRender()
    }
    ;(globalThis as Record<symbol, { dispose: () => void } | undefined>)[STATE] = { dispose }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "mitsuha.wallpaper.toggle",
          title: "Mitsuha wallpaper",
          group: "Appearance",
          palette: true,
          slash: { name: "wallpaper", arguments: true },
          run(input) {
            const arg = input?.trim().toLowerCase() ?? ""
            if (!arg || arg === "toggle") {
              const next = !playing()
              void update((draft) => {
                draft.playing = next
              })
              if (next) {
                frameDirty = true
                schedule()
                context.renderer.requestRender()
              } else {
                schedule()
                context.renderer.requestRender()
              }
              context.ui.toast.show({ message: next ? "Mitsuha wallpaper on" : "Mitsuha wallpaper off", variant: "info" })
              return
            }
            const match = arg.match(/^(icons|panel)\s+(\d+)$/)
            if (!match) {
              context.ui.toast.show({ message: "Usage: /wallpaper [on|off|icons 0-100|panel 0-100]", variant: "info" })
              return
            }
            const value = Math.min(100, Math.max(0, Number(match[2]))) / 100
            if (match[1] === "icons") {
              void update((draft) => {
                draft.icons = value
              })
              context.renderer.requestRender()
              context.ui.toast.show({ message: `Icons: ${Math.round(value * 100)}%`, variant: "info" })
            } else {
              void update((draft) => {
                draft.panel = value
              })
              context.renderer.requestRender()
              context.ui.toast.show({ message: `Panel glass: ${Math.round(value * 100)}%`, variant: "info" })
            }
          },
        },
      ],
    }))

    schedule()
    context.renderer.requestRender()
    return dispose
  },
})
