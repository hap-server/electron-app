import {
    Tray, Menu, BrowserWindow, Notification, ipcMain, session, nativeImage, systemPreferences, app as electron_app,
} from 'electron';
import path from 'path';
import fs from 'fs';
import url from 'url';
import persist from 'node-persist';

import {Logger, Client, AuthenticatedUser, Characteristic, path as hap_server_path} from '@hap-server/hap-server/client';
import WebSocket from 'ws';
import windowStateKeeper from 'electron-window-state';

const log = new Logger();

log.info('Starting');

// const persist_path = path.join(electron.app.getPath('appData'), 'hap-server', 'persist');
const persist_path = path.resolve(__dirname, '..', '..', 'data');
const server_url = 'http://127.0.0.1:8082';

class App {
    static tray: Tray;
    static menu: Menu;
    static storage: typeof persist;
    static preferences_window?: BrowserWindow;

    readonly client: Client;
    private _url: string;
    window?: BrowserWindow;

    ready = false;

    constructor() {
        this.client = new Client(server_url, WebSocket);
        this.client.loadAccessories(this);

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
        // @ts-ignore
        if (this.window) this.window.send('url', base_url);

        const parsed = url.parse(base_url);

        this.websocket_url = parsed.protocol.replace('http', 'ws') + '//' + parsed.host + '/websocket';
    }

    get websocket_url() {
        return this.client.url;
    }
    set websocket_url(url) {
        // @ts-ignore
        this.client.url = url;
        if (this.client.connected) this.client.disconnect().then(() => this.client.tryConnect());
        // if (this.window) this.window.send('reset-has-connected');
    }

    async connected(connection) {
        log.info('Connected to %s', this.client.url, this.client);

        // @ts-ignore
        if (this.window) this.window.send('up');

        connection.on('received-broadcast', data => {
            // @ts-ignore
            if (this.window) this.window.send('b', data);
        });

        connection.on('update-characteristic', this.handleUpdateCharateristic.bind(this));

        this.constructor.menu.items[1].enabled = false;
        this.constructor.menu.items[2].enabled = true;

        this.constructor.tray.setContextMenu(this.constructor.menu);
        if (process.platform === 'darwin') electron_app.dock.setMenu(this.constructor.menu);

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
        log.warn('Disconnected from %s', this.client.url, event);

        // @ts-ignore
        if (this.window) this.window.send('down');
        // @ts-ignore
        if (this.constructor.preferences_window) this.constructor.preferences_window.send('authenticated-user', null);

        if (event !== 1005) this.client.tryConnect();

        this.constructor.menu.items[1].enabled = true;
        this.constructor.menu.items[2].enabled = false;

        this.constructor.tray.setContextMenu(this.constructor.menu);
        if (process.platform === 'darwin') electron_app.dock.setMenu(this.constructor.menu);
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
                // @ts-ignore
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

        // @ts-ignore
        this.client.connection.authenticated_user = authenticated_user;

        if (this.constructor.preferences_window) {
            // @ts-ignore
            this.constructor.preferences_window.send('authenticated-user', {
                id: authenticated_user.id,
                token: authenticated_user.token,
                asset_token: authenticated_user.asset_token,
                data: authenticated_user,
            });
        }

        this.client.connection.getHomeSettings().then(d => this.client.home_settings = d);
        this.client.refreshLoaded();

        return authenticated_user;
    }

    async sendFromRenderer(event: Electron.IpcMessageEvent, {messageid, data}) {
        if (this.client.connection) {
            if (data.type === 'list-accessories') {
                return event.sender.send('r', {
                    messageid,
                    response: Object.keys(this.client.accessories),
                });
            } else if (data.type === 'get-accessories') {
                return event.sender.send('r', {
                    messageid,
                    response: data.id.map(uuid => this.client.accessories[uuid].details),
                });
            } else if (data.type === 'get-accessories-data') {
                return event.sender.send('r', {
                    messageid,
                    response: data.id.map(uuid => this.client.accessories[uuid].data),
                });
            } else if (data.type === 'get-home-settings') {
                return event.sender.send('r', {
                    messageid,
                    response: this.client.home_settings,
                });
            } else if (data.type === 'subscribe-characteristics') {
                console.log(data);

                try {
                    return event.sender.send('r', {
                        messageid,
                        response: await Promise.all(data.ids.map(([accessory_uuid, service_id, characteristic_uuid]) => {
                            const accessory = this.client.accessories[accessory_uuid];
                            const service = accessory.services[service_id];
                            const characteristic = service.characteristics[characteristic_uuid];
    
                            return characteristic.subscribe(event.sender);
                        })),
                    });
                } catch (err) {
                    return event.sender.send('r', {
                        messageid,
                    });
                }
            } else if (data.type === 'unsubscribe-characteristics') {
                console.log(data);

                try {
                    return event.sender.send('r', {
                        messageid,
                        response: await Promise.all(data.ids.map(([accessory_uuid, service_id, characteristic_uuid]) => {
                            const accessory = this.client.accessories[accessory_uuid];
                            const service = accessory.services[service_id];
                            const characteristic = service.characteristics[characteristic_uuid];
    
                            return characteristic.unsubscribe(event.sender);
                        })),
                    });
                } catch (err) {
                    return event.sender.send('r', {
                        messageid,
                    });
                }
            }

            const response = await this.client.connection.send(data);
            event.sender.send('r', {messageid, response});

            if (data.type === 'authenticate' && response.success) {
                const authenticated_user = new AuthenticatedUser(response.authentication_handler_id, response.user_id);

                Object.defineProperty(authenticated_user, 'token', {value: response.token || data.token});
                Object.defineProperty(authenticated_user, 'asset_token', {value: response.asset_token});
                Object.assign(authenticated_user, response.data);

                log.info('AuthenticatedUser', authenticated_user);
                // @ts-ignore
                this.client.connection.authenticated_user = authenticated_user;

                if (this.constructor.preferences_window) {
                    // @ts-ignore
                    this.constructor.preferences_window.send('authenticated-user', {
                        id: authenticated_user.id,
                        token: authenticated_user.token,
                        asset_token: authenticated_user.asset_token,
                        data: authenticated_user,
                    });
                }

                await this.constructor.storage.setItem('Token', authenticated_user.token);

                this.client.connection.getHomeSettings().then(d => this.client.home_settings = d);
                this.client.refreshLoaded();
            } else if (data.type === 'set-accessories-data') {
                for (const [uuid, accessory_data] of data.id_data) {
                    this.client.handleBroadcastMessage({
                        type: 'update-accessory-data',
                        uuid, data: accessory_data,
                    });
                }
            } else if (data.type === 'set-home-settings') {
                this.client.handleBroadcastMessage({
                    type: 'update-home-settings',
                    data: data.data,
                });
            }
        } else {
            event.sender.send('r', {messageid, response: null});
        }
    }

    showWindow() {
        if (this.window) {
            this.window.show();
            this.window.focus();
            return;
        }

        const window_state = windowStateKeeper({
            path: path.join(persist_path, 'window-state'),
            file: 'main.json',
        });

        this.window = new BrowserWindow({
            width: 1000,
            height: 650,
            show: false,
            backgroundColor: '#495057',
            titleBarStyle: 'hiddenInset',
            webPreferences: {
                preload: require.resolve('../main-window/preload'),
                experimentalFeatures: true, // backdrop-filter
                scrollBounce: true,
            },
        });

        this.window.setMenuBarVisibility(false);
        this.window.setAutoHideMenuBar(true);

        // @ts-ignore
        this.window.base_url = this.url;
        // @ts-ignore
        this.window.connected = this.client.connected;

        window_state.manage(this.window);

        this.window.loadFile(path.join(hap_server_path, 'public', 'app.html'));

        this.window.once('ready-to-show', () => {
            this.window.show();

            if (process.platform === 'darwin') electron_app.dock.show();
        });

        // Emitted when the window is closed
        this.window.on('closed', () => {
            // Dereference the window object, usually you would store windows
            // in an array if your app supports multi windows, this is the time
            // when you should delete the corresponding element
            this.window = null;
            window_state.unmanage();

            if (process.platform === 'darwin' && !BrowserWindow.getAllWindows().length) electron_app.dock.hide();
        });
    }

    static async ready(launch_info?) {
        log.info('Launch info', launch_info);

        require('./menu');

        const icon = nativeImage
            .createFromPath(path.resolve(__dirname, '..', '..', 'assets', 'home-icon.png'))
            .resize({height: 22});
        icon.setTemplateImage(true);

        this.tray = new Tray(icon);

        this.menu = Menu.buildFromTemplate([
            {label: 'Show', click: () => app.showWindow()},
            {label: 'Connect', click: () => app.client.connect(), enabled: true},
            {label: 'Disconnect', click: () => app.client.connection.ws.close(), enabled: false},
            {type: 'separator'},
            {label: 'Preferences', click: () => this.showPreferences()},
        ]);

        this.tray.setContextMenu(this.menu);
        if (process.platform === 'darwin') electron_app.dock.setMenu(this.menu);

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
        // @ts-ignore
        if (!app.client.connection.authenticated_user) app.showWindow();
    }

    static showPreferences() {
        if (this.preferences_window) {
            this.preferences_window.show();
            this.preferences_window.focus();
            return;
        }

        const window_state = windowStateKeeper({
            path: path.join(persist_path, 'window-state'),
            file: 'preferences.json',
        });

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

        window_state.manage(this.preferences_window);

        this.preferences_window.loadURL('about:blank');

        this.preferences_window.once('ready-to-show', () => {
            this.preferences_window.show();

            if (process.platform === 'darwin') electron_app.dock.show();
        });

        // Emitted when the window is closed
        this.preferences_window.on('closed', () => {
            // Dereference the window object, usually you would store windows
            // in an array if your app supports multi windows, this is the time
            // when you should delete the corresponding element
            this.preferences_window = null;
            window_state.unmanage();

            if (process.platform === 'darwin' && !BrowserWindow.getAllWindows().length) electron_app.dock.hide();
        });
    }

    static onBeforeSendHeaders(details, callback) {
        // @ts-ignore
        if (!app.client.connection || !app.client.connection.authenticated_user) {
            return callback({requestHeaders: details.requestHeaders});
        }

        const requestHeaders = Object.assign({}, details.requestHeaders, {
            // @ts-ignore
            'Cookie': 'asset_token=' + app.client.connection.authenticated_user.asset_token,
        });

        callback({requestHeaders});
    }

    static handleGetPreferencesUrl(event) {
        event.sender.send('preferences-url', app.url);
    }

    static handleGetAuthenticatedUser(event) {
        // @ts-ignore
        event.sender.send('authenticated-user', app.client.connection && app.client.connection.authenticated_user ? {
            // @ts-ignore
            id: app.client.connection.authenticated_user.id,
            // @ts-ignore
            token: app.client.connection.authenticated_user.token,
            // @ts-ignore
            asset_token: app.client.connection.authenticated_user.asset_token,
            // @ts-ignore
            data: app.client.connection.authenticated_user,
        } : null);
    }

    static async handleSetPreferences(event, data) {
        if (data.url !== app.url) {
            app.url = data.url;

            await App.storage.setItem('URL', data.url);
        }
    }
}

interface App {
    constructor: typeof App;
}

export {App};

electron_app.setAboutPanelOptions({
    applicationName: 'Home',
    applicationVersion: require('../../package').version,
    credits: 'https://gitlab.fancy.org.uk/hap-server/electron-app',
    website: 'https://gitlab.fancy.org.uk/hap-server/electron-app',
    // iconPath
});

export const app = new App();

electron_app.whenReady().then(() => App.ready());
electron_app.on('activate', app.showWindow.bind(app));

electron_app.on('browser-window-created', (event, window) => {
    // @ts-ignore
    window.base_url = app.url;
    // @ts-ignore
    window.connected = app.client.connected;
});

electron_app.on('web-contents-created', (event, webContents) => {
    webContents.on('destroyed', event => {
        // Remove this window's characteristic subscriptions
        Characteristic.unsubscribeAll(webContents);
    });
    webContents.on('crashed', event => {
        // Remove this window's characteristic subscriptions
        Characteristic.unsubscribeAll(webContents);
    });
    webContents.on('did-navigate', event => {
        // Remove this window's characteristic subscriptions
        Characteristic.unsubscribeAll(webContents);
    });
});

electron_app.on('window-all-closed', () => {
    // Don't quit as we want to stay connected to the server to show notifications
});

ipcMain.on('get-preferences-url', App.handleGetPreferencesUrl.bind(App));
ipcMain.on('get-authenticated-user', App.handleGetAuthenticatedUser.bind(App));
ipcMain.on('set-preferences', App.handleSetPreferences.bind(App));

if (process.platform === 'darwin') {
    electron_app.dock.hide();

    systemPreferences.subscribeNotification('AppleInterfaceThemeChangedNotification', () => {
        systemPreferences.setAppLevelAppearance(systemPreferences.isDarkMode() ? 'dark' : 'light');
    });
    systemPreferences.setAppLevelAppearance(systemPreferences.isDarkMode() ? 'dark' : 'light');
}

const interactive = !electron_app.isPackaged && process.argv.includes('--interactive');

if (interactive) {
    electron_app.on('quit', () => {
        require('repl').repl.close();
    });

    log.warn('Disabling logging for REPL');
    console.log = console.error = () => {};

    // @ts-ignore
    global.App = App;
    // @ts-ignore
    global.app = app;

    // @ts-ignore
    global.accessories = app.client.accessories;
}
