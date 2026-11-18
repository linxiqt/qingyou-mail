// Runs with Electron to verify real Chromium cookies and Windows encryption.
const {app,session,safeStorage}=require('electron');
const http=require('node:http'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {Vault}=require('../vault.cjs');
const data=path.join(os.tmpdir(),'qingyou-electron-smoke-'+process.pid);
app.setPath('userData',data);
app.whenReady().then(async()=>{
  const server=http.createServer((req,res)=>{
    if(req.url.startsWith('/login/')){res.setHeader('Set-Cookie','postoffice_client_session='+req.url.slice(7)+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=600');res.setHeader('Content-Type','application/json');res.end('{"ok":true}');}
    else {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({cookie:req.headers.cookie||'',csrf:req.headers['x-csrf-token']}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const origin='http://127.0.0.1:'+server.address().port;
    const a=session.fromPartition('smoke-a'),b=session.fromPartition('smoke-b');
    await a.fetch(origin+'/login/one',{credentials:'include'});
    await b.fetch(origin+'/login/two',{credentials:'include'});
    const one=await(await a.fetch(origin+'/me',{credentials:'include',headers:{'X-CSRF-Token':'a'}})).json();
    const two=await(await b.fetch(origin+'/me',{credentials:'include',headers:{'X-CSRF-Token':'b'}})).json();
    assert.equal(one.cookie,'postoffice_client_session=one');assert.equal(two.cookie,'postoffice_client_session=two');assert.equal(one.csrf,'a');
    await a.clearStorageData();assert.equal((await(await b.fetch(origin+'/me')).json()).cookie,'postoffice_client_session=two');
    const vault=await new Vault(data,safeStorage).open();
    vault.data.accounts=[{id:'one',csrf:'session-secret'}];vault.data.ai={apiKey:'AI-secret'};await vault.save();
    const bytes=await fs.readFile(vault.file);assert(!bytes.includes(Buffer.from('AI-secret')));assert(!bytes.includes(Buffer.from('session-secret')));
    const reopened=await new Vault(data,safeStorage).open();assert.equal(reopened.data.ai.apiKey,'AI-secret');
    console.log(JSON.stringify({electron:process.versions.electron,accountCookiesIsolated:true,independentLogout:true,windowsEncryptedVault:true}));
  } finally {await new Promise(resolve=>server.close(resolve));}
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
