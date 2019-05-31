import electron from 'electron';
import url from 'url';

global.__HAP_SERVER_NATIVE_HOOK__ = ({Client, Connection, Vue, MainComponent}) => {
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

    class NativeClient extends Client {
        constructor() {
            super();

            this.accessories = {};
            this.layouts = {};

            connection.ipc.on('up', event => {
                console.log('Connected');
                this.connection = connection;
                this.emit('connected', connection);
                this.connected = true;
            });
            connection.ipc.on('down', event => {
                this.handleDisconnected();

                global.$root.$children[0].connection = null;
            });

            setTimeout(() => {
                if (this.connection) return;

                if (electron.remote.getCurrentWindow().connected) {
                    this.connection = connection;
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

    const native_hook = {Client: NativeClient, base_url: electron.remote.getCurrentWindow().base_url};
    return native_hook;
};
