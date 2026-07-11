#!/usr/bin/env bats
# set-path hostile validation (plan.md §4.3).

load helpers

setup() {
    setup_env
    rm -f "$CONF"
}

@test "valid absolute .yml path is accepted and written atomically" {
    run "$SCRIPT" set-path "$COMPOSE_FILE"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"result":"ok"'* ]]
    grep -qx "COMPOSE_FILE=$COMPOSE_FILE" "$CONF"
    # 644 permissions. GNU stat first: on Linux, BSD-style `stat -f '%Lp'`
    # does NOT fail — GNU's -f means "filesystem status" and exits 0 with
    # unrelated output, which poisoned the value and never reached the
    # fallback. `stat -c` genuinely fails on macOS, so BSD goes second.
    perms=$(stat -c '%a' "$CONF" 2>/dev/null || stat -f '%Lp' "$CONF")
    [ "$perms" = "644" ]
}

@test "relative path is rejected: exit 7" {
    run "$SCRIPT" set-path "stack/docker-compose.yml"
    [ "$status" -eq 7 ]
    [ ! -e "$CONF" ]
}

@test "wrong extension is rejected: exit 7" {
    cp "$COMPOSE_FILE" "$WORK/stack/compose.txt"
    run "$SCRIPT" set-path "$WORK/stack/compose.txt"
    [ "$status" -eq 7 ]
}

@test "nonexistent file is rejected: exit 7" {
    run "$SCRIPT" set-path "/nonexistent/docker-compose.yml"
    [ "$status" -eq 7 ]
}

@test "newline injection is rejected: exit 7" {
    run "$SCRIPT" set-path "$WORK/stack/a
COMPOSE_FILE=/evil.yml"
    [ "$status" -eq 7 ]
    [ ! -e "$CONF" ]
}

@test "compose file list a.yml:b.yml is rejected: exit 7" {
    run "$SCRIPT" set-path "$COMPOSE_FILE:$COMPOSE_FILE"
    [ "$status" -eq 7 ]
}

@test "missing argument is rejected: exit 7" {
    run "$SCRIPT" set-path
    [ "$status" -eq 7 ]
}

@test "pre-existing symlink at the conf target is replaced, not followed" {
    victim="$WORK/victim"
    echo "do not touch" >"$victim"
    ln -s "$victim" "$CONF"
    run "$SCRIPT" set-path "$COMPOSE_FILE"
    [ "$status" -eq 0 ]
    [ ! -L "$CONF" ]
    grep -qx "do not touch" "$victim"
}

@test "path with spaces and UTF-8 is accepted" {
    mkdir -p "$WORK/mé stack"
    cp "$COMPOSE_FILE" "$WORK/mé stack/docker-compose.yml"
    run "$SCRIPT" set-path "$WORK/mé stack/docker-compose.yml"
    [ "$status" -eq 0 ]
    grep -q "mé stack" "$CONF"
}

@test "registered path is then usable by up" {
    run "$SCRIPT" set-path "$COMPOSE_FILE"
    [ "$status" -eq 0 ]
    run "$SCRIPT" up
    [ "$status" -eq 0 ]
    [[ "$output" == *'"result":"ok"'* ]]
}
