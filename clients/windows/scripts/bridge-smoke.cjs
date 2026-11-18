// Real Electron IPC + real isolated Node mail server; no external messages.
'use strict';
const { app, BrowserWindow, clipboard, ClipboardItem }=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {pathToFileURL}=require('node:url');
const temp=path.join(os.tmpdir(),'qingyou-bridge-smoke-'+process.pid);
process.env.QINGYOU_DEV_LOCAL='1';process.env.QINGYOU_HIDDEN_TEST='1';
app.setPath('userData',path.join(temp,'desktop'));
const {ready}=require('../main.cjs');
let service;
async function run(){
  const {start}=await import(pathToFileURL(path.resolve(__dirname,'../../../src/server.js')));
  service=await start({dataDir:path.join(temp,'server'),host:'127.0.0.1',smtpHost:'127.0.0.1',port:0,smtpPort:0,submissionPort:0,production:false,secureCookies:false,outboundMode:'local',dkimBackend:'node',tls:{}});
  const server='http://127.0.0.1:'+service.ports.http;
  service.config.publicUrl=server;
  const password='Isolated-fixture-password-2026';
  const setup=await fetch(server+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password})});
  assert.equal(setup.status,201);
  const data=await setup.json();const cookie=setup.headers.get('set-cookie').split(';')[0];
  async function adminPost(route,body){
    const response=await fetch(server+'/api'+route,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':data.csrfToken},body:JSON.stringify(body)});
    const value=await response.json();assert.equal(response.status,201,JSON.stringify(value));return value;
  }
  await adminPost('/admin/manage/domains',{name:'native.example'});
  for(const email of ['alice@native.example','bob@native.example'])await adminPost('/admin/users',{email,name:email.split('@')[0],password});
  const win=await ready;
  const call=(method,input)=>win.webContents.executeJavaScript(`window.postoffice[${JSON.stringify(method)}](${JSON.stringify(input)})`);
  const request=(accountId,url,body,method)=>call('request',{accountId,path:url,body,method:method||(body===undefined?'GET':'POST')});
  const admin=await call('login',{server,username:'admin',password});
  assert.equal(admin.portal,'admin');assert.equal(admin.user.role,'admin');
  const adminWindow=BrowserWindow.getAllWindows().find(w=>w!==win&&w.webContents.getURL()===server+'/');
  assert(adminWindow,'Admin login must open server administration');
  const prefs=adminWindow.webContents.getLastWebPreferences();
  assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.contextIsolation,true);assert(!prefs.preload);
  assert.equal(await adminWindow.webContents.executeJavaScript('typeof window.postoffice'),'undefined');
  const alice=await call('login',{server,username:'alice@native.example',password});
  const bob=await call('login',{server,username:'bob@native.example',password});
  assert.equal(alice.portal,'client');assert.equal(bob.portal,'client');assert.notEqual(alice.id,bob.id);
  assert.equal((await call('listAccounts')).length,3);
  await assert.rejects(()=>call('openAdmin',alice.id),/管理员/);
  const me=await request(alice.id,'/auth/me');assert.equal(me.status,200);assert.equal(me.data.user.email,'alice@native.example');
  const draft=await request(alice.id,'/drafts',{to:'bob@native.example',subject:'Native draft',text:'Draft stays on server'});
  assert.equal(draft.status,201,JSON.stringify(draft));
  assert.equal((await request(bob.id,'/messages/'+draft.data.id)).status,404);
  const sent=await request(alice.id,'/send',{to:'bob@native.example',subject:'Native IPC delivery',text:'Local integration message',attachments:[{filename:'hello.txt',content:Buffer.from('native attachment').toString('base64')}]});
  assert.equal(sent.status,201,JSON.stringify(sent));await service.mail.work();
  const inbox=await request(bob.id,'/messages?folder=inbox');assert.equal(inbox.status,200);
  const delivered=inbox.data.items.find(item=>item.subject==='Native IPC delivery');assert(delivered,'Bob received local message');
  const detail=await request(bob.id,'/messages/'+delivered.id);assert.equal(detail.status,200);assert.equal(detail.data.from_email,'alice@native.example');
  const attachment=detail.data.attachments[0];assert(attachment);
  const file=await request(bob.id,'/attachments/'+attachment.id);assert.equal(file.status,200);assert.equal(Buffer.from(file.data.base64,'base64').toString(),'native attachment');
  assert.equal((await request(alice.id,'/messages/'+delivered.id)).status,404);
  assert.equal((await request(alice.id,'/attachments/'+attachment.id)).status,404);
  await call('removeAccount',alice.id);
  assert.equal((await request(bob.id,'/auth/me')).status,200);
  await assert.rejects(()=>request(alice.id,'/auth/me'),/账号不存在/);
  const previousClipboard=[];
  for(const item of await clipboard.read()) {
    const data={}; for(const type of item.types)data[type]=await item.getType(type);
    previousClipboard.push(new ClipboardItem(data));
  }
  try {
    assert.equal((await call('copyText',{text:'青邮 API\nAuthorization: Bearer po_YOUR_API_KEY'})).copied,true);
    assert.equal(await clipboard.readText(),'青邮 API\nAuthorization: Bearer po_YOUR_API_KEY');
    const {completeDocument}=await import(pathToFileURL(path.resolve(__dirname,'../../ui/api-reference.js')));
    const all=completeDocument(server);
    await call('copyText',{text:all});
    assert.equal(await clipboard.readText(),all);
    // Exercise the real qingyou:// renderer and its CSP, not just the IPC method.
    const loaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
    win.reload(); await loaded;
    const waitFor=async expression=>{
      for(let i=0;i<100;i++) {
        if(await win.webContents.executeJavaScript(expression))return;
        await new Promise(resolve=>setTimeout(resolve,30));
      }
      throw Error('Native UI timed out: '+expression);
    };
    await waitFor('!!document.querySelector(\'[data-action="api-docs"]\')');
    await win.webContents.executeJavaScript('document.querySelector(\'[data-action="api-docs"]\').click()');
    await waitFor('!!document.querySelector(\'[data-copy="server"]\')');
    await win.webContents.executeJavaScript('document.querySelector(\'[data-copy="server"]\').click()');
    await waitFor('document.querySelector(".api-copy-status").textContent.includes("已复制到剪贴板")');
    assert.equal(await clipboard.readText(),server);
    await assert.rejects(()=>call('copyText',{text:42}),/复制内容/);
    assert.equal(await win.webContents.executeJavaScript('typeof window.postoffice.readClipboard'),'undefined');
    assert.equal(await win.webContents.executeJavaScript('typeof window.postoffice.setAIConfig'),'undefined');
  } finally { if(previousClipboard.length)await clipboard.write(previousClipboard); else await clipboard.clear(); }
  const vault=await fs.readFile(path.join(temp,'desktop','accounts.secure'));
  assert(!vault.includes(Buffer.from(password)));assert(!vault.includes(Buffer.from('native-fixture-api-secret')));
  const report={electron:process.versions.electron,actualServer:true,adminAutoWindow:true,adminHasNoBridge:true,multiAccountIsolation:true,drafts:true,localSendReceive:true,attachmentIsolation:true,independentLogout:true,nativeClipboardCopy:true,clipboardReadNotExposed:true};
  await fs.mkdir(path.join(__dirname,'.artifacts'),{recursive:true});
  await fs.writeFile(path.join(__dirname,'.artifacts','bridge-smoke.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
run().then(async()=>{await service?.close();app.exit(0);},async error=>{console.error(error);await service?.close();app.exit(1);});
