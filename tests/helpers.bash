# Shared setup for the compose-ctl bats suite.
#
# The script is exercised unprivileged through its test mode
# (COMPOSE_CTL_TEST=1, only honored when EUID != 0), with /etc relocated
# under a temp prefix and a mocked `docker` binary on PATH.

setup_env() {
    SCRIPT="$BATS_TEST_DIRNAME/../system/compose-ctl"
    WORK="$BATS_TEST_TMPDIR/work"
    mkdir -p "$WORK/bin" "$WORK/etc/compose-ctl/conf.d" "$WORK/stack"

    export COMPOSE_CTL_TEST=1
    export COMPOSE_CTL_PREFIX="$WORK"
    export MOCK_LOG="$WORK/mock.log"
    export MOCK_FAIL_UP=0
    export MOCK_FAIL_DOWN=0
    export MOCK_FAIL_INFO=0
    export MOCK_PS_EMPTY=0   # ps prints nothing — the nominal state after a down
    export MOCK_SLOW=0       # up/down sleep 2s and drop a marker on completion
    export MOCK_MARKER="$WORK/action-completed"

    # Mocked docker: records invocations, honors MOCK_FAIL_* switches.
    cat >"$WORK/bin/docker" <<'MOCK'
#!/usr/bin/env bash
echo "docker $*" >>"$MOCK_LOG"
case "$1" in
    info)
        [[ ${MOCK_FAIL_INFO:-0} == 1 ]] && exit 1
        exit 0 ;;
    compose)
        shift
        # strip global -f/-p option pairs to find the verb
        args=("$@")
        verb=''
        i=0
        while [[ $i -lt ${#args[@]} ]]; do
            case "${args[$i]}" in
                -f|-p) i=$((i+2)) ;;
                *) verb="${args[$i]}"; break ;;
            esac
        done
        case "$verb" in
            version) exit 0 ;;
            up)   [[ ${MOCK_FAIL_UP:-0}   == 1 ]] && { echo "boom" >&2; exit 1; }
                  [[ ${MOCK_SLOW:-0} == 1 ]] && { sleep 2; touch "$MOCK_MARKER"; }
                  exit 0 ;;
            down) [[ ${MOCK_FAIL_DOWN:-0} == 1 ]] && { echo "boom" >&2; exit 1; }
                  [[ ${MOCK_SLOW:-0} == 1 ]] && { sleep 2; touch "$MOCK_MARKER"; }
                  exit 0 ;;
            ps)
                [[ ${MOCK_PS_EMPTY:-0} == 1 ]] && exit 0
                printf '{"Name":"svc1","State":"running"}\n'
                printf '{"Name":"svc2","State":"exited"}\n'
                exit 0 ;;
            *) exit 0 ;;
        esac ;;
esac
exit 0
MOCK
    chmod +x "$WORK/bin/docker"
    export PATH="$WORK/bin:$PATH"

    # A minimal valid compose file and a registered conf for the current uid.
    COMPOSE_FILE="$WORK/stack/docker-compose.yml"
    printf 'services:\n  app:\n    image: alpine\n' >"$COMPOSE_FILE"

    CONF="$WORK/etc/compose-ctl/conf.d/$(id -u).conf"
    printf 'COMPOSE_FILE=%s\n' "$COMPOSE_FILE" >"$CONF"
}# Shared setup for the compose-ctl bats suite.
#
# The script is exercised unprivileged through its test mode
# (COMPOSE_CTL_TEST=1, only honored when EUID != 0), with /etc relocated
# under a temp prefix and a mocked `docker` binary on PATH.

setup_env() {
    SCRIPT="$BATS_TEST_DIRNAME/../system/compose-ctl"
    WORK="$BATS_TEST_TMPDIR/work"
    mkdir -p "$WORK/bin" "$WORK/etc/compose-ctl/conf.d" "$WORK/stack"

    export COMPOSE_CTL_TEST=1
    export COMPOSE_CTL_PREFIX="$WORK"
    export MOCK_LOG="$WORK/mock.log"
    export MOCK_FAIL_UP=0
    export MOCK_FAIL_DOWN=0
    export MOCK_FAIL_INFO=0

    # Mocked docker: records invocations, honors MOCK_FAIL_* switches.
    cat >"$WORK/bin/docker" <<'MOCK'
#!/usr/bin/env bash
echo "docker $*" >>"$MOCK_LOG"
case "$1" in
    info)
        [[ ${MOCK_FAIL_INFO:-0} == 1 ]] && exit 1
        exit 0 ;;
    compose)
        shift
        # strip global -f/-p option pairs to find the verb
        args=("$@")
        verb=''
        i=0
        while [[ $i -lt ${#args[@]} ]]; do
            case "${args[$i]}" in
                -f|-p) i=$((i+2)) ;;
                *) verb="${args[$i]}"; break ;;
            esac
        done
        case "$verb" in
            version) exit 0 ;;
            up)   [[ ${MOCK_FAIL_UP:-0}   == 1 ]] && { echo "boom" >&2; exit 1; }; exit 0 ;;
            down) [[ ${MOCK_FAIL_DOWN:-0} == 1 ]] && { echo "boom" >&2; exit 1; }; exit 0 ;;
            ps)
                printf '{"Name":"svc1","State":"running"}\n'
                printf '{"Name":"svc2","State":"exited"}\n'
                exit 0 ;;
            *) exit 0 ;;
        esac ;;
esac
exit 0
MOCK
    chmod +x "$WORK/bin/docker"
    export PATH="$WORK/bin:$PATH"

    # A minimal valid compose file and a registered conf for the current uid.
    COMPOSE_FILE="$WORK/stack/docker-compose.yml"
    printf 'services:\n  app:\n    image: alpine\n' >"$COMPOSE_FILE"

    CONF="$WORK/etc/compose-ctl/conf.d/$(id -u).conf"
    printf 'COMPOSE_FILE=%s\n' "$COMPOSE_FILE" >"$CONF"
}
