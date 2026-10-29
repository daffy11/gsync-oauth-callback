from pathlib import Path
import json
p=Path("main.js")
s=p.read_text(encoding="utf-8")
def rep(old,new):
 global s
 n=s.count(old)
 if n!=1: raise RuntimeError(f"Expected exactly one match ({n}): {old[:90]}")
 s=s.replace(old,new,1)

rep("const SCOPE='https://www.googleapis.com/auth/drive.file';",
"""const SCOPE='https://www.googleapis.com/auth/drive.file';
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
};""")
rep("if(pickMode!=='folder' && pickMode!=='files')throw Error('Invalid Picker mode');",
"if(!['folder','files','shared','reauth'].includes(pickMode))throw Error('Invalid Picker mode');")
rep("scope:SCOPE,code_challenge:b64(digest)", "scope:pickMode==='shared'?SHARED_SCOPE:SCOPE,code_challenge:b64(digest)")
rep("  if(pickMode==='folder')args.mimetypes=FOLDER;",
"""  if(pickMode==='shared'||pickMode==='reauth'){
    delete args.trigger_onepick;delete args.allow_multiple;delete args.allow_folder_selection;
  }
  if(pickMode==='folder')args.mimetypes=FOLDER;""")
rep("id,name,mimeType,parents,md5Checksum,modifiedTime,size,version,appProperties,trashed",
"id,name,mimeType,parents,md5Checksum,modifiedTime,size,version,appProperties,trashed,capabilities(canAddChildren,canEdit)")
rep("  async list(id){",
"""  async about(){
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
  async list(id){""")
rep("  lastAuthCheck:0,lastAuthError:'',lastSyncAt:0,lastSyncResult:'',lastSyncError:'',pendingByMode:{},lastScanAt:0,lastScanRoot:'',lastVisibleFileCount:null,lastVisibleFolderCount:null,lastScanError:''",
"""  lastAuthCheck:0,lastAuthError:'',lastSyncAt:0,lastSyncResult:'',lastSyncError:'',pendingByMode:{},lastScanAt:0,lastScanRoot:'',lastVisibleFileCount:null,lastVisibleFolderCount:null,lastScanError:'',
  accessMode:'limited',modeProfiles:{},expectedDedicatedEmail:'',connectedAccountEmail:'',testingMode:true,authGrantedAt:0,needsReauth:false,reauthReason:'',lastExpiryAlertAt:0""")
rep("    if(this.cfg.syncOnStartup && this.cfg.autoEnabled)this.app.workspace.onLayoutReady(()=>window.setTimeout(()=>void this.autoRun(),8000));",
"""    if(this.cfg.syncOnStartup && this.cfg.autoEnabled)this.app.workspace.onLayoutReady(()=>window.setTimeout(()=>void this.autoRun(),8000));
    // An iPhone plugin cannot push a notification while Obsidian is closed.
    // Check the actual refresh token after opening Obsidian and periodically while it is active.
    this.app.workspace.onLayoutReady(()=>window.setTimeout(()=>void this.checkAuthHealth(),2200));
    this.registerInterval(window.setInterval(()=>void this.checkAuthHealth(),6*60*60*1000));""")
rep("  async prepareAuth(pickMode='folder'){",
"""  async switchAccessMode(mode){
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
  async selectSharedRoot(input){
    if(this.cfg.accessMode!=='shared')throw Error('共有フォルダモードでのみ指定できます');
    if(this.cfg.needsReauth||!this.cfg.refreshToken)throw Error('先に専用Googleアカウントで認証してください');
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
    this.sharedCandidates=await this.drive.listSharedFolders();
    this.tab.display();
    new Notice('共有フォルダを '+this.sharedCandidates.length+' 件取得しました。',8000);
  }
  async prepareAuth(pickMode='folder'){""")
rep("if(!['folder','files'].includes(pickMode))throw Error('Invalid OAuth Picker mode');",
"if(!['folder','files','shared','reauth'].includes(pickMode))throw Error('Invalid OAuth mode');\n    if(this.cfg.accessMode==='shared'&&pickMode!=='shared')throw Error('共有モードでは専用アカウント認証のみ使用します');\n    if(this.cfg.accessMode!=='shared'&&pickMode==='shared')throw Error('限定モードでは共有アカウント認証を使用しません');")
rep("if(pickMode==='files'&&!this.cfg.rootId)throw Error('先にフォルダを選択してください');",
"if(pickMode==='files'&&!this.cfg.rootId)throw Error('先にフォルダを選択してください');\n    if(pickMode==='shared'&&!this.cfg.expectedDedicatedEmail)throw Error('同期専用Googleアカウントのメールアドレスを先に設定してください');")
rep("      if(this.cfg.rootId){\n        const root=await this.drive.get(this.cfg.rootId);",
"""      if(this.cfg.accessMode==='shared'){
        if(!this.cfg.expectedDedicatedEmail)throw Error('同期専用メールアドレスを入力してください');
        const about=await this.drive.about();
        const actual=String(about.user?.emailAddress||'').toLowerCase();
        if(!actual||actual!==this.cfg.expectedDedicatedEmail.trim().toLowerCase())throw Error('Googleアカウントが同期専用のものと一致しません: '+(actual||'不明'));
        this.cfg.connectedAccountEmail=actual;
      }
      if(this.cfg.rootId){
        const root=await this.drive.get(this.cfg.rootId);""")
rep("new Notice('読み取れるファイル: '+tree.files.size+'件。ただし未許可ファイルは見えていない可能性があります。',12000);",
"new Notice('Driveから見つかったファイル: '+tree.files.size+'件'+(this.cfg.accessMode==='shared'?'（共有フォルダ内）':'（個別許可の範囲）'),12000);")
rep("      this.cfg.refreshToken=result.refresh_token||this.cfg.refreshToken;",
"""      if(p.pickMode==='shared'){
        const about=await this.drive.about();
        const actual=String(about.user?.emailAddress||'').toLowerCase();
        const expected=String(this.cfg.expectedDedicatedEmail||'').trim().toLowerCase();
        if(!expected||actual!==expected){
          this.liveAccessToken='';this.accessExpiry=0;
          throw Error('専用アカウントが一致しません。認証を許可したアカウント: '+(actual||'取得不可')+'。誤ってメインアカウントで許可した場合はGoogleの接続管理で取り消してください。');
        }
        this.cfg.connectedAccountEmail=actual;
      }
      this.cfg.refreshToken=result.refresh_token||this.cfg.refreshToken;
      this.cfg.needsReauth=false;this.cfg.reauthReason='';this.cfg.authGrantedAt=Date.now();""")
rep("      const picked=String(args.picked_file_ids||'').split(',').filter(Boolean);",
"""      if(p.pickMode==='shared'||p.pickMode==='reauth'){
        this.invalidate();
        new Notice(p.pickMode==='shared'?'同期専用Googleアカウントの認証が完了しました。':'Googleを再認証しました。',10000);
        return;
      }
      const picked=String(args.picked_file_ids||'').split(',').filter(Boolean);""")
start=s.index("  async getAccess(){")
end=s.index("  async createOwnRoot(){",start)
s=s[:start]+"""  async getAccess(){
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
""" +s[end:]
rep("  async createOwnRoot(){",
"  async createOwnRoot(){\n    if(this.cfg.accessMode==='shared')throw Error('共有フォルダモードでは既存の共有フォルダを指定してください');")
rep("const tree=await this.drive.tree(this.cfg.rootId,this.cfg.selectedFiles);",
"const tree=await this.drive.tree(this.cfg.rootId,this.cfg.accessMode==='shared'?{}:this.cfg.selectedFiles);") # Only first occurrence in scanRemote; second next
rep("const tree=await this.drive.tree(this.cfg.rootId,this.cfg.selectedFiles);",
"const tree=await this.drive.tree(this.cfg.rootId,this.cfg.accessMode==='shared'?{}:this.cfg.selectedFiles);")
rep("    if(task.remote){\n      const r=await this.drive.get(task.remoteId);",
"""    if(task.remote){
      if(this.cfg.accessMode==='shared'&&!(await this.drive.isInsideRoot(task.remoteId,this.cfg.rootId)))
        throw Error('共有フォルダ外へ移動したファイルには操作しません: '+task.path);
      const r=await this.drive.get(task.remoteId);""")
rep("if(!this.cfg.ownRoot)throw Error('Cannot create folders under externally managed Drive root');",
"if(!this.cfg.ownRoot&&this.cfg.accessMode!=='shared')throw Error('Cannot create folders under externally managed Drive root');")
rep("!this.cfg.ownRoot))throw Error('Automatic remote writes require a plugin-owned root; external roots require manual review');",
"!this.cfg.ownRoot && this.cfg.accessMode!=='shared'))throw Error('Automatic remote writes require explicitly authorized shared mode or plugin-owned root');")
rep("if(this.cfg.initializedRoot!==this.cfg.rootId && this.cfg.initMode==='drive' && inv.tree.files.size===0 && inv.local.size>0 && !this.cfg.ownRoot)",
"if(this.cfg.initializedRoot!==this.cfg.rootId && this.cfg.initMode==='drive' && inv.tree.files.size===0 && inv.local.size>0 && !this.cfg.ownRoot && this.cfg.accessMode!=='shared')")
rep("if(init&&!this.cfg.ownRoot&&Object.keys(this.cfg.selectedFiles||{}).length===0)",
"if(init&&!this.cfg.ownRoot&&this.cfg.accessMode!=='shared'&&Object.keys(this.cfg.selectedFiles||{}).length===0)")
rep("if(remoteWrites.some(t=>!this.cfg.ownRoot && (!t.remote || !this.cfg.selectedFiles[t.remoteId])))",
"if(remoteWrites.some(t=>this.cfg.accessMode!=='shared'&&!this.cfg.ownRoot && (!t.remote || !this.cfg.selectedFiles[t.remoteId])))")
p.write_text(s,encoding="utf-8")
print('Shared-mode authorization and safer OAuth expiry implemented:',len(s))
