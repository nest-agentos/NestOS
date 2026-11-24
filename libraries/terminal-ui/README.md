# @nestos/terminal-ui

A browser terminal component using xterm and addon-fit. The host injects a PTY port, optional command storage, translated text and an ID generator. Import `@nestos/terminal-ui/style.css` alongside the component. The component does not depend on VFS, a settings page or a particular server transport. Closing or failing a session discards pending input instead of replaying it.
