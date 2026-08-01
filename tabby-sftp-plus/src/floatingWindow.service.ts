import { Injectable, EnvironmentInjector, ComponentRef, createComponent } from '@angular/core'
import { SFTPCapableSession } from './components/sftpBrowser.component'
import { SftpWindowComponent } from './components/sftpWindow.component'

/**
 * Opens the SFTP browser in a single, shared, always-on-top OS window.
 *
 * The first `open()` creates a real BrowserWindow via `window.open('')` (which,
 * in Electron, shares the opener's JS context — so we render Angular straight
 * into the popup and reuse the live SFTP session with no IPC). Subsequent
 * `open()` calls add a TAB to that same window instead of spawning new windows.
 * Events in the popup fire outside Angular's zone, so a small interval drives CD.
 */
@Injectable({ providedIn: 'root' })
export class FloatingSftpService {
    private popup: Window | null = null
    private ref: ComponentRef<SftpWindowComponent> | null = null
    private getBW: (() => any) | null = null

    constructor (
        private injector: EnvironmentInjector,
    ) {}

    open (session: SFTPCapableSession, label: string): void {
        // Window already up → just add/focus a tab, don't spawn another window.
        if (this.popup && !this.popup.closed && this.ref) {
            this.ref.instance.addSession(session, label)
            this.focusWindow()
            return
        }
        this.create(session, label)
    }

    /** Raise the popup to the foreground — DOM Window.focus() doesn't reliably
     * activate a separate Electron BrowserWindow, so go through the handle. */
    private focusWindow (): void {
        const bw = this.getBW?.()
        if (bw) {
            if (bw.isMinimized()) {
                bw.restore()
            }
            bw.show()
            bw.focus()
        } else {
            this.popup?.focus()
        }
    }

    private create (session: SFTPCapableSession, label: string): void {
        const BW = remoteBrowserWindow()
        const before: number[] = BW ? BW.getAllWindows().map((w: any) => w.id) : []

        const popup = window.open('', `sftp-plus-${Date.now()}`, 'width=1150,height=740')
        if (!popup) {
            return
        }
        this.popup = popup
        const doc = popup.document
        doc.title = `${label} · SFTP`

        // Inherit theme classes, foreground/background/font, and — importantly —
        // the root font-size, which bootstrap's rem-based spacing depends on.
        const rootCs = getComputedStyle(document.documentElement)
        const bodyCs = getComputedStyle(document.body)
        doc.documentElement.className = document.documentElement.className
        doc.body.className = document.body.className
        // Tabby sets all `--theme-*` CSS variables inline on <html> at runtime
        // (themes.service), so copy the root inline style verbatim.
        doc.documentElement.style.cssText = document.documentElement.style.cssText
        doc.body.style.cssText = document.body.style.cssText
        doc.documentElement.style.height = '100%'
        doc.documentElement.style.fontSize = rootCs.fontSize
        doc.body.style.margin = '0'
        doc.body.style.height = '100%'
        doc.body.style.background = bodyCs.backgroundColor && bodyCs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? bodyCs.backgroundColor : '#1e2228'
        doc.body.style.color = bodyCs.color
        doc.body.style.fontFamily = bodyCs.fontFamily
        doc.body.style.fontSize = bodyCs.fontSize

        const host = doc.createElement('div')
        host.style.cssText = 'position:absolute;inset:0;display:flex;'
        doc.body.appendChild(host)

        const ref: ComponentRef<SftpWindowComponent> = createComponent(SftpWindowComponent, {
            environmentInjector: this.injector,
            hostElement: host,
        })
        this.ref = ref

        // The popup's BrowserWindow is the one that appeared after window.open.
        // Resolve it lazily on first control click (it may not exist synchronously).
        let bw: any = null
        const getBW = () => {
            if (!bw && BW) {
                bw = BW.getAllWindows().find((w: any) => !before.includes(w.id)) ?? null
            }
            return bw
        }
        this.getBW = getBW
        ref.instance.controls = {
            minimize: () => getBW()?.minimize(),
            toggleMaximize: () => { const w = getBW(); if (w) { w.isMaximized() ? w.unmaximize() : w.maximize() } },
            close: () => popup.close(),
        }
        ref.instance.onEmpty = () => popup.close()
        ref.instance.addSession(session, label)

        // Render first — this injects the component styles into the MAIN document
        // head. Only THEN can we clone them into the popup.
        ref.changeDetectorRef.detectChanges()

        for (const node of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) {
            doc.head.appendChild(node.cloneNode(true))
        }

        const timer = setInterval(() => {
            try {
                ref.changeDetectorRef.detectChanges()
            } catch {
                clearInterval(timer)
            }
        }, 100)

        const cleanup = () => {
            clearInterval(timer)
            try {
                ref.destroy()
            } catch { /* already gone */ }
            this.popup = null
            this.ref = null
            this.getBW = null
        }
        popup.addEventListener('beforeunload', cleanup)
        window.addEventListener('beforeunload', () => popup.close(), { once: true })
    }
}

function remoteBrowserWindow (): any {
    try {
        return (window as any).require('@electron/remote').BrowserWindow
    } catch {
        return null
    }
}
