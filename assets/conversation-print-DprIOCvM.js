import"./index--DGcS5sg.js";import{D as l}from"./cards-DOIfQaG7.js";import{c as f}from"./factory-6YZp_BEg.js";class u extends l{constructor(t,r,s){super({documentPath:r,assets:f(t,()=>r,s)})}}class c extends u{static LLM_STYLES=`
        .mdx-print-message { page-break-inside: avoid; }
        .mdx-print-message + .mdx-print-message { margin-top: 12px; }
        /* ============================================
           LLM CONVERSATION - MESSAGE
           ============================================ */

        .mdx-print-message {
            margin: 16px 0;
            padding: 16px;
            border-radius: 12px;
            border: 1px solid;
        }

        .mdx-print-message__header {
            display: flex;
            align-items: center;
            margin-bottom: 12px;
        }

        .mdx-print-message__avatar {
            width: 28px;
            height: 28px;
            border-radius: 50%;
            margin-right: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
        }

        .mdx-print-message__role {
            font-size: 0.8125em;
            font-weight: 600;
            text-transform: uppercase;
        }

        .mdx-print-message--user {
            background-color: #ddf4ff;
            border-color: #54aeff;
            margin-left: 10%;
        }

        .mdx-print-message--user .mdx-print-message__avatar {
            background-color: #0969da;
            color: #ffffff;
        }

        .mdx-print-message--assistant {
            background-color: #f6f8fa;
            border-color: #d0d7de;
            margin-right: 10%;
        }

        .mdx-print-message--assistant .mdx-print-message__avatar {
            background-color: #8250df;
            color: #ffffff;
        }

        .mdx-print-message--system {
            background-color: #fff8c5;
            border-color: #d4a72c;
            font-style: italic;
        }

        /* ============================================
           LLM CONVERSATION - SESSION DIVIDER
           ============================================ */

        .mdx-print-session {
            position: relative;
            margin: 32px 0;
            text-align: center;
        }

        .mdx-print-session__line {
            position: absolute;
            top: 50%;
            left: 0;
            right: 0;
            border-top: 2px dashed #d0d7de;
        }

        .mdx-print-session__label {
            position: relative;
            display: inline-block;
            padding: 4px 16px;
            background-color: #ffffff;
            font-size: 0.75em;
            font-weight: 500;
            color: #656d76;
            text-transform: uppercase;
        }

        .mdx-print-message__content { white-space: normal; overflow-wrap: anywhere; }
    `;async renderForPrint(t,r={}){const s=this.preprocessConversation(t);return super.renderForPrint(s,{...r,styles:[c.LLM_STYLES,...Array.isArray(r.styles)?r.styles:r.styles?[r.styles]:[]]})}preprocessConversation(t){const r=t.split(`
`),s=[];let a=null,i=[];const n=()=>{if(a&&i.length>0){const e=i.join(`
`).trim();if(e){const o=this.getRoleIcon(a),d=this.getRoleLabel(a);s.push(`<div class="mdx-print-message mdx-print-message--${a}">`),s.push('  <div class="mdx-print-message__header">'),s.push(`    <span class="mdx-print-message__avatar">${o}</span>`),s.push(`    <span class="mdx-print-message__role">${d}</span>`),s.push("  </div>"),s.push(`  <div class="mdx-print-message__content">

${e}

</div>`),s.push("</div>")}i=[]}};for(const e of r){const o=e.match(/^##\s*User\s*$/i)||e.match(/^>\s*\*\*User\*\*/i),d=e.match(/^##\s*Assistant\s*$/i)||e.match(/^>\s*\*\*Assistant\*\*/i),m=e.match(/^##\s*System\s*$/i)||e.match(/^>\s*\*\*System\*\*/i),p=e.match(/^---+$/);o?(n(),a="user"):d?(n(),a="assistant"):m?(n(),a="system"):p?(n(),a=null,s.push('<div class="mdx-print-session">'),s.push('  <div class="mdx-print-session__line"></div>'),s.push('  <span class="mdx-print-session__label">New Session</span>'),s.push("</div>")):a?i.push(e):s.push(e)}return n(),s.join(`
`)}getRoleIcon(t){switch(t){case"user":return"👤";case"assistant":return"🤖";case"system":return"⚙️";default:return"💬"}}getRoleLabel(t){switch(t){case"user":return"User";case"assistant":return"Assistant";case"system":return"System";default:return t}}}export{u as D,c as L};
