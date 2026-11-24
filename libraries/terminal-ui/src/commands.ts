export interface SavedCommand {id:string; name:string; command:string}
export interface CommandStore {
    listCommands(): Promise<SavedCommand[]>;
    saveCommand(command:SavedCommand): Promise<void>;
    deleteCommand(id:string): Promise<void>;
    listHistory(): Promise<string[]>;
}
export class CommandPanel {
    private commands:SavedCommand[] = [];
    private history:string[] = [];
    private editing?:string;
    constructor(private readonly root:HTMLElement, private readonly store:CommandStore,
        private readonly t:(key:string)=>string, private readonly newId:()=>string,
        private readonly insert:(command:string, execute:boolean)=>void, private readonly error:(error:unknown)=>void) {}
    async show(kind:'commands'|'history'):Promise<void> {
        try {
            if (kind === 'commands') this.commands = await this.store.listCommands(); else this.history = await this.store.listHistory();
            this.root.hidden = false; this.root.replaceChildren();
            if (kind === 'commands') this.renderCommands(); else this.renderHistory();
        } catch (error) {this.error(error);}
    }
    private button(label:string, action:()=>void):HTMLButtonElement {
        const button=document.createElement('button');button.type='button';button.textContent=label;button.addEventListener('click',action);return button;
    }
    private renderHistory():void {
        this.root.append(this.button(this.t('terminal.dismiss'),()=>{this.root.hidden=true;}));
        for (const command of this.history) this.root.append(this.button(command,()=>this.insert(command,false)));
    }
    private renderCommands():void {
        this.root.append(this.button(this.t('terminal.dismiss'),()=>{this.root.hidden=true;}));
        for (const row of this.commands) {
            const line=document.createElement('div');
            line.append(this.button(row.name,()=>this.insert(row.command,true)),this.button(this.t('terminal.edit'),()=>this.edit(row)),
                this.button(this.t('terminal.delete'),()=>void this.remove(row.id)));this.root.append(line);
        }
        this.edit();
    }
    private edit(row?:SavedCommand):void {
        this.root.querySelector('form')?.remove();this.editing=row?.id;
        const form=document.createElement('form'),name=document.createElement('input'),command=document.createElement('textarea');
        name.placeholder=this.t('terminal.commandName');name.required=true;name.maxLength=120;name.value=row?.name??'';
        command.placeholder=this.t('terminal.commandText');command.required=true;command.maxLength=16384;command.value=row?.command??'';
        const save=document.createElement('button');save.type='submit';save.textContent=this.t('terminal.save');
        form.append(name,command,save);form.addEventListener('submit',event=>{event.preventDefault();void this.save(name.value,command.value);});this.root.append(form);
    }
    private async save(name:string,command:string):Promise<void> {
        try {this.editing ??= this.newId();await this.store.saveCommand({id:this.editing,name,command});await this.show('commands');} catch(error){this.error(error);}
    }
    private async remove(id:string):Promise<void> {
        try {await this.store.deleteCommand(id);await this.show('commands');} catch(error){this.error(error);}
    }
}
