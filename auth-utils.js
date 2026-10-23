import * as crypto from "node:crypto";

export function normalizeAccountUsername(value){
  return String(value || '').trim().replace(/\s+/g,' ').slice(0,30);
}

export function usernameKey(value){
  return normalizeAccountUsername(value).toLocaleLowerCase('pt-BR');
}

export function passwordDigest(password,salt){
  return crypto.scryptSync(
    String(password || ''),
    Buffer.from(String(salt || ''),'hex'),
    64
  ).toString('hex');
}

export function verifyAccountPassword(password,account){
  try{
    const expected=Buffer.from(account.passwordHash,'hex');
    const actual=Buffer.from(passwordDigest(password,account.salt),'hex');
    return expected.length===actual.length && crypto.timingSafeEqual(expected,actual);
  }catch{return false}
}

export function tokenHash(token){
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

export function readCookie(header,name){
  const target=String(name||'')+'=';
  for(const part of String(header||'').split(';')){
    const item=part.trim();
    if(item.startsWith(target)){
      try{return decodeURIComponent(item.slice(target.length))}catch{return item.slice(target.length)}
    }
  }
  return '';
}
