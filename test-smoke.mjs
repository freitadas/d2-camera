import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=here;
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const fail=message=>{throw new Error(message)};

for(const file of ['index.js','runtime-v68.js','bootstrap-v68.js','bundle-v68.js','phone-camera-bundle-v68.js','sw.js']){
  execFileSync(process.execPath,['--check',path.join(root,file)],{stdio:'pipe'});
}

const html=read('index-v68.html');
const ids=[...html.matchAll(/\sid=["']([^"']+)["']/g)].map(m=>m[1]);
const unique=new Set(ids);
if(unique.size!==ids.length){
  const dup=[...new Set(ids.filter((id,i)=>ids.indexOf(id)!==i))];
  fail('IDs duplicados: '+dup.join(', '));
}

const bundle=read('bundle-v68.js');
const directIds=new Set([
  ...[...bundle.matchAll(/\$\(['"]#([^'"]+)['"]\)\.addEventListener/g)].map(m=>m[1]),
  ...[...bundle.matchAll(/document\.getElementById\(['"]([^'"]+)['"]\)\?*\.addEventListener/g)].map(m=>m[1])
]);
const missing=[...directIds].filter(id=>!unique.has(id));
if(missing.length) fail('Listeners apontam para IDs ausentes: '+missing.join(', '));

if(!/<div id="login" class="login">/.test(html)) fail('Login deve nascer visível.');
if(!/<div id="appShell" class="app hubMode hidden">/.test(html)) fail('App principal deve nascer oculto.');
if(!html.includes('/runtime-v68.js?v=6.8.0')||!html.includes('/bootstrap-v68.js?v=6.8.0')||!html.includes('/bundle-v68.js?v=6.8.0')) fail('Scripts da versão atual ausentes.');
if(html.indexOf('/runtime-v68.js?v=6.8.0')>html.indexOf('/bootstrap-v68.js?v=6.8.0')||html.indexOf('/bootstrap-v68.js?v=6.8.0')>html.indexOf('/bundle-v68.js?v=6.8.0')) fail('Ordem de startup inválida.');
if(bundle.includes("localStorage.setItem('acord-auth-token'")) fail('Token não pode ser persistido em localStorage.');

const server=read('index.js');
const socketCompat=read('socket-compat.js');
for(const marker of ['__Host-acord_session','verifyRecoveryProof','auth_rate','recoveryProof','appVersion:\'6.8.0\'']){
  if(!server.includes(marker)) fail('Proteção ausente: '+marker);
}

for(const marker of ['id="sharedControlBtn"','id="sharedControlPanel"','id="sharedControlHostToggleBtn"','id="sharedControlRequestBtn"','id="sharedControlTakeBtn"']){
  if(!html.includes(marker)) fail('UI de Controle compartilhado ausente: '+marker);
}
for(const marker of ['function setSharedControlHostEnabled','function normalizedSharedControlPointer','shared-control-host-set','shared-control-request','shared-control-grant','shared-control-revoke','shared-control-input','AcordDesktopControl','__acordDesktopBridgeRequest','sharedControlDesktopHint']){
  if(!bundle.includes(marker)) fail('Cliente de Controle compartilhado ausente: '+marker);
}
for(const marker of ['shared-control-host-set','shared-control-request','shared-control-grant','shared-control-revoke','shared-control-input']){
  if(!server.includes(marker)) fail('Servidor de Controle compartilhado ausente: '+marker);
}
if(!socketCompat.includes('const direct=this.runtime.sockets.get(target)') && !socketCompat.includes('const direct=runtime.sockets.get(target)')) fail('Roteamento direto modular ausente.');

const wrangler=JSON.parse(read('wrangler.jsonc'));
if(wrangler.assets?.html_handling!=='none') fail('html_handling deve permanecer none para evitar loop de redirect.');

if(!html.includes('class="activeCallDock hidden"')) fail('Dock de call temático ausente.');
if(html.includes('background:rgba(13,27,23,.97)')) fail('Dock de call ainda usa fundo verde fixo.');
const css=read('app-v68.css');
for(const marker of ['.activeCallDock{','background:color-mix(in srgb,var(--coral)','body.locked{','--bg0:#050607;','--mint:#c4cad2;','filter:saturate(.94) contrast(1.01) brightness(1.01)!important;','.fakeFullscreen video{object-fit:contain!important;background:#000!important;filter:none!important','.videoCard.sharedControlCapture video{cursor:crosshair;object-fit:contain!important']){
  if(!css.includes(marker)) fail('Correção visual de call/tela ausente: '+marker);
}
console.log(JSON.stringify({ok:true,version:'6.8.0',ids:ids.length,directListenerIds:directIds.size},null,2));
