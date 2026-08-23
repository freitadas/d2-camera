const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

function broadcastOnlineUsers() {
  const users = [...io.sockets.sockets.values()]
    .filter(s => s.data.username)
    .map(s => ({ id: s.id, username: s.data.username }));
  io.emit('online-users', users);
}

const id = () => crypto.randomBytes(5).toString('hex');

const servers = new Map();

function makeServer(name = 'e-cord') {
  const serverId = id();
  const textGeneral = { id: id(), name: 'geral' };
  const voiceGeneral = { id: id(), name: 'Geral' };

  const data = {
    id: serverId,
    name: String(name).trim().slice(0, 30) || 'Servidor',
    textChannels: [textGeneral],
    voiceChannels: [voiceGeneral],
    messages: new Map([[textGeneral.id, []]])
  };

  servers.set(serverId, data);
  return data;
}

const defaultServer = makeServer('e-cord');

function publicServers() {
  return [...servers.values()].map(s => ({
    id: s.id,
    name: s.name,
    textChannels: s.textChannels,
    voiceChannels: s.voiceChannels
  }));
}

function cleanName(value, fallback = 'Usuário') {
  return String(value || fallback).trim().slice(0, 30) || fallback;
}

function cleanChannel(value, fallback = 'novo-canal') {
  return String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9áàâãéèêíïóôõöúçñ_-]/gi, '')
    .slice(0, 28) || fallback;
}

const APP_HTML = String.raw`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#08120f">
<title>e-cord</title>
<style>
:root{
  --bg0:#07110e;--bg1:#0d1b17;--bg2:#12241e;--bg3:#183128;--bg4:#204337;
  --line:#24473b;--text:#eff8f3;--muted:#a8beb4;--low:#6f8e81;
  --coral:#ff6b4a;--coral2:#ff8062;--mint:#41d99a;--mintbg:#153d2c;--danger:#df4c4c;
  font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}
*{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%;background:var(--bg0);color:var(--text)}
body{overflow:hidden}
button,input{font:inherit}
button{cursor:pointer}
.hidden{display:none!important}
.app{display:grid;grid-template-columns:72px 250px minmax(0,1fr) 240px;height:100vh}
.rail{background:var(--bg0);border-right:1px solid var(--line);padding:14px 0;display:flex;flex-direction:column;align-items:center;gap:10px;overflow-y:auto}
.serverIcon,.addServer{width:46px;height:46px;border:0;border-radius:16px;display:grid;place-items:center;font-weight:900;flex:0 0 auto;transition:.15s}
.serverIcon{background:var(--bg2);color:var(--muted);position:relative}
.serverIcon:hover,.serverIcon.active{background:var(--coral);color:#281009;border-radius:13px}
.serverIcon.active:before{content:"";position:absolute;left:-14px;width:4px;height:24px;background:var(--text);border-radius:0 4px 4px 0}
.addServer{background:var(--bg2);color:var(--mint);font-size:24px}
.addServer:hover{background:var(--mint);color:#082116}
.railSep{width:30px;height:1px;background:var(--line);flex:0 0 auto}

.sidebar{background:var(--bg1);border-right:1px solid var(--line);display:flex;flex-direction:column;min-width:0}
.sideHead{height:54px;padding:0 15px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:8px}
.brand{display:flex;align-items:center;gap:9px;font-weight:900;min-width:0}
.brandDot{width:9px;height:9px;border-radius:50%;background:var(--mint);box-shadow:0 0 0 4px rgba(65,217,154,.12)}
.serverTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.inviteBtn{border:1px solid var(--line);background:var(--bg2);color:var(--muted);border-radius:8px;padding:6px 8px;font-size:12px}
.sideScroll{padding:10px;overflow-y:auto;flex:1}
.navBtn{width:100%;border:0;background:transparent;color:var(--muted);border-radius:10px;padding:10px;text-align:left;font-weight:700;margin-bottom:2px}
.navBtn:hover,.navBtn.active{background:var(--bg3);color:var(--text)}
.groupHead{display:flex;align-items:center;justify-content:space-between;margin:18px 8px 6px;color:var(--low);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.07em}
.addChannel{border:0;background:transparent;color:var(--low);font-size:20px;padding:0 4px}
.addChannel:hover{color:var(--mint)}
.channelBtn{width:100%;border:0;background:transparent;color:var(--muted);padding:8px 10px;border-radius:9px;text-align:left;display:flex;align-items:center;gap:8px;margin:1px 0}
.channelBtn:hover,.channelBtn.active{background:var(--bg2);color:var(--text)}
.channelBtn.voice.active{background:var(--mintbg);color:var(--mint)}
.userbar{border-top:1px solid var(--line);background:#0a1613;padding:10px 12px;display:flex;align-items:center;gap:9px}
.avatar{width:34px;height:34px;border-radius:11px;background:var(--coral);color:#281009;display:grid;place-items:center;font-weight:900}
.userMeta{min-width:0}.userMeta strong,.userMeta span{display:block}.userMeta strong{font-size:13px;overflow:hidden;text-overflow:ellipsis}.userMeta span{font-size:11px;color:var(--mint)}

.main{min-width:0;display:flex;flex-direction:column;background:radial-gradient(circle at 20% 15%,rgba(65,217,154,.06),transparent 30%),radial-gradient(circle at 82% 75%,rgba(255,107,74,.07),transparent 35%),var(--bg0)}
.topbar{height:54px;border-bottom:1px solid var(--line);padding:0 18px;display:flex;align-items:center;justify-content:space-between;gap:12px;background:rgba(7,17,14,.93)}
.topLeft{display:flex;align-items:center;gap:9px;min-width:0}.topTitle{font-weight:900;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.topSub{font-size:12px;color:var(--muted)}
.content{flex:1;min-height:0;position:relative}
.view{height:100%;min-height:0}

.home{display:flex;align-items:center;justify-content:center;padding:24px}
.homeCard{width:min(620px,100%);background:rgba(13,27,23,.96);border:1px solid var(--line);border-radius:22px;padding:32px;box-shadow:0 22px 70px rgba(0,0,0,.25)}
.homeMark{width:62px;height:62px;border-radius:20px;background:var(--coral);color:#281009;display:grid;place-items:center;font-size:25px;font-weight:900}
.homeCard h1{margin:20px 0 8px;font-size:30px;letter-spacing:-.035em}.homeCard p{color:var(--muted);line-height:1.55}
.quick{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}

.btn{border:0;border-radius:10px;padding:11px 14px;font-weight:800}
.btn.primary{background:var(--coral);color:#281009}.btn.primary:hover{background:var(--coral2)}
.btn.secondary{background:var(--bg3);border:1px solid var(--line);color:var(--text)}.btn.secondary:hover{background:var(--bg4)}
.btn.danger{background:var(--danger);color:white}
.btn.small{padding:8px 10px;font-size:12px}

.chatView{display:grid;grid-template-rows:auto 1fr auto}
.chatHead{padding:14px 18px;border-bottom:1px solid var(--line);font-weight:900}
.chatHead span{color:var(--low);font-size:12px;font-weight:600;margin-left:8px}
.messages{overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:11px}
.message{max-width:min(72%,720px);padding:10px 12px;border-radius:14px;background:var(--bg2);border:1px solid var(--line);align-self:flex-start}
.message.mine{align-self:flex-end;background:#4b261d;border-color:rgba(255,107,74,.3)}
.message strong{display:block;color:var(--mint);font-size:12px;margin-bottom:4px}.message.mine strong{color:#ffb29f}
.message span{display:block;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.45}
.compose{display:grid;grid-template-columns:1fr auto;gap:8px;padding:12px 14px;border-top:1px solid var(--line);background:var(--bg1)}
input{width:100%;border:1px solid var(--line);background:var(--bg2);color:var(--text);border-radius:10px;padding:12px;outline:none}
input:focus{border-color:var(--coral);box-shadow:0 0 0 3px rgba(255,107,74,.08)}

.voiceView{display:grid;grid-template-rows:auto 1fr auto}
.voiceHead{padding:12px 14px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:10px}
.voiceInfo strong{color:var(--mint)}.voiceInfo span{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.videoGrid{overflow:auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;padding:14px;align-content:center}
.videoCard{position:relative;overflow:hidden;aspect-ratio:16/10;min-height:220px;border-radius:14px;background:var(--bg1);border:1px solid var(--line)}
.videoCard video{width:100%;height:100%;object-fit:cover;background:#050807;display:block}
.placeholder{position:absolute;inset:0;display:grid;place-items:center;background:radial-gradient(circle at 50% 30%,rgba(65,217,154,.09),transparent 35%),var(--bg1)}
.placeholder .bigAvatar{width:82px;height:82px;border-radius:28px;background:var(--coral);color:#281009;display:grid;place-items:center;font-size:30px;font-weight:900}
.videoCard.hasVideo .placeholder{display:none}
.videoName{position:absolute;left:10px;bottom:10px;background:rgba(5,8,7,.76);padding:6px 9px;border-radius:8px;font-size:12px;font-weight:800}
.controls{display:flex;justify-content:center;gap:9px;flex-wrap:wrap;padding:12px;border-top:1px solid var(--line);background:rgba(13,27,23,.95)}
.control{border:1px solid var(--line);background:var(--bg3);color:var(--text);border-radius:999px;padding:11px 15px;font-weight:800;min-width:120px}
.control:hover{background:var(--bg4)}.control.off{background:#18211e;color:var(--muted)}.control.sharing{background:var(--mintbg);color:var(--mint)}.control.danger{background:var(--danger);border-color:transparent}

.rightbar{background:var(--bg1);border-left:1px solid var(--line);padding:18px 14px;overflow-y:auto}
.rightTitle{color:var(--low);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px}
.member{display:flex;align-items:center;gap:9px;padding:9px;border-radius:10px;color:var(--muted)}
.memberDot{width:8px;height:8px;border-radius:50%;background:var(--mint)}

.modalWrap{position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,.72);display:grid;place-items:center;padding:18px}
.modal{width:min(430px,100%);background:var(--bg1);border:1px solid var(--line);border-radius:20px;padding:24px;box-shadow:0 25px 80px rgba(0,0,0,.45)}
.modal h2{margin:0 0 7px}.modal p{margin:0 0 18px;color:var(--muted);font-size:13px;line-height:1.5}
.modalActions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}

.login{
  position:fixed;inset:0;z-index:2000000;
  background:
    radial-gradient(circle at 12% 20%,rgba(65,217,154,.12),transparent 30%),
    radial-gradient(circle at 82% 78%,rgba(255,107,74,.14),transparent 34%),
    var(--bg0);
  display:grid;place-items:center;padding:28px;
}
.loginShell{
  width:min(980px,100%);
  min-height:570px;
  display:grid;
  grid-template-columns:1.12fr .88fr;
  overflow:hidden;
  border:1px solid var(--line);
  border-radius:28px;
  background:rgba(13,27,23,.96);
  box-shadow:0 28px 100px rgba(0,0,0,.42);
}
.loginBrandPanel{
  position:relative;
  padding:46px;
  display:flex;
  flex-direction:column;
  justify-content:space-between;
  background:
    linear-gradient(145deg,rgba(65,217,154,.08),transparent 42%),
    radial-gradient(circle at 75% 20%,rgba(255,107,74,.12),transparent 38%),
    #0a1713;
  border-right:1px solid var(--line);
}
.loginBrandTop{display:flex;align-items:center;gap:13px}
.loginMark{
  width:62px;height:62px;border-radius:20px;
  background:var(--coral);color:#281009;
  display:grid;place-items:center;font-weight:1000;font-size:26px;
  box-shadow:0 0 0 7px rgba(255,107,74,.08);
}
.loginBrandName{font-size:25px;font-weight:950;letter-spacing:-.04em}
.loginBadge{
  width:max-content;
  margin-top:32px;
  padding:7px 10px;
  border:1px solid rgba(65,217,154,.22);
  border-radius:999px;
  color:var(--mint);
  background:rgba(65,217,154,.07);
  font-size:12px;
  font-weight:800;
}
.loginHero h1{
  max-width:460px;
  margin:16px 0 12px;
  font-size:44px;
  line-height:1.03;
  letter-spacing:-.055em;
}
.loginHero p{
  max-width:470px;
  margin:0;
  color:var(--muted);
  font-size:15px;
  line-height:1.65;
}
.loginFeatures{
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:9px;
  margin-top:28px;
}
.loginFeature{
  padding:12px;
  border:1px solid var(--line);
  border-radius:14px;
  background:rgba(18,36,30,.7);
  color:var(--muted);
  font-size:12px;
  line-height:1.4;
}
.loginFeature strong{
  display:block;
  color:var(--text);
  margin-bottom:4px;
  font-size:12px;
}
.loginSignature{
  color:var(--low);
  font-size:11px;
  letter-spacing:.03em;
}
.loginCard{
  width:100%;
  padding:48px 38px;
  display:flex;
  flex-direction:column;
  justify-content:center;
  background:var(--bg1);
}
.loginCard .smallLogo{
  display:none;
  align-items:center;
  gap:10px;
  margin-bottom:26px;
}
.loginCard h2{
  margin:0 0 7px;
  font-size:27px;
  letter-spacing:-.035em;
}
.loginCard>p{
  margin:0 0 24px;
  color:var(--muted);
  line-height:1.55;
  font-size:13px;
}
.loginLabel{
  display:block;
  color:var(--low);
  font-size:11px;
  font-weight:900;
  text-transform:uppercase;
  letter-spacing:.07em;
  margin-bottom:7px;
}
.loginCard .btn{width:100%;margin-top:12px;padding:13px}
.loginPrivacy{
  margin-top:16px;
  padding:11px 12px;
  border-radius:12px;
  background:var(--bg2);
  border:1px solid var(--line);
  color:var(--low);
  font-size:11px;
  line-height:1.45;
}
.loginPrivacy b{color:var(--mint)}


.fakeFullscreen{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;z-index:999999!important;border-radius:0!important;aspect-ratio:auto!important;background:#000!important}
.fakeFullscreen video{object-fit:contain!important}
body.locked{overflow:hidden!important}

.toast{position:fixed;right:18px;bottom:18px;z-index:3000000;background:var(--bg3);border:1px solid var(--line);color:var(--text);padding:11px 14px;border-radius:10px;box-shadow:0 12px 35px rgba(0,0,0,.3);font-size:13px}

@media(max-width:1050px){.app{grid-template-columns:72px 230px minmax(0,1fr)}.rightbar{display:none}}
@media(max-width:760px){
  .app{grid-template-columns:62px minmax(0,1fr)}
  .sidebar{display:none}
  .videoGrid{grid-template-columns:1fr;padding:8px}
  .videoCard{min-height:180px}
  .control{min-width:auto;flex:1 1 42%;font-size:12px}
  .message{max-width:88%}
  .topSub{display:none}
  .login{padding:14px}
  .loginShell{grid-template-columns:1fr;min-height:auto;border-radius:22px}
  .loginBrandPanel{display:none}
  .loginCard{padding:30px 22px}
  .loginCard .smallLogo{display:flex}
}
</style>
</head>
<body>

<div id="login" class="login">
  <div class="loginShell">

    <section class="loginBrandPanel">
      <div>
        <div class="loginBrandTop">
          <div class="loginMark">e</div>
          <div class="loginBrandName">e-cord</div>
        </div>

        <div class="loginHero">
          <div class="loginBadge">● SEU ESPAÇO DE CONVERSA</div>
          <h1>Entre, chame a galera e fique conectado.</h1>
          <p>
            Um lugar simples para criar servidores, conversar por texto,
            entrar em calls, abrir a câmera e compartilhar sua tela.
          </p>

          <div class="loginFeatures">
            <div class="loginFeature">
              <strong>✉ Chats</strong>
              Crie seus próprios canais.
            </div>
            <div class="loginFeature">
              <strong>🎤 Calls</strong>
              Voz rápida com seus amigos.
            </div>
            <div class="loginFeature">
              <strong>🖥 Tela</strong>
              Compartilhe quando quiser.
            </div>
          </div>
        </div>
      </div>

      <div class="loginSignature">e-cord · converse do seu jeito</div>
    </section>

    <section class="loginCard">
      <div class="smallLogo">
        <div class="loginMark">e</div>
        <div class="loginBrandName">e-cord</div>
      </div>

      <h2>Entrar no e-cord</h2>
      <p>Escolha como seus amigos vão ver seu nome dentro do aplicativo.</p>

      <label class="loginLabel" for="loginName">Seu nome</label>
      <input id="loginName" maxlength="30" placeholder="Ex.: Davi" autocomplete="nickname">

      <button id="loginBtn" class="btn primary">Entrar no e-cord</button>

      <div class="loginPrivacy">
        <b>Privacidade:</b> sua câmera não abre ao entrar.
        Ela só pede permissão quando você clicar em “Ligar câmera”.
      </div>
    </section>

  </div>
</div>

<div class="app">
  <aside class="rail">
    <div id="serverRail"></div>
    <div class="railSep"></div>
    <button id="createServerBtn" class="addServer" title="Criar servidor">+</button>
  </aside>

  <aside class="sidebar">
    <div class="sideHead">
      <div class="brand"><span class="brandDot"></span><span id="serverTitle" class="serverTitle">e-cord</span></div>
      <button id="inviteBtn" class="inviteBtn">Convidar</button>
    </div>

    <div class="sideScroll">
      <button id="homeBtn" class="navBtn active">◐ Início</button>
      <button id="friendsBtn" class="navBtn">👥 Amigos</button>
      <button id="messagesBtn" class="navBtn">✉ Mensagens</button>

      <div class="groupHead">
        <span>Canais de texto</span>
        <button id="addTextBtn" class="addChannel" title="Criar canal de texto">+</button>
      </div>
      <div id="textChannels"></div>

      <div class="groupHead">
        <span>Canais de voz</span>
        <button id="addVoiceBtn" class="addChannel" title="Criar canal de voz">+</button>
      </div>
      <div id="voiceChannels"></div>
    </div>

    <div class="userbar">
      <div id="userAvatar" class="avatar">V</div>
      <div class="userMeta"><strong id="userName">Você</strong><span>● Online</span></div>
    </div>
  </aside>

  <main class="main">
    <header class="topbar">
      <div class="topLeft">
        <div id="topTitle" class="topTitle">e-cord</div>
        <div id="topSub" class="topSub">servidores, chat, voz, câmera e tela</div>
      </div>
      <button id="quickInviteBtn" class="btn secondary small">Copiar convite</button>
    </header>

    <div class="content">
      <section id="homeView" class="view home">
        <div class="homeCard">
          <div class="homeMark">e</div>
          <h1 id="welcomeTitle">Bem-vindo ao e-cord</h1>
          <p>Crie servidores, canais de texto e canais de voz. Converse por mensagens, entre em chamadas, ligue a câmera quando quiser e compartilhe a tela.</p>
          <div class="quick">
            <button id="homeCreateServer" class="btn primary">+ Criar servidor</button>
            <button id="homeCreateText" class="btn secondary"># Criar chat</button>
            <button id="homeCreateVoice" class="btn secondary">)) Criar voz</button>
          </div>
        </div>
      </section>

      <section id="friendsView" class="view hidden">
        <div style="height:100%;display:grid;grid-template-rows:auto 1fr;">
          <div style="padding:14px 18px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:10px;">
            <div>
              <strong>👥 Amigos</strong>
              <div style="font-size:12px;color:var(--muted);margin-top:3px;">Sua lista de amigos do e-cord</div>
            </div>
            <button id="addFriendBtn" class="btn primary small">+ Adicionar amigo</button>
          </div>

          <div style="overflow:auto;padding:18px;">
            <div id="friendsList" style="display:grid;gap:10px;"></div>
          </div>
        </div>
      </section>

      <section id="chatView" class="view chatView hidden">
        <div class="chatHead"># <span id="chatTitle">geral</span><span>chat de texto</span></div>
        <div id="messages" class="messages"></div>
        <div class="compose">
          <input id="messageInput" maxlength="500" placeholder="Escreva uma mensagem...">
          <button id="sendBtn" class="btn primary">Enviar</button>
        </div>
      </section>

      <section id="voiceView" class="view voiceView hidden">
        <div class="voiceHead">
          <div class="voiceInfo">
            <strong>)) <span id="voiceTitle">Geral</span></strong>
            <span id="voiceStatus">Fora da chamada</span>
          </div>
          <button id="joinVoiceBtn" class="btn primary small">Entrar na voz</button>
        </div>

        <div id="videoGrid" class="videoGrid"></div>

        <div id="voiceControls" class="controls hidden">
          <button id="micBtn" class="control">🎤 Microfone</button>
          <button id="cameraBtn" class="control off">📷 Ligar câmera</button>
          <button id="screenBtn" class="control">🖥️ Compartilhar tela</button>
          <button id="leaveVoiceBtn" class="control danger">☎ Sair</button>
        </div>
      </section>
    </div>
  </main>

  <aside class="rightbar">
    <div class="rightTitle">Online</div>
    <div id="members"></div>
  </aside>
</div>

<div id="modalWrap" class="modalWrap hidden">
  <div class="modal">
    <h2 id="modalTitle">Criar</h2>
    <p id="modalText"></p>
    <input id="modalInput" maxlength="30">
    <div class="modalActions">
      <button id="modalCancel" class="btn secondary">Cancelar</button>
      <button id="modalOk" class="btn primary">Criar</button>
    </div>
  </div>
</div>

<div id="toast" class="toast hidden"></div>

<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io({reconnection:true});

const $ = (s) => document.querySelector(s);
const state = {
  username: localStorage.getItem('ecord-name') || '',
  servers: [],
  serverId: null,
  textChannelId: null,
  voiceChannelId: null,
  joinedVoiceId: null,
  localStream: null,
  cameraTrack: null,
  screenTrack: null,
  screenStream: null,
  peers: new Map(),
  peerNames: new Map(),
  remoteStreams: new Map(),
  remoteAudio: new Map(),
  pendingCandidates: new Map(),
  modalAction: null,
  onlineUsers: []
};

const rtcConfig = {
  iceServers: [
    {urls:'stun:stun.l.google.com:19302'},
    {urls:'stun:stun1.l.google.com:19302'}
  ]
};

function toast(text){
  const el = $('#toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(()=>el.classList.add('hidden'),1800);
}

function initials(name){
  return (name || 'U').trim().charAt(0).toUpperCase() || 'U';
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

function setView(name){
  $('#homeView').classList.toggle('hidden', name!=='home');
  $('#friendsView').classList.toggle('hidden', name!=='friends');
  $('#chatView').classList.toggle('hidden', name!=='chat');
  $('#voiceView').classList.toggle('hidden', name!=='voice');
  $('#homeBtn').classList.toggle('active', name==='home');
  $('#friendsBtn').classList.toggle('active', name==='friends');
  $('#messagesBtn').classList.toggle('active', name==='chat');

  if(name==='home'){
    $('#topTitle').textContent = currentServer()?.name || 'e-cord';
    $('#topSub').textContent = 'servidores, chat, voz, câmera e tela';
  }
  if(name==='friends'){
    $('#topTitle').textContent = '👥 Amigos';
    $('#topSub').textContent = 'adicione e veja quem está online';
    renderFriends();
  }
  if(name==='chat'){
    const c = currentText();
    $('#topTitle').textContent = c ? '# '+c.name : '# chat';
    $('#topSub').textContent = currentServer()?.name || '';
  }
  if(name==='voice'){
    const c = currentVoice();
    $('#topTitle').textContent = c ? ')) '+c.name : ')) voz';
    $('#topSub').textContent = currentServer()?.name || '';
  }
}

function renderServers(){
  const rail = $('#serverRail');
  rail.innerHTML = '';
  state.servers.forEach(s=>{
    const b = document.createElement('button');
    b.className = 'serverIcon' + (s.id===state.serverId ? ' active' : '');
    b.textContent = initials(s.name);
    b.title = s.name;
    b.addEventListener('click', ()=>selectServer(s.id));
    rail.appendChild(b);
  });
}

function renderSidebar(){
  const s = currentServer();
  if(!s) return;
  $('#serverTitle').textContent = s.name;

  const textBox = $('#textChannels');
  textBox.innerHTML = '';
  s.textChannels.forEach(c=>{
    const b = document.createElement('button');
    b.className = 'channelBtn' + (c.id===state.textChannelId ? ' active' : '');
    b.innerHTML = '<span class="hash">#</span><span></span>';
    b.querySelector('span:last-child').textContent = c.name;
    b.addEventListener('click', ()=>selectText(c.id));
    textBox.appendChild(b);
  });

  const voiceBox = $('#voiceChannels');
  voiceBox.innerHTML = '';
  s.voiceChannels.forEach(c=>{
    const b = document.createElement('button');
    b.className = 'channelBtn voice' + (c.id===state.voiceChannelId ? ' active' : '');
    b.innerHTML = '<span>))</span><span></span>';
    b.querySelector('span:last-child').textContent = c.name;
    b.addEventListener('click', ()=>selectVoice(c.id));
    voiceBox.appendChild(b);
  });
}

function selectServer(serverId){
  if(state.joinedVoiceId) leaveVoice();
  state.serverId = serverId;
  const s = currentServer();
  state.textChannelId = s?.textChannels[0]?.id || null;
  state.voiceChannelId = s?.voiceChannels[0]?.id || null;
  renderServers();
  renderSidebar();
  setView('home');
  const url = new URL(location.href);
  url.searchParams.set('server', serverId);
  history.replaceState(null,'',url);
}

function selectText(channelId){
  state.textChannelId = channelId;
  renderSidebar();
  const c = currentText();
  $('#chatTitle').textContent = c?.name || 'chat';
  $('#messageInput').placeholder = 'Mensagem em #' + (c?.name || 'chat');
  socket.emit('join-text',{serverId:state.serverId,channelId});
  setView('chat');
  $('#messageInput').focus();
}

function selectVoice(channelId){
  state.voiceChannelId = channelId;
  renderSidebar();
  const c = currentVoice();
  $('#voiceTitle').textContent = c?.name || 'Voz';
  setView('voice');
}

function showMessages(history){
  const box = $('#messages');
  box.innerHTML = '';
  history.forEach(m=>appendMessage(m));
  box.scrollTop = box.scrollHeight;
}

function appendMessage(m){
  const row = document.createElement('div');
  row.className = 'message' + (m.senderId===socket.id ? ' mine' : '');
  const strong = document.createElement('strong');
  strong.textContent = m.username;
  const span = document.createElement('span');
  span.textContent = m.text;
  row.append(strong,span);
  $('#messages').appendChild(row);
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

function sendMessage(){
  const input = $('#messageInput');
  const text = input.value.trim().slice(0,500);
  if(!text || !state.serverId || !state.textChannelId) return;
  socket.emit('chat-message',{
    serverId:state.serverId,
    channelId:state.textChannelId,
    username:state.username,
    text
  });
  input.value = '';
  input.focus();
}


function getFriends(){
  try{
    const list = JSON.parse(localStorage.getItem('ecord-friends') || '[]');
    return Array.isArray(list) ? list : [];
  }catch{
    return [];
  }
}

function saveFriends(list){
  localStorage.setItem('ecord-friends', JSON.stringify(list));
}

function addFriendByName(name){
  const clean = String(name || '').trim().slice(0,30);
  if(!clean) return;

  if(clean.toLowerCase() === state.username.toLowerCase()){
    toast('Você não pode adicionar você mesmo');
    return;
  }

  const friends = getFriends();
  if(friends.some(f => f.toLowerCase() === clean.toLowerCase())){
    toast('Esse amigo já está na sua lista');
    return;
  }

  friends.push(clean);
  saveFriends(friends);
  renderFriends();
  toast('Amigo adicionado');
}

function removeFriend(name){
  const friends = getFriends().filter(f => f.toLowerCase() !== name.toLowerCase());
  saveFriends(friends);
  renderFriends();
}

function renderFriends(){
  const box = $('#friendsList');
  if(!box) return;

  const friends = getFriends();
  box.innerHTML = '';

  if(!friends.length){
    const empty = document.createElement('div');
    empty.style.color = 'var(--low)';
    empty.style.fontSize = '13px';
    empty.style.padding = '18px 4px';
    empty.textContent = 'Você ainda não adicionou nenhum amigo.';
    box.appendChild(empty);
    return;
  }

  friends.forEach(friendName => {
    const online = state.onlineUsers.some(
      u => String(u.username || '').toLowerCase() === friendName.toLowerCase()
    );

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg2);border:1px solid var(--line);border-radius:14px;';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = initials(friendName);

    const meta = document.createElement('div');
    meta.style.flex = '1';
    meta.style.minWidth = '0';

    const strong = document.createElement('strong');
    strong.textContent = friendName;
    strong.style.display = 'block';

    const status = document.createElement('span');
    status.textContent = online ? '● Online' : '● Offline';
    status.style.display = 'block';
    status.style.fontSize = '12px';
    status.style.marginTop = '3px';
    status.style.color = online ? 'var(--mint)' : 'var(--low)';

    meta.append(strong, status);

    const remove = document.createElement('button');
    remove.className = 'btn secondary small';
    remove.textContent = 'Remover';
    remove.addEventListener('click', () => removeFriend(friendName));

    row.append(avatar, meta, remove);
    box.appendChild(row);
  });
}

function openModal(type){
  state.modalAction = type;
  const cfg = {
    server:['Criar servidor','Digite o nome do novo servidor.','Ex.: Meus amigos'],
    text:['Criar chat','Digite o nome do novo canal de texto.','Ex.: memes'],
    voice:['Criar canal de voz','Digite o nome do novo canal de voz.','Ex.: Jogos'],
    friend:['Adicionar amigo','Digite exatamente o nome do seu amigo no e-cord.','Ex.: Davi']
  }[type];

  $('#modalTitle').textContent = cfg[0];
  $('#modalText').textContent = cfg[1];
  $('#modalInput').placeholder = cfg[2];
  $('#modalInput').value = '';
  $('#modalWrap').classList.remove('hidden');
  setTimeout(()=>$('#modalInput').focus(),0);
}

function closeModal(){
  $('#modalWrap').classList.add('hidden');
  state.modalAction = null;
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
  } else if(state.modalAction==='friend'){
    addFriendByName(value);
  }
  closeModal();
}

async function copyInvite(){
  if(!state.serverId) return;
  const url = new URL(location.href);
  url.searchParams.set('server',state.serverId);
  try{
    await navigator.clipboard.writeText(url.toString());
    toast('Convite copiado');
  }catch{
    prompt('Copie este convite:',url.toString());
  }
}

async function ensureMic(){
  if(state.localStream && state.localStream.getAudioTracks().length) return state.localStream;
  const mic = await navigator.mediaDevices.getUserMedia({
    audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},
    video:false
  });
  state.localStream = mic;
  return mic;
}

function getVideoSender(pc){
  return pc.getSenders().find(s=>s.track?.kind==='video') ||
         pc.getSenders().find(s=>s.track===null);
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

    card.append(video,ph,lab);
    $('#videoGrid').appendChild(card);
  }

  const video = card.querySelector('video');
  // O vídeo fica mudo para evitar áudio duplicado.
  // O áudio remoto é reproduzido em um elemento <audio> separado.
  video.muted = true;
  if(stream && video.srcObject!==stream) video.srcObject = stream;
  const hasVideo = !!stream?.getVideoTracks().some(t=>t.readyState==='live' && t.enabled);
  card.classList.toggle('hasVideo',hasVideo);
  card.querySelector('.videoName').textContent = name;
  card.querySelector('.bigAvatar').textContent = initials(name);
  return card;
}


function removeRemoteAudio(peerId){
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

function ensureRemoteAudio(peerId, track){
  let audio = state.remoteAudio.get(peerId);

  if(!audio){
    audio = document.createElement('audio');
    audio.id = 'a-' + peerId;
    audio.autoplay = true;
    audio.playsInline = true;
    audio.controls = false;
    audio.style.display = 'none';
    document.body.appendChild(audio);
    state.remoteAudio.set(peerId, audio);
  }

  const current = audio.srcObject;
  if(!current || !current.getTracks().some(t => t.id === track.id)){
    audio.srcObject = new MediaStream([track]);
  }

  audio.muted = false;
  audio.volume = 1;

  const tryPlay = () => {
    audio.play().catch(() => {
      $('#voiceStatus').textContent = 'Clique na tela para ativar o áudio';
    });
  };

  tryPlay();

  // Se o navegador bloquear autoplay, qualquer clique do usuário libera o som.
  const unlock = () => {
    audio.play().then(() => {
      if(state.joinedVoiceId) $('#voiceStatus').textContent = 'Conectado';
    }).catch(()=>{});
  };

  document.addEventListener('click', unlock, { once:true });
  document.addEventListener('keydown', unlock, { once:true });

  track.addEventListener('unmute', tryPlay);
  track.addEventListener('ended', () => removeRemoteAudio(peerId));

  return audio;
}

function unlockAllRemoteAudio(){
  for(const audio of state.remoteAudio.values()){
    audio.muted = false;
    audio.volume = 1;
    audio.play().catch(()=>{});
  }
}

function getRemoteStream(peerId){
  if(!state.remoteStreams.has(peerId)) state.remoteStreams.set(peerId,new MediaStream());
  return state.remoteStreams.get(peerId);
}

function createPeer(peerId,username){
  if(state.peers.has(peerId)) return state.peers.get(peerId);

  state.peerNames.set(peerId,username || 'Usuário');
  const pc = new RTCPeerConnection(rtcConfig);
  state.peers.set(peerId,pc);

  if(state.localStream){
    for(const track of state.localStream.getAudioTracks()) pc.addTrack(track,state.localStream);
  }

  pc.addTransceiver('video',{direction:'sendrecv'});

  pc.onicecandidate = ev=>{
    if(ev.candidate) socket.emit('ice-candidate',{target:peerId,candidate:ev.candidate});
  };

  pc.ontrack = ev=>{
    const name = state.peerNames.get(peerId) || 'Usuário';

    if(ev.track.kind === 'audio'){
      ensureRemoteAudio(peerId, ev.track);

      // Mesmo sem câmera, mantém o cartão/avatar do amigo visível.
      const visualStream = getRemoteStream(peerId);
      ensureCard(peerId, name, visualStream, false);
      return;
    }

    if(ev.track.kind === 'video'){
      const stream = getRemoteStream(peerId);
      if(!stream.getTracks().some(t=>t.id===ev.track.id)) stream.addTrack(ev.track);

      ensureCard(peerId, name, stream, false);

      const refresh = ()=>ensureCard(peerId,name,stream,false);
      ev.track.addEventListener('mute', refresh);
      ev.track.addEventListener('unmute', refresh);
      ev.track.addEventListener('ended', refresh);
    }
  };

  pc.onconnectionstatechange = ()=>{
    if(pc.connectionState==='failed'){
      try{pc.restartIce()}catch{}
    }
  };

  return pc;
}

async function flushCandidates(peerId){
  const pc = state.peers.get(peerId);
  const list = state.pendingCandidates.get(peerId)||[];
  if(!pc?.remoteDescription) return;
  for(const c of list){
    try{await pc.addIceCandidate(c)}catch{}
  }
  state.pendingCandidates.delete(peerId);
}

async function makeOffer(peerId,username){
  const pc = createPeer(peerId,username);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('offer',{target:peerId,sdp:pc.localDescription});
}

async function joinVoice(){
  const channel = currentVoice();
  if(!channel) return;

  try{
    $('#joinVoiceBtn').disabled = true;
    $('#joinVoiceBtn').textContent = 'Entrando...';
    await ensureMic();

    state.joinedVoiceId = channel.id;
    $('#voiceControls').classList.remove('hidden');
    $('#joinVoiceBtn').classList.add('hidden');
    $('#voiceStatus').textContent = 'Conectando...';

    ensureCard('local',state.username+' (você)',state.localStream,true);

    unlockAllRemoteAudio();

    socket.emit('join-voice',{
      serverId:state.serverId,
      channelId:channel.id,
      username:state.username
    });
  }catch(err){
    console.error(err);
    toast('Permita o microfone para entrar na voz');
  }finally{
    $('#joinVoiceBtn').disabled = false;
    $('#joinVoiceBtn').textContent = 'Entrar na voz';
  }
}

function closePeers(){
  for(const pc of state.peers.values()) pc.close();

  for(const peerId of [...state.remoteAudio.keys()]){
    removeRemoteAudio(peerId);
  }

  state.peers.clear();
  state.peerNames.clear();
  state.remoteStreams.clear();
  state.pendingCandidates.clear();
  $('#videoGrid').innerHTML = '';
}

function leaveVoice(){
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
  $('#voiceControls').classList.add('hidden');
  $('#joinVoiceBtn').classList.remove('hidden');
  $('#voiceStatus').textContent = 'Fora da chamada';
  $('#cameraBtn').textContent = '📷 Ligar câmera';
  $('#cameraBtn').classList.add('off');
  $('#screenBtn').textContent = '🖥️ Compartilhar tela';
  $('#screenBtn').classList.remove('sharing');
}

function toggleMic(){
  const t = state.localStream?.getAudioTracks()[0];
  if(!t) return;
  t.enabled = !t.enabled;
  $('#micBtn').textContent = t.enabled ? '🎤 Microfone' : '🔇 Microfone';
  $('#micBtn').classList.toggle('off',!t.enabled);
}

async function toggleCamera(){
  if(!state.joinedVoiceId) return;

  if(state.cameraTrack && state.cameraTrack.readyState==='live'){
    state.cameraTrack.enabled = !state.cameraTrack.enabled;
    $('#cameraBtn').textContent = state.cameraTrack.enabled ? '📷 Câmera' : '📷 Ligar câmera';
    $('#cameraBtn').classList.toggle('off',!state.cameraTrack.enabled);
    ensureCard('local',state.username+' (você)',state.localStream,true);
    return;
  }

  try{
    $('#cameraBtn').disabled = true;
    $('#cameraBtn').textContent = 'Abrindo...';

    const cam = await navigator.mediaDevices.getUserMedia({
      video:{width:{ideal:1280},height:{ideal:720}},
      audio:false
    });

    state.cameraTrack = cam.getVideoTracks()[0];
    if(!state.localStream) state.localStream = new MediaStream();
    state.localStream.addTrack(state.cameraTrack);

    const tasks = [];
    for(const pc of state.peers.values()){
      const sender = getVideoSender(pc);
      if(sender) tasks.push(sender.replaceTrack(state.cameraTrack));
    }
    await Promise.allSettled(tasks);

    ensureCard('local',state.username+' (você)',state.localStream,true);
    $('#cameraBtn').textContent = '📷 Câmera';
    $('#cameraBtn').classList.remove('off');
  }catch(err){
    console.error(err);
    $('#cameraBtn').textContent = '📷 Ligar câmera';
    $('#cameraBtn').classList.add('off');
    toast('Câmera não autorizada');
  }finally{
    $('#cameraBtn').disabled = false;
  }
}

async function stopScreen(){
  if(state.screenStream) state.screenStream.getTracks().forEach(t=>t.stop());
  state.screenStream = null;
  state.screenTrack = null;

  const replacement = state.cameraTrack && state.cameraTrack.enabled ? state.cameraTrack : null;
  const tasks = [];
  for(const pc of state.peers.values()){
    const sender = getVideoSender(pc);
    if(sender) tasks.push(sender.replaceTrack(replacement));
  }
  await Promise.allSettled(tasks);

  ensureCard('local',state.username+' (você)',state.localStream,true);
  $('#screenBtn').textContent = '🖥️ Compartilhar tela';
  $('#screenBtn').classList.remove('sharing');
  $('#cameraBtn').disabled = false;
}

async function toggleScreen(){
  if(!state.joinedVoiceId) return;
  if(state.screenTrack){
    await stopScreen();
    return;
  }

  try{
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});
    state.screenTrack = state.screenStream.getVideoTracks()[0];
    const tasks = [];
    for(const pc of state.peers.values()){
      const sender = getVideoSender(pc);
      if(sender) tasks.push(sender.replaceTrack(state.screenTrack));
    }
    await Promise.allSettled(tasks);

    const preview = new MediaStream([state.screenTrack]);
    ensureCard('local',state.username+' — compartilhando tela',preview,true);

    $('#screenBtn').textContent = '⏹ Parar tela';
    $('#screenBtn').classList.add('sharing');
    $('#cameraBtn').disabled = true;
    state.screenTrack.onended = ()=>stopScreen().catch(console.error);
  }catch(err){
    if(err?.name!=='NotAllowedError') console.error(err);
  }
}

function renderMembers(list){
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
    const dot=document.createElement('span');
    dot.className='memberDot';
    const name=document.createElement('span');
    name.textContent=u.username;
    row.append(dot,name);
    box.appendChild(row);
  });
}

$('#loginBtn').addEventListener('click',()=>{
  const name = $('#loginName').value.trim().slice(0,30);
  if(!name) return;
  state.username = name;
  localStorage.setItem('ecord-name',name);
  $('#userName').textContent = name;
  $('#userAvatar').textContent = initials(name);
  $('#welcomeTitle').textContent = 'Bem-vindo, '+name;
  $('#login').classList.add('hidden');
  socket.emit('set-username', { username: name });
});

$('#loginName').addEventListener('keydown',e=>{if(e.key==='Enter') $('#loginBtn').click()});
if(state.username){
  $('#loginName').value=state.username;
  setTimeout(()=>$('#loginBtn').click(),0);
}

$('#createServerBtn').addEventListener('click',()=>openModal('server'));
$('#homeCreateServer').addEventListener('click',()=>openModal('server'));
$('#addTextBtn').addEventListener('click',()=>openModal('text'));
$('#homeCreateText').addEventListener('click',()=>openModal('text'));
$('#addVoiceBtn').addEventListener('click',()=>openModal('voice'));
$('#homeCreateVoice').addEventListener('click',()=>openModal('voice'));
$('#modalCancel').addEventListener('click',closeModal);
$('#modalOk').addEventListener('click',confirmModal);
$('#modalInput').addEventListener('keydown',e=>{if(e.key==='Enter')confirmModal();if(e.key==='Escape')closeModal()});
$('#modalWrap').addEventListener('click',e=>{if(e.target===$('#modalWrap'))closeModal()});

$('#homeBtn').addEventListener('click',()=>setView('home'));
$('#friendsBtn').addEventListener('click',()=>setView('friends'));
$('#addFriendBtn').addEventListener('click',()=>openModal('friend'));
$('#messagesBtn').addEventListener('click',()=>{
  if(state.textChannelId) selectText(state.textChannelId);
  else toast('Crie um chat primeiro');
});
$('#inviteBtn').addEventListener('click',copyInvite);
$('#quickInviteBtn').addEventListener('click',copyInvite);
$('#sendBtn').addEventListener('click',sendMessage);
$('#messageInput').addEventListener('keydown',e=>{if(e.key==='Enter')sendMessage()});
$('#joinVoiceBtn').addEventListener('click',joinVoice);
$('#leaveVoiceBtn').addEventListener('click',leaveVoice);
$('#micBtn').addEventListener('click',toggleMic);
$('#cameraBtn').addEventListener('click',toggleCamera);
$('#screenBtn').addEventListener('click',toggleScreen);

$('#videoGrid').addEventListener('click',e=>{
  const card = e.target.closest('.videoCard');
  if(!card) return;
  const open = card.classList.contains('fakeFullscreen');
  document.querySelectorAll('.fakeFullscreen').forEach(x=>x.classList.remove('fakeFullscreen'));
  if(open){
    document.body.classList.remove('locked');
  }else{
    card.classList.add('fakeFullscreen');
    document.body.classList.add('locked');
  }
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    document.querySelectorAll('.fakeFullscreen').forEach(x=>x.classList.remove('fakeFullscreen'));
    document.body.classList.remove('locked');
  }
});

socket.on('online-users', users => {
  state.onlineUsers = Array.isArray(users) ? users : [];
  renderFriends();
});

socket.on('server-list',list=>{
  state.servers = list;

  const requested = new URLSearchParams(location.search).get('server');
  if(!state.serverId){
    const chosen = list.find(s=>s.id===requested) || list[0];
    if(chosen) selectServer(chosen.id);
  }else{
    const still = list.find(s=>s.id===state.serverId);
    if(!still && list[0]) selectServer(list[0].id);
    else{
      renderServers();
      renderSidebar();
    }
  }
});

socket.on('server-created',({serverId})=>{
  selectServer(serverId);
  toast('Servidor criado');
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

socket.on('text-history',history=>showMessages(history));
socket.on('chat-message',m=>{
  if(m.serverId===state.serverId && m.channelId===state.textChannelId) appendMessage(m);
});

socket.on('voice-participants',async participants=>{
  renderMembers([{id:socket.id,username:state.username},...participants]);
  for(const p of participants){
    state.peerNames.set(p.id,p.username);
    await makeOffer(p.id,p.username);
  }
  unlockAllRemoteAudio();
  $('#voiceStatus').textContent='Conectado';
});

socket.on('voice-members',members=>renderMembers(members));

socket.on('user-joined',({id,username})=>{
  state.peerNames.set(id,username);
});

socket.on('offer',async({from,sdp,username})=>{
  const pc=createPeer(from,username);
  await pc.setRemoteDescription(sdp);
  await flushCandidates(from);
  const answer=await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer',{target:from,sdp:pc.localDescription});
});

socket.on('answer',async({from,sdp})=>{
  const pc=state.peers.get(from);
  if(!pc)return;
  await pc.setRemoteDescription(sdp);
  await flushCandidates(from);
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
  state.peers.get(id)?.close();
  state.peers.delete(id);
  state.peerNames.delete(id);
  state.remoteStreams.delete(id);
  removeRemoteAudio(id);
  document.getElementById('v-'+id)?.remove();
});

socket.on('disconnect',()=>{
  if(state.joinedVoiceId) $('#voiceStatus').textContent='Reconectando servidor...';
});

socket.on('connect',()=>{
  socket.emit('get-servers');
  if(state.username) socket.emit('set-username',{username:state.username});
  if(state.joinedVoiceId && state.serverId && state.voiceChannelId){
    closePeers();
    socket.emit('join-voice',{
      serverId:state.serverId,
      channelId:state.voiceChannelId,
      username:state.username
    });
  }
});
</script>
</body>
</html>`;

app.get('/', (req, res) => {
  res.type('html').send(APP_HTML);
});

io.on('connection', socket => {
  socket.emit('server-list', publicServers());
  broadcastOnlineUsers();

  socket.on('set-username', ({ username }) => {
    socket.data.username = cleanName(username);
    broadcastOnlineUsers();
  });

  socket.on('get-servers', () => {
    socket.emit('server-list', publicServers());
  });

  socket.on('create-server', ({ name }) => {
    const created = makeServer(cleanName(name, 'Novo servidor'));
    io.emit('server-list', publicServers());
    socket.emit('server-created', { serverId: created.id });
  });

  socket.on('create-channel', ({ serverId, type, name }) => {
    const s = servers.get(serverId);
    if (!s) return;

    if (type === 'text') {
      const channel = { id: id(), name: cleanChannel(name, 'novo-chat') };
      s.textChannels.push(channel);
      s.messages.set(channel.id, []);
      io.emit('server-list', publicServers());
      socket.emit('channel-created', { serverId, type: 'text', channelId: channel.id });
      return;
    }

    if (type === 'voice') {
      const channel = { id: id(), name: cleanName(name, 'Nova voz') };
      s.voiceChannels.push(channel);
      io.emit('server-list', publicServers());
      socket.emit('channel-created', { serverId, type: 'voice', channelId: channel.id });
    }
  });

  socket.on('join-text', ({ serverId, channelId }) => {
    const s = servers.get(serverId);
    if (!s || !s.textChannels.some(c => c.id === channelId)) return;

    if (socket.data.textRoom) socket.leave(socket.data.textRoom);

    const room = `text:${serverId}:${channelId}`;
    socket.data.textRoom = room;
    socket.data.textServerId = serverId;
    socket.data.textChannelId = channelId;
    socket.join(room);

    socket.emit('text-history', s.messages.get(channelId) || []);
  });

  socket.on('chat-message', ({ serverId, channelId, username, text }) => {
    const s = servers.get(serverId);
    if (!s || !s.textChannels.some(c => c.id === channelId)) return;

    const safeText = String(text || '').trim().slice(0, 500);
    if (!safeText) return;

    const message = {
      id: id(),
      senderId: socket.id,
      username: cleanName(username),
      text: safeText,
      serverId,
      channelId,
      at: Date.now()
    };

    const history = s.messages.get(channelId) || [];
    history.push(message);
    while (history.length > 100) history.shift();
    s.messages.set(channelId, history);

    io.to(`text:${serverId}:${channelId}`).emit('chat-message', message);
  });

  function leaveVoiceRoom() {
    const room = socket.data.voiceRoom;
    if (!room) return;

    socket.leave(room);
    socket.to(room).emit('user-left', { id: socket.id });

    const members = [...(io.sockets.adapter.rooms.get(room) || [])]
      .map(socketId => {
        const s = io.sockets.sockets.get(socketId);
        return s ? { id: socketId, username: s.data.username || 'Usuário' } : null;
      })
      .filter(Boolean);

    io.to(room).emit('voice-members', members);

    socket.data.voiceRoom = null;
    socket.data.voiceServerId = null;
    socket.data.voiceChannelId = null;
  }

  socket.on('join-voice', ({ serverId, channelId, username }) => {
    const s = servers.get(serverId);
    if (!s || !s.voiceChannels.some(c => c.id === channelId)) return;

    leaveVoiceRoom();

    const room = `voice:${serverId}:${channelId}`;

    const participants = [...(io.sockets.adapter.rooms.get(room) || [])]
      .map(socketId => {
        const p = io.sockets.sockets.get(socketId);
        return p ? { id: socketId, username: p.data.username || 'Usuário' } : null;
      })
      .filter(Boolean);

    socket.data.username = cleanName(username);
    socket.data.voiceRoom = room;
    socket.data.voiceServerId = serverId;
    socket.data.voiceChannelId = channelId;

    socket.join(room);

    socket.emit('voice-participants', participants);
    socket.to(room).emit('user-joined', { id: socket.id, username: socket.data.username });

    const members = [...(io.sockets.adapter.rooms.get(room) || [])]
      .map(socketId => {
        const p = io.sockets.sockets.get(socketId);
        return p ? { id: socketId, username: p.data.username || 'Usuário' } : null;
      })
      .filter(Boolean);

    io.to(room).emit('voice-members', members);
  });

  socket.on('leave-voice', leaveVoiceRoom);

  socket.on('offer', ({ target, sdp }) => {
    io.to(target).emit('offer', {
      from: socket.id,
      sdp,
      username: socket.data.username || 'Usuário'
    });
  });

  socket.on('answer', ({ target, sdp }) => {
    io.to(target).emit('answer', { from: socket.id, sdp });
  });

  socket.on('ice-candidate', ({ target, candidate }) => {
    io.to(target).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('disconnect', () => {
    const room = socket.data.voiceRoom;
    setTimeout(broadcastOnlineUsers, 0);
    if (room) {
      socket.to(room).emit('user-left', { id: socket.id });

      setTimeout(() => {
        const members = [...(io.sockets.adapter.rooms.get(room) || [])]
          .map(socketId => {
            const p = io.sockets.sockets.get(socketId);
            return p ? { id: socketId, username: p.data.username || 'Usuário' } : null;
          })
          .filter(Boolean);
        io.to(room).emit('voice-members', members);
      }, 0);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`e-cord rodando na porta ${PORT}`);
});
