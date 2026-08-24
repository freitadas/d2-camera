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


function areFriends(userA,userB) {
  const a = String(userA || '');
  const b = String(userB || '');

  if (!a || !b || a === b) return false;

  return friendships.some(pair =>
    (pair.a === a && pair.b === b) ||
    (pair.a === b && pair.b === a)
  );
}

function friendStateForUser(userId) {
  const safeId = String(userId || '').slice(0,100);
  if (!safeId) {
    return { friends:[], incoming:[], outgoing:[] };
  }

  const friendIds = friendships
    .filter(pair => pair.a === safeId || pair.b === safeId)
    .map(pair => pair.a === safeId ? pair.b : pair.a);

  const friends = friendIds
    .map(friendId => publicProfile(profiles.get(friendId)))
    .filter(Boolean);

  const incoming = friendRequests
    .filter(request => request.toUserId === safeId)
    .map(request => ({
      id:request.id,
      from:publicProfile(profiles.get(request.fromUserId)),
      at:request.at
    }))
    .filter(item => item.from);

  const outgoing = friendRequests
    .filter(request => request.fromUserId === safeId)
    .map(request => ({
      id:request.id,
      to:publicProfile(profiles.get(request.toUserId)),
      at:request.at
    }))
    .filter(item => item.to);

  return { friends, incoming, outgoing };
}

function emitFriendState(userId) {
  const safeId = String(userId || '').slice(0,100);
  if (!safeId) return;

  const payload = friendStateForUser(safeId);

  for (const client of io.sockets.sockets.values()) {
    if (client.data.userId === safeId) {
      client.emit('friend-state',payload);
    }
  }
}


function publicPrivateGroup(group) {
  if (!group) return null;

  return {
    id:group.id,
    name:group.name,
    ownerId:group.ownerId,
    members:(group.members || [])
      .map(userId=>publicProfile(profiles.get(userId)))
      .filter(Boolean),
    memberCount:(group.members || []).length,
    createdAt:group.createdAt
  };
}

function groupsForUser(userId) {
  const safeId = String(userId || '').slice(0,100);
  if (!safeId) return [];

  return [...privateGroups.values()]
    .filter(group => (group.members || []).includes(safeId))
    .map(publicPrivateGroup)
    .filter(Boolean);
}

function emitGroupState(userId) {
  const safeId = String(userId || '').slice(0,100);
  if (!safeId) return;

  const groups = groupsForUser(safeId);

  for (const client of io.sockets.sockets.values()) {
    if (client.data.userId === safeId) {
      client.emit('group-state',groups);
    }
  }
}

function emitGroupStateToMembers(group) {
  if (!group) return;
  for (const userId of group.members || []) emitGroupState(userId);
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
const directMessages = [];
const friendRequests = [];
const friendships = [];
const privateGroups = new Map();

function normalizeChannelList(list, fallbackName) {
  if (!Array.isArray(list) || !list.length) {
    return [{
      id: id(),
      name: fallbackName,
      categoryId: null,
      order: 0
    }];
  }

  return list
    .filter(Boolean)
    .slice(0, 100)
    .map((channel, index) => ({
      id: String(channel.id || id()).slice(0, 80),
      name: String(channel.name || fallbackName).trim().slice(0, 30) || fallbackName,
      categoryId: channel.categoryId
        ? String(channel.categoryId).slice(0, 80)
        : null,
      order: Number.isFinite(Number(channel.order))
        ? Number(channel.order)
        : index
    }))
    .sort((a,b) => a.order - b.order);
}

function normalizeCategories(list) {
  if (!Array.isArray(list)) return [];

  return list
    .filter(Boolean)
    .slice(0, 50)
    .map((category, index) => ({
      id: String(category.id || id()).slice(0, 80),
      name: String(category.name || 'Categoria').trim().slice(0, 30) || 'Categoria',
      order: Number.isFinite(Number(category.order))
        ? Number(category.order)
        : index
    }))
    .sort((a,b) => a.order - b.order);
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

      const rawPermissions = role.permissions || {};

      return {
        id: String(role.id || id()).slice(0, 80),
        name: String(role.name || 'Cargo').trim().slice(0, 30) || 'Cargo',
        color,
        members,
        permissions: {
          administrator: !!rawPermissions.administrator,
          manageServer: !!rawPermissions.manageServer,
          manageChannels: !!rawPermissions.manageChannels,
          manageRoles: !!rawPermissions.manageRoles
        }
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
  const categories = normalizeCategories(options.categories);
  const roles = normalizeRoles(options.roles);

  const messages = new Map();
  for (const channel of textChannels) {
    const history = Array.isArray(options.messages?.[channel.id])
      ? options.messages[channel.id].slice(-100)
      : [];
    messages.set(channel.id, history);
  }

  const ownerId = String(options.ownerId || '').trim().slice(0, 100);
  const members = Array.isArray(options.members)
    ? [...new Set(options.members.map(value => String(value || '').trim().slice(0,100)).filter(Boolean))]
    : (ownerId ? [ownerId] : []);

  if (ownerId && !members.includes(ownerId)) members.unshift(ownerId);

  const data = {
    id: serverId,
    ownerId,
    members,
    inviteToken: String(options.inviteToken || crypto.randomBytes(18).toString('hex')).slice(0,100),
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
    categories,
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

function serializeFriendRequests() {
  return friendRequests.slice(-5000).map(request => ({
    id: String(request.id || '').slice(0,80),
    fromUserId: String(request.fromUserId || '').slice(0,100),
    toUserId: String(request.toUserId || '').slice(0,100),
    at: Number(request.at || Date.now())
  }));
}

function serializeFriendships() {
  return friendships.slice(0,10000).map(pair => ({
    a: String(pair.a || '').slice(0,100),
    b: String(pair.b || '').slice(0,100),
    at: Number(pair.at || Date.now())
  }));
}

function serializePrivateGroups() {
  return [...privateGroups.values()].map(group => ({
    id:String(group.id || '').slice(0,80),
    name:String(group.name || 'Grupo').slice(0,40),
    ownerId:String(group.ownerId || '').slice(0,100),
    members:Array.isArray(group.members)
      ? group.members.map(value=>String(value || '').slice(0,100)).filter(Boolean).slice(0,10)
      : [],
    createdAt:Number(group.createdAt || Date.now()),
    messages:Array.isArray(group.messages)
      ? group.messages.slice(-500).map(message=>({
          id:String(message.id || '').slice(0,80),
          userId:String(message.userId || '').slice(0,100),
          username:String(message.username || 'Usuário').slice(0,30),
          text:String(message.text || '').slice(0,1000),
          at:Number(message.at || Date.now())
        }))
      : []
  }));
}

function serializeDirectMessages() {
  return directMessages.slice(-5000).map(message => ({
    id: String(message.id || '').slice(0,80),
    fromUserId: String(message.fromUserId || '').slice(0,100),
    toUserId: String(message.toUserId || '').slice(0,100),
    fromUsername: String(message.fromUsername || 'Usuário').slice(0,30),
    text: String(message.text || '').slice(0,1000),
    at: Number(message.at || Date.now())
  }));
}

function serializeServers() {
  return [...servers.values()].map(serverData => ({
    id: serverData.id,
    ownerId: serverData.ownerId,
    members: serverData.members,
    inviteToken: serverData.inviteToken,
    name: serverData.name,
    icon: serverData.icon,
    accent: serverData.accent,
    description: serverData.description,
    tags: serverData.tags,
    textChannels: serverData.textChannels,
    voiceChannels: serverData.voiceChannels,
    categories: serverData.categories,
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
        version: 6,
        servers: serializeServers(),
        profiles: serializeProfiles(),
        directMessages: serializeDirectMessages(),
        friendRequests: serializeFriendRequests(),
        friendships: serializeFriendships(),
        privateGroups: serializePrivateGroups()
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
    const savedDirectMessages = Array.isArray(parsed?.directMessages) ? parsed.directMessages : [];
    const savedFriendRequests = Array.isArray(parsed?.friendRequests) ? parsed.friendRequests : [];
    const savedFriendships = Array.isArray(parsed?.friendships) ? parsed.friendships : [];
    const savedPrivateGroups = Array.isArray(parsed?.privateGroups) ? parsed.privateGroups : [];

    directMessages.splice(0,directMessages.length);
    friendRequests.splice(0,friendRequests.length);
    friendships.splice(0,friendships.length);
    privateGroups.clear();

    for (const rawGroup of savedPrivateGroups.slice(0,2000)) {
      const groupId = String(rawGroup?.id || '').slice(0,80);
      const ownerId = String(rawGroup?.ownerId || '').slice(0,100);
      const members = Array.isArray(rawGroup?.members)
        ? [...new Set(rawGroup.members.map(value=>String(value || '').slice(0,100)).filter(Boolean))].slice(0,10)
        : [];

      if (!groupId || !ownerId || !members.length) continue;
      if (!members.includes(ownerId)) members.unshift(ownerId);

      privateGroups.set(groupId,{
        id:groupId,
        name:String(rawGroup?.name || 'Grupo').trim().slice(0,40) || 'Grupo',
        ownerId,
        members:members.slice(0,10),
        createdAt:Number(rawGroup?.createdAt || Date.now()),
        messages:Array.isArray(rawGroup?.messages)
          ? rawGroup.messages.slice(-500).map(message=>({
              id:String(message?.id || id()).slice(0,80),
              userId:String(message?.userId || '').slice(0,100),
              username:cleanName(message?.username,'Usuário'),
              text:String(message?.text || '').slice(0,1000),
              at:Number(message?.at || Date.now())
            })).filter(message=>message.userId && message.text)
          : []
      });
    }

    for (const request of savedFriendRequests.slice(-5000)) {
      if (!request?.fromUserId || !request?.toUserId) continue;

      friendRequests.push({
        id: String(request.id || id()).slice(0,80),
        fromUserId: String(request.fromUserId).slice(0,100),
        toUserId: String(request.toUserId).slice(0,100),
        at: Number(request.at || Date.now())
      });
    }

    for (const pair of savedFriendships.slice(0,10000)) {
      if (!pair?.a || !pair?.b || pair.a === pair.b) continue;

      friendships.push({
        a: String(pair.a).slice(0,100),
        b: String(pair.b).slice(0,100),
        at: Number(pair.at || Date.now())
      });
    }

    for (const message of savedDirectMessages.slice(-5000)) {
      if (!message?.fromUserId || !message?.toUserId || !message?.text) continue;

      directMessages.push({
        id: String(message.id || id()).slice(0,80),
        fromUserId: String(message.fromUserId).slice(0,100),
        toUserId: String(message.toUserId).slice(0,100),
        fromUsername: cleanName(message.fromUsername,'Usuário'),
        text: String(message.text).slice(0,1000),
        at: Number(message.at || Date.now())
      });
    }

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
        ownerId: item.ownerId,
        members: item.members,
        inviteToken: item.inviteToken,
        icon: item.icon,
        accent: item.accent,
        description: item.description,
        tags: item.tags,
        textChannels: item.textChannels,
        voiceChannels: item.voiceChannels,
        categories: item.categories,
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
      ownerId: item.ownerId,
      members: item.members,
      inviteToken: item.inviteToken,
      icon: item.icon,
      accent: item.accent,
      description: item.description,
      tags: item.tags,
      textChannels: item.textChannels,
      voiceChannels: item.voiceChannels,
      categories: item.categories,
      roles: item.roles
    });
  }

  if (item.ownerId && !existing.ownerId) {
    existing.ownerId = String(item.ownerId).slice(0,100);
  }

  if (Array.isArray(item.members)) {
    existing.members = [...new Set([
      ...(existing.members || []),
      ...item.members.map(value=>String(value || '').slice(0,100)).filter(Boolean)
    ])];
  }

  if (item.inviteToken && !existing.inviteToken) {
    existing.inviteToken = String(item.inviteToken).slice(0,100);
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
        name: String(channel?.name || fallback).trim().slice(0, 30) || fallback,
        categoryId: channel?.categoryId
          ? String(channel.categoryId).slice(0,80)
          : null,
        order: Number.isFinite(Number(channel?.order))
          ? Number(channel.order)
          : target.length
      });
      known.add(channelId);
    }
  };

  mergeChannels(existing.textChannels, item.textChannels, 'chat');
  mergeChannels(existing.voiceChannels, item.voiceChannels, 'Voz');

  if (Array.isArray(item.categories)) {
    const knownCategories = new Set(existing.categories.map(category => category.id));

    for (const category of normalizeCategories(item.categories)) {
      const current = existing.categories.find(itemCategory => itemCategory.id === category.id);

      if (current) {
        current.name = category.name;
        current.order = category.order;
      } else if (!knownCategories.has(category.id)) {
        existing.categories.push(category);
        knownCategories.add(category.id);
      }
    }

    existing.categories.sort((a,b) => a.order - b.order);
  }

  if (Array.isArray(item.roles)) {
    const knownRoles = new Set(existing.roles.map(role => role.id));

    for (const role of normalizeRoles(item.roles)) {
      const current = existing.roles.find(itemRole => itemRole.id === role.id);

      if (current) {
        current.name = role.name;
        current.color = role.color;
        current.members = [...new Set([...(current.members || []), ...(role.members || [])])].slice(0, 100);
        current.permissions = role.permissions || current.permissions || {};
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

function publicServer(serverData) {
  return {
    id: serverData.id,
    ownerId: serverData.ownerId,
    inviteToken: serverData.inviteToken,
    name: serverData.name,
    icon: serverData.icon,
    accent: serverData.accent,
    description: serverData.description,
    tags: serverData.tags,
    textChannels: serverData.textChannels,
    voiceChannels: serverData.voiceChannels,
    categories: serverData.categories,
    roles: serverData.roles
  };
}

function publicServersForUser(userId) {
  const safeUserId = String(userId || '').slice(0,100);
  if (!safeUserId) return [];

  return [...servers.values()]
    .filter(serverData =>
      serverData.ownerId === safeUserId ||
      (serverData.members || []).includes(safeUserId)
    )
    .map(publicServer);
}

function sendServerList(socket) {
  if (!socket?.data?.userId) return;
  socket.emit('server-list', publicServersForUser(socket.data.userId));
}

function broadcastServerLists() {
  for (const client of io.sockets.sockets.values()) {
    if (!client?.data?.userId) continue;
    sendServerList(client);
  }
}

function broadcastServerUpdate(serverData) {
  if (!serverData) return;

  const payload = publicServer(serverData);

  for (const client of io.sockets.sockets.values()) {
    if (requireServerAccess(serverData, client)) {
      client.emit('server-updated', payload);
    }
  }
}

function userRoles(serverData, socket) {
  const username = String(socket.data.username || '').toLowerCase();
  if (!username) return [];

  return (serverData.roles || []).filter(role =>
    (role.members || []).some(member =>
      String(member || '').toLowerCase() === username
    )
  );
}

function hasServerPermission(serverData, socket, permission) {
  if (!serverData || !socket.data.userId) return false;
  if (serverData.ownerId === socket.data.userId) return true;

  const roles = userRoles(serverData,socket);

  if (roles.some(role => role.permissions?.administrator)) return true;

  return roles.some(role => !!role.permissions?.[permission]);
}

function requireServerAccess(serverData, socket) {
  if (!serverData || !socket.data.userId) return false;

  return serverData.ownerId === socket.data.userId ||
    (serverData.members || []).includes(socket.data.userId);
}

function permissionDenied(socket) {
  socket.emit('permission-error',{
    error:'Você não tem permissão para fazer isso neste servidor'
  });
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

/* Temas opcionais. Sem escolha, o site continua exatamente no tema original. */
html[data-theme="black"]{
  --bg0:#050506;--bg1:#0b0b0d;--bg2:#141417;--bg3:#1d1d21;--bg4:#28282e;
  --line:#35353c;--text:#f4f4f5;--muted:#b3b3ba;--low:#7d7d87;
  --coral:#e5e5e7;--coral2:#ffffff;--mint:#bfc3ca;--mintbg:#202126;--danger:#df4c4c;
}
html[data-theme="white"]{
  --bg0:#edf1f5;--bg1:#ffffff;--bg2:#f4f6f8;--bg3:#e7ebf0;--bg4:#dce2e9;
  --line:#c9d1da;--text:#171a1f;--muted:#505966;--low:#788391;
  --coral:#4d6fff;--coral2:#6683ff;--mint:#3d67d9;--mintbg:#e2e9ff;--danger:#c93c48;
}
html[data-theme="blue"]{
  --bg0:#07101f;--bg1:#0b172b;--bg2:#10213b;--bg3:#162c4b;--bg4:#1d385e;
  --line:#285079;--text:#f3f8ff;--muted:#adc3dd;--low:#7896b7;
  --coral:#4e8cff;--coral2:#6fa2ff;--mint:#53a7ff;--mintbg:#102e52;--danger:#e25264;
}
html[data-theme="purple"]{
  --bg0:#100b19;--bg1:#181123;--bg2:#221830;--bg3:#2c1f40;--bg4:#38284f;
  --line:#4a3761;--text:#faf7ff;--muted:#cabee0;--low:#9586ad;
  --coral:#9b6cff;--coral2:#b28cff;--mint:#a87dff;--mintbg:#2b1c48;--danger:#df4c67;
}
*{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%;background:var(--bg0);color:var(--text)}
body{overflow:hidden}
button,input,textarea{font:inherit}
button{cursor:pointer}
.hidden{display:none!important}
.app{display:grid;grid-template-columns:72px 250px minmax(0,1fr) 240px;height:100vh}
.app.hubMode{
  grid-template-columns:72px minmax(0,1fr) 240px;
}
.app.hubMode .sidebar{
  display:none;
}
.app.serverMode{
  grid-template-columns:72px 250px minmax(0,1fr) 240px;
}
.rail{background:var(--bg0);border-right:1px solid var(--line);padding:14px 0;display:flex;flex-direction:column;align-items:center;gap:10px;overflow-y:auto}
.serverIcon,.addServer{width:46px;height:46px;border:0;border-radius:16px;display:grid;place-items:center;font-weight:900;flex:0 0 auto;transition:.15s}
.serverIcon{background:var(--bg2);color:var(--muted);position:relative}
.serverIcon:hover,.serverIcon.active{background:var(--coral);color:#281009;border-radius:13px}
.homeHubIcon{
  background:var(--bg3);
  color:var(--text);
}
.homeHubIcon:hover,
.homeHubIcon.active{
  background:var(--coral);
  color:#281009;
}
.homeHubIcon{
  overflow:hidden;
  padding:0;
}
.homeHubIcon img{
  width:100%;
  height:100%;
  object-fit:cover;
  display:block;
  border-radius:inherit;
}
.serverIcon.active:before{content:"";position:absolute;left:-14px;width:4px;height:24px;background:var(--text);border-radius:0 4px 4px 0}
.addServer{background:var(--bg2);color:var(--mint);font-size:24px}
.addServer:hover{background:var(--mint);color:#082116}
.railSep{width:30px;height:1px;background:var(--line);flex:0 0 auto}
#serverRail{
  display:flex;
  flex-direction:column;
  align-items:center;
  gap:10px;
}

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
.userbar{border-top:1px solid var(--line);background:var(--bg1);padding:10px 12px;display:flex;align-items:center;gap:9px}
.avatar{width:34px;height:34px;border-radius:11px;background:var(--coral);color:#281009;display:grid;place-items:center;font-weight:900}
.userMeta{min-width:0}.userMeta strong,.userMeta span{display:block}.userMeta strong{font-size:13px;overflow:hidden;text-overflow:ellipsis}.userMeta span{font-size:11px;color:var(--mint)}

.main{min-width:0;display:flex;flex-direction:column;background:radial-gradient(circle at 20% 15%,rgba(65,217,154,.06),transparent 30%),radial-gradient(circle at 82% 75%,rgba(255,107,74,.07),transparent 35%),var(--bg0)}
.topbar{height:54px;border-bottom:1px solid var(--line);padding:0 18px;display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--bg1)}
.topLeft{display:flex;align-items:center;gap:9px;min-width:0}.topTitle{font-weight:900;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.topSub{font-size:12px;color:var(--muted)}
.content{flex:1;min-height:0;position:relative}
.view{height:100%;min-height:0}

.home{display:flex;align-items:center;justify-content:center;padding:24px}
.homeCard{width:min(620px,100%);background:var(--bg1);border:1px solid var(--line);border-radius:22px;padding:32px;box-shadow:0 22px 70px rgba(0,0,0,.25)}
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
.controls{display:flex;justify-content:center;gap:9px;flex-wrap:wrap;padding:12px;border-top:1px solid var(--line);background:var(--bg1)}
.control{border:1px solid var(--line);background:var(--bg3);color:var(--text);border-radius:999px;padding:11px 15px;font-weight:800;min-width:120px}
.control:hover{background:var(--bg4)}.control.off{background:#18211e;color:var(--muted)}.control.sharing{background:var(--mintbg);color:var(--mint)}.control.danger{background:var(--danger);border-color:transparent}

.rightbar{background:var(--bg1);border-left:1px solid var(--line);padding:18px 14px;overflow-y:auto}
.rightTitle{color:var(--low);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px}
.member{display:flex;align-items:center;gap:9px;padding:9px;border-radius:10px;color:var(--muted)}
.memberDot{width:8px;height:8px;border-radius:50%;background:var(--mint)}
.memberInfo{min-width:0;flex:1}
.memberVolume{
  margin-left:auto;
  display:flex;
  align-items:center;
  gap:4px;
  flex:0 0 auto;
}
.memberVolume button{
  width:25px;
  height:25px;
  border:1px solid var(--line);
  border-radius:7px;
  background:var(--bg2);
  color:var(--text);
  font-size:14px;
  font-weight:900;
  padding:0;
}
.memberVolume button:hover{background:var(--bg3)}
.memberVolumeValue{
  min-width:38px;
  text-align:center;
  font-size:10px;
  font-weight:800;
  color:var(--muted);
}

.modalWrap{position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,.72);display:grid;place-items:center;padding:18px}
.modal{width:min(430px,100%);background:var(--bg1);border:1px solid var(--line);border-radius:20px;padding:24px;box-shadow:0 25px 80px rgba(0,0,0,.45)}
.modal h2{margin:0 0 7px}.modal p{margin:0 0 18px;color:var(--muted);font-size:13px;line-height:1.5}
.modalActions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.profileTabs{
  display:flex;
  gap:6px;
  margin:0 0 18px;
  padding:4px;
  background:var(--bg2);
  border:1px solid var(--line);
  border-radius:12px;
}
.profileTabBtn{
  flex:1;
  border:0;
  background:transparent;
  color:var(--muted);
  padding:9px 10px;
  border-radius:9px;
  font-weight:800;
}
.profileTabBtn:hover{background:var(--bg3);color:var(--text)}
.profileTabBtn.active{background:var(--bg4);color:var(--text)}
.profileTabPanel{display:none}
.profileTabPanel.active{display:block}

.profileThemeChoices{display:grid;grid-template-columns:repeat(5,1fr);gap:7px;margin-top:8px}
.profileThemeBtn{
  border:1px solid var(--line);
  background:var(--bg2);
  color:var(--text);
  border-radius:10px;
  padding:8px 5px;
  font-size:11px;
  font-weight:800;
}
.profileThemeBtn:hover{background:var(--bg3)}
.profileThemeBtn.active{outline:2px solid var(--coral);outline-offset:1px}
.profileThemeDot{
  display:block;
  width:25px;height:25px;
  margin:0 auto 5px;
  border-radius:8px;
  border:1px solid rgba(127,127,127,.35);
}
.profileThemeDot.default{background:linear-gradient(135deg,#07110e,#41d99a)}
.profileThemeDot.black{background:linear-gradient(135deg,#050506,#33343a)}
.profileThemeDot.white{background:linear-gradient(135deg,#ffffff,#dce2e9)}
.profileThemeDot.blue{background:linear-gradient(135deg,#07101f,#4e8cff)}
.profileThemeDot.purple{background:linear-gradient(135deg,#100b19,#9b6cff)}
@media(max-width:560px){.profileThemeChoices{grid-template-columns:repeat(3,1fr)}}

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
  background:var(--bg1);
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



.categoryBlock{
  margin:9px 0 14px;
  border-radius:10px;
}
.categoryHeader{
  display:flex;
  align-items:center;
  gap:7px;
  min-height:28px;
  padding:4px 8px;
  color:var(--low);
  font-size:10px;
  font-weight:900;
  text-transform:uppercase;
  letter-spacing:.07em;
  border-radius:8px;
  user-select:none;
}
.categoryHeader:hover{
  color:var(--muted);
  background:rgba(255,255,255,.025);
}
.categoryHeader.dragOver,
.channelBtn.dragOver{
  outline:1px solid var(--mint);
  background:rgba(65,217,154,.08)!important;
}
.categoryHeader .categoryName{
  flex:1;
  overflow:hidden;
  white-space:nowrap;
  text-overflow:ellipsis;
}
.categoryHeader .categoryDelete{
  border:0;
  background:transparent;
  color:var(--low);
  padding:2px 4px;
  border-radius:5px;
  opacity:0;
}
.categoryHeader:hover .categoryDelete{opacity:1}
.categoryHeader .categoryDelete:hover{
  color:#ff8d8d;
  background:rgba(223,76,76,.10);
}
.categoryChannels{
  min-height:8px;
  padding:2px 0;
}
.channelBtn{
  position:relative;
}
.channelBtn[draggable="true"]{
  cursor:grab;
}
.channelBtn.dragging,
.categoryHeader.dragging{
  opacity:.38;
}
.channelGrip{
  color:var(--low);
  font-size:9px;
  letter-spacing:-2px;
  margin-right:1px;
}
.friendsHome{
  height:100%;
  display:grid;
  grid-template-rows:auto auto 1fr;
  min-height:0;
}
.friendsHomeTop{
  min-height:54px;
  padding:0 18px;
  border-bottom:1px solid var(--line);
  display:flex;
  align-items:center;
  gap:8px;
  flex-wrap:wrap;
}
.friendTab{
  border:0;
  background:transparent;
  color:var(--muted);
  padding:8px 11px;
  border-radius:8px;
  font-size:13px;
  font-weight:750;
}
.friendTab:hover,
.friendTab.active{
  color:var(--text);
  background:var(--bg3);
}
.friendTab.add{
  background:var(--mint);
  color:#082116;
}
.friendsSearchWrap{
  padding:14px 18px 10px;
}
.friendsSearchWrap input{
  background:var(--bg2);
}
.friendsListArea{
  min-height:0;
  overflow:auto;
  padding:8px 18px 20px;
}
.friendsSectionTitle{
  color:var(--low);
  font-size:11px;
  font-weight:900;
  text-transform:uppercase;
  letter-spacing:.07em;
  padding:8px 2px 10px;
  border-bottom:1px solid var(--line);
  margin-bottom:2px;
}
.friendRow{
  display:flex;
  align-items:center;
  gap:12px;
  padding:11px 7px;
  border-bottom:1px solid rgba(36,71,59,.55);
  border-radius:9px;
}
.friendRow:hover{
  background:rgba(255,255,255,.025);
}
.friendActions{
  display:flex;
  gap:7px;
}
.activeFriendCard{
  padding:12px;
  background:var(--bg2);
  border:1px solid var(--line);
  border-radius:13px;
  margin-bottom:8px;
}
.activeFriendCard strong{
  display:block;
  font-size:12px;
}
.activeFriendCard span{
  display:block;
  color:var(--muted);
  font-size:11px;
  margin-top:4px;
}

.serverSettings{
  height:100%;
  display:grid;
  grid-template-columns:220px minmax(0,1fr);
  background:var(--bg0);
}
.settingsMenu{
  border-right:1px solid var(--line);
  padding:22px 14px;
  background:var(--bg1);
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

@media(max-width:760px){
  .app.hubMode,.app.serverMode{
    grid-template-columns:62px minmax(0,1fr);
  }
  .app.hubMode .rightbar{
    display:none;
  }
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

<div id="appShell" class="app hubMode">
  <aside class="rail">
    <button id="homeHubBtn" class="serverIcon homeHubIcon active" type="button" title="Início do e-cord">
      <img src="data:image/png;base64,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" alt="e-cord">
    </button>

    <div class="railSep"></div>
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
      <button id="serverRolesBtn" class="navBtn" type="button">🛡 Cargos do servidor</button>

      <div class="groupHead">
        <span>Canais</span>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:0 2px 9px;">
        <button id="createTextQuickBtn" class="btn secondary small" type="button"># Texto</button>
        <button id="createVoiceQuickBtn" class="btn secondary small" type="button">🔊 Voz</button>
      </div>

      <button id="createCategoryQuickBtn" class="navBtn" type="button" style="font-size:12px;">▣ Criar categoria</button>

      <div id="channelTree"></div>
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
        <div class="friendsHome">
          <div class="friendsHomeTop">
            <strong style="margin-right:8px;">e-cord</strong>
            <button id="hubFriendsBtn" class="friendTab active" type="button">👥 Amigos</button>
            <button id="hubMessagesBtn" class="friendTab" type="button">✉ Mensagens privadas</button>
            <span style="width:1px;height:22px;background:var(--line);margin:0 3px;"></span>
            <button id="friendsOnlineTab" class="friendTab active" type="button">Disponível</button>
            <button id="friendsAllTab" class="friendTab" type="button">Todos</button>
            <button id="friendsPendingTab" class="friendTab" type="button">Pendentes</button>
            <button id="createPrivateGroupBtn" class="friendTab" type="button">👥 Criar grupo</button>
            <button id="addFriendBtn" class="friendTab add" type="button">Adicionar amigo</button>
          </div>

          <div class="friendsSearchWrap">
            <input id="friendsSearch" placeholder="Buscar amigo">
          </div>

          <div class="friendsListArea">
            <div id="friendsCountTitle" class="friendsSectionTitle">Online</div>
            <div id="friendsList"></div>
          </div>
        </div>
      </section>



      <section id="dmView" class="view hidden">
        <div style="height:100%;display:grid;grid-template-columns:250px minmax(0,1fr);min-height:0;">
          <aside style="border-right:1px solid var(--line);background:var(--bg1);padding:12px;overflow:auto;">
            <div style="font-weight:900;margin:5px 5px 12px;">Mensagens privadas</div>
            <input id="dmSearch" placeholder="Buscar amigo" style="margin-bottom:10px;">
            <div id="dmContacts"></div>
          </aside>

          <div style="display:grid;grid-template-rows:auto 1fr auto;min-width:0;min-height:0;">
            <div style="padding:14px 18px;border-bottom:1px solid var(--line);">
              <strong id="dmTitle">Selecione um amigo</strong>
              <div id="dmSubtitle" style="font-size:11px;color:var(--muted);margin-top:3px;">Conversa privada</div>
            </div>

            <div id="dmMessages" class="messages"></div>

            <div class="compose">
              <input id="dmInput" maxlength="1000" placeholder="Selecione um amigo para conversar" disabled>
              <button id="dmSendBtn" class="btn primary" disabled>Enviar</button>
            </div>
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
          <button id="deafenBtn" class="control">🔊 Áudio</button>
          <button id="audioGateBtn" class="control audioGate hidden">🔊 Ativar áudio</button>
          <button id="cameraBtn" class="control off">📷 Ligar câmera</button>
          <button id="screenBtn" class="control">🖥️ Compartilhar tela</button>
          <button id="leaveVoiceBtn" class="control danger">☎ Sair</button>
        </div>
      </section>
    </div>
  </main>

  <aside class="rightbar">
    <div id="rightTitle" class="rightTitle">Ativo agora</div>
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


    <div id="rolePermissionsWrap" class="hidden" style="margin-top:14px;">
      <div style="color:var(--low);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px;">Permissões do cargo</div>

      <label style="display:flex;align-items:flex-start;gap:9px;padding:9px 10px;background:var(--bg2);border:1px solid var(--line);border-radius:10px;margin-bottom:6px;text-transform:none;letter-spacing:0;font-size:12px;">
        <input id="permAdministrator" type="checkbox" style="width:auto;margin-top:2px;">
        <span><b>Administrador</b><br><span style="color:var(--low);">Acesso total ao servidor.</span></span>
      </label>

      <label style="display:flex;align-items:flex-start;gap:9px;padding:9px 10px;background:var(--bg2);border:1px solid var(--line);border-radius:10px;margin-bottom:6px;text-transform:none;letter-spacing:0;font-size:12px;">
        <input id="permManageServer" type="checkbox" style="width:auto;margin-top:2px;">
        <span><b>Gerenciar servidor</b><br><span style="color:var(--low);">Alterar nome, ícone e configurações.</span></span>
      </label>

      <label style="display:flex;align-items:flex-start;gap:9px;padding:9px 10px;background:var(--bg2);border:1px solid var(--line);border-radius:10px;margin-bottom:6px;text-transform:none;letter-spacing:0;font-size:12px;">
        <input id="permManageChannels" type="checkbox" style="width:auto;margin-top:2px;">
        <span><b>Gerenciar canais</b><br><span style="color:var(--low);">Criar e organizar texto, voz e categorias.</span></span>
      </label>

      <label style="display:flex;align-items:flex-start;gap:9px;padding:9px 10px;background:var(--bg2);border:1px solid var(--line);border-radius:10px;text-transform:none;letter-spacing:0;font-size:12px;">
        <input id="permManageRoles" type="checkbox" style="width:auto;margin-top:2px;">
        <span><b>Gerenciar cargos</b><br><span style="color:var(--low);">Criar, editar e atribuir cargos.</span></span>
      </label>
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
    <p>Edite seu perfil ou altere a aparência do site.</p>

    <div class="profileTabs">
      <button id="profileInfoTabBtn" class="profileTabBtn active" type="button">Perfil</button>
      <button id="profileAppearanceTabBtn" class="profileTabBtn" type="button">Aparência</button>
    </div>

    <div id="profileInfoTab" class="profileTabPanel active">
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
    </div>

    <div id="profileAppearanceTab" class="profileTabPanel">
      <div style="color:var(--text);font-size:14px;font-weight:900;margin-bottom:5px;">Cor do site</div>
      <div style="color:var(--muted);font-size:12px;line-height:1.5;margin-bottom:12px;">
        Essa opção é só para você. Se não quiser mudar, deixe em Padrão.
      </div>

      <div id="profileThemeChoices" class="profileThemeChoices">
        <button type="button" class="profileThemeBtn" data-profile-theme="default">
          <span class="profileThemeDot default"></span>Padrão
        </button>
        <button type="button" class="profileThemeBtn" data-profile-theme="black">
          <span class="profileThemeDot black"></span>Preto
        </button>
        <button type="button" class="profileThemeBtn" data-profile-theme="white">
          <span class="profileThemeDot white"></span>Branco
        </button>
        <button type="button" class="profileThemeBtn" data-profile-theme="blue">
          <span class="profileThemeDot blue"></span>Azul
        </button>
        <button type="button" class="profileThemeBtn" data-profile-theme="purple">
          <span class="profileThemeDot purple"></span>Roxo
        </button>
      </div>
    </div>

    <div class="modalActions">
      <button id="profileCancelBtn" class="btn secondary">Cancelar</button>
      <button id="profileSaveBtn" class="btn primary">Salvar</button>
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

<div id="activeCallDock" class="hidden" style="
  position:fixed;
  left:50%;
  bottom:16px;
  transform:translateX(-50%);
  z-index:1500000;
  min-width:min(520px,calc(100% - 28px));
  max-width:720px;
  background:rgba(13,27,23,.97);
  border:1px solid var(--line);
  border-radius:16px;
  box-shadow:0 18px 55px rgba(0,0,0,.38);
  padding:10px 12px;
  display:flex;
  align-items:center;
  gap:10px;
">
  <div style="width:10px;height:10px;border-radius:50%;background:var(--mint);box-shadow:0 0 0 4px rgba(65,217,154,.10);"></div>

  <div style="flex:1;min-width:0;">
    <strong style="display:block;font-size:12px;color:var(--mint);">Voz conectada</strong>
    <span id="activeCallDockText" style="display:block;font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Call ativa</span>
  </div>

  <button id="returnToCallBtn" class="btn secondary small" type="button">Voltar à call</button>
  <button id="dockLeaveCallBtn" class="btn danger small" type="button">Sair</button>
</div>

<div id="privateGroupModalWrap" class="modalWrap hidden">
  <div class="modal" style="width:min(520px,100%);">
    <h2>Criar grupo privado</h2>
    <p>Escolha até 9 amigos. Com você, o grupo pode ter no máximo 10 pessoas.</p>

    <label style="display:block;color:var(--low);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;margin-bottom:7px;">Nome do grupo</label>
    <input id="privateGroupNameInput" maxlength="40" placeholder="Ex.: Os cria">

    <div style="margin-top:16px;color:var(--low);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;">Amigos</div>
    <div id="privateGroupFriendsList" style="margin-top:8px;max-height:290px;overflow:auto;display:grid;gap:6px;"></div>

    <div id="privateGroupCount" style="margin-top:10px;color:var(--muted);font-size:12px;">1/10 pessoas</div>

    <div class="modalActions">
      <button id="privateGroupCancelBtn" class="btn secondary">Cancelar</button>
      <button id="privateGroupCreateBtn" class="btn primary">Criar grupo</button>
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
  userId: getOrCreateUserId(),
  username: localStorage.getItem('ecord-name') || '',
  bio: localStorage.getItem('ecord-bio') || '',
  avatar: localStorage.getItem('ecord-avatar') || '',
  theme: localStorage.getItem('ecord-theme') || 'default',
  pendingTheme: null,
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
  privateCallId: null,
  privatePeerName: null,
  incomingCall: null,
  pendingAvatar: null,
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
  privateInviteHandled: false,
  currentView: PAGE_WAS_RELOADED
    ? (localStorage.getItem('ecord-last-view') || 'friends')
    : 'friends',
  appInitialized: false,
  restoringReload: PAGE_WAS_RELOADED,
  profileReady: false
};

applyProfileTheme(state.theme);

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


const PROFILE_THEMES = ['default','black','white','blue','purple'];

function normalizeProfileTheme(theme){
  return PROFILE_THEMES.includes(theme) ? theme : 'default';
}

function applyProfileTheme(theme){
  const selected = normalizeProfileTheme(theme);

  if(selected === 'default'){
    document.documentElement.removeAttribute('data-theme');
  }else{
    document.documentElement.setAttribute('data-theme',selected);
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
}

function previewProfileTheme(theme){
  state.pendingTheme = normalizeProfileTheme(theme);
  applyProfileTheme(state.pendingTheme);
  updateProfileThemeButtons();
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


function setProfileTab(tab){
  const appearance = tab === 'appearance';

  $('#profileInfoTabBtn').classList.toggle('active',!appearance);
  $('#profileAppearanceTabBtn').classList.toggle('active',appearance);

  $('#profileInfoTab').classList.toggle('active',!appearance);
  $('#profileAppearanceTab').classList.toggle('active',appearance);
}

function openProfileModal(){
  state.pendingAvatar = state.avatar || '';
  state.pendingTheme = normalizeProfileTheme(state.theme);
  $('#profileNameInput').value = state.username || '';
  $('#profileBioInput').value = state.bio || '';
  $('#profilePhotoInput').value = '';

  applyAvatar(
    $('#profileAvatarPreview'),
    {username:state.username,avatar:state.pendingAvatar},
    state.username
  );

  updateProfileThemeButtons();
  setProfileTab('profile');
  $('#profileModalWrap').classList.remove('hidden');
}

function closeProfileModal(){
  $('#profileModalWrap').classList.add('hidden');

  if(state.pendingTheme !== null){
    applyProfileTheme(state.theme);
  }

  state.pendingAvatar = null;
  state.pendingTheme = null;
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

  state.theme = normalizeProfileTheme(state.pendingTheme || state.theme);
  localStorage.setItem('ecord-theme',state.theme);
  applyProfileTheme(state.theme);
  state.pendingTheme = null;

  socket.emit('set-profile',{
    userId:state.userId,
    username,
    bio,
    avatar:String(state.pendingAvatar || '').slice(0,350000),
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
          order:Number.isFinite(Number(c.order)) ? Number(c.order) : 0
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
      : []
  };
}

function getCachedServers(){
  const parseCache = value => {
    try{
      const parsed = JSON.parse(value || '[]');
      return Array.isArray(parsed)
        ? parsed.map(safeServerSnapshot).filter(Boolean)
        : [];
    }catch{
      return [];
    }
  };

  const primary = parseCache(localStorage.getItem('ecord-server-cache'));

  if(primary.length){
    return primary;
  }

  return parseCache(localStorage.getItem('ecord-server-backup'));
}

function cacheServers(list){
  try{
    const safe = (Array.isArray(list) ? list : [])
      .map(safeServerSnapshot)
      .filter(Boolean);

    const payload = JSON.stringify(safe);

    localStorage.setItem('ecord-server-cache',payload);

    if(safe.length){
      localStorage.setItem('ecord-server-backup',payload);
    }
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

function setAppMode(mode){
  const app = $('#appShell');
  if(!app) return;

  const hub = mode === 'hub';

  app.classList.toggle('hubMode', hub);
  app.classList.toggle('serverMode', !hub);

  $('#homeHubBtn')?.classList.toggle('active', hub);

  if(hub){
    document.querySelectorAll('#serverRail .serverIcon').forEach(btn=>{
      btn.classList.remove('active');
    });
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
    $('#voiceTitle').textContent = 'Chamada com ' + (state.privatePeerName || 'Amigo');
    $('#topTitle').textContent = '☎ Chamada privada';
    $('#topSub').textContent = state.privatePeerName || '';
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
  updateCallDock();
}

function setView(name){
  state.currentView = name;
  localStorage.setItem('ecord-last-view',name);

  const hubView = name==='friends' || name==='dm';

  if(hubView){
    setAppMode('hub');
  }else{
    setAppMode('server');
  }

  $('#homeView').classList.toggle('hidden', name!=='home');
  $('#friendsView').classList.toggle('hidden', name!=='friends');
  $('#dmView').classList.toggle('hidden', name!=='dm');
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
  $('#serverRolesBtn')?.classList.toggle('active', name==='roles');

  if(name==='home'){
    $('#topTitle').textContent = currentServer()?.name || 'e-cord';
    $('#topSub').textContent = 'servidor';
  }

  if(name==='friends'){
    $('#topTitle').textContent = '👥 Amigos';
    $('#topSub').textContent = 'seus amigos e chamadas';
    renderFriends();
  }

  if(name==='dm'){
    $('#topTitle').textContent = '✉ Mensagens privadas';
    $('#topSub').textContent = 'conversas entre amigos';
    renderDmContacts();
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

  updateCallDock();
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
      $('#voiceControls').classList.add('hidden');
      $('#joinVoiceBtn').classList.remove('hidden');
      $('#joinVoiceBtn').textContent='Entrar na voz';
      $('#voiceStatus').textContent='Fora da chamada';
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
    const hubVisible = state.currentView==='friends' || state.currentView==='dm';
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

function renderSidebar(){
  const s = currentServer();

  if(!s){
    $('#serverTitle').textContent = 'Nenhum servidor';
    $('#channelTree').innerHTML = '';
    $('#inviteBtn').disabled = true;
    $('#serverSettingsBtn').disabled = true;
    $('#deleteServerBtn').disabled = true;
    return;
  }

  $('#inviteBtn').disabled = false;
  $('#serverSettingsBtn').disabled = false;
  $('#deleteServerBtn').disabled = false;
  $('#serverTitle').textContent = s.name;

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
    const b = document.createElement('button');
    b.className =
      'channelBtn' +
      (type==='voice' ? ' voice' : '') +
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
    icon.className = type==='text' ? 'hash' : '';
    icon.textContent = type==='text' ? '#' : '))';

    const label = document.createElement('span');
    label.textContent = channel.name;
    label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;';

    b.append(grip,icon,label);

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

      const del = document.createElement('button');
      del.className = 'categoryDelete';
      del.type = 'button';
      del.textContent = '×';
      del.title = 'Excluir categoria';

      del.addEventListener('click',event=>{
        event.stopPropagation();

        if(confirm('Excluir a categoria "' + category.name + '"? Os canais não serão apagados.')){
          socket.emit('delete-category',{
            serverId:state.serverId,
            categoryId:category.id
          });
        }
      });

      header.appendChild(del);

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

  const server = currentServer();
  if(!server){
    return;
  }

  const memberIds = new Set([
    server.ownerId,
    ...(server.members || [])
  ].filter(Boolean));

  const knownProfiles = [];

  for(const user of state.onlineUsers){
    if(memberIds.has(user.id)){
      knownProfiles.push(user);
    }
  }

  const ownProfile = {
    id:state.userId,
    username:state.username,
    bio:state.bio,
    avatar:state.avatar
  };

  if(memberIds.has(state.userId) && !knownProfiles.some(item=>item.id===state.userId)){
    knownProfiles.unshift(ownProfile);
  }

  if(!knownProfiles.length){
    const empty = document.createElement('div');
    empty.className='settingsCard';
    empty.style.color='var(--low)';
    empty.textContent='Os membros aparecerão aqui quando estiverem online.';
    box.appendChild(empty);
    return;
  }

  knownProfiles.forEach(user=>{
    const row=document.createElement('div');
    row.className='settingsMember';

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
    status.style.cssText='font-size:11px;color:var(--mint);margin-top:2px;';
    status.textContent=user.id===server.ownerId ? 'Dono do servidor' : '● Online';
    meta.appendChild(status);

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

function selectText(channelId){
  setAppMode('server');
  state.textChannelId = channelId;
  localStorage.setItem('ecord-last-text-channel-id',channelId);

  if(state.serverId){
    localStorage.setItem('ecord-server-' + state.serverId + '-text',channelId);
  }

  renderSidebar();
  const c = currentText();
  $('#chatTitle').textContent = c?.name || 'chat';
  $('#messageInput').placeholder = 'Mensagem em #' + (c?.name || 'chat');
  socket.emit('join-text',{serverId:state.serverId,channelId});
  setView('chat');
  $('#messageInput').focus();
}

function selectVoice(channelId){
  setAppMode('server');
  state.voiceChannelId = channelId;
  localStorage.setItem('ecord-last-voice-channel-id',channelId);

  if(state.serverId){
    localStorage.setItem('ecord-server-' + state.serverId + '-voice',channelId);
  }

  renderSidebar();

  const c = currentVoice();
  $('#voiceTitle').textContent = c?.name || 'Voz';
  setView('voice');

  const isActiveChannel =
    !!state.joinedVoiceId &&
    !state.privateCallId &&
    state.activeVoiceServerId === state.serverId &&
    state.activeVoiceChannelId === channelId;

  if(isActiveChannel){
    $('#voiceControls').classList.remove('hidden');
    $('#joinVoiceBtn').classList.add('hidden');
    $('#voiceStatus').textContent = 'Conectado';
  }else if(state.joinedVoiceId){
    // Você continua na call antiga enquanto apenas visualiza outro canal.
    $('#voiceControls').classList.add('hidden');
    $('#joinVoiceBtn').classList.remove('hidden');
    $('#joinVoiceBtn').textContent = 'Trocar para este canal';
    $('#voiceStatus').textContent = 'Você já está em outra call';
  }else{
    $('#voiceControls').classList.add('hidden');
    $('#joinVoiceBtn').classList.remove('hidden');
    $('#joinVoiceBtn').textContent = 'Entrar na voz';
  }

  updateCallDock();
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
  const role = primaryRoleForUser(m.username);

  strong.textContent = role
    ? '[' + role.name + '] ' + m.username
    : m.username;

  if(role){
    strong.style.color = role.color;
  }
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
    remove.addEventListener('click',()=>{
      if(confirm('Remover ' + profile.username + ' dos amigos?')){
        removeFriend(friend);
      }
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

  $('#dmInput').disabled=false;
  $('#dmSendBtn').disabled=false;
  $('#dmInput').placeholder='Mensagem em ' + (group.name || 'grupo');
  $('#dmMessages').innerHTML='';

  socket.emit('group-history',{groupId:group.id});
  $('#dmInput').focus();
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

  const search = String($('#dmSearch')?.value || '').trim().toLowerCase();
  const friends = getFriends().filter(friend =>
    !search || String(friend.username || '').toLowerCase().includes(search)
  );

  const groups = (state.privateGroups || []).filter(group =>
    !search || String(group.name || '').toLowerCase().includes(search)
  );

  box.innerHTML = '';

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
    const empty = document.createElement('div');
    empty.style.cssText='color:var(--low);font-size:12px;padding:12px 5px;';
    empty.textContent='Adicione amigos ou crie um grupo privado.';
    box.appendChild(empty);
  }
}

function openDm(profile){
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
  $('#dmMessages').innerHTML = '';

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

  socket.emit('dm-message',{
    targetUserId:state.dmTarget.id,
    targetUsername:state.dmTarget.username,
    text
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
    remove.addEventListener('click', ()=>{
      if(confirm('Excluir o cargo "' + role.name + '"?')){
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
    category:['Criar categoria','Digite o nome da nova categoria.','Ex.: Jogos'],
    friend:['Adicionar amigo','Digite exatamente o nome do seu amigo no e-cord.','Ex.: Davi'],
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
  const server = currentServer();

  if(!server?.inviteToken){
    toast('Convite indisponível');
    return;
  }

  const url = new URL(location.origin + location.pathname);
  url.searchParams.set('invite',server.inviteToken);

  try{
    await navigator.clipboard.writeText(url.toString());
    toast('Convite privado copiado');
  }catch{
    prompt('Copie este convite privado:',url.toString());
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



function getPeerVolume(peerId){
  const current = Number(state.peerVolumes.get(peerId));
  return Number.isFinite(current) ? Math.max(0,Math.min(2,current)) : 1;
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

    source.connect(gain);
    gain.connect(context.destination);

    state.peerAudioNodes.set(peerId,{
      source,
      gain,
      stream
    });

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
    state.activeVoiceServerId = null;
    state.activeVoiceChannelId = null;
    state.activeVoiceName = 'Chamada com ' + state.privatePeerName;

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

    updateCallDock();
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
    button.textContent = muted ? '🔇 Áudio mutado' : '🔊 Áudio';
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

    state.joinedVoiceId = channel.id;
    state.activeVoiceServerId = state.serverId;
    state.activeVoiceChannelId = channel.id;
    state.activeVoiceName = channel.name || 'Canal de voz';

    $('#voiceControls').classList.remove('hidden');
    $('#joinVoiceBtn').classList.add('hidden');
    $('#voiceStatus').textContent = 'Conectando...';

    ensureCard('local',state.username+' (você)',state.localStream,true);

    unlockAllRemoteAudio();

    socket.emit('join-voice',{
      serverId:state.activeVoiceServerId,
      channelId:state.activeVoiceChannelId,
      username:state.username
    });

    updateCallDock();
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

  for(const peerId of [...state.peerAudioNodes.keys()]){
    disconnectPeerAudioNode(peerId);
  }
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
  state.peerVolumes.clear();
  state.deafened = false;
  applyDeafenState();
  state.activeVoiceServerId = null;
  state.activeVoiceChannelId = null;
  state.activeVoiceName = '';
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
  updateCallDock();

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

      controls.append(minus,value,plus);
      row.appendChild(controls);
    }

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

  // Em abertura normal começa em Amigos.
  // Em F5, mantém servidor/canal/aba que estavam abertos.
  if(!state.restoringReload){
    setAppMode('hub');
    setView('friends');
  }else{
    setAppMode(isServerView(state.currentView) ? 'server' : 'hub');
  }

  socket.emit('set-profile',{
    userId:state.userId,
    username:state.username,
    bio:state.bio,
    avatar:state.avatar,
    knownServerIds:getCachedServers().map(server=>server.id)
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
$('#serverRolesBtn').addEventListener('click',()=>setView('roles'));

$('#createCategoryQuickBtn').addEventListener('click',()=>openModal('category'));
$('#createTextQuickBtn').addEventListener('click',()=>openModal('text'));
$('#createVoiceQuickBtn').addEventListener('click',()=>openModal('voice'));

$('#homeCreateText').addEventListener('click',()=>openModal('text'));
$('#homeCreateVoice').addEventListener('click',()=>openModal('voice'));
$('#modalCancel').addEventListener('click',closeModal);
$('#modalOk').addEventListener('click',confirmModal);
$('#modalInput').addEventListener('keydown',e=>{if(e.key==='Enter')confirmModal();if(e.key==='Escape')closeModal()});
$('#modalWrap').addEventListener('click',e=>{if(e.target===$('#modalWrap'))closeModal()});

$('#profileBtn').addEventListener('click',openProfileModal);
$('#profileCancelBtn').addEventListener('click',closeProfileModal);
$('#profileSaveBtn').addEventListener('click',saveProfile);

$('#profileInfoTabBtn').addEventListener('click',()=>{
  setProfileTab('profile');
});

$('#profileAppearanceTabBtn').addEventListener('click',()=>{
  setProfileTab('appearance');
});

document.querySelectorAll('[data-profile-theme]').forEach(button=>{
  button.addEventListener('click',()=>{
    previewProfileTheme(button.dataset.profileTheme);
  });
});
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
  setView('dm');
  renderDmContacts();
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
$('#sendBtn').addEventListener('click',sendMessage);
$('#messageInput').addEventListener('keydown',e=>{if(e.key==='Enter')sendMessage()});

$('#dmSearch').addEventListener('input',renderDmContacts);
$('#dmSendBtn').addEventListener('click',sendDm);
$('#dmInput').addEventListener('keydown',event=>{
  if(event.key==='Enter') sendDm();
});
$('#joinVoiceBtn').addEventListener('click',joinVoice);
$('#leaveVoiceBtn').addEventListener('click',leaveVoice);
$('#returnToCallBtn').addEventListener('click',returnToActiveCall);
$('#dockLeaveCallBtn').addEventListener('click',leaveVoice);
$('#micBtn').addEventListener('click',toggleMic);
$('#deafenBtn').addEventListener('click',toggleDeafen);
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

  if(!$('#friendsView').classList.contains('hidden')){
    renderActiveFriends();
  }
});

socket.on('profile-saved',profile=>{
  if(!profile) return;

  state.profileReady = true;
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
  restoreCurrentView();

  // Garantia extra para F5: agora que o usuário está identificado,
  // solicita novamente apenas os servidores aos quais ele tem acesso.
  socket.emit('get-servers');
  socket.emit('get-friend-state');

  if(!state.privateInviteHandled){
    const token = new URLSearchParams(location.search).get('invite');

    if(token){
      state.privateInviteHandled = true;
      socket.emit('join-server-invite',{token});
    }
  }

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
  const incomingFriends = normalizeFriendList(payload?.friends || []);
  const cachedFriends = readFriendCache();

  state.incomingFriendRequests = Array.isArray(payload?.incoming) ? payload.incoming : [];
  state.outgoingFriendRequests = Array.isArray(payload?.outgoing) ? payload.outgoing : [];
  state.friendStateLoaded = true;

  if(incomingFriends.length){
    state.serverFriends = incomingFriends;
    saveFriends(incomingFriends);
    state.friendsRestoreAttempted = false;
  }else if(cachedFriends.length){
    // Uma resposta vazia não apaga os amigos.
    // Mantém o backup local e tenta reconstruir a relação no servidor.
    state.serverFriends = cachedFriends;

    if(!state.friendsRestoreAttempted){
      state.friendsRestoreAttempted = true;

      socket.emit('restore-friends',{
        friends:cachedFriends
      });
    }
  }else{
    state.serverFriends = [];
    localStorage.setItem('ecord-friends','[]');
  }

  renderFriends();
  renderActiveFriends();
  renderDmContacts();
});

// Compatibilidade com resposta antiga, sem adicionar automaticamente.
socket.on('friend-lookup-result',result=>{
  if(!result?.ok){
    toast(result?.error || 'Essa pessoa não existe no e-cord');
  }
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

socket.on('dm-history',history=>{
  $('#dmMessages').innerHTML='';
  (Array.isArray(history) ? history : []).forEach(appendDmMessage);
});

socket.on('dm-message',message=>{
  if(!message) return;

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
  // Ignora listas recebidas antes da identificação do usuário.
  // Isso impede o F5 de limpar os servidores por uma atualização concorrente.
  if(!state.profileReady) return;

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

  const previousServerId = state.serverId;
  const previousView = state.currentView || 'friends';

  state.servers = incoming;

  if(incoming.length){
    cacheServers(state.servers);
  }

  const params = new URLSearchParams(location.search);
  const requested =
    params.get('server') ||
    localStorage.getItem('ecord-last-server-id');

  // Nenhum servidor recebido nesta atualização.
  if(!state.servers.length){
    const cached = getCachedServers();

    // Uma atualização vazia não pode apagar/resetar servidores já conhecidos.
    if(cached.length){
      state.servers = cached;

      state.serverId =
        cached.some(server=>server.id===previousServerId)
          ? previousServerId
          : (
              cached.some(server=>server.id===requested)
                ? requested
                : cached[0].id
            );

      const selected = state.servers.find(server=>server.id===state.serverId);

      if(selected){
        const lastText = localStorage.getItem(
          'ecord-server-' + state.serverId + '-text'
        );

        const lastVoice = localStorage.getItem(
          'ecord-server-' + state.serverId + '-voice'
        );

        state.textChannelId =
          selected.textChannels?.some(channel=>channel.id===lastText)
            ? lastText
            : (selected.textChannels?.[0]?.id || null);

        state.voiceChannelId =
          selected.voiceChannels?.some(channel=>channel.id===lastVoice)
            ? lastVoice
            : (selected.voiceChannels?.[0]?.id || null);
      }

      renderServers();
      renderSidebar();
      renderRoles();

      state.currentView = previousView;
      state.appInitialized = true;
      restoreCurrentView();
      return;
    }

    state.serverId = null;
    state.textChannelId = null;
    state.voiceChannelId = null;

    renderServers();
    renderSidebar();
    renderRoles();

    state.appInitialized = true;

    if(isServerView(previousView)){
      setView('friends');
    }else{
      restoreCurrentView();
    }

    return;
  }

  // Mantém o mesmo servidor sempre que ele ainda existe.
  let selected =
    state.servers.find(server=>server.id===previousServerId) ||
    state.servers.find(server=>server.id===requested) ||
    state.servers[0];

  state.serverId = selected.id;
  localStorage.setItem('ecord-last-server-id',state.serverId);

  // Mantém o mesmo canal se ele ainda existir.
  const textStillExists = selected.textChannels?.some(
    channel=>channel.id===state.textChannelId
  );

  if(!textStillExists){
    state.textChannelId = selected.textChannels?.[0]?.id || null;
  }

  if(state.textChannelId){
    localStorage.setItem('ecord-last-text-channel-id',state.textChannelId);
  }

  const voiceStillExists = selected.voiceChannels?.some(
    channel=>channel.id===state.voiceChannelId
  );

  if(!voiceStillExists){
    state.voiceChannelId = selected.voiceChannels?.[0]?.id || null;
  }

  if(state.voiceChannelId){
    localStorage.setItem('ecord-last-voice-channel-id',state.voiceChannelId);
  }

  renderServers();
  renderSidebar();
  renderRoles();

  // Atualizações de dados não mudam a navegação escolhida.
  state.currentView = previousView;
  state.appInitialized = true;
  restoreCurrentView();
});

socket.on('invite-joined',({serverId,serverName})=>{
  toast('Você entrou em ' + (serverName || 'um servidor'));

  const url = new URL(location.href);
  url.searchParams.delete('invite');
  history.replaceState(null,'',url);

  socket.emit('get-servers');

  setTimeout(()=>{
    if(serverId) selectServer(serverId);
  },120);
});

socket.on('permission-error',data=>{
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

socket.on('voice-members',members=>{
  renderMembers(members);
});



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

  // No F5, primeiro identificamos o usuário.
  // O backend envia a lista de servidores somente depois disso.
  if(state.username){
    socket.emit('set-profile',{
      userId:state.userId,
      username:state.username,
      bio:state.bio,
      avatar:state.avatar,
      knownServerIds:getCachedServers().map(server=>server.id)
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
    }else if(state.activeVoiceServerId && state.activeVoiceChannelId){
      socket.emit('join-voice',{
        serverId:state.activeVoiceServerId,
        channelId:state.activeVoiceChannelId,
        username:state.username
      });
    }
  }

  // Uma reconexão de internet não pode trocar a aba atual.
  setTimeout(()=>{
    if(state.appInitialized){
      restoreCurrentView();
    }
  },150);
});
</script>
</body>
</html>`;

app.get('/', (req, res) => {
  res.type('html').send(APP_HTML);
});

io.on('connection', socket => {
  broadcastOnlineUsers();

  socket.on('set-username', ({ username }) => {
    socket.data.username = cleanName(username);
    broadcastOnlineUsers();
  });

  socket.on('set-profile', ({ userId, username, bio, avatar, knownServerIds }) => {
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

    const knownIds = new Set(
      Array.isArray(knownServerIds)
        ? knownServerIds.map(value=>String(value || '').slice(0,80))
        : []
    );

    for (const serverData of servers.values()) {
      const legacyServer =
        !serverData.ownerId &&
        (!Array.isArray(serverData.members) || !serverData.members.length);

      if (legacyServer && knownIds.has(serverData.id)) {
        serverData.ownerId = safeId;
        serverData.members = [safeId];

        if (!serverData.inviteToken) {
          serverData.inviteToken = crypto.randomBytes(18).toString('hex');
        }
      }
    }

    saveServersToDisk();
    socket.emit('profile-saved', publicProfile(profile));
    sendServerList(socket);
    emitFriendState(safeId);
    emitGroupState(safeId);
    broadcastServerLists();
    broadcastOnlineUsers();
  });

  socket.on('restore-friends', ({ friends }) => {
    if (!socket.data.userId || !Array.isArray(friends)) return;

    const ownerId = socket.data.userId;
    let changed = false;

    for (const rawFriend of friends.slice(0,500)) {
      const friendId = String(rawFriend?.id || '').trim().slice(0,100);
      const username = cleanName(rawFriend?.username,'Usuário');

      if (!friendId || friendId === ownerId) continue;

      // Se o perfil do amigo sumiu após reinício do servidor,
      // restaura os dados públicos guardados no navegador.
      if (!profiles.has(friendId)) {
        profiles.set(friendId,{
          id:friendId,
          username,
          bio:String(rawFriend?.bio || '').trim().slice(0,160),
          avatar:String(rawFriend?.avatar || '').slice(0,350000)
        });
        changed = true;
      }

      if (!areFriends(ownerId,friendId)) {
        friendships.push({
          a:ownerId,
          b:friendId,
          at:Date.now()
        });
        changed = true;
      }
    }

    if (changed) {
      saveServersToDisk();
    }

    emitFriendState(ownerId);

    for (const friend of friends.slice(0,500)) {
      const friendId = String(friend?.id || '').trim().slice(0,100);
      if (friendId) emitFriendState(friendId);
    }
  });

  socket.on('friend-request-send', ({ username }) => {
    if (!socket.data.userId) return;

    const target = findProfileByUsername(username);

    if (!target) {
      socket.emit('friend-request-result',{
        ok:false,
        error:'Essa pessoa não existe no e-cord'
      });
      return;
    }

    if (target.id === socket.data.userId) {
      socket.emit('friend-request-result',{
        ok:false,
        error:'Você não pode adicionar você mesmo'
      });
      return;
    }

    if (areFriends(socket.data.userId,target.id)) {
      socket.emit('friend-request-result',{
        ok:false,
        error:'Essa pessoa já é sua amiga'
      });
      return;
    }

    const reverse = friendRequests.find(request =>
      request.fromUserId === target.id &&
      request.toUserId === socket.data.userId
    );

    if (reverse) {
      socket.emit('friend-request-result',{
        ok:false,
        error:'Essa pessoa já enviou uma solicitação para você. Abra Pendentes para aceitar.'
      });
      return;
    }

    const existing = friendRequests.find(request =>
      request.fromUserId === socket.data.userId &&
      request.toUserId === target.id
    );

    if (existing) {
      socket.emit('friend-request-result',{
        ok:false,
        error:'Solicitação já enviada'
      });
      return;
    }

    friendRequests.push({
      id:id(),
      fromUserId:socket.data.userId,
      toUserId:target.id,
      at:Date.now()
    });

    saveServersToDisk();
    emitFriendState(socket.data.userId);
    emitFriendState(target.id);

    socket.emit('friend-request-result',{
      ok:true,
      message:'Solicitação enviada. A pessoa precisa aceitar.'
    });
  });

  socket.on('friend-request-accept', ({ requestId }) => {
    if (!socket.data.userId) return;

    const index = friendRequests.findIndex(request =>
      request.id === requestId &&
      request.toUserId === socket.data.userId
    );

    if (index < 0) return;

    const request = friendRequests[index];

    friendRequests.splice(index,1);

    if (!areFriends(request.fromUserId,request.toUserId)) {
      friendships.push({
        a:request.fromUserId,
        b:request.toUserId,
        at:Date.now()
      });
    }

    // Remove qualquer solicitação duplicada entre as mesmas duas pessoas.
    for (let i = friendRequests.length - 1; i >= 0; i--) {
      const item = friendRequests[i];

      if (
        (
          item.fromUserId === request.fromUserId &&
          item.toUserId === request.toUserId
        ) ||
        (
          item.fromUserId === request.toUserId &&
          item.toUserId === request.fromUserId
        )
      ) {
        friendRequests.splice(i,1);
      }
    }

    saveServersToDisk();
    emitFriendState(request.fromUserId);
    emitFriendState(request.toUserId);
  });

  socket.on('friend-request-decline', ({ requestId }) => {
    if (!socket.data.userId) return;

    const index = friendRequests.findIndex(request =>
      request.id === requestId &&
      request.toUserId === socket.data.userId
    );

    if (index < 0) return;

    const request = friendRequests[index];
    friendRequests.splice(index,1);

    saveServersToDisk();
    emitFriendState(request.fromUserId);
    emitFriendState(request.toUserId);
  });

  socket.on('friend-remove', ({ targetUserId, targetUsername }) => {
    if (!socket.data.userId) return;

    let targetId = String(targetUserId || '').slice(0,100);

    if (!targetId && targetUsername) {
      targetId = findProfileByUsername(targetUsername)?.id || '';
    }

    if (!targetId) return;

    for (let i = friendships.length - 1; i >= 0; i--) {
      const pair = friendships[i];

      if (
        (pair.a === socket.data.userId && pair.b === targetId) ||
        (pair.a === targetId && pair.b === socket.data.userId)
      ) {
        friendships.splice(i,1);
      }
    }

    saveServersToDisk();
    emitFriendState(socket.data.userId);
    emitFriendState(targetId);
  });

  // Compatibilidade com versões antigas do cliente.
  socket.on('friend-lookup', ({ userId, username }) => {
    const profile = findProfileByUsername(username);

    socket.emit('friend-lookup-result', profile && profile.id !== String(userId || '')
      ? {ok:true,profile:publicProfile(profile)}
      : {ok:false,error:'Essa pessoa não existe no e-cord'}
    );
  });

  socket.on('group-create', ({ name, memberIds }) => {
    if (!socket.data.userId) return;

    const ownerId = socket.data.userId;
    const requested = Array.isArray(memberIds)
      ? [...new Set(memberIds.map(value=>String(value || '').slice(0,100)).filter(Boolean))]
      : [];

    if (requested.length > 9) {
      socket.emit('group-error',{error:'O grupo pode ter no máximo 10 pessoas contando com você'});
      return;
    }

    const selected = requested.filter(userId => userId !== ownerId);

    if (!selected.length) {
      socket.emit('group-error',{error:'Escolha pelo menos 1 amigo'});
      return;
    }

    const invalid = selected.find(userId => !areFriends(ownerId,userId));

    if (invalid) {
      socket.emit('group-error',{error:'Só é possível adicionar amigos aceitos'});
      return;
    }

    const group = {
      id:id(),
      name:String(name || 'Grupo privado').trim().slice(0,40) || 'Grupo privado',
      ownerId,
      members:[ownerId,...selected].slice(0,10),
      createdAt:Date.now(),
      messages:[]
    };

    privateGroups.set(group.id,group);
    saveServersToDisk();
    emitGroupStateToMembers(group);

    socket.emit('group-created',{group:publicPrivateGroup(group)});
  });

  socket.on('group-history', ({ groupId }) => {
    if (!socket.data.userId) return;

    const group = privateGroups.get(String(groupId || '').slice(0,80));

    if (!group || !(group.members || []).includes(socket.data.userId)) {
      socket.emit('group-error',{error:'Você não faz parte deste grupo'});
      return;
    }

    socket.emit('group-history',{
      groupId:group.id,
      messages:(group.messages || []).slice(-300)
    });
  });

  socket.on('group-message', ({ groupId, text }) => {
    if (!socket.data.userId) return;

    const group = privateGroups.get(String(groupId || '').slice(0,80));

    if (!group || !(group.members || []).includes(socket.data.userId)) {
      socket.emit('group-error',{error:'Você não faz parte deste grupo'});
      return;
    }

    const safeText = String(text || '').trim().slice(0,1000);
    if (!safeText) return;

    const message = {
      id:id(),
      groupId:group.id,
      userId:socket.data.userId,
      username:socket.data.username || 'Usuário',
      text:safeText,
      at:Date.now()
    };

    group.messages.push(message);
    while (group.messages.length > 500) group.messages.shift();

    saveServersToDisk();

    for (const client of io.sockets.sockets.values()) {
      if ((group.members || []).includes(client.data.userId)) {
        client.emit('group-message',message);
      }
    }
  });

  socket.on('get-friend-state', () => {
    if (!socket.data.userId) return;
    emitFriendState(socket.data.userId);
  });

  socket.on('get-servers', () => {
    sendServerList(socket);
  });

  socket.on('restore-servers', ({ servers: restored }) => {
    if (!Array.isArray(restored) || !socket.data.userId) return;

    for (const rawItem of restored.slice(0, 100)) {
      if (!rawItem?.id) continue;

      const item = { ...rawItem };
      const cachedOwnerId = String(item.ownerId || '');

      if (cachedOwnerId && cachedOwnerId !== String(socket.data.userId)) {
        continue;
      }

      if (!cachedOwnerId) {
        item.ownerId = socket.data.userId;
        item.members = [
          ...new Set([
            socket.data.userId,
            ...(Array.isArray(item.members) ? item.members : [])
          ])
        ];
      }

      if (!item.inviteToken) {
        item.inviteToken = crypto.randomBytes(18).toString('hex');
      }

      mergeRestoredServer(item);
    }

    saveServersToDisk();
    broadcastServerLists();
  });

  socket.on('create-server', ({ name }) => {
    if (!socket.data.userId) return;

    const created = makeServer(
      cleanName(name, 'Novo servidor'),
      {
        ownerId:socket.data.userId,
        members:[socket.data.userId]
      }
    );

    saveServersToDisk();
    broadcastServerLists();
    socket.emit('server-created', { serverId: created.id });
  });

  socket.on('join-server-invite', ({ token }) => {
    if (!socket.data.userId) return;

    const safeToken = String(token || '').trim().slice(0,100);

    const serverData = [...servers.values()].find(item =>
      item.inviteToken === safeToken
    );

    if (!serverData) {
      socket.emit('permission-error',{
        error:'Convite inválido ou expirado'
      });
      return;
    }

    if (!(serverData.members || []).includes(socket.data.userId)) {
      serverData.members.push(socket.data.userId);
      serverData.members = [...new Set(serverData.members)];
      saveServersToDisk();
    }

    sendServerList(socket);

    socket.emit('invite-joined',{
      serverId:serverData.id,
      serverName:serverData.name
    });
  });

  socket.on('update-server-settings', ({ serverId, name, icon, accent, description, tags }) => {
    const safeId = String(serverId || '').slice(0,80);
    const serverData = servers.get(safeId);

    if (!serverData || !requireServerAccess(serverData,socket)) return;

    if (!hasServerPermission(serverData,socket,'manageServer')) {
      permissionDenied(socket);
      return;
    }

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
    broadcastServerLists();

    socket.emit('server-settings-updated',{
      serverId:safeId,
      message:'Configurações salvas'
    });
  });

  socket.on('delete-server', ({ serverId }) => {
    const safeId = String(serverId || '').slice(0, 80);
    const serverData = servers.get(safeId);
    if (!serverData) return;

    if (serverData.ownerId !== socket.data.userId) {
      permissionDenied(socket);
      return;
    }

    servers.delete(safeId);
    saveServersToDisk();

    socket.emit('server-deleted', { serverId: safeId });
    broadcastServerLists();
  });

  socket.on('create-role', ({ serverId, name, color, permissions }) => {
    const s = servers.get(serverId);
    if (!s || !requireServerAccess(s,socket)) return;

    if (!hasServerPermission(s,socket,'manageRoles')) {
      permissionDenied(socket);
      return;
    }

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
      members: [],
      permissions:{
        administrator:!!permissions?.administrator,
        manageServer:!!permissions?.manageServer,
        manageChannels:!!permissions?.manageChannels,
        manageRoles:!!permissions?.manageRoles
      }
    });

    saveServersToDisk();
    broadcastServerUpdate(s);
    socket.emit('role-updated', { message: 'Cargo criado' });
  });

  socket.on('update-role', ({ serverId, roleId, name, color, permissions }) => {
    const s = servers.get(serverId);
    if (!s || !requireServerAccess(s,socket)) return;

    if (!hasServerPermission(s,socket,'manageRoles')) {
      permissionDenied(socket);
      return;
    }

    const role = s.roles.find(item=>item.id===roleId);
    if (!role) return;

    role.name = cleanName(name,role.name || 'Cargo');
    role.color = /^#[0-9a-f]{6}$/i.test(String(color || ''))
      ? String(color)
      : role.color;

    role.permissions = {
      administrator:!!permissions?.administrator,
      manageServer:!!permissions?.manageServer,
      manageChannels:!!permissions?.manageChannels,
      manageRoles:!!permissions?.manageRoles
    };

    saveServersToDisk();
    broadcastServerUpdate(s);
    socket.emit('role-updated',{message:'Cargo atualizado'});
  });

  socket.on('assign-role', ({ serverId, roleId, username }) => {
    const s = servers.get(serverId);
    if (!s || !requireServerAccess(s,socket)) return;

    if (!hasServerPermission(s,socket,'manageRoles')) {
      permissionDenied(socket);
      return;
    }

    const role = s.roles.find(item => item.id === roleId);
    if (!role) return;

    const safeUsername = cleanName(username);
    const targetProfile = findProfileByUsername(safeUsername);

    if (!targetProfile) {
      socket.emit('permission-error',{error:'Esse usuário não existe no e-cord'});
      return;
    }

    if (
      targetProfile.id !== s.ownerId &&
      !(s.members || []).includes(targetProfile.id)
    ) {
      socket.emit('permission-error',{error:'Essa pessoa não faz parte deste servidor'});
      return;
    }

    const exists = role.members.some(
      member => member.toLowerCase() === safeUsername.toLowerCase()
    );

    if (!exists) {
      role.members.push(safeUsername);
      role.members = role.members.slice(0, 100);
    }

    saveServersToDisk();
    broadcastServerUpdate(s);
    socket.emit('role-updated', { message: 'Cargo atribuído a ' + safeUsername });
  });

  socket.on('remove-role', ({ serverId, roleId }) => {
    const s = servers.get(serverId);
    if (!s || !requireServerAccess(s,socket)) return;

    if (!hasServerPermission(s,socket,'manageRoles')) {
      permissionDenied(socket);
      return;
    }

    const before = s.roles.length;
    s.roles = s.roles.filter(role => role.id !== roleId);

    if (s.roles.length !== before) {
      saveServersToDisk();
      broadcastServerUpdate(s);
      socket.emit('role-updated', { message: 'Cargo excluído' });
    }
  });

  socket.on('create-category', ({ serverId, name }) => {
    const s = servers.get(serverId);
    if (!s || !requireServerAccess(s,socket)) return;

    if (!hasServerPermission(s,socket,'manageChannels')) {
      permissionDenied(socket);
      return;
    }

    const category = {
      id: id(),
      name: cleanName(name, 'Categoria'),
      order: s.categories.length
    };

    s.categories.push(category);
    saveServersToDisk();

    broadcastServerLists();
    socket.emit('category-updated', { message: 'Categoria criada' });
  });

  socket.on('delete-category', ({ serverId, categoryId }) => {
    const s = servers.get(serverId);
    if (!s || !requireServerAccess(s,socket)) return;

    if (!hasServerPermission(s,socket,'manageChannels')) {
      permissionDenied(socket);
      return;
    }

    const safeCategoryId = String(categoryId || '').slice(0,80);

    s.categories = s.categories.filter(category => category.id !== safeCategoryId);

    for (const channel of [...s.textChannels, ...s.voiceChannels]) {
      if (channel.categoryId === safeCategoryId) {
        channel.categoryId = null;
      }
    }

    s.categories.forEach((category,index)=>category.order=index);

    saveServersToDisk();
    broadcastServerLists();
    socket.emit('category-updated', { message: 'Categoria excluída' });
  });

  socket.on('move-category', ({ serverId, categoryId, beforeCategoryId }) => {
    const s = servers.get(serverId);
    if (!s || !requireServerAccess(s,socket)) return;

    if (!hasServerPermission(s,socket,'manageChannels')) {
      permissionDenied(socket);
      return;
    }

    const sourceIndex = s.categories.findIndex(category => category.id === categoryId);
    if (sourceIndex < 0) return;

    const [moving] = s.categories.splice(sourceIndex,1);

    let targetIndex = s.categories.findIndex(category => category.id === beforeCategoryId);
    if (targetIndex < 0) targetIndex = s.categories.length;

    s.categories.splice(targetIndex,0,moving);
    s.categories.forEach((category,index)=>category.order=index);

    saveServersToDisk();
    broadcastServerLists();
    socket.emit('category-updated', { message: 'Categoria movida' });
  });

  socket.on('move-channel', ({ serverId, type, channelId, targetCategoryId, beforeChannelId }) => {
    const s = servers.get(serverId);
    if (!s || !requireServerAccess(s,socket)) return;

    if (!hasServerPermission(s,socket,'manageChannels')) {
      permissionDenied(socket);
      return;
    }

    const list = type === 'voice' ? s.voiceChannels : s.textChannels;
    const sourceIndex = list.findIndex(channel => channel.id === channelId);
    if (sourceIndex < 0) return;

    const [moving] = list.splice(sourceIndex,1);

    const validCategory =
      targetCategoryId &&
      s.categories.some(category => category.id === targetCategoryId)
        ? targetCategoryId
        : null;

    moving.categoryId = validCategory;

    let targetIndex = -1;

    if (beforeChannelId) {
      targetIndex = list.findIndex(channel => channel.id === beforeChannelId);
    }

    if (targetIndex < 0) {
      const sameCategoryIndexes = list
        .map((channel,index)=>({channel,index}))
        .filter(item => (item.channel.categoryId || null) === validCategory)
        .map(item=>item.index);

      targetIndex = sameCategoryIndexes.length
        ? Math.max(...sameCategoryIndexes) + 1
        : list.length;
    }

    list.splice(Math.min(targetIndex,list.length),0,moving);

    list.forEach((channel,index)=>channel.order=index);

    saveServersToDisk();
    broadcastServerLists();
    socket.emit('category-updated', { message: 'Canal movido' });
  });

  socket.on('create-channel', ({ serverId, type, name }) => {
    const s = servers.get(serverId);
    if (!s || !requireServerAccess(s,socket)) return;

    if (!hasServerPermission(s,socket,'manageChannels')) {
      permissionDenied(socket);
      return;
    }

    if (type === 'text') {
      const channel = {
        id: id(),
        name: cleanChannel(name, 'novo-chat'),
        categoryId: null,
        order: s.textChannels.length
      };
      s.textChannels.push(channel);
      s.messages.set(channel.id, []);
      saveServersToDisk();
      broadcastServerLists();
      socket.emit('channel-created', { serverId, type: 'text', channelId: channel.id });
      return;
    }

    if (type === 'voice') {
      const channel = {
        id: id(),
        name: cleanName(name, 'Nova voz'),
        categoryId: null,
        order: s.voiceChannels.length
      };
      s.voiceChannels.push(channel);
      saveServersToDisk();
      broadcastServerLists();
      socket.emit('channel-created', { serverId, type: 'voice', channelId: channel.id });
    }
  });

  socket.on('dm-history', ({ targetUserId, targetUsername }) => {
    if (!socket.data.userId) return;

    let targetId = String(targetUserId || '').slice(0,100);

    if (!targetId && targetUsername) {
      targetId = findProfileByUsername(targetUsername)?.id || '';
    }

    if (!targetId) {
      socket.emit('dm-history',[]);
      return;
    }

    const history = directMessages
      .filter(message =>
        (
          message.fromUserId===socket.data.userId &&
          message.toUserId===targetId
        ) ||
        (
          message.fromUserId===targetId &&
          message.toUserId===socket.data.userId
        )
      )
      .slice(-200);

    socket.emit('dm-history',history);
  });

  socket.on('dm-message', ({ targetUserId, targetUsername, text }) => {
    if (!socket.data.userId) return;

    let targetProfile = targetUserId
      ? profiles.get(String(targetUserId).slice(0,100))
      : null;

    if (!targetProfile && targetUsername) {
      targetProfile = findProfileByUsername(targetUsername);
    }

    if (!targetProfile) {
      socket.emit('permission-error',{error:'Esse usuário não existe'});
      return;
    }

    const safeText = String(text || '').trim().slice(0,1000);
    if (!safeText) return;

    const message = {
      id:id(),
      fromUserId:socket.data.userId,
      toUserId:targetProfile.id,
      fromUsername:socket.data.username || 'Usuário',
      text:safeText,
      at:Date.now()
    };

    directMessages.push(message);
    while(directMessages.length>5000) directMessages.shift();

    saveServersToDisk();

    socket.emit('dm-message',message);

    for (const client of io.sockets.sockets.values()) {
      if (client.data.userId===targetProfile.id) {
        client.emit('dm-message',message);
      }
    }
  });

  socket.on('join-text', ({ serverId, channelId }) => {
    const s = servers.get(serverId);
    if (!s || !requireServerAccess(s,socket) || !s.textChannels.some(c => c.id === channelId)) return;

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
    if (!s || !requireServerAccess(s,socket) || !s.textChannels.some(c => c.id === channelId)) return;

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
    if (!s || !requireServerAccess(s,socket) || !s.voiceChannels.some(c => c.id === channelId)) return;

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
