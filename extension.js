// Magnify Dock: a floating dock with icon magnification, for GNOME Shell 50.
//
// Layout is done by hand (no layout managers) so the magnification can widen
// the hovered icons and push their neighbours apart, like the macOS dock.
// All sizes below are logical pixels; they are multiplied by the St scale
// factor when applied to actors.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';

const MAG_RANGE = 3;           // how many icons on each side grow
const SPACING = 6;             // gap between icons
const SEP_WIDTH = 13;          // slot width of a separator
const PAD_X = 6;               // plate padding left/right
const PAD_TOP = 6;
const PAD_BOTTOM = 10;         // room for the running dots
const MARGIN = 6;              // gap between plate and screen edge
const HOVER_TIME = 140;        // ms to grow/shrink on enter/leave
const BOUNCE_HEIGHT = 0.5;     // fraction of the icon size
const BOUNCES = 3;
const AUTOHIDE_TIME = 200;     // ms to slide in/out
const AUTOHIDE_DELAY = 400;    // ms after the pointer leaves before hiding
const REBUILD_DELAY = 150;     // ms to coalesce settings changes
const RECENT_DOWNLOADS = 10;   // files listed in the Downloads menu

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

function downloadsDir() {
    const path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ??
        GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
    return Gio.File.new_for_path(path);
}

function openUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (e) {
        console.warn(`magnify-dock: cannot open ${uri}: ${e.message}`);
    }
}

// Newest non-hidden entries of a directory, most recent first.
async function recentFiles(dir, count) {
    const all = [];
    try {
        const enumerator = await dir.enumerate_children_async(
            'standard::name,standard::display-name,standard::icon,standard::is-hidden,time::modified',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
        for (;;) {
            const batch = await enumerator.next_files_async(100, GLib.PRIORITY_DEFAULT, null);
            if (batch.length === 0)
                break;
            all.push(...batch.filter(info => !info.get_is_hidden()));
        }
        enumerator.close(null);
    } catch (e) {
        console.warn(`magnify-dock: cannot list ${dir.get_path()}: ${e.message}`);
    }
    const mtime = info => info.get_attribute_uint64('time::modified');
    return all.sort((a, b) => mtime(b) - mtime(a)).slice(0, count);
}

function readConfig(settings) {
    const iconSize = settings.get_int('icon-size');
    const magnification = settings.get_boolean('magnification')
        ? settings.get_double('magnification-scale') : 1;
    return {
        iconSize,
        magnification,
        maxIcon: Math.ceil(iconSize * magnification),
        plateHeight: iconSize + PAD_TOP + PAD_BOTTOM,
        autohide: settings.get_boolean('autohide'),
        bounce: settings.get_boolean('animate-launch'),
        dots: settings.get_boolean('show-running-dots'),
        launchpad: settings.get_boolean('show-launchpad'),
        trash: settings.get_boolean('show-trash'),
        downloads: settings.get_boolean('show-downloads'),
        opacity: settings.get_double('background-opacity'),
    };
}

class DockItem {
    constructor(dock, kind, app = null) {
        this.dock = dock;
        this.kind = kind;
        this.app = app;
        this.scale = 1;

        if (kind === 'separator') {
            this.actor = new St.Widget({style_class: 'macdock-separator'});
            return;
        }

        this.actor = new St.Widget({reactive: true, track_hover: true});
        this.visual = this._createVisual();
        this.visual.set_pivot_point(0, 0);
        this.actor.add_child(this.visual);

        this.dot = new St.Widget({style_class: 'macdock-dot', visible: false});

        this.actor.connect('notify::hover', () => this._onHoverChanged());
        this.actor.connect('motion-event', (a, e) => dock.onMotion(e));
        this.actor.connect('button-press-event', (a, e) => this._onPress(e));
        this.actor.connect('button-release-event', (a, e) => this._onRelease(e));
        this.actor.connect('destroy', () => {
            this.destroyed = true;
            this.dot.destroy();
            this.menu?.destroy();
        });
    }

    get label() {
        if (this.kind === 'app')
            return this.app.get_name();
        if (this.kind === 'trash')
            return 'Trash';
        if (this.kind === 'downloads')
            return 'Downloads';
        return 'Applications';
    }

    _createVisual() {
        const maxIcon = this.dock.cfg.maxIcon;
        if (this.kind === 'app')
            return this.app.create_icon_texture(maxIcon);
        if (this.kind === 'trash') {
            this.icon = new St.Icon({icon_name: 'user-trash', icon_size: maxIcon});
            return this.icon;
        }
        if (this.kind === 'downloads')
            return new St.Icon({icon_name: 'folder-download', icon_size: maxIcon});
        // Launchpad: grid glyph on a rounded tile
        const sf = this.dock.scaleFactor;
        return new St.Bin({
            style_class: 'macdock-launchpad',
            style: `border-radius: ${Math.round(maxIcon * 0.22 * sf)}px;`,
            width: maxIcon * sf,
            height: maxIcon * sf,
            child: new St.Icon({
                icon_name: 'view-app-grid-symbolic',
                icon_size: Math.round(maxIcon * 0.55),
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }),
        });
    }

    updateRunning() {
        if (this.kind !== 'app')
            return;
        this.dot.visible = this.dock.cfg.dots &&
            this.app.state === Shell.AppState.RUNNING;
    }

    _onHoverChanged() {
        if (this.actor.hover && !this.menu?.isOpen)
            this.dock.showLabel(this);
        else
            this.dock.hideLabel(this);
        this.dock.checkHover();
    }

    _onPress(event) {
        if (event.get_button() === Clutter.BUTTON_SECONDARY) {
            this._openMenu();
            return Clutter.EVENT_STOP;
        }
        this._pressed = true;
        return Clutter.EVENT_STOP;
    }

    _onRelease(event) {
        if (!this._pressed)
            return Clutter.EVENT_PROPAGATE;
        this._pressed = false;
        this._activate(event.get_button(), event.get_state());
        return Clutter.EVENT_STOP;
    }

    _activate(button, state) {
        if (this.kind === 'launchpad') {
            // show() is a no-op while the overview is open, so switch pages
            // through the (hidden) dash's toggle instead.
            const showApps = Main.overview.dash.showAppsButton;
            if (!Main.overview.visible)
                Main.overview.showApps();
            else if (showApps.checked)
                Main.overview.hide();
            else
                showApps.checked = true;
            return;
        }

        if (this.kind === 'trash' || this.kind === 'downloads') {
            openUri(this.kind === 'trash' ? 'trash:///' : downloadsDir().get_uri());
            Main.overview.hide();
            return;
        }

        const app = this.app;
        const newWindow = button === Clutter.BUTTON_MIDDLE ||
            (state & Clutter.ModifierType.CONTROL_MASK);
        if (newWindow && app.can_open_new_window()) {
            this.bounce();
            app.open_new_window(-1);
        } else {
            if (app.state === Shell.AppState.STOPPED)
                this.bounce();
            app.activate();
        }
        Main.overview.hide();
    }

    _openMenu() {
        if (this.kind === 'launchpad') {
            this.dock.openDockMenu();
            return;
        }
        if (this.kind === 'downloads') {
            this._openDownloadsMenu();
            return;
        }
        if (!this.menu) {
            if (this.kind === 'app') {
                this.menu = new AppMenu(this.actor, St.Side.BOTTOM, {
                    favoritesSection: true,
                    showSingleWindows: true,
                });
                this.menu.setApp(this.app);
            } else {
                this.menu = new PopupMenu.PopupMenu(this.actor, 0.5, St.Side.BOTTOM);
                this.menu.addAction('Open', () => this._activate(1, 0));
                this.menu.addAction('Empty Trash', () => {
                    Gio.Subprocess.new(['gio', 'trash', '--empty'],
                        Gio.SubprocessFlags.NONE);
                });
            }
            this.dock.registerMenu(this.menu, this);
        }
        this.menu.open(BoxPointer.PopupAnimation.FULL);
    }

    async _openDownloadsMenu() {
        if (!this.menu) {
            this.menu = new PopupMenu.PopupMenu(this.actor, 0.5, St.Side.BOTTOM);
            this.dock.registerMenu(this.menu, this);
        }
        const dir = downloadsDir();
        const files = await recentFiles(dir, RECENT_DOWNLOADS);
        if (this.destroyed)
            return;

        this.menu.removeAll();
        for (const info of files) {
            const uri = dir.get_child(info.get_name()).get_uri();
            const item = this.menu.addAction(info.get_display_name(), () => openUri(uri),
                info.get_icon());
            // Long names are shortened in the middle, keeping the extension.
            item.label.style = 'max-width: 24em;';
            item.label.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        }
        if (files.length === 0)
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem('No downloads', {reactive: false}));
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Open Downloads', () => this._activate(1, 0));
        this.menu.open(BoxPointer.PopupAnimation.FULL);
    }

    bounce() {
        if (this._bouncing || !this.dock.cfg.bounce)
            return;
        this._bouncing = true;
        const height = -this.dock.cfg.iconSize * BOUNCE_HEIGHT * this.dock.scaleFactor;
        const once = remaining => {
            this.actor.ease({
                translation_y: height,
                duration: 230,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this.actor.ease({
                    translation_y: 0,
                    duration: 230,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => {
                        const starting = this.app?.state !== Shell.AppState.RUNNING;
                        if (!this.destroyed && remaining > 1 && starting)
                            once(remaining - 1);
                        else
                            this._bouncing = false;
                    },
                }),
            });
        };
        once(BOUNCES);
    }
}

class Dock {
    constructor(extension, cfg) {
        this._extension = extension;
        this.cfg = cfg;
        this.scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._items = [];
        this._appItems = new Map();
        this._menus = [];
        this._hover = 0;            // 0..1 animated magnification amount
        this._hoverTarget = 0;
        this._pointerX = 0;         // pointer, in base-layout coordinates
        this._labelItem = null;
        this._revealed = !cfg.autohide;

        this.container = new St.Widget({name: 'macdock', reactive: false});

        this._plate = new St.Widget({
            style_class: 'macdock-plate',
            style: `background-color: rgba(40, 40, 46, ${cfg.opacity});`,
        });
        this._plate.add_effect(new Shell.BlurEffect({
            mode: Shell.BlurMode.BACKGROUND,
            radius: 30,
            brightness: 0.9,
        }));
        this.container.add_child(this._plate);

        // Reactive area under the icons; it grows upward while magnified so
        // the pointer can move across the enlarged icons without leaving.
        this._hoverZone = new St.Widget({reactive: true, track_hover: true});
        this._hoverZone.connect('notify::hover', () => this.checkHover());
        this._hoverZone.connect('motion-event', (a, e) => this.onMotion(e));
        this._hoverZone.connect('button-press-event', (a, e) => {
            if (e.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            this.openDockMenu();
            return Clutter.EVENT_STOP;
        });
        this.container.add_child(this._hoverZone);

        this._label = new St.Label({style_class: 'macdock-label', visible: false});

        this.menuManager = new PopupMenu.PopupMenuManager(this.container);

        if (cfg.autohide) {
            // Thin strip along the screen edge that reveals the dock. Added
            // before the dock so the dock stays on top of it.
            this._edge = new St.Widget({reactive: true, track_hover: true});
            this._edge.connect('notify::hover', () => this.checkHover());
            Main.layoutManager.addChrome(this._edge, {trackFullscreen: true});
        } else {
            this._strut = new St.Widget({reactive: false});
            Main.layoutManager.addChrome(this._strut, {affectsStruts: true});
        }
        Main.layoutManager.addChrome(this.container, {trackFullscreen: true});
        Main.layoutManager.addTopChrome(this._label);

        if (cfg.launchpad) {
            this._launchpad = new DockItem(this, 'launchpad');
            this._sepLeft = new DockItem(this, 'separator');
        }
        if (cfg.downloads)
            this._downloads = new DockItem(this, 'downloads');
        if (cfg.trash)
            this._trash = new DockItem(this, 'trash');
        if (cfg.downloads || cfg.trash)
            this._sepRight = new DockItem(this, 'separator');
        for (const item of [this._launchpad, this._sepLeft, this._sepRight,
            this._downloads, this._trash]) {
            if (item)
                this._addActor(item);
        }

        if (this._trash)
            this._setupTrash();

        const appSystem = Shell.AppSystem.get_default();
        appSystem.connectObject(
            'app-state-changed', () => this._queueRefresh(),
            'installed-changed', () => this._queueRefresh(), this);
        AppFavorites.getAppFavorites().connectObject(
            'changed', () => this._queueRefresh(), this);
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._place(), this);
        Main.sessionMode.connectObject(
            'updated', () => this._updateVisibility(), this);
        Main.overview.connectObject(
            'showing', () => this.checkHover(),
            'hidden', () => this.checkHover(), this);

        // The overview has its own dash; keep its space but hide it, the
        // dock sits on top of it.
        Main.overview.dash.hide();

        this._refresh();
        this._place();
        this._updateVisibility();
        this._applyReveal(false);
    }

    _addActor(item) {
        this.container.add_child(item.actor);
        if (item.dot)
            this.container.add_child(item.dot);
    }

    registerMenu(menu, item = null) {
        menu.connect('open-state-changed', (m, open) => {
            if (open && item)
                this.hideLabel(item);
            this.checkHover();
        });
        // Item menus die with their item; forget them so destroy() doesn't
        // destroy them a second time.
        menu.connect('destroy', () => {
            this._menus = this._menus.filter(m => m !== menu);
        });
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        this.menuManager.addMenu(menu);
        this._menus.push(menu);
    }

    openDockMenu() {
        if (!this._dockMenu) {
            this._dockMenu = new PopupMenu.PopupMenu(this._hoverZone, 0.5, St.Side.BOTTOM);
            this._dockMenu.addAction('Dock Settings…',
                () => this._extension.openPreferences());
            this.registerMenu(this._dockMenu);
        }
        this._dockMenu.open(BoxPointer.PopupAnimation.FULL);
    }

    _setupTrash() {
        this._trashFile = Gio.File.new_for_uri('trash:///');
        try {
            this._trashMonitor = this._trashFile.monitor_directory(
                Gio.FileMonitorFlags.NONE, null);
            this._trashMonitor.connect('changed', () => this._updateTrash());
        } catch (e) {
            console.warn(`magnify-dock: cannot monitor trash: ${e.message}`);
        }
        this._updateTrash();
    }

    _updateTrash() {
        this._trashFile.query_info_async('trash::item-count',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
            (file, res) => {
                try {
                    const info = file.query_info_finish(res);
                    const count = info.get_attribute_uint32('trash::item-count');
                    if (!this._destroyed && this._trash?.icon)
                        this._trash.icon.icon_name = count > 0 ? 'user-trash-full' : 'user-trash';
                } catch {
                    // trash:/// unavailable (no gvfs); keep the empty icon
                }
            });
    }

    _updateVisibility() {
        // Hide on the lock screen / login screen, where there are no apps.
        const show = !Main.sessionMode.isLocked && Main.sessionMode.hasWindows;
        this.container.visible = show;
        if (this._strut)
            this._strut.visible = show;
        if (this._edge)
            this._edge.visible = show;
        if (!show)
            this._label.hide();
    }

    _queueRefresh() {
        if (this._refreshId)
            return;
        this._refreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._refreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refresh() {
        const favorites = AppFavorites.getAppFavorites().getFavorites();
        const running = Shell.AppSystem.get_default().get_running()
            .filter(app => !favorites.includes(app));
        const apps = [...favorites, ...running];

        const wanted = new Set(apps.map(app => app.get_id()));
        for (const [id, item] of this._appItems) {
            if (!wanted.has(id)) {
                if (this._labelItem === item)
                    this.hideLabel(item);
                item.actor.destroy();
                this._appItems.delete(id);
            }
        }

        const appItems = apps.map(app => {
            let item = this._appItems.get(app.get_id());
            if (!item) {
                item = new DockItem(this, 'app', app);
                this._appItems.set(app.get_id(), item);
                this._addActor(item);
                if (app.state === Shell.AppState.STARTING)
                    item.bounce();
            }
            item.updateRunning();
            return item;
        });

        this._items = [this._launchpad, this._sepLeft, ...appItems,
            this._sepRight, this._downloads, this._trash].filter(Boolean);
        this._relayout();
    }

    _place() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const {iconSize, magnification, plateHeight} = this.cfg;
        const sf = this.scaleFactor;
        // Tall enough for a fully magnified icon plus its bounce.
        this._height = plateHeight + MARGIN +
            iconSize * (magnification - 1) + iconSize * BOUNCE_HEIGHT;
        this._width = monitor.width / sf;

        this.container.set_position(monitor.x,
            monitor.y + monitor.height - this._height * sf);
        this.container.set_size(monitor.width, this._height * sf);

        const strutHeight = (plateHeight + MARGIN) * sf;
        this._strut?.set_position(monitor.x, monitor.y + monitor.height - strutHeight);
        this._strut?.set_size(monitor.width, strutHeight);

        const edgeHeight = Math.max(1, Math.round(sf));
        this._edge?.set_position(monitor.x, monitor.y + monitor.height - edgeHeight);
        this._edge?.set_size(monitor.width, edgeHeight);

        this._relayout();
        this._applyReveal(false);
    }

    // --- autohide --------------------------------------------------------

    _setRevealed(revealed) {
        if (this._revealed === revealed)
            return;
        this._revealed = revealed;
        this._applyReveal(true);
    }

    _applyReveal(animate) {
        const offset = this._revealed ? 0
            : (this.cfg.plateHeight + MARGIN + 2) * this.scaleFactor;
        this.container.remove_transition('translation-y');
        if (animate) {
            this.container.ease({
                translation_y: offset,
                duration: AUTOHIDE_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this.container.translation_y = offset;
        }
    }

    _updateAutohide(active) {
        if (!this.cfg.autohide)
            return;
        if (this._hideId) {
            GLib.source_remove(this._hideId);
            this._hideId = 0;
        }
        if (active || Main.overview.visible) {
            this._setRevealed(true);
            return;
        }
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, AUTOHIDE_DELAY, () => {
            this._hideId = 0;
            this._setRevealed(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- magnification -------------------------------------------------

    _baseWidth(item) {
        return item.kind === 'separator' ? SEP_WIDTH : this.cfg.iconSize + SPACING;
    }

    onMotion(event) {
        const [x] = event.get_coords();
        const [ok, localX] = this.container.transform_stage_point(x, 0);
        if (!ok)
            return Clutter.EVENT_PROPAGATE;
        this._pointerX = localX / this.scaleFactor - this._baseLeft;
        this._setHoverTarget(1);
        this._relayout();
        return Clutter.EVENT_PROPAGATE;
    }

    checkHover() {
        // Defer: moving between two reactive actors briefly unhovers both.
        if (this._checkHoverId)
            return;
        this._checkHoverId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._checkHoverId = 0;
            const menuOpen = this._menus.some(m => m.isOpen);
            const overDock = this._hoverZone.hover ||
                this._items.some(i => i.actor.hover);
            this._setHoverTarget(overDock || menuOpen ? 1 : 0);
            this._updateAutohide(overDock || menuOpen || this._edge?.hover);
            return GLib.SOURCE_REMOVE;
        });
    }

    _setHoverTarget(target) {
        if (this._hoverTarget === target)
            return;
        this._hoverTarget = target;
        const from = this._hover;
        this._timeline?.stop();
        this._timeline = new Clutter.Timeline({
            actor: this.container,
            duration: HOVER_TIME,
            progress_mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._timeline.connect('new-frame', tl => {
            this._hover = from + (target - from) * tl.get_progress();
            this._relayout();
        });
        this._timeline.connect('completed', () => {
            this._hover = target;
            this._relayout();
        });
        this._timeline.start();
    }

    _relayout() {
        if (this._width === undefined)
            return;
        const {iconSize, magnification, maxIcon, plateHeight} = this.cfg;
        const sf = this.scaleFactor;
        const items = this._items;

        // Base (resting) layout, centred on the monitor.
        const baseWidths = items.map(i => this._baseWidth(i));
        const baseTotal = baseWidths.reduce((a, b) => a + b, 0);
        this._baseLeft = (this._width - baseTotal) / 2;

        // Scale of each icon from its distance to the pointer.
        let cursor = 0;
        const widths = items.map((item, i) => {
            const center = cursor + baseWidths[i] / 2;
            cursor += baseWidths[i];
            if (item.kind === 'separator') {
                item.scale = 1;
                return SEP_WIDTH;
            }
            const d = Math.abs(this._pointerX - center) / (iconSize + SPACING);
            const falloff = d < MAG_RANGE ? (Math.cos(Math.PI * d / MAG_RANGE) + 1) / 2 : 0;
            item.scale = 1 + (magnification - 1) * falloff * this._hover;
            return iconSize * item.scale + SPACING;
        });
        const total = widths.reduce((a, b) => a + b, 0);

        // Keep the point under the pointer fixed while the dock widens.
        let left = this._baseLeft;
        if (this._hover > 0 && magnification > 1) {
            const p = Math.clamp(this._pointerX, 0, baseTotal);
            let baseCum = 0, cum = 0;
            for (let i = 0; i < items.length; i++) {
                if (p <= baseCum + baseWidths[i] || i === items.length - 1) {
                    const frac = (p - baseCum) / baseWidths[i];
                    left = this._baseLeft + p - (cum + frac * widths[i]);
                    break;
                }
                baseCum += baseWidths[i];
                cum += widths[i];
            }
        }

        const plateY = this._height - MARGIN - plateHeight;
        this._plate.set_position((left - PAD_X) * sf, plateY * sf);
        this._plate.set_size((total + 2 * PAD_X) * sf, plateHeight * sf);

        const maxScale = Math.max(1, ...items.map(i => i.scale));
        const zoneTop = Math.min(plateY, plateY + PAD_TOP + iconSize - iconSize * maxScale);
        this._hoverZone.set_position((left - PAD_X) * sf, zoneTop * sf);
        this._hoverZone.set_size((total + 2 * PAD_X) * sf, (this._height - zoneTop) * sf);

        let x = left;
        items.forEach((item, i) => {
            const w = widths[i];
            if (item.kind === 'separator') {
                item.actor.set_position(Math.round((x + w / 2) * sf), (plateY + PAD_TOP + 4) * sf);
                item.actor.set_size(Math.max(1, Math.round(sf)), (iconSize - 8) * sf);
            } else {
                const size = iconSize * item.scale;
                item.actor.set_position((x + SPACING / 2) * sf,
                    (plateY + PAD_TOP + iconSize - size) * sf);
                item.actor.set_size(size * sf, size * sf);
                item.visual.set_scale(size / maxIcon, size / maxIcon);
                const dot = 4;
                item.dot.set_position((x + w / 2 - dot / 2) * sf,
                    (plateY + plateHeight - PAD_BOTTOM / 2 - dot / 2) * sf);
                item.dot.set_size(dot * sf, dot * sf);
            }
            x += w;
        });

        if (this._labelItem)
            this._positionLabel(this._labelItem);
    }

    // --- labels ----------------------------------------------------------

    showLabel(item) {
        this._labelItem = item;
        this._label.text = item.label;
        this._label.remove_all_transitions();
        this._label.opacity = 0;
        this._label.show();
        this._positionLabel(item);
        this._label.ease({opacity: 255, duration: 100});
    }

    hideLabel(item) {
        if (this._labelItem !== item)
            return;
        this._labelItem = null;
        this._label.hide();
    }

    _positionLabel(item) {
        const [x, y] = item.actor.get_transformed_position();
        const [w] = item.actor.get_transformed_size();
        const lw = this._label.width;
        const lx = Math.clamp(x + (w - lw) / 2, 0, global.stage.width - lw);
        this._label.set_position(Math.round(lx),
            Math.round(y - this._label.height - 8 * this.scaleFactor));
    }

    destroy() {
        this._destroyed = true;
        for (const id of [this._refreshId, this._checkHoverId, this._hideId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._timeline?.stop();
        this._trashMonitor?.cancel();
        Shell.AppSystem.get_default().disconnectObject(this);
        AppFavorites.getAppFavorites().disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.overview.dash.show();
        this._label.destroy();
        this.container.destroy();   // takes the item menus with it
        for (const menu of [...this._menus])
            menu.destroy();
        this._strut?.destroy();
        this._edge?.destroy();
    }
}

export default class MagnifyDockExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settings.connectObject('changed', () => this._queueRebuild(), this);
        this._dock = new Dock(this, readConfig(this._settings));
    }

    _queueRebuild() {
        // Every setting affects sizes or which actors exist, so rebuild the
        // dock; coalesce bursts (e.g. dragging a slider).
        if (this._rebuildId)
            GLib.source_remove(this._rebuildId);
        this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REBUILD_DELAY, () => {
            this._rebuildId = 0;
            this._dock?.destroy();
            this._dock = new Dock(this, readConfig(this._settings));
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        }
        this._settings?.disconnectObject(this);
        this._settings = null;
        this._dock?.destroy();
        this._dock = null;
    }
}
