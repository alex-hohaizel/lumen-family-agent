import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TestDB,harness} from './helpers.js';

test('fixture cleanup owns only allocated paths and keeps prior harness work available until database close',async()=>{
  const db=new TestDB(),caller=await mkdtemp(join(tmpdir(),'lumen-caller-owned-'));
  let closed=false;
  try{
    await db.init();const first=harness(db),second=harness(db),external=harness(db,caller),allocated=[first.config.runtimeDir,second.config.runtimeDir];
    await writeFile(join(caller,'keep.txt'),'caller fixture');
    await writeFile(join(first.config.runtimeDir,'pending.txt'),'deferred input');
    await db.reset();
    assert.equal(await readFile(join(first.config.runtimeDir,'pending.txt'),'utf8'),'deferred input');
    await writeFile(join(second.config.runtimeDir,'result.txt'),await readFile(join(first.config.runtimeDir,'pending.txt')));
    // Replacing a config path transfers no ownership of the caller's directory.
    second.config.runtimeDir=external.config.runtimeDir;
    await db.close();closed=true;
    for(const path of allocated)await assert.rejects(access(path),{code:'ENOENT'});
    assert.equal(await readFile(join(caller,'keep.txt'),'utf8'),'caller fixture');
  }finally{if(!closed)await db.close();await rm(caller,{recursive:true,force:true});}
});
