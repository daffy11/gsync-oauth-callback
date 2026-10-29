'use strict';
const assert=require('node:assert/strict');
const Module=require('node:module'),orig=Module._load;
class Plugin{};class PluginSettingTab{};class TFile{};class Modal{};class Notice {constructor(msg){}}
Module._load=function(n,p,i){if(n==='obsidian')return {Plugin,PluginSettingTab,TFile,Modal,Notice,requestUrl:async()=>{throw Error('No actual requests')}};return orig.call(this,n,p,i)};
const G=require('../main.js');
const {DEFAULTS}=G.__test;
Object.defineProperty(global,'crypto',{value:require('node:crypto').webcrypto,configurable:true});
const tests=[];
const check=(name,fn)=>tests.push([name,fn]);
function mock(){
 const p=new G();
 p.app={vault:{getName:()=> 'test-vault'}};
 p.cfg={...DEFAULTS,clientId:'test-id.apps.googleusercontent.com',clientSecret:'not-production-secret',redirectUri:'https://example.org/oauth',accessMode:'shared',expectedDedicatedEmail:'isolated@example.org',sharedAccountConfirmed:true,pendingByMode:{},selectedFiles:{},state:{},modeProfiles:{}};
 p.preparedAuth={};p.authPreparing={};p.invalidate=()=>{};p.save=async()=>{};p.tab={display(){}};
 return p;
}
check('First tap prepares OAuth and opens external browser',async()=>{
 const p=mock(),calls=[];
 const prev=globalThis.Capacitor;globalThis.Capacitor={Plugins:{InAppBrowser:{openInExternalBrowser({url}){calls.push(url);return Promise.resolve()}}}};
 try{
  await p.requestSignIn('shared');
  assert.equal(calls.length,1);
  const u=new URL(calls[0]);
  assert.equal(u.searchParams.get('scope'),'https://www.googleapis.com/auth/drive');
  assert(p.cfg.pendingByMode.shared.verifier);
 }finally{globalThis.Capacitor=prev}
});
check('Prepared URL reused and PKCE state stable',async()=>{
 const p=mock(),calls=[];
 const prev=globalThis.Capacitor;globalThis.Capacitor={Plugins:{InAppBrowser:{openInExternalBrowser({url}){calls.push(url);return Promise.resolve()}}}};
 try{
  await p.prepareAuth('shared');
  const before=p.cfg.pendingByMode.shared;
  await p.requestSignIn('shared');
  assert.equal(p.cfg.pendingByMode.shared,before);
  assert.equal(calls.length,1);
 }finally{globalThis.Capacitor=prev}
});
check('Full-drive authorization requires explicit separate-account confirmation',async()=>{
 const p=mock();p.cfg.sharedAccountConfirmed=false;
 await assert.rejects(p.requestSignIn('shared'),/別のGoogleアカウント/);
 await assert.rejects(p.prepareAuth('shared'),/別のGoogleアカウント/);
 assert.equal(Object.keys(p.cfg.pendingByMode).length,0);
});
check('Missing OAuth credentials get an explicit error',async()=>{
 const p=mock();p.cfg.clientId='';
 await assert.rejects(p.requestSignIn('shared'),/OAuthクライアントID/);
});
check('Limited mode does not request full Drive scope',async()=>{
 const p=mock();p.cfg.accessMode='limited';
 const calls=[],prev=globalThis.Capacitor;
 globalThis.Capacitor={Plugins:{InAppBrowser:{openInExternalBrowser({url}){calls.push(url);return Promise.resolve()}}}};
 try{
  await p.requestSignIn('folder');
  assert.equal(new URL(calls[0]).searchParams.get('scope'),'https://www.googleapis.com/auth/drive.file');
 }finally{globalThis.Capacitor=prev}
});
check('Mobile browser launch error is recorded',async()=>{
 const p=mock(),prev=globalThis.Capacitor;
 globalThis.Capacitor={Plugins:{InAppBrowser:{openInExternalBrowser(){return Promise.reject(Error('native link failed'))}}}};
 try{
  await p.requestSignIn('shared');
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(p.cfg.lastLoginError,/native link failed/);
 }finally{globalThis.Capacitor=prev}
});
(async()=>{let n=0;for(const [name,run] of tests){await run();console.log('PASS',name);n++}console.log(n+' OAuth launch/UX tests passed');})().catch(e=>{console.error(e);process.exitCode=1});
