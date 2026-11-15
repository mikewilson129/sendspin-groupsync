import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { buildSyncTrackWav } from './src/calibration/syncPattern'

/**
 * Serves the long sync test track at /sync-track.wav.
 * It is generated in memory so the 29 MB file never has to live in the repo.
 */
function syncTrack(): Plugin {
  const path = '/sync-track.wav'
  let cached: Uint8Array | null = null
  const track = () => (cached ??= buildSyncTrackWav())

  return {
    name: 'groupsync-sync-track',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== path) return next()
        const data = track()
        res.setHeader('Content-Type', 'audio/wav')
        res.setHeader('Accept-Ranges', 'bytes')
        res.setHeader('Cache-Control', 'no-store')
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
        if (match && (match[1] || match[2])) {
          const start = match[1] ? Number(match[1]) : Math.max(0, data.length - Number(match[2]))
          const end = match[1] && match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1
          if (start > end || start >= data.length) {
            res.statusCode = 416
            res.setHeader('Content-Range', `bytes */${data.length}`)
            return res.end()
          }
          res.statusCode = 206
          res.setHeader('Content-Range', `bytes ${start}-${end}/${data.length}`)
          res.setHeader('Content-Length', end - start + 1)
          return res.end(req.method === 'HEAD' ? undefined : data.subarray(start, end + 1))
        }
        res.setHeader('Content-Length', data.length)
        res.end(req.method === 'HEAD' ? undefined : data)
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: path.slice(1), source: track() })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), basicSsl(), syncTrack()],
  server: {
    host: true,   // Allow mobile access on local network
    port: 5173,
    // HTTPS enabled by basicSsl plugin for microphone access on mobile
  },
})
