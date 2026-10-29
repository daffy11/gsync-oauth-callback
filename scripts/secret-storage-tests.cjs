'use strict';
const assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
const Module=require('node:module'), orig=Module._load;
class Plugin{
 constructor(){this.writes=[];this.data={};}
 async loadData(){return structuredClone(this.data);}
 async saveData(v){this.writes.push(structuredClone(v));this.data=structuredClone(v);}
 addSettingTab(){} addCommand(){} registerObsidianProtocolHandler(){} registerInterval(){}
}
class PluginSettingTab{} class TFile{} class Modal{} class Notice{constructor(){}}
Module._load=function(n,p,i){return n==='obsidian'?{Plugin,PluginSettingTab,TFile,Modal,Notice,requestUrl:async()=>{throw Error('Unexpected request')}}:orig.call(this,n,p,i)};
Object.defineProperty(global,'crypto',{value:webcrypto,configurable:true});
global.window={setInterval:()=>42,setTimeout:()=>0};
const G=require('../main.js');
const cases=[];const test=(n,fn)=>cases.push([n,fn]);
const store=()=>{const map=new Map();return {map,getSecret(k){return map.get(k)||null},setSecret(k,v){map.set(k,v)}}};
const instance=(vault,storage,existing)=>{const p=new G();p.data=existing||{};p.app={vault:{getName:()=>vault},secretStorage:storage,workspace:{onLayoutReady:()=>{}}};return p;};
test('Migrates legacy refresh token, secret, and PKCE to local SecretStorage',async()=>{
 const ss=store(),legacy={refreshToken:'refresh-private',clientSecret:'client-private',pendingByMode:{folder:{verifier:'pkce-private',state:'state-private'}},modeProfiles:{shared:{refreshToken:'shared-private'}}};
 const p=instance('A',ss,legacy);await p.onload();
 assert.equal(p.cfg.refreshToken,'refresh-private');
 assert.equal(p.data.refreshToken,'');assert.equal(p.data.clientSecret,'');assert.deepEqual(p.data.pendingByMode,{});
 assert.equal(p.data.modeProfiles.shared.refreshToken,undefined);
 const secret=ss.map.get(p.localAuthKey);
 for(const phrase of ['refresh-private','client-private','pkce-private','shared-private'])assert(secret.includes(phrase));
 const publicDump=JSON.stringify(p.data);
 for(const phrase of ['refresh-private','client-private','pkce-private','shared-private'])assert(!publicDump.includes(phrase));
});
test('Existing local secret takes priority over stale cloud-backed configuration',async()=>{
 const ss=store(),one=instance('A',ss,{refreshToken:'old-value'});await one.onload();
 ss.setSecret(one.localAuthKey,JSON.stringify({refreshToken:'new-device',clientSecret:'new-secret',pendingByMode:{},pending:null,profiles:{}}));
 const two=instance('A',ss,{localSecretId:one.cfg.localSecretId,refreshToken:'stale-cloud',clientSecret:'stale-cloud'});
 await two.onload();assert.equal(two.cfg.refreshToken,'new-device');assert.equal(two.cfg.clientSecret,'new-secret');assert.equal(two.data.refreshToken,'');
});
test('Two different vaults have different SecretStorage keys even on iOS',async()=>{
 const ss=store(),a=instance('A',ss,{refreshToken:'VAULT_A'}),b=instance('B',ss,{refreshToken:'VAULT_B'});
 await a.onload();await b.onload();assert.notEqual(a.localAuthKey,b.localAuthKey);
 assert(ss.map.get(a.localAuthKey).includes('VAULT_A'));assert(!ss.map.get(b.localAuthKey).includes('VAULT_A'));
});
test('When local storage is not available, credentials never leak into data.json',async()=>{
 const p=instance('A',null,{refreshToken:'do-not-persist'});
 await assert.rejects(p.onload(),/SecretStorage/);assert.equal(p.writes.length,0);
});
test('Storage failure halts settings write with no plaintext fallback',async()=>{
 const ss={getSecret:()=>null,setSecret:()=>{throw Error('keystore unavailable')}};
 const p=instance('A',ss,{refreshToken:'do-not-persist'});
 await assert.rejects(p.onload(),/keystore unavailable/);assert.equal(p.writes.length,0);
});
test('Malformed device-local auth record refuses to overwrite or fall back',async()=>{
 const ss=store(),fixed='a'.repeat(32),key='gsync-limited-auth-'+fixed;
 ss.map.set(key,'{malformed');
 const p=instance('A',ss,{localSecretId:fixed,refreshToken:'old'});
 await assert.rejects(p.onload(),/damaged/);assert.equal(p.writes.length,0);assert.equal(ss.map.get(key),'{malformed');
});
test('OAuth settings updates never leak credentials after initial migration',async()=>{
 const ss=store(),p=instance('A',ss,{refreshToken:'start'});await p.onload();
 p.cfg.refreshToken='rotated';p.cfg.clientSecret='secret-rotated';p.cfg.pendingByMode={shared:{verifier:'new-pkce'}};
 await p.save();const j=JSON.stringify(p.data);
 for(const secret of ['rotated','new-pkce'])assert(!j.includes(secret));
 const saved=JSON.parse(ss.map.get(p.localAuthKey));assert.equal(saved.refreshToken,'rotated');assert.equal(saved.clientSecret,'secret-rotated');
});
(async()=>{let n=0;for(const [label,fn] of cases){await fn();n++;console.log('PASS',label)}console.log('Validated',n,'SecretStorage migration cases');})().catch(e=>{console.error(e);process.exitCode=1});
