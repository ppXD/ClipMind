import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

function webFetchProxyPlugin(): Plugin {
  return {
    name: 'web-fetch-proxy',
    configureServer(server) {
      server.middlewares.use('/api/fetch-url', async (req, res) => {
        const requestUrl = new URL(req.url!, `http://${req.headers.host}`)
        const targetUrl = requestUrl.searchParams.get('url')

        if (!targetUrl) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'Missing url parameter' }))
          return
        }

        try {
          const response = await fetch(targetUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; ClipMind/1.0)',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            redirect: 'follow',
          })

          const body = await response.text()
          const contentType = response.headers.get('content-type') || 'text/html; charset=utf-8'
          res.statusCode = response.status
          res.setHeader('Content-Type', contentType)
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(body)
        } catch {
          res.statusCode = 502
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'Failed to fetch the URL from the server.' }))
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), webFetchProxyPlugin()],
  server: {
    proxy: {
      '/proxy/audiodub-api': {
        target: 'https://api.audiodub.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/proxy\/audiodub-api/, ''),
      },
      '/proxy/audiodub-s3': {
        target: 'https://s3.ap-southeast-1.amazonaws.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/proxy\/audiodub-s3/, ''),
      },
      '/proxy/minimax-api': {
        target: 'https://api.minimax.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/proxy\/minimax-api/, ''),
      },
    },
  },
})
