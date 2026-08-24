const { app, BrowserWindow, session, shell } = require('electron');
const APP_URL='https://d2-camera.onrender.com';

function createWindow(){
  const win=new BrowserWindow({
    width:1440,height:900,minWidth:980,minHeight:650,title:'Acord',
    autoHideMenuBar:true,backgroundColor:'#07110e',
    webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false}
  });

  win.webContents.setWindowOpenHandler(({url})=>{
    if(url.startsWith(APP_URL))return {action:'allow'};
    shell.openExternal(url);return {action:'deny'};
  });

  win.loadURL(APP_URL);
}

app.whenReady().then(()=>{
  session.defaultSession.setPermissionRequestHandler((webContents,permission,callback)=>{
    callback(['media','fullscreen','notifications','display-capture'].includes(permission));
  });
  createWindow();
  app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow()});
});

app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});
