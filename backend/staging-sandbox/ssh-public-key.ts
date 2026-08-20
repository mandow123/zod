import { createHash } from 'node:crypto';

export type ParsedSshPublicKey = Readonly<{ algorithm:'ssh-ed25519'|'sk-ssh-ed25519@openssh.com'|'ecdsa-sha2-nistp256'|'ssh-rsa'; fingerprint:string; normalized:string }>;

function fail(code:'PRIVATE_KEY_FORBIDDEN'|'INVALID_SSH_PUBLIC_KEY'):never{throw Object.assign(new Error(code),{code,statusCode:422});}
function readString(blob:Buffer,state:{offset:number}){if(state.offset+4>blob.length)fail('INVALID_SSH_PUBLIC_KEY');const length=blob.readUInt32BE(state.offset);state.offset+=4;if(length>8192||state.offset+length>blob.length)fail('INVALID_SSH_PUBLIC_KEY');const value=blob.subarray(state.offset,state.offset+length);state.offset+=length;return value;}
function text(value:Buffer){try{return new TextDecoder('utf-8',{fatal:true}).decode(value);}catch{fail('INVALID_SSH_PUBLIC_KEY');}}
function rsaBits(modulus:Buffer){let offset=0;while(offset<modulus.length&&modulus[offset]===0)offset+=1;if(offset===modulus.length)return 0;const first=modulus[offset]!;return (modulus.length-offset-1)*8+(32-Math.clz32(first));}

export function parseOpenSshPublicKey(input:string):ParsedSshPublicKey{
  if(/(?:BEGIN|END)[^\r\n]*PRIVATE KEY|OPENSSH PRIVATE KEY|PuTTY-User-Key-File|Proc-Type:|DEK-Info:/iu.test(input))fail('PRIVATE_KEY_FORBIDDEN');
  const value=input.trim();if(!value||/[\r\n]/u.test(value)||Buffer.byteLength(value,'utf8')>16_384)fail('INVALID_SSH_PUBLIC_KEY');
  const match=/^(\S+) ([A-Za-z0-9+/]+={0,2})(?: ([^\r\n]*))?$/u.exec(value);if(!match)fail('INVALID_SSH_PUBLIC_KEY');
  if(match[3]&&/(?:password|passwd|script|token|secret|private\s*key|BEGIN|END)/iu.test(match[3]))fail('INVALID_SSH_PUBLIC_KEY');
  const algorithm=match[1] as ParsedSshPublicKey['algorithm'];
  if(!['ssh-ed25519','sk-ssh-ed25519@openssh.com','ecdsa-sha2-nistp256','ssh-rsa'].includes(algorithm)||algorithm.includes('-cert-'))fail('INVALID_SSH_PUBLIC_KEY');
  const encoded=match[2]!;if(encoded.length%4===1)fail('INVALID_SSH_PUBLIC_KEY');let blob:Buffer;try{blob=Buffer.from(encoded,'base64');}catch{fail('INVALID_SSH_PUBLIC_KEY');}
  if(blob.length===0||blob.length>8192||blob.toString('base64').replace(/=+$/u,'')!==encoded.replace(/=+$/u,''))fail('INVALID_SSH_PUBLIC_KEY');
  const state={offset:0};if(text(readString(blob,state))!==algorithm)fail('INVALID_SSH_PUBLIC_KEY');
  if(algorithm==='ssh-ed25519'){if(readString(blob,state).length!==32)fail('INVALID_SSH_PUBLIC_KEY');}
  else if(algorithm==='sk-ssh-ed25519@openssh.com'){const key=readString(blob,state),application=readString(blob,state);if(key.length!==32||application.length===0||text(application).length===0)fail('INVALID_SSH_PUBLIC_KEY');}
  else if(algorithm==='ecdsa-sha2-nistp256'){const point=(()=>{if(text(readString(blob,state))!=='nistp256')fail('INVALID_SSH_PUBLIC_KEY');return readString(blob,state);})();if(point.length!==65||point[0]!==4)fail('INVALID_SSH_PUBLIC_KEY');}
  else {const exponent=readString(blob,state),modulus=readString(blob,state);const canonical=(part:Buffer)=>part.length>0&&!(part.length>1&&part[0]===0&&(part[1]!&0x80)===0)&&(part[0]!&0x80)===0;if(!canonical(exponent)||!canonical(modulus)||rsaBits(modulus)<3072)fail('INVALID_SSH_PUBLIC_KEY');}
  if(state.offset!==blob.length)fail('INVALID_SSH_PUBLIC_KEY');
  return{algorithm,fingerprint:`SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/u,'')}`,normalized:`${algorithm} ${blob.toString('base64')}`};
}
