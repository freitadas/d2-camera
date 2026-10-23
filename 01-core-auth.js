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

window.__ACORD_BUILD='6.8.3';
document.documentElement.dataset.acordBuild='6.8.3';

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
  rtcTurnConfigured:false,
  sharedControl:{
    active:false,
    hostId:'',
    hostName:'',
    grantedIds:new Set(),
    requestedIds:new Set(),
    grantPermissions:new Map(),
    requestPermissions:new Map(),
    accessToken:'',
    accessExpiresAt:0,
    requestPending:false,
    controlling:false,
    autoStartedScreen:false,
    activating:false,
    lastPointerSentAt:0,
    pointerMoveTimer:null,
    pendingPointerMove:null
  }
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
    'Acord v6.8.3',
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
