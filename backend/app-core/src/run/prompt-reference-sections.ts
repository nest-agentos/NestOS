import type {PromptFile} from './prompt-bundle';
/** Freeze only the entry and its configured Markdown dependencies; do not load them into the model. */
export function promptReferenceSections(files:PromptFile[],entry:string):Record<string,string> {
    const catalog=new Map(files.map(file=>[file.name,file])),selected=new Map<string,string>(),pending=[entry];
    while(pending.length){
        const name=pending.pop()!;if(selected.has(name))continue;
        const file=catalog.get(name);if(!file)continue;
        selected.set(name,file.content);
        for(const match of file.content.matchAll(/\b([a-zA-Z0-9_-]+\.md)\b/g))if(catalog.has(match[1]))pending.push(match[1]);
    }
    return Object.fromEntries(selected);
}
