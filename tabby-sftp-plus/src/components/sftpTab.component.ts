import { Component, Injector, Input } from '@angular/core'
import { BaseTabComponent } from 'tabby-core'
import { SFTPCapableSession } from './sftpBrowser.component'

/**
 * Thin BaseTabComponent wrapper that hosts the SFTP browser as a full tab.
 * (The same browser is also hosted by SftpModalComponent in modal mode.)
 */
@Component({
    selector: 'sftp-plus-tab',
    template: '<sftp-browser class="d-flex w-100 h-100" [session]="session" [sessionLabel]="sessionLabel"></sftp-browser>',
    styles: [':host { display: flex; flex: 1; width: 100%; height: 100%; }'],
})
export class SFTPPlusTabComponent extends BaseTabComponent {
    @Input() session: SFTPCapableSession | null = null
    @Input() sessionLabel = 'SSH'

    constructor (injector: Injector) {
        super(injector)
        this.setTitle('SFTP')
        this.icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M64 480H448c35.3 0 64-28.7 64-64V160c0-35.3-28.7-64-64-64H288L245.3 53.3C233.3 41.3 217 34.5 200 34.5H64C28.7 34.5 0 63.2 0 98.5V416c0 35.3 28.7 64 64 64z"/></svg>'
    }

    ngOnInit (): void {
        this.setTitle(`${this.sessionLabel} · SFTP`)
    }
}
