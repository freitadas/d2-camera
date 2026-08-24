const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const server = http.createServer(app);

const DEFAULT_ALLOWED_ORIGINS = [
  'https://d2-camera.onrender.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

const ALLOWED_ORIGINS = new Set(
  String(process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);

function originAllowed(origin){
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin);
}

const io = new Server(server, {
  maxHttpBufferSize: 512 * 1024,
  perMessageDeflate: false,
  pingInterval: 25000,
  pingTimeout: 60000,
  cors: {
    origin(origin, callback){
      callback(null, originAllowed(origin));
    },
    methods: ['GET','POST'],
    credentials: false
  },
  allowRequest(req, callback){
    callback(null, originAllowed(req.headers.origin));
  }
});

const PORT = process.env.PORT || 3000;

const httpRate = new Map();

app.use((req,res,next)=>{
  const now = Date.now();
  const key = String(req.ip || req.socket.remoteAddress || 'unknown');
  const previous = httpRate.get(key) || {start:now,count:0};

  if(now - previous.start > 60000){
    previous.start = now;
    previous.count = 0;
  }

  previous.count += 1;
  httpRate.set(key,previous);

  if(previous.count > 240){
    res.status(429).type('text').send('Muitas requisições. Tente novamente em instantes.');
    return;
  }

  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=()'
  );
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "media-src 'self' blob: https:; " +
    "connect-src 'self' ws: wss:; " +
    "font-src 'self' data:; " +
    "object-src 'none'; " +
    "base-uri 'self'; " +
    "frame-ancestors 'none'; " +
    "form-action 'self';"
  );

  const proto = String(req.headers['x-forwarded-proto'] || '');
  if(req.secure || proto === 'https'){
    res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  }

  next();
});

setInterval(()=>{
  const cutoff = Date.now() - 120000;
  for(const [key,value] of httpRate){
    if(value.start < cutoff) httpRate.delete(key);
  }
},60000).unref();



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
const accounts = new Map();
const sessions = new Map();
const directMessages = [];
const auditLog = [];
const friendRequests = [];
const friendships = [];
const privateGroups = new Map();


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
  sessions.set(tokenHash(token),{
    userId,
    createdAt:Date.now(),
    expiresAt:Date.now()+1000*60*60*24*30
  });
  return token;
}
function sessionUserId(token){
  const key=tokenHash(token);
  const session=sessions.get(key);
  if(!session) return null;
  if(Number(session.expiresAt||0)<Date.now() || !accounts.has(session.userId)){
    sessions.delete(key);
    return null;
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
    createdAt:Number(account.createdAt||Date.now())
  }));
}
function serializeSessions(){
  return [...sessions.entries()].map(([hash,session])=>({
    hash:String(hash||'').slice(0,128),
    userId:String(session?.userId||'').slice(0,100),
    createdAt:Number(session?.createdAt||Date.now()),
    expiresAt:Number(session?.expiresAt||Date.now())
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
    messages
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
        version: 8,
        servers: serializeServers(),
        profiles: serializeProfiles(),
        accounts: serializeAccounts(),
        sessions: serializeSessions(),
        auditLog: auditLog.slice(-2000),
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
    const savedAccounts = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
    const savedSessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    const savedAuditLog = Array.isArray(parsed?.auditLog) ? parsed.auditLog : [];
    const savedDirectMessages = Array.isArray(parsed?.directMessages) ? parsed.directMessages : [];
    const savedFriendRequests = Array.isArray(parsed?.friendRequests) ? parsed.friendRequests : [];
    const savedFriendships = Array.isArray(parsed?.friendships) ? parsed.friendships : [];
    const savedPrivateGroups = Array.isArray(parsed?.privateGroups) ? parsed.privateGroups : [];

    directMessages.splice(0,directMessages.length);
    friendRequests.splice(0,friendRequests.length);
    friendships.splice(0,friendships.length);
    privateGroups.clear();
    accounts.clear();
    sessions.clear();
    auditLog.splice(0,auditLog.length);

    for(const rawAccount of savedAccounts.slice(0,5000)){
      const userId=String(rawAccount?.userId||'').slice(0,100);
      const username=normalizeAccountUsername(rawAccount?.username);
      const salt=String(rawAccount?.salt||'');
      const passwordHash=String(rawAccount?.passwordHash||'');
      if(!userId || username.length<3 || !salt || !passwordHash) continue;
      accounts.set(userId,{
        userId,username,usernameKey:usernameKey(username),salt,passwordHash,
        createdAt:Number(rawAccount?.createdAt||Date.now())
      });
    }

    for(const rawSession of savedSessions.slice(0,10000)){
      const hash=String(rawSession?.hash||'').slice(0,128);
      const userId=String(rawSession?.userId||'').slice(0,100);
      const expiresAt=Number(rawSession?.expiresAt||0);
      if(!hash || !userId || !accounts.has(userId) || expiresAt<Date.now()) continue;
      sessions.set(hash,{userId,createdAt:Number(rawSession?.createdAt||Date.now()),expiresAt});
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
        id:profileId,
        username:cleanName(raw?.username,'Usuário'),
        displayName:String(raw?.displayName||raw?.username||'Usuário').trim().slice(0,40),
        bio:String(raw?.bio||'').trim().slice(0,300),
        avatar:String(raw?.avatar||'').slice(0,350000),
        banner:String(raw?.banner||'').slice(0,350000),
        status:['online','away','busy','invisible'].includes(raw?.status)?raw.status:'online',
        createdAt:Number(raw?.createdAt||Date.now())
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


function recoverServerForWrite(socket,serverId,serverSnapshot,legacyUserId){
  const safeId=String(serverId||'').slice(0,80);

  let serverData=servers.get(safeId);
  if(serverData) return serverData;

  if(!serverSnapshot || typeof serverSnapshot!=='object') return null;

  const snapshotId=String(serverSnapshot.id||'').slice(0,80);
  if(!snapshotId || snapshotId!==safeId) return null;

  const cachedOwnerId=String(serverSnapshot.ownerId||'').slice(0,100);
  const safeLegacyId=String(legacyUserId||'').slice(0,100);

  // Só recupera automaticamente quando o navegador comprova que este
  // era o ID antigo da própria conta que possuía o servidor.
  if(
    cachedOwnerId &&
    cachedOwnerId!==socket.data.userId &&
    cachedOwnerId!==safeLegacyId
  ){
    return null;
  }

  const recovered={
    ...serverSnapshot,
    id:safeId,
    ownerId:socket.data.userId,
    members:[
      ...new Set([
        socket.data.userId,
        ...(Array.isArray(serverSnapshot.members) ? serverSnapshot.members : [])
      ])
    ]
  };

  if(!recovered.inviteToken){
    recovered.inviteToken=crypto.randomBytes(18).toString('hex');
  }

  mergeRestoredServer(recovered);
  serverData=servers.get(safeId);

  if(serverData){
    serverData.ownerId=socket.data.userId;

    if(!(serverData.members||[]).includes(socket.data.userId)){
      serverData.members=[
        ...new Set([
          socket.data.userId,
          ...(serverData.members||[])
        ])
      ];
    }

    saveServersToDisk();
  }

  return serverData||null;
}

function canManageChannelsCompat(serverData,socket){
  if(!serverData || !socket.data.userId) return false;

  if(hasServerPermission(serverData,socket,'manageChannels')) return true;

  // Compatibilidade com servidores antigos:
  // se o antigo ownerId ficou órfão após a migração de contas e o usuário atual
  // já consta como membro, ele assume a propriedade para não perder o servidor.
  const ownerStillExists =
    !!profiles.get(serverData.ownerId) ||
    !!accounts.get(serverData.ownerId);

  if(
    !ownerStillExists &&
    (serverData.members || []).includes(socket.data.userId)
  ){
    serverData.ownerId=socket.data.userId;
    saveServersToDisk();
    return true;
  }

  return false;
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


const APP_ICON_192 = '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';
const APP_ICON_512 = 'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6AAEAAElEQVR4nGz9Wcyu25YeBj1jfv9qdrf2Pvucfc6p01dzmion5UpwFThuEhwlTqKgFJKDguTgCAhCgBDiglwgIhEiAhcgLkAIEiRMQKYTok1cIRVIZ8DGxsSJK+UmrrhwVbnqdPvsbq31/98cXIzxPM+Y39pra+31/9/3vrMZzTOaOeacgZ/8agIBBAAAkYmMQCCR9RFWBDITCD/H7/R8BBCBQABIJB9IAJGA2g1+OPrsR3PXM4l6fgXimsgAOKIIINHtrGqqWoseUyJ6PJ5B91PN9vPpcWRW21jI3PVudVRDjKgeAv0c+82eM4o+arLnm0BEtdvdsEGP52aMB3UjEJtDrH4DNbb6PbERiExgNV2D/AKAVd8FsBMANlYErtk0XhxBtx1A5kJEen4caTM0osae7o4UUV+gvPTzmRsgDXZWtwhkZPO+xxGh7pBArOVf9u4fq73cLY6Dz0HaRmBn8SCad6Qh+RhI/z6knbzl7LN/XmOMJV+JyH4vd/PW483uB+LFkBfKQd7wPsICOnSkxsTxUmbrmWD7gaEbg2+osRY5ErHMS/ItTy76TbYXidwkOJAZblvyE5pTNG8lxhQh0rmnkQDWavoLDqyd/G11D5kprCA9YmKS+suBCTloiuafpErkLAzw7KXTAUQ00LT8qb+IwTMxWbJDLAisfiwlr5rHOQThCZJdzXGNfjObr02/3EOG2EC3R9nPRCxJcs+LtEtEXCwnPTLKHHVLMijxjJKc1bagsSjYQjSlpWs1ppwMo20RP0umi9xFCGFliHPWP9JvT8whBg97QExa1X6NbbfsTj1q+eZcNYemZ9sLKyf1h1wiXyxXekbiMvC0MTKaLsYgYHYzv6uvCweFl7IDU8eJgcN2hfF6HaI1GCIA42ApWEOZmppYY8CEKBlEIkkLW+J8HWhj0kQSfA3gpt4RRAToZyugkuYcarrtvHlaOt0vGMhiPNQNDY0VCeJsq+aS+iyQQK7je2wg9h6ADs2nph1ueNczE1tyTGrnAFeNNbA3SjAysdE0ozHCwlJ71fZKfgfNMzWeg8g2itWwjAdyn2LRz8zxT6NC+cgpU0cDFtrcG1s4nvNry1kDUe7R1qSlxjBoTsI1eGYrq+ZItufhLjZfag65gcRCxup5tbOVKbmSQuvnMcZsWMxqdyqoqCv8HMwQ8Mw/5VwYcJqCnHuDl/72WEIAf9KY9KGjdPzJyfOmBeg0pcBYj85xtQWeYBiDHlMYorHoFd3V/Ft3b/oTSPJhyvNsg7I5QJbvURaMrgE6sX4vyzE9jP8tLjVWZeovxit84XZ+KWHBK5jG4ZR89Rg4t9lwA/jUkQPuG+/iGHDrgvC1kWx2nrON+n+QJq1zeQCkeX6wGLfzHg4baTDGamXoYb6CG4PJZBvfH3gr6c7hBKmtVuDMYZcGQSgXaUft6FuymmOuUmAcDOjXJHeisQYtIqU+Gjp2GEdUYIibP+OzwgZ7EzuBO3mYBy09YEUM/TsbMJBzjCXY69IDikRid4MLiw5Ee3RUYHs+3XOWRzY9tmpuCENHNIFAbmAtwJEPha7ajRuhKmEl5WtuQSIOAaaHDdhjL884bCQlk+1ltWQLVHq+EQtlKWzUIhZ2A/yK6Ah9OAUUhpjzGnMA5D0SgNl+fdR9UickzQSzUlopZ89d8+x2N71qLJTHybkm2ezX+8mgkkynpj8jX0k7B/1rtMm4slv1tC3wU46a4JabVsMD2ENNqLFbENK8UbxpGaUKhaKpjYXl6IbCwLly6nIG82bsob4mMHEqMadMQ00aduqlmqI+DvmWeJpPMyOzMTJ6U64U1aeGOemkTE4D5uT5DDqd8QmLmnqqfs6MAezUxqT2GFbrnTBU2DTYyMgZzDTe8LazNhpL0yDCsm5DWQNfN9Ez4mzzyHYGEcgZQtOlxzv1YdDVgpotLY2xe+jAbAeGZEWNwYCtMqe4JpQmAzpC9+BHjK7fnSGzfjpa99jZH5AKNHLN6JV07uxky6lm2rLH8aNxWqmxFRprNcUw98QW6Yqw0u8QHkQ7jMzozoqU+RynFwNTE1gIZzpDmoFpt6Tt4zkwkyybiTGwsLzpm5FxYTuYsjZxcOCL+rYek16ZzHRZ1oAQDZhNv0sYnIvGjDrc0eZEjUqHwZVAxDKwMFXSBowRggzRBhC7DAggEnBSihDVL4mfZkgGEGVGqfQ1dgpwnkAmi0S6tTcVZ+QlI8xJW+ORmOBmYy9vVYozBHRfIcBCILOTmj2knR0SrHUYkgJrdXwo3kTWlBPjcayon5zws6DdBgkE1tgEmE6zY6Srwe+GII85m/dFHwYnmDyfY9XyA+WkwU6Ky4Ge2aj2lGQYyXXKV72/pcTZMrgI0Dkl7VAvRCyP2V9rKEG5jlXZl35IlInJBwgAAEgPNJ8VOMg3YUB5vW59ODpKI/c4BaITyGOkI/nemEPpi2WtnMVzvgJpQA5FCesWoJvuE5DYbQP/AK3czjZoGQclC5la0TucInB+AmHrdkQZC0X/0wm/4Z8CmBs9yakMgCxH4vw85//SjsE05sc7hwxHpdmScmbSJ7JT0j1nyslku5QibAeaLnS4JPuZDOKLr234rc+Us0AFSaT5GHSc8lj6QLmqfvbetUTXRpN+7WExxQdm2CAHQnwlvykX8IDyeMZ4XvZkvJuo5eL+nU7H1Bexb9kRy5YnfXDw27gfJj20ErZucok56di4RPsQ5zKxcLhJo5hzCI7F8tR3tb2Im0C25lRw5oxGLUOQtjH0h/QJLFlgNp5QlCHvj/+nMYo11m4H0dK5LSlqQJHKXKenZZlZBAoTB0rCFIe3DPfqL9YiaJcwF3ErLSmiUtFiKnV2Grf76WEXKClpbnIPAZJSxHzqBkT617VWzTqWQSyZ7uz3clCY63igJ2egpeFBe6g7md5voG63V5G7ahlMg9Vp6ilwEqwGhp27ebPKebhRDmcdzLMEOg3J7Ap5DAGZHu65RlDsdo/DshNpuggM9nbaWoJBYMvhjfc7yly019vf0mhrOAOoD4dGfGc7KYVlRil3ZXUCC+HssOi65ZSEAFyOhFKYiXX0Sxrbwak2hlzDuhjixTl/ZV0EQFlOUNBIpCe/LcOkj8beDdLQb7af6LqAwSMAue0QDC5BBhj+s9oaztRsttzEKr4t4kY0BuS5jjoNuCL1Qx1POSqa7IPWqaiohSIsFnsPwOTcmx4x2z+ESVSTIeRSEkkhg5sQnWuJpj533dOwPuoiPca9z15v5Vt0Mhk47kQ5snOJhbitTA9adrut3b7pWmv0cxNtcijT8FL+NfyQfZlYp6USEO+OiXVAI6W1TuxdS2iav2mK5b6Ee2N8k3uUhVdwrl9arLVi36jA51wAJcuWje5oBihsKBOYwnR1Ih6T7sR40w3pOZDKMbJzMRwdOmqpdxaYgfMbi0I2DESOtSU+R/ALp2lnup6EjvHzq0rjSa2FGgX1KxMbWwAW6GiJQQoVtidkPpnR4luaqLM869BwjDzGZHqgItextqhhNo9o7Cqas+PwqoEZIIVExpbzIfiosFhSQtkQdu42dlx3PQZi/kX4s82G4EjBi/dJJvdQp3vGSO00DDXe+T7JuDXYUuh9RP3KIrjasxwwrdcbtDMpMwYtAVZA3/mP4QxJo3tD852qp1A0OxCROq1+R42GHJppXU/SIbHlz7nbGXmYlsYU8tHOnrJvO892OISYBn+Mh5ggNK2lG9cikC/Ns1H8STkSH6ujodPZoJmScc8JkOPEiC+Z3g+8QhL1N/jTvNcySzHxcCQzN7DL0cudctLtcaXEy5mDIbts6dDF9Nj2GAPnw3YDw7EwPewcjr/D+yPt7KAwXKAcjIBE407hXH18UyyQrTNgtAyv3IC8GO3J4aksQz0a4vkcdy13ZDmycj4BBl5yoKlvxNykFRjyxbHeeB2j5hB0ooFpVrKhLKQvMxtLpy+ET3Z6o/vPRNsG4iCZnEPuPSzCAUY7dBLGYJu8N3PKbm0s/1BXdiZ2bo932JYy0Et61uQCYlk91lwqOMcmuZYD1Xayv+OyjGxDpmJLfsQ21pwt19m9nrwGsYQwitLrU0fwNBIyLgSIYVdl6OnF3IJsJrCbsWu5b0a/EoIa4p7EkNDPTMMCklXhFmAJAscWAa6LjVgKTJWosGko9Ct+XcKVwYoqUk4LwnMqei89x/lnhiqVczW9FxXOf1bHRsiQgw4wYiDQ1ryLTrvT1ssZwvY5mAoL0RFgRCfvA9nFnu4T/L4/i+lmolL/WmtNj07rjUH2hJQhWmmKPh5HTK50H0ntHcp46vwAZfCxFDFlz/gY11zJw0QbaCt+opwMuz4ey6YzyXmrLctbDGX5tOI6g6id50Pmxvf+ukE4nFjY9I4lb12kyOYYBVDu+n0q6hnHA9Hub3S2zUV3ITLHqJC3yfCcI+UnAomuL4lejqWxGiRJa5h2WFBPpwElXYLOzWR76wD/TjCaKC9HDBIpEacNDQMNRrryCQ7+ddDUyrUE8AHipfue6XBjux2QIRv9/OLrw8ExjeKV8djRN4arwJEGU5+1g5UAy8vnTocyCcNG9DyDAJXneLRCrmnE+D9lhks5t2yRFgvfvIg22+/Pug3KHQ3sbKf+LOGc9HyqYNYSwmrGSFzHksPNpAAs2aGyQS6kFF/4TpgPRCwtZyYlpPjFYCZppJZl/sgadTaGO2I0bVJzOEP2C0vIl0janWcLGkdUhpYVJAArb6qBpcEDNe/KaAyiDvCNYcm01Q4eDBlXy5MNCBFstCdboJYygBhR74KLlHrZgU6LgMUAQUUT2Im5MwJBE3d1v2jFMfDtbbjLESXN/hBUsH18phUYEcnCybWeJNmXDZMB2oowRmsgHZkUAr2kpCcQKOOnkWcZEgI0Mpz6ply0UFFcSFMqZBnG7TENcLcyBFTJjE6jBWsQpvCMCCMJCN1L+hmzcSK4ozHk/M4mdE8ZygnxGppkbQyp1SQk09wNswXgAHKrRu9YApuRBKnG8ZloHPZ4hRprnaiJrAE0BoECEcrbTLelaZOh8dkIOZO2b+RNtDss4Ij+kZ2RpWPC/knTqR/ZdFwaw0GXPIWsoKBwJ6+jz7SMmTf1GeuTmGKXWhpaak6tL1P16bxmppYDNpcQmv/l2HSgs8b4KZLMjlAHuz1qr0F9LEUQG8NBWHegwccY4yBZP+pMbhD/cttOjyCJYp1p3Cme79HgwJlp/HpuRbqZoO+M46c5ucMm0wC6kzPojJ6vI3rG/1WHICcbJStcuJh0INbMyJfbhFd8+rNSGb2TLUPrILRs19RThDIur4Qvab7RsVwjE+B3jNlH9WY/sdoW2fl3YFeO2ki3KMUC8651evkZC4yN0BQP9r2ps7Yv8Hq9FFDKzKUCkQxaD2fL7CdN++giJVdSyueZJqaM8gR0N3grdvLCh4SBa7ieIEz4Qb+jLRmZW7BOg5w66P/TmK6lSItZganOp1KTyp0GVXdEn5RwTAqTL6LBTdRTdNqNJW1s13iGzoeET8M4HV86TxPQJ63ms/ycxCErCND8s+YLQzlNGQkvnZdTQfhq0fpIE2baeIwIKo63SW/2Q+Bw/0zUMSogjbbatNr7mQZKjkeGyYaLdJl1G9NDFDliAEVA4xlhr349c8QjEzVoPKP9PSP7Bl6nL28Mggyb+e/15hNMLbqdio1QLQ+Rk6DObmr4fNOrrKl6CG8t9oRJav4sBbMxpqpOoNfEZgTPecX4sWkmYVbUg3An/fCUyZIjLst4xqa9InNgLD0SA+v5zb2/w1HRmm6Zk0/BLy5zzjya8oDNJinkIXOVGXFt0mxTY6CDfvD5U+g4gkVhfgAhCTYzzJteWl3+PYmlwrQEHRpibV6Jl21Mo3T5wLnMV7eP3lBHvGlaeC6DtqN+CYrIY/zt4TZfTpVMa1CEibhYV0QsNk+n0yTnelidg+b9u5Yo+LdleimKEOhNBHFEPYkBEhNOm2WGon8pAubvIQXMm8GckYOjvQzUlhbEGSmzTeyyF0N45cQk2UblCWAY0dURPQBMD1rBIoUn0tWi2QU3wrYYDks9YxqgBaeFnh6Z5gpFhsLp6TDIqy1hz0HP4lkJPSOCVzIqYHFT9b8zNc6al3L/BRuBLrSD5ihpnZOWoxP+3tZc83YNwMgQYRjJOZ/+s2DsWSPLcIAT2mNGRweU9VloifbUVR3essDxc3pUbHTNwoaAi/JTtoSyW3RlIdwatIYMSmAd6XXSoYtUGaWK3+mgXOt+sPHIAQDwcg+LxIrEXQ6apqeNgwHchrEMhUHJ2ZBQHY1T7dGW60gh91wo69IdGf3UNCQhU7lyjG9zZ1bxlHLbIxJYBZySLqwcWEX+xvx5GAgM47NGFCZi0Qnje5aTKf5+p5a4kljHKZFeKxBxgbJZTSAWPlquyeuULgJoI0L+1M8L0UVoHJP1fe+uDxrOpCJ9imgAyvNxSVVWZbv4NqtmpUhpmtq4k3n1XPLbbTkEeemXQH0jHpZcmcCSz+FnMiWeQ+6O9fQkjcZUxIcbLu7dSxxcdlinQzDxl3+2HRkVvod5UryKoUtQTQnVgY6SM82jfbaZzgaz/m3PWhdzffDydGB6MC2TPU4uG0TJlDIV3ZQ4lDd91Id5AOKMcIEcIObouxR3pH7lgTXUZiLzOjqzV5rjLRF097sS/BbQFQ3AroJVYWA3vUeuSUUjQ2m0ZoLxdwiShjKNRlmxFvL0Q0AJPI6Pag7DsSIWSNEBA0QPZh7SYqa74KPaiVLmvc2TcRIW+cWUZMgAWX9VqATSLQyqBGlFTFv9YgjesV7ZtGG19kC+AZDwfi/Sm92NOSr1OdfrJ1P4/1GhPH3Xk5lmahL7jqaqgbmV1SO3As4Kg9Dn3bn6g5yu+Z08eZKVIzrWeWkE4jAk7EdDbTBS9qUraV2bQ+ONYRTNYw6NKem16AzPCHHQWTs8elzT6LVDuzCclwF0JRIDdLuuKNsUeTOCA4SgU4Rwilb/eHwyrjDthSmdqs2eJ53FQ2ObHmfqd+TiWgZd8zEtzCF6ao/8J8GVHR36f1thfqTWxzRizn04+JqIdiw1xmoQ1EnzUdjFfgxQRXtZK47ISxN28Tz9uZSmIa6QPB+F4U0LBlApnABmUQiLFXlOxamj9aKi6HnyIaodLfvOqGxxaSylagMNPDYAzDpb5YceTt6Jpp6jgxTc/HHGT6QPgmD9WXT8I6vuaxTFzeayCzLP8Uwa87WBR0Mm5Szs1AFWvWyZ9m56MjkNJkMepDNeEqClgaanqw5LkMb2sya01zwo9AlEebiKHnsiXsOEmOkzEJtPPYdpJAXQ08lJEzb3Lr9irpdwPXTiYCvA1ljpXUYr+aB9KyczAocegsw7xA+qEG/FrTnUXH0EhrGBArpI++3tUd0gIhwt1Hwu5xYXgcGacjKyXHH0eQr+agwZa/Bj7CCdbgwOV6BlAfuLTLhYCilnz0Ti+iozNp6jjXzTcJ1924cKcN+z+N+MVhZmcFERLOnAKLQVcAdrB9DA7PoZRsfZRtM0yDYw1SELNJVFYTSyOo3Yu18cMQ7lF2i04dcuGbheRPrsQ4u8I9FG6MDpIBdsxBUtds3KbR+J0eb4Q9YU3s00amMA+12WwQymUOcaZ+uagB2OupbJJ5lS1GPe1ViWMYjSRnqM8VrwcpJp8MFp3iR9AMzjj0m+GETIo4POuHLeMnjVBneChBzxYhShWFk+OmXa/y3qeyBqz1neucvigMkhE+dolwzZXFZzBiwOJ90OQtrLC9zgxadsYTywYX7EOZIuwxXsbIyVnQ4MRtHtQlwulWViXZXsmLFnFhyeREj/iyxeh7rvWOekMWdAWwo6DO3olDidNRDGrM4kpvmiJa+Z5elx22jJCEoYxFducx+Z8Du0gaenKi8zT4Gu6HZ6YPycSe5WuKCyFlKwEE9EH3J5cLv/4RJXGYVL/7yBHb1Fxuu45k6PbBIgqmB1i/h0RkJCDE/vxmlYomfmxk6mRL22C3htTgJDZlBeenhT5qfCWQmHj52V3uf8Th9w/CEABIbDVO8jIQeTo+ZZ7jb+E+A5vOz+SVOMwbvbmP1YQAb9KA/+XdXZ6prAyB9JU6fuUmMJbX8iqDJ6RSZ0x0QmcjhzPFAnVstLLvfTJyVOQ8FsUoHA6sNboqcXnjIVU9mSDcQFvEPBkVBqLuj3GcXMdXeCQbbQCrxmxMfzLVB6wAQxjQcARc2kecKnYQKJzGX2sK0pXzyXPxdeOUwoLrVDg/qk8/ED8zQTjjvA+Vo8vJZ8AddODyegH948pY17zoPLWc3PHhcDtql50fSYhhcYuIYe76HJeEXOsVuuDqPEnqwfXDIB8Xb5hdLNUz8oC1KEgYfWjaGbN38W9bn7Dp1FAdF+Glke/CMdS0bKnLNpZOykbpl/TtpZb5FpPIDfmbUtJ/ixH/bRNKFTMfRYNByG7WRRtvMzmz1/DxG8R65Kfvjf0KAh2WIROmCnY9g9aS4DKri9YzjV6WFjou3L3lfTTbamecYRNxiFJzL0yVIvPOyzX0hbZnh50FQxcshqJO5yHhcpIGzlOKw1iXDEScMbLGLsZmYdleplAhKnV6TreauymYPdEXkWQEcgdxwyimAWoKohOaA+E7AcBBo8MBU4AG3NeVpJ5aGT0eTCEHAez1kfLUmTxdvgIJI1R+s9zq0FXEwlZ9EgbLDde0Nr3L28Uo4SHbKgrFXfsVxIFfC8e86M7QuH0jhEEO/5ztoQCei4SEO+Ynvf3LbH1KTmp9ntXjc1cY4InfkOydQEsqY3oPERKI4iwgjvUKAhiACu6WOtOZnclUUJeIvn4gVKBqcegWyeulIdVQKXRO4rePETOqLLtUYGzfTDrjMwHBV2dN27XHT5EVBt7s62zENNgDbKfD/BaD24X/6yFJ2EwAAayyG5GwfdAqi6ENIoE7heUR4IjWMOw9P858l2m7LHMfZM14PsXHb0RucISTZXZitWFA0TWJwrHTqdylm8ixW1ZMjUTDsn1JG5hTL1Ocba96D9KLaTUc1U5L/Z3wg6GOTIrqzoZpoGMq5Lw6b6+ucQrfISALNtYw5Sl9yoC3wcMCTn12MaifSezgiqBv/ct1QO8uD4DNuiTtDYDytIXJX+Dn3b/XzEbI/jTjnVDtKgdxXwzTH3O0r5q6+jtACMqrPD6Xm5U8194CM2AhfjNp8hDWWHWufoAIO0gPRzOt+WJ9uMaRw8PeJv29JFPWl6Cpc2UbywKwKxLmBBYjQ/jz+iE20acNfTsNkqlB9SYMZPuLBLYGPM3znAAnJ/mq31WhiIsWbT+9QFhuw9zQgKyqJwBjhqMzCijYWj4zpQI+Bwg55ltU8QroKkUWjC0U/Xs8+pPg9JaupFGfjbYIJzJDtmdBTIMzWY7WC0sWJU7uqNQR1Fy63sHTnM9J6yMJc404lNKwI26xeCDkK2Able29AVsCplxlQu99vGAh5fgEcLcVlOYUcAdwu4uwPuAnF3Qd5V1Lsvl6pFu7uUUi4Al0u1vXoP9er09eqC1K4H0RR3dhtRjg+dhUtdUsXbz/bDRlzWcIhagtelxjei6Lw6SlJ2ZdSclKwsyVDNZ/nI50sgr9cygGsN5a/19rrLYmHdXUYqMRStYfCFOpBZNzmuuEgWWAeQaKMccAVyopbgeFRujyEuy5H4xenGANq4By4L4JYuASR17cr59xDpCKzAvhbyrruF6/0DcIUTBSxqW51JuV6lY8fZCIiiI/c2L7q5C1z2i8ulC7q2nf09HIDrFk3zegWuG7kW8v7ax10D6DqkSCDvrzWePiM+H66dKi1jttYFuO76223eAcD9Fbi/Fp0eHpAP1xarRriHBwWzvIApd9Y5/XsjHx5qbO3g4eEKPCTy4b7ozL/RgskxUReII4z4WNh8AbxDgkYqZZh3/69Yz8+jC65b3oTwsNU7LCFJTHoSg/pXrV0a9TSiJAbS+UiOtJeNR3fDtjvdMKzQGNusiPeNqNA7M6BNGkj6KHOuHSweOd+W9yNTLPwedk8O47Ww19YbvFVTGbJdSjwdGGY2VeydqLqAPflQYypypBwqOu5zSaDGLe+Ck22nKHGnc4Sb2qVE6DQINPDpNdRzGJ6naaI/wxtTlOqQiY6SBbMBhtEAq9+nI1BMLIFxJNvdRPC4bcupjB3BlU6HjT+JDHTNQt1mVELUF5HK+2rnKEkDeW88uXAIZ+Q8WA0+isne+bTGPUwpTgzBzYMIYV5SUNr5sD448yKB6PZ1Bv01getDHRkMtPEE8tIG+RGAR0+Apxfg8aMy7I/vgMd3wBuvYT25Q14uiMcXrEd3wN1CPr4DHi/gsnxmQqxer6ZDIGaK/4poKZg97isNBz1rECYgRWEamTklIEa8udQu353Rs0S6j2ze2BYLOEPF7JGcNkZpdL44vHTauH7v89fh5QOuOScCuS5j/XmJTyrw49iTQL5wbSGpcdFxu8pIKJrEGOfRHuUnPTYYQFZ4m2oRgkAS0h/Ay7rX8LIC+9VS8Iq6bHXsiV6KzBM7et6UbTrCM1PDv5PnTZgQLXsrZI9brnk3Z7c1kJ0wVJYBiYhLr3CTXxxiapdROeXcrrGxuAbNTE/r9O1BT3PJ7YLG1rzqRlA5knsD95VF2i9eAC829scvgPv7ckKvD9gfP8d6ccV+8RL5o4/r7ycvgPsr9ocvkD/8CHjxgLWB/fKKvN+IrnxHRGWDLnfl8N+Vo64gjUYCUBTpTNDInvS8zh0gtgHUg1d2o0hGzENlfjCWvchp6ikzrsxcZaX+6QcQJw871PJqHIDa8xKJHQRiIm2K848OjW0yuKQysjE0xvM+grYBCiYDfVa/Z9lSPGSIwE6wS+nCURQJwM4MTloH5Zfz6/aZtSEjVMT9za/N/IME30Ai1NOAFWlykEx78qYEX+thpZ6M9a/ySDhwCtcajBIxhrJrIrNNWn96fDBhAp6mOpe7SrxLC7ts1ca8XazcZ5RXlhSCWrbI3e4UPUvxswVL3VmozMU5nvkFYNNWbycpHDRUMNhFVWQXqBQg1Z7YVtgF5N0CnjwCnt4BTx8h3niK9cYT4LXHwJuPgSd3yCd3yMePKiK/MMrnuHt+rKbf157jGHcmsg3SBpdqWpg1m3a0xuFSazmyyXYAUrIzlnaW5WO4OPXuSO+CDqVoNNSIchd8L0eyhalC/6x1a0TfqwAwzM0eP6LGvKXs7Kh/IhCtwIzignIzJMQ0snJL79SsYQl6Zk5xzWaUnle9DKwfAkW2S7mnXMWrcjlRqeY/ajDCTjLrIhTscJ6L5zKQHct8GhONYNGkcUioHGdGUTRJY0Me+pcCfYIl96Inuo8oQygMlcw6KFkjclO2K1DLLz13O4upPgTQAbA4N9pAIwBcWja4O0PZKS+t+sa80u3r/T2uH32C9eIBl5dX4MPn2O9/gPzu+8gffIT80SfY3/sQ+f5z7B99BHzyEvn8Abh3jVPeXZB3F8Tl0uUypGPLx7gzYmJ6MxvMVRetKU/989SpEFer/SHHkmHyrp0n3hDK9+yQeCwaWQxs5HNDJhV0JA55pGPI3S5G6sDEZP3YdJn+awLWr4CcFeHjCGZMx9b3FZ0hKHqSXjPbvIltnPChTzd2gt8zs4A8gwtkZbJk7adNUjHaDbtZCXxMoDsMek++Zara3K94hGyYBt1A5rklYM+FyopmbhtcpzxaOYOGfNCIToHWgNxegnYpj/kWczuCyZoT36HSW7jWmBhHuSdr9Wf4lMPw9PWN+4bY4u4AaumPATISlbbuC3MqZR6IJ5eK1t98DfHsCdbbb2A/fYx47Q547RHicgesRLJKPAhznFtWavT6QGts1kVvH2vwXmFtso4Nj5o4AQKLo0oKyxrgz6xRcMmFaH1ZgzTmeSkHWm4vzcua01o0DCnFVlRbOTZU7Ql551qZ4tgwSlyT7UlmLzEFAutS67Foe5BxKVp2enoxqkEZuoTjcESMy3FgAJziMEUCEN0qMt2YAurUZYPghZEcwZn8bGBSNbnHIHCNEbmrXRwOem3hGhkXFs5GZ3/QW5hIYy6LoJYRWM1Ovp7Ggk4LZccGWIdpqSCMGDRiyjGPaNoTDoYUKWqkYc/kEa8kBuc/SuIC/lkMGhxjEWkbi3IeG6NqLQRK916vLecOXkTb5omMq7Y1tkTdLVxefwK88VpniwPr8iVEXPpSMmBfr8D9Rj5/gfzwE+T3f4j9vY9w/f5H2L/xXeC7HyJ/+Bz5/fdx/egFcN9ycVnIuwtwdynMCLS8oSP0Nj0JOAvVObS5W2tYSmUSKNYdGDirgOPAn2kzc9BeDsLYOZTocQk+0w9TZEdQZp0NzkS8PLII+r+xX7fDdlEx54bRlbdq14ch3Q41nGl5tCk5sy0kn15qedb8bOJsp44/fADDeegMQABdXONokWJNY95YKeMYwXUMc0NB4ujTA/KEgfZglxmANgj1OdeDGJVzAIFcZB53JpwOScWeAMCjiull4mivPLttpZJsTBGYbgkOYwzR/Vx3EXEl5DNqo4B0toRnCsBRkGnkeQn4ogQID3UGwFoL+Sgqmn/nDeDZ64i330C89RT5+hPgyWPE4yXGbyTWrlRjbOjkN5+0VQZFUQmNNApktwxvWsgDqIIkpo9NY63hcvx0JBo4ZXzII8oGjzwdRqeRekT+Q8kkCf4NDbKsiST405nwuQ1sf5pbC3FG3Tzp9HBIH3YXa5Zd6zqKo+it5z/289ugNPHasaIxGSUDUuxMO9iSCcpF0EiM9KQo4iIyRsHlcPZIQuZWIi6DRN1tRU3ssQSQI/o6gUx8Qsipo57w86LvVsaKdJ7VzTqsS+h4A5gxxk3xICYMMJeIieT1C42yapFAe80sp/lXV0xzKxy87hsp6s2K9cqUUkpD41tyHlrGOQfiCGlFx02Vp4wGmWzgFuGW9IVxzHiOkwRJhaiiwksgsernuwvy8qgd1421Fy4vH5Df/yHyd97H/s0f4Prv/03s334f+b0f4frb7yM/eFH1NOtSdT2PLsgLj8hN2w+EQJIZBGVvAl7m0To55DD6Omw7fqBcj4j+yNhSLmK4f8p0DePLYbER/mnCRq99Z+szRh8rqiCbaL65nh/QrhGwt4x2bGlt0QFrE0CyMvROqNU8G9v+KHfGpZbMtepoahNFGCH6qCAe0D0F3X/Et75m+oXNXYARFAc2BZvWKXtbSimC6kHI5eEIKCYJfxeBXnvevXBIBUgZ59hCDxNCkU9o0mSygPdgPv9Pgm8R0abBsfltSpLGvYo4KLCM3OCMiPgfAoIpdYx4eUgJ0zkBOwESiqDQoCL7a1cRt7GPt19DfPYt5DtvAm89RrzxGvLJI++h7z2fsVnQseV1cuOEiiW7XxuchgxFfbCSUTGHQhGcKxbuJrIyC8K/StuoslWMkxzQqQvtJCEt2LONFdOpUzJhEB3AIYnWGCZ7ltYgk2rTyskKdPODpIimVYNXO3LSGcpARK9xOsJHyxP7Uw1HME+SnWELjXlFZaFm9QwhkGeIG9C4jOLTChGh9PstIJbR0suSuTjmHHooG3BKHra44AjNaUcEtGZOg9YTAo1liTwjfaLX0hwV4ZN/oM2IjhhFVsixphIaoiTTVk8bqGgaJ/VTdonZAspgyw4bJfA3hmgXwxBGD4eHNIV3PgwnWIJK2aJqNN2OXVlhFFOE23LnVDWlmQ7rLdLRWdAThXMrgHVBPLpD3F1q+W8BawfixQvgBz8CfvN7uP/rv437f+9v4vrXfxv7d36E/cOPkfdZzz9+gnzUu0RyOCIzWwTqd+m/UtUSRWarcvzezVAHhs2SQ3sc86tXB0KMVsQ75uHW0V6xYonX1B9hFoyJ5LMufGqeM5hVkSU1V84d+KIdIo2wZUQfpGs5KBy9i8lb3UsvFbgxQ6527YyYPt/+ujLoMTujAHNtpwnD6FwDp8ENKJJXDQHKw6WBFBtisIMK1grE3cBJxmhnGIuFNqLXweJoyHLGXQUz8nYKjcpfQjPT2FPEgOuw6lKboYxo4Vn2Cuc4wKwChWLZqDajlD3qcefq5ZArsB/uy3g/uiDefAp85g3Ee28h3n0DeOsp8rXHlZrbV+D6ULUJmaV05A/T8lI8GxwcDkfxueW85rdi0DKb6gN0BvoGdhvtdRTCSDACNszkh8bHcXDINCh0MoSoAnn7yS56m4ZQnreUBb0uzxSdPhYvacAODkaIj4GRLRhALMcNkPOlrmGH71bpXzVW7VT01rzaQWDDoIN8et6U01nkSUNL6rBP1VXMFFN6jpRX86F5Lwzg5SOp70AjmU33NcYVMYrs0I4KLOyQu2NAGHBCXZ0Ol0bYcwpSNyhLxKFQPxGh++u9VGiZjjGehC9YkYpkgXo0/lzTaWplBekMHqxsXvX05mUvXBqh+Mt5Csq3Fm/4uGgQmh+FzPPKzlDldZ8O10H2EvScx9uKXAHqU2Qqh1W4FFUo++iCuLtDXGor4Xpxxf7hB3jx67+F/Gu/gYd/99dx/SvfxfV3PkS+eECuC+Lp4yoivtTYsD2+AyOyUaYJ78Br8Ko1gMLi7YQk7cy0DlsgLxEysofjDEguzszPkBHVe/WnmWP8cJtyGFIYw6U/nVr7KXYL4Tad6Us1f25htd4SFYAbeVJmu6kmOtZbPD484ttfy9wN+MgeBAa4NzEjwDTvrNCcwkjtCfgu+vNQG0c2JMSsrCbw1UEnS5MQ4jRhnVK2AaMDkh1BRKdx6o6C7GIjOIswiErmkWNMp9bEIWY5v5BjrvAJWK0xZ1QWbuBgGjG4Myd9PGOsQLz5GHj3DazPPQPeewf59lPkk0v13NuFKCwS1LDHWfxyP6rshjM4IbKmeAaUsle7Y63bVtZ87/ZOA9pCtijQHAHlJ27APgcfoc+tMFYqgWII0et3VvB2/cbCyDrAfxLmvVN1tj9SyJ7nAlSl7uwVuV9bt4TNmmV9wJqAovky4E9QovyoTRyGxAbZvEFA67vllxsmlNXgoOZ4B6DMLFc944yE155TjfE/btVCVO1NGZ2Azig4dguMuS7LkQ0uabpPmQC8/Bcx/NeQrFt5h8GwNR14wOJHGtgUAhUA0jiQ8onAhXWZgyOUNdqO0rW6ubLpAE2h+d6BzMRRK4mMEpdAOb/UVIxvlFVdnDTwko4w36PBnHTiFPN4n/ync2oBolMgx+dGRxKVHcNawN0FeHSH/eQOcRfYDxv40SfYv/ab2H/1N3H9y7+J66/+DeRvvY/98T1weYR4+hj56FJ6e30Y+pAabzNMSwPT4FEPIGO85ksOPpveQdknT+1lWm/JCzlfbKdwcyU6zT4cDJm+beZn68eQ1dxdg8QsxXD+HD8zUuf87OTmmC+BXTixbWtIo4XsHToEEkooxP+Y/Me3vk4aNJBCSiI14MS6Y0bp2j5nMRkGsBkCJpl4jKWLsm6LFwz2vd6CUobKLPS6U/eIoczRrXsNkUe+LllaretPYjYDS0iaUDxAhwbqQHg7IUUKzircZhC8BxYn7GAhCjh3Ag9X7Icr4vFCPHsd6/PPEF/+LPDum8jXKp2f1117mXsPMKPmkMdo8DSf56a48EDChp2CxZFq5wUClYbt8TJD0mBkXSWaJWSBVJ9np0DKly0LFMywkyIHoOmYrfwxn8eM/DEMSvXFy2QkG+rTCoZWFK6t6frh8gwbA13ghYMmkOGVI5goh1MiMuQqZjYLHpPmRGVbkjNFMN3H4mcBVe87s6EBtPGd2RC2CdCQ27gI4gRyhf/heZG+baEiYpwWWnNi2pFgmXCRo+ptAkrLEtAWC045Cjmg9YLl0nQ09NuI6d3Vz5LX0XUHGoezCdpZxP4o42E+cczWnZA4SG67vToOOvvI7ZBRsnxiBAPsMcQ/FzFSSqdO0Fj4vWNXlP5pJyEAdOFrDPqNWVqGR/AQHIPsYjt1q94LsO6HDGvdVlu7L63Z2HFB3tXuonj8CJGBy0fPgb/xN/Hi3/pruP9zfwXXX/1N7O9/hNy9E+nxY8QFhXEDBohJtiy2L5T9aVDnjg+l7gEVixO7Ld8Dn7o9Oo27i6nrYJ2BOXw7PR6fNgpnQeHaKlmD4aRYgPXImYHn/G4kX46FPwBvG43+/Xyhv4gOrMdYsjEv4tvfSKcX0l/CSqniO6ZHRPgo758TGleJIncfZMJJ2IMik1X0PmZexqLqAgwTPdkmohWTBrknu+xJhYA6jEhgqn8IUvTY6JEhtSNPwGIdHQc55VBKpstCoAPkAKKRFbgm4uGKXAvxmdewvvwu1lfeAT7zBrJPbdsPD9pyc6yFT+eKB7vQcwyDRDlQNapy2pYP4YjwlixqHL1lAJvghAC9WVk4kS4lngJqAisVSwfJ2ODOJRkpRAyBBHygy6EwRfgkk8K0MA/DQNyvOuJnl6YVuRY0AATF4OwTGb3chJBRvUGp4gsXSALimQ0NI5lxDK88Bs971gJ4yQ1ApKrrE/ABUZp/Fw2uQW8V/hmoJ+JEg+QBsOIbWzHPVxNsnq62lSVK84YKgiGbAdU0BGUPOHYSTSOjdwTMxIfBczrslS6SU6Pxy0JBeqd5aZij+LBpPrMuNBaSQPpdg5Z0IDNStIwxhnmiJPM4OnTM3NDOSS6xhOSD9MQcSb1DWWOb0ZkAZQ9sFIXj4zOZlwjMZQ4y+BVMHsaT9Byo2hhXD/OAGyCARxfgSZ8fsh+A7/4Q+1f+f7j/M38V9//fX8PDr7+PvN/A08e1XLDCwQ5wBGigwc2BvU0rZznMP6aTI24cTfEbcMDa3wSNuvFCsitMaTsU0RdFUV6JD6sdUtoFY4J0jw4Mh4O2W1m0lHNCOaDsZwrDWgSkv/zBONDPh3+2EgNlY7/z9Xq2T8GKJorAmgZwniccMWvNfNoY3LlS7XQCchj0oopmf/o6zfuMEdG10Q0TfhKW35NRQ7VqNFmgWEfRWuhlIkVkU6fS6a7OngUfZQDXYTycZhqTWKHn4762+MSz1xA/9hmsL38O+Nwbldq/XpHXB51AV4ffeBYWIFdzkh4FpBsDRZwOVmX+4ee2/FuKfDSmHQZG8chR005+xZn1mObFILbOLAq4E6HBsV/SLe9siwoNKu1Y8hmIrKUjMoUiHwF6aQYxyy1PuJo3D0ouMRybwA0tGJ0GakubDVlFw1yCSa3jH+n/vHFE2kgZmOhg9J82bBmALqvShHgJEx2uGGBk2holGrDlaMltg5wOWG4OPV9xcxMj1KZ0lxmjKMCmAZcxDvltLbPMLkBAh5A5A4sCO8Fbn4+TMQN2rG4zCDZLPfcYv49ntYZK/CAOhAMIgCBc766LK8RTejccFbVnmbKx5OeBecLjsVwoNg9jNISeM9fvM0OJSV8nfU2Lpjn7lAGk0xkaGzKBtToIyCH3U8cwDFbLCozXRYzG10wgd2U+n9whnz4BLhfkBx/i4S//Bh7+jV/B9f/xV/DwN76PfADitafAk8fV3/WKeRIr4T0z7WBRZqfXonMehhMOSPenAW1DZfyrDhoSaLsaV2hx0/m+WYTnKDyUSeI76iqM6eD3WIj0cdHEPsknT73MwUPkcKSpUwMkNb3QeJHn/CK+9bU8B8S4iHOh4RtpMXndTkE3lhRxea56jrQqrdYBRG6/pexoS+NC+SqhNprwRSMoNcttGaOicgvgu33Nc6bC8hiTlfOgJWjiIJMHv0cHZYBO7I18uCIeX4AvvIP4xntYX3gb+fRRFe89PMzJdns0bh615JweKRU+Gf31mOQktTBQaYeD0qtEA0ic0ltYOg40M3Fh5DmEGt0XDcmK0GmCZIxSvFkGVMYIVEpUP+G2EoxCxlhzpLxJW4mA30cMb5rGsh2A3NMpCck206XT+ezR6FmCxVyGkFCEZWyQEkyrc6lG5kqgDtNvtivwjC6k7PfJ9+FIAA06yjhV/zqga4Vk3DODT4G0svaUeicO+TeioolRpFscjAg5P/UunSV+B41Dxurw3nA8r+c4Vr4/lqJu+SWj5JHpBEn5uTHkjIe9wHrFbY1arhqd8AwEDQfT+TA2Gls4iOj3YRqhf+a4ujYpkD5Yi0XOw0GwERsZFnI2eJZKapvuhC4vcdC5jfEb+Q+9lUOGiqzdb7g/Ob7DBghXwUi3aQsf7JaxwR0kcdfOwOPHuHzwCfArfx0v/81fwfP/17+Lh1//AbAeAa8/qSlfr6pqLwUYwDxIXmNsHaR63tgSyqCXxcirJDEd8GGB19fP2/jmJUvHTqA5LNbXGIgkO6K39JA203MoZw44HK/Ezfk3hCQKFIaDUG+uiFpK5sAElkDtApAgyJ0AC6/oMWdmb+tJpfSsEPyBwDA+G/btMMaaKz2X3iLGiutA97XgFBsTLQ0ye4Qm3T9xY7NgETjWgOTZKCTLQUh6VVOiTA/aP9JlwEE1u3q7z/21GP7sCeJr72J99T3st1+r7roSFmQom+k1dN5dYBGhUu1ej6/1Je+ArO+QUBW6AVXxk+QDCGdBaGybB2steH/3BIbqs9J8Y1lgjNK+h5HTWZGQwnFGe2ZNgt9lH/zjaNIU7oKxeV7BACx0RTpabsSjLNoalGJE4/TQWWzqTAl1szIoqXP9lb6Tpuaccp0Q2dGE/NCeYwydEvdGvYUi4AUfbNLv6iIVaEo4PHuqgZkn0CiQGuDJufdnPG1sdfEdTzs8HADQmBr8TCctMBnUVFzH7shJHxSTHSHaqdLgoH3ldMBi9E8gBDGrkUQ7bQAarAM8J926j9ATzcLoKmTwMKfhDUQbhH5eGUeN51UHgI7qkZkgUCtia/qCOzYwnnXAIgNMetKQHM5ojKUHjyVbBnhkMgMqIaocKM9JtFqnkac8HXSlLB0nTVof7YBRr5ry16b33R3WG09w9+QJ8MMP8PBnfgUf/wv/bzz/c7+G/OgBeOMp9uO7qp3qi7HG7HAshUYIr2lgCbEhPaRhxjgKuO4LES8HX/iz5zpsbnZavk+1DMkmWj9rrl6W9fzFHEBzyP0AXBoX5LT0bBW09vvTU2WbtGXS5f6Y+sMx5EbEt78xpL+JxrQOJy3jMkA2B9HlUUyAsaASYHJvV6Tz9LvxqNJ7XTCXdDc5Kf7aipW7r0iV4WwhRFdCyuintxMKkUkRmL3HYFpAyWxgEH2MIUbF+P0uAr/3FuInPg98+TPIp4+Ah3tdtFJ2JrSehHDE5PQgb80bDg/p0meI8yhQXZ880oEzZV4qx3MAuJWtoXmecXBZogsV1EsnpiPAOklHqXQ0KPSrtY2/12tjOaXBJ5GqDNG7CBfnAYciS2UYmXQqmVmRuc5GNs0UqkTzqLTq/ylCSCkeFuR0OeU+aMylAHYhY78EMAFI8QGDBzMjEeKG+Gc5ZLqSeuVx1q+lV7cgzDG5Gpnt0iibQIxu94hm2dZSKh6eHAGO9Eb4rBqM+TTjaayncingmQYFXVDXW0lrDM0b3QfR+iXGhQBNeDQwaFbrR1yEU9McF8nbKWUmaTgkMcceHpec94EHFgAbdtazHFd2HwYK4pnX7OPgpeKySfMYJPCgTt4NseRknMyjA2D5r0fYdvNFzktjMukV0y+iM8c1jLG8MBwVp7WXnQCnM7uqPRGPH+HyxmvYV+DhV38Nz//kn8XzX/638fA3f4R4+hrwxhPE9apTCIXizNAPZ5dbVUmbmpqjZxVQTt1Bo1kHI3NpWPwN+OIiOjMg2JFhcBHiGnkZ4n0zVZk/YhltV6ZPzpyihdThPi3ekiv+OeyW4c9ynF10Gd/+up9kim0MUMoyUbV/1jnFNIi8sMEmVQZAICLgtt+wFXGwb0Oi93b2GM8qhjJsTaQjykmaJBNtSH/9zmsUp0LOd1kn8IpyNw2YZrp/KOP1hc8A3/oxxJeeYd8FcP9QJ+7xKM4hGBzFBHVtV2zhEoOl5Rwgd+UDLMgjIkgGWrfKoPKjCeY9nwFuK1LOiZSExpDA1HRUZB8GjPpht4mp4jnTNCSoNOIHG29T4t3cLJKjUxhUJjlOZrPGzWNE51kerSzTAZlRten9quNB2u4QFXBEvuwjPC7SvKY/Y8DU0lirA1QDQGBnhCz56M9nGnI6PIOYx+FDskUE4pkROKNNgnUenwE81pU8V93JCgBLtToB35BInTvuIojO5MTyaJf7jFf4T8PDaZR80VBN4J7vywFeY3lKNIaFkLSOm+xMWGYYTbt/y43ldYxuYhBgBwBk9EC3ie10CFH0HuLYw6TMdmS+Zt/1/8WpyYnpiFLGjW/Uz7yDo9RkDWNpefUpkADrcbqGeGA4ZRzDoTPsypmAQhlUceugU49l9Wd7X+uiqddfQzy9Q/7m93D/L/15PP+//Gm8+Eu/hXj0FPHW0z5JdQsHnLoPjXFCd7QOnfVjzuLJ4e4gqx9wkSFlLxm+TL6hsdFOk+0H1G4ti2AscZJ4sC0auEf74Iy3sXRYaGDIcA69QEscxyiHKROxvvONXsKuj1V416los7cj01au3d6PjW8X/7DIq9dRlG4mFzgCKjgNGAkAKq2NjpUy2ruFJgyEBXdAl0ALKWJIyadHNOw5CaeP0+kSQNhLygMvr0BsrC+/i8s3v4R871lFEdf7ygysgI65bFfMRrGp2sZ0ZjAkUT2Qw5QMga406Z7TQApIBtjDgCaR0c8U4qIPQYYZApk7ClN7uJug1udCaFArEZ2uF+3oJKTnXa10f2xjOGjc/sWloHpvqX9teyPNhKg4aSKF3qKlbhMbRvlQPsop6bfq/ZrnUPhB92puCTzRslc1EsPYSrFRh6sQFsN0ZsgXLCIdMmh6l35V1BwyZHNAM7OS8oSy/daOADO8lS0J/M5eqFh2Dbp136RtDN1lZGWqQPUlQpluRMMlWTUv/ywrGUxDJ3HvMIIrLpQoOKPH3+1YRdhhkWRpvZjyODJyMu5jjnvL2FFGkOS4VbfAm8Wd88hjU4dLYHqeIhJLFj163jz4vApDg9bXpoYqCDpNxsQjs8FDvtA0HA5ZZi9DhLGWbUUAcZky1kix++c+Qnw6v+b3kPuI00kK03bKBJd5cyfy6VOsN1/H5aOP8PJf/f/goz/xr+PFv/XryMdPEW+9BuTuQ5Ba9ySe1Gnq8wz4RgDR/8uOuhXISq6mU50ywFzKrD6J2zYq0WOpnyuzuyfzTQbIQ0n0SaTOqCBDl+0dtRAcJ+hYDt1KS6O4MhzaCta+/fVkKpVN6WIGClHop2ZUGZ5qa9mIDPTJ1WmodLtOpRjgijfe9gFGy5l2IrC6GrlTPgQBFmM3MS147IJZjO5vAgxypHUHZiUzG2kjhGo/VhRT7h+QubHeeweX73wF+OIzXHGt+7ypYCIWAbFTPJK2HlNrsBwDOh3y4NrRilBksBDYnXKrefhwHJq+WsvqfuTxAgThaGNdtGjDNbziaeBoQGRjyNMG1Apem/r9Myvg3RsN3ZSJqQM2YiJZr6cz0UcQc+RrxRt4IiXmz/VvtIhOk+20JZ0Jwim348RwcGbWQ0sna0Gn4fX4te0G4yyABjjIGxsGjODD5lnBzPaIZovrgrIZzs5o/GpQEYDlh5kHg/MZJUB8IT/oDNJRk1mR890ZozWANW9bG8zpEwXVkqwlgWlkHJvf5MMhowTesAGZa8+JVIEdeaeUOgOPIessjuV4SBvJmmgI6ZKyUFPNm3FnWtZylBYNifzhTCHlEKuoUzrTHTV9zqWKcN+oIGoqxXErXfOSGQPTRGQ/BGKm/Yu8PnSMuBSR0BXg/a6DWwdSsbq/IWN2pIzF10xc5hyxsfOKfHSHy7PXsZ5f8fJf/rP4+H/5b+KTv/DXgSdPgTdfq8LrK2usbPin0hx1GuTacEqoE9MRTTSuEQOUtSZ9R8Aio0H2D/kkok/5aVvkcOTm95ZXzUEyOHXOR72Tdc6GSGt7rEWbamMUAdJAD1eAwwGwqsC6PRAPAL3GAdRWhuzzd8w8YYKUdxBf/O3TpfJUPp2X38qhJEh6ZI48Uj+fqZQY3dHopeRCBNaPA7wEolHXfGYivvAM8e0vY33xM0hckS/uBWDVVSp9lF24ZsNpwMYeke5wEkz3YaSYKYnbk+mKKqy+1hLJEdFZsY0/w4o0bblmR17JeSDNxzqWwK5rEaCDjihyxr8akbcjNuuIDtAZwwQzgiqNFhILq5yehHspy1OvUe626aSlkkgV0ZWYdGaLfJhnDFCCkoDX1682HbXX+EjZQTLHLV7k3IjdpVG6dZLkV8U7K63bYFCOyEfhWANKj3YoFA7Co9sEVLinM+5XZyZGntRyR5mgU5Jq13MYjoICiFBGop8aGkqZq5ePtHQb4+J7X7U8IisERsapxyYdNpjb4QnJEFq0KLHa2QLSaIxU4yC/eHgQDNj+RZRXZDjXvqeec/ZyOIgTp9MiCxzW3xi85GFXHDqdr2qbzqYoIHyT3ZCqncGaDW87ewjpKgDtDIqWS0tbyw3HTPrLs4C9gKaojNRw6kBHIgamjTR6BN8tWbzuK3C5Q7z1FPHyAff/938bH/8v/m948e/8DcTT1xFP7uqANWKCsN3zno4dIlS8OE8JlcM+7ADnwBouBrGb2ZK2J+Wo+1bcUNHLwqkTbXMTOsKcY9I6PwrXfeeP8Yc01jsDt4UMsntC7cHPb399IpTaPdcIedpRyEAfaQiF4stMJt8pFKKlfRESSTeX9J7jkCDwkKFOowmHmnTc9ofQ4RM04Ewvo5cNgv0On2P0YPDoL5huBIoR8fIB+MxriJ/+CuLrnytBuV7VYKhxAjaVpQk6xi8YDQNFFZRYgUEdSprVcZAMmRVjzVVfHb/Irq6uUO1f4K2A6ghMHno1xcaBCh5IHwWqU7CcjvcoYtBgRGZhmKEwed5CvKIR1wMHzs8UM4uJBiaLxDNK20G5sxIzexUDmBGjxlv8H8V6AQALm0thAtnU9kMCM/kmh1Nbz+blQQY+SAbtwFqOwgp9RDI9/5YtOw6Q3JWO0WEkTxkd04SfhyzNtfjDmQ6M80Bi0Jw4YWDT+2rTbpEdODs1NLwzOnPlOaSTwTqJQf/RHaIveOJUaey5nMJBC39iSKMicQz+WMfsDKQVi2ZK+mbeL8nVcCYoJJTb7gPMoMkwhmX4KN61zE16OUXNYdGBczq8xJTHVk35tvxzUGumn4P6YJwUt+m4AeNf6B0av1d0fNnBNP7OPuyQrssM/eBlk4cHXNfC3dvv4O7lxvNf+lP44H/6y7j/q7+DePYm8u5SxYJTVjugUJZNd8FY9mdYCXh+jJyF8XLe8pBVQrJ3op3ISFohoBscj0yc2ECsa7lP30AoRo9MmKSAsiT8yVGDRHvTtVrxna+nDIlsSRMjzWT/Gatj/Fj3NveBNKrObrCRG9QTS3ur5UxUu1qGkGcLuFo6kTqTsvtUmmsCUgl1Cf7WWJCB0J7wfo6p2waAudVKEfyLK+LRBfjWe8A3v1AH9zxcW1guotVqoVQ6vhm3o5ZCqt8UT7VumwMJtIwypKgj0d00rLHl0IS2LoMzAfSe4pEZ0X78jj57SyeNV1DC4ZSmUJRK2RE4+CgPjmqpNcRTwBtg5lhaMNlIPTt2GkjpaMzdB7MWEUOREVaIcDoNEVj0eINZH4On6lW6/+lglLyG+pN+kVX2BjSdIqmLpYB2gkeUIFhL8pCOQ9w2BwTVypGvuBs1zhWn4VUElWdDBrA0gLFPW1c7Lc1XHzN9blt1FiIsCzH5BEWm06FokSlty0nGaUDy1fk2TbOB0CZbQ+j5HBrQfXfEH9yPP8E8JJvAyBK1vMzdG3Rg6FQSx5wxMLxnLKXkVRiH0h86ADmope9Z0NwWIAYNnFEdhufG4Miw6U876UPfTTPK9dK1aZz7PNUSY34JZ2puZUxO8AKYKZieOTM6lbBztowO6sSZuVyFfgfDiGqJrfEidgJ3C5d33gS+/wE++uf/ZXz8J/4Urh9dEW+/3jTbY/Wk6RiJ0/CadsKaHNMQxkti4Zz5oPuIMkkqLUvm5M8IlsXIosPeG7pPgmNBoM4kMP5EGxTJIY0/A54O+qbTQYenaP0z38jOkUFbijjhsXZRP+w2LlIxT12RSdjAyaulrBgIyjNxykMRRsyWZ8FVT1jeDfpmKR9CAjox8uImQ3p5Im2EJcA5ngOQl4X10Nfpfu1d4Kd/DHj2tA71yQ1cFqpIZwhwA6LGqogz1a5uTIvRtZhvmg4ErezIDb0ZJcy1R0W3YUCb82PhkyI6KfH02gM4BMySf4Cz+DXAVoaMHgIRt2g/wp0xz1TEJOVj6hsYaUhHoDXWU+GUPtSsY/BYn2hYx7sCnuINo2IMetaw+oeh1AZ1Gol2TjjHdEsHyJG/outGygnpiTDKAJ3pHoqWybhnXAIwBmYQrc+X5mKXgQbNOumioWnU0uQKQDt/Wt5dRxOGAD47M3GIdoT6eFacfxjVRctIU03bQvX5PHRFTohzO5CcDrklbSgr7RCT9mbyCc7zMB4LEDFqRovGtoMPHgkiWPzVmCrdjREMtIPGXHJ/DzqkjY/C5eaNdV+S6DE5FSv55Lj0rgCgp8DlXGQJzDBS0leccg9+1+0rkAJhxo6s3sEw5qD+tIMGBlUudE3YaKuhLD1Yq45Qvz56jPX2G8Bf+nV8/M/9SXz8f/0LQDwC3nwN+fCgepWUzgfmwGSbMMaZwyEIO2A5AWLIlj8gFlLb5tLW7NpzmZdgMXtj59yyN6gvWZM8DgxTtkpYENo5UfP5aToADbDN3FHyPjIBHiQB0OBEQZU/CRbVyPAPoOcYuZcyAKdqI3yMIqNX2Ogwsq+ari57i8mK4VBQCcgsOhyA2LzaK0s6yS9fIt5+A/G7v4b88tvldb18kAAUkhJ81gnYw0CI/vK2WryoDEP+MvnSiUMUssNxpBWSvjmygITEEsb10oxJQ3jfkEDIcOiClwVEn/klLDlBFMmLmLwExIlIaUfps9dqW4wpX9rex7Rl9KUajIx6cCM9XzfCdXHczf0ItBcExmwazO1qxy2KozoaMinpPbwRhwNK45IEqNVlmWJlM3gPwWhg25PZYYDrQY2luKF3/Xxdu3wKvX0A38S5OrrdE3kZ8U45kMMgUwtFJBhHcgd902pcux2GcMboi3oWdOSm43kA2oiOOPfGlJKd7J0YdiYkW5nwPQjQriNhLJ0kVXZ7vi5g7rlqRxM4AImcDFgTOsFEnB1oFXpGILMjVwYda0T9EdABQ40ppBGB3WTyO1YgUbsdweFs9ovHhThyBjkm4i35ZN1kX0uySX1tDCJ+NsHpFMgJQNHOh+vUKEv0T3zwmOygEtp8tshcvqKQ+xaHBHDRUli1mRtYbzxBPH6M+z/1q/jgf/i/x/2f/3XEW28Cjy9dYc/gTWrZtg2jo9R4aO9GyQw5ZVxPv1kvDgN+2D3z3JmBbpM0IJNoz1s/OTzbY0q+ZZPZJH60wtiox+SUfOfHU54nlT6ZbuuomUJL2qinYVjZMcGUbXGSoNBT8GkYafxSkMvTmHAQqPrcpMimAcq6y4eRWPICl5HNAC1BUko8JxL7UtX92In1zc8Dv+vLyKd3yPsHe4G5vXbayuGDjWJSxto0rfnttwvjJB/T0RYxoCr4ATyBEHlrEASpBB0oyt0KRqNtkppPBQDQZ0u0Hhe7gKg2shnUlsm7oJIEEdiHMwlY0TJFAU3ZL0ZYm6APOkx1AmGMVN2M7g5tkOGCjIz8BKQcVboCJY+MgFO0mvxKsiIAHX+t+TKK0ohfcXz4TLDGZQCH7jLnNOKUK9HTktT8j/EdU8E9tkkQfs4G5BQNkJ59AvoePXZk+OJjtjFkc16+ojGSxpn6bjWdXW/DQrxPCTZu5KTkM+000FkZhmTqGilW9VbtsPXPjS6DxSOTAKucnzNOLL3hrMesjrdxZ0P+mYajaJNIHmzUhnHx9Es5eUyhwztXhrPAvpMziNnp/H/LRYx3p1OgMRWOMhtWRoPCSVoT55yNcTaNMhvQNsAAwns9RJupb4z4z8JZ0ouz43hLWlbECFyUx7Luss3cuO5Evv068PIFXvyJX8bH/9y/gv3hFfHZZ8B1G3YtuPUTbY7Em3oA6EjqBmDqvUwhHT7yt4dqPyDOfsPZK+sNRhv6ptv324Eukpfc06GFnAsWEkovMsHBFv1/+seTRrvSD1tfUpSMLWkPZYCFDr+IMYH5c9M3ukqbIKforMPRMhaz2EZmp6KsJoDTvU2YTa+UkenoNv1DAK4DIJGoFC/vgWevYf3ubwBffht5/7KMx2XZENC4SuaZ1jRoAVm1Cux8lRN1rFPL4cK40zmFPlaSZUOXOYTIBWHRe9RzWdkj+mS37Cgw+tyGaNOflZnZGAaFGN/pPxWOteBQi22UCCiAtmmhCczogyBGsCI/ibLC7Sk7BncpVEAercHG65RyCGjU6ewg0MUNTa+Y3UhmMN6hoQS/Qys0I9BWeK9DAoclp4Lrq3pvqT0Cx5bjU7TpQtcGVBqjmf7mv4BBhHTN3KPozAqgbMsQSYK30omZLhLtwTs9yr5o0Pu4aHRUjpH1yLzhay8LtRNh4+oUNNP8BicPVrcNUmPVdvF5Xu9LuVnSM8uQtvlTcilbILl1wfl4DmpPqfOITp8Ome3sluIKEToqLd2FYBz+YShbRhTB9yRXZ9Y2HR7KIOuhGqvrfY87Bp0i5tLCcE5BmOHq9ZCrbD1u+vAQOju9Nu5A7yJZa8hY49ukduAIEtByQPGS/jWektvMoLiqnfOCD1eyOonGriEAEIlrviwCv/sW8i//Fp7/d/8P+ORf+4vAs7cQj++Aa1/Aw4iZDtLy1KcCBb2ykXVpNBRezYD3RlMbL6u9o1yDuJeDfrmNm3mTLZWTmMazHqMyKz0WygPVR/VTAdQSACpFoH33uynQCh9IN9oMcmsQ9gEjYsBgDooZPlGxFS6yHIJMYPnABQPQMFDtWfF4UiQJVMLiQ5tS66TD+ptwIxWCWHXJxP0V66feQ/zsN4BHF+T9i5rTOBDDEog5YQ8lLcBMO9aNyGao7pbPUkAC9rxH+jC7UdBZwMFU5ZCa6XgFlaahICl8XSdxkwpn5bdSeMv080EYFl+m97nAc9Rs9JC5jUWAREAgsJB0bbDs3JgfEtNwcmTS3YLLd2g8RsTWkasqfJGOhDDf449UXs/HhsN8Zx6ESixHDYQAR4XZfTDNHMxMiVzFm6LD0lgJoMe6M2WOKJpTDoeBT1K++54GLcxNrbfHcF4pb+Wle04iUwJ9ip/AufukoxVpJ4bRJMdRsrXlPBnowvPuAKBHc6NqI2IdRhCH47sU8XNpyPKWnrN43uPmIUWTtgkZN3M+sUZxKA2iDZBlwf3RkNC4kc52iNakEw0QHE2TNzIeEmUHI9MIsADRKjJ2I82g4WYJoniEY9xT2bR11KM6gyHqu+HfhdXzc46f4kzdIV3bjrAN6jwzZyFsnuMlZva4gMbM0v/rvmK/8RYeP3kND//bX8b7//1/AfvDK9azN5AP9z2uzhIGd0hNvCHOeCxFk4uMMO2UUcGaUzJAzlI1HLELM5sJ07xOmdSvAcmKBIm8GmPQsnsH2SVEdAACdRAQmdc9+HzxZSY0QlrBqNh2DPy+gb2EPd3WOAxIkSm40fDmzOX2YrYpUR93wdzONo8RuhwqCNlyXAZThu1HAHh5RTxeiP/AjwNf+yzy4UERuUBf3uR4l0QHU5g0IEMJ6HlxXXHPU7VwXOazFb0NUFSH5YRV8/0dzyuhILZhJw1uPcuiAx2pLUAChZDRUgzwggGKVcHa/iZAVetjPEDgAjDFTe8fBD2P13Qd0qOGZlZpV31G80LCP5T+UBgwqo2Wqn0UTnETBTRn15hUl6suP0KvzZMPw1jZkGGsL4eXHeSYUSFNU555j9wl8UFwrTFyeX8CJHU0d8r5CHAdN4aDU30VTQrk11rnPMkPGv8p2zHTiiOqHmqpkoZ16n+ms4FrET+G40UnzZ1jy2GwI+JiN/J2RN3EFJA+NN5eF9ZBNWE95RjOZZ42ynICAplX8DCyoQAaB2XHhuY2UzZivkw5+eTnrvU2GQuQVg3mrAVhVstXgJMODdykAfvFlIueKyw7xNui0Ej39+BrKTOOMctR4bOyEeFAgQhBDIyQcxPgJVaURzuU1JHg7WrB8Yy+sx7UVk0Zei+f6UIf0pGehZ5qm9TB5kbg7rNvIf7938ZH/+3/DT76V38F8e471RYPECKKqA5tI9ZFZ4w4I9SXTynjSPgaAVhncWbWmQ4FD7azge7nZNhJq5A8WXSjL5WjMlsm0XJSP/OAIBzZADoCgW99LVdcBI72GNhRbyXpEZE4ZDb6N4l9Wmg0GT82UlrEdnsxSr9IzgbhyFQRQT3c7KGn8mgC7Wj4zgJkIl7cI957C+v3/ATy7afIly9NwGaSdp5GM4FVti2zvNZRWwCpbBTcZu7KjrRaKUAvUrae8FedbQA2aqk95jn+x4yD3WkadwuEeUbDU3s/V1wEXJwrSTP3mwt0uYZPvmpvTLdP49PAzqwCZHRbSbTFybLjQ3GW3uefsq30kjuL0Ot/5TQNuqBA3KIbsBPiyEx9CCgFh6Q2GMnLsTl6gdOetwqZ0HWsGJ/PY6rpvDgFLng2aZYBtsB2HAuqERaNeRSptqnpTA5oDAJx/tV6742zR7nsMTNiW6xlYHtDwLLrcBKhs8plHAmUxZnSQ2xwJ3p2pkF5HxlGg5QyBS1PgfRSCotFh37Q8HD1QadELmaUWEBJy+7+cvzsq5NJyBlJMbtkcVYbnL8cB3AgygLQqJFWbDcGjS0sjkI5yRwGlWPozUKSt+jfWX7CaUzdsPFIZTshWuicUUt+2wlfKsVK8mX5Cjs7lKGaow095UeOBcbSjQ796L65W8bkkNNXzM7GCQYd1AlyLZv8afm6bqzXn+LR48d48T/5l/D9/9G/iH15hHj9qc52IQbQeVftCe1ZODiWnaKe0dB2/7OwkOGSPzqdBQR6j76xCbfvM5qn48hzWSQgJFY6U6bdXTWnktdExLe+nmAVJRLYV2jbUHc5JBIBX+tLD7DoNCPBjtT4O6vrD2Weg019N5yTFq4Wv2Sa3GZ+OibVVB6EHeFikybqOt7rFXff+hLwM1+q1q5X4ML3uG45axtw/DmMN6cxgD9iHScYkuh8UeZoeKsSaBp39qv+B2API2m5GeNsA1Oko/IEEtdDmABGwJQZHl6S2MwYNJ/ZTrOR1Cx69SFMbFxLC91HtWNeqv/u2ytDRFPO+5QLtqO0bQy6NthDYMniyXOtM4ZjaNHx3KrGhEtKcgd0Wx5RiBG4PfvWATpkHnCDcspQVlbryHuYX0RujHZ6FBteTy55Nw3NxAYiTS8UufVKvAGRDh3lnDO6pS9lNUYWSMs9QPLnQVq+XzqwBPRskxlFNM1rzf4CHVDVcyhfM0UH0RrUs8aFcN9Kw1Ce6aCI7SGcAkb708rCkdqh38x8Dd2d0R2xKXquIfBrh+0Yp7NckX1uRRCw80zlkRaiQXTmSQgsrKEeH/WD6CzVstS2ZB/jxmjDumsaxfLtp2RGiIf1e0r8SZ/oua5XxnnoD8jYGotgoElN/k35UIDZ7yuMYtvMZlNfObam7927z3D9038ZP/in/wRe/tXfweXdt7GvdZ17qVNa6ML9s+icBbJ2apxN1BKvjDblrgbCq6ync00VAeDjnIeDmIFRNwZlt80H2EHsQ4PKCRzLGqrzS0R86xtJ6QoCQw4ve3Qg8AKASB1U4CNeU5ziWg0wiuh6Yov9NMjRpkXs4fF7e9bhGDRzyXufaBdgpAeRehrKqK18TxbWz/048JXPVOEfByT5p/NTafNSSDNFD84JHcrQc+orIMk4ew2nsyBvMIZzFTejD+A4Z7skTAJRwlZtcEkFtMkCB0iAOdbs1NZG1Bp1e/hF5NpqieXaBG6ZOwQ2EkheUxLDuFTfejZKCBEXyRnZQuAJOGKZAO1317G+SIXGoFVJYEelu7Yn8spmpsW9H3cYfyk2MJOnmg+gqA2AEhZEFO3/bXmRo4Ciz9xWpmJS8p20SjV30FOo2G2SFxVVQv3IUQKQI/3uiHymtrOpvSzgVbSieTPrBThFDIxjT+nQgNmx4vfc7luGbOz7jzH/HClM6gGGAWn6kj/kg65opkMdkGGqWXHnAZ1uqI+Ujptf1caU8+ZdRJ01UgQQnYYYWH/H/KRk+qdlJBJg9i1LQYt6XK6MuSFCTheEx+7DWVrTiwWHtbzIyseUbtEZZGTtZbHG3xWSSzq05WfYsNILSWEmuRZQ4WU3kDwmXHLourLu9aAea2TMl17rlFPhIPOs7yBNSJLWrXnkN86lBLJ0Xx+AZ29jffyAD/6ZP46P/k9/HvjsZ+rd5r3kueXs2ELc+sE0fWh+Yx5c55MjwC8C2rlF7MlxZgudG6xO9zctEd6tNVfNAdCppIorA7LThZdtcMu36AxAfTdv/xse10Amr6t0JzoFEMcAa8I+MpUVrcjdXlMrL5jOLuHifvgIXrbgSIvP0UDTa6Sh49gMciROAJ+8RHz2Taxf+AnsNx8DL+5LiNYY+0j7EaASAZ53LwdnzpFee0shMzHOYBzw4GK8iYjDI947vUeVOI2WqTAtGR2DAt0RWCLkYMm7JF0oNDT0TcfErKjuGdKjnIh3GGSDK9/zccOec67Bs6Ti0uMbt5CpqzCfg+/YEBVtvS498ikeY4QcSV5UNfu5Ycmn84HHeDYQJracCFNuGG/Iiy3gmw4fpkEc6UJiQAOzHW+CvzMG1r0yREyzYo5m6JwNBqN3GjCCfOsxgavHS4BboqXJoygaBBnOezhiZBMxXgAMGSLKC/fCO7V6/oz07oGGVsnmzPxMfqypz8So9PSpQxgAGfrSDhiFljt4RCN9IUUBo33MZULK4ZAt7rv3/R9eyquWi+fRmDNnZj4S4cQJ/czDqgLwKZEJxMBVXGy05hKdhkk96J9NmsakkaGh7lHvp0xQN6aztdZlGLWR8QXa2QzNqCLXllE6Jg0iuq2Qckh+itksyOwlCmEx7Vi/lyWneb0iny48ev01fPw//1fw/v/gl5DxCHh8V3ViaLyN5aw3nQyZGXKxeib9Nzaw6diRD3bK5MzDmRxkasxHxjy3aaism3WF9UhWwnay1axthWjJ8axsY763HgjaGUXCw2vL7BoETsP2dqHfbYIwfVrfMSOwLbhh4pSHdkYTh/GPGMSOOgMg4YkSIIe3EM/vsb7xHi5/8DvINx4DLx8qilgFaW07MWwMtLyQ6Oo6fynFSBaNAI46U0YrGhwlGJnUyBImrSM1nfaGtj3lFZnXfrSFP0Wx7q9iB299CsTKEYEZPDkZp8WULAOyeKR0EmAkLKSCkqiZmgIdDmoxtx6SSgbAnjbpygN7YI+4oq3Ulk6WmRNUFi5Fd3rLJCWqxmLEKJ22s6yW81arz5Ed+TQg8inxun+QUiYB1T2koA96BsOzCNT5BeIXwZfza75hwwWDbELitw0W/Fz0tTDcyix/d4t8Njv1l2B0w+f4bMQ5lmoyWzYMMsGhNE5on/7st2WQ51CA+KIxeOw5hNu6WBdA9ciER1RqppU5BtLFmR2P75Bb0aKcHOEemD3hoBr7iEEcWKLxBb2P1jhRx80O2RRZmJxO/Xz+YZ+7ydA4vLf1g13vGz6TIWojBa2S1v5qx4aOxKVOND8mXRRMkH6UU83G8lJt1SdlPvr4dcmP58CTZFt4+rRYQsLAF7ThZE/Ji3D4Ow5+KFqmfAw+YVMWgHm/Cx1fJLAuF1zuEw8//AiP/9jfi3f/e/8ZXJ49Aj58jnh0170u9UNehGhDZNgAtoyqt8WmxyPjPOCmmRUtk9FBhByvbOfusrDb0fHSycBYZVxC/JfTSptA+4Qed2UACIC9JzLKoM1DBQ6vWcbV8eVt5TkAp0sSiubIwErJoG7YC553UQwqp6aJqNYg545RR3TKbDeH55pmRns3Dw+In/ky8J0vIa8P4Al3MiIYadRgVqMhponnvaFy9+q9m7qHW5rMArfDEMuzgyqd6a1V82U8tdbO7zluUxiMPuT/LBrj3WceoB3IobAH0N960Pye/hSPfqWT44uEnPZt543TSwtozbW3ujUtayen93wwnVlbSLsGYzltp4g3aaTswR45qaYxL9Gax/cmiU36Qi90u76t0GaAh0p1pKNItvfn5xIAM5JjOtrRJQAZspSc8U9GLb3UoTwN6BpbQB5u0FAeigZGCKo2h1/Pox28UkjYWgjFn34UzEZJTigP4x4K16loiEWbtE4ockvK9azzmgZltQqR1yNTiIpot5zFk99eioCjUPUxdG3ynPOVbA0Z4TsJXHSAkPWSdNdaNvguwAOZGNnxEDNutc30/GdGUfU60s2JI9ZRjQ38mQRkVNoaHdYr4WlQ79IYw7EVB2q9uotcJ70YzSsYiBu6XEbkzzlRnrR0cqbGOTca8eLztONxjHtmiWLwFS0/iOzloUDmFdpWPKJtBIPM6ohYVLUQwPVhA2+/C/zGb+P9/8o/i5f/zm8i3nkLuD4M3OwA4ShsLP3kLpNJG50H0Pb1mEtVVKjdGpPPYQHVhOZloD8dU+oNpE3GPaBrCZqmIX+1gqFVAUG2EklrwH3nPKZxJ6OzBhxEp2JgYZASQe+ADoMEcYDcxjBqTPNWlMfzio3R9pzn0b3HbX4d5eQC4ppl/H/+G8Dv+jHkw8sa4IqO/ov5WHGkk9tBkhK3p1HfB6ALPbI4Q0Ur72rIYwIZC0xz07kIzQWqjE6U51wOkI9YxWiLjgVQW5Hcj8GO66QzIm0/qsbT21hq48UwBtMgJeF46ZlaVySN6prNcgJQipa1HZOe8OYYWhRXNE8PJw32VvuPtputIcj0/JNiy3Y4XhvGrcxPGtw2I4nh2ZC2bZQEBt1NRsI3GdYYCfa1Ba4VVwasZarPqNiMlnvPvGXJ/K5pt8OTWxX04h0jdgFqv9Qvm75d2Me5DtmI8bZTfwkvtA7goP4DSBp/UYsGKrtYDZJl0lGb8PReOUiZjErIwpqgxkFc6B8IpAX8qx8P18a0PEd/Xk5tKOPIO5bU3+ZfA2rx2jI1iC5j4cBaElDkT+MN+ZE79LpqVLh8tK92RthFP6jM1UB6qeLQn8iOrpt/zDJi79q6plNOObYUL7yoW5/tvPa/JhQN/Yi5IZMsnqBl2ue8CL9kb5TLPKQrOhJRJmXQPOc4QqPx3NmKCr57hDkzjm2AN5TNWVrmDOl4iLeh59pQIXIBe+Fyd4f1/g8Q772Jd/7H/3k8/f0/hfztHyDvLpDnuT3GvXdnPcblXHtmVbawr7pLORvUcdO8qXe99pr9GeDsTMUDpHY0TpNjxMNEYVhtlY/CcOnFcNDxra8Jj7QdQdSP8TgBjNvE2noLcdpTo1JFHMXhXi+0gfJpRpv0gSKwBvU6HyUlM4t7T1v5LT6pohbcX4FLYP2Hfgr7x95CvLwHLlERW+LYv+r5hYQdEV1pOecW4pHjXpLIWjsB1tXz1OZuJ+Ycp+LADtF0AiJkE7P3zQai1oG2Qdy39XVURNq34CExDlph03Hwmetk2eNvv0ZzoFeuPAQzKjS4iGP+BHNF+72NTwcBAQCW+UpQYdTQ8y/Z7yssm28BnhExogFPTZGgRTTUPslRa67nWeTa9khA5QEo0gnTkP/f8PcCfAy1jl5CCC/T1R3ua0Rk0MzINzp2cgrmOPlPUF1HanCcfV9yulTgd7vOXhmqkIheBS7V9tipCzo23EpXBweRuRDvj2UBHnKUnFtqDpT3AHSyIJenmFWh/KguwdJqPrUhOo8drvZ21u6XtWgUbNSp79ntgIf/KLpiFNnCm+ntmaMPy59csgM5s+kQ41kCOcdCenPZYY3jiwe4Wu44zsYUyzjOcfG37mAW1Enf1HC4VmJg3uGGTrtAp8ys1xxjubbIOBMwVkDYwRTmXA8/rlN29IiyLemxcKxT1uHgDDSYwWzlTeAmzGiJWIn9cMV+8giXR0/wwT/5z+Pj/+P/E/He52rHWNOJOQ+Og7JMnsxC50C8cuTPbX0YswVOt53GHpohhDNl90gb+lWpd5ntyPmZooesUlErWxl2n1o1jBwZgUTuK5gK0piSA+HvFtKIqOhkeuEEgOz0MZWGjgBBmNmLeQJgR7IaX2cMEEC+fAAeL6w/+B3kF5/Vfv+gt4oGtC4vUT6cRKPasKvoKB4aeyK8tjfnPSImzl87Kkwp0BmchCAok5ltp/U5oxU6PmijwOiSfFlZDtrWNg92yKUcoBeR5EQIqjSmUqjFSB1c31ottPCaV0r8ofCBRhOkTUi2ptcr0U9mfGpsgdXr53Y7uHZ9awCYuuR2mupv0HYY8GRBC1KRlGQX2UZng04qQJCEwUZKS6ent/ig09Ud+S8CgfjKV4ovbG+N0xhp6Wd2SC9qqJR/Dz2mkdke+76OeaABtjNUu6NSVxLScd2KrnNv7MyKbjbXje2oeA2Wim7+y9kcclKsDhuT7jsG0MvfBmWmfuOSggxM85m6RnMEvsuK5yRWodvZXeeUzvYkFLFRZrxuXbAtmdqnbFMOg38lYpRHyBlcRXjokhYB+5gnoMI3FvJWcykZV42MMKd15dpR9i5dKpXZmqt53HMnziL8+ZC3mPwgTlP+Gl+WRn7z/xj4QOOvd0cGA7JbPZJl/JSY23hxHHxakb0Y2eNunYqMptEWr6DxjPY4nuwI+pqIy0LcX/HyxT3e/G/+p/HsH//DyO//AIjVl8ZtyRzj9ODcAuKrHIIe2zg9wBMlb4Q9HA+scwOXDHFN59US2F9EmA4A+lwBnAFFY3HEN7+aekPAGJh7d1kIGPydakDcEgPsiUcznGAwvS8CuQ4x6UEiDHIx+kYYGCk1ue0hJ73yF1fEW4+x/o6fxPXNJ4j7q6K5Y22G44IB2o4GzugTnrOveTWTE7V/Vx6qhIFc6Ji1CX86fY4W2S6jGICptYSKJJDlKNOpovBLJSwYJCIFK5PpfBu2wwP1ywLp3RmaFbUHHVOZSZMZawWBxQomB9Cugh1c0av7TPMoAseuDGVdmiazKAlBFd9QBM7sQ8syvf5M7dStt8cRvOxlbjcsbWC634DGpylD9PCVQYkyVD79kMLErW8td9ER75w7H6Vcc7RR24EIJ7oiFZ25AafCVrisRpnxXOl0HECCcHXxFIrWN0Z7OghpszYkXJgkNYhBVzOeusDvZhRq82cHdNKETjmQR83QUMYq7E3Lvd5fgK8OZ7Td7lNmZR8ULRbtfURvT4E3IEr/By5RzzWQccNjxFnIy3XnIQtzZwskv8YaDF3nDuMaOqnD/fyjKJgk4Y2IPRZy3JH8oG2PVXpE7Or5SE5aFjaIRQnV5tAxJ60lZ8371jGbshhr/8xOtbzriWFDGkyJEQ5UjIsH/aWzPEsDR4Ys9L8p86gdAm2LL597hud//Jfw/j/zvwPeebv3EE7dMnyqJdJ66Jx0ZtiKpkxDvQDP7GKtWYt74cw8EwfCOsqE8LUDLiVcY9jkTNzRKpkYBoU61uw0LEcqwk7JUPYJ2nQcUoaX76torAnsIx3Jg/xUwgogOZGNKkB5/oD17htYv++b2I+j9vhfdLoPeEiMAFDjsJBzMCcMoy1WjrsMKHQV9tKY7j6xTQA07SsdkUnjVmxd+iFQIQ22CtOkeGP+6GUY+wBU6IQoHWjmn+MZiTYJBEAl62dkYMgk8judomCzq+mENA+5SoSElnrM3nIsg1t1aECGEOx+cA1V6f/ZLzYgN0HBaKzmAA1SjmoQ7HPIWXQg0HQjgyIxLkluJRxGlBEE051U6OxRpufvoz/Tc2hm68jXHHuLQaBL0TY1Q4wzI1KKIQkxgcFlO0YipBd3JFijhS5NgFejVbadtKqZ3l1BUCePJltI0gFavOBEqdRWdm3luzGAmTgNfGcbKlouXimiDfKgTxpUgAIGsCqDkb1BermD86bTO/EGU8+GgWL7jLKJJ4s0HAGIgNOUwfxOfDC/Zz/ELTp8qq2Z2hGhjKKwVfSZMpYWdw3HBsfjMj6IVreGr2m2Y0JESy15Sh0ab+6zAfD6cGXIQFmIE6M3pC9GPrdEx2am/QFobVzI0nRMwEHnrpGtlbh+9wd47Y/9fbh76218/5/848g33qpl5W0akn6aVZ9dUh3uOvyrx6BM33COfAdBU0RBwaCBdGkb+ybtNvEkxcxa/uvsEW0MmGmmpBPgm9OV8vGViRy4bAgnQWWPemfvfMUzIkuyBdcgyD6HUWeaYzJdhVwMhNPDXqg9/u+9hfgD38G+C+T9tVI42cAgAAC4vUzqS4VrMNIBSBRFRdAYhrgj/pHKKrIu/05HYRZcicYUxCXjUwxbNk5jrMLibTCQlzDWbwVyMo6teKv/VukmPJMpXKF2Shs4v32kREEPmp6Z5idzTKK2QpDPV/iOCejARVGb7OH8R6SiP80nk/fk01QILl1s8bfarkjDUXS0vM70OeVLkimD2LJQIUSPjgaqaCXaWQSqpfb86yC2AJLFe/0KwYwCAkbvKTKrFmYImXnWspadipzYkMW/DWj5Rm1t6yTRPJPLJNVxH0FBiqmoKTsNalVOF1eRbt2OznjXZKpYkg4x2ujNdLpMxAC56PFl09ox6Tkfvb+HnpPXNHh78JrOoLAw9VeFtXo+B5ttcoR/cBP1+WYV32iTTiVxbTgp1F8ayZvx+E/25lhod6XpnSqAnQWmW3RrqqlPEulmfqQLe8wcnXkcohH5J5rug447s3Tupt3DehZASkZHN8ircVdF33u2RRoZx51YsQ6rmI558TEOyZ2wsS7revHdH+LRP/x34r3/1n8K+Ogj4ApgLS8pJnGk+TCxaw1dTeIclwM36LyKxk0P3XQ7HSbh76TPxMs0LIOFtPZFOFYAuMOYrGSZJ9hp/RvASJlYUDxYVYOm4YlApmEFwSM0UMSW4YxA3ZXdRxjS4/T05npgG7Xn98CX3kb8wk9hxxVxzSo62umDJCgMVNgV41rgkMdns1ljtGHGwTxGBU57hgRpyiuZGCzWY4DUgjf556WIHFtZeJzw5FLf7ieBaOjm8BJKXSoCCKYnx8jaoMzir2Pc7W3PMgnSsoazfVtfRhXHRGVa+BRlVAZxbAOqo6mbtknPO6HjasF0O08nbKUPSY5nRFml4RCuMo3MTnmQ7RqO60jxIuyg9nxV19JHqDJV73MslughWYJlC5x+05sqoS2iImtomv6BLy9HchwvHZ2xdDWpUgmZc4nG1GfmofV3pAp5D70K8UTsIzYB/R72mkABO4Cq6SkozaYpTzc+HbiJ705TM12pdfDAiQlyMOyYuNBsEPEgMIj7sjVD+87aETBSolMJ60PT2Uix7B8KwKHiN75as+uJcffD2h6nrRSIxSpi5YU53biLWNNyR6xOyltqLA7CHPXWwPasN4MOhhw0dlMDB9MYQJfNBYNNtYEt2MQ30g+uoxIHUnNKDlzj0iSO8XCZlVH+acYBOkPkZzXgdyZoZn9X04vZSmPtwuNLYP/W7+DuH/x5vPsI+P4/8ceBJ68BlwBcaiLXg/x31qRnKt3203J2BhBzedAvt73ZoxOxxgo5oAAR2VfB69HCuRbaxba5hYFRvm7NGoIHCRx7DTA8oMKrspKGkp4RPEEqUT3SUsswA5AjAfdUXdP4o43/iwfEF9/B5T/4TeyoYiU5LA3+q5VbAZpQxxSZgjh5U0flOrWmUUf0IUIUahsOvlwV9ARXK7fX3m77d1SwM6tgybildte6gPeFR69Vu7bAWzMJcrsJypTkFL5YzmmYH3AULpAh71N8qLX0em4TKBFnQgCw9ZMynYfVUFgZTwOw0AMoT22OwQRRtNnOG2WDIPiKx91brybtLa/DZGeBtUEje4wEzzPiST1iRV89D1XcHiaHBsqMPYIqTSvGmnO3yihj0JO04Togx1MtN2Va5lXVngF0RkZbNPvtGNHIEPz6bO+j4DN7PKNA3VNIYgu60K7XPzsjQb0kdtRLNtzK3Ax+C9woLYxoI4DwoTObfaB4KcdDxOH7rRvbuqEajyT4awCaK2kagw7+PPs2SRNj51WHQ5HBXHY4I2WAh9fIkFxLZ1xANnRBiXbBK6r2jQIwM4acR6ql4kHJAA9wY5ak5tcZBGG5CFNc6+ext6Jfqiy2C5NJP7UhWsQxLl5kdBTphulsMxGij8aZWSn5nYguVKdspIztEpSBBwwlHfeb49bZT6y2I4F1WXj47g/w2h/+eXzhv/HHkJ98JAclENB19S0feTVdlIEI5rle/WM/JTVPp/3Nw6Ssqc1BB5BIDKKIf/09A6/o69MEmtP7ABVxuBXcwsWHdoKXfgwTIOVRMqWFYiFFm+jBzKIyZhVoWEKgBhG1jD+QL+4R772N9QvfxBW79yZ3jyxz3ShFlCIbVGrQYYrDYFr98bmWsG2DHEClxXULoVewLJVe5ycDBObpAl6aDeln2CgFOS2nYTXZt4W4xWBrzE55UqHa2qMOrnFmw8Ef51aCsbUvfcukRVrhCOySxO5TBz8LFIEumcVonqUlMh4IrokVEdg3ODYWvg1eSYi4g2Twi0owU3OunO/ohNK6r+OkykYuVVxPINq9EkUZCTkEC66IDqXcqPQt2vsKFXoBqhZmpofmIpH+WVEB2xvLCKJCOAJtOadc8K8M2r6a11wITzue1DcPmqlpsjkVOWjHgCXd8ERhjlDaW4a7db768tKegwg6Gv1ev0j5UxEknWTQ+dji9WyXEVONaNC5eTtzJNqv3TuWOG4Zaol8aj89WVEs2tBNbqKtQbtIN3ccYBg88w/o85b4MzNOfgjcTYBwH26n9UiOBYkfwzFxUEbXN0eftQPkwf3o+eGokNd0BMd5FuKjxgvIuUuHDGXUQzrJ0XGpt/CgtYI01VKOeU6nNEBsaVmTLFO69qiCd7o/KSvKbgyZzz4joWmx7u7w8nfex+Uf/L34/D/1jyI++hiupUs7Q0jdsqg2C2g64UP7Ex64/gxcSGbfA7zxQuON1Wf1NK4M+2H9B1Rgm5B85k7cUTDsr0YL61kschR0qcgtULcHRg1ie43Xa1rNEK3F8XYmUr0NAKDIQ6omsIGejxXIlw9Yn3kD8Qs/gWvs2gKzGOl4JorWkbb16blKQEfKh1E7p1fzHimc6QXA443BNCC8RW30xjnN1aHjfflaeRi8CEbyPoe7+q6WNgFqXnLCPhUFlzD19m0b/26DLNGcYhAdky80niODM8Cg6Gznoj7uN5kGbKUSL3KOudqs6LnnkE6lTWGor7kFr1nZ81nKyhRdAM+m+ugDOKjwnFlAhTTDkQeL8VTRC8tBJG/cMrC7qJUGvUA8r9mZm1HAGZOibCJlCLUbhG0ncOYB0z/OFsSDlsC5rNX0nJdPETmTjmM7adNJt0MOgzLnrnlELcX1Myxosw4d7DaeQG6Ivtt7Ognzn5ZJFriCuANkrD5W26TR6ZWkRfMtUVFqxtjq2PPWJgOE0vBxLAX1vHff7ijn2l9Jl9JV6cpkoDG1i1w17WVolHGgxHGqMZGj+FZ9Fk8WzyrIxIqNzHFeQ9aZm/V7ghV70g86PjqOu8F/p3YG0RAr46RxdkDc9BNctmFyDnfMd0QUI3ksGeYWAfJlGk4vT6zWlQTvd4mb5sXTGzkzUg9kycqKl1jXIW2Ssh1Ydwv33/0+nv5Dvw+fvX+J7/5T/2ust54hscf2zKYltyFPeUc6YOWJo5GNfTTm00qQzdkikuIv3xfxBg8LO1tvFzHXYnUXXF+hZiZu1v0ck6gyU8pqjjGSo4wygjPhW0gJNqATYcNcwnNojw0jBeH+ivXmY8Qv/CSul2ule6R0jqRziWJNkaWlheMWLIzoZHHNKyUQE3RqLNy7PUuI2V5Xco9+aTwS2TUAA1g1TSu3tpFNAzq2YA0CH4KhFA+mAjUf6gEfJkSQA6xAmIenOLMhjzOYIM7hlzW9g7IxtX3Iydzyo3Hl/FFjoAGXg9JOJYW5CSI6eu3Rcw8EdtcYcGlAjmEbJRk1Gugk4AHeXtmf93Oh1AXc4e7tkgNACFzk/VwkEfjpT0c0lwHkI21rRzzgG8FC8gNkXT7UZDeYikn1RjLr43S9pDxx0mDMJKaeJmGhHF2Pk7xJG6YDQyaPh46DMjKwg+vSEmR+tcET2PZyTUGCGbHOjnVntwGM9aP72TTwwwmVvmHMN5v3pzzuxgDO1UtsA74oa83x3coS/Tyi47J9VoNTZVd0xD7kXBEcGZuunvD15dRLOkk9h4ASArc8Io+z5UTLYoFewx82gLUL7fjwgKkZWCDgXSb8klKZTRVube731gy+hkzobO+B29xB4iyg+ceaLstXQFdc055RBQffkZ2dbB5tGvItIrSol+5dLoGX3/0BnvzH/gA++/En+N5/5/+MeOdt5Mt7LXUwIBJQJhovOBLAk2rj3wVjdKJ6A5XQEULJ0tckD+f9IZwTHEgpW92/JwDeHSn9FaGRYPVwCa2Fjt6cFGsoqwFTIwBd2ggKWwsBI6oBtgRIH9XZzQYq0n98QfzCN5FPLjL+aIFRpXEA3GZi0IILfQ7iDANCYVG6u9tOz5fz87qOm5szVpGgwwjN2+kufohmZgnm5iSGsK1hOLSuPOZGEFa0jTnZ6AKt8Bp900d6oMNeTHMoMitlZ7aAc53KnTxlhr332lqNiWnBki0aeJ7aBnfLp2R4WO8wKCtKNM6AmXkBOJlGGdo9vpYrecSjV35GcJm0Ycmw0642ItVHmP48MMovQwsGjYzZ42U048hG3/aFIvBxp9vOrZzLJkBwbJxTElrsZCotTh2jiqdnyrstDkTs3+ko0Jhz2RApSPXYsgxmCXMea8qTImyr/s3RZ/H5wAXKYood4PIPwPR91QGF1unHYTVec7O+kUY9Zu52mcuEczmL+CJnqeley4FXxHVXRnQMkjsDomWAAchRfZ8+cAkHLU0bHqR2kKj1y5trp554Xic/ewY5d3qMOpued2YbwB7TXLLUvzF4l4OOWnagqaJ8DX3hvHJOK7tuYM5/ZEuGjKWWADxfymoOXrqfwoD6rsc2cIX6z990GNnUY4lw6r+4BF78zgd4/J/4B/DWP/p3Ib//PuLukZYcY7xYppLLqqabH4T5RTkctSmzaFvV/RjOLlKYGi27rOeqMwiYtXFfCwnw3OGSBadnJogNMoxBWMB8DSbIOc1qrUTwIGIWlHSUNdwKEBiQTqHLgHVB3vqFbwFvPUVcr20kJibm6XdIL0zQ+TUwHBg6LYlx3HAz6xWw5Py2jHGC6aX27brghSd4BT3LnmVeK6J0Cq0BRv5UQ7HGB8gxC3rWqYIqkiqb0TTmjGR3QEYCkSNlncf0CVx2Bqg8KTkpI764JI0LYqxTlnCS7Lq7fY4xoUtSjiK5sbZHoNTinsCKJ+1hGNFSrGlkKn1uvnAMCSgVPl2PxTsbcq7hUpyDwoIDsaKPJJVTcSNbQwh3G5CprOSz5VV+PVRXQmdkgIDkNp3VYLoyDzEJOZw1x2i/iJEqdX24Qkk5ucrpCGSLxT74U0VXbWxpFDAcw55JdgVuWHwFLoo3aLAwjZH5rhP0sMUTF30NnoO3tm2Rz3VAgXnDHo19DgddztUwyBBuNIG3zS0B3hmj7FP5snW5PpunSco92zmcGWhMWnXdlgfKIIvdchNnUp+BMrhh408Ma6MpPYL5MOxkOVDCPn/u+fOngaSJulJ3Xz2+HMb24drr4lcX7lIGJYdQMJbEiykGe6sY0XUVbId91eTJxjXO0wRGTZDe88Sli5SPtmuydXT6r7YjfGythZc/+ADv/Jf+Ybz19/ws8rvvIx9dpFNb+DC0nfUECoKI6WM5TvUD4f7njMJZPSAQ66KtfsQkuWADZ2mxAO0MokcGkkEDcTRMmsyT0w41gL1eKxONNJEq58DVJZlHYk8no9962Lj8bd8APvca8v6l+08MkrTQCIjq7cMn0EQGoLIQR5g719qFZPqHpExEnSDWxioaqDR/vREW7igQm3pdGY8eFxVi59GGaYXDBklAjicpNKbFpDdTZDHGBcRNnRHXXsM85Lx3RywYxOjeLcCQjlZaeWnMq3mQn/qcKOZZ8VwJAnCOvgpJRRskacelA3ocUAQ+kjljUtMUp+VSRIcKw2QncsisxmUiDj+hjUEbd94rTj3YkKdvoDMd5piDw8nWUembgWD1Nkc59sMYFtB4QyAJR1c0ErpQp/raUKV9z7WqhyFDdRZBkn4GaV4eRLmasgzQCOBwkjGqp48/KiQjH/owZj1ay0N0nJMNgzoQSs1rtDQyg+JJKTBig2EdebDVHo2xna7CgZvC4R7zvCr6zETZAKqKX9g4xiGe+d6CaLm/Ndz8N24/mMZvOAf8bElm+dfLgyUSiX2lc9V04dJloh3DBFNzyiQm5JDSGQWIKQSfKSCHiyy5OnAtXRCa450tLB7B31Qk9QM7HOw2YggtgKvlGRu47gR2ILLcjMeZeHj+Ed75r/9RPP7OF4AffYK4q4PoiEPehZZlN1bUEgrSMjrNqfiBOVAQD+ZSXrbgbOLIbPNWh/qPVm/shdvw0yuKSUBGEBRUdEqZ60s6aCZbiMLA21EBI3ymJeR5HcYKRLj6/cUD1ne+hPzyO8gXL3QO5u0yQlIAUWNJjPU98pT01YRr/GlKt3c94awi3hqPK+m5PYQp7Wm0YjAxgK4a7stskhkRZ17U/c6xRnp69jY8Bbqbxo3f9/uiKYUjXzUoS1KRDQK4cXzcV4pQBMqRlsuRNh1OR8mVo1LcRp+jQkiRqDyHkEygZYyO2txPHjDvnS8a7gMdjSxlnZGDo+DBs14f88U+FpFp6JkozwazmgbHNlywmzVDziMGBQOo85/a2+d2oyCo95BVLY6OcQZAtjrq1MOjcjt9hGsOR8lRzjAOGhtU7xMmWQNjPec3Q9gEjHYpiw3O7rj5k3R4LM9IdFR8tQFUw83zyHaia047wulpvhIeHx1AjVc8Dekm6RFDXnz/Rn8mw0THdSokpkYIGyTvxCDpyRhupPonRWm0tJWxm64IdjhabexrcUELTdCW15s51ysjm6Elh5bpIWuZ6JsGU++RWdpWyUzQlXNoHgmsINzhz9b/ltOWcbqku/ElkdhyAltukkaPMgTpFfWV0TaQ2Ecevt5ftEt0fHJ7mQ3kUfOjMzBzyZXt+bSSZlgA+fweLx/f4e1/+h/Dem0hX14riqd3ShxD50izMricX/VZv7r4dfKvZaRVLkOSLPlA5tjl0PImFTW2014unjbW8SBmqiJlMdUieDd8NTjWSDhB7TG8GQTMWKXOR2RBQU7ksS6PF/e4fPWziG/+GPLlS6x1e6zpwRcRZ4iJ/9+OiBSPtG2BjNGGlEwE2x5TEw+wNw9kX+nbTNgbmdcyKuC6IMGjT/jjSDtVXWMzWPiwFspBgp5pJnxbVit1+SeBxNVeOUpS6OTNNJQNRaeagttJqsPiIY3sPujKqmAO0AaXQm4vlMokOZFD1oOi7O09xmanJ9LqdsCnDHrYNvF7NtT98E7uGEcQzroOAbxkgnpBMBvr/2nZcDeW7RxgUmI2ZOgYe1OTOjIcIluIQctMjT+RLg4FtNR0pjBbPHYqfUpjxvFrKY7DGoDiE9c4Fp/hUDRIbUlkPYN/Z8p+THf75YT1jPzisOM2eTu25dHIIHmxTxul4YQWGToaYtQF83tLRs9aEp0op/mOP4Okcw1XDtqYF9PRt+v8XBasF7iUATWsOhWMZRXxcZtW818Z9K4v6GU0gUbT3Y7ynEwvoQwDmFmpfAUSWjYcY53j0pJxCiNvnTf9luaTZIoZE5qoQ97g56nZOeje3x8XZ3HO3ceG8etYc96D91L9UXFAedo3uAcWB3Yze/cRF7si+h99hPzWV/CZ/9ofBT7+EBiYOvk360yoz9XJlm54TrQF/Wx62Ray37Rvw+HqfmLLeg8y1YN3HgT65SUDfjCKDY9LCOL4qYmmdpg2TsgAJUF/KmB7WBpCtCMBxMsr4jNvIH72a9jX+1Y8V3KeIBxHgQOvnSU4IKLBwus6/NzXKZ5OUA+9WimEsICJYRAwa5eBxjQyJzOlFAGejiV1TpteRkOdPDM9m1ak3Dx1D0itC9q41VqyPMZ02z63vQVRTkjPATHSkIAYCHTqehT23ehfIKAzumPU3qrGwW1Jkzv6PZWtiJALR2rVxYdwx/TWubuJjke3pnPmKGu7QJj8oIrq+hEpUFfkznWDCGjtnHRRdSVQNeLcLQKfmNj/O6JNQNE9O6BzR8cpEOAuLnSbJYol81joIs4Yc6GcsNXOwIUoq+dmNMzzCRg9ljyOCNqqKp2nHKitpunetYuEhmRHH5QyxsYtfJob244xh+Q4+106Qrm9nMF1fK6bT31tHvlOB84/zerDZrVWSUajq//LUa6Pd2MP26aTQZUawIlQlDozVlVZH5ZPLvuxGh69nfpara3eisAMELEhE85YRABgJi9HxtZO1yGv0iMaVVKGh0RVe5mhXRPIrUJlbivW3LnrQk4N+cDOgfPAnd3qGOP9qWu+IZDRrFWfGR5LlCyS0ve+T0Xbjo9549RFOvgxsDUH3eArjscEReO1Ltjffx93f//vwbNf/TX86J/9ZeDz7wAPD8alpjDJzd0ks6DdktgYGMOWUdaKa7AUoQ/t9ZJxEOvgaVO2+vCnMzXqv5BHAf1THWvHH9P6kZ3CHEe9SjACvBs8NLk8pghQSDt6iqg1l0cXrL/9x7EvZFAZHq8nhdrFwRCoWImEQVJgmqwJrdtTkOwJjnEDWtjguqcLsLIdqWUl5LYMCY8dIbGt31W2QCAMecBWVvgDKgAnlRYD8xDgUkh5yqRLCOArE8D0XjSud3Qsj5szWFpy4fKA0ubU04SKe3K+T5oMYHcREZo2Mfhgo6LtfchzTBHqQ+3SGRG9IAdFxpqkn0jfZGU1dAyeVBp5jwdv9COl9kOiW0Z7TDph7wxpLKMZ4Lm6cm5oMODnCLxHwdQIU8vxdf2EDDUjhR4VsUBk3SkdsrOUx+/Fh6VpEwejo0pGQ2VsUhkxAs34BY4UubyRqkxO+WKhz9AFfnJms4ixjtPcoOUK6hp5SJ3qyAPKruGwe5JfR1l2DoQxEcAaS1pd05IzM6a+2umm8SJMb4+rMjij8p+OwStLC8aC+jj1oR7rOaxFWY92WhiNH1LfzgdG+0PH6Cg1FpXItoM4xD8wsKppzsyHdtowIOPc+t0tDOd7QHTNBCfFugdhd8v/gn8O0SXV3uEsDPqwal5YPAnSY7Aw+O9UCxw/k5fp8Xay97IC1+9/H2/+4/8Anv7+bwEffAw8flR8p04OOhpHk5J3zoeYj6hC+HGmf9HANsAFoUP/Y9AD848ORZ8TnekZNj5BzoZNBiR9Nn1EYOUC94XTg9mbRTEeHOABKr1NK7s31s9+DfvZY+DhQQ6IBT4Nknk7LWck9lBQRHhrHjiFGbGjgZ++VXSw3gDVnuuuTeYFumObX/XdaTwqjzAwDobHZDIBUeaDdJXZtLOQUFqznBb7f96a2c5YG3ZeOBHy4slvW3CBsz7zUk9FqPyOE0o5TQQPHREribGC19wtoKtpHd3WdBqoUHI7ckAY1w1ZoN3jonJNw8m5meBsuw+FCcsL2gC7nmQsGYhP0+MZ87Z7c0TZwAA6CdxoIg2WaH5UrQh/T0yn+qA/vx595zR4/b1TjU5985KYQKWMrfqns5JIXKW3RXvWMMz5kh6EL8rqmlYGgcDlwBfFLcl0M0YxcJgXkx6Y8kTw3y173S+4xmqHqcSsx7P3OdekQbNzXlaJwNv6PIoN9nSgUbTZOmlQbljPz2vp0vtRCOg5Jc697mQi62ww1sTpUEDt6yIkMxtjKpbLubxMIyFGUYaMOaPCcjxDPCpscdFjXzyVG+VIcCnI/1nfHLnm+MzyMBxy2gfOT1hS8yIW+nuctVyiL/lsPclBz5IL4hrk6GaiU/02sDVPNlOnQ7KmYO3Ay+sVb/xX/xFc3nsT+eJBgRRpyXFqyYc0cIQtnFCA0TiljLLwhkvbxqgZyCEcZGntLdqiBVOc3Ri9qj0YZiFxH7MzyQa0EaMJiPkmHOGg084xBtl49+Ie61tfRH7lM8CLexGDqYwV487r4EsQgVoqoDOcMYnicZQRWJ2eW11UF/CJVeGCGLTnukkPJl+o8lSMFtJeq7URsQByTz2j2Zq+GTZdLiqCDK2q74diVKOgcjJSLHya94PTMaHT0tu6Rv+Az7yX0zIAYGmrRMOvZIZuaes8i5Uo2ChwowxWdGR5qIMvvFTCiCmbXqHIggDZY801gNIyqO2sAHxzXPPePoykcWWtJV7EE9IACPjOBRwt8bfqmwVMOp09KRfab9vPbjl9u/VAxxAPAMN4tuZgQxfECEpf00A5CRltgAf3EFhVnLlLttagBQSkzEh0q5Ei76cdXewz8uHz0LOdZFiFj10iNNrkkQqiqmCWu0W4hqL1YUlRDMNWtNNRy8CR/cIwnMQ/p+NrfXhzPTWZ2uf4mjIaXyK2twBThyTP1FXKnYqTuYzHuWhCjvB6nlr22LsoSB0YqEP2J/nQDPcdGdTNANBBGYPsxjatWbQcE9LF7wR4cyuP4NVuiMSR5QpBU4reWzTkP8QNy88edLBj43YFKnLQt7C8aNDY1/JcY+vCyExty5Rh30PXFGgAF6zShebmIj6QV7YK2gnBhE3Nk9lJVJX/i5dYP/Ye3vkv/xHERx+2TTIu2iZQ7raN+yHn6qB15zIYH7IJWvYkLbuwOCkDwx+i7dSCfzaCJTxZKlmLS/+e6kwAGDLpZgoaRAAJloS0maH0bHcVK4CXG/H5dxDf/jHg5X0Tq8GvtB2J6Ht/otua4BZNr+whLHl8geh9l9Q4ZgrqfzPW8vgLaetynx6jxjENnImvNaJ0WyX7rbxZRkWFh3KoeIolHQciFcGCoNq05tIKXDZVbfHSkjRd2O8QwGhjyv7WonISGFr2KPiJEQQJeWT4ALkNIuH0zCWYFJTVUTiXJ/Im8m8DYHMDnZ1Ar3f39xI8KhONPCrDo6tyCdVBAOWcWbUNz51zs0UGz1+gtePuiRzgeaWj2ezj+i4LkXjOOSNNygTXtmftgvoVXUeRX/IbuysBsY2MalAKMCoYX1WL4/x29Fi0zqxIxK3ujGMM0fSs0TVeNBjPnQcCXhlZ6mjaaDR/pu4AzpCRdpGkN50fMoNGoX4oaHBqKtKGokB4y35QRyYvp2ypxkfYE86gpLngvsJ8hh0q+AnjDyvstRWu5WXyUsYQg5epft0T8cIJVdMe4l2SluqCOAnwiG9l8NTvMF5op4E0j/DQMaP4MSU5BcEPLIgDWyZUyKnSSNsh60bPIKPHOYIW2Tw5Ju2Uso8NZYfq9VDwIRnee9BJE4YzUHaYqo2FuLvD/uADPP3DP4dnf+TvQH7vR4jLpVlruhx0Zj0QHZwI3ycQoSJ4L+sTz6bmj2OBKVsBXyLS7SaY054C0QaP61f0cnd/LoU7QIqD4MBbOMNELfmIMekcjO42HhLx5ILLz36Vmmuw73dqnbEiqRU0aGEjSpHJIoTXUkaUGlzVNyGU/gEMdj3fRYoLEIc8DkFQMaO9CjCaXDOuDqDOAmCaHlOv7W0mOv3eoNp22bTgIHDD8EEP4qr6Tb3jnwg0jGBSQkmnyo5b0YrbWGx2mCnZchas4NXLCsuTBCNCWKDoZjsVDxpw8c40IrCvm90LgJeWrGA4DLIcOARYhLfJr/SriqAG72fugjJk42knmvw2kEfjfOpZ8lWcHLslDL4EhR7H3PfUOoFeg6SjmNQbZaIcpdoojUwYLRxLJzqPYV4M+aLhBmTEqafHOv+UDg2XwQQzOtXconzO3QrZfpYMboM+elmrI9LkTYOcm1Lj7fBzTDNCTcBRM7VhGBs2wShvYF6GA5tU2zw4SSE2nO+6dWgkDeOjEs6qWof9mT1OpavB6z0N6TCic8mDjtUeUSyE6z4sKIdeOmBYUZkfNA8WyJexdAUL71Gc2GPnYVK5XRNDfk3nQM8DrZuUA5+LMec564YK7ynPfW4ummbXK5BbS4Znm3n+3VzqGcs7qjcYy88WBfOu5aoylLZ7EQsvP/gIb/0XfxFPf+ILyB+90PfEKGUNusHUXDw/F88yq+R3jM9Q0Eh6V0aB485jrABqGyDXwQsrhiclY8bJmgFTnkXXQ8ipeA0gLQzybj5F+fL6gPW7vor9+iPg4aoridOwDUKTkAOt173eM6u/GwaRAjggc5xLjzFNOkdpw8uxceuj14N9PaT2b2a0hRtLGrADk9jeMrhH9gTTWNe4FKXf0BytlIMh/juks0gTSrEuefMwHdd0zho4Z4ElgaCBhMkiBOGbkUNlZ6pAp+YuQyqIbD5pyx/fSztWlJo29q+UEwwAI7ibLKT4Grs/br+n4fF3dPZuo1lV91NG04MwDu2j/TIE4f7CWQv+S3pyJHQJc9CA+ub2pq6kQa/HoN0Rs6+EAMIk9Nh0jPWcw275FJ7vie2WadKqiAdLstvj7pSDPsMok+Y5eGcnNY7vJP3d5+708Iql1HGIJz1KOmTZB1ZJTRwFD8Q1r8agy050Ns9rD5OgR2bKADKofQuM3ab6uAFYL8PkwVMQuFsHUv3RmUOrk9eMybk57Mg+5Ak24qBJMetVpEeasq5ppsE9V0hwvSRQDkMOo8uAYCVwaZAwjSbp2mi14bWD4LS9Cyf7s5ZdZoms0xBOzJqN019K/eu1dpyfpelnZ6EPGepJ0BHmTI5lxxf3uH/9Md7+J34R+fDJwK7U/Kex5//1SNfhTPxKigBKX6JlQoHaTCtr95WTAAxstHDLE6UhA9QgoQG1Z0HvpaP58iQH8JGVw0OcVYomcQF9JAq076+Ir3wO+aV3kC8f+sN6lkVsR0QfFI4tJSB4OBMxdgE0Qfnese40/+ij7UKdmaJWWs8CUsT3mqtOrmsg2tx+yBR7oQe8P7fGXXmJ0OczQmREJk4igFzgjV3osTXFWkC9dziH6LzatkmxRDBGhkrmOeIyKnvfccOhDqyRrDpazl5rLZ5NJegop6M5RXcHU1rOruQLQYyzMxqVThIMQYbL6+dpe3OpKxVVD8Way0zBY383svfq5lxLHAo9ayhqWQOab8Qie6qv8a6K9IZxCvhwl8w63ITnwjt1DtFDk6bTt1MRjZzvbOc4gBPUuR7bdBtFTwQhsA2u0+4a026smGuQjJRllK4G332srTRdjy0KOfQDnhf8fnR6n0tpx/Ww/c50ObnE1NVcY/3a4G6nu2sZEE2+Gsu+kRsVi0lUey2cFf/ckTM+4wFJNui8TyDPWoU577Rhnuc6pHg6ZE+GMr3GrXY2WCOk4mYZQYzlELdbU+y7A3ZaJpJ3GAx5SHQtwOlAJ2XRFt2ZG+pyA9HKQrt90IC09jISwnzRePcVchLGmGRIt3Hdnw+Z5RzF02x/o5Bwd6atEaIzVD1H/td0ZI1NxML1hx8Cv+9n8Ow//geQP/gh8tFYhpDYd6ezSLGxp5ZOWidAA097IrjoEfd/XWQt54QPBd86jgKOs2N6FhSyHpgjkBaCEXHPxWxHLZxIjEF3d1z3etjA608QP/1l5PVa2xwGNiymI3P3mpuXG7jB1mDGiTLt2vUD9GrHMasEHjLfXQ5Kgf4W6TK0vW1GKdiMjkZKmOAa0UNyalavbN8bIAdnplyThrvXKxGtqRM0w8YCSwffoA3XcWcBBZekSs6hP6CRBds1XfaxLmkaTAGL9P7gI00X46Vp6AZJs0GLzxySrYdDv6ba7h38ksUt3mimg54ESCos1493Mt9UDpnAnmAEGAD6Cmqu0fmZNL/Em/p3KwtGsTOdtbTAAsr+PDWv1KcarwrQ2K8hwTLuiLgM0Dyu2uAHMEIUMzS+6EEzi0UnZ1i+0YwNP98vsenxjUxgGV1iA7QlUw33vL0TYcxDW+bqM138kw28uDEg8HimwzYdOZ9vYYHWIgrbOMQyG1A5jjBJNY6pB+kG5ta3nrvscTtf/MNaFju46bFSXW4wV8cuc2mCTkYbEhdVQ9goZwrAXM5IYlBwmcL0oXH3Z9n9cxzTQI+IWuRI1XFRdu2IjjkBR+2I8EaR7JBB1luJGQ5wIce0xzMnOejNby6Ej0zJxXT42O5xcVlMOiSwAs9/+Ame/md/EY9/6vPAJy/70LYBfiQm9ig49og0X+oLbcUowD7/DHvLWYneNR/eJdhKnUW4LGGKVUeA+IYhc81EG7kcRZwzAvLWEAFC0GtqYj5sxE9/BfnkUd2oxTUUpt8AHEsA5nKNE2YC2pDW6oELYxyQxmBgA/yI/AId7QBQmvogKBnA51s6ptNCYaKxZrvCtJp3RfstiEElAxCeg+jIsY8ImkN3NiTVvgwBI4WoSIM0SNY+UKnbbbVDsY92qHQcXyLhVHIalJNHmNoUUVuDaYEBpNUsHbSueI6u5u6h+Hzr/pKAzuUWYh4I1CHRNAhhjqQzqHmOJUadjLwX9Sog179Nf96kKHXrvukd1WcjcmkwrXY8BhlF9JILx0HeJlSlzLV0LrowmjqMzZDPHFFaGUb+9Xzl6tFASJw9bh7hMh3B6Cr76SgWzu6Odu2wq2I5IaOee2Nfa2zHkcCkEeY8lFfWHCX6Y8jc+XJkuwZwp/pgh4xq55RzNJyjy6YPcWL2HZZ5ZRxo2DJxbO2lOh/t7lf7lGqRf5x4CZrqBsZwp7OUuPlXulS03VfP7dOyKDNLUFNkf3bkvXPEGETbUlvjfBoqa1aEL+qT+jvmOXRD0f7Nrg7d4rjdt5Yyh3yvLsCdtz5yTX1mwuayYIg0zG4u03/PTJax6KSXXcm4v8f9W6/j2X/uFxHPP0HEHXK+JzEKYf9o0PSl49ipxODSG9I1S5R0+uiDf2jdCwAKQ0OVg7tT1bQqC7ryMgAfsIKuGq+swJJcO61D41X1BSGDGUGaBfDiivjyu4ivvAM8vJQnG+2xWqi495H9rEGfmFjdmrUU9QZnHdyb2h4xhWTvPtKx122izoz2WewtSLP7JCiJHPp9LtO7pCLlaRdI0/moh5wKKgNGBTYvhwGEP5MC0pxH7/6QkePlO0BggdvjKkI3+tCJcCquhYZRQdqp8p5rrq2BL4BKhD53APCz9RkVjgRihgSWCwI324sxXU6dLEmDg8cw0rRtpYseq5WbETDXGQdoDTECDSwDxL09y+R1qmU458Ujko0RZXEoludQpsOXI81UPdcQHR0xBaqiJExe0TccBlLGwo6itlpS/lDyHQjMVCgGoPKiGe3mYFp50gF+N5vXxUeDjQjRvFkZbUxGgHED+DbMTcuAeTjSsXJV9Z1lIGl0MCKgIeOyd9JNkQXTcPLmzUwgwrdSEl+4nMc5KPMyol4a1JkaP3frkICDYpm4avkFw5ErGe3NJaatjETLzJ7RrzNKp7G/+TtqJ46Im7KrQrd+XvVjI1OCgQ9qCxoLx8Apk29O0fuleW8ACZx6pg0xWIdgXWM/MecCoM5TpBNb49j7Kr1L9Uu+mheGGiMFAGVBJFvWPiADl8sd1g9+iMsf+lm89od+Dnj/Q8TdGrx3JmNf21GWGMjtOHC7ArGjGmU83X9WZylf+TJxB673R9zOR4LO2MBVrYm5XamIRY7Q2uQQhLhpGFIMPL5g/fSXsffVXk9uXAUEUfV9INE3qj6gjlulC50ZfcOahSdFwJEHSAOTRdGEUu0Bq4qBnguL+eyZymhRkWkcFw5BaBwZLOqKixieLQE90b4NAdrLLjrtoPlSIrKbF+0g7br6V+djB9fSop4Fi0ay8aBBuGWg+FJzjiQINheD+FYScR7byYkGIvYrtI6LZYehD+lSD5xHxM55ow2snMchQ3V/QcsaadyOJo/pzSzndW3za+e1M1ztLA3aSm6y575gHaCScLx7I3przkrf7sUK7ADlwaQSqNFo7QQWL5ai3GWtcQumal8z56SsF+UORwfqO3tS3r1S9OeOlSnP4seEk+QaJCQD7d4YwNvBypaZcvKW5QxDb0TkhYxejgu/gygaJ3UnOot4csnI2MtmK1btDlq17Zdj8XJcAbR1zk3xh0BvL140nJa1Tee3x5+JAtbNCYjaYDTKvfQMrOrPMkZNfnEpJ2hAU0zhWDfGVdUAGOTYaYBweffRxaztYq5IGECJaZxKPRVt+CD9PtCbGLhLFqWTg45Z0+zhe+nC2VzT3RbDS0EB9PjbJWKmrr2z3P3ZlOlupVhsXpRcEtJG9mQMIgcvtnA7ejddByMR4LHVVBiO9fQFekzEnjGaaFG4Pn+JN/8L/xG8+Av/HvAygcvqTBmD67mkTYcTGqsznw6KZyYPYLA9yW0FJ2VKhOUZMyIeh9ZIgHE4CIlQkUV95Whiq/k+A1yeomVe/94/YP3kF5HPniDuH0jKpkHNuk1IkTFawAOoNK+zEUxLl6xsCQjXSsKs0XtKA6McGmQX7DUdQlsh+V4bvlbWnbx+sYWOhvRWGPg/8oAMyU69HyKCyuykBaxaOtOZmVcbIwoyu8zEtVNuxcZ5gyHAugnfEpeO6sFbtGYdR0LxeEsjo0+lZqkQQaXa0KVEkWcBock56EMzZ6plOw88fAnsf/4LeuSpz5CsVchDCxJbCl5r7c4+COroEDNtTUNE3icBftSSdJq7RuwDYig3qnVJXo17OtSJOX46OTb93Mq2B9Hk8GTTdbYxI+5j3P3ZK+l9Rj1mjPggnYDkz47bNA+0GjnaTWEJU/6eMw1iHBGqopmew0zlFg6QRgMRyf8Wo6IJo31mRLaeF80MN1PiRoElT/fbx9xoMKqvSm/7IrCuPYkZDY6tbEVQ6BhgZSs4Nqd7i1WNTxhjbfnl6aoy5234rS958M44Ue0tvcYomfIzMyHnCX8pXpLmvrWwiuwad1Rs2e176APHLDr6l84Txh/ytr/DGCdaD3wQduo/qC9fwnRkPmbb8x3JRgrv6qGwXoAu+LQtMP9kx+aI2m48f4H945/Hm3/070H+6GPEumhuynTJsfMFWzjqnIa9yEldOgshnNZwRHJT9w7Dg8hmuJAvwQoRJFKXDGBDpwsR+NnwmYrqn0eeMntgeNiId94AfuqLyJcvwDXCKQ/yglr6E4ns864jwyRIRkb2nBILETiKruyFd3uUgQ3oyiSzTiClXRFjcErtNz25TUN1BwxhRG87IojFa02GMVhDBK0o/tODo8PSTKtsWdGbVxOvRF2Tiux6CU4sBB6Z3BvsCgqyoJwZ86wIHWKl1vzQTlj0+NOyEA4BmsajtgPMIABMP891E0+bacwai46/xOwHUuL2EYeT4TajeWI1DC3HBlPLgTLmI71Z7Q3nYwEsS9VSjQTMyx4GUnu8JaL26LN5QmmgUnttOs45pOl3yMUajhxbOTGhxqLo0qq5YsyBAD8iG7GQFzINmeb3yKwxJGUaHc1U2x0KiFelAwYrOXqxVReD6PTxWBqoj9vJzNBEmEGDZg+w3oVXGTGIELCT96epEa0A4e34ePKljdsIMJK6QZ0eELC4gynhSHjgh/iXyxE5VWywEeTtUJnKhaYbqk403sC1+L6YiirqFMz3smDUAVbMmlRAtawDnFOmC4w1h4GNtCWoOiBHojaqzLyVLKZqIUDcPOGAWoFrZp8yWXTit7UE14IqHhhfKys7tEbtE3lHrViL1rQPuiwOhamU46Fcalj42HopnUJ0bJ2IS+DhRx/jyX/09+Pxn/zTePHXvgc8uZOza16nZaQ5fRh9GXUK0KjLUcBOBTaWMGMTGJniLFlAMDJsYhLElJI2LcbCvz+PruIR0LZHU4rbdboB5E6sn/kq8kn0643AOTzT69Y6mx2KaHFoQU6VtqE84FQ75ZD081qbi04TQn9recQVsJVA8Hosvcve5g9F+yIiDfgQBZIm+jKhG5qSNipGick8verP0INNK3cmcIGrx6lVtSuv9/+3BmYDaCVuajfBbkVlXzz0pPpoY9ZdFq3Yv6NFGnE6paxNOSqImTHh9qXONnBNG7CR52A5DA4uux05iRpnukaBXvTc5sMqX8pnaLZeKyR6S3bYnhWlAJ2pYZ5tUdEO6z9Z/HNcoUo+7ysyr/C6bHbk0lkDyj8mnfsw7kF3jttOhflR82uZ35ZGrze3ExAioNtm1NHCxy1foHFVxbjlSePBOW+NL3NsKx2IDkhenQGj3JQh2nLE0hjGVrLky9X7XQw1o8OO4gTqORyrYbQBqB3qgHTySroMfW5dLDVk7N18o9wdW+Va3tERcjveh5zs2crMNjRgJ3WTskReWekyudRHXl99zkTLyqx/idEOnS4aRfPe26jX4Df54IgcR1ZJe9aHbSF8ETsLX7qehbUyGSr+3dTjzpIokCPt03QiFh56P/jAdxTB05G++l3aBg5YsnFgUe80ST/jQ+ogzFDteBITXHdR0rOAh437tx7h6T/2dyNefKIMtByfQdOimU+spE5MJ5rY6cRYyxSvD6deiCE1J/m4MSScwh3dudkO2M0yAbIHk818jsoDg4EsANxvrC+9C3zpbeD+vosO4RQ1PUyuowxjW2c7p4g5D/0Qo+h2buA4Qa6BH0wzsq+D+TkM8LDEESo81bSmADbQq6o7/arSZzJg88Cdph2dH0QZbo61aQcA2pfN4rERVYh72SI2BLO6cN81X+6Drn6qhoBZCCt5jDAoqUgjKuMuBjoKLpppes3K86BA8xkrsYuF0n8lXymZ1/pqT65SjhgEMN+0rjqUigehUIY10QZoCEx2j6//7opoZESlTL4YxvMaa5niQVipCQQ5p9tgx0LDzC7uChkM8HOBHGUXNroEwc6IzUy7pipwPoFBaVxaTjaFM5U9a0gsHEPu9wk2s736e96N4V03zthVd+RHO4n8PHpMajAwl1nIXp+10XJ6oDLUthZkptxJFKl7/d0xt2orjjHeOGxZa7uZ12HAHFQJQ644/wS0TECfNdXncAIGBtFwWr42kNd+/ioDeSwlXlvmtrVewR7oBDfN6NhcWxYkApYfnZ3CZ9m2vmOw4OBC9AzoQJ8VpJVYoqUS8bq3QXtrY8mns8CcD+UutRTpg4jIO/58OrCUM9qEnb1FkWJPvMwcSkgBgu0MdYG0uCw8vP8R1t/9t+PRz/8U8P4nZ6GeRq7cBLz2T9s4Oup/j4xWeE7W1bB9hLbzDkDgY/LoOgoe6VeGUrppL0e3SjOjjBpCBCIjYgXWt76AxNXvhWQCTAPV50vz0y6AhS68spNCxyQaHMpY7hZ8uS2DNgTkXkrQ+nXas+s+N9fsuv0t6QEylgFtOBEbVshNIQ9OxYfJzmOORXEKP0sZ0kZw9fHB1c0oChprmjp8hO1tIHcfJTSyBwL3LEMf6TS7xuCwGTy6WNd9Uu7CqT7VYIKRbfODhhEGoCKJAYGGV0A3IjPxblSjl97GcK6GBBMUcoAPYGUgADa4lVM10rRs/1O3OtlRmMDj6m6CXhvw6EifejGsoWgoI9wMGxZbzrNk023I+YTHXfpnuswlhaQTyVeGw6MEE+cZg049Fh2rgeyMSIoW86hXOgLnRS/dXl5rW1gC3BVigb2JVOZySH+mg1cEqF0vsDHWekFvRAZjaXzUH9OVzqjktcHU0foAUfI1CVp71A0MeRXtUoG9brEcFfiKzDWvLWMJZc22dDyDRsc0kF6oLsAHgaWW0uo93UHS+sIrnaMN48RqnaDHd5s+pDWzITw/Y1jbfs5OatHu6kiZ+ijd3lBwJFnpeV57Sek4s2GoMrPMyQAhBk7Uw/r90Bvj4ZRD83Asm1G/24jSYa55jyy3bGk9a6tKXGyb2nj77D/59wOXjVHmLTutN5uuWqxIyynHh7XG+QGpjCQx47QbNKVydT2JkmsPWl7tNAYgHNk7UoTfr+pRglwE8uUV8cW3kZ95Dbi/9qOKzeVd+ZNErIs+Y6acnmkiVPBFY1Zn1ZNpJvjgwzGuo4ZhhYKonhR4+jt6R4Tn13A+PAuvuwXmqYlkaIzZMYoSQxtP6CkwxqHRJAOpvBTeGdEg51WlkOJHg3yNfTeIUYOiwXqPLEdofdPGbtAwuxaDSgeCxBZ/ag4Gurrxrg2ihcZ0kycPK+ymj20gmREWjbAAS8sPY/uixpz+l3zKBtrx2Xke/X71Pf1+tTHl9rusbA7TqLxBUno2AIy8VJTeskFAG+ajx2WDtT5NoFuWlSWhyg6ZRbi9ur7Ur+/BYBn/ACp9TtnpUXV0TXos0YpyCcvYoVCUGkc7lCEf29tGvefjZakBuMyMEBNygmPpxPBfoJETxFl45ymNX+bDuDlHvtk89uvXImQ6nU3cSjummhcg/hR9GMYMeqVl3PMh5cbSlfSqUYWnNQ6HhVsltXudDm3L2VYsY2L47P0bETtoYCe+RW/oZX8Wtdx6bBArwbPeAM4WEL/gA5G41bbG3uO7GQeXCfTZ7TIghvxwGEPw6/eeMwMfHFOREy2nEMb10Urx/bjQa3aVo/YncbcC+NGHuPzCt/DkP/y3AB9+glx1sqvkdK7ls6coO1X7vRewlguExQ8ai9CczESUJMUsnqRxY4AZ4UuFaMDM6lbhsliEqqN8gV4qoG1tyATuAviJ95D7AbUaEnCnwFqMMqsvppGsbLBnEYDSNyRA+w3ZFpW7AKqeKHzcLrKcnG7DBm45mu2P6D2x6ldMZV/JvtCKQRr15PnM1rAB2Lu2sa32eAoWd0JUtMU6jG3+DKGwrPM5uO1+ok0wyPbzxq+aEG9bU1FN2mBw0jNom04fox9XQxCgiKcd6SQRjApeCuzlDMoSs0fQDJhit9Ef45t/DjCyUZ1gt6/bRpo9kL40JgNInJhiitQXZqWcMQI7ZZLDSaVZ698B1CDo72Ous6B28jc1Wjvk/uzW46/BZGbtc5YsESS6/QPsU5G06KACyvpT6ciOjlpXlS3ZmoQVRcaiZUh0mc5F99GqUPuyDVxDJIcRNW3otNBJYIQmWdikB3r2NIR7zFkaJDk6MimbKf+UvCvrRVncWcuUWoLIxs/o8xRILxv4aKelfibdLHtVfpZKQdfugxxzPOWNv3v3T8+XTt9mu9XvcVEPuZ6+SGaLd24bHCZIizF2OavbmTziRdNdmUGKKogHbMIYcgQBaceAKfta2vNJh5Rf9uF4HNLDVsYTP/oXFjmvMH+pWKz9AHGq6StskkOXktshTsIJjv1hP+C1P/IHgWWspL31Nk8vtdeVNPuk75iAA850LXeEg66wfN8NjRZ4mSA9CpdpDsaTieRR1j58Uar/4eAiatvfVz+HePdN5Mvn5cGk21Pf6SZojXWnNr3JMdAVOJmoh9olWUsN565xBveia5liTlmdS4ASblMzZB8UvgnR20sKYPFjK8qcHufulYBuU4VKBr5iqlxItcF6jcLpRGBVRMYRJWOUTkO3QFRXNrZibwODd1qkn6fCiubDI0cCWJ2RCb3nraHDhdyUn65/qA/BWhLRltnwgJ5Hv+9kVGjr4uqqb4hMTM3lHDTgmUne6GyQTpJNvjKAY7pVEouUroFTCILGAKHMRFz7ru6uK16L8/Atl9Mh4BzY/xYthsIGAX3QINO0k5BdZSyd6LNDqfnUeldfgU1DFn0ct/dp15iONMYwRIFK66IiI9VGjAicfKJujIzcqS+UgGh2kLfkXcm+vIQYzzIT2EBIkZ2FaUQMnsUwdXIeNS2pyDWWV8gYOmU9HgkDyP2WnxhY5rkNQDUNOmOXMWS+MyPJPnIcBjNTkgIJsmS41nTKeslPEjDwRo5f2mUi9mTycDPrjmYTgd6UX6iQV+w+L4OT2NRhb04YMDQyOBxYQvaVjoaysI0jQjIGfgLPKU+v4gNpFaigk6enMXA88KJ3+6Te8cAKUkfglbx9lCxtQCNmr4X94Se4+9u+iae/51v45M/8JeDZa1qClxNGuT+cjJbxJlTqjIeUXIyEvbPL8NzvSFUfDGKpTE065WEBNFLcuhSDaSmic1ubJCQA3F2AH/+8U33XDcQ4jTgpmNBqQ41nH/3QINMDnzKiNcNmDIVIazdk8AB9gk4Cut9bERQ9uyBDei4bzq4EoK1iLSJrjkvKPJCaxoZZiF7P5hI/t80FquvyV1JkkNIBQ2DrMBreXohEFSCRHknaaTpN6x5pK+yxpHOgNBz9tJEiaJcDCM1LcJdbZ2RrZZtOBNkQ2cobAspSOps5yElq7/5mCYGInquXIIKS6+dK+Zd4JsNBepAfkpdW/nZWtN1OrdIAlYxI/TQvmD8SlA1umaRcy1UboK5JUN6aRjZs/lo0aFDTVq1wzYWVh9kuFr9RNIdzs25oO05AjO2xKsKBDW+1smRcuZQYK1QR6cLSomakQau662rrNgw6JEjTuAJ9RkfuLYQte5WggZXDpnmG8IQ4KuPf+kVjW9OjUQ7Rx/qCDjt7DiJX0yRPPAM6GothpJBA1iFeZLdOQGu+hQAAHHBpRVAOxhJJe/fKpEXABxJxO2RofID1VzXCQ25pMCMSaxVPGUAp6LzQSA7dHj5YGcBojKxxbTgzgeGEDAEGMnqrOdk+AhbJfOiE2RKc0tENIJjJCHNIWYCoZ1NdNu02pDdT/svcVS0YI3DjTiAuN0FObvOG+rHtSPHqEGWksHG9AG/8I38Az//0XwRmG1ICyktdTsTtkGWPljEcDJSjx9OHQaVtkWwleBRw0KCUADECcdA/tyPVJPmMgJcIQVjh91HrQLjfiM+/A7z7OnD/IPBpEitCimYqhZTKovYHsup4Wnit3A65vT2tpag3DnUJMOfeZxcYijDNrBYMBTv1xbzrmheHFLANgKZB6QYInfboMNaj/c5uhTEY315x2n0KN3rOuw2M7Ad/L3rsa/+8UdthBJYNfHPtG05vy5hkuvBppKAELIqCOJUUjQrU7WlM4Sw5oFKH1zv5XA4jx3677QjKEIGmhzCK3uQIJN9zlFgvcZxNy+lQJr/vdnvg1V58egpZK1Tk4RnZo8dby5hNX9VAbI2B47XMQDyB6NNjC6emBZSdwanTTtkH4LV0/n6ja+kpHLg4aBDb8qAttFyP7jP+ueUqNkZRLUVEGtkZLNNetB5HHO9OxS9g7HZp2suxog7wL9et9uC9py0HCHYXKLfJ6HrIcACqoOfuHO06uNLADjajwFhtb/NcMpMiamNKf7bd0KZ8mxyo5QDqa7hTyTuMA+Nz4jVxgP2eRzcD5aR4NjoyHXDiR+Id+tkXC6VYYHxuuuZYUhk1LsefCUXb86PDofcCSBZOEocQo17F825KQe4Y2xT+jjkN/C45Z7YlxEvszirTbrXM8lAjpuxrW/uUy8Rad7h+8BHW7/02nvzcTwAfvlB2vHzGMSY6tnvDOymIP5Y0mQsVr3fgK++y7bjTQMtrU/x/LLGCZ4if0SHpsixYhOBZ+BNArsD68ffGpMiebjvpqWl8zSgvnPukKo4vRnRV76w1JhgLyQMjdkXHnHhTR+0AOArwds8xJ/rRUaBnOsGSCpHN4PDaPXRLlNPbh0HN3nMfBIYNHrQEtJOj6/VINQr0OQYa0FmgIwXfNckysAs6q/+IMljBHfClGVRSMsJy4n9L+Upfdq+rcw4tFxJW1jnY2M6iGSpRMauiMhk3VTZLiAQENBQ+WQ02Ljd8wu5TCnOeP55jagkWOgJ0OE4XMrKMAE9jY1W89vvz2eH4yHhwHG0sQ9X6p5GnHIfGTqXfXi81qTSuKRgFONdB7xzGoPs7OGl6Aqyet0PBCn/9JVWaj/uGlzqAYlSUV2Zl1PYM50l6ofEBqiTbffIdQRB2flUXIJmb84SerenQqd1yGA+Haqwlu+DODqfW3enMHIarnbw2Et5JwJqGUenO7bg0iCpgo9xTZhq1Jq6K3kWfKV8W+xyGaTr5TU/+rpMtozFojCN3O218OjRfz83jKVJ1rcL16gBpGOHYdhR8RgO/jzHOznZkO/fCDbzSd7V3tcwj1bexJzVP0jCyk0jb3+euOTMgdS2B9U31Q2OMdOi8HdOye57XMoRyJ+LhiofLHZ7+4u9FPFyxLhfzRs9Sd6BVphlIZ+uBli/bXtBe8shy6lYicRdAV6tb0ZIKgdSVp1VY49xOsiNpVhNQa6092BXA/RXrs28hPvs68uFeg9q56wA+AW5/5VyxIgDNTAJee913C2/EBcitNXCm8sbgQCMUGi6J2QZzpLQb/29RETzdqi2QqE7Dv9bqyNMARqJHFA2ZfE03pOeZy6AbNk9Uk5DR/nd6nYpyXJoQhL8BaO1grD6RKrGONTyeblfLIe1h9pgYkYOAHqRHj5MyMq7GPeh2kKvmeGwd2ql9sOSR5JcGY3zmNdk+6zy46NLg1g4jEn1oWAtR81VKEpXJTS1D0CEO0VpnO2iJY3qclKctWpRxX1o6CMRxKhjjQOlZJjJ6TV1j6A5bRnZmLw85CzMLm4BR4zZS+LVLjaC4KDj9RvjFdlAZiSba6entNFrSMhkPFiuiD0YfdFbSDno34EuY6ncv/WxER5u04ZvgjI06A36OIZDXbXlI3ofR/XPtrDWufh085p8Y41VqmDraRJXxu56yttGZp6YPM40UMsnnkBncXl/bjjtlTGMbgwzjgnSIfAIDM8um9QrIIIYUBhXZi5Byolrno3lox+vEktAoODovD3HeofEe7PfOFekbpXdz9WLIxzqXP9AnC9KIRtFujZ+rjwpAeSiSlnZlX8ayWLB5UpHBYuMC6dA2avHJltVastOZrrIL1GuE9dVIb4OSHEd/v3/0IR79vp/B3U9+Hg+/8T7yUUhd55n/TFJQvmfwpGfXdDbayacMclkhEytpVKTRHjwFk+tg8u5DX9soa02HAG+QyZ3AV9/FXui00BVM95sehFGLmQxX1kUuTs/aMYiorRARZqhqFZr52j/baa62eFjLmQtGzpynNKgVtpofmY6gl9lRJP9LXw3bE0AgcVlkuvcjR/JEgP6mg4YAKhK4Xoey17B35gA41tvzJZqfAXDMfJLKmgCGR7xVdCID08DLgpZS7K32KTOKKRq1WRdwiHtNCK6g3j3/JHKIB6oS7md4NwM/l880t/1QbrLAQ0Lf4BpJOqRkimKgnOSYBhJK5xdw9onwCa19ujhtLCH0HFZmOQSzOrsr2n1iJAeAppsBQbsFMlFbDZuJI/rjc8pMDJpXJAnxEZh6wYi3o5U9nStH6ASNudxx7LFXfyPT0ZRgxiAnTwmCzATsc+vcAk9Zs4OfnebX6XUxZLsxQAV9OncevfXStQ7cveOsW8tfK0aR1cBM+aHsRS+n6QCaTu1iZ1f1BztW1BxDhjkXy3rRZDctZq2ND7khrfk+DPSSK/LVsirDbQZgZjJ5PolAYaTXdX7IHv32ljTJRc/RfB5Zi6azs4k0uDRk6TkQwz1yORqlr3VypgLAHDjJOg3pETojkLh2RmbeczBcIs8D1abpBuhkwiEL9EHmczKTlC/qw3bGifx3//A4qews9ONk7u+Rb72GJ3/v70Y+f464XEoHUXRWDVjabCayT5kNn93SBbrE9lnXdOo4cOeqcqZd7LGwEpnJC8TNFa/hFKmikhGlJxJ4uCJef4x471md+hcAz5im88BjP3N4NAsJHQJEXmUCvdMgKUTdT6aZrLZLAsE1V2YnWBsQG32DYDO9N8XyEiBGl8jpSYblZogJU/jKgpDj7eRsZlDgsSNSkUWC5MhjbgDjFypVz7ib5otK86ENdnvmG1QOidqNE8Nmw4KhKCmIKXB84KWO9pegiKqVMMlPVIqMka3Xd9WohDvpbI0oYZJQv4PvVcbBWaGSHXQBZGSd58DBCiKHY5eZ2iGSzQ+uCR7bS1uuWXXOZafFwiBSffWNgA0MZfCionuKp27AM5zxBEYeZgI5UUy1bCj+EN9cOFcQy1sRaSxZ8HaFUIN2w6ohfWXEy1VmbenrLbzR0SKDgSN51fyvZwjKRqmY7Dwi/jmPPcZQsreEP51AacfXS3XewnXINRmdjMw6iEka1jZUJEROXBiRXCZwhQrJ3H5H1Ow56Qj2PNBLfqofIWbObECDMkLbpFUbot9tILTuT3rmFThSum0EstxhjpCfqUS1x0+85LwO2rasqNAwzC+On3zJ7r9VHDyGmvkmMWSErsoSK1PopVFn5s4+KRMqHKTZ6v+tCGRvB4vLgi5T6/7s0Deepnck6CYOyvDAH883zeMWv5VmLQBlNJmx9EpUr8MzM9f4qFMFiYMRuP/kOR79oZ/F+l/9G8gH0qF0Y8qwjvxO68Pi+QNNkwC062aSW8vmAd8Vc6Thl/flMyXovPy0fi3EMX43dtSzD1fg828jHy3g2utIXMdLEoNtMXrqptp7L2+xJq4CFFcHtYceHgP65LXd501z2FTkFbrog3YYmU7d0ysHz/kHsK9QZoNEbKAt5rWQDXDkNS+g0KSGV7TN9EcB9SkvNAr8XSRTJ3yRM3ISZCxIxgaEPY++BdAZBx1pm/UZjTcV1wpgLUiOK4eA0xga68tIkIHaygJ7nvWQnTJWZDcPosdNI11fthLQ2+7oyywnv3KIaIpfSXpqLIMJip45N0Z686AanGvBnJ6iulqjn+u3THEXzehwcAAYfOs+57G3ilChtub9AFxP98mOMD3JiZnx6H/bDGr9lYQXTUnCuT6ck77RqVCcWQc6YCNyDFQUxroNNd5j1Q1yaWOk8W7KKbMcobHybzAivrYjrzk4I8EliCo+HDp4yKXnMCy/9YPfKWsFGUVnUma2J7R+XH30HOfYel6iyaZzBWHLvu4uzt2utZAOpOfRql+yR324yQxRtuCsi56RPHo82bKSks2r5I603dd5dsrZxu7PEoMn/X3OiGf2m3Z6Mj9lDkMc6W5Ns7M5T6R0ibtAGDH7jVB7wssmvnGRn6f0et4A6nsnIN5KNtn+biew15Kj9cKA5xmVWC3g+Uvgq1/Ek9/7HeRHHwOXC2TA9N4xe/2R450sHrc8cKkcAa/nJWobYG0jW8ObGQxBU1CbNXttuNckLNSQAvUqSz2+FvCld4D90KSnIlZKuZb17AnKCHP3A78qFDe+h71uRGDvqy75AYVXUQqlhx+8SsCKOASRx7eBmkcOBtSupO3fk1EaRmqnX25aalMbgQJMv7ZxZzZmlCdH038asBhfMnIFwj9TtkhnRq+9ZYbrptVee6ctJJEjUjjGkr3cQqd0ywtlJGePV1CisSbXQ4ec6IjWbpdgxWyMDXxW5odtyfmJAqd2RiQrLYW0wkXWxFxf910XzHSE5LP++Exx6Hm2QbqbwYnUuqoFF+It5VU031FLVMmuQ/8eRzzDWZvoOfH3ioh6/P2skk8BrWUWQlp5HFmKUgL9kpWrU7fIupRrLfiOc0cXWoMcWLC6VWV/RjRX4hySq8w5hg3WPezNMZCGOeYFbGwvZWLr4is5ygxisni2YwN7iaeM5RZTpZJVfm86SR94KMX2NeVOaTf9Lks4w7n5LITogpPSATqcRR5mfTy++iW6VohbuSQwDfTGKzo6CkLQus7v93DuuW6+op32EKQrzk2A28vkTF+vI3NUJoar4HqeOk6co0O16or1Avnqk/vtqRe3SwbEfCijksjV5y9wbMQThNbnQyNrJxnUbcueGycvqRWkX2r9n5mJnd3PWGMv2gowrQvKviTWYkq++nfk35SleMdCZuDJH/55PP+lP0c7LecrdDteHLLHw3CmTotmnVEs8zCy85m4q8M5wI9KIehZSkkHuCNa8XLMV2a9BJaexv0V8dk3gWevIR8eDMQCueU1vu5OaxkSgJAO2ShHp0vLMKC7wx6V5wTsJpA+3yMNF4AOV6G8wk4GjZiaGZjPn2UkIpB5Rezl4r7GC6ZoZHC6rbW0Yq8OaHiriejCRAj45VmvaZsbXDRX6Ua1vq3crgQOZSBIA9dvkuDzmVDjMamTY04bVhxBd/FZdIb5mJSXaKcy+Ub3TwFfIBEdpFk12iakHK9beQQNCwkrR2vwnM4dL6ba2wdIWad7zg0SCS33yHFi/wPM+Wca9p0bcbnIPlt1oWhJf9h5AOcBSHQp6cRx6SKONjHGKcCSYWoeyZgPGg/0S/1u2awRsO8eY9L5Hsa7pxA5ls8oNzl+l1GZms6sSIznWvquu2VilUMw7smgo1LYVe+HnGW0QQrpQ0AMnqoLRiIsUDzaJ+/JnoCN6SErXhKroucYyyk1RmnMWK+lIV89LJ3OydHNjEXTFz1nGbNweh1pJ1k6zGUFytMOILbS+Y3WdTbD1J3Ggozofe0+vrfaI3Z46dNLfcygUJ6rT1vjhM59wOiLLTM4yJtXeiKKgTory1NWywHjs0UIG2mPW7hGXYD70vXZw4nmT8LIjV52IJuMSJQVF1/XvFUYvBauHz/Ho5/7Jh795Bfx8q99D/Hkrt5eHuOx+y25xBEYRJMji/GdZKH/3E04V0pogKzAX8qR0B3SyL7beUxcINuD/fK7yEu01w4DBQ2FcKhgvDuENL0R6/DywER1iPGaxY2M6tumfK5QpC31zTSDKEAxTHYA2Dx/PVyUpSpt98N1dRrfkkMbJOJYRK0f61hWCS3gOohQtCrgK62pZ8TLQe9kNB5KQ1KNd0fxq408qUkBiWD6Lyw4tnwWgdBU7aiIpxQmGmLIYPbEWzBnlHPqurQPBe4W2BD/Mzdij8MwBg3IfNcijX50iMcwMkm59TtFiJLHvQOxhuEImzaR6JCp1PeuOhZzLS7cspYpUWcNA9oRLyBm1qMcGStxQNwSMDV9Dlr4SY4ZjASoh3yYBgMNXJJjy2DbHFYLwE+k+qmOV8+xx91yp+Y0BUZH1hHq+1wjnTqds5E2LDxUizUVwgQ6kx15iX/DYQScMg3KUmYtQ/bcIf2YfC2ixKBr/ceMauOldCiGM2YcdJaqdTHNq0Rn7yg3swhp1IPUVDsDoou76u8OOo4x5HjpnZorcS8bX5jVqunvgwFZWePMhqOorAt1YHNHFp2Ofk67HKr/OKW4g5kF4NoyuDq4YY2Ibc1RvCoFCs2RdiqDhXKUHbYxAoUBHrPOwI5F4dCetSqcx1pyloo9pGXaKesgbHfGR+EpRUCYGojrPeLdZ3jyd/0tePEXfwl47ZnkouRoSKqMHWREfAiQ4EV8k8637N9RCF+RSdGjIDT5ZkDFckomtNEp7yokAPHmE+DzbwEPD+qc3mplGgB5/PQEutonM3wqnuQ9qvAqRyFVetCK8k2LgVhToDkfT3QCe70fGtaEbRobVx/788VsCguxYKFoohDdoOqipPIXU1T3SKchbKCElxMEB8PnWtY1fVwlZ7WWU+BU9lloxqM0pRQ33m6MxlivpMIWzpHtpkc8MpbQTYKC3WyFT7+T0XtWUzQgUMnho8Fg6EXH4hhOG6EJWldGfp3E3QbXJA3DMpwtC7mHFNCQ0U5gOBt6JMD9+6qJkBL26W/JZY6Kkbj8pXEknd02GklDGGRPMyGUHuW8K6DyMpPSsLEQWiy2PFd7GiyYym3YgbIE7ZQ4imy1HSRW1qxv7or+OXlrplLpc/iJNSPqOu6sKJlAshBSQUrzMFGZmoMHV9CT1/QCku8D9gn2lFWCbPOM2agZA0UDaIr/YylQ8rfV/hwzYKNACmZuZJQE2Jx3e2O9lgxJh4+eDUtWbp5F9FJMVzMx6BCPNF/3Kj0iripqgZJpcwlAd2Ls6SxFy7mHVQ5hCUTkch3P1LmWPWH+qBFLydHpxE39Pf6Ir8MWJDFzDZq1yxYX4SOdOjsvo5YMQ65A+SHezyD2tCtDrDQuOu+Um9XOwX7+MZ78nX8rLv+zf63OZBj8OO1KSmYLJyCb4NmzbT4HLefdYQoCNDqtoZWuLkW9K2qPvaKSAfDDbtRa0Wc/Azy+APf3tuQ5ln20N+W8kzt2n5C+F3AJp134bEzQTRH5GIZz4DVOGiEZJRo9Gw0bbUGsWiwHsL7jue3UUQpVci0eFsiADTibYzUACGxpY1g4xx2nAF1mptB3A2LASiswINMHONseJnJfoYORIs41x6ZpNdNA1UQpPAnRdK53KYqibkWW4ovHzSuEWFICW8AXdIY4WoFX82YFFEHRC+5xFVBQqDsKaJrSdErGBqBMnjMFyMi7pmn6iy90SktsakZ0ZuSgTOXclBxJQ475ebdMGbKt9ynAAywGTaUHdEKGAxnwXuV5mtvOcqaCpfTJlDSUqmaEc+71qDZ5XoYNb8vTKJbcvbzh6ndPJhGVBODKuaIY5vKGjvDQlWCcsc8+GfESyMEonYQzCOr3ITtBg9Zo7p0kJQNlXIfek6OMyKGvDKSSKVmFomU42nfmkrgTnHRTyFsdOZ5AekVkOj3b9fUyBYQAkDcUEuZp+mTBuNH3nPzmPDGAK730QSemI3IecsZxyElWdrMMbUXhAVdBSYnEh6rpcFYlucYe0DIksDtpNgIbBXjzc9JqZuu4TEWh73c6a704vnSf4FI3Qs4l7EMUicK72Dj3guR2tpm5SYyxDPPPmiFhRKnU/vg5Hn3zS3jyt34NH//ZXwPefKyofSOPtuTEUlgC0KV1wM3301ME7jhQ4YoepmCVYBPgdwuMUrM5Jt3PI7O88vfekqKuTssxvZfb61ghQehGli+zCa6DRyDz2nVNdhbA1BaB8ggBbZysucP7HSBxGL32cnVhSQP7/5+vfw3WdcvOw6BnzG+ttfc5p09f1X261a1uSb7I8i0imDi2cbCdyBCsioNTSZHiB4SEcCsKMBgo7D9Uyg4EV/zTpAoIFYdKhdhUuNlObIMcUyhOnNiSbGOhiyVZcrcl9VFfzzl7rfXNwY8xnucZ89sNu3ufvdb3ve+8jMszLnPMOZXOAhUDGocgowE2O/orIaVRlo61cHdOLKBTp6R0msQe87IpcaFQDCFNz216NYAzMyNlnth1eU6aBpqvgIn1JRZSHhh0ClpA8MMMiAziiEAJghQvAjBlDYFUAagjcWDpNqtyNKIdCBZ2TUeK2ROpqWhK+iQYnSdCKEv+XLsfK3WJdP2+Owwq41ggG53R2qiCOQJpVf0uG3fyj9SURcco2quaCW4r8hJcDuNkWpR8Jnh+AKO37MNxWCTDCFj6LaMPYHdx1xqH3IA5W31kPq4lPa66nRqjKdl0po7F+IxyIaPJI7kpF/UQsxCbNUVsMFjcVWMRPpAyDf5cfohw0d7EDf5hpBqRfRb/wLZe4tT1xAitW9OWvFaI24Y7FOkEExLGLNKSsiq5BWqHR2c7KCfDQBO8svGTGZ+yzf1GD47bOImPVfANySd5Kudaa/FtbDJR57Z0NbqCHUGXxsIt4x2mHEuf1d8Yu4K20i8GCJzxecLrDKnInwHpiJGub7uxvQSjreslHM7AcK0+5nbK5jkdJRZ29xg2cTFMU0bWiegaTwp5zzPXcCakoOI87YfqRDJwyUTe3eHlP/Qb8N6//+OIeAkHSoANinmlg/oodbEcEIAOyHAOkbgTkUhejhEJpX42PcYQYCj9RQPfZxdruebNB8RH3gCuzwr5aQCSLE0Plld4ai9rtJxmIq6dDpyFQFAcDXpiiZCXdP6JMbGZMqFhr7kmeidAQALIZ8qLrcxHcO1LYJXAukApSUbXCRm/oMTKz9nggRoAHYIea+RrgSuF0Ic8oJ0oe+Bo78XV6OYRPeqqLaAwBrQ3v4GWhoyGgp405+pMwVy/o4Sloj87XVYEFlTt3LpYRwnPWaS1mYVhtS+dJbNRdGRhXVgpytGMAQh0d+wTqFA1p3EgsVMjm0zLfbWS7e0oZXfUSVC4praZinuZKsTXfuED6MJKHU4FI0PbmaqlilJWG91i+VVyJlmhAaTcJMF9zDW7EhvDB+NuFGa5NK2WZ46x11az+R67o93pS+UA9TbUZqDpTPwB9W6Ap2SQbJcB9Xx1QBF5fs2uTUJt/1PKetBmpOF9bkfj2+b6s/GOOqJGSLs2ZFxrdlYuAC1jpH1RYZ41GjQ2dG4CWmvONpBlFLf7n/KAzu60Rnl5KrRjgnRU9g2AliRlQFL+VV57LgF/RzsRCeRqOe8iUNHQ+MNW+bnW7YeR4kIfC7Tby6qZtLxpyzcAXR5njomWFCLvj285yCQJaz6zngLp4KHnK8ercZoOBpmoMCxzxHATqWME2sTifqd/PZb1FM1D+hErsL/xPtZv+k6sj76sI8cpV5o42wjjb4+tAu7h7E485s6vtXCnl6UkLZhaq4F3APZg7VOkQa8f4CER8fG3K/3/+ARc2hkfhI0BmKUDLvbSsap9ja7WHiVOFJLuEwszYljok+FoFLR+E1AWhF4GUmNDK8Bhlo0TKgLEjLRQQIfdR+zeYFwpxBAMTrgZSadBx4vm7LcBagPjzOQGxjYSYx4EYwkeHbLuTwrMahymIDvypmcdbayMVo549uDRpkChx8d+Z3pP67FRqVqRwcYq+z/8mXzVnuE9TPTM8ACj4nYJc8HIAnGMXX2SrklRGul9zxrOLrlOJRlND0WirOikymUnykbB/WsKYy1ekRVbFGYQYPWIDAZ66SDavVmLRZGk/Vjrb1ohElvpyvHP2GlRl/iQHtEFZAYBH7Xt9KYyT6I7v8imW4DLWHKc5VjcjNMWSvOO8UAyW0bcYQEFd9W0MQ1OKd1mBI0ZhnEZhlNzsHzJeAyH5dxsscfU+UyHJ1XY0fMnfdl3747pQW7KLZebOOVrjjGNrMCI1iWKod66Tzrdw8m6orO6vaSA5nPrCq6M5ImE7cSQcgOPaCfAZZWWvxStzVOqvXdpze+ahm2ssp8RX6IziSBWGT9khrQcqdNbuu1w5gNQ1lG7n9o27MZQ3iczEoAeB+U2afRHcAQHrxwYTdyx/ElW0SloAzwzScjE/uAD3H3+k7j/lZ/Gqx/+OeBDL3RiK8AsRIjv/CM7MGxazWfsrW9a3h2ewVZsbpAKqFo5qASi/wRjUao+/cRb6qun18DTQkxha4B0AQ8w1/MBniY31r34O4F4MCIwIvghbCI6B8TpyQowhT4pOZR+0Kmi5rQQ0AB7CcY42JPSwTlp358CMw24o7OTTpUagp6zbea66pgbh8ulB743BpUqEtyeE7djih8p5VNotwmaGJP1eFQdCPK+cjUKNkoSBxgaGCQ7ei41R9LZzkq1w5qRjOxCqgnojHwIdq9nBpi+l7EaExIfEZCDA7h6/9pgu1DrnyTVNUekscSjonanJEW6hG7pkkOcI5oOpw/bECpCEcKm+cu2KDuTQdRfRkT63MY0eIrdkNNsp8Y0SWMB0iQnJCb03ASjMbSBkqtp6zM8CtQsb1oyawrGuBOAelh8qVMPWaCWczyUtz34KH1oaSCuZdNSJ+21wSAHW6e4hDTdQNmdvbt+hSCdlhvRtS+N4hkXyd0LOfTfY6cO0mwMS4NifY2TBcp6DtKIFhXXX/BdzlG43Hqcw1BaTt3m4HqPt98NgNlJYdfhvFP/LDDKRhEFp7xQPyO0KlXyuCQnAo9o/mUc2YgaZwNRXHS97xjNcIq8JDrzb8TDKvgWCA8Hme6lnXZH+2Gb11ikmbTOc0mzGYr94h4v/sFfi1f/4d9G4IUylyN2lkvhZQv/OYolLS0a2x2KT4cgca8kAZOml2VFIabZmMpQ7US88YD48JvI5779qk8jXUwLBcAtKCuWtpfMg2b23lUHQOWXRx9gUVgurzPlnEJTxjfo9YxpH2no087OzC/U1HLMa7RdmqSIcbdw24DNlCEN6dwGxHRdv7N0jEb9GyPFtCm0/lcKQ0ZyzD0HORUtjAvOAkRHIxKgzWNiW8/2uGmvwUvCNCIhAzhgA9pCluAoxGvRbg9w0brvdEzYbtoOtMHUDgDK3XYEL6E+jFYrhozbBH6IH3QOldoWadlSDFkAvOd+y+FQ+jsYRVIeF3QUbwJ0IjjNLVBjdyk5nY6lCanBy/jTgQ2gHCE6A+IdgQ2Wiwa26OekBwB4lwUZULLQn4cNVM3zNEAa/6Rn/0ys5BtV9R+ursa1I+CW/QwcNS0FFv3zxu4ImRlKr0lu7wog8I7xOdBos01jEu1sjHkkz4KY0Sr/yI4fn3rtPzCCEMJ00drQOXifieilH9m9Yx28HfbY5u2gfxnFgSXcTtcRdSS8rZTsPc4T6LFTLjnJluWVA7uy+q6gn/jamMhGAsduLcpL1WPUXGhEfT5EStwVdxE3SShave60oD1VHMgMRMSlnLNevtaZD9nnr+jMGHGu8Qg2zHS0h12wI9juZc/JAaGGJrFiIER6UrdqVXuBt4nyYjdmby4B7FdX3P8DvwbxoT8HXAnCLU86QyFMMJhurAHysksKI4mUd47urSwuEjMRhKWBEZWOL3ST0gbefgP5cEE+PYJVrdwnzcGrqj0TY3OogRmDESa3169ldZ0617YrVnQnjWdNuUDDxl/8uIl4CJA2AhjLK2N8xJbk+h2VI1UARMHVRQ4DxwF01E1p5/pVD2/Tq+8aC6S2e0XUOc7zkAlmUmpQ9OCHAAu8SX8KI/cejq2ATJMRTOkkOryTNywaqOs+32DBc0Nqy07JSTYQsAkaFYyIx65E0ZjC70pWO163vOs6A0ahqjDe5/OtxIzYfF+Bv2bmpjc8A6vGUofPQLYJ2dE8IyTha+eod/JsMngHyjKQomX2xngfBnSNKI3ZBUaWLDpLrwMbREclt4A2FaWWsaSKDhpEZzGiDJRsVmbPwaCpIiMdg9ttjCU4UN8A0UqFqEwjE+jp9LWHmtetNV0VXgLQ+qqOZOVyyKDN1Ok0xrGuKu4uYngFjVv/kpBLsX4epCRRFK0z89QOzIpaG3QafqkdHrCT4lOoVqXElvQgjhojA8SUUHvgenkCiauyTbKqYznHDkjTBx1RC+KcflcRcmeJE4m4LOMV5b/13sukYVp0poe8tTno8ZDt2v5JrHEmp+o/aGtSAVmssKxgEDATrBuo+ql2YiPkXPCdRYdRuN6yGmMujZmkU6xqi/eEeAnW8k494/JwdIRNu0LdM83bsVkX4P1n4Aufwt3nPoann34XeHEvWzWLBuHXJStampKNVg8a4l2lnxy5BCBPW+nzcaRoyYurZCPYJNNLCXz4pYR0Zr34LCMODaeF0L4vGVgvs9iPBAPoTfMDplu4juQlBRdjLRnpGIy24pk8PIPaFwHAwtn6HVQ8osD4mVfBFuh0Wp2zyxsj1FqgTMtYVyY1Arvi5dXe+XPiek3gGYDOdef4p+CzqQGsahkuEqvy9XnkmCd7qa2YWP336uK5Yfnq7876fqPeuTSobkA3mOncgOvNmMN23ZZX9PewG+SmJ0Uv+HgOzb/T6Ngq9b9UGAIl91gLGPshLScQcdAnBc52OBeOP+uZ5TMfeDa6C57ynCfbXbfj7bGNezoQ16paz/Q7k9aADUJsf5/Nc7Yp5wEeO+kKAKvfXWxv0Ej99ySy+ycP9/hefQy9WQu4DDkUeJEucegh9gbPIVGqkuwcZyEUnZpWsyBzFP/5+e5jheenRtne4HuOzyVOad7xC2IIr6abPJ+CLR3t5wQ2MN1u5ZttkC/eLzj4CI83x2e8al7ZEgw5zHNObGNMS8+v3XoeiLuKrC9RxzJvppzbSVt0SrrWjEWT5VxeZdC0EwkbGV08thJ1kE7fETF3DqERlzgK6FIcGWY6TMqcADo0itnFQTtl0Rq1c4c2hgSflZwGaBdt3ziWku860I386UAu2mqSz8QOhG1WogqP3/4Q7n/9d+Hpx/4e8OaL0rkGjaC8BEZARv09JEJ2rzIHNY47GVLARG0GMDJfqKiRe67lvYFrsjTQ5RXiwy8lPMw+uPiu49UElF5vA5VTgZsgdbxpmNYUXBpy2QISAUp/REfBSjgTd8LEoOcZw0DsHIm4pH4OgOMYr+0Ja8AhHKgTNenxt2jmaFOknksGUHSzUAejXDNxfQSu1wXc3QF4xtsPz/i2NzY+/uKKj754xEffSLxYG89wJHG/askF0ZiJVb83/2i3nzedpY2FwN1K7F5jrcCg21xd+rUT1whcdyBj4f5SSnHdiZW1DPu8E/eXwKWjMOL6RvkTCaeeM7vnVq77FVhZYdlVi0/o5ZxQDEaW5DTSQwkJKGsxy1Q8e25bdGn5fR4R2L4GLos1DtmyU/JXkRxwR9+3jSa3BV2aX8T9rqq1Auya5zWzbW8VjV6idIAXLVNh66rqjevuOa5KGV5oY5uW1wSuO3B3iTqvv/VjZ7QfwOuoA5f+baPThyjARssrUBu+llS1BDURwLqIvjWOlB9Tt5r1dwnwop8C85rR3SVwiVpDf8ZqG16R0SUYXRNtbGgvK7CYGo+FfWValwar6P3cTsUlUn5fYQbXobs/hC5KSSzsTsXWOyXbG1z7HdgC4NJn2SdHmQlkRdnkIXTSZjnrqyvEd0I7iS7tuFyx8Jwlo3eramWKpkmXH5dL4L59mX1NPCFq3Kjz5e8Dcrg2AteM8tkBnaKYAVw3I/vSMWXVVnlX2v2I6PPuIT6sKFncCVw7W/C0F957vsM39wO+dn2JX7re4xeeHvD4/JIV31j3ifsuCKZ8xR47T1rGio2jfoe7XphxyrEu3hoyU/URPddOiW8JwOFm2aFBKZDvi2gdSDoJxA8uqdJG1ERypUZLkyC/EK5XojOX/Z0Ojh0mzhbkxnlre7OyLmO6//u/G/Fv/2XQXgc7HNgHjjFGtQgHKQcBMD7yMqCELitoHwhMZ8RglvpJejzhYBFl8PDWA/DmPXB9BtdIagyp+S2EHHFvkWPfY/5jwaqYszSQ1UIVDcAUBO1J7gIqArfSWz1+Ukwp5t1GZqz3riaixY7scvooSI8j1YWD8EgfkuJUeVkSXt7BPwsAYuP51QZeLcRL4Hs//gq/+Z338H3vPOF7P/INfPfb7+FjL654+y7xcLkAlzuoSO9IUUyhp/czlACkcQ+YkYbGwznt8TM9nG5rgcgBuloEgIHCHgubTspEQulpS1pHS2PsXOOcDhhz1rcRI1PuUzNJE3ng4TlxHIp4uKxEr/UGSdguABc8WVbFB82HXoMECUdRIeczM0qybqN9zj1v3msSlrXprMsR9Y2OB85gbA/TvM/9i93+BJrBkxkt8rlJKLU15+qU+knIGH1M2eW484YGY9yy1Hvwmc1GZ8n2zRzC7XndrPteph0fz85qzAifxX2Sp5vvpiwc8g6PJXvcuJkf5XMNGkmXh3zPz2foyHciMZccZhDyGjaQLVMexQdmu7q9ltWNxPt5j6/uF/i5x7fwt97/KH70Gy/x//r62/gb738UX33/JYCNu4dynjdr8DSlAl4uL1U2gFfbmmc1PM4BSv2Xmk4MZYSbyNXZAF4OhbYDMxs4lj8Aj03LftyoyOUGoILS1XYkNSpDLOl8WbIvdLSmnfPSDWrbX8LWJkmbAB5f4e57P4/1kbewn64ah5eCzC7mMmJgorekUxwqQwP0XQA8gpO8lUKpqAjg6WqSryamBLbXffD2S+D+DvF8LSEti2ZvJHoNGiT6YFwTl8Rh1KxCPeFa+JhgjqtlU2tCmFSpiaWU2qV1IuItF2d7WaOjvnPtTaQI7ldngVi7CrwzITwM4VPWtbN0CFYL6PM3SyF+5cc/wO/9wi/jB37FV/GbPvENfOi+J7+z1i0TwCPwnHfY+SzFLtZxfKtlKTFPAcvmCAtwgtRvXh1pJIJEhneJkJWgRE2Fgp5B70XlFksjjIvhpAhHLmwCT//OFCyXLQTmo8kJWHNMFgYgrjeGaoAgfClVteOx8jk6hDZCUF/08oFyQl0QCbeRONoz2HKqnoNlhYYGkmGDmIhY8qftmGlc957EMYbt/tagBd+fNLtxANQll0AkI86H1dPXm7Yw6HlQRTIXky+aO5/inG/baH7f3tExIz7SpNvL1vVDTBZ/mDRs0JYs9k4DAPMiNchJAbz7ounFWgaS3+wUxk25JzbVkk3rZQ4DduzfbxkltsnWE0eJkXw65c8oSB2f2xlUaNQPXAep+9AoVMblrcsz3or38e0PX8E/8OJLwMcveALwU49v4M+9+0n8W7/0efx7X/8Enp8W7u+vVROxQ/vnqVEct+RVQMOsQY+0lwsXyUDXQAWAbWOmrhmwzATqCKjXxMOw8QWXa2nIuURM3JqnGw5bhewkestEZydUqNjyEXMoglobikRgf/CEu3c+irvvfgevfvhngTcfdFbFqVxsiAJeyxej4Rv5zLoLIFeYQF1AtDSdoYhdnTJFT79kInNjfeRNGNSiwYpK3uKadibse4Xek6FKRu022qoHoHHudshEr880TXYXpjAyP/qcBOQxkIFjGyKdAT1p4GUhUbW3O8+V4PYvLyWUAJDpuq86OpUYVzx/cwF3F/xDn38f/7Vf+yX8wOd/CR99uYEnAE+Jx1eBvQNrV+ovmuYrnrA4Dg1tXMM66CriTmPGSt3ViV8WP2lbC+cKtzNt12Kql3whr8K25gBiKissrDyfv99nNSyXhGpvcr1EOZqOSXRqeVTSiB466lS4NpSkJ1HUG/MVShP8hyw0bWpefeRwp7PLXwjZIy2v0WATMLJlhDIkEMtWeoCn3OnCFoxrmulgUbrakPuMjsH3Nvau3k7NWc+purjfCbcpmZkqjai1nlzSN28JpAHuDJfmNEEeB64o5d9RdHCEXaxazU6DRIM6HICJcbSwQy8yIedRATPn3N3n81hawODfOLWU9FOaVwViy0VplBfiE3/f5J2B+PaPtyWj9usj+hyANkzKjLWc9ZkTkwbOblE4jgHhIEJ/bomI8Rh5GcDejoijvsuo6iSecJVoly+ecb82vuf+Ed/zztfx33znZ/EXv/Fx/K9//jvwJ3/503j1/AZe3gGxN3afv18NcCkFVaUfVQS5M/pukCWxjGw7cimZOX3U5o8McAymFzurpqqtnODAy6HZVOmsfy0vUGcD5SNebH1qd4OXju0ENDFZd9FyPU8PFJ/C3x9OxfMGHt7Ei9/wBbz6K3+7HUM6E5OVZ7jhGhmO0krMy/x0DoB8d3qxZHICkb2dbLlYEIhD2DOBuL8AH3qJvGYXfQS4ZS/Aqyajz10OkRlwah3IcaBDA3s46locY1uCWFE7rUBHw8Uw0ZPFaJ1Ay+is/vA6XQJEP3kYinOuJLYyA5jn95dh1dG1myQzmAHAQ17x9JS45gN+x3e8j//e3/+z+D3f/hXcxSvg1carr14QmbgL4C6vBQQJxJPnDxqRMa4a/EKdXIiqh2ieSkn4ujKy16O40wdx5DBi3s6Iw6kqPqXDqA7IC4i8ldIVD7Yx/J6SHEhc+1looLOq3QhdmigDAn/nyMWmzvO24ZSx6S0zbGvu35/8L9vi/dsgEEVH/VPajrT1OV/V0Sg1BDuqA7Azr0cWSioTY51aRnaB0XF09JB5xbFjBzx8xn0M+36078wG+UedpTZdpQW7ZaQcEUeL0vBB+04uqh3RvGlA0SbTcsiktynegF8C55XTE5+GE8fOY8gJetlwZKb4qs490Qekx+IQZGKPeSqE8n9J6PPkQQDcTbFuQ5PosxNazlB1B9H3sZwY3INkdoRO9Cg4pvwwEp2BmM876SdblwNXF+sBQF4tt+yyD6Baa+ESdfJrZuC6F3YEVjzjd731Ln7Xr3kX//1v/m380b/zq/Anf+k7sLHw5v0V13XXti/r0ClQPxtfuqhizyx09BW6ObCBjkzLggsKE7wAK3lEcEDBj4o2vCdUWQS31+qsnUClq6ysAbM8DSo66yPQ2Yii656Z2NazmZXxamjq0DUA2I9XrF/zHYi7hWMNZayuaZl5jFl0HE9ljzHR5wAEaBaHcmeDYBi0k62uALhnnNHyTuDNB+DNF/DlHLCGxiJboULAFsqScRsXbwMjPX2SVV3n2xX9mSIsBbLhUICfqj4v9HY2hEAAo1/QRZgGFe0wnMpJ40LFcYLOgpWeHYiGXYaECzZefWPhsx++4n/2n/4Z/Je/55dxt5/w/MEVr54TFwD3+aRlTWTW0Zud5eShHMH9wYkzPR4t9MEoKkdmo9bH6MkmI5m8jrnKlmM6Spw3KcX2aCCyShGtWMMAAl1wJzkz62QMGmA5gAAj4Qb8dqKC/BHfU4oxl4XkiRvzpWTF375LAM9SbKfRhj1sb91B5wAq0qZliGDGMx0EvnIu/LPlAs4IcJtQNoVVoGL+Jg6y3litqMgnYgQA6XkBg19pEOqIW1t2g75Ag+yo7J6Wb6a0e8N4yUbvOqgloXaUu+153D7FS6cxUk8i+7hl8iq72rsN9sjOccCl956D7gtg2+HHJ8lOAWG7pV/ocVPnihPXATI36XP+SLqx2/UtMCTPcdfDXOPnkh4k85KxZKtzSW+Ovccf1CfKA7EcbjRpA14j5/npnB+aJgve4raW8BlrIS4bdyuRa+Hpsej4n3r5Vfyb3/vX8O9+9WfwP/2JX4//6L1P4cXDIyqKX6hEarqrgMbMPovvfcdDRgc2KexYjWebUTui+d9tgLrFbAztye4q2xi6PuSmMbZUkVmhWhJi35bfPGhlmYawwYTmP+l/gc4oFu/yg1e4++5PY33sDez3rz7ItfskFu1kGa/tjw+/G0LUc7vzmjA7ZsujgQQ2ZmTR7IhhAjKx3nxZBHxOCR6flyII6erfYkqny4NyT+PQoI8+o5+RUhpsd7LA41xMKKaYuJEmUgmVj9IVEBDQmDnReL03Fz1GG74i7s6OWmdql+DfEpC7KsXjaePp+QH/he/5Zfyx3/Gz+MJbH+D5GxtPe9c2muu15OuaJV+73o2dTjGnaaoZHFkMF0OFlm0oEBboCobauDWYj8WzETkViOo9tjMliuNhFMEK36brYeiHAcFsR8woQoujdES5jsXxebM9kHZM2NhcFUgz1ONQDyEhSOQ4Gjf97jSiEogmEh/lVkoWaoF88jLAjCoHeVv+zKmSaUZ6juTm/A8+peeAYEZsAEDC0WccVOqPzDNtKRrYITswsmy3btBrk5qD1meUVzRdZnFuipcAECuh887nH56IRraoW853rONzKUHEGi+Nz4PCmnwtNVQMo+GI/hbXPNfX9aNlVc4W59GyGN1fADo5DTmblESgDRq41KcxaXIUdugQorGV2/M9jZSK6bIzpHNVTM5DPx1AXlpOA2UUeWjSJZCXAJ4vyMsGLhfcrQRW4PlpIZ8f8bs//Ev4rd/3l/CH/8734F/6+V8NROJuXR3R8ljrayBXFwm2Q1n4wXm2fsBZ1zo0qU+0ZA0FJi+XSLGRtYQa3eZw2JgEK1M1ltck1nQ6cBzudt4KGZIj6qGWP7uNrcxZyVNiLjHWPPbTFfFtH8blc5/A/ptfBN64Rz5fh8PBLjsYjOzTmuN1vsNZ1zunKsLMtoQgOoJea6R/+7sSPEZbiXzrhfR7kACMLooeBt4QMXvtZBa2yMMqYtmjBnymKLSW0tRWH5gfZXZ6pdvc9oCn6hAKI3k7WHmGPECIhDt0bR5IougPmhe99Z3AHa54/mDjxd09/ug//PP47/76LwFPj3j1jcBdPpfhfwbwvBFXVL3ac7q93XN/DQ8LyIxX3pYVtwaPS+Ux6Q99Dz19wvtZP+FITYOTUJPPlClnHlJ89XOVea8JNavoNoFRoNZWD0uC9lVPnjDaz5jROuBqm/458Jpz4GgJimTnmqjX5SDHsZ7hkgl08B9yw6U15fCwylcmnihDUqJ5LMfOAE9AJgk5Xu3WBYnniJkHCCVSBeKTwzL2sCPck5Mh4MXKI584+mqKk2cCZejnRNQWNjrNLDRNj8VOimVbcLtGv8xsCPGKCIKKY2cFjCnKLMJOPnk4Lewa7ZqNNQ/JOzAPixrZZ8sPaEBGppMiTz4k5R61cWNm50Rzg7VY4LRk8WeMxbhbD9M406CPyKXaYREex3Yl7fudqzMQEdDWTfHZcVi/dK1swALi7lK8Wgu5rsjLBXF3weVS2YHHD4CXsfEv/oofxm/72Lv45//GfwJffH6JF5dd25A3Tzzsg9LWpU+MThl4ge1yhE/xczDATUnEv5Qd4JY/By5AyE5BusNfuKyG1uPeY2zsI+2OciRmhwAebGRMDMuFsp6aQTXSWxrjeSPvL7j77k/j6Ud+DhEPw8DaC6AsKjs6aDFPOOS/tQRAA8bhslhlpD39jgWQYAugUj5vv1HvBV5fr6Pgz7YQArkCIabber8ti5rbkFBpcVnIK7cTNkjvUgb90YRSbZbM8wQ3g14Oxun+5maKzSKQw0FRgV8z1HwkALQC7iopuYsrnt5LfPatC/7Vf+xn8P2f/mU8frPavt+PyMeNfNqI56zCv11Oi+xl9vgSWn+qatg2QKwzaK99BbqQZgmcCX6kDX1nrlduw71AfdOJYCF5H3PKdoonAx1p8kIa1H0ZhEksFcGMimSDWMvK9qTkjXdDvCSljEdIPgWCE8+1/DOUgIrnR/qz6MM2YAfleCc0fsjL9nwZgZKaPOiyAgyCSf/c0TonV0ZHZtm0DjDbWOOSwJ08DaYXx2dAAtc4iQzyoPnLtHJk3wR3PAAu+8wgsC7B6t9HShKBsUutZLNWgyqiozVVijWhiE7/ZdTem/bpFDA4bikb/mQIk1Q4SAK1bOgkvtTjoF30stPgQ/b4pXMcn0FMmc7W99cyIi7gqOY3Lw4yHY5YZwg5HTjjT9E8EohlJ3+AT8tMj28YAXGe7SV0kx1IA4Bb78GFjuix0hDutgcR6CLFFkba4zaI+1rOANbujMBGXp+xLwvrco/7u4rsH7+58AMf+Xn84N/3Cv/UX//78MOvPoaXl2dc82L7llEOwVpVsIoeaHQmhANfF+WmQJkiNmRnkFfhBq/2VqaLS02NJzxYiIyhLMgfWEtb6VYv7fhIY/OLekR5Csk96BpYT9ujz/Q701hfM3H3nZ8GMz8bzMoQ8Hu4wqjCIXJf9mk42pUcyURVJxN47T3Ru6Oxo1D31METheJ+AW88FKE1qaoGfs0bMlohehIW0wD2tU+SslLLkNDjJ7OSv+cgcjcvagC8GMYR/7dYRxQisIixLHAZ2AS0X3fMIbP2mbaAcamhpkfjv/H0jcSv+tjGv/tP/wy+/5138cE3Evf5CnfPT8jHRDwm8ArAqwQeE/kI5BPqtL/eUclDecgroJSQNQJNoGIuowbOfUcvIYzveoqSM7bDv+jPBr2RBmWSzCBLQN79TJg/VEIajG5DO9f4OWVPqUhmX+D1sF1jiN3goCHnCe7DuE9MJqgdrGQbOk62PtvX4iuVUucf0BmjgQBp0uPhCY3E/xYd5Z7YJ/yObXOah/vmGY43hpxxW2i3GxobSdqG+pqKOidNxG71H/pgzawbTyDr56JpdcwJkx+cs/uRFUp/MJeDctuRIJ8BqPal5KDmpKLYVvzZfxx8trxjjGuOh9mwbF1zQNaRomQDXREPTWwusRyyxN9ZB5Gn3CmDM/o03/KQG41zu+1Iy78OZKF+klY5adP9D52Pjd5hk+o7xBsz7jhaZI/vqPsbyGyDfAXWM7SDCY8JvNrAB1fEq2fk4ytcXz0in55xt694/AD41S/exZ/5jf8BftPbX8QHT8DCdRirkoW8buiYaew6cEraUcQM5KAhZaHe38QliAWexc6Dhrv/SrfVR7/f2Vg5intgxyBfIpG5j4K+PNrWSO2YUX7beWDtyX66lgPwcN+1bQTNHMszY+qiVQ5b13Pp35dJscRPIGrbxRpfMxUJqB5JFzV0AWC8uJdw3FamMyKjNEcbMq+xEEgSlRM7qHiAYKBO76LxYcYhwrUCikDh6FzFTPTXe8sbAPiaW0iBlbre+zwpdfNaJKg9jPckJBm421c8ffOK7/rwI/70P/kT+LUf+gpefTPxIl4Bz1fg1UZ8sBGPWdX90+CPjCa9wdXtYieit7jR6aifdxvy2tYXmbrIQ+OlcQIakHafv0YwCfk6IaNPnkNghWv2aYd2eMqxXh4zaZ909gxynJPOLwkduyGjUkM6Wqq/NIytSDZs4navAdZ8nMeBsiW5rYRa4sjRFf+hY8SxECDHs7ymU8VEFFo5Z+4fXbTpNcVemvGsteTBZYdSy051im+ONw0ePshHxaFAn/mfMoIgzQDxZWgKPwUAns1XY7huMqXeZfawZXAaW9G8nfbcXgCpMdC50GOtb6bvng5H1umG5FPMtvqdoKzyd7QTeQPMMooHEDvqonGkXPHkRAYPA168LEdMHIZEB4aRSMQI6pCWquhoNmZlILglcvAsZqSNxG5nRM+MOcqoAO1QDb5h8mfgOLETkM77T3aw3PhzzDNeczyiMQJPiXjciKeNeNzAqyvweEU+PZcTcH3G4/PGZ+7ew//1N/4wfuuHfhGvngMR1z5pOo9JsahzHk5UMhyDzpyLVLdP/CSe9ViHngunUlwuGsnO7kG3LSOa+wout2Ti4CNpFC0bLEpfGL/vtkXCiYkVdV4MAsDTMy6f/RTuPvYW8HRt+zzXYQb/iVHDNtG2gxgbtPpNiCVPNtVwUnhAo0pQSfUbO4E3XiLvuprSp1GAyV8yQcoiPg3GavBM93p9kcaJ09xkUVSqUJfb5JywU2gpyvCrEKP1YY9WMi/hmkIV/WN5o/TUIln/teVtxk7k+8CnHoB/+/f+NH7li/fw6huBh3iulP/jLg/5KZFPiXxGp3+HVA56MRItJ2yMnXvodyt5DNDOmmu1YTPI9CmPP6/Iywq9mBJuJpP+AmDauESlwlqAJXKJcQTvyApJCKHskuQpHW1rzDlIP5GOlfwB8aDYFPLGvcUxNbbJ0RpJy3Z6vjTyEs0eaHC9L+CCLZ4aN1LQ6MIdDSxNd46n/zkAlilmja+dbtJURbA2fX5MRlmTkJzn0coSC1S4ZA4ZuLTs1u+d1uQ0DC0zTImW1nu+t8EJmbfb+SFjsrNIdRRtOK2pbvKm73aAphcnnU45eMSRaRi1/JJ0XCi3KUNebI3TWA5ALV1Mr4FrbObOrEo4MgXhtuqVGN+HsxUiedqhk1x5XFreinGuE4jVnp+x7MYwZM+VGdPGei4xlDg3UExZIekPh8o/Cy931jncjxvxamM9XRFPz9hPT9hPz7jfz3jaV7yzH/Gnfv2P4jfefRWPz3eVCehzU3Jv5HUXCLUXRZ4hO8JvOi05cxDjXUReBpcy4ymV0yUWE3NEKsqrcbLYsVrHWVfQJwDy4DTyZ763b7MAof9SzoN/KTtPG/HRD+HuO76tnCfWJAB1tfHAUKKIl6Q9jxjzWQKZ7bXTWNH1ZlejNAz0BRDLupuJePlgYe5n2DXXybJBhwcqxFoWOAnLkPzhnnFsVfA/IdBOgl5LoKqnV/dRzWhzIkGh2y5ZZ7FNHh5n9WAvm1mDhdWn97HQJ6vPHsPKxHq+4g6Bf/0//7P4jR/9Gj74ZuABr5CP14r4X23kq3YEntNT7/lYuNCOAAd7AzR7pO9u5gJxIkaakcBHYWn+wm2IJ9uCjoTuNclBHyk6ptHwXARoLPY75jkYnAXMFWAwCmL7fm5CsQpphqWYh7kI4ACBkQoaCImBmhiBNSwbbILSpvQ0aTDoUDyQT90OdRWR5mtjOMHdBOPcwv8SQAdIWCNyvDb0p7+LFWCBb7GJgDSMUZ79DrME1k5iRNGcBuVgRlniES2H9Mbj2+hzA5QybWdt9zp9G3IuB2CQhzfrzR0+nv+pQ8cyD2ZbspDmS9fIRITnM+arIGQ2KNLV56QbszfODDQ/poOshpW707/sMQX+EE664+6DHy8zi4Zq+stFz/TPijjp+FB/MXizxxlIHPuUPuqAaVRY1XyeGYReBswrKivwqjIB8XgFnp9wfaxMwNP1GZ9+eB//xm/4a/hkfh1797kVO4HrtZcBIJzOHsNWvVnzwBpxZL3MR0CHG2W/kZ363x2Ze+3zzOqoTUqdlAHcQg2UrC70PSegM5Any254WnI3bSLcb25cX9xhfe5TwOOz5JFy0prk/8aQJVCQKDftLFp1egxhgOZWJoEfPSAMEO8jDvOtB2BfSWXwIAa+rEhzGtbtNcl9rVSKvuMGeBI69sA3JkvtCR7VtwTNluaUJ9Vjp3AEek0tD8auJj6vWo2TTSU7uSv9hgQ216PcZ+zE0wcL/9J/5ov4/s+9i/e/sfACj8Dj1Yb/FZCPqGr/HTdeIpTmKx9s2ZFSWJFyhtMOoCKf3TQWLZjqyxjeJw8bgdP7EqEiEtNX017SgEiIqWB78ChpoFv0gwaL8BGvAy3lpZk5j1Lmnl1nYWq8q6cm5epxUOHtNKQhNllr0M+MtVX4qdFWOk2efZLXHDNbpyxlOcyZDGSb3kyhDIBC01PHl5IeewDZAeYAIzjpZM9R6+noS3FEKEjvidOH0SHhhkPosXUEhjWuDx60EyFgR0BOYxvC/pJyXgWHIXFH02hR5oRLJ4hl60XuotcQncPJimkcNT7K/wa3wCl1PVZtIFmL8b4GbUPjgVefPHNfmDVN+pC9aYbkyIyJoGgRt+NH2nmXFSKPjWOAAzq9TN5P40g8GbwTDgKHA550yiYp4EPdNNAczgoN6bUzNY2LybqHR2C92ogPygnYT8+42094fHXFr/3wu/hf/bq/3k7Cc9kGLS8b7w8jKapSB51a5/KGTmHlZ7uPZJfRr/kvLCwev2wS9orpyIyleXsUs6ACwsQIhjezUnY25HSk50KdtXM6ArrcePj8JwF4+RrhpcJa9o1Bj+HgHc5afbsqKsB5B0gzUS8GDT/A08rUUiZwtxAv7sdnECoekSJ5o7VHMq8UcnUlpopbhoeDpMJb2PU7yqBZiVNAyvSu9qa3YorAbVCT4hOD4+0fbU23iwOH53j+LeF6wBXP39j4p37Nu/jv/IZfwKtvLrxYV+C5o306AE9bUTGNF8cw51kKZ4U2Vsd5fL9AFuiLM8l+87VZ4wKirO0/Olo67K1jrDAPlvOjmJ+rm2FMYV77Rf5YKBLjKxfK8TOuN0/DSK//xF/ySoVzbCeHU8D5RfiUxsE/YWoDg5aIgvSglJQyrgGQsQnOcp2gIuSc68c82jcQuwzYGmlrp4IT3Crknj3Q5Fh7okFaj+hZE2yDuIRglCMRSdJXPNsyrtlylnrO9BqaLVkI/Q7oGNSmF9DLdXx+Mns4UXY8AN0e03w9aknM1OZdQAf/dABnuxoAb8RLNE36psBoAEy49oYTPeZ6aJMirNftdB7BzqE/wkPfA2KblccygR390f4Yl3WiJYsgntB8puxb++isoP5tbNR/7QlzOucY9OHUbbV81uMoIDAzIpvGrA94VcsCeL5iPz/jHk949cE9ft+nfh7/w+/8CTy+Wrjk89iS2v3Pwj1Aa+p02Hfa4LJ/OQDEpT3m2zgrB4FFgzmWkLIxehb9zWK7lqFpbB30QPPHaxkYB8O0d8wmqFYpA/v5CfkdHwPu7krqucsLbet0UGDUTgcGXew7/CwwMgD0UhPpExEPATDzCnjHmtX9BXi4g+4ZFsZ0WmZ6jw6XDsBYw+OO0fEKpjC9HuJntgCfW9FcgDFAkduCsqKxJWY34AhAh2HXxPugiNwG6pFuit4BQAlZuOL51cZn3n6Ff/m3/xz24xMu+QQ8bWRXw+bjRjwHWJ3t1FyDw6gmpa9mhCRT+1veCzDoVvqxpfiK4JsPMoTILpCbToUNLLIzDFIi863ssrMIBZ6muwoTh/cqgzreKZA7YHXwYA1wbScvCffDoKvRcNZJ5DwdoLm9MqBttv7DtdUYadJeYmG0yGjoqMMgfLbjzLVDrS/O2peotrgkRRWZ6f4iswHuSANTdmXwm75dD5PDsBbJuh8tsQF08HhlrJ3x1FxujTMdR4KXi1RtXrLPZefOnBpXRcaUwRwgJ0AVjwi8NV7XItCZGsxM9I4HYsNYNqJE6Pds/vR4STMRaQD/nLBkLTR2OjDMPMk4bOtDSk7pPDk1H83ruXMIGE6DRVgsUZqX6/L9+cxOOvDpMefsF0AujYGOHSKVgaOhysZFBxMs4jwdG3K97kGhCKTGxonYgR08rjXmKnh+zloKePWMfHzGftqVCXjvgj/0+Z/A933oXTw+XbDyqjFUM8OoM7Jmdfw06hztPueXu0/9Fy6kaJ2KiJhiT8kcY/tjoWH3KZV0QNPPB5fOJSONVWZujXEVptbcEpvzRZvkFcjnZ1ze+Sgub72smoqA5GvmzYDp/ARhbchyPbdYtCCgILB0Q2uNqLi5uPocTxplvPGAvPdmZwlodNWlc36ciojEQjGmY4AxIRoPVErGnrQVTEnMRp0CsjjHkvSQMY5xLAugIpfBlOmxJdpJRJ0fYElOTGYz6ggA1+cL/ue/7Rfw2bce8fQErH1FPiXiFYAnIJ/RESMUJUJN3qQK2RdwFLbwX/oKxWevQ7ZYWiB6XnXtZPobgetwMASQsw3/4bYotjm+gMjPfbazbdxEf/3qllKoIYOg5p+wZ5rKb5SBOV4DDeboYhKYyKkITl13qmeNBnlQFquHXTjKivSRxm4De6YHmy6hkiUNYbVe8ba4gZ830X24qn3e3AdnwBwFQB6YjRX5PD4I02vkYehpiOQ6undmFWjY4PnbLBpm5jp0xLfohwY58zjmWun7cH+HGZfeelkgex7zZ2UthxD4Z2LTAMRJ2vFnshF0kPt/hMraT+2UqwF3CCH7OBocX6ehqdbew7reFyyVLJjvPZP6aXtJJGjomkA0YupRGOLsT7HeNAnigIYqUwoxqB01YQX7BzCLrHluvxyFEZTlztoq+MEGHq/A8zPW8zNiJz4Ur/Av/oofw+WaWFem82+WAAqlpTMznS4CU/4Tnd1jVF2j5bCsg8ymGDvLNpbpJ6aNRYezz8HYwsBxFD56aeLQ4WbLDRa2lEmv8/mK/PiHgI+/WbvImJ2fjoDWTIcu9Vjdb2MQhuFd/XIsV0LuMeFs1C9gWY7M33hAXELeoUSTCKTZUMK5rt1pClax07GgVh0LlkQHZxgqA9TkoYCuAU1eEAVJwNMzVjfiamAyb4AfoaSjmcKcTlJyGaHTULETd9h4/urGP/L5r+O/9Gu+iqf3Fu6xdbrffu71sGv0GmYe/XFSOuef9AaKcdyZQa8xMApf6EwssJCJBix5ex26yGp0GVH036RFi53baIMf4a2QlLkpYATlg92Bo5BG/Q6UkIAUuDkZEjidAo4LMshyQsZa65FNXzZIPiXsyB9A3retivvtfgixsnNZ/Jjr60w8RCxnFYYRK1oPEBLTmkd0pnuOPhaWk4GFnk4xs7dysMc4MuxUEKzCBh2A9SyH40DQz+LcHulcAnw2s6djRzRVVDpkR1Za44uDE9VrHP+WjbiJHIlP7GcBrgSP5mXrDg3a4P2kD505gf5gVk2FmbVBo8aOwbxh0FsZJTvOXh0O6mpZ6oLHqf9abRUONe5yUKQx9ZMrGsoIZjfHGaXoMHG4VjxKZpiJiDHVYRlHe+QvOXLjYILQPmmSPGiml3JGgEeZaj7EBuJ51zXyz1fs68ZlX/H4eI//3Le9i9/3qS/i1fWhtnlHy8a1d2F1NiH3VjaghdfZVG2PhpeP4OBN2bd2FFw3UOPU8mSM57KxH8w8tP7m1vJq7mxbM6go+Wo96GwjBqZkXg9DnY1Asa+It1/i8s5HkE9XG/qxjMMsvAOIkatgUN3vrenJDHSTDEQLEiLOZ+gpRtQBQAPY8nifW6K8rlCeeurn1nbw5CZGvRWxQkpAIoGFYRx34PCi3E/PbCg9v6BnRY+Xo+FpYcVUe8wE50VTsMkwCJj3tc41+APf9yVcdh9k8bzLa3tKxDXrMBZpPIZBsFlarJhshZLn2ALjIDDNdE2tf9gj1boTtb3F4E9+zgjeNDX1kgrQCi9sn1jXoE7DcPvnqMoffzg+AgmNh8ztzTuLljUBHbpD5Rq2iGOCjE3zsGWr7o4AWGNQ5D+VDQgtYwx7BipFXOIA2+wx1OVZ7lXnW7RRDTXBjFGKftPanXUwVPJJ00lIDN7cfIEGj3B60/SwsXGFPAdpIwqcjlnctH/E/f381EMtL0z+DGMr28Y/XIdX23mM2xsipkDu7j+OxioL2QM7LGHIgZYTNRmAPeTxlppNptCp7X5gYCBfdLTKn5tuqiGZFOHYLFcx+UPHi1lQGSQoQ6OWSJeeo49IP7Ey5xhf4243xCWzkMbYziOE05oo25hOTL+kJct2knh2QiQQz0C8uiKen+us+/2MfF74H33X38Vb8VTBVNqw59XVm3JW2xFwGj61q6Gcx10HzWX62hymb0nnWVvQMrbbZmjWTdPrZkbSyw+hfzva1/LDpJ1l6fYQtiHt5grrOu7ucP/Ox4DrddhLPt82rGWlPvxW4Fv/9OVapWR7X7Umzatwg1UFh4bSc0Kh8sv7BuH0qm1mV/4PBrDfdJ/2NsNraGFl2E3AumvC6Fjj80E4txM7ftfadLQyRPexOlLyUsLc5hYRAuHSpY28pgTLIJZYuXH96sZv+ew38Ts/91U8fbBxySfk80Y8JdZz9sU+IWNg457Gp2biocRcwyGI7+n8TFGiBQ8Lc0SnjdNAIGPT/N0NAHtCert7K/Q7n0GOlDUo8ylnQSn08Prv8uQgCCENgmvRXMsNYIJjekz8nQc9SVValBzxtGPQqcHccYhGefjttDA4EU9CRGbaNwBeHy6DloxecO6GONY8G/zIAi4pUKZ474TnwVT7SEGyP2lF1/fn4Wr04/twjl3/0U/J+ekxENBVH9IGBa1ju8XpWALA0SdWAyDrfGjwVXHdz+25ckojeG6HEhDLyNlBssExreQQjsDhoBsos6YHhy7SUqZBuuUpfwggluuUZhdGgf53/JcOPNfkB14UL6ah9vr9a3a0vbsEjJHUQdWIWOdVMR5zRJa9ogMzOMPkhzMo/EM95bkAyoRRRvrnGDRkFoC+2DxkjcmqNaimeW7o5MB8fAauz1hxxdNz4Dd9+Jfxj3/6F/CUF1ywy8D2yYCiQbevAe7sbYPMorahb5Lqd8lB1xQcDkwJz5IjH8d7pLULBi1285RS4++QgTnW4ZxOe114Nj7YZULinY+2DC21peU6wFvem/CktttE41YLE6NqMo7DyaMRCmzDS6Ju/3tx52KRFrTFkZCxIGCSOU6ZcAwyghQYClQ7C7nneAKMiLeqxad2h3FE099tv2hkcmzpaIHotpkao8X1+g4Flqfd0UlKYC38t3/DL+J+XWvp5PlaBS5XdKX9mC/QBr0hZ4C0BIvGvedgEeFaZ1o52zjVX4UC4FowEFIWF2PVCzRkM4rmPvwCcqZcl5SaV93W4yfQTFpxaWEEPt0nDkknOJevSSSjnIWNWONT+gfYOLpgzKBzY5R6PjoCPftWSBpothR2DOa6P9fZ6tl1RJddUyUxJJSyGEt74x1EuLCRxjOdagfHQeKKruZZC5J02FX+pFF230snuEm72wkCC/bAtGfzop0CF3Cf+QVPgmajI55Oi84LxvT+AEYZNqpykE71XY4umEVpt73bZKQzaEaxiKbL1dlI0ElVKrgyIzRaXuYJjSXHBFI0Ni/IEq07E+gHgmr7qljJpGyK56LDiCJtIOp50VM4Icn2OGPUCjElT5ojEZgV62ndabowwyOjssNz3lmV+5I70pzZJTQWUw/MDBt6p93LiRl0fG6Dfc0qcOslgcAjsB/xX/+On8eLeMK+bukNdwLwgCAV8imihvoydlu+5EzBciZjmb7objfvJXNsspfQ99VyUdDhDMQMjnwGi1WoPvLNp6JdsrakC0N6GTivV8SnPgxdXc4/HexFRNfMNfnJB9psQYROmaEYSe6rXmM3UenlNHAnDcvetX5/d+lz5l0klzodyUAU7ga+iYkqsfT7IYACnVJKRujYoz0JYXtce5eg92Cj6wJCyxDDy2sCcd2dCslTt24jTDKR3nfugZZFBwABAABJREFUOkb3+nTBd37iPfye7/wy9lPgklfgGZX2f84S7k7LG6zoEFX7Rb6w4W0jKCXZWrlqAzyPfQV4K5b7YcST7di1oaKz1ILm9f4GFAFLml8Yxq1/8ZYu0ogRHulKulsIdapewqkretdt7MlbGoKtg3toCCDAaY5AGQrU/H2YBkyDbUOxkaq8l7EDAFWxKwcC/wnJN/8yS8R+rMQlY9PP5V+1SAJc6c6sAa5DsRNa05+OgNYvg031nOnUcnzskYgnryTE8yNa0SlpLQWKsBJ0hnnujGRj0Ic6n0nHJuHIh5IVB01WTHDuxmNPW2y6tvMfEQ34ctv0L3mqHAmNjgxfO4rMfg2y60wNzlHryCAMOWsw8MjyTb2qCe2jUhc4Mi1ZtODUI5aM5ZpOyE1NDFlJorGouIzUHvwyvtX34XHvdgClvxzTkJka1PjNTmfmiRVzuWLADleLe8zNp16nZ+AoZ3Zn1wIk8PRcZwPgisdH4Ld+6Iv47R95F8+7dgQYdq7I67XPG2ggnZkSOgl5lW2hsyrZHc7I7XHOwuyW/wYQ8Eh4brljO7Wc0W6enIsU++UoDH7Wuz5NtTmP2zsEAkA+XbE++XYtQ/YZC3VVcsuJ+oD0BI11CGNJZp1Z2gAyBHLTize/bbgpdB0l312Au2hOtnBtHF5SMVirLVKu7PZV7JajI0TlXKW40UobLSdWZl0JS4JFlQZJQBMyejWnZYMhI0yQqvO1dayk5pIDDEiD+rNiI18t/N4vfBUfeTPw+FQZkLhmHe97hWh70BKh4I0gtHrngrrgmnIQ3jrzkLCx7ZRxAlzU6TZmOmskX2mR5BDQ/5SVVeo+ISRq3pXwzy1dIFeiDwbhFZYEMHB86blSoGWbDHC8gmIe+KGCTwpOBEJeRKf6a+AC4QIfvYBhmnwJUXpehDJa7Oz3hd0NcCxFAXJEOsZ40kKua9mrEmGTWNFDna1Rv1u0ppKMKewBJCGOiZ31MWPAcDPKOsS5A4Xj3qmlJcRqR5KZH2dIGjLADJUcYYJm/4mkHEA0E5S08cwmGlnEIuQDc4hJ4lzPlXxUts4OiYiD+aHdubMosB0JAbe4U4Dc/NMbTcfVy2fphk4ZQjmiIP7B/9YNnnFgajkVKYwK9C4TedzD2RAKhviZohWXYtoZCmIf+mIrwFmi1m/dEWAMONQGzgyVDIrIembOh/JE54Xy56Va8s1jYKpdNLpu4Hlj7UQ+10FAl3jE7/vk30E+BdamsU85aErDc/ZpI+/InWl+Y8x1V9EhU/uc+95dK9DvSz/77wafT81dakLbIoqeWGtH1UsLlFHxd9g42odYgbhu3H3yo8DLe+1K0DM9d+kG5WJTg4aziQ53ttLgp5cpIy8N4KRaaZDIh4vWkadMHManjRdYeNHMl4erNTqDGJFQgihDzX33vhFvIAWLGmwk1rn224HFQGoDQu5r1RpQ/xMHcQujSxn281XdXnfg7k3gn/jerwHXNtFXVPpMN7XR6+9Yt/PdswhT68QLo8isp5Pkz4bLaC14QqjtNHWBzVBo/hBRnfS8lnYOOGopAULv0Mi+i76FOALZa9dlGBZ6EaYdSID7YimApZBh/qIzHS2oS8mM1DINMuo4zZixeP+XxklCF4fw0BgXyUO/ZAKvbfMbvCl+cb80gSKOPqIdHey+rXwAr86TGcBN0NVBH4jWOfKJ1jGHHnW2h3JHFy2C3yDVtn+O8Q7YVPOS+543FnIH5jLJfJp1A6v5LSeKXkCinARRvx3BNsZec7WTTeXOCXQRLVd26AHUffCUUY3BmTFlosYSUqIzOuH2a2XMz1j87Y0RcKE0fchSzWOBjyU6cIlsGHIGJy0LGPMBhuHocfO+Ax7eM/fba/mSyi89J+52ZoNBW0P5cFMkD4oaA8qA7r117PeiUaQR6mI5BUslfCDJ6ORkopZ6h246q2FxLvCnFJIAIj+4fAOgccVO/trQ8b93uCIf7/G7PvYuPr6e8PS8LFtsN9M1AfqMyxLVT12eVLetBSvv91awEslnWoeijLw2z42AyphSP2860dNDB/S9z/WfPArFzkXeDdbFGEFq9GV3AVw34kNvYL31og/IbUdiXcDlBi0XCTi95d5ismsJINaI5NpglKAdR5VIRsTDBHB/x4UKMWEMd/BhpAEpAU1wAL31cDm1FjgZvDsSlqBTguq5haiz+dfoFxZWJIGRHqcj/93VodEG1h6XmU3vUbc7tbAuJK7vBb73k4/4zZ99RD4FLqsrNdoIgt5vEJoYGqWjJjJlNa3kKIWAgOs7PI5VUTY9hz08Xor8RmVfGJGOTE+1WjdKUY0JLAFaE3OSSsFzwYtOdGi6zxFZl+FJ3a0tRaDTE1agzbXpBhZmOjLMQxkJCjZsUCh/LOQJ8ayVg9dWMxyPVcotue45hg8cEj2aVnscrsTzLVhtu8AtTzWHle2syblIIh7E8H6XtzuSJjz8inyUoyJQCcQOHUyVsHFUN9RzGs/+oMbiAkfqvb/rpT9A4JygrKlRFYP2izKqmWk5bV5X4EiD6QwXAZrGZdO0tRMpnzPJskYjORNZ8hEtx8gB/haVTI+VDgqj2SGqkjcEl//85zhgyooKXrka6GLaPbAvAzwNkfIYvOCoSblZc0F9vhgzRahRQ5Vw1klGakw5jr/ZurjH+z2X8X6015ptKFgUbX7NTN9E4JpIXoljjToxjFKJka8qoNy3QbQcQdhQz7YuXyuqj33F03PiVz58A9/39tdxzXsd6DaD1rAHbrsjuU7xJa91yZAcXVoGOnXEk7Q1Y9w+LRifIWbksBncUVaR/5AlGnL2I4VQq4O/7WTNgufrFXjzDayPvFk7zOC25EzJ0pE+QQJpBonAotflzkPp42mgqUyjjfrz4q6MLpVSzff5+M1ApRPJIA2ijQDXrkBc2ErPRTsE5Y2V0gtUJVjCE2hNr6MuDzegvZYmiQyjI6rJ3FS0dkRKmVgsJntM/K7PfBUPK3p9CrUO9bzVPxV1kFPjDcvbEdlIJpIAWgZlFtcAaKek+cb0ORVyzCtbEbWbookn1R1oSDqsHo5sD8KA2vwWrZAdtKXsW/LFEf1r+5vkKRxtAbzJGIqqO91KftJrRhuLwRK4loSgBWUA6MQA8y/n7jve1xoAKRmbhjwL2APAWrq0bhY/go6Giq/QBtVGbg2JIrNVmT1/b3kmKKONavJObILWiH4Jz9QwOh+OWk8dIP3U1lGo53bovPEuiQlsBJUJFG6fc4DGIG1SjUEID72EaNjVM2xbO5RKqIJZII4rh0yPNetsfLOuMfJvPvec63lm6Q4lwJikqBP8eI9jfuejbSjKyb4Ur9aJO+U0eNzhLswj/TqiQhrexQxdTaDmGnI+HFMZLAorlqJJzt00P7kszLJoNiXMextO0thOg7CPMD1+FqCUCenCw2dgX3sZ4H38to99CbhW3ZkyIZTLUcnP9jK3+nY0OI18Kqtco+4ggo6gijJTS2UUfjqcxbocOMRsDbQ8tdnvYCLllCcSylYE5Dwz66jnr4l8cYf1kTd6K2DjlLKKzfu2GUERilOQypkjELAzMd2NKGrNYWwbyNbDHbx9jOsZsGK2c3AcEQzpmz4nOBQC90CYiiERkgC2GgTTjeVQwgB4QAMZz7+c3wr4E605N5NJaAGPjYEdIn4G4G7hP/nOV4Fr2X1cE9qnngC2IzqOad0iJ+lCQy76s5mKMY96iEylsG3kCxQqpX6Ck3ZmZG/RRDgFnltAUk7g4tAHP8P85cC1tkRztnBe8xo3hrQdBNHXikSlDRZNMXWo7zoLcgHonOYYu2fr1kuOzs+IF9r+GSkHxCBrWMsEeMpiMppeTXsXJRwwOYtUWWCoyKkRdE9aTq962F5fW2qwYLHtsb0vGjEzPUZS5FgHZ1J8KKNoMuYRGKDDTOASdQkqobVeGm8bYbRMCnxGtmjqIrNcxtlQ/+qnB5W0Og1GNDoEYC+PjMtS+nnpR9NOsiC9TtEA6nNc20r8SfcrugpHu36i8UiFFvU6gkdvuwAFM8NGw6N5kcdjYw96vJyriKpdK3mMS453b6cmPYMBFeBCxyEPXCpTfnBksLacc4sSZZZ0qRKX1mHOgzgyjU1a/APW95p3loxdgdW7EL7vQ+8C+6ntTrrzOYdMRfi17EvjXW1R/w/HY4yx1My7MZjZSQA6bEiY1lmrYXT3fIamsGnu/lrGMlGnKbfW+jXofpG2Jzw0KC8APvpmFUvSHpJ+w4ENGlal+wQYQGQlzM09+A+96eB61aCU5C77CGCuKFGgW2zaCBFQks8ElTFlyKaxE9H1O43IPhSFUSAlx5DN0dRzrk0K7YnPVqA+TMwKRtBpj1CRWjOKAkdwvF6By/0zfv1HXwHXjQvMeOsTDSCdi3aruhLWo+N84ZTvKDp0Ec1Giso9dypnkiZ2XhShEoT5zKicSkZAwSuaKeAJe62zXROdNpBRR2imNDVOvZNlXGIJ9BwZLRJjElpf9B8rtzNOXRPBavub7ydPK9izo+sZMdNF4Lfw0VHSxTY0ELudPdJnzgsQfyIGAIMRoEiHw2ltMh/70odjEOd/1BdJSH1V2nxzPdHo6myj22W0xhHZEeRroWUcAdf4lbMzyBedLPFcYOv5DLEnLnnnC2kMOdj1FUP5Pnxro+o1RHfqiw2qiuZGZiRhMLXFao41+JfsDVq3AQAP/pq0AxnWOJcMgvKsi5oZKdItOXfImeGZGgcW4/ZXj0IjITYhVcxY7yxnk6hYbFDOBkU4jo6cOm4e5kEuVHa0aS8D5HmOVRM4HBtXzai9EOZl81DYpyzA7jtVHvA9D6/w5uUVrl06k9fspT/zj+dzSE5Z+OrJl3zp0KCtI8kP59mGQdhftJg2jHKQLsgEAMw6tdax9HJBjS/5DabIxWibECOHD6VH6yNvFAiF38v+xZkR4BjEsHWALpObMJueLCAgAly0Ry8mEcj7ez2XKV2TgJPto16nmUKgnIabkWqnyCIsNu0Sqfiw10plzOTl1wxXoKqdG9yzCZ9XVlw4gp/XEk9mW9hdRMLUUTZg7KfEx1884/NvPde+VR4QQUIzmkGl5qRQY/85hZ4G1EY2BLJBr5hE6yLI3KlrZ82jQc9u/yjIu1F2gqX4J65E7/vdlpBBI9U1dCfZYMDMAsHMPkwXcI70OLc+qm5A7/U1xTdgyDS4oqWhOvRbjvQ1gaoBuWgWtc2Px7WqCxLIc52H3zCVit47X72ybgV1TgK8PJECGdIthqimeRHMbMGGk9E3WR4z2UC5WYIP7tk//mRgT8NKedevYX6ZsXKcZvTC9WFGXTOYyLEdiin73UWiiLhZWnJWQAY6GXlzjNH2k+vrg6e9zk7+7F0FNtE6pt3UI90ZMFjbFbAzkmrLOpbdJ5fSQvRqnly7n+TSFOUoW+VJCxIvhlGm3EP4JMec7YO4FMJRBgE0ZGX4xOxhq+2MkOamdeNXAEjLvy52yvGXf26yD/w5Wve1dJNuoHjcjoFUyvpI3TocigO7WuC7voAH/1yvF7zz8IhPPzzjCQvBK3yJCaNh4boiFGdmWLfg0wudlVU1fUBZPmV7pxHu/5LW3pQNMMiV49TtzqBQ58wMYhvXKKfT5bSDFADW2y+OIIAOBevVZN8G1lO9iZWr0gcpJWJXLIzQexTeGZFcoopWEsNrYeoEkMLDkzpGQWFos58srGE0yqcje22rBmIz6oUytrO4fa0H3kf/2JuKdePJ9lKGjhwO2LCk2mUKSfaR4P2ceOeNZ7x191zVmdeNfE7vyw1NbzDISw+ieM8hr1R8uL+dN8szbXoY7YkgnFjI8PBMAGVwgjy1QtiAxrCbFPLQnGckYdNTWxcB6OIoVZcTmNdYV60HoEiBNCICHP2IRa2EDSYjtCDo0BmC3unopOehxLf0jalY09WH/kyDOAbCQj39tx2fBrbocmk+XlsiBX0GzfEBaRDh7AjT8clxp98loLoGIpTOnmCqoceQfQJBO2bnmu0AmnZc+coiGMsDQW/xczp8Oq+JkSbXpAZQBWVsftB/R9pfRY70IJU2aNhtQ0t9JHfkoARlxRkBoZrGO3HGuMTiNBbi5opxlo8aElYYFvv5oPETgc2bzLoKetNJoDBAz9edHRVsCSCazrtl2+DSy35sRkZt6LdYl7UkOWWFwsmxiK62BdII4vYovDozFmF6DOMEGaKE7i7gMImxHF9AMtjEqGPWUcfufmy9whdevo9yYGzoZhpwBrA67Y9yuWnPcqTyKURDJpL2a1C6589AlLIdbMqkFM5qKWKQ+hzjQTnBuJd5NnJfMTxpIDfW229KNgb5AfCuG+ZdwnXPtbajEfRhzL5AZl5HKAIie9E8oLvCEcDlgrxf9mAB8OhVFc60wbXFG+kTa62U1AFLdrX70ph8wz2Z5G0ofc1fb9NrYQs6FlbuqQcyBO3p++Q/DmnpOVaJd2hiobkC3/6hJ7y8BK57eNQy0yllOKILOCFn291c4jrZqmo4Rpa6+TlzrDn2ehqj9EA7HwQ+JaMldPXu0i4rerYhhRh04buDL0dh1g5tYzkBdWtLnIs4B/A0Isf4jFGOAIzV2j1vXiySlLf07E6KsqAvi+cRVS1OqG1PleAoJ4dr4Elb31pIEOlxZ89Vl9W0MdytH15BCRnNygwU3ZWBaqClYzsgoUE0BiD39wybIuAtgc2/ll3dbMnoK2qHjF0RmSkbP2DQumgoGZCTHjoTwPAQilr6g4YU8tx8Jwm550ZORxJvRuAQxGbLWtmEanQnl3JsZKaTRHkSaSm9SVnmnQIx5oFhDOgqpB0IoOe/jn4kWc0n6xPp6rPgD36p9qSWsuwcduaOY97ToYDGQzki79Rjwvp/POtMkXeNOIJl/rWWt2o+qkZPZyOKVUQ3hgJJf0D8kmEWLlQfoR0vnaZetaV0D330vOpvbNqfxAXPeOfuvXZkbnE7W399hki0MZzXZ6d7GvaJUm6M4ek1xN0UXbpgnf8Zjn/JdO/S4ZZYZAfGIzKX88TxjTE3bvE7ypIKh6/A/cc+3DV2R88oK5zHd0RGHSff/dwxtLdhbIWO8iMQjuAdfTWY3S+dRTyhiwBZRNnghRx1ilcLTws/05kWIf5cZF8aVwEStTypJP3KYoVrz7bWvdcZoVQpps/G7762hM3nCNQBCzYqVQ0/Pfo2SNfEJ+4fgRW1JpWml6KantFxf/xgwk4yqgyOAaSVug2sfVGASxgUPu4ctdNtYgScQSC8x86KajS+Zhkq0tY7mQJNtHwUqcg/812qv0Z7g2aliBubjskAXQZeIJ/QpQHYfRaBPBDOyPJGB2TOmYZH5AhlIigj9Xj9z0WAW0CfTBFyrkBZoZW9S8H0Vz/HpVcJLzNokNUvf14YPCfwjSWBpvXowPKdNNPDkZgiwYiZYyUPaCeko/5ZLN4GSt2CFyn+c/g8z0LG2Fb4oI8uEQrU2v3NfPQdCFjp35NoUBPkUKc+6CIxMnb1uDYo8V24CWW61DYtr1SbTjtBuL+mkIruHAgFk8FHEq05UAUvfEX9Nf6SfKt3vzTjLRNd6gKxwZk5RqkJqF6JGAKcuEWnUndS9HgKgzgm0tm2gYZR39Nh0JeLACIMGacfW/ZIx35x4pXYHRTCljfWRVw3cAEQG5+6e6rgQ0updkR53PG0XcjS6djZG3hqrCxwpA5G03CDmGR6FhZs3BbdHfPLKT+p93e/m73sErFNy5hoxgwWeVefydWn/OyN+PBbdRQ/KZiu91os4h7YRUeIBiUB3CXCBS8dSVoSPPFoBTJjNnC5By4LPGKxQHPL9i11TABylG9DFr1fcpcQ9b6z3HkU4mSgK2ghIYtGQnnX4WKl1H9FHRuOUVUOMCImO0faZwA7T4Sq7zepDOzEt718lCIjs6+nZL9tQAAxvPDV2zNcJR8SQqeEeybbxpRgXXUQS4rCGRnMHMEchgF0LBKIFppklByNi51+RGVgyv8yPemwMG6Q8vL3tIGsMSwZNUfIpXS8fZqnOMpJW53duOXmBDO+cygMfw/Nh+nqA+Sly60YGQIC+kbl6KQAd9ZKKE2LIdvIrmmc8hQkDidXstgApeKzAxS7TzVzRhgEzGhnnHQ3ULWecH2635HaZbeQqehSdSmyyNSDRatjx4/yrCjexkqo7u4gRytbZ7NzcxwvCJYt2ygsYeQKyXX3k1xe4heoEzcjK/uAjnJbZn2iY2c2pjMv89mAv5bWWcVD6ZAo1MTu9hDSS2W0RvPKY9D6J8ArracR1M/cuTKZTm+vr7mW3zGcgcNp4Pgzxe+Jewk6AwPySS/+d7Da80kZ902eSichPTIGhd8j7STnNMbTMenBSC8hjCFWf/TyqiqwRboN4DIgihH/xuoMQx1dD+EhdpRDASDgTHPZI2/SJaVKL9reXNqpY0AhmjurkJN2m7tSLL8Y7Rd+d4ZonPEf479sLVAHicWbLxB3S7YPCGUoQErLXkiFJTNA4m6JGUWsbONqo4Me3O7fyyggAVzKQy4dYIozYHygASHbQ8abFKrK/qXPc/vnqW5cu0h00omRVgNIdshjOPYfBjAypqRRer8ux5dJ0KfnN4WWTGkFuu6u/H8GoyXBdFK0bXQoGeWx+iS+A1CbaazzZ+IDgQHkIUHQnKRzZdi0B3WCTbSCAchOt5YBAZQdCZqWrEKZRXiT6MowtiRZNAeQcIsQx9BJzo4YbXxCwj9NaPN1ADQpn5RkhOkFNEA3/zkvKtQWWVvvmiaswSCPwzHlliG1Fz+pj6SD6shDctbb5WQkuk9J5lRIgnL4K8tYT5FnDvCTZUdReC8O9TOkzQHoeP098jL4fNsRFUgl0Dstaro0ztN4+l3NcightZjt0umqbt1nMKqkjvY5B+dyJN34dg659MgItnErV4w1//55yM1cjgvyI2I4Tx2Jqe6DY+B/5rydlaAuUmk5YlEiB/7AgGyotz5bB5zBzEQVxkkhLQtH9pDvd1uiG8cIPkcKsS0GDZwiMwNjJokDGwgKE8a4dJSdWTtOpuuHlMVRVslfss5HaldMBrffhA4IKlyrZWxjrQ5cQmJfr9Xe5dLinLIlWmfPGHhKXhnxS/yart12InuZNoG8gmWAwkvSQxM33TOU321dWZrzhDeigDIRaDpcE3jxgLi/WKdgp5byYpmadnF1fdnmQXUpZPCRrGboBAdVrmUWQYNA7q5KbpYZK6A2ikpQEYMsC6oU13atGIpQFPAS/PCSZwUGUNWhWVHfmt4p//TzAtqNOg+a+1b3iPSbNiI+Fbk9zOtzcZvePGmQR9agh8/2uuaARV7YNgb1StSaW4P0XMekoMcQruh2aahGEAZHA0vrqmSsow8if4xormF7ODe8xMP0o0Ec7TQApQhBr9oMYvQ2l0WS/SNGBsUAIaGmPJCWGu9StK3089hdwNEdCGyVVM05P2GmyG1ARkF1Jjt9d30/M50artotRa6tI1E/C7DaA1AEFOQn4zRTV07d4LWvheVcbXwmf4Z961naSXBu2mDMjNEEtKHG8HXaPU7xw4rALa3R68a6X4NEyzYQPBSnPI2eF6DtYJRzSl3GmPskSDiCTgNn9oQsNlzBZkFtDP29USRLz+E8DFWC9Wlka2gIwSOubTxIP/Fm9KPzQIQ/xiuKL8WE5Aj0pTSEaGURQ43TwactVXHurMinHDaNh5bD4rnkYI29vZpHzjmx6HSYDvFDukp8SInO3JWh1g6csw7F4AmAWi7ow6F4bwMFShjAGvLOOOvUwSyCcHfLogM0RVvwkyiHP/pUR04hLXdZ3PdUiC183E5YoPF31GIpU9cDqOFt4P6CuLvrFqtQUnIbbb8ax0ceRszJBJbWGtesnm/wDwt8TchsAwBclgfY0sVT2ybbZPujCYtxzjgolNV2pWtqoquXJDL7+sfdp/jJUw1FulZgoo59p1rTbKKVZEFKmhXdVIRcdJh7kpm6zONmRNwIbEpRfCrVABrSnUomYQ17iS0Ux3rTdFgARycNpLjaKGdnYaisOrxkD9DZsEGI6IxA69DY70b611hGSjqdrYhlw0KpoGGahgSa/zD0LX0h5vfbA0wZNTCUYQTJOjGBNGlNZy0AXxJkudwJn7/POSTT5iHng+KvejRWSvbAA1GIMAtE0UBAzCSPt7of+kDBaj2gDI8qe3ORc2Oj/e3eJif1nfIynIdio6PCQd6RjqRitiZnIrTtlVxturQ8zD+ae/Z2SEnYOIU/rYc0YJ4PdazH1kd5M5tI3ov+dJzULwW4+bc9Vs+/W3cdpyvbSdvEqAgf0io6abLwaaYpT4bRo4vuJn2hZ1aflKk50YqGmwT5k40iYQMnh1AOpeUFaecUyX1V/Uw/n9uZHMqKDzZiqts0OHaRkNyDH+pfzphATrBv2eEv1L8mgexMHM9JBwSk5s+SA512AIcBV3aoCzCJ/aJTep7yXzDaG33fmr14bWzN2zHfoB4ktPwkPgojTT8AXcC+28ELrKhj6qdzNu1RvHxAvLizrnB5A3QgO3NvEB7FqPXsCiynx4fbRkI5DdiQILzI2gbI78QktGEnUMIU7O8XEZ6EoPI2AUjeBMGrhbadlN6vVeRo6tT9y3G825a0aW2jr/QSAS33KNIhcSwoBGdvdxnSgIULz+bnemQO6e7Hoz+j0VNUP9ZvAdJugBsqRb+T6W86FolhF17DGxsEt6P5zPVkuanddrLaCLqoBf5H85EciOeAtmU24EcbN2NocIrFuwjwjgdp5/Ryz1ABlzbu6xgPa8ohBSP5nWSbBhUCOYqsGeRK7C5BgIDMJMQ8ZIRjjPE/y0dX/TaBbOgCOoaVxBMIwtGBQqxTlhTXJxXa3w0EGlF8dEUw9bjkmSnvc9SUMzJKwmtDQ5DtAWfLmWqF2EvU0tyAU7h8ro0PaZKQoWa1dvHHSwqRrMWx0ctBQ2JQnbg2+CAncwBpDpoeZo/0C78bAR7OlHqAX1sfNfXhiLO4dMoKpcXOGft1VMgmRk+jWX6ZlhtSuA3fFIf5hzQLtkdKLmbtJob6nfmXRMqDYKlx2WAOwwMMB9F8oUNIPubsK87m/XNCxj+dbSQLyo/gEtxJX65crU7dEyI508O5md8nFDAAqQuDxsPgDpUbNUQKSKc+9LijsZy7A4SGKTNX8wjbpraB8XCPePFCEz9074bGWhIOgEX5AOoAaB69yChcgtjpWXrLzjn17O4vmJfvEHRCnIAHEdBAog139bdFDEV9ImwPvBVh96EPJfczy9DifxQgsa/KIMRQlGwtKC9wuy9E3QzFz3IcoANvwUgGYN3mZQ3JG5JLAWTPEx5FIBoqLxiBjoLWxKbDAuiyFdDxwODLonAxG4GRGQnR2mAzBIXtc3y8JnQMo/BrwGV/GImDxryAJpsA3KVxsKwXzWNY9GxKHZ4NnQiOnRSk0JME2W5HGpQJvD4S1ahKVkWPLxCKwnVEVnoOlBIaq2lEBHppQ0gDSBzkMs1AvBpKLyUZfIt+XGph1EsjNCjQZy80GAp8coDmJGyAR5raeiZ44RJrSBwxzKzBcMq6PWaduBuE2yFph5CpbIUDd+rp7ipuZhhS9PcZB+ZxRlQpBEGWFxaNcQuIAfAQGNKXGKILaMTTGveUhZpbb2fOlEwUgFo2acRr2Wa6pS3F1GOeIbB6uTWA7CpDioTQ+UJ8hDFMHoSQziJwJa/cxGk4/aX8OUAGp9r00qOW5Gaww2c0VsrQNPbGO2FGxEHXaGvKcRaW98MpNQaDN2ZzJfHpcVGGqN/iUafuNRg6bXKw6WR0JXzrt4LP6aQlwP33LFglbioQ678bvDHQVnvndTgoKV4oOE3zlFzljPU/vdd0aicKG8CLe+Ctl6AjOCjVGEqhdyAm2vejSy+llQsUiMRR8EUDLsm9XGZ3oCFS5C5JpEFtoOvnqohq1ZaFBJDcs8+lhQmw0kzJQo1koaKpbQOZ01C4WBA0BEI1p2YIVnsz4vd+TV4OsfcVmNmAnvNFRpiGeIK084502G0IrGwxX+fcbQ/ADIOeGVrO36mvUqMe45akJXguAoEkUhst+7OqE/D5yTRgnpOmOx8ha4RVaZp042tmFGgRpPUE5KjLLqbh6rE7why0CaZxOZQcgAB4uyINqzFRf2y9u9k2uPSsBSZWTlKe2/lYdEiABFLr4+xOVwRTxgCvXSZwOBRIBK8l5ifT+PZJZrmdzQjUZ4qxqKqpJrovn+xY9Z8Bb8mE5ZJuV9PvMEYyltbJ2b741s8kyiDKXnQluwpXE40NXM5rCg+Ufc2BTu+k0ZnvN6x1Rf7xJvzkOOq8GDlSqamPatrmm/3TGNvdYjjl0HOMuKut/q4dTq9WeVTkXTYA707bJulvYe8LoUhXG00x5NYZ6HYDYUdLsj3bbh7cFH7c0hewnZF8MlE7KH60PVuUV+L2A4Bv5DRN5tsrC4vzWhfOZduGJHYxszgdmm5rsX0tCRsfi0QJwM6Aa3vYTBrDByKINi3L1WFjwXQCsvrfGpHntsbP09GSw0R6ZAJ3F6yX98KQI0DHOejjTpGB2yu6FFqeL8FrFGxYqGc6NGoLoDoOKN0Zq9931LVRkUas1TrWh9zw8zCxmittS9toe8dmjXcP0rfCGmTCRXycW3jtrOZY7cW4+Y0MU1r1YHo7G5QgEVIafBI4LfZSuUBfjsH2zWCynfo2D3BAHB2eykCZ6qJCFYoM4aVQHcrbEbpvqGp+YRrM2VO9zeOgNaswj9WuCogSPMzHisnph61x2rFktDfnS0oMJ3rIqhWLN07ypQmsB3wwa6GwtP92/Yl0V6+ml61w0pbGs3gJzYOXzsiR7oiS6K7UJ3neSq4Akw5IOyOKtOmQyWFqXBf9LFdzLbeadERKWq7Rj64CJ4nakAczD1NPAPUnh6nlPVY4S0VCEuclf/yHTgDkTPEzZlv4niJjzam3d02DyAht9OWTRUOsVj1Nkhvdw3a/mWyUeG6wHgsG/YGNyJQ4+56FE/xOfZJGY1eFCnoR+jq9SAkWynp4oeeL/en5JoSRSWFBKDK1doV0UW1MYTBEDR5SPqc09L87zufk/GqWItIRLM4+Cqb9If/sUZXbvJxGWm/IEZ0Z0FPmmjoOclt+smmxOmBiUZ63/Z1jco6yntElSHvIJIg7JMsGOkNtZ8J9S7YHDshp7KzWenF/6EThZ/exzEsFJtLJkpc7dirgIBghag1ym3BMmQStyt2F2lDPcq2D3hwVm0IAp1wK9NtYF2ocRBUURY4oNZHRTgNSaeZDWdLM4VptOQTb7VGZ5RFzsCM9SliR4NT3e49z8SlsA4xLaGmQgGOhvv/hZsVYwL42MHBrV0BroCaEFU0R5/T0OWQZKMAiCc0r29mZUel0DkT9RPGm+beGM6h08/iZw1S2qL+TrWhhNY3S5FdqrlOfwew7ldbAyChCDsqGtqvVeJmyp6G0w8oIHeAdEsNZ4AxIpzZ+NBJ+LHHIjWQY4zmDtOJdGu80rY39YQ+eY6Xi7tPoeSBhWgaNdY5GSbcl+Z2nAyITurp0dkyQ4u/Se/JnUGvgdYFNCwAou1tj4pCI2/KX+XKafpYbAh/tT+pzgSnskMQYrkk1DL/k1Onu1+k6aMGONYYQv2xMpiEdepQlx2cZUAyaEre8LjuA1HOKlvpJeBmguBm3eRV95gabDIyx0XUQm3O8Pea958ulYywcnXI+50862elNZSzmOrvmkTCR6HiMmqXMxrmMvjgt4QP7e1x0TBfKTghErY9ekt7QybTILvTdnY0puxIc0g5gVYC0crloNqmj8DhoJyOkBnS+tLgVQDAg7YBnNy4qus8h04GaU9NBtKSKsbjvckFcr8hkNv7UhRUzoHJQwMPdKrChZ9+Gv4zXdiXhRMoYP1yGRxuh4z+LiGZU9KSb7wKBTGZfolLucJKPTAqZeyWu3CY6OZEtyBTaYZAVzbf3HVzADxqwIrLue0cLhYxHIRcrSW3DGtFy43pcD8kx9I8bVXnL4qXwHLw9Jw2M/Jw9cR04CUJGS/In1urHotZVCaocQjs88yhMjUHryjmAMnU2wArY0DadLQ4U2l4PG1XWtkfR8jHR6qYegG2N96ZBq0OKCHD8TOrtifL3ZLaH06ls0ME77rttYzLP6q6HojeINI0plE13rcf31c8Suc4InGe4A0NTBm535ILBbzADldIRHe81aOVsDwSGrsBGA1XXzEwXJttRioCu4s44aBXTaSGAzyG0YaJeJTDWYIVQoFMeB7Pr50WATsi5INhpGypfm0YPPW5zXvqio9IPo0Z+NyW6xvUwqiZO4+TgOb0VVsPPWXCOwo8B/DOSbtlCcodR1hIO0tIgw5lj1fKGvwgtxzBsSz7HaVO/2ayAv+ciaCItTSOaB+/AYJaKlxdNvoT8g2g9V0Y22NV4tosTE6mLvyj13vP/LSLlqaMWHzOAFpmOQI62ZWS2HuPv2TRSRT9rBxorkMwWczmieMEyl5x4T2xufXAmZP5l4EsdbBllRrQz1tPGTJsif4Pz7EzVur9r52CBWUTBODdGhRgifSX21SbCcHrJKQ6AsSqlRAUN6HThhcsHITHU2kiQGInkKUvZKePtHnRgS28rUxW6cCSHNzrH1pOj4xKB3Ff46N+hzPL4N9DHA9sImSlMN9l7c09SIBl5ApUk1VvutH50ooyMk8DPRocKWO3xEH3otEFJ/hiXaEGnZqd4xfqGmdGwqQ6vZQKiV8SGTp8D59LN6U3ahBBY2VmD+3dtZYOb6aDLgcjf+adlacVYQJFL22OmIxOQoTc6DIBk9TqXIGyDzXNiWpLzpksToalGOpJHYQUDFCHd7kd2RNRymgmf0e3PTeXADB11CB9pejHP7DZY1gygbtd9wWM7UqspDFAafregcVNIL+lpXse/lkixv3VFjg8NYVDPIXA/oimMn4krVpLOlHGnEDN/nhg1xbLoT0jb6j8hmb2hF7OF1MdsgOfJmXYciSvmBSN7hWEJZVvwGvWgVTAeUsQwhwaxVC38LNmVFXCJTgPv0Ia95sjlQ9h5DyC4a0qM9HMc4ZF+5ncGh8Ynk463s2aOYG1CYBhHxB7+vtu2DNyXLiTagZ9yPIXZmH9kRvdcNh5ySD6zACPRJxp2TczFwhRDN3PvPquiiob3bI4At6lDpltF8sxcYzgK0BzIQhUQH/Sn5tV3m/3FQry49/yUaWVjiSCDSMMOGMuhTCwBNeCogOI8UsX8Xsq1gLxrdAoaC/k54NGvNQ5eEESDVFOvvZwzanEIOYlDz2YaZHpRGt9ORFw0RhoCRlhcU1QbGje7pEEJK8vemNusBHP0IkuKqggwxrgPoqHPRCJAR5+Fz0qZjiBi0noKsQiHdkeH1eEzISOkqTVgEkRKyAppk4rW40vyVt2GFHFvPp8Mvkf0xH65/l3j3QTKNdL4IyqRM9AHAWkoITjoLEaClfxyB+baWKCNqewLZIQYwcK0Fx51JFLnlRs8dZnOMK6rMxDDrAx8r2Wc0rEuGiU9k7I3orwJiFTsNrKT7eSX+EFnchpKRlRZMpWDl36k57FrrpJ1vT8ID9J66A+Nyxiv9JDyp6+n9MYxB3UzD32KordOhux5cgnHAQPHgUNfdTU5hOEDK04DTVw6qcO3YcOYnaWTyLKzMeejCUoJYE1rWo5lam75NG+tk+eICgL3lctKzYvMY39/6XK6Pb2fN9O2vGJ8JOmOOSFTCshhiAFuR83G+Rg0DvKV9KKMRevCjD5v6FYwKsXVHwdDHl7A7wkHVZAN8FA22pNzvzv8+dQ/6tbMEgvAiRG0M/1Z+jPhlsY/w4dhC8WZOOdD+zjw5uSFQVq9xfEA4uWD6XdgS4+kz9FpofFSBgrzV6p6gpMb1YukXnhaEo61sO4vICMlmQldEESFOou00gI0BjLXbhNWvhwDV2Igt4qMvE2iJsq5MqIXowh6aEZTpIbhDfabZqXs7GB8DURHJuJOFrcdpL69j5kBOuKtWuDWMs5Jw7J0yhOU0MiyjFQbmKI7uC/lwzSuN3NaBII5eWZShtgyMHhNtgSSZDsN5TC8Xd/Av0y9Ou0NbwXEcD5HKsueRQ+V5/LQg255WuPz8px58lZHVUG5Qi+phByWWQjICOZI1KtWJbEllxDtmi2OFqKe5TPJ1CdwLLkg4ewEs2Ijy0U7lghVVtNhLDp1XxuDzmWt1lpaJtC+mUgfMEb5mecIYIJ48+U8dAHM5vjgqQE2GyM1CkEH+cDhSc6i5xbD8YgAD8oZWPUaRB4OR6vfcY14nF9Og5JD7tmTnFrqmdrPozK79CGRq7WZnZvERVcsnjc2iedmR7QsB89d2sD1st6kx6Sp8aEGpzVxdk2nTmo4dYv6WQ3TibFfZ5cmwtePH0vCYn+N1UkFG/1MjlRAV1itGViGbg0hiy8TI5gIIJRlhZbvKtoNTMOf2DoVFrlrh1EbXqthn/g3plTHVa6KtiUOw8VT8JlaIphBKdP9ulSMctc6TP7puu8MxO4SB9lOicrIlgwnZG/g4XLQ+nyBykNMiIFR9c8dpxxTOJEHs440Hvffr+hT8zriytEwPXd/MDxPQU97mQEWZwgUW1C9ViIYbDBfItLSJTNnmpcZOPU4KiOyBUsncmXWuf6co+VMjOR3TkuxPV7z2C1zPi0kjqACt0BE8ujwmv6ASkHvEBhp7iEYiDyNaTPQSYNJkNC+aKXmpCWpnvcUvLXaIAVZA4nViAwHHMwH6nmRIJxWHrI5P6gzrfklwbwb2OO9RN+OlgJSUY7e+qivKDHLk5YCuRCvCLNHGjZ7rg3SRy1D9HcjNztTnG2Vjn76gs0ad3+6Vr2Z6C1KkosmcfSo1BaATuG61sAiiOB8gJzFtcn0++Ax9ZP/nUo0ZZ8f7VEc2c8GqO857SbmzMvxvaUXBj9Gvz2vY0lGPG4qh5cCysCl+qVKjC5Mgw42AGjbqtgl41ZypbzB0A/r+SCLIcq+ZC9bypmUY2pDV32eunvICoC8ctmVM4VxTbpHw5Ikn57zdx6fzktpr0DyznFwrOPVQ8k1oKE7dPCRHewkxR8A+gJYAhNxN0CH99x5FJMEp662wypHh4KRWenKFah1sqEvMRobunJcqb4aT1CJ8RLHwvF9tENcGHKUwF6jeeJfy/maGSnZthg8QhWXBw8H4xjZ/thf3UsMme14PHAJoNui/RmFLgcp94BuAHc0N7ztLm6Jv7MMPRWMWX96ksOToxLXGFIH453rfgD36Zt3h0U4wJRCEfK0CVkkpAWAhqboPiJ/EExTmdSSvXYyZGTyaNMGLwcIkOOpLYTalYJSLm9HiwEOZv700MvfIHhaEatcISbR9PPcwpTdiC9kartk8dEOA5BmAmMo6zDYW+PgLYuMApvypQPpyFGy0vRhWnqslR4G+ni6Xx/RL3mnwq2NWusc9MLgr00VFXPIsJyDHktnCANQNbENPHQF6GkM55+5nNJrgJJNGMySkBo2REljRkUm6CUxFyqSolxISVggKwHseZ5GcggsUF34AJOeT4F0dGBMZA0BdU8AMoAkMnVUYMYx5yFbQrCgjix4eNRl/t5rlKRMdAzKpaphmjjLnDIyhpZ7TED0xdjyeABBPTkzD8KR0ByHL98fcW7fYulB8wkN4VjeCOOTBC+BRF9iAzoL5i91fbBkGIVB76ZpyWSKz66TCcxbNc1UCRqgaYcMuoRpzo/yQm6Gs6lNqYPMIQK1U5fk3zQzYyw4cT06m6YsbBvp3b+fst/LE2yfa+KSOdNSesnag8bbCpY3UmvnxL+UfpK/1djqmMU4qcmFbRH5wGWduq63A0VigUjQXKb+b9QGuyx9UpCAhbi/HDJdsmP8C7cm9eUvkShXR+usk488KYrMaMXQ+lgLSOzsCveRkh0EmsaU3/l3jorGg0Tysmi9Y6HXMoLeF1vdp4Ca76UCe3Qb8h65NQN6WX+ngEpl2JZQ2ob20K9JygYBRqjiB50COTonGNE5SFanEBAIgHNfvfqwUtyu1WnLBALAUhEbgoDaBmJE1bS48ho3yp3ft5E3+QMBMGYbMzQczlTylDYuM+VJwOkwiYZzbphZon0jw7UcIoeplV14Q642nRmFKKEzhs9VnkrHR/dFAridk+n9tQoqxvSj5r65hnk9yE3qVNNryRCIlEF9TMk8AZEkOBJVbDbPtL+GPHikrDDnNPgc4/dblvqGwH43xjqoBh+ao1z5dnL4XqU3c3xPEHMW0PqWWuorsvTIWUk/C2g5jsDAkG6HenXwcI5zsDTaBN7SgiA+3++xFFwMcCGhWQMlPppZLGiLwOmg4fjFwRjGAAedZ8GvxiqmxEEHYVFCuMlndQZIpg9LIo5yVIMf9aGF5KSLjWn1Yf1RAGBh17sx587lpqMiPypr0ueizALqBKBDuIZekO7n9zmHPup5+PPgW8+TvUhWMwcN62ctF+gYIOKYmTx391gcOVjrSQBViE+HboiV5jVpq8acUaibdTGVgdM4jV6M0URPeIvxJchyorcnGT0KH7NIDewxRHunnHC2389/4ZqAmbpUjcE07pgZgUrdzELBGou3eGiWFBJ5ns4E7H2EAJitcTBxwzwbY8gZigZ88TYB9I1aCNSSE+dGcA+DsSJT8uJcsTrkmQadirYpvLuvrEUg9+5C8Am8aGeuXQSdokXWtZOQNbEjuuLadDtG04mwENZzdiRjIDVpIvMFLrdMZ0S33gmZ6LW38m8/S5mNBHQ7XESn0BwpmHb9vIqaOI4UX0KyCUDZlqZdG2RSsPhMmhhz+T5BXev0O/uAq/B2I6xR/CWBO8Fn+ZhqAg9rPviojHvS2U/zocdphygaV5tfXbcgXRIyhua3uLaPooNLiWwU6cw1Ocx3drvhvpS+HHpGI8fgo7/L/m61YZazelSy9V/2gUFLDkg6HHpNX853BoZ5Pbx/l+NrvdSQB0g39TCnFEH86EEFFPlBtIf0i/SujpoXJBR1ZO7nZ4OUARrzG/zXOSEqcyer+gduS+WASIc9Pm4Db58n/Dyov8z8VGdTJiIdykiCAjw+VkHhHIdr2HLor7GL7cyIGMGD313rQSdyD9nxO2Qy52G7xiMKxJPBC3K79uXDto1bD2WbRlX+kC3Pl45d8+3+0t24V2V8+hnbAuJ3eMxslASptj2I4bfd0LvfudbeRQ1KnhiZgmMvPojItuRscQhACeEZIcQxGe6BH1MuojKdO/jFNe9Z0Rn9kM4MT/dAsCsDHqC3xqI6KcsxL/NbR5kOUsgoUBhbkTlzevl0GhDp8eYg7UQsDaYEYM/2EBK+NbwIFfmFb2tLQIUqFqIe9fIn6jLMWwv34KFRCSne8QvSl/OxrJQ3nAPEhcKWjhj9pMmg/zJUXzT0ThZrKYQRUQyjwvHTCnXKNsd3r105KttufnrNn4poPlVK2kBK9tF4DQUcjmxaTmam7AZspuN7/JH8q7dDz4Qlg8riS8+tJhnGiWkIowBFap9D51rWaXA0c6aNxxxc2EbK4Zik9InftVhpWWEMaTrgnLOhIsY/Q6ZPL0P6Omp9oavf5y5f4uxQpqGhzphwPAP62P/U4zp0tV7Iyefx8nFSpqB7ZH+kXN1wV8hTp1M/YXRufPKXieFiqF3S1dOmgEPfRBDmmdUEFASwLY0XxxkiJATvUKjCXwdnkK4xoGrDnxhz93JePyTMriq2jcwrygjGLTmLShyqaibqg9qGR09Pgul54mZZhHrLy8Gyr7y/cXoKmqg3vKshR1+Tvs2ry123s0VLNajMQv/cDuNqXiUYRmbfboSh42zgSEsw7dydcZucKlbbYNGLv+5O5Q3ChoWM9z3rtCiuEWH1LQUjvRSQUYsAdoykYPI2wO638qZ6L3uOlD2l0dtjZN0Zz1WnsrHCV9EmPao8XF1cNMHEoRgCfjIhfUSqUKJoeuwEa0YQGAWkhNHR94wKnd4OI6rAJM4XI/vgJgtqBspwwqDu7Eaq7+YMAqm7svmlMkXJdckJXhZKf24jWKwcixgJpTf1jKh0yrqt7jBUBKCE1g65ZXFaijWizZgyLxYZ3Ex3IwYjnagNv+DSzsRFXowpuRn6yd5y8M2Oy7Y8NmWcJm7XhuPzztLB50FjOr/LPVo+PS46ml6SM3BLhGRxbVxn6lH5hKBz3u8yS3D8bbC+lPHjfGPQmlssJwnrmZRDZ/FoQCdGDAwh0lKvJlALhzgvGo5WrrzagWHBm09nG/SWEaiONIaWC2WlpwGfGD/FLVN3ciU6ys/+OWCJGPLv+CrB0+d244wzPuS1iGwmBmUkBl1EpSELRAKnuy0/4w2NzeEkMRnH75ZJ8kF6E/H6OHTlNCezj7V+B+fWKfKkUQjdo+ZT/27rZwkSuJOHNWRHfdNIwR+mn5AHjwEALqgjx72jqMa/O7MgaQ6O0Fh8BOQLiAduL2Ng1wI4BiEZpU2jboI3w7TRSCqTSjcTNyw7Ocp1ltzgwimNJWFKchSDIwB27tMIyDMv0MvttgQIIghxssVvrjNxPJEivMjWiGtwpR5OIw8RSXJGA54J78finIAV3pLCRoWRrehxWDBG6NDn6jH5e4OFSE5hTbha9eSdnaT+YkQvZddS69BKazeEeLtXjv4snJSt6ApKwvhOqpKVQA43yO60Aud8YKaoa8xMXdO4zSWcMV3Ld1AeZEpOJohPLV9kzKjavQWA09i3zM192EyrapI0OB6ntvM0bzegyE1FReHRniPpecx935ojJM+KqyM1Bo+b8scPxxpTy5FBdcg7hoNgj9LFVHAWRc7VAH8WNgIjAxN2BHiRlrZLDZGguMoJl+EAcobi86uWSYFsBI5TGDkmkmK7hThami0HIrZ+ngJovc7xRuteuPAZgIyR33VbN2owZLCJImzk4k4YQ26H3PLCAOikUbS42xGbpK2bXpOIJAgY8Yb0VL6OjN2gSwSiT9dUG2ie3CzF0BH0sbyUG9O/HqdB6wYDzezo5ck9O7rRIOg3HvIrnekxyBkatSs1nmXIb6ppa+pkFnnCrmT7OPbG17yRtdGGrwGGcZ8jTZ41o2P9j7klgFy9BDD0d8zm+K+2VKbLJpaNGMQ8QvoYssBGjj8N6R4JpSvP/x7ev+ZsgzOnIYORZ8qL7ww9HsQbAK4HsiMhClAf98iMA40KgSrdfmA6PxQCrvd6PJSKY1cD5za8YpGcERdfH1qvathR/8A1aU81Dj5EOyockyq8g2msZqYMFbSzgf3SQaikTYz5AjPiUSHKNj0wn9c025gMUD/aPOZjVInhtImHwKgrgXX+rICSkQnKQ1j8Z7pbbl7SqbDcRjuY2W0oapfDSB563DPDQl5t1iRweM2zzMm/htckAA10PRge4G4ByReBxeTS6yweys30KNTvrZXg+jDrOqibSjUWoUHhyJYdZfiyiyMl/yGjLR0CwENjWswGpoyFj80dF0z1m+HRoHkYXQkVMA+kgmQltMVUAVD6e/IycGaeRPLjmaKJIPVWRjigiTua7xmh2dcYzAtHkDPzQvoxo+aiRpKG2JVqnHwfy97t54XpFsZeqJ4A4ol16hAxrzlDj7gQLo1pN4ClOVp2uTbvoc8skEiE2eaJp6djnnp+EE/0m49NNiETS5m8tg/oytvY4jkdOfa/ArX2oy16IflyP+xsZnv8L6bsZ2eQm3jMQmdeRfO5Ql5ZVgs25YZ4Enf1uXg3ahJYME8+MbuWSHkAdzJI5kQPjIZxCCH/KIdVnXPvuLxXfrfayPD6mxXQBQxIBK//7QnoTaZX9KYFo4Q6XagylJvAYaM/9gkPd1uAItZQCaYWMGUUchaO74a67PG53pPMclxkIMAT2kz09CyjaTTSkbooKG/40AJ7G/XS3hOFc9sRKeYbVDDmnxxJg9Q8hJBAqLQZQYRNwODL58Zq85hsHmDDH7KXWvidFbeMvZ7L7MuJnPKKZBZ4APSkz/bqJ5Uoj1EOJwmQ7NvDC/2jGIp0XqRHHN+Ro45Ke0LpaAtJ3qYM66SUDVUxQas6/Az6BQS1k58hWcjWi8PBgnWfmR2OD2DkXu1QF8iLUkMKuWnlDBQwL4E6nLiobVAGHgpaIHnOAGcRQy+blx4A9dpawbMuOMfazkpqcBkhxNpobvj41tQ/R+aw+9PPOTKPzRTSWLJFHU6UA0baRdj5HOQbIxhCQG0oJ4dD0K5H0rv75ju6KA2VEcnetuyDz1LjZTckpYo13fWh17W0MjB/6LlUjzaBy34thN6540yNMF/yETe6EJom9gb2VZjHZVoVIueqwrq1TMckTuYgcE8s+yyZqKifReWlzbWfXscQU4/7GR6gbz8uoB0CuGg+tanwAuS1MlkFSuBdHAmetH0GQxKtztzy/BvLdwJdBCglF8+Mv7au0UWHEG5WBmDkreS5/f/9w3WFIbWt2DQKBDh5f2QejZrUy38pULwYIQi4HWUdhbi9nqV1ZrD4roWXk99cWyH4T6FwSoeAPyN2wn32Dgd74ANE+dFh4LyGzedm1DFEvRV6RPrD86bQaRkjTC1GvaThVmTWYJN+Ds0T5PjXsxvOgGlJ43GMWfgSYw7jIc6XtEIU8O+TAEUbIovf0Q4BtdsyBtIeZ4X+bUai6QUaLNqlYJYihny6/xgFkejTxHxxEqRYvJkMgHZTsK0jzeyQ0DJiKh2G3Vmo5mUwW9BKS6N8WySVyXUFyNnKMascoI5vAYCkn54P4Cq3pfkw+EPSbhyFs8poTCScR6tybt2/HFM580QD0+QkFOfX3Bnj101xfF61AM2PIB9JM/hnGh/pNVNdMWgALdeU8yf312NAx663mEm5kYxN3k1xbRpJbvkFT7VjdsdtDdKIDnRs7FzboWRnmVx3TqlK9jg3gw7yNwe/rm5GyDfmYJ2Fd8YER0zZnLQpvc5bmpFkiXLavUHJbURF4xHL68s8YAyhCDhE6HTAqiAQQ1+dWcm9u1aCuFqT4M4otlF4MZLuQ644Zxu9ycObue65BT1qw43obl0x/0cbdKhUJDG+eq0jfyrdaEdiWeB66DJepzFMQMV9AHy8dY6ZA/CaBr0ke55WVU7ZYF98mje2YRywU0+tA7RaiNBAhy5kzJE+W6sr923uqCQESSmWpJZt9jzpcU0GZghcARjwxljlgNglFuBQFr0/nQxtMetK+AO4ACma2lV/PfSdMv7yVnkoEWnXcz6WXBqounRCoADi4rYObYK/+Gi6MGMkqGpwVVLokOHUnLXu35HKvuZJU6Y1A+bP7IMKyvkA4Glb4nd0xNHFjVvtGxgcNRk8g8R9raBs6MnIesUazh+7CNOCDOS7NI4TkBOJY0KDHwQldZFjvLe4o19aBmQg7XqLdweaFa2oJ3QQ9jTsES42FMMbvLpvrfNv2VtFgJIeRT1UCrZCgN7qQuPPSSsIrI+6lWHQ6fVO0SOJmUqdalpfNmYcBYaODt3fMLSgo3lDXDcs3XL6nyn8tnajGNBoGdbn0dwKDjM6ghxbsYMLWTWX6Icl1RR76pMgMPU9iFHLBdVkRpAPQ+ckB3PZkDQL5wSVqeUMp9zqGYDFd4ezGPwc0h8LyPzXux6UIeg9oFy6lpoBx/Is0BmUTNWqKedLmgWzRiRMODBKz9OV/IU9NgCkGbHYY9ZWxkN8wm3BkIC7i2V46gcJG8POHMSu/lRbIC+DGk+DHWRUaq8vgiUlkKftllafbdrMR4xaDTsYh8Jljqisfw8Opz7VHstAp2m2DFg1QSZwkoCu0WWbgBhQxnFDqZK8YQppwjGsNQzOOP2QNDj+2HgspQk9Z0GRBJuvNJDx17AjslUtNfqahgdRQjI1U+MvQJCfo/+d/choSnkNkOj2WUSn9zTuA2Jb+c5tLpg/V3O06bXUQ/G7SbXRGS25DRPePzRtLVSh39tAe02mjdtMCVu4FukqFk2gMBDbADnCocwYSMl4tkNj1j+TAZQNRflSwtatpld6Dig1HJI2nJYIy8m8yEZ8GcA9+BKtx8rOq/CRk2M7wwG0eE8BF00sr4UFKXqMiQA1GV4elV3gw0LDAZjZfJqkAGJuVFAalbLpIMeSSmd1DkFS3LLHJZ3TNhAnp0KPOfG5mAZj4B0G/iXPKjGdUtjLcSa4Qf3IyMXocHBk0l8hVxswOcI0OCbgMY8g5vNCN53DTcF7HfNyvkcSHdh3jLDBkT9aio0BsM7Owus54NHu6ezWXxp14zAZPoSJvBt9F1+I8THOGcouqzL9hHCe9uCFdb4eOShgOo1faqy8E4X4RcfTtOYPsS56ZmYeD1oNOU3ulmseLok5UyqtLDN95PW/9uIYBbVRdKoVAkjqMMlRAD4vaAmdgkanUxFkkulmJskTfoA3lEInvFHjUGmaJIiRHMLUMMGSY2tZGJ52kGmZteUxSfROf7QlWHTFlenoPmh8KJCUsH6+ptmAQC8dLhgJFmiRlREqgiLoRTswXAvTbWo9Pr5NIOW65YRl5MjSJ5dinAZ0pMGUU5rp2TBFSy6Yb2ILHFOy6K32Tm/V6wOwGhRlZEeFcbBPi9zB12jvfNijY8aKpqbxdcO1lKQtdTHkumi/kciVPsNI8pug8whEg0VNho4TixdnIR2BIGmsh4LPLW5l181RRUKkugBsGD2uf5N3oHym+TlpA+ubYzYluuEWGmAJOOlvbSiawNG8TWZtmSm5yXRtYPUWKU4sIoej4sSrqBKwqZsGkttZOTvq9EhrzLoPDRfQ7qeh4sK+13z9hHfWEMvkuFLum2Jp6vDPsbeBQYotKFh/cYw5ondFuCU55sIHU0n4zc+CtGweJ/nu5QyjNpvJ41+eOVJsMR8SWXK8bDQ154hj7rNIu1hhutf3ATuQp2wJQ7pYlXZA9kJilZ1q7yOnuYOn6Q3SlwZ9VFQqg9CZaS13cZ7uQbRl9q5G2ev9y/O3ofE7dJp0LLaWnONY5iaes4iQtMbExoPzXO83zRXUN0au8Y3+nXohwUNMXcHctFORIR902oMeeMCGLPvWvpC4DLnq9xaBY1REA0BkrdHQcG8RE8PQWAlnZB8EQ1ZG5gSA0FrfVEDr0RCIIKAbmIq5UyH7/UFLrvHFnDA4ztEHv5/HVdIqaO6hOZeDM4yBnLh+h0AvI8tvcvDc6cxR1u1u53D5gfpougmgQ+P2ksRUuNdTvrxToUBI5IOj6fA4xvwzT0eD/flGusGPND84Z5lqpRZTF5kYuJwKh15VbHWCMlCOdK8hxuR30Ah0nwIhwcZQutITBBT9IXFcnay+3QinBaALl9M8vDUsfJ+fkU10HLztFINO7DepgpIN6Sn5kgMYyU8M8Nz8eSgJ5WHML7dxIcaYGc0eYE5DdMiG6cPPCfrZJ2MqE8W0cOvDka20uhpPxFsOww73oQt62cHTEbli9tMpYOmBedujbLXO0XWSLcefbF6H3ks1E2BU2fjHtibISwcCvnJ6dR0BlWlI5DAaRtJ2xhFejgQqaOMuE6Xo3V7iNdgQ7dBZDOxr2ZIcfScpn6OOhzQddBi6gbZtWx2TnqHvhzRDEWuSZnqx/q/q+3JwWCwo2WrHp2a7RssJGW1qXm7wICIGqhpTtg3kDgXS61g6p4ScukxyLZ2VTiOgn00vV7baw2F0Mr0nrYtqIIkpIPJ0xvMEEg11GJ/uvr084rOZcoKM190l8CAm2DOckkXPmlFIROrudK7La2lCkReBqpV5e/6eaLgf8efmuSE8dlo86aq0DYxTQNrjdRtK5IvMncIfusk16RLuQdg+aSsu5reGSDrjBmRRQiFg7fYFbBOBDt7bQeipI9FHFGefYDheDc5OBrvpvGFCDQMNgRm3UTXfV8qJ4AqVnQ8oq8Co/IDTZGSy2jiyUQyZDxl7A8qIwHJE3pHwBUnMDqVkeRaB1Y6IMaJmwbFfuf+rSnQavigZ2IpivTTATI6iW9Fw/NyyUAamvEHiHSdmJ6FH0oVIOUam9zTkYfBY7Hk4PGI238YgI4DOvPBdZnhyZNZIT/KaohKmpYB7PKMlsQa86fBNmvATRoIzi+SJ2PTJqI3giBk/kkokkNMU0A6nlh3XCjFapHEhJqHjj+pvGgnPXEfquaA0nO3ZxLEYExqOovBhc4skddDBRRz/He6XvSbLfEegSsgk9MzBoyHf808gMe9bZh0YRjMxCJwqQGfEPwq7VUOUzQf+9VH2tluNQ3u7aLDxzev4Zq7oY7UY2VLSxnTKbdkX79oz0Q6/no+XZ8YZH51dm9HOXF6PgTUATzwIeOLDoJVgnSkS/xmGSCmgIQhDsCm8ubdBYVRaSuQWQTCV1p9LXcwHSKBk1GfkaF9HhjMBndk8gIVzrHlvMAVGZu3kOfpminRESjKAj8ztL8SsIz2qRzVEfkb6ly31OLX80ltIkgMfAk8vQpEFibpHmjE9X90Vnw0EbcxV3KVOhjdbhPTtfBR6mEcU4uGsmx5dtT491GyFckTctyv2dhXxdcxnhKJgypKOzlH9T8Gf4riHag1cRs+/TZEz2jnGoT+hqvbzUpSTnyUDYcNNx1JLBynWKZNDIQoY+AOam9g95ZsMaNpbAKD+aVwI5kopZpaDLVpXGxvgmSuGeA/njOaG7kH6M4jRckGRFQdWwOvEcUyleJXWt0WHoj7bG53+9DJRs2boSzu5+o6BDRlOHqeCAeKLCxlpk1oHBngYc0y7Q2ZtAsFgQo5j/6wsac8z5mvBbZspIEz+3A8qR0qB7fblHh9jS53pwL8KIqZOTJ7q55GJNTmsk+Q5CTPYf4u3nGMQULm9ayylHGRo+ZjLGKygx8iWxKZm8Bhd0rtb4dkwxLVx6N2UT80lx453yojsFvQe5RujbT3C03LF5+aZxuZ9+zIe4XFoKCoUPZTqiLkmnefdO3l8m0e/ywa1HrrdizzTLmPe6rxJKaHQmh6diARU1digOQGMR1WyzR4FqgBlWBJwW4zRypWlBkaNbdQQaG79tAgmQA3kcaxkgKsjyoR4ZK8ZN4Kp6Dt2S4zJCfCl/3qBvHLkRxBfSo+qmZEFmcLYCkz693YeAPL4MyqCEiu3lYvj5o1fO2SOJBOBKsbkRROU2+NgkN3gy+0ppPF0gftpHUPJ57J4UQb4TL/m7CPHD3L+KHfotmteygDpEeeJMvldKNXsSJSGeMQ1nYVYAyUtgYygz8IgPxrm/6DdpIlJNMEcOI5/bZJNXXFbdtJYz+AjWkeHsmp2kAY5LVMyVjayiiACltXJl6Nq3t9z69SxRXaAq+IQQNH9PAjLtwO20wJGXWjKJ3Ry4ZAnCtCZ4+k2mPVkOzdRcDRmaWCa0ZCnIcLtRZ9WfDs6TGKmtqqtG2NqHZFTuOsAJgCqxkdAy5nkk9LDpNjg92w6h7x6uQx+R0ZxyD1pGXl8rowuZ0v85yDbkT0yZP2EsjOH/AZ8iY0/o85Yv2P013vj6awlhPIHMubNPLOcT403Scd+Z/TD5QQVKA5+Eme3jP9gY8uwdT5Pm5akwxYP9Tn7HrpaNjclP3burP9oO+OgnK/e6AtPVIzg5QAxJNFeykxRzAarOzNFKaHeH0iFrwdv/81hfLMKgHnYTbhtbrXY/F2GkCnrcQECud9j33uDRx/Ke0MzZArfpiPAqxqBzCvoKVIB5LbI8ySnBwLIM0AX9RHQOPchIFSOTgcXC0JZekqa50whGgIGnB5po9FKAPt0d5Ti5aNHpG9VYcQhx6q1NdjXAa5DUci4WUvRk9eacIPBzApwXDJucPKQBlVpbMrGYWTgNCKm8bBxV81EA7uKGjlzYlwaPAPw0o14csrvQqhWYw1L4dQwI9joNttQtVLzyF1gAFFxYRTYERBZIhRtREJjmgAnkdTEDGNcaila39C75cBk5nJS9J0RHqPS+E1A+ReACmHlqAzxqiNR0ssQ/VCNZQ9AbBlkhqDnMw+mUpZv0E6ZB2aPrHICbVVwa/5pGdJ98KcBMA1xOA6TzwKvhNeAm/dGJTqBlNGRXQr3UbI1ZHoDeYUdlBEISvcFQWkZ7MfW+D0iZYAX+cxWwhlWOT9zrzqxUjRM2QTJkvRs8L7lyPfUm2SzkPWIMdno+FLfdeBXn3nJZWYvlCXW6Kl7XjYAJUe2we8wnY8877OxTaQzbNPpTHnTiDQUWPYyVvNhDx0o/bYN9gjZhDE1J5HSfTB4uc1QA1BAFnJQ0X1yoOl0gtYyeCNTT+5Ik4x1hMlko4G9TBdNOUoit4MHrxj/aGpBcKLCR3j9zTbP+z0LGH3nslq6YXAcveQxZjK01uB3VYUSXCV8k8BhII/xN2HPfcoif24rH/ovcE7Nq2usaM85Zlb7rjGecDu+dY6K0v9GQQIfpOJaoMJjTJQjkwZ0RftEySkCNFixLCIiSf83AaftEm6MQ034NBGMBqYCpAyC+KJmUkBCCWIhYgBVFxBp0OOrK2qrkBzTbXnf3KHHfkmM4LKqmS5DfwMo3NlDx/j/F+pJ/sbHje48W18GSYjUDpiyLnAfA4utn3OduH9YeQ6lx8OKYznCPC4bghw1TaAyL8m76H28LpRVzYOknf2NbEqmxqltm3T+KNPsOyGDaqE8dZ2ypoNe5r55jllLJnHQQtd1BRDe6O6llCnDlPZw48a3OP7xcE0H6Ys9dJBa0OccWP+udf1Tcc4jfdNZv6gq0UX80HMDrNLjO5I95O2cEnWPsioAgeV0tMtaotviP803TyNYMtDPbXh3zsB32SkLaH9MQ85h+HkXyg45TGPDJJ+wF+M45/HdzOTIrtBujcnwrBzixmxlJU/nN5a8vmw+yElxGoafU7S9Ts1JxcXNwDsiNVVRBY7plGTSMBBThvC2CmLWAZiSZug0CKO6cLTfRquP+owAcB1FHoGTaGRMj5WF5JuHBwd6bTN7XBYwrw9tzP3awUgEhCaDtNcf++/wSO/EEQIRqQKw4GsipW5lI61B5E0dXXosrxyWKkSD9JQG8DPN3F/toP2QEvGIS9Z36GKm1ek0kb1HcENrR05hB6SPGs3J1wC0nXMavS49IVfY3nlIzCFdGCKoyFzfJsqAgWl9aDfE6fRBBpfHqh5IFucY2Us0XyOAXHUgFb/hdifvyw7TjwY7tsYqxgyer35uUeqy5pyjXsB6KcG6iQRwyImXTOgAVZus+QgNgdazGCYHmPPlkKcQMBsgehHo21nvQW7q62odRTpNPw1CjLkksz1U6JRRJYbMrKSLxwKzcHL+ELDsIDZU1EzhG4Bm+TUO5SzsGiIy7VqMOc1UsEzb/CFT81maShz/ZaYksp32iaccrrJA7NU8kkxyHsIlzzs5yMQ4wMpt+iYyGJ8H20A2jTFUX/0w5zP4lcOpuTW6AEaG52DhQXcGaqDxHE4PU91ULy0Tt4McutO5MzlpfRMfweie7VrxrFPZ9iPEc457LibvnaoTsriFbMru3QkhIIHtsIlT7CCxOeXMOopc1b107NO7h2ZaBAD6yGOiQy0nj8nZeESlu1XNTQYNQjeBpD9J0hlQMBUENB72QjbBC+i0pqOuiiSJbFOIUu/l9niUNWB/DWCztqLoSc8/vZOh+3E7HKIzEP4TUhw6BZhDHJHL9JxjvKeoWn9Te1oDjlLPAkunJEtImgakesKnJ5LftF79wYE3ndLrRJAbTozqF/9x9XDPZg2wmHI26SGLReAyOGo8Zgwwmnq9bTOS6bf5vQyn3lUORR5y9pqdUmEUUQJBe+s8LIgTVh1EjmjvKMs9pkBxwixy88QN4oQKnxtBkhmog8Y+fXXxkeaYf3G2KwzoYS5F3ga9qSRaQtkjIBC/Qm3NqGUKlZZ7Bj1q/TTPZydfx+drHvUMA7jmdOiO6TjlTaIsmpxRFgJ1hslse+BgfZADPNmMdfYItA2aA/NodKdMexT0O3QOQxuFCmIGzaec6GcaK+Dw+oL844uNpxMAe4yHpjUWKzs3STXkjEuqwhR+1bUxvqgs+nfTXzui6JjGJJ9xe9ipY8jCBofx4y+a70P5Dgd4ZrIw9PfMA9KoBn8Zu9xSDOnfeTZAppZFoJ/PoXmWA4eTW/gsLwwYbh15yptlKAa+Lz0np1FyTQqgd1y0JRMuHwXiwxACKA6W5xSA91c1krhpjbS30HXE0d9zQCTAqTipIiUyiWDMGSu9TuXWOlgLBKtjCbjikZB0FK3RwNtJcYQ3FF8MDbVtRwFNuNA4nq8JXCcthkQpKui2oZVUb1nLvqmqGUwDlwKQNvDjDHadg97ZDySw1pJRDiqh5jm5FfKSq7Me17ZgCdMmyI4/juCbD71eW4Z22VANZS05ItalcA+xe+2VcoLaLhUEu2LsvOaViWKJE6t5G8y8FhoqnqqpsI2e6MgSaUuPYGHB981bfX2rVvOvs0HegplWUM5qPFf091qyszoeVm5YdwTOfsDVx9TlPN5nbUIkHHVfp/6Mw1woC2EwB3A8z+2L1q8pFquothM+QYl8aoM96MMloBWDf8F2OZDRL+Y8oe2UobM3JhrxZy4MDthNKGAQqNPwJ2k99ISHfwUPaGl+ckzamjpIT17KYUx/PvCD/N5NyORIm9cq/OwMiEC7PwsRJZpO5v9aUUtdfgWjaySGEQ1A6VNMvA0t/0JjFOnMi+GlSK22byrNo3PLOovbanNim+WgjoS2w6nPYbSnoSWP5RfD/UURGKr8T/7sdzk/GvPknOg0yBagj0Hf4l9ex9H1asp2IuZ4EqfuTIYQFyazaOta/1QHGm6XGUjh6KDHgTctG8l3yApk8UkFXBOFhnJqi0MMRtNjkxA0QQkw2SAZDQxwakb3QE9GyUvszxJwhMVUqgkmYRjMn4QXI/TvZEaqndtVyBMRCZaDWaQQpWdvPF0n82BgtycwTOBYy1YVPo5R8IQ8Gg5daNJpLJGGzN4bcuAyu1g9ZdQwFIDCLrp0r6pshYUJHC0jhkFntwHRKPUafXqDaoje/e3UnN7KqsLL2/AqANWYkP/jUJw5NhL0uGxOfHVzepTecivoxEWDN+yUwsDqfNWQf3CsQ526fQMR4ENGKAtDCsfnAjtGXGMeAMqhWvCSFL+b5CLohUFIyyr9ktQih9M/+cPGyZtMbchxpgT64336fvVgVtwsjQ2uEKBqjbg6OQrZ6EAB0JXFMhGT6U0gGklMnjQtgmnhgYPgnMOywBG2sRZGDJ7QKU7N0UPZrZdHUTUgvdPGDWKaOg5vj2s9pYwwu6U5k5d7jx0+pu7B0/lJ63F9HJoHX5yr8YeckEYCsTGOKRKTzZSb8cqBie2ckniHru4Eb9PTe8kLolI6XP+m9spzMW/qoZ0Ijjn9F+TDoA8NP3fzTHt0pHnDr4FOHfXNmCtpPfqEPmMwosLpseNDxCWeDC/giPwzDxmYMkmV7dBo7Bk80HSkFbrhONo6IFgCq+Npd1ZOOk5ien27XloyxHyuJ0+giopu9UfVde4+kPJec6y5jhhV/waVGABGCoUEjc4VM1tQtA0rZKC31JXElaws64AMY9OCk+W2PAqXed/zwqgg5hdx6FWI30PosJB0kkD6z+/HsoicrDbsGTLeNtgj5U2DCgwjtXzIU0znYCwHTeEl3eWwTeDJAToe2uFQMbrfbvuoiyA3l+fGCMLOydzszr4StGI1d2qFFztnBEqnVhM+QON0BRShDJA7bkrrFIKiOUWOpKWJkVNWBt+9Pq+ODU4Hz5uObHxz7hDvCR4zc2YgITA7sjDQDQvIh2nczZ7+O7f1Thl0U8KctBi40jL16ib/gDON3jJYUeYE+zkYjPHPxHHLgQnWDviGH0otQdgh8WCTM5CD0PHtpHmOn2vEbYPcu7F4GI2bwsRhac7UMzFL7Enx8HBOMmvb7rZcZ2c9JAuSPZuWyvYNUVRhaMsa+op08kfOYGrMY3VtiAhl0Vm4oV79Qh1ZvwE5CgpcDjtEytafRVOnPoxRGjZsC1g/ZpEd2D3XlTNVKF6O4ZTxGkEA424B2CEnZnT7xp+h2KwzCChrQHpEOwZ26tFx0on9PnXQOxpIs+VhODU9CykkRGEgp4Baq1YrxEKsTgeKqnYSSpnqc6/BoT2eQeie0IqxVnlOSaCpswE0nBS2FN047t3Ctg0IMvrEDk/YOKX6b0gi9UHRbR6nfgtk+tMMkxWX9+bIbSOUwtYu+RjrOgFnA2gRtI+X4jWiAvSa7wDPOP47BXAKYvd7TNxjmClOF5uxvXSan321wHtuA/H13KCbwMwUlBzCWZs8v/CBO2yfytBispv2wWe6jxmpB9yvDC/6vWT/AO9cOAzsLDysh5SGszzROfReLhndluEhTnB9CrzEVVSS3E4aHSfH9XP6M73NYXgZWQqwj+drjr4weaIxQaqWotRtt6ttizf8Fo/huco0HIB/yytnAnVanrZSjrbGNPVLTFoQrPnV+IZ067nQ2dYTwwibz5MHOYS/5Z79MDiSgz5kENYftiHne3jHxpc5XmPI1OVKWaO2EfqNoa9AH2xRNL1Y8nJ21P/o4qJtfmgHSoR4QsSsn9OHSpFHEcj1LRxeTpOjNGz5z9iFUpX9dVexVt3UxkCl9pQPBwjAecmQe0ZC1wIDqcNYPe9r/XxlkDqCUwJkO+Kl6rsi+BzLHEO3sCgGDHy5XbX7F2ZYI6i3mJhHQWxgKF1w4ZbvNYGWitfcFsiTswheIlZSjadRG2mY7jMZabGA5uJIEi0Ei8eGpj2RvpSvzi/nxKIxsddBuHUCU8E2Uyxco2ujhxgFaw3Ynd/VXNcAX8RNQdtNCj+H8Ax5qUd6+9jKQ544D2Yy0NvyRoZIB8aUENAwsl97djP1zDEnIMUDUmBhw0U06J85uDBNBD7kY7h9j0XslkKSdzKWA3SytMe0XKnzHMh3PnyzhMvJQt51P5+ZvY6dLdBnAR9PrKOSR+Yhx1UoG6pLYDRypqBpUMsYLlqzZDTKMcCODPWEP/duCikbhqFep4GkgzdR20HhAGLoa8lFehD+mE+YMRqjDVCNl3wLfpjp2pKmv2xw8zQzpZ/ztFB+rxPNhozk4CNjEM3vmBgBc/RJ3jOzRrI07ngp39vzJj+97GfQWysQlwVc+gDUcYQx9XSSVRfrRCpxZgykqU7pW9LYDOOYN/rCDJ+K5SR/ob7lwp81ph7rHraoCTbT6tgh/5JoMg2HsvZ6IJG9jCmHRzxM0/BmC5nW0xHVJ9LOTSzuNLSuzVNlKUJDlLh9mHQRNtMOSOBsh263Cw6zKro5vwllIQ94hP+k+DAymNRpZAfC51a9ql3L0VA17DooO32ci1zb8PinHEbXQOlbyibKvklMnyuqJz5SaJRRFxZMEOj5BLcBcgDyUKCtTLp9jIuqAR9/2mTPATae/zAeTWV5zOxndYyg2QT2voo4ZZiB7O2AapJaEYlj+8QBOEVMZoVLSbsdDMa2Zu+kcNRzEprZp57vAkkuXrPT8SeTxsSAEbDTZKDSnrFet0515XnU3KK43+tBIYwnEJTcho0SWnGCSUYCFKOK1OkqtZWO32VtL+EWlow+ijVZGyrAk7LdDJrGjR7ujMREI8rVMCaMmq3KfO9cJ4xh2Fwe0JxtXhJANriM0sADt+XLk/peANJDdRcmrmM/Z8uEoVE7WrxGS+ak+CgUD9OmeEpQolCM7a/Urx4rQZNGE4ASYZz/btkDEq+f1jfqSzSmyZPtzNzsOzi+1NgrSktgRJiVvEpt5zX49nxnBbpkZjiMPXYa2tNgcYxcToKMVfV7zk3GEZXD0FQJrDREXAKL5h9T3LRO5GM7ojlk2bhKo83ByEQdjnWMMRA7tS1RRsQYpYCAy2AmwjBgNhKS1/7S7N+wh3FjDHJkwZJjiZ4f17z7gV3YQOmcwULkmI9kk+Pn/PkdMRRQtArbHwCuk5ny3gRfGu6sB+hnFgnh+e29URHopPsU/gWl96ecMIBM00Ny2nLIYmW3R9tQrsLWWIyvZmbLjXCvf+6xk8ex/Czh1FhgmZ8n+Qo9W34pGtVu9XHHDqQMY/Iy6vIE559mdPjRQxibIRaQdTRO74mTCgJ0C61SjsljaVPCICOKRMMu4UhefDkxKdkpGV39mRWNuaO5RkjImL+bYQflIUCXvN0KvkE4cwsoYjAmh3G5LcybbeYAUCkZU6902DjEkKxb54eSy0gsOFqiI4XQDX1WkeSrps0A6wPoOGb2ud2OgcaV+WKQodsT6bPcc1Ox+f5kNOdZnNsJ5DMQa2Gthcu6tKF/AnA9rQlBVohyqX+fE/l8RW3wKIfgoh0WOHgw5UNRfn+wwGfMnGw66OrmTQW3U2WKN70jtTOgBjAOvQmfWoDBH+ke4VUGnOpOJxh+TtEfOktmgzF9vHMN28JVuw5y7Lfm2Oy8+NbxQZtwW4yXK8NFXdzI7JCyjfJpJLu7DTxv0iSxYuFyuQB3C1hXIEZNUqbOGUDbpPKw74Br4tqXvdDpTcCOIeWlJ7NvHNzCNEeiOnKYIksDmTHAP270QVSdaHNAj34mfu7SwxWhzCrllG1NbCLPLSN8RiZB0phNHgUp68QH8xSaC50qO+tTJvmqheIweAPP9E6S7C0jB3ZwWozUN8rxW3I6AkvFn4lyVKu8jAC6kTrFlvprXUjANRMAlPHRfKmvnt8RuLZMT+4WWSePrXOMj/YG1mpahtnG7ZJqTcaeujO+HXhAnt7ZQaMHU95LxIK8ZArvMUBYQsbgyYVaE+wOI8r4IUQ8pbmGodCWrbk+ur2OqmNjF7fh2XmQnDShs5ksgtHIUVCpMPAYSSTtrcS18IJv0RHqyJ6pc8nnxrFXnkw+HO4ZfQHlYU6dULRuutaVlwUUuTudpKhrKuHrxslKE2facW5r7MESIHbnGGOtAZB2PDAdK5g+p7ICM5UfHUVkg7kdrDGEaDXIbUd8m08Cx0MWq7uNMtQLwD0A3BfQv3+94Isf3OGL79/hJ7/+Nr703sIvvh/48gcL33wGLgG8cRf48MPGW/eJT76x8fk3H/GZl8/49jce8fkXT7i7SyDvsXdg5xUJ4EJrg5nBMghykJU2pFxZ3Aqrw8WC1zYC03GUEEmScBL+BrgbfL5V9MXILsSXmMM86nRHaCmDzz+KDvm8/JC0HGwgOl3M8eQx5NV64GzXRstIRL0rt6KBLAN9AhOkxcFlu8R1V3brEoGHuwQuG9iBdx/v8aX37vAz33zAj3/zAX/v/cA3HgNfe1p4SuA+Ah+623jr4Rkfe0h85o2N73zzCZ998wmfffMRL1d7Z9eFx2sFG2uhlv1aXx1EhbJTSpuz6IqIdzhYxmRjF1r+Y/DfKlWkT2HwSKJA6/GUH0QH/onMMoJM5BZvw1kTLqIfcjAxkuaWGQHPl3xWZjAA3qw48jFDXj3uPOQcYAH5gR1j/oyeeXy9wrVErbWv5fWhi0WZusXgcaGDqfAYqrV16gJ/5DybxmJH8wA7C0yYKQCsc8T41ZmBtNwyM81Zzcn6kCE6wWNg1Nurl8BE2PnACumZ5GYYoDulT69mtBqMBK+gpLERcKvqotQxYqn4Q9jN6Ddu2+UYy9GQN0+QHAPM8Yp/5gFCOYaSEGiUpVKbBXYWVh0qfpPyyb3tqU/vmIc+MGJnIUq4f1YNMSLe7W1W32MyiKG1h5yBfoqUhPSModgUrpOPMhx2B9Kne9G5bXBxr6H2Ad8MGFi1B3pRaUdH7V0DDWDt0EkRmFEhSNNYDKF3+fpQFpsPuDgUplVPuqZgY8mA7P5yj8t9Ip8SP/qVN/H//Htv4C/94gv8yNde4u++d8HXnwLPG9CZvJmO4ghA+1qnT+YzHl4sfOIt4HvefsZve+c9/JZPvcJv/tj7+LY3NpALz091Hehqg6VLluhodrYglZ5pEyC7YSNajyiHJZ9LDiYdBVKtaWyJ58/h6UgwxlGCCWgvPp0GS4H6TEAZoMM6DdVnpzYA/iyGPA6QkEnn52ekaFZw7dxgSGHn4OrfrtHCysD9/QVYiW98cI+//Atv4Yd+8U380Jcf8Le+8QK/9P4dvvbeM/DcbawuGlkBXFafE8EtJles2PjYiyu+/a1nfN+Hn/BbPvUefsvHP8Bv/PB7WPdAXhee9hUrEosOPVPnw3geMR2doB703GWTJJAYsno1zrgpfOT/opGWDiRlhSTTM0VPZ2HYW0CR6M42TpQEYPNEVtV/eQwDCiC7zqyAcIn9TKcY0mfi/Fmxfv45tuI1jiQCWMs1OgjjSXqctqO2E/X0EtKUvDfW9kmm2Im42NxaDDlootqiFI85hLosVhPL2rWIAIYjVhBU+r1rDdr2b+A9sVEOZts71hNYJTp4PbJR9d5BfpMDd9FKTMWTdZHsciA3goCYBbglAEjdJmf2w20NsKr/LjGJa5hJQrRw60BWpcjIUCWekauMlolDYe1MxpyLOEp/rz6fRYlICsYAsJ4jdyY4uk4XYHBUzA6kZx3O/Wl9vrz0JWXJZtYZmrnt2yiIjdtxalGbrw+OSRE7Go8WsJlazt1JmEMGRhukYcJbm6IBZZIKXAs07Zz7vQG2CC8XxQAxKQLFpVLxGQtPu6Kwh4cF3AV+6hsv8X/7iY/g//hzH8J/8OUHvPfetV66BHAB7u4SD60QruwmAXt8O6qYKe/xvC744uMFX/zywg/+0keAv5X4zref8Ns/8QF+4FNfxz/yzlfw8Tc38BR4vC5cLt02Cbm5NIVWH26dRDsuljdrVvMfjP5awinyTYvp5Is/aR7P3TVyMBJQJduIhAheKzrDlLNvcQg2wiGSARyuv+OyAnmvArgEsNdNCrgd1u5u8TpmbueVdcEwniWbG4kLgMvLxAdPD/gLX/oI/k8//Tb+3C++iZ/82h32NeqM7nsgFvDwJoDrbkxA1zElsBJx0aEaAC7YufDl6x2+/Msv8aO/APyJH/swXr4Z+AffeYXf++1fxz/+ma/gOz98BeKCp8dERB+lzfoGhbeEnNbfEYXa7tExHiIv3lk5hSGN9jmUXOcvUZKEj0VYOguOxwdvW67UXY9rgRjRfWvh2fggsRsyUssQ0DHjr8tqyAIRv0HMbFn2ORQDV3Mj4tLvjy293BLetGXRYTQfilyJyNWHi0mZGm87CB2jkQ2Z8M+lDOpGY+I0/sNr1VEGArOAivVmjUSVWXEpY+RFE0hsBC79fG9XDmdRAWfQsnVu/hliqEwu+U9H4U7hBuDig4AMIfe4iShhelMpkwQyV+WR1NICDChjkBJG2QMyG2pY1z3285vpGi5+NIBS2IRH/fueUbrklIYokLFHHR/B1gaK6XeOb+Ji9DvJyeiLhQinPUGiT2XQcsv4MEluGkHOzQZV0RGFiigTFryiAddXzY8Rbkz/4XASqltnBVJDozHyG0Q4OSCaidNOmGPXOx6A/KjWNqfXrEw+g6ESVXsnXt4nnp4W/vTPvo1//Wc/hj/7pTfxy68uwMsL1v3Gw4dS5yrUeSWBa9S/lElFMAAK8jai6wUCUd7xuuKyajXxp9+7x09/+YI/8TffwHd/9GP4L37Xu/ivfOFr+FUfe0Q+X/C0A3drz0ndRHFNUzncQ+UHTRhNaZAxqTF0SryJYy3wiHhy8HCAgORVXaacPwCuSziiiRk7WZBK70cEHKU3ZVSJOmOp6rYwURbQ788u5HNGbUVbWHh4ecWXvvaA//3/56P4Ez/9Efzw37sD9gLeWLh7uOIugOyq8twd/F8W0HUEMQgW11tjFLisxIor1qW+exWBH/zyh/CDf+9t/OG/9Qn83s98Ff/Md30Fv+1T7wEJPD562AUBrSeqzam29YzA1Pg1UEY0I33IezpgJCOdmVnDFE0nSE6CqtpN1guyV0n9g+UpjFcxnIG5VJBI8PZP24bhBHGaIjRlpZx4HsTjc02I1QO3KF/CuJpLJawnTpt+YB+DeLJnxLV2UmZQKKc4bS9itKOgxoSC7syR89z6vS43GEuHo8c0sF87AUaNThGlAuTdy+d2HHLgVjFWR3z3eCtQHQye+j4Cgbs5SA5grhOoYCIAl4A38fe83nMQmsaJ/SZfWwK/mY6igeI6oDCxJ6GoPAAfrJMS6LmnuMCzt4oh2njvUbzmlIn8vmEMQONH75I0UW6mDdWQNZ0DILLlLGOwAPdcDm9N+d6wfieGoU3TgUKnx0PKT2CWwvQ4F0GwW9tJpTJNS6fSQo+hW9NzEm2G+Eqg+185A2P9ywh2/mFHMySK7vPqeaKdqed9wcP9BYgr/s8/+zb+6N/4BP7Sz91VgdcbwIuXG/sC7L3wHJcC+k4yGcyaPtrlEuoo1pK92pKXwO4jPy9I3D1cgQfgp96/wx/5a5/Ev/KTH8c/9yu+gv/Br/4KPvlG4PExsNa1j3bOBiICjY1mpRwh8CewzS2eBh9GXT0mM/SwpTsFv5i7QCRrQ4Zr2tQAfj2kiGpOOtChnWDJKTa3FbdtO7+URY7H2EKLVD8vMmiZHlXIVj9XjccdXry44muvAn/8Rz6DP/5jH8fP/PIC7jfuXxboXRewsaryeo9B8qcRPEzjJBWUcQ1ccSmnA1wteMZ6Aby77/G/+alvw//up97G7/zM+/j93/Nl/KOf/irwvPDqCtzzYqoY2T6KOgvRGiuPqvIY6pTkbdir1z/936TxIPXTmYPmQ71eTFpB9BtUSXEFMZy4TIifTjZMR75pSfAGdLKpZGEASYJZhaN32/2Zl870Nl7+0a/13HXDeyGH3CRqSYg0i4tT5gJXhDIUgSr6QwbWKseEmWQu4XIOzErHEoIKB8nH7O+9hDzHHaIjddykKDvlrCkzqD3ebjv7tsCGFgvWPNBrcw/CmW2YwVqNOXFnr6yE8/bPfJnrJ+McWvNoGN3pyWd2mj07jaEodqx3yHyVUBURWSXugrFM9LpzC0lvNM2dWGtprBHLDkWnfCLHNsYha0IqFWIAMeZHhEs5P+HPxYhhOdc0ePYAXquiEIiTG+NH2wlnJFTS73YDFkqilzzUUYFcNOnvj8/GlDidHD10BmL2PR0FjHHKVB0ZHgu8DzPxO0I9zM8IbEa8KwKJezy8ufFjX30Lf+ivfRJ/8scfgEzcvV3r8FcsPF6HgemxFHiFDXrMWGx2TyAbES6NqP4TeIw7RAB3K3G5T3w57/C/+Bvfjn/rZ78N/5Nf90v4Z7/wi1i44NVOPAwDIAdTfA596FQqToDF+JP8LgUGCKfr81uTspl8Q/fXWYWMsb1oOgWCOIytkVZ8+et0HrIW1hwnNIA1OPdvzWfrR9GlHd1ek+bnTxl4cR+4i8C/8TPfhn/hr38K/+93H4DLFQ9vb+y84HmYRtOWwUKIDtM9BjjXkRFCGe7SiyWQB0oOr1mG7OFh43nf48//nXv8+Z/7MP6J7/o6/oVf9yV874cf8fR8wcKz0tGSJ+o70vv2ycuEju9WOnisZ0oGE84uJEZ2kryINraDJ8A4BuQUEokDdVpqQIyOlr2R0Ttq1Zh5HQZvRJgUrlrdOSRafQflo6w3eNx5jGc8ye5zb+BaB/Jk7Mb3thk7ARZvIurZu8toL4WFR9Mt20cwyIHqGWOoZAf9HrgUXd/PObMQPTSKnowml/48/N10xhncRnhLa8wm2skpEk2vcdBTGFLf3bVEAb1bUXJKwxNrzD+PVEtEE3usb6MVhxEmlZGpam1JGXPNBvwgF6q6odtxfouCpXVuYj2L3SZduZwhwUyiG+YtejkJNUWNANsR6lSG8hAd5UyB4V/DEelGwZsKmPK6tR0IzLZ09oIcnulb4a+LKJVO4nNixwSg0zMPAt40Holegy1vk0bRCo9eRzstiVhPj1NCYlACBTB67hh8i5ord0WwluXpCry4X3iMxB/+kU/hX/5bn8K7Txfcf+gJ2InnfcH1JougyIlj8L4z5ORJj73YSsFnDjyAqOI+GQUWMiZwDeAaC5cI3L3c+KlXD/jnf+jT+D/85Ev8L7/vy/i+T72Pp1erYlHp0iFajrhIWxkhwbYipGmIMlAO8lA5UIbILUUtpxxGZp3xkBSDkLxA2YfBNwJe9rOAslP1nvkYGjAamInXDMeGjmcideSySUAnNpC4ZuBpL7zx4oof/cpb+B//1c/iz/zcW8Bd4P6Njb0Dz7gDFBAQirxUl0ivux7Glbzws/KAdN4810QGPbNU8bHPjXh4sZGR+FM//XH8hS++iT/wPb+IP/CrfwmXFXj/aeF+bekgaxt0HTjpg5SMxuhr6pgdl4khPSdCJrGj8UrsaHzwcjnT0RQC+A+Nt/TlsDDuf6a75TkYz4E4zq/XZ9OYuYfZQc+M8uCfk+eSHM93bQCsH4xsXGgbqp+wvc0qABW9ew6JUYzvsTGrCfSyztpqp8Q7dJjbzLBSmcpm7M44hj7XHy4Jt9+yKTOxze/GxjI1ZSO5Sw0RnbbsMSSxzpNWiR/fB48jy6kwY8ZsjwQbPBKwzDMe1dk2yIkHLcBpR4MyKGBSVMPoPyUeoj+AjKhTvXrs0U5KzKhI0jgY20pLY+4rHYuIuuHvMOZWQZ1XvAdoCFRaAdMD5fIFdw0EJbqevEm5p+YDd+1JT4EZdBCNJPuh95UuHn8SKEEkr8kjfhDA3ttrl0NxxEche0BpJfFzLJe0APjRUCQiT3WMgaqeKFI/J/DiIfHX332B7/+zn8Mf+qGP4ytPifv7jSsueF4Xt9dA7SLRao9Zq7gsbQCgw0FnRBC7LnZMV8tLzzmwwAt3VPjWXT1ea+3/4cUz/vwXP4Tf/uc+hz/2Ix/BXSTW2Jeu6VroSg4I0jLmMWRQwzVUsq2dfYV0fThEssZ8s9a+fGSixjBVF6mFs3OsCDs/GgXp3CAzdYLA2c7VdPr4vf6l/gT1q56tYvnAGyvxx//mp/Hb/y9fwJ/52y9wd3/FJTauDXAyelzPjaiUbp8ZX8eT0yAs85zRcQR6X185VXSsWqY4j5Jj/oUo8bwWcl3w8o1HfDUW/uBfewff/+c/jx/+5TfwxgV4ehZHweO1iw0LPJQLKOySbdvNTQYtmzS1I65bGjsgmlmZiRWSCcrRwJAgXg02OlMzlsqaVXvX8zqCgorNRnpcclSpLMQiWy8LZRJ/Uk7mPINLCqeAxfjoPvpZHYs+1a0zsh09u/+ETgXsGeu02ex576avlB56lgZJJiahrdnTpSlzQTtSIxslZUik7glg+zn0HoDqMzRO3vme9fPEUTKMjvDkOgM+d1a7WMA03Q1fLCBjUNkN7Ln+QiEdHfEAFHujc6mhfjDoDzullH9HFcMbFRJ2l9mV1ocLP+eQCV992cZFR0r6UJ7JfK+3w8aLHR4jZerH3NT6Msa6EGkmgemneOgIGbRMB8d/s9/hVabb4u+klWo2FA0243mRD40feGdDPz9ANImAm/yT1RyAaHKowPC4uhmYlas1fQ1+gNX4Nwh8wFNe8OI+8ad+8iP4nX/2O/DvfekNPLxZCnl9TteKrLp/Ilb3z4itaad0Ljm2oG1gKaOBNhLNt7WgKJAywLm14xB1rnVxPapc5DkvePESeO9yh9//V97BP/2D344v75d4eACedmWTnBWlnDFlR1oXiZYimJzkscGkXpBupPGAPr1wAN3kD/T5+W7jwUbVYowzJyRUU/dtDeBoZTSV45wldBS0QmCnI7H7HoPrDqxY+OB6wT/7Q5/Df+uHPoVv5ML9y6rvKA8hPLeg8bYeiWDzoiBinxyS+Ww7BKt4jnYM6DDIeQDEe157nQAe84ILLnjxJvAXv/w2fsef/Rz+1Z/8CN54sXDtE+gcANgYTqOcbZzsdFlX+JygcJzhTgmR5AsypsHuFkSKGoN9hcbHw9gNNo6xVvDCq9sHs7sdwgH/hC05ZB6tosoix3i+bE8PFulzS3bhOY2ybNSwR4HG/vrCfUoXGpf7GTnKMv4p2WQt1+7TYbVz+BAfzm2zJlJtV82HFaZsIvMetBmd9Qy+O/ghB5/u5+Bx28CjlqDHa7vZGk4ZT2Ze6s+SMDUB5I2Luc0cKgilFnFjXNkZ/3JgLXSj2/JG+bOZXxjsFHIFm2HD0Qtniyf6DSGbE1O/iboFKixczhCQeUJkC4TS6mOch5KSrEEqmmE0mC0EIqcEkg4BuT2icYuDQZvkHgzVuxSqnh+NfkUTw3vttilc+kiwzuWNemCRSeD4s2VjRBwHt2nEoPaA1GmO4fSAZSrYdgnv7jsf9l542nd4+ebGH/sbn8Q/+Re/A7+EC+7fWHjMpStVN+Umiv65orb89e9yCBC+zIP9tUVidBh0CCyErTAtAf0Ov8/Wl7k+x2WHR5RRePnhO/ybX/wE/rN/4Qv48fde4uUD8JhcG89DQcke6gq67wCGY0iDZzq7AjtE28LIlCx44ksXcK0uemLENa/7lSuQTFFTfycNjQHRssLjc8VXIVkc9oG2xgVwIzCIwHMG7u8Cf/fxBX7gB7+A/+1PfAwv3rgC913YKelyGn1aDhrvuAwdrumDl5V5rKvuBaCs0MDznAC0c8EjZBf63ICWiRXth9TvG8XjhxeJr11e4L/6H34H/tCPfgYPDwu5A86I1w/zglMP1HxWIfFwDKOPg57ZIGuj0bc7UuZI33V7NuzNy53Ym84YKbzFt86v2REJIHKDu51SskkUTnUnJeESRKLvHuAUhoAAFUnL9iRuVUUGbspAf6HlKMqpuh1Z5oPkY1lCA2jj3PK8O6NduEPHh/3Dia2mAR03nQEwnGQF3OlRZDjr6feoL73kPeff+q4FzcZ5io5srXCkW0rPi58uCUEzysUKbIMNoRtpJrNHWZgbz24Ina7yzYTO5J4uoi0bEBiXKKSv+tSjNjqTTKChj6g0VCuLo05av77mNwHdJsXouNvn3c9Ie44FrJuY0MAVQAbuFMjTmBys6v3yBSRah6FiSoJIv1Og9d/qqgpwxAtnMOQwSes8DGViJAhMfy6+pE5oUDkf9q9sUrPAABTj8+bLSLULR4EyQgpBoufUFG6ePO0LXtwH/uBf/Sx+/3/0Gdy9tXB3f8FzXE660LtPrpX1ODoyYwpX21jJuIhaew6meh3p63v2smouteRJo1LEkIOQDULy6gN7LTzuwBtvbvzHX3vA7/7zn8WPfP0tvHwIPF0vOP40GAg3wzyaho0yb6vefExBXutOy2ErvqqpJQODdw3UUxNZfiNDEXRqHX18C1s1mEwOjayPIlHqbfNCDlo9e93A/R3wk++9hd/973wBf/EX38LDWxtPcYc6oY1QniOKtfFglBOXpoicu+UIfjEei76YLDyWtWqrIGVHmYJhyAL9bFR2SZkMCPyf1gXrPvDwVuAP/81P4r/xH38G68UdZnqXDhhlQDCfjj7JaWjWsLEU1UfecQLweHMFDYm/EeQP3Qf6wCDdNDQxiqQm9eYInE6PNTKVet7icZqyiXXOKidpkg7sI6mI1daO833jdHpbd1L3W+oY/PWFOVzyzTEn4jI64K15h4I49DvT0aE+UAjkMO+rCM3IP4bN5JhXsrjeto/zKBnn4UW2o2YknG04+N+zbvD2p1LYKvwNKXZC0XorxSJIS3BHqlB8NEFtYHvfYiuEbxprQRSgzTYAe2eUzgXd9jQkZfMkvwaOPW6KyuYGq7+RAW0DIVbIUKYMRx6MmsPreUVKEOgk8aE1CT+E3kso3Wd7avbU4yj+KaHBUDhGR4P2NACR0JpiQka9+gqcFI6um6CNOUH/RO4o7RrpFS/d0hBYDqQL7F3bL7h0mRWhR2De3HZEbq3oT3nBy4fEH/jhb8cf+aufwsObgevdBVedY0bNGqwJA7UAfgG6InAR6C/DwFoeIiBDr++1BcmGgcYklo1J6TSfp/6EFPQRd3j5EvjpD97CP/b/+Cx+9Ktv4eFF4jG9NTNXOINEFZIeTPnpiXP+e5dusI6JBjEpdw1OeQI/I5Ic8lNsI0ANVRt6YDmElrYMfnRGoBdOwGn9l0Ht29TGmuvjTtzfXfHj33wL/+i/83n8za+/wP3LjadrZ1v6PWZfNLyAtm+K/hEKHIrGfrba6mvL5YSGlyViLPsMhzDaMw623ZkBPmc72nOLCzYWXr4J/Cs/9in8M//+ZxF3D0MXGA2SJszCDfkGcUOo20bSBpgmaEa2gLGKAmRfZ2QFWn4p6mjrq6WOgV3T6DgI9Pc2ejoYhv8Hs7P0pmng2xrcRMSaObQsQCPXNqqkSqdCiTZU34jtA4LEu5OoutRJhnM01tvVy5xtjX+oJVTbRSJkjvQ/VCg7a5LmFHWSbduWcmrzsEtaHGuZmGyQQHMMw7Ep3CrqJqibcwxR9NmJNfepxvhvjsIE2yt6qfDgZXao4NynaGrRc3R7qSKW00tM1b0gfbiBPFxuQ2yF2YdT4vYIoqeQh+aABsu6wc0CnQ2et3+0RDKBcfy7hzMAjvhbyPQE0drPyRQ906ycb4MsyrDw0xkUwrOWkDAjMDY02vFqw8QdoqS3ir7ECwuL2IU45nL7LTSH8K9ZYHMOEqa9WV4Ff7jg5cMVf/CHP40/+lc/gjceHvHE8TcpWMTng0O6ASp0oNO7szC1u14tG2Bqb6b90cZgtS4t10N0m8nLbQJHwVksOsqOMBVNolLCLx6An3n/Ab/n//45/NjXXuDlJfF8HZmiJhhBW/Md2q5Cy8ETAFqjj+GD+6GAVukkL+nvwmypRwa/xh/pnP61ARkseC1RUbwtgXBNAzHKnV8z8eKS+OlvvMAP/OnP4Me/vnD/IvF8veg465QzBnem9f10Wp60C+iYX8uDLZUchlUZg8Pxi16qiXBRIFqeVScz9KznppP++t8dgacNvHix8a/9+Efxz/3lzyHu73RxEJfGlD7vgu8ZNHAYQmcFZTNTaqZJ18U8WuHmffhjsjw3OtBihrfbm+3rBcrnGo6ghWhWqccUkEQp+obOJ4jMrmJnuzGa6oEoADwEEjJn/LyFj/Oo30v4mbYPpLA6YH7RBCXpx/GsxgQa4OFIrFGD4dP5Rv2R2jppmo35Vv2kBLQNYoHfKPSTcHDsbLCeN4sHPw7nxAOS1Wh55VUBJnzSm7TiCZj0eUf1u9LlFLrogdMA753IfVXkxzUUMkze3wBregATriZj+HOd0McvUtWQyWi9jTDnS4GptAyp4uxHqHhsCPprFh9mEPvaiSudmWYiQIBpytKbjN5sSXQUsqDPdHYFp2e+lPkKveK049DvJl85OzvjyIz07QkHH6tfQFtAGV3ESCH3WLnVqC0g5rXC2itMRR/gIpKMdeJEuqgOtZ335f3GH/vr34Y/8lc+ghcP/1+6/jTYtu06D8O+Mdfe59x7X/+Ahx4ECFAkRVEkaKqJHEZU0XIllOOQliyzimWZFG1asRJXqmJZsiPlRyoqi3bFTamxJTuxZIuSUy6n1MRWoqij1ViUaDuERLEFARL9w2vwmtuds/eaIz/G+L4x5r4vB7jvnrv3WnPNOZpvtHOuMx7byC7c2GYV9Ver9xtUWzNoPFVUHcAYPVrLaC8j+ErtLy6XAEEgP97h30z5UmaE0BWheOOrmeHWgTtXjs89POB7/9p78dlHBxy3GW9rQ5MJNjpZyuRlRGhJzBngr/MwyCMCoktC2q6ulMtZOtyCpHq/Bb0IFSQTCfq1APhO9I7LArrZZEUy4zooRqxPum4wfOnREd/7lz+An3/rgOPVxOlMBKJDl3ptyFPWWK4K/tJBTuRW2dFSbsIRoALQiDUjp6laOotpyJt3w4BB+/UpX7w/IWRQRpOGpwlc3d3xp37+Wfzv/t77cDwecN7jvjFMIqQtfUlkXwys5xwLDT0b4uQxphQ2rx8Kn1rfRxtuhbwlG2DCwMosFq8ZEnT+40Kv5zT47vBptYOK9znAvqtqOKYQtfmB2FJ0EW0AybrpyOSMeFVO8KJhYlVMYypb4aSbrs3+FG+0JF1TvuXg+IyDwtzrGrBvrzBdH+YY1RCa2pG8LepFuRxgQ32tPe5Jfp/39hkkdwED6VAwO0mcMGaIPdrmreZdeAZ6KqTQmropT6K27MmzpWfulwtqaWyfoLOg1Qk3g0JzNiBDMdwRHtgwyFkxq7myYjLZQtlenWrGVz3yvyH41ehuF6hG2ckL5O3xy7kIY5OhAs1upZuB1Nid/s2al9xa13HU9o4aio2Vih7zW+FvfqiOfkOlhtj123jBlC6zDrE0q4axvk4J/gUd8s2FOcMYpym6WRzpeX3H8Rc+8yJ+z4+/F8e7jhPfQpjgVs4ZMsVfxrjAGQXaNtJ453QMJadLlIbsBzCVDnQ8KPsHVBOuCJOZLq5rKnuwpf0xWL4bwOEYbridhjt3Jn72zafxA3/nJZzyBaDx6guXXPfoAEiDZ4TxJgQtMlq3ftZPXc3vXewxVGc+0vgUPjchctSro8k/cG1xmWwgRWDGurqRmX1u7Tm7H+A28C/97Q/ik689jeMdx3lavfICnvzKt5NavB68HDqrHo10DDqfwW2AKTOWB82I54wC89/VNwDxHV4ZpqIs5aBKAhyTfd+V5TCcz4arO44/+rMv4t/5R8/j+nrglIeTJRSuIGCNxn2s2b82qjIFIfWyAYyhYVvR3ou6Zd9Ia+FS4LCcpcZP6r0T57xU1rsx4dTN9Cw5yAQYGsSZhlc1/C4zvDs+mT1VInn1Nm7dPzhXOkw5RxVSOnaJRN6DcBlMvhhOCysGhA7TPhHjXCIZ93OHQbNpxN0LRK/5MDuTo8jOJs00BsqBEzZnGcVya3fcUnRj2aLrew5UAu+APG3NbQx1eVPYKxJEk8eeAkGbGQfKBai2FUS1BB3neAmSek+9ozF0loEG6ygihyTcUPWvigZKcULfqSHxdzX5lDSqq31hVfeuFwI0n4InYq2MdoJ4c0zIhfJgrcA3BZipJzkgpKUDlmGYpTfsbb08e1pLT3oOdpwneve3zmGUM9alpIhgDWBq01fz7eL3UdftGDheH/CLbzyF3/Xj7wHuOPwQBiHmRwXJAZ4AacveT4L4RbpXjVxZ409gr3p+GtYEemUL0mCMdAKczgAdB2YihquxSLV80fSSN4ZbbLjzlOHHXn4Bv/d/fA8Oxw2nPSN5KriscvE9cKfVHAWmAZa+h8NGfrDcFZEQGgNi5IGmo7BMAVvxq5uQHk3wG4GiVdnRXc6dGRThOKwBKWuScd3ZD7i+s+Pf+ZmX8Je+/CyunnGc7KorTNLFJQ9OGKLxps6kXstpS77ZlttdUx5826Lzf2u83tRZW0rBXSXiPdDfXNpLAdwdUg2u0PyZJYQNnGG4uhr4A598CX/1S0/j+ug4ebw3hI5eoTfKwIByamnnGiNlPPLAoa5r4qWhtqVB43Uo7pjJIMRlQJLn8AoIKJ+UsZmBlzC8eJaasBhTzcw4brMljjjfgrKiH68/tTdVi606N8u/maWWLtW1g4fVUWuE2bUu8bPbExvZP1PYV1vec729vJ33m7l66sgTa3Pmp/oRn1dbSfvIco45r5sau5aTMsrp6PHFx9FTQpS5Ln99Ug1eVmZpW5Sn/HKEoQvNayJB0FgQjQ7TtFQovzSUyaCWmUyvnwThNZADyNmGE8HvGpGT5wLtfH4/MCWYV4wrI0fhaJFhu4TTFk+6tkn9vABialUi/iT4Umh42A2YgM3aMICLwhJ4ZjTr8MZjclvpxPgmpxyfwrikngUwBCdKAZ/l67WmCeT1bV6N5uHob9ht4Id//P14eT9iux7Y3daxQWNi9REdFUbel9F+M8ZK26fjw2udzVhsGITB0Q4Lao1eHM876LMWveGJ3gTtX+acQBkz3MJwvAf84V94F/7cLz2DuwfgPMMx0TLSeAfJ14NCiH0iMeVb9ZaSIdUKHWWcOUg3UDJYJvvjKQdPNB9WOCTQqwbAnqngfGI0RuE0UufdcX044e985Wn8W//g3TjeBU7bITInbNADDX5mfZKGTPmLTzT2orkBtoEnWmIbGNsW46qcM1pJyXMLaTZn8nuOt43CuHQCmc+MMkDrJxEp+Q9RPGR+A/ZxhX/l778Pr97cwWHMyCAxFKOaLc5b/Gn4HmMqw1i052OHnGLAnQez5b95aJM3fGwGjWshu0OV1S0kXhP7CoG9buJ+9LoyHe/ELc2boNEMkX5Nq9WNE4KQBhTNiP95P8+TgGBc3AIFnCVU4lQFGyiZZ1Yu6SqWZvahHKR6uqVMqhRDu9PLxDT/1F86K40KLOUuzpTo4+KhDgWqb8FR0a5vHIoxs9xIOSnauqak3xeFB2udfJhD27EcNWkavBx40sBYo4Nzz3JPf+Rk8/5hyxoqdZPgNBsgFXoVGag/LjGI1M6MfK+UaDlIhfSwij5yETUuI09kNkGpdRKy6nMKAhKIo2ZFQRApMH1mGq3YTQwQL9NZcJQh6GDLfbxsTNeWk+nAPlstjdxj2iiNIGm38NKqn8L43G5coFNU9dMMoGwHv3PD7gNXd3f8ez/9bvyNL97B9fXEPlmnhUDVMi3fm6wMEdlpi5vxeb5GZgsQVIbAe5PgMPjWwCkBfTDaN2TkV7sI+nXi+VKOIGjHHCe3wuVnwMA2gN/7ky/h5UdHHNUJxd4dZneSD5RNghl7SwQMJh1RF3YaEH5Hvtd2IS+5txo7xJ/CM1tfU2pQcw59duhD0+2S+w5MHDIJj7dP1/jf/sQH8ZBd/GkkkL0ibPijA6wGSzi4BU8ZHvF5ZH9nYk0r8ShK3yr1rzEbDzntOv2RYzWjx2ica075UjMqoNJEyGHMdx8DV1eOTz28hz/wD9+DcbzC2TcRkDajmZT2WWYKhFRrmpqZpKB9ol0zJLpPSpb4qc8JJ9XbU93wif0UL2UT8j6BJEXLahGVNoAKAWlPZquLozv/kkUQZlqfQMl1jFNBTeAi69xpnCf70nZg7oXDlhqU/64Ma2oXnRsZyDLInlkXJGaH+HbdsjTiifXdyE7HLu+Nxr+vvNL9EbwG6MpRUDbHq9HSUhAZ7KD/NJzkEzLKHvLc2fnKG1Kb0xyLIfy2nrByX6cnLaat5ggR1KXgwayL5rpYfhmkQC8olQRWUbrkxed8LBPWBE/RwDoT40vVVdp/49Kh5xhTbkyNe43VZwC0pjnnc0thKO+ExpAtv1AAazyzC1K2dJ4sa2YvSF96tgIs6PrCf6a/OP4Uk8z6boLOYpeXa4wKdK2XLjeLL6DIRU8zHK8Gfvr1Z/GHfvJd2J6Kc/V7jZ2RPJ29BehDK9NYQKl+H7VOnXEgJ8BUB1Y5q9V69XlGmpMGaNScdP4+DX0zSHQY6TDwhTg9kiUrdwxs14ZPPXgaf/CnX8R23CIL0Byqvn2oDHTxmzsH+w4UgWvqbs6sBD8bO5s3EU4J5SCNdkQvVrZ6AXOorhngisViVZEoAZxVQxoSA/Y5cHU98e/+zHvxk1++g+PVxN7plWn5BZPa2Q3Qkb0hA1GqQdHZysAv0blBmZ/KCqEyAwOwzdK5HAv/nQ7iRe8JujOpj0tm6BhgbOAOqZNvON51/Ceffhf+X196DneuJk7tuGjBSv+dxq5YJ91bKU/ls4pw3dSgy859y+vqdi4gn8WzVIQR4UwwwdQNcGGcAD7n5WVD8rne1klsKgxLA0oBSydBJzJy7QYoe9lA1RqNGIErol+9qrQjnF/K6oL7TW8AVPN3O7Y3uza11Gx6ZxyiJnAg7qPRH5XBFd2UTfNlLW1GF7uAyhEg06T9Ck4oCzmCB5+l43AMRhpO82GMAgsYaI7XEM/TI5s1aXGWs69I3uQmtpqMDF5BV6U+c5h85bAYhUhv6X+ybI1xTDvK8sRKdBIS0ntjM5EEAenRZ2MfhRAEcjRmz0YPaUUTDGYbWmak/Y1kYObCwTRTeN9pULrxTsXQjgyUcPB0PEUvLcUi00Agb8pQxnpGkwgJANN6uTzZIxcbMd1z+j2lmARa0KqiKn4Lm/j9f/9deONx9EVMnpXajP9yLjtB4QJ89d7tBuhMGde5AHQG6iAi1pHrHPi6p58YBzN4vkfAe9OY0v50SvIazj2NkJlHvVl6FL+fbYQR+KV348deuYfrMbHvGbE4ZaXu0q+NLat+Fts9m/A8LQfP0tBJkbx2OrB79hCQbeSbY93mZSWj0utqACxL1KxhTGaVIwOOx4mffuNp/JF/+Cy24wn7PtpOBpQgGcrQSx1bn8dgydDFX/UGsIaf19Vpf8nvbcAOW/WFyCmI505Dk6GtDH8fo/WGcL2WtGD2aNCBMFRrDAHbHf/mf/8c3tg3bCMbJ7t+c14oVVLFtAuCExMR+7vJRz0pTY0iRyiTyGsTyrV9zBNTetA208h1Fkk/2xwNxUs+q85XSSChV0MMtramLoc5j4I019jdkQjcbiCl/+bjaJ8U/BFTUdkC2hwUcsqJ4Fv+FnUMO1GGOAfkEnNFehcA7cx0ORT8H+DQoWjt+aZnSS1DpBttC8yTZnl2QQlRyQEDaI44PJkQT/PUuVHGVR5aszpmsvFVc7RYFD3NJgSQ8a3VtDmAzkOkLF3djQ60WiwZ2biqv8vgad6g8pD4s7yllB6jZ6xrWQ/I9kY2kABti5uVh+WeWy5KKcrrZvqtc9AlBDGtBt9tfJCxidSV6bAnFAM1Qny26n9zzoK2Pd0U3z15YEavX3m+l0qeroyOZ++Co9qMEzQ4P86sCeA+DcfDxF/49HP4C5++xvHOOV6WM2dFs5S7Ft3XqX5exXIaW0bprTksMDnS/dz6t14ffBwJ7jphcRvKTLEWTVDHiOYxG4iacxoMZgJsyWKIqEGzNBi6HgO+ATdnwx/8qRdw8gPM1q15ipoutV8892pknODxaLE2UNkdmKZGLXTgl+Eq3VTql/K0N70lVKW+LltEK4GXwJo8yHJKTMixzw02Bv7P/+i9eH0eMA6ta96rpOdEOabyyfCNcpHS2JytMPqb+OatobNvA1WX/4Aifc8xddpjym1sX0UZej0f6WA02RzxzLJMI0hNzMxBHfGCqMNx4pNfvYs/9nPP43A18rXX1JkWRaOGRBqzXqqDlZERftAQ8W/zOhKbtiGxskPosgtFY8XYA0BL1AqHSoJWLJMJ4zjUq5mp8ZwbVZMyEFGqZqFtd4VzzTlNbNfajbhOQcwhnNi0OhORqa1ndXzO7S9pO7qAkyUGtPEY7C5peuoc5zqLfwG/JJTloUNT7x1wRMc/eVt9CgESA4jjMxWNMJi3sF2zaNzNvJjjQM/7N/7NYig9QhrNdhJXRTmZnsuFICexxCdU6GZG6l0CdYmoxBnQSFEA4fm2Ol/uoiKAUTXKGFGANT7H1f0FQH0yufIyAHlfT89qyCYUzEoMDqI91rZe1+5TVMl556DTEtxJSqu5ICM6RWFtzHiUtLCzBsQVesQCfEDOhtac31MJgW6QIk3Mbdpch3t7jqhbQnw6HfEjP/1u+LHV0NNYdHMjz6HCHujkvxah97e5VdrY1JznBPatur7ZBDZZl+9bB5VhsDr7PfeRL86EAQamo2ncyxgYDcJSq6bsh+4e7hp+7NXn8Fc+/xQOR+Sph12MrclagTmdWJ2QlipYDCqQFy+sxkBbKgUk7Z0iHskcwaeB7log6mM3o2EJC+lo7A4cj8Dfe+Up/PlP3cHhesfZtoIFK3QgvXgEc53Pj1Z+QjPsNMAQ7ZmtWI00p8nyEp5M6y+7BMZaRjLogKFqZ6jSgxzQVl6qdDLXEJSbtmE7DvyJn30BL9+/wvEwiTZkSdMigOlbpEPJ8UteGyGb8YlaMZoRSMMG0y4PqwfqrBbCqZ7rLizoL51hsBlY10Qwo2NF0TSQkrluyK0M70KFtrSWPdD7KJiRuRBDEZBYRKfYS4wWgzqh3oE2wTj+vYBXRAxyeHtI62NLB6QXqMvO+6I3cWcYea6RRl/BpK6iRHTqlM25LJOk0cl7gXfSWfrRSocEP2x5iFJRVkLpYpQ2sa4pVmtv+eJ9XgRsL8JriyMylfdLgb+Yt74TWHG9SWTomkRSMRu1YwJlKPUudS+nhAlTs/TOSNAGsKTCSvi8m8xWB3EXujLO+eBSJKuvhpeyhvxVNkV+QP7HSGIY3/IEoqrWZ2y85CyD6fGyktrxQP7qJwU6thZyiXmednY4lt1swiidjUjvcAT+P194Gj/xpSMOdx3nsa1g1vdg8zEE2WHAodmhFvnZ2CLiszD4bOxDr+UmcCuCyyyDAmFG/VvcHxFhAb8P5J7/3G+eaf94TgJTKxOwdFFNRGCAk2sCsBl2HPBHP/Uc9v0gw0s7UZU9CffqhKcx8GISOMBk5I+Un+SbG3Dhe6NSg5Du8R+X/Qh8IU3ofHOeW0aqqSDYAOe+wcbEf/hzz+GxX0E+BY1R8lnnHuSzSGel3Unb3NInnsshhBw92yp9z2fV0c7I2n5kJbBZbQls/9bOAT0nZX+zzALkbqZ0YLX7AC0b2WlC/gDYDsDnHj2F/+LTz2JsFrtgBh2o0qEVWkyGkGOHOPO5lbqvIIhSVOUgNUrS0BCvvJJtyZLAJzR7lD+V3hYzFejwLX9y7HIMMwffj8IomQ5DV0XweRLK/ONxfogmS1pdRN4sB1fjM4/WTXlW3aMCLhE8DSIpXC6AgY6PWIkKoKwRyLz23F9AWlpYgR6G6ZHJnzTc1kw/jdfiFHoG7N7GBvRCO5WoAL1LoMnVIGiYrQOEt1DgxxskAfSKBSwuI8Z3g5NsDmueJ5nRGW5lxLUue0LwQ+ZZKx41JgX+nYxrLqg7EnlHEcsjG2FE5QvjPHWsYhGuBLL/Xv+mE8nszGLradCbT8eLlF5dvYC4Vl59F7ggDIVmWaEX7eLsaatu8AYQjCCL9lpkfTiqNtlJq+nTOdDz4zPVVHPMfQf+g194HvO4QTU5g+r0lvSp5qqiK/9Lo8x6f9QRUbVdvgmOWRWreTCda9tWgE8jv2UpYEsngE4Cf1ekCai3gGn9jBxVDVF6uc6pDyzkqXUG94E5NxyuHX/tzefxd1+9h6uxB7h1wScdVhVZKN2zBEHSZs3Fl0u+iaJPfrX8PqT2TFtSZ3tmNFi1PosYu0/HYRv4mTefwl/87DMYd3acUTJQuzQsaeUtKk9Ho6f/83entWKmhXv3FY1jidDV3JdZH2vX6p0CmS2qUpMBG/lPB5LvErDmWDa85AFEggZmPGc5nQDmGLDN8ad/6Vk8PN3FMcFx0CI0Qy/sJNeaw/WkTHjNHcU7AHJMWeOnjsQtcbT18ibCTIUrp2t0UFJ2eN7anmnndlgY7Yvq+LS56DLKaZbxVMahfXxh4kBFW2TVIEfI52zrD9eHpQRClh6W2YhyFiB6pDoXcS8Jbm1y3UY6davzoLB6qo8sg1muvfdCgRitcBpcAQPT+NSWiYf9TxnpHel9AQUpDey5ABu1R98vzUF9Lm+9W6T8mp2OTB1ZUl3HyJL2CC8m5VJzEBgUymXzXYqOlcfHhTm9OaPzwbnzO1TDjLYvThRwAvKwaXJaesZqKrKGlvSKtaHNh6xx0DstQam0mHoTXF9pro5QKFMpJtnvyI5a4xNgqNcALw0xiZHVvs2RUYvoM3aUAUY9Ixwu8ttEg0hBea1FhHTw0KTphuPR8D+89gz+5svPYNx17CM836UbX3KC4GSL8mkoYJa1+JSPFH5GlMgDYBi98XcaZNbya094Mxr5vEFjwTmlU2FyGvgHdeY8EEZsbKgOcyt6pPPAFL4M5gBu9wN+9LNPAzYicgdPz3sH0009Ik/d1fU7xpMA6oDS8GS0WcrUJIv5pJKFEstef0VhL+W7yRMbXWlwKELTB8bVCX/2l5/HGzfXOIyWjrww0mFgN/FC/GeUncFHPxGS3ft0uGwj/VElAclZlQxqh0jNQ5l6OgbbULYhaJXbUDMDwLMBegaIAbGIZWi9IkhZBhwDxyPw/73/NP7ql+9gOzjOs7Ynk5nCxczIyJAJq/r1AIMr8Ui8GtLdwA2ZdT1rCaRo/tojQuysbxrSiXSr8Sw8bxC9PFG55nQqvctNF0RDlVS5bmvzllDTtthKm2bYTfMpPPbcVeAe524o2NE1Xg3dRvtT4w3rcyB/4ojg4Ww8L7R1Z/nDNdbguGlTKsCljWTmNjsEaNtFYDKoZQT72jm/JhWDRny5kOmU2dPhCSJcxazuf6bGKWSVcugEn5UuqsfpWssJ0UgtvEV7Tv83KUejmG9I44wdLiHwNFo9JQf0ZkdIsQRi7YeRuTr8Zz2/7RCBDnAgIHChVs8mk4jJIVBOIkuBg3ZV94sZp1vVm3FQKUAmtJCyX76I4fLlHeQSU0PKwnDSNCIpad0ogL/r76RLG99pWAi8B8d/+dnncTs3bJxfTSSfHfzPYxqCRkrXr/Tjn4q0bYn+jPX+JaoMResGn8BdDkIAOw75elhF+7ZkxATkuYZqOENFk2jGi/wXmYNeuxtsA/7rl5/Blx8NXG/MoBUggL+HJyeHr9KPqVuZVtWc+NXsAFJ8Yucx+bUKDqpUIFlqMpT3zg7+nAsHTJ0aw/Dm+YA/98vPANe57VPPTDbIEAeN1bC37N4og6sdMcIl8jEpQxkgb1q2p2/r4yuDo9s/ZWmMqPQwuudzWnZJDuMy785rz3Uk5tChkQznTpoB+Djg//6ZpwAbcb5CP+mu/XjdmjjAo2kT79CwizhmvvAivnJVZJ3BFj/PlzZoK221xgsTCAN6c3qT556Q1nxtdQKW0yHnKlZxYzOAXEKnAgnAAEAGXdYO7XGSR0ucj+9tlWvaMbdqGiRVvJ6pxmquAX1tzcBxjml7qkE6T23k+R8+sRInnik6liglh4oOft4hm+v8tRy+sjvG/+tzB9gEWCIUzLIiWy6ARs0IEDDYdPSjTh2ohrc8tNoIvKjrghecTXUqUugNAF9niungtp/wVxqzAcT7ypPujBKbnAAukDDLXTLNctEJsZa6mu37Swu1gNzMgyB25L5ZOiatFNJfckEGFTeFs5YG2mr0xYBHn0IofL2G0tvhHxRMCrItUV91t/ZMRIxT7RhNy6zmJkuS/GSntmpsBjlEyq54njKVT9kOA/dPR/w3X3kGuBP9AMV3L+MoB60cMyx/57pIVm0jsqr1KlpEvGyF2YItgN5ZwzZ+txp51fHhLXL0jN75rAHWaXUiZTPwdALKyUBGo9UaRKcSBmxHxxce3cVff+UebIRe8YVMnvQkeJDmxItI9ZFNNT5JtjjklAWwJBFOraMcUoDZMAd7O6hHg2DckNUIwrCsoLXUcl572M74Oy/fw0+/esThcI5mR+JST+H3nRvUE+o16/j5TDoJLNXEd7PKBOSJDo1yKO2f/OZBPXQ6JV+DDgF5N6ofJD+bPbtj0P1myOzAJjlUBom12VI/7AA22/GXv/w0Pv3GEVcjtyGTvykD2sYsXgPK1LnDss3fUn/okC+HnVHNOAH3NnbKN+UETE1TXikfVYvyhqfdb2x+pTB0CYBGoc6aXyeycc0l5wFrFtgmryCMKfGLuCv59z5y+7xNz7xNNgNNbRvkotXjQhzt6yauNtsC6PQ/94l4Cd0ymfo1F8rhZa8AvsR0JeZyqiDHiM+YJfH2ncsRGOs4RXqS28qA9ceSkq7hasL5tLWHYBbxjAPIFMX1PL0J1oiWEfZMw05MZYpe0SjP1A8PKt6olUav7GxRunlElgwrJ2CWG0s6OJ4w3KljJYwJ3PAJNoqqSuMr7dow9HlqXiMFvUVo6t5lt61m5/3WpI23uZmkRWDR6I80FAMNCLo/ScMCGmA0etUMWFIS0IDZkYwq0nDSK51uGMcNP/HVZ/ALXz1iGzumaneU1pJ0krf3AsioKyKvlK864LPupe2DLaK3LRv3eArcNmToVesfYYwut44pNZ2KiUwvV69BioOaW634MzywbsjaLanu6p2bwGniv/nSM3C7qjcEohk7ipWiowaVSfdxSdMOeqEi9W8UuIOyRWPm7TpvVwlcV4Q3fteybEgcYYz6Fz/7HNwGBhtGR3M6qCdcpyGMdXfuQJnAwhM6D0bD3ZyJeekcGsCz3G2g+j8yy8ASz3IkcV4zW/8HU/k6Njjv92U9nn83NGrQ4OSJGzZzvH57jR/7yj3Yxu2gxUcDjYKRtKkyLmyR3ojr8T3f82D9wSDOthfCUK9Tmfg0ZkSHbg+sytaAVQ46/3K8Gnd1PDTJKYbK2SEO24Wk1r87oWneTfaLg3dahH1ptPO6Bklf0QxVGl5G8Y5/DPo4OucXlw8Qh6fkuDb4xfVjsbQ1tmwOSueaB3YhA3TgSyut/U0HvvOJgqLTDZjyYOSjxeY0pqI0U8S2OhSWfJ2amJrWoFmA5YISOKcsCjjFU04D7RYD5HzYEPONjKsVF3jk2GoEuoiI+BT+zwCwjhNyWDX1btsptLOG6MhaXCDtPDICMxes89lFo/hrwJsxSf4w0ifCONSc41SWxnW+9VBeqWe6UQpGXsb6AiOji3lyPMm2teUQ1FwAh3SGIvr3UpfOs7Hjb3zxLvbbHYd9L0Vt/KgdJKa0aQE9gZyGI+ekaM0y7W6qE9NRcBrxFuET9NXAxXruxsOFWulCUd+IbYOweOVrfmdjCMOkzlTGpGmX5VpLGjBEj4RtwN978w6+erPhaptlTEhmWNtSuoKSEjwcH4BbvbYZ6dAN1m3Ftxin15VLGK0yTA54vXm09NtLHrgW3s8dDcMG7j8+4m+9fBe4Bs6s76fQytmggaMBp6Mnuc7f+7a/bSunTX0hULYA2dDJiH7QaWvXxXPKmNfukf43SZLjZU+JcZeHdgCMaO1nuYrZgkB76bgOkEpazZzfX/nyXWA/QOlpCOKazkOKxe57oxy0BjtpLfuhQrkFruZQtFzmvuBKTZZo+NtKlEsgRbnrNmFI9OK62R5fYlo/bSj3nnEGgV/42kUtGmodfA1uGfLKWNejaBO4VhmrOkYbfTvyimfYPbc+J/a39RMfK+tA+5mOjXtF9HyeeJVXye5MLOc9iA9eMgQA5wmWcMpOFlrrWSiia0uzAYfODCMhSWCm4eqZmpBEl+9hzlS8TunKQR3Q1ojwAC0BgwwtIolkHuPZRJ6eVcwXI63kxRuDw39hehOav57Ia80UsQysFph0UBPJgno1FkF8bMi5FZhxQu5BR5NWocbI4eShUVlSaJlC5wE5KeMZySWoO5JmNMgpSsZzLExjM90sYSY+6PHFWxlXhICGwOb9lBkQLLwAvY3JbtaBeB3qf/vlO8CW80rn2hPvWfDv201Vz20pfdJ8SVkT7I3ZgJLBtY5pWlvMdbS5Aqyiuqcz1NaKmcfVqJaaa5+IUoNvKRUz0d5jznmL5TwzaxmlgEkjGOva7g788s0d/PT9Dd/xkmM/bThY1ALV7CPiNACzEYDR9chAQSlgSRC6FABy3YA4GXDQoFjpAoL+pODS0kSep9BVXT+u2zbg59+8g8++dcC4nnA7xH2N51KxnLdVLqNt/TNlDXguf/B/iL76jLLEsg0qQ2VpmSYzDMKGlCnSh9jECJq7nVPXnPPg5EfKRpboWMawYXVCH+WVe84jTEzHDfjk2/fwxukazx4epfkI2aW8DUPoISgKVULlGo2OFWWrG2HKTjdcxJNURofLMSAzSbuR17nFa66BNgde780EWR/G9WiRWVwuHCJ+cb4DFbxVEFoCY1xTOljcGaXFCddrPvGoKp8AJDCgHWHZ96SJmiPegotly3RfhaHd4JxMjMkmP+9Xk6kyDXR8iK0o+gNyiuSw92CKo7vBdaidQQ5izm/q5QXyU4MyE6w5NuvFVcmQ9ISWy1h1J8FywsBSLQrGsZksPWe9SYwuZw4gR8KLP9bJq+cRkvK1nxyPyp6AMTl3MpUv5Undcb6U25ohJBjJMDWPtCaKA906RYlFPuMvTdwtNSNArAgn+WTmgRmHfK651Q4mRfgOtd00B8NRb1p0PpTK14w/gWWZh9GIxJzVr825DJNzIi++eZIyjmlchgGffesaP/XGNXDt2DmXHI+CHXKBFnUxAqSxz5Q9o+dhatKrruytIj7tAuD1yCjfWunAljMDKDM69rdnF4ZpGyHy0CGOUY1lI7cNVgZBbxSkbBnXm7+zTnwcOOOIT755DxgbqjnTSg+saLzqRAOj/Dz8L0eJbJW6mA0qRLLlWXFVzk+AaxrLBG41ly6v0RvjmNNgY8dPvn0P988HHLxlNujgApWZ4cfmxRder9+tAD9p51lKU5mIuzUyou+nNYYcFE+qVIQLeeFLp1qWaCDkK+ek7wxqOI3mRejsgsoqUt9N+ki2uQ1sG/CF2zv4/OMNY5vFGiqxt7IrohfIWhYynCVbMJkGvLYyozDclqGTr3UPp8w4dVhha+13L0Mou0GHvUap/g2vdbevZTOqNFtft7xs/5BCV9ijTsJ4AN0K7ujhv+voYZaiRrxPQrdbzZO0RFufJS+a42NtfjPeNqeZc6s1j3nifJZDh/wdyQITT6ibKx2GbmIAblQg0W6pI1PukmQHRlJNPNokaCVKiC2ZaAkM4Q4l4A8AmHAfzauPh7tnam3SaHGiSVyvxiZXv0FN1i/nRrCgd24z019DwBROnDcDRsALJYwUS24/tHrpDx2A6REJkqEmgnJSDvYcFYGrLiSljzQA1r09jN6bsfQUSlhlvNrCtV1xMdhcawkqMmui2n0KcjkJLkcghmgKxhRUip/WYKhjLY0OEo33AL1QzT/lZ07DdgR+7s1rfPW+Y3t6Yuab9ZSmbR3zzFJQcoIWVTdn3V5HtjJlawGi0egXwhiy7fF5c5C8CRS7yZesRghh0XgCemFba1cOkm+x7hkZGzfAd6gBrkcBXEvoSMrwdDhG1RKn4SffuAZ8o+ZI6ZnIqLRsT3GagCaiBIenwzi9AZXoDBkKlfK4JRAF9O5TUYcskhV5ZACaXniu29IRgDl+5q07wPEKtp1K/kdzXNKpi+19XKy18gsqyuc2vjTExKN6817OTy/ZE5TmIofsRIdwYVFTbwDA5pHVaUP4CAYbwZ402CzLNFEeiIzKgNuE7R7yOj10NI9Ztm0D3LEdB97ar/HLDw/45heAuRsOAFSKzoxRLKfen+DLpCkyyQvt4fe2wmYBurwnngzJxgQbbpHyZImrIX+lS8GuxWrDYRiDNKaHIcIXNDrtR61BjmSOhV6Pt2RCvYYvbfIEbAsacc66PzFO1nTTgwczTI0eI9dtG6gUfWmgE047yHKmMscGlIMcGS1dR2MOwEfIioJL5Ak8ncjDwC2Del7KQTWEW2WzdGvyLgntHC+F2BDnqhX4Xxpa0jofVK9HRAFB1ip4dGYhg+K/VWCS44JiMz0LADC8LjYshs2TYZWWjKfwkBm0sZL0ilzYkLHWVMqvJLbpoAbdz6eQTl43sD6/ioYYCUc1cHQlSyZK8FG+ZMvM6TaevDbyb+wuARueLlYCtYcEAaNSsQCdC6Pu5Zg5gTFkRKRMTF3ZmraTs8hnGTnTDKwMVZYvbMcvvXmA7wMbgH2EFwwa3xw4dNn0p+M292szwuov7kGCvw0aj4zkcxymgOlY9TqaFmFK4KcokQ45NuWCjuCk8s7cqpkybwEaPg1zTr0MBruFbKeRN6Ymcz7Z+wrMic+8fcS+b9j8nOzzcrIJz0mzVZ8onwUKrv9WClFlPIKCFl3yWg58egdNMLVfuRu+JvPd4QEcOAM//dYd4ADsg5kJo2gmdqTMpXGDmRyqvs++Iv96rI4bHsnvlAHJ6mA5wUGvQLIhGZiI1/9SLmiFXPPkq7xhDhsE94r9MhmnUkA4VNzqRYqoGtsMnCtGgBv+0ZvX+Kc+kFWDLLs4T9vUZFzyGRH5BXbD88yhKh+g+8HNoLFpOe1k6mFin1mswZ9AwFoC1yvxq7xUGHaXTqGWLAMaeF0OBtckJ7LJM3mlTMh0ZZOXw+Ta+ohRIQ9cPPnK0uVspcMKYDDLGFuXlzTMAPLcAKtSBO2O3nzYJsPMiMfvzPFxSHdXYmop4RRFqymXN6FwuRKxhQUKyEqUwe2oB35gaPoMyJPR2/Jg6iI2D88yvJAR9cw2n97g4lkT7P0F/JkoI8t6oaaoFULezkB29XIRzUnQu8np4TmJ2o10pfzD+NIzZbWtHIskQv3JwJLbXuoa7gJI6lJRCE70vrzBpEdKLrKRphqvS6O5jurBCIXO7wb5FMoS+kVoKQGrVH7JIR1ARoq8g8baOH6TAQ4oY90FzdtY7jKWBC6q0qceXgHHDdhc6Ti9gY+0JLgnqBjr8OZq8FNHfCoQNgB5aFXIWaZ4M0pURCznxCJqAzS7kDw6QfF74I8lHcVMmPHd4w69XcUd8KFxfS+5DFG2cBZgsH2HQnlt9W4Abo7PPLjCa2fgJdtzN0DTL6s0MNO/i1GnbM/ULYGJiac0bMQryg7PnGB5IkS3pRYJ6Ap9rJxDazKea2ad9I3HG37p/hH56rHW4Bl8VVMVgYipc/JThr9SyYAt2zYlRLmtk44bLN9XQYdSwkPa68aU9+Q/mMljOphZlpQdD0AwncoZHW6WWR0M0nsAvkfK172i1jSS05uRcQd2x6ceXAHOBs65YEdlqnqW8NIhpKI7qlG64Uiz4MNr/tyRMBPjF8DIGeg8FBAbJACSr8oWU84LmUzPi08mT5WUfaBO0ZZ6dg5OYKZuzwyE8mVkscTkZu/j6FP3sEV0wj0FVT05omXq/CU+JGZ6PoO9G9Mz80c7xyDNaFNAkMSS8qev4YXb3QI6+TRS11Nm3PndrDJMU3q5XloUZN8oA8oiwXFgJAaU8V9+JoWrBC+5m5OvlFAtNtKarjErSu/p62j2CyEhxJmcgfJcrE2gTBYf5SmDlOoyO94UY23VRzms3ZDlh5OGYIw4aMM9hW6WcHdmzWBOCOssJvvlvJDpQw9BaV49AbiErkBVAsDPOXb/d0ZWce0Aa0+hmJzD6g1WqYMOVoE8SiyyYSmwpL+Za7ABil40DUKJS0T6w/GFm3AAfOxS8nJMTH/iFL5MybGpx3iYD5a+AJ7gp3JAGgl9r3G7LALOk80WgU8D3fO/ZXWLV+JbzmeOaBAczUHbtlYDzAyZRxqY5QgbI5R0T8lIORkDeGU/4I194D1XDt8zSmAjGcroumX2QQCWuscIzKDOa6206arzFnM15xIY6JzI/5e0lLwE2azuCe9fkZ3BMWzDV04HvPx4A2wCYxPviy8lR+KR5EGC1LIGfFlPlncoRyNKLDrkJ++Xcw9XCUn6CCGCnMCiF0/km80pyIzTzPS/dCqIXWU6A5tALY00d1SUMXHNG8kLTMcrDy3SZCTrEwatWSwyKRlFI2xhxfNlNqkPsLoFISfhHDl6JtWI6yjnzxdnoMmFM9hx0ZVxOCNi1+IKGmWIaJyZ/SE40QQbFOGH8NF5LwGWneRzkx8ViBGf6tjgCOB5HWrM/izOIuXU0yKTHzrnxMP4DzlDtQ5pjVv2YeT4dBbVpEgpDLnTDBSEMWOb99AZ2FPZGBU6TT3H7Ojf7FbO8+Bh8YpRy6JJnla3TANTwA15eGuomcbEkB5qjDQDfhVNai8mo8/WWGTG2qg3UlIADXM4FL2HJkEV/6Yfwb1MkXs9s0ZLIdM8UjWXlywka8ygWr7k1Psly+8RTQYwcHube1sveZG0nKlQTO1XKiefNauGmRsKMS0dW1nuZoK7sfKEq4wq1KXsaQDGBNNuyb0QmDSulcFJQJ2eXdAEsnTb8noDQXDiK4+P0RzXMIsWR2I6ok42U8aAlJGBbL6LLVhmfKufZZMVWpNWzp3NX+SzPBjKGeUzMxZOk5CHsCQEhkFNGsyRNOTBD83pSd5S6IISyas5iWcxzzxhcwmgKC0DeDwPuH97AK4L2JH6sPwkCCDpR9d0mOcch9ahEg3xKQ0j1y3Dy7mw/psyT6MOKwNB9GZUotCLGyEsnMRHfsCNbzEvdvgnREi2lgi9ykFV6rHKCvAAH0O9FwIG7gDhy6ACuup7I7+NFEMD2FJG8sJ9zw+LjjTEhYvMhKbM7UiaBK76sMigq2xnkieHJT0stwcHM796c8DuG4btoAdgXuDN1yczYo8MaEo2IXhADqkM9UhDC9Ij5W8JFi396FwDAdRYuuF4JfeBz7wW0ORotJCym1ljArRMFMscZsLJmPJ8B5tSfBL+akjLhEM4ehX6MFuW+CRV4NwunIDkNnGKj+LZD1DQ6m1+7WaUPTU65LQT7XrtruG8hJcVvJGGhI7+zMbFRf8kE7AIYIeVXrP0m8BzSFdEk7WxwX3XCz/kPSnfZFojI47iRGOYeQg+L2aDURojTkKRrzV+poBwDj0xwkYTec+GJw4nUUTlukDpXHf2yPkanZPoEs40CpMM4twqKh+kQ5dC/tF39KLLq1OakGttlkACYTKzWRuuKN1z/gQq0kSRv1SrQDsCAcVBufVu9RVkcBOM6q1vbTwZyRh7ePa2WokiZYRgPd3wyI8oR6nWF8unnCEd2ajfTnV5p8wwmm/vAaiXv0DHBwPt7XGUN7Eq58qIKeda7wnfgkbLa1QJdvl7KpEND2O+5z2eRp9pXhm5eO1wZDa8xuJcIg0QMxyG0zQ8OB8gFR8lXtI7EChimKlmVJdMVTOntLCVa03y3o7TKDjq0Tgfkn+zj8KarKnEQmNBQwfDGRv27YCx7djT4RK4QXaxnCim+SmXLe2vPg+9tQ+RAYJh8u18vE405uM2cBcQo/0+B0k4/zFHZHacwhxR/PDMPGi7n8H3PcoBdIhZfnJUf4KyqbkG90pnWxrJMfEAB9zYAcd0QOKWmN3s+KKouAdH3nSKYmhg/5Mws2OaNR5KRQujqNssR1FSdG6E1TOYDVBJ0CXm9Wa6SaeaSXJPsfaat3CHdsFowVAuUEuaZx+ODx4Sl7JNXLGyC1ovgSF7pmSBqMeUkYZV/KEuWsNqUEyo/ADADFV+zrYA6bJuynHojEk/Gpor+icHrKYcZCc6L3ZVcl6wFLoGjx4AWl0HgJktzOrozL/ZiZhzo/gY57R40XUNG368L3yuY0CAwoVQUEeLOlkPLyO5kie86W50+bvlmIxOHZ71W25GL9Asp4bAPZv36DIGXRq2/gphemFoQpO0iewHn5EsVH2owzRksSJicY3Fpkl5qIwkuWZoSdBeVpLZkxqjGRAKPJFhekXO7aAhCY6T7zk2xZS9D4wySzbxaB94+5wyRgPaZIVGUo1bHHewni8NinW0bVeM+Hr0Z2NkkyHUSwBAMliGt4Gflw4oSkmgUg1zAL6T1wbfPR0Oq+u1/SkjKNCgooxaeucxjZlWOZmWHeePeK/AveTCU26oxKmVmreyM6DuxDPNmFWiynQ+y76jP46Nac0ygPGKBmw6PLZYi+TegH1G745lVF40AqWqOZopP7m/yS22W9ZZEGPZxkmHBO0tkIO9yJQh03JTn3KHSApqqG9ros11IrN3sTZeP+v4WyddPbxVy/3j2wZgR3ik+VmWEykLupfOHTN1hwMe24ZbOK6VxGlGJvFJWRGnbCb/JZ7MWkGMJTwSm8wAn4aRvRnqGxG3KRBx48iUDXVe/HNHnGvPa7vMJs8v8InY3C8zyTfQk13GPgxQiUq/457cwO5tAJ7MKHY6Igs8St6EZblUQn/2ZsEQcosJ8M2VAJAn3caUHENb0GmHqHbMw5H3+RIykN9Fj3KKczcbnSWJWdGPZmq652FCpU9xbeeiyW+Iz2fSLQY7yIj0VAZBhf+pf8SicvLVYeoNTAPUZIBQoNrT2XrdrwWZZCy9nsuFs/O5WckFXEGXILuZVStxX5U6x69YteqHSsckcbuiScn4n571YBqW/8yXJBmsUcyTz5aKEEYW3iIE0px1uaQal0w6l4qi1kYF0r+9atUTS6OddQ+SaG9ULpfwDHjxs/2htmgHAWee0VjXaYLudNcLYwTG/DL/1IumIuqqV+taPZwNguZxAlzut/flnPa4b2xbGiGvF/mQF4w86AR4yYxELNI/+dmaHYpj41IuZyptbheKUsxUqtkzFSuHxPquEWhejCb55Xn3+gwp76m4BIAu2HrtJ2Ulld7T4ru+53ikw4rKrX0l/jPLYNXdtvZBdGN7Ibfx7DKYkijrT82MwSID/SVOBp7fj2EByun0cUtoneVgtY3QkVsFY5IsOdCddVocA4DtwvhzfpucwFhO4aFtee/0KJ+lTPmexjBzzUrcjywh7XsxbyCzjAXiZxj2STwoPVUD3kDbkgvV0c2sHDxkozEdFzm3iwImZiEzJp4lyJbq9sItwBVlai99y0YVAYfIWBhYFO2p7/pUucnQx0hMi6aVSmgyyZFtC1knzpFeHLlqTZJrG0O6n+kY2TFLvKKT1TOqo+HvuDhbX3TisgadrrnIDQG9dri5yrHaTqjZ+jJ3Nl3znSB6LwBtFJfvDIi9zTC+ZD8TABwWM1XPEjPKgC4IEPfvXt0XQgwahPxYxg4icPIF8OyibDAUApLMp8Dz7VQ0tqkZ9R4sMqW8IQqfsgZGQ+1J6Eo/hTfXUr5oqc2Oj5QD1aIoaFqsIukSEzrxlvueURGpMxVWRl7coDGikdWzy5Fyb163JZ3S9QiSZQRCHQWqH8MjzT/aXApo+lqhKEWI1ObRnRcdnsFsCADMieFRl44Prf52V3qfDowNj1Rugn88Y+TvEQmWASjD4H0cnd+PuDdf2UqeKQORGQeCVx2zmsbKBnyfiQ8JXMyXE1B9hzJcY8RLP2xAb/oyRFS8m5qZRgKb79QpY2ZT/BxUcJKtAUtFD97UctU9Va0bfpZs0PgXSPJbOXUTWA/NSkszxSzQ0KMZCI1mlWhCygH2Ce6DJ78ESiaIq8/HwNjS4AHB782wpXOo1zjrLAhT5CR5gK1nA6S801CwM5yuUHSBZ4/GloGM0v97PYP1aQw49swSZn+HFW7GvFN+KNags1OZQ2bTsDuu5hkHeCuDrLrDUnIwSlQDsgHMCPzNIgR2zvoMKF4DWLrG8zufiZHMjsgOm+KgtDWUHhC/hYUdEhqGxb3ETYDbjTlSd87KGXH44lSJQNVP0j/ziWEHsJVhLHQLYLMUdr05MvHdrEXX8qg83gfRsByaSTkwsp9evSP12Lg+dg5Adm0BafV/0vluGWWPhlQtZFaZyNszxJEMXpynhcouxv0HktzhBfQUMnJHnCwzjTkzrXGA+Y5K53vRl8RLd04pGhLC8n3EjCbN2qMYnU2NV4aGtsNQng5QB9IwPZZraUZJpLGcg0OvKQ7BohGtm2WYDUrJlkPHNDDHT6dGnjGHSekzRGMGhkA6eh3KGMlWdaUxLM5YXDMawFLUaLcd2r5GlrOxZ+a8VQfNsacrQ+Bck4rGJtqJrbVs8YCAzi1PDsfdo+HZrfjLmr/mblSaCccW8xo0/PnIFgHKqmU/gOdRsEtj4NjSoSAJTM+P1DlBusDI8uAYnzu4t9/GwNz3UBxmbHJt1oyA+VR0aYj1uzkbwXMubAhsgmkm/amMx8SVZfs+H0FwlJY38E3jLv1bnBkTaIK61kGFmaI2Vkwr4cxbmY1rZ7MjZVpiSBlvcOTANs7Y9jNOMPiRC2gyQOVKB28kj2gEdJIi9RHB47FtcgTMDH7o8pLjD2Z7HHqzI10mR4E+DQ6zLg64j0r47TPP+PfY9eGjoq/c0WEkYvJRPTTaD+5y0CRzgOhhALA77s4dV5i5m7BFzBX9wNCcFooEMY4kZvlgNsPNdZIHkqcy4Gi/oZAd5Ve0stMFtjIbQV5RzrRoRf9YMV/iovqwZC5E2VU6LvNVP0V7D3vjG9i9j1y7XBxbnx8s4VwnzDcp3XBSIGUv7Za2Cl/MozLdPbvWRKyoqYblmEo6Hebt2vw2exQCY1naCKYy20SMUbYqgw2YaW3EG76DAOAugLxZS9C8qQzxt1n1hcQaWmMbilA0vqoQZ5qD2COGM1XKyVuBcb1OOA216nH1RK5J9yhyMylDPyPfMq3DV9eWHOSxuTNBr32e7mztkbdV+ULukqG5HbBj2jSCaNAzzUMKZhpKN9Q+RRMSW64RYBRfYh/VjnypLpvS8hIeOZkEWFipkm5XznQ6aBwXBeuEKkaDXJLzms9QHwZpaFESvXNANusxPYoEyYjun2gAA0Hc9TlTw32Ll7q8LzICfCGQ3lPQn5P4ElhNpzH4GgocaV8qyrANfFsj3ON0t4zyqiEw+W8DE/vShcz+AjjAfcyRDp5QHiudC0zggIlnD+eSAVgYHbPSzeRJdsYsQCwPtYVoAj5DyxSRl8nxUvz4vvkp3GrCvoN1PU1GzNHCI8CA45gYtsPnlu9OaPIkw875ZaOUZeHPitfF98wGpYHnEbxQtif44BkoheGPFP9MsNcJd5l5UcPkQBqQ5E8aebPcEigj60KAOOEvdZjOFBIHE9DZ5tHsa11H3iNoeQ9nXJvhDGvNqeQp7+/Z0GIHZQn5/DK/rnusDZX+iDJE1P3l0NLmaAi7uQ5uZwNyL3x+SWORcy08CZpzVnFmSHeEuFTT2lrVksKIyoiFwXcfwmU5FTEpOLdwNhtXL0GvCJ0OoTfh9az/swejstXe7qRNGNVywRXyfTpJMNoFlgrCNtVheeILnyHV4v2d+MjtqEjkCltlvacIzDLn9V4OlgE4aGxvdVCmz1roSwGxbFPUUf3ejAUAqOGBq6mUtRwDJ7BlTcyaUSVwNQMLGWUCKnMnKCHAULTiTIsR4RKABZJmyuIBcZBDxzDSopQigbYphYg6Ru6Hdwmj5u6Jh5wrp2NoTR+s6dJgTBQJVIiI53FXhKF1FKP2qCdYDvfaCmNQ1EZyiWR0vlKcOT+JNLMRXioxSOMkDd/myPn2hXqCMI7As/cm8JoJxPUgY1TEPzmEosxR3xHQeZ4/9/9vNPDIc9pHO10uz3PP35GgTJlSHU4AmsaNNUBP2g6HXhFN5HMqJZtms2F0NiOEPW5hz0fKJJV1pEGjRswdeGac8exVHJmrJlGCFMlCnhDkvZGf/JAR74Y7m5KUqVPiMsepuYzsX6h+AVswwfpz4HKo6Cg5HPO84+lhuHsEHpwN3J0HNGBPy8ItcQIXgla7Jpw8ZIp/ZFkAue1zlAPJdz0Y4n0ROg4akifyNrb2b2lIHPAtMpBucWbHnCqJBNs32KwteuzoV8SVdEM6iRi2ngEwhnpFKvPrMZ/jwIvPAmNMzDnUN1DhZvKaDdJzQrtduCshZSQynEnD0UOWKnewN0S9TsLB/GVSrwEWa9Uu1pwhkEfqq8rvTFMWLig76wi5JA0cZaRTzhQAUraTDjsH9HQIu2M2Z3MqUmYYGedWY80Fg9Irmup0WrjWrPNpUhgTUjPhRaxpeso1pOMeFpHGN846iZ4LuficUrOFqFM3C2RF97JrPfcbfQpTqtqaW51YH/jlDhw8D7kAydK2r5QC1oMJkjylKvKmpsxARVGmSQZwNWNk7RW6fAJBjrUwLSrqHpQgedJ6VsKP7ymUsTijQLKhhSBPouUcPdc53HWKJ5yAZjJwrAvNnZmAUqdBo1VypR81kPFzNmWlEa+UIeRUFBA7NUDPFCSm0ajovWdAUNGSeEG6Qsatl22CRD1FGOlrtmd2lUDyiVcOzpUkkIHI8TfD1z2bDXXpKMmYBVrImQHXmWuI+l0a3HGo+j0j/42pfgPGllsBR20TM6gezGwDrB5V/aVsx0al6TPdO91g+wy7FNnFlMtUdzMYJlQybD0vdDhUt6UM5iSaqAAA5nnHS3dOeGED3Ld0uFN8KA7Jh77jol7XfflDp7jJAcVRokfgbwLsFelQ4fQGNN6f91SJgt+5nPB93/G+48QH7068ev8QjhSbpwZLUDFATx55ejRqNmvPiRf0pHHmC3i2ngUy8d9HgiiPux6VBYp1l24aAxK+uW9yTgbWcnzukQHyzCr4Xgalv+goM0IVRIQc0PHTEdtNDsc07IcDvu65HbAdjOIIX5Raa4LjFmnq2bJYazzdcgA0ujmXMMb57yavwh2QH0aTAc5CBs4g5TUAPJuefIzLJnjgnOc1MkQKzEr+PGWIJ12CDmVTlpm8ijDSGxambE2PwACAcRu4NVsgZ3OVcWXruB46BNQ7q9WV5BaPWWrgM2qlqatpb2q3X+FApxnvURlSDmaRfYDdoClTif+TjoalYJGR7RnsCTgYrJTf60p1shsFoz5zLlbitQpdLJbpjpYqaV3NFQ3lPw3yZAwZbQ0KRTLP29MkDenZNqJ24q0KTrl2ncoEmNZnE5g+MfLlDJh8ATqBMwSsJ4mQCohcMxU96oSVshWFRonOpLClUI72T6S36e7pYDS6cUqNq6kjlX11BI0GKpJv0qOIXYapgX8DdOMF9XgQOOIKOlOjao45wHCkd3TE1z39OOqoqQCMOrpSA6b6PH9n1OdZbgqw3zL9C+g4YUaCPAnOoM+99w/AFgdSn6XxD1GKU+uk/NmzgTkjct4HMCbsMOBnRFObWdb4E0RtQieYjQHMM9BkNo42TXqJ6Q6cgQ9fn/Di0XA6bziOWTsoSH8zyRZlqSKlMqZMx1+ecSHwd8ihoq6DdOi/kl7ijYuPlSVCOe8aIuj61Ob44L0zPvlghEOT8qwSThNvSQK36qksRB6PuncbeuOfDn7aRjhozBCkHKhE0IBA5swba9wRgoR0AL2691MOot6/xUt93JENOFHCtKQTxzeLcdgRTrknXYfluz0ic4Cz42vv3QA2MbAnoHNuNKRF59BlGheXHIiBLWk9c4tv70uJaUzxd8V4jh+/DtkCYnHJmqMHcalK1KecwWCUDkDbxhnUtAyHkT+O3FpLe5YLNtNRaA7XWByd/5JDk87A4BZA0t5CZpHHhhu8HSDmRaPUC0HmIELRCkJzB3XEat260hJDhpddNJRcumeGAsIjh0XVlKWy3mNDR8UqgC+rRquV/6UfMAHn8aBQCYBKUGAiT9BJhDzRDkE0I0AnAYJosz53kUwSxPS+eUX3RVpJ+YoGMpD1b7bPcS5MzcuAWmQEGP3TaFFA5U3pQIpSGp5Sxm0gWMDTl3kRMDX/DmJUcp4GxjGMjgIbxExj04vl+isa59+lNKzzezZhMe1MIaWspCSCrpOOJ6VwWA3NX9WEpa1P+Zxamgz9krIDjboX2x3A2fCRZ29gIxLiyjD1iKOsbzPQOa+Ra2R0R+BkR/eIFK/zFZs8I54NgjwrwAw6ijeBNBIyOVki3ZwLX3hAy9wHbHeYsSs6I1DfQw4N5QQQCDP6L1lPA9zAkLI43DAPGz7ywo5tTJySiHI6JRumqAmSXTrc6UIzaxabiiMycZ7CCUUqlR1oOqBIjPoPCUfXVaYXKZ8S8RxDRmA4vv65W/yll1cQR85D71xQeSip1Rv5BuU4F7BtQXs1fkJ8rz+1lbAwLfeCayzhu5pW2cjmebqSTYtmq8UpzYh0GLRH3eI1wJi7EhvW5uzZbyDn11JZ89gATMfYJr72mds8IrqySmVISR8eENaNgQQqn2tVhyeOa60hm/GdCUuF51RPgkXKg7ZyJz5Ie/nM5tFbH5sOAyNvZiw6jUpNKkChYZuu7GHcy8iXE+0WpYbyZlRpS8YYJZvUG0fZLUZSYFY15jEISAHsoTvYmiPF9TuAobip+sdIyyrNRKl2L51rfRMMlCavbztYSC8G8DT1ghcSwb2up2w0Kh14M9pzeXstzAX4SsVYLB/DgLPrqYsxdMiISGg0Cc7HETWRQrT+OsRej8lJkVvoNZkiPsE8rovvh24tYy6OCexVi2Jk1hYSTxhUuzJcM155+8QPm4KsxlW2pa2TfrREV85TyYCMb3E12WRF5271RxmXRKlw2mTUE3xbVGjiRU6jkWkpRST9dZph01wTkJjs+QCA045vuvsQL97d8Ro2Nf6UvLS1c7TGfzSjzsYvRv7OLX4N+D0zA0uDYBqLSvtxD0aJDLNGqgvwDWETOgEOPEaZ6zXPCN8Rrjppb0kTgLW/yCzsua6wBsx2WTbzYDP8mucfIQ6QyRfCNOWUvlrNuxawZuyKtxWtkdra+w3l55JlJtCgWAo8gKIXUi57NHgJPnClfn/ti4/E3trv32SLv6cId30vXbA0pJltsYx+5AhkFmorWdE9SRuzDfKCQN1BRPOpo3CPVzpvLFFMyY3vuZtpOmB7rpvOXuNVKn0vh9KcyfE2IkwQ7rxPvOt64lfcvQX2hnvKpqI1BebbCSgDjQ8Ja8qSqumb/NGWv8Q9BnQO7QpRmptYn8/o2DmYgbbAYuzpLHuLnlN4lGXN8ZQRbbLjyfxYa8MF0av909pEnOA9hJ3L0egX9mBmEGlA6PaWN80cwk3ZMcDjbX/Ycq3hLMcOjU1j6vFyRpL2lA8AOpEWqPvkdCCdwjiKnNmWUuPSSQW9jnRSy2ml0xDPa0fjs7F8OfbfMTxr1JGCh4jlF/UnJd8Tj6mQxSwUh6y4xWgjLuPEyjjRILLpznVOehqlxRBTSlp2oqWnjUrlNR9GOIzkRXQLEOGeVrHFmdIuYTd+7lTqmLsarCYAdZVqoFSMUYpnqHUiU7CFf/q3Zu+uvaL6WYDLyZxUJJe8TxpnAsFENrExrU9Hrg2ZAhR8KBgvC5ApN6AciaaZnoZSTnBS63ze8aF7j/ENzz0GbjxOTkyS8cQ3LP/N8RLAaeC5HUzbCNndnUZBOwXSYYjDgrY8JS6jyDxFjkcFM41smUoG+weyydBtKLKvXQYjywqReQhDmpE3ACglV8pSYE6iTvoY+myedhztjG994QZw5NkJK42LJ1RYy62pBSzG78kBu3AceGU7QpuOGMtp0uEmBl0cNIyXnHV9MUTtfRsA5oZf/fxjPHPlOLtpeGu0cTjygISK1vOaoZ0fKHkwtJIAI3/U3G2IV2DT6GGrkoEN2NiyQTTHaTJgBzoWI7b/bVs4HpILy+fS4KcS5xoCX7DgCAnX7Fganjj3YZ4dH7/3CB88nnCa1FO2qQVPK8GN0tM0XpOyNAHfgcmGzh7568H8t5fPQn6WNW6S1+RbfG8ZAaWpSx4q1sp5Z8aV0KL4QTiVQ1ve4/kP9YMVEQfXkWDD/g1AVe+cce2yWTJldJLpAfpKGPd4kRLn4HRi2CgKQC+HS+yVM54SbaIrr7ekdcn9gPPYJKgJn+PIkSI9Zl2XjNbZJLSB+ZzKoBTP6XwKCwAMS19IxpmTV5dwo3NHA9eHMpD6SUbLoxcBSjKq7llCZUYhKnCisdX9DvBlKu7I+tCF0Rp9rjWvBYTzetffZdhF+FiM5i9hz2uKsJ3Oq+PARzKzY1wbo6cW8UsONfX2/eXzLgB0gA5EpIuMBkLZDFOphMrUGwclU93J4XMGpaKpCKdDkuRzLBXChG6A745t2/E/fe9D4DQxsrmrDvMxAX4MWnW9lRyu1C6N7wSAw5bbbVYDPjaLo666kegGfxvVIc5MQRqOceEYcF/65KItywmDNFoYQx8ARDZtZ+MSWxRMQu+3Oz589wa/8qnbyDjQOxQRTDyXAycdLPSsLvwmr2CtvkVjOT+NkLKgLAL/kc+lDMiPuTAsrjnysSEL5+n4+L3H+PoXbjAtX1bkXpFm03s6hHQQJGdjAGNjtTptVGaB6JgxG9AyBcjmUIxNpaRy3iwNfHwfh0bF79i25hCkgm0bnIdMjTRUF5mqcqBIGl/si4JxkhcevQVpDf8nz7+Jq3ErnpTmkceyqklzb6U6zgXg2SREUfMyAOZ0UFPXe6/ShD7X0e+okywpQ/FThgcNRyR/tAN5RoLwyk3bJVUqYvlF2RIBUv27/okM5YsePcijUHYdsSQMf2gwzQC+9K0HVE20DZH9s/wfvJZNG2vI/QJpR5kN9YyI9AIxi9/DmM+wLt7c93TmvTGkY7MtNMh5MBugz7pFqp8eJpCWg0RrMltNFWSmlSAsA9F45neMLIPJvN7LuZB3TsI3Y4iqIQ7WXxLokN4Pt7O55mIZ2bbGojmrBguALRViGC0oPdgUAutUlDAB9L/5iuJYRmtEcoNlU4cEZqz007HF7RAFlzesosmFIYF03wA1/ywv/qCDQCCSQ5Ap+iYwcgab4xV0YaRV86AAS5h6ap+S02QkbnLNVw7LtEwLAtgH/ufvfYDtOLDz6N48593KWjZwcy6xEkpjE+35h1v1HKgocIRh50lxrBOzgQxqFovPndvINv7Z1Axk/JxGIxsMqQCUfxkD1hdTTsQR6hnr2t6yGzYQGws2fOd7H+DFqxNuHagiEW14Q37QUKNkwC/SvRd45/7/7x9lajpT5cTRAUfjBUJmNE6CsUlHPPb8zzAA9w6P8Vs++Bawb1lKAWzmvnnKpPEoDdNITucLUITvw6ven8aYpR/pULK6rvHMFG2ZVbClx8DN6hApHittqIifsgVXJohOx6qzLb6zOLNeGavUx3LMaG9GNshOfNe73gIGMDZmW4v/S/kyS0aD25BRDkApckbFk66DV0MoqP3tRwxGk+HVIHvOX+JTVS/IywExnnbBykA16yk4EZ/K8BmSR6lX9dp602wERSmz3afWyhrJ1K/gF58oEMvMc24pLtoELwshK7onEw3sy4pJVXk317U4GMykNv3RoxqI5kp69nmi3cu5cU0KuqeguGx34lBPdxvtozXcJbCRoAbU9rSq4XfJ6V2gxd9k5izZWByBVRbWmnO5PFpgvNxhQEfZLmMYmEtVBJ5ebXW11jpi5SUqMqBav2kONacUalgoH6jkCAeA96pbs3xYrkWHyXDUjJjljLwDyOdlZVCV+kUJhiJLE+8qg0Iha1qap9ZZWz7QU4WrR1oLyVXzhDQOR7ItMllSNgDMG8evf/EBvv6lHbsfWYGr662lyflxKqbSrXldZQpMWwVJexpwa5mCfoBMGIoy7gXmQix1p7ttZZAMIX9bRoca35pSQwAQ/u1av6lIsGpwva6Nq4F/+v1vxh5z93bwTP5xW/pTuJ1KvRxCxeJzPi7+Jrh66bLSro13Cj5aNyblQBF56nbnGt8EL+c/c7EDDj8f8b946U1c2wn7eeYuGX5rIg4Bqer3XE05Afp8xH7neEhmXRSxFz/rPRHQFsFlyyCsto+yadQAH5u2E+qAKTqDy9zoeZTTUobUcKk/ikyTcGYT+8nwkauH+PXP32LuW1YSCj0WLEx26xh4y/CLAQ2C9dobT3nTHDQzyUxFnH4BQQ3biNe5tjm9TpVTsx/5M5b7haQdI9JuaEbtucIiC7zV1kyuv5sI0aUGUAbaIMzPEn9G6utkrNN6TtRJ3kzNB9GnNz40rNKnY2jPP/HVqbt+sZWSaiv+dOxABr3EwVLW5an73mz3hTG/4JcEJ4QOgMqMJlDRrDpw0UDRaMhwJokagQJou/dTfCJodU9BoMlwBgGcxrlkVI+dBS6rRXgTYq8aiYAcmd7qc50BjOw1oPDXuwG6YSqDSuPP7YorQYvIBjBPDJHTAfBgEDDykzkVLUs0GGU2QwEAzEJ0xwFdCasOJVhmaSOnSEcu1oVasRUtl3xJEx4dXIKiRzguGRn0LWjdsOyOfXc8fTjhf/mBB8DpiC275jnN6Jx2GaBFpERfEo1d/UijHqlbOamK/KsprNLBpr3jbEZbU8ZIQzGqRIEEkUH+J8AZMzOjGsA0VVNmQyRzjx0GfDd8yuZhM+z7hm945gbf+eJDnM4DGzJzlHrvDpQzV4a7FKxS+A0hUibIjNRz8wUTEm3in7Ndj3Zd+913OidkTtDBUh9SKoUXw4DzeeATzz7At7zwCPt5w5gErmhMotxmArScUvAZHXgZyxVfciSQAdUnUpkgTqYyAyZHIkpC2yIj2v7nxLMhGVAGKsdRNgdW6V/Q8LU/apIxyfsBjokDvvdDr+M9d884zRHnTahkR11r8FyAqqxgd5ggllo2mdLMURba3ET7XGt3PAkSsMCIUZle0lGX5JjxEjJfDk4zyZa19H8hlYyV5k6s99Sv0WgHWGs28rmrLBzPrWAUYCBYkai73MmFVgOZQW5fGbHYV51RKUBOV8Nm9iEl/z31i8Fot1Flfyai8beVLcT74iPtp0/X2Q9AynM+Xw4FXGut5nVZJgCO0dMJFPSBqsUEo5pxM5U9tXDAU+jLW+rMZNSsV5SSiGkIKXjDIK9VKLbvDftpsXpJoQRZZi8JQ4MnQW5MDx0eqJ8ieP+dKRwKOE/wCyVMAXQD2lngMrjNgPYn83WiShiVK0hfoIGyK6kQtiY5KPrll1Vikk0AkLXoVCQ60dkQ2G2A+NUEN24zOF9epggUTUhN9xSpDUt/RXrTOB/w/V/zOq7v7TjzrP4+A++8oaSaDPSyf5pgazVnRfkwGFhmyHv1OxnJRzKaq4YxrYnPX8DCFIWypirT4wQuEtbhxqr1BXqzlJNhuPsBP/Ar3sCL12ec3BqNL/40YYq+D9ezJABWxrD3ifA/dYZAsTCYTZpaM1JdLmpMNRa2nSB0AGqu7dl+xl27xW/70BvAI2Bzj/R+WODVOBUxi2bJDr61zsxq+x8dY7Eux60pNyE3qlnQaeFz5rO11trxU05eiUE4jaMNxkexXixBqL+YBnKeHWDwfeDe4QY/8CseAjaw2Z6sTPlyA1/MY7qfNGrYnPpW57UDNmdWTqicMa5hqMbfp9hT7yxjxK6HGc9Kfqvprhl53k/aDKu50pDqj27oGQca2bQsTV+E9xKNNgjZRWe3GdBYcpUHJJbg9ckLcGMfJXbVwaUhmXqxYB01zrF4Pp7lAhuqUCLtIQ+KohPBrBydFTkLoD0rOxRDt4zyhb51UZVdoIPQLNRQ16GVQekRIhrhPRkpGdwzmqHHOGk0+FQy3JvDHQSKheSZzuQJ00hY07xZhde8BEQ5hiYqR4URcjFgRYIEMRLWm+CiaBG39/HjGT0KJl0kLDLrqzLSi6ztMKYx9KpYzjmb3WjMQucSBLwAuJbT6AE8wTdSVY80qG64ALYaP9OIMN1sQBwJW7plF3K+ClwZfxry4Y7zaeJbn3sbv/l9b2E+Nhwy6tfR0YTNJsFMrNd+cStA6VGctVJAXlYgQ9mGjJuhKRQQRgUOFo9FkmEw46uFW00fna9F9BX0aQgqqu62jb/MhxPvvr7FP/fhN+En4JjbfPphVwQdKrw6j7vxoRw7MoI07QYJAKnxrOu3DErKltPglWwL/LmBQ+LTQIo8GFxaPGPuwDZ37DcD3/e+1/De5844b9cYagDNCSZYh/yUI+2OeGWu1pF8d0ZEjfGLDLTsywj+yVgrQwD9rWwC063ZV2CLcDeWDCmJ5i3gYkQq+rluDd8qrjvAcfYDfsuH3sa3vXSL2/OGg3lsQ3RXeSeW64lnEqDWb+TivyNxomFlWY0u6/y+8IMBoScvupyYe3uDZWKFjEo9xbTINShDu4b3astdzoDbXqknckZb/5QcgAvZ7DuXtLuLun9Bh5CjoTNwK6K3ytRloEQbMFsZoijrJFzdfykqC1h2erhOtOnnDYg25APxVjTNKzpd6IAkWZD877JbCFSf6XVXJAAPwyDXGelVA5hgeukS1cMbgSgYcuTkXIR3VymMFCC1VBYRDWvdhIRWKqShRO1rR82f6/USxsVYMxVtdU8hCFdXjBPINELuEkToHglKBwGpXQG3LdeHynVAZhmDpJmZPaDQktklOCYhZLSgWN/b+mejqZ5ropN19Hea4brXM6WorYzNoSHN9L2yBjvsZPjdH30FNk/RsHbRTxGRW9vIk4ZbFDdiZyk7nQDV0/Nq7lOXQe+NX+SNmh/zuuZIFCCi7ukynFHwup0NJfB8GxmHn0iHeapsMmxiPx/wfV/zKj5+9QinGQbAKC0zQHftHSEArWAiHVZXd6MRfPnXYgQLyhYV6KemW3v20rjH5XaMa3LG+fkEzifHR+88wj/30dcxTxsOPXy0NGZ9qydBlbOn6jmac9SXU9jiyxfUAQFR4+kQDfrBZiVstRwCdGFqgb+JJ55Kuq6/j2tc3xiwfWL4xA993RuR7cRZxtKB6vAmX/k5M1BtG6BS33n3JT+l85IPS4eusN4AZfk63gpHzFCvG/YnrukYVk5u0lKYUvqCTpqccJC0R9GkReGRePQOP3S4tXQvHnjSCoDS/fHYPPmz0EOEWDLgiQgyF6INlvuBjtMj6Z+fTYAZmD5Gn1w5BN4+72OjnMPEySrFN0zzosVSIso1DQnKTB61xamhg3NrD6eHiGRWLRZJNKQXNjRB5CTokfF6esTCLCp+S+kWnlWpwcUM1j1aCoknvnkf0sVwcq1mXUSyRDOuod+7agZqbk086m+utZQleHCR7uwljby23kKG8g8k8C3tlPcUQOdsve6vLUecul/IVItS6cEaaUj+dYGv55fsUsG5JqtaEWe9T5xvHf/Eu1/HP/7SfZwfTWxzTyeW9Eij1DqrneuaU6QnPWSi5ATwYYtmaQ4O17wWZa8HSVE0LfUbAHJOmyJxfppnKr3Sgk4QKhbTYfVbx7N3TvhXPvYV+G0YA0xXsxJBi1kqgkY/c0Gy0dOpXrqmlXoBvABEh75E6U9CogYvW0mYNOjnFyjCUsNoM4ATeZKeYew75s2GH/7wq3jm6gbnmdcawG2YeoVu1puXeTduOX+j7hAopStW5bISiuJ7rrNvxyx/qLJ/lP1C+hatpb7ofhRwqxFX52UkndTtDmzmOO0H/Mb3vYnf/NLbON9u2GzKyV8MC42LN5nv8ygBDsrQgbL6qlereX/ZmEDCYdZVr+FOOZUhfwVKzTQs543wPIJlIi24A2nr7d9ZZrQ8vbKcp/bHED0BaeCYYme/Djp7ANFNQWGu1cEXKtHqtZ8W3IL9YTmVaPPb88z9WpoL763awMQ3Yjt5O5dVFV1dcgd9XgFY9aMg5aiacS6DJfF1FA70Rm8AGBUl0XuhApYxqh96LNFE53t288rzdAmumNC2z4XhoNeViqKGJKl0Eq2hf1cANMPXBHKV9k5sCAwlDFyLPiGKRpcnm7yqk5QRbQmjtZrg2nxjoHeu+dOgFHKhxYvlrQrt+ngZ2a12rkBNRsb1PdfbPgY7SblrQPQg2JfYILIOxXfNOwk6Oqh64r01LGoiQ9BBbHvFnGdcT+D3f8NX8iSz6pgWILS5wNKW870MnJfXvIMm9VCzuu4JD5tzNIsmLy3F0Rso9MLJdOC0LdLa84FyrigjevbU81m6KCcqZHbDxD6P+B0feQ2/6s4D3N4axj5za1WlNAUSHuvs8ta7+KNOjNqaSGzoANaMUWNSOSheY1KPQtUuAdyKZE4xN9Q2N84pjcAO2NlwPg386nsP8Ds/8jr2xyMa4BaLE/IZ23ln0RReESANOOedxVRiz+hA2CHBoCY/lyPgaVCIfV6OG+nszeh2oZJMeS1WDyuZq258imVgzOE0Yb7j937jyzjup+iqPzeDs5hhNnO5nI0uhzwjwwDwqHW+DZRzFU7wHm0jIP8dZfgWJV70qEp/TZaabDWiQSf2uGMlIXWxP2flbTmU/N64TxQ8PkfYCkTmUzRu9JmF/JQnb/wq7G0whxq+ivVJFw6SMuRwlbKmT+w+66warlVpB/7e8DVn1nxR8PwZ/i5n7WLC0kX0AK7kppG82Un+rffxrgqlaRnFrhkrmtAxoLOZmRaiL0HeZGciI3bk2eFGoz9Y8wHoKRmsurKdSsp0NyNjyCja2AqUaEiFzpIkKDLj2EIWGvRae3ySQNTH4zO6QoAZg/y9Aa0iCs6FETGvtxYlkna6vwvhauQdbbJkZcOKwqVWg+MpgM1wc4x+4AoMrYvW9UxJQdJkGKWBNwGs2y6C6l7k94HNgdvHwHd/4C18/9e9hfPjETVvOV0QiAHEZ8fiYVzQZ0XEmlUZ/NUxNdGm0VMK1CYvBYbKAnFJ29vq3O5jgPNkLtJjtoYzOqCh/MMn/Nbx3rsP8b//FS9jPgYGO7+dRqCwBnAZacoyFyT6dJnp/5L3kEa7ra07XNbv09tDGnAkmIaNtjrF0UqvYBYRv6PVqqs8t/kZ++OB3/PhL+EDT93gbIfouwTWhkKrjaKKfFNRLPe3z1y3chgU7VLr5Y+TjhZjrA26FnVf6rXmbrWGdHAMyacs5YA4hfxCuFjrIe0o10fseHze8M9++DV893vexu3jDUd6ncsC2v2eWSHNsa4RrSQaT+qJgbLO63KXCmnOQItBgh7dMNrXeXliXelGXtfmRXxbf3r5DGVLNH1v6+Ra6pqlAYkoJ/locjwztU+6pEGn4a4x94avzXC6Bkb/kNlmgxXutW+pc54esnCteaS0iyzZDlKbDlwS2HK9S2mLuEbC66URF6S2wj8TkdLmwTCU72nyrr3yFBlRD0q3EH6Y9lWkl0LigJomquEuCeyuFCaF0kF7NFULotIRtATcRhZwbgzXyiuslE1bB3q2QWKTgJi3NiPb1atEg0aIwNuZEukbjPqONOMooqXlv63WvryDwOVOJG/WOk9kWV30FZ1sBXXNLemOxgeuf1pGuC2T0/yJJF9SwrJvoqQr5tHqi7xFcygMBWbUveftwB/85i/hxWfP2O2YRsBbA86s3rBmgGSA3WUIjGAYVkfpLv0RaDOqphxiuabeztf3uJVac25LrwkyapwOdbOzPEMbQAabyWE9uGO/BX7/138RH7t6hPPZ4ohkH2tqX6BKUKySgLcldrle6Y8KOJp8eVu2MlniuLWmqlaq49g0MICASX0BLaos4LSS1Qmcz44PH27xB77hy5h+wOGQxy0HaERGUUCf4ynK7D+p19PBF6B7402nT3culFI36lDy1tDk3uo+ykvKpUtGqUveMAuaO42aynFsdnVg3gIvHW/xI9/yCvYbZm5M8tzr8MIB2mFtwywntrjUaWOFGxbNxO/UJ/WOyV7UHKjjS5DhDNiaUHTfpWN9Xie5fofdBw4Iw9S4SpxJx6vz31KYaCSF2JeL4LijZceYjm9YHo5DT6O3sXNI9u3MtoNiEg/7c9uaeL8skNOylAL3zHbplUue+YZR2ZS8hLuA2urX50qvrfQAoCcCBzD0zuWefyCocKq6mRI4BcJIJZK3b7zHS3Ama2kcPAlBz8RZkxGlJWQEJX7XztlRWraMfC7XIaKuBrHWL8NFopHwzSPVG9UIACJkpuM8NZXXsO1UpdOMm4eQtlTGyGB6kXw0HSmo2U5kB9oLXLySAORPM7RGulDgWlbFmAFpLA2D2ojl9XXYf0f1BxTNCNz9RSiXQwOoU+EA2HScT46PPOX4kU98CfOUL43hNTO9wzS2oY+1WHE76e+UR4F2bd+Ke4U8kJG6+KMMVX4fstWc0Sx5CYjoCMiKTjm2gWLpAORpd9oKidhufns78F0fvI8f/to3cft4YMMMA8AuaxALCBIGNhUq+9UJTWBoSl41VF30pIsgB57RBA0XVsXpkZ9sscswLxiRgKdddROKcnxG5/vtecO//OGv4Hve/2XcPB44ikcTPndgn2XM3VAH3cdavfWDxPMYSaXey0FPOW3rkKNT1ipoI/z1OHck67HcqSKDmXJaMjXrOuoedaI5GYDB94nj6YT9seHf+rYv4GPPvI395NgQz8Ne0SKajktf2VMgEDfJQ7M0y0/s4Onp4OqtWHBP2/9WuDcAY+lu51NtKUGRrIsbZSu+qSdF9/nFPUBlGS6xyCTnNGoKZlJfa4XEpfx34qmKuc1gL5DnlJk2EKW9y7ll9noKevOgSF7LAEASqZudtgURg7dH5Jtui6aeE+S8u6mjQ9PnKefW1zWuC3VNehBIqmHJGj9q8IjgZ1tMA3qmNxsjtbWQhiipKgPFvbrgV6nA3GpldbbywnA1maB0uB6e2NuUhOvKNcprL0RY/+tNaiTU/Lw+e8dII5msOYu2K+PiylTeDtoCLxQNc/w67c11Tz+kRwxZjAKPhExAdMD0msrGJ88onQ5D42elzwhmBZqq/TX8CQZwSq08kso/PAB08zNuH+744Q+/gt/6wVdwenvi6HvtxSWfp8PPe7EBlt33Cbz5yIgePV62R6xmIyVpSPK4AdO0dslI3887ZxjjGZGbShF0BCavmVhZS4cQoS8TaUzCSIwNwK3huTs7/t1v/TzuPL5Nngateo9BzDtHJ9jVPxujk5dDJW7xdngxx9DrjC4949vg5MBSdhfDyAyatW5/FLDn0qnjAh+vyVZfpsN8B24O+Pe/4Yv4wL37OJ+jSdBJZ9S1wg149oLkfHuNuOkFHQTkoV+ikwNLesUje0BsUfMv7/NyXjghkzPAZ6a871NjELRVEsmG5DknjvOM28cbvuejr+OHPvoqTg8GDrbDd8pkN55pZDw/Z7+WdI34Uvwwb2ST0rh4DvKePrJ4lDco2uwPQWQ19TArSO/pA68Mq1bR5mntg247uizBohGRS1oRruM2wB0cxLg6ZK7kzzrN9HlLsWtKJafKbJC3PavlLRPN+QtH9BTAvZo5uQ79xxBv6uvgf5FNarujLHvnFFTkXGYGLTV3umXpeDmnolR7YV3aOZYdILaRU17eRLcpQdScOqPKxmHRwEoYNVYyUILJNAtBKXNfinw5K/cy+qkYOn+/G3vdYkpfFtOpjMUDCgLISFjxOT8zLSaji1Z7l9FbBMjk3JQBXcsEKa6og5EotKatIiVIqEwHU7Ldk8uZ6JrmVDEeQj0xhdoVUceIBJtZ9BWNnnzWArrknQwntMWxv6RkoBvcdALmCfsjxx/91V/Ax595G7dn4CicJiNmKUYDkc5uKpy1Ex5Njl7+rfFIh1SonglwV81Q1/JPuyZAP04fcwDgqXZ6ThmZrjPmwHbecfaJP/Ltn8cn7ryNmzOiH2DFAvVhOEEITWylC43XS/oyHhxT4DyajjRWVtapjKwbaZxPJGZ54wvlztIwNeeeUrWCNe8I3g3E62+/drvBH/6GzwL7Kd7XYKPAtKfYKVOiceMbsyzemqW8ZH+N1pEONVRqkpOL5nimQ+ZzRkpaGQFemKTk83M+fe8+QZzXHmzidHZ87IX7+CPf8jngwYzSczqti3xRf+RIlUwUE1007fqsXxqGgp35MPG5g2Y4oGkDyGfKUz9rIMusRYfCtsCMvL9ha8dBzVmwwmCj6dxsNND80OQ+x6EhZO9GZji73vXraFD5e9ESwpSeMbscgyvlFIy/9DmhzDCdqKXniCylvSlkhsGy4kSem4b3pr9r0r95gE0ve3BUS6xtj0i7OpBy0cFDnsdiVLk4aLJcQP9XPDgPOPB2r9L1adBTWJSmzDqVo4GYe6YocrtGYo2Ik6mRIfBLwqub29Mxqf3YRbb6LwXNCaTNyxOAvrPsITxWcrWeQlqlZ1NKoLRdHkHxhOPYOMZei1y7/LucZzhZmkh6iu3ZLaW3zAetBADTliEqx5SXnDdcOgJOWjcnyNozQAAhWVpBk/Xa3WH7xH6aeP/hjD/7G76E57cT5mliawAsK8U0cC8LUAkTHOKQkoxu9vxbmWOvHoAG5nG8MT3rNNRzwn2XTLMMUPdXSthS0fSSlXQ+Qk4qDeduOO4Ttw83/L5v/gJ+x/tfwaPH+RKgPUnUDO6iek2eyAolBa1dTDHkd3n2/XLgJZBb7VzgwobXxbnKsQJ4kXrGjYlZA23ecuktZbEcX1+ezfcFOI5+i5ubid/2rjfwf/rGL+F8k4fgTIPttV7hrDej0hzE/gQ6o93pM+t8pQM3y1BMzyg++Uc85fr2fMEY5YmzWpzHkjE5JQ3obRj2ecAL144f/XWfw4e3Rzjvjm2fwDkaQMVrh5yQztfSt3TYG3b2cxOSwDlaNqkR5xckpFwFo9cyQRuOpwC2t18SUylvDARV5KQwWNkIBgZdTul8xZY8kswuOaqxlje9kv9GU5szNrRT/dCcsix08TItwOsROS7FQTZWsygHgtW+6hCr4TyVR6pJm8Eu0lYKqZ67tmYH9BZFftqi1zGGgjRr69f/WmaEE9CWdDmLeRRwDD4q2iGJ1XgGCZjs00xk0MlZchuS0GUkKk+/1qvC40nh6N4ulRytQ5UCRuKSkUpXFxNgphOy9ONVt1r2ZOr7Wqsv99X4LWlU7DKoi1neM8GA44JvvMujVTLKMIOaISvSKcNaJ7c1z99bRoSkNZ4W6PLCfZRgTgKRnA1O2ESXokG96Mc5B2K99M7XMZLwpkZA6GIC1tKjyqhnBw77jpubiV/37H38X3/t5yPdf3aMdJa0gFYjhncDnH/2AmNPRwF7puizsawDgQx1ji2jnZ8NOqx7H8+VyhejnYah0sE+w7mx5vhe+Y6bBwf88x99DT/y8VdwerDhSLVImXYJMMCXVel/DfN6bEI9arYYNDiwdACwXB6K306CpHislrp/ybE9Zau5JE1ffBnClnla/14GGjj4jtMj4A987Iv4nR/+Mm7fAq7nWddxJOm7+Af0RZtb8VNygVUmaAT4xtDm0Nlk9ignzHc2zBqrjyEL0RwDptWlC6mnZvHdYQJ/6td/Ab/hmbdwczOwTYefAZwRWwCJs+mwAK3EJaNRgN+7xb0TWSU4lFyL3YUz4G4sREAWx2VD39P5cyfvBcbNLudDL7y1Lk6UTzoB1RTcjDSa/HtF46rhC3qbRZbwefsd6SxZrbUWX1G7jL7pc2WKaxAok6HnN92nzbIuqxw6AzKini1WQ7Jm6I2B6cixdASg/5eLGDT4ZRRE83IWVl1cHIzGp1GGPaRMRnsZDfIsqj43xdwitumzmlgsxpUm9OxGBfReZAtDwxS1p0CqK5Lbq/LZg95NAwQamvVFQilEVEKNUc4Ao16qBgWDnpq158rbTQrLoHHVJAGj/AbuFXHSSJegxqt7iz9O5qrBhNFw4+7i8Tfo7VFZAlfoa6XHAG+KbfqbgpFUzuF80W+B/nT0LZylCHiHn1RxZ9kD8fwz4Dtw8DMeP3L8tpdewx/+xOdwPp/T2Wdad6oDewH+ucdx1Gc2UJWRNvcLgHaNEwrvudOAhmLGm7Wm5xHXe2YK9jQsE+bNkZgeZYDdBfZqPvWYt/sOx44r23FzM/DdH3wNf+KbfxHn+2fY3LFllsJ83d4lZ6uBN1nXz/EPPsQvellisq5HIhRb6XUvKTgqemzyXL54MxKObPokAEKOO+eD1Ben3Ke89/INdcVpOH3i/NDxx37lZ/BbPvgVPH4IXGGHaysizwItoz5mK/PMaBxUxk5lgfSu1Q+A+p1OIR2BPbeBpRxwHXWfV+ZpTzlCu3ffq+9ADsaE7WeMRyfg9oT/+Nf+Ev5XL7yCm0eGA3Y5DsGr5AEDgm7jvJdXyCWjV7BAgIJEL3MzJBR5p/BmSLYWHM+eAzpc1o1uzoGYUoanHNFFhhxQKYHPR2Y+F9jq0XKt17KHpWMzDFECpg3ymlsPwky/O6chGVQtvduz1NtaAX8iVd4TmbRLcvIBzMws1phNV5JGXkwNO0dMLIVtz22OS4X7udRU4vmkbAAWemWN9pxyv1Y9ALSmXt8pknQaQdPYABShcCExRMV5oFADraZ84c1Q0NAZVylVoyMARsbl+cyYmP4dYEgmpnBkCoXPqjSVLQQ3eDSnNY+Uiu/iOBIMWypFqZcGoB1kcskyNu0S1aeNDMZF9N/dCwo+1aCl5zlWQaQ8Qx1ew9IAO3m9HDLLNDWFEW29MZd+IGz/vDkETTCLpi0F5cxaUABTaaYBO4ATcNzPuHm443/zNa/gD3/b57Hv0UC3TUeYx1HOWhp7PyVYs2McSfuzw895UNXuwLmyAdgB2+lYuKJAzwhfWYIdcjCw79UYRt7uE9itasBUYs7DAeyOq3nGzY3hN3/gNfyZT/wCrm7OmOcdY59x3vtsGtHAU3LVP0nL38tm/QyHelEUI7BK8goB+U96Ec1pUypxQuvw1HHNQXXoNBbLHKiPKXfca+/5WVeA6ToiesygxfF0xo9+62fwT33wddw8Bo4mFKsyjE85Zj5n8HInoJrKKT4N6qqfCGeBPE7nwPdzZJzy9a/YPQ83qzJSd6jVkLoz4wToTXuOckAdwDCMAfitA+cT/qNf8yn84Hs/j9uHwOb5utkdsHZ4UxmuNJPa1UD2F8+UygYNUGWBiB8uOYjrZBRxEYlTU/MEOqWR9V1c7CpV1d8lmyUz+TTUbiNiockRV8aMxvgJY4eW8WnyKbOzPkvSmhi2IFaaCtkNUJZQUTzHb+soh4TrzSZ4lpZ4aQuGe8q9z0Tb3r0FpKh1+tzXshYzvLme/m6MhfJieNGiKH7pyNS1pPEhPHSLfZJeN9PzYpo6KaTn8WUhZbRWT8NksKz9m4bSwDzzciIZieiV4mZURYFmumSoL6DSRVqwRyZAxwM0ivQOTkajPS1kmODeWeRBLpEa9xIaLSie74wwaxgZKwmL0RgDGE0ZySmus7OsdWVXxiFWSZrowJiR+3zpJEwTmQkSFFjZAkcAKiMCLwECmhpR6TOaU0UHuW4ZnaH7RxoOOUl5k3nxEmaKzn06tivDzWPgX/3oK3jXHce/9A++Fo/O17g6ACfSIV8Lbe7xCleredJhYQVQDojeNkfZJV1yjg1kpO2OSvufXSUFRbxUZPYTZCRJ+RruOJ5OuHl8xPd+9A38Z9/4Gdx7tGM/Txx2D+dnJlDrvkZ/47tmiobw4oG21DIbNkNeaGdLZwojFr5RL3PgvvwlXemIemLhZPYUkGauz0GAB1Sy46DFIV8+j21vhoGJ3R3P+o7/6h/7NP7FnzX82S99AFdPGXY3GXSHA1vQGudsFNi2jLz3mNy06M1wwHzA1AVNjLqExQa8pHGXi3QU2WdCByJKRUmGXvufjgMcp1vgrhv+5D/+aXzfC1/B47cPOPoZdoKcv9pNZEVgzkpM0yxVntPW23QGQL6lQ6/tdjJIDUpQcqRQvDkMuNBd0ceqQ9+Fu6VTcPAE9tBr7RzgdVzfKPwHZBDrCq8SLidMeXLy0RY2Fl8bvTxutoF0bsYF6zW45mfaautlP/QZygZtW2FM4mg1khf9leJv7C1H2+t1yuqpSB7odSh545xgQN6NRu224fhcb6Nn/oe85XNgwGGx2vrLG2nKqwmhEylS+C3AZ0xUt1FnXhLVGY+QceVrGqfF6xzg+5+DOK25TZmApjjN36HfxefI+Lf1LQZI6UUOU/lTbd/Td7Ysb5UmW/uRHGKOJZC7/pGPMK77YqiuxEnjkYtRmpPOQ/EfdZgJjS10f9Unkkp8fn7FBsXa6uMiI9qdfdUiq8CkAVFYDqjhk555c1o8lZnPcjgONvH4oeH73/8q3nfvjB/45Mfw+dtncHXc4zW5sxojdVogdjBTkyofsuhca+6xdwvUXd4Cnc9mKl1rzz87WjkAYUyUdisnwJhJQJzxbrc7bk6GH/q6V/DHPv4ZHB/dYk7gsAPIs/GbBS6FXSKbes33KuWt5NZ45bDysSfkDAo4dlGnZHTwXoD9STVIn0uCf56NsBqWaiqUSyFHL5+4ilPKgGPuJcdjA3Y4jjc7/vQ3/QLec/eM/+CLXwuMiSsDzm5hfPMGxwD2AWyZYTunIs09vSdmMC0adfYqh8hxovFjZEp5aPwNx24WOeQIxIWS5SwfHG9PuD0PvOfuDX702z+Nf/Kpl3Hz9sBh7sAZwJ6ySPlkRrGJHrGrOFYlGPKUD5Y+loCIPxSxxfhPyFjpJx3N0CuT8S8xaIXdxaA1LJ71T2WFnBnTJrszS1ZW9F9lLWVxGNxGZk/DjvACpq615pTJkq/M/LBBK3dmUSWmjHTebDwUd8ZrwUWsXt5meZz2g0I9MFrwYwyO0fSE/IDYFrRY/JykxeqpJU4zwxj2b6ZHzoCKPF8y9fJOIPyvZQUDD2Ko2NMU1TOWkkB1K0XhKKOzRDBLfakm2R0A4rE8F9ATJBgxy0CelrKqrLB4zWVkqnO+vprtu1jnbMJaaeSI9inY1EZKtmckYk9EVGJyA8/+zm3+pt6RjPCbfcwaa6055oPFMCCj+wIJPjtVgPx0ioS3SLL+roIDAaEEjCUBuVvutR0ox2KKcjUTSIewxF9QojVNyNHKm4cZ5u7wW49jUu8bvuvem/hbv+5n8a/+wkfwX7/+HthwHMYJp7FhjK6WUG8QgACNfFWr5Qlxy1sAnzCEFYGD3gDBYLdqJnTPtC/LAA47Mx0dO18223F7NjxzPONHvumX8LtfehnnB1Ef3PYJzBHliWRDyPJqLFU2YXTAlVLmteD8vKkm5ShYmXyerkRN6XIZgckILOcjoWsyK3kQ8Jc6L7IpmU05tKYink51HGEWv3POWaLazOFnBx4C//7HPoNPPH+Lf+0XP4rXbq5xdQ2cYIkLHlFoRke2oxSCaarcOeLbKMuZOBQZCgOQaW/PjKEK8F6lAUdlfLLMONzA96HYHvndzSbs9oTbhxO/4b1fxf/tm34Zv3J7E6eHGw5zwtL4e5YM6AATawUbVt+TX7GskUY2A6dLSO7ZAup7Ejjuvcjbt0CncLPuKdmqwIAviKKu6OVNFMuZ0Ttp2OZHE6ixGjh3cV7kSFtkewq8lTDbZzxxlta3l4zDgetv5xwywCovEQspp1xCZsAoW/rVacBbwDZIyxZlmGZI1ay1TtK3M6Z4DuKBGWzUbjgDlJnVK61l20axkFNgBoXYHR9ihHfbrKyMdXkuDi7cy6ApfTUX8ByM0Nv9An+OOyMbQBMh7BZ4kfKrQRWD03ucioYhBVIE2wBR9VIRox7VAczai2l8GcOrht5fXpMKNBLQVLMSLblCFysJ7GOUc0DPrtbBGhE/cKwvoemcpcOS/5i8xSVY2mpTiAIq99LRXg8QLUuQ8r5J4U/JMNI8+SYlgiJKjdUBKj308nw86qonALeOq9MZNw8nPjoe4y9+66fxf/n6z+Cp/TFObzmuT/lioN6Brbosgdqzs9urGZCR/HnC9j1SyPyTuwWUyt0dfvL4jvXZPaN8pnp3vhQrehjGoxNuHx3wm158iL/x638Ov/s9X8Tj+wGaYfzDIBEnGv5VTdWoGytyKoPmLpItHhDa3/lhnSWQIrlEWimbBNFUG5+mf0iFObR0JR6sZq0nHx1Sn49boIAC5XRAKCsBsrYD4xSNnadHhh946VX8t9/+s/iuF17D7WPATsBR2/KC/8bGTW4T3ffcTZL9Aqc9HLW9/Wl8d/Kf0S+/P6Xjd46+Essav6cTyJ4COHCNHefdsNvAv/GNX8Ff+cTP41fO+3j8aIv7TgDOqZ/sW5heOv4ED0tPQJKJ9vpyMRmUnRSk1E00w9AeY5ePrH9xS2rJDdA74BSkAdUkqccSJ6LnKaFRczWgZZFD0pUDrgvyu/idwWUFDI790uETxjZ4lm0gfteC2XTeDyIyrw57tDnTtqipNcecOh1yLnrJmINAaRbBZ73W3vL6VM7Wb6YksmWfxnDZnKWsN7naNg5QKcOmY9Z2FJFW4dBPHNCYOXNPZYE2youCq3vUgew6bgM69PIfG6ZsUNnCdp2kdtY2JXl46ZebYKb9t/5kDB7zsbpPQgHXM3unHbfzMLaNlKYepui+ou6sJ6LZyDaPBeDah6KiLKiBNUjLYENOg8IqAkGlVA2Aa9+2tWfkAzmp/J4vWpLAAnLo1og+FFFG3gKEWUKpvogSNDoOipRbmlB1LWcWwGtdIygyAMz5DpkbPSs97bTvh8OO8w1g+8S/9oHP4zc9+xp+3099CH/t7fcBPnF9x7BbNtNFKz14mhqbDuGZDt4b4jGdq+d6dZwjgXkyuqeCTikqdxjYvmP4DrvdcXs64Pk7N/g9H/oMfs/7v4Tr033cPtxwxMzmKYOOxk1ll+8jKhdNtC0pac6zLZQdEF9Wu1okXZ0ILV38d/HNHWHIzPSSp5KvSznIvyU0uPgpUNXBNcZ74k2S3df0fAYvqR4CB05nPL5v+FV33sT/+5vv49/73Pvwb3/+I/jq42scrs7A3SP2zMoADpwd07Px0Cx7BUZlWvjKYS2hkATD1EQc/QWz+lPofLGzP2VmII7wPd1MPN4P+LXPv4of+fBn8F33XsftQ+DxGThMz4bS1F82FspTStRLmlBl1E8t2yZClnzo4xWYFoiQ0136SgMW+lYGIGKeuK62xHnTFcpLOYftdsVdi8OXFG4LKalN3MGRY00AAQAASURBVNV2X8lku78WouvDuFS5ue+Q8tRPNSCmwVFm1HPSfMic1dDOexB0MDU0rDMXVllcNxHZByaeatW0MY0/gBoRZfFo3JdPi2Lh2K2HeTgvMNpkX74z6XHD5fT6vF10UKRbf5XXSWVmCoTD0ZAWZVKAInUyBrCl0XJwksEIvtmOJIjfrZ7X/gbTojROqYhhrIJBnlyPNqIpYWD9m8BT50BrsnBEe1hEK15RbRBBY5ewXCB2UpMvPWKqTGAmYeIvDeCLCGXsu6fejKsOH+lZAGP0lcI4gLkn/dQ93NA5wZ21/sUjd8BGEyHxVhJRnucqKM0mmK4zJxe57Py3Z3ktyVg7HSgbkIIzbzI8tks9Og98+/Vb+Mvf/nP4T7/0VfyhL3wNPvPoacB2XN3b4IcDJrZwAvIIXj4XYyvPmEjnCNV1lANJHGJ6f98xFanN/A4Y+45xOsEfnnE+G3AY+P4PfhH/xw/+Er7xcB+n+4aTG45zwk+IzMGeh1rRiFMTG89Jd/XMyMB6sf+CrUinTk1dKU+mv9PlY4SSaRlr/NWQdIw5DxqN9m8H08HRLNssA6jJFahmul94ktEl05E5PxiiCdnSrc+o2txx5bc4+QF2OuP3ve9z+Keffg0/8qUP4s++/QHsjxzbnTPGMOzumHOLdQyWFz16k4apFGCTkWa3rqY9/Irq93L4mD0ijbdMVZzOjnka+JqnH+DffN+n8YMvvYI7N7e4fQCMPXYoIM+7wOw8kqDJSKi/qhlbzS1p19qvCiNpqK3zW1orWbdNHE1xWjG3OyP8if4ZYk4LDhDnt9jItt8OiUTwlFf3FjhKjhoNAOFSBJ+BIVMBD9fZLBej7hQ2Hw13a+bSH1eKvZ5PnGTgE+NOGDYIGZ0olDcP7rU1mDGeH0spZgDp0JSNCVWn/vP+0tOeUJZ8pAfI7cHa9me1L6ve2VF0778tJZAlg+9yug6XRoKA2J2BJePdCZmn/lHwSHogQDSaWwblBw1P4oe17GXCKe7N1pERPMEsFsEasieIZiRvU+PImCdrnOfUGtpJhUk01sFgyA4q6FxvRdKV8hRT3BFH1edcuH0DBdich40SCtWDvECTJrNNq6RiOJQlEeM5LxFwYX98kTW7WZFZ3zomQ74ATzhGkzOl49CNT6Vx1HVa6539QiBBwpoB0KJHc1VojNmQB2j7zPV2xnkasE388Hu/hN/60mv4T7/yXvzJVz+Anzk9C5w2HI7AhpC93fcYwQawZfodgNJ1UkYsqViVe+aEnxFlgX3CNsOwiP5ON2fMh4575vgt7/0K/uUPfBH/5J2vAo9jv//mO8YOzD0Ny2yKCEsooIA3GS7yr4azG/5O1hISqAdHncsorLQONAn0IjiHoTFuDgmvkRgxW5e9M5vESw9zGnQ9jzjQ+CuHoIuRJptZOgAnjwTOPMH3gUe3E990+Cr+84+/hX/x4cv4E698EP/Phy/h/s1dAMDxaocPw1S0xHq+AdsAzjN6Q5ge728WUxMod3rk0rPr3847bJ6BHTjZBvjAt957Ez/40c/i+194Ge+ZD3B+YHh8jnJQNPsl73nUr0H7U/ouCR5mJ80VJhq6rBbEtwtbJKaSImlK3Brke/FF8k59lGySdF6GDIBnMMwTPpcAhfdT5gDNxZp8wVvGsUX7nlZSouE5PgHHJVJqoKq+GHRhW2lkvITjpAMrfeqAFiBGfSFGV3U1bYxtwmlZO0986XKez69sLDAxMdhsaN3eiaEadXL0HGvk9X37rzkSuyjTXa8aPjOjQ32kHMBxICjUNrpuzK22KcCLWUxdz25oAHpwHM/6A60MsgyQlZCHUngJhkhCgOwEadaLeNYyGeF15nozmqRw9cyFBD7H5ol8Em0RrQkC2iCJuMxAXkyrFDcZHrs+YsKVBkoAoCGUneLqm1CxgcMAdTgPKNqttA9yi1AXKk4x6V0NtRSTom1zFEhPcG5Wo3k6CTw1rztUAqSmkeIsMynpZCnlmIKt9zgk7zAtGrsPkWF6dDK8uD3Cv/6+z+F//aFX8ZfuP4s/88YH8NduPoCH+zVwPmOMibEZxhad5jzuuHhYGQdS2duJgZgTmzvsvGOegf00MA8HYEx86M4DfO+Lr+CHXvwsvu36LeA0cXP/AOyGw9xhc0g+fLbIxMnjojrc6+UnLkgRtfqBHsQsRYoNTMVD/reBPdo1BQsQvy2VoCQOufWv9RA0sJVUzZnGndLeLkACJpCAaukoWgNfUCLVexd3plITY9zg+8RhA27mwL4D33n9Kr7z42/hH9x+Fn/mtXfj//HG+/GL/gLwOBTicARwMGSDTupOOBQRyRngUzOv/eB5JghSDs479scT+23IzPXhBv/EU1/FD777K/ie51/HM3gIPAIe32447idcnZEv9oGOoqZOxbItMSv5od4fL1o0erq39LBxnmgOIh2/LBNZo11n9qRO1z2Gkc20roaynuUpLJCVLhkzb48hHl4Y4MTP2IVZgSRasMX/uq4vZ0KZ+nTKhfGzTUXAVrgX47Grny9jZXYyZK5jVfAlDw/OKVRBupUGaddQWE3nZeQ8Z6+JoIK8uGHUEknvARnnbi97H15cn1mVXkOjcqJsnDA1n7s4AkBu36xSx2FJ4xVvFoNr/LwLZgvRzbHuW6RhRh/amxwRibOCIksGjb9QKdO6cb6tLQwHys4RzMSYBjRqbGld/FS1Pl7PYEi+vNYqIsk5EFSLIXRaCJqaqcAA0Z1Ox6Mp6hKZp6YvJQIJppexdKszuul592Fy3YaWbkPVt7g1rwQxgWfOFqmUYgb/gn5jMaxoqbiWPOupbJEyBHUm641phDlrHdKyuHV6AOvBIhswp+GZq0f4vqdv8H3PfBX/6OYz+PMP3oO/8sbz+OTtc3jD7wCnLc8OmLAtqwHDYnvQVmquuu9pYj/POJ41+WeHHR87PMB3PP0Gvvvp1/Gbrl/D+/AIuD3j8dsDhg3HuedLXQg81J0G/hlFOPmV66P4UYEZHYRereC4RINe/BW3W66zHI+6JFSiPliivnatutBzTnR6Hc1Ao1KrxITefd6TsrEE0yM0VaaWiS8Ca4qLxXG5uwMHg03HYXPcOoC541sOb+Bb3vc2/vV3fR5/48EL+IsP3oO/9eAF/PK8C5yvIvr2HdiA7Zh1233PLWYlszzLY+6z3jxsA9gdzxxu8Y/dewO/8enX8c889QV84nAfhh3+YMPjGXv7r0+51TTnKnGftbRafNKeciJ+VomUdEhJCCNYVzYdKpYvYGNWODjB3PTC4x5tu1iaz8uoJbIT3uEieVkyZoTrXM+l/pehXOUsHudlJEdJo+ece1mDOLCUBbg2QHLHCTLzlNvtk3RxgyHT/Y6QWw4x4wTKipp7RrmRt//N5ya2qh+AaG3kWs/Con6HLFHphRWTbHluBevTveYku9Hs4kUWgIzvJv+ARayo/XkDwdfo3RfHDa530/fetBLa/F2CzO75ZgQYkjdvkwLH/0HkFxUX8FGvGaw8RBjU6MXUDQjAgJvJp4jAwFszXkWj3QmQM/GEBNgieBUxpeLkfHw6tybLrklIaZQTABapoULosJ6KIotfFCHLhjunuDXRMhkgarOAJp+pjCgbnwzaBtomLSeuvFQTkIRCtpqbRIrZFvr9ZUwMLppxaxjQUtGcJ0FnIAyBnzFtw+kMAGf8qsNr+FVPv4Hf+8wVPns64B/ePou//fAF/PzNXXzqdA+v2tN40464xRaM2Bsfp+PKgKvN8Rxu8aGr+/j41Q0+8fRb+I33XsPHt8d4N07A3DFvDA92wwEbDh7bu+K0udhSt4AlIxo+ig4TU3f9wBPP6EvQKeGu6KAJn/T4IvujMANNxvp0iP4CLm80J0tzrGElx94iqMSI4FmtuTJZTC/XoS8yCDqK1iVHXWILqDKLRFpOAFnqi7P/zzjfGs7meNfhMX77vc/jtz/9ZbxiR/zc46fwd29exCfPz+Pnzk/jZdzDV3GNGx84TURXPpkyQm+uDXjm6Hg37uPD20N8y/V9fNudN/Brjq/jY9vjSO2fJh7fDrgPHH3HFft/Mur3TPvPvhY6RMIYqoxjidJM/5EhjtJbZVeoM96wrm8N64aW0WnIwiz8Gi2qTTwsEwjVxSkHbsgsFeWgjJnVSEQqzT2mJ6stY2+Iuj1QslcYWyoJFOs1v7Q/JbsGNuuxxl0lJ1ELNKYrNtG5RtkmQ2a+wkEIWZd2yA6JJ2OdsOiRj2SPmTETlTSvjFrDvrY8ZTD4aXowDCw05VzXZRO2sKF5Xz17Qcoe2hiN+OQyp1TLU0Yo02jylADVjLsxtKbg3Izc7H6tmp6wATpSuM0n7odu7B3SRVQOQ4JEqp0pzloomZ9jkTjdvnuphFRDjAraWEbdm96Q5RJycrKf8xzAWwKI/LfDVQcUk9EmM+R+lVl3llFKGagAXNPCxn5vdXnVAunwjPZoa4GqmlBX48PGyYhSEEV4OHpmiUAQaXYaj6b0ZefEmxIlphozGdeiEncD5o6rcQYMOO0DZzNs44SPbw/x8Ttv4XvvfQnAhjftiK/6FV7HEa/jCg994P5pwxnAFRzP2xkv2gl3MfEiHuNduMEdc8DOkTG63fBoH/A5sM2JI+vg0wL0laUpelbUFmnl/lNbJ1NeCS8EfIqqU396/XQRZdG7R81LvyixzeK7HlUpHUgk7ClGRsnO+rIX6CZq6aVU0kVppB5cJ4lKUkiEnLuX82jNwAW7c+7x2WAUm2HdgOMKJ8yz4TwOmGZ41+EG33F8jO+4/ipwvINHh2u8YRte3Q94NAfu7wNvngamG84TuDo6XtjOeGrf8eJ2xou4wbPzjM3OgMXhPbc3A48xMCbyJEcPo08OcJswaECLzzIy5EgTdp0et6ANywXeZAPiF1WtUjRdX9aMjnvgcqmvoW5NXWZjpkMBiGSrByhIR4D9RNamYG28bjL4QcuiOpCHAbo+VomAoCIjgqQBa5Y5P23B89iZQaeyldeE01wzLunjbbKO6BMrHKV9IAZpF1dQQpxaSmDEYUCHDY12kuDirGvtDUMtkS5xsnCdPIq3z7ruT+fiIs1COyg6dHbkbN0ch0qDkYtryrcEsMWTvQZOJ4DkzQlXKaEZ2CSAhFxCMaG3EaLOEphahGscHT5jCE9voozowvhSGq3P6W3lCjvRhpWjoAyDC9iYylUNrkxgfoeMJEgfU09ByFakuGX0kE12CfZ1mpqJNkyrVrl0VUZFFkROp9OD5p1bWWsShBgkA4QyVg70iIO3o82bdURrPQkGZgtMzoz7kw/r+qbIb5XPLqUpkobOTJuA28gsjmPSQG6Oo4UzcGsjPjfAbMczdsJz4wE+OooX4ayAKBnP2OPvs2947AZgy75gx3Ge8wS/5AUc2PNQGIsjiItHXXRLf7Q2kaGMP8BsmjWamGTkydub/Fp9ZAufGt+DSeI54cHSqDP1HWprAdIzAKmXh+BoDgblq2sgJ8LPU2fVz1Dg58YkSM2D8kd/X09KPEHqsLFPJvm2jR3DDOcd8JNFd/jNjqvtPt5vO96/ccsXed/od07dOwPuAyffcDsNm20Y7th8YoMr0oejDpkqYubvoY/dbV+MPqWhyUrLmTaMSAI1yCWOkVYyPICCmC4shHVG9XQuDcScyqLKANdjm0DkvBlFLxeVPcjp5ZrbWkwfBXZPbgG3xH+uq8pcQDqaHSQyW1OvYC+CcSsv6dtPDsT0PBWwsF89BpQh4hqf3qJ7y0yDpsJeCsqmqGUqXwwrPbYUfu06gyn5J6eMhMpjhemi60fOjDW8Tp7oTZXtFtoULsPWseDMAPSfBWxWAkTk7vBpGMlsvXc5jz90r2tLMFgIY57Q9PGgRKDOUl6IQUPitYiQFUe9aWmEV+R1r+TyUihJCJ6KxbUxUm+RB995ru0WDdXlx5AB7RhRRrq1fU8TyLGtthjxYaBAuUBWfRcJopUSp6O1AoPgQEagrxlLlOUNk0zOki3NiSA5jNcyvWSSNV67ZAGoZFQshglmUGlm9DE4Ec7Y6vkZ7feImc/xNlF9n08fAMbmIVcD8GE4ObfxjFpnm7IheBYJnYkj+yuK7WsT6RJZANppAlO2K94tMVZaV3glWS49Z8mKRG9mtUVeQtRGv+nZk7HsVrlwSBZ5AOQUq0JH3bU8pz8vt8oGaJQpix5rsdI1A1lt6jmwXIP3tKkDRBKeI1LRT/GUeiR6pZx0x5UYYbsDm8HGjmETvrEh31ovE39Gu7fSp4d5wkZdJnt8oI6MzumLdTVX9tRQMnpGQ8FUTlp4KUNLbCz8a1BY/BIXKltA2eB8PJdnkDhKr0IVc07M+llFvuW8xJxMz7WGRZ7LTuTJWwp7bMEd6UDKGbOH9WH9KEomKfkzgwZTwanECEKOBDfPwJIL7/knblkHs57kZXk+ucbRGmInlPZFvFI75NvilD4gx6sov/ptKpCmjBREe9o1kzx0Ge1Zi/7CPUvmMVutsoJ5YQg/l6yRvkGnQyecVJsAwC7EorCElwLQ5LN+2oIAV3RNoV0FGGvNJhmHsSWIJJyr5s1nizpxn1ddW4SUhaAlKwLIlHo6Mas1a/NLrzQPA1IadpYT4FR+Z7qvCWc6F8LOYYvxF9N6GOxF4wUIKbSZYVBNjdsjS3I1VFdkpZEtxxatshtawNV+VAMoBe+7AgRWVr2acWRlrkMZAdcc62UVUMQSjmQHEVOAEWPNrKM1ntPDFQiKZTFfot6I52+MRm2PALDl5eeUYIjWpGVFaGgAm2NdgDFgAu+mppqfU7j8QutUAoLWE+EZ6vAaLlsGwcD9weF0GtymeBzgS/0tqKwgoubIOQtoOg60tYrxaO6g1+pdgpD81/UkqbVGQY8M3vAy/syAEWcAAbT28AvQWkaNGRk2/SahMrYIMXDqQOdjzkn6WPJcqV8sP4LzEhFdu+JgBUK9RnspMauDHIOOUc7GYuWov8kffWW2NGO7cCmzEcsLbXIVAX6SE/Y/aXayGGW0wLXqmuK16tSUSdHHNSeZFfJgAg1k5Ax33QASU5D8HEVl779Mj3c+NOzRg6h0E8AWcxoltC2y5lkAMU86xmFOc2zLTXreoTmbC0fOfzaawSXEwywTSJ5bB1kuSHyztqjkSelsOau+yGaTZCOOXzyfV3UzA+BgqXQqBQjobOkCF5DAVOPStjkrQoDRP4HZCiD0HR8vxHM1WlAQjHkUu6QICRKLLH8oqLFGpvGMiLoKYQVKClVQC/Bm4Gg+qZRJk4rg+Hd5hYxI5EenkJXee4KFVZdrA1oBpBe9SQMDozADZRHgMsgUyEkB555fhVEtoI8TCes1xeaxQ302Z0d52AXsavWRIDY5K/0IbGRkY7n32ugINdKR73HMQQJM/l6lDv1HcxBmci1Oo4ACKYoYhSTXM0lSng6osRI09a6A1bMup4YGoGTYnZGu63z0WKeS2brHgYgSpMHlVCqTs1ikJkAUW2tzS3qWc0sZaGCkTEKTDcFsZc+aWeKC0ft8dIBGypkMUU9JzcIlRpQ0OtXkWtfJKPGUyDzRsQsaG9XqBAXrHcCaNx0sA+kG2bImTKk/XBvaz4XhQQ0fS5DgygxK2xnVUU6KYIrI6ASuGTMOQ8wofNHZ+mhLrckUPtIAL19FtnbhNY381rI7yHo1+NIx8jrvZamPJ5KKbuUAq0lZmVyJj+Yum5AzYsOe6OmVfRbsW8mZYej7Qcus62OsCkYCkyuQYqRO/SHdAL2MyQLA1JPSAq/Qu8xyhQKvLOCPQ3K5ZI9yBbB0AlIO4vmpr8k7Bj4MgrzJiTV6TQJhMwQlkZx/8tlK1ssKem4DtBT7fBOS0jujNS+UqhYgNoCUHF9aCEAE7cJDj0MNb/nZsHjTUT+MpAw2H5JKm0SOdc4Cojmp91KmrpwdCpfabI9sZ/NyEzRJcBPTBvKF7jFRdm0IYxoi85fiUNYwO5A2SkoTqDKNbc2Z4RptQG8kto4CiyFLgWuCIiAnz62biKCJNY+bOlfPgqhJaV7wFABT0rRl/S5F8qQX5crLiCkmUQrc9e/ldXlIJ6MZJslZw0rjc73TGPUcbzRLZe18E4BIb2hhClS4Ls6/d3sLC1tkZKS7t6wP6rmV34lnLL4rSqZb+K25inGpM8pQtAxKPSx/p3GtZcccZr+udKfscKawccEH/ujW+KXvPDEMyaaMjfe1X45TjgnBudMepL4yZMBwf9LoVDFW1ym6I4/RMmArCbo0C5AbVMV/phdJrehUWIEsiXouIXVRHmFbeOepdMv6AyHLstyWORsDVrbzAXxm0ULZAgfmnmWaWfhbcg7JEvGzdntQ3vtCerYUOhJevU/KwrT5O8D3aUi4pR9YbYWwKOQqrmmgxUfn3CuQLFJw8KnGvaBzufRockAttGYOXNdraNViiN8MoBocyYHKEoZGRgt88k/nY5tjleusXtGsxRUfhvadEjD0N1kUlKdS98ePMbQVkA9mD1xER3HvsDaWmJ/PHZGeSn+piGwAFJ3mHAj8XGwzgqzNxO8BbtVkZgLVXtKd7iW0uo+0sLZSztvBmpLsmI3MfJEzHjVMRm0eig2X3UJFdNC2KX4Ms9pawjWk8nrS4YntN+7Qi3WaLeqpt1Jm8pSyUFR3HlRB0hra6zRLwoLGxSsZwMlGMlc6vrhu8o80nsDGa/tiAoBZSVywprI+cg4k5PlMoG2DtEZbkwwbCdJOb1IvyYwXAlUElh5z0kSHyFGe09iM1JmZIJejFoeakUs3K5ef/5U++gr27M3oNoBzmw34SWRHq+WjZKLdFmysswqezDSQHzV/T32QbEkei8ehS9VDMrrxQTkbE6EfNi9ON7fSUauPNLcQ7YpguhPL5mEFGPlZrb1KBcQ1+u0C8VxMd9LivRJok8i18GAbohqNVtOdCjj4UAYqaLsioMhP8guhUX1OPXUoMJHeJG35/fTkxUS1XoEybMsaIVlvEW/WteUYCn/yp5cv01kVrVMflRWWXrn0D96wq8vnnIqEyTOA8wEWaXHTgTvxSma+n4GcK6yr7dJpV7z4iIV/dbcskZeWat5J3wEeyWtau9eIxffUs6VnwXPxtPqECMqhDqXiX7MdCVz6KuyVqq2OsrJ6C+1NtsEAHMRnSKpQDVUVhROB6ApIyTjZehbFrPDMGgH1jPjP4sFwTD6UTUWpboXg+Z1DTqWhhFGGokbNe2etx/UNCs7yMA+pCn+bMgRkbpUsUAbDGjNTn9x8AXDjYUBkhM69sT6tZGcZO3B9QKu5Ml3YnLAuAQncBJwCzOYVKloSTsV4CoG8LoP80KCLzmZK4SQ/NRsa19UYMKoCIEXVf+lti6S87jIKrHShjNJYaREPmopiODcqQYEz+UjGQSJDPnLeUkwagK58ORbnQzjo4M4moX5CnBUhctpN/3qU1Wi1Lh6rNWsK7qSdaO7LfLzT4uKwF61MqZOYC3vcSQXxzxtfUXLqcNXhw2ChMjk1EXFu4bOOz67UuByFdAaXeyhujVfd81yAFr0E4Oga6EnjxakQPbi+wsdlj3XDVBkFx0WfB+eh+lTJnRbVmOE9hdtX3BG5rbLxvxQqZ5MTIe8r2cT7koc6sbMWvfiLXnRY8FB8WKiWuJn8IE4vXh6UqWM2SD0hDTNAWSCthEzUJw7CEsNqD7jObtxkyAG9W4Djv0P+qdmppvTCqmgHdj0mZD6K2o0eFjOP8guPri2ulu0pXSkZDWytMmLeRQFUMLtMDbj4e5DwAsF8uAMREWqJJrBSZM3OecvaUp+8oRTcmU4Kt5QvRqTn6EYRtgW8tI3DOmhQoYpx1cABRYaqoyBrQxZA6A5158tLpeLC0B3NqteZ/ga6UKEMBQD4rMiiRVfCcFDpmK4kPPqChcqAKBoiB1ijK5gSmZvRAXmT3Oc1HLs89qAjo0h1EnMUq7UVcHpFAQt4rH/no3OJtnxms5TXDLU5RLyEMLFSnDIlBTCcm0H87U15ZgXqhYH5bxnSNnF6asTj3MqjzxJ0NEe4tqHK+PN2EZ2T4xpjHEU4zhpdyellpojOb+yAKpnglEgDI98pa15T51Gl7qhT8AxY3m9h4RgyHUsxr6J+Jxnf017yx3nV2QCehj/rsfpv8RWdfsjaLqAyBQ3FYBNqowt1WK9wRcmucT1WuAWeIUtnx9LlyMUyahY2McvVtv5WdN4yINo+2aJr8oTLFS6VQ01pkdqmTtCkU8GEk9QXj7n2pswKMijbxN7KjJT8ATxDnnLSHYbqcYqJDRuANjmNZc5ldCH8iesKuRJoQVXvvCJd+6fENtF2rsEedVtepXQmn9nWqzd5cu1WPCzBL16iP1s2ySSvC2narGvOLtno27VN/OW4eAc84Zw0Wt4uzdIEKvhzwEZll3gXMwy6nzhmmRmIMUcXFN1ACfXV1487MvllkWLtDSr9tYyRGEhhkKdM4zfQXxJESNYcxwaem+wwpWtN3e/RK+DmUpA1FTLaggvICEHLufDJGb6pbREOWkEkiNmFkndhoHFJ5RT4FD+hOntXmmRQ3NqUpikFWeOg61RRY+zXTrqOdV4dsGjfgP7O66YwHVyRc+nFb68xrDjGnGMZtix/9EYaORy9x0FKkM1RajAqmtCglvS19cnqizslfwTrFr1B4yTo8r33pFGORaNF8QEyBducHqc1fqKPpebqScuu23Tq1ugBAS4CD6jURYWl/E4Zh+TTRWaHdFtkA029+buMnkv+KRs0TD3FT0Orfhr44mwpMyJAIyTS4aULDVmtjtFw6NAhbs9asg61Og6ueWthjQeSFRIms5TWhll/XCSlBQr5adiUfGaDLuftaLLKebSpyTTk5+ZCIRk7a8soeLCae2JDd45FljSQgOBVUr1mBWtPfHdgSzBSVvJ3yZRBsj/conPeS98raOv0bBZD4676XJZ+xRjNoc1JjlrHo2VfYz6T+m6W2ZluE6jbrsnSsfZcC/uTRmJ94XxpDvojKe+kbica9cMBx8wD6Uo+yxYUObTWHFcxAqq82OkUX6ShZwPxZagvRXPZQJ4bBCDaKgkTjA7luFBYabDbd/WI8uz7/eINvddGuJiSV8SZijITgPppaAKqFvGTdCOZznp/Beb1kg+VIqhpmkeMWU6gQ+/+puHSxcUsdpVKYAzL4SrauCBpTypZjUuvW2KV45m3noemQAXKnCp/S0NLZSHtcuSmhqohCXwoVeJPpPHYT2Dk/1ydONY/9UIOjGZ0IhoznoEg3kB9IXoJhgQkDFk0+A05c7GuAjyCRWR0oCizg01PHoxGa9ZZ2Wsypy/PKfBtGYOJOASnA1uCaxz56sW3BpjUA9Ya+5ZAOapyNmpoiYrxagkb6Bg8YbesMnJLA6rXfZIXrzwWxwvwc/GPsuc5mTpau7E7hzd94Ev0RTlg/ZH/llFqoF/L53wTxK3Sp5TpLgd8XbACBEM6vxlcNEzrdXAZVy6CGMAoEyuNOdUnujoas0pf81/8Lh3JIKEVH4zRa249JQ+KpXIoDF7rAuR8FNg0GjNLwaADqLakWfcInw1qQh5lBeW8SW9CwMBthFPGe3VgKAdWRLuYYRpF/ssLJ134XEZP/3AUNvNcldko7uXoS9PooDRmCvkpkPCGF4VffFw5CXwOr6W+dEd/rgZdlieuGpdjJ30czf4kb6hLbtB4ZfH6T655Tmp1BSlNRri1uwK3/sMmXEaeSXylrnpHql8AxULcNBy5sK4aZZxbw0UnbjvBiOkklgtUC0NLoST3I9K8JHwBsHgdVqloIi5IfEth0irJtkiKTTX6dqam1qiNdI46xIQCK92q5wBUAKmD/rAG1uvNgxE+FVpo0dboNYWRa1tq7bysOT1U8qVZxFFvGmNphoLZBExg5/VguWeUn+TTkuITiq7ArDewtQV244Ru43gvU810wJxZBNPRrO8A6VBaL//VM1TCbwFKoWmr2sg5cW/AzJJYZ7R6Fwz1wquihdMAoeTBrZ5XhrMpN8HTSvGX7xdTVrrH+VAYlARuNC8d90YjziF/Z5OqJ+2ZbaThsi51QTSd80BaMPXXWGNwOdC1dud26Yp0YbFFGRxe8F6NZ/yAC+caLxUILc1LniernsA4rakwTzqgpZaeU+dm12M0GeIUyGWSJZsn+lLWNTUlkoRYySCUZ0y1WJ0bQ7zFke8E8Gb91FDMRSiT7PUkwmbLNtXrtok5hUFo5RtyqmcnVkyIRmLtoy8GoIjS+VDr7V+rv9CXUeLZxC9rPLVCKafsN3ydbJa3pFEb0QEFOLjUf6CCJ2uY3651lP6WDbW6bNJhL2x1QOU+6ftYLaH+ayWvFYTElQdvxKx3zrs8vovxckF5hoqvpKWR4qJjUiijb20gRlv1zxgir1syA74CihGgveu4Ax4nsUV2wQRxTL/V1pJKNxulBllSmGUM4HMB/XiGiQFa80gJ4L/h8GFxNtHZJWg8DKfWZwvDqc5cd9G/hJ7b0qTQPIG2X00BSoWOEkPRgpF2IYJlSq2lfXPdIxWj8NoXAAojNnSD6nRWdPPKpVLXlufAPV8OUiAndaTA5gbeSwEHu6K1iyCBJ7wwPcyMEFaf9cZCAhVoDKwr1/pTNTnOxFHHkOJCPoSWIJeWzCLqAx6sFwmvlN9+TXOcKSdBk5Ye9qZzPRpEgUDw0wQoxAO7WOpaC+bi8nceaAXKRqMGwaobTbEm9SHZrWxZyojngOwwr36Ii3norAEv4ycAXYGda+mOqdER7oaJst768go80SaTPBIv6jQ2/id44lmmTnniPsA856DKIn1sW+fT5mej+B9rokwVDczWrYRNq2L0kXrQHPfiIcfMn5blkQijeBR40YXC6pwIFKbRaNIkBVxYYYr3NbWzHpr8db1R+mDRn4afaRtkYxDYKxwm5eeMN4NqnqTWqOcrk4iSK3etP+yBF94Z18NsiuX70RoAilrNlghfrWSpLixZS7oBSGe5jVtEFE06Zlr/j4USDUa04bXbYiALt5uwZMTdA9p4MUPfc2Il1I3xhjCWjJ0lSDIElEJTc5A3Iun94k4mLFlszZNzjkzDk4XSuopzTYHwzmQegnTpqJRh8ET747aO53k8Y6WLIDCphoyW5nEsXpmiz4bOEXSNdL4aw3u92gjzDdQpD6Bj14E95iLjyBQ8U20ONUVRsaz+8QQvCqt9uaALs/dbuORcp6IFtEjaSbPOQ6vvuQovzI4hqerNyDRAIHB5pbukkOWNiuklse6gkynHErwngbcd6CPdTLou3cUySD06Jr1aGrPvgGpeb9SF48u5MBxAygojCJJr1EC6VGDFLEDjVuhAM5aupYpGfRvashZGPt7WTUPV1urEk8wmWEy/vyE8y1OBAf2VwzVWY34+c60jxPV8hapuSiyvCNDaaXot+WoEbNNxy2K+QZF72aWSevUNmOmad3K2pJaOyjAVGgBo0at4EAazUupkqgtrlBXl+vL7JehiFi3XMYWdTQ8TRYqfxDJk21WtWU9LHAc6na3N1de/yTxruCHMoYZjBZD8UyS14qdFphiyD9lH5aSJLSaIcqJdUKnE3DLuiGSHa1opQMQ/b7bUgclne8iTjiDXcdi2OOqxtMpk8nM+bwobB+RENRtWdqAxgR8N6F0K/E6vSaZAROpvBfBllJ6D6Ezprowm2X8IBoxCN/TDeWL4SjM6hcBn/MnIzRM8qfgCGE05DFkQpR1Jy/7pCdRGXD48BabJM4U2ZLZ50p2o/LsbDCtaArU+A54opNIfLUA1pdsrM1EPUnSYa6YRpPPCQ3AWxpKHXs8qsM85zFKekb9NLOysD8aoCaRxWDx1goNoFwNMNnKS5M2IEOTM14fKFCYPFV2orMB8cfzupE1HV8vUV2/e6gwUtl54ykR1oDkN/bsC4lbBTZUYBUx0LkFgQN1bUxQolqMBja0ylwwEESWzXRkJuCH7GyC+6gEeujQ5F4qEIlQ6/SuIlx67AF9b45q8I42QZN00QNKtje91oaeCqI8lJ7dm6Srd3sy0KOikiXYOQL5Q14EOSZNEQF1L4J38gM2ZTZyKFvV3OWW+jKm10aA4sPQ5cH6UtbxJO6p8HUcCTnpbk7wm86RaTaT44PluDPXmpCGShHvwOaJwy+cUjq5WGXVqacOUJ6iV710ZfH18bkPsxqrjArGTL4kCt+UJ7AHDzoWXWmjl1v5F09RKPaWuIqeot6hMOvvpTE2r8T0n2lVyYUBmjy1fh/3kUfKoh892c+q03lGhsSsg51rpXJSQlDMjmpIvNG7JMzoYB6X8L43RYujKg1TqvQnDGqEJhTUMwV1mNJUmzi0fAtA4evhChHIsTn8qFAmF6U4DfF4whN9zUW1ePluK0cugSlk89+yTUWgTKyAHvFIywLplBS5hMXBck6LQKwyZdNE2hq1aW89ALEasZS56WbAyOc7LSiBY5nFvR2onXyb0JsHhkNItp1d5e2mTA2au3Qs9Ddx/lPHJlGUHiqU+nbRZvd9KlS6v6DSAL8aoVGrLLVl+PlsJaQIi6tK2G+viC4o4zuJRkx6NAToKWEe86Yu6rKZT60ryhczlc/kmwcYv5zNIT2t6RNtLwy2Ia5EQHRhzMLGaLARfcAJNmzI6NH+Vu5oT4EDt/NHyasLspA759kIOL1qG4+HiQQUCRLy4P96mVnxIXC31Z58Ha+spIzLGyQ/CdioHr5SzagDm7oWRnie9tbWUzrK8RH3Kz7nzpz1Rkm9xj6X+a3eIN6zI58ZfJT/W5s2S1UxdDb+3cLkBboIl0Etn6QcCFFkUvYVzuig1y6GIf0nZ0yFLgeWZATYsX4Mbz5/tKGO9b6LxIHoMameSWDcdk1tS8xrjcafniSaS8cMqJLntUWoo7amAIl7P68Jerpm42RuQBUVGmWmYuoCutaxNoVLsVhvSG3cmbV3BmAb0xoI285gHHYf4fDZn3nlCmc/SWUkgTVoPU6AS4KEUvwS+G7R4/3ATMrkCkDJTwdEWI6PlVQvsfAeJ5KxVJoH14E5KSHkYBXM73JrOznuWbVw1YDnJRJAyPUwT6dGMkBNwsxiBJ36I8pxvTtCAFSha05N2ODQnSvLcAb+P6U34LgHX8z0FkBwtnCoazbyOvEqha2+YYgZAxi35KgAUJLHuWAL3BPwZaeAF8ARuo5LkDe3oV+Q5+UGKzqNmQAGd9Fcv6TLRlgpGR5COjQC9yXsBs75W49T67DIYPbKlDnXZ5bvALQ3G1DWl2lyuNeVcBuL8F4PWnHFG1NKnNSJZopJgf8OsJgNoBqerhUA1x/flcvD1z/qRnPAZlvXuLtONx0mPEPFGT71PukGKwPWipLeAihddJN+NmKNkdMmoEA7ysoU3qX8rztS6Ne9kz2yNiixD9TEXP7EtQzigvyk/BOv181S9GreN6HTUqWEjDXSWoHynHtk6F+kElCmVUew053o1dxGrNcQ2HE39UgCAZDF1vK07iVp44fxylNM4DMO2HKsJCW1Ztz1MhTZ58Fx7z3yVTFjJTvLR27/h+RZAOk1o91qd0hEyxYB6YowRsmHWR25zix+eO9Kb6i+ZHcFzY0K3E2iODUXcCrU7zyIsSEhaoljUuEYFS2/VvBlCHcGYqiJhsmUAGyOaLQwta1uL8w4QBOcUBKaB1JjagMouXiHM4gaFh4wd7T6OH0pjAmtwTPLPCYoEEV8YtaT9FjBlPZZGiPVXKgHaZwQJXzo6g84EPEOcvT1THyi0VtcjhZg9FwZoc4ixjhm/Tx4Q1OfehKPEOpWlparUVOTNDHXDkf+zYqXoFvqQuSRjRqDRjrIsIV/0GgSsYU3prW51d8w5dRQq98xLydz0Uhzr/7MASAKFNwoQf1Q3zvmypGBJI0UvrqSpnNonTn+D6RqJVK+lUm6pVswEdXrCwTKWN3551jXrJV221Pw1JIfQPyh3OSem+tnaY5AhUJo/CCN5W5THuSYsMhv5yQRfpxGoZ5KelCvM5tLkh0xnTgkxFr5SDZB6Rq4W/dr8NN96JtOjHVUoCPV+kLyHL5YhlmRGwvs9DTpsjCf713itbiF2WN5v+p0HmMEdOha9W06mqB2wfIPq5JhocoUI6lRya1tq++6ZYGt+x8wmeQjAO/YuMs6cTa0B6OS2eoaZehhqe5/DzPO1ukFgHay2GNYKevgAT347Gkal3JocQ+K9i09LsNSwx3O+KjGPsniVMhpybkIMFlCMR1weJrV4g7PkNJuPhzEbSnlutgR9cvkL5dArI6qch4SwzT3nOIpRjMAqXW16aG7JSwveqivBrEJ4PYQ6H4JXJzZRMd09atb0aBt4VppwpqwNfU66h2c2CuQN8MzZR30rzi6Qt5QLF5AlZxwMdFy0FFguBr8iVCldKs5cmOJt73wtG2gGgl6gZarJc75WgiYpdMDVbUtBSFPV0kbFjwS+ZEIZbasmNIy2bYdzsaQVT20rB6qGLmV3LzySvCwg0IzN9Go+gdRPYN7HZynGcNmuUfziPXLwMsW4s8nGDYYNwMDuA+fZgTJl1hw2MloqpFd/jDXgNTDTWrBQp0s2pdRnXHxFubHjqjIUnY4aIJ2t0QlpF3zQA+hIXPykE4Gut3k7+45UWy1ytGAiNYFGic9sgtaBlYaRjFoSAO0xCjJyfn5xMR2/kLzq/us6x6yTOarxTeuJ63sWpM8/eOrlzC00S0xIo7PDcLMDe+pIyMKAY6uxrNjmqLKVjXhHSvCWsM70+cWTZZ0oz/W5rrSi+5I6zwBAAQFKV+rAqGR4P3uDdNHF9cChX4mnYdhSy1Rfnk7UbzLSnT8BRHOI87PgXY/cQ1kq0KRMM+uKi2fEJGYXriTeci1S5tigl/0cam4vES+DTEwCKjhJWZ/2DhpX0ZHkoWSi7Jx+rIx4LwOXYiS1DHLwrK2qj9VEHgXC1N90rBh05wtCHGtwDVy+DljMtiaEbfB2ElMZ9yC+zoLuSg1osX3R/O9MFzRxpIhCgfBWYtBFYa75+sqeognFDKZVspq/53OaQsDQGpcM8JkNQFY9Drk2pgwrInHIg7swZIyGddJyEySut8AugAl6TWUTawoTaWeRCbAEU9Z0SXafTP8RoHyhOfrvnccU7tGVkXx3zYGZhyAxPfIVCAjQFEaeASEgSpThNq8VEz3pV2sQjlmBLOlvJLEbzr7h+rADw/Dq7QEPbweuDxPv2U64csfjc8xhG11+k4YigglwnbKU8uHtJTvMZHB9Wr2Zzkpw8LDA0C/KC4FnKKSgFYVkvbZhlzeP5KUOQOJWPwlI6rEbumPoCZSqjUt/GT1ZRrZetCbvndojJGjyD9R57a65Sq5mlTyWsxwQ99HQuPjtDSfqaToMit8v82cWhABe84+30dFA5lWU1S53lIN0Ts97sPDewbHD8Ipf4fE+8NRx4qWrE4ADbk+GzW8vZBfSBW845Z6RrBhsRWv2nDgx4h1+Znat6/XRWGSU16hEmVnFpjptqSOpxTm25yS2sWQlF6Lrt/ocpCBg+VDzp9PrTc8MdYYDZYAZORCvc+xlL3vZIGGW6FyvA2ZmYPHlZaujPkjsj1VNRIBA0fXIzljZYumGe7wbgHYSDmOQ1KL0uMeo3LnGWoGLfnvcT30kfpT46t90BEibuoY2b10ss7yiQsqheOHEDBN9DlwIn+gVcjUE5njFMHUPjwHfdyl40+A2Bhca93vmzsRUAp9HfeVSOePhNOSsrw4pvUQoo/Slpso6FhiNlcAu9coOLMxQpFqpubDsQzEQuS0vL6io3wL891wft1vmoxgd9BlIcczqWqTKehgkGXQ6JuR163vwpAVT3DzYQ1kBc75jRc/p2+ZAYG786QClQ116tmdZSQPxbkjymX7pgXmkn92Y3aC3Wp+lenVOaezdDri66/jrX34Bf/LT9/ATrwy8+chx7+D41S+c8Ns//AD/7Psf4Ppqw+10HCw7iHnMKolAGpbNAc9QaPZRYFlRQ+MWQUQYaW3OkQmQzZwpt+l49Bo7UUBUd2j725JZakbbc9IFDmUUUiQan1JraJQWI+5NNjyhweRsLWlSEc+bnHJyyhWIhqQRn29ArVu2upxL0UM4wgVnwxMzAyaSxbpHXyelp10nsATYEX87N1xf7Xh4a/hPPvMC/qvPPY2ffzjwwAeeuTvwa168xQ9++G1893sfwE9xxMeGAlUPqEiS+DJtynXpSjNz+WufsgIOOs0ZOYpqVptigtSmxq6ueqLh7sCYYFAlMWjnbyynJhI7ssHG81nD6bShotnWKyLzvaRI6m+99KxFwmpI5XkmbKxE4aYmAD6LQpbjNT3j+GYjn7esCr4o6ChnZADcTbSYsJTr2nefy6PtMoWX4k93lDs0jsygx3JyHtnXUCzJ82ysGLXs989/U1c0z5xTVxulhXxZkMY5EMyM6XRFNNAy5CXJRSqQKwlMSWgTckMcpwoCHYnlZRjURNOUooGcVFdRTRKFgkgD7UVnH9ns7oCN8oAodAP5+ZzpsJn2bvMlG/w+FK1Hn6mV3KTc/6CeQwIonabGt7QzZrA5JbgqR+V8SEdlWjQHiUT8vfRPQB65PBXWoBON4vfkiEoQySt1uqKN6Z2lFbC6vgbPcbecY5yapeM8KjtEw9EcHAos3JduepkUq3WrVJ5zmAbstuF6OP4PP/Ve/MjPvQDfd2CegNMO3AKfvn8Hf+Hzz+GPf+CE/+jbX8U3v+uE0+2GMW8jLe8QKMmGi/x8NrNJtWSAkQB/R6sRr9cHfzNl691xcngeIsNF1eFEFSnSaGnUBEtLx0Gs8PZcGYa8notS1JS/0mluMuOMNlO0mCL13RIESzdEk354jhxiL9DnR7nubuzLWXCg8ZtGpqMxO8GJKSHWZJjV+Lye/DKOnbRt2QA3wy2OuPPUGT/z6j380N9/H378y1eAn4FtAtvAK/OATz9+Cv/lF57D7/iar+KPf8tXcMfPmDP6UhYDpbk23eZkrC1Z67QGfeSflQE01BG8Inj8Z7R7yzhwOg0vaFR7VstQwVJCO51tLHOve4T1rOujnj9U8uBihgyQPmMjaopb4WYTdNScEn2xUNaseN5km84Iy0mSQ3kpbQk8XTU/rW2P5EtpIZ+hpec99uTl7QPaJ+7CcFgeVEfhX5zWzBwwUBb/CoaxiLkjDlSCS59CB8NjLHhmlrywV7viLHuEnEwGTU2yUYCNBbTiL1oXcbEUwKwMZItSZVzaCWL1NOQ2CRr/NYWv2g09nAQQvW53iUYpnx11AjwIeK4Z5dqpac1DRQr3vFhfL1XwHGiSZm1K5BjJ6SnZ6ChQaR5n6cNLftVV/KRRqRU0+fOkN73pfk90yMHQPOMFM62wu9PPUOApUOGNXE9fU35oFjSHKzVO3nFsRjEE5s5HgI6ZFfkJXg7Mabg+7Pg3furd+EM/+y4c7ziu7hi2w8B2HDhcDRyvHXfuAX/7rWfxnf/dh/Eff+ppHK8ntsMRJ2zrITtW43Ipw4rfRfE8fIXS6yUvrLEp1awGkSrD9JFAWWRGyBsPeKcHRC3YLF4kH9tZDskujW+odCWJt9Q6eadOOPHG8/wuj42lXHFLU/N1JWOLzWb6VfxdDV5td6bMu+Ys9RWQFygyKpMdoCxbra2MSDNUHtdwyNM0bDZx5zjxJz/9Ir7zb34EP/7gGVw/CxzvDWzHDds2cIDjGre4Pkz86V98Ab/rJ16CH64xcaBaBb2o/pLx5G8/+EX/LiAjbLDXQZjTasGiXfJ3yZYGUK2yCAObtj0P5NEJiMThxH7uWpHOSuRNNXOWA8qZrUd7bvljAxz7QtxaU3QTak96oT/HAOve0rTsAzOUY8TrKRCEqCbb8OX66TMPqyNNrRpFxSMBbgWpdA9ysd6u645PXWslo4n7DDLpaJRitNR+cySiwXgWDZC2rcEtSwvLFmENXTrs+sKFmWX44r6xNhgVQfUweG3tcEdJOAAbGGPE6yLTgNJIaFtdExIaNmQmoWpWOe/MO/NQ1SnvMQTTRxGs5J4G1gXWTiItjDQBm0ClVtJAxpVtgMAqKWGQM9I1YD3zv2gnw39xYINqtIEMRbcu5GJAAQQZzBLF1MtB6KS4lglUzXTKO7bsM3OY8zfIa1aUwXXmVKzNwwkEpktFPwJymrJShiZivIGNaHI4GYmkE+QOmM96LwHF2T0B13B1GPirLz+Hf/sXXsD19Rm7A2fuphgDcwycD0fcHq5wdbXj9XHA7/of343f+rdewqceH3F1teHkx2oEdPpILiXT1DPaDmnsfEqaq3CfVBmFbeUA00g71F0tGaJuxBj14pc0dHQOSzBDrHbXti7xRdFZ8oHqSlDpgIoGcDVN7SToP0tE2793KJNEweYOgk6n3lG+ANcCnC0ixeKftTV0p18WZAVNvaW0tjH3UsOE4+Qbrg/Ap+9f45/5mx/ED/3d9+JVHHF97TiNI/btgLltcIvdM6ez43y74+71GT/6hefxX3z2KVyNHae95mCgoaznh0PucDpYtFWcrZscBMvgqcoEHKcnvcm3+sCafKoWgQokRiOktvqK2by1yaegoBxy+htV/iqJ5vY1lYw4v2YDhI9efFywoSCsXVtY2RG7Smd1MQ+ZWu1VWwNYru2H8gS96fhA1/ZyuFevmMZtZcwERuIyabRsL9SYVs/SIjNKF11blA7idT4/PYAVe/ta43upvbWSoZFjprWM2j8d7qMObSi+CcB6bSOwqp2aRe9Ik3JNVs2FKbASIhlVlJfjqNrHGG2RnHjdF6BXSgNAjSXeVhDK0zMaJqLpYCGmc7u067kJTIzSegoCuYnDoUMtapxyZkJJg+mmaK3S+AXH5e3xVqY85d22//lFxEUjmiiXFq1AsOYM0AmjI8HooW9DCwcwn50K6QT4xu7VqYlxZqO5RFaKQr6ayiOSH2cDHdGtgFUCBADm+OOfeRfgA9gn/HYC56h5uA1gbLAR26HOE9j2Hdd3N/y5L78L/7Mf+zD+9OeexfXBcbCB20nHMflttQ7nbhUAtuyCqUhSMkGgJe1hchDF5Ik0Bsz4FK+F6XK4XHS1eipksA1CZp9ehlkstMYPxImMeS2P2yZA6rx0LzkuVUnQa7wzDDnvfEYBYi5rtllQfjgo6dJ/UlYqkKCuWXvOk3pG+ulBLGgzWk0dcgPOvuHqMHBnc/ypT78b3/HXP4w//9k7OBx3jHnGaU9jshls2+AjDytLXdpz6D/+80/h5szWuuIbyyflZF1iJE1r8kY0Ltr7xbrk8HQD1+SEhq5oZMFbNSM2QyoWMSOLmk+OxRMlAZdIa+tr2xqMJnOF1g2QEpzKZHnJSpN7XtqIAb1DZJXkuEX0MVpF8MAdKlXBhC3ZBwHs4qEM6DXcIM7m+Ooti3kbaZf/M+lpm5scdspr8jUxY8LLhgGyQ6Q5Op5WbQbilGHxjhn4MqTi7w1SQTtXBbRmn7jvkPzgq4CbZdLDiXo9NUIHVHbGAO5dV1qup/4AERU2WBlBQw5FPaXX9YBR791tcNz+K36UJ7YAhHm6xSZhc7PsBl21b9mudkGNAP32XTo7ejbnQ2CmsJBpvqarmuO3Podk8V4mQVM0K+VB1btoPWczIksnKMjTem5vUFf9fq5UviQJsd/dBRAWaYUEH94/KlDh51bqfbFq3Vc9EAFmmwGvPDD8dy8PAGfspwnb9xL4YfDNYp+LBQHmPnE6A1dXE1/er/Av/Ph78D1/53345BvXuHOYsBlbv5id7VOaM42nNePMlCkcy1noHhkKikfQJkGKCCx6FO9FS9G0KbKw0/Qdwal4F991u2oSnJyrYXlWeScle5rvIlsXPMr1yYB0A+TkdHKONMvnlXqF7E9wY07KNh/TRRrlbGllZvXWvgEm04p5juXY07MD7huujxM/8/YdfM/f+xr8zp98D7503nB1x7FPx9wdOO8Vyen89NpKte+OcXuLn3r9/0fXnwftvmVnYdiz9u/9vu/cc4fu26NaPUlCEwgo04aikCKwCZOdEILKFKaCXY5xguMkJHH+oAyucoVyTFweyk5VSJwJEiUkECZjBkfGQmaUQAIM6gYBLRp1S327b6uHe88953zDu1f+2Ot51rPf0/mkvuf73vf323vtNTxr2NOBn3pn4DpmBSrEFbKPiQcr/oWbFjxrbJwWpRQ5lw3A13kEsJI05iuObWgZbfq79dnBmOondjY8ZT8CstNN7OW45Kf4tbCEdBugEKs66m/sMAwPGR4b4it0XDYo0WSgyUFm82vFK02Hz/OTwlwGC14hqPVYwPJhYkIyjhPgKWmi3ilQNeaXQ+8FwSmekJ9quN5t0ZPC8NawC47reMAwDqHfUqSo0mlV5cHItiPPilJsBSJ7FQjXYNgVwuZto5/XQjBX9qDD6XdRDonC1jxwRcLNyjU/ItG114GuGI4QOBHsNKeTIowa2VP/KLCJiqDKEILCpJDtZ8QChoNTEz3KXVJpel0CWDrURg/2h52XW4RPwQ0aC8ByEG1LhX1FoCv7557QLKDW5Sp+fjrY/2jASFZZauuWb0HK6ksRA0R/j6+Vrv1JOaMCx9VEl9aXLnogRVBbGrVWzCfeeH7ga28/AHf3yHOV5Ea1M8IWJ6adApd4OAPHvMf16Yw/+dmX8b0/+I34XT/+Xnx5rpLw+XzgTDAg9h+l5wIOGnrROoE+ezRqO1NIn+XcOK7RMpC6GMqrl0AdiNI6ppXm5hBz/+MivijwKttlLJfKzMwksHYqFMVNGO0fhv71ue0OVhKwVJPOpkFR+lw6nMl3NgOBqjhmI0EgVrajia/2C+YjspxxItZi0RPwfA78nr/7QXzPD30Yf/KNV3B6lDhdDTyMUQFEA61YSnsbtRp+JuJ8xtO7iS/fRVWQ5XJ6LMqsKTMDZUBOX7AdbdftC/lWeXxdxbzrBHUg3B6BxtDoapOqQNURs/pOPlL6HUM5IpjAKdHbmL3sfU6sdWi2RjQGnaQE07o6ZycE00JXrzAabPO/5x40mFX3Opduhq5Tc+jGGtd83T2Dnk4NrEWWh7DKkknyWr9X41tCXAgQA1USLHQlIW40jYtsOajrormrRnIK/CvsWdpMrr7dHpPP1rgHbYpMJIAtc6vAwBzRtoAneYJRK0BHYzubm29C/CUeIeBEX6uYRkfKgdCZtBDXRUHrt3P9vtommeNiv1uT4eJbPyp1kScC+9l+zMbA946Egqgdyc1B6uWQMXJYvUJ6N97OlLEtlmrlDpt75T/8O6T1vF87KxXhdiGtbUAiNQWSfQ8A2uGxzumVA/369RxPfTwz1bdu1Mrmra+x0LjpALMAUW4KZoDAo2PiNHLbew+szF9Os8a3dHeY6gUeMHBzA7wzBn7vJ9+HX/ZffRS//3OvY1wFTqcT7vMk0sbogtECDBt2OXxUFakzIBppMYb77YlISaeGzbY6qwuNXw5JmGFTbnOZMkqszckSs/UhXcmLZ2RvZs8T0BYwoO3T3mEzDbwmi8D22bDoIEwvth8FAo0BymYWiimmCfR+7K9nzDOAhzFwdQPcnBL/7595D77nL3wM/9aPvxdfjRNuriZmDsxxYGW9Q+NrbaKDKK88jgXQE7hG4pXTNOd0QQPxy5lVGWaoErQ+Y2DFoJkODQib1mT7Yd2sdhI9h61A2v/LYCNs2tT0QCSjsXGRlvDr7xZ5QzLxHU9ABb4051ICX8jsvelT4xdHKWdu0x3bv+ST+Bwv6hKwpleN/2vROJOmNSiiIAP+paLZomP5tDrf/IC2mZfBqHxQ9q/D6lq+vJq9g7dV7mnnflEPza/zmTBybn6tv0y1v1XVdGjXUtqhE7w4IKDnQdG+S1m2Z6SVJa3yw9yBh46cfxDQ6ykKWM3JiD1KKUVJKJpaBs9eeHpOP69YoXpSTElEKroiaoHhVgKl8pnxqy3SjW19gN7zQ5J2UfQnefE3/bBormeKF7OUL8CBTMuMmx86/IeGIQ2ddkZ+ADMQc0erJacAMwU5jDICySd7bDoAA53lCvAli2h66BE4nkQpvMFapx+tX+Y0mSmyTnCeiW98fI+PvzsRedJJfWsKJ8BImgC5Ljpa7XsgcjcO4Bh49Cjw6ecv41/+Gx/Gr/vhj+AHvvQKbq4Sx9WB+zzwYOcsbCAgsKDBG2DVoGdS5/rY4N4e5U53vWiFvWV31D6zS9dJ6rSANtxG3DmHdFCiYf/ch8zFe+WU5pzwjDZ65KaD7p64nqD1oIjv2L+Om92CTK6X4JHXpfd0ysr+warO4rXsMSEbnAk84ISrq8DNdeLPf/k9+G/99W/Gb/mxD+HvPL3B9aMHBAJ3moqpzM+zxw1Rq1pzHIhj1GLawIdenvjQ44mHKcWAiXFvi/obzXvdFYBKCkbLNBFrGql4SQyj1QQ1oGSF5Cp8oVnrp4ZVFa2ItmN4Hx2ICFvK8LjtbtSunt5K1vbbi6M5QONF9L9CEq5t0qK1qgQ7/dJW/rowIQoP1XRYv8y83d+IEeRv+TLhU+OfE6wggQGJAuIGbp24WYOjs+UaqK76JL9Yn5c9s/KhvN/HQX/gdCeHHtuYlVzY2HJONBImDRPk9mk7DKeMdt/7XIYp6eVanLeWELbwybNpwpCxWvQSS9nTOk0HNupVsPwftjijgZDaTeoU0bL0lOQS58uNuRFiILPChFUzpLjZvdYYSVM/OKtcbIKYNcYqh/nxCGm6wPVNmwBIO/oZKpqcApf0Oo2k2Z7nMyPoRMu4a+yTAE7drG2YEdk3IaL/RfCsHHNysXcnc80+rVHAQKc8Uyd+7fyuts/u2Mg06GaxBPCAwMuPEr/xo2/j73zxBsfVgfNxWu/IK5lOYUqOve++FrVF4HYcOMXEcST+3Juv4AffeIR/9gOP8T/7tnfwqz70NjAH7h4CB+Y6zGdS/LWxuVRi8bbPd0D2VkchuRYQiwNN6wg7/KW4Sd5U6XtbosLTH6uvEAg0U6kmslFEVxCog7OmuGpwOlhFzoA8nSSG0CBnsp5PdaZlCqa/QNGrgGo9mJFaZ8Lt44ueruatDI0gWw+QuSz148D1aRneD775Gv6jn3wv/uznX8bDCFzdTGAG7nEFGm0eTftK3mjbxmRLfPIYuELgLq7wz3z8Lbx+c8b9feAEkytRqQDcw6SuRRsQuI8L8rAYR6ykjWo9VT1LPFUmUfwsDDVAkDA1suon0H0S17W4uF0HlKF78C4cCGXaOr3RnS/7mOaHL/AvzY5UCcBYASN3UdTzZ7W9gscYUeu4qXRFgd2WyLpGYuByq5/aygSnW1rs0TKQM13vB6diWuwoc7rY6RStv+J3cUcQIOd3oRaz/CBkx/uUduuvG2ugbFqy3eUCJEaXewo5qWisOQdXtHSz1GMlbcRZy+KYhYySMhUIdEQuJDUdYoiMJhgVVocF2NuWoTSGNhYiY9gRj60IXHjXwJViHjNiMY8OjGpsfKAQUnyLZkxCmehyAvU7I3YqVoEj91sn9Hpn0kEVNGfRcgeVnlnXVppzg5fY27hZmuoAA5vj0exFKdKGjY5rk0ZR9AHguoGobaKBmmaJbt+BT/zj16SjVqtrdfRcUzvn+8C/9u1v4aMfeMDzuMbV9YF5HMpW9BMJVYtgQUkURTVPlljTAlenidN14E994XX8ur/wQfyGv/hB/Lk3X8bpAI6rAw/zwJn2ZzLJzDW3X9pBh6KFngUga3lCSPdMkxtEstmkbNr43bbs0zTWhtmhhFW/Tpbeo0u9HRSrQwMh06UZuxMTBhTQxU4bafDKKLNKXeyn7A0KRoaqGHQy1M7s2D4D55k4Z+KME06nwPWR+PNfeg2/4a9+FL/mv/pG/Gc/8xi4Am6uEmcMnMtR9TqawpYxqsSfYhXX9AE1FTMCx/XAfZ7wrtcm/rXvfBt5hoLvpV4DOaNXzG+lXcO8gAKEsO82rAEA3oNCHnBNDkzFSaPDNGBbNaNP60vY2gzyn7ghKokolRCaXpWOTAYCFuVta37oIEUMcaTHGXIi1BMnvunPmsLsPJA8jdaZjKWbYtslk9wxsP9EaIs2MdSrBwZQ9XJNmCpYXbZnNlF9Kem9aCLqndDHdOc9pae/lgNtxrjAw+yyetycf+md75AT5EqBgts3lyC0+I7dlJIiTQnAOQcvBq42fGW+s2M9vTQwoo5a5EliWQAQQasWEwRuBRhhQqTyePmaV3EmoJKmzwulUebbqxA9L94Yy+dmTdEwXgwBJJnufkC/yiA69oztCXshW5mkEAXqWgVqK8d7O0lRpAy72woavf3IAKVQq3SVpUw2NVSO1qhOK0VXY1zlv/6mM+g5vSi7oIsj7Rvg0Ql12i5MiDBeMWhjljEnzjPwwZeA7/9vvIn3PLrF7QxcX9kUSYEdowbNr0YRNwZQJd12hoEHBO5x4PpmYlwP/Mk3Xsev/Qsfxq//4Y/hP3vjVWQAV9cAxoFzDPCIUAFnFA+UcbWjJNbQRycHOmzMxbdp83vrMBM6QzobiqIrY5mh2SjqP8/6p/NdKjC0XQ3U0hL8li1lO8I+7c9tvG1gkKgRcvoNuOxnMWDOWmxFPpW+uvMhw0pqej8CmDlwP4ERB66vlyz/8y++B7/hr38TfvVf/Aj+5M88Rlwlrq8TeQw8xCEZq+AatAf5LPEyYZWr6vt0BB5y4PFLZ/w/vveL+M7Hz/FQyNZb42r3ksblZeC2k4VvfVjEjpeAIRBaTPVf+qzph5ClnLGCe2E7X2VyYJt6yu4zoQWInYCQDilafb/60smXyalXm8+HjWlzwobCkfq6Fx1vbqANhRgN1NRB2CCaieLT3KvKcsbCs6h8IwBVSFdVyW9mXesrLqfefHzdV3+eRaaUor5gtbtoqj56BT+a+Vn8KQwbOkjKGJyQ/GUu9BGwG3T5fTT9pSnrKOC9pshAIBX9cfta124WoZer4nubW4P3LMBB1I3oue5GFkDOdYELXQ3LJe1ojnJUPYiRCyB5wUlOggfLmiQCvTef9leCsA7bcRF5Nfa9wtDTXe6hoiryCV3tW8AS1T/oApOxQymv8bOziP67nTp5DtQtn0TBdaMdAmEbKScqg5qrtGrrqRTQyTGx3QC4TWkiNPfEuWtdP1wkR031sF2S2waSHFBnr/67hOG/VgcMRsv4HcR0BSsSIyfubgd+xQcmfujXfAH/8g+/Hz/6pVdwdQIeclQ7bD0VkLDaITwIdLCjLxIPADAC1zdrnH/mi4/xZ954hO95zyv4Fz72Nn7jh5/jA4/vgLuxDoPJuW46o5eJRWdPqy0CeOoaTUqZs9zu4lWrrbygDJonJOqkxOxpODnLbEcq/YPJLVPXIHMXTYxY5XE7SGdbXGWydh1t/W4nkFLkDbY86ZMs+pAg01OggqukKRc+Hrg+zsBI/PSzG/yxz70ff/Dzr+FHvnKDzMBxc49rAPdxtW5xS6wpg/IEwrfqD3J8xQ8G29RZAFfzAbdPrvHtH3oHv/+X/jS++6XneHhn4CrMgbpOl902QNcYCPYEaz6fnOpoXRcolBz4RfvEuu2UpG5cFrdNDygLA74ZbExjTfKslI5tC7+c9k3W1m10/51wlLx9QbNVHvTppuvrj6SOSndmvyLyyeujxh3aHsppv4awxOQ6lHLyQxfnRNsRfUPRIpJ4aVGW7qp8UTwjzgRdAGkbm92DrjWrsl34EVy8XmJTMll6oEOlNkk348P4t+FoZJMSwEmvDWzKul7kYMIyuS6d+0pk3x7YzqWYTqdTK5pnZf8RsVbVzt4BEDWSRJXpqDSVinSAZP3CeKXyUGqQu2bOFb3aWGb6s+1get7FlKdWfSrQiFjbALntS7aVm+JoGb0MpspExZqeWuUUScnhItvinQW6yCYWTaub1eaLlWBR3EqT1nYxnZgjN1SBEjNK5wub8J9QVF19BsA7HjaAlDhYRaEM2ylGWJtZQQ6ZpYWMiatj4u5Z4he8fI//4le9id/2l+/xxz798todkBNzrHJ71imI7MCNrw0pRUNSRhF4KJ5eX5+BTPzlt17FX/6xx/h3/94tvu8jT/BbPvwU/+S7ngMROM8D53nGclPVkC0MFE6U3sVYZThm5zLU4p/sKk2KrIbtSGkgGDW2VHUtTKQMcnlGPyx49AuHFv/brQg+6ayUmpYu0+SprZngtlrzc6Ad0LZ4H41kLDktWs6V2Y4YOJ3ugZn44a++gv/XZ1/FH/uZV/C5+yvg0QlXV4kxJ+7nwD1oF0P61rKVEcgRTeIcoKCXh2dcPZxxe3/g137rO/j93/sGPpS3uHuWvEhl/3EflUCzrLF0AbiY2t5TAWtq7VRaw6sqQbmsQH9fc5pc6SJ5EpLouHUsL7vtrKQu+SodsLltYUs5pVSUBmEG7Xs7nZgEVETRdtWVYGccEVk+QISTij6w4NBNkJW1q3QGcA0LpxuCug5BzeqpaGam3NbHtWNRu4ncX0i6lhgP8HbTcBkFwHMX20rbl9D04nBUbZnx+cCwRQW0+4mcPMGQiVpjRLM2JJ8FRYt+PnHiNKsyVjpDiiWaCFcYOsA1YCFL/X7UAOhgDNHdy5NLu6YVwaVgxeReqMPiBtWc7U0BkMA9ohSE2uSqtsbS50zv4CY5s53KZiXEcohYfkYtk2ft7ELbSIJWaGC5xtSsocI2OxoQO5K3z+fqY3Rz9XXyOL0y5t0JbY7OlGeBkyGEjIR6MVYQchjdCXB7DQ0ry2BjUBZtPktv1stzrm2HGtPoEx2ZTS6drZVxljVFAjgnTvEcd0+v8e7rM/7Id/8MfvfN6/i9f/NVRE5c3wzcnw5Edqm/mb0ayQll0eFfwXQmq6oQwNUJOEbgH90/wn/wEzf4fT/5Xvw3P3iHf/4jT/FPv+cJvvH6HQAHzufAXNsPNJWXNOSEVn3nCzK+0D20s5T90S42Y2+w3xwRdqcUBVqtMYH9x5TTX6ZzKnFEALpRyYIGMsyTojSZE925tkWBJcE2J84ZyBwYGLh6tOT0+Wc3+M8/9178oc+9gh968wq3DwHcANePgDyAmQwWZuHE6P5EFvkmbq3f5ECmFmJe5Rn3zx9we078z3/RE/y7n/gyru/ucfcAXM1zZ2GUmWNnoEqV1fEkvi7GUZ5rwbBVJEifrR3JYMDggXRgMJExpzZcljUcM3SUT6qydSA5C2HCC8TSUSZqIL20xfbyHYjWeJq54HRpujIWc6i1DbWO78UGZsFcHxXWxmajRc9I+QlFlSVXVR6DOpCtD3jxc8f/TCp7fdjZCSJ4KwgDnM2Vg7cp7tZYf1k2EPZfVDurGjDQCz/bgrqV4mOVRtsvL0ymN9l2Atn4Tu3cmo8iynFhD2tUMux3GHEl1nxrEPX39+t3LQbBGYzgGBdN8qz6I2Nd0TmKZn4xwFa+qoRvdyI78Ktc6XiX0LvOZo292pwGyOfmgCkK5eOOt5ROOwPKSTI6nskvzCiyHQOjzGxei+zaRtQ1z/YX5L2PtadasrpcQcKqvCyaUqdtdKaetURdQUI1yNXOqlAU0UvMZjhz9sr1gG5iRDmALaUJt8MeL4OJAFZkfJ84zVs85MC8Tfw7v/BN/OJ3P8W//sPvwj9++hKuT4lzGRDBc+GKVXmoa2SS6W0WINJZnTPxgFX5OW6AWwT+1Bsv40/99GN89PF78E+9/wn+O+9/C9/zvmf40MsTeADm/cDDeWUroxagqZLDQbl6M6i2tS4hT0NyOU3lNa/sHRy07ZJg5pRsVoBo3W4Y3fqiYJZ6POgQAjE6q6ONUk4Ld12AXYpMQFN21O0sncoxcIwrXB0PQCY+f3uNH/nZx/jTX3gNP/DGDX7q6QEcgeN0xvUV8DAO3EdoSgpcEU9Z26JMOoNLNq8RDTm3MQJXmLh9OPANL9/j3//Fb+K/99G38fwJcDcCV3Ninj1jY0DD8UWLEF2K1qFbxf+kHZMqYrOphJxhGF/16HqwY7mQzyOm72dLrLlkLthlY7R9s1TNs3PxJsKmLxD2e7PA+YoEcCwHaHCgaVsqBvVzia+dt28DR8Cudy4eRXeadJAImQ2nWBuirC1p6xCeL+caGmwi1+2GxEsfn6azl//y5KbzC5vqc0eMZdOX4Tdtg7uc6BtEElJ+g6InwHsw1f+27Wktzs5CIDkFEJDjFDGmmJ3ho4GJHZCvpnCasQuAiy2YLjOSUTmTA4f8axUFWjn03zh6UdwLTrqYUFcuSsgpbq2+udgEHHN9z+di+8fE1HSKl2Udcxpvks6X/GGDVtpHzeEwuNG+6+5j61aZUpVsta+sgUBZtzsIKi53TI0eJggSethojqkVtZty0nnwzIc0LpmRWcEXvbKfzmooC9ONhR4JUzY0ZoqGusFuwrovgFuXByWePgt838ef4BPfcI/f+Tfegz/8mdfXiV4HVoaYqexqsTc3cnsMDSKcK2RKxUXss7KU6+sHxDnx2fsD3//ZV/H9/+gRvumVO3zv+x7wa9//FN/z+jN806NnKzM5H7grAx7IdUBO6aeMv+QjBxW1DbJsh1u/3HEgOyA25GhZMBurdzRGm/OWzivl21oAp5lUZcjcHJB8LJ0OpxsuzihgsLDM5cD1MRDHPTAmvvj8Bn/tzdfwRz//Mv7Lz1/js09PwPUVcDVxc5O6Bvqh9KQDlvRZs82e8sJBm2dYT82V5R0jgIeJ29vAb/jmJ/j3PvElfNvVO3j6FDgGEA9z+RbxRQDYiupfOW5iOTZORXW522qaBG1iZ2bLyZ7nOFK23++mA75DArPIC5JHrQkRuk1jYhncUo/Wk55mLOweaznX9pMdgEgn9EeX+uk+g/LUc+s7rtjXTwC6TMedu7hfSshDiSbqgCJyPBSc0SZCQRDbMU8bLQH+tx1+VQBySQOz5q2pb7H8g7ZkUgcVCLVopsnYVWeJvOxT1eZKnM6UlftC/leeSv/4gtRE4pToOYINVNUxf5nQ/eeKOqg2oVKgz4tkeZ+w+X+2P90TezZrVQNFQfW51hx4sJHtmFDAsgyHG4kZhzBqbeUWM6obZk7aDcF+GEyIHyWo+v2cAFMlZdVJh9+OhvtV3fkqP1G436AmfsyaJxXqkk+2qTbo8Fk2BBTd+qIA2WOPUf1N0oM+gIglNNv/HTQgxwjnncm1x0kdK/ormp3T2sbYI3sBThvPnF3da/2kM1mVhasDeP4U+Pij5/hDv+JN/JqP3uPf/FsfwBvvBK5vVnm5y2TGC64xqN4z18IgBgy5d9pltRh4yESOwIHEOCbiauAzD4/wmc8d+P7PvIZvePkBv/S9d/hn3vcE3/P6Lb7l5Vs8Pu6Xrs4THjLX4Ciz4pqXWLu/9H/aEUdUFYh2TLArOx1RPLbqVzaI01lsU3dKR9dsZrdbdhHlPKXJZSsSWXUSa+U/270aB+J0BiLxMAf+3jsv4Ye/+jp+8Msv46/+7CN8+smx+HFKXD1OjFPiAQMPMcDz2aWfySpgdrYsO49aY4SiMfa5Wilm4vrhjNvbE971KPG/+mVv4nd8y1cQz8549hy4GgDOWdkU9ZKYwsQpRQ9v1uSJf4QobQEzWyA9gURWNBVZu5qisUfOP5fObcvly+GUv2NnWtPBL86ow6gywXRyZrue7g2ad2YwQlozuZ0X7WewtuZqDQptqMFcyaGwFY0lQh5TcQVqMojs9UXbMcqjMZttE097uYIoQiwd0Sp8ZGHQ0bqvN8bSn+NwMnqhNxITs373bVcrMJ7CsBpIiY9rIsIOFpJ8o6csPBHx8SXXQpWuaIdT2TDfZQxO2r3iF6gKwGVEGHUIibIkOuc0Qgge6a3uPdDoljLzRDF7tp7fPmm5IsYB87p7H+YECFmkhXDQhy4A1ARWJ3iELoFjgUgT0GocMtp2rOs9OmhmFnLEESpxbxXtID6w/LvaGWOdbKdsJmpE5oTloDTiLgciQhkWs+22JjrgBnzXSY02qzyY7txpcEsPJsvQbHdvxPiQJgcqZ/GFYMbXSZsjCZXYPuM03K4rpZtFw1omkMAMXEXifBd4OE/8tm/+Kv7pDzzF7/yx9+GPfPZV4GrtF3/I3Wn5eJL0Gp5p8agqB6aCAQWQDwUGRySO60RcAW+cr/CfvnGN//Rzr+BdNw/4zlfu8U++6zl++btv8U+89hTf/NItrk8E3sDDOfoY5eLQKIeaG78hnWkrh0CiF9UxY2H2Thm1TL3Sky6fwUzd8+3qQxJcz68r3Evx56r4jDhwdUzgtKqCt/OEn7h9CZ/88sv44bdfwl//yiP87S8DX3l+LE97Slw9Wke9POTAg3QECHDj/QVQ0/bJhzK2FdMZzXqmZD6BU5xxf3vG7cPAr/v42/j3ftGX8fNfewd37wCYwCNMzLlK5ziX/URsLKeVlaLAKyjrtwZy2YvDmtkirbbN2JIKdUM3X/xndwaNedG2bE3OFwooosCKzhh0wMT5qhKMbOI6CDO8rKB/mIysm7KTslmfGq8Ezw08Sj7EVQUjMMZVNNLTjCQkpb86m0OPRC1YbieW1n9s29kLmc4TcQyjFTp8ivxLZv6IWq602o/agipMo2MXlFbf2wFv/NXqAjLIxp/FAhO8Gui/HTMXne3b9pMAsVWXSwGzoyX+XY200pPiYkCYUsgW+MJmKnJGq78u/6QJK/fASgPUmcqoyoNWqTZZ5JlylIh1UAdx3P7tubt6kU6+yF9R5ywFaGU7uIqtSmUiJXb99QqKhp+WRQwAOVRZmIE6drSBn/Jn23lO6Y2MGLkW19WWk8Q6IrQP4WkBBFCnri0j0Zy8KZo4XtFM0BGRVxbEyXFiOaC0drgnfTVAtfb3y5giJWZlR0SaGl/vB+zyWmYtKCz6I4ErTDx/B/iW6+f4/3z3F/AHPvMM//an3o1PP3mE43rdKvgA1NGiVb4LVhPQ/Vok0GxJRIyVAYinXb8pbQEicERijAfEEXgbgR95+xF+5Ksv4ff95D3ee/M6vuPlO/yid93iE+++xc9/5RY/59EtXr2auDk1IzKPdWPdtEKq7Z2XHRAySM+FjXfgWKg8Wn6O1ApGNYdZgUDWtNfwBgfGSJwCwOlcC82A5w+BL91d4R/eX+PHnzzCj37tBj/+9g0+/c41fvbuWKB3SsR4wPXLK6M9Z+BhTSAv5azq4nJeUYf4kLkcI/WjnjQM4urpZJlqrAPCjgHE7R3unwU+/Grid3/XF/Dbv+ktjJl4/jZwPdbzeV58WfbleCehSze3QIReHFW9TEmmyu57iZ/TFORxRNR6PTrG1iziamfYiwROgGo6kI6oMMNOpgerTX2S5HKEQ85mr+C5DQLr+l+uxY/AwtUGCMlD2X4xhUcuW10DyNly8+A1o9nKcTZFXenUiX8mERHtU7dLD3LEyr65SpLViwoMWP1zf1dOYlVHT0f9mbr/4KL4YbjW7a7febheSOYYo7a5rm3yABS8diRjfnOUV0t0wlnjIwHpxHjykhB+njZHW6W8iFUW4l5lRYU2Nv1m5Uie0JcFjChF7sUuLACFAgsBDQ/u4TDklCtz50CpTCTiYm6FipbJ2KnZspxKNidrXHRk3j+Ig1QegWJnhVzPoANQyKWgD+oMjCWqMH5hYGUU9Ha1oj81DvSiuqgSrFxLjWoEdOSxjZeLoVjW4zg5GJXYtlJcvRNLfYbNgzl3+MYaF7+HttVkf7ElQ9KzcjoEa1U6KpCSIRFrujlo90Iaj6RPJVqtHk7kQ+D6OOP+diBxxr/0TV/BP/uht/C//rvvwv/xM+/H8/u1fWyOAvoZOn5Wd2err9yytq7ycIA0NDRoLOVCRuCMUwUVawvZOBKRA1/GCX/lySP8la+egU8nXjklPvh44uOP7/Fdr97i57x8j+98+Q4ffXzG+6/OeO/NGUNXrk2sQt5YJfPzmpKaci6LrqzxRDmetTujqyeNmkPLd+jYS811hvz6zxl68BjA+cCXzie8cXvgp9454R88ucKn3r7BJ59c47NPB968P/AsB3CsRXwxEtc3a/vvMoGBB3lsSjS1IKyrE1SESgAcmwz5k/oTAM6JrO27vLnvyDPubgceZeC//x3v4Hd918/i41dv4f5p4CFW4JjnAM7U62C3ErX0QMFBE+Gfram15YHl4Gimer4s1KanouSmtTw0Izo2LbilhXZikxc0RvmdyX4KVNZhTKsiOkbrO1Fa9ghvGP2tjYH2utUJ06cSc+dLXn6Pbt/8nrIqX3xR/wwEzuSf4YyaiqwdFefySaUU2Ti7Xede4+x6cLQeoZKwUaczdiTdjthxznjfgB8i0MK51vuIF1jN7H+FSLXlkNEknbmo57R2CIxZufaKOKsdJw2dwJ9UsgYyuRY2CFNqhMwVNJQahOYlQRcBa7HYwNWaaftaxYQUsSEaCVjuWUqBbDFdz++srKLnxNtAxQhEHQLR217AeVJOs83eCKcybAUf3Ecq2VJxzW1qvGaU/WEo4AhtOamxlDJUEbBklFoRymy5y2chWXo3Uuxqc6KzJPk4VKVgLH7orgC9D5XKfGqxo+xonppzaYPPfie7WS8KLNCzjLR0ETk31tFgts/EtlSFhmX5UfPAz58GPnB9xn/8S76K3/zRJ/i3f/y9+LM/+27gfuLqlJg6z4Fjoh5xWqn4vGXVXmKGSrUUxwRBnZawQOvM55E4jrmubL4CnuXAp++u8ennj/CDb74KJHDEA155NPANLwU+dH2PDz4642M39/iWm2d43/UZ77pJvHpMvOt0xnuPMx6NievTGaecFzcZAhgTG4OJOLP/BAYmDtxn4H4OPH0YeOsh8KX7K3zl4QpP7gNffH7CZ59f43O3wOdvr/HT99f4/PPAk+eJeY51TeaRQEycjsT1SOSYyBiYCNz7ZV4kZZjzGsPmN+tLcjaIJJXZI9F7yxdQbp4wgXEApzzj9m6d4PjrP/I1/M7v/Bq+5/UnwPMzbm8HTpiIM92f8YTCTVYAoepXn/FBey9cpL/KWjY7U2VkOvzNt7KXAnjizUr2qrEo23Oc6/LsekdbaJm9Euu8wrB+X5RzKyedZg2rpnLWrtXGTZa4VyJhFYVNkJtlgll9DbCclFV2APh5FC+0UtjO93udENT/BsFBq4zLJpculF1mDcUDhwCs6mTV6Iy1+ws9HaOqCAqNag2H5DqGmGon8mLpRyJ5TklJoYtaKR+8hjDWRnyptPk+W+/Gn+XuCjcD6FsJSeni+mnpTzt5OpREOQstq02w5sfFfX0IT2epSwuX492ctdC5YVswWZg6lPZnlVR8kijXYgwvV9IxKnNl1iwONA1lHcwUFdWCTmf91myMPno1oAqGBcBqo6NzoxVZGXuZhm6+6iecJ9u2F7Gssh8wEGDkx0xiIliKtUBCLl+E5a4AwYAh1mESVHTUqYYCD5FHS4OmAdh+sBoTzZtEOf8FPgPZMil5bYsB68QnDxjJk6nOy8hZBdrZ1YaP1WaO4q+VyzMmrgdwvgucHya++33P8ad/5RfwR3/6bfxvP/Ue/MU3HwOZuHoUa95wQrq1IXVw+klq1URYyABVfYJaZmAnDFtz/WBAsLL0AxNxrMVvC/8DX8vE154e+IknN7UFAUC+BuTEMRI3B/ASJl49TTw+TTw+znjlNPHSVeDlA3gpJh7HGY/HXIfYLKSTjJ+dgdsJPM/Aszzh7TzwtYcDbz8Ent4Gnj4knswDz+eonS/831yO/pSImDhdJ66ieBfr5rxZQU9XSLiog7Knbaw2I7LBsBA9CrRH8WnpWWXJM9aiOVWWmPmtEZ5i4u4OOOcJv/SDt/idP/9n8Ru/4S3g7h63T9aWzqu6IXQtzERXGGRW7tRazmka2pm3VVdK2FFlWy4OlhonT6WDAvzlPMytjUCezT7o18r25ALTKBrR1Yvahpj2O38S0PazLr+5efVnbZ97xUF6TUdgdjEz6y4UsqbrwJSV8hchY/RcNXnKaeQEGGRRBlyAFxxCYdDmQegPIEiULwr0Waq+cDI0nTiW9WoWt+xbmMjKhleDIKwquJbJWHhn+FFczOwpiSC/Gk8QzfOtRFoBGcQqx6j2BZ74nYyjEhCZtau7zQfFAsiVbZtHlJPtP0lGGJHOcJ6CtrA6TZk6+lKUpWgK3SZ1rubns5iyolyPTdfsGHKWoI0mZK96L/77Ypqos9SRVMyULwBMBhhAPsCDH0WQNXepjCcbYNZc4JZqqD92QmHOLFVPmdCKTFGONheo6q1ypKG+qEHGn7BymPrnuBLME8KiTgYQwQVflrW33sw6tjkKw0IVJj60lHHJ2mO1pSq8oTEYK4DbQPtlZubFAypTyR/IVQUg/wMY58TIe9y9E4jjjH/uw1/Dr//Ic/yJzz7Gf/jJd+OvffUVAGvn2YxYUwPh43KHDlWqOHhWMDKbxiXzLiwCLX85PZu04vzupNFjbdcKPKxDmI41Y8JqywzgHoHn58DP3h/A/QHkVTnEWA2uA/hRJaBN3kLgKHGPsDl+lPxXYHI6WdlW9C0gW1XzA2f49jITKgjYZNcytsacNH7kTiIcVvw5A172EKv/4+EBt3fAGQM//71n/I7v+iJ+6ze+hZfyGe7fXgtbrzCRD8UCzqyY7XXpOcC5U06RbvNbAj7Y+Fqgnrm19RLIW1XYnFw5sVgBZTlNVWzaGS9zpaNkEGJYkuhDtopCnd56NgeJqnaBOAZhBtNmxQpxGdym5LnGJW8IlfrEhWUXtJve+k1ayhtYcrimvkf1S2ebm+01dy/lwHaJ4WXLtctNZsAIgX4gl821k0xg1sLA8gkjaMHR+B5DPGmtKAqrbVZa05r3RaR8LckXaGIPfl/L5rHJ6sEkCiZbOjnUaZalHAFTGq0ySRNAgLsVhcHqPyWfGGnA4AIwEza5UVmWfwyBJQ07q/w+BoHdVY08jQYxsAJxLHonunxSwglm13kRfa5oAjqJS9/RcC8EkMAEVyU9FC/XFp1eXDPLOQE8v1tAMpfjxugMenOCNc+6xDEQs465JOjFpVK0Uo3ihY7QlZI08Cwgqe1uBCY5MNf+fosHnCkAon8p0LEJnm2OWfiEJQfhZdJ42QMhpNpQxYNGEtpSKYOt6GZm2JRe9VZyzDOVdmWPp0hEPuDuycAY9/jNH/sqfv3HnuIP/+NX8X/61Mv4K197GTgD11eJHAMzeQBSV5aIBSgA5oJMZqySiUC8lVZzc7JHhqXUBWbJdIYdQK1sptdoaMLuWEZNvSBDQ8xLm0adko30h3YpkKa9BjJXlq1jc91B6p12iIleBNl+nOsQIAkzuyG5WnBl1SW0dqr9pVTc3UOHuapYR07c3wIPE/jE68/xr3z7O/jnP/4Er49neHgG3J0HrvCAzIHkoT4RFSwWxmluT0S1U4SRQbD2e78jxBeuW9l+OnUGz/dI2iyrfvXunrWl+fPQ2RBJIIXJL3sagja9jh8ZhbtZetrZZk8d2DjZKs/ACGqcVUi0Cq7o5xSqKokVLjPIC07fAL2ua+kWr9GVPyK/bCF516l7aiEumFwz9aJf2MFx1sroRNbhZ8zwi29zLUDlkdmL78RKksJKxaoQjBLUms4m9lGeqWpn8F1uIYwoeyx01Bbv9nGB7IQZAeRYlUrpZCOnv9ipSv1NdxCJU8/nuFuQGoERluaaLhw7G1yybZDiivPFpImoC4BUxhZ9zCxDDmABNheooGCRZeRyoIPK1Y5a0V/SzcxdMbYzrjuC9vE6eAUVlhEasYehLw1ukAkDMWaPwzNrgW7q5LsRy2HpLFy2t8kiKwMIzfPT2D1govugp5RhJNBzb/Vo6Zmb+KwAjG0p+NuqA1nvrsh7OaGmTTmsdCSUgfQpkTCFLUfG89p7KJKrAMcdqH7oXvcxbmsXHDxRC+V0m9Qi6TQTOB5w+9bAzdU9/qWPfRW/+WNP8af+8dv4P/y9x/jBL78CzMRxmjhOB6YAYF1ItN2nAud1NpmqCFGPKORAn5bWDn1xgAXM0iUbF/VcWeLmQGNrJen4BYLYdZj0Ueca7aRrshG9klsbvSMHWuiY9k6fFtSOoAbd7bVJ2XhIs1CrMtYhZxgADizwzvPEw8O69veXve8Z/tVv+TK+7xvfwSvHPc53wPMZuM6JMQFd26vxdyXH1Yz0NttS9CgB4+VT9bIv0grHtcpayc/loJMiFoeEx5nNuu5M4lrrdZZv5tdJ+yls5QFgqn0qMXGfmqBzRpjORD+fdM56qUTCLd4702wcKq6bAXR85ZWbQzyO1kGboma2Mac4tfyD9S2e2tHfS4sq8KmjzC8XxjFY2qesV3DQQWY0bax8JLTTpK1+PccdHD51ghhoa2hbXq9NO6ehxyTbKiF31VmTP6VD20viPP/HQIT0nQTWkXqgKz9dZnOJE1AjFkFTzofH2nZEvv6/M7b13pqPHg2RAhNGWR6GRNSiNVIiXdoj69B/lvNX2b4MxHGOo+0Fa1DWz1XpKnHNVjCVJW19wLFW+izQC5PlRaCjuT+0scfRZT7uKhBoZMe5/SZqm07/LZuks0s6gXYeiqTJq1ygnaY0yiLIhwC0w8DBLUwvCgyVqVgfSR4EkHPWOQOQ8kRpZ2vBRcYQqUVGJJr9TkZJEZutaO2EAoZuW1n0XH0qEyhWXR9A3idu7xNXpzv8po/c4b/7oWf4oS89wR/4By/hT3/hFXxtPgLG2iI2YzmRAXTQ11w3o+zV91ngnakJKwUOYRLlHQoCZ7ZosqGOMmNeGNxOnj5zPRf67IUfZfOUJTpTYWBlTJbW0TlVG3R8eyAAyYH2rsOqCpMlnczKti4AMNtuOzBZiHCMwJgTdw8B5IFXrgO/8oNP8K98/Mv4Ne9/Bzdxh4e7A3dYF8hcZ6n0xJq+It6k2aB0kSSYHSd5UeOdxaNG5F44XM7EhqExhPEqm/Vmo2XzkRcLEckLx7bFSC4m6y2sddEUis4YktEALPGjkxrboj4GeUoCGYlMYCV1IYIWrVFVNkuY9JfYs1pOjpGBfpXLw/hDnLB1R+Tf5P0q1ImagopqRzuBJoAj1HPQ4EC8bapWQFmX94zC0GhvFlXZgNtfjZvj6oqXBSz74Bf9sRKfbp0CmeWPqhp1gSt9GBjW+gS/p0AJYvNW/qb0m3ffkOcnp4u/N0EUQAlD95Ob6x2BOJcgow1IwAGnL/fPyogJFDJ0OUA+PBrQ68hOxT0yIj6/hB3VKIMA9sk97hIZs0y6WnnnYmih5jL+0GdSvDJcLWyxjFOnYpmCsPn1eihIIOCo1kRXJ4DHhRFAy1clcHoElygdrIwx6zrmVHiYQIOBh4wpKuAgqPZWZNYKEzUmbK9oLKn25ULk9gIERBSI0TajeiznV2W7oJNP8jL1PFVh6QuM/zBAo0Qo6644XeEBmIG7+4HAHX7168/xq3/ZO/jkO1/DH/qp1/BHfupV/N1nj4D7iRPOiKtAHqNOA6D8dt4xo1LAPcgGlxVLjRerei+VAHSCrSee9Xdz5B3/20HgdkiWfN7obBWVqdpUQMsD6lO7SdTEUG9Lt2zMGi7b7s+0oNSfRaA3/BP4VtUlAOT9OkUQMfDtL9/h+77pCX7TN76DTzx+G7i/w92zwPNx4GrMtd0poT39K3rrYGxjbzklVhoD6BtDEaCxaFFeSORqo88l6fa0ILn+F45PIfymNWAvz++VGcQARumV5uS/jqtNr4KudxkUMCAeWQF8sDpjvAhzOq0ajZgMhjQmqmsDAPEgbdxFXI85Ny1TFcAzZadp1IJNLdhT8Fb9rgVmJVdPFdsm/KPBRKDWCbltLV0vGdhpf/IcZYsMwJlQsmfi2UoU6CfaI/T2QcrKvEWa7DipQdybs85eoPK0nqXRRw6SFw3YwMlnBziIlrKVn9EgI+doSs9IRU7PFBtYwOBCZNQ7uvPqO4A4gbf4pfojWbx60dWiQXcpVF4oVGXnnnHWq1IakhsX38nDxNafDDcZoDfAEij3DM+Eboaa5aC0vrEXIivROKiwjPB0RsMe4CRBJRNMzdRPFjci2miQ4AlBkRfb/tJUJdocwuRFpVqicOPtS0ndyriithGz4U6QElgVF7HcaHJmzuz5aupF6QH5RhBQ6+VIt6lq/zkvQMlchyudYp06d/eQyOOM73r0gN/zXXf4X/ycr+LPffER/uBnXsUPvfESvnp7AGPidBWIqzVnuDKUtbV0TY8sjz8jOZMGuWWzE3eQu4KtsfF8iVbSHa+bTdSNlD7RphkcL0bRuTQhvhbDNAh+tPVEn/a2r90Ak+OdvXTssq1uW5WnjQW2vmFEOf2JvJ94yAOIgXdd3eOXf+ApfstH38Kvfv87eN/pFrg74+7ZwJwDp1yLFjcGJRrEN/1q0NQqfAFz8Iyxfm2aIyX55VVUabLPA1FTjtEfElvbAxo2RNOnfWoQKDTGUaysMKHOTljySqDumliu1O/wyjqjPsD9/82mpbOlmNQL2LvZeCMiBJVMbDRB1ThMXl9iIA/ysaCrzLyniK1jOsK1m6QW6xX2NQ+i5LAW+GmcfDdb7iupGOI7s39EKGuedREaVFmx6kUdY57zXFMGo/o322BgUesGGBwLg21HDnnKijovFrKMB5nnlRBza6psLM2+Zvnb4jz5gzX+E1dzt+TNiRAwtliCzuUCPe1PllYIuoz8VNrY5sj7naAClMKwTFKUYyOVkW2iFTMB8KYmtJJ45WERM8pxlUOdueaFtmckgyWwopR70rehJ1B7xpZjSuqOOW4KxtuVQ8wNHOoWzjaZtMCCNGgrD2UkFq+Rp/nZ6jCofLCx17MEKYIOM+fVfTuGBvauXigJEDjZXLaExmDOGCAlLRkFGAQb/oWcipyfyafVdJsQMZqaNlZTOxNBg3RxmBs15n0B70gcACLOOD8HHm4D7z7d4jd95Bn+uQ+/jb//5Bp/9ouv4I999iX86FdewrPbE4CJY6x958vQhxxwr7MAMpjpU8a0s915a6x615B/KYQFFMvoF6/D5NINCACCAF72PMgXgjH510amih1q2iCoW/Zz4SzXUKjrIT1T9UcA3xUKTt9GYmX6Dwt3XrlKfOI9t/i+D7+NX/O+J/jOl58hcMb5NvD8NnBK4DTP696BqhgNMr14oJvsvApiNq3piLKtxhfSmAqKkbRRNKbwD/R3rWGpdyK4c0diXDwX04g3F8ZsNildshJGRGxFEyZD/OE5AiG6mXU0vk5ywmgDajZ/emvkbekIpzkJRpxrsARBGkO/IOZQH1Lwo6cTqv4J6MhfOmA6STbIQA4hPe5aLOmO9pOjMEgnqPaPgh1iVvo/wdYgx4/GQ1lrslLOp7OudAZYNSD80j4Bu8PGnrFB0NnoA9qnEugt4eqXE6hzAIALxpGQlr6uojXXhABiDMx5rsGHFIUGzWhE+lqLJXTvc/Sqbc5TahUuwbyyPtKkbXZmWS+AZ7UjxwZzTtnvBI1jxDpnALFWl88GBC5iCWB97pGIAbXwOgHet60Py8H3a1ZuK+Zw5egqb9doosCCfKRcztXQKE5bAKEDgJPAkOhSbld5tpJk0DXQ4Q4ZI4FQi1QpL9e/6qtXE9sDZYh6KUSqMpU29nVQjMZU7XQBxiJhJ6C2aq7rTgu4iy45PQZgF3ueE30GRQcHlaVwb/lcO9Cv8YCcibu7dbLgd1w/wXd8y1P8q990jb/z1oEf+MLL+LNvvIa/+dUbPL1b/B1VHcCxFo2R9NDRwwBLPspgRPfSCWYL0ilLs5ntk59A2Ap0Oi+OVUxBA7dXrgoPSy+ZBWurWJizq8WgqlcU4TptLruSEXbOebt5FIhmVbpSa3LOt4lzXAEx8PLpAd/9/lv8tz/0Nn7V+5/g593c4Qa3wEPi+ZMDiHWFwDXOwMR+K11CNMpJyvbcuRctRTsrcsQkwQFL5awkwfRrctrAmKkoCl21IySkTEHr6mIJcWWtLANqKqGa4vSmXyXNxITK484k+kCl7ebGYfqehAKbfjKeeHtyenysgixtOTTmR+minJv4HZrHR1hoQLuztSFalxD9jJJM6mOt2F/bV63kX/LYHX9jh+ImCoLB07AvaEPBKgQuApRU1SPamUneM8pnlWJQNdYi0lm7mWqdEDFO/N1/l18FMB/muqMArCQGVI+O5rMwE+jAsWz/JIarzJHVKQdYwEhlYncZusY2WlTdeYHG3BxMBwUprne7esaIzr2BYiqtM0Traq4YGKRxfUt6NN1RZdg0rQ56rdzLZAwgVnmnFsTV4rRWAPbZpDICpgNf6zuyjamAJoNlRjNmKWrzlwChU+4A5MhaSNfCFY8lldy9MQGdzdfizAUG0afyReoQHRmDmukGogazFfKlZF4xaKA35bKQg0pbZboJ6aOcnqF12turmlFGMXe5mNvrTybtr6tRsypAq1SbFFABWMmXY87AqcomD/eB8/3AiAf8kldu8Uve9Qz/+s/5Gv7uWyf8+S+8hL/8sy/jr33tJfz0/RVwXqh2jIlx6jLpbFWubWiUFbRY0wFXFwDIltsZpU+NTBM0AZQLqpSZ9F7njqtaVzzrYbyoI2NhzaP7Yfv1a4OP62KBJQP5eT/xQCUfEx99fMYvfu87+N73PcM/9Z6n+Hmv3OEm74CHifvnB27nWGcS1MqLqEroOiBp2au2wfK0USljZfitpuBqROli4QDYNkl3vScX6EUR7ZAS3G3a01CBtr1YeuRXwIL8yazzNUKyoQl4GXhtA6RJtOPN0tF9rF3p42csr+v8lcKGdvBWWay1VwM9lcajiIOn5lnwSvtqTGudBug7cBHckMnEsp3vKYyeClAzJzCObSHe4s1RiWQlUwr6qwlLArjKfyU9hZ8z1xHX9cyCXG7hTuMvAF4JDNpW4yH0WQ0iyta5Fo1BBcuTsdoDsoJA3u5AuaxAYlJXw+zK9GK9T32JfTo1GmNO1NReLNICWAKCFsYtcD832IsB+/yDBuqRBwcUo+cjwMilQJtWUxNuOnYVQK9YSzkh9kdDTz1XjB/RC8VioK+dLecUrWizSvhGbWm+Gx1BpMENgY76YAYLtBIUDbouM1KRJ4OsPBe/au93LypOreid0xxBYN9FoXFRiWjJSzmEUa21Pa+EqnHIidTUzQjw8B+VrVgtzAKJun0PdKYF7NxNoUVUdP6UIccFm2DKqWAUEe3IUIYiNErjEbNfVm56jORdllGuFcGudyUl4zdqIWti9iI94Redg4jCGImxzrjDw23gAYEj7/GJx3f4xLc+w//yW9/B524P/NjbN/irX30Ff/VLj/CpJyd86XYsYh4mRpxxXB+rMlFbFHXhT13vK+BkNtlE7bGRAeGqrIdsULwK7Iu0LBjbJptkeyUPAFoJbjbMBxlgxGxPR/0akn+u+woeJs61gA9j4n3XZ/y8d5/xK973Dn7p60/wT7x6jw8/PgPnW+A2cf/0wHMETjNw4LxKpx2t9nQYUIcLppJnjTtJM42r3fiqKlbqPqlRzoPGKQa5lvL082wvoWMc2v6WfUzQGXdQuWEg0Iv6osHbI1td2NUzpI3Lk45hI7/+SBm63fBdNGB3JGWrrVf8u22YHWn8ufe1mlw6rYWVgGyf2NM+bGsAAOoW0oAi0Ii6UIgS8HCssm6eGlvPzTo7XX0kkKMOTFNCygGEHa9fWBN0xMV0Bkf0fZZVKaHDquTUCUL6TPglG6KzXn1oynUJE2TYUk/qXrNIwUf5JgVSxk9PcOn7kMnbADsa5pxUucjFKPl0qlSV/egEk4IOqMbEoCG5NQIWCQ8wBCQYK77R5TdRh9n4HEqd5lejH6VIvm6ApZiM4KYFgRDJ4lnZNhuqYKMjuwuBEh7lKTujOGrBIk1Q9Fzocubs0/DMGYZ4bwL1dRIlg76soww+2vmhssQw4163VIVOMuO51M2zWmeRUacdsh3ypJ0EyLeiSXpR5XYmBUv36VholItelrITdaiTUqIQaCqQ3JhXwQIBVQC0nmtD4uPkA6sDIR1eoLw+G0hMLgxlkxNo5AZ0V0U0gNGYwkqYtI+ravOuVudm3uMjp1t85L3v4De8/y3cfusJn3l+4JNfucaPvPUYP/yFE/7+0xt84WFgbc4awPkBA4njAOIUwDHEt8RhFQILAxSgejQABZrkYa/O8LKgL9psWVIWCtICzdcCkF3/au7+oAOcwAMwz4kHDGV7x5j44M0Z3/ryU3ziPff45e99G9/12h2++dHE9XgAzg/Aw8DtkwN5rsV8kTiK/2vLqTucDmRZwQjqL9cwERjFmq7AQO9mq7sCBxpTQNGkgMQZ7bwOHegjGwewDkEqvjFxUUIwhBu0L2bsvSixMKro62MB1g17vMVPVxXLKYVhf/AV6UdvY6QbL10H2rY0XnvZx0d6mLlTx1BnnZS/4PHM6/Xk8JsWs2XBMM1MjroO0M2mZ727Si5rrR4d8Opn5BCOMmjk4ei93IkYxB7CdB3CAZf7Wpuwph/SaJI+AtBy8BwdQAKd7CT94Oykh/9Wv1xfQglloQWndpDNO+FDekPUZ1a/Fx2nnrNlFl9GrYgU7YTQg8v2VptS7MACZVcNFF2kpphVLiTzLcoRo2ogmg9l+7BKp5dK+RmaKYFmLtcZBNYK/MkDQehsaExkbjo/PYPcC8xifBJYSAszyxqzFLGF04ck7QKNUiztYsjWQQJKsCMuKgGUJaQ5X9vFUiBhsotZTrY4xXlk4yMvbAKan+2AqAoVYOnK3uL5dONY72hvOM+JEL+amZmBeEjoAKFiWwd2NPbuS/TORIzWpUBnY4layZ1t+CubXLIIHakK+JkEDuKrxdjGHwjEGaviNGqa4GFlISPv8B3HxHd84Am+70NfxfNvO+HN28Ann93gU29d429/9Rqf+uo1fvr5Fd64u8K8q3L/uXgeZxwnAGM0/iKr7E05hvQkYIAgp0R5FT+HWAgGArobPaLu36DcZ8uP/HpI4OFcJfwAL1LBXNu13nfzgG9++R6/8N13+LmvPMcvfPcdvu3RPT5wc8ajeADOZ+ABuH12wi2AgQMDiat8aIecdIpmb6wUIux42/LERM/saluRL9Ok3ir72jJB0+ly/rJGZWCxTbPoey5WAyG3baJ7CFOZ6HF6cF2BddPKcbD6kObUherKuHvQnRsnsCVZqdc8MLAT5xqOmgBhNBSUKGnUtbrkKQSe+yJeBj1TfoIEb0G+6fJiz7Jk3i1AZg0GFhbIhPq2hIpIYHrUPScQA73Xn0FmOWdOLamquZqf5Zw94VHA4HzLwjAaLroi0iZF5SRfPdsPBGaxb50KW+SZnTfdkhlLp5suLaau7bEs85L8LHhPo0zk8SkvK3cpa73bRpELZfV5O9JiDTMyKjEYfZqjKUHyZLvtVqXc91fCjLj9g+8jvlR2GxmNTm1L8zchNVAsQa1rCELjVVQ7c5X2a/cIlTupvDWBJzrKaOTpDWjW6tsUEUv5akoFDA5acbYyei5Gc3WwzqpHt5/ErGIM6YxSQmTDjjILRq/8vRZRovrZmNeMhgyQ4BzQPCLXlfQ0EWXYIKGsHrJ3qqF+4dh4uAmF07rXtLGkuxhrNDuQF9+KyvXZKIeXbTcgf9jyQn+cRlvfw0PgXA79GBMfHQ/46Ltu8eveF8A48CxPePM+8Jl3rvATT27wd9++xmefXOFzT9dVu1+5O/Bsdt/UnY6aznIccYxaMlBOTFGBIKj0LrWRhc3RjvNuljjZSelvXTN4nRM3EXjf4zM+dnOLb3j5AR955Yxvf/kO3/nyLb7x5h4fvrrHS/GwdP4M5EPg7mngefF/ROJALSaehTMmJnedDPQ5BdAxsyUNts4DZYsrg6ON9kCDY7tMTmy9BGjTMPu1mztpzqPKVMzplHFWHzSNPblKhByDrjtCk1VEc0rTnITCfS0SghwHdZFJGeWpUebyXlx0R1KV7NF3kO0O8vy3bI9nmmTtvhh1fIO2UpYMm+E9bbPlQRaguRORPxAmhzBg4VwTSmyP2mXDtqQb5MASmLLyRZrpmRIjtO5UD5NJR9QsaC65hUVsvRUSugiKfnObhgrXuqhFkx38AesCKU1BJD/L8m2jno9uk/JRkNc+OiwgOlEAaQ7Hy9MWSjRwJHlDAREspNXoAru4plI392xvq1LtTnuVoeSgWvl04IkqBPRwRQdHyQVsAi1Xguwx8UWQ/CylKaAbuS+uVcjcCseo2e0CnKMs+n2+nk5NCpy97WbFCV6ohQw9TVkIOz73tEU0eflZG4CC4QKyrIzAqy58sIdKqTBuKaslaE6Ws8whcgwFBNKJTPVJNUPAtgDGzh9fC5Kww4B8mCmRpPGLT5h5AejrjJWtAOChRry0KcsYI7CqAkcDa6dO7vytvaD8+Dw00EBdwwkA5wc8zFV1mHdrvMfxgI8dZ3zstWf45e8O4LgC4sCTBL5yN/Dms4HPPx/4/P2Bzz858MVnJ3xpXuHL9weenAfeehZ4+y7wbAbOCDxg4G4GHjJwn6ggx7ZzmKxOMXEcwPUIXB/rpLCXYuK16zNePp3x+AS8+wr48KN7fOTxPb7x5gEfv77De05nvP4S8PqBldXnA5Ars8cZuHs+8GwCwZPWUIfz0ElyykoR9O5sOtmgQlqlsfChd/JR5p0Zq0ZGuU/Tn4iaZ4ZkF7k7gtYtT1QgbxPEUTmcvYJJOulk3PnXoEDsVFC26XZP0qiiuvWHxoWyQZ3fUe9OLvhl1YNjqOx52OI1Yhoxtkzd9F/kms2z2is4N6G1aHRKX6J25GRhAtrRam986LOtLQZe0fP4AOp21CwTjaZPOtTVjQ4yiDd9zoafBEgZ8JK1rATFt1KzDXZJVxLNOJXxt59QbApPRNQGpWA+J7xPVOWYipvUhOY3lUkyp55FroOA1t9cIEFO9Y12CWzG4uC+/tBhwJuz3jpDK/Ay+ujSBRWt/mOuqofCgUkg+s/KRGq3gFd63LiiomutlDcJ5VzfRTFRTkosbubuJR40LWyPJfTYJwaW8fF5AnC1ZZlll5j5dc0Oye8YEtL4zQlp6iLa/pYyl9JQxpSI3mkD1/bA6Db7+ttQ2RxAbZ8kP6w8uslT9llA0+Cu+EXZOXqfcVUtfM5bmVpA85fKVA00nZYs+XPc5FUbnvFEh5BIOUUXkoOKjR4Ccmp3Sgp8FHJYZSGo/6CzWWtvDqRkeX8eyHtmkGdkTFwfwEePxEdfOgOPgXVAwVHkDNznUc5+4OkD8PQ+cZ/AfQRuz8DzBG4fAvcP63Y8xFFrbhcPj5h4dExcH4lHp8CjWL8/HoGX41wH66x1DoEzkOc1NfFQA7sfuL8buKU+5Ap7R6x1MkcA3K8NhLJF2RGDSLex0sN2RGn6YI8q28pyfvKKtKr1e2YXdpLiage/27QZkbrMzenrJeqiVVhq4TxYjSNetW7ZVCBQGV/0WOhBOJVnVYztcin+E8z4L87mt3UsSE8gANTix5wJHLFVGZU5LlHCO+xV+rSBDta3xZblFCUuw7bsTuoBm8qo6STtejLYW9peLSqiyzr5j3VK9CjDZUVvxZv/qDeoIHRs7/bZAgYYSFCk3KW0WLsGqwWaZdtLloCCJIeQUtIUYyhfZuk1/u15xzk0RtvRrhHQzrPFgtWe2MUKgKJh5IulF/54NBwAzwmHAVYYs3o7B62GTDZnwKgYq71edZ1bidodKlDlXDrBLYXsdojwQ6vCex//lPOr/9q8tCukHFkO1PmhEhB/39SsNIJKbqP3YoExsbriFAhim1sHoviQBVJ9TpSUaBTv0yJvA0z2pSoBgx8BXslA0ayXLbsNHrOsQKdHoV86oHrx+7R/FUw4eqW/83W+p/lWYKM92pP8KB3RsuahTHwDsy2ok3VKSG5ELemGjl5pTsNkJmDj3UDS+pFPayMv81n/qeyH01xrdmG1M+pei3wAzudA1jagLHAlQEU+4Ajg5QG8C6lMCJHrxI9NKbHvV6ej2TJSrEraQ+A8V5acmbgtkOGJE4PbwTJxxBmHvU69iYje6TLKcbBrZ54d1d3yssaCekDbLaTIZUdRTisTPVVF8E2ojD5rOmSbeyYxmb2OwVjGqiIdzCzvRt1bSSINm7jF5vOFTF56WzSqN9kqNSY2m2TWTr3qKUZYcLGeCR+Dxlbv2EEbY5h9XDpGt8eknta3dCqAKgu+rZzTD5YlNbZS5tUmcU94zrHPrGkhAo39FF1co4O6fnfNydMhNk5PPq9dHz3dslRhYhaDIkcnDmHJaITvXgTnLfx4XyWM0ePhXSh7QtNy3VjCKRk3Rz1uvornlKB0f/Q7wp+itOkr3YjESYoUxhhxpPZ3bqgePa8MdEJkQKjiF43ApuBFT2syANtHGZUbW6bX0XNlhNGDAaAS85Kz9i2C5UReG9uOglxO0eLbJTKm3h91ME12fbEXCdbPiYFIGXOQflilocbu0yuap89VfXDaPJMGeqsjEHI8jElSnoelMhe0LdoiMEbrnnw2y1QAMOrKy3K4atsW+Cw+eMQO6Iz+cswzVxCm1daJJUPR2SLQuHvIIARoEU/xVwG2Kk3kF3egZPOXMgUzXa6k3PGHfYt91QwXmsmJ0ZhIG2EqqwXxJrn+CMwag8pjKiGD5ve1j9/BgfqWq1SAQCX/UgBsP/mwEnNO6wHdHkUF0GZoc5sX0VNapTxz3akiR0CQq9ZsDUzvm+dzADFxPRNN0rxoh5ER93CDekmgSThWbJm4yvqEvXWYjssKVYmTsxHRhCOzQ8dGn/Yq9mxAbLxSgKK1TeuF8CGinaAWKNfpng7cPNSKdq2FtCbT1oHUVlc56YiGRDn47Z7JxiR0212hNXoibKpv7TzoClqaTaZEGhWopT1DZZAMePymoyqDByy17PUg9YQW6qFsekgzKBe5mpra6NH5NAttGMLSMKxZdK/2eZkdg57FkqHn+pTPqJh+1kJY8o7ta5AlupJv6ZuuHyZuEAqSmAvoisfaZkjuldbU76U7Fmw3X5ZMTlREKnLYg21czRDpvzJxAlsbsgjWQLvsvmRWBe8a9NoSUytGkVBVIRMsl6535hJGMJvPDhAovaLDExlflAUkUk4xG+BhZSyPnBMap9nI+i4CfYFKdt80yGCbnOcM9B32LIGyDNhGsATACNVUudrkXFJvYVtAIbXnHuISmJNP4JCr5VJWipmnaDEYMNb5fHlxB3LO4OriXEhWgYCXaz2LEBvDpg3sQBHGjFRil6Aco2QW7UzUrC/XK/oC4LGzysh8vLGAr3eh8LnmGUW9WFvfTwIUbQBd2i21ELzxd/oKAkKSV+1EZKicTpgVZNehTQIMAp/uf7ApoeJ5nx8gjFqfDRtL6X5nbeYMaFuSSWdGdJpbuRQ+npZBggBFOa1MRAjaiiG7JUTT8SSaNo5Nbrb4GGH8zqUPXX4ufNFR2nJF+u+GY0BvYUaWky66pdz0FkuPg4d+mdshrcRWUG6Z653uTbKQ3VRbzoPlp6y9ck5bhrYffYJmwsIulE531m4egechUPQxW4qbI2uqt7PmHS+Tz3ei6FgKkp4QJvdDTBhoTP1921BpiVgYCjSxtZTiFfnGEvtaY2VTAHrdf18RltYXVRWFi7F9WLTH9muNGYgOS4c2JDYWcspVsGKfNVi7fRXaaQq9Pis9TeoZDPsjei2S2koXVvfOuZjkWfsROtaXOOAvOu80l8P0haBqP+dZlQdFqRxwaPBAR/MNNj2kkEMPKQSyVyisrgnstewu9zlF2o8GFVDrcUGzkF1jpVKs36PeTbaNWBlIrlXPfN2meNYYmKITpKXIqSp3VqO8KCQAy1zsdyovyRo0oFJzViAI4MkztYswbWcyMCSfyChWamTAC1w9sSMtGdnzjJuTgR1g0pevJDM2t2UejmPgmjONxnJ4Gh/ZSSeVGoQWDF44qghA9zoM0hnF6elV/RrfamXw5UzpEZ2ngMp4v3Sw9SdxCZDFWy4d15yerN7i3xrz5sqKdiv/eaVCBzvp+ZY19Hf1myJpxwjy1Yx6saAoYJnYgtKtqkgDqCkI8imCJ0E2QUtFOO2z0zMVaTHIbtPpnUVMDtq5cbx8p22eMu82yFNuWe1gvkFVuuF48AJjQ3xDNg4t8itb1NbG5ukeZHagp+DUhBlVfWDQIgxL1DpjYkFnjL3GKDceCn1LGMQN2gX71IxrHVpDojpwMRpRbfDHA8AKDOUmW5DLLq0SEpSTKy31CKF3g0zk5/JFZyAPyWtV1aMq+63oKTdtGCNd/voWFKoeR68B27S/E0a/+pfZftuZAyAupq4LT9B6W2APRVVZ/Wos6+fEv1JIQG9UmVAhNOenN0KSrGCjDsGN/hnQthy35i7DQPN1SybVRimS1gTIxrq0Hpzz4QP1v2y5YTM0+b7RChmVbSTMAKxDmLGJkDKGAHwLCi1yOaV6lIbIRSLOqwK07SwEX/RD3k5DKo6XoEkUM8FuOiNmVEkxYYbJgKj4IsddL08zYqpYMuPsvtKtL8WGBcZnVmqyUbaRS9H0nKkFgr0WiTywwc92ri2ni8qLmGQGtLyQ2uoSdYN2z/mhDvyKzTuQJK3zqEDk8hCOEBruBpw2bipkqn1naGjthYZFk3pAgYlVJSTWpV86RGtjN+2R2XWD4OrXAiGOZ9IZpLKjRTnHEHx1AUxSlxK8P6StnUAc1iffM8VmydjWYyATWcE9u9Xalhk9dg6WR1A4HjIRucATLd4q+w8CJUu2pN7gLzN7fdJqROIjDPn0mPxX8WqJvvFHax+IQdGVKDkZ0dfy7vntEOYvDEEHFFyUSUFZ5NQLL9sWWGGQLtKtKFigSSTGwcpth8eCNupYphIeBcbUiQRYBepzTppZXdRlSZtf1PtzTdGyihkYNc1DvxTtcqR2HWnQfyiAZTUA9Esa/ZIJyJ9z2wh9XnYVrtGyp2C31f6AAoyeol2T4ayzwPRZFS1YoMhAaJTCJexUWrMP81Wu90suG5uilY0NkHktM7n7rKNbWxGxhQNdqmPksQilj22BoranENBsWqJpBR02FYJAB5he1AOcu/KpCv5olapVK7aMpOqiSRoM1BWPm5GwXJQJXRpyeVYAtYoBRs+lE5TrPzTymUtjzIl09tTA0ogEgcpWvXmRiQbKIVtaYMkXo9uVFULj8BIzErqURPg4WRNfbUrBZwFtt1DjnpIH+bYNj300u6SHa4hdgbBhwrWRTm2X80Wb4ZZQY57EzBBQIA3Ei+4G76Z9ZXFrkOE95jrDXfYJtOOdswJHm24gX7MzaCSrFxfDKX1XObU53XybRqPpRyaQ59ZVBVYJmNLAMwkTUWtGNJ1LH5pXLVD2WQ6fFYpa1ERQLSOvN+v0M690WXVM3sd0YXrgLukCO+dqGhJWtiZfuFOB9EnnocC1uLR0t6oY0p+0PtQWdqyi3mS3T70bivSr7Vn8kD1Q4ard8wq4+X77rq6K0rFJf6kn5l/XOoEKiiYkC9qGnJ0+YyW18cen5Li+NI3kWtsHVUnJX/oJca7o2/SGv1/yOWXHLlvtugGg4+E1Nx6SFyshW2V40xSASrJwYegdXjK27eIgVbEHFCRZp/mRrhpjO2n/nyamiwez+OLjbT4SadnA2gFDW1r/HZxTBqgI0CBYave2O0qGOafYwdWcldogsQKtUJ/abigD9vnEILqsLRosXYFKXY941MxSai2awvZcz8mb6bZImGbV8agB6EhdloDAslylGDN54ERgnC6YhTLiyhjcArJLCD1fXkotkDUwW9l6iq87eof+RyMmL1EKjVCYt6N/AQ5KFisqbZSSvGjYfM0MXGoitKUiG1C5zNHZ6Q6Wrh1rXG4M+l30ohIozmFy+ez6fs5++bJEjebGandOlf07+GoerQB11NUHpbMlv+W0CR7QOQcxqDccQAW5fv95yqdXew10O+u7Ipc8VtbajaKhb70j3f2YO8jwcZaJmqnWwreWm3QeWRU9lpTN4ZP8NFWvtpYKJFWjnV3R0apCXSWerKxqnmt8qiZG66fN97o+BUIB6hJVNlHhv3KdQ+te2jsMSVperjdNuzFq0TeUFwPwwIxjj5Y7fA57d4AS3Wis7QpjtV0Ejct5u8KTWUxPOrdsHKTtTtvqlnYy1Eg6EyhIZ3/YeFLOkT7AF09LJv3v0LjdFjeL2fCJjMsZ4KnwXSnE9p6SrYg+oT4ohxZEWLvkI8v0rf2Q3rJSsCeXqSmXocWC5r8EI2vB98DEoWQthc9dQbz4SSwmXNiw+LkpLRobTN7hTWUCM3kVGP8Hy4qtNpDd9pZ9RnqfUgx1mGinU7xop13MlrKV0hhPJRcaBCO3vqkBHRXFBddqPC+y0rgV4l7IWXrPPr7Y3tfFIeZE9B7HqpO7+uug2gspybsGbpX76p0Oxiq5vljowcbT5EEWc32fUpsy5DEskyfNtsp/iW7P9LQQLLFl5GHNbyykqgTAkxrDWOY621sT6/PhHG/w4Qu7ggO8tKgBZ72ja0VliwZi7nCq5z7vAHWwfb1jOh2ILZLuHR9W3oyo8uUuYxloe6QNSARBYVq46QIfWk54njt75jj9fwCxc0gGHdSZj4DL2+ihfNHVmf6O5cgKcqp60Z5/tTsMB1FVEWXDDvRsWpUiSLGo8VyzEcagJM7oWUgpuw20/VlgvZXmB7a5fadL/JVsrEIj0O2gPRGVrTeNi67c9E1OX0TU56w4YX+WonG6VIGS46nmpjdMG7kcVGf5CqwYIER7AQAeY9XPFE+oIzTBvj7ZHL5svgkweLE5cMdU7ApNXHGdIgXlmFsePT3M8ayxzcafik6J5l25zZ3HFxjfOpb6TNPo9THryBRr1jo3xUyZZZuxt0/Mz8brbjd7YacCpdTatWymbMGEn6ciq4tV9ZJRKPtANcyFVQKoiwa2MhSHUsyg1AU2ZRAOpASymj8jHVpBLWBpAbSCSjL9XDGBpY9A2IUJPWiDm1VyLUayFEZDlmEBsDBDvIiAolBHo81AsxVi4b1QY703rXRmwtfrNUek6XMaAYFM9LShrWbc2GMLyFQ9qPKV03gh6ra57Mh4K2POyuSZRZZchWMo8yTtBJxCxHbCDUBZCkTD4UIXGRKrAqU/3C3iNK/5s+i/tYqbRNGhADsKUVdSC99aL6hbBggFvBGVzSQNmuMqmZK+srd9kqvGZ99rOojfkwYKOuqZArWpIJFTX7GdREmQ2MAXPj7eNgn12zJfD0WIguJR7H8Tlcn3ajuBVb1jJl580pxr8WutKQsE1+dYJQK4DEZ7FAR/p5cuJKxt6oKL2/UfwqCSCDM0kk2aS1E0P8+qU6Ydb5u1lztVnJvRzj7B0nTZN0JVqe5r/1v6ZLqVhqHz7N8V3ZNl3/6O/C+kBlBnGpgNdSNT1ZtN700+cmQzVQnT62H0awyG5d2ZgmvJ5WIs5LF0CDs+6a00HAGHtXREVWVACrqarv/KZJxGIZ98Fsq79ELX0E42BXvFfyaBbHOwgsP2qYKz6w4dVLH/FaEtHpUtz2mYnajroIofoWEq8Af1N5UQDeOg/sc5eGYxHKBAjVZBY+GKT30aUt469FcWyzZ8NkNEU6KqQixT3jJDMVwfIJxhibUohJE8sjK57tnLiwkTFmnYKBwb8DT4YiuBy34MTERo9iMeBFEQYcCwaW4m/LyDjmwJUND7LpJLUpvE8rhaawDbh81tfDsgToF2AY629kW/bxmdq5KIqUV7ng17ELGe7NmqBvTdiOkMaAT7gJtoRboCFAc8OoWwbNX/t57vSNrbvWCoyYQBKEyvFhANORaf0tkNt3VaN8QZ0Mses/S5mJzAntVJTmQNgyAb/zYHHRt/1bfaW55rfZyid258gTJ2ltuVbZkq7YtVS2625uV8Lr1ENtujKwxb0G3jVwxxQZI7DZ4FABvH/nzzUHlfENxH6zmwTknJDiy2wJwyLjvh+hc+F8XSzlbROFJ0UV97XGFTh00qshOcpI5c6vIIuxI318JIA4iYTdeyrZBzCTKR02CZdlQ3/+38VgskL+2DaxHc77Jtt3+efNMAISx64fhcrF1U67FQ27I8DYiOLvV5st1+xEw8YCaqxJA6EdVuaheCJwNWxY4dyzbWmC5RD+iUe30R9aMNOs0XbPekaMxsnL57Z7rnvUrAss4ByIAtDg0NTC+KW+Ef7M7GMrounpQDr8gra6WnVnYOqEyzL+smVvBBfhU1h7cuR9DJf5RnDX4TsEwfyra3Mmf0M3tprqMxKQBCgldhh47NF+YA5RRbCB5hatpjmvGKXtTFHC1k4anmC5dghhyuR7ZCeuigHhgIZNMTpTgOSgEgxsoG/dYSbcmSwzPFF510BKtv3xpFgKMKpZ5fo9TJWkmtoT6K85INt5WZqKybJbcUmLQX2hyJK1o9V9oqPVps3p1WZu1UoBHxGFUAuoYVDF5CPJ6ZGAycYA6hKVMZz8t1o7yG8wTA0v/1y6apHKk0kSvVN+cR1m9o9OIjP69FTbjMnmtsXCOgKkC1sappKaDa9ABFTx16Q7pGHe8o8Ktx0wea9wTqchQePiS7Ev0tekvp6mdorJQD6X7hTKLi7/plXAQPBF1yvvhBPElKGt1X8V4f0u5IP1syPYDbWzcH7jqgfUCr7Dnm5okHwQHDCuqWcLPpqFGIbl3UyWCEdpxAn9zZYoL6IQPMWaS3nR0Y16epLjxcWfQ57yDO9yU8reZhtjF2fOE5MIedPcPAOBI8WEjKZxn0eqb5zZ1y3IEiSyj5NOtTVdB1gmSdfTMTPOBrp5/9NdD1+gXy/8XEsfWs6Gig44fiTQA4MZKkNtFwyRiOwUa/CRIJP1HyAljZZ4mVaxjKIS2Q4w1y5G0gBiP/+pkFtPqEZ1kui5MCS0sLSGIgfbl1BI6iJX0sNLLLSHNgrajV/HI5DwMJGpphLzJpMLGyLDmUrmaorOl9UkY04iA47aVWGpey90b2poOfsH9TZrVjVZ1ez8GSZH3snwPNt81wBENldAaUCHhgxXOyVYo3APZKEtt2Y3BHpZCAvBocU7PSdUOBDFuRg4DRZDKoHmfWEZ71QGSVS2n80ok+tEnHzJpHcUfDzpgtSLUQa/K0TlR0zKRTwFmMbrVG667GANQWTuynxyU2fdRUjJwXGojqWYKe1oVKTJ2Ft7TRYChAaixINWxoQvyQXmHzr82j4mWMnpbZnn3RYTJg2TBsgzF2GGKy83BbBJ0wJ9w0tCKSltbtoA071tAbUX98zE7m7A8YSC7MsEFV33kufTjqAKzcT/tThYHv2Pja5Ep/yVfKk79X9VLJpTVEnLpgdvmaUnZPkNRuKOjrdYAd3ALmFNkOFu8wLuu42QvwqHkJrFMl+5TL3nLN21R3n/Yi6pDapi3GMKgN27bsrzbDGeghoxYGF8/E+2HBdZ3Lgk5KdNBR0aRxy26y+aJniPXlOVWxYVtpS60sumX5PgK9gIvGny8GBT3DUcwPFlmL0eYQ1te5RTyqSma3tuiNraTSBGUDaGYPPqFy2eTnwey3+hPGhP6bZHP0so2tpBvGXAVHerkMtW9Xa9Ap4fsqymaCDIL9tMDEWnCgXlbVd5JH/cEMVA4gjbFlYOLLYnzW99zqE6i5RBoJV5azzF8gHaYs6pP8aCbv1Q2+U7EbFxlvu0hIq5k2gcD3ilO9Gbx6YcrBWDwUUFMUpKt1h8FSt9H73vUMvyIYB8BbGpjVa7z+E013jytsi1z1pBVzVW3JbmvP5GgX8YKD1+Kz4nnTtBrblsHUoDT2zN7WydI0jA7KkSvfNZ/bpWNVCqrPbepHi//CAgT0eEuPB0ebqMWFqX58rHPbWmf92NhRvHaYWDpszzI7qS/ldrJ1K4r3OpeeMuxUXPLh31wXQZyBMKv/zTocbLN/z7Srn3ZBVWpGYdtsnKON+HROlnzD5qiJc8SBJeLGxPVVtm9hydsxyJM8PpOGm+KtALF/TD/4HXtfQX4rR9+B0p1tOqV+7N/yG83Pfp6qwuCM+hqmuNTnrvSG2l02Bwu6Yxvb+rtPTWSgSK3a6ciWrduK9Dlt3Zgd059bWKlxLqlOvPCls96CvpOe9CyRqqCILp2vqzMtIDNHr4itheeHrfTcbHCELXRzWpPKXM5W29/YDx1n9eOlpkCoFAu0kMhUJhs65CiBPv6xlZ8jocAFTp5pWa8vMJvKs6VH7XBVdUH7dRqnH4ZTgwDLTpFcTNSZOoG0jaTtmkDBEhSQ69jgsbz7Ku27DOggujzs2346A/r6cXL33xq4OWfO847WEY/Ak3ST5mLQKqsLDWp8IaBIy7pWAY+6246tzHottqFusS1SbqcR8v2dqZs4dTId6dR0EUuDRXdF20pSWfrsW8DIVZOjo0XpgY7zlF1U7wzwKCcbX5tbgoegJICo+9B97pLvk4owvZCc3KlZxj36RZF9maM1Ttj3UaiRzR8+Lz0vsKb83MG07GI7GRPZZVOTKJC8DIi8akpJB/R5YQQ/j27f+c3GYpkVxPx64OuwZkskhEVFdx/xa8+YOtJhbI5O8lgj5RiRLdW1JqUdjWsfK1oDAd0cJzkIXZWQ7eYQGmc7KXSWvqtxty37WoPT+MLsv3jSGTUDPzWCLtt/PSU0gJVMaEPRsE48KjyhXkjDy1dIXvAq9hD/1otj83mcH2jNpS3ufCG5/s7Ct10WyESMSjqr0daNURVRyqs5spprxR0N8LENbI22ABQLbF5wcqV8OxPp3KpdApP6bGoIXl5mRIT2uvr6JrtLtxSNDRb4ERQC28KWXrW5uMucTqtGwwQHKMLt7Tw9d6PvtywRvcjQFhtqSin6dxuM22R/kSxpWnRXxiE1HMzyCcDVT/EzrH9X9u6LwNeKsaQw1X8U0b0VpQfB6F7zT19HLbQ1zNjUWachAdnFwe4T4+KVABbGSNWjU+StP7tEKpCsVkJZddgKZvT3m4yauapKMUguxvv2vfX8lF4Tf7hgNsiPcP6WHsbGlYs/Nj+ypGV6zcNAIqg/selzJtaxzBw3dSu7TT9Yhy+l97x7KjAYZSMOuV/3Z8hMX3jQA3TyhcXPrZJASFIDDLqKvun0hOS2MzVbp1SwS/GPtrd+ib1kXfpPmvLFJtcfs9ryxXcwhxv9v02w0TLV3Qhg0G523eyqR+pz7ok3exkjaidrADFfSIZ6ESg/L3vCXjXKcvp6pA4j6gAh4MOBMBdWod21RLKzv8O+X0MgljV+ZY1ta0s7L4jRLbZuVww2LG77Sf7OYJhWv2GlWhLtTW3Xrr2KuHCYyp/CjT4xEFBA5qMiHtp4VGuPWAvdrSrBX9SuO5wL8/Ufu2SuBbqd8McO3fTCGFsDDH/OcVEZCw3WSznlyHg9VybW1rTSMu3pVpG7moz+vRhOTEr9L9uYm4w2XFYYKHxncVU1tICGmR0HvQ1eTNqYTPnJSGQHrSTqkwEY21EkufjDbSPLkZZxFiBxykt8j/RpeeisqDjA7XMy7EQpfSs2+QnCQL0zJNTU9613XSbVyWVts1ugoP+JtwMxrBKEDlDWkLJX3Yp3KEdfVF9MKXREsFcpOAQtCk7jg1b2hmgdx1CWbaZvUNaW5fq5fpt73KUjddHMoLirBZqAlCgr8ONWopSKFR967ARA6b0GvFU/G1cKROREwmyqShvUE1D/KJPMPviodFRYXvynD0g0fSg+AyYDvrfpd1UAZ2oqQM7YFtbyn+XoaiKGQE4mcTojua7hckqKOk7t51gmOHzQbunUix+BcrCWADHw9fJwJyE9bkURExgVtLauLr6O0uN+3YI/6gEDC+53josgdUKYBkTrOPWDPe4s3X9kN6WPpRPdRG9T0I4kMODGNn6Orc/nuDCENOoc5AuHdUIqs6rZAYviGGuPUnA80zSSVU6o/23HhU38W11O64RLSovn9EObj0jRsdhWfc72sRyeZEGxZnekezT0WTsa3smD6Hb1nK1x2KdJl24OT2AImSsrrr+/rjZcUCmAKZAzNmpwOk2vyjx0qs4nKW3oBLXutlxZALzdSIuCRi2gqEhKME0H4gMJ1PP1FAFsG+julOWsadhKAapJ30+W2aVQmNCCIL9o9gSk7KXApgxaKXx+HUNoaUrWUcBn24+QfdQkZaWz2uEBDrotzacWb7EOi1g0DAFVtoibr8Urjot1jK6qLIY7q8nPNsUGMGWz8L4ItqvESUDh99uZAJaFLJqqOsAhTzp3h15sATtno/UUP49yTluZLbRtMihhBsBqvYFt363SbTcIsorC8KB1qWUfdecHQU2jkAyYWbeTWkohPnnHCXPY+eK4oQsEofs7yE8B39KzgVinE2pNwtorTdobtCvjp59Cl+un2ZzshUC/nQ5XrNkIoQ5m6wh10UGUme+mz+H/tEzkZPh/lLHxjDROZpb+Xj2ZiUH7gzkl0xF/VoF/ibJHWPwKwz2kBT5e6SOJnuV32R1l480H8mcRRPwWRMweNxMlEZ60IQZE/rzzM7ax9vemj7CgdveOqnQuEu2dtKQ0rKJa0Udphdl+th5nuXn5kp46Vj8BtaPp5Aj5GvGc+iVT75F2ZZn3HW8MKCYN7IoJBWNksgIFe44X6TEooewA0rcGe2rDWNxtVrXzI6s4qiwFo4Ajp5jRo1uP6zavaWCkZ7o9yrVcHljKzYAyFg0+wsBrfUjIWMrs83gOBFHPsiTL8uneF0GIi6AkD5eNOy0NaS+/tieJ5iGZU6DH6oJwi2pW73IONAkW6YpW26FAUGRpPrUjQgutLIqIAhzqjSiIZaSqNoim6tv8j5w5IBrlcDddbjm1LPlQf0HdWFsq2X72uK0dOYBw2SSp1M8ae09FbNhBfqnMxqqLtbPtXV/P84IaXrrDi2Q4t4rRgCdpMyuDVcIIzsVXVTOyS4/ijejNloHLxwJUlG2k2YwH6RqKADhNYCHVk8wT4OU8gZ7jdFkln5athGQn51Z6dulIYxMts//dhtP+y4e9+qBqmcy1GyXNq8gYGi6tkXrH3xspeg295BnNh2ZrByt0wJNBAHGG3P3/AyedmRE7KKyyUlsk1jsMrDSfUXc4YHuX/G2ZO62U0QSz4owh3q9su2jqRUbtBe0PjVFYg76symQjDOd5I4UZYc0GUDtS2CoB2QgY2BacJHk9lFbpZ1tkJ8Or5kZqvZjYHo2PrAqQj620zU81zIHn8itZ18QL7sBuzQ8Qzm12myJsWmfLedK/AXk+rzU8JoWmYTXgItPdBk47qrKrx4gXEGbUNx0QaLAWhfkP9/iCgyWDaq59059qN4rD2/780qj9EIiLbE31lqLa6Jd+AdvuEUiwRLro/fgwZ8yehKz5Yl/DO2nFEmBfAFs3V0rNuepqJo5QOXwzePYaF1UJkyc0xuKXzidfREwBhoNrTYHoaMnYDZ0fJxTUBEKHGTFAYX9kUZc92V49V4DJ19lXVt+p7Nnl3SwmT3nBi06SS3OIgxlmVQgSVfWIWkPbxqeERaq8SsFiW4R4pemTbNNqYw5sK/H5fvb31G0FV8nRZau8IpW6ZEW631aT2bIVsCglg621WHQODXaHRpWRIzaal/xSZs5R6r0Sxl6dq3c5D02HUVUk3TGQG4fQEG89ZOoyGzYdlAvbQcBN36cnJ0FQf9PO2LfpBOpfTR3VMxmwTf01pujvMjUtw8uJBLeUAVF8K3eZnooTRSsxCejT9Cx52BIJiyL0axIdiamsQYVsj4Gi+pUOAKj1AtqWzakDsaVlqTHa0FyHSA+62x2M0dMk6a+Vna1fSR/lBB0oBmazUdVqyQdoLvTgtA7tUo99fJLPZTV4DSBs6om0sslFZleVuYDwonVRJ7r4dYtCiVVejMmb6cXcZoUFTi19G1/0p4Y6SNQ5AEnnq31ZqOglFHkU0oigvlIURI02aEZ4E2tfagIqotRzCKz5Cv5te14XFyrTUkZdikC6wAw+OtEWysTOM9GZYGS/x+YGvmDUTT7Ur5KoUKcXKZrjbKDjfNge1QdCAYm23qULsoKQ6iuz9rZSnMyKS/vk8wN9LoCU3SohXP1bRNImN8+QKccA8bRasuCHUXK3zYJqBx1h46KxbQHLGmrTbzKG7iqHzphouuqaWxMAMzqOIQtogjxJ6Gps55mcC3nrmSIdYTJYZJWKAatNH1zoWqZdclKf+apzxi1koDLFXJo5ivesyqzsrIHQswbKZ3Omsapy6wrpkDx0fgGaXulndqXJQdcsT7Tz7w4wL+2IjpKfltONaPoDK7OUf5MGrecndIELeaS2+NxM7ndredJJIdYK51bgdmjZ5V6W8L9eZsZRMwENAa47GPKAOLQ/4UFcZ3jRN9Jm2VPJ20vd0skI6EIiQW63lxF97siUNou3DAISa60EmEi4PVIG5vw4/TaKZ6y6tLRtXBR7AcsKEKzOMqe4IptRFJH7EcqA+umb+6o34rJUIZQIZq5Li3p3UNnPGKKDE1hL/wz7Aqtqatfpmuqozd6STtKr8qDkjL6rgvjBXQPEQbKKfOB4DIes4sJn19+9cFDJqielGyYX7wI6R2dVB7tqDAAncrIX6a3GUvPI7VTkEIZxwDPU5DwVQZHK0eH8ijYbSEr8lr2W0KY7iNVxjGMxeaKz4UZeqKRkWk2VA1JR/xJsdrnbjR9GmNbHFX9IR9iOzAjgGMXgcyuS0eQVNP7hAUcLsP90W9wDoHYeCxhAb4ELT1QH2BQ4QXhTiiD4A4GDbecsR9hWaHJA85GACoh/Mm7KQeDgtZvmA6LBXWHQ5FDYsmUK2b3xpEMBhgeR9g4NVYhYhufgx8hb75mj2go/0W1oESkpkqlc0AyrZFg53R1Xc9FkQYdgOoiADpJhUupBY9Mu49liK4A6vX3Uv5uiKAEwcCcA5mz+bRVaLrbTR11VUwE6eNiM6R/5nKMzQ+qBZbysUAjfqZNlrwJoDoegm6kDWEwwAnjhDiXB6KOyub73BBoP6qz/1gtBUAdSXWpR1ryCF+O66YCm++j4NJ4QvUumG/GyU2kWzSvQFU4TeEx71ZmyTSnq6cYdsq4KJHpsoI8KRne+9HJXQFmG9augkEPhkAOyBfFCZySwTfI+NH53lm5fos2CsNVH2HRAJcVGds5ZhyxtbAEPqGMAv3yj71U2rND39eUGiI3/Ucq8no+WJd+kjNAM2wIB8t0qEfKxClQXL0af65/dmAyOny2N7gK8O6sGTNW3ONgCJbhgqrsRJlATXlYWmsFrdGER3gINw5HWFFRFIrRuGIqw6q+kcE0GM9gQB1HWK0Qqi1Z2HT3UevzQH0FSwB0R6o+eJI1nsSJejiFK4wP8PMUXGIlLr3ZD7X9TmXcrTWLSEVQfidSd9BR3rXvesku6ryhDFrubhaUG2Q6r9IZX8Uo/HFQS8FLxFiyQJvJq+yzqgpPqs8rFee4x9wutkp05lSZE64PG4o5WfzfPRaRAweiv3kP2Y8apV70I56obcDvMVAW8Han0yFQhCe7F5+pjZ7WNz/5S0FW8YsKuxWbmnFyIvSbI6KGZGGo3b7wsifqNASVkx/zbAzzaXiDVTmpqi0DYFR1m0c3WNR+fmZV0VDuxfp9+mEs0j3WfAfWd8qyAswMvYEzigOGGhAvdHbDUsTLdpA2i9dDk1etSaCPrf9pWTdaV7DVNNcnUlp3CrOywNIsWQn7bc2i8so3s9tXx5PdQA6qJtPmb3YbwUurkB/M0BMpGmomhXSwt7XCSsU70gxaai5BoPrivWeygP9oNym2MvO2dDeszatiqJ4fGQb3qMYXRQF0KVTAlf1ZmuVbI21saobYSqKnngQsh1JDDuaOGZG98pfg5lrOJnlcoICcohTOo0EwKJOVOZOXEKZIbOVQOjjYslZviIl/iZxZRw0S+6AUuQlSKSmMQedlUyS4qwiNXuCq2ORRQudyY2L4iOJWFS16LQeQX+yUQ1n9YXfGbmmZ3AFZPtIhG7/IzB6lWSdJvelcE1EpTExtiHVsrENSzscUzva3EhmX9gqBY3+nmNX+XelOA7tkIMm1Fd/QaAQfP7C2PysobFdYHM9ZRuQKrBs9tH/NitolufUiH0Js6Gm4IUgwSCAAheYf4l4jt5MR2drKa1pEEYs6LtS7QOguVFaMD4v3RLjwu+hrVt7GU7fKEuK7OcZzNa/54FcOdW1cxYHzrdwmsEdB++GxXJHyBdLx7VF9h0wHNRcOD1XkyvdUajGm3DrYDf/Hip9YHSdQdRgUaeZ6Kxta4bJ91Zge5F3qvChuxjhyN5qrvEHCILXU08C/bHt6+yWo25gVqjUxhtBxSaCeqaInoK2u7JriR4b312gZziOLveYonZKpOsjQ5X1YKOe7Wv9zowYK69bsWZScGyw2JdSxvZ4N2Hksla2UT2sKpa75rUNF4rmYMcHvn1yVm5GaLm8doo7cxmv4Sj7DCiK0/rWGp9yN1lsZ6rRb/cfs8+6dvID/Zr7CmK0ecahmKKj1FajPdHOOmEIYA2ssPA5KqGUmQVq5h6Z5HYC6/ZAqRLKlUphdGTzkRhhh0JtqKUaEAAugDYSo+nRPa8rcZfr2/zVuiHQeVhju7wvnuVYwWaXMqyjADHbQEfKsezAln9UuJyjDbl63PtViG/LBnUGAtoFvPpxlk05f9XypQyZawzXhV1/BqFGhdIAGKUsDRr5/ZvKZRL7r4Ko2t5KDtYuvvsr9mPI2PgZyAtP4vjccI9U9mhustg80auC90SwNXZp8KzCSvsDMIoHcU5GWzJAD0qmq2YdkJ5y1buGpji8VrLDFGzZUnMamDLGlgK08UEIb137oGePnn0hkkYMdBmz5tDzJrSh/iyno250cVie1vP5xGSUm1s56h82k3sVoYTYpVd5bdcUyhdnrclG0HROJbGiYo2AaRVnyYZ+P9nI1t7BMMxvbAV5U1o0185DOkzz7nmRWapSAf63+SYGXesLM+pKPNrBU4Z+tWoOxz2u/Cy75C3Bcjgn25i6x+wj7m7aEQH3newZK3zhGZCZwbi8SDapir+9tfEV/Ih0VYf0MMlheFtqVLh6zaIT1L9bftKCOZUZf6UGei+ST9kFytLfS6DRpRSg9SbTBBV2XVMQrUOw89mh+ubIme4pAeIHFi95of4/xj0pHuDAY/C1Tov0gfBLHEdrzo6swyftc0AKkT6KL4xaAgwRu4BGKBjYHMEAjCus2q+mlXvCLxiaI52GKrfLZF6N/mw/7TilZ/Z4iu9XePUQpVi9AITC8Yu2UfLajqexrDOJ6geicJlZGDjtzbR+oOEs6Va+V6dOlz28bIfhQYdR+W1JAjMlLKKq1vUC51QU2vKzUD4IK/QGdOVsEJb5T8muaIevial06Nj3pSFJYuic/V7PDFdQmsa0TMKQp4q9/6HdSTmr/S2VbV7xpby9jH21S0WyOWOkZsq37LPoDU4TgUEacgVoDTgFbMEL9DMms96sJabI+bSsv2SGeYPqit2TrcarMAEXJc5khNBu1wov9mbwnxja9zkdx6qvY9aEuWYZhVLvSxfrJ3wwCyA64pCKdxs4ll/w7A6fIwLFn4w0TGUYVTR90HfQ9ZZr6oKxUbvahV8uWIapJezoxthsky94DMI9Vdro3nWbQS5ykfmWoZX04gDtJMPvZCcHbKyaQtY3XeVWAgLC86NXGSVX2eAZzSpv5D45W9a/Fy6TqMtwU8DVk1XvKT9ATqLIuiO2txrbWxXp913DqvvYm+8wqJmVPOHRZctNABV1DynkLpiSPjLW2hqcHyobNxQJlUijYpgxqmI7OIYTNIY5IYLADseEplvE2jZe4t4A3pAu2gAR5tmOqDWTkVr2jmilMhP39fdE5mg8LgZpPmNfm9kO5ivPyshMkvCbwALLqFQC6KBoLGi6e6RWeoEFsEXB6byCDRcnRvkSXYiFjlcP5USZpLHshuFiEWXi4gddBX4IkGHmdR00Wnki/StRlG8yvPkJN3gGIvfTkP+ZACX7JbAaKqKcYoRdz10WxnKJPeMgnYiYAE4qp/uAcUCMHKktWErZQiOZnsh3yl9+EOGeMjCPLYFvURrUZE91Onolm8tjhV84Mqj5vdbhfPuGm6ll+U+DOzDvQhLC/CVA0AbZEtcd625NWZgKlDJRjU70teoqYQkPLfvY24SsqsAgekyCpx0k5ciaOxZwiPKF8OtuHexILMXJl+jUNyyX5Gyp3GUdrBjJqGYFWh6D1vDeg9UjAp4wmTc/ZY+WG1veRiVUhV5PgOMYC41PhCHswwbTCcWrppiRPpgmtP9HjcHoVL/Iv+op2i84EX1mzY68SA463eGexURRmYNi1AHSh/FAGM0dNTO8CLvkmsYNXYcEP0BtCX9dhw0boo2ugrLzRM+otls11hSBqtqtSsLOwnOq7P1Sb5ZkCcaKx3Vp5yzkp7KjIlyHv0Yc4lODAkMA506bAajdyYcBFmL2IE2v7pGijqMAoXhTVGzi6mRuciCC+xET1bKUg9wbO3EFKQnfl2yWXuBlTOhyvIs8bH7EYgIuYXxby9OFLgutoSsquLammJbTJooSBDiqAF74Fe/cxDPQLKFocZdwZWBjIg3q0vV4/rEhDKPwUoUqbENu5GQW7r8JpLPRI1x5VVuRkG+MEKA2rRJ+CZURhieLlxlI6p4GG8XmV79A6IkovMbimwfJHu7SbPDbyzdEGGXkEcgyXxAhR5yLFou6CB3raFiYBsuxE8sxUPCNryCLlXiBqH6pPW1QZD9I6WCx5z5GvahOOhboymU7Zjb3CAxODU4zp/IPVftgsDr9K/KLpLNi0LsiOkw6ufRFaFZQj4UyqZBaqB0jdfkyIqAgwQtKtFyQsZEa0rqny1o2JfXVQJ+iKTS4jnQ3qEuiq6HXEHmtx2h/rdXUWRFl22zu07r2kGeD+CZ9QUGYe4JQylt+rP+M1BES/boVX7NW5kNrZQfvy8+lYAS3knkNqny6kfDooYVB0E+njTbdFFbs48h110GwGdETS4Ha6xCpQjeUp+KOGh/yMHq34cQ99PTHHZ9au0sey+MckzL1aQe9tldMZflcN9qkJNt/+pigKxbqez2amaT+ndiS1ufppRXmYbuQaW+puMZ6ak7I+LGBy5CH6jQaVLLiz7R1coYOW30raZE2MMzMlydpW82H/zvK2ljE/zutEDjkwttuLWPY10hFaq2uyMjaU6i4FjBBB1zIzS5x6f4Jb9K+0yyaD45hG29Y2BNScWrroGRszaRqJRv8uamxHGgHZbUEljrZjGuW8jRELTBaPKWeQE5ziDJ0BGa4ghLbayPTwShgItAXfXyDS2FTQ0z233oLGuVDsIHrLWsjVJwDJeUsRGQmDFySPX/RWbduy+70duZG9LadkIvKRvNkb0VxqnnHxIj9mzpk7AsmH1W7ze9p3banKFrGnyaGPrdQnKRMyLIXrrb1pFZal9OxTymXpF5yFm71UVG8n6mqvL6Wyo5dHy6CpeGr9bl2DBQSa6Ijexl6yLVm7iklJoGrH6CMJZCrS3kvYGnC0L9pmjKy6zaN5Mv9nQfKTOua0Ay1GEVVUlU75bNuIRiGfg5si2ioCSn2j5mNOn7hDafJqIiddleklHRPxlYuL2TfcqjJdROz5eMKHOvb/PAzh23quqjAADDAUEtMH6a4oY0mW8LR4K68J7qebJk9LmvmQO2BJELP5OogoTXDOikL+UiMxG0b5GumGBwDAebQkxZd483n5KmKQGvSK1jZifs4Eu24zlyOvghKCQy0D3pL/Bpo2UOMQyzwWHw5ROvfb8NI2zRdhAk2WgWSBE5UwxxEpLiigbCIPvqIcCVrLGzzQoATy9gxROBnmQr8tgdDSv/iNydlaVAi3Dy+aRR8x2Bvdu5IsOmozHjOl9zayTrSDl9/vIe+EgQZjGvfcnZ2n967zvaL5xSyS/kIIX2CxQlHY1L1CaJxCCpjEWEFn2zIBmw7voZynLAiM+I3ZSf8DnOdSw8UXzNIG+wKVjflbE2p9GMz87GyUDdasiULf27XSTj+14Q/o9dRy36T3QPp4OcVIHOI1GOdZ6GK3Uh5zIC6iXiXUsaUAzkLP7URKQbZd+EU8TtpbhlKVJxr3vneMNgZ/7gz5FknjSKkmb7sV7dC6N/YH9X2HA5a4Q6ZX9a2swsuTJnSkcB+nd/LN0sOzYdHSNfXUQrN6haZ9Jua0EKRVAjLZp6qKuODRjN+euoVEWYLBQ4g25MVUm6HRWZY1KbWyivhMHyg73hLJ5zmnbpcctOI/r9NPgLrrW1wPvPNThOzw0TLdilW4Kz6nOnUUX6NPntzhoG3HJqxqn7QAJBEZfOi4lHIPcmGQeOpg1lDMdoB3TfpRGFFN66osjyg7Q+mYO8Yc+lRWBRi8TRLLaZMrZ30JWI7C2RogHvO1p4VJn8yRe5a2osjNCi/DGhYIh0HsqZfwX+kBmRmeSAY/W0MpMVhsDO9VMPasol4YWu7P2/sUfZfYLFL/0jITSGV6GDqijQ9EGkrDMlKU5WkHtqMg20BVlUrpU0N2ytBMiiw4e20mpJpp3aaOTIVJRU7qLaPyfdJ6XlZqiJUvu2/VzeoZ6gdYP6ZM5VAHaflt2T7N12Vvz4Oxq2nXPfIc6AdjiuOzjX0FQom7UGOrz5dCGAaUZDAHPZUH6BBwFO7N/N8TZxsadEH4ZzwbwjdSA8UoaIxAh8JHDpiatkRIu77xo87jQH+mLjUd6g3ICHFdYXyZwMRoX4+g3dLOloZbaKdvyoEGwWvTvKtd0oMatv2PpCiyA6sE3eCKdr+sZv1OjHRO2f+WCd8Z30ZAf8cG5+lzvtIT8wjA1WPPukdOw2IzGDLditq5KBp+FEjbxC9imJ9sZ93VYq4GSxoUOL/YEuPpVzlQsSJNrYw+DUbFKv5jeJLEWZBa+ej9sXzCQdusdbbJDTB4XbEmGxE06mKH3dxKQEp49CNiSn+jAQzhT/cycSEzxNURCkAOGIaEuNyxHjd0j3heMpGWTPj1CXngJphRw3S5vmKQSGw2VTGQ2wc5zihYZCKwsKcZChr4a7bPaeUziilKjGZpmWJxcat0T/cx6OtwGsokpX9m3j3kmJ6MxBZb+BMBzAsIbg/HGhPCV5ydgTgzWsP16xlKx9ht0diwNkowskGiDUEm11MTl0NluCLwudxfoTwFk9P7yvUzTAVqS3rxweujSqfGRACQ8SXW/6ykfMKfG0qACEgZHrTnmsC6qERxbhvb+K5pP9N5oIu1MaH7zTDHu1Qvxbduu1Wi43YSIy6pZ9Pbj5HCbf8tOdlCDfa/rjM+wNLczatRY2/mabmS3l8Up2hR1TdmbTlEr7roZVBK1Dlcyh2qyikxVKnyao6Me/lnYUf2TfjLJVLuVBT12OUdKYXRlkQdt0gF6wNYXeBFMDTgIqhy+6dNuDWSnaSJtvj4hzs3S57T/URd7UYRVJKkzUbJkH9UOcYV/D5lNaq1PpPIoSCPa99XIwi6ZWbaT566ylGfqip1eXhihUrOMuu3Aq3Cux4tlxV9WgqsvbiHWgYovrC/K4qweaLrq8h/p6EPgC/c3wAlIc7wJaBvmBkaRSEX8xPCubqv8sGF+dBI7VhA052zMbUrboTOZhOnEPINBDs+nUEXF8NpUCz39Qr1IZM7GRtqzKS5FuuQ1i74pXc1mSunLGuspN0tsZVljJEN2QpODll1ZxJXcFBFtANizEGQJtP5P/VlWKMdehjKTZ8BXf0FwzKKzDChiJw4cgw/SHLsfOp5WXXCFjHLY0eAvZToCn3tywu3dA65jzS1FZC/uoldSd6u91u82GPJfcvV3U1y1YRVfzwZSo1/pWK6daCZ0EMYOjPzVciVXbEm52c2e1I/m8JvusL/XMoL20pm4SPMrr5ORUZRmDDQujlGdcNIoba60gLLWRWiNgMrKXVqL4vGmJ4HKxktm6AwUWAuLutzuL8m1QECba0uhl6KTjp5VHv4eoUVipC2yQRmj9k6jbIUkunJYIJ0Ik1c9kXpzLyhN8s/1p/jMoMR0A60G62fTAZ+i4fj81Q6O+yiDclaGQz2NAtlg1hhA+0dWcepFmyH+6Ox5o/2FA5jYd8mCIlHUIRDm+NqJ7w+0dBY7UuRQ11LPtwCa/O4P/re1OUumGqoNJTORg4oT0hGMWkBMBxitG5lRayLWO36oFGVJ/M6ZOlts0D4c6oIHmwVNQHrs+Cb2s5QvZ0x6AVNsBIDntwfeeHqlATdWrsRGQZTo5dz7IkBWYcqkzB5b2gslrOV9u4hfdqD7KlJ/b0lpmKexpCqoq+aa3Xw7o2pbSI6F45srawgcYLWgedJIJQhV8Nm6Mi66bkdUpGnOXk5CGgkaHX9SbBhyUIt59kxERXNdzvAtUqwsLAYcIEIMDh5uDCUq2ooGRsZTid0y6j9kCLlRzOsKRAlZUR06MgMQYyzfMIAvPA28c8fboKjARpdC3+zTvKiM5C0Pj6GTyPYN9cJ6jkGQTj5rmQSNRf/rkp6mdCJMQamnNSbXmOxfRCOVnLRRFltWaeMTW9NijcS2p0kHg5jiFtFJ2XJqhkIO69eUM2fIUab0KuktwKNjZUjkjYKuqKpU2JbJNlqQwuKvxQbNS9M1BYuX1RaOgz8le82t1+86GdLAgEE173/XAUp0pi28tvNLJ5cWAFHXmNVzsVa9twWkqoAwA6m+5cCwy1lMCzk2HwoAA+uiuTJHHryV1N2NqUuWWeVwcTXJbvNGxQWdQqpmTHBh2GlBQ3tsuFkbHTsWfb2pi203VXRxkOlxZ8KFiy6nwB4gU6frd02l2AOBxgbhJbPxUYGlqixF/Uyd2+A2Tm/BokpjifziXkHi/5SV92eBVDWjHSbHGKqAIc120fzMYuBxJL52PvDGMyDO5zoCww/zqnFyMpD65A2VjvhkGMfE4IyBx6aXokMPts6XymnNBjF4jPajIFP4a/oM5loLAPJgx/cXAoT6ZbGJ5ytcbAWkXpkM7M0lE80X0pgB8OYpzSEyK1EUBSuRpx2tWBCkVZAJvyaRhC0yRjMJo1b6ZvVHw8maTmbmX79LQZq5m+0mn/XStDtDanGDZ6GOCaeFpCiutVeDiRPw5tOBn/raCTiNFXWPWIdSHFmRY+x4BIDzhyqTaRcC6Vn/I1Atu7LsXCzNNkgtZux3UiPs71TlMMvtIlGITpcxHZ8cAoE+Xdb12V4fJCZUFmhjXg9XgBRt79EZy4oVko9aRpAVSMbWk+/9XeSz/BgtT2Z3wFYCneiSaOtT6xtBNLED3xpXT1FoRXPA6PPpHjs8JFaJURm2+NmqlsZnGvS0GAquG0YT82/ZLJ8X/60B/joMCWr87lR6zrNeihWM8G+nXbZqQK4Ew3ZDqETpQA0C2K4v7u+j5wLMMUPy0ktKBkb79Agd0IImf1kK+yu74gJijkOLkflpBfh0ttJfYyvH4icL6uAt8pU0m25tMnIcojyD1lm/87PoV1klZbWMB4KJQCU8xnMx1vCdzhkpW4zCCS5QvOQTZTrAknrr1qrW5baOp92y2XW9NxE4jjM+/fSEz9+ecOLNdjTWqAAeQThBYmtefFQAx+BoZVf6rH0ItGA9CWDC11AVZvUz4cEsMTfEUVowMWlVJhAV7FPPWMHMKv2Xn9sAIcgXwzsk2t+6UUBGFCYzRGCwdOCRpZjfmgVGQxsvqWzC1JCSVnFsT0gFgizdN1MXsJnzQWCWgZCGBMECUiDI2DnQak9ttyA1nypeZmd4NbEm/wwguUq6xr2mHboqAACnAzjfAv/1Vx4B1wfmCODItQtgRG/tIrAk5UJvyd/If0nX7hqHxqMxmTzIWxFeChXDACxcTajIIZZRflYTKaVsmZgqiE9bSsd1JwqJG2jS0ogsq+qlElYK1Dgqays6ps3pyymwiJSBbZeEmjF3krSbntsjdQpQuUreTnJjObi3RnYJjnQnFjhNmqmlu5mJPDfoiWdy9hfo5MBIV8y23DlaO4HKiCUnMdneNzxgQIWQI+6DThp0SVBpb4MZgV0YQ+Yaj4DdgSuAuRhDvT6ygb+/TagiSJ01292zKnPcyObPBW/9X8m3grDl0EjF1DOBxhhbniFa6XT9GuvuZj3DRKbHFsIm4zo0QFNnDycyoR08Cgiypxd8moM4I/3xDInBwrTfk/pimpaxcFH21Hq5koVo0ukL5tLVxgnyqTAfQPiQjSUt3mweMYlCAAfw42+/hPvZR2D3dm3qbuM+uc5Z8eU0268sOjp45jqL4ja9WDnMQTcrlIyw30G8boBMk430Qouzh9lqCH+zFQY9x8ixFZ6TeIc72YUxVTZJ+YT5HGDowAMdapDKZtqxFGsllK14ciFJWEnQnBag+WlGqGSuBlED08K/YQMIdORdEScSta6oB+WRf7fdQD8JpAFFX0TxXv1PBR5SckXqmhczzEvgr3/hCizBBG+lOgJ5oPsi13RdsI2PNEf0AisA+9xhW4mNUIqvA3Eye3sS5ZtLnUfhaButhIacvbK4upbTbZBdRq4taOZgCIoKkARiyn/3LEJGmxB7hI3RxCX0PiYzDFd+Bzd2Ggr9N11NqH+QPwRC8RiIOdsIqWsztn38y1ZQ16CukjQDlYWnPQaySMZvdUOZ1ehqAPnil81sv9BsDWiIgpZM9GJVBr+U13YeAX+vwUgBAnQIFHCaTGTb1Nfq1Iura8zljYI8waa3S6U7x1nVR06JsFKzZMCDrRRQHLEJWEBo60BEQ5HYAWArh/mbhjo6rNn6pqKDZfnKqKr0uxyMyYs7wtieOYVLzJLdjJaxboqkvNU3dasD6GEr46kX2a+DizkPpNrydRBSAzQPsmw+rE/xDGW/aN62cMVI80PN+03N1DlqESL2HW6BtXd/XOHH3nqsBYAjRm29s/eZNBVWJn9Hl/T3RdDZC3yDmMfbd76OmZByC8CI+5qipK4VM3TGzfSWTBfq30gehJeivWkN+ZHc5NABWx9s1j/0mynDh/TxVPQjFDUFlJnwwBiapQDdG16N6aCQaMDvac4UwZ15lVJ5PcoMUPBg3zETiK1vtmxMmNMMPGVgHbWFFDRblqa03mFqwGuVMeQTViwQwPXAX3rjCnd3idMoAD2APHKdh33EOsSHC6Q2ui9LeIYMKOcS0ItBJS5MXWsYmYmKScBYWenIVqSIrIC/XEz9TlaPAug29paz1hPMtR5jGtczzF3zuYRolfNHGBD0N6KbyhtV/UFnGX4SoJ8mGCXDDg5RfM7WgbTZEVkVbJzFC4KvVKfoO6uzZsyZ414HVFFogS4PC3DLOawx8OiZNV5ZhmGYdIHrRqgQqUZ33rYy9iMRCpbCnybKAWLAAh60ypOHdDqgeCinLPCLnbQWUfPJbZz8rwNyqCOlZIt/mX1gD/G03ssZzTuAaN0BaLXdRMN++oRRyqc9UFe9hFmXpWU0HBDjXF7hGJHWtgU8a0VqNK0AfNeS8NPhXV8Hvl6g0FhcGOe6T1xHI0fYuxpzMbuxF9bHqLHV+EgHeRJt32TG/nfppQDCqgshNCt/4Z0vvY6BWswIHAN4eneFH/nSS8AxV5nfdEiLm6vtVq3W/x4bF39fYF3RKl7IPaUtIO6WyDsk6ryNtkP6msWGmp6UvMM5uv6P9weANETniuikwFJ8scoGdvlBPaPbesRxIHpruQypSW9gkKo4Ou7hmWcG2wEGAejSySzg34ykBaVgQodcmPGIjpLIbNDlgLhfNaJpWOUd3idQY2M0ZAqiH2bv6K74b5t8x7wTgfFS4JNfucGPvjEwToEHxHL8p7EqAIeNVTVE48EGKKGxx9z7pEG5Y4t6lzsi6EClWNs4CcY9z0RwVRiSFHGao0xoDjFtoTeyMlaInpxY28TIr3RVb/9BetIkuN5P5JnldQZv5chKt/YrbkPv8VAd6q0HU8QihSo2nj7fvHQ5Q4fnXCpB8rwRLB2dc5oTWCQNTklUf1E6tuorVYwkreJJ6ECi5hvfN0C180UCbdK0L8nhnEZTis/7iq7mFahDGYizBf0T4o0O+fEMSw4NZrMNUK1KXXlb4wt5hV60V6PhgjAs4KSh7DhQ64YsSFKQIkhJvc990YHo6RKyq/gvYcAwQWtHmu9IrEzN+V2L6xapK4CVeqrkJoW3IJNyDFtpvnRhbue99+/poKSxRlf2klWobPslFsxuI89ta1G47Nm4krVsWrX4s/rgYkwxdKJu8Wv8kNwoc5nl6tBXxtuXS76ViM8ErsYd/uaXb/ATTx/hdExMrpC0AKUFS/7sU0v7jo22MWKmnkzDMNRJf2N/kdMfq/eAEmfynlJTMNIVqRZr8VEVMg2+CaxfhvklVh9Xz207ZHY3n00Xf6jESO0mktMTQ0gc3GFflACd3wSujepmdi9SakIbwC5KWnUGP8GGyryVPFEOLVK09wpkOo8eqMpO2787qDgo1ENoCHcHSnmuMR8j8HAL/PG/f2jlchwreo0D2JCCWmXG2lmLg2eq7848Wi6tuNItvWUqaRZNm/RMsCsgS4cM5fzEOtqzyu98j864e+W4erEd+6YcmlY3snWNgUlAq9LNGZFQXGZDMMdS4xLgsK1sOVxE0PuuiBRd/FsZBPlg/wOA4EUvXHnEHQRGj8ZeVIsfAHQJk+QHqYP2VRdP1KmCo+Y5yK+0M+SN306zAJprK9Dzg/3cDuKb/dYYxAM6jGibdQc1WDEgKNfzKT3wrLx4oWCLgBibXJDkqVygeL7jStOembX3KWwNCVrnbfXYSiaaJ90TBRVam9OXlqGwyrCP+GK835wmbPwbVLjCAOE83f2YxjyK/6rysS2zJyO0trI2t9yXNj3dadS6JvEGqIV3PtZ6m1WJLZFriTgELpoKx8eS0VpHtQb1EAMYwB9+4zU8j4E4Vb8DFSQYvzXobFxw/0YQyuJ8YWGPuyuV9DmbS2ebcgQOacWnpsKwynHnQkOJW3TMI/pUQRpf6bqSvBG622DhNzPGsH73/hI7r0afjlZgk+iSrjqqf7dIQrNzYs2WqWTsA2cWoqoAPRfRpQfG+ZJARcFRmzrcCiUUAw6CC/hY2sM2ty1fu8arCM0Y3lMDoSYmjZ5rExh4JICrgT/ymVfx5XcCp6PePwFxCsQp9vksoXspDLodVTEEwEnWg8GYBFzzpDMru5TiWSYstpViMkNjeVtb+PYgrBGGk5GUcJ8L1sAYeo2aAY4hmVkE+mSS1VKrJOXhTbVerDiismbtfYX0gaU/VdhKNsEFocUD8rVGLgNpnawunfekhgAq3eC2Jp4ytuwnCnhWRri8CgEmcmodzKiOtPWzgqV14E3Z1ayy98yVVaGdNCtEHVvOlskFqCggoz5vYubCnPVZT9uVDI2PK4OPdqSlifIZmaJHIJoG8kmxNjDJIQWB2G0i8fV2b7Ts2rbdaXXm2tNsAmj4z9Lkkd1E05w6v92xA0Yb7WgtDksdCtROE7bLJDcbS8MANV2fyaQG1L/GGujAyQBtNWUWxXcIU9rNgKpOGY6RZgfIzT7QMoA/m9JVktMLjrPf4TREYi/TixPuXGssTJ6qInt9mnjz2Q3+xBuvIU4T53FqO6eTlOxDbbVxolRl9TRirR/oFf/lLbTFrzGeFQKvxjWUu6tHG6QHJJvD7fGrdk0ZoMld/m1uvOpjyYceVpUXgRjDxJkVI0ioECaT3Ky7AOhIOg69MBOBpv+U87RshwyhksYLbZA4E0w/sVU9skCLoEZh5PZG9yeDINCXBbEdOezibmYqcpW9ahHPqFXB1WdpZIwBnikN4+sEcLoBPvPla/yxz7yE8dLAeQBxAvIUKxC4CvDueAoH4gMNy+JMO7iK+0pb1fhFsaaDwP5OGs82yFQCiJf81gNcwSofo/bQmwZMkGlbwLRwMWBbGlurt4AL3YbsNNph6J2imdnGqvaUrhDzlY6Dwl+zQ9oLXQYbUftszVlEc8zsnZpVItl5xuxeVRDPyMVn6kXKwSzqAji3hflRz5L5Q+pEvmZf6L9U2BfBnny7BKR2ApZ8bSAkUNZOi+K1VSmaJyn73n5e9H0cpP0hpoKQq2ay1zWsriaEfzNroeVqp8056jqDuOiCjkuKJ55pGkRE1xSOBYrijTWbDnKWJm+7SWiBc29kZ3txcwB+GzTIKvsfg1ZhY6tK4SL7ZXZf71ywPAHd2dLOsHveti6abljm0QdEAdKLbuDif2JeBxnh9IdcH6kHE0TSiiPW3P8x8DAOjBPw/W9+ED91/xKujrPJaQsn6+8OHOVmmKzt4itSeTUwWrdNv6tmaiJl9aOxBcGrugXEG3+4dA+Agt4lKxniHnzQqWsM7XCmeGUVeQ52QwurEmJNP2oqrn6GACNNa0wYjdM9n2acAUYBCI1XT5eVpmerRWAximCzHGK2bUkwpZi62nWDwaUgWH0osaHRktZBRx+SfndhIBpRBknrowzIzlYQRtM9sxprLi0S/8mPv4K7OTCuFt1xSuQVgBNWSYvAVUg5yqkQOfm5QFu8QPPUgdIc4Ho1OnACAxrLxkyJ3WArAcUUiuzcbr4UmCYwaiNwlIb79rdC1Y6wy+q4YjXAG7Ra/8xORR8zGxqtNmFYQCSfwXHkGug6zCe1oC0o7Fq4FAp6FhWc06QzkJ5K0tH8lpGmeLvNCYPiyQrmSOHYecQx29y5y3zDUzPozNL/LSuj7AwUQFtoS+adC1qgxAzNwE/XGZNzrlNpforjfgGHSn6SkQEy25g91lb26MW1DNAikMqGUXA8Wh1J6wIamhJ4bPXm9/Q710iYAQB9toD/RGh9ie8MUfHC2mW1q/1hry4RN+3AGddbc4GtT0EHBLOnKRzh9dMLBruuZt2VLVRjTBY68tIAeuyGLSW7SwdIvmjquNUZjk/EdYpYPIiAFmgH+qjfwFb6xwDGEXh7voI/8I/fgxgT5zg60bbNVcEzOnh3h38pSa3+6aWEUxIkz+iwaZySDZNv3xUR1mz6B9Hyor5HHRsoigISskuNU0oDvRW7k8PGmyy+mQZa68Rd2ulsuyRWBDC2PZ+rd1vsvEcYfVc8dgaCA4FAcZUJpzIoEkQA5SBfKKtYSUnBAfod/i9G9Ol6kkI9x0xRALQKehIKCHK5qYWMRc4LbaRUMgwpVgQPaFg+5ngc+NGfvsYf/4lHOB4dOOMAqgKQRwKjaDOOC6/pBKJZ2sFQyqkxS2uRRxkogY7BUJeWtX+e5eXB70EpLmdAGw+WFNGGvzmVLtlFGcec6Cwt0RnVLpoCU9RiJMq6xr0r4gIIj8ajA5rOIlq1IF5+HRD3bW8XC/AazG0ahOfiaz8udakFlKUvKNDv/vfnNZGQ+k9pfTZfSgaDW4lY+QB5V3mIB6Sz+4X0wBRI3QW4Pzy3RXoyXvWP7ZP6fQswm67Gr0YLIDv4zn5GwYy241Ep6p+Za/dOjZXn0TuFhAbaoxZPMchC7utIpHwwwcS2bkVjjNGL3Eyu3cKWawFY03XbVAQ4hbfzXxgrwvtfkjE0vmwbHjZe0AnldoiSXU66/u0MSG+NJk/4aQNv27CqY9tcEWblieB/PZWOtb/Fr96mfJsSw62QmfQAmIQFVvJ0APcxcHXzgD/8hdfwd568hNMpMcsOOplZmMwmOjnPYnOPhRVE2lEHAbwzZvJTYUIjYU9H9vkqsek7t9pRZ9rXkdaqbCi5WM33ttLlV4TLm9+koLJmnvZdDF6Z0dvblITZQun34KKhCFGiUmYLy89JNvXmoHksWQ2E2XIgtK/Z6WCmtWVTbhii0eZv6ZTaGkSTggq+njYXWQ30IsQappAlur3sgMqbb/TqKkfjCR3kmrSKU+D3/PXX8NazK8RRynrkCgJOiTzQFY0a0ESDhFZEi8fN6v16XoJ5tOykgJtaSI50IuZ+Nh+gxB+tTEleCdDJHGbzWfxOi4AlaK0cX/Sz19h5zECsBCTszZAjQPGLjiOw5re0gl+4XUoSjJSLTzM6W61LUJIMcH9IIDTaOvNrZrlRd3UKrV/RjzMz2WVastChIOgsk/YBDXtvkD+BiyOh0ZREOQwNiuq6OwAHYelDNvhQdu5Ay0L1705TbOfmTyUEQM+XS0kaAkq3GFQF6r6DjC144yr/F2RGYLfx9vdhjq+rO/BmOP1hYlYAVucAbL6NW2Eq69ZpiMQoo6sXna0Pp+10CdLnEiFebQYKVWC1wE+GHUY3g9syXKvEkE2ZtbbKAic5lsUh8PyAnu5sp9HJHuUGs+eyPZQ+w/jcHnsPaMswV9ATyJHr/o5InOKMrz1c49//9Hswribm4JoN0ylQDszkPa3klb0+xWnTHYux4MLzg36CVFtCK/9JG0X2+MU5vrnapO5PBp3kGXUs/DR+CbRsB+CR+Z4MyhwLX0lUFG2ddJO1Nu2I/WdgMxnzBpZhdRx+Meh6RsevVud9OEgpLR0JZS3jK4XbrvM054QuXy+eNyPm5LaebH9ZCpdU0igG8usLYYaH2HI+HbS8EG2UMXtZ2L+bCZxeCnzqZ6/xH/7YNU43iXPMVdI6AXEdiGv04ha+XeWqQPRBEeJpaK6YihtYwKpsjo4xm1+SPrCvW2AVQZSHPwqpCsHNVolLvnBQC4FeiD/QOx19W6AiAO9csgMySMeYeagvybzHSEMQvs4GeS2aKb2JbP42+Nb7NbcvTCkHig0QICMW3cZrU6PqpHQkOVsXAizXUzq+tK0XfM/8iHQy7DsAOi450NbM8Ta2k+/FKy3Myj65Depod6Pl0Tg2O2pe8mLJ1bBnvVrTH2tNZIck3S4xgSwr7EmOqTOlrZLisuO7QB0YxPdDAnEZUjeEY22IO24lSl+oA3s73H7LIIZuRws10W3mnHYCnDSlEZZ8y2675b7+txbHd+VIOyQAw8AuEdNeZ3pPNFSgDxgKjZ+8kYybsxXk1PQQkxFtl83Wk8KOrihCjHbMsQ46vhyJOAE4Je5j4HST+N/8ww/h7z17FaerCd4aKz8R6BMcAwtHA7U6/jAu1+moaJq82Fys2681abdHZrYuahfHNKwj/FDCnIJIRM7CbOLRFC7kZBv1d5qmUcdR9KLxaPNBWUzUlIt9W8al/wqfuD7pwmG00sWKjObFXFUmXIibcdWbOnHPJW2ZR+rpkPA9Kk/L4vulEgK3SNCQ0Q5O6wocxMiAOmkNUYv5du0s4E/olRR7e6DC8LBFPCU4AOcMnB4N/Ad/6zX8zZ+5xvX1gYfAWhB4ALjGWg9wwjosqMY9LhW505CtINAyamOLzIuzpOvfcopaYU7wEM02/DT5GIB1Vk9krLPE/XlT1nYAl1ph2lC6ocCO3ZlBMljQeokNRHbFUNUJbrzRIJlQ1A6ugCZQmblwDBcDB7MtZRHRICts0AhT7yy5VrCo5tthtaNNKz2nxuqBSCLrnH4PlA1ghT5FM51SQlnWNt1HUoOWziwZm0PuhY50FtkFMWNYB/6pc/E1jrLlLiQyqGtdTNGT2gLa+uwo3f/2uQ/2TFAnSLdNRVFWxed9m9Q2GslF7+jLbAda/PEgRTsHyD9LbGCsXMDfIufFfQqkqZ+sgrCdxMWaEkC7tsREVjIDugArGmc1oIYMcEDJmdJyXr3MpBKQtJJ2tJ5oIGSZ8VaOVjzhvEURMKLWS0HHlz+MgUfXEz/8ldfwH3/mPTjdPOBhHMv+iOMjFHiuf0axi7pafVaWzWmDtlkqig0iTUf0i/FaOnW5o6mdug92NbMYJZ3c1LmeVWJQGjj35zpdnFg37l70gQTmbN0zmIE1tW8drjVoS0irQTogdRIAj79dOkWDr0aHE9G4qzmWiIrGePkPWhhcIIhQ1EkQkkgctEqQHHDpuAUskII4yopB1V74u4UOwsL0d+oZZusOcgxeSnlZes4YwJF4Mq/wP/gLr+Fr5xPyGJjHyv5xFYgbIK5QC10ABR1FJ/fy6kMHOZZXuRSheL5+70jSPOZm9DL4RPGJJdHRXwqg2yB7y00xS2NOgZMWH0b0HQgM2mB/GziinJ/0DpCebPCcse03BtLPVBIoHZQh5Ww7Ehj0Za0tcC5pDcTlLqDMnlagHBCbw6aDnTXdsODAAgJ2ROAkmw1Ax9E4LP6IJj5oAItUaRp2wJwfogP7bHdAbh8ui6ogod9fxEX12ATrng46jaTTitZdDZ16Ajm/qTP+vf32Sj31ZELGsnquO2EQqT4bNEof2iE6Xze59QetmjRx6me9u+x8SN8bzzuDl0ypQ5K14ST9hOTZY9dQzYzZG/UjbaHiJc+U/zmuaUzZyBaNrRFNAaczIlLlZFWVjN8tEgssCapeiRSQkjnYDEz8OoA8AbgK5BE4HRM/m9f47Z/8CJ4JI/lO7G3UeMUfAMl138UT4Qpp5ncSUH0/4kKAofUzxnQwWtN0bumT4w1pmYE+q4D4Qx2jkohXtNO2dVT1AIACuiYpaNRUJSjyF/6zspAGeOsrbkcWmHNe143YHaLKcHSiEgKthH0HraOdl9lbopVRLGPqUUJY1byBCMYpKX4lFzxRaUFBX8ynFQMMCtqgWaXgJR6EFWVLVbjNcmiuwEHQbONGfXXOwPX1GT/2M4/wb/zFV3D9UuAhYjn/ayCvA3k11pTAiWRKIyybcQBzYGY5jllMP9dxQ7aSlgP2rUyry5Ymeas/A7bi1fL3CMwCgA6kQlKgMazmYh+a6TQ/mxUErjP0A8GjR1uIpVYsmUnNysjW/9xxoxaBam1FNafrdcFMxpyGdxbkH5CHRe4m9xQw1HCSVmIgPpvGML17gc+qOlF4XZ1y3WK2S97MxHaboYIMOEZF86Rkwvfl49h32UGacxCJF4yi01BMQMEYrUABVi9nb+DzLC051oHZtWzhofDeCYZ9uXdtv+/gqmSuWVBOjyMs7EtoblWkUh7eBfUE2GzVKeQHOelsDZ/qfVawFg9AZeKAG+Mz5MQm/NyBrhBR/zIrQA5xEk2tTV2B/a3PBo9tno1DvO2vMTaxrsVILxYa9jIhMGSiqS7iFxW0oSPXwWk1VXo+Bo5H1/gdn/oo/vZbL+H6Gpg42vZLp8NkmSZr2aW2cacpEPr34nOOWLufwDWqDILwAka2GpaukLMVwSd5Tr1FB/0Ts5aOWMCa1LdiEqcDRGL3wqNFBAHUZ/m5aIyNWJhpuzBeqN4lV0hQ6dCKmFSM1pJNIeqX/lofRZcNuUqehKbPkTW49Va1EBApouO8LzNS/h7sPlv4rd4ChsbUan/Y9cRjgU6336Xkfo7Zv9MIoqskwakMKvk5D1y/PPC//9uv4v/8X7+Cm1eB+wjgFOtMgGus/10txU+tKs2mHeQTqTB+T4Jr05XmYRLobDBCNK45s9VfQ4N55wIDhUxzNo9BEKNSrf7tcrJWsDRDpJIRRFS6Jb+oPCgwq9CC+OcOz4w+Ar3AbkMa00eny3RCYNL+FKFxQw1EQvd0Z3+shTVazNoqB/XscozcvyeQaQoL0EIydbRsbpJflGLZkc6jothkU2nl4EYlsYUfi3Fuoqxs2cJfA8Wu6vQQdRKnmBlqf3rjo0vTBCmJKy6A1+WTpcfVaZeXs/vUJUxeMaRfblnoUqBgnUbikw7YX8WvXDfwFU9l5wklJ74CO8QLwyDTOXdc5lFeCKRUVeBHqsenTWdia3BzLPYVf7QuZjYmZiz+ya7y60zzaE1VBepNNho5bVqtAm+duoha7OzOL5bjz1Os49JPgbu4ws3jA7/3H38z/uAX3ourx4kHHH0KLxNE53Zhss4cYP81Jl2VPgZy2DX0lwbZwNWOdGdv/Z2NZcCqcBurgOjFeRSkNKNQtNrsG0Sbx2xH36ERWHIA0Cf/devhxLqdM/ql/OuFwXIEnQSTIjcIChgRvRLVNZrPBZUn9P2gwxQvWEbKZq5K1zDlLRCjk50J20ALbX+iYQMLtCioMpQ0Gnluu7iWABdeVXEbjWpGs1nRbuYlkPqTC6pQq3wfYuDq5YH/0Q+9B3/07z3GzSvAPaJOCMy1I+BI5Akr+uWaAioDDRph2arRoqm07ASVxllOQ6U8Rt21XY8LSgTkNFPKW6trh3GHGX7xnXi0JLL4qfJzPR/9jos4EF02ZhRsVtftsrswB8Tuo4FuXPLHg7UwnUsX7aInKHJOVVS/03Qdy3AmFz0l5N0S4UUkVwkzQH4XLE00gBT/02TTVRDeZBHlA6JKiO1g2AazTCA2ubReQ8E5ZSK5T6yV6Rwzj082HnTVzYDWt37qXAiph3onH+jQdDQt1bAxkSOSDKUPXretBZ3OY+ltl/iKggHfQbP4RTBscVKmwqI6/CaMn600BGHqLx2P8aLsQUFMLlzwRdN0PFqzdHFXA9tY42Qy5DjbcFEuuPGajNMuiroNVPKhvkff6eHjDIiXPFp6ROu6As4K6ML5lywo0eEwOMi10K+SHhxR/wPux8BLjxP/l899EL/7778Pp+uJM466EyU3sjxh9LFuTtB0r40Qrf9SQOJCWYscvE/ZsSqe7VCDfMi1KJ0JbIlPFUdzgD09bfP1Jfe2D5/aarKp3/1/PWaULi45WL8kswey/aOrXJaBDPpfcBpAXZVzaTE0opNGvVPYJGFYpuxatmWMDKtLKdeeYEZZdaZaKaSiSEC08T0BSA8EPf/RkVn/l32kDOjSCFiy2a9lXG912bZ+H6IKmIk5gPMN8Ft/4F34w3//lQoCsLa6nBJxWoYw9Te5G1a+q8yoFDSWJ1jfaR44S/HovdptU/e51Yk8ssRoKRIX1fAZXrdlUu6VqMnXpIjoplYAYque6YAlo8i+6WqzU9J/UZ2gbo0hGUkabDQaqCnVdTVzTzjp8CjX2lZlATUDDD/oZGSAm9h0aAorAAbY+nx2TxzGZFaCKB1fnfPiFzmiNF7Jg1DnrR/qWunEyrysYpG5yUpBAu3C9KaDk12eDrDms2qYoSk/Tv+sf0N4QPK80hNowJLT09gLdbIPQmGAlpQXtz+ymlj61vpN2UALIj0Q26oVZI74Gq1T9aNERvpM52tgwYqb2ZqaVF9ODGxLajRPk3bV89obQZwKsPEIjmtcwl/qJ98u3eM41Dz1nqRSTsE2ii/Sy0JLBoiln1rIiHL8lF+td4o6ux+H/y9xNw7cPEr8J597L/6Hn/oGHKf7dpDE8hAKrd+D+NZVYjrGYcER6GdKEEOLB8mDNT4dm8uABWWR5PG0aTSEpgsWazitSKwOySEpM4md3iba9qIOWc/VcyaEDYtwnkLrfSRksI4XJTxNL9XYhROtlTjpzwig9kK6kvh2IbQaLde5RTgcdGchoBLIeOx5tl38jQgZpZxxLSQTEJtmbu+gaTToq34SZrkVsZtlo6oE2Q69twvSQDiiwNrqNEsIVk7RT1Cf5NDGCbiLG/zWH7jC+faM3/IdT3H75ECMM44jEVdAjlzg8aA4CJSv2EZQ3YQZoq23o3TkSqD1hTtZx5+CxoFul5ml1mNIV2TZciwoGUD9hdrUv8Q8Ueqcj24XHZCQXtcVZnPtfEznSE/a73wXDQKkb2Iq40lrO0RLtI5k9ilqGgB5GcYiyxhiHYoinQ1KqJohP8Sjzk0Z+HF8LftihbY5mqlH8TIvg7rO/gmM6/sWSGcYIXluK7glK44h2s7sWTqJrEAyXTZxIRdQ7Mtpj8GydEKr1enEKrj1eVG+G6iMurpg9jXzosugdLIxxIAwJyua63tdbc6MCoU4qsLltl2XAUb0a6XzBN89f93QJ5vu7EdaHrWGYl1xPuQAYOMhH5HUv+WotVofrl+7iWIm/JwK4YLxyO1ER+yaLSBZ1chuhN9bOSyOxoqss/7nEZjHwKMb4H/3uQ/hf/oPP4hBrzSOZZN+f8AYdhdL6TKzyJRn6DVbJJZVihi9vgah9QG7VECJbzxkityfN99GBGdR6m1eSd9MdN/KMLXb4FRAyJmT9qj2urpTZjDXcdnZGxLsp+VhbpMIAwbsgzAsR1tRx5ZFXPxoWBbJZqFJansGwNXW7EXziwAyVuSyIuvR0Wf9zYETpeQHVP4sImp1pc/p8eERof32QBnilqkwKkshrPQ2bK0AOvIyaXa70fOkizkF0vV/cwZiBObNFf7Fv/RB/N4few1X14GrY+AuYk0BXMX633UA1wGcct2KdUD38eQo44loLCo5CKqKF53JOagbQJRD6zG0EiWdF/uwdQl6g/0UP2w9nOMXGp2perE/yJ0QpMEcmwYgtd2jX9dPxsNsY7tnvfRxDGlUT4tcznlRn6m/gHR40Rst37GOTtaCH4ES9b35liW3pTcNTPURgDpbxocvobTjoSy0loNGTmdF2W6G2067MYk5nC+OhLIpmGxpL3EhE0tVuyebn+04u21t+87Gvu1C4X9zAR9sXKsKxCF0ZYk0uO/ZPpR92DelA72DoG2CgdSyt25rxSnUmdh1sBol9HLKqqc921epS15ktdEczV86NEVF5EUqG1+H2PSrylqjx9F8LVqYjQfA6UWONYsM0wr93W2l/hsasdkfsqY1O/sH8ewUiFPifhw4XQHHaeDf/MmP43/yDz+KcbVuVJ06m38YwwI6XEdjGdvUb+9WaowDoKSpxxe7XCPaN5CRCXBaiwjTBZUwv1NyD8oGZYOh9RRb1QchPjFYk+xnKaUyf9UY7CctSWQSYkGMKYNjDdnhs2QnzGaEOrIoxEg2Yds3VDKwXEeF4cKILABLKfEyiOVg+Y4YIiBDbQ/rZjAolLRkL1dZ2EogK7KrbmcLXAYlYyLhC7gy61wLQ+EVdU8xtyO/FMIp6iTNVDAaBbVzTOBm4Hf96Hvxl754hd/33U/w8Vee4/nbA8eROI1cZwUMAGcA51j/yplXf+cU+7dsGQt0tF1QRmzVCgZlAkSFTXXVcbZSUWcN1HWaX3hFwfK9KH5Y0IaYcjYdKDjN5Bd1J+z7tImq/i7HMoKptqh7pUO5gMedDpCIoz+7DPDaQhpMIvgtFT3tGZM10/m5dEjhoem19uuR/Z7xkoMyrdYpcWuJa33DrJkOJCmHeu/y9EFJgA21s2xnW/o6rM/BBIEBVuubsldAlcJZ3PSts8tUUkezh+hp22FWK4QS/wZUKiFWKDDg/u7RAQ4CfXspB1h4ZMPXrwHpSYrv/qXDQehBZmoEq0WN2xJ23DOQr49pEcbnvWJDR7z45/gF9QvQpiZ4VTl1NPhemRPXEuRo6IujnKpsLu2uE2xjVGIxnLZcsi3AoKVLjKN0dBQmHMAcwH2c8Ogm8Q/uXsL/+O98BP/FW+/G8dJ52XT5hn3Bb9iq/g4OFGQmvwPNkExqefrvQR+13iNGB4aC/SjdW/3zqOBUsLqkPYp/Yw/ei+bk0kf5vlajpojVuZatYn/aBxpKlq3Gmn5Zh9DDjqas/koX1ZdPjbHjwGnv0FHf/gRtoR1Bf93ZmA9JjLoYUcZA332eW1uqQihIgLVVA5OZN+j7XFMCdUa6PV1jk1mRgVyscDBDIuih64gWCAnsczYmVXvuUzcHo+d6LI9eAv7M596F7/0zj/Hv/OKv4rd+7B3g/sDt/cSB81pUeg7EGciHksG5s2zdgxCWedP/OTBIVoGWXrWxLSq0aJ7gULSvhY1Lx2LEupZWWmj8nZDSsZzq2X7qzMlo/3apZETbAjHOh23e79LIikbASskRGDMFBlqopmjbEBEVyZMPNXYurGyHJaFKoLo+m464dCdEW4PvSGAV3Ji1ZQMaHRd5QudRiqWpCZZgTe8W7i1d1lHCDHzIN6vShX28q0v1Vb8n+cmnBtapkGJBZy4pQbC/dnL1p3qnP2GVnYGkxiFFLr4hS9WLOSync3qQylTv8706Tl2DbBmFKoF8l/RHiNhup34lvPLw0EUDeUtboD5i8caPrZBDX/2s54LTuy0QrM8Xvy/6idIL6tikzXYFUmuuxJaU6aSdHaLpTVMGBWFDYSRZLoybR8tVqhU1Lo6BQcew/x1LA+7GCY9ODziOxB/44gfxb/zkB/DG3QmPbs54yCEd9U5idHbO+2MIdgz0QS8UzfTlgENs40FafEafe38KLkLf+XNCS/Ft1pqCdrQ0AxgX3dd1sOvTbS1/4oM+KSzUNG4ZYRfu3D9CNgYYhiJryj28F5w4mKVfe2lZhBYw2jdNbBHTWTEZ3YOLwVJIGOE7ozyTFcCgdqHFmv/Yyo0Ct+or1sEiY6yMnRbLEs1qsgMMMpTNMiAgAxeIunDq9znb2QOIivsJdAQAP8N+K7dn4A4DV48mPvvsCv/CD7wXf+LbXsO/9Ykn+AWvvw3cXuPu+RnHOAusVU47E8ggxVpdlCEEOnAZ0afgOb3UVMtKknvv67NB5Z/Lcc26lQtI4IiOLrEWxi1jL8cbwDxnr8pPYB1znM1jyY7qRGfXwLbTXIpm2aYi9kzJQFm4V5UovhJsxABXaiWKR8EKCbMxIHJAa0ECFjCVnKnfsptEKxqacAanyYBzNRDu5JPyygbSLfooOUm2i548qG/ZwxRvy74ytxmEDjjImrUHukuXEID7tBIIoDP78CrTqWRCHlFVsKzbCuPSgvr3xjx0AdNww2htTArdkuZJvgdKDdCUyVh0K2CjfrH11Bhjdmdc+JsztT8+JQ7Ti2qj1wJcgDmKdybTRAJztS2+BXV68Vdrk+QMS9+iPhuml9Uv5b9WpqcO+8qMtdde9K82PNhvTOiMmEF3OxXq1+JfHMy6iXUQ/kQsvDhHIMeB66uJ4+oBf+vt1/B7/tEH8Me//G7gNHH9KHGH0VhSLQ3aVTnl/dx8YnaIp3KQo/lQJtAysVMB9YSCJnlXyOdFIA2zVD3lxHvpxWRHqJ06oP2MzsAJT4ZHclTkP3FsNi9WzNLBDPWHmL243lsC3ecxQUuTmZIYACeCkJeptHDP5X0RGTe4l2EQAahgyoRYDiIgoYFQCgsxbCnoKp20cQ8zPGZ6rceTHhvZJ5QZ5HTVdq9VbOVhMTM1LhuxJKEyucYwJGoGF0a4ZRkBbujKnHhI4HQkjsfAH/1Hj/ADn73Cb/v2gd/+c5/jO981gbsD98/XiWmRQBy13TSbYZmW0yXHY8osxa/sUIrDKgvsxL4qq/dQtXZDthShRYk6RVDA0CX/MULz4v7jUxWt3AVm2eAUx4uPVQMtB7IhAzEYuBlNfHSvjElSKvfyUqCa2+9yMgxsqSTsvgLWw4A+ApEVqMqnrOfGLCdLx3ShQou/lnWlf2F9V3/M+BiEqBqmoLd1m2ITtlmT5OGgk1bZGhfEbda02//EKl/LceaqFtVDHZysa1aDMHFJJGkT75YyDYIXv2ZlhqQQq4RHFzzk0ZDDGlfQ1/2qxG4OhuMJrfuwtvkA+0yUDtdzPjzyxfUSqxyuWzEDVX1rT9tVRoL3akcnAaZgZluDwwa4dU86WQ6fNidMLSfLwqfQ0njT1bvSfYO/cUlEJM4RmCNwHANXpzMQgR995134v37xXfj+n3kPnsx1y9+MAw8op8Vh0UZM9/S5jfAFjFF1hOOugN8WBDb+FcnueTIxeHU8ViKECNsoToJ0gK5o6Sm/AHcdEWe3QQibS6Ciq1bzlf7yXJhwX0eESNipQNwFgFY6BcemzJVgdzvr58TgoZ0U54g5uNw5j4Qu0fFyZrQCmI6jHZKDToGtcbDnvOgIVmSTsa5n1MxStgsP/bdce+x87QwPAqLe6rIbssCU0WtOrY0I0HAINitb5HgEwDRSnaY124DJzZpcCwAzDswxcf1o4ukM/Eefeh3/95+4w6//2B3+xW97G7/kvc/x6nUC54HzeeDMs281BTG6BMpyPBmqSG+N4ZxzKTRL45RtAe2sMlNhYysuORxVthzV9lDhGua6qGuUtkXMyyGydOvOpMvy6EySNkJ92X4CZ4Kmou32WcQ72OdbFkU9yn6obA8TfUStFecNLOsbqny1u64RDfMJVf/ZXmSFjXrMd8vGyFNGUkhdboNNZuRz25ucxEarc8HoTlSFq+zw0t7Fw1DrGZcyqGaPlI4LC9CgdbmrJo92EkG7j1TPy6mU3U8L1IghvQZsD1DFl2ZCRsuBC7ISWPPQyNYzNH0cu/r1ZIgYd4EpUXJWtkUcYX8muywAXwERVvBUD0zZSVuVEgrDMgWLud5Zj5u33L1iY6M5A/my8iPknUM5YxPqnGwSPXZE4EybGGsB39UArk4PwAC+dP8If+lLr+D7v/Q6/vSbr+J2AuN64ubqjPuss/2DvOsyvyoypdcqhAzo/qHNpxYLWB1hNfsF6LCfxaqBdU4E4GsKQn3a1FDxOcXjthXpAbHQoz+JsLzcZHXMPQMr0Eaw8VvVjaAe1ZfTKg7ZVQF5R+IRmUQcry7WhgsrKfPIRymKc6sU0fNd8xNte+EFvSJMA65MIFGOFpVxrYUUbfDWMUu6xhwqvRx7BGCLWahIa2qgqwIOdRpzsty2mLsi2lGAkd2fb8NRoEKzdsIW2TF6zldY0o3V/x84l0O9finx1Ycb/N8+/Qj/z3/4CL/w9ef4ld94j1/1oVv83NfO+PBL9zhO1cgsIJo1yaboZx8ff47lLW0yE9isPWHfmRVIBuj/7emG+ZcXHU4LzK34oh85LwnBaOyPuy0y2Lvj+GPrVlMhl214gFTAwujZA6fdus2oL3+Ujtj7ESsI9HLVWOWNnPdgEKLpBNedGmMktA3Rg/NtPQX1j9sIctGj29uws73NxGVh+UKNQ4DmGScfaj9ribMBWFp5fcPJymCyHfCqcFl5N4C1GhbNN3VGQmys/Am9AOmUi8pLfnHxZRtnf047gz9qSsfAjbpx6XFUYila/NhmtiVw2JsWo+mdh3lkZXrAttiaZddNT9OGdGEEXqZAKGHRC8wGJEeOle+V8DglFIH7ecJP3j/CJ99+hP/vV17Gf/mlx/iJ59fA6cBxOuMREg/HsQ5Ea0BpfA4p/woEiMA8v4MBQ9b3go6wNRd8Lmg1Ckw3v03nnLPXh8wVfMJ82Bp6ql1ul1fQHdD0XAK1ZbP1gLbMqivbXuuMFp1DpmKyEx8uwZDyKus3kTpcrj6mJRQuz/X06TLj37qhULxUV//2/CAZugNYZqpUvwmJIGGR0ZrTHWpj3d8OAdj6GVrYk7kOVAl0WeNyP/4iqbOy5hTnYqtUY1MGOpeA46n/RYSmFlSpqP8kBZQU1Gws4UIklhxrwJfrLMiVh5obvn40gXngb7z9Cv7GJ4F//5NnfOSlM77p9YlvffUev+CVO7z70RnvuQm85wq4GYljANpyUkKYMznpoEx88ZbjgowrAshzY4b0pcrCGpPGbZUU/ZbKKhO9SEWmTp1mdF/grvncYjn/Rli/xavkVIa2aWZdaZkWy7gzEzZVW3SZVb3GWkGADJzr5B5Vj33KpdiWJedBuZeOkE63i1FnRpxnYNZ+93kaeN+4xbfcPOB+rlPOVolxgluOFog0T/yypFZutD0JyJJ+VQ+2bcny9JzrCoCVjZJXWmG/dHfNSVK22AIJxU2jP2M8rooA5Z20I4iG62PiH7x9gy/OK1zjjIkAskCx5hbIBx7EhIC2dWYCGAOVWmjsK0ZuB8n+hmVeMPoz1u2NXOfaVaj/H13/FrPrlqWHQc+Y37cOe+3aVbu7XHZVV3dVn+0mPhPLSRoTRYmtoBCDhUSEFC6ASCCh5AIBERISEldccQMSBAUBAl8EOxyigCWaBAucozuNZbvb3baru92u7q7uqq7j3nut9f//NwcXYzzPeOa3ir+79vr/73vfeRiHZxzmmHMWj5dSv4ELsq93ZRuTLSKgswRiMj7Arf+9IHDLpvfaQNIINm1zsihcnlg57J/D0VoGeSMes2v97FJB6MiPHDOTExmkbnMBeKKBCWZj2zXIxNsd+PgGvMHCtx8XfvfxPfzS2xf41U+e49c+vuBrDxdgXYH1hBcvErluuOXCo8QtJSgTd5gDaZd78DKyJF5RdjslMMsHJHq2L9wD5i4xPoMAYk1CxdplRix614hvDVTW2HCp5DrAM2bH37IlDTQuNN6pbKr5fTgGQVlp29Ypmlxje4K25ukmrA7yWBKKM6joT/VEy/cV9v2k66CoWZM8RMbACD3w4/uOvtkmCXznnxRR54ALdFWsA1OZVJR1yintjTAit+WYhHSfyNx8AAEAAElEQVQpxHF4iEaX4zw7kw5LU79uyxwAITAbtmIGG9n3Ta+Wwds5RwB12QlL0gEeNnMIBxJPTfBnzxPrWsUdX709w1d/N/DXvvYCuG0VjD2PxGUlz3A0YOP6MOdMh4Z7nhqw+4n6vehbd7jzBCJagWy2kw57LLrRhWvSUkiPyoft0p5in8r0zfjVOyPczkEYH+a3UfBCbq25J3DvuLFmJiLNyUlr/1AXCAAA0aFwbIu+PHUtCcadgdo3IG+JKzbePAX+pR+94X/6hx7wrTcbKxO3pwq+9m0UWkkDkksgdabsl+TKxp6UKo4/wTJMflf3G5hcC1BhFfTk28n7peUSX6Mf55MgXgejnCC0ejdI1YgmdgQ+/97G/+43X+F/8vc/jffjNZ42kGvVeuwFM8bcCB65urpzXEbOooWaa93AwTMtJA5yW4V5y0nkBMKUt3bGBh9D8/agXxjc/Sxrty1cB/SFE0zyF8Ro+43pWGPDIY9EuOwM6swPzULBJIMw9MCO21TZ6IJxsJuqto/zIbijqzHlhihjvi7d9kVnlizc8OK6gfWIHYGnXIhdQcYcj1vt7aarIn/ibeDdZSfh0GQMZDBaScRaruUHl2pbY2XkxaxDPrMd8cMeuHFfzEpk06R+X/AL6zoDTQeC6WVLciU95u6eBZ8uQ1AbZRsziDGNs4838WsCj+KzstLShaaVReSJxHWgLAXemjI9MGeC2b287Qa8NijsWCFAf9fDPOnJNEubYjoBIHTleEpgJmyMp8DJxnpUZbfBY4s2q5lKE/p0FCAbyUyFDtFRVTM9NnoSa6LLsLQuGHXQ0I2XP/PEGMzt9E/cMnBDratdkAJPCvK+1cweKVZHkY/Lb1OBXnBSuUbtFak0wfO2xZtjKaC0GKrEV/uOgqRlynJRsJPzhetdnqzxOgHpKEE+7B121HUZ7DxxbsEa/a3mdrZhmWm9m/qwicSiNat2IixCbKUai9NXf66um+B7T8BT4ukp8FMfJK6xUdc/lANyM2fwOJhGhnWMwhRDM3pKXAKSf6zou+YNuMiv6J3DXVW821EaGzVRrJa/vICOW6kAXJqhuteD4tJvqkbSlowC5QSsqAxLRj33hz98xL4sPMYVT52RelpRjkCg97Bn1aBITinDJnLNG7Q+UV5GllqOujCMF5EN89IG3p8t+/10DaBU8GFLZmeQ43K6XMrgw18cOlG8ARldPke8qjZ77bgNnZw+YQ4dpoB2CmlY5sAI1xvfqBMit+tfPfMMiVh9quZCrWvv2sd/4wAlv4PzVNF6ZEnetROiI/CkbIXyPqqGR8Tw0ISrcGypSH/kMeyDxqSjZo3BKLEUoKORwqvosU8mjbTL77MswHzUwFyMExnzvhyTxjRd1NbkrneqSLCc+D7l4OFpxk9VNwbTCSm6myMwIIcrGZoUtKBoENdTgCDDTTPUqTFIaHoCbHEakSwxUhVphONpAoiJXvtvZTcssk2MDvkBPWlgLO8K4wYQEpguzuz0XntIMuYo5OE1tRNFc0DuLmUD/hYQaR2WwkKatDK5IQyb25329/8Hntz4cyJrgZhII8EUEQ/DiGxvfnVdMAUQ80OHxQ9eSTOwQKA3swPXAi8WLekQjBwhE7/WdJSACnUmyk8J9igiDbGBmZOE4wmOPOBbA0feaBDFomrjEurnKEAE7Ix/dr/G2IyFm+FtwkvoMx2C4xSOqLXBBXz51RMee4vWSigbUfSJOYJCCly0ZUQ59tQ52NJ4DL/XGI/HzelEdpo67oAKWM1rFUdyK9wQpvTGiEHA0qFcbDs6m4ZyiLjsUs8kbgB+7NlbvLjc8IALdvSiRfPi1kZkN3gLvmi8kzm26bPWpqXF9R7FyaNi8olOVw4eDj2oDxhnHhXF6+Aw8czoH9YHMZKGsLviNj4tCwr/OMnBVP0sBlrVyL7rq4Ww+ypLuBF96M8Ylk3jQ+ZH6VHqSKPQ8uBOw09zqhREsw6pjVWo7ZjiPMzwQENsvPTfWdqQ/bvwXtRH4yvZFqfu7ZxdOtk7k4glxj/SOpHdz9BwniONiHfzhAJqy3RqPNnoFI2/ycwBHQv/6ax546hoRBtpIlryGcDDUwVj1saYp35Pe6rNnjTOB1AOwETO4GwGe7uxnJanu4261WvNulPcgbeUr9/nIUCzz9oYn1PV6pWwbvxDRM4jRRWcG1NaZAxHsvkARGSlWUkDPmGeeT2a1kEznt8zZWgufuFPKuLObkPVpKQG5TPt++l1GJBNtxYERQR98I2oKAuUY/xyBMQWULzjjg7q8iWsVFQr9ya70nTnnVGikOSU5gIW9RoivvMdoMr5NsRyKvOw9vYuDnlQtIw8ixu7BkHko3VFOUPucLqcs80jnSc6QsKUPEAI0KU0lLkNnOcYkF+ZyCfg1fPEj79/ww3A9QJcstaCcat1vryjFxZpFhPw5pB+0sYjBO3rtVxiav066JyKgGGRyBHtyjQ+l+HauNABMta6sS9xGIygQxhNl0vzJTqDUMFbjf3NBr7w/BGfvTzitx6eYV1IwCa5ybB+8e9NQJICIva2LIgYY9yP0wcNPNF9kpbEnMpEmlDdVXJ7jxouA5u7z9Vty6onnGaiIcYo6mwZ9m3bTqexQNySalko6au9JYzsCPiu2t1VBaS1ZK6Mlhu+Td5E7yzqMWwaOCKQTvXrafa/JXMmZLjPFgK6ghldBxI+urYRlrWRsW3DK/E4MoqwrG47BzHugHNwOJGK6Fdcxq60cR3HQIMVg/2MHJiOktPzmsv+1LgEADzeZh6NoaEgj1h5EZYJk4jrSFwLnCRa4JqdIlGwgIKRWcJ3CrA6cgoxRlTlKd62UkpaZoizLRFEA0xImViERsa1MTqn0oxhZB0JzxRQw47nqUQHDjiklDmo9Mke7/+IGplCPN+Dxmu0UD/2XM+H1dAIO7iutZNKfxxMFHp1QE4KPeAQHoGLr5T70DBiPlQXbiRnKcf1hhOi/AATyrD5EDDPdhWcEQEnYoJ/kEgGINS/R/wHZ5VJqufvIFIFVbUzpWllYDPraWYQ3rE+a8YUAPcVzzaexM7OTNCxioWNwJdePuCH37thbeAaQDxVOzosOac4yMFPW6TmU0XXpNmiwcriNfFGzWVOMXXPxv0mIke0vDJw2FqeIKu7pkWRYnWyG0fieLbauCzqQ4/Bdh69zYXPXG/44rNH/NYnC2slbusKz2i0cNU7gV677696ghOZNn2SBorsDRmnwyZaVDjY1vJAx7v7CcpI8HvL/JiJoKOB47/LiG3YoLbn2QkWJhrXMt2dNFZfArDBkzBkDEgPgTA8HofPjT7Y/QEJlDzHZy4rLGU52L6MbYRkum7zHAzg9dZB/mDoX9H/ZCAEV/0s6xsygXUJTKX+afShV5vLJpzMkix3TihHwnniKkBLTTp0rFRnkSThb1BHnDKcjqzaF9fLoebwlfYjWqkH43Y5A4+PCg6U2ekhq64qR+z5jOvU1aijzpcRYAoAUwOSWCUQO4BnYUBjW/m6Dd28ZgKc8wSQjOw1etBbS12fijFztzbGOW2GJl0MdaaXwmLGw/mzqCIa8jvyPIGExGe66O60FdlIppiyp2SsJDAGkFmHwgxz6FTwaVfIEQLfeph370+6CYb2xmjSjQ5RaGT24OFrAuASqlmLZsQoq4Ej5nsXMirDBGVx8nK6BywL4gafoiHF4H/d2+Z3nH9WTxs87pekaNn1yCH1Qg2lz0qIgLZeKeVKWQNk+Pf9XBBdrrI1r1oeveAPfviEz70PfPI6cM3kOTq1hh9RB4Bg5GGWMlODncLUO9obAnARgoaJCjtr1vXWlU65DCMNxnBAJ7KxQzvlkcYCSDyLUCqeRkw2VxYpR+Z7zfWGxKcW8BOvbvjr3wDimlOjQYANQCl3ikz3z6WkoX/9oh2gxJKRkuIpecX5sT3JWt69Jw6IH25kSs0XWGQ2GQYnFjjovko3DN84z9HEiMEWr60iX7P54YZjGfZwK51mvpZlSVpGemlnYZZZygGZUIQ4uEwitT00Znw+1ojQ0lnKs2iSrPYIbXsf6XI4asS/SGctEOa8rqXagd1O3/jQXJKISYGawycH0TCXQsCgqLR/V2bQZEPvvyNbEgZhhYKmns8iK9H6SfL0eKedwZ0jSxwBPM7+Zs9KV1aYeqxmjuGxiPwqAQxLOyiK6snnpE5l2yPqXPhCU8AGPQVlZC6pmsi8YfaumuLABB0kAoW+RLO2Q8AoN2jg6/OzXAGEEYMW1UYzip9Mp4fNxSRClUiM7LJzggDrBGTguliRl2+Q6c3G4Qa90KOSV2J+N5dOE2I8QV67StoJ7MHljfHZN6M/o/zURrTTktP2FAwRxCTTBn0xGRxvm/N1VFJf/R9WtZKWQFu7FLAfDmPYlk7pKmXXBFyMh+QWg5kDLCieVSDaPEhMNILA3ntKGKxIT79HTqp40AoheqJqQkicBfzRz96A5xesx421b3hUan3W+HfWevtWBqvG5Du+sWf9nheOsOI4g1X2NXGyYVSmI4EF6CY9Xmiiky7DdL0305lzOe5iqs1K7d8BlVifGgCXBbCit6kFrtfEH/7gAXh60ZecsB32m4eMMfOWMzOYeGiEgTj0hOOZ6Hbajd62eVyW1fg1f2k25+8Eack0BXWQP47LoLIP1eK4Ob6az8KaMXrBbfO8xDaF3fK6zUBQdmhklf1b+gYdemGbo88qLxliEJspi/W5siU09pYlrJIAMiw0TjpdYoQ+rzaVlbMCz6khCPWlQtwVc2oeeRm+g6tlmTKO0zkQTYmr/C7Rt69O9jVtOsCy/f5uL00O3SPlsqxpo2rLqBvLM9vMYNCxHf5IL582zmJlk1qOxaQK4uv0eVUKHwQivPNzpGvd8KKEcNZv4njv2FJoZ2lTgILtZU+UfS8uS2CAHBOZjzEpBUpQEZYdmkIDT9rk0d7QzIAdNAINUhFw2J3I1jIgFAYnd7YDY56hIoYGNGZJVNzWEYEqUYVpl/rMILcP7Wyht2rinKcYZXGiSiBLT0doynDlsS/VjW0BmwGn0dKh8jCy/ViilfRwQW091kGs3xGbRW8RbmgflT7cory7JQMGfEMxEg3etmEqDUqQm0RrWqOHZPEL6oPGbRqqAtL57B/5gTohbS1gbeAS2ccyhGhN7GMNk0ZDPeL+uxgjsHuAVcMZwguyQ+fZhBXHE2fRqdxFJjIyEkPBrFSlPG1bYTgdD2gYdrfg2D0tiDWJhGttdMEf/MwDcEkZ4JKpAmFqkBtd0QPkTwpXGjHMaei3zShRzeaXPL4f7OHfIxV37sTIgKO/DL+9bwYDvPUuW4qdQD7+NqyqKm+Dn9qSxleaTlTUmLacGenOHsbAEBbCFHD0OVWoDMCMYRz/E4IogCAGMDOyNG46EQi04W++8SjxNVslh0fDm7EjJb9pgEHHkY5AsWRkcDBhWDgYTh0nT7PvmLn7ieIKZVNL5XsP7rUszKFc2TaG7JrovZzakXXwOHzJ9FImLgLYN2Zoxpk7XFXp5fBxitGrzetEfDO9WtOI47OZc4JrWZm7igCbkSqu6stlVKiEyS7EWnIGqjCk2iPBALRnRU7RQ+hJG+PmcAebPJGNqUwAugVp3Sk0v0MAuRBxzlfY3gs9c8FNj4HrLo6AbDsW7C7i6c//MoXS7X4z2zFe8vjD6FGfbX6f5Tz4vBQBrjW2Shatx9qKmqyYFqOI2zGj4aBz9g5DfTdg2vxSAHPSdbzTOTEro2gw98LHcWwxgTIo2AQsK2xyv2ZTBrQkYwdTUVFHTCClk2YCtZzVmQfyOdCZ0ZI4Hs42pBhQDR51h9KlF8+AH/ug1u/WBb1MUO2smi6WrV9y607EyAdaN/kdncBA1lHRqHkKrFteV29hpZGXY9LfXy53a6Bc60wGYyG5Zx3FYHLIrg3QYPQpacjIkz5IqaVgXWop50c/tfH+C+B139lMLkhNOF8ZGusvqDF8fjJT2bw8dEtyNULDpbTV2GZuowwU5STM6VeezWRVI3ejyGr2jDNtT/2MdsKTZZps5dTBiSzH46qgZYlvo4sB4W90IBCrz7kvukhr1XY3H1wKaN3oMW/QmEb1b04Yx6XvSIvevqclxSBGopyCsMyCUCR7WHRQW37F28FVyhmN7uqK+gBzHJDHSWyM6OVY6TZp1TLK8zXe8WoB1sEUK86QofS3d4NtoK5DX+COHI2rYzdlqiSQKSmzDucOHGLyww006vMknd4UtmvrIeWGNiC6BsAwUAbi3vYnLCrv72MDsRmJQil0nbndzIyy3JhClwE2kS6npxARuM+5BlbBTv9O2CMX9D5dASNgJqaAx2WrGY4BW9JAp2A2UzRzgdy0L8+RRgmMXgYYjXRSRg7FK+MRcVcI2XTIBsyYoiBOego2CUedFm5UeqcS2RwWRc8N+rX6MZWkY92MvmtAKO/pYxIT9l8BiuZvwCkFhb3NcVJQbI8uGX5Ee4LxHmY7h32r1pEs9ihMPwY4VCqmws3YjZ5w5BVNAamUPd+f+pTA7SnxpVdP+NFPVXl+8H707PFHGX/qEo+c0BXHrDg3zKuTH8t5Xkjdvkeldx7QrgRg20abh32+xArIaYPNo1l8ykHvfMmoLYIAo5cSRRaHmwen92XeIrBWOVi3WPiJ9274/KeArzxcsWIuA6MR91sotTx5ToXfDpDGGNChhxnOY5itA22cOjaRbg8JqOehFsLaEiK0AT37a2dFQAS4WI/bETaxHimzqP2+xsFHA6BBFx3aaeONj2yrak9ChlfjCYh2RJ8Reot0z1Xc3i5IRl2ajs3vpmfWwfXt5FPX+ryMO0dieDr85iE8s43ThhAAD3Qa/vTnhm90Srg0UktWTuWRscmEnnTXjzk4DFCE9XTWizgjZ3gXK6fNzga+I0mhuCSAzvIl8uHhHTnG3fy1vOB8tDNNrgPwFFa+OQIzlfvQ3+r4aRtIEKRY6ZlHxKXILweoAwRY9jUKGa3AlUptIUBo/LSj6b/rfFKAaZeQ+55iUB3TypOUzHCATosBYI5Q1CNlAb1mkdvxKE1BoQC9O1cqyyC0lKz2tDcv7Qm0MTYPL+awU2VnGgg4JqV4lAKkM7aGpzk8lNC0ZO24mRxImtVciD78C6Ito/gEwHseQONjvJr23ZM/oFxqwnHoMiLMHAa4h2+MNhUtxciKJsrxdCp9tlK2UWl/igpfet0aqL6Ik6bW8va6/17KqrR94Mc+k/jMq8DjmwtWPtZV1+hT5S5Np5AIad+9HESCDUtulslGBi4GUOIfyjAramYNK2nR2/KY9Zvlih5DTEugfoNgnT6s4VyDf/ktaTzCOAlRkf+Knn8mPny58dOfueErX19Y2HN0fnjbxiegb2+DxlL0Kf7M2QB3ctX1JEeVt7fRfI0l9jYI93P93lLpE/lkPGJDllXMPs5cWcMRF/OPKJ+DiTyjhDjJEUvFIzFn/na/lItFExSjzv2zrT96IUdQZjSnwlXgxfF3Stp0bPbsT7SvZQw79Ad2Uh93hKTTgKa4vOD+a7DVzJHVCPTUifucR8/P594MYZLdpICnPE4ndAR92SDtnpcycTxGnKHpSWvhHEVIq6COJRD9gfN3Yg66HgE7gbdPTcJLcZOHEeXwREwxnWYAnZm4eoYjZUAwCqKjNak0RmhEnUfc1qrOK54KfIL9cE0jOkWMXpmivC2CVZ+cjF0SnACXCarQKo+2uJx5xggJ6R0rXBuoghYFJLq5KHeOkP7tcFYeWuVwR6kPQzz6KTCOMXtK0fHAIUWQqfnnNIyR0rQGYE7YiJ6UgCAgcEkVMibpHCb0VHByk+DWABzbVJK1JL6XXcBAZ6CNiYF4xML3S3d5ap6G37efRjhg2EwdVIHZnsO5GR8EtLZVMlqWpZEExTgzYEfY1vQnjzZCh4qwWAlr4Q99+gnPL4nXSLyoSUx7CW1r0g1vZh0marZT5tDGNiFDLq6bgyjY6sOH6Ew1pUsnlvG4nYCpDzARY/TR48pkBYxildLuGNHnZ5tVsUHwK3ipWxATcQF+5r0n/JWnjXhuC0dKN5PZ42TOIUbjJOm9uPsX4zgMjQcbqcdDN8oUx8LIlToVcjYq/a6jt2gmDMxj2oyRZRXp99hHDue/LFhVoTYhhY8HDc5SUSqjXAZjTcYaXVxqbJ0BkPFXw254OOal1Dmdq+CYCapuZNcax5+fRxxpe4/65TBRviQo1H1mEhqfgpmVwZKxXKHxjwxxWdnkXBskwnjGj2hwUbicoX4GYy0ToTqqbjQ5xhB5kvo6rO0OU/wtPWP9mAEVLQoN9i3rJMBV+MnzF6qN1O45c1Es2xjK0l/p3mQPhLn5SR0Ykd0QMdX0VELPlDnfm+NKhwkEm2qwjPaKqgDSEidTqxwkwWmG1pI/ykbFTI43p0exNabdKbqJnt6cllQMcCfD1WD+jZyUr7670Ji1MwVeUDIGTh4fIGVhilnzd0OHqJxtGqyMnp7Y0cRea9VZ7x4xjBcl4CaQe7o4uvpY9Rzd9qwomOu2ijclbBfM4Uf1giUiRf/5gHJQ/zJzoWxNALxP28+aoEE8slCSVderFkJ+fwBPLXXMunGOQ5XZW6XycJYiQulZzqrsWdfDOL3032p7BXC7LPz4ZzeAW6/zNy0bA/MSciJ8bVIzkBOwkZugok2OiOjCrkxd7dykmmWXNQAhVkSngY0laKCS/JEfYfGS0S5XnLsh4JDKvzcul3CvoC7MWbsWIqMm+xM/AODWWY91OeWcx8jKgRlF2F3IKTZKVt04cIoBt7w0/COho7Glp7aVzhxDAKqHIN3A2gpSoL+X6Qw6La1zJlczN+NPtmFvI+hGJwDJbalC3T0h9tLgVSqm1T8GCxcbYmW8VxGFOskWRM7BI1tqhIwx197DMnF0htE7XJiq6uc4b+JTdv2AUGnF3KtAzBQng2o2NWQlEWCpasnzyLdomIYpwPBxwBiz7EjjPYY526DyLIMSol3y0sNaXLYKaNlwzDLxUsUhcwYMxSoYgBoWLyAfnpAPN9SdDUSB2eI5x3ezX+oEA8riyFUAmBgBxZ2gZRyD0uyRtSc/CRQj1ExTHJ4vhZECSDKkedSYycKcACDM8OUUQnBqLpRUuDZOLGQJCrP/BJTVKJLsATfP8VOI6AQN9oxXTsNKUG8Cri4mg44T7jGyvabRbF2ZNrmrQaRTUVsJpFMsWoj4rtyRGAWcorsE9hL9RD6BayrNVc/HtE+62ZYxwAri3qlHOK2RP0ZDzmK2QTMHVfLDnacYg9njTmBomqOokza1GJXbSUlrUFYX9uZRpoCVDTc+ZfOigar7ZtZFs0uAR6Lm3lgL+GOfeQJyd+q4n1vdxRa8DuVipHU5LazQy9fTWfdwoRyC/IrZAmpya5MUH4NAJZvHSKcAjt9pCGqPctWz4LtsBiE5Z/FhkbvGXQmIC/7Qpx7x7PaIvIW2QWQTIFfLtDCF16jOUsRUn9eckqlnUZJYJhhvKItZgz5FbyLfgGof+ECQOVovuov6TT4AyDjCdFOH0OSdgfX0uoNvj4tOLdfa3WBR3RIYhzZCfK3Ph3Pj6NYnHmwpcuT4myd150V/YPaCW1iB4plwK1YfAmVZrCZdC+vQBYDvRHEcowAz6OG4hewyqi3T68w8SKaa9wvDPhp/oUfjhB/+JuI0Tw7ctl6SshTQvnvKooryGutmm+E4jaM76CUeThyIhyfk45mppFWV+1rgMzQa8Wl5y7oNMHkJDSdvkVymMT2nG3IgeBYAAG2JiJQN2H5rHN9VExUla91+ROsdg4VIHUXvxWA1drRQMwIIUX6tuSlNKdyelCIfKVfTYZ0AKsaSyVsqDl4E+S7gVbM6OlSk57zDFBYWObewrailjZZspdBliAGdj5BSYQGIKoJzxibSCySyCWdOBKJSskkFq2dZXxEtTGm0kVACFpEMrSvKQTssI4JMX7FfRowEQxV4uvKaE+DEPgGyBhNEbOqDTGvTyhb6z5T4ksw1w61Dmy+dDBr/FoQxAfVze9j48NnGj33qsffvjyLTUd8t3BHR197y5y5VHZ0QEiXTAFRYrIyEog+YjHNwq1tNGC/SDkkyZ436xt0tfIQHjqn/jkZY5Z6dFo3uew07ReYIRMvclz94xGdeAd/IOU7Vg4iKmppwYZG61RaMkZp56EsHy0ADr40XkxkkXVkMigB0sI3EIGz+7Yj4gRt80Cvlo8Z+3AbKcbbxgfXJQ3TOlLOpBmfVjjRW1r32aBoFZouvGTiEeXKY4ETfN/10j0HEOYaOdIKY3/tX5zhgcxpiwc8GONL5JJWWK5qvLFxkX+JPF90CHSAOEAhL+p1xCqCxiIB0HGikbcyFT82s9EoBysUERLUVG6M74mkIE9D/rEyZw3GCTDaQtnXR7CUDuywa5ptH4PFm4+0fC7BAJ2NIYJOtfq81hmmC688e2YFK0i/NiXmow4C6ebWT9k+noahsYhEjPwPc6Oe3b7HAcIiHnlDhywYasLXx1GyYCaBCc5wRoIdC7zQB2dJswSIKM+XoUaUggMqJEgRevlBj6RMLowsXMzEpGGN8ZgNQj5/CwaxFC62DeHW6x7jzR2dBt4FYXA8aIZNc0EuLMcPj3Eb3SYidCEHlE1IQaVBTJtUePXYdA4wGfJlhYKGcNK6zTwJhAJtLVYPnHG+t7RXNZNqRuFmW5g5odLwzJAu5Q23PUhWnZod1kAWkn9mGMtu38Rvoxb+94cuf3vjc+xt5C6UFFwJ7FY9W1rJNYE9NQmjGNavMfkZfg7rF+pHyaVqGdhu21MSgwtSgwBfwLkab43UJ7N0Y0DJqqTPGmWKkqAKciC6CHPmU0e/lI0a5OwK43fC5Vwtf+gD4xncXLhFz2Q4Mp1gr03MiTnCs0UuaOqTKsGmiZRqyLuaj7GucATpz2QVrAcCP3SDAU1+oLSOdLsNiKCZAqae1m0nAFb1vHpqj6J9luGcnDnUVmg8QwEVaS5bx4X5X2xsqWd7Gr3Z0tHy0fofdK6AjnOls8F8E5gz8MfyF0Qs0xjwWuJZ20XOMg5bCMNi8TH4ZHUsubAyexWYT1HPVO4TJEjPENLTa1dMQhNFVgM5G6WJhWy+FW5CSdw6DeApb27egi2e/UC5GkltG2n4xCENcEW8fELcNPL9g740z+5PqEeIDdbpoyQCU5/aWoLecjnALiZv+E5UHBfPp1k6AEUDiTpWwNFtZVz0/kVf/LwHeFXaudw3j+ZxHfNlrW8fqnYEZ5zBOiv9NZpAJ9irfCI5jdIwFhyUASwpBIzgiNMBLyZwLL9IMFUnYY2dkYuAQ03mPbUmoPT1PwZHicrzQEGTQY+X0oTRV2IBSE097nz9H4VQAPB4zViiFVge/cNwnsCnqagJzDbAAZ0LGEWzqRNa5EkaS4kk7YfTojYazBh5dQd7LKASR7tvTuFIgtZ8zFkYCCMzhpCNbAQA78BMf3vDB84VH8gqQs+3LWWqvsWV4P/3Vmug8I3FAVvRHOe0IP5q+uniEstT0XtHPyCGKqYDX3JzGHAsQl8DlMuPA4hwoWyZnvc4/bYwOIIC9gE9fH/ETn7kBt4uMARA4D8kpWQ8TRG0l0+SlMPWu1pV7AKtl6ygaAHiPfAJdyDbZIGU5Vr8fOKN99rt8LDcwGiRthpcmX2FjpbFSu6E2worrDphbxl+azGiE0La5iXjpeI1ea3LSu5GpO7qyTwEixmhTtnVGgI93jB4QFoh4145RZshswjHE0xhXm+gqKnZZsfHeARfHW6YkNUa3GUkbQbq1PmXaLhX9pAxxiNDoeLqMvpZGkvnX5Gt1gNDBdipVf0+7EkB+8oC83domSjEl92EyNUw6RB0RwPWdddIcRoHsEqNyKMbCu9tGPN0QL66g98Q1jrzrXIJpawpl6MVWfT5eHCP75mWECFqebPa63HiIs22uxSeZUgqSXAzy5QEKau2TnkzE6OIA/4wTgKWCERX1KAoj1VuR/IrdKdKz6OXwBsY7PPu3SDw65drvTX8zcB5xSukijY46CvGgBaUNZQ3Xwo0izTgyiVknQ0h/7r3fnF/bB3Qg8UHD6EGZqE5WU2BHYgmNx0k8eMAW7ZcptnTwKdDVTWhI4LL65sMZWqD2No/CkY0p5e6VG8sQoED5esVPfvYNYm0poNND++97rXnvVBFt8TrfSXVO9XkK6FV8ldmp9wIE7XjBOHBLPCZiw8AjWpf2tCvmpQFv4IjGOBcvEBD/MM6NZTiAuXNiRzkwf/izT/hLvxbQ1eRx0uvEiM58mBNpuUjQ8VaR2e5DWUiNQwcmSuXwZYLs9zEGEOADbbQJVF34tnGBmz2ny2BS85jPWVFYfde4ZTTTeNl//75W3cegYDc4ZNKm312Dw+oKMTvGgphbTjbaAHFso1atPyosdKxtEek5JAsR6YioLcucRGAOCDPb4e1FQDVJnJdbNV2tFRNrpsm7iCCj0q/G4GcMbwfJxn7UHNo2DgGHbnyGbySOnVvReMUj9gN9FHjbnsk4YDKJFMJYyI8fgFsfNpRa/D3Uw4bcfXJJgrxMXAX4bczq2RG64zPYD5V8o7YkBGYXAMiIGQQnEBbFq0FSvb+fyto7j7WmAa1FJwAsVcmX8aZydWrYhYtGqyGCsFjTqJpRY7EYkkqVtiLFNsBIyZJmrLG24HIOmUO3iF4/Fay0QVdHAybN+OxUtbpZXbCWVLISNN3zzXkHgLigN56P42HYr8rqXj/cdM7EqxZWDA08VeagMbrKyAUyJMLcYbF44+PRuyKpKR6Vmf3EmfZKa+O4v6HlxwU5xe8SqONoZR1424N1x5ROpQxny7UAmU7XBp4t/LHf9wigCgBx4/sDasFaBSS0tR22FMHaihW6qsLBlCAQpLcc+i0DAYoXQZU0C2apUlk/GQ6CZ+vtgG5C25VITxqP/l3j7xeDA5hiHvuec134oz/wCFxu/AJ+eIFS/OYgdcMyND5fj/zqMTM6Bqxy6iB1M+fUsTAkH1Ozg2kzfFxucMidBv/0QZGwMwDf5bLh/UH8qbmNUT+2eNKHQC+xuvM/GyDAgE2FeyHmYZZa+FEbcckA+m6WaS9tV4xoe+dkRfdVN2Uu8NRZ2pw6Arhp5cG8VHPokC0f5VhyN1soQ0P19MhadPUAbNZ1wAzfCmaDRl5TFbBcguZ4KKcjMsWZPu7ZtrYTdYaKoa6pK5QTL5TW1iUE8pO3Rf95W1TR4+C8xRyNjb9f7XdobZR/G5DXRQUEE1Qh3CXKqDw1A1jFKuWmx9FtriivT8JY3zHNtv29HhEjZh+ntoTkCVpl/LL249Pzb1rfQd4YbiFcs6uVfEA+wW0y3J6j7SVsmx46wQGBOao17bMaIwWKf5OeM/c2BmtWgMvYxKz9Za+ZBxEnMRsGBhTNxtRxv7eht1KThAqOBwXSkUuCiN4eyOlEXCTkWmboydAwEkQH+AJz7gApNuBaA530wpENcQGwdkfquyVhaEe+OVHu6eFTdVqeswRwY2Otdhx77fMA6+a5gAUyPaAD5FvD9hPwwXuJ/9TvLwfA1wpZ47Hb6atCuJaD/n6GSlpFp6hmDgWq6KxFaO4HX2hANg1QEUInS3r7gCI59ctmApLPWJTDIsRaPCa2aULgX8XrFA8IgN1gj6eyJxf89A884bOvNr6JF1gC1UaEoJMT4o0bfDpolK3szyTaRg8aDAUuMToqvaOx8GOq24jNAWmTc5A2eX9kN8aJdflB8DBnADpPIHBkskG8YEbDPuP8BhS7bcMczk3G39/pUVO85ICwloJw0jLe2DKiHFazQPoQtY0Ghut0iGaZ9+4Zyiv7sYHQqalpcPl10uNszuVNV2cHoGuze7nnPFtm9HfwEcqMCIIS6ou8PU6mBcDto8Gqv35pm6aRj2PhGmSlJ0MT0Q4APnkDMjD8ezrVNQAwzE3itLURCVyVtqURAFMFA840hpNiswtrdgKPN1O3eGebUNpM/fIX7TTggGJNJKgiLfY/nq5vyWhbKEWsR8frpHGctB8FKS2NR4HrtH+jQnLwAnzuD7cDTcDvx5vk5S6zXgw+DCDqAJ0kreuzEsyJUrnOmuDaOQaYeEJgpCrGc62+RY1gOqCYgT6hLxAXi3x6TLVPdJdRLwTA3KJYDdpqh6GcCR0G2E9DOxpBk8vdFwMgS/3RcJRs56w65SiLgwKVHH0kNQJ9BQMBe/jsJ05KfkgmOWBztC4Qs410JZBrwKn5EPY0HWTOMxawnwI/+oMP+IkfAG5v6lwIWYekg4u+/jbqeNYjXDlpzaiAsqerSJLGAK2rBNAjMQg/wY9EDNI0IefC5TlX765h8acAEqKn0uxAnx5o0a5ANLQ0cUZCPY4VeNrAT756xI9+GPi9b1+qgHC3U9zjrEQZDdCA2twjIVui70rlCa6MFAefZsuZ4+DoJOsFJMOkH/W3P6cpOPSgH93pN9E5f8lHUd52n6a9X7SbzNoyLOV8o8UrpLd6hkbO+++s12Hkm1fQ3MdhAWiH6wX5D13UyQRmUvfYJpeKqnEEzszGoMTIlLhneut1Vywm9AmdcxuboSzSRmUxluUY0/vrz12WYpwpHvdLeZmM0Bq1BiEyDVeYKRJozqmuojRpmkaM/tavod8BfPIo/ufeoimPyVVwxX4NMxQvZ+KqVGQbtdoz2rDShF+ROrbUrOUg0eOTto6JafKm2zUg2AQZs0VYe0vCS9LISWjJovFfHE5UMVcRoZipW646uxARczJSGuAt6MKZws1aJ/eDOqTgCbDiHLgjMGpdkdtFdA2mpJFMKTpPRmXAT1aF44vqhVH4GO0EvcMqbqoDlY7jH8EljRbc1l6vmThUps7ElWKNNo432X402SQhGhAkV8bzK8DnFs8xIAOyk/rK4306HIw2JsoM0ZJi2Gq8ho4TDQRmyOPMnHwJXb8LtpCJPemvAaBewgnJNBWVGa4F3iGQyZ1qCz/+qUe8F4GnfcEzdC1GjlxFzPiqHY6zedfAv5cgmQOjmDTvx9nkTWoxdqK77XeqCMApM06XOdDjpMGKCmOcqgC4PERt5mmQU3AJ8ZFt6If9XNthwg3Pr0/4Yx++wX/y9ZdYLxI3DJ9lpCKQLbfHQT0Jk4XJTh2GAamdFqybmJCxZ0G9Z7s84fIgiP3jgqz19cmIEg+DDEs6EUZPZaXsdzlplsUAC18HDwn6Y9CYxxzjXTJgjgMYSY8uuIS1FVPgx8hUZKScaFxhWQt5JN3/0lw5xDmlMDsat34FQnn3OfSZHF4zITpICRCWV3TVF251Q8cx0MQxmPE1J/bogHavz3Wpr5n9CNA0lnpyR0/Labd0iTB3tvo6MgCUnbC+M4BV+bB4fER+/KbPyVD+Edx+z1MFnY7hvy9meKLOARhD5wayyW/pT4MX6OS2TOTbJ8ypbTERq1h1FxU6R7m2HIw6IWUIALl4IxvHP8J+ZhWKGEU0nY92GEd+pjnTMMI8ZYSlwhtCnCA0VVQ+hcal+by3XgZTHnuL0xEV9JjZPJ2dpHGMSfNjxpDRNxdqD7ZlPOQte4J9iB6tpIdDQbogj3X6CNid17CUfAxwSjZmJiO2aVXWVDQNE3I4bHJeoDemzgG8xxITPUvxen2hjkTdoOAfY8vWbeTded5GY1AWBjDccVCqVVT2wz2aoslMD/Bnv/QWl7iBq9p7TkwCo6TpnSltHt5COefZAAZUGJgk0xJ9GyAom9Eyk8rMDU285wQP0Rn5ycmQ6NGmxeJ2RphOQlXxzOTQDC13LpuwyjKYGNQlSRf8Mz/0Bv+bX36yYy6yHCy+L14kIiZgcUcuw6kKyAqG021N2lbybBrTiiBHph2MemVDBc18fIWiQ74/OwWGTv59/ZNi18gG5YHGI6SbtZTa6d3m2dZ5Lv2stqhBae2CHDN6NHbB7OUgwtiikGzV+913d8EdWMquWKAUTRPm9+ZEP+J1i5QMlbkt7oR2Z9l84NIVsxrZhcguqo6bvjNgnCZLl1PvDpUY7B27VG35GTK6efXAskXiWEBIOjC7dvga1jEGT8TLxuwViLePyNcPwGW1SpldNrYeBtfsQ5nuUsKrSZ0eOACeg7M8gsCHZ/w83pTqWGaM5oQkQ35WBOtIqkaY3TdUxURWeT8xCbcD9kSY+i9vgOtxO4iNDR9ACqMa17fKkPQ4kuPIIQNH1qCQ/dqIQpscZliMseNpt2OTjG7a+YhZqhvAMuV3pyYHnCBwivFLMA0dzowM4oCG3jGjrUgJlmKlLAV5Q/WdYq0CHC/eKqCQuSOoqqhtFK2eH8dEhwq3ttQ93U1DFvlJRinHnGaN7HDwKAhybi+w/PbwkI6nRCZqJUB8LuMvHWO3vZc639zw4bMb/tyX3wKPictK7Kd+KCkvFt0lTF84HAko6FywowG6md/yRUhmEkRNaN1+IrEcWvEMAupdmB6RDq0rAmXqaUD9DGiZprbxEcnZTTL6q7ldFnDbC//UFz7Blz79gN94+7IMfKZolQ56geNfx4ySj9T2u+RoAsq+eep1THOt54JiNopXW0eDmLCELQVhAsuhlxmZQz8GeMwZbhXuU9+crmwLNm93cIrcNHKD6TpllS/1c8zcKIgi7cypZ4GguvFIyHhWIhuaq5/LMTrZaXCUk7DQ9VqsQeFcYzRrjGT25/c2aEBrNa/Jj8F50iWF065hxqmRKxaPixSW8VO77IjyBs1PGtfflR1kSEedmIx5suaymAzEzYKb/m8BCxBX4PUT8OZpMNSk3qBDVGpB0NwdJ9dMgoK1ZklEoZgBsGcIaOyf9hzmr+HMiWcVGG0RkilGpdPHJqj9oEA16Be9Z7ItczjLRGfq+i26rYSESk7IYkag09/tGYcUv9qKYFajU29W7cwoicC33OHhHJquOOg6q3611Sag08LWAKkLuQyr6GeEkJcTHHXPP6SQEhAKHvnHLiJUPYuAijZ5PWpGLS3UyWl2clwMT7WSAPQ6Ws1l9zzH8zdNNZJlKx4zJUeh47EfuX/lfmXJdGWSFLXI4IQ9Qwel5XtTvobW93E5qeoKJTxi5L+5PABcInF7E/gLP/UaP/mDGw9PfLtbymXpdhi/S6pKJkyIKa/U8YCiXURUQW7LJg0X9Ug8iYNMMowS/9U6Flk+UWeKEv37qs/DliJiAXEJnfkQrOZf0BzItjFoUICEiCpeTKklnvYNn3//Cf/ln3iNfP2EZ7vPV0/UUp+wdQIMGS8Sh8AozBgdCrT86swHyhsRiuu5hgfImshqN2JFz20wbmG1PMboc4yYFB50fnKRSMSaWsqcteJ+JpadjT/jVnaR+/+p2wuVKVkdxK0ALjOe2kI3hhT9eaxeSuHvnZLnfIQzyxRcZxaEsiIUX1a/q+bEsarPYChnqrGvv6O+rtZFM69dM1CCU4+n3nHZmgiXwykXY5b14h18L4yn6DCzRRxtmrkDxH5qpjLsnCizDCm+Fo7uzi7tbCylRgZtyZwvkN2J7HX7a/n6LfLhsXSy6Rag/lBmA2OP0oKZsREIv7qPE81Zo6xIs71vi+ZDo+kJP27gKYewLRQ+uRIwS//0IJlurI9LWGmMXZfHRWlaCKTHghQWbylUjT+aL9UmCxhlpNh3r+kUpnraPY/n2KUMmAxsDMoGo51+N4yuHBvp2GhpLlgLHHnUCkYFp7AQZVsJJ804fPCIQRah26k/2/DZZ3OGQhjAlAAX+NBdHTDIqKRLKdPc763htsMAgiMF1ARRP8H0GB0czoHPctohGVAqsN8f2QCG3kV7ZhPo0FHWks7twfcxHJLTnNFkG/1JAZH8iXh4wvuvNv6VP/UJYoe2vuWGSuVZxxIEasqZy+ZqR0DKnsNK5LnmKoeh3t0B6LpWTlVAnOB2p2yaggc3LY4rx7GgLLZRzUtU4eKy9hfKWMkJ6bmsejbbWdD3cgL4bs3xujb20xX/zZ/5GJ977wFPuzQkCjVr55EBbAFcHA5Z6Zw5giZiRa5hWJEjRZ+aYwAG3COik+GUfnANuHXKElTznv9rTiyoU9RX4iT1nv9bC3kxvea8RAPI4Mbi75e+ZtpwSgf0EKObAtEOZTCljX4GM58VmpdfLuG0AWbu/F+uuWBMBy1RR00oMyF8MdMomgUdsP47kar9yjTscr7K7O12RENNCluI0/287KhBlKUDQMNKZJrxRmMIsxjUsRmT64WcMmENDMkIAjI4Nae1EB+/1Qm8k9EMZWTnJ5ThjXXR2L1YeMqaQRecwGnKq+frmU2Magchn26VBejtUxNtmQaMG1xM22Mg3YCd6/nNDJ3OZaAvP8UUOSBj7B43sSGAw/NX9BVArRv71vyU0cv2wrRFi8InA8DF+ImIZ/o09KYYBPR195yAgYpBGoUERN5ecJmm6DPtcHsMx+lpWRKBGQ2CQQnjIjhhFIVCW8BtwJMzHv1o/XdUQwIpUQgBHh1F8V9gMICjz6SMXOKgceYXux0YCnhAu0JALzpFNzmPRmf+nwbM8aeld9ns2OlxCrJg58W+4fFj4L/3p7+LP/5DT3h4TFywsTcQN41INFGBHOfc8iGaKCtR7TPa5mFTsYzS5gR4kdSoX4L7qTWZ/gwrKx1pRhwXFKDJUAdwWXNErxtHjiVs/BcgeTjMigE///uK7hcNrgtPO/ETH97wP/zTb3D7BLjgvKkuRPPhixwaoJwEnwd5B8MdsTknaAggLmYo9f3g0dxcZw5by+E2y5eoSI+GhbJSXdF54KumC6ZrisDXXV8rDv4ST3jSoS8fbOrsinbQFnJd+veQM7Cb92GfI2pOzCg0g/TMUZ1PW3FhURysbiOkezADqGDMnEHNXToP8HhdoQudbqcDbDmFGOyMFu2SgiCDP/rfPQQUeInfeX4/OhYQLrW6aocDAnX9c2qs5Cfly7NFsPG4k5p95X2shfju6xaqyTSchn3mfDgfuLOZASzl3Rgp8+FEFX0xBUGDeawp9X8ygYfHVhCeSwwpJI3feKJOgCFgw9vR55GSnk7nNSvCqeGYmITEBXF4YtFETTktGiOZ2+is9f+7scizXLP2xTZks2Eec88/9RnTeRhDZylD95twCKbRQ3S1McW8S4MnQDAyTkZDrpG1ZQDC9+8NPaOMILWHCaczM5Mxc/zOdyWC896Rsjc5oUE+xO++HVt31LwZbrczIL8Xs/aP9uV0p7qUZdax6RzOhDo71ls7X+4HvP7Owj/3Mw/4V/+JN3j8eJWXvQNxizoEiNWAHMOKY6rDkXpIyyerDXUp5xTcURZo5nm0c46TUcc9D1isTtFLLvkVHSJUX1Sx+l85CHQwRfc29vcGSeANaBmCYM+2lREaBcfeiWdr4/Et8N/+ox/hv/Izn+DhOxsv4lbGTCnaPHif3RHHjMbQWWNfOHrK7O2x+kC/Uc+2DA8Gu5Bggd3xY3o5+mGBjNIw7oC5bJsDw+ciDS+YGahXt3jbGCT8aAYbH3LRsVjtEEB6PU7NGseNSwhmVO5PKfXxCV24Hc1o8Y58BuA3WiadX8qs8GEWx2cpgvSBAg5FzbQb1FFig2SDpCY/BieiH7bLV+uzxTR56RtrQ0gI4tEZPMy3HE64HKx5oq39QGHPdUAu9Ayf3995DQqRkDX4ysiSENc8KWcfUDdxD5E1pcRpdMgpRrpuLPt/XZQgTefkSLywFVBZyTzAB9YXlUEV21meFLJpQicDQEV/MR1KqDiOWelIQGvE9TuN3YJOqAEVCaN4XBbRGGIMbg7zSb1gm8xo9DuznAIgb5o/5yRjw745nITaTcSsc4O0iOEYlS0JWFtj2b0NkaBL41L91Jqc0kYnC2dZJ4A6M6DkYdFR1KOmRWZ0ZTSYviXoJXBUoPdcCUA8yjZAoGo6uzHmYAX20+eQc7azzqfkm0Yt77vkA2ROP97tdvaL7URuvHh8wJuPL/izP/Uaf/HPfw/XxwD2rhvAOvrft5hEG7GVV0U3EOr4Jz6YAVbwy7BR0qIv0uFuGgMOrpEWthVHuUURlwaQUkjMUdj8rIUukus7I8ejhGDRqdKCNBZ8Hykn1+osxbORse5nyIwVN+Bp4V/7s9/Ct98k/spX3sPzT9/wZM7HAeTkixhOoCIdAVVst9KJ55QhkFYtxwTPNuhzXntiPKTKFmKoD0aDMcrd4B8aGijvlMSmJ0F8+NjDRSDMAZP4RswhNMvGnhinAVxay8EVzpuyRWq0vCGznYyADaK1xRjY49TSgcZvRsx+wtoo0Z3fITry3bmTQH3258L5lhfiZ30+QYkvM9c5FMuG3hjUtstrxAD0+SJ3Mt6fcy67+aZVAhZOD5NtPmmg2h+pqCzkuCsoVf/sN5EfvemryMcwZI6DH6KKZ+dat4JXlHfPQUKZF50WtuZ82B1BGuMeXb55sglAaXNOUYe6NJOocOyKxtYBDP38JGpCTPfUeIA3TIUA736djooU6gcyLvX5MIvZCeJgq56M5n19wOxvDT2rXGyElg6y50OBzJzPVC9gdBelOtKZ5QQDdmHfgLmWUdbcilaCuRDrogKk42AcM8bBS1KERQ7mdjNWia5YxWcdnJyf5PFE+cMfpj2TyiiPeWoCHEgUjFPNxwaMkVZfE36u1Sk5/R8bDDP+/XcD0/2tH2EphLUWnscG3jzizXeBf+FPvMa/+S98Fx+sjXx6wmVv5BOQj0A+5oEtGgGNNaPmjvaVZl02twb5MUwteRGYKLv5ZctqIzfDiyP1GDlRJKCUpUCGlOLyFXBEYKobYHpYMhoIi+SGiOxzQCWQdSRF83BlIp9u+FQ84S//F76F/8af+AgPH2/km0c827cxTNRt10vq24y8ecfPaRwGgwQQhg++ZLi3Ys1jOschQtRLe1LV6cqSGN8w9FcKPRJzrGxLubWr/oM6A+TK+T5m7GwjbE6rCwNVkyNj0Snsfm15wV/zWFFsPx/N32NuyuV3xlMOU9M2LLvQhJxUershqo1oXNSzM6fyR4ibnLMFmhi55SVL5Ee/MXax6+EnfGtHhHrmtqzXdYg79W9C2zLRck3c5RyND3zxyNoAyj4qRkbIZ8gF4OEJ+N5r4FoB62Q2inaFfWFz7K4sKypPBYkrKcCIauzupBhppCRIdx5MIhBvHvsIXh4k1IKcKEPUej72xtYvul1LBRjvGphjiLPTPBtMCr4YEcYVTqYASVEoElU0YQNKsq6JaZ5Xj5C96RN6mTrNjdSQUIURdNbQqsuKyOmRe/QvTzIhAYygwShhpaEKCU9DTnB05BnHYS5F02/3XCnINNCkHRW3sj2tEIty3vKxx8Eph6SjIWYllLogfw0oOb6mEY+vDbUDc5gn4pVDmDOtQxESVdQ5IiSa03hTGbkf3YI5MDJukzSs3VYwhsS+AU9PgdvrwA+/H/jv/7Ov8S//sY/w9DZwuyUumdhPgXgA8IDqa48TUP3nHb8hHV3SHxw8Ir13djFS00tGnXRxnZATwGjCI+UxQgEu9xBgB/RlLKk2MWMSRpLvpqPUFJ4/MSSNmZg7WWboLpG4PV3w8nrDv/7nvoef/aFH/I//2nv49Y/fA14Bz16UTdixWFo9a7YBrW/P1dVTDa06mssCt7WRB+J760CdJEpBcwqOEZvxd6bFdFP1Riie6fhZbwOALhJDlJNg6kMiF0ZYtL3sHfLTAi3BvTs2KNog26Cx/uKcyOF8MgiiwT6Lzno0QWwpIRm7FJIfb4eMqsxGADxUjXOw/lr4+x9ieth8+lkVxCUiLt2vZqBsCpVkzm04cby2UPZzlEnyP+Y5l4HKEqX0kO8FjTLnohcm0666Koy+yrTsBK6B/fED8qM3tV+2vsBgNeUkh3ZbzUmPp74gcdWLDWp+Q5TSoDIC5AZBtI3piioCfNzI55Cl5/G7SjUO16vPtTQQjp5ByrZQyYmCqGK1bfc4U0ECPFJzns3d85JT4HKlbwz9+91WPrYPGoQkiBAktzkzw1x6XDRkTMmxeQDgITkqUmx0lWIfNCDqovcw16SVUs95krMrEkzGwZAEyhgEYYhAZRSnwJA+FMwYQn7fw1baoCKNHnf853CjaQRAqTaZppw27VM9q8xJp7OyL2lirUUEsLDrvIoMPGWUIt2mfQlDAtg3zISb3qv3veUGbl15+lgDe+/5xp/4/AP+i3/wLf7Fn3mNL733Gm8/ClxRxj+fADyg/n1K4NYs5ZJJR/2iIAOewDhopANJ178r652puoBw+ls0hYDtMkDzZkDLiT2HNZ7GJKiYbvDuQZB0pDQZKEn+MY6qGnK9TCCe2GoV8q3cyBvw9vUN/7U//DH+3I9/gn/9F9/H//Urr/DLH7/E64cXkGJtnmqZd0WAqbRt0TpR9xg3b1YCeSt8uSaul1QGbdPJdaf73g6Yow5g9GJRr/lM8WyKcDHOW4/TD9FJrhcbvdxBGGds3ql+73TVgiQ6ARJFFgCfLRirOdbJa6TtAkh/LdDY2Ut3vv3Zmp5hRm+KaX6Zt5uiRbZR5amo4CxEs1oW5VQ5y2VtQJMvcnkkbk4BhynsM8cK5I+1bVbW7WNaf2yr8IS2idOkM/h97J2Uv4d/uSK+823k6wfEy+fgUq0X04tjXdGeB+0NQYnL+PIPJ1FPRo3ETaryNm8+REQ1GQE8bayf+QLyw+eIGw/n6fboADh48BceFdsalTxhqr/XZUACj+83D0sXe5+gzibFFMpfNhN6pkPoQxkxBA70+mmPp4Wydg8Yk6KY6pGO1mSUYpFkFFDRkOn9Ao1Ng0xnRnzMMUozyukpE6krv1A3fW0K3aSI6FSHxlqf6/5wtp3APmqwm1wdLom1MkoDZjyUSbyTmtCkTyZlZIXyYHTz8RAEaPypP/3OZVXV+NsnAI/13XsvE7//+SM+uD7hxWX3QWY9J0Zat3boNsBDcS7Xy5xetoH3nt/wY59+wn/6i4k/9fkb/pHPPuLVeov8OPHwWB513FBG5RHAQyBvQD6iHRGjAh1HRt4mzxRVlpFP/VVHCqaD7mBXcyl+EOwVYeno65Zj+eATiXiAAuvDTzQDXHaaHwQ3KlY/qgxFO+8OvI3TMkj8PK4AngH5LOr7Sz33FIHnzzbwXuB7jy/xK996jl/45jP8jW88w69++4LvfFzR5yWyrnWOpV2DnhaNFVgXdDr6gsDCwy3wcV7wzf0Sv/em9TQ3nq+NXMDTDqVsS27QhjWUipdch2cujRCcN40x+UR+LmYKJrMD2LvGFxX4JrqYmQghBZTx4hBUFNfMMRslpue8obGWrCxry7H8jG6FwjTqJk88Y2Fp6SkGzsT+OPrR+DjX4SJ4cdJBYo07xOszq2U8jHIQHJtqXGv0MqZJz3ZKKTOPkwiZWWWLPMvkRLHDjBnt0743p+CWwPvPgZ//B8h/5xeBT73sMzHSVMnm7LyB5YhpqnrcVz6YWXeik5JTmEGw7QkwlUgjwWh0b+CTB+AH39PNdopMzXjpTgDNeaK15la9useYB/rUqCRMoqfTqeZef9LWMIJra5YqMC31UV60Xc6xgdlBQEVuJlD41LMxnwzTdHNAjzzg+jI/xA30dCfFF956zfdePCIU/XPpgJ3QMQPCaBxKQ/Jc/vodenZAKtWHTnDssWYs8JpcmQkKl+FAiYmBEKB+wZSw8UWy1nJFgXfnja0PGOaAIlAAo9R64tntCQ9PFzzFwo9+5oZ/9sc/wX/mi5/gpz684Yde3fDBs8TzS4ntIr+EHiXGPMwHAVy5DpolIws3XNYNuGzg6YLHhwvePgWu+4ZrBvIJiKcA6HzcArjl8H9GPhPkcpQ7ZuFUzAGtO0dRciFZH4CzeA29aAFGgrwbAxqCxTlNa+qM+GY3CTr/j0I2dNW0Z1UpaxJX0+ERwI4FWiZZU4wELgOM1wXs28LjR4GX141/9Pe9wT/6hU8ALOTTwuNeyGXFmS3Pm7rRsrMCuKze4tY8eMyFNxn4+sNz/Pp3F/7a117gr3zlJf7G158BG3j24gm3ywW5FtYlBLjpW7iYTqfD5HRqwsghcmNN2gSMOlAWQo6RJMiCobvPpddoPi6ZNj2jaPUO34LyREMc03fxazBTY01MdA6MU8l5mFFnbQgdEJD9LaMRZvjCM7S9Ri/noLCAAMRD3eIy8jbLIiO0HAaN4MyR8tjPt9HmUs0cZR1WaFlHQfvpmZM5fhe/xS6YIyFCpt7JzCnykwPYz3/rE6AvbfPAk4GSHBZNMofHaTQWjvzoDycj0KkkL+pMTO3cHPKXZc7i+NMN6/OfAX7yc8jHJ9TVpuMJ+mUPitTDCKG0SEdjTAuDxmn+rl96XSW4p13iC55Frb2TTpC7aLKECFBEnZ4J8SfNcJEv29L1aFBFCsTgFCRzug0Z/TwFxdM5MoQcA4Xf3klwfRJYTcvdyx5xKFgbYgHAYX8spTwHIslI8CECNjBGU20dUjdk7blwnknA6vbHSN2piztzdCYyMeRZ/Xt9dnm6IT9+xH4L/PEfueG/8499F//Mjz3hCy/flDV5BPbtghsWchON850CvyPE4ElnvXQQPancZTYuqIM08pbAUyKfEvkUiEdgPQH7sR0fALwD6CSRyaaEisAf0of7CvsagwNwHkA2ZmDww0F1slqMeFIgXdkVgoOD7eiy0r+jcvqdc9V5BMxWrOFyakcDjR/7Db2j6PoK4BrIS9aepYU62e5aQLwT2HEZKQo0WJ5V4qdZDRWamhWtjE9k3bFyvQGZ+O7tgp/7jVf4137hM/i533oBXBLPX17xcH2Gy3UBV57BYVjCiXbgQWdAxcgm03x3ApehtYyyk5uBTD3Qc6u5rgO/C31AgwaAO01kE9lCzDgCUAAx2RoYc9fwFt6On9MfDaX8e9L60dsMZe6IBRzNRIKQwe2xE1sRWvmemcqWhtEhUDe8mv4UoUQ7f082TXNl680XvWfOm9EAgaolsQxcW7QOxCrbIB1r3py50aJT+tzbPuPlS+S/+deBf/BN4MWlcKjbyZY9FT0fR5vTcTclbbm/gkzQtScOxG4g+/cVdFZmlw2yvPRPHhBP2bwytWvme1GdDJF7QTVXzOU/c0t2pe5tjC2d5XwN4pBwRZfOajT/qOv0UH0N5Ui+EBg6hUWQpXCQHNlrQdhb81RqF7MMgVaMIxUjAR9mqOAPGKHteRBI57KTZnhbb6be6vfTbTO7Qaqz4fqe1xtLYRMK8ygCtn3qXCLo9hgF9drfqSp0GKN5kRhHKzTIwwhQeKQTRrV0BQlcV+Lp7cIHLwP/o3/qW/hv/ZHv4f1nD3h6eIa3HwdWZy8WNhbXgdeaNeER0vnbPXQaRBrflv3KPKBqCjryj1v5G/uWs63Nw3WKQ1hfpD31qfVFTlceoxNPBfo8Yj7UTMuHGRSLMsiKgV22n9oeBAHGDPreVbMM6PRNbGgDED6osHeA2WVhRskLIQNA9sFJ0cso+QzlCCQQ11pLv+QNXEqRzJJ1jM44Ns6dhhkN/rGALgF5ArDfbmwkXsQj/ks/8gZ/4YvfwV/81U/jX/33fgC//eaKZx9u3NYVSvGSDkM+4R4ChwNU2HHKFgembCVsrMdPYozmcCPQhXcAVqw+v2CNHyYOMxvIJcB+/wgWADofKtqDLSOpb0OYmJHMCYxkfRo9bNwx/XoWaXavNIqQn1IOIlghzDu7CYbJh+LQENP5ZNQ8hYlEqtG98RN715St2HNOumkWE5WfwTT54hmNoYeCqZxnB/xJkwvi7RPwnU+6LmTkRr9psJxT7RQI44lBAADgengOirqOVgf5mmAEYTJOAPD2sS4GerFwRN7Hz8ycxRqHDtBCG5lV6MZIgUSzQpQRSkwlbSwZWkGdFX9EOBeAw/kxBXVhFvjRm6KCO9ArbdozkjFJOPeDc5ciEhpnCJY3GLprHKwaY5/tBAUp18siOQaYmDTgZ8JsBjfJVyqNKO3pOyIq9+6OWoo0jFjYPMeSd88eJo5zpPMFEmmo079cF/D49oI/8vk3+N/+01/Hn/yBj/D2E+CTh4Vn64YrJWBnAbwauPXvoUwOqTwFUe3EZQJYlVmhgd1ZR/zegHVD1Q88oYz+rbMCAoKZS2yrpUgaguTCoXh87OnPlg8zMFWY0UsHvfZOmaRO1qjj+FzGkPNN052WCxmAY7cNhxJ9rESo0v0QBaMjEEUHRYympMn0Pz9uBaNh2FKqyq4As6xwQ9O46LuRCggQ+27dOb1LM5xWMBr1N8UhsmoIVhQ/3+7Exg3/1Z/6Nn72h9/iX/p3P4//1zc+xLNPA7fsJSS76AcmtzpR8KChJg0ZfczSHTguR2rqJfmYJ3657qkCHwuZN4CnoypLyiHd6RwzFigDGc7/YIGoEfGwWdm1rY1DYbgePc9egiJ+8yREjSBmfukYmsY80kY7F6xgsmlb95TYTxiNKHf+tfg19m+Kp3E4MbpDxHSTtBVN+YiNCxybISk/k/dMG2DZbOn1ZQHf/gT4+C1wvUwhuGZ2OhfWumimARstrxpgUh4baNsiHPsHm0mxGXFS3lukH2/A60fg5UtAqyfRYEITl1DKAp1eJeuyvlc1eAvB0raOii4XlT2zPHftSji4CnpzYeMHGF1zrYZcksU6BNoTdsM6EpDEdE6T9CS6R66kK52QAHIfwkIwjMSk5cnMmLGwFS+w9HWl6t8Uvv+r9f2+Ac+GrK1QHJ+c6H6ojrS8UwABCmsEYGNIAdUsn3AkRQwBiNU8SBdaAUg7EzhkJq4r8fj2ij/1hbf4t/781/F5POLNxwvXuJVIPBavV6LQq42y2nLL0LLH7AmoTvR+2nDXHuBA7Kj6o/5f3soh0B7h3o5WgWmqmftlHC5rKJPG8Nd2BAzI8veW3xVdJNi0M0WWivglXYNEI/N0DpCGQW4kXHMoiQQmzI8pSfSgCxhLgCKKF6H3HZAAXsgEwJyfkXdlXW4ArllOyBPmQhTWNwAI7omX4AC6fVS6OsTQ1tEA6vKrFBuwasv8ZQGvXwd+/L1H/Fv//NfwF37uiv/nNz6N5y+AxxvOQ2Ki9LqWqZrPYefhk5J0olouzu1hoI9X8qbgp2VTz5+YcAJ+ImGXB4EZBkPFe+9NzkPMMgyfuHcQMLchNho13Yd35k1rzFoSkEzHYJUyVsZzADqSnY1d+oRNty0K1LKj7Wicp9y6sNpPvwfU8sFuTA7IL8eRXRqAwihTDzj3zNmCnzjWTYDERiSPrW87xfELf4DKfD+Vpf76d5Bvn4D3nnWbLSfMZB7Do6txOpanoawdS+PQ5QwY/TeFQmbBLQN8LQOV+v3kLfDZV8DthnkTNtF7gYMZe3MqcrwlXsPIiO2wPxY1zIEnGIaIRVx3spSRyHAShia71sE3L+3FitmGQr8z7XmBX5iiGnCr0ErrEQUIy2iSTUc/xAUU5LhL7OfMhcBa7VOAWpHCpzftam9/K++yyHEihDFeMv5raKs9uxTXOGWIoCOj1d83K2fm2SY3KBHGT8wEIosnK4DbG+DLn/4Ef/mf+zo+fwXevAm8uHRkuBP7AcCt5rRu6JR8quKfjmjsph75L4+M7h8HGSo4LKMVVVVPR6a3G4qIOXaWikk5J784+SGRG/PhMxVj0ur2UP+u0zL5poHJGNwwJw7Guxgc5Fi9fYL/nZ1TJomUsjkDeSbzuFzVUidltxUobyToGfWyc61UJfKxaX8BWKmtuoPVeGEgV/3NFsBZeuoxdNFefbxV45ABrOtCXjcWgJcX4OFx4f2XV/zFP/c1/JP/tyt+5XufwuVyw02y0h2/c99FApahI4bmos72s9MCd7fa/6JZOXI5WSvqNYSjSL++uNtgtT31zKLjBI7jpV0E2Ze7G0f2xx34fkcOYGM57z5x9PWxyAiyU+OhnjEaVfZn5uvF3n6kL3lOfFH4FQEe+ON1CgvRN/XJtAGuMz0U7cbu/XZHIW3TnzSbTHvrpB1oxCwrCVI2gA4HlywD+Pr3nBk4HAfrechG2pO8MRNqzLgCbjhNUjLNYFG4ApG8T82sMMEdUYcU8J04B8S0vZR/6DRge0hdatA8XAhIpU5Zme5GToKtw4gqdUsFDzvEZozdwTYNVmCLECDKhUky2ISzx81oV8I9luWQoTTaso+zotroApsgK6ZlQc15oWFY6x73e8m74XoxxT9FKV5dr7oIKrJ9F4DVguzhA781p4SKIjpKsaYfAPAKeTpZU7dhTk8bh+vthofHwP/sz/w2vvTyhjefLLzAQ0Xivf8+HlGV+DLaDaDZKXam/luGaHto0BL2QYMcgDl3oJ2JKSRs/aHz2jp08OUu6zGzCr1uQVPJLgaQaXQlMyiZTqZT1U9970A+N1BTX1NjO5yK/vfYumQqaz730CPaQBx8HNyZTAhp1ABm20gm7UvD3BmrhDIZioT39Atk3cUQQFxKPuY2QI4GNucG48ThLNT4UQcwxaoc5q6+8nkN6Vnc8PD2ht//auF/9Y//Hv7sz73CrXWykRvSLwv6kgywqJ1j1wE9B7JuZeR8GUlpoR5zx8EiY1p/fipe7UKI+U4OCBBdlbl6BLx2aSLHob0Q0CFzMfv4ffALowMTBJBMS/UTOnIYI3PDO88UG5y684qSmwQ0xqHxwu4zHvicy4QCAeLsAbe0P6arlHVE7dLYtrTRNoy6oAyyBXIcAvl2lsdDmD+mIhCPifzG9yoVpUyaZdQ01xn/BGKjvMQlAsOVL9VWrWaCpQ0VzeodToAiO33nCsTrB8Tjra4LzSGMOue/RkTfInKkXyVoZgR9+3sbA+LWrH3uCVI7FUdBzq4L2PsO9DnlTFVWQiI3xi3Mmz2Mnh5WQxIgRX2Hl95T4El0nLelDFTNepcxgLOH9JWFMOFmuyQljbbk6i59dogdZ5Z6NvgOu0GlGM9qYUq2pgTK3Ox5xHzoBiONlkhz6mg0qpdLJB7eLPznf/o7+Oe//AYP3ws8i+xqfNRBPQ9APAT2E8o4AC44Nczb/C6x16wtss228dERdsZRVAqOm7rUTNbMWtY2gtuWR6KElyNPG6itgw66wuJWeWIVQx0NptqKpreK+hZsXYAwyWUI8gKWnXGZprNjAKW6W0b+LtTGfxMD6s/hWO8+FEf0ypGDoIPVoKoovfqTaJCWe5YxakXqDleoO9zwU0cpzucEzY68otF+0Qhfi2bP4gGvP3kPf+YPfIz/+k9+C/+Lv/Uhnj1/wtMinFL/JyqcSBvu88jsHOkXANwuKPMg22TLp9Y2ye1+3Bw0NhjgxnVExvTwTiePyNcc2oG4/vvuApvhsYlDslC7irPjzujSfJ/HD8ZgsalBiYctGwUA7gwK2pho53PPyhrp0X3qbgUOlLIgfTY6QCZaX0zGJVomy954VsLjF8qXQwavUtck+z0wKLtegE8ekN/8uIrtszMWMgtEKky9VrZ9bbqcuwKmn6XDMQxA6OHUcxZ/uiGzCUpxLgv58IR889ARKB2Lbotn8DQhTSUGlyirOiMZd5EpiSMcw8whR9mp0OxDgtTPUK8oCwGgr5TVhR1hLnxT9b7Nud7UMhFkiRS0hRAJnXLJWbNIKND1DPyd3rj1r7HGnLm+hlYl0FxfS5tvg20mWNwiAWSxAaUGp3GiYlQTObTqcaxV1R4sPGRWZRbvKj05qUVJUwttYABsgOdMN5vSZQK3wPOXgf/BH/8O8FDWOW67Ttp7BPA2EI9APCWW7pDvfnv9Pm8l6MF++dkOHS4Uu57J3cs02csLxKn+jjoipRKgRR9Py2WJphH9kM5MFTim3jt+Gozqe+OJCG59U8c79ai7JkjCtOZ7BwMzW+idH8k2xcwy/NoYQhBOzFIIuTbKDaKjAx371Xn8fgYYQdfGWTyysfc7mjvmXXYUvdBOXuYO8TS6PbVLMWVmaAPYq75/QtV5PCXiMervx6ziw6eNZ/sNbp8k/uWf/BY+uDzi9hS1G2i7Dk0UehwgA9kTCvv83ZkcrpXrxEAqXrTVIu72Z9HtpP2OCG6TOnF1hRZEqrmOOLPOHykMNPoS7xkkrMEm3QEgFpxLSdFLHCsCcQk5Choj5e+Qz5Y7C5rUlqCO854lDsmCCNxfDDxONkI2h8rOh4aG5IOwuplZJOH2T1nKmZOen4Edix9UJI5K4zaraBkHXC/ANz+uc3audTLpscOMxl+UahsX1t99iqgVeUnB9awZWzED8qAmvc31Fspmg+ktER+91RoYGTUGoUnYYDOH9+Q52GyhmSnJPIzxYmbAXkuxQ3NNghkoUKHWMjGX0cSC1lAzSzgi1E9IsOjUbIEW03gyat0HZ3cfUWnspR0jOKRtW6D7tBh1BWxTDJ0uvPI423io6lm04Mp/P2eGh8Y+gbppTkSchzQnIhzpJODhzVpoGhgHm3fVTlqDYxC1rQtpxZp1kcnT28A//SMf4x/7/W/w9iGxcmM/RUX+j9mn8HVGQCcFDsig15KDxNxZkWiiaLX9vR5e7wDQmR96LsWUWf+vuoK5d6D4GZt6lzaekDhl9xs8S5x0yDYoyk6dKuXjPI2wsYzzzJxgAOPA0PD7K6NbnS3j98n/hWgXWdGVDCuyjfHI1Vj6StnToB/gyOJKczpIJ45VhZe+fADvG6IVMw7EGvKOGUyQ56g+Aj0PUBZQ2RguJz3tcjj3xu3hCX/og+/hP/fDH2M/XHDdU4g4hm0YcWYCk3Z8DCBGFur5mCUg2/FEo42IcfgD4xMihibmCLyDfYACDd1fHwsLvCLd9BlVAxV2+mHYOjbxmHjA63sTgF/EoyFo6cLsArHE3vFgVHMkpggLW5vpTGt+W7QcbIIZ8xE70fbuWRW4H5Sj3HGs9jxH27KUh77uaUWY1BwjrgCjp5mTpfrd79RR+5odtDzr/qEZh6ZBiM60jPW/4t0i8UCDJCVmuhv6LnKIK6Wx9LSY9J3XVSugKvMCg8LzG7Q3n9NxwGq6kjYyUQGrIp1ndWXqSLwciokssuZAvpMhzDK0E0KhlsB6RwEJGbfVePqKXDnWwsSgAQW2ZbL+zjypUBJWULDoqI2Q2eD0nEbWNGY1tKr4JSAce79vQqy1ag07jt8lhvbQKVqYYiceoLHicDR8jnHX3OHc9d+iy7rgz3/pe31S7up0LrAfoVv3GPEXzrcw0XD4jGhcaAOm1ERGE1mf541rz2ZIom9HlEI7X6geJZ9UQBOXE3/6eSeEZ0UEZoP0VO96hTpDxzzblSSQZOuhzY96jV3r7bz6N5teXgNz0MWYuPr7TBMfZSNQuy9o8BNt4Pt30nZnnZ1w14+cDPYrYx591gAJ0842633e+ZnPjqhf70DzVpvtsGED+dR/37KcgNtG5CPi4QF//ovfrIPQnrp4V4c4YfSNhcw9Uh1kdeCegKk/T4G85IfbzdzgBKWqBWWtWismoKzBM9U8tF7WVHuDX491H4Pif2hdLDsUmk03OfjMuSjIicn00UFB02Fx256mMEauoLtpmiX7tFccUnawlmmC05hvUZHZjx5bL2E5G9SE/omuCRl6zLJcr8G3Dam5LuHVUfCbFYLRSZFD2hOf9fot3NTprDuAr30XDD7lktxhBdGCOGEE1b9Dohr7ldgv8SRjvN000OpBVxsE7nk6V1QG4O2tTusCidwM8YHHCA94c4F5yElhuDeu0q5sPuv8xwI8cC19UnD8d7zJ8zrcbAQr4pPAprTuXuVQyOBZwjaC2CNqgQlzlnIGNMKu70NrOTN+MyrRRg/bxpWgkyOHpkh8CISPGsBd2rnfUqSCpskokqI1gu7ggglxDC1By+DLGbZG2CDMiQZwnEBI0CNY3m7Ay2dP+Nk/8Aa4baxcHTWjT+MLVedPejzGOHX/ivJbHC3x0/KVkCGngvjBVOaxpNPf0cO3hmParf6co/26EK3/EU7mwTONM0fmJorFyK39TkHYmR17xfCHUkF+SC9SDoGcG3OK4554gOndZBrA7YrNZy/ognqf4YvE+j2gy4iCQ+l+bt2+F8d1I5yZEVjknWkHrMv+aGS8lnH684062hmle3ktPfzjn/oEn74+4KO8jDxFHOJjmwAkM0yla6zUNb4P5gKHhxPFQgauRHWb/LQsriX2I1EFf9yJ0Pze0vUeh2yL03TwO5s+IRyOY4zE601sC8rxKb/UFeq3ZIu8iwlizL6pDxhNqh8CpuU1M+cEWh9DP8tydh8Zfx8pnk/zDsdmFCNp4/DMe7X9Nc8zaAwVXBfYHHE6V2B9/ID9O9+r9D+xSLo0NDoOIUrrIwc95HQ0yafaIqf3xn01wEQ209yKRMA/RqsiFvJtnQeQl4vNiAaIXuGibDWdKvJO0IDBeg8JuybBz9ek2WW8mskUvpkBjjbu01tHxA/IOaDKU+hZ5KHolszWMAdAle4VJcYwH3wXrwbIRxlHuZT2orCzklxFISOeyR0UgapWDVu3Y/d+LCcs5bdS9K1zF7boXv2EeK8lkgzjJzmUAq4AbQUVKYXZpM07GplQkVpEIB8TX3z/ET/2QSJvqw5swVJ0j4Qqt2fNmDJP2g7hVzIZqWHVr52GTuMDDRJl9JR9WqbuyQ/q0K9bfKycuTN+5P4+HTLDjcF3Ns0MBULDGZrF+R48e5Zw91vvxvSXh3G80w2+JBq1080MAmioQrskkparrIi1NPKxYuTTfyQ2ycykj63H6tsJNwFxlhuy6w8cGN+ZDzDOLxsjTTf6EKJA3gK4AY+3wI++uuHHfnBjX59V4X7YeGV4XLDDHhqcOajb+l1ZSq8NSkWIQAwp+/tAnDc/Rre/pg2b8QF51Hel9geE2ZDh8KXxpHlrTmcyQxWDRloNitBFQLwroebAbF1Ap7rS8ecI9M4oKrPJg8U5D1Nhh5wH3kQ/d9QaENOcZxHv8DCpc42793p1LGuT/vw+ZiziEW0saU5+Pr8C3/i4DgG6XMQTmaumkQIYnxtt4UFDZ3gWzPurjCARCb/FKDAAVZPfx9o1myj6beS3X/d1v8V9XphAIZiBWf+aOAk+Ke/6nRpFL5aQahBFD43zgGUfYhjqypDo4hcTCDBd3c8mNS0oiDAhHKMgtkcp0tQG1Ai1tmVMIRMze53NaUpaHICZUmwWVI1Bavo1kPJO67B5V/TR81CECFSESxqOojGfMNdq0rkiCFUK7i6MZqN9W20r1Zp3yjkxL5vzvge6jmYiAOzA515uPL8Edq7eH8719VCaXmuCEtjJarkTlSNEwyc6GzJeLXuUX6P1GN2UDCizQPmKuEsqyTL02lz9H5N77In1KG4Ok4WJygpwVkNvOn3cD01DuJBVxGao7EClVuKOFiZvuHNuJtpyGgrV+7NZkiDNJqq9k0FAS41SgxZFP19+CgRCRh6JrqMYo420uUB1lz3Pfjfri1r5Zn3AUF6fdU2JdpvcEnsH3n+28VMfbuByrWOyw2RE8xbBMI5u6JklIzRZSwR00FHKsBBnUvIV3RZxxwuLY60pnotpO7RMMTrnBX2nxYw7meBETrlhnVjJ92CRMogXGK5COBurD3oIHKc40gFlUEKx0zjkNLC/FH2Tc1wzBmZUhCm9O4yH+65DFmMclM7M5GVNkfiy+a7VtwFiPm8iahtwfxmUMolY81ROnp0VAQDPniO/+i3k01NneRKhkGVAxp1Aso/UUtFm2wnPPl7DJlzKyb2qEKiZOSq4iU6OmAL2493MQnzndSlIAHWj4AC8nztA/lG8VUE9m5aN0TDtRY+Bk+6xSzbE7hMfUSZJEYsM/Lvr0NVOtat98zQMRh8+J8OWM8cgc3Ja5iE8vJ0NiCOdW54451evpS0fBCN7fsmBc0uL54XQSk569XzKoIfGVVcG9/vRytf0rnRmKVkAkzZEg1mf/T9ZgckdweYvaRo5tQ4pByQTwYqZB1ZEJz58vnHNGx5vG1eGFu0EwAyiTD77kJSNzIrEOdiV7VgVMqMV1gdIeUvoPHtjgy8P8fGtrWiUOUj+AkXfiUyNNKJTtLylImo6x35/QlInjIakRpHx+ARsyHH/UAB+SlnPeWjsGmUEkn0+PGI4usFD+ZimpCHW2JLPd5qYfY64is8B6BZB6HfjT8zzdKj8JsTIQC7Ty6AsZOPrmdVqtK53NzqyTnz6WQKXK+JykzNyBEeko2g32DPp6+5AMrGlh7FmEAHy0dqVbvdHVv2/dYdK85qUIyQbjonGpqfHAlSQ1tks8zR533RIzplB4gTNDCt7WaSKcg54wVro7MbRk5h5kq2zW4w09+68fwiDstunXCzSO3N4QfsW0XcrjN05CCXPfpms12dTezX6Zb6lmaVZtqDdkjF93Mjf+F3Es8tkWWxsg6WnrCWGD0hpH7g8gB76lUMYT4pCOcrGq0pnXAM6WpuDGYQF4PVbxJsnxKsL8mYCKBCgRtOTnaQeGcQhlb0bBoxbQiS5F4waX9HHwdHmEyfRigkb3NlAj5mOi4kcKXaAOEfuW2J4DS4E/mFCaCg7pPi+DOWBHhIvjs+qoPk15X6idkjBuaYVcalGMlAG1qfW8NDGttEHzK8SlOUYCa9NokWrHkNyDKTlzEX/sm9a4ru2PItziboFS9vYuM3PHVGNsUDcwr6ZrBTYdL6/ZjouYgxDPTIZsUHI9rK72BWoiMGOClO/i8Z/j3FUPQggY5iaN0YmWxZoPAXGzt/k+DlatGEI/T2xpJHEfwiIpMG2aFP3DsS774ld1Anrs3UxSJug08vH6+93Ds8xkxHNL4qrbl4D/yGf3AoMq63MCMS8CjpgxbEmDNa7xtSXE40TQOzJyW7t3WMNzR3AHDRxCQGxlgq5JErhF418UHHIkmRDbFvCxskimvG8U4NpmkZiTh903PR6hmk35mIyGhQN0c8usKxDUBoof200NVTSwxDi8EwtG21tbpuU81/6EGE2y2VyloM8I1WEij40wGR/qF6ZHjnwPXzO35ZepX9ttMkzIHm4iMZDnojyzy+I736C/fXvzvq/Ml/2oICk+XaMa7DhrGMrPVyejhPp5cEbV5EqZJmvmplpQoACiXzawHe4DJBKQ1KI04fWDCLdmXjj/vHw0dU+lBHECH4Etsr0IYEiY9JQk36aOcjr48lZ/R1/515cAc9QAF7hT29rkJEGuN/orMOsMZK2ISUNF5Z+TzYxKVzOIld2zjHG+MvojpKfe5KpkBDoVBuTtfGlID7nadvxnjklOnGznJGejjPp5fyUkSH4AeDZCV1nb3OhSDdNbdvMWMpBODqCMiI9YymwvTJFlN0E9SW4LDJzRKfveR5Dye/QNj06wchU1SeS/kYEFJjJ4RCg3c3JZKzkoH9n3wujE8ElHLahofRZEuRh/6z7PjkOc4KX0V4eB8fcwNqpXsmMopeRHS0Vh2dmAtyaDeSkNpn9AGbvUk4WYtaguTySkvWqGTBQbHstrBomjINguiHacJlBwALVmMhv2TxQzdogv0hL0l8Wc1namP12zw5GHKkcsH4uoO2AVZ+EwRzhW/TYx8So5sQw6BzC4IEPz7eo1dR65xTJkuPkCSM1d445mqS2NCdMnDHoI+pF93JgNJcR1F+9fJowzgVzIJoz0vmK1iUptem82a9RnsEyYXDbSze4sDGT75MSIIZBOhXXK+I3v4l8/dB2cXCEfKDB96OufQli/pm5hoiikwB7nt5+QkpDJs8+Wurk9xmQGeb85seIH/p0r0OxfRfu8/1qc4Cjnrvvg3sh6dV1fLCS50mCaUOu8Si5GqPOHArTNJOeTinPODjNMp2kt5BKq006a1KIRoPN6L84M7a6lwHkGEHGf8aqSfe7Ro1oAVv340thNw31mEy228+s6WgfAkuwtLZhtJONCxlfjziCBg6+nASElh7Q4L3By+HnmNiQManswUSiNNgXq2Y2wRjZWmKjDBVRhpFZIuvsh93/An1Urq1pJ84by2aKNfdQs/P1JfQ9etxLa+3dL7cfRdydDJhYtEAsJDWxlCuxpAGddWB7PZ4Gt+AyErr9TOiiFnNAxlih9cjmw++6fzoHMi5A0XCRzKl6n2iwJc34jxx03sHAgDFLj6Y+heBK2RA6QxY87+aQOefrszc6Rkdmwud4KJsRY56S4STmywMvmc2nBG4bWH39KrUuZk+9N81BH8NRjVGoaequaI41zwvfJtslzGp8GdJXdnOx0NrmN8dV5/SvDG/z3QyfTlbV39POLA+k/T50dDLPeFi9yXnf8UA2aPKwaHnWIWj2mZY373g4io0DL2QHQBYlVB8jrIPaJcby1D8eScw9Qmm8JAe9AFspfPHSwKqBa2fikon99367x5fCRlCeQPvllM2ZTJA5XE5P1e8wc3gdZoh+IlY2oSZhyMbNMNDISApa6dZCfu8N4s0T8N6lzks29mldnEIHeu42oUjsDMz99rZOKnQCmFpR/+btZc4RldVGjUMODAsUu8Co0l0xlcvNKHrVpFGsVdXmTRcaBIFkC9AsCWQbthGsQS/x/R2MIGOk/jG0d/9d/JLQQaBFxRZuNm02PciVk54kpe7059iCiaLJAIbnbZfkOudD53z9f3JJYGSmDHQe3KKDFECtrd5SsrRwwcqnMQwB9BXYZSTnEEqJBgFLzs4aOvZx4QZSVDaMkYM5dW1sfKacYsnBKCP1nNkuyXLvYK3vG2YMkMQRnnVPysSMG3Semk+lS5RxAFEFgIdsHdXSzccWkCQNyRNm59DGItv2LNTdC4uyjjIcLQ70L+8vyqNGqDhJJDQ6BroYb8ZNDCBgBTMdd+SPOH/Z/DVPXvGjCMyxuf4s12Op0/2xgk0EbpnA08bTI4CnG/Kygd6WnKTdGoM5twJahq5HU0ait/OtMYzR32nQcxpVj22KdzlvSl0mrz2eaDVz6zIzYnCSPE1nLvU0q95dAmhcZWhBqhLzop898BFouSN2jOHJ5lRQDjmPlvPFTE0zSBktSROx2+UgtDxARwawG1EpT2asKW85bMFgqBkB4pZh/iywWdaUWaoYnumpwHEuifyCQN1z/p3XyK9+C/H8OSYDkpp/U1mUF/c01zUNNt+C426eX406PR8KWxtHMyhFiGLieKbs3w1It/n2CfjGR4gvf9i3r/V4tw04pn/2szPnem+LwhO89YqpYfKnlyG8kGpNWpqdbl1jnALjkv9xZhDQVa6gUJGhByWcqUY7prTaGifXbCRkehsR9M2Ycu9nG7llMI2B7rhK+EkIOl8cVVSUuM35iOYhacA117pDO2k7e/wGlhKg8WDDx9RywfTw4eTkjEdW2Mep3xKnLOLQNWQCDzfc+mAYRpLrUkYZN2aDIBlgtkP/a5pKSbv/bAM/tE1lH47RMmMgLGiah0U6Em0DKv6jnRKhA27i0u3f61ATQkZOeuK0p9OcM78mmP6MGN1QdoW0zXPOHJvTgnUszj+LaOa90S/D0yOgo82hAxaBcqL2kFSKnXHMi7SM+/Ei5IyX89SyHsweuaQN3RSBA7Xtdc98aJR0rgFlKlABCY/jzQ08JR4feThQFu38NsCEFasZfoguMXqtnUM3QTxpF2ovOzPVIA+DDedDANwezO6Q2wr3mh857RO3VEgcFAETzITmMuMzfOM41adNOAFmBtscD1cilD1UbV1PypM39ex5CZLbEHaZdxhFeejrzyarw3E5RHcj0Toyqh0qDAbW1DdFIMpwdFaO8kgnYArJ9bP30EhjCGBvxMvnwC//DvKjt8B75QAc2WuXHeJZ9zfE4mOG087oAK7+4Cgs18JcMM3gGpDMEADksq0UDVzf+Aj44Q8Brk0FmPXF+PZkBtex2mipH4swgIpu1uQEOJk6kS2ILkMMMi66izyj6DIkMw72xdkte38i9X7fos8jK0mrNRUuh7Kh6cRdD7wxjxGRda+5SFAaRTnOEKq2MIomTEYWEGRmVaOTkDHLJUoN9++spnb6cO2PxtAOtpSi1vZRKAI1Fo/wCQgo+GkPEnonjVrz6S0K+4artrLxqObEugRuV9R9AAb69L+CYmH9RgJxCdldDoNOoycApHTACEFQPtswbfJ+lDVQMpd7ZK5EIXVWQcyHOPR3FA6+fGRurvrQMcQIczKMrDHPjeMD6URfPH/KDmtsu389T89V8DKRTixzIpBVNHeB9MONhO4ZoczYfIdN48TRSDRIaX6ZqT7qrg02kkeGYMhReil9In1U1FbzoJ6h8RAI2fXjJ/v4YLekSBmpcYrMobw/d8Si98ruML4L3CuSjFLSCSCwQvhJVimVHZiiVM0RwoBB8ZxakmxHpy/IZfTe+3rB7Whp4jG4l1PozfH0Z7OdeN6ZDHCS7Zz9SXA3bP07d9hkxGSaY3Rk9HmbU2i8n4GL/sq4q40zm0Hc2og+QwZyOCLGLmhGxE/rS26FYecMOLD/7tfqvcaqKViWiw0cbeTIoLenOViw0DJ1PR/gwAz0YpTP9VcpCEbN1q8Edi3k994ivvcAfOYF8nY7Bxsx2z4aodLQeEkZ9iCp1pU7WrWCDs25mas1KUb4tnWmhCJVVAfQuHGSfJckLuIeHhybs4puUUH0oAEeRRzeWPoz+9njlqJh1AhNj1sAsSZKARTpyWA1YM/yxsD2MHOM/KbkNwgcoC26maUCDb59B+dpGhC7US2FRNNGjl47TaGWIMMGJPBs4e999AJPj1VpfduBC+U+EnFJZTiIRYA15nLa7xxqMqzTewILo4UbD/Wx5hvxirTjAfO76sQioPS/Goz7vtOcQRunA1PS1nJip9KXrUt7uD/udpUCv9j73Z7T6KBHz6ce8+cIzJjlMWYS0r7jcLj9zkB4+DY6FRyCjEuPe32f6YYDXbe9wsZ3R6c435Uu6vOUrCdSjnrtQlm4rSsebxu//Mlz4ALsdTHdakMUkLF0LT4AVb2VLq4DB4x2NGzETwZijo/A6FLYsqH0Ts1CGaEEql5hDxaJVdUmMweMptUe7gwPcETxnDPPGaAaavm4mXUso5rUEz+ZNWD91D3/nF4KjEDMvvXQJrh0e3Cv3PdLCe5Q8Gnpt+R7cNHcBGubQGn2oG1O9n8CiezLf/I3vgk8uxRgsPc4zf+YCA8LzG6Y82ozavEMXAnUYixo9Ga9AUHvngDNK3ahPbUmT9BdU7FqH+Pvfg/4gVd1jiuf4wseESaPthUHT/CPMQ6aBAnPia8xhjWebpsV/mzbMw58jgwzWYhAB585wyXN9h5loJNB4QiJ6AAW3JurL1RcKdmbtNUUfRg4gTg+mZHK2GYbbF9vpCPA070HpRWRRGgOU1DWjzGFljP/erZpHL3EcJzZwMgEnQabVCzbDdcuDSnKkSKRrVil1qTL23723sIvfesF/pd/5338K3/0u8DrLDm7LFx0k8q7RvCwPP65tDiHecNi+56fDU8sJLcX7xDJNRXRVeP+bP+uhWrMWKTI3689H+u9FbkfiyMxDRoGvN4Ze8xH2Xr3zgCmnWoqjc42Bn/1HT4UtrhhL4tl/fAyFL7CzAOt3lHtid4ZPHKuId/T8R3ja+8c8wB4mNbMhfy54b0L8L/+6ufwC2/ex/UFsGN2rMzjCRWXrjXmzdRcLJHBZzBwMIrf2MlyPvwJIHyLGrMzLAAcUShPdHaj2d0tNsBhKfXkLsAw8Soyed0VyV+/ZRukRErmhdhB5A51KmymPQDAmgepYY49icYS3wly2Cfh5mD+TDKbtZNxJh8r45KW6ew5NY88+IHN5/RQU8ZaT7kgdB949gz4e1+t2/8+9aKv/D7V2sVXWdnm4chDZyNkIQej0VVB12TLnKwEJ+ZzGghheIBeznTG7/I0HJeF+MZHiC9/Fvl8aTIwIo/nBzHgPjKbZYA2WDmM5JIFbDxp793j4wn2HTHmGF5VaU+4KgmTt+sRRKYMPJo2Wgqx8tJ5BtjclEzDbWOb6DiMwRjAddlqvFRxluFrGnNktAHkYh/oVL+dcd9zlFOQGzxhSFmOBGbNu2WFhpFjpQCShJ5y1dcBCf1wWutnGWinYEDnti64vgf8d3/+9+GXv/Uc/+KXv4PPPU/syxURiUufTaAjIkRRszGJumWNWDNsvEvT1fjGme6x0MGxcamf9uIvLHDj5R6IvoaWWpOHQq+sS0cI0OUnRDuS1VKGX+PKe+prlFuyGjrGOGjIqB8tZ7FGQbbJZSV72/VPO8Yg+vN+f/e4IoBLj2Hveo8n7Wnbb9Nu9xiedcaOh9Uleq6tDpWV5hgaY9qZlpOBOcc9O8XNe943qMdNu5idKPQNmabljYA3wwFgztiJRSe+cSHrYJ6HWw36o6fAv/H1H8T//OufB151mWVMFIuWB86rnP+cS7GOUByzXKHK9tTae02J3GH+rwRdZ0MgjmgfLZPKAJ1ADXoe0sOQNs+4YvQHAWg7LDMP/exMY/SlaF5zvHQAtokLHA7u353j4IXddzt+lKOOCj5EjSNYbHzhyZBLMxsEMnLoAKmmX2VEPWvTtEKOrQKtGDFWUzrGSn6dW6cbZwNT74DG4seN/MXfrOhfapRG5zg6kXkStlDW2NcxoMNIBL78xYSMX1KmumNb7TUDM1vDzDgaE8cAdbtPG/HTXwC+9Bnk4+N4uTlMYIwYx7trQBcj2Fodo82h0YQRwT6vj+8EDTOPtjQCDmAcDclItjHMNIZJygf0eDa0DEkzyedMRsCMqoZ2/DXkJM3ZL60O5xjTxzSYalInTHE8AOhjnGOgApAL/DQ0Zxo5EXTvAid63e1AHkJJYGIEJ0ucSgOWAe2B+byl2KH21u2GpzfA5faID9cT9qXkZUWD7u6Di5qJ3OiQN/KOhEEbA4A1DjqOUz7ClkEiSCjD0ek5pf+aRxELcSmAqkN/+mKWvcFMVxmk6mQp4qmMB/eziyutuLsJY8fDSyZIv5pbHFX0NrDe/rhJfpXpr04B68wMX0/1gknRItikwHdzMT8CuW8yHLwJ7XKJAuOcnQkZ7eIE63hu1g8d3JMXdcRx0/6+KHnxgBnqcstfjyUuVxnQWKudlpKzjFXB9QLickFclo6hzkjkLfH0tJFPG5/shcfrS8T7ZYS1/VBqFjpngGOoMxp66xiDrb5AIMMypwHoIhvqHo310QkNJftp00L1JKy3jBOuXbOP9sxWUGYqM9hRtw6PD/1fomuL1EDRkVNmw2tFX9JZc9d4iSuM7BnsdXPqLxx3iKcnvSfeqjtCPM3O51Tf1ro0mwDaxiHaE+1zTBrX6BkmX3K+ArbURN2Vq2EYTkM+bch+ZSJePkf+2jeQ/8Z/BLx8DnigaFesD79CQF4ZncKe6s4y9R6USzgSVzDCc2L0QwQjHYtKACYh3dAliRqwaigxOX/nO4gvfGDEGWYsTWaYNyxtwxCQknM0MmD9IEFyRHQWCecmvhjDQEFqrXC7KedFTsBkHDjCSRWFFOuwqgTrkYuZFw1Ajy2pOMAZuXG+9D5Ja4wgO1FYQKmxNWGYjAjMO9of3cIyLOCgfR0Lcnz4/Shpj4zzM4Wm8EczW8sMNPhBOaE1ipERRenR1GbjG7kWnr/cyMeFb92e22l1w0+l2634yXlwOhf8G63IKVmY/brc+5aj1e6wDbOGj7YVZ3jOyuwoYyddaZnbRvV3zjtYM1Yd22b6ebx3Gxqyv0W6XAb4WGC5ljnKa/pm7YY7/l4CSn3CAGvJ3WXoG/1Ocn58J/pr6ovf0hkyzJMOX7O+rFRz3DH23ool5qie6b+clMa3mOK22qbWtM4L4DTBBuKpbPQl8PzZE27xDLkuxcFIXNZltth2n8rAGIbIg5PuTJCiMzGCT5/GR8V/1N/vM+8EWF08OOAUCXvP8GOeYTAV1vT0cdZp2NiBvkLXZNXGmEmHePfMZq4y/hwbeR8M+MbJ2ps3IHJMRNEAclm2jK5mPxo5+E9M5M2J7SWVM33Sa2zBUJhc9toGN/R+jkpBF4NL8qXtiBdS/e2vGk/ulgkExsYD74CD/P/HN2FBPXRlBKJ2g4RsUibJGlN0Y5ZXUcfBsDBCBXAN5HdfI779BvG5V8DTUzMkEZjUWUkOBXyBa1JMMdOIZ08u14zVbKbNsonc49NnCcy2ljvPNdOY4jSVhtTTLhxxJFn6eTOuFBZZ/BI2nUJmGF04EyNsxreDSRFTHEKQaH6v1Snuxr3AqiUH0ah6ojGWPCwzbhijHs3X3fwqIBln5LA7Hsl2RL3syFbRNtqALRqT+r2c2FZ2Hkoj5ed4qu2nCOSzC/Csya4+ttrpcFrz8kKvO4Yd8xhaEehixs0MSPfGTAHT8MF32STfBZDJyj9moa79r0c8RCVxfoBZm+oJGBhAcdkAgH3R3DKHjgcgB1C7gc3QBIWp6Fcp5ps+qyenCMsLRXe3Us4dx56V0UBFMHPvRRN8rWkzS2iVrWKNjAxzpdC3nrgc9ChDy0jpBHnXZ790BrEqelfwEHoPK9VOrKwti9dr8zKwg8sTuyN0XbYsXBCAN698mcL1nt9NASDaiJBcgRPwJ/unj7xBCiYwuNz3C9ChOuc8PiWdgZFAa1vyyCUrT9cDPAoXTQM6IPo9Rqdoe2JRT84MA/O/aHpz6fHIQPpP2i/2PfG+SkREcXuudbKzL8KKII7Yey1btEspbC9Hj8d8V6CTNufpcyLz4Q+eXRG/9xHyV3+3tgG2Hnkmu4aS0y7lJs2Oabk3rH9n3jDzqgnzRYE/R3eHiknmjOGYZyHUPEGtGf0730b8/le2Xn1/PMkIIgDEuoLX0DbZGljTjNOkIx3FQ2NrYNvZXh5TlzRglb6WzPRcBI45hG9JgvGxObLPVJRqYKrtaAEZwU7A1wE1SvJhmM4xjhMEnb53gGh/L0HQGJhqa74aSz3Dw5QkjezuA0Q8uifXJ3ALMKrzyEFiwt8ZDbXRz243FpWZQmsGmn90umCUp9VC/TWVSI9MRdlyxJspWhczZlF+RpCp6PNTqck6mGUunomRk/t37oBnpHtSfWn8VPQDgEWUvldbuQ/JswGfhh1HvzNHzpN6gAF/0bjf7/GpH/67Sb+DOarrmPXG0FhpHEpfO4I79DvnO8kV3YB6fitz405AlLx1O5nGj+gObX2k6O37rZlKdjGz7ACISw78gO8759XhmZi7HSBJHPmuoVebqwMW8hwcd7NN6eOFdPkR5pFms5R2BBBNRneWxGPxoWSrVim5o4EyYGYmQssEcjBEB508UP8n49J6btfeupOIJJ7x9E/Yz8jUYBXkKHGJh5h+OCZuiCjl0Xv9Q1I4PQWfC9msoa+NhjxhTwNRo8dRo9R2zyLCYKbog44/ss6IIq0oI823ePEM+UtfQb5+RLz/0jKXIVwY0YhZij4yLMRzOgiWQTS9Jt2qCJCHoHTDk84txZJKb0qaA5GlAs3gFGHJyURcFvIbHwHfeQ18+gXwtGVbezqH4DsouPNCj9CZxvOvfd2F85B5LMs5ckmGxqWH7WlGwDgDrcnR+DcSyAdOyfipNLYEIXq4Mqf4gGOSPe7ZlmlgAyibIYETyJsxYC+UPnZh4drYvRmjmw0fkQrrMEk3FuBARpTzswzS0RFhkkawe9QYg1YO90swpJeUWQaFr8485XTZnAokhx+H4aahYGMRIzlBKScI1QcCTxk1WSO1n7A0q8KJpkGnQGvoxpNGWJdkESHaWJFk4gaAe7CTLpH31OUGhhhH5IwOxqikWbDDOIignPYsX4w49peS9wDTmfo7bISKntvZC5gTiylQowFcwwuOOYLZijYaymg1gHNuMiDtAHfBJk/YK+PHzE7pf3aFfcTCjspqub55JB1GN/aRKPjBpei0O0qUYiWg8xnoDNuRxsxIsh5LfJfMDQ7JET4lsR9TYl84yDlQjZo7R1ATiFnnbyauZee1NH/kTOTgRPU1z5zqSkewHEru1hLeSlYm00Y6631SSO0TbxqbDPcUfEp2DIQjxibJasfcFgmXRf4+jm3aqxpfFMaUPZ525qTFbuyygI8fgF/8Taznzy1DQgBsju8NmFxMv44vgI6BtiDcHXUurR2XTDLdCRTxwXWJA+T2GIhj+1cR05kuRhGsHjfwG9/CnDAiks1/lbbKFo5mfgygsNbA92c6iEi9FRmEpqL23LBowCkGz9DGWxUgkxRIK5Um88N+7//EgItI1e+ntXdIUESn7dtTbMVITwFzpmECEYCuRSa91tLzuizF0scTiYwSCYDBv2OwhEojerTKkSYaU+jfk0h6TUZUW4z2yCDbFLgA5tmakxHTAw66Usmjwa7H3cU0dQ85vwv9zy/JqUwNmZNdBhCK2lLRUsBPf5ORbVr61aegYi+Tx8g2MiYgRjaqo2Ql5l2wf5LWyc15ql0c44jFsa6jTy5byJHq8SXHzcud2BUj1+N/I6cRUJoXkeqXY1KqUyDMZ9AFeWuyZnQM+a7JMfWPcrXJs0Neux3ynVixou5ymMfaETBLSIdA9OOyBsC73kEcJZ1aL9caXavHWEBKreHlWQ0E2zHQ9L6xS44vUsEHM2Cjj014EWou6AJwZBOXnDtRoIkQU2/E90zXAYBbDVl0ewY73MMxvCV9jyVDNc82nG/Z80w7z/7ELwWHJ7NlQIVhpCeFy+0e7YGl9Hti4IwXbO6qj+nPDCqAnN1qk+ia8ZFGtxvw4gXi7/w28hsfIa+rt5jnnKcheV9NKxJoQRdA8WYq0euUrqAdNdJcXYAQUVtduNaGGbSiaRL7EBQhuZFGCeN2SrLWa7/+Paxvv0V+5lltCTTlh6XyFem0MEwmXolEjHcEWvd+qLe1MRXC9FODx1S50yuyJQQyqMd1bJ8jponZ/UFaqgfo9eehEaNHnQmulPgIHgUi+nkyTIZvFyN5AqLma4AN0JueiESRLYEzUEIVwAHxhjuKHcg3FvQogquH748UVd/WiqTC2m45HkVGKeQ7ONsCeO4uwMzLF585DFt/lLL3+DzJgLXGG95nNop80HHSYDum3XSOgsBKSoR1Bo2xXjd55bsgvypadarRGI7rsKjzA1CkJ8AvIIPmfGzh9CwIz6yvcQJeYPXOj7XnJwTS+EmM7YROxSY6lpvtszo7xJ/gIFouxTsaZCogKWSCJ2PDcXemqnYbxIxh2zkjFNimcbAA0MaU6piVDc0np4k/u6gb6Lih24Y5YHqVa/DoMQR4bobzH4yCrR8aIDrsfIfZHU0PI7/EQeaxyoGo95fZAN95MFewdz9JvOYQGTBYVoG/02qFKKd2heVrHhNGm85SrejcLAy92RcQdXtCWNodg4t6OgLKVwbhc+i1mgfiQDQOH/2Fto76GCTbwjj/7+mOKClM0iZKTl8/In/h15DPrrBjWGcOnYEq2XftGpmeQkRD4TjcFYd5AFFFgIKS7LgqOw3WHZFg9p41lYexQ0+IXJbYUrFuCXz124gf/DyQT2W4qJhrYTyxOWRnFGDWCScM6umxepjjkneVcC8T2Jhd7zlzieg6gRgDLRgzJyBd3ZxD5kQ10J/r4nzfxmzAT4XLzGN8vmYzB+iEjFTtr+Z4Q948+5vurbhFVhCVhtYgD4k7Gd4FONwWIyCVl5OKEiRsEuLTI+LSAamqjASAw5BGmDwEdENZArz+kmvs2bz1vnNbm3bQjjstHkWJSzZ/z+jc/5zbAqs/Oom52zDlHucsDfzQ/cqJCY2Do7FhjbyZkwt7PTAHMgXlsd+jiGl3SaOQVyKPQ2sp1KbFRGfjCEPzTGUCRLt+NRmt5MZ5FTSdmQAvv9HQotP3Iku0mqaCDxai1p8NcDG8kgzQWvb8mKFYhh1tAUcnzXEuHjetOX7rhzIwjkDrxurMiuZujpnhRqwqItQIg3RwIZl/Z0mQYwiTlsKftWb+kIzRGEDV7pqCxtkE49JBWLaCI256UwYiSpdV5GrO3FkwB/ElhLlrAh04zctW8Lh4tPwyFPKtbXsaPewV943OMhcmsRxyEe70jyMnhvJzzoM7QMJGDOnP2Bwue9L5S303pmtkIHcCr14A/99/iP3b30Z88J62MB/88xqogAppI1Zv13VooN6l6M1n0h4M9GVAnIAwHYAfrqPozYR+Ko9NoBFax0oqZStFDWYDlwvyd76D9a0PgQ9f1MC4BqfBhBZZN1zwm8ARs2UMaMELFS9NsRSONGUBywXKNoBLAR7lgWLa+uz+HBmbzeisQ3WoYDoVsRMvs/2gfzeGMvvBVLwELTCedou9X1Nn2MwoQMATflCMjZUjkiYMj0huTZJgnqRDHsIlelAmKPda7O5BGqC6ZxwEBb7I+TiRYyLm2ExihXUIi1ZPRaXRpNEJvnI4l8bTAMK2pSnF3DSVYiuCtVvacmnIkEL2ckaDVm1bs6UywqDEkopNWo3D2UgyQ9FnJgs91smQNBAfmSUgYkCBGZ8wb0Tf9fzDXh7wZ6cjELxLwcflxpNpSwDCE7UbQN0eyazWyBfsiG9f6pszGiaqVnGUpuN67JmHGv2O6BglRq+aZuPUmzzFUrRagOq1QqyR6HdU3Nt4Y5hCVBrkat5pWStGP8TeEE5EzyWRtqRoBizOKn4Xl/mjx0o42oAq2mEixQfsxEGus7OvZOGgOXaUo5pGyyLF0WWecJF3/bRnEbLYaf03Tz0AaQUfCEn4TqXpMcVnOZqnemtnSTS9zuB3zu4glrtGj3MLUdIdUEMoGxWA60I8JvALv454dkGdEcKGPNvN3+l4UAZz5iTGQEuOHGCZA9qB+e4qXAmLoMlYzcgYywGRowlFhTT4TB2P8XcCZV2b+evfQPyJHwEYHWhMQ6KJxoYhm/aDYJdj8DMAXa8oL2eMh2KdoKag3yVQUAj3CHXPSXtOWxnnxK1W4j30kECINhiDJ54M0ywGM2VCp5ua2RZt8ghPaZbIN0sdo8j2HGBj0EBbyB38R52GfofY6ucAhH7u1FumBCuzoZsJDXBa5Br02X9bjzYSdAj6dUB9sUZjHIEkiG7IARpHS5I5Chx9DemEizYBW9cHVS6kdIU/ZhTIc3I0gIULJnrA8QxJmwg7sr4p0PxLAMHTG/VS061HNKndlIHggX/KkshJuZeb4aEMjIHPkUuythIhUKm2Jk1JgxjAkdmrydsaAtf5WUjYGTgtv1HO6ZhGZzrEkyja0KBFO2jdl3S2JziRcz9LudK7mH7ZvgwH+VpR6DYZrpqSxIEj1D8B8iIJ6+Pu2wsb9ZMcFzG2ZcGB/XBEFD+PcT/ksIIsP2MBpLH4EmeKW4EXsbieUSyZQKwLXWJEDq3G/KZMBbFENR76Ii0mIL967JbuVp4gQkW4LEBF5mwu4HIi2G9oB0a1OXM77BKxXA4ZND5hCKcuuLGt6oZ5rUwlK8f6IkkbFfy+eoH4m/8Q+ze/XZkATiwgm+FOMRwf6RjTiZJNnF1jNd8tJ9gD7UxeBtQGdAB3gI1RhY7elC0JaLE73nFzxugxXZfTKZ5dkL/7XeBbHyF/8H3E003KMvcI3IMOUxoEYLb/Ds3FiNQcbOJogq1oYrs5oAJ71FMtKbpqtZ9oJs53fFjSI2+/kmiKKBZ5uWadf6bQfbtiJzRcS2tzPXDCD/DK7qEnld94Q+GdClU/XYmyMLssBCp0BqlsJvzKXEipTyNsqaRD0ZydjAQSABZPw7J1Uwo9x2iH1vCa1FzcoliE5lID14NbGowJZBrhhro4QEo+nHw2wFRlGgGFyunjG9noQWD2LZiJj9ljQ+E+ZUMmDocTyfHScHHMbmAoN6Yr/FfFhYcUklaTFVLbPARHQQDZHJo+24s+YKgyNBheHhmkAfcp7DOHPC6aqWT1MIAzCOpldKPjvIV02CNY2Ji5Tp8Rs1NAY2z5DtIrJ/MSd5TrlOz02WMZjJbxEbOi16Ull2KcjCSa5q6TxMZzKY6yNyBZ356GAqjsCGV+3qdcM3sUx/cZXBiw8Wv7mTk4xJAMLRdQ0Ket4St5Njrfc+azetSMjtoV1wfTIPawsf57nhWNj4DtYABkTQTMvvURJx2yDXIvtchxQQKXhfV2I/+9r9T5/3m/LDd6VGqywRMWJRYGgzUucw703NQBVFJ6nKqr6CaidaeNfoctCzcUfLaVM1McGegIzPo0IO8hWgj+/tcRf+pTDQtlXAWwAWuHQAwpGbeIhARO9Nbk5DUnDmdZ6+xrCg0TY9QGSPl8DNO4tpOtZNsGh5C3NTwZpwKdtuYaJ7Ml2r5IRi8gaPMAO5IVbcR5noGvizo4NyA14+bod1e6y4h1G/EA2+8swqbjk1CaLSl0dHoc2IFBNa7HpW58pG+CMOOp9J0BmYQyGz9r3ZLj0U/LwpHcyK32j22dkquQbMPkSU42P1PzNMoBV0wC9JncL6DS8pkBX63LpTJPjCJJy7akWkLTMxgAZvuuHExLTrGqg9Y4BCO/JEOY4XVdtvYJxJQ7nNu+JE5doR7J52esYbOZdcw9kb8YZ2NqfVLNZEwbPExIy36SNUE6dENmQOvqNFogXwCBgrCKM17LjLMWo1s3x8CsWHXH3BqDGCxaJG8AGZMc4kscC5uqLmHn8ApoGdISooY+NOKojG6q0ZHUxuhbyy+dq6ELLENmjG1qvussjaMBVFvO46S8sBaMmGJOAH+KxCHHvEg03Jwrhw9LNJh6NAQwe0QeG+SMSOdIyuG75zwLOcHWBefQY1bxq8Ca7Vqnw8Kxs0jgthEfvA/8B38f+bVvAx/UZXm6kppjODihb1RfMOfahPYAHNdaKwgJDaBktf6+noXUFqXJaOUxCGmmNkJ3ShoWgxAh7X0Vz3E81wvwe58Av/UdxA9/iHx8Gk46yvqPiG6If6Q/Wqm8LJlCLcVjWnDASEbMCM6dC/SWU5zslI5hlQ9bosZxRsx6euwhfhhdRJTs6vQpZuPhGu8cdUtwBnWM9CXQWDqvMbeJWHMg6dpBk7HjPtxzKggsW5dzYMcYWikQ/5tVeW2UoXwELJ1J3rRHHZntnE1qEGbQxWfJWQ4fGkSCvAvMbY4uWmQvjWQrt0e37kTMfl8DgjXpN55cecgpUp6/4FiHH3UF/gKQvT5PuqmQqI2PO5jemkdRhmQFDAMZY9j7rzxU07jJvur5hXZQA2ZY3gWoNN1jdCpXxHcdwOWJvGudoCgcThajQL7AE/6ib7brWgwsw6BQ7U224IfJlrrFqlpIOfDmqkR0ssSyR6RBzAT0mYnwLPqWvC0r0nKwSEBzGOmY/7KlDFgtgWfRCGHku0X5ETZedk2MI0FnEqp7EY4MboT1eeCUO2vU+8UMXXeqZnwrtYMm5jmjz6nfnC+DK869+vdlstId033qoLaGU43qr6r8n7ybrpb3oRmdU3UAKZs60HUIdk+rcb6MUu+GqbtA8nIBvvEx9l/7u4gXz22Hyl1W52iSDojhNVFVNPSlyLELsHZ8itfzEwpFHgZwvqEwhPGQgEwWUEia+Jg1eArHzo1gdexXvg587lN9GikB29ZLrUqYnJIuM3oUEPH7uBNcGpGOupxZaoyeMMA1QPZ54peD8az5uVMyXhnG8zadW0jsZB0BowRmVyYap4caFCSIPWBEwXU3Up80PuU4uowgoaprM+akWYIFKBZVUvnuwIC0oIHI5Nrn/TKGgWbKCxEQ0PAdkEBGIBUViezp756AEtmzM/whMcdwFZ0PRQ/K6gBmKVnAmEEkGEPNsaIV2+Qiegsaa1VIF8kZDUz3NgsSNbAp+vUsC9PQPab+fjUQyomhE9QKsYM7sSczNpHh/fz476k74wQMqA5uh16TagWQbWHnOFijrXR6ItGJDmwYiOmDAGkg78Zk6pjcOF9GpALn+QOwv9VhH0ZE7I4YQ8oDphYzNabjq16gHigLgrw7L2GiNSB1Re9Utw/kU77GoDr2kpfedn8+APkOzMmFc4cnp81gcEC629ZGsYb0SDpcsB97T2NwnlJ/LC3dvOMzWmY+HAXiyz7nQJkQLTg2Gso4mxGhPJsVg/Mm8wYtMzcDjnJ6+O4+5LGWG5kfXJInRFQ50PMr8ud+Efj4AfnqBWKzFu4cb4DYek9iZmP4ECm/h44zyhkxU0ldk3T1AVNQ1AuxRgDayrUtRR6JvrCdbBLhGImEUZJGQSmfj94Cv/EtxE9/DvnwdAB6cqkg2c8wkEF+BMG03XmuN5PRMYTQYTMG9GPPxgwd/lCO0njESZTzbXwClaYXGRfWZqWHxyQQVD29dBrwYsJZQT2x3fQ5hkmz0Bx3/ynzIjCNTjtXG7XWv/d42jaQiUxpaKZKFIxA6qOJBORfmwyqf5dNUkkRPDoh0vN3hmDeZTFNgjAAyfnwnD2E+hHISXnCxoJzbIczZ/wMLi8JGQWMiqqcz9v6HEw9Ur3ocftVpMRPko67G3icdfIkTDZw5yD4uh8drroCLIwNnl2ol2e9GnL8oeja6NKTWfo97d0+ASXEHfUxy2WDYMoWmVEe+0fH2ivT23j0vKb0Og86Fu6dSywaDHXrHmQXdy8YLsSacwbI2z5QSmDMKnEe3tVz0FJAOD1s3oYfWvIh0MuRJe7lO5/vjN4yl3K6Fnmn9idoQSZ4vj4xmcuzNPyeahd2I5VF0niHsWZMh+er9WEi0pztkXIQ82yQBlNZ3sE34RDBIow49uo4syE98tTtOP4HSosHk/1NycKk1ik3k7G9v6FOTllmZYAzgBcvgN/4JvC3fxN49RKJPdsezaEhhpq5wWSQbbgSxxrt4jkbgGSkHl/FazkxWbsASMxBGAhHBA85Sn1Ul7pBPGSAqNUG70jJG1A/W4h/8A3gD3wa+NQzYD+Ba3y8cCccgNAGDUsKVnzPTrFABkARK4aCs446CC8zZSl7GftWCnnV3DcLRmSO/QGdDc22nBYy7PTeUk2aSzWKZsUabgR5aAW4to5AGJiO2pmQmH1RfJ7G+wCwLarwtSExof3vpNFpQnk2AabUlB9tRIfmc6SvuWbr69HuOQkE3PHkFNIKOhvMtI025AjofGy2IF5OWjR6fqDjpj3TYXMMx48mD0G6h9UyzgNwNFFTUspG96yx1XQvxjxxGBSvAeVQu15cZuQpjqxAHsdSG7BJ5g7ro4kMred7pVaPsZ1OapuUaS+hU/G0jdiATL/vvjyqW8m7JZRck85NRM/NHAGJUPdFR5cV/y1PNaVhYvaa/uSoRj4TYApljErLqzIp5An7WEYvfs5ageAYHIMcA1r/+j0dZxEBP+fdh3mcye8k6zE4djNIM5FU34m+slcyxjZkPVWcaPbKxUPjIezxwLBz+17YeNjGRPSeaieeDH3aNSGs8mROylvITEKDEOs9c+vORP1HrWc2bNHJnaxhjXHDi+ukh8lD6GbpQXSKBWzgkhfs//evlE4uVDu80petMciSng09VFtCmHbnHLSPE7QYF1u1yfjE9VgnDpyApc67N0tz+iC1lS5zKs6EIUyltpIYgpdiRd0L8JXfRfzJHwFySZiyBY+xy8wgKAKHnBOouE/zSBUfHh4sG+BAkO7LHKAfCCv2nMhdBkRCFgN8NNpeM0BhEDPGQE6TnY5XugZaV/Y0sHDubg6gI7CzruWkgWVajHxZPZfqAFuZgDZmOYqoLaItK9FALrpb/6mccSoNjflWSp6dUq2IZcCPCjf4SME+HSoqMI10KWk7AXw9pFtl0FTE2mhOuRQm3qX+CdiEE2auALtHqvWBfg5p3nSZzJHIYHI2NCTd57kBxyDnLk3PnQdgwr1+DEAUcDTlDxHhCWpJig4wcFnKfIaw/e1h4xt+CUrVv7ZQ+ksRh49Y387hLlMc2HrRrKjjmzmf4oEqzwn2S3/2P0sAyvnRIWRtwmRq6JjZ2Q5iLeUOGhtlQNkAOehQhqa9SAynOY5xOqk7A9QLpy6N8YjApK1ldA3HAEyUHOOsuFwQZ7x/tnWIKPnEFL4tE9j5GuRpwDAX/vlJQ/Rc5CzLlkDRtVoJQKcjSva0sHI4cNXGOsZ0ji9m3nm3dIA1FAxmppoDKkwU3LfotGzqG85j8BwApmo/q4j51XvAz/8q9j/4PeCDV4gbTyHt3XKtr6W/kwkelWtc5ac9HxOAIQhpnPOO+N8NX30NUJ3ORwL+8TobrHXiTP9nT2EZTbMz04tYYscA3i3r+MPf/R7w299DfPEzwOPDeLNJRo1gBWdnChwggpeK8FzrmV8qo8Ar1RUH5UDn5FuGiD2QAbrD+6ZSuTDaM8bC6HHMcf4dOfIMATa7ou4sp8RRQy0LI4BvyyWBQIruvseX3/vxuUWaiUMoIBpKKyXpdyRxw+mnEYmuo7AmMwQBGg6jOQ/V0cU41lVaAZCM/8mcw5iO4zfGguAhp7WBnICQ5D35Ar5zJ33ia9R1993tAG6KtkOqWQNcEVWUKN7g7Jd0Fdl3nYN/OHzR1eakQkPigQMOHkzvDsqL5x3NeFs+xzkagULhbgZBimjBHFgaPdxhJeRHZ3tYHLdMbvhc6RDX8hVBKdoZfSCPvRZB/8qyjSEbJ4PReclx3aTpUSqfgTBlvPSizcjF/HOYhMPrp/lvmbmrDfAUPJcNRldzuqEMQ7BgzhRvJKCOtlylc6j5EH17KOEq7JkwGfaJhXkLNh/NxBweyxNIpvnsceYFJ0CjSb5k4UYFjpM1FTgF52M6F7DnYsY8BHJ2lY0Iq8fSGOrL4RB3/eSZ3Y3Kyuh66sbL6PbUDwJ4dsX69mvs/88vAy+eI297ZER88aGaJPlAZhozfwnBPdOaD/muswLk1AC4oBUm9CQJ4JaajbONg6BUcaFndPW4S5M3ENEFEAv4ld9BfPZTwPNL3XoUgdy3GkOneYdWnh5vEOTYso18TpqHt2ghYYWZWTs4Wm2oumEp/BHyFlcqDRlHI54EvcmKCH8wCguOWg4Opi6j6cFb4gq3zGC3UkQQuGcMNfRZbglPjSadMA6K/5xpYDoe1fSemj0p2ozRmR+IOb6ylU83F3aYLOfptOymtdOk74xIdrcWkLcxEjrrZaL3pNFhHUySAlaFLHlw8KXSz3kHlV7useTqzFYKfAmgnk6rNrnL4l3A0WcL9p4BfH+v0y8bXJThMEczG9ii+/z+hsj+OLJMTZOWAN0PIIGNWVXRWLp9rosnWTgZuoTxLkjrymbB5i9dsOHNH2uMY3ciJ9+AnwC/ginruIsIS07IT84teukqAdvxktY+JMMEco6dWDNYPbzXIVIDa+ZIdLW/nDLXJZihiuk7OZ8xLHRCNsowsqBZ0a34ThcqZDyTn5OXlEvnraCmU8jlfel5zR/AFAwTG5pOmVpa47cMSGqsZkDt/I0zc8Cxdtvs+2Bv04hjpZzcPegOHvGb+ksLIp/OecLG5HD2G/bgFi0cH0tuiUVj9gJxvWL/O7+A/fEj8P5z4LaPk245T8k59R4w/aQdvttdcxIHcz5LGnvz5AdQdwGQMQVu014YWQ4DMLMeA9PAyrvr0x5UkzHvyQB0sclagf36Efl3vob4k1/E3idozLqzmeQV5SiQsbT8HsVTeBCHoZ3od9KPOmDvEEbCkwG1fc7ftXZ1qB4J2Z8LwOfbSYlPr4k7AMwZ9yhwSkCAcQ44nvNY4hnuuBM9q4XyYB3sqVakhRpImJaJKkfUOD5GP7JEB2WGEFYTEvZNwx2b4r8J6Ihdoyl/19aY/sqaQPgfXEK4O7Y4k+Pod1kgJdpS4kLR0qS8D4Vp0Ztq7onOl3Xp8ppyEjmAmceBCKM3xifxp9fKxy+cZapRBRrTnkNyfjNv0vJguc76n/FjkW68nQzTkUcilH1zvCSqEsRhGjMx1T9PgAzRiQ49ui3eGV9/jxwGAB0nTN5Qh53WzDgEoFQwnw10Rn7pPWqus2Xmxj+ZsSBe2JXpzEKRh8HI2NxjOvoJG9tgRDTTtJwRk4URvYjBwZSy47shjfOKSxcHv0pOwudIxxenrJTtNydn/O4xtn5ZgZ1oWmIVmGJyk2ExdFDkoEvE4J8ZU+t89JsqMyBYw9lDu1J30lWTdg6Pw+6ySUz3Sv4AcNvAq5eIv/EbuP3SVxHvvxq7BftxfejB0rmG62V1MtQXz23KbkyYbTuVDgBwPdYdmVbKnKGFt8ZOKpVM4Ew+Y2k+Uo5fRQTGA542S8g3cAPi2cL+zW/h8vveQ3z5B7HfPEBbP+7sbh0kRseDhHH15JB7cgRDVUOzwd7B0N6ujO3pvnmLEgxP+/NxRr+J6L2dy98cpaXx1ryGbomJ9mT8DtaF/tC6LEJCWFkKMU/HFh9bUciDvE+XdQLXvTVTJC8mkmjo0UZM24oihepHamfHOIyTcishjTYq2W3M2r6xhEYI0Kl+5VRsE/ihX5nk3t6FPOSw9iif+7QFKm24Ld0AICRzkincAdXOyRKxiE2Oduh+eCLkKLGnOnuKrKlpA0W9mvPIY4onW9R2YgpiezN5cix834z1AG0xUm5shC39GSiRTg4RYvepi8rKxPSNlq+59XI+d4wpgJ30bCumRFdZkn6bpynqjH9iEGsJYkTngEt9bo5ZACwc9DR7amy9tqs16cY6LkXkGLBjiZY9x/fBAkA+H0KDBJdQmHHiuQB0iOR8rRjuRWUS0RX9FLFsY+AX9wwj+x06VMoclujcRHMceBxdlL0oX5k6ECkpX/3w1lzTsJY8sMAjUzQu3Erhh+RRzIum4TrrS8wUBTvSdsuY+bFGq3nozrF0/i5rRQmn/oA6B6guhGcq5PMrLt/4Hva/+7ex3nsJXtde/cwAXSZnvz+djcZ2ALNk5lYh5BQA2Yen5XxNrOh5UmjqMiATNgrhuDCn8SfggcLHgQSJ0rybbzDroocZFcjKHO8NXBb2L/021qffQ3zmJeLxCXUQB1NZrdCLTkGIOJNFXdAWFAoqI60cBXeildL2soOA0BWT4E8B5RRGkChxGzyCttONTsIeA1NhBEdGgyBgmgCSqdI84zk01q4iFUqNOOmAGzfWokHa3xKxloGLhFVGhE9ozkMjH+es5cf0laGoZhx2ylUzT143veg8+tDctT2w3ltU2hb0qf6OWXNvenmWoT4JSFabXhOZBHilZtHyXlF6UGobwAJWdno2+h6JiFnzdRCEZRZQSLtdT6ibfHV7nxL4k3bkZUD+70E7M3xOh1KnXkFe9gCjWG3p67nm2Z75s6DzxCzbMRd7lwaXdRISUDn2PNthnP3xzZuGITierI2GxfaW/uQTx1LTMivJhwjKNC7MBPkJgmVBbG6QHosukscB4dph0jfpzbL5qP1C9XOkq0/nwDOtto1+sE+6ZWwsT6HFZXAO0YsYcRF8EP8kPtZeaxfm/A9Om7Zh9FE/EtceEMesuo+a607qnoVz4iX11RpN/ab6MneE+K3k2/SBB0KxE+G4O0OtR6cqdQ/p88KBrzQp6/oc++f+Y+TrJ+BVpf5pRI4MJeZdyRox7LBHQ1Q5CG47YqwGgL4l1NoGwKDmqvRFMoKEBiemmlEg4BYYzgU5bl983SXYhlV5C8waCOkJSW8eN/bf+iriH//J2vZjnnS1R8LVxP2a1Tl4hd1we8UIgiGIGW6Y1Ds4jKen99LmJkGaduixTyqzI6md8PSv9ueah/DO3KRzs7xgbJz5oIS56gdmttRWm30DTgzPmknZtNV1xLsPl+wICkGBH1U4AzOqq5ih9HnkvaY4L/iPZWD44cbQv6v4Wel/2J9NoB2eTtrReDccHadDUDOpTS0BosB/Uvkzf9IuWuH88h2lQgW0oWj8vubAUENyEaud2AQM+uFr2DpE6kC0BB2B2fpo/PexSQY5kZHj+5T+YUto7IQr9XAdbrWGlrJsy8CYOpGK6oP6STUsC9np/VmO4WmLZTQvtj9uZjj1ODgyHofB7OfHd4pxPqhLAY232hpyzAmEcdKD35Nm4hrZM1H7dofXZECODACdvMkonnKEAvWlJVHvhXIP8bNYbDsyVs1ko9vuse+WuwNjeywVkEdnOe38BtNdAOXYoGVz4NT4BOFCtbEU1UsU2W/j32QFcTSkbA0/S4DnPPjYYeM7stSkx6Q1+517zvHvCebCTqX1AMidk9wb8alPIf6Dr+D2la8j3n8P+fTk5tX67My0AkZXwKZB0xayu3Hy3uaTSI2vZPEuCOyfqw/AB0XGSRi6cpZR+BGkIDrq9UkNC0LMGah1wTsIvjfyuhDf+gT5S78N/LEvIh8ewFO4TtI4kEFGQr+DkYW/JylswtIwNe36HdoLmQZTtDlMhAoQGEcKMCs2tI5ArCXFP6JftWWpZHWaw9TlCh0HI6fzGZf+aeeK23fGcuVUemncofbjEqolqD4k/ZaWapCnceVpaTmpZVdSy/dI+AXI/H2LC8UP3gUgI2jz5Tr2SvDWrTN2sD7Ep/n3jCbskhqTFU+Xn4YFA4CJNlKJ3DzgtUdDB1BK283NZPq7mrUyZkHZQu1Rl1NZbS+dM1BG1n+Iz+dNZKuLM323O+lTxjaPys+gSmGEZEg6TgIN/gCOX+4z9THzckStuFeUODuIELBots+aMMNX69TtZOgMfnO0OadwAzEn881RqWnnrvf4KCNkKvGucQvQlPp367fpsOKC6CzOkSyi9PI8ArajwCihXo61+DwdDKm2LbAHZg2cU+zBznjv6NiyrKUitm2p54Pnmkgq6iVucu6OXXP7oZuoEI9olP3K5JpmO0DEQs94Sk+aotKP5qPokbTXRl9+F9PSfYpsT8SfpBEznRyj6T157+NTliUTeO8l4te/jttf/duIVy9lRyNThavMXAsQGFEJtsLGnHKGZoKT0WDgmeJ16t1hMObzhC0BAAPwinAccM2+c4S9djpRK/S3DP9BIBpYWZSDX0CMQD57Bvza7yE+8wr5oz8APDwBF1YrjzK+I6JuTBDg+fto4b6PpFsLuh2bJCyNDRp9q5wGU7Xt6ZuxLkBg5oGtUZDICwrXgI9k3UAhbSwiozk3wNxmwO9CCph2Y+DG2ApDDgOWnVtzCfHRWWWG1QDWD4kiCQugrQ19P0I57kDPl1mZVgQCprYqSRkI5jFZKS7tkKaDlCZ/LQe6VMi02YW0wUXCZWf7ywnQ6zmRaiQy22iBPBhDOQay5gWTx2xApLoUmXjojbkzYdks0uKgcRy/j11gNmmUv8jLo7n5Xi1d6HlzvMXfpvEYTI65nMbT4IwWnI6g0/LS/dHYUb7H+VCqWVg1QE0joHTpojxglopoLJq2OI4AHsQQhnGU7F+0N0eFJBGC+2FD9R6r9isAYHTPq5+n0PlYujPZJEvPqHWYkZQlmAwoY1p6H6hb/nSAz05tadRxtZsGlWKdVkQJYLmcjXKU7OYhC8SG3Sn00XEI23zZi0e/j1iabqrNgJ+LEk0T9w/uY6eRf8p8v88xNKYdGV5ryCv+Z2I0xOa4SAZaUjKRl2e4fPyI2//9bwC49A4rzh1DO9HxtJtqjWDAiTXAmmUarQogTV/Jx2GXrIkQ5TqTS2SfbpScvRlDN9yljCdonka4Pcg5gWWUrCtq6DWzL3lOPWhkAJdA/s1/CHzwAvHZujaYF30UY7f11wRME58FCfZEqBwzt2stI1SIySHQIYnjVNgjlQvNsephuCzhh4CQkvWQnAEaPQlHz520PoAG5myFjMmiAUkzqBEd6ClOGSFpIY1Os+bulHPOMxq0aZfBzChia5sO/BnEAmBRAbisMuuFBfDMEOVJI+4/VyQA/Sg1eBiSpp/JHS/ieScZe6n2KrjkcsAoED9IQKsfyXHZmDUOO9hEaTN7XkVhsu4cNwHUCB6ngRrwgozjwR59J/bpO/1o0/U4lKC+oDJTPUBBQ9mVvkKZ/QgHprD0xOoxcvV3O8z0BU6QaFpSGBx872SJeCKe63VQxuQ0KhtBoz3dpj2vlL6cgpzuk6cn2th9WNrmFjZcU9SYoXOb12AEl3BaLslv13NtyakB1Thz5ER4B+FeiYaNGRbASD96jr2Vc2/brip6hmhwnD3Qf+t8AsuczpLS/Ii2R7utD3KoMYQCwDNfgpgAZl8Ck3YYWShDOMSb5R+zByYLY2fq93Ei2vC2LWDSic5V8mh0jMwnughdxcVCbwCBdbki/y//IeKbb5DvXYHbDXPIE+1Dj527bHL4ZVQcogZDpuNT0XeK/pr3VICWCS4lqfAQgSsV5D6tPN5PwBOaIGM5OKWCSfwSkkklglKKoLLuMCpbNEGjQcZHAI8J/PyvIf/JnwFeBHBr0ljWQQAvZeae/3FElP7jGmKexB0j4GnV+r6u6hyFn0iAXmwOA3hKVqjV7mDmOMsAFJcR8MPxcK0SP6cQS/ydLzEttliq8CxlhNifnDoOLFAnrsGUXVo6Yu5ORNIwUfiZ5urZUFXuUFu/Zn89lsSRDRPcRPE12tlwnpfMK5YGdJRukyb0TYNZ4PRm2msWvobe1T9h78tRvNWaus9pmHIqKdfvAsrKkNecYFIWuKU8SEMbUxMtD0DN45kjy9bbPAeMDRAO/YlxxqLlTN8Z2xaAtEicuiuZnH62wJvV38SH0+GQ49N6v9iRAL2JYeOff22T3bLsCHejiF/2yqIeDG9pQPh8GZ5JYXOLZGZXWB/j4ACi5cRg2k82lK2iwz5OwAH5Pl7Nmd8HD+h75/nSv+aDDY/SOC7AtDuUpAHckuGzwLl17U6F37nAaEyCdNRdewHXPU87szuBBFvI4bAZRu0maCdghV0E1fRRzdhB3OFBSxx0iiZx5hhv9pJKasyCBy4hpShU1/y+eoX8q78E/P2vA++/bONvuEmmcM6knY1xdMrP9TdZuLNRA1YpckLfhNpUtqplMuJLX0x69aM8gTgTy/KkY1odIfJIXw+PIUemIkXEGO8CQPeM7EQyvr8C8eYR+OIPYP3pH0PentoQ0Oi6fiVC1xTjNE6UCOhhMQCgoTMPkfOh95ycnWUKso0SIGlTqtippbVp6OIah9Vjv+tJQo31cKgomFKSESzVI9zYT3/b3r48ar4hQ+DeRquePMWhaTRhlWU41pg1IRLizErgAr/3TjwDMKo7bSyMcs0zgF+4wblsyZhGKR1L3Ecp+U5Vr2gvfGov3R1cdpDnOIcw9Y92+PLdo++QEeL7lFPFhV2EKiehwXmUfpR6VMaQo9sP0S9O8ADO2g4DkaOA153UcFrY0dJqN2gRQCewXzS+2u+nBRtDZM5oZbYO6e4Dvma8vkChKM3nAhoxZp8K8Dlkjkvo53oYbRx26lyOBBRBC88A09/Kpp3n9YfIwyyQjCR1UsaMw5u2YfJTY1yDGcqUjS7A+jj67QYyrVgzbexwXRmjRrg7oklbnhI9+Qn7tAGcGZzsLYsz3iQXukN1xwlgTi3kuOT875zttlR60pacDfTx2cZ3m7vwjGMx/fPaqskWxPCX9mUn8P5LrL/xD5D/9t8E3n+Jvcv4rwhzyrLrnDD6ErRlXK6iXHK4R8TSmFE2jVeVHwWJCnIPxBg9a1y/uveiyuoAeH5weemcfysKjSWKoYU/597S5BOGM2m/I8mMGEERmft/XHd6+Rz5m98G/tZXgT/yRcTjVnry7JBRjEWmJf0YNgd6n5ZLUs+Ghwi1UMuQFS1qnt1SGsBo3DFLFNBhirMOyaZEAr7Z49J0bCw9v0iuGRsDQ9SXMQVtRAzfUhXyM3YqVdILDZmaNtwwAJMU1RrTQu8QgNqB5MicmQBMeii105hznApHmpD37XFzi381esEcIzspP8pa5nxOBauZjTedy5w+uBdOCoeBxSwTlPhUJknRrZyaUjO2y+zLrO/WU7oXnLRZnDvJ0fLDFg9jWv8rXu2TTnzmKJyzfd0wkWJkmhWpz7lTAxMTOTR9+7Kozbkvr/i3sVPvNOzOvLF9z4DxOepGjE+zDQjVvBsNvUM9TGvO0+6mdKyQax4o07FjjLxsSSgTNkZ+nBI1mdYH6xTMOdD4u90k/bvAcJgzfFa+7ah+p34RG0cmdXAYIcCg8f6HAW3cLXMoksZo6FDVzsMIFlXqyM2mi/JVyqDoEK0RtyGCzg0AjkJS0sDhZ2AO5unX6LjsdCdzqfRiG0e/NIj9a/Ss32iZpGPVYPhOwXaMDYi1gMcb8P5LxD/8Bvb/4xeBF88ReZc5dzqYqWFPx64zYeLcUxDeP+fe85nAjgQbqTlW6yUY5NQPfyEZ5ZbCE0VnUNlML4DlGhNBopNtDtYtiBqcuMO+DWyJAdz2MxzRjyb35hH4oz8E/PQfqKLAsOdlhDSi5vF1IoAEMvdheH08MnI5BlEGn8+2Gzdy35Git8e1LKOSB43oVCJ/l3HWQzEZDozDxbHRtfcilA307YCGKOn/kqaWmOsKbACqqKaysH1uRdo5tQb1n9s4QckRkI6GTA2oOhc7+c0YqsmaQPIwNCaUL9E7+3n5xEkAnG6lSNMsoJmfAK4HaIj4kjlRReR3UTUQUzzJr8yQT2RJhzI0PiBtvXehr+fBkUJGHrLh65zFF/fsaYRi9I/6a++TP6IAl2z2qQ+ncW+nxB0/Gro2Xr4UFDHZC/E1Bgu09GHOicN6XHqpiwbO+UDZ71oanhio4sQehajoRoV8NUfURAZc0JGjuNF3h5yBUGEjMwrt1J0qrIGrLzkFIXmVKITtVMA8nxixmbnPfEaih0ikpRuVkuvdyxcznPuljGPdnviN0JxddgseY+Ssn1nmqGp0aksNQ0cxaywahegpgpqj6zYlNB4/wMz5ZGrHMeRgvPhPWoNWbYyqMtmc0Qa4a0a48N4LXL75MW7/+78GPCbyEnXWv+qQ+jyLQ+KYhfUM1WCVZ7ltOvMjekBZgMLbZdG/kAFubzn/K6O/uWmN4JHIvN97SeWGyHTUCkoUo4Ha3zb1tuhnQMPIIxn0/ybw/Ar8rd8CPvUe8MMfIt68HUBlJNuKkCpoYup8IiHpPofk4I7QHfSOPJPSHcMmunT/U6w2bB6azXriobx5OzMZTStuyRqRqd91lKZnA9pQOx9AQ9LjmhO2bOruSTfQCew7vMruazHF1qCyWdMATOHVQZLV1c/FUAssB0jZeytairQGE0p9G33MMA+/mQloEG0ZKHEe3riLxMzOEE4dAF73Yvit43NBmTaKK4KzCQo858/j3Zbf0HkV7J8gyfmHUDKxx4D0+0zI7tz1e/OLB2hVxDxr4oQFUjoDc3obPz3ypRWRzw4S2LxGb+vExT5Qy2yZtuL654zGLZtWk1rTbgyIUcDGLpgis3jTVHPR4CY0X+r76GAYL05eVgCZd2MmlzpzsAIsBxPuWduUReqj64KMV9g8RV7b5lfMEPZK6nL6OjKL7/CH3XiDTZFg6hmT8WJAaI5kfr/lWbapCaVRk43OiHK67d8NMGzMoY9MR2bSPW5vB5rLFEIaRlB1GKR2eQhFyOoLITcgxgX3a8oRMdn4APK2gRfPcX39hP2X/mPgzQ358lLHJuoI7WlvalpSen1c+35wMMw2hGVqZjxy6Hk16R2+sj1lh4dcAHob4LGNzxhGz64cC/OY7Pa6tGN0ncjHechgajlQWweNcybViZzjJPlmoIwbZ3+5AD//61ivfgr48FVlAlYRNLvqPTCmVillm/RM1MYRQ8zxeA0iswDU06K+Fl3/WT0/IQ6URmwh0EluEXPRUfNQItvznb6AyIv4ksBEvP08hUGRlQmLsVSCILCK6EA8wVQ5O+XqB7jm25qSeZs5J5VmPFbS10ztAPCI4Dk2zwY03dzg3r/JacthkRPUPWmrbKqfyWiQ4J3pabktxaD80AEDxv0fXrtDKyfkTjEnJT3vC0ab3nMjXF/3Sj3r9sZxCpF24QrOKppXdHJiT1reI8PsPgTMxieJHThMrnGTx2n0YSaHrSe0l7tVHMmoiSdrmpiWMIO7jSo1O4GGsmGCo5ixZMlD2XrLkgR0RgJoBFzoI7SlbfTNo2ZaCDuitYGZhpwGKSwlWwANgJE1AwzhBwX0zDjICBEzMBnFOQeiFCGaplOU2OPwLXokj5FKs1cUnNoeXHMwvVJgxHHsGY8i8emE9nhkV4qoH+EM6b1JZ4iWMN567cfpHJiNEFAOdo8POqhvI9AzOweP/BnPnLBP3Wsz/xHO0FlCoJZBnz3Dety4/R//feDbnyBfPkPe6tKyGvE4UgCLFbcFLIU1nZYY2tpc7rPugztZ5+bEZD6SWE6ec8fKFBaU7ga160e+kAcvEublN0P6SM961y77STLZBzuMOEF7wDeRffnCRCLirQTGtl7ICKPWbm8JvLgg/omfAD54D3h8uNPhxEQXMMMGIySFo8ebDtohh4fpIp4UAN0e6AoNIGlkmthKo2O8uDSQLTRrQZq0KUb3ZVy1DOPtOHaTv5mjH+BpYRwmDUEvKWj7o2VjuvFDzFIk7CyAOQnDveNNCqy83TYe6wDP77NFkvxrmYpW8s3sR7epDqe3uzn0eNx75t7/u2wC7E3uvuCYZonDgJvKk8MXvZcnFUhzN2QaaYwMZYOECtruwBR3xmrAlXKLiXii53sQlstIpzyWGHT02gA7jv4Ar4zlaCK6sAQ8JbF+d4DUxIegd9QBIKMpUI7B94n8UuLCraSBMUB50PmOvc2+9A/EGiqRResaAIyGPqj+bDm9zWEKOm31TrVU39OGuSN5OgoYAWFQxPP9c95zuTkdPGuHdHWiwL4m3dLpSB7OJT01lk65L6dTteL1Hok5nCq7c4ky8TUMPRqHzKaBgYmcdH4hhydhyibsHdZ4ZvJu7uA42bbPo/4dOpocY+S0Inv0sfXX4stf/g+Rv/Gtqfi3Pp3glWxcqK1sFvE7lgekb3KK0vk/KE18HHlJ46E0dZ63cZFkET/yhbwfrzKOLaD3AMvtWACBNSVM7zDIeElz75nXmC8bc0IpF7ZSPW/wnmwsIB8T8eKC+NmfrHMCHh+BixUGGhLkbaulIhvPME1KxAgecGQvaHh5UEpuW+s2TkuhSDc5Sj0XttdrvtoyKTAPcB+s6zEkp6cWG8lqNATH9LZ7xhlHZDlMhgH2OD5UqugHxkC3AHaE4LInckpGDPmbvtoRIgM1UfLBslQr07A5ZIPuNCYTifFvfn8+j2mPZKAxhwOMdT0vwaHXI4fCS06+n6HDwXU9E3MyVRknGYP+121Nztog1PdJdK9AZ2Etjbdot1YXH1MWzXAoauZaZOm2HPbvU/ugjMPde57tcDnjD2WDS4VJ4RUKmuJRTwjafMuM2+L1xPcMOy2dJXHC2g3wcKFklWnT7zSCSX9ndIg4RpY1ZnDNl0ZwLeVpVHi5bXwVIa4+JXowtIzlmQLmP2e6P0Z3Aeh6XJ8/XKTCm4MKpyNajquolZkxLR3GUoEz+UT74PcQFHQMro68Lh8EuGX6dBh7FqHXYRWZcl7Txy9bQ5mo7JIcV/EbQN4U4M6dGtM39YZsz+P3oPBWwLYWLrGQf+k/Qv7GN5HvvwCebpL5URXjA/W9G/Ys4V11OI7tf5mYglU65NB41bafZJjWVrdhwjoZgPiRL+Rc5WumvgWQRJ+k5xjJU7Q2vGfJMsVfm3VtcBGWog85ElPQcGdITHgzAvG4gfeuWD/708gPnjUD7g1QT3rz1EK2Vf9mWix6WH2A6yrytJp5viXLRj/zpXMz0i5m39dFzJ+jNBrKnghvMNIMIcUn7/pNO9DJj3ZtA3GqTHQ7p9DygjwuXfAdvhJg8dtdS24rWnZmThO9nnb5QAb97sYv5QDC+jRkl4FwMKID0ONLzgfnfHoIBV4cTsCzI26CsmW1hUa043q7+7RV3IrRL+EZpYWDDR/4kMVG6lt8RKsmtMdlZ3v9rlF7ooiZs4INhL1qTo8DbwNIxPR8yHtMTYJHLDxvQRXdXUzlHGXAYclua4ZtDh7RaGjrZdNH8RURvFvaLN6SoV1SOxlqRu7KOnAw5qBE8Va8x5rShQa6cooo9xijTnujOczvM1rM2RF0sCi41iasy3PLJw4j4wEY30fO6MXnGBrLeQUdEsxz/RnPmRjHU7lWnAEk6eKOvCNA2ZDV2O7fuQ6cOzDMCUNg6iSCQIjRNExwFIZ2YX24kyU6Ceq7i3LY4noF/k9/HfiVryE/9aIc/iQGTMPVVo6DiAPijvmp5oJzE3cKa6Jp7MEf+5CeKVs4toXnRkz+blqO+JEfkikRHRwh6aXQG+3PaKBL8rYEQEv8/b6wjEUKd96RGxjOhh5OeaV9iE/eCR6iMgWPt3IC/swfBD79Anh4rKNAtzoWYcDCQKfeNiIfd1Vnl743lBFMzfZQyAgc/SK0TxppZQIe7VpkauOjsWMBHrdOSRdUexFqY2xBPV8FLq3QSdMOZdUMczVe8Qc+V//27h0qBivYtYSBkZN+Z4Q0bO+r/iPjMtg+giz7ZQbKf4ZmpiA187lRT0pXADOd+gwnYtoJM6y+UDFAqf+21z1HJ2+EDiGi0V7HyW6nHFCFhrhcEwfllfcxkIZ6J0aX4iQNeeOGB30j4qnHKJkH52w80YjgQnaA+WH2RYOU4TlpPVoyJyLO85qfRbyrgXjmZrOkcUtABcROhzC8eEdnCO5uWJY3fRoPs1/ZY15rHAdmMkgHPa7jcyvToCNz2Ukso1mPuce3PWIj+Y0VozD8bmgzhXnGxMNauLJMxmq+x7vFnpldJGw1C5wGj8HGnbEUP+76tL+PWoygab+zRdZgqh3LCQVABsg+mABXQN16lHnoGx0b8g6ojIgO6zru2wjE9YJ1vWD/n/8T7F/8LcT7dbuf5KD5doxN9E/REm2kZ173z9TA6/Hun8FouLoyW0XsNZZ7dlDwl4e8VA3AvbLod3HBfmxG9PzyLvISKp3eYB7SAfi+bE0WdC64VJDHaGAAoyKHx4147xniP/vTyM+8B7x5C1VZclD9e2rLE8dVwpMmGFTKkis6Lee6igjNaEhcJsC3kW8jNRX99ObpbOyZ84jNgPR9JkN04lem+DbXd+htbWjNeiRlgFHZHvuMn6gpm6fTV7Z4VwV2h7uT5uIUDFHbeGcfy6xYNn3Me8YSOOpH5FEcYppyAEbX3wW0GcGA0DhmM0t9oHfbCAgMNbF+1H6nVx/Wr04t84zMSAf6BsyhP4dA0Jzp6Eje7vY05LY2vZmmn2Uyrv8fkhcz21O+Lboaatz9EiZXQnRjgqXV/fVkqpxv2TFkwvJ1jFRGKSid1ZCMuhl0CoLfIkl+C0SLIN0GJoBxg8c+JYstIXTaXH4wgJzoVc1ljhFpGfe7S8cwiaekU1CkQnNI8C6K0VPxVoaDNB+DA8qC6zCiCjc5YIwBOw4SYj/u6IGB1ShiDsmqPyv2pJ5wZ4pstg4VAk2MGfQ0GlNneeIjsYZ9EiOa50l+7DMbcj9PAUlIthXVv3iGSwD7L/888u/+DvLVc0Sf8kd9z3fI3XwkrpZ3blhGmJyA7VjSI70k+t1B2xxpJuXeDsITT7OLzXmWg2HwGoDpNZ2728DMvDSB/fv5dRg76WliwFG8xaNsIbVqeq+ZFLcztNQTiLkGouVWoIDt+UK+fsT+q38H+MbHiJfPuWdpQHiFjuWcgkguOXC6sw+zPH0Us+qTgZmYk+UIjloDdqdDgzSAJlOAWSsj/emBOsisGOUbSnDk4Dqsp1Y9PRgHKA85AOmT2jZV1pjqoRTd4EaJdk99R/9f8zisLTkjNn+RI8R/EoprkBxwkH8EsN437QZH+ZWs75cSyTETl4GwtoM0bgPYdB/Xxfpt56kOH9mjlGwTRa9Y5Mu8PsqL3rkytAqUgUBcZimHbawZk97HOMECBNKRumt8LxqaPhgIDBtoRilDBFAMf7y9fk6fe39NBx7zPG0s4Qqrl6NlXEWVbHctEuqok5BRdOeo+ZbqZ+apU+f6u4jLyIL/T7I4ywubTgu/X8uO942RTZQGVWbAUuJNNu2X14BLN3ikbdh4jwNrbJ72UX0uYxYjQ8RpZgFbTzi+bH2ONow1p5YNRvjmqJAOgcEnWD+cBzMjbuA1J+muz56jHfkxF7jlY56uQIlOLMlP92ccpLKonv2iAzK9S9+N5ce42Rb/d0vgxTPE243b/+HfR/7K15DvP0fsWnJW32Z7U3jRVGwM1U6pzvAlOuvDuZGiOe4uW5wh5gTG6e2ZPqJ/Rw4mHLjHuX/pi4fFUrftqZD5MobtSVTENmT1CNKHW7iXByOCgpiJOpXPnm0xYMTCxoJcodcfQPQ41NdTApeoI4O/+GEdHBS2fuZzbJ64ryKPa/4jIqZFpBExWxPteT8vvJYvjGlNfzly9hlnPczknvAcb6QVZDxmu8HQecAh7VsZwMAQnv3H/ZvFI1WhmwJxelJay9SUV3tf+8GIqdfsZfPasYmhE/sVGeSEkt8pf0qRDY2bBL6pl3zKzjJHNk/DqogHiyY9yxGs2pp56bPrkbUkkYAcXxP6AKA9vHurDY9l+6G74ryDoiOf5pxMJsR45LLkf4ORRf7/+nq3Xl2y6zpszNrnnO5Wi6IlUxdSJG0HdoxYDwlgA/nTyVPykCB5SJDAAeI4iWGAtgXEkWTJViRLlMym2Jeza+ZhzXGZtVveBE/v/X1Vq+Z1zMu6lLb9+DEl2+DNNTtZFKiGT82NMnGhztBKZjTMWbUmjDjyuRh+NH/N6o24omN10y4rvbNkTl502nqpDq9jQSG0iQBeJLCg111rLhy0AQcIbXOlcKmrkX/PNIn5Z/J9iRZVqpiAfU9yuM5xCAXS1pP2VG78vjtUWSHe1hf9tSfIKJHxYuSi3oT+Yz1FHuQYQYcj4rEzPsQycuI2iQVPiIwE1fg/dnbzeVNYNVwJ0yuUcPQiRyQCJ2lukRg2sDuJR9cZ5xDPgXRpf5lVJa8N/NInwJ//DPiv/nfcf/JXwAR/xsVMAOQh4qPAbrSKpPEHF3w+14P2UD3bBRMAHn7CpWjH110UprD0GfGFla109+MfNI0AOFvHKJrA9WWsBmQqiGC6Qoq+q3igjICuVPP61DaYGjDggAaDCR3h4srUm2MBdRf6fsXLP/ox+u/8Ovqrr+UQZ5W8AVE+riA8QrsfJ7sFZ1SBWmcM+Ly7Jkjv2O3JZIFBTXDiFkOIX04KaBB954ZtTIo4sNzWgZ4Lqc0BT7JP3fHzaZXOuFp9Slk05NTnWid36kR06LHDeUn7I1HMYMNETwuOh0+9KWz0TKffJyhSQ5SBeyVc38EKAihUbr+skNt1nTelPSpkUPIZiHjTiTZSmWHsVGFcKxIxGd2cgmeDnc/gwLY1gLY1uoxgcGRV6ff6WUd6j0xrHt45Lz1fWO+hnEdFNZe4U6VnAae6BNzR6fiOxDmgSWcVHqhgNiBZdPETPI6G7wg8OdQJhmyLF2reeieiDz1ljFMFEvc3etHHFxhZ71OJElcot/geE1RdiY1VVHRWKEyOmcrTWxobPtjCMnSndboojkKmJ4eT8oanuE64Cv7XNT5HZFdGSSEQiU891kE4UdmTTNeS7ZoehGnItUSIBAw1uhOOHqPWdPEzgWJikwmegmR4KvFR999nxuqXPgX+zZ+j/+t/gv75N6jP3gP3K1i5Bwnqxmzeh4zbxfSOo2/5DQ7WT+5cOXpykElMWvxj++iSegGxC4BQaTCURnSLtOa5S1V+qcR9j6pW3i9mxyiE6rnoLQSoQFgyzqtt3DLk7skIC/jmI67f+QHqH/wW7teP5yVB17zYA3Ffs33lqY2LCUgGXwXLJVucI/SCEDnsBLq79SKeDJTKYAdpT0VvV9FiPRjwuqfGquig8HF6NIM4V3/6xR89DmgjgIFfycW4RIeRpGoDdO5m9p7BoW0gKRNl+9ZrQrds5fYR4dE+cARhkGGQGrPgyY/nUi84pSU1CPqMoFu/tFnxGosiW/RBOpIzSpJnzAh58P5v8ujWclV2xRgAKX2OOKN1bMfq8ESuWRl7OCcJPIIjOzvjc7IHVgJ87XCCM8fs1oth0lZ9Xvy3v047w5R4lG147KygpWdyLdnaWhxgTZefNL/Fmkbp9YE3kC9mADi/X6t6NRO9GRlS7xnu0TlbtMFmS2fih+RXNk6SaSdjDVM9MoDzUJvTej86vLibYRg/xRGQ5/Ovn5GL9To0ZIduCqfjl60k6tgiz48A9IQi7Ueea60P9a8A28ig9yapRnhCBjcaFZVMWUuX8HglNPLRAgyIOvp8IFCR2jTU558CP/lD9H/zz05u//46cWQm7u2pJKzl38Zt2gViCjVsjzIYeoWXNprQayQrwNuEB4DOd+GrnqkH4Uwv+RZ+/IN2QGJFBAUTZxytoPh2kUIa2QqvXkBB3k46BGXCSiCEhlMZGbBsPxOQ6lTpaxU4Cl13BLgCvn7F9bd/DfUPf4z7wmwTNPCL5wSHqDTBtkqPOlmtMeMHtLDciQUz4wus8MEALSjlT1T6D8mdQEijCoLbzufKbGjitElWrk1IjowzKgFu97NlWnwrgBLo9NkA0FRXK7Q3lUg7CXSzB1jmsp7ht+kME2yJTSjbgyqvtCPrVp0YcyAe3F4oFI+t5dM7lBqi0SjE6ggGSVPSkJVhodzSrD2eZCDgwNIXh6zhARpGEl9Js8Wa9hs/I3+S4ybhtk37W4dJRSHA/0QyxgBoWUaQkDzMX4M6AXJRcCZEh49J6o5gR3bTclagwKJtJ4iUm8GZY2n3TyEWqgWga/5ayGtfVeLjSwAsGbCjIPCmEMgk10logNtyyWKCQYX2oMVQPD2wpAOlbUHaWZz7QpSP2OHuwl0Wk/qNQ6eSyjoY5IpmGYNjwnzuRYrxJlT6BA9YwPhlTscAPm2Qz5eL7S6S41Ambj3XVtCjgWGlG4EYU+qzT9D/+F+h/6d/Cbx7D7xMZ9hiNhjQDnC6arYNi1dHtRfgc/rHAYfuhF+NmbYjf+9lG/YHj+edPhzb96orCKDqb/128wsFGFScf9zI7Spmgr8Amgdsu03OGTYJ6WTmGZTgfZrzzI1HbaMBdrvbbAO4cF0z9XddwJevqL/5Geq//Du4f+XD7BCwQ7O7kACo6iiuAtgOp4FFxnZPF4C/C0hmbMp13iI3g1rB9yQuNO6chiGX3OohQaX8qSomLkeG3H12YnGurI42JzDxji3ONliX9YLOIIDR3W29MAi/0mbKeDtMrOmLk4YbQGkEVzmRSZBezjuA5HAx39vGpN1I1rRWWDjeA8Zutao1y+AVoHCCzNA79qfellRBH4qgo8BRwn2fH9/LcclfUWaKZ6WxKZPVNao87On4yDU21vRpDjo8qcUsezw2KlHfTMDZRRiJRLJ+hrWuMuishWSkAQ2u3E+dgOCeIitWadPxgr8vxLHJpKN4NkXgROrkksSx19CUX49bl1SFus6UaAkpXOUORug5Yew5bsVnTMhav7OjZ7lV6JyMsalJH5eA7P4kWMckYwKmK8ywv6wcx6QU1BU8IyZID/BalrBRVeGMGzCdx1Xs4/ZMa/8Mkf7OX8/6sDC1wHramLE7uy40UXev8iRTmH4evVytc/1f8IL+7/857n/6e8DnnxySBuOv8Xi/J8GdtvPM8wzC2dakZZXJthJlwDIaok83Zr6vwrwP2/wyyXEGfniTgEZiow8eaGTc+DHPARhVDGPGrmIE8eKhVIDvlIOrtNACsdvjdrs721gZnrYx2dxkFNkpcKUYTe3iNfaKBs5bxb56PUcH/6MfAz/8FeDrj06eaDyhhJ62vt9BsOcIGWj0cw/d6ZyyVMrLEtuRtNd/clsXZdHVEmvF/VkrUp6S1fw//XFl7Hqd6BF8tnw5xnKpTicLZ42AQjrW/v+wgw6KMcG36hrQExz6GXe5OElDfoCfvmbkTSCJLoaAajKbol3q8rlW9Kcd5pY/WeUZPo9I7Y65drf3+KMKmQuDvHVj1EN7C5gTGIzc2vxYOZfAOgME0NOdCr1OsCVUsdrLAMZhjQPiQLLycsdWksTA9uxI7JPXgAsX7mJKGtVP6LWuXaWl1QVUIYP9tyVP1GzyeQC6QsTz4IoHldvvzyo/XFtBwCoh/gGswDr4QvyXwl1jkOsci+uY4qVlOuFFAbnP+pVIegFoVX8GQxd5t2xYPprBWjbQsW6iJMPFVNXii6JsWH7yByUI9njKMnkiLh9haCEVhAUKOe48LJwDsYwCdRxZOriB+vwT1J//Av3f/t/o3/+zE/zv24LYzIYmKTufR5H4v+ysRubJb1yeY2YSqaRhinBN4/H6wEUngHnMN+bdM9dKTM45AKS1kq1HQ1A6YWveFB/wje0yNBoN2m/AZLf+CURsYV+ofgVI7AC5gWvCCuel2gKzn2Yr6jox6BWov/894He+D7wU8PU3ylhXC1lyZSQo08nxb/kPFAgA8F0A4lVHilKIcEcAknx+bbnMITP6MtSW844YmZwslXyU7+mVG68qgdde42zbUUPJbRt4Kp+g5Hpytyo9Z+bbOOYKLGUVpGRYqSvg0P8JjDEeZaJ56pEHU7ib2bEM0VMYHCTXaFj07lzlSXMEt7Wmpb29S59lNZyBO4LkXtcQ0x0pnibclNSXgd9UNNQa7hQ7W8MJhtfuDkV2/Jy0AibZ4xG8nGukNZd92c8oJeuEyhMsLM9j0wgmgx9WbjHvmkF/uRcz3rsd1IpPymsNruKyEe14dh1I17mO26yPf0I0igAFWx5kdOTLIOdkt4bMI78zZ2+74H1MCmlnTAD9ko9o5XM9x70Dnhahttvm3i5O+ytfw+22xDs5fgQIJovLqdtdIgXtsBvZhz1cRUbiwCKLq/NpRyHr8f8TZtKn/B9MwKXJT71j7L2P3Oqzz3D9yz/E/d/9c/SXr8CHd+elPhfAqttxK3vYhYWTM+XdjGn5lk+BqH29wkdEoPziYN84ATC7Anxeiln2epx4g+wIXOcgCDyIbzcKP/y+piJ25RYMcjrg9FFshIm/FTdtZB8BDNhkZiZSIQFrDr58tDGrG2WwfvnpEfEYaIR85BHDmGGrLuDrV+B7n+P6h38L/Wsf0F99FOBxCoJBhEaS871vq9u2PDrDiM2b0L9MJ4KKWnRd3ibVJ5D0zGcUdsvTrSc2oeffZpbPyo9JVY3/ZqBQJNV3fd/xUhrKIk8sY7LzbOKOftSiOv/mPHyNoTK4yGcTXJzx2chvbn0ssminTzPrb5GzjK2ls6ziCQYnXhw5ZRBlyDoBqD0kyYVlF4pXcppTRmk1BhOS+LCcYreCzwmgnl0qqmS7407PB+sVvAuAKH4GcnYehhsCUiTu7rkxoA2ooqSltQpZgeeMfRMTIlLvhGgfosPgceCTNI613b7XMmPxEHoA+0hlfTEBn4f1ySonT6AfHLnznfZ6tXGYGfW14A72Sf6+O0Ob5FtAXVpbVB7KP3rXgf01W/qy1uULDATUxdElsUvNImFjVs8405eP0yczSO2OiKfNBJOy55btH5PklBs7MByi48Q9hG1Y75DJcdrUgmeC9qbbFhRS6qA+xjDrk/eobwr1v/wu7v/jXwPv353icKb4PA8fugycyoqeiXCN3WzbgK+TNI0tGwPi5zj4Ks6etjQINnbNHWxXyJg+fa+BD1dzEmDOqaMiq6SRstKrh/HsstV3VC1g8rnq2RJjoDkBWz7YE05o59elQCJIHiDk/mA6LfMUV6oG6cPXBXy8gXfvUL/zG8Df+97h/ePM73P+mYF4BmBrtvg35X+3txktEPXzPd8ypsHqPCq8E3zPZ/XyAq9DoAM4AGluj8xNlatqYcZXsjX0Z0tITtGmmx2N7fSyImh1uQS6+eM/1HJ3R+e+V6JssK+jX0UYB8WjQm6tOzYoyEuQebiUyFOwcNLy9EqpLRYzRjtHay5M/yQ1dbom91R9CmoUmYINnLFHQD3f9TTOKF97dl1M8FpVEHVXI8C1KPPN74CP/g1clE8UWZQM7ZMnAdAuNEsdq5s0OuCRAHKKSABWsOwDi9zJcvyGBwzlpMK8g2OCjRRe7ABlRcxnjP6pb6pbPjiWWiEM2sL4Ez+XSh888XK9cEa3O6WsCYbnoE8CvPfid6wBkmTqBGEl3vE96rR7HzvCGReOWK6T9N2NsVesLsObPeZDB3FgBdrVERUyLQzlmO6iNEqLC7Oir3Cl8MMyLeKHGDGxp2G7PSzFjpH5OVOW+msvrnzICePjCqhVqM8+AH/4U+B/+BfAv/0p8EufHnXf5kN9qipwp5ECFZ+s5Mq+KlzKJJ8xLooRJk5eF0NgVKAdHxx/4vawwfjcesnruz0Mn0PdDGnx3Y9/0GBgGULzDWnnqmhfhVGQyQSXtZ3jkelXPjl+JMtuXFcpF2ElfITskKP5Xip5FuuUrUvP6z7VRQnMToCtvk71/4PvoP6LH+L+zieorz/6AX6Dix2k56n3LDSqwv16Q9ulCEyUjzon3gYpUE/mi/bZBpCObXZ2Qct2kolqg0yTvz7BmmsT9vvdD3/HHsNASeHwUQL76GpQvG1MPsO5Vm5YBs5c4eqZfMS+Zs6Lrwcclmb/7MgoHIUgoTMkQpaUpz5PWafjzjgniZfRbdvqkXV3gPclYtIBSw8cYCVAD3/eDeNAn4Ry0Ztb5L5sw7Ft7JZ+Wa1sADqteOhtdhqPnaKh3c4Vtp4dhNCNccEYdWgkqAdQ+ilOUsq2wm2E5pX2P2PO4NI9g1APD7lOIJ5l342PspoEYAUdX2AyxCAJtCvwZft5DLTxr+cZLHCWPi5ogapkX1RMaaumsB+VO1nF43MrGTsNtDtUdB2VgNkmaY/EGnWL0hyfyaTshQqIgKU1DpSYnxOg658H/LM70tdeAYSyLSqQSrUxZaPV7BCdQM2Cv+jITFTsV5z1YDfQ/+T/Rf3j/we4C/3JHNfOG5j4AyosRXNHLCti7sgy8dFa0z2r3S5xhP8F3qvIhvpsw0vYBA3iOsWKy+SRP2NCYZ1vA9oCfvSDltEzgHer4mV7Rs8DTFidKlMGT6bboic43QE4Ml7AwBhVqUypZkGLqimLtBqzqvcoy9X73pu7WmTSXp3z1vECfP0R+KSA/+w30X/318+9X380SIwhc3wA05K2eu6pDh86lKiLWduA2akmx9gZ2HR0J2TwWj4gfDuAUeMwDLIH2G7cN80p2tVNZRP8rMG381mQQTlxncy6436Oy6AXtiH2CSJETgkmXcOgXFMRMgA0cDoz3BFBJxwAow85SLlLBOqNwaZKyX+WFVyQ6mjTq2KUDcnPsoIxHbxGwI3YgVFs9Dn9tTzb88wKcBWBiZDKYBFyDaShvByYLcN+JJ+qaMBUbRLkQ/WRY0FJncYjeBVwqSMEyevQG10JFhFZAKhS4DWsHIlVBBg+d/4hPsoPyGuMDZtZxpgaulgVea508A2ZOB2lXbPyugdY06iqEIvsjCvSkexm/EpFAEIWIiZkd7458/6z7Vo+72D9bJPTTqyt8tzxNVU5s7SwoRRcYjdt4/B1+VW/bd2ok3WdQ9xYIAluAhtFIzsTCk7mvR+L4p4L+qR7HPxbti58H8kWtGMFCIy4caaSPvsU+KM/Q/+PP0H/m78APv1w7r2jx1Ls/IV+lAHEtAYARFGg+FUWue6RXI4+woKkfyVZyVf85T92coDgdVk/IUIC5P+9mPJ0AEawDgaRQd4AXiADSEIWyFdB25IGEfnf4l6OuS59HAE8rDi5zuC8ZvJtJnQUNmMxKJLjtrglLFYiKRtmllWn5fPVR+A3fwn4z3+I/tXPgW+mG/DCNo1b2qqI+J6AJqBtw+SBHUXer0mUboDVIseS5PsY6tmCRUAxLzIHtfioO75wCFAG376nKmVdCkBn2KhUqEt2XmxHC5zNZcqaz773Z7JRV2SyL7SqDK9Mal3r1xJLcRFkAtdIGwNv0KWWuBISGFj4/BEp58UJesr+6dHNMAqDI8o7CpLYulYRdFhzF8iCfIB6gg9fVjLJOQFcj1AwcTAaB5Esu/0MSqcmANJHee+Z1jj2BFAe16PtPmdVEuh4IqdE3lORQHwoede2pnlkOflRECRnFa1pghn1xfthXUnmwLHza69H4WFX+iQPz1HwpqjqrP0anvl2PouK02musta2Sr0eOHQaIVLdGT2UOpqAXsFfs1o7ayKIM8L7Zuvcizm7oXcWGIdZKM1jYL7ZSVLXgYNUoa/pUASGZ4J6xO7U0t7+2NW0qpnUgyVDf+YWYZBG4hFF1A2+3Ik8NFrbWJWDsmj77FO8fPUN+n/7XfQ//QPgI3B/eIfiVmYdGT3bQPHs1jg60t9qbEeJX0yfnCmLe2RWyoEYvKV/TqsjYgcx6DaKWXI72QOi58pE/bH/MA+DOraUBd6Pf7uhjDbatwiBq4PswFLxDAMDdN8gvIFzBss3cvmyAeAa4mkoEyBxFfp+HQc7YOv7TavAkWAF6cr0CWSOEuhcwCwQfAfg7/0G6j/9TeDTd+fwIPE5z+6aLgCfG0GQwrktpyMWHqnr7JYBB6hk+fxoqrDsCIiW9WxVbIK5hDzg3wN91G2OLyOMewvgEcAVQRFp4MEmqwQ6mxYdxUmDh+0nLKS8TkICsN05jsMgk3S26XQArAjKNr+0zayo+zbsiJq1ujhhKMYK/Rq+DND22/sxdulCAjjnwQtsFaftcNDhrl7W1JeC+SB/hVIcty7Ci6DBxKfe43lEXQbiZHLx66QJXepCyZ4D7FeC3/PK5JieOJ2GrHiQ0fXch4YDumVzSN1025dsr/Irz72A3cqtQz8v2Pb4y6DmH0bfCaR+nXDhdDZ4zoP3bYN+KylGEnWRN1fS12zV1YJSzXZEwlWpqPFATokysQ6V5upzJlPE6a7SfDZGxgqwvcdAMV+Pjh2nIsTPEhotZ+QViUHs7pMN8a2txThEWZKbMFEVoCXVSOUfPuB6eQF+99+h/+efAH/8BfrzT04seTW2M07xfBJTazyoh410YGvLFjycML6yIzJF65sD1B7i6lYSc249dsguWb3hP262uI37hCRiiGT44x80W/BrlaJAP0K1LUMDrIoJgqUB7WAGAcahvuY95WDcCfZKCJS2+vvGBCsPewx7tp3p8zDShs5+OILhWHaG/uoj8N1PUb/zA+BHv3au+fp16Hms7kTrmMzMtFVRzoKmNe8vrVBeglAO4mr0qMV61ctX4DatFpelDblKpgUwmPFFN4Cd8LKlLXA7uYQPKtrTNLaznegRSMhP6DmSM81tdRuQQg419qVFdmfoc5pZE0D3PeoSUUkD4j54CDAXPo5HFEVnQfKZKtj3kZuxR21HhasCQDbBygvU5ZVjWDqrCh2gsJ5IIiHU/9KkFgb0vBBTti3TWRUZZar2tFwvg/lOMfMhtAbOM5Lp8+vlednoasji87kZyKhRJqFxbOv52tMRy6f6IUv5tneR6Al6HseissoUJLBzGlD+8UYgaw2Hk5BgiwFX44S+GSQqZVHCjTfBnLTBNKdeMPJPnGW46SrEzMT4x5Er+8DiteKaeDbaciPdqxLPUxtp+5lIyxbK3jg6WJV9GQcF4s9OIS+dr6sL/f7C9eET4I9/hv5f/wX6J/8OePcCfPJhGG+J7a1OiSgnlsRr0uJZ8bKepj0ZQ1hUcpqc3q7vFHbKMQNALUL8+3MNRlQCMfat59oujp3pysCQY4+cAggzUUbFwXXDumoICidiQCvxB893sT0RMsYQOwK4FRQHrGVAZmpnRWby7FBY62ixL8Zy7uRjr6zBWR/w2rhfX1G/+cuof/B94Ne/g35t4JuP5zLeAhuoDXyE2wQ/0lHS69IjEAGfThBCmqDFmm7nk2eQdXY6DVLJCpMb2Hmya8HoILpiPssDOigUpAvqzwlOVJgtdqX386iwGZGQ3ZjpBI0t+BhUyGmcTNouU7Ze30CAWdFCF7LLcbY+5QrtuWfWb7CqIocIHTR8olvKleakkx7nQyaprvwigMIVmmNSnrAQPEcgpwzJm00/riW/ohwCZ/Ed5uGdIwSLI1Gub0AcHKfEQYnc08tq0YfG2eIavtzJg4xl624Fk9r69cmOqev8PJL8sRcveJRIlBw0MCd6lnlLv8mfqyTzXAPALh15yjZyK9AmTB2QP/RFcOmexDETUfNKm5EfMDDPNVntq509Mk+sp5VZV4BeNMV4AndxTRu9vyQL7jTYp5ElTbMeI4oHeq0Ma/ms8dYG0TNdOr757uW8Dv4//BXwT34f/X/+PvDlR+CzDwaj54B83siOukscYVE54hIWHhkwbsZ4ll7EmeGt3AOUXwZ2VOhYKKNB7KRNfHzKheZfpZ17Zn2uUXL/o++3JjPLsLwym7TQCCpAoV4gwWgbB0pvac4V++fXssBC4XzEsyW+dCPh2qBK378FyGU7gT3nj1OKaT5kojq3eOkwjHl/QP3wV4G//33gu58Brx/R37zOdZaVhRrOpQQgWpnIlaVMinZ2KAAGJMNduRnEAN+/f2hQ8WCNZYhWti85TwJwrxAdQBbJHIMZsqpovYhI+lLWTVv5FrChsymhouFargxK7LKcRQI518uhaIvP0FkhkHSivJtOdroYz6Q1RrK1BYiR1puVLyKlUpXk8UqvjM0P+YTCPgSkPDdYUJF77Kb0u6t3Viqcrglb7Ea92DFyEdIpTEqJZWZwDHRawBo8U9bXgNodh9JcExh1v/j0Dz8zLpyL61tsHqmBCHj9VFg4AIsW1Vypj6WBItKfgHYUBdoZifRixqyyvEWQ/6kcT4+NCakaugaLGHY0bnk+nXZEfFlrnAJbizKMMc5aq1vdivQw4oC347kdbz7m2RWxAfcsqoZo4x9rmgFTwHT4UCRb9sSwVU4F2NGWbKv7JO7XBXz2AfVXXwP/7A/OPP8XX6M+vMy6q56dAfYNjDZz+tpz/dSPff3ce2IDdwV595L9ymPDC9izCIv4dVQQa0cyXmbMUyIik7WPG0nHHth5oB7iMKJ8UVo1qn70A7v9NYxk1hpEuOB2Ja9VzMFXIoPIFlBENileK4TPZ03ywEVUBDtQAgRXWgKWwZ0tNzpJ6KEA3lvgCyr4kwo82HsBfZ3jg98X8KNfw/V3fwP47qfo1xv98VXObCJaQLmCStIwAizonJu12hy0KRRQtyrV1a14EjwBeenw+UxMdY1JxNo3a5EZOWEyNmO8gs3yw4sqc+4JZlVGBw/d+r8QLX507QAafBjkBlhnTFYOApisIphkZkLBBVmSbwVJ40CVnYUEOH50B0CUqg7JmM/HrEQeNen0OI5TZRAuLMDcts1rCcDurMh8Feu415x/u4uT/BydzjoLeC94JmZM7hQEI/gvP3ekHr7IqGXIn0tzwoSrUuHYZZjViYThs5W8MFDC9JxV39FRElCZvgN2A/jUkkxUUluVOCt/qIqdrgxvXK3orUe1+ldS64pf8htfFs5HMJbOZAq1F4bFCnxy1tqOFAlwT3AI4HUyPbLrSTAoG14vmOECxAd+MzY8Aj2loo7MjCuMkwhqJZHnqo47HpjM4abqr5cX4MMH1Jcf0T/5Q+D/+n3Un/4c/cl79AvOAu9murdt0pGL/AblXesEeGcg1rcnTCKRy3EL2sZcj+dlcC/KqeEiUFba3iW3sNyCyenlfU1pupE4ytDhZCETALbzFVNL41gJU4lGMK4BEy1UeBNsMwRQDHOPDLMFZsSe7sI1zp4t5hyJBmQkpKNoI/+2oBGmBZY6bvhEMStMznz32R3w4QX1t76H+ru/DnznE+Djjf74Uc6R9AMJaLeUm9vNTjC8zMeAC9uWoemZb34ASSyUiSVHS3Ec++Zzk8meZ7HCiaAoec19WvjDLwOgTtIWSpxr3zieI//QUiODaFsGdjduOQEGzEo0FW61Ss+YTedtQAvzeCpbt2iQY4V9u+INXQQ9AJYOi3xXLZpJm3PUcP8ynhza+ACPAXZoxvYOfbcXMqpKnMGubScCIFCIQ8/onnZ61u9wq2WsvA458169sEV+dmx8v2/dwaLSr/M0vx5KuNhKgWhoL5rPFc+sUNr1YIJgZtAkTpyvO2BmaBLgwmfqoyaZPfH+rvCmqrPocRZXrEX9tW1A1f7wlkEDc7wv1ZYVvgSItk2AY8KJh1RNTGklrxKJKGewsn0V6mxPDMoaPj7btNaWl4qO8Xu0PjoDzxTsBBjZaburoIcCU6TFD+nXyZ9+L2cNTqlwevcO+ORC/ewr4F/+Cfqf/Rv0n/4M9f4d+uWaaTdimOl4wGmYc9KWgKAJsFDjGE2/prTC3h09jiycEBGXabYLFxJsZmRjuf1+A5H91UUQ/QXSXUJ6FeTnfhlQ3Kv0hKCcW844d0nSlW3QjCI4UVnhpO4YBLgqnGQIkGcdYyPAM2Ps3onJBIR0JrW5lRWXh17XMRBRYKmu2jcUgNc+lf9n71A//jXUf/I94Fc+A9QRqNlCZAD81p8xaGHnTEEovE47hyvi2aLNdmOhpkXJQyzGlGIBXtGRa4B+9LqzHwTfsOwFI2//e4JCBpmhuWHdhC0pAIdzqeEn50xIMnGZ1Z672BY3DVdNN+WC7KuDmKPNEtvJfs55IkDoqhd03djBOasdwDsg8ueh+wFFkEXRB6ztaA1cV+wWcSZz5JAxIAGAD4lkbQcZXjdlzX26GddztbYCyyT6I9zc0rbWGsgek1cGDdoinLTWsXNe3HXOFfD2tqj251lNv4+nSj60BQxrVSd5XvLB2MRDS+TxumzH5JIJFpN/i3eeCu/0ueLFLHMgC7sUDh8E5ZEL440SuRhXZxIEwOUF/SycepITh7IOPdDmj49EkC8KDWA3wYHJD5WcJYvpqI3sXEAGptDeBaUbV2r45E4QLwSeJ+pdDpTzJDnv36GuC9dPf477J38I/OSP0X/55Tm+992coHpb8hbaBR+FW/I30f0f+XFcKtkhi53nLosdaeef+9b6DdoUcX6JjDGyO/RAm5l4RpzA2HNgiQP+trXsIhx/DP86BwE51N0zoGs8NxaPHmc+oeBqD4sL05HBNKcV8nlMEmIDqkwxKpKVGGRmCo+74hcf0nYMVwZPpT0idPACKpvGT6M5JQLwzevJRH/7V08i8Gufn+D/zSu8WmpIaUiZjkJlwxyeZENyip5U+OFEfPkHtU8U497XVE9o9LBWPv0uh05+4aCEOZtAmNER/CkryXHGnYV8DKhrYdGAAsFJs6uRIOygwv/YoI0r7EKchx2ZvcppafsqIJXYSjhu7XMLl04Ocnv2piOlHVXYK3damEurmTIHzTKCAnHySVeOpHgQQC0D50Xn72toYjHvF8cMvWNLymGmY0JYOTElD8zhI0oyQXCy/ITYELI5P9ckAVmXToBidTb6v0HFnnUDZ/wbnXgwOwxs05zWaNHp1iwD9diDtuSOLaiipewfeshATHlHG0dV7lSwhwSuL2olPQe2JMkjL75bRcM5yBzzLapEiZOCZVs3OaPFQon8nfUo5/nclkZtk+aa34moXMh4DG+ShqLsH9MS8MPVeQp/HKQfvmv8z7zZHiBdARPIu4D3L6gP74GvPqL+4M/QP/kj9O/9GeoXXwOfRMWvgiLwJaE9cb0h66CsGJjTtG3bN6pegDWcAz3jiBOZ7dfyswc+bD8vyZhdAq6l8tRj2xYqJzZOHDFc2lYQNgeOQDypH36/vcq6Fi2mL8E9OI721t5Ox3uGyeffb362INK/9B77AAjOKxknPTYNM7p6YgXBoUKVsil9oJtE/jiUOgwjVFXfN07Af1fA9z5H/e3vAd//FdSn79Gvr2ch4Qr+iGceo2sg+l00KL7fPIiOIQ5oBzjF+H3f58Q2gscA2apWJ7i7SJ8rlYHO/QPsK3BmICTgPKp7MaOKzPd4lT6N3YY6UlGAz6AJ9CxOA3i0qkctBQE5dqewy1MrQ9DD6ixcgbFtYE0OdaGLZ9kfIWo02qIqwQSYSCAlquj6UO76brpAyx8JklE9FsBuUajW/JUluKbnoJv1zGX4of+9/KR0KwC1ziVv/l0mGZUA+GyjE2h7H6Cjyr19z+Mn6jPkivVc1Aj0qVb7fK439aG0fkA2d9mnhBvfIjLa78mnSvz1klGPDzLQFnR65YA8gyu32qqCQ2tdzlwSdLUCSi4XSRUumsUvpBR1h9iVVaF0PpdE+MwshDIR6AbqRYrO6Ukm1Vl8xzdDV+u6+/U+x/S+XMD7l7O75i++AH73T4Cf/Dv0//cfzk2fvAAveWoRzz7x2NpG20zEo3MXxdn5nJ0nGm1M8R3mY7FutuZbsqHhVcXnoL+N/c6/Mn2FxwKLul2PthW8wN/YtBObnG4h3od/K4bh2Fz98Ptn1MovPPYZ9zKzytZ58TnxiALPBQn6SUsk8VqZ6F2Wb6qcgjI4Bd4U1oCeq4dZlVkROMIpwzQM5gLrUHY4vCGfeeo5CMiONMK6ruPQ33w8tH33U+AH3z27B7772dHh6z3JwGR0vPd2m1Rk0WCb8p5r7nAwot46v36yvvtMC/ez9TnACEq/GfBnfD9cDnrs4bT6ul9B4PNVlPlRoEJNt5WabV8lGgBfrNLMftpyWYmHMJnO7FbcGN+IwUazAE8/tNn4pCfBvKbS4bHMUTmbYyegipEh08eDl12VAkENZM2OE9ohEy+evNdYQJuB0OEL0lue3b9oCKfe3Z0xCQYdVZZSBLgy3W1uTkvxxunGxDk4fqbn8D39Q40UYybQgSlRFXKU83HJ1JpTZaSVvgQHJulN2BPTFOIXSqIPGSkQKPgx0Uz/DCeNhW7kb51sI4APjYWdlOUov46xYodW0f8IW9rvzSDRsxq/5QfZ/TyYX6JVNnVFQKuC34vAnw6ZUN6wDV2X7EMdS9r1XKREvYE8XIjjF3Aq+Xcvh+YvvgT+4KfAv/q3wO/9GfDzb84+/vcvru6kLna8QobTuQCwpsSIL3sngG0md7IZE2WEwQ/8hSDI0z/osJ/ltxCe5d8sMNdzvu2nal5qtHc+ya+7TxdDOxJyquxRaHWj8KMfdMUATYFFFseWYoL4+uHWAgB8LeHxsWv29lsBqwUUMpRD0a8iKxVNCDlGlfptczn8Tn8JJIOG5/JT3qj743nzC6s1OrO+5rZBBtyP9wn4H94Bv/pLqN/6ZeA3vgt859NJBl79BsZvKy96gsqaHvDlCzDtCeDKdK4JY2KRtDrThQNPw68A5T9F6DZlEhcDRtiK2vMTbNC3X0IT2akGt+cAmOw3pgqcZ94BbEPD2IgW8gluhp6bR8FGK20GTR4Kc23jzCO2r8lK9zkdsUHd/+aSZjskdDTuClAV9gPKv94892ypc/fm7FR9yFEycXLqFO1t5fysiAwSBPnwzBoVzbysgL0K52TMuSh3v8l3Ilrw7X8SoJ4ALtw8cWH4maUX2r6Ft+DNZ6jyJ8fyWcR6lOHzghegUV+XcaSugl7UoxfteOxR1pYT8S8A3950LPCYur3QiVqvcc7CTH5GQGwFWSeDAN99spSlX6kTFhhcTwIXSgXw9NWK74xIUUGS3JHpAN+QHW38A/7jmzy/Jc70zuD9/h36/ftz2Re/QP/RT4F//aeo3/tz4C9+ge4b/e46R7LzXko4bSjjKzDBrcbHOnSSnToms9Qlby6JUjyp+KWOZ6TQh6t5yrQXXep2jm3yHvvh6EoenETVvmdsRl3Q5r32fL0afHU98ZDFD38gO/Ye4XtzH47lo8zGuVjhmPPw7wWNVtjd2jeqMSZQKX3Yvd8QwnyQ33H/LMboo+TP09RMX1Sw3XO/7xG3o0jrxjDpt9CNIw2IoOBj2Imc37wC9yv60w/A3/wc9Vu/gvrNXwE+/4B+gV5HjJh31rNYRXcSFUSSb4GvoibOC3IajzCzuiGNG9dcx/3i6G/BPUSbrKNdmmqPwCWgiXUGJRFmpWZ9GrtML+m322NXseQjt6PyiUPPM7PWHNhQtbackkaB7ks8fTs0V6mL9zbA750pkUDTVgqulpYuh5BK2MIE3hYAKoCAflvxXcjkjbyD/g6dzLug5S0X30ZpFa1OUwBWYRL1qcxy0V6Ai6hG8gUDtX6mk0PscEdo7iyLyvofnCmA57kfW+dnBxAN9BXPGk5iDKSslr+wKjSyqZs3vLpRsE+PrL4eCQBVxm6Tn0sdHHlexqtHsbA7mtSRh+rAugONje4rcDaxELJLmusJkmNDJWDnE2T4fKX3mr5KQ+O6pHcX8K5Q1wvw2sAXX6L++GfA7/973L/3J6iffnWuffcCvCv0/epO4AORGJAT39Y0XaUfBi1LQM97rWnZSeENDWo0ZscBTI5vyVvdSs8eLBV6Wq3CGW1bQZJi5O6mcICZ/ktFgt3vwKjQzilmlQAM4Cw5h3mVAwqZUCaekQBthNMnG/jcSqwDotlKS9AxrVYeK34CaLxMgYI8i15uAQMkONIaYMrxukXneZa3ER56Yr6JPPSRG6PlAdnJiNE6nVCBCMD9carNT9+hfuVT4Dc+B37jO6jvfgZ8eHe2+X18Rb/enqfqQ09rZI428iJvbAE/uiIKcFv9eyFdtw884dHGsEPl/OPyw8pfFRkn+HQsXnQi1pJVyYkwbcK1vQ2v6GYbuRUUJF/aldV6PutCFXeUVzwf4NHMIM+MLAoUJf40twqGqdC/7C2oUZBacUPPT91sIOXn8JNomzTJGq1xMRdHbp5QRlt1BSFw0ifxN0H+4bsH8wY8F18PQec461kMPOcXHrX8XLksmKvoKFga0QlwtXf8XZeEDYS0HX0fc+NUzhUama6Kzda3P14UVJKVfYlFD+9jwOWAwvM0hg75tBg518dZCfyPaJpk+Wz1bW3j21FiZFQQ9tGf5G8sdh6+w4pZPtiW0LHDwQviWUFYtxJrJnt1unK4XiboH5yvv/oS+NMv0H/056fF/ydfAD//+vD27kK9XEDd6Nc2hg19C3+GR58eSxXTAceuFHW95dQiJ+48fhSrwlcZbJVA8MOI0azuOxc8j310rwWgx/cCc1IP/LswUzbkv2XUTNATg3Sd4h7XurRut0C5m+9HP2iXL3ZSszlGIx3QatoPDPCSDLUIqENCL7OLYPiIdm8BuCsquFz8RmEHIgtQ6nHNMyLYwpHpvi5p7o1PIHkI9o2F+JG5hzl3ukg06f1VAogLdU4TfL2B9xfqu5+gf+1z1Pd+GfU3fgn12Qfc17Sn1kLCB9jxkcoEx9CawN3xGoVywChEAjCGXDVraZwALPXJAVLOAxsNL5LpCbTLKOOHGalkRXA2YH3rfaA8DczoW9WHnPRYE/qv0Z0cLHZLeAUmzBuWVUUwrbg0okwf2Z0C9sj6OGDUKGmbt5M6ZvbeyspKrmXHy4Hpg2151NCRbc7VAcvg3T3B7wUMtdZri6ZbHSQuRBx5U3/yc/IQr29mMBEbh3kF1ZGNQS+CByvLSAgf7hUB24nKsAaZAXUT1Z6Suaimttqtf9sVW9me4lqmVXwOCB9wy73j+WnDvMf+lAnVGzqUYbp74KKNeGiMcS7r4k52zJcPwa1rBSCE7tJRtUaCaw9Y7NTZZVcX+v0J+Nd1AR8b+KuvgX//BfCnPwP+6M+BP/5L9M++Ar6Z7dLvrrOYb4CmGrjvVynP8WCKPgbtwZ64YDmYMcs2Bn8tX/HnMy6tTX87DqwA/ShGO7ui02WRxa4CZ6bA2j63njXXr1gto5JhQVnEfyQ+qVM969b8qTFN2wCPfgk+QB7SUGN8x/YCNAfkkk7exznKjoeiXnBS+GB2glJF6+rcP2+7q4b3DbsyOjZ/BLrdOOZ+jNoauIdPVQ+SYTuY0dDI/B1OTOfV3BgxuGZcSIYMoAyUi5jLztPArBk4xw7jw3vUdz8Bvvs58Dc+O6cOfvYJ6v3LxN+ZLmjIKFgxJfB1lee3pR+ouRFLldD9ah1cweccqKGDipgRCMQDzBDfoZZ/CcxJP3WPdhdA4dB/H1qdRlVqe1tyBBkoe/bjqT8Y5LLCQDt4yckYsFKRU1nktBMpb9t9xBsDQMjlkOEuDLG+WW3yPuntEeSoivBHA5Xb5vRTwn3+vK19BtR5HDavUTb4sOEqrLPcmczr2ZbZ6bxAckdj7YQ495xns/q++xxOYxXS5khtwXux2z6HCIDCTPothTvAzfOrgWm5m1X1TSKw+AUIEwDSFuVgY5AKFPAzAkcZlNsPOXRqi8KMx5fKMCDTT8rudk5ULAfF9KeaapydtCgcUv6cbnQHymahB9bYyMv8/93LOY3vbvTXH4EvvgZ++gXwx38J/Nu/BP70C+DnXwKvc//7U+Vr98DrLb2IrNtdlfWT2C/C+UfvD4TrocOxlbUWJ8w5m1wRAUaF7XxDvshXsE8c6Ayu9J56w4dMgkkPi4f79iuF4z5hnkAm561SCO4Q8jnrTJQlISZUcxCQ5NlsEUVWTgdDeNRIVSCma+xs52E+MJEU93z+3Odv5wXOiv5c+BXZasyPZnatxSuBP2qHwfYsTBunXKe/RTq80pR0hgRwfllQpU1gkDGE6EoXWkKkAQP+uO9Tnb426mrg/Tv0px9Qv/wB+M6nZ7rgO5+iPnuHfn95O8w9r9Dleps5LvMclZq+YoLW9hdWccbEkaPbnsVxxz6kL8mWAfOAc+CtAsAxVCYwtqV1wElW/yPft2052lvsUx5nEtBmwsCnt/5BQEQQM3yILkgumievS7snbBie/qnL89A5JsA5XSgQFvVPKrm98wFmkgVawV/VJAAvDEzRFVhRnAuP/fXjUiZi4lN8P/WHLc2IVZwmWLgqvhJazdZyWNIrcRX26YNCRPledgsWjcsmES+kga9PsgqngxV+KpQR3ta6XkEsg2oBWvAHINXvqJapWO31KywMlgxhHcpuJbCwjdAJEwrSXMQzz2XLx8nPPXdMctsvdQLSdaGvOu35btTHBr76CPzVV8Cf/xz4s5+j//0XwE9/AXzxFfrLb1CvfdaEvHtBvbu88UZvUR/v6LSJfpgvefA0EpMx+k8GNUhm298l+sDy43pzNkGX8jrIp0aDtAcVOnfEIUvTOqYx9cGQ6YpS68oJlbhGoi0+ojhR4mq/YeFtG7WsRIMWcTk+UhIc60zr/+j7va2NhISBJQW9leZ9yu1g93ionbHhdzpbWXTkewbINs86UpWL6zLoy7lD6XHNGwWRPNGICXjtl22MIWbCATyUIhp4Gt0oepSqZtIjroTgQqi5LS1MmnY4TtOv92SvN+rDy3nD1efvUd/5BPj8/L8++3AOx3g3p07p3wkar6+0fs39K9BJ1QfFi9FplFggSEyiwQQAqY+G10uYjW7qZtZGyFhqySLnfUmLsF8+OfLtnrfwMWjNCLOqmQAuyL3TiCnvSMZSYVFtSCtl3Z/qc/4MW1d8UDLaWv+UtiAw73hsJLCy+fGnZyVhmc7fbdfWdNDFyFW2AfqWnkOaW6DA65U86bpHMkUAHGTyq2SNIkCAJ6CkyYsrk5nxowXj7uiZ1gqfT6GGnMJF+ZA1705wB/HL8vDLUmw9q1pvxIJRz9kuGgvQ+0hgfKUMzvNi1ekk3yI4xpdRiKGxm+ILlmaM2PK7p1BOQKJrVl3oy8/swkzrDP3d582nH2/UVx+BL36B+y9/gfqLvwL+8gR5/IcJ9F99nGe/nF00L7EYsIHuV4oaa3qPssPjJ9ZerR8F4JA3E/Dxvxq+Q2OPBKHCZNr+MJrpGIerV2j/uu6J5cjE5FoXaKvqFHbuOkzcCDwB5aPMPDrZmagMnTV2LFyvB9aTNp77Ilgzrp2rf/hbjwTg2bJIRxtBacKb7flp1Y+A0nG1Nzlw9TmsiK0HQJEdBo/L35nphIBkXlqQURS4aGSmDij7FaQSVc2PzWqC5wp447x69WKlOJOToDTbOutCA/hmAwT3o/SexKDtNC9nsQ0+vACfvT8HEX32HvXZJ+hP352/P1yzl7ZQL+9w4uIshIpIpaOF8/9o1HQVVIGR16XP6LjMuNympfYvAQ2YpMCyd8bdgaaOVqo2AfG+TPh8MYE196YNbZM46mVINGdTsHVMQGPAk046OgMjn3DMEerIY6TiR0ayefkNYxRaJGTkre/Wx61xLMcMJM1WLa9BgCLpxu2gki5etf31SsAID+O5C+KVP+dsEN+U9yNkU9JP68VEG8Clk+D7xM5rzJLAb3PZgcZU037O4RijaeqWgl6BM75rAHyzIgOC5tCmCLjeBvSziv1ND9LPI01M/q5LNBwKY4u1EqnWKaAirq6TFLFST35oP6/3WXn/sYH7I+rjK+qrG/jyK/SXr6iff4X++VfnfP2ffYn+xdfALz4CX34NfGzvdLrqTJ1cgA0Sx+Zu24ioJf/14D+6J5zOUZxtW4IdIUBfF94xbVYa02tHAL07grEDlomKoQJs9NQPr6FNDO40xM8KtoMp9ss7/Hho464C2q0eVWk6wOPbBKgMoW/kSdsJbCLW8L9jaABuvONzTGO0hkh8JmV+BghU1KOdzIYqj+29AE9RPGeihWMRiLJ3HVvKCKhUkNpb5fHOHA322oYIFJ6TPS0VXYBRVIfQywEvwoR+OEckvgm0GjNAILKg0nM1SnxPGltzwAokF4CX04pGTyXQ12m9/fwb1Bdf47TN+KpB4H6p0457/w748IL+7APw4R3q/fms3r8An74An7w783rv6mzHeTmg1NXAO6BuHhFbyNZMmMh29kbYwVnbwUq9ZQcB7vy9MMVYRRKHmGItNF6ceHVqxpUwOzkZsK6ImdTJwfJYwUvAGLB9k5g9sEnEMekFxu5tq2rJmu3l8Mc3x2Yub+0pwOtvBpmELa1/JPviwBHQjvgb7OxU7z35ygMy5slmDQG5wtlCJKTxmbFanAAKVkPBOIe6XgzI2q4eC6lS7Bng6U7l75ZuqBMdSAHzXKVFmpjKGDVjmNkjBaqVr+7MdyhQpqjH/D2AjkPURCwX0cEgXdfRjaYqJslnb/puAK/H1Zio333WDfWtrcT9cc4X+foV+MXXwNc38PEj6usb+PKbqdrP7/j4iv7m9dj8nbAz0ypcr/buBfV+5CRdb3nI3sYWM6dchTflKLOaTpqvsH7CweQ7Cm5cTwY/8xEa/S+Boex/s8g844vTFvtwjOB/2N3gF530QvIRZqTfFmnNz/lVdIxgDIzACOBa8ex8PHijopYJkPnmr15wyBcu8STAFdl5kc/iPnq/fc3cdVbudwRtPnDP/OcSZh/CEcSPHAECBBXTFj67DDKchaCrmEEd+Lh15GMF8zEV8cispBgppN2qSuBh8qAs9spBAqBKAU2KF+/ANURrVXvgSiYgorEsKyuZBusK5ABJJF2S49A4+tSaPlTgdp25q3cFvL9OIHqZv184n3c5QbjqvFf+OtfylaT18rJ4GveFkoZgj6AmVsr6EK9RIei44nFYbuU86yDAVVHe4YAx/hvw0bu05VKrUlofUG++vW06SQB8pnxsl9TUFzg/x/DZoqPzDA26nLAhW+6kq2eG4tb0l05Ul6HHvrgFrKMm+W47/iAWhoZy+B5x2YiMzvJWR4C7D4CTxN4JSldgHeW/uwiWDSJK9Cy4HWavK7pSNOWRHdv0LAqaASu24YZ+93RT+BkP+9EHepDpQvyXQqAP5CJoJQdnZ4Xe6McFu/n81DN1efOgp+Hrbulef7/yu6G9x3duoO8zvafTQzPAXFNlM7nU/9uypiHT0Po2/iJwXhV3R9JtvMwfLaxM/GNQSxujwGPxeOW3cv385vz9/OSIuWRSKyHufoxNG4zSjmSA3WP6dRQTMqGY4on4sH/jW1pnU6xC6GOCmjFHa6zi8Kgl53XL288HKz3lEPF5yfvUc9AchkYKJa8bEYyyqogWfQZ05wnILT56POekqIbmTaGBEJLUVvNZpP3nUYVS5cWgwLZigNEWObSic+j0WBijS7AgLzZztYAykSEVxIymAQJMrDL4SWChyX7QSpkdgzjyUXARLyHTGzjzPydbZmfhBPehvF4gA1U1P3K/b+BroL5+Dd4K4Mlv8spCBjVrmEnehn2X+aVAc8Ri0F0dqNA+JaJui+TltrGwuxroK0UKbh3S6WkrO6eV0G4aTKjOs706ndcxmcToRKuoZ1FitYMz9YcBEIFKySw0jmw/Ol6qhcVDiwXZjyzhnmeOVJT0Iq7JNrklsH7q6BsTwHlV/n7+5XVMgumne+wiRggYjoxlHWbQj7dZuFoLLABbm3HfmkDsVBlB3I85ZDzCTQp2DQBXZWvBJa/lATCZGJTGeCb/AOHKuAAAG+JJREFUDjTpeiOp1eVI7mIMyqhqWvMv1grNofk8o14erkW6cTuYZwdMerh98iGPqT7267n2fmBgYWyYiXMWmGL+4I4X2JJlTtNN1c5960xc1FEcuanbh8DEjAeDaRVYDExiPX6PDjuMn8E64bxMryQrdTLYzQzsdtfhEbdCFGjMyZdhKxMHPIUU9JR/lawp5+5jM9PFznUFtu9z/7tTcbSc94DYCJNB4Q3QjuxaTb8AUo7trR5rpScwFVJs3yODfYC2CfPcmiaCd6LAJOTubDmVrrPYbEz+PYNF2tPc8QYNCVykjtxcz6JuqOB+eyYToXgafwahMex0kSW0+UOqXHNh1NkYDau4lPd8PrYBcDEetpyg/wbwRRV/z6HvNUengrpKOpeHiYjlV88Q8rBLB5lkrxUqzrXXQ09hnOKkoWNK7QglW1F9Y7R9yJajcW7WjnaEfeuKOjgFZ4+XX4TEyzu7QAFTEe28y2HsiFX8CrgJqBBd8tkFgbEuRpFnW2uMAu0CAoCe5FHJwIVseSpgdATyOwB5GHc1hvDFo8QzlM8PIGZoSo2BUbyd53j9RcrBa5Gko8v2Bb1u+HAtfxuauC4jFyMyaZcfX1mhlnRW9eJg05RsjCvTkKE4WMuQbZ+RCYtGr3wPtGpYg/ogOo9y316yTy5OS/iKG5JefRRynPszVojP9OKd/C5cqJrXbh+9ZrHWIpp8ZqFjNjFY7sXo830DXpw+8kiMb9O4bwpcBlYHqkcIXtAXI4xvZ0xZ43cUhDj6X9NVlAwVDXc8ZWf3rYG1GPKtY8k+FuK27025Fn77+4EOG1CKXQAqS4H2PCwNLHQa2jkXrFXStWZDw5jgz5cSEQ4YLaiI2j5yM4yMXzeAusMhAwAfJ95lvX2Ueonntz9D5MpwA6zSYIfve+RRcf8SnxKBpQaGn3ihZj/o/TZJ2jGV8EAi02hn/ELVJcMWSEypr0VPwM4mR/YOzmI2OA86owO0ZUqF83ddpa/XFBN1+XCy0xl6ylUeJKfhCm0Kg2CrRU4zpu1necXuKuGAp1riFk3QRvqWq3A05wy8nL9EG0001ulQYF6vqy8jSVvi68cHNdfq2FAsZRTcPgSf+fALXpdyqSdnClTtYP/8YYdHPNH2j/OvFd8ZdqYKXVNgD4aZeCQ+RV7lKbElguh6hi+utTwcpEi3fUwIzudMQBBm6oslpkdl3N+us0cnYhFPvVTgMhOwEY9X5ScOc8iyvgbzZfiFmQ6reJIxSJoXXASdqb8svjjlwo7JQ0/a+cV3XzjCSn9HV04SZWHkE/68AS0gF+U98YQcNLRg/aEchcpwxHhmmR48fzgdOPGKOBbx0AM9o4Ifl3k+ITJJ1UJiJSfZMw1eOEDgZmxYnYFVvYySCtCK/3RGpoPJ9TDoKjpCchk45fRl7DFdQTT3ZqqKHsAQSEEKYRDjXxhj1KKKiqdQgA8A67VQiAEDcX+JD1Wj4okyzoUkcGaMRsWUBJ9JGeo6W3zItVTd0UAOOZZzUM1b5i/OR/vz02a+Rq5c6XOucYIQmTOIyX6uW3PHYRlXJGaCqMY2USkB88mn3qaWODFAcuzvshw6OlZp70YD8ZQ/yZ9jYIGvXk15cuik1OciDHw0JdxaECba5rJzIBP3cyZNbDsy6AQj3cgdFytrKt+NWBGec7/yxRnj3FaxdsZrRlp03RxV/ElKY6MZ/BVocRt02MYs+qr92FWIsYSBkjToyTIN6r4ER00ramDNw4dULXwmE1jguRPooBMYvyYCJ23N/8gP5a73LMYLG2ryF/eJLqmxAzfLryMePPBYCZbGXtlSyk42SpMyr5qiotPCnVzTM/+9b8nNNPfMjc/6mJGTcJ4+X4E846fu8HD7NHHyXOPE7AbPEQn4FT7WGne+fCSaLO5kBin+hXWUzIqNpygau6gOkbfv6L5R973XWNmKouDF5Nw5tWO379CdvmTcg79nsiIyhbEnodcCVvkf3MUgk/HLOwmYGLpSZr5eN+bOKNhpAzKjsrvFb49sLJUpp8ARtCqSUbC6BlwwyDV7c5c7SpwCaNyaa2fVa3pqLJ5KOn/KjPDMVm0YdPwxXAXtDGa2UAcLX7O3180jteamzK/AaT/jrfAMToWeBW8EUeqlYyyL9gxrnlp6cuVfjVgEB6SnDERJd5TwuYT03nEVHkmN5ewKb0YqwOdEVIiB1wPs5mR3Si3zBKMqzfmpDCIDI2+CV86wLmmvTJ2cU2635fBYDEXwhK6FEi8CGeXn1jLvbdnBcx2IQIvykL1kokuAYNWaY6yUZ2g3sNkioJZ4PNlt8uLY0LPSKnxyJ3klWbbhN3OaFBwDkuy88Nwelr8Xk1kgTlI7elOTvU7/rCk0c28Swi5s0Fkl+zN5FBfbPdjlGpOOJHmN16F3ycet8rREvaME1vUYkx66dBKJB6fmDuk3mLivn8TFwsJ5mTC/o00B6w1znKa1tWNhVzb2HYHq4V/BM6hny4/xAlVzvkWMw3F7d0YpYydhEuIDWgcP2niY5QH133TkoLs0pQTHldzq15YArnbnUTKYWxn3AkMX7i3hBFo9CjSIc/36LT8tptb6V0wgBdg6GjdhlUXQorPM/yQTBA7DRpU/x69TeZKs2q+5VeTQ2TFihwBa3xlDWh8rU1egwA6ws6CtqYByQOlQknx4VQWCu7AmOp35SuW1rrG8j8BqMuIZV/4dBjj3cpGIqyJCL53dgSdj6SHb4JHuKUhUAjSUPt5QlvKQQ2aAE4/bacONxba1RucNWhXI/Ll8LywsZUi7bfIJzuNynO0JD7MEA5kDAAYY5vMVsggSMOAObRaV+WIyuNrL4pf2HJIT1rlrpipkAVdpXQd16l5EoLd4CEcI2euj0da5LK3uWyUGOrj8PQPe7Cho2TckCyUPmKo7bFqm0AngSZ9xhsz5PIVvoTHozBG+FRfrzS/xd8opAD+HZRcJll+n3OFwheBJ9Cwn8lSh0DI7KJu0GS+wISKF82MHTiWdvHeudVt8mAo7f3hxSNT3ED9ZUC1sIUlNk+wlUy3GKwD0XTkDgvfTQaj5PP3QCGEskxzDl6QDAD5Yx1ZhPySuWOfGMca/a+RBeuZzLm6sBnc9dfLS/C6eGzaYtu4OZQKlExzawUIp4s0qaONLAJecNAEAnkMgIIjedNZREDGNbX0ZPR1fxBbjh5ilwaS5c05fiS5wMuHbAVXVvc5auAYEC84ELdzT+iQWBLyFAzOxWdYRFwno5hkSbGcN2ZqbOnLxu6ZVPV6ewqDdeU4njSEcYP7mXHN2KxQ8orrhbWxdXgEKmWy4+szKHNoaxbHYjjvtak6V0KONQtItlcT3KJirIy8KRTqJdnFzU/KuVy0XO5+oIE5MIO5xLjll0ardkg2NzDgGYHa2pDxqR0ngvRaCFyxrEMDS0AEFQ4QfnC1bcVqXnzT/PTsS0hckd9pxUawtnSdU4yF+lx3IqV4QUOqqeD3t2B1xYj609dI27QMC5A7/iIQVaL0lsmC7tI0F1gDCDdujV8Ok2Nxx7OGplh4yKIRadmwhAgZoCtDjXopVCanAxcFwdVGiM0MaXC1fHOVRfIyChKmxWZ/ZYK8nHtRbwZCGRjG08+og7dmhIb4/e0ctumIMLuJmF2KwXhhHngQVcrJt991awCyVSzLDTx2fMWy50zHGqmlZ47UtVjpc+EGMuNwxoC0oqWuTcTv5OPdFsUGa1SFHFCJHrgzMB4sscurO9u6fqjpbxoHBnnlHS8Yr5K+tuBSTeKZvaLqs1RHXm5I15s6GeMl66W5AMb7zUwlghW7DraO71OkKaQxIUwMUaFQJUrxAVFFPfPL5nQocQ1mMrgqiH18JYR1pEO0wyqUJHGnE46R3o3vamVJMSJBZKH1DeLK8FwSoJHG7qDlGj/Hp/ejR8td59NbHmmtsP6f240Bg0PeFMETaCztDnFsdgK+onhce+wnZphRuhj50a5On+SQcy1+XdCGzUCXQkjdFz9EUrN/wPoCzpmGMy7Jljl2kKUboGPRb2rI147CyTxsRoI6OlPikD+shi2nJzHYVH8yXWZU+CEI0WxUg5q6o8C9kYNZWKQLDYcCjc2Gv9DbaVDIaaxIm6Om15OJzrlfHzLTV8KWEDgC37ag4Ib5HUeOf6GBVjC3fbnhB7cP/Un41tiX7daDyTa6aO3S7E2j7tleJUzO9rk326PuuvjlO+2hu6qtLz6e+/bI2yuOi+oTtvtjPTqotjtEt97vDOBRLGyLhzMGMZRmBvCD0acPZcQoCK2xUz4pEL+nu/cTnv/Q3RQTqkFfR3svyUmzIFlc8WHW29CJJ+T0j4+NvGl/d8jsleySgk7+eoyoUvPtxgflXdTyfaREdq0j5Xyo6qko0at69TWx9c5zlCE8tpfLWqwRKgzTnXp/OdhTfcyzlM2DSSPIlQMWDMBoBbkx4hG6i/Xy3QQigUcNCK6g6kkFORsyMfjuLrAPKKoBxSgKdZaDnFhU+TdbIIpda1kKcEH10WAzwSU+FjgMkK+RQDkzpvVFwxqrkMG7EVroQRc6B0/xan6cu+PsGBYLkuA1JBJORfb+7BZJx8jD/eh52xp1MTZY5AcqJavm+3jTPAKHElEC4aYCjAS/41nBsN4dfsdK4vUaA1VrEslWJ7J+C1uFwSIIXeE+0/ofJHvARr3PAzwFbbv3TALaxGUNTeSjpXf88hOiODi9yZ+Q8gocDyav1myrfkGcGkL0wPDqjzefQKOd50cUQtsz3Pbxmx6l6PVB8KDgQ89Ll+Lh63kM5BrUB/JQnmuP5GcTx8kDTteEjTJfOqojuRKIwIdiYl+oJmkTl+J/0FdMklLHYyPiykOhhu0PVehGHaeDCSCLMWTTZxowiHeVuEH24dmxgAuWK/LZfgTbRiy5ekOuYWHyvBX/kb3BL1zJ2sltK/RVQ12U9Du1Fu6Ns73PfpQSkxB/DqwKYuKcux8FFndrS9mk9aAC1Ul3zmQPHfJcgdCsNCIqcmR4j85ybSFlpYwS5KAFXi4U80WArgSHAInz021bdr6qzU6YBWB3yEW9huPScMHi17TGt+yc5W2l2YhqzHOg8xfsk+mGYY5Ch1s30djBW9esa0VpavSxzb4O5TpUTH1lZBs6rCgyAk3wDHMdWCR5M0OpJMKEknP+tCAcs0aoKVJ3SQdNc+dzORDMr4nlGgHmCd75853zH16WFXKO9DvTyHQXH0ScTHCXsBH6d83EroVAHJPSe8u0lIVgHBMkT6ZetjGXNdQ8fD0BS4ImCQ5Z+BOtRO0fmcOYht+FtmrYYyWiSdG6r5QtuXxdCqUs+CQu52yNrv6wqz5f2NY2YcUm88wPeWb4ngnOSQn8wXDfUmofpi6x7CWhr0ZiDkIsh3PLg9XkypHmH5KkuVwS5ir/NF+I6t8Pp0ymy1u0PbD+/kLJzrVbCm0/mMcLCLPyCdmLVQ3DmDxXrXa54pa8GcTFbjmhhRo/jxs+ouWVTcm9/twpfrmeTUAzk/YZkT8mdeHBFgGb1Q8DqcuWxgn6C8gbG3OrGoGbZcq63BZAJCEjHi+DU8+KbqjmeuAk02bFgu7A8XvGKhtLSxswjTeCRM9kA1c0oK7eDqe6eLGorjNW9eTM40UFtXJYRgUTPlarswJUZ33zc6N3JSK0XX0x6ZNPdXjSGM6+LCXR83zif6VfdPiyohiYp1Lwt22gv6oGu9yBMCIJR2d5xODsss1clEzzJkI9Doa8rrrMMj6nIMyxbzgM2xoZKOpR+xvPriopeQ5R9BBsgMunMxWmrIlOX4fBKa+YWLdqlV3Hv4KE2u5KkuU4xyz75DO78b62P2tWInpJ6oF4SIjcItTp8iqwkWaMeXrxtbwUBXVYmPO7VTHlgA3XAyzjHfPwi7dZyWokY7bXGjirsrCyPDAI9NinZDT1a/EbpZEIROMX3inSld498KnCedsudAZO8vGmNG6qhoim2EoK0KzA5aX3WMqxiS3R7jAMFHTVKtr9bem/pWRo2DqfPbFcUv647Kcfzj45dt4fOUB3/O3SrmqZnZVC+LuuWJhbJqOwX0LZO2V3EtiNzvvPisQaAdknMDzsW2kQ8ebtjLtLvxIwC/NrvjUERFI4kej7jQWhzzTny+/x+oSra6DTS2FdbDjBHuLEfLwTMDxzwLPRVcachKOsx4JwRzJRsXUOYUs0vd94LrQsI6Z3nEjtqQEhlf9zLFjnHR7agoioquBUmRycA8UERfBgIVAnx1C1Lz7oMA8yfPvet7FpuAicqiP/n9kohpNtdKSMGS8dtvgSoht99vaRGQ5uokqvXCQhKMi6HcjqrHOu+B1wZYnaQP4Q9gF/Axq4CAQfw6vCQ1zLFmF4gmMW1Bt2hZLxW4MTM7soVy+bHe6L9LZa+MpiXgwgVoyTq8RMg1Eyur5rWuhvM1AWDUU8wyekOTmEAJT+n1fPtdi3Qgf5OYJfdw3LQO+4FPmnQpaAhbjvAW9IfPFoV1QCcsK6lB21Zpg2GMpV0xOJG0cloEKs6LfbSZzKBqBJSO5qHFmZsJ06sYnVNXyPG5z7utDUVOoQcaZlrUuzPPZhN+6I8OMAbmwoXZoiSzqRbyuWKzh39cuKCTKIlX90vjAB4iBPxXzZcxHWAyc7R4XlVcYs6kp3lX8X/HQizUJE9qHg11ithJt+wPIXlsCzYBS/JLJ5LyXTjnPjHkYUcko38sIHG2aqJC34RUyXHQAo0E1QIH4NmgKAemD1ynGr9kuONFahiaQZmO/h5oA/L6b9GFZDiSvLerZpt+DK+DkFSeW2wl/OTwcf8jgz7vqHDQZRIHCbc9vTc03FkZvCx6Kjd5jzX3ZJzoVHlwGDz5P9CF0UhvDqDJlXLGQPoeI+UbuHWoMCpcmZotkx5vG8VWHGqtajRbcB0uCPO0GeV+HMxPoA0FfFRj+3lDQ8AdsvRUtJnfcCDwLp7JL4mhdnS4049N5LGZwQp3h92p/nsqPxYghXnOYGxgU16Vkar6xU8HL34IJ5Y1SOeOw/qyJ/CrCkpJ96kb6SpM9NJyKhDuRLtTfgwV44cl7+FjCmPggEoF2t2APsjZ4FB7mYBC56qqQvlsyMDJWNlfqJCzXz18HIGdqAd6H5eOHKp+H199wiGC2w7P9/gekRrPXTwTh44mlZ287HtMVMkljEfPm8npMxlQ7S3HdAOrhp5nchDSuLU3GF9ZK73ALgLNC4BVt5Rj2L/DG3zv0wUUVvqmXz70+i+kRfGgjZrDFfpw76fvAbmrcoYTuKjy4DhnfpR8rkCWYl4r2u4M7qNiF/P7zaEkcxl3RvwDr/dKl78OUIWc5dwFo45w9NKPJSQtl2aNFfEmugqvYtbwmIALfAQgLh1IeIoeQJxl6YByLCNf+qKEWg3hTd/TyCa9kGwVeAbsbQvnaNHRbhAP2TiVm89hKxBJFAmS2g6Hb2gzHRv5Zxgem5Um+nhI3ZUD1XZih9elE0KAd1CJniztaMWsBRN+Kz1XCVtmqMrHUiRCRwXVDLzjkECla7gnQaAiDYlm3kCrFT7AOI+UU50yK9pweVwIomzJdp40EKPgWg5z7VcRNuThx5QJVKJ3rDHkDurc6qqyWV0nNa4/C4TBSbbZiwFJdAc6Ia7Do8WtDoHJRDflAOP0KbnddAUnhDTAXynxebJqzl1h+2JBQTlXY1mN2kEtlqUwqCH7CRPtsYDPCkPgf4OJBqVfpOBN22UZnZFNzF8IOOnEqhIsreeQvZFf5zn862kywdSFaWvakCUQU5dJCb5gQm0KwVGZ0/CCXZE+YY8E70Y2wzbEgyKqL+OfNt5+XfZ5chCsNBCr/DPHIqYKAcfVT3fvMfpFr8yu6lgI2TI5K8n3u+/aGFlxe4pazNiGONJ4gsDrcQa9j107Cl1+jTO6v58iZQlruew42ID7ZBnhKWHPM9zuL6o9J/p2+T8xdzUAXjMflgZYbfJWaFrPmUccil/siYwE1PkMn8mNoyCAosJylhLEwBHR93OqekE0fsQb1nQOgqYeIcjhL01koKJccnmvLKT5rdWfvuhGkb6Y5Jloa83wYnfOZPbsAPRV924cu856R8At4831nkBC9TTjMLw3qAG7CT8hEA9zu/P57e2zHW/Wg98XAs03nZSyvJZCG/SM4NnMkmHCmmG8APAQ6TnK9vPnowwOefn3ra8kIxtumPEfMbiiT6ke5OxmB4a+zTQP4HTMuc6honDAg8yu6alFLRqBycFAevfRwgbA562TRY6eCNM01GOb+yKf8q2hwilMazOEew3b7LtBYEBdsPPoW/e9ig8Q8hj9KYH2d/6YTfm+HpbyUsoJTrYTaQN5jSAOiDd1llIg5+1kquyOJSw2gcXLQz+82EDayqE35z3PB2AXfPy41tcy6X1O8OausTYMuTvxCdhIh4TQsMbtyc7SR77av+l3TvSu0eKq6J7YMd0BT+fj+xLzyGWBK43ferc49gTOg1GjIX+ecaypgT69hsKrwnQIze5rTgID1Bc8QX2oZHCs9Bl4jL3c1Fi4ce/3YvgfCnHCC5/64rfQSoNLpJWt42s8wYT4gTjjLgW0aHmDTjkMGmC3zwaDIqyyPh2uLQz7t8fZ4lXeXV3jMAMkIpWVadnb5BSUJxnSF6giKPtNfcpi1aVwaEyyzRYUgh0ok4dpFhCTm4fNngMs+byQtxvbhaZBQu/ZKgLGEnICmqUB5RD9ZtryVN+VjEm7wv+U5f6mPTlg+K7Mh2uYiE5vJGbkj5eSd27Kkn/OHSyYxOGSn9JvsjHKuvjc8nboZQ0eeohZCt64xlkSzeXOykWqunm/QG+WgeRtgqDcS8A3A9Upap7aMfBZ2P5x2I/fE2dkIufY/+kjwUsACsEvrWJRQN5qBTaWxsMOS/Zv3U8jb06EFnJT4BRFS3MWQNsswleFiw8cVuf5DRcy2Z97/nFqhn+3hQK/RwYDErPImzvmkryHsFkXnJ1PvN0xO5VsjuTto+tM8DrJJ52r7+JC8FAFIOwdMbv5s2CkQQDFQ3ims6t482CLuRzgUx296JObMgySPp+3rnkOnqrDrt84KJ8GSp83VTvuWBl4TQSOjhkaG+JeEh6ugYO4EEq/yxAqVqc/qafN6fIwd/zY2ZXS4qWOisl8ZdXaIwEkW8R7KLqfP+t1ceQ7+o/PeOh5d6tdn9roFeL6EFDrrEhiCxKQtFA4CHFosAV1xZW1swUQc9pO7SJqY2/8dyKG7Phl3wmdughssHwnAygKYj0RckuBUUA5/cJihlIax4939/mRdcH7trFW/dWkLw6Jk968r9Rha/rFrlJqQGJ4yQwPnHkr5XL+vKvC3IxcnOKoOwr0ovBMriOcWr9vlT35DfGUJXJ6/gs+Zj94Mn38utvvaKMYRy3fG3elTqvxxhJ8567x6Jz39lbLhi7WzZuC8vHPf2RPNbjmv/4T4PJxQ7qHDdKptq8SGm0lXid+Ll8TxGsxbPng3P9SnTbOjARCzt7gQzJfuKpfaCWgB7XJu7287tYA/EQvqasUkdx4SKpQicN7E7d27H1Wbi5XPyt+OLWp8f1Ik9+n1z21PsTl/9/8FLgr8uQLMgAAAAASUVORK5CYII=';

app.get('/manifest.webmanifest', (req,res) => {
  res.type('application/manifest+json').send(JSON.stringify({
    name:'Acord',
    short_name:'Acord',
    description:'Conversas, servidores, chamadas e mensagens privadas.',
    start_url:'/',
    scope:'/',
    display:'standalone',
    background_color:'#07110e',
    theme_color:'#07110e',
    orientation:'any',
    icons:[
      {src:'/icon-192.png',sizes:'192x192',type:'image/png',purpose:'any maskable'},
      {src:'/icon-512.png',sizes:'512x512',type:'image/png',purpose:'any maskable'}
    ]
  }));
});

app.get('/icon-192.png', (req,res) => {
  res.type('image/png').send(Buffer.from(APP_ICON_192,'base64'));
});

app.get('/icon-512.png', (req,res) => {
  res.type('image/png').send(Buffer.from(APP_ICON_512,'base64'));
});

app.get('/sw.js', (req,res) => {
  res.type('application/javascript').send(`
const CACHE='acord-server-restore-fix-v10';
const CORE=['/','/manifest.webmanifest','/icon-192.png','/icon-512.png'];

self.addEventListener('install',event=>{
  event.waitUntil(
    caches.open(CACHE).then(cache=>cache.addAll(CORE)).catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    Promise.all([
      caches.keys().then(keys=>Promise.all(
        keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))
      )),
      self.clients.claim()
    ])
  );
});

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET') return;

  const url=new URL(event.request.url);

  if(url.pathname.startsWith('/socket.io/')) return;

  // HTML principal sempre atualizado.
  if(event.request.mode==='navigate' || url.pathname==='/'){
    event.respondWith(fetch(event.request,{cache:'no-store'}));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response=>{
        const clone=response.clone();
        caches.open(CACHE).then(cache=>cache.put(event.request,clone)).catch(()=>{});
        return response;
      })
      .catch(()=>caches.match(event.request))
  );
});
  `);
});

const APP_HTML = String.raw`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#08120f">
<meta name="application-name" content="Acord">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Acord">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon-192.png">
<title>Acord</title>
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

html[data-palette="ocean"]{
  --coral:#3182ce;--coral2:#63b3ed;--mint:#38bdf8;--mintbg:#0f3057;
}
html[data-palette="sunset"]{
  --coral:#ff7a59;--coral2:#ff9f68;--mint:#ffb347;--mintbg:#4a2430;
}
html[data-palette="forest"]{
  --coral:#2f855a;--coral2:#48bb78;--mint:#68d391;--mintbg:#173d2c;
}
html[data-palette="candy"]{
  --coral:#ec4899;--coral2:#f472b6;--mint:#a855f7;--mintbg:#321b47;
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
  background:color-mix(in srgb, var(--coral) 18%, var(--bg3));
  color:var(--text);
}
.homeHubIcon{
  overflow:hidden;
  padding:0;
}
.homeHubIcon img{
  width:100%;
  height:100%;
}
.homeHubMonitor{
  width:100%;
  height:100%;
  display:block;
  filter:drop-shadow(0 8px 14px rgba(0,0,0,.22));
}
.homeHubIcon:hover .homeHubMonitor,
.homeHubIcon.active .homeHubMonitor{
  transform:scale(1.02);
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
.controls{
  display:flex;
  justify-content:center;
  gap:9px;
  flex-wrap:wrap;
  padding:12px;
  border-top:1px solid var(--line);
  background:var(--bg1);
  position:sticky;
  bottom:0;
  z-index:120;
  flex-shrink:0;
  min-height:64px;
}
#voiceControls:not(.hidden){
  display:flex!important;
  visibility:visible!important;
  opacity:1!important;
}
.control{border:1px solid var(--line);background:var(--bg3);color:var(--text);border-radius:999px;padding:11px 15px;font-weight:800;min-width:120px}
.control:hover{background:var(--bg4)}.control.off{background:#18211e;color:var(--muted)}.control.sharing{background:var(--mintbg);color:var(--mint)}.control.danger{background:var(--danger);border-color:transparent}
.control.musicActive{background:var(--mintbg);color:var(--mint);border-color:rgba(65,217,154,.35)}

.localMusicPanel{
  border-bottom:1px solid var(--line);
  background:var(--bg1);
  padding:14px;
}
.localMusicShell{
  width:min(760px,100%);
  margin:0 auto;
  border:1px solid var(--line);
  border-radius:16px;
  background:var(--bg2);
  overflow:hidden;
}
.localMusicHead{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  padding:13px 14px;
  border-bottom:1px solid var(--line);
}
.localMusicTitle{font-weight:900;font-size:14px}
.localMusicOnly{
  font-size:10px;
  font-weight:900;
  color:var(--mint);
  background:var(--mintbg);
  border:1px solid rgba(65,217,154,.25);
  padding:5px 8px;
  border-radius:999px;
}
.localMusicBody{padding:14px}
.localMusicAdd{
  display:grid;
  grid-template-columns:auto 1fr auto;
  gap:8px;
}
.localMusicChoose{
  border:1px solid var(--line);
  background:var(--bg3);
  color:var(--text);
  border-radius:10px;
  padding:10px 12px;
  font-weight:800;
}
.localMusicChoose:hover{background:var(--bg4)}
.localMusicNow{
  margin-top:12px;
  padding:12px;
  border-radius:12px;
  background:var(--bg1);
  border:1px solid var(--line);
}
.localMusicNowLabel{
  color:var(--low);
  font-size:10px;
  font-weight:900;
  text-transform:uppercase;
  letter-spacing:.06em;
}
.localMusicTrack{
  margin-top:4px;
  color:var(--text);
  font-size:13px;
  font-weight:850;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.localMusicTimeline{
  display:grid;
  grid-template-columns:42px 1fr 42px;
  align-items:center;
  gap:8px;
  margin-top:10px;
}
.localMusicTimeline span{
  color:var(--low);
  font-size:10px;
  text-align:center;
}
.localMusicTimeline input{padding:0;border:0;box-shadow:none}
.localMusicControls{
  display:flex;
  align-items:center;
  justify-content:center;
  gap:8px;
  margin-top:10px;
  flex-wrap:wrap;
}
.localMusicControls button{
  border:1px solid var(--line);
  background:var(--bg3);
  color:var(--text);
  border-radius:999px;
  min-width:42px;
  height:38px;
  padding:0 12px;
  font-weight:900;
}
.localMusicControls button:hover{background:var(--bg4)}
#localMusicPlayBtn{
  min-width:54px;
  background:var(--coral);
  color:#281009;
  border-color:transparent;
}
.localMusicVolume{
  display:flex;
  align-items:center;
  gap:7px;
  margin-left:8px;
  color:var(--muted);
  font-size:11px;
}
.localMusicVolume input{width:110px;padding:0;border:0;box-shadow:none}
.localMusicList{
  margin-top:12px;
  display:grid;
  gap:6px;
  max-height:150px;
  overflow:auto;
}
.localMusicItem{
  display:flex;
  align-items:center;
  gap:8px;
  padding:8px 10px;
  border-radius:10px;
  border:1px solid var(--line);
  background:var(--bg1);
  color:var(--muted);
}
.localMusicItem.active{
  border-color:rgba(65,217,154,.38);
  color:var(--text);
  background:var(--mintbg);
}
.localMusicItemName{
  min-width:0;
  flex:1;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  font-size:11px;
  font-weight:750;
}
.localMusicItem button{
  border:0;
  background:transparent;
  color:var(--muted);
  font-weight:900;
  padding:4px 6px;
}
.localMusicEmpty{
  color:var(--low);
  font-size:11px;
  text-align:center;
  padding:10px;
}

@media(max-width:760px){
  .localMusicAdd{grid-template-columns:1fr auto}
  .localMusicChoose{grid-column:1/-1}
  .localMusicVolume{width:100%;justify-content:center;margin-left:0}
}

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

.profilePaletteChoices{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:7px;
  margin-top:8px;
}
.profilePaletteBtn{
  border:1px solid var(--line);
  background:var(--bg2);
  color:var(--text);
  border-radius:10px;
  padding:8px 5px;
  font-size:11px;
  font-weight:800;
}
.profilePaletteBtn:hover{background:var(--bg3)}
.profilePaletteBtn.active{outline:2px solid var(--mint);outline-offset:1px}
.profilePaletteSwatch{
  display:flex;
  justify-content:center;
  gap:3px;
  margin-bottom:6px;
}
.profilePaletteSwatch span{
  width:13px;
  height:24px;
  border-radius:5px;
  border:1px solid rgba(127,127,127,.25);
}
.paletteDefault span:nth-child(1){background:#ff6b4a}
.paletteDefault span:nth-child(2){background:#41d99a}
.paletteDefault span:nth-child(3){background:#24473b}
.paletteOcean span:nth-child(1){background:#3182ce}
.paletteOcean span:nth-child(2){background:#63b3ed}
.paletteOcean span:nth-child(3){background:#0f3057}
.paletteSunset span:nth-child(1){background:#ff7a59}
.paletteSunset span:nth-child(2){background:#ffb347}
.paletteSunset span:nth-child(3){background:#7b2cbf}
.paletteForest span:nth-child(1){background:#2f855a}
.paletteForest span:nth-child(2){background:#68d391}
.paletteForest span:nth-child(3){background:#1c4532}
.paletteCandy span:nth-child(1){background:#ec4899}
.paletteCandy span:nth-child(2){background:#a855f7}
.paletteCandy span:nth-child(3){background:#60a5fa}

@media(max-width:560px){
  .profileThemeChoices{grid-template-columns:repeat(3,1fr)}
  .profilePaletteChoices{grid-template-columns:repeat(2,1fr)}
}

.customColorBox{margin-top:18px;padding:14px;border:1px solid var(--line);background:var(--bg2);border-radius:14px}
.customColorTop{display:grid;grid-template-columns:46px 58px 1fr;align-items:center;gap:10px}
#customColorPicker{width:58px;height:42px;border:0;padding:0;background:transparent;cursor:pointer}
.customColorPreview{width:42px;height:42px;border-radius:50%;border:2px solid var(--line)}
.rgbFields{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}
.rgbField label{display:block;text-align:center;color:var(--muted);font-size:10px;margin-top:5px}
.rgbField input{text-align:center;padding:9px 6px}
.customColorActions{display:flex;gap:8px;margin-top:12px}
.customColorActions .btn{flex:1}

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

.authSwitch{display:grid;grid-template-columns:1fr 1fr;gap:5px;padding:4px;margin:0 0 18px;border:1px solid var(--line);border-radius:12px;background:var(--bg2)}
.authTab{border:0;border-radius:9px;padding:9px 10px;background:transparent;color:var(--muted);font-weight:850}
.authTab.active{background:var(--bg4);color:var(--text)}
.authField{margin-top:12px}.authError{min-height:18px;margin-top:10px;color:#ff8d8d;font-size:11px}
.profileBannerPreview{height:110px;border-radius:15px;border:1px solid var(--line);background:linear-gradient(135deg,var(--bg3),var(--coral));background-size:cover;background-position:center;margin-bottom:12px}
.accountDangerZone{margin-top:18px;padding-top:14px;border-top:1px solid var(--line);display:flex;gap:8px;flex-wrap:wrap}
.accountDangerZone .btn{flex:1;min-width:140px}
.message{position:relative}.messageActions{display:none;position:absolute;right:8px;top:-16px;gap:4px;background:var(--bg1);border:1px solid var(--line);border-radius:9px;padding:4px;z-index:3}
.message:hover .messageActions{display:flex}.messageActions button{border:0;background:transparent;color:var(--muted);padding:4px 6px;border-radius:6px}
.messageReply{font-size:10px;color:var(--low);padding:5px 7px;border-left:2px solid var(--coral);margin-bottom:7px;background:var(--bg1);border-radius:6px}
.messageAttachment{max-width:340px;max-height:260px;border-radius:10px;margin-top:8px;display:block}
.messageReactions{display:flex;gap:4px;flex-wrap:wrap;margin-top:7px}.reactionChip{border:1px solid var(--line);background:var(--bg1);color:var(--muted);border-radius:999px;padding:3px 7px;font-size:10px}
.replyBar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 12px;background:var(--bg2);border-top:1px solid var(--line);color:var(--muted);font-size:11px}
.callSettingsPanel{position:absolute;right:14px;bottom:78px;width:min(390px,calc(100% - 28px));background:var(--bg1);border:1px solid var(--line);border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.4);padding:14px;z-index:500}
.callSettingsGrid{display:grid;gap:10px}.callSettingsGrid label{font-size:10px;color:var(--low);font-weight:900;text-transform:uppercase}
.callSettingsGrid select{width:100%;margin-top:5px;border:1px solid var(--line);background:var(--bg2);color:var(--text);border-radius:9px;padding:9px}
.callToggle{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 10px;border:1px solid var(--line);border-radius:10px;background:var(--bg2)}
.stageHandBtn{background:var(--mintbg)!important;color:var(--mint)!important}
.musicExtraControls{display:flex;gap:6px;justify-content:center;margin-top:8px}.musicExtraControls button{border:1px solid var(--line);background:var(--bg3);color:var(--text);border-radius:999px;padding:7px 10px;font-size:11px}.musicExtraControls button.active{background:var(--mintbg);color:var(--mint)}




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
.sharePickerQuality{
  padding:0 18px 18px;
}
.sharePickerQualityTitle{
  color:var(--text);
  font-size:12px;
  font-weight:900;
  margin-bottom:8px;
}
.shareQualityChoices{
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:8px;
}
.shareQualityBtn{
  border:1px solid var(--line);
  background:var(--bg2);
  color:var(--muted);
  border-radius:10px;
  padding:10px 8px;
  font-weight:800;
}
.shareQualityBtn:hover{background:var(--bg3);color:var(--text)}
.shareQualityBtn.active{
  border-color:var(--coral);
  color:var(--text);
  box-shadow:0 0 0 2px rgba(255,107,74,.08);
}
.shareQualityBtn strong{display:block;font-size:12px}
.shareQualityBtn span{display:block;font-size:10px;color:var(--low);margin-top:3px}
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
.channelBtn.stage{min-height:52px;align-items:flex-start;padding-top:8px;padding-bottom:8px}
.channelBtn.stage .stageIcon{
  width:20px;height:20px;border:1px solid var(--muted);border-radius:50%;
  display:grid;place-items:center;font-size:10px;flex:0 0 auto;margin-top:1px
}
.channelBtn.stage .stageText{min-width:0;flex:1}
.channelBtn.stage .stageText strong{
  display:block;color:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px
}
.channelBtn.stage .stageText small{
  display:block;color:var(--low);font-size:9px;line-height:1.3;margin-top:2px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap
}
.serverPresenceSection{margin:6px 0 14px}
.serverPresenceTitle{
  color:var(--low);font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;padding:5px 8px
}
.serverMemberRow{
  display:flex;align-items:center;gap:9px;padding:8px;border-radius:10px;cursor:pointer;color:var(--muted)
}
.serverMemberRow:hover{background:var(--bg2);color:var(--text)}
.serverMemberRow.offline{opacity:.58}
.serverMemberAvatar{position:relative;flex:0 0 auto}
.serverMemberStatusDot{
  position:absolute;width:10px;height:10px;right:-2px;bottom:-2px;border-radius:50%;
  border:2px solid var(--bg1);background:var(--mint)
}
.serverMemberRow.offline .serverMemberStatusDot{background:var(--low)}
.serverMemberMeta{min-width:0;flex:1}
.serverMemberMeta strong{
  display:block;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap
}
.serverMemberMeta span{display:block;color:var(--low);font-size:10px;margin-top:2px}
.memberProfileCardTop{display:flex;align-items:center;gap:14px;margin-bottom:14px}
.memberProfileAvatar{
  width:72px!important;height:72px!important;border-radius:24px!important;font-size:24px!important;flex:0 0 auto
}
.memberProfileStatus{font-size:11px;color:var(--muted);margin-top:4px}
.memberProfileBio{
  border:1px solid var(--line);background:var(--bg2);border-radius:12px;padding:12px;
  color:var(--muted);font-size:12px;line-height:1.5;min-height:54px
}
.memberProfileRoles{margin-top:14px}
.memberProfileRolesTitle{
  color:var(--low);font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px
}
.memberRoleToggle{
  display:flex;align-items:center;gap:9px;padding:9px 10px;border:1px solid var(--line);
  border-radius:10px;background:var(--bg2);margin-bottom:6px
}
.memberRoleColor{width:12px;height:12px;border-radius:50%;flex:0 0 auto}
.memberRoleToggle span{min-width:0;flex:1;font-size:12px;font-weight:800}
.memberRoleToggle input{width:auto;margin:0}

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

.fakeFullscreen{position:fixed!important;inset:0 0 76px 0!important;width:100%!important;height:auto!important;z-index:100!important;border-radius:0!important;aspect-ratio:auto!important;background:#000!important}
.fakeFullscreen video{object-fit:contain!important}
body.locked{overflow:hidden!important}

.toast{position:fixed;right:18px;bottom:18px;z-index:3000000;background:var(--bg3);border:1px solid var(--line);color:var(--text);padding:11px 14px;border-radius:10px;box-shadow:0 12px 35px rgba(0,0,0,.3);font-size:13px}
.installAppBtn{
  position:fixed;
  right:18px;
  bottom:72px;
  z-index:2999999;
  border:1px solid var(--line);
  background:var(--coral);
  color:#281009;
  border-radius:12px;
  padding:11px 14px;
  font-weight:900;
  box-shadow:0 12px 35px rgba(0,0,0,.28);
}
.installAppBtn:hover{background:var(--coral2)}


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

/* ===== MODO MINIMALISTA ACORD ===== */
:root{
  --radius-xs:6px;
  --radius-sm:8px;
  --radius-md:10px;
}

*{
  scrollbar-width:thin;
}

body{
  background:var(--bg0);
}

button,
input,
textarea,
select{
  transition:.12s ease;
}

.app{
  gap:0;
}

.rail{
  background:var(--bg0);
  border-right:1px solid var(--line);
  padding-top:8px;
}

.serverIcon,
.addServer,
.homeHubIcon{
  border-radius:10px!important;
  box-shadow:none!important;
}

.serverIcon:hover,
.serverIcon.active,
.homeHubIcon:hover,
.homeHubIcon.active{
  border-radius:10px!important;
  transform:none!important;
  box-shadow:none!important;
}

.serverIcon.active:before{
  width:3px;
  height:18px;
  left:-10px;
}

.homeHubMonitor{
  filter:none!important;
}

.sidebar,
.rightbar,
.main,
.topbar,
.sideHead,
.userbar{
  box-shadow:none!important;
}

.sidebar{
  border-right:1px solid var(--line);
}

.rightbar{
  border-left:1px solid var(--line);
}

.sideHead,
.topbar{
  height:50px;
}

.sideScroll{
  padding:8px;
}

.brandDot{
  width:7px;
  height:7px;
  box-shadow:none;
}

.navBtn,
.channelBtn,
.inviteBtn,
.friendTab,
.btn,
.control{
  border-radius:8px!important;
  box-shadow:none!important;
}

.navBtn,
.channelBtn{
  padding:8px 9px;
}

.navBtn:hover,
.navBtn.active,
.channelBtn:hover,
.channelBtn.active{
  transform:none!important;
}

.groupHead{
  margin:14px 8px 5px;
  font-size:10px;
  letter-spacing:.05em;
}

.userbar{
  padding:9px 10px;
  border-top:1px solid var(--line)!important;
}

.avatar{
  box-shadow:none!important;
}

.topbar{
  padding-left:14px;
  padding-right:14px;
}

.topLeft strong,
#topTitle{
  font-weight:800;
}

.messages{
  padding:12px 16px;
}

.message{
  margin:0 0 4px;
  padding:8px 10px;
  border-radius:8px;
  background:transparent!important;
  border:0!important;
  box-shadow:none!important;
}

.message:hover{
  background:var(--bg2)!important;
}

.message strong{
  font-size:12px;
}

.message span{
  font-size:12px;
  line-height:1.45;
}

.messageActions{
  box-shadow:none!important;
  border-radius:7px;
}

.compose{
  padding:10px 12px;
  gap:7px;
  border-top:1px solid var(--line);
  background:var(--bg1);
}

.compose input,
input,
textarea,
select{
  box-shadow:none!important;
  border-radius:8px!important;
}

.compose input{
  min-height:38px;
}

.btn{
  min-height:36px;
}

.btn.primary{
  box-shadow:none!important;
}

.controls{
  gap:6px;
  padding:9px;
  min-height:56px;
}

.control{
  min-width:auto;
  padding:9px 12px;
  font-size:12px;
}

.videoGrid{
  gap:8px;
  padding:10px;
}

.videoCard{
  border-radius:10px!important;
  box-shadow:none!important;
  border:1px solid var(--line)!important;
}

.modal{
  border-radius:14px!important;
  box-shadow:0 18px 50px rgba(0,0,0,.28)!important;
  border:1px solid var(--line);
}

.modalWrap{
  backdrop-filter:blur(4px);
}

.profileTabs,
.authSwitch{
  border-radius:9px!important;
}

.profileTabBtn,
.authTab{
  border-radius:7px!important;
}

.profileThemeBtn,
.profilePaletteBtn{
  border-radius:9px!important;
  box-shadow:none!important;
}

.customColorBox,
.localMusicShell,
.localMusicNow,
.callSettingsPanel,
.settingsCard,
.memberProfileBio,
.memberRoleToggle{
  border-radius:10px!important;
  box-shadow:none!important;
}

.localMusicPanel{
  padding:10px;
}

.localMusicHead{
  padding:10px 12px;
}

.localMusicBody{
  padding:12px;
}

.localMusicNow{
  padding:10px;
}

.loginShell{
  box-shadow:none!important;
}

.loginBrandPanel{
  background:var(--bg1)!important;
  border-right:1px solid var(--line);
}

.loginHero h1{
  font-size:clamp(30px,4vw,48px)!important;
  line-height:1.02!important;
}

.loginFeatures{
  gap:8px!important;
}

.loginFeature{
  border-radius:9px!important;
  box-shadow:none!important;
  background:var(--bg2)!important;
}

.loginCard{
  box-shadow:none!important;
}

.loginMark,
.sharePickerLogo{
  border-radius:9px!important;
  box-shadow:none!important;
}

.sharePicker,
.shareChoice{
  border-radius:12px!important;
  box-shadow:none!important;
}

.sharePicker{
  background:var(--bg1)!important;
}

.shareChoice{
  min-height:120px;
  padding:14px;
}

.shareChoice:hover{
  transform:none!important;
}

.serverMemberRow,
.friendRow,
.settingsMember{
  border-radius:8px!important;
}

.serverPresenceTitle,
.memberProfileRolesTitle,
.localMusicNowLabel{
  letter-spacing:.05em!important;
}

.callSettingsPanel{
  width:min(360px,calc(100% - 28px));
}

.accountDangerZone{
  gap:6px;
}

.toast{
  border-radius:8px!important;
  box-shadow:0 10px 28px rgba(0,0,0,.24)!important;
}

.installAppBtn{
  border-radius:8px!important;
  box-shadow:none!important;
}

@media(max-width:900px){
  .rightbar{
    display:none;
  }
}

@media(max-width:720px){
  .control{
    padding:8px 10px;
  }

  .messages{
    padding:10px;
  }

  .compose{
    padding:8px;
  }
}


.passwordField{
  position:relative;
  display:flex;
  align-items:center;
}
.passwordField input{
  padding-right:46px!important;
}
.passwordToggle{
  position:absolute;
  right:6px;
  top:50%;
  transform:translateY(-50%);
  width:34px;
  height:30px;
  border:0;
  border-radius:7px;
  background:transparent;
  color:var(--muted);
  font-size:16px;
}
.passwordToggle:hover{
  background:var(--bg3);
  color:var(--text);
}

.friendsHome{
  position:relative;
  padding-bottom:58px;
}
.friendsAccountBar{
  position:absolute;
  left:0;
  right:0;
  bottom:0;
  min-height:54px;
  border:0;
  border-top:1px solid var(--line);
  background:var(--bg1);
  color:var(--text);
  display:flex;
  align-items:center;
  gap:9px;
  padding:8px 14px;
  text-align:left;
  z-index:20;
}
.friendsAccountBar:hover{
  background:var(--bg2);
}
.friendsAccountMeta{
  min-width:0;
  flex:1;
}
.friendsAccountMeta strong,
.friendsAccountMeta span{
  display:block;
}
.friendsAccountMeta strong{
  font-size:13px;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.friendsAccountMeta span{
  margin-top:2px;
  color:var(--muted);
  font-size:10px;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.friendsAccountGear{
  color:var(--low);
  font-size:15px;
}

.messageContextMenu{
  position:fixed;
  z-index:2500000;
  width:150px;
  padding:5px;
  border:1px solid var(--line);
  background:var(--bg1);
  border-radius:9px;
  box-shadow:0 12px 34px rgba(0,0,0,.32);
}
.messageContextMenu button{
  width:100%;
  border:0;
  background:transparent;
  color:var(--text);
  border-radius:6px;
  padding:8px 9px;
  text-align:left;
  font-size:12px;
}
.messageContextMenu button:hover{
  background:var(--bg3);
}
.messageContextMenu button.danger{
  color:#ff8d8d;
}
.messageContextMenu button.hidden{
  display:none!important;
}


/* ===== ACORD — REDESIGN FINAL ===== */
:root{
  --accent:var(--coral);
  --accent-2:var(--coral2);
  --accent-soft:color-mix(in srgb,var(--coral) 16%,transparent);
  --panel:color-mix(in srgb,var(--bg1) 94%,black);
  --panel-2:color-mix(in srgb,var(--bg2) 94%,black);
  --panel-3:color-mix(in srgb,var(--bg3) 92%,black);
}

body{
  background:
    radial-gradient(circle at 35% 8%,color-mix(in srgb,var(--coral) 8%,transparent),transparent 33%),
    linear-gradient(180deg,var(--bg0),color-mix(in srgb,var(--bg0) 90%,black));
}

.app{
  background:transparent;
}

.rail{
  width:76px;
  padding:14px 10px;
  gap:10px;
  background:rgba(4,12,11,.92);
  border-right:1px solid color-mix(in srgb,var(--coral) 18%,var(--line));
}

.serverIcon,
.homeHubIcon,
.addServer{
  width:50px!important;
  height:50px!important;
  border-radius:14px!important;
  border:1px solid color-mix(in srgb,var(--coral) 18%,var(--line))!important;
  background:var(--panel-2)!important;
}

.serverIcon.active,
.homeHubIcon.active{
  border-color:var(--coral)!important;
  box-shadow:0 0 0 1px color-mix(in srgb,var(--coral) 40%,transparent),
             0 0 24px color-mix(in srgb,var(--coral) 24%,transparent)!important;
}

.homeHubMonitor{
  width:100%;
  height:100%;
}

.sidebar{
  width:300px;
  background:rgba(7,18,16,.96)!important;
  border-right:1px solid color-mix(in srgb,var(--coral) 14%,var(--line));
}

.sideHead{
  height:64px;
  padding:0 16px;
  border-bottom:1px solid var(--line);
}

.sideScroll{
  padding:12px;
}

.channelBtn{
  min-height:38px;
  padding:9px 11px;
  border-radius:9px!important;
  color:var(--muted);
}

.channelBtn:hover{
  background:var(--panel-3)!important;
  color:var(--text);
}

.channelBtn.active{
  background:color-mix(in srgb,var(--coral) 17%,var(--panel-3))!important;
  color:var(--text)!important;
  border:1px solid color-mix(in srgb,var(--coral) 35%,var(--line))!important;
}

.groupHead{
  color:var(--coral)!important;
  letter-spacing:.08em;
  font-size:10px;
  font-weight:900;
}

.main{
  background:transparent!important;
}

.topbar{
  height:64px;
  padding:0 20px;
  background:rgba(7,17,15,.94)!important;
  border-bottom:1px solid var(--line);
}

#topTitle{
  font-size:17px!important;
  font-weight:900!important;
}

#topSub{
  color:var(--muted)!important;
}

.friendsHome{
  background:transparent!important;
  padding-bottom:64px!important;
}

.friendsHomeTop{
  padding:20px 24px 14px!important;
  border-bottom:1px solid var(--line);
  background:rgba(7,17,15,.78);
}

.friendTab{
  min-height:36px;
  padding:8px 11px!important;
  border-radius:8px!important;
  color:var(--muted)!important;
  background:transparent!important;
}

.friendTab.active{
  color:var(--coral)!important;
  background:color-mix(in srgb,var(--coral) 12%,transparent)!important;
  box-shadow:inset 0 -2px 0 var(--coral)!important;
}

.friendTab.add{
  color:#fff!important;
  background:var(--coral)!important;
}

.friendSearch{
  margin:12px 16px 0!important;
  border:1px solid color-mix(in srgb,var(--coral) 12%,var(--line))!important;
  background:rgba(7,18,16,.82)!important;
}

.friendsListArea{
  padding:16px!important;
}

.friendRow{
  min-height:62px;
  padding:10px 12px!important;
  border-radius:0!important;
  border-bottom:1px solid color-mix(in srgb,var(--line) 84%,transparent)!important;
  background:transparent!important;
}

.friendRow:hover{
  background:color-mix(in srgb,var(--coral) 7%,transparent)!important;
}

.friendsSectionTitle{
  color:var(--coral)!important;
  font-size:10px!important;
  letter-spacing:.11em!important;
}

.friendsAccountBar{
  left:0!important;
  right:0!important;
  bottom:0!important;
  min-height:62px!important;
  background:rgba(5,15,13,.97)!important;
  border-top:1px solid color-mix(in srgb,var(--coral) 16%,var(--line))!important;
  padding:9px 16px!important;
}

.rightbar{
  width:310px;
  background:rgba(7,18,16,.95)!important;
  border-left:1px solid color-mix(in srgb,var(--coral) 14%,var(--line));
}

#rightTitle{
  color:var(--text)!important;
  font-size:13px!important;
  font-weight:900!important;
}

.serverMemberRow,
.settingsMember{
  min-height:52px;
  border-radius:8px!important;
  padding:8px 10px!important;
}

.serverMemberRow:hover,
.settingsMember:hover{
  background:color-mix(in srgb,var(--coral) 7%,transparent)!important;
}

.messages{
  padding:20px 26px 90px!important;
  background:
    radial-gradient(circle at 70% 15%,color-mix(in srgb,var(--coral) 5%,transparent),transparent 32%);
}

.message{
  padding:9px 10px!important;
  margin-bottom:2px!important;
  border-radius:8px!important;
}

.message:hover{
  background:color-mix(in srgb,var(--coral) 6%,transparent)!important;
}

.message strong{
  font-size:13px!important;
}

.compose{
  position:sticky;
  bottom:0;
  padding:12px 16px!important;
  background:linear-gradient(180deg,transparent,rgba(5,14,12,.98) 28%)!important;
  border-top:0!important;
}

.compose input{
  min-height:44px!important;
  border-radius:12px!important;
  border:1px solid color-mix(in srgb,var(--coral) 18%,var(--line))!important;
  background:rgba(8,20,18,.96)!important;
}

.btn.primary{
  background:var(--coral)!important;
  border-color:var(--coral)!important;
}

.control{
  min-height:44px;
  border-radius:11px!important;
  border:1px solid color-mix(in srgb,var(--coral) 13%,var(--line))!important;
  background:rgba(9,23,20,.96)!important;
}

.control:hover{
  background:color-mix(in srgb,var(--coral) 14%,var(--panel-3))!important;
}

.control.sharing,
.control.musicActive,
.stageHandBtn{
  color:var(--coral)!important;
  background:color-mix(in srgb,var(--coral) 12%,var(--panel-2))!important;
  border-color:color-mix(in srgb,var(--coral) 40%,var(--line))!important;
}

.controls{
  min-height:68px!important;
  background:rgba(5,15,13,.98)!important;
  border-top:1px solid color-mix(in srgb,var(--coral) 14%,var(--line))!important;
}

.videoGrid{
  padding:18px!important;
  gap:14px!important;
}

.videoCard{
  background:linear-gradient(180deg,
    color-mix(in srgb,var(--coral) 5%,var(--panel-2)),
    var(--panel))!important;
  border:1px solid color-mix(in srgb,var(--coral) 16%,var(--line))!important;
  border-radius:14px!important;
}

.callSettingsPanel,
.localMusicShell,
.modal{
  background:rgba(7,18,16,.98)!important;
  border:1px solid color-mix(in srgb,var(--coral) 16%,var(--line))!important;
}

.modal{
  border-radius:16px!important;
}

.profileTabs,
.authSwitch{
  background:var(--panel-2)!important;
  border-color:color-mix(in srgb,var(--coral) 14%,var(--line))!important;
}

.profileTabBtn.active,
.authTab.active{
  color:var(--coral)!important;
  background:color-mix(in srgb,var(--coral) 12%,var(--panel-3))!important;
}

.profileThemeBtn.active,
.profilePaletteBtn.active{
  border-color:var(--coral)!important;
  box-shadow:0 0 0 1px color-mix(in srgb,var(--coral) 25%,transparent)!important;
}

.customColorPreview{
  border-color:var(--coral)!important;
}

.loginShell{
  background:
    radial-gradient(circle at 18% 15%,color-mix(in srgb,var(--coral) 12%,transparent),transparent 30%),
    var(--bg0)!important;
}

.loginBrandPanel{
  background:rgba(5,15,13,.96)!important;
}

.loginMark{
  background:var(--coral)!important;
}

.sharePicker{
  background:rgba(7,18,16,.98)!important;
}

.shareChoice:hover{
  border-color:var(--coral)!important;
}

.messageContextMenu{
  background:rgba(7,18,16,.99)!important;
  border-color:color-mix(in srgb,var(--coral) 20%,var(--line))!important;
}

.toast{
  background:rgba(7,18,16,.98)!important;
  border:1px solid color-mix(in srgb,var(--coral) 18%,var(--line))!important;
}

@media(max-width:1050px){
  .rightbar{display:none!important}
}

@media(max-width:820px){
  .sidebar{width:240px}
}


.uiIcon{
  width:16px;
  height:16px;
  display:inline-block;
  flex:0 0 auto;
  fill:currentColor;
  vertical-align:-3px;
}
.btn .uiIcon,.inviteBtn .uiIcon,.friendTab .uiIcon,.settingsNavBtn .uiIcon,.control .uiIcon{
  margin-right:6px;
}
.iconOnly .uiIcon{margin-right:0}
.passwordToggle .uiIcon{width:17px;height:17px;margin:0}
.friendsAccountGear .uiIcon{width:17px;height:17px}
*{
  font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Segoe UI Symbol","Segoe UI Emoji",sans-serif;
}


/* ===== ACORD — REPARO DE LAYOUT E ÍCONES ===== */
:root{
  --accent-contrast:#07110e;
}

html[data-theme="black"]{
  --accent-contrast:#07110e;
}
html[data-theme="white"],
html[data-theme="blue"],
html[data-theme="purple"]{
  --accent-contrast:#ffffff;
}
html[data-palette="sunset"],
html[data-palette="forest"]{
  --accent-contrast:#07110e;
}
html[data-palette="ocean"],
html[data-palette="candy"]{
  --accent-contrast:#ffffff;
}

/* O grid precisa usar as mesmas larguras reais das colunas. */
.app{
  width:100vw!important;
  height:100vh!important;
  min-width:0!important;
  overflow:hidden!important;
}

.app.hubMode{
  grid-template-columns:76px minmax(0,1fr) 280px!important;
}

.app.serverMode{
  grid-template-columns:76px 300px minmax(0,1fr) 280px!important;
}

.rail{
  width:auto!important;
  min-width:0!important;
  max-width:none!important;
  padding:12px 10px!important;
  overflow-x:hidden!important;
}

.sidebar{
  width:auto!important;
  min-width:0!important;
  max-width:none!important;
}

.main{
  width:auto!important;
  min-width:0!important;
  overflow:hidden!important;
}

.rightbar{
  width:auto!important;
  min-width:0!important;
  max-width:none!important;
}

/* Não usar background shorthand nos servidores:
   ele apagava a imagem do servidor. */
.serverIcon{
  overflow:hidden!important;
  padding:0!important;
  background-color:var(--bg2)!important;
  background-image:none!important;
}

.serverIcon:hover{
  background-color:color-mix(in srgb,var(--coral) 15%,var(--bg2))!important;
}

.serverIcon.active{
  background-color:color-mix(in srgb,var(--coral) 18%,var(--bg2))!important;
}

.serverIconImage{
  display:block!important;
  width:100%!important;
  height:100%!important;
  object-fit:cover!important;
  border-radius:inherit!important;
  pointer-events:none!important;
}

#serverRail{
  width:100%!important;
  align-items:center!important;
}

/* Barra de amigos sempre organizada e sem estourar. */
.friendsHomeTop{
  display:flex!important;
  align-items:center!important;
  gap:6px!important;
  min-height:60px!important;
  padding:10px 16px!important;
  overflow-x:auto!important;
  overflow-y:hidden!important;
  white-space:nowrap!important;
  scrollbar-width:none!important;
}
.friendsHomeTop::-webkit-scrollbar{
  display:none!important;
}

.friendTab{
  flex:0 0 auto!important;
}

.friendTab.add,
.btn.primary{
  color:var(--accent-contrast)!important;
  background-color:var(--coral)!important;
}

/* Corrige o botão branco sem texto quando a cor principal é branca. */
.friendTab.add{
  min-width:116px!important;
  font-weight:900!important;
}

/* Campo de busca correto. */
.friendsSearchWrap{
  padding:12px 16px 0!important;
}

.friendsSearchWrap input{
  height:42px!important;
  min-height:42px!important;
  padding:0 14px!important;
  border:1px solid var(--line)!important;
  background:var(--bg2)!important;
  color:var(--text)!important;
}

/* Área central não pode ficar esmagada por regras antigas. */
.content,
.view,
.friendsHome,
.chatView,
.voiceView{
  min-width:0!important;
  min-height:0!important;
}

.chatView{
  width:100%!important;
}

.chatHead{
  min-height:52px!important;
  padding:13px 18px!important;
}

/* Sidebar de servidor limpa e proporcional. */
.sideHead{
  min-height:64px!important;
  height:64px!important;
  padding:0 14px!important;
}

.sideHead .brand{
  flex:1 1 auto!important;
  min-width:0!important;
}

.sideHead > div:last-child{
  flex:0 0 auto!important;
}

.sideScroll{
  padding:12px!important;
  min-width:0!important;
}

#channelTree{
  width:100%!important;
  min-width:0!important;
}

.channelBtn{
  width:100%!important;
  min-width:0!important;
  max-width:100%!important;
  overflow:hidden!important;
}

.channelBtn > span{
  min-width:0!important;
}

.channelBtn .stageText{
  overflow:hidden!important;
}

.channelBtn .stageText strong,
.channelBtn .stageText small{
  overflow:hidden!important;
  text-overflow:ellipsis!important;
  white-space:nowrap!important;
}

/* Os 3 botões de criar canal não devem ficar apertados demais. */
.sideScroll > div[style*="grid-template-columns:repeat(3,1fr)"]{
  grid-template-columns:repeat(3,minmax(0,1fr))!important;
  gap:6px!important;
}

#createTextQuickBtn,
#createVoiceQuickBtn,
#createStageQuickBtn{
  min-width:0!important;
  padding:8px 5px!important;
  font-size:11px!important;
  overflow:hidden!important;
}

/* Ícones SVG sempre visíveis. */
.uiIcon{
  display:inline-block!important;
  width:16px!important;
  height:16px!important;
  min-width:16px!important;
  min-height:16px!important;
  fill:currentColor!important;
  stroke:none!important;
  opacity:1!important;
}

.iconOnly{
  display:inline-grid!important;
  place-items:center!important;
  min-width:32px!important;
  min-height:32px!important;
  padding:6px!important;
}

.iconOnly .uiIcon{
  margin:0!important;
}

/* Conta inferior e botões nunca somem. */
.userbar,
.friendsAccountBar{
  flex-shrink:0!important;
}

.friendsAccountBar{
  width:100%!important;
}

.controls{
  width:100%!important;
  overflow-x:auto!important;
  flex-wrap:nowrap!important;
}

.control{
  flex:0 0 auto!important;
}

/* Corrige cores em temas claros/escuros sem fixar verde. */
.brandDot,
.serverMemberStatusDot{
  background:var(--coral)!important;
}

.friendTab.active,
.groupHead,
.friendsSectionTitle{
  color:var(--coral)!important;
}

/* Responsividade: esconder painel direito antes de esmagar o centro. */
@media(max-width:1180px){
  .app.hubMode{
    grid-template-columns:76px minmax(0,1fr)!important;
  }

  .app.serverMode{
    grid-template-columns:76px 280px minmax(0,1fr)!important;
  }

  .rightbar{
    display:none!important;
  }
}

@media(max-width:760px){
  .app.serverMode{
    grid-template-columns:64px 230px minmax(0,1fr)!important;
  }

  .app.hubMode{
    grid-template-columns:64px minmax(0,1fr)!important;
  }

  .rail{
    padding-left:6px!important;
    padding-right:6px!important;
  }

  .serverIcon,
  .homeHubIcon,
  .addServer{
    width:46px!important;
    height:46px!important;
  }
}


.chatSearchInput{
  width:min(250px,32vw)!important;height:34px!important;min-height:34px!important;
  padding:0 10px!important;font-size:11px!important
}
.typingIndicator{min-height:24px;padding:4px 16px 7px;color:var(--muted);font-size:10px;font-style:italic}
.notificationPanel{
  position:fixed;top:62px;right:18px;z-index:2000000;width:min(360px,calc(100vw - 36px));
  max-height:520px;overflow:hidden;border:1px solid var(--line);border-radius:12px;
  background:var(--bg1);box-shadow:0 18px 50px rgba(0,0,0,.35)
}
.notificationPanelHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px;border-bottom:1px solid var(--line)}
.notificationList{max-height:450px;overflow:auto;padding:6px}
.notificationItem{padding:10px;border-radius:8px;color:var(--muted);font-size:11px}
.notificationItem:hover{background:var(--bg2);color:var(--text)}
.notificationItem strong{display:block;color:var(--text);font-size:12px;margin-bottom:3px}
.notificationEmpty{padding:18px;color:var(--low);font-size:11px;text-align:center}
.videoCard.speaking{outline:3px solid var(--coral)!important;outline-offset:2px!important;box-shadow:0 0 26px color-mix(in srgb,var(--coral) 28%,transparent)!important}
.serverMemberRow.blockedUser,.friendRow.blockedUser{opacity:.42!important}


/* ===== CATEGORIAS E CANAIS — ESTILO DISCORD ===== */
#channelTree{
  padding:4px 2px 18px!important;
  overflow:visible!important;
}

.discordUncategorized{
  display:grid;
  gap:2px;
  margin:0 0 12px;
}

.discordCategory{
  margin:12px 0 4px;
}

.discordCategoryHeader{
  position:relative;
  min-height:26px;
  display:flex;
  align-items:center;
  gap:4px;
  padding:0 3px 0 0;
  border-radius:5px;
  color:var(--low);
}

.discordCategoryHeader.dragOver{
  background:color-mix(in srgb,var(--coral) 12%,transparent);
  outline:1px dashed color-mix(in srgb,var(--coral) 55%,transparent);
}

.discordCategoryToggle{
  min-width:0;
  flex:1;
  height:26px;
  display:flex;
  align-items:center;
  gap:4px;
  padding:0 4px;
  border:0;
  background:transparent;
  color:inherit;
  text-align:left;
}

.discordCategoryToggle:hover{
  color:var(--text);
}

.discordCategoryArrow{
  width:12px;
  flex:0 0 12px;
  font-size:15px;
  line-height:1;
  text-align:center;
}

.discordCategoryName{
  min-width:0;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  font-size:10px;
  line-height:1;
  letter-spacing:.065em;
  font-weight:900;
}

.discordCategoryActions{
  display:flex;
  align-items:center;
  opacity:.35;
  transition:opacity .12s ease;
}

.discordCategoryHeader:hover .discordCategoryActions{
  opacity:1;
}

.discordCategoryAction{
  width:23px;
  height:23px;
  display:grid;
  place-items:center;
  border:0;
  border-radius:5px;
  background:transparent;
  color:var(--muted);
  font-size:17px;
  line-height:1;
  padding:0;
}

.discordCategoryAction:hover{
  background:var(--bg3);
  color:var(--text);
}

.discordCategoryChannels{
  display:grid;
  gap:2px;
  min-height:2px;
}

.discordCategoryChannels.dragOver,
.discordUncategorized.dragOver{
  border-radius:7px;
  background:color-mix(in srgb,var(--coral) 7%,transparent);
}

.discordChannel{
  width:100%;
  min-width:0;
  min-height:34px;
  display:flex;
  align-items:center;
  gap:7px;
  padding:5px 8px;
  border:0;
  border-radius:7px;
  background:transparent;
  color:var(--muted);
  text-align:left;
}

.discordChannel:hover{
  background:var(--bg3);
  color:var(--text);
}

.discordChannel.active{
  background:color-mix(in srgb,var(--coral) 14%,var(--bg3));
  color:var(--text);
}

.discordChannel.dragging{
  opacity:.45;
}

.discordChannel.dragOver{
  box-shadow:inset 0 2px 0 var(--coral);
}

.discordChannelIcon{
  width:20px;
  flex:0 0 20px;
  display:grid;
  place-items:center;
  color:var(--low);
  font-size:19px;
  font-weight:500;
}

.discordChannel.active .discordChannelIcon,
.discordChannel:hover .discordChannelIcon{
  color:var(--muted);
}

.discordChannelBody{
  min-width:0;
  flex:1;
  display:flex;
  align-items:center;
  gap:6px;
}

.discordChannelName{
  min-width:0;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  font-size:13px;
  line-height:1.2;
  font-weight:650;
}

.discordChannelSub{
  flex:0 0 auto;
  padding:2px 5px;
  border-radius:999px;
  background:color-mix(in srgb,var(--coral) 12%,transparent);
  color:var(--coral);
  font-size:8px;
  font-weight:900;
  text-transform:uppercase;
}

.discordChannelCount{
  flex:0 0 auto;
  min-width:19px;
  height:19px;
  display:grid;
  place-items:center;
  border-radius:999px;
  background:var(--bg4);
  color:var(--muted);
  font-size:9px;
  font-weight:900;
}

.discordEmptyCategory,
.discordCreateCategory{
  width:100%;
  min-height:32px;
  border:1px dashed color-mix(in srgb,var(--line) 78%,transparent);
  border-radius:7px;
  background:transparent;
  color:var(--low);
  text-align:left;
  padding:6px 9px;
  font-size:10px;
}

.discordEmptyCategory:not(:disabled):hover,
.discordCreateCategory:hover{
  border-color:color-mix(in srgb,var(--coral) 45%,var(--line));
  color:var(--text);
  background:color-mix(in srgb,var(--coral) 6%,transparent);
}

.categoryAddMenu{
  position:fixed;
  z-index:2200000;
  width:190px;
  padding:5px;
  border:1px solid var(--line);
  border-radius:9px;
  background:var(--bg1);
  box-shadow:0 16px 38px rgba(0,0,0,.34);
}

.categoryAddMenu button{
  width:100%;
  display:flex;
  align-items:center;
  gap:9px;
  border:0;
  border-radius:6px;
  background:transparent;
  color:var(--text);
  padding:8px 9px;
  text-align:left;
  font-size:11px;
}

.categoryAddMenu button:hover{
  background:var(--bg3);
}

.categoryAddMenuIcon{
  width:20px;
  flex:0 0 20px;
  display:grid;
  place-items:center;
  color:var(--muted);
  font-size:16px;
}

/* Os botões rápidos viram uma barra compacta de criação. */
.sideScroll > div[style*="grid-template-columns:repeat(3,1fr)"]{
  display:flex!important;
  gap:5px!important;
  margin-bottom:10px!important;
}

#createTextQuickBtn,
#createVoiceQuickBtn,
#createStageQuickBtn{
  flex:1 1 0!important;
  min-width:0!important;
  min-height:30px!important;
  padding:6px!important;
  font-size:10px!important;
  border-radius:6px!important;
}

/* A ação de categoria fica parecida com uma ação discreta do Discord. */
#createCategoryBtn{
  width:100%!important;
  min-height:30px!important;
  justify-content:flex-start!important;
  border:0!important;
  background:transparent!important;
  color:var(--low)!important;
  padding:6px 8px!important;
  font-size:10px!important;
}

#createCategoryBtn:hover{
  color:var(--text)!important;
  background:var(--bg3)!important;
}


.createCategoryMainBtn{
  width:100%!important;
  min-height:34px!important;
  display:flex!important;
  align-items:center!important;
  justify-content:flex-start!important;
  padding:7px 9px!important;
  margin:2px 0 8px!important;
  border:1px dashed color-mix(in srgb,var(--coral) 30%,var(--line))!important;
  border-radius:7px!important;
  background:color-mix(in srgb,var(--coral) 5%,transparent)!important;
  color:var(--muted)!important;
  font-size:11px!important;
  font-weight:800!important;
}
.createCategoryMainBtn:hover{
  border-color:var(--coral)!important;
  color:var(--text)!important;
  background:color-mix(in srgb,var(--coral) 10%,transparent)!important;
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
          <div class="loginBrandName" style="color:var(--coral)">Acord</div>
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

      <div class="loginSignature">Acord · converse do seu jeito</div>
    </section>

    <section class="loginCard">
      <div class="smallLogo">
        <div class="loginMark">e</div>
        <div class="loginBrandName">Acord</div>
      </div>

      <div class="authSwitch">
        <button id="authLoginTab" class="authTab active" type="button">Entrar</button>
        <button id="authRegisterTab" class="authTab" type="button">Criar conta</button>
      </div>

      <h2 id="authTitle">Entrar no Acord</h2>
      <p id="authText">Entre com seu nome único e sua senha.</p>

      <div class="authField">
        <label class="loginLabel" for="authUsername">Nome único</label>
        <input id="authUsername" maxlength="30" placeholder="Ex.: Davi" autocomplete="username">
      </div>

      <div class="authField">
        <label class="loginLabel" for="authPassword">Senha</label>
        <div class="passwordField">
          <input id="authPassword" type="password" maxlength="128" placeholder="Sua senha" autocomplete="current-password">
          <button id="showAuthPasswordBtn" class="passwordToggle" type="button" aria-label="Mostrar senha" title="Mostrar senha"><svg class="uiIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Zm10 4a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/></svg></button>
        </div>
      </div>

      <div id="authConfirmWrap" class="authField hidden">
        <label class="loginLabel" for="authPasswordConfirm">Confirmar senha</label>
        <div class="passwordField">
          <input id="authPasswordConfirm" type="password" maxlength="128" placeholder="Repita a senha" autocomplete="new-password">
          <button id="showAuthConfirmBtn" class="passwordToggle" type="button" aria-label="Mostrar senha" title="Mostrar senha"><svg class="uiIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Zm10 4a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/></svg></button>
        </div>
      </div>

      <button id="loginBtn" class="btn primary" style="width:100%;margin-top:14px;">Entrar</button>
      <div id="authError" class="authError"></div>

      <div class="loginPrivacy"><b>Conta pessoal:</b> cada nome é exclusivo e não pode se repetir.</div>
    </section>

  </div>
</div>

<div id="appShell" class="app hubMode hidden">
  <aside class="rail">
    <button id="homeHubBtn" class="serverIcon homeHubIcon active" type="button" title="Início do Acord">
      <svg class="homeHubMonitor" viewBox="0 0 64 64" aria-hidden="true">
        <defs>
          <radialGradient id="hubGlow" cx="50%" cy="45%" r="65%">
            <stop offset="0%" stop-color="#1edd9f"/>
            <stop offset="100%" stop-color="#0a4c3e"/>
          </radialGradient>
          <linearGradient id="hubScreen" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="var(--coral2)"/>
            <stop offset="100%" stop-color="var(--coral)"/>
          </linearGradient>
        </defs>
        <rect x="2" y="2" width="60" height="60" rx="18" fill="url(#hubGlow)"/>
        <rect x="10" y="13" width="44" height="31" rx="8" fill="url(#hubScreen)"/>
        <circle cx="24" cy="28" r="4.2" fill="#055246"/>
        <circle cx="40" cy="28" r="4.2" fill="#055246"/>
        <path d="M22 35.5c5.1 4.4 14.9 4.4 20 0" fill="none" stroke="#055246" stroke-width="2.8" stroke-linecap="round"/>
        <path d="M26 44h12l1.8 7H24.2Z" fill="var(--coral)"/>
        <rect x="21" y="51" width="22" height="4" rx="2" fill="var(--coral)"/>
      </svg>
    </button>

    <div class="railSep"></div>
    <div id="serverRail"></div>
    <div class="railSep"></div>
    <button id="createServerBtn" class="addServer" title="Criar servidor">+</button>
  </aside>

  <aside class="sidebar">
    <div class="sideHead">
      <div class="brand"><span class="brandDot"></span><span id="serverTitle" class="serverTitle">Acord</span></div>
      <div style="display:flex;align-items:center;gap:6px;">
        <button id="inviteBtn" class="inviteBtn">Convidar</button>
        <button id="serverSettingsBtn" class="inviteBtn iconOnly" title="Configurações do servidor"><svg class="uiIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm8.2 4.6v-2.2l-2-.7a7.3 7.3 0 0 0-.7-1.6l.9-1.9-1.6-1.6-1.9.9a7.3 7.3 0 0 0-1.6-.7l-.7-2h-2.2l-.7 2a7.3 7.3 0 0 0-1.6.7l-1.9-.9-1.6 1.6.9 1.9a7.3 7.3 0 0 0-.7 1.6l-2 .7v2.2l2 .7c.2.6.4 1.1.7 1.6l-.9 1.9 1.6 1.6 1.9-.9c.5.3 1 .5 1.6.7l.7 2h2.2l.7-2c.6-.2 1.1-.4 1.6-.7l1.9.9 1.6-1.6-.9-1.9c.3-.5.5-1 .7-1.6l2-.7Z"/></svg></button>
        <button id="deleteServerBtn" class="inviteBtn iconOnly" title="Apagar servidor"><svg class="uiIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8h10l-.8 11H7.8L7 8Zm2-3h6l1 2H8l1-2Zm-3 2h12v2H6V7Z"/></svg></button>
      </div>
    </div>

    <div class="sideScroll">
      <button id="serverRolesBtn" class="navBtn" type="button">Cargos</button>

      <div class="groupHead">
        <span>Canais</span>
      </div>

      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:0 2px 9px;">
        <button id="createTextQuickBtn" class="btn secondary small" type="button"># Texto</button>
        <button id="createVoiceQuickBtn" class="btn secondary small" type="button"><svg class="uiIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4V9Zm12.2-.8a5 5 0 0 1 0 7.6l-1.3-1.5a3 3 0 0 0 0-4.6l1.3-1.5Zm2.8-2.5a8.5 8.5 0 0 1 0 12.6l-1.3-1.5a6.5 6.5 0 0 0 0-9.6L19 5.7Z"/></svg>Voz</button>
        <button id="createStageQuickBtn" class="btn secondary small" type="button"><svg class="uiIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 2a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm-3 5h6v4H9v-4Z"/></svg>Palco</button>
      </div>

      <button id="createCategoryQuickBtn" class="navBtn createCategoryMainBtn" type="button">+ Criar categoria</button>

      <div id="channelTree"></div>
    </div>

    <button id="profileBtn" class="userbar" type="button" style="width:100%;border:0;color:inherit;text-align:left;cursor:pointer;">
      <div id="userAvatar" class="avatar">V</div>
      <div class="userMeta" style="flex:1;">
        <strong id="userName">Você</strong>
        <span id="userBioMini">● Online · Editar perfil</span>
      </div>
      <span style="color:var(--low);font-size:16px;"><svg class="uiIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm8.2 4.6v-2.2l-2-.7a7.3 7.3 0 0 0-.7-1.6l.9-1.9-1.6-1.6-1.9.9a7.3 7.3 0 0 0-1.6-.7l-.7-2h-2.2l-.7 2a7.3 7.3 0 0 0-1.6.7l-1.9-.9-1.6 1.6.9 1.9a7.3 7.3 0 0 0-.7 1.6l-2 .7v2.2l2 .7c.2.6.4 1.1.7 1.6l-.9 1.9 1.6 1.6 1.9-.9c.5.3 1 .5 1.6.7l.7 2h2.2l.7-2c.6-.2 1.1-.4 1.6-.7l1.9.9 1.6-1.6-.9-1.9c.3-.5.5-1 .7-1.6l2-.7Z"/></svg></span>
    </button>
  </aside>

  <main class="main">
    <header class="topbar">
      <div class="topLeft">
        <div id="topTitle" class="topTitle">Acord</div>
        <div id="topSub" class="topSub">servidores, chat, voz, câmera e tela</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <button id="notificationBtn" class="btn secondary small" type="button">Notificações <span id="notificationBadge" class="unreadBadge hidden">0</span></button>
        <button id="quickInviteBtn" class="btn secondary small">Copiar convite</button>
      </div>
    </header>

    <div class="content">
      <section id="homeView" class="view home">
        <div class="homeCard">
          <div class="homeMark">e</div>
          <h1 id="welcomeTitle">Bem-vindo ao Acord</h1>
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
            <strong style="margin-right:8px;">Acord</strong>
            <button id="hubFriendsBtn" class="friendTab active" type="button"><svg class="uiIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm6-1a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 20c0-4 3-7 7-7s7 3 7 7H2Zm13-7c4 0 7 2.6 7 6h-4.2c-.3-2.2-1.3-4.1-2.8-5.5V13Z"/></svg>Amigos</button>
            <button id="hubMessagesBtn" class="friendTab" type="button">✉ Mensagens privadas</button>
            <span style="width:1px;height:22px;background:var(--line);margin:0 3px;"></span>
            <button id="friendsOnlineTab" class="friendTab active" type="button">Disponível</button>
            <button id="friendsAllTab" class="friendTab" type="button">Todos</button>
            <button id="friendsPendingTab" class="friendTab" type="button">Pendentes</button>
            <button id="createPrivateGroupBtn" class="friendTab" type="button">Criar grupo</button>
            <button id="friendsProfileBtn" class="friendTab" type="button">Perfil</button>
            <button id="addFriendBtn" class="friendTab add" type="button">Adicionar amigo</button>
          </div>

          <div class="friendsSearchWrap">
            <input id="friendsSearch" placeholder="Buscar amigo">
          </div>

          <div class="friendsListArea">
            <div id="friendsCountTitle" class="friendsSectionTitle">Online</div>
            <div id="friendsList"></div>
          </div>

          <button id="friendsAccountBar" class="friendsAccountBar" type="button" title="Abrir meu perfil">
            <div id="friendsAccountAvatar" class="avatar">V</div>
            <div class="friendsAccountMeta">
              <strong id="friendsAccountName">Você</strong>
              <span id="friendsAccountStatus">● Online · Editar perfil</span>
            </div>
            <span class="friendsAccountGear"><svg class="uiIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm8.2 4.6v-2.2l-2-.7a7.3 7.3 0 0 0-.7-1.6l.9-1.9-1.6-1.6-1.9.9a7.3 7.3 0 0 0-1.6-.7l-.7-2h-2.2l-.7 2a7.3 7.3 0 0 0-1.6.7l-1.9-.9-1.6 1.6.9 1.9a7.3 7.3 0 0 0-.7 1.6l-2 .7v2.2l2 .7c.2.6.4 1.1.7 1.6l-.9 1.9 1.6 1.6 1.9-.9c.5.3 1 .5 1.6.7l.7 2h2.2l.7-2c.6-.2 1.1-.4 1.6-.7l1.9.9 1.6-1.6-.9-1.9c.3-.5.5-1 .7-1.6l2-.7Z"/></svg></span>
          </button>
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

            <button class="settingsNavBtn active" data-settings-page="profile"><svg class="uiIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm8.2 4.6v-2.2l-2-.7a7.3 7.3 0 0 0-.7-1.6l.9-1.9-1.6-1.6-1.9.9a7.3 7.3 0 0 0-1.6-.7l-.7-2h-2.2l-.7 2a7.3 7.3 0 0 0-1.6.7l-1.9-.9-1.6 1.6.9 1.9a7.3 7.3 0 0 0-.7 1.6l-2 .7v2.2l2 .7c.2.6.4 1.1.7 1.6l-.9 1.9 1.6 1.6 1.9-.9c.5.3 1 .5 1.6.7l.7 2h2.2l.7-2c.6-.2 1.1-.4 1.6-.7l1.9.9 1.6-1.6-.9-1.9c.3-.5.5-1 .7-1.6l2-.7Z"/></svg>Perfil do servidor</button>

            <div class="settingsGroup">Pessoas</div>
            <button class="settingsNavBtn" data-settings-page="members"><svg class="uiIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm6-1a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 20c0-4 3-7 7-7s7 3 7 7H2Zm13-7c4 0 7 2.6 7 6h-4.2c-.3-2.2-1.3-4.1-2.8-5.5V13Z"/></svg>Membros</button>
            <button class="settingsNavBtn" data-settings-page="roles">🛡 Cargos</button>
            <button class="settingsNavBtn" data-settings-page="invites">✉ Convites</button>

            <div class="settingsGroup">Moderação</div>
            <button class="settingsNavBtn" data-settings-page="security"><svg class="uiIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10V8a5 5 0 0 1 10 0v2h2v11H5V10h2Zm2 0h6V8a3 3 0 0 0-6 0v2Z"/></svg>Segurança</button>

            <div class="settingsGroup">Servidor</div>
            <button class="settingsNavBtn danger" data-settings-page="delete"><svg class="uiIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8h10l-.8 11H7.8L7 8Zm2-3h6l1 2H8l1-2Zm-3 2h12v2H6V7Z"/></svg>Excluir servidor</button>
          </aside>

          <div class="settingsBody">

            <div id="settingsProfilePage" class="settingsPanel">
              <h2>Perfil do servidor</h2>
              <p>Personalize a identidade do seu servidor no Acord.</p>

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
                      <div id="serverPreviewDescription" class="serverPreviewDescription">Seu servidor no Acord.</div>
                      <div id="serverPreviewTags" class="serverTags"></div>
                    </div>
                  </div>
                </div>

              </div>
            </div>

            <div id="settingsMembersPage" class="settingsPanel hidden">
              <h2>Membros</h2>
              <p>Veja membros online e offline. Clique em uma pessoa para abrir o perfil e gerenciar cargos.</p>
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
                <strong>Proteção do Acord</strong>
                <p style="color:var(--muted);font-size:13px;line-height:1.55;margin-bottom:0;">
                  Somente pessoas com o link do convite conseguem abrir este servidor.
                  Mais permissões por cargo poderão ser adicionadas depois.
                </p>
              </div>
            </div>

            <div id="settingsDeletePage" class="settingsPanel hidden">
              <h2>Excluir servidor</h2>
              <p>Essa ação remove o servidor e seus canais do Acord.</p>
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
              <strong>Cargos</strong>
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
        <div class="chatHead" style="display:flex;align-items:center;gap:10px;">
          <div style="min-width:0;flex:1;"># <span id="chatTitle">geral</span><span>chat de texto</span></div>
          <input id="chatSearchInput" class="chatSearchInput" type="search" placeholder="Pesquisar mensagens">
        </div>
        <div id="messages" class="messages"></div>
        <div id="typingIndicator" class="typingIndicator hidden"></div>
        <div id="replyBar" class="replyBar hidden">
          <span id="replyBarText">Respondendo...</span>
          <button id="replyCancelBtn" class="btn secondary small" type="button">×</button>
        </div>
        <input id="chatImageInput" class="hidden" type="file" accept="image/*">
        <div class="compose" style="grid-template-columns:auto 1fr auto;">
          <button id="chatImageBtn" class="btn secondary iconOnly" type="button" title="Anexar imagem"><svg class="uiIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="m8.5 12.5 6.7-6.7a4 4 0 1 1 5.6 5.6l-8.9 8.9a6 6 0 0 1-8.5-8.5l9.2-9.2 1.4 1.4-9.2 9.2a4 4 0 0 0 5.7 5.7l8.9-8.9A2 2 0 0 0 16.6 7l-6.7 6.7a1.5 1.5 0 1 0 2.1 2.1l5.3-5.3 1.4 1.4-5.3 5.3a3.5 3.5 0 0 1-5-5Z"/></svg></button>
          <input id="messageInput" maxlength="2000" placeholder="Escreva uma mensagem...">
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

        <div id="localMusicPanel" class="localMusicPanel hidden">
          <div class="localMusicShell">
            <div class="localMusicHead">
              <div class="localMusicTitle"><svg class="uiIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v11.2A3.5 3.5 0 1 0 11 18V8h7v7.2A3.5 3.5 0 1 0 20 18V4H9Z"/></svg> Minha música</div>
              <div class="localMusicOnly">SÓ VOCÊ OUVE</div>
            </div>

            <div class="localMusicBody">
              <input id="localMusicFiles" class="hidden" type="file" accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.oga,.opus,.flac,.webm" multiple>

              <div class="localMusicAdd">
                <button id="localMusicChooseBtn" class="localMusicChoose" type="button">+ Escolher música</button>
                <input id="localMusicUrl" type="url" placeholder="Ou cole um link direto de áudio...">
                <button id="localMusicAddUrlBtn" class="btn secondary small" type="button">Adicionar</button>
              </div>

              <div class="localMusicNow">
                <div class="localMusicNowLabel">Tocando agora</div>
                <div id="localMusicTrack" class="localMusicTrack">Nenhuma música selecionada</div>

                <div class="localMusicTimeline">
                  <span id="localMusicCurrent">0:00</span>
                  <input id="localMusicSeek" type="range" min="0" max="1000" value="0">
                  <span id="localMusicDuration">0:00</span>
                </div>

                <div class="localMusicControls">
                  <button id="localMusicPrevBtn" type="button">⏮</button>
                  <button id="localMusicPlayBtn" type="button">▶</button>
                  <button id="localMusicNextBtn" type="button">⏭</button>

                  <div class="localMusicVolume">
                    <span>🔊</span>
                    <input id="localMusicVolume" type="range" min="0" max="100" value="70">
                    <span id="localMusicVolumeValue">70%</span>
                  </div>
                </div>
              </div>

              <div class="musicExtraControls">
                <button id="musicShuffleBtn" type="button">🔀 Aleatório</button>
                <button id="musicRepeatBtn" type="button">🔁 Repetir</button>
                <button id="musicFavoriteBtn" type="button">☆ Favoritar</button>
              </div>
              <div id="localMusicList" class="localMusicList">
                <div class="localMusicEmpty">Sua fila está vazia.</div>
              </div>
            </div>
          </div>

          <audio id="localMusicAudio" preload="metadata"></audio>
        </div>

        <div id="videoGrid" class="videoGrid"></div>

        <div id="voiceControls" class="controls hidden">
          <button id="micBtn" class="control">Microfone</button>
          <button id="musicBtn" class="control">Música</button>
          <button id="deafenBtn" class="control">Áudio</button>
          <button id="audioGateBtn" class="control audioGate hidden"><svg class="uiIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4V9Zm12.2-.8a5 5 0 0 1 0 7.6l-1.3-1.5a3 3 0 0 0 0-4.6l1.3-1.5Zm2.8-2.5a8.5 8.5 0 0 1 0 12.6l-1.3-1.5a6.5 6.5 0 0 0 0-9.6L19 5.7Z"/></svg>Ativar áudio</button>
          <button id="cameraBtn" class="control off">Câmera</button>
          <button id="screenBtn" class="control">Compartilhar</button>
          <button id="stageHandBtn" class="control stageHandBtn hidden">Pedir para falar</button>
          <button id="callSettingsBtn" class="control">Dispositivos</button>
          <button id="leaveVoiceBtn" class="control danger">Sair</button>
        </div>
        <div id="callSettingsPanel" class="callSettingsPanel hidden">
          <div style="font-weight:900;margin-bottom:10px;">Áudio e vídeo</div>
          <div class="callSettingsGrid">
            <label>Microfone<select id="micDeviceSelect"></select></label>
            <label>Câmera<select id="cameraDeviceSelect"></select></label>
            <div class="callToggle"><span>Supressão de ruído</span><input id="noiseSuppressionToggle" type="checkbox" checked style="width:auto;"></div>
            <div class="callToggle"><span>Push-to-talk (segure Espaço)</span><input id="pushToTalkToggle" type="checkbox" style="width:auto;"></div>
          </div>
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
          <h2>Compartilhar no Acord</h2>
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

    <div class="sharePickerQuality">
      <div class="sharePickerQualityTitle">Qualidade da transmissão</div>
      <div class="shareQualityChoices">
        <button type="button" class="shareQualityBtn" data-share-quality="720p">
          <strong>HD 720p</strong>
          <span>Mais leve</span>
        </button>
        <button type="button" class="shareQualityBtn active" data-share-quality="1080p">
          <strong>Full HD 1080p</strong>
          <span>Recomendado</span>
        </button>
        <button type="button" class="shareQualityBtn" data-share-quality="1080p60">
          <strong>1080p 60 FPS</strong>
          <span>Mais fluido</span>
        </button>
      </div>
    </div>

    <div class="sharePickerFoot">
      A qualidade final também depende do navegador, da resolução da tela e da conexão dos participantes.
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
      <div id="profileBannerPreview" class="profileBannerPreview"></div>
      <label for="profileBannerInput" style="display:block;color:var(--low);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;margin-bottom:7px;">Banner</label>
      <input id="profileBannerInput" type="file" accept="image/*">

      <div style="display:flex;align-items:center;gap:14px;margin:16px 0;">
        <div id="profileAvatarPreview" class="avatar" style="width:74px;height:74px;border-radius:24px;font-size:24px;background-size:cover;background-position:center;">V</div>
        <div style="flex:1;">
          <label for="profilePhotoInput" style="display:block;color:var(--low);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;margin-bottom:7px;">Foto</label>
          <input id="profilePhotoInput" type="file" accept="image/*">
          <button id="removeProfilePhotoBtn" class="btn secondary small" type="button" style="margin-top:7px;">Remover foto</button>
        </div>
      </div>

      <label for="profileNameInput" style="display:block;color:var(--low);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;margin-bottom:7px;">@Nome único</label>
      <input id="profileNameInput" maxlength="30" placeholder="Seu nome único">

      <label for="profileDisplayNameInput" style="display:block;color:var(--low);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;margin:14px 0 7px;">Nome de exibição</label>
      <input id="profileDisplayNameInput" maxlength="40" placeholder="Como você quer aparecer">

      <label for="profileStatusSelect" style="display:block;color:var(--low);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;margin:14px 0 7px;">Status</label>
      <select id="profileStatusSelect" style="width:100%;border:1px solid var(--line);background:var(--bg2);color:var(--text);border-radius:10px;padding:12px;">
        <option value="online">Online</option><option value="away">Ausente</option><option value="busy">Ocupado</option><option value="invisible">Invisível</option>
      </select>

      <label for="profileBioInput" style="display:block;color:var(--low);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;margin:14px 0 7px;">Sobre mim</label>
      <textarea id="profileBioInput" maxlength="300" placeholder="Conte um pouco sobre você..." style="width:100%;min-height:88px;resize:vertical;border:1px solid var(--line);background:var(--bg2);color:var(--text);border-radius:10px;padding:12px;outline:none;"></textarea>
    </div>

    <div id="profileAppearanceTab" class="profileTabPanel">
      <div style="color:var(--text);font-size:14px;font-weight:900;margin-bottom:5px;">Cor do site</div>
      <div style="color:var(--muted);font-size:12px;line-height:1.5;margin-bottom:12px;">
        Essa opção é só para você. Escolha uma cor pronta ou use a cor personalizada logo abaixo.
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
        <button type="button" class="profileThemeBtn" data-profile-theme="custom">
          <span id="profileThemeDotCustom" class="profileThemeDot" style="background:linear-gradient(135deg,#0f1116,var(--coral));"></span>Personalizada
        </button>
      </div>

      <div class="customColorBox" id="siteColorCustomBox">
        <div style="color:var(--text);font-size:13px;font-weight:900;margin-bottom:8px;">Cor personalizada do site</div>
        <div style="color:var(--muted);font-size:11px;line-height:1.45;margin-bottom:10px;">
          A cor escolhida vira a cor principal do site.
        </div>

        <div class="customColorTop">
          <div id="customColorPreview" class="customColorPreview"></div>
          <input id="customColorPicker" type="color" value="#ff6b4a" aria-label="Escolher cor">
          <input id="customColorHex" maxlength="7" value="#ff6b4a" aria-label="Cor hexadecimal">
        </div>

        <div class="rgbFields">
          <div class="rgbField"><input id="customColorR" type="number" min="0" max="255" value="255"><label for="customColorR">R</label></div>
          <div class="rgbField"><input id="customColorG" type="number" min="0" max="255" value="107"><label for="customColorG">G</label></div>
          <div class="rgbField"><input id="customColorB" type="number" min="0" max="255" value="74"><label for="customColorB">B</label></div>
        </div>

        <div class="customColorActions">
          <button id="applyCustomColorBtn" type="button" class="btn primary small">Aplicar cor</button>
          <button id="resetCustomColorBtn" type="button" class="btn secondary small">Remover</button>
        </div>
      </div>

      <div style="margin-top:20px;color:var(--text);font-size:14px;font-weight:900;">Paleta de cores</div>
      <div style="color:var(--muted);font-size:12px;line-height:1.5;margin:5px 0 10px;">
        A paleta muda as cores de destaque dos botões, chamadas e elementos do site.
      </div>

      <div id="profilePaletteChoices" class="profilePaletteChoices">
        <button type="button" class="profilePaletteBtn" data-profile-palette="default">
          <span class="profilePaletteSwatch paletteDefault"><span></span><span></span><span></span></span>
          Padrão
        </button>
        <button type="button" class="profilePaletteBtn" data-profile-palette="ocean">
          <span class="profilePaletteSwatch paletteOcean"><span></span><span></span><span></span></span>
          Oceano
        </button>
        <button type="button" class="profilePaletteBtn" data-profile-palette="sunset">
          <span class="profilePaletteSwatch paletteSunset"><span></span><span></span><span></span></span>
          Pôr do sol
        </button>
        <button type="button" class="profilePaletteBtn" data-profile-palette="forest">
          <span class="profilePaletteSwatch paletteForest"><span></span><span></span><span></span></span>
          Floresta
        </button>
        <button type="button" class="profilePaletteBtn" data-profile-palette="candy">
          <span class="profilePaletteSwatch paletteCandy"><span></span><span></span><span></span></span>
          Candy
        </button>
      </div>


    </div>

    <div class="accountDangerZone">
      <button id="logoutAccountBtn" class="btn secondary" type="button">Sair da conta</button>
      <button id="deleteAccountBtn" class="btn danger" type="button">Excluir conta</button>
    </div>
    <div class="modalActions">
      <button id="profileCancelBtn" class="btn secondary">Cancelar</button>
      <button id="profileSaveBtn" class="btn primary">Salvar</button>
    </div>
  </div>
</div>

<div id="memberProfileModalWrap" class="modalWrap hidden">
  <div class="modal">
    <div class="memberProfileCardTop">
      <div id="memberProfileAvatar" class="avatar memberProfileAvatar">U</div>
      <div style="min-width:0;flex:1;">
        <h2 id="memberProfileName" style="margin:0;">Membro</h2>
        <div id="memberProfileStatus" class="memberProfileStatus">Offline</div>
      </div>
    </div>
    <div id="memberProfileBio" class="memberProfileBio">Sem bio.</div>
    <div class="memberProfileRoles">
      <div class="memberProfileRolesTitle">Cargos neste servidor</div>
      <div id="memberProfileRolesList"></div>
      <div id="memberProfileRolesHint" style="color:var(--low);font-size:10px;line-height:1.4;margin-top:8px;"></div>
    </div>
    <div class="modalActions">
      <button id="memberProfileCloseBtn" class="btn primary" type="button">Fechar</button>
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

<button id="installAppBtn" class="installAppBtn hidden" type="button">⬇ Instalar aplicativo</button>
<div id="notificationPanel" class="notificationPanel hidden">
  <div class="notificationPanelHead">
    <strong>Notificações</strong>
    <button id="clearNotificationsBtn" class="btn secondary small" type="button">Limpar</button>
  </div>
  <div id="notificationList" class="notificationList">
    <div class="notificationEmpty">Nenhuma notificação.</div>
  </div>
</div>

<div id="userContextMenu" class="messageContextMenu hidden">
  <button id="userContextProfileBtn" type="button">Ver perfil</button>
  <button id="userContextMessageBtn" type="button">Mensagem</button>
  <button id="userContextCallBtn" type="button">Ligar</button>
  <button id="userContextBlockBtn" type="button">Bloquear</button>
  <button id="userContextKickBtn" class="danger hidden" type="button">Expulsar do servidor</button>
</div>

<div id="messageContextMenu" class="messageContextMenu hidden">
  <button id="contextReplyBtn" type="button">Responder</button>
  <button id="contextEditBtn" type="button">Editar</button>
  <button id="contextDeleteBtn" class="danger" type="button">Excluir</button>
</div>

<div id="toast" class="toast hidden"></div>

<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io({
  reconnection:true,
  reconnectionAttempts:Infinity,
  reconnectionDelay:700,
  reconnectionDelayMax:4000,
  randomizationFactor:0.35,
  timeout:20000
});

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
  authToken:localStorage.getItem('acord-auth-token')||'',
  authMode:'login',
  legacyUserId:localStorage.getItem('ecord-user-id')||'',
  legacyUsername:localStorage.getItem('ecord-name')||'',
  legacyBio:localStorage.getItem('ecord-bio')||'',
  legacyAvatar:localStorage.getItem('ecord-avatar')||'',
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
  privateCallId: null,
  privatePeerName: null,
  incomingCall: null,
  pendingAvatar:null,
  pendingBanner:null,
  selectedServerMemberId:null,
  replyToMessageId:null,
  pendingChatAttachment:null,
  pushToTalk:localStorage.getItem('acord-ptt')==='1',
  noiseSuppression:localStorage.getItem('acord-noise-suppression')!=='0',
  preferredMicId:localStorage.getItem('acord-mic-device')||'',
  preferredCameraId:localStorage.getItem('acord-camera-device')||'',
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
  privateInviteHandled: false,
  currentView: PAGE_WAS_RELOADED
    ? (localStorage.getItem('ecord-last-view') || 'friends')
    : 'friends',
  appInitialized: false,
  restoringReload: PAGE_WAS_RELOADED,
  profileReady: false,
  voiceReconnectPending:false,
  voiceReconnectTimer:null,
  voiceReconnectAttempts:0,
  notifications:[],
  blockedUsers:new Set((()=>{
    try{
      const value=JSON.parse(localStorage.getItem('acord-blocked-users')||'[]');
      return Array.isArray(value)?value:[];
    }catch{return []}
  })()),
  userContextProfile:null,
  typingTimer:null,
  typingUsers:new Map(),
  chatSearch:'',
  speakingMonitors:new Map(),
  pendingChannelCategoryId:null,
  collapsedCategories:new Set((()=>{
    try{
      const value=JSON.parse(localStorage.getItem('acord-collapsed-categories')||'[]');
      return Array.isArray(value)?value:[];
    }catch{return []}
  })())
};

const rtcConfig = {
  iceServers: [
    {urls:'stun:stun.l.google.com:19302'},
    {urls:'stun:stun1.l.google.com:19302'},
    {urls:'stun:stun.cloudflare.com:3478'}
  ],
  iceCandidatePoolSize: 10
};


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

  $('#localMusicTrack').textContent = track.name || 'Música';
  $('#localMusicCurrent').textContent = '0:00';
  $('#localMusicDuration').textContent = 'Carregando...';
  $('#localMusicSeek').value = 0;

  renderLocalMusicQueue();

  try{
    if(audio.src !== track.url){
      audio.pause();
      audio.removeAttribute('src');
      audio.load();

      audio.src = track.url;
      audio.preload = 'auto';
      audio.load();
    }

    if(audio.readyState < 2){
      await new Promise((resolve,reject)=>{
        let finished=false;

        const cleanup=()=>{
          audio.removeEventListener('canplay',onReady);
          audio.removeEventListener('loadeddata',onReady);
          audio.removeEventListener('error',onError);
        };

        const onReady=()=>{
          if(finished) return;
          finished=true;
          cleanup();
          resolve();
        };

        const onError=()=>{
          if(finished) return;
          finished=true;
          cleanup();
          reject(audio.error || new Error('Formato de áudio não suportado'));
        };

        audio.addEventListener('canplay',onReady,{once:true});
        audio.addEventListener('loadeddata',onReady,{once:true});
        audio.addEventListener('error',onError,{once:true});

        setTimeout(()=>{
          if(finished) return;

          // Alguns navegadores já estão prontos mas não dispararam
          // o evento após uma troca muito rápida de src.
          if(audio.readyState >= 2){
            onReady();
          }
        },1200);
      });
    }

    if(autoplay){
      await audio.play();
    }

    $('#localMusicDuration').textContent = formatMusicTime(audio.duration);
  }catch(error){
    console.warn('Não foi possível reproduzir a música:',error);

    const code = audio.error?.code || 0;

    if(code === 4){
      toast('Esse formato de áudio não é suportado. Tente MP3, WAV ou OGG.');
    }else if(track.local){
      toast('Não consegui abrir esse arquivo. Tente outro MP3.');
    }else{
      toast('Esse link não fornece um áudio reproduzível diretamente.');
    }
  }

  updateLocalMusicPlayButton();
}

function addLocalMusicFiles(files){
  const supportedExtensions = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm)$/i;

  const list = Array.from(files || []).filter(file=>
    String(file.type || '').startsWith('audio/') ||
    supportedExtensions.test(String(file.name || ''))
  );

  if(!list.length){
    toast('Escolha um arquivo de áudio compatível');
    return;
  }

  const firstNewIndex = state.localMusicQueue.length;

  list.forEach(file=>{
    const url = URL.createObjectURL(file);
    state.localMusicObjectUrls.add(url);

    state.localMusicQueue.push({
      name:String(file.name || 'Música').replace(/\.[^.]+$/,''),
      url,
      local:true,
      type:String(file.type || ''),
      size:Number(file.size || 0)
    });
  });

  renderLocalMusicQueue();

  // A escolha do arquivo já é um gesto do usuário:
  // podemos iniciar a reprodução imediatamente.
  playLocalMusicTrack(firstNewIndex,true);

  toast(list.length === 1 ? 'Música adicionada e reproduzindo' : 'Músicas adicionadas');
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
      if(audio.readyState < 2){
        await playLocalMusicTrack(state.localMusicIndex,true);
        return;
      }

      await audio.play();
    }catch(error){
      console.warn('Falha ao tocar:',error);
      toast('Não foi possível tocar. Tente um arquivo MP3.');
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
function submitAuthentication(){
  const username=$('#authUsername').value.trim().slice(0,30);
  const password=$('#authPassword').value;
  const confirmation=$('#authPasswordConfirm').value;
  $('#authError').textContent='';

  const button=$('#loginBtn');

  if(!socket.connected){
    $('#authError').textContent='Conectando ao servidor... tente novamente em alguns segundos.';
    return;
  }
  button.disabled=true;
  button.textContent=state.authMode==='register'?'Criando...':'Entrando...';

  const restoreButton=()=>{
    button.disabled=false;
    button.textContent=state.authMode==='register'?'Criar conta':'Entrar';
  };
  if(username.length<3){$('#authError').textContent='O nome precisa ter pelo menos 3 caracteres.';restoreButton();return}
  if(password.length<6){$('#authError').textContent='A senha precisa ter pelo menos 6 caracteres.';restoreButton();return}
  if(state.authMode==='register'){
    if(password!==confirmation){$('#authError').textContent='As senhas não são iguais.';restoreButton();return}
    socket.emit('auth-register',{username,password});return;
  }
  socket.emit('auth-login',{
    username,
    password,
    legacyUserId:state.legacyUserId,
    legacyProfile:{
      displayName:state.legacyUsername||username,
      bio:state.legacyBio||'',
      avatar:state.legacyAvatar||'',
      banner:'',
      status:'online'
    }
  });

  setTimeout(()=>{
    if(button.disabled){
      button.disabled=false;
      button.textContent='Entrar';
      $('#authError').textContent='O servidor demorou para responder. Tente novamente.';
    }
  },8000);
}
function clearAccountState(){
  state.authToken='';state.userId='';state.username='';state.displayName='';
  state.bio='';state.avatar='';state.banner='';state.profileReady=false;state.appInitialized=false;
  localStorage.removeItem('acord-auth-token');
  localStorage.removeItem('ecord-user-id');localStorage.removeItem('ecord-name');
  localStorage.removeItem('ecord-bio');localStorage.removeItem('ecord-avatar');
  try{leaveVoice()}catch{}
  $('#login').classList.remove('hidden');$('#appShell').classList.add('hidden');
  $('#profileModalWrap').classList.add('hidden');
  $('#authPassword').value='';$('#authPasswordConfirm').value='';
}
function applyAuthProfile(profile,token){
  if(!profile?.id || !token) return;
  state.authToken=token;state.userId=profile.id;state.username=profile.username||'';
  state.displayName=profile.displayName||profile.username||'';state.bio=profile.bio||'';
  state.avatar=profile.avatar||'';state.banner=profile.banner||'';state.status=profile.status||'online';
  state.legacyUserId=state.userId;
  state.legacyUsername=state.username;
  state.legacyBio=state.bio;
  state.legacyAvatar=state.avatar;
  state.profileReady=true;
  localStorage.setItem('acord-auth-token',token);
  localStorage.setItem('ecord-user-id',state.userId);localStorage.setItem('ecord-name',state.username);
  localStorage.setItem('ecord-bio',state.bio);try{localStorage.setItem('ecord-avatar',state.avatar)}catch{}
  $('#login').classList.add('hidden');$('#appShell').classList.remove('hidden');
  refreshOwnProfileUI();
  if(!state.appInitialized){setAppMode('hub');setView('friends')}else{restoreCurrentView()}
  socket.emit('get-servers');socket.emit('get-friend-state');socket.emit('get-group-state');
}
function logoutAccount(){socket.emit('auth-logout',{token:state.authToken})}
function deleteAccount(){
  if(!confirm('Excluir sua conta permanentemente?')) return;
  if(!confirm('Essa ação não pode ser desfeita. Continuar?')) return;
  socket.emit('delete-account',{token:state.authToken});
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
function toggleCallSettings(){ $('#callSettingsPanel').classList.toggle('hidden'); refreshMediaDevices(); }
function syncStageHandButton(){const c=currentVoice();$('#stageHandBtn').classList.toggle('hidden',c?.mode!=='stage')}

function togglePasswordVisibility(inputSelector,buttonSelector){
  const input=$(inputSelector);
  const button=$(buttonSelector);
  if(!input || !button) return;

  const showing=input.type==='text';
  input.type=showing?'password':'text';
  button.title=showing?'Mostrar senha':'Ocultar senha';
  button.setAttribute('aria-label',button.title);
  button.classList.toggle('showing',!showing);
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


function persistBlockedUsers(){
  localStorage.setItem('acord-blocked-users',JSON.stringify([...state.blockedUsers]));
}

function addNotification(title,body=''){
  state.notifications.unshift({
    id:'n-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),
    title:String(title||'Acord').slice(0,80),
    body:String(body||'').slice(0,180),
    at:Date.now()
  });
  state.notifications=state.notifications.slice(0,50);
  renderNotifications();
  if(document.visibilityState!=='visible') maybeNotify(title,body);
}

function renderNotifications(){
  const list=$('#notificationList');
  const badge=$('#notificationBadge');
  if(!list||!badge) return;

  badge.textContent=String(state.notifications.length);
  badge.classList.toggle('hidden',!state.notifications.length);
  list.innerHTML='';

  if(!state.notifications.length){
    const empty=document.createElement('div');
    empty.className='notificationEmpty';
    empty.textContent='Nenhuma notificação.';
    list.appendChild(empty);
    return;
  }

  state.notifications.forEach(item=>{
    const row=document.createElement('div');
    row.className='notificationItem';
    const title=document.createElement('strong');
    title.textContent=item.title;
    const body=document.createElement('div');
    body.textContent=item.body;
    row.append(title,body);
    list.appendChild(row);
  });
}

function closeUserContextMenu(){
  state.userContextProfile=null;
  $('#userContextMenu')?.classList.add('hidden');
}

function openUserContextMenu(event,profile,serverMode=false){
  event.preventDefault();
  if(!profile?.id || profile.id===state.userId) return;

  state.userContextProfile=profile;
  const menu=$('#userContextMenu');

  $('#userContextBlockBtn').textContent=
    state.blockedUsers.has(profile.id)?'Desbloquear':'Bloquear';

  const canKick=
    serverMode &&
    currentServer() &&
    currentServer().ownerId===state.userId &&
    profile.id!==currentServer().ownerId;

  $('#userContextKickBtn').classList.toggle('hidden',!canKick);

  menu.classList.remove('hidden');
  const rect=menu.getBoundingClientRect();
  menu.style.left=Math.max(8,Math.min(event.clientX,window.innerWidth-rect.width-8))+'px';
  menu.style.top=Math.max(8,Math.min(event.clientY,window.innerHeight-rect.height-8))+'px';
}

function filterVisibleMessages(){
  const search=String(state.chatSearch||'').trim().toLowerCase();
  document.querySelectorAll('#messages .message').forEach(row=>{
    row.classList.toggle('hidden',!!search && !String(row.textContent||'').toLowerCase().includes(search));
  });
}

function updateTypingIndicator(){
  const indicator=$('#typingIndicator');
  if(!indicator) return;

  const now=Date.now();
  for(const [id,value] of state.typingUsers){
    if(now-value.at>2600) state.typingUsers.delete(id);
  }

  const names=[...state.typingUsers.values()].map(v=>v.username).filter(Boolean);

  if(!names.length){
    indicator.classList.add('hidden');
    indicator.textContent='';
    return;
  }

  indicator.textContent=names.length===1
    ? names[0]+' está digitando...'
    : names.slice(0,2).join(' e ')+' estão digitando...';

  indicator.classList.remove('hidden');
}

function startSpeakingMonitor(peerId,stream){
  if(!stream?.getAudioTracks?.().length) return;

  try{
    const context=getSharedAudioContext();
    if(!context) return;

    const source=context.createMediaStreamSource(stream);
    const analyser=context.createAnalyser();
    analyser.fftSize=256;
    analyser.smoothingTimeConstant=.65;
    source.connect(analyser);

    const data=new Uint8Array(analyser.frequencyBinCount);
    const monitor={source,analyser,frame:null};

    const tick=()=>{
      analyser.getByteFrequencyData(data);
      let total=0;
      for(const value of data) total+=value;
      const average=total/data.length;
      document.getElementById('v-'+peerId)?.classList.toggle('speaking',average>18);
      monitor.frame=requestAnimationFrame(tick);
    };

    monitor.frame=requestAnimationFrame(tick);
    state.speakingMonitors.set(peerId,monitor);
  }catch{}
}

function stopSpeakingMonitor(peerId){
  const monitor=state.speakingMonitors.get(peerId);
  if(!monitor) return;

  try{cancelAnimationFrame(monitor.frame)}catch{}
  try{monitor.source?.disconnect()}catch{}
  try{monitor.analyser?.disconnect()}catch{}
  state.speakingMonitors.delete(peerId);
  document.getElementById('v-'+peerId)?.classList.remove('speaking');
}

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
function applyCustomColor(hex){
  const rgb=hexToRgb(hex);

  if(!rgb){
    document.documentElement.style.removeProperty('--coral');
    document.documentElement.style.removeProperty('--coral2');
    document.documentElement.style.removeProperty('--accent-contrast');
    return;
  }

  const safe=rgbToHex(rgb.r,rgb.g,rgb.b);
  const lighter=rgbToHex(
    Math.min(255,rgb.r+24),
    Math.min(255,rgb.g+24),
    Math.min(255,rgb.b+24)
  );

  const luminance=(0.299*rgb.r + 0.587*rgb.g + 0.114*rgb.b)/255;
  const contrast=luminance>0.62 ? '#07110e' : '#ffffff';

  document.documentElement.style.setProperty('--coral',safe);
  document.documentElement.style.setProperty('--coral2',lighter);
  document.documentElement.style.setProperty('--accent-contrast',contrast);
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

applyCustomColor(state.customColor);

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
  const appearance = tab === 'appearance';

  $('#profileInfoTabBtn').classList.toggle('active',!appearance);
  $('#profileAppearanceTabBtn').classList.toggle('active',appearance);

  $('#profileInfoTab').classList.toggle('active',!appearance);
  $('#profileAppearanceTab').classList.toggle('active',appearance);
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
  setProfileTab('profile');
  $('#profileModalWrap').classList.remove('hidden');
}

function closeProfileModal(){
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


function currentServerWritePayload(){
  const server=currentServer();

  return {
    serverId:server?.id || state.serverId || '',
    serverSnapshot:server ? safeServerSnapshot(server) : null,
    legacyUserId:state.legacyUserId || ''
  };
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
    $('#voiceTitle').textContent = 'Chamada com ' + (state.privatePeerName || 'Amigo');
    $('#topTitle').textContent = 'Chamada privada';
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

  $('#voiceStatus').textContent = state.privateCallId ? 'Call privada · Somente convidados' : 'Conectado';
  syncVoiceControlsUI();
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
    $('#topTitle').textContent = currentServer()?.name || 'Acord';
    $('#topSub').textContent = 'servidor';
  }

  if(name==='friends'){
    $('#topTitle').textContent = 'Amigos';
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
    const c = currentVoice();
    const isStage = c?.mode === 'stage';

    $('#topTitle').textContent = c
      ? (isStage ? '◉ ' : ')) ') + c.name
      : ')) voz';

    $('#topSub').textContent = isStage
      ? 'Palco · ' + (currentServer()?.name || '')
      : (currentServer()?.name || '');
  }else if(isServerView(name)){
    renderServerPresence();
  }

  syncVoiceControlsUI();

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
    const hubVisible = state.currentView==='friends' || state.currentView==='dm';
    b.className = 'serverIcon' + (s.id===state.serverId && !hubVisible ? ' active' : '');
    b.title = s.name;

    if(s.icon){
      b.textContent = '';
      b.style.backgroundImage = '';

      const image = document.createElement('img');
      image.className = 'serverIconImage';
      image.src = String(s.icon);
      image.alt = '';
      image.draggable = false;

      image.addEventListener('error',()=>{
        image.remove();
        b.textContent = initials(s.name);
        if(s.accent) b.style.backgroundColor = s.accent;
      });

      b.appendChild(image);
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
  const s=currentServer();

  if(!s){
    $('#serverTitle').textContent='Nenhum servidor';
    $('#channelTree').innerHTML='';
    $('#inviteBtn').disabled=true;
    $('#serverSettingsBtn').disabled=true;
    $('#deleteServerBtn').disabled=true;
    return;
  }

  $('#inviteBtn').disabled=false;
  $('#serverSettingsBtn').disabled=false;
  $('#deleteServerBtn').disabled=false;
  $('#serverTitle').textContent=s.name;

  const tree=$('#channelTree');
  tree.innerHTML='';

  const categories=Array.isArray(s.categories)
    ? [...s.categories].sort((a,b)=>(a.order||0)-(b.order||0))
    : [];

  const textChannels=Array.isArray(s.textChannels)
    ? [...s.textChannels].sort((a,b)=>(a.order||0)-(b.order||0))
    : [];

  const voiceChannels=Array.isArray(s.voiceChannels)
    ? [...s.voiceChannels].sort((a,b)=>(a.order||0)-(b.order||0))
    : [];

  const canManageChannels=()=>{
    if(s.ownerId===state.userId) return true;

    const username=String(state.username||'').toLowerCase();

    return (s.roles||[]).some(role=>{
      const member=(role.members||[]).some(
        name=>String(name||'').toLowerCase()===username
      );

      return member && (
        role.permissions?.administrator ||
        role.permissions?.manageChannels
      );
    });
  };

  function persistCollapsedCategories(){
    localStorage.setItem(
      'acord-collapsed-categories',
      JSON.stringify([...state.collapsedCategories])
    );
  }

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
    const raw=JSON.stringify(data);
    event.dataTransfer.effectAllowed='move';
    event.dataTransfer.setData('application/x-ecord',raw);
    event.dataTransfer.setData('text/plain',raw);
  }

  function sendMoveChannel(data,targetCategoryId,beforeChannelId=null){
    if(!data || data.kind!=='channel') return;

    socket.emit('move-channel',{
      serverId:state.serverId,
      type:data.type,
      channelId:data.channelId,
      targetCategoryId:targetCategoryId||null,
      beforeChannelId:beforeChannelId||null
    });
  }

  function openCreateChannel(type,categoryId=null){
    state.pendingChannelCategoryId=categoryId||null;
    openModal(type);
  }

  function createAddMenu(categoryId,anchor){
    document.querySelectorAll('.categoryAddMenu').forEach(menu=>menu.remove());

    const menu=document.createElement('div');
    menu.className='categoryAddMenu';

    const options=[
      ['text','#','Canal de texto'],
      ['voice','◖','Canal de voz'],
      ['stage','◉','Palco']
    ];

    options.forEach(([type,icon,label])=>{
      const button=document.createElement('button');
      button.type='button';

      const symbol=document.createElement('span');
      symbol.className='categoryAddMenuIcon';
      symbol.textContent=icon;

      const text=document.createElement('span');
      text.textContent=label;

      button.append(symbol,text);
      button.addEventListener('click',event=>{
        event.stopPropagation();
        menu.remove();
        openCreateChannel(type,categoryId);
      });

      menu.appendChild(button);
    });

    document.body.appendChild(menu);

    const rect=anchor.getBoundingClientRect();
    const menuRect=menu.getBoundingClientRect();

    menu.style.left=Math.min(
      rect.right-menuRect.width,
      window.innerWidth-menuRect.width-8
    )+'px';

    menu.style.top=Math.min(
      rect.bottom+4,
      window.innerHeight-menuRect.height-8
    )+'px';

    setTimeout(()=>{
      const close=event=>{
        if(!menu.contains(event.target)){
          menu.remove();
          document.removeEventListener('pointerdown',close,true);
        }
      };

      document.addEventListener('pointerdown',close,true);
    },0);
  }

  function makeChannelButton(channel,type){
    const isStage=type==='voice' && channel.mode==='stage';

    const button=document.createElement('button');
    button.type='button';
    button.className='discordChannel' + (
      (type==='text' && channel.id===state.textChannelId) ||
      (type==='voice' && channel.id===state.voiceChannelId)
        ? ' active'
        : ''
    );

    button.draggable=true;
    button.dataset.channelId=channel.id;
    button.dataset.channelType=type;

    const icon=document.createElement('span');
    icon.className='discordChannelIcon';
    icon.textContent=isStage ? '◉' : (type==='text' ? '#' : '◖');

    const body=document.createElement('span');
    body.className='discordChannelBody';

    const title=document.createElement('span');
    title.className='discordChannelName';
    title.textContent=channel.name;

    body.appendChild(title);

    if(isStage){
      const subtitle=document.createElement('span');
      subtitle.className='discordChannelSub';
      subtitle.textContent='Palco';
      body.appendChild(subtitle);
    }

    button.append(icon,body);

    if(type==='voice'){
      const users=[...state.voiceUsers.values()]
        .filter(user=>
          user.serverId===state.serverId &&
          user.channelId===channel.id
        );

      if(users.length){
        const count=document.createElement('span');
        count.className='discordChannelCount';
        count.textContent=String(users.length);
        button.appendChild(count);
      }
    }

    button.addEventListener('click',()=>{
      if(type==='text') selectText(channel.id);
      else selectVoice(channel.id);
    });

    button.addEventListener('dragstart',event=>{
      button.classList.add('dragging');
      setDragData(event,{
        kind:'channel',
        type,
        channelId:channel.id
      });
    });

    button.addEventListener('dragend',()=>{
      button.classList.remove('dragging');
      document.querySelectorAll('.dragOver').forEach(el=>el.classList.remove('dragOver'));
    });

    button.addEventListener('dragover',event=>{
      const data=dragData(event);
      if(!data || data.kind!=='channel') return;

      event.preventDefault();
      button.classList.add('dragOver');
    });

    button.addEventListener('dragleave',()=>{
      button.classList.remove('dragOver');
    });

    button.addEventListener('drop',event=>{
      event.preventDefault();
      button.classList.remove('dragOver');

      const data=dragData(event);
      if(!data || data.kind!=='channel') return;

      sendMoveChannel(
        data,
        channel.categoryId||null,
        data.type===type ? channel.id : null
      );
    });

    return button;
  }

  function appendUncategorized(){
    const uncatText=textChannels.filter(channel=>!channel.categoryId);
    const uncatVoice=voiceChannels.filter(channel=>!channel.categoryId);

    if(!uncatText.length && !uncatVoice.length) return;

    const box=document.createElement('div');
    box.className='discordUncategorized';

    [...uncatText.map(channel=>[channel,'text']),
     ...uncatVoice.map(channel=>[channel,'voice'])]
      .forEach(([channel,type])=>{
        box.appendChild(makeChannelButton(channel,type));
      });

    box.addEventListener('dragover',event=>{
      const data=dragData(event);
      if(data?.kind==='channel'){
        event.preventDefault();
        box.classList.add('dragOver');
      }
    });

    box.addEventListener('dragleave',()=>box.classList.remove('dragOver'));

    box.addEventListener('drop',event=>{
      event.preventDefault();
      box.classList.remove('dragOver');
      sendMoveChannel(dragData(event),null,null);
    });

    tree.appendChild(box);
  }

  function makeCategory(category){
    const block=document.createElement('section');
    block.className='discordCategory';
    block.dataset.categoryId=category.id;

    const header=document.createElement('div');
    header.className='discordCategoryHeader';
    header.draggable=canManageChannels();

    const left=document.createElement('button');
    left.type='button';
    left.className='discordCategoryToggle';

    const arrow=document.createElement('span');
    arrow.className='discordCategoryArrow';

    const collapsed=state.collapsedCategories.has(category.id);
    arrow.textContent=collapsed ? '›' : '⌄';

    const name=document.createElement('span');
    name.className='discordCategoryName';
    name.textContent=String(category.name||'Categoria').toUpperCase();

    left.append(arrow,name);

    const actions=document.createElement('div');
    actions.className='discordCategoryActions';

    if(canManageChannels()){
      const add=document.createElement('button');
      add.type='button';
      add.className='discordCategoryAction';
      add.title='Criar canal nesta categoria';
      add.textContent='+';

      add.addEventListener('click',event=>{
        event.stopPropagation();
        createAddMenu(category.id,add);
      });

      const more=document.createElement('button');
      more.type='button';
      more.className='discordCategoryAction';
      more.title='Excluir categoria';
      more.textContent='⋯';

      more.addEventListener('click',event=>{
        event.stopPropagation();

        if(confirm(
          'Excluir a categoria "'+category.name+'"? Os canais irão para fora da categoria.'
        )){
          socket.emit('delete-category',{
            serverId:state.serverId,
            categoryId:category.id
          });
        }
      });

      actions.append(add,more);
    }

    header.append(left,actions);

    const channels=document.createElement('div');
    channels.className='discordCategoryChannels';
    channels.classList.toggle('hidden',collapsed);

    const items=[
      ...textChannels
        .filter(channel=>(channel.categoryId||null)===category.id)
        .map(channel=>[channel,'text']),
      ...voiceChannels
        .filter(channel=>(channel.categoryId||null)===category.id)
        .map(channel=>[channel,'voice'])
    ];

    items.forEach(([channel,type])=>{
      channels.appendChild(makeChannelButton(channel,type));
    });

    if(!items.length){
      const empty=document.createElement('button');
      empty.type='button';
      empty.className='discordEmptyCategory';
      empty.textContent=canManageChannels()
        ? '+ Criar primeiro canal'
        : 'Categoria vazia';

      if(canManageChannels()){
        empty.addEventListener('click',()=>{
          state.pendingChannelCategoryId=category.id;
          openModal('text');
        });
      }else{
        empty.disabled=true;
      }

      channels.appendChild(empty);
    }

    left.addEventListener('click',()=>{
      const willCollapse=!state.collapsedCategories.has(category.id);

      if(willCollapse) state.collapsedCategories.add(category.id);
      else state.collapsedCategories.delete(category.id);

      persistCollapsedCategories();
      arrow.textContent=willCollapse ? '›' : '⌄';
      channels.classList.toggle('hidden',willCollapse);
    });

    header.addEventListener('dragstart',event=>{
      if(!canManageChannels()){
        event.preventDefault();
        return;
      }

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

    header.addEventListener('dragover',event=>{
      const data=dragData(event);
      if(!data) return;

      if(data.kind==='channel' || data.kind==='category'){
        event.preventDefault();
        header.classList.add('dragOver');
      }
    });

    header.addEventListener('dragleave',()=>{
      header.classList.remove('dragOver');
    });

    header.addEventListener('drop',event=>{
      event.preventDefault();
      header.classList.remove('dragOver');

      const data=dragData(event);
      if(!data) return;

      if(data.kind==='channel'){
        sendMoveChannel(data,category.id,null);
        return;
      }

      if(data.kind==='category' && data.categoryId!==category.id){
        socket.emit('move-category',{
          serverId:state.serverId,
          categoryId:data.categoryId,
          beforeCategoryId:category.id
        });
      }
    });

    channels.addEventListener('dragover',event=>{
      const data=dragData(event);
      if(data?.kind==='channel'){
        event.preventDefault();
        channels.classList.add('dragOver');
      }
    });

    channels.addEventListener('dragleave',()=>{
      channels.classList.remove('dragOver');
    });

    channels.addEventListener('drop',event=>{
      event.preventDefault();
      channels.classList.remove('dragOver');
      sendMoveChannel(dragData(event),category.id,null);
    });

    block.append(header,channels);
    return block;
  }

  appendUncategorized();

  categories.forEach(category=>{
    tree.appendChild(makeCategory(category));
  });

  if(!categories.length && canManageChannels()){
    const starter=document.createElement('button');
    starter.type='button';
    starter.className='discordCreateCategory';
    starter.textContent='+ Criar categoria';
    starter.addEventListener('click',()=>openModal('category'));
    tree.appendChild(starter);
  }
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
      row.classList.toggle('blockedUser',state.blockedUsers.has(profile.id));
      row.addEventListener('contextmenu',event=>openUserContextMenu(event,profile,true));
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
  const box = $('#messages');
  box.innerHTML = '';
  history.forEach(m=>appendMessage(m));
  box.scrollTop = box.scrollHeight;
}

function appendMessage(m){
  const row=document.createElement('div');
  row.className='message'+(m.userId===state.userId || m.senderId===socket.id?' mine':'');
  row.dataset.messageId=m.id||'';

  if(m.replyTo){
    const reply=document.createElement('div');reply.className='messageReply';
    reply.textContent='↪ Resposta a uma mensagem anterior';row.appendChild(reply);
  }

  const strong=document.createElement('strong');
  const role=primaryRoleForUser(m.username);
  strong.textContent=role?'['+role.name+'] '+(m.username||'Usuário'):(m.username||'Usuário');
  if(role) strong.style.color=role.color;

  const span=document.createElement('span');
  span.textContent=(m.text||'')+(m.edited?'  (editado)':'');
  row.append(strong,span);

  if(m.attachment?.data){
    const image=document.createElement('img');image.className='messageAttachment';
    image.src=m.attachment.data;image.alt=m.attachment.name||'Imagem';row.appendChild(image);
  }

  const reactions=document.createElement('div');reactions.className='messageReactions';
  Object.entries(m.reactions||{}).forEach(([emoji,users])=>{
    if(!Array.isArray(users)||!users.length) return;
    const chip=document.createElement('button');chip.className='reactionChip';chip.textContent=emoji+' '+users.length;
    chip.addEventListener('click',()=>socket.emit('chat-react',{serverId:state.serverId,channelId:state.textChannelId,messageId:m.id,emoji}));
    reactions.appendChild(chip);
  });
  if(reactions.childElementCount) row.appendChild(reactions);

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
    edit.addEventListener('click',()=>{
      const value=prompt('Editar mensagem:',m.text||'');if(value===null)return;
      socket.emit('chat-edit',{serverId:state.serverId,channelId:state.textChannelId,messageId:m.id,text:value});
    });
    const remove=document.createElement('button');remove.textContent='🗑';remove.title='Excluir';
    remove.addEventListener('click',()=>socket.emit('chat-delete',{serverId:state.serverId,channelId:state.textChannelId,messageId:m.id}));
    actions.append(edit,remove);
  }

  row.appendChild(actions);

  row.addEventListener('contextmenu',event=>{
    openMessageContextMenu(event,m);
  });

  $('#messages').appendChild(row);
  filterVisibleMessages();
  $('#messages').scrollTop=$('#messages').scrollHeight;
}

function sendMessage(){
  const input=$('#messageInput');
  const messageText=input.value.trim().slice(0,2000);
  if((!messageText&&!state.pendingChatAttachment)||!state.serverId||!state.textChannelId)return;
  socket.emit('chat-message',{
    serverId:state.serverId,channelId:state.textChannelId,text:messageText,
    replyTo:state.replyToMessageId,attachment:state.pendingChatAttachment
  });
  input.value='';state.replyToMessageId=null;state.pendingChatAttachment=null;
  $('#replyBar').classList.add('hidden');input.focus();
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
    call.textContent = 'Ligar';
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
      row.classList.toggle('blockedUser',state.blockedUsers.has(profile.id));
      row.addEventListener('contextmenu',event=>openUserContextMenu(event,profile,false));
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
    call.textContent = 'Ligar';
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
      icon.textContent='';

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
    stage:['Criar Palco','Crie uma chamada de Palco para eventos, painéis e apresentações.','Ex.: Palco principal'],
    category:['Criar categoria','Digite o nome da nova categoria.','Ex.: Jogos'],
    friend:['Adicionar amigo','Digite exatamente o nome do seu amigo no Acord.','Ex.: Davi'],
    role:['Criar cargo','Escolha nome, cor e permissões do cargo.','Ex.: Moderador'],
    editRole:['Editar cargo','Altere nome, cor e permissões do cargo.','Ex.: Administrador'],
    assignRole:['Atribuir cargo','Digite exatamente o nome da pessoa que receberá o cargo.','Ex.: Davi']
  }[type];

  const targetCategory = state.pendingChannelCategoryId
    ? currentServer()?.categories?.find(category=>category.id===state.pendingChannelCategoryId)
    : null;

  $('#modalTitle').textContent = cfg[0];
  $('#modalText').textContent = targetCategory && ['text','voice','stage'].includes(type)
    ? cfg[1] + ' Categoria: ' + targetCategory.name + '.'
    : cfg[1];
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
    const target=currentServerWritePayload();

    socket.emit('create-channel',{
      ...target,
      type:'text',
      name:value,
      categoryId:state.pendingChannelCategoryId
    });
  } else if(state.modalAction==='voice'){
    const target=currentServerWritePayload();

    socket.emit('create-channel',{
      ...target,
      type:'voice',
      name:value,
      categoryId:state.pendingChannelCategoryId
    });
  } else if(state.modalAction==='stage'){
    const target=currentServerWritePayload();

    socket.emit('create-channel',{
      ...target,
      type:'stage',
      name:value,
      categoryId:state.pendingChannelCategoryId
    });
  } else if(state.modalAction==='category'){
    const target=currentServerWritePayload();

    socket.emit('create-category',{
      ...target,
      name:value
    });
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

  state.pendingChannelCategoryId=null;
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
      params.encodings[0].maxBitrate = 5000000;
      params.encodings[0].maxFramerate = 30;
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
      ensureRemoteAudio(peerId,event.track,event.streams?.[0]||null);

      const visualStream=getRemoteStream(peerId);
      ensureCard(peerId,name,visualStream,false);

      startSpeakingMonitor(peerId,event.streams?.[0] || new MediaStream([event.track]));
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

  let disconnectRepairTimer=null;

  const updateConnectionStatus=()=>{
    const connection=pc.connectionState;
    const ice=pc.iceConnectionState;

    if(connection==='connected'){
      if(disconnectRepairTimer){
        clearTimeout(disconnectRepairTimer);
        disconnectRepairTimer=null;
      }

      state.voiceReconnectAttempts=0;
      state.voiceReconnectPending=false;

      if(!state.screenTrack){
        $('#voiceStatus').textContent=state.privateCallId
          ? 'Call privada · Somente convidados'
          : 'Conectado';
      }

      unlockAllRemoteAudio();
      return;
    }

    if(connection==='connecting' || ice==='checking'){
      $('#voiceStatus').textContent='Conectando mídia...';
      return;
    }

    if(connection==='disconnected'){
      $('#voiceStatus').textContent='Conexão instável · tentando recuperar...';

      if(!disconnectRepairTimer){
        disconnectRepairTimer=setTimeout(()=>{
          disconnectRepairTimer=null;

          if(
            pc.connectionState==='disconnected' ||
            pc.iceConnectionState==='disconnected'
          ){
            repairPeerConnection(peerId);
          }
        },2500);
      }
      return;
    }

    if(connection==='failed' || ice==='failed'){
      $('#voiceStatus').textContent='Recuperando conexão de mídia...';
      repairPeerConnection(peerId);

      setTimeout(()=>{
        if(
          state.joinedVoiceId &&
          (
            pc.connectionState==='failed' ||
            pc.iceConnectionState==='failed'
          )
        ){
          try{pc.close()}catch{}
          state.peers.delete(peerId);
          state.pendingCandidates.delete(peerId);
          scheduleVoiceReconnect(400);
        }
      },3500);
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
    $('#topTitle').textContent = 'Chamada privada';
    $('#topSub').textContent = state.privatePeerName;
    $('#voiceStatus').textContent = state.privateCallId ? 'Call privada · Conectando...' : 'Conectando...';

    syncVoiceControlsUI();

    ensureCard('local',state.username+' (você)',state.localStream,true);
    startSpeakingMonitor('local',state.localStream);

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
    button.textContent = muted ? '🔇 Áudio mutado' : 'Áudio';
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
  const channel=currentVoice();
  if(!channel) return;

  state.voiceReconnectPending=false;
  state.voiceReconnectAttempts=0;
  clearVoiceReconnectTimer();

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

    $('#voiceStatus').textContent = 'Conectando...';
    syncVoiceControlsUI();

    ensureCard('local',state.username+' (você)',state.localStream,true);
    startSpeakingMonitor('local',state.localStream);

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


function clearVoiceReconnectTimer(){
  if(state.voiceReconnectTimer){
    clearTimeout(state.voiceReconnectTimer);
    state.voiceReconnectTimer=null;
  }
}

function scheduleVoiceReconnect(delay=500){
  clearVoiceReconnectTimer();
  if(!state.joinedVoiceId) return;

  state.voiceReconnectPending=true;

  state.voiceReconnectTimer=setTimeout(()=>{
    state.voiceReconnectTimer=null;

    if(!state.joinedVoiceId || !socket.connected || !state.profileReady) return;

    state.voiceReconnectAttempts+=1;

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

    $('#voiceStatus').textContent='Reconectando call...';
  },delay);
}

async function repairPeerConnection(peerId){
  const pc=state.peers.get(peerId);
  if(!pc || pc.signalingState==='closed') return;

  try{
    if(typeof pc.restartIce==='function') pc.restartIce();

    if(pc.signalingState==='stable'){
      const offer=await pc.createOffer({iceRestart:true});
      await pc.setLocalDescription(offer);

      socket.emit('offer',{
        target:peerId,
        sdp:pc.localDescription
      });
    }
  }catch(error){
    console.warn('Falha ao reparar conexão WebRTC:',error);
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
  const wasPrivate=!!state.privateCallId;

  state.voiceReconnectPending=false;
  state.voiceReconnectAttempts=0;
  clearVoiceReconnectTimer();

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

  if(wasPrivate){
    setView('friends');
  }
}

function toggleMic(){
  const t = state.localStream?.getAudioTracks()[0];
  if(!t) return;
  t.enabled = !t.enabled;
  $('#micBtn').textContent = t.enabled ? 'Microfone' : '🔇 Microfone';
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


async function applyCameraSenderQuality(){
  for(const pc of state.peers.values()){
    const tx = getTransceiverByKind(pc,'video');
    const sender = tx?.sender;

    if(!sender || !sender.track || sender.track !== state.cameraTrack) continue;

    try{
      const params = sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = 5000000;
      params.encodings[0].maxFramerate = 30;
      await sender.setParameters(params);
    }catch(error){
      console.warn('Não foi possível aplicar o bitrate Full HD da câmera:',error);
    }
  }
}

async function toggleCamera(){
  if(!state.joinedVoiceId) return;

  if(state.cameraTrack && state.cameraTrack.readyState==='live'){
    state.cameraTrack.enabled = !state.cameraTrack.enabled;

    if(!state.screenTrack){
      await replaceVideoForAll(state.cameraTrack.enabled ? state.cameraTrack : null);

      if(state.cameraTrack.enabled){
        await applyCameraSenderQuality();
      }
    }

    $('#cameraBtn').textContent = 'Câmera';
    $('#cameraBtn').classList.toggle('off',!state.cameraTrack.enabled);
    ensureCard('local',state.username+' (você)',state.localStream,true);
    startSpeakingMonitor('local',state.localStream);
    return;
  }

  try{
    $('#cameraBtn').disabled = true;
    $('#cameraBtn').textContent = 'Abrindo...';

    const cam = await navigator.mediaDevices.getUserMedia({
      video:{
        deviceId:state.preferredCameraId?{exact:state.preferredCameraId}:undefined,
        width:{ideal:1920},
        height:{ideal:1080},
        frameRate:{ideal:30,max:30},
        aspectRatio:{ideal:16/9}
      },
      audio:false
    });

    state.cameraTrack = cam.getVideoTracks()[0];

    try{
      state.cameraTrack.contentHint = 'motion';
    }catch{}

    try{
      await state.cameraTrack.applyConstraints({
        width:{ideal:1920},
        height:{ideal:1080},
        frameRate:{ideal:30,max:30},
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
    startSpeakingMonitor('local',state.localStream);
    $('#cameraBtn').textContent = 'Câmera';
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
  $('#screenBtn').textContent = 'Compartilhar';
  $('#screenBtn').classList.remove('sharing');
  $('#cameraBtn').disabled = false;
  if(state.joinedVoiceId) $('#voiceStatus').textContent = 'Conectado';
}


function screenSharePreset(quality){
  if(quality === '720p'){
    return {
      width:{ideal:1280,max:1280},
      height:{ideal:720,max:720},
      frameRate:{ideal:30,max:30},
      maxBitrate:2500000
    };
  }

  if(quality === '1080p60'){
    return {
      width:{ideal:1920,max:1920},
      height:{ideal:1080,max:1080},
      frameRate:{ideal:60,max:60},
      maxBitrate:8000000
    };
  }

  return {
    width:{ideal:1920,max:1920},
    height:{ideal:1080,max:1080},
    frameRate:{ideal:30,max:30},
    maxBitrate:5000000
  };
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
    await applyScreenSenderQuality(state.screenTrack,state.screenShareQuality);

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
  deferredInstallPrompt=event;
  updateInstallButton();
});

window.addEventListener('appinstalled',()=>{
  deferredInstallPrompt=null;
  updateInstallButton();
  toast('Aplicativo instalado');
});

$('#installAppBtn').addEventListener('click',async ()=>{
  if(!deferredInstallPrompt){
    toast('Use a opção “Adicionar à tela inicial” do navegador');
    return;
  }

  deferredInstallPrompt.prompt();

  try{
    await deferredInstallPrompt.userChoice;
  }catch{}

  deferredInstallPrompt=null;
  updateInstallButton();
});

if('serviceWorker' in navigator){
  window.addEventListener('load',()=>{
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
renderNotifications();
if($('#addFriendBtn')){
  $('#addFriendBtn').textContent='Adicionar amigo';
}


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
$('#createTextQuickBtn').addEventListener('click',()=>{state.pendingChannelCategoryId=null;openModal('text')});
$('#createVoiceQuickBtn').addEventListener('click',()=>{state.pendingChannelCategoryId=null;openModal('voice')});
$('#createStageQuickBtn').addEventListener('click',()=>{state.pendingChannelCategoryId=null;openModal('stage')});

$('#homeCreateText').addEventListener('click',()=>openModal('text'));
$('#homeCreateVoice').addEventListener('click',()=>openModal('voice'));
$('#modalCancel').addEventListener('click',closeModal);
$('#modalOk').addEventListener('click',confirmModal);
$('#modalInput').addEventListener('keydown',e=>{if(e.key==='Enter')confirmModal();if(e.key==='Escape')closeModal()});
$('#modalWrap').addEventListener('click',e=>{if(e.target===$('#modalWrap'))closeModal()});

$('#profileBtn').addEventListener('click',openProfileModal);
$('#friendsProfileBtn').addEventListener('click',openProfileModal);
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

  $('#topTitle').textContent = 'Amigos';
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

$('#chatSearchInput').addEventListener('input',event=>{
  state.chatSearch=event.target.value||'';
  filterVisibleMessages();
});

$('#messageInput').addEventListener('input',()=>{
  if(!state.serverId||!state.textChannelId) return;
  socket.emit('chat-typing',{serverId:state.serverId,channelId:state.textChannelId});
});

$('#notificationBtn').addEventListener('click',event=>{
  event.stopPropagation();
  $('#notificationPanel').classList.toggle('hidden');
});

$('#clearNotificationsBtn').addEventListener('click',()=>{
  state.notifications=[];
  renderNotifications();
});

$('#userContextProfileBtn').addEventListener('click',()=>{
  const profile=state.userContextProfile;
  closeUserContextMenu();
  if(!profile) return;

  const member=serverMemberProfiles().find(item=>item.id===profile.id);
  if(member) openServerMemberProfile(profile.id);
  else toast((profile.displayName||profile.username||'Usuário')+' · '+(profile.bio||'Sem bio'));
});

$('#userContextMessageBtn').addEventListener('click',()=>{
  const profile=state.userContextProfile;
  closeUserContextMenu();
  if(!profile) return;

  const friend=getFriends().find(item=>item.id===profile.id);
  if(!friend){
    toast('Adicione essa pessoa como amigo primeiro');
    return;
  }

  state.dmTarget=profile.id;
  setView('dm');
  openDm(profile);
});

$('#userContextCallBtn').addEventListener('click',()=>{
  const profile=state.userContextProfile;
  closeUserContextMenu();
  if(!profile) return;
  socket.emit('private-call-request',{toUserId:profile.id});
});

$('#userContextBlockBtn').addEventListener('click',()=>{
  const profile=state.userContextProfile;
  if(!profile) return;

  if(state.blockedUsers.has(profile.id)){
    state.blockedUsers.delete(profile.id);
    toast('Usuário desbloqueado');
  }else{
    state.blockedUsers.add(profile.id);
    toast('Usuário bloqueado');
  }

  persistBlockedUsers();
  closeUserContextMenu();
  renderFriends();
  if(currentServer() && state.currentView!=='voice') renderServerPresence();
});

$('#userContextKickBtn').addEventListener('click',()=>{
  const profile=state.userContextProfile;
  closeUserContextMenu();
  if(!profile||!state.serverId) return;
  if(!confirm('Expulsar '+(profile.username||'este membro')+' do servidor?')) return;

  socket.emit('server-kick-member',{serverId:state.serverId,userId:profile.id});
});

document.addEventListener('click',event=>{
  if(!event.target.closest('#notificationPanel')&&!event.target.closest('#notificationBtn')){
    $('#notificationPanel').classList.add('hidden');
  }
  if(!event.target.closest('#userContextMenu')) closeUserContextMenu();
});
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

$('#contextEditBtn').addEventListener('click',()=>{
  const message=messageContextTarget;
  closeMessageContextMenu();
  if(!message || message.userId!==state.userId) return;

  const value=prompt('Editar mensagem:',message.text||'');
  if(value===null) return;

  socket.emit('chat-edit',{
    serverId:state.serverId,
    channelId:state.textChannelId,
    messageId:message.id,
    text:value
  });
});

$('#contextDeleteBtn').addEventListener('click',()=>{
  const message=messageContextTarget;
  closeMessageContextMenu();
  if(!message || message.userId!==state.userId) return;

  if(!confirm('Excluir esta mensagem?')) return;

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

$('#chatImageBtn').addEventListener('click',()=>$('#chatImageInput').click());
$('#chatImageInput').addEventListener('change',async event=>{
  const file=event.target.files?.[0];if(!file)return;
  if(!String(file.type||'').startsWith('image/')){toast('Escolha uma imagem');return}
  try{
    const data=await readImageFile(file,1200,.78);
    state.pendingChatAttachment={name:file.name,type:file.type,data};
    toast('Imagem pronta para enviar');
  }catch{toast('Não foi possível anexar a imagem')}
  event.target.value='';
});
$('#messageInput').addEventListener('keydown',e=>{if(e.key==='Enter')sendMessage()});

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
  $('#localMusicSeek').value = 0;
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
  const audio=$('#localMusicAudio');
  updateLocalMusicPlayButton();

  if(audio.error?.code===4){
    $('#localMusicDuration').textContent='Formato inválido';
  }else{
    $('#localMusicDuration').textContent='Erro';
  }
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

$('#micDeviceSelect').addEventListener('change',event=>{
  state.preferredMicId=event.target.value;localStorage.setItem('acord-mic-device',state.preferredMicId);
  toast('Microfone selecionado. Reconecte a call para aplicar.');
});
$('#cameraDeviceSelect').addEventListener('change',event=>{
  state.preferredCameraId=event.target.value;localStorage.setItem('acord-camera-device',state.preferredCameraId);
});
$('#noiseSuppressionToggle').checked=state.noiseSuppression;
$('#noiseSuppressionToggle').addEventListener('change',event=>{
  state.noiseSuppression=event.target.checked;localStorage.setItem('acord-noise-suppression',state.noiseSuppression?'1':'0');
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


socket.on('auth-success',payload=>{
  $('#loginBtn').disabled=false;
  $('#loginBtn').textContent=state.authMode==='register'?'Criar conta':'Entrar';
  $('#authError').textContent='';

  const hadActiveCall=!!state.joinedVoiceId;

  applyAuthProfile(payload?.profile,payload?.token);
  requestNotifications();

  if(hadActiveCall){
    closePeers();
    scheduleVoiceReconnect(250);
  }
});
socket.on('auth-error',payload=>{
  $('#loginBtn').disabled=false;
  $('#loginBtn').textContent=state.authMode==='register'?'Criar conta':'Entrar';
  $('#authError').textContent=payload?.error||'Não foi possível entrar.';
});
socket.on('auth-required',()=>{state.authToken='';localStorage.removeItem('acord-auth-token');$('#login').classList.remove('hidden');$('#appShell').classList.add('hidden')});
socket.on('auth-logout-success',clearAccountState);
socket.on('account-deleted',()=>{clearAccountState();alert('Sua conta foi excluída.')});
socket.on('profile-error',payload=>toast(payload?.error||'Não foi possível salvar o perfil'));
socket.on('chat-typing',data=>{
  if(
    data?.serverId!==state.serverId ||
    data?.channelId!==state.textChannelId ||
    data?.userId===state.userId ||
    state.blockedUsers.has(data?.userId)
  ) return;

  state.typingUsers.set(data.userId,{
    username:data.username||'Usuário',
    at:Date.now()
  });

  updateTypingIndicator();
  setTimeout(updateTypingIndicator,2800);
});

socket.on('chat-message-updated',message=>{
  if(message?.serverId!==state.serverId||message?.channelId!==state.textChannelId)return;
  document.querySelector('.message[data-message-id="' + message.id + '"]')?.remove();
  appendMessage(message);
});
socket.on('chat-message-deleted',({messageId})=>document.querySelector('.message[data-message-id="' + messageId + '"]')?.remove());
socket.on('stage-hand-raised',data=>{
  toast('✋ '+(data?.username||'Alguém')+' pediu para falar');
  addNotification('Acord · Palco',(data?.username||'Alguém')+' levantou a mão');
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
    toast(result?.error || 'Essa pessoa não existe no Acord');
  }
});

socket.on('incoming-private-call',data=>{
  showIncomingCall(data);
  addNotification('Ligação no Acord',(data?.username||'Alguém')+' está ligando para você');
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
  if(message.fromUserId!==state.userId && !state.blockedUsers.has(message.fromUserId)){
    addNotification('Nova mensagem privada',message.fromUsername||'Acord');
  }

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
      socket.emit('restore-servers',{
        servers:cached,
        legacyUserId:state.legacyUserId
      });
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

      state.currentView=previousView;
      state.appInitialized=true;
      restoreCurrentView();

      // Garante que o servidor visível no cache também volte a existir no backend.
      setTimeout(()=>{
        if(socket.connected && state.profileReady){
          socket.emit('restore-servers',{
            servers:getCachedServers(),
            legacyUserId:state.legacyUserId
          });
        }
      },250);

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


socket.on('category-created',payload=>{
  if(payload?.serverId!==state.serverId) return;

  toast('Categoria criada');
  socket.emit('get-servers');

  setTimeout(()=>{
    renderSidebar();
  },120);
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
  socket.emit('get-servers');
});


socket.on('text-history',history=>showMessages(history));
socket.on('chat-message',m=>{
  if(m.serverId===state.serverId && m.channelId===state.textChannelId) appendMessage(m);
});

socket.on('voice-participants',async participants=>{
  state.voiceReconnectPending=false;
  state.voiceReconnectAttempts=0;
  clearVoiceReconnectTimer();

  if(state.joinedVoiceId){
    $('#voiceStatus').textContent=state.privateCallId
      ? 'Call privada · Somente convidados'
      : 'Conectado';
  }

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
  stopSpeakingMonitor(id);
  document.getElementById('v-'+id)?.remove();
});

socket.on('disconnect',reason=>{
  if(!state.joinedVoiceId) return;

  state.voiceReconnectPending=true;
  clearVoiceReconnectTimer();

  $('#voiceStatus').textContent='Conexão interrompida · reconectando...';

  // Preserva microfone, câmera e identificação da call.
  closePeers();
});

socket.on('connect',()=>{
  if(state.authToken){
    socket.emit('auth-restore',{token:state.authToken});
  }else{
    $('#login').classList.remove('hidden');
    $('#appShell').classList.add('hidden');
  }

  setTimeout(()=>{
    if(state.appInitialized&&state.profileReady){
      restoreCurrentView();
    }
  },150);
});
</script>
</body>
</html>`;

app.get('/', (req, res) => {
  res.setHeader('Cache-Control','no-store');
  res.type('html').send(APP_HTML);
});

io.on('connection', socket => {
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
    if(!allowLoginAttempt()){
      socket.emit('auth-error',{error:'Muitas tentativas. Aguarde um minuto.'});
      return;
    }
    const safeUsername=normalizeAccountUsername(username);
    const safePassword=String(password||'');
    if(safeUsername.length<3){
      socket.emit('auth-error',{error:'O nome precisa ter pelo menos 3 caracteres.'});return;
    }
    if(usernameExists(safeUsername)){
      socket.emit('auth-error',{error:'Esse nome já está sendo usado.'});return;
    }
    if(safePassword.length<6 || safePassword.length>128){
      socket.emit('auth-error',{error:'A senha precisa ter entre 6 e 128 caracteres.'});return;
    }
    const userId=crypto.randomUUID();
    const salt=crypto.randomBytes(16).toString('hex');
    accounts.set(userId,{
      userId,username:safeUsername,usernameKey:usernameKey(safeUsername),salt,
      passwordHash:passwordDigest(safePassword,salt),createdAt:Date.now()
    });
    const profile={
      id:userId,username:safeUsername,displayName:safeUsername,bio:'',avatar:'',
      banner:'',status:'online',createdAt:Date.now()
    };
    profiles.set(userId,profile);
    const token=newSession(userId);
    socket.data.userId=userId;
    socket.data.username=safeUsername;
    saveServersToDisk();
    socket.emit('auth-success',{token,profile:publicProfile(profile)});
    sendServerList(socket);emitFriendState(userId);emitGroupState(userId);broadcastOnlineUsers();
  });

  socket.on('auth-login',({username,password,legacyUserId,legacyProfile})=>{
    if(!allowLoginAttempt()){
      socket.emit('auth-error',{error:'Muitas tentativas. Aguarde um minuto.'});
      return;
    }

    const safeUsername=normalizeAccountUsername(username);
    const safePassword=String(password||'');
    const key=usernameKey(safeUsername);

    let account=[...accounts.values()].find(item=>item.usernameKey===key);

    // Recupera a conta após redeploy em hospedagem sem disco persistente.
    if(!account){
      const recoveredId=String(legacyUserId||'').trim().slice(0,100);

      if(
        recoveredId &&
        safeUsername.length>=3 &&
        safePassword.length>=6 &&
        safePassword.length<=128
      ){
        const salt=crypto.randomBytes(16).toString('hex');

        account={
          userId:recoveredId,
          username:safeUsername,
          usernameKey:key,
          salt,
          passwordHash:passwordDigest(safePassword,salt),
          createdAt:Date.now()
        };

        accounts.set(recoveredId,account);

        if(!profiles.has(recoveredId)){
          const incoming=legacyProfile && typeof legacyProfile==='object'
            ? legacyProfile
            : {};

          profiles.set(recoveredId,{
            id:recoveredId,
            username:safeUsername,
            displayName:String(incoming.displayName||safeUsername).trim().slice(0,40)||safeUsername,
            bio:String(incoming.bio||'').trim().slice(0,300),
            avatar:String(incoming.avatar||'').slice(0,350000),
            banner:String(incoming.banner||'').slice(0,350000),
            status:['online','away','busy','invisible'].includes(incoming.status)
              ? incoming.status
              : 'online',
            createdAt:Date.now()
          });
        }

        saveServersToDisk();
      }
    }

    if(!account || !verifyAccountPassword(safePassword,account)){
      socket.emit('auth-error',{error:'Nome ou senha incorretos.'});
      return;
    }

    let profile=profiles.get(account.userId);

    if(!profile){
      profile={
        id:account.userId,
        username:account.username,
        displayName:account.username,
        bio:'',
        avatar:'',
        banner:'',
        status:'online',
        createdAt:Date.now()
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
  });

  socket.on('auth-restore',({token})=>{
    const userId=sessionUserId(token);
    const profile=userId?profiles.get(userId):null;
    if(!userId || !profile){socket.emit('auth-required');return}
    socket.data.userId=userId;
    socket.data.username=profile.username;
    socket.emit('auth-success',{token,profile:publicProfile(profile)});
    sendServerList(socket);emitFriendState(userId);emitGroupState(userId);broadcastOnlineUsers();
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

  socket.on('restore-servers', ({ servers: restored, legacyUserId }) => {
    if (!Array.isArray(restored) || !socket.data.userId) return;

    const safeLegacyId=String(legacyUserId||'').slice(0,100);

    for (const rawItem of restored.slice(0, 100)) {
      if (!rawItem?.id) continue;

      const item = { ...rawItem };
      const cachedOwnerId = String(item.ownerId || '');

      if(
        cachedOwnerId &&
        cachedOwnerId!==String(socket.data.userId) &&
        cachedOwnerId!==safeLegacyId
      ){
        continue;
      }

      if(
        !cachedOwnerId ||
        cachedOwnerId===safeLegacyId
      ){
        item.ownerId=socket.data.userId;
        item.members=[
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

  socket.on('create-category', ({ serverId, name, serverSnapshot, legacyUserId }) => {
    const s=recoverServerForWrite(
      socket,
      serverId,
      serverSnapshot,
      legacyUserId
    );

    if(!s){
      socket.emit('permission-error',{
        error:'Não foi possível recuperar este servidor. Entre nele novamente.'
      });
      return;
    }

    if(!requireServerAccess(s,socket)){
      socket.emit('permission-error',{error:'Você não faz parte deste servidor'});
      return;
    }

    if(!canManageChannelsCompat(s,socket)){
      permissionDenied(socket);
      return;
    }

    const safeName=cleanName(name,'Categoria');

    const category={
      id:id(),
      name:safeName,
      order:s.categories.length
    };

    s.categories.push(category);
    saveServersToDisk();

    broadcastServerLists();
    broadcastServerUpdate(s);

    socket.emit('category-created',{
      serverId:s.id,
      category
    });

    socket.emit('category-updated',{
      message:'Categoria criada'
    });
  });

  socket.on('delete-category', ({ serverId, categoryId }) => {
    const s = servers.get(serverId);
    if (!s || !requireServerAccess(s,socket)) return;

    if (!canManageChannelsCompat(s,socket)) {
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

    if (!canManageChannelsCompat(s,socket)) {
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

    if (!canManageChannelsCompat(s,socket)) {
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

  socket.on('create-channel', ({ serverId, type, name, categoryId, serverSnapshot, legacyUserId }) => {
    const s=recoverServerForWrite(
      socket,
      serverId,
      serverSnapshot,
      legacyUserId
    );

    if(!s){
      socket.emit('permission-error',{
        error:'Não foi possível recuperar este servidor. Entre nele novamente.'
      });
      return;
    }

    if(!requireServerAccess(s,socket)){
      socket.emit('permission-error',{error:'Você não faz parte deste servidor'});
      return;
    }

    if (!canManageChannelsCompat(s,socket)) {
      permissionDenied(socket);
      return;
    }

    const safeCategoryId =
      categoryId &&
      s.categories.some(category=>category.id===String(categoryId))
        ? String(categoryId)
        : null;

    if (type === 'text') {
      const channel = {
        id: id(),
        name: cleanChannel(name, 'novo-chat'),
        categoryId: safeCategoryId,
        order: s.textChannels.length
      };
      s.textChannels.push(channel);
      s.messages.set(channel.id, []);
      saveServersToDisk();
      broadcastServerLists();
      broadcastServerUpdate(s);

      socket.emit('channel-created',{
        serverId:s.id,
        type:'text',
        channelId:channel.id,
        categoryId:channel.categoryId
      });
      return;
    }

    if (type === 'voice' || type === 'stage') {
      const isStage = type === 'stage';

      const channel = {
        id: id(),
        name: cleanName(name, isStage ? 'Palco' : 'Nova voz'),
        categoryId: safeCategoryId,
        order: s.voiceChannels.length,
        mode: isStage ? 'stage' : 'voice'
      };

      s.voiceChannels.push(channel);
      saveServersToDisk();
      broadcastServerLists();
      broadcastServerUpdate(s);

      socket.emit('channel-created',{
        serverId:s.id,
        type:isStage ? 'stage' : 'voice',
        channelId:channel.id,
        categoryId:channel.categoryId
      });
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

  socket.on('chat-typing',({serverId,channelId})=>{
    const s=servers.get(serverId);
    if(!s || !requireServerAccess(s,socket)) return;
    if(!s.textChannels.some(channel=>channel.id===channelId)) return;

    socket.to(`text:${serverId}:${channelId}`).emit('chat-typing',{
      serverId,
      channelId,
      userId:socket.data.userId,
      username:socket.data.username||'Usuário'
    });
  });

  socket.on('chat-message', ({ serverId, channelId, text, replyTo, attachment }) => {
    const s=servers.get(serverId);
    if(!s || !requireServerAccess(s,socket)) return;
    if(!s.textChannels.some(channel=>channel.id===channelId)) return;

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

    if(!cleanText && !safeAttachment) return;

    const history=s.messages.get(channelId)||[];
    const message={
      id:id(),serverId,channelId,senderId:socket.id,userId:socket.data.userId,
      username:socket.data.username||'Usuário',text:cleanText,attachment:safeAttachment,
      replyTo:String(replyTo||'').slice(0,80)||null,reactions:{},at:Date.now(),edited:false
    };
    history.push(message);
    if(history.length>500) history.splice(0,history.length-500);
    s.messages.set(channelId,history);
    saveServersToDisk();
    io.to(`text:${serverId}:${channelId}`).emit('chat-message',message);
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
    io.to(`text:${serverId}:${channelId}`).emit('chat-message-updated',message);
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
    io.to(`text:${serverId}:${channelId}`).emit('chat-message-deleted',{messageId});
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
    io.to(`text:${serverId}:${channelId}`).emit('chat-message-updated',message);
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
    if (!callerSocketId || !callId || !socket.data.userId) return;

    const caller = io.sockets.sockets.get(String(callerSocketId));
    if(!caller?.data?.userId || !areFriends(socket.data.userId,caller.data.userId)) return;

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

    const room = 'private:' + String(callId).slice(0,100);

    if(socket.data.voiceRoom && socket.data.voiceRoom !== room){
      leaveVoiceRoom();
    }

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

    socket.data.username = socket.data.username || cleanName(username);
    if(!socket.data.userId) return;

    const alreadyInRoom=socket.rooms.has(room);

    socket.data.voiceRoom=room;
    socket.data.voiceServerId=null;
    socket.data.voiceChannelId=null;

    socket.join(room);

    socket.emit('voice-participants',participants);

    if(!alreadyInRoom){
      socket.to(room).emit('user-joined',{
        id:socket.id,
        username:socket.data.username
      });
    }

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

    const room = `voice:${serverId}:${channelId}`;

    if(socket.data.voiceRoom && socket.data.voiceRoom !== room){
      leaveVoiceRoom();
    }

    const participants = [...(io.sockets.adapter.rooms.get(room) || [])]
      .map(socketId => {
        const p = io.sockets.sockets.get(socketId);
        return p ? { id: socketId, username: p.data.username || 'Usuário' } : null;
      })
      .filter(Boolean);

    socket.data.username = cleanName(username);
    const alreadyInRoom=socket.rooms.has(room);

    socket.data.voiceRoom=room;
    socket.data.voiceServerId=serverId;
    socket.data.voiceChannelId=channelId;

    socket.join(room);

    socket.emit('voice-participants',participants);

    if(!alreadyInRoom){
      socket.to(room).emit('user-joined',{
        id:socket.id,
        username:socket.data.username
      });
    }

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
  console.log(`Acord rodando na porta ${PORT}`);
});
