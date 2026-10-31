import {mkdir,writeFile} from 'node:fs/promises';
import {lstatSync,realpathSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const repository=realpathSync(fileURLToPath(new URL('../../',import.meta.url)));
function externalPath(path){
  let ancestor=resolve(path);const missing=[];
  while(true){
    try{path=join(realpathSync(ancestor),...missing);break;}
    catch(error){
      if(error.code!=='ENOENT')throw error;
      let entry;try{entry=lstatSync(ancestor);}catch(error){if(error.code!=='ENOENT')throw error;}
      if(entry?.isSymbolicLink())throw Error('diagnostic_output_symlink_unresolved');
      const parent=dirname(ancestor);if(parent===ancestor)throw error;
      missing.unshift(basename(ancestor));ancestor=parent;
    }
  }
  const relativePath=relative(repository,path);
  if(relativePath!=='..'&&!relativePath.startsWith('..'+sep)&&!isAbsolute(relativePath))throw Error('diagnostic_output_must_be_outside_repository');
  return path;
}
export function diagnosticOptions(extra={}){
  const {values}=parseArgs({options:{'output-dir':{type:'string'},...extra}});
  if(values['output-dir'])values.outputDir=externalPath(values['output-dir']);
  return values;
}
export async function report(name,result,outputDir){
  if(outputDir){
    const directory=externalPath(outputDir);await mkdir(directory,{recursive:true});
    await writeFile(externalPath(join(directory,name)),JSON.stringify(result,null,2)+'\n',{mode:0o600});
  }
  console.log(JSON.stringify(result));
}
