import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,realpath,rm,stat,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {diagnosticOptions,report} from './report.mjs';

function outputOption(path){
  const previous=process.argv;process.argv=[process.execPath,'diagnostic-options','--output-dir',path];
  try{return diagnosticOptions().outputDir;}finally{process.argv=previous;}
}

test('report output rejects repository aliases before writes and resolves missing external directories',async()=>{
  const fixture=await mkdtemp(join(tmpdir(),'lumen-report-guard-'));
  try{
    const repository=fileURLToPath(new URL('../../',import.meta.url)),alias=join(fixture,'repository');
    await symlink(repository,alias,'dir');
    for(const path of [repository,alias,join(alias,'docs'),join(alias,'missing','reports')]){
      assert.throws(()=>outputOption(path),/diagnostic_output_must_be_outside_repository/);
    }
    await assert.rejects(report('blocked.json',{passed:false},alias),/diagnostic_output_must_be_outside_repository/);
    await symlink(join(repository,'missing-reports-directory'),join(fixture,'dangling'),'dir');
    assert.throws(()=>outputOption(join(fixture,'dangling','reports')),/diagnostic_output_symlink_unresolved/);

    const external=join(fixture,'external');await symlink(fixture,external,'dir');
    const directory=outputOption(join(external,'new','reports'));
    assert.equal(directory,join(await realpath(fixture),'new','reports'));
    await report('allowed.json',{passed:true},directory);
    assert.deepEqual(JSON.parse(await readFile(join(directory,'allowed.json'),'utf8')),{passed:true});
    assert.equal((await stat(join(directory,'allowed.json'))).mode&0o777,0o600);
    const redirected=join(directory,'redirected.json');await symlink(join(repository,'package.json'),redirected);
    await assert.rejects(report('redirected.json',{passed:false},directory),/diagnostic_output_must_be_outside_repository/);
  }finally{await rm(fixture,{recursive:true,force:true});}
});
