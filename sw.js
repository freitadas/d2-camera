const CACHE='acord-cloudflare-v63-startup';
const CORE=[
  '/app-v63.css',
  '/bootstrap-v63.js',
  '/bundle-v63.js',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install',event=>{
  event.waitUntil(
    caches.open(CACHE).then(cache=>cache.addAll(CORE)).catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(
      keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET') return;

  const url=new URL(event.request.url);

  if(event.request.mode==='navigate'){
    event.respondWith(fetch(event.request,{cache:'no-store'}));
    return;
  }

  if(
    url.pathname==='/ws' ||
    url.pathname.startsWith('/api/') ||
    url.pathname==='/health' ||
    url.pathname==='/sw.js' ||
    url.pathname==='/bootstrap-v63.js' ||
    url.pathname==='/bundle-v63.js' ||
    url.pathname==='/app-v63.css' ||
    url.pathname==='/index-v63.html' ||
    url.pathname==='/phone-camera-v63.html' ||
    url.pathname==='/phone-camera-bundle-v63.js'
  ){
    event.respondWith(fetch(event.request,{cache:'no-store'}));
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached=>{
      if(cached) return cached;
      return fetch(event.request).then(response=>{
        if(response && response.ok){
          const clone=response.clone();
          caches.open(CACHE).then(cache=>cache.put(event.request,clone)).catch(()=>{});
        }
        return response;
      });
    })
  );
});