
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

