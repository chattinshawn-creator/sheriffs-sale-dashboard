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

export function startRouter(mountEl) {
  async function renderCurrent() {
    const path = currentPath()
    const render = routes.get(path) || routes.get('/')
    mountEl.innerHTML = ''
    try {
      if (render) await render(mountEl)
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

    // Highlight the active nav link.
    document.querySelectorAll('nav.top-nav a').forEach(a => {
      const href = a.getAttribute('href')
      if (href === '#' + path) a.classList.add('active')
      else a.classList.remove('active')
    })
  }
  window.addEventListener('hashchange', renderCurrent)
  renderCurrent()
}
