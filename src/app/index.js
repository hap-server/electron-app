import electron, {Tray, Menu, BrowserWindow, Notification, ipcMain, session} from 'electron';
import path from 'path';
import fs from 'fs';
import url from 'url';
import persist from 'node-persist';

import Logger from '@hap-server/hap-server/core/logger';
const log = new Logger();

log.info('Starting');

import {Client, Characteristic} from '@hap-server/hap-server/client';
import {AuthenticatedUser} from '@hap-server/hap-server/common/connection';
import WebSocket from 'ws';

// const persist_path = path.join(electron.app.getPath('appData'), 'hap-server', 'persist');
const persist_path = path.resolve(__dirname, '..', '..', 'data');
const server_url = 'http://127.0.0.1:8082';

export class App {
    constructor() {
        this.client = new Client(server_url, WebSocket);

        this.url = server_url;

        this.client.accessories = {};

        this.client.on('connected', this.connected.bind(this));
        this.client.on('disconnected', this.disconnected.bind(this));

        ipcMain.on('s', this.sendFromRenderer.bind(this));
    }

    get name() {
        return this.client.home_settings && this.client.home_settings.name || 'Home';
    }

    get url() {
        return this._url;
    }
    set url(base_url) {
        this._url = base_url;
        if (this.window) this.window.send('url', base_url);

        const parsed = url.parse(base_url);

        this.websocket_url = parsed.protocol.replace('http', 'ws') + '//' + parsed.host + '/websocket';
    }

    get websocket_url() {
        return this.client.url;
    }
    set websocket_url(url) {
        this.client.url = url;
        if (this.client.connected) this.client.disconnect().then(() => this.client.tryConnect());
        // if (this.window) this.window.send('reset-has-connected');
    }

    async connected(connection) {
        log.info('Connected to %s', client.url, client);

        if (this.window) this.window.send('up');

        connection.on('received-broadcast', data => {
            if (this.window) this.window.send('b', data);
        });

        connection.on('update-characteristic', this.handleUpdateCharateristic.bind(this));

        this.constructor.menu.items[1].enabled = false;
        this.constructor.menu.items[2].enabled = true;

        this.constructor.tray.setContextMenu(this.constructor.menu);
        if (process.platform === 'darwin') electron.app.dock.setMenu(this.constructor.menu);

        const token = await this.constructor.storage.getItem('Token');
        if (this.ready && token) {
            try {
                await app.authenticateWithToken(token);
            } catch (err) {
                log.error('Error authenticating', err);
            }
        }
    }

    disconnected(event) {
        log.warn('Disconnected from %s', client.url, event);

        if (this.window) this.window.send('down');

        if (event !== 1005) this.client.tryConnect();

        this.constructor.menu.items[1].enabled = true;
        this.constructor.menu.items[2].enabled = false;

        this.constructor.tray.setContextMenu(this.constructor.menu);
        if (process.platform === 'darwin') electron.app.dock.setMenu(this.constructor.menu);
    }

    handleUpdateCharateristic(accessory_uuid, service_uuid, characteristic_uuid, details) {
        const accessory = this.client.accessories[accessory_uuid];

        if (!accessory) {
            log.warn('Received characteristic update for an unknown accessory', accessory_uuid, service_uuid,
                characteristic_uuid, details);
            return;
        }

        const service = accessory.findService(s => s.uuid === service_uuid);
        const characteristic = service.findCharacteristic(c => c.uuid === characteristic_uuid);

        log.info('Characteristic updated', accessory.uuid, service.uuid, characteristic.uuid, characteristic.value);

        if (service.is_system_service) return;
        if (characteristic.uuid === '00000023-0000-1000-8000-656261617577') return; // homebridge-hue Last Updated

        const notification = new Notification({
            title: this.name,
            subtitle: 'Characteristic updated',
            body: service.name + ' ' + (
                characteristic.type === characteristic.constructor.On ? characteristic.value ? 'on' : 'off' :
                ''),
        });

        notification.show();
    }

    async authenticateWithToken(token) {
        const response = await this.client.connection.send({
            type: 'authenticate',
            token,
        });

        if (response.reject || !response.success) throw new Error('Error restoring session');

        const authenticated_user = new AuthenticatedUser(response.authentication_handler_id, response.user_id);

        Object.defineProperty(authenticated_user, 'token', {value: token});
        Object.defineProperty(authenticated_user, 'asset_token', {value: response.asset_token});
        Object.assign(authenticated_user, response.data);

        this.client.connection.authenticated_user = authenticated_user;

        this.client.connection.getHomeSettings().then(d => this.client.home_settings = d);
        this.client.refreshAccessories();

        return authenticated_user;
    }

    async sendFromRenderer(event, {messageid, data}) {
        if (this.client.connection) {
            const response = await this.client.connection.send(data);
            event.sender.send('r', {messageid, response});

            if (data.type === 'authenticate' && response.success) {
                const authenticated_user = new AuthenticatedUser(response.authentication_handler_id, response.user_id);

                Object.defineProperty(authenticated_user, 'token', {value: response.token || data.token});
                Object.defineProperty(authenticated_user, 'asset_token', {value: response.asset_token});
                Object.assign(authenticated_user, response.data);

                log.info('AuthenticatedUser', authenticated_user);
                this.client.connection.authenticated_user = authenticated_user;

                if (this.constructor.preferences_window) {
                    this.constructor.preferences_window.send('authenticated-user', {
                        id: authenticated_user.id,
                        token: authenticated_user.token,
                        asset_token: authenticated_user.asset_token,
                        data: authenticated_user,
                    });
                }

                await this.constructor.storage.setItem('Token', authenticated_user.token);

                this.client.connection.getHomeSettings().then(d => this.client.home_settings = d);
                this.client.refreshAccessories();
            }
        } else {
            event.sender.send('r', {messageid, response: null});
        }
    }

    showWindow() {
        if (this.window) {
            this.window.focus();
            return;
        }

        this.window = new BrowserWindow({
            show: false,
            backgroundColor: '#495057',
            titleBarStyle: 'hiddenInset',
            webPreferences: {
                preload: require.resolve('../main-window/preload'),
                experimentalFeatures: true, // backdrop-filter
                scrollBounce: true,
            },
        });

        this.window.base_url = this.url;
        this.window.connected = this.client.connected;

        this.window.loadFile(require.resolve('@hap-server/hap-server/public/index.html'));

        this.window.once('ready-to-show', () => {
            this.window.show();

            if (process.platform === 'darwin') electron.app.dock.show();
        });

        // Emitted when the window is closed
        this.window.on('closed', () => {
            // Dereference the window object, usually you would store windows
            // in an array if your app supports multi windows, this is the time
            // when you should delete the corresponding element
            this.window = null;

            if (process.platform === 'darwin' && !BrowserWindow.getAllWindows().length) electron.app.dock.hide();
        });
    }

    static async ready() {
        require('./menu');

        this.tray = new Tray(electron.nativeImage.createEmpty());
        this.tray.setTitle('Home');

        this.menu = Menu.buildFromTemplate([
            {label: 'Show', click: () => app.showWindow()},
            {label: 'Connect', click: () => app.client.connect(), enabled: true},
            {label: 'Disconnect', click: () => app.client.connection.ws.close(), enabled: false},
            {type: 'separator'},
            {label: 'Preferences', click: () => this.showPreferences()},
        ]);

        this.tray.setContextMenu(this.menu);
        if (process.platform === 'darwin') electron.app.dock.setMenu(this.menu);

        session.defaultSession.webRequest.onBeforeSendHeaders(this.onBeforeSendHeaders.bind(this));

        this.storage = persist.create({
            dir: persist_path,
            stringify: data => JSON.stringify(data, null, 4),
        });
        await this.storage.init();

        const url = await this.storage.getItem('URL');
        if (url) app.url = url;

        await app.client.tryConnect();

        const token = await this.storage.getItem('Token');

        if (token) {
            try {
                await app.authenticateWithToken(token);
            } catch (err) {
                log.error('Error authenticating', err);
            }
        }

        log.info('Ready');
        app.ready = true;

        // If we're not authenticated open the main window so the user can authenticate
        if (!app.client.connection.authenticated_user) app.showWindow();
    }

    static showPreferences() {
        if (this.preferences_window) {
            this.preferences_window.focus();
            return;
        }

        this.preferences_window = new BrowserWindow({
            width: 500,
            height: 200,
            resizable: false,
            title: 'Preferences',
            show: false,
            // parent: window,
            // modal: true,
            vibrancy: 'menu',
            webPreferences: {
                preload: require.resolve('../preferences-window'),
            },
        });

        this.preferences_window.loadURL('about:blank');

        this.preferences_window.once('ready-to-show', () => {
            this.preferences_window.show();

            if (process.platform === 'darwin') electron.app.dock.show();
        });

        // Emitted when the window is closed
        this.preferences_window.on('closed', () => {
            // Dereference the window object, usually you would store windows
            // in an array if your app supports multi windows, this is the time
            // when you should delete the corresponding element
            this.preferences_window = null;

            if (process.platform === 'darwin' && !BrowserWindow.getAllWindows().length) electron.app.dock.hide();
        });
    }

    static onBeforeSendHeaders(details, callback) {
        if (!app.client.connection || !app.client.connection.authenticated_user) return callback({requestHeaders: details.requestHeaders});

        const requestHeaders = Object.assign({}, details.requestHeaders, {
            'Cookie': 'asset_token=' + app.client.connection.authenticated_user.asset_token,
        });

        callback({requestHeaders});
    }
}

if (process.platform === 'darwin') electron.app.dock.hide();

export const app = new App();
const client = app.client;

electron.app.on('ready', App.ready.bind(App));

electron.app.on('window-all-closed', () => {
    // Don't quit as we want to stay connected to the server to show notifications
});

electron.app.on('activate', app.showWindow.bind(app));

export function showPreferences() {
    App.showPreferences();
}

ipcMain.on('get-preferences-url', event => {
    event.sender.send('preferences-url', app.url);
});

ipcMain.on('set-preferences', async (event, data) => {
    if (data.url !== app.url) {
        app.url = data.url;

        await App.storage.setItem('URL', data.url);
    }
});

if (process.platform === 'darwin') {
    electron.systemPreferences.subscribeNotification('AppleInterfaceThemeChangedNotification', () => {
        electron.systemPreferences.setAppLevelAppearance(electron.systemPreferences.isDarkMode() ? 'dark' : 'light');
    });
    electron.systemPreferences.setAppLevelAppearance(electron.systemPreferences.isDarkMode() ? 'dark' : 'light');
}
