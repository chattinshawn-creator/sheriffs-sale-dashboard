import { startRouter, registerRoute, navigate } from './router.js'
import { renderNav } from './ui/nav.js'
import { renderHome } from './views/home.js'
import { renderUpload } from './views/upload.js'
import { renderSettings } from './views/settings.js'
import { renderProperty } from './views/property.js'
import { renderMap } from './views/map.js'

const app = document.getElementById('app')

const navEl = document.createElement('div')
const mainEl = document.createElement('main')
app.appendChild(navEl)
app.appendChild(mainEl)

renderNav(navEl)

registerRoute('/', renderHome)
registerRoute('/upload', renderUpload)
registerRoute('/upload/:uploadId', renderUpload)
registerRoute('/settings', renderSettings)
registerRoute('/property/:caseNumber', renderProperty)
registerRoute('/map', renderMap)

if (!window.location.hash) navigate('/')
startRouter(mainEl)
