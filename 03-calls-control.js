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
  if(state.sharedControl?.active) clearSharedControlVisuals();
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
  shutdownSharedControlOnLeave();
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
  if(state.sharedControl?.active && state.sharedControl.hostId===socket.id){
    shutdownSharedControlOnLeave();
  }
  const oldTrack = state.screenTrack;
  state.screenTrack = null;
  state.sharedControl.autoStartedScreen=false;

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

async function applyScreenSenderQuality(track,quality,{interactive=false}={}){
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
      if(interactive) params.degradationPreference='maintain-framerate';
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

async function installScreenShareStream(stream,{interactive=false,autoStarted=false}={}){
  if(!stream) throw new Error('Fluxo de tela indisponível.');

  const nextTrack=stream.getVideoTracks()[0]||null;
  const nextAudio=stream.getAudioTracks()[0]||null;
  if(!nextTrack) throw new Error('Nenhuma faixa de tela foi selecionada.');

  const previousStream=state.screenStream;
  const previousTrack=state.screenTrack;

  state.screenStream=stream;
  state.screenTrack=nextTrack;
  state.screenAudioTrack=nextAudio;
  state.sharedControl.autoStartedScreen=!!autoStarted;

  try{
    nextTrack.contentHint=interactive?'motion':'detail';
  }catch{}

  await replaceVideoForAll(nextTrack);
  await applyScreenSenderQuality(nextTrack,state.screenShareQuality,{interactive});
  await startScreenAudioMix();

  const preview=new MediaStream([nextTrack]);
  ensureCard('local',state.username+' — compartilhando tela',preview,true);

  $('#screenBtn').textContent='⏹ Parar tela';
  $('#screenBtn').classList.add('sharing');
  $('#cameraBtn').disabled=true;
  const qualityLabel=
    state.screenShareQuality==='720p'
      ? '720p'
      : (state.screenShareQuality==='1080p60'?'1080p 60 FPS':'1080p');
  $('#voiceStatus').textContent=(interactive?'Controle compartilhado · ':'Compartilhando tela · ')+qualityLabel;

  nextTrack.onended=()=>{
    if(state.screenTrack===nextTrack){
      stopScreen().catch(console.error);
    }
  };

  if(previousTrack && previousTrack!==nextTrack){
    previousTrack.onended=null;
  }
  if(previousStream && previousStream!==stream){
    previousStream.getTracks().forEach(track=>{
      if(track!==nextTrack && track!==nextAudio && track.readyState!=='ended'){
        try{track.stop()}catch{}
      }
    });
  }
  return true;
}

async function startScreenShare(displaySurface){
  closeSharePicker();

  try{
    const preset=screenSharePreset(state.screenShareQuality);
    const videoOptions={
      width:preset.width,
      height:preset.height,
      frameRate:preset.frameRate
    };
    if(displaySurface) videoOptions.displaySurface=displaySurface;

    const stream=await navigator.mediaDevices.getDisplayMedia({
      video:videoOptions,
      audio:true,
      selfBrowserSurface:'exclude',
      surfaceSwitching:'include'
    });
    return await installScreenShareStream(stream,{interactive:false,autoStarted:false});
  }catch(error){
    if(error?.name!=='NotAllowedError'){
      console.error('Erro ao compartilhar tela:',error);
      toast(friendlyMediaError(error,'compartilhamento de tela'));
    }
    return false;
  }
}

function sharedControlWithTimeout(promise,ms,message){
  let timer=null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message||'Operação excedeu o tempo limite')),ms)})
  ]).finally(()=>{if(timer)clearTimeout(timer)});
}

async function startSharedControlDesktopCapture(){
  if(!sharedControlDesktopAvailable()) return false;
  if(!navigator.mediaDevices?.getDisplayMedia){
    toast('Captura de tela indisponível nesta instalação do Acord Desktop');
    return false;
  }

  const preset=screenSharePreset(state.screenShareQuality);
  const videoOptions={
    width:preset.width,
    height:preset.height,
    frameRate:preset.frameRate,
    displaySurface:'monitor'
  };

  let stream=null;
  try{
    // Electron Desktop: o processo principal seleciona automaticamente o monitor
    // primário por setDisplayMediaRequestHandler. Isso evita a rota legada
    // chromeMediaSourceId, que é mais frágil em versões novas do Chromium/Electron.
    stream=await sharedControlWithTimeout(
      navigator.mediaDevices.getDisplayMedia({
        video:videoOptions,
        audio:true,
        selfBrowserSurface:'exclude',
        surfaceSwitching:'exclude',
        systemAudio:'include'
      }),
      12000,
      'A captura automática do monitor não respondeu'
    );
  }catch(audioError){
    console.warn('Captura com áudio do sistema indisponível; tentando somente vídeo.',audioError);
    try{
      stream=await sharedControlWithTimeout(
        navigator.mediaDevices.getDisplayMedia({
          video:videoOptions,
          audio:false,
          selfBrowserSurface:'exclude',
          surfaceSwitching:'exclude'
        }),
        12000,
        'A captura automática do monitor não respondeu'
      );
    }catch(error){
      console.error('Falha na captura automática do monitor:',error);
      toast(friendlyMediaError(error,'Controle compartilhado'));
      return false;
    }
  }

  return installScreenShareStream(stream,{interactive:true,autoStarted:true});
}

async function toggleScreen(){
  openSharePicker();
}

const __acordDesktopBridgeState={
  ready:false,
  platform:'',
  version:'',
  seq:0,
  pending:new Map()
};

window.addEventListener('message',event=>{
  if(event.source!==window || !event.data || typeof event.data!=='object') return;
  const data=event.data;
  if(data.__acordDesktopBridgeReady===true){
    __acordDesktopBridgeState.ready=true;
    __acordDesktopBridgeState.platform=String(data.platform||'');
    __acordDesktopBridgeState.version=String(data.version||'');
    return;
  }
  if(data.__acordDesktopBridgeReply!==true || !data.id) return;
  const pending=__acordDesktopBridgeState.pending.get(String(data.id));
  if(!pending) return;
  __acordDesktopBridgeState.pending.delete(String(data.id));
  clearTimeout(pending.timer);
  if(data.error) pending.reject(new Error(String(data.error)));
  else pending.resolve(data.result);
});

function sharedControlDesktopHint(){
  return __acordDesktopBridgeState.ready ||
    window.__ACORD_DESKTOP_SHELL__===true ||
    window.__ACORD_DESKTOP_SHELL__?.available===true ||
    new URLSearchParams(location.search).get('desktop')==='1' ||
    /AcordDesktop\//i.test(navigator.userAgent);
}

function sharedControlBridgeRequest(action,payload={},timeout=4500){
  return new Promise((resolve,reject)=>{
    const id='acd-'+Date.now().toString(36)+'-'+(++__acordDesktopBridgeState.seq).toString(36);
    const timer=setTimeout(()=>{
      __acordDesktopBridgeState.pending.delete(id);
      reject(new Error('A ponte nativa do Acord Desktop não respondeu'));
    },timeout);
    __acordDesktopBridgeState.pending.set(id,{resolve,reject,timer});
    window.postMessage({__acordDesktopBridgeRequest:true,id,action,payload},'*');
  });
}

function sharedControlBridge(){
  const direct=window.AcordDesktopControl;
  if(direct && direct.available===true) return direct;
  if(!sharedControlDesktopHint()) return null;
  return {
    available:true,
    platform:__acordDesktopBridgeState.platform||'win32',
    setHostEnabled:enabled=>sharedControlBridgeRequest('setHostEnabled',{enabled:!!enabled}),
    getPrimaryDisplaySource:()=>sharedControlBridgeRequest('getPrimaryDisplaySource',{},5000),
    injectInput:event=>window.postMessage({__acordDesktopBridgeRequest:true,action:'injectInput',payload:{event}},'*'),
    releaseAll:()=>window.postMessage({__acordDesktopBridgeRequest:true,action:'releaseAll',payload:{}},'*')
  };
}

function sharedControlDesktopAvailable(){
  const bridge=sharedControlBridge();
  return !!bridge && bridge.platform==='win32';
}

function sharedControlParticipants(){
  const map=new Map();
  if(socket.id) map.set(String(socket.id),{id:String(socket.id),username:state.username||'Você'});
  for(const member of (state.lastVoiceMembers||[])){
    if(!member?.id) continue;
    map.set(String(member.id),{id:String(member.id),username:String(member.username||'Usuário')});
  }
  return [...map.values()];
}

function isSharedControlGrantedToMe(){
  const selfId=String(socket.id||'');
  return state.sharedControl.grantedIds.has(selfId) && !!state.sharedControl.accessToken && Number(state.sharedControl.accessExpiresAt||0)>Date.now();
}

function sharedControlPermissionLabel(permissions={}){
  const parts=[];
  if(permissions.mouse) parts.push('mouse');
  if(permissions.keyboard) parts.push('teclado');
  if(permissions.gamepad) parts.push('gamepad');
  return parts.length?parts.join(' + '):'nenhuma permissão';
}

function selectedSharedControlPermissions(){
  return {
    mouse:!!$('#sharedControlMousePerm')?.checked,
    keyboard:!!$('#sharedControlKeyboardPerm')?.checked,
    gamepad:!!$('#sharedControlGamepadPerm')?.checked
  };
}

function sharedControlTargetCard(){
  const hostId=String(state.sharedControl.hostId||'');
  if(!hostId) return null;
  return document.getElementById('v-'+hostId);
}

function clearSharedControlCapture({releaseRemote=false}={}){
  state.sharedControl.controlling=false;
  state.sharedControl.pendingPointerMove=null;
  if(state.sharedControl.pointerMoveTimer){
    clearTimeout(state.sharedControl.pointerMoveTimer);
    state.sharedControl.pointerMoveTimer=null;
  }
  document.querySelectorAll('.videoCard.sharedControlCapture').forEach(card=>{
    card.classList.remove('sharedControlCapture');
    card.querySelector('.sharedControlHint')?.remove();
  });
  if(releaseRemote && state.sharedControl.active && state.sharedControl.hostId && state.sharedControl.accessToken){
    socket.emit('shared-control-input',{
      hostId:state.sharedControl.hostId,
      accessToken:state.sharedControl.accessToken,
      event:{type:'release-all'}
    });
  }
  renderSharedControlPanel();
}

function clearSharedControlVisuals(){
  document.querySelectorAll('.videoCard.sharedControlTarget').forEach(card=>card.classList.remove('sharedControlTarget'));
  if(state.sharedControl.active && state.sharedControl.hostId && state.sharedControl.hostId!==socket.id){
    sharedControlTargetCard()?.classList.add('sharedControlTarget');
  }
}

function applySharedControlSnapshot(snapshot={}){
  const nextActive=!!snapshot.active;
  const nextHostId=String(snapshot.hostId||'');
  const wasControlling=state.sharedControl.controlling;
  const nextGranted=new Set((snapshot.grantedIds||[]).map(String));
  const selfId=String(socket.id||'');
  const stillGranted=nextGranted.has(selfId);

  state.sharedControl.active=nextActive;
  state.sharedControl.hostId=nextHostId;
  state.sharedControl.hostName=String(snapshot.hostName||'');
  state.sharedControl.grantedIds=nextGranted;
  state.sharedControl.requestedIds=new Set((snapshot.requestedIds||[]).map(String));
  state.sharedControl.grantPermissions=new Map((snapshot.grantDetails||[]).map(item=>[String(item.peerId||''),{
    mouse:!!item?.permissions?.mouse,
    keyboard:!!item?.permissions?.keyboard,
    gamepad:!!item?.permissions?.gamepad,
    expiresAt:Number(item?.expiresAt||0)
  }]));
  state.sharedControl.requestPermissions=new Map((snapshot.requestDetails||[]).map(item=>[String(item.peerId||''),{
    mouse:!!item?.permissions?.mouse,
    keyboard:!!item?.permissions?.keyboard,
    gamepad:!!item?.permissions?.gamepad,
    expiresAt:Number(item?.expiresAt||0)
  }]));
  state.sharedControl.requestPending=state.sharedControl.requestedIds.has(selfId);

  if(!nextActive || !stillGranted || nextHostId===selfId){
    if(wasControlling) clearSharedControlCapture({releaseRemote:true});
    if(!stillGranted){
      state.sharedControl.accessToken='';
      state.sharedControl.accessExpiresAt=0;
    }
  }

  clearSharedControlVisuals();
  renderSharedControlPanel();
}

function renderSharedControlPanel(){
  const sc=state.sharedControl;
  const panel=$('#sharedControlPanel');
  if(!panel) return;

  const status=$('#sharedControlStatus');
  const hostBox=$('#sharedControlHostBox');
  const guestBox=$('#sharedControlGuestBox');
  const hostToggle=$('#sharedControlHostToggleBtn');
  const stopAll=$('#sharedControlStopAllBtn');
  const requestBtn=$('#sharedControlRequestBtn');
  const takeBtn=$('#sharedControlTakeBtn');
  const releaseBtn=$('#sharedControlReleaseBtn');
  const hint=$('#sharedControlDesktopHint');
  const participantsBox=$('#sharedControlParticipants');
  const isHost=sc.active && sc.hostId===socket.id;
  const granted=isSharedControlGrantedToMe();
  const requested=sc.requestedIds.has(String(socket.id||''));
  const selfGrant=sc.grantPermissions.get(String(socket.id||''));

  $('#sharedControlBtn')?.classList.toggle('active',sc.active||sc.controlling);

  if(!sc.active){
    if(status) status.textContent=sc.activating?'Ativando…':'Inativo';
    hostBox?.classList.remove('hidden');
    guestBox?.classList.add('hidden');
    if(hostToggle){
      hostToggle.textContent=sc.activating?'Ativando…':'Ativar neste PC';
      hostToggle.classList.remove('danger');
      hostToggle.classList.add('primary');
      hostToggle.disabled=!!sc.activating || !state.joinedVoiceId;
    }
    stopAll?.classList.add('hidden');
    if(hint){
      hint.textContent=sc.activating
        ? 'Preparando o Controle compartilhado e capturando o monitor principal automaticamente…'
        : (sharedControlDesktopAvailable()
          ? 'Clique em Ativar neste PC. O Acord Desktop captura o monitor principal automaticamente.'
          : 'Para hospedar, use o Acord Desktop no Windows. No navegador você pode solicitar controle.');
    }
  }else if(isHost){
    if(status) status.textContent='Ativo neste PC · autorizações expiram em 10 minutos';
    hostBox?.classList.remove('hidden');
    guestBox?.classList.add('hidden');
    if(hostToggle){
      hostToggle.textContent='Desativar neste PC';
      hostToggle.classList.remove('primary');
      hostToggle.classList.add('danger');
      hostToggle.disabled=false;
    }
    stopAll?.classList.toggle('hidden',sc.grantedIds.size===0 && sc.requestedIds.size===0);
    if(hint) hint.textContent='Cada autorização é temporária, vinculada a esta conexão e revogada ao sair ou reconectar.';
  }else{
    if(status){
      const suffix=granted&&selfGrant?' · '+sharedControlPermissionLabel(selfGrant):'';
      status.textContent='Host: '+(sc.hostName||'Participante')+suffix;
    }
    hostBox?.classList.add('hidden');
    guestBox?.classList.remove('hidden');
    requestBtn?.classList.toggle('hidden',granted||requested);
    takeBtn?.classList.toggle('hidden',!granted||sc.controlling);
    releaseBtn?.classList.toggle('hidden',!granted&&!requested);
    if(requestBtn) requestBtn.disabled=!state.joinedVoiceId;
    if(takeBtn) takeBtn.textContent=sc.controlling?'Controlando':'Controlar agora';
  }

  if(!participantsBox) return;
  participantsBox.innerHTML='';
  const participants=sharedControlParticipants().filter(person=>person.id!==socket.id);
  if(!participants.length){
    const empty=document.createElement('div');
    empty.className='sharedControlPerson';
    const info=document.createElement('div');
    info.className='sharedControlPersonInfo';
    const strong=document.createElement('strong');strong.textContent='Nenhum outro participante';
    const small=document.createElement('small');small.textContent='Quando alguém entrar na call, aparecerá aqui.';
    info.append(strong,small);empty.appendChild(info);participantsBox.appendChild(empty);
    return;
  }

  for(const person of participants){
    const row=document.createElement('div');row.className='sharedControlPerson';
    const info=document.createElement('div');info.className='sharedControlPersonInfo';
    const strong=document.createElement('strong');strong.textContent=person.username;
    const small=document.createElement('small');
    const personGranted=sc.grantedIds.has(person.id);
    const personRequested=sc.requestedIds.has(person.id);
    const requestedPerms=sc.requestPermissions.get(person.id)||{};
    const grantedPerms=sc.grantPermissions.get(person.id)||{};
    small.textContent=personGranted
      ? 'Permitido: '+sharedControlPermissionLabel(grantedPerms)
      :(personRequested?'Solicitou: '+sharedControlPermissionLabel(requestedPerms):'Na call');
    info.append(strong,small);row.appendChild(info);

    if(isHost){
      const actions=document.createElement('div');
      actions.className='sharedControlActions';
      if(personGranted){
        const revoke=document.createElement('button');
        revoke.type='button';revoke.className='btn small danger';revoke.textContent='Revogar';
        revoke.addEventListener('click',()=>revokeSharedControl(person.id));
        actions.appendChild(revoke);
      }else if(personRequested){
        for(const [key,label] of [['mouse','Mouse'],['keyboard','Teclado'],['gamepad','Gamepad']]){
          if(!requestedPerms[key]) continue;
          const action=document.createElement('button');
          action.type='button';action.className='btn small primary';action.textContent=label;
          if(key==='gamepad'){
            action.disabled=true;
            action.title='Permissão separada preparada; injeção nativa de gamepad exige componente adicional no Windows.';
          }else{
            action.addEventListener('click',()=>grantSharedControl(person.id,{mouse:key==='mouse',keyboard:key==='keyboard',gamepad:false}));
          }
          actions.appendChild(action);
        }
        if(requestedPerms.mouse&&requestedPerms.keyboard){
          const both=document.createElement('button');
          both.type='button';both.className='btn small primary';both.textContent='Mouse + teclado';
          both.addEventListener('click',()=>grantSharedControl(person.id,{mouse:true,keyboard:true,gamepad:false}));
          actions.appendChild(both);
        }
      }
      row.appendChild(actions);
    }
    participantsBox.appendChild(row);
  }
}

function openSharedControlPanel(){
  if(!state.joinedVoiceId){toast('Entre em uma call primeiro');return}
  $('#sharedControlPanel')?.classList.remove('hidden');
  socket.emit('shared-control-sync');
  renderSharedControlPanel();
}

function closeSharedControlPanel(){
  $('#sharedControlPanel')?.classList.add('hidden');
}

async function setSharedControlHostEnabled(enabled){
  if(!state.joinedVoiceId){toast('Entre em uma call primeiro');return}
  if(state.sharedControl.activating) return;
  const bridge=sharedControlBridge();

  if(enabled){
    if(!sharedControlDesktopAvailable()){
      toast(sharedControlDesktopHint()?'A ponte nativa do Acord Desktop não carregou. Feche e abra o Acord novamente.':'Para hospedar o Controle compartilhado, abra o Acord Desktop no Windows');
      return;
    }

    state.sharedControl.activating=true;
    renderSharedControlPanel();
    let nativeStarted=false;
    let autoCaptureStarted=false;
    try{
      const nativeResult=await sharedControlWithTimeout(
        bridge.setHostEnabled(true),
        6000,
        'O módulo de controle do Windows não respondeu'
      ).catch(error=>({ok:false,error:error?.message||'Falha ao ativar o controle do Windows'}));
      if(!nativeResult?.ok) throw new Error(nativeResult?.error||'Não foi possível ativar o controle do Windows');
      nativeStarted=true;

      const live=!!state.screenTrack && state.screenTrack.readyState==='live';
      const surface=live?String(state.screenTrack.getSettings?.().displaySurface||''):'';
      const alreadyWholeMonitor=live && (!surface || surface==='monitor');

      if(!alreadyWholeMonitor){
        const captured=await startSharedControlDesktopCapture();
        if(!captured) throw new Error('Não foi possível iniciar a transmissão automática do monitor');
        autoCaptureStarted=true;
      }else{
        state.sharedControl.autoStartedScreen=false;
        try{state.screenTrack.contentHint='motion'}catch{}
        await applyScreenSenderQuality(state.screenTrack,state.screenShareQuality,{interactive:true});
      }

      const publishResult=await new Promise(resolve=>{
        socket.timeout(6000).emit('shared-control-host-set',{enabled:true},(error,result)=>{
          resolve(error?{ok:false,error:'O servidor não respondeu à ativação'}:(result||{ok:false,error:'Resposta inválida do servidor'}));
        });
      });
      if(!publishResult?.ok) throw new Error(publishResult?.error||'Não foi possível publicar o Controle compartilhado');

      toast('Controle compartilhado ativo · monitor principal transmitido automaticamente');
      socket.emit('shared-control-sync');
    }catch(error){
      console.error('Falha ao ativar Controle compartilhado:',error);
      if(nativeStarted){
        await bridge.setHostEnabled(false).catch(()=>{});
        bridge.releaseAll?.();
      }
      if((autoCaptureStarted||state.sharedControl.autoStartedScreen) && state.screenTrack){
        state.sharedControl.autoStartedScreen=false;
        await stopScreen().catch(()=>{});
      }
      toast(error?.message||'Não foi possível ativar o Controle compartilhado');
    }finally{
      state.sharedControl.activating=false;
      renderSharedControlPanel();
    }
    return;
  }

  state.sharedControl.activating=false;
  const stopAutoScreen=!!state.sharedControl.autoStartedScreen;
  state.sharedControl.autoStartedScreen=false;
  socket.timeout(4000).emit('shared-control-host-set',{enabled:false},()=>{});
  await bridge?.setHostEnabled(false).catch(()=>{});
  bridge?.releaseAll?.();
  state.sharedControl.accessToken='';
  state.sharedControl.accessExpiresAt=0;
  applySharedControlSnapshot({active:false,hostId:'',hostName:'',grantedIds:[],requestedIds:[],grantDetails:[],requestDetails:[]});
  if(stopAutoScreen && state.screenTrack){
    await stopScreen().catch(()=>{});
  }
  toast('Controle compartilhado desativado');
}

function requestSharedControl(){
  if(!state.sharedControl.active || state.sharedControl.hostId===socket.id) return;
  const permissions=selectedSharedControlPermissions();
  if(!permissions.mouse&&!permissions.keyboard&&!permissions.gamepad){toast('Selecione ao menos uma permissão');return}
  socket.timeout(5000).emit('shared-control-request',{permissions},(error,result)=>{
    if(error || !result?.ok){toast(result?.error||'Não foi possível solicitar o controle');return}
    state.sharedControl.requestPending=true;
    toast('Solicitação enviada: '+sharedControlPermissionLabel(permissions));
    renderSharedControlPanel();
  });
}

function grantSharedControl(peerId,permissions){
  socket.timeout(5000).emit('shared-control-grant',{peerId,permissions},(error,result)=>{
    if(error || !result?.ok){toast(result?.error||'Não foi possível liberar o controle');return}
    toast('Controle liberado por 10 minutos: '+sharedControlPermissionLabel(result.permissions||permissions||{}));
  });
}

function revokeSharedControl(peerId){
  socket.timeout(5000).emit('shared-control-revoke',{peerId},(error,result)=>{
    if(error || !result?.ok){toast(result?.error||'Não foi possível revogar o controle');return}
    toast('Controle revogado');
    sharedControlBridge()?.releaseAll?.();
  });
}

function releaseMySharedControl(){
  clearSharedControlCapture({releaseRemote:true});
  socket.emit('shared-control-cancel');
  state.sharedControl.requestPending=false;
  state.sharedControl.accessToken='';
  state.sharedControl.accessExpiresAt=0;
  toast('Seu acesso ao Controle compartilhado foi liberado');
}

function beginSharedControlCapture(){
  if(!state.sharedControl.active || state.sharedControl.hostId===socket.id || !isSharedControlGrantedToMe()){
    toast('O host ainda não liberou seu controle ou a autorização expirou');
    return;
  }
  const card=sharedControlTargetCard();
  const video=card?.querySelector('video');
  if(!card || !video || !card.classList.contains('hasVideo')){
    toast('A tela do host ainda não está disponível');
    return;
  }
  clearSharedControlCapture();
  state.sharedControl.controlling=true;
  card.classList.add('sharedControlCapture');
  let hint=card.querySelector('.sharedControlHint');
  if(!hint){
    hint=document.createElement('div');
    hint.className='sharedControlHint';
    hint.textContent='Controle compartilhado ativo · Esc para soltar';
    card.appendChild(hint);
  }
  try{card.scrollIntoView({block:'center',inline:'center',behavior:'smooth'})}catch{}
  toast('Você está controlando: '+sharedControlPermissionLabel(state.sharedControl.grantPermissions.get(String(socket.id||''))||{}));
  renderSharedControlPanel();
}

function sharedControlAllowedKey(code){
  return /^(Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|Space|Enter|Escape|Backspace|Tab|Arrow(?:Left|Up|Right|Down)|Home|End|PageUp|PageDown|Insert|Delete|Shift(?:Left|Right)|Control(?:Left|Right)|Alt(?:Left|Right)|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote)$/.test(String(code||''));
}

function sendSharedControlInput(event){
  if(!state.sharedControl.controlling || !isSharedControlGrantedToMe() || !state.sharedControl.hostId || !state.sharedControl.accessToken) return;
  const permissions=state.sharedControl.grantPermissions.get(String(socket.id||''))||{};
  if((event?.type==='pointer-move'||event?.type==='pointer-button'||event?.type==='wheel')&&!permissions.mouse) return;
  if(event?.type==='key'&&!permissions.keyboard) return;
  if(event?.type==='gamepad'&&!permissions.gamepad) return;
  socket.emit('shared-control-input',{hostId:state.sharedControl.hostId,accessToken:state.sharedControl.accessToken,event});
}

function queueSharedControlPointerMove(value){
  state.sharedControl.pendingPointerMove=value;
  if(state.sharedControl.pointerMoveTimer) return;
  const wait=Math.max(0,16-(Date.now()-state.sharedControl.lastPointerSentAt));
  state.sharedControl.pointerMoveTimer=setTimeout(()=>{
    state.sharedControl.pointerMoveTimer=null;
    const next=state.sharedControl.pendingPointerMove;
    state.sharedControl.pendingPointerMove=null;
    if(!next || !state.sharedControl.controlling) return;
    state.sharedControl.lastPointerSentAt=Date.now();
    sendSharedControlInput(next);
  },wait);
}

function normalizedSharedControlPointer(video,clientX,clientY){
  const rect=video?.getBoundingClientRect?.();
  if(!rect || rect.width<=0 || rect.height<=0) return null;
  const vw=Number(video.videoWidth)||16;
  const vh=Number(video.videoHeight)||9;
  const ratio=vw/vh;
  const boxRatio=rect.width/rect.height;
  let left=rect.left,top=rect.top,width=rect.width,height=rect.height;
  if(boxRatio>ratio){width=rect.height*ratio;left=rect.left+(rect.width-width)/2}
  else{height=rect.width/ratio;top=rect.top+(rect.height-height)/2}
  const x=(clientX-left)/width,y=(clientY-top)/height;
  if(x<0||x>1||y<0||y>1) return null;
  return {x:Math.max(0,Math.min(1,x)),y:Math.max(0,Math.min(1,y))};
}

function sharedControlEventVideo(event){
  if(!state.sharedControl.controlling) return null;
  const card=event.target?.closest?.('.videoCard.sharedControlCapture');
  if(!card || card.id!=='v-'+state.sharedControl.hostId) return null;
  return card.querySelector('video');
}

function shutdownSharedControlOnLeave(){
  clearSharedControlCapture({releaseRemote:true});
  if(state.sharedControl.active && state.sharedControl.hostId===socket.id){
    socket.emit('shared-control-host-set',{enabled:false});
    sharedControlBridge()?.releaseAll?.();
    sharedControlBridge()?.setHostEnabled?.(false).catch(()=>{});
  }else if(state.sharedControl.active){
    socket.emit('shared-control-cancel');
  }
  state.sharedControl.accessToken='';
  state.sharedControl.accessExpiresAt=0;
  applySharedControlSnapshot({active:false,hostId:'',hostName:'',grantedIds:[],requestedIds:[],grantDetails:[],requestDetails:[]});
  closeSharedControlPanel();
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
    renderSharedControlPanel();
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
  renderSharedControlPanel();
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

