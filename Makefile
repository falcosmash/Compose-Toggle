UUID = docker-compose-indicator@falco
ZIP  = $(UUID).shell-extension.zip

.PHONY: pack install-user lint test clean

pack: ## Build the EGO zip — system/ is included as data, never executed in place
	gnome-extensions pack --force \
	  --extra-source=system \
	  --extra-source=indicator.js \
	  --extra-source=composeRunner.js \
	  --extra-source=integrity.js

install-user: pack
	gnome-extensions install --force $(ZIP)

lint:
	bash -n system/compose-ctl
	@command -v shellcheck >/dev/null && shellcheck system/compose-ctl || echo "shellcheck not installed, skipped"
	@command -v eslint >/dev/null && eslint *.js || echo "eslint not installed, skipped"

test:
	bats tests/

clean:
	rm -f $(ZIP)
