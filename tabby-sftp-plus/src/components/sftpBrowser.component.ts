import * as fsSync from 'fs'
import * as fs from 'fs/promises'
import * as os from 'os'
import { posix as posixPath } from 'path'
import * as nodePath from 'path'
import { Component, Input, Output, EventEmitter, HostListener, ViewChild, ElementRef } from '@angular/core'
import { BaseComponent, NotificationsService, PlatformService, MenuItemOptions } from 'tabby-core'
import { SFTPSession, SFTPFile } from 'tabby-ssh'
import { LocalFileUpload, LocalFileDownload, MemoryFileUpload, MemoryFileDownload, TransferControl, TransferCancelled } from '../transfers'

/** Minimal structural type — tabby-ssh does not re-export SSHSession, but all we need is openSFTP(). */
export interface SFTPCapableSession {
    openSFTP (): Promise<SFTPSession>
}

/** A unified entry for rendering either side of the dual pane. */
interface Entry {
    name: string
    fullPath: string
    isDirectory: boolean
    isSymlink: boolean
    size: number
    mode: number
    /** Last-modified time in epoch ms (0 if unknown). */
    modified: number
    /** Precomputed for the template so change detection doesn't call methods per row. */
    icon: string
    sizeLabel: string
    modifiedLabel: string
}

type Side = 'local' | 'remote'

/** In-component text editor state (notepad-style, no temp file on disk). */
interface EditorState {
    side: Side
    /** Full path of the file being edited. */
    fullPath: string
    name: string
    mode: number
    content: string
    /** Snapshot to detect unsaved changes. */
    original: string
    loading: boolean
    saving: boolean
    error: string | null
}

/** In-component dialog so prompts/confirms appear in whatever window hosts the browser. */
interface DialogState {
    kind: 'prompt' | 'confirm'
    title: string
    message: string
    value: string
    confirmLabel: string
    resolve: (value: string | boolean | null) => void
}

/** One transfer row shown in the queue. */
interface QueueItem {
    name: string
    direction: 'up' | 'down'
    /** Present for single-file transfers — gives live per-chunk byte progress. */
    transfer?: LocalFileUpload | LocalFileDownload
    /** Pause/resume/cancel handle, shared with the transfer object(s). */
    control: TransferControl
    /** Manual progress accounting, used for recursive folder transfers. */
    completedBytes: number
    totalBytes: number
    status: string
    error?: string
    done: boolean
}

/**
 * The dual-pane SFTP browser. Hosted either by a full tab (SFTPPlusTabComponent)
 * or by a movable modal (SftpModalComponent).
 */
@Component({
    selector: 'sftp-browser',
    templateUrl: './sftpTab.component.pug',
    styleUrls: ['./sftpTab.component.scss'],
})
export class SftpBrowserComponent extends BaseComponent {
    @Input() session: SFTPCapableSession | null = null
    @Input() sessionLabel = 'SSH'
    /** Hide the browser's own top bar when the host already shows one (modal). */
    @Input() compact = false
    @Output() closeRequested = new EventEmitter<void>()

    sftp: SFTPSession | null = null

    localPath = os.homedir()
    remotePath = '.'
    localEntries: Entry[] = []
    remoteEntries: Entry[] = []
    localError: string | null = null
    remoteError: string | null = null
    localLoading = false
    remoteLoading = false
    activeSide: Side = 'local'
    queue: QueueItem[] = []

    // Bounded parallelism: at most maxParallel transfers run at once, the rest wait for a slot.
    maxParallel = 3
    private activeTransfers = 0
    private slotWaiters: (() => void)[] = []

    // Navigation history (per side) + persisted bookmarks.
    private localBack: string[] = []
    private localFwd: string[] = []
    private remoteBack: string[] = []
    private remoteFwd: string[] = []
    localBookmarks: string[] = []
    remoteBookmarks: string[] = []

    // Sort order (shared by both panes; folders always group first).
    sortKey: 'name' | 'size' | 'modified' = 'name'
    sortAsc = true

    // Name filter (both panes).
    showFilter = false
    filterText = ''
    @ViewChild('filterInput') filterInput?: ElementRef<HTMLInputElement>

    dialog: DialogState | null = null
    editor: EditorState | null = null
    /** Highlighted HTML mirror of editor.content, rendered behind the transparent textarea. */
    editorHtml = ''
    private draggedEntry: Entry | null = null
    private draggedSide: Side | null = null
    dragOverSide: Side | null = null
    /** The folder row currently under the drag cursor (for the drop-target highlight). */
    dragOverEntry: Entry | null = null
    /** Set while dragging over a pane's "Up" button — drop there moves to the parent folder. */
    dropParentSide: Side | null = null

    constructor (
        private notifications: NotificationsService,
        public platform: PlatformService,
    ) {
        super()
    }

    async ngOnInit (): Promise<void> {
        this.loadBookmarks()
        await this.reloadLocal()
        if (this.session) {
            try {
                this.sftp = await this.session.openSFTP()
                this.remotePath = '/'
                await this.reloadRemote()
            } catch (error) {
                this.remoteError = error.message
            }
        } else {
            this.remoteError = 'No active SSH session. Open this from an SSH tab.'
        }
    }

    close (): void {
        this.closeRequested.emit()
    }

    // ---- Name filter ----

    @HostListener('keydown', ['$event'])
    onKeyDown (event: KeyboardEvent): void {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !this.editor) {
            event.preventDefault()
            event.stopPropagation()
            this.toggleFilter()
        }
    }

    toggleFilter (): void {
        this.showFilter = !this.showFilter
        if (this.showFilter) {
            setTimeout(() => this.filterInput?.nativeElement.focus(), 0)
        } else {
            this.filterText = ''
        }
    }

    closeFilter (): void {
        this.showFilter = false
        this.filterText = ''
    }

    /** Entries shown in a pane after applying the name filter. */
    visibleEntries (side: Side): Entry[] {
        const all = side === 'local' ? this.localEntries : this.remoteEntries
        const q = this.filterText.trim().toLowerCase()
        if (!this.showFilter || !q) {
            return all
        }
        return all.filter(e => e.name.toLowerCase().includes(q))
    }

    // ---- Local pane ----

    async reloadLocal (): Promise<void> {
        this.localError = null
        this.localLoading = true
        try {
            const names = await fs.readdir(this.localPath, { withFileTypes: true })
            const entries: Entry[] = []
            for (const d of names) {
                const full = nodePath.join(this.localPath, d.name)
                let size = 0
                let mode = 0
                let modified = 0
                try {
                    const st = fsSync.statSync(full)
                    size = st.size
                    mode = st.mode
                    modified = st.mtimeMs
                } catch { /* unreadable, keep zeros */ }
                entries.push({
                    name: d.name,
                    fullPath: full,
                    isDirectory: d.isDirectory(),
                    isSymlink: d.isSymbolicLink(),
                    size,
                    mode,
                    modified,
                    icon: '',
                    sizeLabel: '',
                    modifiedLabel: '',
                })
            }
            this.localEntries = this.finalizeEntries(entries)
        } catch (error) {
            this.localError = error.message
            this.localEntries = []
        } finally {
            this.localLoading = false
        }
    }

    async openLocal (entry: Entry): Promise<void> {
        if (entry.isDirectory) {
            await this.goLocal(entry.fullPath)
        }
    }

    async localUp (): Promise<void> {
        await this.goLocal(nodePath.dirname(this.localPath))
    }

    /** Navigate the local pane, recording history for back/forward. */
    async goLocal (path: string): Promise<void> {
        if (path !== this.localPath) {
            this.localBack.push(this.localPath)
            this.localFwd = []
        }
        this.localPath = path
        await this.reloadLocal()
    }

    async localBackNav (): Promise<void> {
        const p = this.localBack.pop()
        if (p === undefined) {
            return
        }
        this.localFwd.push(this.localPath)
        this.localPath = p
        await this.reloadLocal()
    }

    async localForwardNav (): Promise<void> {
        const p = this.localFwd.pop()
        if (p === undefined) {
            return
        }
        this.localBack.push(this.localPath)
        this.localPath = p
        await this.reloadLocal()
    }

    get canLocalBack (): boolean { return this.localBack.length > 0 }
    get canLocalForward (): boolean { return this.localFwd.length > 0 }

    // ---- Remote pane ----

    async reloadRemote (): Promise<void> {
        if (!this.sftp) {
            return
        }
        this.remoteError = null
        this.remoteLoading = true
        try {
            const files = await this.sftp.readdir(this.remotePath)
            this.remoteEntries = this.finalizeEntries(files.map((f: SFTPFile) => ({
                name: f.name,
                fullPath: f.fullPath,
                isDirectory: f.isDirectory,
                isSymlink: f.isSymlink,
                size: f.size,
                mode: f.mode,
                modified: f.modified instanceof Date ? f.modified.getTime() : 0,
                icon: '',
                sizeLabel: '',
                modifiedLabel: '',
            })))
        } catch (error) {
            this.remoteError = error.message
            this.remoteEntries = []
        } finally {
            this.remoteLoading = false
        }
    }

    async openRemote (entry: Entry): Promise<void> {
        if (entry.isDirectory) {
            await this.goRemote(entry.fullPath)
        }
    }

    async remoteUp (): Promise<void> {
        await this.goRemote(posixPath.dirname(this.remotePath))
    }

    async goRemote (path: string): Promise<void> {
        if (path !== this.remotePath) {
            this.remoteBack.push(this.remotePath)
            this.remoteFwd = []
        }
        this.remotePath = path
        await this.reloadRemote()
    }

    async remoteBackNav (): Promise<void> {
        const p = this.remoteBack.pop()
        if (p === undefined) {
            return
        }
        this.remoteFwd.push(this.remotePath)
        this.remotePath = p
        await this.reloadRemote()
    }

    async remoteForwardNav (): Promise<void> {
        const p = this.remoteFwd.pop()
        if (p === undefined) {
            return
        }
        this.remoteBack.push(this.remotePath)
        this.remotePath = p
        await this.reloadRemote()
    }

    get canRemoteBack (): boolean { return this.remoteBack.length > 0 }
    get canRemoteForward (): boolean { return this.remoteFwd.length > 0 }

    // ---- Transfers ----

    /** Upload the selected local file to the current (or given) remote directory. */
    async upload (entry: Entry, destDir: string = this.remotePath): Promise<void> {
        if (!this.sftp || entry.isDirectory) {
            return
        }
        const dest = posixPath.join(destDir, entry.name)
        if (!await this.confirmOverwriteRemote(dest)) {
            return
        }
        const control = new TransferControl()
        const upload = new LocalFileUpload(entry.fullPath, control)
        const item: QueueItem = { name: entry.name, direction: 'up', transfer: upload, control, completedBytes: 0, totalBytes: 0, status: 'queued', done: false }
        this.queue = [item, ...this.queue]
        try {
            await this.withSlot(item, async () => {
                await upload.open()
                await this.sftp!.upload(dest, upload)
            })
            item.done = true
            await this.reloadRemote()
        } catch (error) {
            this.finishError(item, error, 'Upload')
        } finally {
            upload.close()
        }
    }

    /** Download the selected remote file into the current (or given) local directory. */
    async download (entry: Entry, destDir: string = this.localPath): Promise<void> {
        if (!this.sftp || entry.isDirectory) {
            return
        }
        const target = nodePath.join(destDir, entry.name)
        if (!await this.confirmOverwriteLocal(target)) {
            return
        }
        const control = new TransferControl()
        const dl = new LocalFileDownload(target, entry.mode, entry.size, control)
        const item: QueueItem = { name: entry.name, direction: 'down', transfer: dl, control, completedBytes: 0, totalBytes: 0, status: 'queued', done: false }
        this.queue = [item, ...this.queue]
        try {
            await this.withSlot(item, async () => {
                await dl.open()
                await this.sftp!.download(entry.fullPath, dl)
            })
            item.done = true
            await this.reloadLocal()
        } catch (error) {
            dl.close()
            if (error instanceof TransferCancelled) {
                await fs.rm(target, { force: true }).catch(() => null)  // drop the partial file
            }
            this.finishError(item, error, 'Download')
        } finally {
            dl.close()
        }
    }

    // ---- Recursive folder transfers ----

    /** Download a whole remote directory into the current (or given) local directory. */
    async downloadFolder (entry: Entry, destDir: string = this.localPath): Promise<void> {
        if (!this.sftp || !entry.isDirectory) {
            return
        }
        const localRoot = nodePath.join(destDir, entry.name)
        const control = new TransferControl()
        const item: QueueItem = { name: entry.name + '/', direction: 'down', control, completedBytes: 0, totalBytes: 0, status: 'queued', done: false }
        this.queue = [item, ...this.queue]
        try {
            await this.withSlot(item, async () => {
                item.status = 'scanning…'
                await fs.mkdir(localRoot, { recursive: true })
                await this.downloadDirRecursive(entry.fullPath, localRoot, item)
            })
            item.status = ''
            item.done = true
            await this.reloadLocal()
        } catch (error) {
            this.finishError(item, error, 'Folder download')
        }
    }

    private async downloadDirRecursive (remoteDir: string, localDir: string, item: QueueItem): Promise<void> {
        const files = await this.sftp!.readdir(remoteDir)
        for (const f of files) {
            if (f.isSymlink) {
                continue
            }
            await item.control.gate()  // pause/cancel between files
            if (f.isDirectory) {
                await fs.mkdir(nodePath.join(localDir, f.name), { recursive: true })
                await this.downloadDirRecursive(f.fullPath, nodePath.join(localDir, f.name), item)
            } else {
                item.status = f.name
                item.totalBytes += f.size
                const dl = new LocalFileDownload(nodePath.join(localDir, f.name), f.mode, f.size, item.control)
                await dl.open()
                try {
                    await this.sftp!.download(f.fullPath, dl)
                    item.completedBytes += f.size
                } finally {
                    dl.close()
                }
            }
        }
    }

    /** Upload a whole local directory into the current (or given) remote directory. */
    async uploadFolder (entry: Entry, destDir: string = this.remotePath): Promise<void> {
        if (!this.sftp || !entry.isDirectory) {
            return
        }
        const remoteRoot = posixPath.join(destDir, entry.name)
        const control = new TransferControl()
        const item: QueueItem = { name: entry.name + '/', direction: 'up', control, completedBytes: 0, totalBytes: 0, status: 'queued', done: false }
        this.queue = [item, ...this.queue]
        try {
            await this.withSlot(item, async () => {
                item.status = 'scanning…'
                await this.sftp!.mkdir(remoteRoot).catch(() => null)
                await this.uploadDirRecursive(entry.fullPath, remoteRoot, item)
            })
            item.status = ''
            item.done = true
            await this.reloadRemote()
        } catch (error) {
            this.finishError(item, error, 'Folder upload')
        }
    }

    private async uploadDirRecursive (localDir: string, remoteDir: string, item: QueueItem): Promise<void> {
        const names = await fs.readdir(localDir, { withFileTypes: true })
        for (const d of names) {
            const localFull = nodePath.join(localDir, d.name)
            const remoteFull = posixPath.join(remoteDir, d.name)
            await item.control.gate()  // pause/cancel between files
            if (d.isDirectory()) {
                await this.sftp!.mkdir(remoteFull).catch(() => null)
                await this.uploadDirRecursive(localFull, remoteFull, item)
            } else if (d.isFile()) {
                item.status = d.name
                const up = new LocalFileUpload(localFull, item.control)
                await up.open()
                item.totalBytes += up.getSize()
                try {
                    await this.sftp!.upload(remoteFull, up)
                    item.completedBytes += up.getSize()
                } finally {
                    up.close()
                }
            }
        }
    }

    // ---- Queue progress helpers ----

    itemCompleted (item: QueueItem): number {
        return item.transfer ? item.transfer.getCompletedBytes() : item.completedBytes
    }

    itemTotal (item: QueueItem): number {
        return item.transfer ? item.transfer.getSize() : item.totalBytes
    }

    itemPercent (item: QueueItem): number {
        const total = this.itemTotal(item)
        return total ? Math.min(100, Math.round(this.itemCompleted(item) / total * 100)) : 0
    }

    clearFinishedQueue (): void {
        this.queue = this.queue.filter(i => !i.done && !i.error)
    }

    /** Run fn once a transfer slot is free (bounded parallelism). */
    private async withSlot<T> (item: QueueItem, fn: () => Promise<T>): Promise<T> {
        while (this.activeTransfers >= this.maxParallel) {
            await new Promise<void>(resolve => this.slotWaiters.push(resolve))
        }
        if (item.control.cancelled) {
            throw new TransferCancelled()
        }
        this.activeTransfers++
        item.status = item.status === 'queued' ? '' : item.status
        try {
            return await fn()
        } finally {
            this.activeTransfers--
            this.slotWaiters.shift()?.()
        }
    }

    /** Mark a queue row done, distinguishing a user cancel from a real failure. */
    private finishError (item: QueueItem, error: any, verb: string): void {
        if (error instanceof TransferCancelled || item.control.cancelled) {
            item.status = 'cancelled'
            item.done = true
            return
        }
        item.error = error.message
        this.notifications.error(`${verb} failed: ${error.message}`)
    }

    // ---- Queue row controls ----

    pauseItem (item: QueueItem): void { item.control.pause() }
    resumeItem (item: QueueItem): void { item.control.resume() }
    cancelItem (item: QueueItem): void { item.control.cancel() }
    isPaused (item: QueueItem): boolean { return item.control.paused && !item.control.cancelled }
    isCancelled (item: QueueItem): boolean { return item.control.cancelled }

    // ---- Drag and drop (native HTML5 — works across documents / popup window) ----

    onDragStart (entry: Entry, side: Side, event: DragEvent): void {
        this.draggedEntry = entry
        this.draggedSide = side
        if (event.dataTransfer) {
            // Must allow both: same-side drops use 'move', cross-side use 'copy'. If effectAllowed
            // is 'copy' only, Chromium cancels a 'move' drop and the drop event never fires.
            event.dataTransfer.effectAllowed = 'copyMove'
            event.dataTransfer.setData('text/plain', entry.name)
        }
    }

    onDragEnd (): void {
        this.draggedEntry = null
        this.draggedSide = null
        this.dragOverSide = null
        this.dragOverEntry = null
        this.dropParentSide = null
    }

    // ---- "Move to parent folder" — drop onto the Up button ----

    onDragOverParent (side: Side, event: DragEvent): void {
        if (!this.draggedEntry || this.draggedSide !== side) {
            return  // only same-side entries can be moved up
        }
        event.preventDefault()
        event.stopPropagation()
        this.dropParentSide = side
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'move'
        }
    }

    onDropParent (side: Side, event: DragEvent): void {
        const dragged = this.draggedEntry
        if (!dragged || this.draggedSide !== side) {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        this.onDragEnd()
        if (side === 'local') {
            const parent = nodePath.dirname(this.localPath)
            if (parent !== this.localPath) {
                this.moveLocal(dragged, parent)
            }
        } else {
            const parent = posixPath.dirname(this.remotePath)
            if (parent !== this.remotePath) {
                this.moveRemote(dragged, parent)
            }
        }
    }

    onDragOver (side: Side, event: DragEvent): void {
        // Fires for the empty pane area (folder rows stop propagation) — so clear any row highlight.
        this.dragOverEntry = null
        if (!this.draggedEntry || this.draggedSide === side) {
            return
        }
        event.preventDefault()
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'copy'
        }
        this.dragOverSide = side
    }

    onDragLeavePane (side: Side): void {
        if (this.dragOverSide === side) {
            this.dragOverSide = null
        }
    }

    onDropPane (side: Side, event: DragEvent): void {
        event.preventDefault()
        const entry = this.draggedEntry
        const from = this.draggedSide
        this.onDragEnd()
        if (!entry || !from || from === side) {
            return
        }
        if (from === 'local') {
            entry.isDirectory ? this.uploadFolder(entry) : this.upload(entry)
        } else {
            entry.isDirectory ? this.downloadFolder(entry) : this.download(entry)
        }
    }

    /** Is the row a live drop target right now (a folder, and something is being dragged onto it)? */
    isDropTarget (entry: Entry): boolean {
        return !!this.draggedEntry && entry.isDirectory && entry.fullPath !== this.draggedEntry.fullPath
    }

    onDragOverEntry (entry: Entry, side: Side, event: DragEvent): void {
        if (!this.isDropTarget(entry)) {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        this.dragOverEntry = entry
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = this.draggedSide === side ? 'move' : 'copy'
        }
    }

    /** Drop onto a folder row: same side = move into it, other side = transfer into it. */
    onDropEntry (target: Entry, side: Side, event: DragEvent): void {
        const dragged = this.draggedEntry
        const from = this.draggedSide
        if (!dragged || !from || !target.isDirectory || target.fullPath === dragged.fullPath) {
            return  // let the pane handler deal with it
        }
        event.preventDefault()
        event.stopPropagation()
        this.onDragEnd()
        if (from === side) {
            side === 'local' ? this.moveLocal(dragged, target.fullPath) : this.moveRemote(dragged, target.fullPath)
        } else if (from === 'local') {
            dragged.isDirectory ? this.uploadFolder(dragged, target.fullPath) : this.upload(dragged, target.fullPath)
        } else {
            dragged.isDirectory ? this.downloadFolder(dragged, target.fullPath) : this.download(dragged, target.fullPath)
        }
    }

    // ---- Move within one side ----

    async moveLocal (entry: Entry, destDir: string): Promise<void> {
        try {
            await fs.rename(entry.fullPath, nodePath.join(destDir, entry.name))
            await this.reloadLocal()
        } catch (error) {
            this.notifications.error(`Move failed: ${error.message}`)
        }
    }

    async moveRemote (entry: Entry, destDir: string): Promise<void> {
        if (!this.sftp) {
            return
        }
        try {
            await this.sftp.rename(entry.fullPath, posixPath.join(destDir, entry.name))
            await this.reloadRemote()
        } catch (error) {
            this.notifications.error(`Move failed: ${error.message}`)
        }
    }

    // ---- Bookmarks (persisted in localStorage, shared across windows on the same origin) ----

    private loadBookmarks (): void {
        try {
            const j = JSON.parse(localStorage['sftpPlus.bookmarks'] || '{}')
            this.localBookmarks = Array.isArray(j.local) ? j.local : []
            this.remoteBookmarks = Array.isArray(j.remote) ? j.remote : []
        } catch { /* corrupt store, start empty */ }
    }

    private saveBookmarks (): void {
        localStorage['sftpPlus.bookmarks'] = JSON.stringify({ local: this.localBookmarks, remote: this.remoteBookmarks })
    }

    get localBookmarked (): boolean { return this.localBookmarks.includes(this.localPath) }
    get remoteBookmarked (): boolean { return this.remoteBookmarks.includes(this.remotePath) }

    toggleLocalBookmark (): void {
        this.localBookmarks = this.localBookmarked
            ? this.localBookmarks.filter(p => p !== this.localPath)
            : [...this.localBookmarks, this.localPath]
        this.saveBookmarks()
    }

    toggleRemoteBookmark (): void {
        this.remoteBookmarks = this.remoteBookmarked
            ? this.remoteBookmarks.filter(p => p !== this.remotePath)
            : [...this.remoteBookmarks, this.remotePath]
        this.saveBookmarks()
    }

    removeLocalBookmark (path: string): void {
        this.localBookmarks = this.localBookmarks.filter(p => p !== path)
        this.saveBookmarks()
    }

    removeRemoteBookmark (path: string): void {
        this.remoteBookmarks = this.remoteBookmarks.filter(p => p !== path)
        this.saveBookmarks()
    }

    /** Short label for a bookmark chip — the last path segment (or the path itself for roots). */
    bookmarkLabel (path: string): string {
        // Split on separator runs and take the last non-empty segment.
        // (Avoids an anchored `/[/\\]+$/` trim, which backtracks O(n²) on paths
        // made of many separators — a ReDoS.)
        const base = path.split(/[/\\]+/).filter(Boolean).pop()
        return base || path
    }

    // ---- Local file operations ----

    async newFolderLocal (): Promise<void> {
        const name = await this.promptInput('New folder', 'Folder name', '', 'Create')
        if (!name) {
            return
        }
        try {
            await fs.mkdir(nodePath.join(this.localPath, name))
            await this.reloadLocal()
        } catch (error) {
            this.notifications.error(error.message)
        }
    }

    async renameLocal (entry: Entry): Promise<void> {
        const name = await this.promptInput('Rename', 'New name', entry.name, 'Rename')
        if (!name || name === entry.name) {
            return
        }
        try {
            await fs.rename(entry.fullPath, nodePath.join(this.localPath, name))
            await this.reloadLocal()
        } catch (error) {
            this.notifications.error(error.message)
        }
    }

    async deleteLocal (entry: Entry): Promise<void> {
        if (!await this.confirmDelete(entry.fullPath)) {
            return
        }
        try {
            await fs.rm(entry.fullPath, { recursive: true, force: true })
            await this.reloadLocal()
        } catch (error) {
            this.notifications.error(error.message)
        }
    }

    // ---- Remote file operations ----

    async newFolderRemote (): Promise<void> {
        if (!this.sftp) {
            return
        }
        const name = await this.promptInput('New folder', 'Folder name', '', 'Create')
        if (!name) {
            return
        }
        try {
            await this.sftp.mkdir(posixPath.join(this.remotePath, name))
            await this.reloadRemote()
        } catch (error) {
            this.notifications.error(error.message)
        }
    }

    async renameRemote (entry: Entry): Promise<void> {
        if (!this.sftp) {
            return
        }
        const name = await this.promptInput('Rename', 'New name', entry.name, 'Rename')
        if (!name || name === entry.name) {
            return
        }
        try {
            await this.sftp.rename(entry.fullPath, posixPath.join(this.remotePath, name))
            await this.reloadRemote()
        } catch (error) {
            this.notifications.error(error.message)
        }
    }

    async deleteRemote (entry: Entry): Promise<void> {
        if (!this.sftp) {
            return
        }
        if (!await this.confirmDelete(entry.fullPath)) {
            return
        }
        try {
            await this.rmRemoteRecursive(entry.fullPath, entry.isDirectory)
            await this.reloadRemote()
        } catch (error) {
            this.notifications.error(`Delete failed: ${error.message}`)
        }
    }

    private async rmRemoteRecursive (fullPath: string, isDirectory: boolean): Promise<void> {
        if (!isDirectory) {
            await this.sftp!.unlink(fullPath)
            return
        }
        const children = await this.sftp!.readdir(fullPath)
        for (const child of children) {
            await this.rmRemoteRecursive(child.fullPath, child.isDirectory)
        }
        await this.sftp!.rmdir(fullPath)
    }

    // ---- Built-in text editor (no temp file on disk) ----

    /** Refuse to load huge / clearly-binary files into the text editor. */
    private static readonly MAX_EDIT_BYTES = 8 * 1024 * 1024

    get editorDirty (): boolean {
        return !!this.editor && this.editor.content !== this.editor.original
    }

    async openEditor (entry: Entry, side: Side): Promise<void> {
        if (entry.isDirectory) {
            return
        }
        if (entry.size > SftpBrowserComponent.MAX_EDIT_BYTES) {
            this.notifications.error(`Too large to edit here (${entry.sizeLabel}). Download it instead.`)
            return
        }
        this.editor = {
            side, fullPath: entry.fullPath, name: entry.name, mode: entry.mode || 0o644,
            content: '', original: '', loading: true, saving: false, error: null,
        }
        try {
            let bytes: Buffer
            if (side === 'local') {
                bytes = await fs.readFile(entry.fullPath)
            } else {
                if (!this.sftp) {
                    throw new Error('Not connected')
                }
                const dl = new MemoryFileDownload(entry.name, entry.size)
                await this.sftp.download(entry.fullPath, dl)
                bytes = dl.getData()
            }
            if (bytes.includes(0)) {
                throw new Error('Looks like a binary file — not editable as text.')
            }
            const text = bytes.toString('utf8')
            this.editor.content = text
            this.editor.original = text
            this.highlightEditor()
        } catch (error) {
            this.editor.error = error.message
        } finally {
            if (this.editor) {
                this.editor.loading = false
            }
        }
    }

    async saveEditor (): Promise<void> {
        const ed = this.editor
        if (!ed || ed.saving) {
            return
        }
        ed.saving = true
        ed.error = null
        try {
            const data = Buffer.from(ed.content, 'utf8')
            if (ed.side === 'local') {
                await fs.writeFile(ed.fullPath, data)
                await this.reloadLocal()
            } else {
                if (!this.sftp) {
                    throw new Error('Not connected')
                }
                await this.sftp.upload(ed.fullPath, new MemoryFileUpload(ed.name, data, ed.mode))
                await this.reloadRemote()
            }
            ed.original = ed.content
            this.notifications.notice(`Saved ${ed.name}`)
        } catch (error) {
            ed.error = error.message
            this.notifications.error(`Save failed: ${error.message}`)
        } finally {
            ed.saving = false
        }
    }

    /** Set when a close was requested on a dirty buffer — the template asks to confirm. */
    editorConfirmClose = false

    closeEditor (): void {
        if (this.editorDirty && !this.editorConfirmClose) {
            this.editorConfirmClose = true
            return
        }
        this.editor = null
        this.editorConfirmClose = false
    }

    cancelClose (): void {
        this.editorConfirmClose = false
    }

    onEditorKey (event: KeyboardEvent): void {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault()
            this.saveEditor()
        }
    }

    /** Language-agnostic tokenizer: strings, comments, numbers, and a broad keyword set. */
    // eslint-disable-next-line max-len
    private static readonly TOKEN = /(?<comment>#[^\n]*|\/\/[^\n]*|\/\*[\s\S]{0,5000}?\*\/|<!--[\s\S]{0,5000}?-->)|(?<string>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(?<number>\b\d[\d_]*(?:\.\d+)?\b)|(?<keyword>\b(?:if|else|elif|fi|then|do|done|for|while|switch|case|esac|break|continue|return|function|func|fn|const|let|var|def|class|struct|interface|enum|import|from|export|require|module|package|public|private|protected|static|void|int|float|double|char|string|bool|boolean|true|false|null|nil|none|and|or|not|in|is|new|delete|async|await|try|catch|except|finally|throw|raise|with|as|yield|lambda|echo|print|local|set|unset|source)\b)/g

    highlightEditor (): void {
        this.editorHtml = this.editor ? SftpBrowserComponent.highlight(this.editor.content) : ''
    }

    private static escapeHtml (s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }

    private static highlight (code: string): string {
        const esc = SftpBrowserComponent.escapeHtml
        // Cap tokenizer input: the comment patterns are bounded ({0,5000}) so they
        // can't blow up quadratically, but keep total regex work bounded regardless
        // of file size — very large buffers just render uncolored (still editable).
        if (code.length > 100000) {
            return esc(code)
        }
        let out = ''
        let last = 0
        for (const m of code.matchAll(SftpBrowserComponent.TOKEN)) {
            const i = m.index ?? 0
            out += esc(code.slice(last, i))
            const g = m.groups!
            const cls = g.comment !== undefined ? 'tok-comment'
                : g.string !== undefined ? 'tok-string'
                    : g.number !== undefined ? 'tok-number' : 'tok-keyword'
            out += `<span class="${cls}">${esc(m[0])}</span>`
            last = i + m[0].length
        }
        out += esc(code.slice(last))
        return out
    }

    // ---- Context menus ----

    showLocalMenu (entry: Entry, event: MouseEvent): void {
        event.preventDefault()
        this.activeSide = 'local'
        const items: MenuItemOptions[] = []
        if (entry.isDirectory) {
            items.push({ label: 'Open', click: () => this.openLocal(entry) })
            if (this.sftp) {
                items.push({ label: 'Upload folder to server', click: () => this.uploadFolder(entry) })
            }
        } else {
            items.push(
                { label: 'Edit', click: () => this.openEditor(entry, 'local') },
                { label: 'Open with default app', click: () => this.platform.openPath(entry.fullPath) },
            )
            if (this.sftp) {
                items.push({ label: 'Upload to server', click: () => this.upload(entry) })
            }
        }
        items.push(
            { type: 'separator' },
            { label: 'Show in Explorer', click: () => this.platform.showItemInFolder(entry.fullPath) },
            { label: 'New folder', click: () => this.newFolderLocal() },
            { label: 'Rename', click: () => this.renameLocal(entry) },
            { label: 'Delete', click: () => this.deleteLocal(entry) },
        )
        this.platform.popupContextMenu(items, event)
    }

    showRemoteMenu (entry: Entry, event: MouseEvent): void {
        event.preventDefault()
        this.activeSide = 'remote'
        const items: MenuItemOptions[] = []
        if (entry.isDirectory) {
            items.push(
                { label: 'Open', click: () => this.openRemote(entry) },
                { label: 'Download folder to this PC', click: () => this.downloadFolder(entry) },
            )
        } else {
            items.push(
                { label: 'Edit', click: () => this.openEditor(entry, 'remote') },
                { label: 'Download to this PC', click: () => this.download(entry) },
            )
        }
        items.push(
            { type: 'separator' },
            { label: 'New folder', click: () => this.newFolderRemote() },
            { label: 'Rename', click: () => this.renameRemote(entry) },
            { label: 'Delete', click: () => this.deleteRemote(entry) },
        )
        this.platform.popupContextMenu(items, event)
    }

    showLocalPaneMenu (event: MouseEvent): void {
        event.preventDefault()
        this.activeSide = 'local'
        this.platform.popupContextMenu([
            { label: 'New folder', click: () => this.newFolderLocal() },
            { label: 'Refresh', click: () => this.reloadLocal() },
        ], event)
    }

    showRemotePaneMenu (event: MouseEvent): void {
        event.preventDefault()
        this.activeSide = 'remote'
        this.platform.popupContextMenu([
            { label: 'New folder', click: () => this.newFolderRemote() },
            { label: 'Refresh', click: () => this.reloadRemote() },
        ], event)
    }

    // ---- Prompts ----

    private promptInput (title: string, prompt: string, value: string, confirmLabel: string): Promise<string | null> {
        return new Promise(resolve => {
            this.dialog = { kind: 'prompt', title, message: prompt, value, confirmLabel, resolve: v => resolve(v as string | null) }
        })
    }

    private confirmDelete (fullPath: string): Promise<boolean> {
        return this.confirmDialog('Delete', `Delete ${fullPath}?`, 'Delete')
    }

    private confirmDialog (title: string, message: string, confirmLabel: string): Promise<boolean> {
        return new Promise(resolve => {
            this.dialog = { kind: 'confirm', title, message, value: '', confirmLabel, resolve: v => resolve(!!v) }
        })
    }

    private async confirmOverwriteRemote (dest: string): Promise<boolean> {
        if (!this.sftp) {
            return true
        }
        const exists = await this.sftp.stat(dest).then(() => true).catch(() => false)
        return !exists || this.confirmDialog('Overwrite?', `${dest} already exists on the server. Overwrite it?`, 'Overwrite')
    }

    private async confirmOverwriteLocal (target: string): Promise<boolean> {
        const exists = await fs.stat(target).then(() => true).catch(() => false)
        return !exists || this.confirmDialog('Overwrite?', `${target} already exists. Overwrite it?`, 'Overwrite')
    }

    dialogConfirm (): void {
        const d = this.dialog
        this.dialog = null
        if (!d) {
            return
        }
        d.resolve(d.kind === 'prompt' ? (d.value.trim() || null) : true)
    }

    dialogCancel (): void {
        const d = this.dialog
        this.dialog = null
        d?.resolve(d.kind === 'prompt' ? null : false)
    }

    // ---- Helpers ----

    /** Sort, then precompute per-row display fields once (keeps CD cheap). */
    private finalizeEntries (entries: Entry[]): Entry[] {
        this.sortEntries(entries)
        for (const e of entries) {
            e.icon = this.iconFor(e)
            e.sizeLabel = this.formatSize(e.size)
            e.modifiedLabel = this.formatDate(e.modified)
        }
        return entries
    }

    /** Folders always group first, then by the active key/direction. */
    private sortEntries (entries: Entry[]): void {
        const dir = this.sortAsc ? 1 : -1
        const byKey = (a: Entry, b: Entry): number =>
            this.sortKey === 'size' ? a.size - b.size
                : this.sortKey === 'modified' ? a.modified - b.modified
                    : 0
        entries.sort((a, b) =>
            (b.isDirectory ? 1 : 0) - (a.isDirectory ? 1 : 0) ||
            dir * (byKey(a, b) || a.name.localeCompare(b.name)))
    }

    /** Toggle direction if the same column is clicked, else switch column (ascending). */
    setSort (key: 'name' | 'size' | 'modified'): void {
        if (this.sortKey === key) {
            this.sortAsc = !this.sortAsc
        } else {
            this.sortKey = key
            this.sortAsc = true
        }
        this.sortEntries(this.localEntries)
        this.sortEntries(this.remoteEntries)
        this.localEntries = [...this.localEntries]
        this.remoteEntries = [...this.remoteEntries]
    }

    trackByPath (_index: number, entry: Entry): string {
        return entry.fullPath
    }

    formatSize (bytes: number): string {
        if (!bytes) {
            return ''
        }
        const units = ['B', 'KB', 'MB', 'GB', 'TB']
        let i = 0
        let n = bytes
        while (n >= 1024 && i < units.length - 1) {
            n /= 1024
            i++
        }
        return `${n.toFixed(i ? 1 : 0)} ${units[i]}`
    }

    /** Compact modified-time label: "Feb 09 14:03" within this year, else "Feb 09 2024". */
    formatDate (ms: number): string {
        if (!ms) {
            return ''
        }
        const d = new Date(ms)
        const pad = (n: number): string => String(n).padStart(2, '0')
        const mon = d.toLocaleString('en-US', { month: 'short' })
        return d.getFullYear() === new Date().getFullYear()
            ? `${mon} ${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
            : `${mon} ${pad(d.getDate())} ${d.getFullYear()}`
    }

    iconFor (entry: Entry): string {
        if (entry.isDirectory) {
            return 'fas fa-folder text-info'
        }
        if (entry.isSymlink) {
            return 'fas fa-link text-warning'
        }
        return 'far fa-file'
    }
}
