export class StateIndexes {
  constructor(){
    this.clear();
  }

  clear(){
    this.profileByUsernameKey=new Map();
    this.accountByUsernameKey=new Map();
    this.friendsByUser=new Map();
    this.incomingRequestsByUser=new Map();
    this.outgoingRequestsByUser=new Map();
    this.serversByUser=new Map();
    this.serverByInviteToken=new Map();
    this.groupsByUser=new Map();
    this.revision=(this.revision||0)+1;
  }

  static usernameKey(value){
    return String(value||'').trim().replace(/\s+/g,' ').slice(0,30).toLocaleLowerCase('pt-BR');
  }

  _setAdd(map,key,value){
    if(!key || !value) return;
    if(!map.has(key)) map.set(key,new Set());
    map.get(key).add(value);
  }

  _listPush(map,key,value){
    if(!key || !value) return;
    if(!map.has(key)) map.set(key,[]);
    map.get(key).push(value);
  }

  rebuild({profiles,accounts,friendships,friendRequests,servers,privateGroups}){
    this.clear();

    for(const profile of profiles?.values?.()||[]){
      const key=StateIndexes.usernameKey(profile?.username);
      if(key && !this.profileByUsernameKey.has(key)) this.profileByUsernameKey.set(key,profile);
    }

    for(const account of accounts?.values?.()||[]){
      const key=String(account?.usernameKey||StateIndexes.usernameKey(account?.username));
      if(key && !this.accountByUsernameKey.has(key)) this.accountByUsernameKey.set(key,account);
    }

    for(const pair of friendships||[]){
      const a=String(pair?.a||'');
      const b=String(pair?.b||'');
      if(!a || !b || a===b) continue;
      this._setAdd(this.friendsByUser,a,b);
      this._setAdd(this.friendsByUser,b,a);
    }

    for(const request of friendRequests||[]){
      const from=String(request?.fromUserId||'');
      const to=String(request?.toUserId||'');
      if(!from || !to) continue;
      this._listPush(this.outgoingRequestsByUser,from,request);
      this._listPush(this.incomingRequestsByUser,to,request);
    }

    for(const server of servers?.values?.()||[]){
      const serverId=String(server?.id||'');
      if(!serverId) continue;
      const ownerId=String(server?.ownerId||'');
      if(ownerId) this._setAdd(this.serversByUser,ownerId,serverId);
      for(const userId of server?.members||[]) this._setAdd(this.serversByUser,String(userId||''),serverId);
      const token=String(server?.inviteToken||'');
      if(token) this.serverByInviteToken.set(token,server);
    }

    for(const group of privateGroups?.values?.()||[]){
      const groupId=String(group?.id||'');
      if(!groupId) continue;
      for(const userId of group?.members||[]) this._setAdd(this.groupsByUser,String(userId||''),groupId);
    }

    return this;
  }

  profileByUsername(username){
    return this.profileByUsernameKey.get(StateIndexes.usernameKey(username))||null;
  }

  accountByUsername(username){
    return this.accountByUsernameKey.get(StateIndexes.usernameKey(username))||null;
  }

  usernameExists(username,exceptId=null){
    const account=this.accountByUsername(username);
    return !!(account && String(account.userId||'')!==String(exceptId||''));
  }

  areFriends(a,b){
    const left=String(a||'');
    const right=String(b||'');
    return !!(left && right && left!==right && this.friendsByUser.get(left)?.has(right));
  }

  friendIds(userId){
    return [...(this.friendsByUser.get(String(userId||''))||[])];
  }

  incomingRequests(userId){
    return this.incomingRequestsByUser.get(String(userId||''))||[];
  }

  outgoingRequests(userId){
    return this.outgoingRequestsByUser.get(String(userId||''))||[];
  }

  serverIds(userId){
    return [...(this.serversByUser.get(String(userId||''))||[])];
  }

  serverByInvite(token){
    return this.serverByInviteToken.get(String(token||''))||null;
  }

  groupIds(userId){
    return [...(this.groupsByUser.get(String(userId||''))||[])];
  }
}
