import {expect,it} from 'vitest';
import {nativeInteraction,nativeResponse} from './native-interactions';
it('keeps legacy commands and unavailable choices in disclosures while preserving usable decisions',()=>{
 const view=nativeInteraction({id:'approval',kind:'approval',detail:'python3 script.py',decisions:['accept','cancel'],unsupportedDecisionCount:1});
 expect(view.title).toBe('等待执行授权');expect(view.kind).toBe('approval');if(view.kind!=='approval')return;
 expect(view.decisions).toEqual([{id:'accept',label:'批准本次'},{id:'cancel',label:'取消当前执行'}]);
 expect(view.detail).toBe('执行端未提供授权原因。');
 expect(view.details).toEqual([{label:'查看原始请求',text:'python3 script.py'},{label:'其他授权选项',text:'部分授权选项在当前界面不可用。'}]);
 expect(nativeResponse({kind:'approval',decisionId:'accept'})).toEqual({decision:'accept'});
});
it('prioritizes the supplied reason and explicit paths without interpreting the command',()=>{
 const view=nativeInteraction({id:42,kind:'approval',detail:'Compatibility reason',decisions:['accept','decline'],
  approval:{kind:'command',reason:'更新验收脚本并清理指定缓存',command:'rm -rf .cache/tooling',cwd:'/project',path:'/project/verify.mjs'}});
 expect(view).toMatchObject({id:'number:42',title:'执行命令需要授权',detail:'更新验收脚本并清理指定缓存',
  facts:[{label:'涉及路径',value:'/project/verify.mjs'},{label:'工作目录',value:'/project'}],details:[{label:'查看完整命令',text:'rm -rf .cache/tooling'}]});
 expect(view.facts).not.toContainEqual(expect.objectContaining({value:'.cache/tooling'}));
});
it('preserves an unsupported file approval context without granting a new choice',()=>{
 const view=nativeInteraction({id:'file',kind:'unsupported',detail:'',approval:{kind:'file-change',path:'/project/a.ts'}});
 expect(view).toMatchObject({kind:'unsupported',title:'修改文件需要授权',detail:'执行端未提供授权原因。',facts:[{label:'涉及路径',value:'/project/a.ts'}]});
 expect(view).not.toHaveProperty('decisions');
});
