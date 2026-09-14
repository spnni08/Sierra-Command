import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

function gitCommitHash() {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'unknown'
  }
}

// Unique per build: git commit hash + build timestamp. Written both into
// the bundle (as __APP_VERSION__, the version the running tab loaded with)
// and into dist/version.json (the version currently live on the server) so
// the app can poll and detect a new deploy without a full reload.
const BUILD_VERSION = `${gitCommitHash()}-${Date.now()}`

function versionFilePlugin() {
  return {
    name: 'version-file',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ version: BUILD_VERSION }),
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), versionFilePlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(BUILD_VERSION),
  },
})
