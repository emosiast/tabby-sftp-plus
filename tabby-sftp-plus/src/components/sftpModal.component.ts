import { Component, Input } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { BaseComponent } from 'tabby-core'
import { SFTPCapableSession } from './sftpBrowser.component'

/**
 * Movable modal that floats the SFTP browser over the SSH terminal.
 * Draggable by its title bar; the backdrop lets clicks fall through so the
 * terminal underneath stays usable.
 */
@Component({
    selector: 'sftp-modal',
    templateUrl: './sftpModal.component.pug',
    styleUrls: ['./sftpModal.component.scss'],
})
export class SftpModalComponent extends BaseComponent {
    @Input() session: SFTPCapableSession | null = null
    @Input() sessionLabel = 'SSH'

    constructor (private modal: NgbActiveModal) {
        super()
    }

    close (): void {
        this.modal.dismiss()
    }
}
