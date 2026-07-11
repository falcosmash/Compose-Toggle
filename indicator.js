import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {ComposeRunner, PKEXEC_DISMISSED, PKEXEC_NOT_AUTHORIZED}
    from './composeRunner.js';
import {checkScriptFile, verifyScript, CONF_DIR, SCRIPT_PATH}
    from './integrity.js';

const STATE_STYLES = {
    on: 'dc-state-on',
    off: 'dc-state-off',
    pending: 'dc-state-pending',
    error: 'dc-state-error',
};

const STATE_ICONS = {
    on: 'media-playback-start-symbolic',
    off: 'media-playback-stop-symbolic',
    pending: 'view-refresh-symbolic',
    error: 'window-close-symbolic',
};

const EXIT_MESSAGES = {
    '-1': 'Action was interrupted',
    1: 'Compose action failed',
    2: 'Compose file not found — please reconfigure',
    3: 'Docker is not responding',
    5: 'No configuration found — please run the setup',
    6: 'Internal privilege error',
    8: 'Docker Compose is not installed',
};

export const ComposeIndicator = GObject.registerClass(
class ComposeIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Docker Compose Indicator');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._runner = new ComposeRunner();
        this._monitors = [];
        this._toggleGuard = false;
        this._destroyed = false;

        this._state = 'off';
        this._errorReason = null;

        this._icon = new St.Icon({
            icon_name: STATE_ICONS.off,
            style_class: 'system-status-icon dc-state-off',
        });
        this.add_child(this._icon);

        this._buildMenu();
        this._watchSystemPaths();
        this._initialStateCheck().catch(logError);
    }

    _buildMenu() {
        this._titleItem = new PopupMenu.PopupMenuItem('Docker Compose', {
            reactive: false,
        });
        this.menu.addMenuItem(this._titleItem);

        this._toggleItem = new PopupMenu.PopupSwitchMenuItem('Stack', false);
        this._toggleItem.connect('toggled', (_item, value) => {
            if (this._toggleGuard)
                return;
            this._onFlip(value).catch(logError);
        });
        this.menu.addMenuItem(this._toggleItem);

        this._configureItem = new PopupMenu.PopupMenuItem('Configure…');
        this._configureItem.connect('activate', () => {
            this._extension.openPreferences();
        });
        this.menu.addMenuItem(this._configureItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const prefsItem = new PopupMenu.PopupMenuItem('Preferences ⚙️');
        prefsItem.connect('activate', () => {
            this._extension.openPreferences();
        });
        this.menu.addMenuItem(prefsItem);
    }

    async _initialStateCheck() {
        const integrity = await verifyScript();
        if (this._destroyed)
            return;

        if (!integrity.ok) {
            this._setState('error', 'script');
            return;
        }

        if (!this._confExists()) {
            this._setState('error', 'conf');
            return;
        }

        const last = this._settings.get_string('last-known-state');
        this._setState(last === 'on' ? 'on' : 'off');
    }

    _confExists() {
        const uid = new Gio.Credentials().get_unix_user();
        return GLib.file_test(`${CONF_DIR}/${uid}.conf`, GLib.FileTest.EXISTS);
    }

    async _onFlip(wantUp) {
        if (this._state === 'pending' || this._runner.running) {
            this._syncToggle();
            return;
        }

        const integrity = await verifyScript();
        if (this._destroyed)
            return;
        if (!integrity.ok) {
            this._setState('error', 'script');
            return;
        }

        const previousState = this._state === 'on' ? 'on' : 'off';
        const action = wantUp ? 'up' : 'down';
        this._setState('pending');

        let result;
        try {
            result = await this._runner.run(action);
        } catch (e) {
            if (this._destroyed)
                return;
            this._setState('error', 'action');
            this._notify('Docker Compose', `Failed to start ${action}: ${e.message}`);
            return;
        }

        if (this._destroyed)
            return;

        const {exitCode, report, stderr} = result;

        if (exitCode === 0) {
            const newState = action === 'up' ? 'on' : 'off';
            this._persistState(newState);
            this._setState(newState);
            return;
        }

        if (exitCode === PKEXEC_DISMISSED || exitCode === PKEXEC_NOT_AUTHORIZED) {
            this._setState(previousState);
            if (exitCode === PKEXEC_NOT_AUTHORIZED)
                this._notify('Docker Compose', 'Authentication failed — action not performed.');
            return;
        }

        if (exitCode === 5) {
            this._setState('error', 'conf');
            return;
        }

        this._setState('error', 'action');

        let detail = EXIT_MESSAGES[exitCode] ?? `Unexpected error (exit ${exitCode})`;
        if (report !== null && typeof report.running === 'number')
            detail += ` — ${report.running}/${report.total} services running`;
        if (stderr)
            detail += `\n${stderr.split('\n').slice(-3).join('\n')}`;
        this._notify('Docker Compose', detail);
    }

    _persistState(state) {
        this._settings.set_string('last-known-state', state);
        this._settings.set_int64('last-result-timestamp',
            Math.floor(Date.now() / 1000));
    }

    _setState(state, errorReason = null) {
        this._state = state;
        this._errorReason = state === 'error' ? errorReason : null;

        this._icon.icon_name = STATE_ICONS[state];
        this._icon.style_class = `system-status-icon ${STATE_STYLES[state]}`;

        const needsSetup = this._errorReason === 'script' ||
                           this._errorReason === 'conf';

        this._toggleItem.visible = !needsSetup;
        this._configureItem.visible = needsSetup;
        this._toggleItem.setSensitive(state !== 'pending');

        this._syncToggle();
        this._updateTitle();
    }

    _syncToggle() {
        const wantChecked = this._state === 'on' ||
            (this._state === 'pending' && this._toggleItem.state);
        this._toggleGuard = true;
        try {
            this._toggleItem.setToggleState(
                this._state === 'pending' ? this._toggleItem.state : wantChecked);
        } finally {
            this._toggleGuard = false;
        }
    }

    _updateTitle() {
        let label = 'Docker Compose';
        const path = this._readConfiguredPath();
        if (path !== null)
            label = GLib.path_get_basename(path);

        const ts = this._settings.get_int64('last-result-timestamp');
        if (ts > 0) {
            const dt = GLib.DateTime.new_from_unix_local(ts);
            label += `  (${this._state === 'error' ? 'error' : 'result'} at ${dt.format('%H:%M')})`;
        }
        if (this._errorReason === 'script')
            label = 'Setup required: system script missing';
        else if (this._errorReason === 'conf')
            label = 'Setup required: no compose file configured';

        this._titleItem.label.text = label;
    }

    _readConfiguredPath() {
        const uid = new Gio.Credentials().get_unix_user();
        try {
            const [ok, bytes] = GLib.file_get_contents(`${CONF_DIR}/${uid}.conf`);
            if (!ok)
                return null;
            const text = new TextDecoder().decode(bytes);
            const line = text.split('\n').find(l => l.startsWith('COMPOSE_FILE='));
            return line ? line.slice('COMPOSE_FILE='.length) : null;
        } catch {
            return null;
        }
    }

    _notify(title, body) {
        const source = new MessageTray.Source({
            title: 'Docker Compose Indicator',
            iconName: 'dialog-warning-symbolic',
        });
        Main.messageTray.add(source);
        const notification = new MessageTray.Notification({
            source,
            title,
            body,
        });
        source.addNotification(notification);
    }

    _watchSystemPaths() {
        for (const path of [CONF_DIR, GLib.path_get_dirname(SCRIPT_PATH)]) {
            try {
                const monitor = Gio.File.new_for_path(path)
                    .monitor_directory(Gio.FileMonitorFlags.NONE, null);
                const id = monitor.connect('changed',
                    () => this._onSystemPathChanged());
                this._monitors.push([monitor, id]);
            } catch {
            }
        }
    }

    _onSystemPathChanged() {
        if (this._state === 'pending')
            return;
        const script = checkScriptFile();
        if (!script.ok) {
            this._setState('error', 'script');
            return;
        }
        if (!this._confExists()) {
            this._setState('error', 'conf');
            return;
        }
        if (this._state === 'error' && this._errorReason !== 'action') {
            const last = this._settings.get_string('last-known-state');
            this._setState(last === 'on' ? 'on' : 'off');
        } else {
            this._updateTitle();
        }
    }

    _onDestroy() {
        this._destroyed = true;
        this._runner.cancel();

        for (const [monitor, id] of this._monitors) {
            monitor.disconnect(id);
            monitor.cancel();
        }
        this._monitors = [];
        this._settings = null;

        super._onDestroy();
    }
});
