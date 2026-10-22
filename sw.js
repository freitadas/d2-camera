const CACHE='acord-cloudflare-v52';
const CORE=['/','/manifest.webmanifest','/icon-192.png','/icon-512.png','/socket.io.js'];

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

  if(
    event.request.mode==='navigate' ||
    url.pathname==='/ws' ||
    url.pathname.startsWith('/api/') ||
    url.pathname==='/health' ||
    url.pathname==='/sw.js'
  ){
    event.respondWith(
      fetch(event.request,{cache:'no-store'})
        .catch(()=>caches.match(event.request))
    );
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
