export const failure=(code:string)=>Object.assign(new Error(code),{code});
export function requireValue(value:unknown,code:string):asserts value {if(!value)throw failure(code);}
