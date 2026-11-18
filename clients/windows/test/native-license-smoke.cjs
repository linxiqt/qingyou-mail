// Run with Electron after scripts/prepare.cjs. Uses only an isolated local fixture.
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

process.env.QINGYOU_DEV_LOCAL = '1';
process.env.QINGYOU_HIDDEN_TEST = '1';
const artifacts = path.join(__dirname, '.artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const profile = fs.mkdtempSync(path.join(artifacts, 'license-native-'));
app.setPath('userData', profile);
let license = { required: true, valid: false, expiresAt: null, mode: 'blocked' };
let scope = 'global', authenticated = true, businessCalls = 0;
const admin = () => ({ id: 1, email: 'admin', name: 'Test admin', role: 'admin', admin_scope: scope });
const mailbox = { id: 2, email: 'reader@example.test', name: 'Test mailbox', role: 'user' };
const server = http.createServer((req, res) => {
  const route = new URL(req.url, 'http://127.0.0.1').pathname;
  const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (route.endsWith('/auth/login')) {
    let body = '';
    req.on('data', data => { body += data; });
    req.on('end', () => {
      const input = JSON.parse(body);
      if (route === '/api/auth/login' && input.email.includes('@')) return json(403, { error: 'Use client login' });
      res.setHeader('Set-Cookie', 'fixture=authenticated; HttpOnly; SameSite=Strict; Path=/');
      json(200, { user: route.includes('/client/') ? mailbox : admin(), csrfToken: 'fixture-csrf' });
    });
    return;
  }
  if (route.endsWith('/auth/me')) {
    if (!authenticated || !req.headers.cookie?.includes('fixture=authenticated')) return json(401, { error: 'Session expired' });
    return json(200, { user: route.includes('/client/') ? mailbox : admin(), csrfToken: 'fixture-csrf', license });
  }
  if (/\/(send|drafts|manage)(\/|$)/.test(route)) { businessCalls++; return json(200, { ok: true }); }
  if (route === '/api/client/mailbox') return json(200, { total: 0, messages: [] });
  if (route.endsWith('/auth/logout')) return json(200, { ok: true });
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>Isolated license recovery fixture</title>');
});
const listen = new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { ready } = require('../main.cjs');
async function run() {
  await listen;
  const main = await ready;
  const origin = 'http://127.0.0.1:' + server.address().port;
  const invoke = (name, value) => main.webContents.executeJavaScript(`window.postoffice[${JSON.stringify(name)}](${JSON.stringify(value)})`);
  const a = await invoke('login', { server: origin, username: 'admin', password: 'fixture-only' });
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'login alone never opens unlicensed management');
  await assert.rejects(invoke('openAdmin', a.id), /LICENSE_REQUIRED/);
  assert.deepEqual(await invoke('openLicense', a.id), { opened: true });
  const recovery = BrowserWindow.getAllWindows().find(win => win !== main);
  assert.equal(recovery.webContents.getURL(), origin + '/#license');
  assert.equal(recovery.webContents.getLastWebPreferences().nodeIntegration, false);
  recovery.close();
  scope = 'scoped';
  await assert.rejects(invoke('openLicense', a.id), /全局管理员/);
  scope = 'global';

  const b = await invoke('login', { server: origin, username: mailbox.email, password: 'fixture-only' });
  assert.equal(b.portal, 'client');
  assert.equal((await invoke('request', { accountId: b.id, path: '/mailbox' })).status, 200);
  for (const route of ['/send', '/drafts', '/drafts/2/attachments', '/manage/domains']) {
    const response = await invoke('request', { accountId: b.id, path: route, method: 'POST', body: {} });
    assert.equal(response.status, 402);
    assert.equal(response.data.code, 'LICENSE_REQUIRED');
  }
  assert.equal(businessCalls, 0, 'denied writes never reach business endpoints');
  await assert.rejects(invoke('openLicense', b.id), /管理员后台/);

  license = { required: false, valid: true, expiresAt: null, mode: 'development' };
  assert.equal((await invoke('request', { accountId: b.id, path: '/send', method: 'POST' })).status, 402);
  license = { required: true, valid: true, expiresAt: Math.floor(Date.now() / 1000) - 1, mode: 'online' };
  assert.equal((await invoke('request', { accountId: b.id, path: '/send', method: 'POST' })).status, 402);
  license.expiresAt = null;
  assert.equal((await invoke('request', { accountId: b.id, path: '/send', method: 'POST' })).status, 200);
  assert.equal(businessCalls, 1);
  assert.deepEqual(await invoke('openAdmin', a.id), { opened: true });
  assert.equal(BrowserWindow.getAllWindows().find(win => win !== main).webContents.getURL(), origin + '/');
  authenticated = false;
  assert.equal((await invoke('request', { accountId: b.id, path: '/send', method: 'POST' })).status, 401);
  assert.equal(businessCalls, 1);
  await assert.rejects(invoke('openAdmin', a.id), /登录已失效/);
  const result = { passed: true, checks: ['native write gate before request', 'verified global license recovery only', 'admin window requires active license', 'maintenance/expired license rejected', 'license recovery without client activation', 'expired login rejected'], profile };
  fs.writeFileSync(path.join(artifacts, 'native-license-report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
run().then(() => { server.closeAllConnections(); server.close(); app.exit(0); }).catch(error => { console.error(error); server.closeAllConnections(); server.close(); app.exit(1); });
