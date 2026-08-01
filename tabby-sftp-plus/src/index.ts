import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { DragDropModule } from '@angular/cdk/drag-drop'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import TabbyCorePlugin, { ToolbarButtonProvider } from 'tabby-core'

import './styles.scss'
import { ButtonProvider } from './buttonProvider'
import { SftpBrowserComponent } from './components/sftpBrowser.component'
import { SFTPPlusTabComponent } from './components/sftpTab.component'
import { SftpModalComponent } from './components/sftpModal.component'
import { SftpWindowComponent } from './components/sftpWindow.component'
import { SFTPPromptModalComponent } from './components/promptModal.component'

/** @hidden */
@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        DragDropModule,
        NgbModule,
        TabbyCorePlugin,
    ],
    providers: [
        { provide: ToolbarButtonProvider, useClass: ButtonProvider, multi: true },
    ],
    declarations: [
        SftpBrowserComponent,
        SFTPPlusTabComponent,
        SftpModalComponent,
        SftpWindowComponent,
        SFTPPromptModalComponent,
    ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export default class SFTPPlusModule { }

export { SFTPPlusTabComponent, SftpBrowserComponent, SftpModalComponent }
