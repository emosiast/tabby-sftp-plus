import * as fs from 'fs/promises'
import * as path from 'path'
import { FileUpload, FileDownload } from 'tabby-core'

/** Thrown from the gate when a transfer is cancelled, so the SFTP loop unwinds cleanly. */
export class TransferCancelled extends Error {
    constructor () {
        super('cancelled')
        this.name = 'TransferCancelled'
    }
}

/**
 * Cooperative pause/resume/cancel shared by a transfer and its queue row.
 * The SFTP up/download loops await read()/write() per chunk; calling gate() there
 * lets us block (pause) or unwind (cancel) without touching tabby-ssh.
 */
export class TransferControl {
    paused = false
    cancelled = false
    private waiters: (() => void)[] = []

    pause (): void {
        this.paused = true
    }

    resume (): void {
        this.paused = false
        this.wake()
    }

    cancel (): void {
        this.cancelled = true
        this.wake()
    }

    private wake (): void {
        const w = this.waiters
        this.waiters = []
        w.forEach(fn => fn())
    }

    /** Await while paused; throw TransferCancelled if cancelled. Call once per chunk. */
    async gate (): Promise<void> {
        while (this.paused && !this.cancelled) {
            await new Promise<void>(resolve => this.waiters.push(resolve))
        }
        if (this.cancelled) {
            throw new TransferCancelled()
        }
    }
}

/**
 * A FileUpload backed by a local file on disk, so we can push it straight
 * into an SFTP session without going through the OS file picker.
 */
export class LocalFileUpload extends FileUpload {
    private handle: fs.FileHandle | null = null
    private size = 0
    private mode = 0o644
    private buffer = new Uint8Array(256 * 1024)

    constructor (private filePath: string, readonly control = new TransferControl()) {
        super()
    }

    async open (): Promise<void> {
        const stat = await fs.stat(this.filePath)
        this.size = stat.size
        this.mode = stat.mode
        this.setTotalSize(this.size)
        this.handle = await fs.open(this.filePath, 'r')
    }

    getName (): string {
        return path.basename(this.filePath)
    }

    getMode (): number {
        return this.mode
    }

    getSize (): number {
        return this.size
    }

    async read (): Promise<Uint8Array> {
        if (!this.handle) {
            return new Uint8Array(0)
        }
        await this.control.gate()
        const result = await this.handle.read(this.buffer, 0, this.buffer.length, null)
        this.increaseProgress(result.bytesRead)
        if (this.getCompletedBytes() >= this.getSize()) {
            this.setCompleted(true)
        }
        return this.buffer.slice(0, result.bytesRead)
    }

    close (): void {
        this.handle?.close()
        this.handle = null
    }
}

/** A FileUpload backed by an in-memory buffer — used to write an edited file back over SFTP. */
export class MemoryFileUpload extends FileUpload {
    private offset = 0

    constructor (private name: string, private data: Uint8Array, private mode = 0o644) {
        super()
        this.setTotalSize(data.length)
    }

    getName (): string { return this.name }
    getMode (): number { return this.mode }
    getSize (): number { return this.data.length }

    async read (): Promise<Uint8Array> {
        const chunk = this.data.subarray(this.offset, this.offset + 256 * 1024)
        this.offset += chunk.length
        this.increaseProgress(chunk.length)
        if (this.offset >= this.data.length) {
            this.setCompleted(true)
        }
        return chunk
    }

    close (): void { /* nothing to release */ }
}

/** A FileDownload that collects chunks in memory — used to read a remote file for editing. */
export class MemoryFileDownload extends FileDownload {
    private chunks: Uint8Array[] = []

    constructor (private name: string, size: number) {
        super()
        this.setTotalSize(size)
    }

    getName (): string { return this.name }
    getSize (): number { return this.chunks.reduce((n, c) => n + c.length, 0) }

    async write (buffer: Uint8Array): Promise<void> {
        this.chunks.push(buffer.slice())
        this.increaseProgress(buffer.length)
    }

    getData (): Buffer {
        return Buffer.concat(this.chunks)
    }

    close (): void { /* nothing to release */ }
}

/**
 * A FileDownload that writes to a local file on disk.
 */
export class LocalFileDownload extends FileDownload {
    private handle: fs.FileHandle | null = null

    constructor (private filePath: string, private mode: number, private size: number, readonly control = new TransferControl()) {
        super()
        this.setTotalSize(size)
    }

    async open (): Promise<void> {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true })
        this.handle = await fs.open(this.filePath, 'w', this.mode || 0o644)
    }

    getName (): string {
        return path.basename(this.filePath)
    }

    getSize (): number {
        return this.size
    }

    async write (buffer: Uint8Array): Promise<void> {
        if (!this.handle) {
            return
        }
        await this.control.gate()
        await this.handle.write(buffer)
        this.increaseProgress(buffer.length)
        if (this.getCompletedBytes() >= this.getSize()) {
            this.setCompleted(true)
        }
    }

    close (): void {
        this.handle?.close()
        this.handle = null
    }
}
