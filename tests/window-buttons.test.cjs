const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../electron/main.cjs'),'utf8');
function setup(platform){
  const handlers=new Map(),windowButtons=new WeakMap(),win={isDestroyed:()=>false},calls=[];
  if(platform==='darwin')win.setWindowButtonVisibility=value=>calls.push(value);
  else win.setTitleBarOverlay=value=>calls.push({...value});
  const context=vm.createContext({process:{platform},windowButtons,BrowserWindow:{fromWebContents:()=>win},ipcMain:{handle:(name,handler)=>handlers.set(name,handler)}});
  vm.runInContext(source.slice(source.indexOf('  const paintWindowButtons='),source.indexOf("\n",source.indexOf("ipcMain.handle('window:buttons'"))),context);
  return {calls,send:(name,value)=>handlers.get(`window:${name}`)({sender:{}},value)};
}
test('macOS theme IPC works without setTitleBarOverlay and restores traffic lights after hidden controls (#15)',()=>{
  const h=setup('darwin');h.send('theme',true);h.send('buttons','hidden');h.send('theme',false);h.send('buttons','player');h.send('buttons','page');
  assert.deepEqual(h.calls,[true,false,false,true,true]);
});
for(const platform of ['win32','linux'])test(`${platform} keeps overlay colors and remembered page theme`,()=>{
  const h=setup(platform);h.send('theme',true);h.send('buttons','player');h.send('buttons','hidden');h.send('buttons','invalid');
  assert.deepEqual(h.calls.map(x=>[x.color,x.symbolColor,x.height]),[['#ffffff','#1c1b1f',42],['#00000000','#ffffff',42],['#00000000','#00000000',42],['#ffffff','#1c1b1f',42]]);
});
