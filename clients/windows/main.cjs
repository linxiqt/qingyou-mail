'use strict';
const { app, BrowserWindow, session, ipcMain, safeStorage, dialog, clipboard, protocol, net } = require('electron');
const { randomUUID, createHash } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const tls = require('node:tls');
const { pathToFileURL } = require('node:url');
const { Vault } = require('./vault.cjs');
const { serverUrl, apiPath, fingerprint, certificateFingerprint, accountView, licensedServerResponse, requiresLicense } = require('./core.cjs');
protocol.registerSchemesAsPrivileged([{ scheme:'qingyou', privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true} }]);
const development = !app.isPackaged && process.env.QINGYOU_DEV_LOCAL === '1';
const hiddenTest = development && process.env.QINGYOU_HIDDEN_TEST === '1';
let vault, mainWindow;
let monitoringLicenses = false;
const adminWindows=new Map(), sessions=new Map();
const originFor = value => serverUrl(value,{allowLocal:development});
const account = id => { const a=vault.data.accounts.find(a=>a.id===id);if(!a)throw Error('账号不存在，请重新登录');return a; };
function lockedSession(a) {
  if(sessions.has(a.id))return sessions.get(a.id);
  // Chromium stores this profile's cookies encrypted with the Windows account.
  const s=session.fromPartition('persist:qingyou-'+a.id,{cache:true});
  s.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  s.setPermissionCheckHandler(()=>false);
  s.setCertificateVerifyProc((request,callback)=>{
    const pin=vault.data.pins[a.server];
    if(pin && request.hostname===new URL(a.server).hostname) {
      try { return callback(certificateFingerprint(request.certificate)===pin ? 0 : -2); } catch { return callback(-2); }
    }
    callback(-3);
  });
  s.webRequest.onBeforeRequest((details,callback)=>{
    try { const url=new URL(details.url);callback({cancel:url.origin!==a.server}); }
    catch {callback({cancel:true});}
  });
  sessions.set(a.id,s);return s;
}
async function responseBody(response) {
  const reader=response.body?.getReader();
  const chunks=[];let size=0;
  if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>32*1024*1024){await reader.cancel();throw Error('服务器响应过大');}chunks.push(Buffer.from(value));}
  const buffer=Buffer.concat(chunks);
  const type=response.headers.get('content-type')||'';
  if(type.includes('application/json')){try{return JSON.parse(buffer.toString('utf8'));}catch{throw Error('服务器返回了无效 JSON');}}
  return {base64:buffer.toString('base64'),contentType:type};
}
async function rawRequest(a, pathname, method='GET', body) {
  if(!['GET','POST','PATCH','PUT','DELETE'].includes(method))throw Error('不支持的请求方法');
  const encoded=body===undefined?undefined:JSON.stringify(body);
  if(encoded && Buffer.byteLength(encoded)>30*1024*1024)throw Error('请求内容过大');
  let response;
  try {
    response=await lockedSession(a).fetch(a.server+pathname,{method,headers:{'Accept':'application/json','Content-Type':'application/json','Origin':a.server,...(a.csrf?{'X-CSRF-Token':a.csrf}:{})},body:encoded,credentials:'include',redirect:'error',signal:AbortSignal.timeout(45000)});
  } catch(e) {
    if(/cert|ERR_SSL/i.test(e.message))throw Error('TLS_UNTRUSTED：服务器证书未受信任或已变更，请核对证书指纹后再登录');
    throw Error(method==='GET'?'无法连接服务器，请检查地址、网络与证书':'连接中断或超时，操作结果尚未确认，请刷新核对后再决定是否重试');
  }
  const data=await responseBody(response);
  if(data.csrfToken){a.csrf=data.csrfToken;await vault.save();}
  return {status:response.status,data};
}
async function openAdmin(id, { recovery = false } = {}) {
  const a=account(id);
  if(a.portal!=='admin')throw Error('当前账号没有管理员后台入口');
  const me=await rawRequest(a,'/api/auth/me');
  if(me.status!==200||me.data.user?.role!=='admin')throw Error('管理登录已失效，请重新添加账号登录');
  if(recovery && me.data.user.admin_scope!=='global')throw Error('只有全局管理员可恢复服务端授权');
  if(!recovery && !licensedServerResponse(me))throw Error('LICENSE_REQUIRED：服务端授权无效，请先恢复授权再进入管理页面');
  a.user=me.data.user;await vault.save();
  const destination=a.server+(recovery?'/#license':'/');
  if(adminWindows.has(id)){const w=adminWindows.get(id);if(recovery||w.webContents.getURL().endsWith('#license'))await w.loadURL(destination);if(!hiddenTest){w.show();w.focus();}return {opened:true};}
  const win=new BrowserWindow({width:1440,height:960,minWidth:920,minHeight:650,title:'青邮 · 管理后台',show:!hiddenTest,autoHideMenuBar:true,webPreferences:{session:lockedSession(a),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  adminWindows.set(id,win);
  win.on('closed',()=>adminWindows.delete(id));
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==a.server)event.preventDefault();});
  win.webContents.on('will-attach-webview',event=>event.preventDefault());
  await win.loadURL(destination);return {opened:true};
}
async function enforceAdminWindows() {
  for (const [id, win] of adminWindows) {
    try {
      const a=account(id), me=await rawRequest(a,'/api/auth/me');
      if(adminWindows.get(id)!==win || win.isDestroyed())continue;
      if(me.status!==200 || me.data.user?.role!=='admin') { win.close(); continue; }
      if(!licensedServerResponse(me)) {
        if(me.data.user.admin_scope==='global') { if(!win.webContents.getURL().endsWith('#license'))await win.loadURL(a.server+'/#license'); }
        else win.close();
      }
    } catch { if(adminWindows.get(id)===win && !win.isDestroyed())win.close(); }
  }
}
async function inspectCertificate(input) {
  const server=originFor(input.server),url=new URL(server);
  if(url.protocol!=='https:')throw Error('此地址不使用 HTTPS');
  return new Promise((resolve,reject)=>{
    // This connection inspects only a public certificate; no account data is sent.
    const socket=tls.connect({host:url.hostname.replace(/^\[|\]$/g,''),port:Number(url.port)||443,servername:require('node:net').isIP(url.hostname)?undefined:url.hostname,rejectUnauthorized:false},()=>{
      try {const cert=socket.getPeerCertificate();const fp=createHash('sha256').update(cert.raw).digest('hex').toUpperCase();resolve({server,fingerprint:fp.match(/.{2}/g).join(':'),subject:cert.subject?.CN||url.hostname,issuer:cert.issuer?.CN||'',validFrom:cert.valid_from,validTo:cert.valid_to,trusted:socket.authorized||vault.data.pins[server]===fp});}catch{reject(Error('无法读取服务器证书'));}finally{socket.end();}
    });
    socket.setTimeout(15000,()=>socket.destroy(Error('读取证书超时')));socket.once('error',()=>reject(Error('读取证书失败，请检查服务器地址')));
  });
}
function installIpc() {
  const handlers={
    listAccounts:async()=>vault.data.accounts.map(accountView),
    login:async(input)=>{
      const server=originFor(input?.server),email=String(input.username||'').trim().toLowerCase(),password=String(input.password||'');
      if(!email||email.length>254||password.length>512||!password)throw Error('请输入有效账号和密码');
      if(vault.data.accounts.length>=20&&!vault.data.accounts.some(a=>a.server===server&&a.user.email===email))throw Error('最多保存 20 个账号');
      const a={id:randomUUID(),server,csrf:'',portal:'admin',user:{}};
      let response;
      try {
        response=await rawRequest(a,'/api/auth/login','POST',{email,password});
        if(response.status===403&&email.includes('@')){a.portal='client';response=await rawRequest(a,'/api/client/auth/login','POST',{email,password});}
        if(response.status!==200||!response.data.user)throw Error(response.data.error||'登录失败');
        if(a.portal==='admin'&&response.data.user.role!=='admin')throw Error('服务器未确认管理员权限');
        a.user=response.data.user;a.csrf=response.data.csrfToken;
        const old=vault.data.accounts.find(v=>v.server===server&&v.user.email===a.user.email&&v.portal===a.portal);
        if(old)await handlers.removeAccount(old.id);
        vault.data.accounts.push(a);await vault.save();
      } catch(e) {await lockedSession(a).clearStorageData();sessions.delete(a.id);throw e;}
      return accountView(a);
    },
    request:async(input)=>{
      const a=account(input.accountId), pathname=apiPath(a.portal,input.path);
      if(requiresLicense(input.path)) {
        const me=await rawRequest(a,'/api'+(a.portal==='client'?'/client':'')+'/auth/me');
        if(me.status!==200)return me;
        if(!licensedServerResponse(me))return {status:402,data:{code:'LICENSE_REQUIRED',error:'服务端授权未生效，发件和管理暂不可用，请联系管理员恢复授权。'}};
      }
      return rawRequest(a,pathname,String(input.method||'GET').toUpperCase(),input.body);
    },
    removeAccount:async(id)=>{
      const a=account(id);if(adminWindows.has(id))adminWindows.get(id).close();
      try{await rawRequest(a,'/api'+(a.portal==='client'?'/client':'')+'/auth/logout','POST',{});}catch{}
      await lockedSession(a).clearStorageData();await lockedSession(a).clearCache();sessions.delete(id);
      vault.data.accounts=vault.data.accounts.filter(v=>v.id!==id);await vault.save();return {ok:true};
    },
    openAdmin,
    openLicense:id=>openAdmin(id,{recovery:true}),
    download:async(input)=>{
      const a=account(input.accountId);
      if(!/^\/(attachments\/\d+|messages\/\d+\/raw)$/.test(input.path))throw Error('仅允许下载邮件附件或原文');
      const result=await rawRequest(a,apiPath(a.portal,input.path));
      if(result.status!==200||typeof result.data.base64!=='string')throw Error(result.data.error||'下载失败');
      const filename=String(input.filename||'attachment').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,150);
      const choice=await dialog.showSaveDialog(mainWindow,{title:'保存邮件附件',defaultPath:path.join(app.getPath('downloads'),filename)});
      if(choice.canceled)return {cancelled:true};
      await fs.writeFile(choice.filePath,Buffer.from(result.data.base64,'base64'));return {saved:true};
    },
    inspectCertificate,
    trustCertificate:async(input)=>{
      const server=originFor(input.server),pin=fingerprint(input.fingerprint);
      const observed=await inspectCertificate({server});
      if(fingerprint(observed.fingerprint)!==pin)throw Error('服务器证书已变化，请重新核对');
      const result=await dialog.showMessageBox(mainWindow,{type:'warning',buttons:['取消','指纹已核对，信任此证书'],defaultId:0,cancelId:0,title:'确认服务器证书',message:'请通过服务器管理员提供的可信渠道核对以下 SHA-256 指纹。',detail:server+'\n\n'+observed.fingerprint+'\n\n只信任这一台服务器的这一张证书。证书变更后将重新阻止连接。',noLink:true});
      if(result.response!==1)throw Error('未信任证书');vault.data.pins[server]=pin;await vault.save();
      for(const a of vault.data.accounts.filter(a=>a.server===server)){sessions.delete(a.id);lockedSession(a);}return {ok:true};
    },
    copyText:async(input)=>{
      if(typeof input?.text!=='string'||!input.text.length||input.text.length>1000000)throw Error('复制内容无效或过长');
      await clipboard.writeText(input.text);return {copied:true};
    },

  };
  for(const [name,handler]of Object.entries(handlers))ipcMain.handle('postoffice:'+name,async(event,input)=>{
    if(event.sender!==mainWindow?.webContents||event.senderFrame!==mainWindow.webContents.mainFrame||event.senderFrame.url.split('#')[0]!=='qingyou://app/index.html')throw Error('不可信的客户端来源');
    return handler(input);
  });
}
const ready=app.whenReady().then(async()=>{
  vault=await new Vault(app.getPath('userData'),safeStorage).open();
  protocol.handle('qingyou',request=>{
    const url=new URL(request.url);const name=decodeURIComponent(url.pathname).replace(/^\//,'');
    if(url.host!=='app'||!name||name.includes('..')||name.includes('\\')||!/^[-A-Za-z0-9_.]+$/.test(name))return new Response('Not found',{status:404});
    return net.fetch(pathToFileURL(path.join(__dirname,'ui',name)).href);
  });
  mainWindow=new BrowserWindow({width:1460,height:960,minWidth:900,minHeight:620,title:'青邮',backgroundColor:'#f5f7fb',show:false,autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  mainWindow.webContents.on('will-navigate',(event,url)=>{if(url.split('#')[0]!=='qingyou://app/index.html')event.preventDefault();});
  mainWindow.webContents.on('will-attach-webview',event=>event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((_w,_p,callback)=>callback(false));
  installIpc();mainWindow.once('ready-to-show',()=>{if(!hiddenTest)mainWindow.show();});await mainWindow.loadURL('qingyou://app/index.html');
  const licenseMonitor=setInterval(()=>{if(monitoringLicenses)return;monitoringLicenses=true;void enforceAdminWindows().finally(()=>{monitoringLicenses=false;});},60000);licenseMonitor.unref();
  app.once('before-quit',()=>clearInterval(licenseMonitor));
  return mainWindow;
});
ready.catch(error=>{if(hiddenTest)console.error(error);else dialog.showErrorBox('青邮无法启动',error.message);app.quit();});
module.exports={ready};
app.on('window-all-closed',()=>app.quit());
