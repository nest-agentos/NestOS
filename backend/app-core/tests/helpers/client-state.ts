import type {ClientStatePort} from '../../src/projects/remote-client-state';
export function memoryClientState(records=new Map<string,string>(),prefix=''):ClientStatePort{
    return {read:async key=>records.get(prefix+key)??null,compare:async(key,before,after)=>{
        if((records.get(prefix+key)??null)!==before)return false;
        if(after===null)records.delete(prefix+key);else records.set(prefix+key,after);return true;
    }};
}
