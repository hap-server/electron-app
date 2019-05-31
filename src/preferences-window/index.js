import {ipcRenderer, remote} from 'electron';

(async () => {
    const dark = remote.systemPreferences.isDarkMode();

    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.height = 'calc(100vh - 4rem)';
    container.style.padding = '2rem';
    container.style.fontFamily = '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial,' +
        ' Noto Sans, sans-serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol, Noto Color Emoji';
    container.style.color = dark ? '#ffffff' : '#333333';
    container.style.userSelect = 'none';

    const label = document.createElement('label');
    label.setAttribute('for', 'url');
    label.textContent = 'URL';
    label.style.marginBottom = '0.4rem';
    container.appendChild(label);

    const input = document.createElement('input');
    input.id = 'url';
    input.type = 'text';
    input.value = await new Promise(rs => (ipcRenderer.send('get-preferences-url'),
        ipcRenderer.once('preferences-url', (event, url) => rs(url))));
    input.style.marginBottom = '1rem';
    input.style.outlineWidth = '4px';
    input.style.backgroundColor = dark ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.1)';
    input.style.borderColor = dark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    input.style.borderWidth = '1px';
    input.style.color = dark ? '#ffffff' : '#333333';
    input.style.padding = '0.1rem 0.2rem';
    input.style.fontSize = '13px';
    container.appendChild(input);

    const authenticated_user = await new Promise(rs => (ipcRenderer.send('get-authenticated-user'),
        ipcRenderer.once('authenticated-user', (event, authenticated_user) => rs(authenticated_user))));
    let authenticated_as;
    if (authenticated_user) {
        authenticated_as = document.createElement('p');
        authenticated_as.textContent = 'Authenticated as ' + authenticated_user.data.name || authenticated_user.id;
        authenticated_as.style.marginTop = '0';
        authenticated_as.style.userSelect = 'text';
    } else {
        authenticated_as = document.createComment('authenticated_as');
    }
    container.appendChild(authenticated_as);

    ipcRenderer.on('authenticated-user', (event, authenticated_user) => {
        let new_authenticated_as;
        if (authenticated_user) {
            new_authenticated_as = document.createElement('p');
            new_authenticated_as.textContent = 'Authenticated as ' + authenticated_user.data.name || authenticated_user.id;
            new_authenticated_as.style.marginTop = '0';
            new_authenticated_as.style.userSelect = 'text';
        } else {
            new_authenticated_as = document.createComment('authenticated_as');
        }
        authenticated_as.replaceWith(new_authenticated_as);
        authenticated_as = new_authenticated_as;
    });

    const fill = document.createElement('div');
    fill.style.flexGrow = '1';
    container.appendChild(fill);

    const row = document.createElement('div');
    row.style.display = 'flex';

    const rowfill = document.createElement('div');
    rowfill.style.flexGrow = '1';
    row.appendChild(rowfill);

    const button = document.createElement('button');
    button.textContent = 'Save';
    button.addEventListener('click', event => {
        ipcRenderer.send('set-preferences', {url: input.value});
        window.close();
    });
    row.appendChild(button);

    container.appendChild(row);

    document.body.style.margin = '0';
    document.body.appendChild(container);

    remote.systemPreferences.subscribeNotification('AppleInterfaceThemeChangedNotification', () => {
        const dark = remote.systemPreferences.isDarkMode();
        container.style.color = dark ? '#ffffff' : '#333333';
        input.style.backgroundColor = dark ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.1)';
        input.style.borderColor = dark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
        input.style.color = dark ? '#ffffff' : '#333333';
    });
})();
