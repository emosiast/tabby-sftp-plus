import { Component } from '@angular/core'
import { BaseComponent } from 'tabby-core'
import { SFTPCapableSession } from './sftpBrowser.component'

interface SftpTab {
    id: number
    session: SFTPCapableSession
    label: string
}

interface WindowControls {
    minimize: () => void
    toggleMaximize: () => void
    close: () => void
}

/**
 * Chrome for the floating SFTP window: a custom (frameless) Tabby-style title
 * bar with a tab strip + window controls, hosting one <sftp-browser> per tab.
 * Tabs are kept mounted (toggled with [hidden]) so each keeps its live SFTP
 * channel, current directory, scroll and editor state when you switch away.
 */
@Component({
    selector: 'sftp-window',
    templateUrl: './sftpWindow.component.pug',
    styleUrls: ['./sftpWindow.component.scss'],
})
export class SftpWindowComponent extends BaseComponent {
    tabs: SftpTab[] = []
    activeId = -1
    controls: WindowControls | null = null
    onEmpty: (() => void) | null = null

    private nextId = 1

    /** Add a session as a new tab, or focus the existing tab for that session. */
    addSession (session: SFTPCapableSession, label: string): void {
        const existing = this.tabs.find(t => t.session === session)
        if (existing) {
            this.activeId = existing.id
            return
        }
        const tab: SftpTab = { id: this.nextId++, session, label }
        this.tabs = [...this.tabs, tab]
        this.activeId = tab.id
    }

    selectTab (id: number): void {
        this.activeId = id
    }

    closeTab (id: number): void {
        const idx = this.tabs.findIndex(t => t.id === id)
        if (idx < 0) {
            return
        }
        this.tabs = this.tabs.filter(t => t.id !== id)
        if (this.tabs.length === 0) {
            this.onEmpty?.()
            return
        }
        if (this.activeId === id) {
            // Activate the neighbour that took its place (or the last one).
            this.activeId = (this.tabs[idx] ?? this.tabs[this.tabs.length - 1]).id
        }
    }

    trackTab (_i: number, t: SftpTab): number {
        return t.id
    }
}
