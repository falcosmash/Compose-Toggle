// Integrity verification of the system script, performed before every pkexec.
//
// The chain is only trustworthy if the script we elevate is root-owned and
// not writable by group/other. A residual TOCTOU exists but is not
// exploitable from userland: only root can modify a file that passes these
// checks.

import Gio from 'gi://Gio';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

export const SCRIPT_PATH = '/usr/libexec/compose-ctl/compose-ctl';
export const CONF_DIR = '/etc/compose-ctl/conf.d';

// Interface versions this extension knows how to talk to.
export const COMPATIBLE_VERSIONS = /^1\./;

const ATTRS = 'unix::uid,unix::mode,standard::type';

/**
 * Synchronous stat-based checks (fast, local filesystem only).
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkScriptFile() {
    const file = Gio.File.new_for_path(SCRIPT_PATH);
    let info;
    try {
        info = file.query_info(ATTRS, Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return {ok: false, reason: 'missing'};
    }

    if (info.get_attribute_uint32('unix::uid') !== 0)
        return {ok: false, reason: 'not-root-owned'};

    const mode = info.get_attribute_uint32('unix::mode');
    if ((mode & 0o022) !== 0)
        return {ok: false, reason: 'writable-by-non-root'};

    return {ok: true};
}

/**
 * Parse "1.2.3" into comparable parts. String comparison would break at
 * 1.10 vs 1.9, hence numeric semver handling.
 */
function parseSemver(s) {
    const m = s.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!m)
        return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Full integrity check: file attributes, then `compose-ctl version`
 * (the only unprivileged invocation — never triggers a prompt).
 *
 * @returns {Promise<{ok: boolean, reason?: string, version?: string}>}
 */
export async function verifyScript() {
    const fileCheck = checkScriptFile();
    if (!fileCheck.ok)
        return fileCheck;

    let proc;
    try {
        proc = Gio.Subprocess.new(
            [SCRIPT_PATH, 'version'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    } catch {
        return {ok: false, reason: 'not-executable'};
    }

    let stdout;
    try {
        [stdout] = await proc.communicate_utf8_async(null, null);
    } catch {
        return {ok: false, reason: 'version-failed'};
    }

    if (!proc.get_successful())
        return {ok: false, reason: 'version-failed'};

    const version = (stdout ?? '').trim();
    if (!parseSemver(version) || !COMPATIBLE_VERSIONS.test(version))
        return {ok: false, reason: 'version-incompatible', version};

    return {ok: true, version};
}

/**
 * The one-time install command shown by the wizard, with the real
 * extension directory substituted in.
 */
export function installCommand(extensionPath) {
    return [
        `sudo install -d -m 755 /usr/libexec/compose-ctl ${CONF_DIR}`,
        'sudo install -o root -g root -m 755 \\',
        `  ${extensionPath}/system/compose-ctl \\`,
        `  ${SCRIPT_PATH}`,
    ].join('\n');
}
