import { DurableObject } from "cloudflare:workers";
import * as crypto from "node:crypto";

const id=()=>crypto.randomBytes(5).toString('hex');

const servers=new Map();
const profiles=new Map();
const accounts=new Map();
const sessions=new Map();
const directMessages=[];
const auditLog=[];
const friendRequests=[];
const friendships=[];
const privateGroups=new Map();
const privateCalls=new Map();
const phoneCameraSessions=new Map();

const SESSION_LIFETIME_MS=1000*60*60*24*365;
const SESSION_GRACE_MS=1000*60*60*24*7;

let io=null;


function publicProfile(profile) {
  if(!profile) return null;
  return {
    id:profile.id,
    username:profile.username,
    displayName:profile.displayName||profile.username,
    bio:profile.bio||'',
    avatar:profile.avatar||'',
    banner:profile.banner||'',
    status:profile.status||'online',
    customStatus:String(profile.customStatus||'').slice(0,80),
    pronouns:String(profile.pronouns||'').slice(0,40),
    activity:String(profile.activity||'').slice(0,80),
    links:profile.links && typeof profile.links==='object' ? profile.links : {},
    privacy:profile.privacy && typeof profile.privacy==='object'
      ? profile.privacy
      : {dm:'friends',calls:'friends',friendRequests:'everyone'},
    createdAt:Number(profile.createdAt||Date.now())
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

function privacyAllows(targetId,sourceId,kind){
  const profile=profiles.get(String(targetId||''));if(!profile)return false;
  const setting=profile.privacy?.[kind]||'friends';
  if(setting==='everyone')return true;
  if(setting==='nobody')return false;
  return areFriends(targetId,sourceId);
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

function normalizeAccountUsername(value){
  return String(value || '').trim().replace(/\s+/g,' ').slice(0,30);
}

function usernameKey(value){
  return normalizeAccountUsername(value).toLocaleLowerCase('pt-BR');
}

function usernameExists(username, exceptId = null){
  const key = usernameKey(username);
  for(const account of accounts.values()){
    if(account.userId !== exceptId && account.usernameKey === key) return true;
  }
  return false;
}

function legacyProfileForUsername(username){
  const key=usernameKey(username);
  if(!key) return null;

  for(const profile of profiles.values()){
    if(usernameKey(profile?.username)===key && !accounts.has(profile.id)){
      return profile;
    }
  }

  return null;
}

function passwordDigest(password,salt){
  return crypto.scryptSync(
    String(password || ''),
    Buffer.from(String(salt || ''),'hex'),
    64
  ).toString('hex');
}

function verifyAccountPassword(password,account){
  try{
    const expected=Buffer.from(account.passwordHash,'hex');
    const actual=Buffer.from(passwordDigest(password,account.salt),'hex');
    return expected.length===actual.length && crypto.timingSafeEqual(expected,actual);
  }catch{return false}
}

function tokenHash(token){
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function newSession(userId){
  const token=crypto.randomBytes(32).toString('hex');
  const now=Date.now();

  sessions.set(tokenHash(token),{
    userId,
    createdAt:now,
    lastSeenAt:now,
    expiresAt:now + SESSION_LIFETIME_MS
  });

  return token;
}

function sessionUserId(token,{renew=true}={}){
  const rawToken=String(token || '');
  if(rawToken.length < 20) return null;

  const key=tokenHash(rawToken);
  const session=sessions.get(key);

  if(!session) return null;

  const now=Date.now();
  const expiresAt=Number(session.expiresAt || 0);

  if(!accounts.has(session.userId)){
    sessions.delete(key);
    return null;
  }

  // Pequena tolerância para uma aba que ficou aberta durante uma atualização/reconexão.
  if(expiresAt && expiresAt < now - SESSION_GRACE_MS){
    sessions.delete(key);
    return null;
  }

  if(renew){
    session.lastSeenAt=now;
    session.expiresAt=now + SESSION_LIFETIME_MS;
  }

  return session.userId;
}

function clearSessionsForUser(userId){
  for(const [key,session] of sessions){
    if(session.userId===userId) sessions.delete(key);
  }
}

function serializeAccounts(){
  return [...accounts.values()].map(account=>({
    userId:String(account.userId||'').slice(0,100),
    username:normalizeAccountUsername(account.username),
    usernameKey:usernameKey(account.username),
    salt:String(account.salt||'').slice(0,256),
    passwordHash:String(account.passwordHash||'').slice(0,256),
    createdAt:Number(account.createdAt||Date.now()),
    recoveredSessionOnly:!!account.recoveredSessionOnly
  }));
}

function serializeSessions(){
  return [...sessions.entries()].map(([hash,session])=>({
    hash:String(hash||'').slice(0,128),
    userId:String(session?.userId||'').slice(0,100),
    createdAt:Number(session?.createdAt||Date.now()),
    lastSeenAt:Number(session?.lastSeenAt||session?.createdAt||Date.now()),
    expiresAt:Number(session?.expiresAt||Date.now()+SESSION_LIFETIME_MS)
  }));
}

function recordAudit(serverId,action,actor,target=''){
  auditLog.push({
    id:id(),
    serverId:String(serverId||'').slice(0,80),
    action:String(action||'').slice(0,80),
    actor:String(actor||'').slice(0,30),
    target:String(target||'').slice(0,80),
    at:Date.now()
  });
  if(auditLog.length>2000) auditLog.splice(0,auditLog.length-2000);
}

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
        : index,
      mode: channel.mode === 'stage' ? 'stage' : 'voice'
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

function makeServer(name = 'Acord', options = {}) {
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
    messages,
    rules:String(options.rules||'').slice(0,4000),
    banner:String(options.banner||'').slice(0,350000),
    inviteExpiresAt:Number(options.inviteExpiresAt||0),
    bans:Array.isArray(options.bans)?options.bans.map(String).slice(0,500):[],
    mutes:Array.isArray(options.mutes)?options.mutes.map(String).slice(0,500):[],
    channelPolicies:options.channelPolicies && typeof options.channelPolicies==='object'
      ? options.channelPolicies
      : {},
    pinned:Array.isArray(options.pinned)?options.pinned.slice(-200):[],
    events:Array.isArray(options.events)?options.events.slice(-200):[],
    polls:Array.isArray(options.polls)?options.polls.slice(-200):[],
    watchParty:options.watchParty && typeof options.watchParty==='object'
      ? options.watchParty
      : {url:'',position:0,playing:false,updatedAt:0},
    whiteboard:Array.isArray(options.whiteboard)?options.whiteboard.slice(-2000):[],
    creative:options.creative && typeof options.creative==='object'
      ? options.creative
      : {}
  };

  servers.set(serverId, data);
  return data;
}

function serializeProfiles() {
  return [...profiles.values()].map(profile => ({
    id:String(profile.id||'').slice(0,100),
    username:String(profile.username||'Usuário').slice(0,30),
    displayName:String(profile.displayName||profile.username||'Usuário').slice(0,40),
    bio:String(profile.bio||'').slice(0,300),
    avatar:String(profile.avatar||'').slice(0,350000),
    banner:String(profile.banner||'').slice(0,350000),
    status:['online','away','busy','invisible'].includes(profile.status)?profile.status:'online',
    customStatus:String(profile.customStatus||'').slice(0,80),
    pronouns:String(profile.pronouns||'').slice(0,40),
    activity:String(profile.activity||'').slice(0,80),
    links:profile.links && typeof profile.links==='object'?profile.links:{},
    privacy:profile.privacy && typeof profile.privacy==='object'
      ? profile.privacy
      : {dm:'friends',calls:'friends',friendRequests:'everyone'},
    createdAt:Number(profile.createdAt||Date.now())
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
  return directMessages.slice(-20000).map(message => ({
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
    messages: Object.fromEntries(serverData.messages),
    rules:serverData.rules||'',
    banner:serverData.banner||'',
    inviteExpiresAt:Number(serverData.inviteExpiresAt||0),
    bans:serverData.bans||[],
    mutes:serverData.mutes||[],
    channelPolicies:serverData.channelPolicies||{},
    pinned:serverData.pinned||[],
    events:serverData.events||[],
    polls:serverData.polls||[],
    watchParty:serverData.watchParty||{url:'',position:0,playing:false,updatedAt:0},
    whiteboard:serverData.whiteboard||[],
    creative:serverData.creative&&typeof serverData.creative==='object'?serverData.creative:{}
  }));
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

  if(item.creative && typeof item.creative==='object'){
    existing.creative={
      ...(existing.creative||{}),
      ...item.creative
    };
  }

  return existing;
}

function publicServer(serverData) {
  const memberIds = [...new Set([
    serverData.ownerId,
    ...(serverData.members || [])
  ].filter(Boolean))];

  const memberProfiles = memberIds.map(memberId => {
    const profile = profiles.get(memberId);

    return {
      id:String(memberId).slice(0,100),
      username:profile?.username || 'Membro',
      bio:profile?.bio || '',
      avatar:profile?.avatar || ''
    };
  });

  return {
    id: serverData.id,
    ownerId: serverData.ownerId,
    members: serverData.members,
    memberProfiles,
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
    rules:serverData.rules||'',
    banner:serverData.banner||'',
    inviteExpiresAt:Number(serverData.inviteExpiresAt||0),
    bans:serverData.bans||[],
    mutes:serverData.mutes||[],
    channelPolicies:serverData.channelPolicies||{},
    pinned:serverData.pinned||[],
    events:serverData.events||[],
    polls:serverData.polls||[],
    watchParty:serverData.watchParty||{url:'',position:0,playing:false,updatedAt:0},
    creative:serverData.creative&&typeof serverData.creative==='object'?serverData.creative:{}
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

function syncSocketServerRooms(socket){
  if(!socket?.data?.userId) return;

  const allowedIds=new Set(
    publicServersForUser(socket.data.userId).map(server=>String(server.id))
  );

  for(const room of socket.rooms || []){
    if(
      String(room).startsWith('server:') &&
      !allowedIds.has(String(room).slice(7))
    ){
      socket.leave(room);
    }
  }

  for(const serverId of allowedIds){
    socket.join('server:'+serverId);
  }
}

function sendServerList(socket) {
  if (!socket?.data?.userId) return;

  syncSocketServerRooms(socket);
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


const SNAPSHOT_META_KEY='snapshot:meta';
const SNAPSHOT_CHARS=350000;

function resetPersistentState(){
  servers.clear();
  profiles.clear();
  accounts.clear();
  sessions.clear();
  directMessages.splice(0,directMessages.length);
  auditLog.splice(0,auditLog.length);
  friendRequests.splice(0,friendRequests.length);
  friendships.splice(0,friendships.length);
  privateGroups.clear();
  privateCalls.clear();
  phoneCameraSessions.clear();
}

function serializeSnapshot(){
  return {
    version:15,
    savedAt:Date.now(),
    servers:serializeServers(),
    profiles:serializeProfiles(),
    accounts:serializeAccounts(),
    sessions:serializeSessions(),
    auditLog:auditLog.slice(-2000),
    directMessages:serializeDirectMessages(),
    friendRequests:serializeFriendRequests(),
    friendships:serializeFriendships(),
    privateGroups:serializePrivateGroups(),
    privateCalls:[...privateCalls.entries()]
      .filter(([,call])=>Number(call?.expiresAt||0)>Date.now())
      .slice(-1000)
      .map(([callId,call])=>[String(callId).slice(0,100),call]),
    phoneCameraSessions:[...phoneCameraSessions.entries()]
      .filter(([,session])=>Number(session?.expiresAt||0)>Date.now())
      .slice(-1000)
      .map(([token,session])=>[String(token).slice(0,100),session])
  };
}

function hydrateSnapshot(parsed){
  try{
    resetPersistentState();
    if(!parsed || typeof parsed!=='object') return false;

    const list=Array.isArray(parsed.servers)?parsed.servers:[];
    const savedProfiles=Array.isArray(parsed.profiles)?parsed.profiles:[];
    const savedAccounts=Array.isArray(parsed.accounts)?parsed.accounts:[];
    const savedSessions=Array.isArray(parsed.sessions)?parsed.sessions:[];
    const savedAuditLog=Array.isArray(parsed.auditLog)?parsed.auditLog:[];
    const savedDirectMessages=Array.isArray(parsed.directMessages)?parsed.directMessages:[];
    const savedFriendRequests=Array.isArray(parsed.friendRequests)?parsed.friendRequests:[];
    const savedFriendships=Array.isArray(parsed.friendships)?parsed.friendships:[];
    const savedPrivateGroups=Array.isArray(parsed.privateGroups)?parsed.privateGroups:[];

    for(const rawAccount of savedAccounts.slice(0,5000)){
      const userId=String(rawAccount?.userId||'').slice(0,100);
      const username=normalizeAccountUsername(rawAccount?.username);
      const salt=String(rawAccount?.salt||'');
      const passwordHash=String(rawAccount?.passwordHash||'');
      if(!userId || username.length<3 || !salt || !passwordHash) continue;
      accounts.set(userId,{
        userId,
        username,
        usernameKey:usernameKey(username),
        salt,
        passwordHash,
        createdAt:Number(rawAccount?.createdAt||Date.now()),
        recoveredSessionOnly:!!rawAccount?.recoveredSessionOnly
      });
    }

    for(const rawSession of savedSessions.slice(0,10000)){
      const hash=String(rawSession?.hash||'').slice(0,128);
      const userId=String(rawSession?.userId||'').slice(0,100);
      const expiresAt=Number(rawSession?.expiresAt||0);
      if(
        !hash ||
        !userId ||
        !accounts.has(userId) ||
        (expiresAt && expiresAt<Date.now()-SESSION_GRACE_MS)
      ) continue;
      sessions.set(hash,{
        userId,
        createdAt:Number(rawSession?.createdAt||Date.now()),
        lastSeenAt:Number(rawSession?.lastSeenAt||rawSession?.createdAt||Date.now()),
        expiresAt:Math.max(expiresAt,Date.now()+SESSION_LIFETIME_MS)
      });
    }

    for(const entry of savedAuditLog.slice(-2000)){
      auditLog.push({
        id:String(entry?.id||id()).slice(0,80),
        serverId:String(entry?.serverId||'').slice(0,80),
        action:String(entry?.action||'').slice(0,80),
        actor:String(entry?.actor||'').slice(0,30),
        target:String(entry?.target||'').slice(0,80),
        at:Number(entry?.at||Date.now())
      });
    }

    for(const rawGroup of savedPrivateGroups.slice(0,2000)){
      const groupId=String(rawGroup?.id||'').slice(0,80);
      const ownerId=String(rawGroup?.ownerId||'').slice(0,100);
      const members=Array.isArray(rawGroup?.members)
        ? [...new Set(rawGroup.members.map(v=>String(v||'').slice(0,100)).filter(Boolean))].slice(0,10)
        : [];
      if(!groupId || !ownerId || !members.length) continue;
      if(!members.includes(ownerId)) members.unshift(ownerId);
      privateGroups.set(groupId,{
        id:groupId,
        name:String(rawGroup?.name||'Grupo').trim().slice(0,40)||'Grupo',
        ownerId,
        members:members.slice(0,10),
        createdAt:Number(rawGroup?.createdAt||Date.now()),
        messages:Array.isArray(rawGroup?.messages)
          ? rawGroup.messages.slice(-500).map(message=>({
              id:String(message?.id||id()).slice(0,80),
              userId:String(message?.userId||'').slice(0,100),
              username:cleanName(message?.username,'Usuário'),
              text:String(message?.text||'').slice(0,1000),
              at:Number(message?.at||Date.now())
            })).filter(message=>message.userId && message.text)
          : []
      });
    }

    for(const request of savedFriendRequests.slice(-5000)){
      if(!request?.fromUserId || !request?.toUserId) continue;
      friendRequests.push({
        id:String(request.id||id()).slice(0,80),
        fromUserId:String(request.fromUserId).slice(0,100),
        toUserId:String(request.toUserId).slice(0,100),
        at:Number(request.at||Date.now())
      });
    }

    for(const pair of savedFriendships.slice(0,10000)){
      if(!pair?.a || !pair?.b || pair.a===pair.b) continue;
      friendships.push({
        a:String(pair.a).slice(0,100),
        b:String(pair.b).slice(0,100),
        at:Number(pair.at||Date.now())
      });
    }

    for(const message of savedDirectMessages.slice(-20000)){
      if(!message?.fromUserId || !message?.toUserId || !message?.text) continue;
      directMessages.push({
        id:String(message.id||id()).slice(0,80),
        fromUserId:String(message.fromUserId).slice(0,100),
        toUserId:String(message.toUserId).slice(0,100),
        fromUsername:cleanName(message.fromUsername,'Usuário'),
        text:String(message.text).slice(0,1000),
        at:Number(message.at||Date.now())
      });
    }

    for(const raw of savedProfiles.slice(0,5000)){
      const profileId=String(raw?.id||'').trim().slice(0,100);
      if(!profileId) continue;
      profiles.set(profileId,{
        id:profileId,
        username:cleanName(raw?.username,'Usuário'),
        displayName:String(raw?.displayName||raw?.username||'Usuário').trim().slice(0,40),
        bio:String(raw?.bio||'').trim().slice(0,300),
        avatar:String(raw?.avatar||'').slice(0,350000),
        banner:String(raw?.banner||'').slice(0,350000),
        status:['online','away','busy','invisible'].includes(raw?.status)?raw.status:'online',
        customStatus:String(raw?.customStatus||'').slice(0,80),
        pronouns:String(raw?.pronouns||'').slice(0,40),
        activity:String(raw?.activity||'').slice(0,80),
        links:raw?.links && typeof raw.links==='object'?raw.links:{},
        privacy:raw?.privacy && typeof raw.privacy==='object'
          ? raw.privacy
          : {dm:'friends',calls:'friends',friendRequests:'everyone'},
        createdAt:Number(raw?.createdAt||Date.now())
      });
    }

    for(const item of list){
      makeServer(item.name,{
        id:item.id,
        ownerId:item.ownerId,
        members:item.members,
        inviteToken:item.inviteToken,
        icon:item.icon,
        accent:item.accent,
        description:item.description,
        tags:item.tags,
        textChannels:item.textChannels,
        voiceChannels:item.voiceChannels,
        categories:item.categories,
        roles:item.roles,
        messages:item.messages,
        rules:item.rules,
        banner:item.banner,
        inviteExpiresAt:item.inviteExpiresAt,
        bans:item.bans,
        mutes:item.mutes,
        channelPolicies:item.channelPolicies,
        pinned:item.pinned,
        events:item.events,
        polls:item.polls,
        watchParty:item.watchParty,
        whiteboard:item.whiteboard,
        creative:item.creative
      });
    }

    for(const pair of Array.isArray(parsed.privateCalls)?parsed.privateCalls:[]){
      if(!Array.isArray(pair) || pair.length!==2) continue;
      const [callId,call]=pair;
      if(Number(call?.expiresAt||0)<=Date.now()) continue;
      privateCalls.set(String(callId).slice(0,100),call);
    }

    for(const pair of Array.isArray(parsed.phoneCameraSessions)?parsed.phoneCameraSessions:[]){
      if(!Array.isArray(pair) || pair.length!==2) continue;
      const [token,session]=pair;
      if(Number(session?.expiresAt||0)<=Date.now()) continue;
      phoneCameraSessions.set(String(token).slice(0,100),session);
    }

    return true;
  }catch(error){
    console.error('Falha ao hidratar snapshot:',error);
    resetPersistentState();
    return false;
  }
}

let ACTIVE_RUNTIME=null;

function saveServersToDisk(){
  if(!ACTIVE_RUNTIME) return false;
  ACTIVE_RUNTIME.queuePersist();
  return true;
}



class SocketCompat{
  constructor(runtime,ws,meta){
    this.runtime=runtime;
    this.ws=ws;
    this.id=String(meta?.id||id());
    this.handlers=new Map();
    this.middlewares=[];
    this._meta={
      id:this.id,
      rooms:Array.isArray(meta?.rooms)?meta.rooms.map(String):[],
      data:meta?.data && typeof meta.data==='object'?meta.data:{}
    };

    const socket=this;
    this.data=new Proxy(this._meta.data,{
      set(target,key,value){
        target[key]=value;
        socket.persistAttachment();
        return true;
      },
      deleteProperty(target,key){
        delete target[key];
        socket.persistAttachment();
        return true;
      }
    });
  }

  persistAttachment(){
    try{
      const safeData={...this._meta.data};
      delete safeData.creativeRecentTexts;
      delete safeData.creativeLastMessages;

      this.ws.serializeAttachment({
        id:this._meta.id,
        rooms:this._meta.rooms,
        data:safeData
      });
    }catch(error){
      console.warn('Falha ao persistir metadados do socket:',error?.message||error);
    }
  }

  get rooms(){
    return new Set(this._meta.rooms||[]);
  }

  on(event,handler){
    if(!this.handlers.has(event)) this.handlers.set(event,[]);
    this.handlers.get(event).push(handler);
    return this;
  }

  use(middleware){
    if(typeof middleware==='function') this.middlewares.push(middleware);
    return this;
  }

  emit(event,data){
    this.runtime.sendPacket(this.ws,{t:'e',e:String(event||''),d:data});
    return this;
  }

  join(room){
    const value=String(room||'');
    if(!value) return this;
    const rooms=new Set(this._meta.rooms||[]);
    rooms.add(value);
    this._meta.rooms=[...rooms];
    this.persistAttachment();
    return this;
  }

  leave(room){
    const value=String(room||'');
    const rooms=new Set(this._meta.rooms||[]);
    rooms.delete(value);
    this._meta.rooms=[...rooms];
    this.persistAttachment();
    return this;
  }

  to(room){
    return {
      emit:(event,data)=>{
        this.runtime.broadcastRoom(String(room||''),event,data,this.id);
      }
    };
  }

  async dispatch(event,data,ackId){
    const packet=[event,data];

    for(const middleware of this.middlewares){
      let allowed=false;
      await new Promise(resolve=>{
        try{
          middleware(packet,()=>{
            allowed=true;
            resolve();
          });
        }catch(error){
          console.error('Middleware falhou:',error);
          resolve();
        }
      });
      if(!allowed) return;
    }

    const handlers=this.handlers.get(event)||[];
    if(!handlers.length){
      if(ackId) this.runtime.sendPacket(this.ws,{t:'a',a:ackId,d:{ok:false,error:'Evento não suportado'}});
      return;
    }

    let replied=false;
    const ack=(payload)=>{
      if(!ackId || replied) return;
      replied=true;
      this.runtime.sendPacket(this.ws,{t:'a',a:ackId,d:payload});
    };

    for(const handler of [...handlers]){
      try{
        const result=handler(data,ack);
        if(result && typeof result.then==='function') await result;
      }catch(error){
        console.error('Evento '+event+' falhou:',error);
        if(ackId && !replied){
          ack({ok:false,error:'Falha interna ao processar a ação'});
        }
      }
    }

    if(PERSIST_AFTER_EVENTS.has(event)){
      this.runtime.queuePersist();
    }
  }
}

function createIoCompat(runtime){
  const collection={
    get(id){return runtime.sockets.get(String(id||''));},
    values(){return runtime.sockets.values();}
  };

  const rooms={
    get(room){
      const result=new Set();
      const target=String(room||'');
      for(const socket of runtime.sockets.values()){
        if(socket.rooms.has(target)) result.add(socket.id);
      }
      return result.size?result:undefined;
    }
  };

  return {
    sockets:{
      sockets:collection,
      adapter:{rooms}
    },
    emit(event,data){
      for(const socket of runtime.sockets.values()){
        socket.emit(event,data);
      }
    },
    to(room){
      return {
        emit(event,data){
          runtime.broadcastRoom(String(room||''),event,data,null);
        }
      };
    }
  };
}

const PERSIST_AFTER_EVENTS=new Set([
  'phone-camera-create',
  'phone-camera-join',
  'phone-camera-stop',
  'private-call-invite',
  'private-call-response',
  'private-group-call-start',
  'private-group-call-response',
  'join-private-call'
]);


function setupSocket(socket){

  const eventRate = {
    windowStart: Date.now(),
    total: 0,
    messages: 0
  };

  socket.use((packet,next)=>{
    const now = Date.now();

    if(now - eventRate.windowStart > 10000){
      eventRate.windowStart = now;
      eventRate.total = 0;
      eventRate.messages = 0;
    }

    eventRate.total += 1;

    const eventName = String(packet?.[0] || '');
    if(
      eventName.includes('message') ||
      eventName.includes('request') ||
      eventName.includes('create')
    ){
      eventRate.messages += 1;
    }

    if(eventRate.total > 400 || eventRate.messages > 80){
      socket.emit('security-warning',{
        error:'Muitas ações em pouco tempo. Aguarde alguns segundos.'
      });
      return;
    }

    next();
  });

  function canSignalPeer(targetId){
    const target = io.sockets.sockets.get(String(targetId || ''));
    if(!target) return false;

    const room = socket.data.voiceRoom;
    return !!room && room === target.data.voiceRoom;
  }

  broadcastOnlineUsers();


  const loginAttempts={windowStart:Date.now(),count:0};
  function allowLoginAttempt(){
    const now=Date.now();
    if(now-loginAttempts.windowStart>60000){
      loginAttempts.windowStart=now;
      loginAttempts.count=0;
    }
    loginAttempts.count+=1;
    return loginAttempts.count<=12;
  }

  socket.on('auth-register',({username,password})=>{
    try{
      if(!allowLoginAttempt()){
        socket.emit('auth-error',{error:'Muitas tentativas. Aguarde um minuto.'});
        return;
      }

      const safeUsername=normalizeAccountUsername(username);
      const safePassword=String(password||'');

      if(safeUsername.length<3){
        socket.emit('auth-error',{error:'O nome precisa ter pelo menos 3 caracteres.'});
        return;
      }

      if(usernameExists(safeUsername)){
        socket.emit('auth-error',{error:'Esse nome já possui uma conta. Use a aba Entrar.'});
        return;
      }

      if(safePassword.length<6 || safePassword.length>128){
        socket.emit('auth-error',{error:'A senha precisa ter entre 6 e 128 caracteres.'});
        return;
      }

      // Se existir um perfil antigo sem senha, transforma esse mesmo perfil
      // em conta para preservar servidores, amigos e identidade.
      const legacy=legacyProfileForUsername(safeUsername);
      const userId=legacy?.id || crypto.randomUUID();
      const salt=crypto.randomBytes(16).toString('hex');

      accounts.set(userId,{
        userId,
        username:safeUsername,
        usernameKey:usernameKey(safeUsername),
        salt,
        passwordHash:passwordDigest(safePassword,salt),
        createdAt:Number(legacy?.createdAt || Date.now())
      });

      const profile=legacy || {
        id:userId,
        username:safeUsername,
        displayName:safeUsername,
        bio:'',
        avatar:'',
        banner:'',
        status:'online',
        createdAt:Date.now()
      };

      profile.username=safeUsername;
      profile.displayName=profile.displayName || safeUsername;
      profile.status=profile.status || 'online';
      profiles.set(userId,profile);

      const token=newSession(userId);
      socket.data.userId=userId;
      socket.data.username=safeUsername;

      saveServersToDisk();

      socket.emit('auth-success',{
        token,
        profile:publicProfile(profile),
        migratedLegacy:!!legacy
      });

      sendServerList(socket);
      emitFriendState(userId);
      emitGroupState(userId);
      broadcastOnlineUsers();
    }catch(error){
      console.error('Erro ao criar conta:',error);
      socket.emit('auth-error',{
        error:'Não foi possível criar a conta agora. Tente novamente.'
      });
    }
  });

  socket.on('auth-login',({username,password,recovery})=>{
    try{
      if(!allowLoginAttempt()){
        socket.emit('auth-error',{error:'Muitas tentativas. Aguarde um minuto.'});
        return;
      }

      const safeUsername=normalizeAccountUsername(username);
      const safePassword=String(password||'');

      if(safeUsername.length<3){
        socket.emit('auth-error',{error:'O nome precisa ter pelo menos 3 caracteres.'});
        return;
      }

      if(safePassword.length<6 || safePassword.length>128){
        socket.emit('auth-error',{error:'A senha precisa ter entre 6 e 128 caracteres.'});
        return;
      }

      const key=usernameKey(safeUsername);
      let account=[...accounts.values()].find(item=>item.usernameKey===key);

      // Em hospedagens sem disco persistente, recupera a MESMA identidade
      // armazenada no navegador antes de criar um novo ID. Isso preserva
      // a ligação com servidores e amizades já existentes no backup local.
      if(!account){
        const recoveryUserId=String(recovery?.userId || '').slice(0,100);
        const recoveryUsername=normalizeAccountUsername(recovery?.username);
        const sameRecoveryUser=
          recoveryUserId &&
          recoveryUsername &&
          usernameKey(recoveryUsername)===key;

        const legacy=legacyProfileForUsername(safeUsername);
        const userId=legacy?.id || (sameRecoveryUser ? recoveryUserId : crypto.randomUUID());
        const salt=crypto.randomBytes(16).toString('hex');

        account={
          userId,
          username:safeUsername,
          usernameKey:key,
          salt,
          passwordHash:passwordDigest(safePassword,salt),
          createdAt:Number(legacy?.createdAt || recovery?.savedAt || Date.now())
        };

        accounts.set(userId,account);

        const restoredProfile=legacy || {
          id:userId,
          username:safeUsername,
          displayName:String(recovery?.displayName || safeUsername).slice(0,40),
          bio:String(recovery?.bio || '').slice(0,300),
          avatar:String(recovery?.avatar || '').slice(0,350000),
          banner:String(recovery?.banner || '').slice(0,350000),
          status:['online','away','busy','invisible'].includes(recovery?.status)
            ? recovery.status
            : 'online',
          customStatus:String(recovery?.customStatus || '').slice(0,80),
          pronouns:String(recovery?.pronouns || '').slice(0,40),
          activity:String(recovery?.activity || '').slice(0,80),
          links:recovery?.links && typeof recovery.links==='object' ? recovery.links : {},
          privacy:recovery?.privacy && typeof recovery.privacy==='object'
            ? recovery.privacy
            : {dm:'friends',calls:'friends',friendRequests:'everyone'},
          createdAt:Number(recovery?.savedAt || Date.now())
        };

        restoredProfile.username=safeUsername;
        restoredProfile.displayName=restoredProfile.displayName || safeUsername;
        restoredProfile.status=restoredProfile.status || 'online';
        profiles.set(userId,restoredProfile);

        // Recupera servidores do próprio usuário preservando seus IDs.
        if(sameRecoveryUser && Array.isArray(recovery?.servers)){
          for(const raw of recovery.servers.slice(0,100)){
            const serverId=String(raw?.id || '').slice(0,80);
            const ownerId=String(raw?.ownerId || '').slice(0,100);
            if(!serverId || ownerId!==userId) continue;

            if(!servers.has(serverId)){
              makeServer(cleanName(raw?.name,'Servidor'),{
                id:serverId,
                ownerId:userId,
                members:Array.isArray(raw?.members)
                  ? [...new Set([userId,...raw.members.map(v=>String(v||'').slice(0,100))])]
                  : [userId],
                inviteToken:String(raw?.inviteToken || crypto.randomBytes(18).toString('hex')).slice(0,100),
                icon:String(raw?.icon || '').slice(0,350000),
                accent:raw?.accent,
                description:raw?.description,
                tags:raw?.tags,
                textChannels:raw?.textChannels,
                voiceChannels:raw?.voiceChannels,
                categories:raw?.categories,
                roles:raw?.roles,
                rules:raw?.rules,
                banner:raw?.banner,
                inviteExpiresAt:raw?.inviteExpiresAt,
                bans:raw?.bans,
                mutes:raw?.mutes,
                channelPolicies:raw?.channelPolicies,
                pinned:raw?.pinned,
                events:raw?.events,
                polls:raw?.polls,
                watchParty:raw?.watchParty,
                creative:raw?.creative
              });
            }
          }
        }

        // Recupera amizades públicas salvas no navegador.
        if(sameRecoveryUser && Array.isArray(recovery?.friends)){
          for(const rawFriend of recovery.friends.slice(0,500)){
            const friendId=String(rawFriend?.id || '').slice(0,100);
            if(!friendId || friendId===userId) continue;

            if(!profiles.has(friendId)){
              const friendUsername=cleanName(rawFriend?.username,'Usuário');
              profiles.set(friendId,{
                id:friendId,
                username:friendUsername,
                displayName:friendUsername,
                bio:String(rawFriend?.bio || '').slice(0,160),
                avatar:String(rawFriend?.avatar || '').slice(0,350000),
                banner:'',
                status:'offline',
                createdAt:Date.now()
              });
            }

            if(!areFriends(userId,friendId)){
              friendships.push({a:userId,b:friendId,at:Date.now()});
            }
          }
        }

        socket.data.userId=userId;
        socket.data.username=safeUsername;

        const token=newSession(userId);
        saveServersToDisk();

        socket.emit('auth-success',{
          token,
          profile:publicProfile(restoredProfile),
          accountRecovered:true,
          recoveredIdentity:sameRecoveryUser
        });

        sendServerList(socket);
        emitFriendState(userId);
        emitGroupState(userId);
        broadcastOnlineUsers();
        return;
      }

      if(account.recoveredSessionOnly){
        const newSalt=crypto.randomBytes(16).toString('hex');
        account.salt=newSalt;
        account.passwordHash=passwordDigest(safePassword,newSalt);
        account.recoveredSessionOnly=false;
        saveServersToDisk();
      }else if(!verifyAccountPassword(safePassword,account)){
        socket.emit('auth-error',{error:'Senha incorreta.'});
        return;
      }

      let profile=profiles.get(account.userId);

      // Se a conta existe mas o perfil se perdeu, recria apenas o perfil público.
      if(!profile){
        profile={
          id:account.userId,
          username:account.username,
          displayName:account.username,
          bio:'',
          avatar:'',
          banner:'',
          status:'online',
          createdAt:Number(account.createdAt || Date.now())
        };
        profiles.set(account.userId,profile);
      }

      socket.data.userId=account.userId;
      socket.data.username=account.username;

      const token=newSession(account.userId);
      saveServersToDisk();

      socket.emit('auth-success',{token,profile:publicProfile(profile)});
      sendServerList(socket);
      emitFriendState(account.userId);
      emitGroupState(account.userId);
      broadcastOnlineUsers();
    }catch(error){
      console.error('Erro ao entrar:',error);
      socket.emit('auth-error',{
        error:'Não foi possível entrar agora. Tente novamente.'
      });
    }
  });

  socket.on('auth-restore',({token,recovery})=>{
    try{
      let userId=sessionUserId(token,{renew:true});
      let profile=userId?profiles.get(userId):null;
      let recoveredAfterUpdate=false;

      // Recuperação de atualização:
      // se o host perdeu o arquivo local, o navegador ainda possui token,
      // id, perfil, servidores e amizades do próprio usuário.
      if(!userId && recovery && String(token || '').length>=20){
        const safeUserId=String(recovery.userId || '').slice(0,100);
        const safeUsername=normalizeAccountUsername(recovery.username);
        const key=usernameKey(safeUsername);

        const conflicting=[...accounts.values()].find(account=>
          account.usernameKey===key && account.userId!==safeUserId
        );

        if(
          safeUserId &&
          safeUsername.length>=3 &&
          !conflicting &&
          !accounts.has(safeUserId)
        ){
          // Conta recuperada em modo de sessão. A senha antiga não é armazenada
          // no navegador e por isso não é reconstruída aqui.
          const recoverySalt=crypto.randomBytes(16).toString('hex');

          accounts.set(safeUserId,{
            userId:safeUserId,
            username:safeUsername,
            usernameKey:key,
            salt:recoverySalt,
            passwordHash:passwordDigest(crypto.randomBytes(32).toString('hex'),recoverySalt),
            createdAt:Number(recovery.savedAt || Date.now()),
            recoveredSessionOnly:true
          });

          profile={
            id:safeUserId,
            username:safeUsername,
            displayName:String(recovery.displayName || safeUsername).slice(0,40),
            bio:String(recovery.bio || '').slice(0,300),
            avatar:String(recovery.avatar || '').slice(0,350000),
            banner:String(recovery.banner || '').slice(0,350000),
            status:['online','away','busy','invisible'].includes(recovery.status)
              ? recovery.status
              : 'online',
            customStatus:String(recovery.customStatus || '').slice(0,80),
            pronouns:String(recovery.pronouns || '').slice(0,40),
            activity:String(recovery.activity || '').slice(0,80),
            links:recovery.links && typeof recovery.links==='object' ? recovery.links : {},
            privacy:recovery.privacy && typeof recovery.privacy==='object'
              ? recovery.privacy
              : {dm:'friends',calls:'friends',friendRequests:'everyone'},
            createdAt:Number(recovery.savedAt || Date.now())
          };

          profiles.set(safeUserId,profile);

          sessions.set(tokenHash(token),{
            userId:safeUserId,
            createdAt:Date.now(),
            lastSeenAt:Date.now(),
            expiresAt:Date.now()+SESSION_LIFETIME_MS
          });

          userId=safeUserId;
          recoveredAfterUpdate=true;

          // Recupera apenas servidores pertencentes ao próprio usuário.
          const recoveredServers=Array.isArray(recovery.servers)
            ? recovery.servers.slice(0,100)
            : [];

          for(const raw of recoveredServers){
            const serverId=String(raw?.id || '').slice(0,80);
            const ownerId=String(raw?.ownerId || '').slice(0,100);

            if(!serverId || ownerId!==safeUserId || servers.has(serverId)) continue;

            makeServer(
              cleanName(raw?.name,'Servidor'),
              {
                id:serverId,
                ownerId:safeUserId,
                members:Array.isArray(raw?.members)
                  ? [...new Set([safeUserId,...raw.members.map(v=>String(v||'').slice(0,100))])]
                  : [safeUserId],
                inviteToken:String(raw?.inviteToken || crypto.randomBytes(18).toString('hex')).slice(0,100),
                icon:String(raw?.icon || '').slice(0,350000),
                accent:raw?.accent,
                description:raw?.description,
                tags:raw?.tags,
                textChannels:raw?.textChannels,
                voiceChannels:raw?.voiceChannels,
                categories:raw?.categories,
                roles:raw?.roles,
                rules:raw?.rules,
                banner:raw?.banner,
                inviteExpiresAt:raw?.inviteExpiresAt,
                bans:raw?.bans,
                mutes:raw?.mutes,
                channelPolicies:raw?.channelPolicies,
                pinned:raw?.pinned,
                events:raw?.events,
                polls:raw?.polls,
                watchParty:raw?.watchParty,
                creative:raw?.creative
              }
            );
          }

          // Restaura a lista pública de amigos salva no navegador.
          // Essa compatibilidade preserva amizades antigas após perda do arquivo.
          const recoveredFriends=Array.isArray(recovery.friends)
            ? recovery.friends.slice(0,500)
            : [];

          for(const rawFriend of recoveredFriends){
            const friendId=String(rawFriend?.id || '').slice(0,100);
            const friendUsername=cleanName(rawFriend?.username,'Usuário');

            if(!friendId || friendId===safeUserId) continue;

            if(!profiles.has(friendId)){
              profiles.set(friendId,{
                id:friendId,
                username:friendUsername,
                displayName:friendUsername,
                bio:String(rawFriend?.bio || '').slice(0,160),
                avatar:String(rawFriend?.avatar || '').slice(0,350000),
                banner:'',
                status:'offline',
                createdAt:Date.now()
              });
            }

            if(!areFriends(safeUserId,friendId)){
              friendships.push({
                a:safeUserId,
                b:friendId,
                at:Date.now()
              });
            }
          }

          saveServersToDisk();
        }
      }

      profile=userId ? profiles.get(userId) : null;

      if(!userId || !profile){
        socket.emit('auth-required',{reason:'invalid-session'});
        return;
      }

      socket.data.userId=userId;
      socket.data.username=profile.username;

      saveServersToDisk();

      socket.emit('auth-success',{
        token,
        profile:publicProfile(profile),
        sessionRestored:true,
        recoveredAfterUpdate
      });

      sendServerList(socket);
      emitFriendState(userId);
      emitGroupState(userId);
      broadcastOnlineUsers();
    }catch(error){
      console.error('Erro ao restaurar sessão:',error);
      socket.emit('auth-restore-retry',{reason:'temporary-error'});
    }
  });

  socket.on('auth-keepalive',({token})=>{
    const userId=sessionUserId(token,{renew:true});

    if(!userId || userId!==socket.data.userId){
      socket.emit('auth-required',{reason:'invalid-session'});
      return;
    }

    // Evita gravar o arquivo a cada ping. Grava aproximadamente a cada 30 minutos.
    const hash=tokenHash(token);
    const session=sessions.get(hash);
    const lastPersisted=Number(session?.lastPersistedAt || 0);

    if(session && Date.now()-lastPersisted > 1000*60*30){
      session.lastPersistedAt=Date.now();
      saveServersToDisk();
    }

    socket.emit('auth-alive',{at:Date.now()});
  });

  socket.on('auth-logout',({token})=>{
    const hash=tokenHash(token);
    const session=sessions.get(hash);
    if(session?.userId===socket.data.userId) sessions.delete(hash);
    socket.data.userId=null;
    socket.data.username=null;
    saveServersToDisk();
    socket.emit('auth-logout-success');
    broadcastOnlineUsers();
  });

  socket.on('delete-account',({token})=>{
    const userId=sessionUserId(token);
    if(!userId || userId!==socket.data.userId){
      socket.emit('auth-error',{error:'Sessão inválida.'});return;
    }
    const profile=profiles.get(userId);
    const username=profile?.username||'';

    for(const [serverId,s] of [...servers.entries()]){
      if(s.ownerId===userId){servers.delete(serverId);continue}
      s.members=(s.members||[]).filter(id=>id!==userId);
      for(const role of s.roles||[]){
        role.members=(role.members||[]).filter(member=>String(member||'').toLowerCase()!==username.toLowerCase());
      }
    }
    for(let i=friendRequests.length-1;i>=0;i--){
      if(friendRequests[i].fromUserId===userId || friendRequests[i].toUserId===userId) friendRequests.splice(i,1);
    }
    for(let i=friendships.length-1;i>=0;i--){
      if(friendships[i].a===userId || friendships[i].b===userId) friendships.splice(i,1);
    }
    for(let i=directMessages.length-1;i>=0;i--){
      if(directMessages[i].fromUserId===userId || directMessages[i].toUserId===userId) directMessages.splice(i,1);
    }
    for(const [groupId,group] of [...privateGroups.entries()]){
      if(group.ownerId===userId){privateGroups.delete(groupId);continue}
      group.members=(group.members||[]).filter(id=>id!==userId);
      group.messages=(group.messages||[]).filter(message=>message.userId!==userId);
      if(group.members.length<2) privateGroups.delete(groupId);
    }
    clearSessionsForUser(userId);
    accounts.delete(userId);profiles.delete(userId);
    socket.data.userId=null;socket.data.username=null;
    saveServersToDisk();broadcastServerLists();broadcastOnlineUsers();
    socket.emit('account-deleted');
  });

  socket.on('set-username', ({ username }) => {
    if(!socket.data.userId) return;
    const safe=normalizeAccountUsername(username);
    if(safe.length<3 || usernameExists(safe,socket.data.userId)) return;
    socket.data.username=safe;
    broadcastOnlineUsers();
  });

  socket.on('set-profile', ({ username, displayName, bio, avatar, banner, status, knownServerIds }) => {
    const safeId=String(socket.data.userId||'').trim().slice(0,100);
    if(!safeId || !accounts.has(safeId)) return;

    const oldProfile=profiles.get(safeId);
    const oldName=oldProfile?.username||null;
    const safeUsername=normalizeAccountUsername(username);

    if(safeUsername.length<3){
      socket.emit('profile-error',{error:'O nome precisa ter pelo menos 3 caracteres.'});return;
    }
    if(usernameExists(safeUsername,safeId)){
      socket.emit('profile-error',{error:'Esse nome já está sendo usado.'});return;
    }

    const profile={
      id:safeId,
      username:safeUsername,
      displayName:String(displayName||safeUsername).trim().slice(0,40)||safeUsername,
      bio:String(bio||'').trim().slice(0,300),
      avatar:String(avatar||'').slice(0,350000),
      banner:String(banner||'').slice(0,350000),
      status:['online','away','busy','invisible'].includes(status)?status:'online',
      createdAt:Number(oldProfile?.createdAt||Date.now())
    };

    profiles.set(safeId, profile);
    const account=accounts.get(safeId);
    if(account){
      account.username=profile.username;
      account.usernameKey=usernameKey(profile.username);
    }

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
        error:'Essa pessoa não existe no Acord'
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
      : {ok:false,error:'Essa pessoa não existe no Acord'}
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

  socket.on('group-delete', ({ groupId }) => {
    if(!socket.data.userId) return;

    const safeGroupId=String(groupId || '').slice(0,80);
    const group=privateGroups.get(safeGroupId);

    if(!group){
      socket.emit('group-error',{error:'Grupo não encontrado'});
      return;
    }

    if(group.ownerId!==socket.data.userId){
      socket.emit('group-error',{error:'Apenas o criador pode excluir o grupo'});
      return;
    }

    const members=[...(group.members || [])];
    const groupName=group.name || 'Grupo privado';

    privateGroups.delete(safeGroupId);
    saveServersToDisk();

    for(const userId of members){
      emitGroupState(userId);

      for(const client of io.sockets.sockets.values()){
        if(client.data.userId===userId){
          client.emit('group-deleted',{
            groupId:safeGroupId,
            groupName
          });
        }
      }
    }
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


  socket.on('sync-owned-servers', ({ servers:ownedServers }) => {
    if(!socket.data.userId || !accounts.has(socket.data.userId)) return;
    if(!Array.isArray(ownedServers)) return;

    let changed=false;
    const restoredIds=[];

    for(const raw of ownedServers.slice(0,100)){
      const serverId=String(raw?.id || '').slice(0,80);
      const ownerId=String(raw?.ownerId || '').slice(0,100);

      // Somente o verdadeiro dono autenticado pode restaurar o servidor.
      if(!serverId || ownerId!==String(socket.data.userId)) continue;

      const existing=servers.get(serverId);

      if(existing){
        if(existing.ownerId!==socket.data.userId) continue;

        if(!(existing.members || []).includes(socket.data.userId)){
          existing.members=[
            ...new Set([socket.data.userId,...(existing.members || [])])
          ];
          changed=true;
        }

        continue;
      }

      const created=makeServer(
        cleanName(raw?.name,'Servidor'),
        {
          id:serverId,
          ownerId:socket.data.userId,
          members:Array.isArray(raw?.members)
            ? [...new Set([
                socket.data.userId,
                ...raw.members.map(value=>String(value || '').slice(0,100)).filter(Boolean)
              ])]
            : [socket.data.userId],
          inviteToken:String(raw?.inviteToken || crypto.randomBytes(18).toString('hex')).slice(0,100),
          icon:String(raw?.icon || '').slice(0,350000),
          accent:raw?.accent,
          description:raw?.description,
          tags:raw?.tags,
          textChannels:raw?.textChannels,
          voiceChannels:raw?.voiceChannels,
          categories:raw?.categories,
          roles:raw?.roles,
          messages:raw?.messages,
          rules:raw?.rules,
          banner:raw?.banner,
          inviteExpiresAt:raw?.inviteExpiresAt,
          bans:raw?.bans,
          mutes:raw?.mutes,
          channelPolicies:raw?.channelPolicies,
          pinned:raw?.pinned,
          events:raw?.events,
          polls:raw?.polls,
          watchParty:raw?.watchParty
        }
      );

      if(created){
        changed=true;
        restoredIds.push(created.id);

        recordAudit(
          created.id,
          'restore-owned-server',
          socket.data.username || 'Usuário',
          created.id
        );
      }
    }

    if(changed){
      saveServersToDisk();
      broadcastServerLists();
    }else{
      sendServerList(socket);
    }

    socket.emit('owned-servers-synced',{
      restoredIds,
      total:publicServersForUser(socket.data.userId).length
    });
  });


  socket.on('create-server', ({ name }) => {
    if(!socket.data.userId || !accounts.has(socket.data.userId)) return;

    const beforeIds=new Set(servers.keys());

    const created=makeServer(
      cleanName(name,'Novo servidor'),
      {
        ownerId:socket.data.userId,
        members:[socket.data.userId]
      }
    );

    // Garantia: a criação é estritamente aditiva.
    // Nenhum servidor já existente pode ser removido neste fluxo.
    const missingAfterCreate=[...beforeIds].filter(serverId=>!servers.has(serverId));

    if(missingAfterCreate.length){
      console.error('Falha de integridade: criação removeu servidores',missingAfterCreate);
      socket.emit('permission-error',{
        error:'Não foi possível criar o servidor com segurança'
      });
      return;
    }

    recordAudit(
      created.id,
      'create-server',
      socket.data.username || 'Usuário',
      created.id
    );

    saveServersToDisk();
    broadcastServerLists();

    socket.emit('server-created',{
      serverId:created.id,
      totalServers:servers.size
    });
  });

  socket.on('join-server-invite', ({ token }) => {
    if(!socket.data.userId || !accounts.has(socket.data.userId)){
      socket.emit('permission-error',{error:'Entre na sua conta para usar o convite'});
      return;
    }

    const safeToken=String(token || '').trim().slice(0,100);

    if(!/^[A-Za-z0-9_-]{10,100}$/.test(safeToken)){
      socket.emit('permission-error',{error:'Convite inválido ou expirado'});
      return;
    }

    const serverData=[...servers.values()].find(item=>
      item.inviteToken===safeToken
    );

    if(!serverData || (serverData.inviteExpiresAt && serverData.inviteExpiresAt<=Date.now())){
      socket.emit('permission-error',{error:'Convite inválido ou expirado'});
      return;
    }

    if((serverData.bans||[]).includes(socket.data.userId)){
      socket.emit('permission-error',{error:'Você foi banido deste servidor'});
      return;
    }

    const alreadyMember=(serverData.members || []).includes(socket.data.userId);

    if(!alreadyMember){
      serverData.members.push(socket.data.userId);
      serverData.members=[...new Set(serverData.members)];

      recordAudit(
        serverData.id,
        'join-via-invite',
        socket.data.username || 'Usuário',
        socket.data.userId
      );

      saveServersToDisk();
    }

    sendServerList(socket);

    socket.emit('invite-joined',{
      serverId:serverData.id,
      serverName:serverData.name,
      alreadyMember
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
      socket.emit('permission-error',{error:'Esse usuário não existe no Acord'});
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

  socket.on('set-member-role', ({ serverId, roleId, userId, enabled }) => {
    const s = servers.get(serverId);
    if (!s || !requireServerAccess(s,socket)) return;

    if (!hasServerPermission(s,socket,'manageRoles')) {
      permissionDenied(socket);
      return;
    }

    const role = s.roles.find(item => item.id === String(roleId || ''));
    if (!role) return;

    const safeUserId = String(userId || '').slice(0,100);
    const targetProfile = profiles.get(safeUserId);

    if (!targetProfile) {
      socket.emit('permission-error',{error:'Esse usuário não existe no Acord'});
      return;
    }

    if (
      safeUserId !== s.ownerId &&
      !(s.members || []).includes(safeUserId)
    ) {
      socket.emit('permission-error',{error:'Essa pessoa não faz parte deste servidor'});
      return;
    }

    const targetName = targetProfile.username;
    const lowerName = targetName.toLowerCase();

    role.members = (role.members || []).filter(
      member => String(member || '').toLowerCase() !== lowerName
    );

    if(enabled){
      role.members.push(targetName);
      role.members = [...new Set(role.members)].slice(0,100);
    }

    saveServersToDisk();
    broadcastServerUpdate(s);

    socket.emit('role-updated',{
      message: enabled
        ? 'Cargo atribuído a ' + targetName
        : 'Cargo removido de ' + targetName
    });
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

  socket.on('rename-category', ({ serverId, categoryId, name }) => {
    const s=servers.get(serverId);
    if(!s || !requireServerAccess(s,socket)) return;

    if(!hasServerPermission(s,socket,'manageChannels')){
      permissionDenied(socket);
      return;
    }

    const safeCategoryId=String(categoryId || '').slice(0,80);
    const category=s.categories.find(item=>item.id===safeCategoryId);
    if(!category) return;

    const safeName=cleanName(name,category.name || 'Categoria');
    if(!safeName) return;

    category.name=safeName;

    recordAudit(
      serverId,
      'rename-category',
      socket.data.username || 'Usuário',
      safeCategoryId
    );

    saveServersToDisk();
    broadcastServerLists();
    socket.emit('category-updated',{message:'Categoria renomeada'});
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

  socket.on('rename-channel', ({ serverId, type, channelId, name }) => {
    const s=servers.get(serverId);
    if(!s || !requireServerAccess(s,socket)) return;

    if(!hasServerPermission(s,socket,'manageChannels')){
      permissionDenied(socket);
      return;
    }

    const safeType=type==='voice' ? 'voice' : 'text';
    const list=safeType==='voice' ? s.voiceChannels : s.textChannels;
    const channel=list.find(item=>item.id===String(channelId || '').slice(0,80));
    if(!channel) return;

    const safeName=
      safeType==='text'
        ? cleanChannel(name,channel.name || 'chat')
        : cleanName(name,channel.name || 'Canal');

    if(!safeName) return;

    channel.name=safeName;

    recordAudit(
      serverId,
      'rename-channel',
      socket.data.username || 'Usuário',
      channel.id
    );

    saveServersToDisk();
    broadcastServerLists();
    socket.emit('category-updated',{message:'Canal renomeado'});
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

    if (type === 'voice' || type === 'stage') {
      const isStage = type === 'stage';

      const channel = {
        id: id(),
        name: cleanName(name, isStage ? 'Palco' : 'Nova voz'),
        categoryId: null,
        order: s.voiceChannels.length,
        mode: isStage ? 'stage' : 'voice'
      };

      s.voiceChannels.push(channel);
      saveServersToDisk();
      broadcastServerLists();
      socket.emit('channel-created', {
        serverId,
        type: isStage ? 'stage' : 'voice',
        channelId: channel.id
      });
    }
  });


  socket.on('delete-channel', ({ serverId, type, channelId }) => {
    const s = servers.get(serverId);
    if (!s || !requireServerAccess(s,socket)) return;

    if (!hasServerPermission(s,socket,'manageChannels')) {
      permissionDenied(socket);
      return;
    }

    const safeChannelId = String(channelId || '').slice(0,80);
    const safeType = type === 'voice' ? 'voice' : 'text';

    if(safeType === 'text'){
      const index = s.textChannels.findIndex(channel=>channel.id===safeChannelId);
      if(index < 0) return;

      const [removed] = s.textChannels.splice(index,1);
      s.messages.delete(safeChannelId);
      s.textChannels.forEach((channel,idx)=>channel.order=idx);

      for(const client of io.sockets.sockets.values()){
        if(client.data.textServerId===serverId && client.data.textChannelId===safeChannelId){
          if(client.data.textRoom) client.leave(client.data.textRoom);
          client.data.textRoom=null;
          client.data.textServerId=null;
          client.data.textChannelId=null;
        }
      }

      recordAudit(serverId,'delete-channel',socket.data.username || 'Usuário',removed?.name || safeChannelId);
      saveServersToDisk();
      broadcastServerLists();

      io.to(socket.id).emit('channel-deleted',{
        serverId,
        type:'text',
        channelId:safeChannelId,
        message:'Chat excluído'
      });
      return;
    }

    const index = s.voiceChannels.findIndex(channel=>channel.id===safeChannelId);
    if(index < 0) return;

    const [removed] = s.voiceChannels.splice(index,1);
    s.voiceChannels.forEach((channel,idx)=>channel.order=idx);

    const room = `voice:${serverId}:${safeChannelId}`;
    const participantIds = [...(io.sockets.adapter.rooms.get(room) || [])];

    for(const participantId of participantIds){
      const participant = io.sockets.sockets.get(participantId);
      if(!participant) continue;

      participant.leave(room);
      participant.data.voiceRoom=null;
      participant.data.voiceServerId=null;
      participant.data.voiceChannelId=null;

      participant.emit('voice-channel-removed',{
        serverId,
        channelId:safeChannelId,
        message:'O canal de voz foi excluído'
      });
    }

    recordAudit(serverId,'delete-channel',socket.data.username || 'Usuário',removed?.name || safeChannelId);
    saveServersToDisk();
    broadcastServerLists();

    io.to(socket.id).emit('channel-deleted',{
      serverId,
      type:'voice',
      channelId:safeChannelId,
      message:removed?.mode==='stage' ? 'Palco excluído' : 'Canal de voz excluído'
    });
  });

  function sameDmConversation(message,a,b){
    return (
      (message.fromUserId===a && message.toUserId===b) ||
      (message.fromUserId===b && message.toUserId===a)
    );
  }

  function trimDmConversation(a,b,maxItems=500){
    const indexes=[];
    for(let i=0;i<directMessages.length;i++){
      if(sameDmConversation(directMessages[i],a,b)) indexes.push(i);
    }
    const excess=Math.max(0,indexes.length-maxItems);
    for(let n=excess-1;n>=0;n--) directMessages.splice(indexes[n],1);
    while(directMessages.length>20000) directMessages.shift();
  }

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
      .filter(message=>sameDmConversation(message,socket.data.userId,targetId))
      .sort((a,b)=>Number(a.at||0)-Number(b.at||0))
      .slice(-500);

    socket.emit('dm-history',{
      targetUserId:targetId,
      messages:history
    });
  });

  socket.on('dm-message', ({ targetUserId, targetUsername, text, clientMessageId }) => {
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

    const safeClientId=String(clientMessageId||'')
      .replace(/[^a-zA-Z0-9_-]/g,'')
      .slice(0,80);

    const message = {
      id:safeClientId || id(),
      fromUserId:socket.data.userId,
      toUserId:targetProfile.id,
      fromUsername:socket.data.username || 'Usuário',
      text:safeText,
      at:Date.now()
    };

    if(!directMessages.some(item=>
      item.id===message.id &&
      item.fromUserId===message.fromUserId
    )){
      directMessages.push(message);
      trimDmConversation(message.fromUserId,message.toUserId,500);
    }

    saveServersToDisk();

    socket.emit('dm-message',message);

    for (const client of io.sockets.sockets.values()) {
      if (client.data.userId===targetProfile.id) {
        client.emit('dm-message',message);
      }
    }
  });


  socket.on('dm-recovery-sync',({messages},ack)=>{
    const reply=typeof ack==='function'?ack:()=>{};
    if(!socket.data.userId){
      reply({ok:false,error:'Entre na sua conta'});
      return;
    }

    const list=Array.isArray(messages)?messages.slice(-2000):[];
    let added=0;

    for(const raw of list){
      const fromUserId=String(raw?.fromUserId||'').slice(0,100);
      const toUserId=String(raw?.toUserId||'').slice(0,100);
      const messageId=String(raw?.id||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80);
      const safeText=String(raw?.text||'').trim().slice(0,1000);

      if(
        fromUserId!==socket.data.userId ||
        !toUserId ||
        !profiles.has(toUserId) ||
        !messageId ||
        !safeText
      ) continue;

      if(directMessages.some(m=>m.id===messageId && m.fromUserId===fromUserId)) continue;

      directMessages.push({
        id:messageId,
        fromUserId,
        toUserId,
        fromUsername:socket.data.username||'Usuário',
        text:safeText,
        at:Number(raw?.at||Date.now())
      });

      trimDmConversation(fromUserId,toUserId,500);
      added++;
    }

    if(added) saveServersToDisk();
    reply({ok:true,added});
  });

  function emitChatMessageToServerMembers(serverData,message){
    if(!serverData || !message) return;

    const room='server:'+String(serverData.id || '');

    // Persistência vem primeiro: a mensagem já foi salva no histórico.
    // Esta etapa apenas atualiza em tempo real quem estiver conectado agora.
    for(const client of io.sockets.sockets.values()){
      if(requireServerAccess(serverData,client)){
        if(!client.rooms.has(room)){
          client.join(room);
        }
      }else if(client.rooms.has(room)){
        client.leave(room);
      }
    }

    io.to(room).emit('chat-message',message);
  }

  socket.on('public-chat-history', ({ serverId, channelId }) => {
    if(!socket.data.userId) return;

    const safeServerId=String(serverId || '').slice(0,80);
    const safeChannelId=String(channelId || '').slice(0,80);
    const serverData=servers.get(safeServerId);

    if(
      !serverData ||
      !requireServerAccess(serverData,socket) ||
      !canUseTextChannel(serverData,socket,safeChannelId) ||
      !serverData.textChannels.some(channel=>channel.id===safeChannelId)
    ){
      return;
    }

    socket.emit('public-chat-history',{
      serverId:safeServerId,
      channelId:safeChannelId,
      messages:serverData.messages.get(safeChannelId) || []
    });
  });

  function canUseTextChannel(serverData,socket,channelId){
    const policy=serverData?.channelPolicies?.[channelId]||{};
    if(!policy.roleId) return true;
    if(serverData.ownerId===socket.data.userId) return true;
    return userRoles(serverData,socket).some(role=>role.id===policy.roleId);
  }

  socket.on('public-chat-message', ({ serverId, channelId, text, attachment, replyTo, confirmedEveryone }) => {
    if(!socket.data.userId) return;

    const safeServerId=String(serverId||'').slice(0,80);
    const safeChannelId=String(channelId||'').slice(0,80);
    const serverData=servers.get(safeServerId);
    if(!serverData || !requireServerAccess(serverData,socket)) return;
    if(!canUseTextChannel(serverData,socket,safeChannelId)){socket.emit('permission-error',{error:'Você não tem o cargo necessário para este canal'});return;}
    if((serverData.bans||[]).includes(socket.data.userId)) return;
    if((serverData.mutes||[]).includes(socket.data.userId)){
      socket.emit('permission-error',{error:'Você está silenciado neste servidor'});
      return;
    }
    if(!serverData.textChannels.some(channel=>channel.id===safeChannelId)) return;

    const policy=serverData.channelPolicies?.[safeChannelId]||{};
    if(policy.mode==='readonly' && !hasServerPermission(serverData,socket,'manageChannels')){
      socket.emit('permission-error',{error:'Este canal é somente leitura'});
      return;
    }

    const safeText=String(text||'').trim().slice(0,2000);
    const creative=serverData.creative||{};

    if(
      creative.everyoneConfirm?.enabled &&
      /@everyone\b/i.test(safeText) &&
      !confirmedEveryone
    ){
      socket.emit('permission-error',{error:'Confirme a menção @everyone antes de enviar'});
      return;
    }

    const slowSeconds=Math.max(0,Number(creative.slowMode?.seconds||0));
    if(slowSeconds>0 && !hasServerPermission(serverData,socket,'manageServer')){
      socket.data.creativeLastMessages=socket.data.creativeLastMessages||{};
      const key=safeServerId+':'+safeChannelId;
      const last=Number(socket.data.creativeLastMessages[key]||0);
      if(Date.now()-last<slowSeconds*1000){
        socket.emit('permission-error',{error:'Modo lento ativo. Aguarde '+slowSeconds+' segundos.'});
        return;
      }
      socket.data.creativeLastMessages[key]=Date.now();
    }

    const repeatLimit=Math.max(2,Number(creative.antiSpam?.repeatLimit||0));
    if(creative.antiSpam?.enabled && safeText){
      socket.data.creativeRecentTexts=Array.isArray(socket.data.creativeRecentTexts)
        ? socket.data.creativeRecentTexts.slice(-20)
        : [];
      const normalized=safeText.toLowerCase().replace(/\s+/g,' ').trim();
      const repeated=socket.data.creativeRecentTexts.filter(item=>item===normalized).length;
      if(repeated>=repeatLimit-1){
        socket.emit('permission-error',{error:'Anti-spam: mensagem repetida bloqueada'});
        return;
      }
      socket.data.creativeRecentTexts.push(normalized);
    }
    const data=String(attachment?.data||'');
    const safeAttachment=
      attachment && /^data:[^;]+;base64,/i.test(data) && data.length<=600000
        ? {
            name:String(attachment.name||'arquivo').slice(0,100),
            type:String(attachment.type||'application/octet-stream').slice(0,100),
            data
          }
        : null;
    if(!safeText&&!safeAttachment)return;

    const mentions=[...safeText.matchAll(/@([\\wÀ-ÿ._-]{2,30})/g)].map(match=>match[1]).slice(0,20);

    const message={
      id:id(),serverId:safeServerId,channelId:safeChannelId,
      userId:socket.data.userId,username:socket.data.username||'Usuário',
      text:safeText,attachment:safeAttachment,
      replyTo:String(replyTo||'').slice(0,80)||null,
      mentions,at:Date.now(),edited:false
    };

    const history=serverData.messages.get(safeChannelId)||[];
    history.push(message);
    if(history.length>500)history.splice(0,history.length-500);
    serverData.messages.set(safeChannelId,history);
    saveServersToDisk();

    for(const client of io.sockets.sockets.values()){
      if(requireServerAccess(serverData,client)) client.emit('public-chat-message',message);
    }
  });

  socket.on('mega-edit-public',({serverId,channelId,messageId,text})=>{
    const s=servers.get(String(serverId||''));
    if(!s||!requireServerAccess(s,socket))return;
    const history=s.messages.get(String(channelId||''))||[];
    const message=history.find(m=>m.id===String(messageId||''));
    if(!message||message.userId!==socket.data.userId)return;
    message.text=String(text||'').trim().slice(0,2000);message.edited=true;
    saveServersToDisk();
    for(const client of io.sockets.sockets.values()){
      if(requireServerAccess(s,client)) client.emit('public-chat-message-edited',message);
    }
  });

  socket.on('mega-delete-public',({serverId,channelId,messageId})=>{
    const s=servers.get(String(serverId||''));if(!s||!requireServerAccess(s,socket))return;
    const history=s.messages.get(String(channelId||''))||[];
    const index=history.findIndex(m=>m.id===String(messageId||''));
    if(index<0)return;
    const message=history[index];
    if(message.userId!==socket.data.userId&&!hasServerPermission(s,socket,'manageServer'))return;
    history.splice(index,1);saveServersToDisk();
    for(const client of io.sockets.sockets.values()){
      if(requireServerAccess(s,client)) client.emit('public-chat-message-deleted',{serverId,channelId,messageId});
    }
  });

  socket.on('mega-pin-message',({serverId,channelId,messageId})=>{
    const s=servers.get(String(serverId||''));if(!s||!requireServerAccess(s,socket))return;
    const ref={channelId:String(channelId||''),messageId:String(messageId||'')};
    const exists=(s.pinned||[]).some(p=>p.channelId===ref.channelId&&p.messageId===ref.messageId);
    if(!exists)s.pinned=[...(s.pinned||[]),ref].slice(-200);
    saveServersToDisk();broadcastServerUpdate(s);
  });


  socket.on('join-text', ({ serverId, channelId },ack) => {
    const reply=typeof ack==='function' ? ack : ()=>{};

    if(!socket.data.userId){
      reply({ok:false,error:'Sessão não identificada'});
      return;
    }

    const safeServerId=String(serverId || '').slice(0,80);
    const safeChannelId=String(channelId || '').slice(0,80);
    const s=servers.get(safeServerId);

    if(!s){
      reply({ok:false,error:'Servidor ainda não sincronizado'});
      return;
    }

    if(!requireServerAccess(s,socket)){
      reply({ok:false,error:'Você não tem acesso a este servidor'});
      return;
    }

    if(!s.textChannels.some(c=>c.id===safeChannelId)){
      reply({ok:false,error:'Chat não encontrado'});
      return;
    }

    if(socket.data.textRoom){
      socket.leave(socket.data.textRoom);
    }

    const room='text:'+safeServerId+':'+safeChannelId;

    socket.data.textRoom=room;
    socket.data.textServerId=safeServerId;
    socket.data.textChannelId=safeChannelId;

    socket.join(room);

    const history=s.messages.get(safeChannelId) || [];

    socket.emit('text-history',{
      serverId:safeServerId,
      channelId:safeChannelId,
      history
    });

    reply({
      ok:true,
      serverId:safeServerId,
      channelId:safeChannelId,
      history
    });
  });

  socket.on('chat-message', ({ serverId, channelId, text, replyTo, attachment, clientNonce },ack) => {
    const reply=typeof ack==='function' ? ack : ()=>{};
    const safeServerId=String(serverId || '').slice(0,80);
    const safeChannelId=String(channelId || '').slice(0,80);
    const s=servers.get(safeServerId);

    if(!socket.data.userId){
      reply({ok:false,error:'Sessão não identificada'});
      return;
    }

    if(!s){
      reply({ok:false,error:'Servidor ainda não sincronizado'});
      return;
    }

    if(!requireServerAccess(s,socket)){
      reply({ok:false,error:'Você não tem acesso a este servidor'});
      return;
    }

    if(!s.textChannels.some(channel=>channel.id===safeChannelId)){
      reply({ok:false,error:'Chat não encontrado'});
      return;
    }

    const room='text:'+safeServerId+':'+safeChannelId;

    if(
      socket.data.textRoom!==room ||
      socket.data.textServerId!==safeServerId ||
      socket.data.textChannelId!==safeChannelId
    ){
      socket.data.textRoom=room;
      socket.data.textServerId=safeServerId;
      socket.data.textChannelId=safeChannelId;
      socket.join(room);
    }

    const cleanText=String(text||'').trim().slice(0,2000);
    const safeAttachment=
      attachment &&
      String(attachment.type||'').startsWith('image/') &&
      String(attachment.data||'').startsWith('data:image/') &&
      String(attachment.data||'').length<=900000
        ? {
            name:String(attachment.name||'imagem').slice(0,80),
            type:String(attachment.type||'').slice(0,80),
            data:String(attachment.data||'')
          }
        : null;

    if(!cleanText && !safeAttachment){
      reply({ok:false,error:'Mensagem vazia'});
      return;
    }

    const history=s.messages.get(safeChannelId)||[];
    const message={
      id:id(),serverId:safeServerId,channelId:safeChannelId,senderId:socket.id,userId:socket.data.userId,
      username:socket.data.username||'Usuário',text:cleanText,attachment:safeAttachment,
      clientNonce:String(clientNonce||'').slice(0,100)||null,
      replyTo:String(replyTo||'').slice(0,80)||null,reactions:{},at:Date.now(),edited:false
    };
    history.push(message);
    if(history.length>500) history.splice(0,history.length-500);
    s.messages.set(safeChannelId,history);
    saveServersToDisk();

    // A mensagem não depende mais de o usuário estar inscrito na sala Socket.IO
    // do canal. Todos os membros online do servidor recebem o evento.
    emitChatMessageToServerMembers(s,message);

    reply({
      ok:true,
      messageId:message.id,
      message,
      saved:true
    });
  });

  socket.on('chat-edit',({serverId,channelId,messageId,text})=>{
    const s=servers.get(serverId);
    if(!s || !requireServerAccess(s,socket)) return;
    const history=s.messages.get(channelId)||[];
    const message=history.find(item=>item.id===messageId);
    if(!message || message.userId!==socket.data.userId) return;
    message.text=String(text||'').trim().slice(0,2000);
    message.edited=true;
    saveServersToDisk();

    for(const client of io.sockets.sockets.values()){
      if(
        client.data.userId &&
        (
          client.data.userId===s.ownerId ||
          (s.members || []).includes(client.data.userId)
        )
      ){
        client.emit('chat-message-updated',message);
      }
    }
  });

  socket.on('chat-delete',({serverId,channelId,messageId})=>{
    const s=servers.get(serverId);
    if(!s || !requireServerAccess(s,socket)) return;
    const history=s.messages.get(channelId)||[];
    const index=history.findIndex(item=>item.id===messageId);
    if(index<0) return;
    const message=history[index];
    const canManage=message.userId===socket.data.userId || hasServerPermission(s,socket,'manageServer');
    if(!canManage) return;
    history.splice(index,1);
    saveServersToDisk();

    for(const client of io.sockets.sockets.values()){
      if(
        client.data.userId &&
        (
          client.data.userId===s.ownerId ||
          (s.members || []).includes(client.data.userId)
        )
      ){
        client.emit('chat-message-deleted',{
          serverId,
          channelId,
          messageId
        });
      }
    }
  });

  socket.on('chat-react',({serverId,channelId,messageId,emoji})=>{
    const s=servers.get(serverId);
    if(!s || !requireServerAccess(s,socket)) return;
    const allowed=['👍','❤️','😂','🔥','😮','😢'];
    if(!allowed.includes(emoji)) return;
    const history=s.messages.get(channelId)||[];
    const message=history.find(item=>item.id===messageId);
    if(!message) return;
    message.reactions=message.reactions||{};
    const users=new Set(message.reactions[emoji]||[]);
    if(users.has(socket.data.userId)) users.delete(socket.data.userId);
    else users.add(socket.data.userId);
    message.reactions[emoji]=[...users].slice(0,500);
    saveServersToDisk();

    for(const client of io.sockets.sockets.values()){
      if(
        client.data.userId &&
        (
          client.data.userId===s.ownerId ||
          (s.members || []).includes(client.data.userId)
        )
      ){
        client.emit('chat-message-updated',message);
      }
    }
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

  socket.on('profile-extra-update',payload=>{
    if(!socket.data.userId)return;
    const profile=profiles.get(socket.data.userId);if(!profile)return;
    profile.customStatus=String(payload?.customStatus||'').slice(0,80);
    profile.pronouns=String(payload?.pronouns||'').slice(0,40);
    profile.activity=String(payload?.activity||'').slice(0,80);
    const safeUrl=value=>{
      const v=String(value||'').trim().slice(0,300);
      return /^https:\/\//i.test(v)?v:'';
    };
    profile.links={
      steam:safeUrl(payload?.links?.steam),
      spotify:safeUrl(payload?.links?.spotify),
      youtube:safeUrl(payload?.links?.youtube)
    };
    const allowed=new Set(['everyone','friends','nobody']);
    profile.privacy={
      dm:allowed.has(payload?.privacy?.dm)?payload.privacy.dm:'friends',
      calls:allowed.has(payload?.privacy?.calls)?payload.privacy.calls:'friends',
      friendRequests:'everyone'
    };
    saveServersToDisk();
    socket.emit('profile-extra-updated',publicProfile(profile));
    broadcastOnlineUsers();
  });

  socket.on('mega-server-settings',payload=>{
    const s=servers.get(String(payload?.serverId||''));if(!s||!requireServerAccess(s,socket))return;
    if(!hasServerPermission(s,socket,'manageServer')){permissionDenied(socket);return}
    s.rules=String(payload?.rules||'').slice(0,4000);
    if(typeof payload?.banner==='string'&&payload.banner.length<=350000)s.banner=payload.banner;
    const expiry=Math.max(0,Math.min(1000*60*60*24*30,Number(payload?.inviteExpiryMs||0)));
    s.inviteExpiresAt=expiry?Date.now()+expiry:0;
    const channelId=String(payload?.channelId||'');
    if(channelId && s.textChannels.some(c=>c.id===channelId)){
      s.channelPolicies=s.channelPolicies||{};
      const mode=['normal','readonly','announcement'].includes(payload?.channelMode)?payload.channelMode:'normal';
      const roleId=String(payload?.channelRoleId||'').slice(0,80);
      s.channelPolicies[channelId]={...(s.channelPolicies[channelId]||{}),mode,roleId:s.roles.some(role=>role.id===roleId)?roleId:''};
    }
    recordAudit(s.id,'mega-settings',socket.data.username||'Usuário',channelId||s.id);
    saveServersToDisk();broadcastServerUpdate(s);
  });

  socket.on('mega-moderate',payload=>{
    const s=servers.get(String(payload?.serverId||''));if(!s||!requireServerAccess(s,socket))return;
    if(!hasServerPermission(s,socket,'manageServer')){permissionDenied(socket);return}
    const userId=String(payload?.userId||'').slice(0,100);
    if(!userId||userId===s.ownerId)return;
    const action=String(payload?.action||'');
    if(action==='mute'){
      s.mutes=[...new Set([...(s.mutes||[]),userId])].slice(0,500);
    }else if(action==='kick'){
      s.members=(s.members||[]).filter(id=>id!==userId);
    }else if(action==='ban'){
      s.members=(s.members||[]).filter(id=>id!==userId);
      s.bans=[...new Set([...(s.bans||[]),userId])].slice(0,500);
    }else return;
    recordAudit(s.id,action,socket.data.username||'Usuário',userId);
    saveServersToDisk();broadcastServerLists();broadcastServerUpdate(s);
  });

  socket.on('mega-get-audit',({serverId})=>{
    const s=servers.get(String(serverId||''));if(!s||!requireServerAccess(s,socket))return;
    socket.emit('mega-audit',auditLog.filter(item=>String(item.serverId)===String(serverId)).slice(-200));
  });

  socket.on('mega-create-event',payload=>{
    const s=servers.get(String(payload?.serverId||''));if(!s||!requireServerAccess(s,socket))return;
    const title=String(payload?.title||'').trim().slice(0,80);
    const when=Number(payload?.when||0);if(!title||!when)return;
    s.events=[...(s.events||[]),{id:id(),title,when,createdBy:socket.data.userId}].slice(-200);
    saveServersToDisk();broadcastServerUpdate(s);
  });

  socket.on('mega-create-poll',payload=>{
    const s=servers.get(String(payload?.serverId||''));if(!s||!requireServerAccess(s,socket))return;
    const question=String(payload?.question||'').trim().slice(0,160);
    const options=(Array.isArray(payload?.options)?payload.options:[]).map(v=>String(v||'').trim().slice(0,80)).filter(Boolean).slice(0,8);
    if(!question||options.length<2)return;
    s.polls=[...(s.polls||[]),{id:id(),question,options:options.map(text=>({text,votes:[]})),createdBy:socket.data.userId}].slice(-200);
    saveServersToDisk();broadcastServerUpdate(s);
  });

  socket.on('mega-poll-vote',payload=>{
    const s=servers.get(String(payload?.serverId||''));if(!s||!requireServerAccess(s,socket))return;
    const poll=(s.polls||[]).find(p=>p.id===String(payload?.pollId||''));if(!poll)return;
    const index=Number(payload?.index);if(!poll.options?.[index])return;
    poll.options.forEach(opt=>{opt.votes=(opt.votes||[]).filter(id=>id!==socket.data.userId)});
    poll.options[index].votes.push(socket.data.userId);
    saveServersToDisk();broadcastServerUpdate(s);
  });

  socket.on('mega-watch',payload=>{
    const s=servers.get(String(payload?.serverId||''));if(!s||!requireServerAccess(s,socket))return;
    const url=String(payload?.url||'').trim().slice(0,500);
    if(url&&!/^https:\/\//i.test(url))return;
    s.watchParty={url,position:Number(payload?.position||0),playing:!!payload?.playing,updatedAt:Date.now(),by:socket.data.userId};
    saveServersToDisk();
    for(const client of io.sockets.sockets.values()){
      if(requireServerAccess(s,client))client.emit('mega-watch-state',{serverId:s.id,watchParty:s.watchParty});
    }
  });

  socket.on('mega-whiteboard-stroke',payload=>{
    const s=servers.get(String(payload?.serverId||''));if(!s||!requireServerAccess(s,socket))return;
    const stroke=payload?.stroke;
    if(!stroke?.from||!stroke?.to)return;
    const safe={from:{x:Number(stroke.from.x),y:Number(stroke.from.y)},to:{x:Number(stroke.to.x),y:Number(stroke.to.y)}};
    if(![safe.from.x,safe.from.y,safe.to.x,safe.to.y].every(Number.isFinite))return;
    s.whiteboard=[...(s.whiteboard||[]),safe].slice(-2000);
    for(const client of io.sockets.sockets.values()){
      if(requireServerAccess(s,client)&&client.id!==socket.id)client.emit('mega-whiteboard-stroke',{serverId:s.id,stroke:safe});
    }
  });

  socket.on('mega-whiteboard-get',({serverId})=>{
    const s=servers.get(String(serverId||''));if(!s||!requireServerAccess(s,socket))return;
    socket.emit('mega-whiteboard-state',{serverId:s.id,strokes:s.whiteboard||[]});
  });

  socket.on('mega-whiteboard-clear',({serverId})=>{
    const s=servers.get(String(serverId||''));if(!s||!requireServerAccess(s,socket))return;
    s.whiteboard=[];saveServersToDisk();
    for(const client of io.sockets.sockets.values()){
      if(requireServerAccess(s,client))client.emit('mega-whiteboard-state',{serverId:s.id,strokes:[]});
    }
  });

  socket.on('mega-recording-notice',({serverId})=>{
    const s=servers.get(String(serverId||''));if(!s||!requireServerAccess(s,socket))return;
    for(const client of io.sockets.sockets.values()){
      if(requireServerAccess(s,client)&&client.id!==socket.id){
        client.emit('mega-recording-notice',{serverId:s.id,username:socket.data.username||'Usuário'});
      }
    }
  });

  socket.on('mega-call-file',payload=>{
    const s=servers.get(String(payload?.serverId||''));if(!s||!requireServerAccess(s,socket))return;
    const data=String(payload?.data||'');if(!/^data:[^;]+;base64,/i.test(data)||data.length>600000)return;
    const message={serverId:s.id,username:socket.data.username||'Usuário',name:String(payload?.name||'arquivo').slice(0,100),type:String(payload?.type||'application/octet-stream').slice(0,100),data};
    for(const client of io.sockets.sockets.values()){if(requireServerAccess(s,client)&&client.id!==socket.id)client.emit('mega-call-file',message)}
  });


  function sanitizeCreativeValue(value,depth=0){
    if(depth>5) return null;
    if(value===null || typeof value==='boolean' || typeof value==='number'){
      return value;
    }
    if(typeof value==='string') return value.slice(0,5000);
    if(Array.isArray(value)) return value.slice(-500).map(v=>sanitizeCreativeValue(v,depth+1));
    if(value && typeof value==='object'){
      const out={};
      for(const [key,val] of Object.entries(value).slice(0,100)){
        const safeKey=String(key).replace(/[^a-zA-Z0-9_.:-]/g,'').slice(0,80);
        if(safeKey)out[safeKey]=sanitizeCreativeValue(val,depth+1);
      }
      return out;
    }
    return null;
  }


  socket.on('creative-temp-room',({serverId,name},ack)=>{
    const reply=typeof ack==='function'?ack:()=>{};
    const s=servers.get(String(serverId||''));

    if(!s||!requireServerAccess(s,socket)){
      reply({ok:false,error:'Servidor indisponível'});
      return;
    }

    const channel={
      id:id(),
      name:cleanChannel(name,'temporaria'),
      categoryId:null,
      order:(s.voiceChannels||[]).length,
      mode:'voice'
    };

    s.voiceChannels.push(channel);
    s.creative=s.creative&&typeof s.creative==='object'?s.creative:{};
    const rooms=Array.isArray(s.creative.tempRooms)?s.creative.tempRooms:[];
    rooms.push({
      channelId:channel.id,
      ownerId:socket.data.userId,
      createdAt:Date.now()
    });
    s.creative.tempRooms=rooms.slice(-100);

    saveServersToDisk();
    broadcastServerUpdate(s);
    reply({ok:true,channelId:channel.id,name:channel.name});
  });

  socket.on('creative-expiring-message',({serverId,channelId,text,expiresAt},ack)=>{
    const reply=typeof ack==='function'?ack:()=>{};
    const s=servers.get(String(serverId||''));
    const safeChannelId=String(channelId||'');

    if(
      !s ||
      !requireServerAccess(s,socket) ||
      !s.textChannels.some(c=>c.id===safeChannelId)
    ){
      reply({ok:false,error:'Canal indisponível'});
      return;
    }

    const safeText=String(text||'').trim().slice(0,1800);
    if(!safeText){
      reply({ok:false,error:'Mensagem vazia'});
      return;
    }

    const message={
      id:id(),
      serverId:s.id,
      channelId:safeChannelId,
      userId:socket.data.userId,
      username:socket.data.username||'Usuário',
      text:'⏳ '+safeText,
      attachment:null,
      replyTo:null,
      mentions:[],
      at:Date.now(),
      edited:false,
      expiresAt:Math.max(Date.now()+60000,Number(expiresAt||0))
    };

    const history=s.messages.get(safeChannelId)||[];
    history.push(message);
    if(history.length>500)history.splice(0,history.length-500);
    s.messages.set(safeChannelId,history);

    s.creative=s.creative&&typeof s.creative==='object'?s.creative:{};
    const list=Array.isArray(s.creative.expiringMessages)?s.creative.expiringMessages:[];
    list.push({
      channelId:safeChannelId,
      messageId:message.id,
      expiresAt:message.expiresAt
    });
    s.creative.expiringMessages=list.slice(-500);

    saveServersToDisk();

    for(const client of io.sockets.sockets.values()){
      if(requireServerAccess(s,client))client.emit('public-chat-message',message);
    }

    reply({ok:true,messageId:message.id});
  });

  socket.on('creative-get',({serverId},ack)=>{
    const reply=typeof ack==='function'?ack:()=>{};
    const s=servers.get(String(serverId||''));
    if(!s||!requireServerAccess(s,socket)){reply({ok:false,error:'Servidor indisponível'});return}
    reply({ok:true,creative:s.creative||{}});
  });

  socket.on('creative-set',({serverId,key,value},ack)=>{
    const reply=typeof ack==='function'?ack:()=>{};
    const s=servers.get(String(serverId||''));
    if(!s||!requireServerAccess(s,socket)){reply({ok:false,error:'Servidor indisponível'});return}
    const safeKey=String(key||'').replace(/[^a-zA-Z0-9_.:-]/g,'').slice(0,80);
    if(!safeKey){reply({ok:false,error:'Chave inválida'});return}
    s.creative=s.creative&&typeof s.creative==='object'?s.creative:{};
    s.creative[safeKey]=sanitizeCreativeValue(value);
    saveServersToDisk();
    broadcastServerUpdate(s);
    reply({ok:true,creative:s.creative});
  });

  socket.on('creative-append',({serverId,key,item},ack)=>{
    const reply=typeof ack==='function'?ack:()=>{};
    const s=servers.get(String(serverId||''));
    if(!s||!requireServerAccess(s,socket)){reply({ok:false,error:'Servidor indisponível'});return}
    const safeKey=String(key||'').replace(/[^a-zA-Z0-9_.:-]/g,'').slice(0,80);
    if(!safeKey){reply({ok:false,error:'Chave inválida'});return}
    s.creative=s.creative&&typeof s.creative==='object'?s.creative:{};
    const list=Array.isArray(s.creative[safeKey])?s.creative[safeKey]:[];
    list.push(sanitizeCreativeValue(item));
    if(list.length>500)list.splice(0,list.length-500);
    s.creative[safeKey]=list;
    saveServersToDisk();
    broadcastServerUpdate(s);
    reply({ok:true,creative:s.creative});
  });


  socket.on('essential-ping',(payload,ack)=>{
    if(typeof ack==='function'){
      ack({ok:true,serverTime:Date.now(),echo:payload?.at||0});
    }
  });

  socket.on('essential-sessions',({token},ack)=>{
    const reply=typeof ack==='function'?ack:()=>{};
    const userId=sessionUserId(token,{renew:false});

    if(!userId||userId!==socket.data.userId){
      reply({ok:false,error:'Sessão inválida'});
      return;
    }

    const currentHash=tokenHash(token);
    const list=[...sessions.entries()]
      .filter(([,session])=>session.userId===userId)
      .map(([hash,session])=>({
        current:hash===currentHash,
        createdAt:Number(session.createdAt||Date.now()),
        lastSeenAt:Number(session.lastSeenAt||session.createdAt||Date.now()),
        expiresAt:Number(session.expiresAt||0)
      }))
      .sort((a,b)=>b.lastSeenAt-a.lastSeenAt);

    reply({ok:true,sessions:list});
  });

  socket.on('essential-revoke-other-sessions',({token},ack)=>{
    const reply=typeof ack==='function'?ack:()=>{};
    const userId=sessionUserId(token,{renew:false});

    if(!userId||userId!==socket.data.userId){
      reply({ok:false,error:'Sessão inválida'});
      return;
    }

    const currentHash=tokenHash(token);
    let revoked=0;

    for(const [hash,session] of [...sessions.entries()]){
      if(session.userId===userId&&hash!==currentHash){
        sessions.delete(hash);
        revoked+=1;
      }
    }

    saveServersToDisk();
    reply({ok:true,revoked});
  });

  socket.on('essential-change-password',({token,oldPassword,newPassword},ack)=>{
    const reply=typeof ack==='function'?ack:()=>{};
    const userId=sessionUserId(token,{renew:false});
    const account=userId?accounts.get(userId):null;

    if(!userId||userId!==socket.data.userId||!account){
      reply({ok:false,error:'Sessão inválida'});
      return;
    }

    if(account.recoveredSessionOnly){
      reply({ok:false,error:'Faça login novamente antes de alterar a senha'});
      return;
    }

    if(!verifyAccountPassword(String(oldPassword||''),account)){
      reply({ok:false,error:'Senha atual incorreta'});
      return;
    }

    const safeNew=String(newPassword||'');
    if(safeNew.length<6||safeNew.length>128){
      reply({ok:false,error:'A nova senha precisa ter entre 6 e 128 caracteres'});
      return;
    }

    const salt=crypto.randomBytes(16).toString('hex');
    account.salt=salt;
    account.passwordHash=passwordDigest(safeNew,salt);
    account.recoveredSessionOnly=false;

    const currentHash=tokenHash(token);
    for(const [hash,session] of [...sessions.entries()]){
      if(session.userId===userId&&hash!==currentHash)sessions.delete(hash);
    }

    saveServersToDisk();
    reply({ok:true});
  });

  socket.on('essential-search',({query},ack)=>{
    const reply=typeof ack==='function'?ack:()=>{};
    if(!socket.data.userId){
      reply({ok:false,error:'Entre na sua conta'});
      return;
    }

    const q=String(query||'').trim().toLocaleLowerCase('pt-BR').slice(0,100);
    if(q.length<2){
      reply({ok:false,error:'Busca muito curta'});
      return;
    }

    const results=[];

    for(const s of servers.values()){
      if(!requireServerAccess(s,socket))continue;

      if(String(s.name||'').toLocaleLowerCase('pt-BR').includes(q)){
        results.push({
          type:'server',
          title:'Servidor · '+s.name,
          preview:s.description||'',
          serverId:s.id
        });
      }

      for(const channel of s.textChannels||[]){
        if(channel.name.toLocaleLowerCase('pt-BR').includes(q)){
          results.push({
            type:'channel',
            title:'# '+channel.name+' · '+s.name,
            preview:'Canal de texto',
            serverId:s.id,
            channelId:channel.id
          });
        }

        const history=s.messages.get(channel.id)||[];
        for(const message of history.slice(-500)){
          const hay=(String(message.username||'')+' '+String(message.text||'')).toLocaleLowerCase('pt-BR');
          if(!hay.includes(q))continue;

          results.push({
            type:'message',
            title:(message.username||'Usuário')+' · #'+channel.name,
            preview:String(message.text||'').slice(0,220),
            serverId:s.id,
            channelId:channel.id,
            messageId:message.id
          });

          if(results.length>=80)break;
        }

        if(results.length>=80)break;
      }

      if(results.length>=80)break;
    }

    const visibleUserIds=new Set([socket.data.userId]);

    for(const pair of friendships){
      if(pair.a===socket.data.userId)visibleUserIds.add(pair.b);
      if(pair.b===socket.data.userId)visibleUserIds.add(pair.a);
    }

    for(const s of servers.values()){
      if(requireServerAccess(s,socket)){
        for(const memberId of s.members||[])visibleUserIds.add(memberId);
      }
    }

    for(const userId of visibleUserIds){
      if(results.length>=100)break;
      const profile=profiles.get(userId);
      if(!profile)continue;

      const hay=(String(profile.username||'')+' '+String(profile.displayName||'')+' '+String(profile.bio||'')).toLocaleLowerCase('pt-BR');
      if(hay.includes(q)){
        results.push({
          type:'user',
          title:'Pessoa · '+profile.username,
          preview:profile.bio||profile.displayName||''
        });
      }
    }

    reply({ok:true,results:results.slice(0,100)});
  });

  socket.on('essential-report',({serverId,target,reason},ack)=>{
    const reply=typeof ack==='function'?ack:()=>{};
    const s=servers.get(String(serverId||''));

    if(!s||!requireServerAccess(s,socket)){
      reply({ok:false,error:'Servidor indisponível'});
      return;
    }

    const safeTarget=String(target||'').trim().slice(0,40);
    const safeReason=String(reason||'').trim().slice(0,500);

    if(!safeTarget||safeReason.length<3){
      reply({ok:false,error:'Preencha usuário e motivo'});
      return;
    }

    recordAudit(
      s.id,
      'report',
      socket.data.username||'Usuário',
      (safeTarget+' · '+safeReason).slice(0,80)
    );

    saveServersToDisk();
    reply({ok:true});
  });

  socket.on('labs-ping',(payload,ack)=>{
    if(typeof ack==='function') ack({ok:true,serverTime:Date.now(),echo:payload?.at||0});
  });

  socket.on('phone-camera-create', () => {
    if(!socket.data.userId || !accounts.has(socket.data.userId)) return;

    for(const [token,session] of phoneCameraSessions){
      if(session.desktopSocketId===socket.id){
        phoneCameraSessions.delete(token);
      }
    }

    const token=crypto.randomBytes(18).toString('hex');

    phoneCameraSessions.set(token,{
      ownerUserId:socket.data.userId,
      desktopSocketId:socket.id,
      phoneSocketId:null,
      expiresAt:Date.now()+1000*60*30
    });

    socket.emit('phone-camera-created',{token});
  });

  socket.on('phone-camera-join', ({token},ack) => {
    const reply=typeof ack==='function' ? ack : ()=>{};
    const safeToken=String(token || '').slice(0,100);
    const session=phoneCameraSessions.get(safeToken);

    if(!session || session.expiresAt<=Date.now()){
      reply({ok:false,error:'Link inválido ou expirado'});
      return;
    }

    const desktop=io.sockets.sockets.get(session.desktopSocketId);
    if(!desktop || desktop.data.userId!==session.ownerUserId){
      reply({ok:false,error:'O computador não está conectado'});
      return;
    }

    session.phoneSocketId=socket.id;
    session.expiresAt=Date.now()+1000*60*30;
    socket.data.phoneCameraToken=safeToken;

    desktop.emit('phone-camera-phone-ready',{token:safeToken});
    reply({ok:true});
  });

  socket.on('phone-camera-offer', ({token,sdp}) => {
    const safeToken=String(token || '').slice(0,100);
    const session=phoneCameraSessions.get(safeToken);
    if(!session || session.phoneSocketId!==socket.id || !sdp) return;

    io.sockets.sockets.get(session.desktopSocketId)?.emit('phone-camera-offer',{
      token:safeToken,sdp
    });
  });

  socket.on('phone-camera-answer', ({token,sdp}) => {
    const safeToken=String(token || '').slice(0,100);
    const session=phoneCameraSessions.get(safeToken);
    if(!session || session.desktopSocketId!==socket.id || !sdp) return;

    io.sockets.sockets.get(session.phoneSocketId)?.emit('phone-camera-answer',{
      token:safeToken,sdp
    });
  });

  socket.on('phone-camera-ice', ({token,candidate}) => {
    const safeToken=String(token || '').slice(0,100);
    const session=phoneCameraSessions.get(safeToken);
    if(!session || !candidate) return;

    if(session.desktopSocketId===socket.id){
      io.sockets.sockets.get(session.phoneSocketId)?.emit('phone-camera-ice',{
        token:safeToken,candidate
      });
    }else if(session.phoneSocketId===socket.id){
      io.sockets.sockets.get(session.desktopSocketId)?.emit('phone-camera-ice',{
        token:safeToken,candidate
      });
    }
  });

  socket.on('phone-camera-stop', ({token}) => {
    const safeToken=String(token || '').slice(0,100);
    const session=phoneCameraSessions.get(safeToken);
    if(!session) return;

    if(session.desktopSocketId!==socket.id && session.phoneSocketId!==socket.id) return;

    io.sockets.sockets.get(session.desktopSocketId)?.emit('phone-camera-stopped',{token:safeToken});
    io.sockets.sockets.get(session.phoneSocketId)?.emit('phone-camera-stopped',{token:safeToken});
    phoneCameraSessions.delete(safeToken);
  });


  socket.on('private-group-call-start', ({ groupId }) => {
    if(!socket.data.userId || !accounts.has(socket.data.userId)) return;

    const safeGroupId=String(groupId || '').slice(0,80);
    const group=privateGroups.get(safeGroupId);

    if(!group || !(group.members || []).includes(socket.data.userId)){
      socket.emit('private-call-error',{error:'Você não faz parte deste grupo'});
      return;
    }

    const callId=crypto.randomBytes(18).toString('hex');
    const allowedUserIds=[...new Set(group.members || [])].slice(0,10);

    privateCalls.set(callId,{
      type:'group',
      groupId:safeGroupId,
      groupName:group.name || 'Grupo privado',
      callerUserId:socket.data.userId,
      callerSocketId:socket.id,
      allowedUserIds,
      acceptedUserIds:[socket.data.userId],
      createdAt:Date.now(),
      expiresAt:Date.now()+1000*60*60*4
    });

    socket.emit('private-group-call-started',{
      callId,
      groupId:safeGroupId,
      groupName:group.name || 'Grupo privado'
    });

    for(const client of io.sockets.sockets.values()){
      if(
        client.id!==socket.id &&
        client.data.userId &&
        allowedUserIds.includes(client.data.userId)
      ){
        client.emit('incoming-private-group-call',{
          callId,
          groupId:safeGroupId,
          groupName:group.name || 'Grupo privado',
          fromUserId:socket.data.userId,
          fromUsername:socket.data.username || 'Usuário'
        });
      }
    }
  });

  socket.on('private-group-call-response', ({ callId, accept }) => {
    if(!socket.data.userId) return;

    const safeCallId=String(callId || '').slice(0,100);
    const call=privateCalls.get(safeCallId);

    if(
      !call ||
      call.type!=='group' ||
      !Array.isArray(call.allowedUserIds) ||
      !call.allowedUserIds.includes(socket.data.userId)
    ){
      socket.emit('private-call-error',{error:'Call de grupo inválida ou expirada'});
      return;
    }

    if(accept){
      call.acceptedUserIds=[
        ...new Set([...(call.acceptedUserIds || []),socket.data.userId])
      ];
      call.expiresAt=Date.now()+1000*60*60*4;
    }
  });

  socket.on('private-call-invite', ({ targetUserId, targetUsername }) => {
    if(!socket.data.userId || !accounts.has(socket.data.userId)){
      socket.emit('private-call-error',{error:'Você precisa estar conectado à sua conta'});
      return;
    }

    const target = [...io.sockets.sockets.values()].find(candidate => {
      if(candidate.id===socket.id || !candidate.data.userId) return false;

      if(targetUserId){
        return String(candidate.data.userId)===String(targetUserId);
      }

      return String(candidate.data.username || '').toLowerCase() ===
        String(targetUsername || '').toLowerCase();
    });

    if(!target){
      socket.emit('private-call-error',{error:'Esse amigo está offline'});
      return;
    }

    if(!areFriends(socket.data.userId,target.data.userId)){
      socket.emit('private-call-error',{error:'Calls privadas só podem ser feitas entre amigos'});
      return;
    }

    const callId=crypto.randomBytes(18).toString('hex');

    privateCalls.set(callId,{
      callerUserId:socket.data.userId,
      calleeUserId:target.data.userId,
      callerSocketId:socket.id,
      calleeSocketId:target.id,
      accepted:false,
      createdAt:Date.now(),
      expiresAt:Date.now()+1000*60*60*4
    });

    target.emit('incoming-private-call',{
      callId,
      callerSocketId:socket.id,
      fromUserId:socket.data.userId,
      fromUsername:socket.data.username || 'Usuário'
    });
  });

  socket.on('private-call-response', ({ callId, callerSocketId, accept }) => {
    if(!callId || !socket.data.userId) return;

    const safeCallId=String(callId).slice(0,100);
    const call=privateCalls.get(safeCallId);

    if(
      !call ||
      call.calleeUserId!==socket.data.userId ||
      call.calleeSocketId!==socket.id ||
      call.callerSocketId!==String(callerSocketId || '')
    ){
      socket.emit('private-call-error',{error:'Convite de call inválido ou expirado'});
      return;
    }

    const caller=io.sockets.sockets.get(call.callerSocketId);

    if(
      !caller?.data?.userId ||
      caller.data.userId!==call.callerUserId ||
      !areFriends(call.callerUserId,call.calleeUserId)
    ){
      privateCalls.delete(safeCallId);
      socket.emit('private-call-error',{error:'A call não está mais disponível'});
      return;
    }

    if(accept){
      call.accepted=true;
      call.expiresAt=Date.now()+1000*60*60*4;

      caller.emit('private-call-accepted',{
        callId:safeCallId,
        username:socket.data.username || 'Usuário',
        userId:socket.data.userId
      });
    }else{
      privateCalls.delete(safeCallId);

      caller.emit('private-call-declined',{
        callId:safeCallId,
        username:socket.data.username || 'Usuário'
      });
    }
  });

  socket.on('join-private-call', ({ callId },ack) => {
    const reply=typeof ack==='function'
      ? ack
      : ()=>{};

    if(!socket.data.userId || !accounts.has(socket.data.userId)){
      reply({ok:false,error:'Sessão inválida'});
      return;
    }

    const safeCallId=String(callId || '').slice(0,100);
    const call=privateCalls.get(safeCallId);

    if(!call || !call.accepted || Number(call.expiresAt || 0)<=Date.now()){
      const error='Call privada inválida ou expirada';
      socket.emit('private-call-error',{error});
      reply({ok:false,error});
      return;
    }

    const isGroupCall=call.type==='group';

    const allowed=isGroupCall
      ? (
          Array.isArray(call.allowedUserIds) &&
          call.allowedUserIds.includes(socket.data.userId) &&
          (
            socket.data.userId===call.callerUserId ||
            (call.acceptedUserIds || []).includes(socket.data.userId)
          )
        )
      : (
          socket.data.userId===call.callerUserId ||
          socket.data.userId===call.calleeUserId
        );

    if(!allowed){
      const error='Você não tem acesso a esta call privada';
      socket.emit('private-call-error',{error});
      reply({ok:false,error});
      return;
    }

    leaveVoiceRoom();

    const room='private:'+safeCallId;
    const existing=[...(io.sockets.adapter.rooms.get(room) || [])];

    const participants=existing
      .map(socketId=>{
        const participant=io.sockets.sockets.get(socketId);
        if(!participant?.data?.userId) return null;

        const permitted=isGroupCall
          ? (call.allowedUserIds || []).includes(participant.data.userId)
          : (
              participant.data.userId===call.callerUserId ||
              participant.data.userId===call.calleeUserId
            );

        return permitted
          ? {id:socketId,username:participant.data.username || 'Usuário'}
          : null;
      })
      .filter(Boolean);

    const maxParticipants=isGroupCall
      ? Math.min(10,(call.allowedUserIds || []).length)
      : 2;

    if(participants.length>=maxParticipants && !existing.includes(socket.id)){
      const error='Esta call privada já está completa';
      socket.emit('private-call-error',{error});
      reply({ok:false,error});
      return;
    }

    socket.data.voiceRoom=room;
    socket.data.voiceServerId=null;
    socket.data.voiceChannelId=null;

    socket.join(room);

    socket.emit('voice-participants',participants);

    socket.to(room).emit('user-joined',{
      id:socket.id,
      username:socket.data.username || 'Usuário'
    });

    const members=[...(io.sockets.adapter.rooms.get(room) || [])]
      .map(socketId=>{
        const participant=io.sockets.sockets.get(socketId);
        return participant
          ? {id:socketId,username:participant.data.username || 'Usuário'}
          : null;
      })
      .filter(Boolean);

    io.to(room).emit('voice-members',members);

    reply({
      ok:true,
      callId:safeCallId,
      isGroup:isGroupCall,
      participants
    });
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



  socket.on('stage-raise-hand',({serverId,channelId})=>{
    const s=servers.get(serverId);
    if(!s || !requireServerAccess(s,socket)) return;
    const channel=s.voiceChannels.find(item=>item.id===channelId);
    if(!channel || channel.mode!=='stage') return;
    io.to(`voice:${serverId}:${channelId}`).emit('stage-hand-raised',{
      socketId:socket.id,userId:socket.data.userId,username:socket.data.username||'Usuário'
    });
  });

  socket.on('server-kick-member',({serverId,userId})=>{
    const s=servers.get(serverId);
    if(!s || !hasServerPermission(s,socket,'manageServer')) return;
    const targetId=String(userId||'').slice(0,100);
    if(!targetId || targetId===s.ownerId) return;
    s.members=(s.members||[]).filter(id=>id!==targetId);
    recordAudit(serverId,'kick',socket.data.username,targetId);
    saveServersToDisk();
    broadcastServerLists();
    for(const client of io.sockets.sockets.values()){
      if(client.data.userId===targetId) client.emit('removed-from-server',{serverId});
    }
  });

  socket.on('leave-voice', leaveVoiceRoom);

  socket.on('offer', ({ target, sdp }) => {
    if(!canSignalPeer(target) || !sdp) return;

    io.to(target).emit('offer', {
      from: socket.id,
      sdp,
      username: socket.data.username || 'Usuário'
    });
  });

  socket.on('answer', ({ target, sdp }) => {
    if(!canSignalPeer(target) || !sdp) return;
    io.to(target).emit('answer', { from: socket.id, sdp });
  });

  socket.on('ice-candidate', ({ target, candidate }) => {
    if(!canSignalPeer(target) || !candidate) return;
    io.to(target).emit('ice-candidate', { from: socket.id, candidate });
  });

    socket.on('disconnecting',()=>{
    for(const [token,session] of phoneCameraSessions){
      if(session.phoneSocketId===socket.id){
        session.phoneSocketId=null;
        io.sockets.sockets.get(session.desktopSocketId)?.emit('phone-camera-stopped',{token});
        session.expiresAt=Date.now()+1000*60*10;
      }else if(session.desktopSocketId===socket.id){
        io.sockets.sockets.get(session.phoneSocketId)?.emit('phone-camera-stopped',{token});
        phoneCameraSessions.delete(token);
      }
    }
  });

socket.on('disconnect', () => {
    for(const [callId,call] of privateCalls){
      if(call.type==='group'){
        // A call em grupo continua disponível para os demais membros.
        if(call.callerSocketId===socket.id){
          call.callerSocketId=null;
        }
        continue;
      }

      if(call.callerSocketId===socket.id || call.calleeSocketId===socket.id){
        privateCalls.delete(callId);
      }
    }

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

  socket.on('get-group-state',()=>{
    if(socket.data.userId) emitGroupState(socket.data.userId);
  });

}



export class AcordRealtime extends DurableObject{
  constructor(ctx,env){
    super(ctx,env);
    this.ctx=ctx;
    this.env=env;
    this.sockets=new Map();
    this.persistChain=Promise.resolve();
    this.lastPersistAt=0;
    this.lastPersistError='';
    ACTIVE_RUNTIME=this;
    io=createIoCompat(this);

    ctx.blockConcurrencyWhile(async()=>{
      await this.loadSnapshot();
      this.rebuildSockets();
    });
  }

  sendPacket(ws,packet){
    try{
      ws.send(JSON.stringify(packet));
      return true;
    }catch{
      return false;
    }
  }

  broadcastRoom(room,event,data,excludeId=null){
    for(const socket of this.sockets.values()){
      if(excludeId && socket.id===excludeId) continue;
      if(socket.rooms.has(room)) socket.emit(event,data);
    }
  }

  rebuildSockets(){
    for(const ws of this.ctx.getWebSockets()){
      let meta=null;
      try{meta=ws.deserializeAttachment()}catch{}
      if(!meta?.id){
        meta={id:id(),rooms:[],data:{}};
        try{ws.serializeAttachment(meta)}catch{}
      }

      const socket=new SocketCompat(this,ws,meta);
      this.sockets.set(socket.id,socket);
      setupSocket(socket);
    }
  }

  async loadSnapshot(){
    try{
      resetPersistentState();
      const meta=await this.ctx.storage.get(SNAPSHOT_META_KEY);
      if(!meta?.version || !Number(meta.count)) return false;

      let json='';
      for(let i=0;i<Number(meta.count);i++){
        const chunk=await this.ctx.storage.get(`snapshot:${meta.version}:${i}`);
        if(typeof chunk!=='string') throw new Error('Snapshot incompleto');
        json+=chunk;
      }

      return hydrateSnapshot(JSON.parse(json));
    }catch(error){
      this.lastPersistError=String(error?.message||error);
      console.error('Falha ao carregar estado:',error);
      resetPersistentState();
      return false;
    }
  }

  queuePersist(){
    const snapshot=serializeSnapshot();
    const json=JSON.stringify(snapshot);

    this.persistChain=this.persistChain
      .catch(()=>{})
      .then(()=>this.writeSnapshot(json));

    try{
      this.ctx.waitUntil(this.persistChain);
    }catch{}

    return this.persistChain;
  }

  async writeSnapshot(json){
    try{
      const previous=await this.ctx.storage.get(SNAPSHOT_META_KEY);
      const version=Date.now().toString(36)+'-'+crypto.randomBytes(3).toString('hex');
      const chunks=[];

      for(let offset=0;offset<json.length;offset+=SNAPSHOT_CHARS){
        chunks.push(json.slice(offset,offset+SNAPSHOT_CHARS));
      }

      for(let i=0;i<chunks.length;i++){
        await this.ctx.storage.put(`snapshot:${version}:${i}`,chunks[i]);
      }

      await this.ctx.storage.put(SNAPSHOT_META_KEY,{
        version,
        count:chunks.length,
        savedAt:Date.now(),
        bytes:new TextEncoder().encode(json).byteLength
      });

      if(previous?.version && previous.version!==version){
        const oldKeys=[];
        for(let i=0;i<Number(previous.count||0);i++){
          oldKeys.push(`snapshot:${previous.version}:${i}`);
        }
        for(const key of oldKeys){
          await this.ctx.storage.delete(key);
        }
      }

      this.lastPersistAt=Date.now();
      this.lastPersistError='';
      return true;
    }catch(error){
      this.lastPersistError=String(error?.message||error);
      console.error('Falha ao persistir estado:',error);
      return false;
    }
  }

  async fetch(request){
    const url=new URL(request.url);

    if(url.pathname==='/status'){
      const meta=await this.ctx.storage.get(SNAPSHOT_META_KEY);
      return Response.json({
        ok:true,
        storage:'durable-object-sqlite',
        accounts:accounts.size,
        servers:servers.size,
        directMessages:directMessages.length,
        friendships:friendships.length,
        privateGroups:privateGroups.size,
        sockets:this.sockets.size,
        snapshotSavedAt:Number(meta?.savedAt||this.lastPersistAt||0),
        snapshotBytes:Number(meta?.bytes||0),
        lastPersistError:this.lastPersistError||null
      },{
        headers:{'Cache-Control':'no-store'}
      });
    }

    if(request.headers.get('Upgrade')!=='websocket'){
      return new Response('WebSocket esperado',{status:426});
    }

    const pair=new WebSocketPair();
    const client=pair[0];
    const server=pair[1];
    const meta={id:id(),rooms:[],data:{}};

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(meta);

    const socket=new SocketCompat(this,server,meta);
    this.sockets.set(socket.id,socket);

    this.sendPacket(server,{t:'hello',id:socket.id});
    setupSocket(socket);

    return new Response(null,{status:101,webSocket:client});
  }

  async webSocketMessage(ws,message){
    let meta=null;
    try{meta=ws.deserializeAttachment()}catch{}
    const socket=this.sockets.get(String(meta?.id||''));
    if(!socket) return;

    let packet=null;
    try{
      packet=JSON.parse(typeof message==='string'?message:new TextDecoder().decode(message));
    }catch{
      return;
    }

    if(packet?.t!=='e' || !packet.e) return;
    await socket.dispatch(String(packet.e),packet.d,packet.a?String(packet.a):null);
  }

  async webSocketClose(ws,code,reason,wasClean){
    let meta=null;
    try{meta=ws.deserializeAttachment()}catch{}
    const socket=this.sockets.get(String(meta?.id||''));
    if(!socket) return;

    try{await socket.dispatch('disconnecting',{code,reason,wasClean},null)}catch{}
    try{await socket.dispatch('disconnect',{code,reason,wasClean},null)}catch{}

    this.sockets.delete(socket.id);
    this.queuePersist();
  }

  async webSocketError(ws,error){
    console.error('WebSocket Durable Object:',error);
  }
}

async function doFetch(env,path,request){
  const id=env.ACORD_REALTIME.idFromName('global');
  const stub=env.ACORD_REALTIME.get(id);
  const url=new URL(request.url);
  url.pathname=path;
  return stub.fetch(new Request(url.toString(),request));
}

function json(data,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{
      'Content-Type':'application/json; charset=utf-8',
      'Cache-Control':'no-store'
    }
  });
}

export default{
  async fetch(request,env,ctx){
    const url=new URL(request.url);

    if(url.pathname==='/ws'){
      return doFetch(env,'/ws',request);
    }

    if(url.pathname==='/health'){
      let state={};
      try{state=await (await doFetch(env,'/status',request)).json()}catch{}
      return json({
        ok:true,
        platform:'cloudflare-workers',
        realtime:'durable-objects-websocket',
        storage:'durable-object-sqlite',
        dataVersion:15,
        ...state
      });
    }

    if(url.pathname==='/api/persistence-status'){
      return doFetch(env,'/status',request);
    }

    if(url.pathname==='/api/rtc-config'){
      const urls=String(env.TURN_URLS||'').split(',').map(v=>v.trim()).filter(Boolean);
      const username=String(env.TURN_USERNAME||'');
      const credential=String(env.TURN_CREDENTIAL||'');
      return json({
        turnConfigured:urls.length>0 && !!username && !!credential,
        iceServers:urls.length?[{urls,username,credential}]:[]
      });
    }

    if(url.pathname==='/api/windows-installer'){
      try{
        const response=await fetch(
          'https://api.github.com/repos/freitadas/d2-camera/releases/tags/windows-latest',
          {
            headers:{
              'Accept':'application/vnd.github+json',
              'User-Agent':'Acord-Cloudflare'
            }
          }
        );

        if(!response.ok){
          return json({available:false,url:null});
        }

        const release=await response.json();
        const asset=(Array.isArray(release?.assets)?release.assets:[]).find(item=>
          String(item?.name||'').toLowerCase()==='acord-setup.exe'
        );

        if(!asset?.browser_download_url){
          return json({available:false,url:null});
        }

        return json({
          available:true,
          url:String(asset.browser_download_url)
        });
      }catch{
        return json({available:false,url:null});
      }
    }

    if(url.pathname.startsWith('/phone-camera-qr/')){
      const token=url.pathname.split('/').pop()||'';
      const target=
        'https://api.qrserver.com/v1/create-qr-code/?size=300x300&format=png&data='+
        encodeURIComponent(url.origin+'/phone-camera/'+encodeURIComponent(token));

      const response=await fetch(target,{headers:{'User-Agent':'Acord-Cloudflare'}});
      if(!response.ok) return new Response('Não foi possível gerar o QR Code',{status:502});

      return new Response(response.body,{
        status:200,
        headers:{
          'Content-Type':'image/png',
          'Cache-Control':'no-store'
        }
      });
    }

    if(url.pathname.startsWith('/phone-camera/')){
      const assetUrl=new URL('/phone-camera.html',url);
      return env.ASSETS.fetch(new Request(assetUrl.toString(),request));
    }

    if(url.pathname.startsWith('/invite/')){
      const assetUrl=new URL('/index.html',url);
      return env.ASSETS.fetch(new Request(assetUrl.toString(),request));
    }

    return env.ASSETS.fetch(request);
  }
};
