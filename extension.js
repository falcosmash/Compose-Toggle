// Docker Compose Indicator — entry point.
// All logic lives in indicator.js; this class only owns the lifecycle.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ComposeIndicator} from './indicator.js';

export default class DockerComposeIndicatorExtension extends Extension {
    enable() {
        this._indicator = new ComposeIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        // destroy() performs the exhaustive cleanup (pipes, timeouts,
        // signals, file monitors) — see ComposeIndicator._onDestroy().
        this._indicator?.destroy();
        this._indicator = null;
    }
}
