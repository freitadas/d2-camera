// Teste E2E opcional para um ambiente de teste/staging já implantado.
// Execute com ACORD_TEST_URL=https://seu-worker-de-teste.example npm run test:security:e2e
const base=process.env.ACORD_TEST_URL;
if(!base){
  console.log(JSON.stringify({ok:true,skipped:true,reason:'Defina ACORD_TEST_URL para executar o E2E de segurança.'},null,2));
  process.exit(0);
}

const fail=message=>{throw new Error(message)};
const delay=ms=>new Promise(r=>setTimeout(r,ms));

class Client{
  constructor(name){this.name=name;this.events=[];this.acks=new Map();this.seq=0;this.id='';}
  async connect(){
    const u=new URL(base);u.protocol=u.protocol==='https:'?'wss:':'ws:';u.pathname='/ws';u.search='';
    this.ws=new WebSocket(u);
    await new Promise((resolve,reject)=>{this.ws.onopen=resolve;this.ws.onerror=reject});
    this.ws.onmessage=e=>{
      const p=JSON.parse(String(e.data));
      if(p.t==='hello') this.id=String(p.id||'');
      else if(p.t==='a'&&p.a){const fn=this.acks.get(String(p.a));if(fn){this.acks.delete(String(p.a));fn(p.d)}}
      else if(p.t==='e') this.events.push({event:String(p.e||''),data:p.d,at:Date.now()});
    };
    for(let i=0;i<50&&!this.id;i++) await delay(20);
    if(!this.id) fail(this.name+': handshake ausente');
  }
  emit(event,data={}){this.ws.send(JSON.stringify({t:'e',e:event,d:data}));}
  emitAck(event,data={},timeout=4000){
    const a=String(++this.seq);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.acks.delete(a);reject(new Error(this.name+': timeout '+event))},timeout);
      this.acks.set(a,value=>{clearTimeout(timer);resolve(value)});
      this.ws.send(JSON.stringify({t:'e',e:event,d:data,a}));
    });
  }
  async wait(event,predicate=()=>true,timeout=5000){
    const started=Date.now();
    while(Date.now()-started<timeout){
      const idx=this.events.findIndex(x=>x.event===event&&predicate(x.data));
      if(idx>=0) return this.events.splice(idx,1)[0].data;
      await delay(25);
    }
    throw new Error(this.name+': evento não recebido '+event);
  }
  async expectNo(event,timeout=500){
    const started=Date.now();
    while(Date.now()-started<timeout){
      if(this.events.some(x=>x.event===event)) throw new Error(this.name+': evento indevido '+event);
      await delay(25);
    }
  }
  close(){try{this.ws?.close()}catch{}}
}

const suffix=(Date.now().toString(36)+Math.random().toString(36).slice(2,7)).slice(-10);
const password='Acord!'+suffix+'9x';
const host=new Client('host');
const guest=new Client('guest');
let hostToken='',guestToken='';

try{
  await host.connect();
  host.emit('auth-register',{username:'e2e-host-'+suffix,password});
  hostToken=String((await host.wait('auth-success')).token||'');
  if(hostToken.length<20) fail('token host ausente');
  host.emit('create-server',{name:'E2E Security '+suffix});
  const created=await host.wait('server-created');
  const serverId=String(created.serverId||'');
  const hostServers=await host.wait('server-list',list=>Array.isArray(list)&&list.some(s=>s.id===serverId));
  const server=hostServers.find(s=>s.id===serverId);
  const inviteToken=String(server?.inviteToken||'');
  const voiceId=String(server?.voiceChannels?.[0]?.id||'');
  if(!inviteToken||!voiceId) fail('servidor de teste incompleto');

  await guest.connect();
  guest.emit('auth-register',{username:'e2e-guest-'+suffix,password});
  guestToken=String((await guest.wait('auth-success')).token||'');
  guest.emit('join-server-invite',{token:inviteToken});
  await guest.wait('server-list',list=>Array.isArray(list)&&list.some(s=>s.id===serverId));

  host.emit('join-voice',{serverId,channelId:voiceId,username:'e2e-host-'+suffix});
  guest.emit('join-voice',{serverId,channelId:voiceId,username:'e2e-guest-'+suffix});
  await host.wait('voice-members',list=>Array.isArray(list)&&list.length>=2);

  const enabled=await host.emitAck('shared-control-host-set',{enabled:true});
  if(!enabled?.ok) fail('host não ativou Controle compartilhado');

  const requested=await guest.emitAck('shared-control-request',{permissions:{mouse:true,keyboard:false,gamepad:false}});
  if(!requested?.ok) fail('pedido de mouse falhou');
  await host.wait('shared-control-requested',x=>String(x?.peerId||'')===guest.id);

  const wrongGrant=await host.emitAck('shared-control-grant',{peerId:guest.id,permissions:{mouse:false,keyboard:true,gamepad:false}});
  if(wrongGrant?.ok) fail('servidor aceitou permissão não solicitada');

  const grant=await host.emitAck('shared-control-grant',{peerId:guest.id,permissions:{mouse:true,keyboard:false,gamepad:false}});
  if(!grant?.ok||!grant?.permissions?.mouse||grant?.permissions?.keyboard) fail('grant granular inválido');
  const granted=await guest.wait('shared-control-granted');
  const accessToken=String(granted?.accessToken||'');
  if(accessToken.length<32) fail('token efêmero de controle ausente');

  guest.emit('shared-control-input',{hostId:host.id,accessToken:'token-invalido',event:{type:'pointer-move',x:.5,y:.5}});
  await host.expectNo('shared-control-input',450);

  guest.emit('shared-control-input',{hostId:host.id,accessToken,event:{type:'pointer-move',x:.5,y:.5}});
  const relayed=await host.wait('shared-control-input');
  if(relayed?.event?.type!=='pointer-move') fail('input válido não foi retransmitido');

  const revoked=await host.emitAck('shared-control-revoke',{peerId:guest.id});
  if(!revoked?.ok) fail('revogação falhou');
  await guest.wait('shared-control-revoked');
  guest.emit('shared-control-input',{hostId:host.id,accessToken,event:{type:'pointer-move',x:.2,y:.2}});
  await host.expectNo('shared-control-input',450);

  // Token de sessão aleatório não pode restaurar conta.
  const outsider=new Client('outsider');
  await outsider.connect();
  outsider.emit('auth-restore',{token:'x'.repeat(64),recovery:null});
  await outsider.wait('auth-required',x=>x?.reason==='invalid-session');
  outsider.close();

  guest.emit('delete-account',{token:guestToken});
  await guest.wait('account-deleted');
  host.emit('delete-account',{token:hostToken});
  await host.wait('account-deleted');

  console.log(JSON.stringify({ok:true,e2eSecurity:true,permissions:true,revocation:true,websocketTamper:true,invalidSession:true},null,2));
}finally{
  guest.close();host.close();
}
