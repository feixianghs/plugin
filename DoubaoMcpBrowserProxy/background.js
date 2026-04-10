const COOKIE_BACKUP_KEY = "doubaoCookieBackup";
const DOUBAO_COOKIE_URL = "https://www.doubao.com/";
const DOUBAO_DOMAINS = ["doubao.com", ".doubao.com", "www.doubao.com"];

function isDoubaoDomain(domain = "") {
  return DOUBAO_DOMAINS.some(
    (candidate) => domain === candidate || domain.endsWith(candidate)
  );
}

function buildCookieUrl(cookie) {
  const protocol = cookie.secure ? "https:" : "http:";
  return `${protocol}//${cookie.domain.replace(/^\./, "")}${cookie.path}`;
}

function sanitizeCookieForBackup(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate,
    storeId: cookie.storeId,
  };
}

async function backupDoubaoCookies() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "doubao.com" });
    const backup = cookies
      .filter((cookie) => isDoubaoDomain(cookie.domain))
      .map(sanitizeCookieForBackup);

    await chrome.storage.local.set({
      [COOKIE_BACKUP_KEY]: {
        cookies: backup,
        updatedAt: Date.now(),
      },
    });
    console.log(`[CookieBackup] Saved ${backup.length} Doubao cookies`);
  } catch (error) {
    console.error("[CookieBackup] Failed to save cookies:", error);
  }
}

async function restoreDoubaoCookies() {
  try {
    const result = await chrome.storage.local.get(COOKIE_BACKUP_KEY);
    const backup = result[COOKIE_BACKUP_KEY];
    if (!backup?.cookies?.length) {
      return;
    }

    for (const cookie of backup.cookies) {
      try {
        await chrome.cookies.set({
          url: buildCookieUrl(cookie),
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          expirationDate: cookie.expirationDate,
          storeId: cookie.storeId,
        });
      } catch (cookieError) {
        console.warn(`[CookieBackup] Failed to restore cookie ${cookie.name}:`, cookieError);
      }
    }
    console.log(`[CookieBackup] Restored ${backup.cookies.length} Doubao cookies`);
  } catch (error) {
    console.error("[CookieBackup] Failed to restore cookies:", error);
  }
}

async function clearDoubaoCookies() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "doubao.com" });
    let clearedCount = 0;

    for (const cookie of cookies) {
      if (!isDoubaoDomain(cookie.domain)) {
        continue;
      }

      try {
        await chrome.cookies.remove({
          url: buildCookieUrl(cookie),
          name: cookie.name,
          storeId: cookie.storeId,
        });
        clearedCount += 1;
      } catch (cookieError) {
        console.warn(`[CookieCleanup] Failed to clear cookie ${cookie.name}:`, cookieError);
      }
    }

    console.log(`[CookieCleanup] Cleared ${clearedCount} Doubao cookies`);
  } catch (error) {
    console.error("[CookieCleanup] Failed to clear cookies:", error);
  }
}

chrome.webNavigation.onCommitted.addListener(
  async (details) => {
    if (details.frameId !== 0) {
      return;
    }

    if (details.url?.startsWith(DOUBAO_COOKIE_URL)) {
      console.log("[CookieCleanup] Doubao page committed:", details.url);
    }
  },
  { url: [{ hostContains: "doubao.com", schemes: ["https"] }] }
);

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.sync.set({ autoReload: false });
});

chrome.runtime.onStartup.addListener(async () => {});

const streamRequestIds = new Set();
const pendingWebSocketMessages = [];
const deliveredTaskResults = new Set();
const attachedDebuggerTabs = new Set();

function isManageableDoubaoUrl(url = "") {
  if (typeof url !== "string") {
    return false;
  }
  return /^https:\/\/www\.doubao\.com(\/|$)/.test(url);
}

function collectImageUrlsFromCreations(creations, imageUrls) {
  if (!Array.isArray(creations)) {
    return;
  }

  creations.forEach((creation) => {
    if (!creation || creation.type !== 1 || !creation.image) {
      return;
    }

    const rawUrl = creation.image.image_ori_raw?.url;
    const fallbackUrl =
      creation.image.image_ori?.url ||
      creation.image.image_preview?.url ||
      creation.image.image_thumb?.url;

    const imageUrl = rawUrl || fallbackUrl;
    if (imageUrl) {
      imageUrls.push(imageUrl);
      console.log("Found image URL:", imageUrl);
    }
  });
}

function queueWebSocketMessage(data) {
  pendingWebSocketMessages.push(data);
  console.log(
    "[WebSocket] Queued message:",
    data?.type || "unknown",
    "commandId:",
    data?.commandId || null
  );
}

function flushPendingWebSocketMessages() {
  if (!ws || ws.readyState !== WebSocket.OPEN || pendingWebSocketMessages.length === 0) {
    return;
  }

  while (pendingWebSocketMessages.length > 0) {
    const message = pendingWebSocketMessages[0];
    if (!sendWebSocketMessage(message)) {
      return;
    }
    pendingWebSocketMessages.shift();
  }
}

function extractImageUrlsFromSseData(data, imageUrls) {
  if (!data || typeof data !== "object") {
    return;
  }

  // Legacy structure.
  if (data.event_data) {
    try {
      const eventData = JSON.parse(data.event_data);
      if (eventData.message?.content) {
        const content = JSON.parse(eventData.message.content);
        collectImageUrlsFromCreations(content.creations, imageUrls);

        if (Array.isArray(content.data)) {
          content.data.forEach((item) => {
            if (item.image_raw?.url) {
              imageUrls.push(item.image_raw.url);
              console.log("Found image URL (data):", item.image_raw.url);
            }
          });
        }
      }
    } catch (error) {
      console.error("Error parsing legacy EventStream data:", error);
    }
  }

  // Current Doubao SSE structure.
  if (Array.isArray(data.patch_op)) {
    data.patch_op.forEach((patch) => {
      const contentBlocks = patch?.patch_value?.content_block;
      if (!Array.isArray(contentBlocks)) {
        return;
      }

      contentBlocks.forEach((block) => {
        const creations = block?.content?.creation_block?.creations;
        collectImageUrlsFromCreations(creations, imageUrls);
      });
    });
  }
}

function dispatchCollectedImagesForTab(tabId, imageUrls) {
  if (typeof tabId !== "number") {
    return;
  }

  const uniqueImageUrls = [...new Set(imageUrls)];
  if (uniqueImageUrls.length === 0) {
    return;
  }

  const commandId = getCurrentCommandIdForTab(tabId);
  console.log("发送图片清单到任务标签页", tabId, "commandId:", commandId);

  if (commandId) {
    if (!deliveredTaskResults.has(commandId)) {
      const wsMessage = {
        type: "collectedImageUrls",
        commandId,
        urls: uniqueImageUrls,
        tabId,
      };
      if (!sendWebSocketMessage(wsMessage)) {
        queueWebSocketMessage(wsMessage);
      }
      deliveredTaskResults.add(commandId);
    } else {
      console.log("任务结果已发送，跳过重复回传", commandId);
    }
  } else {
    console.warn("未找到任务标签页对应的 commandId，无法直接回传到后端", tabId);
  }

  chrome.tabs.sendMessage(tabId, {
    type: "IMAGE_URLS",
    urls: uniqueImageUrls,
  });

  onTaskCompleted(tabId);
}

// 添加调试器监听器来拦截 EventStream 请求
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (method === "Network.responseReceived") {
    const requestId = params.requestId; // 获取 requestId
    const response = params.response;

    // 检查 Content-Type 是否为 text/event-stream
    const contentType =
      response.headers["content-type"] || response.headers["Content-Type"]; // Header names can be case-insensitive
    if (contentType && contentType.includes("text/event-stream")) {
      console.log("EventStream Response Headers Received:", response);
      console.log("Request ID for EventStream:", requestId);
      streamRequestIds.add(requestId);
    }
  }
  else if (method === "Network.eventSourceMessageReceived") {
    const dataLine = params?.data;
    if (!dataLine) {
      return;
    }

    try {
      const data = JSON.parse(dataLine);
      const imageUrls = [];
      extractImageUrlsFromSseData(data, imageUrls);
      if (imageUrls.length > 0) {
        console.log("EventSource incremental image URLs found:", imageUrls.length);
        dispatchCollectedImagesForTab(source?.tabId, imageUrls);
      }
    } catch (error) {
      console.error("Error parsing eventSourceMessageReceived payload:", error);
    }
  }
  // 如果你想捕获 EventSource 发送的单个消息（SSE 事件）
  // 你也可以监听 'Network.eventSourceMessageReceived'
  else if (method === "Network.loadingFinished") {
    const { requestId } = params;
    // 判断请求的id是否被记录，是stream类型
    if (streamRequestIds.has(requestId)) {
      try {
        // 使用 Network.getResponseBody 获取响应体
        // source 是 debuggee target，可以直接传递
        const responseBodyData = await chrome.debugger.sendCommand(
          source,
          "Network.getResponseBody",
          { requestId: requestId }
        );

        // responseBodyData 包含 { body: string, base64Encoded: boolean }
        let responseBody = responseBodyData.body;
        if (responseBodyData.base64Encoded) {
          // 如果是 base64 编码的，需要解码
          // 对于 text/event-stream，通常不会是 base64 编码的，但以防万一
          try {
            responseBody = atob(responseBody);
          } catch (e) {
            console.error("Failed to decode base64 body for event stream:", e);
            // Fallback to using the raw base64 string if decoding fails
          }
        }

        console.log("EventStream Response Body:", responseBody);

        // 解析EventStream响应
        const lines = responseBody.split('\n');
        const imageUrls = []; // 存储所有图片URL

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const jsonStr = line.slice(6); // 移除 'data: ' 前缀
              const data = JSON.parse(jsonStr);

              extractImageUrlsFromSseData(data, imageUrls);
            } catch (error) {
              console.error('Error parsing EventStream data:', error);
            }
          }
        }

        const uniqueImageUrls = [...new Set(imageUrls)];

        // 输出找到的所有图片URL
        if (uniqueImageUrls.length > 0) {
          console.log('Total images found:', uniqueImageUrls.length);
          console.log('All image URLs:', uniqueImageUrls);
          dispatchCollectedImagesForTab(source?.tabId, uniqueImageUrls);
        }

        // 注意：对于 text/event-stream，Network.getResponseBody 可能只返回已接收到的部分
        // 或者在流结束时返回全部。如果你需要实时处理每个事件，
        // 你可能需要监听 'Network.eventSourceMessageReceived' 事件。
        // 但 'Network.getResponseBody' 会尝试获取当前可用的完整或部分主体。
      } catch (error) {
        console.error(
          `Error getting response body for requestId ${requestId}:`,
          error
        );
        // 常见错误：
        // - "No resource with given identifier found": 请求可能已完成或被取消，或者 requestId 无效。
        // - "Can only get response body on main resource": 不太可能用于 event-stream。
        // - If the stream is still actively pushing data and not yet "finished" in some sense,
        //   getResponseBody might give you what's buffered so far.
      }
      streamRequestIds.delete(requestId);
    }
  }
});

// ==================== WebSocket 管理 ====================
const DEFAULT_WEBSOCKET_URL = 'ws://localhost:8080';
const FALLBACK_WEBSOCKET_URLS = [
  'ws://browser-api:8080',
  'ws://host.docker.internal:8080',
  DEFAULT_WEBSOCKET_URL,
];
const RECONNECT_DELAY_MS = 5000;

// WebSocket 状态
let ws = null;
let reconnectTimeout = null;
let activeWebSocketUrl = null;

// ==================== 标签页管理 ====================
let doubaoTabs = new Map(); // tabId -> { id, url, status: 'idle' | 'busy', lastUsed: timestamp, currentCommandId: string | null }
let taskQueue = []; // 任务队列
let currentTabIndex = 0; // 轮询索引

// tab状态管理
function addDoubaoTab(tabId, url) {
  if (!isManageableDoubaoUrl(url)) {
    return;
  }
  doubaoTabs.set(tabId, {
    id: tabId,
    url: url,
    status: 'idle',
    lastUsed: Date.now(),
    currentCommandId: null
  });
}

function removeDoubaoTab(tabId) {
  if (doubaoTabs.has(tabId)) {
    doubaoTabs.delete(tabId);
  }
}

function setTabStatus(tabId, status, commandId = null) {
  if (doubaoTabs.has(tabId)) {
    const tabInfo = doubaoTabs.get(tabId);
    tabInfo.status = status;
    if (status === 'busy' && commandId) {
      tabInfo.currentCommandId = commandId;
    }
    if (status === 'idle') {
      tabInfo.lastUsed = Date.now();
      tabInfo.currentCommandId = null;
    }
  }
}

function getCurrentCommandIdForTab(tabId) {
  if (!doubaoTabs.has(tabId)) {
    return null;
  }
  return doubaoTabs.get(tabId).currentCommandId || null;
}

function getIdleTab() {
  // 轮询策略：找到空闲的tab
  const idleTabs = Array.from(doubaoTabs.values()).filter(tab => tab.status === 'idle');
  
  if (idleTabs.length === 0) {
    return null;
  }
  
  // 使用轮询策略选择tab
  const selectedTab = idleTabs[currentTabIndex % idleTabs.length];
  currentTabIndex = (currentTabIndex + 1) % idleTabs.length;
  
  return selectedTab;
}

function getAllDoubaoTabs() {
  return Array.from(doubaoTabs.values());
}

// 任务分发
function dispatchTask(task) {
  const idleTab = getIdleTab();
  
  if (idleTab) {
    // 有空闲tab，直接分发
    try {
      const taskObj = JSON.parse(task);
      setTabStatus(idleTab.id, 'busy', taskObj.commandId || null);
    } catch (error) {
      setTabStatus(idleTab.id, 'busy');
    }
    sendTaskToTab(idleTab.id, task);
    return true;
  } else {
    // 没有空闲tab，加入队列
    taskQueue.push(task);
    return false;
  }
}

function sendTaskToTab(tabId, task) {
  // 先检查tab是否还存在
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      console.error(`[TaskManager] Tab ${tabId} no longer exists:`, chrome.runtime.lastError);
      removeDoubaoTab(tabId);
      processTaskQueue();
      return;
    }
    
    try {
      const taskObj = JSON.parse(task);
      setTabStatus(tabId, 'busy', taskObj.commandId || null);
    } catch (error) {
      setTabStatus(tabId, 'busy');
    }

    // 发送任务到tab
    chrome.tabs.sendMessage(tabId, {
      type: 'COMMAND_FROM_SERVER',
      data: task
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error(`[TaskManager] Failed to send task to tab ${tabId}:`, chrome.runtime.lastError);
        // 如果发送失败，将tab标记为空闲并重新分发任务
        setTabStatus(tabId, 'idle');
        processTaskQueue();
      }
    });
  });
}

function processTaskQueue() {
  while (taskQueue.length > 0) {
    const task = taskQueue.shift();
    if (!dispatchTask(task)) {
      // 如果无法分发，重新加入队列头部
      taskQueue.unshift(task);
      break;
    }
  }
}

// 任务完成回调
function onTaskCompleted(tabId) {
  setTabStatus(tabId, 'idle');
  processTaskQueue(); // 处理队列中的任务
}

function getWebSocketCandidates(configuredUrl) {
  const candidates = [];
  const seen = new Set();

  for (const candidate of [configuredUrl, ...FALLBACK_WEBSOCKET_URLS]) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    candidates.push(candidate);
  }

  return candidates;
}

function tryConnectWebSocket(candidates, index = 0) {
  if (index >= candidates.length) {
    console.error('[WebSocket] All connection targets failed:', candidates);
    scheduleReconnect();
    return;
  }

  const websocketUrl = candidates[index];

  try {
    ws = new WebSocket(websocketUrl);
    activeWebSocketUrl = websocketUrl;
    setupWebSocketHandlers(candidates, index);
  } catch (error) {
    console.error('[WebSocket] Connection failed:', websocketUrl, error);
    tryConnectWebSocket(candidates, index + 1);
  }
}

/**
 * 建立WebSocket连接
 */
function connectWebSocket() {
    // 防止重复连接
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
        return;
    }

    chrome.storage.sync.get(['wsUrl'], (result) => {
        const candidates = getWebSocketCandidates(result.wsUrl);
        tryConnectWebSocket(candidates);
    });
}

/**
 * 设置WebSocket事件处理器
 */
function setupWebSocketHandlers(candidates, candidateIndex) {
    ws.onopen = () => handleWebSocketOpen(activeWebSocketUrl);
    ws.onmessage = handleWebSocketMessage;
    ws.onerror = handleWebSocketError;
    ws.onclose = (event) => handleWebSocketClose(event, candidates, candidateIndex);
}

/**
 * WebSocket连接成功处理
 */
function handleWebSocketOpen(websocketUrl) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
    console.log('[WebSocket] Connected:', websocketUrl);
    
    // 通知所有豆包标签页连接已建立
    notifyAllTabsConnectionReady();
    flushPendingWebSocketMessages();
}

/**
 * WebSocket消息处理
 */
function handleWebSocketMessage(event) {
    
    try {
        const message = JSON.parse(event.data);
        
        // 如果指定了目标标签页，直接发送到该标签页
        if (message.targetTabId && doubaoTabs.has(message.targetTabId)) {
            sendTaskToTab(message.targetTabId, event.data);
        } else {
            // 否则使用轮询策略分发任务
            dispatchTask(event.data);
        }
    } catch (e) {
        // 非JSON消息直接分发
        dispatchTask(event.data);
    }
}

/**
 * WebSocket错误处理
 */
function handleWebSocketError(error) {
    console.warn("[WebSocket] Error:", error);
    // 让onclose处理连接关闭
}

/**
 * WebSocket连接关闭处理
 */
function handleWebSocketClose(event, candidates = [], candidateIndex = 0) {
    ws = null;
    const shouldTryNextCandidate =
      (!event.wasClean || event.code === 1006) &&
      candidateIndex < candidates.length - 1;

    if (shouldTryNextCandidate) {
      const nextIndex = candidateIndex + 1;
      console.warn(
        '[WebSocket] Closed before ready, trying fallback:',
        candidates[nextIndex]
      );
      tryConnectWebSocket(candidates, nextIndex);
      return;
    }

    scheduleReconnect();
}

/**
 * 通知所有豆包标签页连接已就绪
 */
function notifyAllTabsConnectionReady() {
    const allTabs = getAllDoubaoTabs();
    allTabs.forEach(tab => {
        chrome.tabs.get(tab.id, (tabInfo) => {
            if (tabInfo) {
                sendWebSocketMessage({ 
                    type: 'scriptReady', 
                    url: tabInfo.url, 
                    tabId: tab.id,
                    platform: 'doubao'
                });
            }
        });
    });
}

/**
 * 调度重连
 */
function scheduleReconnect() {
    if (reconnectTimeout === null) {
        reconnectTimeout = setTimeout(() => {
            reconnectTimeout = null;
            connectWebSocket();
        }, RECONNECT_DELAY_MS);
    } else {
    }
}

/**
 * 发送WebSocket消息
 */
function sendWebSocketMessage(data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn("[WebSocket] Cannot send message, connection not open", data);
        return false;
    }

    try {
        const message = typeof data === 'object' ? JSON.stringify(data) : String(data);
        if (typeof data === "object" && data !== null) {
            console.log(
              "[WebSocket] Sending message:",
              data.type || "unknown",
              "commandId:",
              data.commandId || null
            );
        }
        ws.send(message);
        return true;
    } catch (e) {
        console.error("[WebSocket] Failed to send message:", e);
        return false;
    }
}

/**
 * 获取WebSocket连接状态
 */
function getWebSocketStatus() {
    if (!ws) return { connected: false, state: 'disconnected' };
    
    const states = ['connecting', 'open', 'closing', 'closed'];
    return {
        connected: ws.readyState === WebSocket.OPEN,
        state: states[ws.readyState] || 'unknown'
    };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'COLLECTED_IMAGE_URLS') {
        const wsMessage = { 
            type: 'collectedImageUrls', 
            commandId: message.commandId, // 添加commandId支持
            urls: message.urls,
            tabId: sender.tab.id
        };
        if (!sendWebSocketMessage(wsMessage)) {
            queueWebSocketMessage(wsMessage);
        }
        onTaskCompleted(sender.tab.id);
    } else if (message.type === 'TASK_COMPLETED') {
        // content script通知任务完成
        onTaskCompleted(sender.tab.id);
        sendResponse({ success: true });
    } else if (message.type === 'TAB_STATUS_UPDATE') {
        // content script更新tab状态
        if (message.status) {
            setTabStatus(sender.tab.id, message.status);
        }
        sendResponse({ success: true });
    } else if (message.type === 'ERROR_FROM_CONTENT') {
        // content script报告错误
        console.error(`[Background] Error from tab ${sender.tab.id}:`, message.error);
        sendWebSocketMessage({
            type: 'error',
            commandId: message.error.details?.commandId,
            errorDetails: message.error.message,
            tabId: sender.tab.id
        });
        sendResponse({ success: true });
    } else if (message.type === 'GET_TAB_STATUS') {
        // 获取所有tab状态
        const tabStatus = getAllDoubaoTabs().map(tab => ({
            id: tab.id,
            status: tab.status,
            lastUsed: tab.lastUsed,
            url: tab.url
        }));
        
        const wsStatus = getWebSocketStatus();
        sendResponse({ 
            tabs: tabStatus, 
            queueLength: taskQueue.length,
            wsConnected: wsStatus.connected,
            wsState: wsStatus.state
        });
        return true;
    } else if (message.type === 'FORCE_TASK_DISPATCH') {
        // 强制分发指定任务到指定tab
        if (message.tabId && message.task && doubaoTabs.has(message.tabId)) {
            sendTaskToTab(message.tabId, message.task);
            sendResponse({ success: true });
        } else {
            sendResponse({ success: false, error: 'Invalid tab or task' });
        }
        return true;
    }
});

// 处理插件图标点击事件
chrome.action.onClicked.addListener(async (tab) => {
  
  try {
    // 检查是否在豆包页面
    if (tab.url && tab.url.includes('doubao.com')) {
      // 注入设置面板到当前页面
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['settings-panel.js']
      });
    } else {
      // 如果不是豆包页面，打开新标签页
      chrome.tabs.create({ url: 'https://www.doubao.com' });
    }
  } catch (error) {
    console.error('[Action] Error injecting settings panel:', error);
  }
});

// 为所有标签页附加调试器
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === "complete" &&
    isManageableDoubaoUrl(tab.url)
  ) {
    // 添加到tab管理器
    addDoubaoTab(tabId, tab.url);
    
    // 如果这是第一个tab，建立WebSocket连接
    if (doubaoTabs.size === 1) {
      connectWebSocket();
    }
    
    if (attachedDebuggerTabs.has(tabId)) {
      return;
    }

    try {
      chrome.debugger.attach({ tabId }, "1.0", () => {
        if (chrome.runtime.lastError) {
          console.error("Debugger attach error:", chrome.runtime.lastError);
          removeDoubaoTab(tabId);
          return;
        }
        attachedDebuggerTabs.add(tabId);
        chrome.debugger.sendCommand({ tabId }, "Network.enable", {}, () => {
          if (chrome.runtime.lastError) {
            console.error("Network enable error:", chrome.runtime.lastError);
          }
        });
      });
    } catch (error) {
      console.error("Debugger error:", error);
    }
  }
});

// 在标签页关闭时分离调试器
chrome.tabs.onRemoved.addListener((tabId) => {
  if (doubaoTabs.has(tabId)) {
    removeDoubaoTab(tabId);
    
    // 如果没有剩余的豆包tab，关闭WebSocket但保持重连机制
    if (doubaoTabs.size === 0) {
      if (ws) {
        ws.close();
      }
      // 保持重连机制工作，清空任务队列
      taskQueue = [];
      currentTabIndex = 0;
    }
  }
  attachedDebuggerTabs.delete(tabId);
  
  try {
    chrome.debugger.detach({ tabId });
  } catch (error) {
    console.error("Debugger detach error:", error);
  }
});
