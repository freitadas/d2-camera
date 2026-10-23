import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {StateIndexes} from './state-indexes.js';
import {SocketRateLimiter} from './socket-rate-limiter.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=here;
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const fail=message=>{throw new Error(message)};

const profiles=new Map([
  ['u1',{id:'u1',username:'Alice'}],['u2',{id:'u2',username:'Bob'}],['u3',{id:'u3',username:'Carol'}]
]);
const accounts=new Map([
  ['u1',{userId:'u1',username:'Alice',usernameKey:'alice'}],['u2',{userId:'u2',username:'Bob',usernameKey:'bob'}]
]);
const friendships=[{a:'u1',b:'u2',at:1}];
const friendRequests=[{id:'r1',fromUserId:'u3',toUserId:'u1',at:2}];
const servers=new Map([['s1',{id:'s1',ownerId:'u1',members:['u2'],inviteToken:'invite1'}]]);
const privateGroups=new Map([['g1',{id:'g1',members:['u1','u3']}]]);
const idx=new StateIndexes().rebuild({profiles,accounts,friendships,friendRequests,servers,privateGroups});
if(idx.profileByUsername('ALICE')?.id!=='u1') fail('Índice de username falhou.');
if(!idx.areFriends('u1','u2')||idx.areFriends('u1','u3')) fail('Índice de amizades falhou.');
if(idx.incomingRequests('u1').length!==1) fail('Índice de solicitações falhou.');
if(!idx.serverIds('u2').includes('s1')||idx.serverByInvite('invite1')?.id!=='s1') fail('Índice de servidores falhou.');
if(!idx.groupIds('u3').includes('g1')) fail('Índice de grupos falhou.');

const limiter=new SocketRateLimiter();
for(let i=0;i<160;i++) if(!limiter.allow('get-servers',1000)) fail('Rate limiter bloqueou cedo demais.');
if(limiter.allow('get-servers',1000)) fail('Rate limiter não bloqueou flood.');
if(!limiter.allow('get-servers',12000)) fail('Rate limiter não abriu nova janela.');

const server=read('index.js');
for(const marker of [
  'this.roomSockets=new Map()','this.userSockets=new Map()','socketsForUser(userId)',
  'emitToServerMembers','stateIndexes.serverIds','stateIndexes.accountByUsername',
  'messageSize>2_500_000','persistDirty=true','delay=Math.max(0,250-',
  'idx_dm_reverse_at','idx_media_updated_at','idx_auth_rate_updated_at',
  "architecture:'sqlite-indexed-v7'"
]) if(!server.includes(marker)) fail('Otimização ausente: '+marker);
if(server.includes('[...accounts.values()].find(item=>item.usernameKey===key)')) fail('Lookup linear de conta ainda presente.');
if(server.includes("[...servers.values()].find(item=>\n      item.inviteToken===safeToken")) fail('Lookup linear de convite ainda presente.');
const globalSocketScans=(server.match(/io\.sockets\.sockets\.values\(\)/g)||[]).length;
if(globalSocketScans>4) fail('Ainda existem varreduras globais demais de sockets: '+globalSocketScans);

const pkg=JSON.parse(read('package.json'));
if(pkg.version!=='6.8.2') fail('Versão raiz incorreta.');
if(!pkg.scripts?.['check:generated']) fail('Verificação de assets gerados ausente.');

console.log(JSON.stringify({ok:true,version:'6.8.2',stateIndexRevision:idx.revision,scalabilityRegression:true},null,2));
