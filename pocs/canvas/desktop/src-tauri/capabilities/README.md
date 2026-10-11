No capabilities on purpose: board windows load the web app with zero Tauri IPC permissions.
Everything privileged (files, dialogs, menus, snapshots) happens in Rust or the sidecar.
