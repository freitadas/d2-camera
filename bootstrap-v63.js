(() => {
  'use strict';

  window.__ACORD_BOOT_READY=false;

  function forceLogin(message=''){
    const login=document.getElementById('login');
    const app=document.getElementById('appShell');

    if(login){
      login.classList.remove('hidden');
      login.style.display='grid';
      login.style.visibility='visible';
      login.style.opacity='1';
      login.style.pointerEvents='auto';
    }

    if(app && !window.__ACORD_BOOT_READY){
      app.classList.add('hidden');
    }

    if(message){
      const error=document.getElementById('authError');
      if(error && !error.textContent){
        error.textContent=message;
      }
    }
  }

  function startup(){
    // Never start with a blank window.
    forceLogin();

    setTimeout(()=>{
      if(!window.__ACORD_BOOT_READY){
        forceLogin('O Acord ainda está carregando. Você pode tentar entrar novamente.');
      }
    },3500);

    setTimeout(()=>{
      if(!window.__ACORD_BOOT_READY){
        forceLogin('Não foi possível concluir a inicialização. Reabra o Acord se necessário.');
      }
    },9000);
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',startup,{once:true});
  }else{
    startup();
  }

  window.addEventListener('error',event=>{
    if(!window.__ACORD_BOOT_READY){
      console.error('Falha ao iniciar o Acord:',event.error||event.message);
      forceLogin('O Acord encontrou um erro ao iniciar. Tente novamente.');
    }
  });

  window.addEventListener('unhandledrejection',event=>{
    if(!window.__ACORD_BOOT_READY){
      console.error('Falha assíncrona ao iniciar o Acord:',event.reason);
      forceLogin('O Acord encontrou um erro ao iniciar. Tente novamente.');
    }
  });

  const desktop=
    new URLSearchParams(location.search).get('desktop')==='1' ||
    /AcordDesktop\//i.test(navigator.userAgent);

  if(desktop && 'serviceWorker' in navigator){
    navigator.serviceWorker.getRegistrations()
      .then(items=>Promise.all(items.map(reg=>reg.unregister())))
      .catch(()=>{});

    if('caches' in window){
      caches.keys()
        .then(keys=>Promise.all(keys.map(key=>caches.delete(key))))
        .catch(()=>{});
    }
  }
})();