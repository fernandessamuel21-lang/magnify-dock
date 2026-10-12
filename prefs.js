import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function scaleRow(settings, key, title, {min, max, step, digits = 0, marks = []}) {
    const adjustment = new Gtk.Adjustment({lower: min, upper: max, step_increment: step});
    const scale = new Gtk.Scale({
        adjustment,
        digits,
        draw_value: true,
        value_pos: Gtk.PositionType.LEFT,
        hexpand: true,
        valign: Gtk.Align.CENTER,
        width_request: 220,
    });
    for (const [value, label] of marks)
        scale.add_mark(value, Gtk.PositionType.BOTTOM, label);
    settings.bind(key, adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
    const row = new Adw.ActionRow({title});
    row.add_suffix(scale);
    return row;
}

export default class MagnifyDockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 640);

        const page = new Adw.PreferencesPage({
            title: 'Dock',
            icon_name: 'preferences-desktop-apps-symbolic',
        });
        window.add(page);

        const look = new Adw.PreferencesGroup({title: 'Appearance'});
        look.add(scaleRow(settings, 'icon-size', 'Size',
            {min: 24, max: 96, step: 2, marks: [[24, 'Small'], [96, 'Large']]}));
        const magnification = switchRow(settings, 'magnification', 'Magnification');
        look.add(magnification);
        const magScale = scaleRow(settings, 'magnification-scale', 'Magnification amount',
            {min: 1.1, max: 3.0, step: 0.1, digits: 1, marks: [[1.1, 'Min'], [3.0, 'Max']]});
        settings.bind('magnification', magScale, 'sensitive', Gio.SettingsBindFlags.GET);
        look.add(magScale);
        look.add(scaleRow(settings, 'background-opacity', 'Background opacity',
            {min: 0, max: 1, step: 0.05, digits: 2}));
        page.add(look);

        const behaviour = new Adw.PreferencesGroup({title: 'Behaviour'});
        behaviour.add(switchRow(settings, 'autohide', 'Automatically hide and show the Dock',
            'Move the pointer to the bottom edge of the screen to show it'));
        behaviour.add(switchRow(settings, 'animate-launch', 'Animate opening applications'));
        behaviour.add(switchRow(settings, 'show-running-dots', 'Show indicators for open applications'));
        page.add(behaviour);

        const items = new Adw.PreferencesGroup({title: 'Items'});
        items.add(switchRow(settings, 'show-launchpad', 'Show Applications button'));
        items.add(switchRow(settings, 'show-downloads', 'Show Downloads'));
        items.add(switchRow(settings, 'show-trash', 'Show Trash'));
        page.add(items);
    }
}
