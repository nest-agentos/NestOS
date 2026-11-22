import {sha256HexSync} from '@nestos/common';
import {FSError,type JournalEvent,type JournalTransaction} from '@nestos/vfs-core';
import type {ApplicationEventFact} from '@nestos/app-contracts/services';

const countKey='notification-unread-v1';
export const readKey='notification-read';
type Tx=JournalTransaction<ApplicationEventFact>;
type Notice=JournalEvent<ApplicationEventFact>;
interface Count {sequence:number;unread:number;readDigest:string}

export async function initializeNotificationIndex(tx:Tx):Promise<void> {
    const previous=await notificationCount(tx),sequence=tx.baseline().sequence,raw=await tx.getState(readKey);
    const readDigest=digest(raw);
    if(previous?.sequence===sequence&&previous.readDigest===readDigest)return;
    const notices=(await retainedEvents(tx)).filter(event=>event.value.notification);
    const available=new Set(notices.map(event=>event.id)),flags=decodeRead(raw);
    const kept=[...new Set(flags.filter(id=>available.has(id)))];
    const normalized=kept.length===flags.length?raw:JSON.stringify(kept);
    if(normalized!==raw)await tx.setState(readKey,normalized);
    await writeCount(tx,notices.length-kept.length,digest(normalized));
}

export async function projectNotification(tx:Tx,added:Notice,removed:readonly Notice[]):Promise<void> {
    const count=await notificationCount(tx);
    if(!count)return;
    const expired=removed.filter(event=>event.value.notification);
    let unread=count.unread+Number(!!added.value.notification),readDigest=count.readDigest;
    if(expired.length){
        const read=new Set(decodeRead(await tx.getState(readKey)));
        for(const event of expired)if(!read.delete(event.id))unread--;
        const raw=JSON.stringify([...read]);
        await tx.setState(readKey,raw);readDigest=digest(raw);
    }
    await writeCount(tx,unread,readDigest);
}

export async function markNotification(tx:Tx,id:string,read:boolean):Promise<void> {
    const event=await tx.find(id);
    if(!event?.value.notification)throw new FSError('ENOENT','Notification expired or unavailable');
    const flags=new Set(decodeRead(await tx.getState(readKey)));
    if(read===flags.has(id))return;
    const count=await requireCount(tx);
    if(read)flags.add(id);else flags.delete(id);
    const raw=JSON.stringify([...flags]);
    await tx.setState(readKey,raw);
    await writeCount(tx,count.unread+(read?-1:1),digest(raw));
}

export async function notificationSummary(tx:Tx) {
    const count=await requireCount(tx);
    return {head:tx.baseline(),unread:count.unread};
}
async function notificationCount(tx:Tx):Promise<Count|undefined> {
    const raw=await tx.getState(countKey);
    if(raw===null)return;
    const value=JSON.parse(raw) as Count;
    if(!value||!Number.isSafeInteger(value.sequence)||!Number.isSafeInteger(value.unread)||value.unread<0||typeof value.readDigest!=='string')
        throw new FSError('EINVAL','Invalid notification index');
    return value;
}
async function requireCount(tx:Tx):Promise<Count> {
    const value=await notificationCount(tx);
    if(!value)throw new FSError('ECONFLICT','Notification index unavailable');
    return value;
}
function digest(raw:string|null):string {return sha256HexSync(raw??'');}
function writeCount(tx:Tx,unread:number,readDigest:string):Promise<void> {
    if(!Number.isSafeInteger(unread)||unread<0)throw new FSError('ECONFLICT','Invalid notification count');
    return tx.setState(countKey,JSON.stringify({sequence:tx.baseline().sequence,unread,readDigest}));
}

export async function retainedEvents(tx:Tx):Promise<Notice[]> {
    let page=await tx.read(undefined,200);
    const events=[...page.events];
    while(page.more){page=await tx.read(page.cursor,200);events.push(...page.events);}
    return events;
}
export function decodeRead(raw:string|null):string[] {
    if(raw===null)return [];
    const values=JSON.parse(raw);
    if(!Array.isArray(values)||values.length>1000||values.some(id=>typeof id!=='string'))throw new FSError('EINVAL','Invalid notification state');
    return values;
}
