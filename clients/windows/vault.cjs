'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
class Vault {
  constructor(directory, storage) { this.file=path.join(directory,'accounts.secure');this.storage=storage;this.data={accounts:[],pins:{},ai:null};this.tail=Promise.resolve(); }
  async open() {
    if (!(await this.storage.isAsyncEncryptionAvailable())) throw Error('Windows 安全存储暂不可用，请登录 Windows 后重试');
    try { this.data=JSON.parse((await this.storage.decryptStringAsync(await fs.readFile(this.file))).result); }
    catch (e) { if(e.code!=='ENOENT') throw Error('安全存储无法解密，请使用原 Windows 用户登录；原文件已保留'); }
    if(!Array.isArray(this.data.accounts)||!this.data.pins) throw Error('安全存储格式无效');
    return this;
  }
  save() {
    const serialized=JSON.stringify(this.data);
    this.tail=this.tail.catch(()=>{}).then(async()=>{const encrypted=await this.storage.encryptStringAsync(serialized);await fs.mkdir(path.dirname(this.file),{recursive:true});await fs.writeFile(this.file+'.tmp',encrypted);await fs.rename(this.file+'.tmp',this.file);});
    return this.tail;
  }
}
module.exports={Vault};
