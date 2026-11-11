import {formatClockTime} from '@nestos/ui-common';
import {escapeHTML, t} from '@nestos/common';
import type {CellsNodeOverview} from '@nestos/app-contracts/services';

type NodeStatus=Extract<CellsNodeOverview['statistics'],{state:'available'}>['value'];
const e=escapeHTML;
const number=(value:number)=>new Intl.NumberFormat(undefined,{maximumFractionDigits:1}).format(value);
function bytes(value:number):string {
    const units=['B','KiB','MiB','GiB','TiB','PiB'];
    const index=Math.min(units.length-1,Math.floor(Math.log(Math.max(1,value))/Math.log(1024)));
    return `${number(value/1024**index)} ${units[index]}`;
}
function card(label:string,value:string,detail=''):string {
    return `<div class="cells-node__metric"><dt>${e(label)}</dt><dd>${e(value)}</dd>${detail?`<small>${e(detail)}</small>`:''}</div>`;
}
export function overview(value:CellsNodeOverview,interactive=false):string {
    const count=new Set(value.mounts.map(m=>m.projectId)).size;
    const summary=card(t('cells.projects'),String(count));
    const statistics=value.statistics;
    let metrics='';
    if(statistics.state==='available') {
        const {cpu,memory,harness}=statistics.value;
        metrics=card(t('cells.cpu'),cpu?.usagePercent==null?t('cells.unknown'):`${number(cpu.usagePercent)}%`,cpu?`${cpu.cores} ${t('cells.cores')}`:'')
            +card(t('cells.memory'),memory?`${bytes(memory.totalBytes-memory.availableBytes)} / ${bytes(memory.totalBytes)}`:t('cells.unknown'))
            +card(t('cells.sessions'),harness.activeSessions==null?t('cells.unknown'):String(harness.activeSessions));
    }
    return `<dl class="cells-node__metrics">${summary}${metrics}</dl>
        ${statistics.state==='available'?`<p class="cells-node__hint">${e(t('cells.systemHint'))}</p><p class="cells-node__hint">${e(t('cells.sessionsHint'))}</p>${load(statistics.value.cpu)}${space(statistics.value.exports)}`:
            `<p class="cells-node__notice" role="status">${e(t(statistics.state==='unsupported'?'cells.statisticsUnsupported':'cells.statisticsUnavailable'))}${statistics.code?` (${e(statistics.code)})`:''}</p>`}
        ${mounts(value,interactive)}<p class="cells-node__hint">${e(t('cells.lastUpdated'))} ${e(formatClockTime(new Date(value.sampledAt)))}</p>`;
}
function load(cpu:NodeStatus['cpu']):string {
    return cpu?`<p class="cells-node__hint">${e(t('cells.load'))} ${cpu.loadAverage.map(number).join(' / ')}</p>`:'';
}
function space(exports:NodeStatus['exports']):string {
    if(!exports.length)return '';
    return `<section class="cells-node__section"><h3>${e(t('cells.space'))}</h3><p class="cells-node__hint">${e(t('cells.spaceHint'))}</p>
        <div class="cells-node__spaces">${exports.map(item=>`<div class="cells-node__space"><strong>${e(item.alias)}</strong>
            <span>${item.availableBytes==null?t('cells.unknown'):`${e(bytes(item.availableBytes))} ${e(t('cells.available'))}`} / ${item.totalBytes==null?t('cells.unknown'):`${e(bytes(item.totalBytes))} ${e(t('cells.total'))}`}</span></div>`).join('')}</div></section>`;
}
type Mount=CellsNodeOverview['mounts'][number];
function link(m:Mount,action:string,label:string):string {
    return `<button type="button" class="cells-node__link" data-cells-mount="${e(m.mountId)}" data-cells-project="${e(m.projectId)}" data-cells-project-action="${action}">${e(label)}</button>`;
}
function mountRow(m:Mount,interactive:boolean):string {
    const projectLabel=t(m.problem?`diagnostics.problem.${m.problem}`:`remote.state.${m.projectStatus}`);
    const actions=interactive?[
        m.canRemount?link(m,'remount',t('remote.remountAs')):'',
        m.unmount?link(m,m.unmount==='project'?'unmount':'detach',t(m.unmount==='project'?'remote.unmountProject':'cells.unmountDirectory')):''
    ].filter(Boolean).join(' '):'';
    return `<tr><td>${interactive?link(m,'open',m.projectName):e(m.projectName)}<small>${e(m.projectId)}</small></td>
        <td><code>${e('/'+m.alias+(m.root==='/'?'':m.root))}</code></td><td><code>${e(m.at)}</code></td>
        <td>${e(t(m.access==='rw'?'cells.readWrite':'cells.readOnly'))}</td>
        <td data-state="${e(m.status)}">${e(t(`remote.state.${m.status}`))}</td>
        <td>${interactive?link(m,'status',projectLabel):e(projectLabel)}</td><td>${actions||'—'}</td></tr>`;
}
function mounts(value:CellsNodeOverview,interactive:boolean):string {
    const headers=['project','remoteDirectory','mountPoint','access','mountStatus','projectStatus','mountActions'] as const;
    return `<section class="cells-node__section"><h3>${e(t('cells.mounts'))}</h3><p class="cells-node__hint">${e(t('cells.mountsHint'))}</p>${value.mounts.length?`
        <div class="cells-node__table-wrap"><table class="cells-node__table"><thead><tr>${headers.map(key=>`<th scope="col">${e(t(`cells.${key}`))}</th>`).join('')}</tr></thead>
        <tbody>${value.mounts.map(m=>mountRow(m,interactive)).join('')}</tbody></table></div>`:
        `<p class="cells-node__hint">${e(t('cells.noMounts'))}</p>`}</section>`;
}
