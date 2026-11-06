const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { Telegraf } = require('telegraf');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

let bot = null; 
if (process.env.TELEGRAM_BOT_TOKEN) {
  bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
}

// Железобетонный CORS
app.use(cors({
  origin: '*', 
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  credentials: true
}));

app.use(express.json());

const UPGRADE_CARDS_CONFIG = {
  ceo_card: { basePrice: 100, baseProfit: 10 },
  marketing_card: { basePrice: 500, baseProfit: 45 },
  crypto_card: { basePrice: 2000, baseProfit: 200 }
};

const MAX_LEVELS = 30;
const BACKEND_LEVELS = Array.from({length: MAX_LEVELS}, (_, i) => Math.floor(5000 * Math.pow(1.22, i)));

// Схема пользователя MongoDB
const UserSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  username: { type: String, default: '' },
  balance: { type: Number, default: 0 }, 
  totalEarned: { type: Number, default: 0 }, 
  level: { type: Number, default: 1 }, 
  profitPerHour: { type: Number, default: 0 }, 
  lastSync: { type: Date, default: Date.now }, 
  purchasedCards: [{
    cardId: { type: String, required: true }, 
    level: { type: Number, default: 1 }      
  }],
  energy: { type: Number, default: 1000 }, 
  maxEnergy: { type: Number, default: 1000 }, 
  multitapLevel: { type: Number, default: 1 }, 
  energyLimitLevel: { type: Number, default: 1 }, 
  offlineMiningLevel: { type: Number, default: 1 }, 
  referredBy: { type: String, default: null }, 
  referrals: [{
    userId: { type: String }, 
    username: { type: String },
    bonusClaimed: { type: Boolean, default: false } 
  }],
  todayCombo: [{ type: String }], 
  lastComboDate: { type: String, default: "" },
  walletAddress: { type: String, default: "" }
}, { timestamps: true });

// Функция многоуровневого перерасчета уровней
UserSchema.methods.recalculateLevel = function() {
  let targetLevel = 1;
  for (let i = 0; i < BACKEND_LEVELS.length; i++) {
    if (this.totalEarned >= BACKEND_LEVELS[i]) {
      targetLevel = i + 2; 
    } else {
      break;
    }
  }
  if (targetLevel > MAX_LEVELS) targetLevel = MAX_LEVELS;
  this.level = targetLevel;
};

// Расчет офлайн майнинга за любое время (секунда, день, месяц)
UserSchema.methods.calculateOfflineProgress = function() {
  const now = new Date();
  if (!this.lastSync) {
    this.lastSync = now;
    return 0;
  }

  const secondsOffline = Math.floor((now - this.lastSync) / 1000);
  if (secondsOffline < 1) return 0;

  // Убираем 3-часовой лимит! Теперь офлайн майнинг копится БЕСКОНЕЧНО (хоть месяц)
  const totalHourlyProfit = this.profitPerHour + ((this.offlineMiningLevel - 1) * 50);
  let earnedOffline = 0;

  if (totalHourlyProfit > 0) {
    const profitPerSecond = totalHourlyProfit / 3600;
    earnedOffline = Math.floor(secondsOffline * profitPerSecond);
    if (earnedOffline > 0) {
      this.balance += earnedOffline;
      this.totalEarned += earnedOffline;
    }
  }

  const recoveryPerSecond = this.maxEnergy / 10800; 
  this.energy = Math.min(this.maxEnergy, this.energy + Math.floor(secondsOffline * recoveryPerSecond));

  this.recalculateLevel();
  this.lastSync = now;
  return earnedOffline;
};

const User = mongoose.model('User', UserSchema);
// 1. СИНХРОНИЗАЦИЯ
app.post('/api/user/sync', async (req, res) => {
  try {
    const { telegramId, username, localBalance, localTotalEarned } = req.body;
    if (!telegramId) return res.status(400).json({ success: false, error: "Не указан telegramId" });

    let user = await User.findOne({ telegramId });
    if (!user) {
      user = new User({ 
        telegramId, username: username || "Пчёлка",
        energy: 1000, maxEnergy: 1000, balance: localBalance || 0, totalEarned: localTotalEarned || 0
      });
    } else {
      if (username) user.username = username;
      // Защита от обнуления: берем наибольшее значение между сервером и localStorage смартфона
      if (localBalance && localBalance > user.balance) user.balance = localBalance;
      if (localTotalEarned && localTotalEarned > user.totalEarned) user.totalEarned = localTotalEarned;
    }

    const earnedOffline = user.calculateOfflineProgress();
    user.recalculateLevel();
    await user.save();
    res.json({ success: true, user, earnedOffline });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. УЛУЧШЕНИЕ БУСТОВ
app.post('/api/user/upgrade-stat', async (req, res) => {
  try {
    const { telegramId, type, cost } = req.body;
    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ success: false, error: "Пользователь не найден" });

    user.calculateOfflineProgress();
    if (user.balance < cost) return res.status(400).json({ success: false, error: "Не хватает мёда!" });
    user.balance -= cost;

    if (type === 'multitap') {
      user.multitapLevel += 1;
    } else if (type === 'energy') {
      user.energyLimitLevel += 1;
      let targetEnergy = user.energy + (user.level * 300);
      user.energy = Math.min(1000, targetEnergy);
      user.maxEnergy = 1000; 
    } else if (type === 'offline') {
      user.offlineMiningLevel += 1;
    }

    user.recalculateLevel();
    await user.save();
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. КЛИКИ
app.post('/api/user/click', async (req, res) => {
  try {
    const { telegramId, clicksCount, clientBalance, clientTotalEarned } = req.body;
    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ success: false, error: "Пользователь не найден" });

    user.calculateOfflineProgress();
    
    if (clicksCount > 0) {
      const requiredEnergy = clicksCount * user.multitapLevel;
      if (user.energy >= requiredEnergy) {
        user.energy -= requiredEnergy;
        user.balance += (clicksCount * user.multitapLevel);
        user.totalEarned += (clicksCount * user.multitapLevel);
      }
    } else {
      // Прямая синхронизация наград (ежедневный вход)
      if (clientBalance && clientBalance > user.balance) user.balance = clientBalance;
      if (clientTotalEarned && clientTotalEarned > user.totalEarned) user.totalEarned = clientTotalEarned;
    }

    user.recalculateLevel();
    await user.save();
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. ПОКУПКА КАРТОЧЕК
app.post('/api/user/buy-card', async (req, res) => {
  try {
    const { telegramId, cardId } = req.body;
    const cardConfig = UPGRADE_CARDS_CONFIG[cardId];
    const user = await User.findOne({ telegramId });
    if (!user || !cardConfig) return res.status(400).json({ success: false, error: "Ошибка параметров" });

    user.calculateOfflineProgress();
    const userCardIndex = user.purchasedCards.findIndex(c => c.cardId === cardId);
    const currentLevel = userCardIndex !== -1 ? user.purchasedCards[userCardIndex].level : 0;
    const currentPrice = Math.floor(cardConfig.basePrice * Math.pow(1.5, currentLevel));

    if (user.balance < currentPrice) return res.status(400).json({ success: false, error: "Не хватает мёда!" });

    const currentProfit = currentLevel > 0 ? Math.floor(cardConfig.baseProfit * Math.pow(1.2, currentLevel - 1)) : 0;
    const nextProfit = Math.floor(cardConfig.baseProfit * Math.pow(1.2, currentLevel));
    
    user.balance -= currentPrice;
    user.profitPerHour += (nextProfit - currentProfit);

    if (userCardIndex !== -1) {
      user.purchasedCards[userCardIndex].level += 1;
    } else {
      user.purchasedCards.push({ cardId: cardId, level: 1 });
    }

    user.recalculateLevel();
    await user.save();
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, error: "Ошибка сервера" });
  }
});
// 5. ЕЖЕДНЕВНОЕ КОМБО ЧЕТКО 1 РАЗ ДЛЯ ИГРОКА (БЕЗ ДУБЛИКАТОВ И НАКРУТОК)
const CURRENT_SECRET_COMBO = ['ceo_card', 'crypto_card']; 
const COMBO_REWARD = 250000;

app.post('/api/user/check-combo', async (req, res) => {
  try {
    const { telegramId, cardId } = req.body;
    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ success: false, error: "Пользователь не найден" });

    const todayStr = new Date().toISOString().split('T')[0];

    // Если комбо на сегодня уже закрыто в базе данных — блокируем начисление намертво
    if (user.lastComboDate === "COMPLETED_" + todayStr) {
      return res.json({ success: true, user, comboCompleted: true });
    }

    // Если наступил новый день — сбрасываем массив найденных карт комбо
    if (user.lastComboDate !== todayStr && !user.lastComboDate.startsWith("COMPLETED_")) {
      user.todayCombo = [];
    }

    // Добавляем карту, если она секретная и еще не была нажата сегодня
    if (CURRENT_SECRET_COMBO.includes(cardId) && !user.todayCombo.includes(cardId)) {
      user.todayCombo.push(cardId);
      user.lastComboDate = todayStr;

      // Сборка завершена — начисляем строго один раз
      if (user.todayCombo.length === CURRENT_SECRET_COMBO.length) {
        user.balance += COMBO_REWARD;
        user.totalEarned += COMBO_REWARD; 
        user.lastComboDate = "COMPLETED_" + todayStr; // Помечаем как вечно закрытое на сегодня
      }
    }

    user.recalculateLevel();
    await user.save();
    res.json({ success: true, user, comboCompleted: user.lastComboDate.startsWith("COMPLETED_") });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. TON CONNECT И ЗАПУСК БОТА С СЕРВЕРОМ
app.post('/api/user/save-wallet', async (req, res) => {
  try {
    const { telegramId, walletAddress } = req.body;
    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ success: false, error: "Пользователь не найден" });
    user.walletAddress = walletAddress || "";
    await user.save();
    res.json({ success: true, user });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/', (req, res) => res.send('API пчелиного кликера стабильно работает онлайн! 🐝'));

if (bot) {
  bot.start((ctx) => {
    const username = ctx.from.username || ctx.from.first_name || "Пчёлка";
    ctx.reply(`Привет, ${username}! Добро пожаловать в улей Tap Game! 🐝`, {
      reply_markup: { inline_keyboard: [[{ text: "Развивать Улей! 🍯", web_app: { url: process.env.FRONTEND_URL || "https://ds3343366-hue.github.io/clicker-frontend/" } }]] }
    });
  });
}

const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/tap_game';
mongoose.connect(mongoUri).then(async () => {
  console.log('✅ База данных MongoDB Atlas успешно подключена');
  if (bot) { try { await bot.telegram.deleteWebhook({ drop_pending_updates: true }); bot.launch(); } catch (e) {} }
  app.listen(PORT, () => console.log(`🚀 Сервер Express на порту ${PORT}`));
});

