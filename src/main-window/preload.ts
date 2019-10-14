import electron from 'electron';
import url from 'url';
import querystring from 'querystring';

document.addEventListener('DOMContentLoaded', () => {
    document.documentElement.classList.add(electron.remote.systemPreferences.isDarkMode() ?
        'theme-dark' : 'theme-light');
});

electron.remote.systemPreferences.subscribeNotification('AppleInterfaceThemeChangedNotification', () => {
    const dark = electron.remote.systemPreferences.isDarkMode();
    document.documentElement.classList.remove(dark ? 'theme-light' : 'theme-dark');
    document.documentElement.classList.add(dark ? 'theme-dark' : 'theme-light');
});

// @ts-ignore
global.__HAP_SERVER_NATIVE_HOOK__ = ({Client, Connection, Vue, MainComponent, Modals}) => {
    class IPCConnection extends Connection {
        constructor(ipc) {
            super({});
            delete this.ws;

            this.ipc = ipc;

            this.ipc.on('url', (event, data) => {
                native_hook.base_url = data;
            });

            this.ipc.on('d', (event, data) => {
                console.log('Received', data);
                this.handleData(data);
            });

            this.ipc.on('r', (event, {messageid, response}) => {
                console.log('Received', messageid, response);

                if (!this.callbacks.has(messageid)) {
                    console.error('Unknown messageid');
                    return;
                }

                const callback = this.callbacks.get(messageid);

                callback.call(this, response);
            });

            this.ipc.on('b', (event, data) => {
                console.log('Received broadcast', data);
                this.emit('received-broadcast', data);
                this.handleBroadcastMessage(data);
            });
        }

        send(data) {
            return new Promise((resolve, reject) => {
                const messageid = this.messageid++;

                console.log('Sending', messageid, data);
                this.ipc.send('s', {messageid, data});

                this.callbacks.set(messageid, resolve);
            });
        }
    }

    const connection = new IPCConnection(electron.ipcRenderer);
    let client = null;

    class NativeClient extends Client {
        constructor() {
            if (client) return client;

            super();

            client = this;

            this.accessories = {};
            this.layouts = {};

            connection.ipc.on('up', event => {
                console.log('Connected');
                this.connection = connection;
                connection.on('received-broadcast', this._handleBroadcastMessage);
                connection.on('disconnected', this._handleDisconnected);
                this.emit('connected', connection);
                this.connected = true;
            });
            connection.ipc.on('down', event => {
                this.handleDisconnected();
            });

            setTimeout(() => {
                if (this.connection) return;

                // @ts-ignore
                if (electron.remote.getCurrentWindow().connected) {
                    this.connection = connection;
                    connection.on('received-broadcast', this._handleBroadcastMessage);
                    connection.on('disconnected', this._handleDisconnected);
                    this.emit('connected', connection);
                    this.connected = true;
                }
            }, 0);
        }

        async connect() {
            return this.connection;
        }

        disconnect() {
            throw new Error('Cannot close IPC connection');
        }
    }

    const modal_windows = new WeakMap();

    const external_types = [
        // 'authenticate',
        'settings',
        'add-accessory',
        'layout-settings',
        'new-layout',
        'delete-layout',
        'accessory-settings',
        'new-bridge',
        'delete-bridge',
        'pairing-settings',
        'service-settings',
        // 'accessory-details',
        'scene-settings',
        'new-scene',
        // 'setup',
    ];

    class NativeModals extends Modals {
        _add(modal) {
            if (modal_windows.has(modal)) {
                modal_windows.get(modal).focus();
                return;
            }

            if (!external_types.includes(modal.type)) return;

            const qs = Object.assign({
                type: modal.type,
            }, this.constructor.getQueryStringForModal(modal));

            // const modal_window = window.open('modal.html?' + querystring.stringify(qs), '_blank', Object.entries(features)
                // .map(([k, v]) => `${k}=${v === true ? 'yes' : v === false ? 'no' : v}`).join(','));
            const modal_window = new electron.remote.BrowserWindow({
                width: ['settings'].includes(modal.type) ? 750 :
                    ['accessory-settings'].includes(modal.type) ? 626 : 500,
                minHeight: 400,
                show: false,
                parent: electron.remote.getCurrentWindow(),
                modal: true,
                backgroundColor: electron.remote.systemPreferences.isDarkMode() ? '#1d2124' : '#f8f9fa',
                webPreferences: {
                    preload: __filename,
                    experimentalFeatures: true, // backdrop-filter
                    scrollBounce: true,
                },
            });

            console.log('Modal stack', modal, this, this.stack);

            const top_modal_window = this.top_modal_window;
            if (top_modal_window) {
                top_modal_window.hide();
            }

            modal_window.setMenuBarVisibility(false);
            modal_window.setAutoHideMenuBar(true);

            // modal_window.base_url = native_hook.base_url;
            // modal_window.connected = client.connected;

            const _url = url.resolve(location.href, 'modal.html?' + querystring.stringify(qs));
            console.log('Modal URL', modal_window, _url);
            modal_window.loadURL(_url);

            const onclose = () => {
                modal_window.removeListener('close', onclose);
                let index;
                while ((index = this.stack.indexOf(modal)) > -1) {
                    this.stack.splice(index, 1);
                }
                modal_windows.delete(modal);
            };
            modal_window.on('close', onclose);

            const onclosed = () => {
                modal_window.removeListener('closed', onclosed);
                let index;
                while ((index = this.stack.indexOf(modal)) > -1) {
                    this.stack.splice(index, 1);
                }
                modal_windows.delete(modal);
                // const top_modal_window = this.top_modal_window;
                if (top_modal_window) top_modal_window.show();
            };
            modal_window.on('closed', onclosed);

            modal_windows.set(modal, modal_window);
        }

        get top_modal_window() {
            let top_modal_window = null;

            for (const modal of this.stack) {
                if (modal_windows.has(modal)) top_modal_window = modal_windows.get(modal);
            }

            return top_modal_window;
        }

        _remove(modal) {
            if (!modal_windows.has(modal)) return;

            const modal_window = modal_windows.get(modal);
            modal_window.close();

            modal_windows.delete(modal);
        }

        static getQueryStringForModal(modal) {
            if (modal.type === 'layout-settings' || modal.type === 'delete-layout') {
                return {layout: modal.layout.uuid};
            }

            if (modal.type === 'accessory-settings' || modal.type === 'delete-bridge') {
                return {accessory: modal.accessory.uuid};
            }

            if (modal.type === 'pairing-settings') {
                console.log('Pairing modal pairing', modal.pairing, modal.pairing.id, modal.accessory.uuid);
                return {accessory: modal.accessory.uuid, pairing: modal.pairing.id};
            }

            if (modal.type === 'service-settings') {
                return {accessory: modal.service.accessory.uuid, service: modal.service.uuid};
            }

            if (modal.type === 'scene-settings') {
                return {scene: modal.scene.uuid};
            }
        }

        getDisplayModals() {
            return this.stack.filter(m => !external_types.includes(m.type));
            // return this.stack;
        }
    }

    interface NativeModals {
        constructor: typeof NativeModals;
    }

    electron.ipcRenderer.on('hap-server-message', (_event, message) => {
        const event = document.createEvent('Event') as MessageEvent;
        event.initEvent('message', false, false);

        // @ts-ignore
        event.data = message;
        // @ts-ignore
        event.origin = location.origin;
        // @ts-ignore
        event.source = null;

        window.dispatchEvent(event);
    });

    class ChildWindowNativeModals extends Modals {
        get stack() {
            throw new Error('Cannot read modal stack from child windows');
        }

        set stack(stack) {}

        add(modal) {
            console.log('Modal', modal);

            const webContentsId = typeof this.constructor.webContentsId === 'number' ? this.constructor.webContentsId :
                this.constructor.webContentsId = electron.remote.getCurrentWindow().getParentWindow().webContents.id;

            electron.ipcRenderer.sendTo(webContentsId, 'hap-server-message', {
                type: 'modal',
                modal: Object.assign({
                    type: modal.type,
                }, NativeModals.getQueryStringForModal(modal)),
            });
        }

        remove() {
            throw new Error('Cannot close modals from child windows');
        }

        __modal_loaded() {
            console.log('Modal loaded');

            electron.remote.getCurrentWindow().show();

            this.__modal_loaded = null;
        }
    }

    interface ChildWindowNativeModals {
        constructor: typeof ChildWindowNativeModals;
    }

    const is_child_window = location.pathname.match(/\/modal\.html$/);

    const native_hook = {
        Client: NativeClient,
        Modals: is_child_window ? ChildWindowNativeModals : NativeModals,
        // @ts-ignore
        base_url: electron.remote.getCurrentWindow().base_url,
        electron,
    };
    return native_hook;
};
