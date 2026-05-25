import { stores, get, set, del } from './db.js'

const KEY_API = 'anthropic-api-key'
const KEY_VERSION = 'app-version'
const KEY_LAST_UPLOAD_LISTINGS = 'last-upload-listings-at'
const KEY_LAST_UPLOAD_RESULTS = 'last-upload-results-at'

export async function getApiKey() {
  return (await get(KEY_API, stores.settings)) || ''
}

export async function setApiKey(value) {
  await set(KEY_API, value, stores.settings)
}

export async function clearApiKey() {
  await del(KEY_API, stores.settings)
}

export async function getLastUploadTimestamps() {
  return {
    listings: await get(KEY_LAST_UPLOAD_LISTINGS, stores.settings),
    results: await get(KEY_LAST_UPLOAD_RESULTS, stores.settings),
  }
}

export async function noteLastUpload(type) {
  const key = type === 'results' ? KEY_LAST_UPLOAD_RESULTS : KEY_LAST_UPLOAD_LISTINGS
  await set(key, Date.now(), stores.settings)
}

export async function getAppVersion() {
  return (await get(KEY_VERSION, stores.settings)) || null
}

export async function setAppVersion(v) {
  await set(KEY_VERSION, v, stores.settings)
}
