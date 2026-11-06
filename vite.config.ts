// @ts-nocheck -- node-only config
import { manusGameTuning } from './scripts/manus-tuning/vite.mjs'
import { loadEnv, type Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import { createReadStream, existsSync, readFileSync } from 'node:fs'

/**
 * Local-only fallback: when a `/manus-storage/...` request reaches the local dev/preview server
 * (e.g. headless smoke tests on 127.0.0.1), stream the matching restored file from `assets/`.
 * Platform Preview and published builds resolve these addresses through Storage/CDN instead.
 */
function localManusStorage(): Plugin {
  const types: Record<string, string> = { glb: 'model/gltf-binary', mp3: 'audio/mpeg', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }
  const handler = (req: { url?: string }, res: { setHeader(k: string, v: string): void; statusCode: number }, next: () => void) => {
    const url = (req.url ?? '').split('?')[0]
    if (!url.startsWith('/manus-storage/')) return next()
    let lock: { assets?: Record<string, { path: string }> } = {}
    try { lock = JSON.parse(readFileSync('assets.lock.json', 'utf8')) } catch { return next() }
    const rel = Object.entries(lock.assets ?? {}).find(([, e]) => e.path === url)?.[0]
    if (!rel || !existsSync(rel)) return next()
    res.setHeader('Content-Type', types[rel.split('.').pop() ?? ''] ?? 'application/octet-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.statusCode = 200
    createReadStream(rel).pipe(res as unknown as NodeJS.WritableStream)
  }
  return {
    name: 'local-manus-storage',
    configureServer(server) { server.middlewares.use(handler as never) },
    configurePreviewServer(server) { server.middlewares.use(handler as never) },
  }
}

// Relative base keeps production output portable; the Session owns preview HOST/PORT.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', ['HOST', 'PORT'])
  const port = Number(env.PORT ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT')
  return {
    base: './',
    plugins: [manusGameTuning(), localManusStorage()],
    server: {
      host: env.HOST ?? '127.0.0.1', port, strictPort: true,
      allowedHosts: ['.manuspre.computer', '.manus.computer', '.manus-asia.computer', '.manuscomputer.ai', '.manusvm.computer', 'localhost', '127.0.0.1'],
    },
    build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 4600, sourcemap: false },
    test: { environment: 'node', include: ['tests/**/*.test.{ts,mjs}'] },
  }
})
