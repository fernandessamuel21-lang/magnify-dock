# Magnify Dock

A floating dock for GNOME Shell with icon magnification.

- Icons grow under the pointer and push their neighbours apart
- Icons bounce while applications open
- Dots under open applications
- Applications button (opens the app grid) and Trash, with a menu to empty it
- Right-click an app for its windows, New Window, Pin/Unpin and Quit
- Optional auto-hide: touch the bottom edge of the screen to show the dock
- Hidden on full-screen windows and the lock screen; maximized windows stay above it

Supports **GNOME Shell 50**.

## Settings

Right-click an empty part of the dock and choose **Dock Settings…**, or open
the Extensions app. Changes apply immediately.

| Setting | Default |
|---|---|
| Size | 48 px |
| Magnification / amount | on / 1.8× |
| Background opacity | 0.42 |
| Automatically hide and show the Dock | off |
| Animate opening applications | on |
| Show indicators for open applications | on |
| Show Applications button / Trash | on / on |

## Install from source

```sh
git clone https://github.com/fernandessamuel21-lang/magnify-dock.git
cd magnify-dock
./pack.sh
gnome-extensions install --force dist/magnify-dock@fernandessamuel21-lang.shell-extension.zip
```

Log out and back in, then enable it:

```sh
gnome-extensions enable magnify-dock@fernandessamuel21-lang
```

If you use Dash to Dock or Ubuntu Dock, turn it off, since both docks sit at
the bottom of the screen.

## Build the extensions.gnome.org package

```sh
./pack.sh   # -> dist/magnify-dock@fernandessamuel21-lang.shell-extension.zip
```

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
