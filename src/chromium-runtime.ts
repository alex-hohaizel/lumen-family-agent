import {createRequire} from 'node:module';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,access,chmod,rename,writeFile} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBrotliDecompress} from 'node:zlib';
import {pipeline} from 'node:stream/promises';

let preparing:Promise<{executablePath:string;directory:string}>|undefined;
export function chromiumRuntime(){
  preparing ||= prepare().catch(e=>{preparing=undefined;throw e;});return preparing;
}
async function prepare(){
  const require=createRequire(import.meta.url),root=resolve(dirname(require.resolve('@sparticuz/chromium')),'../bin');
  const directory=join(tmpdir(),'lumen-chromium-153');await mkdir(directory,{recursive:true,mode:0o700});
  const executablePath=join(directory,'chromium');
  try{await access(join(directory,'.ready-v2'));await access(executablePath);return {executablePath,directory};}catch{}
  const {extract}=require('tar-fs');
  await pipeline(createReadStream(join(root,'chromium.br')),createBrotliDecompress(),createWriteStream(executablePath+'.partial',{mode:0o700}));
  await chmod(executablePath+'.partial',0o700);await rename(executablePath+'.partial',executablePath);
  await mkdir(join(directory,'fonts'),{recursive:true,mode:0o700});
  await pipeline(createReadStream(join(root,'fonts.tar.br')),createBrotliDecompress(),extract(join(directory,'fonts'),{chown:false}));
  await pipeline(createReadStream(join(root,'swiftshader.tar.br')),createBrotliDecompress(),extract(directory,{chown:false}));
  await mkdir(join(directory,'font-cache'),{recursive:true,mode:0o700});
  await writeFile(join(directory,'fonts','fonts.conf'),`<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${directory}/fonts/fonts</dir><dir>/usr/share/fonts</dir><dir>/usr/local/share/fonts</dir><cachedir>${directory}/font-cache</cachedir><config></config></fontconfig>`,{mode:0o600});
  await writeFile(join(directory,'.ready-v2'),'153\n',{mode:0o600});return {executablePath,directory};
}
