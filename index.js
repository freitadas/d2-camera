import { DurableObject } from "cloudflare:workers";
import * as crypto from "node:crypto";
import { StateIndexes } from "./state-indexes.js";
import { SocketCompat, createIoCompat } from "./socket-compat.js";
import { normalizeAccountUsername, usernameKey, passwordDigest, verifyAccountPassword, tokenHash, readCookie } from "./auth-utils.js";

const id=()=>crypto.randomBytes(12).toString('hex');

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
const sharedControlRooms=new Map();
const stateIndexes=new StateIndexes();

const SESSION_LIFETIME_MS=1000*60*60*24*365;
const SESSION_GRACE_MS=1000*60*60*24*7;
const SESSION_COOKIE='__Host-acord_session';
const LEGACY_SESSION_COOKIE='acord_session';
const SHARED_CONTROL_GRANT_MS=10*60*1000;
const SHARED_CONTROL_REQUEST_MS=2*60*1000;

let io=null;

function rebuildStateIndexes(){
  stateIndexes.rebuild({profiles,accounts,friendships,friendRequests,servers,privateGroups});
  return stateIndexes;
}


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
    createdAt:Number(profile.createdAt||Date.now()),
    updatedAt:Number(profile.updatedAt||profile.createdAt||Date.now())
  };
}

function findProfileByUsername(username) {
  return stateIndexes.profileByUsername(username);
}

function privacyAllows(targetId,sourceId,kind){
  const profile=profiles.get(String(targetId||''));if(!profile)return false;
  const setting=profile.privacy?.[kind]||'friends';
  if(setting==='everyone')return true;
  if(setting==='nobody')return false;
  return areFriends(targetId,sourceId);
}

function areFriends(userA,userB) {
  return stateIndexes.areFriends(userA,userB);
}

function friendStateForUser(userId) {
  const safeId = String(userId || '').slice(0,100);
  if (!safeId) return { friends:[], incoming:[], outgoing:[] };

  const friends = stateIndexes.friendIds(safeId)
    .map(friendId => publicProfile(profiles.get(friendId)))
    .filter(Boolean);

  const incoming = stateIndexes.incomingRequests(safeId)
    .map(request => ({
      id:request.id,
      from:publicProfile(profiles.get(request.fromUserId)),
      at:request.at
    }))
    .filter(item => item.from);

  const outgoing = stateIndexes.outgoingRequests(safeId)
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
  const clients=ACTIVE_RUNTIME?.socketsForUser?.(safeId);
  if(clients){
    for(const client of clients) client.emit('friend-state',payload);
    return;
  }
  for (const client of io.sockets.sockets.values()) {
    if (client.data.userId === safeId) client.emit('friend-state',payload);
  }
}


function accountStateForUser(userId){
  const safeId=String(userId||'').slice(0,100);
  if(!safeId || !accounts.has(safeId)) return null;

  return {
    version:1,
    syncedAt:Date.now(),
    profile:publicProfile(profiles.get(safeId)),
    friends:friendStateForUser(safeId),
    servers:publicServersForUser(safeId),
    groups:groupsForUser(safeId)
  };
}

function emitAccountState(socket){
  const userId=String(socket?.data?.userId||'').slice(0,100);
  if(!userId) return;
  const payload=accountStateForUser(userId);
  if(payload) socket.emit('account-state',payload);
}

function migrateUserReferences(fromUserId,toUserId){
  const fromId=String(fromUserId||'').slice(0,100);
  const toId=String(toUserId||'').slice(0,100);
  if(!fromId || !toId || fromId===toId) return false;
  let changed=false;

  for(const s of servers.values()){
    if(s.ownerId===fromId){s.ownerId=toId;changed=true;}
    if(Array.isArray(s.members)&&s.members.includes(fromId)){
      s.members=[...new Set(s.members.map(v=>v===fromId?toId:v))];
      changed=true;
    }
  }
  for(const r of friendRequests){
    if(r.fromUserId===fromId){r.fromUserId=toId;changed=true;}
    if(r.toUserId===fromId){r.toUserId=toId;changed=true;}
  }
  for(const p of friendships){
    if(p.a===fromId){p.a=toId;changed=true;}
    if(p.b===fromId){p.b=toId;changed=true;}
  }
  const seenF=new Set();
  for(let i=friendships.length-1;i>=0;i--){
    const p=friendships[i];
    if(!p.a||!p.b||p.a===p.b){friendships.splice(i,1);changed=true;continue;}
    const k=[p.a,p.b].sort().join(':');
    if(seenF.has(k)){friendships.splice(i,1);changed=true;continue;}
    seenF.add(k);
  }
  const seenR=new Set();
  for(let i=friendRequests.length-1;i>=0;i--){
    const r=friendRequests[i];
    if(!r.fromUserId||!r.toUserId||r.fromUserId===r.toUserId){friendRequests.splice(i,1);changed=true;continue;}
    const k=r.fromUserId+':'+r.toUserId;
    if(seenR.has(k)){friendRequests.splice(i,1);changed=true;continue;}
    seenR.add(k);
  }
  for(const g of privateGroups.values()){
    if(g.ownerId===fromId){g.ownerId=toId;changed=true;}
    if(Array.isArray(g.members)&&g.members.includes(fromId)){
      g.members=[...new Set(g.members.map(v=>v===fromId?toId:v))].slice(0,10);changed=true;
    }
    for(const m of g.messages||[]){if(m.userId===fromId){m.userId=toId;changed=true;}}
  }
  for(const m of directMessages){
    if(m.fromUserId===fromId){m.fromUserId=toId;changed=true;}
    if(m.toUserId===fromId){m.toUserId=toId;changed=true;}
  }
  return changed;
}

function mergeRecoveryIntoCanonicalUser(userId,recovery){
  const canonicalId=String(userId||'').slice(0,100);
  if(!canonicalId||!accounts.has(canonicalId)||!recovery||typeof recovery!=='object')return false;
  const account=accounts.get(canonicalId);
  const recoveryUsername=normalizeAccountUsername(recovery.username);
  if(!recoveryUsername||usernameKey(recoveryUsername)!==account.usernameKey)return false;

  const recoveryId=String(recovery.userId||'').slice(0,100);
  let changed=false;

  if(recoveryId&&recoveryId!==canonicalId&&(!accounts.has(recoveryId)||accounts.get(recoveryId)?.usernameKey===account.usernameKey)){
    const old=profiles.get(recoveryId);
    if(old&&!profiles.has(canonicalId)){
      profiles.set(canonicalId,{...old,id:canonicalId,username:account.username,updatedAt:Date.now()});changed=true;
    }
    changed=migrateUserReferences(recoveryId,canonicalId)||changed;
    if(!accounts.has(recoveryId))profiles.delete(recoveryId);
  }

  let profile=profiles.get(canonicalId);
  if(!profile){
    profile={id:canonicalId,username:account.username,displayName:account.username,bio:'',avatar:'',banner:'',status:'online',customStatus:'',pronouns:'',activity:'',links:{},privacy:{dm:'friends',calls:'friends',friendRequests:'everyone'},createdAt:Number(account.createdAt||Date.now()),updatedAt:Number(account.createdAt||Date.now())};
    profiles.set(canonicalId,profile);changed=true;
  }

  const avatar=String(recovery.avatar||'').slice(0,350000), banner=String(recovery.banner||'').slice(0,350000), bio=String(recovery.bio||'').slice(0,300), display=String(recovery.displayName||'').slice(0,40);
  if(!profile.avatar&&avatar){profile.avatar=avatar;changed=true;}
  if(!profile.banner&&banner){profile.banner=banner;changed=true;}
  if(!profile.bio&&bio){profile.bio=bio;changed=true;}
  if((!profile.displayName||profile.displayName===profile.username)&&display&&display!==profile.username){profile.displayName=display;changed=true;}
  if(!profile.customStatus&&recovery.customStatus){profile.customStatus=String(recovery.customStatus).slice(0,80);changed=true;}
  if(!profile.pronouns&&recovery.pronouns){profile.pronouns=String(recovery.pronouns).slice(0,40);changed=true;}
  if(!profile.activity&&recovery.activity){profile.activity=String(recovery.activity).slice(0,80);changed=true;}
  if((!profile.links||!Object.keys(profile.links).length)&&recovery.links&&typeof recovery.links==='object'){profile.links=recovery.links;changed=true;}

  if(Array.isArray(recovery.servers)){
    for(const raw of recovery.servers.slice(0,100)){
      const sid=String(raw?.id||'').slice(0,80); if(!sid)continue;
      const owner=String(raw?.ownerId||'').slice(0,100);
      const members=Array.isArray(raw?.members)?raw.members.map(v=>String(v||'').slice(0,100)).filter(Boolean):[];
      const belongs=owner===recoveryId||owner===canonicalId||members.includes(recoveryId)||members.includes(canonicalId);
      if(!belongs)continue;
      const s=servers.get(sid);
      if(s){
        if(s.ownerId===recoveryId){s.ownerId=canonicalId;changed=true;}
        if(s.ownerId===canonicalId||(s.members||[]).includes(recoveryId)||(s.members||[]).includes(canonicalId)||members.includes(recoveryId)||members.includes(canonicalId)){
          const mapped=(s.members||[]).map(v=>v===recoveryId?canonicalId:v); if(!mapped.includes(canonicalId))mapped.push(canonicalId); s.members=[...new Set(mapped)];changed=true;
        }
        continue;
      }
      if(owner!==recoveryId&&owner!==canonicalId)continue;
      const restored=makeServer(cleanName(raw?.name,'Servidor'),{id:sid,ownerId:canonicalId,members:[...new Set([canonicalId,...members.map(v=>v===recoveryId?canonicalId:v)])],inviteToken:String(raw?.inviteToken||crypto.randomBytes(18).toString('hex')).slice(0,100),icon:String(raw?.icon||'').slice(0,350000),accent:raw?.accent,description:raw?.description,tags:raw?.tags,textChannels:raw?.textChannels,voiceChannels:raw?.voiceChannels,categories:raw?.categories,roles:raw?.roles,messages:raw?.messages,rules:raw?.rules,banner:raw?.banner,inviteExpiresAt:raw?.inviteExpiresAt,bans:raw?.bans,mutes:raw?.mutes,channelPolicies:raw?.channelPolicies,pinned:raw?.pinned,events:raw?.events,polls:raw?.polls,watchParty:raw?.watchParty,whiteboard:raw?.whiteboard,creative:raw?.creative});
      if(restored)changed=true;
    }
  }

  if(Array.isArray(recovery.friends)){
    for(const rf of recovery.friends.slice(0,500)){
      const uname=cleanName(rf?.username,'Usuário');
      const canonicalFriend=findProfileByUsername(uname);
      let fid=canonicalFriend?.id||String(rf?.id||'').slice(0,100);
      if(fid===recoveryId)fid=canonicalId;
      if(!fid||fid===canonicalId)continue;
      if(!profiles.has(fid)){
        profiles.set(fid,{id:fid,username:uname,displayName:uname,bio:String(rf?.bio||'').slice(0,160),avatar:String(rf?.avatar||'').slice(0,350000),banner:'',status:'offline',customStatus:'',pronouns:'',activity:'',links:{},privacy:{dm:'friends',calls:'friends',friendRequests:'everyone'},createdAt:Date.now(),updatedAt:Date.now()});changed=true;
      }
      if(!areFriends(canonicalId,fid)){friendships.push({a:canonicalId,b:fid,at:Date.now()});changed=true;}
    }
  }
  if(changed)profile.updatedAt=Date.now();
  return changed;
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
  return stateIndexes.groupIds(safeId)
    .map(groupId=>publicPrivateGroup(privateGroups.get(groupId)))
    .filter(Boolean);
}

function emitGroupState(userId) {
  const safeId = String(userId || '').slice(0,100);
  if (!safeId) return;
  const groups = groupsForUser(safeId);
  const clients=ACTIVE_RUNTIME?.socketsForUser?.(safeId);
  if(clients){
    for(const client of clients) client.emit('group-state',groups);
    return;
  }
  for (const client of io.sockets.sockets.values()) {
    if (client.data.userId === safeId) client.emit('group-state',groups);
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





function usernameExists(username, exceptId = null){
  return stateIndexes.usernameExists(username,exceptId);
}

function legacyProfileForUsername(username){
  const profile=stateIndexes.profileByUsername(username);
  return profile && !accounts.has(profile.id) ? profile : null;
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

function recordSecurityAudit(socket,action,target='',outcome='ok',detail=''){
  const username=String(socket?.data?.username||'anonymous').slice(0,30);
  const ip=String(socket?.data?.clientIp||'unknown').slice(0,100);
  const ipTag=crypto.createHash('sha256').update(ip).digest('hex').slice(0,12);
  recordAudit(
    '__security__',
    'security:'+String(action||'event').slice(0,64),
    username,
    [String(outcome||'ok'),String(target||'').slice(0,50),String(detail||'').slice(0,80),'ip#'+ipTag].filter(Boolean).join('|').slice(0,80)
  );
  if(String(action||'')!=='shared-control-input'){
    try{ACTIVE_RUNTIME?.queuePersist?.()}catch{}
  }
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
      ? options.messages[channel.id].slice(-300)
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
    createdAt:Number(profile.createdAt||Date.now()),
    updatedAt:Number(profile.updatedAt||profile.createdAt||Date.now())
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
    messages:[]
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
    messages: {},
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
  const safeId=String(userId||'').slice(0,100);
  if(!safeId) return [];
  return stateIndexes.serverIds(safeId)
    .map(serverId=>publicServer(servers.get(serverId)))
    .filter(Boolean);
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

function broadcastServerLists(serverData=null,{extraUserIds=[]}={}) {
  let userIds=[];
  if(serverData){
    userIds=[serverData.ownerId,...(serverData.members||[]),...extraUserIds];
  }else if(extraUserIds.length){
    userIds=[...extraUserIds];
  }else if(ACTIVE_RUNTIME?.userSockets){
    userIds=[...ACTIVE_RUNTIME.userSockets.keys()];
  }else{
    userIds=[...new Set([...io.sockets.sockets.values()].map(client=>client?.data?.userId).filter(Boolean))];
  }
  for(const userId of [...new Set(userIds.filter(Boolean).map(String))]){
    for(const client of ACTIVE_RUNTIME?.socketsForUser?.(userId)||[]){
      sendServerList(client);
    }
  }
}

function broadcastServerListsForUser(userId){
  const safeId=String(userId||'');
  if(!safeId) return;
  const impacted=new Set([safeId]);
  for(const serverId of stateIndexes.serverIds(safeId)){
    const serverData=servers.get(serverId);
    if(!serverData) continue;
    impacted.add(String(serverData.ownerId||''));
    for(const memberId of serverData.members||[]) impacted.add(String(memberId||''));
  }
  broadcastServerLists(null,{extraUserIds:[...impacted]});
}

function serverSockets(serverData,{excludeId=null}={}){
  if(!serverData) return [];
  const userIds=[...new Set([serverData.ownerId,...(serverData.members||[])].filter(Boolean).map(String))];
  const result=[];
  const seen=new Set();
  for(const userId of userIds){
    for(const client of ACTIVE_RUNTIME?.socketsForUser?.(userId)||[]){
      if(!client || (excludeId&&client.id===excludeId) || seen.has(client.id)) continue;
      seen.add(client.id);
      result.push(client);
    }
  }
  return result;
}

function emitToServerMembers(serverData,event,payload,{excludeId=null}={}){
  for(const client of serverSockets(serverData,{excludeId})) client.emit(event,payload);
}

function broadcastServerUpdate(serverData) {
  if (!serverData) return;
  emitToServerMembers(serverData,'server-updated',publicServer(serverData));
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
  stateIndexes.clear();
}

function serializeSnapshot(){
  return {
    version:20,
    savedAt:Date.now(),
    servers:serializeServers(),
    profiles:serializeProfiles(),
    accounts:serializeAccounts(),
    sessions:serializeSessions(),
    auditLog:auditLog.slice(-2000),
    directMessages:[],
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
        createdAt:Number(raw?.createdAt||Date.now()),
        updatedAt:Number(raw?.updatedAt||raw?.createdAt||Date.now())
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

    rebuildStateIndexes();
    return true;
  }catch(error){
    console.error('Falha ao hidratar snapshot:',error);
    resetPersistentState();
    return false;
  }
}

let ACTIVE_RUNTIME=null;

function persistChatMessage(message){
  if(!ACTIVE_RUNTIME || !message) return Promise.resolve(false);
  return ACTIVE_RUNTIME.persistChatMessage(message);
}

function deletePersistedChatMessage(message){
  if(!ACTIVE_RUNTIME || !message) return Promise.resolve(false);
  return ACTIVE_RUNTIME.deleteChatMessage(message);
}

function persistDmMessage(message){
  if(!ACTIVE_RUNTIME || !message) return Promise.resolve(false);
  return ACTIVE_RUNTIME.persistDmMessage(message);
}

function persistGroupMessage(message){
  if(!ACTIVE_RUNTIME || !message) return Promise.resolve(false);
  return ACTIVE_RUNTIME.persistGroupMessage(message);
}

function saveServersToDisk(){
  rebuildStateIndexes();
  if(!ACTIVE_RUNTIME) return false;
  ACTIVE_RUNTIME.queuePersist();
  return true;
}



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


  function sanitizeSharedControlPermissions(raw){
    const source=raw&&typeof raw==='object'?raw:{};
    return {
      mouse:source.mouse===true,
      keyboard:source.keyboard===true,
      gamepad:source.gamepad===true
    };
  }

  function activeSharedControlGrant(session,peerId){
    const safeId=String(peerId||'');
    const grant=session?.grants?.get(safeId);
    if(!grant) return null;
    if(Number(grant.expiresAt||0)<=Date.now()){
      session.grants.delete(safeId);
      io.sockets.sockets.get(safeId)?.emit('shared-control-revoked',{hostId:session.hostId,reason:'expired'});
      io.sockets.sockets.get(session.hostId)?.emit('shared-control-peer-released',{peerId:safeId,reason:'expired'});
      return null;
    }
    return grant;
  }

  function cleanupExpiredSharedControl(session){
    if(!session) return;
    const now=Date.now();
    for(const [peerId,request] of [...session.requests.entries()]){
      if(Number(request?.expiresAt||0)<=now) session.requests.delete(peerId);
    }
    for(const peerId of [...session.grants.keys()]) activeSharedControlGrant(session,peerId);
  }

  function sharedControlSnapshot(room){
    const session=sharedControlRooms.get(String(room||''));
    if(!session) return {active:false,hostId:'',hostName:'',grantedIds:[],requestedIds:[],grantDetails:[],requestDetails:[]};
    cleanupExpiredSharedControl(session);
    return {
      active:true,
      hostId:session.hostId,
      hostName:session.hostName||'Usuário',
      grantedIds:[...session.grants.keys()],
      requestedIds:[...session.requests.keys()],
      grantDetails:[...session.grants.entries()].map(([peerId,grant])=>({
        peerId,
        permissions:{
          mouse:!!grant?.permissions?.mouse,
          keyboard:!!grant?.permissions?.keyboard,
          gamepad:!!grant?.permissions?.gamepad
        },
        expiresAt:Number(grant?.expiresAt||0)
      })),
      requestDetails:[...session.requests.entries()].map(([peerId,request])=>({
        peerId,
        permissions:{
          mouse:!!request?.permissions?.mouse,
          keyboard:!!request?.permissions?.keyboard,
          gamepad:!!request?.permissions?.gamepad
        },
        expiresAt:Number(request?.expiresAt||0)
      }))
    };
  }

  function emitSharedControlState(room){
    if(!room) return;
    io.to(room).emit('shared-control-state',sharedControlSnapshot(room));
  }

  function cleanupSharedControlForSocket(room,socketId){
    const safeRoom=String(room||'');
    const safeId=String(socketId||'');
    const session=sharedControlRooms.get(safeRoom);
    if(!session) return;
    if(session.hostId===safeId){
      sharedControlRooms.delete(safeRoom);
      recordSecurityAudit(socket,'shared-control-host-stop',safeRoom,'ok','disconnect');
      io.to(safeRoom).emit('shared-control-state',{active:false,hostId:'',hostName:'',grantedIds:[],requestedIds:[],grantDetails:[],requestDetails:[]});
      return;
    }
    const hadAccess=session.grants.has(safeId) || session.requests.has(safeId);
    session.grants.delete(safeId);
    session.requests.delete(safeId);
    if(hadAccess){
      io.sockets.sockets.get(session.hostId)?.emit('shared-control-peer-released',{peerId:safeId,reason:'disconnect'});
      recordSecurityAudit(socket,'shared-control-access-drop',safeRoom,'ok','disconnect');
    }
    emitSharedControlState(safeRoom);
  }

  function sanitizeSharedControlInput(raw){
    if(!raw || typeof raw!=='object') return null;
    const type=String(raw.type||'');
    if(type==='pointer-move'){
      const x=Number(raw.x),y=Number(raw.y);
      if(!Number.isFinite(x)||!Number.isFinite(y)) return null;
      return {type,x:Math.max(0,Math.min(1,x)),y:Math.max(0,Math.min(1,y))};
    }
    if(type==='pointer-button'){
      const button=Math.max(0,Math.min(2,Number(raw.button)||0));
      return {type,button,down:!!raw.down};
    }
    if(type==='wheel'){
      const deltaY=Math.max(-1200,Math.min(1200,Number(raw.deltaY)||0));
      return {type,deltaY};
    }
    if(type==='key'){
      const code=String(raw.code||'').slice(0,32);
      if(!/^(Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|Space|Enter|Escape|Backspace|Tab|Arrow(?:Left|Up|Right|Down)|Home|End|PageUp|PageDown|Insert|Delete|Shift(?:Left|Right)|Control(?:Left|Right)|Alt(?:Left|Right)|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote)$/.test(code)) return null;
      return {type,code,down:!!raw.down};
    }
    if(type==='gamepad'){
      const index=Math.max(0,Math.min(3,Number(raw.index)||0));
      const buttons=Array.isArray(raw.buttons)?raw.buttons.slice(0,24).map(v=>Math.max(0,Math.min(1,Number(v)||0))):[];
      const axes=Array.isArray(raw.axes)?raw.axes.slice(0,8).map(v=>Math.max(-1,Math.min(1,Number(v)||0))):[];
      return {type,index,buttons,axes};
    }
    if(type==='release-all') return {type};
    return null;
  }

  socket.on('shared-control-sync',()=>{
    const room=socket.data.voiceRoom;
    if(room) socket.emit('shared-control-state',sharedControlSnapshot(room));
  });

  socket.on('shared-control-host-set',({enabled}={},ack)=>{
    const reply=typeof ack==='function'?ack:()=>{};
    const room=socket.data.voiceRoom;
    if(!room){reply({ok:false,error:'Entre em uma call primeiro'});return}
    const current=sharedControlRooms.get(room);
    if(!enabled){
      if(current?.hostId===socket.id){
        sharedControlRooms.delete(room);
        recordSecurityAudit(socket,'shared-control-host-stop',room,'ok','manual');
        emitSharedControlState(room);
      }
      reply({ok:true,active:false});
      return;
    }
    if(current && current.hostId!==socket.id){
      recordSecurityAudit(socket,'shared-control-host-start',room,'denied','host-conflict');
      reply({ok:false,error:'Outro participante já está compartilhando o controle nesta call'});
      return;
    }
    sharedControlRooms.set(room,{
      hostId:socket.id,
      hostUserId:String(socket.data.userId||''),
      hostName:socket.data.username||'Usuário',
      grants:new Map(),
      requests:new Map(),
      createdAt:Date.now()
    });
    recordSecurityAudit(socket,'shared-control-host-start',room,'ok');
    emitSharedControlState(room);
    reply({ok:true,active:true});
  });

  socket.on('shared-control-request',({permissions}={},ack)=>{
    const reply=typeof ack==='function'?ack:()=>{};
    const room=socket.data.voiceRoom;
    const session=room?sharedControlRooms.get(room):null;
    if(!room||!session){reply({ok:false,error:'Nenhum Controle compartilhado ativo nesta call'});return}
    if(session.hostId===socket.id){reply({ok:false,error:'Você já é o host do Controle compartilhado'});return}
    const safePermissions=sanitizeSharedControlPermissions(permissions);
    if(!safePermissions.mouse&&!safePermissions.keyboard&&!safePermissions.gamepad){
      reply({ok:false,error:'Selecione ao menos uma permissão'});return;
    }
    const request={
      permissions:safePermissions,
      requestId:crypto.randomBytes(12).toString('hex'),
      requestedAt:Date.now(),
      expiresAt:Date.now()+SHARED_CONTROL_REQUEST_MS
    };
    session.requests.set(socket.id,request);
    const host=io.sockets.sockets.get(session.hostId);
    host?.emit('shared-control-requested',{peerId:socket.id,username:socket.data.username||'Usuário',permissions:safePermissions,expiresAt:request.expiresAt});
    recordSecurityAudit(socket,'shared-control-request',room,'ok',JSON.stringify(safePermissions));
    emitSharedControlState(room);
    reply({ok:true,expiresAt:request.expiresAt});
  });

  socket.on('shared-control-grant',({peerId,permissions}={},ack)=>{
    const reply=typeof ack==='function'?ack:()=>{};
    const room=socket.data.voiceRoom;
    const session=room?sharedControlRooms.get(room):null;
    const safePeerId=String(peerId||'');
    if(!session||session.hostId!==socket.id){reply({ok:false,error:'Somente o host pode liberar o controle'});return}
    const peer=io.sockets.sockets.get(safePeerId);
    if(!peer||peer.data.voiceRoom!==room||safePeerId===socket.id){reply({ok:false,error:'Participante indisponível'});return}
    cleanupExpiredSharedControl(session);
    const request=session.requests.get(safePeerId);
    if(!request){reply({ok:false,error:'A solicitação expirou ou não existe'});return}
    const requested=sanitizeSharedControlPermissions(request.permissions||{});
    const selected=sanitizeSharedControlPermissions(permissions||requested);
    const safePermissions={
      mouse:!!(requested.mouse&&selected.mouse),
      keyboard:!!(requested.keyboard&&selected.keyboard),
      gamepad:!!(requested.gamepad&&selected.gamepad)
    };
    if(!safePermissions.mouse&&!safePermissions.keyboard&&!safePermissions.gamepad){
      reply({ok:false,error:'Nenhuma permissão compatível foi selecionada'});return;
    }
    const accessToken=crypto.randomBytes(24).toString('hex');
    const expiresAt=Date.now()+SHARED_CONTROL_GRANT_MS;
    session.grants.set(safePeerId,{permissions:safePermissions,accessToken,grantedAt:Date.now(),expiresAt});
    session.requests.delete(safePeerId);
    peer.emit('shared-control-granted',{hostId:socket.id,hostName:socket.data.username||'Usuário',permissions:safePermissions,accessToken,expiresAt});
    recordSecurityAudit(socket,'shared-control-grant',safePeerId,'ok',JSON.stringify(safePermissions));
    emitSharedControlState(room);
    reply({ok:true,expiresAt,permissions:safePermissions});
  });

  socket.on('shared-control-revoke',({peerId}={},ack)=>{
    const reply=typeof ack==='function'?ack:()=>{};
    const room=socket.data.voiceRoom;
    const session=room?sharedControlRooms.get(room):null;
    const safePeerId=String(peerId||'');
    if(!session||session.hostId!==socket.id){reply({ok:false,error:'Somente o host pode revogar o controle'});return}
    session.grants.delete(safePeerId);
    session.requests.delete(safePeerId);
    io.sockets.sockets.get(safePeerId)?.emit('shared-control-revoked',{hostId:socket.id,reason:'host-revoked'});
    io.sockets.sockets.get(session.hostId)?.emit('shared-control-peer-released',{peerId:safePeerId,reason:'host-revoked'});
    recordSecurityAudit(socket,'shared-control-revoke',safePeerId,'ok');
    emitSharedControlState(room);
    reply({ok:true});
  });

  socket.on('shared-control-cancel',()=>{
    const room=socket.data.voiceRoom;
    const session=room?sharedControlRooms.get(room):null;
    if(!session||session.hostId===socket.id) return;
    session.grants.delete(socket.id);
    session.requests.delete(socket.id);
    io.sockets.sockets.get(session.hostId)?.emit('shared-control-peer-released',{peerId:socket.id,reason:'peer-release'});
    recordSecurityAudit(socket,'shared-control-release',room,'ok');
    emitSharedControlState(room);
  });

  socket.on('shared-control-input',({hostId,event,accessToken}={})=>{
    const room=socket.data.voiceRoom;
    const session=room?sharedControlRooms.get(room):null;
    if(!session||session.hostId!==String(hostId||'')||session.hostId===socket.id) return;
    const grant=activeSharedControlGrant(session,socket.id);
    if(!grant) return;
    const supplied=String(accessToken||'');
    const expected=String(grant.accessToken||'');
    if(!supplied||!expected||supplied.length!==expected.length){
      recordSecurityAudit(socket,'shared-control-input',room,'denied','missing-token');
      return;
    }
    try{
      if(!crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))){
        recordSecurityAudit(socket,'shared-control-input',room,'denied','bad-token');
        return;
      }
    }catch{return}
    const host=io.sockets.sockets.get(session.hostId);
    if(!host||host.data.voiceRoom!==room) return;
    const safe=sanitizeSharedControlInput(event);
    if(!safe) return;
    if((safe.type==='pointer-move'||safe.type==='pointer-button'||safe.type==='wheel')&&!grant.permissions.mouse) return;
    if(safe.type==='key'&&!grant.permissions.keyboard) return;
    if(safe.type==='gamepad'&&!grant.permissions.gamepad) return;
    host.emit('shared-control-input',{from:socket.id,event:safe,permissions:grant.permissions,expiresAt:grant.expiresAt});
  });

  broadcastOnlineUsers();


  socket.on('auth-cookie',()=>{
    const userId=String(socket.data.userId||'').slice(0,100);
    const profile=userId?profiles.get(userId):null;

    if(!userId || !profile || !socket.data.cookieSession){
      socket.emit('auth-cookie-missing',{ok:false});
      return;
    }

    socket.emit('auth-success',{
      profile:publicProfile(profile),
      cookieSession:true,
      recoveryProof:ACTIVE_RUNTIME?.issueRecoveryProof(userId,profile.username)||''
    });

    emitAccountState(socket);
    sendServerList(socket);
    emitFriendState(userId);
    emitGroupState(userId);
    broadcastOnlineUsers();
  });

  socket.on('auth-register',async ({username,password})=>{
    try{
      const authRate=ACTIVE_RUNTIME?.allowAuthAttempt(socket,username)||{ok:true};
      if(!authRate.ok){
        recordSecurityAudit(socket,'auth-register',String(username||''),'blocked','rate-limit');
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

      if(safePassword.length<8 || safePassword.length>128){
        socket.emit('auth-error',{error:'Para criar a conta, use uma senha entre 8 e 128 caracteres.'});
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
        customStatus:'',
        pronouns:'',
        activity:'',
        links:{},
        privacy:{dm:'friends',calls:'friends',friendRequests:'everyone'},
        createdAt:Date.now(),
        updatedAt:Date.now()
      };

      profile.username=safeUsername;
      profile.displayName=profile.displayName || safeUsername;
      profile.status=profile.status || 'online';
      profiles.set(userId,profile);

      const token=newSession(userId);
      socket.data.userId=userId;
      socket.data.username=safeUsername;
      socket.data.sessionHash=tokenHash(token);
      socket.data.cookieSession=false;

      saveServersToDisk();

      ACTIVE_RUNTIME?.resetAuthAttempts(socket,safeUsername);
      recordSecurityAudit(socket,'auth-register',safeUsername,'ok');
      socket.emit('auth-success',{
        token,
        profile:publicProfile(profile),
        recoveryProof:ACTIVE_RUNTIME?.issueRecoveryProof(userId,safeUsername)||'',
        migratedLegacy:!!legacy
      });

      emitAccountState(socket);
      sendServerList(socket);
      emitFriendState(userId);
      emitGroupState(userId);
      broadcastOnlineUsers();
    }catch(error){
      console.error('Erro ao criar conta:',error);
      recordSecurityAudit(socket,'auth-register',String(username||''),'error','runtime');
      socket.emit('auth-error',{
        error:'Não foi possível criar a conta agora. Tente novamente.'
      });
    }
  });

  socket.on('auth-login',async ({username,password,recovery})=>{
    try{
      const authRate=ACTIVE_RUNTIME?.allowAuthAttempt(socket,username)||{ok:true};
      if(!authRate.ok){
        recordSecurityAudit(socket,'auth-login',String(username||''),'blocked','rate-limit');
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
      let account=stateIndexes.accountByUsername(safeUsername);

      // Login não cria mais uma identidade vazia silenciosamente.
      // Uma conta ausente só é recuperada quando este aparelho possui
      // um backup local compatível com o mesmo usuário.
      if(!account){
        const recoveryUserId=String(recovery?.userId||'').slice(0,100);
        const recoveryUsername=normalizeAccountUsername(recovery?.username);
        const sameRecoveryUser=recoveryUserId&&recoveryUsername&&usernameKey(recoveryUsername)===key;
        const recoveryVerified=!!ACTIVE_RUNTIME?.verifyRecoveryProof(recovery);
        if(!sameRecoveryUser || !recoveryVerified){
          recordSecurityAudit(socket,'auth-login',safeUsername,'denied','invalid-recovery');
          socket.emit('auth-error',{error:'Conta não encontrada. A recuperação local não pôde ser validada com segurança.'});
          return;
        }
        const conflicting=accounts.get(recoveryUserId);
        if(conflicting&&conflicting.usernameKey!==key){socket.emit('auth-error',{error:'Não foi possível recuperar essa conta com segurança.'});return;}
        const salt=crypto.randomBytes(16).toString('hex');
        account={userId:recoveryUserId,username:safeUsername,usernameKey:key,salt,passwordHash:passwordDigest(safePassword,salt),createdAt:Number(recovery?.savedAt||Date.now())};
        accounts.set(recoveryUserId,account);
        if(!profiles.has(recoveryUserId)){
          profiles.set(recoveryUserId,{id:recoveryUserId,username:safeUsername,displayName:String(recovery?.displayName||safeUsername).slice(0,40),bio:String(recovery?.bio||'').slice(0,300),avatar:String(recovery?.avatar||'').slice(0,350000),banner:String(recovery?.banner||'').slice(0,350000),status:['online','away','busy','invisible'].includes(recovery?.status)?recovery.status:'online',customStatus:String(recovery?.customStatus||'').slice(0,80),pronouns:String(recovery?.pronouns||'').slice(0,40),activity:String(recovery?.activity||'').slice(0,80),links:recovery?.links&&typeof recovery.links==='object'?recovery.links:{},privacy:recovery?.privacy&&typeof recovery.privacy==='object'?recovery.privacy:{dm:'friends',calls:'friends',friendRequests:'everyone'},createdAt:Number(recovery?.savedAt||Date.now()),updatedAt:Number(recovery?.savedAt||Date.now())});
        }
        mergeRecoveryIntoCanonicalUser(recoveryUserId,recovery);
        socket.data.userId=recoveryUserId;
        socket.data.username=safeUsername;
        const token=newSession(recoveryUserId);
        socket.data.sessionHash=tokenHash(token);
        socket.data.cookieSession=false;
        saveServersToDisk();
        ACTIVE_RUNTIME?.resetAuthAttempts(socket,safeUsername);
        recordSecurityAudit(socket,'auth-login',safeUsername,'ok','recovered-identity');
        socket.emit('auth-success',{token,profile:publicProfile(profiles.get(recoveryUserId)),recoveryProof:ACTIVE_RUNTIME?.issueRecoveryProof(recoveryUserId,safeUsername)||'',accountRecovered:true,recoveredIdentity:true});
        emitAccountState(socket); sendServerList(socket); emitFriendState(recoveryUserId); emitGroupState(recoveryUserId); broadcastOnlineUsers();
        return;
      }

      if(account.recoveredSessionOnly){
        const recoveryMatches=String(recovery?.userId||'')===String(account.userId||'');
        if(!recoveryMatches || !ACTIVE_RUNTIME?.verifyRecoveryProof(recovery)){
          socket.emit('auth-error',{error:'Esta conta precisa ser reativada pelo dispositivo que possui a recuperação validada.'});
          return;
        }
        const newSalt=crypto.randomBytes(16).toString('hex');
        account.salt=newSalt;
        account.passwordHash=passwordDigest(safePassword,newSalt);
        account.recoveredSessionOnly=false;
        saveServersToDisk();
      }else if(!verifyAccountPassword(safePassword,account)){
        recordSecurityAudit(socket,'auth-login',safeUsername,'denied','bad-password');
        socket.emit('auth-error',{error:'Senha incorreta.'});
        return;
      }

      const recoveryMerged=mergeRecoveryIntoCanonicalUser(account.userId,recovery);
      if(recoveryMerged){
        await ACTIVE_RUNTIME?.migrateInlineMedia();
        saveServersToDisk();
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
          customStatus:'',
          pronouns:'',
          activity:'',
          links:{},
          privacy:{dm:'friends',calls:'friends',friendRequests:'everyone'},
          createdAt:Number(account.createdAt || Date.now()),
          updatedAt:Number(account.createdAt || Date.now())
        };
        profiles.set(account.userId,profile);
      }

      socket.data.userId=account.userId;
      socket.data.username=account.username;

      const token=newSession(account.userId);
      socket.data.sessionHash=tokenHash(token);
      socket.data.cookieSession=false;
      saveServersToDisk();

      ACTIVE_RUNTIME?.resetAuthAttempts(socket,safeUsername);
      recordSecurityAudit(socket,'auth-login',safeUsername,'ok');
      socket.emit('auth-success',{token,profile:publicProfile(profile),recoveryProof:ACTIVE_RUNTIME?.issueRecoveryProof(account.userId,account.username)||''});
      emitAccountState(socket);
      sendServerList(socket);
      emitFriendState(account.userId);
      emitGroupState(account.userId);
      broadcastOnlineUsers();
    }catch(error){
      console.error('Erro ao entrar:',error);
      recordSecurityAudit(socket,'auth-login',String(username||''),'error','runtime');
      socket.emit('auth-error',{
        error:'Não foi possível entrar agora. Tente novamente.'
      });
    }
  });

  socket.on('auth-restore',({token,recovery})=>{
    try{
      let restoredToken=String(token||'');
      let userId=sessionUserId(restoredToken,{renew:true});
      let profile=userId?profiles.get(userId):null;
      let recoveredAfterUpdate=false;

      // Recuperação de atualização:
      // se o host perdeu o arquivo local, o navegador ainda possui token,
      // id, perfil, servidores e amizades do próprio usuário.
      if(!userId && recovery && String(restoredToken || '').length>=20 && ACTIVE_RUNTIME?.verifyRecoveryProof(recovery)){
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
            createdAt:Number(recovery.savedAt || Date.now()),
            updatedAt:Number(recovery.savedAt || Date.now())
          };

          profiles.set(safeUserId,profile);

          restoredToken=newSession(safeUserId);

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

      if(userId && recovery){
        const mergedRecovery=mergeRecoveryIntoCanonicalUser(userId,recovery);
        if(mergedRecovery) saveServersToDisk();
      }

      profile=userId ? profiles.get(userId) : null;

      if(!userId || !profile){
        recordSecurityAudit(socket,'auth-restore','session','denied','invalid-session');
        socket.emit('auth-required',{reason:'invalid-session'});
        return;
      }

      socket.data.userId=userId;
      socket.data.username=profile.username;
      socket.data.sessionHash=tokenHash(restoredToken);
      socket.data.cookieSession=false;

      saveServersToDisk();
      recordSecurityAudit(socket,'auth-restore',profile.username,'ok',recoveredAfterUpdate?'recovered-after-update':'session');

      socket.emit('auth-success',{
        token:restoredToken,
        profile:publicProfile(profile),
        recoveryProof:ACTIVE_RUNTIME?.issueRecoveryProof(userId,profile.username)||'',
        sessionRestored:true,
        recoveredAfterUpdate
      });

      emitAccountState(socket);
      sendServerList(socket);
      emitFriendState(userId);
      emitGroupState(userId);
      broadcastOnlineUsers();
    }catch(error){
      console.error('Erro ao restaurar sessão:',error);
      recordSecurityAudit(socket,'auth-restore','session','error','runtime');
      socket.emit('auth-restore-retry',{reason:'temporary-error'});
    }
  });

  socket.on('auth-keepalive',({token}={})=>{
    const rawToken=String(token||'');
    const hash=rawToken
      ? tokenHash(rawToken)
      : String(socket.data.sessionHash||'');
    const session=hash?sessions.get(hash):null;
    const userId=rawToken
      ? sessionUserId(rawToken,{renew:true})
      : session?.userId;

    if(!userId || userId!==socket.data.userId || !session){
      socket.emit('auth-required',{reason:'invalid-session'});
      return;
    }

    const now=Date.now();
    session.lastSeenAt=now;
    session.expiresAt=now+SESSION_LIFETIME_MS;

    const lastPersisted=Number(session?.lastPersistedAt || 0);

    if(now-lastPersisted > 1000*60*30){
      session.lastPersistedAt=now;
      saveServersToDisk();
    }

    socket.emit('auth-alive',{at:now});
  });

  socket.on('auth-logout',({token}={})=>{
    const rawToken=String(token||'');
    const hash=rawToken
      ? tokenHash(rawToken)
      : String(socket.data.sessionHash||'');
    const session=hash?sessions.get(hash):null;
    if(session?.userId===socket.data.userId) sessions.delete(hash);
    recordSecurityAudit(socket,'auth-logout',String(socket.data.userId||''),'ok');
    socket.data.userId=null;
    socket.data.username=null;
    socket.data.sessionHash=null;
    socket.data.cookieSession=false;
    saveServersToDisk();
    socket.emit('auth-logout-success');
    broadcastOnlineUsers();
  });

  socket.on('delete-account',({token}={})=>{
    const rawToken=String(token||'');
    const hash=rawToken
      ? tokenHash(rawToken)
      : String(socket.data.sessionHash||'');
    const session=hash?sessions.get(hash):null;
    const userId=rawToken
      ? sessionUserId(rawToken)
      : session?.userId;

    if(!userId || userId!==socket.data.userId){
      socket.emit('auth-error',{error:'Sessão inválida.'});return;
    }
    const profile=profiles.get(userId);
    const username=profile?.username||'';

    for(const [serverId,s] of [...servers.entries()]){
      if(s.ownerId===userId){
        servers.delete(serverId);
        ACTIVE_RUNTIME?.deleteServerData(serverId);
        continue;
      }
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
      if(group.ownerId===userId){
        privateGroups.delete(groupId);
        ACTIVE_RUNTIME?.deleteGroupData(groupId);
        continue;
      }
      group.members=(group.members||[]).filter(id=>id!==userId);
      group.messages=(group.messages||[]).filter(message=>message.userId!==userId);
      if(group.members.length<2){
        privateGroups.delete(groupId);
        ACTIVE_RUNTIME?.deleteGroupData(groupId);
      }
    }
    ACTIVE_RUNTIME?.deleteAccountData(userId);
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

  socket.on('set-profile', async ({ username, displayName, bio, avatar, banner, status, knownServerIds }) => {
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

    let nextAvatar=String(avatar===undefined?(oldProfile?.avatar||''):avatar).slice(0,1200000);
    let nextBanner=String(banner===undefined?(oldProfile?.banner||''):banner).slice(0,1200000);

    if(nextAvatar.startsWith('data:')){
      nextAvatar=await ACTIVE_RUNTIME?.putMediaDataUrl('profile:'+safeId+':avatar',nextAvatar) || nextAvatar;
    }

    if(nextBanner.startsWith('data:')){
      nextBanner=await ACTIVE_RUNTIME?.putMediaDataUrl('profile:'+safeId+':banner',nextBanner) || nextBanner;
    }

    const profile={
      ...(oldProfile||{}),
      id:safeId,
      username:safeUsername,
      displayName:String(displayName||safeUsername).trim().slice(0,40)||safeUsername,
      bio:String(bio||'').trim().slice(0,300),
      avatar:nextAvatar,
      banner:nextBanner,
      status:['online','away','busy','invisible'].includes(status)?status:'online',
      customStatus:String(oldProfile?.customStatus||'').slice(0,80),
      pronouns:String(oldProfile?.pronouns||'').slice(0,40),
      activity:String(oldProfile?.activity||'').slice(0,80),
      links:oldProfile?.links&&typeof oldProfile.links==='object'?oldProfile.links:{},
      privacy:oldProfile?.privacy&&typeof oldProfile.privacy==='object'?oldProfile.privacy:{dm:'friends',calls:'friends',friendRequests:'everyone'},
      createdAt:Number(oldProfile?.createdAt||Date.now()),
      updatedAt:Date.now()
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
    emitAccountState(socket);
    sendServerList(socket);
    emitFriendState(safeId);
    emitGroupState(safeId);
    broadcastServerListsForUser(safeId);
    broadcastOnlineUsers();
  });

  socket.on('restore-friends', async ({ friends }) => {
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
        let restoredAvatar=String(rawFriend?.avatar || '').slice(0,1200000);

        if(restoredAvatar.startsWith('data:')){
          restoredAvatar=
            await ACTIVE_RUNTIME?.putMediaDataUrl(
              'profile:'+friendId+':avatar',
              restoredAvatar
            ) || restoredAvatar;
        }

        profiles.set(friendId,{
          id:friendId,
          username,
          displayName:username,
          bio:String(rawFriend?.bio || '').trim().slice(0,160),
          avatar:restoredAvatar,
          banner:'',
          status:'offline',
          customStatus:'',
          pronouns:'',
          activity:'',
          links:{},
          privacy:{dm:'friends',calls:'friends',friendRequests:'everyone'},
          createdAt:Date.now(),
          updatedAt:Date.now()
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
    ACTIVE_RUNTIME?.deleteGroupData(safeGroupId);
    saveServersToDisk();

    for(const userId of members){
      emitGroupState(userId);

      for(const client of ACTIVE_RUNTIME?.socketsForUser?.(userId)||[]){
        client.emit('group-deleted',{groupId:safeGroupId,groupName});
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

    const messages=ACTIVE_RUNTIME?.getGroupHistory(group.id,300)
      || (group.messages||[]).slice(-300);

    group.messages=messages.slice(-300);

    socket.emit('group-history',{
      groupId:group.id,
      messages
    });
  });

  socket.on('group-message', async ({ groupId, text }) => {
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
    while (group.messages.length > 300) group.messages.shift();

    await persistGroupMessage(message);

    for(const userId of group.members||[]){
      for(const client of ACTIVE_RUNTIME?.socketsForUser?.(userId)||[]) client.emit('group-message',message);
    }
  });

  socket.on('get-friend-state', () => {
    if (!socket.data.userId) return;
    emitFriendState(socket.data.userId);
  });

  socket.on('get-account-state',()=>{
    if(!socket.data.userId) return;
    emitAccountState(socket);
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
      broadcastServerListsForUser(socket.data.userId);
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
    broadcastServerLists(created);

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

    const serverData=stateIndexes.serverByInvite(safeToken);

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

  socket.on('update-server-settings', async ({ serverId, name, icon, accent, description, tags }) => {
    const safeId = String(serverId || '').slice(0,80);
    const serverData = servers.get(safeId);

    if (!serverData || !requireServerAccess(serverData,socket)) return;

    if (!hasServerPermission(serverData,socket,'manageServer')) {
      permissionDenied(socket);
      return;
    }

    serverData.name = cleanName(name, serverData.name || 'Servidor');

    const rawIcon=String(icon===undefined?serverData.icon:icon).slice(0,1200000);
    serverData.icon=rawIcon.startsWith('data:')
      ? (await ACTIVE_RUNTIME?.putMediaDataUrl('server:'+safeId+':icon',rawIcon) || rawIcon)
      : rawIcon;

    serverData.accent = /^#[0-9a-f]{6}$/i.test(String(accent || ''))
      ? String(accent)
      : (serverData.accent || '#ff6b4a');
    serverData.description = String(description || '').trim().slice(0,240);
    serverData.tags = Array.isArray(tags)
      ? tags.map(tag => String(tag || '').trim().slice(0,22)).filter(Boolean).slice(0,5)
      : [];

    saveServersToDisk();
    broadcastServerLists(serverData);

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

    const formerUserIds=[serverData.ownerId,...(serverData.members||[])];
    servers.delete(safeId);
    ACTIVE_RUNTIME?.deleteServerData(safeId);
    saveServersToDisk();

    socket.emit('server-deleted', { serverId: safeId });
    broadcastServerLists(null,{extraUserIds:formerUserIds});
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

    broadcastServerLists(s);
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
    broadcastServerLists(s);
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
    broadcastServerLists(s);
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
    broadcastServerLists(s);
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
    broadcastServerLists(s);
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
    broadcastServerLists(s);
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
      broadcastServerLists(s);
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
      broadcastServerLists(s);
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
      ACTIVE_RUNTIME?.deleteChannelData(serverId,safeChannelId);
      s.textChannels.forEach((channel,idx)=>channel.order=idx);

      const textRoom=`text:${serverId}:${safeChannelId}`;
      for(const socketId of [...(ACTIVE_RUNTIME?.roomSockets?.get(textRoom)||[])]){
        const client=ACTIVE_RUNTIME?.sockets?.get(socketId);
        if(!client) continue;
        client.leave(textRoom);
        client.data.textRoom=null;client.data.textServerId=null;client.data.textChannelId=null;
      }

      recordAudit(serverId,'delete-channel',socket.data.username || 'Usuário',removed?.name || safeChannelId);
      saveServersToDisk();
      broadcastServerLists(s);

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
    broadcastServerLists(s);

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

    const history=ACTIVE_RUNTIME?.getDmHistory(socket.data.userId,targetId,500)
      || directMessages
        .filter(message=>sameDmConversation(message,socket.data.userId,targetId))
        .sort((a,b)=>Number(a.at||0)-Number(b.at||0))
        .slice(-500);

    socket.emit('dm-history',{
      targetUserId:targetId,
      messages:history
    });
  });

  socket.on('dm-message', async ({ targetUserId, targetUsername, text, clientMessageId }) => {
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

    await persistDmMessage(message);

    socket.emit('dm-message',message);

    for(const client of ACTIVE_RUNTIME?.socketsForUser?.(targetProfile.id)||[]) client.emit('dm-message',message);
  });


  socket.on('dm-recovery-sync',async({messages},ack)=>{
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

      const recoveredMessage={
        id:messageId,
        fromUserId,
        toUserId,
        fromUsername:socket.data.username||'Usuário',
        text:safeText,
        at:Number(raw?.at||Date.now())
      };

      directMessages.push(recoveredMessage);
      trimDmConversation(fromUserId,toUserId,500);
      await persistDmMessage(recoveredMessage);
      added++;
    }

    reply({ok:true,added});
  });

  function emitChatMessageToServerMembers(serverData,message){
    if(!serverData || !message) return;

    const room='server:'+String(serverData.id || '');

    // Persistência vem primeiro: a mensagem já foi salva no histórico.
    // Esta etapa apenas atualiza em tempo real quem estiver conectado agora.
    const eligible=new Set(serverSockets(serverData).map(client=>client.id));
    for(const client of serverSockets(serverData)){
      if(!client.rooms.has(room)) client.join(room);
    }
    for(const socketId of ACTIVE_RUNTIME?.roomSockets?.get(room)||[]){
      if(!eligible.has(socketId)) ACTIVE_RUNTIME?.sockets?.get(socketId)?.leave(room);
    }

    io.to(room).emit('chat-message',message);
  }

  socket.on('public-chat-history', ({ serverId, channelId, before, limit }) => {
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

    const beforeAt=Number(before||Number.MAX_SAFE_INTEGER);
    const page=ACTIVE_RUNTIME?.getChatHistory(
      safeServerId,
      safeChannelId,
      {before:beforeAt,limit:Math.min(100,Math.max(20,Number(limit)||80))}
    ) || {
      messages:(serverData.messages.get(safeChannelId)||[]).slice(-80),
      hasMore:false
    };

    socket.emit('public-chat-history',{
      serverId:safeServerId,
      channelId:safeChannelId,
      messages:page.messages,
      hasMore:!!page.hasMore,
      before:Number.isFinite(Number(before))?Number(before):null
    });
  });

  function canUseTextChannel(serverData,socket,channelId){
    const policy=serverData?.channelPolicies?.[channelId]||{};
    if(!policy.roleId) return true;
    if(serverData.ownerId===socket.data.userId) return true;
    return userRoles(serverData,socket).some(role=>role.id===policy.roleId);
  }

  socket.on('public-chat-message', async ({ serverId, channelId, text, attachment, replyTo, confirmedEveryone }) => {
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
    const rawAttachment=
      attachment && /^data:[^;]+;base64,/i.test(data) && data.length<=1200000
        ? {
            name:String(attachment.name||'arquivo').slice(0,100),
            type:String(attachment.type||'application/octet-stream').slice(0,100),
            data
          }
        : null;
    if(!safeText&&!rawAttachment)return;

    const mentions=[...safeText.matchAll(/@([\\wÀ-ÿ._-]{2,30})/g)]
      .map(match=>match[1])
      .slice(0,20);

    const messageId=id();
    let safeAttachment=null;

    if(rawAttachment){
      const mediaUrl=await ACTIVE_RUNTIME?.putMediaDataUrl(
        'message:'+messageId+':attachment',
        rawAttachment.data
      );

      safeAttachment={
        name:rawAttachment.name,
        type:rawAttachment.type,
        data:mediaUrl || rawAttachment.data
      };
    }

    const message={
      id:messageId,
      serverId:safeServerId,
      channelId:safeChannelId,
      userId:socket.data.userId,
      username:socket.data.username||'Usuário',
      text:safeText,
      attachment:safeAttachment,
      replyTo:String(replyTo||'').slice(0,80)||null,
      reactions:{},
      mentions,
      at:Date.now(),
      edited:false
    };

    const history=serverData.messages.get(safeChannelId)||[];
    history.push(message);
    if(history.length>400)history.splice(0,history.length-400);
    serverData.messages.set(safeChannelId,history);

    await persistChatMessage(message);

    emitToServerMembers(serverData,'public-chat-message',message);
  });

  socket.on('mega-edit-public',async({serverId,channelId,messageId,text})=>{
    const safeServerId=String(serverId||'').slice(0,80);
    const safeChannelId=String(channelId||'').slice(0,80);
    const s=servers.get(safeServerId);
    if(!s||!requireServerAccess(s,socket))return;
    const history=s.messages.get(safeChannelId)||[];
    let message=history.find(m=>m.id===String(messageId||''));
    if(!message) message=ACTIVE_RUNTIME?.getChatMessage(String(messageId||''));
    if(!message||message.serverId!==safeServerId||message.channelId!==safeChannelId||message.userId!==socket.data.userId)return;
    message.text=String(text||'').trim().slice(0,2000);
    message.edited=true;
    ACTIVE_RUNTIME?.rememberChatMessages(safeServerId,safeChannelId,[message]);
    await persistChatMessage(message);
    emitToServerMembers(s,'public-chat-message-edited',message);
  });

  socket.on('mega-delete-public',async({serverId,channelId,messageId})=>{
    const safeServerId=String(serverId||'').slice(0,80);
    const safeChannelId=String(channelId||'').slice(0,80);
    const s=servers.get(safeServerId);
    if(!s||!requireServerAccess(s,socket))return;
    const history=s.messages.get(safeChannelId)||[];
    const index=history.findIndex(m=>m.id===String(messageId||''));
    const message=index>=0?history[index]:ACTIVE_RUNTIME?.getChatMessage(String(messageId||''));
    if(!message||message.serverId!==safeServerId||message.channelId!==safeChannelId)return;
    if(message.userId!==socket.data.userId&&!hasServerPermission(s,socket,'manageServer'))return;
    if(index>=0)history.splice(index,1);
    await deletePersistedChatMessage(message);
    emitToServerMembers(s,'public-chat-message-deleted',{serverId:safeServerId,channelId:safeChannelId,messageId});
  });

  socket.on('mega-pin-message',({serverId,channelId,messageId})=>{
    const s=servers.get(String(serverId||''));if(!s||!requireServerAccess(s,socket))return;
    const ref={channelId:String(channelId||''),messageId:String(messageId||'')};
    const exists=(s.pinned||[]).some(p=>p.channelId===ref.channelId&&p.messageId===ref.messageId);
    if(!exists)s.pinned=[...(s.pinned||[]),ref].slice(-200);
    saveServersToDisk();broadcastServerUpdate(s);
  });


  socket.on('join-text', async ({ serverId, channelId },ack) => {
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

    const page=ACTIVE_RUNTIME?.getChatHistory(
      safeServerId,
      safeChannelId,
      {limit:80}
    ) || {messages:(s.messages.get(safeChannelId)||[]).slice(-80),hasMore:false};
    const history=page.messages;

    socket.emit('text-history',{
      serverId:safeServerId,
      channelId:safeChannelId,
      history,
      hasMore:!!page.hasMore
    });

    reply({
      ok:true,
      serverId:safeServerId,
      channelId:safeChannelId,
      history,
      hasMore:!!page.hasMore
    });
  });

  socket.on('chat-message', async ({ serverId, channelId, text, replyTo, attachment, clientNonce },ack) => {
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
    const rawAttachment=
      attachment &&
      String(attachment.type||'').startsWith('image/') &&
      String(attachment.data||'').startsWith('data:image/') &&
      String(attachment.data||'').length<=1200000
        ? {
            name:String(attachment.name||'imagem').slice(0,80),
            type:String(attachment.type||'').slice(0,80),
            data:String(attachment.data||'')
          }
        : null;

    if(!cleanText && !rawAttachment){
      reply({ok:false,error:'Mensagem vazia'});
      return;
    }

    const messageId=id();
    let safeAttachment=null;

    if(rawAttachment){
      const mediaUrl=await ACTIVE_RUNTIME?.putMediaDataUrl(
        'message:'+messageId+':attachment',
        rawAttachment.data
      );
      safeAttachment={
        name:rawAttachment.name,
        type:rawAttachment.type,
        data:mediaUrl || rawAttachment.data
      };
    }

    const history=s.messages.get(safeChannelId)||[];
    const message={
      id:messageId,
      serverId:safeServerId,
      channelId:safeChannelId,
      senderId:socket.id,
      userId:socket.data.userId,
      username:socket.data.username||'Usuário',
      text:cleanText,
      attachment:safeAttachment,
      clientNonce:String(clientNonce||'').slice(0,100)||null,
      replyTo:String(replyTo||'').slice(0,80)||null,
      reactions:{},
      at:Date.now(),
      edited:false
    };
    history.push(message);
    if(history.length>400) history.splice(0,history.length-400);
    s.messages.set(safeChannelId,history);
    await persistChatMessage(message);

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

  socket.on('chat-edit',async({serverId,channelId,messageId,text})=>{
    const safeServerId=String(serverId||'').slice(0,80);
    const safeChannelId=String(channelId||'').slice(0,80);
    const s=servers.get(safeServerId);
    if(!s || !requireServerAccess(s,socket)) return;
    const history=s.messages.get(safeChannelId)||[];
    let message=history.find(item=>item.id===String(messageId||''));
    if(!message) message=ACTIVE_RUNTIME?.getChatMessage(String(messageId||''));
    if(!message || message.serverId!==safeServerId || message.channelId!==safeChannelId || message.userId!==socket.data.userId) return;
    message.text=String(text||'').trim().slice(0,2000);
    message.edited=true;
    ACTIVE_RUNTIME?.rememberChatMessages(safeServerId,safeChannelId,[message]);
    await persistChatMessage(message);

    emitToServerMembers(s,'chat-message-updated',message);
  });

  socket.on('chat-delete',async({serverId,channelId,messageId})=>{
    const safeServerId=String(serverId||'').slice(0,80);
    const safeChannelId=String(channelId||'').slice(0,80);
    const s=servers.get(safeServerId);
    if(!s || !requireServerAccess(s,socket)) return;
    const history=s.messages.get(safeChannelId)||[];
    const index=history.findIndex(item=>item.id===String(messageId||''));
    const message=index>=0?history[index]:ACTIVE_RUNTIME?.getChatMessage(String(messageId||''));
    if(!message||message.serverId!==safeServerId||message.channelId!==safeChannelId) return;
    const canManage=message.userId===socket.data.userId || hasServerPermission(s,socket,'manageServer');
    if(!canManage) return;
    if(index>=0)history.splice(index,1);
    await deletePersistedChatMessage(message);

    emitToServerMembers(s,'chat-message-deleted',{serverId:safeServerId,channelId:safeChannelId,messageId});
  });

  socket.on('chat-react',async({serverId,channelId,messageId,emoji})=>{
    const safeServerId=String(serverId||'').slice(0,80);
    const safeChannelId=String(channelId||'').slice(0,80);
    const s=servers.get(safeServerId);
    if(!s || !requireServerAccess(s,socket)) return;
    const allowed=['👍','❤️','😂','🔥','😮','😢'];
    if(!allowed.includes(emoji)) return;
    const history=s.messages.get(safeChannelId)||[];
    let message=history.find(item=>item.id===String(messageId||''));
    if(!message) message=ACTIVE_RUNTIME?.getChatMessage(String(messageId||''));
    if(!message||message.serverId!==safeServerId||message.channelId!==safeChannelId) return;
    message.reactions=message.reactions||{};
    const users=new Set(message.reactions[emoji]||[]);
    if(users.has(socket.data.userId)) users.delete(socket.data.userId);
    else users.add(socket.data.userId);
    message.reactions[emoji]=[...users].slice(0,500);
    ACTIVE_RUNTIME?.rememberChatMessages(safeServerId,safeChannelId,[message]);
    await persistChatMessage(message);

    emitToServerMembers(s,'chat-message-updated',message);
  });

  function leaveVoiceRoom() {
    const room = socket.data.voiceRoom;
    if (!room) return;

    cleanupSharedControlForSocket(room,socket.id);
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
    profile.updatedAt=Date.now();
    saveServersToDisk();
    socket.emit('profile-extra-updated',publicProfile(profile));
    emitAccountState(socket);
    broadcastOnlineUsers();
  });

  socket.on('mega-server-settings',async payload=>{
    const s=servers.get(String(payload?.serverId||''));if(!s||!requireServerAccess(s,socket))return;
    if(!hasServerPermission(s,socket,'manageServer')){permissionDenied(socket);return}
    s.rules=String(payload?.rules||'').slice(0,4000);
    if(typeof payload?.banner==='string'&&payload.banner.length<=1200000){
      const rawBanner=payload.banner;
      s.banner=rawBanner.startsWith('data:')
        ? (await ACTIVE_RUNTIME?.putMediaDataUrl('server:'+s.id+':banner',rawBanner) || rawBanner)
        : rawBanner;
    }
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
    saveServersToDisk();broadcastServerLists(s,{extraUserIds:[userId]});broadcastServerUpdate(s);
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
    emitToServerMembers(s,'mega-watch-state',{serverId:s.id,watchParty:s.watchParty});
  });

  socket.on('mega-whiteboard-stroke',payload=>{
    const s=servers.get(String(payload?.serverId||''));if(!s||!requireServerAccess(s,socket))return;
    const stroke=payload?.stroke;
    if(!stroke?.from||!stroke?.to)return;
    const safe={from:{x:Number(stroke.from.x),y:Number(stroke.from.y)},to:{x:Number(stroke.to.x),y:Number(stroke.to.y)}};
    if(![safe.from.x,safe.from.y,safe.to.x,safe.to.y].every(Number.isFinite))return;
    s.whiteboard=[...(s.whiteboard||[]),safe].slice(-2000);
    emitToServerMembers(s,'mega-whiteboard-stroke',{serverId:s.id,stroke:safe},{excludeId:socket.id});
  });

  socket.on('mega-whiteboard-get',({serverId})=>{
    const s=servers.get(String(serverId||''));if(!s||!requireServerAccess(s,socket))return;
    socket.emit('mega-whiteboard-state',{serverId:s.id,strokes:s.whiteboard||[]});
  });

  socket.on('mega-whiteboard-clear',({serverId})=>{
    const s=servers.get(String(serverId||''));if(!s||!requireServerAccess(s,socket))return;
    s.whiteboard=[];saveServersToDisk();
    emitToServerMembers(s,'mega-whiteboard-state',{serverId:s.id,strokes:[]});
  });

  socket.on('mega-recording-notice',({serverId})=>{
    const s=servers.get(String(serverId||''));if(!s||!requireServerAccess(s,socket))return;
    emitToServerMembers(s,'mega-recording-notice',{serverId:s.id,username:socket.data.username||'Usuário'},{excludeId:socket.id});
  });

  socket.on('mega-call-file',payload=>{
    const s=servers.get(String(payload?.serverId||''));if(!s||!requireServerAccess(s,socket))return;
    const data=String(payload?.data||'');if(!/^data:[^;]+;base64,/i.test(data)||data.length>600000)return;
    const message={serverId:s.id,username:socket.data.username||'Usuário',name:String(payload?.name||'arquivo').slice(0,100),type:String(payload?.type||'application/octet-stream').slice(0,100),data};
    emitToServerMembers(s,'mega-call-file',message,{excludeId:socket.id});
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

    emitToServerMembers(s,'public-chat-message',message);

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

  socket.on('essential-sessions',({token}={},ack)=>{
    const reply=typeof ack==='function'?ack:()=>{};
    const rawToken=String(token||'');
    const currentHash=rawToken
      ? tokenHash(rawToken)
      : String(socket.data.sessionHash||'');
    const currentSession=currentHash?sessions.get(currentHash):null;
    const userId=rawToken
      ? sessionUserId(rawToken,{renew:false})
      : currentSession?.userId;

    if(!userId||userId!==socket.data.userId||!currentSession){
      reply({ok:false,error:'Sessão inválida'});
      return;
    }

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

  socket.on('essential-revoke-other-sessions',({token}={},ack)=>{
    const reply=typeof ack==='function'?ack:()=>{};
    const rawToken=String(token||'');
    const currentHash=rawToken
      ? tokenHash(rawToken)
      : String(socket.data.sessionHash||'');
    const currentSession=currentHash?sessions.get(currentHash):null;
    const userId=rawToken
      ? sessionUserId(rawToken,{renew:false})
      : currentSession?.userId;

    if(!userId||userId!==socket.data.userId||!currentSession){
      reply({ok:false,error:'Sessão inválida'});
      return;
    }

    let revoked=0;

    for(const [hash,session] of [...sessions.entries()]){
      if(session.userId===userId&&hash!==currentHash){
        sessions.delete(hash);
        revoked+=1;
      }
    }

    saveServersToDisk();
    recordSecurityAudit(socket,'session-revoke-others',String(userId||''),'ok','revoked='+revoked);
    reply({ok:true,revoked});
  });

  socket.on('essential-change-password',({token,oldPassword,newPassword}={},ack)=>{
    const reply=typeof ack==='function'?ack:()=>{};
    const rawToken=String(token||'');
    const currentHash=rawToken
      ? tokenHash(rawToken)
      : String(socket.data.sessionHash||'');
    const currentSession=currentHash?sessions.get(currentHash):null;
    const userId=rawToken
      ? sessionUserId(rawToken,{renew:false})
      : currentSession?.userId;
    const account=userId?accounts.get(userId):null;

    if(!userId||userId!==socket.data.userId||!account||!currentSession){
      reply({ok:false,error:'Sessão inválida'});
      return;
    }

    if(account.recoveredSessionOnly){
      reply({ok:false,error:'Faça login novamente antes de alterar a senha'});
      return;
    }

    if(!verifyAccountPassword(String(oldPassword||''),account)){
      recordSecurityAudit(socket,'password-change',String(userId||''),'denied','bad-current-password');
      reply({ok:false,error:'Senha atual incorreta'});
      return;
    }

    const safeNew=String(newPassword||'');
    if(safeNew.length<8||safeNew.length>128){
      reply({ok:false,error:'A nova senha precisa ter entre 8 e 128 caracteres'});
      return;
    }

    const salt=crypto.randomBytes(16).toString('hex');
    account.salt=salt;
    account.passwordHash=passwordDigest(safeNew,salt);
    account.recoveredSessionOnly=false;

    for(const [hash,session] of [...sessions.entries()]){
      if(session.userId===userId&&hash!==currentHash)sessions.delete(hash);
    }

    saveServersToDisk();
    recordSecurityAudit(socket,'password-change',String(userId||''),'ok','other-sessions-revoked');
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

    for(const userId of allowedUserIds){
      for(const client of ACTIVE_RUNTIME?.socketsForUser?.(userId)||[]){
        if(client.id===socket.id) continue;
        client.emit('incoming-private-group-call',{
          callId,groupId:safeGroupId,groupName:group.name || 'Grupo privado',
          fromUserId:socket.data.userId,fromUsername:socket.data.username || 'Usuário'
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

    const targetProfile=targetUserId
      ? profiles.get(String(targetUserId||'').slice(0,100))
      : findProfileByUsername(targetUsername);
    const target=(targetProfile
      ? (ACTIVE_RUNTIME?.socketsForUser?.(targetProfile.id)||[])
      : []
    ).find(candidate=>candidate.id!==socket.id) || null;

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
    broadcastServerLists(s,{extraUserIds:[targetId]});
    for(const client of ACTIVE_RUNTIME?.socketsForUser?.(targetId)||[]) client.emit('removed-from-server',{serverId});
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
    if(socket.data.voiceRoom) cleanupSharedControlForSocket(socket.data.voiceRoom,socket.id);
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
    this.roomSockets=new Map();
    this.userSockets=new Map();
    this.persistChain=Promise.resolve();
    this.persistScheduled=null;
    this.persistDirty=false;
    this.lastPersistAt=0;
    this.lastPersistError='';
    this.sqlReady=false;
    this.recoverySigningKey='';
    ACTIVE_RUNTIME=this;
    io=createIoCompat(this);

    ctx.blockConcurrencyWhile(async()=>{
      this.prepareSql();
      await this.ensureRecoverySigningKey();
      const loaded=await this.loadSnapshot();
      await this.migrateLegacyHistories();
      if(loaded){
        await this.queuePersist();
      }
      this.rebuildSockets();
    });
  }

  addSocketToRoom(socket,room){
    const key=String(room||'');
    if(!key || !socket?.id) return;
    if(!this.roomSockets.has(key)) this.roomSockets.set(key,new Set());
    this.roomSockets.get(key).add(socket.id);
  }

  removeSocketFromRoom(socket,room){
    const key=String(room||'');
    const set=this.roomSockets.get(key);
    if(!set) return;
    set.delete(socket?.id);
    if(!set.size) this.roomSockets.delete(key);
  }

  updateSocketUser(socket,previousUserId,nextUserId){
    const previous=String(previousUserId||'');
    const next=String(nextUserId||'');
    if(previous){
      const set=this.userSockets.get(previous);
      set?.delete(socket?.id);
      if(set && !set.size) this.userSockets.delete(previous);
    }
    if(next && socket?.id){
      if(!this.userSockets.has(next)) this.userSockets.set(next,new Set());
      this.userSockets.get(next).add(socket.id);
    }
  }

  indexSocket(socket){
    if(!socket?.id) return;
    for(const room of socket.rooms) this.addSocketToRoom(socket,room);
    this.updateSocketUser(socket,'',socket.data?.userId);
  }

  unindexSocket(socket){
    if(!socket?.id) return;
    for(const room of socket.rooms) this.removeSocketFromRoom(socket,room);
    this.updateSocketUser(socket,socket.data?.userId,'');
  }

  socketsForUser(userId){
    const ids=this.userSockets.get(String(userId||''));
    if(!ids) return [];
    return [...ids].map(id=>this.sockets.get(id)).filter(Boolean);
  }

  cleanupEphemeralState(){
    const now=Date.now();
    for(const [hash,session] of sessions){
      if(Number(session?.expiresAt||0)<now-SESSION_GRACE_MS) sessions.delete(hash);
    }
    for(const [callId,call] of privateCalls){
      if(Number(call?.expiresAt||0)<=now) privateCalls.delete(callId);
    }
    for(const [token,session] of phoneCameraSessions){
      if(Number(session?.expiresAt||0)<=now) phoneCameraSessions.delete(token);
    }
    for(const [roomKey,room] of sharedControlRooms){
      if(room?.request && Number(room.request.expiresAt||0)<=now) room.request=null;
      if(room?.grants instanceof Map){
        for(const [peerId,grant] of room.grants){
          if(Number(grant?.expiresAt||0)<=now) room.grants.delete(peerId);
        }
      }
      if(!room?.hostSocketId && !room?.request && !(room?.grants?.size)) sharedControlRooms.delete(roomKey);
    }
    try{this.ctx.storage.sql.exec(`DELETE FROM auth_rate WHERE updated_at<?`,now-(24*60*60*1000));}catch{}
  }

  prepareSql(){
    if(this.sqlReady) return;
    const sql=this.ctx.storage.sql;

    sql.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        text TEXT NOT NULL,
        reply_to TEXT,
        attachment_json TEXT,
        reactions_json TEXT,
        mentions_json TEXT,
        client_nonce TEXT,
        at INTEGER NOT NULL,
        edited INTEGER NOT NULL DEFAULT 0
      )
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_chat_channel_at ON chat_messages(server_id,channel_id,at)`);

    sql.exec(`
      CREATE TABLE IF NOT EXISTS dm_messages (
        id TEXT PRIMARY KEY,
        from_user_id TEXT NOT NULL,
        to_user_id TEXT NOT NULL,
        from_username TEXT NOT NULL,
        text TEXT NOT NULL,
        at INTEGER NOT NULL
      )
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_dm_users_at ON dm_messages(from_user_id,to_user_id,at)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_dm_reverse_at ON dm_messages(to_user_id,from_user_id,at)`);

    sql.exec(`
      CREATE TABLE IF NOT EXISTS group_messages (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        text TEXT NOT NULL,
        at INTEGER NOT NULL
      )
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_group_at ON group_messages(group_id,at)`);

    sql.exec(`
      CREATE TABLE IF NOT EXISTS media_objects (
        media_key TEXT PRIMARY KEY,
        mime TEXT NOT NULL,
        data_url TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_media_updated_at ON media_objects(updated_at)`);

    sql.exec(`
      CREATE TABLE IF NOT EXISTS auth_rate (
        rate_key TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        blocked_until INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_auth_rate_updated_at ON auth_rate(updated_at)`);

    this.sqlReady=true;
  }

  async ensureRecoverySigningKey(){
    try{
      let key=await this.ctx.storage.get('recovery-signing-key-v1');
      if(!key){
        key=crypto.randomBytes(32).toString('hex');
        await this.ctx.storage.put('recovery-signing-key-v1',key);
      }
      this.recoverySigningKey=String(key||'');
    }catch(error){
      console.error('Falha ao preparar chave de recuperação:',error);
      this.recoverySigningKey='';
    }
  }

  issueRecoveryProof(userId,username){
    const uid=String(userId||'').slice(0,100);
    const key=usernameKey(username);
    if(!uid||!key||!this.recoverySigningKey) return '';
    return crypto.createHmac('sha256',this.recoverySigningKey)
      .update('acord-recovery-v1|'+uid+'|'+key)
      .digest('hex');
  }

  verifyRecoveryProof(recovery){
    try{
      const proof=String(recovery?.recoveryProof||'');
      const expected=this.issueRecoveryProof(recovery?.userId,recovery?.username);
      if(!proof||!expected||proof.length!==expected.length) return false;
      return crypto.timingSafeEqual(Buffer.from(proof,'hex'),Buffer.from(expected,'hex'));
    }catch{return false}
  }

  issueMediaSignature(mediaKey){
    const key=String(mediaKey||'').slice(0,220);
    if(!key||!this.recoverySigningKey) return '';
    return crypto.createHmac('sha256',this.recoverySigningKey)
      .update('acord-media-v1|'+key)
      .digest('hex');
  }

  verifyMediaSignature(mediaKey,signature){
    try{
      const sig=String(signature||'');
      const expected=this.issueMediaSignature(mediaKey);
      if(!sig||!expected||sig.length!==expected.length) return false;
      return crypto.timingSafeEqual(Buffer.from(sig,'hex'),Buffer.from(expected,'hex'));
    }catch{return false}
  }

  signedMediaUrl(value){
    const raw=String(value||'');
    if(!raw.startsWith('/api/media/') || raw.includes('sig=')) return raw;
    try{
      const parsed=new URL(raw,'https://acord.local');
      const key=decodeURIComponent(parsed.pathname.slice('/api/media/'.length));
      if(!key.startsWith('message:')) return raw;
      const sig=this.issueMediaSignature(key);
      if(!sig) return raw;
      parsed.searchParams.set('sig',sig);
      return parsed.pathname+parsed.search;
    }catch{return raw}
  }

  authRateKey(socket,username){
    const ip=String(socket?.data?.clientIp||'unknown').slice(0,100);
    const user=usernameKey(normalizeAccountUsername(username))||'unknown';
    return crypto.createHash('sha256').update(ip+'|'+user).digest('hex');
  }

  allowAuthAttempt(socket,username){
    this.prepareSql();
    const rateKey=this.authRateKey(socket,username);
    const now=Date.now();
    const windowMs=5*60*1000;
    const rows=[...this.ctx.storage.sql.exec(
      `SELECT window_start,attempts,blocked_until FROM auth_rate WHERE rate_key=? LIMIT 1`,
      rateKey
    )];
    let windowStart=Number(rows[0]?.window_start||now);
    let attempts=Number(rows[0]?.attempts||0);
    const blockedUntil=Number(rows[0]?.blocked_until||0);

    if(blockedUntil>now){
      return {ok:false,retryAfterMs:blockedUntil-now,rateKey};
    }

    if(now-windowStart>windowMs){
      windowStart=now;
      attempts=0;
    }

    attempts+=1;
    let nextBlocked=0;
    if(attempts>10){
      const exponent=Math.min(4,Math.max(0,attempts-11));
      nextBlocked=now+(60*1000*(2**exponent));
    }

    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO auth_rate(rate_key,window_start,attempts,blocked_until,updated_at) VALUES (?,?,?,?,?)`,
      rateKey,windowStart,attempts,nextBlocked,now
    );

    // Limpeza oportunista para não acumular chaves antigas.
    if(Math.random()<0.02){
      this.ctx.storage.sql.exec(`DELETE FROM auth_rate WHERE updated_at<?`,now-(24*60*60*1000));
    }

    return {ok:nextBlocked===0,retryAfterMs:Math.max(0,nextBlocked-now),rateKey};
  }

  resetAuthAttempts(socket,username){
    try{
      this.prepareSql();
      this.ctx.storage.sql.exec(`DELETE FROM auth_rate WHERE rate_key=?`,this.authRateKey(socket,username));
    }catch{}
  }

  rowToChatMessage(row){
    if(!row) return null;
    let attachment=null,reactions={},mentions=[];
    try{attachment=row.attachment_json?JSON.parse(row.attachment_json):null}catch{}
    if(attachment?.data) attachment={...attachment,data:this.signedMediaUrl(attachment.data)};
    try{reactions=row.reactions_json?JSON.parse(row.reactions_json):{}}catch{}
    try{mentions=row.mentions_json?JSON.parse(row.mentions_json):[]}catch{}
    return {
      id:String(row.id||''),
      serverId:String(row.server_id||''),
      channelId:String(row.channel_id||''),
      userId:String(row.user_id||''),
      username:String(row.username||'Usuário'),
      text:String(row.text||''),
      replyTo:row.reply_to?String(row.reply_to):null,
      attachment,
      reactions:reactions&&typeof reactions==='object'?reactions:{},
      mentions:Array.isArray(mentions)?mentions:[],
      clientNonce:row.client_nonce?String(row.client_nonce):null,
      at:Number(row.at||0),
      edited:!!row.edited
    };
  }

  rememberChatMessages(serverId,channelId,messages){
    const serverData=servers.get(String(serverId||''));
    if(!serverData) return;
    const existing=serverData.messages.get(String(channelId||''))||[];
    const byId=new Map(existing.map(message=>[message.id,message]));
    for(const message of messages||[]){
      if(message?.id) byId.set(message.id,message);
    }
    const merged=[...byId.values()]
      .sort((a,b)=>Number(a.at||0)-Number(b.at||0))
      .slice(-400);
    serverData.messages.set(String(channelId||''),merged);
  }

  async persistChatMessage(message){
    try{
      this.prepareSql();
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO chat_messages
          (id,server_id,channel_id,user_id,username,text,reply_to,attachment_json,reactions_json,mentions_json,client_nonce,at,edited)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        String(message.id||''),
        String(message.serverId||''),
        String(message.channelId||''),
        String(message.userId||''),
        String(message.username||'Usuário'),
        String(message.text||''),
        message.replyTo?String(message.replyTo):null,
        message.attachment?JSON.stringify(message.attachment):null,
        JSON.stringify(message.reactions||{}),
        JSON.stringify(message.mentions||[]),
        message.clientNonce?String(message.clientNonce):null,
        Number(message.at||Date.now()),
        message.edited?1:0
      );
      return true;
    }catch(error){
      this.lastPersistError=String(error?.message||error);
      console.error('Falha ao persistir mensagem pública:',error);
      return false;
    }
  }

  async deleteChatMessage(message){
    try{
      this.prepareSql();
      const safeId=String(message.id||'');
      this.ctx.storage.sql.exec(`DELETE FROM chat_messages WHERE id=?`,safeId);
      this.deleteMediaPrefix('message:'+safeId+':');
      return true;
    }catch(error){
      this.lastPersistError=String(error?.message||error);
      return false;
    }
  }

  getChatHistory(serverId,channelId,{before=Number.MAX_SAFE_INTEGER,limit=100}={}){
    this.prepareSql();
    const safeLimit=Math.max(1,Math.min(100,Number(limit)||100));
    const rows=[...this.ctx.storage.sql.exec(
      `SELECT * FROM chat_messages
       WHERE server_id=? AND channel_id=? AND at<?
       ORDER BY at DESC
       LIMIT ?`,
      String(serverId||''),
      String(channelId||''),
      Number(before)||Number.MAX_SAFE_INTEGER,
      safeLimit+1
    )];
    const hasMore=rows.length>safeLimit;
    const messages=rows.slice(0,safeLimit).reverse().map(row=>this.rowToChatMessage(row)).filter(Boolean);
    this.rememberChatMessages(serverId,channelId,messages);
    return {messages,hasMore};
  }

  getChatMessage(messageId){
    this.prepareSql();
    const rows=[...this.ctx.storage.sql.exec(
      `SELECT * FROM chat_messages WHERE id=? LIMIT 1`,
      String(messageId||'')
    )];
    return this.rowToChatMessage(rows[0]);
  }

  async persistDmMessage(message){
    try{
      this.prepareSql();
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO dm_messages
          (id,from_user_id,to_user_id,from_username,text,at)
         VALUES (?,?,?,?,?,?)`,
        String(message.id||''),
        String(message.fromUserId||''),
        String(message.toUserId||''),
        String(message.fromUsername||'Usuário'),
        String(message.text||''),
        Number(message.at||Date.now())
      );
      return true;
    }catch(error){
      this.lastPersistError=String(error?.message||error);
      return false;
    }
  }

  getDmHistory(userA,userB,limit=500){
    this.prepareSql();
    const safeLimit=Math.max(1,Math.min(500,Number(limit)||500));
    const rows=[...this.ctx.storage.sql.exec(
      `SELECT * FROM dm_messages
       WHERE (from_user_id=? AND to_user_id=?)
          OR (from_user_id=? AND to_user_id=?)
       ORDER BY at DESC
       LIMIT ?`,
      String(userA||''),String(userB||''),
      String(userB||''),String(userA||''),
      safeLimit
    )];
    return rows.reverse().map(row=>({
      id:String(row.id||''),
      fromUserId:String(row.from_user_id||''),
      toUserId:String(row.to_user_id||''),
      fromUsername:String(row.from_username||'Usuário'),
      text:String(row.text||''),
      at:Number(row.at||0)
    }));
  }

  async persistGroupMessage(message){
    try{
      this.prepareSql();
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO group_messages
          (id,group_id,user_id,username,text,at)
         VALUES (?,?,?,?,?,?)`,
        String(message.id||''),
        String(message.groupId||''),
        String(message.userId||''),
        String(message.username||'Usuário'),
        String(message.text||''),
        Number(message.at||Date.now())
      );
      return true;
    }catch(error){
      this.lastPersistError=String(error?.message||error);
      return false;
    }
  }

  getGroupHistory(groupId,limit=300){
    this.prepareSql();
    const safeLimit=Math.max(1,Math.min(500,Number(limit)||300));
    const rows=[...this.ctx.storage.sql.exec(
      `SELECT * FROM group_messages
       WHERE group_id=?
       ORDER BY at DESC
       LIMIT ?`,
      String(groupId||''),safeLimit
    )];
    return rows.reverse().map(row=>({
      id:String(row.id||''),
      groupId:String(row.group_id||''),
      userId:String(row.user_id||''),
      username:String(row.username||'Usuário'),
      text:String(row.text||''),
      at:Number(row.at||0)
    }));
  }

  async putMediaDataUrl(mediaKey,dataUrl){
    const value=String(dataUrl||'');
    const match=value.match(/^data:([^;,]+);base64,(.+)$/is);
    if(!match || value.length>1800000) return '';
    try{
      this.prepareSql();
      const safeKey=String(mediaKey||'').slice(0,220);
      const mime=String(match[1]||'application/octet-stream').slice(0,100);
      let storedValue=value;

      // Quando MEDIA_BUCKET estiver ligado no Cloudflare, novos objetos saem do
      // SQLite e vão para R2. O banco mantém somente metadados/ponte de leitura.
      if(this.env?.MEDIA_BUCKET?.put){
        const binary=atob(match[2]);
        const bytes=new Uint8Array(binary.length);
        for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
        const objectKey='media/'+crypto.createHash('sha256').update(safeKey).digest('hex');
        await this.env.MEDIA_BUCKET.put(objectKey,bytes,{httpMetadata:{contentType:mime}});
        storedValue='r2:'+objectKey;
      }

      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO media_objects(media_key,mime,data_url,updated_at)
         VALUES (?,?,?,?)`,
        safeKey,
        mime,
        storedValue,
        Date.now()
      );
      const signature=safeKey.startsWith('message:')?this.issueMediaSignature(safeKey):'';
      return '/api/media/'+encodeURIComponent(safeKey)+'?v='+Date.now()+(signature?'&sig='+encodeURIComponent(signature):'');
    }catch(error){
      this.lastPersistError=String(error?.message||error);
      return '';
    }
  }

  getMedia(mediaKey){
    this.prepareSql();
    const rows=[...this.ctx.storage.sql.exec(
      `SELECT mime,data_url FROM media_objects WHERE media_key=? LIMIT 1`,
      String(mediaKey||'').slice(0,220)
    )];
    return rows[0]||null;
  }

  deleteMediaPrefix(prefix){
    try{
      this.prepareSql();
      this.ctx.storage.sql.exec(
        `DELETE FROM media_objects WHERE media_key LIKE ?`,
        String(prefix||'').slice(0,180)+'%'
      );
    }catch{}
  }

  deleteServerData(serverId){
    try{
      this.prepareSql();
      const safeId=String(serverId||'').slice(0,80);
      const rows=[...this.ctx.storage.sql.exec(
        `SELECT id FROM chat_messages WHERE server_id=?`,
        safeId
      )];
      for(const row of rows){
        if(row?.id) this.deleteMediaPrefix('message:'+String(row.id)+':');
      }
      this.ctx.storage.sql.exec(`DELETE FROM chat_messages WHERE server_id=?`,safeId);
      this.deleteMediaPrefix('server:'+safeId+':');
    }catch{}
  }

  deleteChannelData(serverId,channelId){
    try{
      this.prepareSql();
      const safeServerId=String(serverId||'').slice(0,80);
      const safeChannelId=String(channelId||'').slice(0,80);
      const rows=[...this.ctx.storage.sql.exec(
        `SELECT id FROM chat_messages WHERE server_id=? AND channel_id=?`,
        safeServerId,safeChannelId
      )];
      for(const row of rows){
        if(row?.id) this.deleteMediaPrefix('message:'+String(row.id)+':');
      }
      this.ctx.storage.sql.exec(
        `DELETE FROM chat_messages WHERE server_id=? AND channel_id=?`,
        safeServerId,
        safeChannelId
      );
    }catch{}
  }

  deleteAccountData(userId){
    try{
      this.prepareSql();
      const safeId=String(userId||'').slice(0,100);
      this.ctx.storage.sql.exec(
        `DELETE FROM dm_messages WHERE from_user_id=? OR to_user_id=?`,
        safeId,safeId
      );
      this.ctx.storage.sql.exec(
        `DELETE FROM group_messages WHERE user_id=?`,
        safeId
      );
      this.deleteMediaPrefix('profile:'+safeId+':');
    }catch{}
  }

  deleteGroupData(groupId){
    try{
      this.prepareSql();
      this.ctx.storage.sql.exec(
        `DELETE FROM group_messages WHERE group_id=?`,
        String(groupId||'').slice(0,80)
      );
    }catch{}
  }

  async migrateInlineMedia(){
    const migrate=async(key,value,setter)=>{
      if(!String(value||'').startsWith('data:')) return;
      const url=await this.putMediaDataUrl(key,value);
      if(url) setter(url);
    };

    for(const profile of profiles.values()){
      await migrate('profile:'+profile.id+':avatar',profile.avatar,url=>{profile.avatar=url});
      await migrate('profile:'+profile.id+':banner',profile.banner,url=>{profile.banner=url});
    }

    for(const serverData of servers.values()){
      await migrate('server:'+serverData.id+':icon',serverData.icon,url=>{serverData.icon=url});
      await migrate('server:'+serverData.id+':banner',serverData.banner,url=>{serverData.banner=url});
    }
  }

  async migrateLegacyHistories(){
    this.prepareSql();

    for(const serverData of servers.values()){
      for(const [channelId,history] of serverData.messages){
        for(const message of history||[]){
          message.serverId=message.serverId||serverData.id;
          message.channelId=message.channelId||channelId;

          if(message.attachment?.data && String(message.attachment.data).startsWith('data:')){
            const mediaUrl=await this.putMediaDataUrl(
              'message:'+String(message.id||id())+':attachment',
              String(message.attachment.data)
            );

            if(mediaUrl){
              message.attachment={
                ...message.attachment,
                data:mediaUrl
              };
            }
          }

          await this.persistChatMessage(message);
        }
      }
    }

    for(const message of directMessages){
      await this.persistDmMessage(message);
    }

    for(const group of privateGroups.values()){
      for(const message of group.messages||[]){
        message.groupId=message.groupId||group.id;
        await this.persistGroupMessage(message);
      }
    }

    await this.migrateInlineMedia();
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
    const ids=this.roomSockets.get(String(room||''));
    if(!ids) return;
    for(const socketId of ids){
      if(excludeId && socketId===excludeId) continue;
      this.sockets.get(socketId)?.emit(event,data);
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
      this.indexSocket(socket);
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
    this.persistDirty=true;
    if(this.persistScheduled) return this.persistScheduled;

    const task=this.persistChain
      .catch(()=>{})
      .then(async()=>{
        const delay=Math.max(0,250-(Date.now()-this.lastPersistAt));
        if(delay) await new Promise(resolve=>setTimeout(resolve,delay));
        if(!this.persistDirty) return true;
        this.persistDirty=false;
        this.cleanupEphemeralState();
        rebuildStateIndexes();
        const json=JSON.stringify(serializeSnapshot());
        return this.writeSnapshot(json);
      });

    this.persistScheduled=task.finally(()=>{
      this.persistScheduled=null;
      if(this.persistDirty) this.queuePersist();
    });
    this.persistChain=this.persistScheduled;
    try{this.ctx.waitUntil(this.persistScheduled);}catch{}
    return this.persistScheduled;
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
      let chatRows=0,dmRows=0,groupRows=0,mediaRows=0;

      try{
        chatRows=Number([...this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM chat_messages`)][0]?.n||0);
        dmRows=Number([...this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM dm_messages`)][0]?.n||0);
        groupRows=Number([...this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM group_messages`)][0]?.n||0);
        mediaRows=Number([...this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM media_objects`)][0]?.n||0);
      }catch{}

      return Response.json({
        ok:true,
        storage:'durable-object-sqlite',
        architecture:'sqlite-indexed-v7',
        stateIndexRevision:stateIndexes.revision,
        indexedRooms:this.roomSockets.size,
        indexedUsers:this.userSockets.size,
        accounts:accounts.size,
        servers:servers.size,
        directMessages:dmRows,
        chatMessages:chatRows,
        groupMessages:groupRows,
        mediaObjects:mediaRows,
        mediaBackend:this.env?.MEDIA_BUCKET?'r2+sqlite-metadata':'sqlite-inline-fallback',
        securityAuditEvents:auditLog.filter(item=>String(item?.serverId||'')==='__security__').length,
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

    if(url.pathname==='/security-audit'){
      const configured=String(this.env?.ADMIN_AUDIT_TOKEN||'');
      const supplied=String(request.headers.get('X-Acord-Audit-Token')||'');
      if(!configured || !supplied || supplied.length!==configured.length){
        return Response.json({ok:false,error:'Não autorizado'},{status:401,headers:{'Cache-Control':'no-store'}});
      }
      try{
        if(!crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(configured))){
          return Response.json({ok:false,error:'Não autorizado'},{status:401,headers:{'Cache-Control':'no-store'}});
        }
      }catch{
        return Response.json({ok:false,error:'Não autorizado'},{status:401,headers:{'Cache-Control':'no-store'}});
      }
      const events=auditLog.filter(item=>String(item?.serverId||'')==='__security__').slice(-500);
      return Response.json({ok:true,events},{headers:{'Cache-Control':'no-store'}});
    }

    if(url.pathname.startsWith('/media/')){
      const mediaKey=decodeURIComponent(url.pathname.slice('/media/'.length));

      // Anexos de mensagens exigem sessão e acesso atual ao servidor.
      if(mediaKey.startsWith('message:')){
        const messageId=String(mediaKey.split(':')[1]||'');
        const message=this.getChatMessage(messageId);
        const cookieHeader=request.headers.get('Cookie');
        const cookieToken=readCookie(cookieHeader,SESSION_COOKIE)||readCookie(cookieHeader,LEGACY_SESSION_COOKIE);
        const viewerId=cookieToken?sessionUserId(cookieToken,{renew:false}):null;
        const serverData=message?servers.get(String(message.serverId||'')):null;
        const signed=this.verifyMediaSignature(mediaKey,url.searchParams.get('sig'));
        const allowed=signed || !!(
          viewerId && serverData &&
          (serverData.ownerId===viewerId || (serverData.members||[]).includes(viewerId))
        );
        if(!allowed) return new Response('Não autorizado',{status:401,headers:{'Cache-Control':'no-store'}});
      }

      const media=this.getMedia(mediaKey);

      if(!media?.data_url){
        return new Response('Mídia não encontrada',{status:404});
      }

      const raw=String(media.data_url);
      if(raw.startsWith('r2:')){
        const objectKey=raw.slice(3);
        if(!this.env?.MEDIA_BUCKET?.get) return new Response('Armazenamento de mídia indisponível',{status:503});
        const object=await this.env.MEDIA_BUCKET.get(objectKey);
        if(!object) return new Response('Mídia não encontrada',{status:404});
        return new Response(object.body,{
          status:200,
          headers:{
            'Content-Type':String(media.mime||object.httpMetadata?.contentType||'application/octet-stream'),
            'Cache-Control':mediaKey.startsWith('message:')?'private, max-age=3600':'public, max-age=31536000, immutable',
            'X-Content-Type-Options':'nosniff'
          }
        });
      }
      const match=raw.match(/^data:([^;,]+);base64,(.+)$/s);

      if(!match){
        return new Response('Mídia inválida',{status:500});
      }

      try{
        const binary=atob(match[2]);
        const bytes=new Uint8Array(binary.length);
        for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);

        return new Response(bytes,{
          status:200,
          headers:{
            'Content-Type':String(media.mime||match[1]||'application/octet-stream'),
            'Cache-Control':mediaKey.startsWith('message:')?'private, max-age=3600':'public, max-age=31536000, immutable',
            'X-Content-Type-Options':'nosniff'
          }
        });
      }catch{
        return new Response('Mídia inválida',{status:500});
      }
    }

    if(url.pathname==='/validate-session' && request.method==='POST'){
      try{
        const body=await request.json();
        const token=String(body?.token||'');
        const userId=sessionUserId(token,{renew:true});
        const profile=userId?profiles.get(userId):null;

        return Response.json({
          ok:!!(userId&&profile),
          userId:userId||null,
          profile:publicProfile(profile)
        },{
          headers:{'Cache-Control':'no-store'}
        });
      }catch{
        return Response.json({ok:false},{status:400});
      }
    }

    if(request.headers.get('Upgrade')!=='websocket'){
      return new Response('WebSocket esperado',{status:426});
    }

    const pair=new WebSocketPair();
    const client=pair[0];
    const server=pair[1];

    const cookieHeader=request.headers.get('Cookie');
    const cookieToken=readCookie(cookieHeader,SESSION_COOKIE)||readCookie(cookieHeader,LEGACY_SESSION_COOKIE);
    const cookieUserId=cookieToken
      ? sessionUserId(cookieToken,{renew:true})
      : null;
    const cookieProfile=cookieUserId?profiles.get(cookieUserId):null;

    const clientIp=String(request.headers.get('X-Acord-Client-IP')||request.headers.get('CF-Connecting-IP')||'unknown').slice(0,100);
    const meta={
      id:id(),
      rooms:[],
      data:cookieUserId&&cookieProfile
        ? {
            clientIp,
            userId:cookieUserId,
            username:cookieProfile.username,
            sessionHash:tokenHash(cookieToken),
            cookieSession:true
          }
        : {clientIp}
    };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(meta);

    const socket=new SocketCompat(this,server,meta);
    this.sockets.set(socket.id,socket);
    this.indexSocket(socket);

    this.sendPacket(server,{t:'hello',id:socket.id});
    setupSocket(socket);

    return new Response(null,{status:101,webSocket:client});
  }

  async webSocketMessage(ws,message){
    const messageSize=typeof message==='string'?message.length:Number(message?.byteLength||message?.length||0);
    if(messageSize>2_500_000){
      try{ws.close(1009,'Payload muito grande')}catch{}
      return;
    }
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

    this.unindexSocket(socket);
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
  const forwarded=new Request(url.toString(),request);
  const clientIp=String(request.headers.get('CF-Connecting-IP')||'unknown').slice(0,100);
  const headers=new Headers(forwarded.headers);
  headers.set('X-Acord-Client-IP',clientIp);
  return stub.fetch(new Request(forwarded,{headers}));
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

    // Compatibilidade sem redirecionamento: clientes antigos recebem os assets
    // atuais diretamente, evitando loops e versões misturadas no startup.
    const legacyAssets={
      '/index-v61.html':'/index-v682.html',
      '/index-v62.html':'/index-v682.html',
      '/index-v63.html':'/index-v682.html',
      '/index-v64.html':'/index-v682.html',
      '/index-v65.html':'/index-v682.html',
      '/index-v66.html':'/index-v682.html',
      '/index-v67.html':'/index-v682.html',
      '/runtime-v64.js':'/runtime-v682.js',
      '/runtime-v65.js':'/runtime-v682.js',
      '/runtime-v66.js':'/runtime-v682.js',
      '/runtime-v67.js':'/runtime-v682.js',
      '/bootstrap-v62.js':'/bootstrap-v682.js',
      '/bootstrap-v63.js':'/bootstrap-v682.js',
      '/bootstrap-v64.js':'/bootstrap-v682.js',
      '/bootstrap-v65.js':'/bootstrap-v682.js',
      '/bootstrap-v66.js':'/bootstrap-v682.js',
      '/bootstrap-v67.js':'/bootstrap-v682.js',
      '/bundle-v61.js':'/bundle-v682.js',
      '/bundle-v62.js':'/bundle-v682.js',
      '/bundle-v63.js':'/bundle-v682.js',
      '/bundle-v64.js':'/bundle-v682.js',
      '/bundle-v65.js':'/bundle-v682.js',
      '/bundle-v66.js':'/bundle-v682.js',
      '/bundle-v67.js':'/bundle-v682.js',
      '/app-v61.css':'/app-v682.css',
      '/app-v62.css':'/app-v682.css',
      '/app-v63.css':'/app-v682.css',
      '/app-v64.css':'/app-v682.css',
      '/app-v65.css':'/app-v682.css',
      '/app-v66.css':'/app-v682.css',
      '/app-v67.css':'/app-v682.css',
      '/phone-camera-v61.html':'/phone-camera-v682.html',
      '/phone-camera-v62.html':'/phone-camera-v682.html',
      '/phone-camera-v63.html':'/phone-camera-v682.html',
      '/phone-camera-v64.html':'/phone-camera-v682.html',
      '/phone-camera-v65.html':'/phone-camera-v682.html',
      '/phone-camera-v66.html':'/phone-camera-v682.html',
      '/phone-camera-v67.html':'/phone-camera-v682.html',
      '/phone-camera-bundle-v61.js':'/phone-camera-bundle-v682.js',
      '/phone-camera-bundle-v62.js':'/phone-camera-bundle-v682.js',
      '/phone-camera-bundle-v63.js':'/phone-camera-bundle-v682.js',
      '/phone-camera-bundle-v64.js':'/phone-camera-bundle-v682.js',
      '/phone-camera-bundle-v65.js':'/phone-camera-bundle-v682.js',
      '/phone-camera-bundle-v66.js':'/phone-camera-bundle-v682.js',
      '/phone-camera-bundle-v67.js':'/phone-camera-bundle-v682.js'
    };
    if(request.method==='GET' && legacyAssets[url.pathname]){
      const assetUrl=new URL(legacyAssets[url.pathname],url);
      return env.ASSETS.fetch(new Request(assetUrl.toString(),request));
    }

    const acceptsHtml=String(request.headers.get('Accept')||'').includes('text/html');
    const appNavigation=
      request.method==='GET' &&
      acceptsHtml &&
      (
        url.pathname==='/' ||
        url.pathname==='/index.html' ||
        (!url.pathname.includes('.') && !url.pathname.startsWith('/api/') && url.pathname!=='/ws')
      );

    if(appNavigation && !url.pathname.startsWith('/phone-camera/')){
      const assetUrl=new URL('/index-v682.html',url);
      return env.ASSETS.fetch(new Request(assetUrl.toString(),request));
    }

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
        dataVersion:24,
        appVersion:'6.8.2',
        ...state
      });
    }

    if(url.pathname==='/api/persistence-status'){
      return doFetch(env,'/status',request);
    }

    if(url.pathname==='/api/security-audit'){
      return doFetch(env,'/security-audit',request);
    }

    if(url.pathname==='/api/session-cookie'){
      if(request.method==='DELETE'){
        const headers=new Headers({
          'Content-Type':'application/json; charset=utf-8',
          'Cache-Control':'no-store'
        });
        headers.append('Set-Cookie',SESSION_COOKIE+'=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
        headers.append('Set-Cookie',LEGACY_SESSION_COOKIE+'=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
        return new Response(JSON.stringify({ok:true}),{status:200,headers});
      }

      if(request.method!=='POST'){
        return json({ok:false,error:'Método inválido'},405);
      }

      let token='';
      try{
        const body=await request.clone().json();
        token=String(body?.token||'');
      }catch{}

      if(token.length<20){
        return json({ok:false,error:'Sessão inválida'},401);
      }

      const validationRequest=new Request(request.url,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({token})
      });
      const validation=await doFetch(env,'/validate-session',validationRequest);
      const data=await validation.json().catch(()=>({ok:false}));

      if(!data?.ok){
        return json({ok:false,error:'Sessão inválida'},401);
      }

      const headers=new Headers({
        'Content-Type':'application/json; charset=utf-8',
        'Cache-Control':'no-store'
      });
      headers.append(
        'Set-Cookie',
        SESSION_COOKIE+'='+encodeURIComponent(token)+
        '; Path=/; HttpOnly; Secure; SameSite=Strict; Priority=High; Max-Age='+
        Math.floor(SESSION_LIFETIME_MS/1000)
      );
      // Remove o nome antigo depois da migração para o cookie __Host-.
      headers.append('Set-Cookie',LEGACY_SESSION_COOKIE+'=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');

      return new Response(JSON.stringify({
        ok:true,
        profile:data.profile||null
      }),{status:200,headers});
    }

    if(url.pathname.startsWith('/api/media/')){
      const mediaKey=url.pathname.slice('/api/media/'.length);
      return doFetch(env,'/media/'+mediaKey,request);
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
          'https://api.github.com/repos/freitadas/acord-desktop/releases/latest',
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
      const token=decodeURIComponent(url.pathname.split('/').pop()||'').trim();

      if(!token || token.length>200){
        return new Response('QR inválido',{status:400});
      }

      const phoneUrl=
        url.origin+
        '/phone-camera/'+
        encodeURIComponent(token);

      const providers=[
        'https://api.qrserver.com/v1/create-qr-code/?size=320x320&format=png&margin=12&data='+
          encodeURIComponent(phoneUrl),
        'https://quickchart.io/qr?size=320&margin=2&format=png&text='+
          encodeURIComponent(phoneUrl)
      ];

      for(const target of providers){
        try{
          const response=await fetch(target);

          if(!response.ok) continue;

          const contentType=String(response.headers.get('content-type')||'');
          if(!contentType.includes('image/')) continue;

          return new Response(response.body,{
            status:200,
            headers:{
              'Content-Type':contentType.includes('png')?'image/png':contentType,
              'Cache-Control':'no-store, no-cache, must-revalidate',
              'Pragma':'no-cache',
              'X-Content-Type-Options':'nosniff'
            }
          });
        }catch{}
      }

      return new Response('Não foi possível gerar o QR Code',{status:502});
    }

    if(url.pathname.startsWith('/phone-camera/')){
      const assetUrl=new URL('/phone-camera-v682.html',url);
      return env.ASSETS.fetch(new Request(assetUrl.toString(),request));
    }

    if(url.pathname.startsWith('/invite/')){
      const assetUrl=new URL('/index-v682.html',url);
      return env.ASSETS.fetch(new Request(assetUrl.toString(),request));
    }

    return env.ASSETS.fetch(request);
  }
};
