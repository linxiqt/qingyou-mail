const { contextBridge, ipcRenderer } = require('electron');
const methods = ['listAccounts','login','request','removeAccount','openAdmin','openLicense','download','inspectCertificate','trustCertificate','copyText'];
const api = { platform:'windows', capabilities:{ apiReference:true,admin:true,attachments:true,certificateTrust:true } };
for (const name of methods) api[name] = (argument) => ipcRenderer.invoke('postoffice:'+name, argument);
contextBridge.exposeInMainWorld('postoffice', Object.freeze(api));
