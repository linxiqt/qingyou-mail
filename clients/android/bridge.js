(() => {
  'use strict';
  const pending = new Map(); let next = 0;
  const call = (method, input = {}) => new Promise((resolve, reject) => {
    const id = String(++next);
    const timer = setTimeout(() => {
      AndroidBridge.cancel(id); pending.delete(id);
      reject(new Error('请求结果尚未确认，请刷新服务器数据核对，避免重复发送。'));
    }, 90000);
    pending.set(id, { resolve, reject, timer });
    AndroidBridge.call(id, method, JSON.stringify(input), Date.now() + 90000);
  });
  window.__postofficeNativeResult = (id, result) => {
    const item = pending.get(id); if (!item) return;
    clearTimeout(item.timer); pending.delete(id);
    if (result.error) { const error = new Error(result.error); error.code = result.code; item.reject(error); }
    else item.resolve(result.value);
  };
  window.postoffice = Object.freeze({
    platform: 'android',
    capabilities: Object.freeze({ apiReference: true, admin: false, attachments: true, certificateTrust: true }),
    listAccounts: () => call('listAccounts'), login: input => call('login', input),
    request: input => call('request', input), removeAccount: id => call('removeAccount', { id }),
    copyText: input => call('copyText', input),
    download: input => call('download', input),
    inspectCertificate: input => call('inspectCertificate', input),
    trustCertificate: input => call('trustCertificate', input),
    openAdmin: () => Promise.reject(new Error('管理员后台请使用 Windows 客户端。'))
  });
})();
