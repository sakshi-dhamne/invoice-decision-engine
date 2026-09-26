/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  /**
   * The key the /maintenance page asks for. Optional: with no key set, that page
   * renders a line saying it is turned off and nothing else.
   *
   * This is compiled into the bundle every visitor downloads, so it keeps the page
   * out of the way rather than keeping anybody out. The page says so on itself.
   */
  readonly VITE_MAINTENANCE_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
