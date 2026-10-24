(() => {
  'use strict';

  const MAX_ENTRIES=120;
  const entries=[];

  function safeSessionStorage(){
    try{
      const key='__acord_probe__';
      sessionStorage.setItem(key,'1');
      sessionStorage.removeItem(key);
      return sessionStorage;
    }catch{return null}
  }

  const transientStore=safeSessionStorage();

  function detailValue(value){
    if(value==null) return null;
    if(typeof value==='string') return value.slice(0,500);
    try{return JSON.parse(JSON.stringify(value))}catch{return String(value).slice(0,500)}
  }

  function mark(stage,detail=null){
    const item={at:Date.now(),stage:String(stage||'unknown').slice(0,80),detail:detailValue(detail)};
    entries.push(item);
    if(entries.length>MAX_ENTRIES) entries.splice(0,entries.length-MAX_ENTRIES);
    return item;
  }

  function setStatus(message,tone='neutral'){
    const node=document.getElementById('bootStatus');
    if(!node) return;
    node.textContent=String(message||'');
    node.dataset.tone=String(tone||'neutral');
    node.classList.toggle('hidden',!message);
  }

  function getTransientAuthToken(){
    try{return transientStore?.getItem('acord-auth-token')||''}catch{return ''}
  }

  function setTransientAuthToken(token){
    const value=String(token||'');
    try{
      if(value) transientStore?.setItem('acord-auth-token',value);
      else transientStore?.removeItem('acord-auth-token');
    }catch{}
  }

  function clearAuthToken(){
    try{transientStore?.removeItem('acord-auth-token')}catch{}
    try{localStorage.removeItem('acord-auth-token')}catch{}
  }

  // Migra tokens persistentes antigos para armazenamento somente da sessão atual.
  try{
    const legacy=localStorage.getItem('acord-auth-token')||'';
    if(legacy && !getTransientAuthToken()) setTransientAuthToken(legacy);
    if(legacy) localStorage.removeItem('acord-auth-token');
  }catch{}

  const api={
    version:'6.8.5',
    startedAt:Date.now(),
    entries,
    mark,
    setStatus,
    getTransientAuthToken,
    setTransientAuthToken,
    clearAuthToken,
    snapshot(){return entries.slice(-MAX_ENTRIES)}
  };

  window.AcordRuntime=api;
  window.__ACORD_DIAGNOSTICS=api;
  mark('runtime-loaded',{href:location.href,online:navigator.onLine});

  window.addEventListener('online',()=>{
    mark('network-online');
    if(!window.__ACORD_APP_READY) setStatus('Conectado. Validando sua sessão…','ok');
  });

  window.addEventListener('offline',()=>{
    mark('network-offline');
    setStatus('Sem conexão. O Acord tentará reconectar automaticamente.','warn');
  });
})();
