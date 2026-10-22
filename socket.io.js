(function(global){
'use strict';

class AcordSocket{
  constructor(){
    this.listeners=new Map();
    this.acks=new Map();
    this.queue=[];
    this.connected=false;
    this.id='';
    this.ws=null;
    this.reconnectTimer=null;
    this.reconnectDelay=700;
    this.manualClose=false;
    this.helloTimer=null;
    this._connect();
  }

  on(event,handler){
    if(typeof handler!=='function') return this;
    if(!this.listeners.has(event)) this.listeners.set(event,[]);
    this.listeners.get(event).push(handler);

    if(event==='connect' && this.connected){
      queueMicrotask(()=>{try{handler()}catch(error){console.error(error)}});
    }
    return this;
  }

  emit(event,...args){
    let callback=null;
    if(args.length && typeof args[args.length-1]==='function'){
      callback=args.pop();
    }
    const data=args.length<=1 ? args[0] : args;
    this._sendEvent(event,data,callback,false,0);
    return this;
  }

  timeout(ms){
    const socket=this;
    return {
      emit(event,...args){
        let callback=null;
        if(args.length && typeof args[args.length-1]==='function'){
          callback=args.pop();
        }
        const data=args.length<=1 ? args[0] : args;
        socket._sendEvent(event,data,callback,true,Number(ms)||5000);
        return socket;
      }
    };
  }

  _emitLocal(event,...args){
    const handlers=this.listeners.get(event)||[];
    for(const handler of [...handlers]){
      try{handler(...args)}catch(error){console.error('Evento '+event,error)}
    }
  }

  _newAck(callback,timeoutMode,timeoutMs){
    if(typeof callback!=='function') return null;

    const id='ack-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
    const entry={callback,timeoutMode,timer:null};

    if(timeoutMode){
      entry.timer=setTimeout(()=>{
        if(!this.acks.has(id)) return;
        this.acks.delete(id);
        try{callback(new Error('timeout'))}catch(error){console.error(error)}
      },Math.max(250,timeoutMs||5000));
    }

    this.acks.set(id,entry);
    return id;
  }

  _sendEvent(event,data,callback,timeoutMode,timeoutMs){
    const ackId=this._newAck(callback,timeoutMode,timeoutMs);
    const packet={t:'e',e:String(event||''),d:data};

    if(ackId) packet.a=ackId;

    const encoded=JSON.stringify(packet);

    if(this.connected && this.ws && this.ws.readyState===WebSocket.OPEN){
      try{
        this.ws.send(encoded);
        return;
      }catch{}
    }

    this.queue.push(encoded);
    if(this.queue.length>300) this.queue.splice(0,this.queue.length-300);
  }

  _flushQueue(){
    if(!this.connected || !this.ws || this.ws.readyState!==WebSocket.OPEN) return;
    const pending=this.queue.splice(0);
    for(const encoded of pending){
      try{this.ws.send(encoded)}catch{
        this.queue.unshift(encoded);
        break;
      }
    }
  }

  _scheduleReconnect(){
    if(this.manualClose || this.reconnectTimer) return;
    const delay=this.reconnectDelay;
    this.reconnectDelay=Math.min(5000,Math.round(this.reconnectDelay*1.55));

    this.reconnectTimer=setTimeout(()=>{
      this.reconnectTimer=null;
      this._connect();
    },delay);
  }

  _markConnected(){
    if(this.connected) return;
    this.connected=true;
    this.reconnectDelay=700;
    if(this.helloTimer){
      clearTimeout(this.helloTimer);
      this.helloTimer=null;
    }
    this._flushQueue();
    this._emitLocal('connect');
  }

  _connect(){
    if(this.manualClose) return;

    const protocol=location.protocol==='https:'?'wss:':'ws:';
    const url=protocol+'//'+location.host+'/ws';

    try{
      const ws=new WebSocket(url);
      this.ws=ws;

      ws.addEventListener('open',()=>{
        this.helloTimer=setTimeout(()=>this._markConnected(),1200);
      });

      ws.addEventListener('message',event=>{
        let packet=null;
        try{packet=JSON.parse(String(event.data||''))}catch{return}

        if(packet?.t==='hello'){
          this.id=String(packet.id||'');
          this._markConnected();
          return;
        }

        if(packet?.t==='a'){
          const entry=this.acks.get(String(packet.a||''));
          if(!entry) return;
          this.acks.delete(String(packet.a||''));
          if(entry.timer) clearTimeout(entry.timer);

          try{
            if(entry.timeoutMode){
              entry.callback(null,packet.d);
            }else{
              entry.callback(packet.d);
            }
          }catch(error){console.error(error)}
          return;
        }

        if(packet?.t==='e' && packet.e){
          this._emitLocal(String(packet.e),packet.d);
        }
      });

      ws.addEventListener('close',event=>{
        if(this.ws && this.ws!==ws) return;
        const wasConnected=this.connected;
        this.connected=false;
        this.id='';
        if(this.helloTimer){
          clearTimeout(this.helloTimer);
          this.helloTimer=null;
        }

        if(wasConnected){
          this._emitLocal('disconnect',event.reason||'transport close');
        }

        for(const [ackId,entry] of this.acks){
          if(entry.timer) clearTimeout(entry.timer);
          if(entry.timeoutMode){
            try{entry.callback(new Error('disconnect'))}catch{}
            this.acks.delete(ackId);
          }
        }

        this._scheduleReconnect();
      });

      ws.addEventListener('error',()=>{});
    }catch{
      this._scheduleReconnect();
    }
  }

  connect(){
    if(this.connected) return this;
    this.manualClose=false;
    if(this.reconnectTimer){
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer=null;
    }
    this._connect();
    return this;
  }

  disconnect(){
    this.manualClose=true;
    if(this.reconnectTimer){
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer=null;
    }
    const old=this.ws;
    this.ws=null;
    try{old?.close(1000,'client disconnect')}catch{}
    return this;
  }
}

global.io=function(){
  return new AcordSocket();
};
})(window);
