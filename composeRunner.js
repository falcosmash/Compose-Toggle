// One-shot invocations of the system script through pkexec.
//
// Rules (plan.md §5.3):
//   - pkexec only ever runs on an explicit user gesture; callers are
//     responsible for verifying integrity (integrity.js) first.
//   - Everything is asynchronous; argv is always an array, never a shell
//     string.
//   - Our end of the child's stdin is the control channel: closing it
//     (cancel()) makes the script's stdin monitor observe EOF and terminate
//     the compose process group. That is the only way userland can stop a
//     root process.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {SCRIPT_PATH} from './integrity.js';

Gio._promisify(Gio.Subprocess.prototype, 'wait_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');

// Sentinel for "terminated by a signal": no valid exit code exists then.
export const KILLED_BY_SIGNAL = -1;

// pkexec's own exit codes — the script never emits these (guaranteed by
// contract) so they unambiguously mean an authentication outcome.
export const PKEXEC_DISMISSED = 126;
export const PKEXEC_NOT_AUTHORIZED = 127;

export class ComposeRunner {
    constructor() {
        this._proc = null;
    }

    get running() {
        return this._proc !== null;
    }

    /**
     * Run `pkexec compose-ctl <subcommand> [args...]`.
     * Resolves to {exitCode, report, stderr} — never rejects for an
     * application failure, only for spawn-level errors.
     *
     * @param {string} subcommand  up | down | check | set-path
     * @param {string[]} args
     */
    async run(subcommand, args = []) {
        if (this._proc !== null)
            throw new Error('an action is already in flight');

        const argv = ['pkexec', SCRIPT_PATH, subcommand, ...args];
        const proc = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDIN_PIPE |
            Gio.SubprocessFlags.STDOUT_PIPE |
            Gio.SubprocessFlags.STDERR_PIPE);
        this._proc = proc;

        // DO NOT use communicate_utf8_async() here: it writes its input
        // buffer (empty) and then CLOSES the child's stdin immediately.
        // stdin is our cancellation channel — the script's monitor treats
        // EOF as "the extension went away" and terminates the compose
        // process group. With communicate(), every action was cancelled at
        // t=0 (the "down exits 1 but the containers are gone" bug). The
        // pipe must stay open, silent, until the child exits on its own or
        // cancel() closes it deliberately.
        let stdout = '';
        let stderr = '';
        try {
            [stdout, stderr] = await Promise.all([
                this._drain(proc.get_stdout_pipe()),
                this._drain(proc.get_stderr_pipe()),
                proc.wait_async(null),
            ]);
        } finally {
            try {
                proc.get_stdin_pipe()?.close(null);
            } catch {
                // Already closed by cancel() — fine.
            }
            if (this._proc === proc)
                this._proc = null;
        }

        // get_status() returns the RAW waitpid status (exit code << 8 —
        // e.g. 256 for exit 1); get_exit_status() is the decoded code, and
        // is only meaningful when the process exited rather than being
        // killed by a signal.
        const exitCode = proc.get_if_exited()
            ? proc.get_exit_status()
            : KILLED_BY_SIGNAL;
        return {
            exitCode,
            report: this._parseReport(stdout),
            stderr: (stderr ?? '').trim(),
        };
    }

    /** Read an input stream to EOF, decoding as UTF-8. */
    async _drain(stream) {
        const chunks = [];
        for (;;) {
            const bytes = await stream.read_bytes_async(
                65536, GLib.PRIORITY_DEFAULT, null);
            if (bytes.get_size() === 0)
                break;
            chunks.push(bytes.toArray());
        }
        const buf = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let off = 0;
        for (const c of chunks) {
            buf.set(c, off);
            off += c.length;
        }
        return new TextDecoder().decode(buf);
    }

    /**
     * Close the child's stdin: the root-side script observes EOF on its
     * monitor read and shuts the compose process group down. Used by
     * disable() when an action is still pending.
     */
    cancel() {
        const proc = this._proc;
        if (proc === null)
            return;
        try {
            proc.get_stdin_pipe()?.close(null);
        } catch {
            // Pipe already gone — the child finished on its own.
        }
        this._proc = null;
    }

    _parseReport(stdout) {
        // The script prints exactly one JSON line on stdout; anything else
        // (or nothing, e.g. pkexec dismissal) yields null.
        const line = (stdout ?? '').trim().split('\n').pop();
        if (!line)
            return null;
        try {
            const parsed = JSON.parse(line);
            return typeof parsed === 'object' ? parsed : null;
        } catch {
            return null;
        }
    }
}
