#!/usr/bin/env bats
# up / down / check / version behavior with a mocked docker backend.

load helpers

setup() {
    setup_env
}

@test "version prints semver and exits 0 without any privilege" {
    unset COMPOSE_CTL_TEST COMPOSE_CTL_PREFIX
    run "$SCRIPT" version
    [ "$status" -eq 0 ]
    [[ "$output" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

@test "unknown subcommand exits 6" {
    run "$SCRIPT" frobnicate
    [ "$status" -eq 6 ]
}

@test "up succeeds: exit 0 and ok report with counts" {
    run "$SCRIPT" up
    [ "$status" -eq 0 ]
    [[ "$output" == *'"result":"ok"'* ]]
    [[ "$output" == *'"running":1'* ]]
    [[ "$output" == *'"total":2'* ]]
    grep -q 'compose .* up -d' "$MOCK_LOG"
}

@test "down succeeds: exit 0 and ok report" {
    run "$SCRIPT" down
    [ "$status" -eq 0 ]
    [[ "$output" == *'"result":"ok"'* ]]
    grep -q 'compose .* down' "$MOCK_LOG"
}

@test "up failure: exit 1 and failed report (real state, not invented)" {
    export MOCK_FAIL_UP=1
    run "$SCRIPT" up
    [ "$status" -eq 1 ]
    [[ "$output" == *'"result":"failed"'* ]]
    [[ "$output" == *'"total":2'* ]]
}

@test "daemon unreachable: exit 3" {
    export MOCK_FAIL_INFO=1
    run "$SCRIPT" up
    [ "$status" -eq 3 ]
}

@test "no compose binary: exit 8" {
    rm "$WORK/bin/docker"
    # Hide any real docker/podman on the host while keeping core utilities.
    export PATH="$WORK/bin:/usr/bin:/bin"
    run "$SCRIPT" up
    [ "$status" -eq 8 ]
}

@test "no conf for uid: exit 5" {
    rm "$CONF"
    run "$SCRIPT" up
    [ "$status" -eq 5 ]
}

@test "conf points to a missing compose file: exit 2" {
    rm "$COMPOSE_FILE"
    run "$SCRIPT" up
    [ "$status" -eq 2 ]
}

@test "conf is read inertly: shell metacharacters are not executed" {
    printf 'COMPOSE_FILE=%s\n' "$COMPOSE_FILE; touch $WORK/pwned" >"$CONF"
    run "$SCRIPT" up
    # Path does not exist as a file → exit 2, and nothing was executed.
    [ "$status" -eq 2 ]
    [ ! -e "$WORK/pwned" ]
}

@test "no -p flag: compose resolves the project name itself (CLI interop)" {
    run "$SCRIPT" up
    [ "$status" -eq 0 ]
    ! grep -q '\-p ' "$MOCK_LOG"
}

@test "check reports ok when everything is in place" {
    run "$SCRIPT" check
    [ "$status" -eq 0 ]
    [[ "$output" == *'"result":"ok"'* ]]
    [[ "$output" == *'"daemon":true'* ]]
    [[ "$output" == *'"conf":true'* ]]
}

@test "check fails with daemon down: exit 3, diagnostic JSON still emitted" {
    export MOCK_FAIL_INFO=1
    run "$SCRIPT" check
    [ "$status" -eq 3 ]
    [[ "$output" == *'"result":"failed"'* ]]
    [[ "$output" == *'"daemon":false'* ]]
}

@test "privileged subcommands refuse to run unprivileged outside test mode" {
    unset COMPOSE_CTL_TEST
    run "$SCRIPT" up
    [ "$status" -eq 6 ]
}

# ---------------------------------------------------------------------------
# Regressions for the "down exits 1 but the containers are gone" bug chain
# (raw wait status 256 seen by the extension = decoded exit 1).
# ---------------------------------------------------------------------------

@test "REGRESSION: down with zero remaining containers exits 0 (pipefail on empty ps)" {
    # After a successful down, `ps` legitimately prints nothing. grep then
    # matches nothing and exits 1 — under set -e -o pipefail this killed the
    # script mid-report and turned every nominal down into exit 1.
    MOCK_PS_EMPTY=1 run "$SCRIPT" down
    [ "$status" -eq 0 ]
    [[ "$output" == *'"result":"ok"'* ]]
    [[ "$output" == *'"running":0'* ]]
    [[ "$output" == *'"total":0'* ]]
}

@test "REGRESSION: action completes when stdin is a pipe that stays open" {
    # The stdin monitor ran as a background job, whose stdin POSIX assigns
    # to /dev/null when job control is off: it observed EOF immediately and
    # killed every action at t=0. The monitor must read a duplicate of the
    # real stdin.
    export MOCK_SLOW=1
    rm -f "$MOCK_MARKER"
    run bash -c "exec '$SCRIPT' down < <(sleep 15)"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"result":"ok"'* ]]
    [ -f "$MOCK_MARKER" ]
}

@test "REGRESSION: closing stdin cancels the action (kill survives the setsid race)" {
    # An EOF observed at spawn time races setsid()'s process-group creation;
    # the group kill must retry until it lands, then fall back to the pid.
    export MOCK_SLOW=1
    rm -f "$MOCK_MARKER"
    local t0 t1
    t0=$(date +%s)
    run bash -c "exec '$SCRIPT' down < <(:)"
    t1=$(date +%s)
    [ "$status" -eq 1 ]
    [[ "$output" == *'"result":"failed"'* ]]
    [ ! -f "$MOCK_MARKER" ]
    # Cancellation must be prompt — well under the mock's 2s runtime.
    [ $((t1 - t0)) -lt 2 ]
}
