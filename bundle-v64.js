(function(global){
'use strict';

class AcordSocket{
  constructor(){
    this.listeners=new Map();
    this.acks=new Map();
    this.queue=[];
    this.connected=false;
    this.id='';
    this.ws=null;
    this.reconnectTimer=null;
    this.reconnectDelay=700;
    this.manualClose=false;
    this.helloTimer=null;
    this._connect();
  }

  on(event,handler){
    if(typeof handler!=='function') return this;
    if(!this.listeners.has(event)) this.listeners.set(event,[]);
    this.listeners.get(event).push(handler);

    if(event==='connect' && this.connected){
      queueMicrotask(()=>{try{handler()}catch(error){console.error(error)}});
    }
    return this;
  }

  emit(event,...args){
    let callback=null;
    if(args.length && typeof args[args.length-1]==='function'){
      callback=args.pop();
    }
    const data=args.length<=1 ? args[0] : args;
    this._sendEvent(event,data,callback,false,0);
    return this;
  }

  timeout(ms){
    const socket=this;
    return {
      emit(event,...args){
        let callback=null;
        if(args.length && typeof args[args.length-1]==='function'){
          callback=args.pop();
        }
        const data=args.length<=1 ? args[0] : args;
        socket._sendEvent(event,data,callback,true,Number(ms)||5000);
        return socket;
      }
    };
  }

  _emitLocal(event,...args){
    const handlers=this.listeners.get(event)||[];
    for(const handler of [...handlers]){
      try{handler(...args)}catch(error){console.error('Evento '+event,error)}
    }
  }

  _newAck(callback,timeoutMode,timeoutMs){
    if(typeof callback!=='function') return null;

    const id='ack-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
    const entry={callback,timeoutMode,timer:null};

    if(timeoutMode){
      entry.timer=setTimeout(()=>{
        if(!this.acks.has(id)) return;
        this.acks.delete(id);
        try{callback(new Error('timeout'))}catch(error){console.error(error)}
      },Math.max(250,timeoutMs||5000));
    }

    this.acks.set(id,entry);
    return id;
  }

  _sendEvent(event,data,callback,timeoutMode,timeoutMs){
    const ackId=this._newAck(callback,timeoutMode,timeoutMs);
    const packet={t:'e',e:String(event||''),d:data};

    if(ackId) packet.a=ackId;

    const encoded=JSON.stringify(packet);

    if(this.connected && this.ws && this.ws.readyState===WebSocket.OPEN){
      try{
        this.ws.send(encoded);
        return;
      }catch{}
    }

    this.queue.push(encoded);
    if(this.queue.length>300) this.queue.splice(0,this.queue.length-300);
  }

  _flushQueue(){
    if(!this.connected || !this.ws || this.ws.readyState!==WebSocket.OPEN) return;
    const pending=this.queue.splice(0);
    for(const encoded of pending){
      try{this.ws.send(encoded)}catch{
        this.queue.unshift(encoded);
        break;
      }
    }
  }

  _scheduleReconnect(){
    if(this.manualClose || this.reconnectTimer) return;
    const delay=this.reconnectDelay;
    this.reconnectDelay=Math.min(5000,Math.round(this.reconnectDelay*1.55));

    this.reconnectTimer=setTimeout(()=>{
      this.reconnectTimer=null;
      this._connect();
    },delay);
  }

  _markConnected(){
    if(this.connected) return;
    this.connected=true;
    this.reconnectDelay=700;
    if(this.helloTimer){
      clearTimeout(this.helloTimer);
      this.helloTimer=null;
    }
    this._flushQueue();
    this._emitLocal('connect');
  }

  _connect(){
    if(this.manualClose) return;

    const protocol=location.protocol==='https:'?'wss:':'ws:';
    const url=protocol+'//'+location.host+'/ws';

    try{
      const ws=new WebSocket(url);
      this.ws=ws;

      ws.addEventListener('open',()=>{
        this.helloTimer=setTimeout(()=>this._markConnected(),1200);
      });

      ws.addEventListener('message',event=>{
        let packet=null;
        try{packet=JSON.parse(String(event.data||''))}catch{return}

        if(packet?.t==='hello'){
          this.id=String(packet.id||'');
          this._markConnected();
          return;
        }

        if(packet?.t==='a'){
          const entry=this.acks.get(String(packet.a||''));
          if(!entry) return;
          this.acks.delete(String(packet.a||''));
          if(entry.timer) clearTimeout(entry.timer);

          try{
            if(entry.timeoutMode){
              entry.callback(null,packet.d);
            }else{
              entry.callback(packet.d);
            }
          }catch(error){console.error(error)}
          return;
        }

        if(packet?.t==='e' && packet.e){
          this._emitLocal(String(packet.e),packet.d);
        }
      });

      ws.addEventListener('close',event=>{
        if(this.ws && this.ws!==ws) return;
        const wasConnected=this.connected;
        this.connected=false;
        this.id='';
        if(this.helloTimer){
          clearTimeout(this.helloTimer);
          this.helloTimer=null;
        }

        if(wasConnected){
          this._emitLocal('disconnect',event.reason||'transport close');
        }

        for(const [ackId,entry] of this.acks){
          if(entry.timer) clearTimeout(entry.timer);
          if(entry.timeoutMode){
            try{entry.callback(new Error('disconnect'))}catch{}
            this.acks.delete(ackId);
          }
        }

        this._scheduleReconnect();
      });

      ws.addEventListener('error',()=>{});
    }catch{
      this._scheduleReconnect();
    }
  }

  connect(){
    if(this.connected) return this;
    this.manualClose=false;
    if(this.reconnectTimer){
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer=null;
    }
    this._connect();
    return this;
  }

  disconnect(){
    this.manualClose=true;
    if(this.reconnectTimer){
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer=null;
    }
    const old=this.ws;
    this.ws=null;
    try{old?.close(1000,'client disconnect')}catch{}
    return this;
  }
}

global.io=function(){
  return new AcordSocket();
};
})(window);


const socket = io({reconnection:true});

const $ = (s) => document.querySelector(s);

window.__ACORD_BUILD='6.4.2';
document.documentElement.dataset.acordBuild='6.4.2';

window.addEventListener('error',event=>{
  console.error('Acord runtime:',event.error||event.message);
  const error=document.querySelector('#authError');
  if(error && !document.querySelector('#login')?.classList.contains('hidden')){
    error.textContent='O Acord encontrou um erro ao iniciar. Atualize a página; se continuar, instale a versão mais recente.';
  }
});

// Controles críticos de autenticação são registrados no início do arquivo.
// Isso mantém Entrar/Criar conta funcionais mesmo se um módulo secundário falhar depois.
document.addEventListener('click',event=>{
  const button=event.target?.closest?.('button');
  if(!button) return;

  if(button.id==='authLoginTab'){
    event.preventDefault();
    event.stopPropagation();
    setAuthMode('login');
    return;
  }

  if(button.id==='authRegisterTab'){
    event.preventDefault();
    event.stopPropagation();
    setAuthMode('register');
    return;
  }

  if(button.id==='loginBtn'){
    event.preventDefault();
    event.stopPropagation();
    submitAuthentication();
    return;
  }

  if(button.id==='showAuthPasswordBtn'){
    event.preventDefault();
    event.stopPropagation();
    togglePasswordVisibility('#authPassword','#showAuthPasswordBtn');
    return;
  }

  if(button.id==='showAuthConfirmBtn'){
    event.preventDefault();
    event.stopPropagation();
    togglePasswordVisibility('#authPasswordConfirm','#showAuthConfirmBtn');
  }
},true);

document.addEventListener('click',event=>{
  try{
    handleEssentialDelegatedClick(event);
  }catch(error){
    console.error('Falha no controlador Essenciais:',error);
  }
});

function getOrCreateUserId(){
  let value = localStorage.getItem('ecord-user-id');

  if(!value){
    value = (crypto?.randomUUID ? crypto.randomUUID() : ('u-' + Date.now() + '-' + Math.random().toString(36).slice(2)));
    localStorage.setItem('ecord-user-id', value);
  }

  return value;
}

function pageWasReloaded(){
  try{
    const navigation=performance.getEntriesByType('navigation')?.[0];
    if(navigation?.type) return navigation.type==='reload';
    return performance.navigation?.type===1;
  }catch{
    return false;
  }
}

const PAGE_WAS_RELOADED=pageWasReloaded();

const state = {
  authToken:window.AcordRuntime?.getTransientAuthToken?.()||'',
  authMode:'login',
  authRestoreFailures:0,
  authKeepaliveTimer:null,
  cookieSession:false,
  recoveryProof:'',
  accountCloudReady:false,
  chatHistoryHasMore:false,
  chatHistoryLoading:false,
  chatHistoryOldestAt:null,
  chatLoadedMessages:[],
  chatHistoryRendering:false,
  userId:'',
  username:'',
  displayName:'',
  bio:'',
  avatar:'',
  banner:'',
  status:'online',
  theme: localStorage.getItem('ecord-theme') || 'default',
  pendingTheme: null,
  palette: localStorage.getItem('ecord-palette') || 'default',
  pendingPalette: null,
  customColor: localStorage.getItem('ecord-custom-color') || '',
  pendingCustomColor: null,
  servers: [],
  serverId: PAGE_WAS_RELOADED ? (localStorage.getItem('ecord-last-server-id') || null) : null,
  textChannelId: PAGE_WAS_RELOADED ? (localStorage.getItem('ecord-last-text-channel-id') || null) : null,
  voiceChannelId: PAGE_WAS_RELOADED ? (localStorage.getItem('ecord-last-voice-channel-id') || null) : null,
  joinedVoiceId: null,
  activeVoiceServerId: null,
  activeVoiceChannelId: null,
  activeVoiceName: '',
  localStream: null,
  cameraTrack: null,
  screenTrack: null,
  screenStream: null,
  screenAudioTrack:null,
  mixedAudioTrack:null,
  screenAudioContext:null,
  screenShareQuality: localStorage.getItem('ecord-screen-quality') || '1080p',
  pendingShareKind: null,
  localMusicQueue: [],
  localMusicIndex: -1,
  localMusicObjectUrls: new Set(),
  peers: new Map(),
  peerNames: new Map(),
  remoteStreams: new Map(),
  remoteAudio: new Map(),
  peerVolumes: new Map(),
  peerAudioNodes: new Map(),
  audioContext: null,
  deafened: false,
  pendingCandidates: new Map(),
  modalAction: null,
  selectedRoleId: null,
  onlineUsers: [],
  lastVoiceMembers: [],
  inviteApplied: false,
  restoreAttempted: false,
  lastOwnedServerSyncAt:0,
  privateCallId: null,
  privatePeerName: null,
  privateJoinTimer:null,
  privateJoinCallId:null,
  privateJoinAttempts:0,
  incomingCall: null,
  pendingAvatar:null,
  pendingBanner:null,
  selectedServerMemberId:null,
  replyToMessageId:null,
  pendingChatAttachment:null,
  textJoinTimer:null,
  textJoinAttempts:0,
  textJoinKey:'',
  chatSendPending:false,
  queuedServerMessages:(()=>{
    try{
      const value=JSON.parse(localStorage.getItem('acord-server-message-queue')||'[]');
      return Array.isArray(value) ? value.slice(-100) : [];
    }catch{
      return [];
    }
  })(),
  pushToTalk:localStorage.getItem('acord-ptt')==='1',
  noiseSuppression:localStorage.getItem('acord-noise-suppression')!=='0',
  preferredMicId:localStorage.getItem('acord-mic-device')||'',
  preferredCameraId:localStorage.getItem('acord-camera-device')||'',
  phoneCameraToken:null,
  phoneCameraPc:null,
  phoneCameraTrack:null,
  phoneCameraLink:'',
  unreadCounts:(()=>{
    try{return JSON.parse(localStorage.getItem('acord-unread-counts')||'{}')||{}}catch{return {}}
  })(),
  cameraQuality:localStorage.getItem('acord-camera-quality')||'1080p',
  megaServerBannerData:null,
  captionRecognition:null,
  localRecorder:null,
  localRecordChunks:[],
  pomodoroTimer:null,
  micHotkey:localStorage.getItem('acord-hotkey-mic')||'',
  deafenHotkey:localStorage.getItem('acord-hotkey-deafen')||'',
  capturingHotkey:null,
  musicShuffle:localStorage.getItem('acord-music-shuffle')==='1',
  musicRepeat:localStorage.getItem('acord-music-repeat')==='1',
  musicFavorites:new Set((()=>{
    try{
      const value=JSON.parse(localStorage.getItem('acord-music-favorites')||'[]');
      return Array.isArray(value)?value:[];
    }catch{
      localStorage.removeItem('acord-music-favorites');
      return [];
    }
  })()),
  serverSettingsIcon: null,
  serverSettingsAccent: '#ff6b4a',
  friendsFilter: 'online',
  serverFriends: [],
  incomingFriendRequests: [],
  outgoingFriendRequests: [],
  friendStateLoaded: false,
  friendsRestoreAttempted: false,
  privateGroups: [],
  activeGroupId: null,
  dmTarget: null,
  dmContactsMode:'all',
  privateInviteHandled: false,
  currentView: PAGE_WAS_RELOADED
    ? (localStorage.getItem('ecord-last-view') || 'friends')
    : 'friends',
  appInitialized: false,
  restoringReload: PAGE_WAS_RELOADED,
  profileReady: false,
  customStatus:'',
  pronouns:'',
  activity:'',
  links:{},
  privacy:{dm:'friends',calls:'friends',friendRequests:'everyone'},
  megaFromServer:false,
  labsPrefs:(()=>{
    try{return JSON.parse(localStorage.getItem('concorde-labs-prefs')||'{}')||{}}catch{return {}}
  })(),
  labsNotes:localStorage.getItem('concorde-labs-notes')||'',
  labsStopwatchStarted:0,
  labsStopwatchTimer:null,
  labsWakeLock:null,
  creativeLocal:(()=>{
    try{return JSON.parse(localStorage.getItem('concorde-creative-local')||'{}')||{}}catch{return {}}
  })(),
  creativeServer:{},
  creativeStartedAt:Date.now(),
  creativeHealthyTimer:null,
  creativeSpeechMonitor:null,
  creativeWordFilter:[],
  interfaceMode:localStorage.getItem('concorde-interface-mode')||'auto',
  dataSaver:localStorage.getItem('concorde-data-saver')==='1',
  mobileDrawerOpen:false,
  callPrefs:{
    echoCancellation:localStorage.getItem('acord-echo-cancellation')!=='0',
    autoGain:localStorage.getItem('acord-auto-gain')!=='0',
    autoReconnect:localStorage.getItem('acord-call-auto-reconnect')!=='0',
    autoRejoin:localStorage.getItem('acord-call-auto-rejoin')==='1',
    adaptiveQuality:localStorage.getItem('acord-call-adaptive')!=='0',
    muteOnJoin:localStorage.getItem('acord-call-mute-on-join')==='1',
    confirmLeave:localStorage.getItem('acord-call-confirm-leave')!=='0',
    sounds:localStorage.getItem('acord-call-sounds')!=='0',
    audioOnly:localStorage.getItem('acord-call-audio-only')==='1',
    mirrorSelf:localStorage.getItem('acord-call-mirror-self')==='1',
    hideSelf:localStorage.getItem('acord-call-hide-self')==='1',
    wakeLock:localStorage.getItem('acord-call-wake-lock')==='1',
    mobileFullscreen:localStorage.getItem('acord-call-mobile-fullscreen')!=='0',
    qualityMode:localStorage.getItem('acord-call-quality-mode')||'auto',
    screenFps:Number(localStorage.getItem('acord-call-screen-fps')||30),
    speakerId:localStorage.getItem('acord-speaker-device')||''
  },
  callHealthTimer:null,
  callMicMeterTimer:null,
  callMicAnalyser:null,
  callMicSource:null,
  callWakeLockHandle:null,
  callRepairing:false,
  callLastGoodAt:0,
  callPreviewStream:null,
  preCallStream:null,
  preCallMeterRaf:null,
  callLayout:localStorage.getItem('acord-call-layout')||'grid',
  pinnedPeerId:localStorage.getItem('acord-call-pinned-peer')||'',
  peerQuality:new Map(),
  peerSpeakingRaf:new Map(),
  mutedSpeechStream:null,
  mutedSpeechRaf:null,
  mutedSpeechCooldown:0,
  rtcTurnConfigured:false
};

function setConnectionStatus(label,stateName='connecting'){
  const node=document.getElementById('connectionStatus');
  if(!node) return;
  node.textContent=String(label||'');
  node.dataset.state=String(stateName||'connecting');
}

const rtcConfig = {
  iceServers: [
    {urls:'stun:stun.l.google.com:19302'},
    {urls:'stun:stun1.l.google.com:19302'},
    {urls:'stun:stun.cloudflare.com:3478'}
  ],
  iceCandidatePoolSize: 10
};

fetch('/api/rtc-config',{cache:'no-store'})
  .then(response=>response.ok?response.json():null)
  .then(data=>{
    if(Array.isArray(data?.iceServers) && data.iceServers.length){
      rtcConfig.iceServers.push(...data.iceServers);
    }
    state.rtcTurnConfigured=!!data?.turnConfigured || (data?.iceServers||[]).some(server=>
      (Array.isArray(server.urls)?server.urls:[server.urls]).some(url=>/^turns?:/i.test(String(url||'')))
    );
    updateTurnBadge();
  })
  .catch(()=>{});



// Música pessoal: este <audio> é local ao navegador e nunca é adicionado ao WebRTC.
function formatMusicTime(seconds){
  const value = Number(seconds);
  if(!Number.isFinite(value) || value < 0) return '0:00';

  const minutes = Math.floor(value / 60);
  const secs = Math.floor(value % 60).toString().padStart(2,'0');
  return minutes + ':' + secs;
}

function currentLocalMusic(){
  return state.localMusicQueue[state.localMusicIndex] || null;
}

function updateLocalMusicPlayButton(){
  const audio = $('#localMusicAudio');
  if(!audio) return;
  $('#localMusicPlayBtn').textContent = audio.paused ? '▶' : '⏸';
}

function renderLocalMusicQueue(){
  const list = $('#localMusicList');
  if(!list) return;

  list.innerHTML = '';

  if(!state.localMusicQueue.length){
    const empty = document.createElement('div');
    empty.className = 'localMusicEmpty';
    empty.textContent = 'Sua fila está vazia.';
    list.appendChild(empty);
    return;
  }

  state.localMusicQueue.forEach((track,index)=>{
    const row = document.createElement('div');
    row.className = 'localMusicItem' + (index === state.localMusicIndex ? ' active' : '');

    const play = document.createElement('button');
    play.type = 'button';
    play.textContent = index === state.localMusicIndex ? '♫' : '▶';
    play.title = 'Tocar';

    const name = document.createElement('div');
    name.className = 'localMusicItemName';
    name.textContent = track.name || 'Música';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Remover';

    play.addEventListener('click',()=>{
      playLocalMusicTrack(index,true);
    });

    remove.addEventListener('click',()=>{
      removeLocalMusicTrack(index);
    });

    row.append(play,name,remove);
    list.appendChild(row);
  });
}

async function playLocalMusicTrack(index,autoplay=true){
  const audio = $('#localMusicAudio');
  const track = state.localMusicQueue[index];
  if(!audio || !track) return;

  state.localMusicIndex = index;

  if(audio.src !== track.url){
    audio.src = track.url;
    audio.load();
  }

  $('#localMusicTrack').textContent = track.name || 'Música';
  renderLocalMusicQueue();

  if(autoplay){
    try{
      await audio.play();
    }catch(error){
      console.warn('Não foi possível iniciar a música:',error);
      toast('Clique em ▶ para tocar a música');
    }
  }

  updateLocalMusicPlayButton();
}

function addLocalMusicFiles(files){
  const list = Array.from(files || []).filter(file=>String(file.type || '').startsWith('audio/'));

  if(!list.length){
    toast('Escolha um arquivo de áudio');
    return;
  }

  const firstNewIndex = state.localMusicQueue.length;

  list.forEach(file=>{
    const url = URL.createObjectURL(file);
    state.localMusicObjectUrls.add(url);

    state.localMusicQueue.push({
      name:String(file.name || 'Música').replace(/\.[^.]+$/,''),
      url,
      local:true
    });
  });

  renderLocalMusicQueue();

  if(state.localMusicIndex < 0){
    playLocalMusicTrack(firstNewIndex,false);
  }

  toast(list.length === 1 ? 'Música adicionada' : 'Músicas adicionadas');
}

function addLocalMusicUrl(){
  const input = $('#localMusicUrl');
  const value = String(input?.value || '').trim();

  if(!/^https:\/\//i.test(value)){
    toast('Use um link HTTPS direto de áudio');
    return;
  }

  let name = 'Música por link';

  try{
    const parsed = new URL(value);
    const last = decodeURIComponent(parsed.pathname.split('/').pop() || '');
    if(last){
      name = last.replace(/\.[^.]+$/,'') || name;
    }
  }catch{}

  const index = state.localMusicQueue.length;

  state.localMusicQueue.push({
    name,
    url:value,
    local:false
  });

  input.value = '';
  renderLocalMusicQueue();

  if(state.localMusicIndex < 0){
    playLocalMusicTrack(index,false);
  }

  toast('Link adicionado');
}

function removeLocalMusicTrack(index){
  const audio = $('#localMusicAudio');
  const track = state.localMusicQueue[index];
  if(!track) return;

  const wasCurrent = index === state.localMusicIndex;

  if(track.local && state.localMusicObjectUrls.has(track.url)){
    try{URL.revokeObjectURL(track.url)}catch{}
    state.localMusicObjectUrls.delete(track.url);
  }

  state.localMusicQueue.splice(index,1);

  if(!state.localMusicQueue.length){
    state.localMusicIndex = -1;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    $('#localMusicTrack').textContent = 'Nenhuma música selecionada';
    $('#localMusicCurrent').textContent = '0:00';
    $('#localMusicDuration').textContent = '0:00';
    $('#localMusicSeek').value = 0;
  }else if(wasCurrent){
    const nextIndex = Math.min(index,state.localMusicQueue.length - 1);
    state.localMusicIndex = -1;
    playLocalMusicTrack(nextIndex,false);
  }else if(index < state.localMusicIndex){
    state.localMusicIndex -= 1;
  }

  renderLocalMusicQueue();
  updateLocalMusicPlayButton();
}

function nextLocalMusic(){
  if(!state.localMusicQueue.length)return;
  if(state.musicRepeat && state.localMusicIndex>=0){
    playLocalMusicTrack(state.localMusicIndex,true);return;
  }
  let next;
  if(state.musicShuffle && state.localMusicQueue.length>1){
    do{next=Math.floor(Math.random()*state.localMusicQueue.length)}while(next===state.localMusicIndex);
  }else{
    next=state.localMusicIndex<0?0:(state.localMusicIndex+1)%state.localMusicQueue.length;
  }
  playLocalMusicTrack(next,true);
}

function previousLocalMusic(){
  if(!state.localMusicQueue.length) return;

  const previous =
    state.localMusicIndex <= 0
      ? state.localMusicQueue.length - 1
      : state.localMusicIndex - 1;

  playLocalMusicTrack(previous,true);
}

async function toggleLocalMusicPlayback(){
  const audio = $('#localMusicAudio');

  if(!state.localMusicQueue.length){
    $('#localMusicFiles').click();
    return;
  }

  if(state.localMusicIndex < 0){
    await playLocalMusicTrack(0,true);
    return;
  }

  if(audio.paused){
    try{
      await audio.play();
    }catch{
      toast('Não foi possível tocar essa música');
    }
  }else{
    audio.pause();
  }

  updateLocalMusicPlayButton();
}

function toggleLocalMusicPanel(){
  const panel = $('#localMusicPanel');
  const btn = $('#musicBtn');

  if(!panel || !btn) return;

  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden',!opening);
  btn.classList.toggle('musicActive',opening);
}


function setAuthMode(mode){
  state.authMode=mode==='register'?'register':'login';
  const registering=state.authMode==='register';
  $('#authLoginTab').classList.toggle('active',!registering);
  $('#authRegisterTab').classList.toggle('active',registering);
  $('#authConfirmWrap').classList.toggle('hidden',!registering);
  $('#authTitle').textContent=registering?'Criar conta':'Entrar no Acord';
  $('#authText').textContent=registering?'Escolha um nome único e uma senha.':'Entre com seu nome único e sua senha.';
  $('#loginBtn').textContent=registering?'Criar conta':'Entrar';
  $('#authPassword').setAttribute('autocomplete',registering?'new-password':'current-password');
  $('#authError').textContent='';
}
let authSubmitTimer=null;

function resetAuthSubmitButton(){
  clearTimeout(authSubmitTimer);
  authSubmitTimer=null;

  const button=$('#loginBtn');
  if(!button) return;

  button.disabled=false;
  button.textContent=state.authMode==='register'?'Criar conta':'Entrar';
}

function submitAuthentication(){
  const username=$('#authUsername').value.trim().slice(0,30);
  const password=$('#authPassword').value;
  const confirmation=$('#authPasswordConfirm').value;
  const error=$('#authError');

  error.textContent='';

  if(!socket.connected){
    error.textContent='Sem conexão com o servidor. Aguarde alguns segundos e tente novamente.';
    resetAuthSubmitButton();
    return;
  }

  if(username.length<3){
    error.textContent='O nome precisa ter pelo menos 3 caracteres.';
    resetAuthSubmitButton();
    return;
  }

  const minimumPasswordLength=state.authMode==='register'?8:6;
  if(password.length<minimumPasswordLength){
    error.textContent=state.authMode==='register'
      ? 'Para criar a conta, use pelo menos 8 caracteres.'
      : 'A senha precisa ter pelo menos 6 caracteres.';
    resetAuthSubmitButton();
    return;
  }

  if(state.authMode==='register' && password!==confirmation){
    error.textContent='As senhas não são iguais.';
    resetAuthSubmitButton();
    return;
  }

  const button=$('#loginBtn');
  window.AcordRuntime?.setStatus?.(state.authMode==='register'?'Criando conta…':'Validando login…','neutral');
  button.disabled=true;
  button.textContent=state.authMode==='register'?'Criando...':'Entrando...';

  authSubmitTimer=setTimeout(()=>{
    resetAuthSubmitButton();
    error.textContent='O servidor demorou para responder. Tente novamente.';
  },10000);

  if(state.authMode==='register'){
    socket.emit('auth-register',{username,password});
  }else{
    socket.emit('auth-login',{
      username,
      password,
      recovery:readLocalRecoverySnapshot()
    });
  }
}
function stopAuthKeepalive(){
  if(state.authKeepaliveTimer){
    clearInterval(state.authKeepaliveTimer);
    state.authKeepaliveTimer=null;
  }
}

function startAuthKeepalive(){
  stopAuthKeepalive();

  if(!state.profileReady) return;

  state.authKeepaliveTimer=setInterval(()=>{
    if(socket.connected && state.profileReady){
      socket.emit(
        'auth-keepalive',
        state.authToken ? {token:state.authToken} : {}
      );
    }

    saveLocalRecoverySnapshot();
  },1000*60*5);

  saveLocalRecoverySnapshot();
}

function clearAccountState(){
  window.__ACORD_APP_READY=false;
  stopAuthKeepalive();
  state.authRestoreFailures=0;
  state.accountCloudReady=false;
  state.cookieSession=false;
  state.recoveryProof='';
  state.authToken='';state.userId='';state.username='';state.displayName='';
  state.bio='';state.avatar='';state.banner='';state.profileReady=false;state.appInitialized=false;
  window.AcordRuntime?.clearAuthToken?.();
  localStorage.removeItem('ecord-user-id');localStorage.removeItem('ecord-name');
  localStorage.removeItem('ecord-bio');localStorage.removeItem('ecord-avatar');
  try{leaveVoice()}catch{}
  $('#login').classList.remove('hidden');$('#appShell').classList.add('hidden');
  $('#profileModalWrap').classList.add('hidden');
  $('#authPassword').value='';$('#authPasswordConfirm').value='';
}
function buildLocalRecoverySnapshot(){
  if(!state.userId || !state.username) return null;

  return {
    version:2,
    savedAt:Date.now(),
    userId:state.userId,
    username:state.username,
    displayName:state.displayName || state.username,
    bio:state.bio || '',
    avatar:state.avatar || '',
    banner:state.banner || '',
    status:state.status || 'online',
    customStatus:state.customStatus || '',
    pronouns:state.pronouns || '',
    activity:state.activity || '',
    links:state.links || {},
    privacy:state.privacy || {},
    recoveryProof:state.recoveryProof || '',
    friends:readFriendCache(),
    servers:getCachedServers(),
    lastServerId:state.serverId || null,
    lastTextChannelId:state.textChannelId || null,
    lastVoiceChannelId:state.voiceChannelId || null
  };
}

function saveLocalRecoverySnapshot(){
  try{
    const snapshot=buildLocalRecoverySnapshot();
    if(!snapshot) return;

    localStorage.setItem(
      'acord-recovery-v1',
      JSON.stringify(snapshot)
    );
  }catch(error){
    console.warn('Não foi possível atualizar o backup local',error);
  }
}

function readLocalRecoverySnapshot(){
  try{
    const value=JSON.parse(localStorage.getItem('acord-recovery-v1') || 'null');
    if(!value || ![1,2].includes(Number(value.version)) || !value.userId || !value.username) return null;
    return value;
  }catch{
    return null;
  }
}

async function establishSessionCookie(token){
  const raw=String(token||'');
  if(raw.length<20) return false;

  try{
    const response=await fetch('/api/session-cookie',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token:raw}),
      credentials:'same-origin',
      cache:'no-store'
    });

    if(!response.ok) return false;

    state.cookieSession=true;
    // O cookie HttpOnly é a sessão persistente. O token deixa de ficar
    // disponível ao JavaScript assim que a migração para o cookie termina.
    state.authToken='';
    window.AcordRuntime?.clearAuthToken?.();
    saveLocalRecoverySnapshot();
    return true;
  }catch{
    return false;
  }
}

async function clearSessionCookie(){
  try{
    await fetch('/api/session-cookie',{
      method:'DELETE',
      credentials:'same-origin',
      cache:'no-store'
    });
  }catch{}
}

function applyAuthProfile(profile,token,{cookieSession=false}={}){
  if(!profile?.id) return;
  if(!token && !cookieSession && !state.cookieSession) return;

  if(token){
    state.authToken=String(token);
    window.AcordRuntime?.setTransientAuthToken?.(state.authToken);
  }

  if(cookieSession){
    state.cookieSession=true;
    state.authToken='';
    window.AcordRuntime?.clearAuthToken?.();
  }

  state.userId=profile.id;
  state.username=profile.username||'';
  state.displayName=profile.displayName||profile.username||'';
  state.bio=profile.bio||'';
  state.avatar=profile.avatar||'';
  state.banner=profile.banner||'';
  state.status=profile.status||'online';
  state.customStatus=profile.customStatus||'';
  state.pronouns=profile.pronouns||'';
  state.activity=profile.activity||'';
  state.links=profile.links||{};
  state.privacy=profile.privacy||{};
  state.profileReady=true;

  localStorage.setItem('ecord-user-id',state.userId);
  localStorage.setItem('ecord-name',state.username);
  localStorage.setItem('ecord-bio',state.bio);
  try{localStorage.setItem('ecord-avatar',state.avatar)}catch{}

  // Inicializa a interface principal ANTES de esconder o login.
  // Se qualquer módulo falhar, o usuário continua vendo a tela de entrada.
  try{
    refreshOwnProfileUI();
    saveLocalRecoverySnapshot();

    if(!state.appInitialized){
      setAppMode('hub');
      setView('friends');
    }else{
      restoreCurrentView();
    }

    window.__ACORD_APP_READY=true;
    window.AcordRuntime?.setStatus?.('Sessão validada. Acord pronto.','ok');
    window.AcordRuntime?.mark?.('app-ui-ready',{userId:state.userId});
    $('#appShell').classList.remove('hidden');
    $('#login').classList.add('hidden');
    $('#login').style.removeProperty('display');
    $('#login').style.removeProperty('visibility');
    $('#login').style.removeProperty('opacity');
  }catch(error){
    window.__ACORD_APP_READY=false;
    console.error('Falha ao abrir a interface principal:',error);
    window.AcordRuntime?.mark?.('app-ui-failed',error?.message||String(error));
    window.AcordRuntime?.setStatus?.('Não foi possível abrir a interface. O login continua disponível.','error');
    $('#login').classList.remove('hidden');
    $('#appShell').classList.add('hidden');
    $('#authError').textContent='Não foi possível abrir o Acord. Entre novamente.';
    return;
  }

  socket.emit('get-account-state');
  socket.emit('get-servers');
  socket.emit('get-friend-state');
  socket.emit('get-group-state');
  setTimeout(syncCachedOutgoingDms,700);
}

async function logoutAccount(){
  socket.emit(
    'auth-logout',
    state.authToken ? {token:state.authToken} : {}
  );
  await clearSessionCookie();
}

async function deleteAccount(){
  const result=await appDialog({
    title:'Excluir conta',
    message:'Sua conta, amizades, mensagens e dados associados serão removidos permanentemente. Essa ação não pode ser desfeita.',
    confirmText:'Excluir conta',
    danger:true
  });
  if(!result) return;
  socket.emit('delete-account',state.authToken?{token:state.authToken}:{});
}
async function readImageFile(file,maxSize=1100,quality=.82){
  if(!file) return '';
  return await new Promise((resolve,reject)=>{
    const reader=new FileReader();reader.onerror=()=>reject(new Error('Falha ao ler imagem'));
    reader.onload=()=>{
      const image=new Image();image.onerror=()=>reject(new Error('Imagem inválida'));
      image.onload=()=>{
        const ratio=Math.min(1,maxSize/Math.max(image.naturalWidth,image.naturalHeight));
        const canvas=document.createElement('canvas');
        canvas.width=Math.max(1,Math.round(image.naturalWidth*ratio));
        canvas.height=Math.max(1,Math.round(image.naturalHeight*ratio));
        canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
        resolve(canvas.toDataURL('image/jpeg',quality));
      };image.src=reader.result;
    };reader.readAsDataURL(file);
  });
}
function maybeNotify(title,body){
  if(state?.labsPrefs?.dnd || state?.labsPrefs?.notifications===false) return;
  if(document.visibilityState==='visible') return;
  if('Notification' in window && Notification.permission==='granted') new Notification(title,{body});
}
async function requestNotifications(){
  if('Notification' in window && Notification.permission==='default'){
    try{await Notification.requestPermission()}catch{}
  }
}
async function refreshMediaDevices(){
  if(!navigator.mediaDevices?.enumerateDevices) return;
  const devices=await navigator.mediaDevices.enumerateDevices();
  const mic=$('#micDeviceSelect'),camera=$('#cameraDeviceSelect');
  mic.innerHTML='';camera.innerHTML='';
  devices.filter(d=>d.kind==='audioinput').forEach((d,i)=>{
    const o=document.createElement('option');o.value=d.deviceId;o.textContent=d.label||('Microfone '+(i+1));mic.appendChild(o);
  });
  devices.filter(d=>d.kind==='videoinput').forEach((d,i)=>{
    const o=document.createElement('option');o.value=d.deviceId;o.textContent=d.label||('Câmera '+(i+1));camera.appendChild(o);
  });
  if(state.preferredMicId) mic.value=state.preferredMicId;
  if(state.preferredCameraId) camera.value=state.preferredCameraId;
}
function updatePhoneCameraUI(){
  const wrap=$('#phoneCameraLinkWrap');
  const qr=$('#phoneCameraQr');
  const status=$('#phoneCameraStatus');
  const directLink=$('#phoneCameraDirectLink');
  const copyButton=$('#phoneCameraCopyLinkBtn');
  if(!wrap || !qr || !status) return;

  const active=!!state.phoneCameraToken;
  wrap.classList.toggle('hidden',!active);

  if(directLink){
    directLink.href=active && state.phoneCameraLink
      ? state.phoneCameraLink
      : '#';
    directLink.classList.toggle('hidden',!active || !state.phoneCameraLink);
  }

  if(copyButton){
    copyButton.classList.toggle('hidden',!active || !state.phoneCameraLink);
  }

  if(active && state.phoneCameraLink){
    qr.onerror=()=>{
      qr.classList.add('hidden');
      status.textContent='QR indisponível. Use “Abrir link da câmera” ou “Copiar link”.';
    };

    qr.onload=()=>{
      qr.classList.remove('hidden');
      if(!state.phoneCameraTrack){
        status.textContent='Escaneie o QR Code com o celular';
      }
    };

    qr.classList.remove('hidden');
    qr.src=
      location.origin+
      '/phone-camera-qr/' +
      encodeURIComponent(state.phoneCameraToken) +
      '?v=' + Date.now();
  }else{
    qr.onerror=null;
    qr.onload=null;
    qr.removeAttribute('src');
    qr.classList.remove('hidden');
  }

  status.textContent=
    state.phoneCameraTrack?.readyState==='live'
      ? 'Celular conectado · câmera visível'
      : active
        ? 'Escaneie o QR Code com o celular'
        : 'Nenhum celular conectado.';
}

function createPhoneCameraLink(){
  if(!state.profileReady || !state.userId){
    toast('Entre na sua conta primeiro');
    return;
  }
  socket.emit('phone-camera-create');
}


function closePhoneCameraPeer(){
  const old=state.phoneCameraPc;
  state.phoneCameraPc=null;
  if(old){try{old.close()}catch{}}

  if(state.phoneCameraTrack){
    try{state.phoneCameraTrack.stop()}catch{}
  }

  state.phoneCameraTrack=null;

  const preview=$('#phoneCameraPreview');
  const previewWrap=$('#phoneCameraPreviewWrap');

  if(preview) preview.srcObject=null;
  previewWrap?.classList.add('hidden');
}

async function activatePhoneCameraTrack(track){
  if(!track) return;

  if(state.cameraTrack && state.cameraTrack!==track){
    try{state.cameraTrack.stop()}catch{}
  }

  state.phoneCameraTrack=track;
  state.cameraTrack=track;

  if(!state.localStream){
    state.localStream=new MediaStream();
  }

  for(const old of state.localStream.getVideoTracks()){
    if(old.id!==track.id){
      state.localStream.removeTrack(old);
      try{old.stop()}catch{}
    }
  }

  if(
    !state.localStream.getVideoTracks().some(
      current=>current.id===track.id
    )
  ){
    state.localStream.addTrack(track);
  }

  const preview=$('#phoneCameraPreview');
  const previewWrap=$('#phoneCameraPreviewWrap');

  if(preview){
    preview.srcObject=new MediaStream([track]);
    preview.muted=true;
    preview.playsInline=true;

    try{
      await preview.play();
    }catch{}
  }

  previewWrap?.classList.remove('hidden');

  const refreshLocalPreview=()=>{
    ensureCard(
      'local',
      state.username+' (você)',
      state.localStream,
      true
    );

    updatePhoneCameraUI();
  };

  track.addEventListener('unmute',refreshLocalPreview);
  track.addEventListener('mute',refreshLocalPreview);
  track.addEventListener('ended',()=>{
    if(state.phoneCameraTrack===track){
      state.phoneCameraTrack=null;
      if(state.cameraTrack===track) state.cameraTrack=null;
      previewWrap?.classList.add('hidden');
      if(preview) preview.srcObject=null;
      updatePhoneCameraUI();
      ensureCard('local',state.username+' (você)',state.localStream,true);
    }
  });

  if(state.joinedVoiceId && !state.screenTrack){
    await replaceVideoForAll(track);
    await applyCameraSenderQuality();
  }

  refreshLocalPreview();

  $('#cameraBtn').textContent='📱 Câmera do celular';
  $('#cameraBtn').classList.remove('off');
  $('#phoneCameraStatus').textContent='Celular conectado · câmera visível';
  toast('Câmera do celular conectada');
}

function stopPhoneCameraConnection(notifyServer=true){
  const oldPhoneTrack=state.phoneCameraTrack;
  if(notifyServer && state.phoneCameraToken){
    socket.emit('phone-camera-stop',{token:state.phoneCameraToken});
  }

  closePhoneCameraPeer();

  if(state.cameraTrack===oldPhoneTrack){
    state.cameraTrack=null;
  }

  state.phoneCameraToken=null;
  state.phoneCameraLink='';
  $('#cameraBtn').textContent='Câmera';
  $('#cameraBtn').classList.add('off');
  updatePhoneCameraUI();
}

async function receivePhoneCameraOffer(data){
  if(!data?.token || data.token!==state.phoneCameraToken || !data.sdp) return;

  closePhoneCameraPeer();

  const pc=new RTCPeerConnection(rtcConfig);
  state.phoneCameraPc=pc;

  pc.onicecandidate=event=>{
    if(event.candidate && state.phoneCameraToken){
      socket.emit('phone-camera-ice',{
        token:state.phoneCameraToken,
        candidate:event.candidate
      });
    }
  };

  pc.ontrack=event=>{
    if(event.track?.kind==='video'){
      activatePhoneCameraTrack(event.track).catch(console.error);
    }
  };

  pc.onconnectionstatechange=()=>{
    const status=$('#phoneCameraStatus');
    if(!status) return;

    if(pc.connectionState==='connecting'){
      status.textContent='Conectando vídeo do celular...';
    }else if(pc.connectionState==='connected'){
      status.textContent='Celular conectado · câmera visível';
    }else if(pc.connectionState==='failed'){
      status.textContent='Falha ao receber o vídeo do celular';
    }
  };

  await pc.setRemoteDescription(data.sdp);
  const answer=await pc.createAnswer();
  await pc.setLocalDescription(answer);

  socket.emit('phone-camera-answer',{
    token:data.token,
    sdp:pc.localDescription
  });
}

function toggleCallSettings(){
  const panel=$('#callSettingsPanel');
  const opening=panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  if(opening){
    refreshCallDevices().catch(()=>{});
    syncCallPrefsUI();
    if(state.joinedVoiceId)startMicLevelMeter();
    callDiagnostics().catch(()=>{});
  }
}

let messageContextTarget=null;

function closeMessageContextMenu(){
  messageContextTarget=null;
  $('#messageContextMenu')?.classList.add('hidden');
}

function openMessageContextMenu(event,message){
  event.preventDefault();
  if(!message?.id) return;

  messageContextTarget=message;

  const menu=$('#messageContextMenu');
  const edit=$('#contextEditBtn');
  const remove=$('#contextDeleteBtn');

  const own=message.userId===state.userId;
  edit.classList.toggle('hidden',!own);
  remove.classList.toggle('hidden',!own);

  menu.classList.remove('hidden');

  const margin=8;
  const rect=menu.getBoundingClientRect();
  const x=Math.min(event.clientX,window.innerWidth-rect.width-margin);
  const y=Math.min(event.clientY,window.innerHeight-rect.height-margin);

  menu.style.left=Math.max(margin,x)+'px';
  menu.style.top=Math.max(margin,y)+'px';
}

function toast(text){
  const el = $('#toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(()=>el.classList.add('hidden'),1800);
}

let appDialogResolver=null;

function closeAppDialog(result=null){
  const wrap=$('#appDialogWrap');
  wrap?.classList.add('hidden');
  const resolver=appDialogResolver;
  appDialogResolver=null;
  if(resolver) resolver(result);
}

function appDialog({
  title='Confirmar',
  message='',
  value=null,
  placeholder='',
  confirmText='Confirmar',
  cancelText='Cancelar',
  danger=false
}={}){
  if(appDialogResolver){
    closeAppDialog(null);
  }

  const wrap=$('#appDialogWrap');
  const modal=wrap?.querySelector('.appDialog');
  const input=$('#appDialogInput');

  $('#appDialogTitle').textContent=title;
  $('#appDialogMessage').textContent=message;
  $('#appDialogConfirmBtn').textContent=confirmText;
  $('#appDialogCancelBtn').textContent=cancelText;
  modal?.classList.toggle('danger',!!danger);
  $('#appDialogIcon').textContent=danger?'!':'✓';

  if(value===null){
    input.classList.add('hidden');
    input.value='';
  }else{
    input.classList.remove('hidden');
    input.value=String(value||'');
    input.placeholder=placeholder;
  }

  wrap?.classList.remove('hidden');

  requestAnimationFrame(()=>{
    (value===null ? $('#appDialogConfirmBtn') : input)?.focus();
    if(value!==null){
      try{input.setSelectionRange(input.value.length,input.value.length)}catch{}
    }
  });

  return new Promise(resolve=>{
    appDialogResolver=result=>{
      if(result===true && value!==null){
        resolve(input.value);
      }else{
        resolve(result);
      }
    };
  });
}

$('#appDialogCancelBtn').addEventListener('click',()=>closeAppDialog(null));
$('#appDialogConfirmBtn').addEventListener('click',()=>closeAppDialog(true));
$('#appDialogWrap').addEventListener('click',event=>{
  if(event.target===$('#appDialogWrap')) closeAppDialog(null);
});
$('#appDialogInput').addEventListener('keydown',event=>{
  if(event.key==='Escape'){
    event.preventDefault();
    closeAppDialog(null);
  }
  if(event.key==='Enter' && !event.shiftKey){
    event.preventDefault();
    closeAppDialog(true);
  }
});


function initials(name){
  return (name || 'U').trim().charAt(0).toUpperCase() || 'U';
}



function profileForName(username){
  const key = String(username || '').toLowerCase();

  if(key === String(state.username || '').toLowerCase()){
    return {
      id:state.userId,
      username:state.username,
      bio:state.bio,
      avatar:state.avatar
    };
  }

  return state.onlineUsers.find(
    user => String(user.username || '').toLowerCase() === key
  ) || null;
}

function applyAvatar(el, profile, fallbackName){
  if(!el) return;

  const avatar = String(profile?.avatar || '');

  if(avatar){
    el.textContent = '';
    el.style.backgroundImage = 'url("' + avatar.replace(/"/g,'') + '")';
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
  }else{
    el.style.backgroundImage = '';
    el.textContent = initials(profile?.username || fallbackName || 'U');
  }
}


const PROFILE_THEMES = ['default','black','white','blue','purple','custom'];

function normalizeProfileTheme(theme){
  return PROFILE_THEMES.includes(theme) ? theme : 'default';
}

function applyProfileTheme(theme){
  const selected = normalizeProfileTheme(theme);
  if(selected === 'default' || selected === 'custom'){
    document.documentElement.removeAttribute('data-theme');
  }else{
    document.documentElement.setAttribute('data-theme',selected);
  }
  document.body.classList.toggle('customSiteColorMode', selected === 'custom');
  if(selected==='custom'){
    applyCustomColor(state.pendingCustomColor || state.customColor || '#ff6b4a');
  }else{
    clearCustomColorOverrides();
  }
}

function updateProfileThemeButtons(){
  const selected = normalizeProfileTheme(state.pendingTheme || state.theme);

  document.querySelectorAll('[data-profile-theme]').forEach(button=>{
    button.classList.toggle(
      'active',
      button.dataset.profileTheme === selected
    );
  });

  const dot = $('#profileThemeDotCustom');
  const color = state.pendingCustomColor || state.customColor || '#ff6b4a';
  if(dot){
    dot.style.background = 'linear-gradient(135deg,#0f1116,' + color + ')';
  }
}

function previewProfileTheme(theme){
  state.pendingTheme = normalizeProfileTheme(theme);
  applyProfileTheme(state.pendingTheme);
  updateProfileThemeButtons();
}

// Só aplica o tema salvo depois que todas as funções e constantes do tema existem.
applyProfileTheme(state.theme);


const PROFILE_PALETTES = ['default','ocean','sunset','forest','candy'];

function normalizeProfilePalette(palette){
  return PROFILE_PALETTES.includes(palette) ? palette : 'default';
}

function applyProfilePalette(palette){
  const selected = normalizeProfilePalette(palette);

  if(selected === 'default'){
    document.documentElement.removeAttribute('data-palette');
  }else{
    document.documentElement.setAttribute('data-palette',selected);
  }
}

function updateProfilePaletteButtons(){
  const selected = normalizeProfilePalette(state.pendingPalette || state.palette);

  document.querySelectorAll('[data-profile-palette]').forEach(button=>{
    button.classList.toggle(
      'active',
      button.dataset.profilePalette === selected
    );
  });
}

function previewProfilePalette(palette){
  state.pendingPalette = normalizeProfilePalette(palette);
  applyProfilePalette(state.pendingPalette);
  updateProfilePaletteButtons();
}

applyProfilePalette(state.palette);


function clampRgb(value){
  const n=Number(value);
  return Number.isFinite(n) ? Math.max(0,Math.min(255,Math.round(n))) : 0;
}
function rgbToHex(r,g,b){
  return '#' + [r,g,b].map(v=>clampRgb(v).toString(16).padStart(2,'0')).join('');
}
function hexToRgb(hex){
  const m=/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex||'').trim());
  return m ? {r:parseInt(m[1],16),g:parseInt(m[2],16),b:parseInt(m[3],16)} : null;
}
function customThemeMix(rgb,amount,base={r:4,g:8,b:7}){
  return rgbToHex(
    base.r*(1-amount)+rgb.r*amount,
    base.g*(1-amount)+rgb.g*amount,
    base.b*(1-amount)+rgb.b*amount
  );
}
function clearCustomColorOverrides(){
  [
    '--bg0','--bg1','--bg2','--bg3','--bg4',
    '--line','--text','--muted','--low',
    '--coral','--coral2','--mint','--mintbg'
  ].forEach(name=>document.documentElement.style.removeProperty(name));
}
function applyCustomColor(hex){
  const rgb=hexToRgb(hex);
  if(!rgb){ clearCustomColorOverrides(); return; }
  const safe=rgbToHex(rgb.r,rgb.g,rgb.b);
  const lighter=rgbToHex(
    Math.min(255,rgb.r+34),
    Math.min(255,rgb.g+34),
    Math.min(255,rgb.b+34)
  );
  const root=document.documentElement.style;
  root.setProperty('--bg0',customThemeMix(rgb,.07));
  root.setProperty('--bg1',customThemeMix(rgb,.11));
  root.setProperty('--bg2',customThemeMix(rgb,.17));
  root.setProperty('--bg3',customThemeMix(rgb,.23));
  root.setProperty('--bg4',customThemeMix(rgb,.30));
  root.setProperty('--line',customThemeMix(rgb,.38));
  root.setProperty('--text','#f7fbf9');
  root.setProperty('--muted',customThemeMix(rgb,.48,{r:172,g:190,b:182}));
  root.setProperty('--low',customThemeMix(rgb,.36,{r:108,g:132,b:121}));
  root.setProperty('--coral',safe);
  root.setProperty('--coral2',lighter);
  root.setProperty('--mint',lighter);
  root.setProperty('--mintbg',customThemeMix(rgb,.22));
}
function updateCustomColorUI(hex){
  const rgb=hexToRgb(hex) || {r:255,g:107,b:74};
  const safe=rgbToHex(rgb.r,rgb.g,rgb.b);
  $('#customColorPicker').value=safe;
  $('#customColorHex').value=safe;
  $('#customColorR').value=rgb.r;
  $('#customColorG').value=rgb.g;
  $('#customColorB').value=rgb.b;
  $('#customColorPreview').style.background=safe;
}
function previewCustomColor(hex){
  const rgb=hexToRgb(hex);
  if(!rgb) return;
  const safe=rgbToHex(rgb.r,rgb.g,rgb.b);
  state.pendingCustomColor=safe;
  state.pendingTheme='custom';
  updateCustomColorUI(safe);
  applyProfileTheme('custom');
  applyCustomColor(safe);
  updateProfileThemeButtons();
}
function updateCustomColorFromRgb(){
  previewCustomColor(rgbToHex($('#customColorR').value,$('#customColorG').value,$('#customColorB').value));
}
function updateCustomColorFromHex(){
  const value=$('#customColorHex').value.trim();
  if(/^#[0-9a-f]{6}$/i.test(value)) previewCustomColor(value);
}

if(normalizeProfileTheme(state.theme)==='custom'){
  applyCustomColor(state.customColor || '#ff6b4a');
}else{
  clearCustomColorOverrides();
}

function refreshOwnProfileUI(){
  const shownName=state.displayName || state.username || 'Você';
  const shownStatus='● ' + ({
    online:'Online',
    away:'Ausente',
    busy:'Ocupado',
    invisible:'Invisível'
  }[state.status] || 'Online') + ' · Editar perfil';

  $('#userName').textContent = shownName;
  $('#userBioMini').textContent = shownStatus;

  applyAvatar(
    $('#userAvatar'),
    {username:shownName,avatar:state.avatar},
    shownName
  );

  if($('#friendsAccountName')){
    $('#friendsAccountName').textContent=shownName;
    $('#friendsAccountStatus').textContent=shownStatus;
    applyAvatar(
      $('#friendsAccountAvatar'),
      {username:shownName,avatar:state.avatar},
      shownName
    );
  }

  if($('#welcomeTitle')){
    $('#welcomeTitle').textContent = 'Bem-vindo, ' + (state.username || 'você');
  }
}


function setProfileTab(tab){
  const appearance=tab==='appearance';
  const settings=tab==='settings';
  const profile=!appearance && !settings;

  $('#profileInfoTabBtn').classList.toggle('active',profile);
  $('#profileAppearanceTabBtn').classList.toggle('active',appearance);
  $('#profileSettingsTabBtn').classList.toggle('active',settings);

  $('#profileInfoTab').classList.toggle('active',profile);
  $('#profileAppearanceTab').classList.toggle('active',appearance);
  $('#profileSettingsTab').classList.toggle('active',settings);

  if(settings){
    updateHotkeySettingsUI();
  }else{
    cancelHotkeyCapture();
  }
}

function hotkeyLabel(code){
  const map={
    Space:'Espaço',
    Escape:'Esc',
    Enter:'Enter',
    Tab:'Tab',
    Backspace:'Backspace',
    Delete:'Delete',
    ArrowUp:'↑',
    ArrowDown:'↓',
    ArrowLeft:'←',
    ArrowRight:'→',
    ShiftLeft:'Shift esquerdo',
    ShiftRight:'Shift direito',
    ControlLeft:'Ctrl esquerdo',
    ControlRight:'Ctrl direito',
    AltLeft:'Alt esquerdo',
    AltRight:'Alt direito',
    MetaLeft:'Windows',
    MetaRight:'Windows',
    CapsLock:'Caps Lock'
  };

  if(map[code]) return map[code];

  if(/^Key[A-Z]$/.test(code)){
    return code.slice(3);
  }

  if(/^Digit[0-9]$/.test(code)){
    return code.slice(5);
  }

  if(/^F([1-9]|1[0-2])$/.test(code)){
    return code;
  }

  if(/^Numpad/.test(code)){
    return code.replace('Numpad','Num ');
  }

  return code || 'Não definido';
}

function updateHotkeySettingsUI(){
  const mic=$('#micHotkeyValue');
  const deafen=$('#deafenHotkeyValue');

  if(mic){
    mic.textContent=state.micHotkey
      ? hotkeyLabel(state.micHotkey)
      : 'Não definido';

    mic.classList.toggle('listening',state.capturingHotkey==='mic');
  }

  if(deafen){
    deafen.textContent=state.deafenHotkey
      ? hotkeyLabel(state.deafenHotkey)
      : 'Não definido';

    deafen.classList.toggle('listening',state.capturingHotkey==='deafen');
  }

  const hint=$('#hotkeyCaptureHint');

  if(hint){
    hint.classList.toggle('hidden',!state.capturingHotkey);

    if(state.capturingHotkey){
      hint.textContent=
        'Pressione a tecla para ' +
        (state.capturingHotkey==='mic' ? 'mutar o microfone' : 'mutar o fone') +
        '. Esc cancela.';
    }
  }
}

function beginHotkeyCapture(type){
  state.capturingHotkey=type;
  updateHotkeySettingsUI();

  const value=type==='mic'
    ? $('#micHotkeyValue')
    : $('#deafenHotkeyValue');

  if(value){
    value.textContent='Pressione uma tecla...';
  }
}

function cancelHotkeyCapture(){
  if(!state.capturingHotkey) return;

  state.capturingHotkey=null;
  updateHotkeySettingsUI();
}

function saveHotkey(type,code){
  if(type==='mic'){
    state.micHotkey=code;
    localStorage.setItem('acord-hotkey-mic',code);

    if(state.deafenHotkey===code){
      state.deafenHotkey='';
      localStorage.removeItem('acord-hotkey-deafen');
    }
  }else{
    state.deafenHotkey=code;
    localStorage.setItem('acord-hotkey-deafen',code);

    if(state.micHotkey===code){
      state.micHotkey='';
      localStorage.removeItem('acord-hotkey-mic');
    }
  }

  state.capturingHotkey=null;
  updateHotkeySettingsUI();
  toast('Atalho salvo: ' + hotkeyLabel(code));
}

function clearHotkey(type){
  if(type==='mic'){
    state.micHotkey='';
    localStorage.removeItem('acord-hotkey-mic');
  }else{
    state.deafenHotkey='';
    localStorage.removeItem('acord-hotkey-deafen');
  }

  if(state.capturingHotkey===type){
    state.capturingHotkey=null;
  }

  updateHotkeySettingsUI();
  toast('Atalho removido');
}

function shouldIgnoreCallHotkey(event){
  const target=event.target;

  if(
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target?.isContentEditable
  ){
    return true;
  }

  return false;
}

function handleCallHotkey(event){
  if(state.capturingHotkey){
    event.preventDefault();
    event.stopPropagation();

    if(event.code==='Escape'){
      cancelHotkeyCapture();
      return;
    }

    // Não usa somente modificadores como atalho isolado.
    if([
      'ShiftLeft','ShiftRight',
      'ControlLeft','ControlRight',
      'AltLeft','AltRight',
      'MetaLeft','MetaRight'
    ].includes(event.code)){
      return;
    }

    saveHotkey(state.capturingHotkey,event.code);
    return;
  }

  if(event.repeat || shouldIgnoreCallHotkey(event)) return;
  if(!state.joinedVoiceId) return;

  if(state.micHotkey && event.code===state.micHotkey){
    event.preventDefault();
    toggleMic();
    return;
  }

  if(state.deafenHotkey && event.code===state.deafenHotkey){
    event.preventDefault();
    toggleDeafen();
  }
}



const LAB_FEATURES = [{"n": 1, "id": "compact", "name": "Layout compacto", "desc": "Reduz o espaço vertical das mensagens.", "category": "visual", "type": "toggle", "key": "compact"}, {"n": 2, "id": "largeText", "name": "Texto maior", "desc": "Aumenta o tamanho geral dos textos.", "category": "visual", "type": "toggle", "key": "large-text"}, {"n": 3, "id": "smallText", "name": "Texto menor", "desc": "Deixa a interface mais compacta visualmente.", "category": "visual", "type": "toggle", "key": "small-text"}, {"n": 4, "id": "highContrast", "name": "Alto contraste", "desc": "Aumenta contraste de texto e bordas.", "category": "visual", "type": "toggle", "key": "high-contrast"}, {"n": 5, "id": "reducedMotion", "name": "Reduzir animações", "desc": "Desativa transições e animações.", "category": "visual", "type": "toggle", "key": "reduced-motion"}, {"n": 6, "id": "grayscale", "name": "Modo cinza", "desc": "Exibe a interface em escala de cinza.", "category": "visual", "type": "toggle", "key": "grayscale"}, {"n": 7, "id": "warm", "name": "Filtro quente", "desc": "Aplica um filtro visual mais quente.", "category": "visual", "type": "toggle", "key": "warm"}, {"n": 8, "id": "blurPanels", "name": "Painéis translúcidos", "desc": "Ativa desfoque nos painéis principais.", "category": "visual", "type": "toggle", "key": "blur-panels"}, {"n": 9, "id": "hideSidebar", "name": "Ocultar barra de canais", "desc": "Esconde temporariamente a barra lateral.", "category": "visual", "type": "toggle", "key": "hide-sidebar"}, {"n": 10, "id": "hideRightbar", "name": "Ocultar membros", "desc": "Esconde a barra de membros.", "category": "visual", "type": "toggle", "key": "hide-rightbar"}, {"n": 11, "id": "fullscreen", "name": "Tela cheia", "desc": "Ativa ou sai do modo tela cheia.", "category": "visual", "type": "action", "key": "fullscreen"}, {"n": 12, "id": "focusChat", "name": "Modo foco", "desc": "Mostra apenas a área principal do chat.", "category": "visual", "type": "toggle", "key": "focus-chat"}, {"n": 13, "id": "zenCall", "name": "Modo call limpa", "desc": "Oculta painéis durante chamadas.", "category": "visual", "type": "action", "key": "zenCall"}, {"n": 14, "id": "timestamps", "name": "Hora detalhada", "desc": "Mostra a hora completa das mensagens via tooltip.", "category": "visual", "type": "action", "key": "timestamps"}, {"n": 15, "id": "showIds", "name": "Mostrar IDs", "desc": "Exibe IDs técnicos de canais.", "category": "visual", "type": "toggle", "key": "show-ids"}, {"n": 16, "id": "stickyComposer", "name": "Caixa fixa", "desc": "Mantém o compositor fixo no rodapé.", "category": "visual", "type": "toggle", "key": "sticky-composer"}, {"n": 17, "id": "wideChat", "name": "Chat largo", "desc": "Expande a área principal.", "category": "visual", "type": "toggle", "key": "wide-chat"}, {"n": 18, "id": "narrowChat", "name": "Chat estreito", "desc": "Centraliza o chat em uma largura menor.", "category": "visual", "type": "toggle", "key": "narrow-chat"}, {"n": 19, "id": "roundUi", "name": "Bordas arredondadas", "desc": "Aumenta o arredondamento dos componentes.", "category": "visual", "type": "toggle", "key": "round"}, {"n": 20, "id": "squareUi", "name": "Bordas retas", "desc": "Reduz o arredondamento da interface.", "category": "visual", "type": "toggle", "key": "square"}, {"n": 21, "id": "copyChannelId", "name": "Copiar ID do canal", "desc": "Copia o ID do canal atual.", "category": "chat", "type": "action", "key": "copyChannelId"}, {"n": 22, "id": "copyServerId", "name": "Copiar ID do servidor", "desc": "Copia o ID do servidor atual.", "category": "chat", "type": "action", "key": "copyServerId"}, {"n": 23, "id": "copyUsername", "name": "Copiar usuário", "desc": "Copia seu nome de usuário.", "category": "chat", "type": "action", "key": "copyUsername"}, {"n": 24, "id": "clearUnread", "name": "Limpar não lidas", "desc": "Marca todas as mensagens como lidas.", "category": "chat", "type": "action", "key": "clearUnread"}, {"n": 25, "id": "exportChat", "name": "Exportar chat visível", "desc": "Baixa o texto das mensagens exibidas.", "category": "chat", "type": "action", "key": "exportChat"}, {"n": 26, "id": "searchMessages", "name": "Buscar mensagens", "desc": "Procura texto nas mensagens visíveis.", "category": "chat", "type": "action", "key": "searchMessages"}, {"n": 27, "id": "jumpBottom", "name": "Ir ao fim", "desc": "Vai para a mensagem mais recente.", "category": "chat", "type": "action", "key": "jumpBottom"}, {"n": 28, "id": "jumpTop", "name": "Ir ao início", "desc": "Vai para o começo do histórico carregado.", "category": "chat", "type": "action", "key": "jumpTop"}, {"n": 29, "id": "randomEmoji", "name": "Emoji aleatório", "desc": "Insere um emoji aleatório no chat.", "category": "chat", "type": "action", "key": "randomEmoji"}, {"n": 30, "id": "quickMention", "name": "Menção rápida", "desc": "Insere @usuario no campo de mensagem.", "category": "chat", "type": "action", "key": "quickMention"}, {"n": 31, "id": "codeBlock", "name": "Bloco de código", "desc": "Cria um bloco de código no rascunho.", "category": "chat", "type": "action", "key": "codeBlock"}, {"n": 32, "id": "spoiler", "name": "Spoiler", "desc": "Envolve o texto do rascunho com ||spoiler||.", "category": "chat", "type": "action", "key": "spoiler"}, {"n": 33, "id": "upperDraft", "name": "Rascunho MAIÚSCULO", "desc": "Converte o rascunho para maiúsculas.", "category": "chat", "type": "action", "key": "upperDraft"}, {"n": 34, "id": "lowerDraft", "name": "Rascunho minúsculo", "desc": "Converte o rascunho para minúsculas.", "category": "chat", "type": "action", "key": "lowerDraft"}, {"n": 35, "id": "titleDraft", "name": "Capitalizar rascunho", "desc": "Capitaliza palavras do rascunho.", "category": "chat", "type": "action", "key": "titleDraft"}, {"n": 36, "id": "clearDraft", "name": "Limpar rascunho", "desc": "Apaga o texto não enviado.", "category": "chat", "type": "action", "key": "clearDraft"}, {"n": 37, "id": "saveDraft", "name": "Salvar rascunho", "desc": "Salva o rascunho deste canal no navegador.", "category": "chat", "type": "action", "key": "saveDraft"}, {"n": 38, "id": "restoreDraft", "name": "Restaurar rascunho", "desc": "Recupera o rascunho salvo deste canal.", "category": "chat", "type": "action", "key": "restoreDraft"}, {"n": 39, "id": "wordCount", "name": "Contar palavras", "desc": "Conta as palavras do rascunho.", "category": "chat", "type": "action", "key": "wordCount"}, {"n": 40, "id": "charCount", "name": "Contar caracteres", "desc": "Conta os caracteres do rascunho.", "category": "chat", "type": "action", "key": "charCount"}, {"n": 41, "id": "timer5", "name": "Timer 5 min", "desc": "Inicia um timer de cinco minutos.", "category": "tools", "type": "action", "key": "timer5"}, {"n": 42, "id": "timer10", "name": "Timer 10 min", "desc": "Inicia um timer de dez minutos.", "category": "tools", "type": "action", "key": "timer10"}, {"n": 43, "id": "timer25", "name": "Timer 25 min", "desc": "Inicia um timer de vinte e cinco minutos.", "category": "tools", "type": "action", "key": "timer25"}, {"n": 44, "id": "stopwatch", "name": "Cronômetro", "desc": "Inicia/para um cronômetro simples.", "category": "tools", "type": "action", "key": "stopwatch"}, {"n": 45, "id": "notes", "name": "Bloco de notas", "desc": "Abre um bloco de notas persistente.", "category": "tools", "type": "action", "key": "notes"}, {"n": 46, "id": "saveNotes", "name": "Salvar notas", "desc": "Salva as notas locais do Concorde.", "category": "tools", "type": "action", "key": "saveNotes"}, {"n": 47, "id": "exportNotes", "name": "Exportar notas", "desc": "Baixa suas notas em TXT.", "category": "tools", "type": "action", "key": "exportNotes"}, {"n": 48, "id": "randomPicker", "name": "Sorteador", "desc": "Sorteia um item de uma lista.", "category": "tools", "type": "action", "key": "randomPicker"}, {"n": 49, "id": "dice", "name": "Dado", "desc": "Rola um dado de seis lados.", "category": "tools", "type": "action", "key": "dice"}, {"n": 50, "id": "coin", "name": "Cara ou coroa", "desc": "Faz um sorteio entre cara e coroa.", "category": "tools", "type": "action", "key": "coin"}, {"n": 51, "id": "serverStats", "name": "Resumo do servidor", "desc": "Mostra números básicos do servidor.", "category": "server", "type": "action", "key": "serverStats"}, {"n": 52, "id": "memberCount", "name": "Contar membros", "desc": "Mostra o número de membros.", "category": "server", "type": "action", "key": "memberCount"}, {"n": 53, "id": "channelCount", "name": "Contar canais", "desc": "Conta canais de texto e voz.", "category": "server", "type": "action", "key": "channelCount"}, {"n": 54, "id": "roleCount", "name": "Contar cargos", "desc": "Mostra quantos cargos existem.", "category": "server", "type": "action", "key": "roleCount"}, {"n": 55, "id": "copyInvite", "name": "Copiar convite", "desc": "Copia o convite atual do servidor.", "category": "server", "type": "action", "key": "copyInvite"}, {"n": 56, "id": "copyRules", "name": "Copiar regras", "desc": "Copia as regras configuradas.", "category": "server", "type": "action", "key": "copyRules"}, {"n": 57, "id": "exportServer", "name": "Exportar resumo", "desc": "Baixa um resumo JSON do servidor.", "category": "server", "type": "action", "key": "exportServer"}, {"n": 58, "id": "findChannel", "name": "Localizar canal", "desc": "Busca um canal pelo nome.", "category": "server", "type": "action", "key": "findChannel"}, {"n": 59, "id": "collapseChannels", "name": "Recolher canais", "desc": "Oculta a árvore de canais temporariamente.", "category": "server", "type": "action", "key": "collapseChannels"}, {"n": 60, "id": "expandChannels", "name": "Expandir canais", "desc": "Mostra novamente a árvore de canais.", "category": "server", "type": "action", "key": "expandChannels"}, {"n": 61, "id": "notifyToggle", "name": "Notificações", "desc": "Liga/desliga notificações do Concorde.", "category": "system", "type": "toggle", "key": "notifications"}, {"n": 62, "id": "soundToggle", "name": "Sons", "desc": "Liga/desliga sons de avisos Labs.", "category": "system", "type": "toggle", "key": "sounds"}, {"n": 63, "id": "requestNotify", "name": "Permitir notificações", "desc": "Solicita permissão de notificação ao navegador.", "category": "system", "type": "action", "key": "requestNotify"}, {"n": 64, "id": "dnd", "name": "Não perturbe", "desc": "Silencia notificações e sons locais.", "category": "system", "type": "toggle", "key": "dnd"}, {"n": 65, "id": "autoScroll", "name": "Rolagem automática", "desc": "Mantém o chat no fim ao receber mensagens.", "category": "system", "type": "toggle", "key": "auto-scroll"}, {"n": 66, "id": "wakeLock", "name": "Manter tela ligada", "desc": "Solicita Wake Lock enquanto a aba estiver aberta.", "category": "system", "type": "action", "key": "wakeLock"}, {"n": 67, "id": "wakeRelease", "name": "Liberar tela", "desc": "Libera o Wake Lock ativo.", "category": "system", "type": "action", "key": "wakeRelease"}, {"n": 68, "id": "micStatus", "name": "Status do microfone", "desc": "Mostra o estado atual do microfone.", "category": "system", "type": "action", "key": "micStatus"}, {"n": 69, "id": "cameraStatus", "name": "Status da câmera", "desc": "Mostra o estado atual da câmera.", "category": "system", "type": "action", "key": "cameraStatus"}, {"n": 70, "id": "networkStatus", "name": "Status da internet", "desc": "Mostra informações básicas da conexão.", "category": "system", "type": "action", "key": "networkStatus"}, {"n": 71, "id": "deviceList", "name": "Listar dispositivos", "desc": "Lista microfones, câmeras e saídas disponíveis.", "category": "system", "type": "action", "key": "deviceList"}, {"n": 72, "id": "rtcStats", "name": "Estatísticas da call", "desc": "Mostra estados das conexões WebRTC.", "category": "system", "type": "action", "key": "rtcStats"}, {"n": 73, "id": "speakerTest", "name": "Testar som", "desc": "Reproduz um tom curto de teste.", "category": "system", "type": "action", "key": "speakerTest"}, {"n": 74, "id": "micTest", "name": "Testar microfone", "desc": "Abre o teste de mídia existente.", "category": "system", "type": "action", "key": "micTest"}, {"n": 75, "id": "mirrorVideo", "name": "Espelhar vídeo", "desc": "Espelha os vídeos visualmente.", "category": "system", "type": "toggle", "key": "mirror-video"}, {"n": 76, "id": "videoFill", "name": "Vídeo preencher", "desc": "Usa corte preenchendo o card.", "category": "system", "type": "toggle", "key": "video-fill"}, {"n": 77, "id": "videoContain", "name": "Vídeo inteiro", "desc": "Mostra o vídeo inteiro dentro do card.", "category": "system", "type": "toggle", "key": "video-contain"}, {"n": 78, "id": "videoGray", "name": "Vídeo em cinza", "desc": "Aplica escala de cinza aos vídeos.", "category": "system", "type": "toggle", "key": "video-gray"}, {"n": 79, "id": "videoWarm", "name": "Vídeo quente", "desc": "Aplica filtro quente aos vídeos.", "category": "system", "type": "toggle", "key": "video-warm"}, {"n": 80, "id": "hideRemoteVideo", "name": "Ocultar vídeo remoto", "desc": "Oculta visualmente vídeos de outros participantes.", "category": "system", "type": "toggle", "key": "hide-remote-video"}, {"n": 81, "id": "keyboardHints", "name": "Atalhos principais", "desc": "Mostra um resumo dos atalhos de teclado.", "category": "system", "type": "action", "key": "keyboardHints"}, {"n": 82, "id": "focusOutline", "name": "Foco visível", "desc": "Realça o elemento selecionado pelo teclado.", "category": "system", "type": "toggle", "key": "focus-outline"}, {"n": 83, "id": "letterSpacing", "name": "Espaçamento de letras", "desc": "Aumenta levemente o espaço entre letras.", "category": "system", "type": "toggle", "key": "letter-spacing"}, {"n": 84, "id": "lineHeight", "name": "Linhas espaçadas", "desc": "Aumenta a altura entre linhas.", "category": "system", "type": "toggle", "key": "line-height"}, {"n": 85, "id": "dyslexiaSpacing", "name": "Leitura espaçada", "desc": "Amplia letra, palavra e linha para facilitar leitura.", "category": "system", "type": "toggle", "key": "dyslexia-spacing"}, {"n": 86, "id": "protanopia", "name": "Filtro protanopia", "desc": "Ajuste visual aproximado de cores.", "category": "system", "type": "toggle", "key": "protanopia"}, {"n": 87, "id": "deuteranopia", "name": "Filtro deuteranopia", "desc": "Ajuste visual aproximado de cores.", "category": "system", "type": "toggle", "key": "deuteranopia"}, {"n": 88, "id": "tritanopia", "name": "Filtro tritanopia", "desc": "Ajuste visual aproximado de cores.", "category": "system", "type": "toggle", "key": "tritanopia"}, {"n": 89, "id": "resetAccess", "name": "Reset acessibilidade", "desc": "Desliga ajustes de acessibilidade do Labs.", "category": "system", "type": "action", "key": "resetAccess"}, {"n": 90, "id": "resetVisual", "name": "Reset visual", "desc": "Desliga todas as alterações visuais do Labs.", "category": "system", "type": "action", "key": "resetVisual"}, {"n": 91, "id": "backupPrefs", "name": "Backup das preferências", "desc": "Baixa as preferências Labs em JSON.", "category": "system", "type": "action", "key": "backupPrefs"}, {"n": 92, "id": "importPrefs", "name": "Importar preferências", "desc": "Importa um JSON de preferências Labs.", "category": "system", "type": "action", "key": "importPrefs"}, {"n": 93, "id": "clearCaches", "name": "Limpar caches locais", "desc": "Limpa rascunhos, notas e contadores locais.", "category": "system", "type": "action", "key": "clearCaches"}, {"n": 94, "id": "diagnostics", "name": "Diagnóstico rápido", "desc": "Mostra navegador, estado e recursos disponíveis.", "category": "system", "type": "action", "key": "diagnostics"}, {"n": 95, "id": "copyDiagnostics", "name": "Copiar diagnóstico", "desc": "Copia o diagnóstico rápido.", "category": "system", "type": "action", "key": "copyDiagnostics"}, {"n": 96, "id": "performance", "name": "Desempenho", "desc": "Mostra memória e tempo de carregamento quando disponíveis.", "category": "system", "type": "action", "key": "performance"}, {"n": 97, "id": "ping", "name": "Ping do servidor", "desc": "Mede o tempo de resposta do Socket.IO.", "category": "system", "type": "action", "key": "ping"}, {"n": 98, "id": "serverClock", "name": "Hora do servidor", "desc": "Consulta a hora do backend.", "category": "system", "type": "action", "key": "serverClock"}, {"n": 99, "id": "localClock", "name": "Hora local", "desc": "Mostra a hora local atual.", "category": "system", "type": "action", "key": "localClock"}, {"n": 100, "id": "resetLabs", "name": "Reset Concorde 100+", "desc": "Restaura todas as preferências dos 100 recursos.", "category": "system", "type": "action", "key": "resetLabs"}];

function labsPrefKey(feature){
  return feature.key || feature.id;
}

function saveLabsPrefs(){
  localStorage.setItem('concorde-labs-prefs',JSON.stringify(state.labsPrefs||{}));
  updateLabsEnabledCount();
}

function labsToggleValue(feature){
  return !!state.labsPrefs[labsPrefKey(feature)];
}

function applyLabsPreferences(){
  for(const feature of LAB_FEATURES){
    if(feature.type!=='toggle') continue;
    const key=labsPrefKey(feature);
    document.body.dataset['lab'+key.split('-').map((part,index)=>index?part.charAt(0).toUpperCase()+part.slice(1):part).join('')]=
      state.labsPrefs[key] ? '1' : '0';
  }
  updateLabsEnabledCount();
}

function updateLabsEnabledCount(){
  const count=Object.values(state.labsPrefs||{}).filter(Boolean).length;
  const el=$('#labsEnabledCount');if(el)el.textContent=String(count);
}

function setLabsStatus(message,type=''){
  const el=$('#labsActionStatus');
  if(!el) return;
  el.textContent=String(message||'');
  el.classList.remove('ok','error');
  if(type) el.classList.add(type);
}

function labsConflictKeys(key){
  const groups=[
    ['large-text','small-text'],
    ['wide-chat','narrow-chat'],
    ['round','square'],
    ['video-fill','video-contain'],
    ['protanopia','deuteranopia','tritanopia']
  ];
  return groups.find(group=>group.includes(key))||[];
}

function toggleLabsFeature(feature){
  const key=labsPrefKey(feature);
  const next=!state.labsPrefs[key];

  if(next){
    for(const other of labsConflictKeys(key)){
      if(other!==key) state.labsPrefs[other]=false;
    }
  }

  state.labsPrefs[key]=next;
  saveLabsPrefs();
  applyLabsPreferences();

  setLabsStatus(
    feature.name+': '+(next?'ativado':'desativado'),
    'ok'
  );

  renderLabsFeatures();
}

async function runLabActionSafe(feature){
  if(!feature) return;

  setLabsStatus('Executando: '+feature.name+'...');

  try{
    await runLabAction(feature.key||feature.id);

    if(!$('#labsActionStatus')?.classList.contains('error')){
      setLabsStatus(feature.name+': concluído.','ok');
    }
  }catch(error){
    console.error('Erro no Concorde 100+ ('+feature.name+'):',error);
    setLabsStatus(
      feature.name+': '+(error?.message||'não foi possível executar'),
      'error'
    );
    showLabsOutput(
      'Erro ao executar "'+feature.name+'".\n'+
      String(error?.message||error||'Erro desconhecido')
    );
  }
}

function handleLabsGridClick(event){
  const button=event.target.closest('button[data-lab-id]');
  if(!button) return;

  event.preventDefault();
  event.stopPropagation();

  const feature=LAB_FEATURES.find(item=>item.id===button.dataset.labId);
  if(!feature){
    setLabsStatus('Recurso não encontrado.','error');
    return;
  }

  if(feature.type==='toggle'){
    toggleLabsFeature(feature);
  }else{
    runLabActionSafe(feature);
  }
}

function renderLabsFeatures(){
  const grid=$('#labsFeatureGrid');if(!grid)return;

  const query=String($('#labsSearch')?.value||'').trim().toLowerCase();
  const category=$('#labsCategory')?.value||'all';
  grid.innerHTML='';

  const visible=LAB_FEATURES
    .filter(feature=>(category==='all'||feature.category===category))
    .filter(feature=>!query || (feature.name+' '+feature.desc+' '+feature.n).toLowerCase().includes(query));

  for(const feature of visible){
    const card=document.createElement('div');
    card.className='labsCard';

    const meta=document.createElement('div');
    const title=document.createElement('strong');
    title.textContent=feature.n+'. '+feature.name;

    const desc=document.createElement('p');
    desc.textContent=feature.desc;
    meta.append(title,desc);

    const button=document.createElement('button');
    button.type='button';
    button.dataset.labId=feature.id;

    if(feature.type==='toggle'){
      const active=labsToggleValue(feature);
      button.textContent=active?'Desativar':'Ativar';
      button.classList.toggle('active',active);
      button.setAttribute('aria-pressed',active?'true':'false');
    }else{
      button.textContent='Usar';
    }

    card.append(meta,button);
    grid.appendChild(card);
  }

  updateLabsEnabledCount();

  if(!visible.length){
    const empty=document.createElement('div');
    empty.className='megaItem';
    empty.textContent='Nenhum recurso encontrado.';
    grid.appendChild(empty);
  }
}

function showLabsOutput(value){
  const box=$('#labsOutput');if(!box)return;
  box.textContent=String(value||'');
  box.classList.remove('hidden');
  setLabsStatus('Resultado disponível abaixo.','ok');
  box.scrollIntoView({block:'nearest',behavior:'smooth'});
}

function downloadLabsText(filename,text,type='text/plain'){
  const blob=new Blob([text],{type});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download=filename;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),15000);
}

async function copyLabs(value){
  const text=String(value??'');
  if(!text) throw new Error('Não há conteúdo para copiar');

  try{
    await navigator.clipboard.writeText(text);
    toast('Copiado');
  }catch{
    showLabsOutput(text);
  }
}

function currentChatText(){
  return [...document.querySelectorAll('#messages .message')].map(row=>row.innerText.trim()).filter(Boolean).join('\n\n');
}

function draftKey(){
  return 'concorde-draft-'+String(state.serverId||'hub')+'-'+String(state.textChannelId||'none');
}

function startLabTimer(minutes){
  const end=Date.now()+minutes*60000;
  localStorage.setItem('concorde-lab-timer-end',String(end));
  toast('Timer de '+minutes+' min iniciado');
  showLabsOutput('Timer iniciado: '+minutes+' minutos.');
  setTimeout(()=>{playCallCue('join');toast('Timer concluído')},minutes*60000);
}

function labsDiagnosticText(){
  return [
    'Acord v6.4.2',
    'Usuário: '+(state.username||''),
    'Servidor: '+(currentServer()?.name||'nenhum'),
    'Canal: '+(currentText()?.name||'nenhum'),
    'Online: '+navigator.onLine,
    'Socket: '+(socket.connected?'conectado':'desconectado'),
    'Call: '+(state.joinedVoiceId?'ativa':'inativa'),
    'Câmera: '+(state.cameraTrack?.readyState||'inativa'),
    'Microfone: '+(state.localStream?.getAudioTracks()?.[0]?.readyState||'inativo'),
    'WebRTC peers: '+state.peers.size,
    'Service Worker: '+('serviceWorker' in navigator),
    'Wake Lock: '+('wakeLock' in navigator),
    'SpeechRecognition: '+!!(window.SpeechRecognition||window.webkitSpeechRecognition)
  ].join('\n');
}

async function runLabAction(action){
  const input=$('#messageInput');
  const server=currentServer();
  const channel=currentText();

  switch(action){
    case 'fullscreen':
      if(!document.fullscreenElement){
        if(!document.documentElement.requestFullscreen) throw new Error('Tela cheia não é suportada neste navegador');
        await document.documentElement.requestFullscreen();
      }else{
        if(document.exitFullscreen) await document.exitFullscreen();
      }
      break;
    case 'zenCall':
      state.labsPrefs['hide-sidebar']=!state.labsPrefs['hide-sidebar'];
      state.labsPrefs['hide-rightbar']=state.labsPrefs['hide-sidebar'];
      saveLabsPrefs();applyLabsPreferences();renderLabsFeatures();break;
    case 'timestamps':
      document.querySelectorAll('#messages .message').forEach(row=>{if(!row.title)row.title='Mensagem exibida no histórico atual'});
      toast('Tooltips ativados nas mensagens visíveis');break;
    case 'copyChannelId': if(!state.textChannelId){throw new Error('Selecione um canal de texto primeiro')} await copyLabs(state.textChannelId);break;
    case 'copyServerId': if(!state.serverId){throw new Error('Selecione um servidor primeiro')} await copyLabs(state.serverId);break;
    case 'copyUsername': if(!state.username){throw new Error('Entre na sua conta primeiro')} await copyLabs(state.username);break;
    case 'clearUnread': clearAllUnread();break;
    case 'exportChat': downloadLabsText('concorde-chat-'+Date.now()+'.txt',currentChatText());break;
    case 'searchMessages':{
      const q=await appDialog({title:'Buscar mensagens',message:'Digite o texto que deseja localizar nas mensagens visíveis.',value:'',confirmText:'Buscar'});if(!q)break;
      const rows=[...document.querySelectorAll('#messages .message')];
      let count=0;rows.forEach(r=>{const hit=r.innerText.toLowerCase().includes(q.toLowerCase());r.style.outline=hit?'2px solid var(--coral)':'';if(hit)count++});
      showLabsOutput(count+' resultado(s) para "'+q+'"');break;
    }
    case 'jumpBottom': $('#messages')?.scrollTo({top:$('#messages').scrollHeight,behavior:'smooth'});break;
    case 'jumpTop': $('#messages')?.scrollTo({top:0,behavior:'smooth'});break;
    case 'randomEmoji':{
      const list=['😀','😂','🔥','❤️','🎉','👍','😎','🤝','🚀','💡','⚡','✅'];
      if(input){input.value+=list[Math.floor(Math.random()*list.length)];input.focus()}break;
    }
    case 'quickMention':{
      const name=await appDialog({title:'Mencionar usuário',message:'Digite o nome do usuário.',value:'',confirmText:'Inserir'});if(name&&input){input.value+=' @'+name.replace(/^@/,'');input.focus()}break;
    }
    case 'codeBlock': if(input){input.value=String.fromCharCode(96,96,96)+'\\n'+input.value+'\\n'+String.fromCharCode(96,96,96);input.focus()}break;
    case 'spoiler': if(input){input.value='||'+input.value+'||';input.focus()}break;
    case 'upperDraft': if(input)input.value=input.value.toUpperCase();break;
    case 'lowerDraft': if(input)input.value=input.value.toLowerCase();break;
    case 'titleDraft': if(input)input.value=input.value.replace(/\b\w/g,c=>c.toUpperCase());break;
    case 'clearDraft': if(input)input.value='';break;
    case 'saveDraft': if(input){localStorage.setItem(draftKey(),input.value);toast('Rascunho salvo')}break;
    case 'restoreDraft': if(input){input.value=localStorage.getItem(draftKey())||'';input.focus()}break;
    case 'wordCount': showLabsOutput('Palavras: '+String(input?.value||'').trim().split(/\s+/).filter(Boolean).length);break;
    case 'charCount': showLabsOutput('Caracteres: '+String(input?.value||'').length);break;
    case 'timer5': startLabTimer(5);break;
    case 'timer10': startLabTimer(10);break;
    case 'timer25': startLabTimer(25);break;
    case 'stopwatch':
      if(!state.labsStopwatchStarted){
        state.labsStopwatchStarted=Date.now();toast('Cronômetro iniciado');
      }else{
        const seconds=Math.round((Date.now()-state.labsStopwatchStarted)/1000);
        state.labsStopwatchStarted=0;showLabsOutput('Cronômetro: '+seconds+' segundos');
      }break;
    case 'notes':{
      const value=await appDialog({title:'Bloco de notas',message:'Edite suas notas locais.',value:state.labsNotes||'',confirmText:'Salvar'});
      if(value!==null){state.labsNotes=value;localStorage.setItem('concorde-labs-notes',value);toast('Notas salvas')}break;
    }
    case 'saveNotes': localStorage.setItem('concorde-labs-notes',state.labsNotes||'');toast('Notas salvas');break;
    case 'exportNotes': downloadLabsText('concorde-notas.txt',state.labsNotes||'');break;
    case 'randomPicker':{
      const raw=await appDialog({title:'Sorteio',message:'Digite os itens separados por vírgula.',value:'A, B, C',confirmText:'Sortear'});if(!raw)break;
      const items=raw.split(',').map(v=>v.trim()).filter(Boolean);
      showLabsOutput(items.length?'Sorteado: '+items[Math.floor(Math.random()*items.length)]:'Nenhum item');break;
    }
    case 'dice': showLabsOutput('🎲 '+(1+Math.floor(Math.random()*6)));break;
    case 'coin': showLabsOutput(Math.random()<.5?'🪙 Cara':'🪙 Coroa');break;
    case 'serverStats':
      showLabsOutput(server?[
        'Servidor: '+server.name,
        'Membros: '+(server.memberProfiles||[]).length,
        'Textos: '+(server.textChannels||[]).length,
        'Voz: '+(server.voiceChannels||[]).length,
        'Cargos: '+(server.roles||[]).length
      ].join('\n'):'Nenhum servidor selecionado');break;
    case 'memberCount': showLabsOutput('Membros: '+(server?.memberProfiles?.length||0));break;
    case 'channelCount': showLabsOutput('Canais: '+((server?.textChannels?.length||0)+(server?.voiceChannels?.length||0)));break;
    case 'roleCount': showLabsOutput('Cargos: '+(server?.roles?.length||0));break;
    case 'copyInvite':
      if(server?.inviteToken)copyLabs(location.origin+'/invite/'+server.inviteToken);else toast('Sem convite');break;
    case 'copyRules': if(!server){throw new Error('Selecione um servidor primeiro')} await copyLabs(server.rules||'');break;
    case 'exportServer':
      if(server)downloadLabsText('concorde-servidor-'+Date.now()+'.json',JSON.stringify(server,null,2),'application/json');break;
    case 'findChannel':{
      const q=await appDialog({title:'Encontrar canal',message:'Digite parte do nome do canal.',value:'',confirmText:'Buscar'});if(!q||!server)break;
      const found=[...(server.textChannels||[]),...(server.voiceChannels||[])].filter(c=>c.name.toLowerCase().includes(q.toLowerCase()));
      showLabsOutput(found.length?found.map(c=>c.name+' · '+c.id).join('\n'):'Nenhum canal encontrado');break;
    }
    case 'collapseChannels': if($('#channelTree'))$('#channelTree').style.display='none';break;
    case 'expandChannels': if($('#channelTree'))$('#channelTree').style.display='';break;
    case 'requestNotify':
      if(!('Notification' in window)) throw new Error('Notificações não são suportadas neste navegador');
      await requestNotifications();
      toast(Notification.permission==='granted'?'Notificações permitidas':'Permissão não concedida');
      break;
    case 'wakeLock':
      try{state.labsWakeLock=await navigator.wakeLock?.request('screen');toast(state.labsWakeLock?'Tela mantida ligada':'Wake Lock indisponível')}catch{toast('Wake Lock indisponível')}break;
    case 'wakeRelease':
      try{await state.labsWakeLock?.release();state.labsWakeLock=null;toast('Wake Lock liberado')}catch{}break;
    case 'micStatus':{
      const t=state.localStream?.getAudioTracks()?.[0];showLabsOutput(t?'Microfone: '+t.readyState+' · '+(t.enabled?'ativo':'mutado'):'Microfone inativo');break;
    }
    case 'cameraStatus':{
      const t=state.cameraTrack;showLabsOutput(t?'Câmera: '+t.readyState+' · '+(t.enabled?'ativa':'desativada'):'Câmera inativa');break;
    }
    case 'networkStatus':{
      const c=navigator.connection||navigator.mozConnection||navigator.webkitConnection;
      showLabsOutput('Online: '+navigator.onLine+(c?'\nTipo: '+(c.effectiveType||c.type||'')+'\nDownlink: '+(c.downlink||'?')+' Mbps':''));
      break;
    }
    case 'deviceList':{
      try{
        const devices=await navigator.mediaDevices.enumerateDevices();
        showLabsOutput(devices.map((d,i)=>(i+1)+'. '+d.kind+' · '+(d.label||'sem nome')).join('\n')||'Nenhum dispositivo');
      }catch{showLabsOutput('Não foi possível listar dispositivos')}break;
    }
    case 'rtcStats': await updateMegaConnectionInfo();showLabsOutput($('#megaConnectionInfo')?.textContent||'Sem dados');break;
    case 'speakerTest': playCallCue('join');toast('Som de teste reproduzido');break;
    case 'micTest': await testMedia();break;
    case 'keyboardHints': showLabsOutput('Enter: enviar mensagem\nShift+Enter: não envia\nEsc: cancelar captura de atalho\nAtalhos de microfone/fone: configure em Perfil > Configurações');break;
    case 'resetAccess':
      ['focus-outline','letter-spacing','line-height','dyslexia-spacing','protanopia','deuteranopia','tritanopia'].forEach(k=>state.labsPrefs[k]=false);
      saveLabsPrefs();applyLabsPreferences();renderLabsFeatures();break;
    case 'resetVisual':
      ['compact','large-text','small-text','high-contrast','reduced-motion','grayscale','warm','blur-panels','hide-sidebar','hide-rightbar','focus-chat','sticky-composer','wide-chat','narrow-chat','round','square'].forEach(k=>state.labsPrefs[k]=false);
      saveLabsPrefs();applyLabsPreferences();renderLabsFeatures();break;
    case 'backupPrefs': downloadLabsText('concorde-labs-backup.json',JSON.stringify(state.labsPrefs,null,2),'application/json');break;
    case 'importPrefs':{
      const raw=await appDialog({title:'Importar preferências',message:'Cole o JSON das preferências.',value:'',confirmText:'Importar'});if(!raw)break;
      try{state.labsPrefs=JSON.parse(raw)||{};saveLabsPrefs();applyLabsPreferences();renderLabsFeatures();toast('Preferências importadas')}catch{toast('JSON inválido')}break;
    }
    case 'clearCaches':
      Object.keys(localStorage).filter(k=>k.startsWith('concorde-draft-')||k==='concorde-labs-notes'||k==='acord-unread-counts').forEach(k=>localStorage.removeItem(k));
      state.labsNotes='';state.unreadCounts={};toast('Caches locais limpos');break;
    case 'diagnostics': showLabsOutput(labsDiagnosticText());break;
    case 'copyDiagnostics': copyLabs(labsDiagnosticText());break;
    case 'performance':{
      const nav=performance.getEntriesByType('navigation')?.[0];
      const mem=performance.memory;
      showLabsOutput([
        'Carregamento: '+(nav?Math.round(nav.loadEventEnd-nav.startTime)+' ms':'indisponível'),
        'Memória usada: '+(mem?Math.round(mem.usedJSHeapSize/1048576)+' MB':'indisponível'),
        'DOM: '+document.getElementsByTagName('*').length+' elementos'
      ].join('\n'));break;
    }
    case 'ping':{
      const start=performance.now();
      socket.timeout(3000).emit('labs-ping',{at:Date.now()},(err,response)=>{
        showLabsOutput(err?'Ping falhou':'Ping: '+Math.round(performance.now()-start)+' ms\nServidor: '+new Date(response.serverTime).toLocaleTimeString());
      });break;
    }
    case 'serverClock':
      socket.timeout(3000).emit('labs-ping',{at:Date.now()},(err,response)=>showLabsOutput(err?'Servidor indisponível':'Hora do servidor: '+new Date(response.serverTime).toLocaleString()));break;
    case 'localClock': showLabsOutput('Hora local: '+new Date().toLocaleString());break;
    case 'resetLabs':
      if(await appDialog({title:'Resetar preferências',message:'Restaurar todas as preferências do Concorde 100+?',confirmText:'Resetar',danger:true})){
        state.labsPrefs={};
        if(!Object.prototype.hasOwnProperty.call(state.labsPrefs,'notifications')) state.labsPrefs.notifications=true;
        if(!Object.prototype.hasOwnProperty.call(state.labsPrefs,'sounds')) state.labsPrefs.sounds=true;
        if(!Object.prototype.hasOwnProperty.call(state.labsPrefs,'auto-scroll')) state.labsPrefs['auto-scroll']=true;
        saveLabsPrefs();
        applyLabsPreferences();
        renderLabsFeatures();
        toast('Concorde 100+ resetado');
      }
      break;
    default:
      throw new Error('Ação não implementada: '+action);
  }
}

function initializeLabsAfterStartup(){
  if(!Object.prototype.hasOwnProperty.call(state.labsPrefs,'notifications')) state.labsPrefs.notifications=true;
  if(!Object.prototype.hasOwnProperty.call(state.labsPrefs,'sounds')) state.labsPrefs.sounds=true;
  if(!Object.prototype.hasOwnProperty.call(state.labsPrefs,'auto-scroll')) state.labsPrefs['auto-scroll']=true;
  saveLabsPrefs();
  applyLabsPreferences();
}

initializeLabsAfterStartup();


const CREATIVE_FEATURES = [{"n": 1, "id": "tempRoom", "name": "Sala temporária automática", "desc": "Cria uma sala de voz temporária vinculada ao usuário.", "category": "call"}, {"n": 2, "id": "availableMode", "name": "Modo Estou disponível", "desc": "Publica disponibilidade para conversar, jogar ou estudar.", "category": "social"}, {"n": 3, "id": "peopleMatch", "name": "Match de pessoas do servidor", "desc": "Sugere membros com interesses semelhantes.", "category": "social"}, {"n": 4, "id": "interestGroups", "name": "Grupos automáticos por interesse", "desc": "Agrupa membros por interesses declarados.", "category": "social"}, {"n": 5, "id": "missedSummary", "name": "Resumo do que perdi", "desc": "Resume atividade recente do servidor.", "category": "chat"}, {"n": 6, "id": "callSummary", "name": "Resumo de call", "desc": "Registra decisões, links e tarefas de uma call.", "category": "call"}, {"n": 7, "id": "sharedCalendar", "name": "Agenda compartilhada", "desc": "Adiciona compromissos ao calendário do servidor.", "category": "productivity"}, {"n": 8, "id": "eventRsvp", "name": "Confirmação em eventos", "desc": "Registra Vou, Talvez ou Não vou.", "category": "productivity"}, {"n": 9, "id": "eventLobby", "name": "Sala de espera de eventos", "desc": "Cria uma sala de espera vinculada ao próximo evento.", "category": "call"}, {"n": 10, "id": "serverMissions", "name": "Missões do servidor", "desc": "Cria desafios de participação úteis.", "category": "server"}, {"n": 11, "id": "helpReputation", "name": "Reputação por ajuda", "desc": "Registra agradecimentos e ajuda entre membros.", "category": "social"}, {"n": 12, "id": "contributionProfile", "name": "Perfil de contribuição", "desc": "Mostra áreas em que um membro ajuda mais.", "category": "social"}, {"n": 13, "id": "dailyQuestion", "name": "Pergunta do dia", "desc": "Publica uma pergunta diária no servidor.", "category": "chat"}, {"n": 14, "id": "achievementWall", "name": "Mural de conquistas", "desc": "Registra conquistas reais dos membros.", "category": "social"}, {"n": 15, "id": "studyMode", "name": "Modo estudo em grupo", "desc": "Inicia sessão sincronizada de foco e pausa.", "category": "productivity"}, {"n": 16, "id": "speakerQueue", "name": "Fila para falar", "desc": "Cria uma fila organizada para calls grandes.", "category": "call"}, {"n": 17, "id": "mutedSpeechWarning", "name": "Aviso falando no mudo", "desc": "Ativa detecção local de voz com microfone mutado.", "category": "call"}, {"n": 18, "id": "screenShareWarning", "name": "Aviso de tela compartilhada", "desc": "Mostra alerta persistente enquanto a tela é compartilhada.", "category": "call"}, {"n": 19, "id": "preCallPreview", "name": "Prévia antes de entrar", "desc": "Abre teste de câmera e microfone.", "category": "call"}, {"n": 20, "id": "silentJoin", "name": "Entrada silenciosa", "desc": "Alterna sons de entrada na call.", "category": "call"}, {"n": 21, "id": "miniCall", "name": "Call em mini-player", "desc": "Ativa mini visão da call durante navegação.", "category": "call"}, {"n": 22, "id": "pipVideo", "name": "Picture-in-Picture", "desc": "Abre vídeo local/remoto em Picture-in-Picture.", "category": "call"}, {"n": 23, "id": "autoCallLayout", "name": "Layout automático de call", "desc": "Seleciona layout com foco em quem fala ou compartilha.", "category": "call"}, {"n": 24, "id": "breakoutRooms", "name": "Salas paralelas", "desc": "Cria salas de voz para pequenos grupos.", "category": "call"}, {"n": 25, "id": "walkieTalkie", "name": "Walkie-talkie", "desc": "Ativa push-to-talk rapidamente.", "category": "call"}, {"n": 26, "id": "spatialAudio", "name": "Áudio espacial simples", "desc": "Distribui participantes entre esquerda e direita.", "category": "call"}, {"n": 27, "id": "sharedAmbience", "name": "Som ambiente compartilhado", "desc": "Escolhe chuva, cafeteria, floresta ou ruído branco.", "category": "call"}, {"n": 28, "id": "collabPlaylist", "name": "Playlist colaborativa", "desc": "Adiciona links de música à fila do servidor.", "category": "media"}, {"n": 29, "id": "watchVote", "name": "Watch Party com votação", "desc": "Vota no próximo vídeo a assistir.", "category": "media"}, {"n": 30, "id": "cinemaMode", "name": "Modo cinema", "desc": "Escurece a interface e foca no conteúdo.", "category": "media"}, {"n": 31, "id": "scheduledMessage", "name": "Mensagem programada", "desc": "Agenda uma mensagem para envio futuro.", "category": "chat"}, {"n": 32, "id": "expiringMessage", "name": "Mensagem que expira", "desc": "Envia mensagem com tempo de expiração.", "category": "chat"}, {"n": 33, "id": "importantAck", "name": "Mensagem importante", "desc": "Cria aviso que exige confirmação de leitura.", "category": "chat"}, {"n": 34, "id": "anonymousBox", "name": "Caixa de sugestões anônimas", "desc": "Envia uma sugestão sem exibir o autor.", "category": "chat"}, {"n": 35, "id": "anonymousQuestions", "name": "Perguntas anônimas em call", "desc": "Envia perguntas anônimas para o servidor.", "category": "call"}, {"n": 36, "id": "quickThread", "name": "Thread rápida", "desc": "Cria uma conversa vinculada a um tema.", "category": "chat"}, {"n": 37, "id": "personalInbox", "name": "Inbox pessoal", "desc": "Reúne menções, respostas e itens importantes.", "category": "chat"}, {"n": 38, "id": "readLater", "name": "Ler depois", "desc": "Salva uma anotação ou mensagem para consultar depois.", "category": "chat"}, {"n": 39, "id": "savedFolders", "name": "Pastas de mensagens salvas", "desc": "Organiza itens salvos por pasta.", "category": "chat"}, {"n": 40, "id": "globalSearch", "name": "Pesquisa global inteligente", "desc": "Busca pessoas, canais, eventos e itens do servidor.", "category": "chat"}, {"n": 41, "id": "naturalCommands", "name": "Comandos naturais", "desc": "Interpreta comandos simples em linguagem natural.", "category": "productivity"}, {"n": 42, "id": "favorites", "name": "Favoritos", "desc": "Salva servidores, canais ou pessoas favoritas.", "category": "social"}, {"n": 43, "id": "recentHistory", "name": "Histórico recente", "desc": "Mostra as últimas áreas acessadas.", "category": "social"}, {"n": 44, "id": "commandPalette", "name": "Central Ctrl+K", "desc": "Abre uma paleta de navegação e ações.", "category": "productivity"}, {"n": 45, "id": "customDashboard", "name": "Painel inicial personalizado", "desc": "Escolhe widgets para o painel pessoal.", "category": "productivity"}, {"n": 46, "id": "serverHome", "name": "Página inicial do servidor", "desc": "Monta uma home com regras, eventos e destaques.", "category": "server"}, {"n": 47, "id": "smartOnboarding", "name": "Onboarding inteligente", "desc": "Registra interesses e recomenda canais/cargos.", "category": "server"}, {"n": 48, "id": "selfRoles", "name": "Cargos autoescolhidos", "desc": "Permite ao membro escolher cargos autorizados.", "category": "server"}, {"n": 49, "id": "faqChannel", "name": "FAQ do servidor", "desc": "Cria e consulta perguntas frequentes.", "category": "server"}, {"n": 50, "id": "serverWiki", "name": "Wiki interna", "desc": "Cria páginas permanentes dentro do servidor.", "category": "server"}, {"n": 51, "id": "kanban", "name": "Quadro Kanban", "desc": "Gerencia cartões em A fazer, Fazendo e Concluído.", "category": "productivity"}, {"n": 52, "id": "sharedTasks", "name": "Lista de tarefas compartilhada", "desc": "Cria tarefas e permite assumir responsáveis.", "category": "productivity"}, {"n": 53, "id": "eventChecklist", "name": "Checklist de evento", "desc": "Cria checklist colaborativo para eventos.", "category": "productivity"}, {"n": 54, "id": "groupDecisions", "name": "Decisões do grupo", "desc": "Registra decisões e participantes.", "category": "productivity"}, {"n": 55, "id": "eliminationPoll", "name": "Enquete eliminatória", "desc": "Cria votação em rodadas com eliminação.", "category": "productivity"}, {"n": 56, "id": "onlineDraw", "name": "Sorteio entre membros online", "desc": "Sorteia alguém entre usuários disponíveis.", "category": "social"}, {"n": 57, "id": "internalForms", "name": "Formulários internos", "desc": "Cria formulário simples para inscrições.", "category": "server"}, {"n": 58, "id": "usefulRanking", "name": "Ranking de participação útil", "desc": "Mostra ajuda, tarefas e contribuições registradas.", "category": "social"}, {"n": 59, "id": "customAchievements", "name": "Conquistas personalizadas", "desc": "Cria conquistas definidas pelo servidor.", "category": "server"}, {"n": 60, "id": "memberCard", "name": "Cartão de apresentação", "desc": "Cria cartão com bio, interesses e links.", "category": "social"}, {"n": 61, "id": "scheduleCompatibility", "name": "Compatibilidade de horários", "desc": "Compara faixas de disponibilidade dos membros.", "category": "social"}, {"n": 62, "id": "quickCallInvite", "name": "Chamar para conversar", "desc": "Envia convite rápido para call.", "category": "call"}, {"n": 63, "id": "messageOnlyStatus", "name": "Só mensagem", "desc": "Marca que o usuário prefere mensagem a call.", "category": "social"}, {"n": 64, "id": "timedStatus", "name": "Status com duração", "desc": "Define status temporário com expiração.", "category": "social"}, {"n": 65, "id": "serverInvisible", "name": "Invisível por servidor", "desc": "Oculta sua presença naquele servidor na camada criativa.", "category": "social"}, {"n": 66, "id": "blockUser", "name": "Bloquear usuário", "desc": "Mantém lista pessoal de usuários bloqueados.", "category": "safety"}, {"n": 67, "id": "personalWordFilter", "name": "Filtro de palavras pessoal", "desc": "Oculta termos escolhidos nas mensagens visíveis.", "category": "safety"}, {"n": 68, "id": "adaptiveAntiSpam", "name": "Anti-spam adaptativo", "desc": "Configura limites de repetição/flood.", "category": "safety"}, {"n": 69, "id": "smartSlowMode", "name": "Modo lento inteligente", "desc": "Configura intervalo mínimo entre mensagens.", "category": "safety"}, {"n": 70, "id": "raidProtection", "name": "Proteção contra raid", "desc": "Ativa proteção reforçada para novas entradas.", "category": "safety"}, {"n": 71, "id": "newMemberQuarantine", "name": "Quarentena de novos membros", "desc": "Define período de acesso restrito.", "category": "safety"}, {"n": 72, "id": "everyoneConfirm", "name": "Confirmação de @everyone", "desc": "Exige confirmação extra antes de menções amplas.", "category": "safety"}, {"n": 73, "id": "serverHealth", "name": "Saúde do servidor", "desc": "Exibe atividade, canais e sinais de manutenção.", "category": "server"}, {"n": 74, "id": "cleanupSuggestions", "name": "Sugestões de limpeza", "desc": "Lista canais pouco usados ou vazios.", "category": "server"}, {"n": 75, "id": "archiveChannels", "name": "Arquivar canais", "desc": "Arquiva um canal sem excluir seus metadados.", "category": "server"}, {"n": 76, "id": "recycleBin", "name": "Lixeira de canais", "desc": "Guarda canais removidos para restauração.", "category": "server"}, {"n": 77, "id": "configHistory", "name": "Histórico de configurações", "desc": "Exibe ações administrativas registradas.", "category": "server"}, {"n": 78, "id": "duplicateStructure", "name": "Duplicar canal/categoria", "desc": "Duplica a estrutura selecionada.", "category": "server"}, {"n": 79, "id": "serverTemplates", "name": "Templates de servidor", "desc": "Gera estrutura para estudos, gaming ou comunidade.", "category": "server"}, {"n": 80, "id": "cloneServer", "name": "Clonar estrutura", "desc": "Cria um novo servidor com estrutura semelhante.", "category": "server"}, {"n": 81, "id": "visitorMode", "name": "Modo visitante", "desc": "Configura acesso público limitado na camada criativa.", "category": "server"}, {"n": 82, "id": "perServerProfile", "name": "Perfil diferente por servidor", "desc": "Salva nome, bio e avatar específicos do servidor.", "category": "social"}, {"n": 83, "id": "timedNickname", "name": "Apelido com validade", "desc": "Define apelido temporário por servidor.", "category": "social"}, {"n": 84, "id": "photoWall", "name": "Mural de fotos", "desc": "Adiciona imagens por URL ao mural.", "category": "media"}, {"n": 85, "id": "collabAlbum", "name": "Álbum colaborativo", "desc": "Cria álbuns e adiciona imagens.", "category": "media"}, {"n": 86, "id": "fileGallery", "name": "Galeria de arquivos", "desc": "Organiza links de arquivos compartilhados.", "category": "media"}, {"n": 87, "id": "audioPlayer", "name": "Player de áudio integrado", "desc": "Toca um link direto de áudio.", "category": "media"}, {"n": 88, "id": "pdfViewer", "name": "Visualizador de PDF", "desc": "Abre PDF em visualizador interno do navegador.", "category": "media"}, {"n": 89, "id": "fileNotes", "name": "Notas em arquivos", "desc": "Adiciona comentários vinculados a arquivos.", "category": "media"}, {"n": 90, "id": "versionCompare", "name": "Comparar versões", "desc": "Compara dois textos ou descrições de versão.", "category": "media"}, {"n": 91, "id": "customReactions", "name": "Reações personalizadas", "desc": "Cria reações personalizadas do servidor.", "category": "media"}, {"n": 92, "id": "serverEmojiPacks", "name": "Pacotes de emojis", "desc": "Registra emojis personalizados por URL.", "category": "media"}, {"n": 93, "id": "stickersApproval", "name": "Stickers com aprovação", "desc": "Envia stickers para fila de aprovação.", "category": "media"}, {"n": 94, "id": "temporaryAvatar", "name": "Avatar temporário", "desc": "Define avatar local temporário com duração.", "category": "social"}, {"n": 95, "id": "serverTheme", "name": "Tema por servidor", "desc": "Salva cor e fundo preferidos para o servidor.", "category": "media"}, {"n": 96, "id": "communityThemes", "name": "Temas comunitários", "desc": "Exporta/importa tema compartilhável.", "category": "media"}, {"n": 97, "id": "healthyMode", "name": "Modo saudável", "desc": "Ativa lembretes após muito tempo em call.", "category": "productivity"}, {"n": 98, "id": "usageSummary", "name": "Resumo de tempo de uso", "desc": "Mostra tempo aproximado da sessão atual.", "category": "productivity"}, {"n": 99, "id": "concentrationMode", "name": "Modo concentração", "desc": "Silencia notificações exceto itens prioritários.", "category": "productivity"}, {"n": 100, "id": "todayHub", "name": "Hoje no Concorde", "desc": "Mostra eventos, disponibilidade, tarefas e destaques do dia.", "category": "productivity"}];

function saveCreativeLocal(){
  try{
    localStorage.setItem('concorde-creative-local',JSON.stringify(state.creativeLocal||{}));
  }catch{}
}

function setCreativeStatus(message,type=''){
  const el=$('#creativeStatus');if(!el)return;
  el.textContent=String(message||'');
  el.classList.remove('ok','error');
  if(type)el.classList.add(type);
}

function showCreative(value){
  const panel=$('#creativePanel');if(!panel)return;
  panel.textContent=typeof value==='string'?value:JSON.stringify(value,null,2);
  panel.classList.remove('hidden');
  panel.scrollIntoView({block:'nearest',behavior:'smooth'});
  setCreativeStatus('Resultado disponível abaixo.','ok');
}

function renderCreative(){
  const grid=$('#creativeGrid');if(!grid)return;
  const q=String($('#creativeSearch')?.value||'').trim().toLowerCase();
  const category=$('#creativeCategory')?.value||'all';
  grid.innerHTML='';

  const items=CREATIVE_FEATURES.filter(f=>
    (category==='all'||f.category===category) &&
    (!q||(f.name+' '+f.desc+' '+f.n).toLowerCase().includes(q))
  );

  for(const feature of items){
    const card=document.createElement('div');card.className='creativeCard';
    const meta=document.createElement('div');
    const title=document.createElement('strong');title.textContent=feature.n+'. '+feature.name;
    const desc=document.createElement('p');desc.textContent=feature.desc;
    meta.append(title,desc);

    const btn=document.createElement('button');
    btn.type='button';btn.dataset.creativeId=feature.id;btn.textContent='Usar';
    card.append(meta,btn);grid.appendChild(card);
  }

  if(!items.length){
    const empty=document.createElement('div');empty.className='creativeItem';
    empty.textContent='Nenhum recurso encontrado.';grid.appendChild(empty);
  }
}

function creativeServerRequired(){
  const server=currentServer();
  if(!server)throw new Error('Selecione um servidor primeiro');
  return server;
}

async function creativePrompt(label,initial=''){
  const value=await appDialog({
    title:String(label||'Informação'),
    message:'',
    value:String(initial??''),
    confirmText:'Continuar'
  });
  if(value===null)throw new Error('Ação cancelada');
  return String(value).trim();
}

function creativeAppend(key,item){
  const server=creativeServerRequired();
  return new Promise((resolve,reject)=>{
    socket.timeout(5000).emit('creative-append',{
      serverId:server.id,key,item
    },(err,response)=>{
      if(err||!response?.ok)return reject(new Error(response?.error||'Servidor não respondeu'));
      state.creativeServer=response.creative||{};
      resolve(response);
    });
  });
}

function creativeSet(key,value){
  const server=creativeServerRequired();
  return new Promise((resolve,reject)=>{
    socket.timeout(5000).emit('creative-set',{
      serverId:server.id,key,value
    },(err,response)=>{
      if(err||!response?.ok)return reject(new Error(response?.error||'Servidor não respondeu'));
      state.creativeServer=response.creative||{};
      resolve(response);
    });
  });
}

function creativeGet(){
  if(!state.serverId)return Promise.resolve({});
  return new Promise(resolve=>{
    socket.timeout(4000).emit('creative-get',{serverId:state.serverId},(err,response)=>{
      if(!err&&response?.ok)state.creativeServer=response.creative||{};
      resolve(state.creativeServer||{});
    });
  });
}

function creativeLocalList(key){
  const value=state.creativeLocal[key];
  return Array.isArray(value)?value:[];
}

function creativeLocalAppend(key,value){
  state.creativeLocal[key]=[...creativeLocalList(key),value].slice(-500);
  saveCreativeLocal();
}

function creativeToggle(key){
  state.creativeLocal[key]=!state.creativeLocal[key];
  saveCreativeLocal();
  return !!state.creativeLocal[key];
}

function creativeMembers(){
  return currentServer()?.memberProfiles||[];
}

function creativeRandomMember(){
  const members=creativeMembers().filter(m=>String(m.id)!==String(state.userId));
  return members.length?members[Math.floor(Math.random()*members.length)]:null;
}

function creativeDownload(name,data,type='application/json'){
  const blob=new Blob([data],{type});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=name;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),10000);
}

function creativeApplyWordFilter(){
  const words=creativeLocalList('wordFilter').map(v=>String(v).toLowerCase()).filter(Boolean);
  document.querySelectorAll('#messages .message span').forEach(span=>{
    const original=span.dataset.originalText||span.textContent||'';
    span.dataset.originalText=original;
    let value=original;
    for(const word of words){
      if(!word)continue;
      value=value.replace(new RegExp(word.replace(/[.*+?^$()|[\]\\{}]/g,'\\$&'),'gi'),'••••');
    }
    span.textContent=value;
  });
}

function creativeTodayText(){
  const server=currentServer();
  const creative=server?.creative||state.creativeServer||{};
  const today=new Date().toDateString();
  const events=(server?.events||[]).filter(e=>new Date(e.when).toDateString()===today);
  const tasks=Array.isArray(creative.sharedTasks)?creative.sharedTasks.filter(t=>!t.done):[];
  const available=creative.available||{};
  return [
    'HOJE NO CONCORDE',
    '',
    'Eventos hoje: '+events.length,
    ...events.map(e=>'• '+e.title+' · '+new Date(e.when).toLocaleTimeString()),
    '',
    'Tarefas pendentes: '+tasks.length,
    ...tasks.slice(0,8).map(t=>'• '+(t.title||t.text||'Tarefa')),
    '',
    'Disponíveis: '+Object.values(available).filter(Boolean).length,
    'Não lidas: '+Object.values(state.unreadCounts||{}).reduce((a,b)=>a+Number(b||0),0)
  ].join('\n');
}

async function runCreativeFeature(id){
  const server=currentServer();

  switch(id){
    case 'tempRoom':{
      const name='Temporária-'+(state.username||'usuario').slice(0,12);
      const result=await new Promise((resolve,reject)=>{
        socket.timeout(5000).emit('creative-temp-room',{serverId:creativeServerRequired().id,name},(err,response)=>{
          if(err||!response?.ok)return reject(new Error(response?.error||'Não foi possível criar a sala'));
          resolve(response);
        });
      });
      showCreative('Sala temporária criada: '+result.name);break;
    }
    case 'availableMode':{
      const kind=await creativePrompt('Disponível para quê?','Conversar');
      await creativeSet('available',{...(state.creativeServer.available||{}),[state.userId]:{username:state.username,kind,at:Date.now()}});
      showCreative('Você está disponível para: '+kind);break;
    }
    case 'peopleMatch':{
      const meWords=new Set(String(state.bio+' '+state.activity).toLowerCase().split(/\W+/).filter(w=>w.length>3));
      const ranked=creativeMembers().filter(m=>m.id!==state.userId).map(m=>{
        const words=String((m.bio||'')+' '+(m.username||'')).toLowerCase().split(/\W+/);
        return {name:m.username,score:words.filter(w=>meWords.has(w)).length};
      }).sort((a,b)=>b.score-a.score);
      showCreative(ranked.length?ranked.slice(0,8).map((r,i)=>(i+1)+'. '+r.name+' · compatibilidade '+r.score).join('\n'):'Sem membros suficientes');break;
    }
    case 'interestGroups':{
      const groups={};
      creativeMembers().forEach(m=>{
        const key=String(m.bio||'Sem interesse informado').split(/[,.]/)[0].trim()||'Sem interesse informado';
        (groups[key]||(groups[key]=[])).push(m.username);
      });
      showCreative(Object.entries(groups).map(([k,v])=>k+': '+v.join(', ')).join('\n'));break;
    }
    case 'missedSummary':{
      const c=await creativeGet();
      const recent=[
        ...(currentServer()?.events||[]).slice(-3).map(e=>'Evento: '+e.title),
        ...(c.decisions||[]).slice(-3).map(e=>'Decisão: '+(e.text||e.title||'')),
        ...(c.achievements||[]).slice(-3).map(e=>'Conquista: '+(e.text||'')),
        ...(c.sharedTasks||[]).slice(-3).map(e=>'Tarefa: '+(e.title||e.text||''))
      ];
      showCreative(recent.length?'O QUE VOCÊ PERDEU\n\n'+recent.join('\n'):'Ainda não há atividade suficiente para resumir.');break;
    }
    case 'callSummary':{
      const summary=await creativePrompt('Resumo da call: decisões, links e tarefas','');
      await creativeAppend('callSummaries',{text:summary,by:state.username,at:Date.now()});
      showCreative('Resumo da call salvo.');break;
    }
    case 'sharedCalendar':{
      const title=await creativePrompt('Compromisso','Reunião');
      const when=await creativePrompt('Data/hora (ex.: 2026-09-01 19:00)','');
      await creativeAppend('calendar',{title,when,by:state.username,at:Date.now()});showCreative('Compromisso adicionado: '+title+' · '+when);break;
    }
    case 'eventRsvp':{
      const eventName=await creativePrompt('Evento','Evento');
      const answer=await creativePrompt('Resposta: Vou, Talvez ou Não vou','Vou');
      await creativeAppend('rsvps',{event:eventName,answer,username:state.username,userId:state.userId,at:Date.now()});showCreative('Resposta registrada: '+answer);break;
    }
    case 'eventLobby':{
      const eventName=await creativePrompt('Evento para a sala de espera','Evento');
      const name='Espera-'+eventName.slice(0,18);
      socket.emit('create-channel',{serverId:creativeServerRequired().id,type:'voice',name});
      await creativeAppend('eventLobbies',{event:eventName,name,at:Date.now()});showCreative('Sala de espera criada: '+name);break;
    }
    case 'serverMissions':{
      const mission=await creativePrompt('Nova missão','Ajude um membro hoje');
      await creativeAppend('missions',{text:mission,by:state.username,at:Date.now()});showCreative('Missão criada: '+mission);break;
    }
    case 'helpReputation':{
      const member=await creativePrompt('Quem te ajudou?','');
      const reason=await creativePrompt('Como ajudou?','');
      await creativeAppend('helpThanks',{member,reason,from:state.username,at:Date.now()});showCreative('Agradecimento registrado para '+member);break;
    }
    case 'contributionProfile':{
      const c=await creativeGet();const rows={};
      (c.helpThanks||[]).forEach(x=>rows[x.member]=(rows[x.member]||0)+1);
      showCreative(Object.entries(rows).sort((a,b)=>b[1]-a[1]).map(([n,v])=>n+': '+v+' ajuda(s)').join('\n')||'Nenhuma contribuição registrada.');break;
    }
    case 'dailyQuestion':{
      const q=await creativePrompt('Pergunta do dia','Qual foi a melhor coisa do seu dia?');
      await creativeAppend('dailyQuestions',{text:q,date:new Date().toISOString().slice(0,10),by:state.username});showCreative('Pergunta do dia salva: '+q);break;
    }
    case 'achievementWall':{
      const value=await creativePrompt('Conquista','');
      await creativeAppend('achievements',{text:value,username:state.username,at:Date.now()});showCreative('Conquista adicionada ao mural.');break;
    }
    case 'studyMode':{
      const minutes=Math.max(1,Math.min(180,Number(await creativePrompt('Minutos de foco','25'))||25));
      await creativeSet('studySession',{minutes,startedAt:Date.now(),by:state.username,status:'focus'});
      toast('Modo estudo iniciado por '+minutes+' min');setTimeout(()=>toast('Pausa do estudo em grupo'),minutes*60000);showCreative('Sessão de estudo: '+minutes+' min.');break;
    }
    case 'speakerQueue':{
      const c=await creativeGet();const queue=Array.isArray(c.speakerQueue)?c.speakerQueue:[];
      if(!queue.some(x=>x.userId===state.userId))queue.push({userId:state.userId,username:state.username,at:Date.now()});
      await creativeSet('speakerQueue',queue);showCreative(queue.map((x,i)=>(i+1)+'. '+x.username).join('\n'));break;
    }
    case 'mutedSpeechWarning':{
      const enabled=creativeToggle('mutedSpeechWarning');
      showCreative('Aviso falando no mudo: '+(enabled?'ativado':'desativado')+'. Ele usa o estado local do microfone.');break;
    }
    case 'screenShareWarning':{
      const enabled=creativeToggle('screenShareWarning');showCreative('Aviso de compartilhamento de tela: '+(enabled?'ativado':'desativado'));break;
    }
    case 'preCallPreview': await testMedia();showCreative('Prévia de câmera/microfone aberta.');break;
    case 'silentJoin':{
      state.creativeLocal.silentJoin=!state.creativeLocal.silentJoin;state.labsPrefs.sounds=!state.creativeLocal.silentJoin;saveCreativeLocal();saveLabsPrefs();showCreative('Entrada silenciosa: '+(state.creativeLocal.silentJoin?'ativada':'desativada'));break;
    }
    case 'miniCall':{
      const enabled=creativeToggle('miniCall');$('#activeCallDock')?.classList.toggle('hidden',!enabled&&!state.joinedVoiceId);showCreative('Mini-player de call: '+(enabled?'ativado':'desativado'));break;
    }
    case 'pipVideo':{
      const video=document.querySelector('#videoGrid video, #megaMediaPreview');
      if(!video||!document.pictureInPictureEnabled)throw new Error('Nenhum vídeo compatível disponível');
      await video.requestPictureInPicture();showCreative('Picture-in-Picture ativado.');break;
    }
    case 'autoCallLayout':{
      const mode=await creativePrompt('Layout: grade, foco ou apresentação','grade');
      state.creativeLocal.callLayout=mode;saveCreativeLocal();showCreative('Layout de call salvo: '+mode);break;
    }
    case 'breakoutRooms':{
      const count=Math.max(2,Math.min(8,Number(await creativePrompt('Quantidade de salas','2'))||2));
      for(let i=1;i<=count;i++)socket.emit('create-channel',{serverId:creativeServerRequired().id,type:'voice',name:'Grupo-'+i});
      await creativeAppend('breakoutSets',{count,at:Date.now(),by:state.username});showCreative(count+' salas paralelas solicitadas.');break;
    }
    case 'walkieTalkie': state.pushToTalk=true;localStorage.setItem('acord-ptt','1');showCreative('Walkie-talkie ativado: push-to-talk ligado.');break;
    case 'spatialAudio':{
      const enabled=creativeToggle('spatialAudio');
      let index=0;for(const audio of state.remoteAudio.values()){audio.volume=Math.max(.35,1-(index%3)*.1);index++}
      showCreative('Áudio espacial simples: '+(enabled?'ativado':'desativado'));break;
    }
    case 'sharedAmbience':{
      const sound=await creativePrompt('Ambiente: chuva, cafeteria, floresta, branco','chuva');
      await creativeSet('ambience',{sound,by:state.username,at:Date.now()});showCreative('Ambiente compartilhado selecionado: '+sound);break;
    }
    case 'collabPlaylist':{
      const url=await creativePrompt('Link da música','https://');
      await creativeAppend('playlist',{url,by:state.username,at:Date.now()});showCreative('Música adicionada à playlist colaborativa.');break;
    }
    case 'watchVote':{
      const url=await creativePrompt('Link do vídeo candidato','https://');
      await creativeAppend('watchVotes',{url,by:state.username,votes:[state.userId],at:Date.now()});showCreative('Vídeo adicionado para votação.');break;
    }
    case 'cinemaMode':{
      const enabled=creativeToggle('cinemaMode');document.body.dataset.creativeCinema=enabled?'1':'0';showCreative('Modo cinema: '+(enabled?'ativado':'desativado'));break;
    }
    case 'scheduledMessage':{
      const text=await creativePrompt('Mensagem','');
      const mins=Math.max(1,Number(await creativePrompt('Enviar em quantos minutos?','1'))||1);
      await creativeAppend('scheduledMessages',{text,channelId:state.textChannelId,userId:state.userId,username:state.username,sendAt:Date.now()+mins*60000});
      showCreative('Mensagem programada para '+mins+' min.');break;
    }
    case 'expiringMessage':{
      const text=await creativePrompt('Mensagem temporária','');
      const mins=Math.max(1,Number(await creativePrompt('Expira em quantos minutos?','10'))||10);
      if(!state.textChannelId)throw new Error('Selecione um canal de texto primeiro');
      await new Promise((resolve,reject)=>{
        socket.timeout(5000).emit('creative-expiring-message',{
          serverId:creativeServerRequired().id,
          channelId:state.textChannelId,
          text,
          expiresAt:Date.now()+mins*60000
        },(err,response)=>{
          if(err||!response?.ok)return reject(new Error(response?.error||'Não foi possível enviar'));
          resolve(response);
        });
      });
      showCreative('Mensagem temporária enviada. Ela expira em '+mins+' min.');break;
    }
    case 'importantAck':{
      const text=await creativePrompt('Mensagem importante','');
      await creativeAppend('importantMessages',{id:String(Date.now()),text,by:state.username,acks:[state.userId],at:Date.now()});showCreative('Mensagem importante criada com confirmação de leitura.');break;
    }
    case 'anonymousBox':{
      const text=await creativePrompt('Sugestão anônima','');
      await creativeAppend('anonymousSuggestions',{text,at:Date.now()});showCreative('Sugestão anônima enviada.');break;
    }
    case 'anonymousQuestions':{
      const text=await creativePrompt('Pergunta anônima','');
      await creativeAppend('anonymousQuestions',{text,at:Date.now()});showCreative('Pergunta anônima enviada.');break;
    }
    case 'quickThread':{
      const title=await creativePrompt('Tema da thread','Novo assunto');
      await creativeAppend('threads',{id:String(Date.now()),title,messages:[],by:state.username,at:Date.now()});showCreative('Thread criada: '+title);break;
    }
    case 'personalInbox':{
      showCreative(JSON.stringify({nãoLidas:state.unreadCounts,salvos:creativeLocalList('readLater'),favoritos:creativeLocalList('favorites')},null,2));break;
    }
    case 'readLater':{
      const text=await creativePrompt('Salvar para ler depois',$('#messageInput')?.value||'');
      creativeLocalAppend('readLater',{text,at:Date.now()});showCreative('Item salvo para ler depois.');break;
    }
    case 'savedFolders':{
      const folder=await creativePrompt('Nome da pasta','Importante');
      const text=await creativePrompt('Conteúdo','');
      state.creativeLocal.savedFolders=state.creativeLocal.savedFolders||{};
      (state.creativeLocal.savedFolders[folder]||(state.creativeLocal.savedFolders[folder]=[])).push({text,at:Date.now()});saveCreativeLocal();showCreative('Salvo na pasta '+folder);break;
    }
    case 'globalSearch':{
      const q=await creativePrompt('Pesquisar','').toLowerCase();const c=await creativeGet();
      const matches=[];
      creativeMembers().forEach(m=>{if((m.username+' '+(m.bio||'')).toLowerCase().includes(q))matches.push('Pessoa: '+m.username)});
      (server?.textChannels||[]).forEach(ch=>{if(ch.name.toLowerCase().includes(q))matches.push('Canal: #'+ch.name)});
      Object.entries(c).forEach(([k,v])=>{if(JSON.stringify(v).toLowerCase().includes(q))matches.push('Recurso: '+k)});
      showCreative(matches.slice(0,50).join('\n')||'Nenhum resultado.');break;
    }
    case 'naturalCommands':{
      const cmd=await creativePrompt('Comando natural','criar tarefa estudar');
      if(/^criar tarefa /i.test(cmd)){const title=cmd.replace(/^criar tarefa /i,'');await creativeAppend('sharedTasks',{title,done:false,by:state.username,at:Date.now()});showCreative('Tarefa criada: '+title)}
      else if(/^status /i.test(cmd)){state.customStatus=cmd.replace(/^status /i,'');showCreative('Status preparado: '+state.customStatus)}
      else showCreative('Comandos entendidos: "criar tarefa ..." e "status ...".');break;
    }
    case 'favorites':{
      const item=await creativePrompt('Favorito (servidor, canal ou pessoa)',currentServer()?.name||'');
      creativeLocalAppend('favorites',item);showCreative('Favorito salvo: '+item);break;
    }
    case 'recentHistory': showCreative((JSON.parse(localStorage.getItem('concorde-recent-history')||'[]')||[]).join('\n')||'Sem histórico recente.');break;
    case 'commandPalette':{
      const cmd=await creativePrompt('Ctrl+K — comando','amigos');
      if(/amigo/i.test(cmd))setView('friends');else if(/mensag/i.test(cmd))setView('dm');else if(/call/i.test(cmd))returnToActiveCall();else showCreative('Comandos: amigos, mensagens, call.');break;
    }
    case 'customDashboard':{
      const widgets=await creativePrompt('Widgets separados por vírgula','eventos, amigos online, não lidas, tarefas');
      state.creativeLocal.dashboard=widgets.split(',').map(v=>v.trim()).filter(Boolean);saveCreativeLocal();showCreative('Painel salvo: '+state.creativeLocal.dashboard.join(', '));break;
    }
    case 'serverHome':{
      const c=await creativeGet();showCreative(['HOME — '+creativeServerRequired().name,'',server.rules||'Sem regras.','', 'Eventos: '+(server.events||[]).length,'FAQ: '+(c.faq||[]).length,'Tarefas: '+(c.sharedTasks||[]).length].join('\n'));break;
    }
    case 'smartOnboarding':{
      const interests=await creativePrompt('Seus interesses','jogos, estudo').split(',').map(v=>v.trim()).filter(Boolean);
      await creativeAppend('onboarding',{userId:state.userId,username:state.username,interests,at:Date.now()});showCreative('Onboarding salvo. Recomendações serão baseadas nesses interesses.');break;
    }
    case 'selfRoles':{
      const role=await creativePrompt('Nome do cargo desejado','');
      await creativeAppend('selfRoleRequests',{userId:state.userId,username:state.username,role,at:Date.now()});showCreative('Solicitação de cargo registrada: '+role);break;
    }
    case 'faqChannel':{
      const q=await creativePrompt('Pergunta','');
      const a=await creativePrompt('Resposta','');
      await creativeAppend('faq',{q,a,by:state.username,at:Date.now()});showCreative('FAQ adicionado.');break;
    }
    case 'serverWiki':{
      const title=await creativePrompt('Título da página','Nova página');
      const body=await creativePrompt('Conteúdo','');
      await creativeAppend('wiki',{title,body,by:state.username,updatedAt:Date.now()});showCreative('Página da wiki salva: '+title);break;
    }
    case 'kanban':{
      const title=await creativePrompt('Cartão','Nova tarefa');
      const column=await creativePrompt('Coluna: A fazer, Fazendo ou Concluído','A fazer');
      await creativeAppend('kanban',{title,column,by:state.username,at:Date.now()});showCreative('Cartão criado em '+column);break;
    }
    case 'sharedTasks':{
      const title=await creativePrompt('Tarefa','');
      await creativeAppend('sharedTasks',{title,done:false,assignee:'',by:state.username,at:Date.now()});showCreative('Tarefa compartilhada criada.');break;
    }
    case 'eventChecklist':{
      const event=await creativePrompt('Evento','Evento');
      const item=await creativePrompt('Item do checklist','');
      await creativeAppend('eventChecklist',{event,item,done:false,by:state.username,at:Date.now()});showCreative('Item adicionado ao checklist.');break;
    }
    case 'groupDecisions':{
      const text=await creativePrompt('Decisão tomada','');
      await creativeAppend('decisions',{text,participants:[state.username],at:Date.now()});showCreative('Decisão registrada.');break;
    }
    case 'eliminationPoll':{
      const q=await creativePrompt('Pergunta','Escolha uma opção');
      const options=await creativePrompt('Opções separadas por |','A | B | C').split('|').map(v=>v.trim()).filter(Boolean);
      await creativeAppend('eliminationPolls',{q,options,round:1,votes:{},at:Date.now()});showCreative('Enquete eliminatória criada com '+options.length+' opções.');break;
    }
    case 'onlineDraw':{
      const member=creativeRandomMember();showCreative(member?'Sorteado: '+member.username:'Sem membros disponíveis para sortear.');break;
    }
    case 'internalForms':{
      const title=await creativePrompt('Título do formulário','Inscrição');
      const fields=await creativePrompt('Campos separados por vírgula','Nome, resposta').split(',').map(v=>v.trim());
      await creativeAppend('forms',{id:String(Date.now()),title,fields,responses:[],by:state.username});showCreative('Formulário criado: '+title);break;
    }
    case 'usefulRanking':{
      const c=await creativeGet(),score={};
      (c.helpThanks||[]).forEach(x=>score[x.member]=(score[x.member]||0)+3);
      (c.achievements||[]).forEach(x=>score[x.username]=(score[x.username]||0)+1);
      (c.sharedTasks||[]).forEach(x=>{if(x.assignee)score[x.assignee]=(score[x.assignee]||0)+2});
      showCreative(Object.entries(score).sort((a,b)=>b[1]-a[1]).map(([n,s],i)=>(i+1)+'. '+n+' · '+s).join('\n')||'Sem dados para ranking.');break;
    }
    case 'customAchievements':{
      const name=await creativePrompt('Nome da conquista','Colaborador');
      const desc=await creativePrompt('Critério','');
      await creativeAppend('customAchievements',{name,desc,by:state.username,at:Date.now()});showCreative('Conquista personalizada criada.');break;
    }
    case 'memberCard':{
      const interests=await creativePrompt('Interesses','');
      state.creativeLocal.memberCard={displayName:state.displayName||state.username,bio:state.bio,interests,links:state.links||{}};saveCreativeLocal();showCreative(state.creativeLocal.memberCard);break;
    }
    case 'scheduleCompatibility':{
      const range=await creativePrompt('Seu horário disponível','18:00-22:00');
      await creativeAppend('availabilityRanges',{userId:state.userId,username:state.username,range,at:Date.now()});
      const c=await creativeGet();showCreative((c.availabilityRanges||[]).map(x=>x.username+': '+x.range).join('\n'));break;
    }
    case 'quickCallInvite':{
      const member=await creativePrompt('Usuário para chamar','');
      await creativeAppend('callInvites',{from:state.username,to:member,at:Date.now()});showCreative('Convite de call enviado para '+member);break;
    }
    case 'messageOnlyStatus':{
      const enabled=creativeToggle('messageOnly');state.customStatus=enabled?'💬 Só mensagem':'';showCreative('Só mensagem: '+(enabled?'ativado':'desativado'));break;
    }
    case 'timedStatus':{
      const value=await creativePrompt('Status temporário','Ocupado');
      const mins=Math.max(1,Number(await creativePrompt('Duração em minutos','60'))||60);
      state.customStatus=value;state.creativeLocal.timedStatus={value,expiresAt:Date.now()+mins*60000};saveCreativeLocal();
      setTimeout(()=>{if(state.creativeLocal.timedStatus?.expiresAt<=Date.now()){state.customStatus='';delete state.creativeLocal.timedStatus;saveCreativeLocal()}},mins*60000);
      showCreative('Status ativo por '+mins+' min.');break;
    }
    case 'serverInvisible':{
      const enabled=creativeToggle('invisible:'+state.serverId);await creativeAppend('invisibleMembers',{userId:state.userId,enabled,at:Date.now()});showCreative('Invisível neste servidor: '+(enabled?'sim':'não'));break;
    }
    case 'blockUser':{
      const user=await creativePrompt('Usuário para bloquear','');
      creativeLocalAppend('blockedUsers',user.toLowerCase());showCreative('Usuário adicionado à lista de bloqueio: '+user);break;
    }
    case 'personalWordFilter':{
      const word=await creativePrompt('Palavra para ocultar','');
      creativeLocalAppend('wordFilter',word);creativeApplyWordFilter();showCreative('Filtro aplicado para: '+word);break;
    }
    case 'adaptiveAntiSpam':{
      const limit=Math.max(2,Number(await creativePrompt('Máximo de mensagens repetidas','3'))||3);await creativeSet('antiSpam',{enabled:true,repeatLimit:limit,updatedAt:Date.now()});showCreative('Anti-spam configurado.');break;
    }
    case 'smartSlowMode':{
      const seconds=Math.max(0,Number(await creativePrompt('Intervalo mínimo em segundos','5'))||0);await creativeSet('slowMode',{seconds,updatedAt:Date.now()});showCreative('Modo lento: '+seconds+'s.');break;
    }
    case 'raidProtection':{
      const enabled=await creativePrompt('Ativar proteção contra raid? sim/não','sim').toLowerCase().startsWith('s');await creativeSet('raidProtection',{enabled,updatedAt:Date.now()});showCreative('Proteção contra raid: '+(enabled?'ativada':'desativada'));break;
    }
    case 'newMemberQuarantine':{
      const mins=Math.max(0,Number(await creativePrompt('Minutos de quarentena','10'))||0);await creativeSet('quarantine',{minutes:mins,updatedAt:Date.now()});showCreative('Quarentena configurada para '+mins+' min.');break;
    }
    case 'everyoneConfirm':{
      const enabled=await creativePrompt('Exigir confirmação para @everyone? sim/não','sim').toLowerCase().startsWith('s');await creativeSet('everyoneConfirm',{enabled});showCreative('Confirmação @everyone: '+(enabled?'ativada':'desativada'));break;
    }
    case 'serverHealth':{
      const c=await creativeGet();showCreative(['SAÚDE DO SERVIDOR','Membros: '+(server?.memberProfiles?.length||0),'Canais de texto: '+(server?.textChannels?.length||0),'Canais de voz: '+(server?.voiceChannels?.length||0),'Tarefas: '+(c.sharedTasks||[]).length,'FAQ: '+(c.faq||[]).length,'Wiki: '+(c.wiki||[]).length].join('\n'));break;
    }
    case 'cleanupSuggestions':{
      const empty=(server?.textChannels||[]).filter(ch=>!ch.name||/novo|teste/i.test(ch.name));
      showCreative(empty.length?'Possíveis canais para revisar:\n'+empty.map(c=>'• '+c.name).join('\n'):'Nenhum canal claramente abandonado detectado.');break;
    }
    case 'archiveChannels':{
      const ch=currentText();if(!ch)throw new Error('Selecione um canal de texto');
      await creativeAppend('archivedChannels',{...ch,archivedAt:Date.now(),by:state.username});showCreative('Canal registrado no arquivo: #'+ch.name);break;
    }
    case 'recycleBin':{
      const c=await creativeGet();showCreative((c.recycleBin||[]).map(x=>x.name||x.title||JSON.stringify(x)).join('\n')||'Lixeira vazia.');break;
    }
    case 'configHistory': socket.emit('mega-get-audit',{serverId:creativeServerRequired().id});showCreative('Histórico solicitado. Veja também o log de moderação em Servidor.');break;
    case 'duplicateStructure':{
      const ch=currentText();if(!ch)throw new Error('Selecione um canal de texto');
      socket.emit('create-channel',{serverId:creativeServerRequired().id,type:'text',name:(ch.name+'-copia').slice(0,28)});showCreative('Duplicação solicitada: #'+ch.name+'-copia');break;
    }
    case 'serverTemplates':{
      const type=await creativePrompt('Template: estudo, gaming, comunidade','estudo');
      const presets={estudo:['geral','duvidas','materiais','foco'],gaming:['geral','clips','times','estrategia'],comunidade:['geral','anuncios','eventos','sugestoes']};
      const names=presets[type]||presets.estudo;for(const n of names)socket.emit('create-channel',{serverId:creativeServerRequired().id,type:'text',name:n});
      showCreative('Template '+type+' solicitado com '+names.length+' canais.');break;
    }
    case 'cloneServer':{
      const name=await creativePrompt('Nome do clone',(server?.name||'Servidor')+' Clone');
      socket.emit('create-server',{name});creativeLocalAppend('cloneRequests',{source:state.serverId,name,at:Date.now()});showCreative('Novo servidor solicitado. A estrutura pode ser replicada manualmente pelo template.');break;
    }
    case 'visitorMode':{
      const enabled=await creativePrompt('Ativar modo visitante? sim/não','sim').toLowerCase().startsWith('s');await creativeSet('visitorMode',{enabled,updatedAt:Date.now()});showCreative('Modo visitante criativo: '+(enabled?'ativado':'desativado'));break;
    }
    case 'perServerProfile':{
      const nickname=await creativePrompt('Nome neste servidor',state.displayName||state.username);
      const bio=await creativePrompt('Bio neste servidor',state.bio||'');
      state.creativeLocal.serverProfiles=state.creativeLocal.serverProfiles||{};state.creativeLocal.serverProfiles[state.serverId]={nickname,bio};saveCreativeLocal();showCreative('Perfil do servidor salvo: '+nickname);break;
    }
    case 'timedNickname':{
      const nick=await creativePrompt('Apelido temporário','');
      const mins=Math.max(1,Number(await creativePrompt('Duração em minutos','60'))||60);
      state.creativeLocal.timedNick={serverId:state.serverId,nick,expiresAt:Date.now()+mins*60000};saveCreativeLocal();showCreative('Apelido temporário salvo por '+mins+' min.');break;
    }
    case 'photoWall':{
      const url=await creativePrompt('URL da foto','https://');await creativeAppend('photoWall',{url,by:state.username,at:Date.now()});showCreative('Foto adicionada ao mural.');break;
    }
    case 'collabAlbum':{
      const album=await creativePrompt('Nome do álbum','Geral');const url=await creativePrompt('URL da foto','https://');await creativeAppend('albums',{album,url,by:state.username,at:Date.now()});showCreative('Foto adicionada ao álbum '+album);break;
    }
    case 'fileGallery':{
      const name=await creativePrompt('Nome do arquivo','Arquivo');const url=await creativePrompt('URL do arquivo','https://');await creativeAppend('fileGallery',{name,url,by:state.username,at:Date.now()});showCreative('Arquivo adicionado à galeria.');break;
    }
    case 'audioPlayer':{
      const url=await creativePrompt('URL direta do áudio','https://');const audio=new Audio(url);audio.controls=true;audio.autoplay=true;const panel=$('#creativePanel');panel.innerHTML='';panel.classList.remove('hidden');panel.appendChild(audio);setCreativeStatus('Player de áudio aberto.','ok');break;
    }
    case 'pdfViewer':{
      const url=await creativePrompt('URL do PDF','https://');const iframe=document.createElement('iframe');iframe.src=url;iframe.style.cssText='width:100%;height:320px;border:0';const panel=$('#creativePanel');panel.innerHTML='';panel.classList.remove('hidden');panel.appendChild(iframe);setCreativeStatus('PDF aberto.','ok');break;
    }
    case 'fileNotes':{
      const file=await creativePrompt('Arquivo/link','');const note=await creativePrompt('Nota','');await creativeAppend('fileNotes',{file,note,by:state.username,at:Date.now()});showCreative('Nota vinculada ao arquivo.');break;
    }
    case 'versionCompare':{
      const a=await creativePrompt('Versão A','');const b=await creativePrompt('Versão B','');const aw=a.split(/\s+/),bw=b.split(/\s+/);const onlyA=aw.filter(x=>!bw.includes(x)),onlyB=bw.filter(x=>!aw.includes(x));showCreative('Somente A: '+onlyA.join(' ')+'\n\nSomente B: '+onlyB.join(' '));break;
    }
    case 'customReactions':{
      const emoji=await creativePrompt('Reação','⭐');const label=await creativePrompt('Nome','Destaque');await creativeAppend('customReactions',{emoji,label,by:state.username});showCreative('Reação criada: '+emoji+' '+label);break;
    }
    case 'serverEmojiPacks':{
      const name=await creativePrompt('Nome do emoji','emoji');const url=await creativePrompt('URL da imagem','https://');await creativeAppend('emojiPack',{name,url,by:state.username});showCreative('Emoji personalizado registrado.');break;
    }
    case 'stickersApproval':{
      const name=await creativePrompt('Nome do sticker','sticker');const url=await creativePrompt('URL da imagem','https://');await creativeAppend('stickerQueue',{name,url,by:state.username,status:'pending'});showCreative('Sticker enviado para aprovação.');break;
    }
    case 'temporaryAvatar':{
      const url=await creativePrompt('URL do avatar temporário','https://');const mins=Math.max(1,Number(await creativePrompt('Duração em minutos','60'))||60);state.creativeLocal.tempAvatar={url,expiresAt:Date.now()+mins*60000};saveCreativeLocal();$('#userAvatar').style.backgroundImage='url("'+url.replace(/"/g,'')+'")';showCreative('Avatar temporário aplicado localmente.');break;
    }
    case 'serverTheme':{
      const color=await creativePrompt('Cor principal hexadecimal','#41d99a');const background=await creativePrompt('URL de fundo (opcional)','');state.creativeLocal.serverThemes=state.creativeLocal.serverThemes||{};state.creativeLocal.serverThemes[state.serverId]={color,background};saveCreativeLocal();document.documentElement.style.setProperty('--coral',color);showCreative('Tema do servidor aplicado.');break;
    }
    case 'communityThemes':{
      const action=await creativePrompt('exportar ou importar','exportar');
      if(/^exp/i.test(action)){creativeDownload('concorde-tema.json',JSON.stringify(state.creativeLocal.serverThemes?.[state.serverId]||{},null,2))}
      else{const raw=await creativePrompt('Cole o JSON do tema','{}');state.creativeLocal.serverThemes=state.creativeLocal.serverThemes||{};state.creativeLocal.serverThemes[state.serverId]=JSON.parse(raw);saveCreativeLocal();showCreative('Tema importado.')}break;
    }
    case 'healthyMode':{
      const enabled=creativeToggle('healthyMode');if(state.creativeHealthyTimer)clearInterval(state.creativeHealthyTimer);
      if(enabled)state.creativeHealthyTimer=setInterval(()=>{if(state.joinedVoiceId)toast('Você está há bastante tempo em call. Considere uma pausa.')},60*60*1000);
      showCreative('Modo saudável: '+(enabled?'ativado':'desativado'));break;
    }
    case 'usageSummary':{
      const mins=Math.round((Date.now()-state.creativeStartedAt)/60000);showCreative('Tempo aproximado nesta sessão: '+mins+' minuto(s).');break;
    }
    case 'concentrationMode':{
      const enabled=creativeToggle('concentrationMode');state.labsPrefs.dnd=enabled;saveLabsPrefs();showCreative('Modo concentração: '+(enabled?'ativado':'desativado'));break;
    }
    case 'todayHub': await creativeGet();showCreative(creativeTodayText());break;
    default: throw new Error('Recurso ainda não reconhecido: '+id);
  }
}

async function handleCreativeClick(event){
  const button=event.target.closest('button[data-creative-id]');
  if(!button)return;
  event.preventDefault();event.stopPropagation();

  const feature=CREATIVE_FEATURES.find(f=>f.id===button.dataset.creativeId);
  if(!feature)return;

  setCreativeStatus('Executando: '+feature.name+'...');
  button.disabled=true;

  try{
    await runCreativeFeature(feature.id);
    if(!$('#creativeStatus')?.classList.contains('error'))setCreativeStatus(feature.name+': concluído.','ok');
  }catch(error){
    console.error('Concorde Criativo:',feature.id,error);
    setCreativeStatus(feature.name+': '+(error?.message||'erro'),'error');
    showCreative('Não foi possível executar '+feature.name+'.\n'+String(error?.message||error));
  }finally{
    button.disabled=false;
  }
}



function isMobileInterface(){
  if(state.interfaceMode==='mobile') return true;
  if(state.interfaceMode==='desktop') return false;
  return window.matchMedia('(max-width: 820px)').matches ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

function applyInterfaceMode(){
  const mobile=isMobileInterface();
  document.body.classList.toggle('mobileMode',mobile);
  document.body.classList.toggle('desktopMode',!mobile && state.interfaceMode==='desktop');

  if(!mobile){
    closeMobileServers();
  }

  const select=$('#essentialMobileMode');
  if(select)select.value=state.interfaceMode;

  const saver=$('#essentialDataSaver');
  if(saver)saver.checked=!!state.dataSaver;

  updateMobileNav();
}

function closeMobileServers(){
  state.mobileDrawerOpen=false;
  document.body.classList.remove('mobileServersOpen');
  $('#mobileBackdrop')?.classList.add('hidden');
}

function toggleMobileServers(){
  if(!isMobileInterface()) return;
  state.mobileDrawerOpen=!state.mobileDrawerOpen;
  document.body.classList.toggle('mobileServersOpen',state.mobileDrawerOpen);
  $('#mobileBackdrop')?.classList.toggle('hidden',!state.mobileDrawerOpen);
}

function updateMobileNav(){
  if(!isMobileInterface())return;
  const view=state.currentView;
  $('#mobileHomeBtn')?.classList.toggle('active',view==='friends'||view==='dm');
  $('#mobileServersBtn')?.classList.toggle('active',state.mobileDrawerOpen);
  $('#mobileChatBtn')?.classList.toggle('active',view==='chat');
  $('#mobileCallBtn')?.classList.toggle('active',view==='voice');
}

function setEssentialActionStatus(message,type=''){
  const el=$('#essentialActionStatus');
  if(!el)return;
  el.textContent=String(message||'');
  el.classList.remove('ok','error');
  if(type)el.classList.add(type);
}

function setEssentialStatus(message,type=''){
  setEssentialActionStatus(message,type);
  const out=$('#essentialOutput');
  if(!out)return;
  out.textContent=String(message||'');
  out.classList.remove('hidden');
  out.dataset.type=type;
}

async function essentialConnectionCheck(){
  setEssentialActionStatus('Testando conexão...');
  const badge=$('#essentialConnectionBadge');
  const info=$('#essentialConnectionInfo');
  const started=performance.now();

  if(!socket.connected){
    if(badge){badge.textContent='Desconectado';badge.className='essentialBadge error'}
    if(info)info.textContent='Socket.IO desconectado.';
    setEssentialActionStatus('Sem conexão com o servidor.','error');
    return;
  }

  socket.timeout(3500).emit('essential-ping',{at:Date.now()},(err,response)=>{
    if(err||!response?.ok){
      if(badge){badge.textContent='Instável';badge.className='essentialBadge error'}
      if(info)info.textContent='Servidor conectado, mas sem resposta ao teste.';
      setEssentialActionStatus('Servidor sem resposta ao teste.','error');
      return;
    }

    const ms=Math.round(performance.now()-started);
    if(badge){badge.textContent='Online · '+ms+' ms';badge.className='essentialBadge ok'}
    setEssentialActionStatus('Conexão funcionando.','ok');
    if(info){
      info.textContent=[
        'Conectado',
        'Latência aproximada: '+ms+' ms',
        'Servidor: '+new Date(response.serverTime).toLocaleString(),
        'WebRTC ativo: '+(state.peers.size>0?'sim':'não')
      ].join('\n');
    }
  });
}

async function loadPersistenceStatus(){
  const box=$('#essentialPersistenceStatus');
  if(!box)return;

  try{
    const response=await fetch('/api/persistence-status',{cache:'no-store'});
    const data=await response.json();

    box.textContent=[
      'Arquivo principal: '+(data.dataFileExists?'OK':'não encontrado'),
      'Backup: '+(data.backupExists?'OK':'não encontrado'),
      'Contas carregadas: '+Number(data.accounts||0),
      'Servidores carregados: '+Number(data.servers||0),
      'Amizades carregadas: '+Number(data.friendships||0)
    ].join('\n');
  }catch{
    box.textContent='Não foi possível consultar a persistência.';
  }
}

function downloadEssentialBackup(){
  saveLocalRecoverySnapshot();
  const snapshot=readLocalRecoverySnapshot();

  if(!snapshot){
    setEssentialStatus('Não foi possível gerar o backup.','error');
    return;
  }

  const full={
    kind:'concorde-backup',
    version:1,
    exportedAt:Date.now(),
    recovery:snapshot,
    preferences:{
      theme:state.theme,
      palette:state.palette,
      customColor:state.customColor,
      interfaceMode:state.interfaceMode,
      dataSaver:state.dataSaver,
      blockedUsers:creativeLocalList('blockedUsers')
    }
  };

  const blob=new Blob([JSON.stringify(full,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download='concorde-backup-'+new Date().toISOString().slice(0,10)+'.json';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url),10000);
  setEssentialStatus('Backup baixado.','ok');
}

async function restoreEssentialBackup(file){
  if(!file)return;

  try{
    const raw=await file.text();
    const data=JSON.parse(raw);
    if(data?.kind!=='concorde-backup'||!data?.recovery?.userId){
      throw new Error('Arquivo de backup inválido');
    }

    localStorage.setItem('acord-recovery-v1',JSON.stringify(data.recovery));

    if(data.preferences){
      if(data.preferences.theme)localStorage.setItem('ecord-theme',data.preferences.theme);
      if(data.preferences.palette)localStorage.setItem('ecord-palette',data.preferences.palette);
      if(data.preferences.customColor)localStorage.setItem('ecord-custom-color',data.preferences.customColor);
      if(data.preferences.interfaceMode)localStorage.setItem('concorde-interface-mode',data.preferences.interfaceMode);
      localStorage.setItem('concorde-data-saver',data.preferences.dataSaver?'1':'0');

      if(Array.isArray(data.preferences.blockedUsers)){
        state.creativeLocal.blockedUsers=data.preferences.blockedUsers.slice(0,500);
        saveCreativeLocal();
      }
    }

    setEssentialStatus('Backup importado. Entre com a mesma conta para recuperar os dados.','ok');
  }catch(error){
    setEssentialStatus(error?.message||'Não foi possível importar o backup.','error');
  }
}

function renderEssentialSearchResults(items){
  const box=$('#essentialSearchResults');
  if(!box)return;
  box.innerHTML='';

  for(const item of items||[]){
    const row=document.createElement('div');
    row.className='essentialResult';

    const title=document.createElement('strong');
    title.textContent=item.title||item.type||'Resultado';

    const body=document.createElement('span');
    body.textContent=item.preview||item.subtitle||'';

    row.append(title,body);

    if(item.serverId&&item.channelId){
      row.style.cursor='pointer';
      row.addEventListener('click',()=>{
        state.serverId=item.serverId;
        localStorage.setItem('ecord-last-server-id',item.serverId);
        selectText(item.channelId);
      });
    }

    box.appendChild(row);
  }

  if(!(items||[]).length){
    const row=document.createElement('div');
    row.className='essentialResult';
    row.textContent='Nenhum resultado encontrado.';
    box.appendChild(row);
  }
}

function performEssentialSearch(){
  const query=String($('#essentialSearchInput')?.value||'').trim();
  if(query.length<2){
    setEssentialStatus('Digite pelo menos 2 caracteres.','error');
    return;
  }

  setEssentialActionStatus('Buscando...');

  socket.timeout(6000).emit('essential-search',{query},(err,response)=>{
    if(!err&&response?.ok){
      renderEssentialSearchResults(response.results||[]);
      setEssentialActionStatus('Busca concluída.','ok');
      return;
    }

    // Fallback local: ainda permite buscar nos servidores já carregados no navegador.
    const q=query.toLowerCase();
    const results=[];

    for(const server of state.servers||[]){
      if(String(server.name||'').toLowerCase().includes(q)){
        results.push({
          type:'server',
          title:'Servidor · '+server.name,
          preview:server.description||'',
          serverId:server.id
        });
      }

      for(const channel of server.textChannels||[]){
        if(String(channel.name||'').toLowerCase().includes(q)){
          results.push({
            type:'channel',
            title:'# '+channel.name+' · '+server.name,
            preview:'Canal de texto',
            serverId:server.id,
            channelId:channel.id
          });
        }
      }

      for(const member of server.memberProfiles||[]){
        if(
          (String(member.username||'')+' '+String(member.bio||''))
            .toLowerCase()
            .includes(q)
        ){
          results.push({
            type:'user',
            title:'Pessoa · '+member.username,
            preview:member.bio||''
          });
        }
      }
    }

    renderEssentialSearchResults(results.slice(0,100));
    setEssentialActionStatus(
      results.length
        ? 'Busca feita com os dados locais disponíveis.'
        : (response?.error||'Nenhum resultado e o servidor não respondeu.'),
      results.length?'ok':'error'
    );
  });
}

function loadEssentialSessions(){
  socket.timeout(5000).emit('essential-sessions',state.authToken?{token:state.authToken}:{},(err,response)=>{
    if(err||!response?.ok){
      setEssentialStatus(
        response?.error||
        (state.profileReady
          ? 'Sua sessão atual está ativa, mas o servidor não respondeu à lista completa.'
          : 'Entre na conta novamente.'),
        'error'
      );
      return;
    }

    const lines=(response.sessions||[]).map((session,index)=>
      (index+1)+'. '+(session.current?'ESTE DISPOSITIVO':'Outra sessão')+
      ' · criada '+new Date(session.createdAt).toLocaleString()+
      ' · ativa '+new Date(session.lastSeenAt).toLocaleString()
    );

    setEssentialStatus(lines.join('\n')||'Nenhuma sessão ativa.','ok');
  });
}

function revokeOtherSessions(){
  socket.timeout(5000).emit('essential-revoke-other-sessions',state.authToken?{token:state.authToken}:{},(err,response)=>{
    if(err||!response?.ok){
      setEssentialStatus(response?.error||'Não foi possível encerrar as sessões.','error');
      return;
    }
    setEssentialStatus('Outras sessões encerradas: '+Number(response.revoked||0),'ok');
  });
}

function changeEssentialPassword(){
  const oldPassword=$('#essentialOldPassword').value;
  const newPassword=$('#essentialNewPassword').value;

  if(newPassword.length<6){
    setEssentialStatus('A nova senha precisa ter pelo menos 6 caracteres.','error');
    return;
  }

  socket.timeout(6000).emit('essential-change-password',{
    ...(state.authToken?{token:state.authToken}:{}),
    oldPassword,
    newPassword
  },(err,response)=>{
    if(err||!response?.ok){
      setEssentialStatus(response?.error||'Não foi possível alterar a senha.','error');
      return;
    }

    $('#essentialOldPassword').value='';
    $('#essentialNewPassword').value='';
    setEssentialStatus('Senha alterada com sucesso.','ok');
  });
}

function essentialBlock(action){
  const username=String($('#essentialBlockUser').value||'').trim().toLowerCase();
  if(!username){
    setEssentialStatus('Digite o nome do usuário.','error');
    return;
  }

  const list=new Set(creativeLocalList('blockedUsers').map(v=>String(v).toLowerCase()));

  if(action==='block')list.add(username);
  else list.delete(username);

  state.creativeLocal.blockedUsers=[...list].slice(0,500);
  saveCreativeLocal();

  setEssentialStatus(
    action==='block'?'Usuário bloqueado neste dispositivo.':'Usuário desbloqueado.',
    'ok'
  );
}

function essentialReport(){
  if(!state.serverId){
    setEssentialStatus('Abra o servidor onde ocorreu o problema.','error');
    return;
  }

  const target=String($('#essentialBlockUser').value||'').trim();
  const reason=String($('#essentialReportReason').value||'').trim();

  if(!target||reason.length<3){
    setEssentialStatus('Informe o usuário e o motivo da denúncia.','error');
    return;
  }

  socket.timeout(5000).emit('essential-report',{
    serverId:state.serverId,
    target,
    reason
  },(err,response)=>{
    if(err||!response?.ok){
      setEssentialStatus(response?.error||'Não foi possível enviar a denúncia.','error');
      return;
    }

    $('#essentialReportReason').value='';
    setEssentialStatus('Denúncia registrada.','ok');
  });
}

function applyDataSaver(){
  localStorage.setItem('concorde-data-saver',state.dataSaver?'1':'0');

  if(state.dataSaver){
    state.cameraQuality='720p';
    state.screenShareQuality='720p';
    localStorage.setItem('acord-camera-quality','720p');
    localStorage.setItem('ecord-screen-quality','720p');
  }
}


async function runEssentialAction(action,event){
  try{
    setEssentialActionStatus('Executando...');

    switch(action){
      case 'apply-mobile':
        state.interfaceMode=$('#essentialMobileMode').value;
        state.dataSaver=$('#essentialDataSaver').checked;
        localStorage.setItem('concorde-interface-mode',state.interfaceMode);
        applyDataSaver();
        applyInterfaceMode();
        setEssentialStatus('Modo de interface aplicado.','ok');
        return;

      case 'install':
        if(/Windows/i.test(navigator.userAgent)){
          downloadAcordWindows();
          setEssentialStatus('Abrindo o instalador independente do Acord para Windows.','ok');
        }else{
          setEssentialStatus('A instalação pelo navegador foi desativada. Use o site normalmente neste dispositivo.','ok');
        }
        return;

      case 'backup':
        downloadEssentialBackup();
        return;

      case 'refresh-backup':
        saveLocalRecoverySnapshot();
        await loadPersistenceStatus();
        setEssentialStatus('Backup local atualizado.','ok');
        return;

      case 'search':
        performEssentialSearch();
        return;

      case 'sessions':
        loadEssentialSessions();
        return;

      case 'logout-others':
        revokeOtherSessions();
        return;

      case 'change-password':
        changeEssentialPassword();
        return;

      case 'ping':
        essentialConnectionCheck();
        return;

      case 'reconnect':
        setEssentialActionStatus('Reconectando...');
        socket.disconnect();
        setTimeout(()=>socket.connect(),250);
        setTimeout(essentialConnectionCheck,1000);
        return;

      case 'block':
        essentialBlock('block');
        return;

      case 'unblock':
        essentialBlock('unblock');
        return;

      case 'report':
        essentialReport();
        return;

      default:
        throw new Error('Ação essencial desconhecida: '+action);
    }
  }catch(error){
    console.error('Essenciais:',action,error);
    setEssentialStatus(error?.message||'Não foi possível executar esta função.','error');
  }
}

function essentialActionFromElement(target){
  const id=target?.id||'';

  const map={
    essentialApplyMobileBtn:'apply-mobile',
    essentialInstallBtn:'install',
    essentialBackupBtn:'backup',
    essentialRefreshBackupBtn:'refresh-backup',
    essentialSearchBtn:'search',
    essentialSessionsBtn:'sessions',
    essentialLogoutOthersBtn:'logout-others',
    essentialChangePasswordBtn:'change-password',
    essentialPingBtn:'ping',
    essentialReconnectBtn:'reconnect',
    essentialBlockBtn:'block',
    essentialUnblockBtn:'unblock',
    essentialReportBtn:'report'
  };

  return map[id]||'';
}

function handleEssentialDelegatedClick(event){
  const button=event.target.closest(
    '#megaPageEssential button, #essentialInstallBtn'
  );

  if(!button)return;

  const action=essentialActionFromElement(button);
  if(!action)return;

  event.preventDefault();
  event.stopPropagation();
  runEssentialAction(action,event);
}

function openEssentials(){
  openMegaView('essential',state.megaFromServer);
}

function openMegaView(page='profile',fromServer=false){
  state.megaFromServer=!!fromServer;

  setView('mega');
  setAppMode(state.megaFromServer ? 'server' : 'hub');

  $('#topTitle').textContent=state.megaFromServer
    ? '✦ Concorde+ · ' + (currentServer()?.name || 'Servidor')
    : '✦ Concorde+';

  $('#topSub').textContent=state.megaFromServer
    ? 'ferramentas e recursos deste servidor'
    : 'recursos avançados';

  $('#quickInviteBtn')?.classList.toggle(
    'hidden',
    !state.megaFromServer
  );

  selectMegaPage(
    state.megaFromServer && page==='profile'
      ? 'server'
      : page
  );

  loadMegaData();
}

function selectMegaPage(page){
  document.querySelectorAll('.megaNavBtn').forEach(btn=>{
    btn.classList.toggle('active',btn.dataset.megaPage===page);
  });
  document.querySelectorAll('.megaPage').forEach(panel=>panel.classList.remove('active'));
  const target=document.getElementById(
    'megaPage'+page.charAt(0).toUpperCase()+page.slice(1)
  );
  target?.classList.add('active');
  if(page==='community') renderMegaCommunity();
  if(page==='server') renderMegaServerControls();
  if(page==='call') updateMegaConnectionInfo();
  if(page==='labs'){
    setLabsStatus('Pronto para usar.');
    renderLabsFeatures();
  }
  if(page==='creative'){
    setCreativeStatus('Pronto para usar.');
    creativeGet().then(()=>renderCreative());
  }
  if(page==='essential'){
    setEssentialActionStatus('Carregando recursos essenciais...');
    applyInterfaceMode();

    Promise.resolve()
      .then(()=>loadPersistenceStatus())
      .catch(()=>{})
      .finally(()=>essentialConnectionCheck());
  }
  if(page==='whiteboard' && state.serverId){
    initMegaWhiteboard();
    socket.emit('mega-whiteboard-get',{serverId:state.serverId});
  }
}

function loadMegaData(){
  $('#megaCustomStatus').value=state.customStatus||'';
  $('#megaPronouns').value=state.pronouns||'';
  $('#megaActivity').value=state.activity||'';
  $('#megaSteam').value=state.links?.steam||'';
  $('#megaSpotify').value=state.links?.spotify||'';
  $('#megaYoutube').value=state.links?.youtube||'';
  $('#megaPrivacyDm').value=state.privacy?.dm||'friends';
  $('#megaPrivacyCalls').value=state.privacy?.calls||'friends';
  $('#megaCameraQuality').value=state.cameraQuality||'1080p';
  $('#megaTenorKey').value=localStorage.getItem('acord-tenor-key')||'';
  renderMegaServerControls();
  renderMegaCommunity();
  updateWatchPartyUI(currentServer()?.watchParty);
}

function saveMegaProfile(){
  socket.emit('profile-extra-update',{
    customStatus:$('#megaCustomStatus').value,
    pronouns:$('#megaPronouns').value,
    activity:$('#megaActivity').value,
    links:{
      steam:$('#megaSteam').value,
      spotify:$('#megaSpotify').value,
      youtube:$('#megaYoutube').value
    },
    privacy:{
      dm:$('#megaPrivacyDm').value,
      calls:$('#megaPrivacyCalls').value,
      friendRequests:'everyone'
    }
  });
}

function unreadKey(serverId,channelId){
  return String(serverId)+':'+String(channelId);
}
function saveUnreadCounts(){
  localStorage.setItem('acord-unread-counts',JSON.stringify(state.unreadCounts||{}));
}
function addUnread(serverId,channelId){
  const key=unreadKey(serverId,channelId);
  state.unreadCounts[key]=Math.min(99,Number(state.unreadCounts[key]||0)+1);
  saveUnreadCounts();
  renderSidebar();
}
function clearUnread(serverId,channelId){
  const key=unreadKey(serverId,channelId);
  if(state.unreadCounts[key]){
    delete state.unreadCounts[key];
    saveUnreadCounts();
    renderSidebar();
  }
}
function clearAllUnread(){
  state.unreadCounts={};
  saveUnreadCounts();
  renderSidebar();
  toast('Tudo marcado como lido');
}

function renderMegaServerControls(){
  const server=currentServer();
  if(!server) return;
  $('#megaServerRules').value=server.rules||'';
  $('#megaInviteExpiry').value=String(
    server.inviteExpiresAt && server.inviteExpiresAt>Date.now()
      ? Math.max(0,server.inviteExpiresAt-Date.now())
      : 0
  );

  const policy=server.channelPolicies?.[state.textChannelId]||{};
  $('#megaChannelMode').value=policy.mode||'normal';
  const roleSelect=$('#megaChannelRole');
  roleSelect.innerHTML='<option value="">Todos os membros</option>';
  (server.roles||[]).forEach(role=>{const o=document.createElement('option');o.value=role.id;o.textContent=role.name;roleSelect.appendChild(o)});
  roleSelect.value=policy.roleId||'';

  const select=$('#megaModerationMember');
  select.innerHTML='';
  (server.memberProfiles||[]).forEach(profile=>{
    if(String(profile.id)===String(state.userId)) return;
    const option=document.createElement('option');
    option.value=profile.id;
    option.textContent=profile.username;
    select.appendChild(option);
  });
}

function saveMegaServer(){
  if(!state.serverId) return;
  socket.emit('mega-server-settings',{
    serverId:state.serverId,
    rules:$('#megaServerRules').value,
    banner:state.megaServerBannerData,
    inviteExpiryMs:Number($('#megaInviteExpiry').value||0),
    channelId:state.textChannelId,
    channelMode:$('#megaChannelMode').value,
    channelRoleId:$('#megaChannelRole').value
  });
}

function moderateMember(action){
  const userId=$('#megaModerationMember').value;
  if(!userId||!state.serverId) return;
  socket.emit('mega-moderate',{
    serverId:state.serverId,
    userId,
    action
  });
}

function renderMegaAudit(items){
  const box=$('#megaAuditList');
  box.innerHTML='';
  (items||[]).slice().reverse().forEach(item=>{
    const div=document.createElement('div');
    div.className='megaItem';
    div.textContent=new Date(item.at||Date.now()).toLocaleString()+
      ' · '+(item.actor||'Sistema')+' · '+(item.action||'ação')+
      (item.target?' · '+item.target:'');
    box.appendChild(div);
  });
}

function renderMegaCommunity(){
  const server=currentServer();
  const box=$('#megaCommunityList');
  if(!box||!server) return;
  box.innerHTML='';
  (server.events||[]).slice().reverse().forEach(event=>{
    const div=document.createElement('div');div.className='megaItem';
    div.textContent='📅 '+event.title+' · '+new Date(event.when).toLocaleString();
    box.appendChild(div);
  });
  (server.polls||[]).slice().reverse().forEach(poll=>{
    const div=document.createElement('div');div.className='megaItem';
    const title=document.createElement('strong');title.textContent='📊 '+poll.question;
    div.appendChild(title);
    (poll.options||[]).forEach((opt,index)=>{
      const btn=document.createElement('button');
      btn.className='btn secondary small';
      btn.style.margin='6px 6px 0 0';
      btn.textContent=opt.text+' ('+(opt.votes||[]).length+')';
      btn.addEventListener('click',()=>socket.emit('mega-poll-vote',{
        serverId:state.serverId,pollId:poll.id,index
      }));
      div.appendChild(btn);
    });
    box.appendChild(div);
  });
}

function updateWatchPartyUI(watch){
  const data=watch||{url:'',playing:false};
  $('#megaWatchUrl').value=data.url||'';
  $('#megaWatchStatus').textContent=data.url
    ? (data.playing?'▶ Reproduzindo junto':'⏸ Pausado')+' · atualizado '+new Date(data.updatedAt||Date.now()).toLocaleTimeString()
    : 'Nenhum vídeo compartilhado.';
  const link=$('#megaWatchOpen');
  if(data.url){
    link.href=data.url;link.classList.remove('hidden');
  }else{
    link.classList.add('hidden');
  }
}

function emitWatchParty(playing){
  if(!state.serverId) return;
  socket.emit('mega-watch',{
    serverId:state.serverId,
    url:$('#megaWatchUrl').value,
    playing:!!playing,
    position:0
  });
}

function initMegaWhiteboard(){
  const canvas=$('#megaWhiteboard');
  if(!canvas||canvas.dataset.ready==='1') return;
  canvas.dataset.ready='1';
  const ctx=canvas.getContext('2d');
  let drawing=false,last=null;
  const point=event=>{
    const rect=canvas.getBoundingClientRect();
    const source=event.touches?.[0]||event;
    return {
      x:(source.clientX-rect.left)/rect.width,
      y:(source.clientY-rect.top)/rect.height
    };
  };
  const start=e=>{drawing=true;last=point(e);e.preventDefault()};
  const move=e=>{
    if(!drawing||!last)return;
    const next=point(e);
    drawWhiteboardStroke({from:last,to:next});
    socket.emit('mega-whiteboard-stroke',{
      serverId:state.serverId,stroke:{from:last,to:next}
    });
    last=next;e.preventDefault();
  };
  const stop=()=>{drawing=false;last=null};
  canvas.addEventListener('pointerdown',start);
  canvas.addEventListener('pointermove',move);
  window.addEventListener('pointerup',stop);
}
function drawWhiteboardStroke(stroke){
  const canvas=$('#megaWhiteboard');if(!canvas||!stroke)return;
  const ctx=canvas.getContext('2d');
  ctx.strokeStyle='#111';ctx.lineWidth=3;ctx.lineCap='round';
  ctx.beginPath();
  ctx.moveTo(stroke.from.x*canvas.width,stroke.from.y*canvas.height);
  ctx.lineTo(stroke.to.x*canvas.width,stroke.to.y*canvas.height);
  ctx.stroke();
}
function clearWhiteboardLocal(){
  const canvas=$('#megaWhiteboard');if(!canvas)return;
  canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);
}

async function testMedia(){
  try{
    const quality=state.cameraQuality==='720p'
      ? {width:{ideal:1280},height:{ideal:720}}
      : {width:{ideal:1920},height:{ideal:1080}};
    const stream=await navigator.mediaDevices.getUserMedia({
      audio:true,video:{...quality,frameRate:{ideal:30,max:30}}
    });
    const preview=$('#megaMediaPreview');
    preview.srcObject=stream;
    preview.style.filter=$('#megaBlurPreview').checked?'blur(8px)':'none';
    setTimeout(()=>stream.getTracks().forEach(t=>t.stop()),15000);
    toast('Teste de mídia iniciado');
  }catch{toast('Não foi possível acessar câmera/microfone')}
}

function toggleLiveCaptions(){
  const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SpeechRecognition){
    toast('Legendas não disponíveis neste navegador');
    return;
  }
  if(state.captionRecognition){
    try{state.captionRecognition.stop()}catch{}
    state.captionRecognition=null;
    $('#megaCaptionBox').textContent='Legendas desativadas.';
    return;
  }
  const rec=new SpeechRecognition();
  rec.continuous=true;rec.interimResults=true;rec.lang='pt-BR';
  rec.onresult=event=>{
    let text='';
    for(let i=event.resultIndex;i<event.results.length;i++) text+=event.results[i][0].transcript+' ';
    $('#megaCaptionBox').textContent=text.trim()||'Ouvindo...';
  };
  rec.onend=()=>{if(state.captionRecognition===rec){try{rec.start()}catch{}}};
  rec.start();
  state.captionRecognition=rec;
  $('#megaCaptionBox').textContent='Ouvindo...';
}

function toggleLocalRecording(){
  if(state.localRecorder && state.localRecorder.state!=='inactive'){
    state.localRecorder.stop();return;
  }
  if(!state.localStream){toast('Entre em uma call primeiro');return}
  try{
    const recorder=new MediaRecorder(state.localStream);
    state.localRecordChunks=[];
    recorder.ondataavailable=e=>{if(e.data?.size)state.localRecordChunks.push(e.data)};
    recorder.onstop=()=>{
      const blob=new Blob(state.localRecordChunks,{type:recorder.mimeType||'video/webm'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');a.href=url;a.download='concorde-gravacao-'+Date.now()+'.webm';a.click();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      $('#megaRecordBtn').textContent='⏺ Gravar minha mídia';
    };
    recorder.start(1000);
    state.localRecorder=recorder;
    $('#megaRecordBtn').textContent='⏹ Parar gravação';
    socket.emit('mega-recording-notice',{serverId:state.activeVoiceServerId||state.serverId});
  }catch{toast('Gravação indisponível')}
}

async function updateMegaConnectionInfo(){
  const pcs=[...state.peers.values()];
  if(!pcs.length){
    $('#megaConnectionInfo').textContent='Sem conexão WebRTC ativa.';
    return;
  }

  const rows=[];
  for(const pc of pcs){
    let rtt=null,candidate='';
    try{
      const stats=await pc.getStats();
      stats.forEach(report=>{
        if(report.type==='candidate-pair' && report.state==='succeeded' && report.nominated){
          if(Number.isFinite(report.currentRoundTripTime)) rtt=Math.round(report.currentRoundTripTime*1000);
        }
        if(report.type==='local-candidate' && !candidate){
          candidate=report.candidateType||'';
        }
      });
    }catch{}
    const stateText=pc.connectionState||pc.iceConnectionState||'desconhecido';
    rows.push(stateText+(rtt!==null?' · '+rtt+' ms':'')+(candidate?' · '+candidate:''));
  }
  $('#megaConnectionInfo').textContent='Conexão: '+rows.join(' | ');
}

function startPomodoro(){
  clearInterval(state.pomodoroTimer);
  let seconds=Math.max(60,Math.min(10800,Number($('#megaPomodoroMinutes').value||25)*60));
  const render=()=>{
    const m=Math.floor(seconds/60).toString().padStart(2,'0');
    const s=(seconds%60).toString().padStart(2,'0');
    $('#megaPomodoroDisplay').textContent=m+':'+s;
  };
  render();
  state.pomodoroTimer=setInterval(()=>{
    seconds--;render();
    if(seconds<=0){
      clearInterval(state.pomodoroTimer);state.pomodoroTimer=null;
      playCallCue('join');toast('Pomodoro concluído');
    }
  },1000);
}

function runLocalBot(){
  const input=$('#megaBotCommand');
  const cmd=String(input.value||'').trim();
  let out='';
  if(cmd==='/roll') out='🎲 '+(1+Math.floor(Math.random()*6));
  else if(cmd==='/coin') out=Math.random()<.5?'🪙 Cara':'🪙 Coroa';
  else if(cmd==='/welcome') out='👋 Bem-vindo ao servidor!';
  else if(cmd.startsWith('/8ball')) {
    const answers=['Sim','Não','Provavelmente','Melhor perguntar depois','Com certeza','Pouco provável'];
    out='🎱 '+answers[Math.floor(Math.random()*answers.length)];
  } else if(cmd.startsWith('/say ')){
    out='🤖 '+cmd.slice(5,300);
  } else out='Comandos: /roll, /coin, /8ball pergunta, /welcome, /say texto';
  $('#megaBotOutput').innerHTML='<div class="megaItem"></div>';
  $('#megaBotOutput').firstElementChild.textContent=out;
}

function openProfileModal(){
  if(!state.profileReady || !state.userId){
    toast('Entre na sua conta primeiro');
    return;
  }

  state.pendingAvatar = state.avatar || '';
  state.pendingBanner = state.banner || '';
  state.pendingTheme = normalizeProfileTheme(state.theme);
  state.pendingPalette = normalizeProfilePalette(state.palette);
  state.pendingCustomColor = state.customColor || '';
  $('#profileNameInput').value=state.username||'';
  $('#profileDisplayNameInput').value=state.displayName||state.username||'';
  $('#profileStatusSelect').value=state.status||'online';
  $('#profileBioInput').value=state.bio||'';
  $('#profileBannerPreview').style.backgroundImage=state.pendingBanner?'url("' + state.pendingBanner.replace(/"/g,'') + '")':'';
  $('#profilePhotoInput').value = '';

  applyAvatar(
    $('#profileAvatarPreview'),
    {username:state.username,avatar:state.pendingAvatar},
    state.username
  );

  updateProfileThemeButtons();
  updateProfilePaletteButtons();
  updateCustomColorUI(state.pendingCustomColor || '#ff6b4a');
  updateHotkeySettingsUI();
  setProfileTab('profile');
  $('#profileModalWrap').classList.remove('hidden');
}

function closeProfileModal(){
  cancelHotkeyCapture();
  $('#profileModalWrap').classList.add('hidden');

  if(state.pendingTheme !== null){
    applyProfileTheme(state.theme);
  }

  if(state.pendingPalette !== null){
    applyProfilePalette(state.palette);
  }

  if(state.pendingCustomColor !== null){
    applyCustomColor(state.customColor);
  }

  state.pendingAvatar = null;
  state.pendingBanner = null;
  state.pendingTheme = null;
  state.pendingPalette = null;
  state.pendingCustomColor = null;
}

function fileToAvatar(file){
  return new Promise((resolve,reject)=>{
    if(!file){
      resolve('');
      return;
    }
    if(file.type==='image/gif' && file.size<=340000){
      const reader=new FileReader();reader.onerror=()=>reject(new Error('Não foi possível ler o GIF'));reader.onload=()=>resolve(String(reader.result||''));reader.readAsDataURL(file);return;
    }

    const reader = new FileReader();

    reader.onerror = ()=>reject(new Error('Não foi possível ler a imagem'));

    reader.onload = ()=>{
      const img = new Image();

      img.onerror = ()=>reject(new Error('Imagem inválida'));

      img.onload = ()=>{
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;

        const ctx = canvas.getContext('2d');
        const sourceSize = Math.min(img.naturalWidth,img.naturalHeight);
        const sx = Math.max(0,(img.naturalWidth-sourceSize)/2);
        const sy = Math.max(0,(img.naturalHeight-sourceSize)/2);

        ctx.drawImage(
          img,
          sx,sy,sourceSize,sourceSize,
          0,0,size,size
        );

        resolve(canvas.toDataURL('image/jpeg',0.82));
      };

      img.src = reader.result;
    };

    reader.readAsDataURL(file);
  });
}

function saveProfile(){
  const username=$('#profileNameInput').value.trim().slice(0,30);
  const displayName=$('#profileDisplayNameInput').value.trim().slice(0,40);
  const bio=$('#profileBioInput').value.trim().slice(0,300);
  const status=$('#profileStatusSelect').value;

  if(!username){
    toast('Digite um nome');
    return;
  }

  state.theme = normalizeProfileTheme(state.pendingTheme || state.theme);
  localStorage.setItem('ecord-theme',state.theme);
  applyProfileTheme(state.theme);
  state.pendingTheme = null;

  state.palette = normalizeProfilePalette(state.pendingPalette || state.palette);
  localStorage.setItem('ecord-palette',state.palette);
  applyProfilePalette(state.palette);
  state.pendingPalette = null;

  state.customColor = state.pendingCustomColor || '';
  if(state.customColor){
    localStorage.setItem('ecord-custom-color',state.customColor);
  }else{
    localStorage.removeItem('ecord-custom-color');
  }
  applyCustomColor(state.customColor);
  state.pendingCustomColor = null;

  socket.emit('set-profile',{
    username,displayName:displayName||username,bio,status,
    avatar:String(state.pendingAvatar||'').slice(0,350000),
    banner:String(state.pendingBanner||'').slice(0,350000),
    knownServerIds:getCachedServers().map(server=>server.id)
  });
}

function safeServerSnapshot(serverData){
  if(!serverData?.id) return null;

  return {
    id:String(serverData.id),
    ownerId:String(serverData.ownerId || '').slice(0,100),
    members:Array.isArray(serverData.members)
      ? serverData.members.map(value=>String(value||'').slice(0,100)).filter(Boolean)
      : [],
    inviteToken:String(serverData.inviteToken || '').slice(0,100),
    name:String(serverData.name || 'Servidor').slice(0,30),
    icon:String(serverData.icon || '').slice(0,350000),
    accent:/^#[0-9a-f]{6}$/i.test(String(serverData.accent||'')) ? String(serverData.accent) : '#ff6b4a',
    description:String(serverData.description || '').slice(0,240),
    tags:Array.isArray(serverData.tags)
      ? serverData.tags.map(tag=>String(tag||'').slice(0,22)).filter(Boolean).slice(0,5)
      : [],
    textChannels:Array.isArray(serverData.textChannels)
      ? serverData.textChannels.map(c=>({
          id:String(c.id),
          name:String(c.name||'chat').slice(0,30),
          categoryId:c.categoryId ? String(c.categoryId) : null,
          order:Number.isFinite(Number(c.order)) ? Number(c.order) : 0
        }))
      : [],
    voiceChannels:Array.isArray(serverData.voiceChannels)
      ? serverData.voiceChannels.map(c=>({
          id:String(c.id),
          name:String(c.name||'Voz').slice(0,30),
          categoryId:c.categoryId ? String(c.categoryId) : null,
          order:Number.isFinite(Number(c.order)) ? Number(c.order) : 0,
          mode:c.mode === 'stage' ? 'stage' : 'voice'
        }))
      : [],
    categories:Array.isArray(serverData.categories)
      ? serverData.categories.map(category=>({
          id:String(category.id),
          name:String(category.name||'Categoria').slice(0,30),
          order:Number.isFinite(Number(category.order)) ? Number(category.order) : 0
        }))
      : [],
    roles:Array.isArray(serverData.roles)
      ? serverData.roles.map(role=>({
          id:String(role.id),
          name:String(role.name||'Cargo').slice(0,30),
          color:/^#[0-9a-f]{6}$/i.test(String(role.color||'')) ? String(role.color) : '#ff6b4a',
          members:Array.isArray(role.members)
            ? role.members.map(name=>String(name||'').slice(0,30)).filter(Boolean).slice(0,100)
            : [],
          permissions:{
            administrator:!!role.permissions?.administrator,
            manageServer:!!role.permissions?.manageServer,
            manageChannels:!!role.permissions?.manageChannels,
            manageRoles:!!role.permissions?.manageRoles
          }
        }))
      : [],
    rules:String(serverData.rules||'').slice(0,4000),
    banner:String(serverData.banner||'').slice(0,350000),
    inviteExpiresAt:Number(serverData.inviteExpiresAt||0),
    bans:Array.isArray(serverData.bans)?serverData.bans.map(String).slice(0,500):[],
    mutes:Array.isArray(serverData.mutes)?serverData.mutes.map(String).slice(0,500):[],
    channelPolicies:serverData.channelPolicies&&typeof serverData.channelPolicies==='object'?serverData.channelPolicies:{},
    pinned:Array.isArray(serverData.pinned)?serverData.pinned.slice(-200):[],
    events:Array.isArray(serverData.events)?serverData.events.slice(-200):[],
    polls:Array.isArray(serverData.polls)?serverData.polls.slice(-200):[],
    watchParty:serverData.watchParty&&typeof serverData.watchParty==='object'?serverData.watchParty:{url:'',position:0,playing:false,updatedAt:0},
    creative:serverData.creative&&typeof serverData.creative==='object'?serverData.creative:{}
  };
}

function getCachedServers(){
  const parseCache = value => {
    try{
      const parsed=JSON.parse(value || '[]');

      return Array.isArray(parsed)
        ? parsed.map(safeServerSnapshot).filter(Boolean)
        : [];
    }catch{
      return [];
    }
  };

  const primary=parseCache(localStorage.getItem('ecord-server-cache'));
  const backup=parseCache(localStorage.getItem('ecord-server-backup'));
  const recovery=(()=>{
    try{
      const snapshot=JSON.parse(localStorage.getItem('acord-recovery-v1') || 'null');

      return Array.isArray(snapshot?.servers)
        ? snapshot.servers.map(safeServerSnapshot).filter(Boolean)
        : [];
    }catch{
      return [];
    }
  })();

  const merged=new Map();

  // Recovery é o mais antigo; backup e cache atual têm prioridade.
  for(const server of recovery){
    if(server?.id) merged.set(server.id,server);
  }

  for(const server of backup){
    if(server?.id) merged.set(server.id,server);
  }

  for(const server of primary){
    if(server?.id) merged.set(server.id,server);
  }

  return [...merged.values()];
}

function cacheServers(list){
  try{
    const incoming=(Array.isArray(list) ? list : [])
      .map(safeServerSnapshot)
      .filter(Boolean);

    const previous=getCachedServers();
    const merged=new Map();

    for(const server of previous){
      if(server?.id) merged.set(server.id,server);
    }

    for(const server of incoming){
      if(server?.id) merged.set(server.id,server);
    }

    const safe=[...merged.values()];
    const payload=JSON.stringify(safe);

    // Nunca substitui um backup cheio por uma resposta vazia/incompleta.
    if(safe.length){
      localStorage.setItem('ecord-server-cache',payload);
      localStorage.setItem('ecord-server-backup',payload);
    }

    if(state.profileReady){
      saveLocalRecoverySnapshot();
    }
  }catch(error){
    console.warn('Não foi possível salvar o backup local dos servidores',error);
  }
}

function replaceServerCacheFromCloud(list){
  try{
    const safe=(Array.isArray(list)?list:[]).map(safeServerSnapshot).filter(Boolean);
    const payload=JSON.stringify(safe);
    localStorage.setItem('ecord-server-cache',payload);
    localStorage.setItem('ecord-server-backup',payload);
    if(state.profileReady)saveLocalRecoverySnapshot();
  }catch(error){console.warn('Não foi possível atualizar o cache canônico dos servidores',error);}
}

function syncOwnedServersToBackend(force=false){
  if(!state.profileReady || !state.userId || !socket.connected) return;

  const now=Date.now();

  if(!force && now-state.lastOwnedServerSyncAt<2500){
    return;
  }

  const cached=getCachedServers();

  const owned=cached
    .filter(server=>String(server?.ownerId || '')===String(state.userId))
    .map(safeServerSnapshot)
    .filter(Boolean)
    .slice(0,100);

  state.lastOwnedServerSyncAt=now;

  if(!owned.length) return;

  socket.emit('sync-owned-servers',{
    servers:owned
  });
}


function pendingServerInviteToken(){
  try{
    const params=new URLSearchParams(location.search);
    const queryToken=String(params.get('invite') || '').trim();

    if(queryToken) return queryToken.slice(0,100);

    const match=location.pathname.match(/^\/invite\/([A-Za-z0-9_-]{10,100})\/?$/);
    return match ? String(match[1] || '').slice(0,100) : '';
  }catch{
    return '';
  }
}

function clearServerInviteFromUrl(){
  try{
    const clean=new URL(location.origin + '/');
    history.replaceState(null,'',clean);
  }catch{}
}

function handlePendingServerInvite(){
  if(state.privateInviteHandled || !state.profileReady || !(state.authToken||state.cookieSession)) return;

  const token=pendingServerInviteToken();
  if(!token) return;

  state.privateInviteHandled=true;
  socket.emit('join-server-invite',{token});
}

function currentServer(){
  return state.servers.find(s=>s.id===state.serverId) || null;
}

function currentText(){
  return currentServer()?.textChannels.find(c=>c.id===state.textChannelId) || null;
}

function currentVoice(){
  return currentServer()?.voiceChannels.find(c=>c.id===state.voiceChannelId) || null;
}

function setAppMode(mode){
  const app = $('#appShell');
  if(!app) return;

  const hub = mode === 'hub';
  const privateCall = mode === 'private-call';
  const server = !hub && !privateCall;

  app.classList.toggle('hubMode',hub);
  app.classList.toggle('serverMode',server);
  app.classList.toggle('privateCallMode',privateCall);

  $('#homeHubBtn')?.classList.toggle('active',hub || privateCall);

  if(hub || privateCall){
    document.querySelectorAll('#serverRail .serverIcon').forEach(btn=>{
      btn.classList.remove('active');
    });
  }
}



function syncVoiceControlsUI(){
  const controls = $('#voiceControls');
  const joinBtn = $('#joinVoiceBtn');
  if(!controls || !joinBtn) return;

  const inCall = !!state.joinedVoiceId;

  if(!inCall){
    controls.classList.add('hidden');
    joinBtn.classList.remove('hidden');
    joinBtn.textContent = 'Entrar na voz';
    return;
  }

  // Se o usuário está na tela de voz e existe uma chamada ativa,
  // os controles nunca devem desaparecer por causa de re-renderizações.
  if(state.currentView === 'voice'){
    controls.classList.remove('hidden');

    const viewingActiveChannel =
      !!state.privateCallId ||
      (
        state.activeVoiceServerId === state.serverId &&
        state.activeVoiceChannelId === state.voiceChannelId
      );

    if(viewingActiveChannel){
      joinBtn.classList.add('hidden');
    }else{
      joinBtn.classList.remove('hidden');
      joinBtn.textContent = 'Trocar para este canal';
    }
  }else{
    controls.classList.add('hidden');
  }
}

function updateCallDock(){
  const dock = $('#activeCallDock');
  if(!dock) return;

  const inCall = !!state.joinedVoiceId;
  const viewingCall = state.currentView === 'voice';

  dock.classList.toggle('hidden', !inCall || viewingCall);

  if(!inCall) return;

  let label = state.activeVoiceName || 'Call ativa';

  if(state.privateCallId && state.privatePeerName){
    label = 'Chamada com ' + state.privatePeerName;
  }

  $('#activeCallDockText').textContent = label;
}

function returnToActiveCall(){
  if(!state.joinedVoiceId) return;

  if(state.privateCallId){
    setView('voice');
    setAppMode('private-call');
    $('#voiceTitle').textContent = 'Chamada privada com ' + (state.privatePeerName || 'Amigo');
    $('#topTitle').textContent = '☎ Chamada privada';
    $('#topSub').textContent = 'Somente você e ' + (state.privatePeerName || 'seu amigo');
    $('#quickInviteBtn')?.classList.add('hidden');
    updateCallDock();
    return;
  }

  const activeServer = state.servers.find(
    server => server.id === state.activeVoiceServerId
  );

  if(activeServer){
    state.serverId = activeServer.id;

    const activeChannel = activeServer.voiceChannels?.find(
      channel => channel.id === state.activeVoiceChannelId
    );

    if(activeChannel){
      state.voiceChannelId = activeChannel.id;
      state.activeVoiceName = activeChannel.name || state.activeVoiceName;
    }

    renderServers();
    renderSidebar();
  }

  setView('voice');

  if(state.activeVoiceName){
    $('#voiceTitle').textContent = state.activeVoiceName;
  }

  $('#voiceStatus').textContent = 'Conectado';
  syncVoiceControlsUI();
  updateCallDock();
}

function setView(name){
  state.currentView = name;
  localStorage.setItem('ecord-last-view',name);

  const hubView =
    name==='friends' ||
    name==='dm' ||
    (name==='mega' && !state.megaFromServer);
  const privateCallView = name==='voice' && !!state.privateCallId;

  if(privateCallView){
    setAppMode('private-call');
  }else if(hubView){
    setAppMode('hub');
  }else{
    setAppMode('server');
  }

  $('#homeView').classList.toggle('hidden', name!=='home');
  $('#friendsView').classList.toggle('hidden', name!=='friends');
  $('#dmView').classList.toggle('hidden', name!=='dm');
  $('#megaView').classList.toggle('hidden', name!=='mega');
  $('#rolesView').classList.toggle('hidden', name!=='roles');
  $('#serverSettingsView').classList.toggle('hidden', name!=='settings');
  $('#chatView').classList.toggle('hidden', name!=='chat');
  $('#voiceView').classList.toggle('hidden', name!=='voice');

  $('#homeHubBtn')?.classList.toggle('active', hubView);

  document.querySelectorAll('#serverRail .serverIcon').forEach(btn=>{
    if(hubView) btn.classList.remove('active');
  });

  $('#hubFriendsBtn')?.classList.toggle('active', name==='friends');
  $('#hubMessagesBtn')?.classList.toggle('active', name==='dm');
  $('#concordePlusBtn')?.classList.toggle(
    'active',
    name==='mega' && !state.megaFromServer
  );

  $('#serverConcordeBtn')?.classList.toggle(
    'active',
    name==='mega' && state.megaFromServer
  );

  $('#serverRolesBtn')?.classList.toggle('active', name==='roles');

  if(name==='home'){
    $('#topTitle').textContent = currentServer()?.name || 'Acord';
    $('#topSub').textContent = 'servidor';
  }

  if(name==='friends'){
    state.megaFromServer=false;
    $('#topTitle').textContent = '👥 Amigos';
    $('#topSub').textContent = 'seus amigos e chamadas';
    renderFriends();
  }

  if(name==='dm'){
    state.megaFromServer=false;
    const groupsOnly=state.dmContactsMode==='groups';

    $('#topTitle').textContent=groupsOnly
      ? '👥 Grupos privados'
      : '✉ Mensagens privadas';

    $('#topSub').textContent=groupsOnly
      ? 'seus grupos e chamadas privadas'
      : 'conversas entre amigos';

    renderDmContacts();
  }

  if(name==='roles'){
    $('#topTitle').textContent = '🛡 Cargos';
    $('#topSub').textContent = currentServer()?.name || '';
    renderRoles();
  }

  if(name==='mega' && state.megaFromServer){
    $('#topTitle').textContent='✦ Concorde+ · ' + (currentServer()?.name || 'Servidor');
    $('#topSub').textContent='ferramentas e recursos deste servidor';
    $('#quickInviteBtn')?.classList.remove('hidden');
    renderMegaServerControls();
    renderMegaCommunity();
  }

  if(name==='settings'){
    $('#topTitle').textContent = 'Configurações do servidor';
    $('#topSub').textContent = currentServer()?.name || '';
    openServerSettings();
  }

  if(name==='chat'){
    const c = currentText();
    $('#topTitle').textContent = c ? '# '+c.name : '# chat';
    $('#topSub').textContent = currentServer()?.name || '';
  }

  if(name==='voice'){
    if(state.privateCallId){
      $('#topTitle').textContent='☎ Chamada privada';
      $('#topSub').textContent=state.privatePeerName || '';
    }else{
      const c=currentVoice();
      const isStage=c?.mode==='stage';

      $('#topTitle').textContent=c
        ? (isStage ? '◉ ' : ')) ') + c.name
        : ')) voz';

      $('#topSub').textContent=isStage
        ? 'Palco · ' + (currentServer()?.name || '')
        : (currentServer()?.name || '');
    }
  }else if(isServerView(name)){
    renderServerPresence();
  }

  syncVoiceControlsUI();

  updateCallDock();
  updateMobileNav();
  applyMobileCallMode();
}



function isServerView(view = state.currentView){
  return ['home','roles','settings','chat','voice'].includes(view);
}

function restoreCurrentView(){
  const view = state.currentView || 'friends';

  if(!state.appInitialized && isServerView(view)){
    return;
  }

  if(view === 'friends'){
    setView('friends');
    renderFriends();
    return;
  }

  if(view === 'dm'){
    setView('dm');
    renderDmContacts();
    return;
  }

  const server = state.servers.find(item=>item.id===state.serverId);

  if(!server){
    if(state.appInitialized) setView('friends');
    return;
  }

  setAppMode('server');

  if(view === 'chat'){
    const channel = server.textChannels?.find(item=>item.id===state.textChannelId);

    if(channel){
      setView('chat');
      $('#chatTitle').textContent=channel.name;
      $('#messageInput').placeholder='Mensagem em #' + channel.name;

      socket.emit('join-text',{
        serverId:state.serverId,
        channelId:channel.id
      });

      return;
    }

    const fallback=server.textChannels?.[0];

    if(fallback){
      state.textChannelId=fallback.id;
      localStorage.setItem('ecord-last-text-channel-id',fallback.id);
      selectText(fallback.id);
      return;
    }
  }

  if(view === 'voice'){
    const channel = server.voiceChannels?.find(item=>item.id===state.voiceChannelId);

    setView('voice');

    if(channel){
      $('#voiceTitle').textContent=channel.name;

      if(state.joinedVoiceId){
        const activeHere =
          !!state.privateCallId ||
          (
            state.activeVoiceServerId === state.serverId &&
            state.activeVoiceChannelId === channel.id
          );

        $('#voiceStatus').textContent = activeHere
          ? 'Conectado'
          : 'Você já está em outra call';
      }else{
        $('#voiceStatus').textContent='Fora da chamada';
      }

      syncVoiceControlsUI();
    }

    return;
  }

  if(view === 'roles'){
    setView('roles');
    renderRoles();
    return;
  }

  if(view === 'settings'){
    setView('settings');
    openServerSettings();
    return;
  }

  setView('home');
}

function renderServers(){
  const rail = $('#serverRail');
  rail.innerHTML = '';
  state.servers.forEach(s=>{
    const b = document.createElement('button');
    const hubVisible =
      state.currentView==='friends' ||
      state.currentView==='dm' ||
      (state.currentView==='mega' && !state.megaFromServer);
    b.className = 'serverIcon' + (s.id===state.serverId && !hubVisible ? ' active' : '');
    b.title = s.name;

    if(s.icon){
      b.textContent = '';
      b.style.backgroundImage = 'url("' + String(s.icon).replace(/"/g,'') + '")';
      b.style.backgroundSize = 'cover';
      b.style.backgroundPosition = 'center';
    }else{
      b.textContent = initials(s.name);
      b.style.backgroundImage = '';
      if(s.accent) b.style.backgroundColor = s.accent;
    }
    b.addEventListener('click', ()=>selectServer(s.id));
    rail.appendChild(b);
  });
}

function updateServerBanner(){
  const server=currentServer();
  const side=document.querySelector('.sidebar');
  const head=document.querySelector('.sideHead');
  const dot=document.querySelector('.brandDot');
  if(!side || !head) return;

  side.style.backgroundImage='';

  if(server?.banner){
    head.style.backgroundImage=
      'linear-gradient(180deg,rgba(3,13,10,.18),rgba(6,18,14,.92)),url("'+
      String(server.banner).replace(/"/g,'')+
      '")';
  }else{
    head.style.backgroundImage=
      'radial-gradient(circle at 85% 0%,color-mix(in srgb,var(--mint) 22%,transparent),transparent 42%),'+
      'linear-gradient(145deg,var(--bg2),var(--bg1))';
  }

  head.style.backgroundSize='cover';
  head.style.backgroundPosition='center';

  if(dot){
    if(server?.icon){
      dot.style.backgroundImage='url("'+String(server.icon).replace(/"/g,'')+'")';
      dot.style.backgroundSize='cover';
      dot.style.backgroundPosition='center';
      dot.textContent='';
    }else{
      dot.style.backgroundImage='';
      dot.textContent=initials(server?.name||'A');
    }
  }
}

function renderSidebar(){
  updateServerBanner();
  const s = currentServer();

  if(!s){
    $('#serverTitle').textContent = 'Nenhum servidor';
    $('#channelTree').innerHTML = '';
    $('#inviteBtn').disabled = true;
    $('#serverSettingsBtn').disabled = true;
    $('#serverConcordeBtn').disabled = true;
    $('#deleteServerBtn').disabled = true;
    return;
  }

  $('#inviteBtn').disabled = false;
  $('#serverSettingsBtn').disabled = false;
  $('#serverConcordeBtn').disabled = false;
  $('#deleteServerBtn').disabled = false;
  $('#serverTitle').textContent = s.name;

  const serverProfiles=serverMemberProfiles(s);
  const onlineCount=serverProfiles.filter(profile=>profile.online).length;
  const serverMeta=$('#serverHeroMeta');
  if(serverMeta){
    serverMeta.textContent=
      serverProfiles.length+
      (serverProfiles.length===1?' membro':' membros')+
      ' · '+
      onlineCount+
      (onlineCount===1?' online':' online');
  }

  const tree = $('#channelTree');
  tree.innerHTML = '';

  const categories = Array.isArray(s.categories)
    ? [...s.categories].sort((a,b)=>(a.order||0)-(b.order||0))
    : [];

  const textChannels = Array.isArray(s.textChannels)
    ? [...s.textChannels].sort((a,b)=>(a.order||0)-(b.order||0))
    : [];

  const voiceChannels = Array.isArray(s.voiceChannels)
    ? [...s.voiceChannels].sort((a,b)=>(a.order||0)-(b.order||0))
    : [];

  function dragData(event){
    try{
      return JSON.parse(event.dataTransfer.getData('application/x-ecord'));
    }catch{
      try{
        return JSON.parse(event.dataTransfer.getData('text/plain'));
      }catch{
        return null;
      }
    }
  }

  function setDragData(event,data){
    const raw = JSON.stringify(data);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-ecord',raw);
    event.dataTransfer.setData('text/plain',raw);
  }

  function sendMoveChannel(data,targetCategoryId,beforeChannelId=null){
    if(!data || data.kind!=='channel') return;

    socket.emit('move-channel',{
      serverId:state.serverId,
      type:data.type,
      channelId:data.channelId,
      targetCategoryId:targetCategoryId || null,
      beforeChannelId:beforeChannelId || null
    });
  }

  function makeChannelButton(channel,type){
    const isStage = type === 'voice' && channel.mode === 'stage';

    const b = document.createElement('button');
    b.className =
      'channelBtn' +
      (type==='voice' ? ' voice' : '') +
      (isStage ? ' stage' : '') +
      (
        (type==='text' && channel.id===state.textChannelId) ||
        (type==='voice' && channel.id===state.voiceChannelId)
          ? ' active'
          : ''
      );

    b.draggable = true;
    b.dataset.channelId = channel.id;
    b.dataset.channelType = type;

    const grip = document.createElement('span');
    grip.className = 'channelGrip';
    grip.textContent = '⠿';

    const icon = document.createElement('span');

    if(isStage){
      icon.className = 'stageIcon';
      icon.textContent = '◉';
    }else{
      icon.className = type==='text' ? 'hash' : '';
      icon.textContent = type==='text' ? '#' : '))';
    }

    if(isStage){
      const stageText = document.createElement('span');
      stageText.className = 'stageText';

      const title = document.createElement('strong');
      title.textContent = channel.name;

      const subtitle = document.createElement('small');
      subtitle.textContent = 'Eventos, painéis e conversas para uma plateia';

      stageText.append(title,subtitle);
      b.append(grip,icon,stageText);
    }else{
      const label = document.createElement('span');
      label.textContent = channel.name;
      label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;';
      b.append(grip,icon,label);

      if(type==='text'){
        const unread=Number(state.unreadCounts?.[unreadKey(state.serverId,channel.id)]||0);
        if(unread>0){
          const badge=document.createElement('span');badge.className='unreadBadge';badge.textContent=unread>99?'99+':String(unread);
          b.appendChild(badge);
        }
      }
    }

    if(canManageChannelsLocally()){
      const actions = document.createElement('span');
      actions.className = 'channelActions';

      const edit = document.createElement('span');
      edit.className = 'channelAction';
      edit.setAttribute('role','button');
      edit.setAttribute('tabindex','0');
      edit.textContent = '✎';
      edit.title = 'Editar nome';

      const requestEdit = async event=>{
        event.preventDefault();
        event.stopPropagation();

        const nextName=await appDialog({
          title:type==='text'?'Renomear chat':(isStage?'Renomear palco':'Renomear canal'),
          message:'Digite o novo nome.',
          value:channel.name||'',
          confirmText:'Salvar'
        });

        if(nextName===null) return;

        socket.emit('rename-channel',{
          serverId:state.serverId,
          type,
          channelId:channel.id,
          name:nextName
        });
      };

      edit.addEventListener('click',requestEdit);
      edit.addEventListener('keydown',event=>{
        if(event.key==='Enter' || event.key===' ') requestEdit(event);
      });

      const move = document.createElement('span');
      move.className = 'channelAction';
      move.setAttribute('role','button');
      move.setAttribute('tabindex','0');
      move.textContent = '⇄';
      move.title = 'Mover para outra categoria';

      const requestMove = async event=>{
        event.preventDefault();
        event.stopPropagation();

        const server=currentServer();
        const categories=Array.isArray(server?.categories)?server.categories:[];

        const options=[
          {id:null,name:'Sem categoria'},
          ...categories.map(category=>({id:category.id,name:category.name}))
        ];

        const textOptions=options
          .map((option,index)=>(index+1)+' · '+option.name)
          .join('\n');

        const choice=await appDialog({
          title:'Mover canal',
          message:'Escolha a categoria pelo número:\n'+textOptions,
          value:'1',
          confirmText:'Mover'
        });

        if(choice===null) return;

        const selectedIndex=Number(choice)-1;

        if(!Number.isInteger(selectedIndex)||selectedIndex<0||selectedIndex>=options.length){
          toast('Categoria inválida');
          return;
        }

        socket.emit('move-channel',{
          serverId:state.serverId,
          type,
          channelId:channel.id,
          targetCategoryId:options[selectedIndex].id,
          beforeChannelId:null
        });
      };

      move.addEventListener('click',requestMove);
      move.addEventListener('keydown',event=>{
        if(event.key==='Enter' || event.key===' ') requestMove(event);
      });

      const del = document.createElement('span');
      del.className = 'channelAction danger';
      del.setAttribute('role','button');
      del.setAttribute('tabindex','0');
      del.textContent = '🗑';
      del.title = type==='text' ? 'Excluir chat' : (isStage ? 'Excluir palco' : 'Excluir canal de voz');

      const requestDelete = async event=>{
        event.preventDefault();
        event.stopPropagation();

        const kind=type==='text'?'chat':(isStage?'palco':'canal de voz');
        const result=await appDialog({
          title:'Excluir '+kind,
          message:'Excluir "'+channel.name+'"? O histórico desse canal também será removido.',
          confirmText:'Excluir',
          danger:true
        });

        if(!result) return;

        socket.emit('delete-channel',{
          serverId:state.serverId,
          type,
          channelId:channel.id
        });
      };

      del.addEventListener('click',requestDelete);
      del.addEventListener('keydown',event=>{
        if(event.key==='Enter' || event.key===' ') requestDelete(event);
      });

      actions.append(edit,move,del);
      b.appendChild(actions);
    }

    b.addEventListener('click',()=>{
      if(type==='text') selectText(channel.id);
      else selectVoice(channel.id);
    });

    b.addEventListener('dragstart',event=>{
      b.classList.add('dragging');
      setDragData(event,{
        kind:'channel',
        type,
        channelId:channel.id
      });
    });

    b.addEventListener('dragend',()=>{
      b.classList.remove('dragging');
      document.querySelectorAll('.dragOver').forEach(el=>el.classList.remove('dragOver'));
    });

    b.addEventListener('dragover',event=>{
      const data = dragData(event);
      if(!data || data.kind!=='channel') return;
      event.preventDefault();
      b.classList.add('dragOver');
    });

    b.addEventListener('dragleave',()=>b.classList.remove('dragOver'));

    b.addEventListener('drop',event=>{
      event.preventDefault();
      b.classList.remove('dragOver');

      const data = dragData(event);
      if(!data || data.kind!=='channel') return;

      const categoryId = channel.categoryId || null;

      sendMoveChannel(
        data,
        categoryId,
        data.type===type ? channel.id : null
      );
    });

    return b;
  }

  function makeCategory(category,isUncategorized=false){
    const block = document.createElement('div');
    block.className = 'categoryBlock';

    const header = document.createElement('div');
    header.className = 'categoryHeader';

    const arrow = document.createElement('span');
    arrow.textContent = '⌄';

    const name = document.createElement('span');
    name.className = 'categoryName';
    name.textContent = isUncategorized ? 'Sem categoria' : category.name;

    header.append(arrow,name);

    if(!isUncategorized){
      header.draggable = true;

      if(canManageChannelsLocally()){
        const edit = document.createElement('button');
        edit.className = 'categoryEdit';
        edit.type = 'button';
        edit.textContent = '✎';
        edit.title = 'Editar nome da categoria';

        edit.addEventListener('click',async event=>{
          event.stopPropagation();

          const nextName=await appDialog({
            title:'Renomear categoria',
            message:'Digite o novo nome da categoria.',
            value:category.name||'',
            confirmText:'Salvar'
          });
          if(nextName===null) return;

          socket.emit('rename-category',{
            serverId:state.serverId,
            categoryId:category.id,
            name:nextName
          });
        });

        const del = document.createElement('button');
        del.className = 'categoryDelete';
        del.type = 'button';
        del.textContent = '🗑';
        del.title = 'Excluir categoria';

        del.addEventListener('click',async event=>{
          event.stopPropagation();

          const result=await appDialog({
            title:'Excluir categoria',
            message:'Excluir "'+category.name+'"? Os canais dela serão movidos para “Sem categoria”.',
            confirmText:'Excluir',
            danger:true
          });

          if(result){
            socket.emit('delete-category',{
              serverId:state.serverId,
              categoryId:category.id
            });
          }
        });

        header.append(edit,del);
      }

      header.addEventListener('dragstart',event=>{
        header.classList.add('dragging');
        setDragData(event,{
          kind:'category',
          categoryId:category.id
        });
      });

      header.addEventListener('dragend',()=>{
        header.classList.remove('dragging');
        document.querySelectorAll('.dragOver').forEach(el=>el.classList.remove('dragOver'));
      });
    }

    header.addEventListener('dragover',event=>{
      const data = dragData(event);
      if(!data) return;

      if(data.kind==='channel' || (!isUncategorized && data.kind==='category')){
        event.preventDefault();
        header.classList.add('dragOver');
      }
    });

    header.addEventListener('dragleave',()=>header.classList.remove('dragOver'));

    header.addEventListener('drop',event=>{
      event.preventDefault();
      header.classList.remove('dragOver');

      const data = dragData(event);
      if(!data) return;

      if(data.kind==='channel'){
        sendMoveChannel(
          data,
          isUncategorized ? null : category.id,
          null
        );
        return;
      }

      if(
        data.kind==='category' &&
        !isUncategorized &&
        data.categoryId !== category.id
      ){
        socket.emit('move-category',{
          serverId:state.serverId,
          categoryId:data.categoryId,
          beforeCategoryId:category.id
        });
      }
    });

    const channelsBox = document.createElement('div');
    channelsBox.className = 'categoryChannels';

    channelsBox.addEventListener('dragover',event=>{
      const data = dragData(event);
      if(data?.kind==='channel'){
        event.preventDefault();
        channelsBox.classList.add('dragOver');
      }
    });

    channelsBox.addEventListener('dragleave',()=>channelsBox.classList.remove('dragOver'));

    channelsBox.addEventListener('drop',event=>{
      event.preventDefault();
      channelsBox.classList.remove('dragOver');
      const data = dragData(event);

      sendMoveChannel(
        data,
        isUncategorized ? null : category.id,
        null
      );
    });

    const categoryId = isUncategorized ? null : category.id;

    textChannels
      .filter(channel => (channel.categoryId || null) === categoryId)
      .forEach(channel=>channelsBox.appendChild(makeChannelButton(channel,'text')));

    voiceChannels
      .filter(channel => (channel.categoryId || null) === categoryId)
      .forEach(channel=>channelsBox.appendChild(makeChannelButton(channel,'voice')));

    block.append(header,channelsBox);
    return block;
  }

  tree.appendChild(makeCategory({id:null,name:'Sem categoria'},true));

  categories.forEach(category=>{
    tree.appendChild(makeCategory(category,false));
  });
}



function serverMemberProfiles(server = currentServer()){
  if(!server) return [];

  const ids = [...new Set([
    server.ownerId,
    ...(server.members || [])
  ].filter(Boolean))];

  const byId = new Map((server.memberProfiles || []).map(profile=>[profile.id,profile]));

  return ids.map(memberId=>{
    const online = state.onlineUsers.find(user=>user.id===memberId);
    const cached = byId.get(memberId);

    return {
      id:memberId,
      username:online?.username || cached?.username || 'Membro',
      bio:online?.bio ?? cached?.bio ?? '',
      avatar:online?.avatar || cached?.avatar || '',
      online:!!online
    };
  });
}

function canManageRolesLocally(server = currentServer()){
  if(!server) return false;
  if(server.ownerId === state.userId) return true;

  const username = String(state.username || '').toLowerCase();

  return (server.roles || []).some(role=>{
    const hasRole = (role.members || []).some(
      member=>String(member || '').toLowerCase() === username
    );

    return hasRole && (
      role.permissions?.administrator ||
      role.permissions?.manageRoles
    );
  });
}

function canManageChannelsLocally(server = currentServer()){
  if(!server) return false;
  if(server.ownerId === state.userId) return true;

  const username = String(state.username || '').toLowerCase();

  return (server.roles || []).some(role=>{
    const hasRole = (role.members || []).some(
      member=>String(member || '').toLowerCase() === username
    );

    return hasRole && (
      role.permissions?.administrator ||
      role.permissions?.manageServer ||
      role.permissions?.manageChannels
    );
  });
}

function renderServerPresence(){
  const server = currentServer();
  const box = $('#members');
  if(!server || !box) return;

  $('#rightTitle').textContent = 'Membros';

  const profiles = serverMemberProfiles(server);
  const online = profiles.filter(profile=>profile.online);
  const offline = profiles.filter(profile=>!profile.online);

  box.innerHTML = '';

  function section(title,items,isOffline){
    const wrap = document.createElement('div');
    wrap.className = 'serverPresenceSection';

    const heading = document.createElement('div');
    heading.className = 'serverPresenceTitle';
    heading.textContent = title + ' — ' + items.length;
    wrap.appendChild(heading);

    if(!items.length){
      const empty = document.createElement('div');
      empty.style.cssText='color:var(--low);font-size:10px;padding:6px 8px;';
      empty.textContent = isOffline ? 'Ninguém offline.' : 'Ninguém ativo agora.';
      wrap.appendChild(empty);
    }

    items.forEach(profile=>{
      const row = document.createElement('div');
      row.className = 'serverMemberRow' + (isOffline ? ' offline' : '');

      const avatarWrap = document.createElement('div');
      avatarWrap.className = 'serverMemberAvatar';

      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      applyAvatar(avatar,profile,profile.username);

      const dot = document.createElement('span');
      dot.className = 'serverMemberStatusDot';
      avatarWrap.append(avatar,dot);

      const meta = document.createElement('div');
      meta.className = 'serverMemberMeta';

      const name = document.createElement('strong');
      name.textContent = profile.username;

      const primary = primaryRoleForUser(profile.username);
      if(primary) name.style.color = primary.color;

      const status = document.createElement('span');
      status.textContent =
        profile.id === server.ownerId
          ? (isOffline ? 'Dono · Offline' : 'Dono · Online')
          : (isOffline ? 'Offline' : 'Online');

      meta.append(name,status);
      row.append(avatarWrap,meta);
      row.addEventListener('click',()=>openServerMemberProfile(profile.id));
      wrap.appendChild(row);
    });

    box.appendChild(wrap);
  }

  section('Ativos agora',online,false);
  section('Offline',offline,true);
}

function openServerMemberProfile(userId){
  const server = currentServer();
  if(!server) return;

  const profile = serverMemberProfiles(server).find(item=>item.id===userId);
  if(!profile) return;

  state.selectedServerMemberId = profile.id;
  $('#memberProfileName').textContent = profile.username;
  $('#memberProfileStatus').textContent =
    profile.online
      ? (profile.id === server.ownerId ? '● Online · Dono do servidor' : '● Online')
      : (profile.id === server.ownerId ? 'Offline · Dono do servidor' : 'Offline');

  $('#memberProfileStatus').style.color = profile.online ? 'var(--mint)' : 'var(--low)';
  $('#memberProfileBio').textContent = profile.bio || 'Sem bio.';
  applyAvatar($('#memberProfileAvatar'),profile,profile.username);
  renderMemberProfileRoles(profile);
  $('#memberProfileModalWrap').classList.remove('hidden');
}

function closeServerMemberProfile(){
  state.selectedServerMemberId = null;
  $('#memberProfileModalWrap').classList.add('hidden');
}

function renderMemberProfileRoles(profile){
  const server = currentServer();
  const box = $('#memberProfileRolesList');
  const hint = $('#memberProfileRolesHint');
  box.innerHTML = '';

  if(!server) return;

  const canEdit = canManageRolesLocally(server);
  const roles = Array.isArray(server.roles) ? server.roles : [];

  if(!roles.length){
    const empty = document.createElement('div');
    empty.style.cssText='color:var(--low);font-size:11px;padding:8px 0;';
    empty.textContent='Este servidor ainda não possui cargos.';
    box.appendChild(empty);
    hint.textContent = canEdit ? 'Crie cargos na área Cargos do servidor.' : '';
    return;
  }

  roles.forEach(role=>{
    const row = document.createElement('label');
    row.className = 'memberRoleToggle';

    const color = document.createElement('span');
    color.className = 'memberRoleColor';
    color.style.background = role.color || '#ff6b4a';

    const name = document.createElement('span');
    name.textContent = role.name;

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = (role.members || []).some(
      member=>String(member || '').toLowerCase() === String(profile.username || '').toLowerCase()
    );
    check.disabled = !canEdit;

    check.addEventListener('change',()=>{
      socket.emit('set-member-role',{
        serverId:server.id,
        roleId:role.id,
        userId:profile.id,
        enabled:check.checked
      });
    });

    row.append(color,name,check);
    box.appendChild(row);
  });

  hint.textContent = canEdit
    ? 'Marque ou desmarque os cargos para alterar este membro.'
    : 'Você pode ver os cargos, mas não tem permissão para alterá-los.';
}

function setServerSettingsPage(page){
  const pages = ['profile','members','roles','invites','security','delete'];

  pages.forEach(name=>{
    const id =
      name === 'profile' ? '#settingsProfilePage' :
      name === 'members' ? '#settingsMembersPage' :
      name === 'roles' ? '#settingsRolesPage' :
      name === 'invites' ? '#settingsInvitesPage' :
      name === 'security' ? '#settingsSecurityPage' :
      '#settingsDeletePage';

    $(id).classList.toggle('hidden',name !== page);
  });

  document.querySelectorAll('.settingsNavBtn').forEach(btn=>{
    btn.classList.toggle('active',btn.dataset.settingsPage === page);
  });

  if(page === 'members'){
    renderSettingsMembers();
  }
}

function updateServerSettingsPreview(){
  const server = currentServer();
  if(!server) return;

  const name = $('#serverSettingsName').value.trim() || 'Servidor';
  const description = $('#serverSettingsDescription').value.trim();
  const accent = state.serverSettingsAccent || '#ff6b4a';
  const icon = state.serverSettingsIcon || '';

  $('#serverPreviewBanner').style.background = accent;
  $('#serverPreviewName').textContent = name;
  $('#serverPreviewDescription').textContent =
    description || 'Seu servidor no Acord.';

  const iconPreview = $('#serverPreviewIcon');
  const settingsIcon = $('#serverSettingsIconPreview');

  [iconPreview,settingsIcon].forEach(el=>{
    if(icon){
      el.textContent = '';
      el.style.backgroundImage = 'url("' + icon.replace(/"/g,'') + '")';
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
    }else{
      el.style.backgroundImage = '';
      el.style.background = accent;
      el.textContent = initials(name);
    }
  });

  const tags = $('#serverSettingsTags').value
    .split(',')
    .map(item=>item.trim())
    .filter(Boolean)
    .slice(0,5);

  const tagsBox = $('#serverPreviewTags');
  tagsBox.innerHTML = '';

  tags.forEach(tag=>{
    const span = document.createElement('span');
    span.className = 'serverTag';
    span.textContent = tag;
    tagsBox.appendChild(span);
  });

  document.querySelectorAll('.accentChoice').forEach(btn=>{
    btn.classList.toggle(
      'active',
      String(btn.dataset.accent).toLowerCase() === accent.toLowerCase()
    );
  });
}

function openServerSettings(){
  const server = currentServer();
  if(!server) return;

  $('#settingsServerName').textContent = server.name;
  $('#serverSettingsName').value = server.name || '';
  $('#serverSettingsDescription').value = server.description || '';
  $('#serverSettingsTags').value = Array.isArray(server.tags)
    ? server.tags.join(', ')
    : '';

  state.serverSettingsIcon = server.icon || '';
  state.serverSettingsAccent = server.accent || '#ff6b4a';

  $('#serverSettingsIconInput').value = '';

  setServerSettingsPage('profile');
  updateServerSettingsPreview();
}

function renderSettingsMembers(){
  const box = $('#settingsMembersList');
  box.innerHTML = '';

  const server = currentServer();
  if(!server) return;

  const profiles = serverMemberProfiles(server);

  if(!profiles.length){
    const empty = document.createElement('div');
    empty.className='settingsCard';
    empty.style.color='var(--low)';
    empty.textContent='Nenhum membro encontrado.';
    box.appendChild(empty);
    return;
  }

  profiles
    .sort((a,b)=>Number(b.online)-Number(a.online) || a.username.localeCompare(b.username))
    .forEach(user=>{
      const row=document.createElement('div');
      row.className='settingsMember';
      row.style.cursor='pointer';
      row.style.opacity=user.online ? '1' : '.62';

      const avatar=document.createElement('div');
      avatar.className='avatar';
      applyAvatar(avatar,user,user.username);

      const meta=document.createElement('div');
      meta.style.flex='1';

      const role=primaryRoleForUser(user.username);
      const name=document.createElement('strong');
      name.textContent=user.username;

      if(role){
        name.style.color=role.color;
        const roleLine=document.createElement('div');
        roleLine.textContent='[' + role.name + ']';
        roleLine.style.cssText='font-size:10px;font-weight:900;color:' + role.color + ';margin-bottom:2px;';
        meta.append(roleLine,name);
      }else{
        meta.appendChild(name);
      }

      const status=document.createElement('div');
      status.style.cssText='font-size:11px;margin-top:2px;color:' + (user.online ? 'var(--mint)' : 'var(--low)') + ';';
      status.textContent =
        user.id===server.ownerId
          ? (user.online ? 'Dono do servidor · Online' : 'Dono do servidor · Offline')
          : (user.online ? '● Online' : 'Offline');

      meta.appendChild(status);
      row.append(avatar,meta);
      row.addEventListener('click',()=>openServerMemberProfile(user.id));
      box.appendChild(row);
    });
}


async function readServerIcon(file){
  if(!file) return '';

  const reader = new FileReader();

  return await new Promise((resolve,reject)=>{
    reader.onerror = ()=>reject(new Error('Erro ao ler imagem'));

    reader.onload = ()=>{
      const img = new Image();

      img.onerror = ()=>reject(new Error('Imagem inválida'));

      img.onload = ()=>{
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;

        const ctx = canvas.getContext('2d');
        const source = Math.min(img.naturalWidth,img.naturalHeight);
        const sx = (img.naturalWidth-source)/2;
        const sy = (img.naturalHeight-source)/2;

        ctx.drawImage(
          img,
          sx,sy,source,source,
          0,0,size,size
        );

        resolve(canvas.toDataURL('image/jpeg',0.82));
      };

      img.src = reader.result;
    };

    reader.readAsDataURL(file);
  });
}

function saveServerSettings(){
  const server = currentServer();
  if(!server) return;

  const name = $('#serverSettingsName').value.trim().slice(0,30);

  if(!name){
    toast('Digite um nome para o servidor');
    return;
  }

  const tags = $('#serverSettingsTags').value
    .split(',')
    .map(tag=>tag.trim().slice(0,22))
    .filter(Boolean)
    .slice(0,5);

  socket.emit('update-server-settings',{
    serverId:server.id,
    name,
    icon:state.serverSettingsIcon || '',
    accent:state.serverSettingsAccent || '#ff6b4a',
    description:$('#serverSettingsDescription').value.trim().slice(0,240),
    tags
  });
}

function selectServer(serverId){
  closeMobileServers();
  // Navegar para outro servidor não encerra a call atual.
  // A call só termina pelo botão "Sair" ou ao entrar deliberadamente em outra call.
  setAppMode('server');

  state.serverId = serverId;
  localStorage.setItem('ecord-last-server-id',serverId);
  localStorage.setItem('ecord-last-view','chat');

  const s = currentServer();

  const savedText = localStorage.getItem('ecord-server-' + serverId + '-text');
  const savedVoice = localStorage.getItem('ecord-server-' + serverId + '-voice');

  state.textChannelId =
    s?.textChannels?.some(channel=>channel.id===savedText)
      ? savedText
      : (s?.textChannels?.[0]?.id || null);

  state.voiceChannelId =
    s?.voiceChannels?.some(channel=>channel.id===savedVoice)
      ? savedVoice
      : (s?.voiceChannels?.[0]?.id || null);
  renderServers();
  renderSidebar();

  // Ao clicar no servidor, entra nele.
  // Se existir chat, abre o primeiro chat. Caso contrário, abre a tela inicial do servidor.
  const firstText = s?.textChannels?.[0]?.id || null;

  if(firstText){
    selectText(firstText);
  }else{
    setView('home');
  }

  setAppMode('server');
  renderServers();

  const url = new URL(location.href);
  url.searchParams.set('server', serverId);
  history.replaceState(null,'',url);
}

function clearTextJoinRetry(){
  if(state.textJoinTimer){
    clearTimeout(state.textJoinTimer);
    state.textJoinTimer=null;
  }

  state.textJoinAttempts=0;
  state.textJoinKey='';
}

function requestTextJoin(serverId,channelId){
  if(!serverId || !channelId || !socket.connected) return;

  const key=String(serverId)+':'+String(channelId);

  if(state.textJoinKey!==key){
    clearTextJoinRetry();
    state.textJoinKey=key;
  }

  state.textJoinAttempts+=1;

  socket.timeout(2200).emit(
    'join-text',
    {serverId,channelId},
    (error,response)=>{
      if(
        state.serverId!==serverId ||
        state.textChannelId!==channelId
      ){
        return;
      }

      if(!error && response?.ok){
        clearTextJoinRetry();

        if(Array.isArray(response.history)){
          showMessages(response.history);
        }

        $('#messageInput').disabled=false;
        $('#sendBtn').disabled=false;
        return;
      }

      // O usuário continua podendo escrever e enviar enquanto o backend
      // sincroniza o servidor/canal.
      $('#messageInput').disabled=false;
      $('#sendBtn').disabled=false;

      if(state.textJoinAttempts<4){
        state.textJoinTimer=setTimeout(()=>{
          // Se o servidor ainda estiver apenas no backup local, reenviamos ao backend.
          syncOwnedServersToBackend(true);
          requestTextJoin(serverId,channelId);
        },700 + state.textJoinAttempts*350);
      }else{
        clearTextJoinRetry();
        $('#messageInput').disabled=false;
        $('#sendBtn').disabled=false;
        toast(response?.error || 'Não foi possível abrir o chat. Tente novamente.');
      }
    }
  );
}


function selectText(channelId){
  closeMobileServers();
  $('#quickInviteBtn')?.classList.remove('hidden');
  setAppMode('server');

  state.textChannelId=channelId;
  clearUnread(state.serverId,channelId);

  localStorage.setItem('ecord-last-text-channel-id',channelId);

  if(state.serverId){
    localStorage.setItem(
      'ecord-server-' + state.serverId + '-text',
      channelId
    );
  }

  renderSidebar();

  const channel=currentText();

  $('#chatTitle').textContent=channel?.name || 'chat';
  $('#messageInput').placeholder=
    'Mensagem em #' + (channel?.name || 'chat');

  $('#messageInput').disabled=false;
  $('#sendBtn').disabled=false;
  $('#messages').innerHTML='';
  state.chatLoadedMessages=[];
  state.chatHistoryHasMore=false;
  state.chatHistoryLoading=false;
  state.chatHistoryOldestAt=null;

  setView('chat');

  socket.emit('public-chat-history',{
    serverId:state.serverId,
    channelId,
    limit:80
  });

  $('#messageInput').focus();
}

function selectVoice(channelId){
  closeMobileServers();
  clearTextJoinRetry();
  $('#quickInviteBtn')?.classList.remove('hidden');
  setAppMode('server');
  state.voiceChannelId = channelId;
  localStorage.setItem('ecord-last-voice-channel-id',channelId);

  if(state.serverId){
    localStorage.setItem('ecord-server-' + state.serverId + '-voice',channelId);
  }

  renderSidebar();

  const c = currentVoice();
  $('#voiceTitle').textContent =
    c?.mode === 'stage'
      ? '◉ ' + (c.name || 'Palco')
      : (c?.name || 'Voz');
  setView('voice');
  syncStageHandButton();

  const isActiveChannel =
    !!state.joinedVoiceId &&
    !state.privateCallId &&
    state.activeVoiceServerId === state.serverId &&
    state.activeVoiceChannelId === channelId;

  if(isActiveChannel){
    $('#voiceStatus').textContent = 'Conectado';
  }else if(state.joinedVoiceId){
    // A call antiga continua ativa. Os controles permanecem visíveis.
    $('#voiceStatus').textContent = 'Você já está em outra call';
  }else{
    $('#voiceStatus').textContent = 'Fora da chamada';
  }

  syncVoiceControlsUI();
  updateCallDock();
}

function showMessages(history){
  const box=$('#messages');
  box.innerHTML='';
  (Array.isArray(history) ? history : []).forEach(appendPublicChatMessage);
  box.scrollTop=box.scrollHeight;
}

function appendMessage(m){
  if(!m) return;

  const safeMessageId=String(m.id || '');

  if(
    safeMessageId &&
    document.querySelector(
      '#messages .message[data-message-id="' +
      safeMessageId.replace(/"/g,'') +
      '"]'
    )
  ){
    return;
  }

  const row=document.createElement('div');
  row.className='message'+(m.userId===state.userId || m.senderId===socket.id?' mine':'');
  row.dataset.messageId=safeMessageId;

  const avatar=document.createElement('div');
  avatar.className='avatar messageAvatar';
  const messageProfile=profileForName(m.username);
  applyAvatar(avatar,messageProfile,m.username||'Usuário');

  const body=document.createElement('div');
  body.className='messageBody';
  row.append(avatar,body);

  if(m.replyTo){
    const reply=document.createElement('div');reply.className='messageReply';
    reply.textContent='↪ Resposta a uma mensagem anterior';body.appendChild(reply);
  }

  const header=document.createElement('div');
  header.className='messageHeader';

  const strong=document.createElement('strong');
  const role=primaryRoleForUser(m.username);
  strong.textContent=role?'['+role.name+'] '+(m.username||'Usuário'):(m.username||'Usuário');
  if(role) strong.style.color=role.color;

  const time=document.createElement('time');
  time.className='messageTime';
  time.textContent=m.at
    ? new Date(m.at).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})
    : '';

  header.append(strong,time);

  const span=document.createElement('span');
  span.className='messageText';
  span.textContent=(m.text||'')+(m.edited?'  (editado)':'');
  body.append(header,span);

  if(m.attachment?.data){
    const image=document.createElement('img');image.className='messageAttachment';
    image.src=m.attachment.data;image.alt=m.attachment.name||'Imagem';body.appendChild(image);
  }

  const reactions=document.createElement('div');reactions.className='messageReactions';
  Object.entries(m.reactions||{}).forEach(([emoji,users])=>{
    if(!Array.isArray(users)||!users.length) return;
    const chip=document.createElement('button');chip.className='reactionChip';chip.textContent=emoji+' '+users.length;
    chip.addEventListener('click',()=>socket.emit('chat-react',{serverId:state.serverId,channelId:state.textChannelId,messageId:m.id,emoji}));
    reactions.appendChild(chip);
  });
  if(reactions.childElementCount) body.appendChild(reactions);

  const legacyUrlMatch=String(m.text||'').match(/https?:\/\/[^\s]+/i);
  if(legacyUrlMatch){
    try{
      const legacyUrl=new URL(legacyUrlMatch[0]);
      const looksLikeGif=
        /\.gif(?:$|[?#])/i.test(legacyUrl.pathname+legacyUrl.search) ||
        /(?:media\.)?tenor\.com$/i.test(legacyUrl.hostname) ||
        /giphy\.com/i.test(legacyUrl.hostname);

      if(looksLikeGif){
        const gif=document.createElement('img');
        gif.className='messageGif';
        gif.src=legacyUrlMatch[0];
        gif.alt='GIF';
        gif.loading='lazy';
        gif.referrerPolicy='no-referrer';
        gif.addEventListener('error',()=>gif.remove());
        body.appendChild(gif);
      }
    }catch{}
  }

  const actions=document.createElement('div');actions.className='messageActions';
  const replyBtn=document.createElement('button');replyBtn.textContent='↩';replyBtn.title='Responder';
  replyBtn.addEventListener('click',()=>{
    state.replyToMessageId=m.id;$('#replyBarText').textContent='Respondendo a '+(m.username||'Usuário');
    $('#replyBar').classList.remove('hidden');$('#messageInput').focus();
  });
  actions.appendChild(replyBtn);

  ['👍','❤️','😂','🔥'].forEach(emoji=>{
    const b=document.createElement('button');b.textContent=emoji;
    b.addEventListener('click',()=>socket.emit('chat-react',{serverId:state.serverId,channelId:state.textChannelId,messageId:m.id,emoji}));
    actions.appendChild(b);
  });

  if(m.userId===state.userId){
    const edit=document.createElement('button');edit.textContent='✎';edit.title='Editar';
    edit.addEventListener('click',async()=>{
      const value=await appDialog({
        title:'Editar mensagem',
        message:'Altere o texto da mensagem.',
        value:m.text||'',
        confirmText:'Salvar'
      });
      if(value===null)return;
      socket.emit('chat-edit',{serverId:state.serverId,channelId:state.textChannelId,messageId:m.id,text:value});
    });
    const remove=document.createElement('button');remove.textContent='🗑';remove.title='Excluir';
    remove.addEventListener('click',async()=>{
      const result=await appDialog({
        title:'Excluir mensagem',
        message:'Essa mensagem será removida do histórico.',
        confirmText:'Excluir',
        danger:true
      });
      if(result) socket.emit('chat-delete',{serverId:state.serverId,channelId:state.textChannelId,messageId:m.id});
    });
    actions.append(edit,remove);
  }

  body.appendChild(actions);

  row.addEventListener('contextmenu',event=>{
    openMessageContextMenu(event,m);
  });

  $('#messages').appendChild(row);$('#messages').scrollTop=$('#messages').scrollHeight;
}

function saveServerMessageQueue(){
  try{
    localStorage.setItem(
      'acord-server-message-queue',
      JSON.stringify((state.queuedServerMessages || []).slice(-100))
    );
  }catch{}
}

function queueServerMessage(payload){
  if(!payload?.clientNonce) return;

  const exists=(state.queuedServerMessages || []).some(
    item=>item?.clientNonce===payload.clientNonce
  );

  if(!exists){
    state.queuedServerMessages=[
      ...(state.queuedServerMessages || []),
      payload
    ].slice(-100);
  }

  saveServerMessageQueue();
}

function removeQueuedServerMessage(clientNonce){
  state.queuedServerMessages=(state.queuedServerMessages || []).filter(
    item=>item?.clientNonce!==clientNonce
  );
  saveServerMessageQueue();
}

function flushQueuedServerMessages(){
  if(!socket.connected || !state.profileReady) return;

  const queued=[...(state.queuedServerMessages || [])];

  for(const payload of queued){
    socket.timeout(3000).emit(
      'chat-message',
      payload,
      (error,response)=>{
        if(!error && response?.ok){
          removeQueuedServerMessage(payload.clientNonce);

          if(
            response.message &&
            String(response.message.serverId)===String(state.serverId) &&
            String(response.message.channelId)===String(state.textChannelId)
          ){
            resolvePendingChatMessage(payload.clientNonce);
            appendMessage(response.message);
          }
        }
      }
    );
  }
}


function appendPendingChatMessage(text,attachment,clientNonce){
  const message={
    id:'pending-'+clientNonce,
    clientNonce,
    serverId:state.serverId,
    channelId:state.textChannelId,
    senderId:socket.id,
    userId:state.userId,
    username:state.username || 'Usuário',
    text:text || '',
    attachment:attachment || null,
    replyTo:state.replyToMessageId || null,
    reactions:{},
    at:Date.now(),
    edited:false,
    pending:true
  };

  appendMessage(message);

  const node=document.querySelector(
    '#messages .message[data-message-id="pending-' +
    String(clientNonce).replace(/"/g,'') +
    '"]'
  );

  if(node){
    node.dataset.clientNonce=clientNonce;
    node.classList.add('pendingMessage');
  }
}

function resolvePendingChatMessage(clientNonce){
  if(!clientNonce) return;

  const node=document.querySelector(
    '#messages .message[data-client-nonce="' +
    String(clientNonce).replace(/"/g,'') +
    '"]'
  );

  if(node) node.remove();
}


function appendPublicChatMessage(message){
  if(!message) return;
  const box=$('#messages');if(!box)return;
  if(message.id && box.querySelector('.message[data-message-id="'+String(message.id).replace(/"/g,'')+'"]')) return;

  const mine=String(message.userId)===String(state.userId);
  const mentioned=(message.mentions||[]).some(name=>String(name).toLowerCase()===String(state.username||'').toLowerCase());

  const row=document.createElement('div');
  row.className='message'+(mine?' mine':'')+(mentioned?' mentioned':'');
  row.dataset.messageId=message.id||'';

  const avatar=document.createElement('div');
  avatar.className='avatar messageAvatar';
  const messageProfile=profileForName(message.username);
  applyAvatar(avatar,messageProfile,message.username||'Usuário');

  const body=document.createElement('div');
  body.className='messageBody';
  row.append(avatar,body);

  if(message.replyTo){
    const reply=document.createElement('div');reply.className='messageReply';
    reply.textContent='↪ resposta a uma mensagem';body.appendChild(reply);
  }

  const header=document.createElement('div');
  header.className='messageHeader';

  const strong=document.createElement('strong');
  strong.textContent=message.username||'Usuário';

  const time=document.createElement('time');
  time.className='messageTime';
  time.textContent=message.at
    ? new Date(message.at).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})
    : '';

  header.append(strong,time);

  const span=document.createElement('span');
  span.className='messageText';
  span.textContent=message.text||'';
  body.append(header,span);

  if(message.attachment?.data){
    if(String(message.attachment.type||'').startsWith('image/')){
      const img=document.createElement('img');img.className='messageAttachment';
      img.src=message.attachment.data;img.alt=message.attachment.name||'Imagem';body.appendChild(img);
    }else{
      const a=document.createElement('a');a.className='btn secondary small megaLink';
      a.href=message.attachment.data;a.download=message.attachment.name||'arquivo';
      a.textContent='📎 '+(message.attachment.name||'Arquivo');body.appendChild(a);
    }
  }

  const urlMatch=String(message.text||'').match(/https?:\/\/[^\s]+/i);
  if(urlMatch){
    try{
      const rawUrl=urlMatch[0];
      const u=new URL(rawUrl);
      const looksLikeGif=
        /\.gif(?:$|[?#])/i.test(u.pathname+u.search) ||
        /(?:media\.)?tenor\.com$/i.test(u.hostname) ||
        /giphy\.com$/i.test(u.hostname) ||
        /giphy\.com/i.test(u.hostname);

      if(looksLikeGif){
        const gif=document.createElement('img');
        gif.className='messageGif';
        gif.src=rawUrl;
        gif.alt='GIF';
        gif.loading='lazy';
        gif.referrerPolicy='no-referrer';
        gif.addEventListener('error',()=>gif.remove());
        body.appendChild(gif);
      }else{
        const preview=document.createElement('div');
        preview.className='messageLinkPreview';
        preview.textContent='🔗 '+u.hostname+' · '+u.pathname.slice(0,80);
        body.appendChild(preview);
      }
    }catch{}
  }

  const actions=document.createElement('div');actions.className='messageMetaActions';
  const replyBtn=document.createElement('button');replyBtn.textContent='↩ Responder';
  replyBtn.onclick=()=>{state.replyToMessageId=message.id;$('#replyBarText').textContent='Respondendo a '+(message.username||'Usuário');$('#replyBar').classList.remove('hidden');$('#messageInput').focus()};
  const pinBtn=document.createElement('button');pinBtn.textContent='📌 Fixar';
  pinBtn.onclick=()=>socket.emit('mega-pin-message',{serverId:state.serverId,channelId:state.textChannelId,messageId:message.id});
  actions.append(replyBtn,pinBtn);
  if(mine){
    const edit=document.createElement('button');edit.textContent='✎ Editar';
    edit.onclick=async()=>{
      const value=await appDialog({
        title:'Editar mensagem',
        message:'Altere o texto da mensagem.',
        value:message.text||'',
        confirmText:'Salvar'
      });
      if(value!==null){
        socket.emit('mega-edit-public',{serverId:state.serverId,channelId:state.textChannelId,messageId:message.id,text:value});
      }
    };
    const del=document.createElement('button');del.textContent='🗑 Excluir';
    del.onclick=async()=>{
      const result=await appDialog({
        title:'Excluir mensagem',
        message:'Essa mensagem será removida do histórico.',
        confirmText:'Excluir',
        danger:true
      });
      if(result){
        socket.emit('mega-delete-public',{serverId:state.serverId,channelId:state.textChannelId,messageId:message.id});
      }
    };
    actions.append(edit,del);
  }
  body.appendChild(actions);
  box.appendChild(row);
  if(state.labsPrefs?.['auto-scroll']!==false && !state.chatHistoryRendering) box.scrollTop=box.scrollHeight;

  creativeApplyWordFilter();

  if(mentioned && !mine){
    playCallCue('join');
    maybeNotify('Você foi mencionado',message.username+' mencionou você');
  }
}

async function sendPublicChat(){
  const input=$('#messageInput');
  if(!input) return;

  const text=String(input.value || '').trim().slice(0,2000);

  if(!text && !state.pendingChatAttachment) return;
  if(!state.serverId || !state.textChannelId) return;

  let confirmedEveryone=false;

  if(/@everyone\b/i.test(text) && currentServer()?.creative?.everyoneConfirm?.enabled){
    confirmedEveryone=!!(await appDialog({
      title:'Mencionar todos',
      message:'Você está prestes a mencionar @everyone. Deseja enviar a mensagem?',
      confirmText:'Enviar'
    }));
    if(!confirmedEveryone) return;
  }

  socket.emit('public-chat-message',{
    serverId:state.serverId,
    channelId:state.textChannelId,
    text,
    attachment:state.pendingChatAttachment,
    replyTo:state.replyToMessageId,
    confirmedEveryone
  });

  input.value='';
  state.pendingChatAttachment=null;
  state.replyToMessageId=null;
  $('#replyBar').classList.add('hidden');
  input.focus();
}

function sendMessage(){
  sendPublicChat();
}

function normalizeFriendList(list){
  if(!Array.isArray(list)) return [];

  return list
    .map(friend=>{
      if(typeof friend === 'string'){
        return {
          id:null,
          username:friend.slice(0,30),
          bio:'',
          avatar:''
        };
      }

      if(!friend || !friend.username) return null;

      return {
        id:friend.id ? String(friend.id).slice(0,100) : null,
        username:String(friend.username).slice(0,30),
        bio:String(friend.bio || '').slice(0,160),
        avatar:String(friend.avatar || '').slice(0,350000)
      };
    })
    .filter(Boolean);
}

function readFriendCache(){
  const parse = key => {
    try{
      const parsed = JSON.parse(localStorage.getItem(key) || '[]');
      return normalizeFriendList(parsed);
    }catch{
      return [];
    }
  };

  const primary = parse('ecord-friends');

  if(primary.length){
    return primary;
  }

  return parse('ecord-friends-backup');
}

function getFriends(){
  if(state.friendStateLoaded && Array.isArray(state.serverFriends) && state.serverFriends.length){
    return state.serverFriends;
  }

  const cached = readFriendCache();

  if(cached.length){
    return cached;
  }

  return Array.isArray(state.serverFriends)
    ? state.serverFriends
    : [];
}

function saveFriends(list){
  const safe = normalizeFriendList(list);
  const payload = JSON.stringify(safe);

  localStorage.setItem('ecord-friends',payload);

  // O backup só é substituído por uma lista que realmente contém amigos.
  // Assim uma atualização vazia temporária não apaga amizades salvas.
  if(safe.length){
    localStorage.setItem('ecord-friends-backup',payload);
  }

  if(state.profileReady){
    saveLocalRecoverySnapshot();
  }
}

function clearFriendFromLocalCache(friend){
  const matches = item => {
    if(friend?.id && item?.id){
      return String(item.id) === String(friend.id);
    }

    return String(item?.username || '').toLowerCase() ===
      String(friend?.username || '').toLowerCase();
  };

  const current = readFriendCache().filter(item=>!matches(item));

  localStorage.setItem('ecord-friends',JSON.stringify(current));
  localStorage.setItem('ecord-friends-backup',JSON.stringify(current));

  state.serverFriends = (state.serverFriends || []).filter(item=>!matches(item));
}

function addFriendByName(name){
  const clean = String(name || '').trim().slice(0,30);

  if(!clean) return;

  socket.emit('friend-request-send',{
    username:clean
  });
}

function addResolvedFriend(profile){
  if(!profile?.username) return;

  const friends = getFriends();

  const exists = friends.some(friend =>
    (profile.id && friend.id && friend.id === profile.id) ||
    String(friend.username || '').toLowerCase() === String(profile.username || '').toLowerCase()
  );

  if(exists){
    toast('Esse amigo já está na sua lista');
    return;
  }

  friends.push({
    id:profile.id || null,
    username:String(profile.username).slice(0,30),
    bio:String(profile.bio || '').slice(0,160),
    avatar:String(profile.avatar || '').slice(0,350000)
  });

  saveFriends(friends);
  renderFriends();
  toast('Amigo adicionado');
}

function removeFriend(friend){
  if(!friend) return;

  clearFriendFromLocalCache(friend);
  renderFriends();
  renderActiveFriends();
  renderDmContacts();

  socket.emit('friend-remove',{
    targetUserId:friend.id || null,
    targetUsername:friend.username || ''
  });
}

function callCurrentDmFriend(){
  if(!state.dmTarget){
    toast('Selecione um amigo');
    return;
  }

  callFriend(state.dmTarget);
}

function callFriend(friend){
  const online = state.onlineUsers.find(user =>
    (friend.id && user.id === friend.id) ||
    String(user.username || '').toLowerCase() === String(friend.username || '').toLowerCase()
  );

  if(!online){
    toast('Esse amigo está offline');
    return;
  }

  socket.emit('private-call-invite',{
    targetUserId:online.id,
    targetUsername:online.username
  });

  toast('Chamando ' + online.username + '...');
}

function renderActiveFriends(){
  const title = $('#rightTitle');
  const box = $('#members');

  if(title) title.textContent = 'Ativo agora';
  if(!box) return;

  box.innerHTML = '';

  const friends = getFriends();
  const onlineFriends = friends
    .map(friend=>{
      const live = state.onlineUsers.find(user =>
        (friend.id && user.id===friend.id) ||
        String(user.username||'').toLowerCase() ===
          String(friend.username||'').toLowerCase()
      );

      return live || null;
    })
    .filter(Boolean);

  if(!onlineFriends.length){
    const empty = document.createElement('div');
    empty.style.cssText = 'color:var(--low);font-size:12px;line-height:1.5;padding:7px 3px;';
    empty.textContent = 'Quando seus amigos estiverem online, eles vão aparecer aqui.';
    box.appendChild(empty);
    return;
  }

  onlineFriends.forEach(friend=>{
    const card = document.createElement('div');
    card.className = 'activeFriendCard';

    const top = document.createElement('div');
    top.style.cssText = 'display:flex;align-items:center;gap:9px;';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    applyAvatar(avatar,friend,friend.username);

    const meta = document.createElement('div');
    meta.style.minWidth = '0';

    const name = document.createElement('strong');
    name.textContent = friend.username;

    const status = document.createElement('span');
    status.textContent = '● Online';

    meta.append(name,status);
    top.append(avatar,meta);

    const call = document.createElement('button');
    call.className = 'btn primary small';
    call.style.cssText = 'width:100%;margin-top:10px;';
    call.textContent = '☎ Ligar';
    call.addEventListener('click',()=>callFriend(friend));

    card.append(top,call);
    box.appendChild(card);
  });
}

function renderFriends(){
  const box = $('#friendsList');
  if(!box) return;

  const search = String($('#friendsSearch')?.value || '').trim().toLowerCase();

  $('#friendsOnlineTab')?.classList.toggle('active',state.friendsFilter==='online');
  $('#friendsAllTab')?.classList.toggle('active',state.friendsFilter==='all');
  $('#friendsPendingTab')?.classList.toggle('active',state.friendsFilter==='pending');

  const pendingCount =
    (state.incomingFriendRequests?.length || 0) +
    (state.outgoingFriendRequests?.length || 0);

  if($('#friendsPendingTab')){
    $('#friendsPendingTab').textContent = pendingCount
      ? 'Pendentes (' + pendingCount + ')'
      : 'Pendentes';
  }

  box.innerHTML = '';

  if(state.friendsFilter === 'pending'){
    const incoming = (state.incomingFriendRequests || []).filter(item=>{
      const profile = item.from || {};
      return !search ||
        String(profile.username || '').toLowerCase().includes(search) ||
        String(profile.bio || '').toLowerCase().includes(search);
    });

    const outgoing = (state.outgoingFriendRequests || []).filter(item=>{
      const profile = item.to || {};
      return !search ||
        String(profile.username || '').toLowerCase().includes(search) ||
        String(profile.bio || '').toLowerCase().includes(search);
    });

    if($('#friendsCountTitle')){
      $('#friendsCountTitle').textContent =
        'Solicitações — ' + (incoming.length + outgoing.length);
    }

    if(!incoming.length && !outgoing.length){
      const empty = document.createElement('div');
      empty.style.cssText='padding:26px 4px;color:var(--low);font-size:13px;';
      empty.textContent='Nenhuma solicitação de amizade pendente.';
      box.appendChild(empty);
      renderActiveFriends();
      return;
    }

    incoming.forEach(item=>{
      const profile = item.from;
      const row=document.createElement('div');
      row.className='friendRow';

      const avatar=document.createElement('div');
      avatar.className='avatar';
      applyAvatar(avatar,profile,profile.username);

      const meta=document.createElement('div');
      meta.style.cssText='flex:1;min-width:0;';

      const name=document.createElement('strong');
      name.textContent=profile.username;

      const status=document.createElement('span');
      status.style.cssText='display:block;font-size:11px;color:var(--mint);margin-top:3px;';
      status.textContent='Quer adicionar você como amigo';

      meta.append(name,status);

      const actions=document.createElement('div');
      actions.className='friendActions';

      const accept=document.createElement('button');
      accept.className='btn primary small';
      accept.textContent='Aceitar';
      accept.addEventListener('click',()=>{
        socket.emit('friend-request-accept',{requestId:item.id});
      });

      const decline=document.createElement('button');
      decline.className='btn secondary small';
      decline.textContent='Recusar';
      decline.addEventListener('click',()=>{
        socket.emit('friend-request-decline',{requestId:item.id});
      });

      actions.append(accept,decline);
      row.append(avatar,meta,actions);
      box.appendChild(row);
    });

    outgoing.forEach(item=>{
      const profile=item.to;
      const row=document.createElement('div');
      row.className='friendRow';

      const avatar=document.createElement('div');
      avatar.className='avatar';
      applyAvatar(avatar,profile,profile.username);

      const meta=document.createElement('div');
      meta.style.cssText='flex:1;min-width:0;';

      const name=document.createElement('strong');
      name.textContent=profile.username;

      const status=document.createElement('span');
      status.style.cssText='display:block;font-size:11px;color:var(--low);margin-top:3px;';
      status.textContent='Solicitação enviada · aguardando aceitar';

      meta.append(name,status);
      row.append(avatar,meta);
      box.appendChild(row);
    });

    renderActiveFriends();
    return;
  }

  const allFriends = getFriends();

  const enriched = allFriends.map(friend=>{
    const live = state.onlineUsers.find(user =>
      (friend.id && user.id===friend.id) ||
      String(user.username||'').toLowerCase() ===
        String(friend.username||'').toLowerCase()
    );

    return {
      friend,
      profile:live || friend,
      online:!!live
    };
  });

  let rows = enriched;

  if(state.friendsFilter==='online'){
    rows = rows.filter(item=>item.online);
  }

  if(search){
    rows = rows.filter(item=>
      String(item.profile.username||'').toLowerCase().includes(search) ||
      String(item.profile.bio||'').toLowerCase().includes(search)
    );
  }

  if($('#friendsCountTitle')){
    $('#friendsCountTitle').textContent =
      (state.friendsFilter==='online' ? 'Online' : 'Todos') +
      ' — ' + rows.length;
  }

  if(!rows.length){
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:26px 4px;color:var(--low);font-size:13px;';
    empty.textContent =
      state.friendsFilter==='online'
        ? 'Nenhum amigo online agora.'
        : 'Você ainda não tem amigos adicionados.';
    box.appendChild(empty);
    renderActiveFriends();
    return;
  }

  rows.forEach(item=>{
    const friend = item.friend;
    const profile = item.profile;
    const online = item.online;

    const row = document.createElement('div');
    row.className = 'friendRow';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.flex = '0 0 auto';
    applyAvatar(avatar,profile,profile.username);

    const meta = document.createElement('div');
    meta.style.cssText = 'flex:1;min-width:0;';

    const strong = document.createElement('strong');
    strong.textContent = profile.username;
    strong.style.display = 'block';

    const status = document.createElement('span');
    status.textContent = online ? '● Online' : '● Offline';
    status.style.cssText =
      'display:block;font-size:11px;margin-top:3px;color:' +
      (online ? 'var(--mint)' : 'var(--low)') + ';';

    meta.append(strong,status);

    if(profile.bio){
      const bio = document.createElement('span');
      bio.textContent = profile.bio;
      bio.style.cssText =
        'display:block;font-size:11px;color:var(--low);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      meta.appendChild(bio);
    }

    const actions = document.createElement('div');
    actions.className = 'friendActions';

    const call = document.createElement('button');
    call.className = 'btn primary small';
    call.textContent = '☎';
    call.title = 'Ligar';
    call.disabled = !online;
    call.style.opacity = online ? '1' : '.4';
    call.addEventListener('click',()=>callFriend(profile));

    const remove = document.createElement('button');
    remove.className = 'btn secondary small';
    remove.textContent = '⋮';
    remove.title = 'Remover amigo';
    remove.addEventListener('click',async()=>{
      const result=await appDialog({
        title:'Remover amizade',
        message:'Remover '+profile.username+' da sua lista de amigos?',
        confirmText:'Remover',
        danger:true
      });
      if(result) removeFriend(friend);
    });

    actions.append(call,remove);
    row.append(avatar,meta,actions);
    box.appendChild(row);
  });

  renderActiveFriends();
}



function openPrivateGroupModal(){
  const friends = getFriends();

  $('#privateGroupNameInput').value = '';
  $('#privateGroupFriendsList').innerHTML = '';

  if(!friends.length){
    const empty=document.createElement('div');
    empty.style.cssText='padding:14px;color:var(--low);font-size:12px;border:1px dashed var(--line);border-radius:10px;';
    empty.textContent='Você precisa ter amigos aceitos para criar um grupo.';
    $('#privateGroupFriendsList').appendChild(empty);
  }else{
    friends.forEach(friend=>{
      const row=document.createElement('label');
      row.style.cssText='display:flex;align-items:center;gap:10px;padding:10px 11px;background:var(--bg2);border:1px solid var(--line);border-radius:10px;text-transform:none;letter-spacing:0;font-size:12px;cursor:pointer;';

      const checkbox=document.createElement('input');
      checkbox.type='checkbox';
      checkbox.value=friend.id || '';
      checkbox.style.cssText='width:auto;';

      const avatar=document.createElement('div');
      avatar.className='avatar';
      avatar.style.cssText='width:30px;height:30px;border-radius:10px;flex:0 0 auto;';
      applyAvatar(avatar,friend,friend.username);

      const name=document.createElement('span');
      name.textContent=friend.username;
      name.style.flex='1';

      checkbox.addEventListener('change',()=>{
        const checked=[...document.querySelectorAll('#privateGroupFriendsList input[type="checkbox"]:checked')];

        if(checked.length > 9){
          checkbox.checked=false;
          toast('Máximo de 10 pessoas contando com você');
        }

        updatePrivateGroupCount();
      });

      row.append(checkbox,avatar,name);
      $('#privateGroupFriendsList').appendChild(row);
    });
  }

  updatePrivateGroupCount();
  $('#privateGroupModalWrap').classList.remove('hidden');
  setTimeout(()=>$('#privateGroupNameInput').focus(),0);
}

function closePrivateGroupModal(){
  $('#privateGroupModalWrap').classList.add('hidden');
}

function updatePrivateGroupCount(){
  const selected=document.querySelectorAll('#privateGroupFriendsList input[type="checkbox"]:checked').length;
  $('#privateGroupCount').textContent=(selected + 1) + '/10 pessoas';
}

function createPrivateGroup(){
  const name=$('#privateGroupNameInput').value.trim().slice(0,40);
  const checked=[...document.querySelectorAll('#privateGroupFriendsList input[type="checkbox"]:checked')];

  if(!name){
    toast('Digite o nome do grupo');
    return;
  }

  if(!checked.length){
    toast('Escolha pelo menos 1 amigo');
    return;
  }

  if(checked.length > 9){
    toast('O grupo pode ter no máximo 10 pessoas');
    return;
  }

  socket.emit('group-create',{
    name,
    memberIds:checked.map(item=>item.value).filter(Boolean)
  });
}

function openGroupChat(group){
  if(!group?.id) return;

  state.activeGroupId=group.id;
  state.dmTarget=null;

  $('#dmTitle').textContent=group.name || 'Grupo';
  $('#dmSubtitle').textContent=
    'Grupo privado · ' + String(group.memberCount || group.members?.length || 1) + '/10 pessoas';

  $('#dmCallBtn').classList.add('hidden');
  $('#groupCallBtn').classList.remove('hidden');
  $('#groupDeleteBtn').classList.toggle('hidden',group.ownerId!==state.userId);

  $('#dmInput').disabled=false;
  $('#dmSendBtn').disabled=false;
  $('#dmInput').placeholder='Mensagem em ' + (group.name || 'grupo');
  $('#dmMessages').innerHTML='';

  socket.emit('group-history',{groupId:group.id});
  $('#dmInput').focus();
}

function currentPrivateGroup(){
  return (state.privateGroups || []).find(group=>group.id===state.activeGroupId) || null;
}

async function deleteCurrentPrivateGroup(){
  const group=currentPrivateGroup();
  if(!group) return;

  if(group.ownerId!==state.userId){
    toast('Apenas o criador pode excluir o grupo');
    return;
  }

  const result=await appDialog({
    title:'Excluir grupo',
    message:'Excluir o grupo privado "'+(group.name||'Grupo')+'"? O histórico do grupo será removido.',
    confirmText:'Excluir grupo',
    danger:true
  });

  if(!result) return;
  socket.emit('group-delete',{groupId:group.id});
}

function callCurrentPrivateGroup(){
  const group=currentPrivateGroup();
  if(!group) return;

  socket.emit('private-group-call-start',{groupId:group.id});
  toast('Iniciando chamada do grupo...');
}

async function enterPrivateGroupCall(callId,groupName){
  try{
    await ensureMic();
    const micTrack=state.localStream?.getAudioTracks()?.[0];
    if(micTrack&&state.callPrefs.muteOnJoin)micTrack.enabled=false;

    if(state.joinedVoiceId){
      socket.emit('leave-voice');
      closePeers();
    }

    state.privateCallId=callId;
    state.privatePeerName=groupName || 'Grupo privado';
    state.joinedVoiceId='private:'+callId;
    state.activeVoiceServerId=null;
    state.activeVoiceChannelId=null;
    state.activeVoiceName='Chamada em grupo · ' + state.privatePeerName;

    setView('voice');
    setAppMode('private-call');

    $('#voiceTitle').textContent='Chamada em grupo · ' + state.privatePeerName;
    $('#topTitle').textContent='☎ Chamada privada em grupo';
    $('#topSub').textContent=state.privatePeerName;
    $('#voiceStatus').textContent='Call privada em grupo · Conectando...';
    $('#quickInviteBtn')?.classList.add('hidden');

    syncVoiceControlsUI();
    ensureCard('local',state.username+' (você)',state.localStream,true);

    clearPrivateJoinRetry();
    requestPrivateCallJoin(callId);
    updateCallDock();
    applyMobileCallMode();
    syncCallPrefsUI();
    startMicLevelMeter();
    startCallHealthMonitor();
    updateCallWakeLock();
  }catch(error){
    console.error(error);
    toast(friendlyMediaError(error,'microfone'));
  }
}

function appendGroupMessage(message){
  if(!message) return;

  const mine=message.userId===state.userId;
  const row=document.createElement('div');
  row.className='message' + (mine ? ' mine' : '');

  const strong=document.createElement('strong');
  strong.textContent=mine ? state.username : (message.username || 'Usuário');

  const span=document.createElement('span');
  span.textContent=message.text || '';

  row.append(strong,span);
  $('#dmMessages').appendChild(row);
  $('#dmMessages').scrollTop=$('#dmMessages').scrollHeight;
}

function renderDmContacts(){
  const box = $('#dmContacts');
  if(!box) return;

  const search=String($('#dmSearch')?.value || '').trim().toLowerCase();

  const showGroupsOnly=state.dmContactsMode==='groups';

  const friends=showGroupsOnly
    ? []
    : getFriends().filter(friend =>
        !search || String(friend.username || '').toLowerCase().includes(search)
      );

  const groups=(state.privateGroups || []).filter(group =>
    !search || String(group.name || '').toLowerCase().includes(search)
  );

  box.innerHTML='';

  if(showGroupsOnly){
    const heading=document.createElement('div');
    heading.style.cssText='color:var(--text);font-size:13px;font-weight:900;margin:4px 5px 12px;';
    heading.textContent='Seus grupos privados';
    box.appendChild(heading);
  }

  if(groups.length){
    const title=document.createElement('div');
    title.style.cssText='color:var(--low);font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;margin:6px 5px 7px;';
    title.textContent='Grupos privados';
    box.appendChild(title);

    groups.forEach(group=>{
      const btn=document.createElement('button');
      btn.type='button';
      btn.className='navBtn';
      btn.style.cssText='display:flex;align-items:center;gap:9px;margin-bottom:3px;';

      const icon=document.createElement('div');
      icon.className='avatar';
      icon.style.cssText='width:30px;height:30px;border-radius:10px;flex:0 0 auto;background:var(--mintbg);color:var(--mint);';
      icon.textContent='👥';

      const meta=document.createElement('div');
      meta.style.cssText='min-width:0;flex:1;text-align:left;';

      const name=document.createElement('div');
      name.textContent=group.name || 'Grupo';
      name.style.cssText='overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

      const count=document.createElement('div');
      count.textContent=String(group.memberCount || group.members?.length || 1) + '/10';
      count.style.cssText='font-size:10px;color:var(--low);margin-top:2px;';

      meta.append(name,count);
      btn.append(icon,meta);
      btn.addEventListener('click',()=>openGroupChat(group));
      box.appendChild(btn);
    });
  }

  if(friends.length){
    const title=document.createElement('div');
    title.style.cssText='color:var(--low);font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;margin:14px 5px 7px;';
    title.textContent='Amigos';
    box.appendChild(title);

    friends.forEach(friend=>{
      const live = state.onlineUsers.find(user =>
        (friend.id && user.id===friend.id) ||
        String(user.username||'').toLowerCase()===String(friend.username||'').toLowerCase()
      );

      const profile = live || friend;
      const btn = document.createElement('button');
      btn.type='button';
      btn.className='navBtn';
      btn.style.cssText='display:flex;align-items:center;gap:9px;margin-bottom:3px;';

      const avatar=document.createElement('div');
      avatar.className='avatar';
      avatar.style.cssText='width:30px;height:30px;border-radius:10px;flex:0 0 auto;';
      applyAvatar(avatar,profile,profile.username);

      const name=document.createElement('span');
      name.textContent=profile.username;
      name.style.cssText='overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

      btn.append(avatar,name);
      btn.addEventListener('click',()=>openDm(profile));
      box.appendChild(btn);
    });
  }

  if(!groups.length && !friends.length){
    const empty=document.createElement('div');
    empty.style.cssText='color:var(--low);font-size:12px;padding:12px 5px;';
    empty.textContent=showGroupsOnly
      ? 'Você ainda não participa de nenhum grupo privado.'
      : 'Adicione amigos ou crie um grupo privado.';
    box.appendChild(empty);
  }
}


function dmCacheKey(userA,userB){
  const ids=[String(userA||''),String(userB||'')].filter(Boolean).sort();
  return ids.length===2 ? 'concorde-dm-cache-'+ids.join('--') : '';
}

function readDmCache(targetId){
  try{
    const key=dmCacheKey(state.userId,targetId);
    if(!key)return [];
    const value=JSON.parse(localStorage.getItem(key)||'[]');
    return Array.isArray(value)?value:[];
  }catch{return []}
}

function writeDmCache(targetId,messages){
  try{
    const key=dmCacheKey(state.userId,targetId);
    if(!key)return;

    const byId=new Map();
    for(const message of messages||[]){
      if(message?.id) byId.set(String(message.id),message);
    }

    const list=[...byId.values()]
      .sort((a,b)=>Number(a.at||0)-Number(b.at||0))
      .slice(-500);

    localStorage.setItem(key,JSON.stringify(list));
  }catch(error){
    console.warn('Falha ao salvar DM localmente',error);
  }
}

function cacheDmMessage(message){
  if(!message)return;
  const otherId=message.fromUserId===state.userId ? message.toUserId : message.fromUserId;
  if(!otherId)return;
  writeDmCache(otherId,[...readDmCache(otherId),message]);
}

function mergedDmHistory(targetId,serverMessages){
  const byId=new Map();
  for(const message of [...readDmCache(targetId),...(serverMessages||[])]){
    if(message?.id) byId.set(String(message.id),message);
  }
  const merged=[...byId.values()]
    .sort((a,b)=>Number(a.at||0)-Number(b.at||0))
    .slice(-500);
  writeDmCache(targetId,merged);
  return merged;
}

function renderDmHistory(messages){
  $('#dmMessages').innerHTML='';
  (messages||[]).forEach(appendDmMessage);
}

function syncCachedOutgoingDms(){
  if(!state.profileReady || !socket.connected || !state.userId)return;

  const ownId=String(state.userId);
  const byId=new Map();

  for(let i=0;i<localStorage.length;i++){
    const key=localStorage.key(i);
    if(!key || !key.startsWith('concorde-dm-cache-') || !key.includes(ownId)) continue;
    try{
      const list=JSON.parse(localStorage.getItem(key)||'[]');
      if(!Array.isArray(list))continue;
      for(const message of list){
        if(message?.fromUserId===ownId && message?.toUserId && message?.id){
          byId.set(String(message.id),message);
        }
      }
    }catch{}
  }

  const messages=[...byId.values()]
    .sort((a,b)=>Number(a.at||0)-Number(b.at||0))
    .slice(-2000);

  if(messages.length){
    socket.timeout(8000).emit('dm-recovery-sync',{messages},()=>{});
  }
}

function openDm(profile){
  $('#groupCallBtn')?.classList.add('hidden');
  $('#groupDeleteBtn')?.classList.add('hidden');
  $('#dmCallBtn')?.classList.remove('hidden');
  state.activeGroupId=null;
  if(!profile?.username) return;

  state.activeGroupId=null;

  const resolved = state.onlineUsers.find(user =>
    (profile.id && user.id===profile.id) ||
    String(user.username||'').toLowerCase()===String(profile.username||'').toLowerCase()
  ) || profile;

  state.dmTarget = {
    id:resolved.id || profile.id || null,
    username:resolved.username || profile.username
  };

  $('#dmTitle').textContent = state.dmTarget.username;
  $('#dmSubtitle').textContent = 'Mensagem privada';
  $('#dmInput').disabled = false;
  $('#dmSendBtn').disabled = false;
  $('#dmInput').placeholder = 'Mensagem para ' + state.dmTarget.username;
  renderDmHistory(readDmCache(state.dmTarget.id));

  socket.emit('dm-history',{
    targetUserId:state.dmTarget.id,
    targetUsername:state.dmTarget.username
  });

  $('#dmInput').focus();
}

function appendDmMessage(message){
  if(!message) return;

  const mine = message.fromUserId === state.userId;
  const row = document.createElement('div');
  row.className = 'message' + (mine ? ' mine' : '');

  const strong = document.createElement('strong');
  strong.textContent = mine ? state.username : message.fromUsername;

  const span = document.createElement('span');
  span.textContent = message.text || '';

  row.append(strong,span);
  $('#dmMessages').appendChild(row);
  $('#dmMessages').scrollTop = $('#dmMessages').scrollHeight;
}

function sendDm(){
  const input = $('#dmInput');
  const text = input.value.trim().slice(0,1000);

  if(!text) return;

  if(state.activeGroupId){
    socket.emit('group-message',{
      groupId:state.activeGroupId,
      text
    });

    input.value='';
    input.focus();
    return;
  }

  if(!state.dmTarget) return;

  const clientMessageId='local-'+Date.now()+'-'+Math.random().toString(36).slice(2,10);

  cacheDmMessage({
    id:clientMessageId,
    fromUserId:state.userId,
    toUserId:state.dmTarget.id,
    fromUsername:state.username,
    text,
    at:Date.now()
  });

  socket.emit('dm-message',{
    targetUserId:state.dmTarget.id,
    targetUsername:state.dmTarget.username,
    text,
    clientMessageId
  });

  input.value='';
  input.focus();
}


function roleNamesForUser(username){
  const server = currentServer();
  if(!server || !Array.isArray(server.roles)) return [];

  const key = String(username || '').toLowerCase();

  return server.roles.filter(role =>
    Array.isArray(role.members) &&
    role.members.some(name => String(name).toLowerCase() === key)
  );
}

function renderRoles(){
  const box = $('#rolesList');
  if(!box) return;

  const server = currentServer();
  const roles = Array.isArray(server?.roles) ? server.roles : [];
  box.innerHTML = '';

  if(!roles.length){
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:20px;background:var(--bg2);border:1px dashed var(--line);border-radius:14px;color:var(--low);font-size:13px;';
    empty.textContent = 'Este servidor ainda não tem cargos. Clique em “Criar cargo”.';
    box.appendChild(empty);
    return;
  }

  roles.forEach(role => {
    const roleColor = role.color || '#ff6b4a';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:13px 14px;background:var(--bg2);border:1px solid var(--line);border-radius:14px;';

    const color = document.createElement('div');
    color.style.cssText =
      'width:13px;height:38px;border-radius:999px;background:' + roleColor +
      ';box-shadow:0 0 18px ' + roleColor + '33;flex:0 0 auto;';

    const meta = document.createElement('div');
    meta.style.cssText = 'flex:1;min-width:0;';

    const name = document.createElement('strong');
    name.textContent = role.name;
    name.style.cssText = 'display:block;color:' + roleColor + ';';

    const members = document.createElement('div');
    members.style.cssText = 'font-size:12px;color:var(--muted);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    const list = Array.isArray(role.members) ? role.members : [];
    members.textContent = list.length
      ? String(list.length) + ' membro' + (list.length === 1 ? '' : 's') + ' · ' + list.join(', ')
      : 'Nenhum membro com este cargo';

    const perms = document.createElement('div');
    perms.style.cssText='font-size:10px;color:var(--low);margin-top:4px;';

    const enabledPerms = [];
    if(role.permissions?.administrator) enabledPerms.push('Administrador');
    if(role.permissions?.manageServer) enabledPerms.push('Gerenciar servidor');
    if(role.permissions?.manageChannels) enabledPerms.push('Gerenciar canais');
    if(role.permissions?.manageRoles) enabledPerms.push('Gerenciar cargos');

    perms.textContent = enabledPerms.length
      ? enabledPerms.join(' · ')
      : 'Sem permissões especiais';

    meta.append(name, members, perms);

    const edit = document.createElement('button');
    edit.className = 'btn secondary small';
    edit.textContent = 'Editar';
    edit.addEventListener('click',()=>{
      state.selectedRoleId = role.id;
      openModal('editRole');
    });

    const assign = document.createElement('button');
    assign.className = 'btn secondary small';
    assign.textContent = 'Atribuir';
    assign.addEventListener('click', ()=>{
      state.selectedRoleId = role.id;
      openModal('assignRole');
    });

    const remove = document.createElement('button');
    remove.className = 'btn secondary small';
    remove.textContent = 'Excluir';
    remove.addEventListener('click',async()=>{
      const result=await appDialog({
        title:'Excluir cargo',
        message:'Excluir o cargo "'+role.name+'"?',
        confirmText:'Excluir',
        danger:true
      });
      if(result){
        socket.emit('remove-role',{
          serverId:state.serverId,
          roleId:role.id
        });
      }
    });

    row.append(color, meta, edit, assign, remove);
    box.appendChild(row);
  });
}

function openModal(type){
  state.modalAction = type;
  const cfg = {
    server:['Criar servidor','Digite o nome do novo servidor.','Ex.: Meus amigos'],
    text:['Criar chat','Digite o nome do novo canal de texto.','Ex.: memes'],
    voice:['Criar canal de voz','Digite o nome do novo canal de voz.','Ex.: Jogos'],
    stage:['Criar Palco','Crie uma chamada de Palco para eventos, painéis e apresentações.','Ex.: Palco principal'],
    category:['Criar categoria','Digite o nome da nova categoria.','Ex.: Jogos'],
    friend:['Adicionar amigo','Digite exatamente o nome do seu amigo no Acord.','Ex.: Davi'],
    role:['Criar cargo','Escolha nome, cor e permissões do cargo.','Ex.: Moderador'],
    editRole:['Editar cargo','Altere nome, cor e permissões do cargo.','Ex.: Administrador'],
    assignRole:['Atribuir cargo','Digite exatamente o nome da pessoa que receberá o cargo.','Ex.: Davi']
  }[type];

  $('#modalTitle').textContent = cfg[0];
  $('#modalText').textContent = cfg[1];
  $('#modalInput').placeholder = cfg[2];
  $('#modalInput').value = '';

  const roleEditor = type === 'role' || type === 'editRole';

  $('#roleColorWrap').classList.toggle('hidden', !roleEditor);
  $('#rolePermissionsWrap').classList.toggle('hidden', !roleEditor);

  ['#permAdministrator','#permManageServer','#permManageChannels','#permManageRoles']
    .forEach(selector=>$(selector).checked=false);

  if(type === 'role'){
    $('#roleColor').value = '#ff6b4a';
    $('#roleColorText').textContent = '#ff6b4a';
  }

  if(type === 'editRole'){
    const role = currentServer()?.roles?.find(item=>item.id===state.selectedRoleId);

    if(role){
      $('#modalInput').value = role.name || '';
      $('#roleColor').value = role.color || '#ff6b4a';
      $('#roleColorText').textContent = $('#roleColor').value;
      $('#permAdministrator').checked = !!role.permissions?.administrator;
      $('#permManageServer').checked = !!role.permissions?.manageServer;
      $('#permManageChannels').checked = !!role.permissions?.manageChannels;
      $('#permManageRoles').checked = !!role.permissions?.manageRoles;
    }
  }

  $('#modalOk').textContent =
    type === 'assignRole' ? 'Atribuir' :
    type === 'role' ? 'Criar cargo' :
    type === 'editRole' ? 'Salvar cargo' :
    'Criar';

  $('#modalWrap').classList.remove('hidden');
  setTimeout(()=>$('#modalInput').focus(),0);
}

function closeModal(){
  $('#modalWrap').classList.add('hidden');
  state.modalAction = null;
  $('#roleColorWrap').classList.add('hidden');
  $('#rolePermissionsWrap').classList.add('hidden');
  $('#modalOk').textContent = 'Criar';
}

function confirmModal(){
  const value = $('#modalInput').value.trim();
  if(!value) return;
  if(state.modalAction==='server'){
    socket.emit('create-server',{name:value});
  } else if(state.modalAction==='text'){
    socket.emit('create-channel',{serverId:state.serverId,type:'text',name:value});
  } else if(state.modalAction==='voice'){
    socket.emit('create-channel',{serverId:state.serverId,type:'voice',name:value});
  } else if(state.modalAction==='stage'){
    socket.emit('create-channel',{serverId:state.serverId,type:'stage',name:value});
  } else if(state.modalAction==='category'){
    socket.emit('create-category',{serverId:state.serverId,name:value});
  } else if(state.modalAction==='friend'){
    addFriendByName(value);
  } else if(state.modalAction==='role'){
    socket.emit('create-role',{
      serverId:state.serverId,
      name:value,
      color:$('#roleColor').value,
      permissions:{
        administrator:$('#permAdministrator').checked,
        manageServer:$('#permManageServer').checked,
        manageChannels:$('#permManageChannels').checked,
        manageRoles:$('#permManageRoles').checked
      }
    });
  } else if(state.modalAction==='editRole'){
    socket.emit('update-role',{
      serverId:state.serverId,
      roleId:state.selectedRoleId,
      name:value,
      color:$('#roleColor').value,
      permissions:{
        administrator:$('#permAdministrator').checked,
        manageServer:$('#permManageServer').checked,
        manageChannels:$('#permManageChannels').checked,
        manageRoles:$('#permManageRoles').checked
      }
    });
    state.selectedRoleId=null;
  } else if(state.modalAction==='assignRole'){
    socket.emit('assign-role',{
      serverId:state.serverId,
      roleId:state.selectedRoleId,
      username:value
    });
    state.selectedRoleId = null;
  }
  closeModal();
}

async function deleteCurrentServer(){
  const server=currentServer();

  if(!server){
    toast('Nenhum servidor selecionado');
    return;
  }

  const result=await appDialog({
    title:'Excluir servidor',
    message:'Apagar "'+server.name+'"? Canais, mensagens e arquivos desse servidor serão removidos permanentemente.',
    confirmText:'Excluir servidor',
    danger:true
  });

  if(!result) return;
  socket.emit('delete-server',{serverId:server.id});
}

async function copyInvite(){
  const server=currentServer();

  if(!server?.inviteToken){
    toast('Convite indisponível');
    return;
  }

  // O link contém apenas o token de entrada. Nenhum dado, canal ou configuração
  // do servidor é colocado no convite.
  const url=new URL(
    '/invite/' + encodeURIComponent(server.inviteToken),
    location.origin
  );

  try{
    await navigator.clipboard.writeText(url.toString());
    toast('Link de convite do servidor copiado');
  }catch{
    await appDialog({
      title:'Link de convite',
      message:'Copie o link abaixo para compartilhar o servidor.',
      value:url.toString(),
      confirmText:'Fechar'
    });
  }
}


async function ensureMic(){
  if(state.localStream && state.localStream.getAudioTracks().length){
    return state.localStream;
  }

  const mic=await navigator.mediaDevices.getUserMedia({
    audio:{
      deviceId:state.preferredMicId?{exact:state.preferredMicId}:undefined,
      echoCancellation:state.callPrefs.echoCancellation,
      noiseSuppression:state.noiseSuppression,
      autoGainControl:state.callPrefs.autoGain
    },
    video:false
  });

  if(!state.localStream){
    state.localStream=new MediaStream();
  }

  for(const track of mic.getAudioTracks()){
    state.localStream.addTrack(track);
  }

  // Não substitui o MediaStream inteiro: assim a câmera do celular,
  // conectada antes de entrar na call, continua anexada.
  if(
    state.phoneCameraTrack &&
    state.phoneCameraTrack.readyState==='live' &&
    !state.localStream.getVideoTracks().some(
      track=>track.id===state.phoneCameraTrack.id
    )
  ){
    state.localStream.addTrack(state.phoneCameraTrack);
  }

  return state.localStream;
}

function getTransceiverByKind(pc, kind){
  return pc.getTransceivers().find(t =>
    t.receiver?.track?.kind === kind ||
    t.sender?.track?.kind === kind
  ) || null;
}

function getSenderByKind(pc, kind){
  return getTransceiverByKind(pc, kind)?.sender || null;
}

function ensureOfferTransceivers(pc){
  if(!getTransceiverByKind(pc,'audio')){
    pc.addTransceiver('audio',{direction:'sendrecv'});
  }

  if(!getTransceiverByKind(pc,'video')){
    pc.addTransceiver('video',{direction:'sendrecv'});
  }
}

async function attachLocalTracks(pc){
  let audioTx = getTransceiverByKind(pc,'audio');
  let videoTx = getTransceiverByKind(pc,'video');

  if(!audioTx){
    audioTx = pc.addTransceiver('audio',{direction:'sendrecv'});
  }else{
    audioTx.direction = 'sendrecv';
  }

  if(!videoTx){
    videoTx = pc.addTransceiver('video',{direction:'sendrecv'});
  }else{
    videoTx.direction = 'sendrecv';
  }

  const micTrack = state.localStream?.getAudioTracks()?.[0] || null;
  const activeVideoTrack =
    state.screenTrack && state.screenTrack.readyState === 'live'
      ? state.screenTrack
      : (
          state.cameraTrack &&
          state.cameraTrack.readyState === 'live' &&
          state.cameraTrack.enabled
            ? state.cameraTrack
            : null
        );

  await Promise.allSettled([
    audioTx.sender.replaceTrack(micTrack),
    videoTx.sender.replaceTrack(activeVideoTrack)
  ]);

  if(state.screenTrack && activeVideoTrack === state.screenTrack){
    const preset = screenSharePreset(state.screenShareQuality);

    try{
      const params = videoTx.sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = preset.maxBitrate;
      params.encodings[0].maxFramerate = preset.frameRate.max || preset.frameRate.ideal || 30;
      await videoTx.sender.setParameters(params);
    }catch{}
  }else if(state.cameraTrack && activeVideoTrack === state.cameraTrack){
    try{
      const params = videoTx.sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      const preset=cameraPreset();
      params.encodings[0].maxBitrate = preset.bitrate;
      params.encodings[0].maxFramerate = preset.frameRate;
      await videoTx.sender.setParameters(params);
    }catch{}
  }
}

function ensureCard(peerId,name,stream,isLocal=false){
  let card = document.getElementById('v-'+peerId);
  if(!card){
    card = document.createElement('div');
    card.className = 'videoCard';
    card.id = 'v-'+peerId;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = isLocal;

    const ph = document.createElement('div');
    ph.className = 'placeholder';
    const av = document.createElement('div');
    av.className = 'bigAvatar';
    av.textContent = initials(name);
    ph.appendChild(av);

    const lab = document.createElement('div');
    lab.className = 'videoName';
    lab.textContent = name;
    const pin=document.createElement('button');pin.type='button';pin.className='videoPinBtn';pin.textContent='Fixar';pin.addEventListener('click',event=>{event.stopPropagation();togglePinPeer(peerId)});
    const quality=document.createElement('div');quality.className='videoQualityBadge';quality.textContent=isLocal?'Você':'—';
    card.append(video,ph,lab,pin,quality);
    $('#videoGrid').appendChild(card);
    updateCallLayout();
  }

  const video = card.querySelector('video');
  // O vídeo fica mudo para evitar áudio duplicado.
  // O áudio remoto é reproduzido em um elemento <audio> separado.
  video.muted = true;
  if(stream && video.srcObject!==stream) video.srcObject = stream;
  const hasVideo = !!stream?.getVideoTracks().some(
    t=>t.readyState==='live' && t.enabled && !t.muted
  );
  card.classList.toggle('hasVideo',hasVideo);
  card.querySelector('.videoName').textContent = name;

  const cardProfile = profileForName(
    String(name || '').replace(' (você)','').replace(' — compartilhando tela','')
  );

  applyAvatar(
    card.querySelector('.bigAvatar'),
    cardProfile,
    name
  );
  if(!isLocal){const q=state.peerQuality.get(peerId);if(q)updatePeerQualityBadge(peerId,q.quality,q.rtt)}
  updateCallLayout();
  return card;
}



function getPeerVolume(peerId){
  const current=Number(state.peerVolumes.get(peerId));
  if(Number.isFinite(current))return Math.max(0,Math.min(2,current));
  const username=state.peerNames.get(peerId)||'';
  if(username){
    const saved=Number(localStorage.getItem('acord-peer-volume-'+username.toLowerCase()));
    if(Number.isFinite(saved)){
      const value=Math.max(0,Math.min(2,saved));
      state.peerVolumes.set(peerId,value);
      return value;
    }
  }
  return 1;
}

function getSharedAudioContext(){
  if(state.audioContext) return state.audioContext;

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if(!AudioCtx) return null;

  try{
    state.audioContext = new AudioCtx();
  }catch{
    state.audioContext = null;
  }

  return state.audioContext;
}

function disconnectPeerAudioNode(peerId){
  const node = state.peerAudioNodes.get(peerId);

  if(node){
    try{node.source?.disconnect()}catch{}
    try{node.gain?.disconnect()}catch{}
  }

  stopRemoteSpeakingMonitor(peerId);
  state.peerAudioNodes.delete(peerId);
}

async function setupPeerAudioGain(peerId,stream){
  if(!stream?.getAudioTracks?.().length) return false;

  const context = getSharedAudioContext();
  if(!context) return false;

  const existing = state.peerAudioNodes.get(peerId);

  if(existing?.stream === stream){
    existing.gain.gain.value = state.deafened ? 0 : getPeerVolume(peerId);

    try{
      if(context.state === 'suspended') await context.resume();
    }catch{}

    return context.state === 'running';
  }

  disconnectPeerAudioNode(peerId);

  try{
    const source = context.createMediaStreamSource(stream);
    const gain = context.createGain();

    gain.gain.value = state.deafened ? 0 : getPeerVolume(peerId);

    const analyser=context.createAnalyser();analyser.fftSize=256;analyser.smoothingTimeConstant=.74;
    source.connect(analyser);analyser.connect(gain);gain.connect(context.destination);
    state.peerAudioNodes.set(peerId,{source,analyser,gain,stream});
    startRemoteSpeakingMonitor(peerId,analyser);

    if(context.state === 'suspended'){
      try{await context.resume()}catch{}
    }

    return context.state === 'running';
  }catch(error){
    console.warn('Áudio individual indisponível:',error);
    disconnectPeerAudioNode(peerId);
    return false;
  }
}

function setPeerVolume(peerId,value){
  const volume = Math.max(0,Math.min(2,Number(value) || 0));
  state.peerVolumes.set(peerId,volume);
  const username=state.peerNames.get(peerId)||'';
  if(username)localStorage.setItem('acord-peer-volume-'+username.toLowerCase(),String(volume));

  const node = state.peerAudioNodes.get(peerId);
  if(node?.gain){
    node.gain.gain.value = state.deafened ? 0 : volume;
  }

  const audio = state.remoteAudio.get(peerId);

  // Fallback dos navegadores sem Web Audio:
  // até 100% usa o volume nativo. Acima disso precisa do GainNode.
  if(audio && !node){
    audio.volume = Math.min(1,volume);
  }

  renderMembers(state.lastVoiceMembers || []);
}

function changePeerVolume(peerId,delta){
  const next = Math.round((getPeerVolume(peerId) + delta) * 100) / 100;
  setPeerVolume(peerId,next);
}

function removeRemoteAudio(peerId){
  disconnectPeerAudioNode(peerId);

  const audio = state.remoteAudio.get(peerId);
  if(audio){
    try{
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    }catch{}
  }
  state.remoteAudio.delete(peerId);
}

function ensureRemoteAudio(peerId, track, sourceStream = null){
  let audio = state.remoteAudio.get(peerId);

  if(!audio){
    audio = document.createElement('audio');
    audio.id = 'a-' + peerId;
    audio.autoplay = true;
    audio.playsInline = true;
    audio.controls = false;
    audio.preload = 'auto';
    audio.style.position = 'fixed';
    audio.style.width = '1px';
    audio.style.height = '1px';
    audio.style.opacity = '0';
    audio.style.pointerEvents = 'none';
    document.body.appendChild(audio);
    state.remoteAudio.set(peerId, audio);
    if(typeof audio.setSinkId==='function'&&state.callPrefs.speakerId){
      audio.setSinkId(state.callPrefs.speakerId).catch(()=>{});
    }
  }

  const stream =
    sourceStream && sourceStream.getAudioTracks?.().length
      ? sourceStream
      : new MediaStream([track]);

  if(audio.srcObject !== stream){
    audio.srcObject = stream;
  }

  const volume = getPeerVolume(peerId);

  const tryPlay = async () => {
    const usingGain = await setupPeerAudioGain(peerId,stream);

    if(usingGain){
      // O áudio é reproduzido pelo Web Audio para permitir até 200%.
      audio.muted = true;
      audio.volume = 1;

      $('#audioGateBtn').classList.add('hidden');

      if(state.joinedVoiceId && !state.screenTrack){
        $('#voiceStatus').textContent = 'Conectado';
      }

      return;
    }

    // Fallback comum: controle individual até 100%.
    audio.muted = !!state.deafened;
    audio.volume = Math.min(1,volume);

    try{
      await audio.play();
      $('#audioGateBtn').classList.add('hidden');

      if(state.joinedVoiceId && !state.screenTrack){
        $('#voiceStatus').textContent = 'Conectado';
      }
    }catch{
      $('#audioGateBtn').classList.remove('hidden');
      $('#voiceStatus').textContent = 'Clique em “Ativar áudio”';
    }
  };

  tryPlay();

  track.addEventListener('unmute', tryPlay);
  track.addEventListener('ended', () => removeRemoteAudio(peerId));

  return audio;
}

async function unlockAllRemoteAudio(){
  let blocked = false;

  const context = getSharedAudioContext();

  if(context?.state === 'suspended'){
    try{await context.resume()}catch{}
  }

  for(const [peerId,audio] of state.remoteAudio.entries()){
    const node = state.peerAudioNodes.get(peerId);

    if(node && context?.state === 'running'){
      node.gain.gain.value = state.deafened ? 0 : getPeerVolume(peerId);
      audio.muted = true;
      continue;
    }

    audio.muted = !!state.deafened;
    audio.volume = Math.min(1,getPeerVolume(peerId));

    try{
      await audio.play();
    }catch{
      blocked = true;
    }
  }

  $('#audioGateBtn').classList.toggle('hidden', !blocked);

  if(!blocked && state.joinedVoiceId && !state.screenTrack){
    $('#voiceStatus').textContent = 'Conectado';
  }
}

function getRemoteStream(peerId){
  if(!state.remoteStreams.has(peerId)) state.remoteStreams.set(peerId,new MediaStream());
  return state.remoteStreams.get(peerId);
}


function updateTurnBadge(){
  const badge=$('#callTurnBadge');if(!badge)return;
  badge.textContent=state.rtcTurnConfigured?'TURN: ativo':'TURN: não configurado';
  badge.className='callStatusBadge '+(state.rtcTurnConfigured?'good':'bad');
}
function friendlyMediaError(error,kind='dispositivo'){
  const name=String(error?.name||'');
  if(name==='NotAllowedError'||name==='SecurityError')return 'O navegador bloqueou '+kind+'. Abra as permissões do site e permita o acesso.';
  if(name==='NotFoundError'||name==='DevicesNotFoundError')return 'Nenhum '+kind+' compatível foi encontrado.';
  if(name==='NotReadableError'||name==='TrackStartError')return 'Não foi possível usar '+kind+'. Outro aplicativo pode estar usando o dispositivo.';
  if(name==='OverconstrainedError'||name==='ConstraintNotSatisfiedError')return 'O dispositivo não suporta a qualidade selecionada. Tente uma qualidade menor.';
  if(name==='AbortError')return 'A abertura do dispositivo foi interrompida. Tente novamente.';
  return 'Não foi possível acessar '+kind+'. Verifique as permissões e tente novamente.';
}
function setCallReconnectState(show,title='Reconectando...',message='Tentando recuperar áudio e vídeo.'){
  const wrap=$('#callReconnectOverlay');if(!wrap)return;
  wrap.classList.toggle('hidden',!show);if($('#callReconnectTitle'))$('#callReconnectTitle').textContent=title;if($('#callReconnectText'))$('#callReconnectText').textContent=message;
}
function qualityClass(value){const q=String(value||'').toLowerCase();if(q==='boa')return 'good';if(q==='média'||q==='media')return 'medium';if(q==='ruim')return 'bad';return ''}
function updatePeerQualityBadge(peerId,quality,rtt=0){
  state.peerQuality.set(peerId,{quality,rtt,at:Date.now()});
  const card=$('#v-'+peerId),badge=card?.querySelector('.videoQualityBadge');
  if(badge){badge.textContent=quality+(rtt?(' · '+Math.round(rtt)+'ms'):'');badge.className='videoQualityBadge '+qualityClass(quality)}
  const member=document.querySelector('.member[data-peer-id="'+CSS.escape(String(peerId))+'"] .memberQuality');
  if(member){member.textContent=quality;member.className='memberQuality '+qualityClass(quality)}
}
function updateCallLayout(){
  const grid=$('#videoGrid');if(!grid)return;
  grid.classList.remove('layoutGrid','layoutFocus','layoutPresentation','hasPinned');
  grid.classList.add(state.callLayout==='focus'?'layoutFocus':state.callLayout==='presentation'?'layoutPresentation':'layoutGrid');
  let found=false;
  grid.querySelectorAll('.videoCard').forEach(card=>{const peerId=card.id.replace(/^v-/,'');const pinned=!!state.pinnedPeerId&&peerId===state.pinnedPeerId;card.classList.toggle('pinned',pinned);const btn=card.querySelector('.videoPinBtn');if(btn)btn.textContent=pinned?'Desafixar':'Fixar';if(pinned)found=true});
  grid.classList.toggle('hasPinned',found);
  [['callLayoutGridBtn','grid'],['callLayoutFocusBtn','focus'],['callLayoutPresentationBtn','presentation']].forEach(([id,mode])=>$('#'+id)?.classList.toggle('active',state.callLayout===mode));
  localStorage.setItem('acord-call-layout',state.callLayout);if(state.pinnedPeerId)localStorage.setItem('acord-call-pinned-peer',state.pinnedPeerId);else localStorage.removeItem('acord-call-pinned-peer');
}
function togglePinPeer(peerId){state.pinnedPeerId=state.pinnedPeerId===peerId?'':peerId;if(state.pinnedPeerId&&state.callLayout==='grid')state.callLayout='focus';updateCallLayout()}
function applyMobileCallMode(){const active=isMobileInterface()&&state.callPrefs.mobileFullscreen&&state.currentView==='voice'&&!!state.joinedVoiceId;document.body.classList.toggle('mobileCallFullscreen',active)}
function stopRemoteSpeakingMonitor(peerId){const raf=state.peerSpeakingRaf.get(peerId);if(raf)cancelAnimationFrame(raf);state.peerSpeakingRaf.delete(peerId);$('#v-'+peerId)?.classList.remove('speaking')}
function startRemoteSpeakingMonitor(peerId,analyser){stopRemoteSpeakingMonitor(peerId);if(!analyser)return;const data=new Uint8Array(analyser.frequencyBinCount);const tick=()=>{if(!state.peers.has(peerId))return stopRemoteSpeakingMonitor(peerId);analyser.getByteFrequencyData(data);const avg=data.reduce((a,b)=>a+b,0)/Math.max(1,data.length);$('#v-'+peerId)?.classList.toggle('speaking',avg>18);state.peerSpeakingRaf.set(peerId,requestAnimationFrame(tick))};tick()}
function stopMutedSpeechMonitor(){if(state.mutedSpeechRaf){cancelAnimationFrame(state.mutedSpeechRaf);state.mutedSpeechRaf=null}if(state.mutedSpeechStream){state.mutedSpeechStream.getTracks().forEach(t=>t.stop());state.mutedSpeechStream=null}}
async function startMutedSpeechMonitor(){
  stopMutedSpeechMonitor();if(!state.joinedVoiceId)return;
  try{const stream=await navigator.mediaDevices.getUserMedia({audio:{deviceId:state.preferredMicId?{exact:state.preferredMicId}:undefined,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});state.mutedSpeechStream=stream;const ctx=getSharedAudioContext();if(!ctx)return;const src=ctx.createMediaStreamSource(stream),analyser=ctx.createAnalyser();analyser.fftSize=256;analyser.smoothingTimeConstant=.72;src.connect(analyser);const data=new Uint8Array(analyser.frequencyBinCount);let hot=0;const tick=()=>{if(!state.mutedSpeechStream)return;analyser.getByteFrequencyData(data);const avg=data.reduce((a,b)=>a+b,0)/Math.max(1,data.length);hot=avg>22?hot+1:Math.max(0,hot-2);if(hot>28&&Date.now()>state.mutedSpeechCooldown){state.mutedSpeechCooldown=Date.now()+6000;toast('Você está falando, mas o microfone está mutado');hot=0}state.mutedSpeechRaf=requestAnimationFrame(tick)};tick()}catch{}
}

function cameraPreset(){
  if(state.cameraQuality==='360p')return {width:640,height:360,bitrate:700000,frameRate:24};
  if(state.cameraQuality==='720p')return {width:1280,height:720,bitrate:2200000,frameRate:30};
  return {width:1920,height:1080,bitrate:5000000,frameRate:30};
}

function saveCallPrefs(){
  localStorage.setItem('acord-echo-cancellation',state.callPrefs.echoCancellation?'1':'0');
  localStorage.setItem('acord-auto-gain',state.callPrefs.autoGain?'1':'0');
  localStorage.setItem('acord-call-auto-reconnect',state.callPrefs.autoReconnect?'1':'0');
  localStorage.setItem('acord-call-auto-rejoin',state.callPrefs.autoRejoin?'1':'0');
  localStorage.setItem('acord-call-adaptive',state.callPrefs.adaptiveQuality?'1':'0');
  localStorage.setItem('acord-call-mute-on-join',state.callPrefs.muteOnJoin?'1':'0');
  localStorage.setItem('acord-call-confirm-leave',state.callPrefs.confirmLeave?'1':'0');
  localStorage.setItem('acord-call-sounds',state.callPrefs.sounds?'1':'0');
  localStorage.setItem('acord-call-audio-only',state.callPrefs.audioOnly?'1':'0');
  localStorage.setItem('acord-call-mirror-self',state.callPrefs.mirrorSelf?'1':'0');
  localStorage.setItem('acord-call-hide-self',state.callPrefs.hideSelf?'1':'0');
  localStorage.setItem('acord-call-wake-lock',state.callPrefs.wakeLock?'1':'0');
  localStorage.setItem('acord-call-mobile-fullscreen',state.callPrefs.mobileFullscreen?'1':'0');
  localStorage.setItem('acord-call-quality-mode',state.callPrefs.qualityMode||'auto');
  localStorage.setItem('acord-call-screen-fps',String(state.callPrefs.screenFps||30));
  localStorage.setItem('acord-speaker-device',state.callPrefs.speakerId||'');
}

function applyCallVisualPrefs(){
  document.body.classList.toggle('callAudioOnly',!!state.callPrefs.audioOnly);
  document.body.classList.toggle('callMirrorSelf',!!state.callPrefs.mirrorSelf);
  document.body.classList.toggle('callHideSelf',!!state.callPrefs.hideSelf);
}

function syncCallPrefsUI(){
  const map={
    echoCancellationToggle:state.callPrefs.echoCancellation,
    autoGainToggle:state.callPrefs.autoGain,
    callAutoReconnectToggle:state.callPrefs.autoReconnect,
    callAutoRejoinToggle:state.callPrefs.autoRejoin,
    callAdaptiveToggle:state.callPrefs.adaptiveQuality,
    callMuteOnJoinToggle:state.callPrefs.muteOnJoin,
    callConfirmLeaveToggle:state.callPrefs.confirmLeave,
    callSoundsToggle:state.callPrefs.sounds,
    callAudioOnlyToggle:state.callPrefs.audioOnly,
    callMirrorSelfToggle:state.callPrefs.mirrorSelf,
    callHideSelfToggle:state.callPrefs.hideSelf,
    callWakeLockToggle:state.callPrefs.wakeLock,
    callMobileFullscreenToggle:state.callPrefs.mobileFullscreen
  };
  for(const [id,value] of Object.entries(map)){
    const el=document.getElementById(id);
    if(el)el.checked=!!value;
  }
  if($('#callQualityMode'))$('#callQualityMode').value=state.callPrefs.qualityMode||'auto';
  if($('#callScreenFpsSelect'))$('#callScreenFpsSelect').value=String(state.callPrefs.screenFps||30);
  if($('#callCameraQualitySelect'))$('#callCameraQualitySelect').value=state.cameraQuality||'1080p';
  if($('#speakerDeviceSelect'))$('#speakerDeviceSelect').value=state.callPrefs.speakerId||'';
  applyCallVisualPrefs();
}

async function refreshCallDevices(){
  await refreshMediaDevices();
  const speaker=$('#speakerDeviceSelect');
  if(!speaker)return;
  const wanted=state.callPrefs.speakerId||'';
  speaker.innerHTML='<option value="">Padrão do sistema</option>';
  try{
    const devices=await navigator.mediaDevices.enumerateDevices();
    devices.filter(d=>d.kind==='audiooutput').forEach((d,i)=>{
      const o=document.createElement('option');
      o.value=d.deviceId;
      o.textContent=d.label||('Saída '+(i+1));
      speaker.appendChild(o);
    });
  }catch{}
  if([...speaker.options].some(o=>o.value===wanted))speaker.value=wanted;
  else state.callPrefs.speakerId='';
  syncCallPrefsUI();
}

async function applySpeakerDevice(){
  const sink=state.callPrefs.speakerId||'';
  const elements=[...state.remoteAudio.values(),$('#localMusicAudio')].filter(Boolean);
  for(const el of elements){
    if(typeof el.setSinkId==='function'){
      try{await el.setSinkId(sink)}catch{}
    }
  }
}

async function replaceMicrophoneDevice(){
  const old=state.localStream?.getAudioTracks()?.[0]||null;
  const stream=await navigator.mediaDevices.getUserMedia({
    audio:{
      deviceId:state.preferredMicId?{exact:state.preferredMicId}:undefined,
      echoCancellation:state.callPrefs.echoCancellation,
      noiseSuppression:state.noiseSuppression,
      autoGainControl:state.callPrefs.autoGain
    },
    video:false
  });
  const track=stream.getAudioTracks()[0];
  if(!track)throw new Error('Microfone indisponível');
  if(!state.localStream)state.localStream=new MediaStream();
  if(old)state.localStream.removeTrack(old);
  state.localStream.addTrack(track);
  if(old&&!old.enabled)track.enabled=false;
  await applyOutgoingAudioTrack(track);
  if(old){try{old.stop()}catch{}}
  startMicLevelMeter();
  return track;
}

async function replaceCameraDevice(){
  if(!state.cameraTrack||state.cameraTrack.readyState!=='live')return;
  const preset=cameraPreset();
  const stream=await navigator.mediaDevices.getUserMedia({
    video:{
      deviceId:state.preferredCameraId?{exact:state.preferredCameraId}:undefined,
      width:{ideal:preset.width},
      height:{ideal:preset.height},
      frameRate:{ideal:preset.frameRate,max:preset.frameRate},
      facingMode:{ideal:state.creativeLocal?.mobileFacingMode||'user'}
    },
    audio:false
  });
  const track=stream.getVideoTracks()[0];
  if(!track)throw new Error('Câmera indisponível');
  const old=state.cameraTrack;
  state.cameraTrack=track;
  if(state.localStream){
    if(old)state.localStream.removeTrack(old);
    state.localStream.addTrack(track);
  }
  if(!state.screenTrack)await replaceVideoForAll(track);
  await applyCameraSenderQuality();
  if(old){try{old.stop()}catch{}}
  ensureCard('local',state.username+' (você)',state.localStream,true);
}

function stopMicLevelMeter(){
  if(state.callMicMeterTimer){
    cancelAnimationFrame(state.callMicMeterTimer);
    state.callMicMeterTimer=null;
  }
  try{state.callMicSource?.disconnect()}catch{}
  state.callMicSource=null;
  state.callMicAnalyser=null;
}

function startMicLevelMeter(){
  stopMicLevelMeter();
  const track=state.localStream?.getAudioTracks()?.[0];
  if(!track)return;
  const context=getSharedAudioContext();
  if(!context)return;
  try{
    const source=context.createMediaStreamSource(new MediaStream([track]));
    const analyser=context.createAnalyser();
    analyser.fftSize=256;
    analyser.smoothingTimeConstant=.72;
    source.connect(analyser);
    state.callMicSource=source;
    state.callMicAnalyser=analyser;
    const data=new Uint8Array(analyser.frequencyBinCount);
    const tick=()=>{
      if(state.callMicAnalyser!==analyser)return;
      analyser.getByteFrequencyData(data);
      const avg=data.reduce((a,b)=>a+b,0)/Math.max(1,data.length);
      const level=Math.max(0,Math.min(100,Math.round(avg/1.1)));
      if($('#callMicMeterBar'))$('#callMicMeterBar').style.width=level+'%';
      if($('#callMicMeterText'))$('#callMicMeterText').textContent=level+'%';
      $('#v-local')?.classList.toggle('speaking',level>18&&track.enabled);
      state.callMicMeterTimer=requestAnimationFrame(tick);
    };
    tick();
  }catch{}
}

async function callDiagnostics(){
  let maxRtt=0,maxJitter=0,totalLost=0,totalReceived=0,relay=false;
  const rows=[];
  let score=100;

  for(const [peerId,pc] of state.peers){
    let rtt=0,jitter=0,lost=0,received=0,candidate='';
    try{
      const stats=await pc.getStats();
      stats.forEach(report=>{
        if(report.type==='candidate-pair'&&report.state==='succeeded'&&(report.nominated||report.selected)){
          if(Number.isFinite(report.currentRoundTripTime))rtt=Math.max(rtt,report.currentRoundTripTime*1000);
        }
        if(report.type==='local-candidate'||report.type==='remote-candidate'){
          if(report.candidateType==='relay')relay=true;
          if(!candidate&&report.candidateType)candidate=report.candidateType;
        }
        if(report.type==='inbound-rtp'&&!report.isRemote){
          lost+=Number(report.packetsLost||0);
          received+=Number(report.packetsReceived||0);
          jitter=Math.max(jitter,Number(report.jitter||0)*1000);
        }
      });
    }catch{}
    const loss=(lost+received)>0?(lost/(lost+received))*100:0;
    maxRtt=Math.max(maxRtt,rtt);maxJitter=Math.max(maxJitter,jitter);
    totalLost+=lost;totalReceived+=received;
    if(rtt>180)score-=10;if(rtt>350)score-=15;
    if(jitter>30)score-=10;if(jitter>60)score-=15;
    if(loss>2)score-=15;if(loss>6)score-=20;
    const peerScore=Math.max(0,100-(rtt>350?40:rtt>180?20:0)-(jitter>60?30:jitter>30?15:0)-(loss>6?30:loss>2?15:0));
    const peerQuality=peerScore>=80?'Boa':peerScore>=55?'Média':'Ruim';updatePeerQualityBadge(peerId,peerQuality,rtt);
    rows.push((state.peerNames.get(peerId)||'Participante')+': '+Math.round(rtt)+' ms · jitter '+Math.round(jitter)+' ms · perda '+loss.toFixed(1)+'% · '+(candidate||'ICE'));
  }

  score=Math.max(0,Math.min(100,score));
  const quality=score>=80?'Boa':score>=55?'Média':'Ruim';
  const result={quality,score,rtt:Math.round(maxRtt),jitter:Math.round(maxJitter),lost:totalLost,received:totalReceived,relay,rows};

  const networkBadge=$('#callNetworkBadge');if(networkBadge){networkBadge.textContent='Conexão: '+quality+(result.rtt?(' · '+result.rtt+'ms'):'');networkBadge.className='callStatusBadge '+qualityClass(quality)}
  if($('#callHealthPanel')){
    $('#callHealthPanel').textContent=[
      'Qualidade: '+quality,
      'Ping: '+result.rtt+' ms',
      'Jitter: '+result.jitter+' ms',
      'Pacotes perdidos: '+result.lost,
      'Rota: '+(relay?'TURN/relay':'direta/STUN quando possível'),
      '',
      ...(rows.length?rows:['Sem participante remoto para medir.'])
    ].join('\n');
  }
  return result;
}

async function applyAdaptiveCallQuality(diag){
  if(!state.callPrefs.adaptiveQuality||!state.joinedVoiceId)return;
  const mode=state.callPrefs.qualityMode;
  const weak=mode==='weak'||diag.quality==='Ruim'||diag.rtt>350||diag.jitter>60;
  const medium=!weak&&(diag.quality==='Média'||diag.rtt>180||diag.jitter>30);
  const desired=mode==='quality'?'1080p':(weak?'360p':(medium?'720p':'1080p'));
  if(state.cameraQuality!==desired){
    state.cameraQuality=desired;
    localStorage.setItem('acord-camera-quality',desired);
    if($('#callCameraQualitySelect'))$('#callCameraQualitySelect').value=desired;
    if(state.cameraTrack?.readyState==='live'){
      const p=cameraPreset();
      try{await state.cameraTrack.applyConstraints({width:{ideal:p.width},height:{ideal:p.height},frameRate:{ideal:p.frameRate,max:p.frameRate}})}catch{}
      await applyCameraSenderQuality();
    }
  }
}

function stopCallHealthMonitor(){
  if(state.callHealthTimer){clearInterval(state.callHealthTimer);state.callHealthTimer=null}
}

function startCallHealthMonitor(){
  stopCallHealthMonitor();
  const tick=async()=>{
    if(!state.joinedVoiceId)return;
    try{
      const diag=await callDiagnostics();
      if(diag.quality==='Boa')state.callLastGoodAt=Date.now();
      await applyAdaptiveCallQuality(diag);
      if(state.callPrefs.autoReconnect&&diag.quality==='Ruim'&&Date.now()-state.callLastGoodAt>12000){
        const failed=[...state.peers.values()].some(pc=>['failed','disconnected'].includes(pc.connectionState)||pc.iceConnectionState==='failed');
        if(failed)repairCall(true).catch(()=>{});
      }
    }catch{}
  };
  tick();
  state.callHealthTimer=setInterval(tick,5000);
}

async function restartPeerIce(peerId,pc){
  if(!pc || pc.connectionState==='closed') return false;

  try{
    if(pc.signalingState!=='stable') return false;

    try{pc.restartIce()}catch{}
    await attachLocalTracks(pc);

    const offer=await pc.createOffer({iceRestart:true});
    await pc.setLocalDescription(offer);

    socket.emit('offer',{
      target:peerId,
      sdp:pc.localDescription
    });

    return true;
  }catch(error){
    console.warn('ICE restart falhou para',peerId,error);
    return false;
  }
}

async function repairCall(silent=false){
  if(state.callRepairing)return;
  state.callRepairing=true;
  try{
    if(!silent)toast('Reparando a call...');
    setCallReconnectState(true,'Corrigindo sua call...','Reiniciando conexão, áudio e vídeo.');
    const mic=state.localStream?.getAudioTracks()?.[0];
    if(!mic||mic.readyState==='ended')await ensureMic();
    for(const [peerId,pc] of state.peers){
      let restarted=false;

      if(
        pc.connectionState!=='closed' &&
        ['failed','disconnected','connecting'].includes(pc.connectionState)
      ){
        restarted=await restartPeerIce(peerId,pc);
      }

      if(!restarted){
        try{await attachLocalTracks(pc)}catch{}
      }

      if(['failed','closed'].includes(pc.connectionState) && !restarted){
        try{pc.close()}catch{}
        state.peers.delete(peerId);
        try{await makeOffer(peerId,state.peerNames.get(peerId)||'Usuário')}catch{}
      }
    }
    if(state.privateCallId)requestPrivateCallJoin(state.privateCallId);
    else if(state.activeVoiceServerId&&state.activeVoiceChannelId){
      socket.emit('join-voice',{serverId:state.activeVoiceServerId,channelId:state.activeVoiceChannelId,username:state.username});
    }
    await unlockAllRemoteAudio();
    startMicLevelMeter();
    setCallReconnectState(false);
    if(!silent)toast('Reparo concluído');
  }catch(error){
    console.error('Reparo da call:',error);
    setCallReconnectState(false);
    if(!silent)toast('Não foi possível reparar completamente a call');
  }finally{
    state.callRepairing=false;
  }
}

async function testCallSpeaker(){
  try{
    const ctx=getSharedAudioContext();
    if(!ctx)throw new Error();

    if(
      state.callPrefs.speakerId &&
      typeof ctx.setSinkId==='function'
    ){
      try{await ctx.setSinkId(state.callPrefs.speakerId)}catch{}
    }

    if(ctx.state==='suspended')await ctx.resume();

    const osc=ctx.createOscillator();
    const gain=ctx.createGain();

    gain.gain.value=.08;
    osc.frequency.value=523.25;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime+.35);

    toast(
      state.callPrefs.speakerId
        ? 'Som reproduzido na saída selecionada'
        : 'Som de teste reproduzido'
    );
  }catch{
    toast('Não foi possível testar o som')
  }
}

async function callPictureInPicture(){
  const video=document.querySelector('.videoCard.hasVideo:not(#v-local) video')||document.querySelector('#v-local video');
  if(!video||!document.pictureInPictureEnabled){toast('Picture-in-Picture indisponível');return}
  try{await video.requestPictureInPicture()}catch{toast('Não foi possível abrir Picture-in-Picture')}
}

async function flipMobileCamera(){
  const next=(state.creativeLocal?.mobileFacingMode||'user')==='user'?'environment':'user';
  state.creativeLocal.mobileFacingMode=next;saveCreativeLocal();
  if(state.cameraTrack?.readyState==='live'){
    try{await replaceCameraDevice();toast(next==='environment'?'Câmera traseira':'Câmera frontal')}catch{toast('Não foi possível trocar a câmera')}
  }else toast(next==='environment'?'Próxima câmera: traseira':'Próxima câmera: frontal');
}

async function updateCallWakeLock(){
  if(!state.callPrefs.wakeLock||!state.joinedVoiceId){
    if(state.callWakeLockHandle){try{await state.callWakeLockHandle.release()}catch{}state.callWakeLockHandle=null}
    return;
  }
  if(!('wakeLock' in navigator))return;
  try{state.callWakeLockHandle=await navigator.wakeLock.request('screen')}catch{}
}


function stopPreCallModalMedia(){if(state.preCallMeterRaf){cancelAnimationFrame(state.preCallMeterRaf);state.preCallMeterRaf=null}if(state.preCallStream){state.preCallStream.getTracks().forEach(t=>t.stop());state.preCallStream=null}const video=$('#preCallVideo');if(video)video.srcObject=null}
async function fillPreCallDevices(){try{const devices=await navigator.mediaDevices.enumerateDevices(),mic=$('#preCallMicSelect'),cam=$('#preCallCameraSelect');mic.innerHTML='';cam.innerHTML='';devices.filter(d=>d.kind==='audioinput').forEach((d,i)=>{const o=document.createElement('option');o.value=d.deviceId;o.textContent=d.label||('Microfone '+(i+1));mic.appendChild(o)});devices.filter(d=>d.kind==='videoinput').forEach((d,i)=>{const o=document.createElement('option');o.value=d.deviceId;o.textContent=d.label||('Câmera '+(i+1));cam.appendChild(o)});if(state.preferredMicId&&[...mic.options].some(o=>o.value===state.preferredMicId))mic.value=state.preferredMicId;if(state.preferredCameraId&&[...cam.options].some(o=>o.value===state.preferredCameraId))cam.value=state.preferredCameraId}catch{}}
async function restartPreCallMedia(){stopPreCallModalMedia();const cameraOff=$('#preCallCameraOffToggle')?.checked;try{const p=cameraPreset();const stream=await navigator.mediaDevices.getUserMedia({audio:{deviceId:$('#preCallMicSelect')?.value?{exact:$('#preCallMicSelect').value}:undefined,echoCancellation:state.callPrefs.echoCancellation,noiseSuppression:state.noiseSuppression,autoGainControl:state.callPrefs.autoGain},video:cameraOff?false:{deviceId:$('#preCallCameraSelect')?.value?{exact:$('#preCallCameraSelect').value}:undefined,width:{ideal:p.width},height:{ideal:p.height},frameRate:{ideal:p.frameRate,max:p.frameRate},facingMode:{ideal:state.creativeLocal?.mobileFacingMode||'user'}}});state.preCallStream=stream;const video=$('#preCallVideo');if(video){video.srcObject=stream;video.classList.toggle('hidden',cameraOff)}$('#preCallVideoOff')?.classList.toggle('hidden',!cameraOff);const audioTrack=stream.getAudioTracks()[0],ctx=getSharedAudioContext();if(audioTrack&&ctx){const src=ctx.createMediaStreamSource(new MediaStream([audioTrack])),analyser=ctx.createAnalyser();analyser.fftSize=256;analyser.smoothingTimeConstant=.7;src.connect(analyser);const data=new Uint8Array(analyser.frequencyBinCount);const tick=()=>{if(!state.preCallStream)return;analyser.getByteFrequencyData(data);const avg=data.reduce((a,b)=>a+b,0)/Math.max(1,data.length),level=Math.max(0,Math.min(100,Math.round(avg/1.1)));if($('#preCallMicBar'))$('#preCallMicBar').style.width=level+'%';if($('#preCallMicText'))$('#preCallMicText').textContent=level+'%';state.preCallMeterRaf=requestAnimationFrame(tick)};tick()}}catch(error){toast(friendlyMediaError(error,'câmera ou microfone'))}}
async function openPreCallModal(){$('#preCallWrap')?.classList.remove('hidden');$('#preCallMuteToggle').checked=!!state.callPrefs.muteOnJoin;$('#preCallCameraOffToggle').checked=localStorage.getItem('acord-precall-camera-off')!=='0';await fillPreCallDevices();await restartPreCallMedia()}
function closePreCallModal(){stopPreCallModalMedia();$('#preCallWrap')?.classList.add('hidden')}

async function startPreCallPreview(){
  const video=$('#callPreviewVideo');
  if(!video)return;

  if(state.callPreviewStream){
    state.callPreviewStream.getTracks().forEach(t=>t.stop());
    state.callPreviewStream=null;
    video.srcObject=null;
    video.classList.add('hidden');
    $('#preCallTestBtn').textContent='Testar áudio/vídeo';
    return;
  }

  try{
    const p=cameraPreset();
    const stream=await navigator.mediaDevices.getUserMedia({
      audio:{
        deviceId:state.preferredMicId?{exact:state.preferredMicId}:undefined,
        echoCancellation:state.callPrefs.echoCancellation,
        noiseSuppression:state.noiseSuppression,
        autoGainControl:state.callPrefs.autoGain
      },
      video:{
        deviceId:state.preferredCameraId?{exact:state.preferredCameraId}:undefined,
        width:{ideal:p.width},
        height:{ideal:p.height},
        frameRate:{ideal:p.frameRate,max:p.frameRate},
        facingMode:{ideal:state.creativeLocal?.mobileFacingMode||'user'}
      }
    });
    state.callPreviewStream=stream;
    video.srcObject=stream;
    video.classList.remove('hidden');
    $('#preCallTestBtn').textContent='Fechar teste';
    await refreshCallDevices();
    toast('Prévia ativa');
  }catch(error){
    toast('Permita câmera e microfone para testar');
  }
}

function stopPreCallPreview(){
  if(state.callPreviewStream){
    state.callPreviewStream.getTracks().forEach(t=>t.stop());
    state.callPreviewStream=null;
  }
  const video=$('#callPreviewVideo');
  if(video){video.srcObject=null;video.classList.add('hidden')}
  if($('#preCallTestBtn'))$('#preCallTestBtn').textContent='Testar áudio/vídeo';
}

async function confirmCallLeave(){
  if(!state.callPrefs.confirmLeave || !state.joinedVoiceId) return true;
  return !!(await appDialog({
    title:'Sair da chamada',
    message:'Deseja realmente desconectar da call atual?',
    confirmText:'Sair',
    danger:true
  }));
}

let networkRepairTimer=null;

function scheduleCallNetworkRepair(reason='Mudança de rede'){
  if(!state.joinedVoiceId || !state.callPrefs.autoReconnect) return;

  if(networkRepairTimer) clearTimeout(networkRepairTimer);

  setCallReconnectState(
    true,
    'Reconectando...',
    reason+'. Ajustando a conexão da call.'
  );

  networkRepairTimer=setTimeout(()=>{
    networkRepairTimer=null;
    if(state.joinedVoiceId && navigator.onLine){
      repairCall(true).catch(()=>{});
    }
  },900);
}

window.addEventListener('offline',()=>{
  if(state.joinedVoiceId){
    setCallReconnectState(
      true,
      'Sem internet',
      'A call será recuperada automaticamente quando a conexão voltar.'
    );
  }
});

window.addEventListener('online',()=>{
  if(state.joinedVoiceId){
    scheduleCallNetworkRepair('Internet restaurada');
  }
});

const networkInfo=
  navigator.connection ||
  navigator.mozConnection ||
  navigator.webkitConnection;

networkInfo?.addEventListener?.('change',()=>{
  if(state.joinedVoiceId){
    scheduleCallNetworkRepair('A rede mudou');
  }
});

function createPeer(peerId, username, asOfferer = false){
  if(state.peers.has(peerId)) return state.peers.get(peerId);

  state.peerNames.set(peerId, username || 'Usuário');

  const pc = new RTCPeerConnection(rtcConfig);
  state.peers.set(peerId, pc);

  if(asOfferer){
    ensureOfferTransceivers(pc);
  }

  pc.onicecandidate = event=>{
    if(event.candidate){
      socket.emit('ice-candidate',{
        target:peerId,
        candidate:event.candidate
      });
    }
  };

  pc.ontrack = event=>{
    const name = state.peerNames.get(peerId) || 'Usuário';

    if(event.track.kind === 'audio'){
      ensureRemoteAudio(peerId, event.track, event.streams?.[0] || null);

      const visualStream = getRemoteStream(peerId);
      ensureCard(peerId, name, visualStream, false);
      return;
    }

    if(event.track.kind === 'video'){
      const stream = getRemoteStream(peerId);

      if(!stream.getTracks().some(t=>t.id===event.track.id)){
        stream.addTrack(event.track);
      }

      ensureCard(peerId, name, stream, false);

      const refresh = ()=>ensureCard(peerId,name,stream,false);
      event.track.addEventListener('mute', refresh);
      event.track.addEventListener('unmute', refresh);
      event.track.addEventListener('ended', refresh);
    }
  };

  const updateConnectionStatus = ()=>{
    const connection = pc.connectionState;
    const ice = pc.iceConnectionState;

    if(connection === 'connected'){
      if(!state.screenTrack) $('#voiceStatus').textContent = 'Conectado';setCallReconnectState(false);unlockAllRemoteAudio();
    }else if(connection === 'connecting' || ice === 'checking'){
      $('#voiceStatus').textContent = 'Conectando mídia...';setCallReconnectState(true,'Conectando...','Estabelecendo áudio e vídeo com os participantes.');
    }else if(connection==='failed' || ice==='failed' || connection==='disconnected'){
      $('#voiceStatus').textContent='Reconectando mídia...';setCallReconnectState(true,'Reconectando...','A conexão oscilou. O Concorde está tentando recuperar a call.');

      if(state.callPrefs.autoReconnect){
        setTimeout(async()=>{
          const current=state.peers.get(peerId);
          if(current!==pc || current.connectionState==='connected') return;

          const restarted=await restartPeerIce(peerId,current);
          if(!restarted){
            repairCall(true).catch(()=>{});
          }
        },700);
      }

      if(state.privateCallId){
        setTimeout(async()=>{
          const current=state.peers.get(peerId);

          if(
            current!==pc ||
            !state.privateCallId ||
            current.connectionState==='connected'
          ){
            return;
          }

          try{
            current.close();
          }catch{}

          state.peers.delete(peerId);

          try{
            await makeOffer(
              peerId,
              state.peerNames.get(peerId) || username || 'Usuário'
            );
          }catch(error){
            console.warn('Renegociação da call privada falhou:',error);
          }
        },1200);
      }else{
        toast('A conexão de voz/vídeo falhou nesta rede.');
      }
    }
  };

  pc.onconnectionstatechange = updateConnectionStatus;
  pc.oniceconnectionstatechange = updateConnectionStatus;

  return pc;
}

async function flushCandidates(peerId){
  const pc = state.peers.get(peerId);
  const list = state.pendingCandidates.get(peerId)||[];

  if(!pc?.remoteDescription) return;

  for(const candidate of list){
    try{
      await pc.addIceCandidate(candidate);
    }catch(error){
      console.warn('ICE candidate rejeitado:', error);
    }
  }

  state.pendingCandidates.delete(peerId);
}

async function makeOffer(peerId, username){
  const pc=createPeer(peerId,username,true);

  if(!pc || pc.connectionState==='closed') return;

  // Se o peer já tinha sido criado como recebedor, garante os transceivers
  // antes de uma tentativa posterior de oferta.
  ensureOfferTransceivers(pc);

  if(pc.signalingState!=='stable'){
    return;
  }

  await attachLocalTracks(pc);

  const offer=await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.emit('offer',{
    target:peerId,
    sdp:pc.localDescription
  });
}


function clearPrivateJoinRetry(){
  if(state.privateJoinTimer){
    clearTimeout(state.privateJoinTimer);
    state.privateJoinTimer=null;
  }

  state.privateJoinAttempts=0;
  state.privateJoinCallId=null;
}

function requestPrivateCallJoin(callId){
  if(!callId || !socket.connected) return;

  const safeCallId=String(callId);
  state.privateJoinCallId=safeCallId;
  state.privateJoinAttempts+=1;

  socket.timeout(2500).emit(
    'join-private-call',
    {callId:safeCallId},
    (error,response)=>{
      if(state.privateCallId!==safeCallId) return;

      if(!error && response?.ok){
        clearPrivateJoinRetry();
        playJoinCue();

        $('#voiceStatus').textContent=response.isGroup
          ? 'Call privada em grupo · Conectado'
          : 'Call privada · Conectado';

        const participants=Array.isArray(response.participants)
          ? response.participants
          : [];

        renderMembers([
          {id:socket.id,username:state.username},
          ...participants
        ]);

        participants.forEach(participant=>{
          if(participant?.id){
            state.peerNames.set(participant.id,participant.username || 'Usuário');
          }
        });

        return;
      }

      if(response?.error){
        $('#voiceStatus').textContent=response.error;
      }

      if(state.privateJoinAttempts<4){
        state.privateJoinTimer=setTimeout(
          ()=>requestPrivateCallJoin(safeCallId),
          900 + state.privateJoinAttempts*450
        );
      }else{
        clearPrivateJoinRetry();
        $('#voiceStatus').textContent='Não foi possível entrar na call';
        toast('Falha ao entrar na chamada. Tente ligar novamente.');
      }
    }
  );
}

async function enterPrivateCall(callId,peerName){
  try{
    await ensureMic();
    stopPreCallPreview();
    const callMicTrack=state.localStream?.getAudioTracks()?.[0];
    if(callMicTrack&&state.callPrefs.muteOnJoin)callMicTrack.enabled=false;

    if(state.joinedVoiceId){
      socket.emit('leave-voice');
      closePeers();
    }

    state.privateCallId = callId;
    state.privatePeerName = peerName || 'Amigo';
    state.joinedVoiceId = 'private:' + callId;

    // Calls privadas não pertencem a nenhum servidor ou canal.
    state.activeVoiceServerId = null;
    state.activeVoiceChannelId = null;
    state.activeVoiceName = 'Chamada privada com ' + state.privatePeerName;

    setView('voice');
    setAppMode('private-call');

    $('#voiceTitle').textContent = 'Chamada privada com ' + state.privatePeerName;
    $('#topTitle').textContent = '☎ Chamada privada';
    $('#topSub').textContent = 'Somente você e ' + state.privatePeerName;
    $('#voiceStatus').textContent = 'Call privada · Conectando...';
    $('#quickInviteBtn')?.classList.add('hidden');

    syncVoiceControlsUI();

    ensureCard('local',state.username+' (você)',state.localStream,true);

    clearPrivateJoinRetry();
    requestPrivateCallJoin(callId);

    updateCallDock();
    syncCallPrefsUI();
    startMicLevelMeter();
    startCallHealthMonitor();
    updateCallWakeLock();
  }catch(error){
    console.error(error);
    toast(friendlyMediaError(error,'microfone'));
  }
}

function showIncomingCall(data){
  state.incomingCall = data;
  $('#incomingCallerName').textContent = data?.fromUsername || 'Um amigo';
  $('#incomingCallWrap').classList.remove('hidden');
}

function closeIncomingCall(){
  $('#incomingCallWrap').classList.add('hidden');
}


function playCallCue(kind){
  if(state.callPrefs && state.callPrefs.sounds===false) return;
  if(state?.labsPrefs?.dnd || state?.labsPrefs?.sounds===false) return;
  try{
    const AudioCtx=window.AudioContext || window.webkitAudioContext;
    if(!AudioCtx) return;

    const ctx=new AudioCtx();
    const now=ctx.currentTime;

    const gain=ctx.createGain();
    gain.connect(ctx.destination);

    const osc1=ctx.createOscillator();
    const osc2=ctx.createOscillator();

    osc1.type='sine';
    osc2.type='sine';

    if(kind==='join'){
      osc1.frequency.setValueAtTime(520,now);
      osc1.frequency.exponentialRampToValueAtTime(760,now+0.16);
      osc2.frequency.setValueAtTime(660,now+0.05);
      osc2.frequency.exponentialRampToValueAtTime(900,now+0.19);
    }else{
      osc1.frequency.setValueAtTime(760,now);
      osc1.frequency.exponentialRampToValueAtTime(420,now+0.18);
      osc2.frequency.setValueAtTime(600,now+0.03);
      osc2.frequency.exponentialRampToValueAtTime(320,now+0.2);
    }

    gain.gain.setValueAtTime(0.0001,now);
    gain.gain.exponentialRampToValueAtTime(0.16,now+0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001,now+0.22);

    osc1.connect(gain);
    osc2.connect(gain);

    osc1.start(now);
    osc2.start(now+0.025);
    osc1.stop(now+0.23);
    osc2.stop(now+0.23);

    setTimeout(()=>{
      try{ctx.close()}catch{}
    },350);
  }catch(error){
    console.warn('Não foi possível tocar o som da call:',error);
  }
}

function playJoinCue(){
  playCallCue('join');
}

function playLeaveCue(){
  playCallCue('leave');
}


function applyDeafenState(){
  const muted = !!state.deafened;

  for(const [peerId,audio] of state.remoteAudio.entries()){
    const node = state.peerAudioNodes.get(peerId);

    if(node?.gain){
      node.gain.gain.value = muted ? 0 : getPeerVolume(peerId);
      audio.muted = true;
    }else{
      audio.muted = muted;

      if(!muted){
        audio.volume = Math.min(1,getPeerVolume(peerId));
      }
    }
  }

  const button = $('#deafenBtn');

  if(button){
    button.textContent = muted ? '🔇 Fone mutado' : 'Fone';
    button.classList.toggle('off',muted);
  }
}

function toggleDeafen(){
  state.deafened = !state.deafened;
  applyDeafenState();

  toast(
    state.deafened
      ? 'Você não está ouvindo ninguém'
      : 'Áudio da call ativado'
  );
}

async function joinVoice(){
  const channel = currentVoice();
  if(!channel) return;

  const changingCall =
    !!state.joinedVoiceId &&
    (
      state.privateCallId ||
      state.activeVoiceServerId !== state.serverId ||
      state.activeVoiceChannelId !== channel.id
    );

  if(changingCall){
    socket.emit('leave-voice');
    closePeers();

    state.privateCallId = null;
    state.privatePeerName = null;
    state.joinedVoiceId = null;
  }

  state.privateCallId = null;
  state.privatePeerName = null;

  try{
    $('#joinVoiceBtn').disabled = true;
    $('#joinVoiceBtn').textContent = 'Entrando...';
    await ensureMic();
    stopPreCallPreview();
    const callMicTrack=state.localStream?.getAudioTracks()?.[0];
    if(callMicTrack&&state.callPrefs.muteOnJoin)callMicTrack.enabled=false;

    if(
      state.phoneCameraTrack &&
      state.phoneCameraTrack.readyState==='live'
    ){
      if(
        !state.localStream.getVideoTracks().some(
          track=>track.id===state.phoneCameraTrack.id
        )
      ){
        state.localStream.addTrack(state.phoneCameraTrack);
      }

      state.cameraTrack=state.phoneCameraTrack;
    }

    state.joinedVoiceId = channel.id;
    state.activeVoiceServerId = state.serverId;
    state.activeVoiceChannelId = channel.id;
    state.activeVoiceName = channel.name || 'Canal de voz';

    $('#voiceStatus').textContent = 'Conectando...';
    syncVoiceControlsUI();

    ensureCard('local',state.username+' (você)',state.localStream,true);

    if(state.phoneCameraTrack?.readyState==='live'){
      const preview=$('#phoneCameraPreview');
      if(preview){
        preview.srcObject=new MediaStream([state.phoneCameraTrack]);
        preview.muted=true;
        preview.playsInline=true;
        preview.play().catch(()=>{});
      }
      $('#phoneCameraPreviewWrap')?.classList.remove('hidden');
      $('#cameraBtn').textContent='📱 Câmera do celular';
      $('#cameraBtn').classList.remove('off');
    }

    unlockAllRemoteAudio();

    socket.emit('join-voice',{
      serverId:state.activeVoiceServerId,
      channelId:state.activeVoiceChannelId,
      username:state.username
    });

    updateCallDock();
    syncCallPrefsUI();
    startMicLevelMeter();
    startCallHealthMonitor();
    updateCallWakeLock();
    localStorage.setItem('acord-last-active-call',JSON.stringify({serverId:state.activeVoiceServerId,channelId:state.activeVoiceChannelId,name:state.activeVoiceName,at:Date.now()}));
  }catch(err){
    console.error(err);
    toast(friendlyMediaError(err,'microfone'));
  }finally{
    $('#joinVoiceBtn').disabled = false;
    $('#joinVoiceBtn').textContent = 'Entrar na voz';
  }
}

function closePeers(){
  for(const peerId of state.peerSpeakingRaf.keys())stopRemoteSpeakingMonitor(peerId);
  for(const pc of state.peers.values()) pc.close();

  for(const peerId of [...state.remoteAudio.keys()]){
    removeRemoteAudio(peerId);
  }

  state.peers.clear();
  state.peerNames.clear();
  state.remoteStreams.clear();

  for(const peerId of [...state.peerAudioNodes.keys()]){
    disconnectPeerAudioNode(peerId);
  }
  state.pendingCandidates.clear();
  $('#videoGrid').innerHTML = '';
}

function leaveVoice(){
  const wasPrivate=!!state.privateCallId;
  const wasInCall=!!state.joinedVoiceId;

  if(wasInCall){
    playLeaveCue();
  }

  clearPrivateJoinRetry();
  stopCallHealthMonitor();
  stopMicLevelMeter();
  stopMutedSpeechMonitor();
  stopPreCallPreview();
  closePreCallModal();
  if(state.callWakeLockHandle){try{state.callWakeLockHandle.release()}catch{}state.callWakeLockHandle=null}
  localStorage.removeItem('acord-last-active-call');
  if(state.phoneCameraToken){
    stopPhoneCameraConnection(true);
  }
  socket.emit('leave-voice');
  closePeers();

  if(state.screenStream) state.screenStream.getTracks().forEach(t=>t.stop());
  state.screenStream = null;
  state.screenTrack = null;

  if(state.cameraTrack){
    state.cameraTrack.stop();
    state.cameraTrack = null;
  }

  if(state.localStream){
    state.localStream.getTracks().forEach(t=>t.stop());
    state.localStream = null;
  }

  state.joinedVoiceId = null;
  state.peerVolumes.clear();
  state.deafened = false;
  applyDeafenState();
  state.activeVoiceServerId = null;
  state.activeVoiceChannelId = null;
  state.activeVoiceName = '';
  state.privateCallId = null;
  state.privatePeerName = null;
  $('#audioGateBtn').classList.add('hidden');
  $('#voiceStatus').textContent = 'Fora da chamada';
  syncVoiceControlsUI();
  $('#cameraBtn').textContent = 'Câmera';
  $('#cameraBtn').classList.add('off');
  $('#screenBtn').textContent = 'Compartilhar';
  $('#screenBtn').classList.remove('sharing');

  $('#localMusicPanel').classList.add('hidden');
  $('#musicBtn').classList.remove('musicActive');
  $('#localMusicAudio').pause();

  updateCallDock();
  applyMobileCallMode();

  if(wasPrivate){
    setView('friends');
    setAppMode('hub');
    $('#quickInviteBtn')?.classList.add('hidden');
    $('#topTitle').textContent='👥 Amigos';
    $('#topSub').textContent='seus amigos e chamadas';
  }
}

function toggleMic(){
  const t = state.localStream?.getAudioTracks()[0];if(!t)return;t.enabled=!t.enabled;$('#micBtn').textContent=t.enabled?'Microfone':'🔇 Microfone';$('#micBtn').classList.toggle('off',!t.enabled);if(t.enabled)stopMutedSpeechMonitor();else startMutedSpeechMonitor().catch(()=>{});
}


async function replaceVideoForAll(track){
  const tasks = [];

  for(const pc of state.peers.values()){
    let sender = getSenderByKind(pc,'video');

    if(!sender){
      const tx = pc.addTransceiver('video',{direction:'sendrecv'});
      sender = tx.sender;
    }

    tasks.push(sender.replaceTrack(track));
  }

  await Promise.allSettled(tasks);
}


async function applyCameraSenderQuality(){
  for(const pc of state.peers.values()){
    const tx = getTransceiverByKind(pc,'video');
    const sender = tx?.sender;

    if(!sender || !sender.track || sender.track !== state.cameraTrack) continue;

    try{
      const params = sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      const preset=cameraPreset();
      params.encodings[0].maxBitrate = preset.bitrate;
      params.encodings[0].maxFramerate = preset.frameRate;
      await sender.setParameters(params);
    }catch(error){
      console.warn('Não foi possível aplicar o bitrate Full HD da câmera:',error);
    }
  }
}

async function toggleCamera(){
  if(!state.joinedVoiceId) return;

  if(state.phoneCameraTrack?.readyState==='live'){
    state.phoneCameraTrack.enabled=!state.phoneCameraTrack.enabled;
    if(!state.screenTrack){
      await replaceVideoForAll(state.phoneCameraTrack.enabled ? state.phoneCameraTrack : null);
    }
    $('#cameraBtn').textContent=state.phoneCameraTrack.enabled ? '📱 Câmera do celular' : 'Câmera';
    $('#cameraBtn').classList.toggle('off',!state.phoneCameraTrack.enabled);
    return;
  }

  if(state.cameraTrack && state.cameraTrack.readyState==='live'){
    state.cameraTrack.enabled = !state.cameraTrack.enabled;

    if(!state.screenTrack){
      await replaceVideoForAll(state.cameraTrack.enabled ? state.cameraTrack : null);

      if(state.cameraTrack.enabled){
        await applyCameraSenderQuality();
      }
    }

    $('#cameraBtn').textContent = state.cameraTrack.enabled ? '📷 Câmera' : 'Câmera';
    $('#cameraBtn').classList.toggle('off',!state.cameraTrack.enabled);
    ensureCard('local',state.username+' (você)',state.localStream,true);
    return;
  }

  try{
    $('#cameraBtn').disabled = true;
    $('#cameraBtn').textContent = 'Abrindo...';

    const preset=cameraPreset();
    const cam = await navigator.mediaDevices.getUserMedia({
      video:{
        deviceId:state.preferredCameraId?{exact:state.preferredCameraId}:undefined,
        width:{ideal:preset.width},
        height:{ideal:preset.height},
        frameRate:{ideal:preset.frameRate,max:preset.frameRate},
        aspectRatio:{ideal:16/9},
        facingMode:{ideal:state.creativeLocal?.mobileFacingMode||'user'}
      },
      audio:false
    });

    state.cameraTrack = cam.getVideoTracks()[0];

    try{
      state.cameraTrack.contentHint = 'motion';
    }catch{}

    try{
      await state.cameraTrack.applyConstraints({
        width:{ideal:preset.width},
        height:{ideal:preset.height},
        frameRate:{ideal:preset.frameRate,max:preset.frameRate},
        aspectRatio:{ideal:16/9}
      });
    }catch(error){
      console.warn('A câmera não aceitou todas as configurações Full HD:',error);
    }

    if(!state.localStream) state.localStream = new MediaStream();
    state.localStream.addTrack(state.cameraTrack);

    await replaceVideoForAll(state.cameraTrack);
    await applyCameraSenderQuality();

    ensureCard('local',state.username+' (você)',state.localStream,true);
    $('#cameraBtn').textContent = '📷 Câmera';
    $('#cameraBtn').classList.remove('off');
  }catch(err){
    console.error(err);
    $('#cameraBtn').textContent = 'Câmera';
    $('#cameraBtn').classList.add('off');
    toast('Câmera não autorizada');
  }finally{
    $('#cameraBtn').disabled = false;
  }
}

async function applyOutgoingAudioTrack(track){
  const tasks=[];for(const pc of state.peers.values()){let sender=getSenderByKind(pc,'audio');if(!sender){sender=pc.addTransceiver('audio',{direction:'sendrecv'}).sender}tasks.push(sender.replaceTrack(track||null))}await Promise.allSettled(tasks);
}
async function startScreenAudioMix(){
  const mic=state.localStream?.getAudioTracks()?.[0]||null;const screen=state.screenAudioTrack;
  if(!screen){await applyOutgoingAudioTrack(mic);return}
  try{
    const AudioCtx=window.AudioContext||window.webkitAudioContext;if(!AudioCtx)throw new Error('AudioContext indisponível');
    if(state.screenAudioContext){try{state.screenAudioContext.close()}catch{}}
    const ctx=new AudioCtx();const dest=ctx.createMediaStreamDestination();
    if(mic)ctx.createMediaStreamSource(new MediaStream([mic])).connect(dest);
    ctx.createMediaStreamSource(new MediaStream([screen])).connect(dest);
    state.screenAudioContext=ctx;state.mixedAudioTrack=dest.stream.getAudioTracks()[0]||null;
    await applyOutgoingAudioTrack(state.mixedAudioTrack||mic);
  }catch{await applyOutgoingAudioTrack(mic)}
}
async function stopScreenAudioMix(){
  const mic=state.localStream?.getAudioTracks()?.[0]||null;
  if(state.mixedAudioTrack){try{state.mixedAudioTrack.stop()}catch{}}
  state.mixedAudioTrack=null;if(state.screenAudioContext){try{await state.screenAudioContext.close()}catch{}}
  state.screenAudioContext=null;state.screenAudioTrack=null;await applyOutgoingAudioTrack(mic);
}

async function stopScreen(){
  const oldTrack = state.screenTrack;
  state.screenTrack = null;

  if(oldTrack){
    oldTrack.onended = null;
  }

  if(state.screenStream){
    state.screenStream.getTracks().forEach(t=>{
      if(t.readyState !== 'ended') t.stop();
    });
  }

  state.screenStream = null;
  await stopScreenAudioMix();

  const replacement =
    state.cameraTrack &&
    state.cameraTrack.readyState === 'live' &&
    state.cameraTrack.enabled
      ? state.cameraTrack
      : null;

  await replaceVideoForAll(replacement);

  ensureCard('local',state.username+' (você)',state.localStream,true);
  $('#screenBtn').textContent = 'Compartilhar';
  $('#screenBtn').classList.remove('sharing');
  $('#cameraBtn').disabled = false;
  if(state.joinedVoiceId) $('#voiceStatus').textContent = 'Conectado';
}


function screenSharePreset(quality){
  const requested=[15,30,60].includes(Number(state.callPrefs.screenFps))?Number(state.callPrefs.screenFps):30;
  if(quality==='720p'){
    const fps=Math.min(requested,30);
    return {width:{ideal:1280,max:1280},height:{ideal:720,max:720},frameRate:{ideal:fps,max:fps},maxBitrate:fps<=15?1400000:2500000};
  }
  const fps=quality==='1080p60'?Math.max(30,requested):Math.min(requested,30);
  return {width:{ideal:1920,max:1920},height:{ideal:1080,max:1080},frameRate:{ideal:fps,max:fps},maxBitrate:fps>=60?8000000:(fps<=15?3000000:5000000)};
}

function updateShareQualityButtons(){
  document.querySelectorAll('[data-share-quality]').forEach(button=>{
    button.classList.toggle(
      'active',
      button.dataset.shareQuality === state.screenShareQuality
    );
  });
}

async function applyScreenSenderQuality(track,quality){
  const preset = screenSharePreset(quality);

  try{
    await track.applyConstraints({
      width:preset.width,
      height:preset.height,
      frameRate:preset.frameRate
    });
  }catch(error){
    console.warn('O navegador não aplicou todas as restrições de tela:',error);
  }

  for(const pc of state.peers.values()){
    const tx = getTransceiverByKind(pc,'video');
    const sender = tx?.sender;

    if(!sender || !sender.track) continue;

    try{
      const params = sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = preset.maxBitrate;
      params.encodings[0].maxFramerate = preset.frameRate.max || preset.frameRate.ideal || 30;
      await sender.setParameters(params);
    }catch(error){
      console.warn('Não foi possível aplicar bitrate da tela:',error);
    }
  }
}

function openSharePicker(){
  if(!state.joinedVoiceId){
    toast('Entre em um canal de voz primeiro');
    return;
  }

  if(state.screenTrack){
    stopScreen().catch(console.error);
    return;
  }

  updateShareQualityButtons();
  $('#sharePickerWrap').classList.remove('hidden');
}

function closeSharePicker(){
  $('#sharePickerWrap').classList.add('hidden');
}

async function startScreenShare(displaySurface){
  closeSharePicker();

  try{
    const preset = screenSharePreset(state.screenShareQuality);

    const videoOptions = {
      width:preset.width,
      height:preset.height,
      frameRate:preset.frameRate
    };

    if(displaySurface){
      videoOptions.displaySurface = displaySurface;
    }

    state.screenStream = await navigator.mediaDevices.getDisplayMedia({
      video:videoOptions,
      audio:true,
      selfBrowserSurface:'exclude',
      surfaceSwitching:'include'
    });

    state.screenTrack = state.screenStream.getVideoTracks()[0];
    state.screenAudioTrack = state.screenStream.getAudioTracks()[0] || null;

    if(!state.screenTrack){
      throw new Error('Nenhuma faixa de tela foi selecionada.');
    }

    try{
      state.screenTrack.contentHint = 'detail';
    }catch{}

    await replaceVideoForAll(state.screenTrack);
    await applyScreenSenderQuality(state.screenTrack,state.screenShareQuality);
    await startScreenAudioMix();

    const preview = new MediaStream([state.screenTrack]);
    ensureCard(
      'local',
      state.username+' — compartilhando tela',
      preview,
      true
    );

    $('#screenBtn').textContent = '⏹ Parar tela';
    $('#screenBtn').classList.add('sharing');
    $('#cameraBtn').disabled = true;
    const qualityLabel =
      state.screenShareQuality === '720p'
        ? '720p'
        : (
            state.screenShareQuality === '1080p60'
              ? '1080p 60 FPS'
              : '1080p'
          );

    $('#voiceStatus').textContent = 'Compartilhando tela · ' + qualityLabel;

    state.screenTrack.onended = ()=>{
      if(state.screenTrack){
        stopScreen().catch(console.error);
      }
    };
  }catch(error){
    state.screenStream = null;
    state.screenTrack = null;

    if(error?.name !== 'NotAllowedError'){
      console.error('Erro ao compartilhar tela:',error);
      toast(friendlyMediaError(error,'compartilhamento de tela'));
    }
  }
}

async function toggleScreen(){
  openSharePicker();
}

function renderMembers(list){
  state.lastVoiceMembers = Array.isArray(list) ? list : [];

  if($('#rightTitle')) $('#rightTitle').textContent = 'Na chamada';

  const box = $('#members');
  box.innerHTML = '';

  if(!list?.length){
    const p = document.createElement('div');
    p.style.color='var(--low)';
    p.style.fontSize='12px';
    p.textContent='Ninguém na voz ainda.';
    box.appendChild(p);
    return;
  }

  list.forEach(u=>{
    const row = document.createElement('div');
    row.className='member';
    if(u.id)row.dataset.peerId=String(u.id);

    const dot=document.createElement('span');
    dot.className='memberDot';

    const info=document.createElement('div');
    info.className='memberInfo';

    const name=document.createElement('span');
    name.textContent=u.username;
    name.style.display='block';

    const roles = roleNamesForUser(u.username);
    const primaryRole = roles[0] || null;

    if(primaryRole){
      const roleLine=document.createElement('div');
      roleLine.textContent='[' + primaryRole.name + ']';
      roleLine.style.cssText =
        'font-size:10px;font-weight:900;color:' + primaryRole.color + ';margin-bottom:2px;';

      name.style.color = primaryRole.color;
      info.append(roleLine,name);

      if(roles.length > 1){
        const extra=document.createElement('div');
        extra.textContent=roles.slice(1,3).map(role=>role.name).join(' · ');
        extra.style.cssText='font-size:9px;color:var(--low);margin-top:2px;';
        info.appendChild(extra);
      }
    }else{
      info.appendChild(name);
    }

    row.append(dot,info);
    if(u.id&&u.id!==socket.id){const q=state.peerQuality.get(u.id);const quality=document.createElement('span');quality.className='memberQuality '+qualityClass(q?.quality);quality.textContent=q?.quality||'—';row.appendChild(quality)}

    // Volume individual apenas para as outras pessoas.
    if(u.id && u.id !== socket.id){
      const controls=document.createElement('div');
      controls.className='memberVolume';
      controls.title='Volume individual desta pessoa';

      const minus=document.createElement('button');
      minus.type='button';
      minus.textContent='−';
      minus.title='Diminuir volume';

      const value=document.createElement('span');
      value.className='memberVolumeValue';
      value.textContent=Math.round(getPeerVolume(u.id) * 100) + '%';

      const plus=document.createElement('button');
      plus.type='button';
      plus.textContent='+';
      plus.title='Aumentar volume';

      minus.addEventListener('click',event=>{
        event.stopPropagation();
        changePeerVolume(u.id,-0.25);
      });

      plus.addEventListener('click',event=>{
        event.stopPropagation();
        changePeerVolume(u.id,0.25);
      });

      const mute=document.createElement('button');
      mute.type='button';
      mute.className='peerMuteBtn';
      mute.textContent=getPeerVolume(u.id)===0?'🔈':'🔇';
      mute.title=getPeerVolume(u.id)===0?'Restaurar áudio':'Mutar só para mim';
      mute.addEventListener('click',event=>{
        event.stopPropagation();
        const current=getPeerVolume(u.id);
        if(current===0){
          const saved=Number(localStorage.getItem('acord-peer-last-volume-'+String(u.username||'').toLowerCase()))||1;
          setPeerVolume(u.id,saved);
        }else{
          localStorage.setItem('acord-peer-last-volume-'+String(u.username||'').toLowerCase(),String(current));
          setPeerVolume(u.id,0);
        }
      });

      controls.append(mute,minus,value,plus);
      row.appendChild(controls);
    }

    box.appendChild(row);
  });
}


let acordWindowsInstallerUrl='';

function setWindowsDownloadVisibility(available){
  const main=$('#windowsDownloadBtn');
  const top=$('#topWindowsDownloadBtn');

  [main,top].forEach(button=>{
    if(!button)return;
    button.classList.remove('hidden');
    button.disabled=false;
    button.classList.toggle('installerPending',!available);
  });

  if(main){
    const title=main.querySelector('strong');
    const sub=main.querySelector('small');

    if(available){
      if(title)title.textContent='Baixar Acord para Windows';
      if(sub)sub.textContent='Instalador independente · .exe';
    }else{
      if(title)title.textContent='Baixar Acord para Windows';
      if(sub)sub.textContent='Instalador ainda não publicado';
    }
  }

  if(top){
    top.textContent=available?'↓ Windows .exe':'↓ Windows';
  }
}

async function refreshWindowsInstaller(){
  setWindowsDownloadVisibility(false);
  acordWindowsInstallerUrl='';

  try{
    const response=await fetch('/api/windows-installer',{
      cache:'no-store'
    });

    if(!response.ok)return;

    const data=await response.json();

    if(!data?.available || !data?.url)return;

    acordWindowsInstallerUrl=String(data.url);
    setWindowsDownloadVisibility(true);
  }catch{}
}

function downloadAcordWindows(){
  if(!acordWindowsInstallerUrl){
    toast('O instalador do Windows ainda não foi publicado.');
    return;
  }

  window.location.assign(acordWindowsInstallerUrl);
}

let deferredInstallPrompt = null;

function isStandaloneApp(){
  return window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
}

function updateInstallButton(){
  const btn=$('#installAppBtn');
  if(!btn) return;

  btn.classList.toggle(
    'hidden',
    !deferredInstallPrompt || isStandaloneApp()
  );
}

window.addEventListener('beforeinstallprompt',event=>{
  event.preventDefault();
  deferredInstallPrompt=null;
  $('#installAppBtn')?.classList.add('hidden','uiLegacyHidden');
});

window.addEventListener('appinstalled',()=>{
  deferredInstallPrompt=null;
  updateInstallButton();
  toast('Aplicativo instalado');
});

$('#installAppBtn').addEventListener('click',event=>{
  event.preventDefault();
});
$('#windowsDownloadBtn').addEventListener('click',downloadAcordWindows);
$('#topWindowsDownloadBtn').addEventListener('click',downloadAcordWindows);

refreshWindowsInstaller();

applyInterfaceMode();

if('serviceWorker' in navigator){
  const desktopClient=
    new URLSearchParams(location.search).get('desktop')==='1' ||
    /AcordDesktop\//i.test(navigator.userAgent);

  window.addEventListener('load',()=>{
    if(desktopClient){
      navigator.serviceWorker.getRegistrations()
        .then(registrations=>Promise.all(registrations.map(reg=>reg.unregister())))
        .catch(()=>{});
      return;
    }

    navigator.serviceWorker.register('/sw.js').catch(error=>{
      console.warn('Service Worker:',error);
    });
  });
}

$('#authLoginTab').addEventListener('click',()=>setAuthMode('login'));
$('#authRegisterTab').addEventListener('click',()=>setAuthMode('register'));
$('#loginBtn').addEventListener('click',submitAuthentication);
$('#authUsername').addEventListener('keydown',event=>{if(event.key==='Enter')$('#authPassword').focus()});
$('#authPassword').addEventListener('keydown',event=>{
  if(event.key==='Enter'){
    if(state.authMode==='register')$('#authPasswordConfirm').focus();else submitAuthentication();
  }
});
$('#authPasswordConfirm').addEventListener('keydown',event=>{if(event.key==='Enter')submitAuthentication()});
setAuthMode('login');
syncCallPrefsUI();
applyCallVisualPrefs();
refreshCallDevices().catch(()=>{});

$('#showAuthPasswordBtn').addEventListener('click',()=>{
  togglePasswordVisibility('#authPassword','#showAuthPasswordBtn');
});
$('#showAuthConfirmBtn').addEventListener('click',()=>{
  togglePasswordVisibility('#authPasswordConfirm','#showAuthConfirmBtn');
});

$('#createServerBtn').addEventListener('click',()=>openModal('server'));
$('#homeCreateServer').addEventListener('click',()=>openModal('server'));
$('#serverRolesBtn').addEventListener('click',()=>setView('roles'));

$('#createCategoryQuickBtn').addEventListener('click',()=>openModal('category'));
$('#createTextQuickBtn').addEventListener('click',()=>openModal('text'));
$('#createVoiceQuickBtn').addEventListener('click',()=>openModal('voice'));
$('#createStageQuickBtn').addEventListener('click',()=>openModal('stage'));

$('#homeCreateText').addEventListener('click',()=>openModal('text'));
$('#homeCreateVoice').addEventListener('click',()=>openModal('voice'));
$('#modalCancel').addEventListener('click',closeModal);
$('#modalOk').addEventListener('click',confirmModal);
$('#modalInput').addEventListener('keydown',e=>{if(e.key==='Enter')confirmModal();if(e.key==='Escape')closeModal()});
$('#modalWrap').addEventListener('click',e=>{if(e.target===$('#modalWrap'))closeModal()});

$('#profileBtn').addEventListener('click',openProfileModal);
$('#friendsProfileBtn').addEventListener('click',openProfileModal);
$('#concordePlusBtn').addEventListener('click',()=>openMegaView('profile',false));
$('#serverConcordeBtn').addEventListener('click',()=>openMegaView('server',true));
document.querySelectorAll('.megaNavBtn').forEach(btn=>btn.addEventListener('click',()=>selectMegaPage(btn.dataset.megaPage)));
$('#labsSearch').addEventListener('input',renderLabsFeatures);
$('#labsCategory').addEventListener('change',renderLabsFeatures);
$('#labsFeatureGrid').addEventListener('click',handleLabsGridClick);
$('#creativeSearch').addEventListener('input',renderCreative);
$('#creativeCategory').addEventListener('change',renderCreative);
$('#creativeGrid').addEventListener('click',handleCreativeClick);
$('#essentialMobileMode').addEventListener('change',event=>{state.interfaceMode=event.target.value});
$('#essentialDataSaver').addEventListener('change',event=>{state.dataSaver=event.target.checked});




$('#essentialRestoreFile').addEventListener('change',event=>{
  setEssentialActionStatus('Importando backup...');
  restoreEssentialBackup(event.target.files?.[0]);
});

$('#essentialSearchInput').addEventListener('keydown',event=>{
  if(event.key==='Enter'){
    event.preventDefault();
    runEssentialAction('search',event);
  }
});









$('#mobileHomeBtn').addEventListener('click',()=>{closeMobileServers();setAppMode('hub');setView('friends')});
$('#mobileServersBtn').addEventListener('click',toggleMobileServers);
$('#mobileChatBtn').addEventListener('click',()=>{
  closeMobileServers();
  if(state.serverId&&state.textChannelId)selectText(state.textChannelId);
  else toggleMobileServers();
});
$('#mobileCallBtn').addEventListener('click',()=>{
  closeMobileServers();
  if(state.joinedVoiceId){returnToActiveCall();return}
  if(state.voiceChannelId&&typeof selectVoice==='function'){selectVoice(state.voiceChannelId);return}
  toast('Escolha um canal de voz');
});
$('#mobileProfileBtn').addEventListener('click',()=>{closeMobileServers();openProfileModal()});
$('#mobileBackdrop').addEventListener('click',closeMobileServers);

window.addEventListener('resize',()=>{if(state.interfaceMode==='auto')applyInterfaceMode()});

$('#megaSaveProfile').addEventListener('click',saveMegaProfile);
$('#megaUnreadClearBtn').addEventListener('click',clearAllUnread);
$('#megaSaveServer').addEventListener('click',saveMegaServer);
$('#megaServerBanner').addEventListener('change',async event=>{
  const file=event.target.files?.[0];if(!file)return;
  try{state.megaServerBannerData=await readImageFile(file,1600,.72);toast('Banner pronto para salvar')}catch{toast('Não foi possível ler o banner')}
});
$('#megaMuteMember').addEventListener('click',()=>moderateMember('mute'));
$('#megaKickMember').addEventListener('click',()=>moderateMember('kick'));
$('#megaBanMember').addEventListener('click',()=>moderateMember('ban'));
$('#megaAuditBtn').addEventListener('click',()=>socket.emit('mega-get-audit',{serverId:state.serverId}));
$('#megaCreateEvent').addEventListener('click',()=>{
  socket.emit('mega-create-event',{serverId:state.serverId,title:$('#megaEventTitle').value,when:new Date($('#megaEventDate').value).getTime()});
});
$('#megaCreatePoll').addEventListener('click',()=>{
  socket.emit('mega-create-poll',{serverId:state.serverId,question:$('#megaPollQuestion').value,options:$('#megaPollOptions').value.split('|')});
});
$('#megaWatchLoad').addEventListener('click',()=>emitWatchParty(false));
$('#megaWatchPlay').addEventListener('click',()=>emitWatchParty(true));
$('#megaWatchPause').addEventListener('click',()=>emitWatchParty(false));
$('#megaWhiteboardClear').addEventListener('click',()=>socket.emit('mega-whiteboard-clear',{serverId:state.serverId}));
$('#megaMediaTest').addEventListener('click',testMedia);
$('#megaCallRepairBtn').addEventListener('click',()=>repairCall());
$('#megaCallDiagBtn').addEventListener('click',async()=>{
  const d=await callDiagnostics();
  $('#megaConnectionInfo').textContent='Qualidade: '+d.quality+' · Ping: '+d.rtt+' ms · Jitter: '+d.jitter+' ms · Perdidos: '+d.lost+' · '+(d.relay?'TURN/relay':'direta/STUN');
});
$('#megaCaptionsBtn').addEventListener('click',toggleLiveCaptions);
$('#megaRecordBtn').addEventListener('click',toggleLocalRecording);
$('#megaCallFile').addEventListener('change',event=>{
  const file=event.target.files?.[0];if(!file)return;if(file.size>450000){toast('Arquivo máximo: 450 KB');event.target.value='';return}
  const reader=new FileReader();reader.onload=()=>socket.emit('mega-call-file',{serverId:state.activeVoiceServerId||state.serverId,name:file.name,type:file.type||'application/octet-stream',data:String(reader.result||'')});
  reader.readAsDataURL(file);event.target.value='';
});
$('#megaCameraQuality').addEventListener('change',event=>{state.cameraQuality=event.target.value;localStorage.setItem('acord-camera-quality',state.cameraQuality);toast('Qualidade salva')});
$('#megaBlurPreview').addEventListener('change',event=>{$('#megaMediaPreview').style.filter=event.target.checked?'blur(8px)':'none'});
$('#megaPomodoroStart').addEventListener('click',startPomodoro);
$('#megaBotRun').addEventListener('click',runLocalBot);
$('#megaTenorKey').addEventListener('change',event=>localStorage.setItem('acord-tenor-key',event.target.value.trim()));
$('#megaEmojiBtn').addEventListener('click',()=>{$('#messageInput').value+='😀';toast('Emoji inserido no chat atual')});
$('#megaGifBtn').addEventListener('click',()=>{
  closeChatMediaPickers();
  $('#chatGifPicker')?.classList.remove('hidden');
  $('#chatGifSearchInput')?.focus();
  toast('Escolha um GIF no painel do chat');
});
$('#megaPinsBtn').addEventListener('click',async()=>{
  const server=currentServer();
  const pins=server?.pinned||[];
  await appDialog({
    title:'Mensagens fixadas',
    message:pins.length?pins.map(p=>p.channelId+' · '+p.messageId).join('\n'):'Nenhuma mensagem fixada.',
    confirmText:'Fechar'
  });
});
initMegaWhiteboard();

$('#friendsAccountBar').addEventListener('click',openProfileModal);
$('#profileCancelBtn').addEventListener('click',closeProfileModal);
$('#profileSaveBtn').addEventListener('click',saveProfile);
$('#logoutAccountBtn').addEventListener('click',logoutAccount);
$('#deleteAccountBtn').addEventListener('click',deleteAccount);

$('#profileInfoTabBtn').addEventListener('click',()=>{
  setProfileTab('profile');
});

$('#profileAppearanceTabBtn').addEventListener('click',()=>{
  setProfileTab('appearance');
});

$('#profileSettingsTabBtn').addEventListener('click',()=>{
  setProfileTab('settings');
});

$('#setMicHotkeyBtn').addEventListener('click',()=>{
  beginHotkeyCapture('mic');
});

$('#setDeafenHotkeyBtn').addEventListener('click',()=>{
  beginHotkeyCapture('deafen');
});

$('#clearMicHotkeyBtn').addEventListener('click',()=>{
  clearHotkey('mic');
});

$('#clearDeafenHotkeyBtn').addEventListener('click',()=>{
  clearHotkey('deafen');
});

document.querySelectorAll('[data-profile-theme]').forEach(button=>{
  button.addEventListener('click',()=>{
    const selectedTheme = button.dataset.profileTheme;

    if(selectedTheme === 'custom'){
      state.pendingTheme='custom';
      applyProfileTheme('custom');
      const currentCustom = state.pendingCustomColor || state.customColor || '#ff6b4a';
      applyCustomColor(currentCustom);
      updateCustomColorUI(currentCustom);
      updateProfileThemeButtons();
      $('#siteColorCustomBox')?.scrollIntoView({behavior:'smooth',block:'nearest'});
      return;
    }

    previewProfileTheme(selectedTheme);

    if(selectedTheme !== 'custom' && !(state.pendingCustomColor || state.customColor)){
      applyCustomColor('');
    }
  });
});

document.querySelectorAll('[data-profile-palette]').forEach(button=>{
  button.addEventListener('click',()=>{
    previewProfilePalette(button.dataset.profilePalette);
  });
});

$('#customColorPicker').addEventListener('input',event=>previewCustomColor(event.target.value));
$('#customColorHex').addEventListener('input',updateCustomColorFromHex);
$('#customColorR').addEventListener('input',updateCustomColorFromRgb);
$('#customColorG').addEventListener('input',updateCustomColorFromRgb);
$('#customColorB').addEventListener('input',updateCustomColorFromRgb);

$('#applyCustomColorBtn').addEventListener('click',()=>{
  updateCustomColorFromRgb();
  toast('Cor personalizada aplicada');
});

$('#resetCustomColorBtn').addEventListener('click',()=>{
  state.pendingCustomColor='';
  if((state.pendingTheme || state.theme) === 'custom'){
    state.pendingTheme='default';
    applyProfileTheme('default');
  }
  applyCustomColor('');
  updateCustomColorUI('#ff6b4a');
  updateProfileThemeButtons();
  toast('Cor personalizada removida');
});
$('#removeProfilePhotoBtn').addEventListener('click',()=>{
  state.pendingAvatar = '';
  applyAvatar(
    $('#profileAvatarPreview'),
    {username:$('#profileNameInput').value || state.username,avatar:''},
    $('#profileNameInput').value || state.username
  );
});
$('#profileBannerInput').addEventListener('change',async event=>{
  const file=event.target.files?.[0];if(!file)return;
  try{
    state.pendingBanner=await readImageFile(file,1200,.8);
    $('#profileBannerPreview').style.backgroundImage='url("' + state.pendingBanner.replace(/"/g,'') + '")';
  }catch{toast('Não foi possível usar esse banner')}
});

$('#profilePhotoInput').addEventListener('change',async event=>{
  const file = event.target.files?.[0];
  if(!file) return;

  try{
    state.pendingAvatar = await fileToAvatar(file);

    applyAvatar(
      $('#profileAvatarPreview'),
      {username:$('#profileNameInput').value || state.username,avatar:state.pendingAvatar},
      $('#profileNameInput').value || state.username
    );
  }catch(error){
    console.error(error);
    toast('Não foi possível usar essa foto');
  }
});
$('#profileModalWrap').addEventListener('click',event=>{
  if(event.target === $('#profileModalWrap')) closeProfileModal();
});

$('#memberProfileCloseBtn').addEventListener('click',closeServerMemberProfile);
$('#memberProfileModalWrap').addEventListener('click',event=>{
  if(event.target === $('#memberProfileModalWrap')) closeServerMemberProfile();
});

$('#serverSettingsBtn').addEventListener('click',()=>{
  if(!currentServer()){
    toast('Crie um servidor primeiro');
    return;
  }
  setView('settings');
});

$('#deleteServerBtn').addEventListener('click',deleteCurrentServer);

document.querySelectorAll('.settingsNavBtn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    setServerSettingsPage(btn.dataset.settingsPage);
  });
});

$('#serverSettingsName').addEventListener('input',updateServerSettingsPreview);
$('#serverSettingsDescription').addEventListener('input',updateServerSettingsPreview);
$('#serverSettingsTags').addEventListener('input',updateServerSettingsPreview);

document.querySelectorAll('.accentChoice').forEach(btn=>{
  btn.addEventListener('click',()=>{
    state.serverSettingsAccent = btn.dataset.accent || '#ff6b4a';
    updateServerSettingsPreview();
  });
});

$('#serverSettingsIconInput').addEventListener('change',async event=>{
  const file = event.target.files?.[0];
  if(!file) return;

  try{
    state.serverSettingsIcon = await readServerIcon(file);
    updateServerSettingsPreview();
  }catch(error){
    console.error(error);
    toast('Não foi possível usar esse ícone');
  }
});

$('#serverSettingsRemoveIcon').addEventListener('click',()=>{
  state.serverSettingsIcon = '';
  $('#serverSettingsIconInput').value = '';
  updateServerSettingsPreview();
});

$('#saveServerSettingsBtn').addEventListener('click',saveServerSettings);
$('#settingsOpenRolesBtn').addEventListener('click',()=>setView('roles'));
$('#settingsCopyInviteBtn').addEventListener('click',copyInvite);
$('#settingsDeleteServerBtn').addEventListener('click',deleteCurrentServer);

$('#acceptCallBtn').addEventListener('click',()=>{
  const call=state.incomingCall;
  if(!call) return;

  closeIncomingCall();

  if(call.isGroup){
    socket.emit('private-group-call-response',{
      callId:call.callId,
      accept:true
    });

    enterPrivateGroupCall(call.callId,call.groupName || 'Grupo privado');
  }else{
    socket.emit('private-call-response',{
      callId:call.callId,
      callerSocketId:call.callerSocketId,
      accept:true
    });

    enterPrivateCall(call.callId,call.fromUsername);
  }

  state.incomingCall=null;
});

$('#declineCallBtn').addEventListener('click',()=>{
  const call=state.incomingCall;
  if(!call) return;

  if(call.isGroup){
    socket.emit('private-group-call-response',{
      callId:call.callId,
      accept:false
    });
  }else{
    socket.emit('private-call-response',{
      callId:call.callId,
      callerSocketId:call.callerSocketId,
      accept:false
    });
  }

  state.incomingCall=null;
  closeIncomingCall();
});

$('#homeHubBtn').addEventListener('click',()=>{
  setAppMode('hub');
  setView('friends');
  renderFriends();

  $('#topTitle').textContent = '👥 Amigos';
  $('#topSub').textContent = 'seus amigos e chamadas';

  const url = new URL(location.href);

  if(state.serverId){
    url.searchParams.set('server',state.serverId);
  }

  history.replaceState(null,'',url);
});

$('#hubFriendsBtn').addEventListener('click',()=>{
  setView('friends');
  renderFriends();
});

$('#hubMessagesBtn').addEventListener('click',()=>{
  state.dmContactsMode='all';
  $('#dmSearch').placeholder='Buscar amigo ou grupo';
  setView('dm');
  renderDmContacts();
});

$('#hubGroupsBtn').addEventListener('click',()=>{
  state.dmContactsMode='groups';
  $('#dmSearch').placeholder='Buscar grupo';
  setView('dm');
  renderDmContacts();

  $('#topTitle').textContent='👥 Grupos privados';
  $('#topSub').textContent='seus grupos e chamadas privadas';
});

$('#friendsOnlineTab').addEventListener('click',()=>{
  state.friendsFilter='online';
  renderFriends();
});
$('#friendsAllTab').addEventListener('click',()=>{
  state.friendsFilter='all';
  renderFriends();
});
$('#friendsPendingTab').addEventListener('click',()=>{
  state.friendsFilter='pending';
  renderFriends();
});
$('#friendsSearch').addEventListener('input',renderFriends);
$('#addFriendBtn').addEventListener('click',()=>openModal('friend'));
$('#createPrivateGroupBtn').addEventListener('click',openPrivateGroupModal);
$('#dmCallBtn').addEventListener('click',callCurrentDmFriend);
$('#groupDeleteBtn').addEventListener('click',deleteCurrentPrivateGroup);
$('#groupCallBtn').addEventListener('click',callCurrentPrivateGroup);
$('#privateGroupCancelBtn').addEventListener('click',closePrivateGroupModal);
$('#privateGroupCreateBtn').addEventListener('click',createPrivateGroup);
$('#privateGroupModalWrap').addEventListener('click',event=>{
  if(event.target===$('#privateGroupModalWrap')) closePrivateGroupModal();
});
$('#addRoleBtn').addEventListener('click',()=>openModal('role'));
$('#homeCreateRole').addEventListener('click',()=>openModal('role'));
$('#roleColor').addEventListener('input',()=>{$('#roleColorText').textContent=$('#roleColor').value;});

$('#inviteBtn').addEventListener('click',copyInvite);
$('#quickInviteBtn').addEventListener('click',copyInvite);
$('#sendBtn').addEventListener('click',sendPublicChat);
$('#replyCancelBtn').addEventListener('click',()=>{state.replyToMessageId=null;$('#replyBar').classList.add('hidden')});
$('#contextReplyBtn').addEventListener('click',()=>{
  const message=messageContextTarget;
  closeMessageContextMenu();
  if(!message) return;

  state.replyToMessageId=message.id;
  $('#replyBarText').textContent='Respondendo a '+(message.username||'Usuário');
  $('#replyBar').classList.remove('hidden');
  $('#messageInput').focus();
});

$('#contextEditBtn').addEventListener('click',async()=>{
  const message=messageContextTarget;
  closeMessageContextMenu();
  if(!message || message.userId!==state.userId) return;

  const value=await appDialog({
    title:'Editar mensagem',
    message:'Altere o texto da mensagem.',
    value:message.text||'',
    confirmText:'Salvar'
  });
  if(value===null) return;

  socket.emit('chat-edit',{
    serverId:state.serverId,
    channelId:state.textChannelId,
    messageId:message.id,
    text:value
  });
});

$('#contextDeleteBtn').addEventListener('click',async()=>{
  const message=messageContextTarget;
  closeMessageContextMenu();
  if(!message || message.userId!==state.userId) return;

  const result=await appDialog({
    title:'Excluir mensagem',
    message:'Essa mensagem será removida do histórico.',
    confirmText:'Excluir',
    danger:true
  });
  if(!result) return;

  socket.emit('chat-delete',{
    serverId:state.serverId,
    channelId:state.textChannelId,
    messageId:message.id
  });
});

document.addEventListener('click',event=>{
  if(!event.target.closest('#messageContextMenu')){
    closeMessageContextMenu();
  }
});

window.addEventListener('blur',closeMessageContextMenu);
window.addEventListener('resize',closeMessageContextMenu);

const CHAT_EMOJIS=[
  '😀','😃','😄','😁','😆','😂','🤣','😊','😍','🥰','😘',
  '😎','🤩','🥳','😴','😭','😡','🤔','🤯','😱','🙃','😉',
  '👍','👎','👏','🙌','🤝','🙏','💪','👀','🔥','❤️','💚',
  '💙','💜','✨','⭐','🎉','🎮','🎧','⚽','🏆','🚀','✅',
  '❌','💯','😅','😢','😇','🤗','😋','🤤','😜','🤪','🫡',
  '🫶','👌','✌️','🤞','👋','💬','📌','🎵','📸','💡','⚡'
];

function closeChatMediaPickers(){
  $('#chatEmojiPicker')?.classList.add('hidden');
  $('#chatGifPicker')?.classList.add('hidden');
}

function appendToChatInput(value){
  const input=$('#messageInput');
  if(!input) return;

  const start=Number.isFinite(input.selectionStart)
    ? input.selectionStart
    : input.value.length;
  const end=Number.isFinite(input.selectionEnd)
    ? input.selectionEnd
    : input.value.length;

  input.value=
    input.value.slice(0,start)+
    value+
    input.value.slice(end);

  const next=start+value.length;
  input.focus();

  try{
    input.setSelectionRange(next,next);
  }catch{}
}

function initChatEmojiPicker(){
  const grid=$('#chatEmojiGrid');
  if(!grid || grid.childElementCount) return;

  for(const emoji of CHAT_EMOJIS){
    const button=document.createElement('button');
    button.type='button';
    button.className='chatEmojiOption';
    button.textContent=emoji;
    button.title='Inserir '+emoji;
    button.addEventListener('click',()=>{
      appendToChatInput(emoji);
      $('#chatEmojiPicker')?.classList.add('hidden');
    });
    grid.appendChild(button);
  }
}

function renderGifResults(urls){
  const box=$('#chatGifResults');
  if(!box) return;

  box.innerHTML='';

  const safe=(Array.isArray(urls)?urls:[])
    .filter(url=>/^https:\/\//i.test(String(url||'')))
    .slice(0,12);

  if(!safe.length){
    box.innerHTML='<div class="chatGifEmpty">Nenhum GIF encontrado.</div>';
    return;
  }

  for(const url of safe){
    const button=document.createElement('button');
    button.type='button';
    button.className='chatGifResult';

    const image=document.createElement('img');
    image.src=url;
    image.alt='GIF';
    image.loading='lazy';

    image.addEventListener('error',()=>{
      button.remove();
      if(!box.children.length){
        box.innerHTML='<div class="chatGifEmpty">Não foi possível carregar os GIFs.</div>';
      }
    });

    button.appendChild(image);
    button.addEventListener('click',()=>{
      appendToChatInput(($('#messageInput').value?' ':'')+url);
      closeChatMediaPickers();
    });

    box.appendChild(button);
  }
}

async function searchChatGifs(){
  const query=String($('#chatGifSearchInput')?.value||'').trim();
  if(!query){
    $('#chatGifSearchInput')?.focus();
    return;
  }

  const key=String(localStorage.getItem('acord-tenor-key')||'').trim();
  const hint=$('#chatGifSearchHint');
  const results=$('#chatGifResults');

  if(!key){
    if(hint){
      hint.textContent='Busca de GIF precisa de uma chave Tenor. Você ainda pode colar um link direto abaixo.';
    }
    results.innerHTML='<div class="chatGifEmpty">Cole um link HTTPS de GIF abaixo para inserir.</div>';
    return;
  }

  if(hint) hint.textContent='Buscando GIFs...';
  results.innerHTML='<div class="chatGifEmpty">Carregando...</div>';

  try{
    const response=await fetch(
      'https://tenor.googleapis.com/v2/search?q='+
      encodeURIComponent(query)+
      '&key='+
      encodeURIComponent(key)+
      '&limit=12&media_filter=gif'
    );

    if(!response.ok) throw new Error('Falha na busca');

    const data=await response.json();
    const urls=(data.results||[])
      .map(item=>item?.media_formats?.gif?.url)
      .filter(Boolean);

    renderGifResults(urls);

    if(hint){
      hint.textContent=urls.length
        ? 'Clique em um GIF para inserir na mensagem.'
        : 'Nenhum GIF encontrado.';
    }
  }catch{
    if(hint){
      hint.textContent='Não foi possível buscar GIFs. Você ainda pode colar um link direto abaixo.';
    }
    results.innerHTML='<div class="chatGifEmpty">Busca indisponível.</div>';
  }
}

function insertGifUrl(){
  const input=$('#chatGifUrlInput');
  const url=String(input?.value||'').trim();

  if(!/^https:\/\//i.test(url)){
    toast('Cole um link HTTPS válido');
    input?.focus();
    return;
  }

  appendToChatInput(($('#messageInput').value?' ':'')+url);
  if(input) input.value='';
  closeChatMediaPickers();
}

$('#chatImageBtn').addEventListener('click',()=>$('#chatImageInput').click());

$('#chatEmojiBtn').addEventListener('click',event=>{
  event.preventDefault();
  initChatEmojiPicker();

  const picker=$('#chatEmojiPicker');
  const opening=picker?.classList.contains('hidden');

  closeChatMediaPickers();

  if(opening){
    picker?.classList.remove('hidden');
  }
});

$('#chatGifBtn').addEventListener('click',event=>{
  event.preventDefault();

  const picker=$('#chatGifPicker');
  const opening=picker?.classList.contains('hidden');

  closeChatMediaPickers();

  if(opening){
    picker?.classList.remove('hidden');
    $('#chatGifSearchInput')?.focus();
  }
});

$('#chatEmojiCloseBtn').addEventListener('click',closeChatMediaPickers);
$('#chatGifCloseBtn').addEventListener('click',closeChatMediaPickers);
$('#chatGifSearchBtn').addEventListener('click',searchChatGifs);
$('#chatGifInsertUrlBtn').addEventListener('click',insertGifUrl);

$('#chatGifSearchInput').addEventListener('keydown',event=>{
  if(event.key==='Enter'){
    event.preventDefault();
    searchChatGifs();
  }
});

$('#chatGifUrlInput').addEventListener('keydown',event=>{
  if(event.key==='Enter'){
    event.preventDefault();
    insertGifUrl();
  }
});

document.addEventListener('click',event=>{
  if(
    !event.target.closest('#chatEmojiPicker') &&
    !event.target.closest('#chatGifPicker') &&
    !event.target.closest('#chatEmojiBtn') &&
    !event.target.closest('#chatGifBtn')
  ){
    closeChatMediaPickers();
  }
});

document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){
    closeChatMediaPickers();
  }
});
$('#chatImageInput').addEventListener('change',async event=>{
  const file=event.target.files?.[0];if(!file)return;
  try{
    let data='';
    if(String(file.type||'').startsWith('image/')){
      data=await readImageFile(file,1200,.78);
    }else{
      if(file.size>450000){toast('Arquivo máximo: 450 KB');event.target.value='';return}
      data=await new Promise((resolve,reject)=>{
        const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=reject;reader.readAsDataURL(file);
      });
    }
    state.pendingChatAttachment={name:file.name,type:file.type||'application/octet-stream',data};
    toast('Arquivo pronto para enviar');
  }catch{toast('Não foi possível anexar o arquivo')}
  event.target.value='';
});
$('#messageInput').addEventListener('keydown',event=>{
  if(event.key==='Enter' && !event.shiftKey){
    event.preventDefault();
    sendPublicChat();
  }
});

$('#dmSearch').addEventListener('input',renderDmContacts);
$('#dmSendBtn').addEventListener('click',sendDm);
$('#dmInput').addEventListener('keydown',event=>{
  if(event.key==='Enter') sendDm();
});

setInterval(()=>{
  if(state.currentView === 'voice'){
    syncVoiceControlsUI();
  }
},1000);

$('#preCallTestBtn').addEventListener('click',openPreCallModal);
$('#callLayoutGridBtn').addEventListener('click',()=>{state.callLayout='grid';updateCallLayout()});
$('#callLayoutFocusBtn').addEventListener('click',()=>{state.callLayout='focus';updateCallLayout()});
$('#callLayoutPresentationBtn').addEventListener('click',()=>{state.callLayout='presentation';updateCallLayout()});
$('#preCallCloseBtn').addEventListener('click',closePreCallModal);$('#preCallCancelBtn').addEventListener('click',closePreCallModal);$('#preCallWrap').addEventListener('click',event=>{if(event.target===$('#preCallWrap'))closePreCallModal()});
$('#preCallMicSelect').addEventListener('change',async event=>{state.preferredMicId=event.target.value;localStorage.setItem('acord-mic-device',state.preferredMicId);await restartPreCallMedia()});
$('#preCallCameraSelect').addEventListener('change',async event=>{state.preferredCameraId=event.target.value;localStorage.setItem('acord-camera-device',state.preferredCameraId);await restartPreCallMedia()});
$('#preCallCameraOffToggle').addEventListener('change',event=>{localStorage.setItem('acord-precall-camera-off',event.target.checked?'1':'0');restartPreCallMedia()});$('#preCallMuteToggle').addEventListener('change',event=>{state.callPrefs.muteOnJoin=event.target.checked;saveCallPrefs()});
$('#preCallJoinBtn').addEventListener('click',async()=>{const cameraOn=!$('#preCallCameraOffToggle').checked;state.callPrefs.muteOnJoin=$('#preCallMuteToggle').checked;saveCallPrefs();closePreCallModal();await joinVoice();if(cameraOn&&state.joinedVoiceId&&!state.cameraTrack)await toggleCamera()});
$('#joinVoiceBtn').addEventListener('click',joinVoice);
$('#leaveVoiceBtn').addEventListener('click',async()=>{if(await confirmCallLeave())leaveVoice()});
$('#returnToCallBtn').addEventListener('click',returnToActiveCall);
$('#dockLeaveCallBtn').addEventListener('click',async()=>{if(await confirmCallLeave())leaveVoice()});
$('#micBtn').addEventListener('click',toggleMic);
$('#deafenBtn').addEventListener('click',toggleDeafen);

document.addEventListener('keydown',handleCallHotkey,true);
$('#audioGateBtn').addEventListener('click',async()=>{
  await unlockAllRemoteAudio();
  $('#audioGateBtn').classList.add('hidden');
});

$('#musicBtn').addEventListener('click',toggleLocalMusicPanel);

$('#localMusicChooseBtn').addEventListener('click',()=>{
  $('#localMusicFiles').click();
});

$('#localMusicFiles').addEventListener('change',event=>{
  addLocalMusicFiles(event.target.files);
  event.target.value = '';
});

$('#localMusicAddUrlBtn').addEventListener('click',addLocalMusicUrl);

$('#localMusicUrl').addEventListener('keydown',event=>{
  if(event.key === 'Enter'){
    event.preventDefault();
    addLocalMusicUrl();
  }
});

$('#localMusicPlayBtn').addEventListener('click',toggleLocalMusicPlayback);
$('#localMusicNextBtn').addEventListener('click',nextLocalMusic);
$('#localMusicPrevBtn').addEventListener('click',previousLocalMusic);

$('#localMusicVolume').addEventListener('input',event=>{
  const value = Math.max(0,Math.min(100,Number(event.target.value) || 0));
  const audio = $('#localMusicAudio');
  audio.volume = value / 100;
  $('#localMusicVolumeValue').textContent = Math.round(value) + '%';
  localStorage.setItem('ecord-local-music-volume',String(value));
});

$('#localMusicSeek').addEventListener('input',event=>{
  const audio = $('#localMusicAudio');
  if(!Number.isFinite(audio.duration) || audio.duration <= 0) return;

  const ratio = Math.max(0,Math.min(1000,Number(event.target.value) || 0)) / 1000;
  audio.currentTime = audio.duration * ratio;
});

$('#localMusicAudio').addEventListener('loadedmetadata',()=>{
  const audio = $('#localMusicAudio');
  $('#localMusicDuration').textContent = formatMusicTime(audio.duration);
});

$('#localMusicAudio').addEventListener('timeupdate',()=>{
  const audio = $('#localMusicAudio');
  $('#localMusicCurrent').textContent = formatMusicTime(audio.currentTime);
  $('#localMusicDuration').textContent = formatMusicTime(audio.duration);

  if(Number.isFinite(audio.duration) && audio.duration > 0){
    $('#localMusicSeek').value = Math.round((audio.currentTime / audio.duration) * 1000);
  }
});

$('#localMusicAudio').addEventListener('play',updateLocalMusicPlayButton);
$('#localMusicAudio').addEventListener('pause',updateLocalMusicPlayButton);
$('#musicShuffleBtn').classList.toggle('active',state.musicShuffle);
$('#musicRepeatBtn').classList.toggle('active',state.musicRepeat);
$('#musicShuffleBtn').addEventListener('click',()=>{
  state.musicShuffle=!state.musicShuffle;localStorage.setItem('acord-music-shuffle',state.musicShuffle?'1':'0');
  $('#musicShuffleBtn').classList.toggle('active',state.musicShuffle);
});
$('#musicRepeatBtn').addEventListener('click',()=>{
  state.musicRepeat=!state.musicRepeat;localStorage.setItem('acord-music-repeat',state.musicRepeat?'1':'0');
  $('#musicRepeatBtn').classList.toggle('active',state.musicRepeat);
});
$('#musicFavoriteBtn').addEventListener('click',()=>{
  const track=currentLocalMusic();if(!track)return;
  const key=track.name||track.url;
  if(state.musicFavorites.has(key))state.musicFavorites.delete(key);else state.musicFavorites.add(key);
  localStorage.setItem('acord-music-favorites',JSON.stringify([...state.musicFavorites]));
  $('#musicFavoriteBtn').textContent=state.musicFavorites.has(key)?'★ Favorito':'☆ Favoritar';
});
$('#localMusicAudio').addEventListener('ended',nextLocalMusic);
$('#localMusicAudio').addEventListener('error',()=>{
  updateLocalMusicPlayButton();
  toast('Não foi possível reproduzir essa música');
});

const savedLocalMusicVolume = Math.max(
  0,
  Math.min(
    100,
    Number(localStorage.getItem('ecord-local-music-volume') || 70)
  )
);

$('#localMusicVolume').value = savedLocalMusicVolume;
$('#localMusicVolumeValue').textContent = Math.round(savedLocalMusicVolume) + '%';
$('#localMusicAudio').volume = savedLocalMusicVolume / 100;

$('#cameraBtn').addEventListener('click',toggleCamera);
$('#callSettingsBtn').addEventListener('click',toggleCallSettings);

$('#micDeviceSelect').addEventListener('change',async event=>{
  state.preferredMicId=event.target.value;localStorage.setItem('acord-mic-device',state.preferredMicId);
  if(state.joinedVoiceId){try{await replaceMicrophoneDevice();toast('Microfone alterado')}catch{toast('Não foi possível trocar o microfone')}}
});
$('#cameraDeviceSelect').addEventListener('change',async event=>{
  state.preferredCameraId=event.target.value;localStorage.setItem('acord-camera-device',state.preferredCameraId);
  if(state.cameraTrack?.readyState==='live'){try{await replaceCameraDevice();toast('Câmera alterada')}catch{toast('Não foi possível trocar a câmera')}}
});
$('#speakerDeviceSelect').addEventListener('change',async event=>{
  state.callPrefs.speakerId=event.target.value;saveCallPrefs();await applySpeakerDevice();toast('Saída de áudio alterada');
});
$('#memberSearchInput').addEventListener('input',event=>{
  const query=String(event.target.value||'').trim().toLocaleLowerCase('pt-BR');
  document.querySelectorAll('#members .serverMemberRow').forEach(row=>{
    const text=String(row.textContent||'').toLocaleLowerCase('pt-BR');
    row.classList.toggle('hidden',!!query && !text.includes(query));
  });
});

$('#phoneCameraCreateBtn').addEventListener('click',createPhoneCameraLink);
$('#phoneCameraStopBtn').addEventListener('click',()=>stopPhoneCameraConnection(true));
$('#phoneCameraCopyLinkBtn').addEventListener('click',async()=>{
  if(!state.phoneCameraLink){
    toast('Crie o link da câmera primeiro');
    return;
  }

  try{
    await navigator.clipboard.writeText(state.phoneCameraLink);
    toast('Link da câmera copiado');
  }catch{
    const temp=document.createElement('textarea');
    temp.value=state.phoneCameraLink;
    temp.style.position='fixed';
    temp.style.opacity='0';
    document.body.appendChild(temp);
    temp.select();
    document.execCommand('copy');
    temp.remove();
    toast('Link da câmera copiado');
  }
});
$('#noiseSuppressionToggle').checked=state.noiseSuppression;
$('#noiseSuppressionToggle').addEventListener('change',async event=>{
  state.noiseSuppression=event.target.checked;localStorage.setItem('acord-noise-suppression',state.noiseSuppression?'1':'0');
  if(state.joinedVoiceId){try{await replaceMicrophoneDevice()}catch{}}
});
$('#echoCancellationToggle').addEventListener('change',async event=>{state.callPrefs.echoCancellation=event.target.checked;saveCallPrefs();if(state.joinedVoiceId){try{await replaceMicrophoneDevice()}catch{}}});
$('#autoGainToggle').addEventListener('change',async event=>{state.callPrefs.autoGain=event.target.checked;saveCallPrefs();if(state.joinedVoiceId){try{await replaceMicrophoneDevice()}catch{}}});
$('#callAutoReconnectToggle').addEventListener('change',event=>{state.callPrefs.autoReconnect=event.target.checked;saveCallPrefs()});
$('#callAutoRejoinToggle').addEventListener('change',event=>{state.callPrefs.autoRejoin=event.target.checked;saveCallPrefs()});
$('#callAdaptiveToggle').addEventListener('change',event=>{state.callPrefs.adaptiveQuality=event.target.checked;saveCallPrefs()});
$('#callMuteOnJoinToggle').addEventListener('change',event=>{state.callPrefs.muteOnJoin=event.target.checked;saveCallPrefs()});
$('#callConfirmLeaveToggle').addEventListener('change',event=>{state.callPrefs.confirmLeave=event.target.checked;saveCallPrefs()});
$('#callSoundsToggle').addEventListener('change',event=>{state.callPrefs.sounds=event.target.checked;saveCallPrefs()});
$('#callAudioOnlyToggle').addEventListener('change',event=>{state.callPrefs.audioOnly=event.target.checked;saveCallPrefs();applyCallVisualPrefs()});
$('#callMirrorSelfToggle').addEventListener('change',event=>{state.callPrefs.mirrorSelf=event.target.checked;saveCallPrefs();applyCallVisualPrefs()});
$('#callHideSelfToggle').addEventListener('change',event=>{state.callPrefs.hideSelf=event.target.checked;saveCallPrefs();applyCallVisualPrefs()});
$('#callWakeLockToggle').addEventListener('change',event=>{state.callPrefs.wakeLock=event.target.checked;saveCallPrefs();updateCallWakeLock()});
$('#callMobileFullscreenToggle').addEventListener('change',event=>{state.callPrefs.mobileFullscreen=event.target.checked;saveCallPrefs();applyMobileCallMode()});
$('#callQualityMode').addEventListener('change',event=>{state.callPrefs.qualityMode=event.target.value;saveCallPrefs()});
$('#callScreenFpsSelect').addEventListener('change',event=>{state.callPrefs.screenFps=Number(event.target.value||30);saveCallPrefs()});
$('#callCameraQualitySelect').addEventListener('change',async event=>{
  state.cameraQuality=event.target.value;localStorage.setItem('acord-camera-quality',state.cameraQuality);
  if(state.cameraTrack?.readyState==='live'){
    const p=cameraPreset();try{await state.cameraTrack.applyConstraints({width:{ideal:p.width},height:{ideal:p.height},frameRate:{ideal:p.frameRate,max:p.frameRate}})}catch{}
    await applyCameraSenderQuality();
  }
});
$('#pushToTalkToggle').checked=state.pushToTalk;
$('#pushToTalkToggle').addEventListener('change',event=>{
  state.pushToTalk=event.target.checked;localStorage.setItem('acord-ptt',state.pushToTalk?'1':'0');
});
$('#stageHandBtn').addEventListener('click',()=>{
  const c=currentVoice();if(c?.mode!=='stage')return;
  socket.emit('stage-raise-hand',{serverId:state.serverId,channelId:c.id});toast('Você levantou a mão');
});
document.addEventListener('keydown',event=>{
  if(!state.pushToTalk||event.code!=='Space'||['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))return;
  const t=state.localStream?.getAudioTracks?.()[0];if(t)t.enabled=true;
});
document.addEventListener('keyup',event=>{
  if(!state.pushToTalk||event.code!=='Space')return;
  const t=state.localStream?.getAudioTracks?.()[0];if(t)t.enabled=false;
});
$('#screenBtn').addEventListener('click',toggleScreen);
$('#callRepairQuickBtn').addEventListener('click',()=>repairCall());
$('#callRepairBtn').addEventListener('click',()=>repairCall());
$('#callDiagnosticsBtn').addEventListener('click',callDiagnostics);
$('#callSpeakerTestBtn').addEventListener('click',testCallSpeaker);
$('#callPipBtn').addEventListener('click',callPictureInPicture);
$('#callFlipCameraBtn').addEventListener('click',flipMobileCamera);
navigator.mediaDevices?.addEventListener?.('devicechange',async()=>{
  const wantedMic=state.preferredMicId,wantedCam=state.preferredCameraId;
  await refreshCallDevices();
  const devices=await navigator.mediaDevices.enumerateDevices().catch(()=>[]);
  if(wantedMic&&!devices.some(d=>d.kind==='audioinput'&&d.deviceId===wantedMic)){
    state.preferredMicId='';localStorage.removeItem('acord-mic-device');
    if(state.joinedVoiceId)replaceMicrophoneDevice().then(()=>toast('Microfone alterado automaticamente')).catch(()=>{});
  }
  if(wantedCam&&!devices.some(d=>d.kind==='videoinput'&&d.deviceId===wantedCam)){
    state.preferredCameraId='';localStorage.removeItem('acord-camera-device');
    if(state.cameraTrack?.readyState==='live')replaceCameraDevice().then(()=>toast('Câmera alterada automaticamente')).catch(()=>{});
  }
});

$('#sharePickerClose').addEventListener('click',closeSharePicker);
$('#sharePickerWrap').addEventListener('click',event=>{
  if(event.target === $('#sharePickerWrap')) closeSharePicker();
});
document.querySelectorAll('[data-share-quality]').forEach(button=>{
  button.addEventListener('click',()=>{
    state.screenShareQuality = button.dataset.shareQuality || '1080p';
    localStorage.setItem('ecord-screen-quality',state.screenShareQuality);
    updateShareQualityButtons();
  });
});

document.querySelectorAll('[data-share-kind]').forEach(button=>{
  button.addEventListener('click',()=>{
    startScreenShare(button.dataset.shareKind);
  });
});

function setShareFullscreenState(card=null){
  document.querySelectorAll('.fakeFullscreen').forEach(x=>x.classList.remove('fakeFullscreen'));
  const enabled=!!card;
  if(card) card.classList.add('fakeFullscreen');
  document.body.classList.toggle('locked',enabled);
  document.documentElement.classList.toggle('shareFullscreenActive',enabled);
}

$('#videoGrid').addEventListener('click',e=>{
  const card = e.target.closest('.videoCard');
  if(!card) return;
  const open = card.classList.contains('fakeFullscreen');
  setShareFullscreenState(open ? null : card);
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape') setShareFullscreenState(null);
});


socket.on('auth-success',payload=>{
  resetAuthSubmitButton();
  state.authRestoreFailures=0;
  if(payload?.recoveryProof) state.recoveryProof=String(payload.recoveryProof);
  window.AcordRuntime?.mark?.('auth-success',{cookieSession:!!payload?.cookieSession,sessionRestored:!!payload?.sessionRestored});
  setConnectionStatus('Conectado','online');
  state.accountCloudReady=false;
  $('#authError').textContent='';
  applyAuthProfile(
    payload?.profile,
    payload?.token,
    {cookieSession:!!payload?.cookieSession}
  );

  if(payload?.token){
    establishSessionCookie(payload.token).then(ok=>{
      if(ok) startAuthKeepalive();
    });
  }

  startAuthKeepalive();

  socket.emit('get-account-state');
  setTimeout(()=>syncOwnedServersToBackend(true),120);
  setTimeout(flushQueuedServerMessages,300);
  setTimeout(handlePendingServerInvite,80);

  if(payload?.recoveredAfterUpdate){
    setTimeout(()=>toast('Conta, servidores e amizades recuperados após a atualização'),250);
  }else if(payload?.accountRecovered){
    setTimeout(()=>toast('Conta reativada e login concluído'),250);
  }

  setTimeout(saveLocalRecoverySnapshot,300);
  requestNotifications();
});
socket.on('auth-cookie-missing',()=>{
  if(state.profileReady || state.authToken) return;
  window.AcordRuntime?.setStatus?.('Sessão não encontrada. Entre com sua conta.','neutral');
  window.__ACORD_APP_READY=false;
  state.cookieSession=false;
  $('#login').classList.remove('hidden');
  $('#appShell').classList.add('hidden');
});

socket.on('auth-error',payload=>{
  resetAuthSubmitButton();
  $('#authError').textContent=payload?.error||'Não foi possível entrar.';
  window.AcordRuntime?.setStatus?.('Login disponível.','neutral');
  window.AcordRuntime?.mark?.('auth-error',payload?.error||'unknown');
});
socket.on('auth-restore-retry',()=>{
  if(!state.authToken) return;

  setTimeout(()=>{
    if(socket.connected && state.authToken){
      socket.emit('auth-restore',{
          token:state.authToken,
          recovery:readLocalRecoverySnapshot()
        });
    }
  },1200);
});

socket.on('auth-alive',()=>{
  state.authRestoreFailures=0;
});
socket.on('auth-required',payload=>{
  resetAuthSubmitButton();

  // Não derruba a conta por uma falha isolada de restauração.
  if(
    (state.authToken || state.cookieSession) &&
    socket.connected &&
    state.authRestoreFailures < 1
  ){
    state.authRestoreFailures+=1;

    setTimeout(()=>{
      if(!socket.connected) return;
      if(state.authToken){
        socket.emit('auth-restore',{
          token:state.authToken,
          recovery:readLocalRecoverySnapshot()
        });
      }else if(state.cookieSession){
        socket.emit('auth-cookie');
      }
    },800);

    return;
  }

  stopAuthKeepalive();
  state.authRestoreFailures=0;
  state.authToken='';
  state.cookieSession=false;
  state.profileReady=false;
  window.AcordRuntime?.clearAuthToken?.();
  clearSessionCookie();

  $('#login').classList.remove('hidden');
  $('#appShell').classList.add('hidden');
  $('#authError').textContent='Sua sessão não pôde ser restaurada. Entre novamente.';
});
socket.on('auth-logout-success',clearAccountState);
socket.on('account-deleted',()=>{clearSessionCookie();clearAccountState();toast('Sua conta foi excluída.');});
socket.on('profile-error',payload=>toast(payload?.error||'Não foi possível salvar o perfil'));
socket.on('chat-message-updated',message=>{
  if(
    !message ||
    message.serverId!==state.serverId ||
    message.channelId!==state.textChannelId
  ){
    return;
  }

  const node=document.querySelector(
    '.message[data-message-id="' + String(message.id || '').replace(/"/g,'') + '"]'
  );

  if(!node) return;

  const historyNode=[...document.querySelectorAll('#messages .message')];
  const index=historyNode.indexOf(node);

  // Forma mais segura: recarrega o histórico atual para refletir texto/reação.
  socket.emit('join-text',{
    serverId:state.serverId,
    channelId:state.textChannelId
  });
});

socket.on('chat-message-deleted',payload=>{
  if(
    !payload ||
    String(payload.serverId)!==String(state.serverId) ||
    String(payload.channelId)!==String(state.textChannelId)
  ){
    return;
  }

  requestTextJoin(state.serverId,state.textChannelId);
});

socket.on('stage-hand-raised',data=>{
  toast('✋ '+(data?.username||'Alguém')+' pediu para falar');
  maybeNotify('Acord · Palco',(data?.username||'Alguém')+' levantou a mão');
});
socket.on('removed-from-server',({serverId})=>{
  toast('Você foi removido de um servidor');socket.emit('get-servers');
  if(state.serverId===serverId){setAppMode('hub');setView('friends')}
});

socket.on('online-users', users => {
  state.onlineUsers = Array.isArray(users) ? users : [];
  renderFriends();

  if(!$('#friendsView').classList.contains('hidden')){
    renderActiveFriends();
  }

  if(currentServer() && state.currentView !== 'voice'){
    renderServerPresence();
  }

  if(!$('#settingsMembersPage').classList.contains('hidden')){
    renderSettingsMembers();
  }
});

socket.on('account-state',payload=>{
  if(!payload||!state.profileReady)return;
  state.accountCloudReady=true;
  const p=payload.profile;
  if(p?.id&&String(p.id)===String(state.userId)){
    state.username=p.username||state.username;state.displayName=p.displayName||p.username||state.displayName;state.bio=p.bio||'';state.avatar=p.avatar||'';state.banner=p.banner||'';state.status=p.status||'online';state.customStatus=p.customStatus||'';state.pronouns=p.pronouns||'';state.activity=p.activity||'';state.links=p.links||{};state.privacy=p.privacy||{};
    localStorage.setItem('ecord-user-id',state.userId);localStorage.setItem('ecord-name',state.username);localStorage.setItem('ecord-bio',state.bio);try{localStorage.setItem('ecord-avatar',state.avatar)}catch{localStorage.removeItem('ecord-avatar')}
  }
  const cloudServers=Array.isArray(payload.servers)?payload.servers:[];state.servers=cloudServers;replaceServerCacheFromCloud(cloudServers);
  const fp=payload.friends||{};const cloudFriends=normalizeFriendList(fp.friends||[]);state.serverFriends=cloudFriends;state.incomingFriendRequests=Array.isArray(fp.incoming)?fp.incoming:[];state.outgoingFriendRequests=Array.isArray(fp.outgoing)?fp.outgoing:[];state.friendStateLoaded=true;state.friendsRestoreAttempted=false;
  const fj=JSON.stringify(cloudFriends);localStorage.setItem('ecord-friends',fj);localStorage.setItem('ecord-friends-backup',fj);
  state.privateGroups=Array.isArray(payload.groups)?payload.groups:[];
  if(!state.servers.some(s=>s.id===state.serverId)){state.serverId=state.servers[0]?.id||null;state.textChannelId=null;state.voiceChannelId=null;}
  refreshOwnProfileUI();renderServers();renderSidebar();renderRoles();renderFriends();renderActiveFriends();renderDmContacts();renderPrivateGroups();restoreCurrentView();saveLocalRecoverySnapshot();
});

socket.on('profile-saved',profile=>{
  if(!profile) return;

  state.profileReady = true;
  state.userId = profile.id || state.userId;
  state.username=profile.username||state.username;
  state.displayName=profile.displayName||profile.username||state.displayName;
  state.bio=profile.bio||'';
  state.avatar=profile.avatar||'';
  state.banner=profile.banner||'';
  state.status=profile.status||'online';
  state.customStatus=profile.customStatus||'';
  state.pronouns=profile.pronouns||'';
  state.activity=profile.activity||'';
  state.links=profile.links||{};
  state.privacy=profile.privacy||{};

  localStorage.setItem('ecord-user-id',state.userId);
  localStorage.setItem('ecord-name',state.username);
  localStorage.setItem('ecord-bio',state.bio);

  try{
    localStorage.setItem('ecord-avatar',state.avatar);
  }catch{
    localStorage.removeItem('ecord-avatar');
  }

  refreshOwnProfileUI();
  closeProfileModal();
  renderFriends();
  restoreCurrentView();

  // Garantia extra para F5: agora que o usuário está identificado,
  // solicita novamente apenas os servidores aos quais ele tem acesso.
  syncOwnedServersToBackend(true);
  socket.emit('get-servers');
  socket.emit('get-friend-state');

  handlePendingServerInvite();

  toast('Perfil salvo');
});

socket.on('friend-request-result',result=>{
  toast(result?.message || result?.error || 'Solicitação atualizada');

  if(result?.ok){
    state.friendsFilter='pending';
    renderFriends();
  }
});

socket.on('friend-state',payload=>{
  const incomingFriends=normalizeFriendList(payload?.friends||[]);const cachedFriends=readFriendCache();
  state.incomingFriendRequests=Array.isArray(payload?.incoming)?payload.incoming:[];state.outgoingFriendRequests=Array.isArray(payload?.outgoing)?payload.outgoing:[];state.friendStateLoaded=true;
  if(state.accountCloudReady){
    state.serverFriends=incomingFriends;const authoritative=JSON.stringify(incomingFriends);localStorage.setItem('ecord-friends',authoritative);localStorage.setItem('ecord-friends-backup',authoritative);state.friendsRestoreAttempted=false;
  }else if(incomingFriends.length){state.serverFriends=incomingFriends;saveFriends(incomingFriends);state.friendsRestoreAttempted=false;
  }else if(cachedFriends.length){state.serverFriends=cachedFriends;if(!state.friendsRestoreAttempted){state.friendsRestoreAttempted=true;socket.emit('restore-friends',{friends:cachedFriends});}
  }else{state.serverFriends=[];localStorage.setItem('ecord-friends','[]');}
  renderFriends();renderActiveFriends();renderDmContacts();
});

// Compatibilidade com resposta antiga, sem adicionar automaticamente.
socket.on('friend-lookup-result',result=>{
  if(!result?.ok){
    toast(result?.error || 'Essa pessoa não existe no Acord');
  }
});

socket.on('incoming-private-call',data=>{
  showIncomingCall(data);
  maybeNotify('Ligação no Acord',(data?.username||'Alguém')+' está ligando para você');
});

socket.on('private-call-accepted',data=>{
  toast((data?.username || 'Seu amigo') + ' aceitou');
  enterPrivateCall(data.callId,data.username || 'Amigo');
});

socket.on('private-call-declined',data=>{
  toast((data?.username || 'Seu amigo') + ' recusou a chamada');
});

socket.on('private-call-error',data=>{
  toast(data?.error || 'Não foi possível fazer a chamada');
});

socket.on('group-state',groups=>{
  state.privateGroups=Array.isArray(groups) ? groups : [];
  renderDmContacts();
});

socket.on('group-created',({group})=>{
  closePrivateGroupModal();
  toast('Grupo privado criado');

  if(group){
    setView('dm');
    setTimeout(()=>openGroupChat(group),40);
  }
});

socket.on('group-deleted',({groupId,groupName})=>{
  state.privateGroups=(state.privateGroups || []).filter(group=>group.id!==groupId);

  if(state.activeGroupId===groupId){
    state.activeGroupId=null;
    $('#dmTitle').textContent='Selecione um amigo';
    $('#dmSubtitle').textContent='Conversa privada';
    $('#dmMessages').innerHTML='';
    $('#dmInput').disabled=true;
    $('#dmSendBtn').disabled=true;
    $('#dmCallBtn').classList.add('hidden');
    $('#groupCallBtn').classList.add('hidden');
    $('#groupDeleteBtn').classList.add('hidden');
  }

  renderDmContacts();
  toast('Grupo "' + (groupName || 'privado') + '" excluído');
});

socket.on('private-group-call-started',data=>{
  enterPrivateGroupCall(data.callId,data.groupName || 'Grupo privado');
});

socket.on('incoming-private-group-call',data=>{
  state.incomingCall={
    ...data,
    isGroup:true
  };

  $('#incomingCallerName').textContent=
    (data?.fromUsername || 'Alguém') + ' · ' + (data?.groupName || 'Grupo privado');

  $('#incomingCallWrap').classList.remove('hidden');

  maybeNotify(
    'Chamada de grupo no Acord',
    (data?.fromUsername || 'Alguém') + ' iniciou uma chamada em ' + (data?.groupName || 'um grupo')
  );
});

socket.on('group-error',data=>{
  toast(data?.error || 'Não foi possível atualizar o grupo');
});

socket.on('group-history',payload=>{
  if(!payload || payload.groupId!==state.activeGroupId) return;

  $('#dmMessages').innerHTML='';
  (Array.isArray(payload.messages) ? payload.messages : []).forEach(appendGroupMessage);
});

socket.on('group-message',message=>{
  if(message?.groupId===state.activeGroupId){
    appendGroupMessage(message);
  }
});

function renderLoadedChatHistory({preserveScroll=false,oldHeight=0}={}){
  const box=$('#messages');
  if(!box) return;

  const oldTop=box.scrollTop;
  box.innerHTML='';

  if(state.chatHistoryHasMore){
    const more=document.createElement('button');
    more.id='loadOlderMessagesBtn';
    more.type='button';
    more.className='loadOlderMessagesBtn';
    more.textContent=state.chatHistoryLoading
      ? 'Carregando...'
      : '↑ Carregar mensagens anteriores';
    more.disabled=state.chatHistoryLoading;
    more.addEventListener('click',loadOlderChatMessages);
    box.appendChild(more);
  }

  state.chatHistoryRendering=true;
  for(const message of state.chatLoadedMessages){
    appendPublicChatMessage(message);
  }
  state.chatHistoryRendering=false;

  requestAnimationFrame(()=>{
    if(preserveScroll){
      const delta=box.scrollHeight-oldHeight;
      box.scrollTop=Math.max(0,oldTop+delta);
    }else if(state.labsPrefs?.['auto-scroll']!==false){
      box.scrollTop=box.scrollHeight;
    }
  });
}

function loadOlderChatMessages(){
  if(
    state.chatHistoryLoading ||
    !state.chatHistoryHasMore ||
    !state.chatHistoryOldestAt ||
    !state.serverId ||
    !state.textChannelId
  ) return;

  state.chatHistoryLoading=true;
  const button=$('#loadOlderMessagesBtn');
  if(button){
    button.disabled=true;
    button.textContent='Carregando...';
  }

  socket.emit('public-chat-history',{
    serverId:state.serverId,
    channelId:state.textChannelId,
    before:state.chatHistoryOldestAt,
    limit:80
  });
}

socket.on('public-chat-history',payload=>{
  if(!payload) return;

  if(
    String(payload.serverId)!==String(state.serverId) ||
    String(payload.channelId)!==String(state.textChannelId)
  ){
    return;
  }

  const incoming=Array.isArray(payload.messages)?payload.messages:[];
  const isOlder=Number(payload.before)>0;
  const box=$('#messages');
  const oldHeight=box?.scrollHeight||0;

  if(isOlder){
    const byId=new Map(
      [...incoming,...state.chatLoadedMessages]
        .filter(message=>message?.id)
        .map(message=>[String(message.id),message])
    );

    state.chatLoadedMessages=[...byId.values()]
      .sort((a,b)=>Number(a.at||0)-Number(b.at||0));
  }else{
    state.chatLoadedMessages=[...incoming]
      .sort((a,b)=>Number(a.at||0)-Number(b.at||0));
  }

  state.chatHistoryHasMore=!!payload.hasMore;
  state.chatHistoryLoading=false;
  state.chatHistoryOldestAt=state.chatLoadedMessages.length
    ? Number(state.chatLoadedMessages[0].at||0)
    : null;

  renderLoadedChatHistory({
    preserveScroll:isOlder,
    oldHeight
  });
});

socket.on('public-chat-message',message=>{
  if(!message) return;

  const blocked=creativeLocalList('blockedUsers').map(v=>String(v).toLowerCase());
  if(
    String(message.userId)!==String(state.userId) &&
    blocked.includes(String(message.username||'').toLowerCase())
  ){
    return;
  }

  const isCurrent=
    String(message.serverId)===String(state.serverId) &&
    String(message.channelId)===String(state.textChannelId) &&
    state.currentView==='chat';

  if(!isCurrent){
    if(String(message.userId)!==String(state.userId)){
      addUnread(message.serverId,message.channelId);
      playCallCue('join');
      maybeNotify('Nova mensagem em servidor',(message.username||'Alguém')+': '+String(message.text||'').slice(0,80));
    }
    return;
  }

  state.chatLoadedMessages=[
    ...state.chatLoadedMessages.filter(item=>String(item?.id)!==String(message.id)),
    message
  ].sort((a,b)=>Number(a.at||0)-Number(b.at||0));

  appendPublicChatMessage(message);
});


socket.on('public-chat-message-edited',message=>{
  if(String(message.serverId)!==String(state.serverId)||String(message.channelId)!==String(state.textChannelId))return;
  state.chatLoadedMessages=state.chatLoadedMessages.map(item=>
    String(item?.id)===String(message.id)?message:item
  );
  renderLoadedChatHistory({preserveScroll:true,oldHeight:$('#messages')?.scrollHeight||0});
});
socket.on('public-chat-message-deleted',payload=>{
  if(String(payload.serverId)!==String(state.serverId)||String(payload.channelId)!==String(state.textChannelId))return;
  state.chatLoadedMessages=state.chatLoadedMessages.filter(item=>String(item?.id)!==String(payload.messageId));
  state.chatHistoryOldestAt=state.chatLoadedMessages.length?Number(state.chatLoadedMessages[0].at||0):null;
  renderLoadedChatHistory({preserveScroll:true,oldHeight:$('#messages')?.scrollHeight||0});
});
socket.on('mega-server-state',server=>{
  if(!server?.id)return;
  const index=state.servers.findIndex(s=>s.id===server.id);
  if(index>=0)state.servers[index]=server;else state.servers.push(server);
  renderSidebar();renderMegaServerControls();renderMegaCommunity();updateWatchPartyUI(server.watchParty);
});
socket.on('mega-audit',renderMegaAudit);
socket.on('mega-whiteboard-state',payload=>{
  if(String(payload.serverId)!==String(state.serverId))return;
  clearWhiteboardLocal();(payload.strokes||[]).forEach(drawWhiteboardStroke);
});
socket.on('mega-whiteboard-stroke',payload=>{
  if(String(payload.serverId)===String(state.serverId))drawWhiteboardStroke(payload.stroke);
});
socket.on('mega-watch-state',payload=>{
  if(String(payload.serverId)===String(state.serverId))updateWatchPartyUI(payload.watchParty);
});
socket.on('mega-recording-notice',payload=>{
  toast((payload.username||'Alguém')+' iniciou uma gravação local');
});
socket.on('mega-call-file',payload=>{
  if(!payload?.data)return;const a=document.createElement('a');a.href=payload.data;a.download=payload.name||'arquivo';a.textContent='📎 '+(payload.username||'Alguém')+' enviou '+(payload.name||'arquivo');a.className='btn secondary small';a.style.position='fixed';a.style.right='16px';a.style.bottom='90px';a.style.zIndex='9999';document.body.appendChild(a);setTimeout(()=>a.remove(),15000);
});


socket.on('dm-history',payload=>{
  const messages=Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.messages)?payload.messages:[]);

  const targetId=String(payload?.targetUserId||state.dmTarget?.id||'');
  if(!targetId)return;
  if(state.dmTarget?.id && String(state.dmTarget.id)!==targetId)return;

  renderDmHistory(mergedDmHistory(targetId,messages));
});

socket.on('dm-message',message=>{
  if(!message) return;

  cacheDmMessage(message);

  const blocked=creativeLocalList('blockedUsers').map(v=>String(v).toLowerCase());
  if(
    message.fromUserId!==state.userId &&
    blocked.includes(String(message.fromUsername||'').toLowerCase())
  ){
    return;
  }

  if(message.fromUserId!==state.userId) maybeNotify('Nova mensagem privada',message.fromUsername||'Acord');

  const targetId = state.dmTarget?.id;
  const involvesCurrent =
    message.fromUserId===state.userId ||
    message.toUserId===state.userId;

  const otherId =
    message.fromUserId===state.userId
      ? message.toUserId
      : message.fromUserId;

  if(involvesCurrent && targetId && otherId===targetId){
    appendDmMessage(message);
  }
});

socket.on('profile-extra-updated',profile=>{
  if(!profile)return;
  state.customStatus=profile.customStatus||'';
  state.pronouns=profile.pronouns||'';
  state.activity=profile.activity||'';
  state.links=profile.links||{};
  state.privacy=profile.privacy||{};
  toast('Perfil atualizado');
  loadMegaData();
});

socket.on('server-updated',updatedServer=>{
  if(!updatedServer?.id) return;

  const index = state.servers.findIndex(server=>server.id===updatedServer.id);

  if(index >= 0){
    state.servers[index] = updatedServer;
  }else{
    state.servers.push(updatedServer);
  }

  cacheServers(state.servers);

  const wasCurrent = state.serverId===updatedServer.id;

  renderServers();

  if(wasCurrent){
    renderSidebar();
    renderRoles();
  }

  restoreCurrentView();
});

socket.on('server-list',list=>{
  if(!state.profileReady) return;

  const incoming=Array.isArray(list) ? list : [];
  const previousServerId=state.serverId;
  const previousView=state.currentView || 'friends';

  const cachedOwned=getCachedServers().filter(server=>String(server?.ownerId||'')===String(state.userId));
  if(state.accountCloudReady){
    state.servers=incoming;replaceServerCacheFromCloud(incoming);
  }else{
    const byId=new Map();for(const server of incoming){if(server?.id)byId.set(server.id,server)}for(const cached of cachedOwned){if(cached?.id&&!byId.has(cached.id))byId.set(cached.id,cached)}state.servers=[...byId.values()];if(state.servers.length)cacheServers(state.servers);
    const missingOwned=cachedOwned.filter(cached=>!incoming.some(server=>server?.id===cached.id));if(missingOwned.length)socket.emit('sync-owned-servers',{servers:missingOwned.map(safeServerSnapshot).filter(Boolean)});
  }
  state.restoreAttempted=true;

  const params=new URLSearchParams(location.search);
  const requested=
    params.get('server') ||
    localStorage.getItem('ecord-last-server-id');

  if(!state.servers.length){
    state.serverId=null;
    state.textChannelId=null;
    state.voiceChannelId=null;

    renderServers();
    renderSidebar();
    renderRoles();

    state.appInitialized=true;

    if(isServerView(previousView)){
      setView('friends');
    }else{
      restoreCurrentView();
    }

    return;
  }

  const selected=
    state.servers.find(server=>server.id===previousServerId) ||
    state.servers.find(server=>server.id===requested) ||
    state.servers[0];

  state.serverId=selected.id;
  localStorage.setItem('ecord-last-server-id',state.serverId);

  const textStillExists=selected.textChannels?.some(
    channel=>channel.id===state.textChannelId
  );

  if(!textStillExists){
    const savedText=localStorage.getItem('ecord-server-' + selected.id + '-text');
    state.textChannelId=
      selected.textChannels?.some(channel=>channel.id===savedText)
        ? savedText
        : (selected.textChannels?.[0]?.id || null);
  }

  if(state.textChannelId){
    localStorage.setItem('ecord-last-text-channel-id',state.textChannelId);
  }

  const voiceStillExists=selected.voiceChannels?.some(
    channel=>channel.id===state.voiceChannelId
  );

  if(!voiceStillExists){
    const savedVoice=localStorage.getItem('ecord-server-' + selected.id + '-voice');
    state.voiceChannelId=
      selected.voiceChannels?.some(channel=>channel.id===savedVoice)
        ? savedVoice
        : (selected.voiceChannels?.[0]?.id || null);
  }

  if(state.voiceChannelId){
    localStorage.setItem('ecord-last-voice-channel-id',state.voiceChannelId);
  }

  renderServers();
  renderSidebar();
  renderRoles();

  state.currentView=previousView;
  state.appInitialized=true;
  restoreCurrentView();

  if(state.callPrefs.autoRejoin&&!state.joinedVoiceId){
    try{
      const saved=JSON.parse(localStorage.getItem('acord-last-active-call')||'null');
      const recent=saved&&Date.now()-Number(saved.at||0)<1000*60*30;
      const server=recent?state.servers.find(s=>s.id===saved.serverId):null;
      const channel=server?.voiceChannels?.find(c=>c.id===saved.channelId);
      if(server&&channel){
        state.serverId=server.id;
        state.voiceChannelId=channel.id;
        localStorage.setItem('ecord-last-server-id',server.id);
        localStorage.setItem('ecord-last-voice-channel-id',channel.id);
        setTimeout(()=>{
          setView('voice');
          joinVoice().catch(()=>{});
        },700);
      }
    }catch{}
  }
});

socket.on('owned-servers-synced',payload=>{
  if(Array.isArray(payload?.restoredIds) && payload.restoredIds.length){
    toast(
      payload.restoredIds.length===1
        ? 'Servidor salvo foi recuperado'
        : payload.restoredIds.length + ' servidores salvos foram recuperados'
    );
  }

  socket.emit('get-servers');
});

socket.on('invite-joined',({serverId,serverName,alreadyMember})=>{
  clearServerInviteFromUrl();

  toast(
    alreadyMember
      ? 'Você já participa de ' + (serverName || 'este servidor')
      : 'Você entrou em ' + (serverName || 'um servidor')
  );

  socket.emit('get-servers');

  setTimeout(()=>{
    if(serverId) selectServer(serverId);
  },140);
});

socket.on('security-warning',data=>{
  toast(data?.error||'Muitas ações em pouco tempo. Aguarde alguns segundos.');
});

socket.on('permission-error',data=>{
  if(pendingServerInviteToken()){
    clearServerInviteFromUrl();
    state.privateInviteHandled=false;
  }

  toast(data?.error || 'Sem permissão');
});

socket.on('server-settings-updated',({serverId,message})=>{
  const keepView = state.currentView;
  const keepServer = state.serverId;

  renderServers();
  renderSidebar();

  state.currentView = keepView;
  state.serverId = keepServer;

  if(state.serverId===serverId && state.currentView==='settings'){
    openServerSettings();
  }else{
    restoreCurrentView();
  }

  toast(message || 'Servidor atualizado');
});

function removeServerFromLocalBackups(serverId){
  try{
    const safeId=String(serverId || '');
    const remaining=getCachedServers().filter(server=>server.id!==safeId);
    const payload=JSON.stringify(remaining);

    localStorage.setItem('ecord-server-cache',payload);
    localStorage.setItem('ecord-server-backup',payload);

    const recovery=readLocalRecoverySnapshot();

    if(recovery){
      recovery.servers=remaining;
      recovery.savedAt=Date.now();
      localStorage.setItem('acord-recovery-v1',JSON.stringify(recovery));
    }
  }catch{}
}

socket.on('server-deleted',({serverId})=>{
  removeServerFromLocalBackups(serverId);

  state.servers=(state.servers || []).filter(server=>server.id!==serverId);

  if(state.serverId===serverId){
    state.serverId=null;
    state.textChannelId=null;
    state.voiceChannelId=null;
  }

  renderServers();
  toast('Servidor apagado');
});

socket.on('server-created',({serverId})=>{
  // Solicita a lista completa antes de abrir o novo servidor.
  // Assim, criar um servidor nunca substitui a lista anterior no cliente.
  socket.emit('get-servers');

  setTimeout(()=>{
    const exists=state.servers.some(server=>server.id===serverId);

    if(exists){
      selectServer(serverId);
    }
  },180);

  toast('Servidor criado');
});

socket.on('role-updated',({message})=>{
  renderServers();
  renderSidebar();
  renderRoles();
  renderMembers(state.lastVoiceMembers || []);
  restoreCurrentView();
  toast(message || 'Cargos atualizados');
});

socket.on('category-updated',({message})=>{
  renderSidebar();
  toast(message || 'Canais atualizados');
});

socket.on('channel-created',({serverId,type,channelId})=>{
  if(serverId!==state.serverId) return;
  if(type==='text'){
    state.textChannelId=channelId;
    setTimeout(()=>selectText(channelId),50);
    toast('Chat criado');
  }else{
    state.voiceChannelId=channelId;
    setTimeout(()=>selectVoice(channelId),50);
    toast('Canal de voz criado');
  }
});

socket.on('channel-deleted',({serverId,type,channelId,message})=>{
  if(serverId!==state.serverId) return;

  const server=currentServer();

  if(type==='text' && state.textChannelId===channelId){
    state.textChannelId=server?.textChannels?.[0]?.id || null;

    if(state.textChannelId){
      setTimeout(()=>selectText(state.textChannelId),60);
    }else{
      setView('home');
      renderSidebar();
    }
  }

  if(type==='voice' && state.voiceChannelId===channelId){
    state.voiceChannelId=server?.voiceChannels?.[0]?.id || null;

    if(!state.joinedVoiceId){
      if(state.voiceChannelId){
        setTimeout(()=>selectVoice(state.voiceChannelId),60);
      }else{
        setView('home');
        renderSidebar();
      }
    }
  }

  toast(message || 'Canal excluído');
});

socket.on('voice-channel-removed',({serverId,channelId,message})=>{
  if(state.activeVoiceServerId===serverId && state.activeVoiceChannelId===channelId){
    playLeaveCue();
    closePeers();

    if(state.localStream){
      state.localStream.getTracks().forEach(track=>track.stop());
      state.localStream=null;
    }

    state.joinedVoiceId=null;
    state.activeVoiceServerId=null;
    state.activeVoiceChannelId=null;
    state.activeVoiceName='';

    $('#voiceStatus').textContent='Canal excluído';
    syncVoiceControlsUI();
    updateCallDock();
  }

  toast(message || 'O canal de voz foi excluído');
});

socket.on('phone-camera-created',data=>{
  if(!data?.token) return;
  closePhoneCameraPeer();
  state.phoneCameraToken=data.token;
  state.phoneCameraLink=location.origin + '/phone-camera/' + encodeURIComponent(data.token);
  updatePhoneCameraUI();
  toast('Escaneie o QR Code com o celular');
});

socket.on('phone-camera-phone-ready',data=>{
  if(data?.token!==state.phoneCameraToken) return;
  $('#phoneCameraStatus').textContent='Celular conectado · autorize a câmera';
});

socket.on('phone-camera-offer',data=>{
  receivePhoneCameraOffer(data).catch(error=>{
    console.error(error);
    $('#phoneCameraStatus').textContent='Falha ao receber a câmera do celular';
  });
});

socket.on('phone-camera-ice',async data=>{
  if(!data?.candidate || data.token!==state.phoneCameraToken || !state.phoneCameraPc) return;
  try{
    await state.phoneCameraPc.addIceCandidate(data.candidate);
  }catch{}
});

socket.on('phone-camera-stopped',data=>{
  if(data?.token && data.token!==state.phoneCameraToken) return;
  closePhoneCameraPeer();
  state.phoneCameraToken=null;
  state.phoneCameraLink='';
  updatePhoneCameraUI();
});


socket.on('text-history',()=>{});

socket.on('chat-message',()=>{});

socket.on('voice-participants',async participants=>{
  const safeParticipants=Array.isArray(participants) ? participants : [];

  if(!state.privateCallId){
    playJoinCue();
  }

  renderMembers([
    {id:socket.id,username:state.username},
    ...safeParticipants
  ]);

  for(const p of safeParticipants){
    if(!p?.id || p.id===socket.id) continue;

    state.peerNames.set(p.id,p.username || 'Usuário');

    const existing=state.peers.get(p.id);

    if(
      existing &&
      (
        existing.connectionState==='connected' ||
        existing.connectionState==='connecting' ||
        existing.signalingState!=='stable'
      )
    ){
      continue;
    }

    try{
      await makeOffer(p.id,p.username || 'Usuário');
    }catch(error){
      console.warn('Falha na oferta inicial:',error);
    }
  }

  unlockAllRemoteAudio();

  $('#voiceStatus').textContent=state.privateCallId
    ? 'Call privada · Conectando mídia...'
    : 'Conectado';
});

socket.on('voice-members',members=>{
  renderMembers(members);
});



socket.on('user-joined',({id,username})=>{
  if(!id || id===socket.id) return;

  playJoinCue();
  state.peerNames.set(id,username || 'Usuário');

  // Normalmente quem acabou de entrar recebe voice-participants e cria a offer.
  // Se essa primeira negociação não acontecer, o usuário que já estava na sala
  // inicia uma segunda tentativa depois de um pequeno atraso.
  setTimeout(async()=>{
    if(!state.joinedVoiceId) return;

    const existing=state.peers.get(id);

    if(
      existing &&
      (
        existing.connectionState==='connected' ||
        existing.connectionState==='connecting' ||
        existing.signalingState!=='stable'
      )
    ){
      return;
    }

    try{
      await makeOffer(id,username || 'Usuário');
    }catch(error){
      console.warn('Tentativa alternativa de conexão falhou:',error);
    }
  },900);
});

socket.on('offer',async({from,sdp,username})=>{
  let pc = state.peers.get(from);

  if(!pc){
    pc = createPeer(from,username,false);
  }

  try{
    await pc.setRemoteDescription(sdp);

    // Depois de ler a offer, os transceivers remotos já existem.
    // Agora encaixamos microfone e vídeo local nos mesmos m-lines.
    await attachLocalTracks(pc);
    await flushCandidates(from);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit('answer',{
      target:from,
      sdp:pc.localDescription
    });
  }catch(error){
    console.error('Erro ao receber offer:',error);
  }
});

socket.on('answer',async({from,sdp})=>{
  const pc = state.peers.get(from);
  if(!pc) return;

  try{
    if(pc.signalingState === 'have-local-offer'){
      await pc.setRemoteDescription(sdp);
      await flushCandidates(from);
    }
  }catch(error){
    console.error('Erro ao aplicar answer:',error);
  }
});

socket.on('ice-candidate',async({from,candidate})=>{
  const pc=state.peers.get(from);
  if(pc?.remoteDescription){
    try{await pc.addIceCandidate(candidate)}catch{}
  }else{
    const list=state.pendingCandidates.get(from)||[];
    list.push(candidate);
    state.pendingCandidates.set(from,list);
  }
});

socket.on('user-left',({id})=>{
  playLeaveCue();
  state.peers.get(id)?.close();
  state.peers.delete(id);
  state.peerNames.delete(id);
  state.remoteStreams.delete(id);
  removeRemoteAudio(id);
  document.getElementById('v-'+id)?.remove();
});

socket.on('disconnect',()=>{
  resetAuthSubmitButton();
  window.AcordRuntime?.mark?.('socket-disconnect');
  window.AcordRuntime?.setStatus?.('Conexão perdida. Tentando reconectar…','warn');
  setConnectionStatus('Reconectando…','offline');
  stopAuthKeepalive();
  if(state.joinedVoiceId)setCallReconnectState(true,'Sem conexão','Tentando reconectar ao servidor sem tirar você da call.');

  // Uma queda de internet não encerra a sessão local.
  if(!state.profileReady && $('#authError')){
    $('#authError').textContent='Conexão perdida. Tentando reconectar...';
  }

  if(state.joinedVoiceId) $('#voiceStatus').textContent='Reconectando servidor...';
});

socket.on('connect',()=>{
  state.lastOwnedServerSyncAt=0;
  window.AcordRuntime?.mark?.('socket-connect');
  setConnectionStatus(state.profileReady?'Conectado':'Validando…',state.profileReady?'online':'connecting');
  if(!state.profileReady) window.AcordRuntime?.setStatus?.('Conectado. Validando sua sessão…','ok');
  if(state.profileReady)setTimeout(syncCachedOutgoingDms,900);
  if(!state.joinedVoiceId)setCallReconnectState(false);

  if($('#authError') && !state.profileReady){
    $('#authError').textContent='';
    resetAuthSubmitButton();
  }

  if(state.authToken){
    socket.emit('auth-restore',{
      token:state.authToken,
      recovery:readLocalRecoverySnapshot()
    });
  }else{
    // O cookie HttpOnly é a sessão principal. O servidor responde
    // auth-success sem expor o token ao JavaScript.
    socket.emit('auth-cookie');
  }

  if(state.joinedVoiceId && state.profileReady){
    closePeers();

    if(state.privateCallId){
      // Aguarda o auth-restore identificar este novo socket no servidor.
      setTimeout(()=>{
        if(socket.connected && state.privateCallId && state.profileReady){
          clearPrivateJoinRetry();
          requestPrivateCallJoin(state.privateCallId);
        }
      },700);
    }else if(state.activeVoiceServerId&&state.activeVoiceChannelId){
      setTimeout(()=>{
        if(socket.connected && state.profileReady){
          socket.emit('join-voice',{
            serverId:state.activeVoiceServerId,
            channelId:state.activeVoiceChannelId,
            username:state.username
          });
        }
      },700);
    }
  }

  setTimeout(()=>{
    if(state.appInitialized&&state.profileReady){
      restoreCurrentView();

      if(
        state.currentView==='chat' &&
        state.serverId &&
        state.textChannelId
      ){
        requestTextJoin(state.serverId,state.textChannelId);
      }

      flushQueuedServerMessages();
    }
  },800);
});


// v6.4: all DOM listeners/modules registered successfully.
window.__ACORD_BOOT_READY=true;
window.AcordRuntime?.mark?.('bundle-ready');
if(!window.__ACORD_APP_READY){
  window.AcordRuntime?.setStatus?.(navigator.onLine?'Pronto para entrar.':'Sem conexão. O login ficará disponível quando a internet voltar.',navigator.onLine?'ok':'warn');
}
