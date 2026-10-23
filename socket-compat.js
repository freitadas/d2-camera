import { SocketRateLimiter } from "./socket-rate-limiter.js";

export class SocketCompat{
  constructor(runtime,ws,meta){
    this.runtime=runtime;
    this.ws=ws;
    this.id=String(meta?.id||id());
    this.handlers=new Map();
    this.middlewares=[];
    this.rateLimiter=new SocketRateLimiter();
    this._meta={
      id:this.id,
      rooms:Array.isArray(meta?.rooms)?meta.rooms.map(String):[],
      data:meta?.data && typeof meta.data==='object'?meta.data:{}
    };

    const socket=this;
    this.data=new Proxy(this._meta.data,{
      set(target,key,value){
        const previous=target[key];
        target[key]=value;
        if(key==='userId') socket.runtime.updateSocketUser(socket,previous,value);
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
    this.runtime.addSocketToRoom(this,value);
    this.persistAttachment();
    return this;
  }

  leave(room){
    const value=String(room||'');
    const rooms=new Set(this._meta.rooms||[]);
    rooms.delete(value);
    this._meta.rooms=[...rooms];
    this.runtime.removeSocketFromRoom(this,value);
    this.persistAttachment();
    return this;
  }

  to(room){
    return {
      emit:(event,data)=>{
        const target=String(room||'');
        const direct=this.runtime.sockets.get(target);
        if(direct && direct.id!==this.id){
          direct.emit(event,data);
          return;
        }
        this.runtime.broadcastRoom(target,event,data,this.id);
      }
    };
  }

  async dispatch(event,data,ackId){
    if(!this.rateLimiter.allow(event)){
      if(ackId) this.runtime.sendPacket(this.ws,{t:'a',a:ackId,d:{ok:false,error:'Muitas ações em pouco tempo'}});
      return;
    }
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

export function createIoCompat(runtime){
  const collection={
    get(id){return runtime.sockets.get(String(id||''));},
    values(){return runtime.sockets.values();}
  };

  const rooms={
    get(room){
      const indexed=runtime.roomSockets.get(String(room||''));
      return indexed?.size ? new Set(indexed) : undefined;
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
          const target=String(room||'');
          const direct=runtime.sockets.get(target);
          if(direct){
            direct.emit(event,data);
            return;
          }
          runtime.broadcastRoom(target,event,data,null);
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


