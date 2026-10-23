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
$('#sharedControlBtn').addEventListener('click',()=>{
  const panel=$('#sharedControlPanel');
  if(panel?.classList.contains('hidden')) openSharedControlPanel();
  else closeSharedControlPanel();
});
$('#sharedControlCloseBtn').addEventListener('click',closeSharedControlPanel);
$('#sharedControlHostToggleBtn').addEventListener('click',()=>{
  const isHost=state.sharedControl.active && state.sharedControl.hostId===socket.id;
  setSharedControlHostEnabled(!isHost).catch(error=>{console.error(error);toast('Falha ao alterar o Controle compartilhado')});
});
$('#sharedControlStopAllBtn').addEventListener('click',()=>{
  if(!(state.sharedControl.active && state.sharedControl.hostId===socket.id)) return;
  const ids=new Set([...state.sharedControl.grantedIds,...state.sharedControl.requestedIds]);
  for(const peerId of ids) socket.emit('shared-control-revoke',{peerId});
  sharedControlBridge()?.releaseAll?.();
  toast('Todos os controles foram interrompidos');
});
$('#sharedControlRequestBtn').addEventListener('click',requestSharedControl);
$('#sharedControlTakeBtn').addEventListener('click',beginSharedControlCapture);
$('#sharedControlReleaseBtn').addEventListener('click',releaseMySharedControl);
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

$('#videoGrid').addEventListener('pointermove',event=>{
  const video=sharedControlEventVideo(event);
  if(!video) return;
  const point=normalizedSharedControlPointer(video,event.clientX,event.clientY);
  if(!point) return;
  event.preventDefault();
  queueSharedControlPointerMove({type:'pointer-move',x:point.x,y:point.y});
},{passive:false});

$('#videoGrid').addEventListener('pointerdown',event=>{
  const video=sharedControlEventVideo(event);
  if(!video) return;
  const point=normalizedSharedControlPointer(video,event.clientX,event.clientY);
  if(point) sendSharedControlInput({type:'pointer-move',x:point.x,y:point.y});
  event.preventDefault();
  event.stopPropagation();
  try{event.target?.setPointerCapture?.(event.pointerId)}catch{}
  sendSharedControlInput({type:'pointer-button',button:event.button,down:true});
},{passive:false});

$('#videoGrid').addEventListener('pointerup',event=>{
  const video=sharedControlEventVideo(event);
  if(!video) return;
  const point=normalizedSharedControlPointer(video,event.clientX,event.clientY);
  if(point) sendSharedControlInput({type:'pointer-move',x:point.x,y:point.y});
  event.preventDefault();
  event.stopPropagation();
  sendSharedControlInput({type:'pointer-button',button:event.button,down:false});
},{passive:false});

$('#videoGrid').addEventListener('wheel',event=>{
  const video=sharedControlEventVideo(event);
  if(!video) return;
  event.preventDefault();
  event.stopPropagation();
  sendSharedControlInput({type:'wheel',deltaY:event.deltaY});
},{passive:false});

$('#videoGrid').addEventListener('contextmenu',event=>{
  if(sharedControlEventVideo(event)) event.preventDefault();
});

$('#videoGrid').addEventListener('click',e=>{
  const card = e.target.closest('.videoCard');
  if(!card) return;
  if(state.sharedControl.controlling && card.classList.contains('sharedControlCapture')){
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const open = card.classList.contains('fakeFullscreen');
  setShareFullscreenState(open ? null : card);
});

document.addEventListener('keydown',event=>{
  if(!state.sharedControl.controlling) return;
  if(event.key==='Escape'){
    event.preventDefault();
    event.stopPropagation();
    clearSharedControlCapture({releaseRemote:true});
    toast('Controle local solto');
    return;
  }
  if(!sharedControlAllowedKey(event.code)) return;
  event.preventDefault();
  event.stopPropagation();
  sendSharedControlInput({type:'key',code:event.code,down:true});
},true);

document.addEventListener('keyup',event=>{
  if(!state.sharedControl.controlling) return;
  if(event.key==='Escape') return;
  if(!sharedControlAllowedKey(event.code)) return;
  event.preventDefault();
  event.stopPropagation();
  sendSharedControlInput({type:'key',code:event.code,down:false});
},true);

document.addEventListener('keydown',e=>{
  if(e.key==='Escape' && !state.sharedControl.controlling) setShareFullscreenState(null);
});


socket.on('shared-control-state',snapshot=>{
  applySharedControlSnapshot(snapshot||{});
});

socket.on('shared-control-requested',({peerId,username,permissions,expiresAt}={})=>{
  if(!(state.sharedControl.active && state.sharedControl.hostId===socket.id)) return;
  const safeId=String(peerId||'');
  toast((username||'Um participante')+' solicitou: '+sharedControlPermissionLabel(permissions||{}));
  state.sharedControl.requestedIds.add(safeId);
  state.sharedControl.requestPermissions.set(safeId,{...(permissions||{}),expiresAt:Number(expiresAt||0)});
  renderSharedControlPanel();
});

socket.on('shared-control-granted',({hostId,hostName,permissions,accessToken,expiresAt}={})=>{
  state.sharedControl.active=true;
  state.sharedControl.hostId=String(hostId||state.sharedControl.hostId||'');
  state.sharedControl.hostName=String(hostName||state.sharedControl.hostName||'');
  const selfId=String(socket.id||'');
  state.sharedControl.grantedIds.add(selfId);
  state.sharedControl.grantPermissions.set(selfId,{...(permissions||{}),expiresAt:Number(expiresAt||0)});
  state.sharedControl.requestedIds.delete(selfId);
  state.sharedControl.requestPermissions.delete(selfId);
  state.sharedControl.accessToken=String(accessToken||'');
  state.sharedControl.accessExpiresAt=Number(expiresAt||0);
  state.sharedControl.requestPending=false;
  clearSharedControlVisuals();
  renderSharedControlPanel();
  toast('Controle liberado por tempo limitado: '+sharedControlPermissionLabel(permissions||{}));
});

socket.on('shared-control-revoked',({reason}={})=>{
  clearSharedControlCapture({releaseRemote:true});
  const selfId=String(socket.id||'');
  state.sharedControl.grantedIds.delete(selfId);
  state.sharedControl.requestedIds.delete(selfId);
  state.sharedControl.grantPermissions.delete(selfId);
  state.sharedControl.requestPermissions.delete(selfId);
  state.sharedControl.accessToken='';
  state.sharedControl.accessExpiresAt=0;
  state.sharedControl.requestPending=false;
  renderSharedControlPanel();
  toast(reason==='expired'?'Sua autorização de Controle compartilhado expirou':'O host revogou seu Controle compartilhado');
});

socket.on('shared-control-peer-released',({peerId}={})=>{
  if(!(state.sharedControl.active && state.sharedControl.hostId===socket.id)) return;
  const safeId=String(peerId||'');
  state.sharedControl.grantedIds.delete(safeId);
  state.sharedControl.requestedIds.delete(safeId);
  state.sharedControl.grantPermissions.delete(safeId);
  state.sharedControl.requestPermissions.delete(safeId);
  sharedControlBridge()?.releaseAll?.();
  renderSharedControlPanel();
});

socket.on('shared-control-input',({event,permissions,expiresAt}={})=>{
  if(!(state.sharedControl.active && state.sharedControl.hostId===socket.id)) return;
  const bridge=sharedControlBridge();
  if(!bridge || !event || Number(expiresAt||0)<=Date.now()) return;
  bridge.injectInput({event,permissions:permissions||{}});
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
  socket.emit('shared-control-sync');
});

socket.on('voice-members',members=>{
  renderMembers(members);
  socket.emit('shared-control-sync');
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
  if(state.sharedControl?.active || state.sharedControl?.controlling){
    clearSharedControlCapture({releaseRemote:false});
    sharedControlBridge()?.releaseAll?.();
    sharedControlBridge()?.setHostEnabled?.(false).catch(()=>{});
    applySharedControlSnapshot({active:false,hostId:'',hostName:'',grantedIds:[],requestedIds:[]});
  }
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


// v6.6: all DOM listeners/modules registered successfully.
window.__ACORD_BOOT_READY=true;
window.AcordRuntime?.mark?.('bundle-ready');
if(!window.__ACORD_APP_READY){
  window.AcordRuntime?.setStatus?.(navigator.onLine?'Pronto para entrar.':'Sem conexão. O login ficará disponível quando a internet voltar.',navigator.onLine?'ok':'warn');
}
