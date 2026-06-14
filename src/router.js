import { escapeHtml } from './ui/format.js'

const routes = new Map()

export function registerRoute(path, render) {
  routes.set(path, render)
}

export function navigate(path) {
  window.location.hash = '#' + path
}

export function currentPath() {
  return window.location.hash.slice(1) || '/'
}

/**
 * Parse a `?a=1&b=two` query string into a plain object. Empty/missing
 * string → {}. Keys and values are URI-decoded. Used so views can offer
 * deep links like `#/search?month=2026-06` without changing route matching.
 */
function parseQuery(qs) {
  const out = {}
  if (!qs) return out
  for (const pair of qs.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const k = eq === -1 ? pair : pair.slice(0, eq)
    const v = eq === -1 ? '' : pair.slice(eq + 1)
    try { out[decodeURIComponent(k)] = decodeURIComponent(v) }
    catch { out[k] = v }
  }
  return out
}

/**
 * Match the current path against registered routes.
 * Exact matches win first. Otherwise, routes containing `:param` segments
 * are matched positionally — e.g. registering "/property/:caseNumber"
 * matches "/property/GD-16-022895" with params = { caseNumber: "GD-16-022895" }.
 */
function matchRoute(path) {
  if (routes.has(path)) return { render: routes.get(path), params: {} }
  for (const [routePath, render] of routes) {
    if (!routePath.includes(':')) continue
    const routeParts = routePath.split('/')
    const pathParts = path.split('/')
    if (routeParts.length !== pathParts.length) continue
    const params = {}
    let ok = true
    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(':')) {
        params[routeParts[i].slice(1)] = decodeURIComponent(pathParts[i])
      } else if (routeParts[i] !== pathParts[i]) {
        ok = false
        break
      }
    }
    if (ok) return { render, params }
  }
  return null
}

export function startRouter(mountEl) {
  async function renderCurrent() {
    const raw = currentPath()
    const qIdx = raw.indexOf('?')
    const path = qIdx === -1 ? raw : raw.slice(0, qIdx)
    const query = qIdx === -1 ? {} : parseQuery(raw.slice(qIdx + 1))
    const match = matchRoute(path) || { render: routes.get('/'), params: {} }
    mountEl.innerHTML = ''
    try {
      if (match.render) await match.render(mountEl, { ...match.params, query })
    } catch (e) {
      // Surface render errors instead of leaving a blank page.
      console.error('[router] error rendering', path, e)
      mountEl.innerHTML = `
        <div class="banner err">
          <strong>Something broke rendering this view.</strong>
          <div class="spacer"></div>
          <div class="small">Open the browser console (F12) for the full stack trace.</div>
          <div class="spacer"></div>
          <pre style="white-space:pre-wrap; font-size:12px;">${escapeHtml(String(e?.stack || e?.message || e))}</pre>
        </div>
      `
    }

    // Highlight the active nav link. Compare against the path only (ignoring
    // any ?query) so a deep-linked view stays highlighted.
    document.querySelectorAll('nav.top-nav a').forEach(a => {
      const href = a.getAttribute('href')
      if (href === '#' + path) a.classList.add('active')
      else a.classList.remove('active')
    })
  }
  window.addEventListener('hashchange', renderCurrent)
  renderCurrent()
}
