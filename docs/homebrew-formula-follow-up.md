# Homebrew formula follow-up

The tap lives in a separate repository. Before the next release:

- [ ] Update the pinned conch version. The current formula points to a stale July build that lacks `conch install-plugin`, although the README promises that command.
- [ ] Remove the caveat telling users to run `conch service install`; `conch setup` already installs and starts the service.
- [ ] Replace the `test do` invocation of bare `conch`. It opens the dashboard and waits for tmux indefinitely, so the formula test will hang. Use a bounded command such as `conch version` instead.
