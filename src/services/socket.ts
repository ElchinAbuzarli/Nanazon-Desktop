import { io, Socket } from "socket.io-client";
import { invoke } from "@tauri-apps/api/core";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "https://new-api.nanazon.com";
const KEEPALIVE_INTERVAL_MS = 30000;
const STALE_HANDSHAKE_MS = 180000;
const STALE_FORCE_RECONNECT_MS = 240000;

let socket: Socket | null = null;
let token: string | null = null;
let userId: string | null = null;
let userName: string | null = null;
let userRole: string | null = null;

let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let lastIncomingAt = Date.now();
let lastReadySentAt = 0;
let lastForcedReconnectAt = 0;

const registeredListeners = new Map<string, (...args: any[]) => void>();

function markIncomingActivity() {
  lastIncomingAt = Date.now();
}

function startKeepAliveLoop() {
  stopKeepAliveLoop();
  keepAliveTimer = setInterval(() => {
    if (!socket) return;

    if (!socket.connected) {
      console.warn("[socket] keepalive: disconnected, trying reconnect");
      try { socket.connect(); } catch (e) { /* ignore */ }
      return;
    }

    emitSecure("clientHeartbeat", { ts: Date.now() });

    const idleMs = Date.now() - lastIncomingAt;

    if (idleMs > STALE_FORCE_RECONNECT_MS && Date.now() - lastForcedReconnectAt > KEEPALIVE_INTERVAL_MS) {
      lastForcedReconnectAt = Date.now();
      console.warn(`[socket] keepalive: forcing reconnect after ${Math.round(idleMs / 1000)}s idle`);
      try { socket.disconnect(); socket.connect(); } catch (e) { /* ignore */ }
      return;
    }

    if (idleMs > STALE_HANDSHAKE_MS && Date.now() - lastReadySentAt > KEEPALIVE_INTERVAL_MS) {
      console.warn(`[socket] keepalive: resending readyToReceiveStatus`);
      emitSecure("readyToReceiveStatus");
      lastReadySentAt = Date.now();
    }
  }, KEEPALIVE_INTERVAL_MS);
}

function stopKeepAliveLoop() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function buildSocket(auth?: { email: string; password: string }): Socket {
  return io(SOCKET_URL, {
    autoConnect: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    timeout: 25000,
    transports: ["polling"],
    auth: (cb) => {
      if (token) return cb({ token });
      if (auth?.email && auth?.password) return cb({ email: auth.email, password: auth.password });
      return cb({});
    },
  });
}

function setupGlobalListeners() {
  if (!socket) return;
  if ((socket as any).__nanazonGlobalAttached) return;
  (socket as any).__nanazonGlobalAttached = true;

  socket.on("connect", () => {
    markIncomingActivity();
    console.log("[socket] Connected. ID:", socket?.id);
  });

  socket.on("disconnect", (reason) => {
    markIncomingActivity();
    console.log("[socket] Disconnected:", reason);
    if (reason === "io server disconnect") {
      socket?.connect();
    }
  });

  socket.onAny(() => {
    markIncomingActivity();
  });

  if (socket.io) {
    socket.io.on("reconnect_attempt", (attempt) => {
      console.log(`[socket] Reconnect attempt: ${attempt}`);
    });
    socket.io.on("reconnect", () => {
      markIncomingActivity();
    });
  }
}

export function connectSocket(email: string, password: string): Promise<{ token: string; userId: string }> {
  return new Promise((resolve, reject) => {
    if (socket) {
      stopKeepAliveLoop();
      removeAllListeners();
      socket.disconnect();
      socket = null;
    }

    token = null;
    userId = null;
    lastIncomingAt = Date.now();
    lastReadySentAt = 0;
    socket = buildSocket({ email, password });
    socket.connect();
    setupGlobalListeners();

    let settled = false;

    const loginTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject("Login timeout - server did not respond.");
      socket?.disconnect();
    }, 5000);

    socket.on("connect_error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(loginTimeout);
      reject("Connection Error: " + err.message);
      socket?.disconnect();
      socket = null;
    });

    socket.on("loginSuccess", (data: { token: string; userId: string; name?: string; role?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(loginTimeout);
      token = data.token;
      userId = data.userId;
      userName = data.name || null;
      userRole = data.role || null;
      startKeepAliveLoop();
      markIncomingActivity();
      resolve({ token: data.token, userId: data.userId, name: data.name, role: data.role } as any);
    });

    socket.on("loginError", () => {
      if (settled) return;
      settled = true;
      clearTimeout(loginTimeout);
      reject("Incorrect Login!");
      socket?.disconnect();
      socket = null;
    });
  });
}

export function connectSocketWithToken(receivedToken: string, receivedUserId: string): Promise<{ token: string; userId: string }> {
  return new Promise((resolve, reject) => {
    if (socket) {
      stopKeepAliveLoop();
      removeAllListeners();
      socket.disconnect();
      socket = null;
    }

    token = receivedToken;
    userId = receivedUserId;
    lastIncomingAt = Date.now();
    lastReadySentAt = 0;
    socket = buildSocket();
    socket.connect();
    setupGlobalListeners();

    let settled = false;

    socket.on("connect", () => {
      if (settled) return;
      settled = true;
      startKeepAliveLoop();
      markIncomingActivity();
      resolve({ token: receivedToken, userId: receivedUserId });
    });

    socket.on("connect_error", (err) => {
      if (settled) return;
      settled = true;
      token = null;
      userId = null;
      reject("Connection failed: " + err.message);
    });
  });
}

export function emitSecure(event: string, data: Record<string, any> = {}) {
  if (!socket || !token) return;
  socket.emit(event, { ...data, token, userId });
}

export function listen(event: string, callback: (...args: any[]) => void) {
  if (!socket) return;
  if (registeredListeners.has(event)) {
    socket.off(event, registeredListeners.get(event)!);
  }
  const handler = (...args: any[]) => callback(...args);
  socket.on(event, handler);
  registeredListeners.set(event, handler);
}

export function removeListener(event: string) {
  if (!socket) return;
  if (registeredListeners.has(event)) {
    socket.off(event, registeredListeners.get(event)!);
    registeredListeners.delete(event);
  }
}

export function removeAllListeners() {
  if (!socket) return;
  registeredListeners.forEach((handler, event) => {
    socket!.off(event, handler);
  });
  registeredListeners.clear();
}

export function disconnectSocket() {
  if (socket) {
    stopKeepAliveLoop();
    removeAllListeners();
    socket.disconnect();
    socket = null;
    token = null;
    userId = null;
    userName = null;
    userRole = null;
  }
}

export function getToken() { return token; }
export function getUserId() { return userId; }
export function getUserName() { return userName; }
export function getUserRole() { return userRole; }
export function getSocket() { return socket; }

export async function sendHandshake(reason: string) {
  if (!socket || !token || !userId) return;
  emitSecure("readyToReceiveStatus", { token });
  try {
    const deviceInfo = await invoke("get_device_info");
    emitSecure("deviceControl", { token, device: deviceInfo, userId });
    console.log(`[socket] Handshake sent (${reason})`);
  } catch (e) {
    console.warn("[socket] Handshake failed:", e);
  }
}
