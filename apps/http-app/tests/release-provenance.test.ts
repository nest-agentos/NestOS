import {expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {releaseDependencies} from '../../node-host/src/runtime/release-provenance';
it('compares shipped package bytes even when versions and root commits agree',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'release-proof-'));
 try{
  for(const name of ['current','previous']){
   const base=path.join(root,name),pkg=path.join(base,'node_modules/@test/library');mkdirSync(path.join(pkg,'dist'),{recursive:true});
   writeFileSync(path.join(base,'package.json'),JSON.stringify({dependencies:{'@test/library':'1'}}));writeFileSync(path.join(pkg,'package.json'),JSON.stringify({version:'1'}));writeFileSync(path.join(pkg,'dist/index.js'),'same');
  }
  const current=path.join(root,'current'),previous=path.join(root,'previous');
  const same=releaseDependencies(current,previous)['@test/library'];expect(same.current).toBe(same.previous);
  writeFileSync(path.join(current,'node_modules/@test/library/dist/index.js.map'),'build-directory-only');
  const mapped=releaseDependencies(current,previous)['@test/library'];expect(mapped.current).toBe(mapped.previous);
  writeFileSync(path.join(current,'node_modules/@test/library/dist/index.js'),'changed');
  const changed=releaseDependencies(current,previous)['@test/library'];expect(changed.current).not.toBe(changed.previous);
 }finally{rmSync(root,{recursive:true,force:true});}
});
