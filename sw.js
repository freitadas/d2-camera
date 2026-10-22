const CACHE='acord-cloudflare-v61-login-fix';
const CORE=['/','/app-v61.css','/bundle-v61.js','/manifest.webmanifest','/icon-192.png','/icon-512.png','/phone-camera-bundle-v61.js'];

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

  if(url.pathname.startsWith('/api/media/')){
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
    return;
  }

  if(
    event.request.mode==='navigate' ||
    url.pathname==='/ws' ||
    url.pathname.startsWith('/api/') ||
    url.pathname==='/health' ||
    url.pathname==='/sw.js' ||
    url.pathname==='/app.js' ||
    url.pathname==='/app.css' ||
    url.pathname==='/phone-camera.js' ||
    url.pathname==='/bundle-v61.js' ||
    url.pathname==='/app-v61.css' ||
    url.pathname==='/phone-camera-bundle-v61.js' ||
    url.pathname==='/index-v61.html'
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
