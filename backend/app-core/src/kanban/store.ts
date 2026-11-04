import {SeqKanbanStore} from '@nestos/kanban/storage';
import type {IFileSystem} from '@nestos/vfs-core';

export function openPersonalKanbanStore(fs: IFileSystem): Promise<SeqKanbanStore> {return SeqKanbanStore.open(fs, '/var/lib/kanban');}
export function openProjectKanbanStore(fs: IFileSystem): Promise<SeqKanbanStore> {return SeqKanbanStore.open(fs, '/.nestos/kanban');}
