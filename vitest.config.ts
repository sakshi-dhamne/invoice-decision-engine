import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  test: {
    // The rules engine is pure and the fixtures are on disk — the suite must run
    // with no network and no database.
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // pipeline.ts imports the Supabase client module, which refuses to load
    // without these. Creating a client makes no request, so the row adapters
    // stay testable offline; nothing in the suite calls the network.
    env: {
      VITE_SUPABASE_URL: 'http://localhost:54321',
      VITE_SUPABASE_ANON_KEY: 'test-anon-key',
    },
  },
})
