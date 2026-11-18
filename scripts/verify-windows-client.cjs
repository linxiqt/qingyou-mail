'use strict';
const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
const asar=require('../clients/windows/node_modules/@electron/asar');
const root=path.resolve(__dirname,'..'), archive=path.resolve(process.argv[2]);
const expected=new Map();
for(const file of ['main.cjs','preload.cjs','core.cjs','vault.cjs','package.json'])expected.set(file,path.join(root,'clients/windows',file));
for(const file of fs.readdirSync(path.join(root,'clients/ui'))){
  const local=path.join(root,'clients/ui',file);
  if(fs.statSync(local).isFile()&&/\.(html|css|js|svg|png|ico|woff2)$/.test(file))expected.set('ui/'+file,local);
}
for(const [name,local] of expected){
  const packed=asar.extractFile(archive,name), source=fs.readFileSync(local);
  if(name==='package.json'){
    const a=JSON.parse(packed),b=JSON.parse(source);
    for(const key of ['name','version','main'])assert.equal(a[key],b[key]);
  }else assert(packed.equals(source),'Stale packaged source: '+name);
}
for(const name of asar.listPackage(archive)){
  const normalized=name.replaceAll('\\','/').replace(/^\//,'');
  if(normalized==='ui')continue;
  assert(expected.has(normalized),'Unexpected packaged file: '+normalized);
}
console.log(JSON.stringify({archive,version:JSON.parse(asar.extractFile(archive,'package.json')).version,matchedFiles:expected.size,inAppApiReference:true}));
