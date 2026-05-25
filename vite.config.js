import { defineConfig } from 'vite'

// `base` controls the URL prefix the built site is served from.
// On GitHub Pages, the site lives at /<repo-name>/, so the build needs
// that prefix. Local dev serves from /, so we only set the prefix on build.
// If you rename the repo, update the string below to match.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/sheriffs-sale-dashboard/' : '/',
}))
