import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=here;
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const fail=message=>{throw new Error(message)};
const server=read('index.js');
const bundle=read('bundle-v682.js');
const html=read('index-v682.html');

const must=(source,marker,label=marker)=>{if(!source.includes(marker))fail('Proteção ausente: '+label)};
const mustNot=(source,marker,label=marker)=>{if(source.includes(marker))fail('Padrão inseguro encontrado: '+label)};

// Sessão/autenticação
for(const marker of [
  '__Host-acord_session','HttpOnly; Secure; SameSite=Strict','tokenHash(token)','crypto.timingSafeEqual',
  'auth_rate','recordSecurityAudit','security:','password-change','auth-restore','ADMIN_AUDIT_TOKEN','/api/security-audit'
]) must(server,marker);
mustNot(bundle,"localStorage.setItem('acord-auth-token'",'token em localStorage');

// Controle compartilhado: permissão granular, autorização efêmera e anti-replay.
for(const marker of [
  'SHARED_CONTROL_GRANT_MS=10*60*1000','SHARED_CONTROL_REQUEST_MS=2*60*1000',
  'accessToken=crypto.randomBytes(24)','const expiresAt=Date.now()+SHARED_CONTROL_GRANT_MS',
  "shared-control-input',({hostId,event,accessToken}",
  "safe.type==='key'&&!grant.permissions.keyboard",
  "safe.type==='pointer-move'||safe.type==='pointer-button'||safe.type==='wheel'",
  'cleanupSharedControlForSocket','reason:\'expired\''
]) must(server,marker);
for(const marker of [
  'sharedControlMousePerm','sharedControlKeyboardPerm','sharedControlGamepadPerm'
]) must(html,marker);
for(const marker of [
  "accessToken:state.sharedControl.accessToken",'grantPermissions:new Map()','requestPermissions:new Map()',
  'accessExpiresAt:0','selectedSharedControlPermissions','sharedControlPermissionLabel'
]) must(bundle,marker);

// Mídia preparada para isolamento em R2, mantendo fallback compatível.
for(const marker of ['this.env?.MEDIA_BUCKET?.put','this.env?.MEDIA_BUCKET?.get',"storedValue='r2:'",'mediaBackend:']) must(server,marker);

// XSS/runtime: proíbe execução dinâmica no bundle principal.
mustNot(bundle,'eval(','eval');
mustNot(bundle,'new Function(','new Function');
mustNot(bundle,'document.write(','document.write');

console.log(JSON.stringify({ok:true,securityRegression:true,version:'6.8.2'},null,2));
