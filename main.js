'use strict';
const SyncCore = (() => {
  const MODES = ['drive','local','both','skip'];
  const POLICIES = ['inherit',...MODES];
  const cleanPath = p => typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.includes('\\') && p.split('/').every(x=>x && x !== '.' && x !== '..' && !x.startsWith('.')) && !/[\x00-\x1f]/.test(p);
  const canonical = p => String(p||'').replace(/^\/+|\/+$/g,'');
  const priority = (path, folderRules, fallback) => {
    let best={length:-1,policy:fallback};
    for(const [raw,mode] of Object.entries(folderRules||{})) {
      const f=canonical(raw);if(!f||!POLICIES.includes(mode)||mode==='inherit')continue;
      if(path===f || path.startsWith(f+'/')) if(f.length>best.length)best={length:f.length,policy:mode};
    }
    return best.policy;
  };
  const excluded = (path, patterns) => String(patterns||'').split('\n').some(line=>{
    const rule=line.trim();if(!rule||rule.startsWith('#'))return false;
    if(rule.startsWith('*.'))return path.toLowerCase().endsWith(rule.slice(1).toLowerCase());
    if(rule.endsWith('/'))return path.startsWith(rule);
    return path===rule || path.startsWith(rule+'/');
  });
  const rev = f => [f.version||'',f.md5Checksum||'',f.modifiedTime||'',f.size||''].join('|');
  const localSignature = f => [f.stat?.mtime??'',f.stat?.size??''].join('|');
  const trackedLocalChanged = (local, record) => local.hash !== record.localHash;
  const trackedRemoteChanged = (remote, record) => rev(remote)!==record.remoteRev || remote.id!==record.remoteId;
  function decideFirst(path,local,remote,mode,localOnly,remoteOnly){
    if(local && remote){if(mode==='skip')return 'skip';if(mode==='drive')return 'drive-to-local';if(mode==='local')return 'local-to-drive';return 'keep-both';}
    if(local){if(mode==='skip')return 'skip';if(localOnly==='keep')return 'keep-local';return 'local-to-drive';}
    if(remote){if(mode==='skip')return 'skip';if(remoteOnly==='keep')return 'keep-remote';return 'drive-to-local';}
    return 'skip';
  }
  function buildPlan({local,remote,state={},initialized=false,initMode='drive',localOnly='keep',remoteOnly='download',conflict='both',rules={},excludes='',protectedLocal=[]}){
    const protectedSet=new Set(protectedLocal);
    const keys=new Set([...local.keys(),...remote.keys(),...Object.keys(state)]);
    const results=[];
    for(const path of [...keys].sort()) {
      if(!cleanPath(path)||excluded(path,excludes))continue;
      const l=local.get(path),r=remote.get(path),s=state[path];
      const mode=priority(path,rules,initialized?conflict:initMode);
      let action='skip',reason='';
      if(mode==='skip'){results.push({path,action:'skip',reason:'Excluded by folder rule',local:!!l,remote:!!r,remoteId:r?.id||null,remoteRevision:r?rev(r):null,localHash:l?.hash||null});continue;}
      if(!initialized) action=decideFirst(path,l,r,mode,localOnly,remoteOnly);
      else if(s){
        if(!r || r.id!==s.remoteId){action='BLOCK';reason='Known Drive item missing/invisible/moved; cannot infer deletion';}
        else if(!l){action='BLOCK';reason='Known local item missing; cannot infer deletion';}
        else{
          const lc=trackedLocalChanged(l,s),rc=trackedRemoteChanged(r,s);
          if(lc&&rc){action=mode==='drive'?'drive-to-local':mode==='local'?'local-to-drive':mode==='skip'?'skip':'keep-both';reason='Both changed';}
          else if(lc){action=mode==='skip'?'skip':'local-to-drive';reason='Local edited';}
          else if(rc){action=mode==='skip'?'skip':'drive-to-local';reason='Drive edited (possibly third-party)';}
        }
      } else if(l&&r){
        action=mode==='drive'?'drive-to-local':mode==='local'?'local-to-drive':mode==='skip'?'skip':'keep-both';reason='Previously untracked overlap';
      }else if(l){action=localOnly==='upload'&&!protectedSet.has(path)?'local-to-drive':'keep-local';reason='Local-only file';}
      else if(r){action=remoteOnly==='download'?'drive-to-local':'keep-remote';reason='Drive-only file';}
      if(protectedSet.has(path) && !initialized && !r) {action='keep-local';reason='Protected local-only file';}
      else if(protectedSet.has(path) && r && action!=='skip'){action='BLOCK';reason='Previously protected local-only item now overlaps a remote file; choose manually';}
      else if(protectedSet.has(path) && action==='local-to-drive'){action='BLOCK';reason='Protected local-only file';}
      results.push({path,action,reason,local:!!l,remote:!!r,remoteId:r?.id||null,remoteRevision:r?rev(r):null,localHash:l?.hash||null});
    }
    return results;
  }
  function groupedPaths(local,remote,rules={}){
    const folders=new Set(Object.keys(rules));
    for(const p of [...local.keys(),...remote.keys()]){
      const bits=p.split('/');for(let i=1;i<bits.length;i++)folders.add(bits.slice(0,i).join('/'));
    }
    return [...folders].filter(Boolean).sort();
  }
  function fingerprint(plan,rootId,policy){
    const payload=JSON.stringify({rootId,policy,plan:plan.map(p=>[p.path,p.action,p.remoteId,p.remoteRevision,p.localHash])});
    // Simple deterministic fingerprint used for SAME-process approval (not a cryptographic signature).
    let h=2166136261;for(let i=0;i<payload.length;i++){h^=payload.charCodeAt(i);h=Math.imul(h,16777619);}
    return (h>>>0).toString(16)+':'+payload.length;
  }
  const summary = plan => plan.reduce((a,p)=>(a[p.action]=(a[p.action]||0)+1,a),{});
  return {MODES,POLICIES,cleanPath,canonical,priority,excluded,rev,localSignature,buildPlan,groupedPaths,fingerprint,summary};
})();


'use strict';
const SCOPE='https://www.googleapis.com/auth/drive.file';
const AUTH='https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN='https://oauth2.googleapis.com/token';
const API='https://www.googleapis.com/drive/v3';
const UPLOAD='https://www.googleapis.com/upload/drive/v3';
const FOLDER='application/vnd.google-apps.folder';
const REDIRECT='https://daffy11.github.io/gsync-oauth-callback/limited-callback.html';
const form = v => new URLSearchParams(v).toString();
const b64 = b => btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const oauthUrl = async (clientId,redirect,vaultName,pickMode='folder') => {
  if(pickMode!=='folder' && pickMode!=='files')throw Error('Invalid Picker mode');
  const verifier=b64(crypto.getRandomValues(new Uint8Array(32)));
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
  const state=b64(crypto.getRandomValues(new Uint8Array(24)))+'~'+b64(new TextEncoder().encode(vaultName));
  const args={client_id:clientId,redirect_uri:redirect,response_type:'code',scope:SCOPE,code_challenge:b64(digest),code_challenge_method:'S256',access_type:'offline',prompt:'consent',state,trigger_onepick:'true',allow_multiple:pickMode==='files'?'true':'false',allow_folder_selection:pickMode==='folder'?'true':'false'};
  if(pickMode==='folder')args.mimetypes=FOLDER;
  return {url:AUTH+'?'+form(args),pending:{verifier,state,redirect,time:Date.now(),pickMode}};
};
class DriveIO {
  constructor(accessToken,request){this.getAccessToken=accessToken;this.request=request;}
  async send(url,method='GET',body,contentType){
    let attempt=0;
    while(true){
      const opts={url,method,throw:false,headers:{Authorization:'Bearer '+await this.getAccessToken()}};
      if(body!==undefined)opts.body=body;
      if(contentType)opts.contentType=contentType;
      const r=await this.request(opts);
      if([429,500,502,503,504].includes(r.status) && attempt++<3){await new Promise(res=>setTimeout(res,Math.min(6000,300*(2**attempt))));continue;}
      if(r.status<200||r.status>=300)throw Error('Drive API '+r.status+': '+String(r.text||'').slice(0,180));
      return r;
    }
  }
  async get(id){return (await this.send(API+'/files/'+encodeURIComponent(id)+'?fields='+encodeURIComponent('id,name,mimeType,parents,md5Checksum,modifiedTime,size,version,appProperties,trashed'))).json;}
  async list(id){
    let out=[],cursor='';
    do{
      const qs=new URLSearchParams({q:"'"+id.replace(/'/g,"\\'")+"' in parents and trashed = false",fields:'nextPageToken,files(id,name,mimeType,parents,md5Checksum,modifiedTime,size,version,appProperties)',pageSize:'1000',spaces:'drive'});
      if(cursor)qs.set('pageToken',cursor);
      const result=(await this.send(API+'/files?'+qs)).json;
      if(!Array.isArray(result.files))throw Error('Invalid Drive listing');
      out.push(...result.files);cursor=result.nextPageToken||'';
    }while(cursor);
    return out;
  }
  async createFolder(name,parent='root',mark=false){
    const body={name,mimeType:FOLDER,parents:[parent]};
    if(mark)body.appProperties={gsyncLimitedRoot:'1'};
    return (await this.send(API+'/files?fields='+encodeURIComponent('id,name,mimeType,parents,appProperties'),'POST',JSON.stringify(body),'application/json')).json;
  }
  async download(id){return (await this.send(API+'/files/'+encodeURIComponent(id)+'?alt=media')).arrayBuffer;}
  async upload(name,parent,data){
    const boundary='limited-'+b64(crypto.getRandomValues(new Uint8Array(12)));
    const head=new TextEncoder().encode('--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify({name,parents:[parent]})+'\r\n--'+boundary+'\r\nContent-Type: application/octet-stream\r\n\r\n');
    const tail=new TextEncoder().encode('\r\n--'+boundary+'--');
    const body=new Uint8Array(head.length+data.byteLength+tail.length);
    body.set(head);body.set(new Uint8Array(data),head.length);body.set(tail,head.length+data.byteLength);
    return (await this.send(UPLOAD+'/files?uploadType=multipart&fields='+encodeURIComponent('id,name,mimeType,parents,md5Checksum,modifiedTime,size,version'),'POST',body.buffer,'multipart/related; boundary='+boundary)).json;
  }
  async update(id,data){return (await this.send(UPLOAD+'/files/'+encodeURIComponent(id)+'?uploadType=media&fields='+encodeURIComponent('id,name,mimeType,parents,md5Checksum,modifiedTime,size,version'),'PATCH',data,'application/octet-stream')).json;}
  async tree(folderId,explicitFiles={}){
    const root=await this.get(folderId);
    if(root.trashed||root.mimeType!==FOLDER)throw Error('Drive root missing or not folder');
    const files=new Map(),folders=new Map([['',folderId]]),queue=[['',folderId]],seen=new Set();
    for(;queue.length;){
      const [prefix,id]=queue.shift();
      if(seen.has(id))throw Error('Folder graph repeated: '+id);
      seen.add(id);
      const children=await this.list(id);
      for(const f of children){
        if(!f.name||f.name==='.'||f.name==='..'||f.name.includes('/')||f.name.includes('\\'))throw Error('Unsafe Drive filename');
        const path=prefix?prefix+'/'+f.name:f.name;
        if(!SyncCore.cleanPath(path))continue;
        if(f.mimeType===FOLDER){if(folders.has(path))throw Error('Duplicate remote folder: '+path);folders.set(path,f.id);queue.push([path,f.id]);}
        else if(!f.mimeType.startsWith('application/vnd.google-apps.')){
          if(files.has(path))throw Error('Duplicate remote file: '+path);
          files.set(path,f);
        }
      }
    }
    // Individually selected files may not be returned by folder listing in all circumstances.
    // Only include ones whose FULL parent chain to the selected root can be verified.
    for(const id of Object.keys(explicitFiles)){
      const f=await this.get(id).catch(()=>null);
      if(!f||f.trashed||f.mimeType===FOLDER||f.mimeType.startsWith('application/vnd.google-apps.'))continue;
      let parents=f.parents||[],parts=[f.name],visited=new Set([id]),attached=false;
      for(let depth=0;parents.length && depth<32;depth++){
        const pid=parents[0];if(pid===folderId){attached=true;break;}
        if(visited.has(pid))break;visited.add(pid);
        const parent=await this.get(pid).catch(()=>null);
        if(!parent||parent.mimeType!==FOLDER)break;
        parts.unshift(parent.name);parents=parent.parents||[];
      }
      if(!attached)continue;
      const path=parts.join('/');if(!SyncCore.cleanPath(path))continue;
      if(files.has(path)&&files.get(path).id!==f.id)throw Error('Two remote files have same path: '+path);
      files.set(path,f);
    }
    return {files,folders,root};
  }
}

'use strict';
const {Plugin,PluginSettingTab,Setting,Notice,TFile,requestUrl,Modal} = require('obsidian');
const DEFAULTS={
  clientId:'',clientSecret:'',refreshToken:'',redirectUri:REDIRECT,pending:null,
  rootId:'',rootName:'',ownRoot:false,selectedFiles:{},
  initializedRoot:'',state:{},protectedLocal:[],
  initMode:'drive',localOnly:'keep',remoteOnly:'download',conflict:'both',rules:{},excludes:'# 1行につき1パス。例: Templates/\n',
  autoMinutes:0,autoEnabled:false,autoRemoteWrites:false,syncOnStartup:false,maxFileSizeMB:20,
  // The drive.file scope never guarantees folder-complete visibility. Keep writes off until explicit opt-in.
  allowRemoteWrites:false,
};
const randomId = () => b64(crypto.getRandomValues(new Uint8Array(9)));
const sha256 = async data => b64(new Uint8Array(await crypto.subtle.digest('SHA-256',data)));
function guardTokenResponse(r,operation){
  if(r.status!==200)throw Error(operation+' ('+r.status+'): '+String(r.text||'').slice(0,150));
  if(!r.json?.access_token)throw Error(operation+': no access token');
  return r.json;
}
function friendlyCounts(counts){return Object.entries(counts).map(([k,v])=>k+' '+v).join(', ') || 'no changes';}
class GSyncLimited extends Plugin {
  async onload(){
    const saved=await this.loadData()||{};
    this.cfg={...DEFAULTS,...saved,rules:{...(saved.rules||{})},state:saved.state||{},selectedFiles:saved.selectedFiles||{},protectedLocal:saved.protectedLocal||[]};
    this.liveAccessToken='';this.accessExpiry=0;this.busy=false;this.previewed=null;this.lastSync=0;
    this.drive=new DriveIO(()=>this.getAccess(),requestUrl);
    this.tab=new LimitedSettings(this.app,this);this.addSettingTab(this.tab);
    this.addCommand({id:'limited-preview',name:'Review proposed Drive sync (no changes)',callback:()=>void this.preview()});
    this.addCommand({id:'limited-apply',name:'Apply reviewed sync plan',callback:()=>void this.apply()});
    this.registerObsidianProtocolHandler('gsync-limited-auth',args=>void this.finishAuth(args));
    this.interval=window.setInterval(()=>{
      if(this.cfg.autoEnabled && this.cfg.autoMinutes>0 && Date.now()-this.lastSync>this.cfg.autoMinutes*60000)void this.autoRun();
    },60000);this.registerInterval(this.interval);
    if(this.cfg.syncOnStartup && this.cfg.autoEnabled)this.app.workspace.onLayoutReady(()=>window.setTimeout(()=>void this.autoRun(),8000));
  }
  async save(){await this.saveData(this.cfg);}
  invalidate(){this.previewed=null;}
  async requestSignIn(pickMode='folder'){
    if(pickMode==='files' && !this.cfg.rootId)throw Error('Select a root folder first.');
    if(!this.cfg.clientId||!this.cfg.clientSecret)throw Error('OAuth client ID / secret required');
    const tab=window.open('about:blank','_blank');
    try{
      const {url,pending}=await oauthUrl(this.cfg.clientId,this.cfg.redirectUri,this.app.vault.getName(),pickMode);
      this.cfg.pending=pending;await this.save();
      if(tab)tab.location.href=url;
      else {await navigator.clipboard.writeText(url);new Notice('Google sign-in URL copied. Open it in Safari.',8000);}
    }catch(e){tab?.close();throw e;}
  }
  async finishAuth(args){
    const p=this.cfg.pending;
    try{
      if(args.error)throw Error('Google: '+args.error);
      if(!p||Date.now()-p.time>15*60*1000||args.state!==p.state||!args.code)throw Error('Invalid/expired OAuth state');
      const result=guardTokenResponse(await requestUrl({url:TOKEN,method:'POST',contentType:'application/x-www-form-urlencoded',body:form({client_id:this.cfg.clientId,client_secret:this.cfg.clientSecret,code:args.code,code_verifier:p.verifier,redirect_uri:p.redirect,grant_type:'authorization_code'}),throw:false}),'Code exchange');
      this.liveAccessToken=result.access_token;this.accessExpiry=Date.now()+(result.expires_in-60)*1000;
      this.cfg.refreshToken=result.refresh_token||this.cfg.refreshToken;
      const picked=String(args.picked_file_ids||'').split(',').filter(Boolean);
      const selected=await Promise.all(picked.map(id=>this.drive.get(id)));
      const folders=selected.filter(file=>file.mimeType===FOLDER);
      const files=selected.filter(file=>file.mimeType!==FOLDER);
      const pickMode=p.pickMode||'folder';
      if(pickMode==='folder'){
        if(folders.length!==1||files.length)throw Error('Choose exactly one Drive FOLDER, not files.');
        const f=folders[0];
        if(this.cfg.rootId!==f.id){
          this.cfg.initializedRoot='';this.cfg.state={};this.cfg.protectedLocal=[];
          this.cfg.allowRemoteWrites=false;this.cfg.selectedFiles={};
        }
        this.cfg.rootId=f.id;this.cfg.rootName=f.name;
        this.cfg.ownRoot=f.appProperties?.gsyncLimitedRoot==='1';
        new Notice('Folder selected: '+f.name+'. Its child files are NOT automatically granted. Grant files separately.',16000);
      }else{
        if(folders.length)throw Error('Select files only in Add files flow.');
        for(const file of files){
          if(file.mimeType.startsWith('application/vnd.google-apps.'))continue;
          this.cfg.selectedFiles[file.id]={name:file.name};
        }
        new Notice('Granted '+files.length+' file(s). Only individually authorized files are guaranteed visible.',12000);
      }
      this.invalidate();
    }catch(e){new Notice('GSync Limited OAuth: '+e.message,16000);console.error('[gsync-limited]',e);}
    finally{this.cfg.pending=null;await this.save();this.tab.display();}
  }
  async getAccess(){
    if(this.liveAccessToken&&Date.now()<this.accessExpiry)return this.liveAccessToken;
    if(!this.cfg.refreshToken)throw Error('Google sign-in required');
    const result=guardTokenResponse(await requestUrl({url:TOKEN,method:'POST',contentType:'application/x-www-form-urlencoded',body:form({client_id:this.cfg.clientId,client_secret:this.cfg.clientSecret,refresh_token:this.cfg.refreshToken,grant_type:'refresh_token'}),throw:false}),'Token refresh');
    this.liveAccessToken=result.access_token;this.accessExpiry=Date.now()+(result.expires_in-60)*1000;return result.access_token;
  }
  async createOwnRoot(){
    if(!this.cfg.refreshToken)throw Error('Sign in first');
    if(this.cfg.rootId)throw Error('Root already selected. Change root only after exporting/backup and clearing root.');
    const name='GSync-Limited-'+this.app.vault.getName();
    const root=await this.drive.createFolder(name,'root',true);
    this.cfg.rootId=root.id;this.cfg.rootName=name;this.cfg.ownRoot=true;
    this.cfg.allowRemoteWrites=false;this.cfg.state={};this.cfg.protectedLocal=[];this.cfg.initializedRoot='';
    await this.save();this.tab.display();new Notice('New plugin-owned Drive folder created. Data is untouched.');
  }
  async localInventory(){
    const list=new Map();
    for(const f of this.app.vault.getFiles()){
      if(!SyncCore.cleanPath(f.path)||SyncCore.excluded(f.path,this.cfg.excludes))continue;
      if(f.stat.size>this.cfg.maxFileSizeMB*1048576)throw Error('Local file exceeds limit: '+f.path);
      list.set(f.path,{file:f,hash:await sha256(await this.app.vault.readBinary(f))});
    }
    return list;
  }
  async inventory(){
    if(!this.cfg.refreshToken||!this.cfg.rootId)throw Error('Sign in and select/create one Drive root folder first.');
    const tree=await this.drive.tree(this.cfg.rootId,this.cfg.selectedFiles);
    const local=await this.localInventory();
    for(const [path,r] of tree.files){
      if(!SyncCore.cleanPath(path))throw Error('Drive contains unsafe path: '+path);
      if(this.cfg.maxFileSizeMB>0 && Number(r.size||0)>this.cfg.maxFileSizeMB*1048576)throw Error('Drive file exceeds size limit: '+path);
    }
    return {tree,local};
  }
  plan(inv){
    return SyncCore.buildPlan({local:inv.local,remote:inv.tree.files,state:this.cfg.state,
      initialized:this.cfg.initializedRoot===this.cfg.rootId,
      initMode:this.cfg.initMode,localOnly:this.cfg.localOnly,remoteOnly:this.cfg.remoteOnly,
      conflict:this.cfg.conflict,rules:this.cfg.rules,excludes:this.cfg.excludes,protectedLocal:this.cfg.protectedLocal});
  }
  policy(){const s=this.cfg;return {initMode:s.initMode,localOnly:s.localOnly,remoteOnly:s.remoteOnly,conflict:s.conflict,rules:s.rules,excludes:s.excludes,allowRemoteWrites:s.allowRemoteWrites,initialized:s.initializedRoot===s.rootId};}
  async preview(){
    if(this.busy){new Notice('Another operation is running.');return;}
    this.busy=true;
    try{
      const inv=await this.inventory();const tasks=this.plan(inv);
      const digest=SyncCore.fingerprint(tasks,this.cfg.rootId,this.policy());
      this.previewed={digest,counts:SyncCore.summary(tasks),tasks,local:inv.local.size,remote:inv.tree.files.size,at:Date.now()};
      console.info('[gsync-limited] complete itemized preview',tasks);
      // Preview in modal with path and action, not just a count in console.
      new SyncPreviewModal(this.app,this.previewed).open();
      if(tasks.some(p=>p.action==='BLOCK'))new Notice('Blocked by missing/invisible files. No changes allowed.',10000);
      this.tab.display();
    }catch(e){this.invalidate();new Notice('Preview failed: '+e.message,17000);console.error('[gsync-limited]',e);}
    finally{this.busy=false;}
  }
  async addBackup(path,bytes,label){
    const base='.gsync-limited-backups/'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomId();
    const name=base+'/'+label+'/'+path;
    const dirs=name.split('/').slice(0,-1);let cur='';
    for(const part of dirs){cur=cur?cur+'/'+part:part;if(!await this.app.vault.adapter.exists(cur))await this.app.vault.adapter.mkdir(cur);}
    await this.app.vault.adapter.writeBinary(name,bytes);return name;
  }
  async writeLocal(path,data){
    if(!SyncCore.cleanPath(path))throw Error('Unsafe path');
    const dirs=path.split('/').slice(0,-1);let prefix='';
    for(const d of dirs){prefix=prefix?prefix+'/'+d:d;if(!this.app.vault.getAbstractFileByPath(prefix))await this.app.vault.createFolder(prefix);}
    const old=this.app.vault.getAbstractFileByPath(path);
    if(old instanceof TFile)await this.app.vault.modifyBinary(old,data);
    else if(old)throw Error('Directory/file name collision: '+path);
    else await this.app.vault.createBinary(path,data);
  }
  async record(path,r){
    const f=this.app.vault.getAbstractFileByPath(path);
    if(!(f instanceof TFile))throw Error('Cannot record missing file: '+path);
    const bytes=await this.app.vault.readBinary(f);
    this.cfg.state[path]={remoteId:r.id,remoteRev:SyncCore.rev(r),localHash:await sha256(bytes)};
    await this.save();
  }
  async assertUnchanged(task){
    if(task.local){
      const f=this.app.vault.getAbstractFileByPath(task.path);
      if(!(f instanceof TFile))throw Error('Local item disappeared: '+task.path);
      const now=await sha256(await this.app.vault.readBinary(f));
      if(now!==task.localHash)throw Error('Local file changed since review: '+task.path);
    }else if(this.app.vault.getAbstractFileByPath(task.path))throw Error('New local item since review: '+task.path);
    if(task.remote){
      const r=await this.drive.get(task.remoteId);
      if(r.trashed||SyncCore.rev(r)!==task.remoteRevision||r.id!==task.remoteId)throw Error('Drive item changed by another app since review: '+task.path);
    }
  }
  async getParent(path,folders){
    const names=path.split('/').slice(0,-1);
    let cur='',parent=this.cfg.rootId;
    for(const name of names){
      cur=cur?cur+'/'+name:name;
      if(!folders.has(cur)){
        if(!this.cfg.ownRoot)throw Error('Cannot create folders under externally managed Drive root');
        const f=await this.drive.createFolder(name,parent,false);
        folders.set(cur,f.id);
      }
      parent=folders.get(cur);
    }
    return parent;
  }
  async autoRun(){
    if(this.busy || !this.cfg.autoEnabled || !this.cfg.initializedRoot || this.cfg.initializedRoot!==this.cfg.rootId)return;
    // Only run automatic actions if explicitly configured; prevent write operations unless additionally approved.
    this.busy=true;
    try{
      const inv=await this.inventory(),tasks=this.plan(inv);
      if(tasks.some(t=>t.action==='BLOCK'))throw Error('Known file missing/invisible');
      if(tasks.some(t=>t.action==='local-to-drive') && (!this.cfg.autoRemoteWrites || !this.cfg.allowRemoteWrites || !this.cfg.ownRoot))throw Error('Automatic remote writes require a plugin-owned root; external roots require manual review');
      this.previewed={digest:SyncCore.fingerprint(tasks,this.cfg.rootId,this.policy()),tasks,at:Date.now(),counts:SyncCore.summary(tasks),local:inv.local.size,remote:inv.tree.files.size};
    }catch(e){this.invalidate();this.lastSync=Date.now();new Notice('GSync auto-sync paused: '+e.message,7000);return;}
    finally{this.busy=false;}
    await this.apply();
  }
  async apply(){
    if(this.busy){new Notice('Another operation is running.');return;}
    if(!this.previewed){new Notice('Review a fresh preview first.');return;}
    if(Date.now()-this.previewed.at>5*60*1000){this.invalidate();new Notice('Preview expired (5 min). Review again.');return;}
    this.busy=true;
    let completed=0;
    try{
      const inv=await this.inventory(),tasks=this.plan(inv);
      if(SyncCore.fingerprint(tasks,this.cfg.rootId,this.policy())!==this.previewed.digest)throw Error('Local or remote inventory changed. Re-review before applying.');
      if(tasks.some(t=>t.action==='BLOCK'))throw Error('Missing/invisible tracked items: cannot apply.');
      if(this.cfg.initializedRoot!==this.cfg.rootId && this.cfg.initMode==='drive' && inv.tree.files.size===0 && inv.local.size>0 && !this.cfg.ownRoot)throw Error('Drive-first cannot verify an empty externally managed root. Select individual files with Google Picker first.');
      const remoteWrites=tasks.filter(t=>t.action==='local-to-drive');
      if(remoteWrites.length && !this.cfg.allowRemoteWrites)throw Error('Enable explicit Drive write permission before applying.');
      if(remoteWrites.some(t=>!this.cfg.ownRoot && (!t.remote || !this.cfg.selectedFiles[t.remoteId])))throw Error('External Drive roots allow updates ONLY to files individually granted through Google Picker; new file creation is blocked.');
      // New files created by third-party apps may be invisible. The app-owned root is a necessary, not sufficient, safeguard.
      const init=this.cfg.initializedRoot!==this.cfg.rootId;
      if(init && this.cfg.initMode==='drive' && remoteWrites.length)throw Error('Drive-first must not write to remote');
      // Execution is intentionally serial, with per-file fresh checks to catch third-party edits.
      const held=new Set(this.cfg.protectedLocal||[]);
      for(const task of tasks){
        if(['skip','keep-local','keep-remote'].includes(task.action)){
          if(init&&task.action==='keep-local')held.add(task.path);
          continue;
        }
        if(task.action==='BLOCK')throw Error('Blocked path: '+task.path);
        await this.assertUnchanged(task);
        const path=task.path;const l=this.app.vault.getAbstractFileByPath(path);const r=inv.tree.files.get(path);
        if(task.action==='drive-to-local'){
          const bytes=await this.drive.download(r.id);
          await this.assertUnchanged(task); // Detect external editor changes during transfer.
          if(l instanceof TFile){const old=await this.app.vault.readBinary(l);
            if(await sha256(old)!==await sha256(bytes))await this.addBackup(path,old,'local-before-drive');
          }
          await this.writeLocal(path,bytes);await this.record(path,r);
        }else if(task.action==='local-to-drive'){
          if(!(l instanceof TFile))throw Error('Missing local file');
          const bytes=await this.app.vault.readBinary(l);
          if(r){
            const old=await this.drive.download(r.id);
            if(await sha256(old)!==await sha256(bytes))await this.addBackup(path,old,'remote-before-upload');
            // last-second metadata check; Drive has no transaction lock for concurrent edits here.
            await this.assertUnchanged(task);
            const updated=await this.drive.update(r.id,bytes);await this.record(path,updated);
          }else{
            const parent=await this.getParent(path,inv.tree.folders);
            // Check once again for a visible same-name file; invisible new files remain an API limitation.
            if((await this.drive.list(parent)).some(x=>x.name===path.split('/').at(-1)))throw Error('New remote path collision: '+path);
            const created=await this.drive.upload(path.split('/').at(-1),parent,bytes);
            await this.record(path,created);
          }
        }else if(task.action==='keep-both'){
          if(!(l instanceof TFile)||!r){continue;}
          const ld=await this.app.vault.readBinary(l),rd=await this.drive.download(r.id);
          await this.assertUnchanged(task);
          if(await sha256(ld)!==await sha256(rd)){
            const backup=await this.addBackup(path,ld,'local-conflict');
            await this.addBackup(path,rd,'drive-conflict');
            new Notice('Conflict backed up locally: '+path+' ('+backup+')',8000);
            // Canonical becomes remote; local version is retained as backup, Drive remains unchanged.
            await this.writeLocal(path,rd);
          }
          await this.record(path,r);
        }
        completed++;
      }
      if(init){this.cfg.initializedRoot=this.cfg.rootId;this.cfg.protectedLocal=[...held];await this.save();}
      this.lastSync=Date.now();
      new Notice('GSync Limited: applied '+completed+' actions. No deletions.',12000);
    }catch(e){new Notice('STOPPED after '+completed+' actions: '+e.message+'; inspect backups and re-preview.',17000);console.error('[gsync-limited] apply',e);}
    finally{this.invalidate();this.busy=false;this.tab.display();}
  }
}
class SyncPreviewModal extends Modal {
  constructor(app,p){super(app);this.p=p;}
  onOpen(){
    this.contentEl.empty();this.contentEl.createEl('h2',{text:'同期プレビュー（変更なし）'});
    this.contentEl.createEl('p',{text:'ローカル '+this.p.local+'件 / Google Driveで見えているファイル '+this.p.remote+'件。全ファイルが見えている保証はありません。'});
    this.contentEl.createEl('p',{text:friendlyCounts(this.p.counts)});
    const el=this.contentEl.createEl('div');el.style.maxHeight='50vh';el.style.overflowY='auto';
    for(const item of this.p.tasks.slice(0,500))el.createEl('div',{text:item.action+' : '+item.path+(item.reason?' ('+item.reason+')':'')});
    if(this.p.tasks.length>500)el.createEl('p',{text:'Only first 500 displayed; full plan logged to console.'});
    this.contentEl.createEl('p',{text:'実行するには閉じてから「プレビュー済みの計画を適用」を押してください。5分以内、対象が未変更の場合のみ実行します。'});
  }
  onClose(){this.contentEl.empty();}
}
class LimitedSettings extends PluginSettingTab {
  constructor(app,plugin){super(app,plugin);this.p=plugin;}
  display(){
    const el=this.containerEl;el.empty();const p=this.p,s=p.cfg;
    new Setting(el).setName('GSync Limited — scoped sync').setHeading();
    el.createEl('p',{text:'この版は drive.file のみにアクセスします。外部アプリが追加した新しいファイルは自動検出できない場合があります。同期前に Google Picker で許可して一覧を確認してください。削除同期・無確認の自動書き込みは行いません。'});
    const input=(name,key,secret=false)=>new Setting(el).setName(name).addText(t=>{if(secret)t.inputEl.type='password';t.setValue(String(s[key]||'')).onChange(async v=>{s[key]=v.trim();p.invalidate();await p.save();});});
    input('OAuth client ID','clientId');input('OAuth client secret','clientSecret',true);input('Sign-in redirect page','redirectUri');
    new Setting(el).setName('① 同期先フォルダを選択').setDesc('フォルダのみ表示。1つ選択します。フォルダへの許可は子ファイルへ自動的に広がりません。').addButton(b=>b.setButtonText('フォルダを選ぶ').onClick(()=>void p.requestSignIn('folder').catch(e=>new Notice(e.message,10000))));
    new Setting(el).setName('② 既存ファイルを個別許可').setDesc('Driveに保存済みのファイルは別途許可してください。外部アプリが今後追加するファイルも自動許可されません。').addButton(b=>b.setButtonText('ファイルを追加許可').setDisabled(!s.rootId).onClick(()=>void p.requestSignIn('files').catch(e=>new Notice(e.message,10000))));
    new Setting(el).setName('認証状態').setDesc(s.refreshToken?'Refresh token saved on this device':'Not authenticated');
    new Setting(el).setName('Driveルート').setDesc((s.rootName||'未設定')+' / '+(s.rootId||'')+' / '+(s.ownRoot?'プラグイン所有':'外部管理（書込禁止）'));
    new Setting(el).setName('新規の専用Driveルートを作成').addButton(b=>b.setButtonText('専用フォルダを作成').onClick(()=>void p.createOwnRoot().catch(e=>new Notice(e.message,12000))));
    new Setting(el).setName('初回の正本（同名ファイルの処理）').addDropdown(d=>d.addOptions({drive:'Google Drive優先',local:'iPhone優先（上書き注意）',both:'両方保護しDrive版を正本',skip:'同名を変更しない'}).setValue(s.initMode).onChange(async v=>{s.initMode=v;p.invalidate();await p.save();}));
    new Setting(el).setName('iPhoneにしかないファイル').addDropdown(d=>d.addOptions({keep:'iPhoneに保持（推奨）',upload:'Driveに追加（専用フォルダのみ）'}).setValue(s.localOnly).onChange(async v=>{s.localOnly=v;p.invalidate();await p.save();}));
    new Setting(el).setName('Driveにしかないファイル').addDropdown(d=>d.addOptions({download:'iPhoneへダウンロード',keep:'Driveのみに残す'}).setValue(s.remoteOnly).onChange(async v=>{s.remoteOnly=v;p.invalidate();await p.save();}));
    new Setting(el).setName('通常同期での両側編集時').addDropdown(d=>d.addOptions({both:'両方バックアップ・Driveを正本',drive:'Driveを正本（ローカル退避）',local:'iPhone優先（Drive退避）',skip:'変更せず保留'}).setValue(s.conflict).onChange(async v=>{s.conflict=v;p.invalidate();await p.save();}));
    new Setting(el).setName('Driveへの書き込みを許可').setDesc('初期値OFF。外部管理ルートではPickerで個別許可した既存ファイルへの手動更新のみ可。新規アップロードは禁止。').addToggle(t=>t.setValue(s.allowRemoteWrites).onChange(async v=>{s.allowRemoteWrites=v;p.invalidate();await p.save();}));
    new Setting(el).setName('除外パス（同期しない）').setDesc('1行に1件。フォルダは末尾 /、例: Archives/、ファイル種類 *.tmp').addTextArea(t=>{t.setValue(s.excludes).onChange(async v=>{s.excludes=v;p.invalidate();await p.save();});});
    new Setting(el).setName('フォルダ別ルール').setDesc('変更しないフォルダは「触らない」。優先先は競合時に適用し、それ以外の新しい変更は双方向に反映します。').setHeading();
    new Setting(el).setName('任意のフォルダをルールへ追加').setDesc('例えば Archives、Notes/Private など。フォルダは手入力で追加可能です。').addText(t=>t.setPlaceholder('Folder/Subfolder').onChange(v=>{p.folderDraft=v.trim().replace(/\\/g,'/').replace(/^\/+|\/+$/g,'');})).addButton(b=>b.setButtonText('追加').onClick(async()=>{const name=p.folderDraft||'';if(!SyncCore.cleanPath(name)){new Notice('Invalid path');return;}s.rules[name]='skip';p.invalidate();await p.save();this.display();}));
    const folderList=p.previewed ? [...new Set(p.previewed.tasks.flatMap(t=>{const bits=t.path.split('/');return bits.slice(0,-1).map((_,i)=>bits.slice(0,i+1).join('/'));}))].sort() : Object.keys(s.rules).sort();
    for(const folder of folderList.slice(0,120)){
      new Setting(el).setName(folder+'/').addDropdown(d=>d.addOptions({inherit:'基本ルール',drive:'競合時Drive優先',local:'競合時iPhone優先',both:'競合時両方保持',skip:'このフォルダを触らない'}).setValue(s.rules[folder]||'inherit').onChange(async v=>{if(v==='inherit')delete s.rules[folder];else s.rules[folder]=v;p.invalidate();await p.save();}));
    }
    new Setting(el).setName('自動同期（明示的に有効化した場合のみ）').setDesc('初期OFF。Obsidianが開いている間のみ差分を検証・同期。競合は双方退避。').addToggle(t=>t.setValue(!!s.autoEnabled).onChange(async v=>{s.autoEnabled=v;p.invalidate();await p.save();}));
    new Setting(el).setName('自動同期の間隔（分）').setDesc('0で無効。デフォルト無効。').addText(t=>t.setValue(String(s.autoMinutes)).onChange(async v=>{const n=Number.parseInt(v,10);s.autoMinutes=Number.isFinite(n)&&n>0?n:0;p.invalidate();await p.save();}));
    new Setting(el).setName('自動でDriveへ書き込む').setDesc('初期OFF。専用ルート＋Drive書き込み許可が必要。外部アプリと同時編集の完全排他はできません。').addToggle(t=>t.setValue(!!s.autoRemoteWrites).onChange(async v=>{s.autoRemoteWrites=v;p.invalidate();await p.save();}));
    new Setting(el).setName('起動時に自動同期').addToggle(t=>t.setValue(!!s.syncOnStartup).onChange(async v=>{s.syncOnStartup=v;await p.save();}));
    new Setting(el).setName('最大ファイルサイズ（MB）').addText(t=>t.setValue(String(s.maxFileSizeMB)).onChange(async v=>{const n=Number.parseInt(v,10);if(Number.isFinite(n)&&n>0){s.maxFileSizeMB=n;p.invalidate();await p.save();}}));
    new Setting(el).setName('同期プレビュー').setDesc('各ファイルの予定操作と件数を表示。実データは変更しません。').addButton(b=>b.setButtonText('差分を確認').onClick(()=>void p.preview()));
    new Setting(el).setName('プレビュー済みの計画を適用').setDesc('一度差分を確認し、5分以内に実行してください。外部編集が挟まると中断します。').addButton(b=>b.setButtonText('確認済み計画を実行').setDisabled(!p.previewed).onClick(()=>void p.apply()));
    new Setting(el).setName('初回状態').setDesc(s.rootId&&s.initializedRoot===s.rootId?'初期化済み':'未初期化（最初の適用で選択ルールを採用）');
    new Setting(el).setName('同期履歴の再作成').setDesc('同期状態を解除します。ファイルは削除しません。先にバックアップしてください。').addButton(b=>b.setButtonText('履歴をクリア').onClick(async()=>{s.state={};s.initializedRoot='';s.protectedLocal=[];p.invalidate();await p.save();new Notice('同期履歴をクリアしました。');}));
  }
}
module.exports=GSyncLimited;
module.exports.__test={SyncCore,DriveIO,oauthUrl,sha256,DEFAULTS,REDIRECT,SCOPE};

