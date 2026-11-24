# @nestos/terminal-ui

Reusable browser terminal with injected PTY and command storage ports. It has no dependency on the settings page, HTTP host or vfs-core. Preserve bounded output, close/failure handling and the rule that input is never automatically replayed. History selection must not submit input; do not log command text or terminal output. Keep xterm and addon-fit as package dependencies.
