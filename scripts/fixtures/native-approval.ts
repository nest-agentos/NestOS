import {nativeRequest} from '../../libraries/cells-driver/src/harness/interactions';
import {renderConversationRequests,clearConversationRequests} from '../../ui/llm-ui-adapter/src/shell/remote-interactions';

async function run(){
 const editor=document.getElementById('editor')!;editor.className='llm-chat';
 const command='python3 - <<\'PY\'\n'+Array.from({length:1500},(_,index)=>`# verification step ${index}`).join('\n')+'\nPY\nrm -rf .cache/tooling';
 const native={id:17,method:'item/commandExecution/requestApproval',params:{threadId:'session',title:'调整浏览器验收脚本',reason:'备份并调整验收脚本，补充复现说明，删除指定缓存目录。',command,cwd:'/workspace',path:'/workspace/_nestos/kanban/artifacts/browser/verify.mjs',
  availableDecisions:['accept',{futurePolicy:{}},'decline']}};
 const requests=nativeRequest(native),responses:Array<{id:string|number;value:Record<string,unknown>}>=[],metrics:unknown[]=[];
 const respond=async(id:string|number,value:Record<string,unknown>)=>{responses.push({id,value});};
 const measure=async(operation:string,action:()=>void,ready:()=>boolean)=>{
  const start=performance.now();action();for(let attempt=0;attempt<500&&!ready();attempt++)await new Promise(resolve=>setTimeout(resolve,5));
  if(!ready())throw Error('APPROVAL_UI_NOT_READY:'+operation);
  const durationMs=Math.round((performance.now()-start)*100)/100;metrics.push({operation,durationMs,logicalApiCalls:0,httpRequests:0});
  if(durationMs>=5000)throw Error('PERFORMANCE_LIMIT:'+operation);
 };
 await measure('cold.render-long-command-approval',()=>renderConversationRequests(editor,requests,respond,true),()=>editor.querySelectorAll('button').length===2);
 const disclosure=editor.querySelector('details')!,body=disclosure.querySelector('pre')!,button=editor.querySelector('button')!;
 if(disclosure.open||body.textContent||editor.textContent?.includes('verification step')||responses.length)throw Error('COMMAND_EXPOSED_OR_AUTO_APPROVED');
 if(!editor.textContent?.includes(native.params.reason)||!editor.querySelector('dl')?.textContent?.includes(native.params.path))throw Error('MISSING_APPROVAL_CONTEXT');
 if(button.getBoundingClientRect().bottom>innerHeight||button.getBoundingClientRect().top<0)throw Error('APPROVAL_BUTTON_BELOW_FOLD');
 if(editor.querySelectorAll('details').length!==2)throw Error('COMPATIBILITY_NOTICE_NOT_SECONDARY');
 await measure('warm.expand-full-command',()=>{disclosure.open=true;},()=>body.textContent===command);
 renderConversationRequests(editor,requests.map(request=>({...request,responding:true})),respond,true);
 if(editor.querySelector('details')!==disclosure||!disclosure.open||!button.disabled)throw Error('PENDING_LOST_CONTEXT');
 renderConversationRequests(editor,requests,respond,true);button.click();await Promise.resolve();
 if(responses.length!==1||responses[0].id!==17||JSON.stringify(responses[0].value)!=='{"decision":"accept"}')throw Error('WRONG_AUTHORIZATION_RESPONSE');
 clearConversationRequests(editor);
 await measure('warm.render-legacy-request',()=>renderConversationRequests(editor,[{id:'old',kind:'approval',detail:command,decisions:['accept','decline']}],respond,true),()=>!!editor.querySelector('details'));
 if(!editor.textContent?.includes('执行端未提供授权原因')||editor.textContent?.includes('verification step'))throw Error('LEGACY_COMMAND_MISREPRESENTED');
 renderConversationRequests(editor,requests,respond,true);
 document.getElementById('result')!.textContent=JSON.stringify({result:'passed',environment:'Google Chrome headless; actual native request parser, adapter and shared interaction DOM; injected response port; no remote execution or HTTP transport',dataset:{approvals:1,legacyApprovals:1,commandLines:1503,backgroundLoad:'none'},metrics});
}
void run().catch(error=>{document.getElementById('result')!.textContent=JSON.stringify({result:'failed',code:error instanceof Error?error.message:'UNKNOWN'});});
