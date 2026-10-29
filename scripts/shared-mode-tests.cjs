'use strict';
const assert=require('node:assert/strict');
const Module=require('node:module');
const loader=Module._load;
class Plugin{} class PluginSettingTab{} class TFile{} class Modal{} class Notice{constructor(msg){this.msg=msg;}}
let tokenResponse=()=>{throw Error('Unexpected live OAuth request')};
Module._load=function(name,parent,main){if(name==='obsidian')return {Plugin,PluginSettingTab,TFile,Modal,Notice,requestUrl:opts=>tokenResponse(opts)};return loader.call(this,name,parent,main)};
const G=require('../main.js');
const {DriveIO,DEFAULTS,oauthUrl,parseSharedFolderId,SHARED_SCOPE,SyncCore}=G.__test;
const folder='application/vnd.google-apps.folder';
Object.defineProperty(global,'crypto',{value:require('node:crypto').webcrypto,configurable:true});
let successes=0;
const test=async(name,f)=>{await f();successes++;console.log('PASS:',name)};
const instance=()=>{
 const p=new G();p.cfg={...DEFAULTS,modeProfiles:{},state:{},selectedFiles:{},protectedLocal:[],pendingByMode:{}};
 p.app={vault:{getName:()=> 'test'}};p.save=async()=>{};p.tab={display:()=>{}};p.invalidate=()=>{p.previewed=null};p.preparedAuth={};
 p.drive={about:async()=>({user:{emailAddress:'sync@example.com'}}),get:async(id)=>({id,name:'shared',mimeType:folder,capabilities:{canAddChildren:true}}),list:async()=>[]};
 return p;
};
(async()=>{
 await test('Separate OAuth Drive scope is full Drive for dedicated account',()=>assert.equal(SHARED_SCOPE,'https://www.googleapis.com/auth/drive'));
 await test('Shared OAuth is not a Picker permission request',async()=>{
  const u=new URL((await oauthUrl('123-abc.apps.googleusercontent.com','https://example.org/callback','vault','shared')).url);
  assert.equal(u.searchParams.get('scope'),SHARED_SCOPE);
  assert.equal(u.searchParams.get('trigger_onepick'),null);
  assert.equal(u.searchParams.get('allow_folder_selection'),null);
  assert.equal(u.searchParams.get('access_type'),'offline');
  assert.equal(u.searchParams.get('code_challenge_method'),'S256');
 });
 await test('Original limited OAuth scope remains',async()=>{
  const u=new URL((await oauthUrl('123-abc.apps.googleusercontent.com','https://example.org/callback','vault','folder')).url);
  assert.equal(u.searchParams.get('scope'),'https://www.googleapis.com/auth/drive.file');
 });
 await test('Accept folder link',()=>assert.equal(parseSharedFolderId('https://drive.google.com/drive/u/0/folders/abcDEF0123456789-_'),'abcDEF0123456789-_'));
 await test('Reject non-Google folder URL',()=>assert.throws(()=>parseSharedFolderId('https://evil.example/folders/abcDEF0123456789'),/Google Drive/));
 await test('Reject traversal and malformed IDs',()=>assert.throws(()=>parseSharedFolderId('../private'),/正しくありません/));
 await test('Mode-switch removes old active token and root',async()=>{
  const p=instance();p.cfg.refreshToken='old-limited';p.cfg.rootId='limited-root';p.cfg.clientId='id';
  p.liveAccessToken='old-access';p.accessExpiry=Date.now()+10000;
  await p.switchAccessMode('shared');
  assert.equal(p.cfg.refreshToken,'');assert.equal(p.cfg.rootId,'');assert.equal(p.liveAccessToken,'');
  assert.equal(p.cfg.modeProfiles.limited.rootId,'limited-root');
  await p.switchAccessMode('limited');assert.equal(p.cfg.refreshToken,'old-limited');assert.equal(p.cfg.rootId,'limited-root');
 });
 await test('Cannot select shared folder before authentication',async()=>{
  const p=instance();p.cfg.accessMode='shared';p.cfg.expectedDedicatedEmail='sync@example.com';
  await assert.rejects(p.selectSharedRoot('abcDEF0123456789'),/認証/);
 });
 await test('Shared root rejects account mismatch',async()=>{
  const p=instance();p.cfg.accessMode='shared';p.cfg.refreshToken='valid';p.cfg.expectedDedicatedEmail='sync@example.com';
  p.drive.about=async()=>({user:{emailAddress:'personal@example.com'}});
  await assert.rejects(p.selectSharedRoot('abcDEF0123456789'),/一致しません/);
 });
 await test('Shared root rejects read-only folder',async()=>{
  const p=instance();p.cfg.accessMode='shared';p.cfg.refreshToken='valid';p.cfg.expectedDedicatedEmail='sync@example.com';
  p.drive.get=async(id)=>({id,name:'read-only',mimeType:folder,capabilities:{canAddChildren:false}});
  await assert.rejects(p.selectSharedRoot('abcDEF0123456789'),/編集者/);
 });
 await test('Shared root is accepted only when editable and visible',async()=>{
  const p=instance();p.cfg.accessMode='shared';p.cfg.refreshToken='valid';p.cfg.expectedDedicatedEmail='sync@example.com';
  await p.selectSharedRoot('abcDEF0123456789');
  assert.equal(p.cfg.rootId,'abcDEF0123456789');assert.equal(p.cfg.ownRoot,false);
 });
 await test('Token refresh invalid_grant triggers reauthentication',async()=>{
  const p=instance();p.cfg.refreshToken='expired';p.cfg.clientId='client';p.cfg.clientSecret='secret';
  tokenResponse=async()=>({status:400,json:{error:'invalid_grant'},text:'invalid_grant'});
  await assert.rejects(p.getAccess(),/再認証/);
  assert.equal(p.cfg.needsReauth,true);assert.equal(p.liveAccessToken,'');
 });
 await test('Non-expiry network error does not erase refresh token',async()=>{
  const p=instance();p.cfg.refreshToken='unchanged';p.cfg.clientId='client';p.cfg.clientSecret='secret';
  tokenResponse=async()=>({status:503,text:'overloaded',json:{}});
  await assert.rejects(p.getAccess(),/503/);
  assert.equal(p.cfg.needsReauth,false);assert.equal(p.cfg.refreshToken,'unchanged');
 });
 await test('Expired state refuses further silent requests',async()=>{
  const p=instance();p.cfg.refreshToken='expired';p.cfg.needsReauth=true;
  await assert.rejects(p.getAccess(),/期限切れ/);
 });
 await test('Folder recursion finds nested file from third-party source',async()=>{
  const nodes={'abcDEF0123456789':{id:'abcDEF0123456789',name:'shared',mimeType:folder,parents:[]},'nestedfolderxyz':{id:'nestedfolderxyz',name:'sub',mimeType:folder,parents:['abcDEF0123456789']}};
  const files={'abcDEF0123456789':[nodes.nestedfolderxyz,{id:'external-note',name:'a.md',mimeType:'text/markdown',parents:['abcDEF0123456789']}],'nestedfolderxyz':[{id:'future-note',name:'new.md',mimeType:'text/markdown',parents:['nestedfolderxyz']}]};
  const api=new DriveIO(async()=> 'test',async opts=>{
    const u=new URL(opts.url);let json;
    if(u.pathname.endsWith('/files')){const q=u.searchParams.get('q');const m=q.match(/'([^']+)' in parents/);json={files:files[m?.[1]]||[]};}
    else {const id=u.pathname.split('/').at(-1);json=nodes[id]||{id,parents:['abcDEF0123456789'],mimeType:'text/markdown'};}
    return {status:200,json};
  });
  const tree=await api.tree('abcDEF0123456789',{});
  assert(tree.files.has('a.md'));assert(tree.files.has('sub/new.md'));
 });
 await test('Blocked actions when remote file moved outside selected root',async()=>{
  const p=instance();p.cfg.accessMode='shared';p.cfg.rootId='abcDEF0123456789';
  p.drive.isInsideRoot=async()=>false;
  p.app.vault.getAbstractFileByPath=()=>null;
  await assert.rejects(p.assertUnchanged({path:'a.md',local:false,remote:true,remoteId:'somefile',remoteRevision:'1'}),/フォルダ外/);
 });
 await test('Wrong Google account during code exchange refuses to save refresh token',async()=>{
  const p=instance();p.cfg.accessMode='shared';p.cfg.clientId='client';p.cfg.clientSecret='secret';
  p.cfg.expectedDedicatedEmail='sync@example.com';p.cfg.pendingByMode.shared={state:'q',time:Date.now(),pickMode:'shared',redirect:'https://example.org/cb',verifier:'v'};
  p.drive.about=async()=>({user:{emailAddress:'personal@example.com'}});
  tokenResponse=async()=>({status:200,json:{access_token:'access',expires_in:3600,refresh_token:'private-token'},text:''});
  await p.finishAuth({state:'q',code:'mock-code'});
  assert.equal(p.cfg.refreshToken,'');assert.equal(p.liveAccessToken,'');assert.match(p.cfg.lastAuthError,/一致しません/);
 });
 await test('Successful shared OAuth saves new refresh token and account identity',async()=>{
  const p=instance();p.cfg.accessMode='shared';p.cfg.clientId='client';p.cfg.clientSecret='secret';
  p.cfg.expectedDedicatedEmail='sync@example.com';p.cfg.pendingByMode.shared={state:'p',time:Date.now(),pickMode:'shared',redirect:'https://example.org/cb',verifier:'v'};
  tokenResponse=async()=>({status:200,json:{access_token:'access',expires_in:3600,refresh_token:'new-refresh'},text:''});
  await p.finishAuth({state:'p',code:'mock-code'});
  assert.equal(p.cfg.refreshToken,'new-refresh');assert.equal(p.cfg.connectedAccountEmail,'sync@example.com');assert.equal(p.cfg.needsReauth,false);
 });
 await test('OAuth success without refresh token cannot clear an expired state',async()=>{
  const p=instance();p.cfg.accessMode='shared';p.cfg.clientId='client';p.cfg.clientSecret='secret';
  p.cfg.expectedDedicatedEmail='sync@example.com';p.cfg.needsReauth=true;p.cfg.refreshToken='expired';
  p.cfg.pendingByMode.shared={state:'x',time:Date.now(),pickMode:'shared',redirect:'https://example.org/cb',verifier:'v'};
  tokenResponse=async()=>({status:200,json:{access_token:'access',expires_in:3600},text:''});
  await p.finishAuth({state:'x',code:'mock-code'});
  assert.equal(p.cfg.refreshToken,'expired');assert.equal(p.cfg.needsReauth,true);assert.match(p.cfg.lastAuthError,/更新用トークン/);
 });
 await test('Shared inventory checks signed-in account before reading files',async()=>{
  const p=instance();p.cfg.accessMode='shared';p.cfg.rootId='abcDEF0123456789';p.cfg.refreshToken='yes';
  p.cfg.expectedDedicatedEmail='sync@example.com';p.drive.about=async()=>({user:{emailAddress:'personal@example.com'}});
  p.drive.tree=async()=>{throw Error('Should not read file tree before identity verification')};
  await assert.rejects(p.inventory(),/安全停止/);
 });
 await test('Drive first remains the default; no deletions',()=>{
  assert.equal(DEFAULTS.initMode,'drive');assert.equal(DEFAULTS.autoEnabled,false);
  assert.equal(typeof DriveIO.prototype.trash,'undefined');
 });
 console.log('Shared-mode tests passed:',successes);
})().catch(e=>{console.error(e);process.exitCode=1});
