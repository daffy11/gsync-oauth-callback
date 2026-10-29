from pathlib import Path
import json
p=Path("main.js")
s=p.read_text()
def rep(old,new):
    global s
    n=s.count(old)
    if n!=1: raise RuntimeError("Expected exactly one match, got "+str(n)+" for "+old[:65])
    s=s.replace(old,new,1)
rep("const oauthUrl = async (clientId,redirect,vaultName) => {",
    "const oauthUrl = async (clientId,redirect,vaultName,pickMode='folder') => {\n  if(pickMode!=='folder' && pickMode!=='files')throw Error('Invalid Picker mode');")
rep("allow_multiple:'true',allow_folder_selection:'true'",
    "allow_multiple:pickMode==='files'?'true':'false',allow_folder_selection:pickMode==='folder'?'true':'false'")
rep("  return {url:AUTH+'?'+form(args),pending:{verifier,state,redirect,time:Date.now()}};",
    "  if(pickMode==='folder')args.mimetypes=FOLDER;\n  return {url:AUTH+'?'+form(args),pending:{verifier,state,redirect,time:Date.now(),pickMode}};")
rep("  async requestSignIn(){",
    "  async requestSignIn(pickMode='folder'){\n    if(pickMode==='files' && !this.cfg.rootId)throw Error('Select a root folder first.');")
rep("oauthUrl(this.cfg.clientId,this.cfg.redirectUri,this.app.vault.getName())",
    "oauthUrl(this.cfg.clientId,this.cfg.redirectUri,this.app.vault.getName(),pickMode)")
start=s.index("      let imported=0,folders=[];")
end=s.index("\n    }catch(e){new Notice('GSync Limited OAuth:",start)
s=s[:start]+"""      const selected=await Promise.all(picked.map(id=>this.drive.get(id)));
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
      this.invalidate();"""+s[end:]
rep("    new Setting(el).setName('Google OnePick — 許可するフォルダ・ファイルを選択').setDesc('選択したファイルを追加許可する際もここから再認証。').addButton(b=>b.setButtonText('Googleで選択').onClick(()=>void p.requestSignIn().catch(e=>new Notice(e.message,10000))));",
    "    new Setting(el).setName('① 同期先フォルダを選択').setDesc('フォルダのみ表示。1つ選択します。フォルダへの許可は子ファイルへ自動的に広がりません。').addButton(b=>b.setButtonText('フォルダを選ぶ').onClick(()=>void p.requestSignIn('folder').catch(e=>new Notice(e.message,10000))));\n    new Setting(el).setName('② 既存ファイルを個別許可').setDesc('Driveに保存済みのファイルは別途許可してください。外部アプリが今後追加するファイルも自動許可されません。').addButton(b=>b.setButtonText('ファイルを追加許可').setDisabled(!s.rootId).onClick(()=>void p.requestSignIn('files').catch(e=>new Notice(e.message,10000))));")
p.write_text(s)
manifest=json.loads(Path("manifest.json").read_text())
manifest["version"]="0.2.1"
Path("manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n")
Path("versions.json").write_text(json.dumps({"0.2.0":"1.6.6","0.2.1":"1.6.6"},indent=2)+"\n")
print("Updated folder-only picker and separate file grants to 0.2.1")
