const crypto = require("crypto");
const axios = require("axios");
const https = require("https");
const http = require("http");
const fs = require("fs/promises");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { HttpProxyAgent } = require("http-proxy-agent");
const { URL } = require("url");

// Enhanced Configuration with Prestige Support and Flexible Plant Strategy
const HEADER_KEYS = {
  META_HASH: "x-xcsa3d",
  CLIENT_TIME: "x-dbsv",
  TRACE_ID: "x-dsa"
};

const CONFIG = {
  MINIMUM_RESERVES: {
    AP: 10,
    COINS: 5
  },
  HMAC: {
    SECRET: null,
    UNIT: "ms",
    SKEW_MS: 0
  },
  CAPTCHA: {
    enabled: true,
    service: "capmonster",
    apiKey: "b1a8194e01bed5af5a4762f1d865c2be",
    websiteURL: "https://app.appleville.xyz",
    websiteKey: "6LcRCKYrAAAAAEcLKaQ4Yk41S4lwpVd2a0YUTR94",
    maxRetries: 3,
    pollingInterval: 3000,
    timeoutSeconds: 300
  },
  ITEMS: {
    "wheat": { cost: 2, currency: "coins" },
    "golden-apple": { cost: 10, currency: "ap" },
    "royal-apple": { cost: 1500, currency: "ap" },
    "legacy-apple": { cost: 8, currency: "ap" },
    "apex-apple": { cost: 3000, currency: "ap" },
    "quantum-fertilizer": { cost: 175, currency: "ap" }
  },
  PRESTIGE: {
    LEVELS: {
      1: { required: 60000, multiplier: 1.2 },
      2: { required: 150000, multiplier: 1.4 },
      3: { required: 300000, multiplier: 1.5 },
      4: { required: 500000, multiplier: 1.6 },
      5: { required: 750000, multiplier: 1.8 },
      6: { required: 900000, multiplier: 1.9 },
      7: { required: 1000000, multiplier: 2.0 }
    },
    ENDPOINT: "https://app.appleville.xyz/api/trpc/prestige.performReset?batch=1",
    WAIT_AFTER_PRESTIGE: 30000 // 30 seconds
  },
  // NEW: Plant-first strategy configuration
  PLANT_STRATEGY: {
    // Enable buying boosters only after ensuring plant needs are met
    AUTO_BUY_BOOSTERS: true,
    // Always prioritize plants over boosters in AP allocation
    PLANTS_FIRST_PRIORITY: true
  },
  API: {
    GET_STATE: "https://app.appleville.xyz/api/trpc/core.getState,auth.me?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%2C%22meta%22%3A%7B%22values%22%3A%5B%22undefined%22%5D%7D%7D%2C%221%22%3A%7B%22json%22%3Anull%2C%22meta%22%3A%7B%22values%22%3A%5B%22undefined%22%5D%7D%7D%7D",
    CLAIM_FARMHOUSE: "https://app.appleville.xyz/api/trpc/core.collectFarmhouse?batch=1",
    BUY_ITEM: "https://app.appleville.xyz/api/trpc/core.buyItem?batch=1",
    BUY_PLOT: "https://app.appleville.xyz/api/trpc/core.buyPlot?batch=1",
    HARVEST: "https://app.appleville.xyz/api/trpc/core.harvest?batch=1",
    PLANT_SEED: "https://app.appleville.xyz/api/trpc/core.plantSeed?batch=1",
    APPLY_MODIFIER: "https://app.appleville.xyz/api/trpc/core.applyModifier?batch=1",
    VERIFY_CAPTCHA: "https://app.appleville.xyz/api/trpc/auth.verifyCaptcha?batch=1"
  }
};

// Utility Functions
function buildSecret() {
  const parts = ["bbsds!eda", "2", "3ed2@#@!@#Ffdf#@!", "4"];
  const pattern = [2, 1, 0, 2, 1, 2];
  return pattern.map(i => parts[i]).join("");
}

function generateNonce() {
  return crypto.randomBytes(16).toString("hex");
}

function createSignature(secret, message) {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

function createAuthHeaders(operationInput) {
  const timestamp = Date.now();
  const nonce = generateNonce();
  const inputString = JSON.stringify(operationInput ?? null);
  const raw = `${timestamp}.${nonce}.${inputString}`;

  const secret = buildSecret();
  const signature = createSignature(secret, raw);

  return {
    [HEADER_KEYS.META_HASH]: signature,
    [HEADER_KEYS.CLIENT_TIME]: timestamp.toString(),
    [HEADER_KEYS.TRACE_ID]: nonce,
  };
}

function makeHttpRequest(url, options = {}, proxyUrl = null) {
  return new Promise((resolve, reject) => {
    try {
      const urlObject = new URL(url);
      const isHttps = urlObject.protocol === 'https:';
      const httpModule = isHttps ? https : http;
      
      const requestOptions = {
        hostname: urlObject.hostname,
        port: urlObject.port || (isHttps ? 443 : 80),
        path: urlObject.pathname + urlObject.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: 30000,
      };

      if (proxyUrl) {
        try {
          if (isHttps) {
            requestOptions.agent = new HttpsProxyAgent(proxyUrl);
          } else {
            requestOptions.agent = new HttpProxyAgent(proxyUrl);
          }
        } catch (proxyError) {
          console.error(`Proxy error: ${proxyError.message}`);
        }
      }

      const request = httpModule.request(requestOptions, (response) => {
        let responseData = '';
        
        response.on('data', (chunk) => {
          responseData += chunk;
        });
        
        response.on('end', () => {
          try {
            if (response.statusCode < 200 || response.statusCode >= 300) {
              return reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
            }
            
            const jsonData = JSON.parse(responseData);
            resolve(jsonData);
          } catch (error) {
            reject(new Error(`Gagal parsing JSON response: ${error.message}`));
          }
        });
      });

      request.on('error', (error) => {
        reject(new Error(`Request gagal: ${error.message}`));
      });

      request.on('timeout', () => {
        request.destroy();
        reject(new Error(`Request timeout`));
      });

      if (options.body) {
        request.write(options.body);
      }
      
      request.end();
      
    } catch (error) {
      reject(new Error(`Setup request gagal: ${error.message}`));
    }
  });
}

// Proxy Manager Class
class ProxyManager {
  constructor() {
    this.proxies = [];
    this.currentIndex = 0;
  }

  async loadProxies() {
    try {
      const proxyData = await fs.readFile("proxy.txt", "utf8");
      
      this.proxies = proxyData
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .filter(line => {
          const proxyRegex = /^https?:\/\/([^:]+:[^@]+@)?[^:]+:\d+$/;
          return proxyRegex.test(line);
        });
      
      if (this.proxies.length > 0) {
        console.log(`Berhasil memuat ${this.proxies.length} proxy dari proxy.txt`);
      } else {
        console.log("Tidak ada proxy yang valid di proxy.txt, akan berjalan tanpa proxy");
      }
      
      return this.proxies;
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log("File proxy.txt tidak ditemukan, akan berjalan tanpa proxy");
      } else {
        console.log(`Error membaca proxy.txt: ${error.message}, akan berjalan tanpa proxy`);
      }
      this.proxies = [];
      return [];
    }
  }

  getProxy(accountIndex = 0) {
    if (this.proxies.length === 0) {
      return null;
    }
    const proxyIndex = accountIndex % this.proxies.length;
    return this.proxies[proxyIndex];
  }

  getAllProxies() {
    return this.proxies;
  }

  getCount() {
    return this.proxies.length;
  }

  async testProxy(proxyUrl) {
    try {
      const testResponse = await axios.get('https://httpbin.org/ip', {
        proxy: false,
        httpsAgent: new HttpsProxyAgent(proxyUrl),
        timeout: 10000
      });
      
      return {
        working: true,
        ip: testResponse.data?.origin || 'unknown'
      };
    } catch (error) {
      return {
        working: false,
        error: error.message
      };
    }
  }
}

// CAPTCHA Handler Class
class CaptchaHandler {
  constructor() {
    this.isEnabled = CONFIG.CAPTCHA.enabled;
    this.apiKey = CONFIG.CAPTCHA.apiKey;
    this.solvingCache = new Map();
  }

  async solveCaptcha(websiteURL = null, websiteKey = null) {
    if (!this.isEnabled) {
      throw new Error("CAPTCHA handling dinonaktifkan dalam konfigurasi");
    }

    const url = websiteURL || CONFIG.CAPTCHA.websiteURL;
    const key = websiteKey || CONFIG.CAPTCHA.websiteKey;

    console.log(`Menyelesaikan CAPTCHA untuk ${url}...`);

    try {
      const createResponse = await axios.post('https://api.capmonster.cloud/createTask', {
        clientKey: this.apiKey,
        task: {
          type: "RecaptchaV2TaskProxyless",
          websiteURL: url,
          websiteKey: key,
        },
      }, { timeout: 30000 });

      if (createResponse.data.errorId !== 0) {
        throw new Error(`CapMonster error: ${createResponse.data.errorDescription}`);
      }

      const taskId = createResponse.data.taskId;
      console.log(`Task CAPTCHA dibuat: ${taskId}`);

      const startTime = Date.now();
      const timeoutMs = CONFIG.CAPTCHA.timeoutSeconds * 1000;

      while (Date.now() - startTime < timeoutMs) {
        await this.sleep(CONFIG.CAPTCHA.pollingInterval);

        const pollResponse = await axios.post('https://api.capmonster.cloud/getTaskResult', {
          clientKey: this.apiKey,
          taskId: taskId,
        }, { timeout: 30000 });

        if (pollResponse.data.errorId !== 0) {
          throw new Error(`CapMonster polling error: ${pollResponse.data.errorDescription}`);
        }

        if (pollResponse.data.status === "ready") {
          const token = pollResponse.data.solution.gRecaptchaResponse;
          console.log(`CAPTCHA berhasil diselesaikan!`);
          return token;
        }

        if (pollResponse.data.status === "processing") {
          console.log(`CAPTCHA masih diproses... (${Math.floor((Date.now() - startTime) / 1000)}s)`);
          continue;
        }
      }

      throw new Error("Timeout menunggu penyelesaian CAPTCHA");

    } catch (error) {
      console.error(`Error solving CAPTCHA: ${error.message}`);
      throw error;
    }
  }

  async verifyCaptcha(token, cookieString) {
    const headers = {
      accept: "application/json",
      "trpc-accept": "application/json",
      "x-trpc-source": "nextjs-react",
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      origin: "https://app.appleville.xyz",
      referer: "https://app.appleville.xyz/",
      cookie: cookieString,
      "x-trace-id": crypto.randomUUID(),
    };

    const payload = { "0": { json: { token } } };

    console.log(`Mengirim verifikasi CAPTCHA ke server...`);

    const response = await makeHttpRequest(CONFIG.API.VERIFY_CAPTCHA, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    console.log(`CAPTCHA berhasil diverifikasi di server!`);
    return response;
  }

  async handleCaptchaError(error, cookieString) {
    const errorMessage = String(error.message || "").toLowerCase();
    
    if (errorMessage.includes("captcha verification required") || 
        errorMessage.includes("412") ||
        errorMessage.includes("precondition failed")) {
      
      console.log(`Terdeteksi error CAPTCHA (412/Precondition Failed)`);
      
      try {
        const captchaToken = await this.solveCaptcha();
        await this.verifyCaptcha(captchaToken, cookieString);
        
        console.log(`CAPTCHA berhasil diselesaikan dan diverifikasi!`);
        return true;
        
      } catch (captchaError) {
        console.error(`Gagal menyelesaikan CAPTCHA: ${captchaError.message}`);
        return false;
      }
    }
    
    return false;
  }

  resetCache() {
    this.solvingCache.clear();
  }

  sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }
}

// Cookie Manager Class
class CookieManager {
  constructor() {
    this.cookies = [];
  }

  async loadCookies() {
    try {
      const rawCookies = await fs.readFile("cookie.txt", "utf8");
      
      this.cookies = rawCookies
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
      
      console.log(`Berhasil memuat ${this.cookies.length} cookie dari cookie.txt`);
      return this.cookies;
      
    } catch (error) {
      console.error("Error membaca cookie.txt:", error.message);
      console.error("Pastikan file cookie.txt ada dan berisi cookie yang valid");
      throw error;
    }
  }

  getCookie(index = 0) {
    if (this.cookies.length === 0) {
      throw new Error("Belum ada cookie yang dimuat. Jalankan loadCookies() terlebih dahulu.");
    }
    
    if (index >= this.cookies.length) {
      throw new Error(`Index ${index} melebihi jumlah cookie yang tersedia (${this.cookies.length})`);
    }
    
    return this.cookies[index];
  }

  getAllCookies() {
    return this.cookies;
  }

  getCount() {
    return this.cookies.length;
  }
}

// Game State Manager Class - Enhanced with Plant-First Strategy
class GameStateManager {
  constructor(cookieString = null, proxyUrl = null) {
    this.cookieString = cookieString;
    this.proxyUrl = proxyUrl;
    this.gameState = null;
    this.userInfo = null;
    this.cookieManager = new CookieManager();
    this.proxyManager = new ProxyManager();
  }

  setCookie(cookieString) {
    this.cookieString = cookieString;
  }

  setProxy(proxyUrl) {
    this.proxyUrl = proxyUrl;
  }

  async loadCookieFromFile(index = 0) {
    await this.cookieManager.loadCookies();
    this.cookieString = this.cookieManager.getCookie(index);
    
    await this.proxyManager.loadProxies();
    this.proxyUrl = this.proxyManager.getProxy(index);
    
    if (this.proxyUrl) {
      const maskedProxy = this.proxyUrl.replace(/\/\/.*@/, '//***@');
      console.log(`Cookie akun #${index + 1} berhasil dimuat dengan proxy: ${maskedProxy}`);
    } else {
      console.log(`Cookie akun #${index + 1} berhasil dimuat tanpa proxy`);
    }
  }

  async getState() {
    if (!this.cookieString) {
      throw new Error("Cookie belum di-set. Gunakan setCookie() atau loadCookieFromFile()");
    }

    const headers = {
      accept: "application/json",
      "trpc-accept": "application/json",
      "x-trpc-source": "nextjs-react",
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      origin: "https://app.appleville.xyz",
      referer: "https://app.appleville.xyz/",
      cookie: this.cookieString,
    };

    try {
      const response = await makeHttpRequest(CONFIG.API.GET_STATE, {
        method: "GET",
        headers,
      }, this.proxyUrl);

      if (Array.isArray(response) && response.length >= 2) {
        this.gameState = response[0]?.result?.data?.json || null;
        this.userInfo = response[1]?.result?.data?.json || null;
      }

      return {
        gameState: this.gameState,
        userInfo: this.userInfo
      };
    } catch (error) {
      throw new Error(`Gagal mendapatkan state: ${error.message}`);
    }
  }

  // Inventory Utils
  getItemCount(itemKey) {
    if (!this.gameState?.items) return 0;
    
    return this.gameState.items
      .filter(item => item.key === itemKey)
      .reduce((total, item) => total + (item.quantity || 0), 0);
  }

  getEmptyPlotsCount() {
    if (!this.gameState?.plots) return 0;
    
    return this.gameState.plots.filter(plot => !plot.seed).length;
  }

  getEmptyPlots() {
    if (!this.gameState?.plots) return [];
    
    return this.gameState.plots
      .filter(plot => !plot.seed)
      .map(plot => ({
        slotIndex: plot.slotIndex,
        id: plot.id
      }))
      .sort((a, b) => a.slotIndex - b.slotIndex);
  }

  getPlotsNeedingBooster() {
    if (!this.gameState?.plots) return [];
    
    return this.gameState.plots
      .filter(plot => !plot.modifier || this.isModifierExpired(plot.modifier))
      .map(plot => ({
        slotIndex: plot.slotIndex,
        id: plot.id,
        hasSeed: !!plot.seed
      }))
      .sort((a, b) => a.slotIndex - b.slotIndex);
  }

  getPlotsReadyToHarvest() {
    if (!this.gameState?.plots) return [];
    
    return this.gameState.plots
      .filter(plot => plot.seed && this.isReadyToHarvest(plot.seed))
      .map(plot => ({
        slotIndex: plot.slotIndex,
        id: plot.id,
        seedKey: plot.seed.key,
        endsAt: plot.seed.endsAt
      }))
      .sort((a, b) => a.slotIndex - b.slotIndex);
  }

  isModifierExpired(modifier) {
    if (!modifier?.endsAt) return true;
    return new Date(modifier.endsAt).getTime() <= Date.now();
  }

  isReadyToHarvest(seed) {
    if (!seed?.endsAt) return false;
    return new Date(seed.endsAt).getTime() <= Date.now();
  }

  // CORRECTED: Plant Strategy according to user requirements
  determinePlantingStrategy() {
    const totalPlots = this.gameState?.numPlots || 0;
    const prestigeLevel = this.userInfo?.prestigeLevel || 0;
    const nextPlotPrice = this.gameState?.nextPlotPrice;
    const currentAP = this.gameState?.ap || 0
    
      // CEK INVENTORY TERSEDIA DULU
    const goldenAppleCount = this.getItemCount("golden-apple");
    const legacyAppleCount = this.getItemCount("legacy-apple");
    const apexAppleCount = this.getItemCount("apex-apple");
    const wheatCount = this.getItemCount("wheat");
      // PRIORITAS 1: Gunakan yang ada di inventory terlebih dahulu
    if (prestigeLevel >= 7 && apexAppleCount > 0) {
      return "apex-apple";
    }
    if (prestigeLevel >= 1 && legacyAppleCount > 0) {
      return "legacy-apple";
    }
    if (goldenAppleCount > 0) {
      return "golden-apple";
    }
    if (wheatCount > 0) {
      return "wheat";
    }

    // PRIORITY 2: Jika masih bisa beli plot, ikuti currency next plot
    if (nextPlotPrice && nextPlotPrice.currency && totalPlots < 12) {
      const currency = nextPlotPrice.currency.toLowerCase();
      
      if (currency === "coins") {
        return "wheat";
      } else if (currency === "ap") {
        // Berdasarkan prestige level
        if (prestigeLevel >= 1) {
          // Level 1+: Coba legacy-apple, fallback ke golden-apple
          const legacyAppleCost = CONFIG.ITEMS["legacy-apple"].cost;
          if (currentAP >= legacyAppleCost) {
            return "legacy-apple";
          } else {
            return "golden-apple";
          }
        } else {
          // Level 0: Golden Apple
          return "golden-apple";
        }
      }
    }

    // PRIORITY 3: Jika sudah 12 plots (maksimal)
    if (totalPlots >= 12) {
      if (prestigeLevel >= 7) {
        // Level 7+: Apex Apple → Legacy Apple → Golden Apple
        const apexAppleCost = CONFIG.ITEMS["apex-apple"].cost;
        if (currentAP >= apexAppleCost) {
          return "apex-apple";
        } else {
          const legacyAppleCost = CONFIG.ITEMS["legacy-apple"].cost;
          if (currentAP >= legacyAppleCost) {
            return "legacy-apple";
          } else {
            return "golden-apple";
          }
        }
      } else if (prestigeLevel >= 1) {
        // Level 1-6: Legacy Apple → Golden Apple
        const legacyAppleCost = CONFIG.ITEMS["legacy-apple"].cost;
        if (currentAP >= legacyAppleCost) {
          return "legacy-apple";
        } else {
          return "golden-apple";
        }
      } else {
        // Level 0: Golden Apple (jangan pakai Royal Apple yang mahal)
        return "golden-apple";
      }
    }

    // PRIORITY 4: Fallback strategy
    if (prestigeLevel >= 1) {
      return "legacy-apple";
    } else {
      return "golden-apple"; // Level 0 pakai golden apple
    }
  }
  
  // Fungsi untuk mendapatkan seed terbaik yang tersedia di inventory
  getBestAvailableSeed() {
    const prestigeLevel = this.userInfo?.prestigeLevel || 0;
  
    // Urutan prioritas berdasarkan prestige level
    const seedPriorities = [];
  
    if (prestigeLevel >= 7) {
      seedPriorities.push("apex-apple", "legacy-apple", "golden-apple", "wheat");
    } else if (prestigeLevel >= 1) {
      seedPriorities.push("legacy-apple", "golden-apple", "wheat");
    } else {
      seedPriorities.push("golden-apple", "wheat");
    }
  
    // Return seed pertama yang tersedia di inventory
    for (const seed of seedPriorities) {
      if (this.getItemCount(seed) > 0) {
        return seed;
      }
    }
  
    return null; // Tidak ada seed tersedia
  }

  // Prestige Methods
  canPrestige() {
    const currentLevel = this.userInfo?.prestigeLevel || 0;
    const currentAP = this.gameState?.ap || 0;
    const totalPlots = this.gameState?.numPlots || 0;
    
    if (totalPlots < 12) {
      return {
        canPrestige: false,
        reason: "Butuh 12 plots untuk prestige",
        currentPlots: totalPlots,
        requiredPlots: 12
      };
    }
    
    if (currentLevel >= 7) {
      return {
        canPrestige: false,
        reason: "Sudah prestige level maksimal (7)",
        currentLevel,
        maxLevel: 7
      };
    }
    
    const nextLevel = currentLevel + 1;
    const prestigeRequirement = CONFIG.PRESTIGE.LEVELS[nextLevel];
    
    if (!prestigeRequirement) {
      return {
        canPrestige: false,
        reason: "Level prestige tidak valid",
        currentLevel,
        nextLevel
      };
    }
    
    if (currentAP >= prestigeRequirement.required) {
      return {
        canPrestige: true,
        currentLevel,
        nextLevel,
        currentAP,
        requiredAP: prestigeRequirement.required,
        newMultiplier: prestigeRequirement.multiplier,
        reason: `Dapat prestige ke level ${nextLevel}`
      };
    } else {
      return {
        canPrestige: false,
        reason: `AP tidak cukup untuk prestige level ${nextLevel}`,
        currentLevel,
        nextLevel,
        currentAP,
        requiredAP: prestigeRequirement.required,
        shortage: prestigeRequirement.required - currentAP
      };
    }
  }

  async performPrestige() {
    if (!this.cookieString) {
      throw new Error("Cookie belum di-set");
    }
    
    const prestigeCheck = this.canPrestige();
    if (!prestigeCheck.canPrestige) {
      return {
        success: false,
        reason: prestigeCheck.reason,
        data: prestigeCheck
      };
    }
    
    try {
      console.log(`[PRESTIGE] Upgrading from level ${prestigeCheck.currentLevel} to ${prestigeCheck.nextLevel}...`);
      
      const operationInput = null;
      const requestBody = { 
        "0": { 
          json: operationInput, 
          meta: { values: ["undefined"] } 
        } 
      };

      const baseHeaders = {
        accept: "application/json",
        "trpc-accept": "application/json",
        "x-trpc-source": "nextjs-react",
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        origin: "https://app.appleville.xyz",
        referer: "https://app.appleville.xyz/",
        cookie: this.cookieString,
      };

      const authHeaders = createAuthHeaders(operationInput);
      const headers = { ...baseHeaders, ...authHeaders };

      const response = await makeHttpRequest(CONFIG.PRESTIGE.ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
      }, this.proxyUrl);

      if (response?.[0]?.error) {
        throw new Error(`Prestige API Error: ${response[0].error.message || 'Unknown error'}`);
      }

      console.log(`[PRESTIGE] Success! Level ${prestigeCheck.currentLevel} → ${prestigeCheck.nextLevel}`);
      console.log(`[PRESTIGE] Waiting ${CONFIG.PRESTIGE.WAIT_AFTER_PRESTIGE / 1000}s before continuing...`);
      
      await new Promise(resolve => setTimeout(resolve, CONFIG.PRESTIGE.WAIT_AFTER_PRESTIGE));
      await this.getState();
      
      return {
        success: true,
        oldLevel: prestigeCheck.currentLevel,
        newLevel: prestigeCheck.nextLevel,
        apSpent: prestigeCheck.requiredAP,
        newMultiplier: prestigeCheck.newMultiplier
      };

    } catch (error) {
      console.error(`[PRESTIGE] Error: ${error.message}`);
      
      if (error.message.includes('412') || error.message.includes('captcha')) {
        try {
          const captchaHandler = new CaptchaHandler();
          const handled = await captchaHandler.handleCaptchaError(error, this.cookieString);
          
          if (handled) {
            return await this.performPrestige();
          }
        } catch (captchaError) {
          // Silent fail for captcha errors
        }
      }
      
      return {
        success: false,
        reason: error.message,
        data: prestigeCheck
      };
    }
  }

  async autoPrestige() {
    const prestigeCheck = this.canPrestige();
    
    if (prestigeCheck.canPrestige) {
      console.log(`[AUTO-PRESTIGE] Conditions met: Level ${prestigeCheck.currentLevel} → ${prestigeCheck.nextLevel}`);
      return await this.performPrestige();
    } else {
      return {
        success: false,
        reason: "Conditions not met for auto prestige",
        data: prestigeCheck
      };
    }
  }

  // ENHANCED: Plant-First Strategic Needs Analysis
  analyzeStrategicNeeds() {
    const emptyPlots = this.getEmptyPlotsCount();
    const totalPlots = this.gameState?.numPlots || 0;
    const nextPlotPrice = this.gameState?.nextPlotPrice;
    const seedStrategy = this.determinePlantingStrategy();
  
    const wheatCount = this.getItemCount("wheat");
    const goldenAppleCount = this.getItemCount("golden-apple");
    const royalAppleCount = this.getItemCount("royal-apple");
    const legacyAppleCount = this.getItemCount("legacy-apple");
    const apexAppleCount = this.getItemCount("apex-apple");
    const boosterCount = this.getItemCount("quantum-fertilizer");
  
    let needSeeds = 0;
    let currentSeedCount = 0;
  
    if (seedStrategy === "wheat") {
      needSeeds = Math.max(0, emptyPlots - wheatCount);
      currentSeedCount = wheatCount;
    } else if (seedStrategy === "golden-apple") {
      needSeeds = Math.max(0, emptyPlots - goldenAppleCount);
      currentSeedCount = goldenAppleCount;
    } else if (seedStrategy === "royal-apple") {
      needSeeds = Math.max(0, emptyPlots - royalAppleCount);
      currentSeedCount = royalAppleCount;
    } else if (seedStrategy === "legacy-apple") {
      needSeeds = Math.max(0, emptyPlots - legacyAppleCount);
      currentSeedCount = legacyAppleCount;
    } else if (seedStrategy === "apex-apple") {
      needSeeds = Math.max(0, emptyPlots - apexAppleCount);
      currentSeedCount = apexAppleCount;
    }
  
    if (currentSeedCount >= emptyPlots) {
      needSeeds = 0;
    }
  
    const needBoosters = Math.max(0, totalPlots - boosterCount);
    const currentCoins = this.gameState?.coins || 0;
    const currentAP = this.gameState?.ap || 0;

    // CALCULATE AVAILABLE BUDGET WITH MINIMUM RESERVES
    const availableCoins = Math.max(0, currentCoins - CONFIG.MINIMUM_RESERVES.COINS);
    const availableAP = Math.max(0, currentAP - CONFIG.MINIMUM_RESERVES.AP);

    // PLANTS FIRST: Calculate seed affordability first (with reserves)
    let affordableSeeds = 0;
    let seedCost = 0;
    let seedCurrency = "";

    const seedConfig = CONFIG.ITEMS[seedStrategy];
    if (seedConfig) {
      seedCost = seedConfig.cost;
      seedCurrency = seedConfig.currency;
    
      if (seedCurrency === "coins") {
        affordableSeeds = Math.floor(availableCoins / seedCost);
      } else if (seedCurrency === "ap") {
        affordableSeeds = Math.floor(availableAP / seedCost);
      }
    }

    // PLANTS FIRST: Calculate remaining budget after buying all needed seeds
    let remainingAPAfterSeeds = availableAP;
    let remainingCoinsAfterSeeds = availableCoins;
  
    if (seedCurrency === "ap") {
      const seedsToBuy = Math.min(needSeeds, affordableSeeds);
      remainingAPAfterSeeds = availableAP - (seedsToBuy * seedCost);
    } else if (seedCurrency === "coins") {
      const seedsToBuy = Math.min(needSeeds, affordableSeeds);
      remainingCoinsAfterSeeds = availableCoins - (seedsToBuy * seedCost);
    }

    // BOOSTERS SECOND: Only buy boosters with remaining budget
    let affordableBoosters = 0;
    if (CONFIG.PLANT_STRATEGY.AUTO_BUY_BOOSTERS && remainingAPAfterSeeds >= CONFIG.ITEMS["quantum-fertilizer"].cost) {
      affordableBoosters = Math.floor(remainingAPAfterSeeds / CONFIG.ITEMS["quantum-fertilizer"].cost);
    }

    // Plot affordability - consider after plants and boosters WITH MINIMUM RESERVES
    let canAffordPlot = false;
    let plotCost = 0;
    let plotCurrency = "";
  
    if (nextPlotPrice) {
      plotCost = nextPlotPrice.amount || 0;
      plotCurrency = (nextPlotPrice.currency || "").toLowerCase();
    
      if (plotCurrency === "coins") {
        // Check if we have enough coins INCLUDING the minimum reserve
        canAffordPlot = currentCoins >= (plotCost + CONFIG.MINIMUM_RESERVES.COINS);
      } else if (plotCurrency === "ap") {
        let remainingAPAfterAllPurchases = remainingAPAfterSeeds;
        const boostersToBuy = Math.min(needBoosters, affordableBoosters);
        remainingAPAfterAllPurchases -= (boostersToBuy * CONFIG.ITEMS["quantum-fertilizer"].cost);
      
        // Check if we have enough AP INCLUDING the minimum reserve
        canAffordPlot = (remainingAPAfterAllPurchases + CONFIG.MINIMUM_RESERVES.AP) >= (plotCost + CONFIG.MINIMUM_RESERVES.AP);
      }
    }

    const buyPlan = {
      seeds: {
        type: seedStrategy,
        quantity: Math.min(needSeeds, affordableSeeds),
        cost: seedCost,
        currency: seedCurrency
      },
      boosters: {
        quantity: Math.min(needBoosters, affordableBoosters),
        cost: CONFIG.ITEMS["quantum-fertilizer"].cost,
        currency: "ap",
        plantsFirstEnabled: CONFIG.PLANT_STRATEGY.PLANTS_FIRST_PRIORITY
      },
      plot: {
        canAfford: canAffordPlot,
        cost: plotCost,
        currency: plotCurrency,
        shouldBuy: canAffordPlot && nextPlotPrice,
        minimumReserveApplied: true
      }
    };

    return {
      totalPlots,
      emptyPlots,
      nextPlotPrice,
      seedStrategy,
      inventory: {
        wheat: wheatCount,
        "golden-apple": goldenAppleCount,
        "royal-apple": royalAppleCount,
        "legacy-apple": legacyAppleCount,
        "apex-apple": apexAppleCount,
        "quantum-fertilizer": boosterCount
      },
      budget: {
        coins: currentCoins,
        ap: currentAP,
        availableCoins: availableCoins,  // After minimum reserve
        availableAP: availableAP,        // After minimum reserve
        apAfterSeeds: remainingAPAfterSeeds,
        minimumReserves: CONFIG.MINIMUM_RESERVES
      },
      needs: {
        seeds: needSeeds,
        boosters: needBoosters
      },
      affordable: {
        seeds: affordableSeeds,
        boosters: affordableBoosters
      },
      buyPlan,
      hasEnoughSeeds: currentSeedCount >= emptyPlots,
      hasEnoughBoosters: boosterCount >= totalPlots,
      readyToPlant: true,
      canAffordAllNeeds: buyPlan.seeds.quantity >= needSeeds && buyPlan.boosters.quantity >= needBoosters
    };
  }

  canAffordItem(itemKey, quantity = 1) {
    const priceInfo = CONFIG.ITEMS[itemKey];
    if (!priceInfo) {
      return { canAfford: false, reason: `Item ${itemKey} tidak dikenal` };
    }

    const totalCost = priceInfo.cost * quantity;
    const currency = priceInfo.currency;
    const available = currency === "coins" ? (this.gameState?.coins || 0) : (this.gameState?.ap || 0);

    if (available >= totalCost) {
      return {
        canAfford: true,
        totalCost,
        currency,
        available,
        remaining: available - totalCost
      };
    } else {
      return {
        canAfford: false,
        reason: `${currency.toUpperCase()} tidak cukup`,
        totalCost,
        currency,
        available,
        shortage: totalCost - available
      };
    }
  }

  displayInfo() {
    if (!this.gameState || !this.userInfo) {
      console.log("Belum ada data state. Jalankan getState() terlebih dahulu.");
      return;
    }

    console.log("=== INFORMASI AKUN ===");
    console.log(`AP: ${this.gameState.ap || 0}`);
    console.log(`Coins: ${this.gameState.coins || 0}`);
    console.log(`Prestige Level: ${this.userInfo.prestigeLevel || 0}`);
    
    const prestigeCheck = this.canPrestige();
    if (prestigeCheck.canPrestige) {
      console.log(`PRESTIGE: DAPAT UPGRADE ke level ${prestigeCheck.nextLevel} (${prestigeCheck.currentAP.toLocaleString()}/${prestigeCheck.requiredAP.toLocaleString()} AP)`);
    } else if (prestigeCheck.currentLevel < 7) {
      const shortage = prestigeCheck.shortage || 0;
      console.log(`PRESTIGE: Level ${prestigeCheck.currentLevel}, butuh ${shortage.toLocaleString()} AP lagi untuk level ${prestigeCheck.nextLevel || prestigeCheck.currentLevel + 1}`);
    } else {
      console.log(`PRESTIGE: Level maksimal (7) tercapai`);
    }
    
    const claimStatus = this.canClaimFarmhouse();
    if (claimStatus.canClaim) {
      console.log(`Farmhouse: DAPAT DIKLAIM (${claimStatus.reason})`);
    } else {
      console.log(`Farmhouse: ${claimStatus.reason}`);
    }
    
    const analysis = this.analyzeStrategicNeeds();
    console.log(`Plot: ${analysis.totalPlots} total, ${analysis.emptyPlots} kosong`);
    console.log(`Strategi: ${analysis.seedStrategy} (NextPlot: ${analysis.nextPlotPrice?.currency || 'none'})`);
    console.log(`Seeds: ${analysis.inventory.wheat}W, ${analysis.inventory["golden-apple"]}G, ${analysis.inventory["royal-apple"]}R, ${analysis.inventory["legacy-apple"]}L, ${analysis.inventory["apex-apple"]}A`);
    console.log(`Boosters: ${analysis.inventory["quantum-fertilizer"]}`);
    
    if (bestAvailable) {
      const availableCount = this.getItemCount(bestAvailable);
      console.log(`Best Available: ${availableCount} ${bestAvailable} (will plant this first)`);
    } else {
      console.log(`Best Available: None (need to buy seeds)`);
    }
    
    if (analysis.needs.seeds > 0 || analysis.needs.boosters > 0) {
      console.log(`PERLU: ${analysis.needs.seeds} ${analysis.seedStrategy}, ${analysis.needs.boosters} boosters`);
      console.log(`MAMPU BELI: ${analysis.affordable.seeds} seeds, ${analysis.affordable.boosters} boosters`);
      
      if (analysis.canAffordAllNeeds) {
        console.log(`STATUS: BISA BELI SEMUA KEBUTUHAN (PLANTS FIRST)`);
      } else {
        console.log(`STATUS: BUDGET TIDAK CUKUP UNTUK SEMUA (PRIORITAS PLANTS)`);
      }
    } else if (analysis.readyToPlant) {
      console.log(`STATUS: SIAP TANAM`);
    }
    
    console.log("=====================");
  }
}

// Farmhouse Methods with Proxy Support
GameStateManager.prototype.canClaimFarmhouse = function() {
  if (!this.gameState?.lastFarmhouseAt) {
    return {
      canClaim: true,
      reason: "Belum pernah claim sebelumnya",
      timeSinceLastClaim: null,
      nextClaimTime: null
    };
  }

  const lastClaimTime = new Date(this.gameState.lastFarmhouseAt).getTime();
  const currentTime = Date.now();
  const timeSinceLastClaim = currentTime - lastClaimTime;
  const hoursInMs = 24 * 60 * 60 * 1000;

  if (timeSinceLastClaim >= hoursInMs) {
    return {
      canClaim: true,
      reason: `Sudah ${Math.floor(timeSinceLastClaim / 1000 / 60 / 60)} jam sejak claim terakhir`,
      timeSinceLastClaim: timeSinceLastClaim,
      nextClaimTime: null
    };
  } else {
    const remainingTime = hoursInMs - timeSinceLastClaim;
    const hoursRemaining = Math.floor(remainingTime / 1000 / 60 / 60);
    const minutesRemaining = Math.floor((remainingTime % (1000 * 60 * 60)) / (1000 * 60));

    return {
      canClaim: false,
      reason: `Masih ${hoursRemaining}h ${minutesRemaining}m lagi`,
      timeSinceLastClaim: timeSinceLastClaim,
      nextClaimTime: lastClaimTime + hoursInMs
    };
  }
};

GameStateManager.prototype.claimFarmhouse = async function() {
  if (!this.cookieString) {
    throw new Error("Cookie belum di-set");
  }

  try {
    const operationInput = null;
    const requestBody = { 
      "0": { 
        json: operationInput, 
        meta: { values: ["undefined"] } 
      } 
    };

    const baseHeaders = {
      accept: "application/json",
      "trpc-accept": "application/json",
      "x-trpc-source": "nextjs-react",
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      origin: "https://app.appleville.xyz",
      referer: "https://app.appleville.xyz/",
      cookie: this.cookieString,
    };

    const authHeaders = createAuthHeaders(operationInput);
    const headers = { ...baseHeaders, ...authHeaders };

    const response = await makeHttpRequest(CONFIG.API.CLAIM_FARMHOUSE, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    }, this.proxyUrl);

    if (response?.[0]?.error) {
      throw new Error(`API Error: ${response[0].error.message || 'Unknown error'}`);
    }

    await this.getState();
    return true;

  } catch (error) {
    if (error.message.includes('412') || error.message.includes('captcha')) {
      try {
        const captchaHandler = new CaptchaHandler();
        const handled = await captchaHandler.handleCaptchaError(error, this.cookieString);
        
        if (handled) {
          return await this.claimFarmhouse();
        }
      } catch (captchaError) {
        // Silent fail for captcha errors
      }
    }
    
    return false;
  }
};

GameStateManager.prototype.autoClaimFarmhouse = async function() {
  const claimStatus = this.canClaimFarmhouse();
  
  if (claimStatus.canClaim) {
    return await this.claimFarmhouse();
  } else {
    return false;
  }
};

// Buy Item Method with Proxy Support
GameStateManager.prototype.buyItem = async function(itemKey, quantity = 1) {
  if (!this.cookieString) {
    throw new Error("Cookie belum di-set");
  }

  if (quantity <= 0) {
    return false;
  }

  const budgetCheck = this.canAffordItem(itemKey, quantity);
  if (!budgetCheck.canAfford) {
    return false;
  }

  try {
    const purchases = [];
    for (let i = 0; i < quantity; i++) {
      purchases.push({
        key: itemKey,
        quantity: 1
      });
    }

    const operationInput = { purchases };
    const requestBody = { "0": { json: operationInput } };

    const baseHeaders = {
      accept: "application/json",
      "trpc-accept": "application/json",
      "x-trpc-source": "nextjs-react",
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      origin: "https://app.appleville.xyz",
      referer: "https://app.appleville.xyz/",
      cookie: this.cookieString,
    };

    const authHeaders = createAuthHeaders(operationInput);
    const headers = { ...baseHeaders, ...authHeaders };

    const response = await makeHttpRequest(CONFIG.API.BUY_ITEM, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    }, this.proxyUrl);

    if (response?.[0]?.error) {
      throw new Error(`API Error: ${response[0].error.message || 'Unknown error'}`);
    }

    await this.getState();
    return true;

  } catch (error) {
    if (error.message.includes('412') || error.message.includes('captcha')) {
      try {
        const captchaHandler = new CaptchaHandler();
        const handled = await captchaHandler.handleCaptchaError(error, this.cookieString);
        
        if (handled) {
          return await this.buyItem(itemKey, quantity);
        }
      } catch (captchaError) {
        // Silent fail for captcha errors
      }
    }
    
    return false;
  }
};

// Buy Plot Method with Proxy Support
GameStateManager.prototype.buyPlot = async function() {
  if (!this.cookieString) {
    throw new Error("Cookie belum di-set");
  }

  const nextPlotPrice = this.gameState?.nextPlotPrice;
  if (!nextPlotPrice) {
    return false;
  }

  const cost = nextPlotPrice.amount || 0;
  const currency = (nextPlotPrice.currency || "").toLowerCase();
  const currentAP = this.gameState?.ap || 0;
  const currentCoins = this.gameState?.coins || 0;

  // CHECK MINIMUM RESERVES BEFORE BUYING PLOT
  if (currency === "coins") {
    const availableCoins = currentCoins;
    const requiredTotal = cost + CONFIG.MINIMUM_RESERVES.COINS;
    
    if (availableCoins < requiredTotal) {
      console.log(`Skip buy plot: Need ${requiredTotal} coins (${cost} + ${CONFIG.MINIMUM_RESERVES.COINS} reserve), have ${availableCoins}`);
      return false;
    }
  } else if (currency === "ap") {
    const availableAP = currentAP;
    const requiredTotal = cost + CONFIG.MINIMUM_RESERVES.AP;
    
    if (availableAP < requiredTotal) {
      console.log(`Skip buy plot: Need ${requiredTotal} AP (${cost} + ${CONFIG.MINIMUM_RESERVES.AP} reserve), have ${availableAP}`);
      return false;
    }
  }

  try {
    const operationInput = null;
    const requestBody = { 
      "0": { 
        json: operationInput, 
        meta: { values: ["undefined"] } 
      } 
    };

    const baseHeaders = {
      accept: "application/json",
      "trpc-accept": "application/json",
      "x-trpc-source": "nextjs-react",
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      origin: "https://app.appleville.xyz",
      referer: "https://app.appleville.xyz/",
      cookie: this.cookieString,
    };

    const authHeaders = createAuthHeaders(operationInput);
    const headers = { ...baseHeaders, ...authHeaders };

    const response = await makeHttpRequest(CONFIG.API.BUY_PLOT, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    }, this.proxyUrl);

    if (response?.[0]?.error) {
      throw new Error(`API Error: ${response[0].error.message || 'Unknown error'}`);
    }

    await this.getState();
    return true;

  } catch (error) {
    if (error.message.includes('412') || error.message.includes('captcha')) {
      try {
        const captchaHandler = new CaptchaHandler();
        const handled = await captchaHandler.handleCaptchaError(error, this.cookieString);
        
        if (handled) {
          return await this.buyPlot();
        }
      } catch (captchaError) {
        // Silent fail for captcha errors
      }
    }
    
    return false;
  }
};

// Plant Seed Method with Proxy Support
GameStateManager.prototype.plantSeed = async function(slotIndex, seedKey) {
  if (!this.cookieString) {
    throw new Error("Cookie belum di-set");
  }

  try {
    const operationInput = {
      plantings: [{
        slotIndex: slotIndex,
        seedKey: seedKey
      }]
    };
    const requestBody = { "0": { json: operationInput } };

    const baseHeaders = {
      accept: "application/json",
      "trpc-accept": "application/json",
      "x-trpc-source": "nextjs-react",
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      origin: "https://app.appleville.xyz",
      referer: "https://app.appleville.xyz/",
      cookie: this.cookieString,
    };

    const authHeaders = createAuthHeaders(operationInput);
    const headers = { ...baseHeaders, ...authHeaders };

    const response = await makeHttpRequest(CONFIG.API.PLANT_SEED, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    }, this.proxyUrl);

    if (response?.[0]?.error) {
      throw new Error(`API Error: ${response[0].error.message || 'Unknown error'}`);
    }

    await this.getState();
    return true;

  } catch (error) {
    if (error.message.includes('412') || error.message.includes('captcha')) {
      try {
        const captchaHandler = new CaptchaHandler();
        const handled = await captchaHandler.handleCaptchaError(error, this.cookieString);
        
        if (handled) {
          return await this.plantSeed(slotIndex, seedKey);
        }
      } catch (captchaError) {
        // Silent fail for captcha errors
      }
    }
    
    return false;
  }
};

// Apply Booster Method with Proxy Support
GameStateManager.prototype.applyBooster = async function(slotIndex, modifierKey = "quantum-fertilizer") {
  if (!this.cookieString) {
    throw new Error("Cookie belum di-set");
  }

  try {
    const operationInput = {
      applications: [{
        slotIndex: slotIndex,
        modifierKey: modifierKey
      }]
    };
    const requestBody = { "0": { json: operationInput } };

    const baseHeaders = {
      accept: "application/json",
      "trpc-accept": "application/json",
      "x-trpc-source": "nextjs-react",
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      origin: "https://app.appleville.xyz",
      referer: "https://app.appleville.xyz/",
      cookie: this.cookieString,
    };

    const authHeaders = createAuthHeaders(operationInput);
    const headers = { ...baseHeaders, ...authHeaders };

    const response = await makeHttpRequest(CONFIG.API.APPLY_MODIFIER, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    }, this.proxyUrl);

    if (response?.[0]?.error) {
      throw new Error(`API Error: ${response[0].error.message || 'Unknown error'}`);
    }

    await this.getState();
    return true;

  } catch (error) {
    if (error.message.includes('412') || error.message.includes('captcha')) {
      try {
        const captchaHandler = new CaptchaHandler();
        const handled = await captchaHandler.handleCaptchaError(error, this.cookieString);
        
        if (handled) {
          return await this.applyBooster(slotIndex, modifierKey);
        }
      } catch (captchaError) {
        // Silent fail for captcha errors
      }
    }
    
    return false;
  }
};

// Harvest Methods with Proxy Support
GameStateManager.prototype.harvestPlots = async function(slotIndexes) {
  if (!this.cookieString) {
    throw new Error("Cookie belum di-set");
  }

  if (!Array.isArray(slotIndexes) || slotIndexes.length === 0) {
    return false;
  }

  const validSlots = [...new Set(slotIndexes)].sort((a, b) => a - b);

  try {
    const operationInput = {
      slotIndexes: validSlots
    };
    const requestBody = { "0": { json: operationInput } };

    const baseHeaders = {
      accept: "application/json",
      "trpc-accept": "application/json",
      "x-trpc-source": "nextjs-react",
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      origin: "https://app.appleville.xyz",
      referer: "https://app.appleville.xyz/",
      cookie: this.cookieString,
    };

    const authHeaders = createAuthHeaders(operationInput);
    const headers = { ...baseHeaders, ...authHeaders };

    const response = await makeHttpRequest(CONFIG.API.HARVEST, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    }, this.proxyUrl);

    if (response?.[0]?.error) {
      throw new Error(`API Error: ${response[0].error.message || 'Unknown error'}`);
    }

    await this.getState();
    return true;

  } catch (error) {
    if (error.message.includes('412') || error.message.includes('captcha')) {
      try {
        const captchaHandler = new CaptchaHandler();
        const handled = await captchaHandler.handleCaptchaError(error, this.cookieString);
        
        if (handled) {
          return await this.harvestPlots(slotIndexes);
        }
      } catch (captchaError) {
        // Silent fail for captcha errors
      }
    }
    
    return false;
  }
};

// Auto Harvest
GameStateManager.prototype.autoHarvest = async function() {
  const readyPlots = this.getPlotsReadyToHarvest();

  if (readyPlots.length === 0) {
    return { harvested: 0, total: 0, success: true };
  }

  const slotIndexes = readyPlots.map(plot => plot.slotIndex);
  
  try {
    const success = await this.harvestPlots(slotIndexes);
    
    if (success) {
      return { 
        harvested: readyPlots.length, 
        total: readyPlots.length, 
        success: true,
        plots: readyPlots
      };
    } else {
      return { 
        harvested: 0, 
        total: readyPlots.length, 
        success: false,
        plots: readyPlots
      };
    }
  } catch (error) {
    return { 
      harvested: 0, 
      total: readyPlots.length, 
      success: false,
      plots: readyPlots
    };
  }
};

// ENHANCED: Plant-First Auto Strategic Buy
GameStateManager.prototype.autoStrategicBuy = async function() {
  const analysis = this.analyzeStrategicNeeds();
  
  const results = {
    seedsBought: 0,
    boostersBought: 0,
    plotsBought: 0,
    totalSpentCoins: 0,
    totalSpentAP: 0,
    skippedBoosters: 0,
    skippedPlots: 0,
    success: false,
    messages: []
  };

  // PRIORITAS 1: Beli seeds WAJIB (plants first strategy)
  if (analysis.buyPlan.seeds.quantity > 0) {
    const seedSuccess = await this.buyItem(analysis.seedStrategy, analysis.buyPlan.seeds.quantity);
    if (seedSuccess) {
      results.seedsBought = analysis.buyPlan.seeds.quantity;
      if (analysis.buyPlan.seeds.currency === "coins") {
        results.totalSpentCoins += analysis.buyPlan.seeds.quantity * analysis.buyPlan.seeds.cost;
      } else {
        results.totalSpentAP += analysis.buyPlan.seeds.quantity * analysis.buyPlan.seeds.cost;
      }
      results.messages.push(`Bought ${results.seedsBought} ${analysis.seedStrategy}`);
      
      // Refresh state after buying seeds untuk update AP
      await this.getState();
    }
  }

  // Re-analyze after buying seeds untuk menghitung ulang sisa AP
  const updatedAnalysis = this.analyzeStrategicNeeds();

  // PRIORITAS 2: Beli boosters HANYA dengan sisa AP setelah plants
  if (updatedAnalysis.needs.boosters > 0) {
    if (updatedAnalysis.buyPlan.boosters.quantity > 0) {
      const boosterSuccess = await this.buyItem("quantum-fertilizer", updatedAnalysis.buyPlan.boosters.quantity);
      if (boosterSuccess) {
        results.boostersBought = updatedAnalysis.buyPlan.boosters.quantity;
        results.totalSpentAP += updatedAnalysis.buyPlan.boosters.quantity * updatedAnalysis.buyPlan.boosters.cost;
        results.messages.push(`Bought ${results.boostersBought} boosters with remaining AP`);
        
        // Refresh state after buying boosters
        await this.getState();
      }
    } else {
      // Skip boosters karena prioritas plants
      results.skippedBoosters = updatedAnalysis.needs.boosters;
      results.messages.push(`Skipped ${results.skippedBoosters} boosters (plants priority, insufficient remaining AP)`);
    }
  }

  // Re-analyze lagi untuk plot purchase
  const finalAnalysis = this.analyzeStrategicNeeds();

  // PRIORITAS 3: Beli plot dengan sisa budget setelah plants dan boosters
  if (finalAnalysis.buyPlan.plot.shouldBuy) {
    if (finalAnalysis.buyPlan.plot.canAfford) {
      const plotSuccess = await this.buyPlot();
      if (plotSuccess) {
        results.plotsBought = 1;
        if (finalAnalysis.buyPlan.plot.currency === "coins") {
          results.totalSpentCoins += finalAnalysis.buyPlan.plot.cost;
        } else {
          results.totalSpentAP += finalAnalysis.buyPlan.plot.cost;
        }
        results.messages.push(`Bought 1 new plot`);
      }
    } else {
      results.skippedPlots = 1;
      results.messages.push(`Skipped plot purchase (plants priority, insufficient ${finalAnalysis.buyPlan.plot.currency})`);
    }
  }

  // Success jika minimal seeds terpenuhi (plants first priority)
  const currentAnalysis = this.analyzeStrategicNeeds();
  results.success = currentAnalysis.hasEnoughSeeds;
  
  // Add summary message
  if (results.success) {
    results.messages.push(`SUCCESS: Plants prioritized, boosters with remaining AP`);
  }
  
  return results;
};

// Auto Plant Seeds
GameStateManager.prototype.autoPlantSeeds = async function() {
  const emptyPlots = this.getEmptyPlots();
  
  if (emptyPlots.length === 0) {
    return { planted: 0, total: 0, success: true };
  }

  // PRIORITAS: Gunakan seed yang tersedia di inventory
  const availableSeed = this.getBestAvailableSeed();
  
  if (!availableSeed) {
    return { planted: 0, total: emptyPlots.length, success: false, reason: "No seeds in inventory" };
  }

  const availableCount = this.getItemCount(availableSeed);
  const maxPlantable = Math.min(emptyPlots.length, availableCount);

  const results = {
    planted: 0,
    failed: 0,
    total: maxPlantable,
    seedType: availableSeed,
    success: false
  };

  for (let i = 0; i < maxPlantable; i++) {
    const plot = emptyPlots[i];
    
    const success = await this.plantSeed(plot.slotIndex, availableSeed);
    if (success) {
      results.planted++;
    } else {
      results.failed++;
    }

    if (i < maxPlantable - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  results.success = results.planted === maxPlantable;
  return results;
};

// Auto Apply Boosters dengan plant-first logic
GameStateManager.prototype.autoApplyBoosters = async function(modifierKey = "quantum-fertilizer") {
  const plotsNeedingBooster = this.getPlotsNeedingBooster();
  const availableBoosters = this.getItemCount(modifierKey);

  if (plotsNeedingBooster.length === 0) {
    return { 
      applied: 0, 
      total: 0, 
      skipped: 0,
      success: true,
      message: "No plots need boosters"
    };
  }

  if (availableBoosters === 0) {
    return { 
      applied: 0, 
      total: plotsNeedingBooster.length, 
      skipped: plotsNeedingBooster.length,
      success: true,
      message: `Skipped ${plotsNeedingBooster.length} plots (no boosters available, plants priority)`
    };
  }

  const maxApplicable = Math.min(plotsNeedingBooster.length, availableBoosters);

  const results = {
    applied: 0,
    failed: 0,
    skipped: Math.max(0, plotsNeedingBooster.length - availableBoosters),
    total: plotsNeedingBooster.length,
    success: false
  };

  // Apply boosters sesuai yang tersedia setelah plants priority
  for (let i = 0; i < maxApplicable; i++) {
    const plot = plotsNeedingBooster[i];
    
    const success = await this.applyBooster(plot.slotIndex, modifierKey);
    if (success) {
      results.applied++;
    } else {
      results.failed++;
    }

    // Delay antar aplikasi untuk menghindari rate limiting
    if (i < maxApplicable - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  results.success = results.applied >= 0;
  
  if (results.skipped > 0) {
    results.message = `Applied ${results.applied}, skipped ${results.skipped} (plants priority, insufficient boosters)`;
  } else {
    results.message = `Applied ${results.applied} boosters`;
  }
  
  return results;
};

// Smart Timing Calculator
GameStateManager.prototype.calculateNextActionTime = function() {
  const currentTime = Date.now();
  const upcomingActions = [];

  if (this.gameState?.plots) {
    for (const plot of this.gameState.plots) {
      if (plot.seed?.endsAt) {
        const harvestTime = new Date(plot.seed.endsAt).getTime();
        if (harvestTime > currentTime) {
          upcomingActions.push({
            type: 'harvest',
            time: harvestTime,
            description: `Harvest ${plot.seed.key} slot ${plot.slotIndex}`
          });
        }
      }
    }
  }

  if (this.gameState?.lastFarmhouseAt) {
    const lastClaimTime = new Date(this.gameState.lastFarmhouseAt).getTime();
    const nextClaimTime = lastClaimTime + (24 * 60 * 60 * 1000);
    if (nextClaimTime > currentTime) {
      upcomingActions.push({
        type: 'claim',
        time: nextClaimTime,
        description: 'Claim farmhouse'
      });
    }
  }

  if (this.gameState?.plots) {
    for (const plot of this.gameState.plots) {
      if (plot.modifier?.endsAt) {
        const expireTime = new Date(plot.modifier.endsAt).getTime();
        if (expireTime > currentTime) {
          upcomingActions.push({
            type: 'booster',
            time: expireTime,
            description: `Booster expire slot ${plot.slotIndex}`
          });
        }
      }
    }
  }

  upcomingActions.sort((a, b) => a.time - b.time);

  if (upcomingActions.length > 0) {
    const nextAction = upcomingActions[0];
    const waitTime = nextAction.time - currentTime;
    
    return {
      waitTime: Math.max(1000, waitTime),
      action: nextAction,
      allActions: upcomingActions
    };
  }

  return {
    waitTime: 60000,
    action: { type: 'check', description: 'Routine check' },
    allActions: []
  };
};

GameStateManager.prototype.formatTimeRemaining = function(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
};

// Account Worker untuk processing individual dengan plant-first strategy
class AccountWorker {
  constructor(stateManager, accountIndex) {
    this.stateManager = stateManager;
    this.accountIndex = accountIndex;
    this.isRunning = false;
    this.lastActionTime = 0;
    this.lastStatusUpdate = Date.now();
    this.proxyInfo = this.stateManager.proxyUrl ? 
      this.stateManager.proxyUrl.replace(/\/\/.*@/, '//***@') : 'No Proxy';
    this.stats = {
      farmhouseClaimed: 0,
      harvested: 0,
      planted: 0,
      boosted: 0,
      purchased: 0,
      prestiged: 0,
      lastAction: 'Starting...',
      nextAction: 'Loading...',
      nextTime: '',
      proxy: this.proxyInfo
    };
  }

  logAction(action) {
    // Remove individual logging to prevent cluttering the display
    return;
  }

  async processAccount() {
    try {
      await this.stateManager.getState();
      
      let hasAnyAction = false;
      const actions = [];

      // 1. Farmhouse
      const claimStatus = this.stateManager.canClaimFarmhouse();
      if (claimStatus.canClaim) {
        const claimResult = await this.stateManager.autoClaimFarmhouse();
        if (claimResult) {
          hasAnyAction = true;
          this.stats.farmhouseClaimed++;
          actions.push('Farmhouse claimed');
          await this.stateManager.getState();
        }
      }

      // 2. Harvest
      const readyPlots = this.stateManager.getPlotsReadyToHarvest();
      if (readyPlots.length > 0) {
        const harvestResult = await this.stateManager.autoHarvest();
        if (harvestResult.success) {
          hasAnyAction = true;
          this.stats.harvested += harvestResult.harvested;
          actions.push(`Harvested ${harvestResult.harvested}`);
          await this.stateManager.getState();
        }
      }

      // 2.5. Auto Prestige (setelah harvest, sebelum buy)
      const prestigeCheck = this.stateManager.canPrestige();
      if (prestigeCheck.canPrestige) {
        const prestigeResult = await this.stateManager.autoPrestige();
        if (prestigeResult.success) {
          hasAnyAction = true;
          this.stats.prestiged++;
          actions.push(`Prestige LV${prestigeResult.newLevel}`);
          this.lastActionTime = Date.now();
          this.stats.lastAction = actions.join(', ');
          
          return {
            waitTime: 5000,
            action: { type: 'prestige_cooldown', description: 'Post-prestige cooldown' },
            hasAction: true
          };
        }
      }

      // 3. Buy - PLANTS FIRST STRATEGY
      const analysis = this.stateManager.analyzeStrategicNeeds();
      
      // Check jika perlu beli sesuatu dengan plants-first priority
      const needSeeds = analysis.needs.seeds > 0;
      const canAffordSeeds = analysis.buyPlan.seeds.quantity > 0;
      const needBoosters = analysis.needs.boosters > 0;
      const canAffordBoosters = analysis.buyPlan.boosters.quantity > 0;
      const canAffordPlots = analysis.buyPlan.plot.shouldBuy && analysis.buyPlan.plot.canAfford;
      
      if (needSeeds && canAffordSeeds) {
        // PRIORITAS PLANTS: Selalu beli seeds yang dibutuhkan
        const buyResult = await this.stateManager.autoStrategicBuy();
        
        if (buyResult.seedsBought > 0 || buyResult.boostersBought > 0 || buyResult.plotsBought > 0) {
          hasAnyAction = true;
          this.stats.purchased++;
          const items = [];
          if (buyResult.seedsBought > 0) items.push(`${buyResult.seedsBought}s`);
          if (buyResult.boostersBought > 0) items.push(`${buyResult.boostersBought}b`);
          if (buyResult.plotsBought > 0) items.push(`${buyResult.plotsBought}p`);
          actions.push(`Bought ${items.join(',')}`);
          await this.stateManager.getState();
        }
      } else if ((needBoosters && canAffordBoosters) || canAffordPlots) {
        // Hanya beli booster/plot jika tidak ada kebutuhan seeds urgent
        const buyResult = await this.stateManager.autoStrategicBuy();
        
        if (buyResult.boostersBought > 0 || buyResult.plotsBought > 0) {
          hasAnyAction = true;
          this.stats.purchased++;
          const items = [];
          if (buyResult.boostersBought > 0) items.push(`${buyResult.boostersBought}b`);
          if (buyResult.plotsBought > 0) items.push(`${buyResult.plotsBought}p`);
          actions.push(`Bought ${items.join(',')}`);
          await this.stateManager.getState();
        }
      }

      // 4. Plant - prioritas setelah seeds dibeli
      const emptyPlots = this.stateManager.getEmptyPlots();
      if (emptyPlots.length > 0) {
        const seedStrategy = this.stateManager.determinePlantingStrategy();
        const availableSeeds = this.stateManager.getItemCount(seedStrategy);
        
        if (availableSeeds > 0) {
          const plantResult = await this.stateManager.autoPlantSeeds();
          if (plantResult.planted > 0) {
            hasAnyAction = true;
            this.stats.planted += plantResult.planted;
            actions.push(`Planted ${plantResult.planted}`);
            await this.stateManager.getState();
          }
        }
      }

      // 5. Boosters - hanya jika ada yang tersedia setelah plants priority
      const plotsNeedingBooster = this.stateManager.getPlotsNeedingBooster();
      const availableBoosters = this.stateManager.getItemCount("quantum-fertilizer");
      
      if (plotsNeedingBooster.length > 0 && availableBoosters > 0) {
        const boostResult = await this.stateManager.autoApplyBoosters();
        if (boostResult.applied > 0) {
          hasAnyAction = true;
          this.stats.boosted += boostResult.applied;
          actions.push(`Boosted ${boostResult.applied}`);
          await this.stateManager.getState();
        }
      }

      // Update stats and timing for countdown
      const timing = this.stateManager.calculateNextActionTime();
      this.lastStatusUpdate = Date.now();
      
      if (hasAnyAction) {
        this.lastActionTime = Date.now();
        this.stats.lastAction = actions.join(', ');
        
        return {
          waitTime: 2000,
          action: { type: 'recheck', description: 'Quick recheck' },
          hasAction: true
        };
      } else {
        this.stats.nextAction = timing.action.description;
        this.stats.nextTime = this.stateManager.formatTimeRemaining(timing.waitTime);
        
        return {
          ...timing,
          hasAction: false
        };
      }

    } catch (error) {
      return {
        waitTime: 60000,
        action: { type: 'error', description: 'Error recovery' },
        hasAction: false,
        error: error.message
      };
    }
  }

  async startWorker() {
    this.isRunning = true;
    
    while (this.isRunning) {
      try {
        const result = await this.processAccount();
        
        const timeSinceLastAction = Date.now() - this.lastActionTime;
        const minDelayBetweenActions = 3000;
        
        let actualWaitTime = result.waitTime;
        if (result.hasAction && timeSinceLastAction < minDelayBetweenActions) {
          actualWaitTime = Math.max(actualWaitTime, minDelayBetweenActions - timeSinceLastAction);
        }
        
        actualWaitTime = Math.max(1000, Math.min(actualWaitTime, 600000));
        
        await new Promise(resolve => setTimeout(resolve, actualWaitTime));
        
      } catch (error) {
        await new Promise(resolve => setTimeout(resolve, 60000));
      }
    }
  }

  stop() {
    this.isRunning = false;
  }

  getStats() {
    return this.stats;
  }
}

// Parallel Auto Monitor dengan Enhanced Display dan Plant-First Strategy
class ParallelAutoMonitor {
  constructor() {
    this.isRunning = false;
    this.accounts = [];
    this.workers = [];
    this.startTime = Date.now();
    this.lastStatus = '';
  }

  async loadAccounts() {
    const cookieManager = new CookieManager();
    await cookieManager.loadCookies();
    
    this.accounts = [];
    for (let i = 0; i < cookieManager.getCount(); i++) {
      const stateManager = new GameStateManager();
      await stateManager.loadCookieFromFile(i);
      this.accounts.push(stateManager);
    }
    
    console.log(`Loaded ${this.accounts.length} accounts for parallel processing`);
  }

  printStatus() {
    console.clear();
    
    const uptime = Math.floor((Date.now() - this.startTime) / 1000 / 60);
    console.log(`APPLEVILLE BOT v3.1 PLANTS-FIRST - Uptime: ${uptime}m | Total Accounts: ${this.accounts.length} | ${new Date().toLocaleTimeString()}`);
    console.log('='.repeat(130));
    
    // Account status per line
    this.workers.forEach((worker, index) => {
      const stats = worker.getStats();
      const state = worker.stateManager.gameState;
      const userInfo = worker.stateManager.userInfo;
      
      // Format AP properly
      let apFormatted;
      const ap = state?.ap || 0;
      if (ap >= 1000000) {
        apFormatted = `${(ap / 1000000).toFixed(1)}M`;
      } else if (ap >= 1000) {
        apFormatted = `${(ap / 1000).toFixed(1)}k`;
      } else {
        apFormatted = ap.toString();
      }
      
      const coins = state?.coins || 0;
      const prestigeLevel = userInfo?.prestigeLevel || 0;
      
      // Get detailed status with PLANTS-FIRST PRIORITY LOGIC
      let statusText = 'Idle';
      const readyPlots = worker.stateManager.getPlotsReadyToHarvest();
      const emptyPlots = worker.stateManager.getEmptyPlots();
      const needBoosters = worker.stateManager.getPlotsNeedingBooster();
      const availableBoosters = worker.stateManager.getItemCount("quantum-fertilizer");
      const claimStatus = worker.stateManager.canClaimFarmhouse();
      const prestigeCheck = worker.stateManager.canPrestige();
      const timing = worker.stateManager.calculateNextActionTime();
      
      // Calculate real-time countdown
      const currentTime = Date.now();
      const remainingTime = Math.max(0, timing.waitTime - (currentTime - (worker.lastStatusUpdate || currentTime)));
      const countdownText = worker.stateManager.formatTimeRemaining(remainingTime);
      
      // ENHANCED PRIORITY LOGIC dengan PLANTS-FIRST strategy
      if (readyPlots.length > 0) {
        // PRIORITY 1: Ready to harvest
        const seedGroups = {};
        readyPlots.forEach(plot => {
          if (!seedGroups[plot.seedKey]) {
            seedGroups[plot.seedKey] = [];
          }
          seedGroups[plot.seedKey].push(plot.slotIndex);
        });
        
        const statusParts = Object.entries(seedGroups).map(([seedKey, slots]) => 
          `Panen ${seedKey} slot ${slots.join(',')}`
        );
        
        statusText = statusParts.join(' | ');
        
      } else if (claimStatus.canClaim) {
        // PRIORITY 2: Farmhouse ready to claim
        statusText = 'Claim farmhouse';
        
      } else if (prestigeCheck.canPrestige) {
        // PRIORITY 3: Can prestige
        statusText = `Prestige ready LV${prestigeCheck.currentLevel}→${prestigeCheck.nextLevel}`;
        
      } else if (emptyPlots.length > 0) {
        // PRIORITY 4: PLANTS FIRST - Empty plots need planting
        const seedStrategy = worker.stateManager.determinePlantingStrategy();
        const availableSeeds = worker.stateManager.getItemCount(seedStrategy);
        const analysis = worker.stateManager.analyzeStrategicNeeds();
        
        if (availableSeeds > 0) {
          const plotNumbers = emptyPlots.slice(0, Math.min(emptyPlots.length, availableSeeds))
            .map(plot => plot.slotIndex).join(',');
          statusText = `Tanam ${seedStrategy} slot ${plotNumbers}`;
        } else if (analysis.buyPlan.seeds.quantity > 0) {
          statusText = `Beli ${seedStrategy} (PLANTS FIRST)`;
        } else {
          statusText = `Tunggu AP untuk ${seedStrategy} (PLANTS PRIORITY)`;
        }
        
      } else if (needBoosters.length > 0 && availableBoosters > 0) {
        // PRIORITY 5: Apply available boosters (after plants satisfied)
        const plotNumbers = needBoosters.slice(0, Math.min(needBoosters.length, availableBoosters))
          .map(plot => plot.slotIndex).join(',');
        statusText = `Boost slot ${plotNumbers}`;
        
      } else {
        // PRIORITY 6: Show next upcoming action with PLANTS-FIRST context
        if (timing.action.type === 'harvest') {
          const harvestDetails = timing.action.description.replace('Harvest ', '').replace(' slot ', ' slot ');
          statusText = `Menunggu panen ${harvestDetails} dalam ${countdownText}`;
          
        } else if (timing.action.type === 'claim') {
          statusText = `Menunggu claim farmhouse dalam ${countdownText}`;
          
        } else if (timing.action.type === 'booster') {
          const boosterDetails = timing.action.description.replace('Booster expire ', '');
          statusText = `Menunggu booster expire ${boosterDetails} dalam ${countdownText}`;
          
        } else {
          // Check plants-first context
          if (needBoosters.length > 0) {
            const analysis = worker.stateManager.analyzeStrategicNeeds();
            if (analysis.buyPlan.boosters.quantity > 0) {
              statusText = 'Beli booster (setelah plants priority)';
            } else {
              // Show next harvest instead of being stuck at no booster
              if (timing.allActions && timing.allActions.length > 0) {
                const nextHarvest = timing.allActions.find(action => action.type === 'harvest');
                if (nextHarvest) {
                  const harvestTime = nextHarvest.time - currentTime;
                  const harvestCountdown = worker.stateManager.formatTimeRemaining(harvestTime);
                  const harvestDetails = nextHarvest.description.replace('Harvest ', '').replace(' slot ', ' slot ');
                  statusText = `Menunggu panen ${harvestDetails} dalam ${harvestCountdown}`;
                } else {
                  statusText = `Skip booster (PLANTS FIRST: AP ${ap}/175)`;
                }
              } else {
                statusText = `Skip booster (PLANTS FIRST: AP ${ap}/175)`;
              }
            }
          } else {
            statusText = `Menunggu check rutin dalam ${countdownText}`;
          }
        }
      }
      
      // Format proxy info
      const proxyStatus = stats.proxy === 'No Proxy' ? 'Direct' : stats.proxy.split('@')[1] || 'Proxy';
      
      // Enhanced prestige info display dengan plants-first context
      let prestigeInfo = `LV${prestigeLevel}`;
      if (prestigeLevel < 7) {
        if (prestigeCheck.canPrestige) {
          prestigeInfo += ` (READY→${prestigeCheck.nextLevel})`;
        } else {
          const nextLevel = prestigeLevel + 1;
          const nextRequirement = CONFIG.PRESTIGE.LEVELS[nextLevel];
          if (nextRequirement) {
            const currentAP = ap;
            const shortage = nextRequirement.required - currentAP;
            
            if (shortage < 1000) {
              prestigeInfo += ` (${shortage}AP)`;
            } else if (shortage < 1000000) {
              prestigeInfo += ` (${Math.round(shortage/1000)}k AP)`;
            } else {
              prestigeInfo += ` (${(shortage/1000000).toFixed(1)}M AP)`;
            }
          }
        }
      } else {
        prestigeInfo += ` (MAX)`;
      }
      
      console.log(`[AKUN ${index + 1}] AP: ${apFormatted} | Coins: ${coins} | ${prestigeInfo} | ${proxyStatus} | ${statusText}`);
    });
    
    console.log('='.repeat(130));
    console.log(`Strategy: PLANTS-FIRST Priority | LV0: Golden | LV1-6: Legacy→Golden | LV7+: Apex→Legacy→Golden`);
  }

  async startParallelMonitoring() {
    if (this.isRunning) {
      console.log("Parallel monitoring already running");
      return;
    }

    await this.loadAccounts();
    this.isRunning = true;
    this.startTime = Date.now();

    // Create workers
    this.workers = this.accounts.map((stateManager, index) => 
      new AccountWorker(stateManager, index)
    );

    console.log(`Starting ${this.workers.length} parallel workers with PLANTS-FIRST strategy...`);

    // Start all workers
    const workerPromises = this.workers.map((worker, index) => {
      return new Promise(async (resolve, reject) => {
        try {
          await new Promise(resolve => setTimeout(resolve, index * 1000));
          await worker.startWorker();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });

    // Status display loop
    const statusInterval = setInterval(() => {
      if (!this.isRunning) {
        clearInterval(statusInterval);
        return;
      }
      this.printStatus();
    }, 3000);

    try {
      await Promise.all(workerPromises);
    } catch (error) {
      console.error("Error in parallel monitoring:", error.message);
    } finally {
      clearInterval(statusInterval);
    }
  }

  stop() {
    console.log("Stopping PLANTS-FIRST parallel monitoring...");
    this.isRunning = false;
    this.workers.forEach(worker => worker.stop());
    console.log("PLANTS-FIRST parallel monitoring stopped");
  }
}

// Main Functions
async function runSingleAccount(accountIndex = 0) {
  const stateManager = new GameStateManager();
  
  try {
    await stateManager.loadCookieFromFile(accountIndex);
    await stateManager.getState();
    
    console.log("=== STATUS AWAL ===");
    stateManager.displayInfo();
    
    console.log("\n=== MENJALANKAN PLANTS-FIRST STRATEGY ===");
    
    // 1. Claim farmhouse
    console.log("1. Checking farmhouse...");
    await stateManager.autoClaimFarmhouse();
    
    // 2. Harvest ready plots
    console.log("2. Harvesting ready plots...");
    await stateManager.autoHarvest();
    
    // 3. PLANTS FIRST: Buy dengan prioritas tanaman
    console.log("3. PLANTS-FIRST: Strategic buying (plants priority)...");
    const buyResult = await stateManager.autoStrategicBuy();
    if (buyResult.messages.length > 0) {
      buyResult.messages.forEach(msg => console.log(`   ${msg}`));
    }
    
    // 4. Plant seeds
    console.log("4. Planting seeds...");
    await stateManager.autoPlantSeeds();
    
    // 5. Apply boosters dengan sisa AP
    console.log("5. Applying boosters (with remaining AP)...");
    await stateManager.autoApplyBoosters("quantum-fertilizer");
    
    // 6. Check prestige
    console.log("6. Checking prestige opportunity...");
    const prestigeResult = await stateManager.autoPrestige();
    if (prestigeResult.success) {
      console.log(`   PRESTIGE SUCCESS: Level ${prestigeResult.oldLevel} → ${prestigeResult.newLevel}`);
    }
    
    console.log("\n=== STATUS AKHIR ===");
    stateManager.displayInfo();
    
  } catch (error) {
    console.error("Error:", error.message);
  }
}

async function startParallelBot() {
  const monitor = new ParallelAutoMonitor();
  await monitor.startParallelMonitoring();
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONFIG,
    generateNonce,
    createSignature,
    createAuthHeaders,
    makeHttpRequest,
    ProxyManager,
    CaptchaHandler,
    CookieManager,
    GameStateManager,
    AccountWorker,
    ParallelAutoMonitor,
    runSingleAccount,
    startParallelBot
  };
}

// Auto start dengan informasi strategi plants-first
if (require.main === module) {
  console.log("=".repeat(80));
  console.log("APPLEVILLE PARALLEL BOT v3.1 - PLANTS-FIRST STRATEGY");
  console.log("=".repeat(80));
  console.log("");
  
  console.log("🌱 STRATEGI PENANAMAN BARU:");
  console.log("  • Prestige Level 0: Golden Apple");
  console.log("  • Prestige Level 1-6: Legacy Apple → fallback Golden Apple");
  console.log("  • Prestige Level 7+: Apex Apple → fallback Legacy/Golden Apple");
  console.log("");
  
  console.log("⚡ PRIORITAS PEMBELIAN (PLANTS-FIRST):");
  console.log("  1. TANAMAN dulu (WAJIB) - ensure bisa tanam semua plot");
  console.log("  2. BOOSTER dengan sisa AP setelah tanaman");
  console.log("  3. PLOT dengan sisa budget setelah tanaman & booster");
  console.log("");
  
  console.log("🎯 KEUNGGULAN:");
  console.log("  • Tidak stuck karena tidak mampu beli Royal/Apex Apple mahal");
  console.log("  • AP dialokasikan optimal: tanaman dulu, booster kemudian");
  console.log("  • Strategi adaptif sesuai prestige level dan budget");
  console.log("  • Auto prestige support tetap aktif");
  console.log("  • Proxy support & CAPTCHA handling");
  console.log("");
  
  console.log("📝 CLEAN CODE IMPROVEMENTS:");
  console.log("  • Struktur kode lebih modular dan mudah maintenance");
  console.log("  • Logic pembelian yang jelas dan terstruktur");
  console.log("  • Enhanced display dengan informasi plants-first strategy");
  console.log("  • Better error handling dan status tracking");
  console.log("");
  
  console.log("Starting PLANTS-FIRST bot in 3 seconds...");
  console.log("=".repeat(80));
  
  setTimeout(() => {
    startParallelBot().catch(error => {
      console.error("Error starting PLANTS-FIRST bot:", error.message);
      process.exit(1);
    });
  }, 3000);
}
