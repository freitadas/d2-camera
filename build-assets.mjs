import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const check=process.argv.includes('--check');
const groups=[
  {out:'bundle-v685.js',dir:'.',files:['01-core-auth.js','02-app-chat.js','03-calls-control.js','04-features-runtime.js']},
  {out:'app-v685.css',dir:'.',files:['01-foundation.css','02-layout.css','03-components.css','04-calls-themes.css']}
];

let failed=false;
for(const group of groups){
  const built=group.files.map(name=>fs.readFileSync(path.join(root,group.dir,name),'utf8')).join('');
  const out=path.join(root,group.out);
  if(check){
    const current=fs.readFileSync(out,'utf8');
    if(current!==built){
      console.error(`${group.out} está diferente das fontes modulares. Execute npm run build:assets.`);
      failed=true;
    }
  }else{
    fs.writeFileSync(out,built);
    console.log(`Gerado ${group.out}`);
  }
}
if(failed) process.exit(1);
