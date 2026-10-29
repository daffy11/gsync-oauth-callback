'use strict';
const assert=require('node:assert/strict');
const Module=require('node:module');
const original=Module._load;
class Plugin{};class PluginSettingTab{};class TFile{};class Modal{};class Notice{constructor(){}}
Module._load=function(name,parent,isMain){
 if(name==='obsidian')return {Plugin,PluginSettingTab,TFile,Modal,Notice,requestUrl:async()=>{throw Error('No live OAuth calls in CI')}};
 return original.call(this,name,parent,isMain);
};
const source=require('node:fs').readFileSync('main.js','utf8');
const G=require('../main.js');
const {SyncCore:c,DriveIO,DEFAULTS,SCOPE,oauthUrl,sha256}=G.__test;
if(!c||!DEFAULTS)throw Error('Test exports not present');
Object.defineProperty(global,'crypto',{value:require('node:crypto').webcrypto,configurable:true});
const B=s=>new TextEncoder().encode(s).buffer;
let count=0;
const t=async(name,f)=>{await f();count++;console.log('PASS',name)};
(async()=>{
 await t('Google Drive file scope only',()=>assert.equal(SCOPE,'https://www.googleapis.com/auth/drive.file'));
 await t('No remote deletion API',()=>assert.equal(typeof DriveIO.prototype.trash,'undefined'));
 await t('Existing GSync Limited plugin id stable',()=>assert.match(source,/gsync-limited-auth/));
 await t('Setup has four required steps',()=>{
  for(let i=1;i<=4;i++)assert.ok(source.includes('必須設定 '+i+'/4'));
 });
 await t('Advanced settings are collapsed by default',()=>assert.ok(source.includes("el.createEl('details')")));
 await t('Status tells difference between visible files and grants',()=>{
  assert.ok(source.includes('0件はDriveのファイル総数ではありません'));
  assert.ok(source.includes('ファイル一覧を読み取る'));
 });
 await t('Read-only remote scan exists',()=>assert.equal(typeof G.prototype.scanRemoteReadOnly,'function'));
 await t('No automatic sync initially',()=>{assert.equal(DEFAULTS.autoEnabled,false);assert.equal(DEFAULTS.allowRemoteWrites,false);});
 await t('Hard-stop initial sync when external root has no individual grants',()=>assert.ok(source.includes('ファイルへの個別許可が0件です')));
 await t('Drive first local only keep as default',()=>{assert.equal(DEFAULTS.initMode,'drive');assert.equal(DEFAULTS.localOnly,'keep');});
 await t('Folder selection is separate from file selection',async()=>{
  const url=await oauthUrl('123-abc.apps.googleusercontent.com','https://example.com/cb','myvault','folder');
  const q=new URL(url.url).searchParams;
  assert.equal(q.get('allow_folder_selection'),'true');
  assert.equal(q.get('mimetypes'),'application/vnd.google-apps.folder');
 });
 await t('File picker does not claim folder grant',async()=>{
  const url=await oauthUrl('123-abc.apps.googleusercontent.com','https://example.com/cb','myvault','files');
  const q=new URL(url.url).searchParams;
  assert.equal(q.get('allow_folder_selection'),'false');
  assert.equal(q.get('mimetypes'),null);
 });
 await t('Defensive invalid path rejection',()=>{for(const path of ['../x','.obsidian/x','a//b','/a','a/..'])assert.equal(c.cleanPath(path),false);});
 await t('Drive first plans download, never upload initial same-name',()=>{const plan=c.buildPlan({local:new Map([['a.md',{hash:'a'}]]),remote:new Map([['a.md',{id:'1'}]]),initMode:'drive'});assert.equal(plan[0].action,'drive-to-local');});
 await t('No delete when known remote item becomes invisible',()=>{const plan=c.buildPlan({local:new Map([['a.md',{hash:'x'}]]),remote:new Map(),initialized:true,state:{'a.md':{remoteId:'id',localHash:'x',remoteRev:'v'}}});assert.equal(plan[0].action,'BLOCK');});
 await t('Third-party Drive revision changes are detected',()=>{const plan=c.buildPlan({local:new Map([['a.md',{hash:'old'}]]),remote:new Map([['a.md',{id:'id',version:'2'}]]),initialized:true,state:{'a.md':{remoteId:'id',localHash:'old',remoteRev:'1|||'}}});assert.equal(plan[0].action,'drive-to-local');});
 await t('Local same-size change has different hash',async()=>assert.notEqual(await sha256(B('ab')),await sha256(B('cd'))));
 await t('Previously protected local item is not auto-overwritten',()=>{const plan=c.buildPlan({local:new Map([['p.md',{hash:'x'}]]),remote:new Map([['p.md',{id:'1'}]]),initialized:true,protectedLocal:['p.md']});assert.equal(plan[0].action,'BLOCK');});
 console.log('Verified',count,'release smoke tests');
})().catch(e=>{console.error(e);process.exitCode=1});
