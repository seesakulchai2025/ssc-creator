const CACHE_NAME = 'ssc-creator-v1'
const APP_SHELL = [
  '/',
  '/manifest.webmanifest',
  '/ssc-logo-192.png',
  '/ssc-logo-512.png',
  '/ssc-logo-maskable-512.png',
  '/apple-touch-icon.png',
]

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      await cache.addAll(APP_SHELL)
      const shell = await cache.match('/')
      if (!shell) throw new Error('App shell was not cached')
      const html = await shell.text()
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1])
      await cache.addAll(assets)
    })
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith('ssc-creator-') && key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', event => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async response => {
          if (response.ok) await caches.open(CACHE_NAME).then(cache => cache.put('/', response.clone()))
          return response
        })
        .catch(async () => (await caches.match('/')) || Response.error()),
    )
    return
  }

  if (url.pathname.startsWith('/assets/') || APP_SHELL.includes(url.pathname)) {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request).then(async response => {
        if (response.ok) await caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()))
        return response
      })),
    )
  }
})
