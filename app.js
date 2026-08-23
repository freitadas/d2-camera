const socket = io();

const joinView = document.getElementById('joinView');
const callView = document.getElementById('callView');
const usernameInput = document.getElementById('usernameInput');
const roomInput = document.getElementById('roomInput');
const randomRoomBtn = document.getElementById('randomRoomBtn');
const createRoomBtn = document.getElementById('createRoomBtn');
const inviteHint = document.getElementById('inviteHint');
const joinBtn = document.getElementById('joinBtn');
const joinError = document.getElementById('joinError');
const roomLabel = document.getElementById('roomLabel');
const copyRoomBtn = document.getElementById('copyRoomBtn');
const videoGrid = document.getElementById('videoGrid');
const micBtn = document.getElementById('micBtn');
const cameraBtn = document.getElementById('cameraBtn');
const screenBtn = document.getElementById('screenBtn');
const leaveBtn = document.getElementById('leaveBtn');

let localStream = null;
let cameraTrack = null;
let screenStream = null;
let screenTrack = null;
let outgoingVideoTrack = null;
let currentRoom = '';
let currentUsername = '';
const peers = new Map();
const peerNames = new Map();
const pendingCandidates = new Map();

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function normalizeRoom(value) {
  return value.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
}

function addVideoCard(id, name, stream, muted = false) {
  removeVideoCard(id);

  const card = document.createElement('div');
  card.className = 'video-card';
  card.id = `card-${id}`;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = muted;
  video.srcObject = stream;

  const label = document.createElement('div');
  label.className = 'name';
  label.textContent = name;

  card.append(video, label);
  videoGrid.appendChild(card);
}

function removeVideoCard(id) {
  document.getElementById(`card-${id}`)?.remove();
}

async function getLocalMedia() {
  return navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: true
  });
}

function createPeer(peerId, username = 'Usuário') {
  if (peers.has(peerId)) return peers.get(peerId);

  peerNames.set(peerId, username);
  const pc = new RTCPeerConnection(rtcConfig);
  peers.set(peerId, pc);

  for (const track of localStream.getAudioTracks()) {
    pc.addTrack(track, localStream);
  }

  if (outgoingVideoTrack) {
    pc.addTrack(outgoingVideoTrack, new MediaStream([outgoingVideoTrack]));
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { target: peerId, candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0];
    if (stream) addVideoCard(peerId, peerNames.get(peerId) || 'Usuário', stream, false);
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      if (pc.connectionState === 'failed') pc.restartIce?.();
    }
  };

  return pc;
}

async function flushPendingCandidates(peerId) {
  const pc = peers.get(peerId);
  const list = pendingCandidates.get(peerId) || [];
  if (!pc?.remoteDescription) return;

  for (const candidate of list) {
    try { await pc.addIceCandidate(candidate); } catch (err) { console.warn(err); }
  }
  pendingCandidates.delete(peerId);
}

async function makeOffer(peerId, username) {
  const pc = createPeer(peerId, username);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('offer', { target: peerId, sdp: pc.localDescription });
}

async function joinRoom() {
  joinError.textContent = '';
  currentUsername = usernameInput.value.trim() || 'Usuário';
  currentRoom = normalizeRoom(roomInput.value.trim());

  if (!currentRoom) {
    joinError.textContent = 'Digite ou gere um código de sala.';
    return;
  }

  try {
    joinBtn.disabled = true;
    joinBtn.textContent = 'Abrindo câmera...';
    localStream = await getLocalMedia();
    cameraTrack = localStream.getVideoTracks()[0] || null;
    outgoingVideoTrack = cameraTrack;

    addVideoCard('local', `${currentUsername} (você)`, localStream, true);
    roomLabel.textContent = currentRoom;
    joinView.classList.add('hidden');
    callView.classList.remove('hidden');

    socket.emit('join-room', { roomId: currentRoom, username: currentUsername });
  } catch (error) {
    console.error(error);
    joinError.textContent = 'Não foi possível acessar câmera/microfone. Verifique a permissão do navegador.';
  } finally {
    joinBtn.disabled = false;
    joinBtn.textContent = 'Entrar na sala';
  }
}

function toggleTrack(kind, button, onText, offText) {
  if (!localStream) return;
  const tracks = kind === 'audio' ? localStream.getAudioTracks() : localStream.getVideoTracks();
  if (!tracks.length) return;

  const enabled = !tracks[0].enabled;
  tracks.forEach((track) => { track.enabled = enabled; });
  button.classList.toggle('off', !enabled);
  button.textContent = enabled ? onText : offText;
}

function updateLocalPreview(stream, label) {
  addVideoCard('local', label, stream, true);
  const localVideo = document.querySelector('#card-local video');
  if (localVideo) localVideo.style.objectFit = screenTrack ? 'contain' : 'cover';
}

async function replaceOutgoingVideoTrack(track) {
  outgoingVideoTrack = track;

  const replacements = [];
  for (const pc of peers.values()) {
    const sender = pc.getSenders().find((item) => item.track?.kind === 'video');
    if (sender) replacements.push(sender.replaceTrack(track));
  }
  await Promise.allSettled(replacements);
}

async function stopScreenShare() {
  if (!screenTrack && !screenStream) return;

  if (screenTrack) screenTrack.onended = null;
  screenStream?.getTracks().forEach((track) => track.stop());
  screenStream = null;
  screenTrack = null;

  await replaceOutgoingVideoTrack(cameraTrack);
  if (localStream) updateLocalPreview(localStream, `${currentUsername} (você)`);

  screenBtn.classList.remove('sharing');
  screenBtn.textContent = '🖥️ Compartilhar tela';
  cameraBtn.disabled = false;
}

async function toggleScreenShare() {
  if (screenTrack) {
    await stopScreenShare();
    return;
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    alert('Este navegador não oferece compartilhamento de tela. Use Chrome, Edge ou outro navegador compatível.');
    return;
  }

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: false
    });

    screenTrack = screenStream.getVideoTracks()[0] || null;
    if (!screenTrack) throw new Error('Nenhuma tela foi selecionada.');

    await replaceOutgoingVideoTrack(screenTrack);
    updateLocalPreview(new MediaStream([screenTrack]), `${currentUsername} — compartilhando tela`);

    screenBtn.classList.add('sharing');
    screenBtn.textContent = '⏹️ Parar tela';
    cameraBtn.disabled = true;

    screenTrack.onended = () => {
      stopScreenShare().catch(console.error);
    };
  } catch (error) {
    if (error?.name !== 'NotAllowedError') console.error(error);
    screenStream?.getTracks().forEach((track) => track.stop());
    screenStream = null;
    screenTrack = null;
  }
}

function leaveCall() {
  for (const pc of peers.values()) pc.close();
  peers.clear();
  peerNames.clear();
  pendingCandidates.clear();
  screenStream?.getTracks().forEach((track) => track.stop());
  screenStream = null;
  screenTrack = null;
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  cameraTrack = null;
  outgoingVideoTrack = null;
  socket.disconnect();
  window.location.reload();
}

randomRoomBtn.addEventListener('click', () => { roomInput.value = makeRoomCode(); });
createRoomBtn.addEventListener('click', () => { roomInput.value = makeRoomCode(); joinRoom(); });
joinBtn.addEventListener('click', joinRoom);
roomInput.addEventListener('input', () => { roomInput.value = normalizeRoom(roomInput.value); });
roomInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') joinRoom(); });
usernameInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') joinRoom(); });

copyRoomBtn.addEventListener('click', async () => {
  const inviteUrl = new URL(window.location.href);
  inviteUrl.search = '';
  inviteUrl.searchParams.set('room', currentRoom);
  await navigator.clipboard.writeText(inviteUrl.toString());
  const old = copyRoomBtn.textContent;
  copyRoomBtn.textContent = 'Link copiado';
  setTimeout(() => { copyRoomBtn.textContent = old; }, 1200);
});

micBtn.addEventListener('click', () => toggleTrack('audio', micBtn, '🎤 Microfone', '🔇 Microfone'));
cameraBtn.addEventListener('click', () => toggleTrack('video', cameraBtn, '📷 Câmera', '🚫 Câmera'));
screenBtn.addEventListener('click', toggleScreenShare);
leaveBtn.addEventListener('click', leaveCall);

const inviteRoom = normalizeRoom(new URLSearchParams(window.location.search).get('room') || '');
if (inviteRoom) {
  roomInput.value = inviteRoom;
  inviteHint.classList.remove('hidden');
}

socket.on('room-error', (message) => { joinError.textContent = message; });

socket.on('room-participants', async (participants) => {
  for (const participant of participants) {
    peerNames.set(participant.id, participant.username);
    await makeOffer(participant.id, participant.username);
  }
});

socket.on('user-joined', ({ id, username }) => {
  peerNames.set(id, username);
});

socket.on('offer', async ({ from, sdp, username }) => {
  const pc = createPeer(from, username);
  await pc.setRemoteDescription(sdp);
  await flushPendingCandidates(from);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { target: from, sdp: pc.localDescription });
});

socket.on('answer', async ({ from, sdp }) => {
  const pc = peers.get(from);
  if (!pc) return;
  await pc.setRemoteDescription(sdp);
  await flushPendingCandidates(from);
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  const pc = peers.get(from);
  if (pc?.remoteDescription) {
    try { await pc.addIceCandidate(candidate); } catch (err) { console.warn(err); }
  } else {
    const list = pendingCandidates.get(from) || [];
    list.push(candidate);
    pendingCandidates.set(from, list);
  }
});

socket.on('user-left', ({ id }) => {
  peers.get(id)?.close();
  peers.delete(id);
  peerNames.delete(id);
  pendingCandidates.delete(id);
  removeVideoCard(id);
});
