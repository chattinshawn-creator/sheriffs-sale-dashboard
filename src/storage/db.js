import { promisifyRequest, get, set, del, keys, values, entries } from 'idb-keyval'

// One IndexedDB database, multiple named stores. We open the DB ourselves
// (instead of using idb-keyval's `createStore`) because idb-keyval's helper
// only sets up ONE store per database — calling it multiple times for the
// same DB name silently fails to create the second-and-later stores.
//
// Stores are kept separate so a "clear settings" operation can't accidentally
// wipe uploads, and so that the heavy PDF blobs don't get loaded when we
// just want to list metadata.
const DB_NAME = 'sheriffs-sale-dashboard'

// IMPORTANT: bump this number any time you ADD a new store name below.
// On next page load, the browser will run `onupgradeneeded` and create the
// missing store(s) without losing existing data.
const DB_VERSION = 2

const STORE_NAMES = [
  'uploads',
  'pdf-blobs',
  'properties',
  'settings',
  'geo-data-cache',
]

const dbPromise = (() => {
  const request = indexedDB.open(DB_NAME, DB_VERSION)
  request.onupgradeneeded = () => {
    const db = request.result
    for (const name of STORE_NAMES) {
      if (!db.objectStoreNames.contains(name)) {
        db.createObjectStore(name)
      }
    }
  }
  return promisifyRequest(request)
})()

// Build a "store" handle in the exact shape that idb-keyval's `get`, `set`,
// `del`, `keys`, `values`, `entries` expect: a function
//   (txMode, callback) => Promise<callback's return value>
function makeStore(storeName) {
  return (txMode, callback) =>
    dbPromise.then(db =>
      callback(db.transaction(storeName, txMode).objectStore(storeName))
    )
}

export const stores = {
  uploads:      makeStore('uploads'),
  pdfBlobs:     makeStore('pdf-blobs'),
  properties:   makeStore('properties'),
  settings:     makeStore('settings'),
  geoDataCache: makeStore('geo-data-cache'),
}

export { get, set, del, keys, values, entries }
