# Preferences sync

Preferences sync keeps your personal preferences the same on every device you use. It is off by
default, and each device opts in separately.

## Turn it on

On web and desktop, open **Settings → General → Sync** and turn on **Sync preferences across
devices**. On mobile, open **Settings → Connections** and turn on **Sync preferences**.

If no server holds synced preferences yet, the device shares its own. If one does, the device
asks which to keep:

- **Use synced settings**: this device takes the shared preferences.
- **Use this device's settings**: every device takes this device's preferences.

**Cancel** leaves sync off.

## What syncs

On every device: the theme, light and dark themes and appearance mode, tool call visibility,
follow-up behavior, math rendering, project grouping and the working shelf.

On computers also: appearance, font sizes, composer and chat, sidebar, diffs, notifications,
confirmations, voice, pull request and load-balancing preferences, and custom themes.

Phones also receive your custom themes and list them in **Settings → Appearance**. A
phone never changes or deletes them on your other devices.

Per operating system: font families, font smoothing and the last editor.

On desktop also: the built-in browser, SnapShot, quit and update preferences.

Never synced: the microphone, whether SnapShot is on, and browser profiles.

## Status

- **Waiting for a server**: no server has answered yet.
- **No connected server supports sync**: your servers are older, or your pairings do not have
  settings access.
- **Syncing through**: the servers in use.

## Good to know

- Only pairings that may change settings take part.
- A device that was offline catches up when it reconnects.
- For each preference, the newest change wins.
- Older servers do not sync.
- Two servers exchange preferences only while one device is connected to both.
