const fs = require("fs/promises");
const https = require("https");
const http = require("http");

/* =========================
    CONFIGURATION
   ========================= */
const CONFIG = {
  seedCostCoins: { wheat: 2 },
  seedCostAP: {
    "golden-apple": 10,
    "royal-apple": 1500
  },
  boosterKey: "quantum-fertilizer",
  boosterCostAP: 175,
  plantingMode: "auto50",
  boosterIgnoreReservedAP: true,
  manual: { wheatSlots: [1,2,3,4,5], goldenSlots: [6,7,8,9,10] },
  safetyMargin: 2,
  perRequestDelayMs: 120,
  postHarvestPoll: { tries: 6, delayMs: 250 },
  apFloor: 0,
  maxWaitSeconds: 180,
  pollJitter: 0.15,
  refreshIntervalSeconds: 1,
  idleRefreshMs: 10000,
  
  bufferSettings: {
    harvest: {
      immediate: 2000,    
      short: 5000,        
      medium: 15000,      
      long: 30000         
    },
    claim: 60000,
    booster: 5000,
  },
  
  showBufferInfo: true,
  debug: false,         
  proxy: {
    enabled: false,
    list: [],
    currentIndex: 0,
    rotateOnError: true,
    timeout: 30000,
  }
};

/* =========================
    PROXY UTILITIES
   ========================= */
class ProxyManager {
  constructor() {
    this.proxies = [];
    this.currentIndex = 0;
    this.loadProxies();
  }

  async loadProxies() {
    try {
      const rawProxies = await fs.readFile("proxy.txt", "utf8");
      
      this.proxies = rawProxies
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(proxy => this.parseProxy(proxy))
        .filter(proxy => proxy !== null);
      
      CONFIG.proxy.list = this.proxies;
      CONFIG.proxy.enabled = this.proxies.length > 0;
      
      if (this.proxies.length > 0) {
        console.log(`[PROXY] Loaded ${this.proxies.length} proxies`);
      }
      
    } catch (error) {
      CONFIG.proxy.enabled = false;
      this.proxies = [];
    }
  }

  parseProxy(proxyString) {
    try {
      let url = proxyString;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'http://' + url;
      }
      
      const parsedUrl = new URL(url);
      
      return {
        protocol: parsedUrl.protocol.replace(':', ''),
        host: parsedUrl.hostname,
        port: parseInt(parsedUrl.port) || 8080,
        username: parsedUrl.username || null,
        password: parsedUrl.password || null,
        auth: parsedUrl.username ? `${parsedUrl.username}:${parsedUrl.password}` : null
      };
    } catch (error) {
      return null;
    }
  }

  getCurrentProxy() {
    if (!CONFIG.proxy.enabled || this.proxies.length === 0) {
      return null;
    }
    return this.proxies[this.currentIndex];
  }

  rotateProxy() {
    if (this.proxies.length > 1) {
      this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
    }
  }

  getProxyForAccount(accountIndex) {
    if (!CONFIG.proxy.enabled || this.proxies.length === 0) {
      return null;
    }
    
    const proxyIndex = accountIndex % this.proxies.length;
    return this.proxies[proxyIndex];
  }
}

const proxyManager = new ProxyManager();

/* =========================
    API ENDPOINTS
   ========================= */
const ENDPOINTS = {
  GET_STATE: "https://app.appleville.xyz/api/trpc/core.getState?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%2C%22meta%22%3A%7B%22values%22%3A%5B%22undefined%22%5D%7D%7D%7D",
  CLAIM: "https://app.appleville.xyz/api/trpc/core.collectFarmhouse?batch=1",
  BATCH_HARVEST: "https://app.appleville.xyz/api/trpc/core.batchHarvest?batch=1",
  HARVEST_SINGLE_BASE: "https://app.appleville.xyz/api/trpc/core.harvest",
  BUY: "https://app.appleville.xyz/api/trpc/core.batchBuyItem?batch=1",
  BUY_SINGLE: "https://app.appleville.xyz/api/trpc/core.buyItem?batch=1",
  PLANT_SINGLE: "https://app.appleville.xyz/api/trpc/core.plantSeed?batch=1",
  BUY_PLOT: "https://app.appleville.xyz/api/trpc/core.buyPlot?batch=1",
  APPLY_MOD: "https://app.appleville.xyz/api/trpc/core.applyModifier?batch=1",
};

/* =========================
    UTILITY FUNCTIONS
   ========================= */
class GameUtils {
  static sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  static isReady(seed) {
    return !!seed?.endsAt && new Date(seed.endsAt).getTime() <= Date.now();
  }

  static isExpired(modifier) {
    return !!modifier?.endsAt && new Date(modifier.endsAt).getTime() <= Date.now();
  }

  static getTimeUntil(isoString) {
    const timestamp = new Date(isoString).getTime();
    return Number.isNaN(timestamp) ? null : (timestamp - Date.now());
  }

  static countItems(items, key, type = "SEED") {
    return (items || [])
      .filter(item => item.type === type && item.key === key)
      .reduce((sum, item) => sum + (item.quantity || 0), 0);
  }

  static formatTime(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
    const secs = String(seconds % 60).padStart(2, "0");
    return `${hours}:${minutes}:${secs}`;
  }

  static formatNumber(num) {
    if (num === undefined || num === null) return "-";
    if (typeof num !== 'number') return String(num);
    
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return String(num);
  }

  static formatItemCounts(keys) {
    const frequency = keys.reduce((map, key) => {
      map[key] = (map[key] || 0) + 1;
      return map;
    }, {});

    return Object.entries(frequency)
      .map(([key, count]) => count > 1 ? `${key}×${count}` : key)
      .join(", ");
  }

  // ========== SMART STRATEGY ==========
  static getDesiredPlantingMap(totalPlots, nextPlotPrice = null) {
    const map = new Map();

    // STRATEGY 1: 1 plot -> wheat
    if (totalPlots === 1) {
      map.set(1, "wheat");
      return map;
    }

    // STRATEGY 2: 2 plot -> 50/50
    if (totalPlots === 2) {
      map.set(1, "wheat");
      map.set(2, "golden-apple");
      return map;
    }

    // STRATEGY 3: <12 plot -> proporsional berdasar biaya plot berikutnya
    if (totalPlots < 12) {
      return this.getStrategicPlantingMap(totalPlots, nextPlotPrice);
    }

    // STRATEGY 4: >=12 plot -> fokus high value (default golden)
    for (let i = 1; i <= totalPlots; i++) {
      map.set(i, "golden-apple");
    }
    return map;
  }

  static getStrategicPlantingMap(totalPlots, nextPlotPrice) {
    const map = new Map();

    // Normalisasi currency
    const currency = (nextPlotPrice && nextPlotPrice.currency || "").toString().toLowerCase();

    // Rasio default
    let wheatSlots, goldenSlots;

    if (currency === "coins") {
      wheatSlots = Math.ceil(totalPlots * 0.6);
      goldenSlots = totalPlots - wheatSlots;
    } else if (currency === "ap") {
      goldenSlots = Math.ceil(totalPlots * 0.6);
      wheatSlots = totalPlots - goldenSlots;
    } else {
      wheatSlots = Math.ceil(totalPlots / 2);
      goldenSlots = totalPlots - wheatSlots;
    }

    let wheatCount = 0;
    let goldenCount = 0;

    for (let i = 1; i <= totalPlots; i++) {
      if (wheatCount < wheatSlots) {
        map.set(i, "wheat");
        wheatCount++;
      } else if (goldenCount < goldenSlots) {
        map.set(i, "golden-apple");
        goldenCount++;
      } else {
        map.set(i, "wheat");
      }
    }

    return map;
  }

  // Smart delay calculation
  static getNextActionDelay(state) {
    const delays = [];
    const now = Date.now();
    
    for (const plot of state?.plots || []) {
      if (plot?.seed?.endsAt) {
        const harvestTime = new Date(plot.seed.endsAt).getTime();
        const delay = harvestTime - now;
        
        if (delay > 0) {
          let buffer = 0;
          if (delay <= 30000) {      
            buffer = CONFIG.bufferSettings.harvest.immediate;
          } else if (delay <= 120000) { 
            buffer = CONFIG.bufferSettings.harvest.short;    
          } else if (delay <= 600000) { 
            buffer = CONFIG.bufferSettings.harvest.medium;   
          } else {
            buffer = CONFIG.bufferSettings.harvest.long;      
          }
          
          const bufferedDelay = Math.max(1000, delay - buffer);
          delays.push(bufferedDelay);
        }
      }
    }
    
    // Daily claim
    if (state?.lastFarmhouseAt) {
      const claimTime = new Date(state.lastFarmhouseAt).getTime() + 86400000;
      const claimDelay = claimTime - now;
      if (claimDelay > 0) {
        const bufferedClaimDelay = Math.max(1000, claimDelay - CONFIG.bufferSettings.claim);
        delays.push(bufferedClaimDelay);
      }
    }
    
    const rawDelay = delays.length ? Math.min(...delays) : 60000;
    const capMs = (CONFIG.maxWaitSeconds || 180) * 1000;
    const finalDelay = Math.min(rawDelay, capMs);

    // Add small jitter
    const j = Math.max(0, Math.min(0.5, CONFIG.pollJitter ?? 0.15));
    const jitterMs = Math.floor(finalDelay * j);
    return Math.max(1000, finalDelay - jitterMs + Math.floor(Math.random() * (jitterMs * 2 + 1)));
  }

  static async refreshStateUntil(api, predicate, { tries = 6, delayMs = 250 } = {}) {
    let state = await api.getState();
    for (let i = 0; i < tries; i++) {
      if (predicate(state)) return state;
      await this.sleep(delayMs);
      state = await api.getState();
    }
    return state;
  }
}

/* =========================
    SMART DELAY 
   ========================= */
class SmartDelayCalculator {
  static getDetailedNextAction(state) {
    const events = [];
    const now = Date.now();

    // Collect harvest events with detailed
    for (const plot of state?.plots || []) {
      if (plot?.seed?.endsAt) {
        const harvestTime = new Date(plot.seed.endsAt).getTime();
        const delay = harvestTime - now;
        
        if (delay > 0) {
          let buffer = 0;
          let urgency = "normal";
          
          if (delay <= 30000) {
            buffer = CONFIG.bufferSettings.harvest.immediate;
            urgency = "immediate";
          } else if (delay <= 120000) {
            buffer = CONFIG.bufferSettings.harvest.short;
            urgency = "short";
          } else if (delay <= 600000) {
            buffer = CONFIG.bufferSettings.harvest.medium;
            urgency = "medium";
          } else {
            buffer = CONFIG.bufferSettings.harvest.long;
            urgency = "long";
          }
          
          events.push({
            type: "harvest",
            slotIndex: plot.slotIndex,
            seedKey: plot.seed.key,
            exactTime: harvestTime,
            delay: delay,
            bufferedDelay: Math.max(1000, delay - buffer),
            buffer: buffer,
            urgency: urgency,
            timeString: new Date(harvestTime).toLocaleTimeString()
          });
        }
      }
    }

    // Daily claim
    if (state?.lastFarmhouseAt) {
      const claimTime = new Date(state.lastFarmhouseAt).getTime() + 86400000;
      const delay = claimTime - now;
      
      if (delay > 0) {
        events.push({
          type: "claim",
          exactTime: claimTime,
          delay: delay,
          bufferedDelay: Math.max(1000, delay - CONFIG.bufferSettings.claim),
          buffer: CONFIG.bufferSettings.claim,
          urgency: "normal",
          timeString: new Date(claimTime).toLocaleTimeString()
        });
      }
    }

    // Sort by buffered delay
    events.sort((a, b) => a.bufferedDelay - b.bufferedDelay);
    
    return events.length > 0 ? events[0] : null;
  }

  static generateBufferStatus(nextEvent) {
    if (!nextEvent) return "No events scheduled";
    
    const timeUntilAction = GameUtils.formatTime(nextEvent.bufferedDelay);
    const timeUntilActual = GameUtils.formatTime(nextEvent.delay);
    const bufferTime = GameUtils.formatTime(nextEvent.buffer);
    
    if (CONFIG.showBufferInfo) {
      switch (nextEvent.type) {
        case "harvest":
          return `Harvest ${nextEvent.seedKey} in ${timeUntilAction} (actual: ${timeUntilActual}, buffer: ${bufferTime})`;
        case "claim":
          return `Daily claim in ${timeUntilAction} (actual: ${timeUntilActual}, buffer: ${bufferTime})`;
        default:
          return `Next action in ${timeUntilAction} (buffer: ${bufferTime})`;
      }
    } else {
      switch (nextEvent.type) {
        case "harvest":
          return `Harvest ${nextEvent.seedKey} in ${timeUntilAction}`;
        case "claim":
          return `Daily claim in ${timeUntilAction}`;
        default:
          return `Next action in ${timeUntilAction}`;
      }
    }
  }

  static getAllUpcomingEvents(state) {
    const events = [];
    const now = Date.now();

    // All harvest events
    for (const plot of state?.plots || []) {
      if (plot?.seed?.endsAt) {
        const harvestTime = new Date(plot.seed.endsAt).getTime();
        const delay = harvestTime - now;
        if (delay > 0) {
          events.push({
            type: "harvest",
            description: `Harvest ${plot.seed.key} (slot ${plot.slotIndex})`,
            delay: delay,
            timeString: new Date(harvestTime).toLocaleTimeString()
          });
        }
      }
    }

    // Daily claim
    if (state?.lastFarmhouseAt) {
      const claimTime = new Date(state.lastFarmhouseAt).getTime() + 86400000;
      const delay = claimTime - now;
      if (delay > 0) {
        events.push({
          type: "claim",
          description: "Daily farmhouse claim",
          delay: delay,
          timeString: new Date(claimTime).toLocaleTimeString()
        });
      }
    }

    return events.sort((a, b) => a.delay - b.delay);
  }
}

/* =========================
    SIMPLE DISPLAY
   ========================= */
class SimpleDisplay {
  constructor() {
    this.accounts = new Map();
    this.startTime = Date.now();
    
    console.log("═".repeat(70));
    console.log("🍎 APPLEVILLE AUTOMATION BOT - Buffer System Enabled");
    console.log("═".repeat(70));
  }

  updateAccount(index, state, status) {
    const ap = GameUtils.formatNumber(state?.ap);
    const coins = GameUtils.formatNumber(state?.coins);
    const plots = state?.numPlots ?? (state?.plots?.length || "-");
    
    this.accounts.set(index, {
      ap, coins, plots, status,
      lastUpdate: Date.now()
    });
    
    this.displayLine(index);
  }

  displayLine(index) {
    const account = this.accounts.get(index);
    if (!account) return;
    
    const accountNum = `#${(index + 1).toString().padStart(2, '0')}`;
    const statusIcon = this.getStatusIcon(account.status);
    const cleanStatus = this.cleanStatus(account.status);
    
    console.log(`[${accountNum}] AP: ${account.ap.padEnd(8)} | Coins: ${account.coins.padEnd(8)} | Plots: ${String(account.plots).padEnd(2)} | ${statusIcon} ${cleanStatus}`);
  }

  cleanStatus(status) {
    if (!status) return "Initializing...";
    
    // Remove priority emoji and duplicates
    let cleaned = status.replace(/^[🔴🟡🟢⚪]\s*/, '');
    cleaned = cleaned.replace(/([🌾🌱💰🚀⏱️✅❌⚠️])\s*\1+/g, '$1');
    
    // Clean up specific patterns  
    cleaned = cleaned
      .replace(/Ready to harvest (\d+) crops?/, 'Harvesting $1 crops')
      .replace(/Ready to plant (\d+) empty slots?/, 'Planting $1 slots') 
      .replace(/Need to buy seeds: (.+)/, 'Buying $1 seeds')
      .replace(/Need to buy (\d+) boosters \((\d+) AP\)/, 'Buying $1 boosters')
      .replace(/Applying boosters to (\d+) slots/, 'Boosting $1 slots')
      .replace(/Next action in (\d{2}:\d{2}:\d{2})/, 'Wait $1')
      .replace(/Polling in (\d{2}:\d{2}:\d{2})/, 'Check $1')
      .replace(/Daily rewards ready to claim/, 'Claiming rewards')
      .replace(/successfully$/, 'done')
      .replace(/\s+/g, ' ')
      .trim();

    return cleaned;
  }

  getStatusIcon(status) {
    if (!status) return "⏳";
    const s = status.toLowerCase();
    
    // Buffer-aware status icons
    if (s.includes('harvest') && (s.includes('ready') || s.includes('harvesting') || s.includes('in ') && s.includes('buffer'))) return "🌾";
    if (s.includes('claim')) return "🎁";
    if (s.includes('buy') && s.includes('plot')) return "🏞️";
    if (s.includes('buy') && (s.includes('seed') || s.includes('wheat') || s.includes('golden') || s.includes('royal'))) return "💰";
    if (s.includes('buy') && s.includes('booster')) return "💰";
    if (s.includes('plant') && !s.includes('completed')) return "🌱";
    if (s.includes('boost') || s.includes('applying')) return "⚡";
    
    // Result-based icons
    if (s.includes('success') || s.includes('completed') || s.includes('done')) {
      if (s.includes('0 failed') || !s.includes('failed')) {
        return "✅";
      }
      return "⚠️";
    }
    
    if (s.includes('error') || s.includes('fail')) {
      if (s.includes('0 failed')) return "✅";
      return "❌";
    }
    
    // Timing-based icons
    if (s.includes('wait') || s.includes('next action') || s.includes('check') || s.includes('buffer') || s.includes('actual')) return "⏱️";
    if (s.includes('initializing') || s.includes('checking')) return "⏳";
    
    return "ℹ️";
  }

  setTotalAccounts(total) {
    console.log(`Starting ${total} account(s) with smart buffer system...`);
    console.log("═".repeat(70));
  }

  close() {
    const runtime = Math.floor((Date.now() - this.startTime) / 1000);
    const hours = Math.floor(runtime / 3600);
    const minutes = Math.floor((runtime % 3600) / 60);
    
    console.log("═".repeat(70));
    console.log(`Bot stopped. Runtime: ${hours}h ${minutes}m`);
  }
}

/* =========================
    HTTP CLIENT
   ========================= */
let HttpsProxyAgent, HttpProxyAgent;
try {
  ({ HttpsProxyAgent } = require('https-proxy-agent'));
  ({ HttpProxyAgent } = require('http-proxy-agent'));
} catch (error) {
  // Proxy agents not available
}

let defaultAgent = new https.Agent({ 
  keepAlive: true,
  maxSockets: 10,
  timeout: 30000
});

const proxyAgents = new Map();

function createProxyAgent(proxy, isHttps = true) {
  if (!proxy || !HttpsProxyAgent || !HttpProxyAgent) return defaultAgent;
  
  const proxyKey = `${proxy.host}:${proxy.port}:${proxy.auth || 'noauth'}:${isHttps}`;
  
  if (proxyAgents.has(proxyKey)) {
    return proxyAgents.get(proxyKey);
  }
  
  try {
    let proxyUrl = `http://${proxy.host}:${proxy.port}`;
    if (proxy.auth) {
      proxyUrl = `http://${proxy.auth}@${proxy.host}:${proxy.port}`;
    }
    
    const agent = isHttps ? 
      new HttpsProxyAgent(proxyUrl, { keepAlive: true, timeout: 30000 }) : 
      new HttpProxyAgent(proxyUrl, { keepAlive: true, timeout: 30000 });
    
    proxyAgents.set(proxyKey, agent);
    return agent;
  } catch (error) {
    return defaultAgent;
  }
}

const createHeaders = (cookie) => ({
  accept: "application/json",
  "trpc-accept": "application/json",
  "x-trpc-source": "nextjs-react",
  "content-type": "application/json",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  origin: "https://app.appleville.xyz",
  referer: "https://app.appleville.xyz/",
  cookie,
});

function makeHttpRequest(url, options = {}, proxy = null) {
  return new Promise((resolve, reject) => {
    try {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      
      let agent;
      if (proxy && HttpsProxyAgent && HttpProxyAgent) {
        agent = createProxyAgent(proxy, isHttps);
      } else {
        agent = isHttps ? defaultAgent : new http.Agent({ keepAlive: true });
      }
      
      const httpModule = isHttps ? https : http;
      
      const requestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        agent: agent,
        timeout: 30000,
      };

      if (proxy && proxy.auth) {
        requestOptions.headers['Proxy-Authorization'] = `Basic ${Buffer.from(proxy.auth).toString('base64')}`;
      }

      const req = httpModule.request(requestOptions, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
            }
            
            let json;
            try {
              json = JSON.parse(data);
            } catch (parseError) {
              return reject(new Error(`Failed to parse JSON response`));
            }
            
            resolve(json);
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Request failed: ${error.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timeout`));
      });

      if (options.body) {
        req.write(options.body);
      }
      
      req.end();
      
    } catch (error) {
      reject(new Error(`Request setup failed: ${error.message}`));
    }
  });
}

/* =========================
    API CLIENT
   ========================= */
class ApiClient {
  constructor(cookie, accountIndex = 0) {
    this.cookie = cookie;
    this.headers = createHeaders(cookie);
    this.accountIndex = accountIndex;
    
    // Get proxy if available
    if (typeof proxyManager !== 'undefined' && proxyManager.getProxyForAccount) {
      this.proxy = proxyManager.getProxyForAccount(accountIndex);
    } else {
      this.proxy = null;
    }
  }

  async makeRequest(url, options = {}) {
    let attempts = 0;
    const maxAttempts = this.proxy ? 3 : 1;

    while (attempts < maxAttempts) {
      try {
        return await makeHttpRequest(url, options, this.proxy);
      } catch (error) {
        attempts++;
        
        if (attempts < maxAttempts && this.proxy) {
          if (typeof proxyManager !== 'undefined' && proxyManager.rotateProxy) {
            proxyManager.rotateProxy();
            this.proxy = proxyManager.getCurrentProxy();
          }
          
          await GameUtils.sleep(1000);
        } else {
          throw error;
        }
      }
    }
  }

  async getState() {
    try {
      const data = await this.makeRequest(ENDPOINTS.GET_STATE, {
        method: "GET",
        headers: this.headers,
      });
      return data?.[0]?.result?.data?.json;
    } catch (error) {
      throw new Error(`Failed to get state: ${error.message}`);
    }
  }

  async claimFarmhouse() {
    try {
      return await this.makeRequest(ENDPOINTS.CLAIM, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ "0": { "json": null, "meta": { "values": ["undefined"] } } }),
      });
    } catch (error) {
      throw new Error(`Failed to claim farmhouse: ${error.message}`);
    }
  }

  async harvestSlots(slotIndexes) {
    try {
      const slots = [...new Set(slotIndexes.filter(Number.isInteger))].sort((a, b) => a - b);
      if (!slots.length) return;

      const body = JSON.stringify({ "0": { json: { slotIndexes: slots } } });
      
      try {
        await this.makeRequest(ENDPOINTS.BATCH_HARVEST, {
          method: "POST",
          headers: this.headers,
          body,
        });
      } catch (batchError) {
        // Fallback to single harvest
        const payload = {};
        slots.forEach((slot, i) => {
          payload[i] = { json: { slotIndex: slot } };
        });
        
        await this.makeRequest(`${ENDPOINTS.HARVEST_SINGLE_BASE}?batch=${slots.length}`, {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify(payload),
        });
      }
    } catch (error) {
      throw new Error(`Failed to harvest slots: ${error.message}`);
    }
  }

  async buyItems(purchases) {
    try {
      if (!purchases?.length) return;
      
      await this.makeRequest(ENDPOINTS.BUY, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ "0": { json: { purchases } } }),
      });
    } catch (error) {
      throw new Error(`Failed to buy items: ${error.message}`);
    }
  }

  async buySingleItem(key, type = "SEED", quantity = 1) {
    try {
      await this.makeRequest(ENDPOINTS.BUY_SINGLE, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ "0": { json: { key, type, quantity } } }),
      });
    } catch (error) {
      throw new Error(`Failed to buy single item: ${error.message}`);
    }
  }

  async buyPlot() {
    try {
      const body = JSON.stringify({
        "0": { json: null, meta: { values: ["undefined"] } },
      });
      
      await this.makeRequest(ENDPOINTS.BUY_PLOT, {
        method: "POST",
        headers: this.headers,
        body,
      });
    } catch (error) {
      throw new Error(`Failed to buy plot: ${error.message}`);
    }
  }

  // Planting
  async plantSeed(slotIndex, seedKey) {
    try {
      // Try new format first
      const newPayload = {
        "0": {
          json: {
            plantings: [
              {
                slotIndex: slotIndex,
                seedKey: seedKey
              }
            ]
          }
        }
      };

      await this.makeRequest(ENDPOINTS.PLANT_SINGLE, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(newPayload),
      });
      
    } catch (error) {
      // Fallback to old format
      try {
        const oldPayload = {
          "0": {
            json: {
              slotIndex: slotIndex,
              seedKey: seedKey
            }
          }
        };

        await this.makeRequest(ENDPOINTS.PLANT_SINGLE, {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify(oldPayload),
        });
        
      } catch (fallbackError) {
        throw new Error(`All planting formats failed: ${error.message}`);
      }
    }
  }

  // Booster application
  async applyModifier(slotIndex, modifierKey) {
    try {
      // Try new format first
      const newPayload = {
        "0": {
          json: {
            applications: [
              {
                slotIndex: slotIndex,
                modifierKey: modifierKey
              }
            ]
          }
        }
      };

      await this.makeRequest(ENDPOINTS.APPLY_MOD, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(newPayload),
      });
      
    } catch (error) {
      // Fallback to old format
      try {
        const oldPayload = {
          "0": {
            json: {
              slotIndex: slotIndex,
              modifierKey: modifierKey
            }
          }
        };

        await this.makeRequest(ENDPOINTS.APPLY_MOD, {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify(oldPayload),
        });
        
      } catch (fallbackError) {
        throw new Error(`All booster formats failed: ${error.message}`);
      }
    }
  }
}


/* =========================
    FARM MANAGER
   ========================= */
class FarmManager {
  constructor(apiClient) {
    this.api = apiClient;
  }

  async harvestReadyCrops(state, accountIndex, display) {
    let hasHarvested = false;

    while (true) {
      const readyPlots = (state.plots || [])
        .filter(plot => plot.seed && GameUtils.isReady(plot.seed))
        .sort((a, b) => a.slotIndex - b.slotIndex);

      if (!readyPlots.length) break;

      const slots = readyPlots.map(plot => plot.slotIndex);
      const crops = readyPlots.map(plot => plot.seed.key);

      display.updateAccount(
        accountIndex,
        state,
        `Harvesting ${GameUtils.formatItemCounts(crops)} from slots [${slots.join(",")}]`
      );

      await this.api.harvestSlots(slots);
      hasHarvested = true;

      state = await GameUtils.refreshStateUntil(
        this.api,
        newState =>
          slots.every(slotIndex =>
            (newState.plots || []).find(plot => plot.slotIndex === slotIndex)?.seed == null
          ),
        CONFIG.postHarvestPoll
      );
    }

    return { state, hasHarvested };
  }

  hasBudgetForAllRoyal(state, emptySlots) {
    const targetSlots = (emptySlots || []).length;
    if (targetSlots === 0) return false;

    const ap = state.ap || 0;
    const haveRoyalSeeds = GameUtils.countItems(state.items, "royal-apple");
    const haveBoosters = GameUtils.countItems(state.items, CONFIG.boosterKey, "MODIFIER");

    const needRoyal = Math.max(0, targetSlots - haveRoyalSeeds);
    const needBooster = Math.max(0, targetSlots - haveBoosters);

    const apNeeded =
      needRoyal * (CONFIG.seedCostAP["royal-apple"] || 0) +
      needBooster * (CONFIG.boosterCostAP || 0);

    return ap >= apNeeded + (CONFIG.apFloor || 0);
  }

  buildPlantingPlan(state, emptySlots) {
    const coins = state.coins || 0;
    const ap = state.ap || 0;
    const totalPlots = state.numPlots ?? (state.plots?.length || 0);
    const nextPlotPrice = state.nextPlotPrice;

    const currentWheat        = GameUtils.countItems(state.items, "wheat");
    const currentGoldenApple  = GameUtils.countItems(state.items, "golden-apple");
    const currentRoyalApple   = GameUtils.countItems(state.items, "royal-apple");

    const buyableWheat  = Math.floor(coins / (CONFIG.seedCostCoins.wheat || Infinity));
    const buyableGolden = Math.floor(ap    / (CONFIG.seedCostAP["golden-apple"] || Infinity));
    const buyableRoyal  = Math.floor(ap    / (CONFIG.seedCostAP["royal-apple"]  || Infinity));

    let maxWheat  = currentWheat        + (isFinite(buyableWheat)  ? buyableWheat  : 0);
    let maxGolden = currentGoldenApple  + (isFinite(buyableGolden) ? buyableGolden : 0);
    let maxRoyal  = currentRoyalApple   + (isFinite(buyableRoyal)  ? buyableRoyal  : 0);

    // 12+ plots: Royal-all jika mampu, else Golden > Royal > Wheat
    if (totalPlots >= 12) {
      if (this.hasBudgetForAllRoyal(state, emptySlots)) {
        return emptySlots.map(slot => ({ slot, key: "royal-apple" }));
      }

      const plan = [];
      for (const slot of emptySlots) {
        if (maxGolden > 0) { 
          plan.push({ slot, key: "golden-apple" }); 
          maxGolden--; 
        } else if (maxRoyal > 0) { 
          plan.push({ slot, key: "royal-apple" }); 
          maxRoyal--; 
        } else if (maxWheat > 0) { 
          plan.push({ slot, key: "wheat" }); 
          maxWheat--; 
        } else { 
          plan.push({ slot, key: "golden-apple" }); 
        }
      }
      return plan;
    }

    // <12 plots — Fokus resource sesuai currency next plot
    const currency = (nextPlotPrice?.currency || "").toString().toLowerCase();
    const plan = [];

    for (const slot of emptySlots) {
      if (currency === "ap") {
        // Fokus AP → tanam GA (fallback wheat)
        if (maxGolden > 0) {
          plan.push({ slot, key: "golden-apple" });
          maxGolden--;
        } else if (maxWheat > 0) {
          plan.push({ slot, key: "wheat" });
          maxWheat--;
        } else if (maxRoyal > 0) {
          // optional: jika ingin menyalurkan AP berlebih ke royal pada <12 plot
          plan.push({ slot, key: "royal-apple" });
          maxRoyal--;
        } else {
          break;
        }
      } else if (currency === "coins") {
        // Fokus coins → tanam wheat (fallback GA)
        if (maxWheat > 0) {
          plan.push({ slot, key: "wheat" });
          maxWheat--;
        } else if (maxGolden > 0) {
          plan.push({ slot, key: "golden-apple" });
          maxGolden--;
        } else if (maxRoyal > 0) {
          plan.push({ slot, key: "royal-apple" });
          maxRoyal--;
        } else {
          break;
        }
      } else {
        // currency tidak diketahui → default wheat
        if (maxWheat > 0) {
          plan.push({ slot, key: "wheat" });
          maxWheat--;
        } else if (maxGolden > 0) {
          plan.push({ slot, key: "golden-apple" });
          maxGolden--;
        } else if (maxRoyal > 0) {
          plan.push({ slot, key: "royal-apple" });
          maxRoyal--;
        } else {
          break;
        }
      }
    }

    return plan;
  }

  canAffordPlot(state) {
    const price = state?.nextPlotPrice;
    if (!price || typeof price.amount !== "number" || !price.currency) {
      return { canAfford: false, reason: "no-price" };
    }

    const totalPlots = state.numPlots ?? (state.plots?.length || 0);
    const currentWheat = GameUtils.countItems(state.items, "wheat");
    const currentGoldenApple = GameUtils.countItems(state.items, "golden-apple");
    const ownedSeeds = currentWheat + currentGoldenApple;

    const seedsNeeded = Math.max(0, totalPlots - ownedSeeds);
    const seedsWithMargin = Math.ceil(seedsNeeded * CONFIG.safetyMargin);

    let remainingCoins = state.coins || 0;
    let remainingAP = state.ap || 0;

    if (String(price.currency).toLowerCase() === "coins") {
      remainingCoins -= price.amount;
    } else {
      remainingAP -= price.amount;
    }

    if (remainingCoins < 0 || remainingAP < 0) {
      return {
        canAfford: false,
        reason: "insufficient-funds",
        remainingCoins,
        remainingAP,
        seedsNeeded: seedsWithMargin,
        buyableSeeds: 0,
      };
    }

    const wheatCost = CONFIG.seedCostCoins.wheat || Infinity;
    const goldenAppleCost = CONFIG.seedCostAP["golden-apple"] || Infinity;

    const buyableWheatSeeds  = Math.floor(remainingCoins / wheatCost);
    const buyableGoldenSeeds = Math.floor(remainingAP   / goldenAppleCost);

    const totalBuyableSeeds =
      (isFinite(buyableWheatSeeds)  ? buyableWheatSeeds  : 0) +
      (isFinite(buyableGoldenSeeds) ? buyableGoldenSeeds : 0);

    return {
      canAfford: totalBuyableSeeds >= seedsWithMargin,
      currency: String(price.currency),
      amount: price.amount,
      remainingCoins,
      remainingAP,
      seedsNeeded: seedsWithMargin,
      buyableSeeds: totalBuyableSeeds,
    };
  }

  async autoBuyPlots(state, accountIndex, display) {
    while (state.nextPlotPrice) {
      const affordabilityCheck = this.canAffordPlot(state);

      if (!affordabilityCheck.canAfford) break;

      display.updateAccount(
        accountIndex,
        state,
        `Buying Plot (${affordabilityCheck.currency} ${affordabilityCheck.amount})`
      );

      try {
        await this.api.buyPlot();
        state = await this.api.getState();
        display.updateAccount(accountIndex, state, `Plot purchased successfully!`);
      } catch {
        display.updateAccount(accountIndex, state, `Plot purchase failed`);
        break;
      }
    }
    return state;
  }

  async applyBoosters(state, accountIndex, display) {
    const needsBooster = (state.plots || [])
      .filter(plot => !plot.modifier || GameUtils.isExpired(plot.modifier))
      .map(plot => plot.slotIndex)
      .sort((a, b) => a - b);

    if (!needsBooster.length) return state;

    const currentBoosters = GameUtils.countItems(state.items, CONFIG.boosterKey, "MODIFIER");
    const needToBuy = Math.max(0, needsBooster.length - currentBoosters);

    const reservedAP = this.calculateReservedAP(state);
    const availableAP = Math.max(0, (state.ap || 0) - reservedAP - (CONFIG.apFloor || 0));
    const canBuy = Math.min(needToBuy, Math.floor(availableAP / (CONFIG.boosterCostAP || 175)));

    if (canBuy > 0) {
      display.updateAccount(accountIndex, state, `Buying boosters (${canBuy}x)`);
      try {
        const purchases = Array.from({ length: canBuy }, () => ({
          key: CONFIG.boosterKey,
          type: "MODIFIER",
          quantity: 1,
        }));
        await this.api.buyItems(purchases);
        state = await this.api.getState();
        display.updateAccount(accountIndex, state, `Boosters purchased successfully`);
      } catch (buyError) {
        display.updateAccount(accountIndex, state, `Failed to buy boosters`);
      }
    }

    const finalBoosters = GameUtils.countItems(state.items, CONFIG.boosterKey, "MODIFIER");
    const slotsToBoost = needsBooster.slice(0, finalBoosters);

    if (slotsToBoost.length > 0) {
      display.updateAccount(
        accountIndex,
        state,
        `Applying boosters to ${slotsToBoost.length} slots [${slotsToBoost.join(",")}]`
      );

      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < slotsToBoost.length; i++) {
        const targetSlot = slotsToBoost[i];

        display.updateAccount(
          accountIndex,
          state,
          `Applying booster to slot ${targetSlot} (${i + 1}/${slotsToBoost.length})`
        );

        try {
          const preState = await this.api.getState();
          const targetPlot = preState.plots?.find(p => p.slotIndex === targetSlot);

          if (targetPlot?.modifier && !GameUtils.isExpired(targetPlot.modifier)) {
            continue;
          }

          const currentBoosterCount = GameUtils.countItems(
            preState.items,
            CONFIG.boosterKey,
            "MODIFIER"
          );
          if (currentBoosterCount <= 0) break;

          await this.api.applyModifier(targetSlot, CONFIG.boosterKey);

          await GameUtils.sleep(500);
          const postState = await this.api.getState();
          const verifyPlot = postState.plots?.find(p => p.slotIndex === targetSlot);

          if (verifyPlot?.modifier?.key === CONFIG.boosterKey) {
            successCount++;
          } else {
            failCount++;
          }

          await GameUtils.sleep(CONFIG.perRequestDelayMs || 120);
        } catch (boosterError) {
          failCount++;
          await GameUtils.sleep(500);
        }
      }

      if (failCount === 0 && successCount > 0) {
        display.updateAccount(accountIndex, state, `Boosters applied successfully: ${successCount} applied`);
      } else if (successCount > 0 && failCount > 0) {
        display.updateAccount(accountIndex, state, `Boosters partial success: ${successCount} applied, ${failCount} failed`);
      } else if (failCount > 0) {
        display.updateAccount(accountIndex, state, `Booster application failed: no boosters applied`);
      }

      if (successCount > 0) {
        try {
          state = await this.api.getState();
        } catch (stateError) {
          display.updateAccount(accountIndex, state, `Warning: Failed to refresh state after boosters`);
        }
      }
    }

    return state;
  }

  // Reserved AP agar GA tetap kebeli saat perlu (dipakai untuk booster logic)
  calculateReservedAP(state) {
    const totalPlots = state.numPlots ?? (state.plots?.length || 0);
    const nextPlotPrice = state.nextPlotPrice;
    const emptySlots = (state.plots || [])
      .filter(plot => !plot.seed)
      .map(plot => plot.slotIndex);

    if (!emptySlots.length) return 0;

    let targetGASlots = [];
    if (totalPlots >= 12) {
      targetGASlots = emptySlots;
    } else {
      const preferences = GameUtils.getDesiredPlantingMap(totalPlots, nextPlotPrice);
      targetGASlots = emptySlots.filter(slot => preferences.get(slot) === "golden-apple");
    }

    const currentGoldenSeeds = GameUtils.countItems(state.items, "golden-apple");
    const needToBuy = Math.max(0, targetGASlots.length - currentGoldenSeeds);
    return needToBuy * (CONFIG.seedCostAP["golden-apple"] || 0);
  }

  // Final plan penanaman (fix cabang 12+ pakai 'seeds')
  createFinalPlantingPlan(state, emptySlots, availableSeeds) {
    const totalPlots = state.numPlots ?? (state.plots?.length || 0);
    const nextPlotPrice = state.nextPlotPrice;
    const plan = [];
    const seeds = { wheat: 0, "golden-apple": 0, "royal-apple": 0, ...(availableSeeds || {}) };

    if (totalPlots >= 12) {
      for (const slot of emptySlots) {
        if (seeds["royal-apple"] > 0) {
          plan.push({ slot, key: "royal-apple" });
          seeds["royal-apple"]--;
        } else if (seeds["golden-apple"] > 0) {
          plan.push({ slot, key: "golden-apple" });
          seeds["golden-apple"]--;
        } else if (seeds["wheat"] > 0) {
          plan.push({ slot, key: "wheat" });
          seeds["wheat"]--;
        }
      }
      return plan;
    }

    // <12 plots: pakai preferensi lama untuk fallback stok (tidak mengubah fokus utama)
    const preferences = GameUtils.getDesiredPlantingMap(totalPlots, nextPlotPrice);
    for (const slot of emptySlots) {
      const preferredKey = preferences.get(slot) || "wheat";

      const take = (k) => {
        if (seeds[k] > 0) { seeds[k]--; plan.push({ slot, key: k }); return true; }
        return false;
      };

      if (!take(preferredKey)) {
        if (!take("royal-apple")) {
          if (!take("golden-apple")) {
            take("wheat");
          }
        }
      }
    }
    return plan;
  }
}

/* =========================
    STATE CHECKER (fixed boosters + focus strategy info)
   ========================= */
class StateChecker {
  constructor(farmManager, apiClient) {
    this.farmManager = farmManager;
    this.api = apiClient;
  }

  analyzeState(state) {
    const analysis = {
      // basic
      totalPlots: state.numPlots ?? (state.plots?.length || 0),
      ap: state.ap || 0,
      coins: state.coins || 0,

      // flags
      needsHarvest: false,
      needsClaim: false,
      needsBuyPlot: false,
      needsBuySeeds: false,
      needsBuyBoosters: false,
      needsApplyBoosters: false,
      needsPlanting: false,

      // details
      harvestableSlots: [],
      emptySlots: [],
      boosterSlots: [],
      seedRequirements: { wheat: 0, "golden-apple": 0, "royal-apple": 0 },
      availableSeeds: { wheat: 0, "golden-apple": 0, "royal-apple": 0 },
      availableBoosters: 0,

      // budgets
      availableAP: 0,
      reservedAP: 0,

      // boosters (computed buy count)
      boosterBuyCount: 0,

      // focus (informational only)
      focusCurrency: (state.nextPlotPrice?.currency || "").toString().toLowerCase(),

      // scheduling
      nextAction: "wait",
      priority: 0,

      // debug
      debugInfo: {}
    };

    this.checkHarvestConditions(state, analysis);
    this.checkClaimConditions(state, analysis);
    this.checkPlotPurchaseConditions(state, analysis);
    this.checkSeedRequirements(state, analysis);
    this.checkBoosterConditions(state, analysis);
    this.checkPlantingConditions(state, analysis);
    this.calculateAPBudget(state, analysis);
    this.determinePriority(analysis);

    return analysis;
  }

  /* ---------- harvest ---------- */
  checkHarvestConditions(state, analysis) {
    const ready = (state.plots || [])
      .filter(p => p.seed && GameUtils.isReady(p.seed))
      .map(p => ({ slotIndex: p.slotIndex, seedKey: p.seed.key, readyTime: p.seed.endsAt }));

    if (ready.length > 0) {
      analysis.needsHarvest = true;
      analysis.harvestableSlots = ready;
      analysis.nextAction = "harvest";
      analysis.priority = 1;
      analysis.debugInfo.harvest = `${ready.length} slots ready`;
    }
  }

  /* ---------- claim ---------- */
  checkClaimConditions(state, analysis) {
    const last = new Date(state.lastFarmhouseAt || 0).getTime();
    if (!last || last + 86_400_000 <= Date.now()) {
      analysis.needsClaim = true;
      if (analysis.priority > 1) {
        analysis.nextAction = "claim";
        analysis.priority = 1;
      }
      analysis.debugInfo.claim = "Daily rewards available";
    }
  }

  /* ---------- buy plot ---------- */
  checkPlotPurchaseConditions(state, analysis) {
    if (!state.nextPlotPrice) return;
    const affordability = this.farmManager.canAffordPlot(state);
    if (affordability.canAfford) {
      analysis.needsBuyPlot = true;
      if (analysis.priority > 1) {
        analysis.nextAction = "buyPlot";
        analysis.priority = 1;
      }
      analysis.debugInfo.plot =
        `Can afford plot for ${affordability.amount} ${affordability.currency}`;
    } else {
      analysis.debugInfo.plot = `Cannot afford plot: ${affordability.reason}`;
    }
  }

  /* ---------- seeds / planting strategy ---------- */
  checkSeedRequirements(state, analysis) {
    analysis.emptySlots = (state.plots || [])
      .filter(p => !p.seed)
      .map(p => p.slotIndex)
      .sort((a, b) => a - b);

    if (analysis.emptySlots.length === 0) return;

    // current inventory
    analysis.availableSeeds = {
      wheat: GameUtils.countItems(state.items, "wheat"),
      "golden-apple": GameUtils.countItems(state.items, "golden-apple"),
      "royal-apple": GameUtils.countItems(state.items, "royal-apple"),
    };

    // desired plan (FarmManager already encodes “focus AP when plot uses AP, focus coins when plot uses coins”)
    const plan = this.farmManager.buildPlantingPlan(state, analysis.emptySlots);
    plan.forEach(p => analysis.seedRequirements[p.key]++);

    // strategy string (for UI only)
    const currency = analysis.focusCurrency;
    const n = analysis.totalPlots;
    let strategy;
    if (n === 1) strategy = "1 plot → 100% wheat";
    else if (n === 2) strategy = "2 plots → 50% wheat / 50% golden";
    else if (n < 12) {
      strategy = currency === "ap"
        ? `${n} plots → focus AP (golden)`
        : currency === "coins"
          ? `${n} plots → focus coins (wheat)`
          : `${n} plots → balanced`;
    } else {
      strategy = "12+ plots → golden/royal priority";
    }
    analysis.debugInfo.strategy = strategy;

    // detect shortage → buy seeds
    for (const k of Object.keys(analysis.seedRequirements)) {
      const need = analysis.seedRequirements[k];
      const have = analysis.availableSeeds[k];
      if (need > have) {
        analysis.needsBuySeeds = true;
        if (analysis.priority > 2) {
          analysis.nextAction = "buySeeds";
          analysis.priority = 2;
        }
        (analysis.debugInfo.seeds ||= {})[k] = `Need ${need}, have ${have}`;
      }
    }
  }

  /* ---------- boosters ---------- */
  checkBoosterConditions(state, analysis) {
    const needBoost = (state.plots || [])
      .filter(p => !p.modifier || GameUtils.isExpired(p.modifier))
      .map(p => p.slotIndex)
      .sort((a, b) => a - b);

    analysis.boosterSlots = needBoost;
    analysis.availableBoosters = GameUtils.countItems(state.items, CONFIG.boosterKey, "MODIFIER");

    if (needBoost.length === 0) return;

    // Decide if we should buy boosters and how many
    const costPer = CONFIG.boosterCostAP || 175;
    const baseAP = analysis.ap || 0;
    const reservedAP = this.farmManager.calculateReservedAP(state);
    const apFloor = CONFIG.apFloor || 0;

    // By default we ignore reserved AP when buying boosters (more aggressive) unless explicitly false
    const ignoreReserved = CONFIG.boosterIgnoreReservedAP !== false;
    const apForBooster = Math.max(0, (ignoreReserved ? baseAP : baseAP - reservedAP) - apFloor);
    const canBuyByAP = Math.floor(apForBooster / costPer);

    const needToBuy = Math.max(0, needBoost.length - analysis.availableBoosters);
    const buyCount = Math.min(needToBuy, canBuyByAP);

    analysis.boosterBuyCount = buyCount;

    if (buyCount > 0) {
      analysis.needsBuyBoosters = true;
      if (analysis.priority > 2) {
        analysis.nextAction = "buyBoosters";
        analysis.priority = 2;
      }
      analysis.debugInfo.boosters = `Buy ${buyCount}/${needToBuy} (AP budget ${apForBooster})`;
    } else {
      analysis.debugInfo.boosters = `No buy (need ${needToBuy}, AP budget ${apForBooster})`;
    }

    // Apply if we already have boosters
    if (analysis.availableBoosters > 0) {
      analysis.needsApplyBoosters = true;
      if (analysis.priority > 2) {
        analysis.nextAction = "applyBoosters";
        analysis.priority = 2;
      }
      analysis.debugInfo.boosterApplication =
        `${analysis.availableBoosters} boosters available for ${needBoost.length} slots`;
    }
  }

  /* ---------- planting ---------- */
  checkPlantingConditions(state, analysis) {
    if (analysis.emptySlots.length === 0) return;

    const totalAvail =
      Object.values(analysis.availableSeeds).reduce((a, b) => a + b, 0);

    if (totalAvail > 0) {
      analysis.needsPlanting = true;
      if (analysis.priority > 3) {
        analysis.nextAction = "plant";
        analysis.priority = 3;
      }
      analysis.debugInfo.planting =
        `${analysis.emptySlots.length} empty slots, ${totalAvail} seeds available`;
    } else {
      analysis.debugInfo.planting =
        `${analysis.emptySlots.length} empty slots but no seeds available`;
    }
  }

  /* ---------- AP budget snapshot ---------- */
  calculateAPBudget(state, analysis) {
    analysis.reservedAP = this.farmManager.calculateReservedAP(state);
    analysis.availableAP = Math.max(
      0,
      (analysis.ap || 0) - analysis.reservedAP - (CONFIG.apFloor || 0)
    );

    analysis.debugInfo.apBudget = {
      total: analysis.ap,
      reserved: analysis.reservedAP,
      floor: CONFIG.apFloor || 0,
      available: analysis.availableAP
    };
  }

  /* ---------- priority order ---------- */
  determinePriority(a) {
    if (a.needsBuyPlot) {
      a.nextAction = "buyPlot"; a.priority = 1;
    } else if (a.needsHarvest) {
      a.nextAction = "plant"; a.priority = 1;
    } else if (a.needsClaim) {
      a.nextAction = "claim"; a.priority = 1;
    } else if (a.needsBuySeeds && a.needsPlanting) {
      a.nextAction = "buySeeds"; a.priority = 2;
    } else if (a.needsBuyBoosters) {
      a.nextAction = "buyBoosters"; a.priority = 2;
    } else if (a.needsApplyBoosters) {
      a.nextAction = "applyBoosters"; a.priority = 2;
    } else if (a.needsPlanting) {
      a.nextAction = "harvest"; a.priority = 3;
    } else {
      a.nextAction = "wait"; a.priority = 4;
    }
  }

  /* ---------- UI status ---------- */
  generateStatus(a) {
    const withStrategy = (t) =>
      a.debugInfo?.strategy ? `${t} (${a.debugInfo.strategy})` : t;

    switch (a.nextAction) {
      case "harvest":
        return `Ready to harvest ${a.harvestableSlots.length} crops`;
      case "claim":
        return `Daily rewards available`;
      case "buySeeds": {
        const s = Object.keys(a.debugInfo.seeds || {});
        if (s.length === 1) {
          const k = s[0];
          const shortage = a.seedRequirements[k] - a.availableSeeds[k];
          return withStrategy(`Need ${shortage}x ${k} seeds`);
        }
        return withStrategy(`Need seeds: ${s.join(", ")}`);
      }
      case "buyBoosters":
        return `Need ${a.boosterBuyCount} boosters`;
      case "applyBoosters":
        return `Boosting ${a.boosterSlots.length} slots`;
      case "plant":
        return withStrategy(`Planting ${a.emptySlots.length} slots`);
      case "buyPlot": {
        const info = a.debugInfo.plot || "";
        const m = info.match(/(\d+)\s+(\w+)/);
        return m ? `Buying plot (${m[1]} ${m[2]})` : `Buying new plot`;
      }
      case "wait":
        return "Waiting for next action";
      default:
        return a.nextAction || "Checking account";
    }
  }
}

/* =========================
    AUTOMATED WORKER
   ========================= */
async function smartDelayAutomatedWorker(accountIndex, cookie, display) {
  const apiClient = new ApiClient(cookie, accountIndex);
  const farmManager = new FarmManager(apiClient);
  const stateChecker = new StateChecker(farmManager, apiClient);

  let consecutiveNoActions = 0;

  while (true) {
    try {
      // Ambil state awal
      let state = await apiClient.getState();
      const analysis = stateChecker.analyzeState(state);

      let immediateAction = false;

      //️ BUY PLOT (prioritas tertinggi)
      if (analysis.needsBuyPlot) {
        const aff = farmManager.canAffordPlot(state);
        if (aff.canAfford) {
          display.updateAccount(accountIndex, state, `Buying plot (${aff.amount} ${aff.currency})`);
          try {
            await apiClient.buyPlot();
            state = await apiClient.getState();
            display.updateAccount(accountIndex, state, `Plot purchased successfully`);
            immediateAction = true;
            consecutiveNoActions = 0;
            continue;
          } catch (e) {
            display.updateAccount(accountIndex, state, `Plot purchase failed: ${String(e.message || e).split(':')[0]}`);
          }
        }
      }
      
      // PLANT
      if (analysis.needsPlanting) {
        const seeds = {
          wheat: GameUtils.countItems(state.items, "wheat"),
          "golden-apple": GameUtils.countItems(state.items, "golden-apple"),
          "royal-apple": GameUtils.countItems(state.items, "royal-apple"),
        };
        const plan = farmManager.createFinalPlantingPlan(state, analysis.emptySlots, seeds);
        if (plan.length > 0) {
          const groups = plan.reduce((g, p) => { (g[p.key] ||= []).push(p.slot); return g; }, {});
          for (const [seedType, slots] of Object.entries(groups)) {
            if (!slots.length) continue;
            display.updateAccount(accountIndex, state, `Planting ${seedType} in ${slots.length} slots`);
            let success = 0;
            for (const s of slots) {
              try {
                const current = await apiClient.getState();
                const tgt = current.plots?.find(x => x.slotIndex === s);
                if (tgt?.seed) continue;
                await apiClient.plantSeed(s, seedType);
                success++;
                await GameUtils.sleep(150);
              } catch {}
            }
            if (success > 0) {
              state = await apiClient.getState();
              display.updateAccount(accountIndex, state, `Planted ${success}x ${seedType} successfully`);
              immediateAction = true;
              consecutiveNoActions = 0;
              break;
            }
          }
          if (immediateAction) continue;
        }
      }

      // DAILY CLAIM
      if (analysis.needsClaim) {
        display.updateAccount(accountIndex, state, `Claiming daily rewards now`);
        try {
          const before = new Date(state?.lastFarmhouseAt || 0).getTime() || 0;
          await apiClient.claimFarmhouse();

          const verifiedState = await GameUtils.refreshStateUntil(
            apiClient,
            s => (new Date(s?.lastFarmhouseAt || 0).getTime() || 0) > before,
            { tries: 6, delayMs: 700 }
          );

          const after = new Date(verifiedState?.lastFarmhouseAt || 0).getTime() || 0;
          if (after > before) {
            state = verifiedState;
            display.updateAccount(accountIndex, state, `Daily rewards claimed successfully`);
          } else {
            display.updateAccount(accountIndex, state, `Claim sent (not confirmed) — continuing`);
            state = await apiClient.getState();
          }

          immediateAction = true;
          consecutiveNoActions = 0;
          continue;
        } catch (e) {
          display.updateAccount(accountIndex, state, `Claim failed: ${String(e.message || e).split(':')[0]}`);
        }
      }

      // BUY SEEDS (prioritas: royal > golden > wheat)
      if (analysis.needsBuySeeds) {
        const order = ["royal-apple", "golden-apple", "wheat"].filter(
          k => (analysis.seedRequirements[k] || 0) > (analysis.availableSeeds[k] || 0)
        );

        let changed = false;

        for (const seedType of order) {
          const needed = (analysis.seedRequirements[seedType] || 0) - (analysis.availableSeeds[seedType] || 0);
          if (needed <= 0) continue;

          const cost = seedType === "wheat"
            ? (CONFIG.seedCostCoins.wheat || Infinity)
            : (CONFIG.seedCostAP[seedType] || Infinity);

          // Gunakan AP total (sisakan apFloor), tidak dikurangi reservedAP (lebih agresif)
          const apForSeeds = Math.max(0, (analysis.ap || 0) - (CONFIG.apFloor || 0));
          const budget = seedType === "wheat" ? (analysis.coins || 0) : apForSeeds;

          const canBuy = Math.min(needed, Math.floor(budget / cost));
          if (canBuy <= 0) continue;

          display.updateAccount(accountIndex, state, `Buying ${canBuy}x ${seedType} seeds`);
          try {
            const purchases = Array.from({ length: canBuy }, () => ({
              key: seedType,
              type: "SEED",
              quantity: 1
            }));
            await apiClient.buyItems(purchases);
            state = await apiClient.getState();
            display.updateAccount(accountIndex, state, `Bought ${canBuy}x ${seedType} seeds successfully`);

            // Update stok lokal agar rencana tanam setelahnya akurat
            analysis.availableSeeds[seedType] = (analysis.availableSeeds[seedType] || 0) + canBuy;
            changed = true;
          } catch (e) {
            display.updateAccount(accountIndex, state, `Buy ${seedType} failed: ${String(e.message || e).split(':')[0]}`);
          }
        }

        if (changed) {
          immediateAction = true;
          consecutiveNoActions = 0;
          continue; // lanjut ke siklus berikutnya untuk tanam
        }
      }

      // BUY BOOSTERS (PARCIAL, hormati config boosterIgnoreReservedAP)
      if (analysis.needsBuyBoosters) {
        const costPer = CONFIG.boosterCostAP || 175;

        // Ambil jumlah dari checker bila ada (sudah parsial):
        let buyCount = Math.max(0, analysis.boosterBuyCount || 0);

        // Fallback hitung di sini jika checker lama
        if (buyCount === 0) {
          const baseAP = analysis.ap || 0;
          const reservedAP = farmManager.calculateReservedAP(state);
          const apFloor = CONFIG.apFloor || 0;

          const apForBooster = Math.max(
            0,
            (CONFIG.boosterIgnoreReservedAP !== false ? baseAP : baseAP - reservedAP) - apFloor
          );
          buyCount = Math.floor(apForBooster / costPer);
        }

        if (buyCount > 0) {
          display.updateAccount(accountIndex, state, `Buying ${buyCount} boosters`);
          try {
            const purchases = Array.from({ length: buyCount }, () => ({
              key: CONFIG.boosterKey,
              type: "MODIFIER",
              quantity: 1
            }));
            await apiClient.buyItems(purchases);
            state = await apiClient.getState();
            display.updateAccount(accountIndex, state, `Bought ${buyCount} boosters successfully`);
            immediateAction = true;
            consecutiveNoActions = 0;
            continue; // biarkan loop berikutnya meng-apply
          } catch (e) {
            display.updateAccount(accountIndex, state, `Buy boosters failed: ${String(e.message || e).split(':')[0]}`);
          }
        } else {
          display.updateAccount(accountIndex, state, `Skip buying boosters (insufficient AP after floor/reserve)`);
        }
      }

      // APPLY BOOSTERS (jalankan jika stok > 0)
      if (analysis.needsApplyBoosters) {
        const have = GameUtils.countItems(state.items, CONFIG.boosterKey, "MODIFIER");
        const slots = analysis.boosterSlots.slice(0, have);
        if (slots.length > 0) {
          display.updateAccount(accountIndex, state, `Applying boosters to ${slots.length} slots`);
          let success = 0;
          for (const s of slots) {
            try {
              const current = await apiClient.getState();
              const p = current.plots?.find(x => x.slotIndex === s);
              if (p?.modifier && !GameUtils.isExpired(p.modifier)) continue;
              await apiClient.applyModifier(s, CONFIG.boosterKey);
              success++;
              await GameUtils.sleep(200);
            } catch {}
          }
          if (success > 0) {
            state = await apiClient.getState();
            display.updateAccount(accountIndex, state, `Applied ${success} boosters successfully`);
            immediateAction = true;
            consecutiveNoActions = 0;
            continue;
          }
        }
      }

      // HARVEST
      if (analysis.needsHarvest) {
        const slots = analysis.harvestableSlots.map(h => h.slotIndex);
        display.updateAccount(accountIndex, state, `Harvesting ${slots.length} crops now`);
        try {
          await apiClient.harvestSlots(slots);
          state = await GameUtils.refreshStateUntil(
            apiClient,
            s => slots.every(i => (s.plots || []).find(p => p.slotIndex === i)?.seed == null),
            { tries: 3, delayMs: 200 }
          );
          display.updateAccount(accountIndex, state, `Harvested ${slots.length} crops - checking for replant`);
          immediateAction = true;
          consecutiveNoActions = 0;
          continue;
        } catch (e) {
          display.updateAccount(accountIndex, state, `Harvest failed: ${String(e.message || e).split(':')[0]}`);
        }
      }

      // ========== IDLE / WAIT ==========
      if (!immediateAction) {
        consecutiveNoActions++;

        const nextEvent = SmartDelayCalculator.getDetailedNextAction(state);
        let remainingTimeMs;

        if (nextEvent) {
          remainingTimeMs = nextEvent.bufferedDelay;
          display.updateAccount(accountIndex, state, SmartDelayCalculator.generateBufferStatus(nextEvent));
        } else {
          remainingTimeMs = 60000;
          display.updateAccount(accountIndex, state, "No events scheduled, polling in 1 minute");
        }

        if (consecutiveNoActions > 10) {
          remainingTimeMs = 60000; // force 1 menit
          display.updateAccount(accountIndex, state, `Force polling after ${consecutiveNoActions} cycles`);
          consecutiveNoActions = 0;
        }

        // Periodik refresh state saat menunggu
        const REFRESH_EVERY_MS = CONFIG.idleRefreshMs;
        let sinceRefresh = 0;

        while (remainingTimeMs > 0) {
          await GameUtils.sleep(1000);
          remainingTimeMs -= 1000;
          sinceRefresh += 1000;

          // Update countdown tiap ~5 detik
          if (nextEvent && remainingTimeMs % 5000 < 1000) {
            const t = GameUtils.formatTime(remainingTimeMs);
            const actual = GameUtils.formatTime(remainingTimeMs + nextEvent.buffer);
            const status = CONFIG.showBufferInfo
              ? (nextEvent.type === "harvest"
                  ? `Harvest ${nextEvent.seedKey} in ${t} (actual: ${actual})`
                  : nextEvent.type === "claim"
                    ? `Daily claim in ${t} (actual: ${actual})`
                    : `Next action in ${t} (actual: ${actual})`)
              : (nextEvent.type === "harvest"
                  ? `Harvest ${nextEvent.seedKey} in ${t}`
                  : nextEvent.type === "claim"
                    ? `Daily claim in ${t}`
                    : `Next action in ${t}`);
            display.updateAccount(accountIndex, state, status);
          }

          // Re-fetch untuk deteksi aksi baru
          if (sinceRefresh >= REFRESH_EVERY_MS) {
            sinceRefresh = 0;
            try {
              const fresh = await apiClient.getState();
              const freshAnalysis = stateChecker.analyzeState(fresh);
              if (
                freshAnalysis.needsHarvest ||
                freshAnalysis.needsClaim ||
                freshAnalysis.needsBuySeeds ||
                freshAnalysis.needsBuyBoosters ||
                freshAnalysis.needsApplyBoosters ||
                freshAnalysis.needsPlanting ||
                freshAnalysis.needsBuyPlot
              ) {
                state = fresh;
                display.updateAccount(accountIndex, state, `New action detected — rechecking now`);
                immediateAction = true;
                break;
              }
            } catch {
              // ignore fetch error while idle
            }
          }
        }

        if (immediateAction) continue;
      } else {
        consecutiveNoActions = 0;
      }

    } catch (error) {
      consecutiveNoActions++;
      if (
        String(error.message || "").includes('proxy') ||
        String(error.message || "").includes('ECONNREFUSED') ||
        String(error.message || "").includes('timeout')
      ) {
        display.updateAccount(accountIndex, { ap: "-", coins: "-", numPlots: "-" }, `Proxy error: ${String(error.message).split(":")[0]}`);
        if (CONFIG.proxy.enabled && CONFIG.proxy.rotateOnError && typeof proxyManager !== 'undefined') {
          proxyManager.rotateProxy();
          apiClient.proxy = proxyManager.getProxyForAccount(accountIndex);
        }
        await GameUtils.sleep(15000);
      } else {
        display.updateAccount(accountIndex, { ap: "-", coins: "-", numPlots: "-" }, `Error: ${String(error.message || error).split("\n")[0]}`);
        const wait = Math.min(30000, 5000 * consecutiveNoActions);
        await GameUtils.sleep(wait);
      }
    }
  }
}

/* =========================
    MAIN ENTRY POINT
   ========================= */
async function main() {
  console.log(`Initializing AppleVille Bot with Smart Buffer System...`);
  
  // Initialize proxy manager first
  await proxyManager.loadProxies();
  const display = new SimpleDisplay();
  
  try {
    const rawTokens = await fs.readFile("token.txt", "utf8");
    const cookies = rawTokens
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    if (!cookies.length) {
      console.error("❌ Error: token.txt is empty or not found!");
      process.exit(1);
    }

    console.log(`Found ${cookies.length} accounts`);
    console.log(`Proxy status: ${CONFIG.proxy.enabled ? `Enabled (${CONFIG.proxy.list.length} proxies)` : 'Disabled'}`);
    console.log(`Buffer system: ${CONFIG.showBufferInfo ? 'Enabled with details' : 'Enabled (simple)'}`);

    display.setTotalAccounts(cookies.length);

    // Start workers with smart buffer system
    const workers = cookies.map((cookie, index) => 
      smartDelayAutomatedWorker(index, cookie, display)
    );

    // Shutdown handlers
    const gracefulShutdown = () => {
      display.close();
      console.log("⚠️ Shutting down gracefully...");
      
      // Clear proxy agents on shutdown
      if (typeof proxyAgents !== 'undefined') {
        proxyAgents.clear();
      }
      
      process.exit(0);
    };

    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);

    process.on('uncaughtException', (error) => {
      display.close();
      console.error(`❌ Uncaught Exception: ${error.message}`);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      display.close();
      console.error(`❌ Unhandled Rejection: ${reason}`);
      process.exit(1);
    });

    await Promise.all(workers);

  } catch (error) {
    display.close();
    console.error(`❌ Fatal error: ${error.message}`);
    process.exit(1);
  }
}

/* =========================
    MODULE EXPORTS
   ========================= */
module.exports = {
  CONFIG,
  ProxyManager,
  GameUtils,
  SmartDelayCalculator,
  SimpleDisplay,
  ApiClient,
  FarmManager,
  StateChecker,
  smartDelayAutomatedWorker,
  main,
};

// Start the application
if (require.main === module) {
  main().catch(error => {
    console.error(`❌ Unhandled error: ${error.message}`);
    process.exit(1);
  });
}
