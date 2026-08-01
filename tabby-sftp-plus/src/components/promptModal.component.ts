import { Component, Input } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { BaseComponent } from 'tabby-core'

/** @hidden */
@Component({
    templateUrl: './promptModal.component.pug',
})
export class SFTPPromptModalComponent extends BaseComponent {
    @Input() title = ''
    @Input() prompt = ''
    @Input() value = ''
    @Input() confirmLabel = 'OK'

    constructor (
        private modalInstance: NgbActiveModal,
    ) {
        super()
    }

    confirm (): void {
        this.modalInstance.close(this.value)
    }

    cancel (): void {
        this.modalInstance.dismiss()
    }
}
