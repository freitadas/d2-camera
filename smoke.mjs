import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const fail=message=>{throw new Error(message)};

for(const file of ['index.js','runtime-v64.js','bootstrap-v64.js','bundle-v64.js','phone-camera-bundle-v64.js','sw.js']){
  execFileSync(process.execPath,['--check',path.join(root,file)],{stdio:'pipe'});
}

const html=read('index-v64.html');
const ids=[...html.matchAll(/\sid=["']([^"']+)["']/g)].map(m=>m[1]);
const unique=new Set(ids);
if(unique.size!==ids.length){
  const dup=[...new Set(ids.filter((id,i)=>ids.indexOf(id)!==i))];
  fail('IDs duplicados: '+dup.join(', '));
}

const bundle=read('bundle-v64.js');
const directIds=new Set([
  ...[...bundle.matchAll(/\$\(['"]#([^'"]+)['"]\)\.addEventListener/g)].map(m=>m[1]),
  ...[...bundle.matchAll(/document\.getElementById\(['"]([^'"]+)['"]\)\?*\.addEventListener/g)].map(m=>m[1])
]);
const missing=[...directIds].filter(id=>!unique.has(id));
if(missing.length) fail('Listeners apontam para IDs ausentes: '+missing.join(', '));

if(!/<div id="login" class="login">/.test(html)) fail('Login deve nascer visível.');
if(!/<div id="appShell" class="app hubMode hidden">/.test(html)) fail('App principal deve nascer oculto.');
if(!html.includes('/runtime-v64.js?v=6.4.2')||!html.includes('/bootstrap-v64.js?v=6.4.2')||!html.includes('/bundle-v64.js?v=6.4.2')) fail('Scripts v6.4 ausentes.');
if(html.indexOf('/runtime-v64.js?v=6.4.2')>html.indexOf('/bootstrap-v64.js?v=6.4.2')||html.indexOf('/bootstrap-v64.js?v=6.4.2')>html.indexOf('/bundle-v64.js?v=6.4.2')) fail('Ordem de startup inválida.');
if(bundle.includes("localStorage.setItem('acord-auth-token'")) fail('Token não pode ser persistido em localStorage.');

const server=read('index.js');
for(const marker of ['__Host-acord_session','verifyRecoveryProof','auth_rate','recoveryProof','appVersion:\'6.4.2\'']){
  if(!server.includes(marker)) fail('Proteção ausente: '+marker);
}
const wrangler=JSON.parse(read('wrangler.jsonc'));
if(wrangler.assets?.html_handling!=='none') fail('html_handling deve permanecer none para evitar loop de redirect.');

if(!html.includes('class="activeCallDock hidden"')) fail('Dock de call temático ausente.');
if(html.includes('background:rgba(13,27,23,.97)')) fail('Dock de call ainda usa fundo verde fixo.');
const css=read('app-v64.css');
for(const marker of ['.activeCallDock{','background:color-mix(in srgb,var(--coral)','body.locked{','--bg0:#050607;','--mint:#c4cad2;','filter:saturate(.94) contrast(1.01) brightness(1.01)!important;','.fakeFullscreen video{object-fit:contain!important;background:#000!important;filter:none!important']){
  if(!css.includes(marker)) fail('Correção visual de call/tela ausente: '+marker);
}
console.log(JSON.stringify({ok:true,version:'6.4.2',ids:ids.length,directListenerIds:directIds.size},null,2));
