(() => {
  'use strict';

  const isDesktop =
    new URLSearchParams(location.search).get('desktop') === '1' ||
    /AcordDesktop\//i.test(navigator.userAgent);

  function showLogin(message=''){
    const login=document.getElementById('login');
    const app=document.getElementById('appShell');

    if(login){
      login.classList.remove('hidden');
      login.style.display='grid';
      login.style.visibility='visible';
      login.style.opacity='1';
    }

    if(app){
      app.classList.add('hidden');
    }

    if(message){
      const error=document.getElementById('authError');
      if(error && !error.textContent){
        error.textContent=message;
      }
    }
  }

  function armStartupGuard(){
    showLogin();

    // Se o bundle principal quebrar durante a inicialização,
    // nunca deixa o usuário preso em uma tela vazia.
    window.setTimeout(()=>{
      if(!window.__ACORD_APP_READY){
        showLogin();
      }
    },2500);

    window.setTimeout(()=>{
      if(!window.__ACORD_APP_READY){
        showLogin('Não foi possível restaurar a sessão automaticamente. Entre novamente.');
      }
    },7000);
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',armStartupGuard,{once:true});
  }else{
    armStartupGuard();
  }

  window.addEventListener('error',event=>{
    if(!window.__ACORD_APP_READY){
      console.error('Falha ao iniciar o Acord:',event.error||event.message);
      showLogin('O Acord encontrou um erro ao iniciar. Tente entrar novamente.');
    }
  });

  window.addEventListener('unhandledrejection',event=>{
    if(!window.__ACORD_APP_READY){
      console.error('Falha assíncrona ao iniciar o Acord:',event.reason);
      showLogin('O Acord encontrou um erro ao iniciar. Tente entrar novamente.');
    }
  });

  // O aplicativo Windows não precisa de Service Worker/offline cache.
  // Limpa caches antigos que podem misturar versões da interface.
  if(isDesktop && 'serviceWorker' in navigator){
    navigator.serviceWorker.getRegistrations()
      .then(registrations=>Promise.all(registrations.map(reg=>reg.unregister())))
      .catch(()=>{});

    if('caches' in window){
      caches.keys()
        .then(keys=>Promise.all(
          keys
            .filter(key=>String(key).startsWith('acord-cloudflare-'))
            .map(key=>caches.delete(key))
        ))
        .catch(()=>{});
    }
  }
})();