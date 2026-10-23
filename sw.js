const CACHE='acord-cloudflare-v641-static';
const STATIC=['/manifest.webmanifest','/icon-192.png','/icon-512.png'];

self.addEventListener('install',event=>{
  event.waitUntil(
    caches.open(CACHE).then(cache=>cache.addAll(STATIC)).catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(
      keys.filter(key=>key.startsWith('acord-')&&key!==CACHE).map(key=>caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('message',event=>{
  if(event.data==='SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET') return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin) return;

  if(event.request.mode==='navigate'){
    event.respondWith(
      fetch(event.request,{cache:'no-store'}).catch(()=>new Response(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Acord</title><body style="margin:0;background:#07110e;color:#eff8f3;font-family:system-ui;display:grid;place-items:center;min-height:100vh"><main style="max-width:520px;padding:28px;text-align:center"><h1>Acord sem conexão</h1><p style="color:#a8beb4">Não foi possível alcançar o servidor. Verifique sua internet e recarregue a página.</p><button onclick="location.reload()" style="padding:12px 18px;border:0;border-radius:10px;background:#41d99a;font-weight:800">Tentar novamente</button></main></body>',
        {status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}}
      ))
    );
    return;
  }

  if(STATIC.includes(url.pathname)){
    event.respondWith(
      caches.match(event.request).then(cached=>cached||fetch(event.request).then(response=>{
        if(response?.ok){
          const clone=response.clone();
          caches.open(CACHE).then(cache=>cache.put(event.request,clone)).catch(()=>{});
        }
        return response;
      }))
    );
    return;
  }

  // Código, CSS, API, WebSocket e mídia sempre vêm da rede para evitar
  // inicialização com versões misturadas.
  event.respondWith(fetch(event.request,{cache:'no-store'}));
});
