import { Injectable } from '@angular/core'
import { ToolbarButtonProvider, ToolbarButton, AppService, NotificationsService, BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { SSHTabComponent } from 'tabby-ssh'
import { SFTPPlusTabComponent } from './components/sftpTab.component'
import { FloatingSftpService } from './floatingWindow.service'

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M64 480H448c35.3 0 64-28.7 64-64V160c0-35.3-28.7-64-64-64H288L245.3 53.3C233.3 41.3 217 34.5 200 34.5H64C28.7 34.5 0 63.2 0 98.5V416c0 35.3 28.7 64 64 64z"/></svg>'

/** @hidden */
@Injectable()
export class ButtonProvider extends ToolbarButtonProvider {
    constructor (
        private app: AppService,
        private notifications: NotificationsService,
        private floating: FloatingSftpService,
    ) {
        super()
    }

    provide (): ToolbarButton[] {
        return [{
            icon: ICON,
            title: 'SFTP+',
            weight: 5,
            click: () => this.openWindow(),
            submenu: async () => [
                { icon: ICON, title: 'Open as floating window', click: () => this.openWindow() },
                { icon: ICON, title: 'Open as tab', click: () => this.openTab() },
            ],
        }]
    }

    /** Returns the active SSH session + a friendly label, or null with a toast. */
    private resolveSession (): { session: SSHTabComponent['sshSession'], label: string } | null {
        let tab: BaseTabComponent | null = this.app.activeTab
        if (tab instanceof SplitTabComponent) {
            tab = tab.getFocusedTab()
        }
        if (!(tab instanceof SSHTabComponent) || !tab.sshSession) {
            this.notifications.error('Open an SSH tab first, then click SFTP+')
            return null
        }
        return {
            session: tab.sshSession,
            label: tab.title || (tab as any).profile?.name || 'SSH',
        }
    }

    openWindow (): void {
        const resolved = this.resolveSession()
        if (!resolved) {
            return
        }
        this.floating.open(resolved.session!, resolved.label)
    }

    openTab (): void {
        const resolved = this.resolveSession()
        if (!resolved) {
            return
        }
        this.app.openNewTabRaw({
            type: SFTPPlusTabComponent,
            inputs: { session: resolved.session, sessionLabel: resolved.label },
        })
    }
}
