// Where this app's traffic goes (설정 > 연결, see wireguard-proxy.cjs): direct, or through a local HTTP proxy (wireproxy's).
// route(proxy) points every Chromium session (the window, the hidden player pages, each partition as it is made),
// Node's fetch and the child processes started afterwards (ffmpeg, uv: by HTTP_PROXY / http_proxy) at it; this
// computer's and the local network's addresses always go direct. directFetch never goes through it (wireproxy's own
// download, device sync).

const { Agent, ProxyAgent, Dispatcher, setGlobalDispatcher } = require('undici');
const { isDirectHost, CHROMIUM_BYPASS, NO_PROXY } = require('./wireguard-proxy.cjs');

const PROXY_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];

function createAppRouting({ app, env = process.env } = {}) {
  const directAgent = new Agent();
  const directFetch = (url, options = {}) => fetch(url, { ...options, dispatcher: directAgent });
  class RoutingDispatcher extends Dispatcher {
    constructor(proxy) { super(); this.proxy = proxy; }
    dispatch(options, handler) { let host = ''; try { host = new URL(options.origin).hostname; } catch { /* no origin */ } return (isDirectHost(host) ? directAgent : this.proxy).dispatch(options, handler); }
    close(...args) { return this.proxy.close(...args); }
    destroy(...args) { return this.proxy.destroy(...args); }
  }
  const sessions = new Set(), originalEnv = Object.fromEntries(PROXY_ENV.map(key => [key, env[key]]));
  let current = null;
  function routeSession(ses) {
    if (typeof ses?.setProxy !== 'function') return Promise.resolve();
    sessions.add(ses);
    return Promise.resolve().then(() => ses.setProxy(current ? { proxyRules: current.replace(/^http:\/\//, ''), proxyBypassRules: CHROMIUM_BYPASS } : { mode: 'direct' }))
      .then(() => ses.closeAllConnections?.()).catch(() => {});
  }
  // proxy: "http://127.0.0.1:<port>", or null for direct. Resolves once the sessions known have it.
  function route(proxy) {
    if (proxy === current) return Promise.resolve();
    const was = current; current = proxy;
    if (proxy || was) setGlobalDispatcher(proxy ? new RoutingDispatcher(new ProxyAgent(proxy)) : new Agent());
    for (const key of PROXY_ENV) {
      const value = proxy ? (/no_proxy/i.test(key) ? NO_PROXY : proxy) : originalEnv[key];
      if (value === undefined) delete env[key]; else env[key] = value;
    }
    return Promise.all([...sessions].map(routeSession));
  }
  app?.on?.('session-created', ses => { routeSession(ses); });
  return { route, routeSession, directFetch, directAgent, current: () => current };
}

module.exports = { createAppRouting, PROXY_ENV };
