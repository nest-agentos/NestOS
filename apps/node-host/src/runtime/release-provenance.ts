import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,lstatSync,existsSync} from 'node:fs';
import path from 'node:path';
/** Compare the shipped runtime packages, not version strings or mutable library caches. */
export function releaseDependencies(current:string,previous:string):Record<string,{current:string;previous:string}> {
    const names=Object.keys(JSON.parse(readFileSync(path.join(previous,'package.json'),'utf8')).dependencies??{}),result:Record<string,{current:string;previous:string}>={};
    if(names.length>256)throw Error('RELEASE_DEPENDENCY_LIMIT');
    for(const name of names){
        if(!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name)||name.includes('..'))continue;
        const before=packageDigest(path.join(previous,'node_modules',name)),after=packageDigest(path.join(current,'node_modules',name));
        if(before&&after)result[name]={previous:before,current:after};
    }
    return result;
}
function packageDigest(directory:string):string|undefined {
    if(!existsSync(path.join(directory,'package.json'))||!existsSync(path.join(directory,'dist')))return;
    const hash=createHash('sha256');let count=0,bytes=0;
    const visit=(relative:string)=>{
        if(relative.endsWith('.map'))return;
        const file=path.join(directory,relative),stat=lstatSync(file);
        if(++count>4096||stat.isSymbolicLink())throw Error('RELEASE_DEPENDENCY_LIMIT');
        if(stat.isDirectory()){for(const name of readdirSync(file).sort())visit(relative+'/'+name);return;}
        if(!stat.isFile()||(bytes+=stat.size)>64*1024*1024)throw Error('RELEASE_DEPENDENCY_LIMIT');
        hash.update(relative).update('\0').update(readFileSync(file)).update('\0');
    };
    visit('package.json');visit('dist');return hash.digest('hex');
}
