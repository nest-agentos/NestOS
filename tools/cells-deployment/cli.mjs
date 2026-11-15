#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {createServiceControl} from './index.mjs';
import {packageArtifact,fail} from './artifact.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url));
try{
 if(process.argv[2]==='describe'){
  const entries=JSON.parse(await readFile(homedir()+'/.config/nestos/service-modules.json','utf8')),selected=entries.find(entry=>entry.id===process.argv[3]);
  if(!selected)throw fail('SERVICE_TARGET_UNAVAILABLE');
  console.log(JSON.stringify(await(await createServiceControl(selected.options)).describe()));
 }else{
 if(process.argv[2]!=='build')throw fail('CELLS_BUILD_COMMAND_REQUIRED');
 const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',timeout:10000}).trim();
 const commit=git('rev-parse','HEAD');
 if(git('status','--porcelain','--untracked-files=no'))throw fail('BUILD_SOURCE_DIRTY');
 const before=execFileSync('git',['-C',root+'/tools/cells','rev-parse','HEAD'],{encoding:'utf8'}).trim();
 execFileSync('cargo',['build','--locked','--release','--manifest-path',root+'/tools/cells/Cargo.toml','--target-dir',root+'/release/cells-build'],{cwd:root,stdio:'inherit',timeout:600000});
 if(git('rev-parse','HEAD')!==commit||git('status','--porcelain','--untracked-files=no')||execFileSync('git',['-C',root+'/tools/cells','rev-parse','HEAD'],{encoding:'utf8'}).trim()!==before)throw fail('BUILD_SOURCE_CHANGED');
 const result=await packageArtifact(root,commit,root+'/release/cells-build/release/cells');
 console.log(JSON.stringify({operation:'cells.build',result:'success',version:result.value.id,evidence:{path:'release/cells/'+result.value.id+'/release.json',sha256:result.digest}}));
}
}catch(error){console.error(JSON.stringify({operation:'cells.build',result:'failure',code:error.code??'CELLS_BUILD_FAILED'}));process.exitCode=1;}
