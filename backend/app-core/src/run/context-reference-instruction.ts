import {formatPromptSections} from '@nestos/llm-context/prompt';
/** A channel already owns scope identity and data; the message names only sections to read. */
export function contextReferenceInstruction(reference:unknown,instruction?:string):string {
    const ref=reference as {section?:unknown;sections?:unknown}|undefined;
    const sections=typeof ref?.section==='string'?[ref.section]:ref?.sections;
    if(Array.isArray(sections)&&sections.length&&sections.every(name=>typeof name==='string'&&/^[\w.-]+$/.test(name)))
        return instruction?.trim()||`Read ${sections.map(name=>'\`'+name+'\`').join(', ')} via \`session_context\` and follow the current instructions.`;
    return formatPromptSections([{title:'Instructions',content:instruction},{title:'Context reference',content:reference}]);
}
