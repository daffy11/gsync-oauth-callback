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
const SHARED_SCOPE='https://www.googleapis.com/auth/drive';
const parseSharedFolderId = value => {
  const raw=String(value||'').trim();
  let id=raw;
  try {
    const u=new URL(raw);
    if(!['drive.google.com','docs.google.com'].includes(u.hostname))throw Error('Google DriveのフォルダURLを入力してください');
    const m=u.pathname.match(/\/folders\/([^/?#]+)/);
    id=m ? m[1] : u.searchParams.get('id')||'';
  }catch(e){
    if(raw.includes('://'))throw e;
  }
  if(!/^[a-zA-Z0-9_-]{10,}$/.test(id))throw Error('共有フォルダのURLまたはIDが正しくありません');
  return id;
};
const AUTH='https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN='https://oauth2.googleapis.com/token';
const API='https://www.googleapis.com/drive/v3';
const UPLOAD='https://www.googleapis.com/upload/drive/v3';
const FOLDER='application/vnd.google-apps.folder';
const REDIRECT='https://daffy11.github.io/gsync-oauth-callback/limited-callback.html';
const form = v => new URLSearchParams(v).toString();
const b64 = b => btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const oauthUrl = async (clientId,redirect,vaultName,pickMode='folder') => {
  if(!['folder','files','shared','reauth'].includes(pickMode))throw Error('Invalid Picker mode');
  const verifier=b64(crypto.getRandomValues(new Uint8Array(32)));
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
  const state=b64(crypto.getRandomValues(new Uint8Array(24)))+'~'+b64(new TextEncoder().encode(vaultName));
  const args={client_id:clientId,redirect_uri:redirect,response_type:'code',scope:pickMode==='shared'?SHARED_SCOPE:SCOPE,code_challenge:b64(digest),code_challenge_method:'S256',access_type:'offline',prompt:'consent',state,trigger_onepick:'true',allow_multiple:pickMode==='files'?'true':'false',allow_folder_selection:pickMode==='folder'?'true':'false'};
  if(pickMode==='shared'||pickMode==='reauth'){
    delete args.trigger_onepick;delete args.allow_multiple;delete args.allow_folder_selection;
  }
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
  async get(id){return (await this.send(API+'/files/'+encodeURIComponent(id)+'?fields='+encodeURIComponent('id,name,mimeType,parents,md5Checksum,modifiedTime,size,version,appProperties,trashed,capabilities(canAddChildren,canEdit)'))).json;}
  async about(){
    const r=await this.send(API+'/about?fields='+encodeURIComponent('user(emailAddress,displayName)'));
    return r.json;
  }
  async isInsideRoot(id,rootId){
    let current=id,visited=new Set();
    for(let depth=0;depth<48;depth++){
      if(current===rootId)return true;
      if(visited.has(current))return false;
      visited.add(current);
      const f=await this.get(current);
      current=(f.parents||[])[0];
      if(!current)return false;
    }
    return false;
  }
  async listSharedFolders(){
    const out=[];let page='';
    do{
      const qs=new URLSearchParams({
        q:"sharedWithMe = true and mimeType = '"+FOLDER+"' and trashed = false",
        fields:'nextPageToken,files(id,name,mimeType,capabilities(canAddChildren),webViewLink)',
        spaces:'drive',pageSize:'1000'
      });
      if(page)qs.set('pageToken',page);
      const r=(await this.send(API+'/files?'+qs)).json;
      out.push(...(r.files||[]));page=r.nextPageToken||'';
    }while(page);
    return out;
  }
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
  lastAuthCheck:0,lastAuthError:'',lastSyncAt:0,lastSyncResult:'',lastSyncError:'',pendingByMode:{},lastScanAt:0,lastScanRoot:'',lastVisibleFileCount:null,lastVisibleFolderCount:null,lastScanError:'',
  accessMode:'limited',modeProfiles:{},expectedDedicatedEmail:'',connectedAccountEmail:'',testingMode:true,authGrantedAt:0,needsReauth:false,reauthReason:'',lastExpiryAlertAt:0
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
    this.cfg={...DEFAULTS,...saved,rules:{...(saved.rules||{})},state:saved.state||{},selectedFiles:saved.selectedFiles||{},protectedLocal:saved.protectedLocal||[],pendingByMode:saved.pendingByMode||{}};
    this.liveAccessToken='';this.accessExpiry=0;this.busy=false;this.previewed=null;this.lastSync=0;
    this.drive=new DriveIO(()=>this.getAccess(),requestUrl);this.preparedAuth={};this.authPreparing={};
    this.tab=new LimitedSettings(this.app,this);this.addSettingTab(this.tab);
    this.addCommand({id:'limited-preview',name:'Review proposed Drive sync (no changes)',callback:()=>void this.preview()});
    this.addCommand({id:'limited-apply',name:'Apply reviewed sync plan',callback:()=>void this.apply()});
    this.registerObsidianProtocolHandler('gsync-limited-auth',args=>void this.finishAuth(args));
    this.interval=window.setInterval(()=>{
      if(this.cfg.autoEnabled && this.cfg.autoMinutes>0 && Date.now()-this.lastSync>this.cfg.autoMinutes*60000)void this.autoRun();
    },60000);this.registerInterval(this.interval);
    if(this.cfg.syncOnStartup && this.cfg.autoEnabled)this.app.workspace.onLayoutReady(()=>window.setTimeout(()=>void this.autoRun(),8000));
    // An iPhone plugin cannot push a notification while Obsidian is closed.
    // Check the actual refresh token after opening Obsidian and periodically while it is active.
    this.app.workspace.onLayoutReady(()=>window.setTimeout(()=>void this.checkAuthHealth(),2200));
    this.registerInterval(window.setInterval(()=>void this.checkAuthHealth(),6*60*60*1000));
  }
  async save(){await this.saveData(this.cfg);}
  invalidate(){this.previewed=null;}
  async switchAccessMode(mode){
    if(!['limited','shared'].includes(mode))throw Error('Invalid sync mode');
    const from=this.cfg.accessMode||'limited';
    if(mode===from)return;
    const fields=['refreshToken','rootId','rootName','ownRoot','selectedFiles','initializedRoot','state','protectedLocal','allowRemoteWrites','lastScanAt','lastScanRoot','lastVisibleFileCount','lastVisibleFolderCount','lastSyncAt','lastSyncResult','lastSyncError','expectedDedicatedEmail','connectedAccountEmail','authGrantedAt','needsReauth','reauthReason','lastAuthCheck'];
    this.cfg.modeProfiles=this.cfg.modeProfiles||{};
    this.cfg.modeProfiles[from]=Object.fromEntries(fields.map(k=>[k,this.cfg[k]]));
    const target=this.cfg.modeProfiles[mode]||{};
    for(const k of fields)this.cfg[k]=Object.prototype.hasOwnProperty.call(target,k)?target[k]:DEFAULTS[k];
    this.cfg.accessMode=mode;
    this.cfg.pendingByMode={};this.preparedAuth={};this.authPreparing={};
    this.liveAccessToken='';this.accessExpiry=0;this.invalidate();
    await this.save();this.tab.display();
    new Notice(mode==='shared'?'専用Googleアカウントモードに切り替えました。対象アカウントで認証してください。':'個別ファイル許可モードに戻しました。',9000);
  }
  async checkAuthHealth(){
    if(!this.cfg.refreshToken)return;
    if(this.cfg.needsReauth){
      if(Date.now()-this.cfg.lastExpiryAlertAt>6*60*60*1000){
        this.cfg.lastExpiryAlertAt=Date.now();await this.save();
        new Notice('GSync Limited: Googleの認証期限が切れています。設定から「再認証」を実行してください。',16000);
      }
      return;
    }
    try{await this.getAccess();}catch(e){
      console.warn('[gsync-limited] auth health',e);
      if(this.cfg.needsReauth){
        this.cfg.lastExpiryAlertAt=Date.now();await this.save();
        new Notice('GSync Limited: Google認証が失効しました。設定画面から再認証してください。',17000);
        this.tab.display();
      }
    }
  }
  async assertDedicatedAccount(){
    if(this.cfg.accessMode!=='shared')return;
    const expected=String(this.cfg.expectedDedicatedEmail||'').trim().toLowerCase();
    if(!expected)throw Error('同期専用アカウントのメールアドレスが未設定です');
    const result=await this.drive.about();
    const actual=String(result.user?.emailAddress||'').trim().toLowerCase();
    if(actual!==expected)throw Error('安全停止: 現在のGoogle認証アカウントが専用アカウントと一致しません（'+(actual||'不明')+'）');
    this.cfg.connectedAccountEmail=actual;
  }
  async selectSharedRoot(input){
    if(this.cfg.accessMode!=='shared')throw Error('共有フォルダモードでのみ指定できます');
    if(this.cfg.needsReauth||!this.cfg.refreshToken)throw Error('先に専用Googleアカウントで認証してください');
    await this.assertDedicatedAccount();
    const id=parseSharedFolderId(input);
    const f=await this.drive.get(id);
    if(f.trashed||f.mimeType!==FOLDER)throw Error('アクセス可能なフォルダではありません');
    if(f.capabilities?.canAddChildren!==true)throw Error('共有フォルダの「編集者」権限がありません。共有設定を確認してください');
    await this.drive.list(id); // Verify list permission before accepting it.
    if(id!==this.cfg.rootId){
      this.cfg.state={};this.cfg.initializedRoot='';this.cfg.protectedLocal=[];
      this.cfg.allowRemoteWrites=false;this.cfg.selectedFiles={};
      this.cfg.lastScanAt=0;this.cfg.lastScanRoot='';this.cfg.lastVisibleFileCount=null;
    }
    this.cfg.rootId=id;this.cfg.rootName=f.name;this.cfg.ownRoot=false;
    this.invalidate();await this.save();this.tab.display();
    new Notice('共有フォルダ '+f.name+' を登録しました。次にファイル一覧を確認してください。',12000);
  }
  async discoverSharedFolders(){
    if(this.cfg.accessMode!=='shared')throw Error('共有フォルダモードでのみ利用できます');
    await this.assertDedicatedAccount();
    this.sharedCandidates=await this.drive.listSharedFolders();
    this.tab.display();
    new Notice('共有フォルダを '+this.sharedCandidates.length+' 件取得しました。',8000);
  }
  async prepareAuth(pickMode='folder'){
    if(!['folder','files','shared','reauth'].includes(pickMode))throw Error('Invalid OAuth mode');
    if(this.cfg.accessMode==='shared'&&pickMode!=='shared')throw Error('共有モードでは専用アカウント認証のみ使用します');
    if(this.cfg.accessMode!=='shared'&&pickMode==='shared')throw Error('限定モードでは共有アカウント認証を使用しません');
    if(!this.cfg.clientId||!this.cfg.clientSecret)return false;
    if(this.authPreparing[pickMode])return this.authPreparing[pickMode];
    const job=(async()=>{
      const entry=this.preparedAuth[pickMode],key=this.cfg.clientId+'|'+this.cfg.redirectUri;
      if(entry&&entry.key===key&&Date.now()-entry.pending.time<12*60000)return true;
      const {url,pending}=await oauthUrl(this.cfg.clientId,this.cfg.redirectUri,this.app.vault.getName(),pickMode);
      this.preparedAuth[pickMode]={url,pending,key};
      this.cfg.pendingByMode[pickMode]=pending;
      await this.save();
      return true;
    })();
    this.authPreparing[pickMode]=job;
    try{return await job;}finally{delete this.authPreparing[pickMode];}
  }
  async requestSignIn(pickMode='folder'){
    if(pickMode==='files'&&!this.cfg.rootId)throw Error('先にフォルダを選択してください');
    if(pickMode==='shared'&&!this.cfg.expectedDedicatedEmail)throw Error('同期専用Googleアカウントのメールアドレスを先に設定してください');
    if(!this.cfg.clientId||!this.cfg.clientSecret)throw Error('OAuthクライアントIDとシークレットを入力してください');
    const entry=this.preparedAuth[pickMode],key=this.cfg.clientId+'|'+this.cfg.redirectUri;
    if(!entry||entry.key!==key||Date.now()-entry.pending.time>=12*60000){
      void this.prepareAuth(pickMode);
      throw Error('認証リンクを準備中です。少し経ってからもう一度押してください。');
    }
    // Launch during the tap, not after an async request/blank in-app tab.
    // The saved PKCE verifier must not be regenerated during the browser trip.
    const url=entry.url;
    const external=globalThis.Capacitor?.Plugins?.InAppBrowser;
    if(typeof external?.openInExternalBrowser==='function'){
      try{
        const promise=external.openInExternalBrowser({url});
        Promise.resolve(promise).catch(e=>console.warn('[gsync-limited] external browser',e));
        new Notice('外部ブラウザでGoogle認証を続けてください。',7000);
        return;
      }catch(e){console.warn('[gsync-limited] native browser',e);}
    }
    let opened;
    try{opened=window.open(url,'_system');}catch(e){console.warn('[gsync-limited] system open',e);}
    if(!opened)new Notice('ブラウザを開けなかった場合は「認証URLをコピー」を使ってください。',10000);
    else new Notice('Google認証画面を開きました。アプリ内表示になる場合はURLコピーも利用できます。',8000);
  }
  async copySignInUrl(pickMode='folder'){
    if(!await this.prepareAuth(pickMode))throw Error('OAuthの設定を確認してください');
    await navigator.clipboard.writeText(this.preparedAuth[pickMode].url);
    new Notice('認証URLをコピーしました。既定ブラウザへ貼り付けてください。',9500);
  }
  async verifyConnection(){
    if(!this.cfg.refreshToken)throw Error('認証情報がありません');
    try{
      await this.getAccess();
      if(this.cfg.accessMode==='shared'){
        if(!this.cfg.expectedDedicatedEmail)throw Error('同期専用メールアドレスを入力してください');
        const about=await this.drive.about();
        const actual=String(about.user?.emailAddress||'').toLowerCase();
        if(!actual||actual!==this.cfg.expectedDedicatedEmail.trim().toLowerCase())throw Error('Googleアカウントが同期専用のものと一致しません: '+(actual||'不明'));
        this.cfg.connectedAccountEmail=actual;
      }
      if(this.cfg.rootId){
        const root=await this.drive.get(this.cfg.rootId);
        if(root.trashed||root.mimeType!==FOLDER)throw Error('同期先フォルダにアクセスできません');
      }
      this.cfg.lastAuthCheck=Date.now();this.cfg.lastAuthError='';
      await this.save();new Notice('Googleとの接続を確認しました。',8000);
    }catch(e){this.cfg.lastAuthCheck=0;this.cfg.lastAuthError=String(e.message||e);await this.save();throw e;}
    finally{this.tab.display();}
  }
  async scanRemoteReadOnly(){
    if(!this.cfg.refreshToken||!this.cfg.rootId)throw Error('先にGoogle認証とフォルダ選択が必要です。');
    try{
      await this.assertDedicatedAccount();
      const tree=await this.drive.tree(this.cfg.rootId,this.cfg.accessMode==='shared'?{}:this.cfg.selectedFiles);
      this.cfg.lastScanAt=Date.now();
      this.cfg.lastScanRoot=this.cfg.rootId;
      this.cfg.lastVisibleFileCount=tree.files.size;
      this.cfg.lastVisibleFolderCount=Math.max(0,tree.folders.size-1);
      this.cfg.lastScanError='';
      await this.save();
      new Notice('Driveから見つかったファイル: '+tree.files.size+'件'+(this.cfg.accessMode==='shared'?'（共有フォルダ内）':'（個別許可の範囲）'),12000);
    }catch(e){
      this.cfg.lastScanError=String(e.message||e);
      await this.save();
      throw e;
    }finally{this.tab.display();}
  }
  async finishAuth(args){
    const matched=Object.entries(this.cfg.pendingByMode||{}).find(([,v])=>v.state===args.state);
    const p=matched?.[1]||null;
    try{
      if(args.error)throw Error('Google: '+args.error);
      if(!p||Date.now()-p.time>15*60*1000||args.state!==p.state||!args.code)throw Error('Invalid/expired OAuth state');
      const result=guardTokenResponse(await requestUrl({url:TOKEN,method:'POST',contentType:'application/x-www-form-urlencoded',body:form({client_id:this.cfg.clientId,client_secret:this.cfg.clientSecret,code:args.code,code_verifier:p.verifier,redirect_uri:p.redirect,grant_type:'authorization_code'}),throw:false}),'Code exchange');
      this.liveAccessToken=result.access_token;this.accessExpiry=Date.now()+(result.expires_in-60)*1000;
      if(p.pickMode==='shared'){
        const about=await this.drive.about();
        const actual=String(about.user?.emailAddress||'').toLowerCase();
        const expected=String(this.cfg.expectedDedicatedEmail||'').trim().toLowerCase();
        if(!expected||actual!==expected){
          this.liveAccessToken='';this.accessExpiry=0;
          throw Error('専用アカウントが一致しません。認証を許可したアカウント: '+(actual||'取得不可')+'。誤ってメインアカウントで許可した場合はGoogleの接続管理で取り消してください。');
        }
        this.cfg.connectedAccountEmail=actual;
      }
      if(p.pickMode==='shared' && !result.refresh_token && (!this.cfg.refreshToken||this.cfg.needsReauth)){
        this.liveAccessToken='';this.accessExpiry=0;
        throw Error('Googleから更新用トークンが発行されませんでした。Googleの接続管理で旧アプリ許可を取り消して再認証してください。');
      }
      this.cfg.refreshToken=result.refresh_token||this.cfg.refreshToken;
      this.cfg.needsReauth=false;this.cfg.reauthReason='';this.cfg.authGrantedAt=Date.now();
      this.cfg.lastAuthCheck=Date.now();this.cfg.lastAuthError='';
      if(p.pickMode==='shared'||p.pickMode==='reauth'){
        this.invalidate();
        new Notice(p.pickMode==='shared'?'同期専用Googleアカウントの認証が完了しました。':'Googleを再認証しました。',10000);
        return;
      }
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
          this.cfg.allowRemoteWrites=false;this.cfg.selectedFiles={};this.cfg.lastScanAt=0;this.cfg.lastScanRoot='';this.cfg.lastVisibleFileCount=null;this.cfg.lastVisibleFolderCount=null;
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
      this.cfg.lastScanAt=0;this.cfg.lastScanRoot='';
      this.invalidate();
    }catch(e){this.cfg.lastAuthError=String(e.message||e);new Notice('GSync Limited OAuth: '+e.message,16000);console.error('[gsync-limited]',e);}
    finally{if(matched){delete this.cfg.pendingByMode[matched[0]];delete this.preparedAuth[matched[0]];}this.cfg.pending=null;await this.save();this.tab.display();}
  }
  async getAccess(){
    if(this.cfg.needsReauth)throw Error('Google認証が期限切れです。GSync Limited設定から再認証してください。');
    if(this.liveAccessToken&&Date.now()<this.accessExpiry)return this.liveAccessToken;
    if(!this.cfg.refreshToken)throw Error('Google sign-in required');
    const r=await requestUrl({
      url:TOKEN,method:'POST',contentType:'application/x-www-form-urlencoded',
      body:form({client_id:this.cfg.clientId,client_secret:this.cfg.clientSecret,refresh_token:this.cfg.refreshToken,grant_type:'refresh_token'}),
      throw:false
    });
    if(r.status!==200){
      const expired=r.json?.error==='invalid_grant'||String(r.text||'').includes('invalid_grant');
      if(expired){
        this.cfg.needsReauth=true;
        this.cfg.reauthReason='Googleがリフレッシュトークンを無効と判定しました（テスト中のOAuthなら原則7日で失効）。';
        this.cfg.lastAuthError=this.cfg.reauthReason;
        this.liveAccessToken='';this.accessExpiry=0;this.invalidate();await this.save();
        this.tab.display();
        throw Error(this.cfg.reauthReason+' 「再認証」を押してください。');
      }
      throw Error('Google token refresh failed ('+r.status+'): '+String(r.text||'').slice(0,180));
    }
    const result=guardTokenResponse(r,'Token refresh');
    this.liveAccessToken=result.access_token;
    this.accessExpiry=Date.now()+(result.expires_in-60)*1000;
    return result.access_token;
  }
  async createOwnRoot(){
    if(this.cfg.accessMode==='shared')throw Error('共有フォルダモードでは既存の共有フォルダを指定してください');
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
    await this.assertDedicatedAccount();
    const tree=await this.drive.tree(this.cfg.rootId,this.cfg.accessMode==='shared'?{}:this.cfg.selectedFiles);
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
      if(this.cfg.accessMode==='shared'&&!(await this.drive.isInsideRoot(task.remoteId,this.cfg.rootId)))
        throw Error('共有フォルダ外へ移動したファイルには操作しません: '+task.path);
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
        if(!this.cfg.ownRoot&&this.cfg.accessMode!=='shared')throw Error('Cannot create folders under externally managed Drive root');
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
      if(tasks.some(t=>t.action==='local-to-drive') && (!this.cfg.autoRemoteWrites || !this.cfg.allowRemoteWrites || !this.cfg.ownRoot && this.cfg.accessMode!=='shared'))throw Error('Automatic remote writes require explicitly authorized shared mode or plugin-owned root');
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
      if(this.cfg.initializedRoot!==this.cfg.rootId && this.cfg.initMode==='drive' && inv.tree.files.size===0 && inv.local.size>0 && !this.cfg.ownRoot && this.cfg.accessMode!=='shared')throw Error('Drive-first cannot verify an empty externally managed root. Select individual files with Google Picker first.');
      const init=this.cfg.initializedRoot!==this.cfg.rootId;
      if(init&&!this.cfg.ownRoot&&this.cfg.accessMode!=='shared'&&Object.keys(this.cfg.selectedFiles||{}).length===0){
        throw Error('既存のDriveフォルダ: ファイルへの個別許可が0件です。見えないファイルを空と誤認する危険があるため、初回同期を停止しました。');
      }
      const remoteWrites=tasks.filter(t=>t.action==='local-to-drive');
      if(remoteWrites.length && !this.cfg.allowRemoteWrites)throw Error('Enable explicit Drive write permission before applying.');
      if(remoteWrites.some(t=>this.cfg.accessMode!=='shared'&&!this.cfg.ownRoot && (!t.remote || !this.cfg.selectedFiles[t.remoteId])))throw Error('External Drive roots allow updates ONLY to files individually granted through Google Picker; new file creation is blocked.');
      // New files created by third-party apps may be invisible. The app-owned root is a necessary, not sufficient, safeguard.
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
      this.lastSync=Date.now();this.cfg.lastSyncAt=this.lastSync;this.cfg.lastSyncResult='同期 '+completed+'件（削除なし）';this.cfg.lastSyncError='';await this.save();
      new Notice('GSync Limited: applied '+completed+' actions. No deletions.',12000);
    }catch(e){this.cfg.lastSyncError='中止（'+completed+'件の処理後）: '+e.message;await this.save();new Notice('STOPPED after '+completed+' actions: '+e.message+'; inspect backups and re-preview.',17000);console.error('[gsync-limited] apply',e);}
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
    new Setting(el).setName('GSync Limited — 同期セットアップ').setHeading();
    const date=ms=>ms?new Date(ms).toLocaleString('ja-JP'):'未確認';
    const box=(title,detail,kind='info')=>{
      const elem=el.createDiv({cls:'gsync-limited-status'});
      elem.style.padding='7px 10px';elem.style.marginBottom='4px';elem.style.borderRadius='6px';
      elem.style.border='1px solid var(--background-modifier-border)';
      elem.style.borderLeft='4px solid '+(kind==='ok'?'var(--color-green)':kind==='warn'?'var(--color-orange)':'var(--interactive-accent)');
      elem.createEl('strong',{text:title});elem.createEl('div',{text:detail,cls:'setting-item-description'});
    };
    const hasAuth=!!s.refreshToken,hasFolder=!!s.rootId,initialized=hasFolder&&s.initializedRoot===s.rootId;
    const grantCount=Object.keys(s.selectedFiles||{}).length;
    const reviewed=!!(p.previewed&&Date.now()-p.previewed.at<5*60000);
    const scanned=hasFolder&&s.lastScanAt>0&&s.lastScanRoot===s.rootId;
    const visible=scanned?s.lastVisibleFileCount:null;
    el.createEl('p',{text:'初回同期は自動で実行されません。①アクセス権を確認 → ②同期対象を確認 → ③ルールを選択 → ④差分確認 → ⑤適用、の順に進めます。'});
    new Setting(el).setName('同期方式').setDesc('新方式は専用Googleアカウントの共有フォルダを使用します。OAuthには専用アカウントのDrive全体への権限が必要です。').addDropdown(d=>d.addOptions({shared:'専用Googleアカウント＋共有フォルダ',limited:'個別ファイル許可（旧方式）'}).setValue(s.accessMode||'limited').onChange(v=>void p.switchAccessMode(v)));
    const shared=(s.accessMode||'limited')==='shared';
    new Setting(el).setName('現在のセットアップ状況').setHeading();
    box('① Google認証: '+(s.needsReauth?'更新が必要':hasAuth?'済み':'未完了'),s.needsReauth?'Google認証が失効しました。下の「再認証」を実行してください。':hasAuth?(s.lastAuthCheck?'Google接続確認: '+date(s.lastAuthCheck):'トークンは保存済み。接続テストが必要です。'):'OAuth設定とログインが必要です。',hasAuth&&s.lastAuthCheck&&!s.needsReauth?'ok':'warn');
    if(s.lastAuthError)box('認証の前回エラー',s.lastAuthError,'warn');
    box('② 同期先フォルダ: '+(hasFolder?'選択済み':'未選択'),hasFolder?s.rootName+'（'+(s.ownRoot?'プラグイン専用':'既存のDriveフォルダ')+'）':'Google Driveからフォルダを選択してください。',hasFolder?'ok':'warn');
    if(shared)box('③ 共有フォルダの内容',hasFolder?(scanned?'取得済み: '+visible+'件（'+date(s.lastScanAt)+'）':'一覧をまだ取得していません'):'共有フォルダを指定してください',hasFolder&&scanned?'ok':'warn');
    else box('③ ファイルへの個別許可: '+grantCount+'件',hasFolder?(scanned?'APIから見えたファイル: '+visible+'件（'+date(s.lastScanAt)+'）。':'フォルダ内一覧は未確認です。')+' 0件はDriveのファイル総数ではありません。':'フォルダ選択後に確認できます。',grantCount>0||s.ownRoot?'ok':'warn');
    if(s.lastScanError)box('ファイル読取テストのエラー',s.lastScanError,'warn');
    box('④ 初回同期: '+(initialized?'実行済み':'まだ実行していません'),initialized?'初回ルール適用済み。変更は差分確認から実行してください。':'「Drive優先」「iPhoneのみ保持」などを選び、差分を確認してから実行します。',initialized?'ok':'warn');
    box('⑤ 最終同期: '+(s.lastSyncAt?date(s.lastSyncAt):'未実行'),(s.lastSyncResult||'データの変更なし')+(s.lastSyncError?' / エラー: '+s.lastSyncError:''),s.lastSyncError?'warn':'info');
    const next=s.needsReauth?'Google認証を更新':shared&&!s.expectedDedicatedEmail?'専用アカウントのメールアドレスを入力':!hasAuth?'Googleアカウントでログイン':!hasFolder?(shared?'共有フォルダのURLまたはIDを指定':'Driveフォルダを選択'):!scanned?'ファイル一覧を読み取る':!shared&&!s.ownRoot&&grantCount===0?'既存ファイルを個別に許可':!reviewed?'差分プレビューを確認':'差分を適用';
    box('次にすること',next);
    if(hasFolder&&!s.ownRoot&&!shared){
      const caution=el.createEl('p',{text:'重要: このアプリの drive.file 権限では、フォルダ内の全ファイルを把握できません。Windowsなど別アプリが新しく追加したファイルも自動で見つかる保証はありません。現在の版で「フォルダ全体を常時自動同期できる」とは扱わないでください。'});
      caution.style.color='var(--text-warning)';
    }
    if(shared){
      box('認証中の専用アカウント',s.connectedAccountEmail||'まだ接続確認していません',s.connectedAccountEmail?'ok':'warn');
      box('認証の更新',s.needsReauth?'認証が失効しました。再ログインしてください':s.testingMode?'OAuthがテスト状態なら通常7日間で更新が必要です。失効時に通知します。':'認証失効を検出した場合に再ログインを案内します。',s.needsReauth?'warn':'info');
    }
    new Setting(el).setName('接続テスト').setDesc('認証情報と同期先フォルダへのアクセスを検証します。').addButton(b=>b.setButtonText('Google接続を確認').setDisabled(!hasAuth||!!s.needsReauth).onClick(()=>void p.verifyConnection().catch(e=>new Notice('接続失敗: '+e.message,12000))));
    new Setting(el).setName('必須設定 1/4 — Google認証と同期先フォルダ').setHeading();
    const authOptions=el.createEl('details');const authSummary=authOptions.createEl('summary',{text:'Google Cloud OAuthの詳細設定（登録済みなら変更不要）'});authOptions.open=!s.clientId||!s.clientSecret;
    const input=(name,key,secret=false)=>new Setting(authOptions).setName(name).addText(t=>{if(secret)t.inputEl.type='password';t.setValue(String(s[key]||'')).onChange(async v=>{s[key]=v.trim();p.preparedAuth={};p.cfg.pendingByMode={};p.invalidate();await p.save();void p.prepareAuth(shared?'shared':'folder').catch(()=>{});});});
    input('OAuth client ID','clientId');input('OAuth client secret','clientSecret',true);input('Sign-in redirect page','redirectUri');
    if(shared){
      new Setting(el).setName('専用アカウントのメールアドレス').setDesc('間違ったGoogleアカウントで認証した場合は拒否します。').addText(t=>t.setPlaceholder('sync@example.com').setValue(s.expectedDedicatedEmail||'').onChange(async v=>{s.expectedDedicatedEmail=v.trim();p.preparedAuth={};p.cfg.pendingByMode={};await p.save();void p.prepareAuth('shared').catch(()=>{});}));
      void p.prepareAuth('shared').catch(e=>console.warn('[gsync-limited] prepare shared',e));
      new Setting(el).setName(s.needsReauth?'Google認証を更新':'専用アカウントでログイン').setDesc('iPhoneのブラウザで専用アカウントを選択します。').addButton(b=>b.setButtonText(s.needsReauth?'再認証':'Googleログイン').setDisabled(!s.expectedDedicatedEmail).onClick(()=>void p.requestSignIn('shared').catch(e=>new Notice(e.message,13000))));
      new Setting(el).setName('ログインURLをコピー').setDesc('既定ブラウザへ直接貼り付ける場合はこちら。').addButton(b=>b.setButtonText('コピー').onClick(()=>void p.copySignInUrl('shared').catch(e=>new Notice(e.message,12000))));
      new Setting(el).setName('必須設定 2/4 — 共有フォルダを登録').setHeading();
      el.createEl('p',{text:'メインアカウントから専用アカウントに「編集者」として共有したフォルダを選択します。個別ファイルの許可は不要です。'});
      new Setting(el).setName('共有フォルダのURLまたはID').setDesc('メインアカウントのGoogle Driveでフォルダを開いたURLを入力。').addText(t=>t.setPlaceholder('https://drive.google.com/drive/folders/...').onChange(v=>{p.sharedFolderDraft=v.trim();})).addButton(b=>b.setButtonText('このフォルダを使う').setDisabled(!hasAuth||!!s.needsReauth).onClick(()=>void p.selectSharedRoot(p.sharedFolderDraft||'').catch(e=>new Notice(e.message,14000))));
      new Setting(el).setName('共有フォルダを検索').setDesc('専用アカウントに共有されたフォルダを検索します。').addButton(b=>b.setButtonText('共有フォルダを探す').setDisabled(!hasAuth||!!s.needsReauth).onClick(()=>void p.discoverSharedFolders().catch(e=>new Notice(e.message,14000))));
      if(Array.isArray(p.sharedCandidates))for(const f of p.sharedCandidates.slice(0,60)){
        new Setting(el).setName(f.name||'名前なし').setDesc(f.id).addButton(b=>b.setButtonText('選択').onClick(()=>void p.selectSharedRoot(f.id).catch(e=>new Notice(e.message,14000))));
      }
      new Setting(el).setName('同期前にファイル一覧を検証').setDesc('Drive内の選択フォルダを再帰的に読み取ります。変更や削除は行いません。').addButton(b=>b.setButtonText('読取テスト').setDisabled(!hasFolder||!hasAuth).onClick(()=>void p.scanRemoteReadOnly().catch(e=>new Notice(e.message,14000))));
      const warning=el.createEl('p',{text:'注意: GoogleのOAuth権限自体は専用アカウント全体に及びます。このアプリは選択フォルダ以外を同期しない設計です。ほかの個人データを専用アカウントに置かないでください。'});
      warning.style.color='var(--text-warning)';
    }else{
      void p.prepareAuth('folder').catch(()=>{});
      if(hasFolder)void p.prepareAuth('files').catch(()=>{});
      new Setting(el).setName('同期先フォルダを選択').addButton(b=>b.setButtonText('フォルダを選ぶ').onClick(()=>void p.requestSignIn('folder').catch(e=>new Notice(e.message,10000))));
      new Setting(el).setName('認証URLをコピー').addButton(b=>b.setButtonText('コピー').onClick(()=>void p.copySignInUrl('folder').catch(e=>new Notice(e.message,10000))));
      new Setting(el).setName('必須設定 2/4 — 既存ファイルを個別に許可').setHeading();
      new Setting(el).setName('見えるファイル数を調べる').addButton(b=>b.setButtonText('ファイル一覧を読み取る').setDisabled(!hasFolder||!hasAuth).onClick(()=>void p.scanRemoteReadOnly().catch(e=>new Notice(e.message,15000))));
      new Setting(el).setName('既存ファイルを個別に許可').addButton(b=>b.setButtonText('ファイルを追加許可').setDisabled(!hasFolder).onClick(()=>void p.requestSignIn('files').catch(e=>new Notice(e.message,10000))));
    }

    new Setting(el).setName('必須設定 3/4 — 初回同期の方針').setHeading();
    el.createEl('p',{text:'初回はDrive優先が初期値です。iPhoneにしかないファイルは残します。初回同期前はDriveへ書き込みません。'});
    new Setting(el).setName('初回の正本（同名ファイルの処理）').addDropdown(d=>d.addOptions({drive:'Google Drive優先',local:'iPhone優先（上書き注意）',both:'両方保護しDrive版を正本',skip:'同名を変更しない'}).setValue(s.initMode).onChange(async v=>{s.initMode=v;p.invalidate();await p.save();}));
    new Setting(el).setName('iPhoneにしかないファイル').addDropdown(d=>d.addOptions({keep:'iPhoneに保持（推奨）',upload:'Driveに追加（専用フォルダのみ）'}).setValue(s.localOnly).onChange(async v=>{s.localOnly=v;p.invalidate();await p.save();}));
    new Setting(el).setName('Driveにしかないファイル').addDropdown(d=>d.addOptions({download:'iPhoneへダウンロード',keep:'Driveのみに残す'}).setValue(s.remoteOnly).onChange(async v=>{s.remoteOnly=v;p.invalidate();await p.save();}));
    const advanced=el.createEl('details'); advanced.createEl('summary',{text:'任意設定・高度な設定（通常は変更不要）'});
    if(!shared)new Setting(advanced).setName('新しい専用Driveフォルダを作成').setDesc('既存フォルダを使う場合は不要。').addButton(b=>b.setButtonText('専用フォルダを作成').setDisabled(!hasAuth||hasFolder).onClick(()=>void p.createOwnRoot().catch(e=>new Notice(e.message,12000))));
    new Setting(advanced).setName('通常同期での両側編集時').addDropdown(d=>d.addOptions({both:'両方バックアップ・Driveを正本',drive:'Driveを正本（ローカル退避）',local:'iPhone優先（Drive退避）',skip:'変更せず保留'}).setValue(s.conflict).onChange(async v=>{s.conflict=v;p.invalidate();await p.save();}));
    new Setting(advanced).setName('Driveへの書き込みを許可').setDesc(shared?'初期値OFF。共有フォルダ内の更新・作成を明示的に許可します。':'初期値OFF。外部管理ルートは個別許可した既存ファイルのみ更新できます。').addToggle(t=>t.setValue(s.allowRemoteWrites).onChange(async v=>{s.allowRemoteWrites=v;p.invalidate();await p.save();}));
    new Setting(advanced).setName('除外パス（同期しない）').setDesc('1行に1件。フォルダは末尾 /、例: Archives/、ファイル種類 *.tmp').addTextArea(t=>{t.setValue(s.excludes).onChange(async v=>{s.excludes=v;p.invalidate();await p.save();});});
    new Setting(advanced).setName('フォルダ別ルール').setDesc('変更しないフォルダは「触らない」。優先先は競合時に適用し、それ以外の新しい変更は双方向に反映します。').setHeading();
    new Setting(advanced).setName('任意のフォルダをルールへ追加').setDesc('例えば Archives、Notes/Private など。フォルダは手入力で追加可能です。').addText(t=>t.setPlaceholder('Folder/Subfolder').onChange(v=>{p.folderDraft=v.trim().replace(/\\/g,'/').replace(/^\/+|\/+$/g,'');})).addButton(b=>b.setButtonText('追加').onClick(async()=>{const name=p.folderDraft||'';if(!SyncCore.cleanPath(name)){new Notice('Invalid path');return;}s.rules[name]='skip';p.invalidate();await p.save();this.display();}));
    const folderList=p.previewed ? [...new Set(p.previewed.tasks.flatMap(t=>{const bits=t.path.split('/');return bits.slice(0,-1).map((_,i)=>bits.slice(0,i+1).join('/'));}))].sort() : Object.keys(s.rules).sort();
    for(const folder of folderList.slice(0,120)){
      new Setting(advanced).setName(folder+'/').addDropdown(d=>d.addOptions({inherit:'基本ルール',drive:'競合時Drive優先',local:'競合時iPhone優先',both:'競合時両方保持',skip:'このフォルダを触らない'}).setValue(s.rules[folder]||'inherit').onChange(async v=>{if(v==='inherit')delete s.rules[folder];else s.rules[folder]=v;p.invalidate();await p.save();}));
    }
    if(shared)new Setting(advanced).setName('Google OAuthがテスト状態（表示用）').setDesc('Google Cloudの公開状態に合わせて設定してください。このスイッチでGoogleのトークン期限は変わりません。').addToggle(t=>t.setValue(!!s.testingMode).onChange(async v=>{s.testingMode=v;await p.save();this.display();}));
    new Setting(advanced).setName('自動同期（明示的に有効化した場合のみ）').setDesc('初期OFF。Obsidianが開いている間のみ差分を検証・同期。競合は双方退避。').addToggle(t=>t.setValue(!!s.autoEnabled).onChange(async v=>{s.autoEnabled=v;p.invalidate();await p.save();}));
    new Setting(advanced).setName('自動同期の間隔（分）').setDesc('0で無効。デフォルト無効。').addText(t=>t.setValue(String(s.autoMinutes)).onChange(async v=>{const n=Number.parseInt(v,10);s.autoMinutes=Number.isFinite(n)&&n>0?n:0;p.invalidate();await p.save();}));
    new Setting(advanced).setName('自動でDriveへ書き込む').setDesc(shared?'初期OFF。共有フォルダ内の更新に限ります。外部編集との同時操作を完全にはロックできません。':'初期OFF。専用ルート＋書き込み許可が必要です。').addToggle(t=>t.setValue(!!s.autoRemoteWrites).onChange(async v=>{s.autoRemoteWrites=v;p.invalidate();await p.save();}));
    new Setting(advanced).setName('起動時に自動同期').addToggle(t=>t.setValue(!!s.syncOnStartup).onChange(async v=>{s.syncOnStartup=v;await p.save();}));
    new Setting(advanced).setName('最大ファイルサイズ（MB）').addText(t=>t.setValue(String(s.maxFileSizeMB)).onChange(async v=>{const n=Number.parseInt(v,10);if(Number.isFinite(n)&&n>0){s.maxFileSizeMB=n;p.invalidate();await p.save();}}));
    new Setting(el).setName('必須設定 4/4 — 差分の確認と実行').setHeading();
    el.createEl('p',{text:'最初に「差分を確認」を押して、変更されるファイルを見てから実行してください。旧方式では、ファイル個別許可0件の初回同期を禁止します。'});
    new Setting(el).setName('同期プレビュー').setDesc('各ファイルの予定操作と件数を表示。実データは変更しません。').addButton(b=>b.setButtonText('差分を確認').setDisabled(!hasAuth||!hasFolder).onClick(()=>void p.preview()));
    new Setting(el).setName('プレビュー済みの計画を適用').setDesc('一度差分を確認し、5分以内に実行してください。外部編集が挟まると中断します。').addButton(b=>b.setButtonText('確認済み計画を実行').setDisabled(!reviewed).onClick(()=>void p.apply()));
    new Setting(el).setName('初回状態').setDesc(s.rootId&&s.initializedRoot===s.rootId?'初期化済み':'未初期化（最初の適用で選択ルールを採用）');
    new Setting(el).setName('同期履歴の再作成').setDesc('同期状態を解除します。ファイルは削除しません。先にバックアップしてください。').addButton(b=>b.setButtonText('履歴をクリア').onClick(async()=>{s.state={};s.initializedRoot='';s.protectedLocal=[];p.invalidate();await p.save();new Notice('同期履歴をクリアしました。');}));
  }
}
module.exports=GSyncLimited;
module.exports.__test={SyncCore,DriveIO,oauthUrl,sha256,DEFAULTS,REDIRECT,SCOPE,SHARED_SCOPE,parseSharedFolderId};

