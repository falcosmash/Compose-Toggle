// Preferences: 4-step setup wizard+ settings.
//
// Runs in a separate process from the indicator: no shared in-memory state.
// Coordination happens exclusively through GSettings and the conf.d file
// monitor, both of which the indicator watches.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences}
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ComposeRunner} from './composeRunner.js';
import {verifyScript, installCommand, CONF_DIR} from './integrity.js';

Gio._promisify(Gtk.FileDialog.prototype, 'open');

export default class ComposeIndicatorPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(640, 720);

        const page = new Adw.PreferencesPage({
            title: 'Setup',
            icon_name: 'applications-system-symbolic',
        });
        window.add(page);

        this._runner = new ComposeRunner();
        this._selectedPath = null;

        this._buildStep1(page, window);
        this._buildStep2(page, window);
        this._buildStep3(page, window);
        this._buildStep4(page, window);
        this._buildStatusGroup(page);

        this._refreshAll(window).catch(logError);

        // An admin (or set-path) touching conf.d refreshes the displayed
        // configuration.
        try {
            this._confMonitor = Gio.File.new_for_path(CONF_DIR)
                .monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._confMonitor.connect('changed',
                () => this._refreshConfRow());
        } catch {
            // conf.d absent pre-install; step 1 handles it.
        }
        window.connect('close-request', () => {
            this._confMonitor?.cancel();
            this._confMonitor = null;
            return false;
        });
    }

    // ------------------------------------------------------------------
    // Step 1 — install the system script (manual sudo command + Verify)
    // ------------------------------------------------------------------

    _buildStep1(page, window) {
        const group = new Adw.PreferencesGroup({
            title: 'Step 1 — Install the system script',
            description: 'The extension never runs code from its own ' +
                'directory. Copy the helper script to a root-owned location ' +
                'by running this command in a terminal (one time only):',
        });
        page.add(group);

        const command = installCommand(this.path);

        const commandView = new Gtk.TextView({
            editable: false,
            monospace: true,
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            top_margin: 8, bottom_margin: 8,
            left_margin: 8, right_margin: 8,
        });
        commandView.buffer.set_text(command, -1);

        const frame = new Gtk.Frame({child: commandView});
        const row = new Adw.PreferencesRow({child: frame, activatable: false});
        group.add(row);

        const buttonBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            margin_top: 8,
            halign: Gtk.Align.END,
        });

        const copyButton = new Gtk.Button({label: 'Copy command'});
        copyButton.connect('clicked', () => {
            const display = window.get_display();
            display.get_clipboard().set(command);
            copyButton.set_label('Copied ✓');
        });
        buttonBox.append(copyButton);

        const verifyButton = new Gtk.Button({
            label: 'Verify',
            css_classes: ['suggested-action'],
        });
        verifyButton.connect('clicked', () => {
            this._refreshAll(window).catch(logError);
        });
        buttonBox.append(verifyButton);

        this._step1Status = new Adw.ActionRow({title: 'Not verified yet'});
        group.add(this._step1Status);

        const buttonRow = new Adw.PreferencesRow({
            child: buttonBox,
            activatable: false,
        });
        group.add(buttonRow);
    }

    // ------------------------------------------------------------------
    // Step 2 — choose the compose file (local validation only)
    // ------------------------------------------------------------------

    _buildStep2(page, window) {
        const group = new Adw.PreferencesGroup({
            title: 'Step 2 — Choose your compose file',
        });
        page.add(group);

        this._fileRow = new Adw.ActionRow({
            title: 'Compose file',
            subtitle: 'No file selected',
        });
        const chooseButton = new Gtk.Button({
            label: 'Choose…',
            valign: Gtk.Align.CENTER,
        });
        chooseButton.connect('clicked', () => {
            this._chooseFile(window).catch(logError);
        });
        this._fileRow.add_suffix(chooseButton);
        group.add(this._fileRow);
    }

    async _chooseFile(window) {
        const filter = new Gtk.FileFilter();
        filter.set_name('Compose files (*.yml, *.yaml)');
        filter.add_pattern('*.yml');
        filter.add_pattern('*.yaml');

        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);

        const dialog = new Gtk.FileDialog({
            title: 'Select docker-compose.yml',
            filters,
            default_filter: filter,
        });

        let file;
        try {
            file = await dialog.open(window, null);
        } catch {
            return; // dismissed
        }

        const path = file.get_path();
        const problem = this._validateLocally(path);
        if (problem !== null) {
            this._fileRow.set_subtitle(`✗ ${problem}`);
            this._selectedPath = null;
            return;
        }

        this._selectedPath = path;
        this._fileRow.set_subtitle(`✓ ${path}`);
        this._registerButton.set_sensitive(true);
    }

    _validateLocally(path) {
        // Cheap userland validation before bothering root; the script
        // re-validates everything under pkexec.
        if (!path || !path.startsWith('/'))
            return 'Path must be absolute';
        if (!GLib.file_test(path, GLib.FileTest.IS_REGULAR))
            return 'File does not exist';
        let contents;
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            if (!ok)
                return 'File is not readable';
            contents = new TextDecoder().decode(bytes);
        } catch {
            return 'File is not readable';
        }
        if (!/^services\s*:/m.test(contents))
            return 'File has no top-level "services:" key';
        return null;
    }

    // ------------------------------------------------------------------
    // Step 3 — register the path (pkexec set-path)
    // ------------------------------------------------------------------

    _buildStep3(page, _window) {
        const group = new Adw.PreferencesGroup({
            title: 'Step 3 — Register the path',
            description: 'Saving writes the path to a root-owned ' +
                'configuration file. An administrator password prompt will ' +
                'appear — it is the generic system prompt and mentions ' +
                '"compose-ctl set-path".',
        });
        page.add(group);

        this._registerRow = new Adw.ActionRow({title: 'Not registered yet'});
        this._registerButton = new Gtk.Button({
            label: 'Register (admin prompt)',
            valign: Gtk.Align.CENTER,
            sensitive: false,
        });
        this._registerButton.connect('clicked', () => {
            this._registerPath().catch(logError);
        });
        this._registerRow.add_suffix(this._registerButton);
        group.add(this._registerRow);
    }

    async _registerPath() {
        if (this._selectedPath === null || this._runner.running)
            return;

        // Integrity before every pkexec.
        const integrity = await verifyScript();
        if (!integrity.ok) {
            this._registerRow.set_title(
                '✗ System script missing or invalid — complete step 1 first');
            return;
        }

        this._registerButton.set_sensitive(false);
        this._registerRow.set_title('Waiting for authentication…');

        let result;
        try {
            result = await this._runner.run('set-path', [this._selectedPath]);
        } catch (e) {
            this._registerRow.set_title(`✗ Failed to run: ${e.message}`);
            this._registerButton.set_sensitive(true);
            return;
        }

        this._registerButton.set_sensitive(true);

        if (result.exitCode === 0) {
            this._registerRow.set_title('✓ Path registered');
            this._checkButton.set_sensitive(true);
        } else if (result.exitCode === 126 || result.exitCode === 127) {
            this._registerRow.set_title('Authentication cancelled or refused');
        } else if (result.exitCode === 7) {
            this._registerRow.set_title(
                `✗ Path rejected: ${result.stderr || 'validation failed'}`);
        } else {
            this._registerRow.set_title(
                `✗ Error (exit ${result.exitCode}): ${result.stderr}`);
        }
        this._refreshConfRow();
    }

    // ------------------------------------------------------------------
    // Step 4 — diagnostic (pkexec check)
    // ------------------------------------------------------------------

    _buildStep4(page, _window) {
        const group = new Adw.PreferencesGroup({
            title: 'Step 4 — Diagnostic',
            description: 'Runs a full check as root (compose binary, ' +
                'daemon, configuration, file). This asks for authentication ' +
                'again — each elevation is an explicit, separate action.',
        });
        page.add(group);

        this._checkRow = new Adw.ActionRow({title: 'Not checked yet'});
        this._checkButton = new Gtk.Button({
            label: 'Run diagnostic (admin prompt)',
            valign: Gtk.Align.CENTER,
        });
        this._checkButton.connect('clicked', () => {
            this._runCheck().catch(logError);
        });
        this._checkRow.add_suffix(this._checkButton);
        group.add(this._checkRow);
    }

    async _runCheck() {
        if (this._runner.running)
            return;

        const integrity = await verifyScript();
        if (!integrity.ok) {
            this._checkRow.set_title('✗ System script missing or invalid');
            return;
        }

        this._checkButton.set_sensitive(false);
        this._checkRow.set_title('Waiting for authentication…');

        let result;
        try {
            result = await this._runner.run('check');
        } catch (e) {
            this._checkRow.set_title(`✗ Failed to run: ${e.message}`);
            this._checkButton.set_sensitive(true);
            return;
        }

        this._checkButton.set_sensitive(true);

        const r = result.report;
        if (result.exitCode === 0 && r !== null) {
            this._checkRow.set_title('✓ Everything is ready — you can close this window');
            this._checkRow.set_subtitle(
                `Backend: ${r.binary} · daemon reachable · ${r.file}`);
        } else if (result.exitCode === 126 || result.exitCode === 127) {
            this._checkRow.set_title('Authentication cancelled or refused');
        } else {
            const detail = r !== null
                ? `binary: ${r.binary || 'none'} · daemon: ${r.daemon} · conf: ${r.conf}`
                : result.stderr;
            this._checkRow.set_title(`✗ Diagnostic failed (exit ${result.exitCode})`);
            this._checkRow.set_subtitle(detail);
        }
    }

    // ------------------------------------------------------------------
    // Status group — current configuration, uninstall hint
    // ------------------------------------------------------------------

    _buildStatusGroup(page) {
        const group = new Adw.PreferencesGroup({title: 'Current configuration'});
        page.add(group);

        this._confRow = new Adw.ActionRow({title: 'No compose file registered'});
        group.add(this._confRow);

        this._refreshConfRow();
    }

    _refreshConfRow() {
        const uid = new Gio.Credentials().get_unix_user();
        try {
            const [ok, bytes] = GLib.file_get_contents(`${CONF_DIR}/${uid}.conf`);
            if (!ok)
                throw new Error();
            const text = new TextDecoder().decode(bytes);
            const line = text.split('\n').find(l => l.startsWith('COMPOSE_FILE='));
            if (line) {
                this._confRow.set_title('Registered compose file');
                this._confRow.set_subtitle(line.slice('COMPOSE_FILE='.length));
                return;
            }
        } catch {
            // fall through
        }
        this._confRow.set_title('No compose file registered');
        this._confRow.set_subtitle('');
    }

    async _refreshAll(_window) {
        const integrity = await verifyScript();
        if (integrity.ok) {
            this._step1Status.set_title(
                `✓ Script installed (interface version ${integrity.version})`);
        } else {
            const reasons = {
                'missing': 'Script not installed yet',
                'not-root-owned': '✗ Script is not owned by root',
                'writable-by-non-root': '✗ Script is writable by non-root users',
                'not-executable': '✗ Script is not executable',
                'version-failed': '✗ Script failed to report its version',
                'version-incompatible':
                    `✗ Script version ${integrity.version ?? '?'} is ` +
                    'incompatible — re-run the install command',
            };
            this._step1Status.set_title(
                reasons[integrity.reason] ?? `✗ ${integrity.reason}`);
        }
        this._refreshConfRow();
    }
}
