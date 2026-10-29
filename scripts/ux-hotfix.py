from pathlib import Path
import json
p=Path('main.js'); s=p.read_text()
def rep(a,b):
 global s
 count=s.count(a)
 if count!=1: raise RuntimeError(f'Expected 1 occurrence, got {count}: {a[:90]}')
 s=s.replace(a,b,1)
rep("  allowRemoteWrites:false,\n};", "  allowRemoteWrites:false,\n  lastAuthCheck:0,lastAuthError:'',lastSyncAt:0,lastSyncResult:'',lastSyncError:'',pendingByMode:{}\n};")
rep("selectedFiles:saved.selectedFiles||{},protectedLocal:saved.protectedLocal||[]};", "selectedFiles:saved.selectedFiles||{},protectedLocal:saved.protectedLocal||[],pendingByMode:saved.pendingByMode||{}};")
rep("this.drive=new DriveIO(()=>this.getAccess(),requestUrl);", "this.drive=new DriveIO(()=>this.getAccess(),requestUrl);this.preparedAuth={};this.authPreparing={};")
start=s.index("  async requestSignIn(pickMode='folder'){")
end=s.index("  async finishAuth(args){",start)
s=s[:start]+'''  async prepareAuth(pickMode='folder'){
    if(!['folder','files'].includes(pickMode))throw Error('Invalid OAuth Picker mode');
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
      if(this.cfg.rootId){
        const root=await this.drive.get(this.cfg.rootId);
        if(root.trashed||root.mimeType!==FOLDER)throw Error('同期先フォルダにアクセスできません');
      }
      this.cfg.lastAuthCheck=Date.now();this.cfg.lastAuthError='';
      await this.save();new Notice('Googleとの接続を確認しました。',8000);
    }catch(e){this.cfg.lastAuthCheck=0;this.cfg.lastAuthError=String(e.message||e);await this.save();throw e;}
    finally{this.tab.display();}
  }
''' +s[end:]
rep("    const p=this.cfg.pending;\n    try{", "    const matched=Object.entries(this.cfg.pendingByMode||{}).find(([,v])=>v.state===args.state);\n    const p=matched?.[1]||null;\n    try{")
rep("      this.cfg.refreshToken=result.refresh_token||this.cfg.refreshToken;", "      this.cfg.refreshToken=result.refresh_token||this.cfg.refreshToken;\n      this.cfg.lastAuthCheck=Date.now();this.cfg.lastAuthError='';")
rep("    }catch(e){new Notice('GSync Limited OAuth: '+e.message,16000);console.error('[gsync-limited]',e);}\n    finally{this.cfg.pending=null;await this.save();this.tab.display();}", "    }catch(e){this.cfg.lastAuthError=String(e.message||e);new Notice('GSync Limited OAuth: '+e.message,16000);console.error('[gsync-limited]',e);}\n    finally{if(matched){delete this.cfg.pendingByMode[matched[0]];delete this.preparedAuth[matched[0]];}this.cfg.pending=null;await this.save();this.tab.display();}")
rep("      this.lastSync=Date.now();\n      new Notice('GSync Limited: applied '", "      this.lastSync=Date.now();this.cfg.lastSyncAt=this.lastSync;this.cfg.lastSyncResult='同期 '+completed+'件（削除なし）';this.cfg.lastSyncError='';await this.save();\n      new Notice('GSync Limited: applied '")
rep("    }catch(e){new Notice('STOPPED after '+completed+' actions: '+e.message+'; inspect backups and re-preview.',17000);console.error('[gsync-limited] apply',e);}", "    }catch(e){this.cfg.lastSyncError='中止（'+completed+'件の処理後）: '+e.message;await this.save();new Notice('STOPPED after '+completed+' actions: '+e.message+'; inspect backups and re-preview.',17000);console.error('[gsync-limited] apply',e);}")
start=s.index("    new Setting(el).setName('GSync Limited — scoped sync').setHeading();")
end=s.index("    new Setting(el).setName('初回の正本（同名ファイルの処理）')",start)
s=s[:start]+'''    new Setting(el).setName('GSync Limited — 同期セットアップ').setHeading();
    const date=ms=>ms?new Date(ms).toLocaleString('ja-JP'):'未確認';
    const box=(title,detail,kind='info')=>{
      const elem=el.createDiv({cls:'gsync-limited-status'});
      elem.style.padding='12px';elem.style.marginBottom='8px';elem.style.borderRadius='8px';
      elem.style.border='1px solid var(--background-modifier-border)';
      elem.style.borderLeft='4px solid '+(kind==='ok'?'var(--color-green)':kind==='warn'?'var(--color-orange)':'var(--interactive-accent)');
      elem.createEl('strong',{text:title});elem.createEl('div',{text:detail,cls:'setting-item-description'});
    };
    const hasAuth=!!s.refreshToken,hasFolder=!!s.rootId,initialized=hasFolder&&s.initializedRoot===s.rootId;
    const grantCount=Object.keys(s.selectedFiles||{}).length;
    const reviewed=!!(p.previewed&&Date.now()-p.previewed.at<5*60000);
    el.createEl('p',{text:'進捗を確認して、上から順に設定してください。既存のVaultをバックアップし、差分プレビュー後に適用してください。'});
    new Setting(el).setName('現在の状態').setHeading();
    box('① Google認証: '+(hasAuth?'保存済み':'未認証'),hasAuth?(s.lastAuthCheck?'Google接続確認: '+date(s.lastAuthCheck):'トークンは保存済みですが接続は未確認'):'クライアント設定とGoogleログインが必要です。',hasAuth&&s.lastAuthCheck?'ok':'warn');
    if(s.lastAuthError)box('前回の認証エラー',s.lastAuthError,'warn');
    box('② Driveフォルダ: '+(hasFolder?'選択済み':'未選択'),hasFolder?s.rootName+'（'+(s.ownRoot?'専用':'外部管理')+'）':'フォルダを1つ選択してください。',hasFolder?'ok':'warn');
    box('③ 明示的に許可した既存ファイル: '+grantCount+' 件','フォルダ選択だけでは全ファイルへの権限は取得できません。外部アプリが新たに追加したファイルは再許可が必要です。','warn');
    box('④ 初回同期: '+(initialized?'初期化済み':'未完了'),initialized?'次は差分確認で変更を確認してください。':'初回の正本とファイル保持ルールを設定してください。',initialized?'ok':'warn');
    box('⑤ 最終同期: '+date(s.lastSyncAt),(s.lastSyncResult||'未実行')+(s.lastSyncError?' / エラー: '+s.lastSyncError:''),s.lastSyncError?'warn':s.lastSyncAt?'ok':'info');
    box('次にすること',!hasAuth?'OAuthを設定しフォルダ選択からGoogleログイン':!hasFolder?'Driveのフォルダを選択':grantCount===0&&!s.ownRoot?'既存ファイルを許可（0件のまま初期同期しない）':!reviewed?'同期ルールを確認して差分をプレビュー':'プレビューで予定操作を確認して適用');
    new Setting(el).setName('接続テスト').setDesc('保存済みトークンを実際に検証します。').addButton(b=>b.setButtonText('Google接続を確認').setDisabled(!hasAuth).onClick(()=>void p.verifyConnection().catch(e=>new Notice('接続失敗: '+e.message,12000))));
    new Setting(el).setName('① Google認証・同期フォルダ').setHeading();
    const input=(name,key,secret=false)=>new Setting(el).setName(name).addText(t=>{if(secret)t.inputEl.type='password';t.setValue(String(s[key]||'')).onChange(async v=>{s[key]=v.trim();p.preparedAuth={};p.cfg.pendingByMode={};p.invalidate();await p.save();void p.prepareAuth('folder').catch(e=>console.warn('[gsync-limited] prepare',e));});});
    input('OAuth client ID','clientId');input('OAuth client secret','clientSecret',true);input('Sign-in redirect page','redirectUri');
    void p.prepareAuth('folder').catch(e=>console.warn('[gsync-limited] prepare',e));
    if(hasFolder)void p.prepareAuth('files').catch(e=>console.warn('[gsync-limited] prepare files',e));
    new Setting(el).setName('同期先フォルダを選択').setDesc('フォルダを1つ選択します。可能であれば既定ブラウザを使用します。').addButton(b=>b.setButtonText('フォルダを選ぶ').onClick(()=>void p.requestSignIn('folder').catch(e=>new Notice(e.message,10000))));
    new Setting(el).setName('ブラウザで認証できない場合').setDesc('URLをコピーし、既定のブラウザで開けます。').addButton(b=>b.setButtonText('認証URLをコピー').onClick(()=>void p.copySignInUrl('folder').catch(e=>new Notice(e.message,10000))));
    new Setting(el).setName('③ 既存ファイルにアクセスを許可').setDesc('個別に許可。外部アプリが新たに追加したファイルは自動許可されません。').addButton(b=>b.setButtonText('ファイルを追加許可').setDisabled(!hasFolder).onClick(()=>void p.requestSignIn('files').catch(e=>new Notice(e.message,10000))));
    new Setting(el).setName('ファイル許可URLをコピー').addButton(b=>b.setButtonText('コピー').setDisabled(!hasFolder).onClick(()=>void p.copySignInUrl('files').catch(e=>new Notice(e.message,10000))));
    new Setting(el).setName('新規の専用Driveルートを作成').setDesc('既存フォルダとは別の保存先を作ります。').addButton(b=>b.setButtonText('専用フォルダを作成').setDisabled(!hasAuth||hasFolder).onClick(()=>void p.createOwnRoot().catch(e=>new Notice(e.message,12000))));
    new Setting(el).setName('④ 同期ルールを設定').setHeading();
''' +s[end:]
rep("    new Setting(el).setName('同期プレビュー').setDesc('各ファイルの予定操作と件数を表示。実データは変更しません。').addButton(b=>b.setButtonText('差分を確認').onClick(()=>void p.preview()));", "    new Setting(el).setName('⑤ 差分確認と実行').setHeading();\n    new Setting(el).setName('同期プレビュー').setDesc('各ファイルの予定操作と件数を表示。実データは変更しません。').addButton(b=>b.setButtonText('差分を確認').setDisabled(!hasAuth||!hasFolder).onClick(()=>void p.preview()));")
rep(".setDisabled(!p.previewed).onClick(()=>void p.apply())", ".setDisabled(!reviewed).onClick(()=>void p.apply())")
p.write_text(s)
m=json.loads(Path('manifest.json').read_text());m['version']='0.2.2';Path('manifest.json').write_text(json.dumps(m,ensure_ascii=False,indent=2)+'\n');Path('versions.json').write_text(json.dumps({'0.2.0':'1.6.6','0.2.1':'1.6.6','0.2.2':'1.6.6'},indent=2)+'\n')
print('UX version 0.2.2 built; JS bytes',len(s))
