const HIGH_FREQUENCY_EVENTS=new Set([
  'shared-control-input','ice-candidate','phone-camera-ice','mega-whiteboard-stroke'
]);
const MESSAGE_EVENTS=new Set([
  'chat-message','public-chat-message','dm-message','group-message','creative-expiring-message','mega-call-file'
]);
const SENSITIVE_EVENTS=new Set([
  'auth-login','auth-register','auth-restore','essential-change-password','delete-account',
  'shared-control-request','shared-control-grant','shared-control-revoke'
]);

export class SocketRateLimiter {
  constructor(){
    this.buckets=new Map();
  }

  policy(event){
    if(HIGH_FREQUENCY_EVENTS.has(event)) return {limit:1200,windowMs:10_000};
    if(MESSAGE_EVENTS.has(event)) return {limit:45,windowMs:10_000};
    if(SENSITIVE_EVENTS.has(event)) return {limit:20,windowMs:60_000};
    return {limit:160,windowMs:10_000};
  }

  allow(event,now=Date.now()){
    const key=String(event||'');
    const {limit,windowMs}=this.policy(key);
    let bucket=this.buckets.get(key);
    if(!bucket || now-bucket.startedAt>=windowMs){
      bucket={startedAt:now,count:0};
      this.buckets.set(key,bucket);
    }
    bucket.count+=1;
    if(this.buckets.size>96){
      for(const [name,value] of this.buckets){
        if(now-value.startedAt>120_000) this.buckets.delete(name);
      }
    }
    return bucket.count<=limit;
  }
}
