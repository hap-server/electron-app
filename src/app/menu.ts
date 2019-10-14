import {app, shell, Menu} from 'electron';
import {App} from '.';

const isMac = process.platform === 'darwin';

const template = [
    ...(process.platform === 'darwin' ? [{
        label: app.getName(),
        submenu: [
            {role: 'about'},
            {label: 'Preferences', click: () => App.showPreferences(), accelerator: 'CommandOrControl+,'},
            {type: 'separator'},
            {role: 'services'},
            {type: 'separator'},
            {role: 'hide'},
            {role: 'hideothers'},
            {role: 'unhide'},
            {type: 'separator'},
            {role: 'quit'},
        ],
    }] : []),
    {
        label: 'File',
        submenu: [
            isMac ? {role: 'close'} : {role: 'quit'},
            ...(isMac ? [] : [{label: 'Preferences', click: () => App.showPreferences(), accelerator: 'CommandOrControl+,'}]),
        ],
    },
    {role: 'editMenu'},
    {role: 'viewMenu'},
    {role: 'windowMenu'},
    {
        role: 'help',
        submenu: [
            {
                label: 'hap-server',
                click() {
                    shell.openExternal('https://gitlab.fancy.org.uk/hap-server/hap-server');
                },
            },
            {
                label: 'hap-server-electron',
                click() {
                    shell.openExternal('https://gitlab.fancy.org.uk/hap-server/electron-app');
                },
            },
        ],
    },
] as Electron.MenuItemConstructorOptions[];

const menu = Menu.buildFromTemplate(template);
Menu.setApplicationMenu(menu);
