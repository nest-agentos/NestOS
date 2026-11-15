import prompt from './prompts/verification-waiver.json';
export const verificationWaiverConfirmation='确认豁免所列专项验证并继续交付';
export function verificationWaiverInstruction(receipt:unknown):string{return prompt.instruction+JSON.stringify(receipt);}
