(() => {
  'use strict';

  window.__ACORD_BOOT_READY=false;
  window.__ACORD_APP_READY=false;

  const runtime=window.AcordRuntime||null;
  const mark=(stage,detail)=>runtime?.mark?.(stage,detail);
  const status=(message,tone='neutral')=>runtime?.setStatus?.(message,tone);

  function forceLogin(message='',tone='error'){
    const login=document.getElementById('login');
    const app=document.getElementById('appShell');

    if(login){
      login.classList.remove('hidden');
      login.style.display='grid';
      login.style.visibility='visible';
      login.style.opacity='1';
      login.style.pointerEvents='auto';
    }

    if(app && !window.__ACORD_APP_READY){
      app.classList.add('hidden');
    }

    if(message){
      status(message,tone);
    }
  }

  function startup(){
    mark('bootstrap-dom-ready');
    forceLogin('Conectando ao Acord…','neutral');

    setTimeout(()=>{
      if(!window.__ACORD_BOOT_READY){
        mark('bootstrap-slow-3500');
        forceLogin('A interface ainda está carregando. O login continuará disponível.','warn');
      }
    },3500);

    setTimeout(()=>{
      if(!window.__ACORD_BOOT_READY){
        mark('bootstrap-timeout-9000');
        forceLogin('A inicialização demorou mais que o esperado. Recarregue se o login não responder.','error');
      }
    },9000);
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',startup,{once:true});
  }else{
    startup();
  }

  window.addEventListener('error',event=>{
    mark('window-error',{
      message:event?.message||'',
      source:event?.filename||'',
      line:event?.lineno||0,
      column:event?.colno||0
    });
    if(!window.__ACORD_APP_READY){
      console.error('Falha ao iniciar o Acord:',event.error||event.message);
      forceLogin('O Acord encontrou um erro ao iniciar. O login permanece disponível.','error');
    }
  });

  window.addEventListener('unhandledrejection',event=>{
    mark('unhandled-rejection',String(event?.reason?.message||event?.reason||'').slice(0,500));
    if(!window.__ACORD_APP_READY){
      console.error('Falha assíncrona ao iniciar o Acord:',event.reason);
      forceLogin('Uma etapa da inicialização falhou. Você ainda pode tentar entrar.','error');
    }
  });

  const desktop=
    new URLSearchParams(location.search).get('desktop')==='1' ||
    /AcordDesktop\//i.test(navigator.userAgent);

  if(desktop && 'serviceWorker' in navigator){
    mark('desktop-cache-cleanup-start');
    navigator.serviceWorker.getRegistrations()
      .then(items=>Promise.all(items.map(reg=>reg.unregister())))
      .then(()=>mark('desktop-service-workers-cleared'))
      .catch(error=>mark('desktop-service-worker-clear-failed',error?.message||String(error)));

    if('caches' in window){
      caches.keys()
        .then(keys=>Promise.all(keys.map(key=>caches.delete(key))))
        .then(()=>mark('desktop-cache-storage-cleared'))
        .catch(error=>mark('desktop-cache-clear-failed',error?.message||String(error)));
    }
  }
})();
