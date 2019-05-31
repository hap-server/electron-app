import electron from 'electron';
import url from 'url';

const base_url = 'http://127.0.0.1:8082';

global.__HAP_SERVER_NATIVE_HOOK__ = ({Client, Connection, Vue, MainComponent}) => {
    const base = document.createElement('base');
    base.setAttribute('href', base_url);
    document.head.appendChild(base);

    // Patch document.head.appendChild to resolve chunk links properly
    const appendChild = document.head.appendChild;
    document.head.appendChild = function(script) {
        if (script.tagName === 'SCRIPT') {
            const base = 'file://' + require.resolve('@hap-server/hap-server/public/index.html');
            const src = script.src = url.resolve(base, script.getAttribute('src'));
            console.log('src', src);
        }

        if (script.tagName === 'LINK') {
            const base = 'file://' + require.resolve('@hap-server/hap-server/public/index.html');
            const src = script.href = url.resolve(base, script.getAttribute('href'));
            console.log('src', src);
        }

        return appendChild.apply(this, arguments);
    };

    class IPCConnection extends Connection {
        constructor(ipc) {
            super({});
            delete this.ws;

            this.ipc = ipc;

            this.ipc.on('url', (event, data) => {
                base.setAttribute('href', base_url);
            });

            this.ipc.on('up', event => {
                this.connected = true;
            });
            this.ipc.on('down', event => {
                this.connected = false;
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

    return class NativeClient extends Client {
        constructor() {
            super();

            this.accessories = {};
            this.layouts = {};
        }

        async connect() {
            this.connection = connection;
            this.connected = true;

            connection.on('received-broadcast', this._handleBroadcastMessage);

            this.emit('connected', connection);

            return connection;
        }

        disconnect() {
            throw new Error('Cannot close IPC connection');
        }
    };
};
