import { getApiKey, setApiKey, clearApiKey } from '../storage/settings.js'
import { escapeAttr } from '../ui/format.js'

export async function renderSettings(el) {
  const currentKey = await getApiKey()
  const hasKey = !!currentKey

  el.innerHTML = `
    <h1>Settings</h1>

    <div class="banner warn">
      <strong>Heads up:</strong> Your API key is stored in this browser's local
      database on this device. It never leaves your machine, but anyone with
      access to this computer could read it. Don't use this app on a shared
      computer.
    </div>

    <div class="field">
      <label for="api-key">Anthropic API key</label>
      <input
        type="password"
        id="api-key"
        value="${escapeAttr(currentKey)}"
        placeholder="sk-ant-..."
        autocomplete="off"
      />
      <span class="hint">
        Status:
        <span class="indicator ${hasKey ? 'present' : 'absent'}">
          ${hasKey ? 'Key present' : 'Key not set'}
        </span>
      </span>
    </div>

    <div class="row">
      <button class="primary" id="save-key">Save</button>
      <button class="danger" id="clear-key" ${hasKey ? '' : 'disabled'}>Clear API key</button>
      <span id="save-status" class="muted small"></span>
    </div>

    <div class="spacer"></div>
    <p class="muted small">
      The Anthropic API is not yet called from this app — saving the key here
      just stores it for use in the next prompt's parser.
    </p>
  `

  el.querySelector('#save-key').addEventListener('click', async () => {
    const v = el.querySelector('#api-key').value.trim()
    await setApiKey(v)
    el.querySelector('#save-status').textContent = 'Saved.'
    setTimeout(() => renderSettings(el), 600)
  })

  el.querySelector('#clear-key').addEventListener('click', async () => {
    if (!confirm('Clear the saved API key from this browser?')) return
    await clearApiKey()
    renderSettings(el)
  })
}
