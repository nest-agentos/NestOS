export type Locale='zh-CN'|'en';
let locale:Locale='zh-CN';
export function setLocaleCode(value:Locale):void {locale=value;}
export function getLocale():Locale {return locale;}
