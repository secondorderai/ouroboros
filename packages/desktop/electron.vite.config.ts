import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          preload: resolve(__dirname, 'src/main/preload.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    // Force a single React copy. In this Bun workspace, transitive deps that
    // peer-depend on `react` can resolve to the hoisted root copy while our
    // own renderer code resolves to the desktop-local copy; without dedupe,
    // both end up in the bundle and React's dispatcher is null inside hooks
    // ("Cannot read properties of null (reading 'useState')"), which leaves
    // the renderer as a blank page. Locked alongside the `react` /
    // `react-dom` overrides in the root package.json.
    resolve: {
      dedupe: ['react', 'react-dom']
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
