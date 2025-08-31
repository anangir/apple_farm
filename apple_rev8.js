const crypto = require("crypto");
const axios = require("axios");
const https = require("https");
const http = require("http");
const fs = require("fs/promises");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { HttpProxyAgent } = require("http-proxy-agent");
const { URL } = require("url");

// Enhanced Configuration with Smart Booster Strategy
const HEADER_KEYS = {
  META_HASH: "x-xcsa3d",
  CLIENT_TIME: "x-dbsv",
  TRACE_ID: "x-dsa"
};

const CONFIG = {
  MINIMUM_RESERVES: {
    AP: 100,
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
    "quantum-fertilizer": { cost: 175, currency: "ap" },
    "apex-potion": { cost: 5000, currency: "ap" }
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
  // UPDATED: Smart Booster Strategy configuration
  BOOSTER_STRATEGY: {
    // Auto-buy boosters when needed
    AUTO_BUY_WHEN_NEEDED: true,
    // Apply boosters immediately after buying
    AUTO_APPLY_AFTER_BUY: true,
    // Prioritize plants over boosters in budget allocation
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

// Game State Manager Class - Enhanced with Smart Booster Strategy
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

  // FIXED: Accurate plots needing booster detection
  getPlotsNeedingBooster() {
    if (!this.gameState?.plots) return [];

    return this.gameState.plots
      .filter(plot => {
        // Plot butuh booster jika tidak punya modifier atau modifier expired
        return !plot.modifier || this.isModifierExpired(plot.modifier);
      })
      .map(plot => ({
        slotIndex: plot.slotIndex,
        id: plot.id,
        hasSeed: !!plot.seed,
        currentModifier: plot.modifier?.key || null,
        modifierExpired: plot.modifier ? this.isModifierExpired(plot.modifier) : true
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

  // Plant Strategy Methods
  determinePlantingStrategy() {
    const totalPlots = this.gameState?.numPlots || 0;
    const prestigeLevel = this.userInfo?.prestigeLevel || 0;
    const nextPlotPrice = this.gameState?.nextPlotPrice;
    const currentAP = this.gameState?.ap || 0;
    
    // PRIORITAS 1: Gunakan yang ada di inventory terlebih dahulu
    const goldenAppleCount = this.getItemCount("golden-apple");
    const legacyAppleCount = this.getItemCount("legacy-apple");
    const apexAppleCount = this.getItemCount("apex-apple");
    const wheatCount = this.getItemCount("wheat");
    
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

    // PRIORITAS 2: Jika masih bisa beli plot, ikuti currency next plot
    if (nextPlotPrice && nextPlotPrice.currency && totalPlots < 12) {
      const currency = nextPlotPrice.currency.toLowerCase();
      
      if (currency === "coins") {
        return "wheat";
      } else if (currency === "ap") {
        if (prestigeLevel >= 1) {
          const legacyAppleCost = CONFIG.ITEMS["legacy-apple"].cost;
          if (currentAP >= legacyAppleCost) {
            return "legacy-apple";
          } else {
            return "golden-apple";
          }
        } else {
          return "golden-apple";
        }
      }
    }

    // PRIORITAS 3: Jika sudah 12 plots (maksimal)
    if (totalPlots >= 12) {
      if (prestigeLevel >= 7) {
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
        const legacyAppleCost = CONFIG.ITEMS["legacy-apple"].cost;
        if (currentAP >= legacyAppleCost) {
          return "legacy-apple";
        } else {
          return "golden-apple";
        }
      } else {
        return "golden-apple";
      }
    }

    // PRIORITAS 4: Fallback strategy
    if (prestigeLevel >= 1) {
      return "legacy-apple";
    } else {
      return "golden-apple";
    }
  }
  
  getBestAvailableSeed() {
    const prestigeLevel = this.userInfo?.prestigeLevel || 0;
  
    const seedPriorities = [];
  
    if (prestigeLevel >= 7) {
      seedPriorities.push("apex-apple", "legacy-apple", "golden-apple", "wheat");
    } else if (prestigeLevel >= 1) {
      seedPriorities.push("legacy-apple", "golden-apple", "wheat");
    } else {
      seedPriorities.push("golden-apple", "wheat");
    }
  
    for (const seed of seedPriorities) {
      if (this.getItemCount(seed) > 0) {
        return seed;
      }
    }
  
    return null;
  }

  // Booster Strategy Method
  determineBoosterStrategy() {
    const prestigeLevel = this.userInfo?.prestigeLevel || 0;
    if (prestigeLevel >= 7) {
      return "apex-potion";  // Level 7+ pakai apex-potion
    } else {
      return "quantum-fertilizer";  // Level 0-6 pakai quantum-fertilizer
    }
  }

  // Affordability Check
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

  // Smart Timing Calculator
  calculateNextActionTime() {
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
  }

  formatTimeRemaining(milliseconds) {
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
  }

  // Display Information
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
    console.log(`Strategi: ${analysis.seedStrategy} seeds + ${analysis.boosterStrategy} boosters`);
    console.log(`Seeds: ${analysis.inventory.wheat}W, ${analysis.inventory["golden-apple"]}G, ${analysis.inventory["royal-apple"]}R, ${analysis.inventory["legacy-apple"]}L, ${analysis.inventory["apex-apple"]}A`);
    console.log(`Boosters: ${analysis.inventory["quantum-fertilizer"]} quantum, ${analysis.inventory["apex-potion"]} apex`);
    
    const bestAvailable = this.getBestAvailableSeed();
    if (bestAvailable) {
      const availableCount = this.getItemCount(bestAvailable);
      console.log(`Best Available: ${availableCount} ${bestAvailable} (will plant this first)`);
    } else {
      console.log(`Best Available: None (need to buy seeds)`);
    }
    
    // FIXED: Display booster needs accurately
    const plotsNeedingBooster = this.getPlotsNeedingBooster();
    if (plotsNeedingBooster.length > 0) {
      console.log(`BOOSTER NEEDS: ${plotsNeedingBooster.length} plots need ${analysis.boosterStrategy}`);
      const currentBoosterCount = this.getItemCount(analysis.boosterStrategy);
      if (currentBoosterCount >= plotsNeedingBooster.length) {
        console.log(`BOOSTER STATUS: SUFFICIENT (have ${currentBoosterCount}, need ${plotsNeedingBooster.length})`);
      } else {
        const boosterShortage = plotsNeedingBooster.length - currentBoosterCount;
        console.log(`BOOSTER STATUS: NEED ${boosterShortage} MORE (have ${currentBoosterCount}, need ${plotsNeedingBooster.length})`);
      }
    } else {
      console.log(`BOOSTER STATUS: ALL PLOTS COVERED`);
    }
    
    if (analysis.needs.seeds > 0) {
      console.log(`SEED NEEDS: ${analysis.needs.seeds} ${analysis.seedStrategy}`);
      console.log(`SEED BUDGET: Can afford ${analysis.affordable.seeds} seeds`);
    }
    
    if (analysis.readyToPlant) {
      console.log(`STATUS: SIAP TANAM`);
    }
    
    console.log("=====================");
  }
}

// Prestige Methods
GameStateManager.prototype.canPrestige = function() {
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
};

GameStateManager.prototype.performPrestige = async function() {
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
};

GameStateManager.prototype.autoPrestige = async function() {
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
};

// Farmhouse Methods
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
    const requiredTotal = cost + CONFIG.MINIMUM_RESERVES.COINS;
    if (currentCoins < requiredTotal) {
      console.log(`Skip buy plot: Need ${requiredTotal} coins (${cost} + ${CONFIG.MINIMUM_RESERVES.COINS} reserve), have ${currentCoins}`);
      return false;
    }
  } else if (currency === "ap") {
    const requiredTotal = cost + CONFIG.MINIMUM_RESERVES.AP;
    if (currentAP < requiredTotal) {
      console.log(`Skip buy plot: Need ${requiredTotal} AP (${cost} + ${CONFIG.MINIMUM_RESERVES.AP} reserve), have ${currentAP}`);
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

// MAIN FIX: Smart Booster Application dengan Auto-Buy
GameStateManager.prototype.smartApplyBoosters = async function(modifierKey = null) {
  if (!modifierKey) {
    modifierKey = this.determineBoosterStrategy();
  }
  
  // STEP 1: Cek plot mana yang butuh booster
  const plotsNeedingBooster = this.getPlotsNeedingBooster();
  
  if (plotsNeedingBooster.length === 0) {
    return { 
      applied: 0, 
      bought: 0,
      total: 0, 
      success: true,
      message: "No plots need boosters"
    };
  }
  
  // STEP 2: Cek inventory booster yang tersedia
  let availableBoosters = this.getItemCount(modifierKey);
  let boostersBought = 0;
  
  console.log(`[SMART BOOSTER] ${plotsNeedingBooster.length} plots need booster, ${availableBoosters} ${modifierKey} in inventory`);
  
  // STEP 3: Beli booster jika inventory tidak cukup
  if (availableBoosters < plotsNeedingBooster.length) {
    const boostersNeeded = plotsNeedingBooster.length - availableBoosters;
    console.log(`[SMART BOOSTER] Need to buy ${boostersNeeded} more ${modifierKey}`);
    
    // Cek affordability
    const boosterCost = CONFIG.ITEMS[modifierKey].cost;
    const currentAP = this.gameState?.ap || 0;
    const affordableBoosters = Math.floor(currentAP / boosterCost);
    const canBuy = Math.min(boostersNeeded, affordableBoosters);
    
    if (canBuy > 0) {
      console.log(`[SMART BOOSTER] Buying ${canBuy} ${modifierKey} (need ${boostersNeeded}, can afford ${affordableBoosters})`);
      
      const buySuccess = await this.buyItem(modifierKey, canBuy);
      if (buySuccess) {
        boostersBought = canBuy;
        console.log(`[SMART BOOSTER] Successfully bought ${boostersBought} ${modifierKey}`);
        
        // Refresh state dan update available boosters
        await this.getState();
        availableBoosters = this.getItemCount(modifierKey);
      } else {
        console.log(`[SMART BOOSTER] Failed to buy ${modifierKey}`);
      }
    } else {
      console.log(`[SMART BOOSTER] Cannot afford any ${modifierKey} (need ${boosterCost * boostersNeeded} AP, have ${currentAP})`);
    }
  }
  
  // STEP 4: Apply boosters yang tersedia
  const maxApplicable = Math.min(plotsNeedingBooster.length, availableBoosters);
  
  const results = {
    applied: 0,
    bought: boostersBought,
    failed: 0,
    skipped: Math.max(0, plotsNeedingBooster.length - availableBoosters),
    total: plotsNeedingBooster.length,
    boosterType: modifierKey,
    success: false,
    message: ""
  };
  
  if (maxApplicable === 0) {
    results.message = `No ${modifierKey} available to apply (bought ${boostersBought}, need ${plotsNeedingBooster.length})`;
    results.success = true; // Success karena sudah beli yang bisa
    return results;
  }
  
  console.log(`[SMART BOOSTER] Applying ${maxApplicable} ${modifierKey} to plots`);
  
  // Apply boosters satu per satu
  for (let i = 0; i < maxApplicable; i++) {
    const plot = plotsNeedingBooster[i];
    
    console.log(`[SMART BOOSTER] Applying ${modifierKey} to slot ${plot.slotIndex}...`);
    const success = await this.applyBooster(plot.slotIndex, modifierKey);
    
    if (success) {
      results.applied++;
      console.log(`[SMART BOOSTER] SUCCESS: Applied ${modifierKey} to slot ${plot.slotIndex}`);
    } else {
      results.failed++;
      console.log(`[SMART BOOSTER] FAILED: Could not apply ${modifierKey} to slot ${plot.slotIndex}`);
    }

    // Delay antar aplikasi
    if (i < maxApplicable - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  // Generate hasil message
  const messageParts = [];
  if (results.bought > 0) {
    messageParts.push(`bought ${results.bought}`);
  }
  if (results.applied > 0) {
    messageParts.push(`applied ${results.applied}`);
  }
  if (results.skipped > 0) {
    messageParts.push(`skipped ${results.skipped}`);
  }
  
  results.message = `${modifierKey}: ${messageParts.join(', ')}`;
  results.success = results.applied > 0 || results.bought > 0;
  
  console.log(`[SMART BOOSTER] FINAL RESULT: ${results.message}`);
  return results;
};

// LEGACY: Keep old autoApplyBoosters for backward compatibility
GameStateManager.prototype.autoApplyBoosters = async function(modifierKey = null) {
  if (!modifierKey) {
    modifierKey = this.determineBoosterStrategy();
  }
  
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
      message: `Skipped ${plotsNeedingBooster.length} plots (no ${modifierKey} available, plants priority)`
    };
  }

  const maxApplicable = Math.min(plotsNeedingBooster.length, availableBoosters);

  const results = {
    applied: 0,
    failed: 0,
    skipped: Math.max(0, plotsNeedingBooster.length - availableBoosters),
    total: plotsNeedingBooster.length,
    boosterType: modifierKey,
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
    results.message = `Applied ${results.applied} ${modifierKey}, skipped ${results.skipped} (plants priority, insufficient boosters)`;
  } else {
    results.message = `Applied ${results.applied} ${modifierKey}`;
  }
  
  return results;
};

// FIXED: Strategic Needs Analysis dengan TRUE Plants-First Priority
GameStateManager.prototype.analyzeStrategicNeeds = function() {
  const emptyPlots = this.getEmptyPlotsCount();
  const totalPlots = this.gameState?.numPlots || 0;
  const nextPlotPrice = this.gameState?.nextPlotPrice;
  const seedStrategy = this.determinePlantingStrategy();
  const boosterStrategy = this.determineBoosterStrategy();
  
  // FIXED: Hitung kebutuhan booster berdasarkan plot yang benar-benar butuh
  const plotsNeedingBooster = this.getPlotsNeedingBooster();
  const needBoosters = plotsNeedingBooster.length; // <- PERBAIKAN UTAMA
  const currentBoosterCount = this.getItemCount(boosterStrategy);
  
  const wheatCount = this.getItemCount("wheat");
  const goldenAppleCount = this.getItemCount("golden-apple");
  const royalAppleCount = this.getItemCount("royal-apple");
  const legacyAppleCount = this.getItemCount("legacy-apple");
  const apexAppleCount = this.getItemCount("apex-apple");

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

  const currentCoins = this.gameState?.coins || 0;
  const currentAP = this.gameState?.ap || 0;

  // TRUE PLANTS FIRST: Seeds mendapat prioritas budget penuh, boosters tidak di-buy di sini
  const availableCoinsForSeeds = currentCoins; // Full budget untuk seeds
  const availableAPForSeeds = currentAP;       // Full budget untuk seeds

  // Calculate seed affordability dengan full budget
  let affordableSeeds = 0;
  let seedCost = 0;
  let seedCurrency = "";

  const seedConfig = CONFIG.ITEMS[seedStrategy];
  if (seedConfig) {
    seedCost = seedConfig.cost;
    seedCurrency = seedConfig.currency;
  
    if (seedCurrency === "coins") {
      affordableSeeds = Math.floor(availableCoinsForSeeds / seedCost);
    } else if (seedCurrency === "ap") {
      affordableSeeds = Math.floor(availableAPForSeeds / seedCost);
    }
  }

  // Calculate remaining budget after seeds (untuk plot calculation)
  let remainingAPAfterSeeds = availableAPForSeeds;
  let remainingCoinsAfterSeeds = availableCoinsForSeeds;

  if (seedCurrency === "ap") {
    const seedsToBuy = Math.min(needSeeds, affordableSeeds);
    remainingAPAfterSeeds = availableAPForSeeds - (seedsToBuy * seedCost);
  } else if (seedCurrency === "coins") {
    const seedsToBuy = Math.min(needSeeds, affordableSeeds);
    remainingCoinsAfterSeeds = availableCoinsForSeeds - (seedsToBuy * seedCost);
  }

  // Plot affordability check dengan reserve (setelah seeds)
  let canAffordPlot = false;
  let plotCost = 0;
  let plotCurrency = "";

  if (nextPlotPrice) {
    plotCost = nextPlotPrice.amount || 0;
    plotCurrency = (nextPlotPrice.currency || "").toLowerCase();
  
    if (plotCurrency === "coins") {
      const requiredCoinsForPlot = plotCost + CONFIG.MINIMUM_RESERVES.COINS;
      canAffordPlot = remainingCoinsAfterSeeds >= requiredCoinsForPlot;
    } else if (plotCurrency === "ap") {
      const requiredAPForPlot = plotCost + CONFIG.MINIMUM_RESERVES.AP;
      canAffordPlot = remainingAPAfterSeeds >= requiredAPForPlot;
    }
  }

  const buyPlan = {
    seeds: {
      type: seedStrategy,
      quantity: Math.min(needSeeds, affordableSeeds),
      cost: seedCost,
      currency: seedCurrency,
      priority: "HIGHEST" // Plants first priority
    },
    plot: {
      canAfford: canAffordPlot,
      cost: plotCost,
      currency: plotCurrency,
      shouldBuy: canAffordPlot && nextPlotPrice,
      priority: "MEDIUM" // Setelah plants
    },
    // Boosters TIDAK di-handle di sini, diserahkan ke smartApplyBoosters
    boosters: {
      type: boosterStrategy,
      quantity: 0, // Tidak dibeli di autoStrategicBuy
      cost: CONFIG.ITEMS[boosterStrategy].cost,
      currency: "ap",
      priority: "HANDLED_SEPARATELY", // Handled by smartApplyBoosters
      note: "Use smartApplyBoosters() instead"
    }
  };

  return {
    totalPlots,
    emptyPlots,
    nextPlotPrice,
    seedStrategy,
    boosterStrategy: boosterStrategy,
    inventory: {
      wheat: wheatCount,
      "golden-apple": goldenAppleCount,
      "royal-apple": royalAppleCount,
      "legacy-apple": legacyAppleCount,
      "apex-apple": apexAppleCount,
      "quantum-fertilizer": currentBoosterCount,
      "apex-potion": this.getItemCount("apex-potion")
    },
    budget: {
      coins: currentCoins,
      ap: currentAP,
      availableCoinsForSeeds: availableCoinsForSeeds,
      availableAPForSeeds: availableAPForSeeds,
      minimumReserves: CONFIG.MINIMUM_RESERVES,
      apAfterSeeds: remainingAPAfterSeeds
    },
    needs: {
      seeds: needSeeds,
      boosters: needBoosters // Accurate count untuk display/reference
    },
    affordable: {
      seeds: affordableSeeds,
      boosters: "handled_separately" // Tidak dihitung di sini
    },
    buyPlan,
    hasEnoughSeeds: currentSeedCount >= emptyPlots,
    hasEnoughBoosters: currentBoosterCount >= needBoosters,
    readyToPlant: currentSeedCount > 0,
    plantsFullySatisfied: emptyPlots === 0, // NEW: Indicator untuk booster readiness
    canAffordAllSeeds: buyPlan.seeds.quantity >= needSeeds
  };
};

// FIXED: autoStrategicBuy() HANYA untuk Seeds dan Plots (NO BOOSTERS)
GameStateManager.prototype.autoStrategicBuy = async function() {
  const analysis = this.analyzeStrategicNeeds();
  
  const results = {
    seedsBought: 0,
    plotsBought: 0,
    totalSpentCoins: 0,
    totalSpentAP: 0,
    skippedPlots: 0,
    success: false,
    messages: []
  };

  // PRIORITAS 1: PLANTS FIRST - Beli seeds dengan budget penuh
  if (analysis.buyPlan.seeds.quantity > 0) {
    console.log(`[PLANTS FIRST] Buying ${analysis.buyPlan.seeds.quantity} ${analysis.seedStrategy} with full budget priority...`);
    
    const seedSuccess = await this.buyItem(analysis.seedStrategy, analysis.buyPlan.seeds.quantity);
    if (seedSuccess) {
      results.seedsBought = analysis.buyPlan.seeds.quantity;
      if (analysis.buyPlan.seeds.currency === "coins") {
        results.totalSpentCoins += analysis.buyPlan.seeds.quantity * analysis.buyPlan.seeds.cost;
      } else {
        results.totalSpentAP += analysis.buyPlan.seeds.quantity * analysis.buyPlan.seeds.cost;
      }
      results.messages.push(`Bought ${results.seedsBought} ${analysis.seedStrategy} (PLANTS FIRST PRIORITY)`);
      
      // Refresh state after buying seeds
      await this.getState();
    }
  }

  // Re-analyze untuk plot purchase dengan budget yang tersisa setelah seeds
  const finalAnalysis = this.analyzeStrategicNeeds();

  // PRIORITAS 2: Beli plot dengan remaining budget setelah plants
  if (finalAnalysis.buyPlan.plot.shouldBuy && finalAnalysis.buyPlan.plot.canAfford) {
    console.log(`[PLANTS FIRST] Buying plot with remaining budget after seeds...`);
    const plotSuccess = await this.buyPlot();
    if (plotSuccess) {
      results.plotsBought = 1;
      if (finalAnalysis.buyPlan.plot.currency === "coins") {
        results.totalSpentCoins += finalAnalysis.buyPlan.plot.cost;
      } else {
        results.totalSpentAP += finalAnalysis.buyPlan.plot.cost;
      }
      results.messages.push(`Bought 1 new plot (after plants priority)`);
    }
  } else if (finalAnalysis.buyPlan.plot.shouldBuy) {
    results.skippedPlots = 1;
    results.messages.push(`Skipped plot purchase (plants consumed budget)`);
  }

  // Success criteria: plants needs addressed
  results.success = results.seedsBought > 0 || results.plotsBought > 0 || analysis.hasEnoughSeeds;
  
  if (results.success) {
    results.messages.push(`SUCCESS: Plants prioritized, boosters handled by smartApplyBoosters`);
  }
  
  // NOTE: Boosters TIDAK dibeli di sini, diserahkan sepenuhnya ke smartApplyBoosters()
  console.log(`[PLANTS FIRST] Seeds & plots handled. Boosters will be handled separately by smartApplyBoosters.`);
  
  return results;
};

// Account Worker dengan TRUE Plants-First Strategy
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

  // FIXED: processAccount dengan TRUE Plants-First Flow
  async processAccount() {
    try {
      await this.stateManager.getState();
      
      let hasAnyAction = false;
      const actions = [];

      console.log(`[ACCOUNT ${this.accountIndex + 1}] Starting TRUE Plants-First process...`);

      // 1. Farmhouse
      const claimStatus = this.stateManager.canClaimFarmhouse();
      if (claimStatus.canClaim) {
        console.log(`[ACCOUNT ${this.accountIndex + 1}] Claiming farmhouse...`);
        const claimResult = await this.stateManager.autoClaimFarmhouse();
        if (claimResult) {
          hasAnyAction = true;
          this.stats.farmhouseClaimed++;
          actions.push('Farmhouse');
          await this.stateManager.getState();
        }
      }

      // 2. Harvest
      const readyPlots = this.stateManager.getPlotsReadyToHarvest();
      if (readyPlots.length > 0) {
        console.log(`[ACCOUNT ${this.accountIndex + 1}] Harvesting ${readyPlots.length} ready plots...`);
        const harvestResult = await this.stateManager.autoHarvest();
        if (harvestResult.success) {
          hasAnyAction = true;
          this.stats.harvested += harvestResult.harvested;
          actions.push(`Harvest ${harvestResult.harvested}`);
          await this.stateManager.getState();
        }
      }

      // 2.5. Auto Prestige
      const prestigeCheck = this.stateManager.canPrestige();
      if (prestigeCheck.canPrestige) {
        console.log(`[ACCOUNT ${this.accountIndex + 1}] Prestiging ${prestigeCheck.currentLevel} → ${prestigeCheck.nextLevel}...`);
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

      // 3. TRUE PLANTS FIRST: Buy Seeds & Plots (NO BOOSTERS AT ALL)
      const analysis = this.stateManager.analyzeStrategicNeeds();
      const needSeeds = analysis.needs.seeds > 0;
      const canAffordSeeds = analysis.buyPlan.seeds.quantity > 0;
      const canAffordPlots = analysis.buyPlan.plot.shouldBuy && analysis.buyPlan.plot.canAfford;
      
      if (needSeeds && canAffordSeeds) {
        console.log(`[ACCOUNT ${this.accountIndex + 1}] TRUE PLANTS FIRST: Buying ${analysis.buyPlan.seeds.quantity} ${analysis.seedStrategy}...`);
        const buyResult = await this.stateManager.autoStrategicBuy();
        
        if (buyResult.seedsBought > 0 || buyResult.plotsBought > 0) {
          hasAnyAction = true;
          this.stats.purchased++;
          const items = [];
          if (buyResult.seedsBought > 0) items.push(`${buyResult.seedsBought}s`);
          if (buyResult.plotsBought > 0) items.push(`${buyResult.plotsBought}p`);
          actions.push(`Buy ${items.join(',')}`);
          await this.stateManager.getState();
        }
      } else if (canAffordPlots) {
        console.log(`[ACCOUNT ${this.accountIndex + 1}] TRUE PLANTS FIRST: Buying plots (no seed needs)...`);
        const buyResult = await this.stateManager.autoStrategicBuy();
        
        if (buyResult.plotsBought > 0) {
          hasAnyAction = true;
          this.stats.purchased++;
          actions.push(`Buy ${buyResult.plotsBought}p`);
          await this.stateManager.getState();
        }
      }

      // 4. PLANTS FIRST: Plant seeds IMMEDIATELY setelah ada seeds
      const emptyPlots = this.stateManager.getEmptyPlots();
      if (emptyPlots.length > 0) {
        const availableSeed = this.stateManager.getBestAvailableSeed();
        
        if (availableSeed) {
          const availableCount = this.stateManager.getItemCount(availableSeed);
          console.log(`[ACCOUNT ${this.accountIndex + 1}] TRUE PLANTS FIRST: Planting ${Math.min(emptyPlots.length, availableCount)} ${availableSeed}...`);
          
          const plantResult = await this.stateManager.autoPlantSeeds();
          if (plantResult.planted > 0) {
            hasAnyAction = true;
            this.stats.planted += plantResult.planted;
            actions.push(`Plant ${plantResult.planted}`);
            await this.stateManager.getState();
          }
        } else {
          console.log(`[ACCOUNT ${this.accountIndex + 1}] TRUE PLANTS FIRST: ${emptyPlots.length} empty plots but no seeds available`);
        }
      }

      // 5. TRUE PLANTS FIRST: Smart Boosters HANYA setelah ALL plots tertanami
      const updatedEmptyPlots = this.stateManager.getEmptyPlots();
      const plotsNeedingBooster = this.stateManager.getPlotsNeedingBooster();
      
      // CRITICAL CHECK: Hanya handle boosters jika TIDAK ada empty plots
      const allPlotsFilled = updatedEmptyPlots.length === 0;
      const noMoreSeedsCanBuy = this.stateManager.getBestAvailableSeed() === null && analysis.buyPlan.seeds.quantity === 0;
      const canHandleBoosters = allPlotsFilled || noMoreSeedsCanBuy;
      
      if (plotsNeedingBooster.length > 0 && canHandleBoosters) {
        console.log(`[ACCOUNT ${this.accountIndex + 1}] TRUE PLANTS FIRST: All plots filled, now handling ${plotsNeedingBooster.length} boosters...`);
        const boostResult = await this.stateManager.smartApplyBoosters();
        
        if (boostResult.applied > 0 || boostResult.bought > 0) {
          hasAnyAction = true;
          this.stats.boosted += boostResult.applied;
          if (boostResult.bought > 0) {
            this.stats.purchased++;
          }
          
          const actionParts = [];
          if (boostResult.bought > 0) actionParts.push(`Buy ${boostResult.bought}b`);
          if (boostResult.applied > 0) actionParts.push(`Apply ${boostResult.applied}b`);
          
          actions.push(actionParts.join('+'));
          await this.stateManager.getState();
        }
      } else if (plotsNeedingBooster.length > 0 && !canHandleBoosters) {
        console.log(`[ACCOUNT ${this.accountIndex + 1}] TRUE PLANTS FIRST: Skipping ${plotsNeedingBooster.length} boosters (${updatedEmptyPlots.length} empty plots need plants first)`);
      }

      // Update timing
      const timing = this.stateManager.calculateNextActionTime();
      this.lastStatusUpdate = Date.now();
      
      if (hasAnyAction) {
        this.lastActionTime = Date.now();
        this.stats.lastAction = actions.join(', ');
        
        return {
          waitTime: 2000,
          action: { type: 'recheck', description: 'Quick recheck after action' },
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
      console.error(`[ACCOUNT ${this.accountIndex + 1}] ERROR:`, error.message);
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
        console.error(`[ACCOUNT ${this.accountIndex + 1}] Worker error:`, error.message);
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

// Parallel Auto Monitor dengan TRUE Plants-First Display
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
    
    console.log(`Loaded ${this.accounts.length} accounts for TRUE Plants-First parallel processing`);
  }

  // FIXED: printStatus dengan TRUE Plants-First Priority Display
  printStatus() {
    console.clear();
    
    const uptime = Math.floor((Date.now() - this.startTime) / 1000 / 60);
    console.log(`APPLEVILLE BOT v3.3 TRUE-PLANTS-FIRST - Uptime: ${uptime}m | Total Accounts: ${this.accounts.length} | ${new Date().toLocaleTimeString()}`);
    console.log('='.repeat(140));
    
    // Account status per line dengan TRUE Plants-First Logic
    this.workers.forEach((worker, index) => {
      const stats = worker.getStats();
      const state = worker.stateManager.gameState;
      const userInfo = worker.stateManager.userInfo;
      
      // Format numbers
      const ap = state?.ap || 0;
      const apFormatted = ap >= 1000000 ? `${(ap / 1000000).toFixed(1)}M` : 
                         ap >= 1000 ? `${(ap / 1000).toFixed(1)}k` : ap.toString();
      const coins = state?.coins || 0;
      const prestigeLevel = userInfo?.prestigeLevel || 0;
      
      // TRUE PLANTS-FIRST Status Logic
      let statusText = 'Idle';
      const readyPlots = worker.stateManager.getPlotsReadyToHarvest();
      const emptyPlots = worker.stateManager.getEmptyPlots();
      const needBoosters = worker.stateManager.getPlotsNeedingBooster();
      const claimStatus = worker.stateManager.canClaimFarmhouse();
      const prestigeCheck = worker.stateManager.canPrestige();
      const timing = worker.stateManager.calculateNextActionTime();
      
      // Real-time countdown
      const currentTime = Date.now();
      const remainingTime = Math.max(0, timing.waitTime - (currentTime - (worker.lastStatusUpdate || currentTime)));
      const countdownText = worker.stateManager.formatTimeRemaining(remainingTime);
      
      // TRUE PLANTS-FIRST PRIORITY LOGIC
      if (readyPlots.length > 0) {
        // PRIORITY 1: Ready to harvest
        statusText = `Panen ${readyPlots.length} plots`;
        
      } else if (claimStatus.canClaim) {
        // PRIORITY 2: Farmhouse ready to claim
        statusText = 'Claim farmhouse';
        
      } else if (prestigeCheck.canPrestige) {
        // PRIORITY 3: Can prestige
        statusText = `Prestige LV${prestigeCheck.currentLevel}→${prestigeCheck.nextLevel}`;
        
      } else if (emptyPlots.length > 0) {
        // PRIORITY 4: TRUE PLANTS FIRST - Empty plots MUST be handled first
        const seedStrategy = worker.stateManager.determinePlantingStrategy();
        const availableSeeds = worker.stateManager.getItemCount(seedStrategy);
        const analysis = worker.stateManager.analyzeStrategicNeeds();
        
        if (availableSeeds >= emptyPlots.length) {
          // Cukup seeds untuk semua empty plots
          statusText = `PLANTS: Tanam ${emptyPlots.length} ${seedStrategy}`;
        } else if (availableSeeds > 0) {
          // Sebagian seeds tersedia
          const stillNeed = emptyPlots.length - availableSeeds;
          statusText = `PLANTS: Tanam ${availableSeeds}, beli ${stillNeed} lagi`;
        } else if (analysis.buyPlan.seeds.quantity > 0) {
          // Perlu beli seeds
          statusText = `PLANTS: Beli ${analysis.buyPlan.seeds.quantity} ${seedStrategy}`;
        } else {
          // Tidak mampu beli seeds
          const seedCost = CONFIG.ITEMS[seedStrategy]?.cost || 0;
          const seedCurrency = CONFIG.ITEMS[seedStrategy]?.currency || 'ap';
          statusText = `PLANTS: Tunggu ${seedCurrency.toUpperCase()} (need ${seedCost})`;
        }
        
      } else if (needBoosters.length > 0) {
        // PRIORITY 5: BOOSTERS - HANYA setelah ALL plots tertanami
        const boosterStrategy = worker.stateManager.determineBoosterStrategy();
        const availableBoosters = worker.stateManager.getItemCount(boosterStrategy);
        const boosterCost = CONFIG.ITEMS[boosterStrategy].cost;
        
        if (availableBoosters >= needBoosters.length) {
          // Cukup booster di inventory
          statusText = `BOOSTER: Apply ${needBoosters.length} ${boosterStrategy}`;
        } else {
          // Perlu beli booster
          const boostersNeeded = needBoosters.length - availableBoosters;
          const canAfford = Math.floor(ap / boosterCost);
          
          if (canAfford >= boostersNeeded) {
            statusText = `BOOSTER: Buy ${boostersNeeded} + Apply ${needBoosters.length}`;
          } else if (canAfford > 0) {
            statusText = `BOOSTER: Buy ${canAfford} + Apply ${availableBoosters + canAfford}`;
          } else {
            statusText = `BOOSTER: Tunggu AP (need ${boosterCost * boostersNeeded})`;
          }
        }
        
      } else {
        // PRIORITY 6: All satisfied, show next action
        if (timing.action.type === 'harvest') {
          const harvestDetails = timing.action.description.replace('Harvest ', '').replace(' slot ', ' s');
          statusText = `Tunggu panen ${harvestDetails} (${countdownText})`;
        } else if (timing.action.type === 'claim') {
          statusText = `Tunggu farmhouse (${countdownText})`;
        } else if (timing.action.type === 'booster') {
          const boosterDetails = timing.action.description.replace('Booster expire ', '');
          statusText = `Tunggu booster expire ${boosterDetails} (${countdownText})`;
        } else {
          statusText = `All satisfied - Check rutin (${countdownText})`;
        }
      }
      
      // Enhanced info display
      const proxyStatus = stats.proxy === 'No Proxy' ? 'Direct' : stats.proxy.split('@')[1] || 'Proxy';
      
      // Prestige info
      let prestigeInfo = `LV${prestigeLevel}`;
      if (prestigeLevel < 7) {
        if (prestigeCheck.canPrestige) {
          prestigeInfo += ` (READY→${prestigeCheck.nextLevel})`;
        } else {
          const nextLevel = prestigeLevel + 1;
          const nextRequirement = CONFIG.PRESTIGE.LEVELS[nextLevel];
          if (nextRequirement) {
            const shortage = nextRequirement.required - ap;
            if (shortage < 1000) {
              prestigeInfo += ` (${shortage}AP)`;
            } else if (shortage < 1000000) {
              prestigeInfo += ` (${Math.round(shortage/1000)}k)`;
            } else {
              prestigeInfo += ` (${(shortage/1000000).toFixed(1)}M)`;
            }
          }
        }
      } else {
        prestigeInfo += ` (MAX)`;
      }
      
      // TRUE PLANTS-FIRST Resource Status
      const seedStrategy = worker.stateManager.determinePlantingStrategy();
      const boosterStrategy = worker.stateManager.determineBoosterStrategy();
      const seedCount = worker.stateManager.getItemCount(seedStrategy);
      const boosterCount = worker.stateManager.getItemCount(boosterStrategy);
      const emptyCount = emptyPlots.length;
      const needBoosterCount = needBoosters.length;
      
      let resourceStatus = '';
      
      if (emptyCount > 0) {
        // PLANTS PHASE: Show plants priority
        if (seedCount >= emptyCount) {
          resourceStatus = `PLANTS:✓${seedCount}/${emptyCount}`;
        } else {
          resourceStatus = `PLANTS:${seedCount}/${emptyCount}⚠`;
        }
        
        // Show boosters as secondary/waiting
        if (needBoosterCount > 0) {
          if (boosterCount >= needBoosterCount) {
            resourceStatus += ` B:✓(wait)`;
          } else {
            resourceStatus += ` B:${boosterCount}/${needBoosterCount}(wait)`;
          }
        }
      } else {
        // BOOSTER PHASE: Plants satisfied, show boosters
        if (needBoosterCount === 0) {
          resourceStatus = `PLANTS:✓ BOOST:✓`;
        } else if (boosterCount >= needBoosterCount) {
          resourceStatus = `PLANTS:✓ BOOST:✓${boosterCount}/${needBoosterCount}`;
        } else {
          resourceStatus = `PLANTS:✓ BOOST:${boosterCount}/${needBoosterCount}⚠`;
        }
      }
      
      console.log(`[AKUN ${index + 1}] AP: ${apFormatted} | Coins: ${coins} | ${prestigeInfo} | ${resourceStatus} | ${proxyStatus} | ${statusText}`);
    });
    
    console.log('='.repeat(140));
    console.log(`TRUE PLANTS-FIRST: Seeds→Plant→AllPlotsFilled THEN Boosters | PLANTS:seeds/empty BOOST:boosters/needed | ✓=OK ⚠=Need (wait)=Waiting`);
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

    console.log(`Starting ${this.workers.length} parallel workers with TRUE PLANTS-FIRST strategy...`);
    console.log(`Priority: ALL plots must be filled with plants BEFORE any booster handling`);

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
    console.log("Stopping TRUE PLANTS-FIRST parallel monitoring...");
    this.isRunning = false;
    this.workers.forEach(worker => worker.stop());
    console.log("TRUE PLANTS-FIRST parallel monitoring stopped");
  }
}

// Main Functions dengan Smart Booster Strategy
async function runSingleAccount(accountIndex = 0) {
  const stateManager = new GameStateManager();
  
  try {
    await stateManager.loadCookieFromFile(accountIndex);
    await stateManager.getState();
    
    console.log("=== STATUS AWAL ===");
    stateManager.displayInfo();
    
    console.log("\n=== MENJALANKAN SMART-BOOSTER STRATEGY ===");
    
    // 1. Claim farmhouse
    console.log("1. Checking farmhouse...");
    await stateManager.autoClaimFarmhouse();
    
    // 2. Harvest ready plots
    console.log("2. Harvesting ready plots...");
    await stateManager.autoHarvest();
    
    // 3. PLANTS FIRST: Buy seeds dan plots
    console.log("3. PLANTS-FIRST: Strategic buying (plants priority)...");
    const buyResult = await stateManager.autoStrategicBuy();
    if (buyResult.messages.length > 0) {
      buyResult.messages.forEach(msg => console.log(`   ${msg}`));
    }
    
    // 4. Plant seeds
    console.log("4. Planting seeds...");
    await stateManager.autoPlantSeeds();
    
    // 5. SMART BOOSTER: Cek → Beli → Apply
    console.log("5. SMART BOOSTER: Auto buy + apply...");
    const boosterResult = await stateManager.smartApplyBoosters();
    console.log(`   ${boosterResult.message}`);
    
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

// Test Function untuk Debug Smart Booster
async function testSmartBooster(accountIndex = 0) {
  const stateManager = new GameStateManager();
  
  try {
    await stateManager.loadCookieFromFile(accountIndex);
    await stateManager.getState();
    
    console.log("=== SMART BOOSTER TEST ===");
    console.log("Before:");
    const plotsNeedingBooster = stateManager.getPlotsNeedingBooster();
    const boosterStrategy = stateManager.determineBoosterStrategy();
    const availableBoosters = stateManager.getItemCount(boosterStrategy);
    const currentAP = stateManager.gameState?.ap || 0;
    
    console.log(`- Plots needing booster: ${plotsNeedingBooster.length}`);
    console.log(`- Available ${boosterStrategy}: ${availableBoosters}`);
    console.log(`- Current AP: ${currentAP}`);
    console.log(`- Booster cost: ${CONFIG.ITEMS[boosterStrategy].cost} AP each`);
    
    if (plotsNeedingBooster.length > 0) {
      console.log(`- Plot details:`, plotsNeedingBooster.map(p => 
        `Slot ${p.slotIndex} (modifier: ${p.currentModifier || 'none'})`
      ));
    }
    
    console.log("\n--- Executing Smart Booster ---");
    const result = await stateManager.smartApplyBoosters();
    
    console.log("\nResult:", result);
    
    console.log("\nAfter:");
    await stateManager.getState();
    const newPlotsNeedingBooster = stateManager.getPlotsNeedingBooster();
    const newAvailableBoosters = stateManager.getItemCount(boosterStrategy);
    const newAP = stateManager.gameState?.ap || 0;
    
    console.log(`- Plots still needing booster: ${newPlotsNeedingBooster.length}`);
    console.log(`- Available ${boosterStrategy}: ${newAvailableBoosters}`);
    console.log(`- Current AP: ${newAP}`);
    console.log(`- AP spent: ${currentAP - newAP}`);
    
  } catch (error) {
    console.error("Test Error:", error.message);
  }
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
    startParallelBot,
    testSmartBooster
  };
}

// Auto start dengan informasi Smart Booster Strategy
if (require.main === module) {
  console.log("=".repeat(80));
  console.log("APPLEVILLE PARALLEL BOT v3.2 - SMART-BOOSTER STRATEGY");
  console.log("=".repeat(80));
  console.log("");
  
  console.log("🌱 STRATEGI PENANAMAN:");
  console.log("  • Prestige Level 0: Golden Apple");
  console.log("  • Prestige Level 1-6: Legacy Apple → fallback Golden Apple");
  console.log("  • Prestige Level 7+: Apex Apple → fallback Legacy/Golden Apple");
  console.log("");
  
  console.log("⚡ SMART BOOSTER STRATEGY (FIX UTAMA):");
  console.log("  1. CEK plots yang butuh booster (bukan total plot)");
  console.log("  2. CEK inventory booster yang tersedia");
  console.log("  3. BELI booster HANYA jika inventory tidak cukup");
  console.log("  4. APPLY semua booster yang tersedia");
  console.log("  5. TIDAK beli booster berlebihan lagi!");
  console.log("");
  
  console.log("🎯 PRIORITAS PEMBELIAN:");
  console.log("  1. TANAMAN dulu (WAJIB) - plants first priority");
  console.log("  2. BOOSTER smart buy (hanya yang dibutuhkan)");
  console.log("  3. PLOT dengan sisa budget");
  console.log("");
  
  console.log("🔧 PERBAIKAN MASALAH:");
  console.log("  ✓ Fix: Booster calculation berdasarkan kebutuhan aktual");
  console.log("  ✓ Fix: Tidak beli booster berlebihan");
  console.log("  ✓ Fix: Auto-buy + apply booster dalam satu flow");
  console.log("  ✓ Fix: Smart inventory management");
  console.log("  ✓ Enhanced: Better status display dengan booster info");
  console.log("");
  
  console.log("📝 CLEAN CODE FEATURES:");
  console.log("  • Modular structure dengan clear separation of concerns");
  console.log("  • Enhanced debugging dengan detailed logging");
  console.log("  • Smart resource management dan error handling");
  console.log("  • Backward compatibility dengan legacy functions");
  console.log("");
  
  console.log("🧪 TEST COMMANDS:");
  console.log("  • testSmartBooster(0) - Test smart booster untuk akun 1");
  console.log("  • runSingleAccount(0) - Test full strategy untuk akun 1");
  console.log("");
  
  console.log("Starting SMART-BOOSTER bot in 3 seconds...");
  console.log("=".repeat(80));
  
  setTimeout(() => {
    startParallelBot().catch(error => {
      console.error("Error starting SMART-BOOSTER bot:", error.message);
      process.exit(1);
    });
  }, 3000);
}
