const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

function publicProfile(profile) {
  if (!profile) return null;

  return {
    id: String(profile.id || '').slice(0, 100),
    username: String(profile.username || 'Usuário').slice(0, 30),
    bio: String(profile.bio || '').slice(0, 160),
    avatar: String(profile.avatar || '').slice(0, 350000)
  };
}

function findProfileByUsername(username) {
  const key = String(username || '').trim().toLowerCase();
  if (!key) return null;

  for (const profile of profiles.values()) {
    if (String(profile.username || '').toLowerCase() === key) {
      return profile;
    }
  }

  return null;
}

function broadcastOnlineUsers() {
  const users = [...io.sockets.sockets.values()]
    .filter(s => s.data.username)
    .map(s => {
      const profile = s.data.userId ? profiles.get(s.data.userId) : null;

      return {
        socketId: s.id,
        id: profile?.id || s.data.userId || s.id,
        username: profile?.username || s.data.username,
        bio: profile?.bio || '',
        avatar: profile?.avatar || ''
      };
    });

  io.emit('online-users', users);
}

const id = () => crypto.randomBytes(5).toString('hex');

const DATA_FILE = process.env.ECORD_DATA_FILE || path.join(process.cwd(), 'ecord-data.json');
const servers = new Map();
const profiles = new Map();

function normalizeChannelList(list, fallbackName) {
  if (!Array.isArray(list) || !list.length) {
    return [{ id: id(), name: fallbackName }];
  }

  return list
    .filter(Boolean)
    .slice(0, 100)
    .map(channel => ({
      id: String(channel.id || id()).slice(0, 80),
      name: String(channel.name || fallbackName).trim().slice(0, 30) || fallbackName
    }));
}

function normalizeRoles(list) {
  if (!Array.isArray(list)) return [];

  return list
    .filter(Boolean)
    .slice(0, 50)
    .map(role => {
      const color = /^#[0-9a-f]{6}$/i.test(String(role.color || ''))
        ? String(role.color)
        : '#ff6b4a';

      const members = Array.isArray(role.members)
        ? [...new Set(
            role.members
              .map(name => String(name || '').trim().slice(0, 30))
              .filter(Boolean)
          )].slice(0, 100)
        : [];

      return {
        id: String(role.id || id()).slice(0, 80),
        name: String(role.name || 'Cargo').trim().slice(0, 30) || 'Cargo',
        color,
        members
      };
    });
}

function makeServer(name = 'e-cord', options = {}) {
  const serverId = String(options.id || id()).slice(0, 80);

  if (servers.has(serverId)) {
    return servers.get(serverId);
  }

  const textChannels = normalizeChannelList(options.textChannels, 'geral');
  const voiceChannels = normalizeChannelList(options.voiceChannels, 'Geral');
  const roles = normalizeRoles(options.roles);

  const messages = new Map();
  for (const channel of textChannels) {
    const history = Array.isArray(options.messages?.[channel.id])
      ? options.messages[channel.id].slice(-100)
      : [];
    messages.set(channel.id, history);
  }

  const data = {
    id: serverId,
    name: String(name || 'Servidor').trim().slice(0, 30) || 'Servidor',
    icon: String(options.icon || '').slice(0, 350000),
    accent: /^#[0-9a-f]{6}$/i.test(String(options.accent || ''))
      ? String(options.accent)
      : '#ff6b4a',
    description: String(options.description || '').trim().slice(0, 240),
    tags: Array.isArray(options.tags)
      ? options.tags.map(tag => String(tag || '').trim().slice(0, 22)).filter(Boolean).slice(0, 5)
      : [],
    textChannels,
    voiceChannels,
    roles,
    messages
  };

  servers.set(serverId, data);
  return data;
}

function serializeProfiles() {
  return [...profiles.values()].map(profile => ({
    id: String(profile.id || '').slice(0, 100),
    username: String(profile.username || 'Usuário').slice(0, 30),
    bio: String(profile.bio || '').slice(0, 160),
    avatar: String(profile.avatar || '').slice(0, 350000)
  }));
}

function serializeServers() {
  return [...servers.values()].map(serverData => ({
    id: serverData.id,
    name: serverData.name,
    icon: serverData.icon,
    accent: serverData.accent,
    description: serverData.description,
    tags: serverData.tags,
    textChannels: serverData.textChannels,
    voiceChannels: serverData.voiceChannels,
    roles: serverData.roles,
    messages: Object.fromEntries(serverData.messages)
  }));
}

function saveServersToDisk() {
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        version: 3,
        servers: serializeServers(),
        profiles: serializeProfiles()
      }, null, 2),
      'utf8'
    );
    fs.renameSync(tmp, DATA_FILE);
  } catch (error) {
    console.error('Não foi possível salvar os servidores:', error.message);
  }
}

function loadServersFromDisk() {
  try {
    if (!fs.existsSync(DATA_FILE)) return false;

    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const list = Array.isArray(parsed?.servers) ? parsed.servers : [];
    const savedProfiles = Array.isArray(parsed?.profiles) ? parsed.profiles : [];

    for (const raw of savedProfiles.slice(0, 5000)) {
      const profileId = String(raw?.id || '').trim().slice(0, 100);
      if (!profileId) continue;

      profiles.set(profileId, {
        id: profileId,
        username: cleanName(raw?.username, 'Usuário'),
        bio: String(raw?.bio || '').trim().slice(0, 160),
        avatar: String(raw?.avatar || '').slice(0, 350000)
      });
    }

    for (const item of list) {
      makeServer(item.name, {
        id: item.id,
        icon: item.icon,
        accent: item.accent,
        description: item.description,
        tags: item.tags,
        textChannels: item.textChannels,
        voiceChannels: item.voiceChannels,
        roles: item.roles,
        messages: item.messages
      });
    }

    return true;
  } catch (error) {
    console.error('Não foi possível carregar os servidores salvos:', error.message);
    return false;
  }
}

function mergeRestoredServer(item) {
  if (!item?.id) return null;

  const serverId = String(item.id).slice(0, 80);
  const existing = servers.get(serverId);

  if (!existing) {
    return makeServer(item.name || 'Servidor', {
      id: serverId,
      icon: item.icon,
      accent: item.accent,
      description: item.description,
      tags: item.tags,
      textChannels: item.textChannels,
      voiceChannels: item.voiceChannels,
      roles: item.roles
    });
  }

  if (item.name) {
    existing.name = String(item.name).trim().slice(0, 30) || existing.name;
  }

  if (typeof item.icon === 'string') {
    existing.icon = item.icon.slice(0, 350000);
  }

  if (/^#[0-9a-f]{6}$/i.test(String(item.accent || ''))) {
    existing.accent = String(item.accent);
  }

  if (typeof item.description === 'string') {
    existing.description = item.description.trim().slice(0, 240);
  }

  if (Array.isArray(item.tags)) {
    existing.tags = item.tags
      .map(tag => String(tag || '').trim().slice(0, 22))
      .filter(Boolean)
      .slice(0, 5);
  }

  const mergeChannels = (target, incoming, fallback) => {
    if (!Array.isArray(incoming)) return;
    const known = new Set(target.map(channel => channel.id));

    for (const channel of incoming.slice(0, 100)) {
      const channelId = String(channel?.id || id()).slice(0, 80);
      if (known.has(channelId)) continue;

      target.push({
        id: channelId,
        name: String(channel?.name || fallback).trim().slice(0, 30) || fallback
      });
      known.add(channelId);
    }
  };

  mergeChannels(existing.textChannels, item.textChannels, 'chat');
  mergeChannels(existing.voiceChannels, item.voiceChannels, 'Voz');

  if (Array.isArray(item.roles)) {
    const knownRoles = new Set(existing.roles.map(role => role.id));

    for (const role of normalizeRoles(item.roles)) {
      const current = existing.roles.find(itemRole => itemRole.id === role.id);

      if (current) {
        current.name = role.name;
        current.color = role.color;
        current.members = [...new Set([...(current.members || []), ...(role.members || [])])].slice(0, 100);
      } else if (!knownRoles.has(role.id)) {
        existing.roles.push(role);
        knownRoles.add(role.id);
      }
    }
  }

  for (const channel of existing.textChannels) {
    if (!existing.messages.has(channel.id)) existing.messages.set(channel.id, []);
  }

  return existing;
}

if (!loadServersFromDisk()) {
  // Primeira execução: começa sem criar servidor automaticamente.
  // O usuário cria o primeiro servidor quando quiser.
  saveServersToDisk();
}

function publicServers() {
  return [...servers.values()].map(s => ({
    id: s.id,
    name: s.name,
    icon: s.icon,
    accent: s.accent,
    description: s.description,
    tags: s.tags,
    textChannels: s.textChannels,
    voiceChannels: s.voiceChannels,
    roles: s.roles
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
button,input,textarea{font:inherit}
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



.sharePickerWrap{
  position:fixed;inset:0;z-index:1900000;
  display:grid;place-items:center;
  padding:18px;
  background:rgba(2,8,6,.78);
  backdrop-filter:blur(10px);
}
.sharePicker{
  width:min(720px,100%);
  border:1px solid var(--line);
  border-radius:24px;
  overflow:hidden;
  background:linear-gradient(145deg,rgba(65,217,154,.055),transparent 34%),var(--bg1);
  box-shadow:0 28px 90px rgba(0,0,0,.48);
}
.sharePickerHead{
  padding:24px 24px 17px;
  border-bottom:1px solid var(--line);
  display:flex;align-items:flex-start;justify-content:space-between;gap:16px;
}
.sharePickerBrand{display:flex;gap:12px;align-items:center}
.sharePickerLogo{
  width:44px;height:44px;border-radius:14px;
  display:grid;place-items:center;
  background:var(--coral);color:#281009;
  font-size:18px;font-weight:950;
}
.sharePickerHead h2{margin:0 0 4px;font-size:21px;letter-spacing:-.035em}
.sharePickerHead p{margin:0;color:var(--muted);font-size:12px;line-height:1.45}
.sharePickerClose{
  width:34px;height:34px;border:1px solid var(--line);
  border-radius:10px;background:var(--bg2);color:var(--muted);font-weight:900;
}
.shareChoices{
  display:grid;grid-template-columns:repeat(3,1fr);
  gap:10px;padding:18px;
}
.shareChoice{
  min-height:150px;
  border:1px solid var(--line);
  border-radius:16px;
  background:var(--bg2);
  color:var(--text);
  padding:17px;
  text-align:left;
  transition:.15s ease;
}
.shareChoice:hover{
  transform:translateY(-2px);
  border-color:rgba(255,107,74,.65);
  background:var(--bg3);
}
.shareChoiceIcon{
  width:43px;height:43px;border-radius:13px;
  display:grid;place-items:center;
  background:rgba(255,107,74,.10);
  color:var(--coral);
  font-size:21px;margin-bottom:14px;
}
.shareChoice strong{display:block;margin-bottom:6px;font-size:14px}
.shareChoice span{display:block;color:var(--muted);font-size:12px;line-height:1.45}
.sharePickerFoot{
  padding:0 18px 18px;color:var(--low);
  font-size:11px;line-height:1.5;
}
.audioGate{
  border:1px solid rgba(65,217,154,.38)!important;
  background:var(--mintbg)!important;
  color:var(--mint)!important;
}


.serverSettings{
  height:100%;
  display:grid;
  grid-template-columns:220px minmax(0,1fr);
  background:#091510;
}
.settingsMenu{
  border-right:1px solid var(--line);
  padding:22px 14px;
  background:#0b1915;
  overflow:auto;
}
.settingsServerName{
  padding:0 10px 16px;
  color:var(--text);
  font-size:12px;
  font-weight:900;
  letter-spacing:.06em;
  text-transform:uppercase;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.settingsGroup{
  margin-top:15px;
  padding:0 10px 6px;
  color:var(--low);
  font-size:10px;
  font-weight:900;
  letter-spacing:.08em;
  text-transform:uppercase;
}
.settingsNavBtn{
  width:100%;
  border:0;
  background:transparent;
  color:var(--muted);
  padding:9px 10px;
  border-radius:9px;
  text-align:left;
  font-weight:650;
  font-size:13px;
  margin:1px 0;
}
.settingsNavBtn:hover,
.settingsNavBtn.active{
  background:var(--bg3);
  color:var(--text);
}
.settingsNavBtn.danger{
  color:#ff7f7f;
}
.settingsBody{
  overflow:auto;
  padding:32px 38px 60px;
}
.settingsPanel{
  width:min(850px,100%);
}
.settingsPanel h2{
  margin:0 0 7px;
  font-size:24px;
  letter-spacing:-.035em;
}
.settingsPanel>p{
  margin:0 0 24px;
  color:var(--muted);
  line-height:1.5;
  font-size:13px;
}
.settingsGrid{
  display:grid;
  grid-template-columns:minmax(0,1fr) 260px;
  gap:30px;
}
.settingsCard{
  background:var(--bg1);
  border:1px solid var(--line);
  border-radius:18px;
  padding:20px;
}
.settingsLabel{
  display:block;
  margin:0 0 7px;
  color:var(--low);
  font-size:10px;
  font-weight:900;
  letter-spacing:.08em;
  text-transform:uppercase;
}
.settingsField{
  margin-bottom:18px;
}
.serverIconPreview{
  width:92px;
  height:92px;
  border-radius:28px;
  display:grid;
  place-items:center;
  font-size:29px;
  font-weight:950;
  color:#25100b;
  background:var(--coral);
  background-size:cover;
  background-position:center;
  border:1px solid rgba(255,255,255,.08);
}
.accentChoices{
  display:grid;
  grid-template-columns:repeat(5,1fr);
  gap:8px;
}
.accentChoice{
  height:48px;
  border-radius:12px;
  border:2px solid transparent;
}
.accentChoice.active{
  border-color:var(--text);
  box-shadow:0 0 0 3px rgba(255,255,255,.06);
}
.serverPreview{
  overflow:hidden;
  border:1px solid var(--line);
  border-radius:18px;
  background:var(--bg2);
}
.serverPreviewBanner{
  height:105px;
  background:var(--coral);
}
.serverPreviewInner{
  padding:0 16px 18px;
}
.serverPreviewIcon{
  width:64px;
  height:64px;
  margin-top:-32px;
  border:5px solid var(--bg2);
  border-radius:22px;
  display:grid;
  place-items:center;
  background:var(--coral);
  color:#25100b;
  background-size:cover;
  background-position:center;
  font-size:21px;
  font-weight:950;
}
.serverPreviewName{
  font-weight:900;
  font-size:15px;
  margin-top:9px;
}
.serverPreviewDescription{
  color:var(--muted);
  font-size:12px;
  line-height:1.5;
  margin-top:7px;
}
.serverTags{
  display:flex;
  flex-wrap:wrap;
  gap:6px;
  margin-top:12px;
}
.serverTag{
  padding:5px 8px;
  border-radius:999px;
  background:var(--bg3);
  border:1px solid var(--line);
  color:var(--muted);
  font-size:10px;
  font-weight:700;
}
.settingsMember{
  display:flex;
  align-items:center;
  gap:10px;
  padding:11px 12px;
  border:1px solid var(--line);
  background:var(--bg2);
  border-radius:12px;
  margin-bottom:8px;
}
.settingsDangerBox{
  border:1px solid rgba(223,76,76,.35);
  background:rgba(223,76,76,.07);
  padding:18px;
  border-radius:15px;
}
@media(max-width:850px){
  .serverSettings{grid-template-columns:160px minmax(0,1fr)}
  .settingsBody{padding:24px 18px 50px}
  .settingsGrid{grid-template-columns:1fr}
}

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
  .shareChoices{grid-template-columns:1fr}
  .shareChoice{min-height:0}
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
      <div style="display:flex;align-items:center;gap:6px;">
        <button id="inviteBtn" class="inviteBtn">Convidar</button>
        <button id="serverSettingsBtn" class="inviteBtn" title="Configurações do servidor">⚙</button>
        <button id="deleteServerBtn" class="inviteBtn" title="Apagar servidor">🗑</button>
      </div>
    </div>

    <div class="sideScroll">
      <button id="homeBtn" class="navBtn active">◐ Início</button>
      <button id="friendsBtn" class="navBtn">👥 Amigos</button>
      <button id="rolesBtn" class="navBtn">🛡 Cargos</button>
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

    <button id="profileBtn" class="userbar" type="button" style="width:100%;border:0;color:inherit;text-align:left;cursor:pointer;">
      <div id="userAvatar" class="avatar">V</div>
      <div class="userMeta" style="flex:1;">
        <strong id="userName">Você</strong>
        <span id="userBioMini">● Online · Editar perfil</span>
      </div>
      <span style="color:var(--low);font-size:16px;">⚙</span>
    </button>
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
            <button id="homeCreateRole" class="btn secondary">🛡 Criar cargo</button>
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


      <section id="serverSettingsView" class="view hidden">
        <div class="serverSettings">

          <aside class="settingsMenu">
            <div id="settingsServerName" class="settingsServerName">Servidor</div>

            <button class="settingsNavBtn active" data-settings-page="profile">⚙ Perfil do servidor</button>

            <div class="settingsGroup">Pessoas</div>
            <button class="settingsNavBtn" data-settings-page="members">👥 Membros</button>
            <button class="settingsNavBtn" data-settings-page="roles">🛡 Cargos</button>
            <button class="settingsNavBtn" data-settings-page="invites">✉ Convites</button>

            <div class="settingsGroup">Moderação</div>
            <button class="settingsNavBtn" data-settings-page="security">🔒 Segurança</button>

            <div class="settingsGroup">Servidor</div>
            <button class="settingsNavBtn danger" data-settings-page="delete">🗑 Excluir servidor</button>
          </aside>

          <div class="settingsBody">

            <div id="settingsProfilePage" class="settingsPanel">
              <h2>Perfil do servidor</h2>
              <p>Personalize a identidade do seu servidor no e-cord.</p>

              <div class="settingsGrid">

                <div class="settingsCard">
                  <div class="settingsField">
                    <label class="settingsLabel" for="serverSettingsName">Nome do servidor</label>
                    <input id="serverSettingsName" maxlength="30" placeholder="Nome do servidor">
                  </div>

                  <div class="settingsField">
                    <label class="settingsLabel">Ícone</label>
                    <div style="display:flex;align-items:center;gap:16px;">
                      <div id="serverSettingsIconPreview" class="serverIconPreview">e</div>
                      <div style="flex:1;">
                        <input id="serverSettingsIconInput" type="file" accept="image/*">
                        <button id="serverSettingsRemoveIcon" class="btn secondary small" type="button" style="margin-top:8px;">Remover ícone</button>
                      </div>
                    </div>
                  </div>

                  <div class="settingsField">
                    <label class="settingsLabel">Faixa / cor do servidor</label>
                    <div id="serverAccentChoices" class="accentChoices">
                      <button class="accentChoice" data-accent="#ff6b4a" style="background:#ff6b4a"></button>
                      <button class="accentChoice" data-accent="#41d99a" style="background:#41d99a"></button>
                      <button class="accentChoice" data-accent="#b56cff" style="background:#b56cff"></button>
                      <button class="accentChoice" data-accent="#3ea6ff" style="background:#3ea6ff"></button>
                      <button class="accentChoice" data-accent="#ffd84a" style="background:#ffd84a"></button>
                      <button class="accentChoice" data-accent="#ff4f81" style="background:#ff4f81"></button>
                      <button class="accentChoice" data-accent="#31d7d0" style="background:#31d7d0"></button>
                      <button class="accentChoice" data-accent="#ff9c42" style="background:#ff9c42"></button>
                      <button class="accentChoice" data-accent="#74d14c" style="background:#74d14c"></button>
                      <button class="accentChoice" data-accent="#7b8794" style="background:#7b8794"></button>
                    </div>
                  </div>

                  <div class="settingsField">
                    <label class="settingsLabel" for="serverSettingsDescription">Descrição</label>
                    <textarea id="serverSettingsDescription" maxlength="240" placeholder="Conte para as pessoas sobre o seu servidor..." style="width:100%;min-height:110px;resize:vertical;border:1px solid var(--line);background:var(--bg2);color:var(--text);border-radius:10px;padding:12px;outline:none;"></textarea>
                  </div>

                  <div class="settingsField">
                    <label class="settingsLabel" for="serverSettingsTags">Características</label>
                    <input id="serverSettingsTags" maxlength="120" placeholder="Ex.: Jogos, Amigos, Comunidade">
                    <div style="font-size:11px;color:var(--low);margin-top:6px;">Separe por vírgulas. Máximo de 5.</div>
                  </div>

                  <button id="saveServerSettingsBtn" class="btn primary">Salvar alterações</button>
                </div>

                <div>
                  <div style="color:var(--low);font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;">Prévia</div>
                  <div class="serverPreview">
                    <div id="serverPreviewBanner" class="serverPreviewBanner"></div>
                    <div class="serverPreviewInner">
                      <div id="serverPreviewIcon" class="serverPreviewIcon">e</div>
                      <div id="serverPreviewName" class="serverPreviewName">Servidor</div>
                      <div id="serverPreviewDescription" class="serverPreviewDescription">Seu servidor no e-cord.</div>
                      <div id="serverPreviewTags" class="serverTags"></div>
                    </div>
                  </div>
                </div>

              </div>
            </div>

            <div id="settingsMembersPage" class="settingsPanel hidden">
              <h2>Membros</h2>
              <p>Pessoas que estão online no e-cord agora.</p>
              <div id="settingsMembersList"></div>
            </div>

            <div id="settingsRolesPage" class="settingsPanel hidden">
              <h2>Cargos</h2>
              <p>Gerencie os cargos já existentes do servidor.</p>
              <button id="settingsOpenRolesBtn" class="btn primary">Abrir gerenciamento de cargos</button>
            </div>

            <div id="settingsInvitesPage" class="settingsPanel hidden">
              <h2>Convites</h2>
              <p>Envie um link para seus amigos entrarem neste servidor.</p>
              <div class="settingsCard">
                <button id="settingsCopyInviteBtn" class="btn primary">Copiar convite do servidor</button>
              </div>
            </div>

            <div id="settingsSecurityPage" class="settingsPanel hidden">
              <h2>Segurança</h2>
              <p>Ferramentas básicas de controle do seu servidor.</p>
              <div class="settingsCard">
                <strong>Proteção do e-cord</strong>
                <p style="color:var(--muted);font-size:13px;line-height:1.55;margin-bottom:0;">
                  Somente pessoas com o link do convite conseguem abrir este servidor.
                  Mais permissões por cargo poderão ser adicionadas depois.
                </p>
              </div>
            </div>

            <div id="settingsDeletePage" class="settingsPanel hidden">
              <h2>Excluir servidor</h2>
              <p>Essa ação remove o servidor e seus canais do e-cord.</p>
              <div class="settingsDangerBox">
                <strong style="color:#ff9696;">Zona de perigo</strong>
                <p style="color:var(--muted);font-size:13px;line-height:1.5;">
                  Depois de excluir, não será possível recuperar pelo aplicativo.
                </p>
                <button id="settingsDeleteServerBtn" class="btn danger">Excluir servidor</button>
              </div>
            </div>

          </div>
        </div>
      </section>

      <section id="rolesView" class="view hidden">
        <div style="height:100%;display:grid;grid-template-rows:auto 1fr;">
          <div style="padding:14px 18px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:10px;">
            <div>
              <strong>🛡 Cargos do servidor</strong>
              <div style="font-size:12px;color:var(--muted);margin-top:3px;">Crie cargos, escolha a cor e atribua aos membros.</div>
            </div>
            <button id="addRoleBtn" class="btn primary small">+ Criar cargo</button>
          </div>
          <div style="overflow:auto;padding:18px;">
            <div id="rolesList" style="display:grid;gap:10px;"></div>
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
          <button id="audioGateBtn" class="control audioGate hidden">🔊 Ativar áudio</button>
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

<div id="sharePickerWrap" class="sharePickerWrap hidden">
  <div class="sharePicker">
    <div class="sharePickerHead">
      <div class="sharePickerBrand">
        <div class="sharePickerLogo">e</div>
        <div>
          <h2>Compartilhar no e-cord</h2>
          <p>Escolha o tipo de conteúdo. Depois o Chrome abrirá a janela segura para você confirmar.</p>
        </div>
      </div>
      <button id="sharePickerClose" class="sharePickerClose" type="button">×</button>
    </div>

    <div class="shareChoices">
      <button class="shareChoice" data-share-kind="monitor" type="button">
        <div class="shareChoiceIcon">🖥</div>
        <strong>Tela inteira</strong>
        <span>Mostre tudo o que aparece em um monitor.</span>
      </button>

      <button class="shareChoice" data-share-kind="window" type="button">
        <div class="shareChoiceIcon">▣</div>
        <strong>Uma janela</strong>
        <span>Compartilhe somente um programa aberto.</span>
      </button>

      <button class="shareChoice" data-share-kind="browser" type="button">
        <div class="shareChoiceIcon">▤</div>
        <strong>Aba do navegador</strong>
        <span>Ideal para sites, vídeos e apresentações.</span>
      </button>
    </div>

    <div class="sharePickerFoot">
      O seletor final de tela, janela ou aba é uma área de segurança do navegador e não pode receber o tema do e-cord.
    </div>
  </div>
</div>

<div id="modalWrap" class="modalWrap hidden">
  <div class="modal">
    <h2 id="modalTitle">Criar</h2>
    <p id="modalText"></p>
    <input id="modalInput" maxlength="30">

    <div id="roleColorWrap" class="hidden" style="margin-top:14px;">
      <label for="roleColor" style="display:block;color:var(--low);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;margin-bottom:7px;">Cor do cargo</label>
      <div style="display:flex;align-items:center;gap:10px;background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:10px 12px;">
        <input id="roleColor" type="color" value="#ff6b4a" style="width:48px;height:38px;padding:2px;border:0;background:transparent;cursor:pointer;">
        <span id="roleColorText" style="color:var(--muted);font-size:12px;">#ff6b4a</span>
      </div>
    </div>

    <div class="modalActions">
      <button id="modalCancel" class="btn secondary">Cancelar</button>
      <button id="modalOk" class="btn primary">Criar</button>
    </div>
  </div>
</div>

<div id="profileModalWrap" class="modalWrap hidden">
  <div class="modal">
    <h2>Meu perfil</h2>
    <p>Troque sua foto, seu nome e escreva uma bio curta.</p>

    <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px;">
      <div id="profileAvatarPreview" class="avatar" style="width:74px;height:74px;border-radius:24px;font-size:24px;background-size:cover;background-position:center;">V</div>
      <div style="flex:1;">
        <label for="profilePhotoInput" style="display:block;color:var(--low);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;margin-bottom:7px;">Foto</label>
        <input id="profilePhotoInput" type="file" accept="image/*">
        <button id="removeProfilePhotoBtn" class="btn secondary small" type="button" style="margin-top:7px;">Remover foto</button>
      </div>
    </div>

    <label for="profileNameInput" style="display:block;color:var(--low);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;margin-bottom:7px;">Nome</label>
    <input id="profileNameInput" maxlength="30" placeholder="Seu nome">

    <label for="profileBioInput" style="display:block;color:var(--low);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;margin:14px 0 7px;">Bio</label>
    <textarea id="profileBioInput" maxlength="160" placeholder="Ex.: Jogando com a galera..." style="width:100%;min-height:88px;resize:vertical;border:1px solid var(--line);background:var(--bg2);color:var(--text);border-radius:10px;padding:12px;outline:none;"></textarea>

    <div class="modalActions">
      <button id="profileCancelBtn" class="btn secondary">Cancelar</button>
      <button id="profileSaveBtn" class="btn primary">Salvar perfil</button>
    </div>
  </div>
</div>

<div id="incomingCallWrap" class="modalWrap hidden">
  <div class="modal">
    <div style="width:56px;height:56px;border-radius:18px;background:var(--mintbg);color:var(--mint);display:grid;place-items:center;font-size:23px;margin-bottom:16px;">☎</div>
    <h2>Chamada privada</h2>
    <p><strong id="incomingCallerName" style="color:var(--text);">Um amigo</strong> está te ligando.</p>
    <div class="modalActions">
      <button id="declineCallBtn" class="btn danger">Recusar</button>
      <button id="acceptCallBtn" class="btn primary">Aceitar</button>
    </div>
  </div>
</div>

<div id="toast" class="toast hidden"></div>

<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io({reconnection:true});

const $ = (s) => document.querySelector(s);

function getOrCreateUserId(){
  let value = localStorage.getItem('ecord-user-id');

  if(!value){
    value = (crypto?.randomUUID ? crypto.randomUUID() : ('u-' + Date.now() + '-' + Math.random().toString(36).slice(2)));
    localStorage.setItem('ecord-user-id', value);
  }

  return value;
}

const state = {
  userId: getOrCreateUserId(),
  username: localStorage.getItem('ecord-name') || '',
  bio: localStorage.getItem('ecord-bio') || '',
  avatar: localStorage.getItem('ecord-avatar') || '',
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
  selectedRoleId: null,
  onlineUsers: [],
  lastVoiceMembers: [],
  inviteApplied: false,
  restoreAttempted: false,
  privateCallId: null,
  privatePeerName: null,
  incomingCall: null,
  pendingAvatar: null,
  serverSettingsIcon: null,
  serverSettingsAccent: '#ff6b4a'
};

const rtcConfig = {
  iceServers: [
    {urls:'stun:stun.l.google.com:19302'},
    {urls:'stun:stun1.l.google.com:19302'},
    {urls:'stun:stun.cloudflare.com:3478'}
  ],
  iceCandidatePoolSize: 10
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

function refreshOwnProfileUI(){
  $('#userName').textContent = state.username || 'Você';
  $('#userBioMini').textContent = state.bio
    ? state.bio.slice(0,34)
    : '● Online · Editar perfil';

  applyAvatar(
    $('#userAvatar'),
    {username:state.username,avatar:state.avatar},
    state.username
  );

  if($('#welcomeTitle')){
    $('#welcomeTitle').textContent = 'Bem-vindo, ' + (state.username || 'você');
  }
}

function openProfileModal(){
  state.pendingAvatar = state.avatar || '';
  $('#profileNameInput').value = state.username || '';
  $('#profileBioInput').value = state.bio || '';
  $('#profilePhotoInput').value = '';

  applyAvatar(
    $('#profileAvatarPreview'),
    {username:state.username,avatar:state.pendingAvatar},
    state.username
  );

  $('#profileModalWrap').classList.remove('hidden');
}

function closeProfileModal(){
  $('#profileModalWrap').classList.add('hidden');
  state.pendingAvatar = null;
}

function fileToAvatar(file){
  return new Promise((resolve,reject)=>{
    if(!file){
      resolve('');
      return;
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
  const username = $('#profileNameInput').value.trim().slice(0,30);
  const bio = $('#profileBioInput').value.trim().slice(0,160);

  if(!username){
    toast('Digite um nome');
    return;
  }

  socket.emit('set-profile',{
    userId:state.userId,
    username,
    bio,
    avatar:String(state.pendingAvatar || '').slice(0,350000)
  });
}

function safeServerSnapshot(serverData){
  if(!serverData?.id) return null;

  return {
    id:String(serverData.id),
    name:String(serverData.name || 'Servidor').slice(0,30),
    icon:String(serverData.icon || '').slice(0,350000),
    accent:/^#[0-9a-f]{6}$/i.test(String(serverData.accent||'')) ? String(serverData.accent) : '#ff6b4a',
    description:String(serverData.description || '').slice(0,240),
    tags:Array.isArray(serverData.tags)
      ? serverData.tags.map(tag=>String(tag||'').slice(0,22)).filter(Boolean).slice(0,5)
      : [],
    textChannels:Array.isArray(serverData.textChannels)
      ? serverData.textChannels.map(c=>({id:String(c.id),name:String(c.name||'chat').slice(0,30)}))
      : [],
    voiceChannels:Array.isArray(serverData.voiceChannels)
      ? serverData.voiceChannels.map(c=>({id:String(c.id),name:String(c.name||'Voz').slice(0,30)}))
      : [],
    roles:Array.isArray(serverData.roles)
      ? serverData.roles.map(role=>({
          id:String(role.id),
          name:String(role.name||'Cargo').slice(0,30),
          color:/^#[0-9a-f]{6}$/i.test(String(role.color||'')) ? String(role.color) : '#ff6b4a',
          members:Array.isArray(role.members)
            ? role.members.map(name=>String(name||'').slice(0,30)).filter(Boolean).slice(0,100)
            : []
        }))
      : []
  };
}

function getCachedServers(){
  try{
    const parsed = JSON.parse(localStorage.getItem('ecord-server-cache') || '[]');
    return Array.isArray(parsed) ? parsed.map(safeServerSnapshot).filter(Boolean) : [];
  }catch{
    return [];
  }
}

function cacheServers(list){
  try{
    const safe = (Array.isArray(list) ? list : [])
      .map(safeServerSnapshot)
      .filter(Boolean);
    localStorage.setItem('ecord-server-cache', JSON.stringify(safe));
  }catch{}
}

function encodeInviteServer(serverData){
  try{
    const json = JSON.stringify(safeServerSnapshot(serverData));
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for(const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }catch{
    return '';
  }
}

function decodeInviteServer(value){
  try{
    if(!value) return null;
    let base = value.replace(/-/g,'+').replace(/_/g,'/');
    while(base.length % 4) base += '=';
    const binary = atob(base);
    const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
    return safeServerSnapshot(JSON.parse(new TextDecoder().decode(bytes)));
  }catch{
    return null;
  }
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
  $('#rolesView').classList.toggle('hidden', name!=='roles');
  $('#serverSettingsView').classList.toggle('hidden', name!=='settings');
  $('#chatView').classList.toggle('hidden', name!=='chat');
  $('#voiceView').classList.toggle('hidden', name!=='voice');
  $('#homeBtn').classList.toggle('active', name==='home');
  $('#friendsBtn').classList.toggle('active', name==='friends');
  $('#rolesBtn').classList.toggle('active', name==='roles');
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
  if(name==='roles'){
    $('#topTitle').textContent = '🛡 Cargos';
    $('#topSub').textContent = currentServer()?.name || '';
    renderRoles();
  }
  if(name==='settings'){
    $('#topTitle').textContent = '⚙ Configurações do servidor';
    $('#topSub').textContent = currentServer()?.name || '';
    openServerSettings();
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

function renderSidebar(){
  const s = currentServer();

  if(!s){
    $('#serverTitle').textContent = 'Nenhum servidor';
    $('#textChannels').innerHTML = '';
    $('#voiceChannels').innerHTML = '';
    $('#inviteBtn').disabled = true;
    $('#serverSettingsBtn').disabled = true;
    $('#deleteServerBtn').disabled = true;
    return;
  }

  $('#inviteBtn').disabled = false;
  $('#serverSettingsBtn').disabled = false;
  $('#deleteServerBtn').disabled = false;
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
    description || 'Seu servidor no e-cord.';

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

  const users = Array.isArray(state.onlineUsers) ? state.onlineUsers : [];

  if(!users.length){
    const empty = document.createElement('div');
    empty.className = 'settingsCard';
    empty.style.color = 'var(--low)';
    empty.textContent = 'Nenhum usuário online agora.';
    box.appendChild(empty);
    return;
  }

  users.forEach(user=>{
    const row = document.createElement('div');
    row.className = 'settingsMember';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    applyAvatar(avatar,user,user.username);

    const meta = document.createElement('div');
    meta.style.flex = '1';

    const name = document.createElement('strong');
    name.textContent = user.username || 'Usuário';

    const status = document.createElement('div');
    status.style.cssText = 'font-size:11px;color:var(--mint);margin-top:2px;';
    status.textContent = '● Online';

    meta.append(name,status);
    row.append(avatar,meta);
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
          id:friend.id ? String(friend.id) : null,
          username:String(friend.username).slice(0,30),
          bio:String(friend.bio || '').slice(0,160),
          avatar:String(friend.avatar || '').slice(0,350000)
        };
      })
      .filter(Boolean);
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

  socket.emit('friend-lookup',{
    userId:state.userId,
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
  const friends = getFriends().filter(item => {
    if(friend?.id && item.id) return item.id !== friend.id;
    return String(item.username || '').toLowerCase() !== String(friend?.username || '').toLowerCase();
  });

  saveFriends(friends);
  renderFriends();
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

function renderFriends(){
  const box = $('#friendsList');
  if(!box) return;

  const friends = getFriends();
  box.innerHTML = '';

  if(!friends.length){
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:20px;background:var(--bg2);border:1px dashed var(--line);border-radius:14px;color:var(--low);font-size:13px;';
    empty.textContent = 'Você ainda não adicionou nenhum amigo.';
    box.appendChild(empty);
    return;
  }

  friends.forEach(friend => {
    const live = state.onlineUsers.find(user =>
      (friend.id && user.id === friend.id) ||
      String(user.username || '').toLowerCase() === String(friend.username || '').toLowerCase()
    );

    const profile = live || friend;
    const online = !!live;

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg2);border:1px solid var(--line);border-radius:14px;';

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
      'display:block;font-size:12px;margin-top:3px;color:' +
      (online ? 'var(--mint)' : 'var(--low)') + ';';

    meta.append(strong,status);

    if(profile.bio){
      const bio = document.createElement('span');
      bio.textContent = profile.bio;
      bio.style.cssText = 'display:block;font-size:11px;color:var(--low);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      meta.appendChild(bio);
    }

    const call = document.createElement('button');
    call.className = 'btn primary small';
    call.textContent = '☎ Ligar';
    call.disabled = !online;
    call.style.opacity = online ? '1' : '.45';
    call.addEventListener('click',()=>callFriend(profile));

    const remove = document.createElement('button');
    remove.className = 'btn secondary small';
    remove.textContent = 'Remover';
    remove.addEventListener('click',()=>removeFriend(friend));

    row.append(avatar,meta,call,remove);
    box.appendChild(row);
  });
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

    meta.append(name, members);

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
    remove.addEventListener('click', ()=>{
      if(confirm('Excluir o cargo "' + role.name + '"?')){
        socket.emit('remove-role',{
          serverId:state.serverId,
          roleId:role.id
        });
      }
    });

    row.append(color, meta, assign, remove);
    box.appendChild(row);
  });
}

function openModal(type){
  state.modalAction = type;
  const cfg = {
    server:['Criar servidor','Digite o nome do novo servidor.','Ex.: Meus amigos'],
    text:['Criar chat','Digite o nome do novo canal de texto.','Ex.: memes'],
    voice:['Criar canal de voz','Digite o nome do novo canal de voz.','Ex.: Jogos'],
    friend:['Adicionar amigo','Digite exatamente o nome do seu amigo no e-cord.','Ex.: Davi'],
    role:['Criar cargo','Escolha um nome e uma cor para o cargo.','Ex.: Moderador'],
    assignRole:['Atribuir cargo','Digite exatamente o nome da pessoa que receberá o cargo.','Ex.: Davi']
  }[type];

  $('#modalTitle').textContent = cfg[0];
  $('#modalText').textContent = cfg[1];
  $('#modalInput').placeholder = cfg[2];
  $('#modalInput').value = '';

  $('#roleColorWrap').classList.toggle('hidden', type !== 'role');

  if(type === 'role'){
    $('#roleColor').value = '#ff6b4a';
    $('#roleColorText').textContent = '#ff6b4a';
  }

  $('#modalOk').textContent =
    type === 'assignRole' ? 'Atribuir' :
    type === 'role' ? 'Criar cargo' :
    'Criar';

  $('#modalWrap').classList.remove('hidden');
  setTimeout(()=>$('#modalInput').focus(),0);
}

function closeModal(){
  $('#modalWrap').classList.add('hidden');
  state.modalAction = null;
  $('#roleColorWrap').classList.add('hidden');
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
  } else if(state.modalAction==='friend'){
    addFriendByName(value);
  } else if(state.modalAction==='role'){
    socket.emit('create-role',{
      serverId:state.serverId,
      name:value,
      color:$('#roleColor').value
    });
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

function deleteCurrentServer(){
  const server = currentServer();

  if(!server){
    toast('Nenhum servidor selecionado');
    return;
  }

  if(!confirm('Apagar o servidor "' + server.name + '"? Esta ação não pode ser desfeita.')){
    return;
  }

  socket.emit('delete-server',{serverId:server.id});
}

async function copyInvite(){
  if(!state.serverId) return;
  const url = new URL(location.href);
  url.searchParams.set('server',state.serverId);

  const snapshot = encodeInviteServer(currentServer());
  if(snapshot) url.searchParams.set('s',snapshot);

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
  }

  const stream =
    sourceStream && sourceStream.getAudioTracks?.().length
      ? sourceStream
      : new MediaStream([track]);

  if(audio.srcObject !== stream){
    audio.srcObject = stream;
  }

  audio.muted = false;
  audio.volume = 1;

  const tryPlay = async () => {
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

  for(const audio of state.remoteAudio.values()){
    audio.muted = false;
    audio.volume = 1;

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
      if(!state.screenTrack) $('#voiceStatus').textContent = 'Conectado';
      unlockAllRemoteAudio();
    }else if(connection === 'connecting' || ice === 'checking'){
      $('#voiceStatus').textContent = 'Conectando mídia...';
    }else if(connection === 'failed' || ice === 'failed'){
      $('#voiceStatus').textContent = 'Falha na conexão de mídia';
      toast('A conexão de voz/vídeo falhou nesta rede.');
      try{ pc.restartIce(); }catch{}
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
  const pc = createPeer(peerId, username, true);

  await attachLocalTracks(pc);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.emit('offer',{
    target:peerId,
    sdp:pc.localDescription
  });
}


async function enterPrivateCall(callId,peerName){
  try{
    await ensureMic();

    if(state.joinedVoiceId){
      socket.emit('leave-voice');
      closePeers();
    }

    state.privateCallId = callId;
    state.privatePeerName = peerName || 'Amigo';
    state.joinedVoiceId = 'private:' + callId;

    setView('voice');

    $('#voiceTitle').textContent = 'Chamada com ' + state.privatePeerName;
    $('#topTitle').textContent = '☎ Chamada privada';
    $('#topSub').textContent = state.privatePeerName;
    $('#voiceStatus').textContent = 'Conectando...';

    $('#voiceControls').classList.remove('hidden');
    $('#joinVoiceBtn').classList.add('hidden');

    ensureCard('local',state.username+' (você)',state.localStream,true);

    socket.emit('join-private-call',{
      callId,
      username:state.username,
      userId:state.userId
    });
  }catch(error){
    console.error(error);
    toast('Permita o microfone para entrar na chamada');
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

async function joinVoice(){
  const channel = currentVoice();
  if(!channel) return;

  state.privateCallId = null;
  state.privatePeerName = null;

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
  const wasPrivate = !!state.privateCallId;

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
  state.privateCallId = null;
  state.privatePeerName = null;
  $('#voiceControls').classList.add('hidden');
  $('#audioGateBtn').classList.add('hidden');
  $('#joinVoiceBtn').classList.remove('hidden');
  $('#voiceStatus').textContent = 'Fora da chamada';
  $('#cameraBtn').textContent = '📷 Ligar câmera';
  $('#cameraBtn').classList.add('off');
  $('#screenBtn').textContent = '🖥️ Compartilhar tela';
  $('#screenBtn').classList.remove('sharing');

  if(wasPrivate){
    setView('friends');
  }
}

function toggleMic(){
  const t = state.localStream?.getAudioTracks()[0];
  if(!t) return;
  t.enabled = !t.enabled;
  $('#micBtn').textContent = t.enabled ? '🎤 Microfone' : '🔇 Microfone';
  $('#micBtn').classList.toggle('off',!t.enabled);
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

async function toggleCamera(){
  if(!state.joinedVoiceId) return;

  if(state.cameraTrack && state.cameraTrack.readyState==='live'){
    state.cameraTrack.enabled = !state.cameraTrack.enabled;

    if(!state.screenTrack){
      await replaceVideoForAll(state.cameraTrack.enabled ? state.cameraTrack : null);
    }

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

    await replaceVideoForAll(state.cameraTrack);

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

  const replacement =
    state.cameraTrack &&
    state.cameraTrack.readyState === 'live' &&
    state.cameraTrack.enabled
      ? state.cameraTrack
      : null;

  await replaceVideoForAll(replacement);

  ensureCard('local',state.username+' (você)',state.localStream,true);
  $('#screenBtn').textContent = '🖥️ Compartilhar tela';
  $('#screenBtn').classList.remove('sharing');
  $('#cameraBtn').disabled = false;
  if(state.joinedVoiceId) $('#voiceStatus').textContent = 'Conectado';
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

  $('#sharePickerWrap').classList.remove('hidden');
}

function closeSharePicker(){
  $('#sharePickerWrap').classList.add('hidden');
}

async function startScreenShare(displaySurface){
  closeSharePicker();

  try{
    const videoOptions = {
      frameRate:{ideal:30,max:60}
    };

    if(displaySurface){
      videoOptions.displaySurface = displaySurface;
    }

    state.screenStream = await navigator.mediaDevices.getDisplayMedia({
      video:videoOptions,
      audio:false,
      selfBrowserSurface:'exclude',
      surfaceSwitching:'include'
    });

    state.screenTrack = state.screenStream.getVideoTracks()[0];

    if(!state.screenTrack){
      throw new Error('Nenhuma faixa de tela foi selecionada.');
    }

    try{
      state.screenTrack.contentHint = 'detail';
    }catch{}

    await replaceVideoForAll(state.screenTrack);

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
    $('#voiceStatus').textContent = 'Compartilhando tela';

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
      toast('Não foi possível iniciar o compartilhamento.');
    }
  }
}

async function toggleScreen(){
  openSharePicker();
}

function renderMembers(list){
  state.lastVoiceMembers = Array.isArray(list) ? list : [];
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
    const info=document.createElement('div');
    info.style.minWidth='0';

    const name=document.createElement('span');
    name.textContent=u.username;
    name.style.display='block';

    const roles = roleNamesForUser(u.username);

    if(roles.length){
      const badges=document.createElement('div');
      badges.style.cssText='display:flex;gap:4px;flex-wrap:wrap;margin-top:3px;';

      roles.slice(0,3).forEach(role=>{
        const badge=document.createElement('span');
        badge.textContent=role.name;
        badge.style.cssText =
          'font-size:9px;font-weight:800;padding:2px 5px;border-radius:999px;color:' +
          role.color + ';background:' + role.color + '18;border:1px solid ' + role.color + '44;';
        badges.appendChild(badge);
      });

      info.append(name,badges);
    }else{
      info.appendChild(name);
    }

    row.append(dot,info);
    box.appendChild(row);
  });
}

$('#loginBtn').addEventListener('click',()=>{
  const name = $('#loginName').value.trim().slice(0,30);
  if(!name) return;
  state.username = name;
  localStorage.setItem('ecord-name',name);
  refreshOwnProfileUI();
  $('#login').classList.add('hidden');

  socket.emit('set-profile',{
    userId:state.userId,
    username:state.username,
    bio:state.bio,
    avatar:state.avatar
  });
});

$('#loginName').addEventListener('keydown',e=>{if(e.key==='Enter') $('#loginBtn').click()});
if(state.username){
  $('#loginName').value=state.username;
  refreshOwnProfileUI();
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

$('#profileBtn').addEventListener('click',openProfileModal);
$('#profileCancelBtn').addEventListener('click',closeProfileModal);
$('#profileSaveBtn').addEventListener('click',saveProfile);
$('#removeProfilePhotoBtn').addEventListener('click',()=>{
  state.pendingAvatar = '';
  applyAvatar(
    $('#profileAvatarPreview'),
    {username:$('#profileNameInput').value || state.username,avatar:''},
    $('#profileNameInput').value || state.username
  );
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
  const call = state.incomingCall;
  if(!call) return;

  closeIncomingCall();

  socket.emit('private-call-response',{
    callId:call.callId,
    callerSocketId:call.callerSocketId,
    accept:true
  });

  enterPrivateCall(call.callId,call.fromUsername);
  state.incomingCall = null;
});

$('#declineCallBtn').addEventListener('click',()=>{
  const call = state.incomingCall;
  if(!call) return;

  socket.emit('private-call-response',{
    callId:call.callId,
    callerSocketId:call.callerSocketId,
    accept:false
  });

  state.incomingCall = null;
  closeIncomingCall();
});

$('#homeBtn').addEventListener('click',()=>setView('home'));
$('#friendsBtn').addEventListener('click',()=>setView('friends'));
$('#rolesBtn').addEventListener('click',()=>setView('roles'));
$('#addFriendBtn').addEventListener('click',()=>openModal('friend'));
$('#addRoleBtn').addEventListener('click',()=>openModal('role'));
$('#homeCreateRole').addEventListener('click',()=>openModal('role'));
$('#roleColor').addEventListener('input',()=>{$('#roleColorText').textContent=$('#roleColor').value;});
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
$('#audioGateBtn').addEventListener('click',async()=>{
  await unlockAllRemoteAudio();
  $('#audioGateBtn').classList.add('hidden');
});
$('#cameraBtn').addEventListener('click',toggleCamera);
$('#screenBtn').addEventListener('click',toggleScreen);

$('#sharePickerClose').addEventListener('click',closeSharePicker);
$('#sharePickerWrap').addEventListener('click',event=>{
  if(event.target === $('#sharePickerWrap')) closeSharePicker();
});
document.querySelectorAll('[data-share-kind]').forEach(button=>{
  button.addEventListener('click',()=>{
    startScreenShare(button.dataset.shareKind);
  });
});

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

socket.on('profile-saved',profile=>{
  if(!profile) return;

  state.userId = profile.id || state.userId;
  state.username = profile.username || state.username;
  state.bio = profile.bio || '';
  state.avatar = profile.avatar || '';

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
  toast('Perfil salvo');
});

socket.on('friend-lookup-result',result=>{
  if(!result?.ok){
    toast(result?.error || 'Essa pessoa não existe no e-cord');
    return;
  }

  addResolvedFriend(result.profile);
});

socket.on('incoming-private-call',data=>{
  showIncomingCall(data);
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

socket.on('server-list',list=>{
  const incoming = Array.isArray(list) ? list : [];

  if(!incoming.length && !state.restoreAttempted){
    const cached = getCachedServers();

    state.restoreAttempted = true;

    if(cached.length){
      socket.emit('restore-servers',{servers:cached});
      return;
    }
  }

  if(incoming.length){
    state.restoreAttempted = true;
  }

  state.servers = incoming;
  cacheServers(state.servers);

  const params = new URLSearchParams(location.search);
  const requested = params.get('server');

  if(!state.servers.length){
    state.serverId = null;
    state.textChannelId = null;
    state.voiceChannelId = null;

    renderServers();
    renderSidebar();
    renderRoles();
    setView('home');

    $('#topTitle').textContent = 'e-cord';
    $('#topSub').textContent = 'Crie seu primeiro servidor';
    return;
  }

  if(
    requested &&
    !state.inviteApplied &&
    state.servers.some(server=>server.id===requested)
  ){
    state.inviteApplied = true;
    selectServer(requested);
    return;
  }

  if(!state.serverId){
    const chosen = state.servers.find(server=>server.id===requested) || state.servers[0];
    if(chosen) selectServer(chosen.id);
    return;
  }

  const still = state.servers.find(server=>server.id===state.serverId);

  if(!still){
    selectServer(state.servers[0].id);
    return;
  }

  renderServers();
  renderSidebar();
  renderRoles();
});

socket.on('server-settings-updated',({serverId,message})=>{
  renderServers();
  renderSidebar();

  if(state.serverId===serverId && !$('#serverSettingsView').classList.contains('hidden')){
    openServerSettings();
  }

  toast(message || 'Servidor atualizado');
});

socket.on('server-deleted',({serverId})=>{
  if(state.serverId===serverId){
    state.serverId = null;
    state.textChannelId = null;
    state.voiceChannelId = null;
  }

  toast('Servidor apagado');
});

socket.on('server-created',({serverId})=>{
  selectServer(serverId);
  toast('Servidor criado');
});

socket.on('role-updated',({message})=>{
  renderRoles();
  renderMembers(state.lastVoiceMembers || []);
  toast(message || 'Cargos atualizados');
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
  const params = new URLSearchParams(location.search);
  const invitedServer = decodeInviteServer(params.get('s'));

  if(invitedServer){
    socket.emit('restore-servers',{servers:[invitedServer]});
  }

  socket.emit('get-servers');

  if(state.username){
    socket.emit('set-profile',{
      userId:state.userId,
      username:state.username,
      bio:state.bio,
      avatar:state.avatar
    });
  }

  if(state.joinedVoiceId){
    closePeers();

    if(state.privateCallId){
      socket.emit('join-private-call',{
        callId:state.privateCallId,
        username:state.username,
        userId:state.userId
      });
    }else if(state.serverId && state.voiceChannelId){
      socket.emit('join-voice',{
        serverId:state.serverId,
        channelId:state.voiceChannelId,
        username:state.username
      });
    }
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

  socket.on('set-profile', ({ userId, username, bio, avatar }) => {
    const safeId = String(userId || '').trim().slice(0, 100);
    if (!safeId) return;

    const oldProfile = profiles.get(safeId);
    const oldName = oldProfile?.username || null;

    const profile = {
      id: safeId,
      username: cleanName(username, oldProfile?.username || 'Usuário'),
      bio: String(bio || '').trim().slice(0, 160),
      avatar: String(avatar || '').slice(0, 350000)
    };

    profiles.set(safeId, profile);

    if (oldName && oldName.toLowerCase() !== profile.username.toLowerCase()) {
      for (const serverData of servers.values()) {
        for (const role of serverData.roles || []) {
          role.members = (role.members || []).map(member =>
            String(member).toLowerCase() === oldName.toLowerCase()
              ? profile.username
              : member
          );
        }
      }
    }

    socket.data.userId = safeId;
    socket.data.username = profile.username;

    saveServersToDisk();
    socket.emit('profile-saved', publicProfile(profile));
    io.emit('server-list', publicServers());
    broadcastOnlineUsers();
  });

  socket.on('friend-lookup', ({ userId, username }) => {
    const profile = findProfileByUsername(username);

    if (!profile) {
      socket.emit('friend-lookup-result', {
        ok: false,
        error: 'Essa pessoa não existe no e-cord'
      });
      return;
    }

    if (String(profile.id) === String(userId || '')) {
      socket.emit('friend-lookup-result', {
        ok: false,
        error: 'Você não pode adicionar você mesmo'
      });
      return;
    }

    socket.emit('friend-lookup-result', {
      ok: true,
      profile: publicProfile(profile)
    });
  });

  socket.on('get-servers', () => {
    socket.emit('server-list', publicServers());
  });

  socket.on('restore-servers', ({ servers: restored }) => {
    if (!Array.isArray(restored)) return;

    for (const item of restored.slice(0, 100)) {
      mergeRestoredServer(item);
    }

    saveServersToDisk();
    io.emit('server-list', publicServers());
  });

  socket.on('create-server', ({ name }) => {
    const created = makeServer(cleanName(name, 'Novo servidor'));
    saveServersToDisk();
    io.emit('server-list', publicServers());
    socket.emit('server-created', { serverId: created.id });
  });

  socket.on('update-server-settings', ({ serverId, name, icon, accent, description, tags }) => {
    const safeId = String(serverId || '').slice(0,80);
    const serverData = servers.get(safeId);

    if (!serverData) return;

    serverData.name = cleanName(name, serverData.name || 'Servidor');
    serverData.icon = String(icon || '').slice(0,350000);
    serverData.accent = /^#[0-9a-f]{6}$/i.test(String(accent || ''))
      ? String(accent)
      : (serverData.accent || '#ff6b4a');
    serverData.description = String(description || '').trim().slice(0,240);
    serverData.tags = Array.isArray(tags)
      ? tags.map(tag => String(tag || '').trim().slice(0,22)).filter(Boolean).slice(0,5)
      : [];

    saveServersToDisk();
    io.emit('server-list', publicServers());

    socket.emit('server-settings-updated',{
      serverId:safeId,
      message:'Configurações salvas'
    });
  });

  socket.on('delete-server', ({ serverId }) => {
    const safeId = String(serverId || '').slice(0, 80);
    if (!safeId || !servers.has(safeId)) return;

    servers.delete(safeId);
    saveServersToDisk();

    socket.emit('server-deleted', { serverId: safeId });
    io.emit('server-list', publicServers());
  });

  socket.on('create-role', ({ serverId, name, color }) => {
    const s = servers.get(serverId);
    if (!s) return;

    const safeName = cleanName(name, 'Cargo');
    const safeColor = /^#[0-9a-f]{6}$/i.test(String(color || ''))
      ? String(color)
      : '#ff6b4a';

    if (s.roles.some(role => role.name.toLowerCase() === safeName.toLowerCase())) {
      socket.emit('role-updated', { message: 'Já existe um cargo com esse nome' });
      return;
    }

    s.roles.push({
      id: id(),
      name: safeName,
      color: safeColor,
      members: []
    });

    saveServersToDisk();
    io.emit('server-list', publicServers());
    socket.emit('role-updated', { message: 'Cargo criado' });
  });

  socket.on('assign-role', ({ serverId, roleId, username }) => {
    const s = servers.get(serverId);
    if (!s) return;

    const role = s.roles.find(item => item.id === roleId);
    if (!role) return;

    const safeUsername = cleanName(username);
    const exists = role.members.some(
      member => member.toLowerCase() === safeUsername.toLowerCase()
    );

    if (!exists) {
      role.members.push(safeUsername);
      role.members = role.members.slice(0, 100);
    }

    saveServersToDisk();
    io.emit('server-list', publicServers());
    socket.emit('role-updated', { message: 'Cargo atribuído a ' + safeUsername });
  });

  socket.on('remove-role', ({ serverId, roleId }) => {
    const s = servers.get(serverId);
    if (!s) return;

    const before = s.roles.length;
    s.roles = s.roles.filter(role => role.id !== roleId);

    if (s.roles.length !== before) {
      saveServersToDisk();
      io.emit('server-list', publicServers());
      socket.emit('role-updated', { message: 'Cargo excluído' });
    }
  });

  socket.on('create-channel', ({ serverId, type, name }) => {
    const s = servers.get(serverId);
    if (!s) return;

    if (type === 'text') {
      const channel = { id: id(), name: cleanChannel(name, 'novo-chat') };
      s.textChannels.push(channel);
      s.messages.set(channel.id, []);
      saveServersToDisk();
      io.emit('server-list', publicServers());
      socket.emit('channel-created', { serverId, type: 'text', channelId: channel.id });
      return;
    }

    if (type === 'voice') {
      const channel = { id: id(), name: cleanName(name, 'Nova voz') };
      s.voiceChannels.push(channel);
      saveServersToDisk();
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
    saveServersToDisk();

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

  socket.on('private-call-invite', ({ targetUserId, targetUsername }) => {
    const target = [...io.sockets.sockets.values()].find(candidate => {
      if (candidate.id === socket.id) return false;

      if (targetUserId && candidate.data.userId) {
        return String(candidate.data.userId) === String(targetUserId);
      }

      return String(candidate.data.username || '').toLowerCase() ===
        String(targetUsername || '').toLowerCase();
    });

    if (!target) {
      socket.emit('private-call-error', {
        error: 'Esse amigo está offline'
      });
      return;
    }

    const callId = id();

    target.emit('incoming-private-call', {
      callId,
      callerSocketId: socket.id,
      fromUserId: socket.data.userId || null,
      fromUsername: socket.data.username || 'Usuário'
    });
  });

  socket.on('private-call-response', ({ callId, callerSocketId, accept }) => {
    if (!callerSocketId || !callId) return;

    if (accept) {
      io.to(callerSocketId).emit('private-call-accepted', {
        callId,
        username: socket.data.username || 'Usuário',
        userId: socket.data.userId || null
      });
    } else {
      io.to(callerSocketId).emit('private-call-declined', {
        callId,
        username: socket.data.username || 'Usuário'
      });
    }
  });

  socket.on('join-private-call', ({ callId, username, userId }) => {
    if (!callId) return;

    leaveVoiceRoom();

    const room = 'private:' + String(callId).slice(0, 100);

    const participants = [...(io.sockets.adapter.rooms.get(room) || [])]
      .map(socketId => {
        const participant = io.sockets.sockets.get(socketId);

        return participant
          ? {
              id: socketId,
              username: participant.data.username || 'Usuário'
            }
          : null;
      })
      .filter(Boolean);

    socket.data.username = cleanName(username);
    socket.data.userId = String(userId || socket.data.userId || '').slice(0,100);
    socket.data.voiceRoom = room;
    socket.data.voiceServerId = null;
    socket.data.voiceChannelId = null;

    socket.join(room);

    socket.emit('voice-participants', participants);

    socket.to(room).emit('user-joined', {
      id: socket.id,
      username: socket.data.username
    });

    const members = [...(io.sockets.adapter.rooms.get(room) || [])]
      .map(socketId => {
        const participant = io.sockets.sockets.get(socketId);

        return participant
          ? {
              id: socketId,
              username: participant.data.username || 'Usuário'
            }
          : null;
      })
      .filter(Boolean);

    io.to(room).emit('voice-members', members);
  });

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
